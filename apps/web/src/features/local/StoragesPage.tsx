// Страница /admin/storages локального режима: своя Grafana или свой Loki. «Проверить» идёт в хранилище тем же check, что страница сервиса,
// «Сохранить» пишет файл storages.json на этом компьютере и подключает хранилище без перезапуска. Токен обратно не приходит.
import type { LocalStorageAuth, LocalStorageInfo, LocalStorageInput, ProbeResponse } from '@threadline/core';
import { CircleAlert, CircleCheck, Loader2, RefreshCw, Save, ServerCrash, Trash2 } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Page } from '@/components/shell/Page.tsx';
import { StateMessage } from '@/components/states/StateMessage.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Card } from '@/components/ui/card.tsx';
import { StatusChip } from '@/components/ui/chip.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Segmented } from '@/components/ui/segmented.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { Notice } from '@/features/catalog/ui.tsx';
import { languageOf } from '@/i18n/languages.ts';
import { cn } from '@/lib/utils.ts';
import { checkStorage, StorageApiError, useDeleteStorage, useLocalStorages, useSaveStorage } from './api.ts';
import { useLocalMode } from './slot.tsx';

type Kind = 'loki-grafana' | 'loki';
type DatasourceKind = 'name' | 'uid' | 'id';

export interface Draft {
  type: Kind;
  id: string;
  url: string;
  token: string;
  dsKind: DatasourceKind;
  ds: string;
  tenant: string;
  auth: LocalStorageAuth;
  username: string;
  password: string;
  scopeLabel: string;
}

export const EMPTY: Draft = { type: 'loki-grafana', id: 'grafana', url: '', token: '', dsKind: 'name', ds: 'Loki', tenant: '', auth: 'none', username: '', password: '', scopeLabel: 'namespace' };

/** Тело запроса из формы: поля другого типа и другого входа не уходят. Чистая функция: её читает тест. */
export function toInput(d: Draft): LocalStorageInput {
  const base = { id: d.id.trim(), type: d.type, url: d.url.trim(), scopeLabel: d.scopeLabel.trim() };
  if (d.type === 'loki-grafana') {
    const value = d.ds.trim();
    const datasource = d.dsKind === 'id' ? { id: Number(value) } : d.dsKind === 'uid' ? { uid: value } : { name: value };
    return { ...base, datasource, token: d.token.trim() };
  }
  return {
    ...base,
    ...(d.tenant.trim() ? { tenant: d.tenant.trim() } : {}),
    auth: d.auth,
    ...(d.auth === 'bearer' ? { token: d.token.trim() } : {}),
    ...(d.auth === 'basic' ? { username: d.username.trim(), password: d.password } : {}),
  };
}

/** Незаполненные обязательные поля: без запроса к серверу. Остальные правила проверяет сервер. */
export function missingFields(d: Draft): string[] {
  const out: string[] = [];
  if (!d.id.trim()) out.push('id');
  if (!d.url.trim()) out.push('url');
  if (!d.scopeLabel.trim()) out.push('scopeLabel');
  if (d.type === 'loki-grafana') {
    if (!d.token.trim()) out.push('token');
    if (!d.ds.trim()) out.push('datasource');
  } else if (d.auth === 'bearer' && !d.token.trim()) out.push('token');
  else if (d.auth === 'basic') {
    if (!d.username.trim()) out.push('username');
    if (!d.password) out.push('password');
  }
  return out;
}

export type InvalidKey = 'id' | 'type' | 'grafanaUrl' | 'lokiUrl' | 'tenant' | 'auth' | 'grafanaToken' | 'bearer' | 'username' | 'password' | 'datasource' | 'scopeLabel' | 'other';

/** Общий текст ошибки поля на языке интерфейса: по имени поля из ответа сервера и типу хранилища. */
export function invalidKey(field: string, type: Kind): InvalidKey {
  if (field === 'url') return type === 'loki' ? 'lokiUrl' : 'grafanaUrl';
  if (field === 'token') return type === 'loki' ? 'bearer' : 'grafanaToken';
  const known: readonly string[] = ['id', 'type', 'tenant', 'auth', 'username', 'password', 'datasource', 'scopeLabel'];
  return known.includes(field) ? (field as InvalidKey) : 'other';
}

/**
 * Ошибки полей из ответа сервера. Сервер пишет их по-русски: на русском интерфейсе видны его точные тексты,
 * на другом языке — общий текст поля из файла строк.
 */
