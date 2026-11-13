// Страница операции и строка над результатами в ленивых чанках: главный чанк от них не растёт, на результатах и запросе код страницы не нужен.
import type { SearchState } from '@threadline/core/search';
import { lazy, Suspense, type ComponentType } from 'react';
import { PageSkeleton } from '@/components/states/PageSkeleton.tsx';
import { loadBundle } from '@/i18n/bundles.ts';
import type { Selection } from '@/lib/selection.ts';

const OperationRoute = lazy(() =>
  loadBundle('operation')
    .then(() => import('./OperationPage.tsx'))
    .then((m) => ({ default: m.OperationRoute })),
);

export function OperationSlot() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <OperationRoute />
    </Suspense>
  );
}

interface StripProps {
  state: SearchState;
  selection: Selection;
}

const OperationStrip = lazy<ComponentType<StripProps>>(() =>
  loadBundle('operation')
    .then(() => import('./OperationStrip.tsx'))
    .then((m) => ({ default: m.OperationStrip }))
    // Сбой чанка: строки нет, результаты на месте.
    .catch(() => ({ default: () => null })),
);

/** Строка операции над результатами: поиск по одному значению, которое оказалось id операции. Иначе ничего не грузится. */
export function OperationStripSlot({ state, selection }: StripProps) {
  if (state.status !== 'done' || state.terms.length !== 1 || state.requests.length === 0) return null;
  return (
    <Suspense fallback={null}>
      <OperationStrip state={state} selection={selection} />
    </Suspense>
  );
}
