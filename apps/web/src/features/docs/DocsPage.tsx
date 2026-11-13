// Оболочка документации и обучения: слева меню, в середине одна страница, справа «На странице»; уже 1280 список уходит
// в полосу над текстом, уже 1024 меню выдвигается слева по кнопке в той же полосе. Прокручивается одна страница, колонки закреплены.
// Адрес страницы /docs/<файл>, /docs без файла — главная документации. Поиск браузера и ссылки работают обычным образом.
import { Check, ChevronRight, Link2, PanelLeft, X } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { use, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, useLocation, useParams } from 'react-router';
import { Page } from '@/components/shell/Page.tsx';
import { useCopy } from '@/lib/clipboard.ts';
import { cn } from '@/lib/utils.ts';
import { UnknownPage } from '@/routes/UnknownPage.tsx';
import { headingsOf, loadAll, loadTexts, menuOf, pageText, textsLoaded, type DocGroup, type DocPage, type Heading } from './content.ts';
import { CARD, CARD_BACK, CARD_FORWARD, CARD_LABEL, CARD_NOTE, CARD_TITLE, CardArrow } from './card.tsx';
import { DocsHome } from './DocsHome.tsx';
import { DocsNav } from './DocsNav.tsx';
import { TOC_FROM, TocColumn, TocMenu, tocOf } from './DocsToc.tsx';
import { DocText } from './markdown.tsx';
import type { Tree } from './menu.ts';
import { ReadingSnapshot, useActiveSection, useReadingPosition, useScrolledPast } from './reading.ts';
import { cardTargets, repeats } from './rehype-docs.ts';
import { GROUP_ICONS, groupOf, placeOf, rememberPage, sectionKey } from './sections.ts';
import { DOCS_GRID, DOCS_MAIN, DOCS_SIDEBAR, DOCS_TOC } from './slot.tsx';
import './docs.css';

const HOME_TREES: readonly Tree[] = ['docs', 'learn'];

/**
 * Путь над заголовком. Документация: «Документация › раздел», первая часть ведёт на главную. Обучение стоит рядом с документацией,
 * как в переключателе: «Обучение › Урок 3 из 8», первая часть ведёт на первый урок.
 */
function Breadcrumb({ tree, page, pages }: { tree: Tree; page: string; pages: readonly DocPage[] }) {
  const { t } = useTranslation();
  const group = groupOf(tree, page);
  const Icon = group ? GROUP_ICONS[group] : null;
  const at = pages.findIndex((p) => p.id === page);
  const root = tree === 'learn' ? { to: '/learn', label: t('docs.learnTitle') } : { to: '/docs', label: t('docs.docsTitle') };
  const here = tree === 'learn' && at >= 0 ? t('docs.lesson', { n: at + 1, total: pages.length }) : t(sectionKey(tree, group));
  return (
    <nav aria-label={t('docs.breadcrumb')} className="min-w-0" data-testid="docs-breadcrumb">
      <ol className="flex min-w-0 items-center gap-1.5 text-[13px] leading-5">
        <li className="shrink-0">
          <Link to={root.to} className="text-muted-foreground transition-colors hover:text-heading">
            {root.label}
          </Link>
        </li>
        <li aria-hidden className="shrink-0 text-muted-foreground/70">
          <ChevronRight className="size-3.5" />
        </li>
        <li className="flex min-w-0 items-center gap-1.5 font-medium text-primary">
          {Icon && <Icon className="size-3.5 shrink-0" aria-hidden />}
          <span className="truncate">{here}</span>
        </li>
      </ol>
    </nav>
  );
}

