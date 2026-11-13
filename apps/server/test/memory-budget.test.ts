// Память под результаты: оценка строки, бюджет, доля владельца, вытеснение завершённых,
// предел одного задания у поиска, операции и поиска по нескольким средам, повтор крупной страницы. Записи синтетические.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BackendError, type CheckInfo, type CountQuery, type LinesQuery, type LogBackend, type LogLine, type Matcher, type TimeRange } from '@threadline/core/backend';
import { validateConfig } from '@threadline/core/config';
import { BUILTIN_GET_FLAG, builtinProfile } from '@threadline/core/profile';
import type { SearchStatus } from '@threadline/core/search';
import { escapeRegex } from '../src/backends/logql.ts';
import type { MockRecord } from '../src/backends/mock/dataset-pay.ts';
import { MockBackend } from '../src/backends/mock/index.ts';
import { Backends } from '../src/backends/registry.ts';
import type { ResolvedConfig } from '../src/config/load.ts';
import { Metrics } from '../src/metrics.ts';
import { NO_CATALOG, OperationJob } from '../src/operation/job.ts';
import { readLines, SearchJob, type EngineDeps, type SearchSpec } from '../src/search/engine.ts';
import { SearchJobs, type StoredJob } from '../src/search/jobs.ts';
import { lineBytes, MemoryBudget, readCap, RECORD_OVERHEAD, type MemoryGate } from '../src/search/memory.ts';
import { MultiSearch } from '../src/search/multi.ts';
import { SharePool } from '../src/share/pool.ts';

const NOW = Date.UTC(2026, 10, 2, 9, 0, 0);
const M = 60_000;
const H = 60 * M;
const VALUE = 'aaaaaaaa-1111-4222-8333-444455556666';

// ---------- Оценка строки ----------

describe('оценка строки', () => {
  it('ASCII — байт на знак, дважды, и запас на запись', () => {
    expect(lineBytes('abc')).toBe(2 * 3 + RECORD_OVERHEAD);
  });

  it('с кириллицей: строка по два байта на знак, разобранные поля по размеру в UTF-8', () => {
    expect(lineBytes('ab ж')).toBe(2 * 4 + 5 + RECORD_OVERHEAD);
  });
});

// ---------- Бюджет на подставных заданиях ----------

class FakeJob implements StoredJob {
  readonly key = 'k';
  readonly createdAt = 0;
  readonly error = null;
  lastAccess = 0;
  lastPoll = 0;
  status: SearchStatus = 'running';
  bytes = 0;
  gate: MemoryGate | null = null;
  readonly id: string;
  constructor(id: string) {
    this.id = id;
  }
  limitMemory(gate: MemoryGate): void {
    this.gate = gate;
  }
  /** Чтение через шлюз: что дали, то и держится. */
  read(want: number): number {
    const got = this.gate!(this.bytes, want);
    this.bytes += got;
    return got;
  }
  cancel(): void {
    if (this.status === 'running') this.status = 'cancelled';
  }
}

function pools(limitBytes: number) {
  const clock = { t: 1_800_000_000_000 };
  const memory = new MemoryBudget({ limitBytes });
  const main = new SearchJobs<FakeJob>({ now: () => clock.t, timer: false, memory });
  const guest = new SearchJobs<FakeJob>({ now: () => clock.t, timer: false, memory, guest: true });
  let n = 0;
  /** Задание владельца holder; done — завершённое с bytes в памяти. */
  const job = (holder: string | undefined, bytes: number, done = true, pool = main) => {
    clock.t += 1000;
    const j = pool.create(`k${n}`, true, () => new FakeJob(`j${n++}`), { project: 'pay', env: 'demo', ...(holder !== undefined ? { holder } : {}) }).job;
    j.bytes = bytes;
    if (done) j.status = 'done';
    return j;
  };
  return { clock, memory, main, guest, job };
}

