// Главная документации: название, одна строка о том, что здесь есть, поиск по страницам, разделам и тексту, карточки разделов
// с главными страницами. Обучение — тоже раздел: его уроки на той же главной.
import { ArrowRight, ChevronRight, FileText, Hash, Search, X } from 'lucide-react';
import { useDeferredValue, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';
import { Page } from '@/components/shell/Page.tsx';
import { cn } from '@/lib/utils.ts';
import { featuredOf, menuOf, searchDocs, type SearchHit } from './content.ts';
import { Marked } from './DocsNav.tsx';
import { HOME_SECTIONS, type MenuGroup, type Tree } from './menu.ts';
import { GROUP_ICONS, sectionKey } from './sections.ts';

const TREES: readonly Tree[] = ['docs', 'learn'];
const hrefOf = (hit: SearchHit) => `/${hit.tree}/${hit.page.id}${hit.heading ? `#${hit.heading.id}` : ''}`;

function DocsSearch({ language }: { language: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useId();
  const typed = useDeferredValue(query.trim());
  const hits = useMemo(() => searchDocs(TREES, language, typed, 8), [language, typed]);
  const shown = open && typed !== '';
  const current = Math.min(at, hits.length - 1);
  const go = (hit: SearchHit) => {
    setOpen(false);
    void navigate(hrefOf(hit));
  };
  return (
    <div className="relative" data-testid="docs-search">
      <Search className="pointer-events-none absolute top-1/2 left-4 size-[18px] -translate-y-1/2 text-muted-foreground" aria-hidden />
      <input
        ref={input}
        type="search"
        role="combobox"
        aria-expanded={shown}
        aria-controls={list}
        aria-autocomplete="list"
        aria-activedescendant={shown && current >= 0 ? `${list}-${current}` : undefined}
        aria-label={t('docs.home.searchLabel')}
        placeholder={t('docs.home.searchPlaceholder')}
        value={query}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => {
          setQuery(e.target.value);
          setAt(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            setOpen(true);
            if (hits.length > 0) setAt((current + (e.key === 'ArrowDown' ? 1 : -1) + hits.length) % hits.length);
          } else if (e.key === 'Enter' && shown && hits[current]) {
            e.preventDefault();
            go(hits[current]);
          } else if (e.key === 'Escape' && (shown || query)) {
            e.preventDefault();
            e.stopPropagation();
            if (shown) setOpen(false);
            else setQuery('');
          }
        }}
        className="h-12 w-full rounded-[12px] border border-border bg-card pr-11 pl-11 text-[15px] text-foreground shadow-[0_1px_2px_rgb(0_39_100/0.06),0_4px_16px_-6px_rgb(0_39_100/0.12)] transition-[border-color,box-shadow] placeholder:text-muted-foreground focus-visible:border-primary focus-visible:shadow-[0_0_0_4px_var(--accent)] focus-visible:outline-none dark:shadow-none [&::-webkit-search-cancel-button]:hidden"
        data-testid="docs-search-input"
      />
      {query && (
        <button
          type="button"
          aria-label={t('docs.filter.clear')}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            setQuery('');
            input.current?.focus();
          }}
          className="absolute top-1/2 right-2.5 flex size-7 -translate-y-1/2 items-center justify-center rounded-[7px] text-muted-foreground hover:bg-sub hover:text-foreground"
        >
          <X className="size-4" aria-hidden />
        </button>
      )}
      {/* Список поверх страницы, ниже поля: место под ним не занято, карточки разделов не сдвигаются. */}
      <div
        className={cn('absolute inset-x-0 top-[calc(100%+8px)] z-30 overflow-hidden rounded-[12px] border border-border bg-card shadow-[var(--shadow-pop)]', !shown && 'hidden')}
        data-testid="docs-search-results"
      >
        <ul id={list} role="listbox" aria-label={t('docs.home.searchLabel')} className="docs-scroll max-h-[min(420px,60vh)] overflow-y-auto p-1.5">
          {hits.map((hit, i) => {
            const Icon = hit.heading ? Hash : FileText;
            return (
              <li
                key={hrefOf(hit)}
                id={`${list}-${i}`}
                role="option"
                aria-selected={i === current}
                onMouseDown={(e) => e.preventDefault()}
                onMouseMove={() => setAt(i)}
                onClick={() => go(hit)}
                className={cn('flex cursor-pointer items-start gap-3 rounded-[8px] px-3 py-2.5', i === current && 'bg-accent/70 dark:bg-accent')}
                data-testid="docs-search-hit"
              >
                <Icon className={cn('mt-0.5 size-4 shrink-0', i === current ? 'text-primary' : 'text-muted-foreground')} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] leading-5 font-medium text-heading">
                    <Marked text={hit.heading?.title ?? hit.page.title} query={typed} />
                  </span>
                  <span className="block truncate text-[12.5px] leading-[18px] text-muted-foreground">
                    {t(sectionKey(hit.tree, hit.group))}
                    {hit.heading && ` › ${hit.page.title}`}
                  </span>
                  {hit.snippet && (
                    <span className="mt-1 line-clamp-2 text-[13px] leading-[19px] text-foreground-2" data-testid="docs-search-snippet">
                      <Marked text={hit.snippet} query={typed} />
                    </span>
                  )}
                </span>
                {i === current && <ArrowRight className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />}
              </li>
            );
          })}
        </ul>
        {hits.length === 0 && (
          <p className="px-4 py-6 text-center text-[13.5px] text-muted-foreground" data-testid="docs-search-empty">
            {t('docs.home.empty', { query: typed })}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Карточка раздела: заголовок с описанием, главные страницы, ссылка на весь раздел. Три строки сетки общие для карточек одного ряда
 * (subgrid): списки и нижние ссылки соседних карточек на одной линии, как бы ни переносилось описание.
 */
function SectionCard({ tree, group, language, className }: { tree: Tree; group: MenuGroup['id']; language: string; className?: string }) {
  const { t } = useTranslation();
  const Icon = GROUP_ICONS[group];
  const pages = menuOf(tree, language).find((g) => g.id === group)?.pages ?? [];
  const featured = featuredOf(tree, group, language);
  const first = pages[0];
  if (!first) return null;
  const title = t(sectionKey(tree, group));
  return (
    <section
      className={cn(
        'row-span-3 grid min-w-0 grid-rows-subgrid gap-y-0 rounded-[16px] border border-border bg-card p-6 transition-[border-color,box-shadow] duration-200 hover:border-accent-line hover:shadow-[0_1px_2px_rgb(0_39_100/0.05),0_12px_32px_-12px_rgb(0_39_100/0.18)] dark:hover:shadow-none',
        className,
      )}
      data-testid={`docs-home-${group}`}
    >
      <div className="flex min-w-0 items-start gap-4">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-[11px] border border-accent-line/60 bg-accent text-primary">
          <Icon className="size-5" aria-hidden />
        </span>
        <div className="min-w-0">
          <h2 className="text-[17px] leading-6 font-semibold tracking-[-0.01em] text-heading">
            <Link to={`/${tree}/${first.id}`} className="hover:text-primary">
              {title}
            </Link>
          </h2>
          <p className="mt-1 text-[14px] leading-[22px] text-muted-foreground">{t(`docs.home.sections.${group}`)}</p>
        </div>
      </div>
      <ul className="mt-5 flex min-w-0 flex-col gap-0.5 border-t border-border pt-4">
        {featured.map((p) => (
          <li key={p.id} className="min-w-0">
            <Link to={`/${tree}/${p.id}`} className="group/link -mx-2 flex items-start gap-2 rounded-[8px] px-2 py-1.5 text-[14px] leading-5 text-foreground-2 transition-colors hover:bg-sub hover:text-primary">
              <ChevronRight className="mt-[3px] size-3.5 shrink-0 text-muted-foreground transition-transform group-hover/link:translate-x-0.5 group-hover/link:text-primary" aria-hidden />
              <span className="line-clamp-2 min-w-0">{p.title}</span>
            </Link>
          </li>
        ))}
      </ul>
      {/* Весь раздел — и у короткого раздела, где все страницы уже в списке: карточка заканчивается так же, как соседние. */}
      <Link to={`/${tree}/${first.id}`} className="group/all inline-flex items-center gap-1.5 self-end justify-self-start pt-4 text-[13.5px] font-medium text-primary" data-testid="docs-home-all">
        {pages.length > featured.length ? t('docs.home.all', { count: pages.length }) : t('docs.home.openSection')}
        <ArrowRight className="size-3.5 transition-transform group-hover/all:translate-x-0.5" aria-hidden />
      </Link>
    </section>
  );
}

// Две первые карточки шире: с них начинают. На 768 две колонки, последняя карточка на всю ширину.
const SPANS = ['lg:col-span-3', 'lg:col-span-3', 'lg:col-span-2', 'lg:col-span-2', 'md:col-span-2 lg:col-span-2'];

export function DocsHome({ language }: { language: string }) {
  const { t } = useTranslation();
  return (
    <Page data-docs-shell data-docs-home className="py-0 lg:py-0" data-testid="docs-page">
      <div data-docs-home-body className="mx-auto w-full max-w-[1180px] pt-8 pb-20 lg:pt-10">
        {/* Без overflow-hidden: список поиска выходит за край подложки поверх карточек. Узор обрезан своим скруглением. */}
        <section className="relative rounded-[20px] border border-border bg-sub px-6 py-12 md:px-12 md:py-14" data-testid="docs-home-hero">
          <div aria-hidden className="docs-hero-dots pointer-events-none absolute inset-0 rounded-[inherit]" />
          <div className="relative max-w-[660px]">
            <h1 className="text-[36px] leading-[44px] font-semibold tracking-[-0.03em] text-heading md:text-[44px] md:leading-[52px]">{t('docs.docsTitle')}</h1>
            <p className="mt-4 max-w-[58ch] text-[17px] leading-[28px] text-muted-foreground">{t('docs.home.intro')}</p>
            <div className="mt-8">
              <DocsSearch language={language} />
            </div>
          </div>
        </section>
        <div className="mt-6 grid gap-4 md:grid-cols-2 lg:grid-cols-6" data-testid="docs-home-sections">
          {HOME_SECTIONS.map((s, i) => (
            <SectionCard key={s.group} tree={s.tree} group={s.group} language={language} className={SPANS[i]} />
          ))}
        </div>
      </div>
    </Page>
  );
}
