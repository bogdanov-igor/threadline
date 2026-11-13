import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { searchKeys } from '@/features/search/queries.ts';
import { apiGet } from '@/lib/api.ts';
import { type CatalogResponse, type DeleteResult, type Dependents, type DraftOf, type MaskingEditBody, type MaskingSaved, ROW_PATH, type RowKind, type RowOf, type UnknownKind, type UnknownPage, type UnknownRow } from '@threadline/core/catalog';
import type { CatalogState, SearchState } from '@threadline/core/search';
import { catalogBase, catalogErrorCode, catalogGet, catalogSend } from './api.ts';

export const catalogKeys = {
  state: ['catalog-state'] as const,
  snapshot: (p: string) => ['catalog', p] as const,
  unknown: (p: string, f: UnknownFilter) => ['catalog-unknown', p, f.kind, f.env, f.hidden] as const,
  unknownAll: (p: string) => ['catalog-unknown', p] as const,
  dependents: (p: string, kind: 'system' | 'method', id: number) => ['catalog-dependents', p, kind, id] as const,
};

/** Состояние справочника: раз в 60 с и только к серверу Threadline. */
export function useCatalogState() {
  return useQuery({
    queryKey: catalogKeys.state,
    queryFn: ({ signal }) => catalogGet<CatalogState>('/api/catalog', signal),
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: false,
  });
}

/** Справочник проекта целиком: сервер отдаёт его из памяти. */
export function useCatalog(project: string, enabled = true, refreshOnReturn = false) {
  return useQuery({
    queryKey: catalogKeys.snapshot(project),
    queryFn: ({ signal }) => catalogGet<CatalogResponse>(catalogBase(project), signal),
    staleTime: 30_000,
    enabled,
    retry: false,
    // Открытая форма: тип заводят в другой вкладке, при возврате список уже с ним. Логи не читаются.
    refetchOnWindowFocus: refreshOnReturn ? 'always' : false,
  });
}

export interface UnknownFilter {
  kind: UnknownKind | 'all';
  env: string;
  hidden: boolean;
}

export function useUnknown(project: string, f: UnknownFilter, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: catalogKeys.unknown(project, f),
    queryFn: ({ pageParam, signal }) => {
      const qs = new URLSearchParams({
        ...(f.kind !== 'all' ? { kind: f.kind } : {}),
        ...(f.env ? { env: f.env } : {}),
        ...(f.hidden ? { hidden: '1' } : {}),
        ...(pageParam ? { offset: String(pageParam) } : {}),
      });
      return catalogGet<UnknownPage>(`${catalogBase(project)}/unknown${qs.size ? `?${qs}` : ''}`, signal);
    },
    initialPageParam: 0,
    // Следующая страница — со смещения после последней загруженной, пока не достигнут total.
    getNextPageParam: (last) => {
      const next = last.offset + last.items.length;
      return last.items.length > 0 && next < last.total ? next : undefined;
    },
    staleTime: 30_000,
    enabled,
    retry: false,
  });
}

export function useDependents(project: string, kind: 'system' | 'method', id: number, enabled: boolean) {
  return useQuery({
    queryKey: catalogKeys.dependents(project, kind, id),
    queryFn: ({ signal }) => catalogGet<Dependents>(`${catalogBase(project)}/${ROW_PATH[kind]}/${id}/dependents`, signal),
    enabled,
    staleTime: 0,
    retry: false,
  });
}

/**
 * Открытые результаты и запросы после правки: названия ставит сервер при выдаче, Loki не читается.
 * Список результатов дописывается с индекса from, поэтому он перечитывается с начала и заменяется целиком.
 */
export async function refreshResults(qc: QueryClient): Promise<void> {
  const states = qc.getQueriesData<SearchState>({ queryKey: ['search'] });
  await Promise.all(
    states.map(async ([key, data]) => {
      const id = key[1];
      if (!data || typeof id !== 'string' || !id) return;
      try {
        qc.setQueryData(searchKeys.state(id), await apiGet<SearchState>(`/api/searches/${encodeURIComponent(id)}?from=0`));
      } catch {
        // Задание истекло — названия обновятся при следующем поиске.
      }
    }),
  );
  await qc.invalidateQueries({ queryKey: ['search-request'] });
  await qc.invalidateQueries({ queryKey: ['request-link'] });
}

