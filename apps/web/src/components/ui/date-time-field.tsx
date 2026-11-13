// Единственное поле даты и времени: Tab прыгает к следующему полю, сегменты и стрелки внутри поля остаются браузеру.
import { MAX_INPUT_YEAR, MIN_INPUT_YEAR } from '@threadline/core';
import { CalendarDays } from 'lucide-react';
import { useRef, type ComponentProps, type KeyboardEvent, type RefObject } from 'react';
import { Input } from '@/components/ui/input.tsx';
import { moveTab } from '@/lib/focus.ts';
import { cn } from '@/lib/utils.ts';

// С этими границами год в Chromium не длиннее четырёх цифр: после четвёртой курсор сам уходит к часам.
export const DATE_TIME_MIN = `${MIN_INPUT_YEAR}-01-01T00:00`;
export const DATE_TIME_MAX = `${MAX_INPUT_YEAR}-12-31T23:59`;

/** Календарь браузера. Без поддержки или вне нажатия браузер откажет: остаётся ввод с клавиатуры. */
function openPicker(input: HTMLInputElement | null): void {
  if (!input) return;
  input.focus();
  try {
    input.showPicker();
  } catch {
    // Поле уже в фокусе, дата вводится с клавиатуры.
  }
}

export function DateTimeField({
  calendarLabel,
  inputRef,
  className,
  onKeyDown,
  ...props
}: Omit<ComponentProps<'input'>, 'type' | 'min' | 'max' | 'step' | 'ref'> & { /** Подпись кнопки календаря для наведения. */ calendarLabel: string; inputRef?: RefObject<HTMLInputElement | null> }) {
  const own = useRef<HTMLInputElement>(null);
  const ref = inputRef ?? own;
  const keys = (e: KeyboardEvent<HTMLInputElement>) => {
    onKeyDown?.(e);
    if (e.defaultPrevented) return;
    if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (moveTab(e.currentTarget, e.shiftKey)) {
        e.preventDefault();
        // Окно считает следующую остановку само и увело бы фокус дальше.
        e.stopPropagation();
      }
    } else if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
      // Браузеры по-разному отправляют форму из составного поля: одно поведение на всех.
      e.preventDefault();
      e.currentTarget.form?.requestSubmit();
    }
  };
  return (
    <div className="relative min-w-0">
      <Input {...props} ref={ref} type="datetime-local" step={60} min={DATE_TIME_MIN} max={DATE_TIME_MAX} onKeyDown={keys} className={cn('tabular [&::-webkit-calendar-picker-indicator]:hidden supports-[selector(::-webkit-calendar-picker-indicator)]:pr-8', className)} />
      {/* Только мышью: с клавиатуры дата вводится в самом поле. В браузере без этой части значок свой, второго не нужно. */}
      <button
        type="button"
        tabIndex={-1}
        aria-label={calendarLabel}
        title={calendarLabel}
        disabled={props.disabled}
        data-testid="date-time-calendar"
        onClick={() => openPicker(ref.current)}
        className="absolute top-1/2 right-0.5 hidden size-7 -translate-y-1/2 items-center justify-center rounded-[6px] text-muted-foreground hover:bg-sunk hover:text-foreground disabled:pointer-events-none supports-[selector(::-webkit-calendar-picker-indicator)]:flex"
      >
        <CalendarDays className="size-4" aria-hidden />
      </button>
    </div>
  );
}
