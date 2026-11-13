import { useQueryClient } from '@tanstack/react-query';
import type { SearchState } from '@threadline/core/search';
import { useCallback } from 'react';
import { useSearchParams } from 'react-router';
import { searchKeys, useStopSearch } from './queries.ts';

/**
 * Смена среды, стенда или проекта через выбор останавливает идущий поиск страницы поиска: найденное остаётся доступно
 * через «назад». Состояния в кэше ещё нет — поиск тоже останавливается. У страниц запроса и операции ?search нет,
 * там действуют их правила. «Назад», логотип и «Справочник» сюда не ходят: поиск остановит сервер, если его не спрашивают.
 */
export function useLeaveSearch() {
  const [params] = useSearchParams();
  const qc = useQueryClient();
  const { mutate: stop } = useStopSearch();
  const id = params.get('search');
  return useCallback(() => {
    if (!id) return;
    const state = qc.getQueryData<SearchState>(searchKeys.state(id));
    if (!state || state.status === 'running') stop(id);
  }, [id, qc, stop]);
}
