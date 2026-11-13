import { timeZoneOffsetLabel } from '@threadline/core';
import type { SearchState } from '@threadline/core/search';
import { visibleColumns } from '@threadline/core/view';
import type { TFunction } from 'i18next';
import { AlertTriangle, CircleSlash, Funnel, History, Info, RefreshCw, RotateCcw, ServerCrash } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router';
import { Button } from '@/components/ui/button.tsx';
import { ExploreLinkButton } from '@/components/ui/explore-link.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { Switch } from '@/components/ui/switch.tsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs.tsx';
import { Tooltip } from '@/components/ui/tooltip.tsx';
import { useAccess } from '@/features/auth/access.tsx';
import { extras } from '@/features/extras/hub.ts';
import { OperationStripSlot } from '@/features/operation/slot.tsx';
import { HitsContext, hitFormsOf } from '@/features/request/overlay.ts';
import { useShareMode } from '@/features/share/mode.ts';
import { ShareSlot, zonedText } from '@/features/share/slot.tsx';
import { useView } from '@/features/view/context.tsx';
import { DetailSwitch } from '@/features/view/DetailSwitch.tsx';
import { ResultFiltersSlot, ResultFiltersStatusSlot } from '@/features/tools/slot.tsx';
import { formatInt, formatSpan, shortDateTime, upperFirst } from '@/lib/format.ts';
import { envSetName, selectionEnvs } from '@/lib/selection.ts';
import { cn } from '@/lib/utils.ts';
import { closedAdvice, describeError, errorAdvice, errorTitle } from './errors.ts';
import { LinesTab } from './LinesTab.tsx';
import { errorCount, isCardKind, multiNoticesOf, newestFirst, noticesOf, partState, progressOf, type Notice as NoticeKind } from './model.ts';
import { EnvPartsSlot, ExploreMenuSlot } from './multi-slot.tsx';
import { customRangeLabel } from './PeriodControl.tsx';
import { isExpired } from './queries.ts';
import { RequestsTable, RequestsTableSkeleton } from './RequestsTable.tsx';
import { activeFilters, anyFilter, applyFilters, filterOptions, NO_FILTERS, rowFacets, rowsByStatus, type RowFilters } from './result-filters.ts';
import { useSearchSession, type ResultsUi } from './session.tsx';
import { StatusLegendButton } from './StatusChip.tsx';
import type { SearchController } from './useSearchController.ts';

/** Что результатам нужно от страницы: страница короткой ссылки даёт то же без поля поиска. */
export type ResultsController = Pick<SearchController, 'state' | 'selection' | 'chips' | 'excludes' | 'cached' | 'starting' | 'run' | 'reset'>;

