// Среда на форме: карточка, условия селектора строками, нейтральный предпросмотр. Запрос к хранилищу только по кнопке.
import { BUILTIN_FORMAT, PROJECT_LIMITS, type EnvironmentSetting, type ProbeResponse, type StoreInfo } from '@threadline/core';
import { ArrowDown, ArrowUp, ChevronRight, Loader2, Plus, RotateCw, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { connectionText } from '@/components/shell/status.ts';
import { Button } from '@/components/ui/button.tsx';
import { Card } from '@/components/ui/card.tsx';
import { Chip, StatusChip } from '@/components/ui/chip.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Field, Notice, SelectField } from '@/features/catalog/ui.tsx';
import { isAccessDenied } from '@/lib/api.ts';
import { cn } from '@/lib/utils.ts';
import { fieldTexts, ProjectApiError } from './api.ts';
import { ExamplesField } from './ExamplesField.tsx';
import { emptyMatcher, previewEnv, type EnvForm, type MatcherForm } from './model.ts';
import { ProbeControl } from './parts.tsx';
import { useProbe, type ProbeRequest } from './queries.ts';

const SPACE = ' ';

interface EnvProps {
  env: EnvForm;
  index: number;
  total: number;
  project: string | undefined;
  /** Сохранённая среда не работает: хранилище убрали из файла или условия вышли за границу. */
  problem: Pick<EnvironmentSetting, 'missingStore' | 'outOfScope'> | undefined;
  stores: StoreInfo[];
  format: string;
  errors: Record<string, string>;
  readOnly: boolean;
  onChange: (next: EnvForm) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
}

/** Запрос проверки подключения: то, что сейчас введено в форме. */
const probeRequest = (env: EnvForm, project: string | undefined): ProbeRequest => ({
  store: env.backend,
  ...(project ? { project } : {}),
  environment: {
    ...(env.saved ? { id: env.id } : {}),
    kind: env.kind,
    selector: env.selector.map((m) => ({ label: m.label, op: m.op, value: m.value, ...(m.searchOnly && m.op === '!=' ? { searchOnly: true } : {}) })),
    ...(env.kind === 'pr-stands' ? { stand: { label: env.standLabel, template: env.standTemplate } } : {}),
  },
});

/** Кнопки порядка и удаления среды. */
function EnvActions({ env, index, total, onMove, onRemove }: Pick<EnvProps, 'env' | 'index' | 'total' | 'onMove' | 'onRemove'>) {
  const { t } = useTranslation();
  return (
    <div className="flex shrink-0 items-center gap-1">
      <Button type="button" variant="ghost" size="icon" className="size-8" disabled={index === 0} aria-label={t('projects.env.up', { name: env.name })} onClick={() => onMove(-1)}>
        <ArrowUp aria-hidden />
      </Button>
      <Button type="button" variant="ghost" size="icon" className="size-8" disabled={index === total - 1} aria-label={t('projects.env.down', { name: env.name })} onClick={() => onMove(1)}>
        <ArrowDown aria-hidden />
      </Button>
      <Button type="button" variant="ghost" size="sm" disabled={total === 1} title={total === 1 ? t('projects.env.lastHint') : undefined} onClick={onRemove} data-testid="env-remove">
        <Trash2 aria-hidden />
        {t('projects.env.remove')}
      </Button>
    </div>
  );
}

/** Среда целиком на странице нового проекта: все поля сразу. */
export function EnvironmentCard(props: EnvProps) {
  const { env, project, readOnly } = props;
  const { t } = useTranslation();
  return (
    <Card className="flex min-w-0 flex-col gap-3 p-4" data-testid="env-card" data-env={env.id}>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <h3 className="min-w-0 truncate text-[14px] leading-5 font-semibold text-heading" title={env.name}>
          {env.name || t('projects.env.untitled')}
        </h3>
        {!readOnly && <EnvActions {...props} />}
      </div>
      <EnvironmentFields {...props} />
      <ProbeControl request={() => probeRequest(env, project)} />
    </Card>
  );
}

/** Что показать о проверке подключения: статус в капсуле, текст строкой ниже. */
function useProbeView(data: ProbeResponse | null, error: unknown): { status: string; tone: 'success' | 'warning' | 'danger'; title: string; text: string } | null {
  const { t } = useTranslation();
  if (error) {
    const fields = error instanceof ProjectApiError ? Object.values(fieldTexts(error)) : [];
    return { status: 'invalid', tone: 'danger', title: t('projects.probe.action'), text: isAccessDenied(error) ? t('projects.problem.forbidden') : (fields[0] ?? t('projects.probe.failed')) };
  }
  if (!data) return null;
  const name = data.missingEnv ?? '';
  const ok = data.status === 'connected' || data.status === 'demo';
  const text =
    data.status === 'connected'
      ? [data.hasRecords === true ? t('projects.probe.records') : data.hasRecords === false ? t('projects.probe.noRecords') : null, data.stands ? t('projects.probe.stands', { list: data.stands.join(', ') || '—' }) : null].filter(Boolean).join(' ')
      : connectionText(t, { ...data, missingEnv: name });
  const retry = data.retryAfterSeconds !== undefined ? ` ${t('connection.retryIn', { seconds: data.retryAfterSeconds })}` : '';
  return { status: data.status, tone: ok ? 'success' : 'warning', title: t(`connection.status.${data.status}.title`), text: `${text}${retry}` };
}

/**
 * Среда в настройках проекта: строка со значениями, по нажатию раскрывается формой.
 * Результата проверки до нажатия нет. Результат встаёт на место строки значений: карточка не меняет высоту, соседние не едут.
 */
export function EnvironmentRow({ open, onToggle, ...props }: EnvProps & { open: boolean; onToggle: () => void }) {
  const { env, project, stores, readOnly } = props;
  const { t } = useTranslation();
  const probe = useProbe();
  const view = useProbeView(probe.data, probe.error);
  const store = stores.find((s) => s.id === env.backend);
  const storeName = !env.backend ? '—' : store?.type === 'mock' ? `${env.backend} · ${t('projects.stores.mock')}` : env.backend;
  const conditions = previewEnv(env).join(', ') || '—';
  return (
    <Card className="flex min-w-0 flex-col gap-2.5 px-5 py-4" data-testid="env-card" data-env={env.id}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
        <button type="button" aria-expanded={open} onClick={onToggle} className="flex min-w-0 flex-1 basis-64 items-center gap-2.5 text-left" data-testid="env-toggle">
          <ChevronRight className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} aria-hidden />
          <span className={cn('size-2 shrink-0 rounded-full', view === null ? 'bg-muted-foreground/40' : view.tone === 'success' ? 'bg-success' : view.tone === 'danger' ? 'bg-danger' : 'bg-warning')} aria-hidden />
          <span className="min-w-0 truncate text-section font-semibold text-heading" title={env.name}>
            {env.name || t('projects.env.untitled')}
          </span>
          {env.id && <span className="min-w-0 truncate font-mono text-[12.5px] text-muted-foreground">{env.id}</span>}
          <Chip className="shrink-0">{t(env.kind === 'pr-stands' ? 'projects.env.kindStands' : 'projects.env.kindSingle')}</Chip>
        </button>
        {view && (
          <StatusChip tone={view.tone} className="max-w-full min-w-0" title={view.title}>
            <span className="truncate">{view.title}</span>
          </StatusChip>
        )}
        <Button type="button" variant="secondary" disabled={probe.pending} onClick={() => void probe.run(probeRequest(env, project))} data-testid="probe-button">
          {probe.pending ? <Loader2 className="animate-spin" aria-hidden /> : <RotateCw aria-hidden />}
          {t('projects.zone.probe')}
        </Button>
      </div>
      <div aria-live="polite" className="min-w-0 pl-[26px] text-[12.5px] leading-[18px] text-foreground-2">
        {view ? (
          <p className={cn(open ? 'break-words' : 'truncate', view.tone === 'danger' && 'text-danger')} title={view.text} data-testid="probe-result" data-status={view.status}>
            <span className="sr-only">{view.title}: </span>
            {view.text}
          </p>
        ) : (
          <p className="truncate" title={conditions}>
            {t('projects.zone.storage')}: <b className="font-semibold">{storeName}</b> · {t('projects.zone.selector')}: <span className="font-mono text-[12px]">{conditions}</span>
          </p>
        )}
      </div>
      {open && (
        <div className="flex min-w-0 flex-col gap-3 border-t border-border pt-3">
          {!readOnly && (
            <div className="flex justify-end">
              <EnvActions {...props} />
            </div>
          )}
          <EnvironmentFields {...props} />
          {probe.data?.labelNames && probe.data.labelNames.length > 0 && (
            <details className="text-[12.5px]">
              <summary className="cursor-pointer text-muted-foreground hover:text-foreground">{t('projects.probe.labels')}</summary>
              <p className="break-words font-mono text-[12px] leading-[18px]">{probe.data.labelNames.join(', ')}</p>
            </details>
          )}
          {probe.data?.details && (
            <details className="text-[12.5px]">
              <summary className="cursor-pointer text-muted-foreground hover:text-foreground">{t('connection.details')}</summary>
              <p className="break-words font-mono text-[12px] leading-[18px]">{probe.data.details}</p>
            </details>
          )}
        </div>
      )}
    </Card>
  );
}

