// Экран запроса для Бизнеса в своём чанке: остальным ролям его код и строки не нужны. Заготовка лежит здесь, чтобы готовый экран не прыгал.
import { lazy, Suspense, type ReactNode } from 'react';
import { GUTTERS } from '@/components/shell/Page.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { useAccess } from '@/features/auth/access.tsx';
import { useShareMode } from '@/features/share/mode.ts';
import { loadBundle } from '@/i18n/bundles.ts';
import { cn } from '@/lib/utils.ts';
import type { BusinessRequestProps } from './BusinessRequest.tsx';

const BusinessRequest = lazy(() =>
  loadBundle('business')
    .then(() => import('./BusinessRequest.tsx'))
    .then((m) => ({ default: m.BusinessRequest })),
);

/** Экран только у Бизнеса на его страницах. На короткой ссылке роль не читается: там обычная страница. */
export function useBusinessScreen(): boolean {
  const technical = useAccess().can('details');
  const onLink = useShareMode() !== null;
  return !technical && !onLink;
}

/** Обёртка экрана: страница в размер окна в рабочем режиме прокручивается внутри, в компактном обычным потоком. */
export const BUSINESS_PAGE = cn('flex min-w-0 flex-col gap-4 pt-3.5 pb-6 work:min-h-0 work:flex-1 work:overflow-y-auto', GUTTERS);
/** Те же колонки у заготовки и у экрана. */
export const BUSINESS_GRID = 'grid min-w-0 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_360px]';

export function BusinessSkeleton({ head }: { /** Возврат и соседние результаты: на месте, пока запрос читается. */ head?: ReactNode }) {
  return (
    <div className={BUSINESS_PAGE} aria-busy="true" data-testid="request-skeleton">
      {head && <div className="flex h-8 min-w-0 items-center [&>*]:mb-0">{head}</div>}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2.5">
          <Skeleton className="h-6 w-20" />
          <Skeleton className="h-7 w-80 max-w-full lg:h-[30px]" />
        </div>
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <div className={BUSINESS_GRID}>
        <Skeleton className="h-[320px] w-full rounded-[12px]" />
        <Skeleton className="h-[200px] w-full rounded-[12px]" />
      </div>
    </div>
  );
}

export function BusinessRequestSlot(props: BusinessRequestProps) {
  return (
    <Suspense fallback={<BusinessSkeleton head={props.back} />}>
      <BusinessRequest {...props} />
    </Suspense>
  );
}
