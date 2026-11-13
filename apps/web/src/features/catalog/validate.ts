// Модели форм и проверки на клиенте с теми же пределами, что у сервера.
// Сервер проверяет те же правила zod-схемой из core; когда схема появится в
// @threadline/core/catalog, проверки структуры берутся из неё, здесь остаются только подписи полей формы.
import { BUILTIN_MASKING, maskKindsText, maskText } from '@threadline/core/search';
import { generalRuleTooBroad, hiddenPart, parseHostPattern, sensitivePath, type CatalogResponse, type DraftOf, type ErrorRow, type HttpVerb, type IdField, type IdKind, type IdTypeData, type MethodKind, type OutcomeKind, type Severity, type StatusOutcome, type SystemData, type SystemKind, type SystemType } from '@threadline/core/catalog';
import { checkTemplate, conditionsToModel, MAX_VALUE, modelToConditions, newFieldKey, templatePlaces, type CondError, type ConditionsModel } from './conditions.ts';
import { needsOp } from './model.ts';

export const LIMITS = {
  name: 80,
  domain: 40,
  title: 200,
  action: 500,
  description: 500,
  textMatchMin: 3,
  textMatch: 200,
  code: 64,
  statusValue: 64,
  statuses: 30,
  fields: 10,
  fieldPath: 128,
  rpc: 128,
  path: 512,
  hosts: 50,
  host: 255,
} as const;

export type VKey =
  | CondError
  | 'pathStart'
  | 'pathQuery'
  | 'pathPlaceholder'
  | 'pathEmptySegment'
  | 'keySystem'
  | 'keyType'
  | 'hostFormat'
  | 'hostDuplicate'
  | 'hostTaken'
  | 'opRequired'
  | 'opNotOperation'
  | 'unknownType'
  | 'statusNotInType'
  | 'mapDuplicate'
  | 'valueDuplicate'
  | 'tooManyStatuses'
  | 'textMatchLength'
  | 'priorityRange'
  | 'noErrorConditions'
  | 'generalHttpOnly'
  | 'textHidden'
  | 'templateUnclosed'
  | 'templateTooMany'
  | 'templatePlace'
  | 'templateSensitive'
  | 'sensitive'
  | 'methodRequired'
  | 'systemRequired'
  | 'keyTaken'
  | 'duplicate';

export interface VError {
  key: VKey;
  max?: number;
  /** Название системы или записи, к которой относится ошибка. */
  name?: string;
  /** id существующей записи у повтора. */
  id?: number;
}

export type Errors = Record<string, VError>;

const NO_KEEP: ReadonlySet<string> = new Set();
/** Маскирование что-то скрыло бы: номер карты, секрет или значение вида, включённого по умолчанию. */
export const isMasked = (s: string) => s !== '' && (maskText(s, NO_KEEP) !== s || maskKindsText(s, BUILTIN_MASKING.strict, NO_KEEP) !== s);

/** Необязательный текст: пустой — null. */
const opt = (s: string) => (s.trim() === '' ? null : s.trim());

function text(errors: Errors, field: string, value: string, o: { max: number; required?: boolean; min?: number }): void {
  const v = value.trim();
  if (!v) {
    if (o.required) errors[field] = { key: 'required' };
    return;
  }
  if (o.min !== undefined && v.length < o.min) errors[field] = { key: 'textMatchLength' };
  else if (v.length > o.max) errors[field] = { key: o.min !== undefined ? 'textMatchLength' : 'tooLong', max: o.max };
  else if (isMasked(v)) errors[field] = { key: 'masked' };
}

// ---------- Шаблон пути ----------

const PLACE = /^\{[A-Za-z][A-Za-z0-9_-]*\}$/;

