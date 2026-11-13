// Маска видов на выходе и показ: настоящий сервер, имитация хранилища, база в памяти.
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { BackendError } from '@threadline/core/backend';
import type { Role } from '@threadline/core/access';
import { BUILTIN_MASKING, viewerMasking, type RequestDetail, type SearchState } from '@threadline/core/search';
import { buildApp } from '../src/app.ts';
import { LOCAL_VIEWER } from '../src/auth/access.ts';
import { MOCK_PERSONAL, MOCK_SPECIAL } from '../src/backends/mock/dataset-pay.ts';
import { MockBackend } from '../src/backends/mock/index.ts';
import { Backends } from '../src/backends/registry.ts';
import { UnknownCollector } from '../src/catalog/collector.ts';
import type { CatalogService } from '../src/catalog/service.ts';
import { service } from './catalog/fixture.ts';
import { demoConfig } from './demo-regional.ts';

const V = MOCK_PERSONAL;
const OPEN_VALUES = [V.phone, V.phone2, V.address, encodeURIComponent(V.address), V.passport, V.passportNumber, V.nationalId, V.surname, V.fullName, V.holder, V.additionalInfo, V.pan, V.password, V.account, V.accountId, V.bankAccountId, V.cardToken];
/** Выключены по умолчанию: остаются как есть, пока вид не включили. */
const DEFAULT_OFF = [V.firstName, V.middleName, V.birthday, V.email];
// Значения прежних записей демо-набора, которые теперь маска: имя на карте, срок и теги.
const LEGACY = /"(?:nameOnCard|expiry|additionalInfo)":"(?!\*)/;

const ANCHOR = Date.now();
let app: FastifyInstance;
let svc: CatalogService;
let mock: MockBackend;
let calls = 0;
const logs: string[] = [];

interface RevealBody {
  records: { id: string; uri: string | null; sections: { body: string | null }; raw: string }[];
}

const as = (role: Role | undefined) => (role ? { 'x-test-role': role } : {});
const get = async <T = unknown>(url: string, role?: Role) => {
  const r = await app.inject({ url, headers: as(role) });
  return { status: r.statusCode, body: r.json() as T, text: r.body, headers: r.headers };
};
const leaks = (text: string) => OPEN_VALUES.filter((v) => text.includes(v));
const put = async (type: string, change: { enabled?: boolean; keys?: string[] }) => {
  const snap = svc.snapshot('pay')!.masking!.find((r) => r.type === type)!;
  return app.inject({ method: 'PUT', url: `/api/projects/pay/catalog/masking/${type}`, payload: { enabled: change.enabled ?? snap.enabled, keys: change.keys ?? snap.keys, updatedAt: snap.updatedAt } });
};

async function startSearch(terms: string[]): Promise<string> {
  const r = await app.inject({ method: 'POST', url: '/api/projects/pay/envs/demo/searches', payload: { terms, period: { fromMs: ANCHOR - 20 * 3_600_000, toMs: ANCHOR }, fresh: true } });
  const id = (r.json() as { id: string }).id;
  await vi.waitFor(async () => expect((await get<SearchState>(`/api/searches/${id}`)).body.status).toBe('done'), { timeout: 10_000 });
  return id;
}

let job: string;
let first: number;
let last: number;

beforeAll(async () => {
  const { config } = await demoConfig();
  mock = new MockBackend({ type: 'mock', latencyMs: 0 } as never, { anchorMs: ANCHOR });
  const query = mock.queryLines.bind(mock);
  mock.queryLines = (q, s) => {
    calls++;
    return query(q, s);
  };
  svc = service(config, 'pglite://memory');
  await svc.start();
  const stream = new Writable({
    write(chunk, _e, cb) {
      logs.push(String(chunk));
      cb();
    },
  });
  // Без заголовка роли запрос идёт как при auth: off.
  app = await buildApp({ config, backends: new Backends(config, { createAdapter: () => mock }), catalog: svc, collector: new UnknownCollector(svc), logger: { stream }, testViewer: (req) => (req.headers['x-test-role'] ? { owner: 'local', role: req.headers['x-test-role'] as Role, name: null } : LOCAL_VIEWER) });
  job = await startSearch([V.cid]);
  const { body } = await get<RequestDetail>(`/api/searches/${job}/requests/${V.cid}`);
  first = body.summary.firstMs;
  last = body.summary.lastMs;
}, 30_000);

