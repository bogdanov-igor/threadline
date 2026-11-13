// Форма нового проекта. Правка живёт в зоне проекта: ProjectSettings.tsx, состояние общее: use-project-form.tsx.
import type { ProjectSettingsResponse } from '@threadline/core';
import { BUILTIN_FORMAT, PROJECT_LIMITS, RESERVED_ENV_IDS, RESERVED_PROJECT_IDS } from '@threadline/core';
import { ArrowLeft, Loader2, Plus, RotateCcw, ServerCrash } from 'lucide-react';
import { Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Page } from '@/components/shell/Page.tsx';
import { PageSkeleton } from '@/components/states/PageSkeleton.tsx';
import { StateMessage } from '@/components/states/StateMessage.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { useAccess } from '@/features/auth/access.tsx';
import { FieldRow, Notice, SelectField } from '@/features/catalog/ui.tsx';
import { EnvironmentCard } from './EnvironmentCard.tsx';
import { LogoField } from './LogoField.tsx';
import { emptyEnv, moveEnv } from './model.ts';
import { NewStoreHint, SourceNotice } from './parts.tsx';
import { useProjectSettings } from './queries.ts';
import { ProblemNotice, UnplacedErrors, useProjectForm } from './use-project-form.tsx';

const ZONES: readonly string[] = (() => {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return [];
  }
})();

/** Пути, для которых на форме есть своё место. Остальное показывается общим списком: ничего не теряется молча. */
const PLACED = /^(?:id|name|timezone|retentionDays|format|logo(?:\.light|\.dark)?|environments\.\d+\.(?:id|name|kind|backend|selector|stand|stand\.label|stand\.template|selector\.\d+(?:\.label|\.op|\.value)?))$/;

export function ProjectFormRoute() {
  const { t } = useTranslation();
  const settings = useProjectSettings();
  if (settings.isPending) return <PageSkeleton />;
  if (settings.isError || !settings.data) {
    return (
      <StateMessage icon={ServerCrash} tone="danger" title={t('projects.loadFailed.title')} text={t('projects.loadFailed.text')}>
        <Button onClick={() => void settings.refetch()} disabled={settings.isFetching}>
          <RotateCcw className={settings.isFetching ? 'animate-spin' : undefined} aria-hidden />
          {t('states.retry')}
        </Button>
      </StateMessage>
    );
  }
  const data = settings.data;
  if (!data.editable) {
    return (
      <Page className="flex flex-col gap-4">
        <SourceNotice settings={data} />
        <Button variant="secondary" className="self-start" asChild>
          <Link to="/admin/projects">
            <ArrowLeft aria-hidden />
            {t('projects.form.toList')}
          </Link>
        </Button>
      </Page>
    );
  }
  return <ProjectFormBody data={data} />;
}

/** Одна сетка на всю форму: подпись слева, поле или карточка среды справа. Уже 768 в одну колонку. */
const FORM_GRID = 'grid min-w-0 grid-cols-1 gap-x-8 gap-y-5 md:grid-cols-[200px_minmax(0,640px)]';
const SECTION_TITLE = 'mb-3 text-section font-semibold text-heading';