/** Результаты одного поиска. Ключуется по id задания. run — номер повтора того же задания из памяти. */
export function SearchResults({ c, searchId, run = 0 }: { c: ResultsController; searchId: string; run?: number }) {
  const { t, i18n } = useTranslation();
  const share = useShareMode();
  const session = useSearchSession();
  const location = useLocation();
  const [ui, setUiState] = useState<ResultsUi>(() => session.ui(searchId));
  const setUi = (patch: Partial<ResultsUi>) => {
    setUiState((prev) => ({ ...prev, ...patch }));
    session.saveUi(searchId, patch);
  };
  // Со страницы запроса приходят на тот результат, который на ней открыт. В записи истории осталась строка, с которой начали, и после перезагрузки только она.
  const focusCid = ui.openedCid ?? readFocusCid(location.state);

  // Прокруткой страницы со списком владеет сам список. Браузер вернул бы старое место с опозданием, поверх прокрутки к строке, открытой сейчас.
  // Режим хранится в записи истории и наследуется новой: при уходе запись следующей страницы снова отдаётся браузеру.
  useLayoutEffect(() => {
    window.history.scrollRestoration = 'manual';
    const y = session.ui(searchId).pageY;
    if (y !== undefined) window.scrollTo(0, y);
    return () => {
      session.saveUi(searchId, { pageY: window.scrollY });
      window.history.scrollRestoration = 'auto';
    };
  }, [session, searchId]);

  // В «Кратко» вкладки «Все записи» нет: действующая вкладка считается при рендере, поэтому первый кадр не монтирует список строк и не читает хранилище.
  const { mode, view } = useView();
  const brief = mode === 'brief';
  const tab: ResultsUi['tab'] = brief ? 'requests' : ui.tab;

  const q = c.state;
  const data = q.data;
  // Поиск по нескольким средам: при равном времени строки идут в порядке сред.
  const envOrder = data?.envs?.map((p) => p.env).join(',') ?? '';
  const requests = useMemo(() => newestFirst(data?.requests ?? [], envOrder ? envOrder.split(',') : []), [data?.requests, envOrder]);
  const multi = data?.envs ? multiNoticesOf(data) : null;
  const notices = data ? (multi ? [...multi.group, ...multi.parts.flatMap((p) => p.notices)] : noticesOf(data)) : [];
  const onlyLines = notices.includes('only-lines');
  // Три пустых поиска подряд. Ключ — запуск: возврат к тому же результату не считается.
  const finishedEmpty = data && data.status !== 'running' ? notices.includes('empty') : null;
  useEffect(() => {
    if (finishedEmpty !== null && !share) extras.searchDone(`${searchId}:${run}`, finishedEmpty);
  }, [finishedEmpty, share, searchId, run]);
  const envNames = useMemo(() => new Map(selectionEnvs(c.selection).map((e) => [e.id, e.name])), [c.selection]);
  // Значения подсветки «Всех записей» — тот же объект, пока значения поиска те же: опрос не перерисовывает раскрытые строки.
  const hitForms = useMemo(() => hitFormsOf(data?.terms), [data?.terms]);

  // Фильтр компонента там же, где его колонка. Значения в «Кратко» те же, что в строке: адресов среди них нет.
  const hasComponent = visibleColumns(view, mode).includes('component');
  // eslint-disable-next-line react-hooks/exhaustive-deps -- подпись шаблона пути на языке интерфейса
  const facets = useMemo(() => rowFacets(requests, brief), [requests, brief, i18n.language]);
  const options = useMemo(() => filterOptions(facets, hasComponent), [facets, hasComponent]);
  const filters = activeFilters(ui.filters, options);
  const setFilters = (next: RowFilters) => setUi({ filters: next });
  // Значения фильтра исчезли (сменились режим или язык): выбор забывается. Пока строки ещё не дошли, сравнивать не с чем.
  const allLoaded = !!data && requests.length === data.requestsTotal && requests.length > 0;
  const stale = allLoaded && JSON.stringify(filters) !== JSON.stringify(ui.filters);
  useEffect(() => {
    if (!stale) return;
    setUiState((prev) => ({ ...prev, filters }));
    session.saveUi(searchId, { filters });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- filters считается из состояния при каждом рендере
  }, [stale, session, searchId]);

  // Есть только строки без correlation_id: вкладка «Все записи» открывается сама. В «Кратко» её нет.
  useEffect(() => {
    if (!brief && onlyLines && !ui.tabChosen && ui.tab !== 'lines') {
      setUiState((prev) => ({ ...prev, tab: 'lines' }));
      session.saveUi(searchId, { tab: 'lines' });
    }
  }, [brief, onlyLines, ui.tabChosen, ui.tab, session, searchId]);

  // Режим мог смениться где угодно, в том числе на странице запроса и в другой вкладке браузера. Выбор вкладки забывается:
  // возврат в «Подробно» не должен снова читать строки из хранилища, а автооткрытие при only-lines должно сработать.
  useEffect(() => {
    if (!brief || ui.tab !== 'lines') return;
    setUiState((prev) => ({ ...prev, tab: 'requests', tabChosen: false }));
    session.saveUi(searchId, { tab: 'requests', tabChosen: false });
  }, [brief, ui.tab, session, searchId]);

  if (q.isError && isExpired(q.error)) {
    // На странице ссылки поиск запускается заново сам, а при отказе кнопка повторяет то же.
    const canRepeat = share !== null || (c.chips.length > 0 && c.chips.every((x) => x.raw !== null) && c.excludes.every((x) => x.raw !== null));
    return (
      <Notice
        tone="warning"
        icon={History}
        name="expired"
        title={t('results.notice.expired.title')}
        action={
          canRepeat ? (
            <Button size="sm" onClick={() => void c.run()}>
              <RotateCcw aria-hidden />
              {t('results.notice.expired.repeat')}
            </Button>
          ) : (
            <Button size="sm" onClick={c.reset}>
              {t('results.notice.expired.new')}
            </Button>
          )
        }
      >
        {t('results.notice.expired.text')}
      </Notice>
    );
  }

  if (!data) {
    if (q.isError) {
      const d = describeError(t, q.error);
      return (
        <Notice
          tone="danger"
          icon={ServerCrash}
          name="poll-failed"
          title={t('results.pollFailed')}
          action={
            <Button size="sm" variant="secondary" onClick={() => void q.refetch()}>
              <RotateCcw aria-hidden />
              {t('states.retry')}
            </Button>
          }
        >
          {d.title}
        </Notice>
      );
    }
    return <ResultsSkeleton />;
  }

  const errors = errorCount(data.requests);
  const byStatus = rowsByStatus(requests, ui.onlyErrors);
  const shown = applyFilters(byStatus, facets, filters);
  const running = data.status === 'running';
  // Опрос не удался, а последнее состояние — «идёт»: ход поиска не показывается как идущий, полоса стоит до первого удачного ответа.
  // Опрос продолжается сам: TanStack Query держит прежние данные и спрашивает дальше.
  const lost = running && q.isError;
  const tz = c.selection.project.timezone;
  // Поиск упал и ничего не нашёл: пустые вкладки читались бы как «запросов нет», а логи не просмотрены.
  const failedEmpty = !running && data.requestsTotal === 0 && !!data.error && !data.tooMany;
  const showTabs = !failedEmpty && (data.requestsTotal > 0 || running || notices.some((n) => n !== 'empty'));
  const summary = summaryOf(t, data, errors);
  const canFilter = anyFilter(filters) || options.method.length > 1 || options.system.length > 1 || options.component.length > 1;
  // Есть строки: сообщения под таблицей, она становится ниже, а строки не двигаются. В компактном режиме страница прокручивается, и снизу их не видно: над таблицей.
  // Несколько сред: сначала общие сообщения, затем сообщения сред с их названием. Обрыв связи — первым, один на весь поиск.
  const lostBlock = lost ? (
    <Notice key="poll-failed" tone="warning" icon={ServerCrash} name="poll-failed" title={t('results.pollFailed')}>
      <p>{describeError(t, q.error).title}</p>
      <p>{t('results.pollRetrying')}</p>
    </Notice>
  ) : null;
  const noticeBlocks = [
    lostBlock,
    ...(multi
      ? [
          ...multi.group.map((n) => <SearchNotice key={n} kind={n} s={data} c={c} />),
          ...multi.parts.flatMap(({ part, notices: own }) => own.map((n) => <SearchNotice key={`${part.env}:${n}`} kind={n} s={partState(data, part)} c={c} env={envNames.get(part.env) ?? part.env} envId={part.env} />)),
        ]
      : notices.map((n) => <SearchNotice key={n} kind={n} s={data} c={c} />)),
  ];
  const under = data.requestsTotal > 0;

  return (
    <section aria-label={t('results.label')} className="flex min-h-0 flex-1 flex-col" data-testid="search-results" data-status={data.status}>
      <div className="flex min-h-10 shrink-0 items-start gap-x-1">
        <div className="min-w-0 flex-1">
          <h2 className="tabular truncate text-[16px] leading-[22px] font-semibold text-heading" data-testid="results-summary" title={summary.text}>
            {summary.main}
            {summary.errors && (
              <>
                {' · '}
                <span className="text-danger">{summary.errors}</span>
              </>
            )}
          </h2>
          <p className="tabular mt-0.5 flex h-4 min-w-0 items-center gap-x-3 overflow-hidden text-[12px] leading-4 whitespace-nowrap text-muted-foreground">
            <span className="min-w-0 truncate" title={periodText(t, data, tz)}>
              {periodText(t, data, tz)}
            </span>
            {running && !lost && (
              <span className="shrink-0" data-testid="search-progress-text">
                {progressText(t, data)}
              </span>
            )}
            {c.cached && !running && (
              <span className="inline-flex min-w-0 items-center gap-1.5" data-testid="cached-note" title={t('search.cached')}>
                <History className="size-3.5 shrink-0" aria-hidden />
                <span className="min-w-0 truncate">{t('search.cached')}</span>
              </span>
            )}
          </p>
        </div>
        {!brief && (data.envs ? <ExploreMenuSlot parts={data.envs} names={envNames} /> : data.explore && <ExploreLinkButton link={data.explore} labelClass="max-lg:sr-only" />)}
        <ShareSlot
          quiet
          target={{ kind: 'results', searchId }}
          timeZone={tz}
          ticket={{
            title: summary.text,
            at: zonedText(t('period.customRange', customRangeLabel(data.period.fromMs, data.period.toMs, tz)), tz, data.period.fromMs),
            env: c.selection.stand ? `${c.selection.env.name} · ${t('header.standNumber', { number: c.selection.stand })}` : envSetName(c.selection),
          }}
        />
        {/* По ссылке поиск запускается заново сам. Место кнопки постоянное: и во время поиска, и после. */}
        {!share && (
          <div className="shrink-0" data-testid="search-second-slot">
            <Tooltip content={t('search.refreshHint')} disabled={running}>
              <Button type="button" variant="ghost" onClick={() => void c.run({ fresh: true })} disabled={running || c.starting || selectionEnvs(c.selection).every((e) => e.notConfigured)}>
                <RefreshCw aria-hidden />
                <span className="max-lg:sr-only">{t('search.refresh')}</span>
              </Button>
            </Tooltip>
          </div>
        )}
      </div>
      {data.envs && <EnvPartsSlot parts={data.envs} names={envNames} />}
      <p className="sr-only" aria-live="polite">
        {running ? '' : summary.text}
      </p>

      {!showTabs && <div className="mt-3 flex shrink-0 flex-col gap-3 empty:hidden">{noticeBlocks}</div>}

      {showTabs && (
        <Tabs value={tab} onValueChange={(v) => setUi({ tab: v as ResultsUi['tab'], tabChosen: true })} className="mt-3 flex min-h-0 flex-1 flex-col">
          <div className="relative flex h-10 shrink-0 items-end justify-between gap-x-4 border-b border-border compact:order-[-2]">
            <TabsList className="border-b-0">
              <TabsTrigger value="requests">
                {t('results.tabs.requests')}
                {data.requestsTotal > 0 && <span className="tabular text-[12px] font-medium text-muted-foreground">{formatInt(data.requestsTotal)}</span>}
              </TabsTrigger>
              {!brief && <TabsTrigger value="lines">{t('results.tabs.lines')}</TabsTrigger>}
            </TabsList>
            <div className="flex h-10 min-w-0 items-center gap-x-3">
              {tab === 'requests' && data.requestsTotal > 0 && (
                <>
                  <label className="flex h-10 min-w-0 cursor-pointer items-center gap-2 text-[12.5px] font-medium whitespace-nowrap text-foreground-2 has-[:disabled]:cursor-default">
                    <Switch checked={ui.onlyErrors && errors > 0} disabled={errors === 0} onCheckedChange={(v) => setUi({ onlyErrors: v })} />
                    <span>{t('results.onlyErrors')}</span>
                    {errors === 0 && <span className="text-muted-foreground max-xl:sr-only">· {t('results.noErrors')}</span>}
                  </label>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button type="button" variant="ghost" size="sm" className="text-[13px]" disabled={!canFilter} data-testid="filters-toggle" aria-label={t('results.filter')}>
                        <Funnel aria-hidden />
                        <span className="max-lg:sr-only">{t('results.filter')}</span>
                        {anyFilter(filters) && <span className="size-1.5 rounded-full bg-primary" aria-hidden />}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-72">
                      <ResultFiltersSlot options={options} value={filters} onChange={setFilters} />
                    </PopoverContent>
                  </Popover>
                </>
              )}
              <StatusLegendButton />
              {/* Режим показа живёт в меню профиля; на странице ссылки профиля нет, переключатель здесь. */}
              {share && <DetailSwitch />}
            </div>
            {/* Ход поиска — полоса по нижней линии вкладок: места не занимает, при завершении ничего не сдвигается. */}
            {running && !lost && <Progress s={data} />}
          </div>
          {!under && <div className="mt-3 flex shrink-0 flex-col gap-3 empty:hidden">{noticeBlocks}</div>}
          <TabsContent value="requests" className="flex min-h-0 flex-col pt-3 data-[state=inactive]:hidden">
            {anyFilter(filters) && (
              <div className="mb-2 shrink-0">
                <ResultFiltersStatusSlot hidden={byStatus.length - shown.length} shown={shown.length} onReset={() => setFilters(NO_FILTERS)} />
              </div>
            )}
            {shown.length > 0 ? (
              <RequestsTable requests={shown} selection={c.selection} searchId={searchId} focusCid={focusCid} />
            ) : running && !lost && byStatus.length === 0 ? (
              <RequestsTableSkeleton text={t('requests.waiting')} />
            ) : null}
          </TabsContent>
          <TabsContent value="lines" className="min-h-0 pt-3 data-[state=inactive]:hidden work:overflow-y-auto">
            <HitsContext.Provider value={hitForms}>
              <LinesTab searchId={searchId} selection={c.selection} requests={data.requests} parts={data.envs} />
            </HitsContext.Provider>
          </TabsContent>
          {/* Строка операции появляется после чтения первого запроса: на этом месте она тоже не двигает таблицу. Пустой блок места не занимает. */}
          {under && (
            <div className="mt-3 flex max-h-[40%] shrink-0 flex-col gap-3 overflow-y-auto empty:hidden compact:order-[-1] compact:max-h-none">
              {noticeBlocks}
              <OperationStripSlot state={data} selection={c.selection} />
            </div>
          )}
        </Tabs>
      )}
    </section>
  );
}

