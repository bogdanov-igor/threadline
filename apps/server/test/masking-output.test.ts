// Значения не открываются в ответах сервера: заголовки записей, причины, потоки операции, «Неизвестное», проверка
// подключения, журнал. Записи — синтетические, идут через настоящий сервер и имитацию хранилища.
import { Writable } from 'node:stream';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { BackendError } from '@threadline/core/backend';
import { buildApp } from '../src/app.ts';
import { Backends } from '../src/backends/registry.ts';
import { MockBackend } from '../src/backends/mock/index.ts';
import { UnknownCollector } from '../src/catalog/collector.ts';
import { createCatalogService, type CatalogService } from '../src/catalog/service.ts';
import { loadConfig } from '../src/config/load.ts';

const YAML = `
auth: off
defaults: { project: pay, environment: demo }
backends:
  demo: { type: mock }
projects:
  pay:
    name: Demo Pay
    timezone: UTC
    retentionDays: 30
    environments:
      demo:
        name: Демо
        backend: demo
        selector: [{ label: namespace, op: '=', value: pay }]
`;

const LUHN = '4111111234557893';
const NON_LUHN = '5100123440473348';
const T0 = Date.now() - 20 * 60_000;
const LABELS = { cluster: 'c', namespace: 'pay', container: 'api', app_kubernetes_io_component: 'api' };
const GW = { cluster: 'c', namespace: 'pay', app_kubernetes_io_component: 'gateway' };

let tick = 0;
const stamp = () => {
  const ms = T0 + tick++ * 50;
  return { ms, iso: new Date(ms).toISOString().replace('Z', '000+00:00') };
};
const records: { tsNs: bigint; labels: Record<string, string>; line: string }[] = [];
/** Запись приложения встроенного формата json: поля после correlation_id — request_id, request, upstream, ctx. */
function rec(cid: string, msg: string, fields: Record<string, unknown>, level = 200): void {
  const t = stamp();
  const name = { 200: 'info', 300: 'warning', 400: 'error' }[level] ?? 'info';
  records.push({ tsNs: BigInt(t.ms) * 1_000_000n, labels: LABELS, line: JSON.stringify({ time: t.iso, level: name, msg, correlation_id: cid, ...fields }) });
}
/** Запись с остальным контекстом. */
const mono = (cid: string, msg: string, ctx: Record<string, unknown>, level = 200) => rec(cid, msg, Object.keys(ctx).length > 0 ? { ctx } : {}, level);
function exchange(cid: string, uri: string, status: number, resp: unknown, req?: unknown): void {
  rec(cid, 'send', { request_id: `r-${cid}`, upstream: { method: 'POST', url: uri, headers: {}, body: req ?? '' } });
  rec(cid, 'recv', { request_id: `r-${cid}`, upstream: { method: 'POST', url: uri, status, headers: {}, body: resp } });
}
function gateway(cid: string, raw: string): void {
  const t = stamp();
  const http = raw.replace('{cid}', cid);
  records.push({ tsNs: BigInt(t.ms) * 1_000_000n, labels: GW, line: JSON.stringify({ time: t.iso, level: 'info', msg: 'request received', raw_request: http }) });
}

interface Case {
  name: string;
  cid: string;
  tokens: string[];
}
const cases: Case[] = [];
function add(name: string, tokens: string[], write: (cid: string) => void): void {
  const cid = `cid-m${cases.length}-synthetic`;
  cases.push({ name, cid, tokens });
  write(cid);
}

