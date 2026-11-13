// SQL справочника: чтение проекта целиком, запись строк, версия, «Неизвестное».
// Только запросы; проверки записей — в edit.ts и в core (@threadline/core/catalog).

import {
  codeKey,
  condKey,
  methodKey,
  pathKey,
  type CatalogSnapshot,
  type ErrorData,
  type ErrorRow,
  type IdTypeData,
  type IdTypeRow,
  type MaskingRow,
  type MethodData,
  type MethodRow,
  type OutcomeData,
  type OutcomeRow,
  type SystemData,
  type SystemRow,
  type Dependents,
  type RowKind as CoreRowKind,
  type RowOf as CoreRowOf,
  type UnknownItem,
  type UnknownKind,
  type UnknownRow,
} from '@threadline/core/catalog';
import { MASK_KIND_CODES, MASK_KINDS, withoutHtml } from '@threadline/core/search';
import { limitLockWait, type Queryable, type Row } from './db.ts';

/** updated_at с микросекундами в UTC: метка версии строки для защиты от одновременной правки. */
const UPDATED = `to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at`;
const META = `seed_key, edited, hidden, ${UPDATED}`;

/** Ключ pg_advisory_xact_lock правок и импорта: первое число — пространство Threadline, второе — hashtext(проект). */
export const EDIT_LOCK_NS = 7_310_421;

const num = (v: unknown): number => Number(v);
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

function meta(r: Row) {
  return { id: num(r.id), hidden: r.hidden === true, edited: r.edited === true, seedKey: strOrNull(r.seed_key), updatedAt: String(r.updated_at) };
}

export function idTypeRow(r: Row): IdTypeRow {
  return { ...meta(r), key: String(r.key), kind: r.kind as IdTypeRow['kind'], name: String(r.name), statuses: (r.statuses as IdTypeRow['statuses']) ?? [] };
}
export function systemRow(r: Row): SystemRow {
  return {
    ...meta(r),
    key: String(r.key),
    kind: r.kind as SystemRow['kind'],
    type: r.type as SystemRow['type'],
    name: String(r.name),
    hosts: (r.hosts as string[]) ?? [],
    description: strOrNull(r.description),
  };
}
export function methodRow(r: Row): MethodRow {
  return {
    ...meta(r),
    systemId: num(r.system_id),
    http: r.http_method as MethodRow['http'],
    path: String(r.path),
    rpc: String(r.rpc ?? ''),
    name: String(r.name),
    domain: strOrNull(r.domain),
    description: strOrNull(r.description),
    kind: r.kind as MethodRow['kind'],
    op: strOrNull(r.op_type),
    fields: (r.fields as MethodRow['fields']) ?? [],
    status: (r.status_at as MethodRow['status']) ?? null,
  };
}
export function errorRow(r: Row): ErrorRow {
  return {
    ...meta(r),
    systemId: numOrNull(r.system_id),
    methodId: numOrNull(r.method_id),
    http: numOrNull(r.http_status),
    code: strOrNull(r.code),
    text: strOrNull(r.text_match),
    title: String(r.title),
    action: strOrNull(r.action),
    severity: r.severity as ErrorRow['severity'],
    partnerCode: strOrNull(r.partner_code),
  };
}
export function outcomeRow(r: Row): OutcomeRow {
  return {
    ...meta(r),
    systemId: numOrNull(r.system_id),
    methodId: numOrNull(r.method_id),
    priority: num(r.priority),
    when: r.conditions as OutcomeRow['when'],
    outcome: r.outcome as OutcomeRow['outcome'],
    text: strOrNull(r.text),
    action: strOrNull(r.action),
  };
}

export function maskingRow(r: Row): MaskingRow {
  return { id: num(r.id), type: String(r.type), enabled: r.enabled === true, keys: (r.keys as string[]) ?? [], edited: r.edited === true, updatedAt: String(r.updated_at) };
}

const SELECT_MASKING = `select id, type, enabled, keys, edited, ${UPDATED} from catalog_masking`;

