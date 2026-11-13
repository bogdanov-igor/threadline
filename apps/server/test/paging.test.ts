import { describe, expect, it } from 'vitest';
import { BackendError, type CheckInfo, type CountQuery, type LinesQuery, type LogBackend, type LogLine } from '@threadline/core/backend';
import { validateConfig } from '@threadline/core/config';
import { BUILTIN_COUNT_REGEXP } from '@threadline/core/profile';
import type { ResolvedConfig } from '../src/config/load.ts';
import { Backends } from '../src/backends/registry.ts';
import { readLines, type EngineDeps } from '../src/search/engine.ts';
import { decodeCursor, encodeCursor, lineHash, readPage, type PageCursor } from '../src/search/paging.ts';

const MS = 1_000_000n;
const BASE = 1_793_180_000_000_000_000n;
const T0 = Number(BASE / MS);

/**
 * Хранилище строк в памяти. Порядок строк с равным временем задаётся: как в наборе или свой на каждый вызов.
 * short — как Loki 2.9 с фильтром строк: страница обрывается раньше предела на случайном времени (все строки
 * до него и с ним включительно), хотя строки дальше есть.
 */
class LinesAdapter implements LogBackend {
  readonly calls: LinesQuery[] = [];
  /** Ответ на каждый вызов. */
  readonly answers: LogLine[][] = [];
  readonly counts: CountQuery[] = [];
  readonly data: LogLine[];
  readonly ties: 'stable' | 'shuffle';
  readonly short: boolean;

  constructor(data: LogLine[], ties: 'stable' | 'shuffle' = 'stable', short = false) {
    this.data = data;
    this.ties = ties;
    this.short = short;
  }

  async check(): Promise<CheckInfo> {
    return { labelNames: [] };
  }
  async labelValues(): Promise<string[]> {
    return [];
  }
  async countBy(q: CountQuery): Promise<Record<string, number>> {
    this.counts.push(q);
    return { 'cid-1': 2 };
  }

  async queryLines(q: LinesQuery): Promise<LogLine[]> {
    this.calls.push(q);
    const from = q.range.fromNs !== undefined ? BigInt(q.range.fromNs) : BigInt(q.range.fromMs) * MS;
    const to = q.range.toNs !== undefined ? BigInt(q.range.toNs) : BigInt(q.range.toMs) * MS;
    const rand = mulberry(this.calls.length);
    const sign = q.direction === 'forward' ? 1 : -1;
    const page = this.data
      .map((l, i) => ({ l, t: BigInt(l.tsNs), k: this.ties === 'stable' ? i : rand() }))
      .filter((x) => x.t >= from && x.t <= to)
      .sort((a, b) => (a.t === b.t ? a.k - b.k : a.t < b.t ? -sign : sign))
      .slice(0, q.limit);
    const cut = this.short && page.length > 0 ? page[Math.floor(rand() * page.length)]!.t : null;
    const out = (cut === null ? page : page.filter((x) => (sign > 0 ? x.t <= cut : x.t >= cut))).map((x) => x.l);
    this.answers.push(out);
    return out;
  }
}