// Адреса: заголовок, причина, http.uri, сырая строка.
for (const [name, uri] of [
  ['/ в пароле', 'https://svc:pa/SYNTHUA@partner.example/x'],
  ['@ в пароле', 'https://svc:pa@SYNTHUA@partner.example/x'],
  ['? в пароле', 'https://svc:SYNTHUA?z@partner.example/x'],
  ['# в пароле', 'https://svc:SYNTHUA#z@partner.example/x'],
  ['без схемы //', '//svc:SYNTHUA@partner.example/x'],
  ['без схемы и косых', 'svc:SYNTHUA@partner.example/x'],
  ['пробел в пароле', 'https://svc:pa SYNTHUA@partner.example/x'],
  ['кавычка в пароле', 'https://svc:pa"SYNTHUA@partner.example/x'],
  ['пароль 600 символов', `https://svc:${'SYNTHUA'.repeat(90)}@partner.example/x`],
] as const) {
  add(`адрес: ${name}`, ['SYNTHUA'], (cid) => exchange(cid, uri, 500, { message: 'boom' }));
}
// Обрезанные и длинные значения.
add('обрезанный JSON: пароль', ['SYNTHSEC'], (cid) => exchange(cid, 'https://partner.example/x', 500, '{"code":1,"password":"SYNTHSEC015Q'));
add('обрезанный JSON: номер без Луна', [NON_LUHN], (cid) => exchange(cid, 'https://partner.example/x', 200, `{"pan":"${NON_LUHN}`));
add('обрезанный XML: пароль', ['SYNTHSEC'], (cid) => exchange(cid, 'https://partner.example/x', 500, '<a><password>SYNTHSEC017Q'));
add('обрезанный XML: номер', [NON_LUHN], (cid) => exchange(cid, 'https://partner.example/x', 200, `<RCARD>${NON_LUHN}`));
add('сообщение записи с обрезанным JSON', ['SYNTHSEC'], (cid) => mono(cid, '{"password":"SYNTHSEC', {}, 400));
add('перевод строки в значении', ['SYNTHSEC'], (cid) => exchange(cid, 'https://partner.example/x', 200, '{"password":"SYNTHSEC\nz"}'));
add('токен длиннее 8 КБ', ['SYNTHSEC'], (cid) => exchange(cid, 'https://partner.example/x', 200, `{"access_token":"SYNTHSEC${'a'.repeat(9000)}"}`));
// Вложенные теги.
add('вложенный элемент под паролем', ['SYNTHSEC'], (cid) => exchange(cid, 'https://partner.example/x', 200, '<a><password><value>SYNTHSEC</value></password></a>'));
add('комментарий под паролем', ['SYNTHSEC'], (cid) => exchange(cid, 'https://partner.example/x', 200, '<password><!-- c -->SYNTHSEC</password>'));
add('RCARD с вложенным элементом', [NON_LUHN], (cid) => exchange(cid, 'https://partner.example/x', 200, `<RCARD><number>${NON_LUHN}</number></RCARD>`));
// Служебные имена и числа.
add('контекст: tsNs', [LUHN], (cid) => mono(cid, 'm', { tsNs: LUHN, a: { b: { tsNs: LUHN } } }));
add('контекст: id и pairId', [LUHN], (cid) => mono(cid, 'm', { id: `${LUHN}-1`, pairId: `${LUHN}-1` }));
add('контекст: отрицательное и дробное', [LUHN], (cid) => {
  const t = stamp();
  const raw = `{"time":"${t.iso}","level":"info","msg":"m","correlation_id":"${cid}","ctx":{"amount":-${LUHN},"x":${LUHN}.5}}`;
  records.push({ tsNs: BigInt(t.ms) * 1_000_000n, labels: LABELS, line: raw });
});
// Учётные данные.
add('Digest в сообщении', ['SYNTHSEC'], (cid) => mono(cid, 'login Digest username="SYNTHSEC", realm="r", response="z"', {}));
add('Bearer+ в теле формы', ['SYNTHSEC'], (cid) => exchange(cid, 'https://partner.example/x', 200, 'ok', 'auth=Bearer+SYNTHSEC&x=1'));
add('X-Authorization в сыром HTTP', ['SYNTHSEC'], (cid) => gateway(cid, 'POST /v1/x HTTP/1.1\r\nHost: h\r\nX-Correlation-Id: {cid}\r\nX-Authorization: SYNTHSEC\r\n\r\n'));
add('сложенный Authorization', ['SYNTHSEC'], (cid) => gateway(cid, 'POST /v1/x HTTP/1.1\r\nHost: h\r\nX-Correlation-Id: {cid}\r\nAuthorization: Bearer\r\n SYNTHSEC\r\n\r\n'));
add('Authorization в теге', ['SYNTHSEC'], (cid) => exchange(cid, 'https://partner.example/x', 200, '<a><Authorization>SYNTHSEC</Authorization></a>'));
// Номер без Луна вне ключа JSON.
add('?pan= в адресе', [NON_LUHN], (cid) => exchange(cid, `https://partner.example/x?pan=${NON_LUHN}&y=1`, 200, { ok: 1 }));
add('cardNumber= в форме', [NON_LUHN], (cid) => exchange(cid, 'https://partner.example/x', 200, { ok: 1 }, `cardNumber=${NON_LUHN}&y=1`));
add('двойные пробелы', [NON_LUHN.slice(6, 10)], (cid) => exchange(cid, 'https://partner.example/x', 200, { cardNumber: '5100  1234  4047  3348' }));
add('объект под pan', [NON_LUHN], (cid) => mono(cid, 'm', { pan: { number: NON_LUHN }, FilterCondition: { value: NON_LUHN } }));
// Записи не JSON и не имя=значение.
add('password: значение', ['SYNTHSEC'], (cid) => mono(cid, 'login failed password: SYNTHSEC', {}));
add('кодовое слово из двух слов', ['SYNTHSEC'], (cid) => mono(cid, 'cardholderPassword=golden SYNTHSEC', {}));
add('одинарные кавычки', ['SYNTHSEC'], (cid) => mono(cid, "req {'password': 'SYNTHSEC'}", {}));

