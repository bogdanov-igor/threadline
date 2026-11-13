// Чистая логика редактора: разделы, порядок записей, поиск по справочнику, типы подстановок.
import { type CatalogResponse, type ErrorRow, type HttpCond, type IdTypeRow, type MaskingRow, type MethodKind, type MethodRow, type OutcomeRow, type RowKind, type SystemKind, type SystemRow, typeKeyOf } from '@threadline/core/catalog';
import { BUILTIN_FIELDS, MASK_KIND_CODES, MASK_KINDS, type MaskKind } from '@threadline/core/search';
import i18n from '@/i18n/index.ts';

// ---------- Разделы ----------

export type SectionId = 'project' | 'general' | 'ids' | 'masking' | 'unknown' | `system-${string}`;

export interface Section {
  id: SectionId;
  kind: 'system' | 'general' | 'ids' | 'masking' | 'unknown';
  /** Система раздела: у «Проекта» — система-автор. */
  system: SystemRow | null;
}

/** Адрес раздела. «Проект» — без раздела в адресе, система — /catalog/systems/:key, маскирование — пункт настроек проекта. */
export function catalogPath(project: string, section?: SectionId): string {
  const root = `/${encodeURIComponent(project)}`;
  if (section === 'masking') return `${root}/settings/masks`;
  if (section?.startsWith('system-')) return `${root}/catalog/systems/${encodeURIComponent(section.slice('system-'.length))}`;
  return section && section !== 'project' ? `${root}/catalog/${encodeURIComponent(section)}` : `${root}/catalog`;
}

/** Раздел из параметров адреса: обратное к catalogPath. */
export function sectionParam(params: { section?: string | undefined; key?: string | undefined }): string | undefined {
  if (params.key !== undefined) return `system-${params.key}`;
  return params.section === 'masks' ? 'masking' : params.section;
}

const collator = new Intl.Collator('ru', { sensitivity: 'base', numeric: true });

export const authorOf = (s: CatalogResponse): SystemRow | null => s.systems.find((x) => x.kind === 'project') ?? null;

/** Внешние системы по алфавиту. Скрытые — только в фильтре «Скрытые». */
export function externalSystems(s: CatalogResponse, hidden = false): SystemRow[] {
  return s.systems.filter((x) => x.kind === 'external' && (hidden || !x.hidden)).sort((a, b) => collator.compare(a.name, b.name) || a.id - b.id);
}

export const sectionOf = (system: SystemRow): SectionId => (system.kind === 'project' ? 'project' : `system-${system.key}`);

/** Разделы слева: «Проект», внешние системы, «Общие правила», «Идентификаторы», «Маскирование», «Неизвестное». */
export function sections(s: CatalogResponse | undefined, hidden = false): Section[] {
  const author = s ? authorOf(s) : null;
  return [
    { id: 'project', kind: 'system', system: author },
    ...(s ? externalSystems(s, hidden) : []).map((system): Section => ({ id: sectionOf(system), kind: 'system', system })),
    { id: 'general', kind: 'general', system: null },
    { id: 'ids', kind: 'ids', system: null },
    { id: 'masking', kind: 'masking', system: null },
    { id: 'unknown', kind: 'unknown', system: null },
  ];
}

/** Раздел из адреса. Неизвестный — «Проект» с пометкой, что раздела нет. */
export function resolveSection(param: string | undefined, list: Section[]): { section: Section; notFound: boolean } {
  const first = list[0]!;
  if (!param) return { section: first, notFound: false };
  const found = list.find((x) => x.id === param);
  return found ? { section: found, notFound: false } : { section: first, notFound: true };
}

// ---------- Записи раздела ----------

const visible = <T extends { hidden: boolean }>(rows: T[], hidden: boolean) => rows.filter((r) => r.hidden === hidden);

export function methodsOf(s: CatalogResponse, systemId: number, hidden = false): MethodRow[] {
  return visible(
    s.methods.filter((m) => m.systemId === systemId),
    hidden,
  ).sort((a, b) => collator.compare(a.path, b.path) || a.http.localeCompare(b.http) || a.rpc.localeCompare(b.rpc) || a.id - b.id);
}

const codeOrder = (e: ErrorRow) => [e.http === null ? 1 : 0, e.code === null ? 1 : 0, e.text === null ? 1 : 0].join('');

