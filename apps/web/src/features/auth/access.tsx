// Сведения о входе и права в интерфейсе. Набор прав приходит с сервера: интерфейс только убирает кнопки, запрещает сервер.
import type { AuthMe, Capability, Role } from '@threadline/core/access';
import { useQuery } from '@tanstack/react-query';
import { createContext, useContext } from 'react';
import { apiGet } from '@/lib/api.ts';
import { ME_KEY } from './session.ts';

export const ME_POLL_MS = 60_000;

export interface Access {
  mode: AuthMe['mode'];
  name: string | null;
  role: Role | null;
  can: (capability: Capability) => boolean;
}

export const accessOf = (me: AuthMe): Access => ({
  mode: me.mode,
  name: me.user.name,
  role: me.role,
  can: (c) => me.capabilities.includes(c),
});

/** Вне AuthGate: модульные тесты страниц. На настоящих страницах значение всегда от сервера, сервер и так откажет. */
const OUTSIDE: Access = { mode: 'off', name: null, role: 'admin', can: () => true };

export const AccessContext = createContext<Access | null>(null);
export const useAccess = (): Access => useContext(AccessContext) ?? OUTSIDE;

/** Сведения о входе: раз в 60 секунд, пока вкладка видна. Смену роли страница узнаёт отсюда. */
export function useMe() {
  return useQuery({
    queryKey: ME_KEY,
    queryFn: ({ signal }) => apiGet<AuthMe>('/api/auth/me', signal),
    staleTime: 30_000,
    refetchInterval: ME_POLL_MS,
    refetchIntervalInBackground: false,
  });
}
