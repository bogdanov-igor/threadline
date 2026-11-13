// Страница операции: итог и ход статусов, одна таблица
// запросов по времени с буквами и общей шкалой. Код графа грузится только при раскрытии строки.
import type { OperationView } from '@threadline/core/flow';
import type { SearchState } from '@threadline/core/search';
import {
  ArrowLeft,
  Check,
  CircleCheck,
  CircleDashed,
  CircleX,
  Clock,
  FileQuestion,
  RotateCcw,
  Search,
  ServerCrash,
  Unlink,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { Page } from '@/components/shell/Page.tsx';
import { PageSkeleton } from '@/components/states/PageSkeleton.tsx';
import { StateMessage } from '@/components/states/StateMessage.tsx';
import { Button } from '@/components/ui/button.tsx';
import { StatusChip as StatusCapsule } from '@/components/ui/chip.tsx';
import { CopyIconButton } from '@/components/ui/copy-button.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { Tooltip } from '@/components/ui/tooltip.tsx';
import { useShareMode } from '@/features/share/mode.ts';
import { ShareSlot, zonedText } from '@/features/share/slot.tsx';
import { customRangeLabel } from '@/features/search/PeriodControl.tsx';
import { useView } from '@/features/view/context.tsx';
import { DetailSwitch } from '@/features/view/DetailSwitch.tsx';
import { describeError } from '@/features/search/errors.ts';
import { isExpired, useSearchState } from '@/features/search/queries.ts';
import { ApiError } from '@/lib/api.ts';
import { formatDuration, shortDateTime, timeParts } from '@/lib/format.ts';
import { readableDetails } from '@/lib/server-text.ts';
import { envPath, type Selection } from '@/lib/selection.ts';
import { cn } from '@/lib/utils.ts';
import { useLayout } from '@/routes/Layout.tsx';
import { UnknownEnvironment } from '@/routes/UnknownPage.tsx';
import {
  flowKey,
  flowsOf,
  lettersOf,
  linkedTypes,
  operationPath,
  parseOperationAddress,
  scaleOf,
  typeName,
  type OperationAddress,
  type OperationLinkState,
  spansDays,
  summaryPlan,
} from './model.ts';
import { OperationFlows } from './OperationFlows.tsx';
import { OperationSummary } from './OperationSummary.tsx';
import { useStartOperation, useStopOnLeave, useSupplementOperation } from './queries.ts';

const SECTION_TITLE = 'text-[13px] font-[650] text-foreground';

export function OperationRoute() {
  const { data, selection } = useLayout();
  if (!data) return <PageSkeleton />;
  if (!selection) return <UnknownEnvironment />;
  return (
    <OperationPage
      key={`${selection.project.id}/${selection.env.id}/${selection.stand ?? ''}`}
      selection={selection}
    />
  );
}

function OperationPage({ selection }: { selection: Selection }) {
  const { t } = useTranslation();
  const { type, value } = useParams();
  const [qs] = useSearchParams();
  const parsed = parseOperationAddress(type, value, qs);
  const { project, env, stand } = selection;
  const toSearch = (
    <Button asChild>
      <Link to={envPath(project.id, env.id, stand)}>{t('request.toSearch')}</Link>
    </Button>
  );
  if (!parsed.ok) {
    return (
      <Page>
        <StateMessage
          icon={Unlink}
          tone="warning"
          title={t(
            parsed.reason === 'short' ? 'operation.error.short.title' : 'operation.error.badLink.title',
          )}
          text={t(parsed.reason === 'short' ? 'operation.error.short.text' : 'operation.error.badLink.text')}
        >
          {toSearch}
        </StateMessage>
      </Page>
    );
  }
  const a = parsed.address;
  // Новый момент, окно или значения — новый поиск; id задания в адресе не пересоздаёт страницу.
  const key = [a.type, a.value, a.atMs, a.window, ...a.also.map((x) => `${x.type}:${x.value}`)].join('|');
  return (
    <Page className="pt-4 lg:pt-4">
      <OperationContent key={key} selection={selection} address={a} toSearch={toSearch} />
    </Page>
  );
}

function OperationContent({
  selection,
  address: a,
  toSearch,
}: {
  selection: Selection;
  address: OperationAddress;
  toSearch: ReactNode;
}) {
  const { t } = useTranslation();
  const [, setQs] = useSearchParams();
  const { project, env, stand } = selection;
  const start = useStartOperation(project.id, env.id);
  const { mutate } = start;
  const state = useSearchState(a.searchId);
  const expired = a.searchId !== null && state.isError && isExpired(state.error);
  // Остановленное задание — как истёкшее: уход со страницы и «Назад», чужой уход, долгая пауза без опроса.
  // Его итог ничего не говорит об операции: ничего не прочитано или прочитано не всё.
  const stopped = a.searchId !== null && state.data?.status === 'cancelled' && state.data.id === a.searchId;

  // Поиск запускается, если в адресе нет живого задания: повтор из памяти сервера вернёт прежнее задание.
  const run = useCallback(
    (fresh: boolean) =>
      mutate(
        {
          ...(stand ? { stand } : {}),
          type: a.type,
          values: [a.value],
          ...(a.also.length > 0 ? { also: a.also } : {}),
          atMs: a.atMs,
          window: a.window,
          ...(fresh ? { fresh: true } : {}),
        },
        {
          onSuccess: (r) => {
            if (!r) return;
            setQs(
              (p) => {
                const n = new URLSearchParams(p);
                n.set('search', r.id);
                return n;
              },
              { replace: true },
            );
          },
        },
      ),
    [mutate, stand, a.type, a.value, a.also, a.atMs, a.window, setQs],
  );
  const started = useRef<string | null>(null);
  useEffect(() => {
    if (a.searchId && !expired && !stopped) return;
    const k = a.searchId ?? '';
    if (started.current === k) return;
    started.current = k;
    run(false);
  }, [a.searchId, expired, stopped, run]);

  const s = state.data && !expired && !stopped ? state.data : undefined;
  const op = s?.operation ?? null;
  // Опрос не удался, а поиск шёл: вместо хода поиска предупреждение, опрос продолжается сам.
  const lost = s?.status === 'running' && state.isError;
  const href = operationPath(project.id, env.id, stand, { ...a, searchId: s?.id ?? a.searchId });
  useStopOnLeave(s?.id ?? a.searchId, href);

  let body: ReactNode;
  if (start.error && !op) {
    const e = start.error;
    if (e instanceof ApiError && e.code === 'invalid-operation') {
      body = (
        <StateMessage
          icon={Unlink}
          tone="warning"
          title={t('operation.error.badValue.title')}
          text={readableDetails(e.details) ?? t('operation.error.badValue.text')}
        >
          {toSearch}
        </StateMessage>
      );
    } else if (e instanceof ApiError && e.code === 'operation-expired') {
      body = (
        <StateMessage
          icon={FileQuestion}
          tone="warning"
          title={t('operation.error.expired.title')}
          text={t('operation.error.expired.text', { count: project.retentionDays })}
        >
          {toSearch}
        </StateMessage>
      );
    } else if (e instanceof ApiError && e.code === 'bad-request') {
      body = (
        <StateMessage
          icon={Unlink}
          tone="warning"
          title={t('operation.error.badLink.title')}
          text={readableDetails(e.details) ?? t('operation.error.badLink.text')}
        >
          {toSearch}
        </StateMessage>
      );
    } else {
      const d = describeError(t, e);
      body = (
        <StateMessage
          icon={ServerCrash}
          tone="danger"
          title={t('operation.error.failed')}
          text={[d.title, d.advice ?? readableDetails(d.details)].filter(Boolean).join('. ')}
        >
          <Button onClick={() => run(false)}>
            <RotateCcw aria-hidden />
            {t('states.retry')}
          </Button>
        </StateMessage>
      );
    }
    return body;
  }
  if (!op || !s) {
    if (state.isError && !expired) {
      const d = describeError(t, state.error);
      return (
        <StateMessage
          icon={ServerCrash}
          tone="danger"
          title={t('operation.error.failed')}
          text={[d.title, d.advice ?? readableDetails(d.details)].filter(Boolean).join('. ')}
        >
          <Button onClick={() => void state.refetch()}>
            <RotateCcw aria-hidden />
            {t('states.retry')}
          </Button>
        </StateMessage>
      );
    }
    return <OperationSkeleton running={s?.status === 'running' || start.isPending} progress={s} />;
  }
  return (
    <OperationBody
      op={op}
      s={s}
      selection={selection}
      address={a}
      href={href}
      refreshing={start.isPending}
      onRefresh={() => run(true)}
      lost={lost}
    />
  );
}

/** Содержимое страницы операции: его же показывает страница короткой ссылки. */
export function OperationBody({
  op,
  s,
  selection,
  address: a,
  href,
  refreshing,
  onRefresh,
  lost = false,
}: {
  op: OperationView;
  s: SearchState;
  selection: Selection;
  address: OperationAddress;
  href: string;
  refreshing: boolean;
  onRefresh: () => void;
  /** Опрос не удался, а последнее состояние — «идёт»: ход поиска не показывается как идущий. */
  lost?: boolean;
}) {
  const { t } = useTranslation();
  const share = useShareMode();
  const { mode } = useView();
  const brief = mode === 'brief';
  const tz = selection.project.timezone;
  const { project, env, stand } = selection;
  const flows = flowsOf(op);
  const name = op.key.name ?? op.key.type;
  const value = op.key.values[0] ?? a.value;
  const short = value.length <= 4 ? value : value.slice(-4);
  const done = s.status !== 'running';
  // Поиск оборвался: логи прочитаны не все, поэтому «Статусов нет» и пустая таблица были бы ложным выводом.
  const broken = s.status !== 'done' && done;
  const finished = done && !broken && !s.error;
  const link: OperationLinkState = { searchId: s.id, operation: { href } };
  // Запросы через полночь: без даты «23:58 → 00:03» читалось бы как время назад.
  const multiDay = spansDays(op.items, tz);
  const windowPath = (w: '6h' | '24h') =>
    operationPath(project.id, env.id, stand, { ...a, window: w, searchId: null });
  const supplement = useSupplementOperation();
  const navigate = useNavigate();
  const canSupplement =
    !share && !op.supplemented && op.extraIds.length > 0 && op.key.values.length + op.key.also.length < 3;
  // Дополнение — новое задание с потоками прежнего: страница переходит к нему, а новые значения попадают в адрес,
  // чтобы ссылка коллеге повторила поиск целиком.
  const added = op.extraIds
    .slice(0, Math.max(0, 3 - op.key.values.length - op.key.also.length))
    .map((x) => ({ type: x.type, value: x.value }));
  const onSupplement = () =>
    supplement.mutate(
      { searchId: s.id, body: { values: added } },
      {
        onSuccess: (r) => {
          if (r) void navigate(operationPath(project.id, env.id, stand, { ...a, also: [...a.also, ...added], searchId: r.id }));
        },
      },
    );
  const scale = scaleOf(op.items);
  const letters = lettersOf(op.items).flows;
  const plan = summaryPlan(op, done && !finished);

  return (
    // Связь оборвалась: значки хода поиска на странице не вращаются, до первого удачного ответа.
    <div className={cn('flex flex-col gap-6', lost && '[&_.animate-spin]:animate-none')} data-testid="operation-page" data-status={s.status} data-poll-lost={lost || undefined}>
      <div className="flex min-w-0 flex-col" data-testid="operation-header">
        <div className="flex min-h-8 min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2">
          {share ? (
            <span />
          ) : (
            <Link
              to={envPath(project.id, env.id, stand)}
              className="-ml-1.5 inline-flex h-8 min-w-0 items-center gap-1.5 rounded-[var(--radius-control)] px-1.5 text-[13px] font-[550] text-foreground-2 transition-colors hover:bg-sunk"
            >
              <ArrowLeft className="size-4 shrink-0" aria-hidden />
              <span className="truncate">{t('request.toSearch')}</span>
            </Link>
          )}
          <div className="flex shrink-0 items-center gap-2">
            {/* Режим показа живёт в меню профиля; на странице ссылки профиля нет, переключатель здесь. */}
            {share && <DetailSwitch />}
            {/* На странице ссылки окно зафиксировано при создании: выбора и «Обновить» нет. */}
            {!share && (
              <div role="group" aria-label={t('operation.window.label')} className="inline-flex h-8 shrink-0 items-center gap-0.5 rounded-[9px] bg-sunk p-[3px]">
                {(['6h', '24h'] as const).map((w) => (
                  <Link
                    key={w}
                    to={windowPath(w)}
                    aria-current={a.window === w ? 'true' : undefined}
                    className={cn(
                      'tabular flex h-full items-center rounded-[7px] px-2.5 text-[13px] font-medium whitespace-nowrap transition-colors',
                      a.window === w ? 'bg-[var(--seg-on)] text-foreground shadow-[var(--seg-on-shadow)]' : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {t(`operation.window.${w}`)}
                  </Link>
                ))}
              </div>
            )}
            {!share && (
              <Tooltip content={t('operation.refresh')}>
                <Button variant="secondary" onClick={onRefresh} disabled={refreshing || !done} aria-label={t('operation.refresh')}>
                  <RotateCcw className={refreshing ? 'animate-spin' : undefined} aria-hidden />
                  <span className="max-lg:sr-only">{t('operation.refresh')}</span>
                </Button>
              </Tooltip>
            )}
            <ShareSlot
              target={{ kind: 'operation', searchId: s.id }}
              timeZone={tz}
              ticket={{
                title: t('operation.pageTitle', { name, short }),
                at: zonedText(t('period.customRange', customRangeLabel(op.window.fromMs, op.window.toMs, tz)), tz, op.window.fromMs),
                env: stand ? `${env.name} · ${t('header.standNumber', { number: stand })}` : env.name,
                operationId: value,
              }}
            />
          </div>
        </div>
        <p className="mt-2.5 text-[12px] leading-4 font-medium text-muted-foreground">{t('operation.kicker')}</p>
        {/* Полный id на строке заголовка: смена режима ничего не сдвигает, id обрезается только по месту. */}
        <div className="mt-0.5 flex min-w-0 items-center gap-x-3">
          <h1 className="min-w-0 text-[20px] leading-[26px] font-[650] tracking-[-0.015em] [overflow-wrap:anywhere] text-heading" data-testid="operation-title">
            {t('operation.pageTitle', { name, short })}
          </h1>
          {brief ? (
            <span aria-hidden className="min-w-24 flex-1" />
          ) : (
            <span className="flex min-w-24 flex-1 items-center gap-0.5" data-testid="operation-id">
              <code className="block min-w-0 truncate font-mono text-[12.5px] text-muted-foreground" title={value}>
                {value}
              </code>
              <CopyIconButton text={value} label={t('operation.copyId', { value })} className="size-6" />
            </span>
          )}
        </div>
        <OutcomeLine op={op} done={done} finished={finished} />
        <Facts op={op} tz={tz} brief={brief} />
      </div>

      {/* Пока поиск идёт, место блока держит заготовка высотой короткой строки: блок, пришедший в конце, ничего ниже не сдвигает. */}
      {plan ? (
        <OperationSummary plan={plan} op={op} jobId={share?.id ?? s.id} selection={selection} link={link} done={done} />
      ) : (
        !done && <Skeleton className="-mt-2 h-10 w-full rounded-[12px]" data-testid="operation-summary-skeleton" />
      )}

      <Notices
        op={op}
        s={s}
        window={a.window}
        widerHref={windowPath('24h')}
        flows={flows.length}
        tz={tz}
        brief={brief}
        onRetry={onRefresh}
        retrying={refreshing}
        lost={lost}
        supplement={
          canSupplement ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={supplement.isPending || !done}
              onClick={onSupplement}
              data-testid="operation-supplement"
            >
              <Search aria-hidden />
              {t('operation.notice.supplement', {
                name: [...new Set(op.extraIds.map((x) => x.name ?? x.type))].join(', '),
              })}
            </Button>
          ) : null
        }
      />

      <Trail op={op} letters={letters} tz={tz} done={finished} broken={!finished && done} multiDay={multiDay} />

      <section aria-labelledby="operation-flows-title" className="flex min-w-0 flex-col gap-3">
        <div className="flex min-w-0 items-baseline justify-between gap-4">
          <h2 id="operation-flows-title" className={cn(SECTION_TITLE, 'tabular shrink-0')}>
            {t('operation.flows.title')}
            {(finished || flows.length > 0) && ` · ${flows.length}`}
          </h2>
          {scale && scale.spanMs > 0 && (
            <p className="min-w-0 truncate text-[12px] leading-4 text-muted-foreground compact:hidden" title={t('operation.table.note', { span: formatDuration(scale.spanMs) })}>
              {t('operation.table.note', { span: formatDuration(scale.spanMs) })}
            </p>
          )}
        </div>
        {done && op.items.length === 0 ? (
          <p className="text-[13px] text-muted-foreground" data-testid="operation-flows-empty">
            {t(finished ? 'operation.flows.empty' : 'operation.flows.notRead')}
          </p>
        ) : (
          <OperationFlows op={op} s={s} selection={selection} link={link} tz={tz} mode={mode} multiDay={multiDay} done={done} scale={scale} />
        )}
      </section>
    </div>
  );
}

const statusName = (s: { name: string | null; raw: string; value: string }) => s.name ?? (s.raw || s.value);

/** Факты под итогом: начало, вся длительность, сколько запросов, по чему связаны. Пока потоков нет, строка пуста той же высоты. */
function Facts({ op, tz, brief }: { op: OperationView; tz: string; brief: boolean }) {
  const { t } = useTranslation();
  const flows = flowsOf(op);
  if (flows.length === 0) return <p className="mt-2 min-h-5" data-testid="operation-facts" />;
  const from = Math.min(...flows.map((f) => f.firstMs));
  const to = Math.max(...flows.map((f) => f.lastMs));
  const start = timeParts(from, tz);
  // В «Кратко» ключ связи только названием типа: тип без названия не показан.
  const list = linkedTypes(op)
    .map((type) => ({ type, name: typeName(op, type) }))
    .filter((x) => !brief || x.name !== x.type)
    .map((x) => x.name)
    .join(', ');
  return (
    <p className="tabular mt-2 flex min-h-5 min-w-0 flex-wrap items-center gap-x-1.5 text-[13px] leading-5 text-muted-foreground" data-testid="operation-facts">
      <span>{t('operation.facts.start', start)}</span>
      <span aria-hidden>·</span>
      <span className="font-semibold text-foreground-2">{formatDuration(Math.max(0, to - from))}</span>
      <span aria-hidden>·</span>
      <span>{t('operation.facts.requests', { count: flows.length })}</span>
      {list && (
        <>
          <span aria-hidden>·</span>
          <span className="min-w-0 [overflow-wrap:anywhere]">{t('operation.facts.linked', { list })}</span>
        </>
      )}
    </p>
  );
}

/** Итог: «Отклонён», «Выполнен → Возврат», «В процессе», «Итог не прочитан»; подписи «по колбэку» и «по неполным данным». */
function OutcomeLine({ op, done, finished }: { op: OperationView; done: boolean; finished: boolean }) {
  const { t } = useTranslation();
  const o = op.outcome;
  // Пока поиск идёт, «Итог не прочитан» выдавал бы незнание за вывод.
  const searching = !done && o.kind === 'unknown';
  // Поиск оборвался, а статусов нет: логи прочитаны не все, вывода об операции нет.
  const notRead = done && !finished && o.kind === 'unknown';
  const Icon = searching
    ? RotateCcw
    : o.kind === 'success'
      ? CircleCheck
      : o.kind === 'failure'
        ? CircleX
        : o.kind === 'pending'
          ? Clock
          : CircleDashed;
  const text = searching
    ? t('operation.outcome.searching')
    : notRead
      ? t('operation.outcome.notRead')
      : o.kind === 'pending'
      ? t('operation.outcome.pending')
      : o.kind === 'unknown' || !o.status
        ? t('operation.outcome.unknown')
        : [o.previous ? statusName(o.previous) : null, statusName(o.status)].filter(Boolean).join(' → ');
  const notes = [
    o.basis === 'claimed' ? t('operation.outcome.claimed') : null,
    o.partial && !notRead ? t('operation.outcome.partial') : null,
    o.kind === 'pending' ? t('operation.outcome.pendingHint') : null,
    o.kind === 'unknown' && o.failed > 0 ? t('operation.outcome.errors', { count: o.failed }) : null,
  ].filter(Boolean);
  const tone = searching ? 'neutral' : o.kind === 'success' ? 'success' : o.kind === 'failure' ? 'danger' : 'neutral';
  return (
    <div
      className="mt-2 flex min-h-6 min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[13px]"
      data-testid="operation-outcome"
      data-kind={o.kind}
      data-basis={o.basis ?? undefined}
    >
      <span className="sr-only">{t('operation.outcome.label')}</span>
      <StatusCapsule tone={tone} className="max-w-full min-w-0 shrink">
        <Icon className={cn(searching && 'animate-spin')} aria-hidden />
        <span className="min-w-0 truncate" title={text}>
          {text}
        </span>
      </StatusCapsule>
      {!searching && notes.length > 0 && <span className="min-w-0 font-medium text-foreground-2">{notes.join(' · ')}</span>}
    </div>
  );
}

function Notices({
  op,
  s,
  window,
  widerHref,
  flows,
  tz,
  brief,
  onRetry,
  retrying,
  lost,
  supplement,
}: {
  op: OperationView;
  s: SearchState;
  window: '6h' | '24h';
  widerHref: string;
  flows: number;
  tz: string;
  brief: boolean;
  onRetry: () => void;
  retrying: boolean;
  lost: boolean;
  supplement: ReactNode;
}) {
  const { t } = useTranslation();
  const share = useShareMode();
  // Строка хода поиска постоянной высоты: прогресс сменяется итоговой фразой или кнопкой на том же месте, блоки ниже не едут.
  const status: ReactNode[] = [];
  if (s.status === 'running' && lost) {
    status.push(
      <span key="lost" className="inline-flex flex-wrap items-center gap-x-2 text-warning" role="status" data-testid="operation-poll-failed">
        <ServerCrash className="size-3.5 shrink-0" aria-hidden />
        <span className="font-semibold">{t('results.pollFailed')}</span>
        <span>{t('results.pollRetrying')}</span>
      </span>,
    );
  } else if (s.status === 'running') {
    const p = s.progress;
    const total = p.chunksTotal + p.batchesTotal;
    status.push(
      <span key="running" className="inline-flex items-center gap-2" aria-live="polite">
        <RotateCcw className="size-3.5 animate-spin" aria-hidden />
        {t('operation.notice.running')}
        {total > 0 && (
          <span className="tabular text-muted-foreground">
            {Math.round(((p.chunksDone + p.batchesDone) / total) * 100)} %
          </span>
        )}
      </span>,
    );
  }
  if (s.error) {
    const d = describeError(t, new ApiError(s.error.code as ApiError['code'], 0, s.error.details));
    const time = s.scannedFromMs !== null ? timeParts(s.scannedFromMs, tz).time.slice(0, 5) : null;
    status.push(
      <span key="error" className="text-danger" role="alert">
        {time
          ? t('operation.notice.error', { reason: d.title, time })
          : t('operation.notice.errorNoTime', { reason: d.title })}
      </span>,
      <Button key="retry" variant="secondary" size="sm" onClick={onRetry} disabled={retrying} data-testid="operation-retry">
        <RotateCcw className={retrying ? 'animate-spin' : undefined} aria-hidden />
        {t('states.retry')}
      </Button>,
    );
  }
  if (s.status === 'done' && !s.error && flows <= 1) {
    status.push(
      <span key="single" className="inline-flex flex-wrap items-center gap-2">
        {t('operation.notice.single')}
        {window === '6h' && !share && (
          <Link to={widerHref} className="font-medium text-primary hover:underline">
            {t('operation.notice.wider')}
          </Link>
        )}
      </span>,
    );
  }
  if (s.status === 'done' && !s.error && flows > 1 && !supplement) {
    status.push(<span key="finished" className="text-muted-foreground">{t('operation.notice.finished')}</span>);
  }
  const items: ReactNode[] = [];
  if (op.unknownType) items.push(<span key="type">{t('operation.unknownType', { type: op.key.type })}</span>);
  if (op.excluded.length > 0 && !brief)
    items.push(
      <span key="excluded">{t('operation.notice.excluded', { list: op.excluded.join(', ') })}</span>,
    );
  // В «Кратко» этих сообщений нет, а место остаётся: смена режима не сдвигает ход статусов и таблицу.
  const reserved = brief ? (op.excluded.length > 0 ? 1 : 0) + (op.unsearchedIds.length > 0 ? 1 : 0) : 0;
  if (op.unsearchedIds.length > 0 && !brief) {
    items.push(
      <span key="more" data-testid="operation-unsearched" className="inline-flex flex-wrap items-center gap-x-2">
        {t('operation.notice.unsearched')}
        {op.unsearchedIds.map((x) => (
          <span key={`${x.type}:${x.value}`} className="inline-flex items-center gap-1">
            <span className="text-muted-foreground">{x.name ?? x.type}</span>
            <code className="font-mono text-[12.5px]">{x.value}</code>
            <CopyIconButton text={x.value} label={t('operation.copyId', { value: x.value })} className="size-6" />
          </span>
        ))}
      </span>,
    );
  }
  if (window === '24h') items.push(<span key="long">{t('operation.notice.long')}</span>);
  return (
    // Только ход поиска: строка без подложки, как текст страницы. Высота та же, поэтому блоки ниже не едут, когда подложка появляется.
    <ul
      className={cn('-mt-3 flex flex-col gap-1 py-1.5 text-[13px]', (items.length > 0 || reserved > 0 || s.error || lost) && 'rounded-[10px] bg-sub px-3.5')}
      data-testid="operation-notices"
    >
      <li className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1" data-testid="operation-status-row">
        {status}
        {supplement}
      </li>
      {items.map((x, i) => (
        <li key={i}>{x}</li>
      ))}
      {Array.from({ length: reserved }, (_, i) => (
        <li key={`reserved-${i}`} aria-hidden className="h-5" />
      ))}
    </ul>
  );
}

/** Ход статусов линией с шагами: «В обработке → Отказ (заявлено в колбэке) → Отклонён», устаревшие серым. Много статусов переносятся, вбок страница не едет. */
function Trail({
  op,
  letters,
  tz,
  done,
  broken,
  multiDay,
}: {
  op: OperationView;
  letters: ReadonlyMap<string, string>;
  tz: string;
  done: boolean;
  broken: boolean;
  multiDay: boolean;
}) {
  const { t } = useTranslation();
  return (
    <section aria-labelledby="operation-trail-title" className="flex min-w-0 flex-col gap-3.5">
      <h2 id="operation-trail-title" className={SECTION_TITLE}>
        {t('operation.trail.title')}
      </h2>
      {op.trail.length === 0 ? (
        done || broken ? (
          <p className="text-[13px] text-muted-foreground" data-testid="operation-trail-empty">
            {t(done ? 'operation.trail.empty' : 'operation.trail.notRead')}
          </p>
        ) : (
          <Skeleton className="h-6 w-56 max-w-full" data-testid="operation-trail-skeleton" />
        )
      ) : (
        <ol className="grid min-w-0 gap-y-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr))]" data-testid="operation-trail">
          {op.trail.map((x, i) => {
            const last = i === op.trail.length - 1;
            // Операция ещё идёт: последний статус текущий, итога у него нет.
            const current = last && op.outcome.kind === 'pending';
            const failed = !x.stale && x.status.outcome === 'failure';
            // Пройденный шаг отмечен галочкой: красный только у отказа.
            const passed = !x.stale && !failed && !current;
            const letter = letters.get(flowKey(x));
            const time = multiDay ? shortDateTime(x.atMs, tz) : timeParts(x.atMs, tz).time;
            return (
              <li
                key={`${x.cid}:${x.atMs}:${i}`}
                className={cn('relative flex min-w-0 flex-col gap-1 pt-[30px] pr-3', x.stale && 'opacity-70')}
                data-stale={x.stale || undefined}
                data-claimed={x.claimed || undefined}
              >
                <span
                  className={cn(
                    'absolute top-0 left-0 flex size-[22px] items-center justify-center rounded-full [&_svg]:size-3.5',
                    failed ? 'bg-danger-bg text-danger' : passed ? 'bg-success-bg text-success' : 'bg-muted text-muted-foreground',
                    current && 'shadow-[0_0_0_2px_var(--background),0_0_0_3px_var(--muted-foreground)]',
                  )}
                >
                  {current ? <Clock aria-hidden /> : failed ? <X aria-hidden /> : passed ? <Check aria-hidden /> : <CircleDashed aria-hidden />}
                </span>
                {!last && <span aria-hidden className="absolute top-[11px] right-2 left-[30px] h-0.5 bg-input" />}
                <span className="min-w-0 [overflow-wrap:anywhere]">
                  <span className={cn('font-semibold', failed && 'text-danger')}>{statusName(x.status)}</span>
                  {x.claimed && <span className="text-[13px] text-muted-foreground"> · {t('operation.trail.claimed')}</span>}
                  {x.stale && <span className="text-[13px] text-muted-foreground"> · {t('operation.trail.stale')}</span>}
                </span>
                <span className="tabular min-w-0 text-[12px] leading-4 text-muted-foreground">
                  {[time, letter ? t('operation.trail.from', { letter }) : null, current ? t('operation.trail.current') : null].filter(Boolean).join(' · ')}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

export function OperationSkeleton({ running, progress }: { running: boolean; progress: SearchState | undefined }) {
  const { t } = useTranslation();
  return (
    <div
      className="flex flex-col gap-5"
      aria-busy="true"
      data-testid="operation-skeleton"
      data-status={progress?.status}
    >
      <div className="flex h-8 items-center justify-end gap-3">
        <Skeleton className="h-8 w-72 max-w-full" />
      </div>
      <Skeleton className="h-[26px] w-72 max-w-full" />
      <Skeleton className="h-6 w-56" />
      {running && (
        <p className="inline-flex items-center gap-2 text-[13px] text-muted-foreground" aria-live="polite">
          <RotateCcw className="size-3.5 animate-spin" aria-hidden />
          {t('operation.notice.running')}
        </p>
      )}
      <Skeleton className="h-[240px] w-full rounded-[var(--radius-card)]" />
    </div>
  );
}
