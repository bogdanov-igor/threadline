// Выдуманный справочник для модульных тестов редактора: проект, коммутатор, сеть выплат, база, общие правила, типы id.
import type { CatalogResponse, ErrorRow, IdTypeRow, MethodRow, OutcomeRow, SystemRow } from '@threadline/core/catalog';

const meta = (id: number, extra: Partial<{ hidden: boolean; edited: boolean; seedKey: string | null }> = {}) => ({
  id,
  hidden: false,
  edited: false,
  seedKey: null,
  updatedAt: '2026-11-02T10:00:00.000Z',
  ...extra,
});

export const SYSTEMS: SystemRow[] = [
  { ...meta(1), key: 'pay', kind: 'project', type: 'service', name: 'Demo Pay', hosts: [], description: null },
  { ...meta(2), key: 'switch', kind: 'external', type: 'service', name: 'Коммутатор', hosts: ['switch.pay.example:11101'], description: 'REST JSON' },
  { ...meta(3), key: 'payout', kind: 'external', type: 'service', name: 'Сеть выплат', hosts: ['*.payout.example'], description: null },
  { ...meta(4), key: 'db', kind: 'external', type: 'database', name: 'База Demo Pay', hosts: ['192.0.2.9:5432'], description: null },
  { ...meta(5, { hidden: true, seedKey: 'old' }), key: 'old', kind: 'external', type: 'service', name: 'Старая система', hosts: [], description: null },
];

export const ID_TYPES: IdTypeRow[] = [
  { ...meta(1), key: 'user', kind: 'entity', name: 'Пользователь', statuses: [] },
  { ...meta(2), key: 'card', kind: 'entity', name: 'Карта', statuses: [] },
  {
    ...meta(3),
    key: 'transfer',
    kind: 'operation',
    name: 'Перевод',
    statuses: [
      { value: 'processing', name: 'В обработке', outcome: 'pending' },
      { value: 'completed', name: 'Выполнен', outcome: 'success' },
      { value: 'failed', name: 'Отказ', outcome: 'failure' },
    ],
  },
];

const method = (id: number, systemId: number, http: MethodRow['http'], path: string, name: string, extra: Partial<MethodRow> = {}): MethodRow => ({
  ...meta(id),
  systemId,
  http,
  path,
  rpc: '',
  name,
  domain: null,
  description: null,
  kind: 'call',
  op: null,
  fields: [],
  status: null,
  ...extra,
});

export const METHODS: MethodRow[] = [
  method(1, 1, 'GET', '/v1/users/{userId}/cards/{cardId}', 'Данные карты', { domain: 'Карты' }),
  method(2, 1, 'GET', '/v1/users/{user}/transfers/{transfer}', 'Статус перевода', { kind: 'status', op: 'transfer' }),
  method(3, 2, 'POST', '/v3/cards/info', 'Данные карты в коммутаторе'),
  method(4, 2, 'POST', '/v3/cards/token', 'Номер по токену'),
  method(5, 3, 'POST', '/v3/transfer', 'Выплата', { kind: 'start', op: 'transfer', fields: [{ in: 'request', path: 'document_id', type: 'transfer' }] }),
];

const error = (id: number, systemId: number | null, methodId: number | null, e: Partial<ErrorRow>): ErrorRow => ({
  ...meta(id),
  systemId,
  methodId,
  http: null,
  code: null,
  text: null,
  title: '',
  action: null,
  severity: 'error',
  partnerCode: null,
  ...e,
});

export const ERRORS: ErrorRow[] = [
  error(1, 2, null, { code: '200', title: 'Карта не найдена', action: 'Проверьте номер карты у клиента', partnerCode: '176' }),
  error(2, 2, 4, { code: '200', title: 'Карта не найдена' }),
  error(3, null, null, { http: 504, title: 'Система не ответила вовремя' }),
  error(4, 3, null, { code: '200', title: 'Выплата отклонена' }),
];

const rule = (id: number, systemId: number | null, methodId: number | null, r: Partial<OutcomeRow>): OutcomeRow => ({
  ...meta(id),
  systemId,
  methodId,
  priority: 100,
  when: { http: 200 },
  outcome: 'success',
  text: null,
  action: null,
  ...r,
});

export const RULES: OutcomeRow[] = [
  rule(1, 2, null, { priority: 100, when: { http: 200, fields: [{ path: 'status', equals: 'error' }] }, outcome: 'error', text: '{message}' }),
  rule(2, 2, null, { priority: 10, when: { http: 422, fields: [{ path: 'status', equals: 'OK' }] }, outcome: 'success' }),
  rule(3, 2, 3, { priority: 500, when: { http: { from: 400, to: 499 } }, outcome: 'error' }),
];

export const SNAPSHOT: CatalogResponse = { version: 3, state: 'ok', loadedAt: 1_793_000_000_000, idTypes: ID_TYPES, systems: SYSTEMS, methods: METHODS, errors: ERRORS, outcomeRules: RULES };

export const EMPTY: CatalogResponse = { version: 1, state: 'ok', loadedAt: 1_793_000_000_000, idTypes: [], systems: [SYSTEMS[0]!], methods: [], errors: [], outcomeRules: [] };
