import { describe, expect, it } from 'vitest';
import { BackendError, type CheckInfo, type CountQuery, type Filter, type LinesQuery, type LogBackend, type LogLine, type TimeRange } from '@threadline/core/backend';
import { validateConfig, type SearchConfig } from '@threadline/core/config';
import { BUILTIN_COUNT_REGEXP, builtinProfile } from '@threadline/core/profile';
import { parseLine, tsNsToMs, validateExcludes, validateTerms, type Term } from '@threadline/core/search';
import type { ResolvedConfig } from '../src/config/load.ts';
import { Backends } from '../src/backends/registry.ts';
import { countChunks, planBatches, readLinesPage, SearchJob, type EngineDeps, type SearchSpec } from '../src/search/engine.ts';
import { decodeCursor, encodeCursor, type PageCursor } from '../src/search/paging.ts';

const M = 60_000;
const H = 60 * M;
const NOW = Date.UTC(2026, 10, 2, 12, 0, 0);
const EXACT = '4111111234557893';
const TWIN = '4111119999957893';
const MASKED = '411111******7893';

const MS = 1_000_000n;
const nsOf = (ms: number) => BigInt(Math.trunc(ms)) * MS;
const bounds = (r: TimeRange) => ({
  from: r.fromNs !== undefined ? BigInt(r.fromNs) : nsOf(r.fromMs),
  to: r.toNs !== undefined ? BigInt(r.toNs) : nsOf(r.toMs),
});

function filtered(lines: LogLine[], filters: Filter[], range: TimeRange): LogLine[] {
  const { from, to } = bounds(range);
  const tests = filters.map((f) => {
    if (f.kind === 'contains') return (l: string) => l.includes(f.value);
    if (f.kind === 'not-contains') return (l: string) => !l.includes(f.value);
    const re = new RegExp(f.pattern);
    return f.kind === 'regex' ? (l: string) => re.test(l) : (l: string) => !re.test(l);
  });
  return lines.filter((l) => BigInt(l.tsNs) >= from && BigInt(l.tsNs) <= to && tests.every((t) => t(l.line)));
}

/** Хранилище в памяти: считает вызовы, запоминает запросы и сигналы, умеет подменять ответ. */
class FakeStore implements LogBackend {
  lines: LogLine[] = [];
  readonly counts: CountQuery[] = [];
  readonly queries: LinesQuery[] = [];
  readonly signals: AbortSignal[] = [];
  active = 0;
  maxActive = 0;
  onCount: ((q: CountQuery, n: number, signal: AbortSignal) => Promise<Record<string, number> | undefined> | Record<string, number> | undefined) | undefined;
  onLines: ((q: LinesQuery, n: number, signal: AbortSignal) => Promise<LogLine[] | undefined> | LogLine[] | undefined) | undefined;

  async check(): Promise<CheckInfo> {
    return { labelNames: [] };
  }
  async labelValues(): Promise<string[]> {
    return [];
  }

  async countBy(q: CountQuery, signal: AbortSignal): Promise<Record<string, number>> {
    const n = this.counts.push(q) - 1;
    this.signals.push(signal);
    return this.#track(async () => {
      const custom = await this.onCount?.(q, n, signal);
      if (custom) return custom;
      const out: Record<string, number> = {};
      for (const l of filtered(this.lines, q.filters, q.range)) {
        const cid = parseLine(l).correlationId;
        if (cid) out[cid] = (out[cid] ?? 0) + 1;
      }
      return out;
    });
  }

  async queryLines(q: LinesQuery, signal: AbortSignal): Promise<LogLine[]> {
    const n = this.queries.push(q) - 1;
    this.signals.push(signal);
    return this.#track(async () => {
      const custom = await this.onLines?.(q, n, signal);
      if (custom) return custom;
      const sign = q.direction === 'forward' ? 1 : -1;
      return filtered(this.lines, q.filters, q.range)
        .sort((a, b) => (BigInt(a.tsNs) < BigInt(b.tsNs) ? -sign : BigInt(a.tsNs) > BigInt(b.tsNs) ? sign : 0))
        .slice(0, q.limit);
    });
  }

  async #track<T>(fn: () => Promise<T>): Promise<T> {
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      return await fn();
    } finally {
      this.active--;
    }
  }
}

const v = validateConfig({
  auth: 'off',
  defaults: { project: 'pay', environment: 'demo' },
  backends: { demo: { type: 'mock' } },
  projects: { pay: { name: 'Demo Pay', environments: { demo: { name: 'Демо', backend: 'demo', selector: [{ label: 'namespace', op: '=', value: 'pay' }] } } } },
});
if (!v.ok) throw new Error(JSON.stringify(v.issues));
const CONFIG = v.config;
const DEFAULTS: SearchConfig = CONFIG.search;

function excludes(raws: string[], terms: Term[]): Term[] {
  const v = validateExcludes(raws, terms);
  if (!v.ok) throw new Error(JSON.stringify(v.error));
  return v.excludes;
}

function makeJob(store: FakeStore, o: { terms: string[]; excludes?: string[]; fromMs: number; toMs: number; limits?: Partial<SearchConfig>; now?: number; parallel?: number }) {
  const demo = CONFIG.backends.demo;
  if (demo?.type !== 'mock') throw new Error('bad config');
  const resolved: ResolvedConfig = { path: 'x', config: CONFIG, backends: { demo } };
  const backends = new Backends(resolved, { createAdapter: () => store });
  const env = backends.environment('pay', 'demo')!;
  const t = validateTerms(o.terms);
  if (!t.ok) throw new Error(JSON.stringify(t.error));
  const spec: SearchSpec = {
    project: 'pay',
    env,
    selector: env.selector,
    terms: t.terms,
    ...(o.excludes ? { excludes: excludes(o.excludes, t.terms) } : {}),
    period: { fromMs: o.fromMs, toMs: o.toMs, preset: null },
    profile: builtinProfile(),
    limits: { ...DEFAULTS, ...o.limits },
    ...(o.parallel ? { parallel: o.parallel } : {}),
  };
  const warnings: string[] = [];
  const deps: EngineDeps = { backends, now: () => o.now ?? NOW, warn: (m) => warnings.push(m) };
  const job = new SearchJob('job-1', 'key', spec, deps);
  return { job, warnings, deps };
}

async function run(store: FakeStore, o: Parameters<typeof makeJob>[1]) {
  const { job } = makeJob(store, o);
  await job.start();
  return job;
}

// ---------- Синтетические строки ----------

let seq = 0;
const LEVEL_NAMES: Record<number, string> = { 200: 'info', 300: 'warning', 400: 'error' };

/** Запись встроенного формата json; cid = null — строка не JSON (текст как есть). */
function rec(ms: number, cid: string | null, msg: string, fields: Record<string, unknown> = {}, level = 200): LogLine {
  const line = cid === null ? msg : JSON.stringify({ time: new Date(ms).toISOString(), level: LEVEL_NAMES[level], msg, correlation_id: cid, ...fields });
  return {
    tsNs: (nsOf(ms) + BigInt(seq++ % 997)).toString(),
    line,
    labels: { namespace: 'pay', container: 'api' },
  };
}

