// Правила итога: три типичных случая (200 и OK, 200 и error с сообщением, 422 и OK), уровни, приоритет,
// условия, шаблон текста, «не ошибка».
import { describe, expect, it } from 'vitest';
import type { RequestSummary } from '../search/api.ts';
import { buildView, markPending, maskDeep, summarize, type ParsedRecord } from '../search/index.ts';
import { annotateRecords, finalizeSummary } from './annotate.ts';
import { parseBody } from './body.ts';
import { conditionsMatch, httpMatches, renderTemplate } from './outcome.ts';
import { exchange, incoming, resolverFromFile, TEST_FILE } from './test-catalog.ts';

const resolver = resolverFromFile(TEST_FILE);
const T0 = Date.UTC(2026, 10, 2, 9, 0, 0);
const OPTS = { match: 'exact' as const, readEndMs: T0 + 600_000, incomplete: false };

function run(records: ParsedRecord[]): { base: RequestSummary; final: RequestSummary } {
  const base = summarize('c0ffee00-0000-4000-8000-000000000001', records, OPTS);
  return { base, final: finalizeSummary(base, records, resolver, OPTS) };
}

function response(records: ParsedRecord[]) {
  const view = annotateRecords(markPending(buildView(records, { withOffsets: true }), OPTS), resolver);
  return view.find((v) => v.kind === 'response')!;
}

const req = (uri: string, status: number, resp: unknown, extra: { req?: unknown; method?: string } = {}) => [
  incoming(T0, 'POST', '/v1/users'),
  ...exchange(T0 + 10, uri, { status, resp, ...extra }),
];

describe('три типичных случая', () => {
  it('HTTP 200 и status OK при сработавшем общем признаке → успех', () => {
    const records = req('http://alpha.local/api/pay', 200, { status: 'OK', error: { code: 7, message: 'warn' } });
    const { base, final } = run(records);
    expect(base.status).toBe('error');
    expect(final.status).toBe('success');
    expect(final.reasons).toEqual([]);
    const r = response(records);
    expect(r.catalog?.outcome).toMatchObject({ kind: 'success', rule: { level: 'system' } });
    expect(r.catalog?.error).toBeNull();
  });

  it('HTTP 200 и status error с message без общего признака → ошибка с текстом из тела', () => {
    const records = req('http://alpha.local/api/pay', 200, { status: 'error', message: 'Limit exceeded' });
    const { base, final } = run(records);
    expect(base.status).toBe('success');
    expect(final.status).toBe('error');
    expect(final.reasons).toHaveLength(1);
    expect(final.reasons[0]).toMatchObject({ kind: 'outcome', name: { system: { name: 'Альфа' } }, error: { title: 'Limit exceeded', rule: { kind: 'outcome', level: 'system' } } });
    expect(response(records).catalog?.outcome).toMatchObject({ kind: 'error', text: 'Limit exceeded' });
  });

  it('HTTP 422 и status OK → успех, причины HTTP 422 нет', () => {
    const records = req('http://alpha.local/api/pay', 422, { status: 'OK' });
    const { base, final } = run(records);
    expect(base.reasons.map((r) => r.kind)).toEqual(['http']);
    expect(final.status).toBe('success');
    expect(final.reasons).toEqual([]);
  });
});

describe('уровни и приоритет', () => {
  it('правило метода сильнее правила системы', () => {
    const { final } = run(req('http://beta.local/v1/check', 422, { status: 'OK' }));
    expect(final.status).toBe('success');
    const other = run(req('http://beta.local/v1/other', 422, { status: 'OK' })).final;
    expect(other.status).toBe('error');
    expect(other.reasons[0]).toMatchObject({ kind: 'outcome', error: { title: 'Отказ Беты' } });
  });

  it('приоритет внутри уровня: 10 раньше 100', () => {
    const { final } = run(req('http://beta.local/v1/other', 200, { status: 'error', error: { message: 'Card expired' } }));
    expect(final.status).toBe('error');
    expect(final.reasons[0]!.error?.title).toBe('Отказ: Card expired');
  });

  it('ни одно правило не подошло → общий признак и правила ошибок', () => {
    const { final } = run(req('http://beta.local/v1/other', 500, ''));
    expect(final.status).toBe('error');
    expect(final.reasons[0]).toMatchObject({ kind: 'http', error: { source: 'unknown', title: null, raw: { http: 500 } } });
  });

  it('неузнанная система: только общие правила проекта', () => {
    const { final } = run(req('http://unknown.local/x', 503, ''));
    expect(final.reasons[0]).toMatchObject({ kind: 'outcome', name: { source: 'unknown' }, error: { title: 'Сервис недоступен', rule: { level: 'general' } } });
  });
});

