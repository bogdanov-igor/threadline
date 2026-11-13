// Встроенный профиль json: шлюз по формату записи и по метке, остальной контекст, приведение значений, выражение подсчёта
// на каждом виде записи, признак входа GET, шаги и уровни. Все значения выдуманы.
import { describe, expect, it } from 'vitest';
import type { LogLine } from '../backend/index.ts';
import { buildView, parseLine } from '../search/records.ts';
import { summarize } from '../search/status.ts';
import { API_LABELS, app, BROKEN_LINE, cardsLookup, CARDS_LABELS, GIN_TEXT, line, nsAfter, OFFSET, record } from '../search/test-fixtures.ts';
import { buildTrace, GATEWAY_LABEL } from '../search/trace.ts';
import { BUILTIN_COUNT_REGEXP, BUILTIN_GET_FLAG, builtinProfile, BUILTIN_PROFILE, profileSource } from './builtin.ts';
import { contextOwnKeys } from './compile.ts';
import { checkRe2, re2ToJs } from './regex.ts';

const CID = '5b0c1d2e-3f40-4a51-8b62-7c83d94ea5f6';
const RID = 'a1b2c3d4-e5f6-4a07-9b18-c29d3e4f5a60';
const PATH = '/v1/users/0193a0b1-c2d3-7e4f-8a5b-6c7d8e9f0a1b/cards/0193a1b2-c3d4-7e5f-9a6b-7c8d9e0f1a2b';
/** Метки пода шлюза, у которого контейнер называется иначе: контейнер server, компонент gateway. */
const PROD_GATEWAY_LABELS = { cluster: 'demo', namespace: 'pay', container: 'server', app_kubernetes_io_component: 'gateway' };
const countKey = (text: string) => re2ToJs(BUILTIN_COUNT_REGEXP).exec(text)?.groups?.cid ?? null;
const getFlag = (text: string) => re2ToJs(BUILTIN_GET_FLAG).exec(text)?.groups?.flag ?? null;

/** Запись шлюза: сырой HTTP партнёра в raw_request. */
function gateway(over: Record<string, unknown> = {}, opts: { eol?: string; labels?: Record<string, string>; local?: string; method?: string } = {}): LogLine {
  const eol = opts.eol ?? '\r\n';
  const local = opts.local ?? '2026-11-01T10:11:12.345678';
  const http = [`${opts.method ?? 'GET'} ${PATH} HTTP/1.1`, 'Host: api.pay.example', 'Authorization: Bearer ***', `X-Correlation-Id: ${CID}`, `X-Request-Id: ${RID}`].join(eol) + eol + eol;
  const gw = { time: `${local}${OFFSET}`, level: 'debug', msg: 'request received', raw_request: http, ...over };
  return { tsNs: nsAfter(local, 0), line: line(gw), labels: opts.labels ?? PROD_GATEWAY_LABELS };
}

/** Обмен api с коммутатором по тому же запросу. */
function apiExchange(): LogLine[] {
  const url = 'http://switch.pay.example:11101/v3/cards/info';
  return [
    record(app('http request sending', { request_id: RID, upstream: { method: 'POST', url, body: '{"id":"1"}' } }, '2026-11-01T10:11:12.359832', CID), API_LABELS),
    record(app('http response received', { request_id: RID, upstream: { method: 'POST', url, status: 200, body: '{"id":"1","result":{}}' } }, '2026-11-01T10:11:12.373242', CID), API_LABELS),
  ];
}

const done = { match: 'exact' as const, readEndMs: Date.parse('2026-11-01T10:20:00+05:00'), incomplete: false };
const at = '2026-11-01T10:11:12.300000';