function mulberry(seed: number): () => number {
  let a = seed * 2654435761;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function setup(adapter: LogBackend) {
  const v = validateConfig({
    auth: 'off',
    defaults: { project: 'pay', environment: 'demo' },
    backends: {
      demo: { type: 'mock' },
      grafana: { type: 'loki-grafana', url: 'https://g.example', tokenEnv: 'T' },
    },
    projects: {
      pay: {
        name: 'Demo Pay',
        environments: {
          demo: { name: 'Демо', backend: 'demo', selector: [{ label: 'namespace', op: '=', value: 'pay' }] },
          prod: { name: 'Прод', backend: 'grafana', selector: [{ label: 'namespace', op: '=', value: 'pay' }] },
        },
      },
    },
  });
  if (!v.ok) throw new Error(JSON.stringify(v.issues));
  const d = v.config.backends.demo;
  const g = v.config.backends.grafana;
  if (d?.type !== 'mock' || g?.type !== 'loki-grafana') throw new Error('bad base');
  const resolved: ResolvedConfig = { path: 'x', config: v.config, backends: { demo: d, grafana: { ...g, token: undefined, ca: undefined } } };
  const reg = new Backends(resolved, { createAdapter: () => adapter });
  return { reg, env: reg.environment('pay', 'demo')!, unconfigured: reg.environment('pay', 'prod')! };
}

const signal = () => new AbortController().signal;
const at = (ns: bigint, line: string): LogLine => ({ tsNs: (BASE + ns).toString(), line, labels: { container: 'api' } });

const query = (over: Partial<LinesQuery> = {}): LinesQuery => ({
  selector: [{ label: 'namespace', op: '=', value: 'pay' }],
  filters: [{ kind: 'contains', value: 'x' }],
  range: { fromMs: T0, toMs: T0 + 60_000 },
  limit: 3,
  direction: 'forward',
  ...over,
});

/** Читает все страницы. Курсор каждый раз проходит через адресную строку. */
async function readAll(adapter: LinesAdapter, q: LinesQuery) {
  const { reg, env } = setup(adapter);
  const warnings: string[] = [];
  const out: LogLine[] = [];
  let cursor: PageCursor | null = null;
  for (let pages = 0; ; pages++) {
    if (pages > 1000) throw new Error('чтение зациклилось');
    const page = await readPage(reg, env, q, cursor, signal(), { warn: (m) => warnings.push(m) });
    out.push(...page.lines);
    if (!page.next) break;
    cursor = decodeCursor(encodeCursor(page.next));
  }
  return { lines: out, warnings };
}

/** Набор с группами строк в одну наносекунду до 3 штук, в одной и в разных мс. */
function dataset(): LogLine[] {
  const sizes = [1, 2, 3, 1, 1, 3, 2, 1, 3, 3, 1, 2, 2, 1, 3];
  const steps = [1n, 250_000n, 999_999n, 1n, MS, 7n, 3n * MS, 500n];
  const out: LogLine[] = [];
  let t = 10n;
  let n = 0;
  sizes.forEach((size, gi) => {
    for (let i = 0; i < size; i++) out.push(at(t, `line-${n++}`));
    t += steps[gi % steps.length]!;
  });
  // Одинаковый текст в разное время — разные строки.
  out.push(at(t, 'line-0'), at(t + 1n, 'line-0'));
  return out;
}

const key = (l: LogLine) => `${l.tsNs}|${l.line}`;
const sorted = (ls: LogLine[]) => ls.map(key).sort();

describe('постраничное чтение', () => {
  for (const direction of ['forward', 'backward'] as const) {
    for (const ties of ['stable', 'shuffle'] as const) {
      it(`${direction}, порядок равных ${ties}: без повторов и пропусков при любом пределе`, async () => {
        const data = dataset();
        for (let limit = 3; limit <= 8; limit++) {
          const { lines } = await readAll(new LinesAdapter(data, ties), query({ direction, limit }));
          expect(sorted(lines)).toEqual(sorted(data));
          const ts = lines.map((l) => BigInt(l.tsNs));
          for (let i = 1; i < ts.length; i++) {
            if (direction === 'forward') expect(ts[i]! >= ts[i - 1]!).toBe(true);
            else expect(ts[i]! <= ts[i - 1]!).toBe(true);
          }
        }
      });
    }
  }

  for (const direction of ['forward', 'backward'] as const) {
    it(`${direction}: хранилище обрывает страницы раньше предела (Loki 2.9) — ни одна строка не теряется`, async () => {
      const data = dataset();
      for (const ties of ['stable', 'shuffle'] as const) {
        for (let limit = 3; limit <= 8; limit++) {
          const { lines } = await readAll(new LinesAdapter(data, ties, true), query({ direction, limit }));
          expect(sorted(lines)).toEqual(sorted(data));
          expect(new Set(lines.map(key)).size).toBe(lines.length);
        }
      }
    });
  }

  it('readLines: короткие страницы не обрывают чтение; truncated — только если строки отброшены', async () => {
    const data = dataset();
    const adapter = new LinesAdapter(data, 'stable', true);
    const { reg, env } = setup(adapter);
    const deps: EngineDeps = { backends: reg, now: () => T0, warn: () => {} };
    const all = await readLines(deps, env, query({ limit: 4 }), 1000, signal());
    expect(all.truncated).toBe(false);
    expect(sorted(all.lines)).toEqual(sorted(data));
    const part = await readLines(deps, env, query({ limit: 4 }), 10, signal());
    expect(part.truncated).toBe(true);
    expect(part.lines).toHaveLength(10);
  });

  it('несколько строк в одну наносекунду на границе страницы: ни одна не теряется и не повторяется', async () => {
    const data = [at(1n, 'a'), at(2n, 'b'), at(3n, 'c1'), at(3n, 'c2'), at(3n, 'c3'), at(4n, 'd')];
    for (const direction of ['forward', 'backward'] as const) {
      const { lines } = await readAll(new LinesAdapter(data), query({ direction }));
      expect(sorted(lines)).toEqual(sorted(data));
    }
    const fwd = await readAll(new LinesAdapter(data), query());
    expect(fwd.lines.map((l) => l.line)).toEqual(['a', 'b', 'c1', 'c2', 'c3', 'd']);
    const back = await readAll(new LinesAdapter(data), query({ direction: 'backward' }));
    expect(back.lines.map((l) => l.line)).toEqual(['d', 'c1', 'c2', 'c3', 'b', 'a']);
  });

  it('граница forward: следующий запрос с времени последней строки включительно, в нс', async () => {
    const adapter = new LinesAdapter([at(MS + 100n, 'x'), at(MS + 200n, 'y'), at(2n * MS, 'z')]);
    const { reg, env } = setup(adapter);
    const q = query({ limit: 2 });
    const p1 = await readPage(reg, env, q, null, signal());
    expect(p1.lines.map((l) => l.line)).toEqual(['x', 'y']);
    expect(p1.next).toEqual({ tsNs: (BASE + MS + 200n).toString(), seen: [lineHash((BASE + MS + 200n).toString(), 'y')] });
    const p2 = await readPage(reg, env, q, p1.next, signal());
    expect(p2.lines).toEqual([at(2n * MS, 'z')]);
    expect(p2.next?.tsNs).toBe((BASE + 2n * MS).toString());
    expect(await readPage(reg, env, q, p2.next, signal())).toEqual({ lines: [], next: null });
    expect(adapter.calls[0]).toEqual(q);
    expect(adapter.calls[1]!.range).toEqual({ fromMs: T0 + 1, toMs: T0 + 60_000, fromNs: (BASE + MS + 200n).toString() });
  });

  it('граница backward: следующий запрос кончается на времени самой старой строки включительно', async () => {
    const adapter = new LinesAdapter([at(MS + 100n, 'x'), at(MS + 200n, 'y'), at(2n * MS, 'z')]);
    const { reg, env } = setup(adapter);
    const q = query({ limit: 2, direction: 'backward' });
    const p1 = await readPage(reg, env, q, null, signal());
    expect(p1.lines.map((l) => l.line)).toEqual(['z', 'y']);
    const p2 = await readPage(reg, env, q, p1.next, signal());
    expect(p2.lines.map((l) => l.line)).toEqual(['x']);
    expect(await readPage(reg, env, q, p2.next, signal())).toEqual({ lines: [], next: null });
    // Конец в мс округлён вверх: хранилище без нс отдаст лишнее, а не потеряет строки.
    expect(adapter.calls[1]!.range).toEqual({ fromMs: T0, toMs: T0 + 2, toNs: (BASE + MS + 200n).toString() });
  });

  it('пустой результат — конец; короткая страница — не конец, следующая через 1 нс после неё', async () => {
    const { reg, env } = setup(new LinesAdapter([]));
    expect(await readPage(reg, env, query(), null, signal())).toEqual({ lines: [], next: null });
    const adapter = new LinesAdapter([at(1n, 'a'), at(2n, 'b')]);
    const two = setup(adapter);
    const p1 = await readPage(two.reg, two.env, query(), null, signal());
    expect(p1.lines.map((l) => l.line)).toEqual(['a', 'b']);
    // Короткая страница уже содержит все строки времени b: того же времени второй раз не спрашиваем.
    expect(p1.next).toEqual({ tsNs: (BASE + 3n).toString(), seen: [] });
    expect(await readPage(two.reg, two.env, query(), p1.next, signal())).toEqual({ lines: [], next: null });
    expect(adapter.calls.map((c) => c.range.fromNs)).toEqual([undefined, (BASE + 3n).toString()]);
  });

  it('короткая страница от новых к старым кончается за 1 нс до последней строки', async () => {
    const adapter = new LinesAdapter([at(MS + 1n, 'a'), at(MS + 2n, 'b')]);
    const { reg, env } = setup(adapter);
    const p1 = await readPage(reg, env, query({ direction: 'backward' }), null, signal());
    expect(p1.lines.map((l) => l.line)).toEqual(['b', 'a']);
    expect(p1.next).toEqual({ tsNs: (BASE + MS).toString(), seen: [] });
    expect(await readPage(reg, env, query({ direction: 'backward' }), p1.next, signal())).toEqual({ lines: [], next: null });
    expect(adapter.calls[1]!.range).toMatchObject({ toNs: (BASE + MS).toString(), toMs: T0 + 1 });
  });

  it('короткая страница на последней наносекунде периода — конец без нового запроса', async () => {
    const end = BigInt(T0 + 1) * MS;
    const fwd = new LinesAdapter([at(5n, 'a'), { ...at(0n, 'z'), tsNs: end.toString() }]);
    const f = setup(fwd);
    const q = query({ range: { fromMs: T0, toMs: T0 + 1 } });
    expect(await readPage(f.reg, f.env, q, null, signal())).toMatchObject({ next: null });
    expect(fwd.calls).toHaveLength(1);
    const back = new LinesAdapter([at(0n, 'a'), at(7n, 'b')]);
    const b = setup(back);
    expect(await readPage(b.reg, b.env, query({ direction: 'backward', range: { fromMs: T0, toMs: T0 + 1 } }), null, signal())).toMatchObject({ next: null });
    expect(back.calls).toHaveLength(1);
  });

  it('случайные наборы со строками в одну наносекунду и обрывом страниц: без потерь и повторов, после короткой страницы — сразу дальше', async () => {
    for (let seed = 1; seed <= 150; seed++) {
      const r = mulberry(seed);
      const data = Array.from({ length: 1 + Math.floor(r() * 120) }, (_, i) => at(BigInt(Math.floor(r() * 50)) * 1000n + (r() < 0.3 ? 0n : BigInt(Math.floor(r() * 3))), `l${i}`));
      const perNs = new Map<string, number>();
      for (const l of data) perNs.set(l.tsNs, (perNs.get(l.tsNs) ?? 0) + 1);
      const ties = Math.max(...perNs.values());
      const limit = ties + 1 + Math.floor(r() * 20);
      for (const direction of ['forward', 'backward'] as const) {
        const adapter = new LinesAdapter(data, seed % 2 ? 'stable' : 'shuffle', true);
        const { lines } = await readAll(adapter, query({ direction, limit, range: { fromMs: T0, toMs: T0 + 1 } }));
        expect(sorted(lines)).toEqual(sorted(data));
        // После короткого ответа следующий запрос начинается (backward — кончается) через 1 нс после его последней строки.
        for (let i = 1; i < adapter.calls.length; i++) {
          const prev = adapter.answers[i - 1]!;
          if (prev.length === 0 || prev.length >= limit) continue;
          const edge = prev.map((l) => BigInt(l.tsNs)).reduce((a, b) => (direction === 'forward' ? (b > a ? b : a) : b < a ? b : a));
          const bound = direction === 'forward' ? adapter.calls[i]!.range.fromNs : adapter.calls[i]!.range.toNs;
          expect(bound).toBe((direction === 'forward' ? edge + 1n : edge - 1n).toString());
        }
      }
    }
  });

  it('ровно предел строк: вторая страница пустая и последняя', async () => {
    const data = [at(1n, 'a'), at(2n, 'b'), at(3n, 'c')];
    const adapter = new LinesAdapter(data);
    const { reg, env } = setup(adapter);
    const p1 = await readPage(reg, env, query(), null, signal());
    expect(p1.lines).toHaveLength(3);
    expect(p1.next).not.toBeNull();
    expect(await readPage(reg, env, query(), p1.next, signal())).toEqual({ lines: [], next: null });
  });

  it('больше предела строк в одной наносекунде: граница сдвигается на 1 нс, чтение не зацикливается', async () => {
    const same = ['s1', 's2', 's3', 's4', 's5'].map((s) => at(2000n, s));
    const data = [at(1000n, 'a'), ...same, at(3000n, 'z')];
    const fwd = new LinesAdapter(data);
    const r = await readAll(fwd, query());
    expect(r.lines.map((l) => l.line)).toEqual(['a', 's1', 's2', 's3', 'z']);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain((BASE + 2000n).toString());
    expect(r.warnings[0]).not.toContain('s4');
    expect(fwd.calls.some((c) => c.range.fromNs === (BASE + 2001n).toString())).toBe(true);

    const back = new LinesAdapter(data);
    const b = await readAll(back, query({ direction: 'backward' }));
    expect(b.lines.map((l) => l.line)).toEqual(['z', 's1', 's2', 's3', 'a']);
    expect(b.warnings).toHaveLength(1);
    expect(back.calls.some((c) => c.range.toNs === (BASE + 1999n).toString())).toBe(true);
  });

  it('при меняющемся порядке равных строк отдаёт больше строк одной наносекунды и не повторяет их', async () => {
    const data = [at(1n, 'a'), ...Array.from({ length: 6 }, (_, i) => at(2n, `s${i}`)), at(3n, 'z')];
    const { lines } = await readAll(new LinesAdapter(data, 'shuffle'), query());
    expect(new Set(lines.map(key)).size).toBe(lines.length);
    expect(lines[0]!.line).toBe('a');
    expect(lines.at(-1)!.line).toBe('z');
  });

  it('сдвиг за конец периода завершает чтение', async () => {
    const data = ['s1', 's2', 's3', 's4'].map((s) => at(0n, s));
    const adapter = new LinesAdapter(data);
    const q = query({ range: { fromMs: T0 - 1, toMs: T0 } });
    const r = await readAll(adapter, q);
    expect(r.lines.map((l) => l.line)).toEqual(['s1', 's2', 's3']);
    expect(adapter.calls).toHaveLength(2);
    const b = await readAll(new LinesAdapter(data), query({ direction: 'backward', range: { fromMs: T0, toMs: T0 + 1 } }));
    expect(b.lines).toHaveLength(3);
  });

  it('отклоняет предел меньше 1', async () => {
    const { reg, env } = setup(new LinesAdapter([]));
    await expect(readPage(reg, env, query({ limit: 0 }), null, signal())).rejects.toThrow();
  });
});

describe('защитный слой для чтения и подсчёта', () => {
  it('одинаковые одновременные запросы склеиваются, разные — нет', async () => {
    const adapter = new LinesAdapter([at(1n, 'a')]);
    const { reg, env } = setup(adapter);
    const [a, b] = await Promise.all([readPage(reg, env, query(), null, signal()), readPage(reg, env, query(), null, signal())]);
    expect(a).toEqual(b);
    expect(adapter.calls).toHaveLength(1);
    await Promise.all([reg.queryLines(env, query(), signal()), reg.queryLines(env, query({ limit: 4 }), signal())]);
    expect(adapter.calls).toHaveLength(3);
  });

  it('подсчёт идёт через защитный слой и склеивается', async () => {
    const adapter = new LinesAdapter([]);
    const { reg, env } = setup(adapter);
    const q: CountQuery = {
      selector: [{ label: 'namespace', op: '=', value: 'pay' }],
      filters: [],
      range: { fromMs: T0, toMs: T0 + 3_600_000 },
      key: { regexp: BUILTIN_COUNT_REGEXP },
    };
    const [a, b] = await Promise.all([reg.countBy(env, q, signal()), reg.countBy(env, q, signal())]);
    expect(a).toEqual({ 'cid-1': 2 });
    expect(b).toEqual(a);
    expect(adapter.counts).toHaveLength(1);
  });

  it('отмена клиентом прерывает чтение', async () => {
    const { reg, env } = setup(new LinesAdapter([]));
    const c = new AbortController();
    c.abort();
    await expect(readPage(reg, env, query(), null, c.signal)).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('без токена — «не настроено», в хранилище не ходит', async () => {
    const adapter = new LinesAdapter([at(1n, 'a')]);
    const { reg, unconfigured } = setup(adapter);
    const e = await readPage(reg, unconfigured, query(), null, signal()).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(BackendError);
    expect((e as BackendError).code).toBe('not-configured');
    await expect(reg.countBy(unconfigured, {} as CountQuery, signal())).rejects.toMatchObject({ code: 'not-configured' });
    expect(adapter.calls).toHaveLength(0);
  });
});

describe('курсор', () => {
  const b64 = (v: unknown) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

  it('кодируется в base64url и обратно', () => {
    const c: PageCursor = { tsNs: '1793180000000000123', seen: [lineHash('1793180000000000123', 'a'), lineHash('1793180000000000123', 'b')] };
    const s = encodeCursor(c);
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(s)).toEqual(c);
    expect(decodeCursor(encodeCursor({ tsNs: '0', seen: [] }))).toEqual({ tsNs: '0', seen: [] });
  });

  it('хэш строки — 16 символов sha1 от времени и текста', () => {
    expect(lineHash('1', 'a')).toMatch(/^[0-9a-f]{16}$/);
    expect(lineHash('1', 'a')).not.toBe(lineHash('2', 'a'));
    expect(lineHash('1', 'a')).not.toBe(lineHash('1', 'b'));
    expect(lineHash('1', '1\na')).not.toBe(lineHash('11', 'a'));
  });

  it.each([
    ['пустая строка', ''],
    ['не base64url', 'abc+/='],
    ['не JSON', b64('not json')],
    ['массив', b64([])],
    ['null', b64('null')],
    ['время числом', b64({ tsNs: 12, seen: [] })],
    ['время с нулём впереди', b64({ tsNs: '012', seen: [] })],
    ['отрицательное время', b64({ tsNs: '-1', seen: [] })],
    ['время слишком длинное', b64({ tsNs: '1'.repeat(21), seen: [] })],
    ['seen не массив', b64({ tsNs: '1', seen: 'x' })],
    ['нет seen', b64({ tsNs: '1' })],
    ['хэш не hex', b64({ tsNs: '1', seen: ['zzzzzzzzzzzzzzzz'] })],
    ['хэш другой длины', b64({ tsNs: '1', seen: ['abc'] })],
    ['хэш не строка', b64({ tsNs: '1', seen: [1] })],
    ['слишком много хэшей', b64({ tsNs: '1', seen: Array.from({ length: 100_001 }, () => '0123456789abcdef') })],
  ])('отклоняет курсор: %s', (_name, s) => {
    expect(() => decodeCursor(s)).toThrow('bad-cursor');
  });
});