describe('итоги правила', () => {
  it('в обработке: шаг нейтральный, запрос не ошибка', () => {
    const records = req('http://gamma.local/v1/op', 202, { state: 'PROCESSING' });
    expect(run(records).final.status).toBe('success');
    expect(response(records).catalog?.outcome?.kind).toBe('pending');
  });

  it('не ошибка по условию метода: HTTP 404 остаётся в подробностях с severity ok', () => {
    const records = [incoming(T0, 'GET', '/v1/users'), ...exchange(T0 + 10, 'http://gamma.local/v1/client', { method: 'GET', status: 404, resp: '' })];
    expect(run(records).final.status).toBe('success');
    const r = response(records);
    expect(r.catalog?.outcome).toMatchObject({ kind: 'ignore', rule: { level: 'method' } });
    expect(r.catalog?.error).toMatchObject({ severity: 'ok', raw: { http: 404 }, rule: { kind: 'outcome' } });
  });

  it('поле тела запроса', () => {
    const refund = req('http://gamma.local/v1/op', 409, '', { req: { operation: 'refund' } });
    expect(run(refund).final.status).toBe('success');
    const pay = req('http://gamma.local/v1/op', 409, '', { req: { operation: 'pay' } });
    expect(run(pay).final.status).toBe('error');
  });

  it('нет ответа: правила не проверяются', () => {
    const records = [incoming(T0, 'POST', '/v1/users'), ...exchange(T0 + 10, 'http://alpha.local/api/pay', { status: null })];
    const { final } = run(records);
    expect(final.reasons).toEqual([expect.objectContaining({ kind: 'no-response', name: expect.objectContaining({ system: expect.objectContaining({ name: 'Альфа' }) }) })]);
  });

  it('правило итога сильнее «не ошибки» правила ошибок', () => {
    const records = req('http://fraud.local/', 200, { jsonrpc: '2.0', error: { code: '00', message: 'ok' }, result: { card_status: 'BLOCKED' } }, { req: { jsonrpc: '2.0', method: 'card.status', id: 1 } });
    const { final } = run(records);
    expect(final.status).toBe('error');
    expect(final.reasons[0]).toMatchObject({ kind: 'outcome', error: { title: 'Карта заблокирована', severity: 'error' } });
  });
});

describe('ошибка по правилу без текста', () => {
  it('поля для шаблона нет → текст признака', () => {
    const records = req('http://delta.local/pay', 201, { status: 'error', error: { code: 99, message: 'Insufficient funds' } });
    const { final } = run(records);
    expect(final.reasons[0]!.error).toMatchObject({ title: 'error 99: Insufficient funds', action: 'Повторить' });
  });

  it('текста нет → правило ошибки и его «что делать»', () => {
    const records = req('http://delta.local/pay', 200, { status: 'error', error: { code: 51, message: 'Insufficient funds' } });
    const { final } = run(records);
    expect(final.reasons[0]!.error).toMatchObject({ title: 'Недостаточно средств', action: 'Сообщить клиенту', rule: { kind: 'outcome' } });
  });

  it('без текста, правила ошибки и признака → HTTP-статус', () => {
    const records = req('http://delta.local/pay', 200, { status: 'error' });
    expect(run(records).final.reasons[0]!.error?.title).toBe('HTTP 200');
  });
});

