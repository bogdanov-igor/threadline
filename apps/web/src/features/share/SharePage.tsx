// Страница короткой ссылки: только чтение, поиск заново по сохранённым условиям. Браузер обращается только к /api/s/*, логотипам и файлам интерфейса.
// Страницы результатов, запроса и операции те же: источник данных и режим приходят из контекста.
// Адрес внутри ссылки: /s/<id>/requests/<cid> и /s/<id>/operations/<type>/<value>. Что им открыть, решает сохранённый поиск ссылки, а не адрес.
import { timeZoneOffsetLabel, type EnvironmentInfo, type ProjectInfo, type ShareInfo, type ShareRun } from '@threadline/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock, FileQuestion, Link2Off, LogIn, RotateCcw, ServerCrash, Unlink, type LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate, useNavigationType, useParams, useSearchParams } from 'react-router';
import { GUTTERS, Page, WorkPage } from '@/components/shell/Page.tsx';
import { LanguageSwitch } from '@/components/shell/LanguageSwitch.tsx';
import { Brand, ProjectLogo } from '@/components/shell/Logo.tsx';
import { ThemeToggle } from '@/components/shell/ThemeToggle.tsx';
import { TruncatedLabel } from '@/components/shell/Switcher.tsx';
import { PageSkeleton } from '@/components/states/PageSkeleton.tsx';
import { StateMessage } from '@/components/states/StateMessage.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Chip } from '@/components/ui/chip.tsx';
import { OperationBody, OperationSkeleton } from '@/features/operation/OperationPage.tsx';
import { OperationNav } from '@/features/operation/OperationNav.tsx';
import { flowsOf, type OperationAddress, type OperationLinkState } from '@/features/operation/model.ts';
import { BackLink as IconBackLink, NavLine, RequestContent, RequestSkeleton } from '@/features/request/RequestPage.tsx';
import { readListSteps, useOneMove } from '@/features/request/result-stepper.ts';
import { ResultStepper } from '@/features/request/ResultStepper.tsx';
import { describeError } from '@/features/search/errors.ts';
import { customRangeLabel } from '@/features/search/PeriodControl.tsx';
import { isExpired, searchKeys, useSearchState } from '@/features/search/queries.ts';
import { SearchResults, type ResultsController } from '@/features/search/SearchResults.tsx';
import { SearchSessionProvider, useSearchSession } from '@/features/search/session.tsx';
import { useKindLabel } from '@/features/search/TermsField.tsx';
import { LocalViewProvider } from '@/features/view/context.tsx';
import { ApiError, apiGet, apiSend } from '@/lib/api.ts';
import { timeParts } from '@/lib/format.ts';
import type { Selection } from '@/lib/selection.ts';
import { cn } from '@/lib/utils.ts';
import { JobSourceContext, LINK_SOURCE, shareOperationPath, sharePath, ShareModeContext, useJobSource, type ShareMode, type ShareRequestState } from './mode.ts';

const enc = encodeURIComponent;

/** Состояния, в которых страница ссылки не открылась: своя причина на каждый код. */
const STATES: Record<string, { key: 'notFound' | 'projectHidden' | 'noEnvironment' | 'notConfigured' | 'logsGone' | 'busy' | 'unavailable' | 'outdated'; icon: LucideIcon; tone: 'warning' | 'danger'; retry?: boolean }> = {
  'share-not-found': { key: 'notFound', icon: Link2Off, tone: 'warning' },
  'share-project-hidden': { key: 'projectHidden', icon: Unlink, tone: 'warning' },
  'unknown-environment': { key: 'noEnvironment', icon: Unlink, tone: 'warning' },
  'not-configured': { key: 'notConfigured', icon: Unlink, tone: 'warning' },
  'logs-gone': { key: 'logsGone', icon: FileQuestion, tone: 'warning' },
  busy: { key: 'busy', icon: Clock, tone: 'warning', retry: true },
  'share-unavailable': { key: 'unavailable', icon: ServerCrash, tone: 'danger', retry: true },
  'share-outdated': { key: 'outdated', icon: Link2Off, tone: 'warning' },
};

