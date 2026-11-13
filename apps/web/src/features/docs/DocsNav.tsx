// Меню документации: переключатель «Документация · Обучение», фильтр по названиям страниц и разделов, группы со значками.
// Группа текущей страницы открыта, остальные свёрнуты; открытые человеком группы остаются открытыми при переходах.
import { ChevronRight, Hash, Search, X } from 'lucide-react';
import { Fragment, useDeferredValue, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { cn } from '@/lib/utils.ts';
import { filterMenu, matchesIn, pagesOf, termsOf, type DocGroup } from './content.ts';
import { useOverflowMark } from './reading.ts';
import type { MenuGroup, Tree } from './menu.ts';
import { GROUP_ICONS, lastPage } from './sections.ts';

/** Открытые группы на раздел. Живёт дольше меню: в выдвижной панели и после перехода те же группы открыты. */
const OPENED = new Map<Tree, ReadonlySet<string>>();

/** Совпавшие слова выделены целиком: те же основы, что у поиска, поэтому «карта» выделяет и «карты». */
export function Marked({ text, query }: { text: string; query: string }) {
  const found = matchesIn(text, termsOf(query));
  if (found.length === 0) return <>{text}</>;
  const parts: { text: string; hit: boolean }[] = [];
  let at = 0;
  for (const m of found) {
    if (m.at > at) parts.push({ text: text.slice(at, m.at), hit: false });
    parts.push({ text: text.slice(m.at, m.end), hit: true });
    at = m.end;
  }
  if (at < text.length) parts.push({ text: text.slice(at), hit: false });
  return (
    <>
      {parts.map((p, i) =>
        p.hit ? (
          <mark key={i} className="rounded-[3px] bg-[color-mix(in_srgb,var(--hit-bg)_55%,transparent)] text-inherit">
            {p.text}
          </mark>
        ) : (
          <Fragment key={i}>{p.text}</Fragment>
        ),
      )}
    </>
  );
}

/** Переключатель ведёт на страницу, которую читали в другом разделе последней; если её нет — на первую страницу раздела. */
function TreeSwitch({ tree }: { tree: Tree }) {
  const { t } = useTranslation();
  const target = (own: Tree) => {
    const ids = pagesOf(own).map((p) => p.id);
    const last = lastPage(own);
    const id = last && ids.includes(last) ? last : ids[0];
    return id ? `/${own}/${id}` : `/${own}`;
  };
  const items = [
    { to: target('docs'), tree: 'docs' as const, label: t('docs.docsTitle') },
    { to: target('learn'), tree: 'learn' as const, label: t('docs.learnTitle') },
  ];
  return (
    <nav aria-label={t('docs.menu.trees')} className="grid grid-cols-2 gap-1 rounded-[10px] border border-border bg-sub p-1" data-testid="docs-trees">
      {items.map(({ to, tree: own, label }) => (
        <Link
          key={own}
          to={to}
          aria-current={own === tree ? 'true' : undefined}
          className={cn(
            'flex h-8 min-w-0 items-center justify-center rounded-[7px] px-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground',
            own === tree && 'bg-[var(--seg-on)] text-heading shadow-[var(--seg-on-shadow)] hover:text-heading',
          )}
        >
          <span className="truncate">{label}</span>
        </Link>
      ))}
    </nav>
  );
}

function Filter({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="relative mt-3">
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
      <input
        ref={input}
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value) {
            e.preventDefault();
            e.stopPropagation();
            onChange('');
          }
        }}
        aria-label={t('docs.filter.label')}
        placeholder={t('docs.filter.placeholder')}
        autoComplete="off"
        spellCheck={false}
        className="h-9 w-full rounded-[9px] border border-border bg-card pr-8 pl-9 text-[13.5px] text-foreground transition-[border-color,box-shadow] placeholder:text-muted-foreground hover:border-input/60 focus-visible:border-primary focus-visible:shadow-[0_0_0_3px_var(--accent)] focus-visible:outline-none [&::-webkit-search-cancel-button]:hidden"
        data-testid="docs-filter"
      />
      {value && (
        <button
          type="button"
          onClick={() => {
            onChange('');
            input.current?.focus();
          }}
          aria-label={t('docs.filter.clear')}
          className="absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 items-center justify-center rounded-[6px] text-muted-foreground hover:bg-sub hover:text-foreground"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      )}
    </div>
  );
}

