import { ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils.ts';

/** Стрелка между значениями: символа → нет в шрифтах, которые отдаёт Threadline. Текст остаётся для диктора и копирования. */
export function Arrow({ className }: { className?: string }) {
  return (
    <>
      <span className="sr-only"> → </span>
      <ArrowRight aria-hidden className={cn('mx-1 inline size-3.5 align-[-2px] text-muted-foreground', className)} />
    </>
  );
}
