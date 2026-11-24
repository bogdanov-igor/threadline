// Id шага с типами и статус операции: типы идентификаторов, идентификаторы шага, статус и перевод его значений.
import { describe, expect, it } from 'vitest';
import { buildView, markPending, summarize, type ParsedRecord } from '../search/index.ts';
import { annotateRecords, finalizeSummary } from './annotate.ts';
import { parseBody, readField, readQuery } from './body.ts';
import { stepIds, typeKeyOf } from './ids.ts';
import { parseTemplate } from './path.ts';
import { ALL_KINDS_MASKING, compileMasking } from '../search/mask-pass.ts';
import { exchange, incoming, resolverFromFile, TEST_FILE } from './test-catalog.ts';

const resolver = resolverFromFile(TEST_FILE);
const T0 = Date.UTC(2026, 10, 2, 9, 0, 0);
const OPTS = { match: 'exact' as const, readEndMs: T0 + 600_000, incomplete: false };
const U1 = '5a1d0100-0000-4000-8000-000000000001';
const U2 = '5a1d0200-0000-4000-8000-000000000002';
const view = (records: ParsedRecord[]) => annotateRecords(markPending(buildView(records, { withOffsets: true }), OPTS), resolver);

describe('подстановка счёта', () => {
  const types = new Map([['account', { kind: 'entity' as const, name: 'Счёт' }], ['branch', { kind: 'entity' as const, name: 'Филиал' }]]);
  const bodies = { query: null, request: parseBody(null), response: parseBody(null) };
  const ACCOUNT = '10500000900123456001';
  const ids = (path: string, strict = compileMasking([]).strict) => stepIds(parseTemplate(path), ['v1', 'accounts', ACCOUNT, '00001'], [], bodies, types, strict);

  it('{account} маской: значение не уходит в разметку и в keep', () => {
    expect(ids('/v1/accounts/{account}/{branch}').map((i) => [i.type, i.value])).toEqual([['account', '****************6001'], ['branch', '00001']]);
    expect(ids('/v1/accounts/{account_id}/{branch}').map((i) => i.value)).toEqual(['****************6001', '00001']);
  });

  it('вид скрыт в строгом проходе и при выключенном виде: разметка показывает маску всегда', () => {
    const off = compileMasking([{ type: 'account_number', enabled: false, keys: [] }]).strict;
    expect(ids('/v1/accounts/{account}/{branch}', off)[0]!.value).toBe('****************6001');
    expect(ids('/v1/accounts/{account}/{branch}', ALL_KINDS_MASKING.strict)[0]!.value).toBe('****************6001');
  });
});

describe('тип по имени подстановки', () => {
  it('разные написания одного типа и составной ключ', () => {
    expect(['transferId', 'transfer_id', 'transfer', 'transfer2', 'TransferID'].map(typeKeyOf)).toEqual(['transfer', 'transfer', 'transfer', 'transfer', 'transfer']);
    expect(['qrPaymentId', 'qr-payment', 'qr_payment'].map(typeKeyOf)).toEqual(['qr_payment', 'qr_payment', 'qr_payment']);
    expect(typeKeyOf('id')).toBe('id');
  });
});

describe('чтение полей', () => {
  it('JSON по объектам, без массивов', () => {
    const b = parseBody('{"a":{"b":{"c":"x"}},"arr":[{"c":1}],"n":null}');
    expect(readField(b, 'a.b.c')).toEqual({ found: true, value: 'x' });
    expect(readField(b, 'arr.0.c')).toEqual({ found: false });
    expect(readField(b, 'n')).toEqual({ found: true, value: null });
    expect(readField(b, 'missing')).toEqual({ found: false });
  });

  it('XML: первый элемент по локальному имени, nil, вложенные элементы', () => {
    const b = parseBody('<a:Env><a:Body><x:remote_transfer_id> 42 </x:remote_transfer_id><x:nil xsi:nil="true"/><x:obj><y>1</y></x:obj><x:e/></a:Body></a:Env>');
    expect(readField(b, 'remote_transfer_id')).toEqual({ found: true, value: ' 42 ' });
    expect(readField(b, 'nil')).toEqual({ found: true, value: null });
    expect(readField(b, 'data.e')).toEqual({ found: true, value: '' });
    expect(readField(b, 'obj').found && readField(b, 'obj')).toMatchObject({ found: true });
  });

  it('строка запроса', () => {
    expect(readQuery('a=1&transfer_id=abc', 'transfer_id')).toEqual({ found: true, value: 'abc' });
    expect(readQuery(null, 'x')).toEqual({ found: false });
  });
});

