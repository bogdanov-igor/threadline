// Экраны входа, меню пользователя и окно истёкшей сессии грузятся лениво: главный чанк от них почти не растёт.
import { lazy, Suspense } from 'react';
import { PageSkeleton } from '@/components/states/PageSkeleton.tsx';
import { loadBundle } from '@/i18n/bundles.ts';
import type { AuthScreenName } from './screens.tsx';

const parts = () => loadBundle('auth').then(() => import('./screens.tsx'));
const Screen = lazy(() => parts().then((m) => ({ default: m.AuthScreen })));
const Expired = lazy(() => parts().then((m) => ({ default: m.ExpiredDialog })));
const Menu = lazy(() => parts().then((m) => ({ default: m.UserMenu })));
const Closed = lazy(() => parts().then((m) => ({ default: m.SectionClosed })));

export function ScreenLazy({ screen, name = null }: { screen: AuthScreenName; name?: string | null }) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Screen screen={screen} name={name} />
    </Suspense>
  );
}

export function ExpiredDialogLazy() {
  return (
    <Suspense fallback={null}>
      <Expired />
    </Suspense>
  );
}

/** Место занято, пока грузится меню: его появление шапку не сдвигает. Кнопка профиля одной ширины с входом и без. */
export function UserMenuLazy() {
  return (
    <Suspense fallback={<span aria-hidden className="inline-block h-[34px] w-[55px] shrink-0" data-testid="user-menu-placeholder" />}>
      <Menu />
    </Suspense>
  );
}

/** Закрытая для роли страница по прямому адресу: запросов данных этой страницы нет. */
export function SectionClosedLazy({ toProjects = false }: { toProjects?: boolean }) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Closed toProjects={toProjects} />
    </Suspense>
  );
}
