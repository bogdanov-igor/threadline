import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils.ts';

export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="skeleton" aria-hidden className={cn('animate-pulse rounded-[8px] bg-muted', className)} {...props} />;
}
