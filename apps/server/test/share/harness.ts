// Сервер с базой PGlite и подсчётом обращений к имитации хранилища. Grafana только поддельная, значения синтетические.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type { ShareCreated, ShareInfo } from '@threadline/core';
import type { Role } from '@threadline/core/access';
import type { SearchCreated, SearchState } from '@threadline/core/search';
import { buildApp } from '../../src/app.ts';
import { MockBackend } from '../../src/backends/mock/index.ts';
import { Backends } from '../../src/backends/registry.ts';
import type { CatalogService } from '../../src/catalog/service.ts';
import type { UnknownCollector } from '../../src/catalog/collector.ts';
import { loadConfig } from '../../src/config/load.ts';
import type { SharePool } from '../../src/share/pool.ts';
import { SearchJobs } from '../../src/search/jobs.ts';
import { CATALOG_YAML } from '../catalog/fixture.ts';
import { flowResolver } from '../operation-catalog.ts';

export const ANCHOR = Date.UTC(2026, 10, 2, 9, 0, 0);
export const DAY = 24 * 60 * 60_000;

const YAML = `
auth: off
defaults: { project: pay, environment: demo }
backends:
  demo: { type: mock }
  broken: { type: mock, fail: timeout }
  grafana: { type: loki-grafana, url: 'https://grafana.corp.example', tokenEnv: THREADLINE_TEST_NO_TOKEN }
# Региональные правила демо-проекта, как в config/threadline.yaml: телефоны без кода страны, паспорт и личный номер в тексте.
regional:
  phone: { countryCode: '44', nationalDigits: 10, trunkPrefix: '0' }
  patterns:
    passport: ['[A-Z]{2}\\d{7}']
    national_id: ['[A-Z]{2}\\d{6}[A-D]']
projects:
  pay:
    name: Demo Pay
    retentionDays: 400
    environments:
      demo: { name: Демо, backend: demo, selector: [{ label: namespace, op: '=', value: pay }] }
      broken: { name: Сбой, backend: broken, selector: [{ label: namespace, op: '=', value: pay }] }
      prod: { name: Прод, backend: grafana, selector: [{ label: namespace, op: '=', value: pay }] }
      pr: { name: Стенды, kind: pr-stands, backend: demo, stand: { label: namespace, template: 'pay-pr-{number}' } }
  other:
    name: Другой проект
    retentionDays: 400
    environments:
      demo: { name: Демо, backend: demo, selector: [{ label: namespace, op: '=', value: pay }] }
`;

export interface ShareRig {
  app: FastifyInstance;
  catalog: CatalogService;
  pool: SharePool;
  jobs: SearchJobs;
  clock: { t: number };
  /** Обращений к хранилищу. */
  reads: () => number;
  /** Подсчёт ждёт, пока тест не откроет ворота: поиск стоит в состоянии «идёт». */
  gate: { close: () => void; open: () => void };
  observed: unknown[];
  close: () => Promise<void>;
}

const signedIn = (req: { headers: Record<string, unknown> }) => {
  const role = req.headers['x-test-role'];
  if (role === undefined) return null;
  return { owner: String(req.headers['x-test-owner'] ?? 'one-person'), role: role === 'none' ? null : (role as Role), name: null };
};

