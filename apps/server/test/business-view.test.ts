// Вид для Бизнеса на настоящем сервере и синтетическом наборе: все значения из ответов администратора ищутся в ответах Бизнеса.
// Главная защита от утечки: новое поле или новый путь выдачи покажет этот тест, а не проверка глазами.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Role } from '@threadline/core/access';
import type { ConnectionResponse, ProjectsResponse } from '@threadline/core';
import type { CatalogState, RequestDetail, SearchCreated, SearchState } from '@threadline/core/search';
import { DEFAULT_VIEW } from '@threadline/core/view';
import { buildApp } from '../src/app.ts';
import { generatePayDataset, MOCK_FLOW, MOCK_PERSONAL, MOCK_SPECIAL } from '../src/backends/mock/dataset-pay.ts';
import { MockBackend } from '../src/backends/mock/index.ts';
import { Backends } from '../src/backends/registry.ts';
import { UnknownCollector } from '../src/catalog/collector.ts';
import type { CatalogService } from '../src/catalog/service.ts';
import { loadConfig } from '../src/config/load.ts';
import { SearchJobs } from '../src/search/jobs.ts';
import { CATALOG_YAML, service } from './catalog/fixture.ts';
import { DEMO_REGIONAL } from './demo-regional.ts';
import { FLOW_CATALOG, flowResolver } from './operation-catalog.ts';

const ANCHOR = Date.UTC(2026, 10, 2, 9, 0, 0);
const S = 1000;

const YAML = `
auth: off
defaults: { project: pay, environment: demo }
backends:
  demo: { type: mock }
  broken: { type: mock, fail: timeout }
  grafana: { type: loki-grafana, url: 'https://grafana.example', tokenEnv: THREADLINE_TEST_NO_TOKEN }
projects:
  pay:
    name: Demo Pay
    retentionDays: 30
    environments:
      demo: { name: Демо, backend: demo, selector: [{ label: namespace, op: '=', value: pay }] }
      broken: { name: Сбой, backend: broken, selector: [{ label: namespace, op: '=', value: pay }] }
      prod: { name: Прод, backend: grafana, selector: [{ label: namespace, op: '=', value: pay }] }
${DEMO_REGIONAL}`;

let app: FastifyInstance;
let svc: CatalogService;
let jobs: SearchJobs;
let reads = 0;

const as = (role: Role) => ({ 'x-test-role': role });
const get = async <T>(url: string, role: Role): Promise<T> => {
  const r = await app.inject({ url, headers: as(role) });
  expect(r.statusCode, `${url}: ${r.body}`).toBe(200);
  return r.json() as T;
};

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'threadline-business-'));
  await writeFile(join(dir, 'threadline.yaml'), YAML);
  await mkdir(join(dir, 'catalog'));
  await writeFile(join(dir, 'catalog', 'pay.yaml'), CATALOG_YAML);
  const config = await loadConfig({ path: join(dir, 'threadline.yaml'), env: {} });
  svc = service(config, 'pglite://memory');
  await svc.start();
  const backends = new Backends(config, {
    createAdapter: (_id, cfg) => {
      const mock = new MockBackend(cfg as never, { anchorMs: ANCHOR });
      const count = mock.countBy.bind(mock);
      const lines = mock.queryLines.bind(mock);
      mock.countBy = (q, s) => (reads++, count(q, s));
      mock.queryLines = (q, s) => (reads++, lines(q, s));
      return mock;
    },
  });
  // Ссылка в интерфейс хранилища: у имитации её нет, а в ответ администратора она должна попасть.
  backends.exploreUrl = () => 'https://grafana.example/explore?left=pay';
  const clock = { t: ANCHOR + S };
  jobs = new SearchJobs({ now: () => clock.t, timer: false });
  app = await buildApp({
    config,
    backends,
    now: () => clock.t,
    jobs,
    catalog: svc,
    collector: new UnknownCollector(svc, {}),
    operationCatalog: { resolver: () => flowResolver() },
    testViewer: (req) => ({ owner: 'one-person', role: req.headers['x-test-role'] as Role, name: null }),
  });
}, 60_000);

