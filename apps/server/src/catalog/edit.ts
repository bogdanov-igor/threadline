// Правка записей справочника из редактора: проверка схемой и правилами core, повторы, хосты, ссылки,
// защита от одновременной правки по updated_at, мягкое удаление.
// Каждая функция работает внутри транзакции правки (CatalogService.edit) и бросает CatalogHttpError.

import {
  checkError,
  checkIdType,
  checkMethod,
  checkOutcome,
  checkSystem,
  errorInput,
  errorKey,
  GENERAL_HTTP_ONLY,
  hiddenPart,
  TEXT_HIDDEN,
  generalRuleTooBroad,
  HIDDEN_AUTHOR_MESSAGE,
  idTypeInput,
  methodInput,
  methodKey,
  normalizeHostPattern,
  outcomeInput,
  outcomeKey,
  systemInput,
  toErrorData,
  toIdTypeData,
  toMethodData,
  toOutcomeData,
  toSystemData,
  zodIssues,
  type CatalogErrorCode,
  type CatalogErrorExtra,
  templatePlaceholders,
  type CatalogSnapshot,
  type DeleteResult,
  type Issue,
  type MaskingSaved,
} from '@threadline/core/catalog';
import { MASK_KINDS, maskingKeyIssues, normalizeFieldName, type MaskKind } from '@threadline/core/search';
import { isUniqueViolation, type Queryable } from './db.ts';
import * as store from './store.ts';

export type { CatalogErrorCode };