const ITEM = 'relative block rounded-[8px] py-[7px] pr-2.5 pl-3 text-[14px] leading-5 transition-colors';
const ITEM_IDLE = 'text-foreground-2 hover:bg-sub hover:text-heading';
const ITEM_CURRENT = 'bg-accent/70 font-medium text-primary dark:bg-accent';
// Черта текущей страницы ложится на линию группы слева: отступ пункта 8px и толщина линии 1px.
const ITEM_LINE = 'before:absolute before:top-1.5 before:bottom-1.5 before:-left-[9px] before:w-[2px] before:rounded-full before:bg-primary';

function PageLink({ to, current, lined, onNavigate, children }: { to: string; current: boolean; lined: boolean; onNavigate: (() => void) | undefined; children: ReactNode }) {
  return (
    <Link to={to} aria-current={current ? 'page' : undefined} onClick={onNavigate} className={cn(ITEM, current ? ITEM_CURRENT : ITEM_IDLE, current && lined && ITEM_LINE)}>
      {children}
    </Link>
  );
}

function Group({ tree, group, current, open, animated, single, onToggle, onNavigate }: { tree: Tree; group: DocGroup; current: string; open: boolean; /** Открыл или закрыл человек: плавно. Открылась переходом на страницу: сразу, меню прокручивается к пункту в том же кадре. */ animated: boolean; single: boolean; onToggle: () => void; onNavigate: (() => void) | undefined }) {
  const { t } = useTranslation();
  const Icon = GROUP_ICONS[group.id];
  const list = useId();
  const holds = group.pages.some((p) => p.id === current);
  const label = (
    <>
      <span className={cn('flex size-6 shrink-0 items-center justify-center rounded-[7px] border transition-colors', holds ? 'border-accent-line/70 bg-accent text-primary' : 'border-border bg-card text-muted-foreground')}>
        <Icon className="size-3.5" aria-hidden />
      </span>
      <span className="min-w-0 flex-1 truncate">{t(`docs.groups.${group.id}`)}</span>
    </>
  );
  return (
    <section className="mt-1 first:mt-0" data-testid={`docs-group-${group.id}`}>
      {single ? (
        <h2 className="flex h-9 items-center gap-2.5 px-1.5 text-[13.5px] font-semibold text-heading">{label}</h2>
      ) : (
        <h2>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={list}
            onClick={onToggle}
            className="flex h-9 w-full items-center gap-2.5 rounded-[8px] px-1.5 text-left text-[13.5px] font-semibold text-heading transition-colors hover:bg-sub"
            data-testid="docs-group-toggle"
          >
            {label}
            <ChevronRight className={cn('size-4 shrink-0 text-muted-foreground transition-transform duration-200', open && 'rotate-90')} aria-hidden />
          </button>
        </h2>
      )}
      {/* Свёрнутая группа уходит из обхода Tab и чтения с экрана: inert. Высота меняется через сетку 0fr → 1fr, без измерений. */}
      <div id={list} inert={!open} className={cn('grid', animated && 'transition-[grid-template-rows] duration-200 ease-out', open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]')}>
        <div className="min-h-0 overflow-hidden">
          <ul className="ml-[18px] border-l border-border pt-0.5 pb-2">
            {group.pages.map((p) => (
              <li key={p.id} className="pl-2">
                <PageLink to={`/${tree}/${p.id}`} current={p.id === current} lined onNavigate={onNavigate}>
                  {p.title}
                </PageLink>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

function Filtered({ tree, language, query, current, onNavigate }: { tree: Tree; language: string; query: string; current: string; onNavigate: (() => void) | undefined }) {
  const { t } = useTranslation();
  const groups = useMemo(() => filterMenu(tree, language, query), [tree, language, query]);
  if (groups.length === 0)
    return (
      <p className="px-2 py-6 text-center text-[13.5px] text-muted-foreground" data-testid="docs-filter-empty">
        {t('docs.filter.empty')}
      </p>
    );
  return (
    <div data-testid="docs-filter-results">
      {groups.map((g) => {
        const Icon = GROUP_ICONS[g.id];
        return (
          <section key={g.id} className="mt-3 first:mt-0">
            <h2 className="flex items-center gap-2 px-1.5 pb-1 text-[12px] font-medium tracking-[0.02em] text-muted-foreground uppercase">
              <Icon className="size-3.5" aria-hidden />
              {t(`docs.groups.${g.id}`)}
            </h2>
            <ul>
              {g.pages.map(({ page, headings }) => (
                <li key={page.id}>
                  <PageLink to={`/${tree}/${page.id}`} current={page.id === current} lined={false} onNavigate={onNavigate}>
                    <Marked text={page.title} query={query} />
                  </PageLink>
                  {headings.length > 0 && (
                    <ul className="mb-1 ml-4 border-l border-border">
                      {headings.map((h) => (
                        <li key={h.id}>
                          <Link to={`/${tree}/${page.id}#${h.id}`} onClick={onNavigate} className="flex items-start gap-1.5 rounded-[6px] py-1 pr-2 pl-3 text-[13px] leading-5 text-muted-foreground transition-colors hover:bg-sub hover:text-heading">
                            <Hash className="mt-[3px] size-3 shrink-0 opacity-60" aria-hidden />
                            <span className="min-w-0">
                              <Marked text={h.title} query={query} />
                            </span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

export interface DocsNavProps {
  tree: Tree;
  groups: readonly DocGroup[];
  current: string;
  language: string;
  testId: string;
  /** Выдвижная панель закрывается выбором страницы. */
  onNavigate?: () => void;
}

export function DocsNav({ tree, groups, current, language, testId, onNavigate }: DocsNavProps) {
  const { t } = useTranslation();
  const shown = groups.filter((g) => g.pages.length > 0);
  const holding = shown.find((g) => g.pages.some((p) => p.id === current))?.id ?? null;
  const [query, setQuery] = useState('');
  const filter = useDeferredValue(query.trim());

  // Открытые группы. Переход в свёрнутую группу её открывает до отрисовки, без кадра со свёрнутой текущей страницей.
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set([...(OPENED.get(tree) ?? []), ...(holding ? [holding] : [])]));
  const [seen, setSeen] = useState({ tree, holding });
  const [animated, setAnimated] = useState(false);
  if (seen.tree !== tree || seen.holding !== holding) {
    setSeen({ tree, holding });
    setAnimated(false);
    const next = new Set(seen.tree === tree ? open : (OPENED.get(tree) ?? []));
    if (holding) next.add(holding);
    setOpen(next);
  }
  useEffect(() => {
    OPENED.set(tree, open);
  }, [tree, open]);
  const toggle = (id: MenuGroup['id']) => {
    setAnimated(true);
    setOpen((was) => {
      const next = new Set(was);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Своя прокрутка меню переживает переход. Текущая страница всегда видна: прокручивается только меню, не страница.
  const scroller = useRef<HTMLElement>(null);
  useOverflowMark(scroller);
  useLayoutEffect(() => {
    const nav = scroller.current;
    const item = nav?.querySelector('a[aria-current="page"]');
    if (!nav || !item || nav.scrollHeight <= nav.clientHeight) return;
    const box = nav.getBoundingClientRect();
    const at = item.getBoundingClientRect();
    if (at.top < box.top + 8) nav.scrollTop -= box.top - at.top + 48;
    else if (at.bottom > box.bottom - 8) nav.scrollTop += at.bottom - box.bottom + 48;
  }, [current, tree]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-4 pt-6 pb-3 lg:pr-5 lg:pl-0">
        <TreeSwitch tree={tree} />
        <Filter value={query} onChange={setQuery} />
      </div>
      <nav ref={scroller} aria-label={t('docs.contents')} className="docs-scroll min-h-0 flex-1 overflow-y-auto px-4 pt-1 pb-10 lg:pr-5 lg:pl-0" data-testid={testId}>
        <div>
          {filter ? (
            <Filtered tree={tree} language={language} query={filter} current={current} onNavigate={onNavigate} />
          ) : (
            shown.map((g) => <Group key={g.id} tree={tree} group={g} current={current} open={shown.length === 1 || open.has(g.id)} animated={animated} single={shown.length === 1} onToggle={() => toggle(g.id)} onNavigate={onNavigate} />)
          )}
        </div>
      </nav>
    </div>
  );
}
