// Запросы к API справочника: правка с PUT, тела YAML и JSON, ошибки с данными (свежая запись, повтор, отчёт).
import { ApiError, noteAccess, type ClientErrorCode } from '@/lib/api.ts';
import type { CatalogErrorBody, CatalogErrorCode, CatalogErrorExtra, ImportReport } from '@threadline/core/catalog';

export type CatalogClientCode = ClientErrorCode | CatalogErrorCode;

/** Ошибка API справочника: код и данные ответа сверх кода. */
export class CatalogApiError extends ApiError {
  readonly extra: CatalogErrorExtra;

  constructor(code: CatalogClientCode, status: number, details: string | undefined, extra: CatalogErrorExtra) {
    super(code as ClientErrorCode, status, details);
    this.extra = extra;
  }
}

export const isCatalogError = (e: unknown, code?: CatalogClientCode): e is CatalogApiError =>
  e instanceof CatalogApiError && (code === undefined || e.code === code);

/** Код ошибки справочника у любой ошибки запроса. */
export function catalogErrorCode(e: unknown): CatalogClientCode | null {
  return e instanceof ApiError ? (e.code as CatalogClientCode) : null;
}

const enc = encodeURIComponent;
export const catalogBase = (project: string) => `/api/projects/${enc(project)}/catalog`;

/** Данные ошибки из тела { error: { code, ...CatalogErrorExtra } }. */
function readExtra(body: Partial<CatalogErrorBody> | null): { code: string | undefined; details: string | undefined; extra: CatalogErrorExtra } {
  const err: Partial<CatalogErrorBody['error']> = body?.error && typeof body.error === 'object' ? body.error : {};
  const { code, details, ...extra } = err;
  return { code: typeof code === 'string' ? code : undefined, details: typeof details === 'string' ? details : undefined, extra };
}

export async function send(path: string, init: RequestInit): Promise<Response> {
  try {
    const res = await fetch(path, init);
    noteAccess(res.status);
    return res;
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e;
    throw new CatalogApiError('server-unreachable', 0, undefined, {});
  }
}

async function parse<T>(res: Response): Promise<T> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    if (res.ok) throw new CatalogApiError('bad-response', res.status, undefined, {});
    // Прокси разработки отвечает не JSON, когда сервер Threadline лежит.
    if (res.status >= 500 || res.status === 0) throw new CatalogApiError(res.status === 503 ? 'catalog-unavailable' : 'server-unreachable', res.status, undefined, {});
    if (res.status === 413) throw new CatalogApiError('catalog-file-too-large', res.status, undefined, {});
    throw new CatalogApiError('bad-response', res.status, undefined, {});
  }
  if (!res.ok) {
    const { code, details, extra } = readExtra(body as Partial<CatalogErrorBody> | null);
    throw new CatalogApiError((code ?? (res.status === 503 ? 'catalog-unavailable' : 'unknown')) as CatalogClientCode, res.status, details, extra);
  }
  return body as T;
}

export async function catalogGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  return parse<T>(await send(path, { headers: { Accept: 'application/json' }, ...(signal ? { signal } : {}) }));
}

/** Правка с телом JSON. */
export async function catalogSend<T>(method: 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const res = await send(path, {
    method,
    headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 204) return {} as T;
  return parse<T>(res);
}

/** JSON без списков отчёта, например ответ прокси, — непонятный ответ: страница не должна падать на экран ошибки. */
export function isReport(v: unknown): v is ImportReport {
  const r = v as Partial<ImportReport> | null | undefined;
  return [r?.added, r?.changed, r?.hidden, r?.skipped, r?.errors].every((x) => Array.isArray(x));
}

export const parseResponse = parse;

export const SCHEMA_URL = '/api/catalog/schema';
