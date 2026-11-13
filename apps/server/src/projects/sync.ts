// Посев и сверка с файлом настроек: одной транзакцией, под блокировкой правки.
// Файл только читается. Журнал называет проект и поля верхнего уровня, значений в нём нет.

import { createHash } from 'node:crypto';
import type { ProjectConfig } from '@threadline/core/config';
import { canonicalProject, changedFields, environmentList, validateStoredProject, type CanonicalProjectInput } from '@threadline/core/config/project-input';
import type { ProjectFileState } from '@threadline/core';
import { ensureProject } from '../catalog/store.ts';
import type { Queryable } from '../catalog/db.ts';
import type { ProjectLogo } from '../config/logo.ts';
import * as store from './store.ts';

export interface FileProjects {
  projects: Readonly<Record<string, ProjectConfig>>;
  logos: ReadonlyMap<string, ProjectLogo>;
}

export interface SyncLog {
  info(message: string): void;
  warn(message: string): void;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function logoHashes(logo: ProjectLogo | undefined | null): { light: string; dark: string | null } | null {
  if (!logo) return null;
  return { light: logo.light.hash, dark: logo.dark === logo.light ? null : logo.dark.hash };
}

/** Проект из файла как запись: логотип хранится отдельно. */
export function fileData(id: string, p: ProjectConfig): store.ProjectData {
  return { id, name: p.name, timezone: p.timezone, retentionDays: p.retentionDays, format: p.format, environments: environmentList(p.environments) };
}

export interface FileVersion {
  canon: string;
  hash: string;
}

export function fileVersion(file: FileProjects, id: string): FileVersion | undefined {
  if (!Object.hasOwn(file.projects, id)) return undefined;
  const canon = canonicalProject(fileData(id, file.projects[id]!), logoHashes(file.logos.get(id)));
  return { canon, hash: sha256(canon) };
}

export const recordCanon = (row: CanonicalProjectInput, logo: ProjectLogo | undefined | null): string => canonicalProject(row, logoHashes(logo));

/** Отметка на странице. */
export function fileStateOf(row: store.StoredProject, canon: string, file: FileVersion | undefined): ProjectFileState {
  if (!file) return row.hiddenBy === 'file' ? 'removed' : 'none';
  if (canon === file.canon) return 'same';
  if (!row.edited) return 'same';
  return row.fileHash === file.hash ? 'here' : 'file-newer';
}

async function writeAuthor(q: Queryable, id: string, name: string, rename: boolean): Promise<void> {
  await store.lockProject(q, id);
  await ensureProject(q, id, name);
  if (rename) await store.renameAuthor(q, id, name);
}

/** Сверка. Возвращает, изменилось ли что-то: версия растёт только тогда, перезапуск с тем же файлом метки не трогает. */
export async function syncProjects(q: Queryable, file: FileProjects, formats: readonly string[], log: SyncLog): Promise<boolean> {
  await store.lockProjects(q);
  const rows = await store.readProjects(q);
  const logos = await store.readLogos(q);
  const deleted = await store.readDeleted(q);
  const byId = new Map(rows.map((r) => [r.id, r]));
  let position = rows.reduce((m, r) => Math.max(m, r.position + 1), 0);
  let changed = false;

  for (const [id, p] of Object.entries(file.projects)) {
    const version = fileVersion(file, id)!;
    const logo = file.logos.get(id) ?? null;
    const row = byId.get(id);
    if (!row) {
      if (deleted.has(id)) {
        log.warn(`проект «${id}» удалён на странице и остался в файле настроек: уберите его из файла`);
        continue;
      }
      await store.insertProject(q, fileData(id, p), position++, { hiddenBy: null, fromFile: true, edited: false, fileHash: version.hash });
      await store.replaceLogo(q, id, logo);
      await writeAuthor(q, id, p.name, false);
      changed = true;
      continue;
    }
    const canon = recordCanon(row, logos.get(id));
    const hiddenBy = row.hiddenBy === 'file' ? null : row.hiddenBy;
    if (canon === version.canon) {
      if (row.edited || !row.fromFile || row.fileHash !== version.hash || row.hiddenBy !== hiddenBy) {
        await store.setFlags(q, id, { hiddenBy, fromFile: true, edited: false, fileHash: version.hash });
        changed = true;
      }
      continue;
    }
    if (!row.edited) {
      await store.updateProject(q, fileData(id, p), { hiddenBy, fromFile: true, edited: false, fileHash: version.hash });
      await store.replaceLogo(q, id, logo);
      await writeAuthor(q, id, p.name, true);
      changed = true;
      continue;
    }
    if (row.fileHash !== version.hash) {
      log.warn(`проект «${id}» правили на странице, а файл настроек изменился и не применён: ${changedFields(canon, version.canon).join(', ')}`);
    }
    // Возврат в файл снимает только скрытие из-за файла, правка на странице остаётся.
    if (row.hiddenBy === 'file') {
      await store.setFlags(q, id, { hiddenBy: null, fromFile: row.fromFile, edited: true, fileHash: row.fileHash });
      changed = true;
    }
  }

  const current = await store.readProjects(q);
  const valid = (r: store.StoredProject) => validateStoredProject(r.id, r, formats).ok;
  let visible = current.filter((r) => r.hiddenBy === null && valid(r)).length;
  for (const r of current) {
    if (Object.hasOwn(file.projects, r.id) || !r.fromFile || r.edited || r.hiddenBy !== null) continue;
    if (valid(r) && visible <= 1) {
      log.warn(`проект «${r.id}» убран из файла настроек, но остаётся видимым: других видимых проектов нет`);
      continue;
    }
    await store.setFlags(q, r.id, { hiddenBy: 'file', fromFile: r.fromFile, edited: false, fileHash: r.fileHash });
    if (valid(r)) visible--;
    changed = true;
  }

  if (changed) await store.bumpVersion(q);
  return changed;
}
