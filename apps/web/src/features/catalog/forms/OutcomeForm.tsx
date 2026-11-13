import { Plus } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { focusFirstInvalid } from '@/lib/focus.ts';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import type { OutcomeKind, OutcomeRow } from '@threadline/core/catalog';
import { emptyField, MAX_FIELDS, type CheckKind, type FieldModel, type HttpMode } from '../conditions.ts';
import { FormFooter, ProblemNotice, targetSystemId, useRowSave, type FormProps } from '../form-parts.tsx';
import { methodsOf } from '../model.ts';
import { Field, FormSection, Notice, SelectField, TextArea, useErrorText } from '../ui.tsx';
import { outcomeDraft, outcomeModel, type Errors, type OutcomeModel, type RuleLevelModel } from '../validate.ts';
import { RemoveButton, RowInput } from './MethodForm.tsx';

const LEVELS: RuleLevelModel[] = ['method', 'system', 'general'];
const MODES: HttpMode[] = ['any', 'equals', 'oneOf', 'range'];
const CHECKS: CheckKind[] = ['equals', 'oneOf', 'exists', 'missing', 'regex'];
export const OUTCOMES: OutcomeKind[] = ['success', 'error', 'pending', 'ignore'];

export function OutcomeForm({ project, snapshot, row, target, readOnly, onTitle, onDone, onOpen }: FormProps<'outcome'>) {
  const { t } = useTranslation();
  const err = useErrorText();
  const init = target.kind === 'outcome' ? target : undefined;
  const [m, setM] = useState<OutcomeModel>(() => {
    if (row) return outcomeModel(row);
    const general = init?.draft?.systemId === null && !init.systemKey;
    return outcomeModel({ ...init?.draft, systemId: general ? null : targetSystemId(snapshot, init?.draft?.systemId, init?.systemKey) });
  });
  const [errors, setErrors] = useState<Errors>({});
  const save = useRowSave(project, 'outcome', row, onDone);
  const base = save.base;
  const system = snapshot.systems.find((x) => x.id === m.systemId);
  const methods = m.systemId !== null ? methodsOf(snapshot, m.systemId) : [];

  useEffect(() => {
    onTitle?.(base ? t('catalog.form.title.outcome') : t('catalog.form.title.newOutcome'), m.level === 'general' ? t('catalog.section.general') : (system?.name ?? null));
  }, [base, m.level, system?.name, onTitle, t]);

  const touch = (f: string) => {
    setErrors(({ [f]: _drop, conditions: _c, ...rest }) => rest);
    save.clearServer(f);
  };
  const set = <F extends keyof OutcomeModel>(f: F, v: OutcomeModel[F]) => {
    setM((prev) => ({ ...prev, [f]: v }));
    touch(f);
  };
  const setHttp = (patch: Partial<OutcomeModel['conditions']['http']>, field: string) => {
    setM((prev) => ({ ...prev, conditions: { ...prev.conditions, http: { ...prev.conditions.http, ...patch } } }));
    touch(field);
  };
  const setField = (i: number, patch: Partial<FieldModel>, field: string) => {
    setM((prev) => ({ ...prev, conditions: { ...prev.conditions, fields: prev.conditions.fields.map((x, j) => (j === i ? { ...x, ...patch } : x)) } }));
    touch(`fields.${i}.${field}`);
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const r = outcomeDraft(m);
    setErrors(r.errors);
    if (Object.keys(r.errors).length === 0) void save.submit(r.draft);
    else focusFirstInvalid(e.currentTarget);
  };

  const fe = (f: string) => err(errors[f] ?? save.serverErrors[f]);
  const disabled = readOnly;
  const h = m.conditions.http;

  return (
    <form id="catalog-form" onSubmit={onSubmit} noValidate className="flex min-h-full flex-col gap-4">
      <ProblemNotice
        problem={save.problem}
        onReload={() => {
          const fresh = (save.problem?.kind === 'conflict' ? save.problem.fresh : null) as OutcomeRow | null;
          const next = fresh ?? snapshot.outcomeRules.find((x) => x.id === base?.id);
          save.reload(next);
          if (next) setM(outcomeModel(next));
        }}
        onRecreate={save.recreate}
        onOpenExisting={(id) => onOpen({ kind: 'outcome', id })}
        onRestoreExisting={(id) => void save.restoreExisting(id)}
      />

      <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-3">
        <Field label={t('catalog.field.level')} disabled={disabled || !!base}>
          {(p) => (
            <SelectField
              control={p}
              value={m.level}
              onChange={(v: RuleLevelModel) => {
                setM((prev) => ({ ...prev, level: v, systemId: v === 'general' ? null : (prev.systemId ?? targetSystemId(snapshot, null, undefined)), methodId: v === 'method' ? prev.methodId : null }));
                touch('methodId');
              }}
              options={LEVELS.map((x) => ({ value: x, label: t(`catalog.level.${x}`) }))}
            />
          )}
        </Field>
        <Field label={t('catalog.field.priority')} error={fe('priority')} disabled={disabled}>
          {(p) => <Input {...p} value={m.priority} inputMode="numeric" className="tabular" maxLength={4} onChange={(e) => set('priority', e.target.value.replace(/\D/g, ''))} />}
        </Field>
      </div>
      <p className="-mt-2 text-[12px] leading-4 text-muted-foreground">{t('catalog.hint.priority')}</p>
      {m.level !== 'general' && (
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('catalog.field.system')} error={fe('systemId')} disabled={disabled || !!base}>
            {(p) => (
              <SelectField
                control={p}
                value={m.systemId === null ? '' : String(m.systemId)}
                onChange={(v) => setM((prev) => ({ ...prev, systemId: Number(v), methodId: null }))}
                options={snapshot.systems.filter((x) => !x.hidden).map((x) => ({ value: String(x.id), label: x.name }))}
              />
            )}
          </Field>
          {m.level === 'method' && (
            <Field label={t('catalog.field.method')} error={fe('methodId')} disabled={disabled || !!base}>
              {(p) => (
                <SelectField
                  control={p}
                  value={m.methodId === null ? '' : String(m.methodId)}
                  onChange={(v) => set('methodId', Number(v))}
                  options={methods.map((x) => ({ value: String(x.id), label: x.name }))}
                  placeholder={t('catalog.form.chooseMethod')}
                />
              )}
            </Field>
          )}
        </div>
      )}

      <FormSection title={t('catalog.form.when')}>
        {errors.conditions && (
          <Notice tone="danger" testId="no-conditions">
            {err(errors.conditions)}
          </Notice>
        )}
        <div className="grid grid-cols-[9rem_minmax(0,1fr)] items-start gap-3">
          <Field label={t('catalog.field.httpStatus')} disabled={disabled}>
            {(p) => <SelectField control={p} value={h.mode} onChange={(v: HttpMode) => setHttp({ mode: v }, 'http.equals')} options={MODES.map((x) => ({ value: x, label: t(`catalog.httpMode.${x}`) }))} />}
          </Field>
          <div className="flex min-w-0 flex-col gap-1.5 pt-[26px]">
            {h.mode === 'equals' && (
              <RowInput label={t('catalog.field.httpStatus')} value={h.equals} error={fe('http.equals')} disabled={disabled} placeholder="422" onChange={(v) => setHttp({ equals: v.replace(/\D/g, '').slice(0, 3) }, 'http.equals')} />
            )}
            {h.mode === 'oneOf' && (
              <RowInput label={t('catalog.httpMode.oneOf')} value={h.oneOf} error={fe('http.oneOf')} disabled={disabled} placeholder="200, 202, 400-499" onChange={(v) => setHttp({ oneOf: v }, 'http.oneOf')} />
            )}
            {h.mode === 'range' && (
              <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-start gap-2">
                <RowInput label={t('catalog.field.httpFrom')} value={h.from} error={fe('http.from')} disabled={disabled} placeholder="400" onChange={(v) => setHttp({ from: v.replace(/\D/g, '').slice(0, 3) }, 'http.from')} />
                <span className="pt-2 text-muted-foreground" aria-hidden>
                  –
                </span>
                <RowInput label={t('catalog.field.httpTo')} value={h.to} error={fe('http.to')} disabled={disabled} placeholder="499" onChange={(v) => setHttp({ to: v.replace(/\D/g, '').slice(0, 3) }, 'http.to')} />
              </div>
            )}
          </div>
        </div>

        {m.conditions.fields.length > 0 && <p className="text-[12px] leading-4 text-muted-foreground">{t('catalog.hint.fieldPath')}</p>}
        {fe('conditions.fields') && <p className="text-[12px] text-danger">{fe('conditions.fields')}</p>}
        {m.conditions.fields.map((f, i) => (
          <div key={f.key} className="grid grid-cols-[minmax(0,1fr)_2rem] gap-2 rounded-[10px] border border-border p-2.5" data-testid="condition-row">
            <div className="grid min-w-0 grid-cols-[6.5rem_minmax(0,1fr)] gap-2">
              <SelectField
                ariaLabel={t('catalog.field.where')}
                control={{ id: `${f.key}-in`, ...(disabled ? { disabled } : {}) }}
                value={f.in}
                onChange={(v) => setField(i, { in: v }, 'path')}
                options={[
                  { value: 'response' as const, label: t('catalog.place.response') },
                  { value: 'request' as const, label: t('catalog.place.request') },
                ]}
              />
              <RowInput label={t('catalog.field.fieldPath')} value={f.path} error={fe(`fields.${i}.path`)} disabled={disabled} mono placeholder="status" onChange={(v) => setField(i, { path: v }, 'path')} />
              <SelectField
                ariaLabel={t('catalog.field.check')}
                control={{ id: `${f.key}-check`, ...(disabled ? { disabled } : {}) }}
                value={f.check}
                onChange={(v: CheckKind) => setField(i, { check: v }, 'value')}
                options={CHECKS.map((x) => ({ value: x, label: t(`catalog.check.${x}`) }))}
              />
              {f.check === 'exists' || f.check === 'missing' ? (
                <span />
              ) : (
                <RowInput
                  label={t('catalog.field.value')}
                  value={f.value}
                  error={fe(`fields.${i}.value`)}
                  disabled={disabled}
                  mono
                  placeholder={f.check === 'oneOf' ? 'OK, SUCCESS' : f.check === 'regex' ? '^[Tt]imeout' : 'OK'}
                  onChange={(v) => setField(i, { value: v }, 'value')}
                />
              )}
            </div>
            <RemoveButton
              label={t('catalog.form.removeCondition')}
              disabled={disabled}
              onClick={() => setM((prev) => ({ ...prev, conditions: { ...prev.conditions, fields: prev.conditions.fields.filter((_, j) => j !== i) } }))}
            />
          </div>
        ))}
        {!disabled && m.conditions.fields.length < MAX_FIELDS && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="self-start text-primary"
            onClick={() => {
              setM((prev) => ({ ...prev, conditions: { ...prev.conditions, fields: [...prev.conditions.fields, emptyField()] } }));
              touch('conditions');
            }}
          >
            <Plus aria-hidden />
            {t('catalog.form.addCondition')}
          </Button>
        )}
      </FormSection>

      <FormSection title={t('catalog.form.then')}>
        <Field label={t('catalog.field.outcome')} disabled={disabled}>
          {(p) => <SelectField control={p} value={m.outcome} onChange={(v: OutcomeKind) => set('outcome', v)} options={OUTCOMES.map((x) => ({ value: x, label: t(`catalog.outcome.${x}`) }))} />}
        </Field>
        <Field label={t('catalog.field.text')} hint={t('catalog.hint.template')} error={fe('text')} optional disabled={disabled}>
          {(p) => <Input {...p} value={m.text} placeholder={t('catalog.hint.templateExample')} onChange={(e) => set('text', e.target.value)} />}
        </Field>
        <Field label={t('catalog.field.action')} error={fe('action')} optional disabled={disabled}>
          {(p) => <TextArea {...p} value={m.action} rows={2} onChange={(e) => set('action', e.target.value)} />}
        </Field>
      </FormSection>

      <FormFooter
        project={project}
        kind="outcome"
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
