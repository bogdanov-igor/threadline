import type { ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { BackendError, type CountQuery, type LinesQuery } from '@threadline/core/backend';
import type { ResolvedLoki } from '../src/config/load.ts';
import { LokiGrafanaBackend } from '../src/backends/loki-grafana.ts';
import { BUILTIN_COUNT_REGEXP } from '@threadline/core/profile';
import { countLogql } from '../src/backends/logql.ts';
import { fakeGrafana, json } from './fake-grafana.ts';

let servers: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
});

type Reply = (res: ServerResponse, params: URLSearchParams) => void;

/** Grafana с источником id 7: на чтение и подсчёт отвечает заданными функциями. */
async function setup(opts: { range?: Reply; query?: Reply }) {
  const g = await fakeGrafana((req, res) => {
    const u = new URL(req.url ?? '', 'http://x');
    if (u.pathname === '/api/datasources/id/Loki') return json(res, 200, { id: 7 });
    if (u.pathname === '/api/datasources/proxy/7/loki/api/v1/query_range' && opts.range) return opts.range(res, u.searchParams);
    if (u.pathname === '/api/datasources/proxy/7/loki/api/v1/query' && opts.query) return opts.query(res, u.searchParams);
    json(res, 404, { message: 'Not found' });
  });
  servers.push(g);
  const cfg: ResolvedLoki = {
    type: 'loki-grafana',
    url: g.url,
    datasource: { name: 'Loki' },
    tokenEnv: 'T',
    token: 'test-token',
    ca: undefined,
    maxConcurrent: 4,
    queueTimeoutSeconds: 10,
    timeoutSeconds: 30,
  };
  const params = (path: string) =>
    g.requests.filter((r) => new URL(r.url, 'http://x').pathname.endsWith(path)).map((r) => new URL(r.url, 'http://x').searchParams);
  return { g, backend: new LokiGrafanaBackend(cfg), params };
}

const signal = () => AbortSignal.timeout(5000);
const ok = (data: unknown): Reply => (res) => json(res, 200, { status: 'success', data });
const streams = (result: unknown): Reply => ok({ resultType: 'streams', result });
const vector = (result: unknown): Reply => ok({ resultType: 'vector', result });

async function failure(p: Promise<unknown>): Promise<BackendError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof BackendError) return e;
    throw e;
  }
  throw new Error('ожидалась ошибка');
}

const T0 = 1_793_180_000_000;
const lines = (over: Partial<LinesQuery> = {}): LinesQuery => ({
  selector: [{ label: 'namespace', op: '=', value: 'pay' }],
  filters: [{ kind: 'contains', value: 'abc' }],
  range: { fromMs: T0, toMs: T0 + 60_000 },
  limit: 100,
  direction: 'forward',
  ...over,
});

const count = (over: Partial<CountQuery> = {}): CountQuery => ({
  selector: [{ label: 'namespace', op: '=', value: 'pay' }],
  filters: [{ kind: 'contains', value: 'abc' }],
  range: { fromMs: T0, toMs: T0 + 3_600_000 },
  key: { regexp: BUILTIN_COUNT_REGEXP },
  ...over,
});

const A = { container: 'api', pod: 'a' };
const B = { container: 'kafka-consumer', pod: 'b' };
const twoStreams = [
  { stream: A, values: [['1793180000000000300', 'a3'], ['1793180000000000100', 'a1']] },
  { stream: B, values: [['1793180000000000200', 'b2'], ['1793180000000000100', 'b1'], ['1793180000000000400', 'b4']] },
];

