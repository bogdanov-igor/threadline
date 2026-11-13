// Большое окно с телом (открытое состояние): почти на весь экран поверх страницы, шаг и его данные вкладками, виды тела,
// поиск по тексту, перенос и копирование. Esc закрывает, «/» ставит в поиск, J и K листают соседние шаги. Ленивый чанк.
// Код, подсветка, маска и «Показать скрытое», «Как страница» — те же части, что у блока кода (useCode, CodeBody): окно только раскладывает их.
import type { Trace, ViewRecord } from '@threadline/core/search';
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, CircleCheck, CircleDashed, CircleX, Search, TriangleAlert, WrapText, X } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button.tsx';
import { CopyCodeButton } from '@/components/ui/code-parts.tsx';
import { Kbd } from '@/components/ui/kbd.tsx';
import { Tooltip } from '@/components/ui/tooltip.tsx';
import { useView } from '@/features/view/context.tsx';
import { errorParts } from '@/lib/error-text.ts';
import { formatInt, formatSize, timeParts } from '@/lib/format.ts';
import { hotkeyOf, TYPING } from '@/lib/hotkeys.ts';
import type { HitForms } from '@/lib/hits.ts';
import { useMedia } from '@/lib/use-media.ts';
import { cn } from '@/lib/utils.ts';
import { CodeBody, CodeModeContext, HitCount, ModeSwitch, useCode, type CodeSource } from './CodeView.tsx';
import type { DataItem, DataKey, DataPart } from './code-window.ts';
import { HitsContext, RevealContext } from './overlay.ts';
import { bodyMeta, dataHits, partText, stepDataItems, stepOutcomeView, stepSystemLabel, stepTitle, stepWindowBlock } from './StepDetails.tsx';
import { neighbourStep, stepBlocks, type OutcomeTone } from './trace-model.ts';

export interface BodyViewerProps {
  /** Шаг окна — выбранный на странице: J и K в окне выбирают соседний шаг и на странице. */
  stepId: string;
  trace: Trace;
  byId: ReadonlyMap<string, ViewRecord>;
  /** Шаги, по которым ходят J и K: те же, что на схеме и шкале в этом режиме. */
  steps: readonly { id: string }[];
  stepNumber?: { order: ReadonlyMap<string, number>; total: number } | undefined;
  timeZone: string;
  item: DataKey;
  onItem: (item: DataKey) => void;
  onStep: (stepId: string) => void;
  onClose: () => void;
  /** Кнопка, с которой открыто окно: фокус возвращается на неё. */
  opener: HTMLElement | null;
}

const PILL: Record<OutcomeTone, string> = { success: 'bg-success-bg text-success', danger: 'bg-danger-bg text-danger', warning: 'bg-warning-bg text-warning', neutral: 'bg-muted text-muted-foreground' };
const PILL_ICON = { success: CircleCheck, danger: CircleX, warning: TriangleAlert, neutral: CircleDashed } as const;
const EMPTY: CodeSource = { name: 'raw', text: '', lang: 'text', empty: true };
const escapeRe = (s: string) => s.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');

export default function BodyViewer(props: BodyViewerProps) {
  const pageForms = useContext(HitsContext);
  // Поиск окна: пусто — подсвечено искомое значение страницы; введённый текст ищется как есть, без учёта регистра.
  const [query, setQuery] = useState('');
  const forms = useMemo<HitForms | null>(() => (query.trim() ? [new RegExp(escapeRe(query.trim()), 'gi')] : pageForms), [query, pageForms]);
  return (
    <HitsContext.Provider value={forms}>
      {/* Вид и перенос принадлежат окну: панель шага и окно их не делят. */}
      <CodeModeContext.Provider value={null}>
        <Viewer {...props} query={query} onQuery={setQuery} />
      </CodeModeContext.Provider>
    </HitsContext.Provider>
  );
}

