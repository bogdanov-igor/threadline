// Раздел settings файла проекта и версия файла.
// Файл не может больше форм: те же проверки validateProjectInput и та же запись, что у service.update и saveView.

import type { ImportItem } from '@threadline/core/catalog';
import { parseSettingsSection, type SettingsSection } from '@threadline/core/catalog/project-file';
import type { ConfigIssue } from '@threadline/core/config';
import { BUILTIN_FORMAT } from '@threadline/core/profile';
import { canonicalProject, scopeChanged, validateProjectInput, type EnvironmentRecord, type ProjectDraft, type ProjectInputContext } from '@threadline/core/config/project-input';
import { normalizeView, type ViewSettings } from '@threadline/core/view';
import type { Queryable } from '../catalog/db.ts';
import { lockProject } from '../catalog/store.ts';
import type { ProjectLogo } from '../config/logo.ts';
import * as store from './store.ts';
import { fileVersion, logoHashes, recordCanon, type FileProjects, type FileVersion } from './sync.ts';
import * as viewStore from './view.ts';

/** Что нужно проверке раздела: хранилища и профили файла настроек и его версия проекта. У сервера из снимка, у команды из loadConfig. */
export interface ProjectFileContext {
  backends: ProjectInputContext['backends'];
  formats: readonly string[];
  file: FileProjects;
}

/** Тот же контекст, что у формы проекта. */
export const inputContext = (ctx: ProjectFileContext, id: string | undefined, saved: readonly EnvironmentRecord[]): ProjectInputContext => ({
  backends: ctx.backends,
  formats: ctx.formats,
  fileEnvironments: id !== undefined && Object.hasOwn(ctx.file.projects, id) ? ctx.file.projects[id]!.environments : undefined,
  savedEnvironmentIds: new Set(saved.map((e) => e.id)),
});

// ---------- Версия файла ----------

const STAMP = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;
const STAMP_RE = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{6}Z';
/** Вид версии файла: параметр baseVersion отклоняется до разбора файла. */
export const FILE_VERSION = new RegExp(`^\\d{1,19}\\|(?:-|${STAMP_RE})\\|(?:-|${STAMP_RE})$`);

/**
 * Версия файла проекта: версия справочника, метка проекта, метка вида. Одним запросом из базы, снимок в памяти не участвует.
 * Маскирование поднимает версию справочника, правка другого проекта не меняет ни одной части.
 */
export async function readFileVersion(q: Queryable, id: string): Promise<string> {
  const [r] = await q.query<{ c: unknown; u: unknown; v: unknown }>(
    `select (select version::text from catalog_project where project_id = $1) as c,
            (select to_char(updated_at at time zone 'UTC', ${STAMP}) from project where id = $1) as u,
            (select to_char(view_updated_at at time zone 'UTC', ${STAMP}) from project where id = $1) as v`,
    [id],
  );
  return `${String(r?.c ?? 0)}|${String(r?.u ?? '-')}|${String(r?.v ?? '-')}`;
}

// ---------- Выгрузка ----------

/** Раздел для выгрузки: без логотипа, id и меток. kind single и пустые условия не пишутся. */
export function settingsOut(row: store.StoredProject, stored: viewStore.StoredView | null): Record<string, unknown> {
  return {
    name: row.name,
    timezone: row.timezone,
    retentionDays: row.retentionDays,
    format: row.format,
    environments: row.environments.map((e) => ({
      id: e.id,
      name: e.name,
      ...(e.kind && e.kind !== 'single' ? { kind: e.kind } : {}),
      backend: e.backend,
      ...(e.selector && e.selector.length > 0 ? { selector: e.selector.map((m) => ({ label: m.label, op: m.op, value: m.value, ...(m.searchOnly === true ? { searchOnly: true } : {}) })) } : {}),
      ...(e.stand ? { stand: { label: e.stand.label, template: e.stand.template } } : {}),
      ...(e.examples && e.examples.length > 0 ? { examples: e.examples.map((x) => ({ label: typeof x.label === 'string' ? x.label : { ...x.label }, values: [...x.values], ...(x.period ? { period: x.period } : {}) })) } : {}),
    })),
    view: normalizeView(stored?.raw ?? null).view,
  };
}

