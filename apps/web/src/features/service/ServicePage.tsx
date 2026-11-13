// Страница /admin/status: «Состояние» — хранилища, база и вход одним списком, «Общие» — настройки сервиса одной формой.
// Открытие читает только сервер Threadline, хранилище проверяется по нажатию у своей строки или «Проверить всё».
import { formatDateTime, type BackendType, type ConnectionStatus, type ProbeResponse, type ProjectSettingsResponse, type StoreInfo } from '@threadline/core';
import { Database, Loader2, LogIn, RefreshCw, RotateCcw, Server, ServerCrash, type LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router';
import { Page } from '@/components/shell/Page.tsx';
import { connectionText } from '@/components/shell/status.ts';
import { StateMessage } from '@/components/states/StateMessage.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { useAccess } from '@/features/auth/access.tsx';
import { Notice } from '@/features/catalog/ui.tsx';
import { enc, projectSend, projectErrorCode } from '@/features/projects/api.ts';
import { SourceNotice } from '@/features/projects/parts.tsx';
import { useProjectSettings } from '@/features/projects/queries.ts';
import { SectionHead } from '@/features/settings/section-head.tsx';
import { SettingsSection } from '@/features/settings/slot.tsx';
import { LocalStoragesLink } from '@/features/local/slot.tsx';
import { isAccessDenied } from '@/lib/api.ts';
import { useDelayed } from '@/lib/use-delayed.ts';
import { cn } from '@/lib/utils.ts';

export interface StoreCheck {
  pending: boolean;
  data: ProbeResponse | null;
  error: unknown;
  /** Когда нажали «Проверить», мс: время в строке, пока проверка идёт. */
  startedAt?: number;
}

/** Где сбой: ok, настройка подключения у нас, хранилище или сеть до него, сам сервер Threadline. */
export type CheckSide = 'ok' | 'ours' | 'remote' | 'self';

const OURS: ReadonlySet<ConnectionStatus> = new Set<ConnectionStatus>(['not-configured', 'unauthorized', 'forbidden', 'not-found', 'certificate']);

export function checkSide(check: StoreCheck | undefined): CheckSide | null {
  if (!check || check.pending) return null;
  if (check.error) return 'self';
  if (!check.data) return null;
  if (check.data.status === 'connected' || check.data.status === 'demo') return 'ok';
  return OURS.has(check.data.status) ? 'ours' : 'remote';
}

/** Запрос только по нажатию. Вторая проверка той же строки при идущей не запускается, уход со страницы отменяет идущие, результат нигде не хранится. */
function useStoreChecks() {
  const [checks, setChecks] = useState<Record<string, StoreCheck>>({});
  const running = useRef(new Map<string, AbortController>());
  useEffect(() => {
    const active = running.current;
    return () => {
      for (const ac of active.values()) ac.abort();
      active.clear();
    };
  }, []);
  const run = useCallback(async (store: string) => {
    if (running.current.has(store)) return;
    const ac = new AbortController();
    running.current.set(store, ac);
    setChecks((c) => ({ ...c, [store]: { pending: true, data: c[store]?.data ?? null, error: null, startedAt: Date.now() } }));
    let next: StoreCheck;
    try {
      next = { pending: false, data: await projectSend<ProbeResponse>('POST', `/api/stores/${enc(store)}/probe`, {}, ac.signal), error: null };
    } catch (e) {
      next = { pending: false, data: null, error: e };
    }
    if (ac.signal.aborted) return;
    running.current.delete(store);
    setChecks((c) => ({ ...c, [store]: next }));
  }, []);
  return { checks, run };
}

export default function ServicePage() {
  const { t } = useTranslation();
  const access = useAccess();
  const admin = access.can('editSettings');
  const toSettings = useLocation().hash === '#settings';
  const settings = useProjectSettings();
  const skeleton = useDelayed(settings.isPending, 300);
  if (settings.isPending) return <ServiceSkeleton shown={skeleton} />;
  if (settings.isError || !settings.data) {
    return (
      <StateMessage icon={ServerCrash} tone="danger" title={t('service.loadFailed')} text={t('service.loadFailedText', { code: projectErrorCode(settings.error) ?? 'unknown' })}>
        <Button onClick={() => void settings.refetch()} disabled={settings.isFetching}>
          <RotateCcw className={settings.isFetching ? 'animate-spin' : undefined} aria-hidden />
          {t('states.retry')}
        </Button>
      </StateMessage>
    );
  }
  const data = settings.data;
  return (
    <Page className="mx-auto flex max-w-[928px] flex-col gap-[34px] lg:pt-8 lg:pb-11" data-testid="service-page">
      <h1 className="text-title font-semibold tracking-[-0.015em] text-heading">{t('service.title')}</h1>
      {toSettings && !admin && (
        <Notice tone="warning" testId="service-settings-closed">
          {t('service.settingsClosed')}
        </Notice>
      )}
      <Status data={data} />
      {admin && (data.state === 'off' ? <Notice testId="service-no-settings">{t('service.noSettings')}</Notice> : <SettingsSection scrollTo={toSettings} />)}
    </Page>
  );
}

const ROW = 'grid min-h-[60px] min-w-0 items-center gap-x-3.5 gap-y-1 border-t border-border px-4 py-2 first:border-t-0 grid-cols-[32px_minmax(0,1fr)_auto] md:grid-cols-[32px_minmax(0,1fr)_minmax(0,300px)_112px]';
const DOT = { ok: 'bg-success', warn: 'bg-warning', bad: 'bg-danger', muted: 'bg-muted-foreground/60' } as const;
const TONE = { ok: 'text-success', warn: 'text-warning', bad: 'text-danger', muted: 'text-foreground-2' } as const;
type Tone = keyof typeof DOT;

/** Строка списка состояния: значок, имя и вид, итог с пояснением, кнопка проверки там, где проверка есть. */
function StatusRow({ icon: Icon, name, kind, tone, status, note, action, detail, testId, store }: { icon: LucideIcon; name: ReactNode; kind: ReactNode; tone: Tone; status: string; note?: ReactNode; action?: ReactNode; detail?: ReactNode; testId: string; store?: string }) {
  return (
    <li className="flex flex-col" data-testid={testId} data-store={store}>
      <div className={ROW}>
        <span aria-hidden className="flex size-8 items-center justify-center rounded-[8px] bg-background text-foreground-2 shadow-[inset_0_0_0_1px_var(--color-border)]">
          <Icon className="size-4" />
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-semibold text-foreground">{name}</span>
          <span className="truncate text-[12px] leading-[17px] text-muted-foreground">{kind}</span>
        </span>
        <span className="flex min-w-0 flex-col max-md:col-start-2 max-md:row-start-2" aria-live="polite">
          <span className={cn('inline-flex min-w-0 items-center gap-[7px] text-[13px] font-medium', TONE[tone])} data-testid="row-status">
            <i aria-hidden className={cn('size-[7px] shrink-0 rounded-full', DOT[tone])} />
            <span className="min-w-0 truncate" title={status}>
              {status}
            </span>
          </span>
          {note && <span className="text-[12px] leading-[17px] [overflow-wrap:anywhere] text-muted-foreground">{note}</span>}
        </span>
        <span className="justify-self-end max-md:col-start-3 max-md:row-span-2 max-md:row-start-1">{action}</span>
      </div>
      {detail}
    </li>
  );
}

function kindLabel(type: BackendType, mock: string): string {
  const labels: Record<BackendType, string> = { 'loki-grafana': 'Grafana · Loki', loki: 'Loki', mock };
  return labels[type];
}

const DB_TONE: Record<ProjectSettingsResponse['state'], { tone: Tone; key: 'dbOk' | 'dbOff' | 'dbConnecting' | 'dbDown' }> = {
  ok: { tone: 'ok', key: 'dbOk' },
  off: { tone: 'muted', key: 'dbOff' },
  connecting: { tone: 'muted', key: 'dbConnecting' },
  error: { tone: 'bad', key: 'dbDown' },
  stale: { tone: 'bad', key: 'dbDown' },
};

/** «Состояние»: хранилища, база и вход одним списком. Итог проверок одной строкой под ним. */
function Status({ data }: { data: ProjectSettingsResponse }) {
  const { t } = useTranslation();
  const access = useAccess();
  const { checks, run } = useStoreChecks();
  const zone = data.projects[0]?.timezone ?? 'UTC';
  const time = (ms: number) => formatDateTime(ms, zone).slice(-8, -3);
  const db = DB_TONE[data.state];
  const busy = data.stores.some((s) => checks[s.id]?.pending);
  return (
    <section className="flex flex-col gap-3" aria-labelledby="status-title" data-testid="service-status">
      <div className="flex min-w-0 flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div id="status-title">
          <SectionHead title={t('service.state.title')} text={t('service.state.lead')} />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <LocalStoragesLink />
          {data.stores.length > 0 && (
            <Button type="button" variant="ghost" disabled={busy} onClick={() => data.stores.forEach((s) => void run(s.id))} data-testid="stores-probe-all">
              <RefreshCw className={busy ? 'animate-spin' : undefined} aria-hidden />
              {t('service.state.checkAll')}
            </Button>
          )}
        </div>
      </div>
      {(data.state === 'connecting' || data.state === 'error' || data.state === 'stale') && <SourceNotice settings={data} />}
      <ul className="min-w-0 overflow-hidden rounded-[12px] bg-sub" data-testid="stores-list">
        {data.stores.map((s) => (
          <StoreRow key={s.id} store={s} check={checks[s.id]} time={time} onCheck={() => void run(s.id)} />
        ))}
        <StatusRow icon={Database} name={t('service.db.name')} kind={t('service.db.kind')} tone={db.tone} status={t(`service.summary.${db.key}`)} note={data.state === 'ok' && data.loadedAt ? t('service.db.loadedAt', { time: time(data.loadedAt) }) : undefined} testId="status-database" />
        <StatusRow icon={LogIn} name={t('service.login.name')} kind={access.mode === 'off' ? t('service.login.offKind') : t('service.login.oidc')} tone={access.mode === 'off' ? 'muted' : 'ok'} status={access.mode === 'off' ? t('service.login.off') : t('service.login.on')} testId="status-login" />
      </ul>
      {data.stores.length === 0 && <Notice testId="stores-empty">{t('service.stores.empty')}</Notice>}
      <Verdict stores={data.stores} checks={checks} />
      <p className="text-[12.5px] leading-[18px] text-muted-foreground">
        <Link to="/docs/admin-grafana" className="text-primary underline-offset-2 hover:underline" data-testid="stores-docs">
          {t('service.docs')}
        </Link>
      </p>
    </section>
  );
}

/** Ответ на вопрос страницы одной строкой. Появляется после первой проверки. */
function Verdict({ stores, checks }: { stores: StoreInfo[]; checks: Record<string, StoreCheck> }) {
  const { t } = useTranslation();
  const named = (side: CheckSide) => stores.filter((s) => checkSide(checks[s.id]) === side).map((s) => s.id);
  const remote = named('remote');
  const ours = named('ours');
  let text: string | null = null;
  let tone = 'text-success';
  if (named('self').length > 0) {
    text = t('service.verdict.self');
    tone = 'text-danger';
  } else if (remote.length > 0) {
    text = t('service.verdict.remote', { list: remote.join(', ') });
    tone = 'text-danger';
  } else if (ours.length > 0) {
    text = t('service.verdict.ours', { list: ours.join(', ') });
    tone = 'text-warning';
  } else if (named('ok').length > 0) text = t('service.verdict.ok');
  return (
    <p role="status" className={cn('min-w-0 text-[13px] leading-5 font-medium [overflow-wrap:anywhere] empty:hidden', tone)} data-testid="service-verdict">
      {text}
    </p>
  );
}

function StoreRow({ store: s, check, time, onCheck }: { store: StoreInfo; check: StoreCheck | undefined; time: (ms: number) => string; onCheck: () => void }) {
  const { t } = useTranslation();
  const mock = s.type === 'mock';
  const open = s.scope?.values.includes('*') === true;
  const scopeFull = !s.scope ? t('projects.stores.noScope', { id: s.id }) : open ? t('projects.stores.scopeOpen', { label: s.scope.label }) : t('projects.stores.scope', { label: s.scope.label, values: s.scope.values.join(', ') });
  const scopeShort = !s.scope ? t('service.stores.scopeNone') : `${s.scope.label}: ${open ? '*' : s.scope.values.join(', ')}`;
  const side = checkSide(check);
  // Итог строки: идущая проверка, её результат, иначе то, что видно без проверки (нет токена), иначе «Не проверено».
  let tone: Tone = 'muted';
  let status = t('service.stores.notChecked');
  let note: ReactNode = null;
  let probe: string | undefined;
  if (check?.pending) {
    status = t('service.stores.checking');
    note = check.startedAt ? t('service.stores.startedAt', { time: time(check.startedAt) }) : null;
  } else if (check?.error) {
    tone = 'bad';
    status = t('service.stores.failed');
    probe = 'invalid';
  } else if (check?.data) {
    const { status: code } = check.data;
    status = code === 'connected' ? t('service.stores.working') : code === 'not-configured' ? t('service.stores.noToken') : t(`connection.status.${code}.title`);
    tone = side === 'ok' ? 'ok' : side === 'ours' ? 'warn' : 'bad';
    note = t('service.stores.checkedAt', { time: time(Date.parse(check.data.checkedAt)) });
    probe = code;
  } else if (s.tokenSet === false) {
    tone = 'warn';
    status = t('service.stores.tokenMissing');
    note = s.tokenEnv ? t('service.stores.tokenHint', { env: s.tokenEnv }) : null;
  }
  const kind = (
    <>
      {kindLabel(s.type, t('projects.stores.mock'))}
      {!mock && (
        <>
          {' · '}
          <span title={scopeFull} data-testid="store-scope">
            {scopeShort}
          </span>
        </>
      )}
      {!mock && s.tokenSet !== undefined && (
        <span className="sr-only" data-testid="token-state">
          {' · '}
          {t('service.stores.token')}: {s.tokenSet ? t('projects.stores.tokenSet') : t('projects.stores.tokenMissing')}
        </span>
      )}
    </>
  );
  return (
    <StatusRow
      icon={Server}
      name={<span title={s.id}>{s.id}</span>}
      kind={kind}
      tone={tone}
      status={status}
      note={probe ? <span data-testid="probe-result" data-status={probe}>{note}</span> : note}
      testId="store-row"
      store={s.id}
      action={
        <Button variant="secondary" size="sm" disabled={check?.pending} aria-busy={check?.pending} aria-label={`${t('service.stores.check')}: ${s.id}`} onClick={onCheck} data-testid="store-probe">
          {check?.pending ? <Loader2 className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}
          {t('service.stores.check')}
        </Button>
      }
      detail={<CheckDetail check={check} />}
    />
  );
}

/** Что сделать при сбое: появляется только после нажатия и только у этой строки. */
function CheckDetail({ check }: { check: StoreCheck | undefined }) {
  const { t } = useTranslation();
  if (!check || check.pending) return null;
  if (check.error) {
    return (
      <p className="px-4 pb-2 pl-[62px] text-[12.5px] leading-[18px] text-danger" data-testid="store-detail">
        {isAccessDenied(check.error) ? t('projects.problem.forbidden') : t('projects.probe.failed')}
      </p>
    );
  }
  const data = check.data;
  if (!data || data.status === 'connected' || data.status === 'demo') return null;
  return (
    <div className="px-4 pb-2 pl-[62px] text-[12.5px] leading-[18px] [overflow-wrap:anywhere] text-muted-foreground" data-testid="store-detail">
      {connectionText(t, data)}
      {data.retryAfterSeconds !== undefined && <> {t('connection.retryIn', { seconds: data.retryAfterSeconds })}</>}
      {data.details && (
        <details>
          <summary className="cursor-pointer hover:text-foreground">{t('connection.details')}</summary>
          <p className="font-mono text-[12px] leading-[18px] break-words">{data.details}</p>
        </details>
      )}
    </div>
  );
}

/** Заготовка тех же размеров, что страница: заголовок, список состояния, форма. */
function ServiceSkeleton({ shown }: { shown: boolean }) {
  return (
    <Page className="mx-auto flex max-w-[928px] flex-col gap-[34px] lg:pt-8 lg:pb-11" aria-busy="true" data-testid="page-skeleton">
      {shown && (
        <>
          <Skeleton className="h-[26px] w-48" />
          <div className="flex flex-col gap-3">
            <Skeleton className="h-10 w-80 max-w-full" />
            <Skeleton className="h-64 w-full rounded-[12px]" />
          </div>
        </>
      )}
    </Page>
  );
}