const OPV = 'opvalue-synthetic-abcdef123456';
rec('cid-op1', 'incoming request', { request: { method: 'POST', path: 'https://svc:pa/SYNTHUB@partner.example/zzz', body: JSON.stringify({ ref: OPV }) } });
mono('cid-op1', `s ${OPV}`, {});
exchange('cid-op2', 'https://svc:pa/SYNTHUB@unknown-host.example/zz', 200, { ref: OPV });

let app: FastifyInstance;
let svc: CatalogService;
let mock: MockBackend;
let checkDetails: string | null = null;
const log: string[] = [];

beforeAll(async () => {
  records.sort((a, b) => (a.tsNs < b.tsNs ? -1 : 1));
  const dir = await mkdtemp(join(tmpdir(), 'threadline-mask-'));
  await writeFile(join(dir, 'threadline.yaml'), YAML);
  const config = await loadConfig({ path: join(dir, 'threadline.yaml'), env: {} });
  mock = new MockBackend({ type: 'mock', latencyMs: 0 } as never, { flowScenarios: false });
  mock.records.length = 0;
  mock.records.push(...records);
  const check = mock.check.bind(mock);
  mock.check = async (s: AbortSignal) => {
    if (checkDetails) throw new BackendError('unauthorized', { status: 401, details: checkDetails });
    return check(s);
  };
  svc = createCatalogService(config, 'pglite://memory', { info: () => undefined, warn: () => undefined });
  await svc.start();
  const collector = new UnknownCollector(svc, { demoInbox: true });
  const stream = new Writable({
    write(chunk, _e, cb) {
      log.push(String(chunk));
      cb();
    },
  });
  app = await buildApp({ config, backends: new Backends(config, { createAdapter: () => mock }), catalog: svc, collector, logger: { stream } });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await svc.close();
});

const get = async (url: string) => (await app.inject(url)).body;
async function search(term: string): Promise<{ id: string; state: { requests: { correlationId: string; firstMs: number; lastMs: number }[]; status: string } }> {
  const r = await app.inject({ method: 'POST', url: '/api/projects/pay/envs/demo/searches', payload: { terms: [term], period: { preset: '1h' }, fresh: true } });
  expect(r.statusCode, r.body).toBe(200);
  const id = (r.json() as { id: string }).id;
  for (let i = 0; i < 500; i++) {
    const s = (await app.inject(`/api/searches/${id}`)).json() as { requests: never[]; status: string };
    if (s.status !== 'running') return { id, state: s };
    await new Promise((f) => setTimeout(f, 5));
  }
  throw new Error('поиск не завершился');
}

