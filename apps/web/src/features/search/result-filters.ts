// Фильтры результатов: только по уже загруженным строкам, запросов не добавляют.
import { rowKey, type RequestSummary } from '@threadline/core/search';
import { catalogReasonView, entryName, entryOf } from '@/features/catalog/names.ts';
import { briefMethod, briefSystem } from '@/features/view/brief.ts';

export type RowFacet = 'method' | 'system' | 'component';

/** null — фильтр не выбран. */
export type RowFilters = Record<RowFacet, string | null>;

export const NO_FILTERS: RowFilters = { method: null, system: null, component: null };

/** Значение строки без метода, системы или компонента: символ из личной области, настоящего значения с ним не бывает. */
export const NO_VALUE = '\uE000';

export type RowFacets = Map<string, Record<RowFacet, readonly string[]>>;
export type FilterOptions = Record<RowFacet, string[]>;

/** Название метода, иначе шаблон пути: значений из адреса в списке нет. */
function rowMethod(r: RequestSummary): string {
  return entryName(r) ?? (r.incoming ? briefMethod({ uri: r.incoming.path }) : '');
}

/** Система входа и системы причин: только по входу у всех строк был бы один проект. В «Кратко» имена те же, что в строке, адресов нет. */
function rowSystems(r: RequestSummary, brief: boolean): string[] {
  const out = new Set<string>();
  const entry = entryOf(r)?.system?.name;
  if (entry) out.add(entry);
  for (const reason of r.reasons) {
    if (reason.kind === 'pending') continue;
    const system = catalogReasonView(reason).system;
    if (system) out.add(brief ? briefSystem(system) : system);
  }
  return out.size > 0 ? [...out] : [NO_VALUE];
}

export function rowFacets(rows: readonly RequestSummary[], brief: boolean): RowFacets {
  // Ключ строки: один correlation_id в двух средах — две строки со своими значениями.
  return new Map(rows.map((r) => [rowKey(r), { method: [rowMethod(r) || NO_VALUE], system: rowSystems(r, brief), component: [r.component || NO_VALUE] }]));
}

/** Значения фильтров по всем загруженным строкам. Компонента нет там, где нет его колонки. */
export function filterOptions(facets: RowFacets, hasComponent: boolean): FilterOptions {
  const collect = (facet: RowFacet) => {
    const values = new Set<string>();
    for (const f of facets.values()) for (const v of f[facet]) values.add(v);
    // Строки без значения последними.
    return [...values].sort((a, b) => Number(a === NO_VALUE) - Number(b === NO_VALUE) || a.localeCompare(b));
  };
  return { method: collect('method'), system: collect('system'), component: hasComponent ? collect('component') : [] };
}

/** Что действует: выбранное значение, которого нет среди значений фильтра (сменились режим или язык), не скрывает строки. */
export function activeFilters(filters: RowFilters, options: FilterOptions): RowFilters {
  const pick = (facet: RowFacet) => {
    const v = filters[facet];
    return v !== null && options[facet].includes(v) ? v : null;
  };
  return { method: pick('method'), system: pick('system'), component: pick('component') };
}

/** «Только с ошибкой»: без строк с ошибкой выключатель ничего не скрывает. */
export const rowsByStatus = (rows: RequestSummary[], onlyErrors: boolean): RequestSummary[] => (onlyErrors && rows.some((r) => r.status === 'error') ? rows.filter((r) => r.status === 'error') : rows);

export const anyFilter = (f: RowFilters) => f.method !== null || f.system !== null || f.component !== null;

export function applyFilters(rows: readonly RequestSummary[], facets: RowFacets, f: RowFilters): RequestSummary[] {
  if (!anyFilter(f)) return [...rows];
  return rows.filter((r) => {
    const row = facets.get(rowKey(r));
    return !!row && (['method', 'system', 'component'] as const).every((facet) => f[facet] === null || row[facet].includes(f[facet]));
  });
}
