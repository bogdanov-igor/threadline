// Страницы настроек проекта в зоне «Проект»: «Основное», «Среды», «Вид».
// Смена пункта с правками спрашивает подтверждение: на каждом пункте своя форма, отказ оставляет правки на месте.
import type { ProjectSetting, ProjectSettingsResponse } from '@threadline/core';
import { BUILTIN_FORMAT, PROJECT_LIMITS } from '@threadline/core';
import { Eye, EyeOff, FileDown, FolderCheck, Loader2, MapPinOff, Plus, RotateCcw, ServerCrash, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';
import { PageSkeleton } from '@/components/states/PageSkeleton.tsx';
import { StateMessage } from '@/components/states/StateMessage.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { useAccess } from '@/features/auth/access.tsx';
import { FieldRow, Notice, SelectField, SETTINGS_GRID, UnsavedMark, ZONE_PAGE, ZoneFooter, ZoneHead } from '@/features/catalog/ui.tsx';
import { ProjectFileSlot } from '@/features/project-file/slot.tsx';
import { DeleteSheet } from './DeleteSheet.tsx';
import { EnvironmentRow } from './EnvironmentCard.tsx';
import { LogoField } from './LogoField.tsx';
import { emptyEnv, moveEnv } from './model.ts';
import { FileMark, NewStoreHint, SourceNotice } from './parts.tsx';
import { TimezoneInput } from './ProjectFormPage.tsx';
import { useProjectSettings } from './queries.ts';
import { ProblemNotice, UnplacedErrors, useLeaveGuard, useProjectForm } from './use-project-form.tsx';
import { ViewSection } from './ViewSection.tsx';

/** Пути, у которых на этой странице есть своё поле. Остальное показывается общим списком: ничего не теряется молча. */
const PLACED_MAIN = /^(?:id|name|timezone|retentionDays|format|logo(?:\.light|\.dark)?)$/;
const PLACED_ENVS = /^(?:environments|environments\.\d+\.(?:id|name|kind|backend|selector|stand|stand\.label|stand\.template|selector\.\d+(?:\.label|\.op|\.value)?))$/;

export function ProjectSettingsRoute({ id, section }: { id: string; section: string | undefined }) {
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
  return <EditRoute data={settings.data} id={id} section={section} onRetry={() => void settings.refetch()} />;
}

/** Открытая форма не исчезает, когда проект удалили другие: введённое на месте, о судьбе проекта говорит сохранение. */
function EditRoute({ data, id, section, onRetry }: { data: ProjectSettingsResponse; id: string; section: string | undefined; onRetry: () => void }) {
  const { t } = useTranslation();
  const project = data.projects.find((p) => p.id === id);
  const [opened] = useState(project);
  const shown = project ?? opened;
  if (!shown) {
    return (
      <StateMessage icon={MapPinOff} tone="warning" title={t('projects.form.notFound.title')} text={t('projects.form.notFound.text', { id })}>
        <Button asChild>
          <Link to="/admin/projects">{t('projects.form.toList')}</Link>
        </Button>
      </StateMessage>
    );
  }
  if (section === 'view') return <ViewPage key="view" data={data} project={shown} />;
  if (section === 'file') return <ProjectFileSlot key="file" data={data} project={shown} notices={<SourceNotice settings={data} />} onRetry={onRetry} />;
  // Свой ключ у каждого пункта: подтверждённый уход сбрасывает правки, а новый пункт читает свежую запись.
  return section === 'environments' ? <EnvironmentsPage key="environments" data={data} initial={shown} /> : <MainPage key="main" data={data} initial={shown} />;
}

/** Почему правка закрыта и что с видимостью проекта: одинаково на всех пунктах. */
function Notices({ data, project }: { data: ProjectSettingsResponse; project: ProjectSetting | null }) {
  const { t } = useTranslation();
  return (
    <>
      <SourceNotice settings={data} />
      {project?.hidden && <Notice tone="warning">{t(`projects.hiddenNotice.${project.hidden}`)}</Notice>}
    </>
  );
}

/** Подвал формы: отметка о правках, «Отменить», «Сохранить». Занят всегда, раскладка не прыгает. */
function FormFooter({ f, saveLabel }: { f: ReturnType<typeof useProjectForm>; saveLabel: string }) {
  const { t } = useTranslation();
  if (f.readOnly) return null;
  return (
    <ZoneFooter>
      {f.problem?.kind === 'invalid' ? <span className="min-w-0 text-[13px] text-danger">{t('projects.form.hasErrors')}</span> : f.dirty && <UnsavedMark text={t('projects.zone.unsaved')} />}
      <span className="flex-1" />
      {/* Главная кнопка первая в разметке: с поля Tab идёт на неё, на экране она справа. */}
      <Button type="submit" disabled={!f.canSave} className="order-last" data-testid="project-save">
        {f.pending && <Loader2 className="animate-spin" aria-hidden />}
        {saveLabel}
      </Button>
      <Button type="button" variant="secondary" disabled={!f.dirty || f.pending || f.recreate} onClick={f.discard} data-testid="project-cancel">
        {t('projects.zone.cancel')}
      </Button>
    </ZoneFooter>
  );
}

function FormProblem({ f }: { f: ReturnType<typeof useProjectForm> }) {
  const { can } = useAccess();
  const { problem, form } = f;
  if (!problem || problem.kind === 'invalid') return null;
  return (
    <ProblemNotice
      problem={problem}
      id={form.id}
      canRecreate={can('createProjects')}
      onReload={(fresh) => {
        f.setBase(fresh);
        f.setProblem(null);
      }}
      onRecreate={() => {
        f.setRecreate(true);
        f.setProblem(null);
      }}
    />
  );
}

function MainPage({ data, initial }: { data: ProjectSettingsResponse; initial: ProjectSetting }) {
  const { t } = useTranslation();
  const { can } = useAccess();
  const navigate = useNavigate();
  const f = useProjectForm(data, initial);
  const { form, errors, base, readOnly, patch, act } = f;
  const [deleting, setDeleting] = useState(false);
  return (
    <div className={ZONE_PAGE} data-testid="project-form">
      <ZoneHead
        title={t('projects.form.main')}
        titleExtra={base && <FileMark state={base.fileState} />}
        subtitle={t('projects.zone.mainHint')}
        actions={
          base &&
          !readOnly &&
          !f.recreate && (
            <>
              {base.fileState === 'file-newer' && (
                <Button type="button" variant="ghost" disabled={f.actionPending} onClick={() => act({ id: base.id, kind: 'file', action: 'keep', updatedAt: base.updatedAt! })}>
                  <FolderCheck aria-hidden />
                  {t('projects.fileAction.keep')}
                </Button>
              )}
              {(base.fileState === 'file-newer' || base.fileState === 'here') && (
                <Button type="button" variant="ghost" disabled={f.actionPending} onClick={() => act({ id: base.id, kind: 'file', action: 'take', updatedAt: base.updatedAt! }, { takeForm: true })}>
                  <FileDown aria-hidden />
                  {t('projects.fileAction.take')}
                </Button>
              )}
              {base.hidden === null ? (
                <Button type="button" variant="secondary" disabled={f.actionPending || f.others === 0} title={f.others === 0 ? t('projects.action.hideLast') : undefined} onClick={() => act({ id: base.id, kind: 'visibility', hidden: true, updatedAt: base.updatedAt! })} data-testid="form-hide">
                  <EyeOff aria-hidden />
                  {t('projects.zone.hideProject')}
                </Button>
              ) : (
                <>
                  <Button type="button" variant="secondary" disabled={f.actionPending} onClick={() => act({ id: base.id, kind: 'visibility', hidden: false, updatedAt: base.updatedAt! })} data-testid="form-show">
                    <Eye aria-hidden />
                    {t('projects.action.show')}
                  </Button>
                  {can('deleteForever') && (
                    <Button type="button" variant="secondary" className="border-danger/40 text-danger hover:bg-danger-bg" onClick={() => setDeleting(true)} data-testid="form-delete">
                      <Trash2 aria-hidden />
                      {t('projects.action.delete')}
                    </Button>
                  )}
                </>
              )}
            </>
          )
        }
      />
      <Notices data={data} project={base} />
      {/* Правила называет сервер у своих полей: пузырь браузера остановил бы отправку на числе вне диапазона. */}
      <form
        noValidate
        className="flex min-w-0 flex-1 flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (f.canSave) void f.submit();
        }}
      >
        <div className={SETTINGS_GRID}>
          <FieldRow label={t('projects.form.name')} hint={t('projects.zone.nameHint')} error={errors.name}>
            {(c) => <Input {...c} value={form.name} disabled={readOnly} autoComplete="off" onChange={(e) => patch({ name: e.target.value })} data-testid="project-name" />}
          </FieldRow>
          <FieldRow label={t('projects.form.id')} hint={t('projects.form.idSaved')} error={errors.id}>
            {(c) => <Input {...c} value={form.id} readOnly={!f.creating} tabIndex={f.creating ? undefined : -1} disabled={readOnly} autoComplete="off" onChange={(e) => patch({ id: e.target.value })} className="border-transparent bg-transparent px-0 font-mono read-only:focus:border-transparent" data-testid="project-id" />}
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
                  options={[{ value: BUILTIN_FORMAT, label: BUILTIN_FORMAT }, ...data.formats.map((x) => ({ value: x, label: x })), ...(f.missingFormat ? [{ value: form.format, label: t('projects.form.formatMissing', { name: form.format }) }] : [])]}
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
            <LogoField theme="light" side={form.light} savedUrl={base?.logo?.light} error={errors['logo.light'] ?? errors.logo} disabled={readOnly} onChange={(light) => patch({ light, ...(light.kind === 'none' ? { dark: { kind: 'none' as const } } : {}) })} />
            <LogoField theme="dark" side={form.dark} savedUrl={base?.logo?.dark} error={errors['logo.dark']} disabled={readOnly} onChange={(dark) => patch({ dark })} />
          </div>
        </div>
        <UnplacedErrors errors={errors} placed={PLACED_MAIN} />
        <FormProblem f={f} />
        <FormFooter f={f} saveLabel={f.creating ? t('projects.form.create') : t('projects.form.save')} />
      </form>
      {deleting && base && (
        <DeleteSheet
          project={base}
          onClose={() => setDeleting(false)}
          onDeleted={() => {
            f.skipBlock.current = true;
            void navigate('/admin/projects', { replace: true });
          }}
        />
      )}
    </div>
  );
}

