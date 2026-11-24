// Справочник для тестов поиска операции на синтетическом наборе (MOCK_FLOW). Названия и значения выдуманы.
import { compileCatalog, readCatalogFile, type CatalogSnapshot, type Resolver } from '@threadline/core/catalog';

const S = (value: string, name: string, outcome: 'pending' | 'success' | 'failure') => ({ value, name, outcome });
const ledgerId = (type: string) => [{ in: 'request', path: 'request_id', type }];

export const FLOW_CATALOG = {
  version: 1,
  project: 'pay',
  idTypes: [
    { key: 'user', kind: 'entity', name: 'Пользователь' },
    { key: 'transfer', kind: 'operation', name: 'Перевод', statuses: [S('created', 'Создан', 'pending'), S('held', 'Захолдирован', 'pending'), S('completed', 'Выполнен', 'success'), S('failed', 'Отказ', 'failure')] },
    { key: 'payout', kind: 'operation', name: 'Выплата', statuses: [S('created', 'Создан', 'pending'), S('processing', 'В обработке', 'pending'), S('completed', 'Выполнен', 'success'), S('failed', 'Отклонён', 'failure')] },
    { key: 'payment', kind: 'operation', name: 'Платёж', statuses: [S('held', 'Захолдирован', 'pending'), S('confirming', 'Подтверждается', 'pending'), S('confirmed', 'Подтверждён', 'success'), S('refunded', 'Возвращён', 'failure')] },
    { key: 'installment', kind: 'operation', name: 'Рассрочка', statuses: [S('charged', 'Списано', 'success')] },
  ],
  systems: [
    {
      key: 'pay',
      kind: 'project',
      name: 'Demo Pay',
      methods: [
        { http: 'POST', path: '/v1/users/{user}/transfers', name: 'Перевод', kind: 'start', op: 'transfer' },
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
        { http: 'POST', path: '/v1/users/{user}/payments/{payment}/confirm', name: 'Подтверждение платежа', op: 'payment' },
      ],
    },
    {
      key: 'ledger',
      name: 'Платёжное ядро',
      hosts: ['ledger.pay.example:8080'],
      methods: [
        { http: 'POST', path: '/v1/transfers/hold', name: 'Холд перевода', op: 'transfer', fields: ledgerId('transfer'), status: { in: 'response', path: 'data.status' } },
        { http: 'POST', path: '/v1/payments/hold', name: 'Холд', op: 'payment', fields: ledgerId('payment'), status: { in: 'response', path: 'data.status' } },
        { http: 'POST', path: '/v1/payments/confirm', name: 'Подтверждение', op: 'payment', fields: ledgerId('payment'), status: { in: 'response', path: 'data.status' } },
        { http: 'POST', path: '/v1/payments/status', name: 'Статус платежа', kind: 'status', op: 'payment', fields: ledgerId('payment'), status: { in: 'response', path: 'data.status' } },
        { http: 'POST', path: '/v1/installments/charge', name: 'Списание', op: 'installment', fields: ledgerId('installment'), status: { in: 'response', path: 'data.status' } },
      ],
    },
    {
      key: 'payout',
      name: 'Сеть выплат',
      hosts: ['payout.pay.example:9443'],
      methods: [
        {
          http: 'POST',
          path: '/v3/transfer',
          name: 'Перевод',
          kind: 'start',
          op: 'transfer',
          fields: [
            { in: 'request', path: 'document_id', type: 'transfer' },
            { in: 'response', path: 'data.transfer_id', type: 'payout' },
          ],
          status: { in: 'response', path: 'data.state' },
        },
        {
          http: 'POST',
          path: '/v1/payout_status',
          name: 'Статус перевода',
          kind: 'status',
          op: 'payout',
          fields: [{ in: 'request', path: 'transfer_id', type: 'payout' }],
          status: { in: 'response', path: 'data.payout_data.state' },
        },
      ],
    },
  ],
};

/** Файл версии 1 → строки базы с номерами по порядку, как после импорта в пустую базу. */
export function flowSnapshot(version = 1): CatalogSnapshot {
  const r = readCatalogFile(FLOW_CATALOG, 'pay');
  if (!r.ok) throw new Error(`справочник теста с ошибками: ${JSON.stringify(r.errors)}`);
  const e = r.entries;
  let id = 0;
  const meta = (hidden: boolean, seedKey: string) => ({ id: ++id, hidden, edited: false, seedKey, updatedAt: '2026-11-03T10:00:00.000Z' });
  const idTypes = e.idTypes.map((t) => ({ ...t.data, ...meta(t.hidden, t.key) }));
  const systems = e.systems.map((s) => ({ ...s.data, ...meta(s.hidden, s.key) }));
  const sysId = new Map(systems.map((s) => [s.key, s.id]));
  const methods = e.methods.map((m) => ({ ...m.data, systemId: sysId.get(m.systemKey)!, ...meta(m.hidden, m.key) }));
  return { project: 'pay', version, idTypes, systems, methods, errors: [], outcomeRules: [] };
}

export function flowResolver(version = 1): Resolver {
  return compileCatalog(flowSnapshot(version));
}
