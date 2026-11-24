import { describe, expect, it } from 'vitest';
import type { LogLine } from '../backend/index.ts';
import { maskDeep } from './masking.ts';
import { buildView, parseDatetime, parseLine, RAW_TITLE, type ParsedRecord } from './records.ts';
import {
  API_LABELS,
  app,
  BROKEN_LINE,
  cardsLookup,
  CARDS_CID,
  CARDS_LABELS,
  GIN_TEXT,
  ginLine,
  line,
  localMs,
  logLine,
  nsAfter,
  OFFSET,
  PROCESSOR_HEADERS,
  PROCESSOR_URI,
  record,
  SWITCH_CID,
  switchCardBody,
  switchResponseLine,
} from './test-fixtures.ts';

const parseAll = (lines: LogLine[]) => lines.map(parseLine);
const view = (lines: LogLine[], withOffsets = true) => buildView(parseAll(lines), { withOffsets });

describe('parseDatetime', () => {
  it('микросекунды и смещение +05:00', () => {
    expect(parseDatetime('2026-10-30T16:49:15.486322+05:00')).toBeCloseTo(
      Date.UTC(2026, 9, 30, 11, 49, 15, 486) + 0.322,
      6,
    );
    expect(parseDatetime('2026-10-30T11:49:15.5Z')).toBe(Date.UTC(2026, 9, 30, 11, 49, 15, 500));
    expect(parseDatetime('2026-10-30T13:49:15-0300')).toBe(Date.UTC(2026, 9, 30, 16, 49, 15));
  });

  it('неразборчивое время — null', () => {
    expect(parseDatetime('30.10.2026 16:49')).toBeNull();
    expect(parseDatetime('2026-10-30T16:49:15')).toBeNull();
    expect(parseDatetime({ date: '2026-10-30 16:49:15.486322', timezone: 'Asia/Karachi' })).toBeNull();
    expect(parseDatetime(undefined)).toBeNull();
  });
});

