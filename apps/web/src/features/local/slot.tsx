// Локальный режим в ленивом чанке: на обычном сервере код и строки не грузятся, запросов к /api/local нет.
// Кроме призыва на стартовой странице и кнопки на странице сервиса: они маленькие, ленивая загрузка сдвигала бы страницу.
import { lazy, Suspense } from 'react';
import { PageSkeleton } from '@/components/states/PageSkeleton.tsx';
import { useAccess, useMe } from '@/features/auth/access.tsx';
import { SectionClosedLazy } from '@/features/auth/slot.tsx';
import { loadBundle } from '@/i18n/bundles.ts';
import Callout from './Callout.tsx';
import StoragesLink from './StoragesLink.tsx';

/** Локальный режим: сервер сказал это в /api/auth/me. На обычном сервере поля нет, маршрутов хранилищ тоже. */
export function useLocalMode(): boolean {
  return useMe().data?.local === true;
}

const StoragesPage = lazy(() => loadBundle('local').then(() => import('./StoragesPage.tsx')));

/** Страница /admin/storages. */
export function LocalStoragesSlot() {
  if (!useAccess().can('editSettings')) return <SectionClosedLazy />;
  return (
    <Suspense fallback={<PageSkeleton />}>
      <StoragesPage />
    </Suspense>
  );
}

/** Призыв подключить хранилище на стартовой странице: только в локальном режиме и только администратору. */
export function LocalStorageCallout() {
  const local = useLocalMode();
  const admin = useAccess().can('editSettings');
  if (!local || !admin) return null;
  return <Callout />;
}

/** Ссылка на подключение хранилищ на странице сервиса: только в локальном режиме. */
export function LocalStoragesLink() {
  const local = useLocalMode();
  const admin = useAccess().can('editSettings');
  if (!local || !admin) return null;
  return <StoragesLink />;
}