const SELECT = {
  idType: `select id, key, kind, name, statuses, ${META} from catalog_id_type`,
  system: `select id, key, kind, type, name, hosts, description, ${META} from catalog_system`,
  method: `select id, system_id, http_method, path, rpc, name, domain, description, kind, op_type, fields, status_at, ${META} from catalog_method`,
  error: `select id, system_id, method_id, http_status, code, text_match, title, action, severity, partner_code, ${META} from catalog_error`,
  outcome: `select id, system_id, method_id, priority, conditions, outcome, text, action, ${META} from catalog_outcome_rule`,
} as const;

export type RowKind = CoreRowKind & keyof typeof SELECT;
export const TABLE: Record<RowKind, string> = {
  idType: 'catalog_id_type',
  system: 'catalog_system',
  method: 'catalog_method',
  error: 'catalog_error',
  outcome: 'catalog_outcome_rule',
};
const MAPPER = { idType: idTypeRow, system: systemRow, method: methodRow, error: errorRow, outcome: outcomeRow } as const;
export type RowOf = CoreRowOf;

/** Одна строка по id в проекте; null — нет. */
export async function getRow<K extends RowKind>(q: Queryable, kind: K, project: string, id: number): Promise<RowOf[K] | null> {
  const rows = await q.query(`${SELECT[kind]} where project_id = $1 and id = $2`, [project, id]);
  return rows[0] ? (MAPPER[kind](rows[0]) as RowOf[K]) : null;
}

/** Справочник проекта целиком, со скрытыми: пять запросов и версия. Проекта нет — пустой с версией 0. */
export async function loadSnapshot(q: Queryable, project: string): Promise<CatalogSnapshot> {
  const v = await q.query<{ version: unknown }>('select version from catalog_project where project_id = $1', [project]);
  const order = ' where project_id = $1 order by id';
  // По очереди: внутри транзакции все запросы идут по одному соединению.
  const idTypes = await q.query(SELECT.idType + order, [project]);
  const systems = await q.query(SELECT.system + order, [project]);
  const methods = await q.query(SELECT.method + order, [project]);
  const errors = await q.query(SELECT.error + order, [project]);
  const outcomeRules = await q.query(SELECT.outcome + order, [project]);
  const masking = await q.query(SELECT_MASKING + order, [project]);
  return {
    project,
    version: v[0] ? num(v[0].version) : 0,
    idTypes: idTypes.map(idTypeRow),
    systems: systems.map(systemRow),
    methods: methods.map(methodRow),
    errors: errors.map(errorRow),
    outcomeRules: outcomeRules.map(outcomeRow),
    masking: masking.map(maskingRow),
  };
}

/**
 * Проект и система-автор: создаются, если их нет. Название автора — из настройки, только при создании.
 * У автора seed_key = ключ: начальный набор вправе переименовать его, пока аналитик не правил запись.
 */
export async function ensureProject(q: Queryable, project: string, name: string): Promise<boolean> {
  await q.query('insert into catalog_project (project_id) values ($1) on conflict do nothing', [project]);
  // Система с ключом проекта всегда автор и всегда видна: старый файл мог поменять ей вид или скрыть её.
  const repaired = await q.query(
    `update catalog_system set kind = 'project', type = 'service', hidden = false, updated_at = clock_timestamp()
      where project_id = $1 and key = $1 and (kind <> 'project' or type <> 'service' or hidden)
        and not exists (select 1 from catalog_system o where o.project_id = $1 and o.kind = 'project' and o.key <> $1)
      returning id`,
    [project],
  );
  if (repaired.length > 0) await bumpVersion(q, project);
  const created = await q.query(
    `insert into catalog_system (project_id, key, kind, type, name, seed_key)
     select $1, $1, 'project', 'service', $2, $1
     where not exists (select 1 from catalog_system where project_id = $1 and kind = 'project')
     on conflict do nothing returning id`,
    [project, name],
  );
  if (created.length > 0) await bumpVersion(q, project);
  // Строки всех видов: другая копия увидит строку и её updatedAt, поэтому правка всегда идёт по существующей строке.
  const masking = await q.query(
    `insert into catalog_masking (project_id, type, enabled) select $1, t, e from unnest($2::text[], $3::boolean[]) as u(t, e) on conflict do nothing returning id`,
    [project, [...MASK_KIND_CODES], MASK_KIND_CODES.map((k) => MASK_KINDS[k].defaultEnabled)],
  );
  if (masking.length > 0) await bumpVersion(q, project);
  return created.length > 0;
}

