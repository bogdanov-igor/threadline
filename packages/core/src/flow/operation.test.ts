import { describe, expect, it } from 'vitest';
import type { FlowCatalogStatus } from './catalog.ts';
import { flowFacts, foundPlace, operationKeysOf } from './facts.ts';
import { buildOperation, cidSegments, MAX_SEGMENTS, nocidSegments, type OperationFlow, type OperationGroup, type OpFlowFacts } from './operation.ts';
import { BASE_MS, FlowFixture, name, opId, status, sys } from './test-flow.ts';

// Синтетические операции типичных форм, значения выдуманы.

const MIN = 60_000;
const LEDGER = sys('ledger', 'Платёжное ядро');
const PAYOUT = sys('payout', 'Сеть выплат');
const WINDOW = { fromMs: 0, toMs: Number.MAX_SAFE_INTEGER, preset: '6h' as const };

const PAY = 'pay-0000-1111-2222';
const payId = (at: 'path' | 'request' | 'response' = 'path') => opId('payment', PAY, at, 'Платёж');

const confirmed = status('payment', 'confirmed', 'Подтверждён', 'success');
const refunded = status('payment', 'refunded', 'Возвращён', 'success');
const payoutProcessing = status('payout', 'processing', 'В обработке', 'pending');
const payoutCompleted = status('payout', 'completed', 'Выполнен', 'success');
const payoutError = status('payout', 'failed', 'Отказ', 'failure');
const payoutFailed = status('payout', 'failed', 'Отклонён', 'failure');

/** Вход проекта с методом справочника. */
function entryFlow(cid: string, t: number, method: string, kind: 'start' | 'status' | 'callback' | 'call', o: { ids?: ReturnType<typeof opId>[]; st?: FlowCatalogStatus; hasStatus?: boolean } = {}) {
  const f = new FlowFixture(cid);
  const r = f.entry(t, { method: method.split(' ')[0]!, uri: method.split(' ')[1]!, catalog: { name: name(null, { name: method, kind, op: 'payment' }), ids: o.ids ?? [payId()], status: o.st ?? null } });
  if (o.hasStatus !== undefined) (r.catalog as unknown as { name: { method: { hasStatus: boolean } } }).name.method.hasStatus = o.hasStatus;
  return f;
}

/** Обмен с платёжным ядром: метод справочника, id в request_id, статус в ответе. */
function ledger(f: FlowFixture, t: number, method: string, o: { st?: FlowCatalogStatus | null; error?: boolean; value?: string; type?: string } = {}) {
  const id = opId(o.type ?? 'payment', o.value ?? PAY, 'request', 'Платёж');
  f.exchange(t, t + 200, {
    uri: 'https://ledger.pay.example:8443/api/v1/op',
    status: o.error ? 500 : 200,
    catalog: { name: name(LEDGER, { name: method, kind: 'call' }), ids: [id] },
    respCatalog: { name: name(LEDGER, { name: method, kind: 'call' }), ids: [id], status: o.st ?? null },
  });
  return f;
}

const facts = (f: FlowFixture, opts: Parameters<typeof flowFacts>[2] = {}): OpFlowFacts => flowFacts(f.cid, f.view(), opts);
const key = (values: string[] = [PAY], type = 'payment') => ({ type, name: 'Платёж', values });
const flows = (items: ReturnType<typeof buildOperation>['items']) => items.filter((i): i is OperationFlow => i.kind === 'flow');

