import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { SystemRow } from '@threadline/core/catalog';
import { useTranslation } from 'react-i18next';
import { focusFirstInvalid } from '@/lib/focus.ts';
import { systemLabel } from '@/lib/systems.ts';
import { cn } from '@/lib/utils.ts';
import { FormFooter, ProblemNotice, useRowSave, type FormProps } from '../form-parts.tsx';
import { externalSystems } from '../model.ts';
import { Field, SelectField, useErrorText } from '../ui.tsx';
import { systemDraft, systemModel, type Errors } from '../validate.ts';
import { SystemForm } from './SystemForm.tsx';

/** Ключ новой системы по хосту: «switch.pay.example:11101» → «switch». */
export function keyFromHost(host: string): string {
  return systemLabel(host)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

/** Неузнанный хост: новая система с этим хостом или хост к существующей системе. */
export function HostForm(props: FormProps<'system'>) {
  const { snapshot, target, readOnly, onTitle } = props;
  const { t } = useTranslation();
  const host = target.kind === 'host' ? target.host.toLowerCase() : '';
  const systems = externalSystems(snapshot).filter((x) => !x.hosts.includes(host));
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [systemId, setSystemId] = useState<number | null>(systems[0]?.id ?? null);

  useEffect(() => {
    if (mode === 'existing') onTitle?.(t('catalog.form.title.addHost'), host);
  }, [mode, host, onTitle, t]);

  const choice = (
    <fieldset className="mb-4 flex flex-col gap-2" data-testid="host-choice">
      <legend className="mb-2 text-[13px] text-muted-foreground">{t('catalog.form.hostChoice', { host })}</legend>
      {(['new', 'existing'] as const).map((v) => (
        <label
          key={v}
          className={cn(
            'flex cursor-pointer items-center gap-2.5 rounded-[10px] border px-3 py-2.5 text-[13.5px] transition-colors',
            mode === v ? 'border-primary/50 bg-accent text-accent-foreground' : 'border-border hover:bg-accent/40',
            v === 'existing' && systems.length === 0 && 'pointer-events-none opacity-50',
          )}
        >
          <input type="radio" name="host-mode" value={v} checked={mode === v} disabled={readOnly || (v === 'existing' && systems.length === 0)} onChange={() => setMode(v)} className="accent-[var(--color-primary)]" />
          {t(v === 'new' ? 'catalog.form.hostNew' : 'catalog.form.hostExisting')}
        </label>
      ))}
    </fieldset>
  );

  if (mode === 'new') {
    const key = keyFromHost(host);
    return (
      <div className="flex min-h-full flex-col">
        {choice}
        <SystemForm {...props} row={undefined} target={{ kind: 'system', draft: { key, name: systemLabel(host), hosts: host ? [host] : [], kind: 'external' } }} />
      </div>
    );
  }

  return (
    <AddHost key={systemId ?? 0} {...props} host={host} systemId={systemId} systems={systems} onSystem={setSystemId}>
      {choice}
    </AddHost>
  );
}

/** Хост к выбранной системе: правка системы с её updatedAt. Ключ — система, поэтому смена выбора начинает форму заново. */
function AddHost({
  project,
  snapshot,
  readOnly,
  onDone,
  onOpen,
  host,
  systemId,
  systems,
  onSystem,
  children,
}: FormProps<'system'> & { host: string; systemId: number | null; systems: SystemRow[]; onSystem: (id: number) => void; children: ReactNode }) {
  const { t } = useTranslation();
  const err = useErrorText();
  const chosen = snapshot.systems.find((x) => x.id === systemId);
  const [errors, setErrors] = useState<Errors>({});
  const save = useRowSave(project, 'system', chosen, onDone);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!chosen) return;
    const model = systemModel(chosen);
    const r = systemDraft({ ...model, hosts: `${model.hosts}\n${host}` }, snapshot, chosen.id);
    setErrors(r.errors);
    if (Object.keys(r.errors).length === 0) void save.submit(r.draft);
    else focusFirstInvalid(e.currentTarget);
  };

  return (
    <form id="catalog-form" onSubmit={onSubmit} noValidate className="flex min-h-full flex-col gap-4">
      {children}
      <ProblemNotice problem={save.problem} onReload={() => save.reload(chosen)} onRecreate={save.recreate} onOpenExisting={(id) => onOpen({ kind: 'system', id })} />
      <Field label={t('catalog.field.system')} error={err(errors.hosts ?? save.serverErrors.hosts)} disabled={readOnly}>
        {(p) => (
          <SelectField
            control={p}
            value={systemId === null ? '' : String(systemId)}
            onChange={(v) => onSystem(Number(v))}
            options={systems.map((x) => ({ value: String(x.id), label: x.name }))}
          />
        )}
      </Field>
      {chosen && <p className="text-[12px] leading-4 text-muted-foreground">{t('catalog.form.hostsAfter', { hosts: [...chosen.hosts, host].join(', ') })}</p>}
      <FormFooter project={project} kind="system" row={undefined} readOnly={readOnly} pending={save.pending} onCancel={onDone} onDelete={() => {}} onRestore={() => {}} />
    </form>
  );
}