export async function shareRig(opts: { databaseUrl?: string; stream?: Writable } = {}): Promise<ShareRig> {
  const dir = await mkdtemp(join(tmpdir(), 'threadline-share-'));
  await writeFile(join(dir, 'threadline.yaml'), YAML);
  await mkdir(join(dir, 'catalog'));
  await writeFile(join(dir, 'catalog', 'pay.yaml'), CATALOG_YAML);
  const config = await loadConfig({ path: join(dir, 'threadline.yaml'), env: {} });
  let reads = 0;
  let wait: Promise<void> | null = null;
  let release: () => void = () => undefined;
  const backends = new Backends(config, {
    createAdapter: (_id, cfg) => {
      const mock = new MockBackend(cfg as never, { anchorMs: ANCHOR });
      const count = mock.countBy.bind(mock);
      const lines = mock.queryLines.bind(mock);
      const held = async (signal?: AbortSignal) => {
        if (!wait) return;
        await Promise.race([wait, new Promise((_, no) => signal?.addEventListener('abort', () => no(new DOMException('стоп', 'AbortError'))))]);
      };
      mock.countBy = async (q, s) => {
        reads++;
        await held(s);
        return count(q, s);
      };
      mock.queryLines = async (q, s) => {
        reads++;
        await held(s);
        return lines(q, s);
      };
      return mock;
    },
  });
  const clock = { t: ANCHOR + 1000 };
  const now = () => clock.t;
  const jobs = new SearchJobs({ now, timer: false });
  const observed: unknown[] = [];
  const collector = { observe: (...a: unknown[]) => observed.push(a), start: () => undefined, close: () => Promise.resolve(), forget: () => undefined } as unknown as UnknownCollector;
  let catalog!: CatalogService;
  let pool!: SharePool;
  const app = await buildApp({
    config,
    backends,
    now,
    jobs,
    collector,
    databaseUrl: opts.databaseUrl === undefined ? 'pglite://memory' : opts.databaseUrl,
    operationCatalog: { resolver: () => flowResolver() },
    testViewer: signedIn,
    logger: opts.stream ? { stream: opts.stream } : false,
    onCatalog: (c, p) => {
      catalog = c;
      pool = p;
    },
  });
  await app.ready();
  for (let i = 0; i < 3000 && opts.databaseUrl !== '' && catalog.state().state !== 'ok'; i++) await new Promise((r) => setTimeout(r, 20));
  return {
    app,
    catalog,
    pool,
    jobs,
    clock,
    reads: () => reads,
    gate: {
      close: () => {
        wait = new Promise((r) => (release = r));
      },
      open: () => {
        release();
        wait = null;
      },
    },
    observed,
    close: async () => {
      jobs.close();
      await app.close();
    },
  };
}

export const as = (role: string, owner?: string) => ({ 'x-test-role': role, ...(owner ? { 'x-test-owner': owner } : {}) });

export async function search(r: ShareRig, terms: string[], role = 'analyst', env = 'demo', owner?: string): Promise<string> {
  const res = await r.app.inject({ method: 'POST', url: `/api/projects/pay/envs/${env}/searches`, headers: as(role, owner), payload: { terms, period: { preset: '24h' } } });
  if (res.statusCode !== 200) throw new Error(res.body);
  const { id } = res.json() as SearchCreated;
  await finish(r, `/api/searches/${id}`, as(role, owner));
  return id;
}

/** Опрос до конца поиска. */
export async function finish(r: ShareRig, url: string, headers: Record<string, string> = {}): Promise<SearchState> {
  for (let i = 0; i < 3000; i++) {
    const res = await r.app.inject({ url, headers });
    if (res.statusCode !== 200) throw new Error(`${url}: ${res.statusCode} ${res.body}`);
    const s = res.json() as SearchState;
    if (s.status !== 'running') return s;
    await new Promise((x) => setTimeout(x, 5));
  }
  throw new Error('поиск не завершился');
}

export async function share(r: ShareRig, body: object, headers: Record<string, string> = as('analyst')): Promise<{ id: string } & ShareCreated> {
  const res = await r.app.inject({ method: 'POST', url: '/api/share', headers, payload: body });
  if (res.statusCode !== 201) throw new Error(`создание: ${res.statusCode} ${res.body}`);
  const created = res.json() as ShareCreated;
  return { ...created, id: created.path.slice('/s/'.length) };
}

export const info = async (r: ShareRig, id: string) => (await r.app.inject(`/api/s/${id}`)).json() as ShareInfo;

export async function runLink(r: ShareRig, id: string): Promise<SearchState> {
  const run = await r.app.inject({ method: 'POST', url: `/api/s/${id}/run` });
  if (run.statusCode !== 200) throw new Error(`запуск: ${run.statusCode} ${run.body}`);
  return finish(r, `/api/s/${id}/state`);
}
