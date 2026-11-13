import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils.ts';

export function Card({ className, ...props }: ComponentProps<'section'>) {
  return (
    <section
      data-slot="card"
      className={cn('rounded-[var(--radius-card)] border border-border bg-card shadow-[var(--shadow-card)]', className)}
      {...props}
    />
  );
}
