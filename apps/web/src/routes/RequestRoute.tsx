import { lazy, Suspense, useEffect } from 'react';
import { PageSkeleton } from '@/components/states/PageSkeleton.tsx';
import { useAccess } from '@/features/auth/access.tsx';
import { preloadFlow } from '@/features/flow/load.ts';
import { useView } from '@/features/view/context.tsx';
import { useLayout } from './Layout.tsx';
import { UnknownEnvironment } from './UnknownPage.tsx';

// Страница запроса — в своём чанке: главный чанк не несёт код панели шага, шкалы и модели графа.
const RequestPage = lazy(() => import('@/features/request/RequestPage.tsx').then((m) => ({ default: m.RequestPage })));

export function RequestRoute() {
  const { data, selection } = useLayout();
  // Код графа грузится вместе со страницей, а не после неё, если «Схема» включена хотя бы в одном режиме:
  // иначе переход в режим со схемой отправил бы запрос за файлом кода, а смена режима запросов не отправляет.
  const { view } = useView();
  // У Бизнеса на странице запроса схемы нет: код графа ему не нужен.
  const technical = useAccess().can('details');
  const schemeEver = technical && (view.tabs.scheme.full || view.tabs.scheme.brief);
  useEffect(() => {
    if (schemeEver) preloadFlow();
  }, [schemeEver]);
  if (!data) return <PageSkeleton />;
  if (!selection) return <UnknownEnvironment />;
  return (
    <Suspense fallback={<PageSkeleton />}>
      <RequestPage key={`${selection.project.id}/${selection.env.id}/${selection.stand ?? ''}`} selection={selection} />
    </Suspense>
  );
}