describe('parseLine: встроенный формат json', () => {
  it('ответ коммутатора: тело — строка JSON внутри записи', () => {
    const l = switchResponseLine();
    const r = parseLine(l);
    expect(r).toMatchObject({
      tsNs: l.tsNs,
      kind: 'response',
      message: 'http response received',
      level: 'INFO',
      levelNum: 200,
      correlationId: SWITCH_CID,
      requestId: 'd5258298-5586-4a80-9cbd-67d49e7f5b1c',
      labels: API_LABELS,
      line: l.line,
    });
    expect(r.timeMs).toBeCloseTo(Date.UTC(2026, 9, 30, 11, 49, 15, 486) + 0.322, 6);
    expect(r.status).toBe(200);
    // Тело ответа — строка JSON в upstream.body.
    expect(JSON.parse(String(r.body)).result.card.primaryAccountNumber).toBe('5100123440473348');
  });

  it('целые больше 2^53 в записи — исходные цифры строкой: номер карты числом маскируется, длинный id точен', () => {
    const card = '9999000000000053'; // проходит проверку Луна, Number() округлил бы до …052
    const id = '12345678901234567';
    const text = JSON.stringify(
      app('processor call', { request_id: 'r', action: 'getCard', payload: [{ CARD: '@CARD@' }], ctx: { someId: '@ID@' } }, '2026-10-28T16:20:29.100000', 'c'),
    )
      .replace('"@CARD@"', card)
      .replace('"@ID@"', id);
    const r = parseLine(logLine(nsAfter('2026-10-28T16:20:29.100000'), text, API_LABELS));
    expect(r.payload).toEqual([{ CARD: card }]);
    expect(r.context?.someId).toBe(id);
    expect(r.requestId).toBe('r');
    const out = JSON.stringify(maskDeep(buildView([r], { withOffsets: true }), new Set()));
    expect(out).toContain('999900******0053');
    expect(out).not.toContain('99990000000000');
    expect(out).toContain(id);
  });

  it('заголовок записи маскируется до обрезки: номер карты и секрет на границе 200 символов', () => {
    const pan = '5555551234517894'; // проходит проверку Луна
    const lines = [
      `${'x'.repeat(178)} card ${pan} declined`,
      `${'w'.repeat(170)}{"cardholderPassword":"golden sun"}`,
      `${'y'.repeat(158)}{"primaryAccountNumber":"5100123440473348"}`,
    ].map((m, i) => record(app(m, {}, `2026-10-28T16:20:29.${i}00000`, 'c', 400), API_LABELS));
    for (const v of view(lines)) {
      expect(v.title.length).toBeLessThanOrEqual(200);
      expect(v.title).not.toMatch(/\d{13,}/);
      expect(v.title).not.toContain('golden');
    }
    // Входящая запись с номером карты в длинном пути.
    const incoming = record(
      app('incoming request', { request_id: 'i', request: { method: 'GET', path: `/v1/${'p/'.repeat(90)}${pan}/x`, body: '""' } }, '2026-10-28T16:20:29.500000', 'i'),
      API_LABELS,
    );
    expect(view([incoming])[0]!.title).not.toMatch(/\d{13,}/);
  });

  it('вид записи по полям', () => {
    const [incoming, call, send, response] = parseAll(cardsLookup());
    expect(incoming).toMatchObject({ kind: 'incoming', correlationId: CARDS_CID, requestId: CARDS_CID });
    expect(call?.kind).toBe('call');
    expect(send?.kind).toBe('send');
    expect(response?.kind).toBe('response');
    const db = parseLine(record(app('db query', { step: 'db', duration_ms: 230, ctx: { host: 'db', port: '5432' } }, '2026-10-28T16:20:29.930000', 'x')));
    expect(db.kind).toBe('log');
  });

  it('время из поля time записи, а не время Loki', () => {
    const [incoming] = cardsLookup();
    const r = parseLine(incoming!);
    expect(r.timeMs).toBeCloseTo(localMs('2026-10-28T16:20:29.921030'), 6);
    expect(r.timeMs).toBeLessThan(Number(BigInt(incoming!.tsNs) / 1_000_000n));
  });

  it('без времени в записи время берётся из tsNs', () => {
    const m = app('job done', {}, '2026-10-28T16:20:29.921030', 'x');
    delete m.time;
    const r = parseLine(logLine('1793180429955538034', line(m)));
    expect(r.kind).toBe('log');
    expect(r.timeMs).toBeCloseTo(1793180429955 + 0.538034, 3);
  });

  it('уровень по имени и по числу', () => {
    const err = parseLine(record(app('acquirer payment failed', { ctx: { exception: { code: 500 } } }, '2026-10-28T16:20:30.100000', 'x', 400)));
    expect(err).toMatchObject({ level: 'ERROR', levelNum: 400 });
    const onlyNum = { ...app('m', {}, '2026-10-28T16:20:30.100000', 'x'), level: 300 };
    expect(parseLine(logLine('1', line(onlyNum)))).toMatchObject({ level: 'WARNING', levelNum: 300 });
    const onlyName = { ...app('m', {}, '2026-10-28T16:20:30.100000', 'x'), level: 'critical' };
    expect(parseLine(logLine('1', line(onlyName)))).toMatchObject({ level: 'CRITICAL', levelNum: 500 });
    const none = app('m', {}, '2026-10-28T16:20:30.100000', 'x');
    delete none.level;
    expect(parseLine(logLine('1', line(none)))).toMatchObject({ level: null, levelNum: null });
  });

  it('пустой контекст массивом и запись без correlation_id', () => {
    const m = { time: `2026-10-28T16:20:29.921030${OFFSET}`, level: 'info', msg: 'db query', ctx: [] };
    const r = parseLine(logLine('1', line(m)));
    expect(r).toMatchObject({ kind: 'log', context: null, correlationId: null, requestId: null });
  });

  it('строка доступа шлюза [GIN] — текст', () => {
    const l = ginLine();
    const r = parseLine(l);
    expect(r).toMatchObject({
      kind: 'text',
      message: GIN_TEXT,
      correlationId: null,
      level: null,
      context: null,
    });
    expect(r.timeMs).toBe(Number(BigInt(l.tsNs) / 1_000_000n));
  });

  it('PHP Warning и JSON без сообщения — текст; поле message вместо msg — запись', () => {
    const php = 'PHP Warning:  Undefined array key "pan" in /app/src/Service/CardService.php on line 88';
    expect(parseLine(logLine('1', php))).toMatchObject({ kind: 'text', message: php });
    expect(parseLine(logLine('1', '{"foo":1}'))).toMatchObject({ kind: 'text', message: '{"foo":1}' });
    expect(parseLine(logLine('1', '{"msg":null}'))).toMatchObject({ kind: 'text', message: '{"msg":null}' });
    expect(parseLine(logLine('1', '{"message":"x"}'))).toMatchObject({ kind: 'log', message: 'x' });
  });

  it('JSON без поля сообщения — текст со строкой целиком', () => {
    const text = '{"time":"2026-10-28T16:20:29.955538+05:00","stream":"stderr"}';
    expect(parseLine(logLine('1', text))).toMatchObject({ kind: 'text', message: text });
  });

  it('битая строка и строка не объект JSON — текст как есть; пустая строка — не разобрана', () => {
    const r = parseLine(logLine('1793180955495787352', BROKEN_LINE));
    expect(r).toMatchObject({ kind: 'text', message: BROKEN_LINE, line: BROKEN_LINE, correlationId: null });
    expect(r.timeMs).toBeCloseTo(1793180955495 + 0.787352, 3);
    expect(parseLine(logLine('1', '42'))).toMatchObject({ kind: 'text', message: '42' });
    expect(parseLine(logLine('1', '[1,2]')).kind).toBe('text');
    expect(parseLine(logLine('1', '')).kind).toBe('raw');
  });
});

