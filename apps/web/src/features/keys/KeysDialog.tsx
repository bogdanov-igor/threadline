// Окно «Горячие клавиши». На странице короткой ссылки только то, что на ней работает.
import { X } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button.tsx';
import { Kbd } from '@/components/ui/kbd.tsx';
import { saveKeysLabel } from '@/lib/hotkeys.ts';
import type { KeysDialogProps } from './slot.tsx';

type Row = { keys: string[]; text: string };

function Group({ title, rows }: { title: string; rows: Row[] }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-[12px] leading-4 font-semibold text-muted-foreground">{title}</h3>
      <ul className="flex flex-col">
        {rows.map((r) => (
          <li key={r.text} className="flex min-h-8 items-center justify-between gap-4 border-b border-border text-[13px] leading-5 last:border-b-0">
            <span className="min-w-0">{r.text}</span>
            <span className="flex shrink-0 gap-1">
              {r.keys.map((k) => (
                <Kbd key={k}>{k}</Kbd>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function KeysDialog({ open, onOpenChange, returnFocus }: KeysDialogProps) {
  const { t } = useTranslation();
  const onLink = window.location.pathname.startsWith('/s/');
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/25 data-[state=open]:animate-in data-[state=open]:fade-in-0 dark:bg-black/55" />
        <DialogPrimitive.Content
          data-testid="keys-dialog"
          aria-describedby={undefined}
          // Полей здесь нет: фокус на самом окне, а не рамкой на крестике.
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement).focus();
          }}
          onCloseAutoFocus={(e) => {
            if (!returnFocus?.isConnected) return;
            e.preventDefault();
            returnFocus.focus();
          }}
          className="fixed top-10 left-1/2 z-50 flex max-h-[calc(100dvh-56px)] w-[480px] max-w-[calc(100vw-32px)] -translate-x-1/2 flex-col gap-4 overflow-y-auto rounded-[16px] border border-border bg-card p-6 text-foreground shadow-[var(--shadow-pop)] outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0"
        >
          <header className="flex items-start gap-3">
            <DialogPrimitive.Title className="min-w-0 flex-1 text-[16px] leading-[22px] font-semibold text-heading">{t('keys.title')}</DialogPrimitive.Title>
            <DialogPrimitive.Close asChild>
              <Button variant="ghost" size="icon" className="-mt-1 -mr-2" aria-label={t('keys.close')}>
                <X aria-hidden />
              </Button>
            </DialogPrimitive.Close>
          </header>
          <Group
            title={t('keys.group.everywhere')}
            rows={[
              { keys: ['?'], text: t('keys.help') },
              ...(onLink ? [] : [{ keys: ['/'], text: t('keys.search') }]),
              { keys: ['Esc'], text: t('keys.escape') },
            ]}
          />
          <Group
            title={t('keys.group.request')}
            rows={[
              { keys: ['J'], text: t('keys.next') },
              { keys: ['K'], text: t('keys.prev') },
              { keys: [']'], text: t('keys.nextResult') },
              { keys: ['['], text: t('keys.prevResult') },
            ]}
          />
          <Group title={t('keys.group.share')} rows={onLink ? [{ keys: ['L'], text: t('keys.linkHere') }] : [{ keys: ['L'], text: t('keys.link') }, { keys: ['T'], text: t('keys.ticket') }]} />
          {!onLink && (
            <Group
              title={t('keys.group.forms')}
              rows={[
                { keys: ['Tab'], text: t('keys.tab') },
                { keys: ['Enter'], text: t('keys.enter') },
                { keys: [saveKeysLabel()], text: t('keys.save') },
              ]}
            />
          )}
          <p className="text-[12.5px] leading-[18px] text-muted-foreground">{t('keys.note')}</p>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
