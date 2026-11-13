// Запросы API проектов: PUT и ошибки с данными (поля, свежая запись).
import type { MessageRef, ProjectErrorBody, ProjectErrorCode } from '@threadline/core';
import { ApiError, noteAccess, type ClientErrorCode } from '@/lib/api.ts';
import { fieldText } from '@/lib/server-text.ts';

export type ProjectClientCode = ClientErrorCode | ProjectErrorCode;

/** Ошибка API проектов: код и данные ответа сверх кода. */
export class ProjectApiError extends ApiError {
  readonly fields: Record<string, string>;
  readonly fieldKeys: Record<string, MessageRef>;
  readonly current: ProjectErrorBody['error']['current'];

  constructor(code: ProjectClientCode, status: number, body?: Partial<ProjectErrorBody['error']>) {
    super(code as ClientErrorCode, status, body?.details);
    this.fields = body?.fields ?? {};
    this.fieldKeys = body?.fieldKeys ?? {};
    this.current = body?.current;
  }
}

/** Сообщения полей на языке интерфейса: путь поля → текст. */
export const fieldTexts = (e: ProjectApiError): Record<string, string> =>
  Object.fromEntries(Object.entries(e.fields).map(([path, message]) => [path, fieldText({ message, ...e.fieldKeys[path] })]));

export const projectErrorCode = (e: unknown): ProjectClientCode | null => (e instanceof ApiError ? (e.code as ProjectClientCode) : null);

export async function projectSend<T>(method: 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown, signal?: AbortSignal): Promise<T | null> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(signal ? { signal } : {}),
    });
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e;
    throw new ProjectApiError('server-unreachable', 0);
  }
  noteAccess(res.status);
  if (res.status === 204) return null;
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    if (res.ok) throw new ProjectApiError('bad-response', res.status);
    // Прокси разработки отвечает не JSON, когда сервер Threadline лежит.
    throw new ProjectApiError(res.status >= 500 ? 'server-unreachable' : 'bad-response', res.status);
  }
  if (res.ok) return parsed as T;
  const err = (parsed as Partial<ProjectErrorBody> | null)?.error;
  throw new ProjectApiError(err?.code ?? (res.status === 503 ? 'project-readonly' : 'unknown'), res.status, err);
}

export const enc = encodeURIComponent;
