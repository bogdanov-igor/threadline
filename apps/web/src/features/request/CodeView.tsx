import { ChevronRight, Maximize2 } from 'lucide-react';
import { findHtml, type HtmlFind } from '@threadline/core/search';
import { createContext, lazy, Suspense, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button.tsx';
import { Segmented } from '@/components/ui/segmented.tsx';
import { codeAreaClass, codeInnerClass, CopyCodeButton, renderNumbered, renderPieces, WrapButton, type Piece } from '@/components/ui/code-parts.tsx';
import { Tooltip } from '@/components/ui/tooltip.tsx';
import { formatInt } from '@/lib/format.ts';
import { detectLang, highlight, tooBigToHighlight, tooLongToWrap, type HighlightLang } from '@/lib/highlight.ts';
import { applyHits, findHits, MAX_MARKS, type Hits } from '@/lib/hits.ts';
import { cn } from '@/lib/utils.ts';
import { useView } from '@/features/view/context.tsx';
import { BlockMemoryContext, blockKind } from './block-memory.ts';
import type { NestedList } from './blocks.ts';
import { CodeWindowContext, type WindowTarget } from './code-window.ts';
import { NestedBlocks } from './NestedBlocks.tsx';
import { HitsContext } from './overlay.ts';

export type CodeMode = 'pretty' | 'raw';
/** Что показывает блок. «Как страница» своя у каждого блока: общий вид панели остаётся кодом. */
export type CodeChoice = CodeMode | 'page';

/** Общий вид для блоков одной панели: переключили на «как в логе» — так видны и другие вкладки. */
export const CodeModeContext = createContext<{ mode: CodeMode; setMode: (m: CodeMode) => void } | null>(null);

export interface CodeViewProps {
  /** Вид блока для тестов: body, headers, raw… */
  name: string;
  title: string;
  /** Отформатированный вид. */
  text: string;
  lang: HighlightLang;
  /** Как лежит в записи; null — переключателя вида нет. */
  raw?: string | null;
  /** Тело «""»: показывается словом «пусто». */
  empty?: boolean;
  defaultOpen?: boolean;
  nested?: NestedList | undefined;
  /** Раскрыть по действию пользователя: «К первому», когда совпадение есть только в сырой записи. */
  forceOpen?: boolean;
  /** Коротко о содержимом рядом с заголовком: метод и адрес, число заголовков, вид тела. */
  summary?: ReactNode;
  /** Панель шага в рабочем режиме: открытый блок занимает свободное место, код прокручивается внутри, не меньше пяти строк. */
  fill?: boolean;
  /** Строка причины ошибки в отформатированном виде, с 0: подсвечена, код прокручен к ней. */
  reasonAt?: number | null;
  /** Какой это блок для большого окна; нет — кнопки окна нет. */
  target?: WindowTarget;
}

/** Блок с кодом не ниже шапки и пяти строк по 19 px с полями. В узкой панели кнопки уходят на вторую строку шапки: места нужно больше. */
const FILL_OPEN = 'work:flex work:min-h-[153px] work:@max-[445px]:min-h-[190px] work:flex-[1_1_0] work:flex-col';
/** Страницу не прочитать в пяти строках кода: блок выше, панель прокручивается. */
const FILL_OPEN_PAGE = 'work:flex work:min-h-[400px] work:flex-[1_1_0] work:flex-col';

/** Блоки с телом: страница бывает в ответе, теле, payload, контексте и вложенном теле. В адресе, заголовках и сырой записи её не ищем. */
const PAGE_BLOCKS: ReadonlySet<string> = new Set(['response', 'body', 'payload', 'context', 'nested']);

interface HtmlPageProps {
  find: HtmlFind;
  fill: boolean;
  className?: string | undefined;
}

function PageFailed({ className }: HtmlPageProps) {
  const { t } = useTranslation();
  return <p className={cn('border-t border-border px-3 py-2 text-[13px] text-muted-foreground', className)}>{t('code.page.failed')}</p>;
}

// Защита и показ страницы — в ленивом чанке: большинство блоков этого вида не открывают.
const HtmlPage = lazy((): Promise<{ default: ComponentType<HtmlPageProps> }> => import('./HtmlPage.tsx').catch(() => ({ default: PageFailed })));

export interface CodeSource {
  name: string;
  text: string;
  lang: HighlightLang;
  raw?: string | null;
  empty?: boolean;
  reasonAt?: number | null | undefined;
}

/** Что показывает код блока: общее у блока панели и большого окна. Те же пределы подсветки и совпадений. */
export function useCode({ name, text, lang, raw = null, empty = false, reasonAt = null }: CodeSource, initial?: CodeChoice) {
  const shared = useContext(CodeModeContext);
  const forms = useContext(HitsContext);
  const { mode: viewMode, view: settings } = useView();
  const [localMode, setLocalMode] = useState<CodeMode>(initial && initial !== 'page' ? initial : settings.bodyView);
  const [showPage, setShowPage] = useState(initial === 'page');
  const mode = shared?.mode ?? localMode;
  const setMode = shared?.setMode ?? setLocalMode;
  // В «Кратко» тело только отформатированное, выбор остаётся для возврата.
  const canToggle = raw !== null && !empty && viewMode === 'full';
  // Страница ищется в том же тексте, что показывает код: маска и «Показать скрытое» действуют одинаково. В «Кратко» вида нет, как и «Как в логе».
  const html = useMemo(() => (viewMode === 'full' && !empty && PAGE_BLOCKS.has(name) ? findHtml(raw ?? text) : null), [viewMode, empty, name, raw, text]);
  const page = showPage && html !== null;
  const asLogged = canToggle && mode === 'raw';
  const view = asLogged ? raw : text;
  const viewLang = asLogged ? detectLang(raw) : lang;
  // Предел — по размеру тела в записи, а не отформатированного вида: отступы раздувают текст, а число span-ов почти не меняют.
  const big = useMemo(() => tooBigToHighlight(raw ?? text), [raw, text]);
  // Очень длинные строки: перенос держал бы вкладку секундами, блок и окно показывают их без него.
  const longLine = useMemo(() => tooLongToWrap(view), [view]);
  // Формы те же, пока те же значения поиска: опрос состояния ничего не пересчитывает.
  const hits = useMemo(() => (forms && !empty ? findHits(view, forms) : null), [forms, view, empty]);
  // Строка причины ищется в отформатированном виде; «как в логе» тело одной строкой.
  const reasonShown = reasonAt === null ? null : asLogged ? 0 : reasonAt;
  const numbered = !big && name !== 'request';
  const content = useMemo(() => (big ? renderPlain(view, hits) : renderTokens(view, viewLang, hits, numbered, reasonShown)), [big, view, viewLang, hits, numbered, reasonShown]);
  const choice: CodeChoice = page ? 'page' : asLogged ? 'raw' : 'pretty';
  const choose = (next: CodeChoice) => {
    setShowPage(next === 'page');
    if (next !== 'page') setMode(next);
  };
  // Копирование берёт то, что на экране: в виде страницы это строка с ней и текстом вокруг.
  return { mode, setMode, canToggle, asLogged, html, page, choice, choose, setShowPage, view, copyText: page ? html.source : view, big, longLine, first: hits?.ranges[0]?.[0] ?? null, count: hits?.count ?? 0, capped: hits ? hits.count > hits.ranges.length : false, reasonShown, numbered, content };
}

export type Code = ReturnType<typeof useCode>;

/** Код блока: первое совпадение на экране, только область кода, страница не двигается. Скрытый блок прокрутится при раскрытии. */
export function CodeBody({ code, empty, wrap, active, fill = false, className }: { code: Code; empty: boolean; wrap: boolean; /** Блок раскрыт. */ active: boolean; fill?: boolean; className?: string }) {
  const { t } = useTranslation();
  const preRef = useRef<HTMLPreElement>(null);
  const { first, view, reasonShown, numbered, big, longLine, content } = code;
  const wrapped = wrap && !longLine;
  useLayoutEffect(() => {
    const pre = preRef.current;
    if (!pre || pre.clientHeight === 0) return;
    // Причина важнее совпадения: ради неё открыт шаг.
    const line = reasonShown === null ? null : pre.querySelector('[data-reason]');
    if (line) {
      const box = pre.getBoundingClientRect();
      pre.scrollTop = Math.max(0, line.getBoundingClientRect().top - box.top + pre.scrollTop - pre.clientHeight / 3);
      return;
    }
    if (first === null) return;
    const mark = pre.querySelector('mark.search-hit');
    if (!mark) return;
    const at = mark.getBoundingClientRect();
    const box = pre.getBoundingClientRect();
    pre.scrollTop = Math.max(0, at.top - box.top + pre.scrollTop - pre.clientHeight / 3);
    if (!wrapped) pre.scrollLeft = Math.max(0, at.left - box.left + pre.scrollLeft - pre.clientWidth / 3);
  }, [first, view, active, wrapped, reasonShown]);
  if (empty) return <p className="border-t border-border px-3 py-2 text-[13px] text-muted-foreground italic">{t('record.empty')}</p>;
  if (code.page && code.html) {
    if (!active) return null;
    return (
      <Suspense fallback={<div className={cn('h-[360px] border-t border-border bg-code', className)} aria-busy="true" />}>
        <HtmlPage find={code.html} fill={fill} className={className} />
      </Suspense>
    );
  }
  return (
    <>
      <pre
        ref={preRef}
        tabIndex={0}
        className={cn('max-h-[480px] overflow-auto', codeAreaClass(numbered, wrapped), fill && 'work:max-h-none work:min-h-0 work:flex-1', className)}
      >
        <code className={codeInnerClass(numbered, wrapped)}>{content}</code>
      </pre>
      {big && <p className="shrink-0 border-t border-border px-3 py-1.5 text-[12px] text-muted-foreground">{t('code.tooBig')}</p>}
      {longLine && <p className="shrink-0 border-t border-border px-3 py-1.5 text-[12px] text-muted-foreground" data-testid="code-long-line">{t('code.longLine')}</p>}
    </>
  );
}

/** Блок кода: подсветка, «форматировано / как в логе», «Копировать» текущего вида, перенос строк, вложенные тела под ним. */
export function CodeView({ name, title, text, lang, raw = null, empty = false, defaultOpen = true, nested, forceOpen = false, summary, fill = false, reasonAt = null, target }: CodeViewProps) {
  const { t } = useTranslation();
  const code = useCode({ name, text, lang, raw, empty, reasonAt });
  const { canToggle, asLogged, html, page, choice, choose, copyText, count, capped, longLine } = code;
  const [wrap, setWrap] = useState(true);
  const id = useId();

  // Панель шага: всё свёрнуто до нажатия, выбор человека общий для одного вида блоков на всю страницу.
  const memory = useContext(BlockMemoryContext);
  const kind = blockKind(name);
  // Вне панели блок с совпадением раскрыт сразу, кроме сырой записи: она содержит всё и раскрывалась бы у каждой записи.
  const openForHit = count > 0 && name !== 'raw';
  const [localOpen, setLocalOpen] = useState(defaultOpen || openForHit || forceOpen);
  const toggled = useRef(false);
  useEffect(() => {
    if (openForHit && !toggled.current) setLocalOpen(true);
  }, [openForHit]);
  useEffect(() => {
    if (forceOpen) setLocalOpen(true);
  }, [forceOpen]);
  const open = memory ? (memory.opened.get(kind) ?? false) : localOpen;
  const toggle = () => {
    toggled.current = true;
    if (memory) memory.set(kind, !open);
    else setLocalOpen(!open);
  };

  const windows = useContext(CodeWindowContext);
  const opener = useRef<HTMLButtonElement>(null);
  // Счётчик совпадений относится к коду: на странице совпадения не отмечаются.
  const counter = count > 0 && !page ? <HitCount count={count} capped={capped} /> : null;

  return (
    <>
      <div className={cn('min-w-0 shrink-0 overflow-hidden rounded-[10px] border border-border bg-background', fill && open && !empty && (page ? FILL_OPEN_PAGE : FILL_OPEN))} data-block={name} data-mode={choice}>
        {/* В панели шага шапка одной высоты: раскрытие не сдвигает заголовок. */}
        <div className={cn('flex min-w-0 shrink-0 flex-wrap items-center gap-1 p-1', memory && 'min-h-10')}>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={id}
            onClick={toggle}
            className={cn('flex min-w-0 flex-[1_1_10rem] items-center gap-1.5 rounded-[6px] px-1.5 py-1 text-left text-[13px] font-medium text-heading hover:bg-accent', fill && 'work:flex-[1_1_6.5rem]')}
          >
            <ChevronRight className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} aria-hidden />
            <span className={cn('truncate', summary && 'shrink-0')}>{title}</span>
            {summary && <span className="min-w-0 truncate text-[12px] font-normal text-muted-foreground" data-testid="block-summary">{summary}</span>}
            {counter}
          </button>
          {/* Кнопки — одной группой: в узкой панели они уходят на вторую строку целиком, а заголовок не сжимается до буквы. */}
          <div className={cn('ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1', fill && 'work:@max-[445px]:gap-0.5')} data-testid="code-controls">
            {open && (canToggle || html) && <ModeSwitch value={choice} raw={canToggle} page={html !== null} onChange={choose} className={fill ? 'work:@max-[445px]:[&_button]:px-1.5' : undefined} />}
            {open && !empty && !page && !longLine && <WrapButton wrap={wrap} onChange={setWrap} />}
            {/* В панели шага подпись только для чтения с экрана: место занимает код. */}
            {(open || !fill) && <CopyCodeButton text={copyText} title={title} disabled={empty} hideLabel={fill} />}
            {windows && target && !empty && (
              <Tooltip content={t('code.window.open')}>
                <Button ref={opener} type="button" variant="ghost" size="sm" className="w-8 px-0 text-muted-foreground" aria-label={`${t('code.window.open')}: ${title}`} data-testid="code-window-open" onClick={() => windows.open(target, opener.current, choice)}>
                  <Maximize2 aria-hidden />
                </Button>
              </Tooltip>
            )}
          </div>
        </div>
        <div id={id} hidden={!open} className={cn(fill && 'work:flex work:min-h-0 work:flex-1 work:flex-col')}>
          <CodeBody code={code} empty={empty} wrap={wrap} active={open} fill={fill} />
        </div>
      </div>
      {open && nested && !asLogged && !page && <NestedBlocks nested={nested} target={target} />}
    </>
  );
}

