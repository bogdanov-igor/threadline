// Чайник у шага с HTTP 418: ленивый чанк грузится только у такого шага, сбой загрузки ничего не ломает.
import { lazy, Suspense, type ComponentType } from 'react';

const Mark = lazy((): Promise<{ default: ComponentType }> =>
  import('./show.tsx').then((m) => ({ default: m.TeapotMark })).catch(() => ({ default: () => null })),
);

export function TeapotSlot() {
  return (
    <Suspense fallback={null}>
      <Mark />
    </Suspense>
  );
}
