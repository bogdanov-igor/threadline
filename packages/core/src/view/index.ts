// Настройка вида проекта: состав, встроенные значения, правила выбора, терпимый разбор записи. Без zod: идёт в главный чанк.
// Строгая схема записи — в ./schema.ts, её импортирует только сервер.

export type ViewMode = 'full' | 'brief';
export const VIEW_MODES: readonly ViewMode[] = ['full', 'brief'];

export interface Shown {
  full: boolean;
  brief: boolean;
}

/** Порядок колонок постоянный: статус всегда первый и не настраивается, ID запроса всегда последний. */
export const LIST_COLUMNS = ['time', 'request', 'outcome', 'component', 'duration', 'records', 'cid'] as const;
export type ListColumn = (typeof LIST_COLUMNS)[number];
/** Без них строку нельзя прочитать: не выключаются ни формой, ни запросом. */
export const REQUIRED_COLUMNS: readonly ListColumn[] = ['time', 'request', 'outcome'];

export const REQUEST_TABS = ['scheme', 'timeline', 'records'] as const;
export type RequestTab = (typeof REQUEST_TABS)[number];
/** «Шкалы времени» здесь нет: она есть всегда. */
export const OPTIONAL_TABS = ['scheme', 'records'] as const;
export type OptionalTab = (typeof OPTIONAL_TABS)[number];

export const VIEW_BLOCKS = ['request', 'response', 'headers', 'context', 'raw', 'logs'] as const;
export type ViewBlock = (typeof VIEW_BLOCKS)[number];

export const BODY_VIEWS = ['pretty', 'raw'] as const;
export type BodyView = (typeof BODY_VIEWS)[number];

export interface ViewSettings {
  defaultMode: ViewMode;
  columns: Record<ListColumn, Shown>;
  defaultTab: RequestTab;
  tabs: Record<OptionalTab, Shown>;
  blocks: Record<ViewBlock, Shown>;
  bodyView: BodyView;
}

/** Что разбор записи изменил. Текст берёт интерфейс из каталога строк. */
export interface ViewIssue {
  code: 'dropped' | 'forced' | 'defaulted' | 'unparsed';
  field: string;
  value?: string;
}

const both = (): Shown => ({ full: true, brief: true });
const fullOnly = (): Shown => ({ full: true, brief: false });

export const DEFAULT_VIEW: ViewSettings = {
  defaultMode: 'full',
  columns: { time: both(), request: both(), outcome: both(), component: fullOnly(), duration: both(), records: fullOnly(), cid: fullOnly() },
  defaultTab: 'scheme',
  tabs: { scheme: both(), records: fullOnly() },
  blocks: { request: both(), response: both(), headers: fullOnly(), context: fullOnly(), raw: fullOnly(), logs: fullOnly() },
  bodyView: 'pretty',
};

/** Колонки режима в постоянном порядке. */
export function visibleColumns(view: ViewSettings, mode: ViewMode): ListColumn[] {
  return LIST_COLUMNS.filter((c) => view.columns[c][mode]);
}

/** Вкладки страницы запроса в режиме: «Шкала времени» есть всегда. */
export function visibleTabs(view: ViewSettings, mode: ViewMode): RequestTab[] {
  return REQUEST_TABS.filter((t) => t === 'timeline' || view.tabs[t][mode]);
}

/** Вкладка, открытая в режиме: выбранная, если она тут есть; иначе вкладка по умолчанию; иначе первая видимая. */
export function shownTab(view: ViewSettings, mode: ViewMode, chosen: RequestTab | null): RequestTab {
  const tabs = visibleTabs(view, mode);
  if (chosen && tabs.includes(chosen)) return chosen;
  return tabs.includes(view.defaultTab) ? view.defaultTab : tabs[0]!;
}

export function blockVisible(view: ViewSettings, mode: ViewMode, block: ViewBlock): boolean {
  return view.blocks[block][mode];
}

/** Виден ли хотя бы один блок подробностей записи: у логов свои блоки, они здесь не считаются. */
export function anyDetailBlock(view: ViewSettings, mode: ViewMode): boolean {
  return VIEW_BLOCKS.some((b) => b !== 'logs' && view.blocks[b][mode]);
}

/** Вкладка выключена в обоих режимах: вкладкой по умолчанию она быть не может. */
export function tabOffEverywhere(view: Pick<ViewSettings, 'tabs'>, tab: RequestTab): boolean {
  return tab !== 'timeline' && !view.tabs[tab].full && !view.tabs[tab].brief;
}

// ---------- Разбор записи ----------

const MAX_VALUE = 40;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Значение для сообщения: обрезано, разметки в нём нет, страница покажет его как текст. */
function shortValue(v: unknown): string {
  let s: string;
  try {
    s = typeof v === 'string' ? v : (JSON.stringify(v) ?? String(v));
  } catch {
    s = String(v);
  }
  return s.length > MAX_VALUE ? `${s.slice(0, MAX_VALUE - 1)}…` : s;
}

function readEnum<T extends string>(raw: Record<string, unknown>, field: string, allowed: readonly T[], fallback: T, issues: ViewIssue[]): T {
  if (!Object.hasOwn(raw, field)) return fallback;
  const v = raw[field];
  if (typeof v === 'string' && (allowed as readonly string[]).includes(v)) return v as T;
  issues.push({ code: 'defaulted', field, value: shortValue(v) });
  return fallback;
}