/** Поля среды: идентификатор, название, вид, хранилище, стенды, условия, предпросмотр и примеры поиска. */
function EnvironmentFields({ env, index, problem, stores, format, errors, readOnly, onChange }: EnvProps) {
  const { t } = useTranslation();
  const at = `environments.${index}`;
  const store = stores.find((s) => s.id === env.backend);
  const preview = previewEnv(env);
  const patch = (p: Partial<EnvForm>) => onChange({ ...env, ...p });
  const setMatcher = (key: string, p: Partial<MatcherForm>) => patch({ selector: env.selector.map((m) => (m.key === key ? { ...m, ...p } : m)) });
  const full = env.selector.length >= PROJECT_LIMITS.conditions;
  const storeOptions = stores.map((s) => ({ value: s.id, label: s.type === 'mock' ? `${s.id} · ${t('projects.stores.mock')}` : s.id }));
  // Сохранённая среда на хранилище, которого уже нет в файле: значение остаётся видимым, чтобы его можно было сменить.
  if (env.backend && !store) storeOptions.push({ value: env.backend, label: `${env.backend} · ${t('projects.env.storeMissing')}` });

  return (
    <>
      {problem?.outOfScope && <Notice tone="warning">{t('projects.env.outOfScope', { id: problem.outOfScope })}</Notice>}

      <div className="grid min-w-0 gap-3 md:grid-cols-2">
        <Field label={t('projects.env.id')} error={errors[`${at}.id`]} hint={env.saved ? t('projects.env.idSaved') : t('projects.env.idHint')}>
          {(c) => <Input {...c} value={env.id} readOnly={env.saved} tabIndex={env.saved ? -1 : undefined} disabled={readOnly} onChange={(e) => patch({ id: e.target.value })} className="font-mono" data-testid="env-id" />}
        </Field>
        <Field label={t('projects.env.name')} error={errors[`${at}.name`]} hint={SPACE}>
          {(c) => <Input {...c} value={env.name} disabled={readOnly} onChange={(e) => patch({ name: e.target.value })} data-testid="env-name" />}
        </Field>
        <Field label={t('projects.env.kind')} error={errors[`${at}.kind`]} hint={env.saved && env.savedKind !== env.kind ? t('projects.env.kindChanged') : SPACE}>
          {(c) => (
            <SelectField
              control={{ ...c, disabled: readOnly }}
              value={env.kind}
              onChange={(kind) => patch({ kind })}
              options={[
                { value: 'single', label: t('projects.env.kindSingle') },
                { value: 'pr-stands', label: t('projects.env.kindStands') },
              ]}
            />
          )}
        </Field>
        <Field
          label={t('projects.env.backend')}
          error={errors[`${at}.backend`]}
          hint={<StoreHint store={store} format={format} missing={!store && !!env.backend} />}
        >
          {(c) => <SelectField control={{ ...c, disabled: readOnly }} value={env.backend} onChange={(backend) => patch({ backend })} options={storeOptions} />}
        </Field>
      </div>

      {env.kind === 'pr-stands' && (
        <div className="grid min-w-0 gap-3 md:grid-cols-2">
          <Field label={t('projects.env.standLabel')} error={errors[`${at}.stand.label`] ?? errors[`${at}.stand`]} hint={SPACE}>
            {(c) => <Input {...c} value={env.standLabel} disabled={readOnly} onChange={(e) => patch({ standLabel: e.target.value })} className="font-mono" data-testid="stand-label" />}
          </Field>
          <Field label={t('projects.env.standTemplate')} error={errors[`${at}.stand.template`]} hint={t('projects.env.standHint')}>
            {(c) => <Input {...c} value={env.standTemplate} disabled={readOnly} onChange={(e) => patch({ standTemplate: e.target.value })} className="font-mono" data-testid="stand-template" />}
          </Field>
        </div>
      )}

      <div className="flex min-w-0 flex-col gap-2">
        <span className="text-[13px] leading-5 font-medium text-foreground">{t('projects.env.selector')}</span>
        {env.selector.map((m, j) => (
          <MatcherRow key={m.key} matcher={m} at={`${at}.selector.${j}`} errors={errors} readOnly={readOnly} onChange={(p) => setMatcher(m.key, p)} onRemove={() => patch({ selector: env.selector.filter((x) => x.key !== m.key) })} />
        ))}
        <p className="min-h-4 text-[12px] leading-4 text-danger" data-testid={errors[`${at}.selector`] ? 'field-error' : undefined}>
          {errors[`${at}.selector`] ?? SPACE}
        </p>
        {!readOnly && (
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="secondary" size="sm" disabled={full} onClick={() => patch({ selector: [...env.selector, emptyMatcher()] })} data-testid="add-condition">
              <Plus aria-hidden />
              {t('projects.env.addCondition')}
            </Button>
            {full && <span className="text-[12px] text-muted-foreground">{t('projects.env.conditionsLimit', { max: PROJECT_LIMITS.conditions })}</span>}
          </div>
        )}
      </div>

      <div className="min-w-0 rounded-[var(--radius-control)] bg-muted/60 px-3 py-2 text-[12px] leading-[18px]" data-testid="env-preview">
        <span className="text-muted-foreground">{t('projects.env.preview')}: </span>
        <span className="break-all font-mono text-foreground">{preview.length > 0 ? preview.join(', ') : '—'}</span>
      </div>

      <ExamplesField examples={env.examples} at={at} errors={errors} readOnly={readOnly} onChange={(examples) => patch({ examples })} />
    </>
  );
}