export async function afterCatalogChange(qc: QueryClient, project: string): Promise<void> {
  await Promise.all([
    qc.invalidateQueries({ queryKey: catalogKeys.snapshot(project) }),
    qc.invalidateQueries({ queryKey: catalogKeys.unknownAll(project) }),
    // Отпечаток настройки маскирования: своя правка идёт тем же путём, что чужая, только сразу.
    qc.invalidateQueries({ queryKey: catalogKeys.state }),
    refreshResults(qc),
  ]);
}

/**
 * Настройка маскирования изменилась: страницы «Всех записей» сбрасываются (invalidate перечитал бы из Loki все загруженные,
 * сброс — только первую и только при показе вкладки), запросы и состояние поиска перечитываются.
 */
export async function afterMaskingChange(qc: QueryClient): Promise<void> {
  await qc.resetQueries({ queryKey: ['search-lines'] });
  await refreshResults(qc);
}

export interface SaveArgs {
  kind: RowKind;
  id?: number;
  updatedAt?: string;
  draft: DraftOf[RowKind] & { hidden?: boolean };
}

/**
 * Запись изменили или удалили в другом месте: справочник в браузере устарел. Перечитывается до показа сообщения, иначе
 * «Создать заново» упрётся в проверку повтора по уже удалённой записи, а ссылка на чужой повтор никуда не приведёт.
 */
function refreshOnStale(qc: QueryClient, project: string, e: unknown): Promise<void> | undefined {
  const code = catalogErrorCode(e);
  return code === 'catalog-not-found' || code === 'catalog-conflict' || code === 'catalog-duplicate'
    ? qc.invalidateQueries({ queryKey: catalogKeys.snapshot(project) })
    : undefined;
}

/** Создание и правка записи. Правка несёт updatedAt: сервер отклонит устаревшую. */
export function useSaveRow(project: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: SaveArgs): Promise<RowOf[RowKind]> => {
      const base = `${catalogBase(project)}/${ROW_PATH[a.kind]}`;
      return a.id === undefined ? catalogSend('POST', base, a.draft) : catalogSend('PUT', `${base}/${a.id}`, { ...a.draft, updatedAt: a.updatedAt });
    },
    onSuccess: () => afterCatalogChange(qc, project),
    onError: (e) => refreshOnStale(qc, project, e),
  });
}

/** Возврат скрытой записи: та же правка с hidden: false. */
export function useRestoreRow(project: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { kind: RowKind; row: RowOf[RowKind] }) => {
      const { id, updatedAt, seedKey: _s, edited: _e, hidden: _h, ...draft } = a.row;
      return catalogSend<RowOf[RowKind]>('PUT', `${catalogBase(project)}/${ROW_PATH[a.kind]}/${id}`, { ...draft, hidden: false, updatedAt });
    },
    onSuccess: () => afterCatalogChange(qc, project),
    onError: (e) => refreshOnStale(qc, project, e),
  });
}

export function useDeleteRow(project: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { kind: RowKind; id: number; updatedAt: string; permanent?: boolean }) =>
      catalogSend<DeleteResult>('DELETE', `${catalogBase(project)}/${ROW_PATH[a.kind]}/${a.id}?updatedAt=${encodeURIComponent(a.updatedAt)}${a.permanent ? '&permanent=1' : ''}`),
    onSuccess: () => afterCatalogChange(qc, project),
    onError: (e) => refreshOnStale(qc, project, e),
  });
}

/** Правка вида маскирования: вид целиком, updatedAt защищает от одновременной правки. */
export function useSaveMasking(project: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { type: string; body: MaskingEditBody }) => catalogSend<MaskingSaved>('PUT', `${catalogBase(project)}/masking/${encodeURIComponent(a.type)}`, a.body),
    onSuccess: () => afterCatalogChange(qc, project),
    onError: (e) => refreshOnStale(qc, project, e),
  });
}

export function useHideUnknown(project: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { row: UnknownRow; hidden: boolean }) => catalogSend<UnknownRow>('PUT', `${catalogBase(project)}/unknown/${a.row.id}`, { hidden: a.hidden }),
    // Состояние несёт счётчик «Неизвестного»: значок и число раздела меняются сразу.
    onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: catalogKeys.unknownAll(project) }), qc.invalidateQueries({ queryKey: catalogKeys.state })]),
  });
}