/** Итог над вкладками: найдено, рядом красным сколько с ошибкой. text — целиком, для подсказки и диктора. */
function summaryOf(t: T, s: SearchState, errors: number): { main: string; errors: string | null; text: string } {
  const plain = (main: string) => ({ main, errors: null, text: main });
  if (s.requestsTotal === 0) {
    if (s.status === 'running') return plain(t('results.searching'));
    // Слишком много: список не строился, но первый проход их насчитал.
    if (s.tooMany) return plain(s.found !== null ? t('results.found', { count: s.found }) : t('results.notice.tooMany.title'));
    if (s.error) return plain(t('results.notRun'));
    return plain(t('results.found', { count: 0 }));
  }
  const found = t('results.found', { count: s.requestsTotal });
  const main = s.status === 'running' ? t('results.foundSoFar', { found }) : found;
  if (errors > 0) {
    const part = t('results.withErrors', { count: errors });
    return { main, errors: part, text: `${main} · ${part}` };
  }
  return plain(`${main} · ${t('results.noErrors')}`);
}

function readFocusCid(state: unknown): string | null {
  const v = (state as { focusCid?: unknown } | null)?.focusCid;
  return typeof v === 'string' ? v : null;
}

// TFunction, а не ReturnType<typeof useTranslation>: с большим каталогом строк tsc не выводит такой тип (TS2589).
type T = TFunction;