describe('queryLines в Loki', () => {
  it('идёт в query_range с периодом в нс, концом +1 нс, пределом и направлением', async () => {
    const { backend, params } = await setup({ range: streams([]) });
    expect(await backend.queryLines(lines({ direction: 'backward', limit: 5000 }), signal())).toEqual([]);
    const p = params('/query_range')[0]!;
    expect(p.get('query')).toBe('{namespace="pay"} |= "abc"');
    expect(p.get('start')).toBe('1793180000000000000');
    expect(p.get('end')).toBe('1793180060000000001');
    expect(p.get('limit')).toBe('5000');
    expect(p.get('direction')).toBe('backward');
  });

  it('точная граница в нс заменяет мс', async () => {
    const { backend, params } = await setup({ range: streams([]) });
    await backend.queryLines(
      lines({ range: { fromMs: T0, toMs: T0 + 60_000, fromNs: '1793180000000123456', toNs: '1793180059999999999' } }),
      signal(),
    );
    const p = params('/query_range')[0]!;
    expect(p.get('start')).toBe('1793180000000123456');
    expect(p.get('end')).toBe('1793180060000000000');
  });

  it('пустой период не ходит в Loki', async () => {
    const { g, backend } = await setup({ range: streams([]) });
    expect(await backend.queryLines(lines({ range: { fromMs: T0 + 1, toMs: T0 } }), signal())).toEqual([]);
    expect(g.requests).toHaveLength(0);
  });

  it('разворачивает потоки и сортирует от старых к новым, равное время — в порядке ответа', async () => {
    const { backend } = await setup({ range: streams(twoStreams) });
    const got = await backend.queryLines(lines(), signal());
    expect(got.map((l) => l.line)).toEqual(['a1', 'b1', 'b2', 'a3', 'b4']);
    expect(got[0]).toEqual({ tsNs: '1793180000000000100', line: 'a1', labels: A });
    expect(got[1]!.labels).toEqual(B);
  });

  it('от новых к старым — по убыванию времени', async () => {
    const { backend } = await setup({ range: streams(twoStreams) });
    const got = await backend.queryLines(lines({ direction: 'backward' }), signal());
    expect(got.map((l) => l.line)).toEqual(['b4', 'a3', 'b2', 'a1', 'b1']);
  });

  it('сравнивает время как числа, а не как строки', async () => {
    const { backend } = await setup({ range: streams([{ stream: A, values: [['1000000000000000000', 'new'], ['999999999999999999', 'old']] }]) });
    expect((await backend.queryLines(lines(), signal())).map((l) => l.line)).toEqual(['old', 'new']);
  });

  it('не отдаёт больше предела', async () => {
    const { backend } = await setup({ range: streams(twoStreams) });
    expect((await backend.queryLines(lines({ limit: 2 }), signal())).map((l) => l.line)).toEqual(['a1', 'b1']);
  });

  it.each([
    ['data не объект', null],
    ['не потоки', { resultType: 'matrix', result: [] }],
    ['result не массив', { resultType: 'streams', result: {} }],
    ['нет values', { resultType: 'streams', result: [{ stream: A }] }],
    ['метка не строка', { resultType: 'streams', result: [{ stream: { a: 1 }, values: [] }] }],
    ['время не число', { resultType: 'streams', result: [{ stream: A, values: [['12a', 'x']] }] }],
    ['строка не строка', { resultType: 'streams', result: [{ stream: A, values: [['12', 5]] }] }],
    ['значение не пара', { resultType: 'streams', result: [{ stream: A, values: ['12'] }] }],
  ])('битый ответ (%s) → bad-response', async (_name, data) => {
    const { backend } = await setup({ range: ok(data) });
    expect((await failure(backend.queryLines(lines(), signal()))).code).toBe('bad-response');
  });

  it('предел строк Loki → limit', async () => {
    const { backend } = await setup({
      range: (res) => {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('max entries limit per query exceeded, limit > max_entries_limit (10000 > 5000)');
      },
    });
    expect((await failure(backend.queryLines(lines({ limit: 10000 }), signal()))).code).toBe('limit');
  });
});