/** Видимость одного элемента: чего нет — встроенное, неизвестное отбрасывается. */
function readShown(raw: unknown, at: string, fallback: Shown, issues: ViewIssue[]): Shown {
  if (!isRecord(raw)) {
    issues.push({ code: 'defaulted', field: at, value: shortValue(raw) });
    return { ...fallback };
  }
  for (const key of Object.keys(raw)) if (key !== 'full' && key !== 'brief') issues.push({ code: 'dropped', field: at, value: shortValue(key) });
  const part = (mode: ViewMode): boolean => {
    if (!Object.hasOwn(raw, mode)) return fallback[mode];
    const v = raw[mode];
    if (typeof v === 'boolean') return v;
    issues.push({ code: 'defaulted', field: `${at}.${mode}`, value: shortValue(v) });
    return fallback[mode];
  };
  return { full: part('full'), brief: part('brief') };
}

/** Раздел настройки: только известные ключи, неизвестные называются в сообщении. */
function readSection<K extends string>(raw: Record<string, unknown>, field: string, known: readonly K[], fallback: Record<K, Shown>, issues: ViewIssue[]): Record<K, Shown> {
  const out = Object.fromEntries(known.map((k) => [k, { ...fallback[k] }])) as Record<K, Shown>;
  if (!Object.hasOwn(raw, field)) return out;
  const section = raw[field];
  if (!isRecord(section)) {
    issues.push({ code: 'defaulted', field, value: shortValue(section) });
    return out;
  }
  for (const key of Object.keys(section)) {
    if ((known as readonly string[]).includes(key)) out[key as K] = readShown(section[key], `${field}.${key}`, fallback[key as K], issues);
    else issues.push({ code: 'dropped', field, value: shortValue(key) });
  }
  return out;
}

const KNOWN_FIELDS = ['defaultMode', 'columns', 'defaultTab', 'tabs', 'blocks', 'bodyView'];

/**
 * Запись из базы в полную настройку. Неверная запись не делает проект неверным и не бросает исключений,
 * сервер её сам не переписывает: откат версии просто отбросит новое при чтении. Результат всегда проходит viewSchema.
 */
export function normalizeView(raw: unknown): { view: ViewSettings; issues: ViewIssue[] } {
  const issues: ViewIssue[] = [];
  if (raw === null || raw === undefined) return { view: copyDefault(), issues };
  if (!isRecord(raw)) return { view: copyDefault(), issues: [{ code: 'unparsed', field: 'view' }] };
  for (const key of Object.keys(raw)) if (!KNOWN_FIELDS.includes(key)) issues.push({ code: 'dropped', field: 'view', value: shortValue(key) });

  const columns = readSection(raw, 'columns', LIST_COLUMNS, DEFAULT_VIEW.columns, issues);
  for (const c of REQUIRED_COLUMNS) force(columns[c], `columns.${c}`, issues, ['full', 'brief']);
  const blocks = readSection(raw, 'blocks', VIEW_BLOCKS, DEFAULT_VIEW.blocks, issues);
  force(blocks.raw, 'blocks.raw', issues, ['full']);
  const tabs = readSection(raw, 'tabs', OPTIONAL_TABS, DEFAULT_VIEW.tabs, issues);

  let defaultTab = readEnum(raw, 'defaultTab', REQUEST_TABS, DEFAULT_VIEW.defaultTab, issues);
  // Встроенная вкладка тоже могла оказаться выключенной: запись выключила «Схему» и вкладки по умолчанию не называет.
  if (tabOffEverywhere({ tabs }, defaultTab)) {
    if (Object.hasOwn(raw, 'defaultTab')) issues.push({ code: 'defaulted', field: 'defaultTab', value: defaultTab });
    defaultTab = 'timeline';
  }
  return {
    view: {
      defaultMode: readEnum(raw, 'defaultMode', VIEW_MODES, DEFAULT_VIEW.defaultMode, issues),
      columns,
      defaultTab,
      tabs,
      blocks,
      bodyView: readEnum(raw, 'bodyView', BODY_VIEWS, DEFAULT_VIEW.bodyView, issues),
    },
    issues,
  };
}

function force(shown: Shown, field: string, issues: ViewIssue[], modes: readonly ViewMode[]): void {
  for (const mode of modes) {
    if (shown[mode]) continue;
    shown[mode] = true;
    issues.push({ code: 'forced', field: `${field}.${mode}` });
  }
}

function copyDefault(): ViewSettings {
  return structuredClone(DEFAULT_VIEW);
}

/** Одинаковы ли две настройки: форма сравнивает с записью и отправляет встроенную как null. */
export function sameView(a: ViewSettings, b: ViewSettings): boolean {
  const same = (x: Record<string, Shown>, y: Record<string, Shown>) => Object.keys(x).every((k) => x[k]!.full === y[k]!.full && x[k]!.brief === y[k]!.brief);
  return a.defaultMode === b.defaultMode && a.defaultTab === b.defaultTab && a.bodyView === b.bodyView && same(a.columns, b.columns) && same(a.tabs, b.tabs) && same(a.blocks, b.blocks);
}