/** Регулярное выражение correlation_id пакета второго прохода. */
const patternOf = (q: LinesQuery) => {
  const f = q.filters[0];
  return f?.kind === 'regex' ? f.pattern : '';
};

/** Запрос: входящая запись и запись с текстом. */
function request(cid: string, ms: number, text: string): LogLine[] {
  return [
    rec(ms, cid, 'incoming request', { request_id: cid, request: { method: 'GET', path: `/v1/items/${cid}`, body: '""' } }),
    rec(ms + 20, cid, `processed ${text}`),
  ];
}

const sortLines = (lines: LogLine[]) => lines.sort((a, b) => (BigInt(a.tsNs) < BigInt(b.tsNs) ? -1 : 1));

describe('куски первого прохода', () => {
  it('6 часов — 6 подсчётов по часу, один за другим, начиная с последнего часа', async () => {
    const store = new FakeStore();
    const job = await run(store, { terms: ['needle'], fromMs: NOW - 6 * H, toMs: NOW });
    expect(store.counts.map((q) => [q.range.fromMs, q.range.toMs])).toEqual(
      [1, 2, 3, 4, 5, 6].map((h) => [NOW - h * H, NOW - (h - 1) * H]),
    );
    expect(store.counts.every((q) => q.key.regexp === BUILTIN_COUNT_REGEXP)).toBe(true);
    expect(store.maxActive).toBe(1);
    expect(job.progress).toMatchObject({ chunksDone: 6, chunksTotal: 6 });
    expect(job.scannedFromMs).toBe(NOW - 6 * H);
  });

  it('2 часа 20 минут — куски 60, 60 и 20 минут', () => {
    const chunks = countChunks({ fromMs: NOW - 140 * M, toMs: NOW }, 60);
    expect(chunks.map((c) => (c.toMs - c.fromMs) / M)).toEqual([60, 60, 20]);
    expect(chunks[0]!.toMs).toBe(NOW);
    expect(chunks[2]!.fromMs).toBe(NOW - 140 * M);
  });

  it('период вокруг времени: ±5, ±15, ±30 минут — один кусок, ±60 — два', () => {
    for (const [minutes, chunks] of [[5, 1], [15, 1], [30, 1], [60, 2]] as const) {
      expect(countChunks({ fromMs: NOW - minutes * M, toMs: NOW + minutes * M }, 60), `±${minutes}`).toHaveLength(chunks);
    }
  });

  it('больше 200 запросов — остановка после куска, второго прохода нет', async () => {
    const store = new FakeStore();
    store.onCount = (_q, n) => Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`c${n}-${i}`, 1]));
    const job = await run(store, { terms: ['needle'], fromMs: NOW - 6 * H, toMs: NOW });
    expect(store.counts).toHaveLength(3);
    expect(store.queries).toHaveLength(0);
    expect(job.state()).toMatchObject({ status: 'done', tooMany: true, found: 240, scannedFromMs: NOW - 3 * H, requestsTotal: 0, error: null });
  });

  it('тайм-аут в пятом часе с конца — второй проход по найденному за первые четыре часа', async () => {
    const store = new FakeStore();
    for (let h = 0; h < 6; h++) store.lines.push(...request(`cid-${h}`, NOW - h * H - 30 * M, 'needle'));
    sortLines(store.lines);
    store.onCount = (_q, n) => {
      if (n === 4) throw new BackendError('timeout', { details: 'хранилище не ответило за 30 с' });
      return undefined;
    };
    const job = await run(store, { terms: ['needle'], fromMs: NOW - 6 * H, toMs: NOW });
    expect(store.counts).toHaveLength(5);
    const s = job.state();
    expect(s.error).toEqual({ code: 'timeout', details: 'хранилище не ответило за 30 с', stage: 'count' });
    expect(s.status).toBe('failed');
    expect(s.scannedFromMs).toBe(NOW - 4 * H);
    expect(s.requests.map((r) => r.correlationId).sort()).toEqual(['cid-0', 'cid-1', 'cid-2', 'cid-3']);
  });

  it('отказ по лимиту рядов — «слишком много», без ошибки и второго прохода', async () => {
    const store = new FakeStore();
    store.onCount = (_q, n) => {
      if (n === 1) throw new BackendError('limit', { details: 'maximum of series (500) reached for a single query' });
      return { a: 1 };
    };
    const job = await run(store, { terms: ['needle'], fromMs: NOW - 6 * H, toMs: NOW });
    expect(store.queries).toHaveLength(0);
    expect(job.state()).toMatchObject({ status: 'done', tooMany: true, found: null, error: null, scannedFromMs: NOW - H });
  });
});