describe('countBy в Loki', () => {
  it('один мгновенный запрос на конец периода + 1 нс с окном длиннее периода', async () => {
    const { g, backend, params } = await setup({ query: vector([]) });
    const q = count();
    expect(await backend.countBy(q, signal())).toEqual({});
    expect(g.requests).toHaveLength(2);
    const p = params('/query')[0]!;
    // Окно Loki (time − range, time) без обоих концов: строки ровно в начале и ровно в конце часа внутри.
    expect(p.get('query')).toBe(countLogql(q, 3601));
    expect(p.get('query')).toContain('[3601s]');
    expect(p.get('time')).toBe('1793183600000000001');
    expect(p.has('start')).toBe(false);
  });

  it('кусок, кончающийся на T: time = T + 1 нс, окно покрывает начало куска', async () => {
    const { backend, params } = await setup({ query: vector([]) });
    const fromMs = T0 + 20 * 60_000;
    const toMs = T0 + 40 * 60_000;
    await backend.countBy(count({ range: { fromMs, toMs } }), signal());
    const p = params('/query')[0]!;
    const time = BigInt(p.get('time')!);
    const range = BigInt(/\[(\d+)s\]/.exec(p.get('query')!)![1]!) * 1_000_000_000n;
    expect(time).toBe(BigInt(toMs) * 1_000_000n + 1n);
    // Начало куска строго внутри открытого окна: (time − range) < from.
    expect(time - range < BigInt(fromMs) * 1_000_000n).toBe(true);
    expect(range > BigInt(toMs - fromMs) * 1_000_000n).toBe(true);
  });

  it('округляет окно вверх и не делает его пустым', async () => {
    const { backend, params } = await setup({ query: vector([]) });
    await backend.countBy(count({ range: { fromMs: T0, toMs: T0 + 1500 } }), signal());
    await backend.countBy(count({ range: { fromMs: T0, toMs: T0 } }), signal());
    const [a, b] = params('/query');
    expect(a!.get('query')).toContain('[2s]');
    expect(b!.get('query')).toContain('[1s]');
  });

  it('разбирает вектор: значение метки → число, пустые и не числа пропускает', async () => {
    const { backend } = await setup({
      query: vector([
        { metric: { threadline_key: 'cid-1' }, value: [1793183600, '3'] },
        { metric: { threadline_key: 'cid-2' }, value: [1793183600, '12'] },
        { metric: { threadline_key: '' }, value: [1793183600, '7'] },
        { metric: {}, value: [1793183600, '7'] },
        { metric: { threadline_key: 'cid-3' }, value: [1793183600, 'NaN'] },
        { metric: { threadline_key: '__proto__' }, value: [1793183600, '1'] },
      ]),
    });
    const got = await backend.countBy(count(), signal());
    expect(Object.keys(got).sort()).toEqual(['__proto__', 'cid-1', 'cid-2']);
    expect(got['cid-1']).toBe(3);
    expect(got['cid-2']).toBe(12);
    expect(Object.getPrototypeOf(got)).toBe(Object.prototype);
  });

  it.each([
    ['не вектор', { resultType: 'streams', result: [] }],
    ['result не массив', { resultType: 'vector', result: null }],
    ['нет metric', { resultType: 'vector', result: [{ value: [1, '1'] }] }],
    ['value не массив', { resultType: 'vector', result: [{ metric: { threadline_key: 'a' }, value: '1' }] }],
  ])('битый ответ (%s) → bad-response', async (_name, data) => {
    const { backend } = await setup({ query: ok(data) });
    expect((await failure(backend.countBy(count(), signal()))).code).toBe('bad-response');
  });

  it('лимит рядов Loki → limit', async () => {
    const { backend } = await setup({
      query: (res) => {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('maximum of series (500) reached for a single query');
      },
    });
    const e = await failure(backend.countBy(count(), signal()));
    expect(e.code).toBe('limit');
    expect(e.details).toContain('maximum of series (500)');
  });

  it('Loki не вернул status: success → bad-response', async () => {
    const { backend } = await setup({ query: (res) => json(res, 200, { status: 'error', data: null }) });
    expect((await failure(backend.countBy(count(), signal()))).code).toBe('bad-response');
  });
});
