import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils.ts';

export type ChipTone = 'neutral' | 'accent' | 'success' | 'danger' | 'warning';

const TONES: Record<ChipTone, string> = {
  neutral: 'border-border bg-muted text-muted-foreground',
  accent: 'border-primary/20 bg-accent text-accent-foreground',
  success: 'border-success/25 bg-success-bg text-success',
  danger: 'border-danger/30 bg-danger-bg text-danger',
  warning: 'border-warning/30 bg-warning-bg text-warning',
};

/** Метка: статус, вид записи, пометка. Зелёный — только успех, красный — только ошибка. */
export function Chip({ tone = 'neutral', className, ...props }: ComponentProps<'span'> & { tone?: ChipTone }) {
  return (
    <span
      data-slot="chip"
      className={cn('inline-flex h-6 shrink-0 items-center gap-1 rounded-[var(--radius-chip)] border px-2 text-[12px] leading-4 font-medium whitespace-nowrap', TONES[tone], className)}
      {...props}
    />
  );
}

const STATUS_TONES: Record<Exclude<ChipTone, 'accent'>, string> = {
  neutral: 'bg-muted text-muted-foreground',
  success: 'bg-success-bg text-success',
  danger: 'bg-danger-bg text-danger',
  warning: 'bg-warning-bg text-warning',
};

/** Статус на таблице и странице запроса: капсула 24px без рамки, текст не переносится. */
export function StatusChip({ tone = 'neutral', className, ...props }: ComponentProps<'span'> & { tone?: keyof typeof STATUS_TONES }) {
  return (
    <span
      data-slot="status-chip"
      className={cn('inline-flex h-6 shrink-0 items-center gap-[5px] rounded-full pr-[9px] pl-[7px] text-[12.5px] font-semibold whitespace-nowrap [&_svg]:size-3.5 [&_svg]:shrink-0', STATUS_TONES[tone], className)}
      {...props}
    />
  );
}
