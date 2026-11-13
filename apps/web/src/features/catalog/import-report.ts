// Модель отчёта загрузки файла: группы изменений, ошибки, можно ли применить.
import type { ImportItem, ImportKind, ImportReport } from '@threadline/core/catalog';
import type { MaskKind } from '@threadline/core/search';
import i18n from '@/i18n/index.ts';
import { fieldText } from '@/lib/server-text.ts';

export type DiffGroupKey = 'added' | 'changed' | 'hidden' | 'restored' | 'undeleted' | 'skipped';
export const DIFF_GROUPS: readonly DiffGroupKey[] = ['added', 'changed', 'hidden', 'restored', 'undeleted', 'skipped'];

const KIND_ORDER: readonly ImportKind[] = ['settings', 'environment', 'view', 'idType', 'system', 'method', 'error', 'outcome', 'masking'];

export interface DiffItem {
  kind: ImportKind;
  key: string;
  title: string;
  /** Изменённые поля по порядку файла; у других групп — пусто. */
  fields: string[];
  /** Правка остановит идущие поиски, как при сохранении формы. */
  stopsSearches: boolean;
}

export interface DiffGroup {
  key: DiffGroupKey;
  count: number;
  /** Записи по видам: типы id, системы, методы, ошибки, правила итога. */
  byKind: { kind: ImportKind; items: DiffItem[] }[];
}

export interface DiffModel {
  /** Только непустые группы, в порядке «добавлено, изменено, скрыто, возвращено, файл не возвращает, пропущено». */
  groups: DiffGroup[];
  unchanged: number;
  missing: number;
  errors: { path: string; message: string }[];
  /** Поля без действия и повторы: применить файл они не мешают. */
  warnings: { path: string; message: string }[];
  /** Какие виды маскирования файл выключает: отдельная строка-предупреждение. */
  disables: string[];
  /** Сколько записей изменит загрузка: добавлено + изменено + скрыто + возвращено. */
  changes: number;
  /** Файл верный, и есть что применить. */
  canApply: boolean;
  /** Ручные правки пропущены: --force заменил бы их. */
  forceWouldHelp: boolean;
  /** Сколько удалённых записей файл не вернул: --force вернул бы их. */
  undeleted: number;
  /** Сколько сред нет в файле: их убирают на форме. */
  missingEnvironments: number;
  /** Что-то из правок остановит идущие поиски. */
  stopsSearches: boolean;
}

/** Заголовок строки отчёта: название вида маскирования и строк настроек на языке интерфейса, остальное из файла как есть. */
function itemTitle(x: ImportItem): string {
  if (x.kind === 'masking') return i18n.t(`catalog.masking.type.${x.key as MaskKind}`);
  if (x.kind === 'settings') return i18n.t('catalog.fileItem.settings');
  if (x.kind === 'view') return i18n.t('catalog.fileItem.view');
  if (x.kind === 'environment' && x.key === 'order') return i18n.t('catalog.fileItem.order');
  return x.title || x.key;
}

function toItem(x: ImportItem): DiffItem {
  return { kind: x.kind, key: x.key, title: itemTitle(x), fields: x.fields ?? [], stopsSearches: x.stopsSearches === true };
}

function byKind(items: readonly ImportItem[]): DiffGroup['byKind'] {
  return KIND_ORDER.map((kind) => ({ kind, items: items.filter((x) => x.kind === kind).map(toItem) })).filter((g) => g.items.length > 0);
}

export function diffModel(r: ImportReport): DiffModel {
  // Заготовки отчётов в тестах и прежний сервер этих групп не несут.
  const items = (key: DiffGroupKey): readonly ImportItem[] => r[key] ?? [];
  const groups = DIFF_GROUPS.map((key): DiffGroup => ({ key, count: items(key).length, byKind: byKind(items(key)) })).filter((g) => g.count > 0);
  const changes = r.added.length + r.changed.length + r.hidden.length + items('restored').length;
  return {
    groups,
    unchanged: r.unchanged,
    missing: r.missing,
    errors: [...r.errors].sort((a, b) => a.path.localeCompare(b.path, 'en', { numeric: true })).map((e) => ({ path: e.path, message: fieldText(e) })),
    warnings: [...(r.warnings ?? [])].sort((a, b) => a.path.localeCompare(b.path, 'en', { numeric: true })).map((e) => ({ path: e.path, message: fieldText(e) })),
    disables: r.changed.filter((x) => x.disables).map(itemTitle),
    changes,
    canApply: r.errors.length === 0 && !r.applied && changes > 0,
    forceWouldHelp: r.errors.length === 0 && r.skipped.length > 0,
    undeleted: r.errors.length === 0 ? items('undeleted').length : 0,
    missingEnvironments: r.missingEnvironments ?? 0,
    stopsSearches: [...r.added, ...r.changed].some((x) => x.stopsSearches === true),
  };
}