export async function getMasking(q: Queryable, project: string, type: string): Promise<MaskingRow | null> {
  const rows = await q.query(`${SELECT_MASKING} where project_id = $1 and type = $2`, [project, type]);
  return rows[0] ? maskingRow(rows[0]) : null;
}

/** Вид целиком. Строки может ещё не быть, если копия читала раньше, чем её создали. */
export async function writeMasking(q: Queryable, project: string, type: string, enabled: boolean, keys: readonly string[], edited: boolean): Promise<void> {
  await q.query(
    `insert into catalog_masking (project_id, type, enabled, keys, edited) values ($1, $2, $3, $4::text[], $5)
     on conflict (project_id, type) do update set enabled = excluded.enabled, keys = excluded.keys, edited = excluded.edited, updated_at = clock_timestamp()`,
    [project, type, enabled, [...keys], edited],
  );
}

/**
 * Ключ системы → id и ключ метода → id: ссылки записей файла. Запись ищется и по ключу записи файла (seed_key), и по
 * смысловому: аналитик мог поправить путь метода, а файл знает его по старому. Как и в diffCatalog, seed_key сильнее.
 */
export function snapshotKeys(s: CatalogSnapshot): { systems: Map<string, number>; methods: Map<string, number> } {
  const sysKey = new Map(s.systems.map((x) => [x.id, x.key]));
  const systems = new Map(s.systems.map((x) => [x.key, x.id]));
  for (const x of s.systems) if (x.seedKey !== null) systems.set(x.seedKey, x.id);
  const methods = new Map(s.methods.map((m) => [methodKey(sysKey.get(m.systemId) ?? '', m), m.id]));
  for (const m of s.methods) if (m.seedKey !== null) methods.set(m.seedKey, m.id);
  return { systems, methods };
}

export async function bumpVersion(q: Queryable, project: string): Promise<void> {
  await q.query('update catalog_project set version = version + 1 where project_id = $1', [project]);
}

export async function lockProject(q: Queryable, project: string): Promise<void> {
  await limitLockWait(q);
  await q.query('select pg_advisory_xact_lock($1, hashtext($2))', [EDIT_LOCK_NS, project]);
}

export async function versions(q: Queryable): Promise<Map<string, number>> {
  const rows = await q.query<{ project_id: string; version: unknown }>('select project_id, version from catalog_project');
  return new Map(rows.map((r) => [r.project_id, num(r.version)]));
}

/**
 * Отметка в seed_hash: справочник проекта загружен командой или со страницы. Начальный набор при старте его больше не трогает:
 * записи такого импорта — тоже записи файла (edited = false), и набор из образа переписал бы их своими.
 */
export const OPERATOR_SEED = 'operator';

export async function seedHash(q: Queryable, project: string): Promise<string | null> {
  const rows = await q.query<{ seed_hash: string | null }>('select seed_hash from catalog_project where project_id = $1', [project]);
  return rows[0]?.seed_hash ?? null;
}

export async function setSeedHash(q: Queryable, project: string, hash: string): Promise<void> {
  await q.query('update catalog_project set seed_hash = $2 where project_id = $1', [project, hash]);
}

// ---------- Запись строк ----------

/** Ключ записи файла и отметки: у записи файла seed_key и edited = false, у правки редактора — edited = true. */
export interface WriteMeta {
  seedKey?: string | null;
  edited: boolean;
  hidden: boolean;
}

const json = (v: unknown) => JSON.stringify(v);

export async function insertIdType(q: Queryable, project: string, d: IdTypeData, m: WriteMeta): Promise<number> {
  const r = await q.query<{ id: unknown }>(
    `insert into catalog_id_type (project_id, key, kind, name, statuses, seed_key, edited, hidden)
     values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8) returning id`,
    [project, d.key, d.kind, d.name, json(d.statuses), m.seedKey ?? null, m.edited, m.hidden],
  );
  return num(r[0]!.id);
}

export async function insertSystem(q: Queryable, project: string, d: SystemData, m: WriteMeta): Promise<number> {
  const r = await q.query<{ id: unknown }>(
    `insert into catalog_system (project_id, key, kind, type, name, hosts, description, seed_key, edited, hidden)
     values ($1, $2, $3, $4, $5, $6::text[], $7, $8, $9, $10) returning id`,
    [project, d.key, d.kind, d.type, d.name, d.hosts, d.description, m.seedKey ?? null, m.edited, m.hidden],
  );
  return num(r[0]!.id);
}