export function serverFieldErrors(fields: Record<string, string>, type: Kind, russian: boolean, text: (key: InvalidKey) => string): Record<string, string> {
  if (russian) return fields;
  return Object.fromEntries(Object.keys(fields).map((f) => [f, text(invalidKey(f, type))]));
}

export default function StoragesPage() {
  const { t } = useTranslation();
  const local = useLocalMode();
  const list = useLocalStorages(local);
  const [saved, setSaved] = useState<string | null>(null);
  if (!local) {
    return (
      <Page className="flex flex-col gap-4" data-testid="local-storages-page">
        <h1 className="text-title font-semibold text-heading">{t('local.page.title')}</h1>
        <Notice testId="local-not-local">{t('local.page.notLocal')}</Notice>
      </Page>
    );
  }
  return (
    <Page className="mx-auto flex max-w-[928px] flex-col gap-6" data-testid="local-storages-page">
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="text-title font-semibold text-heading">{t('local.page.title')}</h1>
        <p className="max-w-[46rem] text-[13px] leading-[18px] text-muted-foreground">{t('local.page.lead')}</p>
        {list.data && (
          <p className="text-[12.5px] leading-[18px] text-muted-foreground [overflow-wrap:anywhere]" data-testid="local-storages-file">
            {t('local.page.file', { file: list.data.file })}
          </p>
        )}
      </div>
      {saved && (
        <Notice
          icon={CircleCheck}
          testId="local-storage-saved"
          actions={
            <Button asChild size="sm">
              <Link to="/admin/projects/new">{t('local.page.createProject')}</Link>
            </Button>
          }
        >
          {t('local.form.saved', { id: saved })} {t('local.page.next')}
        </Notice>
      )}
      <StorageForm taken={list.data?.storages.map((s) => s.id) ?? []} onSaved={setSaved} />
      <section className="flex flex-col gap-3" aria-labelledby="local-storages-title">
        <h2 id="local-storages-title" className="text-section font-semibold text-heading">
          {t('local.list.title')}
        </h2>
        {list.isPending ? (
          <Skeleton className="h-16 w-full rounded-[var(--radius-card)]" />
        ) : list.isError || !list.data ? (
          <StateMessage icon={ServerCrash} tone="danger" title={t('local.page.loadFailed')}>
            <Button onClick={() => void list.refetch()}>{t('states.retry')}</Button>
          </StateMessage>
        ) : list.data.storages.length === 0 ? (
          <Notice testId="local-storages-empty">{t('local.list.empty')}</Notice>
        ) : (
          <Card className="min-w-0 overflow-hidden">
            <ul data-testid="local-storages-list">
              {list.data.storages.map((s) => (
                <StorageRow key={s.id} storage={s} onDeleted={() => setSaved((v) => (v === s.id ? null : v))} />
              ))}
            </ul>
          </Card>
        )}
      </section>
    </Page>
  );
}

function Field({ label, hint, error, optional, children }: { label: string; hint?: ReactNode; error?: string | null | undefined; optional?: boolean; children: (p: { id: string; 'aria-invalid'?: boolean; 'aria-describedby'?: string }) => ReactNode }) {
  const { t } = useTranslation();
  const id = useId();
  const described = error || hint ? `${id}-d` : undefined;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-[13px] leading-5 font-medium text-foreground">
        {label}
        {optional && <span className="font-normal text-muted-foreground"> · {t('local.form.optional')}</span>}
      </label>
      {children({ id, ...(error ? { 'aria-invalid': true } : {}), ...(described ? { 'aria-describedby': described } : {}) })}
      {error ? (
        <p id={described} className="flex items-start gap-1.5 text-[12px] leading-4 text-danger" data-testid="field-error">
          <CircleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 break-words">{error}</span>
        </p>
      ) : (
        hint && (
          <p id={described} className="text-[12px] leading-4 text-muted-foreground">
            {hint}
          </p>
        )
      )}
    </div>
  );
}

interface CheckState {
  pending: boolean;
  data: ProbeResponse | null;
  failed: boolean;
}