describe('buildOperation: роли и состав', () => {
  it('платёж с опросами: создание, вызов, фоновая обработка «Платёжное ядро · Холд», вызов, опрос статуса', () => {
    const create = entryFlow('c1', 0, 'POST /payments', 'start', { ids: [payId('response')] });
    const start = entryFlow('c2', 1 * MIN, 'POST /payments/{payment}/start', 'call');
    const worker = ledger(new FlowFixture('c3'), 2 * MIN, 'Холд', { st: status('payment', 'hold', 'Холд', 'pending') });
    const confirm = ledger(entryFlow('c4', 3 * MIN, 'POST /payments/{payment}/confirm', 'call'), 3 * MIN + 10, 'Подтверждение', { st: confirmed });
    const poll = ledger(entryFlow('c5', 4 * MIN, 'GET /payments/{payment}', 'status'), 4 * MIN + 10, 'Статус');
    const view = buildOperation({ key: key(), window: WINDOW, flows: [poll, create, worker, start, confirm].map((f) => facts(f)) });
    const rows = flows(view.items);
    expect(rows.map((r) => r.role)).toEqual(['start', 'call', 'worker', 'call', 'status']);
    expect(rows[2]!.title).toBe('Платёжное ядро · Холд');
    expect(view.outcome).toMatchObject({ kind: 'success', basis: 'confirmed', cid: 'c4' });
  });

  it('метод входа без вида — роль «вызов»', () => {
    const f = entryFlow('c1', 0, 'POST /payments/{payment}/start', 'call');
    expect(flows(buildOperation({ key: key(), window: WINDOW, flows: [facts(f)] }).items)[0]!.role).toBe('call');
  });

  it('джоба по трём рассрочкам, вторая с ошибкой — ошибку видит только её операция, «обрабатывает 3 операции»', () => {
    const job = new FlowFixture('job');
    ledger(job, 0, 'Списание', { type: 'installment', value: 'inst-000001' });
    ledger(job, 1000, 'Списание', { type: 'installment', value: 'inst-000002', error: true });
    ledger(job, 2000, 'Списание', { type: 'installment', value: 'inst-000003' });
    const f = facts(job);
    for (const [v, err] of [
      ['inst-000001', false],
      ['inst-000002', true],
      ['inst-000003', false],
    ] as const) {
      const row = flows(buildOperation({ key: { type: 'installment', name: 'Рассрочка', values: [v] }, window: WINDOW, flows: [f] }).items)[0]!;
      expect(row).toMatchObject({ role: 'worker', ops: 3, error: err });
    }
  });

  it('id перевода в пути опроса, в request_id платёжного ядра и в ext_transfer_id колбэка — все три потока в операции', () => {
    const poll = entryFlow('p', 0, 'GET /v1/users/{user}/transfers/{transfer}', 'status', { ids: [opId('transfer', 'tr-1', 'path')] });
    const w = new FlowFixture('w');
    ledger(w, 1000, 'Перевод', { type: 'transfer', value: 'tr-1' });
    const cb = entryFlow('cb', 2000, 'POST /v1/callbacks/payout', 'callback', { ids: [opId('transfer', 'tr-1', 'request')] });
    const view = buildOperation({ key: { type: 'transfer', name: 'Перевод', values: ['tr-1'] }, window: WINDOW, flows: [poll, w, cb].map((x) => facts(x)) });
    expect(flows(view.items).map((r) => r.role)).toEqual(['status', 'worker', 'callback']);
    expect(flows(view.items).map((r) => r.linkedBy[0]!.at)).toEqual(['path', 'request', 'request']);
  });

  it('значение в тексте записи-лога другого потока — mention в конце, вне итога, с местом', () => {
    const own = ledger(entryFlow('own', 0, 'POST /payments/{payment}/confirm', 'call'), 10, 'Подтверждение', { st: confirmed });
    const other = new FlowFixture('other');
    other.entry(-1000, { uri: '/v1/other' });
    other.log(-900, `processing ${PAY}`, { level: 'ERROR' });
    const view = buildOperation({ key: key(), window: WINDOW, flows: [facts(other, { values: [PAY] }), facts(own)] });
    const last = view.items[view.items.length - 1] as OperationFlow;
    expect(last).toMatchObject({ role: 'mention', cid: 'other', found: 'log-body', error: false });
    expect(view.outcome.failed).toBe(0);
    expect(view.outcome.kind).toBe('success');
  });

  it('место совпадения: путь входа, тело ответа', () => {
    const f = new FlowFixture('x');
    f.entry(0, { uri: `/v1/payments/${PAY}` });
    expect(foundPlace(f.view(), [PAY])).toBe('entry-path');
    const g = new FlowFixture('y');
    g.exchange(0, 10, { uri: 'https://a.pay.example/x', respBody: `{"id":"${PAY}"}` });
    expect(foundPlace(g.view(), [PAY])).toBe('response-body');
    expect(foundPlace(g.view(), ['nothing-here'])).toBeNull();
  });
});

