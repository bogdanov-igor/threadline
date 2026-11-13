// Проверка входа над роутером: пока нет ответа, видна заготовка, запросов данных нет.
import type { AuthMe } from '@threadline/core/access';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Brand } from '@/components/shell/Logo.tsx';
import { GUTTERS } from '@/components/shell/Page.tsx';
import { PageSkeleton } from '@/components/states/PageSkeleton.tsx';
import { isApiError } from '@/lib/api.ts';
import { queryClient } from '@/lib/queries.ts';
import { cn } from '@/lib/utils.ts';
import { AccessContext, accessOf, useMe } from './access.tsx';
import { hasUnsavedInput, sessionConfirmed, useSessionProblem, type SessionProblem } from './session.ts';
import { ExpiredDialogLazy, ScreenLazy } from './slot.tsx';

export type PublicScreen = 'auth-error' | 'logged-out' | 'auth-done';
const PUBLIC_SCREENS: readonly PublicScreen[] = ['auth-error', 'logged-out', 'auth-done'];
export const publicScreen = (path: string): PublicScreen | null => PUBLIC_SCREENS.find((s) => path === `/${s}`) ?? null;

export type GateView = { kind: 'wait' } | { kind: 'lost' } | { kind: 'no-access' } | { kind: 'app' };

/** Что показать: без роли «Нет доступа» на каждой странице, сбой сервера — обычное сообщение страницы, а не экран входа. */
export function gateView(me: { data: AuthMe | undefined; unauthenticated: boolean; failed: boolean }, problem: SessionProblem): GateView {
  if (problem === 'lost') return { kind: 'lost' };
  if (me.data) return me.data.role === null ? { kind: 'no-access' } : { kind: 'app' };
  // 401 уже ведёт браузер на вход: данных на экране нет.
  if (me.unauthenticated || !me.failed) return { kind: 'wait' };
  return { kind: 'app' };
}

/** Сервер недоступен: прав нет, страница покажет своё сообщение. */
const NO_ANSWER: AuthMe = { mode: 'on', user: { name: null }, role: null, capabilities: [] };

/** Кто вошёл: при смене человека или роли данные прежнего уходят из памяти. */
const identity = (me: AuthMe) => `${me.role ?? ''}|${me.user.name ?? ''}`;

/** Проверка сессии: блок Threadline на месте шапки, данных других страниц нет. Шапка приложения встаёт на то же место без скачка. */
function SessionCheck() {
  return (
    <div className="flex min-h-dvh flex-col">
      <div className={cn('flex h-14 shrink-0 items-center border-b border-border', GUTTERS)}>
        <Brand />
      </div>
      <PageSkeleton />
    </div>
  );
}

function SignedInGate({ children }: { children: ReactNode }) {
  const me = useMe();
  const problem = useSessionProblem();
  const seen = useRef<string | null>(null);
  const [checking, setChecking] = useState(false);
  const data = me.data;

  useEffect(() => {
    if (!data) return;
    sessionConfirmed();
    const who = identity(data);
    const before = seen.current;
    seen.current = who;
    if (before === null || before === who) return;
    // Несохранённый ввод остаётся, кнопок просто становится меньше: страницу перечитает следующая навигация.
    queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== 'auth' });
    if (!hasUnsavedInput()) window.location.reload();
  }, [data]);

  // Страница из кэша возврата: сессия проверяется сразу, а данные не показываются, пока нет ответа.
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => {
      if (!e.persisted) return;
      setChecking(true);
      void me.refetch().finally(() => setChecking(false));
    };
    window.addEventListener('pageshow', onShow);
    return () => window.removeEventListener('pageshow', onShow);
  }, [me]);

  const access = useMemo(() => accessOf(data ?? NO_ANSWER), [data]);
  // Ответа ещё не было, а сбой уже был: новый запрос (его зовёт любая смонтированная страница) снимает ошибку на время запроса,
  // и без этого страница по кругу возвращалась бы к заготовке. Так сервер недоступен и без сети: страница показывает свой сбой.
  const failed = me.isError || (data === undefined && me.errorUpdatedAt > 0);
  const view = gateView({ data, unauthenticated: isApiError(me.error, 'unauthenticated'), failed }, problem);
  if (checking || view.kind === 'wait') return <SessionCheck />;
  if (view.kind === 'lost') return <ScreenLazy screen="lost" />;
  if (view.kind === 'no-access') return <ScreenLazy screen="no-access" name={data?.user.name ?? null} />;
  return (
    <AccessContext.Provider value={access}>
      {children}
      {problem === 'expired' && <ExpiredDialogLazy />}
    </AccessContext.Provider>
  );
}

/** Экраны без сессии работают без списка проектов и запросов данных. */
export function AuthGate({ children }: { children: ReactNode }) {
  const screen = publicScreen(window.location.pathname);
  if (screen) return <ScreenLazy screen={screen} />;
  return <SignedInGate>{children}</SignedInGate>;
}