describe('несколько часов сразу', () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  /** Подсчёт куска n отвечает через delays[n] мс; без задержки в списке — висит до отмены. */
  const timed = (store: FakeStore, delays: (number | undefined)[], answer: (n: number) => Record<string, number> = () => ({})) => {
    store.onCount = async (_q, n, signal) => {
      const d = delays[n];
      if (d === undefined) return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
      await wait(d);
      return answer(n);
    };
  };

  it('24 часа: 24 подсчёта, не больше трёх сразу, от свежих к старым, прогресс до конца', async () => {
    const store = new FakeStore();
    for (let h = 0; h < 24; h += 5) store.lines.push(...request(`cid-${h}`, NOW - h * H - 10 * M, 'needle'));
    sortLines(store.lines);
    const inner = store.onCount;
    store.onCount = async (q, n, signal) => {
      await wait(3);
      return inner?.(q, n, signal);
    };
    const job = await run(store, { terms: ['needle'], fromMs: NOW - 24 * H, toMs: NOW, parallel: 3 });
    expect(store.counts).toHaveLength(24);
    expect(store.counts.slice(0, 3).map((q) => q.range.toMs)).toEqual([NOW, NOW - H, NOW - 2 * H]);
    expect(store.maxActive).toBe(3);
    expect(job.state()).toMatchObject({ status: 'done', found: 5, scannedFromMs: NOW - 24 * H, progress: { chunksDone: 24, chunksTotal: 24 } });
    expect(job.state().requests.map((r) => r.correlationId).sort()).toEqual(['cid-0', 'cid-10', 'cid-15', 'cid-20', 'cid-5']);
  });

  it('предел 200 после второго часа: третий час ответил раньше, но не учтён; начатые куски прерваны', async () => {
    const store = new FakeStore();
    // 0 — 150 запросов через 20 мс, 1 — 60 через 10 мс, 2 — один сразу, дальше висят до отмены.
    timed(store, [20, 10, 0], (n) => Object.fromEntries(Array.from({ length: [150, 60, 1][n]! }, (_, i) => [`c${n}-${i}`, 1])));
    const job = await run(store, { terms: ['needle'], fromMs: NOW - 6 * H, toMs: NOW, parallel: 3 });
    expect(job.state()).toMatchObject({ status: 'done', tooMany: true, found: 210, scannedFromMs: NOW - 2 * H, progress: { chunksDone: 2 } });
    expect(store.queries).toHaveLength(0);
    expect(store.signals.slice(3).length).toBeGreaterThan(0);
    expect(store.signals.slice(3).every((s) => s.aborted)).toBe(true);
  });

  it('тайм-аут второго часа: второй проход по первому часу, посчитанный третий час не учтён', async () => {
    const store = new FakeStore();
    for (let h = 0; h < 3; h++) store.lines.push(...request(`cid-${h}`, NOW - h * H - 30 * M, 'needle'));
    sortLines(store.lines);
    const inner = store.onCount;
    const counted: AbortSignal[] = [];
    store.onCount = async (q, n, signal) => {
      counted[n] = signal;
      if (n === 1) {
        await wait(10);
        throw new BackendError('timeout', { details: 'хранилище не ответило за 30 с' });
      }
      if (n > 2) return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
      if (n === 0) await wait(5);
      return inner?.(q, n, signal);
    };
    const job = await run(store, { terms: ['needle'], fromMs: NOW - 6 * H, toMs: NOW, parallel: 3 });
    const s = job.state();
    expect(s).toMatchObject({ status: 'failed', scannedFromMs: NOW - H, found: 1, error: { code: 'timeout', stage: 'count' } });
    expect(s.requests.map((r) => r.correlationId)).toEqual(['cid-0']);
    expect(counted.length).toBeGreaterThan(3);
    expect(counted.slice(3).every((x) => x.aborted)).toBe(true);
  });

  it('лимит рядов во втором часе: «слишком много», остальные подсчёты прерваны', async () => {
    const store = new FakeStore();
    store.onCount = async (_q, n, signal) => {
      if (n === 1) throw new BackendError('limit', { details: 'maximum of series (500) reached for a single query' });
      if (n === 0) {
        await wait(5);
        return { a: 1 };
      }
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
    };
    const job = await run(store, { terms: ['needle'], fromMs: NOW - 6 * H, toMs: NOW, parallel: 3 });
    expect(job.state()).toMatchObject({ status: 'done', tooMany: true, found: null, error: null, scannedFromMs: NOW - H });
    expect(store.queries).toHaveLength(0);
    expect(store.signals.slice(2).every((x) => x.aborted)).toBe(true);
  });

  it('остановка прерывает все три идущих подсчёта', async () => {
    const store = new FakeStore();
    timed(store, []);
    const { job } = makeJob(store, { terms: ['needle'], fromMs: NOW - 6 * H, toMs: NOW, parallel: 3 });
    const done = job.start();
    while (store.counts.length < 3) await wait(1);
    job.cancel();
    await done;
    expect(store.counts).toHaveLength(3);
    expect(store.signals.every((x) => x.aborted)).toBe(true);
    expect(job.state()).toMatchObject({ status: 'cancelled', scannedFromMs: null });
  });

  it('пусто за 24 часа: все 24 подсчёта, запросов нет', async () => {
    const store = new FakeStore();
    const job = await run(store, { terms: ['needle'], fromMs: NOW - 24 * H, toMs: NOW, parallel: 3 });
    expect(store.counts).toHaveLength(24);
    expect(job.state()).toMatchObject({ status: 'done', found: 0, lines: 'none', progress: { chunksDone: 24 } });
  });
});

describe('отказ хранилища по другим лимитам в первом проходе', () => {
  it('лимит байт — ошибка куска, а не «слишком много»: второй проход по найденному, текст Loki в details', async () => {
    const store = new FakeStore();
    for (let h = 0; h < 6; h++) store.lines.push(...request(`cid-${h}`, NOW - h * H - 30 * M, 'needle'));
    sortLines(store.lines);
    const details = 'the query would read too many bytes (query: 12 GB, limit: 10 GB)';
    store.onCount = (_q, n) => {
      if (n === 2) throw new BackendError('limit', { details });
      return undefined;
    };
    const job = await run(store, { terms: ['needle'], fromMs: NOW - 6 * H, toMs: NOW });
    const s = job.state();
    expect(s).toMatchObject({ status: 'failed', tooMany: false, found: 2, scannedFromMs: NOW - 2 * H });
    expect(s.error).toEqual({ code: 'limit', stage: 'count', details });
    expect(s.requests.map((r) => r.correlationId).sort()).toEqual(['cid-0', 'cid-1']);
  });
});

