// Владелец мест пула (holderOf), места пула через маршруты, предел чтений запроса по ссылке.
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { BackendError, type CheckInfo, type CountQuery, type LinesQuery, type LogBackend, type LogLine, type Matcher, type TimeRange } from '@threadline/core/backend';
import type { SearchCreated } from '@threadline/core/search';
import { buildApp } from '../src/app.ts';
import { holderOf, LOCAL_VIEWER, type Viewer } from '../src/auth/access.ts';
import { MockBackend } from '../src/backends/mock/index.ts';
import { Backends } from '../src/backends/registry.ts';
import { loadConfig } from '../src/config/load.ts';
import { HolderReads } from '../src/search/holder-reads.ts';
import { SearchJobs } from '../src/search/jobs.ts';

const YAML = `
auth: off
defaults: { project: pay, environment: demo }
backends:
  demo: { type: mock }
  slow: { type: mock }
projects:
  pay:
    name: Demo Pay
    retentionDays: 30
    environments:
      demo: { name: Демо, backend: demo, selector: [{ label: namespace, op: "=", value: pay }] }
      slow: { name: Медленно, backend: slow, selector: [{ label: namespace, op: "=", value: pay }] }
`;

/** Имитация с задержкой чтения строк: считает одновременные чтения. */
class Slow implements LogBackend {
  readonly inner: MockBackend;
  delayMs = 0;
  active = 0;
  peak = 0;
  reads = 0;
  constructor(inner: MockBackend) {
    this.inner = inner;
  }
  check(signal: AbortSignal): Promise<CheckInfo> {
    return this.inner.check(signal);
  }
  labelValues(label: string, scope: Matcher[], range: TimeRange, signal: AbortSignal): Promise<string[]> {
    return this.inner.labelValues(label, scope, range, signal);
  }
  countBy(q: CountQuery, signal: AbortSignal): Promise<Record<string, number>> {
    return this.inner.countBy(q, signal);
  }
  async queryLines(q: LinesQuery, signal: AbortSignal): Promise<LogLine[]> {
    this.reads++;
    this.active++;
    this.peak = Math.max(this.peak, this.active);
    try {
      await new Promise((r) => setTimeout(r, this.delayMs));
      return await this.inner.queryLines(q, signal);
    } finally {
      this.active--;
    }
  }
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup(viewer?: (req: FastifyRequest) => Viewer) {
  const dir = await mkdtemp(join(tmpdir(), 'threadline-holder-'));
  await writeFile(join(dir, 'threadline.yaml'), YAML);
  const config = await loadConfig({ path: join(dir, 'threadline.yaml'), env: {} });
  let slow: Slow | undefined;
  const backends = new Backends(config, {
    createAdapter: (id, cfg) => {
      if (cfg.type !== 'mock') throw new Error('только имитация');
      const mock = new MockBackend(cfg);
      if (id !== 'slow') return mock;
      return (slow = new Slow(mock));
    },
  });
  const jobs = new SearchJobs({ timer: false });
  const app = await buildApp({ config, backends, logger: false, jobs, ...(viewer ? { testViewer: viewer } : {}) });
  cleanups.push(async () => {
    jobs.close();
    await app.close();
  });
  return { app, jobs, slow: slow! };
}

const from = (address: string) => ({ 'x-forwarded-for': address });

async function search(app: FastifyInstance, value: string, headers: Record<string, string>): Promise<string> {
  const r = await app.inject({ method: 'POST', url: '/api/projects/pay/envs/demo/searches', headers, payload: { terms: [value], period: { preset: '15m' }, fresh: true } });
  expect(r.statusCode, r.body).toBe(200);
  return (r.json() as SearchCreated).id;
}

const alive = async (app: FastifyInstance, id: string, headers: Record<string, string> = {}) => (await app.inject({ url: `/api/searches/${id}`, headers })).statusCode === 200;

describe('владелец мест', () => {
  const req = (viewer: Viewer | null, headers: Record<string, string | string[]> = {}, ip = '127.0.0.1') => ({ viewer, headers, ip }) as unknown as FastifyRequest;

  it('при входе — учётная запись, адрес не читается', () => {
    expect(holderOf(req({ owner: 'sub-1', role: 'support', name: null }, from('10.0.0.9')))).toBe('user:sub-1');
  });

  it('при auth: off — последний адрес X-Forwarded-For, без заголовка — адрес соединения', () => {
    expect(holderOf(req(LOCAL_VIEWER, { 'x-forwarded-for': '1.2.3.4, 10.0.0.7' }))).toBe('addr:10.0.0.7');
    expect(holderOf(req(LOCAL_VIEWER, { 'x-forwarded-for': ['1.2.3.4', '10.0.0.8'] }))).toBe('addr:10.0.0.8');
    expect(holderOf(req(LOCAL_VIEWER, {}, '192.168.1.5'))).toBe('addr:192.168.1.5');
    expect(holderOf(req(LOCAL_VIEWER, { 'x-forwarded-for': ' ' }, '192.168.1.5'))).toBe('addr:192.168.1.5');
  });
});

describe('места пула через маршруты', () => {
  it('auth: off: 30 поисков с другого адреса не вытесняют поиск первого', async () => {
    const { app, jobs } = await setup();
    const mine = await search(app, 'mine-123456', from('10.0.0.1'));
    const flood: string[] = [];
    for (let i = 0; i < 30; i++) flood.push(await search(app, `flood-${i}-abcdef`, from('10.0.0.2')));
    expect(await alive(app, mine)).toBe(true);
    expect(flood.filter((id) => jobs.has(id))).toEqual(flood.slice(-25));
    // Видимость прежняя: при auth: off все запросы — один пользователь.
    expect(await alive(app, mine, from('10.0.0.2'))).toBe(true);
  });

  it('вход: учётная запись, две «сессии» одного человека делят места', async () => {
    const { app, jobs } = await setup((r) => ({ owner: String(r.headers['x-test-user']), role: 'support', name: null }));
    const as = (user: string, address: string) => ({ 'x-test-user': user, ...from(address) });
    const other = await search(app, 'other-123456', as('b', '10.0.0.1'));
    const own: string[] = [];
    for (let i = 0; i < 30; i++) own.push(await search(app, `own-${i}-abcdef`, as('a', i % 2 ? '10.0.0.2' : '10.0.0.3')));
    expect(await alive(app, other, as('b', '10.0.0.1'))).toBe(true);
    expect(own.filter((id) => jobs.has(id))).toHaveLength(25);
  });
});

describe('чтения запроса по ссылке', () => {
  const link = (cid = 'cid-holder-1') => {
    const now = Date.now();
    return `/api/projects/pay/envs/slow/requests/${cid}?from=${now - 60_000}&to=${now}`;
  };

  it('у одного адреса не больше трёх сразу, ждущие дочитываются, сверх десяти ждущих — busy; другой адрес не ждёт', async () => {
    const { app, slow } = await setup();
    slow.delayMs = 40;
    const mine = Array.from({ length: 14 }, (_, i) => app.inject({ url: link(`cid-holder-${i}`), headers: from('10.0.0.1') }));
    await new Promise((r) => setTimeout(r, 10));
    const started = performance.now();
    const other = await app.inject({ url: link('cid-other'), headers: from('10.0.0.2') });
    expect(performance.now() - started).toBeLessThan(200);
    expect(other.statusCode).toBe(404);
    const answers = await Promise.all(mine);
    const busy = answers.filter((r) => r.statusCode === 503);
    expect(busy).toHaveLength(1);
    expect(busy[0]!.json()).toEqual({ error: { code: 'busy', retryAfterSeconds: 5 } });
    expect(busy[0]!.headers['retry-after']).toBe('5');
    expect(answers.filter((r) => r.statusCode === 404)).toHaveLength(13);
    // Три своих и одно чужое.
    expect(slow.peak).toBeLessThanOrEqual(4);
  });

  it('показ по ссылке считается вместе со страницей', async () => {
    const { app, slow } = await setup();
    slow.delayMs = 40;
    const reqs = Array.from({ length: 6 }, (_, i) => app.inject({ url: link(`cid-r-${i}`).replace('?', i % 2 ? '/reveal?' : '?'), headers: from('10.0.0.1') }));
    await Promise.all(reqs);
    expect(slow.peak).toBe(3);
  });

  it('отказ проверок до чтения места не занимает и к хранилищу не идёт', async () => {
    const { app, slow } = await setup();
    const bad = await app.inject({ url: '/api/projects/pay/envs/slow/requests/bad%20cid?from=1&to=2', headers: from('10.0.0.1') });
    expect(bad.statusCode).toBe(400);
    expect(slow.reads).toBe(0);
  });
});

describe('предел владельца', () => {
  const gate = () => {
    let open!: () => void;
    const p = new Promise<void>((r) => (open = r));
    return { p, open };
  };

  it('три сразу, четвёртое ждёт и идёт после освобождения; запись владельца уходит', async () => {
    const reads = new HolderReads();
    const g = gate();
    let running = 0;
    let peak = 0;
    const work = async () => {
      running++;
      peak = Math.max(peak, running);
      await g.p;
      running--;
      return 'ok';
    };
    const all = Array.from({ length: 4 }, () => reads.run('a', new AbortController().signal, work));
    await new Promise((r) => setTimeout(r, 5));
    expect(peak).toBe(3);
    g.open();
    expect(await Promise.all(all)).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(reads.size).toBe(0);
  });

  it('ждущих сверх предела — busy сразу; ожидание дольше срока — busy; отмена в ожидании — работы нет', async () => {
    const reads = new HolderReads({ max: 1, waiting: 1, waitMs: 30 });
    const g = gate();
    const first = reads.run('a', new AbortController().signal, () => g.p);
    const ac = new AbortController();
    let ran = false;
    const second = reads.run('a', ac.signal, async () => {
      ran = true;
    });
    await expect(reads.run('a', new AbortController().signal, async () => undefined)).rejects.toMatchObject({ code: 'busy', retryAfterSeconds: 5 });
    ac.abort();
    await expect(second).rejects.toMatchObject({ code: 'cancelled' });
    expect(ran).toBe(false);
    await expect(reads.run('a', new AbortController().signal, async () => undefined)).rejects.toBeInstanceOf(BackendError);
    // Другой владелец не ждёт.
    expect(await reads.run('b', new AbortController().signal, async () => 'b')).toBe('b');
    g.open();
    await first;
    expect(reads.size).toBe(0);
  });
});