describe('профиль json: шлюз по формату записи и по метке', () => {
  it('запись шлюза в контейнере server — шлюз, компонент запроса api, цепочка начинается со шлюза', () => {
    const gw = parseLine(gateway());
    expect(gw).toMatchObject({ kind: 'incoming', gateway: true, component: 'gateway', correlationId: CID, requestId: RID, method: 'GET', uri: PATH, level: 'DEBUG', levelNum: 100 });
    const parsed = [gw, ...apiExchange().map(parseLine)];
    expect(summarize(CID, parsed, done)).toMatchObject({ component: 'api', kind: 'incoming', incoming: { method: 'GET', path: PATH } });
    const view = buildView(parsed, { withOffsets: true });
    // Компонент записи шлюза — значение шлюза из меток, хотя контейнер называется server.
    expect(view.map((v) => [v.kind, v.component, v.gateway])).toEqual([
      ['incoming', 'gateway', true],
      ['send', 'api', false],
      ['response', 'api', false],
    ]);
    const trace = buildTrace(view);
    expect(trace.chain).toEqual([GATEWAY_LABEL, 'api', 'switch.pay.example']);
    expect(trace.steps[0]).toMatchObject({ kind: 'incoming', system: 'gateway' });
  });

  it('только запись шлюза: компонент запроса — gateway, а не контейнер server', () => {
    expect(summarize(CID, [parseLine(gateway())], done).component).toBe('gateway');
  });

  it('запись приложения из контейнера server без метки шлюза — не шлюз', () => {
    const m = parseLine(record(app('job', {}, at, CID), { container: 'server', app_kubernetes_io_component: 'server' }));
    expect(m).toMatchObject({ kind: 'log', gateway: false, component: 'server' });
  });

  it('значение шлюза важнее порядка меток, остальные компоненты берут метку контейнера', () => {
    const worker = parseLine(record(app('job', {}, at, CID), { container: 'worker', app_kubernetes_io_component: 'worker-jobs' }));
    expect(worker).toMatchObject({ gateway: false, component: 'worker' });
    const gw = parseLine(record(app('job', {}, at, CID), PROD_GATEWAY_LABELS));
    expect(gw).toMatchObject({ gateway: true, component: 'gateway' });
  });

  it('JSON Logstash, ECS и logback-json без raw_request — записи приложения, не шлюз, компонент — контейнер', () => {
    const ecs = { '@timestamp': `${at}${OFFSET}`, message: 'card blocked', 'log.level': 'info', correlation_id: CID };
    const logback = { '@timestamp': `${at}${OFFSET}`, '@version': '1', message: 'payment failed', logger_name: 'example.pay.Ledger', thread_name: 'http-1', level: 'ERROR', level_value: 40000 };
    for (const [rec, container] of [
      [ecs, 'cards'],
      [logback, 'api'],
    ] as const) {
      const r = parseLine({ tsNs: nsAfter(at, 0), line: line(rec), labels: { ...API_LABELS, container, app_kubernetes_io_component: container } });
      expect(r, container).toMatchObject({ kind: 'log', gateway: false, component: container, timeMs: Date.parse(`2026-11-01T10:11:12${OFFSET}`) + 300 });
      expect(buildView([r], { withOffsets: true })[0]).toMatchObject({ gateway: false, component: container });
    }
    expect(parseLine({ tsNs: '1', line: line(ecs), labels: CARDS_LABELS }).correlationId).toBe(CID);
    // Запись шлюза с raw_request — шлюз и в контейнере server.
    expect(parseLine(gateway()).gateway).toBe(true);
  });

  it('строка доступа [GIN]: текст, шлюз по метке компонента', () => {
    const gin = parseLine({ tsNs: nsAfter(at, 0), line: GIN_TEXT, labels: PROD_GATEWAY_LABELS });
    expect(gin).toMatchObject({ kind: 'text', gateway: true, component: 'gateway', message: GIN_TEXT });
  });

  it('метка gateway по-прежнему означает шлюз', () => {
    const m = parseLine(record(app('job', {}, at, CID), { container: 'gateway' }));
    expect(m.gateway).toBe(true);
  });
});

describe('профиль json: остальной контекст', () => {
  it('контекст — объект ctx целиком: своих ключей в нём нет', () => {
    const v = BUILTIN_PROFILE.variants[0]!;
    const own = contextOwnKeys(v.fields, v.kinds ?? [], v.when).get('rec.ctx');
    expect([...own!]).toEqual([]);
  });

  it('лишние ключи request и записи вне ctx в остальной контекст не попадают', () => {
    const r = parseLine(record(app('incoming request', { request: { method: 'GET', path: '/x', query: { a: 1 }, ip: '192.0.2.1' }, ctx: { exception: 'E' }, extra_top: 1 }, at, CID)));
    expect(r.context).toEqual({ exception: 'E' });
    expect(r).toMatchObject({ kind: 'incoming', method: 'GET', uri: '/x' });
  });

  it('у ответа с upstream и ctx в контексте остаётся только ctx', () => {
    const r = parseLine(record(app('http response received', { upstream: { url: 'http://x/y', status: 500, body: '{}' }, ctx: { exception: { code: 1 } } }, at, CID)));
    expect(buildView([r], { withOffsets: true })[0]!.sections.context).toEqual({ exception: { code: 1 } });
  });

  it('вызов по имени: action и payload, без upstream', () => {
    const r = parseLine(record(app('processor call', { request_id: 'r', action: 'getCard', payload: [{ CARD: 'x' }] }, at, CID)));
    expect(r).toMatchObject({ kind: 'call', action: 'getCard', payload: [{ CARD: 'x' }], requestId: 'r' });
  });

  it('пустой или отсутствующий ctx — контекста нет', () => {
    expect(parseLine(record(app('m', { ctx: {} }, at, CID))).context).toBeNull();
    expect(parseLine(record(app('m', {}, at, CID))).context).toBeNull();
  });
});