afterAll(async () => {
  await app.close();
  await svc.close();
});

describe('маска на выходе', () => {
  it('все GET без единого значения, кроме значений поиска в terms', async () => {
    const searched = await startSearch([V.phone]);
    const state = await get<SearchState>(`/api/searches/${searched}`);
    expect(state.body.requests.some((r) => r.correlationId === V.cid)).toBe(true);
    // В поле поиска значение как введено: из него собирается «Обновить».
    expect(state.body.terms[0]!.display).toBe(V.phone);
    const { terms: _terms, ...rest } = state.body;
    expect(leaks(JSON.stringify(rest))).toEqual([]);
    const pages = [
      await get(`/api/searches/${job}/requests/${V.cid}`),
      await get(`/api/searches/${job}/lines`),
      await get(`/api/projects/pay/envs/demo/requests/${V.cid}?from=${first}&to=${last}`),
      await get('/api/projects/pay/catalog/unknown'),
      await get('/api/projects/pay/catalog'),
    ];
    for (const p of pages) {
      expect(p.status).toBe(200);
      expect(leaks(p.text)).toEqual([]);
      expect(p.headers['cache-control']).toBe('no-store');
    }
    const demo = await get(`/api/searches/${await startSearch([MOCK_SPECIAL.exactPan])}/lines`);
    expect(demo.text).not.toMatch(LEGACY);
  }, 30_000);

  it('есть что показать: только виды, без значений; имя, дата рождения и e-mail открыты, пока виды выключены', async () => {
    const { body, text } = await get<RequestDetail>(`/api/searches/${job}/requests/${V.cid}`);
    expect([...body.reveal!.kinds].sort()).toEqual(['account_number', 'address', 'card_data', 'card_token', 'national_id', 'passport', 'phone', 'surname']);
    expect(body.reveal!.stays).toEqual(['card_number', 'secrets']);
    for (const open of DEFAULT_OFF) expect(text).toContain(open);
    expect(text).toContain('+********0102');
    expect(text).toContain('*****101A');
    expect(text).toContain('****************6101');
    expect(text).toContain('************0101');
    expect(text).toContain('"card_tokens\\":[\\"***\\"]');
    expect(body.records.some((r) => r.open)).toBe(false);
  });

  it('correlation_id и id разметки открыты, сшивка работает', async () => {
    const { body } = await get<RequestDetail>(`/api/searches/${job}/requests/${V.cid}`);
    expect(body.summary.correlationId).toBe(V.cid);
    expect(body.records.every((r) => r.correlationId === V.cid)).toBe(true);
  });
});

