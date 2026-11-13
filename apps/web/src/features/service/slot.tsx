// Страница сервиса в ленивом чанке: часть строк хранилищ и причина закрытой базы лежат в файле страниц проектов.
import { lazy, Suspense } from 'react';
import { PageSkeleton } from '@/components/states/PageSkeleton.tsx';
import { useAccess } from '@/features/auth/access.tsx';
import { SectionClosedLazy } from '@/features/auth/slot.tsx';
import { loadBundle } from '@/i18n/bundles.ts';

const ServicePage = lazy(() => Promise.all([loadBundle('service'), loadBundle('projects')]).then(() => import('./ServicePage.tsx')));

export function ServiceSlot() {
  // Закрытая страница по адресу: запросов данных этой страницы нет.
  if (!useAccess().can('details')) return <SectionClosedLazy />;
  return (
    <Suspense fallback={<PageSkeleton />}>
      <ServicePage />
    </Suspense>
  );
}