export async function insertMethod(q: Queryable, project: string, systemId: number, d: MethodData, m: WriteMeta): Promise<number> {
  const r = await q.query<{ id: unknown }>(
    `insert into catalog_method (project_id, system_id, http_method, path, path_key, rpc, name, domain, description, kind, op_type, fields, status_at, seed_key, edited, hidden)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14, $15, $16) returning id`,
    [project, systemId, d.http, d.path, pathKey(d.path), d.rpc, d.name, d.domain, d.description, d.kind, d.op, json(d.fields), d.status ? json(d.status) : null, m.seedKey ?? null, m.edited, m.hidden],
  );
  return num(r[0]!.id);
}

export async function insertError(q: Queryable, project: string, systemId: number | null, methodId: number | null, d: ErrorData, m: WriteMeta): Promise<number> {
  const r = await q.query<{ id: unknown }>(
    `insert into catalog_error (project_id, system_id, method_id, http_status, code, code_key, text_match, title, action, severity, partner_code, seed_key, edited, hidden)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) returning id`,
    [project, systemId, methodId, d.http, d.code, codeKey(d.code), d.text, d.title, d.action, d.severity, d.partnerCode, m.seedKey ?? null, m.edited, m.hidden],
  );
  return num(r[0]!.id);
}

export async function insertOutcome(q: Queryable, project: string, systemId: number | null, methodId: number | null, d: OutcomeData, m: WriteMeta): Promise<number> {
  const r = await q.query<{ id: unknown }>(
    `insert into catalog_outcome_rule (project_id, system_id, method_id, priority, conditions, cond_key, outcome, text, action, seed_key, edited, hidden)
     values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12) returning id`,
    [project, systemId, methodId, d.priority, json(d.when), condKey(d.when), d.outcome, d.text, d.action, m.seedKey ?? null, m.edited, m.hidden],
  );
  return num(r[0]!.id);
}

/**
 * Правка строки. expected — updated_at, который видел аналитик: не совпал — ноль строк (конфликт).
 * seedKey undefined — ключ записи файла не меняется.
 */
interface UpdateGuard {
  expected?: string | undefined;
}

async function update(q: Queryable, table: string, project: string, id: number, sets: string[], params: unknown[], m: WriteMeta, g: UpdateGuard): Promise<boolean> {
  const all = [...params];
  const p = (v: unknown) => {
    all.push(v);
    return `$${all.length}`;
  };
  const cols = [...sets, `edited = ${p(m.edited)}`, `hidden = ${p(m.hidden)}`, 'updated_at = clock_timestamp()'];
  if (m.seedKey !== undefined) cols.push(`seed_key = ${p(m.seedKey)}`);
  let where = `project_id = ${p(project)} and id = ${p(id)}`;
  if (g.expected !== undefined) where += ` and updated_at = ${p(g.expected)}::timestamptz`;
  const rows = await q.query(`update ${table} set ${cols.join(', ')} where ${where} returning id`, all);
  return rows.length > 0;
}

export function updateIdType(q: Queryable, project: string, id: number, d: IdTypeData, m: WriteMeta, g: UpdateGuard = {}): Promise<boolean> {
  return update(q, TABLE.idType, project, id, ['kind = $1', 'name = $2', 'statuses = $3::jsonb'], [d.kind, d.name, json(d.statuses)], m, g);
}

export function updateSystem(q: Queryable, project: string, id: number, d: SystemData, m: WriteMeta, g: UpdateGuard = {}): Promise<boolean> {
  return update(
    q,
    TABLE.system,
    project,
    id,
    ['key = $1', 'kind = $2', 'type = $3', 'name = $4', 'hosts = $5::text[]', 'description = $6'],
    [d.key, d.kind, d.type, d.name, d.hosts, d.description],
    m,
    g,
  );
}