describe('идентификаторы шага', () => {
  it('тип по имени подстановки: user и transfer из пути', () => {
    const v = view([incoming(T0, 'GET', `/v1/users/${U1}/transfers/${U2}`)]);
    expect(v[0]!.catalog?.ids).toEqual([
      { type: 'user', name: 'Пользователь', kind: 'entity', value: U1, at: 'path' },
      { type: 'transfer', name: 'Перевод', kind: 'operation', value: U2, at: 'path' },
    ]);
  });

  it('id в теле колбэка — тот же перевод', () => {
    const v = view([incoming(T0, 'POST', '/internal/callbacks/payout', { remote_transfer_id: U2, state: 'complete' })]);
    expect(v[0]!.catalog?.ids).toEqual([{ type: 'transfer', name: 'Перевод', kind: 'operation', value: U2, at: 'request' }]);
  });

  it('id операции в вызове платёжного ядра; у ответа — только поля ответа', () => {
    const v = view(exchange(T0, 'http://ledger.local/v1/transfers/p2p', { req: { request_id: U2, amount: 100 }, resp: { result: 'success', data: {} } }));
    expect(v[0]!.catalog?.ids).toEqual([{ type: 'transfer', name: 'Перевод', kind: 'operation', value: U2, at: 'request' }]);
    expect(v[1]!.catalog?.ids).toEqual([]);
  });

  it('асинхронная отправка: id в отправке и в ответе', () => {
    const v = view(exchange(T0, 'http://payout.local/v3/transfer', { req: { document_id: U2 }, resp: { res: 0, error: null, data: { transfer_id: 777 } } }));
    expect(v[0]!.catalog?.ids.map((i) => [i.type, i.value, i.at])).toEqual([['transfer', U2, 'request']]);
    expect(v[1]!.catalog?.ids.map((i) => [i.type, i.value, i.at])).toEqual([['payout', '777', 'response']]);
  });

  it('имя без типа не попадает; поля нет или тело не разобралось', () => {
    const r = resolverFromFile({
      version: 1,
      project: 'pay',
      idTypes: [{ key: 'payout', kind: 'operation', name: 'Выплата' }],
      systems: [{ key: 'x', name: 'X', hosts: ['x.local'], methods: [{ http: 'POST', path: '/t/{id}', name: 'T', fields: [{ in: 'response', path: 'data.transfer_id', type: 'payout' }] }] }],
    });
    const recs = exchange(T0, 'http://x.local/t/123456789', { resp: 'not json' });
    const v = annotateRecords(buildView(recs, { withOffsets: true }), r);
    expect(v[1]!.catalog?.ids).toEqual([]);
    expect(v[1]!.catalog?.name?.method?.name).toBe('T');
  });

  it('пустое и длинное значение пропускаются, повторы схлопываются', () => {
    const v = view([incoming(T0, 'POST', '/internal/callbacks/payout', { remote_transfer_id: '   ' })]);
    expect(v[0]!.catalog?.ids).toEqual([]);
    const long = view([incoming(T0, 'POST', '/internal/callbacks/payout', { remote_transfer_id: 'x'.repeat(129) })]);
    expect(long[0]!.catalog?.ids).toEqual([]);
  });
});