/** Шаблон пути: с «/», без «?» и «#», подстановка занимает сегмент целиком. */
export function checkPath(path: string): VKey | null {
  const p = path.trim();
  if (!p) return 'required';
  if (!p.startsWith('/')) return 'pathStart';
  if (/[?#]/.test(p)) return 'pathQuery';
  const segments = p.split('/').slice(1);
  for (const [i, seg] of segments.entries()) {
    if (seg === '' && i < segments.length - 1) return 'pathEmptySegment';
    if ((seg.includes('{') || seg.includes('}')) && !PLACE.test(seg)) return 'pathPlaceholder';
  }
  return null;
}

/** Подстановки без имён: {userId} и {id} — один метод (path_key). */
export const pathKey = (path: string) => path.trim().replace(/\{[^{}/]*\}/g, '{}').replace(/(.)\/$/, '$1');

// ---------- Хосты ----------

export function splitHosts(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** Та же проверка, что на сервере: подчёркивание в имени контейнера, порт, [ipv6], *.domain. */
export const hostValid = (h: string) => parseHostPattern(h) !== null;

// ---------- Система ----------

export interface SystemModel {
  key: string;
  kind: SystemKind;
  type: SystemType;
  name: string;
  hosts: string;
  description: string;
}

export function systemModel(d?: Partial<SystemData>): SystemModel {
  return {
    key: d?.key ?? '',
    kind: d?.kind ?? 'external',
    type: d?.type ?? 'service',
    name: d?.name ?? '',
    hosts: (d?.hosts ?? []).join('\n'),
    description: d?.description ?? '',
  };
}

export function systemDraft(m: SystemModel, s: CatalogResponse, selfId?: number): { draft: SystemData; errors: Errors } {
  const errors: Errors = {};
  const key = m.key.trim();
  if (!/^[a-z0-9-]{1,32}$/.test(key)) errors.key = { key: key ? 'keySystem' : 'required' };
  else {
    const taken = s.systems.find((x) => x.key === key && x.id !== selfId);
    if (taken) errors.key = { key: 'keyTaken', name: taken.name, id: taken.id };
  }
  text(errors, 'name', m.name, { max: LIMITS.name, required: true });
  text(errors, 'description', m.description, { max: LIMITS.description });
  const hosts = splitHosts(m.hosts);
  const bad = hosts.find((h) => !hostValid(h) || h.length > LIMITS.host);
  const dup = hosts.find((h, i) => hosts.indexOf(h) !== i);
  if (bad) errors.hosts = { key: 'hostFormat', name: bad };
  else if (dup) errors.hosts = { key: 'hostDuplicate', name: dup };
  else if (hosts.length > LIMITS.hosts) errors.hosts = { key: 'tooManyValues', max: LIMITS.hosts };
  else {
    // Хост скрытой системы свободен, как и на сервере.
    const other = s.systems.find((x) => x.id !== selfId && !x.hidden && x.hosts.some((h) => hosts.includes(h)));
    if (other) errors.hosts = { key: 'hostTaken', name: other.name, id: other.id };
  }
  // Система-автор — сервис.
  const type = m.kind === 'project' ? 'service' : m.type;
  return { draft: { key, kind: m.kind, type, name: m.name.trim(), hosts, description: opt(m.description) }, errors };
}

// ---------- Метод ----------

export interface FieldRowModel {
  key: string;
  in: IdField['in'];
  path: string;
  type: string;
}

export interface MapRowModel {
  key: string;
  from: string;
  to: string;
}

export interface MethodModel {
  systemId: number;
  http: HttpVerb;
  path: string;
  rpc: string;
  name: string;
  domain: string;
  description: string;
  kind: MethodKind;
  op: string;
  fields: FieldRowModel[];
  /** Поле статуса задано. */
  status: boolean;
  statusIn: 'request' | 'response';
  statusPath: string;
  statusMap: MapRowModel[];
}

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', '*'] as const;

export function methodModel(d: Partial<DraftOf['method']> & { systemId: number }): MethodModel {
  return {
    systemId: d.systemId,
    http: d.http ?? 'GET',
    path: d.path ?? '',
    rpc: d.rpc ?? '',
    name: d.name ?? '',
    domain: d.domain ?? '',
    description: d.description ?? '',
    kind: d.kind ?? 'call',
    op: d.op ?? '',
    fields: (d.fields ?? []).map((f) => ({ key: newFieldKey(), ...f })),
    status: !!d.status,
    statusIn: d.status?.in ?? 'response',
    statusPath: d.status?.path ?? '',
    statusMap: Object.entries(d.status?.map ?? {}).map(([from, to]) => ({ key: newFieldKey(), from, to })),
  };
}

export function methodDraft(m: MethodModel, s: CatalogResponse, selfId?: number): { draft: DraftOf['method']; errors: Errors } {
  const errors: Errors = {};
  const pathError = checkPath(m.path);
  if (pathError) errors.path = { key: pathError };
  else if (m.path.trim().length > LIMITS.path) errors.path = { key: 'tooLong', max: LIMITS.path };
  else if (isMasked(m.path.trim())) errors.path = { key: 'masked' };
  text(errors, 'rpc', m.rpc, { max: LIMITS.rpc });
  text(errors, 'name', m.name, { max: LIMITS.name, required: true });
  text(errors, 'domain', m.domain, { max: LIMITS.domain });
  text(errors, 'description', m.description, { max: LIMITS.description });

  const types = new Map(s.idTypes.filter((t) => !t.hidden).map((t) => [t.key, t]));
  const op = m.op.trim() || null;
  const opType = op ? types.get(op) : undefined;
  if (needsOp(m.kind) && !op) errors.op = { key: 'opRequired' };
  else if (op && !opType) errors.op = { key: 'unknownType' };
  else if (opType && opType.kind !== 'operation') errors.op = { key: 'opNotOperation' };

  if (m.fields.length > LIMITS.fields) errors.fields = { key: 'tooManyFields', max: LIMITS.fields };
  m.fields.forEach((f, i) => {
    const p = f.path.trim();
    if (!p) errors[`fields.${i}.path`] = { key: 'required' };
    else if (p.length > LIMITS.fieldPath) errors[`fields.${i}.path`] = { key: 'pathTooLong', max: LIMITS.fieldPath };
    else if (sensitivePath(p)) errors[`fields.${i}.path`] = { key: 'sensitive' };
    if (!f.type) errors[`fields.${i}.type`] = { key: 'required' };
    else if (!types.has(f.type)) errors[`fields.${i}.type`] = { key: 'unknownType' };
  });

  const hasStatus = m.status && !!op;
  const map: Record<string, string> = {};
  if (hasStatus) {
    const p = m.statusPath.trim();
    if (!p) errors.statusPath = { key: 'required' };
    else if (p.length > LIMITS.fieldPath) errors.statusPath = { key: 'pathTooLong', max: LIMITS.fieldPath };
    else if (sensitivePath(p)) errors.statusPath = { key: 'sensitive' };
    const values = new Set(opType?.statuses.map((x) => x.value) ?? []);
    m.statusMap.forEach((r, i) => {
      const from = r.from.trim();
      if (!from) errors[`statusMap.${i}.from`] = { key: 'required' };
      else if (from.length > LIMITS.statusValue) errors[`statusMap.${i}.from`] = { key: 'tooLong', max: LIMITS.statusValue };
      else if (Object.keys(map).some((k) => k.toLowerCase() === from.toLowerCase())) errors[`statusMap.${i}.from`] = { key: 'mapDuplicate' };
      if (!r.to) errors[`statusMap.${i}.to`] = { key: 'required' };
      else if (opType && !values.has(r.to)) errors[`statusMap.${i}.to`] = { key: 'statusNotInType' };
      if (from) map[from] = r.to;
    });
  }

  const draft: DraftOf['method'] = {
    systemId: m.systemId,
    http: m.http,
    path: m.path.trim(),
    rpc: m.rpc.trim(),
    name: m.name.trim(),
    domain: opt(m.domain),
    description: opt(m.description),
    kind: m.kind,
    op,
    fields: m.fields.map((f) => ({ in: f.in, path: f.path.trim(), type: f.type })),
    status: hasStatus ? { in: m.statusIn, path: m.statusPath.trim(), ...(Object.keys(map).length ? { map } : {}) } : null,
  };

  if (!errors.path) {
    const key = pathKey(draft.path);
    const dup = s.methods.find((x) => x.id !== selfId && x.systemId === draft.systemId && x.http === draft.http && x.rpc === draft.rpc && pathKey(x.path) === key);
    if (dup) errors.path = { key: 'duplicate', name: dup.name, id: dup.id };
  }
  return { draft, errors };
}

// ---------- Ошибка ----------

export interface ErrorModel {
  systemId: number | null;
  methodId: number | null;
  http: string;
  code: string;
  text: string;
  title: string;
  action: string;
  severity: Severity;
  partnerCode: string;
}

export function errorModel(d?: Partial<DraftOf['error']>): ErrorModel {
  return {
    systemId: d?.systemId ?? null,
    methodId: d?.methodId ?? null,
    http: d?.http != null ? String(d.http) : '',
    code: d?.code ?? '',
    text: d?.text ?? '',
    title: d?.title ?? '',
    action: d?.action ?? '',
    severity: d?.severity ?? 'error',
    partnerCode: d?.partnerCode ?? '',
  };
}

/** В значении есть маска или «…»: с настоящей ошибкой оно не совпадёт. */
const HIDDEN_PART = /[*…]/;

/**
 * Условия новой записи из шага или строки «Неизвестного»: только те, что совпадут с настоящей ошибкой.
 * Подстрока берётся из примера, если других условий нет или запись общая: общая действует на весь проект, одного кода ей мало.
 * Поле однострочное, поэтому из примера берётся первая строка.
 */
export function errorPrefill(d: Partial<DraftOf['error']> | undefined, sample: string | null | undefined, general: boolean): Partial<DraftOf['error']> {
  const code = d?.code && HIDDEN_PART.test(d.code) ? null : (d?.code ?? null);
  const line = sample?.split(/\r?\n/, 1)[0]?.trim().slice(0, LIMITS.textMatch).trim() ?? '';
  const usable = line.length >= LIMITS.textMatchMin && !HIDDEN_PART.test(line);
  return { ...d, code, text: usable && (general || (code === null && d?.http == null)) ? line : (d?.text ?? null) };
}

/** was: запись, которую правит форма. Её прежние условия остаются допустимыми. */
export function errorDraft(m: ErrorModel, was?: ErrorRow): { draft: DraftOf['error']; errors: Errors } {
  const errors: Errors = {};
  let http: number | null = null;
  if (m.http.trim()) {
    const n = Number(m.http.trim());
    if (!/^\d{3}$/.test(m.http.trim()) || n < 100 || n > 599) errors.http = { key: 'httpRange' };
    else http = n;
  }
  text(errors, 'code', m.code, { max: LIMITS.code });
  text(errors, 'text', m.text, { max: LIMITS.textMatch, min: LIMITS.textMatchMin });
  if (hiddenPart(m.text)) errors.text = { key: 'textHidden' };
  text(errors, 'title', m.title, { max: LIMITS.title, required: true });
  text(errors, 'action', m.action, { max: LIMITS.action });
  text(errors, 'partnerCode', m.partnerCode, { max: LIMITS.code });
  if (!m.http.trim() && !m.code.trim() && !m.text.trim()) errors.conditions = { key: 'noErrorConditions' };
  if (m.methodId !== null && m.systemId === null) errors.methodId = { key: 'systemRequired' };
  const draft: DraftOf['error'] = {
    systemId: m.systemId,
    methodId: m.systemId === null ? null : m.methodId,
    http,
    code: opt(m.code),
    text: opt(m.text),
    title: m.title.trim(),
    action: opt(m.action),
    severity: m.severity,
    partnerCode: opt(m.partnerCode),
  };
  if (generalRuleTooBroad(draft, was)) errors.text = { key: 'generalHttpOnly' };
  return { draft, errors };
}

// ---------- Тип id ----------

export interface StatusRowModel {
  key: string;
  value: string;
  name: string;
  outcome: StatusOutcome;
}

export interface IdTypeModel {
  key: string;
  kind: IdKind;
  name: string;
  statuses: StatusRowModel[];
}

export function idTypeModel(d?: Partial<IdTypeData>): IdTypeModel {
  return {
    key: d?.key ?? '',
    kind: d?.kind ?? 'entity',
    name: d?.name ?? '',
    statuses: (d?.statuses ?? []).map((x) => ({ key: newFieldKey(), ...x })),
  };
}

export function idTypeDraft(m: IdTypeModel, s: CatalogResponse, selfId?: number): { draft: IdTypeData; errors: Errors } {
  const errors: Errors = {};
  const key = m.key.trim();
  if (!/^[a-z][a-z0-9_]{0,31}$/.test(key)) errors.key = { key: key ? 'keyType' : 'required' };
  else {
    const taken = s.idTypes.find((x) => x.key === key && x.id !== selfId);
    if (taken) errors.key = { key: 'keyTaken', name: taken.name, id: taken.id };
  }
  text(errors, 'name', m.name, { max: LIMITS.name, required: true });
  const statuses = m.kind === 'operation' ? m.statuses : [];
  if (statuses.length > LIMITS.statuses) errors.statuses = { key: 'tooManyStatuses', max: LIMITS.statuses };
  const seen = new Set<string>();
  statuses.forEach((x, i) => {
    const v = x.value.trim();
    if (!v) errors[`statuses.${i}.value`] = { key: 'required' };
    else if (v.length > LIMITS.statusValue) errors[`statuses.${i}.value`] = { key: 'tooLong', max: LIMITS.statusValue };
    else if (seen.has(v.toLowerCase())) errors[`statuses.${i}.value`] = { key: 'valueDuplicate' };
    else if (isMasked(v)) errors[`statuses.${i}.value`] = { key: 'masked' };
    seen.add(v.toLowerCase());
    text(errors, `statuses.${i}.name`, x.name, { max: LIMITS.name, required: true });
  });
  return {
    draft: { key, kind: m.kind, name: m.name.trim(), statuses: statuses.map((x) => ({ value: x.value.trim(), name: x.name.trim(), outcome: x.outcome })) },
    errors,
  };
}

/** Перестановка строки словаря: вверх или вниз. */
export function moveRow<T>(rows: readonly T[], index: number, delta: -1 | 1): T[] {
  const to = index + delta;
  if (to < 0 || to >= rows.length) return [...rows];
  const out = [...rows];
  [out[index], out[to]] = [out[to]!, out[index]!];
  return out;
}

// ---------- Правило итога ----------

export type RuleLevelModel = 'method' | 'system' | 'general';

export interface OutcomeModel {
  level: RuleLevelModel;
  systemId: number | null;
  methodId: number | null;
  priority: string;
  conditions: ConditionsModel;
  outcome: OutcomeKind;
  text: string;
  action: string;
}

export function outcomeModel(d?: Partial<DraftOf['outcome']>): OutcomeModel {
  const systemId = d?.systemId ?? null;
  const methodId = d?.methodId ?? null;
  return {
    level: methodId !== null ? 'method' : systemId !== null ? 'system' : 'general',
    systemId,
    methodId,
    priority: String(d?.priority ?? 100),
    conditions: conditionsToModel(d?.when),
    outcome: d?.outcome ?? 'success',
    text: d?.text ?? '',
    action: d?.action ?? '',
  };
}

const COND_MAX: Partial<Record<CondError, number>> = { tooLong: MAX_VALUE, tooManyValues: 50, tooManyFields: 10, pathTooLong: LIMITS.fieldPath };

export function outcomeDraft(m: OutcomeModel): { draft: DraftOf['outcome']; errors: Errors } {
  const errors: Errors = {};
  const p = m.priority.trim();
  const priority = Number(p);
  if (!/^\d{1,4}$/.test(p) || priority < 1 || priority > 1000) errors.priority = { key: 'priorityRange' };
  if (m.level !== 'general' && m.systemId === null) errors.systemId = { key: 'systemRequired' };
  if (m.level === 'method' && m.methodId === null) errors.methodId = { key: 'methodRequired' };
  const c = modelToConditions(m.conditions, isMasked, (path) => sensitivePath(path) !== null);
  for (const [field, key] of Object.entries(c.errors)) errors[field] = { key, ...(COND_MAX[key] ? { max: COND_MAX[key] } : {}) };
  const t = m.text.trim();
  const te = t ? checkTemplate(t) : null;
  if (te) errors.text = { key: te, ...(te === 'tooLong' ? { max: 200 } : {}) };
  else if (isMasked(t)) errors.text = { key: 'masked' };
  else if (templatePlaces(t).some((p) => sensitivePath(p))) errors.text = { key: 'templateSensitive' };
  text(errors, 'action', m.action, { max: LIMITS.action });
  return {
    draft: {
      systemId: m.level === 'general' ? null : m.systemId,
      methodId: m.level === 'method' ? m.methodId : null,
      priority: Number.isFinite(priority) ? priority : 100,
      when: c.conditions,
      outcome: m.outcome,
      text: opt(m.text),
      action: opt(m.action),
    },
    errors,
  };
}

/** Ошибки сервера 422 по путям API — на поля формы: «when.fields.0.value» → «fields.0.value». */
export function serverFieldErrors(fields: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, key] of Object.entries(fields ?? {})) {
    const p = path
      .replace(/^when\.http(\..*)?$/, 'http.equals')
      .replace(/^when\.fields\.(\d+)\.(?:regex|equals|oneOf)(?:\..*)?$/, 'fields.$1.value')
      .replace(/^when\./, '')
      .replace(/^status\.map\..*/, 'statusMap')
      .replace(/^status\.(path|in)$/, 'statusPath')
      .replace(/^fields\.(\d+)\.path$/, 'fields.$1.path')
      .replace(/^hosts\.\d+$/, 'hosts');
    out[p] = key;
  }
  return out;
}
