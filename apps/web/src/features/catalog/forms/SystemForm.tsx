import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { focusFirstInvalid } from '@/lib/focus.ts';
import { Input } from '@/components/ui/input.tsx';
import type { SystemRow, SystemType } from '@threadline/core/catalog';
import { FormFooter, ProblemNotice, useRowSave, type FormProps } from '../form-parts.tsx';
import { Field, SelectField, TextArea, useErrorText } from '../ui.tsx';
import { systemDraft, systemModel, type Errors, type SystemModel } from '../validate.ts';

const TYPES: SystemType[] = ['service', 'database', 'queue'];

export function SystemForm({ project, snapshot, row, target, readOnly, onTitle, onDone, onOpen }: FormProps<'system'>) {
  const { t } = useTranslation();
  const err = useErrorText();
  const initial = target.kind === 'system' ? target.draft : undefined;
  const [m, setM] = useState<SystemModel>(() => systemModel(row ?? initial));
  const [errors, setErrors] = useState<Errors>({});
  const save = useRowSave(project, 'system', row, onDone);
  const base = save.base;
  const author = (base?.kind ?? m.kind) === 'project';

  useEffect(() => {
    onTitle?.(base ? base.name : t('catalog.form.title.newSystem'), author ? t('catalog.section.project') : t('catalog.section.external'));
  }, [base, author, onTitle, t]);

  const set = <F extends keyof SystemModel>(f: F, v: SystemModel[F]) => {
    setM((prev) => ({ ...prev, [f]: v }));
    if (errors[f]) setErrors(({ [f]: _drop, ...rest }) => rest);
    save.clearServer(f);
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const r = systemDraft(m, snapshot, base?.id);
    setErrors(r.errors);
    if (Object.keys(r.errors).length === 0) void save.submit(r.draft);
    else focusFirstInvalid(e.currentTarget);
  };

  const fieldError = (f: string) => err(errors[f] ?? save.serverErrors[f]);
  const disabled = readOnly;

  return (
    <form id="catalog-form" onSubmit={onSubmit} noValidate className="flex min-h-full flex-1 flex-col gap-4">
      <ProblemNotice
        problem={save.problem}
        onReload={() => {
          const fresh = (save.problem?.kind === 'conflict' ? save.problem.fresh : null) as SystemRow | null;
          const next = fresh ?? snapshot.systems.find((x) => x.id === base?.id);
          save.reload(next);
          if (next) setM(systemModel(next));
        }}
        onRecreate={save.recreate}
        onOpenExisting={(id) => onOpen({ kind: 'system', id })}
        onRestoreExisting={(id) => void save.restoreExisting(id)}
      />
      <Field label={t('catalog.field.name')} error={fieldError('name')} disabled={disabled}>
        {(p) => <Input {...p} value={m.name} maxLength={200} onChange={(e) => set('name', e.target.value)} autoFocus={!base} />}
      </Field>
      <Field label={t('catalog.field.systemKey')} hint={base ? t('catalog.hint.keyFixed') : t('catalog.hint.systemKey')} error={fieldError('key')} disabled={disabled || !!base}>
        {(p) => <Input {...p} value={m.key} className="font-mono" onChange={(e) => set('key', e.target.value.toLowerCase())} spellCheck={false} />}
      </Field>
      {!author && (
        <Field label={t('catalog.field.systemType')} error={fieldError('type')} disabled={disabled}>
          {(p) => <SelectField control={p} value={m.type} onChange={(v) => set('type', v)} options={TYPES.map((x) => ({ value: x, label: t(`catalog.systemType.${x}`) }))} />}
        </Field>
      )}
      <Field label={t('catalog.field.hosts')} hint={t('catalog.hint.hosts')} error={fieldError('hosts')} optional disabled={disabled}>
        {(p) => <TextArea {...p} value={m.hosts} className="font-mono text-[13px]" rows={3} spellCheck={false} onChange={(e) => set('hosts', e.target.value)} />}
      </Field>
      <Field label={t('catalog.field.description')} error={fieldError('description')} optional disabled={disabled}>
        {(p) => <TextArea {...p} value={m.description} rows={3} onChange={(e) => set('description', e.target.value)} />}
      </Field>
      <FormFooter
        project={project}
        kind="system"
        row={base}
        readOnly={readOnly}
        pending={save.pending}
        canDelete={!author}
        onCancel={onDone}
        onDelete={() => void save.remove()}
        onRestore={() => void save.restore()}
        onDeleteForever={() => void save.removeForever()}
      />
    </form>
  );
}