/** Ссылка на страницу, без раздела. Подписи в одной ячейке: ширина кнопки не меняется. */
function CopyLink() {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const { state, copy } = useCopy();
  const labels = { idle: t('docs.copyLink.idle'), copied: t('docs.copyLink.copied'), failed: t('docs.copyLink.failed') };
  return (
    <button
      type="button"
      onClick={() => void copy(`${window.location.origin}${pathname}`)}
      className={cn(
        'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[8px] border border-transparent px-2.5 text-[13px] font-medium transition-colors hover:border-border hover:bg-card',
        state === 'copied' ? 'text-success' : state === 'failed' ? 'text-danger' : 'text-muted-foreground hover:text-heading',
      )}
      data-testid="docs-copy-link"
    >
      {state === 'copied' ? <Check className="size-4" aria-hidden /> : <Link2 className="size-4" aria-hidden />}
      {/* Уже 640 только значок: подпись остаётся для чтения с экрана, путь над заголовком не обрезается. */}
      <span className="grid max-sm:sr-only">
        {(['idle', 'copied', 'failed'] as const).map((s) => (
          <span key={s} aria-hidden={s !== state} className={cn('col-start-1 row-start-1', s !== state && 'invisible')}>
            {labels[s]}
          </span>
        ))}
      </span>
      <span role="status" className="sr-only">
        {state === 'idle' ? '' : labels[state]}
      </span>
    </button>
  );
}

/**
 * «Назад» и «Дальше» под текстом, той же карточкой, что ссылки в тексте. Соседняя страница, на которую уже ведёт карточка
 * «Что читать дальше», второй раз не показывается. Под названием — раздел соседней страницы, если название с него не начинается.
 */
function Neighbours({ tree, pages, current, linked }: { tree: Tree; pages: readonly DocPage[]; current: string; linked: ReadonlySet<string> }) {
  const { t } = useTranslation();
  const at = pages.findIndex((p) => p.id === current);
  const unlisted = (p: DocPage | undefined) => (p && !linked.has(`/${tree}/${p.id}`) ? p : undefined);
  const prev = unlisted(at > 0 ? pages[at - 1] : undefined);
  const next = unlisted(at >= 0 && at < pages.length - 1 ? pages[at + 1] : undefined);
  if (!prev && !next) return null;
  const card = (p: DocPage, back: boolean) => {
    const section = t(sectionKey(tree, groupOf(tree, p.id)));
    return (
      <Link to={`/${tree}/${p.id}`} rel={back ? 'prev' : 'next'} className={cn(CARD, back ? CARD_BACK : cn(CARD_FORWARD, 'sm:col-start-2'))} data-testid={back ? 'docs-prev' : 'docs-next'}>
        <span className={CARD_LABEL}>{t(back ? 'docs.prev' : 'docs.next')}</span>
        <span className={CARD_TITLE}>{p.title}</span>
        {!repeats(p.title, section) && <span className={CARD_NOTE}>{section}</span>}
        <CardArrow back={back} />
      </Link>
    );
  };
  return (
    <nav aria-label={t('docs.neighbours')} className="mt-16 grid gap-3 sm:grid-cols-2" data-testid="docs-neighbours">
      {prev && card(prev, true)}
      {next && card(next, false)}
    </nav>
  );
}

