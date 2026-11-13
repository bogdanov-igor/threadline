import { X } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { useRef, type ReactNode } from 'react';
import { focusFirstField } from '@/lib/focus.ts';
import { Button } from './button.tsx';

/** Что открыло панель. Пункт меню к закрытию уже снят: тогда его кнопка. */
function openerOf(): HTMLElement | null {
  const active = document.activeElement as HTMLElement | null;
  return active?.closest('[role=menu]') ? (document.querySelector<HTMLElement>('[aria-haspopup="menu"][aria-expanded="true"]') ?? active) : active;
}

/**
 * Боковая панель с затемнением, 560px, в окне уже панели на всю ширину: шапка и подвал стоят, прокручивается тело.
 * Подпись кнопки закрытия задаёт страница: строки лежат в её ленивом чанке.
 * При открытии фокус на первом поле, а не на крестике; при закрытии на том, что открыло: своей кнопки открытия у панели нет, Radix сам не вернёт.
 */
export function SidePanel({
  open,
  onOpenChange,
  title,
  subtitle,
  closeLabel,
  footer,
  children,
  testId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  subtitle?: string | null;
  closeLabel: string;
  footer?: ReactNode;
  children: ReactNode;
  testId?: string | undefined;
}) {
  const opener = useRef<HTMLElement | null>(null);
  if (open && !opener.current) opener.current = openerOf();
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/25 data-[state=open]:animate-in data-[state=open]:fade-in-0 dark:bg-black/55" />
        <DialogPrimitive.Content
          data-testid={testId}
          onOpenAutoFocus={(e) => {
            if (focusFirstField(e.currentTarget as HTMLElement)) e.preventDefault();
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
            opener.current = null;
          }}
          {...(subtitle ? {} : { 'aria-describedby': undefined })}
          className="fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-border bg-card text-foreground shadow-[var(--shadow-pop)] outline-none data-[state=open]:animate-in data-[state=open]:slide-in-from-right-8 data-[state=open]:fade-in-0 md:w-[560px]"
        >
          <header className="flex shrink-0 items-start gap-3 border-b border-border px-5 py-3.5">
            <div className="min-w-0 flex-1">
              <DialogPrimitive.Title className="truncate text-section font-semibold text-heading">{title}</DialogPrimitive.Title>
              {subtitle && (
                <DialogPrimitive.Description className="truncate text-[13px] leading-5 text-muted-foreground" title={subtitle}>
                  {subtitle}
                </DialogPrimitive.Description>
              )}
            </div>
            <DialogPrimitive.Close asChild>
              <Button variant="ghost" size="icon" className="-mr-2" aria-label={closeLabel}>
                <X aria-hidden />
              </Button>
            </DialogPrimitive.Close>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <footer className="shrink-0 border-t border-border px-5 py-3">{footer}</footer>}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