afterAll(async () => {
  jobs.close();
  await app.close();
  await svc.close();
});

async function finish(id: string, role: Role = 'admin'): Promise<SearchState> {
  for (let i = 0; i < 2000; i++) {
    const s = await get<SearchState>(`/api/searches/${id}`, role);
    if (s.status !== 'running') return s;
    await new Promise((res) => setTimeout(res, 5));
  }
  throw new Error('поиск не завершился');
}

async function search(term: string, env = 'demo'): Promise<string> {
  const r = await app.inject({ method: 'POST', url: `/api/projects/pay/envs/${env}/searches`, headers: as('admin'), payload: { terms: [term], period: { preset: '24h' } } });
  expect(r.statusCode, r.body).toBe(200);
  return (r.json() as SearchCreated).id;
}

const dataset = generatePayDataset(ANCHOR);
const firstWith = (value: string) => Math.min(...dataset.records.filter((p) => p.line.includes(value)).map((p) => Number(p.tsNs / 1_000_000n)));

async function operation(type: string, value: string): Promise<string> {
  const r = await app.inject({ method: 'POST', url: '/api/projects/pay/envs/demo/operations', headers: as('admin'), payload: { type, values: [value], atMs: firstWith(value), window: '24h' } });
  expect(r.statusCode, r.body).toBe(200);
  return (r.json() as SearchCreated).id;
}

function leaves(v: unknown, out = new Set<string>()): Set<string> {
  if (typeof v === 'string') out.add(v);
  else if (Array.isArray(v)) for (const x of v) leaves(x, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) leaves(x, out);
  return out;
}

/** Имена действий SOAP набора: имя действия показывать можно, само тело не уходит. */
const ACTIONS = new Set(['getCard', 'getCardholder', 'getBalance']);

/** Шаблон пути, с коротким именем системы или без него. */
const TEMPLATE = /^(?:[a-z][a-z0-9_-]*)?(?:\/[a-z][a-z0-9_-]{0,40}|\/\{[a-z0-9_-]+\})+\/?$/;

/** Постоянные значения ответа: виды, состояния, коды полей. Текста из записи среди них нет. */
const CONSTANTS = new Set(['error', 'success', 'done', 'incoming', 'background', 'maybe-cached', 'exact', 'inexact', 'none', 'some', 'unknown', 'send', 'response', 'call', 'text', 'raw', 'log', 'ERROR', 'WARNING', 'INFO', 'DEBUG', 'NOTICE', 'external', 'project', 'service', 'database', 'queue', 'operation', 'path', 'query', 'request', 'status', 'start', 'callback', 'pending', 'failure', 'system', 'method', 'general', 'db', 'wait', 'flow', 'group', 'polls', 'unread', 'limit', 'segments', 'worker', 'mention', 'confirmed', 'claimed', 'http', 'business', 'level', 'no-response', 'outcome', 'phone', 'pan', 'number', 'pan-mask', 'uuid', '24h', '6h', 'background']);

/** Названия и ключи справочников тестов: их написал человек. Хосты и пути справочника сюда не входят. */
const CATALOG_TEXT = new Set(['pay', 'switch', 'processor', 'transfer', 'Карты', 'Перевод', 'Тестовый шлюз', 'Карты по токенам', 'Статус перевода', 'Процессинг-тест', 'Карта по токену', 'Карта не найдена в процессинге', 'Проверить токен карты', 'Коммутатор-тест', 'Система не ответила вовремя']);
function catalogWords(v: unknown): void {
  if (Array.isArray(v)) for (const x of v) catalogWords(x);
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (typeof x === 'string' && ['name', 'key', 'value', 'title', 'action', 'domain'].includes(k)) CATALOG_TEXT.add(x);
      else catalogWords(x);
    }
  }
}
catalogWords(FLOW_CATALOG);
/** Название потока из справочника: «система · метод»; вторая часть может быть шаблоном пути. */
const catalogText = (s: string) => s.split(' · ').every((p) => CATALOG_TEXT.has(p) || TEMPLATE.test(p));