describe('buildOperation: свёртка, порядок, паузы', () => {
  it('12 фоновых попыток раз в 5 минут — одна группа ×12 с последним статусом и числом неудачных', () => {
    const list = Array.from({ length: 12 }, (_, i) =>
      facts(ledger(new FlowFixture(`w${i}`), i * 5 * MIN, 'Подтверждение', { error: i % 4 === 0, st: status('payment', 'retry', 'Повтор', 'pending') })),
    );
    const view = buildOperation({ key: key(), window: WINDOW, flows: list });
    expect(view.items).toHaveLength(1);
    const g = view.items[0] as OperationGroup;
    expect(g).toMatchObject({ kind: 'group', role: 'worker', title: 'Платёжное ядро · Подтверждение', failed: 3 });
    expect(g.cids).toHaveLength(12);
    expect(g.lastMs - g.firstMs).toBe(55 * MIN + 200);
    expect(g.lastStatus?.name).toBe('Повтор');
    expect(g.flows[1]!.pauseMs).toBe(5 * MIN - 200);
  });

  it('попытки до колбэка и после него — две группы по обе стороны', () => {
    const w = (i: number, t: number) => facts(ledger(new FlowFixture(`w${i}`), t, 'Подтверждение'));
    const cb = facts(entryFlow('cb', 10 * MIN, 'POST /callback', 'callback'));
    const view = buildOperation({ key: key(), window: WINDOW, flows: [w(1, 0), w(2, 5 * MIN), cb, w(3, 15 * MIN), w(4, 20 * MIN)] });
    expect(view.items.map((i) => i.kind)).toEqual(['group', 'flow', 'group']);
  });

  it('колбэк на 300 мс раньше ответа на создание — «одновременно», пауза 0, пометка, итог по колбэку', () => {
    const create = new FlowFixture('create');
    create.entry(0, { method: 'POST', uri: '/v1/users/u/transfers', catalog: { name: name(null, { name: 'Перевод', kind: 'call' }), ids: [opId('transfer', 'tr-1', 'request')] } });
    create.exchange(100, 1500, {
      uri: 'https://payout.pay.example/v3/transfer',
      catalog: { name: name(PAYOUT, { name: 'Перевод', kind: 'start', op: 'transfer' }), ids: [opId('transfer', 'tr-1')] },
      respCatalog: { name: name(PAYOUT, { name: 'Перевод', kind: 'start', op: 'transfer' }), ids: [opId('transfer', 'tr-1'), opId('payout', '604821', 'response')] },
    });
    const cb = entryFlow('cb', 1200, 'POST /v1/callbacks/payout', 'callback', { ids: [opId('transfer', 'tr-1', 'request')], st: payoutError });
    const view = buildOperation({ key: { type: 'transfer', name: 'Перевод', values: ['tr-1'] }, window: WINDOW, flows: [facts(create), facts(cb)] });
    const [, c] = flows(view.items);
    expect(c).toMatchObject({ role: 'callback', together: true, pauseMs: 0, callbackEarly: true });
    expect(view.outcome).toMatchObject({ kind: 'failure', basis: 'claimed', status: { name: 'Отказ' } });
  });

  it('пауза между потоками не меньше нуля, порядок с допуском 1 с', () => {
    const a = facts(ledger(entryFlow('a', 0, 'POST /a', 'call'), 10, 'A'));
    const b = facts(ledger(entryFlow('b', 150, 'POST /b', 'call'), 160, 'B'));
    const view = buildOperation({ key: key(), window: WINDOW, flows: [b, a] });
    const [x, y] = flows(view.items);
    expect(x!.cid).toBe('a');
    expect(y).toMatchObject({ together: true, pauseMs: 0 });
  });

  it('строки опросов партнёра и непрочитанного — в общем порядке времени', () => {
    const a = facts(ledger(entryFlow('a', 0, 'POST /a', 'call'), 10, 'A'));
    const b = facts(ledger(entryFlow('b', 3 * 60 * MIN, 'POST /b', 'call'), 3 * 60 * MIN + 10, 'B'));
    const view = buildOperation({
      key: key(),
      window: WINDOW,
      flows: [a, b],
      polls: [{ kind: 'polls', count: 40, fromMs: BASE_MS + 60 * MIN, toMs: BASE_MS + 2 * 60 * MIN }],
      unread: [{ kind: 'unread', count: 12, fromMs: BASE_MS + 2 * 60 * MIN + 1, toMs: BASE_MS + 2.5 * 60 * MIN, reason: 'limit' }],
    });
    expect(view.items.map((i) => i.kind)).toEqual(['flow', 'polls', 'unread', 'flow']);
    expect(view.outcome.partial).toBe(true);
  });
});

