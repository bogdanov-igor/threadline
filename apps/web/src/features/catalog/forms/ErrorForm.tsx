import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { focusFirstInvalid } from '@/lib/focus.ts';
import { Input } from '@/components/ui/input.tsx';
import type { ErrorRow, Severity } from '@threadline/core/catalog';
import { FormFooter, ProblemNotice, targetSystemId, useRowSave, type FormProps } from '../form-parts.tsx';
import { methodsOf } from '../model.ts';
import { Field, FormSection, Notice, SelectField, TextArea, useErrorText } from '../ui.tsx';
import { errorDraft, errorModel, errorPrefill, type ErrorModel, type Errors } from '../validate.ts';

const GENERAL = 'general';
const WHOLE = 'whole';

export function ErrorForm({ project, snapshot, row, target, readOnly, onTitle, onDone, onOpen }: FormProps<'error'>) {
  const { t } = useTranslation();
  const err = useErrorText();
  const init = target.kind === 'error' ? target : undefined;
  const [m, setM] = useState<ErrorModel>(() => {
    if (row) return errorModel(row);
    // Общее правило — только если цель так и сказала; иначе система шага или система-автор.
    const general = init?.draft?.systemId === null && !init.systemKey;
    return errorModel({ ...errorPrefill(init?.draft, init?.sample, general), systemId: general ? null : targetSystemId(snapshot, init?.draft?.systemId, init?.systemKey) });
  });
  const [errors, setErrors] = useState<Errors>({});
  const save = useRowSave(project, 'error', row, onDone);
  const base = save.base;
  const sample = init?.sample ?? null;
  const system = snapshot.systems.find((x) => x.id === m.systemId);
  const methods = m.systemId !== null ? methodsOf(snapshot, m.systemId) : [];

  useEffect(() => {
    onTitle?.(base ? base.title : t('catalog.form.title.newError'), system?.name ?? t('catalog.section.general'));
  }, [base, system?.name, onTitle, t]);

  // Отказ про общее правило стоит у подстроки, а снимают его и код, и статус, и «Где действует».
  const dropBroad = () => {
    setErrors((prev) => {
      if (prev.text?.key !== 'generalHttpOnly') return prev;
      const { text: _text, ...rest } = prev;
      return rest;
    });
    save.clearServer('text');
  };

  const set = <F extends keyof ErrorModel>(f: F, v: ErrorModel[F]) => {
    setM((prev) => ({ ...prev, [f]: v }));
    setErrors(({ [f]: _drop, conditions: _c, ...rest }) => rest);
    save.clearServer(f);
    if (f === 'http' || f === 'code') dropBroad();
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const r = errorDraft(m, base);
    setErrors(r.errors);
    if (Object.keys(r.errors).length === 0) void save.submit(r.draft);
    else focusFirstInvalid(e.currentTarget);
  };

  const fe = (f: string) => err(errors[f] ?? save.serverErrors[f]);
  const disabled = readOnly;

  return (
    <form id="catalog-form" onSubmit={onSubmit} noValidate className="flex min-h-full flex-col gap-4">
      <ProblemNotice
        problem={save.problem}
        onReload={() => {
          const fresh = (save.problem?.kind === 'conflict' ? save.problem.fresh : null) as ErrorRow | null;
          const next = fresh ?? snapshot.errors.find((x) => x.id === base?.id);
          save.reload(next);
          if (next) setM(errorModel(next));
        }}
        onRecreate={save.recreate}
        onOpenExisting={(id) => onOpen({ kind: 'error', id })}
        onRestoreExisting={(id) => void save.restoreExisting(id)}
      />
      {!base && init?.noSystem && <Notice testId="error-no-system">{t('catalog.form.noSystemScope')}</Notice>}
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('catalog.field.scope')} disabled={disabled || !!base}>
          {(p) => (
            <SelectField
              control={p}
              value={m.systemId === null ? GENERAL : String(m.systemId)}
              onChange={(v) => {
                setM((prev) => ({ ...prev, systemId: v === GENERAL ? null : Number(v), methodId: null }));
                dropBroad();
              }}
              options={[
                { value: GENERAL, label: t('catalog.section.general') },
                ...snapshot.systems.filter((x) => !x.hidden).map((x) => ({ value: String(x.id), label: x.name })),
              ]}
            />
          )}
        </Field>
        <Field label={t('catalog.field.method')} error={fe('methodId')} optional disabled={disabled || !!base || m.systemId === null}>
          {(p) => (
            <SelectField
              control={p}
              value={m.methodId === null ? WHOLE : String(m.methodId)}
              onChange={(v) => set('methodId', v === WHOLE ? null : Number(v))}
              options={[{ value: WHOLE, label: t('catalog.form.wholeSystem') }, ...methods.map((x) => ({ value: String(x.id), label: x.name }))]}
            />
          )}
        </Field>
      </div>

      <FormSection title={t('catalog.form.matchBy')}>
        {errors.conditions && (
          <Notice tone="danger" testId="no-conditions">
            {err(errors.conditions)}
          </Notice>
        )}
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] items-start gap-3">
          <Field label={t('catalog.field.httpStatus')} error={fe('http')} optional disabled={disabled}>
            {(p) => <Input {...p} value={m.http} inputMode="numeric" className="tabular" maxLength={3} onChange={(e) => set('http', e.target.value.replace(/\D/g, ''))} />}
          </Field>
          <Field label={t('catalog.field.code')} hint={t('catalog.hint.code')} error={fe('code')} optional disabled={disabled}>
            {(p) => <Input {...p} value={m.code} className="font-mono text-[13px]" spellCheck={false} onChange={(e) => set('code', e.target.value)} />}
          </Field>
        </div>
        <Field
          label={t('catalog.field.textMatch')}
          hint={sample ? <span className="break-words">{t('catalog.hint.sample', { text: sample })}</span> : t('catalog.hint.textMatch')}
          error={fe('text')}
          optional
          disabled={disabled}
        >
          {(p) => <Input {...p} value={m.text} onChange={(e) => set('text', e.target.value)} />}
        </Field>
      </FormSection>

      <FormSection title={t('catalog.form.whatToShow')}>
        <Field label={t('catalog.field.title')} error={fe('title')} disabled={disabled}>
          {(p) => <Input {...p} value={m.title} onChange={(e) => set('title', e.target.value)} />}
        </Field>
        <Field label={t('catalog.field.action')} hint={t('catalog.hint.action')} error={fe('action')} optional disabled={disabled}>
          {(p) => <TextArea {...p} value={m.action} rows={2} onChange={(e) => set('action', e.target.value)} />}
        </Field>
        <div className="grid grid-cols-2 items-start gap-3">
          <Field label={t('catalog.field.severity')} hint={m.severity === 'ok' ? t('catalog.hint.severityOk') : undefined} disabled={disabled}>
            {(p) => (
              <SelectField
                control={p}
                value={m.severity}
                onChange={(v: Severity) => set('severity', v)}
                options={[
                  { value: 'error', label: t('catalog.severity.error') },
                  { value: 'ok', label: t('catalog.severity.ok') },
                ]}
              />
            )}
          </Field>
          <Field label={t('catalog.field.partnerCode')} hint={t('catalog.hint.partnerCode')} error={fe('partnerCode')} optional disabled={disabled}>
            {(p) => <Input {...p} value={m.partnerCode} className="font-mono text-[13px]" onChange={(e) => set('partnerCode', e.target.value)} />}
          </Field>
        </div>
      </FormSection>

      <FormFooter
        project={project}
        kind="error"
        row={base}
        readOnly={readOnly}
        pending={save.pending}
        onCancel={onDone}
        onDelete={() => void save.remove()}
        onRestore={() => void save.restore()}
        onDeleteForever={() => void save.removeForever()}
      />
    </form>
  );
}
