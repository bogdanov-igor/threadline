import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { luhnValid } from '@threadline/core';
import { BackendError, type CheckInfo, type CountQuery, type LinesQuery, type LogBackend, type LogLine, type Matcher, type TimeRange } from '@threadline/core/backend';
import { parseLine, type LinesPageResponse, type RequestDetail, type SearchCreated, type SearchState, type ViewRecord } from '@threadline/core/search';
import { buildApp } from '../src/app.ts';
import { generatePayDataset, MOCK_PHONE, MOCK_SPECIAL } from '../src/backends/mock/dataset-pay.ts';
import { MockBackend } from '../src/backends/mock/index.ts';
import { Backends, defaultAdapter } from '../src/backends/registry.ts';
import { loadConfig } from '../src/config/load.ts';
import { SearchJobs } from '../src/search/jobs.ts';
import { MASK_PLACEHOLDER_TITLE, maskRecords } from '../src/search/routes.ts';
import { fakeGrafana, json } from './fake-grafana.ts';

const ANCHOR = Date.UTC(2026, 10, 2, 9, 0, 0);
const S = 1000;
const M = 60 * S;
const H = 60 * M;
const DAY = 24 * H;
const { exactPan, twinPan, nonLuhnPan, maskedPan } = MOCK_SPECIAL;

const YAML = `
auth: off
defaults: { project: pay, environment: demo }
backends:
  demo: { type: mock }
  slow: { type: mock, latencyMs: 5000 }
  failing-timeout: { type: mock, fail: timeout }
  failing-limit: { type: mock, fail: limit }
  narrow: { type: mock, latencyMs: 3000, maxConcurrent: 1, queueTimeoutSeconds: 1 }
  grafana:
    type: loki-grafana
    url: https://grafana.example
    tokenEnv: THREADLINE_SEARCH_TEST_TOKEN
regional:
  phone: { countryCode: '44', nationalDigits: 10, trunkPrefix: '0' }
  patterns:
    passport: ['[A-Z]{2}\\d{7}']
    national_id: ['[A-Z]{2}\\d{6}[A-D]']
projects:
  pay:
    name: Demo Pay
    retentionDays: 30
    environments:
      demo:
        name: Демо
        backend: demo
        selector: [{ label: namespace, op: "=", value: pay }]
      demo-pr:
        name: Демо стенды
        kind: pr-stands
        backend: demo
        stand: { label: namespace, template: "pay-pr-{number}" }
      failing-timeout:
        name: Тайм-аут
        backend: failing-timeout
        selector: [{ label: namespace, op: "=", value: pay }]
      failing-limit:
        name: Лимит
        backend: failing-limit
        selector: [{ label: namespace, op: "=", value: pay }]
      slow:
        name: Медленная
        backend: slow
        selector: [{ label: namespace, op: "=", value: pay }]
      narrow:
        name: Один запрос к хранилищу
        backend: narrow
        selector: [{ label: namespace, op: "=", value: pay }]
      prod:
        name: Прод
        backend: grafana
        selector: [{ label: namespace, op: "=", value: pay }]
`;

interface Call {
  op: 'lines' | 'count';
  q: LinesQuery | CountQuery;
  signal: AbortSignal;
}

/** Имитация, которая запоминает обращения к хранилищу. */
class Counting implements LogBackend {
  readonly inner: MockBackend;
  readonly calls: Call[] = [];
  failLines: BackendError | undefined;
  constructor(inner: MockBackend) {
    this.inner = inner;
  }
  check(signal: AbortSignal): Promise<CheckInfo> {
    return this.inner.check(signal);
  }
  labelValues(label: string, scope: Matcher[], range: TimeRange, signal: AbortSignal): Promise<string[]> {
    return this.inner.labelValues(label, scope, range, signal);
  }
  queryLines(q: LinesQuery, signal: AbortSignal): Promise<LogLine[]> {
    this.calls.push({ op: 'lines', q, signal });
    if (this.failLines) return Promise.reject(this.failLines);
    return this.inner.queryLines(q, signal);
  }
  countBy(q: CountQuery, signal: AbortSignal): Promise<Record<string, number>> {
    this.calls.push({ op: 'count', q, signal });
    return this.inner.countBy(q, signal);
  }
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup(opts: { logs?: string[] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'threadline-search-'));
  await writeFile(join(dir, 'threadline.yaml'), YAML);
  const config = await loadConfig({ path: join(dir, 'threadline.yaml'), env: {} });
  const adapters: Counting[] = [];
  const backends = new Backends(config, {
    createAdapter: (id, cfg) => {
      if (cfg.type !== 'mock') return defaultAdapter(id, cfg);
      const a = new Counting(new MockBackend(cfg, { anchorMs: ANCHOR }));
      adapters.push(a);
      return a;
    },
  });
  const clock = { t: ANCHOR + S };
  const jobs = new SearchJobs({ now: () => clock.t, timer: false });
  const logger = opts.logs
    ? {
        stream: new Writable({
          write(chunk, _enc, cb) {
            opts.logs!.push(String(chunk));
            cb();
          },
        }),
      }
    : false;
  const app = await buildApp({ config, backends, logger, now: () => clock.t, jobs });
  cleanups.push(async () => {
    jobs.close();
    await app.close();
  });
  return { app, clock, calls: () => adapters.flatMap((a) => a.calls), adapters };
}

type App = FastifyInstance;

async function post(app: App, body: unknown, env = 'demo') {
  return app.inject({ method: 'POST', url: `/api/projects/pay/envs/${env}/searches`, payload: body as object });
}

async function start(app: App, terms: string[], period: object = { preset: '24h' }, extra: object = {}, env = 'demo'): Promise<SearchCreated> {
  const r = await post(app, { terms, period, ...extra }, env);
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}

