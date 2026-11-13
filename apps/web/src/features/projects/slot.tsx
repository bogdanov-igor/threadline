// Страницы проектов грузятся лениво: шапка видна сразу, сбой загрузки чанка показывает экран ошибки маршрута.
import { lazy, Suspense } from 'react';
import { PageSkeleton } from '@/components/states/PageSkeleton.tsx';
import { useAccess } from '@/features/auth/access.tsx';
import { SectionClosedLazy } from '@/features/auth/slot.tsx';
import { loadBundle } from '@/i18n/bundles.ts';

const Pages = lazy(() => loadBundle('projects').then(() => import('./pages.tsx')));

export function ProjectsSlot({ page }: { page: 'list' | 'new' | 'edit' }) {
  const { can } = useAccess();
  // Закрытая страница по адресу: запросов данных этой страницы нет.
  if (!can('details')) return <SectionClosedLazy />;
  if (page === 'new' && !can('createProjects')) return <SectionClosedLazy toProjects />;
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Pages page={page} />
    </Suspense>
  );
}
