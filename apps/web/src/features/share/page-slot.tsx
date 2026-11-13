// Страница короткой ссылки в ленивом чанке: вне проверки входа, без списка проектов и опросов.
import { lazy, Suspense } from 'react';
import { PageSkeleton } from '@/components/states/PageSkeleton.tsx';
import { loadBundle } from '@/i18n/bundles.ts';

// Страница ссылки показывает и тело операции: его строки лежат в файле страницы операции.
const SharePage = lazy(() => Promise.all([loadBundle('share'), loadBundle('operation')]).then(() => import('./SharePage.tsx')));

export function SharePageSlot() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <SharePage />
    </Suspense>
  );
}