describe('бюджет памяти', () => {
  it('доли от бюджета: задание четверть, владелец половина', () => {
    const memory = new MemoryBudget({ limitBytes: 1000 });
    expect([memory.limit, memory.jobLimit, memory.holderLimit]).toEqual([1000, 250, 500]);
  });

  it('по умолчанию треть предела кучи', () => {
    const memory = new MemoryBudget();
    expect(memory.limit).toBe(Math.floor(memory.heapLimit / 3));
    expect(memory.describe()).toMatch(/^память под результаты поиска: \d+ МБ, треть предела кучи \d+ МБ/);
  });

  it('бюджет следует за NODE_OPTIONS: предел образа и вдвое больший', () => {
    const url = pathToFileURL(new URL('../src/search/memory.ts', import.meta.url).pathname).href;
    const probe = (mb: number) =>
      JSON.parse(
        execFileSync(process.execPath, ['--input-type=module', '-e', `const { MemoryBudget } = await import(${JSON.stringify(url)}); const m = new MemoryBudget(); console.log(JSON.stringify([m.heapLimit, m.limit, m.describe()]))`], {
          env: { ...process.env, NODE_OPTIONS: `--max-old-space-size=${mb}` },
          encoding: 'utf8',
        }),
      ) as [number, number, string];
    const [heap, limit, text] = probe(640);
    // V8 прибавляет к старому поколению молодое: у Node 24 это 192 МБ.
    expect(heap / 2 ** 20).toBeGreaterThanOrEqual(640);
    expect(heap / 2 ** 20).toBeLessThanOrEqual(900);
    expect(limit).toBe(Math.floor(heap / 3));
    expect(text).toContain(`треть предела кучи ${Math.round(heap / 2 ** 20)} МБ`);
    expect(probe(1280)[1]).toBeGreaterThan(limit + 200 * 2 ** 20);
  });

  it('предел одного задания: сверх четверти бюджета чтение не берёт', () => {
    const { job } = pools(1000);
    const j = job('anna', 0, false);
    expect(j.read(400)).toBe(250);
    expect(j.read(10)).toBe(0);
  });

  it('бюджет занят завершёнными: уходит самый давний у того, кто держит больше всех', () => {
    const { main, memory, job } = pools(900);
    const a1 = job('anna', 250);
    const b1 = job('boris', 300);
    const a2 = job('anna', 150);
    const c = job('vera', 0, false);
    expect(c.read(225)).toBe(225);
    expect(main.has(a1.id)).toBe(false);
    expect([main.has(a2.id), main.has(b1.id)]).toEqual([true, true]);
    expect(memory.evicted).toBe(1);
    expect(memory.used()).toBe(150 + 300 + 225);
  });

  it('бюджет занят только идущими: никто не вытесняется, чтение получает остаток', () => {
    const { main, job } = pools(1000);
    const a = job('anna', 240, false);
    const b = job('boris', 240, false);
    const v = job('vera', 240, false);
    const g = job('gleb', 200, false);
    const d = job('dina', 0, false);
    expect(d.read(200)).toBe(80);
    expect(d.read(10)).toBe(0);
    for (const j of [a, b, v, g, d]) expect(main.has(j.id)).toBe(true);
  });

  it('доля владельца: уходят его же давние результаты, чужие остаются', () => {
    const { main, job } = pools(1000);
    const b1 = job('boris', 100);
    const a1 = job('anna', 300);
    const a2 = job('anna', 100);
    const a3 = job('anna', 0, false);
    expect(a3.read(200)).toBe(200);
    expect(main.has(a1.id)).toBe(false);
    expect([main.has(a2.id), main.has(b1.id)]).toEqual([true, true]);
  });

  it('доля владельца занята его идущими поисками: чтение получает остаток доли', () => {
    const { job } = pools(1000);
    job('anna', 250, false);
    job('anna', 200, false);
    const a = job('anna', 0, false);
    expect(a.read(200)).toBe(50);
  });

  it('свежее обращение: первым уходит результат, к которому обращались раньше', () => {
    const { main, clock, job } = pools(1000);
    const a1 = job('anna', 200);
    const a2 = job('anna', 200);
    clock.t += 1000;
    main.get(a1.id);
    job('boris', 400, false);
    const v = job('vera', 0, false);
    expect(v.read(250)).toBe(250);
    expect([main.has(a1.id), main.has(a2.id)]).toEqual([true, false]);
  });

  it('без входа: владелец — адрес клиента, широкий поиск вытесняет сначала свои результаты', () => {
    const { main, job } = pools(1000);
    const x = job('ip:10.0.0.1', 300);
    const y = job('ip:10.0.0.2', 300);
    const z = job('ip:10.0.0.2', 0, false);
    expect(z.read(250)).toBe(250);
    expect([main.has(x.id), main.has(y.id)]).toEqual([true, false]);
  });

  it('пул ссылок: его чтение вытесняет только задания ссылок, даже если больше держит вошедший', () => {
    const { main, guest, job } = pools(1000);
    const a1 = job('anna', 450);
    const b1 = job('boris', 300);
    const l1 = job(undefined, 100, true, guest);
    const l3 = job(undefined, 0, false, guest);
    expect(l3.read(250)).toBe(250);
    expect([main.has(a1.id), main.has(b1.id)]).toEqual([true, true]);
    expect(guest.has(l1.id)).toBe(false);
  });

  it('пул ссылок — один владелец: сверх половины бюджета уходят давние задания ссылок', () => {
    const { main, guest, job } = pools(1000);
    const a1 = job('anna', 100);
    const l1 = job(undefined, 150, true, guest);
    const l2 = job(undefined, 200, true, guest);
    const l3 = job(undefined, 0, false, guest);
    expect(l3.read(250)).toBe(250);
    expect(main.has(a1.id)).toBe(true);
    expect([guest.has(l1.id), guest.has(l2.id)]).toEqual([false, true]);
  });

  it('пул ссылок без своих завершённых: чтение обрывается, результаты вошедших на месте', () => {
    const { main, guest, job } = pools(1000);
    const a1 = job('anna', 450);
    const b1 = job('boris', 450);
    const l = job(undefined, 0, false, guest);
    expect(l.read(250)).toBe(100);
    expect([main.has(a1.id), main.has(b1.id)]).toEqual([true, true]);
  });

  it('чтение обычного поиска может вытеснить завершённое задание ссылки', () => {
    const { main, guest, job } = pools(1000);
    const l1 = job(undefined, 450, true, guest);
    const a1 = job('anna', 350);
    const b = job('boris', 0, false);
    expect(b.read(250)).toBe(250);
    expect(guest.has(l1.id)).toBe(false);
    expect(main.has(a1.id)).toBe(true);
  });

  it('задания нет в пуле: памяти не получает и ничего не вытесняет', () => {
    const { main, memory, job } = pools(1000);
    job('anna', 900);
    const b = job('boris', 0, false);
    main.dropScope('pay', 'demo');
    expect(b.read(250)).toBe(0);
    expect(memory.evicted).toBe(0);
  });

  it('предел чтения без задания: своя память, бюджет не тронут', () => {
    const cap = readCap(100);
    expect([cap(60), cap(60), cap(1)]).toEqual([60, 40, 0]);
  });
});