describe('показ', () => {
  it('из задания: ноль обращений к хранилищу, открытые значения, PAN и секрет маской, форма ответа, no-store', async () => {
    const before = calls;
    const r = await get<RevealBody>(`/api/searches/${job}/requests/${V.cid}/reveal`);
    expect(calls).toBe(before);
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(Object.keys(r.body)).toEqual(['records']);
    for (const x of r.body.records) expect(Object.keys(x).sort()).toEqual(['id', 'raw', 'sections', 'uri']);
    for (const v of [V.nationalId, V.surname, V.expiry, V.holder, V.account, V.accountId, V.bankAccountId, V.cardToken]) expect(r.text).toContain(v);
    expect(r.text).not.toContain(V.pan);
    expect(r.text).not.toContain(V.password);
    expect(r.text).toContain('555555******0101');
    const detail = await get<RequestDetail>(`/api/searches/${job}/requests/${V.cid}`);
    expect(r.body.records.map((x) => x.id)).toEqual(detail.body.records.map((x) => x.id));
  });

  it('по ссылке: одно чтение, те же проверки до хранилища; «Неизвестное» не меняется', async () => {
    const start = calls;
    await get(`/api/projects/pay/envs/demo/requests/${V.cid}?from=${first}&to=${last}`);
    const page = calls - start;
    const before = calls;
    const r = await get<RevealBody>(`/api/projects/pay/envs/demo/requests/${V.cid}/reveal?from=${first}&to=${last}`);
    expect(r.status).toBe(200);
    // Одно чтение окна: столько же страниц хранилища, сколько у страницы по ссылке.
    expect(page).toBeGreaterThan(0);
    expect(calls - before).toBe(page);
    expect(r.text).toContain(V.nationalId);
    const reads = calls;
    for (const url of [`/api/projects/pay/envs/demo/requests/${encodeURIComponent('a"b')}/reveal?from=1&to=2`, `/api/projects/pay/envs/demo/requests/${'x'.repeat(129)}/reveal?from=1&to=2`, `/api/projects/pay/envs/demo/requests/${V.cid}/reveal?from=5&to=1`]) {
      expect((await get(url)).status).toBe(400);
    }
    expect(calls).toBe(reads);
  });

  it('задания нет — 404 search-expired; записей окна нет — request-not-found; ошибка и таймаут хранилища', async () => {
    const gone = await get<{ error: { code: string } }>(`/api/searches/no-such-job/requests/${V.cid}/reveal`);
    expect([gone.status, gone.body.error.code]).toEqual([404, 'search-expired']);
    const empty = await get<{ error: { code: string } }>(`/api/projects/pay/envs/demo/requests/no-such-cid/reveal?from=${first}&to=${last}`);
    expect(empty.body.error.code).toBe('request-not-found');
    for (const code of ['timeout', 'limit', 'unauthorized'] as const) {
      const query = mock.queryLines;
      mock.queryLines = () => Promise.reject(new BackendError(code, {}));
      const failed = await get<{ error: { code: string } }>(`/api/projects/pay/envs/demo/requests/${V.cid}/reveal?from=${first}&to=${last}`);
      mock.queryLines = query;
      expect(failed.body.error.code).toBe(code);
    }
  });

  it('журнал без значений и при показе', async () => {
    await get(`/api/searches/${job}/requests/${V.cid}/reveal`);
    await app.inject({ url: `/api/searches/${job}/requests/${V.cid}` });
    expect(leaks(logs.join(''))).toEqual([]);
  });
});

describe('настройка', () => {
  it('вид выключен: обычные поля с маской, значения только в open, ответ из задания без чтения; включён — снова маска', async () => {
    const before = calls;
    expect((await put('phone', { enabled: false })).statusCode).toBe(200);
    const off = await get<RequestDetail>(`/api/searches/${job}/requests/${V.cid}`);
    expect(calls).toBe(before);
    expect(off.body.reveal!.kinds).not.toContain('phone');
    const withOpen = off.body.records.filter((r) => r.open);
    expect(withOpen.length).toBeGreaterThan(0);
    expect(JSON.stringify(withOpen.map((r) => r.open))).toContain(V.phone);
    expect(JSON.stringify(withOpen.map((r) => r.open))).not.toContain(V.nationalId);
    const plain = JSON.stringify({ ...off.body, records: off.body.records.map(({ open: _o, ...r }) => r) });
    expect(leaks(plain)).toEqual([]);
    expect((await get<{ masking: Record<string, string> }>('/api/catalog')).body.masking.pay).not.toBe(BUILTIN_MASKING.stamp);

    expect((await put('phone', { enabled: true })).statusCode).toBe(200);
    const on = await get<RequestDetail>(`/api/searches/${job}/requests/${V.cid}`);
    expect(on.body.records.some((r) => r.open)).toBe(false);
    expect(leaks(on.text)).toEqual([]);
    expect(calls).toBe(before);
  });

  it('добавленное поле скрыто в следующем ответе, разметка не трогается', async () => {
    // Имя поля, которого нет ни в одном виде.
    const fresh = 'request_id';
    expect((await get<RequestDetail>(`/api/searches/${job}/requests/${V.cid}`)).text).toContain(V.accountRequestId);
    expect((await put('card_data', { keys: [fresh] })).statusCode).toBe(200);
    const masked = (await get<RequestDetail>(`/api/searches/${job}/requests/${V.cid}`)).body.records.find((r) => r.raw.includes('availableAmount'))!;
    expect(masked.raw).not.toContain(V.accountRequestId);
    expect(masked.raw).toContain('"request_id":"***"');
    expect((await put('card_data', { keys: [] })).statusCode).toBe(200);
  });

  it('значение поиска без показа: запрос найден по исходному, в теле маска; поиск по маске ничего не находит', async () => {
    const found = await startSearch([V.phone]);
    const s = await get<SearchState>(`/api/searches/${found}`);
    expect(s.body.requests.map((r) => r.correlationId)).toContain(V.cid);
    const none = await startSearch(['********0101']);
    expect((await get<SearchState>(`/api/searches/${none}`)).body.requests).toEqual([]);
  });
});

