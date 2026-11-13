import { Tooltip as TooltipPrimitive } from 'radix-ui';
import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { cn } from '@/lib/utils.ts';

export const TooltipProvider = TooltipPrimitive.Provider;

/** Клавиши, которыми человек сам переводит фокус. Enter, пробел и Escape его только возвращают: меню и окна закрываются. */
const MOVE_KEYS = new Set(['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);

/**
 * Фокус пришёл с клавиатуры. Одного :focus-visible мало: Chromium считает его верным и для фокуса, который скрипт вернул на кнопку
 * после закрытия меню мышью, а возврат окна из другой вкладки снова шлёт focus на ту же кнопку.
 */
let movedByKey = false;
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => (movedByKey = MOVE_KEYS.has(e.key)), { capture: true });
  window.addEventListener('pointerdown', () => (movedByKey = false), { capture: true });
  window.addEventListener('blur', () => (movedByKey = false));
}

/**
 * Подсказка показывается при наведении и при фокусе с клавиатуры, закрывается по уходу указателя, нажатию, Escape, прокрутке и потере окна.
 * Radix сам открывает её на любой focus и ждёт движения указателя внутри страницы, чтобы закрыть: без этих правил она висела.
 */
export function Tooltip({
  content,
  children,
  side = 'bottom',
  className,
  disabled = false,
}: {
  content: ReactNode;
  children: ReactNode;
  side?: ComponentProps<typeof TooltipPrimitive.Content>['side'];
  className?: string;
  /** Выключенная подсказка не открывается, но дерево не перестраивается. */
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  if (disabled && open) setOpen(false);

  // Кнопка уже открыла своё меню или окно: подсказка закрыла бы его.
  const silent = () => disabled || trigger.current?.getAttribute('aria-expanded') === 'true';

  // Radix этого не видит: указатель ушёл за край страницы, к вкладкам браузера, или окно потеряло фокус.
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const page = document.documentElement;
    window.addEventListener('blur', close);
    page.addEventListener('pointerleave', close);
    return () => {
      window.removeEventListener('blur', close);
      page.removeEventListener('pointerleave', close);
    };
  }, [open]);

  return (
    <TooltipPrimitive.Root open={open} onOpenChange={(next) => setOpen(next && !silent())}>
      <TooltipPrimitive.Trigger
        asChild
        ref={trigger}
        onPointerMove={(e) => {
          if (silent()) e.preventDefault();
        }}
        onFocus={(e) => {
          if (silent() || !movedByKey || !e.currentTarget.matches(':focus-visible')) e.preventDefault();
        }}
      >
        {children}
      </TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          collisionPadding={8}
          className={cn(
            'z-50 max-w-80 rounded-[8px] border border-tooltip-line bg-tooltip px-2.5 py-1.5 text-[12px] leading-4 text-tooltip-foreground shadow-[var(--shadow-pop)] data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0',
            className,
          )}
        >
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
