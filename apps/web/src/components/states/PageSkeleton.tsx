import { Page } from '@/components/shell/Page.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { useDelayed } from '@/lib/use-delayed.ts';

/** Заготовка страницы: метка, заголовок, строка, полоса и блок. Страницы со своей раскладкой заготовку держат рядом с собой, иначе после загрузки будет скачок. */
export function PageSkeleton() {
  const shown = useDelayed(true, 300);
  return (
    <Page aria-busy="true" data-testid="page-skeleton">
      {shown && (
        <div className="flex flex-col gap-2.5">
          <Skeleton className="h-[22px] w-[72px] rounded-full" />
          <Skeleton className="mt-1 h-6 w-[min(62%,28rem)]" />
          <Skeleton className="h-3 w-[min(80%,40rem)]" />
          <Skeleton className="mt-1.5 h-2 w-full rounded-full" />
          <Skeleton className="mt-2 h-[92px] w-full rounded-[var(--radius-card)]" />
        </div>
      )}
    </Page>
  );
}