describe('исключение прохода', () => {
  it('первый проход и проход по видам упали — заглушка на странице', async () => {
    const { maskRecords, kindRecords, MASK_PLACEHOLDER_TITLE } = await import('../src/search/routes.ts');
    const log = { error: () => undefined };
    const r = { id: '1-0', tsNs: '1', timeMs: 1, offsetMs: 0, kind: 'log', title: 't', message: '', level: null, isError: false, component: null, gateway: false, correlationId: null, requestId: null, http: null, sections: { headers: null, body: null, payload: null, context: null }, raw: '', match: null } as const;
    const boom = () => {
      throw new Error('x');
    };
    expect(maskRecords([{ ...r }], new Set(), log, boom)[0]!.title).toBe(MASK_PLACEHOLDER_TITLE);
    expect(kindRecords([{ ...r }], BUILTIN_MASKING, new Set(), log, boom).records[0]!.title).toBe(MASK_PLACEHOLDER_TITLE);
  });
});

const JOB_REVEAL = () => `/api/searches/${job}/requests/${V.cid}/reveal`;
const LINK_REVEAL = () => `/api/projects/pay/envs/demo/requests/${V.cid}/reveal?from=${first}&to=${last}`;

describe('зритель', () => {
  it('роль сессии; при auth: off и без сессии no-login; вошедшему без роли не открыто ничего', async () => {
    const { viewerOf } = await import('../src/search/viewer.ts');
    const req = (viewer: unknown) => ({ viewer }) as never;
    for (const role of ['business', 'support', 'developer', 'analyst', 'admin'] as const) expect(viewerOf(req({ owner: 'o', role, name: null }))).toBe(role);
    expect(viewerOf(req(LOCAL_VIEWER))).toBe('no-login');
    expect(viewerOf(req(null))).toBe('no-login');
    expect(viewerOf(req({ owner: 'o', role: null, name: null }))).toBe('business');
  });
});

