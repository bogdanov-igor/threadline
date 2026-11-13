// Поиск по нескольким средам: маршрут, части по средам, параметр env, повтор из памяти, очередь хранилища.
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { CheckInfo, CountQuery, LinesQuery, LogBackend, LogLine, Matcher, TimeRange } from '@threadline/core/backend';
import type { LinesPageResponse, RequestDetail, SearchCreated, SearchState, SearchStatus } from '@threadline/core/search';
import { buildApp } from '../src/app.ts';
import { MOCK_PERSONAL } from '../src/backends/mock/dataset-pay.ts';
import { MockBackend } from '../src/backends/mock/index.ts';
import { Backends, defaultAdapter } from '../src/backends/registry.ts';
import { loadConfig } from '../src/config/load.ts';
import type { SearchJob } from '../src/search/engine.ts';
import { SearchJobs, type StoredJob } from '../src/search/jobs.ts';
import { MultiSearch, type MultiPart } from '../src/search/multi.ts';

const ANCHOR = Date.UTC(2026, 10, 2, 9, 0, 0);
const CID = MOCK_PERSONAL.cid;

const YAML = `
auth: off
defaults: { project: pay, environment: demo }
backends:
  demo: { type: mock }
  other: { type: mock }
  failing-timeout: { type: mock, fail: timeout }
  failing-limit: { type: mock, fail: limit }
  narrow: { type: mock, maxConcurrent: 1 }
  grafana:
    type: loki-grafana
    url: https://grafana.example
    tokenEnv: THREADLINE_MULTI_TEST_TOKEN
projects:
  pay:
    name: Demo Pay
    retentionDays: 30
    environments:
      demo: { name: Демо, backend: demo, selector: [{ label: namespace, op: "=", value: pay }] }
      twin: { name: Двойник, backend: demo, selector: [{ label: namespace, op: "=", value: pay }] }
      test: { name: Тест, backend: other, selector: [{ label: namespace, op: "=", value: pay }] }
      timeout: { name: Тайм-аут, backend: failing-timeout, selector: [{ label: namespace, op: "=", value: pay }] }
      limit: { name: Лимит, backend: failing-limit, selector: [{ label: namespace, op: "=", value: pay }] }
      narrow-a: { name: Узкая А, backend: narrow, selector: [{ label: namespace, op: "=", value: pay }] }
      narrow-b: { name: Узкая Б, backend: narrow, selector: [{ label: namespace, op: "=", value: pay }] }
      prod: { name: Прод, backend: grafana, selector: [{ label: namespace, op: "=", value: pay }] }
      prod2: { name: Прод 2, backend: grafana, selector: [{ label: namespace, op: "=", value: pay }] }
      pr: { name: Стенды, kind: pr-stands, backend: demo, stand: { label: namespace, template: "pay-pr-{number}" } }
`;

/** Имитация, которая считает обращения и одновременные запросы. */
class Counting implements LogBackend {
  readonly inner: MockBackend;
  readonly store: string;
  calls = 0;
  active = 0;
  peak = 0;
  constructor(store: string, inner: MockBackend) {
    this.store = store;
    this.inner = inner;
  }
  check(signal: AbortSignal): Promise<CheckInfo> {
    return this.inner.check(signal);
  }
  labelValues(label: string, scope: Matcher[], range: TimeRange, signal: AbortSignal): Promise<string[]> {
    return this.inner.labelValues(label, scope, range, signal);
  }
  async #count<T>(work: () => Promise<T>): Promise<T> {
    this.calls++;
    this.active++;
    this.peak = Math.max(this.peak, this.active);
    try {
      await new Promise((r) => setTimeout(r, 2));
      return await work();
    } finally {
      this.active--;
    }
  }
  queryLines(q: LinesQuery, signal: AbortSignal): Promise<LogLine[]> {
    return this.#count(() => this.inner.queryLines(q, signal));
  }
  countBy(q: CountQuery, signal: AbortSignal): Promise<Record<string, number>> {
    return this.#count(() => this.inner.countBy(q, signal));
  }
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'threadline-multi-'));
  await writeFile(join(dir, 'threadline.yaml'), YAML);
  const config = await loadConfig({ path: join(dir, 'threadline.yaml'), env: {} });
  const adapters: Counting[] = [];
  const backends = new Backends(config, {
    createAdapter: (id, cfg) => {
      if (cfg.type !== 'mock') return defaultAdapter(id, cfg);
      const a = new Counting(id, new MockBackend(cfg, { anchorMs: ANCHOR }));
      adapters.push(a);
      return a;
    },
  });
  const clock = { t: ANCHOR + 1000 };
  const jobs = new SearchJobs({ now: () => clock.t, timer: false });
  const app = await buildApp({ config, backends, logger: false, now: () => clock.t, jobs });
  cleanups.push(async () => {
    jobs.close();
    await app.close();
  });
  const store = (id: string) => adapters.find((a) => a.store === id)!;
  return { app, jobs, clock, calls: () => adapters.reduce((n, a) => n + a.calls, 0), store };
}