export class CatalogHttpError extends Error {
  readonly status: number;
  readonly code: CatalogErrorCode;
  readonly extra: CatalogErrorExtra;
  constructor(status: number, code: CatalogErrorCode, extra: CatalogErrorExtra = {}) {
    super(code);
    this.name = 'CatalogHttpError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export type EntityKind = store.RowKind;

const ROUTE_KIND: Readonly<Record<string, EntityKind>> = {
  'id-types': 'idType',
  systems: 'system',
  methods: 'method',
  errors: 'error',
  'outcome-rules': 'outcome',
};

/** Сегмент адреса API → вид записи. Только свои ключи: /catalog/constructor и /catalog/__proto__ — не разделы. */
export function routeKind(section: string): EntityKind | undefined {
  return Object.hasOwn(ROUTE_KIND, section) ? ROUTE_KIND[section] : undefined;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function invalid(issues: Issue[]): never {
  const fields: Record<string, string> = {};
  const fieldKeys: NonNullable<CatalogErrorExtra['fieldKeys']> = {};
  for (const i of issues) {
    if (i.path in fields) continue;
    fields[i.path] = i.message;
    if (i.key) fieldKeys[i.path] = { key: i.key, ...(i.params ? { params: i.params } : {}) };
  }
  throw new CatalogHttpError(422, 'catalog-invalid', { fields, ...(Object.keys(fieldKeys).length > 0 ? { fieldKeys } : {}) });
}

const SYSTEM_HIDDEN: Issue = { path: 'systemId', message: 'система скрыта: верните её, чтобы добавлять и править её записи', key: 'catalog.systemHidden' };
const METHOD_HIDDEN: Issue = { path: 'methodId', message: 'метод скрыт: верните его, чтобы добавлять и править его записи', key: 'catalog.methodHidden' };

type Schema<T> = { safeParse(v: unknown): { success: true; data: T } | { success: false; error: Parameters<typeof zodIssues>[0] } };

function parse<T>(schema: Schema<T>, body: Obj): T {
  const r = schema.safeParse(body);
  if (!r.success) invalid(zodIssues(r.error));
  return r.data;
}

/** Служебные поля тела: ссылки и метка версии, остальное — данные записи. */
function split(body: unknown, refs: readonly string[]): { data: Obj; refs: Obj; updatedAt: string | undefined } {
  if (!isObj(body)) throw new CatalogHttpError(400, 'bad-request', { details: 'тело запроса: объект JSON' });
  const data: Obj = {};
  const r: Obj = {};
  for (const [k, v] of Object.entries(body)) {
    if (k === 'updatedAt') continue;
    if (refs.includes(k)) r[k] = v;
    else data[k] = v;
  }
  const updatedAt = typeof body.updatedAt === 'string' ? body.updatedAt : undefined;
  return { data, refs: r, updatedAt };
}

const idOrNull = (v: unknown, path: string): number | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' && Number.isInteger(v) && v > 0) return v;
  invalid([{ path, message: 'id записи: целое число' }]);
};

function rowsOf(s: CatalogSnapshot, kind: EntityKind): { id: number; updatedAt: string; seedKey: string | null; hidden: boolean }[] {
  return kind === 'idType' ? s.idTypes : kind === 'system' ? s.systems : kind === 'method' ? s.methods : kind === 'error' ? s.errors : s.outcomeRules;
}

function found<T extends { id: number }>(list: readonly T[], id: number): T {
  const row = list.find((r) => r.id === id);
  if (!row) throw new CatalogHttpError(404, 'catalog-not-found');
  return row;
}

async function fresh(q: Queryable, kind: EntityKind, project: string, id: number): Promise<store.RowOf[EntityKind] | undefined> {
  return (await store.getRow(q, kind, project, id)) ?? undefined;
}

/** Метка версии: тело правки несёт updatedAt, который видел аналитик. */
async function guard(q: Queryable, kind: EntityKind, project: string, row: { id: number; updatedAt: string }, updatedAt: string | undefined): Promise<void> {
  if (updatedAt === undefined) invalid([{ path: 'updatedAt', message: 'нужна метка версии записи updatedAt' }]);
  if (row.updatedAt !== updatedAt) throw new CatalogHttpError(409, 'catalog-conflict', { current: await fresh(q, kind, project, row.id) });
}

/** Сколько методов и правил итога читают поля вида: значения этих полей теперь показаны маской. */
export function maskingReaders(s: CatalogSnapshot, keys: readonly string[]): number {
  const names = new Set(keys.map(normalizeFieldName));
  const reads = (path: string) => path.split('.').some((n) => names.has(normalizeFieldName(n)));
  let n = 0;
  for (const m of s.methods) if (!m.hidden && (m.fields.some((f) => reads(f.path)) || (m.status !== null && reads(m.status.path)))) n++;
  for (const r of s.outcomeRules) {
    if (r.hidden) continue;
    const t = r.text ? templatePlaceholders(r.text) : null;
    if ((r.when.fields ?? []).some((f) => reads(f.path)) || (t?.ok === true && t.paths.some(reads))) n++;
  }
  return n;
}

/** Правка вида маскирования: вид целиком, защита по updatedAt, строка становится ручной. */
export async function saveMasking(q: Queryable, project: string, type: MaskKind, body: unknown): Promise<MaskingSaved> {
  if (!isObj(body)) throw new CatalogHttpError(400, 'bad-request', { details: 'тело запроса: объект JSON' });
  const { enabled, keys, updatedAt } = body;
  if (typeof enabled !== 'boolean') invalid([{ path: 'enabled', message: 'нужно true или false' }]);
  if (!Array.isArray(keys) || !keys.every((k) => typeof k === 'string')) invalid([{ path: 'keys', message: 'список имён полей' }]);
  if (typeof updatedAt !== 'string') invalid([{ path: 'updatedAt', message: 'нужна метка версии записи updatedAt' }]);
  const snapshot = await store.loadSnapshot(q, project);
  const row = (snapshot.masking ?? []).find((r) => r.type === type);
  if (!row) throw new CatalogHttpError(404, 'catalog-not-found');
  if (row.updatedAt !== updatedAt) throw new CatalogHttpError(409, 'catalog-conflict', { current: row });
  if (!enabled && !MASK_KINDS[type].switchable) invalid([{ path: 'enabled', message: `у вида «${MASK_KINDS[type].label}» нет выключателя`, key: 'masking.kindLocked' }]);
  const issues = maskingKeyIssues(type, keys as string[], snapshot.masking ?? [], 'keys', row.keys);
  if (issues.length > 0) invalid(issues);
  await store.writeMasking(q, project, type, enabled, keys as string[], true);
  return { row: (await store.getMasking(q, project, type))!, readers: maskingReaders(snapshot, keys as string[]) };
}

function keysOf(s: CatalogSnapshot) {
  const sysKey = new Map(s.systems.map((x) => [x.id, x.key]));
  const mKey = new Map(s.methods.map((m) => [m.id, methodKey(sysKey.get(m.systemId) ?? '', m)]));
  return { sysKey, mKey };
}

/**
 * Ссылка на систему и метод правила: метод — своей системы. Скрытый родитель отклоняется: при мягком удалении молчаливая
 * правка была бы ловушкой. Возврат самой записи проходит: она заработает после возврата родителя.
 */
function scopeOf(s: CatalogSnapshot, refs: Obj, restoring: boolean): { systemId: number | null; methodId: number | null } {
  const systemId = idOrNull(refs.systemId, 'systemId');
  const methodId = idOrNull(refs.methodId, 'methodId');
  const system = systemId === null ? undefined : s.systems.find((x) => x.id === systemId);
  if (systemId !== null && !system) invalid([{ path: 'systemId', message: 'системы нет в справочнике' }]);
  if (system?.hidden && !restoring) invalid([SYSTEM_HIDDEN]);
  if (methodId !== null) {
    const m = s.methods.find((x) => x.id === methodId);
    if (!m) invalid([{ path: 'methodId', message: 'метода нет в справочнике' }]);
    if (systemId === null || m.systemId !== systemId) invalid([{ path: 'methodId', message: 'метод другой системы' }]);
    if (m.hidden && !restoring) invalid([METHOD_HIDDEN]);
  }
  return { systemId, methodId };
}

/** Запись с тем же ключом уже есть. Скрытая названа отдельно: уникальные индексы считают и её, форма предлагает вернуть. */
function duplicate(existing: { id: number; hidden: boolean } | null): never {
  throw new CatalogHttpError(409, 'catalog-duplicate', { existingId: existing?.id ?? 0, ...(existing?.hidden ? { existingHidden: true } : {}) });
}

/** Сколько методов ссылаются на тип: op или поле id. */
function typeUses(s: CatalogSnapshot, key: string): number {
  return s.methods.filter((m) => m.op === key || m.fields.some((f) => f.type === key)).length;
}

/** Новая запись: повтор ключа ловит индекс, отметка удаления навсегда с этим ключом снимается. */
async function insertGuarded(q: Queryable, project: string, kind: EntityKind, key: string, fn: () => Promise<number>): Promise<number> {
  let id: number;
  try {
    id = await fn();
  } catch (e) {
    if (isUniqueViolation(e)) duplicate(null);
    throw e;
  }
  await store.clearDeleted(q, project, kind, key);
  return id;
}

/** Создание или правка записи. id — правка. Возвращает id записи. */
export async function saveRow(q: Queryable, project: string, kind: EntityKind, body: unknown, id: number | null): Promise<number> {
  const s = await store.loadSnapshot(q, project);
  const editing = id === null ? null : found(rowsOf(s, kind), id);
  const refs = kind === 'method' ? ['systemId'] : kind === 'error' || kind === 'outcome' ? ['systemId', 'methodId'] : [];
  const { data: raw, refs: r, updatedAt } = split(body, refs);
  if (editing) await guard(q, kind, project, editing, updatedAt);
  const hidden = typeof raw.hidden === 'boolean' ? raw.hidden : (editing?.hidden ?? false);
  const restoring = editing?.hidden === true && !hidden;
  // Правка редактора: edited — импорт без force запись не тронет. seed_key остаётся прежним.
  const meta = { edited: true, hidden };
  const { sysKey, mKey } = keysOf(s);

  switch (kind) {
    case 'idType': {
      const d = toIdTypeData(parse(idTypeInput, raw));
      const issues = checkIdType(d);
      const prev = editing ? s.idTypes.find((t) => t.id === editing.id)! : null;
      if (prev && prev.key !== d.key) issues.push({ path: 'key', message: 'ключ типа после создания не меняется' });
      if (issues.length) invalid(issues);
      const other = s.idTypes.find((t) => t.key === d.key && t.id !== id);
      if (other) duplicate(other);
      if (prev) {
        const uses = typeUses(s, prev.key);
        if (uses > 0 && hidden && !prev.hidden) throw new CatalogHttpError(409, 'catalog-in-use', { count: uses });
        if (uses > 0 && d.kind !== 'operation' && prev.kind === 'operation') throw new CatalogHttpError(409, 'catalog-in-use', { count: uses });
        await store.updateIdType(q, project, prev.id, d, meta);
        return prev.id;
      }
      return insertGuarded(q, project, kind, d.key, () => store.insertIdType(q, project, d, { ...meta, seedKey: null }));
    }
    case 'system': {
      const d = toSystemData(parse(systemInput, raw));
      const prev = editing ? s.systems.find((x) => x.id === editing.id)! : null;
      const issues = checkSystem(d, { project, otherHosts: new Map() });
      if (prev?.kind === 'project' && d.kind !== 'project') issues.push({ path: 'kind', message: 'система-автор остаётся системой проекта' });
      if (!prev && d.kind === 'project') issues.push({ path: 'kind', message: 'система-автор у проекта одна' });
      if (prev && prev.key !== d.key && prev.kind === 'project') issues.push({ path: 'key', message: 'ключ системы-автора равен id проекта' });
      if ((prev?.kind === 'project' || d.kind === 'project') && hidden) issues.push({ path: 'hidden', message: HIDDEN_AUTHOR_MESSAGE });
      if (prev && d.type !== 'service' && d.type !== prev.type) {
        const methods = s.methods.filter((m) => m.systemId === prev.id).length;
        if (methods > 0) issues.push({ path: 'type', message: `у системы ${methods} методов: у базы данных и шины сообщений методов нет` });
      }
      if (issues.length) invalid(issues);
      const other = s.systems.find((x) => x.key === d.key && x.id !== id);
      if (other) duplicate(other);
      for (const h of d.hosts) {
        const norm = normalizeHostPattern(h);
        const taken = s.systems.find((x) => x.id !== id && !x.hidden && x.hosts.some((y) => normalizeHostPattern(y) === norm));
        if (taken) throw new CatalogHttpError(409, 'catalog-host-taken', { host: h, system: { id: taken.id, key: taken.key, name: taken.name } });
      }
      if (prev) {
        await store.updateSystem(q, project, prev.id, d, meta);
        return prev.id;
      }
      return insertGuarded(q, project, kind, d.key, () => store.insertSystem(q, project, d, { ...meta, seedKey: null }));
    }
    case 'method': {
      const systemId = idOrNull(r.systemId, 'systemId');
      const system = s.systems.find((x) => x.id === systemId);
      if (!system) invalid([{ path: 'systemId', message: 'системы нет в справочнике' }]);
      if (system.hidden && !restoring) invalid([SYSTEM_HIDDEN]);
      const d = toMethodData(parse(methodInput, raw));
      const idTypes = new Map(s.idTypes.filter((t) => !t.hidden).map((t) => [t.key, t]));
      const issues = checkMethod(d, { system, idTypes });
      if (issues.length) invalid(issues);
      const key = methodKey(system.key, d);
      const other = s.methods.find((m) => m.id !== id && mKey.get(m.id) === key);
      if (other) duplicate(other);
      if (editing) {
        await store.updateMethod(q, project, editing.id, system.id, d, meta);
        return editing.id;
      }
      return insertGuarded(q, project, kind, key, () => store.insertMethod(q, project, system.id, d, { ...meta, seedKey: null }));
    }
    case 'error': {
      const scope = scopeOf(s, r, restoring);
      const d = toErrorData(parse(errorInput, raw));
      // Первое сообщение поля остаётся: про скрытую часть вперёд общего про маску.
      const issues = [...(hiddenPart(d.text) ? [{ path: 'text', ...TEXT_HIDDEN }] : []), ...checkError(d)];
      if (generalRuleTooBroad({ ...d, systemId: scope.systemId }, s.errors.find((e) => e.id === id))) issues.push({ path: 'text', ...GENERAL_HTTP_ONLY });
      if (issues.length) invalid(issues);
      const key = errorKey(scope.systemId === null ? null : sysKey.get(scope.systemId)!, scope.methodId === null ? null : mKey.get(scope.methodId)!, d);
      const other = s.errors.find((e) => e.id !== id && errorKey(e.systemId === null ? null : (sysKey.get(e.systemId) ?? null), e.methodId === null ? null : (mKey.get(e.methodId) ?? null), e) === key);
      if (other) duplicate(other);
      if (editing) {
        await store.updateError(q, project, editing.id, scope.systemId, scope.methodId, d, meta);
        return editing.id;
      }
      return insertGuarded(q, project, kind, key, () => store.insertError(q, project, scope.systemId, scope.methodId, d, { ...meta, seedKey: null }));
    }
    case 'outcome': {
      const scope = scopeOf(s, r, restoring);
      const d = toOutcomeData(parse(outcomeInput, raw));
      const issues = checkOutcome(d);
      if (issues.length) invalid(issues);
      const key = outcomeKey(scope.systemId === null ? null : sysKey.get(scope.systemId)!, scope.methodId === null ? null : mKey.get(scope.methodId)!, d);
      const other = s.outcomeRules.find((o) => o.id !== id && outcomeKey(o.systemId === null ? null : (sysKey.get(o.systemId) ?? null), o.methodId === null ? null : (mKey.get(o.methodId) ?? null), o) === key);
      if (other) duplicate(other);
      if (editing) {
        await store.updateOutcome(q, project, editing.id, scope.systemId, scope.methodId, d, meta);
        return editing.id;
      }
      return insertGuarded(q, project, kind, key, () => store.insertOutcome(q, project, scope.systemId, scope.methodId, d, { ...meta, seedKey: null }));
    }
  }
}

export type RemoveResult = DeleteResult;

/** Общие проверки удаления. Возвращает строку и число зависимых записей. */
async function removable(q: Queryable, s: CatalogSnapshot, project: string, kind: EntityKind, id: number, updatedAt: string | undefined) {
  const row = found(rowsOf(s, kind), id);
  await guard(q, kind, project, row, updatedAt);
  if (kind === 'system' && s.systems.find((x) => x.id === id)!.kind === 'project') throw new CatalogHttpError(409, 'catalog-author');
  if (kind === 'idType') {
    const uses = typeUses(s, s.idTypes.find((t) => t.id === id)!.key);
    if (uses > 0) throw new CatalogHttpError(409, 'catalog-in-use', { count: uses });
  }
  const deps = kind === 'system' || kind === 'method' ? await store.dependents(q, kind, project, id) : undefined;
  return { row, deps };
}

/** Удаление всегда обратимо: запись скрывается, сама она и зависимые остаются в базе. */
export async function removeRow(q: Queryable, project: string, kind: EntityKind, id: number, updatedAt: string | undefined): Promise<RemoveResult> {
  const s = await store.loadSnapshot(q, project);
  const { row, deps } = await removable(q, s, project, kind, id, updatedAt);
  await store.hideRow(q, kind, project, id, row.updatedAt);
  return { deleted: false, hidden: true, ...(deps ? { dependents: deps } : {}) };
}

/** Отметки записей файла: сама запись и зависимые, которые сотрёт внешний ключ. Запись без seed_key отметки не даёт. */
function deletedMarks(s: CatalogSnapshot, kind: EntityKind, row: { seedKey: string | null }, id: number): { kind: EntityKind; seedKey: string }[] {
  const methods = kind === 'system' ? s.methods.filter((m) => m.systemId === id) : [];
  const methodIds = new Set(kind === 'method' ? [id] : methods.map((m) => m.id));
  const owned = (r: { systemId: number | null; methodId: number | null }) => (kind === 'system' && r.systemId === id) || (r.methodId !== null && methodIds.has(r.methodId));
  const nested = kind === 'system' || kind === 'method';
  const all: [EntityKind, { seedKey: string | null }][] = [
    [kind, row],
    ...methods.map((m): [EntityKind, { seedKey: string | null }] => ['method', m]),
    ...(nested ? s.errors.filter(owned).map((e): [EntityKind, { seedKey: string | null }] => ['error', e]) : []),
    ...(nested ? s.outcomeRules.filter(owned).map((o): [EntityKind, { seedKey: string | null }] => ['outcome', o]) : []),
  ];
  return all.flatMap(([k, r]) => (r.seedKey === null ? [] : [{ kind: k, seedKey: r.seedKey }]));
}

/** Удаление навсегда: только запись, которую уже удалили мягко. Зависимые стирает внешний ключ, отметки пишутся той же транзакцией. */
export async function removeForever(q: Queryable, project: string, kind: EntityKind, id: number, updatedAt: string | undefined): Promise<RemoveResult> {
  const s = await store.loadSnapshot(q, project);
  const { row, deps } = await removable(q, s, project, kind, id, updatedAt);
  if (!row.hidden) throw new CatalogHttpError(409, 'catalog-not-hidden');
  await store.markDeleted(q, project, deletedMarks(s, kind, row, id));
  await store.deleteRow(q, kind, project, id, row.updatedAt);
  return { deleted: true, hidden: false, ...(deps ? { dependents: deps } : {}) };
}
