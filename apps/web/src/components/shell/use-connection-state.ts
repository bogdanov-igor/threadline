import type { ConnectionResponse } from '@threadline/core';
import { useQueries, type UseQueryResult } from '@tanstack/react-query';
import { ApiError } from '@/lib/api.ts';
import { connectionQuery, useRecheck } from '@/lib/queries.ts';
import { toneOf, type IndicatorStatus } from './status.ts';

function statusOf(query: Pick<UseQueryResult<ConnectionResponse>, 'isPending' | 'data' | 'error'>, recheck: { isPending: boolean; isError: boolean; error: unknown } | null): IndicatorStatus {
  if (recheck?.isPending || query.isPending) return 'checking';
  if (query.data && !recheck?.isError) return query.data.status;
  const err = recheck?.error ?? query.error;
  return err instanceof ApiError && err.code === 'server-unreachable' ? 'server-unreachable' : 'unknown';
}

/** Чем хуже состояние, тем больше: ошибка, предупреждение, проверка, подключено, демо. */
const RANK = { danger: 4, warning: 3, neutral: 2, success: 1, demo: 0 } as const;
const rank = (s: IndicatorStatus) => RANK[toneOf(s)];

/**
 * Состояние подключения среды для индикатора и карточки. Компонент с ним ключуется по среде.
 * Несколько сред: худшее среди них, подробности и повторная проверка — у этой среды. Сервер кэширует проверку по хранилищу.
 */
export function useConnectionState(project: string, envs: string | readonly string[]) {
  const ids = typeof envs === 'string' ? [envs] : envs;
  const queries = useQueries({ queries: ids.map((env) => connectionQuery(project, env)) });
  // Худшая среда без учёта повторной проверки: иначе её ход перекидывал бы окно на другую среду.
  let worst = 0;
  for (let i = 1; i < ids.length; i++) if (rank(statusOf(queries[i]!, null)) > rank(statusOf(queries[worst]!, null))) worst = i;
  const env = ids[worst]!;
  const recheck = useRecheck(project, env);
  const query = queries[worst]!;
  return { status: statusOf(query, recheck), data: query.data, env, recheck: () => recheck.mutate(), rechecking: recheck.isPending };
}
