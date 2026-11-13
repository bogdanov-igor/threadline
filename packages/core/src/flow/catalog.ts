// Разметка справочника, которую читает граф и операция.
// Граф и операция зависят только от этих полей, а не от полного типа разметки в search/api.ts (ViewRecord.catalog): граф читает разметку
// через этот адаптер: поля те же, лишние поля разметки не мешают, без разметки — null.
import type { ViewRecord } from '../search/api.ts';

export type FlowSystemType = 'service' | 'database' | 'queue';
export type FlowMethodKind = 'call' | 'start' | 'status' | 'callback';
export type FlowStatusOutcome = 'pending' | 'success' | 'failure';
export type FlowOutcomeKind = 'success' | 'error' | 'pending' | 'ignore';

export interface FlowCatalogName {
  system: { key: string; name: string; type: FlowSystemType } | null;
  method: {
    id: number;
    name: string;
    kind: FlowMethodKind;
    opType: { key: string; name: string } | null;
    /** У метода есть поле статуса. Нет поля в разметке — тогда «статус» с типом операции считается со статусом. */
    hasStatus?: boolean;
  } | null;
}

export interface FlowCatalogId {
  type: string;
  name: string;
  kind: 'entity' | 'operation';
  value: string;
  at: 'path' | 'query' | 'request' | 'response';
}

export interface FlowCatalogStatus {
  type: string;
  value: string;
  raw: string;
  name: string | null;
  outcome: FlowStatusOutcome | null;
  order: number | null;
}

export interface FlowCatalogMarkup {
  name: FlowCatalogName | null;
  error: { title: string | null; severity: 'error' | 'ok' } | null;
  outcome: { kind: FlowOutcomeKind; text: string | null } | null;
  ids: FlowCatalogId[];
  status: FlowCatalogStatus | null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** Разметка записи или null: справочник выключен, запись не размечена или разметка не той формы. */
export function catalogOf(r: ViewRecord): FlowCatalogMarkup | null {
  const c = (r as ViewRecord & { catalog?: unknown }).catalog;
  if (!isObj(c)) return null;
  return {
    name: nameOf(c.name),
    error: isObj(c.error) ? { title: str(c.error.title), severity: c.error.severity === 'ok' ? 'ok' : 'error' } : null,
    outcome: outcomeOf(c.outcome),
    ids: Array.isArray(c.ids) ? c.ids.filter(isId) : [],
    status: statusOf(c.status),
  };
}

function nameOf(v: unknown): FlowCatalogName | null {
  if (!isObj(v)) return null;
  const s = v.system;
  const m = v.method;
  const system =
    isObj(s) && typeof s.key === 'string' && typeof s.name === 'string'
      ? { key: s.key, name: s.name, type: s.type === 'database' || s.type === 'queue' ? s.type : ('service' as FlowSystemType) }
      : null;
  let method: FlowCatalogName['method'] = null;
  if (isObj(m) && typeof m.name === 'string') {
    const kind: FlowMethodKind = m.kind === 'start' || m.kind === 'status' || m.kind === 'callback' ? m.kind : 'call';
    const op = isObj(m.opType) && typeof m.opType.key === 'string' ? { key: m.opType.key, name: str(m.opType.name) ?? m.opType.key } : null;
    method = { id: typeof m.id === 'number' ? m.id : 0, name: m.name, kind, opType: op };
    if (typeof m.hasStatus === 'boolean') method.hasStatus = m.hasStatus;
  }
  return { system, method };
}

function outcomeOf(v: unknown): FlowCatalogMarkup['outcome'] {
  if (!isObj(v)) return null;
  const k = v.kind;
  if (k !== 'success' && k !== 'error' && k !== 'pending' && k !== 'ignore') return null;
  return { kind: k, text: str(v.text) };
}

function isId(v: unknown): v is FlowCatalogId {
  return (
    isObj(v) &&
    typeof v.type === 'string' &&
    typeof v.value === 'string' &&
    (v.kind === 'entity' || v.kind === 'operation') &&
    (v.at === 'path' || v.at === 'query' || v.at === 'request' || v.at === 'response')
  );
}

function statusOf(v: unknown): FlowCatalogStatus | null {
  if (!isObj(v) || typeof v.type !== 'string' || typeof v.value !== 'string') return null;
  const o = v.outcome;
  return {
    type: v.type,
    value: v.value,
    raw: str(v.raw) ?? v.value,
    name: str(v.name),
    outcome: o === 'pending' || o === 'success' || o === 'failure' ? o : null,
    order: typeof v.order === 'number' ? v.order : null,
  };
}

/** Ключ пары тип + значение id: по нему склеивается операция. */
export const idKey = (type: string, value: string): string => `${type}\u0000${value}`;

/** Последние 4 символа значения: «…4821». */
export const shortId = (value: string): string => (value.length <= 4 ? value : value.slice(-4));
