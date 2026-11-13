// Карточка ссылки на страницу: одна на «Что читать дальше» в тексте и на «Назад» и «Дальше» под ним. Сверху подпись в своей строке,
// ниже название и пояснение, стрелка сбоку. Строка подписи есть у всех карточек ряда, даже пустая: названия соседних карточек на одной линии.
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils.ts';

export const CARD =
  'group/card relative flex min-w-0 flex-col rounded-[12px] border border-border bg-card py-3.5 transition-colors hover:border-accent-line hover:bg-accent/40 focus-visible:border-accent-line dark:hover:bg-accent/40';
/** Место под стрелку: вперёд — справа, назад — слева. */
export const CARD_FORWARD = 'pr-11 pl-4';
export const CARD_BACK = 'pr-4 pl-11';
export const CARD_LABEL = 'block min-h-4 truncate text-[11.5px] leading-4 font-medium tracking-[0.04em] text-muted-foreground uppercase';
export const CARD_TITLE = 'mt-1 block text-[15px] leading-[22px] font-semibold text-heading group-hover/card:text-primary';
export const CARD_NOTE = 'mt-1 block text-[13.5px] leading-5 text-muted-foreground';

export function CardArrow({ back = false }: { back?: boolean }) {
  const Icon = back ? ArrowLeft : ArrowRight;
  return (
    <Icon
      className={cn(
        'absolute top-1/2 size-4 -translate-y-1/2 text-muted-foreground transition-transform group-hover/card:text-primary',
        back ? 'left-4 group-hover/card:-translate-x-0.5' : 'right-4 group-hover/card:translate-x-0.5',
      )}
      aria-hidden
    />
  );
}