describe('buildView', () => {
  it('запрос сервиса карт: заголовки записей, блоки и связь с процессингом', () => {
    const v = view(cardsLookup());
    expect(v.map((r) => [r.kind, r.title])).toEqual([
      ['incoming', 'POST /v1/cards/lookup'],
      ['call', 'getCard'],
      ['send', 'POST processor.pay.example:8443/soap/issuing'],
      ['response', 'POST processor.pay.example:8443/soap/issuing → 200'],
    ]);
    const [incoming, call, send, response] = v;

    expect(incoming!.http).toEqual({
      method: 'POST',
      uri: '/v1/cards/lookup',
      status: null,
      durationMs: null,
      pairId: null,
      noResponse: false,
      pending: false,
    });
    expect(incoming!.sections).toEqual({
      headers: null,
      body: '{"card_tokens":["400000ABCDEF1234","400000GHIJKL5678"]}',
      payload: null,
      context: null,
    });

    expect(call!.http).toBeNull();
    expect(call!.sections.payload).toEqual([
      {
        issuerCode: '01',
        groupCode: '02',
        sessionId: '019a2b3c-4d5e-7f60-8a71-b2c3d4e5f607',
      },
      { CARD: '400000ABCDEF1234' },
    ]);

    expect(send!.sections.headers).toEqual(PROCESSOR_HEADERS);
    expect(send!.sections.body).toContain('<ns1:getCard>');
    expect(send!.http).toEqual({
      method: 'POST',
      uri: PROCESSOR_URI,
      status: null,
      durationMs: 312,
      pairId: response!.id,
      noResponse: false,
      pending: false,
    });
    expect(response!.http).toMatchObject({
      status: 200,
      durationMs: 312,
      pairId: send!.id,
      noResponse: false,
    });

    for (const r of v) {
      expect(r).toMatchObject({
        component: 'cards',
        correlationId: CARDS_CID,
        requestId: CARDS_CID,
        isError: false,
        match: null,
      });
    }
  });

  it('смещение от первой записи с дробью мс', () => {
    const lines = [
      record(app('incoming request', { request: { method: 'GET', path: '/v1/x', body: '""' } }, '2026-10-28T16:20:29.900000', 'c')),
      record(app('step', {}, '2026-10-28T16:20:29.931400', 'c')),
    ];
    expect(view(lines).map((r) => r.offsetMs)).toEqual([0, 31.4]);
    expect(view(lines, false).map((r) => r.offsetMs)).toEqual([null, null]);
  });

  it('порядок по времени записи, при равенстве — по времени Loki; id стабильны', () => {
    const a = record(app('a', {}, '2026-10-28T16:20:29.950000', 'c'), CARDS_LABELS, 1);
    const b = record(app('b', {}, '2026-10-28T16:20:29.940000', 'c'), CARDS_LABELS, 20);
    const c1 = logLine('1793180429960000001', line(app('c1', {}, '2026-10-28T16:20:29.960000', 'c')));
    const c2 = logLine('1793180429960000000', line(app('c2', {}, '2026-10-28T16:20:29.960000', 'c')));
    const v = view([a, c1, b, c2]);
    expect(v.map((r) => r.message)).toEqual(['b', 'a', 'c2', 'c1']);
    expect(v.map((r) => r.id)).toEqual([`${b.tsNs}-0`, `${a.tsNs}-1`, `${c2.tsNs}-2`, `${c1.tsNs}-3`]);
    expect(view([c2, b, c1, a]).map((r) => r.id)).toEqual(v.map((r) => r.id));
  });

  it('отправка без ответа', () => {
    const send = record(
      app(
        'http request sending',
        { request_id: 'r1', upstream: { method: 'POST', url: 'http://fraud.pay.example:9090/', body: '{"jsonrpc":"2.0","method":"risk.check","id":7}' } },
        '2026-10-28T16:20:29.950000',
        'c',
      ),
      API_LABELS,
    );
    const [r] = view([send]);
    expect(r!.title).toBe('POST fraud.pay.example:9090/');
    expect(r!.http).toEqual({
      method: 'POST',
      uri: 'http://fraud.pay.example:9090/',
      status: null,
      durationMs: null,
      pairId: null,
      noResponse: true,
      pending: false,
    });
    expect(r!.isError).toBe(false);
  });

  const exchange = (msg: 'send' | 'resp', rid: string | null, at: string, url = 'http://ledger.pay.example:8080/v1/payments/charge') =>
    record(
      app(
        msg === 'send' ? 'http request sending' : 'http response received',
        {
          ...(rid ? { request_id: rid } : {}),
          upstream: { method: 'POST', url, ...(msg === 'resp' ? { status: 200, body: '{"result":"success"}' } : {}) },
        },
        at,
        'c',
      ),
      API_LABELS,
    );

  it('два одновременных обмена с одним адресом связываются по request_id', () => {
    const v = view([
      exchange('send', 'A', '2026-10-28T16:20:29.100000'),
      exchange('send', 'B', '2026-10-28T16:20:29.200000'),
      exchange('resp', 'A', '2026-10-28T16:20:29.500000'),
      exchange('resp', 'B', '2026-10-28T16:20:29.700000'),
    ]);
    const [sendA, sendB, respA, respB] = v;
    expect(respA!.http).toMatchObject({ pairId: sendA!.id, durationMs: 400 });
    expect(respB!.http).toMatchObject({ pairId: sendB!.id, durationMs: 500 });
    expect(sendA!.http).toMatchObject({ pairId: respA!.id, noResponse: false });
    expect(sendB!.http).toMatchObject({ pairId: respB!.id, noResponse: false });
  });

  it('с одним request_id ответ берёт последнюю неотвеченную отправку', () => {
    const v = view([
      exchange('send', CARDS_CID, '2026-10-28T16:20:29.100000'),
      exchange('send', CARDS_CID, '2026-10-28T16:20:29.200000'),
      exchange('resp', CARDS_CID, '2026-10-28T16:20:29.300000'),
      exchange('resp', CARDS_CID, '2026-10-28T16:20:29.400000'),
    ]);
    const [first, second, resp1, resp2] = v;
    expect(resp1!.http?.pairId).toBe(second!.id);
    expect(resp2!.http?.pairId).toBe(first!.id);
    expect(resp2!.http?.durationMs).toBe(300);
  });

  it('без совпадения request_id — по адресу; другой адрес не связывается', () => {
    const v = view([
      exchange('send', 'A', '2026-10-28T16:20:29.100000'),
      exchange('send', 'B', '2026-10-28T16:20:29.150000', 'http://other.example/x'),
      exchange('resp', null, '2026-10-28T16:20:29.300000'),
      exchange('resp', 'Z', '2026-10-28T16:20:29.400000', 'http://third.example/y'),
    ]);
    const [sendA, sendB, resp, orphan] = v;
    expect(resp!.http?.pairId).toBe(sendA!.id);
    expect(sendB!.http).toMatchObject({ noResponse: true, pairId: null });
    expect(orphan!.http).toMatchObject({ pairId: null, durationMs: null, noResponse: false });
  });

  it('ответ раньше отправки не связывается', () => {
    const v = view([exchange('resp', 'A', '2026-10-28T16:20:29.100000'), exchange('send', 'A', '2026-10-28T16:20:29.200000')]);
    expect(v[0]!.http?.pairId).toBeNull();
    expect(v[1]!.http?.noResponse).toBe(true);
  });

  it('ошибка записи: уровень, HTTP-статус, бизнес-код ответа', () => {
    const v = view([
      record(app('Circuit breaker opened', { ctx: { service: 'fraud' } }, '2026-10-28T16:20:29.100000', 'c', 300), API_LABELS),
      record(app('debug', {}, '2026-10-28T16:20:29.150000', 'c', 250), API_LABELS),
      record(app('http response received', { upstream: { method: 'POST', url: 'https://api.acquirer.example/api/payments', status: 500, body: '{}' } }, '2026-10-28T16:20:29.200000', 'c'), API_LABELS),
      record(
        app(
          'http response received',
          { upstream: { method: 'POST', url: 'http://ledger.pay.example:8080/v1/payments/charge', status: 200, body: '{"result":"error","error":{"code":12,"message":"x"}}' } },
          '2026-10-28T16:20:29.300000',
          'c',
        ),
        API_LABELS,
      ),
      record(app('http response received', { upstream: { method: 'POST', url: PROCESSOR_URI, status: 200, body: switchCardBody() } }, '2026-10-28T16:20:29.400000', 'c'), API_LABELS),
    ]);
    expect(v.map((r) => r.isError)).toEqual([true, false, true, true, false]);
    expect(v[2]!.title).toBe('POST api.acquirer.example/api/payments → 500');
  });

  it('остальной контекст без собственных полей', () => {
    const [db] = view([record(app('db query', { request_id: 'r', step: 'db', duration_ms: 230, ctx: { host: 'db-pay', port: '5432' } }, '2026-10-28T16:20:29.100000', 'c'), API_LABELS)]);
    expect(db).toMatchObject({ kind: 'log', title: 'db query', component: 'api' });
    expect(db!.sections).toEqual({
      headers: null,
      body: null,
      payload: null,
      context: { host: 'db-pay', port: '5432' },
    });
    const [err] = view([record(app('cURL error 28', { request_id: 'r', action: 'x', upstream: null, ctx: { exception: { code: 28 } } }, '2026-10-28T16:20:29.100000', 'c', 400))]);
    expect(err!.sections.context).toEqual({ exception: { code: 28 } });
  });

  it('заголовки и тело входящего запроса из request', () => {
    const [r] = view([
      record(
        app(
          'incoming request',
          { request_id: 'c', request: { method: 'POST', path: '/v1/users', headers: { 'X-Request-Id': ['abc'] }, body: { phone: '+447700900234' } } },
          '2026-10-28T16:20:29.100000',
          'c',
        ),
        API_LABELS,
      ),
    ]);
    expect(r!.sections.headers).toEqual({ 'X-Request-Id': ['abc'] });
    expect(r!.sections.body).toBe('{"phone":"+447700900234"}');
  });

  it('строка [GIN], PHP Warning, битая и пустая строки не теряются', () => {
    const php = 'PHP Warning:  Undefined array key "pan" in /app/src/Service/CardService.php on line 88';
    const v = view([
      ginLine(),
      logLine(nsAfter('2026-10-28T16:20:29.950000'), php, API_LABELS),
      logLine(nsAfter('2026-10-28T16:20:29.990000'), BROKEN_LINE, CARDS_LABELS),
      logLine(nsAfter('2026-10-28T16:20:29.995000'), '', CARDS_LABELS),
    ]);
    expect(v.map((r) => [r.kind, r.title])).toEqual([
      ['text', php],
      ['text', GIN_TEXT],
      ['text', BROKEN_LINE],
      ['raw', RAW_TITLE],
    ]);
    expect(v[1]).toMatchObject({
      component: 'gateway',
      correlationId: null,
      http: null,
      level: null,
      isError: false,
    });
    expect(v[2]).toMatchObject({ raw: BROKEN_LINE, message: BROKEN_LINE, component: 'cards' });
    expect(v[2]!.sections).toEqual({ headers: null, body: null, payload: null, context: null });
  });

  it('длинное сообщение в заголовке обрезается до 200 символов', () => {
    const long = 'x'.repeat(500);
    const [r] = view([logLine('1', long)]);
    expect(r!.title).toHaveLength(200);
    expect(r!.message).toBe(long);
  });

  it('компонент — container, иначе app_kubernetes_io_component', () => {
    const at = '2026-10-28T16:20:29.100000';
    const v = view([
      logLine(nsAfter(at), line(app('a', {}, at, 'c')), { app_kubernetes_io_component: 'worker' }),
      logLine(nsAfter(at, 4), line(app('b', {}, at, 'c')), {}),
    ]);
    expect(v.map((r) => r.component)).toEqual(['worker', null]);
  });

  it('пустой список', () => {
    expect(buildView([], { withOffsets: true })).toEqual([]);
  });

  it('не меняет входные записи', () => {
    const parsed: ParsedRecord[] = parseAll(cardsLookup()).reverse();
    const copy = structuredClone(parsed);
    buildView(parsed, { withOffsets: true });
    expect(parsed).toEqual(copy);
  });
});

describe('значения видов маски в заголовке', () => {
  const rec = (message: string): ParsedRecord => parseLine(logLine('1777000000000000000', line({ time: `2026-10-28T12:00:00.000000${OFFSET}`, level: 'info', msg: message, correlation_id: 'c1' }), API_LABELS));
  it('телефон на границе 200 символов не оставляет начала; без персональных данных текст прежний', () => {
    const [v] = buildView([rec(`${'x'.repeat(195)} +447700900001 конец`)], { withOffsets: true });
    expect(v!.title).not.toContain('4477');
    expect(v!.title.length).toBeLessThanOrEqual(200);
    const plain = `${'y'.repeat(50)} обычный текст`;
    expect(buildView([rec(plain)], { withOffsets: true })[0]!.title).toBe(plain);
  });
});