describe('кто открывает: таблица по зрителям', () => {
  const KINDS_OPEN = [V.phone, V.nationalId, V.surname, V.holder, V.expiry, V.account, V.accountId, V.bankAccountId, V.cardToken];

  it.each([
    [undefined, { kinds: true, pan: false, secret: false }],
    ['support', { kinds: true, pan: true, secret: false }],
    ['developer', { kinds: true, pan: true, secret: false }],
    ['analyst', { kinds: true, pan: true, secret: true }],
    ['admin', { kinds: true, pan: true, secret: true }],
  ] as [Role | undefined, { kinds: boolean; pan: boolean; secret: boolean }][])('%s: показ из задания и по ссылке', async (role, want) => {
    const fromJob = await get<RevealBody>(JOB_REVEAL(), role);
    const reads = calls;
    const fromLink = await get<RevealBody>(LINK_REVEAL(), role);
    expect(calls).toBeGreaterThan(reads);
    for (const r of [fromJob, fromLink]) {
      expect(r.status).toBe(200);
      expect(r.headers['cache-control']).toBe('no-store');
      for (const v of KINDS_OPEN) expect(r.text.includes(v), v).toBe(want.kinds);
      expect(r.text.includes(V.pan)).toBe(want.pan);
      expect(r.text.includes(V.password)).toBe(want.secret);
      if (!want.pan) expect(r.text).toContain('555555******0101');
      if (!want.secret) expect(r.text).toContain('\\"password\\":\\"***\\"');
    }
  });

  it('Бизнесу 403 до чтения: ни задание, ни хранилище не тронуты; в его ответах нет open', async () => {
    const before = calls;
    expect((await get(JOB_REVEAL(), 'business')).status).toBe(403);
    expect((await get(LINK_REVEAL(), 'business')).status).toBe(403);
    expect(calls).toBe(before);
  });

  it('маршрута secrets и прежнего personal нет', async () => {
    for (const name of ['secrets', 'personal']) {
      expect((await app.inject(`/api/searches/${job}/requests/${V.cid}/${name}`)).statusCode, name).toBe(404);
      expect((await app.inject(`/api/projects/pay/envs/demo/requests/${V.cid}/${name}?from=${first}&to=${last}`)).statusCode, name).toBe(404);
    }
  });

  it('без нажатия у администратора номер и пароль под маской, личный номер открыт сразу и только в open', async () => {
    const r = await get<RequestDetail>(`/api/searches/${job}/requests/${V.cid}`, 'admin');
    expect(r.text).not.toContain(V.pan);
    expect(r.text).not.toContain(V.password);
    const opened = r.body.records.filter((x) => x.open);
    expect(opened.length).toBeGreaterThan(0);
    expect(JSON.stringify(opened.map((x) => x.open))).toContain(V.nationalId);
    const plain = JSON.stringify({ ...r.body, records: r.body.records.map(({ open: _o, ...x }) => x) });
    expect(plain).not.toContain(V.nationalId);
    expect(r.body.reveal!.kinds).toEqual(['card_number', 'secrets']);
    expect(r.body.reveal!.stays).toEqual([]);
  });

  it('список: поддержка видит номер и виды, не секреты; разработчик так же; без входа без номера', async () => {
    for (const role of ['support', 'developer'] as const) {
      const { body } = await get<RequestDetail>(`/api/searches/${job}/requests/${V.cid}`, role);
      expect(body.reveal!.kinds).toContain('card_number');
      expect(body.reveal!.kinds).not.toContain('secrets');
      expect(body.reveal!.stays).toEqual(['secrets']);
      expect(body.records.some((x) => x.open)).toBe(false);
    }
    const none = await get<RequestDetail>(`/api/searches/${job}/requests/${V.cid}`);
    expect(none.body.reveal!.kinds).not.toContain('card_number');
  });

  it('Все записи: аналитику открыто сразу, поддержке только маска; показа там нет', async () => {
    const support = await get(`/api/searches/${job}/lines`, 'support');
    expect(support.text).not.toContain(V.nationalId);
    const analyst = await get<{ records: RequestDetail['records'] }>(`/api/searches/${job}/lines`, 'analyst');
    const plain = JSON.stringify(analyst.body.records.map(({ open: _o, ...x }) => x));
    expect(plain).not.toContain(V.nationalId);
  });

  it('выключенный вид у поддержки открыт в open, кнопка на него не считается; настройка возвращается', async () => {
    expect((await put('national_id', { enabled: false })).statusCode).toBe(200);
    const r = await get<RequestDetail>(`/api/searches/${job}/requests/${V.cid}`, 'support');
    expect(r.body.reveal!.kinds).not.toContain('national_id');
    expect(JSON.stringify(r.body.records.map((x) => x.open))).toContain(V.nationalId);
    expect((await put('national_id', { enabled: true })).statusCode).toBe(200);
  });

  it('добавленное к секретам поле скрыто и при показе поддержки; аналитику открыто; номер рядом открыт', async () => {
    expect((await put('secrets', { keys: ['availableAmount'] })).statusCode).toBe(200);
    const support = await get<RevealBody>(JOB_REVEAL(), 'support');
    expect(support.text).toContain('\\"availableAmount\\":\\"***\\"');
    expect(support.text).toContain(V.pan);
    const analyst = await get<RevealBody>(JOB_REVEAL(), 'analyst');
    expect(analyst.text).not.toContain('\\"availableAmount\\":\\"***\\"');
    expect((await get<RequestDetail>(`/api/searches/${job}/requests/${V.cid}`, 'analyst')).body.reveal!.kinds).toContain('secrets');
    expect((await put('secrets', { keys: [] })).statusCode).toBe(200);
  });

  it('E-mail включили: маска в заголовках и теле, показ открывает; выключили: снова как есть', async () => {
    expect((await put('email', { enabled: true })).statusCode).toBe(200);
    const on = await get<RequestDetail>(`/api/searches/${job}/requests/${V.cid}`);
    expect(on.text).not.toContain(V.email);
    expect(on.text).toContain('t*****@example.com');
    expect(on.body.reveal!.kinds).toContain('email');
    expect((await get<RevealBody>(JOB_REVEAL())).text).toContain(V.email);
    expect((await put('email', { enabled: false })).statusCode).toBe(200);
    const off = await get<RequestDetail>(`/api/searches/${job}/requests/${V.cid}`);
    expect(off.text).toContain(V.email);
    expect(off.body.reveal!.kinds).not.toContain('email');
  });
});

