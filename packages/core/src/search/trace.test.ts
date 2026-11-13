import { describe, expect, it } from 'vitest';
import type { LogLine } from '../backend/index.ts';
import type { ViewRecord } from './api.ts';
import { buildView, parseLine } from './records.ts';
import { API_LABELS, app, BROKEN_LINE, cardsLookup, CARDS_CID, GATEWAY_LABELS, GIN_TEXT, line, logLine, nsAfter, OFFSET, PROCESSOR_URI, record } from './test-fixtures.ts';
import { buildTrace, GATEWAY_LABEL, hostOf, pathOf, type Trace, type TraceStep } from './trace.ts';

// Записи демо-проекта выдуманы.

const view = (lines: LogLine[]): ViewRecord[] => buildView(lines.map(parseLine), { withOffsets: true });
const kinds = (t: Trace) => t.steps.map((s) => `${'  '.repeat(s.depth)}${s.kind}`);
const byKind = (t: Trace, kind: TraceStep['kind']) => t.steps.filter((s) => s.kind === kind);

const API_CID = '7d1e2f30-4a5b-4c6d-8e7f-90a1b2c3d4e5';
const API_RID = 'c0ffee00-1111-4222-8333-944455566677';
const USER = '0193b0c1-d2e3-7f40-8a51-6b7c8d9e0f1a';
const CARD = '0193b1c2-d3e4-7f50-9a61-7b8c9d0e1f2a';
const SWITCH_URI = 'http://switch.pay.example:11101/v3/cards/info';

/** Запись шлюза с сырым HTTP-запросом партнёра. */
function gatewayLine(local: string): LogLine {
  const http = [
    `GET /v1/users/${USER}/cards/${CARD} HTTP/1.1`,
    'Host: api.pay.example',
    'Authorization: Bearer ***',
    `X-Correlation-Id: ${API_CID}`,
    `X-Request-Id: ${API_RID}`,
  ].join('\r\n');
  const gw = { time: `${local}${OFFSET}`, level: 'debug', msg: 'request received', raw_request: `${http}\r\n\r\n` };
  return logLine(nsAfter(local, 1), line(gw), GATEWAY_LABELS);
}

/** Запрос api через шлюз: вход, лог, отправка в коммутатор и ответ. Всего 33 мс, обмен — 13 мс. */
function apiViaGateway(): LogLine[] {
  return [
    gatewayLine('2026-11-02T15:24:52.100000'),
    record(app('db query', { step: 'db', duration_ms: 4, ctx: { host: 'db.pay.example' } }, '2026-11-02T15:24:52.110000', API_CID), API_LABELS),
    record(app('http request sending', { request_id: API_RID, upstream: { method: 'POST', url: SWITCH_URI, body: '{"id":"1","params":{"mb_flag":1}}' } }, '2026-11-02T15:24:52.118000', API_CID), API_LABELS),
    record(app('http response received', { request_id: API_RID, upstream: { method: 'POST', url: SWITCH_URI, status: 200, body: '{"id":"1","result":{}}' } }, '2026-11-02T15:24:52.131000', API_CID), API_LABELS),
    record(app('card info returned', { ctx: { ok: true } }, '2026-11-02T15:24:52.133000', API_CID), API_LABELS),
  ];
}

const send = (url: string, time: string, rid = API_RID) =>
  record(app('http request sending', { request_id: rid, upstream: { method: 'POST', url, body: '{}' } }, time, API_CID), API_LABELS);
const response = (url: string, time: string, status = 200, rid = API_RID) =>
  record(app('http response received', { request_id: rid, upstream: { method: 'POST', url, status, body: '{}' } }, time, API_CID), API_LABELS);