/** Разрешённые формы значений: шаблоны путей и короткие имена систем. */
const ALLOWED_FORMS: readonly RegExp[] = [
  TEMPLATE,
];

const allowed = (s: string, extra: ReadonlySet<string>) => CONSTANTS.has(s) || ACTIONS.has(s) || catalogText(s) || extra.has(s) || ALLOWED_FORMS.some((re) => re.test(s));

/** Ключи адреса и записей из ответа администратора: они нужны ссылке и связи шагов, на экране их нет. */
function addressKeys(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) for (const x of v) addressKeys(x, out);
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (typeof x === 'string' && ['correlationId', 'cid', 'firstRecordId', 'id', 'tsNs', 'pairId'].includes(k)) out.add(x);
      else if (k === 'cids' && Array.isArray(x)) for (const c of x) out.add(String(c));
      else addressKeys(x, out);
    }
  }
  return out;
}

/**
 * Значения администратора, найденные у Бизнеса, кроме разрешённых. Сравнение подстрокой: значение могло быть вклеено в другое.
 * Число ищется только целым: Content-Length «405» внутри correlation_id «6373407940566» — совпадение, а не утечка.
 */
function leaksOf(admin: unknown, business: unknown, extra: ReadonlySet<string> = new Set()): string[] {
  const biz = [...leaves(business)];
  const keys = addressKeys(admin);
  const found = new Set<string>();
  for (const s of leaves(admin)) {
    if (s.length < 3 || keys.has(s) || allowed(s, extra)) continue;
    const whole = /^\d+$/.test(s) ? new RegExp(`(?<!\\d)${s}(?!\\d)`) : undefined;
    if (biz.some((b) => (whole ? whole.test(b) : b.includes(s)))) found.add(s);
  }
  return [...found];
}

const PERSONAL = [MOCK_PERSONAL.phone, MOCK_PERSONAL.phone2, MOCK_PERSONAL.address, MOCK_PERSONAL.passport, MOCK_PERSONAL.passportNumber, MOCK_PERSONAL.nationalId, MOCK_PERSONAL.surname, MOCK_PERSONAL.fullName, MOCK_PERSONAL.holder, MOCK_PERSONAL.additionalInfo, MOCK_PERSONAL.pan, MOCK_SPECIAL.exactPan, MOCK_SPECIAL.twinPan];