describe('buildOperation: ход статусов и итог', () => {
  const vdPoll = (cid: string, t: number, st: FlowCatalogStatus) => {
    const f = new FlowFixture(cid);
    f.entry(t, { method: 'GET', uri: '/v1/x', catalog: { name: name(null, { name: 'Опрос', kind: 'call' }), ids: [] } });
    f.exchange(t + 10, t + 100, {
      uri: 'https://payout.pay.example/v1/transfer_info',
      catalog: { name: name(PAYOUT, { name: 'Статус выплаты', kind: 'status', op: 'payout' }), ids: [opId('payout', '604821')] },
      respCatalog: { name: name(PAYOUT, { name: 'Статус выплаты', kind: 'status', op: 'payout' }), ids: [opId('payout', '604821')], status: st },
    });
    return facts(f);
  };
  const vdCallback = (cid: string, t: number, st: FlowCatalogStatus) =>
    facts(entryFlow(cid, t, 'POST /v1/callbacks/payout', 'callback', { ids: [opId('payout', '604821', 'request')], st }));
  const payoutKey = { type: 'payout', name: 'Выплата', values: ['604821'] };

  it('processing → колбэк error → transfer_info failed: итог «Отклонён» из последнего transfer_info', () => {
    const view = buildOperation({ key: payoutKey, window: WINDOW, flows: [vdPoll('p1', 0, payoutProcessing), vdCallback('cb', 10 * MIN, payoutError), vdPoll('p2', 20 * MIN, payoutFailed)] });
    expect(view.trail.map((t) => [t.status.name, t.claimed, t.stale])).toEqual([
      ['В обработке', false, false],
      ['Отказ', true, false],
      ['Отклонён', false, false],
    ]);
    expect(view.outcome).toMatchObject({ kind: 'failure', status: { name: 'Отклонён' }, basis: 'confirmed', cid: 'p2', previous: null });
  });

  it('только колбэк complete — итог «Выполнен» по колбэку', () => {
    const view = buildOperation({ key: payoutKey, window: WINDOW, flows: [vdCallback('cb', 0, payoutCompleted)] });
    expect(view.outcome).toMatchObject({ kind: 'success', basis: 'claimed', status: { name: 'Выполнен' } });
  });

  it('колбэк, затем запись-лог об отказе в обработке — итог всё равно по колбэку', () => {
    const cb = new FlowFixture('cb');
    cb.entry(0, { method: 'POST', uri: '/v1/callbacks/payout', catalog: { name: name(null, { name: 'Колбэк', kind: 'callback' }), ids: [opId('payout', '604821', 'request')], status: payoutCompleted } });
    cb.log(50, 'callback ignored: transfer already final', { level: 'WARNING' });
    const view = buildOperation({ key: payoutKey, window: WINDOW, flows: [facts(cb)] });
    expect(view.outcome.basis).toBe('claimed');
  });

  it('колбэк error, затем transfer_info processing — «В процессе», processing не устаревший', () => {
    const view = buildOperation({ key: payoutKey, window: WINDOW, flows: [vdCallback('cb', 0, payoutError), vdPoll('p', MIN, payoutProcessing)] });
    expect(view.outcome.kind).toBe('pending');
    expect(view.trail[1]).toMatchObject({ claimed: false, stale: false });
  });

  it('колбэк и следующий финальный transfer_info — итог из transfer_info', () => {
    const view = buildOperation({ key: payoutKey, window: WINDOW, flows: [vdCallback('cb', 0, payoutError), vdPoll('p', MIN, payoutCompleted)] });
    expect(view.outcome).toMatchObject({ kind: 'success', basis: 'confirmed', cid: 'p' });
  });

  it('нефинальный после финального — устаревший; итог прежний', () => {
    const view = buildOperation({ key: payoutKey, window: WINDOW, flows: [vdPoll('p1', 0, payoutCompleted), vdPoll('p2', MIN, payoutProcessing)] });
    expect(view.trail[1]).toMatchObject({ stale: true });
    expect(view.outcome).toMatchObject({ kind: 'success', status: { name: 'Выполнен' } });
  });

  it('Подтверждён → Возвращён — итог переходом', () => {
    const a = facts(ledger(new FlowFixture('a'), 0, 'Подтверждение', { st: confirmed }));
    const b = facts(ledger(new FlowFixture('b'), 10 * MIN, 'Возврат', { st: refunded }));
    const view = buildOperation({ key: key(), window: WINDOW, flows: [a, b] });
    expect(view.trail.map((t) => t.status.name)).toEqual(['Подтверждён', 'Возвращён']);
    expect(view.outcome).toMatchObject({ status: { name: 'Возвращён' }, previous: { name: 'Подтверждён' } });
  });

  it('равные статусы подряд склеены', () => {
    const view = buildOperation({ key: payoutKey, window: WINDOW, flows: [vdPoll('p1', 0, payoutProcessing), vdPoll('p2', MIN, payoutProcessing)] });
    expect(view.trail).toHaveLength(1);
  });

  it('последний статус processing — pending; статусов нет — unknown с числом потоков с ошибкой', () => {
    expect(buildOperation({ key: payoutKey, window: WINDOW, flows: [vdPoll('p', 0, payoutProcessing)] }).outcome.kind).toBe('pending');
    const err = facts(ledger(new FlowFixture('e'), 0, 'Холд', { error: true }));
    const view = buildOperation({ key: key(), window: WINDOW, flows: [err] });
    expect(view.outcome).toMatchObject({ kind: 'unknown', failed: 1 });
  });

  it('статус вне словаря показан как есть и итог не задаёт', () => {
    const odd = status('payout', 'waiting_cancel', null, null);
    const view = buildOperation({ key: payoutKey, window: WINDOW, flows: [vdPoll('p', 0, odd)] });
    expect(view.trail[0]!.status.value).toBe('waiting_cancel');
    expect(view.outcome.kind).toBe('pending');
  });

  it('partial — при неполном потоке или ошибке поиска', () => {
    const p = vdPoll('p', 0, payoutCompleted);
    expect(buildOperation({ key: payoutKey, window: WINDOW, flows: [{ ...p, incomplete: true }] }).outcome.partial).toBe(true);
    expect(buildOperation({ key: payoutKey, window: WINDOW, flows: [p], partial: true }).outcome.partial).toBe(true);
    expect(buildOperation({ key: payoutKey, window: WINDOW, flows: [p] }).outcome.partial).toBe(false);
  });

  it('опрос с полем статуса без статуса в логах — noStatus', () => {
    const poll = entryFlow('p', 0, 'GET /v1/users/{user}/payments/{payment}', 'status', { hasStatus: true });
    const row = flows(buildOperation({ key: key(), window: WINDOW, flows: [facts(poll)] }).items)[0]!;
    expect(row).toMatchObject({ role: 'status', noStatus: true });
  });
});