export function updateMethod(q: Queryable, project: string, id: number, systemId: number, d: MethodData, m: WriteMeta, g: UpdateGuard = {}): Promise<boolean> {
  return update(
    q,
    TABLE.method,
    project,
    id,
    [
      'system_id = $1',
      'http_method = $2',
      'path = $3',
      'path_key = $4',
      'rpc = $5',
      'name = $6',
      'domain = $7',
      'description = $8',
      'kind = $9',
      'op_type = $10',
      'fields = $11::jsonb',
      'status_at = $12::jsonb',
    ],
    [systemId, d.http, d.path, pathKey(d.path), d.rpc, d.name, d.domain, d.description, d.kind, d.op, json(d.fields), d.status ? json(d.status) : null],
    m,
    g,
  );
}

export function updateError(q: Queryable, project: string, id: number, systemId: number | null, methodId: number | null, d: ErrorData, m: WriteMeta, g: UpdateGuard = {}): Promise<boolean> {
  return update(
    q,
    TABLE.error,
    project,
    id,
    ['system_id = $1', 'method_id = $2', 'http_status = $3', 'code = $4', 'code_key = $5', 'text_match = $6', 'title = $7', 'action = $8', 'severity = $9', 'partner_code = $10'],
    [systemId, methodId, d.http, d.code, codeKey(d.code), d.text, d.title, d.action, d.severity, d.partnerCode],
    m,
    g,
  );
}

export function updateOutcome(q: Queryable, project: string, id: number, systemId: number | null, methodId: number | null, d: OutcomeData, m: WriteMeta, g: UpdateGuard = {}): Promise<boolean> {
  return update(
    q,
    TABLE.outcome,
    project,
    id,
    ['system_id = $1', 'method_id = $2', 'priority = $3', 'conditions = $4::jsonb', 'cond_key = $5', 'outcome = $6', 'text = $7', 'action = $8'],
    [systemId, methodId, d.priority, json(d.when), condKey(d.when), d.outcome, d.text, d.action],
    m,
    g,
  );
}

/** Мягкое удаление: hidden и edited, чтобы импорт её не вернул. Зависимые записи не меняются, сопоставление их и так не использует. */
export async function hideRow(q: Queryable, kind: RowKind, project: string, id: number, expected: string): Promise<boolean> {
  const rows = await q.query(
    `update ${TABLE[kind]} set hidden = true, edited = true, updated_at = clock_timestamp()
     where project_id = $1 and id = $2 and updated_at = $3::timestamptz returning id`,
    [project, id, expected],
  );
  return rows.length > 0;
}

export async function deleteRow(q: Queryable, kind: RowKind, project: string, id: number, expected: string): Promise<boolean> {
  const rows = await q.query(`delete from ${TABLE[kind]} where project_id = $1 and id = $2 and updated_at = $3::timestamptz returning id`, [project, id, expected]);
  return rows.length > 0;
}

/** Ключи записей файла, удалённых навсегда, в виде kind|ключ: файл такую запись снова не добавляет. */
export async function deletedKeys(q: Queryable, project: string): Promise<Set<string>> {
  const rows = await q.query<{ kind: string; seed_key: string }>('select kind, seed_key from catalog_deleted where project_id = $1', [project]);
  return new Set(rows.map((r) => `${r.kind}|${r.seed_key}`));
}

export async function markDeleted(q: Queryable, project: string, marks: readonly { kind: RowKind; seedKey: string }[]): Promise<void> {
  if (marks.length === 0) return;
  await q.query(
    `insert into catalog_deleted (project_id, kind, seed_key)
     select $1, u.kind, u.seed_key from unnest($2::text[], $3::text[]) as u(kind, seed_key)
     on conflict do nothing`,
    [project, marks.map((m) => m.kind), marks.map((m) => m.seedKey)],
  );
}

/** Запись с этим ключом создали заново: отметка снимается. */
export async function clearDeleted(q: Queryable, project: string, kind: RowKind, key: string): Promise<void> {
  await q.query('delete from catalog_deleted where project_id = $1 and kind = $2 and seed_key = $3', [project, kind, key]);
}

/** Зависимые записи системы или метода: подтверждение удаления. */
export async function dependents(q: Queryable, kind: 'system' | 'method', project: string, id: number): Promise<Dependents> {
  const col = kind === 'system' ? 'system_id' : 'method_id';
  const count = async (table: string) =>
    num((await q.query<{ n: unknown }>(`select count(*) as n from ${table} where project_id = $1 and ${col} = $2`, [project, id]))[0]!.n);
  const out: Dependents = { errors: await count(TABLE.error), outcomeRules: await count(TABLE.outcome) };
  if (kind === 'system') out.methods = await count(TABLE.method);
  return out;
}

