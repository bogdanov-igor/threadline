// Чтение операции: общий предел строк, записи без correlation_id, граница окна чтения, прерывание этапа при ошибке.
// Задание собирается напрямую над имитацией с задержкой
// и ошибками по запросу; записи синтетические.
import { describe, expect, it } from 'vitest';
import { BackendError, type CheckInfo, type CountQuery, type LinesQuery, type LogBackend, type LogLine, type Matcher, type TimeRange } from '@threadline/core/backend';
import { validateConfig } from '@threadline/core/config';
import type { OperationFlow, OperationUnread, OperationView } from '@threadline/core/flow';
import { BUILTIN_COUNT_REGEXP, BUILTIN_GET_FLAG, builtinProfile, type CompiledProfile } from '@threadline/core/profile';
import { escapeRegex } from '../src/backends/logql.ts';
import type { MockRecord } from '../src/backends/mock/dataset-pay.ts';
import { MockBackend } from '../src/backends/mock/index.ts';
import { Backends } from '../src/backends/registry.ts';
import type { ResolvedConfig } from '../src/config/load.ts';
import { NO_CATALOG, OperationJob } from '../src/operation/job.ts';

const NOW = Date.UTC(2026, 10, 2, 9, 0, 0);
const S = 1000;
const M = 60 * S;
const H = 60 * M;
/** Конец окна операции: за 10 часов до текущего времени, хвосты возможны. */
const END = NOW - 10 * H;
/** Куски окна по часу от конца: c0 — последний час. */
const C0 = { fromMs: END - H, toMs: END };
const C1 = { fromMs: END - 2 * H, toMs: END - H };
const VALUE = 'aaaaaaaa-1111-4222-8333-444455556666';

const iso = (ms: number) => `${new Date(Math.trunc(ms)).toISOString().slice(0, 23)}000Z`;

/** Запись встроенного формата json; cid null — запись без correlation_id. */
function rec(ms: number, cid: string | null, msg: string, fields: Record<string, unknown>): MockRecord {
  const r = { time: iso(ms), level: 'info', msg, ...(cid ? { correlation_id: cid } : {}), ...fields };
  return {
    tsNs: BigInt(Math.trunc(ms)) * 1_000_000n,
    labels: { namespace: 'pay', container: 'api', app_kubernetes_io_component: 'api', pod: 'api-pod-1' },
    line: JSON.stringify(r),
  };
}

const LEDGER = 'http://ledger.pay.example:8080/v1/transfers/hold';
const incoming = (ms: number, cid: string, method = 'POST', path = '/v1/users/u/transfers') =>
  rec(ms, cid, 'incoming request', { request_id: cid, request: { method, path, ...(method === 'POST' ? { body: `{"transfer":"${VALUE}"}` } : {}) } });
const send = (ms: number, cid: string, rid: string) => rec(ms, cid, 'http request sending', { request_id: rid, upstream: { method: 'POST', url: LEDGER } });
const resp = (ms: number, cid: string, rid: string) => rec(ms, cid, 'http response received', { request_id: rid, upstream: { method: 'POST', url: LEDGER, status: 200 } });

interface Call {
  op: 'lines' | 'count';
  q: LinesQuery | CountQuery;
  atMs: number;
  returned: number;
  bytes: number;
}

interface Hooks {
  /** Задержка ответа или ошибки в мс; прерывание сигналом её обрывает. */
  delayMs?: (op: Call['op'], q: LinesQuery | CountQuery) => number;
  /** Запрос после задержки завершается ошибкой хранилища. */
  fail?: (op: Call['op'], q: LinesQuery | CountQuery) => boolean;
}

/** Имитация с задержкой и ошибками по запросу; запоминает каждый запрос, его время и ответ. */
class Store implements LogBackend {
  readonly calls: Call[] = [];
  readonly #inner: MockBackend;
  readonly #hooks: Hooks;
  readonly #t0 = performance.now();
  constructor(inner: MockBackend, hooks: Hooks) {
    this.#inner = inner;
    this.#hooks = hooks;
  }
  check(signal: AbortSignal): Promise<CheckInfo> {
    return this.#inner.check(signal);
  }
  labelValues(label: string, scope: Matcher[], range: TimeRange, signal: AbortSignal): Promise<string[]> {
    return this.#inner.labelValues(label, scope, range, signal);
  }
  queryLines(q: LinesQuery, signal: AbortSignal): Promise<LogLine[]> {
    return this.#run('lines', q, signal, async () => {
      const r = await this.#inner.queryLines(q, signal);
      return { r, returned: r.length, bytes: r.reduce((n, l) => n + l.line.length, 0) };
    });
  }
  countBy(q: CountQuery, signal: AbortSignal): Promise<Record<string, number>> {
    return this.#run('count', q, signal, async () => {
      const r = await this.#inner.countBy(q, signal);
      return { r, returned: Object.keys(r).length, bytes: 0 };
    });
  }
  async #run<T>(op: Call['op'], q: LinesQuery | CountQuery, signal: AbortSignal, fn: () => Promise<{ r: T; returned: number; bytes: number }>): Promise<T> {
    const call: Call = { op, q, atMs: performance.now() - this.#t0, returned: 0, bytes: 0 };
    this.calls.push(call);
    const ms = this.#hooks.delayMs?.(op, q) ?? 0;
    if (ms > 0) await abortable(ms, signal);
    if (this.#hooks.fail?.(op, q)) throw new BackendError('bad-response', { details: 'имитация: ошибка запроса' });
    const { r, returned, bytes } = await fn();
    call.returned = returned;
    call.bytes = bytes;
    return r;
  }
}

function abortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new BackendError('cancelled'));
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new BackendError('cancelled'));
    }, { once: true });
  });
}

interface Run {
  job: OperationJob;
  store: Store;
  op: OperationView;
  ms: number;
}

/** Поиск операции за 3 часа [END − 3 ч, END] над записями records. */
async function runOperation(
  records: MockRecord[],
  opts: { maxConcurrent?: number; search?: { maxLinesPerSearch?: number; maxLinesPerQuery?: number }; hooks?: Hooks; profile?: CompiledProfile } = {},
): Promise<Run> {
  const v = validateConfig({
    auth: 'off',
    defaults: { project: 'pay', environment: 'demo' },
    backends: { demo: { type: 'mock', maxConcurrent: opts.maxConcurrent ?? 4 } },
    search: opts.search ?? {},
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
      store = new Store(mock, opts.hooks ?? {});
      return store;
    },
  });
  const env = backends.environment('pay', 'demo')!;
  const pattern = escapeRegex(VALUE);
  const window = { fromMs: END - 3 * H, toMs: END };
  const job = new OperationJob(
    'job-1',
    'key-1',
    {
      project: 'pay',
      env,
      selector: env.selector,
      terms: [{ kind: 'text', value: VALUE, display: VALUE, filter: { kind: 'regex', pattern } }],
      period: { ...window, preset: null },
      profile: opts.profile ?? builtinProfile(),
      limits: v.config.search,
    },
    {
      project: 'pay',
      envId: 'demo',
      stand: null,
      mock: true,
      key: { type: 'transfer', values: [VALUE], also: [] },
      search: { values: [{ type: 'transfer', value: VALUE }], pattern },
      window: { ...window, preset: '6h' },
      excluded: [],
      flagRegexp: BUILTIN_GET_FLAG,
    },
    { backends, now: () => NOW, warn: () => {}, catalog: NO_CATALOG },
  );
  const t0 = performance.now();
  await job.start();
  return { job, store: store!, op: job.state().operation!, ms: performance.now() - t0 };
}

const lineCalls = (s: Store) => s.calls.filter((c) => c.op === 'lines');
const unreadRows = (op: OperationView) => op.items.filter((i): i is OperationUnread => i.kind === 'unread');
const allFlows = (op: OperationView): OperationFlow[] => op.items.flatMap((i) => (i.kind === 'group' ? i.flows : i.kind === 'flow' ? [i] : []));
const isTail = (q: LinesQuery) => q.range.toMs - q.range.fromMs === 15 * M;

/** Поток: входящий запрос с id операции и пары отправка/ответ, 100 мс между строками; extra — строки без отправок. */
function flowLines(cid: string, at: number, pairs: number, extra = 0): MockRecord[] {
  const out = [incoming(at, cid)];
  for (let k = 1; k <= pairs; k++) out.push(send(at + (2 * k - 1) * 100, cid, `${cid}-${k}`), resp(at + 2 * k * 100, cid, `${cid}-${k}`));
  for (let k = 0; k < extra; k++) out.push(rec(at + (2 * pairs + 1 + k) * 100, cid, 'still working', {}));
  return out;
}

const cidOf = (i: number) => `cid-${String(i).padStart(3, '0')}`;