describe('условия', () => {
  const ctx = (http: number | null, body: unknown, request: unknown = null) => ({
    http,
    response: parseBody(typeof body === 'string' ? body : JSON.stringify(body)),
    request: parseBody(request === null ? null : JSON.stringify(request)),
  });

  it('HTTP: диапазон и список', () => {
    expect(httpMatches({ from: 400, to: 499 }, 422)).toBe(true);
    expect(httpMatches({ from: 400, to: 499 }, 500)).toBe(false);
    expect(httpMatches([200, 202], 202)).toBe(true);
    expect(httpMatches([200, 202], 201)).toBe(false);
    expect(httpMatches(200, null)).toBe(false);
  });

  it('число и строка равны', () => {
    const when = { fields: [{ path: 'data.status', equals: '2' }] };
    expect(conditionsMatch(when, ctx(200, { data: { status: 2 } }))).toBe(true);
    expect(conditionsMatch(when, ctx(200, { data: { status: '2' } }))).toBe(true);
    expect(conditionsMatch({ fields: [{ path: 'ok', equals: 'TRUE' }] }, ctx(200, { ok: true }))).toBe(true);
  });

  it('null — «нет», объект — «значения нет»', () => {
    expect(conditionsMatch({ fields: [{ path: 'error', exists: false }] }, ctx(200, { error: null }))).toBe(true);
    expect(conditionsMatch({ fields: [{ path: 'error', exists: true }] }, ctx(200, { error: null }))).toBe(false);
    expect(conditionsMatch({ fields: [{ path: 'error', equals: 'x' }] }, ctx(200, { error: { a: 1 } }))).toBe(false);
  });

  it('регулярное выражение', () => {
    expect(conditionsMatch({ fields: [{ path: 'message', regex: '^Timeout' }] }, ctx(200, { message: 'Timeout after 30s' }))).toBe(true);
    expect(conditionsMatch({ fields: [{ path: 'message', regex: '^Timeout' }] }, ctx(200, { message: 'timeout' }))).toBe(false);
  });

  it('тег XML', () => {
    const xml = '<S:Envelope><S:Body><ns2:resp><ns2:response_code>0</ns2:response_code></ns2:resp></S:Body></S:Envelope>';
    expect(conditionsMatch({ fields: [{ path: 'response_code', equals: '0' }] }, ctx(200, xml))).toBe(true);
  });

  it('тело не разобралось: выполняется только «нет»', () => {
    const body = '{"status":"OK",';
    expect(conditionsMatch({ http: 200, fields: [{ path: 'status', equals: 'OK' }] }, ctx(200, body))).toBe(false);
    expect(conditionsMatch({ fields: [{ path: 'status', exists: false }] }, ctx(200, body))).toBe(true);
  });

  it('без условий правило не подходит', () => {
    expect(conditionsMatch({}, ctx(200, {}))).toBe(false);
  });
});

describe('шаблон текста', () => {
  it('подстановка, пустое место, обрезка', () => {
    const body = parseBody(JSON.stringify({ error: { message: 'Card expired' }, obj: { a: 1 }, n: 5, long: 'x'.repeat(150) }));
    expect(renderTemplate('Отказ партнёра: {error.message}', body)).toBe('Отказ партнёра: Card expired');
    expect(renderTemplate('{missing} {obj} код {n}', body)).toBe('код 5');
    expect(renderTemplate('{long} {long}', body)).toHaveLength(200);
    expect(renderTemplate('{n}'.repeat(6), body)).toBe('');
  });

  it('номер карты из {message} маскируется ещё при сборке текста', () => {
    const records = req('http://alpha.local/api/pay', 200, { status: 'error', message: 'card 4111111234557893 blocked' });
    const { final } = run(records);
    expect(final.reasons[0]!.error?.title).toBe('card 411111******7893 blocked');
    const masked = maskDeep(final, new Set());
    expect(JSON.stringify(masked)).not.toContain('4111111234557893');
    expect(masked.reasons[0]!.error?.title).toBe('card 411111******7893 blocked');
  });
});