function Viewer({ stepId, trace, byId, steps, stepNumber, timeZone, item, onItem, onStep, onClose, opener, query, onQuery }: BodyViewerProps & { query: string; onQuery: (q: string) => void }) {
  const { t, i18n } = useTranslation();
  const { mode, view } = useView();
  const brief = mode === 'brief';
  const overlay = useContext(RevealContext);
  const forms = useContext(HitsContext);
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const step = trace.steps.find((s) => s.id === stepId) ?? null;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- подписи на языке интерфейса
  const items = useMemo<DataItem[]>(() => (step ? stepDataItems(step, stepBlocks(step, byId, overlay, view, mode), t) : []), [step, byId, overlay, view, mode, t, i18n.language]);
  const current = items.find((x) => x.key === item) ?? items[0] ?? null;

  // Часть внутри данных: при смене шага или вкладки — первая с совпадением, иначе первая. Выбор человека живёт до следующей смены.
  const partKey = `${stepId}|${current?.key ?? ''}`;
  const [chosen, setChosen] = useState<{ key: string; index: number } | null>(null);
  const firstHit = current ? Math.max(0, current.parts.findIndex((p) => !p.item.block.empty && forms !== null && dataHits({ key: current.key, parts: [p] }, forms) > 0)) : 0;
  const partIndex = chosen?.key === partKey ? chosen.index : firstHit;
  const part: DataPart | null = current?.parts[Math.min(partIndex, current.parts.length - 1)] ?? null;
  const number = step ? stepNumber?.order.get(step.id) : undefined;
  const block = part && step ? stepWindowBlock(part.target, step, trace, byId, overlay, view, mode, number, t) : null;

  const code = useCode(block ?? EMPTY, view.bodyView);
  const [wrap, setWrap] = useState(true);
  // Узкое окно: подпись «Копировать» уходит в подсказку, строка инструментов помещается в две строки.
  const roomy = useMedia('(min-width: 1024px)');

  // Переход по совпадениям: отметки в коде, текущая обведена и прокручена в середину.
  const [hit, setHit] = useState(0);
  const total = code.page ? 0 : code.count;
  const at = total > 0 ? Math.min(hit, total - 1) : 0;
  const moved = useRef(false);
  useEffect(() => setHit(0), [query, block?.id, code.choice]);
  useLayoutEffect(() => {
    const marks = [...(root.current?.querySelectorAll<HTMLElement>('pre mark.search-hit') ?? [])];
    marks.forEach((m, i) => (i === at ? m.setAttribute('data-current', '') : m.removeAttribute('data-current')));
    if (!moved.current) return;
    moved.current = false;
    marks[at]?.scrollIntoView({ block: 'center', inline: 'nearest' });
  });
  const go = (delta: 1 | -1) => {
    if (total === 0) return;
    moved.current = true;
    setHit((h) => (Math.min(h, total - 1) + delta + total) % total);
  };

  const index = steps.findIndex((s) => s.id === stepId);
  const prev = index > 0 ? (neighbourStep(steps, stepId, -1) ?? null) : null;
  const next = index >= 0 && index < steps.length - 1 ? (neighbourStep(steps, stepId, 1) ?? null) : null;
  const position = number !== undefined && stepNumber ? { index: number, total: stepNumber.total } : index >= 0 ? { index: index + 1, total: steps.length } : null;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || e.nativeEvent.isComposing) return;
    const typing = (e.target as Element).closest(TYPING);
    const key = hotkeyOf(e.nativeEvent);
    if (key === 'search' && !typing) {
      e.preventDefault();
      search.current?.focus();
      search.current?.select();
    } else if ((key === 'next' || key === 'prev') && !typing) {
      const to = key === 'next' ? next : prev;
      e.preventDefault();
      if (to) onStep(to);
    }
  };

  const title = step ? stepTitle(step, trace, byId, brief, t) : '';
  const outcome = step ? stepOutcomeView(step, byId, brief, t) : null;
  const Pill = outcome?.label ? PILL_ICON[outcome.tone] : null;
  const sub = step ? [position ? t('flow.mark.step', { index: position.index, of: position.total }) : null, stepSystemLabel(step, byId, brief), brief ? null : step.title].filter(Boolean).join(' · ') : '';
  const record = part?.item.record;
  const meta = block && part ? [part.nested ? [part.nested.lang.toUpperCase(), formatSize(new TextEncoder().encode(part.nested.text).length)].join(' · ') : bodyMeta(part.item.block, t), block.empty ? null : t('viewer.lines', { count: code.view.split('\n').length }), record ? t('viewer.at', { time: timeParts(record.timeMs, timeZone).time }) : null].filter(Boolean).join(' · ') : '';

  return (
    <DialogPrimitive.Root open onOpenChange={(open) => !open && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-[rgb(15_23_36/0.34)] data-[state=open]:animate-in data-[state=open]:fade-in-0 dark:bg-[rgb(4_5_7/0.66)]" />
        <DialogPrimitive.Content
          ref={root}
          aria-describedby={undefined}
          data-testid="body-viewer"
          data-item={current?.key}
          data-step={stepId}
          data-mode={code.choice}
          onKeyDown={onKeyDown}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            (root.current?.querySelector<HTMLElement>('pre') ?? root.current)?.focus({ preventScroll: true });
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            const back = opener?.isConnected ? opener : document.getElementById('step-details');
            back?.focus({ preventScroll: true });
          }}
          className="fixed inset-x-7 top-7 bottom-6 z-50 flex min-w-0 flex-col overflow-hidden rounded-[14px] border border-border bg-sub text-foreground shadow-[var(--shadow-pop)] outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.98] max-md:inset-2"
        >
          <header className="flex min-h-[58px] shrink-0 items-center gap-3.5 border-b border-border py-2 pr-3 pl-5">
            <div className="flex min-w-0 flex-col">
              <DialogPrimitive.Title className="truncate text-[15px] leading-5 font-semibold text-heading" data-testid="viewer-title">
                {title || t('viewer.tabs')}
              </DialogPrimitive.Title>
              {sub && (
                <span className="truncate font-mono text-[12px] leading-4 text-muted-foreground" title={sub}>
                  {sub}
                </span>
              )}
            </div>
            {outcome?.label && Pill && (
              <span className={cn('inline-flex h-[22px] max-w-[40%] min-w-0 shrink-0 items-center gap-1.5 rounded-[6px] pr-2 pl-1.5 text-[12px] font-semibold', PILL[outcome.tone])} title={outcome.label} data-testid="viewer-outcome">
                <Pill className="size-3.5 shrink-0" aria-hidden />
                <span className="min-w-0 truncate">{outcome.tone === 'danger' ? errorParts(outcome.label).message : outcome.label}</span>
              </span>
            )}
            <span className="flex-1" />
            <nav aria-label={t('viewer.stepPosition', { index: position?.index ?? 0, total: position?.total ?? 0 })} className="flex shrink-0 items-center gap-1 text-[12.5px] text-muted-foreground">
              <Tooltip content={`${t('viewer.prevStep')} · K`}>
                <Button type="button" variant="ghost" size="icon" className="size-[30px]" aria-label={t('viewer.prevStep')} aria-keyshortcuts="K" disabled={!prev} onClick={() => prev && onStep(prev)} data-testid="viewer-prev">
                  <ChevronLeft aria-hidden />
                </Button>
              </Tooltip>
              {position && (
                <span className="tabular whitespace-nowrap" data-testid="viewer-position">
                  {t('viewer.stepPosition', { index: position.index, total: position.total })}
                </span>
              )}
              <Tooltip content={`${t('viewer.nextStep')} · J`}>
                <Button type="button" variant="ghost" size="icon" className="size-[30px]" aria-label={t('viewer.nextStep')} aria-keyshortcuts="J" disabled={!next} onClick={() => next && onStep(next)} data-testid="viewer-next">
                  <ChevronRight aria-hidden />
                </Button>
              </Tooltip>
            </nav>
            <span aria-hidden className="h-[18px] w-px shrink-0 bg-border" />
            <Tooltip content={`${t('viewer.close')} · Esc`}>
              <DialogPrimitive.Close asChild>
                <Button type="button" variant="ghost" size="icon" aria-label={t('viewer.close')} aria-keyshortcuts="Escape" data-testid="viewer-close">
                  <X aria-hidden />
                </Button>
              </DialogPrimitive.Close>
            </Tooltip>
          </header>

          <div className="flex min-h-12 shrink-0 flex-wrap items-stretch gap-x-2.5 gap-y-1 border-b border-border pr-3 pl-5">
            <div role="tablist" aria-label={t('viewer.tabs')} className="flex min-w-0 items-stretch gap-6" data-testid="viewer-tabs" onKeyDown={(e) => moveTab(e, items, current?.key ?? null, onItem)}>
              {items.map((x) => (
                <DataTab key={x.key} item={x} selected={x.key === current?.key} forms={forms} onSelect={() => onItem(x.key)} />
              ))}
            </div>
            <span className="flex-1" />
            <div className="flex flex-wrap items-center gap-2.5 py-2">
              {(code.canToggle || code.html) && <ModeSwitch value={code.choice} raw={code.canToggle} page={code.html !== null} onChange={code.choose} />}
              <label className="flex h-8 w-[260px] max-w-full items-center lg:w-[300px] gap-1.5 rounded-[8px] border border-input bg-background pr-1 pl-2.5 text-muted-foreground focus-within:outline-2 focus-within:outline-ring" data-testid="viewer-search">
                <Search className="size-3.5 shrink-0" aria-hidden />
                <input
                  ref={search}
                  type="text"
                  value={query}
                  spellCheck={false}
                  placeholder={t('viewer.search')}
                  aria-label={t('viewer.search')}
                  aria-keyshortcuts="/"
                  onChange={(e) => onQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      go(e.shiftKey ? -1 : 1);
                    }
                  }}
                  className="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-foreground outline-none placeholder:font-sans placeholder:text-muted-foreground"
                />
                <span className="tabular shrink-0 text-[12px] whitespace-nowrap" aria-live="polite" data-testid="viewer-matches">
                  {total > 0 ? t('viewer.searchPosition', { index: formatInt(at + 1), total: formatInt(total) }) : query.trim() ? t('viewer.noMatches') : ''}
                </span>
                <Button type="button" variant="ghost" size="icon" className="size-[26px]" aria-label={t('viewer.prevMatch')} disabled={total === 0} onClick={() => go(-1)}>
                  <ChevronUp aria-hidden />
                </Button>
                <Button type="button" variant="ghost" size="icon" className="size-[26px]" aria-label={t('viewer.nextMatch')} disabled={total === 0} onClick={() => go(1)}>
                  <ChevronDown aria-hidden />
                </Button>
              </label>
              {block && !block.empty && !code.page && !code.longLine && (
                <Tooltip content={t('record.wrap')}>
                  <Button type="button" variant="ghost" size="icon" className={cn('size-[30px]', wrap && 'bg-sunk')} aria-pressed={wrap} aria-label={t('record.wrap')} onClick={() => setWrap(!wrap)}>
                    <WrapText className={wrap ? 'text-primary' : 'text-muted-foreground'} aria-hidden />
                  </Button>
                </Tooltip>
              )}
              {block && <CopyCodeButton text={code.copyText} title={block.title} disabled={block.empty} hideLabel={!roomy} />}
            </div>
          </div>

          {current && current.parts.length > 1 && (
            <div role="group" aria-label={t('viewer.partsLabel')} className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-5 py-1.5" data-testid="viewer-parts">
              {current.parts.map((p, i) => (
                <button
                  key={`${p.target.tab}|${p.target.name}|${p.target.nth}|${p.target.nested ?? ''}`}
                  type="button"
                  aria-pressed={i === partIndex}
                  onClick={() => setChosen({ key: partKey, index: i })}
                  className={cn('inline-flex h-[26px] max-w-80 items-center gap-1.5 rounded-[7px] px-2.5 text-[12.5px] font-medium transition-colors', i === partIndex ? 'bg-[var(--seg-on)] text-foreground shadow-[var(--seg-on-shadow)]' : 'text-muted-foreground hover:text-foreground')}
                >
                  <span className="min-w-0 truncate">{p.label}</span>
                  {forms && !p.item.block.empty && dataHits({ key: current.key, parts: [p] }, forms) > 0 && <HitCount count={dataHits({ key: current.key, parts: [p] }, forms)} />}
                </button>
              ))}
            </div>
          )}

          <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background" data-block={block?.name} data-mode={code.choice} data-testid="viewer-code">
            {block ? (
              <CodeBody key={block.id} code={code} empty={block.empty} wrap={wrap} active className="max-h-none min-h-0 flex-1 border-t-0 pt-2 text-[13px] leading-5" />
            ) : (
              <p className="px-5 py-4 text-[13px] text-muted-foreground" data-testid="viewer-empty">
                {t('viewer.empty')}
              </p>
            )}
          </div>

          <footer className="flex min-h-[34px] shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-5 py-1.5 text-[12px] text-muted-foreground">
            <span className="min-w-0 truncate" data-testid="viewer-meta">
              {meta}
            </span>
            <span className="flex-1" />
            <span className="inline-flex items-center gap-1 max-md:hidden">
              <Kbd>Esc</Kbd> {t('viewer.keys.close')}
            </span>
            <span className="inline-flex items-center gap-1 max-md:hidden">
              <Kbd>/</Kbd> {t('viewer.keys.search')}
            </span>
            <span className="inline-flex items-center gap-1 max-md:hidden">
              <Kbd>J</Kbd>
              <Kbd>K</Kbd> {t('viewer.keys.step')}
            </span>
          </footer>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** Вкладка данных: подпись, совпадения жёлтым числом или число заголовков и записей. */