function readShareStatus(state: unknown): 'error' | 'success' | null {
  return (state as Partial<ShareRequestState> | null)?.shareRequest?.status ?? null;
}

/** Открыто нажатием внутри страницы: кнопка «Назад» идёт по истории. По присланному адресу истории нет. */
const openedInside = (state: unknown) => !!(state as Partial<ShareRequestState> | null)?.shareRequest;

const readSegment = (v: string | null): number | null => (v !== null && /^\d{1,6}$/.test(v) ? Number(v) : null);

/** Открыт запрос или поток: строки условий нет, среда в шапке. На результатах и операции она в строке условий. */
function useRequestAddress(): boolean {
  const { cid, type } = useParams();
  const [query] = useSearchParams();
  return cid !== undefined || (type !== undefined && query.has('flow'));
}

/** Среда запроса внутри ссылки на несколько сред: ?env= из адреса, только среда этой ссылки. */
function useRowEnv(info: ShareInfo | null) {
  const [query] = useSearchParams();
  const id = query.get('env');
  return info?.envs?.find((e) => e.id === id) ?? null;
}

function ShareHeader({ info }: { info: ShareInfo | null }) {
  const { t } = useTranslation();
  const request = useRequestAddress();
  const rowEnv = useRowEnv(info);
  const envInHeader = request || info?.kind === 'request';
  const envName = info && (rowEnv ? rowEnv.name : info.stand ? `${info.env.name} · ${t('share.header.stand', { stand: info.stand })}` : info.env.name);
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background" data-testid="share-header">
      <div className={cn('flex h-[55px] items-center', GUTTERS)}>
        <Brand />
        {info && (
          <div className="flex min-w-0 flex-1 items-center gap-2 text-[13.5px] font-medium text-foreground" data-testid="share-header-project">
            <span className="mx-3 h-7 w-px shrink-0 bg-border xl:mx-4" aria-hidden />
            {info.project.logo && <ProjectLogo logo={info.project.logo} />}
            <TruncatedLabel text={info.project.name} className="min-w-[3rem]" />
            {envInHeader && (
              <>
                <span className="shrink-0 text-muted-foreground" aria-hidden>
                  ·
                </span>
                <TruncatedLabel text={envName!} className="min-w-[3rem] text-foreground-2" />
              </>
            )}
          </div>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1 pl-2">
          {info && (
            <Chip className="mr-1 border-transparent font-normal" data-testid="share-header-mark">
              {t('share.header.openedByLink')}
              <span className="max-xl:hidden">· {t('share.header.readOnly')}</span>
            </Chip>
          )}
          <LanguageSwitch />
          <ThemeToggle />
          {/* Обычный переход: вход проверяется уже на главной странице, а не здесь. Уже 1024px только значок: шапка в одну строку. */}
          <Button asChild size="sm" className="ml-1">
            <a href="/" data-testid="share-sign-in">
              <LogIn aria-hidden />
              <span className="max-lg:sr-only">{t('share.header.signIn')}</span>
            </a>
          </Button>
        </div>
      </div>
    </header>
  );
}

/** Те же правила, что у Layout: страница с меткой WorkPage в рабочем режиме занимает ровно окно. */
function Frame({ info, children }: { info: ShareInfo | null; children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col work:has-[[data-work-page]]:h-dvh work:has-[[data-work-page]]:overflow-hidden work:has-[[data-work-page]]:[&>main]:flex work:has-[[data-work-page]]:[&>main]:min-h-0 work:has-[[data-work-page]]:[&>main]:flex-col">
      <ShareHeader info={info} />
      <main className="flex-1">{children}</main>
    </div>
  );
}

function StateScreen({ error, onRetry, retrying = false, note, children }: { error: unknown; onRetry?: () => void; retrying?: boolean; note?: string; children?: ReactNode }) {
  const { t } = useTranslation();
  const code = error instanceof ApiError ? error.code : '';
  const known = STATES[code];
  const retryIn = error instanceof ApiError ? error.retryAfterSeconds : undefined;
  const key = known?.key ?? 'failed';
  return (
    <StateMessage icon={known?.icon ?? ServerCrash} tone={known?.tone ?? 'danger'} title={t(`share.states.${key}.title`)} text={[t(`share.states.${key}.text`), retryIn !== undefined ? t('share.states.busyIn', { seconds: retryIn }) : null, note].filter(Boolean).join(' ')}>
      {onRetry && (!known || known.retry) && (
        <Button onClick={onRetry} disabled={retrying} data-testid="share-retry">
          <RotateCcw className={retrying ? 'animate-spin' : undefined} aria-hidden />
          {t('share.retry')}
        </Button>
      )}
      {children}
    </StateMessage>
  );
}

const NOT_FOUND = new ApiError('share-not-found', 404);

/** Запроса или операции нет в поиске этой ссылки: то же сообщение, что у неизвестной ссылки, и путь к её результатам. Узнать, существует ли такой запрос вообще, нельзя. */
function NotInLink({ mode }: { mode: ShareMode }) {
  const { t } = useTranslation();
  return (
    <StateScreen error={NOT_FOUND} note={t('share.states.notInLink')}>
      <Button asChild variant="secondary">
        <Link to={sharePath(mode)} data-testid="share-to-results">
          {t('share.toResults')}
        </Link>
      </Button>
    </StateScreen>
  );
}

/**
 * Условия ссылки только для чтения: значения маской и период теми же датами, что при создании. Часовой пояс проекта, браузер в другом поясе этого не меняет.
 * Высота в рабочем режиме та же, что у строки поиска на обычной странице, и не зависит от числа значений: таблица стоит на том же месте. Длинные значения обрезаются, полное в подсказке.
 */
function Summary({ info }: { info: ShareInfo }) {
  const { t } = useTranslation();
  const kindLabel = useKindLabel();
  const tz = info.project.timezone;
  const range = customRangeLabel(info.period.fromMs, info.period.toMs, tz);
  const until = t('share.summary.until', { date: timeParts(new Date(info.expiresAt).getTime(), tz).date });
  const env = info.envs ? info.envs.map((e) => e.name).join(' + ') : info.stand ? `${info.env.name} · ${t('share.header.stand', { stand: info.stand })}` : info.env.name;
  const masked = `${until} · ${t('share.summary.masked')}`;
  return (
    <section aria-label={t('share.summary.label')} className={cn('flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-border bg-sub py-2 text-[13px] work:h-[69px] work:flex-nowrap', GUTTERS)} data-testid="share-summary">
      <div className="flex min-w-0 flex-1 basis-full flex-col justify-center gap-1 work:basis-0">
        <dl className="flex min-w-0 items-center gap-x-2.5 overflow-hidden">
          <div className="shrink-0">
            <dt className="sr-only">{t('share.summary.environment')}</dt>
            <dd className="font-semibold text-heading" data-testid="share-env">
              {env}
            </dd>
          </div>
          {info.terms.length > 0 && (
            <div className="flex min-w-0 items-center gap-1.5">
              <dt className="sr-only">{t('share.summary.values')}</dt>
              {info.terms.map((x, i) => (
                // Короткое значение не сжимается: длинное отдаёт место первым. Вид значения виден, пока места хватает; при трёх и больше он в подсказке.
                <dd key={i} className={x.display.length <= 8 ? 'shrink-0' : 'min-w-[4rem]'} data-testid="share-term">
                  <Chip className="w-full max-w-full justify-start border-transparent bg-accent text-foreground" title={`${kindLabel(x.kind, x.display)}: ${x.display}`}>
                    {info.terms.length < 3 && <span className="shrink-0 font-normal text-foreground-2 max-xl:hidden">{kindLabel(x.kind, x.display)}</span>}
                    <span className="min-w-0 truncate font-mono">{x.display}</span>
                  </Chip>
                </dd>
              ))}
            </div>
          )}
          {info.excludes && (
            <div className="flex min-w-0 items-center gap-1.5">
              <dt className="shrink-0 text-muted-foreground">{t('share.summary.excludes')}</dt>
              {info.excludes.map((x, i) => (
                <dd key={i} className="min-w-[3rem]" data-testid="share-exclude">
                  <Chip className="w-full max-w-full justify-start font-mono" title={x.display}>
                    <span className="min-w-0 truncate">{x.display}</span>
                  </Chip>
                </dd>
              ))}
            </div>
          )}
        </dl>
        <dl className="flex min-w-0 items-center gap-x-3 text-[12.5px] leading-[18px] text-muted-foreground">
          <div className="shrink-0">
            <dt className="sr-only">{t('share.summary.period')}</dt>
            <dd className="tabular" data-testid="share-period" title={t('share.summary.zone', { zone: tz })}>
              {t('period.customRange', range)} · {tz}, {timeZoneOffsetLabel(tz, new Date(info.period.fromMs))}
            </dd>
          </div>
          {info.periodCut && (
            <div className="min-w-0">
              <dt className="sr-only">{t('share.summary.label')}</dt>
              <dd className="truncate text-warning" title={t('share.summary.periodCut')} data-testid="share-period-cut">
                {t('share.summary.periodCut')}
              </dd>
            </div>
          )}
          {info.envsDropped && (
            <div className="min-w-0">
              <dt className="sr-only">{t('share.summary.environment')}</dt>
              <dd className="truncate text-warning" title={t('share.summary.envsDropped')} data-testid="share-envs-dropped">
                {t('share.summary.envsDropped')}
              </dd>
            </div>
          )}
        </dl>
      </div>
      <p className="min-w-0 text-[12.5px] leading-[18px] text-muted-foreground work:max-w-[38%] work:shrink-0 work:text-right" title={masked} data-testid="share-until">
        {masked}
      </p>
    </section>
  );
}

/** Запуск поиска ссылки: один при открытии, один автоматический повтор, если задание ушло из памяти при открытой странице. */
function useLinkRun(id: string) {
  const qc = useQueryClient();
  const [ready, setReady] = useState(false);
  const run = useMutation({ mutationFn: () => apiSend<ShareRun>('POST', `/api/s/${enc(id)}/run`) });
  const { mutate } = run;
  const start = useCallback(() => {
    setReady(false);
    mutate(undefined, {
      onSuccess: () => {
        // Новое задание считает сводки с нуля: прежние данные страниц уходят.
        qc.removeQueries({ queryKey: searchKeys.state(id) });
        qc.removeQueries({ queryKey: ['search-lines', id] });
        qc.removeQueries({ queryKey: ['search-request', id] });
        setReady(true);
      },
    });
  }, [mutate, qc, id]);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    start();
  }, [start]);
  const state = useSearchState(ready ? id : null);
  const retried = useRef(false);
  /** Задание ушло из памяти: запустить заново один раз за открытие страницы, дальше решает кнопка. */
  const retryOnce = useCallback(() => {
    if (retried.current) return;
    retried.current = true;
    start();
  }, [start]);
  const expired = state.isError && isExpired(state.error);
  useEffect(() => {
    if (expired) retryOnce();
  }, [expired, retryOnce]);
  return { state, error: run.error, pending: run.isPending, restart: start, retryOnce };
}

