// Слоты частей поиска по нескольким средам: ленивый чанк, поиску одной среды он не нужен. Строки в основном файле языка.
// Пока чанк грузится, место строки сред уже занято: итог не прыгает.
import { lazy, Suspense, type ComponentType } from 'react';
import type { PartsProps } from './multi-parts.tsx';

const parts = () => import('./multi-parts.tsx');

function slot(pick: (m: Awaited<ReturnType<typeof parts>>) => ComponentType<PartsProps>, fallback: ComponentType = () => null) {
  const Part = lazy(() => parts().then((m) => ({ default: pick(m) }), (): { default: ComponentType<PartsProps> } => ({ default: () => null })));
  const Fallback = fallback;
  return function Slot(props: PartsProps) {
    return (
      <Suspense fallback={<Fallback />}>
        <Part {...props} />
      </Suspense>
    );
  };
}

export const EnvPartsSlot = slot(
  (m) => m.EnvParts,
  () => <div className="mt-1.5 h-6" aria-hidden />,
);
export const ExploreMenuSlot = slot((m) => m.ExploreMenu);