describe('buildTrace: сервис карт и вызовы процессинга', () => {
  it('вход → вызов getCard → обмен с процессингом', () => {
    const t = buildTrace(view(cardsLookup()));
    expect(kinds(t)).toEqual(['incoming', '  call', '    exchange']);
    const [incoming, call, exchange] = t.steps as [TraceStep, TraceStep, TraceStep];
    expect(incoming).toMatchObject({ parentId: null, title: 'POST /v1/cards/lookup', system: 'cards', startMs: 0 });
    expect(incoming.endMs).toBe(t.totalMs);
    expect(call).toMatchObject({ parentId: incoming.id, title: 'getCard', system: 'cards' });
    expect(exchange).toMatchObject({
      parentId: call.id,
      title: 'POST /soap/issuing',
      system: 'processor.pay.example',
      status: 200,
      isError: false,
      noResponse: false,
    });
    expect(exchange.durationMs).toBeCloseTo(312, 3);
    expect(exchange.recordIds).toHaveLength(2);
    // Вызов кончается вместе с последним вложенным обменом.
    expect(call.endMs).toBe(exchange.endMs);
    expect(call.durationMs).toBeCloseTo(exchange.endMs - call.startMs, 3);
    expect(t.totalMs).toBeCloseTo(318.628, 3);
    expect(t.externalMs).toBeCloseTo(312, 3);
    expect(t.chain).toEqual(['cards', 'processor.pay.example']);
    expect(t.startTimeMs).toBe(view(cardsLookup())[0]!.timeMs);
  });

  it('ответ процессинга с response_code 8 — обмен с ошибкой', () => {
    const t = buildTrace(view(cardsLookup('<ResponseInfo><response_code>8</response_code><error_description>PRC-ERR-0027 Card not found</error_description></ResponseInfo>')));
    expect(byKind(t, 'exchange')[0]).toMatchObject({ isError: true, status: 200 });
    expect(byKind(t, 'call')[0]!.isError).toBe(false);
  });

  it('второй вызов с тем же request_id забирает свои отправки', () => {
    const second = [
      record(app('processor call', { request_id: CARDS_CID, action: 'getCardholder', payload: [] }, '2026-10-28T16:20:30.300000', CARDS_CID)),
      record(app('http request sending', { request_id: CARDS_CID, upstream: { method: 'POST', url: PROCESSOR_URI, body: '<a/>' } }, '2026-10-28T16:20:30.302000', CARDS_CID)),
      record(app('http response received', { request_id: CARDS_CID, upstream: { method: 'POST', url: PROCESSOR_URI, status: 200, body: '<b/>' } }, '2026-10-28T16:20:30.402000', CARDS_CID)),
    ];
    const t = buildTrace(view([...cardsLookup(), ...second]));
    expect(kinds(t)).toEqual(['incoming', '  call', '    exchange', '  call', '    exchange']);
    const calls = byKind(t, 'call');
    const exchanges = byKind(t, 'exchange');
    expect(calls.map((c) => c.title)).toEqual(['getCard', 'getCardholder']);
    expect(exchanges[1]!.parentId).toBe(calls[1]!.id);
    expect(calls[1]!.durationMs).toBeCloseTo(102, 3);
    expect(t.chain).toEqual(['cards', 'processor.pay.example']);
  });
});

describe('buildTrace: запрос api через шлюз', () => {
  it('вход от шлюза — корень, обмен с коммутатором вложен во вход, цепочка «шлюз → api → коммутатор»', () => {
    const t = buildTrace(view(apiViaGateway()));
    expect(kinds(t)).toEqual(['incoming', '  log', '  exchange', '  log']);
    const incoming = t.steps[0]!;
    expect(incoming).toMatchObject({ kind: 'incoming', system: 'gateway', startMs: 0, endMs: 33, durationMs: 33 });
    expect(incoming.title).toBe(`GET /v1/users/${USER}/cards/${CARD}`);
    const sw = byKind(t, 'exchange')[0]!;
    expect(sw).toMatchObject({ parentId: incoming.id, depth: 1, system: 'switch.pay.example', title: 'POST /v3/cards/info', status: 200 });
    expect(sw.startMs).toBeCloseTo(18, 3);
    expect(sw.durationMs).toBeCloseTo(13, 3);
    expect(t.totalMs).toBeCloseTo(33, 3);
    expect(t.externalMs).toBeCloseTo(13, 3);
    expect(t.chain).toEqual([GATEWAY_LABEL, 'api', 'switch.pay.example']);
  });

  it('вход — корень, даже если запись шлюза по времени позже первой записи приложения', () => {
    const lines = apiViaGateway();
    lines[0] = gatewayLine('2026-11-02T15:24:52.112000');
    const t = buildTrace(view(lines));
    expect(t.steps[0]).toMatchObject({ kind: 'incoming', startMs: 0, endMs: t.totalMs });
    expect(t.steps.slice(1).every((s) => s.parentId === t.steps[0]!.id)).toBe(true);
  });
});