/** Ошибки системы и её методов (или общие при systemId = null): сначала методов, затем системы. */
export function errorsOf(s: CatalogResponse, systemId: number | null, hidden = false): ErrorRow[] {
  const name = methodNames(s);
  return visible(
    s.errors.filter((e) => e.systemId === systemId),
    hidden,
  ).sort(
    (a, b) =>
      (a.methodId === null ? 1 : 0) - (b.methodId === null ? 1 : 0) ||
      collator.compare(name.get(a.methodId ?? -1) ?? '', name.get(b.methodId ?? -1) ?? '') ||
      collator.compare(a.code ?? '', b.code ?? '') ||
      (a.http ?? 0) - (b.http ?? 0) ||
      codeOrder(a).localeCompare(codeOrder(b)) ||
      collator.compare(a.text ?? '', b.text ?? '') ||
      a.id - b.id,
  );
}

/** Правила итога в порядке проверки: правила методов, затем правила системы по приоритету. */
export function outcomeRulesOf(s: CatalogResponse, systemId: number | null, hidden = false): OutcomeRow[] {
  const name = methodNames(s);
  return visible(
    s.outcomeRules.filter((r) => r.systemId === systemId),
    hidden,
  ).sort(
    (a, b) =>
      (a.methodId === null ? 1 : 0) - (b.methodId === null ? 1 : 0) ||
      collator.compare(name.get(a.methodId ?? -1) ?? '', name.get(b.methodId ?? -1) ?? '') ||
      a.priority - b.priority ||
      a.id - b.id,
  );
}

export function idTypesOf(s: CatalogResponse, hidden = false): IdTypeRow[] {
  return visible(s.idTypes, hidden).sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'entity' ? -1 : 1) || a.key.localeCompare(b.key));
}

export function methodNames(s: CatalogResponse): Map<number, string> {
  return new Map(s.methods.map((m) => [m.id, m.name]));
}

/** Сколько ошибок и правил итога у метода: счётчик в строке метода. */
export function methodRuleCounts(s: CatalogResponse): Map<number, { errors: number; outcomes: number }> {
  const out = new Map<number, { errors: number; outcomes: number }>();
  const get = (id: number) => out.get(id) ?? out.set(id, { errors: 0, outcomes: 0 }).get(id)!;
  for (const e of s.errors) if (e.methodId !== null && !e.hidden) get(e.methodId).errors++;
  for (const r of s.outcomeRules) if (r.methodId !== null && !r.hidden) get(r.methodId).outcomes++;
  return out;
}

/** Сколько видимых методов ссылается на тип id: тип операции или поле id. */
export function typeUsage(s: CatalogResponse): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of s.methods) {
    if (m.hidden) continue;
    const keys = new Set([...(m.op ? [m.op] : []), ...m.fields.map((f) => f.type)]);
    for (const k of keys) out.set(k, (out.get(k) ?? 0) + 1);
  }
  return out;
}

/** Число скрытых записей раздела: подсказка у фильтра «Скрытые». */
export function hiddenCount(s: CatalogResponse): number {
  return [s.systems, s.methods, s.errors, s.outcomeRules, s.idTypes].reduce((n, rows) => n + rows.filter((r) => r.hidden).length, 0);
}

// ---------- Виды ----------

/** Виды метода, которые можно выбрать: колбэк — только у системы-автора. */
export function methodKinds(systemKind: SystemKind): MethodKind[] {
  return systemKind === 'project' ? ['call', 'start', 'status', 'callback'] : ['call', 'start', 'status'];
}

/** Нужен ли тип операции: у вида, кроме обычного, обязателен. */
export const needsOp = (kind: MethodKind) => kind !== 'call';

// ---------- Подстановки пути ----------

/** Имя подстановки → ключ типа: {transferId}, {transfer_id}, {transfer2} → transfer. */
export const placeholderType = (name: string): string => typeKeyOf(name);

export interface PlaceholderInfo {
  name: string;
  type: IdTypeRow | null;
}

/** Подстановки шаблона с найденным типом: подпись под полем пути. */
export function placeholders(path: string, idTypes: readonly IdTypeRow[]): PlaceholderInfo[] {
  const byKey = new Map(idTypes.filter((t) => !t.hidden).map((t) => [t.key, t]));
  const out: PlaceholderInfo[] = [];
  for (const m of path.matchAll(/\{([^{}/]+)\}/g)) {
    const name = m[1]!;
    if (out.some((p) => p.name === name)) continue;
    out.push({ name, type: byKey.get(placeholderType(name)) ?? null });
  }
  return out;
}

