// Команда справочника: pnpm threadline:catalog import|export|schema.
// Коды выхода: 0 — успех или проверка без ошибок, 1 — ошибки файла или аргументов, 2 — база недоступна или адрес не задан.

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { countEntries, type ImportItem, type ImportReport, type Issue } from '@threadline/core/catalog';
import { projectFileJsonSchema } from '@threadline/core/catalog/project-file';
import { ALL_KINDS_MASKING, maskKindsText, maskText } from '@threadline/core/search';
import { ConfigError, loadConfig } from '../config/load.ts';
import { DbError, describeUrl, isBusyError, openDb, safeMessage, type Db } from './db.ts';
import { ExportBlocked, exportCatalogText, importCatalog, parseCatalogText, type FileFormat } from './exchange.ts';
import { migrate, MigrationError } from './migrate.ts';
import { commandProjects } from '../projects/cli.ts';
import { readProject } from '../projects/store.ts';
import * as store from './store.ts';

export interface CliIo {
  env: NodeJS.ProcessEnv;
  /** Каталог, от которого считаются пути: INIT_CWD у pnpm. */
  cwd: string;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Для тестов: своё подключение. */
  open?: (url: string) => Promise<Db>;
}

const USAGE = [
  'pnpm threadline:catalog import <проект> <файл> [--dry-run] [--force]',
  'pnpm threadline:catalog export <проект> <файл> [--format yaml|json]',
  'pnpm threadline:catalog schema <файл>',
].join('\n');

const NO_KEEP: ReadonlySet<string> = new Set();
const KIND: Record<ImportItem['kind'], string> = { idType: 'тип id', system: 'система', method: 'метод', error: 'ошибка', outcome: 'правило итога', masking: 'маскирование', settings: 'настройки проекта', environment: 'среда', view: 'вид' };

export function formatReport(r: ImportReport): string[] {
  const lines: string[] = [];
  const head = r.dryRun ? 'Проверка без записи' : r.applied ? 'Импорт применён' : 'Импорт: изменений нет';
  lines.push(`${head} · проект ${r.project}`);
  if (r.errors.length > 0) {
    lines.push(`Ошибки файла (${r.errors.length}), ничего не применено:`);
    for (const e of r.errors) lines.push(`  ${e.path || '—'}: ${e.message}`);
  }
  if (r.warnings?.length) {
    lines.push(`Предупреждения (${r.warnings.length}), файл они не останавливают:`);
    for (const w of r.warnings) lines.push(`  ${w.path || '—'}: ${w.message}`);
  }
  if (r.errors.length > 0) return lines.map(masked);
  const section = (title: string, list: ImportItem[]) => {
    lines.push(`${title}: ${list.length}`);
    for (const i of list.slice(0, 200)) {
      lines.push(`  ${KIND[i.kind]} · ${i.title}${i.fields?.length ? ` (${i.fields.join(', ')})` : ''}`);
      if (i.disables) lines.push(`  Внимание: вид «${i.title}» выключается, значения откроются всем пользователям проекта во всех средах`);
      if (i.stopsSearches) lines.push('  Внимание: идущие поиски этого проекта остановятся');
    }
    if (list.length > 200) lines.push(`  … ещё ${list.length - 200}`);
  };
  section('Добавлено', r.added);
  section('Изменено', r.changed);
  section('Скрыто', r.hidden);
  section('Возвращено', r.restored ?? []);
  section('Удалённые записи файл не возвращает (--force вернёт)', r.undeleted ?? []);
  section('Ручные правки пропущены (--force заменит)', r.skipped);
  lines.push(`Без изменений: ${r.unchanged}`);
  lines.push(`Нет в файле (не удаляются): ${r.missing}`);
  if (r.missingEnvironments) lines.push(`  из них сред: ${r.missingEnvironments}, убирают среду на форме «Среды»`);
  return lines.map(masked);
}

// Строка отчёта цитирует ссылку на метод из файла: в пути бывает номер карты.
const masked = (line: string) => maskKindsText(maskText(line, NO_KEEP), ALL_KINDS_MASKING.strict, NO_KEEP);