describe('исключённые значения', () => {
  const CID_A = '11111111-1111-4111-8111-111111111111';
  const CID_B = '22222222-2222-4222-8222-222222222222';
  const NOT = { kind: 'not-contains', value: 'абсолютно-лишнее' };
  const period = { fromMs: NOW - H, toMs: NOW };
  const lines = () => sortLines([rec(NOW - 10 * M, CID_A, 'искомое абсолютно-лишнее'), rec(NOW - 9 * M, CID_A, 'искомое и больше ничего'), rec(NOW - 8 * M, CID_B, 'искомое абсолютно-лишнее')]);

  it('подсчёт и записи запросов идут без условия, «Все записи» с условием', async () => {
    const store = new FakeStore();
    store.lines = lines();
    const { job, deps } = makeJob(store, { terms: ['искомое'], excludes: ['абсолютно-лишнее'], ...period });
    await job.start();
    expect(store.counts.length).toBeGreaterThan(0);
    for (const c of store.counts) expect(c.filters).not.toContainEqual(NOT);
    const reads = store.queries.filter((q) => q.filters[0]?.kind === 'regex');
    expect(reads.length).toBeGreaterThan(0);
    for (const q of reads) expect(q.filters).not.toContainEqual(NOT);
    const page = await readLinesPage(deps, job.spec, null, new AbortController().signal);
    expect(store.queries.at(-1)!.filters).toContainEqual(NOT);
    expect(page.records.map((r) => r.raw).join()).not.toContain('абсолютно-лишнее');
  });

  it('запрос с исключённым значением в любой записи убран из списка, другой остался целиком', async () => {
    const store = new FakeStore();
    store.lines = sortLines([rec(NOW - 10 * M, CID_A, 'искомое абсолютно-лишнее'), rec(NOW - 9 * M, CID_A, 'искомое и больше ничего'), rec(NOW - 8 * M, CID_B, 'искомое и больше ничего'), rec(NOW - 7 * M, CID_B, 'тоже ничего')]);
    const job = await run(store, { terms: ['искомое'], excludes: ['абсолютно-лишнее'], ...period });
    expect(job.requests.map((r) => r.correlationId)).toEqual([CID_B]);
    expect(job.requests[0]!.recordCount).toBe(2);
    expect(job.state().requestsTotal).toBe(1);
    expect(job.state().excluding).toEqual({ removed: true });
    // К запросу ведёт «К запросу» из «Всех записей»: открывается целиком.
    expect(job.request(CID_A)!.records.map((r) => r.line).join()).toContain('абсолютно-лишнее');
  });

  it('все запросы убраны: список пуст, строки есть, состояние говорит почему', async () => {
    const store = new FakeStore();
    store.lines = lines().slice(0, 2);
    const job = await run(store, { terms: ['искомое'], excludes: ['абсолютно-лишнее'], ...period });
    expect(job.requests).toEqual([]);
    expect(job.lines).toBe('some');
    expect(job.state().excluding).toEqual({ removed: true });
  });

  it('запрос на 8 минут через границу часа: окно то же, что без условия, запроса с исключённым значением нет в списке', async () => {
    const wide = { fromMs: NOW - 3 * H, toMs: NOW };
    const all = sortLines([rec(NOW - 66 * M, CID_A, 'искомое абсолютно-лишнее'), rec(NOW - 58 * M, CID_A, 'искомое')]);
    const store = new FakeStore();
    store.lines = [...all];
    const job = await run(store, { terms: ['искомое'], excludes: ['абсолютно-лишнее'], ...wide });
    expect(job.requests).toEqual([]);
    expect(job.state().excluding).toEqual({ removed: true });
    expect(job.request(CID_A)!.records).toHaveLength(2);
    const plain = new FakeStore();
    plain.lines = [...all];
    await run(plain, { terms: ['искомое'], ...wide });
    expect(store.counts).toEqual(plain.counts);
    const reads = (s: FakeStore) => s.queries.filter((q) => q.filters[0]?.kind === 'regex');
    expect(reads(store)).toEqual(reads(plain));
  });

  it('«Слишком много запросов» то же, что без условия: исключённые запросы считаются', async () => {
    const make = () => sortLines([rec(NOW - 10 * M, CID_A, 'искомое абсолютно-лишнее'), rec(NOW - 8 * M, CID_B, 'искомое')]);
    const search = async (extra: { excludes?: string[] }) => {
      const store = new FakeStore();
      store.lines = make();
      return run(store, { terms: ['искомое'], ...extra, ...period, limits: { maxRequests: 1 } });
    };
    const [plain, excluded] = [await search({}), await search({ excludes: ['абсолютно-лишнее'] })];
    expect(plain.tooMany).toBe(true);
    expect(excluded.tooMany).toBe(true);
    expect(excluded.found).toBe(plain.found);
  });

  it('значение на записи вне окна чтения не видно: запрос остаётся в списке', async () => {
    const store = new FakeStore();
    store.lines = sortLines([rec(NOW - 70 * M, CID_A, 'строка абсолютно-лишнее'), rec(NOW - 50 * M, CID_A, 'искомое')]);
    const job = await run(store, { terms: ['искомое'], excludes: ['абсолютно-лишнее'], fromMs: NOW - 3 * H, toMs: NOW });
    expect(job.requests.map((r) => r.correlationId)).toEqual([CID_A]);
    expect(job.state().excluding).toEqual({ removed: false });
  });

  it('значения нет ни в одном запросе: список и записи те же, что без условия', async () => {
    const store = new FakeStore();
    store.lines = sortLines([rec(NOW - 9 * M, CID_A, 'искомое и больше ничего'), rec(NOW - 8 * M, CID_A, 'другая строка')]);
    const job = await run(store, { terms: ['искомое'], excludes: ['абсолютно-лишнее'], ...period });
    expect(job.requests[0]).toMatchObject({ correlationId: CID_A, recordCount: 2, incomplete: false });
    expect(job.state().excluding).toEqual({ removed: false });
  });

  it('номер карты в условии: запрос убирается и по другой карте с теми же краями, и по маске, как у `!=`', async () => {
    const store = new FakeStore();
    const edges = `${EXACT.slice(0, 6)}${'*'.repeat(EXACT.length - 10)}${EXACT.slice(-4)}`;
    store.lines = sortLines([rec(NOW - 10 * M, CID_A, 'искомое'), rec(NOW - 9 * M, CID_A, `карта ${edges}`), rec(NOW - 8 * M, CID_B, 'искомое')]);
    const job = await run(store, { terms: ['искомое'], excludes: [EXACT], ...period });
    expect(job.requests.map((r) => r.correlationId)).toEqual([CID_B]);
  });

  it('предел строк: запрос не проверен до конца, остаётся с меткой «записи неполные», состояние говорит о пределе', async () => {
    const store = new FakeStore();
    store.lines = sortLines([rec(NOW - 10 * M, CID_A, 'искомое'), rec(NOW - 9 * M, CID_A, 'строка'), rec(NOW - 8 * M, CID_A, 'строка абсолютно-лишнее')]);
    const job = await run(store, { terms: ['искомое'], excludes: ['абсолютно-лишнее'], ...period, limits: { maxLinesPerQuery: 2, maxLinesPerSearch: 2 } });
    expect(job.truncated).toBe(true);
    expect(job.requests[0]).toMatchObject({ correlationId: CID_A, incomplete: true });
    expect(job.state().excluding).toEqual({ removed: false });
  });

  it('число кусков то же, что без исключения', async () => {
    const store = new FakeStore();
    store.lines = lines();
    await run(store, { terms: ['искомое'], excludes: ['абсолютно-лишнее'], ...period });
    const plain = new FakeStore();
    plain.lines = lines();
    await run(plain, { terms: ['искомое'], ...period });
    expect(store.counts).toHaveLength(plain.counts.length);
  });

  it('без исключения фильтры прежние, поля в состоянии нет', async () => {
    const store = new FakeStore();
    store.lines = lines();
    const job = await run(store, { terms: ['искомое'], ...period });
    expect(store.counts[0]!.filters).toEqual([{ kind: 'contains', value: 'искомое' }]);
    expect(store.queries[0]!.filters).toHaveLength(1);
    expect('excludes' in job.state()).toBe(false);
  });

  it('все строки исключены: запросов нет, поиск завершён чисто', async () => {
    const store = new FakeStore();
    store.lines = [rec(NOW - 8 * M, CID_B, 'искомое абсолютно-лишнее')];
    const job = await run(store, { terms: ['искомое'], excludes: ['абсолютно-лишнее'], ...period });
    expect(job.status).toBe('done');
    expect(job.requests).toEqual([]);
    expect(job.state().excludes).toEqual([{ display: 'абсолютно-лишнее', kind: 'text' }]);
    // Строк без значения нет: сообщение обычное, а не про «Не содержит».
    expect(job.lines).toBe('none');
  });

  it('запрос открыт из поиска с условием: статус и записи те же, что без условия', async () => {
    const exchange = (cid: string, ms: number) => [
      rec(ms, cid, 'http request sending', { request_id: cid, upstream: { method: 'POST', url: 'https://switch.pay.example/v3', body: 'искомое' } }),
      rec(ms + 10, cid, 'http response', { request_id: cid, upstream: { method: 'POST', url: 'https://switch.pay.example/v3', status: 500, body: 'ответ' } }),
    ];
    const read = async (excludes?: string[]) => {
      const store = new FakeStore();
      store.lines = sortLines(exchange(CID_A, NOW - 30 * M));
      return run(store, { terms: ['искомое'], ...(excludes ? { excludes } : {}), ...period });
    };
    const [plain, excluded] = [await read(), await read(['абсолютно-лишнее'])];
    expect(excluded.requests).toEqual(plain.requests);
    expect(excluded.requests[0]).toMatchObject({ status: 'error', incomplete: false, recordCount: 2 });
    expect(excluded.request(CID_A)!.records).toHaveLength(2);
    expect(excluded.request(CID_A)!.incomplete).toBe(false);
  });

  it('номер карты в хранилище только шаблоном', async () => {
    const store = new FakeStore();
    store.lines = [rec(NOW - 8 * M, CID_B, 'искомое')];
    const { job, deps } = makeJob(store, { terms: ['искомое'], excludes: [EXACT], ...period });
    await job.start();
    await readLinesPage(deps, job.spec, null, new AbortController().signal);
    const text = JSON.stringify([store.counts, store.queries]);
    expect(text).not.toContain(EXACT);
    expect(store.queries.at(-1)!.filters[1]).toMatchObject({ kind: 'not-regex' });
  });
});