describe('профиль json: приведение значений', () => {
  const resp = (status: unknown) => parseLine(record(app('http response received', { upstream: { url: 'http://x/y', status } }, at, CID))).status;

  it('статус: число или строка, которая читается числом', () => {
    expect([resp(200), resp(' 200'), resp('200.0'), resp('503'), resp('abc')]).toEqual([200, 200, 200, 503, null]);
    // Статус null или пустая строка — отправка без ответа.
    expect(parseLine(record(app('m', { upstream: { url: 'http://x/y', status: null } }, at, CID)))).toMatchObject({ kind: 'send', status: null });
    expect(resp('')).toBeNull();
  });

  it('correlation_id из одних пробелов — нет correlation_id; строка — как есть, без обрезки', () => {
    const cid = (v: unknown) => parseLine(record(app('x', { correlation_id: v }, at, ''))).correlationId;
    expect([cid('  '), cid(' a '), cid(42), cid(null)]).toEqual([null, ' a ', '42', null]);
  });

  it('уровень: неизвестное имя в level и имя в severity — число по severity', () => {
    expect(parseLine(record(app('x', { level: 'NOTE', severity: 'WARNING' }, at, 'c')))).toMatchObject({ level: 'NOTE', levelNum: 300 });
  });

  it('уровни строчными, числом и строкой из цифр; WARN, ERR, CRIT, FATAL — по встроенной таблице', () => {
    expect(parseLine(record(app('x', {}, at, 'c', 'warning')))).toMatchObject({ level: 'WARNING', levelNum: 300 });
    expect(parseLine(gateway({ level: '400' }))).toMatchObject({ level: 'ERROR', levelNum: 400 });
    expect(parseLine(record(app('x', {}, at, 'c', 'notice')))).toMatchObject({ level: 'NOTICE', levelNum: 250 });
    expect(['WARN', 'ERR', 'CRIT', 'FATAL'].map((level) => parseLine(gateway({ level })).levelNum)).toEqual([300, 400, 500, 600]);
    expect(parseLine(record({ ...app('x', {}, at, 'c'), level: 400 }))).toMatchObject({ level: 'ERROR', levelNum: 400 });
  });

  it('время: другие имена поля и число от эпохи', () => {
    const base = { msg: 'x', correlation_id: 'c' };
    const t = Date.parse(`2026-11-01T10:11:12${OFFSET}`) + 300;
    for (const key of ['timestamp', '@timestamp', 'ts']) expect(parseLine({ tsNs: '1', line: line({ [key]: `${at}${OFFSET}`, ...base }), labels: API_LABELS }).timeMs, key).toBe(t);
    expect(parseLine({ tsNs: nsAfter(at), line: line({ time: 1793180955495, ...base }), labels: API_LABELS }).timeMs).toBe(1793180955495);
    // Время не разобралось — время хранилища.
    expect(parseLine({ tsNs: nsAfter(at, 0), line: line({ time: 'yesterday', ...base }), labels: API_LABELS }).timeMs).toBe(t);
  });

  it('сообщение в поле message, а не msg', () => {
    expect(parseLine({ tsNs: '1', line: line({ message: 'hi', correlation_id: 'c' }), labels: API_LABELS })).toMatchObject({ kind: 'log', message: 'hi', correlationId: 'c' });
  });
});

describe('профиль json: известные расхождения', () => {
  it('сообщение объектом: текст JSON', () => {
    expect(parseLine(record(app('x', {}, at, CID))).message).toBe('x');
    expect(parseLine({ tsNs: '1', line: line({ time: `${at}${OFFSET}`, msg: { text: 'obj' }, correlation_id: CID }), labels: API_LABELS })).toMatchObject({ kind: 'log', message: '{"text":"obj"}' });
    expect(parseLine(gateway({ msg: { name: 'edge' } })).message).toBe('{"name":"edge"}');
  });

  it('сообщение null и строка не JSON — записи-текст, строка целиком', () => {
    const nullMessage = line({ time: `${at}${OFFSET}`, level: 'info', msg: null, correlation_id: CID });
    expect(parseLine({ tsNs: '1', line: nullMessage, labels: API_LABELS })).toMatchObject({ kind: 'text', message: nullMessage, correlationId: null });
    expect(parseLine({ tsNs: '1', line: BROKEN_LINE, labels: API_LABELS })).toMatchObject({ kind: 'text', message: BROKEN_LINE });
    expect(parseLine({ tsNs: '1', line: '   ', labels: API_LABELS }).kind).toBe('raw');
  });

  it('LF в raw_request шлюза: разбор находит correlation_id, подсчёт — нет', () => {
    const l = gateway({}, { eol: '\n' });
    expect(parseLine(l).correlationId).toBe(CID);
    expect(countKey(l.line)).toBeNull();
    expect(countKey(gateway().line)).toBe(CID);
  });

  it('запись шлюза без метода в первой строке — без вида incoming: лог', () => {
    const r = parseLine(gateway({ raw_request: 'garbage' }));
    expect(r).toMatchObject({ kind: 'log', gateway: true, correlationId: null });
  });
});