describe('buildTrace: обмены без пары', () => {
  it('отправка без ответа идёт до конца запроса с пометкой', () => {
    const lines = [
      gatewayLine('2026-11-02T15:24:52.100000'),
      send('http://fraud.pay.example:9090/', '2026-11-02T15:24:52.110000'),
      record(app('Circuit breaker opened', { ctx: { service: 'fraud' } }, '2026-11-02T15:25:22.110000', API_CID, 300), API_LABELS),
    ];
    const t = buildTrace(view(lines));
    const ex = byKind(t, 'exchange')[0]!;
    expect(ex).toMatchObject({ system: 'fraud.pay.example', title: 'POST /', noResponse: true, pending: false, durationMs: null, status: null });
    expect(ex.startMs).toBeCloseTo(10, 3);
    expect(ex.endMs).toBe(t.totalMs);
    expect(t.externalMs).toBeCloseTo(t.totalMs - 10, 3);
    const warning = byKind(t, 'log')[0]!;
    expect(warning).toMatchObject({ isError: true, title: 'Circuit breaker opened' });
  });

  it('pending берётся из записи отправки', () => {
    const records = view([gatewayLine('2026-11-02T15:24:52.100000'), send(SWITCH_URI, '2026-11-02T15:24:52.110000')]);
    records[1] = { ...records[1]!, http: { ...records[1]!.http!, pending: true } };
    expect(byKind(buildTrace(records), 'exchange')[0]).toMatchObject({ noResponse: true, pending: true });
  });

  it('ответ без отправки — обмен нулевой длины', () => {
    const t = buildTrace(view([gatewayLine('2026-11-02T15:24:52.100000'), response(SWITCH_URI, '2026-11-02T15:24:52.120000', 502)]));
    const ex = byKind(t, 'exchange')[0]!;
    expect(ex).toMatchObject({ status: 502, isError: true, noResponse: false, durationMs: null, parentId: t.steps[0]!.id });
    expect(ex.startMs).toBe(ex.endMs);
    expect(ex.recordIds).toHaveLength(1);
    expect(t.externalMs).toBe(0);
  });

  it('время во внешних системах — объединение отрезков без перекрытий', () => {
    const a = 'http://a.pay.example/x';
    const b = 'http://b.pay.example/y';
    const c = 'http://c.pay.example/z';
    const t = buildTrace(
      view([
        gatewayLine('2026-11-02T15:24:52.000000'),
        send(a, '2026-11-02T15:24:52.010000'),
        send(b, '2026-11-02T15:24:52.020000'),
        response(b, '2026-11-02T15:24:52.040000'),
        response(a, '2026-11-02T15:24:52.050000'),
        send(c, '2026-11-02T15:24:52.060000'),
        response(c, '2026-11-02T15:24:52.070000'),
      ]),
    );
    expect(byKind(t, 'exchange').map((e) => [e.system, e.startMs, e.endMs])).toEqual([
      ['a.pay.example', 10, 50],
      ['b.pay.example', 20, 40],
      ['c.pay.example', 60, 70],
    ]);
    expect(t.externalMs).toBe(50);
    expect(t.chain).toEqual([GATEWAY_LABEL, 'api', 'a.pay.example', 'b.pay.example', 'c.pay.example']);
  });
});

describe('buildTrace: логи и края', () => {
  it('логи — точки внутри входа; текст и обрезанная строка не теряются', () => {
    const lines = [
      ...cardsLookup(),
      logLine(nsAfter('2026-10-28T16:20:30.300000'), GIN_TEXT),
      logLine(nsAfter('2026-10-28T16:20:30.310000'), BROKEN_LINE),
    ];
    const records = view(lines);
    const t = buildTrace(records);
    const logs = byKind(t, 'log');
    expect(logs).toHaveLength(2);
    for (const l of logs) {
      expect(l.startMs).toBe(l.endMs);
      expect(l.durationMs).toBeNull();
      expect(l.parentId).toBe(t.steps[0]!.id);
    }
    expect(logs[0]!.title).toBe(GIN_TEXT);
    expect(logs[1]!.title).toContain('incoming req');
    // Каждая запись есть хотя бы в одном шаге.
    expect(new Set(t.steps.flatMap((s) => s.recordIds))).toEqual(new Set(records.map((r) => r.id)));
  });

  it('фоновый запрос без входа: шаги в корне', () => {
    const t = buildTrace(view([send(SWITCH_URI, '2026-11-02T15:24:52.000000'), response(SWITCH_URI, '2026-11-02T15:24:52.020000')]));
    expect(kinds(t)).toEqual(['exchange']);
    expect(t.steps[0]).toMatchObject({ parentId: null, depth: 0, startMs: 0, endMs: 20 });
    expect(t.chain).toEqual(['api', 'switch.pay.example']);
  });

  it('пустой запрос', () => {
    expect(buildTrace([])).toEqual({ steps: [], totalMs: 0, externalMs: 0, chain: [], startTimeMs: 0 });
  });

  it('хост и путь адреса', () => {
    expect(hostOf('http://192.0.2.41:11101/v3/cards/info')).toBe('192.0.2.41');
    expect(hostOf('https://user:pw@processor.pay.example:8443')).toBe('processor.pay.example');
    expect(hostOf('https://[::1]:8443/x')).toBe('[::1]');
    expect(hostOf('fraud.pay.example:9090/')).toBe('fraud.pay.example');
    expect(hostOf('/relative/path')).toBeNull();
    expect(hostOf(null)).toBeNull();
    expect(pathOf('http://switch.pay.example:11101/v3/cards/info?x=1')).toBe('/v3/cards/info');
    expect(pathOf('https://processor-balance.pay.example:8443')).toBe('/');
    expect(pathOf('/v1/x')).toBe('/v1/x');
  });
});