describe('buildOperation: дополнение', () => {
  it('extraIds — только с шага, где уже есть ключ, и не больше 3 − значений', () => {
    const f = new FlowFixture('w');
    f.exchange(0, 100, {
      uri: 'https://payout.pay.example/v3/transfer',
      catalog: { name: name(PAYOUT, { name: 'Перевод', kind: 'start', op: 'transfer' }), ids: [opId('transfer', 'tr-1')] },
      respCatalog: { name: name(PAYOUT, { name: 'Перевод', kind: 'start', op: 'transfer' }), ids: [opId('transfer', 'tr-1'), opId('payout', '604821', 'response', 'Выплата')] },
    });
    // id без ключа на шаге — не дополнение.
    f.exchange(200, 300, { uri: 'https://x.pay.example/y', catalog: { ids: [opId('merchant_payment', 'mp-1')] } });
    const k = { type: 'transfer', name: 'Перевод', values: ['tr-1'] };
    const view = buildOperation({ key: k, window: WINDOW, flows: [facts(f)] });
    expect(view.extraIds).toEqual([{ type: 'payout', name: 'Выплата', value: '604821' }]);
    expect(buildOperation({ key: k, window: WINDOW, flows: [facts(f)], canSearch: () => false }).extraIds).toEqual([]);
    expect(buildOperation({ key: { ...k, values: ['tr-1', 'tr-2', 'tr-3'] }, window: WINDOW, flows: [facts(f)] }).extraIds).toEqual([]);
  });

  it('тип не описан — все потоки mention, итог unknown', () => {
    const f = new FlowFixture('x');
    f.entry(0, { uri: '/v1/x/zz-123456' });
    const view = buildOperation({ key: { type: 'zz', name: null, values: ['zz-123456'] }, window: WINDOW, flows: [facts(f, { values: ['zz-123456'] })], unknownType: true });
    expect(flows(view.items)[0]).toMatchObject({ role: 'mention', found: 'entry-path' });
    expect(view.outcome.kind).toBe('unknown');
    expect(view.unknownType).toBe(true);
  });
});

