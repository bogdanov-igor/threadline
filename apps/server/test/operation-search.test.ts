// Поиск операции на имитации: запуск, дополнение, фильтры поиска и сборка операции на сервере.
// Записи синтетические (MOCK_FLOW).
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { BackendError, type CheckInfo, type CountQuery, type LinesQuery, type LogBackend, type LogLine, type Matcher, type TimeRange } from '@threadline/core/backend';
import { annotateRecords, type Resolver } from '@threadline/core/catalog';
import type { OperationFlow, OperationGroup, OperationView } from '@threadline/core/flow';
import { BUILTIN_GET_FLAG, builtinProfile } from '@threadline/core/profile';
import { parseLine, type RequestDetail, type SearchCreated, type SearchState } from '@threadline/core/search';
import { buildApp } from '../src/app.ts';
import { countLogql } from '../src/backends/logql.ts';
import { generatePayDataset, MOCK_FLOW, type MockRecord } from '../src/backends/mock/dataset-pay.ts';
import { MockBackend } from '../src/backends/mock/index.ts';
import { Backends } from '../src/backends/registry.ts';
import { loadConfig } from '../src/config/load.ts';
import { SearchJobs, type StoredJob } from '../src/search/jobs.ts';
import { OperationJob, pickChunks } from '../src/operation/job.ts';
import { operationKey, operationWindow, parseOperationBody } from '../src/operation/routes.ts';
import { isShort, placesOf, valueIssue, valuePattern } from '../src/operation/values.ts';
import { DEMO, useRegional } from '../../../packages/core/src/search/test-regional.ts';
import { flowResolver } from './operation-catalog.ts';

const ANCHOR = Date.UTC(2026, 10, 2, 9, 0, 0);
const S = 1000;
const M = 60 * S;
const H = 60 * M;
const DAY = 24 * H;

const YAML = `
auth: off
defaults: { project: pay, environment: demo }
backends:
  demo: { type: mock }
regional:
  phone: { countryCode: '44', nationalDigits: 10, trunkPrefix: '0' }
projects:
  pay:
    name: Demo Pay
    retentionDays: 30
    environments:
      demo:
        name: Демо
        backend: demo
        selector: [{ label: namespace, op: "=", value: pay }]
      test:
        name: Тест
        backend: demo
        selector:
          - { label: namespace, op: "=", value: pay-test }
          - { label: container, op: "!=", value: pgadmin }
          - { label: app_kubernetes_io_sub_service, op: "!=", value: cron, searchOnly: true }
`;

interface Call {
  op: 'lines' | 'count';
  q: LinesQuery | CountQuery;
}

class Counting implements LogBackend {
  readonly inner: MockBackend;
  readonly calls: Call[] = [];
  failCountAt = -1;
  failLinesAt = -1;
  failLinesWhen: ((q: LinesQuery) => boolean) | null = null;
  /** Через сколько мс приходит ошибка. 0 — сразу: запросы, начатые вместе с ней, прерываются. */
  failDelayMs = 0;
  #count = 0;
  #lines = 0;
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
    this.calls.push({ op: 'lines', q });
    if (this.#lines++ === this.failLinesAt || this.failLinesWhen?.(q)) return this.#fail(new BackendError('bad-response', { details: 'имитация: ошибка пакета' }));
    return this.inner.queryLines(q, signal);
  }
  countBy(q: CountQuery, signal: AbortSignal): Promise<Record<string, number>> {
    this.calls.push({ op: 'count', q });
    if (this.#count++ === this.failCountAt) return this.#fail(new BackendError('timeout', { details: 'имитация: тайм-аут подсчёта' }));
    return this.inner.countBy(q, signal);
  }
  #fail(e: BackendError): Promise<never> {
    if (this.failDelayMs === 0) return Promise.reject(e);
    return new Promise((_, reject) => setTimeout(() => reject(e), this.failDelayMs));
  }
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup(opts: { records?: MockRecord[]; failCountAt?: number; failLinesAt?: number; failLinesWhen?: (q: LinesQuery) => boolean; failDelayMs?: number; now?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'threadline-op-'));
  await writeFile(join(dir, 'threadline.yaml'), YAML);
  const config = await loadConfig({ path: join(dir, 'threadline.yaml'), env: {} });
  const adapters: Counting[] = [];
  const backends = new Backends(config, {
    createAdapter: (_id, cfg) => {
      const mock = new MockBackend(cfg as never, { anchorMs: ANCHOR });
      if (opts.records) {
        mock.records.length = 0;
        mock.records.push(...[...opts.records].sort((a, b) => (a.tsNs < b.tsNs ? -1 : a.tsNs > b.tsNs ? 1 : 0)));
      }
      const a = new Counting(mock);
      a.failCountAt = opts.failCountAt ?? -1;
      a.failLinesAt = opts.failLinesAt ?? -1;
      a.failLinesWhen = opts.failLinesWhen ?? null;
      a.failDelayMs = opts.failDelayMs ?? 0;
      adapters.push(a);
      return a;
    },
  });
  const clock = { t: opts.now ?? ANCHOR + S };
  const catalog = { resolver: flowResolver() as Resolver | null };
  const jobs = new SearchJobs({ now: () => clock.t, timer: false });
  const app = await buildApp({ config, backends, logger: false, now: () => clock.t, jobs, operationCatalog: { resolver: () => catalog.resolver } });
  cleanups.push(async () => {
    jobs.close();
    await app.close();
  });
  return { app, clock, catalog, config, backends, jobs, calls: () => adapters.flatMap((a) => a.calls) };
}

type App = FastifyInstance;

async function postOp(app: App, body: object, env = 'demo') {
  return app.inject({ method: 'POST', url: `/api/projects/pay/envs/${env}/operations`, payload: body });
}