/** Токены с отметками совпадений: отметка стоит внутри токена. */
const withHits = (tokens: readonly Piece[], hits: Hits | null): readonly Piece[] => (hits && hits.ranges.length > 0 ? applyHits(tokens, hits.ranges) : tokens);

function renderTokens(text: string, lang: HighlightLang, hits: Hits | null, numbered = false, reasonAt: number | null = null): ReactNode[] {
  const pieces = withHits(highlight(text, lang), hits);
  return numbered ? renderNumbered(pieces, reasonAt) : renderPieces(pieces);
}

/** Большое тело без токенов: одна строка, разрезанная только по участкам. */
function renderPlain(text: string, hits: Hits | null): ReactNode {
  return hits && hits.ranges.length > 0 ? renderPieces(withHits([{ kind: null, text }], hits)) : text;
}

/** Число в заголовке блока: подсказка атрибутом, потому что число стоит внутри кнопки заголовка. */
export function HitCount({ count, capped = false }: { count: number; /** Подсвечены не все. */ capped?: boolean }) {
  const { t } = useTranslation();
  const hint = [t('code.hitsHint'), capped ? t('code.hitsCapped', { max: formatInt(MAX_MARKS) }) : null].filter(Boolean).join(' ');
  return (
    <span className="search-hit tabular shrink-0 rounded-[4px] px-1 text-[12px] leading-4" title={hint} aria-label={t('code.hits', { count })} data-testid="hit-count">
      {formatInt(count)}
    </span>
  );
}

export function ModeSwitch({ value, raw, page, onChange, className }: { value: CodeChoice; /** Есть «Как в логе». */ raw: boolean; /** В теле есть страница HTML. */ page: boolean; onChange: (m: CodeChoice) => void; className?: string | undefined }) {
  const { t } = useTranslation();
  const options: { value: CodeChoice; label: string }[] = [{ value: 'pretty', label: t('code.pretty') }];
  if (raw) options.push({ value: 'raw', label: t('code.asLogged') });
  if (page) options.push({ value: 'page', label: t('code.asPage') });
  return <Segmented label={t('code.view')} value={value} options={options} onChange={onChange} {...(className ? { className } : {})} />;
}