function StorageForm({ taken, onSaved }: { taken: string[]; onSaved: (id: string) => void }) {
  const { t, i18n } = useTranslation();
  const [d, setDraft] = useState<Draft>(EMPTY);
  const [idTouched, setIdTouched] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [check, setCheck] = useState<CheckState>({ pending: false, data: null, failed: false });
  const [problem, setProblem] = useState<string | null>(null);
  const save = useSaveStorage();
  const running = useRef<AbortController | null>(null);
  useEffect(() => () => running.current?.abort(), []);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((old) => {
      const next = { ...old, [key]: value };
      // Имя по типу, пока его не меняли руками: grafana или loki, со вторым номером, если занято.
      if (key === 'type' && !idTouched) next.id = freeId(value === 'loki' ? 'loki' : 'grafana', taken);
      return next;
    });
    if (key === 'id') setIdTouched(true);
    setErrors((e) => {
      const { [key === 'ds' || key === 'dsKind' ? 'datasource' : key]: _drop, ...rest } = e;
      return rest;
    });
    // Изменённая форма — уже другое подключение: прежний результат проверки к ней не относится.
    running.current?.abort();
    setCheck({ pending: false, data: null, failed: false });
    setProblem(null);
  };

  const fromServer = (fields: Record<string, string>) => serverFieldErrors(fields, d.type, languageOf(i18n.language).code === 'ru', (key) => t(`local.form.invalid.${key}`));

  const required = (): boolean => {
    const missing = missingFields(d);
    if (missing.length === 0) return true;
    setErrors(Object.fromEntries(missing.map((f) => [f, t('local.form.required')])));
    return false;
  };

  const runCheck = async () => {
    if (check.pending || !required()) return;
    running.current?.abort();
    const ac = new AbortController();
    running.current = ac;
    setCheck({ pending: true, data: null, failed: false });
    setProblem(null);
    try {
      const data = await checkStorage(toInput(d), ac.signal);
      if (!ac.signal.aborted) setCheck({ pending: false, data, failed: false });
    } catch (e) {
      if (ac.signal.aborted) return;
      setCheck({ pending: false, data: null, failed: !(e instanceof StorageApiError && e.code === 'storage-invalid') });
      if (e instanceof StorageApiError && e.code === 'storage-invalid') setErrors(fromServer(e.fields));
    }
  };

  const runSave = () => {
    if (save.isPending || !required()) return;
    setProblem(null);
    save.mutate(toInput(d), {
      onSuccess: (info) => {
        onSaved(info?.id ?? d.id.trim());
        setDraft({ ...EMPTY, id: freeId('grafana', [...taken, info?.id ?? d.id.trim()]) });
        setIdTouched(false);
        setCheck({ pending: false, data: null, failed: false });
      },
      onError: (e) => {
        if (e instanceof StorageApiError && e.code === 'storage-invalid') setErrors(fromServer(e.fields));
        else if (e instanceof StorageApiError && e.code === 'storage-exists') setErrors({ id: t('local.form.exists') });
        else setProblem(e instanceof StorageApiError && e.code === 'storage-save-failed' ? t('local.form.saveFailed') : t('local.form.failed'));
      },
    });
  };

  const grafana = d.type === 'loki-grafana';
  const ok = check.data?.status === 'connected';
  return (
    <Card className="flex min-w-0 flex-col gap-5 px-5 py-5" data-testid="local-storage-form">
      <h2 className="text-section font-semibold text-heading">{t('local.form.title')}</h2>
      <form
        className="flex min-w-0 flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) runSave();
          else void runCheck();
        }}
      >
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] leading-5 font-medium text-foreground">{t('local.form.type')}</span>
          <Segmented
            label={t('local.form.type')}
            value={d.type}
            onChange={(v) => set('type', v)}
            options={[
              { value: 'loki-grafana', label: t('local.form.typeGrafana'), testId: 'local-type-grafana' },
              { value: 'loki', label: t('local.form.typeLoki'), testId: 'local-type-loki' },
            ]}
          />
        </div>
        <div className="grid min-w-0 gap-4 md:grid-cols-2">
          <Field label={grafana ? t('local.form.grafanaUrl') : t('local.form.lokiUrl')} hint={grafana ? undefined : t('local.form.lokiUrlHint')} error={errors.url}>
            {(p) => <Input {...p} name="url" type="url" inputMode="url" autoComplete="off" spellCheck={false} placeholder={grafana ? 'https://grafana.example' : 'http://localhost:3100'} value={d.url} onChange={(e) => set('url', e.target.value)} />}
          </Field>
          <Field label={t('local.form.id')} hint={t('local.form.idHint')} error={errors.id}>
            {(p) => <Input {...p} name="id" autoComplete="off" spellCheck={false} maxLength={32} value={d.id} onChange={(e) => set('id', e.target.value.toLowerCase())} />}
          </Field>
        </div>
        {grafana ? (
          <>
            <Field label={t('local.form.token')} hint={t('local.form.tokenHint')} error={errors.token}>
              {(p) => <Input {...p} name="token" type="password" autoComplete="off" spellCheck={false} value={d.token} onChange={(e) => set('token', e.target.value)} />}
            </Field>
            <div className="grid min-w-0 gap-4 md:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <span className="text-[13px] leading-5 font-medium text-foreground">{t('local.form.datasourceKind')}</span>
                <Segmented
                  label={t('local.form.datasourceKind')}
                  value={d.dsKind}
                  onChange={(v) => set('dsKind', v)}
                  options={[
                    { value: 'name', label: t('local.form.datasourceName') },
                    { value: 'uid', label: t('local.form.datasourceUid') },
                    { value: 'id', label: t('local.form.datasourceId') },
                  ]}
                />
              </div>
              <Field label={t('local.form.datasource')} error={errors.datasource}>
                {(p) => <Input {...p} name="datasource" autoComplete="off" spellCheck={false} inputMode={d.dsKind === 'id' ? 'numeric' : undefined} value={d.ds} onChange={(e) => set('ds', e.target.value)} />}
              </Field>
            </div>
          </>
        ) : (
          <>
            <div className="flex flex-col gap-1.5">
              <span className="text-[13px] leading-5 font-medium text-foreground">{t('local.form.auth')}</span>
              <Segmented
                label={t('local.form.auth')}
                value={d.auth}
                onChange={(v) => set('auth', v)}
                options={[
                  { value: 'none', label: t('local.form.authNone'), testId: 'local-auth-none' },
                  { value: 'bearer', label: t('local.form.authBearer'), testId: 'local-auth-bearer' },
                  { value: 'basic', label: t('local.form.authBasic'), testId: 'local-auth-basic' },
                ]}
              />
              {errors.auth && <p className="text-[12px] leading-4 text-danger">{errors.auth}</p>}
            </div>
            {d.auth === 'bearer' && (
              <Field label={t('local.form.bearer')} error={errors.token}>
                {(p) => <Input {...p} name="token" type="password" autoComplete="off" spellCheck={false} value={d.token} onChange={(e) => set('token', e.target.value)} />}
              </Field>
            )}
            {d.auth === 'basic' && (
              <div className="grid min-w-0 gap-4 md:grid-cols-2">
                <Field label={t('local.form.username')} error={errors.username}>
                  {(p) => <Input {...p} name="username" autoComplete="off" spellCheck={false} value={d.username} onChange={(e) => set('username', e.target.value)} />}
                </Field>
                <Field label={t('local.form.password')} error={errors.password}>
                  {(p) => <Input {...p} name="password" type="password" autoComplete="new-password" value={d.password} onChange={(e) => set('password', e.target.value)} />}
                </Field>
              </div>
            )}
            <Field label={t('local.form.tenant')} hint={t('local.form.tenantHint')} error={errors.tenant} optional>
              {(p) => <Input {...p} name="tenant" autoComplete="off" spellCheck={false} value={d.tenant} onChange={(e) => set('tenant', e.target.value)} />}
            </Field>
          </>
        )}
        <Field label={t('local.form.scopeLabel')} hint={t('local.form.scopeHint')} error={errors.scopeLabel}>
          {(p) => <Input {...p} name="scopeLabel" autoComplete="off" spellCheck={false} className="md:max-w-[260px]" value={d.scopeLabel} onChange={(e) => set('scopeLabel', e.target.value)} />}
        </Field>
        {errors.type && <Notice tone="danger">{errors.type}</Notice>}
        <CheckResult check={check} />
        {problem && (
          <Notice tone="danger" testId="local-storage-problem">
            {problem}
          </Notice>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant={ok ? 'secondary' : 'default'} onClick={() => void runCheck()} disabled={check.pending} aria-busy={check.pending} data-testid="local-storage-check">
            {check.pending ? <Loader2 className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}
            {check.pending ? t('local.form.checking') : t('local.form.check')}
          </Button>
          <Button type="button" variant={ok ? 'default' : 'secondary'} onClick={runSave} disabled={save.isPending} aria-busy={save.isPending} data-testid="local-storage-save">
            {save.isPending ? <Loader2 className="animate-spin" aria-hidden /> : <Save aria-hidden />}
            {save.isPending ? t('local.form.saving') : ok ? t('local.form.save') : t('local.form.saveAnyway')}
          </Button>
          {!ok && !check.pending && <span className="text-[12.5px] leading-5 text-muted-foreground">{t('local.form.checkFirst')}</span>}
        </div>
      </form>
    </Card>
  );
}