// ---------- Проверка ----------

export interface SettingsPlan {
  row: store.StoredProject;
  /** Новая запись проекта; null — меняется только вид. */
  data: store.ProjectData | null;
  /** Новая настройка вида; null — вид не меняется. */
  view: ViewSettings | null;
  viewExpected: string | null;
}

export interface SettingsRead {
  /** Раздел отличается от базы: без права это отказ, а совпавший раздел правкой не считается. */
  changed: boolean;
  issues: ConfigIssue[];
  plan: SettingsPlan | null;
  added: ImportItem[];
  changedItems: ImportItem[];
  /** Сколько сред проекта нет в файле. */
  missing: number;
}

const NOTHING: Omit<SettingsRead, 'changed' | 'issues'> = { plan: null, added: [], changedItems: [], missing: 0 };

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Порядок среды в проверке и в записи: откуда она и где стоит в файле. */
interface Merged {
  list: (SettingsSection['environments'][number] | EnvironmentRecord)[];
  /** Индекс среды в файле; null — среды в файле нет. */
  origin: (number | null)[];
}

/**
 * Полный список сред: среды файла по его порядку, затем остальные. Стереть блок среды это не перестановка:
 * если названные среды идут как в базе и новые только в конце, порядок базы остаётся.
 */
function mergeEnvironments(stored: readonly EnvironmentRecord[], named: SettingsSection['environments']): Merged {
  const namedIds = new Set(named.map((e) => e.id));
  const rest = stored.filter((e) => !namedIds.has(e.id));
  const storedIds = new Set(stored.map((e) => e.id));
  const fileOrder = named.map((e, i) => ({ e, i }));
  const inFile = fileOrder.filter(({ e }) => storedIds.has(e.id));
  const kept = stored.filter((e) => namedIds.has(e.id)).map((e) => e.id);
  const fresh = fileOrder.filter(({ e }) => !storedIds.has(e.id));
  const relativeSame = same(inFile.map(({ e }) => e.id), kept);
  const newAtEnd = fileOrder.slice(fileOrder.length - fresh.length).every(({ e }) => !storedIds.has(e.id));
  if (rest.length > 0 && relativeSame && newAtEnd) {
    const byId = new Map(fileOrder.map(({ e, i }) => [e.id, { e, i }]));
    const list: Merged['list'] = [];
    const origin: Merged['origin'] = [];
    for (const s of stored) {
      const hit = byId.get(s.id);
      list.push(hit ? hit.e : s);
      origin.push(hit ? hit.i : null);
    }
    for (const { e, i } of fresh) {
      list.push(e);
      origin.push(i);
    }
    return { list, origin };
  }
  return { list: [...named, ...rest], origin: [...named.map((_, i) => i), ...rest.map(() => null)] };
}

/** Путь проверки формы в путь файла: индекс в полном списке заменяется индексом в файле. */
function toFilePath(path: string, origin: readonly (number | null)[]): string {
  const m = /^environments\.(\d+)(.*)$/.exec(path);
  if (!m) return `settings.${path}`;
  const at = origin[Number(m[1])];
  return at === null || at === undefined ? 'settings.environments' : `settings.environments.${at}${m[2]}`;
}

const VIEW_FIELDS: readonly (keyof ViewSettings)[] = ['defaultMode', 'columns', 'defaultTab', 'tabs', 'blocks', 'bodyView'];
const ENV_FIELDS = ['name', 'kind', 'backend', 'selector', 'stand', 'examples'] as const;

