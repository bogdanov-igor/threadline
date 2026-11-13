// «Что делать» из справочника: блок причин запроса и блок «Что случилось» на странице операции. Отдельный файл: страница операции не тянет страницу запроса.
import { useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils.ts';

/**
 * Две строки и «ещё», полный текст раскрывается. Блок причин не растёт сам.
 * boxed — раскрытый блок причин запроса: подпись слева, полный текст на светлой подложке, раскрывать нечего.
 */
export function WhatToDo({ text, boxed = false }: { text: string; boxed?: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && !open && !boxed) setLong(el.scrollHeight > el.clientHeight + 1);
  }, [text, open, boxed]);
  if (boxed) {
    return (
      <div className="mt-2 flex max-w-[980px] min-w-0 gap-2.5 rounded-[8px] bg-background/75 px-3 py-2.5 text-[13px] leading-[19px] text-foreground-2 dark:bg-background" data-testid="reason-action">
        <b className="shrink-0 font-semibold whitespace-nowrap text-foreground">{t('catalog.step.action')}</b>
        <p className="min-w-0">{text}</p>
      </div>
    );
  }
  return (
    <div className="mt-1 flex min-w-0 items-end gap-2 pl-6 text-[12px] leading-4" data-testid="reason-action">
      <p ref={ref} className={cn('min-w-0 flex-1 text-foreground', !open && 'line-clamp-2')} title={open ? undefined : text}>
        <b className="font-semibold">{t('catalog.step.action')}:</b> {text}
      </p>
      {(long || open) && (
        <button type="button" className="shrink-0 text-primary underline-offset-2 hover:underline" aria-expanded={open} onClick={() => setOpen(!open)}>
          {t(open ? 'request.whatLess' : 'request.whatMore')}
        </button>
      )}
    </div>
  );
}
