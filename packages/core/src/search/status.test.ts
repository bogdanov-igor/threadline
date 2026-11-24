import { describe, expect, it } from 'vitest';
import type { LogLine } from '../backend/index.ts';
import { businessFact } from './business.ts';
import { buildView, parseLine } from './records.ts';
import {
  businessError,
  markPending,
  NO_RESPONSE_AFTER_MS,
  summarize,
  type SummarizeOptions,
} from './status.ts';
import { API_LABELS, app, cardsLookup, CARDS_CID, CARDS_LABELS, GATEWAY_LABELS, localMs, record, soap, switchCardBody } from './test-fixtures.ts';

const parseAll = (lines: LogLine[]) => lines.map(parseLine);
const done = (readEndMs = localMs('2026-10-28T17:00:00.000000')): SummarizeOptions => ({
  match: 'exact',
  readEndMs,
  incomplete: false,
});

/** Вход запроса в сервис: запись приложения с объектом request. */
const incoming = (method: string, path: string, body: string, at: string, cid: string, extra: Record<string, unknown> = {}) =>
  record(app('incoming request', { ...extra, request: { method, path, body } }, at, cid), API_LABELS);
/** Отправка вызова: upstream без статуса. */
const sending = (rid: string, url: string, at: string, cid: string, extra: Record<string, unknown> = {}) =>
  record(app('http request sending', { request_id: rid, upstream: { method: 'POST', url, ...extra } }, at, cid), API_LABELS);
/** Ответ вызова: upstream со статусом и телом. */
const received = (rid: string, url: string, status: number, body: string, at: string, cid: string) =>
  record(app('http response received', { request_id: rid, upstream: { method: 'POST', url, status, body } }, at, cid), API_LABELS);

