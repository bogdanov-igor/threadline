// SQL проектов: чтение снимка, запись, логотипы, запрет на возврат из файла, версия.
// Только запросы; проверки — в core (@threadline/core/config/project-input), решения — в sync.ts и service.ts.

import type { CanonicalProjectInput, EnvironmentRecord } from '@threadline/core/config/project-input';
import { limitLockWait, type Queryable, type Row } from '../catalog/db.ts';
import { bumpVersion as bumpCatalogVersion, EDIT_LOCK_NS, lockProject } from '../catalog/store.ts';
import type { LogoFile, ProjectLogo } from '../config/logo.ts';

export type HiddenBy = 'page' | 'file';

export interface StoredProject extends CanonicalProjectInput {
  id: string;
  environments: EnvironmentRecord[];
  position: number;
  hiddenBy: HiddenBy | null;
  fromFile: boolean;
  edited: boolean;
  fileHash: string | null;
  updatedAt: string;
}

export interface ProjectFlags {
  hiddenBy: HiddenBy | null;
  fromFile: boolean;
  edited: boolean;
  fileHash: string | null;
}

/** updated_at с микросекундами в UTC: та же метка версии, что у записей справочника. */
const COLUMNS = `id, name, timezone, retention_days, format, environments, position, hidden_by, from_file, edited, file_hash,
  to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at`;

function projectRow(r: Row): StoredProject {
  return {
    id: String(r.id),
    name: String(r.name),
    timezone: String(r.timezone),
    retentionDays: Number(r.retention_days),
    format: String(r.format),
    environments: r.environments as EnvironmentRecord[],
    position: Number(r.position),
    hiddenBy: (r.hidden_by as HiddenBy | null) ?? null,
    fromFile: r.from_file === true,
    edited: r.edited === true,
    fileHash: r.file_hash === null || r.file_hash === undefined ? null : String(r.file_hash),
    updatedAt: String(r.updated_at),
  };
}

/** Блокировка правки и посева, одна на все проекты. Порядок всегда: сначала она, потом lockProject справочника. */
export async function lockProjects(q: Queryable): Promise<void> {
  await limitLockWait(q);
  await q.query('select pg_advisory_xact_lock($1, 0)', [EDIT_LOCK_NS + 1]);
}

export async function readProjects(q: Queryable): Promise<StoredProject[]> {
  return (await q.query(`select ${COLUMNS} from project order by position, id`)).map(projectRow);
}

export async function readProject(q: Queryable, id: string): Promise<StoredProject | null> {
  const [r] = await q.query(`select ${COLUMNS} from project where id = $1`, [id]);
  return r ? projectRow(r) : null;
}

export async function readVersion(q: Queryable): Promise<number> {
  const [r] = await q.query<{ version: unknown }>('select version from project_meta');
  return Number(r?.version ?? 0);
}

export async function bumpVersion(q: Queryable): Promise<void> {
  await q.query('update project_meta set version = version + 1');
}

export async function countProjects(q: Queryable): Promise<number> {
  const [r] = await q.query<{ n: unknown }>('select count(*) as n from project');
  return Number(r?.n ?? 0);
}

export async function nextPosition(q: Queryable): Promise<number> {
  const [r] = await q.query<{ p: unknown }>('select coalesce(max(position), -1) + 1 as p from project');
  return Number(r?.p ?? 0);
}

export type ProjectData = Omit<StoredProject, 'position' | 'hiddenBy' | 'fromFile' | 'edited' | 'fileHash' | 'updatedAt'>;

const envJson = (p: ProjectData) => JSON.stringify(p.environments);

export async function insertProject(q: Queryable, p: ProjectData, position: number, flags: ProjectFlags): Promise<void> {
  await q.query(
    `insert into project (id, name, timezone, retention_days, format, environments, position, hidden_by, from_file, edited, file_hash)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11)`,
    [p.id, p.name, p.timezone, p.retentionDays, p.format, envJson(p), position, flags.hiddenBy, flags.fromFile, flags.edited, flags.fileHash],
  );
}

/** Запись целиком. expected — метка версии формы: другая метка даёт false, запись не меняется. */
export async function updateProject(q: Queryable, p: ProjectData, flags: ProjectFlags, expected?: string): Promise<boolean> {
  const rows = await q.query(
    `update project set name = $2, timezone = $3, retention_days = $4, format = $5, environments = $6::jsonb,
            hidden_by = $7, from_file = $8, edited = $9, file_hash = $10, updated_at = clock_timestamp()
      where id = $1 ${expected !== undefined ? 'and updated_at = $11::timestamptz' : ''} returning id`,
    [p.id, p.name, p.timezone, p.retentionDays, p.format, envJson(p), flags.hiddenBy, flags.fromFile, flags.edited, flags.fileHash, ...(expected !== undefined ? [expected] : [])],
  );
  return rows.length > 0;
}