/** Меню на узком окне: панель слева поверх страницы. Выбор страницы её закрывает, фокус возвращается на кнопку. */
function Drawer({ tree, groups, current, language }: { tree: Tree; groups: readonly DocGroup[]; current: string; language: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  const [shownPath, setShownPath] = useState(pathname);
  if (shownPath !== pathname) {
    setShownPath(pathname);
    setOpen(false);
  }
  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Trigger asChild>
        <button
          type="button"
          className="-ml-1 flex h-8 shrink-0 items-center gap-2 rounded-[8px] px-2 text-[13.5px] font-medium text-heading transition-colors hover:bg-sub data-[state=open]:bg-sub lg:hidden"
          data-testid="docs-nav-toggle"
        >
          <PanelLeft className="size-4 text-muted-foreground" aria-hidden />
          {t('docs.menu.open')}
        </button>
      </DialogPrimitive.Trigger>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/25 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0 dark:bg-black/55" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed inset-y-0 left-0 z-50 flex w-[320px] max-w-[86vw] flex-col border-r border-border bg-background shadow-[var(--shadow-pop)] outline-none data-[state=closed]:animate-out data-[state=closed]:slide-out-to-left data-[state=open]:animate-in data-[state=open]:slide-in-from-left data-[state=closed]:duration-150 data-[state=open]:duration-200"
          data-testid="docs-drawer"
        >
          <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border pr-2 pl-4">
            <DialogPrimitive.Title className="min-w-0 flex-1 truncate text-[15px] font-semibold text-heading">{t(`docs.${tree}Title`)}</DialogPrimitive.Title>
            <DialogPrimitive.Close asChild>
              <button type="button" aria-label={t('docs.menu.close')} className="flex size-8 items-center justify-center rounded-[8px] text-muted-foreground hover:bg-sub hover:text-foreground">
                <X className="size-4" aria-hidden />
              </button>
            </DialogPrimitive.Close>
          </div>
          <div className="min-h-0 flex-1">
            <DocsNav tree={tree} groups={groups} current={current} language={language} testId="docs-drawer-nav" onNavigate={() => setOpen(false)} />
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export default function DocsPage({ tree }: { tree: Tree }) {
  const { t, i18n } = useTranslation();
  const { page: id } = useParams();
  // Текст на языке интерфейса грузится отдельно от кода: при открытии ждёт заготовка Suspense; при смене языка отложенное значение
  // держит прежний текст, пока новый не пришёл. Переход между страницами идёт переходом React: прежняя страница стоит, пока новая не готова.
  const language = useDeferredValue(i18n.language);
  const home = tree === 'docs' && !id;
  if (home ? !HOME_TREES.every((tr) => textsLoaded(tr, language)) : !textsLoaded(tree, language)) use(home ? loadAll(HOME_TREES, language) : loadTexts(tree, language));
  const entry = useReadingPosition();

  const groups = useMemo(() => menuOf(tree, language), [tree, language]);
  const pages = useMemo(() => groups.flatMap((g) => g.pages), [groups]);
  const page = id ? pageText(tree, id, language) : null;
  const headings = useMemo(() => (page ? headingsOf(page.body) : []), [page?.body]); // eslint-disable-line react-hooks/exhaustive-deps
  const toc = useMemo(() => tocOf(headings), [headings]);
  const tocIds = useMemo(() => (toc.length >= TOC_FROM ? toc.map((h) => h.id) : []), [toc]);
  const { active, pin } = useActiveSection(tocIds);
  // Подпись раздела на карточке ссылки: группа страницы, на которую ссылка ведёт.
  const sectionOf = useCallback((href: string) => {
    const place = placeOf(href);
    return place ? t(sectionKey(place.tree, groupOf(place.tree, place.id))) : null;
  }, [t, language]); // eslint-disable-line react-hooks/exhaustive-deps

  // В заголовке вкладки название страницы: удобно, когда открыто несколько.
  const title = home ? t('docs.docsTitle') : page?.title;
  useEffect(() => {
    if (!title) return;
    const before = document.title;
    document.title = `${title} · ${t('app.name')}`;
    return () => {
      document.title = before;
    };
  }, [title]); // eslint-disable-line react-hooks/exhaustive-deps

  return <ReadingSnapshot entry={entry}>{home ? <DocsHome language={language} /> : <DocsArticle tree={tree} id={id} page={page} groups={groups} pages={pages} headings={headings} toc={toc} tocIds={tocIds} active={active} pin={pin} sectionOf={sectionOf} language={language} />}</ReadingSnapshot>;
}

interface ArticleProps {
  tree: Tree;
  id: string | undefined;
  page: { title: string; body: string; language: string } | null;
  groups: readonly DocGroup[];
  pages: readonly DocPage[];
  headings: readonly Heading[];
  toc: readonly Heading[];
  tocIds: readonly string[];
  active: string | null;
  pin: (id: string) => void;
  sectionOf: (href: string) => string | null;
  language: string;
}

/** Страница текста: меню, текст, «На странице». Без файла в адресе — первая страница раздела, неизвестный файл — экран неизвестного адреса. */
function DocsArticle({ tree, id, page, groups, pages, headings, toc, tocIds, active, pin, sectionOf, language }: ArticleProps) {
  const { t } = useTranslation();
  if (!id) {
    const first = pages[0];
    if (first) return <Navigate to={`/${tree}/${first.id}`} replace />;
    // Текста ещё нет: сообщение вместо пустой страницы.
    return (
      <Page data-docs-shell data-testid="docs-page">
        <h1 className="text-[20px] leading-7 font-semibold text-heading">{t(`docs.${tree}Title`)}</h1>
        <p className="mt-3 text-muted-foreground" data-testid="docs-preparing">
          {t('docs.preparing')}
        </p>
      </Page>
    );
  }
  if (!page) return <UnknownPage />;
  return <Article tree={tree} id={id} page={page} groups={groups} pages={pages} headings={headings} toc={toc} tocIds={tocIds} active={active} pin={pin} sectionOf={sectionOf} language={language} />;
}

function Article({ tree, id, page, groups, pages, headings, toc, tocIds, active, pin, sectionOf, language }: ArticleProps & { id: string; page: NonNullable<ArticleProps['page']> }) {
  const { t, i18n } = useTranslation();
  const title = useRef<HTMLHeadingElement>(null);
  // Название в полосе над текстом — только когда заголовок страницы ушёл под шапку: иначе оно повторяло бы его строкой ниже.
  const titleGone = useScrolledPast(title);
  const linked = useMemo(() => cardTargets(page.body), [page.body]);
  useEffect(() => rememberPage(tree, id), [tree, id]);
  const translated = page.language === language.split('-')[0];
  const withToc = tocIds.length > 0;
  return (
    <Page data-docs-shell className="py-0 lg:py-0" data-testid="docs-page">
      <div className={DOCS_GRID}>
        <aside className={DOCS_SIDEBAR} data-testid="docs-sidebar">
          <DocsNav tree={tree} groups={groups} current={id} language={language} testId="docs-nav" />
        </aside>
        <div className={DOCS_MAIN}>
          {/* Полоса над текстом уже 1280: кнопка меню уже 1024 и «На странице». Закреплена под шапкой, высота 48 (--docs-top). */}
          <div data-docs-bar className="sticky top-14 z-20 -mx-[var(--page-gutter)] flex h-12 items-center gap-3 border-b border-border bg-background/90 px-[var(--page-gutter)] backdrop-blur-md lg:-mx-10 lg:px-10 xl:hidden" data-testid="docs-bar">
            <Drawer tree={tree} groups={groups} current={id} language={language} />
            <span className="h-5 w-px shrink-0 bg-border lg:hidden" aria-hidden />
            <span aria-hidden={!titleGone} className={cn('min-w-0 flex-1 truncate text-[13.5px] font-medium text-foreground-2 transition-opacity duration-150 max-sm:hidden', !titleGone && 'opacity-0')} data-testid="docs-bar-title">
              {page.title}
            </span>
            {withToc && <TocMenu entries={toc} active={active} onPick={pin} />}
          </div>
          <article lang={page.language} className="mx-auto w-full max-w-[768px] pt-8 lg:pt-10" data-testid="docs-text">
            <header className="mb-4" data-testid="docs-header">
              <div className="flex min-h-8 items-center gap-3">
                <Breadcrumb tree={tree} page={id} pages={pages} />
                <span className="ml-auto" />
                <CopyLink />
              </div>
              <h1 ref={title} className="mt-3 text-[30px] leading-[38px] font-semibold tracking-[-0.022em] text-balance text-heading xl:text-[34px] xl:leading-[42px]">{page.title}</h1>
            </header>
            {!translated && (
              <p lang={i18n.language} className="mb-6 rounded-[10px] border border-accent-line/70 bg-accent/50 px-4 py-2.5 text-[13.5px] leading-5 text-foreground-2" data-testid="docs-not-translated">
                {t('docs.notTranslated')}
              </p>
            )}
            {/* Своя копия на страницу: выбор переноса у блока кода не переходит на соседнюю страницу. */}
            <DocText key={`${tree}/${id}`} body={page.body} headings={headings} sectionOf={sectionOf} />
            <Neighbours tree={tree} pages={pages} current={id} linked={linked} />
          </article>
        </div>
        {/* Колонка есть и у страницы без списка: текст стоит на одном месте. */}
        <div className={DOCS_TOC}>{withToc && <TocColumn entries={toc} active={active} onPick={pin} className="max-h-[calc(100dvh-57px)]" />}</div>
      </div>
    </Page>
  );
}