describe('второй проход', () => {
  it('120 запросов — пакеты не больше 50 соседних по времени, окно каждого — свои куски ±5 минут', async () => {
    const store = new FakeStore();
    for (let h = 0; h < 6; h++) {
      for (let i = 0; i < 20; i++) store.lines.push(...request(`r${h}-${i}`, NOW - h * H - 10 * M - i * M, 'needle'));
    }
    sortLines(store.lines);
    const job = await run(store, { terms: ['needle'], fromMs: NOW - 6 * H, toMs: NOW });
    expect(job.state()).toMatchObject({ status: 'done', found: 120, requestsTotal: 120 });
    // Первый запрос каждого пакета — без границы продолжения в нс; дальше идут продолжения того же пакета.
    const firsts = store.queries.filter((q) => q.range.fromNs === undefined);
    expect(firsts.length).toBeGreaterThanOrEqual(3);
    const batches = firsts.map((q) => {
      const f = q.filters[0]!;
      if (f.kind !== 'regex') throw new Error('нужен regex');
      return { cids: f.pattern.split('|'), q };
    });
    for (const b of batches) {
      expect(b.cids.length).toBeLessThanOrEqual(50);
      expect(b.q.direction).toBe('forward');
      expect(b.q.limit).toBe(5000);
      const hours = new Set(b.cids.map((c) => Number(/^r(\d)-/.exec(c)![1])));
      const min = Math.min(...hours);
      const max = Math.max(...hours);
      // Соседние по времени: часы пакета подряд, окно — от начала самого раннего до конца самого позднего ±5 мин.
      expect(hours.size).toBe(max - min + 1);
      expect(b.q.range.fromMs).toBe(NOW - (max + 1) * H - 5 * M);
      expect(b.q.range.toMs).toBe(Math.min(NOW - min * H + 5 * M, NOW));
    }
    expect(batches[0]!.cids.some((c) => c.startsWith('r0-'))).toBe(true);
    expect(job.progress).toMatchObject({ batchesDone: batches.length, batchesTotal: batches.length });
  });

  it('поиск за 24 часа, 3 запроса в одном часе — один запрос строк за окно около 1 ч 10 мин', async () => {
    const store = new FakeStore();
    for (const i of [0, 1, 2]) store.lines.push(...request(`one-${i}`, NOW - 10 * H - 30 * M + i * M, 'needle'));
    sortLines(store.lines);
    const job = await run(store, { terms: ['needle'], fromMs: NOW - 24 * H, toMs: NOW });
    expect(store.counts).toHaveLength(24);
    // Один пакет: все запросы строк с одним фильтром, первый — за всё окно пакета.
    expect(store.queries.filter((q) => q.range.fromNs === undefined)).toHaveLength(1);
    expect(new Set(store.queries.map((q) => JSON.stringify(q.filters))).size).toBe(1);
    const r = store.queries[0]!.range;
    expect([r.fromMs, r.toMs]).toEqual([NOW - 11 * H - 5 * M, NOW - 10 * H + 5 * M]);
    expect(job.state().requestsTotal).toBe(3);
  });

  it('окно пакета обрезается текущим моментом и периодом ±5 минут', () => {
    const chunks = countChunks({ fromMs: NOW - 2 * H, toMs: NOW }, 60);
    const found = new Map([
      ['a', [0]],
      ['b', [1]],
    ]);
    const [batch] = planBatches(found, chunks, { fromMs: NOW - 2 * H, toMs: NOW }, { batchSize: 50, periodMarginMinutes: 5 }, NOW);
    expect(batch).toEqual({ cids: ['a', 'b'], fromMs: NOW - 2 * H - 5 * M, toMs: NOW });
  });

  it('запись чужого запроса с этим correlation_id в теле не попадает в запрос', async () => {
    const store = new FakeStore();
    store.lines.push(...request('aaa-1', NOW - 20 * M, 'needle'));
    const foreign = rec(NOW - 19 * M, 'bbb-2', 'callback', { ctx: { body: '{"parent":"aaa-1"}' } });
    store.lines.push(foreign);
    sortLines(store.lines);
    const job = await run(store, { terms: ['needle'], fromMs: NOW - H, toMs: NOW });
    const f = store.queries[0]!.filters[0]!;
    expect(f.kind === 'regex' && new RegExp(f.pattern).test(foreign.line)).toBe(true);
    expect(job.state().requests.map((r) => r.correlationId)).toEqual(['aaa-1']);
    expect(job.request('aaa-1')!.records.every((r) => r.correlationId === 'aaa-1')).toBe(true);
    expect(job.request('aaa-1')!.summary.recordCount).toBe(2);
    expect(job.request('bbb-2')).toBeUndefined();
  });

  it('запрос, начатый за 2 минуты до начала периода, получает и записи до начала', async () => {
    const store = new FakeStore();
    const start = NOW - H;
    store.lines.push(
      rec(start - 2 * M, 'edge-1', 'incoming request', { request_id: 'edge-1', request: { method: 'POST', path: '/v1/pay', body: '{}' } }),
      rec(start + M, 'edge-1', 'needle found'),
    );
    const job = await run(store, { terms: ['needle'], fromMs: start, toMs: NOW });
    const stored = job.request('edge-1')!;
    expect(stored.records).toHaveLength(2);
    expect(stored.summary.firstMs).toBe(start - 2 * M);
    expect(stored.summary.incoming).toEqual({ method: 'POST', path: '/v1/pay' });
  });

  it('предел строк — собранное с пометкой, запросы пакета «записи неполные», остальные пакеты не читаются', async () => {
    const store = new FakeStore();
    const t = NOW - 20 * M;
    const uri = 'http://fraud.pay.example:9090/';
    store.lines.push(
      rec(t, 'big', 'incoming request', { request_id: 'big', request: { method: 'GET', path: '/v1/big', body: '""' } }),
      rec(t + 1, 'big', 'http request sending', { request_id: 'r1', upstream: { method: 'POST', url: uri, body: '{"needle":1}' } }),
    );
    for (let i = 0; i < 200; i++) store.lines.push(rec(t + 10 + i, 'big', `step ${i}`));
    store.lines.push(rec(t + 400, 'big', 'http response received', { request_id: 'r1', upstream: { method: 'POST', url: uri, status: 200, body: '{}' } }));
    store.lines.push(...request('old', NOW - 5 * H, 'needle'));
    sortLines(store.lines);
    const { job, warnings } = makeJob(store, {
      terms: ['needle'],
      fromMs: NOW - 6 * H,
      toMs: NOW,
      limits: { maxLinesPerQuery: 100, maxLinesPerSearch: 150, batchSize: 1 },
    });
    await job.start();
    expect(warnings).toEqual([]);
    expect(store.queries.map((q) => q.limit)).toEqual([100, 100]);
    const s = job.state();
    expect(s).toMatchObject({ status: 'done', truncated: true, found: 2, requestsTotal: 1, progress: { batchesDone: 1, batchesTotal: 2 } });
    const big = s.requests[0]!;
    expect(big).toMatchObject({ correlationId: 'big', incomplete: true, status: 'success', recordCount: 150 });
    expect(big.reasons.map((r) => r.kind)).toEqual(['pending']);
    const stored = job.request('big')!;
    expect(stored.incomplete).toBe(true);
    expect(stored.readEndMs).toBe(tsNsToMs(stored.records[149]!.tsNs));
  });
});