// ---------- Задания над имитацией ----------

const iso = (ms: number) => `${new Date(Math.trunc(ms)).toISOString().slice(0, 23)}000Z`;

/** Запись встроенного формата json с телом отправки body и значением поиска. */
function rec(ms: number, cid: string, msg: string, body: string): MockRecord {
  const r = { time: iso(ms), level: 'info', msg, correlation_id: cid, request_id: cid, upstream: { method: 'POST', url: 'http://ledger.pay.example:8080/v1/x', body }, ctx: { transfer: VALUE } };
  return {
    tsNs: BigInt(Math.trunc(ms)) * 1_000_000n,
    labels: { namespace: 'pay', container: 'api', app_kubernetes_io_component: 'api', pod: 'api-pod-1' },
    line: JSON.stringify(r),
  };
}

/** flows потоков по per строк с телом длины pad в последние часы до NOW. */
function dataset(flows: number, per: number, pad: number, tag = 'c'): MockRecord[] {
  const out: MockRecord[] = [];
  for (let f = 0; f < flows; f++) {
    const cid = `${tag}${String(f).padStart(4, '0')}-0000-4000-8000-000000000000`;
    const t = NOW - (f % 3) * H - 30 * M + f * 1000;
    out.push(rec(t, cid, 'incoming request', 'x'.repeat(pad)));
    for (let i = 1; i < per; i++) out.push(rec(t + i * 20, cid, 'http request sending', 'x'.repeat(pad)));
  }
  return out;
}

