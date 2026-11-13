// Хранилища локального режима: список, проверка, сохранение, удаление. Токен уходит только в запросе, обратно приходит «задан».
import type { LocalStorageErrorBody, LocalStorageInfo, LocalStorageInput, ProbeResponse } from '@threadline/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { settingsKey } from '@/features/projects/queries.ts';
import { noteAccess } from '@/lib/api.ts';
import { keys } from '@/lib/queries.ts';
import { storagesKey } from './list.ts';

export { storagesKey, useLocalStorages } from './list.ts';

/** Ошибка API хранилищ: код и сообщения полей с сервера. */
export class StorageApiError extends Error {
  readonly code: LocalStorageErrorBody['error']['code'] | 'failed';
  readonly fields: Record<string, string>;
  constructor(code: StorageApiError['code'], fields: Record<string, string> = {}) {
    super(code);
    this.name = 'StorageApiError';
    this.code = code;
    this.fields = fields;
  }
}

async function send<T>(method: 'POST' | 'DELETE', path: string, body?: unknown, signal?: AbortSignal): Promise<T | null> {
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
    throw new StorageApiError('failed');
  }
  noteAccess(res.status);
  if (res.status === 204) return null;
  const parsed = (await res.json().catch(() => null)) as unknown;
  if (res.ok) return parsed as T;
  const err = (parsed as Partial<LocalStorageErrorBody> | null)?.error;
  throw new StorageApiError(err?.code ?? 'failed', err?.fields ?? {});
}

export const checkStorage = (input: LocalStorageInput, signal?: AbortSignal) => send<ProbeResponse>('POST', '/api/local/storages/check', input, signal);

/** После правки: список хранилищ, страницы проектов и шапка читают заново. */
function useAfterChange() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: storagesKey });
    void qc.invalidateQueries({ queryKey: settingsKey });
    void qc.invalidateQueries({ queryKey: keys.projects });
  };
}

export function useSaveStorage() {
  const after = useAfterChange();
  return useMutation({ mutationFn: (input: LocalStorageInput) => send<LocalStorageInfo>('POST', '/api/local/storages', input), onSuccess: after });
}

export function useDeleteStorage() {
  const after = useAfterChange();
  return useMutation({ mutationFn: (id: string) => send<null>('DELETE', `/api/local/storages/${encodeURIComponent(id)}`), onSuccess: after });
}