async function finish(app: App, id: string): Promise<SearchState> {
  for (let i = 0; i < 1000; i++) {
    const s = (await app.inject(`/api/searches/${id}`)).json() as SearchState;
    if (s.status !== 'running') return s;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('поиск операции не завершился');
}

async function operation(app: App, body: object, env = 'demo'): Promise<{ id: string; state: SearchState; op: OperationView }> {
  const r = await postOp(app, body, env);
  expect(r.statusCode, r.body).toBe(200);
  const { id } = r.json() as SearchCreated;
  const state = await finish(app, id);
  return { id, state, op: state.operation! };
}

const errorOf = (r: { statusCode: number; json: () => unknown }) => [r.statusCode, (r.json() as { error: { code: string } }).error.code];
const flows = (op: OperationView) => op.items.filter((i): i is OperationFlow => i.kind === 'flow');
const counts = (calls: Call[]) => calls.filter((c) => c.op === 'count').map((c) => c.q as CountQuery);
const lines = (calls: Call[]) => calls.filter((c) => c.op === 'lines').map((c) => c.q as LinesQuery);

const dataset = generatePayDataset(ANCHOR);
const parsed = dataset.records.map((r) => parseLine({ tsNs: String(r.tsNs), line: r.line, labels: r.labels }));
/** Время первой записи потока, где встречается значение. */
const firstWith = (value: string) => Math.min(...parsed.filter((p) => p.line.includes(value)).map((p) => p.timeMs));

describe('значения id операции', () => {
  useRegional(DEMO);

  it('проверка значения: длина, символы, номер карты, телефон', () => {
    expect(valueIssue('abc12')).toBe('short');
    expect(valueIssue('abc 123456')).toBe('format');
    expect(valueIssue('4111111234557893')).toBe('kind');
    expect(valueIssue('447700900234')).toBe('kind');
    expect(valueIssue('447700900001')).toBe('kind');
    expect(valueIssue('44-7700-900-001')).toBe('kind');
    // Местная форма — только разделители: id с такими же группами не теряется.
    expect(valueIssue('12-345-67-89')).toBeNull();
    expect(valueIssue('7700-900-001')).toBeNull();
    expect(valueIssue('07700-900-001')).toBeNull();
    expect(valueIssue(MOCK_FLOW.transfer)).toBeNull();
    expect(valueIssue(MOCK_FLOW.payoutId)).toBeNull();
  });

  it('короткие значения: не UUID и только цифры или короче 16 символов', () => {
    expect(isShort('604217')).toBe(true);
    expect(isShort('inst-2026-001')).toBe(true);
    expect(isShort(MOCK_FLOW.transfer)).toBe(false);
    expect(isShort('inst-20261101-0001')).toBe(false);
  });

  it('одно выражение на значения с экранированием: «.» совпадает только с точкой', () => {
    const p = valuePattern('a.b-c:d_e.0001xyz', placesOf(null, 'x'));
    expect(p).toBe('a\\.b-c:d_e\\.0001xyz');
    const re = new RegExp(p!);
    expect(re.test('id a.b-c:d_e.0001xyz')).toBe(true);
    expect(re.test('id aXb-c:d_eY0001xyz')).toBe(false);
  });

  it('короткое значение — только с привязкой к полю: время записи не находится, поле JSON и экранированное — находятся', () => {
    const places = placesOf(flowResolver(), 'payout');
    expect(places.fields).toEqual(['transfer_id']);
    const re = new RegExp(valuePattern('604217', places)!);
    expect(re.test('{"time":"2026-11-02T10:24:52.604217Z"}')).toBe(false);
    expect(re.test('{"transfer_id": 604217}')).toBe(true);
    expect(re.test('{\\"transfer_id\\":\\"604217\\"}')).toBe(true);
    expect(re.test('{\\\\\\"transfer_id\\\\\\":604217,')).toBe(true);
    expect(re.test('<ns:transfer_id>604217</ns:transfer_id>')).toBe(true);
    expect(re.test('{"ext_transfer_id": 604217}')).toBe(false);
    expect(re.test('{"transfer_id": 6042171}')).toBe(false);
    // На наборе: те же цифры в микросекундах времени чужой записи не находятся, ответ /v3/transfer — находится.
    const hits = dataset.records.filter((r) => re.test(r.line));
    const bare = dataset.records.filter((r) => r.line.includes('604217'));
    expect(bare.length).toBeGreaterThan(hits.length);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((r) => /transfer_id\\*":604217/.test(r.line))).toBe(true);
  });

  it('подстановка пути: короткое значение типа, который справочник ждёт в пути', () => {
    const places = placesOf(flowResolver(), 'payment');
    expect(places.path).toBe(true);
    const re = new RegExp(valuePattern('9876543', { fields: [], query: [], path: true })!);
    expect(re.test('"path":"/v1/users/u/payments/9876543/confirm"')).toBe(true);
    expect(re.test('"time":"12:00:00.9876543"')).toBe(false);
  });

  it('без поля и подстановки короткое значение не ищется', () => {
    expect(valuePattern('604217', { fields: [], query: [], path: false })).toBeNull();
  });

  it('признак входа GET: объект request и сырой HTTP шлюза, POST — нет', () => {
    const re = new RegExp(BUILTIN_GET_FLAG.replace('(?P<flag>', '(?<flag>'));
    const cards = dataset.records.find((r) => r.line.includes('incoming request') && r.line.includes(`transfers/${MOCK_FLOW.transfer}`))!;
    expect(re.test(cards.line)).toBe(true);
    const gw = dataset.records.find((r) => r.labels.container === 'gateway' && r.line.includes('"raw_request":"GET '))!;
    expect(gw).toBeDefined();
    expect(re.test(gw.line)).toBe(true);
    const gwPost = dataset.records.find((r) => r.labels.container === 'gateway' && r.line.includes('"raw_request":"POST '))!;
    expect(re.test(gwPost.line)).toBe(false);
    const post = dataset.records.find((r) => r.line.includes('incoming request') && r.line.includes('/v1/cards/lookup'))!;
    expect(re.test(post.line)).toBe(false);
  });

  it('тело запуска, окно и ключ повтора', () => {
    expect(parseOperationBody({ type: 'transfer', values: ['a'], atMs: 1, window: '6h' })).toMatchObject({ ok: false, code: 'invalid-operation' });
    expect(parseOperationBody({ type: 'transfer', values: ['abcdef', 'bcdefg', 'cdefgh', 'defghi'], atMs: 1, window: '6h' })).toMatchObject({ ok: false });
    expect(parseOperationBody({ type: 'transfer', values: ['abcdef'], atMs: 1, window: '3h' })).toMatchObject({ ok: false, code: 'bad-request' });
    expect(parseOperationBody({ type: 'transfer', values: ['abcdef'], atMs: 6_323_000_000_000_000, window: '6h' })).toMatchObject({ ok: false, code: 'bad-request' });
    expect(operationWindow(ANCHOR - 40 * M, '6h', ANCHOR, 30)).toEqual({ fromMs: ANCHOR - 40 * M - 3 * H, toMs: ANCHOR });
    expect(operationWindow(ANCHOR - 40 * DAY, '6h', ANCHOR, 30)).toBeNull();
    const k = (atMs: number) => operationKey({ project: 'pay', env: 'demo', stand: undefined, type: 't', values: ['b', 'a'], also: [], atMs, window: '6h' });
    expect(k(1)).toBe(k(1));
    expect(k(1)).not.toBe(k(2));
  });

  it('куски с обоих концов окна до предела', () => {
    const ordered = Array.from({ length: 20 }, (_, i) => i);
    const one = (c: number) => [`c${c}`];
    expect(pickChunks(ordered, one, { maxFlows: 200, maxChunks: 8 }).chunks).toEqual([0, 19, 1, 18, 2, 17, 3, 16]);
    const big = pickChunks([0], () => Array.from({ length: 250 }, (_, i) => `x${i}`), { maxFlows: 200, maxChunks: 8 });
    expect(big.cids.size).toBe(200);
  });
});

describe('поиск операции: выплата из четырёх потоков', () => {
  it('окно ±3 ч — 6 подсчётов одним выражением; роли, опросы партнёра строкой, итог по колбэку; дополнение по id выплаты', async () => {
    const { app, calls } = await setup();
    const at = firstWith(MOCK_FLOW.transfer);
    const { id, state, op } = await operation(app, { type: 'transfer', values: [MOCK_FLOW.transfer], atMs: at, window: '6h' });
    expect(state).toMatchObject({ status: 'done', error: null, tooMany: false });

    const cq = counts(calls());
    expect(cq).toHaveLength(6);
    for (const q of cq) {
      expect(q.filters).toEqual([{ kind: 'regex', pattern: MOCK_FLOW.transfer }]);
      expect(q).toMatchObject({ keepEmpty: true, flag: { regexp: BUILTIN_GET_FLAG } });
      expect(q.range.toMs - q.range.fromMs).toBeLessThanOrEqual(H);
    }
    expect(Math.min(...cq.map((q) => q.range.fromMs))).toBe(at - 3 * H);
    expect(Math.max(...cq.map((q) => q.range.toMs))).toBe(at + 3 * H);

    // Опросы партнёра не читаются: в пакетах только прочитанные потоки.
    const polls = op.items.find((i) => i.kind === 'polls');
    expect(polls).toMatchObject({ kind: 'polls', count: 6 });
    const read = new Set(state.requests.map((r) => r.correlationId));
    expect(read.size).toBe(3);
    for (const q of lines(calls())) {
      const f = (q.filters[0] as { pattern: string }).pattern;
      if (f.includes(MOCK_FLOW.transfer)) continue;
      for (const cid of f.split('|')) expect(read.has(cid.replace(/\\/g, ''))).toBe(true);
    }
    for (const q of lines(calls())) expect(q.range.toMs - q.range.fromMs).toBeLessThanOrEqual(70 * M);

    const rows = flows(op);
    expect(rows.map((r) => r.role)).toEqual(['start', 'worker', 'callback']);
    expect(rows[0]!.title).toBe('Перевод');
    expect(rows[1]!.title).toBe('Сеть выплат · Перевод');
    expect(rows[2]).toMatchObject({ title: 'Колбэк сети выплат', together: true, pauseMs: 0, callbackEarly: true });
    expect(op.outcome).toMatchObject({ kind: 'failure', basis: 'claimed', status: { value: 'failed', name: 'Отказ' } });
    expect(op.trail.find((t) => t.claimed)).toMatchObject({ status: { raw: 'error', value: 'failed' } });
    expect(op.extraIds).toEqual([{ type: 'payout', name: 'Выплата', value: MOCK_FLOW.payoutId }]);
    expect(op.key).toMatchObject({ type: 'transfer', name: 'Перевод', values: [MOCK_FLOW.transfer] });

    // Переход к потоку — из памяти задания.
    const before = calls().length;
    const d = (await app.inject(`/api/searches/${id}/requests/${rows[1]!.cid}`)).json() as RequestDetail;
    expect(d.records.some((r) => r.http?.uri?.includes('/v1/transfer_info'))).toBe(true);
    expect(calls().length).toBe(before);

    // Дополнение: одно, только по новым значениям, короткое — с привязкой к полю.
    const sup = await app.inject({ method: 'POST', url: `/api/searches/${id}/supplement`, payload: { values: [{ type: 'payout', value: MOCK_FLOW.payoutId }] } });
    expect(sup.statusCode, sup.body).toBe(200);
    const next = (sup.json() as SearchCreated).id;
    expect(next).not.toBe(id);
    const s2 = await finish(app, next);
    const supCounts = counts(calls()).slice(6);
    expect(supCounts).toHaveLength(6);
    expect((supCounts[0]!.filters[0] as { pattern: string }).pattern).toContain('transfer_id');
    expect((supCounts[0]!.filters[0] as { pattern: string }).pattern).not.toContain(MOCK_FLOW.transfer);
    const op2 = s2.operation!;
    expect(op2.supplemented).toBe(true);
    expect(op2.key.also).toEqual([{ type: 'payout', name: 'Выплата', value: MOCK_FLOW.payoutId }]);
    expect(op2.outcome).toMatchObject({ kind: 'failure', basis: 'confirmed', status: { name: 'Отклонён' } });
    expect(op2.trail.map((t) => t.status.name)).toEqual(['Захолдирован', 'Создан', 'Отказ', 'В обработке', 'Отклонён']);
    expect(op2.trail.find((t) => t.status.name === 'В обработке')!.stale).toBe(false);
    // Та же операция без also= в другой вкладке: кнопка есть, дополнение не повторяется, а отдаётся уже готовое.
    expect((await finish(app, id)).operation!.supplemented).toBe(false);
    const countsBefore = calls().length;
    const again = await app.inject({ method: 'POST', url: `/api/searches/${id}/supplement`, payload: { values: [{ type: 'payout', value: MOCK_FLOW.payoutId }] } });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toEqual({ id: next, cached: true });
    expect(calls().length).toBe(countsBefore);
    expect(errorOf(await app.inject({ method: 'POST', url: `/api/searches/${next}/supplement`, payload: { values: [{ type: 'user', value: 'user-00000001' }] } }))).toEqual([409, 'operation-supplemented']);
  });

  it('короткий id выплаты с полем в справочнике: находится фоновая отправка, а не запись с теми же цифрами во времени', async () => {
    const { app, calls } = await setup();
    const at = Math.min(...parsed.filter((p) => /transfer_id\\*":604217/.test(p.line)).map((p) => p.timeMs));
    const { op, state } = await operation(app, { type: 'payout', values: [MOCK_FLOW.payoutId], atMs: at, window: '6h' });
    expect(state.requests).toHaveLength(1);
    expect(flows(op).map((r) => r.role)).toEqual(['worker']);
    expect(op.trail.at(-1)!.status.name).toBe('Отклонён');
    expect((counts(calls())[0]!.filters[0] as { pattern: string }).pattern).toContain('"transfer_id');
  });
});

describe('поиск операции: проверки и повтор', () => {
  it('PAN и телефон — 400 без обращения к хранилищу; короткий id без поля — тоже', async () => {
    const { app, calls, catalog } = await setup();
    for (const v of ['4111111234557893', '447700900234']) {
      expect(errorOf(await postOp(app, { type: 'transfer', values: [v], atMs: ANCHOR - H, window: '6h' }))).toEqual([400, 'invalid-operation']);
    }
    expect(errorOf(await postOp(app, { type: 'transfer', values: ['ab'], atMs: ANCHOR - H, window: '6h' }))).toEqual([400, 'invalid-operation']);
    catalog.resolver = null;
    expect(errorOf(await postOp(app, { type: 'payout', values: ['604217'], atMs: ANCHOR - H, window: '6h' }))).toEqual([400, 'invalid-operation']);
    expect(calls()).toHaveLength(0);
  });

  it('окно старше срока хранения — 410 без обращения к хранилищу', async () => {
    const { app, calls } = await setup();
    expect(errorOf(await postOp(app, { type: 'transfer', values: [MOCK_FLOW.transfer], atMs: ANCHOR - 40 * DAY, window: '24h' }))).toEqual([410, 'operation-expired']);
    expect(calls()).toHaveLength(0);
  });

  it('окно упирается в текущее время; ключ повтора от момента потока: повтор с другим now — то же задание без запросов', async () => {
    const { app, calls, clock } = await setup();
    const atMs = ANCHOR - 40 * M;
    const a = await operation(app, { type: 'transfer', values: [MOCK_FLOW.transfer], atMs, window: '6h' });
    expect(a.op.window).toEqual({ fromMs: atMs - 3 * H, toMs: ANCHOR + S, preset: '6h' });
    expect(counts(calls())).toHaveLength(4);
    // Найден только открытый поток или ничего: опросов и потоков в окне нет.
    expect(a.op.items).toEqual([]);
    const n = calls().length;
    clock.t += 10 * S;
    const r = await postOp(app, { type: 'transfer', values: [MOCK_FLOW.transfer], atMs, window: '6h' });
    expect(r.json()).toEqual({ id: a.id, cached: true });
    expect(calls().length).toBe(n);
  });

  it('повторный запуск во время поиска подключается к идущему заданию', async () => {
    const { app } = await setup();
    const body = { type: 'transfer', values: [MOCK_FLOW.transfer], atMs: firstWith(MOCK_FLOW.transfer), window: '6h' };
    const one = (await postOp(app, body)).json() as SearchCreated;
    const two = (await postOp(app, body)).json() as SearchCreated;
    expect(two).toEqual({ id: one.id, cached: true });
    await finish(app, one.id);
  });
});

describe('поиск операции: фоновые потоки, чтение по кускам, маскирование', () => {
  it('платёж: записи без correlation_id по поду и паузе, сегменты под исходным correlation_id; поток двух кусков — два окна по 70 мин без повторов', async () => {
    const { app, calls } = await setup();
    const c0 = Math.min(...parsed.filter((p) => p.line.includes(MOCK_FLOW.payment) && p.correlationId !== null).map((p) => p.timeMs));
    // Граница кусков приходится на середину потока подтверждения.
    const atMs = c0 + 7 * M;
    const { id, op, state } = await operation(app, { type: 'payment', values: [MOCK_FLOW.payment], atMs, window: '6h' });
    expect(state.error).toBeNull();
    expect(op.items.map((i) => i.kind)).toEqual(['group', 'flow', 'group']);
    const [hold, confirm, retries] = op.items as [OperationGroup, OperationFlow, OperationGroup];
    expect(hold).toMatchObject({ role: 'worker', title: 'Платёжное ядро · Холд' });
    expect(hold.flows.every((f) => f.nocid && f.cid.startsWith('nocid:'))).toBe(true);
    expect(hold.cids).toHaveLength(2);
    expect(confirm).toMatchObject({ role: 'call', segment: 0, error: true });
    expect(retries).toMatchObject({ role: 'worker', title: 'Платёжное ядро · Подтверждение', failed: 1 });
    expect(retries.flows.map((f) => f.segment)).toEqual([1, 2]);
    expect(op.outcome).toMatchObject({ kind: 'success', basis: 'confirmed', status: { name: 'Подтверждён' } });

    const cid = confirm.cid;
    // Первые страницы чтения по correlation_id: продолжения страниц идут с границей в нс.
    const batchCalls = lines(calls()).filter((q) => (q.filters[0] as { pattern: string }).pattern === cid && q.range.fromNs === undefined);
    expect(batchCalls).toHaveLength(2);
    for (const q of batchCalls) expect(q.range.toMs - q.range.fromMs).toBe(70 * M);
    const d = (await app.inject(`/api/searches/${id}/requests/${cid}`)).json() as RequestDetail;
    expect(d.records).toHaveLength(parsed.filter((p) => p.correlationId === cid).length);
    expect(new Set(d.records.map((r) => r.tsNs + r.raw)).size).toBe(d.records.length);

    // Маскирование: номер карты в теле фонового потока замаскирован, поток найден по id.
    const seg = hold.flows[0]!.cid;
    const nd = await app.inject(`/api/searches/${id}/requests/${encodeURIComponent(seg)}`);
    expect(nd.statusCode, nd.body).toBe(200);
    const body = nd.body + JSON.stringify(state);
    expect(body).toContain('v1/payments/hold');
    for (const pan of dataset.pans) expect(body).not.toContain(pan);
  });

  it('джоба по трём рассрочкам: ошибку видит только операция второй, поток ведёт 3 операции', async () => {
    const { app } = await setup();
    const at = firstWith(MOCK_FLOW.installments[0]);
    const [one, two] = await Promise.all(
      [MOCK_FLOW.installments[0], MOCK_FLOW.installments[1]].map((v) => operation(app, { type: 'installment', values: [v], atMs: at, window: '6h' })),
    );
    expect(flows(one!.op)[0]).toMatchObject({ role: 'worker', ops: 3, error: false });
    expect(flows(two!.op)[0]).toMatchObject({ role: 'worker', ops: 3, error: true });
  });

  it('крон на тесте: поиск операции его находит, обычный поиск — нет; «Не ищутся записи» без кронов', async () => {
    const { app, calls } = await setup();
    const at = firstWith(MOCK_FLOW.testPayment);
    const { op } = await operation(app, { type: 'payment', values: [MOCK_FLOW.testPayment], atMs: at, window: '6h' }, 'test');
    expect(op.excluded).toEqual(['container != pgadmin']);
    expect(flows(op).map((r) => [r.role, r.title])).toEqual([
      ['call', 'Подтверждение платежа'],
      ['worker', 'Платёжное ядро · Статус платежа'],
    ]);
    const opSelector = counts(calls())[0]!.selector;
    expect(opSelector.some((m) => m.value === 'cron')).toBe(false);

    const s = await app.inject({ method: 'POST', url: '/api/projects/pay/envs/test/searches', payload: { terms: [MOCK_FLOW.testPayment], period: { preset: '24h' } } });
    const plain = await finish(app, (s.json() as SearchCreated).id);
    expect(plain.requests).toHaveLength(1);
    const last = counts(calls()).at(-1)!;
    expect(last.selector.some((m) => m.value === 'cron' && m.op === '!=')).toBe(true);
  });
});

// ---------- Синтетические строки для границ окна и пределов ----------

const iso = (ms: number) => `${new Date(Math.trunc(ms)).toISOString().slice(0, 23)}000Z`;

/** Запись встроенного формата json: время, уровень, сообщение, correlation_id, затем поля. */
function rec(ms: number, cid: string | null, msg: string, fields: Record<string, unknown>, component = 'api'): MockRecord {
  const r = { time: iso(ms), level: 'info', msg, ...(cid ? { correlation_id: cid } : {}), ...fields };
  return {
    tsNs: BigInt(Math.trunc(ms) + 2) * 1_000_000n,
    labels: { namespace: 'pay', container: component, app_kubernetes_io_component: component, pod: `${component}-pod-1` },
    line: JSON.stringify(r),
  };
}

const VALUE = 'syntheticop-000000000000001';
const CONFIRM = 'http://ledger.pay.example:8080/v1/payments/confirm';
const send = (ms: number, cid: string, body: object) => rec(ms, cid, 'http request sending', { request_id: cid, upstream: { method: 'POST', url: CONFIRM, body: JSON.stringify(body) } });
const resp = (ms: number, cid: string) => rec(ms, cid, 'http response received', { request_id: cid, upstream: { method: 'POST', url: CONFIRM, status: 200, body: '{"result":"ok"}' } });

describe('поиск операции: хвост, пределы, ошибки', () => {
  const atMs = ANCHOR - 10 * H;
  const end = atMs + 3 * H;

  it('отправка без ответа у конца окна дочитана хвостом; поток у границы и после хвоста — «записи неполные»', async () => {
    const recs: MockRecord[] = [send(end - 20 * S, 'cid-tail-a', { request_id: VALUE }), resp(end + 6 * M, 'cid-tail-a')];
    recs.push(send(end - 30 * S, 'cid-tail-b', { request_id: VALUE }));
    for (let t = end; t <= end + 40 * M; t += 30 * S) recs.push(rec(t, 'cid-tail-b', 'still working', {}));
    const { app, calls } = await setup({ records: recs });
    const { id, op } = await operation(app, { type: 'payment', values: [VALUE], atMs, window: '6h' });
    const tail = lines(calls()).filter((q) => q.range.fromMs === end + 5 * M);
    expect(tail).toHaveLength(1);
    expect(tail[0]!.range.toMs).toBe(end + 20 * M);
    const a = (await app.inject(`/api/searches/${id}/requests/cid-tail-a`)).json() as RequestDetail;
    expect(a.records.map((r) => r.kind)).toEqual(['send', 'response']);
    expect(a.summary.incomplete).toBe(false);
    const all = op.items.flatMap((i) => (i.kind === 'group' ? i.flows : i.kind === 'flow' ? [i] : []));
    const b = all.find((f) => f.cid === 'cid-tail-b')!;
    expect(b.incomplete).toBe(true);
    expect(op.outcome.partial).toBe(true);
  });

  it('больше 8 кусков — читаются края окна, середина строкой непрочитанного', async () => {
    const at = ANCHOR - 13 * H;
    const recs = Array.from({ length: 20 }, (_, i) => send(at - 12 * H + 30 * M + i * H, `cid-hour-${i}`, { request_id: VALUE }));
    const { app, calls } = await setup({ records: recs });
    const { op, state } = await operation(app, { type: 'payment', values: [VALUE], atMs: at, window: '24h' });
    expect(counts(calls())).toHaveLength(24);
    expect(state.requests).toHaveLength(8);
    const read = state.requests.map((r) => Number(r.correlationId.split('-').pop())).sort((x, y) => x - y);
    expect(read).toEqual([0, 1, 2, 3, 16, 17, 18, 19]);
    const unread = op.items.find((i) => i.kind === 'unread');
    expect(unread).toMatchObject({ kind: 'unread', count: 12, reason: 'limit' });
    expect(op.outcome.partial).toBe(true);
  });

  it('один correlation_id на всё окно: середина строкой непрочитанного, поток помечен неполным', async () => {
    const at = ANCHOR - 13 * H;
    // 288 попыток раз в 5 минут за ±12 ч под одним correlation_id: совпадения в каждом из 24 кусков.
    const recs = Array.from({ length: 288 }, (_, i) => send(at - 12 * H + i * 5 * M + 30 * S, 'cid-one', { request_id: VALUE }));
    const { app, calls } = await setup({ records: recs });
    const { op, id } = await operation(app, { type: 'payment', values: [VALUE], atMs: at, window: '24h' });
    expect(counts(calls())).toHaveLength(24);
    const unread = op.items.find((i) => i.kind === 'unread');
    expect(unread).toMatchObject({ kind: 'unread', count: 1, reason: 'limit' });
    if (unread?.kind === 'unread') {
      expect(unread.fromMs).toBeGreaterThan(at - 12 * H);
      expect(unread.toMs).toBeLessThan(at + 12 * H);
    }
    expect(op.outcome.partial).toBe(true);
    // Группа не выдаётся за непрерывную: края окна по обе стороны непрочитанной строки.
    const kinds = op.items.map((i) => i.kind);
    expect(kinds.indexOf('unread')).toBeGreaterThan(0);
    expect(kinds.indexOf('unread')).toBeLessThan(kinds.length - 1);
    const d = (await app.inject(`/api/searches/${id}/requests/cid-one`)).json() as RequestDetail;
    expect(d.summary.incomplete).toBe(true);
  });

  it('больше 200 потоков — читается 200, остальные строкой непрочитанного', async () => {
    const recs = Array.from({ length: 250 }, (_, i) => send(atMs + 10 * M + i * 100, `cid-many-${String(i).padStart(3, '0')}`, { request_id: VALUE }));
    const { app } = await setup({ records: recs });
    const { op, state } = await operation(app, { type: 'payment', values: [VALUE], atMs, window: '6h' });
    expect(state.found).toBe(250);
    expect(state.requests).toHaveLength(200);
    expect(op.items.find((i) => i.kind === 'unread')).toMatchObject({ count: 50 });
  });

  it('тайм-аут подсчёта: операция из просмотренных кусков, граница просмотра, итог по неполным данным', async () => {
    const recs = [send(end - 30 * M, 'cid-late', { request_id: VALUE }), resp(end - 29 * M, 'cid-late'), send(atMs - 2 * H, 'cid-early', { request_id: VALUE })];
    // Тайм-аут приходит позже ответов на подсчёты, начатые вместе с ним.
    const { app } = await setup({ records: recs, failCountAt: 2, failDelayMs: 50 });
    const { state, op } = await operation(app, { type: 'payment', values: [VALUE], atMs, window: '6h' });
    expect(state).toMatchObject({ status: 'failed', error: { code: 'timeout', stage: 'count' }, scannedFromMs: end - 2 * H });
    expect(flows(op).map((f) => f.cid)).toEqual(['cid-late']);
    expect(op.outcome.partial).toBe(true);
  });

  it('ошибка второго пакета чтения, когда первый прочитан: прочитанное остаётся, ошибка видна', async () => {
    const recs = [send(atMs - 2 * H, 'cid-x', { request_id: VALUE }), send(end - 30 * M, 'cid-y', { request_id: VALUE })];
    // Пакеты идут от конца окна: cid-y первый, ошибка второго приходит после его ответа.
    const { app } = await setup({ records: recs, failLinesWhen: (q) => (q.filters[0] as { pattern: string }).pattern.includes('cid-x'), failDelayMs: 50 });
    const { state, op } = await operation(app, { type: 'payment', values: [VALUE], atMs, window: '6h' });
    expect(state).toMatchObject({ status: 'failed', error: { stage: 'fetch' } });
    expect(flows(op).map((f) => f.cid)).toEqual(['cid-y']);
    expect(op.outcome.partial).toBe(true);
  });
});

describe('кэш OperationView', () => {
  it('повторный опрос без нового пакета не размечает записи заново, правка справочника — размечает', async () => {
    const { config, backends } = await setup();
    let calls = 0;
    let resolver = flowResolver(1);
    const env = config.config.projects.pay!.environments.demo!;
    const at = firstWith(MOCK_FLOW.transfer);
    const window = { fromMs: at - 3 * H, toMs: at + 3 * H };
    const pattern = MOCK_FLOW.transfer;
    const job = new OperationJob(
      'job-cache',
      'k',
      { project: 'pay', env, selector: env.selector, terms: [], period: { ...window, preset: null }, profile: builtinProfile(), limits: config.config.search },
      {
        project: 'pay',
        envId: 'demo', stand: null,
        mock: true,
        key: { type: 'transfer', values: [MOCK_FLOW.transfer], also: [] },
        search: { values: [{ type: 'transfer', value: MOCK_FLOW.transfer }], pattern },
        window: { ...window, preset: '6h' },
        excluded: [],
        flagRegexp: BUILTIN_GET_FLAG,
      },
      {
        backends,
        now: () => ANCHOR + S,
        warn: () => {},
        catalog: { resolver: () => resolver },
        annotate: (view, r) => {
          calls++;
          return annotateRecords(view, r);
        },
      },
    );
    await job.start();
    const first = job.state();
    const n = calls;
    expect(n).toBeGreaterThan(0);
    expect(first.operation!.outcome.basis).toBe('claimed');
    job.state();
    job.state();
    expect(calls).toBe(n);
    resolver = flowResolver(2);
    job.state();
    expect(calls).toBe(2 * n);
  });
});

describe('подсчёт в режиме поиска операции', () => {
  it('LogQL: без отбрасывания пустого ключа, признак входа вторым извлечением', () => {
    const q: CountQuery = {
      selector: [{ label: 'namespace', op: '=', value: 'pay' }],
      filters: [{ kind: 'regex', pattern: 'a\\.b|c' }],
      range: { fromMs: 0, toMs: H },
      key: { regexp: builtinProfile().countRegexp },
    };
    const plain = countLogql(q, 3600);
    expect(plain).toContain('| threadline_key!=""');
    const any = countLogql({ ...q, keepEmpty: true, flag: { regexp: BUILTIN_GET_FLAG } }, 3600);
    expect(any.startsWith('sum by (threadline_key, threadline_flag) (count_over_time({namespace="pay"} |~ "a\\\\.b|c"')).toBe(true);
    expect(any).toContain('(?P<threadline_flag>\\"request\\":');
    expect(any).not.toContain('threadline_key!=""');
  });

  it('имитация: пустой ключ и строки с признаком считаются отдельно', async () => {
    const recs = [
      send(ANCHOR - 2 * H, 'cid-a', { request_id: VALUE }),
      rec(ANCHOR - 2 * H + S, null, 'worker hold', { request_id: VALUE }),
      rec(ANCHOR - 2 * H + 2 * S, 'cid-poll', 'incoming request', { request: { method: 'GET', path: `/v1/x/${VALUE}` } }),
    ];
    const mock = new MockBackend({ type: 'mock', dataset: 'pay', latencyMs: 0, maxConcurrent: 4, queueTimeoutSeconds: 10, timeoutSeconds: 30 }, { anchorMs: ANCHOR });
    mock.records.length = 0;
    mock.records.push(...recs);
    const q: CountQuery = { selector: [], filters: [{ kind: 'regex', pattern: VALUE }], range: { fromMs: ANCHOR - 3 * H, toMs: ANCHOR }, key: { regexp: builtinProfile().countRegexp } };
    expect(await mock.countBy(q, AbortSignal.timeout(1000))).toEqual({ 'cid-a': 1, 'cid-poll': 1 });
    const any = await mock.countBy({ ...q, keepEmpty: true, flag: { regexp: BUILTIN_GET_FLAG } }, AbortSignal.timeout(1000));
    expect(any).toEqual({ 'cid-a': 1, '': 1, 'cid-poll\u0000flag': 1 });
  });
});

describe('синтетический набор форм потоков', () => {
  it('платёж с опросами: 40 опросов партнёра одной строкой, создание и подтверждение прочитаны', async () => {
    const { app } = await setup();
    const at = firstWith(MOCK_FLOW.polledPayment);
    const { op, state } = await operation(app, { type: 'payment', values: [MOCK_FLOW.polledPayment], atMs: at, window: '6h' });
    expect(op.items.find((i) => i.kind === 'polls')).toMatchObject({ count: 40 });
    expect(state.requests).toHaveLength(2);
    expect(flows(op).map((f) => f.role)).toEqual(['call', 'call']);
    expect(op.outcome).toMatchObject({ kind: 'success', status: { name: 'Подтверждён' } });
  });

});

describe('дополнение: другие вкладки и остановленное задание', () => {
  const body = { values: [{ type: 'payout', value: MOCK_FLOW.payoutId }] };
  const supplement = (app: App, id: string, payload: unknown = body) => app.inject({ method: 'POST', url: `/api/searches/${id}/supplement`, payload: payload as object });
  const start = async (app: App) => {
    const at = firstWith(MOCK_FLOW.transfer);
    return operation(app, { type: 'transfer', values: [MOCK_FLOW.transfer], atMs: at, window: '6h' });
  };

  it('дополнение получает область родителя: правка среды убирает и его', async () => {
    const { app, jobs } = await setup();
    const { id } = await start(app);
    const sup = (await supplement(app, id)).json() as SearchCreated;
    jobs.dropScope('pay', 'demo');
    expect(errorOf(await app.inject(`/api/searches/${sup.id}`))).toEqual([404, 'search-expired']);
  });

  it('тело проверяется до всего: неверное — 400, в том числе когда дополнение уже есть', async () => {
    const { app } = await setup();
    const { id } = await start(app);
    expect(errorOf(await supplement(app, id, { nonsense: true }))).toEqual([400, 'bad-request']);
    const first = await supplement(app, id);
    expect(first.statusCode, first.body).toBe(200);
    await finish(app, (first.json() as SearchCreated).id);
    expect(errorOf(await supplement(app, id, { nonsense: true }))).toEqual([400, 'bad-request']);
  });

  it('другие значения при живом дополнении — 409, те же — готовое', async () => {
    const { app } = await setup();
    const { id } = await start(app);
    const first = (await supplement(app, id)).json() as SearchCreated;
    await finish(app, first.id);
    expect(errorOf(await supplement(app, id, { values: [{ type: 'user', value: 'user-00000001' }] }))).toEqual([409, 'operation-supplemented']);
    expect((await supplement(app, id)).json()).toEqual({ id: first.id, cached: true });
  });

  it('упавшее дополнение не отдаётся как готовое: запускается новое', async () => {
    // Родитель считает шестью подсчётами: седьмой — первый подсчёт дополнения.
    const { app } = await setup({ failCountAt: 6 });
    const { id } = await start(app);
    const first = (await supplement(app, id)).json() as SearchCreated;
    const failed = await finish(app, first.id);
    expect(failed.error).not.toBeNull();
    const again = (await supplement(app, id)).json() as SearchCreated;
    expect(again.cached).toBe(false);
    expect(again.id).not.toBe(first.id);
    expect((await finish(app, again.id)).status).toBe('done');
  });

  it('новая вкладка после минуты: новое задание родителя получает прежнее дополнение без поиска в хранилище', async () => {
    const { app, calls } = await setup();
    const { id } = await start(app);
    const first = (await supplement(app, id)).json() as SearchCreated;
    await finish(app, first.id);
    const parent2 = (await postOp(app, { type: 'transfer', values: [MOCK_FLOW.transfer], atMs: firstWith(MOCK_FLOW.transfer), window: '6h', fresh: true })).json() as SearchCreated;
    expect(parent2.id).not.toBe(id);
    await finish(app, parent2.id);
    const before = calls().length;
    expect((await supplement(app, parent2.id)).json()).toEqual({ id: first.id, cached: true });
    expect(calls().length).toBe(before);
  });
});

describe('уход вкладки', () => {
  const body = () => ({ type: 'transfer', values: [MOCK_FLOW.transfer], atMs: firstWith(MOCK_FLOW.transfer), window: '6h' });
  const started = async (app: App) => {
    const r = await postOp(app, body());
    return (r.json() as SearchCreated).id;
  };
  const statusOf = async (app: App, id: string) => ((await app.inject(`/api/searches/${id}`)).json() as SearchState).status;

  it('другая вкладка опрашивает: задание идёт; последняя вкладка ушла — остановлено', async () => {
    const records = generatePayDataset(ANCHOR).records;
    const { app } = await setup({ records });
    const id = await started(app);
    await app.inject(`/api/searches/${id}?from=0&viewer=tab-a`);
    await app.inject(`/api/searches/${id}?from=0&viewer=tab-b`);
    expect((await app.inject({ method: 'DELETE', url: `/api/searches/${id}?leave=tab-a` })).statusCode).toBe(204);
    const after = await statusOf(app, id);
    expect(after).not.toBe('cancelled');
    if (after === 'running') {
      await app.inject({ method: 'DELETE', url: `/api/searches/${id}?leave=tab-b` });
      expect(await statusOf(app, id)).toBe('cancelled');
    }
  });

  it('явная остановка без leave останавливает при любых вкладках', async () => {
    const { app } = await setup();
    const id = await started(app);
    await app.inject(`/api/searches/${id}?from=0&viewer=tab-b`);
    await app.inject({ method: 'DELETE', url: `/api/searches/${id}` });
    expect(['cancelled', 'done']).toContain(await statusOf(app, id));
  });
});

describe('SearchJobs.leave', () => {
  const job = (id: string): StoredJob & { cancelled: number } => ({
    id,
    key: id,
    createdAt: 0,
    status: 'running',
    error: null,
    lastAccess: 0,
    lastPoll: 0,
    cancelled: 0,
    cancel() {
      this.cancelled++;
    },
  });

  it('вкладка считается открытой 3 с после опроса', () => {
    let now = 1000;
    const jobs = new SearchJobs<ReturnType<typeof job>>({ now: () => now, timer: false });
    const { job: j } = jobs.create('k', false, (id) => job(id));
    jobs.get(j.id, { poll: true, viewer: 'a' });
    jobs.get(j.id, { poll: true, viewer: 'b' });
    jobs.leave(j.id, 'a');
    expect(j.cancelled).toBe(0);
    now += 3001;
    jobs.get(j.id, { poll: true, viewer: 'c' });
    now += 3001;
    jobs.leave(j.id, 'b');
    expect(j.cancelled).toBe(1);
  });

  it('нет других вкладок — остановка сразу', () => {
    const jobs = new SearchJobs<ReturnType<typeof job>>({ now: () => 1000, timer: false });
    const { job: j } = jobs.create('k', false, (id) => job(id));
    jobs.get(j.id, { poll: true, viewer: 'a' });
    jobs.leave(j.id, 'a');
    expect(j.cancelled).toBe(1);
  });
});