async function finish(app: App, id: string): Promise<SearchState> {
  for (let i = 0; i < 500; i++) {
    const s = (await app.inject(`/api/searches/${id}`)).json() as SearchState;
    if (s.status !== 'running') return s;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('поиск не завершился');
}

async function search(app: App, terms: string[], period?: object, extra?: object): Promise<SearchState> {
  return finish(app, (await start(app, terms, period, extra)).id);
}

async function allLines(app: App, id: string): Promise<LinesPageResponse[]> {
  const pages: LinesPageResponse[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 100; i++) {
    const r = await app.inject(`/api/searches/${id}/lines${cursor ? `?cursor=${cursor}` : ''}`);
    expect(r.statusCode, r.body).toBe(200);
    const page = r.json() as LinesPageResponse;
    pages.push(page);
    if (!page.nextCursor) return pages;
    cursor = page.nextCursor;
  }
  throw new Error('страницы не кончились');
}

const errorOf = (r: { statusCode: number; json: () => unknown }) => [r.statusCode, (r.json() as { error: { code: string } }).error.code];

/** Строки набора и correlation_id запроса, в котором встречается значение. */
const dataset = generatePayDataset(ANCHOR).records.map((r) => parseLine({ tsNs: String(r.tsNs), line: r.line, labels: r.labels }));
const cidOf = (s: string) => [...new Set(dataset.filter((r) => r.line.includes(s)).map((r) => r.correlationId))];

describe('проверки до обращения к хранилищу', () => {
  it.each<[string, unknown, string]>([
    ['тело не объект', [1, 2], 'bad-request'],
    ['terms не список строк', { terms: 'abcdef', period: { preset: '6h' } }, 'bad-request'],
    ['fresh не булево', { terms: ['abcdef'], period: { preset: '6h' }, fresh: 'yes' }, 'bad-request'],
    ['шесть значений', { terms: ['abcdef', 'bb', 'cc', 'dd', 'ee', 'ff'], period: { preset: '6h' } }, 'invalid-terms'],
    ['все короткие', { terms: ['ab', 'cd'], period: { preset: '6h' } }, 'invalid-terms'],
    ['один символ', { terms: ['7', 'abcdef'], period: { preset: '6h' } }, 'invalid-terms'],
    ['кавычка', { terms: ['ab"cdef'], period: { preset: '6h' } }, 'invalid-terms'],
    ['пусто', { terms: [' '], period: { preset: '6h' } }, 'invalid-terms'],
    ['нет периода', { terms: ['abcdef'] }, 'invalid-period'],
    ['неизвестный пресет', { terms: ['abcdef'], period: { preset: '2h' } }, 'invalid-period'],
    ['длиннее 24 часов', { terms: ['abcdef'], period: { fromMs: ANCHOR - 25 * H, toMs: ANCHOR } }, 'invalid-period'],
    ['начало позже конца', { terms: ['abcdef'], period: { fromMs: ANCHOR - H, toMs: ANCHOR - 2 * H } }, 'invalid-period'],
    ['раньше срока хранения', { terms: ['abcdef'], period: { fromMs: ANCHOR - 31 * DAY, toMs: ANCHOR - 31 * DAY + H } }, 'invalid-period'],
    ['в будущем', { terms: ['abcdef'], period: { fromMs: ANCHOR + H, toMs: ANCHOR + 2 * H } }, 'invalid-period'],
    ['год 202333', { terms: ['abcdef'], period: { fromMs: 6_323_000_000_000_000, toMs: 6_323_000_000_001_000 } }, 'invalid-period'],
    ['граница как число без предела', { terms: ['abcdef'], period: { fromMs: 1e300, toMs: 2e300 } }, 'invalid-period'],
    ['стенд у обычной среды', { terms: ['abcdef'], period: { preset: '6h' }, stand: '92' }, 'bad-request'],
  ])('%s', async (_name, body, code) => {
    const { app, calls } = await setup();
    const r = await post(app, body);
    expect(errorOf(r)).toEqual([400, code]);
    expect(calls()).toHaveLength(0);
  });

  it('год 202333 в ссылке на запрос: понятный отказ, в хранилище запроса нет', async () => {
    const { app, calls } = await setup();
    const junk = 6_323_000_000_000_000;
    const r = await app.inject(`/api/projects/pay/envs/demo/requests/c1?from=${junk}&to=${junk + 1000}`);
    expect(errorOf(r)).toEqual([400, 'bad-request']);
    expect(r.json().error.details).toBe('в ссылке неверные границы запроса');
    expect(calls()).toHaveLength(0);
  });

  it('называет причину понятным текстом', async () => {
    const { app } = await setup();
    const r = await post(app, { terms: ['ab', 'cd'], period: { preset: '6h' } });
    expect(r.json().error.details).toBe('нужно хотя бы одно значение длиной от 6 символов');
    const p = await post(app, { terms: ['abcdef'], period: { fromMs: ANCHOR - 31 * DAY, toMs: ANCHOR - 31 * DAY + H } });
    expect(p.json().error.details).toContain('30 дней');
  });

  it.each([undefined, 'abc', '92"} or {x="1'])('среда стендов: стенд %s отклоняется', async (stand) => {
    const { app, calls } = await setup();
    const r = await post(app, { terms: ['abcdef'], period: { preset: '6h' }, ...(stand === undefined ? {} : { stand }) }, 'demo-pr');
    expect(errorOf(r)).toEqual([400, 'bad-request']);
    expect(calls()).toHaveLength(0);
  });

  it('неизвестная среда, неверный идентификатор, ненастроенная среда', async () => {
    const { app, calls } = await setup();
    const body = { terms: ['abcdef'], period: { preset: '6h' } };
    expect(errorOf(await post(app, body, 'nope'))).toEqual([404, 'unknown-environment']);
    expect(errorOf(await app.inject({ method: 'POST', url: '/api/projects/PAY_/envs/demo/searches', payload: body }))).toEqual([400, 'bad-request']);
    const prod = await post(app, body, 'prod');
    expect(errorOf(prod)).toEqual([409, 'not-configured']);
    expect(prod.json().error.details).toContain('THREADLINE_SEARCH_TEST_TOKEN');
    expect(calls()).toHaveLength(0);
  });

  it('неизвестное или устаревшее задание — search-expired', async () => {
    const { app } = await setup();
    for (const url of ['/api/searches/nope', '/api/searches/a%20b', '/api/searches/nope/lines', '/api/searches/nope/requests/abc']) {
      expect(errorOf(await app.inject(url)), url).toEqual([404, 'search-expired']);
    }
    expect(errorOf(await app.inject({ method: 'DELETE', url: '/api/searches/nope' }))).toEqual([404, 'search-expired']);
  });

  it('запрос по ссылке: неверный correlation_id и границы отклоняются', async () => {
    const { app, calls } = await setup();
    const base = '/api/projects/pay/envs/demo/requests';
    const ok = `from=${ANCHOR - H}&to=${ANCHOR - H + 2 * S}`;
    const cases: [string, number, string][] = [
      [`${base}/${encodeURIComponent('abc" or 1')}?${ok}`, 400, 'bad-request'],
      [`${base}/${'a'.repeat(129)}?${ok}`, 400, 'bad-request'],
      [`${base}/${'a'.repeat(128)}?${ok}`, 404, 'request-not-found'],
      [`${base}/abc%20def?${ok}`, 400, 'bad-request'],
      [`${base}/abc`, 400, 'bad-request'],
      [`${base}/abc?from=x&to=1`, 400, 'bad-request'],
      [`${base}/abc?from=${ANCHOR}&to=${ANCHOR - 1}`, 400, 'bad-request'],
      [`${base}/abc?from=${ANCHOR - 25 * H}&to=${ANCHOR}`, 400, 'bad-request'],
      [`${base}/abc?from=${ANCHOR - 31 * DAY}&to=${ANCHOR - 31 * DAY + S}`, 404, 'request-not-found'],
      [`/api/projects/pay/envs/demo-pr/requests/abc?${ok}&stand=x`, 400, 'bad-request'],
      [`/api/projects/pay/envs/prod/requests/abc?${ok}`, 409, 'not-configured'],
    ];
    for (const [url, status, code] of cases) expect(errorOf(await app.inject(url)), url).toEqual([status, code]);
    // Только допустимый correlation_id из 128 символов дошёл до хранилища.
    expect(calls()).toHaveLength(1);
  });
});

describe('поиск на синтетическом наборе', () => {
  it('находит запросы getCard, отдаёт сводки, записи запроса и хвост списка', async () => {
    const { app } = await setup();
    const s = await search(app, ['getCard']);
    expect(s).toMatchObject({ status: 'done', stage: 'done', tooMany: false, truncated: false, error: null, lines: 'unknown' });
    expect(s.period).toEqual({ fromMs: ANCHOR + S - DAY, toMs: ANCHOR + S, preset: '24h' });
    expect(s.terms).toEqual([{ display: 'getCard', kind: 'text' }]);
    expect(s.progress).toMatchObject({ chunksDone: 24, chunksTotal: 24 });
    expect(s.requestsTotal).toBe(s.found);
    expect(s.requestsTotal).toBeGreaterThanOrEqual(8);
    for (const r of s.requests) {
      expect(r).toMatchObject({ incoming: { method: 'POST', path: '/v1/cards/lookup' }, component: 'cards', kind: 'incoming', match: 'exact' });
    }
    const errors = s.requests.filter((r) => r.status === 'error');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.reasons.some((x) => x.kind === 'business' && x.text.includes('PRC-ERR-0027'))).toBe(true);

    const tail = (await app.inject(`/api/searches/${s.id}?from=2`)).json() as SearchState;
    expect(tail.requests).toEqual(s.requests.slice(2));
    expect(tail.requestsTotal).toBe(s.requestsTotal);
    expect(errorOf(await app.inject(`/api/searches/${s.id}?from=-1`))).toEqual([400, 'bad-request']);

    const cid = s.requests[0]!.correlationId;
    const d = (await app.inject(`/api/searches/${s.id}/requests/${cid}`)).json() as RequestDetail;
    expect(d.summary).toEqual(s.requests[0]);
    expect(d.records).toHaveLength(d.summary.recordCount);
    expect(d.records[0]).toMatchObject({ kind: 'incoming', offsetMs: 0 });
    expect(d.records.every((r) => r.correlationId === cid)).toBe(true);
    const response = d.records.find((r) => r.kind === 'response')!;
    expect(response.http!.pairId).not.toBeNull();
    expect(response.http!.durationMs).toBeGreaterThan(0);

    expect(errorOf(await app.inject(`/api/searches/${s.id}/requests/${encodeURIComponent('a b')}`))).toEqual([400, 'bad-request']);
    expect(errorOf(await app.inject(`/api/searches/${s.id}/requests/not-found-cid`))).toEqual([404, 'request-not-found']);
  });

  it('несколько значений: запись должна содержать все', async () => {
    const { app } = await setup();
    const one = await search(app, ['http response received']);
    const both = await search(app, ['http response received', 'PRC-ERR-0027']);
    expect(both.requestsTotal).toBeGreaterThan(0);
    expect(both.requestsTotal).toBeLessThan(one.requestsTotal);
    expect(both.requests.every((r) => r.status === 'error')).toBe(true);
  });

  it('повтор из памяти: тот же поиск, другой порядок; «Обновить» и остановленный — заново', async () => {
    const { app, clock, calls } = await setup();
    const first = await start(app, ['getCard', 'issuing']);
    await finish(app, first.id);
    const before = calls().length;
    clock.t += 20 * S;
    expect(await start(app, ['issuing', ' getCard '])).toEqual({ id: first.id, cached: true });
    expect(calls()).toHaveLength(before);
    const fresh = await start(app, ['getCard', 'issuing'], { preset: '24h' }, { fresh: true });
    expect(fresh.cached).toBe(false);
    expect(fresh.id).not.toBe(first.id);
    await finish(app, fresh.id);
    clock.t += 61 * S;
    expect((await start(app, ['getCard', 'issuing'])).cached).toBe(false);
  });

  it('остановка прерывает запросы к хранилищу, состояние — остановлен', async () => {
    const { app, calls } = await setup();
    const { id } = await start(app, ['getCard'], { preset: '6h' }, {}, 'slow');
    // Подсчёт идёт по три часа сразу: остановка прерывает все три.
    for (let i = 0; i < 100 && calls().length < 3; i++) await new Promise((r) => setTimeout(r, 5));
    const r = await app.inject({ method: 'DELETE', url: `/api/searches/${id}` });
    expect(r.statusCode).toBe(204);
    const s = (await app.inject(`/api/searches/${id}`)).json() as SearchState;
    expect(s.status).toBe('cancelled');
    for (let i = 0; i < 100 && !calls().every((c) => c.signal.aborted); i++) await new Promise((r) => setTimeout(r, 5));
    expect(calls().every((c) => c.signal.aborted)).toBe(true);
    expect(calls()).toHaveLength(3);
  });

  it('свой период с концом в будущем — до текущего момента', async () => {
    const { app } = await setup();
    const s = await search(app, ['getCard'], { fromMs: ANCHOR - 2 * H, toMs: ANCHOR + 2 * H });
    expect(s.period).toEqual({ fromMs: ANCHOR - 2 * H, toMs: ANCHOR + S, preset: null });
    expect(s.progress.chunksTotal).toBe(3);
  });

  it('стенд: поиск только в его namespace', async () => {
    const { app, calls } = await setup();
    // На стенде один запрос api: его вход — запись шлюза с сырым HTTP.
    const { id } = await start(app, ['raw_request'], { preset: '24h' }, { stand: '92' }, 'demo-pr');
    const s = await finish(app, id);
    expect(s.requestsTotal).toBe(1);
    expect(calls().every((c) => c.q.selector.some((m) => m.label === 'namespace' && m.value === 'pay-pr-92'))).toBe(true);
  });

  it('«Все записи» не запрашиваются, пока вкладку не открыли; страницы без повторов', async () => {
    const { app, calls } = await setup();
    const s = await search(app, ['getCard']);
    expect(calls().filter((c) => c.op === 'lines').every((c) => (c.q as LinesQuery).direction === 'forward')).toBe(true);
    const pages = await allLines(app, s.id);
    const backward = calls().filter((c) => c.op === 'lines' && (c.q as LinesQuery).direction === 'backward');
    expect(backward.length).toBeGreaterThan(0);
    expect(backward.every((c) => (c.q as LinesQuery).limit === 100)).toBe(true);
    const records = pages.flatMap((p) => p.records);
    expect(pages.slice(0, -1).every((p) => p.records.length === 100)).toBe(true);
    expect(new Set(records.map((r) => r.id)).size).toBe(records.length);
    expect(records.map((r) => r.tsNs)).toEqual([...records.map((r) => r.tsNs)].sort((a, b) => (BigInt(a) > BigInt(b) ? -1 : 1)));
    const expected = dataset.filter((r) => r.line.includes('getCard') && r.labels.namespace === 'pay');
    expect(records).toHaveLength(expected.length);
    expect(records.every((r) => r.offsetMs === null && r.match === null)).toBe(true);
    expect(records.filter((r) => r.http).every((r) => !r.http!.noResponse && r.http!.pairId === null)).toBe(true);

    expect(errorOf(await app.inject(`/api/searches/${s.id}/lines?cursor=%%%`))).toEqual([400, 'bad-request']);
    const outside = Buffer.from(JSON.stringify({ tsNs: String(BigInt(ANCHOR + H) * 1_000_000n), seen: [] })).toString('base64url');
    expect(errorOf(await app.inject(`/api/searches/${s.id}/lines?cursor=${outside}`))).toEqual([400, 'bad-request']);
  });

  it('пустой результат: ничего нет; «Все записи» отдаются из первой страницы без нового чтения', async () => {
    const { app, calls } = await setup();
    const s = await search(app, ['nothing-here-at-all'], { preset: '6h' });
    expect(s).toMatchObject({ status: 'done', found: 0, requestsTotal: 0, lines: 'none' });
    const before = calls().length;
    expect((await app.inject(`/api/searches/${s.id}/lines`)).json()).toEqual({ records: [], nextCursor: null });
    expect(calls()).toHaveLength(before);
  });

  it('есть только строки без correlation_id: первая страница из памяти, хранилище не читается', async () => {
    const { app, calls } = await setup();
    const s = await search(app, ['PHP Warning']);
    expect(s).toMatchObject({ status: 'done', found: 0, lines: 'some' });
    const before = calls().length;
    const first = await app.inject(`/api/searches/${s.id}/lines`);
    expect(first.statusCode, first.body).toBe(200);
    expect(calls()).toHaveLength(before);
    const [page] = await allLines(app, s.id);
    expect(page!.records).toHaveLength(1);
    expect(page!.records[0]).toMatchObject({ kind: 'text', correlationId: null });
  });

  it('отказ проверки личности в теле при HTTP 200 — ошибка с причиной из тела', async () => {
    const { app } = await setup();
    const s = await search(app, ['kyc.pay.example'], { preset: '6h' });
    expect(s.requestsTotal).toBe(1);
    const [r] = s.requests;
    expect(r).toMatchObject({ status: 'error', kind: 'incoming' });
    expect(r!.reasons).toEqual([expect.objectContaining({ kind: 'business' })]);
    expect(r!.reasons[0]!.text).toContain('BAD');
  });

  it('отправка без ответа: «ответ ещё не пришёл» в конце периода и «не найден» позже', async () => {
    const { app, clock } = await setup();
    const fresh = await search(app, ['queryCardInfo'], { preset: '15m' });
    expect(fresh.requests).toHaveLength(1);
    const r = fresh.requests[0]!;
    expect(r.status).toBe('success');
    expect(r.reasons.map((x) => x.kind)).toEqual(['pending']);
    const d = (await app.inject(`/api/searches/${fresh.id}/requests/${r.correlationId}`)).json() as RequestDetail;
    expect(d.records.find((x) => x.kind === 'send')!.http).toMatchObject({ noResponse: true, pending: true });

    clock.t = ANCHOR + 2 * M;
    const later = await search(app, ['queryCardInfo'], { preset: '15m' }, { fresh: true });
    expect(later.requests[0]!.status).toBe('error');
    expect(later.requests[0]!.reasons.map((x) => x.kind)).toEqual(['no-response']);
    const d2 = (await app.inject(`/api/searches/${later.id}/requests/${r.correlationId}`)).json() as RequestDetail;
    expect(d2.records.find((x) => x.kind === 'send')!.http).toMatchObject({ noResponse: true, pending: false });
  });

  it('по номеру карты: точное совпадение, маска — неточно, другая карта с теми же краями не попадает', async () => {
    const { app, calls } = await setup();
    const s = await search(app, [exactPan], { preset: '6h' });
    expect(s.terms).toEqual([{ display: maskedPan, kind: 'pan' }]);
    const [twinCid] = cidOf(twinPan);
    const exactCids = cidOf(exactPan);
    const [maskedCid] = cidOf(maskedPan);
    const match = Object.fromEntries(s.requests.map((r) => [r.correlationId, r.match]));
    expect(match).toEqual({ [exactCids[0]!]: 'exact', [exactCids[1]!]: 'exact', [maskedCid!]: 'inexact' });
    expect(match[twinCid!]).toBeUndefined();
    expect(s.found).toBe(4);

    const records = (await allLines(app, s.id)).flatMap((p) => p.records);
    expect(records.length).toBeGreaterThan(0);
    expect(records.some((r) => r.correlationId === twinCid)).toBe(false);
    expect(records.filter((r) => r.correlationId === maskedCid).every((r) => r.match === 'inexact')).toBe(true);
    expect(records.filter((r) => exactCids.includes(r.correlationId)).every((r) => r.match === 'exact')).toBe(true);
    expect(JSON.stringify(calls().map((c) => c.q))).not.toContain(exactPan);
  });

  it('запрос по ссылке: те же записи за окно запроса ±5 минут', async () => {
    const { app, calls } = await setup();
    const s = await search(app, ['getCard']);
    const sum = s.requests[0]!;
    const fromJob = (await app.inject(`/api/searches/${s.id}/requests/${sum.correlationId}`)).json() as RequestDetail;
    const before = calls().length;
    const r = await app.inject(`/api/projects/pay/envs/demo/requests/${sum.correlationId}?from=${sum.firstMs}&to=${sum.lastMs}`);
    expect(r.statusCode, r.body).toBe(200);
    const byLink = r.json() as RequestDetail;
    expect(byLink.records.map((x) => x.raw)).toEqual(fromJob.records.map((x) => x.raw));
    expect(byLink.summary).toMatchObject({ correlationId: sum.correlationId, recordCount: sum.recordCount, status: sum.status, match: 'exact' });
    // Одно чтение окна запроса: первая страница и продолжения с тем же фильтром.
    const reads = calls().slice(before);
    expect(reads.length).toBeGreaterThanOrEqual(1);
    expect(new Set(reads.map((r) => JSON.stringify((r.q as LinesQuery).filters))).size).toBe(1);
    const q = reads[0]!.q as LinesQuery;
    expect(q.filters).toEqual([{ kind: 'contains', value: sum.correlationId }]);
    expect(q.range).toEqual({ fromMs: sum.firstMs - 5 * M, toMs: Math.min(sum.lastMs + 5 * M, ANCHOR + S) });

    const gone = await app.inject(`/api/projects/pay/envs/demo/requests/no-such-cid?from=${sum.firstMs}&to=${sum.lastMs}`);
    expect(errorOf(gone)).toEqual([404, 'request-not-found']);
  });
});