/** Что не должно быть в ответе Бизнеса ни в каком виде. */
function expectClean(business: unknown): void {
  const text = JSON.stringify(business);
  expect(text).not.toMatch(/\.example\b|grafana|\b(?:\d{1,3}\.){3}\d{1,3}\b|:\d{4,5}\//);
  expect(text).not.toMatch(/"(?:GET|POST|PUT|PATCH|DELETE)\b|HTTP \d{3}|\bPOST \/|\bGET \//);
  expect(text).not.toMatch(/pay-app-|raw_request|"explore"|"personal"|"reveal"|"open"/);
  for (const v of PERSONAL) expect(text, v).not.toContain(v);
  for (const f of ['headers', 'body', 'payload', 'context']) expect(text).not.toMatch(new RegExp(`"${f}":(?!null)`));
  expect(text).not.toMatch(/"raw":"[^"]/);
  expect(text).not.toMatch(/"message":"[^"]/);
  expect(text).not.toMatch(/"component":"/);
  expect(text).not.toMatch(/"(?:status|http)":\d/);
  expect(text).not.toMatch(/"details":/);
}

/** Значения поиска ввёл сам пользователь: только они и остаются в поле terms. */
const withoutTerms = (s: SearchState): SearchState => ({ ...s, terms: [] });

describe('сравнение с ответом администратора', () => {
  // Все запросы набора, которые находятся по этим значениям: ошибки справочника, вложенные тела, персональные данные.
  const TERMS = [MOCK_SPECIAL.exactPan, MOCK_SPECIAL.gatewayUserId, MOCK_PERSONAL.phone, MOCK_PERSONAL.nationalId];

  it.each(TERMS)('поиск %s: сводки, запрос из задания и по ссылке', async (term) => {
    const id = await search(term);
    await finish(id);
    const adminState = await get<SearchState>(`/api/searches/${id}`, 'admin');
    const bizState = await get<SearchState>(`/api/searches/${id}`, 'business');
    expect(bizState.requestsTotal).toBe(adminState.requestsTotal);
    expect(bizState.requests.map((r) => r.status)).toEqual(adminState.requests.map((r) => r.status));
    expect(bizState.terms).toEqual(adminState.terms);
    const extra = new Set(leaves(adminState.terms));
    expect(leaksOf(withoutTerms(adminState), withoutTerms(bizState), extra)).toEqual([]);
    expectClean(withoutTerms(bizState));
    expect(adminState.requests.length).toBeGreaterThan(0);

    for (const s of adminState.requests.slice(0, 12)) {
      const cid = encodeURIComponent(s.correlationId);
      const admin = await get<RequestDetail>(`/api/searches/${id}/requests/${cid}`, 'admin');
      const biz = await get<RequestDetail>(`/api/searches/${id}/requests/${cid}`, 'business');
      expect(Object.keys(biz).filter((k) => k !== 'operationKeys').sort()).toEqual(['records', 'summary']);
      expect(leaksOf(admin, biz)).toEqual([]);
      expectClean(biz);
      expect(biz.records.length).toBeGreaterThan(0);
      if (s.correlationId.startsWith('nocid:')) continue;
      const bounds = `?from=${s.firstMs}&to=${s.lastMs}`;
      const start = reads;
      const linkAdmin = await get<RequestDetail>(`/api/projects/pay/envs/demo/requests/${cid}${bounds}`, 'admin');
      const before = reads;
      const linkBiz = await get<RequestDetail>(`/api/projects/pay/envs/demo/requests/${cid}${bounds}`, 'business');
      // Лишних чтений хранилища вид для Бизнеса не добавляет.
      expect(reads - before).toBe(before - start);
      expect(leaksOf(linkAdmin, linkBiz)).toEqual([]);
      expectClean(linkBiz);
    }
  }, 60_000);

  it.each([
    ['transfer', MOCK_FLOW.transfer],
    ['payment', MOCK_FLOW.payment],
    ['payment', MOCK_FLOW.polledPayment],
  ])('операция %s %s: потоки, ход статусов, итог', async (type, value) => {
    const id = await operation(type, value);
    await finish(id);
    const admin = await get<SearchState>(`/api/searches/${id}`, 'admin');
    const biz = await get<SearchState>(`/api/searches/${id}`, 'business');
    expect(biz.operation).toBeTruthy();
    expect(admin.operation!.items.length).toBeGreaterThan(0);
    const extra = new Set([...leaves(admin.terms), ...leaves(admin.operation!.key), ...leaves(admin.operation!.extraIds)]);
    expect(leaksOf(withoutTerms(admin), withoutTerms(biz), extra)).toEqual([]);
    const clean = { ...biz, terms: [] };
    expectClean(clean);
    expect(biz.operation!.excluded).toEqual([]);
    expect(biz.operation!.unsearchedIds).toEqual([]);
    for (const item of biz.operation!.items) if (item.kind === 'flow') expect(item.role).not.toBe('mention');
    for (const t of biz.operation!.trail) expect([t.status.raw, typeof t.status.name]).toEqual(['', 'string']);
    // Поток открывается той же страницей запроса: и обычный, и сегмент без correlation_id.
    for (const item of biz.operation!.items) {
      if (item.kind !== 'flow') continue;
      expect(item.cid).not.toContain('worker');
      const detail = await get<RequestDetail>(`/api/searches/${id}/requests/${encodeURIComponent(item.cid)}`, 'business');
      expectClean(detail);
    }
  }, 60_000);

  it('сегмент без correlation_id: имени пода нет ни у кого, даже у администратора', async () => {
    const id = await operation('payment', MOCK_FLOW.payment);
    await finish(id);
    for (const role of ['admin', 'business'] as const) {
      const s = await get<SearchState>(`/api/searches/${id}`, role);
      const flows = s.operation!.items.flatMap((i) => (i.kind === 'flow' ? [i] : i.kind === 'group' ? i.flows : []));
      const nocid = flows.filter((f) => f.nocid);
      expect(nocid.length).toBeGreaterThan(0);
      for (const f of nocid) {
        expect(f.cid).toMatch(/^nocid:[0-9a-f]{12}:\d+$/);
        expect(f.cid).not.toContain(MOCK_FLOW.nocidPod);
      }
    }
  });
});

describe('причина ошибки на настоящем справочнике', () => {
  it('описанная ошибка текстом справочника, неописанная пустым текстом', async () => {
    const id = await search(MOCK_SPECIAL.exactPan);
    await finish(id);
    const biz = await get<SearchState>(`/api/searches/${id}`, 'business');
    const reasons = biz.requests.flatMap((r) => r.reasons);
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons.map((r) => r.text)).toContain('Карта не найдена в процессинге');
    for (const r of reasons) {
      expect(r.error?.raw ?? { http: null, code: null, text: null }).toEqual({ http: null, code: null, text: null });
      expect(r.error?.partnerCode ?? null).toBeNull();
      if (r.text !== '') expect(CATALOG_TEXT.has(r.text), r.text).toBe(true);
    }
  });
});