describe('предел строк: недочитанный пакет', () => {
  it('запрос пакета без прочитанных строк не пропадает, а помечен «записи неполные»', async () => {
    const store = new FakeStore();
    const t = NOW - 20 * M;
    store.lines.push(rec(t, 'big', 'incoming request', { request_id: 'big', request: { method: 'GET', path: '/v1/big', body: '""' } }));
    for (let i = 0; i < 299; i++) store.lines.push(rec(t + 1 + i, 'big', `step needle ${i}`));
    store.lines.push(...request('late', t + 2000, 'needle'));
    sortLines(store.lines);
    const job = await run(store, {
      terms: ['needle'],
      fromMs: NOW - H,
      toMs: NOW,
      limits: { maxLinesPerQuery: 100, maxLinesPerSearch: 200, batchSize: 2 },
    });
    const s = job.state();
    expect(s).toMatchObject({ status: 'done', truncated: true, found: 2, requestsTotal: 2 });
    expect(s.requests.every((r) => r.incomplete)).toBe(true);
    const late = job.request('late')!;
    expect(late.records).toEqual([]);
    expect(late.summary).toMatchObject({ correlationId: 'late', recordCount: 0, incomplete: true });
    expect(late.summary.firstMs).toBe(late.readEndMs);
    expect(late.readEndMs).toBe(tsNsToMs(job.request('big')!.records.at(-1)!.tsNs));
  });

  it('предел исчерпан ровно на границе пакета — следующий пакет не читается', async () => {
    const store = new FakeStore();
    store.lines.push(rec(NOW - 20 * M, 'aaa', 'incoming request', { request_id: 'aaa', request: { method: 'GET', path: '/a', body: '""' } }));
    for (let i = 0; i < 9; i++) store.lines.push(rec(NOW - 20 * M + 1 + i, 'aaa', `needle ${i}`));
    store.lines.push(...request('bbb', NOW - 2 * H - 20 * M, 'needle'));
    sortLines(store.lines);
    const job = await run(store, {
      terms: ['needle'],
      fromMs: NOW - 3 * H,
      toMs: NOW,
      limits: { maxLinesPerQuery: 100, maxLinesPerSearch: 10, batchSize: 1 },
    });
    expect(store.queries.every((q) => patternOf(q) === 'aaa')).toBe(true);
    expect(job.state()).toMatchObject({ truncated: true, found: 2, progress: { batchesDone: 1, batchesTotal: 2 } });
    expect(job.state().requests.map((r) => r.correlationId)).toEqual(['aaa']);
  });
});

describe('совпадение номера карты', () => {
  function cards(store: FakeStore) {
    const body = (pan: string) => ({ request_id: 'x', upstream: { method: 'POST', url: 'https://processor.pay.example/', status: 200, body: `<RCARD>${pan}</RCARD>` } });
    store.lines.push(
      ...request('r-exact', NOW - 50 * M, 'card'),
      rec(NOW - 50 * M + 30, 'r-exact', 'http response received', body(EXACT)),
      ...request('r-twin', NOW - 40 * M, 'card'),
      rec(NOW - 40 * M + 30, 'r-twin', 'http response received', body(TWIN)),
      ...request('r-masked', NOW - 30 * M, 'card'),
      rec(NOW - 30 * M + 30, 'r-masked', 'payment', { ctx: { sender: { pan: MASKED } } }),
      ...request('r-both', NOW - 20 * M, 'card'),
      rec(NOW - 20 * M + 30, 'r-both', 'http response received', body(TWIN)),
      rec(NOW - 20 * M + 40, 'r-both', 'payment', { ctx: { sender: { pan: MASKED } } }),
    );
    sortLines(store.lines);
  }

  it('полный номер — точно, только маска — неточно, другая карта с теми же краями отброшена', async () => {
    const store = new FakeStore();
    cards(store);
    const job = await run(store, { terms: [EXACT], fromMs: NOW - H, toMs: NOW });
    const s = job.state();
    expect(s.found).toBe(4);
    const byCid = Object.fromEntries(s.requests.map((r) => [r.correlationId, r.match]));
    expect(byCid).toEqual({ 'r-exact': 'exact', 'r-masked': 'inexact', 'r-both': 'inexact' });
    expect(s.terms).toEqual([{ kind: 'pan', display: MASKED }]);
    // Полный номер не уходит в хранилище.
    expect(JSON.stringify([store.counts, store.queries])).not.toContain(EXACT);
  });

  it('поиск по маске — всё неточно', async () => {
    const store = new FakeStore();
    cards(store);
    const job = await run(store, { terms: [MASKED], fromMs: NOW - H, toMs: NOW });
    const s = job.state();
    expect(s.requests).toHaveLength(4);
    expect(s.requests.every((r) => r.match === 'inexact')).toBe(true);
  });

  it('строка с полным номером за пределом строк — запрос не отброшен: неточно и «записи неполные»', async () => {
    const lines = () => {
      const t = NOW - 20 * M;
      const out = [rec(t, 'X', 'incoming request', { request_id: 'X', request: { method: 'POST', path: '/v1/card', body: '{}' } })];
      for (let i = 0; i < 20; i++) out.push(rec(t + 1 + i, 'X', `step ${i}`));
      out.push(rec(t + 100, 'X', 'http response received', { request_id: 'x', upstream: { method: 'POST', url: 'https://processor.pay.example/', status: 200, body: `<RCARD>${EXACT}</RCARD>` } }));
      return sortLines(out);
    };
    const store = new FakeStore();
    store.lines = lines();
    const job = await run(store, { terms: [EXACT], fromMs: NOW - H, toMs: NOW, limits: { maxLinesPerQuery: 5, maxLinesPerSearch: 10 } });
    const s = job.state();
    expect(s).toMatchObject({ truncated: true, found: 1, requestsTotal: 1 });
    expect(s.requests[0]).toMatchObject({ correlationId: 'X', match: 'inexact', incomplete: true });
    const full = new FakeStore();
    full.lines = lines();
    const all = await run(full, { terms: [EXACT], fromMs: NOW - H, toMs: NOW });
    expect(all.state().requests[0]).toMatchObject({ correlationId: 'X', match: 'exact', incomplete: false });
  });

  it('все найденные запросы отсеяны вторым проходом — проверяются строки без запросов', async () => {
    const store = new FakeStore();
    store.lines.push(
      ...request('r-twin', NOW - 40 * M, 'card'),
      rec(NOW - 40 * M + 30, 'r-twin', 'http response received', { request_id: 'x', upstream: { method: 'POST', url: 'https://processor.pay.example/', status: 200, body: `<RCARD>${TWIN}</RCARD>` } }),
      rec(NOW - 10 * M, null, `[GIN] 2026/11/02 - 16:49:15 | 200 | GET "/v1/check?pan=${EXACT}"`),
    );
    sortLines(store.lines);
    const job = await run(store, { terms: [EXACT], fromMs: NOW - H, toMs: NOW });
    expect(job.state()).toMatchObject({ status: 'done', found: 1, requestsTotal: 0, lines: 'some', error: null });
    expect(job.firstLinesPage!.records).toHaveLength(1);
    expect(job.firstLinesPage!.records[0]!.match).toBe('exact');
  });

  it('ключи null, true и false первого прохода не становятся запросами и не входят в пакет', async () => {
    const store = new FakeStore();
    store.lines.push(...request('r-real', NOW - 30 * M, `card ${EXACT}`));
    sortLines(store.lines);
    store.onCount = (q) => {
      const out: Record<string, number> = { null: 40, TRUE: 2, false: 1 };
      for (const l of filtered(store.lines, q.filters, q.range)) out['r-real'] = (out['r-real'] ?? 0) + (parseLine(l).correlationId ? 1 : 0);
      return out;
    };
    const job = await run(store, { terms: [EXACT], fromMs: NOW - H, toMs: NOW });
    expect(job.state()).toMatchObject({ status: 'done', found: 1, requestsTotal: 1 });
    expect(job.state().requests.map((r) => r.correlationId)).toEqual(['r-real']);
    expect(new Set(store.queries.map(patternOf))).toEqual(new Set(['r-real']));
  });

  it('16 цифр без проверки Луна ищутся так же, как номер карты', async () => {
    const store = new FakeStore();
    const number = '5555550000473342';
    const other = '5555559999983342';
    store.lines.push(
      ...request('n-1', NOW - 30 * M, 'acc'),
      rec(NOW - 30 * M + 30, 'n-1', 'account', { ctx: { primaryAccountNumber: number } }),
      ...request('n-2', NOW - 20 * M, 'acc'),
      rec(NOW - 20 * M + 30, 'n-2', 'account', { ctx: { primaryAccountNumber: other } }),
    );
    sortLines(store.lines);
    const job = await run(store, { terms: [number], fromMs: NOW - H, toMs: NOW });
    expect(job.state().requests.map((r) => [r.correlationId, r.match])).toEqual([['n-1', 'exact']]);
    expect(JSON.stringify(store.counts)).not.toContain(number);
  });
});

