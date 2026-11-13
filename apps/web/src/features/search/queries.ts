import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MultiSearchRequestBody, RequestDetail, SearchCreated, SearchRequestBody, SearchState } from '@threadline/core/search';
import { useJobSource, VIEWER } from '@/features/share/mode.ts';
import { ApiError, apiGet, apiSend } from '@/lib/api.ts';
import { mergeSearchState } from './model.ts';

const enc = encodeURIComponent;

export const searchKeys = {
  state: (id: string) => ['search', id] as const,
  lines: (id: string, env?: string) => ['search-lines', id, env ?? ''] as const,
  request: (id: string, cid: string, env?: string) => ['search-request', id, cid, env ?? ''] as const,
  link: (p: string, e: string, stand: string, cid: string, from: number, to: number) => ['request-link', p, e, stand, cid, from, to] as const,
};

/** Задания уже нет в памяти сервера. */
export const isExpired = (e: unknown) => e instanceof ApiError && (e.code === 'search-expired' || e.status === 404);

const retryUnreachable = (count: number, e: unknown) => e instanceof ApiError && e.code === 'server-unreachable' && count < 2;

/**
 * Состояние поиска. Пока поиск идёт, опрос каждые 500 мс, и в скрытой вкладке тоже: иначе сервер
 * решит, что вкладку закрыли, и остановит поиск. Новые запросы приходят с индекса from и дописываются.
 * select — срез состояния: компонент перерисовывается, только когда срез изменился (сравнение по значению), опрос тот же.
 */
export function useSearchState<T = SearchState>(id: string | null, select?: (s: SearchState) => T) {
  const qc = useQueryClient();
  const source = useJobSource();
  return useQuery<SearchState, Error, T>({
    ...(select ? { select } : {}),
    queryKey: searchKeys.state(id ?? ''),
    queryFn: async ({ signal }) => {
      const prev = qc.getQueryData<SearchState>(searchKeys.state(id!));
      const from = prev?.requests.length ?? 0;
      const next = await source.state(id!, from, signal);
      return mergeSearchState(prev, next, from);
    },
    enabled: !!id,
    refetchInterval: (q) => (q.state.data?.status === 'running' && !isExpired(q.state.error) ? 500 : false),
    refetchIntervalInBackground: true,
    retry: retryUnreachable,
  });
}

/** Запуск поиска: одна среда — прежний маршрут, несколько — поиск по нескольким средам. */
export function useCreateSearch(project: string, envs: readonly string[]) {
  return useMutation({
    mutationFn: (body: SearchRequestBody) => {
      if (envs.length === 1) return apiSend<SearchCreated>('POST', `/api/projects/${enc(project)}/envs/${enc(envs[0]!)}/searches`, body);
      const { stand: _stand, ...rest } = body;
      return apiSend<SearchCreated>('POST', `/api/projects/${enc(project)}/searches`, { ...rest, envs: [...envs] } satisfies MultiSearchRequestBody);
    },
  });
}

export function useStopSearch(opts: { leave?: boolean } = {}) {
  const qc = useQueryClient();
  const suffix = opts.leave ? `?leave=${VIEWER}` : '';
  return useMutation({
    mutationFn: async (id: string) => {
      try {
        await apiSend('DELETE', `/api/searches/${enc(id)}${suffix}`);
      } catch (e) {
        // Задание уже удалено — останавливать нечего.
        if (!isExpired(e)) throw e;
      }
      return id;
    },
    onSettled: (id) => {
      if (id) void qc.invalidateQueries({ queryKey: searchKeys.state(id) });
    },
  });
}

/** «Все записи»: первая страница запрашивается только при открытии вкладки. */
export function useSearchLines(id: string, env?: string) {
  const source = useJobSource();
  return useInfiniteQuery({
    queryKey: searchKeys.lines(id, env),
    queryFn: ({ pageParam, signal }) => source.lines(id, pageParam, signal, env),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    staleTime: Infinity,
    retry: retryUnreachable,
  });
}

export interface RequestQueryArgs {
  project: string;
  env: string;
  stand: string | undefined;
  cid: string;
  searchId: string | null;
  /** Строка поиска по нескольким средам: из задания читается часть этой среды. Нет — поиск одной среды, ключ кэша прежний. */
  jobEnv?: string | undefined;
  from: number | null;
  to: number | null;
}

/**
 * Запрос из результатов поиска берётся из задания. Если задания уже нет или запроса в нём нет,
 * и по ссылке без задания — записи забираются заново за границы из адреса.
 */
export function useRequestDetail(a: RequestQueryArgs) {
  const source = useJobSource();
  const bySearch = useQuery({
    queryKey: searchKeys.request(a.searchId ?? '', a.cid, a.jobEnv),
    queryFn: ({ signal }) => source.request(a.searchId!, a.cid, signal, a.jobEnv),
    enabled: !!a.searchId,
    staleTime: Infinity,
    retry: retryUnreachable,
  });
  const fallback = !a.searchId || (bySearch.isError && isExpired(bySearch.error));
  const hasBounds = a.from !== null && a.to !== null;
  const byLink = useQuery({
    queryKey: searchKeys.link(a.project, a.env, a.stand ?? '', a.cid, a.from ?? 0, a.to ?? 0),
    queryFn: ({ signal }) => {
      const qs = new URLSearchParams({ from: String(a.from), to: String(a.to), ...(a.stand ? { stand: a.stand } : {}) });
      return apiGet<RequestDetail>(`/api/projects/${enc(a.project)}/envs/${enc(a.env)}/requests/${enc(a.cid)}?${qs}`, signal);
    },
    enabled: fallback && hasBounds,
    staleTime: 5 * 60_000,
    retry: retryUnreachable,
  });

  if (bySearch.data) return { data: bySearch.data, pending: false, error: null, noBounds: false, refetch: bySearch.refetch };
  if (!fallback) {
    return { data: undefined, pending: bySearch.isPending, error: bySearch.error, noBounds: false, refetch: bySearch.refetch };
  }
  if (!hasBounds) return { data: undefined, pending: false, error: null, noBounds: true, refetch: byLink.refetch };
  return { data: byLink.data, pending: byLink.isPending, error: byLink.error, noBounds: false, refetch: byLink.refetch };
}
