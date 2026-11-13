// «На странице»: разделы второго и третьего уровня. Справа на широком окне — колонка с чертой, которая идёт за местом чтения;
// уже — выпадающий список в полосе над текстом. Черта двигается сдвигом, без перерисовки списка, поэтому не мигает.
import { ArrowUp, ChevronDown } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.tsx';
import { cn } from '@/lib/utils.ts';
import type { Heading } from './content.ts';
import { reducedMotion, useOverflowMark } from './reading.ts';

/** Список нужен, когда разделов хотя бы три. */
export const TOC_FROM = 3;

export const tocOf = (headings: readonly Heading[]): Heading[] => headings.filter((h) => h.level === 2 || h.level === 3);

function Entries({ entries, active, onPick, className }: { entries: readonly Heading[]; active: string | null; onPick: (id: string) => void; className?: string }) {
  return (
    <ul className={className}>
      {entries.map((h) => (
        <li key={h.id}>
          <Link
            to={{ hash: h.id }}
            onClick={() => onPick(h.id)}
            aria-current={h.id === active ? 'location' : undefined}
            data-toc={h.id}
            className={cn(
              'block py-[5px] pr-2 text-[13px] leading-[19px] transition-colors duration-150',
              h.level === 3 ? 'pl-7' : 'pl-4',
              h.id === active ? 'font-medium text-primary' : 'text-muted-foreground hover:text-heading',
            )}
          >
            {h.title}
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** Колонка справа. Черта стоит у текущего раздела: её место берётся из пункта списка после отрисовки. */
export function TocColumn({ entries, active, onPick, className }: { entries: readonly Heading[]; active: string | null; onPick: (id: string) => void; className?: string }) {
  const { t } = useTranslation();
  const list = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLElement>(null);
  useOverflowMark(scroller);
  const [mark, setMark] = useState<{ top: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const item = active ? list.current?.querySelector<HTMLElement>(`[data-toc="${CSS.escape(active)}"]`) : null;
    setMark((was) => (item ? (was && was.top === item.offsetTop && was.height === item.offsetHeight ? was : { top: item.offsetTop, height: item.offsetHeight }) : null));
    // Длинный список со своей прокруткой: текущий раздел не уходит за край колонки.
    const box = scroller.current;
    if (item && box && box.scrollHeight > box.clientHeight) {
      const at = item.getBoundingClientRect();
      const frame = box.getBoundingClientRect();
      if (at.top < frame.top + 40) box.scrollTop -= frame.top + 40 - at.top;
      else if (at.bottom > frame.bottom - 56) box.scrollTop += at.bottom - frame.bottom + 56;
    }
  }, [active, entries]);
  return (
    <nav ref={scroller} aria-label={t('docs.onPage')} className={cn('docs-scroll overflow-y-auto pt-8 pb-10 pl-1', className)} data-testid="docs-toc">
      <h2 className="pl-4 text-[12px] leading-5 font-semibold tracking-[0.04em] text-heading uppercase">{t('docs.onPage')}</h2>
      <div ref={list} className="relative mt-3">
        <span aria-hidden className="absolute inset-y-0 left-0 w-px bg-border" />
        {mark && (
          <span
            aria-hidden
            className="absolute left-0 w-[2px] -translate-x-[0.5px] rounded-full bg-primary transition-[transform,height] duration-200 ease-out"
            style={{ height: mark.height, transform: `translateY(${mark.top}px)` }}
            data-testid="docs-toc-mark"
          />
        )}
        <Entries entries={entries} active={active} onPick={onPick} />
      </div>
      <button
        type="button"
        onClick={() => window.scrollTo({ top: 0, behavior: reducedMotion() ? 'instant' : 'smooth' })}
        className="mt-5 ml-4 inline-flex items-center gap-1.5 text-[12.5px] text-muted-foreground transition-colors hover:text-heading"
        data-testid="docs-to-top"
      >
        <ArrowUp className="size-3.5" aria-hidden />
        {t('docs.toTop')}
      </button>
    </nav>
  );
}

/** Выпадающий список в полосе над текстом: на кнопке — раздел, который читают. Ширина кнопки постоянная (уже 640 — остаток полосы): смена раздела ничего не сдвигает. */
export function TocMenu({ entries, active, onPick }: { entries: readonly Heading[]; active: string | null; onPick: (id: string) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const current = entries.find((h) => h.id === active);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex h-8 w-[min(340px,48vw)] shrink-0 items-center max-sm:w-auto max-sm:min-w-0 max-sm:flex-1 gap-1.5 rounded-[8px] border border-border bg-card px-2.5 text-left text-[13px] text-foreground-2 transition-colors hover:bg-sub data-[state=open]:bg-sub"
          data-testid="docs-toc-menu"
        >
          <span className="shrink-0 font-medium text-heading">{t('docs.onPage')}</span>
          {current && (
            <>
              <span className="shrink-0 text-muted-foreground" aria-hidden>
                ·
              </span>
              <span className="min-w-0 truncate text-muted-foreground">{current.title}</span>
            </>
          )}
          <ChevronDown className={cn('ml-auto size-4 shrink-0 text-muted-foreground transition-transform duration-200', open && 'rotate-180')} aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(340px,calc(100vw-32px))] p-0">
        <nav aria-label={t('docs.onPage')} className="docs-scroll max-h-[min(60vh,480px)] overflow-y-auto py-2" data-testid="docs-toc-menu-list">
          <Entries
            entries={entries}
            active={active}
            onPick={(id) => {
              setOpen(false);
              onPick(id);
            }}
          />
        </nav>
      </PopoverContent>
    </Popover>
  );
}