describe('закрытые маршруты', () => {
  it('показ и «Все записи» отвечают 403 до хранилища и памяти заданий', async () => {
    const id = await search(MOCK_SPECIAL.exactPan);
    const state = await finish(id);
    const cid = encodeURIComponent(state.requests[0]!.correlationId);
    const before = reads;
    const urls = [`/api/searches/${id}/lines`, `/api/searches/${id}/requests/${cid}/personal`, `/api/searches/${id}/requests/${cid}/reveal`, `/api/projects/pay/envs/demo/requests/${cid}/personal?from=1&to=2`, `/api/projects/pay/envs/demo/requests/${cid}/reveal?from=1&to=2`];
    let closed = 0;
    for (const url of urls) {
      const r = await app.inject({ url, headers: as('business') });
      // Адреса /personal у сервера нет, его 404 пропускается. Появится такой маршрут — он тоже должен ответить 403.
      if (r.statusCode === 404) continue;
      closed++;
      expect([url, r.statusCode, (r.json() as { error: { code: string } }).error.code]).toEqual([url, 403, 'forbidden']);
    }
    expect(closed).toBeGreaterThanOrEqual(3);
    expect(reads).toBe(before);
  });
});

describe('ссылка на Grafana', () => {
  it('у администратора есть, у Бизнеса поля нет ни в поиске, ни в запросе', async () => {
    const id = await search(MOCK_SPECIAL.exactPan);
    const state = await finish(id);
    expect(state.explore).toBeTruthy();
    expect((await get<SearchState>(`/api/searches/${id}`, 'business')).explore).toBeUndefined();
    const cid = encodeURIComponent(state.requests[0]!.correlationId);
    expect((await get<RequestDetail>(`/api/searches/${id}/requests/${cid}`, 'admin')).explore).toBeTruthy();
    expect((await get<RequestDetail>(`/api/searches/${id}/requests/${cid}`, 'business')).explore).toBeUndefined();
  });
});

