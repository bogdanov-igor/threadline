// Слоты инструментов поддержки: один ленивый чанк и его строки. Сбой загрузки убирает инструмент, страница остаётся на месте.
import { lazy, Suspense, type ComponentType } from 'react';
import { loadBundle } from '@/i18n/bundles.ts';

const parts = () => loadBundle('tools').then(() => import('./parts.tsx'));

function slot<P extends object>(pick: (m: Awaited<ReturnType<typeof parts>>) => ComponentType<P>) {
  const Part = lazy(() => parts().then((m) => ({ default: pick(m) }), (): { default: ComponentType<P> } => ({ default: () => null }))) as unknown as ComponentType<P>;
  return function Slot(props: P) {
    return (
      <Suspense fallback={null}>
        <Part {...props} />
      </Suspense>
    );
  };
}

export const ExcludeToggleSlot = slot((m) => m.ExcludeToggle);
export const ExcludeFieldSlot = slot((m) => m.ExcludeField);
export const ResultFiltersSlot = slot((m) => m.ResultFiltersBar);
export const ResultFiltersStatusSlot = slot((m) => m.ResultFiltersStatus);
export const CurlSlot = slot((m) => m.CurlButton);
export const SupportContactSlot = slot((m) => m.SupportContact);
