import { buildTrace, type OperationKey, type RequestDetail, type RequestSummary, type SearchState, type Trace, type ViewRecord } from '@threadline/core/search';
import { buildFlowGraph, logsByStep, recordError, stepGroups, stepOrder, type OperationView } from '@threadline/core/flow';
import { anyDetailBlock, blockVisible, shownTab, visibleTabs, type RequestTab } from '@threadline/core/view';
import { ArrowLeft, ChevronDown, CircleX, Ellipsis, FileQuestion, Info, PanelRightOpen, RotateCcw, Search, ServerCrash, Unlink } from 'lucide-react';
import { flushSync } from 'react-dom';
import { Fragment, lazy, Suspense, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type ComponentType, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { formatDateTime, MAX_EPOCH_MS } from '@threadline/core';
import { Link, useLocation, useNavigate, useNavigationType, useParams, useSearchParams } from 'react-router';
import { ParamChips, PathTitle, titleParams } from '@/components/path/PathTitle.tsx';
import { GUTTERS, Page, WorkPage } from '@/components/shell/Page.tsx';
import { TimeWithZone } from '@/components/shell/TimeWithZone.tsx';
import { StateMessage } from '@/components/states/StateMessage.tsx';
import { Arrow } from '@/components/ui/arrow.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Chip } from '@/components/ui/chip.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.tsx';
import { CopyIconButton } from '@/components/ui/copy-button.tsx';
import { ExploreLinkButton } from '@/components/ui/explore-link.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs.tsx';
import { Tooltip } from '@/components/ui/tooltip.tsx';
import { FlowSlot } from '@/features/flow/FlowSlot.tsx';
import { OperationButton } from '@/features/operation/OperationButton.tsx';
import { OperationNav } from '@/features/operation/OperationNav.tsx';
import {
  chooseOperation,
  flowKey,
  flowPath,
  flowsOf,
  isNocid,
  linkTo,
  operationPath,
  readOperationHref,
  readOperationLink,
  relatedAfter,
  type OperationLinkState,
} from '@/features/operation/model.ts';
import { useStopOnLeave } from '@/features/operation/queries.ts';
import { describeError } from '@/features/search/errors.ts';
import { isExpired, useRequestDetail, useSearchState } from '@/features/search/queries.ts';
import { useSearchSession } from '@/features/search/session.tsx';
import { StatusChip } from '@/features/search/StatusChip.tsx';
import { ApiError } from '@/lib/api.ts';
import { useAccess } from '@/features/auth/access.tsx';
import { BusinessRequestSlot, BusinessSkeleton, useBusinessScreen } from '@/features/business/slot.tsx';
import { briefReason, catalogReasonView, chainLabels, chainNames, entryName, undescribedReason } from '@/features/catalog/names.ts';
import { shareRequestLink, useShareMode } from '@/features/share/mode.ts';
import { ShareButtonSpace, ShareSlot, zonedText, type ShareButtonProps } from '@/features/share/slot.tsx';
import { SupportContactSlot } from '@/features/tools/slot.tsx';
import { briefMethod, briefSystem, collapseNeighbours } from '@/features/view/brief.ts';
import { useView } from '@/features/view/context.tsx';
import { DetailSwitch } from '@/features/view/DetailSwitch.tsx';
import { formatDuration, formatInt, timeParts } from '@/lib/format.ts';
import { readableTitle } from '@/lib/path-template.ts';
import { useHotkey } from '@/lib/hotkeys.ts';
import { useMedia, WIDE } from '@/lib/use-media.ts';
import { readableDetails } from '@/lib/server-text.ts';
import { envPath, envsSearchPath, searchPath, type Selection } from '@/lib/selection.ts';
import { systemLabel } from '@/lib/systems.ts';
import { cn } from '@/lib/utils.ts';
import { useBlockMemory } from './block-memory.ts';
import type { CodeMode } from './CodeView.tsx';
import type { BodyViewerProps } from './BodyViewer.tsx';
import { DataViewerContext, recordWindowBlock, type DataKey, type DataViewerApi, type WindowTarget } from './code-window.ts';
import { CodeWindowScope } from './CodeWindowScope.tsx';
import { HitsContext, hitFormsOf, useHitSummary, type HitSummary } from './overlay.ts';
import { PanelHandle } from './PanelHandle.tsx';
import { RECORD_LIST, RecordItem } from './RecordItem.tsx';
import { RevealButton } from './RevealButton.tsx';
import { RevealContext, useReveal, type Reveal } from './reveal.ts';
import { groupReasons, reasonsOverCap, reasonWhere, rowAction, type ReasonRow } from './reasons.ts';
import { readListSteps, RESULT_NAV_PAGE, useOneMove } from './result-stepper.ts';
import { ResultNav, ResultStepper } from './ResultStepper.tsx';
import { PANEL_WIDTH, readPanel, useStepPanel } from './step-panel.ts';
import { StepDetails, stepWindowBlock, stepWindowPlace, windowBackLabel } from './StepDetails.tsx';
import { APP, appSummary, defaultSelection, neighbourStep, operationsByTarget, visibleSteps, type DetailTab } from './trace-model.ts';
import { TraceTimeline } from './TraceTimeline.tsx';
import { WhatToDo } from './WhatToDo.tsx';

const NO_STAYS: readonly string[] = [];

// Окно тела в ленивом чанке: большинство открытых запросов его не открывают. Сбой загрузки — окна нет, страница работает.
const BodyViewer = lazy((): Promise<{ default: ComponentType<BodyViewerProps> }> => import('./BodyViewer.tsx').catch(() => ({ default: () => null })));

/** Что странице запроса нужно от состояния поиска: опрос, который приносит только ход поиска, её не перерисовывает. */
const pageSlice = (s: SearchState) => ({ operation: s.operation ?? null, terms: s.terms });

// Проверка до обращения к серверу, как на сервере.
const CID = /^[A-Za-z0-9._:-]{1,128}$/;

function readSearchId(state: unknown): string | null {
  const v = (state as { searchId?: unknown } | null)?.searchId;
  return typeof v === 'string' && v ? v : null;
}

/** Среды поиска по нескольким средам из состояния перехода: по ним «К результатам» ведёт к общему списку. null — поиск одной среды. */
function readSearchEnvs(state: unknown): string[] | null {
  const v = (state as { envs?: unknown } | null)?.envs;
  return Array.isArray(v) && v.length > 1 && v.every((x) => typeof x === 'string' && /^[a-z0-9][a-z0-9-]{0,31}$/.test(x)) ? (v as string[]) : null;
}

/** Статус из строки результатов: заготовка страницы заранее оставляет место под причины ошибки. */
function readStatus(state: unknown): 'error' | 'success' | null {
  const v = (state as { status?: unknown } | null)?.status;
  return v === 'error' || v === 'success' ? v : null;
}

function readMs(v: string | null): number | null {
  if (v === null || !/^\d{1,16}$/.test(v)) return null;
  // Год 202333 в адресе: та же страница «Неверная ссылка», запроса к серверу нет.
  const ms = Number(v);
  return ms < MAX_EPOCH_MS ? ms : null;
}

export function RequestPage({ selection }: { selection: Selection }) {
  const { cid = '' } = useParams();
  const [params] = useSearchParams();
  const location = useLocation();
  const searchId = readSearchId(location.state);
  const searchEnvs = readSearchEnvs(location.state);
  const status = readStatus(location.state);
  const from = readMs(params.get('from'));
  const to = readMs(params.get('to'));
  const opLink = readOperationLink(location.state);
  const opHref = readOperationHref(params.get('op'));
  const view = `${cid}|${from}|${to}|${searchId ?? ''}`;
  const navigationType = useNavigationType();
  // Запрос открывается с начала страницы, а не с прокрутки списка результатов.
  // «Назад» и «Вперёд» (POP) прокрутку оставляют браузеру.
  useLayoutEffect(() => {
    if (navigationType !== 'POP') window.scrollTo(0, 0);
  }, [view, navigationType]);
  return (
    <WorkPage>
      <RequestView key={view} selection={selection} cid={cid} searchId={searchId} searchEnvs={searchEnvs} status={status} from={from} to={to} opLink={opLink} opHref={opHref} listSteps={opLink ? null : readListSteps(location.state)} />
    </WorkPage>
  );
}

/** «1 из N» со своим опросом: на опросе перерисовывается только он, а не страница запроса. Запрос состояния тот же, опрос не удваивается. */
function LiveResultNav({ back, searchId, cid, selection }: { back: ReactNode; searchId: string; cid: string; selection: Selection }) {
  const search = useSearchState(searchId);
  return <ResultNav back={back} searchId={searchId} cid={cid} selection={selection} state={search.data} gone={isExpired(search.error)} />;
}

/** То же «1 из N» справа в первой строке шапки открытого запроса. */
function LiveResultStepper({ searchId, cid, selection }: { searchId: string; cid: string; selection: Selection }) {
  const search = useSearchState(searchId);
  return <ResultStepper searchId={searchId} cid={cid} selection={selection} state={search.data} gone={isExpired(search.error)} inHeader />;
}

/** Возврат к результатам значком: подпись в подсказке и для чтения с экрана. */
export function BackLink({ label, className, ...props }: ComponentProps<typeof Link> & { label: string }) {
  return (
    <Tooltip content={label}>
      <Link aria-label={label} className={cn('inline-flex size-[30px] shrink-0 items-center justify-center rounded-[8px] text-foreground-2 transition-colors hover:bg-sunk hover:text-foreground', className)} {...props}>
        <ArrowLeft className="size-4" aria-hidden />
      </Link>
    </Tooltip>
  );
}

/** Обычное нажатие: без клавиш-модификаторов и не средней кнопкой (те открывают ссылку в новой вкладке). */
function plainClick(e: MouseEvent<HTMLAnchorElement>): boolean {
  return !e.defaultPrevented && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

function RequestView({
  selection,
  cid,
  searchId,
  searchEnvs,
  status,
  from,
  to,
  opLink,
  opHref,
  listSteps,
}: {
  selection: Selection;
  cid: string;
  searchId: string | null;
  /** Открыт строкой поиска по нескольким средам: среды того поиска. */
  searchEnvs: string[] | null;
  status: 'error' | 'success' | null;
  from: number | null;
  to: number | null;
  /** Запрос открыт со страницы операции: задание операции и адрес возврата. */
  opLink: OperationLinkState | null;
  /** Адрес операции из ссылки сегмента без correlation_id. */
  opHref: string | null;
  /** Открыт строкой списка: сколько переходов между результатами от неё сделано. null — не из списка. */
  listSteps: number | null;
}) {
  const { t } = useTranslation();
  const { project, env, stand } = selection;
  const validCid = CID.test(cid);
  // Сегмент записей без correlation_id есть только в задании операции: по ссылке хранилище не читается.
  const nocid = isNocid(cid);
  const detail = useRequestDetail({
    project: project.id,
    env: env.id,
    stand,
    cid: validCid ? cid : '',
    searchId: validCid ? searchId : null,
    jobEnv: searchEnvs ? env.id : undefined,
    from: nocid ? null : from,
    to: nocid ? null : to,
  });
  // Поиск, из которого открыт запрос, может ещё идти: без опроса сервер остановит его через 90 с.
  // Тот же запрос состояния, что на странице поиска, — опрос не удваивается. Задание операции даёт ещё
  // «Поток N из M» и более поздние потоки для графа.
  // Страница берёт только свой срез: «1 из N» опрашивает состояние сам (LiveResultNav), записи на опросе не перерисовываются.
  const searched = useSearchState(searchId, pageSlice).data;
  const operation = searched?.operation ?? null;
  // Значения подсветки — из того же состояния. После истечения поиска они остаются, пока страница не перезагружена.
  const terms = searched?.terms;
  const forms = useMemo(() => hitFormsOf(terms), [terms]);
  useStopOnLeave(opLink ? opLink.searchId : null, opLink?.operation.href ?? '');
  const navigate = useNavigate();
  const session = useSearchSession();
  const oneMove = useOneMove();
  const business = useBusinessScreen();
  // Ключ строки списка: у поиска по нескольким средам со средой этой страницы.
  const rowKey = searchEnvs ? `${env.id}/${cid}` : cid;

  // Запрос открыт из результатов (searchId в состоянии ставит только ссылка из них): результаты лежат в истории
  // перед ним и перед переходами между соседними результатами. Возврат идёт по истории, без новой записи:
  // «Назад» браузера потом не ведёт снова сюда. Строку в фокус ставит открытый сейчас запрос из памяти вкладки.
  const back = opLink ? (
    <OperationNav link={opLink} operation={operation} cid={cid} selection={selection} />
  ) : searchId ? (
    <BackLink
      to={searchEnvs ? envsSearchPath(project.id, searchEnvs, searchId) : searchPath(project.id, env.id, stand, searchId)}
      state={{ focusCid: rowKey }}
      label={t('request.back')}
      onClick={(e) => {
        if (!plainClick(e)) return;
        e.preventDefault();
        oneMove(() => {
          if (listSteps !== null) session.saveUi(searchId, { openedCid: rowKey });
          void navigate(-((listSteps ?? 0) + 1));
        });
      }}
    />
  ) : null;
  // Из списка: соседние результаты справа в шапке; пока запрос ещё читается или не открылся — рядом с возвратом.
  const stepper = searchId && listSteps !== null ? <LiveResultStepper searchId={searchId} cid={cid} selection={selection} /> : null;
  const nav = searchId && listSteps !== null ? <LiveResultNav back={back} searchId={searchId} cid={cid} selection={selection} /> : back;

  // Запроса не открыть: следующий шаг — новый поиск в этой среде.
  const toSearch = (
    <Button asChild variant={searchId ? 'secondary' : 'default'}>
      <Link to={envPath(project.id, env.id, stand)}>
        <Search aria-hidden />
        {t('request.toSearch')}
      </Link>
    </Button>
  );

  let body: ReactNode;
  if (validCid && nocid && detail.noBounds) {
    body = (
      <StateMessage icon={Unlink} tone="warning" title={t('operation.reopen')}>
        {opHref ? (
          <Button asChild>
            <Link to={opHref}>{t('operation.open')}</Link>
          </Button>
        ) : (
          toSearch
        )}
      </StateMessage>
    );
  } else if (!validCid || detail.noBounds) {
    body = (
      <StateMessage icon={Unlink} tone="warning" title={t('request.badLink.title')} text={t('request.badLink.text')}>
        {toSearch}
      </StateMessage>
    );
  } else if (detail.data) {
    body = <RequestContent data={detail.data} selection={selection} searchId={searchId} operation={opLink ? { link: opLink, view: operation } : null} back={back} stepper={stepper} fill />;
  } else if (detail.error) {
    const e = detail.error;
    if (e instanceof ApiError && e.code === 'request-not-found') {
      body = (
        <StateMessage icon={FileQuestion} tone="warning" title={t('request.notFound.title')} text={t('request.notFound.text', { count: project.retentionDays })}>
          {toSearch}
        </StateMessage>
      );
    } else if (e instanceof ApiError && e.code === 'bad-request') {
      body = (
        <StateMessage icon={Unlink} tone="warning" title={t('request.badLink.title')} text={readableDetails(e.details) ?? t('request.badLink.text')}>
          {toSearch}
        </StateMessage>
      );
    } else {
      const d = describeError(t, e);
      body = (
        <StateMessage icon={ServerCrash} tone="danger" title={t('request.failed')} text={business ? t('request.failedPlain') : [d.title, d.advice ?? readableDetails(d.details)].filter(Boolean).join('. ')}>
          <Button onClick={() => void detail.refetch()}>
            <RotateCcw aria-hidden />
            {t('states.retry')}
          </Button>
        </StateMessage>
      );
    }
  } else {
    body = business ? <BusinessSkeleton head={nav} /> : <RequestSkeleton reasons={status === 'error'} back={back} stepper={stepper} fill />;
  }

  // Шапка запроса сама ставит ссылку «назад» и «N из M»; остальным состояниям — та же строка над сообщением (у Бизнеса — прежняя строка возврата).
  const ready = validCid && !detail.noBounds && (detail.data || !detail.error);
  return (
    <HitsContext.Provider value={forms}>
      {ready ? (
        body
      ) : business ? (
        <Page className={searchId && listSteps !== null ? RESULT_NAV_PAGE : undefined}>
          {nav}
          {body}
        </Page>
      ) : (
        <>
          {(back || stepper) && <NavLine back={back} stepper={stepper} />}
          <Page className={back || stepper ? 'pt-4 lg:pt-4' : undefined}>{body}</Page>
        </>
      )}
    </HitsContext.Provider>
  );
}

/** Строка возврата и «N из M», пока запрос читается или не открылся: те же места, что в шапке открытого запроса, стрелки не уходят из-под указателя. */
export function NavLine({ back, stepper }: { back: ReactNode; stepper: ReactNode }) {
  return (
    <div className={cn(GUTTERS, 'pt-3')} data-testid="request-nav">
      <div className={HEADER_TOP}>
        {back && <div className="-ml-1.5 flex shrink-0 items-center [&>*]:mb-0">{back}</div>}
        <span className="flex-1" />
        {stepper}
        {stepper && <ShareButtonSpace />}
      </div>
    </div>
  );
}

// Схема или шкала слева, панель шага справа от 1280: 400 px, пока человек не поменял ширину; ниже — панель под ними, страница прокручивается.
// Страница в размер окна (fill): прокручивают части, колонки во всю высоту.
// Широкое и низкое окно (от 1280, ниже 700): компактный режим, страница прокручивается, но панель шага остаётся справа, а схема прилипает под шапкой и под неё не уходит.
// Схема — точечный холст без рамки от края страницы до панели шага; уже 1280 — во всю ширину окна, панель шага под ней.
const SPLIT_FILL = cn('flex min-w-0 flex-col gap-3.5 compact:pb-5 work:min-h-0 work:flex-1 work:flex-row work:gap-0', 'compact:px-[var(--page-gutter)]', '[@media(min-width:1280px)_and_(max-height:699.98px)]:flex-row [@media(min-width:1280px)_and_(max-height:699.98px)]:items-start [@media(min-width:1280px)_and_(max-height:699.98px)]:gap-5 [@media(min-width:1280px)_and_(max-height:699.98px)]:pt-4');
const SPLIT_FLOW = 'grid min-w-0 gap-4 pt-4 work:grid-cols-[minmax(0,1fr)_clamp(380px,var(--step-panel-w,400px),50vw)]';
const LOW_STICKY = '[@media(min-width:1280px)_and_(max-height:699.98px)]:sticky [@media(min-width:1280px)_and_(max-height:699.98px)]:top-[64px] [@media(min-width:1280px)_and_(max-height:699.98px)]:flex-1';
const LEFT_FILL = cn('flex min-w-0 flex-col max-xl:-mx-[var(--page-gutter)] work:min-h-0 work:flex-1 [@media(min-width:1280px)_and_(max-height:699.98px)]:-ml-[var(--page-gutter)]', LOW_STICKY);
const LEFT_TIMELINE_FILL = cn('flex min-w-0 flex-col compact:pt-4 work:min-h-0 work:flex-1 work:pt-4 work:pr-5 work:pb-4 work:pl-[var(--page-gutter)]', LOW_STICKY);

interface RequestContentProps {
  data: RequestDetail;
  selection: Selection;
  searchId: string | null;
  operation: { link: OperationLinkState; view: OperationView | null } | null;
  /** Ссылка назад: первой в строке шапки. */
  back?: ReactNode;
  /** «N из M» соседних результатов: справа в строке шапки. */
  stepper?: ReactNode;
  /** Пометка перед кнопкой «Поделиться»: на странице ссылки срок и маска. */
  headerNote?: ReactNode;
  /** Страница в размер окна в рабочем режиме. */
  fill?: boolean;
}

/** Содержимое страницы запроса: его же показывает страница короткой ссылки. У Бизнеса на его страницах свой экран. */
export function RequestContent(props: RequestContentProps) {
  // У Бизнеса возврат и соседние результаты одной строкой над экраном, как раньше.
  const back = props.stepper ? (
    <div className="mb-3 flex min-w-0 shrink-0 items-center gap-1.5 [&>*]:mb-0">
      {props.back}
      {props.stepper}
    </div>
  ) : (props.back ?? null);
  return useBusinessScreen() ? <BusinessRequestSlot data={props.data} selection={props.selection} back={back} /> : <FullRequestContent {...props} />;
}

function FullRequestContent({ data, selection, searchId, operation, back = null, stepper = null, headerNote = null, fill = false }: RequestContentProps) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { mode, view: settings } = useView();
  const share = useShareMode();
  const canOpen = useAccess().can('reveal') && share === null;
  const s = data.summary;
  const tz = selection.project.timezone;
  const trace = useMemo(() => buildTrace(data.records), [data.records]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- подпись шлюза на языке интерфейса
  const summary = useMemo(() => appSummary(trace, data.records), [trace, data.records, i18n.language]);
  const byId = useMemo(() => new Map(data.records.map((r) => [r.id, r])), [data.records]);

  // Выбор шага общий для схемы и шкалы; вкладка подробностей и вид кода — тоже.
  // Состояние пользователя при смене режима не сбрасывается: действующие вкладка и шаг вычисляются при рендере.
  const [chosenTab, setChosenTab] = useState<RequestTab | null>(null);
  const shown = shownTab(settings, mode, chosenTab);
  const tabs = visibleTabs(settings, mode);
  const [visited, setVisited] = useState<ReadonlySet<RequestTab>>(() => new Set([shown]));
  useEffect(() => {
    setVisited((prev) => (prev.has(shown) ? prev : new Set(prev).add(shown)));
  }, [shown]);
  // Из операции сегмент открывается своим первым шагом.
  const [selected, setSelected] = useState<string | null>(() => {
    const step = operation?.link.operation.step;
    const first = step ? trace.steps.find((x) => x.id === step || x.recordIds.includes(step)) : undefined;
    return first?.id ?? defaultSelection(trace, byId);
  });
  const [detailTab, setDetailTab] = useState<DetailTab | null>(null);
  const [codeMode, setCodeMode] = useState<CodeMode>(settings.bodyView);
  const detailsRef = useRef<HTMLElement>(null);
  const blockMemory = useBlockMemory();
  // Ширина и свёрнутость панели действуют от 1280: ниже панель стоит под схемой и не сворачивается.
  const panel = useStepPanel();
  const { update: updatePanel, collapsed } = panel;
  const reopenRef = useRef<HTMLButtonElement>(null);
  const select = useCallback(
    (stepId: string) => {
      setSelected(stepId);
      updatePanel({ collapsed: false });
    },
    [updatePanel],
  );
  const collapsePanel = useCallback(() => {
    flushSync(() => updatePanel({ collapsed: true }));
    reopenRef.current?.focus({ preventScroll: true });
  }, [updatePanel]);
  // «К первому»: цель перехода живёт здесь, потому что список записей монтируется при первом показе вкладки.
  const [hitTarget, setHitTarget] = useState<HitTarget | null>(null);

  const openDetails = useCallback(() => {
    // Панель свёрнута: сначала она появляется, скрытому элементу фокус не поставить.
    flushSync(() => updatePanel({ collapsed: false }));
    detailsRef.current?.scrollIntoView({ block: 'nearest' });
    detailsRef.current?.focus({ preventScroll: true });
  }, [updatePanel]);

  // Граф: более поздние потоки операции, шкала времени вместо графа, переход к потоку операции.
  const opView = operation?.view ?? null;
  const opLinkState = operation?.link ?? null;
  const openKey = flowKey({ cid: s.correlationId, segment: opLinkState?.operation.segment ?? null });
  const related = useMemo(() => relatedAfter(opView, openKey), [opView, openKey]);
  // Логи узлов: то же правило активного узла, что у значка на схеме. Те же группы и номера шагов в панели.
  const { stepLogs, groups, stepNumber } = useMemo(() => {
    try {
      const graph = buildFlowGraph(trace, data.records, { related: [] });
      return { stepLogs: logsByStep(graph), groups: stepGroups(graph), stepNumber: stepOrder(graph) };
    } catch {
      return { stepLogs: new Map<string, string[]>(), groups: undefined, stepNumber: undefined };
    }
  }, [trace, data.records]);
  const app = useMemo(
    () => ({ count: summary.app.logs.length, warnings: summary.app.warnings, errors: summary.app.errors }),
    [summary],
  );
  const toTimeline = useCallback((stepId: string | null) => {
    if (stepId) select(stepId);
    setChosenTab('timeline');
  }, [select]);
  const logsOn = blockVisible(settings, mode, 'logs');
  const steps = useMemo(() => visibleSteps(trace, byId, logsOn), [trace, byId, logsOn]);
  const timelineTrace = useMemo(() => ({ ...trace, steps: [...steps] }), [trace, steps]);
  // Выбранный шаг скрыт в режиме: действует шаг по умолчанию среди видимых, при возврате выбор прежний.
  const activeStep = useMemo(() => {
    if (selected === APP) return logsOn ? APP : defaultSelection(trace, byId, steps);
    return selected !== null && steps.some((x) => x.id === selected) ? selected : defaultSelection(trace, byId, steps);
  }, [selected, logsOn, trace, byId, steps]);
  // J и K: соседний шаг на схеме и шкале. Узел на схеме показывает себя сам, строку шкалы прокручиваем сюда. Фокус на строке или узле идёт за выбором.
  const stepKey = (delta: 1 | -1) => () => {
    const next = neighbourStep(steps, activeStep, delta);
    if (!next || next === activeStep) return;
    const wasOn = document.activeElement?.closest('[role=option][data-step], button[data-node]');
    flushSync(() => select(next));
    const row = document.querySelector<HTMLElement>(`[role=option][data-step="${CSS.escape(next)}"]`);
    row?.scrollIntoView({ block: 'nearest' });
    if (wasOn && row) row.focus({ preventScroll: true });
    // Узлы графа обновляет его собственное хранилище, остановка Tab переезжает к следующему кадру.
    else if (wasOn) requestAnimationFrame(() => document.querySelector<HTMLElement>('button[data-node][tabindex="0"]')?.focus({ preventScroll: true }));
  };
  useHotkey('next', shown === 'records' ? null : stepKey(1));
  useHotkey('prev', shown === 'records' ? null : stepKey(-1));
  const { project, env, stand } = selection;
  const reveal = useReveal({ project: project.id, env: env.id, stand: stand ?? null, cid: s.correlationId, searchId, firstMs: s.firstMs, lastMs: s.lastMs }, data.records);
  const forms = useContext(HitsContext);
  const hitSummary = useHitSummary(data.records, forms, reveal.overlay);
  // Показ снимается той же функцией, что «Скрыть»: иначе открытые значения остались бы в памяти без кнопки.
  const canReveal = anyDetailBlock(settings, mode);
  const revealStatus = reveal.status;
  const revealOff = reveal.off;
  useEffect(() => {
    if (!canReveal && revealStatus !== 'off') revealOff();
  }, [canReveal, revealStatus, revealOff]);
  const toFirstHit = useCallback((id: string) => {
    setChosenTab('records');
    setHitTarget((prev) => ({ id, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);
  const toRelated = useCallback(
    (key: string | null) => {
      if (!opLinkState) return;
      const flow = key ? (flowsOf(opView).find((f) => flowKey(f) === key) ?? null) : null;
      if (!flow) return void navigate(opLinkState.operation.href);
      if (share) {
        const link = shareRequestLink(share, { cid: flow.cid, segment: flow.segment, step: flow.firstRecordId });
        return void navigate(link.to, { state: link.state });
      }
      void navigate(flowPath(project.id, env.id, stand, flow, opLinkState.operation.href), { state: linkTo(opLinkState, flow) });
    },
    [opLinkState, opView, navigate, project.id, env.id, stand, share],
  );
  // Действие «Открыть операцию» на узле с ключом — только у запроса, открытого не из операции.
  const nodeKeys = useMemo(() => (operation || share ? [] : (data.operationKeys ?? [])), [operation, share, data.operationKeys]);
  const openOperation = useCallback(
    (k: OperationKey) => {
      const also = chooseOperation(nodeKeys)?.also.filter((x) => x.type !== k.type) ?? [];
      void navigate(operationPath(project.id, env.id, stand, { type: k.type, value: k.value, atMs: s.firstMs, also }));
    },
    [nodeKeys, navigate, project.id, env.id, stand, s.firstMs],
  );

  const details = () => (
    <StepDetails
      ref={detailsRef}
      trace={trace}
      summary={summary}
      byId={byId}
      selected={activeStep}
      tab={detailTab}
      onTab={setDetailTab}
      mode={codeMode}
      onMode={setCodeMode}
      timeZone={tz}
      logs={logsOn ? stepLogs : undefined}
      groups={groups}
      stepNumber={stepNumber}
      onSelect={select}
      fill={fill}
      memory={blockMemory}
      requestStatus={s.status}
      {...(fill ? { onCollapse: collapsePanel } : {})}
      className={fill && collapsed ? 'xl:hidden!' : undefined}
    />
  );
  const handle = fill && !collapsed && <PanelHandle width={panel.width} max={panel.max} onWidth={(width) => updatePanel({ width })} />;
  const splitStyle = { '--step-panel-w': `${panel.saved}px` } as CSSProperties;

  // Большое окно кода закреплено за блоком, из которого открыто: блок находится заново при смене режима, показа, языка и записей, а выбор шага его не меняет.
  const overlay = reveal.overlay;
  const recordsOn = tabs.includes('records');
  const schemeOn = tabs.includes('scheme');
  const order = stepNumber?.order;
  const resolveWindow = useCallback(
    (target: WindowTarget) => {
      const { step: stepId, record } = target;
      const step = steps.find((x) => x.id === stepId);
      const number = step ? order?.get(step.id) : undefined;
      if (record === null) return step ? stepWindowBlock(target, step, trace, byId, overlay, settings, mode, number, t) : null;
      const r = byId.get(record);
      // Вкладку «Записи» или логи шага режим мог убрать: блока, из которого открыто окно, больше нет.
      if (stepId === null) return recordsOn ? recordWindowBlock(target, r, overlay, settings, mode, { place: t('request.tabs.records'), backLabel: null }) : null;
      if (!logsOn) return null;
      if (stepId === APP) return recordWindowBlock(target, r, overlay, settings, mode, { place: t('trace.details.appLogs'), backLabel: t('code.window.toAppLogs') });
      return step ? recordWindowBlock(target, r, overlay, settings, mode, { place: `${stepWindowPlace(step, trace, byId, number, mode === 'brief', t)} · ${t('trace.details.stepLogs')}`, backLabel: windowBackLabel(number, t) }) : null;
    },
    [steps, order, byId, overlay, settings, mode, trace, recordsOn, logsOn, t],
  );
  // Обратно к шагу окна: сам шаг, его вкладка панели и панель на экране. С вкладки «Записи» панели не видно, поэтому сначала к схеме.
  const toWindowStep = useCallback(
    (target: WindowTarget) => {
      if (target.step === null) return;
      const { step: stepId, tab } = target;
      flushSync(() => {
        select(stepId);
        if (tab) setDetailTab(tab);
        if (shown === 'records') setChosenTab(schemeOn ? 'scheme' : 'timeline');
      });
      detailsRef.current?.scrollIntoView({ block: 'nearest' });
      detailsRef.current?.focus({ preventScroll: true });
    },
    [select, shown, schemeOn],
  );
  const windowBack = useMemo(() => ({ current: shown === 'records' ? null : activeStep, go: toWindowStep }), [shown, activeStep, toWindowStep]);
  // Окно тела: его шаг — выбранный на странице, J и K в окне выбирают соседний шаг и здесь. Закрытие возвращает фокус на строку данных.
  const [viewer, setViewer] = useState<{ item: DataKey; opener: HTMLElement | null } | null>(null);
  const viewerApi = useMemo<DataViewerApi>(() => ({ open: (stepId, item, opener) => {
    select(stepId);
    setViewer({ item, opener });
  } }), [select]);

  const brief = mode === 'brief';
  const requestTitle = s.incoming ? (entryName(s) ?? (brief ? briefMethod({ uri: `${s.incoming.method} ${s.incoming.path}` }) : readableTitle(`${s.incoming.method} ${s.incoming.path}`))) : t('request.backgroundTitle');
  const frame = useMemo(
    () => ({ title: `${selection.project.name} · ${requestTitle}`, duration: formatDuration(trace.totalMs), note: brief ? undefined : t('requests.records', { count: data.records.length }) }),
    [selection.project.name, requestTitle, trace.totalMs, brief, t, data.records.length],
  );
  const entry = useMemo(() => ({ status: s.status, time: timeParts(trace.startTimeMs || s.firstMs, tz).time.slice(0, 8) }), [s.status, trace.startTimeMs, s.firstMs, tz]);
  const split = fill ? SPLIT_FILL : SPLIT_FLOW;
  const shareProps = useMemo(() => requestShare(t, s, selection, { title: requestTitle, atMs: trace.startTimeMs || s.firstMs, reason: firstReasonText(s, trace, byId, brief) }), [t, s, selection, requestTitle, trace, byId, brief]);

  return (
    <RevealContext.Provider value={reveal.overlay}>
    <CodeWindowScope resolve={resolveWindow} back={windowBack}>
    <DataViewerContext.Provider value={viewerApi}>
    <div className={cn('flex min-w-0 flex-col', fill && 'work:min-h-0 work:flex-1')} data-testid="request-page">
      <div className={cn('flex shrink-0 flex-col gap-2.5', fill && cn(GUTTERS, 'pt-3'))}>
        <RequestHeader s={s} trace={trace} byId={byId} selection={selection} operationKeys={data.operationKeys} reveal={canOpen && (data.reveal?.kinds.length ?? 0) > 0 && canReveal ? reveal : null} revealStays={data.reveal?.stays ?? NO_STAYS} explore={data.explore} back={back} stepper={stepper} note={headerNote} shareProps={shareProps} />
        {s.reasons.length > 0 && <Reasons s={s} trace={trace} byId={byId} projectName={selection.project.name} share={<ShareSlot {...shareProps} />} stepNumber={stepNumber?.order} />}
      </div>

      <Tabs
        value={shown}
        onValueChange={(v) => setChosenTab(v as RequestTab)}
        className={cn('flex min-w-0 flex-col', fill && 'work:min-h-0 work:flex-1')}
      >
        {/* Та же строка, что у вкладок результатов: высота одна, есть сводка или нет. */}
        <div className={cn('shrink-0 pt-2.5', fill && GUTTERS)}>
        <div className="relative flex h-10 items-end justify-between gap-x-4 border-b border-border">
          <TabsList aria-label={t('request.tabs.label')} className="shrink-0 border-b-0">
            {tabs.includes('scheme') && <TabsTrigger value="scheme">{t('request.tabs.scheme')}</TabsTrigger>}
            <TabsTrigger value="timeline">{t('request.tabs.timeline')}</TabsTrigger>
            {tabs.includes('records') && (
              <TabsTrigger value="records">
                {t('request.tabs.records')}
                <span className="tabular font-normal text-muted-foreground">{formatInt(data.records.length)}</span>
              </TabsTrigger>
            )}
          </TabsList>
          {/* Сводка обрезается многоточием. Режим показа живёт в меню профиля; на странице ссылки профиля нет, переключатель здесь. */}
          <div className="flex h-10 min-w-0 items-center justify-end gap-x-4">
            {mode === 'full' && hitSummary && <HitSummaryLine summary={hitSummary} onFirst={tabs.includes('records') ? toFirstHit : null} />}
            {share && <DetailSwitch />}
            {fill && collapsed && shown !== 'records' && (
              <Button ref={reopenRef} type="button" variant="ghost" size="sm" className="hidden h-7 shrink-0 text-primary xl:inline-flex" data-testid="panel-open" onClick={openDetails}>
                <PanelRightOpen aria-hidden />
                {t('trace.panel.open')}
              </Button>
            )}
          </div>
        </div>
        </div>

        <TabsContent value="scheme" className={cn('flex min-w-0 flex-col outline-none', fill && 'work:min-h-0 work:flex-1')}>
          {trace.steps.length === 0 ? (
            <p className={cn('pt-4 text-muted-foreground', fill && GUTTERS)}>{t('trace.empty')}</p>
          ) : (
            <div className={split} style={splitStyle}>
              <div className={fill ? LEFT_FILL : 'min-w-0'}>
                <FlowSlot
                  trace={trace}
                  records={data.records}
                  incomplete={s.incomplete}
                  related={related}
                  app={app}
                  logs={logsOn}
                  steps={steps.length}
                  selected={activeStep}
                  onSelect={select}
                  onOpen={openDetails}
                  onTimeline={toTimeline}
                  onRelated={toRelated}
                  operationKeys={nodeKeys}
                  onOperation={openOperation}
                  fill={fill}
                  className={fill ? 'work:min-h-0 work:flex-1' : undefined}
                  frame={frame}
                  entry={entry}
                  refitKey={`${collapsed}|${panel.width}`}
                />
              </div>
              {handle}
              {details()}
            </div>
          )}
        </TabsContent>

        <TabsContent value="timeline" className={cn('flex min-w-0 flex-col outline-none', fill && 'work:min-h-0 work:flex-1')}>
          {trace.steps.length === 0 ? (
            <p className={cn('pt-4 text-muted-foreground', fill && GUTTERS)}>{t('trace.empty')}</p>
          ) : (
            <div className={split} style={splitStyle}>
              <div className={fill ? LEFT_TIMELINE_FILL : 'min-w-0'}>
                <TraceTimeline trace={timelineTrace} byId={byId} selected={activeStep} onSelect={select} onOpen={openDetails} className={fill ? 'work:max-h-full work:overflow-y-auto [@media(min-width:1280px)_and_(max-height:699.98px)]:max-h-[calc(100dvh-84px)] [@media(min-width:1280px)_and_(max-height:699.98px)]:overflow-y-auto' : undefined} />
              </div>
              {handle}
              {details()}
            </div>
          )}
        </TabsContent>

        {/* Записи остаются смонтированными после первого открытия: раскрытые блоки не сворачиваются. */}
        <TabsContent value="records" forceMount className={cn('min-w-0 pt-4 outline-none data-[state=inactive]:hidden', fill && cn(GUTTERS, 'pb-5 work:min-h-0 work:flex-1 work:overflow-y-auto'))} data-testid="records-tab">
          {(visited.has('records') || shown === 'records') && <RecordsList data={data} timeZone={tz} target={hitTarget} />}
        </TabsContent>
      </Tabs>
      {viewer && activeStep && (
        <Suspense fallback={null}>
          <BodyViewer stepId={activeStep} trace={trace} byId={byId} steps={steps} stepNumber={stepNumber} timeZone={tz} item={viewer.item} onItem={(item) => setViewer((v) => v && { ...v, item })} onStep={select} onClose={() => setViewer(null)} opener={viewer.opener} />
        </Suspense>
      )}
    </div>
    </DataViewerContext.Provider>
    </CodeWindowScope>
    </RevealContext.Provider>
  );
}

const SOURCE_ICON = { external: CircleX, project: CircleX, unknown: CircleX, pending: Info } as const;

/** Что записать в ссылку на запрос: correlation_id и границы самого запроса. У сегмента без correlation_id ссылки нет: поделиться можно самой операцией. */
/** Первая причина для текста тикета: те же слова, что в блоке «Что случилось» и в том же режиме. */
export function firstReasonText(s: RequestSummary, trace: Trace, byId: ReadonlyMap<string, ViewRecord>, brief: boolean): { text: string | null; where: string | null } {
  const reason = s.reasons.find((r) => r.kind !== 'pending');
  if (!reason) return { text: null, where: null };
  const v = catalogReasonView(reason);
  const operation = (v.target && operationsByTarget(trace, byId).get(v.target)) || null;
  const short = brief ? briefReason(v, operation) : null;
  return { text: v.message, where: (short ? [short.system, short.call] : [v.system, operation ?? v.call]).filter(Boolean).join(', ') || null };
}

export function requestShare(t: TFunction, s: RequestSummary, { project, env, stand }: Selection, about: { title: string; atMs: number; reason: { text: string | null; where: string | null } }): ShareButtonProps {
  const target = isNocid(s.correlationId) ? null : { kind: 'request' as const, project: project.id, env: env.id, ...(stand ? { stand } : {}), cid: s.correlationId, fromMs: s.firstMs, toMs: s.lastMs };
  return {
    target,
    timeZone: project.timezone,
    ticket: {
      title: `${about.title} · ${t(`requests.status.${s.status}`)}`,
      at: zonedText(formatDateTime(about.atMs, project.timezone), project.timezone, about.atMs),
      env: stand ? `${env.name} · ${t('header.standNumber', { number: stand })}` : env.name,
      reason: about.reason.text,
      where: about.reason.where,
      // У сегмента без correlation_id id запроса — внутренний ключ: в текст тикета он не идёт.
      requestId: target ? s.correlationId : null,
    },
  };
}

/**
 * Причины ошибки одной спокойной строкой: первая причина, где и коды; остальные причины, «Что делать» и строка о неописанной
 * ошибке раскрываются по нажатию и до того не сдвигают схему. Без адресов с портами — система и операция; полный текст — в подсказке.
 */
export function Reasons({ s, trace, byId, projectName, share, stepNumber }: { s: RequestSummary; trace: Trace; byId: ReadonlyMap<string, ViewRecord>; projectName: string; /** Кнопка «Поделиться» рядом со строкой о неописанной ошибке. */ share?: ReactNode; /** Номер шага на графе: «Процессинг · шаг 3» у первой причины. */ stepNumber?: ReadonlyMap<string, number> | undefined }) {
  const { t } = useTranslation();
  const brief = useView().mode === 'brief';
  // Маршрут контакта закрыт без входа: со страницы ссылки его ответ увёл бы на вход.
  const onLink = useShareMode() !== null;
  // Без права на подробности причины сверх пяти показываются теми же словами, что серверные: только справочник и общие слова.
  const restricted = !useAccess().can('details');
  const bodyId = useId();
  const [open, setOpen] = useState(false);
  const ops = useMemo(() => operationsByTarget(trace, byId), [trace, byId]);
  const ordered = useMemo(() => [...s.reasons.filter((r) => r.kind !== 'pending'), ...reasonsOverCap(s, byId.values(), restricted), ...s.reasons.filter((r) => r.kind === 'pending')], [s, byId, restricted]);
  const views = useMemo(() => ordered.map((r) => catalogReasonView(r)), [ordered]);
  const errors = views.some((v) => v.source !== 'pending');
  const rows = useMemo(() => groupReasons(views), [views]);
  // Число в строке — ровно то, что раскрывается: повторы видимых строк уже посчитаны в их ×N.
  const rest = rows.slice(1).reduce((n, r) => n + r.count, 0);
  // «Что делать» у первой причины: действие справочника для неё.
  const action = rowAction(rows[0], ordered, views);
  const undescribed = ordered.some(undescribedReason);
  const expandable = rest > 0 || action !== null || undescribed;
  // Номер шага первой причины: тот же шаг выбран на схеме при открытии.
  const firstStep = defaultSelection(trace, byId);
  const number = firstStep ? stepNumber?.get(firstStep) : undefined;
  const line = ({ view: v, count }: ReasonRow, i: number) => {
    const Icon = SOURCE_ICON[v.source];
    const operation = (v.target && ops.get(v.target)) || null;
    // «Кратко»: без кодов и адреса, подсказка из тех же слов.
    const short = brief ? briefReason(v, operation) : null;
    const where = reasonWhere(v, operation, brief);
    const tail = short ? where : [where, ...v.codes].filter(Boolean).join(' · ');
    const primary = i === 0;
    // Чья ошибка — справа тихой меткой. У свёрнутой первой строки её видно только читающему с экрана: строка спокойная.
    const sourceHidden = primary && expandable && !open;
    return (
      <li key={i} className={cn('flex min-w-0 shrink-0 items-center gap-2.5', primary ? 'h-[38px]' : 'h-[26px]')} data-source={v.source}>
        <Icon className={cn('size-4 shrink-0', v.source === 'pending' ? 'text-muted-foreground' : 'text-danger')} aria-hidden />
        <span className="min-w-0 flex-1 truncate" title={short ? short.title : v.raw}>
          <span className={cn('text-foreground', primary && 'font-semibold')}>{v.message}</span>
          {count > 1 && <span className={cn('tabular', v.source !== 'pending' && 'text-danger')}> ×{count}</span>}
          {tail && <span className="text-[12.5px] text-muted-foreground"> · {tail}</span>}
          {/* Номер — у шага с ошибкой: без ошибки на схеме выбран вход, а не этот обмен. */}
          {primary && v.source !== 'pending' && number !== undefined && <span className="tabular text-[12.5px] text-muted-foreground"> · {t('flow.mark.step', { index: number, of: stepNumber?.size ? Math.max(...stepNumber.values()) : number })}</span>}
        </span>
        <span className={cn('shrink-0 text-[12px] leading-4 whitespace-nowrap text-muted-foreground max-md:hidden', sourceHidden && 'sr-only')}>{t(`request.source.${v.label}`, { name: projectName })}</span>
      </li>
    );
  };
  const more = [rest > 0 ? t('request.moreErrors', { count: rest }) : null, action !== null || undescribed ? t('request.whatToDo') : null].filter(Boolean).join(' · ');
  return (
    <section aria-labelledby="request-reasons-title" data-testid="request-reasons" data-open={open || undefined} className={cn('min-w-0 rounded-[10px]', errors ? 'bg-danger-bg' : 'bg-muted/50')}>
      <h2 id="request-reasons-title" className="sr-only">
        {errors ? t('request.reasons') : t('request.notes')}
      </h2>
      {/* Вся строка раскрывает список мышью; кнопка справа — то же для клавиатуры и чтения с экрана. */}
      <div className={cn('flex min-w-0 items-center gap-2 pr-2 pl-3', expandable && 'cursor-pointer')} onClick={expandable ? (e) => !(e.target as Element).closest('button, a') && setOpen(!open) : undefined}>
        <ul className="min-w-0 flex-1 text-[13px]">{rows.slice(0, 1).map(line)}</ul>
        {expandable && (
          <button type="button" aria-expanded={open} aria-controls={bodyId} className="inline-flex h-[26px] shrink-0 items-center gap-1.5 rounded-[7px] px-2 text-[12.5px] font-medium whitespace-nowrap text-foreground-2 transition-colors hover:bg-background/60" data-testid="reasons-more" onClick={() => setOpen(!open)}>
            <span className={cn(open && 'sr-only')}>{more}</span>
            {open && <span>{t('request.whatLess')}</span>}
            <ChevronDown className={cn('size-3.5 transition-transform', open && 'rotate-180')} aria-hidden />
          </button>
        )}
      </div>
      {expandable && (
        <div id={bodyId} hidden={!open} className="min-w-0 pr-3 pb-3 pl-3" data-testid="reasons-body">
          {rest > 0 && (
            /* Длинный список прокручивается сам: граф и панель шага остаются на экране. */
            <ul className="flex max-h-[min(40dvh,264px)] min-w-0 flex-col overflow-y-auto pr-1 text-[13px]">{rows.slice(1).map((r, i) => line(r, i + 1))}</ul>
          )}
          {action && <WhatToDo text={action} boxed />}
          {/* Один раз на запрос: рядом тот же механизм, что в шапке запроса. */}
          {undescribed && (
            <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 pl-[26px]">
              <p className="min-w-0 text-[13px] text-foreground" data-testid="reasons-undescribed">
                {t('request.undescribed')}
              </p>
              {!onLink && <SupportContactSlot />}
              {share}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

interface HitTarget {
  id: string;
  /** Повторное нажатие на ту же запись тоже переходит к ней. */
  nonce: number;
}

/** Сводка над вкладками: сколько записей с совпадением и переход к первой. Сервер о совпадениях ничего не сообщает. */
function HitSummaryLine({ summary, onFirst }: { summary: HitSummary; /** null — вкладки «Записи» нет в этом режиме: переход вёл бы в никуда. */ onFirst: ((id: string) => void) | null }) {
  const { t } = useTranslation();
  const { matched, first, total } = summary;
  const text = matched > 0 ? t('request.hitsFound', { count: matched, total: formatInt(total) }) : t('request.hitsNone');
  return (
    <p className="flex h-10 min-w-0 items-center gap-2 text-[13px] text-muted-foreground" data-testid="hit-summary">
      <span className="tabular min-w-0 truncate" title={text}>
        {text}
      </span>
      {first !== null && onFirst && (
        <Button type="button" variant="ghost" size="sm" className="h-7 shrink-0 text-primary" onClick={() => onFirst(first)}>
          {t('request.toFirstHit')}
        </Button>
      )}
    </p>
  );
}

function RecordsList({ data, timeZone, target }: { data: RequestDetail; timeZone: string; target: HitTarget | null }) {
  const { t } = useTranslation();
  // Без сеттера: первая ошибка запоминается один раз, обновление данных не прокручивает страницу снова.
  const [firstError] = useState(() => data.records.find((r) => recordError(r))?.id ?? null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(firstError ? [firstError] : []));
  const [highlight, setHighlight] = useState<string | null>(null);
  const [scrollTo, setScrollTo] = useState<string | null>(null);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Переход к паре — прокрутка и подсветка.
  useEffect(() => {
    if (!scrollTo) return;
    document.getElementById(`record-${scrollTo}`)?.scrollIntoView({ block: 'nearest' });
    setScrollTo(null);
  }, [scrollTo]);
  useEffect(() => () => clearTimeout(highlightTimer.current), []);
  // Цель «К первому» при монтировании: страница остаётся у совпадения, а не возвращается к первой ошибке.
  const startedAtTarget = useRef(target !== null);
  // Первая ошибка раскрыта; страница сама не прокручивается, разве что ошибка целиком за краем окна.
  useEffect(() => {
    if (startedAtTarget.current) return;
    // Мерить после кадра: прежняя вкладка снимается не в том же проходе.
    const frame = requestAnimationFrame(() => {
      const el = firstError ? document.getElementById(`record-${firstError}`) : null;
      const r = el?.getBoundingClientRect();
      if (el && r && (r.top >= window.innerHeight || r.bottom <= 0)) el.scrollIntoView({ block: 'nearest' });
    });
    return () => cancelAnimationFrame(frame);
  }, [firstError]);

  const flash = useCallback((id: string) => {
    setHighlight(id);
    document.querySelector<HTMLElement>(`#record-${CSS.escape(id)} button[aria-expanded]`)?.focus({ preventScroll: true });
    clearTimeout(highlightTimer.current);
    highlightTimer.current = setTimeout(() => setHighlight(null), 2000);
  }, []);

  // Функции записей стабильны: запись мемоизирована, новое замыкание перерисовало бы все записи.
  const jump = useCallback(
    (id: string) => {
      setScrollTo(id);
      flash(id);
    },
    [flash],
  );

  // Переход после монтирования записи: иначе некуда поставить фокус. После кадра запись уже раскрыта и вкладка показана.
  const targetId = target?.id;
  const targetNonce = target?.nonce;
  useEffect(() => {
    if (!targetId) return;
    setExpanded((prev) => (prev.has(targetId) ? prev : new Set(prev).add(targetId)));
    const frame = requestAnimationFrame(() => {
      document.getElementById(`record-${targetId}`)?.scrollIntoView({ block: 'start' });
      flash(targetId);
    });
    return () => cancelAnimationFrame(frame);
  }, [targetId, targetNonce, flash]);

  const toggle = useCallback(
    (id: string) =>
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    [],
  );

  return (
    <ol className={RECORD_LIST} aria-label={t('request.recordsTitle')}>
      {data.records.map((r) => (
        <RecordItem
          key={r.id}
          record={r}
          timeZone={timeZone}
          mode="request"
          expanded={expanded.has(r.id)}
          onToggle={toggle}
          highlighted={highlight === r.id}
          onJump={jump}
          hitTarget={targetId === r.id}
        />
      ))}
    </ol>
  );
}

// Шапка запроса в две строки. Первая: назад, статус, название и путь, «N из M», действия. Вторая: путь через сервисы, время, длительности и id с копированием.
// Строки не переносятся: вкладки под шапкой стоят на месте при любых значениях. Уже 1280 путь через сервисы, внешнее время и действия «Операция», «Показать скрытое» уходят: путь и время видны на схеме, действия — в меню «⋯».
const HEADER_TOP = 'flex h-9 min-w-0 items-center gap-2.5';
const HEADER_META = 'flex h-[22px] min-w-0 items-center overflow-hidden text-[12.5px] whitespace-nowrap text-muted-foreground';
const LONG_ID = 'block min-w-0 truncate font-mono text-[12px] text-foreground';
/** Разделитель «·» перед полем второй строки: точкой из CSS, внутри dl посторонних элементов нет. */
const SEP = "before:mx-[9px] before:text-[color:var(--input)] before:content-['·']";
const SEP_WIDE = "xl:before:mx-[9px] xl:before:text-[color:var(--input)] xl:before:content-['·']";

/** Действия, которым нет места в строке: «Открыть в Grafana» всегда, на узком окне ещё «Операция» и «Показать скрытое». Те же кнопки, что в строке. */
function MoreActions({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <Popover>
      <Tooltip content={t('request.more')}>
        <PopoverTrigger asChild>
          <Button type="button" variant="ghost" size="icon" className="size-[30px] data-[state=open]:bg-sunk" aria-label={t('request.more')} data-testid="request-more">
            <Ellipsis aria-hidden />
          </Button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent className="flex w-auto min-w-56 flex-col gap-0.5 p-1.5" data-testid="request-more-menu">
        {children}
      </PopoverContent>
    </Popover>
  );
}

function RequestHeader({
  s,
  trace,
  byId,
  selection,
  operationKeys,
  reveal,
  revealStays,
  explore,
  back,
  stepper,
  note,
  shareProps,
}: {
  s: RequestSummary;
  trace: Trace;
  byId: ReadonlyMap<string, ViewRecord>;
  selection: Selection;
  operationKeys: RequestDetail['operationKeys'];
  /** null — на странице нечего показывать: кнопки нет. */
  reveal: Reveal | null;
  revealStays: readonly string[];
  /** Нет поля — у хранилища нет такой операции или записи без correlation_id: кнопки нет. */
  explore: RequestDetail['explore'];
  back: ReactNode;
  /** «N из M» со стрелками: справа в первой строке. */
  stepper: ReactNode;
  note: ReactNode;
  shareProps: ShareButtonProps;
}) {
  const { t } = useTranslation();
  const share = useShareMode();
  const { mode } = useView();
  const wide = useMedia(WIDE);
  const brief = mode === 'brief';
  const { project } = selection;
  const operationKey = operationKeys?.find((k) => !k.masked) ?? null;
  // У сегмента без correlation_id id запроса — внутренний ключ задания: вместо него слова, копировать нечего.
  const nocid = isNocid(s.correlationId);
  const title = s.incoming ? `${s.incoming.method} ${s.incoming.path}` : null;
  // Внешние системы в цепочке — именами, не хостами.
  // Справочник: имена систем и название входящего метода.
  const chain = brief ? collapseNeighbours(chainNames(trace, byId, (host) => briefSystem(host))) : chainNames(trace, byId, (host) => systemLabel(host));
  const name = title ? entryName(s) : null;
  // В «Кратко» путь шаблоном без метки метода и значений, приглушённо: это не название.
  const briefPath = brief && title && !name ? briefMethod({ uri: title }) : null;
  const operation = !share && chooseOperation(operationKeys ?? []) !== null;
  const revealButton = (inMenu: boolean) => reveal && <RevealButton status={reveal.status} partial={reveal.partial} error={reveal.error} stays={revealStays} onToggle={reveal.toggle} inMenu={inMenu} />;
  const more = [
    !wide && operation && <OperationButton key="operation" keys={operationKeys} selection={selection} atMs={s.firstMs} look="menu" />,
    !wide && reveal && <Fragment key="reveal">{revealButton(true)}</Fragment>,
    explore && !brief && <ExploreLinkButton key="explore" link={explore} labelClass="" inMenu />,
  ].filter(Boolean);
  const inline = wide && (operation || reveal);

  return (
    <header className="flex flex-col gap-1" data-testid="request-header">
      <div className={HEADER_TOP}>
        {/* Ссылка назад и переходы операции: нижнего поля своего у них здесь нет. */}
        {back && <div className="-ml-1.5 flex shrink-0 items-center [&>*]:mb-0">{back}</div>}
        <StatusChip status={s.status} focusable />
        {/* Название рядом с путём не сжимается раньше пути: путь второстепенный, обрезается он. Очень длинное — до 40 % строки. */}
        <h1 className={cn('min-w-0 shrink truncate text-[18px] leading-6 font-semibold tracking-[-0.012em] text-heading', name && title && !brief && 'xl:max-w-[40%] xl:shrink-0')}>
          {name ? (
            <span title={brief ? name : (title ?? undefined)} data-testid="request-name">
              {name}
            </span>
          ) : briefPath ? (
            <span title={t('view.brief.noName')} className="font-normal text-muted-foreground" data-testid="request-path">
              {briefPath}
            </span>
          ) : title ? (
            <PathTitle title={title} />
          ) : (
            t('request.backgroundTitle')
          )}
        </h1>
        {/* Путь рядом с названием, тихо: само название его не говорит. На узком окне путь в подсказке названия. */}
        {name && title && !brief && (
          <span className="min-w-0 shrink-[2] truncate font-mono text-[12.5px] text-muted-foreground max-xl:hidden" title={title} data-testid="request-path-line">
            {title}
          </span>
        )}
        {/* «Фоновый» уже сказан заголовком. */}
        {(s.kind === 'maybe-cached' || s.match === 'inexact' || s.incomplete) && (
          <span className="flex shrink-0 gap-1.5">
            {s.kind === 'maybe-cached' && (
              <Tooltip content={t('requests.maybeCachedHint')}>
                <Chip>{t('requests.maybeCached')}</Chip>
              </Tooltip>
            )}
            {s.match === 'inexact' && (
              <Tooltip content={t('requests.inexactHint')}>
                <Chip tone="warning">{t('requests.inexact')}</Chip>
              </Tooltip>
            )}
            {s.incomplete && (
              <Tooltip content={t('requests.incompleteHint')}>
                <Chip tone="warning">{t('requests.incomplete')}</Chip>
              </Tooltip>
            )}
          </span>
        )}
        {/* Параметры пути — в оставшемся месте: не поместившиеся скрыты, все есть в подробностях входа. */}
        <span className="flex min-w-0 flex-1">{title && !brief && <ParamChips params={titleParams(title)} className="h-6 gap-y-4 overflow-hidden" />}</span>
        {wide && operation && <OperationButton keys={operationKeys} selection={selection} atMs={s.firstMs} look="header" />}
        {wide && revealButton(false)}
        {more.length > 0 && <MoreActions>{more}</MoreActions>}
        {note}
        {/* «N из M» у «Поделиться»: действия запроса бывают не у всех, а стрелки должны оставаться под указателем от результата к результату. */}
        {stepper && (inline || note || more.length > 0) && <span aria-hidden className="mx-1 h-[18px] w-px shrink-0 bg-border" />}
        {stepper}
        <ShareSlot {...shareProps} />
      </div>
      <dl className={HEADER_META} data-testid="request-meta">
        {chain.length > 0 && (
          <Meta label={t('request.chain')} hideLabel className="max-w-[40%] min-w-0 shrink max-xl:hidden">
            <span className="relative block truncate text-foreground-2" data-testid="request-chain" title={(brief ? chain : chainLabels(trace.chain)).join(' → ')}>
              {chain.map((c, i) => (
                <Fragment key={i}>
                  {i > 0 && <Arrow />}
                  {c}
                </Fragment>
              ))}
            </span>
          </Meta>
        )}
        <Meta label={t('request.start')} hideLabel className={chain.length > 0 ? SEP_WIDE : undefined}>
          <TimeWithZone iso={new Date(trace.startTimeMs || s.firstMs).toISOString()} timeZone={project.timezone} ms />
        </Meta>
        <Meta label={t('request.total')} className={SEP}>
          <span className="tabular font-semibold text-foreground" data-testid="request-total">
            {formatDuration(trace.totalMs)}
          </span>
        </Meta>
        <Meta label={t('request.externalShort')} className={cn(SEP, 'max-xl:hidden')} title={t('request.external')}>
          <span className="tabular font-semibold text-foreground" data-testid="request-external">
            {formatDuration(trace.externalMs)}
          </span>
        </Meta>
        {/* На месте скрытого id нули той же длины: режим не сдвигает то, что ниже шапки. */}
        {brief ? (
          <IdPlace label={t('request.cid')} value={nocid ? t('request.nocid') : s.correlationId} />
        ) : nocid ? (
          <Meta label={t('request.cid')} className={cn(SEP, 'min-w-[9rem] shrink')}>
            <span className="flex min-w-0 items-center gap-0.5">
              <span className={cn(LONG_ID, 'text-muted-foreground')} title={t('request.nocid')} data-testid="request-cid">
                {t('request.nocid')}
              </span>
              <span className="size-6 shrink-0" />
            </span>
          </Meta>
        ) : (
          <Meta label={t('request.cid')} className={cn(SEP, 'min-w-[9rem] shrink')}>
            <span className="flex min-w-0 items-center gap-0.5">
              <Tooltip content={<span className="font-mono break-all">{s.correlationId}</span>}>
                <code className={LONG_ID} data-testid="request-cid" tabIndex={0}>
                  {s.correlationId}
                </code>
              </Tooltip>
              <CopyIconButton text={s.correlationId} label={t('requests.copyCid', { cid: s.correlationId })} className="size-6" />
            </span>
          </Meta>
        )}
        {brief && operationKey && <IdPlace label={operationKey.name ?? t('request.operationId')} value={operationKey.value} />}
        {!brief && operationKey && (
          <Meta label={operationKey.name ?? t('request.operationId')} className={cn(SEP, 'min-w-[9rem] shrink')}>
            <span className="flex min-w-0 items-center gap-0.5">
              <Tooltip content={<span className="font-mono break-all">{operationKey.value}</span>}>
                <code className={LONG_ID} data-testid="request-operation-id" tabIndex={0}>
                  {operationKey.value}
                </code>
              </Tooltip>
              <CopyIconButton text={operationKey.value} label={t('operation.copyId', { value: operationKey.value })} className="size-6" />
            </span>
          </Meta>
        )}
      </dl>
    </header>
  );
}

function IdPlace({ label, value }: { label: string; value: string }) {
  return (
    <Meta label={label} className={cn(SEP, 'invisible min-w-[9rem] shrink')}>
      <span className="flex min-w-0 items-center gap-0.5" aria-hidden data-testid="meta-placeholder">
        <span className={LONG_ID}>{'0'.repeat(value.length)}</span>
        <span className="size-6 shrink-0" />
      </span>
    </Meta>
  );
}

function Meta({ label, children, className, title, hideLabel = false }: { label: string; children: ReactNode; className?: string | undefined; title?: string; hideLabel?: boolean }) {
  return (
    <div className={cn('flex h-[22px] min-w-0 shrink-0 items-center gap-1.5 whitespace-nowrap', className)} title={title}>
      <dt className={cn('shrink-0', hideLabel && 'sr-only')}>{label}</dt>
      <dd className="min-w-0 text-foreground">{children}</dd>
    </div>
  );
}

export function RequestSkeleton({ reasons, fill = false, back = null, stepper = null }: { reasons: boolean; fill?: boolean; /** Возврат и соседние результаты: на тех же местах, что в шапке, пока запрос читается. */ back?: ReactNode; stepper?: ReactNode }) {
  // Панель той ширины, что запомнена: готовая страница не прыгает.
  const [panel] = useState(readPanel);
  // Те же строки и высоты, что у шапки; запрос с ошибкой — с местом под строку причины.
  return (
    <div className={cn('flex flex-col', fill && 'work:min-h-0 work:flex-1')} aria-busy="true" data-testid="request-skeleton">
      <div className={cn('flex shrink-0 flex-col gap-2.5', fill && cn(GUTTERS, 'pt-3'))}>
        <div className="flex flex-col gap-1">
          <div className={HEADER_TOP}>
            {back && <div className="-ml-1.5 flex shrink-0 items-center [&>*]:mb-0">{back}</div>}
            <Skeleton className="h-[22px] w-20" />
            <Skeleton className="h-6 w-80 max-w-full" />
            <span className="flex-1" />
            {stepper}
            {stepper && <ShareButtonSpace />}
          </div>
          <div className={HEADER_META}>
            <Skeleton className="h-4 w-[min(40rem,100%)]" />
          </div>
        </div>
        {reasons && <Skeleton className="h-[38px] w-full rounded-[10px]" />}
      </div>
      <div className={cn('shrink-0 pt-2.5', fill && GUTTERS)}>
        <div className="flex h-10 items-end gap-4 border-b border-border pb-2.5">
          <Skeleton className="h-5 w-16" />
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-5 w-16" />
        </div>
      </div>
      {/* Рабочий режим: холст и панель шага, как на готовой странице. */}
      <div className={fill ? SPLIT_FILL : SPLIT_FLOW} style={{ '--step-panel-w': `${panel.width}px` } as CSSProperties}>
        <div className={fill ? LEFT_FILL : 'min-w-0'}>
          <Skeleton className="h-[316px] w-full rounded-[12px] work:h-full" />
        </div>
        <div className={cn('compact:hidden [@media(min-width:1280px)_and_(max-height:699.98px)]:block', fill && cn(PANEL_WIDTH, 'work:border-l work:border-border work:bg-sub work:p-4', panel.collapsed && 'xl:hidden!'))}>
          <Skeleton className="h-[340px] w-full rounded-[10px]" />
        </div>
      </div>
    </div>
  );
}