describe('businessError: признаки в JSON', () => {
  it('result:error с кодом и текстом', () => {
    expect(
      businessError(
        '{"result":"error","data":null,"error":{"code":12,"message":"Insufficient funds on account"}}',
      ),
    ).toBe('error 12: Insufficient funds on account');
    expect(businessError('{"result":"error","data":null,"error":null}')).toBe('result: error');
    expect(businessError('{"result":"success","data":{"payment_id":"x"},"error":null}')).toBeNull();
  });

  it('success рядом с непустым error', () => {
    expect(
      businessError(
        '{"result":"success","from_cache":false,"data":null,"error":{"code":"TDF-404","message":"Bill date not found"}}',
      ),
    ).toBe('error TDF-404: Bill date not found');
    expect(
      businessError('{"result":"success","from_cache":true,"data":{"date":"2026-11-15"},"error":null}'),
    ).toBeNull();
    expect(businessError('{"result":"success","error":{}}')).toBeNull();
    expect(businessError('{"error":"invalid_client"}')).toBe('error: invalid_client');
    expect(businessError('{"error":""}')).toBeNull();
  });

  it('success:false', () => {
    expect(businessError('{"success":false,"statusCode":400,"errors":[{"message":"Invalid amount"}]}')).toBe(
      'success false: Invalid amount',
    );
    expect(businessError('{"success":false}')).toBe('success: false');
    expect(businessError('{"success":true,"data":{}}')).toBeNull();
  });

  it('success:false с объектом error', () => {
    expect(
      businessError(
        '{"success":false,"error":{"systemName":"transit","message":"Method not allowed","code":405}}',
      ),
    ).toBe('error 405: Method not allowed');
  });

  it('поле res сети выплат', () => {
    expect(businessError('{"res":5,"error":null,"data":null}')).toBe('res: 5');
    expect(businessError('{"res":0,"error":null,"data":{"state":"completed"}}')).toBeNull();
    expect(businessError('{"res":"0","error":null}')).toBeNull();
  });

  it('проверка личности: result_code', () => {
    expect(businessError('{"result_code":"BAD"}')).toBe('result_code: BAD');
    expect(businessError('{"result_code":"GOOD"}')).toBeNull();
  });

  it('3DS transStatus', () => {
    expect(businessError('{"threeDSServerTransID":"x","transStatus":"N","transStatusReason":"05"}')).toBe(
      'transStatus N: 05',
    );
    expect(businessError('{"transStatus":"Y"}')).toBeNull();
  });

  it('вложенный код resultInfo.code', () => {
    expect(businessError('{"resultInfo":{"code":5,"message":"Payment not found"}}')).toBe('resultInfo.code 5: Payment not found');
    expect(businessError('{"resultInfo":{"code":"0"}}')).toBeNull();
  });

  it('JSON-RPC error', () => {
    expect(businessError('{"jsonrpc":"2.0","id":7,"error":{"code":-202,"message":"Card not found"}}')).toBe(
      'error -202: Card not found',
    );
    expect(businessError('{"jsonrpc":"2.0","id":7,"result":{"CARDSTATUS":0}}')).toBeNull();
  });

  it('коммутатор: card 000 при card2 118 — не ошибка', () => {
    expect(businessError(switchCardBody())).toBeNull();
  });

  it('коммутатор: card 05 — ошибка', () => {
    expect(businessError(switchCardBody('05'))).toBe('actionCode 05: Do not honor');
  });

  it('statuses.item глубже 6 уровней не ищется', () => {
    let deep: unknown = { statuses: { item: [{ type: 'card', actionCode: '05' }] } };
    for (let i = 0; i < 8; i++) deep = { x: deep };
    expect(businessError(JSON.stringify(deep))).toBeNull();
  });

  it('не JSON, пусто, битый JSON — нет признака', () => {
    expect(businessError('')).toBeNull();
    expect(businessError('""')).toBeNull();
    expect(businessError('OK')).toBeNull();
    expect(businessError('{"result":"err')).toBeNull();
    expect(businessError('[1,2]')).toBeNull();
  });

  it('result:error без объекта error — код и текст из тела', () => {
    expect(businessError('{"result":"error","error":null,"code":7,"message":"Card blocked"}')).toBe('result 7: Card blocked');
    expect(businessError('{"result":"error","error_code":"E12"}')).toBe('result: E12');
  });

  it('номер карты на границе обрезки маскируется до обрезки', () => {
    const pan = '5555551234517894'; // проходит проверку Луна
    const text = businessError(JSON.stringify({ success: false, message: `${'m'.repeat(178)} card ${pan} declined` }))!;
    expect(text).not.toMatch(/\d{13,}/);
    expect(text).not.toContain(pan.slice(0, 15));
  });

  it('текст причины не длиннее 200 символов', () => {
    const text = businessError(JSON.stringify({ error: { code: 1, message: 'x'.repeat(500) } }));
    expect(text).toHaveLength(200);
  });
});

describe('businessError: признаки в XML', () => {
  it('SOAP response_code 8 с причиной из error_description', () => {
    const body = soap(
      'getCardResponse',
      '<ResponseInfo><response_code>8</response_code><error_description>PRC-ERR-0027 Card not found</error_description><error_action>REJECT</error_action></ResponseInfo>',
    );
    expect(businessError(body)).toBe('response_code 8: PRC-ERR-0027 Card not found');
  });

  it('response_code 0 и префикс пространства имён', () => {
    expect(businessError(soap('getCardResponse', '<ResponseInfo><response_code>0</response_code></ResponseInfo>'))).toBeNull();
    expect(businessError('<a><ns2:response_code> -1 </ns2:response_code></a>')).toBe('response_code: -1');
  });

  it('статус карты в XML-ответе', () => {
    const item = (type: string, code: string) =>
      `<item><type>${type}</type><actionCode>${code}</actionCode><actionDescription>d${code}</actionDescription></item>`;
    expect(businessError(`<card><statuses>${item('card', '000')}${item('card2', '118')}</statuses></card>`)).toBeNull();
    expect(businessError(`<card><statuses>${item('card2', '000')}${item('card', '05')}</statuses></card>`)).toBe('actionCode 05: d05');
  });
});