describe('профиль json: выражение подсчёта на каждом виде записи', () => {
  it('вход, вызов, отправка, ответ, лог, шаг базы и вход шлюза дают разобранный correlation_id; текст — нет', () => {
    const lines: LogLine[] = [
      ...cardsLookup(),
      record(app('db query', { step: 'db', duration_ms: 3, ctx: { host: 'db.pay.example' } }, at, CID), API_LABELS),
      record(app('failed', { ctx: { exception: { message: 'boom "correlation_id":"x"' } } }, at, CID, 400), API_LABELS),
      gateway(),
    ];
    const parsed = lines.map(parseLine);
    expect(parsed.map((r) => r.kind)).toEqual(['incoming', 'call', 'send', 'response', 'log', 'log', 'incoming']);
    for (const [i, l] of lines.entries()) {
      expect(parsed[i]!.correlationId, String(i)).not.toBeNull();
      expect(countKey(l.line), String(i)).toBe(parsed[i]!.correlationId);
    }
    expect(countKey(GIN_TEXT)).toBeNull();
    expect(countKey(BROKEN_LINE)).toBeNull();
  });

  it('ключ в экранированном теле не считается: в записи без correlation_id ключа нет', () => {
    const body = JSON.stringify({ correlation_id: 'body-1', nested: JSON.stringify({ correlation_id: 'deeper' }) });
    const l = record(app('http response received', { upstream: { url: 'http://x/y', status: 200, body } }, at, ''), API_LABELS);
    expect(parseLine(l).correlationId).toBeNull();
    expect(countKey(l.line)).toBeNull();
  });
});

describe('профиль json: признак входа GET', () => {
  it('выражение годится для хранилища: RE2, одна группа flag', () => {
    const c = checkRe2(BUILTIN_GET_FLAG);
    expect(c.ok && c.info.groups).toEqual(['flag']);
  });

  it('вход приложения GET и сырой GET шлюза — признак есть; POST, исходящий GET и GET в теле — нет', () => {
    const inGet = record(app('incoming request', { request: { method: 'GET', path: '/v1/x' } }, at, CID)).line;
    const inGetLate = record(app('incoming request', { request: { path: '/v1/x', headers: { Accept: ['*/*'] }, method: 'GET' } }, at, CID)).line;
    const inPost = record(app('incoming request', { request: { method: 'POST', path: '/v1/x', body: '{}' } }, at, CID)).line;
    const outGet = record(app('http request sending', { upstream: { method: 'GET', url: 'http://x/y' } }, at, CID)).line;
    const inBody = record(app('http request sending', { upstream: { method: 'POST', url: 'http://x/y', body: JSON.stringify({ request: { method: 'GET' } }) } }, at, CID)).line;
    expect([inGet, inGetLate, gateway().line].map(getFlag).every((f) => f !== null)).toBe(true);
    expect([inPost, gateway({}, { method: 'POST' }).line, outGet, inBody].map(getFlag)).toEqual([null, null, null, null]);
  });
});

describe('профиль json: сборка и выбор профиля', () => {
  it('profileSource: встроенный json, свой профиль, неизвестный — undefined', () => {
    const own = { variants: [{ name: 'a', layers: [{ name: 'r', decode: 'json' as const }], fields: { correlationId: 'r.c' } }] };
    expect(profileSource('json', {})).toBe(BUILTIN_PROFILE);
    expect(profileSource('acme', { acme: own })).toBe(own);
    expect(profileSource('nope', { acme: own })).toBeUndefined();
    expect(profileSource('toString', {})).toBeUndefined();
    expect(builtinProfile()).toBe(builtinProfile());
    expect(builtinProfile().name).toBe('json');
  });

  it('20 000 строк — меньше секунды', () => {
    const base = [...cardsLookup(), ...apiExchange(), gateway(), { tsNs: '1', line: GIN_TEXT, labels: API_LABELS }, { tsNs: '1', line: '{"broken', labels: API_LABELS }];
    const lines = Array.from({ length: 20_000 }, (_, i) => base[i % base.length]!);
    const p = builtinProfile();
    const t = performance.now();
    for (const l of lines) p.parse(l);
    expect(performance.now() - t).toBeLessThan(1000);
  });
});