/** Имитация, которая отказывает с too-large, когда предел страницы больше tooLargeAbove. */
class Store implements LogBackend {
  readonly limits: number[] = [];
  readonly inner: MockBackend;
  readonly tooLargeAbove: number;
  constructor(inner: MockBackend, tooLargeAbove = Infinity) {
    this.inner = inner;
    this.tooLargeAbove = tooLargeAbove;
  }
  check(signal: AbortSignal): Promise<CheckInfo> {
    return this.inner.check(signal);
  }
  labelValues(label: string, scope: Matcher[], range: TimeRange, signal: AbortSignal): Promise<string[]> {
    return this.inner.labelValues(label, scope, range, signal);
  }
  async queryLines(q: LinesQuery, signal: AbortSignal): Promise<LogLine[]> {
    this.limits.push(q.limit);
    if (q.limit > this.tooLargeAbove) throw new BackendError('too-large', { details: 'ответ больше 50 МБ' });
    return this.inner.queryLines(q, signal);
  }
  countBy(q: CountQuery, signal: AbortSignal): Promise<Record<string, number>> {
    return this.inner.countBy(q, signal);
  }
}

function world(records: MockRecord[], opts: { tooLargeAbove?: number; maxLinesPerSearch?: number } = {}) {
  const v = validateConfig({
    auth: 'off',
    defaults: { project: 'pay', environment: 'demo' },
    backends: { demo: { type: 'mock', maxConcurrent: 4 } },
    search: opts.maxLinesPerSearch ? { maxLinesPerSearch: opts.maxLinesPerSearch } : {},
    projects: { pay: { name: 'Demo Pay', environments: { demo: { name: 'Демо', backend: 'demo', selector: [{ label: 'namespace', op: '=', value: 'pay' }] } } } },
  });
  if (!v.ok) throw new Error(JSON.stringify(v.issues));
  const d = v.config.backends.demo;
  if (d?.type !== 'mock') throw new Error('нет имитации');
  let store: Store | null = null;
  const resolved: ResolvedConfig = { path: 'x', config: v.config, backends: { demo: d } };
  const backends = new Backends(resolved, {
    createAdapter: (_id, cfg) => {
      const mock = new MockBackend(cfg as never, { anchorMs: NOW });
      mock.records.length = 0;
      mock.records.push(...[...records].sort((a, b) => (a.tsNs < b.tsNs ? -1 : a.tsNs > b.tsNs ? 1 : 0)));
      store = new Store(mock, opts.tooLargeAbove);
      return store;
    },
  });
  const env = backends.environment('pay', 'demo')!;
  const pattern = escapeRegex(VALUE);
  const spec: SearchSpec = {
    project: 'pay',
    envId: 'demo',
    env,
    selector: env.selector,
    terms: [{ kind: 'text', value: VALUE, display: VALUE, filter: { kind: 'regex', pattern } }],
    period: { fromMs: NOW - 6 * H, toMs: NOW, preset: null },
    profile: builtinProfile(),
    limits: v.config.search,
  };
  const deps: EngineDeps & { catalog: typeof NO_CATALOG } = { backends, now: () => NOW, warn: () => {}, catalog: NO_CATALOG };
  const operation = (seed?: ReturnType<OperationJob['seed']>) => (id: string) =>
    new OperationJob(
      id,
      `op|${id}`,
      spec,
      {
        project: 'pay',
        envId: 'demo',
        stand: null,
        mock: true,
        key: { type: 'transfer', values: [VALUE], also: [] },
        search: { values: [{ type: 'transfer', value: VALUE }], pattern },
        window: { fromMs: NOW - 6 * H, toMs: NOW, preset: '6h' },
        excluded: [],
        flagRegexp: BUILTIN_GET_FLAG,
      },
      deps,
      seed,
    );
  return { spec, deps, env, store: () => store!, operation };
}

const linesOf = (records: MockRecord[]) => records.reduce((n, r) => n + lineBytes(r.line), 0);