function periodText(t: T, s: SearchState, tz: string): string {
  const range = customRangeLabel(s.period.fromMs, s.period.toMs, tz);
  const period = s.period.preset ? `${t(`period.during.${s.period.preset}`)} · ${t('period.customRange', range)}` : t('period.during.custom', range);
  return `${period} · ${tz}, ${timeZoneOffsetLabel(tz)}`;
}

function duringText(t: T, s: SearchState, tz: string): string {
  if (s.period.preset) return t(`period.during.${s.period.preset}`);
  return t('period.during.custom', customRangeLabel(s.period.fromMs, s.period.toMs, tz));
}

function progressText(t: T, s: SearchState): string {
  const p = s.progress;
  return s.stage === 'fetch'
    ? t('results.progress.fetch', { done: p.batchesDone, total: p.batchesTotal })
    : t('results.progress.count', { done: p.chunksDone, total: p.chunksTotal });
}

function Progress({ s }: { s: SearchState }) {
  const { t } = useTranslation();
  const pct = Math.round(progressOf(s) * 100);
  return (
    <div
      role="progressbar"
      aria-label={t('results.progress.label')}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-valuetext={progressText(t, s)}
      data-testid="search-progress"
      className="absolute inset-x-0 -bottom-px h-0.5 overflow-hidden bg-muted"
    >
      <div className="h-full bg-primary transition-[width] duration-300" style={{ width: `${Math.max(pct, 3)}%` }} />
    </div>
  );
}

