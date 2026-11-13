// Страницы зоны «Справка» в ленивом чанке: адреса занимает главный чанк, содержимое грузится при открытии.
import { lazy, Suspense } from 'react';
import { PageSkeleton } from '@/components/states/PageSkeleton.tsx';
import { loadBundle } from '@/i18n/bundles.ts';
import type { HelpPageName } from './HelpPage.tsx';

const HelpPage = lazy(() => loadBundle('help').then(() => import('./HelpPage.tsx')));

export function HelpSlot({ page }: { page: HelpPageName }) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <HelpPage page={page} />
    </Suspense>
  );
}