describe('фоновые потоки', () => {
  it('(A) записи без correlation_id — сегменты по поду и паузе больше 30 с', () => {
    const rec = (t: number, pod: string) => ({ timeMs: t, labels: { pod }, component: 'worker' });
    const { segments, rest } = nocidSegments([rec(0, 'w-1'), rec(10_000, 'w-1'), rec(45_000, 'w-1'), rec(5_000, 'w-2')]);
    expect(segments.map((s) => [s.pod, s.records.length])).toEqual([
      ['w-1', 2],
      ['w-2', 1],
      ['w-1', 1],
    ]);
    expect(segments[0]!.id).toMatch(/^nocid:[0-9a-f]{12}:0$/);
    expect(segments[0]!.id).not.toContain('w-1');
    expect(rest).toBe(0);
  });

  it('(A) без метки пода — по компоненту; больше 50 сегментов — остаток', () => {
    const many = Array.from({ length: 55 }, (_, i) => ({ timeMs: i * 60_000, labels: {}, component: 'cron' }));
    const { segments, rest } = nocidSegments(many);
    expect(segments).toHaveLength(MAX_SEGMENTS);
    expect(segments[0]!.pod).toBe('cron');
    expect(rest).toBe(5);
  });

  it('(A) сегмент без correlation_id — роль «фоновая обработка» с названием вызова платёжного ядра', () => {
    const f = ledger(new FlowFixture('nocid:w-1:0'), 0, 'Подтверждение');
    const row = flows(buildOperation({ key: key(), window: WINDOW, flows: [facts(f, { nocid: true })] }).items)[0]!;
    expect(row).toMatchObject({ role: 'worker', nocid: true, title: 'Платёжное ядро · Подтверждение' });
    expect(row.titleCode).toBeUndefined();
  });

  it('(A) сегмент без correlation_id, где id только в тексте записи-лога, — название кодом nocid, внутреннего ключа нет', () => {
    const f = new FlowFixture('nocid:3fa2b1c0d9e8:1731000000000');
    f.log(0, `cards sync for ${PAY}`);
    const row = buildOperation({ key: key(), window: WINDOW, flows: [facts(f, { nocid: true, values: [PAY] })] }).items[0] as OperationFlow;
    expect(row).toMatchObject({ role: 'mention', nocid: true, titleCode: 'nocid', title: 'Записи без correlation_id', found: 'log-body' });
    expect(JSON.stringify({ title: row.title, titleCode: row.titleCode })).not.toContain('nocid:');
  });

  it('упоминание с настоящим correlation_id без входа и шагов называется своим cid, кода названия нет', () => {
    const f = new FlowFixture('6630000000001');
    f.log(0, `cards sync for ${PAY}`);
    const row = buildOperation({ key: key(), window: WINDOW, flows: [facts(f, { values: [PAY] })] }).items[0] as OperationFlow;
    expect(row).toMatchObject({ role: 'mention', title: '6630000000001' });
    expect(row.titleCode).toBeUndefined();
  });

  it('(B) один correlation_id с паузами 5 мин — сегменты: первый «вызов», следующие — фоновые попытки в группе', () => {
    const f = entryFlow('orig', 0, 'POST /payments/{payment}/confirm', 'call');
    ledger(f, 100, 'Подтверждение', { error: true });
    for (let i = 1; i <= 3; i++) ledger(f, i * 5 * MIN, 'Подтверждение', { error: i < 3, st: i === 3 ? confirmed : null });
    const parts = cidSegments(f.view());
    expect(parts).toHaveLength(4);
    const list = parts.map((p, i) => flowFacts('orig', p, { segment: i }));
    const view = buildOperation({ key: key(), window: WINDOW, flows: list });
    expect(view.items.map((i) => i.kind)).toEqual(['flow', 'group']);
    const [first, group] = view.items as [OperationFlow, OperationGroup];
    expect(first).toMatchObject({ role: 'call', segment: 0 });
    expect(group).toMatchObject({ role: 'worker', failed: 2 });
    expect(group.flows.map((x) => x.segment)).toEqual([1, 2, 3]);
    expect(group.flows[0]!.firstRecordId).toBe(parts[1]![0]!.id);
    expect(view.outcome.kind).toBe('success');
  });

  it('(B) паузы не больше 3 мин — один сегмент', () => {
    const f = ledger(new FlowFixture('x'), 0, 'A');
    ledger(f, 2 * MIN, 'A');
    expect(cidSegments(f.view())).toHaveLength(1);
  });
});

