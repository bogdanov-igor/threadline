// Файл справочника: разбор YAML и JSON, импорт в одной транзакции под блокировкой проекта, выгрузка из базы.
// Проверки и разница — в core (readCatalogFile, diffCatalog).

import { isMap, isScalar, isSeq, parseDocument, stringify as stringifyYaml } from 'yaml';
import {
  diffCatalog,
  exportCatalog,
  knownOf,
  MAX_FILE_BYTES,
  maskIssues,
  readCatalogFile,
  SCHEMA_COMMENT,
  withoutExampleValues,
  YAML_PARSE_OPTIONS,
  YAML_STRINGIFY_OPTIONS,
  type ImportReport,
  type Issue,
  type PlanItem,
} from '@threadline/core/catalog';
import { compileMasking, maskText } from '@threadline/core/search';
import { readFileVersion, readSettings, settingsOut, writeSettings, type ProjectFileContext, type SettingsRead } from '../projects/file.ts';
import * as projectStore from '../projects/store.ts';
import * as viewStore from '../projects/view.ts';
import { DbError, isBusyError, isConnectionError, type Db, type Queryable } from './db.ts';
import * as store from './store.ts';

export type FileFormat = 'yaml' | 'json';

export type ParsedText = { ok: true; value: unknown; warnings: Issue[] } | { ok: false; tooLarge: boolean; errors: Issue[] };

const NO_KEEP: ReadonlySet<string> = new Set();

/** Поля, написанные в записи дважды: останется последнее значение. Имя поля уходит в путь, а путь в ответ и журнал: номер карты под маской. */
function duplicateFields(node: unknown, at = '', out: Issue[] = []): Issue[] {
  if (isMap(node)) {
    const seen = new Set<string>();
    for (const { key, value } of node.items) {
      if (!isScalar(key)) continue;
      const name = String(key.value);
      const path = at ? `${at}.${name}` : name;
      if (seen.has(name)) out.push({ path: maskText(path, NO_KEEP), message: 'поле повторяется: действует последнее значение. Оставьте одно', key: 'catalog.duplicateField' });
      seen.add(name);
      duplicateFields(value, path, out);
    }
  } else if (isSeq(node)) node.items.forEach((x, i) => duplicateFields(x, at ? `${at}.${i}` : String(i), out));
  return out;
}

/** JSON.parse повтор не видит, а YAML читает JSON и ключей не теряет. Синтаксис уже проверен, поэтому жалобы разбора не важны. Слишком глубокий текст: без этой проверки. */
function jsonDuplicates(text: string): Issue[] {
  try {
    return duplicateFields(parseDocument(text, { uniqueKeys: false, logLevel: 'silent' }).contents);
  } catch {
    return [];
  }
}

