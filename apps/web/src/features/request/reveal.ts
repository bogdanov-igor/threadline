// Показ скрытого и смена настройки при открытой странице. Состояние живёт в RequestContent: уход к другому
// запросу пересоздаёт компонент и сбрасывает показ сам.
import type { OpenRecord, RevealResponse, RequestDetail } from '@threadline/core/search';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { whenSessionExpires } from '@/features/auth/session.ts';
import { afterMaskingChange, useCatalogState } from '@/features/catalog/queries.ts';
import { isNocid } from '@/features/operation/model.ts';
import { ApiError, apiGet } from '@/lib/api.ts';
import { revealPartial, type RevealOverlay } from './overlay.ts';

export { revealPartial, RevealContext, withRevealed, type RevealOverlay } from './overlay.ts';

export const REVEAL_KEY = ['mask-reveal'] as const;

export interface RevealArgs {
  project: string;
  env: string;
  stand: string | null;
  cid: string;
  searchId: string | null;
  firstMs: number;
  lastMs: number;
}

export type RevealStatus = 'off' | 'loading' | 'on' | 'failed';

export interface Reveal {
  status: RevealStatus;
  overlay: RevealOverlay | null;
  /** Не все записи страницы нашлись в ответе показа. */
  partial: boolean;
  error: unknown;
  toggle(): void;
  /** Снять показ без нажатия: идущий запрос отменён, значения удалены из памяти страницы. */
  off(): void;
}

const enc = encodeURIComponent;

/** Показ из задания, а если его уже нет — чтение окна запроса по границам сводки. Сегмент без correlation_id по ссылке не прочитать. */
export async function fetchReveal(a: RevealArgs, signal?: AbortSignal): Promise<RevealResponse> {
  if (a.searchId) {
    try {
      // Среда строки: у поиска по нескольким средам по ней выбирается часть, у поиска одной среды сервер её не читает.
      return await apiGet<RevealResponse>(`/api/searches/${enc(a.searchId)}/requests/${enc(a.cid)}/reveal?env=${enc(a.env)}`, signal);
    } catch (e) {
      if (!(e instanceof ApiError && e.code === 'search-expired') || isNocid(a.cid)) throw e;
    }
  }
  const qs = new URLSearchParams({ from: String(a.firstMs), to: String(a.lastMs), ...(a.stand ? { stand: a.stand } : {}) });
  return apiGet<RevealResponse>(`/api/projects/${enc(a.project)}/envs/${enc(a.env)}/requests/${enc(a.cid)}/reveal?${qs}`, signal);
}

// Счётчик сбросов: смена настройки снимает показ на всех открытых страницах.
let epoch = 0;
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};
const readEpoch = () => epoch;

/** Снять показ: значения уходят из памяти, следующий показ — новый запрос. */
export function dropReveal(qc: QueryClient): void {
  epoch++;
  for (const fn of listeners) fn();
  qc.removeQueries({ queryKey: REVEAL_KEY });
}

export function useReveal(a: RevealArgs, records: readonly { id: string }[]): Reveal {
  const qc = useQueryClient();
  const [on, setOn] = useState(false);
  const seen = useSyncExternalStore(subscribe, readEpoch, readEpoch);
  const first = useRef(seen);
  useEffect(() => {
    if (first.current !== seen) setOn(false);
    first.current = seen;
  }, [seen]);
  // Сессия кончилась: показ снят сразу, даже если страница остаётся ради несохранённой формы.
  useEffect(() => whenSessionExpires(() => hideOpenValues(qc)), [qc]);
  // Страница могла бы восстановиться из кэша возврата браузера с открытыми значениями.
  useEffect(() => {
    const hide = () => {
      setOn(false);
      qc.removeQueries({ queryKey: REVEAL_KEY });
    };
    window.addEventListener('pagehide', hide);
    return () => {
      window.removeEventListener('pagehide', hide);
      qc.removeQueries({ queryKey: REVEAL_KEY });
    };
  }, [qc]);
  const q = useQuery({
    queryKey: [...REVEAL_KEY, a.searchId, a.env, a.cid, a.firstMs, a.lastMs],
    queryFn: ({ signal }) => fetchReveal(a, signal),
    enabled: on,
    gcTime: 0,
    staleTime: Infinity,
    retry: false,
  });
  const overlay = useMemo<RevealOverlay | null>(() => (on && q.data ? new Map<string, OpenRecord>(q.data.records.map((r) => [r.id, r])) : null), [on, q.data]);
  const status: RevealStatus = !on ? 'off' : q.isFetching ? 'loading' : q.isError ? 'failed' : q.data ? 'on' : 'loading';
  const refetch = q.refetch;
  const toggle = useCallback(() => {
    if (status === 'loading') return;
    if (status === 'failed') void refetch();
    else if (status === 'on') {
      setOn(false);
      qc.removeQueries({ queryKey: REVEAL_KEY });
    } else setOn(true);
  }, [status, refetch, qc]);
  const off = useCallback(() => {
    setOn(false);
    qc.removeQueries({ queryKey: REVEAL_KEY });
  }, [qc]);
  return { status, overlay, partial: revealPartial(records, overlay), error: q.error, toggle, off };
}

/** Изменился ли отпечаток настройки хотя бы одного проекта. Первый ответ ничего не сбрасывает. */
export function stampsChanged(was: Record<string, string> | null, now: Record<string, string>): boolean {
  if (was === null) return false;
  const keys = new Set([...Object.keys(was), ...Object.keys(now)]);
  return [...keys].some((k) => was[k] !== now[k]);
}

/** Записи кэша без открытых значений: панели сразу показывают маску, шаг и вкладка остаются. */
export function stripOpen(d: RequestDetail): RequestDetail {
  if (!d.records.some((r) => r.open)) return d;
  return { ...d, records: d.records.map(({ open: _open, ...r }) => r) };
}

/** Показ снят, открытых значений нет и в кэше страницы: панели сразу показывают маску. */
export function hideOpenValues(qc: QueryClient): void {
  dropReveal(qc);
  qc.setQueriesData<RequestDetail>({ queryKey: ['search-request'] }, (d) => (d ? stripOpen(d) : d));
  qc.setQueriesData<RequestDetail>({ queryKey: ['request-link'] }, (d) => (d ? stripOpen(d) : d));
}

export async function applyMaskingChange(qc: QueryClient): Promise<void> {
  hideOpenValues(qc);
  await afterMaskingChange(qc);
}

/** Сравнивает отпечатки двух опросов подряд. Опрос раз в 60 с, пока вкладка видна, и только к серверу Threadline. */
export function useMaskingWatch(): void {
  const qc = useQueryClient();
  const stamps = useCatalogState().data?.masking;
  const prev = useRef<Record<string, string> | null>(null);
  useEffect(() => {
    if (!stamps) return;
    const was = prev.current;
    prev.current = stamps;
    if (stampsChanged(was, stamps)) void applyMaskingChange(qc);
  }, [stamps, qc]);
}