/** Новый проект одной формой, без мастера. Поля и карточка среды общие с настройками проекта. */
function ProjectFormBody({ data }: { data: ProjectSettingsResponse }) {
  const { t } = useTranslation();
  const { can } = useAccess();
  const f = useProjectForm(data, null);
  const { form, errors, problem, readOnly, canSave, patch, setEnv, submit, missingFormat } = f;
  const atLimit = form.environments.length >= PROJECT_LIMITS.environments;

  return (
    <Page className="flex min-h-[calc(100dvh-56px)] w-full flex-col gap-4 pb-0" data-testid="project-form">
      <div className="flex min-w-0 flex-col gap-3">
        <Link to="/admin/projects" className="inline-flex items-center gap-1.5 self-start text-[12.5px] leading-[18px] text-foreground-2 hover:text-foreground">
          <ArrowLeft className="size-3.5" aria-hidden />
          {t('projects.list.title')}
        </Link>
        <h1 className="text-title font-semibold tracking-[-0.015em] text-heading">{t('projects.form.createTitle')}</h1>
      </div>

      <SourceNotice settings={data} />

      {/* Правила называет сервер у своих полей: пузырь браузера остановил бы отправку на числе вне диапазона. */}
      <form
        noValidate
        className="flex min-w-0 flex-1 flex-col gap-6"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSave) void submit();
        }}
      >
        <section aria-labelledby="new-project-main">
          <h2 id="new-project-main" className={SECTION_TITLE}>
            {t('projects.form.main')}
          </h2>
          <div className={FORM_GRID}>
            <FieldRow label={t('projects.form.name')} hint={t('projects.zone.nameHint')} error={errors.name}>
              {(c) => <Input {...c} value={form.name} disabled={readOnly} autoComplete="off" onChange={(e) => patch({ name: e.target.value })} data-testid="project-name" />}
            </FieldRow>
            <FieldRow label={t('projects.form.id')} hint={`${t('projects.form.idHint')} ${t('projects.form.idReserved', { list: [...RESERVED_PROJECT_IDS].join(', ') })}`} error={errors.id}>
              {(c) => <Input {...c} value={form.id} disabled={readOnly} autoComplete="off" onChange={(e) => patch({ id: e.target.value })} className="font-mono" data-testid="project-id" />}
            </FieldRow>
            <FieldRow label={t('projects.form.timezone')} error={errors.timezone}>
              {(c) => <TimezoneInput control={c} value={form.timezone} disabled={readOnly} onChange={(timezone) => patch({ timezone })} />}
            </FieldRow>
            <FieldRow label={t('projects.form.retention')} hint={t('projects.form.retentionHint')} error={errors.retentionDays}>
              {(c) => <Input {...c} inputMode="numeric" autoComplete="off" maxLength={3} value={form.retentionDays} disabled={readOnly} onChange={(e) => patch({ retentionDays: e.target.value.replace(/\D/g, '') })} className="w-40" data-testid="project-retention" />}
            </FieldRow>
            <FieldRow label={t('projects.form.formatLabel')} hint={t('projects.zone.formatHint')} error={errors.format}>
              {(c) => (
                <>
                  <SelectField
                    control={{ ...c, disabled: readOnly }}
                    value={form.format}
                    onChange={(format) => patch({ format })}
                    options={[{ value: BUILTIN_FORMAT, label: BUILTIN_FORMAT }, ...data.formats.map((x) => ({ value: x, label: x })), ...(missingFormat ? [{ value: form.format, label: t('projects.form.formatMissing', { name: form.format }) }] : [])]}
                  />
                  <p className="text-[12px] leading-4 text-muted-foreground">{t('projects.form.formatHint')}</p>
                </>
              )}
            </FieldRow>
            <div className="min-w-0 md:pt-1.5">
              <span className="block text-[13.5px] leading-5 font-semibold text-foreground">{t('projects.form.logo')}</span>
              <span className="mt-0.5 block text-[12px] leading-[18px] text-muted-foreground">{t('projects.logo.hint')}</span>
            </div>
            <div className="grid min-w-0 gap-3 sm:grid-cols-2">
              <LogoField theme="light" side={form.light} savedUrl={undefined} error={errors['logo.light'] ?? errors.logo} disabled={readOnly} onChange={(light) => patch({ light, ...(light.kind === 'none' ? { dark: { kind: 'none' as const } } : {}) })} />
              <LogoField theme="dark" side={form.dark} savedUrl={undefined} error={errors['logo.dark']} disabled={readOnly} onChange={(dark) => patch({ dark })} />
            </div>
          </div>
        </section>

        <section aria-labelledby="new-project-envs">
          <h2 id="new-project-envs" className={SECTION_TITLE}>
            {t('projects.form.environments')}
          </h2>
          <div className={FORM_GRID}>
            <span className="max-md:hidden" />
            <div className="flex min-w-0 flex-col gap-2">
              <NewStoreHint />
              {errors.environments && (
                <p className="text-[12px] leading-4 text-danger" data-testid="field-error">
                  {errors.environments}
                </p>
              )}
              {form.environments.length === 0 && <Notice tone="warning">{t('projects.env.needOne')}</Notice>}
            </div>
            {form.environments.map((env, i) => (
              <Fragment key={env.key}>
                <div className="min-w-0 text-[13.5px] leading-5 font-semibold text-foreground md:pt-4">{t('projects.form.envNumber', { n: i + 1 })}</div>
                <EnvironmentCard
                  env={env}
                  index={i}
                  total={form.environments.length}
                  project={undefined}
                  problem={undefined}
                  stores={data.stores}
                  format={form.format}
                  errors={errors}
                  readOnly={readOnly}
                  onChange={(next) => setEnv(env.key, next)}
                  onMove={(delta) => patch({ environments: moveEnv(form.environments, i, delta) })}
                  onRemove={() => patch({ environments: form.environments.filter((e) => e.key !== env.key) })}
                />
              </Fragment>
            ))}
            <span className="max-md:hidden" />
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="secondary" disabled={atLimit} onClick={() => patch({ environments: [...form.environments, emptyEnv(data.stores[0]?.id ?? '')] })} data-testid="add-env">
                <Plus aria-hidden />
                {t('projects.env.add')}
              </Button>
              {atLimit && <span className="text-[12px] text-muted-foreground">{t('projects.env.envLimit', { max: PROJECT_LIMITS.environments })}</span>}
            </div>
          </div>
        </section>

        <UnplacedErrors errors={errors} placed={PLACED} />

        {problem && problem.kind !== 'invalid' && <ProblemNotice problem={problem} id={form.id} canRecreate={can('createProjects')} onReload={(fresh) => { f.setBase(fresh); f.setProblem(null); }} onRecreate={() => { f.setRecreate(true); f.setProblem(null); }} />}

        <div className="sticky bottom-0 z-10 -mx-[var(--page-gutter)] mt-auto flex min-h-[57px] flex-wrap items-center gap-x-3 gap-y-2 border-t border-border bg-background px-[var(--page-gutter)] py-3">
          {problem?.kind === 'invalid' ? <span className="min-w-0 text-[13px] text-danger">{t('projects.form.hasErrors')}</span> : <span className="min-w-0 text-[12.5px] leading-[18px] text-muted-foreground">{t('projects.form.envIdsTaken', { list: [...RESERVED_ENV_IDS].join(', ') })}</span>}
          <span className="flex-1" />
          {/* Главная кнопка первая в разметке: с поля Tab идёт на неё, на экране она справа. */}
          <Button type="submit" disabled={!canSave} className="order-last" data-testid="project-save">
            {f.pending && <Loader2 className="animate-spin" aria-hidden />}
            {t('projects.form.createProject')}
          </Button>
          <Button variant="secondary" asChild>
            <Link to="/admin/projects" data-testid="project-cancel">
              {t('projects.zone.cancel')}
            </Link>
          </Button>
        </div>
      </form>
    </Page>
  );
}

/** Часовой пояс: поле с подсказками из базы браузера. Проверяет сервер. */
export function TimezoneInput({ control, value, disabled, onChange }: { control: object; value: string; disabled: boolean; onChange: (v: string) => void }) {
  return (
    <>
      <Input {...control} list="project-zones" value={value} disabled={disabled} autoComplete="off" onChange={(e) => onChange(e.target.value)} data-testid="project-timezone" />
      <datalist id="project-zones">
        {ZONES.map((z) => (
          <option key={z} value={z} />
        ))}
      </datalist>
    </>
  );
}