function StoreHint({ store, format, missing }: { store: StoreInfo | undefined; format: string; missing: boolean }) {
  const { t } = useTranslation();
  if (missing) return <>{t('projects.env.storeMissingHint')}</>;
  if (!store) return <>{SPACE}</>;
  if (store.type === 'mock') {
    return (
      <span className="flex flex-wrap items-center gap-1.5">
        <Chip tone="accent">{t('projects.stores.mock')}</Chip>
        {format !== BUILTIN_FORMAT && <span>{t('projects.env.mockFormat')}</span>}
      </span>
    );
  }
  // У Loki без входа переменных нет: tokenSet не задан, и сказать о нехватке нечего.
  const token = store.tokenSet === false ? t('projects.env.tokenMissing', { name: store.tokenEnv ?? '' }) : null;
  const scope = !store.scope
    ? t('projects.env.noScope', { id: store.id })
    : store.scope.values.includes('*')
      ? t('projects.stores.scopeOpen', { label: store.scope.label })
      : t('projects.stores.scope', { label: store.scope.label, values: store.scope.values.join(', ') });
  return (
    <span data-testid="store-hint">
      {scope}
      {token && <> {token}</>}
    </span>
  );
}

function MatcherRow({ matcher: m, at, errors, readOnly, onChange, onRemove }: { matcher: MatcherForm; at: string; errors: Record<string, string>; readOnly: boolean; onChange: (p: Partial<MatcherForm>) => void; onRemove: () => void }) {
  const { t } = useTranslation();
  const rowError = errors[`${at}.label`] ?? errors[`${at}.op`] ?? errors[`${at}.value`] ?? errors[at];
  return (
    <div className="flex min-w-0 flex-col gap-1" data-testid="matcher-row">
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_5rem_minmax(0,2fr)_auto] items-center gap-2">
        <Input aria-label={t('projects.env.label')} aria-invalid={!!errors[`${at}.label`] || undefined} placeholder={t('projects.env.label')} value={m.label} disabled={readOnly} onChange={(e) => onChange({ label: e.target.value })} className="font-mono" data-testid="matcher-label" />
        <SelectField
          ariaLabel={t('projects.env.op')}
          control={{ id: `${at}.op`, disabled: readOnly }}
          value={m.op}
          onChange={(op) => onChange({ op, ...(op !== '!=' ? { searchOnly: false } : {}) })}
          options={[
            { value: '=', label: '=' },
            { value: '!=', label: '!=' },
            { value: '=~', label: '=~' },
            { value: '!~', label: '!~' },
          ]}
        />
        <Input aria-label={t('projects.env.value')} aria-invalid={!!errors[`${at}.value`] || undefined} placeholder={t('projects.env.value')} value={m.value} disabled={readOnly} onChange={(e) => onChange({ value: e.target.value })} className="font-mono" data-testid="matcher-value" />
        {!readOnly && (
          <Button type="button" variant="ghost" size="icon" className="size-8" aria-label={t('projects.env.removeCondition')} onClick={onRemove}>
            <Trash2 aria-hidden />
          </Button>
        )}
      </div>
      {m.op === '=~' && <p className="text-[12px] leading-4 text-muted-foreground">{t('projects.env.regexHint')}</p>}
      {m.op === '!~' && <p className="text-[12px] leading-4 text-muted-foreground">{t('projects.env.regexNotHint')}</p>}
      {m.op === '!=' && (
        <label className="flex items-center gap-2 text-[12px] leading-4 text-muted-foreground">
          <input type="checkbox" checked={m.searchOnly} disabled={readOnly} onChange={(e) => onChange({ searchOnly: e.target.checked })} />
          {t('projects.env.searchOnly')}
        </label>
      )}
      {rowError && (
        <p className="break-words text-[12px] leading-4 text-danger" data-testid="field-error">
          {rowError}
        </p>
      )}
    </div>
  );
}
