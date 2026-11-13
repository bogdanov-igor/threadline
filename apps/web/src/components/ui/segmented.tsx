import type { ComponentProps, ReactNode } from 'react';
import { moveInGroup } from '@/lib/focus.ts';
import { cn } from '@/lib/utils.ts';

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  testId?: string;
}

/**
 * Выбор одного из нескольких: подложка и кнопки с aria-pressed, как у режима и периода.
 * Ширина кнопок постоянная: выбранный вариант отличается фоном, а не начертанием, поэтому при смене ничего не сдвигается.
 * Группа — одна остановка Tab: внутри стрелки, выбор нажатием или пробелом.
 */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
  ...props
}: Omit<ComponentProps<'div'>, 'onChange' | 'aria-label'> & {
  label: string;
  value: T | null;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
}) {
  const stop = options.some((o) => o.value === value) ? value : (options[0]?.value ?? null);
  return (
    <div role="group" aria-label={label} onKeyDown={moveInGroup} className={cn('inline-flex shrink-0 items-center gap-0.5 rounded-[9px] bg-sunk p-[3px]', className)} {...props}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          tabIndex={o.value === stop ? 0 : -1}
          aria-pressed={o.value === value}
          data-testid={o.testId}
          onClick={() => onChange(o.value)}
          className={cn(
            'inline-flex h-[26px] items-center gap-1 rounded-[7px] px-2.5 text-[13px] font-medium whitespace-nowrap transition-colors',
            o.value === value ? 'bg-[var(--seg-on)] text-foreground shadow-[var(--seg-on-shadow)]' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
