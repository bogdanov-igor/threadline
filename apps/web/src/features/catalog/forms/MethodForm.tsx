import { ArrowRight, ChevronDown, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { focusFirstInvalid } from '@/lib/focus.ts';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Switch } from '@/components/ui/switch.tsx';
import type { IdField, MethodKind, MethodRow } from '@threadline/core/catalog';
import { quoted } from '@/lib/format.ts';
import { cn } from '@/lib/utils.ts';
import { FormFooter, ProblemNotice, targetSystemId, useRowSave, type FormProps } from '../form-parts.tsx';
import { catalogPath, methodKinds, needsOp, placeholders } from '../model.ts';
import { Field, SelectField, TextArea, useErrorText } from '../ui.tsx';
import { HTTP_METHODS, LIMITS, methodDraft, methodModel, type Errors, type MethodModel } from '../validate.ts';
import { newFieldKey } from '../conditions.ts';

const PLACES: IdField['in'][] = ['query', 'request', 'response'];
// Статус лежит в теле: строки запроса у него нет.
const STATUS_PLACES: ('request' | 'response')[] = ['request', 'response'];
const NO_OP = '—';

export function MethodForm({ project, snapshot, row, target, readOnly, onTitle, onDone, onOpen }: FormProps<'method'>) {
  const { t } = useTranslation();
  const err = useErrorText();
  const init = target.kind === 'method' ? target : undefined;
  const [m, setM] = useState<MethodModel>(() =>
    methodModel(row ?? { ...init?.draft, systemId: targetSystemId(snapshot, init?.draft?.systemId, init?.systemKey) ?? snapshot.systems[0]?.id ?? 0 }),
  );
  const [errors, setErrors] = useState<Errors>({});
  const [idsOpen, setIdsOpen] = useState(() => m.fields.length > 0 || m.status);
  const save = useRowSave(project, 'method', row, onDone);
  const base = save.base;
  const system = snapshot.systems.find((x) => x.id === m.systemId);
  const source = system?.kind ?? 'external';

  useEffect(() => {
    onTitle?.(base ? base.name : t('catalog.form.title.newMethod'), system?.name ?? null);
  }, [base, system?.name, onTitle, t]);

  const set = <F extends keyof MethodModel>(f: F, v: MethodModel[F]) => {
    setM((prev) => ({ ...prev, [f]: v }));
    if (errors[f]) setErrors(({ [f]: _drop, ...rest }) => rest);
    save.clearServer(f);
  };

  const opTypes = snapshot.idTypes.filter((x) => x.kind === 'operation' && !x.hidden);
  const allTypes = snapshot.idTypes.filter((x) => !x.hidden);
  const opType = opTypes.find((x) => x.key === m.op);
  const places = useMemo(() => placeholders(m.path, snapshot.idTypes), [m.path, snapshot.idTypes]);
  const kinds = methodKinds(source);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const r = methodDraft(m, snapshot, base?.id);
    setErrors(r.errors);
    if (Object.keys(r.errors).some((k) => k.startsWith('fields') || k.startsWith('status'))) setIdsOpen(true);
    if (Object.keys(r.errors).length === 0) void save.submit(r.draft);
    else focusFirstInvalid(e.currentTarget);
  };

  const fe = (f: string) => err(errors[f] ?? save.serverErrors[f]);
  const disabled = readOnly;
  const dup = errors.path?.key === 'duplicate' ? errors.path.id : undefined;

  return (
    <form id="catalog-form" onSubmit={onSubmit} noValidate className="flex min-h-full flex-col gap-4">
      <ProblemNotice
        problem={save.problem}
        onReload={() => {
          const fresh = (save.problem?.kind === 'conflict' ? save.problem.fresh : null) as MethodRow | null;
          const next = fresh ?? snapshot.methods.find((x) => x.id === base?.id);
          save.reload(next);
          if (next) setM(methodModel(next));
        }}
        onRecreate={save.recreate}
        onOpenExisting={(id) => onOpen({ kind: 'method', id })}
        onRestoreExisting={(id) => void save.restoreExisting(id)}
      />
      <Field label={t('catalog.field.system')} disabled={disabled || !!base}>
        {(p) => (
          <SelectField
            control={p}
            value={String(m.systemId)}
            onChange={(v) => {
              const next = snapshot.systems.find((x) => x.id === Number(v));
              setM((prev) => ({ ...prev, systemId: Number(v), kind: next?.kind !== 'project' && prev.kind === 'callback' ? 'call' : prev.kind }));
            }}
            options={snapshot.systems.filter((x) => !x.hidden && x.type === 'service').map((x) => ({ value: String(x.id), label: x.name }))}
          />
        )}
      </Field>
      <div className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-3">
        <Field label={t('catalog.field.http')} disabled={disabled}>
          {(p) => (
            <SelectField
              control={p}
              value={m.http}
              onChange={(v) => set('http', v)}
              options={HTTP_METHODS.map((x) => ({ value: x, label: x === '*' ? t('catalog.anyMethod') : x }))}
            />
          )}
        </Field>
        <Field
          label={t('catalog.field.path')}
          error={dup === undefined ? fe('path') : null}
          hint={t('catalog.hint.path')}
          disabled={disabled}
        >
          {(p) => <Input {...p} value={m.path} className="font-mono text-[13px]" spellCheck={false} onChange={(e) => set('path', e.target.value)} autoFocus={!base && !init?.draft?.path} />}
        </Field>
      </div>
      {dup !== undefined && (
        <ProblemNotice problem={{ kind: 'duplicate', id: dup ?? null, hidden: snapshot.methods.some((x) => x.id === dup && x.hidden) }} onReload={() => {}} onRecreate={() => {}} onOpenExisting={(id) => onOpen({ kind: 'method', id })} onRestoreExisting={(id) => void save.restoreExisting(id)} />
      )}
      {places.length > 0 && (
        <ul className="-mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] leading-4" aria-label={t('catalog.form.placeholders')} data-testid="placeholder-types">
          {places.map((x) => (
            <li key={x.name} className="min-w-0">
              <code className="font-mono text-foreground">{`{${x.name}}`}</code>
              <span className="text-muted-foreground"> — {x.type ? x.type.name : t('catalog.form.noType')}</span>
            </li>
          ))}
        </ul>
      )}
      <Field label={t('catalog.field.rpc')} hint={t('catalog.hint.rpc')} error={fe('rpc')} optional disabled={disabled}>
        {(p) => <Input {...p} value={m.rpc} className="font-mono text-[13px]" spellCheck={false} onChange={(e) => set('rpc', e.target.value)} />}
      </Field>
      <Field label={t('catalog.field.name')} error={fe('name')} disabled={disabled}>
        {(p) => <Input {...p} value={m.name} onChange={(e) => set('name', e.target.value)} autoFocus={!base && !!init?.draft?.path} />}
      </Field>
      <Field label={t('catalog.field.domain')} error={fe('domain')} optional disabled={disabled}>
        {(p) => <Input {...p} value={m.domain} onChange={(e) => set('domain', e.target.value)} />}
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('catalog.field.kind')} disabled={disabled}>
          {(p) => (
            <SelectField
              control={p}
              value={m.kind}
              onChange={(v: MethodKind) => set('kind', v)}
              options={kinds.map((k) => ({ value: k, label: t(`catalog.methodKind.${source}.${k}`) }))}
            />
          )}
        </Field>
        <Field label={t('catalog.field.op')} error={fe('op')} optional={!needsOp(m.kind)} disabled={disabled || (opTypes.length === 0 && !m.op)}>
          {(p) => (
            <SelectField
              control={p}
              value={m.op || NO_OP}
              onChange={(v) => set('op', v === NO_OP ? '' : v)}
              options={[
                ...(needsOp(m.kind) ? [] : [{ value: NO_OP, label: t('catalog.form.noOp') }]),
                ...opTypes.map((x) => ({ value: x.key, label: x.name })),
              ]}
              placeholder={t('catalog.form.chooseOp')}
            />
          )}
        </Field>
      </div>
      <TypesHint project={project} text={opTypes.length > 0 ? t('catalog.hint.opTypes') : t('catalog.hint.noOpTypes')} warning={opTypes.length === 0 && needsOp(m.kind)} testId="op-types-hint" className="-mt-2" />
      <Field label={t('catalog.field.description')} error={fe('description')} optional disabled={disabled}>
        {(p) => <TextArea {...p} value={m.description} rows={2} onChange={(e) => set('description', e.target.value)} />}
      </Field>

      {/* Поля id и статус — свёрнутым блоком: нужны только методам операций. */}
      <section className="rounded-[12px] border border-border">
        <button
          type="button"
          aria-expanded={idsOpen}
          onClick={() => setIdsOpen((v) => !v)}
          className="flex h-10 w-full items-center gap-2 rounded-[12px] px-3.5 text-left text-[13px] font-medium text-foreground hover:bg-accent/40"
        >
          <ChevronDown className={cn('size-4 shrink-0 text-muted-foreground transition-transform', !idsOpen && '-rotate-90')} aria-hidden />
          <span className="flex-1">{t('catalog.form.idsAndStatus')}</span>
          <span className="text-[12px] font-normal text-muted-foreground">
            {[m.fields.length ? t('catalog.count.fields', { count: m.fields.length }) : null, m.status && m.op ? t('catalog.form.statusOn') : null].filter(Boolean).join(' · ')}
          </span>
        </button>
        {idsOpen && (
          <div className="flex flex-col gap-3 border-t border-border px-3.5 pt-3 pb-3.5">
            <p className="text-[12px] leading-4 text-muted-foreground">{t('catalog.hint.idFields')}</p>
            <TypesHint project={project} text={allTypes.length > 0 ? t('catalog.hint.idTypes') : t('catalog.hint.noIdTypes')} warning={allTypes.length === 0 && m.fields.length > 0} testId="id-types-hint" />
            {fe('fields') && <p className="text-[12px] text-danger">{fe('fields')}</p>}
            {m.fields.map((f, i) => (
              <div key={f.key} className="grid grid-cols-[6.5rem_minmax(0,1fr)_minmax(0,0.8fr)_2rem] items-start gap-2" data-testid="id-field-row">
                <SelectField
                  ariaLabel={t('catalog.field.where')}
                  control={{ id: `${f.key}-in`, ...(disabled ? { disabled } : {}) }}
                  value={f.in}
                  onChange={(v) => set('fields', m.fields.map((x, j) => (j === i ? { ...x, in: v } : x)))}
                  options={PLACES.map((x) => ({ value: x, label: t(`catalog.place.${x}`) }))}
                />
                <RowInput
                  label={t('catalog.field.fieldPath')}
                  value={f.path}
                  error={fe(`fields.${i}.path`)}
                  disabled={disabled}
                  mono
                  onChange={(v) => set('fields', m.fields.map((x, j) => (j === i ? { ...x, path: v } : x)))}
                />
                <div className="flex min-w-0 flex-col gap-1">
                  <SelectField
                    ariaLabel={t('catalog.field.idType')}
                    control={{ id: `${f.key}-type`, ...(fe(`fields.${i}.type`) ? { 'aria-invalid': true } : {}), ...(disabled || (allTypes.length === 0 && !f.type) ? { disabled: true } : {}) }}
                    value={f.type}
                    onChange={(v) => set('fields', m.fields.map((x, j) => (j === i ? { ...x, type: v } : x)))}
                    options={allTypes.map((x) => ({ value: x.key, label: x.name }))}
                    placeholder={t('catalog.form.chooseType')}
                  />
                  {fe(`fields.${i}.type`) && <span className="text-[12px] leading-4 text-danger">{fe(`fields.${i}.type`)}</span>}
                </div>
                <RemoveButton label={t('catalog.form.removeField')} disabled={disabled} onClick={() => set('fields', m.fields.filter((_, j) => j !== i))} />
              </div>
            ))}
            {!disabled && m.fields.length < LIMITS.fields && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="self-start text-primary"
                onClick={() => set('fields', [...m.fields, { key: newFieldKey(), in: 'request', path: '', type: '' }])}
              >
                <Plus aria-hidden />
                {t('catalog.form.addField')}
              </Button>
            )}

            <div className="mt-1 flex items-center justify-between gap-3 border-t border-border pt-3">
              <label htmlFor="method-status" className={cn('text-[13px] font-medium', !m.op && 'text-muted-foreground')}>
                {t('catalog.form.statusField')}
              </label>
              <Switch id="method-status" checked={m.status && !!m.op} disabled={disabled || !m.op} onCheckedChange={(v) => set('status', v)} />
            </div>
            {!m.op && <p className="-mt-1 text-[12px] leading-4 text-muted-foreground">{t('catalog.hint.statusNeedsOp')}</p>}
            {m.status && m.op && (
              <>
                <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-start gap-2">
                  <SelectField
                    ariaLabel={t('catalog.field.where')}
                    control={{ id: 'status-in', ...(disabled ? { disabled } : {}) }}
                    value={m.statusIn}
                    onChange={(v) => set('statusIn', v)}
                    options={STATUS_PLACES.map((x) => ({ value: x, label: t(`catalog.place.${x}`) }))}
                  />
                  <RowInput label={t('catalog.field.statusPath')} value={m.statusPath} error={fe('statusPath')} disabled={disabled} mono onChange={(v) => set('statusPath', v)} />
                </div>
                <p className="text-[12px] leading-4 text-muted-foreground">{t('catalog.hint.statusMap', { type: opType?.name ?? m.op })}</p>
                {fe('statusMap') && <p className="text-[12px] text-danger">{fe('statusMap')}</p>}
                {m.statusMap.map((r, i) => (
                  <div key={r.key} className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_2rem] items-start gap-2" data-testid="status-map-row">
                    <RowInput
                      label={t('catalog.field.recordValue')}
                      value={r.from}
                      error={fe(`statusMap.${i}.from`)}
                      disabled={disabled}
                      mono
                      onChange={(v) => set('statusMap', m.statusMap.map((x, j) => (j === i ? { ...x, from: v } : x)))}
                    />
                    <ArrowRight aria-hidden className="mt-2 size-4 shrink-0 text-muted-foreground" />
                    <div className="flex min-w-0 flex-col gap-1">
                      <SelectField
                        ariaLabel={t('catalog.field.typeStatus')}
                        control={{ id: `${r.key}-to`, ...(fe(`statusMap.${i}.to`) ? { 'aria-invalid': true } : {}), ...(disabled ? { disabled } : {}) }}
                        value={r.to}
                        onChange={(v) => set('statusMap', m.statusMap.map((x, j) => (j === i ? { ...x, to: v } : x)))}
                        options={(opType?.statuses ?? []).map((x) => ({ value: x.value, label: `${x.value} · ${x.name}` }))}
                        placeholder={t('catalog.form.chooseStatus')}
                      />
                      {fe(`statusMap.${i}.to`) && <span className="text-[12px] leading-4 text-danger">{fe(`statusMap.${i}.to`)}</span>}
                    </div>
                    <RemoveButton label={t('catalog.form.removeMap')} disabled={disabled} onClick={() => set('statusMap', m.statusMap.filter((_, j) => j !== i))} />
                  </div>
                ))}
                {!disabled && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="self-start text-primary"
                    onClick={() => set('statusMap', [...m.statusMap, { key: newFieldKey(), from: '', to: '' }])}
                  >
                    <Plus aria-hidden />
                    {t('catalog.form.addMap')}
                  </Button>
                )}
              </>
            )}
          </div>
        )}
      </section>

      <FormFooter
        project={project}
        kind="method"
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

