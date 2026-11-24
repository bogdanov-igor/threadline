// Справочник для тестов: файл версии 1 → строки базы с номерами по порядку, как после импорта в пустую базу.
import type { ParsedRecord } from '../search/records.ts';
import { compileCatalog, type Resolver } from './resolve.ts';
import { snapshotFromFile } from './snapshot-file.ts';

export { snapshotFromFile };

export function resolverFromFile(file: unknown, project = 'pay'): Resolver {
  return compileCatalog(snapshotFromFile(file, project));
}

let seq = 0;

/** Разобранная запись для тестов разметки. */
export function rec(p: Partial<ParsedRecord> & Pick<ParsedRecord, 'kind' | 'timeMs'>): ParsedRecord {
  seq++;
  return {
    tsNs: `${p.timeMs}000000`,
    labels: {},
    line: `line ${seq}`,
    message: '',
    level: 'INFO',
    levelNum: 200,
    correlationId: 'c0ffee00-0000-4000-8000-000000000001',
    requestId: null,
    method: null,
    uri: null,
    status: null,
    headers: null,
    body: null,
    payload: null,
    action: null,
    context: null,
    component: 'api',
    gateway: false,
    ...p,
  };
}

const S = (value: string, name: string, outcome: 'pending' | 'success' | 'failure') => ({ value, name, outcome });