describe('есть что показать: номер и секреты', () => {
  const PAN = '4111111234557893';
  const rec = (raw: string, body: string | null = raw) => ({ id: '1-0', tsNs: '1', timeMs: 1, offsetMs: 0, kind: 'log', title: 't', message: '', level: null, isError: false, component: null, gateway: false, correlationId: null, requestId: null, http: null, sections: { headers: null, body, payload: null, context: null }, raw, match: null }) as const;
  const kinds = async (viewer: 'support' | 'analyst' | 'no-login' | 'business', cardHidden: boolean, raw: string) => {
    const { eyeKinds } = await import('../src/search/routes.ts');
    return eyeKinds(viewerMasking(BUILTIN_MASKING, viewer), new Set(), cardHidden, [rec(raw)], new Set());
  };

  it('на странице скрыт только пароль: у поддержки и без входа список пуст, у аналитика секреты', async () => {
    const raw = `{"password":"${V.password}"}`;
    expect(await kinds('support', false, raw)).toEqual([]);
    expect(await kinds('no-login', false, raw)).toEqual([]);
    expect(await kinds('analyst', false, raw)).toEqual(['secrets']);
  });

  it('на странице скрыт только номер: у аналитика секретов в списке нет, в том числе номер числом и группами', async () => {
    for (const raw of [`{"pan":"${PAN}"}`, `{"pan":${PAN}}`, `карта ${PAN}`, '4111 1112 3455 7893', `<pan>${V.pan}</pan>`, `pan=${V.pan}`]) {
      expect(await kinds('analyst', true, raw), raw).toEqual(['card_number']);
    }
    expect(await kinds('support', true, `{"pan":"${PAN}"}`)).toEqual(['card_number']);
    expect(await kinds('no-login', true, `{"pan":"${PAN}"}`)).toEqual([]);
    expect(await kinds('business', true, `{"pan":"${PAN}"}`)).toEqual([]);
  });
});

describe('секрет сервиса в настоящем маршруте', () => {
  it('значение из окружения в ответе показа администратора заменено, номер карты рядом открыт', async () => {
    vi.stubEnv('THREADLINE_SESSION_SECRET', V.additionalInfo);
    const { config } = await demoConfig();
    const local = new MockBackend({ type: 'mock', latencyMs: 0 } as never, { anchorMs: ANCHOR });
    const server = await buildApp({ config, backends: new Backends(config, { createAdapter: () => local }), testViewer: () => ({ owner: 'o', role: 'admin', name: null }) });
    try {
      const url = `/api/projects/pay/envs/demo/requests/${V.cid}/reveal?from=${first}&to=${last}`;
      const r = await server.inject(url);
      expect(r.statusCode).toBe(200);
      expect(r.body).not.toContain(V.additionalInfo);
      expect(r.body).toContain(V.pan);
      expect(r.body).toContain(V.password);
      expect(r.body).toContain('\\"additionalInfo\\":\\"***\\"');
    } finally {
      vi.unstubAllEnvs();
      await server.close();
    }
  });
});

