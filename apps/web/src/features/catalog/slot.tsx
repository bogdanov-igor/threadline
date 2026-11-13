// Зона «Проект» грузится лениво, как страницы проектов: шапка видна сразу, сбой загрузки чанка показывает экран ошибки маршрута.
import { lazy, Suspense } from 'react';
import { PageSkeleton } from '@/components/states/PageSkeleton.tsx';
import { useAccess } from '@/features/auth/access.tsx';
import { SectionClosedLazy } from '@/features/auth/slot.tsx';
import { loadBundle } from '@/i18n/bundles.ts';

// Строки проектов нужны зоне для сообщений о настройках: страницы настроек грузят их ещё раз сами, это дешёвая повторная запись в тот же раздел.
const CatalogRoute = lazy(() =>
  Promise.all([loadBundle('catalog'), loadBundle('projects')])
    .then(() => import('./CatalogPage.tsx'))
    .then((m) => ({ default: m.CatalogRoute })),
);

export function CatalogSlot() {
  // Закрытая страница по адресу: запросов данных этой страницы нет.
  if (!useAccess().can('details')) return <SectionClosedLazy />;
  return (
    <Suspense fallback={<PageSkeleton />}>
      <CatalogRoute />
    </Suspense>
  );
}
