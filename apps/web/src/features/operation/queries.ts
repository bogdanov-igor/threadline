// Запуск поиска операции и дополнение по новым id. Состояние задания
// опрашивает тот же useSearchState, что у обычного поиска: поле operation приходит в SearchState.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import type { OperationRequestBody, OperationSupplementBody, SearchCreated, SearchState } from '@threadline/core/search';
import { searchKeys, useStopSearch } from '@/features/search/queries.ts';
import { apiSend } from '@/lib/api.ts';
import { staysInOperation } from './model.ts';

const enc = encodeURIComponent;

export function useStartOperation(project: string, env: string) {
  return useMutation({
    mutationFn: (body: OperationRequestBody) =>
      apiSend<SearchCreated>('POST', `/api/projects/${enc(project)}/envs/${enc(env)}/operations`, body),
  });
}

/**
 * «Искать и по id …»: то же дополнение из другой вкладки отдаётся готовым (cached), другие значения при живом
 * дополнении — 409 operation-supplemented; остановленное или упавшее запускается заново.
 */
export function useSupplementOperation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ searchId, body }: { searchId: string; body: OperationSupplementBody }) =>
      apiSend<SearchCreated>('POST', `/api/searches/${enc(searchId)}/supplement`, body),
    onSettled: (_r, _e, v) => {
      void qc.invalidateQueries({ queryKey: searchKeys.state(v.searchId) });
    },
  });
}

/**
 * Уход со страницы операции или её потока останавливает поиск, если следующий адрес — не эта операция и задание не
 * опрашивает другая вкладка: то решает сервер. При размонтировании адрес и состояние перехода уже новые: история
 * меняется раньше отрисовки.
 */
export function useStopOnLeave(searchId: string | null, href: string): void {
  const qc = useQueryClient();
  const { mutate: stop } = useStopSearch({ leave: true });
  const latest = useRef(href);
  latest.current = href;
  useEffect(() => {
    if (!searchId) return;
    return () => {
      const state = qc.getQueryData<SearchState>(searchKeys.state(searchId));
      if (state && state.status !== 'running') return;
      const to = {
        pathname: window.location.pathname,
        search: window.location.search,
        state: (window.history.state as { usr?: unknown } | null)?.usr ?? null,
      };
      if (!staysInOperation(latest.current, searchId, to)) stop(searchId);
    };
  }, [searchId, qc, stop]);
}
