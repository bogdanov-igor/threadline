// Режим страницы короткой ссылки и источник данных задания. В главном чанке: их читают страницы результатов, запроса и операции.
// На обычных страницах режима нет, а источник зовёт прежние адреса.
import type { ShareKind } from '@threadline/core';
import type { LinesPageResponse, RequestDetail, SearchState } from '@threadline/core/search';
import { createContext, useContext } from 'react';
import { apiGet } from '@/lib/api.ts';

const enc = encodeURIComponent;

/** Эта вкладка: сервер не останавливает задание, пока его опрашивает другая. */
export const VIEWER = Math.random().toString(36).slice(2, 14) + Date.now().toString(36);

/** Откуда страницы берут задание. id — идентификатор задания, на странице ссылки — самой ссылки: идентификатор задания наружу не отдаётся. */
export interface JobSource {
  state(id: string, from: number, signal?: AbortSignal): Promise<SearchState>;
  /** env — среда строки: у поиска по нескольким средам обязательна, у поиска одной среды сервер её не читает. */
  request(id: string, cid: string, signal?: AbortSignal, env?: string): Promise<RequestDetail>;
  lines(id: string, cursor: string | null, signal?: AbortSignal, env?: string): Promise<LinesPageResponse>;
}

/** Строка запроса: курсор и среда, пустые не пишутся. */
const query = (parts: Record<string, string | null | undefined>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(parts)) if (v) q.set(k, v);
  const s = q.toString();
  return s ? `?${s}` : '';
};

const JOBS: JobSource = {
  state: (id, from, signal) => apiGet<SearchState>(`/api/searches/${enc(id)}?from=${from}&viewer=${VIEWER}`, signal),
  request: (id, cid, signal, env) => apiGet<RequestDetail>(`/api/searches/${enc(id)}/requests/${enc(cid)}${query({ env })}`, signal),
  lines: (id, cursor, signal, env) => apiGet<LinesPageResponse>(`/api/searches/${enc(id)}/lines${query({ cursor, env })}`, signal),
};

/** Источник страницы ссылки: только открытая поверхность /api/s/*. */
export const LINK_SOURCE: JobSource = {
  state: (id, from, signal) => apiGet<SearchState>(`/api/s/${enc(id)}/state?from=${from}`, signal),
  request: (id, cid, signal, env) => apiGet<RequestDetail>(`/api/s/${enc(id)}/requests/${enc(cid)}${query({ env })}`, signal),
  lines: (id, cursor, signal, env) => apiGet<LinesPageResponse>(`/api/s/${enc(id)}/lines${query({ cursor, env })}`, signal),
};

export const JobSourceContext = createContext<JobSource>(JOBS);
export const useJobSource = () => useContext(JobSourceContext);

export interface ShareMode {
  id: string;
  kind: ShareKind;
  /** Только у ссылки на операцию: её адрес внутри ссылки. Значение из описания ссылки, а не из адресной строки. */
  operation?: { type: string; value: string } | null;
}

/** null — обычная страница. Режим отключает поле поиска, действия задания, показ, действия справочника и опросы. */
export const ShareModeContext = createContext<ShareMode | null>(null);
export const useShareMode = () => useContext(ShareModeContext);

/** Откуда открыт запрос: только для заготовки до ответа. Значений здесь нет, сам запрос назван адресом. */
export interface ShareRequestState {
  shareRequest: { status: 'error' | 'success' | null };
}

export const sharePath = (mode: ShareMode) => `/s/${mode.id}`;

/** Адрес операции внутри ссылки. Только у ссылки на операцию, у остальных корень ссылки. */
export const shareOperationPath = (mode: ShareMode) => (mode.operation ? `${sharePath(mode)}/operations/${enc(mode.operation.type)}/${enc(mode.operation.value)}` : sharePath(mode));

/** Запрос из списка: /s/<id>/requests/<cid>, у ссылки на несколько сред ещё ?env=. Поток операции: адрес операции и сам поток параметром, адрес можно переслать. */
export const shareRequestLink = (mode: ShareMode, r: { cid: string; env?: string | undefined; segment?: number | null | undefined; step?: string | null | undefined; status?: 'error' | 'success' | undefined }): { to: string; state: ShareRequestState } => {
  const state: ShareRequestState = { shareRequest: { status: r.status ?? null } };
  if (!mode.operation) return { to: `${sharePath(mode)}/requests/${enc(r.cid)}${r.env ? `?env=${enc(r.env)}` : ''}`, state };
  const query = new URLSearchParams({ flow: r.cid });
  if (r.segment !== null && r.segment !== undefined) query.set('segment', String(r.segment));
  if (r.step) query.set('step', r.step);
  return { to: `${shareOperationPath(mode)}?${query.toString()}`, state };
};
