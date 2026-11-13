import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils.ts';

/** Подпись клавиши: в меню и окне горячих клавиш. */
export function Kbd({ className, ...props }: ComponentProps<'kbd'>) {
  return <kbd className={cn('inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-[5px] border border-border bg-sub px-1 font-mono text-[11px] leading-4 text-muted-foreground', className)} {...props} />;
}