function DataTab({ item, selected, forms, onSelect }: { item: DataItem; selected: boolean; forms: HitForms | null; onSelect: () => void }) {
  const { t } = useTranslation();
  const hits = dataHits(item, forms);
  const own = item.parts.filter((p) => p.nested === null);
  const countOf = item.key === 'headers' ? own.reduce((n, p) => n + partText(p).split('\n').filter(Boolean).length, 0) : item.key === 'raw' ? own.length : null;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      onClick={onSelect}
      data-item={item.key}
      className={cn('relative inline-flex items-center gap-1.5 text-[13.5px] font-medium whitespace-nowrap transition-colors', selected ? 'text-heading after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:rounded-full after:bg-primary' : 'text-muted-foreground hover:text-foreground')}
    >
      {t(`trace.details.tabs.${item.key}`)}
      {hits > 0 ? <HitCount count={hits} /> : countOf !== null && <span className="tabular font-normal text-muted-foreground">{formatInt(countOf)}</span>}
    </button>
  );
}

/** Стрелки влево и вправо по вкладкам данных, как у вкладок страницы. */
function moveTab(e: KeyboardEvent<HTMLDivElement>, items: readonly DataItem[], current: DataKey | null, onItem: (key: DataKey) => void) {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End') return;
  const i = items.findIndex((x) => x.key === current);
  const n = items.length;
  if (n === 0) return;
  e.preventDefault();
  const list = e.currentTarget;
  const to = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + n) % n;
  onItem(items[to]!.key);
  requestAnimationFrame(() => list.querySelector<HTMLElement>(`[data-item="${items[to]!.key}"]`)?.focus());
}