describe('ключи операции запроса', () => {
  it('id входа первым, затем обменов; разные типы на шаге — ключи одной операции; не больше трёх', () => {
    const f = new FlowFixture('x');
    f.entry(0, { catalog: { ids: [opId('transfer', 'tr-00001', 'path'), { ...opId('user', 'u-1', 'path'), kind: 'entity' }] } });
    f.exchange(10, 100, { uri: 'https://payout.pay.example/v3/transfer', catalog: { ids: [opId('transfer', 'tr-00001')] }, respCatalog: { ids: [opId('payout', '604821', 'response')] } });
    f.exchange(200, 300, { uri: 'https://ledger.pay.example/a', catalog: { ids: [opId('installment', 'i-1'), opId('installment', 'i-2')] } });
    const keys = operationKeysOf(f.view());
    expect(keys.map((k) => `${k.type}:${k.value}`)).toEqual(['transfer:tr-00001', 'payout:604821', 'installment:i-1']);
    expect(keys[1]).toMatchObject({ short: '4821', masked: false });
  });

  it('id, который маскирование меняет, недоступен для поиска', () => {
    const f = new FlowFixture('x');
    f.entry(0, { catalog: { ids: [opId('card_op', '4111111111111111', 'path')] } });
    expect(operationKeysOf(f.view())[0]!.masked).toBe(true);
  });

  it('без разметки ключей нет', () => {
    const f = new FlowFixture('x');
    f.entry(0);
    expect(operationKeysOf(f.view())).toEqual([]);
  });
});