// ---------- «Неизвестное» ----------

export type { UnknownRow };

const UNKNOWN_COLS = `id, kind, system_id, method_id, http_method, path, rpc, host, http_status, code, text, env, stand, example_cid, example_ms, count,
  to_char(first_seen at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as first_seen,
  to_char(last_seen at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as last_seen, hidden`;

const unknownRowText = (text: string | null): string | null => (text === null ? null : withoutHtml(text) || null);

function unknownRow(r: Row): UnknownRow {
  return {
    id: num(r.id),
    kind: r.kind as UnknownKind,
    systemId: numOrNull(r.system_id),
    methodId: numOrNull(r.method_id),
    httpMethod: strOrNull(r.http_method),
    path: strOrNull(r.path),
    rpc: strOrNull(r.rpc),
    host: strOrNull(r.host),
    httpStatus: numOrNull(r.http_status),
    code: strOrNull(r.code),
    // Строка, записанная до того, как текст ошибки стал очищаться от HTML, может хранить страницу: новая запись придёт только со следующей такой ошибкой.
    text: unknownRowText(strOrNull(r.text)),
    env: String(r.env),
    stand: strOrNull(r.stand),
    exampleCid: String(r.example_cid),
    exampleMs: num(r.example_ms),
    count: num(r.count),
    firstSeen: String(r.first_seen),
    lastSeen: String(r.last_seen),
    hidden: r.hidden === true,
  };
}

export interface UnknownFilter {
  kind?: UnknownKind | undefined;
  env?: string | undefined;
  hidden: boolean;
  offset: number;
  limit: number;
}

export async function listUnknown(q: Queryable, project: string, f: UnknownFilter): Promise<{ rows: UnknownRow[]; total: number }> {
  const params: unknown[] = [project, f.hidden];
  let where = 'project_id = $1 and hidden = $2';
  if (f.kind) {
    params.push(f.kind);
    where += ` and kind = $${params.length}`;
  }
  if (f.env) {
    params.push(f.env);
    where += ` and env = $${params.length}`;
  }
  const total = num((await q.query<{ n: unknown }>(`select count(*) as n from catalog_unknown where ${where}`, params))[0]!.n);
  const rows = await q.query(
    `select ${UNKNOWN_COLS} from catalog_unknown where ${where} order by count desc, last_seen desc, id desc limit ${f.limit} offset ${f.offset}`,
    params,
  );
  return { rows: rows.map(unknownRow), total };
}

/** Открытые строки «Неизвестного» по проектам: для значка в шапке. Проекта без строк в ответе нет. */
export async function openUnknownCounts(q: Queryable): Promise<Record<string, number>> {
  const rows = await q.query<{ project_id: string; n: unknown }>('select project_id, count(*) as n from catalog_unknown where hidden = false group by project_id');
  return Object.fromEntries(rows.map((r) => [r.project_id, num(r.n)]));
}

/** Вид строки «Неизвестного»: от него зависит, кто её скрывает. null — строки нет. */
export async function unknownKind(q: Queryable, project: string, id: number): Promise<UnknownKind | null> {
  const rows = await q.query<{ kind: string }>('select kind from catalog_unknown where project_id = $1 and id = $2', [project, id]);
  return rows[0] ? (rows[0].kind as UnknownKind) : null;
}

export async function setUnknownHidden(q: Queryable, project: string, id: number, hidden: boolean): Promise<UnknownRow | null> {
  const rows = await q.query(`update catalog_unknown set hidden = $3 where project_id = $1 and id = $2 returning ${UNKNOWN_COLS}`, [project, id, hidden]);
  return rows[0] ? unknownRow(rows[0]) : null;
}

/** Все строки «Неизвестного» проекта для уборки после правки (до предела). */
export async function allUnknown(q: Queryable, project: string, limit: number): Promise<UnknownRow[]> {
  const rows = await q.query(`select ${UNKNOWN_COLS} from catalog_unknown where project_id = $1 order by id limit ${limit}`, [project]);
  return rows.map(unknownRow);
}

export async function deleteUnknown(q: Queryable, ids: readonly number[]): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await q.query('delete from catalog_unknown where id = any($1::bigint[]) returning id', [ids]);
  return rows.length;
}

