// Страницы документации и обучения грузятся лениво: библиотека показа и текст не входят в главный чанк.
import { lazy, Suspense } from 'react';
import { useParams } from 'react-router';
import { Page } from '@/components/shell/Page.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { loadBundle } from '@/i18n/bundles.ts';
import { useDelayed } from '@/lib/use-delayed.ts';
import { cn } from '@/lib/utils.ts';
import type { Tree } from './menu.ts';

const DocsPage = lazy(() => loadBundle('docs').then(() => import('./DocsPage.tsx')));

/** Сетка страницы: меню, текст, «На странице». Третья колонка есть и у страницы без списка, поэтому текст стоит на одном месте. */
export const DOCS_GRID = 'mx-auto w-full max-w-[1600px] lg:grid lg:grid-cols-[256px_minmax(0,1fr)] xl:grid-cols-[272px_minmax(0,1fr)_240px]';
/** Меню закреплено под шапкой на всю высоту окна; прокручивается само, только когда выше окна. На 1 меньше окна: дробная высота текста в конце страницы не поджимает колонку вверх. */
export const DOCS_SIDEBAR = 'max-lg:hidden lg:sticky lg:top-14 lg:h-[calc(100dvh-57px)] lg:self-start lg:border-r lg:border-border';
export const DOCS_MAIN = 'min-w-0 pb-24 lg:px-10 xl:px-12';
export const DOCS_TOC = 'max-xl:hidden xl:sticky xl:top-14 xl:self-start';

/** Заготовка в той же сетке: когда приходит чанк, колонки уже стоят на своих местах. */
function DocsSkeleton({ home }: { home: boolean }) {
  const shown = useDelayed(true, 300);
  if (home)
    return (
      <Page aria-busy="true" data-docs-shell className="py-0 lg:py-0" data-testid="page-skeleton">
        {shown && (
          <div className="mx-auto w-full max-w-[1180px] pt-8 lg:pt-10">
            <Skeleton className="h-[264px] w-full rounded-[20px]" />
            <div className="mt-6 grid gap-4 md:grid-cols-2 lg:grid-cols-6">
              {[3, 3, 2, 2, 2].map((span, i) => (
                <Skeleton key={i} className={cn('h-[280px] rounded-[16px]', span === 3 ? 'lg:col-span-3' : 'lg:col-span-2', i === 4 && 'md:col-span-2')} />
              ))}
            </div>
          </div>
        )}
      </Page>
    );
  return (
    <Page aria-busy="true" data-docs-shell className="py-0 lg:py-0" data-testid="page-skeleton">
      {shown && (
        <div className={DOCS_GRID}>
          <div className={cn(DOCS_SIDEBAR, 'flex flex-col gap-3 pt-6 pr-5')}>
            <Skeleton className="h-10 w-full rounded-[10px]" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="mt-3 h-5 w-40" />
            <Skeleton className="ml-6 h-4 w-44" />
            <Skeleton className="ml-6 h-4 w-36" />
            <Skeleton className="ml-6 h-4 w-40" />
          </div>
          <div className={DOCS_MAIN}>
            <div className="-mx-[var(--page-gutter)] h-12 border-b border-border lg:-mx-10 xl:hidden" />
            <div className="mx-auto flex w-full max-w-[768px] flex-col gap-3 pt-8 lg:pt-10">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="mt-2 h-9 w-[min(62%,28rem)]" />
              <Skeleton className="mt-4 h-4 w-full" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-[80%]" />
            </div>
          </div>
        </div>
      )}
    </Page>
  );
}

export function DocsSlot({ tree }: { tree: Tree }) {
  const { page } = useParams();
  return (
    <Suspense fallback={<DocsSkeleton home={tree === 'docs' && !page} />}>
      <DocsPage tree={tree} />
    </Suspense>
  );
}
