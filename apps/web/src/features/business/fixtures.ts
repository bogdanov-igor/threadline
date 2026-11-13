// Выдуманные запросы для экрана Бизнеса: полный ответ проходит тот же список полей, что на сервере. Только для тестов, в сборку не входит.
import type { ErrorReason, RecordCatalog, RequestDetail, RequestSummary, ViewRecord } from '@threadline/core/search';
import { businessDetail } from '@threadline/core/view/business';

export type FixtureState = 'ok' | 'known' | 'unknown' | 'noresp';

export const FIXTURE_START = Date.UTC(2026, 10, 2, 9, 41, 7);
export const FIXTURE_ENTRY = 'Перевод между картами';
export const FIXTURE_LEAKS = ['cards.pay.example', '192.0.2.17', '8443', 'PRC-ERR-0027', 'P-51', '447700900001', 'сырая строка', 'Insufficient', 'x-secret', 'cid-business-'];

const RAW = { http: 402, code: 'PRC-ERR-0027', text: 'Insufficient funds' };
const uuid = '5a1d0100-e29b-41d4-a716-446655440000';

const named = (method: string, system = 'Процессинг карт'): Pick<RecordCatalog, 'name'> => ({
  name: { source: 'external', system: { key: 'cards', name: system, type: 'service' }, method: { id: 1, name: method, domain: null, kind: 'call', opType: null }, host: 'cards.pay.example:8443' },
});

const catalog = (method: string, over: Partial<RecordCatalog> = {}): RecordCatalog => ({ ...named(method), error: null, outcome: null, ids: [], status: null, ...over });

const sections = { headers: { 'x-secret': 'x-secret' }, body: '{"phone":"447700900001"}', payload: null, context: null };

function base(id: string, at: number, over: Partial<ViewRecord> & Pick<ViewRecord, 'kind'>): ViewRecord {
  return {
    id,
    tsNs: String(FIXTURE_START + at),
    timeMs: FIXTURE_START + at,
    offsetMs: at,
    title: 'сырая строка',
    message: 'сырая строка 447700900001',
    level: 'INFO',
    isError: false,
    component: 'api',
    gateway: false,
    correlationId: 'cid-business-1',
    requestId: 'rq',
    http: null,
    sections: sections as unknown as ViewRecord['sections'],
    raw: 'сырая строка',
    match: 'exact',
    ...over,
  };
}

/** Обмен: отправка и, если передан конец, ответ. */
function exchange(id: string, from: number, to: number | null, c: RecordCatalog | null, isError = false): ViewRecord[] {
  const uri = `https://cards.pay.example:8443/v3/card/${uuid}?x=1`;
  const http = { method: 'POST', uri, status: null, durationMs: null, pairId: to === null ? null : `${id}-r`, noResponse: to === null, pending: false };
  const send = base(id, from, { kind: 'send', http, ...(c ? { catalog: c } : {}) });
  if (to === null) return [send];
  return [send, base(`${id}-r`, to, { kind: 'response', isError, http: { ...http, status: isError ? 402 : 200, durationMs: to - from, pairId: id, noResponse: false }, ...(c ? { catalog: c } : {}) })];
}

const ENTRY: RecordCatalog = { ...catalog(FIXTURE_ENTRY) };

function detail(status: RequestSummary['status'], records: ViewRecord[], reasons: ErrorReason[], over: Partial<RequestSummary> = {}): RequestDetail {
  const last = records.reduce((m, r) => Math.max(m, r.timeMs), FIXTURE_START);
  const summary: RequestSummary = {
    correlationId: 'cid-business-1',
    firstMs: FIXTURE_START,
    lastMs: last,
    durationMs: last - FIXTURE_START,
    incoming: { method: 'POST', path: `/v1/transfers/${uuid}?x=1` },
    component: 'api',
    recordCount: records.length,
    status,
    kind: 'incoming',
    reasons,
    match: 'exact',
    incomplete: false,
    entry: ENTRY.name,
    ...over,
  };
  return businessDetail({ summary, records });
}

const INCOMING = base('in', 0, { kind: 'incoming', http: { method: 'POST', uri: `/v1/transfers/${uuid}?x=1`, status: null, durationMs: null, pairId: null, noResponse: false, pending: false }, catalog: ENTRY });

const SENDER = 'Проверка карты отправителя';
const RECEIVER = 'Проверка карты получателя';
const DEBIT = 'Списание с карты отправителя';
const CREDIT = 'Зачисление на карту получателя';
const NOTIFY = 'Уведомление клиенту';

export const FIXTURE_TITLE = 'Недостаточно средств на карте отправителя';
export const FIXTURE_ACTION = 'Клиенту нужно пополнить карту или перевести меньшую сумму.';

export function fixture(state: FixtureState, over: Partial<RequestSummary> = {}): RequestDetail {
  const first = [...exchange('s1', 10, 210, catalog(SENDER)), ...exchange('s2', 220, 620, catalog(RECEIVER))];
  if (state === 'ok') {
    const records = [INCOMING, ...first, ...exchange('s3', 630, 1230, catalog(DEBIT, { outcome: { kind: 'success', rule: { id: 7, level: 'system' }, text: 'Списано', fixed: true, action: null } })), ...exchange('s4', 1240, 2140, catalog(CREDIT)), ...exchange('s5', 2150, 2400, catalog(NOTIFY))];
    return detail('success', records, [], over);
  }
  if (state === 'known') {
    const error: RecordCatalog['error'] = { source: 'external', rule: { id: 9, level: 'system', kind: 'error' }, title: FIXTURE_TITLE, action: FIXTURE_ACTION, severity: 'error', partnerCode: 'P-51', raw: RAW };
    const c = catalog(DEBIT, { error });
    return detail('error', [INCOMING, ...first, ...exchange('s3', 630, 1100, c, true)], [{ kind: 'business', text: 'PRC-ERR-0027 Insufficient funds · POST cards.pay.example:8443', name: c.name, error }], over);
  }
  if (state === 'unknown') {
    const c = catalog(CREDIT);
    return detail('error', [INCOMING, ...first, ...exchange('s3', 630, 1230, catalog(DEBIT)), ...exchange('s4', 1240, 2000, c, true), ...exchange('s5', 2010, 2040, catalog(NOTIFY))], [{ kind: 'http', text: 'HTTP 402 · POST 192.0.2.17:8443/v3/card', name: c.name, error: null }], over);
  }
  const c = catalog(RECEIVER);
  const records = [INCOMING, ...exchange('s1', 10, 210, catalog(SENDER)), ...exchange('s2', 220, null, c), base('tail', 20_200, { kind: 'log' })];
  return detail('error', records, [{ kind: 'no-response', text: 'ответ не найден · POST cards.pay.example:8443', name: c.name, error: null }], over);
}