/** grafana, затем grafana-2, grafana-3…: первое свободное имя. */
export function freeId(base: string, taken: readonly string[]): string {
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) if (!taken.includes(`${base}-${n}`)) return `${base}-${n}`;
}

function CheckResult({ check }: { check: CheckState }) {
  const { t, i18n } = useTranslation();
  if (check.failed) return <Notice tone="danger">{t('local.form.failed')}</Notice>;
  const data = check.data;
  if (!data) return null;
  if (data.status === 'connected') {
    return (
      <div role="status" className="flex min-w-0 flex-wrap items-center gap-2" data-testid="local-check-result" data-status="connected">
        <StatusChip tone="success">
          <CircleCheck aria-hidden />
          {t('local.check.connected')}
        </StatusChip>
        <span className="text-[12.5px] leading-5 text-muted-foreground">{t('local.check.labels', { count: data.labelNames?.length ?? 0 })}</span>
      </div>
    );
  }
  const key = `local.check.${data.status}`;
  const text = i18n.exists(key) ? String(t(key as never)) : t('local.check.other', { code: data.status });
  return (
    <div role="alert" className="flex min-w-0 flex-col gap-1.5" data-testid="local-check-result" data-status={data.status}>
      <StatusChip tone="danger" className="self-start">
        <CircleAlert aria-hidden />
        {t(`connection.status.${data.status}.title` as never)}
      </StatusChip>
      <p className="text-[12.5px] leading-[18px] text-muted-foreground [overflow-wrap:anywhere]">{text}</p>
      {data.details && (
        <details className="text-[12.5px] leading-[18px] text-muted-foreground">
          <summary className="cursor-pointer hover:text-foreground">{t('local.check.details')}</summary>
          <p className="font-mono text-[12px] break-words">{data.details}</p>
        </details>
      )}
    </div>
  );
}