export interface UnknownAggregate {
  project: string;
  item: UnknownItem;
  count: number;
  env: string;
  /** Номер стенда примера у среды со стендами PR. */
  stand: string | null;
  exampleCid: string;
  exampleMs: number;
  firstSeen: number;
  lastSeen: number;
}

/** Записанная строка: inserted — первое появление в базе. */
export interface UnknownWritten {
  project: string;
  key: string;
  inserted: boolean;
}

/**
 * Сброс агрегата одним запросом: новые строки вставляются, у известных растёт счётчик и обновляется пример.
 * Скрытые строки обновляются и остаются скрытыми. Ссылки на удалённые системы и методы обнуляются.
 */
export async function upsertUnknown(q: Queryable, list: readonly UnknownAggregate[]): Promise<UnknownWritten[]> {
  if (list.length === 0) return [];
  const col = <T>(f: (a: UnknownAggregate) => T) => list.map(f);
  const rows = await q.query<{ project_id: string; key: string; inserted: boolean }>(
    `insert into catalog_unknown (project_id, key, kind, system_id, method_id, http_method, path, rpc, host, http_status, code, text,
                                  env, stand, example_cid, example_ms, count, first_seen, last_seen)
     select u.project_id, u.key, u.kind, s.id, m.id, u.http_method, u.path, u.rpc, u.host, u.http_status, u.code, u.text,
            u.env, u.stand, u.example_cid, u.example_ms, u.count, to_timestamp(u.first_ms / 1000.0), to_timestamp(u.last_ms / 1000.0)
       from unnest($1::text[], $2::text[], $3::text[], $4::bigint[], $5::bigint[], $6::text[], $7::text[], $8::text[], $9::text[],
                   $10::int[], $11::text[], $12::text[], $13::text[], $14::text[], $15::bigint[], $16::bigint[], $17::bigint[], $18::bigint[], $19::text[])
            as u(project_id, key, kind, system_id, method_id, http_method, path, rpc, host, http_status, code, text,
                 env, example_cid, example_ms, count, first_ms, last_ms, stand)
       join catalog_project p on p.project_id = u.project_id
       left join catalog_system s on s.id = u.system_id and s.project_id = u.project_id
       left join catalog_method m on m.id = u.method_id and m.project_id = u.project_id
     on conflict (project_id, key) do update set
       count = catalog_unknown.count + excluded.count,
       last_seen = greatest(catalog_unknown.last_seen, excluded.last_seen),
       system_id = excluded.system_id, method_id = excluded.method_id,
       http_method = excluded.http_method, path = excluded.path, rpc = excluded.rpc, host = excluded.host,
       http_status = excluded.http_status, code = excluded.code, text = excluded.text,
       env = excluded.env, stand = excluded.stand, example_cid = excluded.example_cid, example_ms = excluded.example_ms
     returning project_id, key, (xmax = 0) as inserted`,
    [
      col((a) => a.project),
      col((a) => a.item.key),
      col((a) => a.item.kind),
      col((a) => a.item.systemId),
      col((a) => a.item.methodId),
      col((a) => a.item.httpMethod),
      col((a) => a.item.path),
      col((a) => a.item.rpc),
      col((a) => a.item.host),
      col((a) => a.item.httpStatus),
      col((a) => a.item.code),
      col((a) => a.item.text),
      col((a) => a.env),
      col((a) => a.exampleCid),
      col((a) => Math.trunc(a.exampleMs)),
      col((a) => a.count),
      col((a) => Math.trunc(a.firstSeen)),
      col((a) => Math.trunc(a.lastSeen)),
      col((a) => a.stand ?? null),
    ],
  );
  // Первое появление определяет база: так и при двух копиях сервера «новой» строка окажется только у одной.
  return rows.map((r) => ({ project: r.project_id, key: r.key, inserted: r.inserted === true }));
}

/** Предел «Неизвестного» проекта: лишние строки с самым давним last_seen удаляются. */
export async function trimUnknown(q: Queryable, limit: number): Promise<number> {
  const rows = await q.query(
    `delete from catalog_unknown where id in (
       select id from (select id, row_number() over (partition by project_id order by last_seen desc, id desc) as rn from catalog_unknown) x
        where x.rn > $1)
     returning id`,
    [limit],
  );
  return rows.length;
}