function SearchNotice({ kind, s, c, env, envId }: { kind: NoticeKind; s: SearchState; c: ResultsController; /** Сообщение среды поиска по нескольким средам: её название в заголовке. */ env?: string; envId?: string }) {
  const { t } = useTranslation();
  const titled = (title: string) => (env ? t('multi.notice', { env, title }) : title);
  const share = useShareMode();
  const { mode, setMode, locked } = useView();
  const details = useAccess().can('details');
  const brief = mode === 'brief';
  // В «Кратко» вкладки «Все записи» нет: сообщения ведут к ней кнопкой режима. У Бизнеса режим один, такой кнопки нет.
  const toFull = brief && !locked ? (
    <Button size="sm" variant="secondary" onClick={() => setMode('full')} data-testid="notice-to-full">
      {t('view.toFull')}
    </Button>
  ) : undefined;
  const tz = c.selection.project.timezone;
  switch (kind) {
    case 'too-many': {
      const span = formatSpan(s.period.toMs - (s.scannedFromMs ?? s.period.fromMs));
      return (
        <Notice tone="warning" icon={AlertTriangle} name={kind} env={envId} title={titled(t('results.notice.tooMany.title'))} action={toFull}>
          <p>
            {s.found !== null
              ? t('results.notice.tooMany.text', { span, found: t('common.requests', { count: s.found }) })
              : t('results.notice.tooMany.textNoCount')}
          </p>
          {s.terms.some((x) => isCardKind(x.kind)) && <p>{t('results.notice.tooMany.card')}</p>}
          {!brief && <p>{t('results.notice.tooMany.lines')}</p>}
          {share && <p>{t('share.askSender')}</p>}
        </Notice>
      );
    }
    case 'error': {
      const e = s.error!;
      const scanned = s.scannedFromMs !== null && s.scannedFromMs < s.period.toMs;
      const advice = errorAdvice(t, e.code) ?? closedAdvice(t, e.code, e.details);
      // Ничего не нашлось: сообщение вместо таблицы, главным действием. Есть строки: полоса под таблицей. Сообщение среды — всегда полоса.
      const large = !env && s.requestsTotal === 0;
      return (
        <Notice
          tone="danger"
          icon={ServerCrash}
          name={kind}
          env={envId}
          title={titled(errorTitle(t, e.code))}
          large={large}
          action={
            <>
              <Button size={large ? 'default' : 'sm'} variant={large ? 'default' : 'secondary'} onClick={() => void c.run({ fresh: true })} disabled={c.starting}>
                <RotateCcw aria-hidden />
                {t('states.retry')}
              </Button>
              {/* Страница сервиса закрыта Бизнесу и ссылке: кнопки у них нет. */}
              {large && details && !share && (
                <Button asChild variant="secondary">
                  <Link to="/admin/status" data-testid="notice-service">
                    {t('header.service')}
                  </Link>
                </Button>
              )}
            </>
          }
        >
          {/* Ненастроенная среда поиска по нескольким средам не читалась вовсе: о ходе подсчёта говорить нечего. */}
          {e.code !== 'not-configured' && (
            <p>
              {e.stage === 'fetch'
                ? t('results.notice.error.fetch')
                : scanned
                  ? t('results.notice.error.count', { from: shortDateTime(s.scannedFromMs!, tz), to: shortDateTime(s.period.toMs, tz) })
                  : t('results.notice.error.countNone')}
            </p>
          )}
          {(advice || e.retryAfterSeconds !== undefined) && (
            <p>
              {advice}
              {e.retryAfterSeconds !== undefined && <> {t('connection.retryIn', { seconds: e.retryAfterSeconds })}</>}
            </p>
          )}
          {e.details && !brief && (
            <details className="mt-1">
              <summary className="cursor-pointer text-[13px] font-medium">{t('results.notice.error.details')}</summary>
              <pre className="mt-1 max-h-40 overflow-auto text-left font-mono text-[12px] leading-[18px] break-all whitespace-pre-wrap" tabIndex={0}>
                {e.details}
              </pre>
            </details>
          )}
        </Notice>
      );
    }
    case 'cancelled':
      return (
        <Notice tone="info" icon={CircleSlash} name={kind} title={t('results.notice.cancelled.title')}>
          {t('results.notice.cancelled.text')}
        </Notice>
      );
    case 'truncated':
      return (
        <Notice tone="warning" icon={AlertTriangle} name={kind} env={envId} title={titled(t('results.notice.truncated.title'))}>
          <p>
            {t(
              s.truncatedBy === 'memory'
                ? s.excluding
                  ? 'results.notice.truncated.memoryExclude'
                  : 'results.notice.truncated.memory'
                : s.excluding
                  ? 'results.notice.truncated.textExclude'
                  : 'results.notice.truncated.text',
            )}
          </p>
          {share && <p>{t('share.askSender')}</p>}
        </Notice>
      );
    case 'only-lines':
      // Строки есть у запросов, которые убрало «Не содержит»: про строки без correlation_id говорить нельзя.
      if (s.excluding?.removed) {
        return (
          <Notice tone="info" icon={Info} name={kind} title={t('results.notice.onlyLines.excludedTitle')} action={toFull}>
            {t(locked ? 'results.notice.onlyLines.excludedBusinessText' : brief ? 'results.notice.onlyLines.excludedBriefText' : 'results.notice.onlyLines.excludedText')}
          </Notice>
        );
      }
      return (
        <Notice tone="info" icon={Info} name={kind} title={t(brief ? 'results.notice.onlyLines.briefTitle' : 'results.notice.onlyLines.title')} action={toFull}>
          {t(locked ? 'results.notice.onlyLines.businessText' : brief ? 'results.notice.onlyLines.briefText' : 'results.notice.onlyLines.text')}
        </Notice>
      );
    case 'empty':
      return (
        <div className="flex flex-col items-center rounded-[var(--radius-card)] border border-border bg-card p-12 text-center" data-notice="empty" role="status">
          <p className="text-[15px] leading-[22px] font-semibold text-heading">{upperFirst(t('results.notice.empty.title', { period: duringText(t, s, tz) }))}</p>
          <p className="mt-2 max-w-[460px] text-[12px] leading-4 text-muted-foreground">{t(share ? 'share.emptyText' : 'results.notice.empty.text')}</p>
          {share && c.selection.stand && <p className="mt-1 max-w-[460px] text-[12px] leading-4 text-muted-foreground">{t('share.standGone')}</p>}
          {!share && s.period.preset !== '24h' && (
            <Button className="mt-4" variant="secondary" onClick={() => void c.run({ period: { preset: '24h' } })} disabled={c.starting}>
              {t('results.notice.empty.action')}
            </Button>
          )}
        </div>
      );
  }
}