function StorageRow({ storage: s, onDeleted }: { storage: LocalStorageInfo; onDeleted: () => void }) {
  const { t } = useTranslation();
  const [confirm, setConfirm] = useState(false);
  const remove = useDeleteStorage();
  const kind = s.type === 'loki-grafana' ? 'Grafana · Loki' : 'Loki';
  const auth = s.auth === 'basic' ? t('local.list.authBasic') : s.auth === 'bearer' ? t('local.list.authBearer') : t('local.list.authNone');
  return (
    <li className="flex min-w-0 flex-col gap-2 border-t border-border px-5 py-3 first:border-t-0" data-testid="local-storage-row" data-storage={s.id}>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-[13.5px] leading-5 font-semibold text-foreground">{s.id}</span>
          <span className="text-[12.5px] leading-[18px] text-muted-foreground [overflow-wrap:anywhere]">
            {kind} · {s.url} · {auth}
            {s.tenant && ` · ${t('local.list.tenant', { tenant: s.tenant })}`}
          </span>
          <span className="text-[12.5px] leading-[18px] text-muted-foreground">{s.usedBy.length > 0 ? t('local.list.usedBy', { list: s.usedBy.join(', ') }) : t('local.list.unused')}</span>
        </div>
        {!confirm && (
          <Button variant="secondary" size="sm" onClick={() => setConfirm(true)} data-testid="local-storage-delete">
            <Trash2 aria-hidden />
            {t('local.list.delete')}
          </Button>
        )}
      </div>
      {confirm && (
        <div className={cn('flex min-w-0 flex-wrap items-center gap-2 rounded-[10px] bg-sunk px-3 py-2 text-[13px] leading-5')} data-testid="local-storage-confirm">
          <span className="min-w-0 flex-1">
            {t('local.list.deleteConfirm', { id: s.id })}
            {s.usedBy.length > 0 && ` ${t('local.list.deleteUsed', { list: s.usedBy.join(', ') })}`}
          </span>
          <Button size="sm" disabled={remove.isPending} onClick={() => remove.mutate(s.id, { onSuccess: onDeleted, onSettled: () => setConfirm(false) })} data-testid="local-storage-delete-yes">
            {remove.isPending && <Loader2 className="animate-spin" aria-hidden />}
            {t('local.list.deleteYes')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>
            {t('local.list.cancel')}
          </Button>
        </div>
      )}
    </li>
  );
}
