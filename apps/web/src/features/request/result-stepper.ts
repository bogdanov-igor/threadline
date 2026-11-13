// «1 из 12» на странице запроса: какой список идём, где в нём запрос.
import { rowKey, type RequestSummary, type SearchState } from '@threadline/core/search';
import { useCallback, useLayoutEffect, useRef } from 'react';
import { useLocation } from 'react-router';
import { newestFirst } from '@/features/search/model.ts';
import { activeFilters, anyFilter, applyFilters, filterOptions, rowFacets, rowsByStatus, type RowFilters } from '@/features/search/result-filters.ts';

export type ListDirection = 'prev' | 'next';

/** Поле страницы над ссылкой назад, когда запрос не открылся: та же высота, что у строки действий в шапке и заготовке (pt-3.5 и полоса h-8), кнопки перехода не прыгают. */
export const RESULT_NAV_PAGE = 'pt-4 lg:pt-4';

/**
 * Один переход с одной записи истории. Пока новая страница не показана, повтор считал бы от старого места: та же цель, то же число переходов, лишняя запись истории или возврат мимо списка.
 * Возвращает обёртку: второй вызов до смены записи ничего не делает.
 */
export function useOneMove(): (move: () => void) => void {
  const { key } = useLocation();
  const moved = useRef(false);
  useLayoutEffect(() => {
    moved.current = false;
  }, [key]);
  return useCallback((move) => {
    if (moved.current) return;
    moved.current = true;
    move();
  }, []);
}

const listMark = (state: unknown) => (state as { resultList?: { steps?: unknown; focus?: unknown } } | null)?.resultList;

/** Запрос открыт строкой списка: сколько переходов от неё сделано. Столько записей истории лежит между ним и результатами. null — открыт не из списка. */
export function readListSteps(state: unknown): number | null {
  const steps = listMark(state)?.steps;
  return typeof steps === 'number' && Number.isInteger(steps) && steps >= 0 ? steps : null;
}

/** Кнопка, на которой стоял фокус при переходе: страница пересоздаётся, фокус возвращается на такую же. */
export function readListFocus(state: unknown): ListDirection | null {
  const focus = listMark(state)?.focus;
  return focus === 'prev' || focus === 'next' ? focus : null;
}

/** Список таким, каким его показывает страница результатов: тот же порядок, «Только с ошибкой» и фильтры. Фильтр, значения которого больше нет, не действует и там. */
export function listRows(requests: RequestSummary[], ui: { onlyErrors: boolean; filters: RowFilters }, view: { brief: boolean; hasComponent: boolean }, envOrder: readonly string[] = []): RequestSummary[] {
  const newest = newestFirst(requests, envOrder);
  const facets = rowFacets(newest, view.brief);
  const filters = activeFilters(ui.filters, filterOptions(facets, view.hasComponent));
  return applyFilters(rowsByStatus(newest, ui.onlyErrors), facets, filters);
}

/**
 * Режим или язык отменили выбранное значение фильтра: страница результатов забывает его, когда все строки дошли.
 * Смена режима на странице запроса забывает так же, иначе при возврате в «Подробно» фильтр вернулся бы сам. null — забывать нечего.
 */
export function staleFilters(s: Pick<SearchState, 'requests' | 'requestsTotal'>, filters: RowFilters, view: { brief: boolean; hasComponent: boolean }): RowFilters | null {
  if (!anyFilter(filters) || s.requests.length === 0 || s.requests.length !== s.requestsTotal) return null;
  const active = activeFilters(filters, filterOptions(rowFacets(s.requests, view.brief), view.hasComponent));
  return JSON.stringify(active) === JSON.stringify(filters) ? null : active;
}

export interface ListPlace {
  /** С нуля. */
  index: number;
  total: number;
  prev: RequestSummary | null;
  next: RequestSummary | null;
}

/** Запроса нет в списке: переходить не от чего. key — ключ строки: correlation_id, у поиска по нескольким средам со средой. */
export function placeInList(rows: readonly RequestSummary[], key: string): ListPlace | null {
  const index = rows.findIndex((r) => rowKey(r) === key);
  if (index < 0) return null;
  return { index, total: rows.length, prev: rows[index - 1] ?? null, next: rows[index + 1] ?? null };
}

/** Строк может быть больше, чем видно: поиск идёт, остановлен, упал или упёрся в предел строк. */
export const listIsPartial = (s: Pick<SearchState, 'status' | 'truncated' | 'error'>): boolean => s.status !== 'done' || s.truncated || s.error !== null;
