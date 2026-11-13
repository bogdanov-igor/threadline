// Команды видят те же проекты, что и сервер: только чтение, миграций здесь нет.
// Адрес задан, а база молчит или схемы ещё нет: команда работает с файлом и предупреждает.

import { DbError, isConnectionError, openDb, safeMessage, type Db } from '../catalog/db.ts';
import { validateStoredProject, environmentRecord, sameScope, environmentWithinScope } from '@threadline/core/config/project-input';
import type { EnvironmentConfig, ProjectConfig } from '@threadline/core/config';
import type { ResolvedConfig } from '../config/load.ts';
import * as store from './store.ts';
import { fileStateOf, fileVersion, recordCanon } from './sync.ts';

/** Код PostgreSQL: таблицы нет. */
const UNDEFINED_TABLE = '42P01';

export interface CommandProjects {
  /** Проекты базы, в том числе скрытые; при недоступной базе — из файла. */
  projects: Record<string, ProjectConfig>;
  warnings: string[];
}

/** Причина, по которой среда не читает хранилище. Файл доверенный: граница действует только на записи базы. */
export function commandEnvironmentProblem(config: ResolvedConfig, fileEnv: EnvironmentConfig | undefined, env: EnvironmentConfig): string | null {
  const backend = Object.hasOwn(config.backends, env.backend) ? config.backends[env.backend] : undefined;
  if (!backend) return `хранилища «${env.backend}» нет в файле настроек`;
  if (backend.type === 'mock' || (fileEnv && sameScope(env, fileEnv))) return null;
  return environmentWithinScope(env, backend.formScope) ? null : `условия среды вышли за границу хранилища «${env.backend}»: backends.${env.backend}.formScope`;
}

export async function commandProjects(config: ResolvedConfig, url: string | undefined, open: (url: string) => Promise<Db> = openDb): Promise<CommandProjects> {
  const file = config.config.projects;
  const target = url?.trim();
  if (!target) return { projects: file, warnings: [] };
  const warnings: string[] = [];
  let db: Db | null = null;
  try {
    db = await open(target);
    const rows = await store.readProjects(db);
    const logos = await store.readLogos(db);
    const deleted = await store.readDeleted(db);
    const formats = Object.keys(config.config.formats);
    const fileSide = { projects: file, logos: config.logos ?? new Map() };
    const projects: Record<string, ProjectConfig> = {};
    for (const row of rows) {
      const checked = validateStoredProject(row.id, row, formats);
      if (!checked.ok) {
        warnings.push(`проект «${row.id}» в базе не прошёл проверку: ${checked.issues.map((i) => i.path).join(', ')}`);
        projects[row.id] = { name: row.name, format: row.format, retentionDays: row.retentionDays, timezone: row.timezone, environments: environmentRecord(row.environments) };
        continue;
      }
      projects[row.id] = checked.project;
      if (fileStateOf(row, recordCanon(row, logos.get(row.id)), fileVersion(fileSide, row.id)) === 'file-newer') {
        warnings.push(`проект «${row.id}» правили на странице, а файл настроек изменился и не применён`);
      }
    }
    for (const id of deleted) if (Object.hasOwn(file, id) && !Object.hasOwn(projects, id)) warnings.push(`проект «${id}» удалён на странице и остался в файле настроек: уберите его из файла`);
    return rows.length > 0 ? { projects, warnings } : { projects: file, warnings: [...warnings, 'в базе ещё нет проектов: команда работает с файлом настроек'] };
  } catch (e) {
    if (e instanceof DbError && e.pgCode === UNDEFINED_TABLE) return { projects: file, warnings: ['в базе ещё нет таблиц проектов: команда работает с файлом настроек, миграции применит сервер при запуске'] };
    if (e instanceof DbError && !isConnectionError(e)) throw e;
    return { projects: file, warnings: [`база недоступна (${safeMessage(e, target)}): команда работает с проектами из файла настроек`] };
  } finally {
    await db?.close().catch(() => undefined);
  }
}