describe('предел памяти поиска', () => {
  it('длинные строки: чтение обрывается пределом памяти, запросы недочитанного пакета неполные', async () => {
    const records = dataset(20, 50, 2000);
    const w = world(records);
    const memory = new MemoryBudget({ limitBytes: Math.floor(linesOf(records) * 1.6) });
    const jobs = new SearchJobs({ now: () => NOW, timer: false, memory });
    const { job } = jobs.create('k', true, (id) => new SearchJob(id, 'k', w.spec, w.deps), { project: 'pay', env: 'demo', holder: 'anna' });
    await job.start();
    const state = (job as SearchJob).state();
    expect(state.status).toBe('done');
    expect(state.truncated).toBe(true);
    expect(state.truncatedBy).toBe('memory');
    expect(job.bytes).toBeLessThanOrEqual(memory.jobLimit);
    expect(job.bytes).toBeGreaterThan(memory.jobLimit * 0.9);
    expect(state.requests.some((r) => r.incomplete)).toBe(true);
  });

  it('обычные строки: предел строк, причина прежняя', async () => {
    const records = dataset(20, 50, 200);
    const w = world(records, { maxLinesPerSearch: 500 });
    const jobs = new SearchJobs({ now: () => NOW, timer: false, memory: new MemoryBudget({ limitBytes: 1e9 }) });
    const { job } = jobs.create('k', true, (id) => new SearchJob(id, 'k', w.spec, w.deps), { project: 'pay', env: 'demo' });
    await job.start();
    const state = (job as SearchJob).state();
    expect(state.truncated).toBe(true);
    expect(state.truncatedBy).toBeUndefined();
  });

  it('без бюджета чтение как раньше: все строки, без обрыва', async () => {
    const records = dataset(10, 20, 500);
    const w = world(records);
    const job = new SearchJob('j', 'k', w.spec, w.deps);
    await job.start();
    expect(job.state().truncated).toBe(false);
    expect(job.bytes).toBe(linesOf(records));
  });

  it('отказ памяти обнуляет общий предел строк: другие чтения не идут', async () => {
    const records = dataset(5, 40, 100);
    const w = world(records);
    const sorted = [...records].sort((a, b) => (a.tsNs < b.tsNs ? -1 : 1));
    const budget = { left: 1000, memory: readCap(linesOf(sorted.slice(0, 30))) };
    const q: LinesQuery = { selector: w.env.selector, filters: [{ kind: 'regex', pattern: escapeRegex(VALUE) }], range: { fromMs: NOW - 6 * H, toMs: NOW }, limit: 5000, direction: 'forward' };
    const read = await readLines(w.deps, w.env, q, budget, new AbortController().signal);
    expect(read).toMatchObject({ truncated: true, memory: true });
    expect(read.lines.length).toBe(30);
    expect(budget.left).toBe(0);
  });

  it('поиск операции: предел памяти, итог по неполным данным', async () => {
    const records = dataset(30, 40, 2000);
    const w = world(records);
    const memory = new MemoryBudget({ limitBytes: Math.floor(linesOf(records) * 1.2) });
    const jobs = new SearchJobs({ now: () => NOW, timer: false, memory });
    const { job } = jobs.create('op', true, w.operation(), { project: 'pay', env: 'demo', holder: 'anna' });
    await job.start();
    const op = job as OperationJob;
    expect(op.state().truncatedBy).toBe('memory');
    expect(op.bytes).toBeLessThanOrEqual(memory.jobLimit);
    expect(op.operationView().outcome.partial).toBe(true);
  });

  it('дополнение операции: свой предел на новое чтение, записи прежнего в памяти дополнения', async () => {
    const records = dataset(10, 20, 300);
    const w = world(records);
    const memory = new MemoryBudget({ limitBytes: 1e9 });
    const jobs = new SearchJobs({ now: () => NOW, timer: false, memory });
    const parent = jobs.create('op', true, w.operation(), { project: 'pay', env: 'demo', holder: 'anna' }).job as OperationJob;
    await parent.start();
    const child = jobs.create('op2', true, w.operation(parent.seed()), { project: 'pay', env: 'demo', holder: 'anna' }).job as OperationJob;
    expect(child.bytes).toBe(parent.bytes);
    expect(child.memory.read).toBe(0);
    expect(memory.used()).toBe(2 * parent.bytes);
  });

  it('поиск по нескольким средам: каждая среда в пределе задания, все вместе в доле владельца', async () => {
    const records = dataset(20, 50, 2000);
    const w = world(records);
    const memory = new MemoryBudget({ limitBytes: Math.floor(linesOf(records) * 1.5) });
    const jobs = new SearchJobs({ now: () => NOW, timer: false, memory });
    const parts = ['prod', 'test', 'dev'].map((env) => ({ env, store: 'demo', job: new SearchJob(`${env}-job`, 'k', { ...w.spec, envId: env }, w.deps) }));
    const multi = jobs.create('m', true, (id) => new MultiSearch(id, 'm', parts, { project: 'pay', now: () => NOW, parallel: () => 1, sequential: true, period: w.spec.period, terms: [] }), { project: 'pay', env: 'prod', envs: ['prod', 'test', 'dev'], holder: 'anna' }).job as MultiSearch;
    await multi.start();
    for (const p of parts) expect(p.job.bytes).toBeLessThanOrEqual(memory.jobLimit);
    expect(multi.bytes).toBeLessThanOrEqual(memory.holderLimit);
    const states = multi.partStates();
    expect(states.map((s) => s.truncatedBy)).toEqual(['memory', 'memory', 'memory']);
  });

  it('пул ссылок подключён к бюджету как один владелец', async () => {
    const memory = new MemoryBudget({ limitBytes: 1e9 });
    const pool = new SharePool({ now: () => NOW, timer: false, memory });
    const records = dataset(3, 10, 100);
    const w = world(records);
    const run = pool.run('L1', (create) => create((id) => new SearchJob(id, 'link:L1', w.spec, w.deps), { project: 'pay', env: 'demo' }))!;
    await run.job.done;
    await new Promise((r) => setTimeout(r, 0));
    expect(memory.used()).toBe(run.job.bytes);
    expect(run.job.bytes).toBe(linesOf(records));
    pool.close();
  });
});

