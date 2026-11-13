// Журнал для Kubernetes: формат записи и журнал без чувствительных данных.
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.ts';
import { MOCK_PERSONAL } from '../../src/backends/mock/dataset-pay.ts';
import { Backends } from '../../src/backends/registry.ts';
import { loadConfig } from '../../src/config/load.ts';
import { queryLog, requestId, routeLabel } from '../../src/logging.ts';
import { configDir, memoryLog, mockApp } from './kit.ts';

const LINK_ID = 'AbCdEfGhIjKlMnOpQrStUv';
const PAN = '4111110000000000';
const SECRETS = {
  cookie: 'threadline.sid=synthetic-cookie-value',
  bearer: 'Bearer synthetic-bearer-value',
  password: 'synthetic-password-value',
  otp: '918273',
  token: 'synthetic-grafana-token-value',
};

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const parse = (lines: string[]) => lines.map((l) => JSON.parse(l) as Record<string, unknown>);

describe('формат журнала', () => {
  it('в каждой записи timestamp, level словом, message, request_id, по одному разу', async () => {
    const log = memoryLog();
    ({ app } = await mockApp({ logger: { stream: log.stream } }));
    await app.inject('/api/projects');
    await app.inject('/нет-такого-адреса');
    app.log.warn('запись вне запроса');
    expect(log.lines.length).toBeGreaterThanOrEqual(5);
    for (const line of log.lines) {
      for (const key of ['timestamp', 'level', 'message', 'request_id']) expect(line.match(new RegExp(`"${key}":`, 'g')), `${key} в ${line}`).toHaveLength(1);
      const r = JSON.parse(line) as Record<string, unknown>;
      expect(new Date(r.timestamp as string).toISOString()).toBe(r.timestamp);
      expect(typeof r.level).toBe('string');
      expect(typeof r.message).toBe('string');
      expect(typeof r.request_id).toBe('string');
      for (const old of ['time', 'msg', 'reqId', 'pid', 'hostname']) expect(r).not.toHaveProperty(old);
    }
  });

  it('вне запроса request_id равен system, в запросе свой', async () => {
    const log = memoryLog();
    ({ app } = await mockApp({ logger: { stream: log.stream } }));
    app.log.info('старт');
    await app.inject('/api/projects');
    const records = parse(log.lines);
    expect(records.find((r) => r.message === 'старт')!.request_id).toBe('system');
    const incoming = records.find((r) => r.message === 'incoming request')!;
    expect(incoming.request_id).not.toBe('system');
    expect(records.find((r) => r.message === 'request completed')!.request_id).toBe(incoming.request_id);
  });

  it('заголовок X-Request-Id принимается, если безопасен', () => {
    expect(requestId({ headers: { 'x-request-id': 'abc-12345.def' } })).toBe('abc-12345.def');
    expect(requestId({ headers: { 'x-request-id': '019a1f2e-7c3d-7000-8000-426614174000' } })).toBe('019a1f2e-7c3d-7000-8000-426614174000');
    for (const bad of ['короткий', 'a b c d e f g h', PAN, 'x'.repeat(200)]) expect(requestId({ headers: { 'x-request-id': bad } })).not.toBe(bad);
    expect(requestId({ headers: {} })).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('проверки и метрики не пишутся на уровне info', async () => {
    const log = memoryLog();
    ({ app } = await mockApp({ logger: { stream: log.stream } }));
    await app.inject('/health/liveness');
    await app.inject('/health/readiness');
    await app.inject('/metrics');
    expect(log.lines).toEqual([]);
  });
});

describe('журнал без чувствительных данных', () => {
  it('нет адресов, значений, идентификаторов ссылок, заголовков и тел', async () => {
    const log = memoryLog();
    ({ app } = await mockApp({ logger: { stream: log.stream } }));
    const headers = { cookie: SECRETS.cookie, authorization: SECRETS.bearer, 'x-grafana-token': SECRETS.token };
    await app.inject({ url: `/api/s/${LINK_ID}`, headers });
    await app.inject({ url: `/s/${LINK_ID}/requests/${PAN}`, headers });
    await app.inject({ url: `/api/projects/pay/envs/demo/requests/${PAN}?q=${PAN}&password=${SECRETS.password}&otp=${SECRETS.otp}`, headers });
    await app.inject({ method: 'POST', url: '/api/projects/pay/envs/demo/searches', headers: { ...headers, 'content-type': 'application/json' }, payload: JSON.stringify({ terms: [PAN], period: { preset: '6h' }, password: SECRETS.password }) });
    await app.inject({ method: 'POST', url: '/api/projects/pay/envs/demo/searches', headers: { 'content-type': 'application/json' }, payload: `{"terms":["${PAN}"` });
    await app.inject({ url: `/нет/${PAN}/${LINK_ID}?otp=${SECRETS.otp}`, headers });
    const text = log.lines.join('\n');
    expect(log.lines.length).toBeGreaterThan(5);
    for (const value of [LINK_ID, PAN, ...Object.values(SECRETS), 'synthetic-']) expect(text).not.toContain(value);
    expect(text).toContain('/api/s/:id');
    expect(text).toContain('"route":"unmatched"');
    for (const r of parse(log.lines)) expect((r.req as Record<string, unknown> | undefined)?.url).toBeUndefined();
  });

  it('ошибка: только тип и код, текста нет', async () => {
    const log = memoryLog();
    ({ app } = await mockApp({ logger: { stream: log.stream } }));
    app.log.error({ err: Object.assign(new Error(`сбой на ${PAN}`), { code: 'E_TEST' }) }, 'запись с ошибкой');
    const r = parse(log.lines)[0]!;
    expect(r.err).toEqual({ type: 'Error', code: 'E_TEST' });
    expect(log.lines[0]).not.toContain(PAN);
  });

  it('метка маршрута: шаблон API или постоянное значение', () => {
    expect(routeLabel('/api/s/:id')).toBe('/api/s/:id');
    expect(routeLabel('/health/readiness')).toBe('/health/readiness');
    expect(routeLabel('/metrics')).toBe('/metrics');
    expect(routeLabel('/*')).toBe('web');
    expect(routeLabel('/assets/index-abc.js')).toBe('web');
    expect(routeLabel(undefined)).toBe('unmatched');
  });
});

// Идентификатор ingress-nginx, опрос без info, подпись запросов к хранилищу.
describe('журнал поиска', () => {
  const VALUE = MOCK_PERSONAL.cid;

  async function traced() {
    const log = memoryLog();
    const dir = await configDir();
    const config = await loadConfig({ path: join(dir, 'threadline.yaml'), env: {} });
    const backends = new Backends(config);
    app = await buildApp({ config, backends, logger: { stream: log.stream } });
    backends.onQuery = queryLog(app.log);
    return log;
  }

  async function finished(id: string) {
    for (let i = 0; i < 500; i++) {
      const s = (await app!.inject(`/api/searches/${id}`)).json() as { status: string };
      if (s.status !== 'running') return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error('поиск не завершился');
  }

  const timings = (lines: string[]) => parse(lines).filter((r) => r.message === 'запрос к хранилищу');

  it('X-Request-Id ingress-nginx с 13 цифрами подряд принимается, номер карты и 32 цифры нет', () => {
    const ingress = '3f1234567890123456789abcdef01234';
    expect(requestId({ headers: { 'x-request-id': ingress } })).toBe(ingress);
    expect(requestId({ headers: { 'x-request-id': ingress.toUpperCase() } })).toBe(ingress.toUpperCase());
    for (const bad of ['4111111111111111', 'req-4111111111111111', 'pan-4111111111111111', '4'.repeat(32), `${ingress}0`]) {
      expect(requestId({ headers: { 'x-request-id': bad } }), bad).not.toBe(bad);
    }
    expect(requestId({ headers: { 'x-request-id': '0123456789abcdef0123456789abcdef' } })).toBe('0123456789abcdef0123456789abcdef');
  });

  it('опрос хода поиска и поиска ссылки не пишет info', async () => {
    const log = memoryLog();
    ({ app } = await mockApp({ logger: { stream: log.stream } }));
    const r = await app.inject({ method: 'POST', url: '/api/projects/pay/envs/demo/searches', payload: { terms: [VALUE], period: { preset: '15m' } } });
    const { id } = r.json() as { id: string };
    for (let i = 0; i < 3; i++) await app.inject(`/api/searches/${id}?from=0`);
    await app.inject(`/api/s/${LINK_ID}/state?from=0`);
    const routes = parse(log.lines).map((x) => (x.req as { route?: string } | undefined)?.route);
    expect(routes).toContain('/api/projects/:project/envs/:env/searches');
    expect(routes).not.toContain('/api/searches/:id');
    expect(routes).not.toContain('/api/s/:id/state');
  });

  it('запросы поиска одной среды несут id поиска, проект и среду; значений нет', async () => {
    const log = await traced();
    const r = await app!.inject({ method: 'POST', url: '/api/projects/pay/envs/demo/searches', payload: { terms: [VALUE], period: { preset: '24h' } } });
    const { id } = r.json() as { id: string };
    await finished(id);
    const lines = timings(log.lines);
    expect(lines.filter((x) => x.kind === 'count')).toHaveLength(24);
    expect(lines.length).toBeGreaterThan(24);
    for (const x of lines) expect(x).toMatchObject({ searchId: id, project: 'pay', env: 'demo', request_id: 'system', outcome: 'ok' });
    for (const l of log.lines.filter((x) => x.includes('запрос к хранилищу'))) expect(l).not.toContain(VALUE);
  });

  it('поиск по нескольким средам: общий id, своя среда, ошибка среды с исходом', async () => {
    const log = await traced();
    const r = await app!.inject({ method: 'POST', url: '/api/projects/pay/searches', payload: { envs: ['demo', 'broken'], terms: [VALUE], period: { preset: '1h' } } });
    const { id } = r.json() as { id: string };
    await finished(id);
    const lines = timings(log.lines);
    expect(new Set(lines.map((x) => x.searchId))).toEqual(new Set([id]));
    expect(lines.some((x) => x.env === 'demo' && x.outcome === 'ok')).toBe(true);
    expect(lines.find((x) => x.env === 'broken')).toMatchObject({ outcome: 'network', searchId: id, project: 'pay' });
  });

  it('«Все записи» и запрос по ссылке: request_id своего запроса', async () => {
    const log = await traced();
    const r = await app!.inject({ method: 'POST', url: '/api/projects/pay/envs/demo/searches', payload: { terms: [VALUE], period: { preset: '24h' } } });
    const { id } = r.json() as { id: string };
    await finished(id);
    const linesRead = 'lines-read-0001';
    await app!.inject({ url: `/api/searches/${id}/lines`, headers: { 'x-request-id': linesRead } });
    expect(timings(log.lines).filter((x) => x.request_id === linesRead)).not.toHaveLength(0);
    for (const x of timings(log.lines).filter((t) => t.request_id === linesRead)) expect(x).toMatchObject({ searchId: id, env: 'demo' });
    const linkRead = 'link-read-0001';
    const now = Date.now();
    await app!.inject({ url: `/api/projects/pay/envs/demo/requests/${VALUE}?from=${now - 60_000}&to=${now}`, headers: { 'x-request-id': linkRead } });
    const link = timings(log.lines).filter((x) => x.request_id === linkRead);
    expect(link).not.toHaveLength(0);
    for (const x of link) {
      expect(x).toMatchObject({ project: 'pay', env: 'demo' });
      expect(x).not.toHaveProperty('searchId');
    }
    for (const l of log.lines) expect(l.match(/"request_id":/g)).toHaveLength(1);
  });

  it('поиск операции несёт id задания и среду', async () => {
    const log = await traced();
    const r = await app!.inject({ method: 'POST', url: '/api/projects/pay/envs/demo/operations', payload: { type: 'ref', values: ['opvalue-synthetic-abcdef123456'], atMs: Date.now() - 20 * 60_000, window: '6h' } });
    expect(r.statusCode, r.body).toBe(200);
    const { id } = r.json() as { id: string };
    await finished(id);
    const lines = timings(log.lines);
    expect(lines.length).toBeGreaterThan(0);
    for (const x of lines) expect(x).toMatchObject({ searchId: id, project: 'pay', env: 'demo' });
  });
});