/** Справочник с выдуманными системами на каждый случай сопоставления. */
export const TEST_FILE = {
  version: 1,
  project: 'pay',
  idTypes: [
    { key: 'user', kind: 'entity', name: 'Пользователь' },
    { key: 'card', kind: 'entity', name: 'Карта' },
    { key: 'transfer', kind: 'operation', name: 'Перевод', statuses: [S('awaiting', 'Ожидает', 'pending'), S('completed', 'Выполнен', 'success'), S('failed', 'Отказ', 'failure')] },
    { key: 'payment', kind: 'operation', name: 'Платёж', statuses: [S('new', 'Новый', 'pending'), S('holding', 'Холдируется', 'pending'), S('held', 'Захолдирован', 'pending'), S('confirming', 'Подтверждается', 'pending'), S('confirmed', 'Подтверждён', 'success'), S('refunded', 'Возвращён', 'failure')] },
    { key: 'payout', kind: 'operation', name: 'Выплата', statuses: [S('created', 'Создан', 'pending'), S('processing', 'В обработке', 'pending'), S('completed', 'Выполнен', 'success'), S('failed', 'Отклонён', 'failure')] },
    { key: 'merchant_payment', kind: 'operation', name: 'Оплата у партнёра', statuses: [S('created', 'Создан', 'pending'), S('performed', 'Проведён', 'success'), S('cancelled', 'Отменён', 'failure')] },
    { key: 'metro', kind: 'operation', name: 'Оплата проезда', statuses: [S('1', 'В обработке', 'pending'), S('2', 'Успешно', 'success'), S('3', 'Неуспешно', 'failure'), S('4', 'Не найдена', 'failure')] },
  ],
  systems: [
    {
      key: 'pay',
      kind: 'project',
      name: 'Demo Pay',
      methods: [
        { http: 'GET', path: '/v1/users/{userId}/cards/{cardId}', name: 'Данные карты', domain: 'Карты' },
        { http: 'GET', path: '/v1/users/{userId}/cards/unmask', name: 'Раскрытие карты' },
        { http: 'GET', path: '/v1/users/{user}/transfers/{transfer}', name: 'Статус перевода', kind: 'status', op: 'transfer' },
        {
          http: 'POST',
          path: '/internal/callbacks/payout',
          name: 'Колбэк сети выплат',
          kind: 'callback',
          op: 'transfer',
          fields: [{ in: 'request', path: 'remote_transfer_id', type: 'transfer' }],
          status: { in: 'request', path: 'state', map: { complete: 'completed', error: 'failed' } },
        },
        { http: '*', path: '/internal/callbacks/crm', name: 'Колбэк CRM, любой метод' },
        { http: 'POST', path: '/internal/callbacks/crm', name: 'Колбэк CRM' },
        { http: 'POST', path: '/v1/users', name: 'Регистрация' },
      ],
      errors: [
        { text: 'duplicated user by phone', title: 'Телефон уже зарегистрирован' },
        { text: 'cache warmup', title: 'Прогрев кэша', severity: 'ok' },
      ],
    },
    {
      key: 'switch',
      name: 'Коммутатор',
      hosts: ['switch.pay.example:9191'],
      methods: [
        { http: 'POST', path: '/v3/cards/info', name: 'Данные карты в коммутаторе' },
        { http: 'POST', path: '/v3/cards/token', name: 'Номер по токену' },
      ],
      errors: [
        { code: '200', title: 'Карта не найдена', partnerCode: '176' },
        { method: { http: 'POST', path: '/v3/cards/token' }, code: '200', title: 'Карта не найдена или закрыта' },
      ],
    },
    {
      key: 'alpha',
      name: 'Альфа',
      hosts: ['alpha.local'],
      methods: [{ http: 'POST', path: '/api/pay', name: 'Оплата' }],
      outcomes: [
        { when: { http: 200, fields: [{ path: 'status', equals: 'OK' }] }, outcome: 'success' },
        { when: { http: 200, fields: [{ path: 'status', equals: 'error' }] }, outcome: 'error', text: '{message}' },
        { when: { http: 422, fields: [{ path: 'status', equals: 'OK' }] }, outcome: 'success' },
      ],
    },
    {
      key: 'beta',
      name: 'Бета',
      hosts: ['beta.local'],
      methods: [
        { http: 'POST', path: '/v1/check', name: 'Проверка' },
        { http: 'POST', path: '/v1/other', name: 'Другое' },
      ],
      outcomes: [
        { when: { http: { from: 400, to: 499 } }, outcome: 'error', text: 'Отказ Беты' },
        { method: { http: 'POST', path: '/v1/check' }, when: { http: 422, fields: [{ path: 'status', equals: 'OK' }] }, outcome: 'success' },
        { priority: 100, when: { http: 200 }, outcome: 'success' },
        { priority: 10, when: { fields: [{ path: 'status', equals: 'error' }] }, outcome: 'error', text: 'Отказ: {error.message}' },
      ],
    },
    {
      key: 'gamma',
      name: 'Гамма',
      hosts: ['gamma.local'],
      methods: [
        { http: 'GET', path: '/v1/client', name: 'Поиск клиента' },
        { http: 'POST', path: '/v1/op', name: 'Операция' },
      ],
      outcomes: [
        { method: { http: 'GET', path: '/v1/client' }, when: { http: 404 }, outcome: 'ignore' },
        { when: { http: 409, fields: [{ in: 'request', path: 'operation', equals: 'refund' }] }, outcome: 'ignore' },
        { when: { fields: [{ path: 'state', oneOf: ['PENDING', 'PROCESSING'] }] }, outcome: 'pending' },
        { when: { http: [200, 202], fields: [{ path: 'message', regex: '^Timeout' }] }, outcome: 'error', text: 'Тайм-аут' },
        { when: { fields: [{ path: 'data.status', equals: '2' }] }, outcome: 'success' },
        { when: { http: 200, fields: [{ path: 'error', exists: false }] }, outcome: 'success', priority: 500 },
      ],
    },
    {
      key: 'delta',
      name: 'Дельта',
      hosts: ['delta.local'],
      methods: [{ http: 'POST', path: '/pay', name: 'Платёж' }],
      errors: [{ code: '51', title: 'Недостаточно средств', action: 'Сообщить клиенту' }],
      outcomes: [
        { when: { http: 200, fields: [{ path: 'status', equals: 'error' }] }, outcome: 'error' },
        { when: { http: 201, fields: [{ path: 'status', equals: 'error' }] }, outcome: 'error', text: '{message}', action: 'Повторить' },
      ],
    },
    {
      key: 'fraud',
      name: 'Проверка мошенничества',
      hosts: ['fraud.local'],
      methods: [
        { http: 'POST', path: '/', rpc: 'risk.check', name: 'Оценка риска' },
        { http: 'POST', path: '/', rpc: 'card.status', name: 'Статус карты' },
      ],
      errors: [{ code: '00', title: 'Успешно', severity: 'ok' }],
      outcomes: [{ method: { http: 'POST', path: '/', rpc: 'card.status' }, when: { fields: [{ path: 'result.card_status', equals: 'BLOCKED' }] }, outcome: 'error', text: 'Карта заблокирована' }],
    },
    {
      key: 'processor',
      name: 'Процессинг карт',
      methods: [
        { http: 'POST', path: '/soap/issuing', rpc: 'getCard', name: 'Номер карты по токену' },
        { http: 'POST', path: '/soap/issuing', rpc: 'getCardholder', name: 'Держатель карты' },
        { http: 'POST', path: '/soap/issuing', name: 'Процессинг SOAP' },
      ],
      errors: [
        { code: '8', title: 'Общая ошибка процессинга' },
        { code: '8', text: 'PRC-ERR-0027', title: 'Карта не найдена в процессинге' },
      ],
      outcomes: [{ when: { fields: [{ path: 'response_code', equals: 0 }] }, outcome: 'success' }],
    },
    { key: 'balance', name: 'Балансы процессинга', methods: [{ http: 'POST', path: '/', rpc: 'getBalance', name: 'Баланс' }] },
    { key: 'pay1', name: 'Платежи 1', methods: [{ http: 'POST', path: '/api/payments', name: 'Платёж 1' }] },
    { key: 'pay2', name: 'Платежи 2', methods: [{ http: 'POST', path: '/api/payments', name: 'Платёж 2' }] },
    {
      key: 'payout',
      name: 'Сеть выплат',
      hosts: ['payout.local'],
      methods: [
        { http: 'POST', path: '/v3/transfer', name: 'Выплата на карту', kind: 'start', op: 'payout', fields: [{ in: 'request', path: 'document_id', type: 'transfer' }, { in: 'response', path: 'data.transfer_id', type: 'payout' }] },
        { http: '*', path: '/v1/payout_status', name: 'Статус выплаты', kind: 'status', op: 'payout', fields: [{ in: 'request', path: 'transfer_id', type: 'payout' }], status: { in: 'response', path: 'data.payout_data.state' } },
      ],
    },
    {
      key: 'ledger',
      name: 'Платёжное ядро',
      hosts: ['ledger.local'],
      methods: [
        { http: 'POST', path: '/v1/transfers/p2p', name: 'Перевод с карты на карту', op: 'transfer', fields: [{ in: 'request', path: 'request_id', type: 'transfer' }] },
        { http: 'POST', path: '/v1/payments/confirm', name: 'Подтверждение платежа', op: 'payment', fields: [{ in: 'request', path: 'request_id', type: 'payment' }], status: { in: 'response', path: 'result', map: { success: 'confirmed' } } },
        { http: 'POST', path: '/v1/payments/refund', name: 'Возврат платежа', op: 'payment', fields: [{ in: 'request', path: 'request_id', type: 'payment' }], status: { in: 'response', path: 'result', map: { success: 'refunded' } } },
        { http: 'POST', path: '/v1/holds', name: 'Холд', op: 'payment', status: { in: 'response', path: 'state' } },
      ],
    },
    { key: 'acquirer', name: 'Эквайер', hosts: ['*.acquirer.example'], methods: [{ http: 'GET', path: '/api/payments/{transactionId}', name: 'Статус платежа эквайера', kind: 'status', op: 'merchant_payment', status: { in: 'response', path: 'status' } }] },
    { key: 'metro', name: 'Транспортный шлюз', hosts: ['transit.local'], methods: [{ http: 'POST', path: '/v1.0/transit/payment/check', name: 'Проверка оплаты', kind: 'status', op: 'metro', status: { in: 'response', path: 'data.status' } }] },
    { key: 'kafka', type: 'queue', name: 'Kafka Demo Pay', hosts: ['kafka.pay.example:9092'] },
    { key: 'pg', type: 'database', name: 'PostgreSQL Demo Pay', errors: [{ text: 'deadlock detected', title: 'Взаимная блокировка в базе' }] },
  ],
  general: {
    errors: [{ http: 504, title: 'Система не ответила вовремя' }],
    outcomes: [{ when: { http: 503 }, outcome: 'error', text: 'Сервис недоступен' }],
  },
};

const j = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

/** Отправка и ответ одного обмена. status null — ответа нет, только отправка. */
export function exchange(t: number, uri: string, o: { method?: string; req?: unknown; resp?: unknown; status?: number | null; requestId?: string }): ParsedRecord[] {
  const send = rec({ kind: 'send', timeMs: t, method: o.method ?? 'POST', uri, body: o.req === undefined ? null : j(o.req), requestId: o.requestId ?? null });
  if (o.status === null) return [send];
  const resp = rec({ kind: 'response', timeMs: t + 50, method: o.method ?? 'POST', uri, status: o.status ?? 200, body: o.resp === undefined ? null : j(o.resp), requestId: o.requestId ?? null });
  return [send, resp];
}

export function incoming(t: number, method: string, uri: string, body?: unknown): ParsedRecord {
  return rec({ kind: 'incoming', timeMs: t, method, uri, body: body === undefined ? null : j(body) });
}