const canonicalEnv = (e: Pick<EnvironmentRecord, 'name' | 'backend' | 'kind' | 'selector' | 'stand' | 'examples'>) => JSON.parse(canonicalProject({ name: '', timezone: '', retentionDays: 0, format: '', environments: [{ ...e, id: '' }] as EnvironmentRecord[] }, null)).environments[0] as Record<string, unknown>;

function reportItems(row: store.StoredProject, draft: ProjectDraft): { added: ImportItem[]; changedItems: ImportItem[] } {
  const added: ImportItem[] = [];
  const changedItems: ImportItem[] = [];
  const fields = (['name', 'timezone', 'retentionDays', 'format'] as const).filter((f) => row[f] !== draft[f]);
  if (fields.length > 0) changedItems.push({ kind: 'settings', key: 'settings', title: 'Настройки проекта', fields: [...fields], ...(fields.includes('format') ? { stopsSearches: true } : {}) });
  const stored = new Map(row.environments.map((e) => [e.id, e]));
  for (const e of draft.environments) {
    const was = stored.get(e.id);
    if (!was) {
      added.push({ kind: 'environment', key: e.id, title: e.id });
      continue;
    }
    const a = canonicalEnv(was);
    const b = canonicalEnv(e as EnvironmentRecord);
    const diff = ENV_FIELDS.filter((f) => !same(a[f], b[f]));
    if (diff.length > 0) changedItems.push({ kind: 'environment', key: e.id, title: e.id, fields: [...diff], ...(scopeChanged(was as Parameters<typeof scopeChanged>[0], e as Parameters<typeof scopeChanged>[1]) ? { stopsSearches: true } : {}) });
  }
  const draftIds = draft.environments.map((e) => e.id);
  const before = row.environments.map((e) => e.id).filter((id) => draftIds.includes(id));
  const after = draftIds.filter((id) => stored.has(id));
  if (!same(before, after)) changedItems.push({ kind: 'environment', key: 'order', title: 'Порядок сред', fields: ['order'] });
  return { added, changedItems };
}

/** Запись для store: как у формы, без лишних полей. */
export function dataOf(id: string, draft: Pick<ProjectDraft, 'name' | 'timezone' | 'retentionDays' | 'format' | 'environments'>): store.ProjectData {
  return {
    id,
    name: draft.name,
    timezone: draft.timezone,
    retentionDays: draft.retentionDays,
    format: draft.format,
    environments: draft.environments.map((e) => ({
      id: e.id,
      name: e.name,
      kind: e.kind,
      backend: e.backend,
      selector: e.selector,
      ...(e.stand ? { stand: e.stand } : {}),
      ...(e.examples && e.examples.length > 0 ? { examples: e.examples } : {}),
    })) as EnvironmentRecord[],
  };
}