describe('предел строк этапа чтения', () => {
  it('один пакет 7 500 строк при пределе 20 000 и трёх местах: все 50 потоков целиком', async () => {
    const records = Array.from({ length: 50 }, (_, f) => flowLines(cidOf(f), END - 50 * M + f * 20 * S, 74, 1)).flat();
    expect(records).toHaveLength(7500);
    const { job, op, store } = await runOperation(records);
    const flows = job.seed().flows;
    expect(job.status).toBe('done');
    expect(job.truncated).toBe(false);
    expect(flows.size).toBe(50);
    expect([...flows.values()].filter((f) => f.incomplete)).toHaveLength(0);
    expect([...flows.values()].reduce((n, f) => n + f.records.length, 0)).toBe(7500);
    expect(unreadRows(op)).toEqual([]);
    expect(op.outcome.partial).toBe(false);
    // Страница 5 000, затем с её последней строки включительно (+1 повтор) и пустая за короткой.
    expect(lineCalls(store).map((c) => c.returned)).toEqual([5000, 2501, 0]);
  });

  it('предел оборвал пакет: потоки без строк — строкой «не прочитаны» за час пакета, со строками — «записи неполные»', async () => {
    // 50 потоков по 3 строки, предел 100: прочитаны 33 потока и первая строка 34-го.
    const records = Array.from({ length: 50 }, (_, f) => flowLines(cidOf(f), END - 50 * M + f * 20 * S, 1)).flat();
    const { job, op } = await runOperation(records, { search: { maxLinesPerSearch: 100, maxLinesPerQuery: 100 } });
    const flows = job.seed().flows;
    expect(job.status).toBe('done');
    expect(job.truncated).toBe(true);
    expect(job.state().found).toBe(50);
    expect(flows.size).toBe(34);
    expect([...flows.values()].every((f) => f.incomplete)).toBe(true);
    expect(unreadRows(op)).toEqual([{ kind: 'unread', count: 16, fromMs: C0.fromMs, toMs: C0.toMs, reason: 'limit' }]);
    expect(op.outcome.partial).toBe(true);
  });

  it('поток без строк в оборванном часе, но прочитанный в другом: «записи неполные», в строку непрочитанного не входит', async () => {
    const records = [
      ...flowLines('shared', C1.toMs - 10 * M, 1),
      ...Array.from({ length: 40 }, (_, f) => flowLines(cidOf(f), C0.fromMs + M + f * 20 * S, 1)).flat(),
      ...flowLines('shared', END - 10 * M, 1),
    ];
    // Одно место: часы читаются от раннего к позднему, на последний час остаётся 97 строк из 100,
    // строки shared в нём идут после строк 40 потоков.
    const { job, op } = await runOperation(records, { maxConcurrent: 2, search: { maxLinesPerSearch: 100, maxLinesPerQuery: 100 } });
    const flows = job.seed().flows;
    expect(job.truncated).toBe(true);
    expect(flows.get('shared')).toMatchObject({ incomplete: true });
    expect(flows.get('shared')!.records).toHaveLength(3);
    // 97 строк последнего часа: 32 потока целиком и первая строка 33-го; 7 потоков без строк.
    expect(flows.size).toBe(34);
    expect(unreadRows(op)).toEqual([{ kind: 'unread', count: 7, fromMs: C0.fromMs, toMs: C0.toMs, reason: 'limit' }]);
  });
});

describe('записи без correlation_id', () => {
  /** Поток с id операции, 1 350 опросов партнёра раз в 8 с и строка крона раз в час. */
  function pollsAndCron(): MockRecord[] {
    const out = flowLines('cid-main', END - 150 * M, 5, 1);
    let n = 0;
    for (let t = END - 3 * H + S; t < END; t += 8 * S) {
      const cid = `poll-${n++}`;
      out.push(incoming(t, cid, 'GET', `/v1/users/u/transfers/${VALUE}`), rec(t + 30, cid, 'http response received', { request_id: cid, upstream: { method: 'GET', url: '/x', status: 200 } }));
    }
    expect(n).toBe(1350);
    for (let h = 0; h < 3; h++) out.push(rec(END - h * H - 20 * M, null, 'transfer status job', { ctx: { transfer: VALUE } }));
    return out;
  }

  for (const [name, regexp] of [
    ['встроенное выражение', BUILTIN_COUNT_REGEXP],
    ['группа в форме (?<cid>…)', BUILTIN_COUNT_REGEXP.replace('(?P<cid>', '(?<cid>')],
  ] as const) {
    it(`крон среди опросов партнёра: читаются только 3 строки крона (${name})`, async () => {
      const profile = { ...builtinProfile(), countRegexp: regexp };
      const { job, op, store } = await runOperation(pollsAndCron(), { profile });
      expect(job.status).toBe('done');
      const nocid = lineCalls(store).filter((c) => (c.q as LinesQuery).filters.some((f) => f.kind === 'not-regex'));
      // По чтению на час: страница со строкой крона и пустая за ней.
      expect(nocid.filter((c) => c.q.range.fromNs === undefined)).toHaveLength(3);
      for (const c of nocid) {
        expect((c.q as LinesQuery).filters).toEqual([
          { kind: 'regex', pattern: escapeRegex(VALUE) },
          // Хранилище получает группы в форме (?P<…>.
          { kind: 'not-regex', pattern: BUILTIN_COUNT_REGEXP },
        ]);
      }
      expect(nocid.reduce((n, c) => n + c.returned, 0)).toBe(3);
      expect(job.seed().nocid.size).toBe(3);
      expect(allFlows(op).filter((f) => f.nocid)).toHaveLength(3);
      // Опросы — одной строкой, поток прочитан.
      expect(op.items.find((i) => i.kind === 'polls')).toMatchObject({ count: 1350 });
      expect(job.seed().flows.get('cid-main')?.records).toHaveLength(12);
    });
  }
});