function EnvironmentsPage({ data, initial }: { data: ProjectSettingsResponse; initial: ProjectSetting }) {
  const { t } = useTranslation();
  const f = useProjectForm(data, initial);
  const { form, errors, base, readOnly, patch, setEnv } = f;
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string) =>
    setOpened((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const atLimit = form.environments.length >= PROJECT_LIMITS.environments;
  return (
    <div className={ZONE_PAGE} data-testid="project-form">
      <ZoneHead
        title={t('projects.form.environments')}
        subtitle={t('projects.zone.envsHint')}
        actions={
          !readOnly && (
            <>
              {atLimit && <span className="text-[12px] text-muted-foreground">{t('projects.env.envLimit', { max: PROJECT_LIMITS.environments })}</span>}
              <Button
                type="button"
                disabled={atLimit}
                onClick={() => {
                  const env = emptyEnv(data.stores[0]?.id ?? '');
                  patch({ environments: [...form.environments, env] });
                  setOpened((prev) => new Set(prev).add(env.key));
                }}
                data-testid="add-env"
              >
                <Plus aria-hidden />
                {t('projects.env.add')}
              </Button>
            </>
          )
        }
      />
      <Notices data={data} project={base} />
      <form
        noValidate
        className="flex min-w-0 flex-1 flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (f.canSave) void f.submit();
        }}
      >
        {errors.environments && (
          <p className="text-[12px] leading-4 text-danger" data-testid="field-error">
            {errors.environments}
          </p>
        )}
        {form.environments.length === 0 && <Notice tone="warning">{t('projects.env.needOne')}</Notice>}
        {form.environments.map((env, i) => {
          const problem = base?.environments.find((e) => e.id === env.id && env.saved);
          // Закрытая карточка спрятала бы ошибку: среда с ошибкой, новая и неработающая раскрыты.
          const hasError = Object.keys(errors).some((k) => k.startsWith(`environments.${i}.`));
          return (
            <EnvironmentRow
              key={env.key}
              env={env}
              index={i}
              total={form.environments.length}
              project={initial.id}
              problem={problem}
              stores={data.stores}
              format={form.format}
              errors={errors}
              readOnly={readOnly}
              open={opened.has(env.key) || hasError || !!problem?.missingStore || !!problem?.outOfScope}
              onToggle={() => toggle(env.key)}
              onChange={(next) => setEnv(env.key, next)}
              onMove={(delta) => patch({ environments: moveEnv(form.environments, i, delta) })}
              onRemove={() => patch({ environments: form.environments.filter((e) => e.key !== env.key) })}
            />
          );
        })}
        {f.removedSaved.length > 0 && <Notice tone="warning">{t('projects.env.removedWarning', { list: f.removedSaved.map((e) => e.name).join(', ') })}</Notice>}
        <NewStoreHint />
        <UnplacedErrors errors={errors} placed={PLACED_ENVS} />
        <FormProblem f={f} />
        <FormFooter f={f} saveLabel={f.creating ? t('projects.form.create') : t('projects.form.save')} />
      </form>
    </div>
  );
}

function ViewPage({ data, project }: { data: ProjectSettingsResponse; project: ProjectSetting }) {
  const { can } = useAccess();
  const readOnly = !data.editable || !can('editProjects');
  const [dirty, setDirty] = useState(false);
  useLeaveGuard(dirty);
  return (
    <div className={ZONE_PAGE} data-testid="project-form">
      <ViewSection project={project} readOnly={readOnly} onDirty={setDirty} notices={<Notices data={data} project={project} />} />
    </div>
  );
}