describe('ответы сервера без открытых значений', () => {
  it.each(cases.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    const { id, state } = await search(c.cid);
    expect(state.requests.length).toBeGreaterThan(0);
    const bodies = [JSON.stringify(state), await get(`/api/searches/${id}/lines`)];
    for (const r of state.requests) {
      bodies.push(await get(`/api/searches/${id}/requests/${encodeURIComponent(r.correlationId)}`));
      bodies.push(await get(`/api/projects/pay/envs/demo/requests/${encodeURIComponent(r.correlationId)}?from=${Math.floor(r.firstMs) - 1000}&to=${Math.ceil(r.lastMs) + 1000}`));
    }
    for (const b of bodies) for (const t of c.tokens) expect(b, b.slice(0, 200)).not.toContain(t);
  });

  it('заголовок записи и причина: только хост и путь', async () => {
    const c = cases.find((x) => x.name === 'адрес: @ в пароле')!;
    const { id, state } = await search(c.cid);
    const d = JSON.parse(await get(`/api/searches/${id}/requests/${encodeURIComponent(c.cid)}`)) as { records: { title: string }[]; summary: { reasons: { text: string }[] } };
    expect(d.records[0]!.title).toBe('POST partner.example/x');
    expect(d.summary.reasons[0]!.text).toContain('POST partner.example/x');
    expect(state.requests).toHaveLength(1);
  });

  it('потоки операции: заголовки без пароля', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/projects/pay/envs/demo/operations', payload: { type: 'ref', values: [OPV], atMs: T0, window: '6h' } });
    expect(r.statusCode, r.body).toBe(200);
    const id = (r.json() as { id: string }).id;
    let body = '';
    for (let i = 0; i < 500; i++) {
      body = await get(`/api/searches/${id}`);
      if ((JSON.parse(body) as { status: string }).status !== 'running') break;
      await new Promise((f) => setTimeout(f, 5));
    }
    expect((JSON.parse(body) as { operation: { items: unknown[] } }).operation.items.length).toBeGreaterThan(0);
    expect(body).not.toContain('SYNTHUB');
    expect(body).toContain('/zzz');
  });

  it('«Неизвестное»: примеры и таблица без значений', async () => {
    const c = cases.find((x) => x.name === 'обрезанный JSON: пароль')!;
    await search(c.cid);
    await new Promise((f) => setTimeout(f, 50));
    const rows = await svc.db().query<Record<string, unknown>>('select * from catalog_unknown');
    expect(JSON.stringify(rows)).not.toMatch(/SYNTHSEC|SYNTHUA/);
    expect(await get('/api/projects/pay/catalog/unknown')).not.toMatch(/SYNTHSEC|SYNTHUA/);
  });

  it('проверка подключения: текст ошибки хранилища маскирован', async () => {
    checkDetails = `Invalid token Bearer SYNTHH01 for https://u:SYNTHH02@h.example/x card ${LUHN} password=SYNTHH03`;
    const body = await get('/api/projects/pay/envs/demo/connection?refresh=1');
    checkDetails = null;
    expect(JSON.parse(body)).toMatchObject({ status: 'unauthorized' });
    expect(body).not.toMatch(/SYNTHH01|SYNTHH02|SYNTHH03/);
    expect(body).not.toContain(LUHN);
    expect(body).toContain('Bearer ***');
  });

  it('журнал сервера: путь запроса маскирован', async () => {
    await app.inject(`/api/x/${LUHN}/password=SYNTHG01`);
    const text = log.join('');
    expect(text).not.toContain('SYNTHG01');
    expect(text).not.toContain(LUHN);
  });

  it('равенство с отрицательным или дробным номером не принимается', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/projects/pay/catalog/systems', payload: { key: 'sys-mask', name: 'Система маски' } });
    expect(created.statusCode, created.body).toBe(201);
    const systemId = (created.json() as { id: number }).id;
    for (const equals of [-Number(LUHN), Number(LUHN) + 0.5]) {
      const r = await app.inject({ method: 'POST', url: '/api/projects/pay/catalog/outcome-rules', payload: { systemId, when: { fields: [{ path: 'a', equals }] }, outcome: 'error' } });
      expect(r.statusCode, r.body).toBe(422);
    }
  });
});