describe('summarize', () => {
  it('успешный запрос сервиса карт', () => {
    const lines = cardsLookup();
    const s = summarize(CARDS_CID, parseAll(lines), done());
    const first = localMs('2026-10-28T16:20:29.921030');
    const last = localMs('2026-10-28T16:20:30.239658');
    expect(s).toMatchObject({
      correlationId: CARDS_CID,
      incoming: { method: 'POST', path: '/v1/cards/lookup' },
      component: 'cards',
      recordCount: 4,
      status: 'success',
      kind: 'incoming',
      reasons: [],
      match: 'exact',
      incomplete: false,
    });
    expect(s.firstMs).toBeCloseTo(first, 6);
    expect(s.lastMs).toBeCloseTo(last, 6);
    expect(s.durationMs).toBeCloseTo(318.628, 6);
  });

  it('запись уровня ERROR — ошибка, причина — её сообщение', () => {
    const lines = [...cardsLookup(), record(app('processor getCard failed', { ctx: { exception: { message: 'x' } } }, '2026-10-28T16:20:30.250000', CARDS_CID, 400))];
    const s = summarize(CARDS_CID, parseAll(lines), done());
    expect(s.status).toBe('error');
    expect(s.reasons).toEqual([{ kind: 'level', text: 'processor getCard failed' }]);
  });

  it('NOTICE — не ошибка', () => {
    const lines = [...cardsLookup(), record(app('slow', {}, '2026-10-28T16:20:30.250000', CARDS_CID, 250))];
    expect(summarize(CARDS_CID, parseAll(lines), done()).status).toBe('success');
  });

  const acquirer500 = () => {
    const cid = 'a1f0c2d4-1111-4222-8333-944455556666';
    const url = 'https://api.acquirer.example/api/payments';
    return [
      incoming('POST', '/v1/users/u/merchant-payments', '{}', '2026-10-28T16:20:29.000000', cid, { request_id: cid }),
      sending('r1', url, '2026-10-28T16:20:29.010000', cid, { headers: { Authorization: ['Bearer abc'] }, body: '{}' }),
      received('r1', url, 500, '{"type":"about:blank","title":"Internal Server Error","status":500}', '2026-10-28T16:20:30.010000', cid),
    ];
  };

  it('HTTP 500 от эквайера — ошибка с адресом вызова', () => {
    const s = summarize('c', parseAll(acquirer500()), done());
    expect(s.status).toBe('error');
    expect(s.reasons).toEqual([{ kind: 'http', text: 'HTTP 500 · POST api.acquirer.example/api/payments' }]);
    expect(s.component).toBe('api');
  });

  it('result:error при HTTP 200 — код и текст из тела', () => {
    const url = 'http://ledger.pay.example:8080/v1/payments/charge';
    const lines = [
      incoming('POST', '/v1/users/u/payments/p/confirm', '{}', '2026-10-28T16:20:29.000000', 'c'),
      sending('p', url, '2026-10-28T16:20:29.010000', 'c', { body: '{}' }),
      received('p', url, 200, '{"result":"error","data":null,"error":{"code":12,"message":"Insufficient funds on account"}}', '2026-10-28T16:20:29.900000', 'c'),
    ];
    const s = summarize('c', parseAll(lines), done());
    expect(s.status).toBe('error');
    expect(s.reasons).toEqual([
      {
        kind: 'business',
        text: 'error 12: Insufficient funds on account · POST ledger.pay.example:8080/v1/payments/charge',
      },
    ]);
  });

  it('SOAP response_code 8 — ошибка с причиной из error_description', () => {
    const lines = cardsLookup('<ResponseInfo><response_code>8</response_code><error_description>PRC-ERR-0027 Card not found</error_description></ResponseInfo>');
    const s = summarize(CARDS_CID, parseAll(lines), done());
    expect(s.status).toBe('error');
    expect(s.kind).toBe('incoming');
    expect(s.reasons).toHaveLength(1);
    expect(s.reasons[0]).toMatchObject({ kind: 'business' });
    expect(s.reasons[0]!.text).toContain('response_code 8: PRC-ERR-0027 Card not found');
  });

  it('коммутатор: card2 118 при card 000 — успех', () => {
    const url = 'http://192.0.2.41:9191/v3/cards/info';
    const lines = [
      incoming('GET', '/v1/users/u/cards/c', '""', '2026-10-30T16:49:14.900000', 'h'),
      sending('r', url, '2026-10-30T16:49:15.000000', 'h', { body: '{}' }),
      received('r', url, 200, switchCardBody(), '2026-10-30T16:49:15.486322', 'h'),
    ];
    expect(summarize('h', parseAll(lines), done(localMs('2026-10-30T17:00:00.000000'))).status).toBe('success');
  });

  const fraud = (sendAt: string) => [
    incoming('GET', '/v1/users/u/cards/c/balance', '""', '2026-10-28T16:20:29.000000', 's'),
    sending('r', 'http://fraud.pay.example:9090/', sendAt, 's', { body: '{"jsonrpc":"2.0"}' }),
  ];

  it('нет ответа за минуту до конца прочитанного — ошибка', () => {
    const sendAt = '2026-10-28T16:20:29.010000';
    const s = summarize('s', parseAll(fraud(sendAt)), done(localMs(sendAt) + 60_000));
    expect(s.status).toBe('error');
    expect(s.reasons).toEqual([{ kind: 'no-response', text: 'ответ не найден · POST fraud.pay.example:9090/' }]);
    expect(s.kind).toBe('incoming');
  });

  it('отправка за 5 с до конца прочитанного — ответ ещё не пришёл, не ошибка', () => {
    const sendAt = '2026-10-28T16:20:29.010000';
    const s = summarize('s', parseAll(fraud(sendAt)), done(localMs(sendAt) + 5_000));
    expect(s.status).toBe('success');
    expect(s.reasons).toEqual([{ kind: 'pending', text: 'ответ ещё не пришёл · POST fraud.pay.example:9090/' }]);
    expect(s.kind).toBe('incoming');
  });

  it('граница 30 с: ровно 30 с — ещё ждём, больше — ошибка', () => {
    const sendAt = '2026-10-28T16:20:29.010000';
    const at = (d: number) => summarize('s', parseAll(fraud(sendAt)), done(localMs(sendAt) + d)).reasons[0]?.kind;
    expect(at(NO_RESPONSE_AFTER_MS)).toBe('pending');
    expect(at(NO_RESPONSE_AFTER_MS + 1)).toBe('no-response');
  });

  it('записи неполные — «ответ не найден» не ошибка', () => {
    const sendAt = '2026-10-28T16:20:29.010000';
    const s = summarize('s', parseAll(fraud(sendAt)), {
      match: 'exact',
      readEndMs: localMs(sendAt) + 600_000,
      incomplete: true,
    });
    expect(s.status).toBe('success');
    expect(s.incomplete).toBe(true);
    expect(s.reasons.map((r) => r.kind)).toEqual(['pending']);
  });

  it('pending не скрывает настоящую ошибку', () => {
    const sendAt = '2026-10-28T16:20:29.010000';
    const lines = [...fraud(sendAt), record(app('Circuit breaker opened', {}, '2026-10-28T16:20:29.020000', 's', 300), API_LABELS)];
    const s = summarize('s', parseAll(lines), {
      match: 'inexact',
      readEndMs: localMs(sendAt),
      incomplete: true,
    });
    expect(s.status).toBe('error');
    expect(s.reasons.map((r) => r.kind)).toEqual(['pending', 'level']);
    expect(s.match).toBe('inexact');
  });

  it('пять отправок без ответа не вытесняют причину ERROR', () => {
    const sends = [1, 2, 3, 4, 5].map((i) => sending(`r${i}`, `https://processor.pay.example/pool/${i}`, `2026-10-28T16:20:29.0${i}0000`, 's', { body: '{}' }));
    const error = record(app('processor pool failed', {}, '2026-10-28T16:20:29.200000', 's', 400), API_LABELS);
    for (const incomplete of [false, true]) {
      const s = summarize('s', parseAll([...sends, error]), {
        match: 'exact',
        readEndMs: localMs('2026-10-28T16:20:29.010000') + 5_000,
        incomplete,
      });
      expect(s.status).toBe('error');
      expect(s.reasons).toHaveLength(5);
      expect(s.reasons).toContainEqual({ kind: 'level', text: 'processor pool failed' });
      // Порядок времени сохраняется: ERROR после четырёх отправок.
      expect(s.reasons.map((r) => r.kind)).toEqual(['pending', 'pending', 'pending', 'pending', 'level']);
    }
  });

  it('тексты причин не длиннее 200 символов: длинный адрес, длинная бизнес-ошибка', () => {
    const url = `https://ledger.pay.example/${'segment/'.repeat(40)}pay`;
    const lines = [
      sending('a', url, '2026-10-28T16:20:29.010000', 'b', { body: '{}' }),
      received('a', url, 502, JSON.stringify({ result: 'error', error: { code: 5, message: 'x'.repeat(500) } }), '2026-10-28T16:20:29.100000', 'b'),
      sending('c', url, '2026-10-28T16:20:29.200000', 'b', { body: '{}' }),
    ];
    const s = summarize('b', parseAll(lines), done(localMs('2026-10-28T16:20:29.200000') + 60_000));
    expect(s.reasons.map((r) => r.kind)).toEqual(['http', 'business', 'no-response']);
    for (const r of s.reasons) expect(r.text.length).toBeLessThanOrEqual(200);
  });

  it('причина ERROR: номер карты и секреты на границе обрезки скрыты', () => {
    const pan = '5555551234517894';
    const messages = [
      `${'x'.repeat(178)} card ${pan} declined`,
      `${'w'.repeat(170)}{"cardholderPassword":"golden sun"}`,
      `${'y'.repeat(158)}{"primaryAccountNumber":"5100123440473348"}`,
    ];
    const lines = messages.map((m, i) => record(app(m, {}, `2026-10-28T16:20:29.${i}00000`, 'e', 400), API_LABELS));
    const s = summarize('e', parseAll(lines), done());
    expect(s.reasons).toHaveLength(3);
    for (const r of s.reasons) {
      expect(r.text).not.toMatch(/\d{13,}/);
      expect(r.text).not.toContain('golden');
    }
  });

  it('фоновый запрос: нет входящей записи', () => {
    const lines = [
      record(app('tokenization callback processed', { request_id: '6312345678901', ctx: { status: 'ACTIVE' } }, '2026-10-28T16:20:29.000000', '6312345678901'), { container: 'worker' }),
      record(app('done', {}, '2026-10-28T16:20:29.100000', '6312345678901'), { container: 'worker' }),
      record(app('other', {}, '2026-10-28T16:20:29.200000', '6312345678901'), CARDS_LABELS),
    ];
    const s = summarize('6312345678901', parseAll(lines), done());
    expect(s).toMatchObject({
      kind: 'background',
      incoming: null,
      status: 'success',
      component: 'worker',
      recordCount: 3,
    });
  });

  it('возможно, ответ из кэша: входящий запрос без вызовов и ошибок', () => {
    const [entry] = cardsLookup();
    const lines = [entry!, record(app('db query', { step: 'db', duration_ms: 12, ctx: { port: '5432' } }, '2026-10-28T16:20:29.930000', CARDS_CID))];
    expect(summarize(CARDS_CID, parseAll(lines), done()).kind).toBe('maybe-cached');
    const withError = [...lines, record(app('Unhandled', {}, '2026-10-28T16:20:29.940000', CARDS_CID, 400))];
    expect(summarize(CARDS_CID, parseAll(withError), done())).toMatchObject({
      kind: 'incoming',
      status: 'error',
    });
  });

  it('компонент входящей записи важнее самой частой', () => {
    const [entry] = cardsLookup();
    const lines = [
      entry!,
      record(app('a', {}, '2026-10-28T16:20:29.930000', CARDS_CID), API_LABELS),
      record(app('b', {}, '2026-10-28T16:20:29.940000', CARDS_CID), API_LABELS),
      record(app('c', {}, '2026-10-28T16:20:29.950000', CARDS_CID), GATEWAY_LABELS),
    ];
    expect(summarize(CARDS_CID, parseAll(lines), done()).component).toBe('cards');
  });

  it('причины по времени, не больше пяти', () => {
    const lines = Array.from({ length: 7 }, (_, i) =>
      record(app(`warn ${i}`, {}, `2026-10-28T16:20:29.${String(900 - i * 100).padStart(3, '0')}000`, 'w', 300), API_LABELS),
    );
    const s = summarize('w', parseAll(lines), done());
    expect(s.reasons.map((r) => r.text)).toEqual(['warn 6', 'warn 5', 'warn 4', 'warn 3', 'warn 2']);
    expect(s.status).toBe('error');
  });

  it('пустой набор записей', () => {
    expect(summarize('x', [], done())).toMatchObject({
      firstMs: 0,
      lastMs: 0,
      durationMs: 0,
      recordCount: 0,
      kind: 'background',
      component: null,
    });
  });
});