describe('глазок не открывает лишнего', () => {
  it('нераспознанная запись и текст: показ идёт теми же правилами', async () => {
    const { revealRecords } = await import('../src/search/routes.ts');
    const { ownSecretScrubber } = await import('../src/search/own-secrets.ts');
    const log = { error: vi.fn() };
    const raw = { id: '1-0', tsNs: '1', timeMs: 1, offsetMs: 0, kind: 'raw', title: 't', message: '', level: null, isError: false, component: null, gateway: false, correlationId: null, requestId: null, http: null, sections: { headers: null, body: null, payload: null, context: null }, raw: `не JSON pan=${V.pan} password=${V.password} national id ${V.nationalId}`, match: null } as const;
    const out = (role: 'support' | 'no-login' | 'admin') => revealRecords([raw], viewerMasking(BUILTIN_MASKING, role), new Set(), ownSecretScrubber([]), log)[0]!.raw;
    expect(out('support')).toBe(`не JSON pan=${V.pan} password=*** national id ${V.nationalId}`);
    expect(out('no-login')).toBe(`не JSON pan=555555******0101 password=*** national id ${V.nationalId}`);
    expect(out('admin')).toBe(raw.raw);
  });

  it('сбой маски: записи нет в ответе, в журнал только тип ошибки', async () => {
    const { revealRecords } = await import('../src/search/routes.ts');
    const { ownSecretScrubber } = await import('../src/search/own-secrets.ts');
    const errors: string[] = [];
    const log = { error: (m: string) => void errors.push(m) };
    const r = { id: '1-0', tsNs: '1', timeMs: 1, offsetMs: 0, kind: 'log', title: 't', message: '', level: null, isError: false, component: null, gateway: false, correlationId: null, requestId: null, http: null, sections: { headers: null, body: null, payload: null, context: null }, raw: V.pan, match: null } as const;
    const boom = () => {
      throw new RangeError(`значение ${V.pan}`);
    };
    expect(revealRecords([r], viewerMasking(BUILTIN_MASKING, 'support'), new Set(), ownSecretScrubber([]), log, boom)).toEqual([]);
    expect(errors).toEqual(['маскирование записи не удалось: RangeError']);
  });
});

describe('показ без лишнего чтения', () => {
  it('задание истекло: одно чтение окна, значения те же', async () => {
    const reads = calls;
    const r = await get<RevealBody>(LINK_REVEAL());
    expect(r.status).toBe(200);
    expect(calls).toBeGreaterThan(reads);
    expect(r.text).toContain(V.nationalId);
  });

  it('читается меньше записей, чем на странице: в ответе только прочитанные, остальные на странице остаются маской', async () => {
    const full = await get<RevealBody>(LINK_REVEAL());
    const query = mock.queryLines;
    mock.queryLines = async (q, signal) => (await query(q, signal)).filter((_, i) => i % 2 === 0);
    const r = await get<RevealBody>(LINK_REVEAL());
    mock.queryLines = query;
    expect(r.status).toBe(200);
    expect(r.body.records.length).toBeGreaterThan(0);
    expect(r.body.records.length).toBeLessThan(full.body.records.length);
  });
});

