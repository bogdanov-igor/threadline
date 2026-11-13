import { MutationCache, QueryCache, QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ConnectionResponse, ProjectsResponse, StandResponse, StandsResponse } from '@threadline/core';
import { applyRegional } from '@threadline/core/search';
import { ApiError, apiGet } from './api.ts';

/** Среды больше нет: страница сразу узнаёт об этом, не дожидаясь опроса версии. Проверка подключения от списка не зависит. */
const rereadOnUnknown = (e: unknown) => {
  if (e instanceof ApiError && e.code === 'unknown-environment') void queryClient.invalidateQueries({ queryKey: keys.projects });
};

export const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: rereadOnUnknown }),
  mutationCache: new MutationCache({ onError: rereadOnUnknown }),
  defaultOptions: {
    queries: {
      // Никаких фоновых запросов: Grafana не нагружаем.
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchInterval: false,
      retry: (count, e) => e instanceof ApiError && e.code === 'server-unreachable' && count < 2,
      retryDelay: 1000,
      // Без сети запрос не ставится на паузу, а падает: страница сразу говорит, что сервер недоступен, вместо бесконечной заготовки.
      // Так и у приложения, открытого из кэша воркера без связи.
      networkMode: 'always',
    },
    mutations: { networkMode: 'always' },
  },
});

const envPath = (project: string, env: string) => `/api/projects/${encodeURIComponent(project)}/envs/${encodeURIComponent(env)}`;

export const keys = {
  projects: ['projects'] as const,
  connection: (p: string, e: string) => ['connection', p, e] as const,
  stands: (p: string, e: string) => ['stands', p, e] as const,
  stand: (p: string, e: string, s: string) => ['stand', p, e, s] as const,
};

export function useProjects() {
  return useQuery({
    queryKey: keys.projects,
    // Региональные правила приходят со списком: телефоны в поиске и маска страницы из лога — по ним.
    queryFn: ({ signal }) =>
      apiGet<ProjectsResponse>('/api/projects', signal).then((r) => {
        applyRegional(r.regional);
        return r;
      }),
    // Список обновляют своя правка и смена версии проектов, своего опроса нет.
    staleTime: Infinity,
  });
}

/** Проверка подключения среды: один запрос и кэш на среду, его же читают значок нескольких сред. */
export const connectionQuery = (project: string, env: string) => ({
  queryKey: keys.connection(project, env),
  queryFn: ({ signal }: { signal: AbortSignal }) => apiGet<ConnectionResponse>(`${envPath(project, env)}/connection`, signal),
  staleTime: 60_000,
});

export function useConnection(project: string, env: string) {
  return useQuery(connectionQuery(project, env));
}

export function useRecheck(project: string, env: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiGet<ConnectionResponse>(`${envPath(project, env)}/connection?refresh=1`),
    onSuccess: (data) => qc.setQueryData(keys.connection(project, env), data),
  });
}

export function useStands(project: string, env: string, enabled: boolean) {
  return useQuery({
    queryKey: keys.stands(project, env),
    queryFn: ({ signal }) => apiGet<StandsResponse>(`${envPath(project, env)}/stands`, signal),
    staleTime: 5 * 60_000,
    enabled,
  });
}

export function useStandLive(project: string, env: string, stand: string | undefined) {
  return useQuery({
    queryKey: keys.stand(project, env, stand ?? ''),
    queryFn: ({ signal }) => apiGet<StandResponse>(`${envPath(project, env)}/stands/${encodeURIComponent(stand!)}`, signal),
    staleTime: 5 * 60_000,
    enabled: !!stand,
  });
}