describe('граница окна чтения', () => {
  /** Ранний час (c2) отвечает позже позднего (c0). */
  const lateEarly: Hooks = { delayMs: (op, q) => (op === 'lines' && q.range.fromMs < END - 2 * H ? 50 : 0) };

  it('совпадения в двух несоседних часах, поздний прочитан раньше: без хвоста и без «записи неполные»', async () => {
    const records: MockRecord[] = [];
    for (const at of [END - 150 * M, END - 30 * M]) {
      records.push(rec(at, 'retry-1', 'job attempt', { request_id: 'r', ctx: { transfer: VALUE } }), send(at + 500, 'retry-1', `r${at}`), resp(at + 900, 'retry-1', `r${at}`));
    }
    const { job, op, store } = await runOperation(records, { hooks: lateEarly });
    const f = job.seed().flows.get('retry-1')!;
    expect(f.records).toHaveLength(6);
    expect(f.incomplete).toBe(false);
    expect(lineCalls(store).filter((c) => isTail(c.q as LinesQuery))).toHaveLength(0);
    expect(op.outcome.partial).toBe(false);
    expect(job.request('retry-1')?.summary.incomplete).toBe(false);
  });

  it('отправка без ответа только в позднем часе: хвост читается только за поздним часом', async () => {
    const early = END - 150 * M;
    const late = END - 30 * M;
    const records = [
      rec(early, 'retry-2', 'job attempt', { request_id: 'r', ctx: { transfer: VALUE } }),
      send(early + 500, 'retry-2', 'r-early'),
      resp(early + 900, 'retry-2', 'r-early'),
      rec(late, 'retry-2', 'job attempt', { request_id: 'r', ctx: { transfer: VALUE } }),
      send(late + 500, 'retry-2', 'r-late'),
    ];
    const { store } = await runOperation(records, { hooks: lateEarly });
    const tails = lineCalls(store).filter((c) => isTail(c.q as LinesQuery));
    expect(tails.map((c) => c.q.range.fromMs)).toEqual([END + 5 * M]);
  });
});

describe('ошибка в параллельном этапе', () => {
  /** Поток в каждом из трёх часов, за 30 минут до конца часа. */
  const hourly = () => [0, 1, 2].flatMap((h) => [incoming(END - h * H - 30 * M, `c${h}`), send(END - h * H - 30 * M + 100, `c${h}`, `c${h}-1`)]);

  it('пакет чтения упал, пока другой читается: тот прерван, новых запросов нет, поиск сразу завершён ошибкой', async () => {
    // Чтение двух ранних часов падает сразу, последний час отвечал бы секунду.
    const early = (q: LinesQuery | CountQuery) => q.range.fromMs < END - H - 5 * M;
    const { job, op, store, ms } = await runOperation(hourly(), {
      hooks: { fail: (op, q) => op === 'lines' && early(q), delayMs: (op, q) => (op === 'lines' && !early(q) ? 1000 : 0) },
    });
    expect(job.status).toBe('failed');
    expect(job.error).toMatchObject({ code: 'bad-response', stage: 'fetch' });
    expect(ms).toBeLessThan(800);
    // По запросу на час, ни одной следующей страницы и ни одного хвоста.
    expect(lineCalls(store).length).toBeLessThanOrEqual(3);
    expect(lineCalls(store).every((c) => c.q.range.fromNs === undefined && !isTail(c.q as LinesQuery))).toBe(true);
    expect(job.seed().flows.size).toBe(0);
    expect(op.outcome.partial).toBe(true);
  });

  it('подсчёт упал, пока идёт подсчёт другого часа: тот прерван, граница — последний час без пропусков', async () => {
    // c0 отвечает сразу, c1 — через секунду, c2 падает через 30 мс, после ответа c0.
    const { job, ms } = await runOperation(hourly(), {
      hooks: {
        fail: (op, q) => op === 'count' && q.range.fromMs === END - 3 * H,
        delayMs: (op, q) => (op !== 'count' ? 0 : q.range.fromMs === C1.fromMs ? 1000 : q.range.fromMs === END - 3 * H ? 30 : 0),
      },
    });
    expect(job.status).toBe('failed');
    expect(job.error).toMatchObject({ code: 'bad-response', stage: 'count' });
    expect(ms).toBeLessThan(800);
    expect(job.state().scannedFromMs).toBe(C0.fromMs);
    // Операция собрана из просмотренного часа.
    expect([...job.seed().flows.keys()]).toEqual(['c0']);
  });
});