describe('статус операции', () => {
  const info = (state: string) => view(exchange(T0, 'http://payout.local/v1/payout_status', { req: { transfer_id: 5 }, resp: { data: { payout_data: { state } } } }))[1]!.catalog?.status;

  it('опрос статуса во внешней системе', () => {
    expect(info('processing')).toEqual({ type: 'payout', value: 'processing', raw: 'processing', name: 'В обработке', outcome: 'pending', order: 2 });
  });

  it('модель холдирования: место в словаре', () => {
    const s = view(exchange(T0, 'http://ledger.local/v1/holds', { resp: { state: 'held' } }))[1]!.catalog?.status;
    expect(s).toMatchObject({ value: 'held', outcome: 'pending', order: 3 });
  });

  it('числовой статус', () => {
    const s = view(exchange(T0, 'http://transit.local/v1.0/transit/payment/check', { resp: { data: { status: 2 } } }))[1]!.catalog?.status;
    expect(s).toMatchObject({ value: '2', name: 'Успешно', outcome: 'success' });
  });

  it('значение вне словаря — как есть', () => {
    const s = view(exchange(T0, 'https://checkout.acquirer.example/api/payments/abc', { method: 'GET', resp: { status: 'cancel_queued' } }))[1]!.catalog?.status;
    expect(s).toEqual({ type: 'merchant_payment', value: 'cancel_queued', raw: 'cancel_queued', name: null, outcome: null, order: null });
  });

  it('отказ не делает шаг и запрос ошибочными', () => {
    const records = [incoming(T0, 'GET', '/v1/users'), ...exchange(T0 + 1, 'http://payout.local/v1/payout_status', { req: {}, resp: { data: { payout_data: { state: 'failed' } } } })];
    const v = view(records);
    expect(v[2]!.catalog?.status?.outcome).toBe('failure');
    expect(v[2]!.isError).toBe(false);
    expect(finalizeSummary(summarize('c', records, OPTS), records, resolver, OPTS).status).toBe('success');
  });

  it('перевод значения колбэка: complete → completed', () => {
    const s = view([incoming(T0, 'POST', '/internal/callbacks/payout', { remote_transfer_id: U2, state: 'Complete' })])[0]!.catalog?.status;
    expect(s).toEqual({ type: 'transfer', value: 'completed', raw: 'Complete', name: 'Выполнен', outcome: 'success', order: 2 });
  });

  it('один ответ — разные статусы; синхронный метод с типом операции', () => {
    const confirm = view(exchange(T0, 'http://ledger.local/v1/payments/confirm', { req: { request_id: U1 }, resp: { result: 'success' } }))[1]!;
    const refund = view(exchange(T0, 'http://ledger.local/v1/payments/refund', { req: { request_id: U1 }, resp: { result: 'success' } }))[1]!;
    expect(confirm.catalog?.status?.name).toBe('Подтверждён');
    expect(refund.catalog?.status?.name).toBe('Возвращён');
    expect(confirm.catalog?.name?.method?.kind).toBe('call');
  });

  it('статус в ответе на вход без записи ответа — статуса нет', () => {
    expect(view([incoming(T0, 'GET', `/v1/users/${U1}/transfers/${U2}`)])[0]!.catalog?.status).toBeNull();
  });
});

describe('ключ типа: цифры перед Id и заглавная аббревиатура', () => {
  it('card2Id и QRPaymentId', () => {
    expect(typeKeyOf('card2Id')).toBe('card');
    expect(typeKeyOf('QRPaymentId')).toBe('qr_payment');
  });

  it('цифры после Id: cardId2 и card_id_2 дают card, а не card_id', () => {
    expect(['cardId2', 'card_id_2', 'card_id2', 'CardID3'].map(typeKeyOf)).toEqual(['card', 'card', 'card', 'card']);
    expect(['id2', 'QRPaymentId2'].map(typeKeyOf)).toEqual(['id', 'qr_payment']);
  });
});