// ---------- Маскирование ----------

const SERVICE_KEYS = new Set(['tsNs', 'id', 'pairId', 'nextCursor']);
const PAN_KEY_VALUE = /(\\*")(primaryaccountnumber|rcard|pan|cardnumber|card_number)\1\s*:\s*\1?(\d{12,19})(?!\d)/gi;
const PAN_XML = /<(?:[\w.-]+:)?(primaryaccountnumber|rcard|pan|cardnumber|card_number)(?:\s[^<>]*)?>\s*\d{12,19}\s*</gi;
const FILTER_VALUE = /(\\*")Value\1\s*:\s*\1\d{12,19}\1/g;

/** Ответ API без PAN: ни одной последовательности 15–19 цифр с Луном вне keep и ни одного немаскированного PAN-поля. */
function assertMasked(body: unknown, where: string): void {
  const keep = new Set<string>();
  JSON.stringify(body, (k, v: unknown) => {
    if ((k === 'correlationId' || k === 'requestId') && typeof v === 'string') keep.add(v);
    return v;
  });
  const text = JSON.stringify(body, (k, v: unknown) => (SERVICE_KEYS.has(k) ? undefined : v));
  for (const m of text.matchAll(/(?<!\d)\d{15,19}(?!\d)/g)) {
    expect(luhnValid(m[0]) && !keep.has(m[0]), `${where}: ${m[0]}`).toBe(false);
  }
  expect(text.match(PAN_KEY_VALUE), where).toBeNull();
  expect(text.match(PAN_XML), where).toBeNull();
  expect(text.match(FILTER_VALUE), where).toBeNull();
  for (const pan of [exactPan, twinPan, nonLuhnPan]) expect(text, where).not.toContain(pan);
}

describe('маскирование ответов', () => {
  it('на всём наборе в ответах API нет PAN и немаскированных PAN-полей', async () => {
    const { app } = await setup();
    let checked = 0;
    for (const terms of [['2026-11'], ['[GIN] 2026/11'], ['PHP Warning'], [exactPan], ['v3/cards/info'], [maskedPan]]) {
      const s = await search(app, terms);
      expect(s.status).toBe('done');
      assertMasked(s, `state ${terms[0]}`);
      for (const r of s.requests) {
        const d = (await app.inject(`/api/searches/${s.id}/requests/${r.correlationId}`)).json() as RequestDetail;
        assertMasked(d, `request ${r.correlationId}`);
        const link = await app.inject(`/api/projects/pay/envs/demo/requests/${r.correlationId}?from=${r.firstMs}&to=${r.lastMs}`);
        expect(link.statusCode).toBe(200);
        assertMasked(link.json(), `link ${r.correlationId}`);
        checked += d.records.length;
      }
      for (const page of await allLines(app, s.id)) {
        assertMasked(page, `lines ${terms[0]}`);
        checked += page.records.length;
      }
    }
    // Весь набор прошёл через ответы: дата есть во времени каждой записи JSON, строки-текст найдены своими значениями; битой строки нет.
    expect(checked).toBeGreaterThan(dataset.filter((r) => r.labels.namespace === 'pay').length);
  });

  it('PAN без проверки Луна в primaryAccountNumber замаскирован по имени поля', async () => {
    const { app } = await setup();
    const s = await search(app, ['v3/cards/info']);
    const [cid] = cidOf(nonLuhnPan);
    const d = (await app.inject(`/api/searches/${s.id}/requests/${cid}`)).json() as RequestDetail;
    const text = JSON.stringify(d);
    expect(text).not.toContain(nonLuhnPan);
    expect(text).toContain(`${nonLuhnPan.slice(0, 6)}******${nonLuhnPan.slice(-4)}`);
    expect(text).not.toMatch(/blue river|golden sun|green forest|silver moon/);
  });

  it('ошибка маскирования записи — заглушка, в журнале нет содержимого', () => {
    const errors: string[] = [];
    const rec = { id: '1-0', tsNs: '1', raw: `secret ${exactPan}`, message: exactPan } as ViewRecord;
    const out = maskRecords([rec], new Set(), { error: (m: string) => errors.push(m) } as never, () => {
      throw new Error(`boom ${exactPan}`);
    });
    expect(out[0]).toMatchObject({ id: '1-0', kind: 'raw', title: MASK_PLACEHOLDER_TITLE, raw: '', message: '', sections: { body: null } });
    expect(JSON.stringify(out)).not.toContain(exactPan);
    expect(errors).toHaveLength(1);
    expect(errors.join()).not.toContain(exactPan);
  });
});

describe('ошибки хранилища в ответах', () => {
  it('код и HTTP-статус как при проверке подключения, текст ошибки замаскирован', async () => {
    const { app, adapters } = await setup();
    const s = await search(app, ['getCard']);
    const sum = s.requests[0]!;
    for (const a of adapters) a.failLines = new BackendError('timeout', { details: 'хранилище не ответило за 30 с' });
    expect(errorOf(await app.inject(`/api/searches/${s.id}/lines`))).toEqual([504, 'timeout']);
    for (const a of adapters) a.failLines = new BackendError('unknown', { details: `Loki: parse error near ${exactPan}` });
    const r = await app.inject(`/api/projects/pay/envs/demo/requests/${sum.correlationId}?from=${sum.firstMs}&to=${sum.lastMs}`);
    expect(errorOf(r)).toEqual([502, 'unknown']);
    expect(r.body).not.toContain(exactPan);
    expect(r.json().error.details).toContain(maskedPan);
    for (const a of adapters) a.failLines = new BackendError('overloaded', { retryAfterSeconds: 15 });
    const busy = await app.inject(`/api/searches/${s.id}/lines`);
    expect(errorOf(busy)).toEqual([503, 'overloaded']);
    expect(busy.headers['retry-after']).toBe('15');
  });

  it('ошибка второго прохода видна в состоянии поиска, найденное остаётся', async () => {
    const { app, adapters } = await setup();
    for (const a of adapters) a.failLines = new BackendError('timeout', { details: `таймаут ${exactPan}` });
    const s = await search(app, ['getCard']);
    expect(s).toMatchObject({ status: 'failed', error: { code: 'timeout', stage: 'fetch' }, requestsTotal: 0 });
    expect(JSON.stringify(s)).not.toContain(exactPan);
  });
});

describe('Threadline занят', () => {
  it('лимит параллельных запросов занят, очередь не освободилась за 1 с — поиск завершён с ошибкой busy', async () => {
    const { app, calls } = await setup();
    // Первый поиск занимает единственное место: подсчёт куска идёт 3 с.
    const first = await start(app, ['getCard'], { preset: '6h' }, {}, 'narrow');
    for (let i = 0; i < 100 && calls().length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    const s = await finish(app, (await start(app, ['getCardholder'], { preset: '6h' }, {}, 'narrow')).id);
    expect(s).toMatchObject({ status: 'failed', error: { code: 'busy', stage: 'count' }, scannedFromMs: null, requestsTotal: 0 });
    expect(s.error!.details).toContain('ожидание в очереди');
    expect((await app.inject(`/api/searches/${first.id}`)).json()).toMatchObject({ status: 'running' });
    expect((await app.inject({ method: 'DELETE', url: `/api/searches/${first.id}` })).statusCode).toBe(204);
  });
});

describe('исключённые значения', () => {
  const body = (terms: string[], excludes: unknown) => ({ terms, excludes, period: { preset: '24h' } });

  it('неверные значения: тело, длина, правило 6 символов не закрывается исключением, конфликт — до хранилища', async () => {
    const { app, calls } = await setup();
    expect((await post(app, body(['getCard'], 'строка'))).statusCode).toBe(400);
    expect((await post(app, body(['getCard'], [1]))).statusCode).toBe(400);
    for (const excludes of [['x'], ['a"b'], ['aa', 'bb', 'cc', 'dd', 'ee', 'ff'], ['getCard'], ['etCard']]) {
      const r = await post(app, body(['getCard'], excludes));
      expect([r.statusCode, r.json().error.code]).toEqual([400, 'invalid-terms']);
    }
    const short = await post(app, body(['ab'], ['getCard']));
    expect([short.statusCode, short.json().error.code]).toEqual([400, 'invalid-terms']);
    expect(calls()).toHaveLength(0);
  });

  it('поиск с исключением: строк с ним нет, значение в состоянии, повтор с другим набором — новый поиск', async () => {
    const { app } = await setup();
    const plain = await finish(app, (await start(app, ['getCard'])).id);
    expect(plain.requestsTotal).toBeGreaterThan(0);
    // Значения нет в логах: результат тот же, но это другой поиск.
    const excluded = await finish(app, (await start(app, ['getCard'], { preset: '24h' }, { excludes: ['getCardX'] })).id);
    expect(excluded.requestsTotal).toBe(plain.requestsTotal);
    expect(excluded.excludes).toEqual([{ display: 'getCardX', kind: 'text' }]);
    expect(excluded.id).not.toBe(plain.id);
    // Этот текст есть в ответах SOAP: «Все записи» без таких строк, в списке нет запросов с ними.
    expect(JSON.stringify(await allLines(app, plain.id))).toContain('getCardResponse');
    const all = await finish(app, (await start(app, ['getCard'], { preset: '24h' }, { excludes: ['getCardResponse'] })).id);
    expect(JSON.stringify(await allLines(app, all.id))).not.toContain('getCardResponse');
    expect(all.requestsTotal).toBeLessThan(plain.requestsTotal);
    expect(all.excluding?.removed).toBe(true);
    for (const r of all.requests) expect((await app.inject(`/api/searches/${all.id}/requests/${r.correlationId}`)).body).not.toContain('getCardResponse');
    // Запрос из списка открывается целиком: статус и число записей те же, что в поиске без условия.
    const narrow = await finish(app, (await start(app, ['getCard'], { preset: '24h' }, { excludes: ['getBalance'] })).id);
    expect(narrow.requestsTotal).toBeGreaterThan(0);
    expect(narrow.requestsTotal).toBeLessThan(plain.requestsTotal);
    for (const r of narrow.requests) {
      const same = plain.requests.find((x) => x.correlationId === r.correlationId)!;
      expect({ status: r.status, recordCount: r.recordCount, reasons: r.reasons.length, incomplete: r.incomplete }).toEqual({ status: same.status, recordCount: same.recordCount, reasons: same.reasons.length, incomplete: same.incomplete });
    }
  });

  it('журнал: исключённых значений нет, в состоянии номер карты маской', async () => {
    const logs: string[] = [];
    const { app } = await setup({ logs });
    const s = await finish(app, (await start(app, ['getCard'], { preset: '24h' }, { excludes: [exactPan, '+44 7700 900001', 'лишнее-значение'] })).id);
    expect(s.excludes?.map((x) => x.kind)).toEqual(['pan', 'phone', 'text']);
    expect(JSON.stringify(s)).not.toContain(exactPan);
    await post(app, { terms: ['getCard'], excludes: [`${exactPan}"`], period: { preset: '6h' } });
    const all = logs.join('\n');
    for (const v of [exactPan, '7700900001', 'лишнее-значение']) expect(all).not.toContain(v);
  });

  it('в хранилище полного номера нет', async () => {
    const { app, calls } = await setup();
    await finish(app, (await start(app, ['getCard'], { preset: '6h' }, { excludes: [exactPan] })).id);
    expect(calls().length).toBeGreaterThan(0);
    expect(JSON.stringify(calls().map((c) => c.q))).not.toContain(exactPan);
  });
});

describe('журнал сервера', () => {
  it('значения поиска не попадают в журнал', async () => {
    const logs: string[] = [];
    const { app } = await setup({ logs });
    const s = await search(app, [exactPan, 'getCard']);
    for (const r of s.requests) await app.inject(`/api/searches/${s.id}/requests/${r.correlationId}`);
    await allLines(app, s.id);
    await search(app, ['tokenization callback']);
    // Битое тело и неверные значения: текст ошибки разбора содержит тело.
    await app.inject({ method: 'POST', url: '/api/projects/pay/envs/demo/searches', headers: { 'content-type': 'application/json' }, payload: `{"terms":["${twinPan}"` });
    await post(app, { terms: [`${exactPan}"`], period: { preset: '6h' } });
    const all = logs.join('\n');
    expect(all).toContain('/api/projects/:project/envs/:env/searches');
    for (const v of [exactPan, twinPan, maskedPan, 'getCard', 'tokenization callback']) expect(all).not.toContain(v);
  });
});

describe('телефон в разных написаниях', () => {
  const cids = MOCK_PHONE.spellings.map((_, i) => MOCK_PHONE.cid(i));

  it('находит все написания одним фильтром, 6 запросов подсчёта за 6 часов', async () => {
    const { app, calls } = await setup();
    const s = await search(app, ['+44 7700 900001'], { preset: '6h' });
    expect(s.terms).toEqual([{ display: MOCK_PHONE.value, kind: 'phone' }]);
    expect(s.requests.map((r) => r.correlationId).sort()).toEqual([...cids].sort());
    const counts = calls().filter((c) => c.op === 'count');
    expect(counts).toHaveLength(6);
    for (const c of counts) expect(c.q.filters).toEqual([{ kind: 'regex', pattern: '7[ ()-]{0,2}7[ ()-]{0,2}0[ ()-]{0,2}0[ ()-]{0,2}9[ ()-]{0,2}0[ ()-]{0,2}0[ ()-]{0,2}0[ ()-]{0,2}0[ ()-]{0,2}1' }]);
  });

  it('в теле записи маска, значения поиска в ответе остаются только в terms', async () => {
    const { app } = await setup();
    const s = await search(app, ['+447700900001'], { preset: '6h' });
    const i = MOCK_PHONE.spellings.indexOf('+447700900001');
    const d = (await app.inject(`/api/searches/${s.id}/requests/${MOCK_PHONE.cid(i)}`)).json() as RequestDetail;
    expect(JSON.stringify(d)).not.toContain('447700900001');
    expect(d.records[0]!.sections.body).toContain('+********0001');
    const { terms: _terms, ...rest } = (await app.inject(`/api/searches/${s.id}`)).json() as SearchState;
    expect(JSON.stringify(rest)).not.toContain('447700900001');
  });

  it('другое написание через 20 с — из памяти, значения нет в журнале', async () => {
    const logs: string[] = [];
    const { app, clock, calls } = await setup({ logs });
    const first = await start(app, ['+44 7700 900001']);
    await finish(app, first.id);
    const before = calls().length;
    clock.t += 20 * S;
    const again = await start(app, ['(7700) 900001']);
    expect(again).toEqual({ id: first.id, cached: true });
    expect(calls().length).toBe(before);
    const all = logs.join('\n');
    for (const v of ['447700900001', '7700900001', '(7700) 900001', '7700) 900']) expect(all).not.toContain(v);
  });

  it.each([
    ['failing-timeout', 'timeout'],
    ['failing-limit', 'limit'],
  ])('режим имитации %s: то же сообщение, что у любого поиска', async (env, code) => {
    const { app } = await setup();
    const phone = await finish(app, (await start(app, ['+44 7700 900001'], { preset: '6h' }, {}, env)).id);
    const text = await finish(app, (await start(app, ['getCard'], { preset: '6h' }, {}, env)).id);
    expect(phone.error?.code).toBe(code);
    expect(phone.error).toEqual(text.error);
    expect(phone.status).toBe(text.status);
  });
});

describe('ссылка «Открыть в Grafana»', () => {
  const CID = 'explore-cid-1';
  const LINE = JSON.stringify({ time: '2026-11-02T09:00:00.000000Z', level: 'info', msg: 'incoming request', correlation_id: CID, request_id: CID, request: { method: 'GET', path: '/v1/x' } });
  const TOKEN = 'explore-test-token';

  async function setupGrafana(extra = '') {
    const g = await fakeGrafana((req, res) => {
      const u = new URL(req.url ?? '', 'http://x');
      if (u.pathname === '/api/datasources/id/Loki') return json(res, 200, { id: 7 });
      if (u.pathname.endsWith('/query')) return json(res, 200, { status: 'success', data: { resultType: 'vector', result: [{ metric: { threadline_key: CID }, value: [0, '1'] }] } });
      if (u.pathname.endsWith('/query_range')) {
        const ts = BigInt(ANCHOR - S) * 1_000_000n;
        const inside = ts > BigInt(u.searchParams.get('start')!) && ts < BigInt(u.searchParams.get('end')!);
        return json(res, 200, { status: 'success', data: { resultType: 'streams', result: inside ? [{ stream: { container: 'api' }, values: [[String(ts), LINE]] }] : [] } });
      }
      return json(res, 404, { message: 'Not found' });
    });
    cleanups.push(g.close);
    const dir = await mkdtemp(join(tmpdir(), 'threadline-explore-'));
    const yaml = `
auth: off
defaults: { project: pay, environment: prod }
backends:
  demo: { type: mock }
  grafana:
    type: loki-grafana
    url: ${g.url}
    tokenEnv: T
${extra}
projects:
  pay:
    name: Demo Pay
    environments:
      prod:
        name: Прод
        backend: grafana
        selector: [{ label: namespace, op: "=", value: pay }]
`;
    await writeFile(join(dir, 'threadline.yaml'), yaml);
    const config = await loadConfig({ path: join(dir, 'threadline.yaml'), env: { T: TOKEN } });
    const clock = { t: ANCHOR + S };
    const logs: string[] = [];
    const logger = { stream: new Writable({ write(chunk, _enc, cb) { logs.push(String(chunk)); cb(); } }) };
    const jobs = new SearchJobs({ now: () => clock.t, timer: false });
    const backends = new Backends(config, { now: () => clock.t });
    const app = await buildApp({ config, backends, logger, now: () => clock.t, jobs });
    cleanups.push(async () => {
      jobs.close();
      await app.close();
    });
    return { app, g, clock, logs };
  }

  const left = (url: string) => JSON.parse(decodeURIComponent(url.slice(url.indexOf('?left=') + 6))) as { datasource: string; queries: { expr: string }[]; range: { from: string; to: string } };

  it('поиск: поле с адресом, тем же периодом и запросом; токена и лишних запросов нет', async () => {
    const { app, g, logs } = await setupGrafana();
    const before = g.requests.length;
    const created = await start(app, ['CardIssuing'], { preset: '6h' }, {}, 'prod');
    const atStart = (await app.inject(`/api/searches/${created.id}`)).json() as SearchState;
    expect(atStart.explore).toBeDefined();
    const s = await finish(app, created.id);
    const link = s.explore as { url: string; wider: boolean; typed: boolean };
    expect(link).toMatchObject({ wider: false, typed: true });
    expect(link.url.startsWith(`${g.url}/explore?left=`)).toBe(true);
    expect(left(link.url)).toEqual({
      datasource: 'Loki',
      queries: [{ refId: 'A', expr: '{namespace="pay"} |= "CardIssuing"' }],
      range: { from: String(ANCHOR + S - 6 * H), to: String(ANCHOR + S) },
    });
    // Построение ссылки идёт без сети: запросы только у самого поиска.
    expect(g.requests.slice(before).every((r) => /\/(query|query_range|api\/datasources\/id\/Loki)/.test(r.url))).toBe(true);
    expect(g.requests.some((r) => r.url.startsWith('/explore'))).toBe(false);
    const raw = (await app.inject(`/api/searches/${created.id}`)).body;
    expect(raw).not.toContain(TOKEN);
    expect(logs.join('\n')).not.toContain('explore?left');
  });

  it('исключённые значения в ссылке: `!=`, номер карты и телефон шаблоном, телефон предупреждает, что скроет больше', async () => {
    const { app } = await setupGrafana();
    const link = async (excludes: string[]) => (await finish(app, (await start(app, ['CardIssuing'], { preset: '6h' }, { excludes }, 'prod')).id)).explore as { url: string; wider: boolean; typed: boolean; narrower?: boolean };
    const text = await link(['getCard']);
    expect(left(text.url).queries[0]!.expr).toBe('{namespace="pay"} |= "CardIssuing" != "getCard"');
    expect(text).toMatchObject({ wider: false, typed: true });
    expect('narrower' in text).toBe(false);
    const pan = await link([exactPan]);
    const panExpr = left(pan.url).queries[0]!.expr;
    expect(panExpr).toContain('!~ "411111(?:');
    expect(decodeURIComponent(pan.url)).not.toContain(exactPan);
    expect('narrower' in pan).toBe(false);
    const phone = await link(['+44 7700 900001']);
    expect(left(phone.url).queries[0]!.expr).toContain('!~');
    expect(decodeURIComponent(phone.url)).not.toContain('7700900001');
    expect(phone).toMatchObject({ narrower: true });
  });

  it('исключённое значение закрывает ссылку по тем же правилам', async () => {
    const { app } = await setupGrafana();
    for (const excludes of [[`card ${exactPan}`], ['$abc'], ['password=abc']]) {
      const s = await finish(app, (await start(app, ['CardIssuing'], { preset: '6h' }, { excludes }, 'prod')).id);
      expect(s.explore).toEqual({ url: null, reason: 'unsafe' });
    }
  });

  it('значения в ссылке: телефон и номер карты шаблоном, в адресе нет ни номера, ни кода оператора', async () => {
    const { app } = await setupGrafana();
    const s = await finish(app, (await start(app, ['+44 7700 900001', exactPan], { preset: '6h' }, {}, 'prod')).id);
    const link = s.explore as { url: string; wider: boolean; typed: boolean };
    expect(link).toMatchObject({ wider: true, typed: false });
    const decoded = decodeURIComponent(link.url);
    expect(decoded).not.toContain(exactPan);
    expect(decoded).not.toContain('7700900001');
    expect(decoded).toContain('411111(?:');
  });

  it('значение, которое нельзя передать в адресе: кнопка недоступна, причина названа', async () => {
    const { app } = await setupGrafana();
    const s = await finish(app, (await start(app, ['phone=447700900001', 'CardIssuing'], { preset: '6h' }, {}, 'prod')).id);
    expect(s.explore).toEqual({ url: null, reason: 'unsafe' });
  });

  it('слишком длинный запрос: кнопка недоступна', async () => {
    const { app } = await setupGrafana();
    const long = Array.from({ length: 5 }, (_, i) => `${'ж'.repeat(990)}${i}`);
    const s = await finish(app, (await start(app, long, { preset: '6h' }, {}, 'prod')).id);
    expect(s.explore).toEqual({ url: null, reason: 'too-long' });
  });

  it('ответ из памяти отдаёт тот же адрес и тот же период', async () => {
    const { app, clock } = await setupGrafana();
    const first = await start(app, ['CardIssuing'], { preset: '6h' }, {}, 'prod');
    const a = await finish(app, first.id);
    clock.t += 20 * S;
    const again = await start(app, ['CardIssuing'], { preset: '6h' }, {}, 'prod');
    expect(again).toEqual({ id: first.id, cached: true });
    const b = await finish(app, again.id);
    expect(b.explore).toEqual(a.explore);
  });

  it('запрос: фильтр по correlation_id, окно ±5 минут, без значений поиска; из поиска и по ссылке одинаково', async () => {
    const { app, clock } = await setupGrafana();
    const s = await finish(app, (await start(app, ['CardIssuing'], { preset: '6h' }, {}, 'prod')).id);
    const fromJob = (await app.inject(`/api/searches/${s.id}/requests/${CID}`)).json() as RequestDetail;
    const link = fromJob.explore as { url: string; wider: boolean; typed: boolean };
    expect(link).toMatchObject({ wider: false, typed: false });
    const firstMs = fromJob.summary.firstMs;
    const lastMs = fromJob.summary.lastMs;
    expect(left(link.url).queries[0]!.expr).toBe(`{namespace="pay"} |= "${CID}"`);
    expect(left(link.url).range).toEqual({ from: String(firstMs - 5 * M), to: String(Math.min(lastMs + 5 * M, clock.t)) });
    const byLink = (await app.inject(`/api/projects/pay/envs/prod/requests/${CID}?from=${firstMs}&to=${lastMs}`)).json() as RequestDetail;
    expect(byLink.explore).toEqual(link);
  });

  it('правка настройки: exploreLink: false и источник числом — поля нет', async () => {
    const off = await setupGrafana('    exploreLink: false');
    const s = await finish(off.app, (await start(off.app, ['phone=447700900001', 'CardIssuing'], { preset: '6h' }, {}, 'prod')).id);
    expect(s.explore).toBeUndefined();
    const byId = await setupGrafana('    datasource: { id: 7 }');
    const t = await finish(byId.app, (await start(byId.app, ['CardIssuing'], { preset: '6h' }, {}, 'prod')).id);
    expect(t.explore).toBeUndefined();
  });

  it('publicUrl: ссылка на него, адреса нет в списке проектов', async () => {
    const { app, g } = await setupGrafana('    publicUrl: https://grafana.public.example/g/');
    const s = await finish(app, (await start(app, ['CardIssuing'], { preset: '6h' }, {}, 'prod')).id);
    expect((s.explore as { url: string }).url.startsWith('https://grafana.public.example/g/explore?left=')).toBe(true);
    expect(g.requests.length).toBeGreaterThan(0);
    const projects = (await app.inject('/api/projects')).body;
    expect(projects).not.toContain('grafana.public.example');
    expect(projects).not.toContain(g.url);
  });

  it('на имитации поля нет, в том числе при значении, которое закрыло бы ссылку', async () => {
    const { app } = await setup();
    const s = await search(app, ['phone=447700900001', 'getCard']);
    expect(s.explore).toBeUndefined();
    const found = await search(app, ['getCard']);
    const d = (await app.inject(`/api/searches/${found.id}/requests/${found.requests[0]!.correlationId}`)).json() as RequestDetail;
    expect(d.explore).toBeUndefined();
  });
});
