import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils.ts';

/** Одно поле страницы на всё приложение (токен --page-gutter): те же у шапки, поэтому края совпадают. */
export const GUTTERS = 'px-[var(--page-gutter)]';

/** Страница во всю ширину окна. Узкая колонка — только у длинного текста (max-w-prose), данные занимают ширину. */
export function Page({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('w-full py-5 lg:py-6', GUTTERS, className)} {...props} />;
}

/**
 * Страница в размер окна: результаты и запрос в рабочем режиме. Сама страница не прокручивается, прокручивать должны
 * её части (`min-h-0 overflow-y-auto`). В компактном режиме обычный поток: страница прокручивается. Высоту задаёт Layout по метке.
 */
export function WorkPage({ className, ...props }: ComponentProps<'div'>) {
  return <div data-work-page className={cn('flex w-full flex-col work:min-h-0 work:flex-1 work:overflow-hidden', className)} {...props} />;
}
