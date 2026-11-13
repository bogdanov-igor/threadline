// Задание поиска принадлежит пользователю: чужое выглядит как истёкшее, повтор из памяти только у того же человека.
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { LogBackend } from '@threadline/core/backend';
import type { SearchCreated, SearchState } from '@threadline/core/search';
import { buildApp } from '../../src/app.ts';
import { generatePayDataset, MOCK_FLOW, MOCK_SPECIAL } from '../../src/backends/mock/dataset-pay.ts';
import { MockBackend } from '../../src/backends/mock/index.ts';
import { Backends } from '../../src/backends/registry.ts';
import { loadConfig } from '../../src/config/load.ts';
import { SearchJobs, TTL_MS } from '../../src/search/jobs.ts';
import { flowResolver } from '../operation-catalog.ts';

const ANCHOR = Date.UTC(2026, 10, 2, 9, 0, 0);
const YAML = `
auth: off
defaults: { project: pay, environment: demo }
backends:
  demo: { type: mock }
projects:
  pay:
    name: Demo Pay
    environments:
      demo: { name: Демо, backend: demo, selector: [{ label: namespace, op: '=', value: pay }] }
`;

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

async function setup(opts: { viewer?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'threadline-owner-'));
  await writeFile(join(dir, 'threadline.yaml'), YAML);
  const config = await loadConfig({ path: join(dir, 'threadline.yaml'), env: {} });
  let reads = 0;
  const backends = new Backends(config, {
    createAdapter: (_id, cfg) => {
      const mock = new MockBackend(cfg as never, { anchorMs: ANCHOR });
      const count = mock.countBy.bind(mock);
      mock.countBy = (q, s) => (reads++, count(q, s));
      return mock as LogBackend;
    },
  });
  const clock = { t: ANCHOR + 1000 };
  const now = () => clock.t;
  const jobs = new SearchJobs({ now, timer: false });
  const app = await buildApp({
    config,
    backends,
    now,
    jobs,
    operationCatalog: { resolver: () => flowResolver() },
    ...(opts.viewer === false ? {} : { testViewer: (req: { headers: Record<string, unknown> }) => ({ owner: String(req.headers['x-owner']), role: 'admin' as const, name: null }) }),
  });
  closers.push(async () => {
    jobs.close();
    await app.close();
  });
  return { app, clock, reads: () => reads };
}

const as = (owner: string) => ({ 'x-owner': owner });
const code = (r: { json: () => unknown }) => (r.json() as { error: { code: string } }).error.code;

async function search(app: FastifyInstance, owner: string): Promise<SearchCreated> {
  const r = await app.inject({ method: 'POST', url: '/api/projects/pay/envs/demo/searches', headers: as(owner), payload: { terms: [MOCK_SPECIAL.exactPan], period: { preset: '24h' } } });
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as SearchCreated;
}

async function finish(app: FastifyInstance, id: string, owner: string): Promise<SearchState> {
  for (let i = 0; i < 2000; i++) {
    const s = (await app.inject({ url: `/api/searches/${id}`, headers: as(owner) })).json() as SearchState;
    if (s.status !== 'running') return s;
    await new Promise((res) => setTimeout(res, 5));
  }
  throw new Error('поиск не завершился');
}