const NOTICE_TONES = {
  danger: 'bg-danger-bg text-danger',
  warning: 'bg-warning-bg text-warning',
  info: 'bg-accent text-accent-foreground',
} as const;

function Notice({
  tone,
  icon: Icon,
  name,
  env,
  title,
  action,
  large = false,
  children,
}: {
  tone: keyof typeof NOTICE_TONES;
  icon: typeof Info;
  name: string;
  /** Среда сообщения в поиске по нескольким средам. */
  env?: string | undefined;
  title: string;
  action?: ReactNode;
  /** Вместо таблицы: карточка по центру. Иначе полоса. */
  large?: boolean;
  children: ReactNode;
}) {
  if (large) {
    return (
      <div role={tone === 'danger' ? 'alert' : 'status'} data-notice={name} className="flex flex-col items-center rounded-[var(--radius-card)] border border-danger-line bg-card p-12 text-center">
        <p className="text-[15px] leading-[22px] font-semibold text-danger">{title}</p>
        <div className="mt-2 flex max-w-[460px] flex-col gap-1 text-[12px] leading-4 text-muted-foreground">{children}</div>
        {action && <div className="mt-4 flex flex-wrap justify-center gap-2">{action}</div>}
      </div>
    );
  }
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} data-notice={name} data-env={env} className={cn('flex flex-wrap items-start gap-x-2.5 gap-y-2 rounded-[10px] px-3.5 py-2.5 text-[12px] leading-4', NOTICE_TONES[tone])}>
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <div className="flex min-w-0 flex-1 basis-64 flex-col gap-0.5">
        <p className="font-semibold">{title}</p>
        <div className="flex max-w-[880px] flex-col gap-0.5">{children}</div>
      </div>
      {action && <div className="flex shrink-0 gap-2">{action}</div>}
    </div>
  );
}

function ResultsSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col" aria-busy="true" data-testid="results-skeleton">
      <div className="h-10 shrink-0">
        <Skeleton className="h-[22px] w-64" />
        <Skeleton className="mt-0.5 h-4 w-48" />
      </div>
      <div className="mt-3 flex h-10 shrink-0 items-end gap-[22px] border-b border-border pb-2.5">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-5 w-20" />
      </div>
      <div className="flex min-h-0 flex-col pt-3">
        <RequestsTableSkeleton />
      </div>
    </div>
  );
}