/** Запрос из того же задания: хранилище не читается. Пока поиск идёт и запроса в нём ещё нет, видна заготовка. Чужой идентификатор сервер не отличит от несуществующего. */
function RequestView({ mode, info, cid, selection, run, opLink, status, inside, listSteps }: { mode: ShareMode; info: ShareInfo; cid: string; selection: Selection; run: ReturnType<typeof useLinkRun>; opLink: OperationLinkState | null; status: 'error' | 'success' | null; inside: boolean; /** Открыт строкой списка: сколько переходов между результатами от неё сделано. null — не из списка. */ listSteps: number | null }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const session = useSearchSession();
  const oneMove = useOneMove();
  const navigation = useNavigationType();
  const source = useJobSource();
  const searched = run.state.data;
  // Ссылка на несколько сред: запрос из части своей среды. Среды нет в ссылке — запрос не из этой ссылки.
  const rowEnv = info.envs ? selection.env.id : undefined;
  const known = !!searched && (searched.status !== 'running' || searched.requests.some((r) => r.correlationId === cid && r.env === rowEnv) || flowsOf(searched.operation).some((f) => f.cid === cid));
  const detail = useQuery({
    queryKey: searchKeys.request(mode.id, cid, rowEnv),
    queryFn: ({ signal }) => source.request(mode.id, cid, signal, rowEnv),
    enabled: known,
    staleTime: Infinity,
    retry: false,
  });
  const expired = detail.isError && isExpired(detail.error) && (detail.error as ApiError).code === 'search-expired';
  const { retryOnce } = run;
  useEffect(() => {
    if (expired) retryOnce();
  }, [expired, retryOnce]);
  // Запрос открывается с начала страницы, а не с прокрутки списка. «Назад» прокрутку оставляет браузеру.
  useLayoutEffect(() => {
    if (navigation !== 'POP') window.scrollTo(0, 0);
  }, [navigation]);

  // Назад — по истории, как у обычной страницы запроса: «Назад» браузера потом не ведёт снова сюда. По присланному адресу обычный переход.
  const back = (e: MouseEvent<HTMLAnchorElement>) => {
    if (!inside || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    oneMove(() => {
      if (listSteps !== null) session.saveUi(mode.id, { openedCid: cid });
      void navigate(-((listSteps ?? 0) + 1));
    });
  };
  // У ссылки на один запрос результатов нет: идти некуда. Возврат значком слева, соседние результаты справа.
  const headerBack = opLink ? <OperationNav link={opLink} operation={searched?.operation ?? null} cid={cid} selection={selection} /> : info.kind === 'results' ? <IconBackLink to={sharePath(mode)} onClick={back} label={t('share.back')} data-testid="share-back" /> : null;
  // Из списка: соседние результаты, адреса внутри этой же ссылки.
  const fromList = listSteps !== null && !opLink && info.kind === 'results';
  const stepper = fromList ? <ResultStepper searchId={mode.id} cid={cid} selection={selection} state={searched} gone={isExpired(run.state.error)} inHeader /> : null;
  const until = t('share.summary.requestUntil', { date: timeParts(new Date(info.expiresAt).getTime(), info.project.timezone).date });

  let body: ReactNode;
  if (run.error) body = <StateScreen error={run.error} onRetry={run.restart} retrying={run.pending} />;
  else if (run.state.isError && !run.pending && !detail.data) body = <StateScreen error={run.state.error} onRetry={run.restart} />;
  else if (searched?.error && searched.status === 'failed' && !detail.data) {
    const d = describeError(t, new ApiError(searched.error.code as ApiError['code'], 0, undefined, searched.error.retryAfterSeconds));
    body = (
      <StateMessage icon={ServerCrash} tone="danger" title={t('share.failedRequest')} text={[d.title, d.advice].filter(Boolean).join('. ')}>
        <Button onClick={run.restart} disabled={run.pending} data-testid="share-retry">
          <RotateCcw aria-hidden />
          {t('share.openAgain')}
        </Button>
      </StateMessage>
    );
  } else if (detail.data) {
    return (
      <WorkPage>
        <RequestContent
          data={detail.data}
          selection={selection}
          searchId={mode.id}
          operation={opLink ? { link: opLink, view: searched?.operation ?? null } : null}
          back={headerBack}
          stepper={stepper}
          headerNote={
            <span className="hidden min-w-0 truncate text-[12.5px] text-muted-foreground xl:block" title={until} data-testid="share-until">
              {until}
            </span>
          }
          fill
        />
      </WorkPage>
    );
  } else if (detail.isError && !expired) {
    const code = detail.error instanceof ApiError ? detail.error.code : null;
    if (code === 'share-not-found') return <NotInLink mode={mode} />;
    body =
      code === 'request-not-found' ? (
        <StateMessage icon={FileQuestion} tone="warning" title={t('share.requestEmpty.title')} text={t('share.requestEmpty.text')} />
      ) : (
        <StateMessage icon={ServerCrash} tone="danger" title={t('share.failedRequest')} text={describeError(t, detail.error).title}>
          <Button onClick={() => void detail.refetch()}>
            <RotateCcw aria-hidden />
            {t('share.retry')}
          </Button>
        </StateMessage>
      );
  } else {
    return (
      <WorkPage>
        <RequestSkeleton reasons={status === 'error'} back={headerBack} stepper={stepper} fill />
      </WorkPage>
    );
  }
  // Та же строка возврата и «N из M», что в шапке открытого запроса: стрелки не уходят из-под указателя.
  return (
    <>
      {(headerBack || stepper) && <NavLine back={headerBack} stepper={stepper} />}
      <Page className={headerBack || stepper ? 'pt-4 lg:pt-4' : undefined}>{body}</Page>
    </>
  );
}

function OperationView({ mode, info, selection, run }: { mode: ShareMode; info: ShareInfo; selection: Selection; run: ReturnType<typeof useLinkRun> }) {
  const s = run.state.data;
  const op = s?.operation ?? null;
  const target = info.target && 'type' in info.target ? info.target : null;
  const address = useMemo<OperationAddress>(() => ({ type: target?.type ?? '', value: target?.value ?? '', atMs: info.period.fromMs, window: target?.window ?? '6h', also: [], searchId: mode.id }), [target, info.period.fromMs, mode.id]);
  let body: ReactNode;
  if (run.error) body = <StateScreen error={run.error} onRetry={run.restart} retrying={run.pending} />;
  else if (run.state.isError && !run.pending) body = <StateScreen error={run.state.error} onRetry={run.restart} />;
  else if (!op || !s) body = <OperationSkeleton running={s?.status === 'running' || run.pending} progress={s} />;
  else body = <OperationBody op={op} s={s} selection={selection} address={address} href={shareOperationPath(mode)} refreshing={run.pending} onRefresh={run.restart} />;
  return (
    <>
      <Summary info={info} />
      <Page className="pt-4 lg:pt-4">{body}</Page>
    </>
  );
}

function ResultsView({ mode, info, selection, run }: { mode: ShareMode; info: ShareInfo; selection: Selection; run: ReturnType<typeof useLinkRun> }) {
  const c: ResultsController = {
    state: run.state,
    selection,
    chips: [],
    excludes: [],
    cached: false,
    starting: run.pending,
    run: async () => run.restart(),
    reset: run.restart,
  };
  if (run.error) return <StateScreen error={run.error} onRetry={run.restart} retrying={run.pending} />;
  return (
    <WorkPage>
      {/* Проект в шапке, среда в строке условий: заголовок только для чтения с экрана. */}
      <h1 className="sr-only">
        {info.project.name} · {info.envs ? info.envs.map((e) => e.name).join(' + ') : info.env.name}
      </h1>
      <Summary info={info} />
      <div className={cn('flex min-h-0 flex-1 flex-col py-4', GUTTERS)}>
        <SearchResults c={c} searchId={mode.id} />
      </div>
    </WorkPage>
  );
}

function Opened({ id, info }: { id: string; info: ShareInfo }) {
  const mode = useMemo<ShareMode>(() => {
    const target = info.kind === 'operation' && info.target && 'type' in info.target ? info.target : null;
    return { id, kind: info.kind, operation: target && { type: target.type, value: target.value } };
  }, [id, info.kind, info.target]);
  const selection = useMemo<Selection>(() => {
    const env: EnvironmentInfo = { id: info.env.id, name: info.env.name, kind: info.env.kind, notConfigured: false };
    // Ссылка на несколько сред: все её среды, первая — env.
    const envs: EnvironmentInfo[] | undefined = info.envs?.map((e) => ({ id: e.id, name: e.name, kind: e.kind, notConfigured: false }));
    const project: ProjectInfo = { id: info.project.id, name: info.project.name, timezone: info.project.timezone, retentionDays: info.project.retentionDays, environments: envs ?? [env], ...(info.project.logo ? { logo: info.project.logo } : {}), view: info.project.view };
    return { project, env: envs?.[0] ?? env, stand: info.stand ?? undefined, ...(envs ? { envs } : {}) };
  }, [info]);
  const { type, value } = useParams();
  // Адрес операции: только та, что записана в ссылке. Сравнение до первого запроса: чужое значение не запускает поиск и хранилище не читает.
  const foreign = type !== undefined && (mode.operation?.type !== type || mode.operation.value !== value);
  return (
    <ShareModeContext.Provider value={mode}>
      <JobSourceContext.Provider value={LINK_SOURCE}>
        <LocalViewProvider view={info.project.view}>
          <SearchSessionProvider>{foreign ? <NotInLink mode={mode} /> : <Body mode={mode} info={info} selection={selection} />}</SearchSessionProvider>
        </LocalViewProvider>
      </JobSourceContext.Provider>
    </ShareModeContext.Provider>
  );
}

function Body({ mode, info, selection }: { mode: ShareMode; info: ShareInfo; selection: Selection }) {
  const run = useLinkRun(mode.id);
  const location = useLocation();
  const params = useParams();
  const [query] = useSearchParams();
  const flow = params.type ? query.get('flow') : null;
  const cid = params.cid ?? flow ?? (info.target && 'cid' in info.target ? info.target.cid : null);
  const segment = readSegment(query.get('segment'));
  const step = query.get('step');
  // У ссылки на операцию любой открытый запрос это её поток: переходы и возврат есть и у присланного адреса.
  const opLink = useMemo<OperationLinkState | null>(() => (info.kind === 'operation' && cid ? { searchId: mode.id, operation: { href: shareOperationPath(mode), step, segment } } : null), [info.kind, cid, mode, step, segment]);
  // Запрос внутри ссылки на несколько сред: выбор одной среды строки из ?env=. Без неё или с чужой — запрос не из этой ссылки.
  const envId = query.get('env');
  const rowEnv = selection.envs?.find((e) => e.id === envId);
  if (cid && selection.envs && !rowEnv) return <NotInLink mode={mode} />;
  if (cid && rowEnv) {
    const { envs: _envs, ...single } = selection;
    return <RequestView key={`${cid}|${rowEnv.id}|${segment ?? ''}`} mode={mode} info={info} cid={cid} selection={{ ...single, env: rowEnv, stand: undefined }} run={run} opLink={opLink} status={readShareStatus(location.state)} inside={openedInside(location.state)} listSteps={readListSteps(location.state)} />;
  }
  if (cid) return <RequestView key={`${cid}|${segment ?? ''}`} mode={mode} info={info} cid={cid} selection={selection} run={run} opLink={opLink} status={readShareStatus(location.state)} inside={openedInside(location.state)} listSteps={readListSteps(location.state)} />;
  if (info.kind === 'operation') return <OperationView mode={mode} info={info} selection={selection} run={run} />;
  return <ResultsView mode={mode} info={info} selection={selection} run={run} />;
}

export default function SharePage() {
  const { id = '' } = useParams();
  const info = useQuery({
    queryKey: ['share', id],
    queryFn: ({ signal }) => apiGet<ShareInfo>(`/api/s/${enc(id)}`, signal),
    staleTime: Infinity,
    retry: (count, e) => e instanceof ApiError && e.code === 'server-unreachable' && count < 2,
  });
  if (info.data) {
    return (
      <Frame info={info.data}>
        <Opened id={id} info={info.data} />
      </Frame>
    );
  }
  return <Frame info={null}>{info.isError ? <StateScreen error={info.error} onRetry={() => void info.refetch()} retrying={info.isFetching} /> : <PageSkeleton />}</Frame>;
}
