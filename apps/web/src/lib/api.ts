import type { ApiErrorBody, ApiErrorCode } from '@threadline/core';
import type { SearchErrorCode } from '@threadline/core/search';

export type ClientErrorCode = ApiErrorCode | SearchErrorCode | 'server-unreachable';

export class ApiError extends Error {
  readonly code: ClientErrorCode;
  readonly status: number;
  readonly details: string | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(code: ClientErrorCode, status: number, details?: string, retryAfterSeconds?: number) {
    super(code);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Реакция на отказ сервера: вход и роль (features/auth). 5xx и недоступный сервер концом сессии не считаются. */
export interface AccessEvents {
  unauthenticated: () => void;
  forbidden: () => void;
}
let accessEvents: AccessEvents | null = null;
export const setAccessEvents = (events: AccessEvents) => {
  accessEvents = events;
};
/** Зовут все, кто сам делает fetch к API. Статус 403 бывает только от таблицы доступа: отказ хранилища сервер отдаёт кодом 502. */
export function noteAccess(status: number): void {
  if (status === 401) accessEvents?.unauthenticated();
  else if (status === 403) accessEvents?.forbidden();
}

async function request(path: string, init: RequestInit): Promise<Response> {
  try {
    const res = await fetch(path, init);
    noteAccess(res.status);
    return res;
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e;
    throw new ApiError('server-unreachable', 0);
  }
}

async function parse<T>(res: Response): Promise<T> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    // Прокси разработки или балансировщик отвечает не JSON, когда сервер Threadline лежит.
    throw new ApiError(res.status >= 500 || res.status === 0 ? 'server-unreachable' : 'bad-response', res.status);
  }
  if (!res.ok) {
    const err = (body as { error?: ApiErrorBody['error'] & { code: ClientErrorCode } } | null)?.error;
    throw new ApiError(err?.code ?? 'unknown', res.status, err?.details, err?.retryAfterSeconds);
  }
  return body as T;
}

export async function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await request(path, { headers: { Accept: 'application/json' }, ...(signal ? { signal } : {}) });
  return parse<T>(res);
}

/** POST с телом JSON или DELETE. Ответ 204 — null. */
export async function apiSend<T>(method: 'POST' | 'DELETE', path: string, body?: unknown): Promise<T | null> {
  const res = await request(path, {
    method,
    headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 204) return null;
  return parse<T>(res);
}

/** Отказ таблицы доступа: статус 403 бывает только от неё, отказ хранилища сервер отдаёт кодом 502. */
export const isAccessDenied = (e: unknown): boolean => e instanceof ApiError && e.status === 403;

export const isApiError = (e: unknown, code?: ClientErrorCode): e is ApiError => e instanceof ApiError && (code === undefined || e.code === code);