describe('секреты самого сервиса', () => {
  const TOKEN = 'SYNTHgrafanaTOKEN+0/1';
  const scrubbing = async (over: string[]) => {
    const { ownSecretScrubber } = await import('../src/search/own-secrets.ts');
    return ownSecretScrubber(over);
  };

  it.each([
    ['как есть', `x ${TOKEN} y`, 'x *** y'],
    ['percent-encoding', `x ${encodeURIComponent(TOKEN)} y`, 'x *** y'],
    ['base64', `x ${Buffer.from(TOKEN).toString('base64')} y`, 'x *** y'],
    ['после Basic как логин и пароль', `Basic ${Buffer.from(`svc:${TOKEN}`).toString('base64')}`, 'Basic ***'],
    ['Basic в %20', `Basic%20${Buffer.from(`svc:${TOKEN}`).toString('base64')}`, 'Basic%20***'],
    ['чужой Basic на месте', `Basic ${Buffer.from('svc:other').toString('base64')}`, `Basic ${Buffer.from('svc:other').toString('base64')}`],
  ])('%s', async (_n, text, want) => {
    const scrub = await scrubbing([TOKEN]);
    expect(scrub(text)).toBe(want);
  });

  it('экранирование JSON: значение с кавычкой и чертой', async () => {
    const quoted = 'a"b\\c-synthetic';
    const scrub = await scrubbing([quoted]);
    expect(scrub(JSON.stringify({ t: quoted }))).toBe('{"t":"***"}');
    expect(scrub(JSON.stringify(JSON.stringify({ t: quoted })))).toBe('"{\\"t\\":\\"***\\"}"');
  });

  it('секрета нет в окружении: подмены нет, показ работает', async () => {
    const { ownSecrets, scrubOwnSecrets, ownSecretScrubber } = await import('../src/search/own-secrets.ts');
    const none = ownSecrets({ backends: { demo: { type: 'mock' } } } as never, {});
    expect(none).toEqual([]);
    const r = { id: '1', uri: '/x', sections: { headers: null, body: 'b', payload: null, context: null }, raw: 'r' };
    expect(scrubOwnSecrets(r, ownSecretScrubber(none))).toEqual(r);
  });

  it('значения собираются из хранилищ и окружения: токен, секреты входа, пароль базы', async () => {
    const { ownSecrets } = await import('../src/search/own-secrets.ts');
    const got = ownSecrets({ backends: { g: { type: 'loki-grafana', token: TOKEN }, d: { type: 'mock' } } } as never, { THREADLINE_OIDC_CLIENT_SECRET: 'oidc-x', THREADLINE_SESSION_SECRET: 'sess-x', THREADLINE_DATABASE_URL: 'postgres://u:p%40ss-x@h/db' });
    expect(got).toEqual([TOKEN, 'oidc-x', 'sess-x', 'p%40ss-x', 'p@ss-x']);
  });

  it('поля записи и ключи: заголовки, тело, контекст, сырая запись и адрес', async () => {
    const { ownSecretScrubber, scrubOwnSecrets } = await import('../src/search/own-secrets.ts');
    const scrub = ownSecretScrubber([TOKEN]);
    const r = { id: '1', uri: `/x?t=${encodeURIComponent(TOKEN)}`, sections: { headers: { 'X-T': [TOKEN] }, body: TOKEN, payload: { [TOKEN]: 1 }, context: { n: { t: TOKEN } } }, raw: TOKEN };
    const out = scrubOwnSecrets(r, scrub);
    expect(JSON.stringify(out)).not.toContain('SYNTH');
    expect(out.uri).toBe('/x?t=***');
  });

  it('показ администратора: токен скрыт, номер карты рядом открыт', async () => {
    const { revealRecords } = await import('../src/search/routes.ts');
    const { ownSecretScrubber } = await import('../src/search/own-secrets.ts');
    const r = { id: '1-0', tsNs: '1', timeMs: 1, offsetMs: 0, kind: 'log', title: 't', message: '', level: null, isError: false, component: null, gateway: false, correlationId: null, requestId: null, http: { method: 'GET', uri: `/x?token=${encodeURIComponent(TOKEN)}`, status: null, durationMs: null, pairId: null, noResponse: false, pending: false }, sections: { headers: { Authorization: `Basic ${Buffer.from(`svc:${TOKEN}`).toString('base64')}` }, body: `{"pan":"${V.pan}","x":"${TOKEN}","password":"${V.password}"}`, payload: null, context: null }, raw: TOKEN, match: null } as const;
    const out = revealRecords([r], viewerMasking(BUILTIN_MASKING, 'admin'), new Set(), ownSecretScrubber([TOKEN]), { error: () => undefined })[0]!;
    expect(JSON.stringify(out)).not.toContain(TOKEN);
    expect(out.sections.body).toBe(`{"pan":"${V.pan}","x":"***","password":"${V.password}"}`);
    expect(out.sections.headers).toEqual({ Authorization: 'Basic ***' });
    expect(out.uri).toBe('/x?token=***');
    expect(out.raw).toBe('***');
  });
});