// ---------- Поиск ----------

export interface SearchHit {
  kind: RowKind | 'masking';
  id: number;
  section: SectionId;
  /** Вид маскирования: у него своя строка результата. */
  type?: MaskKind;
}

/** Строка настройки каждого вида в порядке таблицы: другая копия могла ещё не создать строку, вид тогда в состоянии по умолчанию. У вида с замком значение строки не действует. */
export function maskingRows(s: CatalogResponse): { type: MaskKind; row: MaskingRow | null; enabled: boolean; keys: string[] }[] {
  const byType = new Map((s.masking ?? []).map((r) => [r.type, r]));
  return MASK_KIND_CODES.map((type) => {
    const row = byType.get(type) ?? null;
    return { type, row, enabled: !MASK_KINDS[type].switchable || (row?.enabled ?? MASK_KINDS[type].defaultEnabled), keys: row?.keys ?? [] };
  });
}

export interface SearchGroup {
  section: SectionId;
  hits: SearchHit[];
}

function httpValues(h: HttpCond | undefined): string[] {
  if (h === undefined) return [];
  const list = Array.isArray(h) ? h : [h];
  return list.map((x) => (typeof x === 'number' ? String(x) : `${x.from}-${x.to}`));
}

/** Поиск без учёта регистра по всему справочнику, группами по разделам в их порядке. */
export function searchCatalog(s: CatalogResponse, query: string, hidden = false): SearchGroup[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hit = (...values: (string | number | null | undefined)[]) => values.some((v) => v !== null && v !== undefined && String(v).toLowerCase().includes(q));
  const systemSection = new Map(s.systems.map((x) => [x.id, sectionOf(x)]));
  const sectionFor = (systemId: number | null): SectionId => (systemId === null ? 'general' : (systemSection.get(systemId) ?? 'general'));
  const groups = new Map<SectionId, SearchHit[]>();
  const add = (h: SearchHit) => groups.set(h.section, [...(groups.get(h.section) ?? []), h]);

  for (const x of s.systems) if (x.hidden === hidden && hit(x.name, x.key, x.description, ...x.hosts)) add({ kind: 'system', id: x.id, section: sectionOf(x) });
  for (const m of methodsSorted(s))
    if (m.hidden === hidden && hit(m.name, m.path, m.rpc, m.domain, m.description, m.http === '*' ? null : m.http, m.op, ...m.fields.map((f) => f.path), m.status?.path))
      add({ kind: 'method', id: m.id, section: sectionFor(m.systemId) });
  for (const e of s.errors) if (e.hidden === hidden && hit(e.code, e.text, e.title, e.action, e.partnerCode, e.http)) add({ kind: 'error', id: e.id, section: sectionFor(e.systemId) });
  for (const r of s.outcomeRules) {
    if (r.hidden !== hidden) continue;
    const fields = r.when.fields ?? [];
    const values = fields.flatMap((f) => [f.path, f.regex, f.equals, ...(f.oneOf ?? [])].map((v) => (v === undefined ? null : String(v))));
    if (hit(r.text, r.action, ...httpValues(r.when.http), ...values)) add({ kind: 'outcome', id: r.id, section: sectionFor(r.systemId) });
  }
  for (const t of s.idTypes) if (t.hidden === hidden && hit(t.key, t.name, ...t.statuses.flatMap((x) => [x.value, x.name]))) add({ kind: 'idType', id: t.id, section: 'ids' });
  if (!hidden) {
    for (const [i, m] of maskingRows(s).entries()) {
      if (hit(m.type, i18n.t(`catalog.masking.type.${m.type}`), ...BUILTIN_FIELDS[m.type], ...m.keys)) add({ kind: 'masking', id: i, section: 'masking', type: m.type });
    }
  }

  const order = sections(s, true).map((x) => x.id);
  return [...groups.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])).map(([section, hits]) => ({ section, hits }));
}

function methodsSorted(s: CatalogResponse): MethodRow[] {
  return [...s.methods].sort((a, b) => collator.compare(a.path, b.path) || a.id - b.id);
}