/** Откуда берётся список типов. Ссылка — в новой вкладке: заполненная форма остаётся на месте, при возврате список свежий. */
function TypesHint({ project, text, warning, testId, className }: { project: string; text: string; warning: boolean; testId: string; className?: string }) {
  const { t } = useTranslation();
  return (
    <p className={cn('text-[12px] leading-4', warning ? 'text-warning' : 'text-muted-foreground', className)} data-testid={testId}>
      {text}{' '}
      <Link to={catalogPath(project, 'ids')} target="_blank" className="text-primary underline underline-offset-2">
        {quoted(t('catalog.section.ids'))}
      </Link>
      .
    </p>
  );
}

/** Поле в строке таблицы формы: подпись только для чтения с экрана, ошибка под полем. */
export function RowInput({
  label,
  value,
  error,
  disabled,
  mono,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  error: string | null;
  disabled: boolean;
  mono?: boolean;
  placeholder?: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Input
        aria-label={label}
        aria-invalid={error ? true : undefined}
        value={value}
        disabled={disabled}
        placeholder={placeholder ?? label}
        spellCheck={false}
        className={cn(mono && 'font-mono text-[13px]')}
        onChange={(e) => onChange(e.target.value)}
      />
      {error && <span className="text-[12px] leading-4 text-danger">{error}</span>}
    </div>
  );
}

export function RemoveButton({ label, disabled, onClick }: { label: string; disabled: boolean; onClick: () => void }) {
  if (disabled) return <span />;
  return (
    <Button type="button" variant="ghost" size="icon" className="text-muted-foreground hover:text-danger" aria-label={label} onClick={onClick}>
      <Trash2 aria-hidden />
    </Button>
  );
}