export async function runCatalogCli(argv: readonly string[], io: CliIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: { 'dry-run': { type: 'boolean' }, force: { type: 'boolean' }, format: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
      allowPositionals: true,
    });
  } catch (e) {
    io.err(`${e instanceof Error ? e.message : String(e)}\n${USAGE}`);
    return 1;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    io.out(USAGE);
    return 0;
  }
  const [cmd, a, b] = positionals;
  if (cmd === 'schema' && a) {
    const path = resolve(io.cwd, a);
    await writeFile(path, `${JSON.stringify(projectFileJsonSchema(), null, 2)}\n`);
    io.out(`Схема файла справочника записана: ${path}`);
    return 0;
  }
  if ((cmd !== 'import' && cmd !== 'export') || !a || !b) {
    io.err(USAGE);
    return 1;
  }
  const format = values.format;
  if (format !== undefined && format !== 'yaml' && format !== 'json') {
    io.err('--format: yaml или json');
    return 1;
  }

  let config;
  try {
    config = await loadConfig({ env: io.env });
  } catch (e) {
    io.err(e instanceof ConfigError ? e.format() : `настройка не прочитана: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  // Проекты те же, что у сервера: со страницы и скрытые тоже. Предупреждения на код завершения не влияют.
  const known = await commandProjects(config, io.env.THREADLINE_DATABASE_URL, io.open ?? openDb);
  for (const w of known.warnings) io.err(`Предупреждение: ${w}`);
  const project = Object.hasOwn(known.projects, a) ? known.projects[a] : undefined;
  if (!project) {
    io.err(`проекта «${a}» нет в ${config.path}. Проекты: ${Object.keys(known.projects).join(', ')}`);
    return 1;
  }
  const path = resolve(io.cwd, b);

  let input: unknown = null;
  let textWarnings: Issue[] = [];
  let text = '';
  if (cmd === 'import') {
    try {
      text = await readFile(path, 'utf8');
    } catch {
      io.err(`файл не читается: ${path}`);
      return 1;
    }
    const p = parseCatalogText(text, format as FileFormat | undefined);
    if (!p.ok) {
      for (const e of p.errors) io.err(`${e.path || '—'}: ${e.message}`);
      return 1;
    }
    input = p.value;
    textWarnings = p.warnings;
  }

  const url = io.env.THREADLINE_DATABASE_URL?.trim();
  if (!url) {
    io.err('THREADLINE_DATABASE_URL не задан: справочник выключен. Адрес базы — в .env, пример — .env.example.');
    return 2;
  }
  let db: Db | null = null;
  try {
    db = await (io.open ?? openDb)(url);
    await migrate(db);
    await db.tx(async (q) => {
      await store.lockProject(q, a);
      await store.ensureProject(q, a, project.name);
    });
    if (cmd === 'export') {
      const fmt: FileFormat = format === 'json' || (format === undefined && path.endsWith('.json')) ? 'json' : 'yaml';
      await writeFile(path, await exportCatalogText(db, a, fmt));
      if (!(await readProject(db, a))) io.err('Предупреждение: записи проекта в базе ещё нет, файл выгружен без раздела settings');
      const n = countEntries(await store.loadSnapshot(db, a));
      io.out(`Справочник ${a} выгружен: ${path}`);
      io.out(`Записей: типов id ${n.idType}, систем ${n.system}, методов ${n.method}, ошибок ${n.error}, правил итога ${n.outcome}`);
      return 0;
    }
    // Контекст раздела settings из файла настроек, прав и сверки у команды нет: требование «Команда вне ролей».
    const report = await importCatalog(db, a, project.name, input, {
      dryRun: values['dry-run'] === true,
      force: values.force === true,
      warnings: textWarnings,
      settings: { backends: config.backends, formats: Object.keys(config.config.formats), file: { projects: config.config.projects, logos: config.logos ?? new Map() } },
    });
    for (const line of formatReport(report)) io.out(line);
    if (report.applied) io.out('Работающий сервер увидит изменения при следующем опросе версии (до 30 с).');
    return report.errors.length > 0 ? 1 : 0;
  } catch (e) {
    if (e instanceof MigrationError) {
      io.err(`справочник: ${e.message}`);
      return 2;
    }
    if (isBusyError(e)) {
      io.err('справочник занят: идёт правка или импорт в другой копии, повторите команду через несколько секунд');
      return 2;
    }
    if (e instanceof ExportBlocked) {
      io.err('Выгрузка отклонена: маскирование скрыло бы часть этих записей. Уберите значения в редакторе.');
      for (const i of e.issues) io.err(`  ${masked(i.path) || '—'}: ${i.message}`);
      return 1;
    }
    io.err(`база справочника недоступна (${describeUrl(url)}): ${e instanceof DbError ? e.message : safeMessage(e, url)}`);
    return 2;
  } finally {
    await db?.close().catch(() => undefined);
  }
}
