import { foldAttempts, reasonLine, type GroupEntry, type StepGroup } from '@threadline/core/flow';
import { blockVisible, type ViewMode, type ViewSettings } from '@threadline/core/view';
import type { Trace, TraceStep, ViewRecord } from '@threadline/core/search';
import { Braces, ChevronRight, CircleCheck, CircleX, Clock, FileText, List, ListTree, Maximize2, PanelRightClose, type LucideIcon } from 'lucide-react';
import type { TFunction } from 'i18next';
import { forwardRef, Fragment, useContext, useMemo, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router';
import { Card } from '@/components/ui/card.tsx';
import { renderPieces } from '@/components/ui/code-parts.tsx';
import { Tooltip } from '@/components/ui/tooltip.tsx';
import { ParamChips, PathTitle, titleParams } from '@/components/path/PathTitle.tsx';
import { errorParts, meaningOf, noAnswerKey } from '@/lib/error-text.ts';
import { readableTitle } from '@/lib/path-template.ts';
import { highlight, type HighlightLang } from '@/lib/highlight.ts';
import { findHits, type HitForms } from '@/lib/hits.ts';
import { formatDuration, formatInt, formatOffset, formatSize, timeParts, upperFirst } from '@/lib/format.ts';
import { systemLabel } from '@/lib/systems.ts';
import { cn } from '@/lib/utils.ts';
import { BlockMemoryContext, LOGS_KIND, recordKey, useBlockMemory, type BlockMemory } from './block-memory.ts';
import { CodeModeContext, HitCount, type CodeMode } from './CodeView.tsx';
import { blockOrNested, DATA_KEYS, DataViewerContext, PanelStepContext, type DataItem, type DataKey, type DataPart, type WindowBlock, type WindowTarget } from './code-window.ts';
import { RECORD_LIST, RecordItem } from './RecordItem.tsx';
import { catalogLine, methodName, stepCatalog, systemName } from '@/features/catalog/names.ts';
import { briefMethod, briefSystem } from '@/features/view/brief.ts';
import { useView } from '@/features/view/context.tsx';
import { useAccess } from '@/features/auth/access.tsx';
import { StepOutcome } from '@/features/catalog/StepOutcome.tsx';
import { useShareMode } from '@/features/share/mode.ts';
import { CurlSlot } from '@/features/tools/slot.tsx';
import { OutcomeLine } from './OutcomeLine.tsx';
import { HitsContext, RevealContext, withRevealed, type RevealOverlay } from './overlay.ts';
import { PANEL_WIDTH } from './step-panel.ts';
import { titleText } from './record-title.ts';
import { APP, curlRecord, DANGER_LEVELS, exchangeHost, operationOf, stepBlocks, stepOutcome, stepRecords, type AppSummary, type DetailTab, type Outcome, type StepBlock } from './trace-model.ts';

export interface StepDetailsProps {
  trace: Trace;
  summary: AppSummary;
  byId: ReadonlyMap<string, ViewRecord>;
  selected: string | null;
  /** Вкладка, которую выбрал пользователь; если у шага её нет — вкладка по умолчанию. */
  tab: DetailTab | null;
  onTab: (tab: DetailTab) => void;
  mode: CodeMode;
  onMode: (mode: CodeMode) => void;
  timeZone: string;
  /** Записи-логи шага: те, что считает значок логов его узла на схеме. */
  logs?: ReadonlyMap<string, readonly string[]>;
  /** Группы шагов: список попыток или свёрнутых вызовов над вкладками. */
  groups?: ReadonlyMap<string, StepGroup>;
  /** Номер видимого шага среди узлов потока: «шаг 3 из 3». */
  stepNumber?: { order: ReadonlyMap<string, number>; total: number };
  /** Строка списка или клетка полоски: панель показывает эту попытку. */
  onSelect?: (stepId: string) => void;
  /** Страница в размер окна: панель прокручивает сама себя, код занимает свободное место. */
  fill?: boolean;
  /** Итог всего запроса: его показывает панель входа, как и его узел на схеме. */
  requestStatus?: 'error' | 'success';
  /** Что раскрыто: общее на всю страницу. Нет — панель помнит сама, пока смонтирована. */
  memory?: BlockMemory;
  /** Свернуть панель; нет — кнопки нет. */
  onCollapse?: () => void;
  className?: string;
}

/** Панель подробностей выбранного шага или блока приложения. */
export const StepDetails = forwardRef<HTMLElement, StepDetailsProps>(function StepDetails(props, ref) {
  const { t } = useTranslation();
  const { trace, selected, mode, onMode, className, fill = false } = props;
  const step = selected === APP ? null : trace.steps.find((s) => s.id === selected);
  const codeMode = useMemo(() => ({ mode, setMode: onMode }), [mode, onMode]);
  const own = useBlockMemory();
  const memory = props.memory ?? own;

  return (
    <Card
      ref={ref}
      id="step-details"
      tabIndex={-1}
      aria-label={t('trace.details.label')}
      data-testid="step-details"
      data-step={selected ?? undefined}
      className={cn(
        // Сводка шага на своей подложке: справа от схемы во всю высоту, уже 1280 — карточкой под ней.
        'min-w-0 border-0 bg-sub px-5 pt-4 pb-5 outline-none',
        fill && cn(PANEL_WIDTH, 'work:flex work:flex-col work:overflow-y-auto work:rounded-none work:border-l work:border-border work:shadow-none work:[scrollbar-gutter:stable]'),
        className,
      )}
    >
      <CodeModeContext.Provider value={codeMode}>
        <BlockMemoryContext.Provider value={memory}>
          <PanelStepContext.Provider value={selected}>
            {selected === APP ? <AppDetails {...props} /> : step ? <StepView key={step.id} step={step} {...props} /> : null}
          </PanelStepContext.Provider>
        </BlockMemoryContext.Provider>
      </CodeModeContext.Provider>
    </Card>
  );
});

const HTTP_KINDS = new Set<TraceStep['kind']>(['incoming', 'exchange']);

/** Имя шага в заголовке панели; null — у обмена есть только адрес. В «Кратко» имя есть всегда: по запасным правилам, без адреса и метки метода. */
function stepName(step: TraceStep, trace: Trace, byId: ReadonlyMap<string, ViewRecord>, brief: boolean, t: TFunction): string | null {
  const http = HTTP_KINDS.has(step.kind);
  const op = operationOf(step, trace);
  if (!brief) return op ?? (http ? null : titleText(step));
  // У Бизнеса заголовка записи нет: путь шаблоном из адреса записи, иначе общая подпись шага.
  return methodName(stepCatalog(step, byId)) ?? op ?? ((http ? briefMethod({ uri: step.title || byId.get(step.recordIds[0] ?? '')?.http?.uri }) : titleText(step)) || upperFirst(t(`trace.kind.${step.kind}`)));
}

/** Итог в «Кратко»: без цифр статуса и кодов, «OK» словом. Текст причины не переписывается. */
function briefOutcome(o: Outcome, ok: string, success: string): Outcome {
  const label = o.label === ok ? success : o.label && meaningOf(o.label);
  return { ...o, status: null, label };
}

/** Система шага для подписи окна тела: в «Подробно» хост, в «Кратко» имя из справочника или запасное слово — хоста и адреса там нет. */
export function stepSystemLabel(step: TraceStep, byId: ReadonlyMap<string, ViewRecord>, brief: boolean): string | null {
  if (!step.system) return null;
  if (!brief) return step.system;
  return step.kind === 'exchange' ? (systemName(stepCatalog(step, byId)) ?? briefSystem(step.system)) : briefSystem(step.system);
}

/** Имя шага для окна тела: то же, что в заголовке панели, у обмена без имени — читаемый путь. */
export const stepTitle = (step: TraceStep, trace: Trace, byId: ReadonlyMap<string, ViewRecord>, brief: boolean, t: TFunction): string => stepName(step, trace, byId, brief, t) ?? readableTitle(step.title);

/** Итог шага теми же словами, что в панели: справочник, правило итога, в «Кратко» без кодов. */
export function stepOutcomeView(step: TraceStep, byId: ReadonlyMap<string, ViewRecord>, brief: boolean, t: TFunction): Outcome {
  const line = catalogLine(stepOutcome(step, byId), step, stepCatalog(step, byId), { ok: t('trace.ok'), pending: t('catalog.verdict.pending'), ignored: t('catalog.verdict.ignored') });
  return brief ? briefOutcome(line, t('trace.ok'), t('flow.outcome.success')) : line;
}

/** Кнопка на панели: панель уходит, граф занимает всю ширину. Есть только там, где панель стоит справа. */
function CollapsePanel({ onCollapse }: { onCollapse: () => void }) {
  const { t } = useTranslation();
  return (
    <Tooltip content={t('trace.panel.collapse')}>
      <Button type="button" variant="ghost" size="sm" className="-my-1 hidden w-7 shrink-0 px-0 text-muted-foreground xl:inline-flex" aria-label={t('trace.panel.collapse')} data-testid="panel-collapse" onClick={onCollapse}>
        <PanelRightClose aria-hidden />
      </Button>
    </Tooltip>
  );
}

/** Длинное имя класса переносится по «\\», а посреди слова только если сегмент не помещается в строку. */
function wrapName(name: string): ReactNode {
  return name.split(/(?<=\\)/).map((seg, i) => (
    <Fragment key={i}>
      {i > 0 && <wbr />}
      {seg}
    </Fragment>
  ));
}

const DATA_ICON: Record<DataKey, LucideIcon> = { request: FileText, response: FileText, headers: List, context: Braces, raw: ListTree };

/** Строка данных шага: что внутри, совпадения, строка причины одной строкой. Нажатие открывает большое окно с телом. */
function DataRow({ item, step, forms, needles, failed }: { item: DataItem; step: TraceStep; forms: HitForms | null; needles: readonly (string | null | undefined)[]; failed: boolean }) {
  const { t } = useTranslation();
  const viewer = useContext(DataViewerContext);
  const brief = useView().mode === 'brief';
  const Icon = DATA_ICON[item.key];
  const hits = dataHits(item, forms);
  const excerpt = item.key === 'response' || item.key === 'request' ? dataExcerpt(item, forms, failed, needles) : null;
  const meta = dataMeta(item, brief, t);
  const label = t(`trace.details.tabs.${item.key}`);
  const content = (
    <>
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <span className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 font-medium text-foreground">{label}</span>
          {hits > 0 && <HitCount count={hits} />}
          {meta && (
            <span className="min-w-0 truncate text-[12px] text-muted-foreground" data-testid="data-meta">
              {meta}
            </span>
          )}
        </span>
        {excerpt && (
          <span className="flex min-w-0 items-center font-mono text-[11.5px] leading-4" data-testid="data-excerpt">
            <span className="min-w-0 truncate">{renderPieces(highlight(excerpt.text, excerpt.lang))}</span>
            <span className="ml-2.5 shrink-0 font-sans text-muted-foreground">{t('viewer.line', { n: excerpt.line + 1 })}</span>
          </span>
        )}
      </span>
      {viewer && (
        <>
          <ChevronRight className="size-4 shrink-0 text-muted-foreground group-hover:hidden group-focus-visible:hidden" aria-hidden />
          <span className="hidden shrink-0 items-center gap-1.5 text-[12.5px] font-medium text-primary group-hover:inline-flex group-focus-visible:inline-flex" aria-hidden>
            <Maximize2 className="size-3.5" />
            {t('viewer.open')}
          </span>
        </>
      )}
    </>
  );
  const box = 'group flex min-h-11 min-w-0 items-center gap-2.5 rounded-[9px] bg-background py-[9px] pr-2.5 pl-3 text-left text-[13.5px] leading-5 shadow-[inset_0_0_0_1px_var(--color-border)] dark:bg-[var(--code)] dark:shadow-none';
  if (!viewer) {
    return (
      <div className={box} data-testid="data-row" data-item={item.key}>
        {content}
      </div>
    );
  }
  return (
    <button
      type="button"
      className={cn(box, 'w-full transition-colors hover:bg-sunk focus-visible:outline-offset-0')}
      data-testid="data-row"
      data-item={item.key}
      aria-label={[label, hits > 0 ? t('code.hits', { count: hits }) : null, meta, t('viewer.open')].filter(Boolean).join(', ')}
      onClick={(e) => viewer.open(step.id, item.key, e.currentTarget)}
    >
      {content}
    </button>
  );
}

/** Адрес обмена без схемы: «POST api.pay.example/v1/x». Полный адрес — в подсказке. */
const shortAddress = (text: string) => text.replace(/^(\S+\s+)?https?:\/\//, '$1');

function StepView({ step, trace, summary, byId, timeZone, logs, groups, stepNumber, onSelect, requestStatus, fill = false, onCollapse }: StepDetailsProps & { step: TraceStep }) {
  const { t, i18n } = useTranslation();
  const { mode, view, setMode, locked } = useView();
  const brief = mode === 'brief';
  const overlay = useContext(RevealContext);
  const forms = useContext(HitsContext);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- заголовки блоков на языке интерфейса
  const blocks = useMemo(() => stepBlocks(step, byId, overlay, view, mode), [step, byId, overlay, view, mode, i18n.language]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- подписи частей на языке интерфейса
  const items = useMemo(() => stepDataItems(step, blocks, t), [step, blocks, t, i18n.language]);
  // Часть блоков шага видна только в «Подробно»: внизу панели строка с переходом.
  const count = (m: Map<DetailTab, StepBlock[]>) => [...m.values()].flat().length;
  const hiddenPart = brief && !locked && count(stepBlocks(step, byId, overlay, view, 'full')) > count(blocks);
  const address = blocks.get('request')?.find((b) => b.block.name === 'request')?.block.text ?? null;
  const first = byId.get(step.recordIds[0] ?? '');
  const when = first ? timeParts(first.timeMs, timeZone) : null;
  // Адрес с портом — только здесь, в строке о шаге; в заголовках — имя системы.
  const system = (step.kind === 'incoming' && step.parentId === null ? summary.entrySource : step.kind === 'exchange' ? exchangeHost(step, byId) : step.system) ?? null;
  // Уровень записи — слово из логов: в «Кратко» о сбое говорит итог шага.
  const level = step.kind === 'log' && !brief ? first?.level?.toUpperCase() : undefined;
  const http = HTTP_KINDS.has(step.kind);
  const op = operationOf(step, trace);
  // Справочник: итог по правилу, «не ошибка», названия; без разметки — прежний итог.
  const { project = '' } = useParams();
  const catalog = useMemo(() => stepCatalog(step, byId), [step, byId]);
  const line = catalogLine(stepOutcome(step, byId), step, catalog, { ok: t('trace.ok'), pending: t('catalog.verdict.pending'), ignored: t('catalog.verdict.ignored') });
  const outcome = brief ? briefOutcome(line, t('trace.ok'), t('flow.outcome.success')) : line;
  // Коды причины — тихой строкой под итогом: метка с причиной короткая.
  const codes = !brief && line.tone === 'danger' && line.label ? errorParts(line.label).codes : [];
  // В «Кратко» адреса нет ни в строке о шаге, ни в заголовке: система и метод по запасным правилам.
  const shownSystem = !brief ? system : step.kind === 'exchange' ? (systemName(catalog) ?? briefSystem(step.system)) : step.kind === 'incoming' && step.parentId === null ? system : system && briefSystem(system);
  // cURL собирается из того, что на экране: блок запроса скрыт — кнопки нет, блок заголовков скрыт — заголовков нет. У Бизнеса и на ссылке кнопки нет совсем.
  const details = useAccess().can('details');
  const onLink = useShareMode() !== null;
  const request = details && !onLink && !brief && http && blockVisible(view, mode, 'request') ? curlRecord(step, byId) : null;
  const group = groups?.get(step.id);
  const number = stepNumber?.order.get(step.id);
  // Причина в теле: строка ответа с ней — в строке «Ответ». Нужны и поля справочника: правило итога может смотреть на другое поле.
  const { needles, failed } = stepReasonContext(step, byId, t);
  const name = stepName(step, trace, byId, brief, t);

  return (
    <div className={cn('flex min-w-0 flex-col gap-3.5', fill && 'work:flex-[1_0_auto]')}>
      {/* Что за шаг — одной тихой строкой; итог — одной строкой под заголовком. */}
      <div className="flex min-w-0 shrink-0 flex-col gap-1">
        <div className="tabular flex min-w-0 items-center gap-1.5 text-[12px] leading-6 text-muted-foreground">
          <p className="flex min-w-0 flex-1 items-center gap-x-[7px] overflow-hidden whitespace-nowrap" data-testid="step-meta">
            <span className="inline-flex h-5 shrink-0 items-center rounded-[5px] border border-border px-1.5 font-medium text-foreground-2">{upperFirst(t(`trace.kind.${step.kind}`))}</span>
            {shownSystem && (
              <span className="min-w-0 truncate" title={shownSystem}>
                {shownSystem}
              </span>
            )}
            {level && level !== 'INFO' && (
              <>
                <span aria-hidden>·</span>
                <span className={cn('font-medium', DANGER_LEVELS.has(level) ? 'text-danger' : level === 'WARNING' ? 'text-warning' : '')}>{level}</span>
              </>
            )}
            {!outcome.label && step.durationMs !== null && (
              <>
                <span aria-hidden>·</span>
                <span className="shrink-0">{formatDuration(step.durationMs)}</span>
              </>
            )}
          </p>
          {number !== undefined && stepNumber && stepNumber.total > 1 && (
            <span className="shrink-0" data-testid="step-number">
              {t('flow.mark.step', { index: number, of: stepNumber.total })}
            </span>
          )}
          {onCollapse && <CollapsePanel onCollapse={onCollapse} />}
        </div>
        {/* Обмен внутри вызова называется операцией (getCardNumber); общий адрес SOAP — второй строкой. */}
        <h2 className="mt-0.5 line-clamp-2 min-w-0 text-[15.5px] leading-[22px] font-semibold tracking-[-0.008em] [overflow-wrap:anywhere] text-heading" title={name ?? undefined} data-testid="step-title">
          {name === null ? <PathTitle title={step.title} wrap /> : wrapName(name)}
        </h2>
        {!brief && op && <PathTitle title={step.title} className="block min-w-0 truncate font-mono text-[12px] leading-4 text-muted-foreground" data-testid="step-subtitle" />}
        {!brief && http && !op && <ParamChips params={titleParams(step.title)} className="max-h-6 overflow-hidden" />}
        <div className="mt-1.5 flex min-w-0 shrink-0 flex-col gap-1">
          <StepOutcome project={project} step={step} catalog={catalog} records={stepRecords(step, byId)} brief={brief} line={<OutcomeLine outcome={outcome} />} requestStatus={requestStatus} />
          {codes.length > 0 && (
            <p className="tabular min-w-0 truncate font-mono text-[12px] leading-4 text-foreground-2" title={codes.join(' · ')} data-testid="step-codes">
              {codes.join(' · ')}
            </p>
          )}
        </div>
      </div>

      {/* Сводка шага: адрес и начало; тела открываются в большом окне. */}
      {(address || when) && (
        <dl className="grid min-w-0 shrink-0 grid-cols-[64px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[12.5px] leading-[18px]" data-testid="step-facts">
          {address && (
            <>
              <dt className="text-muted-foreground">{t('trace.details.address')}</dt>
              <dd className="min-w-0 truncate font-mono text-[12px] text-foreground-2" title={address} data-testid="step-address">
                {shortAddress(address)}
              </dd>
            </>
          )}
          {when && (
            <>
              <dt className="text-muted-foreground">{t('request.start')}</dt>
              <dd className="tabular min-w-0 text-foreground" data-testid="step-start">
                {when.time} · {t('trace.details.fromStart', { offset: formatOffset(step.startMs) })}
              </dd>
            </>
          )}
        </dl>
      )}

      {group && <GroupList group={group} selected={step.id} brief={brief} timeZone={timeZone} baseMs={trace.startTimeMs} onSelect={onSelect} />}

      {items.length > 0 && (
        <section className="flex min-w-0 shrink-0 flex-col" aria-labelledby={`step-data-${step.id}`} data-testid="step-data">
          <h3 id={`step-data-${step.id}`} className="mb-1.5 text-[12px] leading-4 font-semibold text-muted-foreground">
            {t('trace.details.data')}
          </h3>
          <div className="grid min-w-0 grid-cols-1 gap-1.5 md:max-xl:grid-cols-2">
            {items.map((item) => (
              <DataRow key={item.key} item={item} step={step} forms={forms} needles={needles} failed={failed} />
            ))}
          </div>
        </section>
      )}
      {request && (
        // relative: подпись кнопки меряется невидимым абсолютным элементом, он не должен вылезать за панель и удлинять страницу.
        <div className="relative -mt-1.5 flex h-7 shrink-0 items-center" data-testid="step-curl">
          <CurlSlot record={withRevealed(request, overlay)} withHeaders={blockVisible(view, mode, 'headers')} />
        </div>
      )}
      {blockVisible(view, mode, 'logs') && <StepLogs ids={logs?.get(step.id)} byId={byId} timeZone={timeZone} />}
      {hiddenPart && (
        <p className="flex min-w-0 shrink-0 flex-wrap items-center gap-x-2 text-[13px] text-muted-foreground" data-testid="step-more-details">
          {t('view.moreDetails')}
          <Button type="button" variant="ghost" size="sm" className="h-7 text-primary" onClick={() => setMode('full')}>
            {t('view.toFull')}
          </Button>
        </p>
      )}
    </div>
  );
}

// Номер, начало, пауза перед, длительность, итог: ширина панели от 380 px, итог забирает остаток.
const ATTEMPT_COLS = 'grid grid-cols-[24px_84px_76px_56px_minmax(0,1fr)] items-center gap-x-2 px-2';
const CALL_COLS = 'grid grid-cols-[24px_minmax(0,1fr)_60px_minmax(0,1fr)] items-center gap-x-2 px-2';

/** Итог строки списка: причина или слово, в «Кратко» без статуса и кодов. */
function entryResult(e: GroupEntry, brief: boolean, t: TFunction): { text: string; tone: 'success' | 'danger' | 'muted' } {
  const o = e.outcome;
  if (o.noResponse) return { text: t(noAnswerKey(o)), tone: o.pending ? 'muted' : 'danger' };
  if (o.tone === 'error') return { text: o.reason ? (brief ? meaningOf(o.reason) : o.reason) : t('flow.outcome.error'), tone: 'danger' };
  if (o.tone === 'success') return { text: !brief && o.http !== null ? `${t('flow.outcome.success')} · HTTP ${o.http}` : t('flow.outcome.success'), tone: 'success' };
  return { text: '', tone: 'muted' };
}

const RESULT_ICON = { success: CircleCheck, danger: CircleX, muted: Clock } as const;
const RESULT_TONE = { success: 'text-success', danger: 'text-danger', muted: 'text-muted-foreground' } as const;

/** Попытки группы или вызовы из свёрнутых веток. Строка выбирает шаг, граф при этом не двигается. Одинаковые подряд свёрнуты. */
function GroupList({ group, selected, brief, timeZone, baseMs, onSelect }: { group: StepGroup; selected: string; brief: boolean; timeZone: string; baseMs: number; onSelect?: ((stepId: string) => void) | undefined }) {
  const { t } = useTranslation();
  const [opened, setOpened] = useState<ReadonlySet<number>>(() => new Set());
  const parallel = group.kind === 'parallel';
  const rows = useMemo(() => foldAttempts(group.entries, selected, opened), [group, selected, opened]);
  const day = (ms: number) => timeParts(baseMs + ms, timeZone).date;
  // Через сутки время без даты вводит в заблуждение.
  const manyDays = group.entries.length > 0 && day(group.entries[0]!.startMs) !== day(group.entries.at(-1)!.startMs);
  const startOf = (ms: number) => {
    const { date, time } = timeParts(baseMs + ms, timeZone);
    return manyDays ? `${date.slice(0, 5)} ${time.slice(0, 5)}` : time.slice(0, 8);
  };
  return (
    <section className="min-w-0 shrink-0 overflow-hidden rounded-[10px] border border-border" aria-label={t(parallel ? 'trace.attempts.titleParallel' : 'trace.attempts.title')} data-testid="step-attempts" data-kind={group.kind}>
      <div className={cn(parallel ? CALL_COLS : ATTEMPT_COLS, 'h-7 border-b border-border bg-sub text-[12px] text-muted-foreground')} aria-hidden>
        <span>{t('trace.attempts.number')}</span>
        {parallel ? (
          <span>{t('trace.attempts.system')}</span>
        ) : (
          <>
            <span>{t('trace.attempts.start')}</span>
            <span className="truncate">{t('trace.attempts.pause')}</span>
          </>
        )}
        <span>{t('trace.attempts.duration')}</span>
        <span>{t('trace.attempts.result')}</span>
      </div>
      <ul className="max-h-[168px] overflow-y-auto text-[12.5px] leading-4">
        {rows.map((row) => {
          if (row.kind === 'fold') {
            const a = row.entries[0]!;
            const b = row.entries.at(-1)!;
            const result = entryResult(a, brief, t);
            return (
              <li key={`fold-${a.index}`} className="flex h-7 min-w-0 items-center gap-2 border-b border-border bg-sub px-2 last:border-b-0" data-testid="attempt-fold">
                <span className="tabular shrink-0 text-foreground-2">
                  {a.index}–{b.index}
                </span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground" title={[t('trace.attempts.same', { count: row.entries.length }), result.text].join(': ')}>
                  {t('trace.attempts.same', { count: row.entries.length })}: <span className={RESULT_TONE[result.tone]}>{result.text}</span>
                </span>
                <button type="button" className="shrink-0 text-primary underline-offset-2 hover:underline" onClick={() => setOpened((prev) => new Set(prev).add(a.index))}>
                  {t('trace.attempts.show', { count: row.entries.length })}
                </button>
              </li>
            );
          }
          const e = row.entry;
          const result = entryResult(e, brief, t);
          const Icon = RESULT_ICON[result.tone];
          const current = e.stepId === selected;
          const name = [brief || /[\s\p{Lu}]/u.test(e.name) ? briefSystem(e.name) : systemLabel(e.name), e.plain].filter(Boolean).join(' · ');
          return (
            <li key={e.index} className="border-b border-border last:border-b-0">
              <button
                type="button"
                aria-current={current || undefined}
                onClick={() => onSelect?.(e.stepId)}
                data-testid="attempt-row"
                className={cn(parallel ? CALL_COLS : ATTEMPT_COLS, 'h-7 w-full text-left transition-colors hover:bg-accent/60', current && 'bg-accent')}
              >
                <span className="tabular font-medium text-foreground">{e.index}</span>
                {parallel ? (
                  <span className="min-w-0 truncate text-foreground" title={name}>
                    {name}
                  </span>
                ) : (
                  <>
                    <span className="tabular truncate text-muted-foreground">{startOf(e.startMs)}</span>
                    <span className="tabular truncate text-muted-foreground" title={e.pauseMs !== null ? t('trace.attempts.pauseNote', { duration: formatDuration(e.pauseMs) }) : undefined} data-testid="attempt-pause">
                      {e.pauseMs !== null ? formatDuration(e.pauseMs) : '—'}
                    </span>
                  </>
                )}
                <span className="tabular truncate text-foreground-2">{e.durationMs !== null ? formatDuration(e.durationMs) : '—'}</span>
                <span className={cn('flex min-w-0 items-center gap-1', RESULT_TONE[result.tone])} title={result.text}>
                  {result.text && <Icon className="size-3.5 shrink-0" aria-hidden />}
                  <span className="min-w-0 truncate">{result.text}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Строка записи в панели шага: свёрнута до нажатия, раскрытая остаётся раскрытой при возврате к шагу. */
function PanelRecord({ record, timeZone }: { record: ViewRecord; timeZone: string }) {
  const memory = useContext(BlockMemoryContext)!;
  const key = recordKey(record.id);
  const expanded = memory.opened.get(key) ?? false;
  return <RecordItem record={record} timeZone={timeZone} mode="request" expanded={expanded} onToggle={() => memory.set(key, !expanded)} />;
}

/** Логи шага теми же строками, что на вкладке «Записи». Свёрнуты до нажатия: заголовок говорит, сколько в них ошибок и совпадений. */
function StepLogs({ ids, byId, timeZone }: { ids: readonly string[] | undefined; byId: ReadonlyMap<string, ViewRecord>; timeZone: string }) {
  const { t } = useTranslation();
  const records = useMemo(() => (ids ?? []).map((id) => byId.get(id)).filter((r): r is ViewRecord => r !== undefined), [ids, byId]);
  const memory = useContext(BlockMemoryContext)!;
  const open = memory.opened.get(LOGS_KIND) ?? false;
  // Свёрнутые логи всё равно говорят, что в них есть совпадение: число по тому же тексту, что в сырой записи.
  const forms = useContext(HitsContext);
  const overlay = useContext(RevealContext);
  const hits = useMemo(() => (forms ? records.reduce((n, r) => n + findHits(withRevealed(r, overlay).raw, forms).count, 0) : 0), [forms, records, overlay]);
  if (records.length === 0) return null;
  const errors = records.filter((r) => DANGER_LEVELS.has(r.level?.toUpperCase() ?? '')).length;
  const warnings = records.filter((r) => r.level?.toUpperCase() === 'WARNING').length;
  return (
    <section className="min-w-0 shrink-0 overflow-hidden rounded-[10px] border border-border" data-testid="step-logs">
      <h3 className="min-w-0">
        <button type="button" aria-expanded={open} onClick={() => memory.set(LOGS_KIND, !open)} className="flex h-[34px] w-full min-w-0 items-center gap-2 px-3 text-left text-[13px] font-semibold text-heading hover:bg-accent/40">
          <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} aria-hidden />
          {t('trace.details.stepLogs')}
          <span className="tabular text-[12px] font-normal text-muted-foreground">{formatInt(records.length)}</span>
          {errors > 0 && <span className="tabular inline-flex h-5 items-center rounded-[10px] bg-danger-bg px-2 text-[11.5px] font-semibold text-danger">{t('flow.logs.level', { count: errors, level: 'ERROR' })}</span>}
          {warnings > 0 && <span className="tabular inline-flex h-5 items-center rounded-[10px] bg-warning-bg px-2 text-[11.5px] font-semibold text-warning">{t('flow.logs.level', { count: warnings, level: 'WARNING' })}</span>}
          {hits > 0 && <HitCount count={hits} />}
        </button>
      </h3>
      <ol hidden={!open} className={cn(RECORD_LIST, 'rounded-none border-0 border-t shadow-none')} aria-label={t('trace.details.stepLogs')}>
        {records.map((r) => (
          <PanelRecord key={r.id} record={r} timeZone={timeZone} />
        ))}
      </ol>
    </section>
  );
}

const HTML_DOCUMENT = /^\s*(?:<!doctype\s+html\b|<html[\s>])/i;

/** Вид тела рядом с заголовком блока: «XML · HTTP 200». В «Кратко» статуса нет, как и в заголовке. */
function blockSummary(b: StepBlock['block'], r: ViewRecord, brief: boolean): string | undefined {
  if (b.name === 'request') return b.text;
  if (b.name === 'headers') return formatInt(b.text.split('\n').filter(Boolean).length);
  if (b.name === 'response' || b.name === 'body' || b.name === 'payload') {
    const lang = b.lang === 'text' ? null : HTML_DOCUMENT.test(b.text) ? 'HTML' : b.lang.toUpperCase();
    const status = !brief && b.name === 'response' && r.http?.status != null ? `HTTP ${r.http.status}` : null;
    return [lang, status].filter(Boolean).join(' · ') || undefined;
  }
  return undefined;
}

/** Блоки нескольких записей подписаны видом записи: адрес запроса над ответом не считается. */
const severalRecords = (list: readonly StepBlock[]): boolean => new Set(list.filter((x) => x.block.name !== 'request').map((x) => x.record.id)).size > 1;

/** Вкладка уже называет, что внутри: заголовок блока короткий. */
function blockTitle({ record: r, block: b }: StepBlock, several: boolean, t: TFunction): string {
  const kind = t(`record.kind.${r.kind}`);
  const titles: Record<typeof b.name, string> = {
    request: t('trace.details.address'),
    body: t('trace.details.body'),
    response: t('trace.details.body'),
    payload: b.title,
    headers: b.title,
    context: t('trace.details.context'),
    raw: `${kind} · ${formatOffset(r.offsetMs ?? 0)}`,
  };
  return several && b.name !== 'raw' && b.name !== 'request' ? `${titles[b.name]} · ${kind}` : titles[b.name];
}

/** Причина в теле: код прокручен к её строке. Нужны и поля справочника: правило итога может смотреть на другое поле. */
function stepReasonContext(step: TraceStep, byId: ReadonlyMap<string, ViewRecord>, t: TFunction): { needles: readonly (string | null | undefined)[]; failed: boolean } {
  const catalog = stepCatalog(step, byId);
  const line = catalogLine(stepOutcome(step, byId), step, catalog, { ok: t('trace.ok'), pending: t('catalog.verdict.pending'), ignored: t('catalog.verdict.ignored') });
  return { needles: [catalog?.error?.raw?.code, catalog?.error?.raw?.text, catalog?.outcome?.text, catalog?.error?.title], failed: line.tone === 'danger' };
}

/**
 * Данные шага строками панели и вкладками окна: блоки вкладок шага без адреса (он в сводке), заголовки запроса и ответа вместе,
 * вложенные тела — частями рядом со своим телом. Пустых строк нет.
 */
export function stepDataItems(step: TraceStep, blocks: ReadonlyMap<DetailTab, StepBlock[]>, t: TFunction): DataItem[] {
  const out = new Map<DataKey, DataPart[]>();
  const push = (key: DataKey, part: DataPart) => out.set(key, [...(out.get(key) ?? []), part]);
  for (const [tab, list] of blocks) {
    const several = severalRecords(list);
    list.forEach((b, i) => {
      if (b.block.name === 'request') return;
      const key: DataKey = b.block.name === 'headers' ? 'headers' : tab;
      const nth = list.slice(0, i).filter((x) => x.block.name === b.block.name).length;
      const target: WindowTarget = { step: step.id, tab, name: b.block.name, nth, record: null, nested: null };
      const label = key === 'headers' ? [t(`trace.details.tabs.${tab}`), several ? t(`record.kind.${b.record.kind}`) : null].filter(Boolean).join(' · ') : blockTitle(b, several, t);
      push(key, { target, item: b, label, nested: null });
      for (const n of b.block.nested?.items ?? []) push(key, { target: { ...target, nested: n.path }, item: b, label: n.title, nested: n });
    });
  }
  return DATA_KEYS.filter((k) => out.has(k)).map((k) => ({ key: k, parts: out.get(k)! }));
}

/** Текст части так, как его показывает окно в отформатированном виде. */
export const partText = (p: DataPart): string => p.nested?.text ?? p.item.block.text;

/** Совпадений с искомым значением во всех частях: то же число, что у счётчика в окне. */
export function dataHits(item: DataItem, forms: HitForms | null): number {
  if (!forms) return 0;
  return item.parts.reduce((n, p) => n + (p.item.block.empty ? 0 : findHits(partText(p), forms).count), 0);
}

const BODY_BLOCKS: ReadonlySet<string> = new Set(['response', 'body', 'payload', 'context']);

/** Вид и размер тела: «JSON · 1,2 КБ». */
export function bodyMeta(b: StepBlock['block'], t: TFunction): string {
  if (b.empty) return t('record.empty');
  const lang = b.lang === 'text' ? null : HTML_DOCUMENT.test(b.raw ?? b.text) ? 'HTML' : b.lang.toUpperCase();
  return [lang, formatSize(new TextEncoder().encode(b.raw ?? b.text).length)].filter(Boolean).join(' · ');
}

/** Что сказать о данных в строке панели: вид и размер тела, число заголовков или записей. */
export function dataMeta(item: DataItem, brief: boolean, t: TFunction): string | null {
  const own = item.parts.filter((p) => p.nested === null);
  if (item.key === 'headers') return formatInt(own.reduce((n, p) => n + p.item.block.text.split('\n').filter(Boolean).length, 0));
  if (item.key === 'raw') return formatInt(own.length);
  const body = own.find((p) => BODY_BLOCKS.has(p.item.block.name));
  if (!body) return null;
  const meta = bodyMeta(body.item.block, t);
  // Несколько записей с телом: сколько их, вид и размер — у первой.
  return own.length > 1 && !brief ? `${meta} · ${t('viewer.parts', { count: own.length })}` : meta;
}

/** Строка тела одной строкой в панели: строка причины ошибки, иначе первая строка с совпадением. */
export function dataExcerpt(item: DataItem, forms: HitForms | null, failed: boolean, needles: readonly (string | null | undefined)[]): { line: number; text: string; lang: HighlightLang } | null {
  const body = item.parts.find((p) => p.nested === null && BODY_BLOCKS.has(p.item.block.name) && !p.item.block.empty);
  if (!body) return null;
  const { block: b, record: r } = body.item;
  const lines = b.text.split('\n');
  const reasonAt = failed && b.name === 'response' ? reasonLine(b.text, r.sections.body, needles) : null;
  if (reasonAt !== null && lines[reasonAt]?.trim()) return { line: reasonAt, text: lines[reasonAt]!.trim(), lang: b.lang };
  const at = forms ? findHits(b.text, forms, 1).ranges[0]?.[0] : undefined;
  if (at === undefined) return null;
  const line = b.text.slice(0, at).split('\n').length - 1;
  return { line, text: lines[line]!.trim(), lang: b.lang };
}

/** Шаг для заголовка большого окна: номер и имя. Адрес обмена читаемым шаблоном: на месте PathTitle здесь строка. */
export function stepWindowPlace(step: TraceStep, trace: Trace, byId: ReadonlyMap<string, ViewRecord>, number: number | undefined, brief: boolean, t: TFunction): string {
  const name = stepName(step, trace, byId, brief, t) ?? readableTitle(step.title);
  return number === undefined ? name : `${t('code.window.step', { index: number })} · ${name}`;
}

/** Блок вкладки панели для большого окна: тот же заголовок, сводка и строка причины. Блока больше нет: null, окно закрывается. */
export function stepWindowBlock(target: WindowTarget, step: TraceStep, trace: Trace, byId: ReadonlyMap<string, ViewRecord>, overlay: RevealOverlay | null, view: ViewSettings, mode: ViewMode, number: number | undefined, t: TFunction): WindowBlock | null {
  if (target.tab === null) return null;
  const list = stepBlocks(step, byId, overlay, view, mode).get(target.tab) ?? [];
  const item = list.filter((x) => x.block.name === target.name)[target.nth];
  if (!item) return null;
  const { needles, failed } = stepReasonContext(step, byId, t);
  const reasonAt = failed && item.block.name === 'response' ? reasonLine(item.block.text, item.record.sections.body, needles) : null;
  const place = stepWindowPlace(step, trace, byId, number, mode === 'brief', t);
  const tab = t(`trace.details.tabs.${target.tab}`);
  return blockOrNested(item.block, `${step.id}|${target.tab}|${item.record.id}`, target, { title: blockTitle(item, severalRecords(list), t), summary: blockSummary(item.block, item.record, mode === 'brief'), reasonAt, place, tab, backLabel: windowBackLabel(number, t) });
}

/** Подпись ссылки из окна обратно к его шагу. */
export const windowBackLabel = (number: number | undefined, t: TFunction): string => (number === undefined ? t('code.window.toThisStep') : t('code.window.toStep', { index: number }));

function AppDetails({ summary, byId, trace, timeZone, onCollapse }: StepDetailsProps) {
  const { t } = useTranslation();
  const logs = summary.app.logs.map((s) => byId.get(s.id)).filter((r): r is ViewRecord => r !== undefined);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <p className="tabular flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 text-[12px] leading-5 text-muted-foreground">
            <span className="font-medium text-foreground">{t('trace.scheme.app')}</span>
            <span aria-hidden>·</span>
            <span>{t('requests.records', { count: summary.app.recordCount })}</span>
            <span aria-hidden>·</span>
            <span>{formatDuration(trace.totalMs)}</span>
          </p>
          {onCollapse && <CollapsePanel onCollapse={onCollapse} />}
        </div>
        <h2 className="text-[15px] leading-6 font-semibold text-heading" data-testid="step-title">
          {summary.app.component ?? '—'}
        </h2>
      </div>
      {logs.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">{t('trace.details.noLogs')}</p>
      ) : (
        <section className="flex min-w-0 flex-col gap-2">
          <h3 className="text-[13px] font-medium text-muted-foreground">
            {t('trace.details.appLogs')} · <span className="tabular">{formatInt(logs.length)}</span>
          </h3>
          <ol className={RECORD_LIST} aria-label={t('trace.details.appLogs')}>
            {logs.map((r) => (
              <PanelRecord key={r.id} record={r} timeZone={timeZone} />
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}
