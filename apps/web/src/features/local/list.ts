// Список хранилищ локального режима. Его читает и призыв на стартовой странице из главного чанка: здесь только чтение,
// без правок и страниц проектов, чтобы они не попадали в общий код.
import type { LocalStoragesResponse } from '@threadline/core';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@/lib/api.ts';

export const storagesKey = ['local-storages'] as const;

export function useLocalStorages(enabled = true) {
  return useQuery({
    queryKey: storagesKey,
    queryFn: ({ signal }) => apiGet<LocalStoragesResponse>('/api/local/storages', signal),
    staleTime: 10_000,
    enabled,
  });
}
