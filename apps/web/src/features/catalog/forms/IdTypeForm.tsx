import { ArrowDown, ArrowUp, Plus } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { focusFirstInvalid } from '@/lib/focus.ts';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import type { IdKind, IdTypeRow, StatusOutcome } from '@threadline/core/catalog';
import { newFieldKey } from '../conditions.ts';
import { FormFooter, ProblemNotice, useRowSave, type FormProps } from '../form-parts.tsx';
import { Field, SelectField, useErrorText } from '../ui.tsx';
import { idTypeDraft, idTypeModel, LIMITS, moveRow, type Errors, type IdTypeModel } from '../validate.ts';
import { RemoveButton, RowInput } from './MethodForm.tsx';

const KINDS: IdKind[] = ['entity', 'operation'];
const STATUS_OUTCOMES: StatusOutcome[] = ['pending', 'success', 'failure'];

export function IdTypeForm({ project, snapshot, row, target, readOnly, onTitle, onDone, onOpen }: FormProps<'idType'>) {
  const { t } = useTranslation();
  const err = useErrorText();
  const init = target.kind === 'idType' ? target.draft : undefined;
  const [m, setM] = useState<IdTypeModel>(() => idTypeModel(row ?? init));
  const [errors, setErrors] = useState<Errors>({});
  const save = useRowSave(project, 'idType', row, onDone);
  const base = save.base;
  // Сколько методов ссылается на тип: удалить и скрыть такой тип нельзя.
  const usedBy = base ? snapshot.methods.filter((x) => !x.hidden && (x.op === base.key || x.fields.some((f) => f.type === base.key))).length : 0;

  useEffect(() => {
    onTitle?.(base ? base.name : t('catalog.form.title.newIdType'), t('catalog.section.ids'));
  }, [base, onTitle, t]);

  const set = <F extends keyof IdTypeModel>(f: F, v: IdTypeModel[F]) => {
    setM((prev) => ({ ...prev, [f]: v }));
    if (errors[f]) setErrors(({ [f]: _drop, ...rest }) => rest);
    save.clearServer(f);
  };
  const setStatus = (i: number, patch: Partial<IdTypeModel['statuses'][number]>) => set('statuses', m.statuses.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const r = idTypeDraft(m, snapshot, base?.id);
    setErrors(r.errors);
    if (Object.keys(r.errors).length === 0) void save.submit(r.draft);
    else focusFirstInvalid(e.currentTarget);
  };

  const fe = (f: string) => err(errors[f] ?? save.serverErrors[f]);
  const disabled = readOnly;
  const dupKey = errors.key?.key === 'keyTaken' ? errors.key.id : undefined;

  return (
    <form id="catalog-form" onSubmit={onSubmit} noValidate className="flex min-h-full flex-col gap-4">
      <ProblemNotice
        problem={save.problem}
        onReload={() => {
          const fresh = (save.problem?.kind === 'conflict' ? save.problem.fresh : null) as IdTypeRow | null;
          const next = fresh ?? snapshot.idTypes.find((x) => x.id === base?.id);
          save.reload(next);
          if (next) setM(idTypeModel(next));
        }}
        onRecreate={save.recreate}
        onOpenExisting={(id) => onOpen({ kind: 'idType', id })}
        onRestoreExisting={(id) => void save.restoreExisting(id)}
      />
      {dupKey !== undefined && (
        <ProblemNotice problem={{ kind: 'duplicate', id: dupKey ?? null, hidden: snapshot.idTypes.some((x) => x.id === dupKey && x.hidden) }} onReload={() => {}} onRecreate={() => {}} onOpenExisting={(id) => onOpen({ kind: 'idType', id })} onRestoreExisting={(id) => void save.restoreExisting(id)} />
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('catalog.field.typeKey')} hint={base ? t('catalog.hint.keyFixed') : t('catalog.hint.typeKey')} error={dupKey === undefined ? fe('key') : null} disabled={disabled || !!base}>
          {(p) => <Input {...p} value={m.key} className="font-mono" spellCheck={false} onChange={(e) => set('key', e.target.value.toLowerCase())} autoFocus={!base} />}
        </Field>
        <Field label={t('catalog.field.typeKind')} disabled={disabled}>
          {(p) => <SelectField control={p} value={m.kind} onChange={(v: IdKind) => set('kind', v)} options={KINDS.map((x) => ({ value: x, label: t(`catalog.idKind.${x}`) }))} />}
        </Field>
      </div>
      <Field label={t('catalog.field.name')} error={fe('name')} disabled={disabled}>
        {(p) => <Input {...p} value={m.name} onChange={(e) => set('name', e.target.value)} />}
      </Field>
      {base && usedBy > 0 && <p className="-mt-2 text-[12px] leading-4 text-muted-foreground">{t('catalog.hint.typeUsed', { count: usedBy })}</p>}

      {m.kind === 'operation' && (
        <section className="flex flex-col gap-2.5" aria-labelledby="statuses-title">
          <div className="flex items-baseline justify-between gap-3">
            <h3 id="statuses-title" className="text-[13px] font-medium text-foreground">
              {t('catalog.form.statuses')}
            </h3>
            <span className="tabular text-[12px] text-muted-foreground">
              {m.statuses.length} / {LIMITS.statuses}
            </span>
          </div>
          <p className="text-[12px] leading-4 text-muted-foreground">{t('catalog.hint.statuses')}</p>
          {fe('statuses') && <p className="text-[12px] text-danger">{fe('statuses')}</p>}
          <ol className="flex flex-col gap-2" aria-labelledby="statuses-title">
            {m.statuses.map((x, i) => (
              <li key={x.key} className="grid grid-cols-[minmax(0,0.9fr)_minmax(0,1fr)_7.5rem_auto] items-start gap-2" data-testid="status-row">
                <RowInput label={t('catalog.field.statusValue')} value={x.value} error={fe(`statuses.${i}.value`)} disabled={disabled} mono onChange={(v) => setStatus(i, { value: v })} />
                <RowInput label={t('catalog.field.statusName')} value={x.name} error={fe(`statuses.${i}.name`)} disabled={disabled} onChange={(v) => setStatus(i, { name: v })} />
                <SelectField
                  ariaLabel={t('catalog.field.statusOutcome')}
                  control={{ id: `${x.key}-o`, ...(disabled ? { disabled } : {}) }}
                  value={x.outcome}
                  onChange={(v: StatusOutcome) => setStatus(i, { outcome: v })}
                  options={STATUS_OUTCOMES.map((o) => ({ value: o, label: t(`catalog.statusOutcome.${o}`) }))}
                />
                {!disabled && (
                  <span className="flex">
                    <Button type="button" variant="ghost" size="icon" className="text-muted-foreground" aria-label={t('catalog.form.moveUp', { value: x.value || i + 1 })} disabled={i === 0} onClick={() => set('statuses', moveRow(m.statuses, i, -1))}>
                      <ArrowUp aria-hidden />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="text-muted-foreground"
                      aria-label={t('catalog.form.moveDown', { value: x.value || i + 1 })}
                      disabled={i === m.statuses.length - 1}
                      onClick={() => set('statuses', moveRow(m.statuses, i, 1))}
                    >
                      <ArrowDown aria-hidden />
                    </Button>
                    <RemoveButton label={t('catalog.form.removeStatus')} disabled={disabled} onClick={() => set('statuses', m.statuses.filter((_, j) => j !== i))} />
                  </span>
                )}
              </li>
            ))}
          </ol>
          {!disabled && m.statuses.length < LIMITS.statuses && (
            <Button type="button" variant="ghost" size="sm" className="self-start text-primary" onClick={() => set('statuses', [...m.statuses, { key: newFieldKey(), value: '', name: '', outcome: 'pending' }])}>
              <Plus aria-hidden />
              {t('catalog.form.addStatus')}
            </Button>
          )}
        </section>
      )}

      <FormFooter
        project={project}
        kind="idType"
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
