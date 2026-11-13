import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils.ts';

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return (
    <input
      data-slot="input"
      className={cn(
        'h-8 w-full min-w-0 rounded-[var(--radius-control)] border border-input bg-card px-2.5 text-sm text-foreground transition-colors placeholder:text-muted-foreground focus-visible:border-primary focus-visible:shadow-[0_0_0_3px_var(--accent)] focus-visible:outline-none disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground aria-invalid:border-danger',
        className,
      )}
      {...props}
    />
  );
}