describe('задание поиска принадлежит пользователю', () => {
  it('чужое задание выглядит как истёкшее по всем маршрутам', async () => {
    const { app } = await setup();
    const { id } = await search(app, 'alice');
    const state = await finish(app, id, 'alice');
    const cid = state.requests[0]!.correlationId;
    for (const [method, url] of [
      ['GET', `/api/searches/${id}`],
      ['GET', `/api/searches/${id}/requests/${cid}`],
      ['GET', `/api/searches/${id}/requests/${cid}/reveal`],
      ['GET', `/api/searches/${id}/lines`],
      ['DELETE', `/api/searches/${id}`],
      ['POST', `/api/searches/${id}/supplement`],
    ] as const) {
      const r = await app.inject({ method, url, headers: as('bob'), ...(method === 'POST' ? { payload: { values: [{ type: 'x', value: 'abcdef' }] } } : {}) });
      expect([r.statusCode, code(r)], url).toEqual([404, 'search-expired']);
      expect(r.body).not.toContain(MOCK_SPECIAL.exactPan);
    }
    expect((await app.inject({ url: `/api/searches/${id}`, headers: as('alice') })).statusCode).toBe(200);
  });

  it('чужая остановка не принимается, поиск владельца продолжается', async () => {
    const { app } = await setup();
    const { id } = await search(app, 'alice');
    const denied = await app.inject({ method: 'DELETE', url: `/api/searches/${id}`, headers: as('bob') });
    expect(code(denied)).toBe('search-expired');
    expect((await finish(app, id, 'alice')).status).toBe('done');
  });

  it('чужие запросы не продлевают срок жизни задания', async () => {
    const { app, clock } = await setup();
    const { id } = await search(app, 'alice');
    await finish(app, id, 'alice');
    clock.t += TTL_MS - 1;
    expect((await app.inject({ url: `/api/searches/${id}`, headers: as('bob') })).statusCode).toBe(404);
    clock.t += 2;
    expect(code(await app.inject({ url: `/api/searches/${id}`, headers: as('alice') }))).toBe('search-expired');
  });

  it('тот же поиск другого человека идёт в хранилище, свой повтор — из памяти', async () => {
    const { app, clock, reads } = await setup();
    const first = await search(app, 'alice');
    await finish(app, first.id, 'alice');
    const afterFirst = reads();
    clock.t += 20_000;
    const mine = await search(app, 'alice');
    expect(mine).toEqual({ id: first.id, cached: true });
    expect(reads()).toBe(afterFirst);
    const theirs = await search(app, 'bob');
    expect(theirs.cached).toBe(false);
    expect(theirs.id).not.toBe(first.id);
    await finish(app, theirs.id, 'bob');
    expect(reads()).toBeGreaterThan(afterFirst);
  });

  it('вторая вкладка и новый вход: принадлежность идёт от учётной записи', async () => {
    const { app } = await setup();
    const { id } = await search(app, 'alice');
    await finish(app, id, 'alice');
    expect((await app.inject({ url: `/api/searches/${id}?viewer=tab-2`, headers: as('alice') })).statusCode).toBe(200);
  });

  it('поиск операции: идущий поиск другому человеку не отдаётся', async () => {
    const { app } = await setup();
    const dataset = generatePayDataset(ANCHOR);
    const atMs = Math.min(...dataset.records.filter((p) => p.line.includes(MOCK_FLOW.transfer)).map((p) => Number(p.tsNs / 1_000_000n)));
    const body = { type: 'transfer', values: [MOCK_FLOW.transfer], atMs, window: '24h' };
    const start = (owner: string) => app.inject({ method: 'POST', url: '/api/projects/pay/envs/demo/operations', headers: as(owner), payload: body });
    const a = await start('alice');
    expect(a.statusCode, a.body).toBe(200);
    const b = await start('bob');
    expect(b.statusCode, b.body).toBe(200);
    expect((b.json() as SearchCreated).id).not.toBe((a.json() as SearchCreated).id);
    expect((b.json() as SearchCreated).cached).toBe(false);
    expect(code(await app.inject({ url: `/api/searches/${(a.json() as SearchCreated).id}`, headers: as('bob') }))).toBe('search-expired');
  });

  it('auth: off: все запросы считаются одним пользователем', async () => {
    const { app, clock } = await setup({ viewer: false });
    const start = () => app.inject({ method: 'POST', url: '/api/projects/pay/envs/demo/searches', payload: { terms: [MOCK_SPECIAL.exactPan], period: { preset: '24h' } } });
    const first = (await start()).json() as SearchCreated;
    for (let i = 0; i < 2000; i++) {
      const s = (await app.inject(`/api/searches/${first.id}`)).json() as SearchState;
      if (s.status !== 'running') break;
      await new Promise((res) => setTimeout(res, 5));
    }
    clock.t += 20_000;
    expect((await start()).json()).toEqual({ id: first.id, cached: true });
  });
});