// ---------- Крупная страница ----------

describe('страница больше предела ответа', () => {
  const query = (w: ReturnType<typeof world>, limit = 5000): LinesQuery => ({ selector: w.env.selector, filters: [{ kind: 'regex', pattern: escapeRegex(VALUE) }], range: { fromMs: NOW - 6 * H, toMs: NOW }, limit, direction: 'forward' });

  it('страница читается вдвое меньшим пределом, дальше чтение идёт с ним, строки без потерь и повторов', async () => {
    const records = dataset(40, 100, 10);
    const w = world(records, { tooLargeAbove: 1250 });
    const read = await readLines(w.deps, w.env, query(w), 20_000, new AbortController().signal);
    expect(read.truncated).toBe(false);
    expect(read.lines.length).toBe(records.length);
    expect(new Set(read.lines.map((l) => `${l.tsNs}|${l.line}`)).size).toBe(records.length);
    const limits = w.store().limits;
    expect(limits.slice(0, 3)).toEqual([5000, 2500, 1250]);
    expect(new Set(limits.slice(2))).toEqual(new Set([1250]));
  });

  it('и 625 строк больше предела: шаг падает с too-large после четырёх запросов', async () => {
    const records = dataset(5, 10, 10);
    const w = world(records, { tooLargeAbove: 0 });
    await expect(readLines(w.deps, w.env, query(w), 20_000, new AbortController().signal)).rejects.toMatchObject({ code: 'too-large' });
    expect(w.store().limits).toEqual([5000, 2500, 1250, 625]);
  });
});

// ---------- Метрики ----------

describe('метрики памяти', () => {
  it('процесс Node, куча, сборка мусора, цикл событий и память результатов', async () => {
    const metrics = new Metrics({ runtime: true });
    const { memory, job } = pools(1000);
    metrics.watchMemory(memory);
    job('anna', 500);
    job('anna', 300);
    const b = job('boris', 0, false);
    b.read(250);
    const text = await metrics.registry.metrics();
    for (const name of ['nodejs_heap_size_used_bytes', 'nodejs_gc_duration_seconds', 'nodejs_eventloop_lag_p99_seconds', 'process_resident_memory_bytes']) expect(text).toContain(`# TYPE ${name} `);
    expect(text).toContain('jobs_memory_bytes 550');
    expect(text).toContain('jobs_memory_limit_bytes 1000');
    expect(text).toContain('jobs_memory_evicted_total 1');
  });
});