/** Текст файла → объект. Больше 2 МБ — отказ до разбора. Формат по первому символу, если не задан. */
export function parseCatalogText(text: string, format?: FileFormat): ParsedText {
  if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) {
    return { ok: false, tooLarge: true, errors: [{ path: '', message: `файл больше ${MAX_FILE_BYTES / 1024 / 1024} МБ` }] };
  }
  const fmt = format ?? (/^\s*[{[]/.test(text) ? 'json' : 'yaml');
  try {
    if (fmt === 'json') return { ok: true, value: JSON.parse(text) as unknown, warnings: jsonDuplicates(text) };
    // Настоящий повтор здесь ошибка синтаксиса. Остаётся то, что станет одним ключом только в объекте: 1 и '1'.
    // Журнал разбору не нужен: предупреждения цитировали бы строку файла.
    const doc = parseDocument(text, YAML_PARSE_OPTIONS);
    if (doc.errors.length > 0) throw doc.errors[0];
    return { ok: true, value: doc.toJS(YAML_PARSE_OPTIONS) as unknown, warnings: duplicateFields(doc.contents) };
  } catch (e) {
    // Текст разборщика цитирует файл, значение могло бы попасть в ответ и журнал: только позиция.
    const at = parsePosition(e);
    return { ok: false, tooLarge: false, errors: [{ path: '', message: `файл не разбирается как ${fmt === 'json' ? 'JSON' : 'YAML'}${at ? `: ${at}` : ''}` }] };
  }
}

/** Позиция ошибки разбора без цитаты: YAML отдаёт её полем, JSON — числами в тексте. */
function parsePosition(e: unknown): string | null {
  const pos = (e as { linePos?: { line: number; col: number }[] } | null)?.linePos?.[0];
  if (pos) return `строка ${pos.line}, столбец ${pos.col}`;
  const text = e instanceof Error ? e.message : '';
  const lineCol = /\(line (\d+) column (\d+)\)/.exec(text);
  if (lineCol) return `строка ${lineCol[1]}, столбец ${lineCol[2]}`;
  const offset = /position (\d+)/.exec(text);
  return offset ? `позиция ${offset[1]}` : null;
}

export function emptyReport(project: string, dryRun: boolean, errors: Issue[] = []): ImportReport {
  return { project, dryRun, applied: false, added: [], changed: [], hidden: [], skipped: [], restored: [], undeleted: [], unchanged: 0, missing: 0, errors, warnings: [] };
}

export interface ImportOptions {
  dryRun: boolean;
  force: boolean;
  /**
   * Хэш начального набора: пишется в той же транзакции, если файл прошёл проверку. Он же признак набора: раздел masking пропускается.
   * Без него импорт — команда или страница: вместо хэша пишется отметка оператора (store.OPERATOR_SEED).
   */
  seedHash?: string;
  /** false — раздел masking менять нельзя: файл с такой правкой отклоняется целиком. Команда прав не проверяет, посев раздел пропускает. */
  allowMasking?: boolean;
  /** false — раздел settings менять нельзя: так же, как allowMasking. */
  allowSettings?: boolean;
  /** Версия файла, с которой открыт текст: сверка под блокировками. Только у маршрута, у команды открытого текста нет. */
  baseVersion?: string;
  /** Контекст раздела settings. Без него раздел пропускается с предупреждением: посев не пишет настройки, а выгрузка годится как начальный набор. */
  settings?: ProjectFileContext;
  /** Предупреждения разбора текста: идут в отчёт вместе с остальными. */
  warnings?: readonly Issue[];
}

/** Текст устарел: проект изменился после выгрузки. Ничего не записано. */
export class FileVersionConflict extends Error {
  readonly version: string;
  constructor(version: string) {
    super('версия файла проекта изменилась');
    this.name = 'FileVersionConflict';
    this.version = version;
  }
}

/** В отчёте ошибки: транзакция откатывается вместе с ensureProject, иначе версия выросла бы без применения. */
class ReportRollback extends Error {
  readonly report: ImportReport;
  constructor(report: ImportReport) {
    super('файл не применён');
    this.name = 'ReportRollback';
    this.report = report;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const hasSettings = (input: unknown): input is { settings: unknown } => isObject(input) && Object.hasOwn(input, 'settings');

/** Файл не применён из-за данных: запись не нашлась или столкнулась с другой. Соединение тут ни при чём. */
export class ImportDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportDataError';
  }
}

/** Применение плана разницы: типы → системы → методы → ошибки → правила, внутри — по порядку файла. */
async function applyPlan(q: Queryable, project: string, plan: readonly PlanItem[], sysIds: Map<string, number>, methodIds: Map<string, number>): Promise<void> {
  const sys = (key: string | null) => {
    if (key === null) return null;
    const id = sysIds.get(key);
    if (id === undefined) throw new ImportDataError(`нет системы ${key}`);
    return id;
  };
  const meth = (key: string | null) => {
    if (key === null) return null;
    const id = methodIds.get(key);
    if (id === undefined) throw new ImportDataError(`нет метода ${key}`);
    return id;
  };
  for (const p of plan) {
    // Запись, удалённую навсегда, файл вернул только явной заменой: отметка больше не нужна.
    if (p.action === 'add' && p.kind !== 'masking') await store.clearDeleted(q, project, p.kind, p.key);
    // Применённая запись — запись файла: seed_key = ключ, edited снят (force снимает и ручную отметку).
    const m = { seedKey: p.key, edited: false, hidden: p.action === 'hide' ? true : p.hidden };
    switch (p.kind) {
      case 'idType':
        if (p.rowId === null) await store.insertIdType(q, project, p.data, m);
        else await store.updateIdType(q, project, p.rowId, p.data, m);
        break;
      case 'system':
        if (p.rowId === null) sysIds.set(p.key, await store.insertSystem(q, project, p.data, m));
        else await store.updateSystem(q, project, p.rowId, p.data, m);
        break;
      case 'method':
        if (p.rowId === null) methodIds.set(p.key, await store.insertMethod(q, project, sys(p.systemKey)!, p.data, m));
        else await store.updateMethod(q, project, p.rowId, sys(p.systemKey)!, p.data, m);
        break;
      case 'error':
        if (p.rowId === null) await store.insertError(q, project, sys(p.systemKey), meth(p.methodKey), p.data, m);
        else await store.updateError(q, project, p.rowId, sys(p.systemKey), meth(p.methodKey), p.data, m);
        break;
      case 'outcome':
        if (p.rowId === null) await store.insertOutcome(q, project, sys(p.systemKey), meth(p.methodKey), p.data, m);
        else await store.updateOutcome(q, project, p.rowId, sys(p.systemKey), meth(p.methodKey), p.data, m);
        break;
      case 'masking':
        // Применённая строка файла снимает отметку ручной правки.
        await store.writeMasking(q, project, p.data.type, p.data.enabled, p.data.keys, false);
        break;
    }
  }
}

/** Раздел settings: сравнение с базой и проверка. Файл другого проекта уже отклонён, раздел тогда не читается. */
async function readSection(q: Queryable, project: string, input: unknown, opts: ImportOptions): Promise<{ read: SettingsRead | null; issues: Issue[]; warnings: Issue[] }> {
  if (!hasSettings(input) || (input as { project?: unknown }).project !== project) return { read: null, issues: [], warnings: [] };
  if (!opts.settings) return { read: null, issues: [], warnings: [{ path: 'settings', message: 'начальный набор не меняет настройки: раздел settings пропущен, остальное применено. Настройки меняют на странице «Файл проекта»', key: 'catalog.settingsInSeed' }] };
  const read = await readSettings(q, project, input.settings, opts.settings);
  // Без права важен сам факт правки, а не её ошибки.
  if (read.changed && opts.allowSettings === false) return { read, issues: [{ path: 'settings', message: 'раздел настроек меняют только аналитик и администратор: файл не применён', key: 'catalog.settingsNoRight' }], warnings: [] };
  return { read, issues: read.issues, warnings: [] };
}

/**
 * Начальный набор не меняет маскирование: файл не должен выключить маску в другой среде, новая база остаётся на встроенных масках.
 * Раздел убирается до проверки: он не применяется, поэтому не держит набор и не влияет на проверку остальных значений.
 */
function seedInput(input: unknown, opts: ImportOptions): { input: unknown; warnings: Issue[] } {
  if (opts.seedHash === undefined || !isObject(input) || !Object.hasOwn(input, 'masking')) return { input, warnings: [] };
  const { masking: _skipped, ...rest } = input;
  return { input: rest, warnings: [{ path: 'masking', message: 'начальный набор не меняет маскирование: раздел masking пропущен, остальное применено. Маскирование меняет администратор на странице «Файл проекта»', key: 'catalog.maskingInSeed' }] };
}

/** Разница и, без dryRun, применение. Вызывается внутри транзакции под блокировкой проекта. Порядок шагов: версия, снимок, проверка файла и раздела settings, разница; затем настройки, записи, версии и отметка посева. */
async function importIn(q: Queryable, project: string, raw: unknown, opts: ImportOptions): Promise<ImportReport> {
  const { input, warnings: seedWarnings } = seedInput(raw, opts);
  // Версия раньше данных: текст не старше своей версии, худший случай лишний 409, а не тихий откат.
  const version = await readFileVersion(q, project);
  const snapshot = await store.loadSnapshot(q, project);
  const read = readCatalogFile(input, project, knownOf(snapshot));
  const section = await readSection(q, project, input, opts);
  const warnings = [...(opts.warnings ?? []), ...read.warnings, ...section.warnings, ...seedWarnings];
  const failed = (errors: Issue[]): ImportReport => ({ ...emptyReport(project, opts.dryRun, errors), warnings, version });
  if (!read.ok) return failed([...read.errors, ...section.issues]);
  const diff = diffCatalog(snapshot, read.entries, { force: opts.force, deleted: await store.deletedKeys(q, project) });
  // Совпадающий раздел в план не попадает: файл после выгрузки загружается обратно. Все запрещённые разделы названы сразу.
  const errors = [...section.issues];
  if (opts.allowMasking === false && diff.plan.some((p) => p.kind === 'masking')) errors.push({ path: 'masking', message: 'раздел маскирования меняет только администратор: файл не применён', key: 'catalog.maskingAdminOnly' });
  if (errors.length > 0) return failed(errors);
  const s = section.read;
  const report: ImportReport = {
    project,
    dryRun: opts.dryRun,
    applied: false,
    added: [...(s?.added ?? []), ...diff.added],
    changed: [...(s?.changedItems ?? []), ...diff.changed],
    hidden: diff.hidden,
    skipped: diff.skipped,
    restored: diff.restored,
    undeleted: diff.undeleted,
    unchanged: diff.unchanged,
    missing: diff.missing + (s?.missing ?? 0),
    ...(s && s.missing > 0 ? { missingEnvironments: s.missing } : {}),
    errors: [],
    warnings,
    version,
  };
  if (opts.dryRun) return report;
  if (s?.plan && opts.settings) await writeSettings(q, s.plan, opts.settings);
  const keys = store.snapshotKeys(snapshot);
  await applyPlan(q, project, diff.plan, keys.systems, keys.methods);
  if (diff.plan.length > 0) await store.bumpVersion(q, project);
  if (s?.plan) await projectStore.bumpVersion(q);
  // Импорт командой или со страницы: проект переходит к оператору, начальный набор при старте его больше не импортирует.
  await store.setSeedHash(q, project, opts.seedHash ?? store.OPERATOR_SEED);
  report.applied = diff.plan.length > 0 || s?.plan != null;
  if (report.applied) report.version = await readFileVersion(q, project);
  return report;
}

/**
 * Импорт файла: одна транзакция под блокировками, разница считается заново под ними. dryRun только читает, блокировок не берёт.
 * Ошибка в любой записи откатывает всё. Посев и команда без раздела settings берут только блокировку справочника, как раньше.
 */
export async function importCatalog(db: Db, project: string, authorName: string, input: unknown, opts: ImportOptions): Promise<ImportReport> {
  if (opts.dryRun) return importIn(db, project, input, opts);
  const withVersion = async (report: ImportReport): Promise<ImportReport> => ({ ...report, version: await readFileVersion(db, project) });
  try {
    return await db.tx(async (q) => {
      if (opts.baseVersion !== undefined || (hasSettings(input) && opts.settings)) await projectStore.lockProjects(q);
      await store.lockProject(q, project);
      // До ensureProject и всего, что поднимает версию: иначе первое применение в пустой справочник получило бы ложный 409.
      if (opts.baseVersion !== undefined) {
        const current = await readFileVersion(q, project);
        if (current !== opts.baseVersion) throw new FileVersionConflict(current);
      }
      await store.ensureProject(q, project, authorName);
      const report = await importIn(q, project, input, opts);
      if (report.errors.length > 0) throw new ReportRollback(report);
      return report;
    });
  } catch (e) {
    if (e instanceof ReportRollback) return withVersion(e.report);
    // Ошибка данных откатила транзакцию: отчёт с причиной, а не «база недоступна». Обрыв и занятая блокировка идут дальше.
    if (e instanceof ImportDataError) return withVersion(emptyReport(project, false, [{ path: '', message: `файл не применён: ${e.message}` }]));
    if (e instanceof DbError && !isConnectionError(e) && !isBusyError(e)) return withVersion(emptyReport(project, false, [{ path: '', message: `файл не применён: записи файла конфликтуют со справочником (${e.pgCode})` }]));
    throw e;
  }
}

/** В строках справочника нашлось то, что скрыло бы маскирование: файл не отдаётся. */
export class ExportBlocked extends Error {
  readonly issues: Issue[];
  constructor(issues: Issue[]) {
    super('выгрузка отклонена');
    this.name = 'ExportBlocked';
    this.issues = issues;
  }
}

/**
 * Выгрузка из базы, а не из памяти: в состоянии stale в памяти могли остаться старые данные.
 * Выгрузка не маскируется, чтобы файл загружался обратно, поэтому ни одна её строка не должна меняться под маской.
 */
export async function exportCatalogText(q: Queryable, project: string, format: FileFormat): Promise<string> {
  const snapshot = await store.loadSnapshot(q, project);
  const row = await projectStore.readProject(q, project);
  // Записи проекта нет, например команда до первого запуска сервера: файл без раздела.
  const settings = row ? settingsOut(row, await viewStore.readView(q, project)) : undefined;
  const file = exportCatalog(snapshot, settings);
  // В разделе masking имена полей, а не значения. В настройке вида постоянные значения. Встроенные маски и настройка проекта.
  const { masking: _names, ...rest } = file;
  const { view: _view, ...settingsText } = settings ?? {};
  // Значения примеров поиска — ввод строки поиска, как при загрузке файла (withoutExampleValues).
  const issues = maskIssues({ ...rest, ...(settings ? { settings: withoutExampleValues(settingsText) } : {}) }, '', compileMasking(snapshot.masking ?? []).strict);
  if (issues.length > 0) throw new ExportBlocked(issues);
  if (format === 'json') return `${JSON.stringify(file, null, 2)}\n`;
  return `${SCHEMA_COMMENT}\n${stringifyYaml(file, YAML_STRINGIFY_OPTIONS)}`;
}

/** Отчёт импорта строкой для журнала и команды. */
export function reportLine(r: ImportReport): string {
  if (r.errors.length > 0) return `ошибок в файле: ${r.errors.length}, ничего не применено`;
  return `добавлено ${r.added.length}, изменено ${r.changed.length}, скрыто ${r.hidden.length}, возвращено ${r.restored?.length ?? 0}, удалённые не возвращены ${r.undeleted?.length ?? 0}, ручные правки пропущены ${r.skipped.length}, без изменений ${r.unchanged}, нет в файле ${r.missing}`;
}
