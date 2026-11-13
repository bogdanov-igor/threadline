// Что открыть в редакторе: из шага запроса и из строки «Неизвестного», с данными шага.
import type { TraceStep, ViewRecord } from '@threadline/core/search';
import type { DraftOf, HttpVerb, IdTypeData, SystemData, UnknownRow } from '@threadline/core/catalog';
import { compactHost, pathTemplate, titleTemplate } from '@/lib/path-template.ts';
import type { StepCatalog } from './names.ts';

/** Запись для формы: id — правка, без id — новая запись с заполненными полями. systemKey — система, если id ещё не известен. */
export type EditTarget =
  | { kind: 'system'; id?: number; key?: string; draft?: Partial<SystemData> }
  | { kind: 'host'; host: string }
  | { kind: 'method'; id?: number; systemKey?: string; draft?: Partial<DraftOf['method']> }
  | { kind: 'error'; id?: number; systemKey?: string; draft?: Partial<DraftOf['error']>; sample?: string | null; /** Система ошибки не описана: на неё действует только общее правило. */ noSystem?: boolean }
  | { kind: 'outcome'; id?: number; systemKey?: string; draft?: Partial<DraftOf['outcome']> }
  | { kind: 'idType'; id?: number; draft?: Partial<IdTypeData> };

/** Действие SOAP или JSON-RPC по телу: первый элемент Body или method; у ответа без «Response». */
export function rpcOf(body: string | null, response = false): string {
  const s = body?.trim() ?? '';
  if (s.startsWith('<')) {
    const m = /<(?:[\w.-]+:)?Body\b[^>]*>\s*<(?:[\w.-]+:)?([\w.-]+)/.exec(s);
    const name = m?.[1] ?? '';
    return response ? name.replace(/Response$/, '') : name;
  }
  if (s.startsWith('{')) {
    try {
      const v = JSON.parse(s) as { jsonrpc?: unknown; method?: unknown };
      return v && v.jsonrpc !== undefined && typeof v.method === 'string' ? v.method : '';
    } catch {
      return '';
    }
  }
  return '';
}

const VERBS: readonly string[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', '*'];

/** HTTP-метод записи — в метод справочника; незнакомый — «любой». */
export function verbOf(method: string | null | undefined, fallback: HttpVerb = 'GET'): HttpVerb {
  if (!method) return fallback;
  const m = method.toUpperCase();
  return VERBS.includes(m) ? (m as HttpVerb) : '*';
}

function httpOf(r: ViewRecord | undefined, step: TraceStep): { method: string; path: string } {
  const t = titleTemplate(step.title);
  if (step.kind === 'exchange' && r?.http?.uri) {
    const u = titleTemplate(`${r.http.method ?? t.method ?? 'POST'} ${r.http.uri}`);
    return { method: u.method ?? 'POST', path: u.template };
  }
  return { method: t.method ?? 'GET', path: t.method ? t.template : pathTemplate(step.title).template };
}

export interface StepActions {
  /** «Добавить в справочник»: что из шага не узнано — система, метод или ошибка. */
  add: EditTarget | null;
  /** «Изменить в справочнике»: самая точная найденная запись. */
  edit: EditTarget | null;
  /** «Добавить правило итога» или «Изменить правило итога» — у ответа узнанной системы. */
  rule: { target: EditTarget; edit: boolean } | null;
}

/**
 * Действия справочника у шага. Без разметки (справочник выключен) — никаких. allowed — можно ли роли править записи вида:
 * недоступного действия нет, вместо него предлагается следующее, которое ей доступно.
 */
export function stepActions(step: TraceStep, c: StepCatalog | null, records: readonly ViewRecord[], allowed: (kind: EditTarget['kind']) => boolean = () => true): StepActions {
  const none = { add: null, edit: null, rule: null };
  if (!c || step.kind === 'call') return none;
  const first = records[0];
  const send = records.find((r) => r.kind === 'send' || r.kind === 'incoming') ?? first;
  const response = records.find((r) => r.kind === 'response');
  const system = c.name?.system ?? null;
  const method = c.name?.method ?? null;
  const http = httpOf(send, step);
  const isExchange = step.kind === 'exchange';
  const failed = step.isError || !!c.error;

  let add: EditTarget | null = null;
  const host = isExchange && !system && allowed('host') ? (c.name?.host ?? (send?.http?.uri ? compactHost(send.http.uri) : null)) : null;
  if (host) {
    add = { kind: 'host', host };
  } else if ((isExchange || step.kind === 'incoming') && !method && (!isExchange || !!system) && allowed('method')) {
    const rpc = rpcOf(send?.sections.body ?? null) || rpcOf(response?.sections.body ?? null, true);
    add = { kind: 'method', ...(system ? { systemKey: system.key } : {}), draft: { http: verbOf(http.method), path: http.path, rpc } };
  } else if (failed && c.error && c.error.rule === null && allowed('error')) {
    add = {
      kind: 'error',
      // Система не описана: запись на любой системе этот шаг не изменит, сработает только общая.
      ...(system ? { systemKey: system.key } : { noSystem: true }),
      draft: { ...(system ? {} : { systemId: null }), methodId: method?.id ?? null, http: c.error.raw.http, code: c.error.raw.code },
      sample: c.error.raw.text,
    };
  }

  let edit: EditTarget | null = null;
  if (c.error?.rule?.kind === 'error' && allowed('error')) edit = { kind: 'error', id: c.error.rule.id };
  else if (method && allowed('method')) edit = { kind: 'method', id: method.id };
  else if (system && allowed('system')) edit = { kind: 'system', key: system.key };

  let rule: StepActions['rule'] = null;
  if (!allowed('outcome')) rule = null;
  else if (c.outcome) rule = { target: { kind: 'outcome', id: c.outcome.rule.id }, edit: true };
  else if (system && response) {
    const status = response.http?.status ?? step.status;
    rule = {
      target: { kind: 'outcome', systemKey: system.key, draft: { methodId: method?.id ?? null, when: status !== null ? { http: status } : {}, outcome: 'success' } },
      edit: false,
    };
  }
  return { add, edit: add ? null : edit, rule };
}

/** Строка «Неизвестного» — в форму: метод, хост или ошибка с примером в подсказке. */
export function unknownTarget(u: UnknownRow): EditTarget {
  if (u.kind === 'host') return { kind: 'host', host: u.host ?? '' };
  if (u.kind === 'method') {
    return { kind: 'method', draft: { ...(u.systemId !== null ? { systemId: u.systemId } : {}), http: verbOf(u.httpMethod), path: u.path ?? '/', rpc: u.rpc ?? '' } };
  }
  return { kind: 'error', ...(u.systemId === null ? { noSystem: true } : {}), draft: { systemId: u.systemId, methodId: u.methodId, http: u.httpStatus, code: u.code }, sample: u.text };
}