describe('тексты ошибок', () => {
  it('ошибка хранилища в состоянии поиска: только код и время повтора', async () => {
    const id = await search(MOCK_SPECIAL.exactPan, 'broken');
    const admin = await finish(id);
    expect(admin.error?.code).toBe('timeout');
    const biz = await get<SearchState>(`/api/searches/${id}`, 'business');
    expect(biz.error!.code).toBe('timeout');
    expect(Object.keys(biz.error!).filter((k) => k !== 'retryAfterSeconds').sort()).toEqual(['code', 'stage']);
  });

  it('среда не настроена: код без имени переменной и хранилища', async () => {
    const urls: [string, 'GET' | 'POST', object?][] = [
      ['/api/projects/pay/envs/prod/searches', 'POST', { terms: [MOCK_SPECIAL.exactPan], period: { preset: '6h' } }],
      [`/api/projects/pay/envs/prod/requests/cid-1?from=${ANCHOR - 1000}&to=${ANCHOR}`, 'GET'],
    ];
    for (const [url, method, payload] of urls) {
      const admin = await app.inject({ url, method, headers: as('admin'), ...(payload ? { payload } : {}) });
      expect(admin.body).toContain('THREADLINE_TEST_NO_TOKEN');
      const biz = await app.inject({ url, method, headers: as('business'), ...(payload ? { payload } : {}) });
      expect(biz.statusCode).toBe(admin.statusCode);
      expect(biz.json()).toEqual({ error: { code: 'not-configured' } });
    }
  });

  it('неверный запрос: без подробностей', async () => {
    const r = await app.inject({ url: '/api/projects/pay/envs/demo/requests/cid-1', headers: as('business') });
    expect(r.json()).toEqual({ error: { code: 'bad-request' } });
  });
});

describe('служебные ответы', () => {
  it('список проектов: нужное выбору проекта и среды, вид принудительный', async () => {
    const admin = await get<ProjectsResponse>('/api/projects', 'admin');
    expect(JSON.stringify(admin)).toContain('THREADLINE_TEST_NO_TOKEN');
    const biz = await get<ProjectsResponse>('/api/projects', 'business');
    const prod = biz.projects[0]!.environments.find((e) => e.id === 'prod')!;
    expect(prod).toEqual({ id: 'prod', name: 'Прод', kind: 'single', notConfigured: true });
    expect('hidden' in biz).toBe(false);
    expect(biz.projects[0]!.view).toMatchObject({ defaultMode: 'brief', blocks: { raw: { brief: false }, headers: { brief: false } }, columns: { cid: { brief: false } } });
    expect(biz.projects[0]!.view).not.toEqual(DEFAULT_VIEW);
  });

  it('проверка подключения: состояние и время', async () => {
    const admin = await get<ConnectionResponse>('/api/projects/pay/envs/prod/connection', 'admin');
    expect(admin.missingEnv).toBe('THREADLINE_TEST_NO_TOKEN');
    const biz = await get<ConnectionResponse>('/api/projects/pay/envs/prod/connection', 'business');
    expect(Object.keys(biz).sort()).toEqual(['checkedAt', 'status']);
    expect(biz.status).toBe('not-configured');
  });

  it('состояние справочника: только состояние, время данных и версия', async () => {
    const admin = await get<CatalogState>('/api/catalog', 'admin');
    expect(admin.masking).toBeTruthy();
    const biz = await get<CatalogState>('/api/catalog', 'business');
    expect(biz.state).toBe(admin.state);
    expect(biz.loadedAt).toBe(admin.loadedAt);
    expect(biz.message).toBeNull();
    expect(biz.masking).toBeUndefined();
    expect(biz.unknownOpen).toBeUndefined();
  });

  it('другие роли получают прежний ответ без копирования полей', async () => {
    for (const role of ['support', 'developer', 'analyst'] as const) {
      expect(await get<ProjectsResponse>('/api/projects', role)).toEqual(await get<ProjectsResponse>('/api/projects', 'admin'));
    }
  });
});