describe('markPending', () => {
  it('ставит pending отправкам без ответа по правилу summarize', () => {
    const sendAt = '2026-10-28T16:20:29.010000';
    const lines = [sending('r', 'http://fraud.pay.example:9090/', sendAt, 's'), ...cardsLookup()];
    const v = buildView(parseAll(lines), { withOffsets: true });
    const soon = markPending(v, { readEndMs: localMs(sendAt) + 5_000, incomplete: false });
    const late = markPending(v, { readEndMs: localMs(sendAt) + 60_000, incomplete: false });
    const cut = markPending(v, { readEndMs: localMs(sendAt) + 60_000, incomplete: true });
    const pending = (rs: typeof v) => rs.filter((r) => r.http?.pending).map((r) => r.title);
    expect(pending(soon)).toEqual(['POST fraud.pay.example:9090/']);
    expect(pending(late)).toEqual([]);
    expect(pending(cut)).toEqual(['POST fraud.pay.example:9090/']);
    expect(v.every((r) => !r.http?.pending)).toBe(true);
  });
});

describe('businessFact: код и сообщение рядом с текстом причины', () => {
  it('код и сообщение без маскирования, текст — прежняя строка причины', () => {
    const f = businessFact('{"error":{"code":-202,"message":"Card not found"}}');
    expect(f).toEqual({ marker: 'error', code: '-202', message: 'Card not found', text: 'error -202: Card not found' });
  });

  it('номер карты в тексте маскирован, в сообщении для правил справочника — как в ответе', () => {
    const pan = '4111111234557893';
    const f = businessFact(JSON.stringify({ success: false, message: `card ${pan} declined` }))!;
    expect(f.marker).toBe('success');
    expect(f.code).toBeNull();
    expect(f.message).toContain(pan);
    expect(f.text).not.toContain(pan);
  });

  it('значение для текста не становится кодом: «result: error» без кода', () => {
    expect(businessFact('{"result":"error"}')).toMatchObject({ code: null, text: 'result: error' });
    expect(businessFact('{"result":"error","code":7}')).toMatchObject({ code: '7', text: 'result: 7' });
  });

  it('XML: код и описание; нет признака — null', () => {
    const f = businessFact('<a><response_code>8</response_code><error_description>Card not found</error_description></a>');
    expect(f).toEqual({ marker: 'response_code', code: '8', message: 'Card not found', text: 'response_code 8: Card not found' });
    expect(businessFact('<a><response_code>0</response_code></a>')).toBeNull();
    expect(businessFact('')).toBeNull();
  });
});

describe('значения видов маски в причине', () => {
  it('бизнес-ошибка: телефон на границе 200 символов не оставляет начала', () => {
    const f = businessFact(JSON.stringify({ error: `${'x'.repeat(190)} +447700900001` }));
    expect(f!.text).not.toContain('4477');
    expect(businessFact('{"error":"обычный текст"}')!.text).toBe('error: обычный текст');
  });
});