/** Сравнение раздела с базой и проверка изменившегося. Хранилище не вызывается: условия проверяются статически. */
export async function readSettings(q: Queryable, id: string, raw: unknown, ctx: ProjectFileContext): Promise<SettingsRead> {
  const row = await store.readProject(q, id);
  if (!row) return { changed: true, issues: [{ path: 'settings', message: 'записи проекта в базе ещё нет: раздел settings применить не к чему', key: 'catalog.settingsNoRecord' }], ...NOTHING };
  const parsed = parseSettingsSection(raw);
  if (!parsed.ok) {
    const known = [BUILTIN_FORMAT, ...ctx.formats].join(', ');
    // format не строка: те же слова, что у неизвестного профиля. Тело профиля файл задать не может.
    const issues = parsed.issues.map((i): ConfigIssue => (i.path === 'settings.format' ? { path: i.path, message: `формат логов указывается именем: известные форматы — ${known}`, key: 'project.format', params: { format: '—', known } } : i));
    return { changed: true, issues, ...NOTHING };
  }
  const s = parsed.value;
  const merged = mergeEnvironments(row.environments, s.environments);
  const namedIds = new Set(s.environments.map((e) => e.id));
  const missing = row.environments.filter((e) => !namedIds.has(e.id)).length;
  const candidate = { name: s.name, timezone: s.timezone, retentionDays: s.retentionDays, format: s.format, environments: merged.list };
  const sameData = canonicalProject(candidate as Parameters<typeof canonicalProject>[0], null) === canonicalProject(row, null);

  const stored = await viewStore.readView(q, id);
  const current = normalizeView(stored?.raw ?? null).view;
  const viewFields = s.view ? VIEW_FIELDS.filter((f) => !same(canonicalJson(s.view![f]), canonicalJson(current[f]))) : [];
  const viewItem: ImportItem[] = viewFields.length > 0 ? [{ kind: 'view', key: 'view', title: 'Вид', fields: [...viewFields] }] : [];

  if (sameData && viewFields.length === 0) return { changed: false, issues: [], ...NOTHING, missing };

  const view = viewFields.length > 0 ? (s.view as ViewSettings) : null;
  if (sameData) return { changed: true, issues: [], plan: { row, data: null, view, viewExpected: stored?.updatedAt ?? null }, added: [], changedItems: viewItem, missing };

  // Изменился: те же проверки, что у формы, в том же контексте. Пути от settings и с индексами файла.
  const checked = validateProjectInput(candidate, inputContext(ctx, id, row.environments));
  if (!checked.ok) return { changed: true, issues: checked.issues.map((i) => ({ ...i, path: toFilePath(i.path, merged.origin) })), ...NOTHING, missing };
  const draft = checked.project;
  const data = dataOf(id, draft);
  // После обрезки краёв запись могла совпасть с базой.
  const sameAfter = canonicalProject(data, null) === canonicalProject(row, null);
  const items = sameAfter ? { added: [], changedItems: [] } : reportItems(row, draft);
  if (sameAfter && viewFields.length === 0) return { changed: false, issues: [], ...NOTHING, missing };
  return { changed: true, issues: [], plan: { row, data: sameAfter ? null : data, view, viewExpected: stored?.updatedAt ?? null }, added: items.added, changedItems: [...items.changedItems, ...viewItem], missing };
}

/** Порядок ключей не важен: { full, brief } и { brief, full } одна настройка. */
function canonicalJson(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalJson);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, canonicalJson(x)]));
  return v;
}

// ---------- Запись ----------

/**
 * Запись настроек проекта, одна на форму и файл. Ничего не изменилось: false, отметка «Правится здесь» не появляется.
 * Система-автор идёт за названием проекта. Вызывать под обеими блокировками.
 */
export async function writeProjectRecord(q: Queryable, row: store.StoredProject, data: store.ProjectData, currentLogo: ProjectLogo | null, logo: ProjectLogo | null, file: FileVersion | undefined): Promise<boolean> {
  const canon = recordCanon(data, logo);
  if (canon === recordCanon(row, currentLogo)) return false;
  const sameAsFile = file?.canon === canon;
  await store.updateProject(q, data, {
    hiddenBy: row.hiddenBy,
    fromFile: row.fromFile || sameAsFile,
    edited: !sameAsFile,
    fileHash: sameAsFile ? file.hash : row.fileHash,
  });
  if (JSON.stringify(logoHashes(currentLogo)) !== JSON.stringify(logoHashes(logo))) await store.replaceLogo(q, data.id, logo);
  await lockProject(q, data.id);
  await store.renameAuthor(q, data.id, data.name);
  return true;
}

/** Шаг 5 применения: вид и настройки, затем система-автор. Логотип не меняется, метка вида и метка проекта независимы, как на формах. */
export async function writeSettings(q: Queryable, plan: SettingsPlan, ctx: ProjectFileContext): Promise<void> {
  const id = plan.row.id;
  if (plan.view) await viewStore.writeView(q, id, plan.view, plan.viewExpected);
  if (plan.data) {
    const logo = (await store.readLogos(q)).get(id) ?? null;
    await writeProjectRecord(q, plan.row, plan.data, logo, logo, fileVersion(ctx.file, id));
  }
}