describe('buildOperation: строки опросов и непрочитанного', () => {
  const op = (flowsList: OpFlowFacts[], extra: object = {}) => buildOperation({ key: key(), window: WINDOW, flows: flowsList, ...extra });
  const T = BASE_MS;

  it('опросы из часового куска не стоят раньше создания; у первого потока паузы нет', () => {
    const create = facts(entryFlow('c1', 0, 'POST /payments', 'start', { ids: [payId('response')] }));
    const later = facts(entryFlow('c2', 10 * MIN, 'POST /payments/x/start', 'call'));
    const v = op([create, later], { polls: [{ kind: 'polls', count: 6, fromMs: T - 59 * MIN, toMs: T + 61 * MIN }] });
    expect(v.items.map((i) => i.kind)).toEqual(['flow', 'polls', 'flow']);
    const polls = v.items[1]!;
    if (polls.kind === 'polls') {
      expect(polls.fromMs).toBe(T);
      expect(polls.toMs).toBe(T + 61 * MIN);
    }
    const [first, second] = flows(v.items);
    expect(first!.pauseMs).toBeNull();
    expect(first!.together).toBe(false);
    expect(second!.pauseMs).toBeGreaterThan(0);
  });

  it('без прочитанных потоков строка опросов остаётся как есть', () => {
    const v = op([], { polls: [{ kind: 'polls', count: 3, fromMs: T, toMs: T + MIN }] });
    expect(v.items[0]).toMatchObject({ kind: 'polls', fromMs: T });
  });

  it('группа попыток не идёт через непрочитанную середину, итог — по неполным данным', () => {
    const attempt = (i: number, t: number) => facts(ledger(new FlowFixture('c-same'), t, 'Подтверждение'), { segment: i });
    const list = [attempt(0, 0), attempt(1, 5 * MIN), attempt(2, 960 * MIN), attempt(3, 965 * MIN)];
    const v = op(list, { unread: [{ kind: 'unread', count: 1, fromMs: T + 60 * MIN, toMs: T + 900 * MIN, reason: 'limit' }] });
    expect(v.items.map((i) => i.kind)).toEqual(['group', 'unread', 'group']);
    expect(v.outcome.partial).toBe(true);
  });
});

describe('группа и непрочитанная середина', () => {
  it('группа не содержит паузы шире непрочитанного отрезка, строка стоит между группами', () => {
    // Попытки раз в 5 минут; между двумя — большой непрочитанный отрезок, край которого совпал с временем потока.
    const at = [0, 5, 10, 15, 960, 965, 970];
    const list = at.map((m, i) => facts(ledger(new FlowFixture(`w${i}`), m * MIN, 'Подтверждение')));
    const view = buildOperation({
      key: key(),
      window: WINDOW,
      flows: list,
      unread: [{ kind: 'unread', count: 100, fromMs: BASE_MS + 15 * MIN, toMs: BASE_MS + 965 * MIN, reason: 'limit' }],
    });
    expect(view.items.map((i) => i.kind)).toEqual(['group', 'unread', 'group']);
    for (const it of view.items) {
      if (it.kind !== 'group') continue;
      const firsts = it.flows.map((f) => f.firstMs);
      for (let i = 1; i < firsts.length; i++) expect(firsts[i]! - firsts[i - 1]!).toBeLessThanOrEqual(5 * MIN);
    }
  });

  it('пауза рядом с краем отрезка в запасе чтения группу не разбивает', () => {
    const list = [0, 5, 10].map((m, i) => facts(ledger(new FlowFixture(`w${i}`), m * MIN, 'Подтверждение')));
    const view = buildOperation({
      key: key(),
      window: WINDOW,
      flows: list,
      unread: [{ kind: 'unread', count: 3, fromMs: BASE_MS + 4 * MIN, toMs: BASE_MS + 10 * MIN, reason: 'limit' }],
    });
    expect((view.items[0] as OperationGroup).cids).toHaveLength(3);
  });
});

describe('новые id сверх предела значений', () => {
  it('нельзя дополнить, но они показаны отдельно', () => {
    const f = new FlowFixture('w');
    f.exchange(0, 10, { uri: 'https://payout.pay.example/v3/transfer', catalog: { name: name(PAYOUT, { name: 'Перевод', kind: 'start', op: 'payout' }), ids: [opId('transfer', 'a'), opId('payout', 'd-value')] } });
    const view = buildOperation({ key: { ...key(), type: 'transfer', values: ['a', 'b', 'c'] }, window: WINDOW, flows: [facts(f)] });
    expect(view.extraIds).toEqual([]);
    expect(view.unsearchedIds).toMatchObject([{ type: 'payout', value: 'd-value' }]);
  });
});

describe('ключ операции со скрытым значением', () => {
  it('*** и маска: masked, хвоста нет', () => {
    const f = new FlowFixture('w');
    f.entry(0, { method: 'GET', uri: '/v1/x', catalog: { name: name(null, { name: 'X', kind: 'call' }), ids: [opId('transfer', '***')] } });
    expect(operationKeysOf(f.view())[0]).toMatchObject({ value: '***', short: '', masked: true });
  });
});