export async function setFlags(q: Queryable, id: string, flags: ProjectFlags, expected?: string): Promise<boolean> {
  const rows = await q.query(
    `update project set hidden_by = $2, from_file = $3, edited = $4, file_hash = $5, updated_at = clock_timestamp()
      where id = $1 ${expected !== undefined ? 'and updated_at = $6::timestamptz' : ''} returning id`,
    [id, flags.hiddenBy, flags.fromFile, flags.edited, flags.fileHash, ...(expected !== undefined ? [expected] : [])],
  );
  return rows.length > 0;
}

// ---------- Логотипы ----------

export async function readLogos(q: Queryable): Promise<Map<string, ProjectLogo>> {
  const rows = await q.query<{ project_id: string; theme: string; content: Uint8Array; content_type: LogoFile['type']; ratio: unknown; hash: string }>(
    'select project_id, theme, content, content_type, ratio, hash from project_logo',
  );
  const files = new Map<string, { light?: LogoFile; dark?: LogoFile }>();
  for (const r of rows) {
    const one = files.get(r.project_id) ?? {};
    // pg отдаёт Buffer, PGlite — Uint8Array.
    one[r.theme as 'light' | 'dark'] = { body: Buffer.from(r.content), type: r.content_type, ratio: Number(r.ratio), hash: r.hash };
    files.set(r.project_id, one);
  }
  const out = new Map<string, ProjectLogo>();
  for (const [id, { light, dark }] of files) {
    if (!light) continue;
    const other = dark ?? light;
    out.set(id, { light, dark: other, ratio: Math.max(light.ratio, other.ratio) });
  }
  return out;
}

/** Логотип заменяется целиком. Без тёмной версии строки нет, при чтении dark — тот же объект, что light. */
export async function replaceLogo(q: Queryable, id: string, logo: ProjectLogo | null): Promise<void> {
  await q.query('delete from project_logo where project_id = $1', [id]);
  if (!logo) return;
  const insert = (theme: string, f: LogoFile) =>
    q.query('insert into project_logo (project_id, theme, content, content_type, ratio, hash) values ($1, $2, $3, $4, $5, $6)', [id, theme, f.body, f.type, f.ratio, f.hash]);
  await insert('light', logo.light);
  if (logo.dark !== logo.light) await insert('dark', logo.dark);
}

// ---------- Запрет и удаление ----------

export async function readDeleted(q: Queryable): Promise<Set<string>> {
  return new Set((await q.query<{ project_id: string }>('select project_id from project_deleted')).map((r) => r.project_id));
}

export async function removeDeleted(q: Queryable, id: string): Promise<void> {
  await q.query('delete from project_deleted where project_id = $1', [id]);
}

/** Удаление навсегда: каскады убирают справочник вместе с настройкой маскирования и логотипы, короткие ссылки стираются здесь же. Вызывать под обеими блокировками. */
export async function deleteProject(q: Queryable, id: string, keepOutOfFile: boolean): Promise<void> {
  await q.query('delete from share_link where project_id = $1', [id]);
  await q.query('delete from catalog_project where project_id = $1', [id]);
  await q.query('delete from project where id = $1', [id]);
  if (keepOutOfFile) await q.query('insert into project_deleted (project_id) values ($1) on conflict do nothing', [id]);
}

export async function deletePreview(q: Queryable, id: string): Promise<{ systems: number; methods: number; errors: number; unknown: number }> {
  const [r] = await q.query<Record<'systems' | 'methods' | 'errors' | 'unknown', unknown>>(
    `select (select count(*) from catalog_system where project_id = $1) as systems,
            (select count(*) from catalog_method where project_id = $1) as methods,
            (select count(*) from catalog_error where project_id = $1) as errors,
            (select count(*) from catalog_unknown where project_id = $1) as unknown`,
    [id],
  );
  return { systems: Number(r?.systems ?? 0), methods: Number(r?.methods ?? 0), errors: Number(r?.errors ?? 0), unknown: Number(r?.unknown ?? 0) };
}

/** Смена названия проекта: система-автор получает его, если её не правили в редакторе. Вызывать под обеими блокировками. */
export async function renameAuthor(q: Queryable, id: string, name: string): Promise<void> {
  const rows = await q.query(
    `update catalog_system set name = $2, updated_at = clock_timestamp()
      where project_id = $1 and kind = 'project' and not edited and name <> $2 returning id`,
    [id, name],
  );
  if (rows.length > 0) await bumpCatalogVersion(q, id);
}

export { lockProject };