type App = FastifyInstance;

const post = (app: App, body: object) => app.inject({ method: 'POST', url: '/api/projects/pay/searches', payload: body });
const body = (envs: string[], extra: object = {}) => ({ envs, terms: [CID], period: { preset: '24h' }, ...extra });

async function start(app: App, envs: string[], extra: object = {}): Promise<SearchCreated> {
  const r = await post(app, body(envs, extra));
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}

async function finish(app: App, id: string): Promise<SearchState> {
  for (let i = 0; i < 1000; i++) {
    const s = (await app.inject(`/api/searches/${id}`)).json() as SearchState;
    if (s.status !== 'running') return s;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('поиск не завершился');
}

const errorOf = (r: { statusCode: number; json: () => unknown }) => [r.statusCode, (r.json() as { error: { code: string } }).error.code];

describe('проверки запуска', () => {
  it.each<[string, object, number, string]>([
    ['одна среда', body(['demo']), 400, 'bad-request'],
    ['шесть сред', body(['demo', 'twin', 'test', 'timeout', 'limit', 'narrow-a']), 400, 'bad-request'],
    ['среда дважды', body(['demo', 'demo']), 400, 'bad-request'],
    ['стенды', body(['demo', 'pr']), 400, 'bad-request'],
    ['стенд в теле', body(['demo', 'twin'], { stand: '12' }), 400, 'bad-request'],
    ['envs не список', { envs: 'demo,twin', terms: [CID], period: { preset: '6h' } }, 400, 'bad-request'],
    ['неизвестная среда', body(['demo', 'nope']), 404, 'unknown-environment'],
    ['короткие значения', body(['demo', 'twin'], { terms: ['ab'] }), 400, 'invalid-terms'],
    ['нет периода', { envs: ['demo', 'twin'], terms: [CID] }, 400, 'invalid-period'],
    ['ни одна среда не настроена', body(['prod', 'prod2']), 409, 'not-configured'],
  ])('%s: отказ до хранилища', async (_name, payload, status, code) => {
    const { app, calls } = await setup();
    const r = await post(app, payload);
    expect(errorOf(r)).toEqual([status, code]);
    expect(calls()).toBe(0);
  });
});

describe('части по средам', () => {
  it('один correlation_id в двух средах: две строки со своими средами, записи не склеиваются', async () => {
    const { app } = await setup();
    const s = await finish(app, (await start(app, ['twin', 'demo'])).id);
    expect(s.status).toBe('done');
    expect(s.error).toBeNull();
    expect(s.envs?.map((p) => [p.env, p.status, p.requestsTotal])).toEqual([
      ['demo', 'done', 1],
      ['twin', 'done', 1],
    ]);
    expect(s.requests.map((r) => [r.env, r.correlationId]).sort()).toEqual([
      ['demo', CID],
      ['twin', CID],
    ]);
    expect(s.requestsTotal).toBe(2);
    // Строку открывает своя среда: без env — отказ, чужая среда — отказ.
    const one = await app.inject(`/api/searches/${s.id}/requests/${CID}?env=twin`);
    expect(one.statusCode, one.body).toBe(200);
    expect((one.json() as RequestDetail).summary.correlationId).toBe(CID);
    expect(errorOf(await app.inject(`/api/searches/${s.id}/requests/${CID}`))).toEqual([400, 'bad-request']);
    expect(errorOf(await app.inject(`/api/searches/${s.id}/requests/${CID}?env=test`))).toEqual([400, 'bad-request']);
    const lines = await app.inject(`/api/searches/${s.id}/lines?env=demo`);
    expect(lines.statusCode, lines.body).toBe(200);
    expect((lines.json() as LinesPageResponse).records.length).toBeGreaterThan(0);
    expect(errorOf(await app.inject(`/api/searches/${s.id}/lines`))).toEqual([400, 'bad-request']);
  });

  it('опрос с from получает хвост общего списка', async () => {
    const { app } = await setup();
    const s = await finish(app, (await start(app, ['demo', 'twin'])).id);
    const tail = (await app.inject(`/api/searches/${s.id}?from=1`)).json() as SearchState;
    expect(tail.requests).toHaveLength(1);
    expect(tail.requestsTotal).toBe(2);
    expect(tail.requests[0]).toEqual(s.requests[1]);
  });

  it('тайм-аут одной среды: найденное в другой на месте, общей ошибки нет', async () => {
    const { app } = await setup();
    const s = await finish(app, (await start(app, ['demo', 'timeout'])).id);
    expect(s.status).toBe('done');
    expect(s.error).toBeNull();
    expect(s.requests.map((r) => r.env)).toEqual(['demo']);
    const failed = s.envs!.find((p) => p.env === 'timeout')!;
    expect(failed.status).toBe('failed');
    expect(failed.error?.code).toBe('timeout');
  });

  it('не удалось ни в одной: общий статус failed и первая ошибка', async () => {
    const { app } = await setup();
    const s = await finish(app, (await start(app, ['timeout', 'limit'])).id);
    expect(s.status).toBe('failed');
    expect(s.error?.code).toBe('timeout');
    expect(s.envs!.map((p) => p.status)).toEqual(['failed', 'failed']);
  });

  it('ненастроенная среда: часть с ошибкой, к её хранилищу запросов нет, остальные ищутся', async () => {
    const { app } = await setup();
    const s = await finish(app, (await start(app, ['demo', 'prod'])).id);
    expect(s.status).toBe('done');
    const prod = s.envs!.find((p) => p.env === 'prod')!;
    expect(prod.error?.code).toBe('not-configured');
    expect(s.requests.map((r) => r.env)).toEqual(['demo']);
    expect(errorOf(await app.inject(`/api/searches/${s.id}/requests/${CID}?env=prod`))).toEqual([404, 'request-not-found']);
  });

  it('повтор из памяти с тем же набором в другом порядке; другой набор — новый поиск', async () => {
    const { app, calls } = await setup();
    const first = await start(app, ['demo', 'twin']);
    await finish(app, first.id);
    const used = calls();
    const again = await start(app, ['twin', 'demo']);
    expect(again).toEqual({ id: first.id, cached: true });
    expect(calls()).toBe(used);
    const other = await start(app, ['demo', 'test']);
    expect(other.cached).toBe(false);
  });

  it('сбой одной среды: повтор идёт в хранилища заново', async () => {
    const { app } = await setup();
    const first = await start(app, ['demo', 'timeout']);
    await finish(app, first.id);
    const again = await start(app, ['demo', 'timeout']);
    expect(again.cached).toBe(false);
  });

  it('хранилище с одним местом: его среды идут одна за другой', async () => {
    const { app, store } = await setup();
    await finish(app, (await start(app, ['narrow-a', 'narrow-b'])).id);
    expect(store('narrow').calls).toBeGreaterThan(2);
    expect(store('narrow').peak).toBe(1);
  });

  it('подсчёт: одна среда — до трёх часов сразу, две среды одного хранилища — по часу каждая', async () => {
    const { app, store } = await setup();
    const single = await app.inject({ method: 'POST', url: '/api/projects/pay/envs/demo/searches', payload: { terms: [CID], period: { preset: '24h' } } });
    await finish(app, (single.json() as SearchCreated).id);
    expect(store('demo').peak).toBe(3);
    store('demo').peak = 0;
    await finish(app, (await start(app, ['demo', 'twin'], { fresh: true })).id);
    expect(store('demo').peak).toBeLessThanOrEqual(2);
  });

  it('остановка останавливает все среды', async () => {
    const { app } = await setup();
    const { id } = await start(app, ['demo', 'test']);
    const del = await app.inject({ method: 'DELETE', url: `/api/searches/${id}` });
    expect(del.statusCode).toBe(204);
    const s = await finish(app, id);
    expect(s.status).toBe('cancelled');
    expect(s.envs!.every((p) => p.status === 'cancelled' || p.status === 'done')).toBe(true);
  });

  it('правка второй среды убирает весь поиск из памяти', async () => {
    const { app, jobs } = await setup();
    const { id } = await start(app, ['demo', 'test']);
    await finish(app, id);
    jobs.dropScope('pay', 'test');
    expect(errorOf(await app.inject(`/api/searches/${id}`))).toEqual([404, 'search-expired']);
  });

  it('у поиска одной среды параметр env не читается', async () => {
    const { app } = await setup();
    const r = await app.inject({ method: 'POST', url: '/api/projects/pay/envs/demo/searches', payload: { terms: [CID], period: { preset: '24h' } } });
    const { id } = r.json() as SearchCreated;
    const s = await finish(app, id);
    expect(s.envs).toBeUndefined();
    expect(s.requests[0]?.env).toBeUndefined();
    expect((await app.inject(`/api/searches/${id}/requests/${CID}?env=test`)).statusCode).toBe(200);
  });
});

// ---------- Задание и пул без хранилища ----------

interface FakeJob {
  status: SearchStatus;
  error: null | { code: string; stage: 'count' | 'fetch' };
  requests: never[];
  started: number;
  release: () => void;
}

/** Часть с заданием, которое идёт, пока тест его не отпустит. */
function fakePart(env: string, store: string): MultiPart & { fake: FakeJob } {
  const fake: FakeJob = { status: 'running', error: null, requests: [], started: 0, release: () => undefined };
  const job = {
    get status() {
      return fake.status;
    },
    get error() {
      return fake.error;
    },
    requests: fake.requests,
    keep: new Set<string>(),
    spec: {},
    start: () => {
      fake.started++;
      return new Promise<void>((r) => {
        fake.release = () => {
          fake.status = 'done';
          r();
        };
      });
    },
    cancel: () => {
      if (fake.status === 'running') fake.status = 'cancelled';
      fake.release();
    },
    state: () => ({ status: fake.status, stage: 'count', found: 0, tooMany: false, truncated: false, scannedFromMs: null, lines: 'none', progress: { chunksDone: 0, chunksTotal: 1, batchesDone: 0, batchesTotal: 0 }, requestsTotal: 0, error: fake.error }),
  } as unknown as SearchJob;
  return { env, store, job, fake };
}

const multi = (parts: MultiPart[], parallel = 3, sequential = false) =>
  new MultiSearch('m1', 'k', parts, { project: 'pay', now: () => 0, parallel: () => parallel, ...(sequential ? { sequential } : {}), period: { fromMs: 0, toMs: 1, preset: null }, terms: [{ display: 'abcdef', kind: 'text' }] });

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('очередь частей', () => {
  it('в одно хранилище не больше parallelFor сред сразу, остальные начинают по освобождении', async () => {
    const parts = ['a', 'b', 'c', 'd', 'e'].map((e) => fakePart(e, 'grafana'));
    const m = multi(parts, 3);
    void m.start();
    await tick();
    expect(parts.map((p) => p.fake.started)).toEqual([1, 1, 1, 0, 0]);
    expect(m.state().envs!.map((p) => p.status)).toEqual(['running', 'running', 'running', 'running', 'running']);
    parts[1]!.fake.release();
    await tick();
    expect(parts.map((p) => p.fake.started)).toEqual([1, 1, 1, 1, 0]);
  });

  it('среды разных хранилищ идут одновременно', async () => {
    const parts = [fakePart('a', 'one'), fakePart('b', 'two')];
    void multi(parts, 1).start();
    await tick();
    expect(parts.map((p) => p.fake.started)).toEqual([1, 1]);
  });

  it('по очереди: одна среда за другой даже на разных хранилищах', async () => {
    const parts = [fakePart('a', 'one'), fakePart('b', 'two')];
    void multi(parts, 3, true).start();
    await tick();
    expect(parts.map((p) => p.fake.started)).toEqual([1, 0]);
    parts[0]!.fake.release();
    await tick();
    expect(parts.map((p) => p.fake.started)).toEqual([1, 1]);
  });

  it('остановка: не начатые среды не начинаются, статус cancelled', async () => {
    const parts = [fakePart('a', 'g'), fakePart('b', 'g')];
    const m = multi(parts, 1);
    void m.start();
    await tick();
    m.cancel();
    await tick();
    expect(parts.map((p) => p.fake.started)).toEqual([1, 0]);
    expect(m.status).toBe('cancelled');
  });

  it('сводный статус и общая ошибка', () => {
    const [a, b] = [fakePart('a', 'g'), fakePart('b', 'g')];
    const m = multi([a!, b!]);
    a!.fake.status = 'failed';
    a!.fake.error = { code: 'timeout', stage: 'count' };
    expect(m.status).toBe('running');
    b!.fake.status = 'done';
    expect(m.status).toBe('done');
    expect(m.state().error).toBeNull();
    expect(m.error).toEqual({ code: 'timeout', stage: 'count' });
    b!.fake.status = 'failed';
    b!.fake.error = { code: 'limit', stage: 'count' };
    expect(m.status).toBe('failed');
    expect(m.state().error?.code).toBe('timeout');
  });
});

describe('пул: вес и набор сред', () => {
  const stored = (id: string, weight?: number): StoredJob => ({ id, key: id, createdAt: 0, status: 'done', error: null, lastAccess: 0, lastPoll: 0, cancel: () => undefined, ...(weight ? { weight } : {}) });

  it('задание по трём средам весит три: вытесняются давние, новое остаётся', () => {
    const jobs = new SearchJobs<StoredJob>({ now: () => 0, timer: false, maxJobs: 4 });
    for (const id of ['a', 'b', 'c']) jobs.create(id, true, () => stored(id));
    const { job } = jobs.create('m', true, () => stored('m', 3));
    expect(jobs.has('a')).toBe(false);
    expect(jobs.has('b')).toBe(false);
    expect(jobs.has('c')).toBe(true);
    expect(jobs.has(job.id)).toBe(true);
    const big = jobs.create('big', true, () => stored('big', 9)).job;
    expect(jobs.has(big.id)).toBe(true);
    expect(jobs.size).toBe(1);
  });

  it('правка любой среды набора убирает задание', () => {
    const jobs = new SearchJobs<StoredJob>({ now: () => 0, timer: false });
    jobs.create('m', true, () => stored('m', 2), { project: 'pay', env: 'demo', envs: ['demo', 'test'] });
    jobs.create('s', true, () => stored('s'), { project: 'pay', env: 'demo' });
    jobs.dropScope('pay', 'test');
    expect(jobs.has('m')).toBe(false);
    expect(jobs.has('s')).toBe(true);
  });
});