describe('ошибки, остановка, пустой результат', () => {
  it('ошибка второго пакета — запросы первого остаются, поиск завершён с ошибкой', async () => {
    const store = new FakeStore();
    for (let h = 0; h < 4; h++) store.lines.push(...request(`b${h}`, NOW - h * H - 30 * M, 'needle'));
    sortLines(store.lines);
    store.onLines = (q) => {
      if (patternOf(q).includes('b2')) throw new BackendError('timeout', { details: 'хранилище не ответило за 30 с' });
      return undefined;
    };
    const job = await run(store, { terms: ['needle'], fromMs: NOW - 4 * H, toMs: NOW, limits: { batchSize: 2 } });
    const s = job.state();
    expect(s.status).toBe('failed');
    expect(s.error).toMatchObject({ code: 'timeout', stage: 'fetch' });
    expect(s.progress).toMatchObject({ batchesDone: 1, batchesTotal: 2 });
    expect(s.requests.map((r) => r.correlationId).sort()).toEqual(['b0', 'b1']);
    expect(store.queries.filter((q) => patternOf(q).includes('b2'))).toHaveLength(1);
  });

  it('Threadline занят в первом проходе — поиск завершён с ошибкой busy, второй проход по найденному до неё', async () => {
    const store = new FakeStore();
    for (let h = 0; h < 6; h++) store.lines.push(...request(`cid-${h}`, NOW - h * H - 30 * M, 'needle'));
    sortLines(store.lines);
    store.onCount = (_q, n) => {
      if (n === 2) throw new BackendError('busy', { details: 'ожидание в очереди дольше 10 с' });
      return undefined;
    };
    const job = await run(store, { terms: ['needle'], fromMs: NOW - 6 * H, toMs: NOW });
    const s = job.state();
    expect(s).toMatchObject({ status: 'failed', error: { code: 'busy', stage: 'count', details: 'ожидание в очереди дольше 10 с' } });
    expect(s.scannedFromMs).toBe(NOW - 2 * H);
    expect(s.requests.map((r) => r.correlationId).sort()).toEqual(['cid-0', 'cid-1']);
  });

  it('Threadline занят во втором проходе — запросы первого пакета остаются, ошибка busy', async () => {
    const store = new FakeStore();
    for (let h = 0; h < 4; h++) store.lines.push(...request(`b${h}`, NOW - h * H - 30 * M, 'needle'));
    sortLines(store.lines);
    store.onLines = (q) => {
      if (patternOf(q).includes('b2')) throw new BackendError('busy', { details: 'ожидание в очереди дольше 10 с' });
      return undefined;
    };
    const job = await run(store, { terms: ['needle'], fromMs: NOW - 4 * H, toMs: NOW, limits: { batchSize: 2 } });
    const s = job.state();
    expect(s).toMatchObject({ status: 'failed', error: { code: 'busy', stage: 'fetch' }, progress: { batchesDone: 1, batchesTotal: 2 } });
    expect(s.requests.map((r) => r.correlationId).sort()).toEqual(['b0', 'b1']);
  });

  it('ошибка пакета после ошибки первого прохода — на экране остаётся граница просмотренного периода', async () => {
    const store = new FakeStore();
    for (let h = 0; h < 6; h++) store.lines.push(...request(`cid-${h}`, NOW - h * H - 30 * M, 'needle'));
    sortLines(store.lines);
    store.onCount = (_q, n) => {
      if (n === 4) throw new BackendError('timeout', { details: 'хранилище не ответило за 30 с' });
      return undefined;
    };
    store.onLines = (q) => {
      if (patternOf(q).includes('cid-2')) throw new BackendError('overloaded', { details: 'busy' });
      return undefined;
    };
    const job = await run(store, { terms: ['needle'], fromMs: NOW - 6 * H, toMs: NOW, limits: { batchSize: 2 } });
    const s = job.state();
    expect(s.status).toBe('failed');
    expect(s.error).toMatchObject({ code: 'timeout', stage: 'count' });
    expect(s.scannedFromMs).toBe(NOW - 4 * H);
    expect(s.requests.map((r) => r.correlationId).sort()).toEqual(['cid-0', 'cid-1']);
    expect(s.progress).toMatchObject({ batchesDone: 1, batchesTotal: 2 });
  });

  it('остановка прерывает запрос к хранилищу, найденное остаётся', async () => {
    const store = new FakeStore();
    store.lines.push(...request('first', NOW - 30 * M, 'needle'), ...request('second', NOW - 90 * M, 'needle'));
    sortLines(store.lines);
    let release: (() => void) | undefined;
    const hung = new Promise<void>((r) => (release = r));
    store.onLines = async (q, _n, signal) => {
      if (patternOf(q).includes('first')) return undefined;
      release!();
      return new Promise<LogLine[]>((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
    };
    const { job } = makeJob(store, { terms: ['needle'], fromMs: NOW - 2 * H, toMs: NOW, limits: { batchSize: 1 } });
    const done = job.start();
    await hung;
    expect(job.state().requests.map((r) => r.correlationId)).toEqual(['first']);
    job.cancel();
    await done;
    expect(store.signals.at(-1)!.aborted).toBe(true);
    expect(job.state()).toMatchObject({ status: 'cancelled', requestsTotal: 1 });
  });

  it('остановка во время первого прохода', async () => {
    const store = new FakeStore();
    let started: (() => void) | undefined;
    const waiting = new Promise<void>((r) => (started = r));
    store.onCount = (_q, _n, signal) =>
      new Promise((_, reject) => {
        started!();
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const { job } = makeJob(store, { terms: ['needle'], fromMs: NOW - 6 * H, toMs: NOW });
    const done = job.start();
    await waiting;
    job.cancel();
    await done;
    expect(store.signals[0]!.aborted).toBe(true);
    expect(store.counts).toHaveLength(1);
    expect(job.state()).toMatchObject({ status: 'cancelled', scannedFromMs: null });
  });

  it('пусто — ничего нет', async () => {
    const store = new FakeStore();
    const job = await run(store, { terms: ['needle'], fromMs: NOW - 6 * H, toMs: NOW });
    expect(store.queries).toEqual([
      expect.objectContaining({ direction: 'backward', limit: 100, range: { fromMs: NOW - 6 * H, toMs: NOW } }),
    ]);
    expect(job.state()).toMatchObject({ status: 'done', found: 0, lines: 'none', requestsTotal: 0 });
  });

  it('пусто, но есть строки без correlation_id — lines = some, первая страница сохранена', async () => {
    const store = new FakeStore();
    store.lines.push(rec(NOW - 10 * M, null, '[GIN] 2026/11/02 - 16:49:15 | 200 | GET "/v1/needle"'));
    const job = await run(store, { terms: ['needle'], fromMs: NOW - H, toMs: NOW });
    expect(job.state()).toMatchObject({ status: 'done', found: 0, lines: 'some' });
    expect(job.firstLinesPage!.records).toHaveLength(1);
    expect(job.firstLinesPage!.records[0]).toMatchObject({ kind: 'text', offsetMs: null, match: null });
  });

  it('пусто по номеру карты: строки только другой карты с теми же краями не считаются', async () => {
    const store = new FakeStore();
    store.lines.push(rec(NOW - 10 * M, null, `card ${TWIN} declined`));
    const job = await run(store, { terms: [EXACT], fromMs: NOW - H, toMs: NOW });
    expect(job.state()).toMatchObject({ lines: 'none' });
  });

  it('сводки дописываются в конец, опрос с from отдаёт хвост', async () => {
    const store = new FakeStore();
    for (let h = 0; h < 3; h++) store.lines.push(...request(`s${h}`, NOW - h * H - 30 * M, 'needle'));
    sortLines(store.lines);
    const job = await run(store, { terms: ['needle'], fromMs: NOW - 3 * H, toMs: NOW, limits: { batchSize: 1 } });
    const all = job.state(0);
    expect(all.requests.map((r) => r.correlationId)).toEqual(['s0', 's1', 's2']);
    expect(job.state(2)).toMatchObject({ requests: [expect.objectContaining({ correlationId: 's2' })], requestsTotal: 3 });
    expect(job.keep).toEqual(new Set(['s0', 's1', 's2']));
  });
});

describe('«Все записи»', () => {
  /** 260 строк по номеру: каждая третья — другая карта с теми же краями, каждая пятая — только маска. */
  function cardLines(store: FakeStore) {
    for (let i = 0; i < 260; i++) {
      const pan = i % 3 === 0 ? TWIN : i % 5 === 0 ? MASKED : EXACT;
      // Пары строк в одну наносекунду: граница страницы попадает и между ними.
      const tsNs = (nsOf(NOW - 50 * M + Math.floor(i / 2) * 1000)).toString();
      store.lines.push({ tsNs, line: JSON.stringify({ message: `line ${i} card ${pan}` }), labels: { container: 'gateway' } });
    }
  }

  async function readAll(store: FakeStore, terms: string[]) {
    const { job, deps, warnings } = makeJob(store, { terms, fromMs: NOW - H, toMs: NOW });
    const pages: string[][] = [];
    const matches: (string | null)[] = [];
    let cursor: PageCursor | null = null;
    for (let n = 0; n < 50; n++) {
      const page = await readLinesPage(deps, job.spec, cursor, new AbortController().signal);
      pages.push(page.records.map((r) => r.message));
      matches.push(...page.records.map((r) => r.match));
      if (!page.next) return { pages, matches, warnings };
      cursor = decodeCursor(encodeCursor(page.next));
    }
    throw new Error('чтение зациклилось');
  }

  it('страницы по 100 от новых к старым без повторов и пропусков, чужие карты отсеяны', async () => {
    const store = new FakeStore();
    cardLines(store);
    const { pages, matches, warnings } = await readAll(store, [EXACT]);
    expect(warnings).toEqual([]);
    expect(pages.slice(0, -1).every((p) => p.length === 100)).toBe(true);
    const got = pages.flat();
    const expected = store.lines
      .map((l, i) => ({ l, i }))
      .filter(({ i }) => i % 3 !== 0)
      .sort((a, b) => (BigInt(a.l.tsNs) === BigInt(b.l.tsNs) ? a.i - b.i : BigInt(a.l.tsNs) > BigInt(b.l.tsNs) ? -1 : 1))
      .map(({ l }) => (JSON.parse(l.line) as { message: string }).message);
    expect(new Set(got).size).toBe(got.length);
    expect([...got].sort()).toEqual([...expected].sort());
    expect(got.filter((m) => m.includes(TWIN))).toEqual([]);
    expect(matches.filter((m) => m === 'inexact')).toHaveLength(got.filter((m) => m.includes(MASKED)).length);
    expect(matches.every((m) => m === 'exact' || m === 'inexact')).toBe(true);
  });

  it('без номера карты — пометки совпадения нет', async () => {
    const store = new FakeStore();
    cardLines(store);
    const { pages, matches } = await readAll(store, ['card 4111']);
    expect(pages.flat()).toHaveLength(260);
    expect(matches.every((m) => m === null)).toBe(true);
  });

  it('если после отсева всё пусто — не больше 5 страниц хранилища, курсор отдаётся', async () => {
    const store = new FakeStore();
    for (let i = 0; i < 700; i++) {
      store.lines.push({ tsNs: nsOf(NOW - 50 * M + i * 10).toString(), line: JSON.stringify({ message: `twin ${TWIN} ${i}` }), labels: {} });
    }
    const { job, deps } = makeJob(store, { terms: [EXACT], fromMs: NOW - H, toMs: NOW });
    const page = await readLinesPage(deps, job.spec, null, new AbortController().signal);
    expect(page.records).toEqual([]);
    expect(page.next).not.toBeNull();
    expect(store.queries).toHaveLength(5);
    expect(store.queries.every((q) => q.direction === 'backward' && q.limit === 100)).toBe(true);
  });
});
