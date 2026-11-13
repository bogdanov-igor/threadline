// Блок «Итог» в подробностях шага: итог по справочнику,
// название, источник, текст и «что делать», исходные код и текст, операция и статус, действия справочника.
import type { TraceStep, ViewRecord } from '@threadline/core/search';
import { CircleCheck, CircleX, Clock, Pencil, Plus, Scale, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button.tsx';
import { useShareMode } from '@/features/share/mode.ts';
import { cn } from '@/lib/utils.ts';
import { EditorProvider, useEditor } from './editor.tsx';
import { kindLabelKey, stepVerdict, type StepCatalog, type StepVerdict } from './names.ts';
import { stepActions } from './prefill.ts';
import { useCatalogState } from './queries.ts';

/**
 * Итог шага для блока: по правилу итога, по отметке «не ошибка», иначе по признакам шага.
 * У входа своего итога в логах нет: те же слова, что на его узле, итог всего запроса.
 */
export function displayVerdict(step: TraceStep, c: StepCatalog, requestStatus?: 'error' | 'success'): StepVerdict {
  const v = stepVerdict(step, c);
  if (v) return v;
  if (step.noResponse) return step.pending ? 'pending' : 'error';
  if (requestStatus && step.kind === 'incoming' && step.parentId === null) return requestStatus;
  return step.isError ? 'error' : 'success';
}

const VERDICT: Record<StepVerdict, { icon: LucideIcon; color: string }> = {
  success: { icon: CircleCheck, color: 'text-success' },
  ignored: { icon: CircleCheck, color: 'text-muted-foreground' },
  pending: { icon: Clock, color: 'text-muted-foreground' },
  error: { icon: CircleX, color: 'text-danger' },
};

type StepOutcomeProps = {
  project: string;
  step: TraceStep;
  catalog: StepCatalog | null;
  records: readonly ViewRecord[];
  /** «Кратко»: без кодов, исходных значений и действий справочника. */
  brief?: boolean;
  /** Строка итога шага: кнопки справочника стоят в ней справа и не выходят за панель при любой длине причины. */
  line?: ReactNode;
  /** Итог всего запроса: у входа нет своего. */
  requestStatus?: 'error' | 'success' | undefined;
};

export function StepOutcome(props: StepOutcomeProps) {
  // Страница ссылки только читает: действий справочника нет, и опроса его состояния тоже.
  if (useShareMode()) {
    const { step, catalog: c, records, brief = false, line, requestStatus } = props;
    return c ? <OutcomeBlock step={step} c={c} records={records} editable={false} brief={brief} line={line} requestStatus={requestStatus} /> : line;
  }
  return <EditableOutcome {...props} />;
}

function EditableOutcome({ project, step, catalog: c, records, brief = false, line, requestStatus }: StepOutcomeProps) {
  const state = useCatalogState();
  if (!c) return line;
  const editable = state.data?.state === 'ok' && !brief;
  return (
    <EditorProvider project={project} readOnly={!editable}>
      <OutcomeBlock step={step} c={c} records={records} editable={editable} brief={brief} line={line} requestStatus={requestStatus} />
    </EditorProvider>
  );
}

function OutcomeBlock({ step, c, records, editable, brief, line, requestStatus }: { step: TraceStep; c: StepCatalog; records: readonly ViewRecord[]; editable: boolean; brief: boolean; line?: ReactNode; requestStatus?: 'error' | 'success' | undefined }) {
  const { t } = useTranslation();
  const { open, canEdit } = useEditor();
  const verdict = displayVerdict(step, c, requestStatus);
  const { icon: Icon, color } = VERDICT[verdict];
  const source = c.error?.source ?? c.name?.source ?? 'unknown';
  const name = [c.name?.system?.name, c.name?.method?.name].filter(Boolean).join(' · ');
  const byRule = c.outcome && !brief ? t(`catalog.verdict.byRule.${c.outcome.rule.level}`) : null;
  // У Бизнеса правила в ответе нет, заголовок ошибки только из справочника.
  const text = c.outcome?.text ?? c.error?.title ?? null;
  const action = c.outcome?.action ?? c.error?.action ?? null;
  const raw = c.error?.raw ?? null;
  const rawText = raw ? (brief ? (raw.text ?? '') : [raw.http !== null ? `HTTP ${raw.http}` : null, raw.code, raw.text].filter(Boolean).join(' · ')) : '';
  const partner = brief ? null : (c.error?.partnerCode ?? null);
  const http = c.outcome && step.status !== null && !brief ? `HTTP ${step.status}` : null;
  const method = c.name?.method ?? null;
  const op = method?.opType
    ? [t(kindLabelKey(method.kind, c.name?.source === 'project' ? 'project' : 'external')), method.opType.name, c.status ? (c.status.name ?? c.status.value) : null].filter(Boolean).join(' · ')
    : null;
  const actions = editable ? stepActions(step, c, records, canEdit) : { add: null, edit: null, rule: null };

  const hasActions = actions.add || actions.edit || actions.rule;
  const facts = [rawText ? `${t('catalog.step.raw')}: ${rawText}` : null, partner ? t('catalog.step.partner', { code: partner }) : null].filter(Boolean).join(' · ');

  return (
    <section className="flex min-w-0 flex-col gap-1 text-[12px] leading-4" aria-label={t('catalog.step.title')} data-testid="step-catalog" data-verdict={verdict} data-source={source}>
      {/* Итог, длительность и кнопки справочника. Метка итога обрезается, кнопки не сжимаются. */}
      {(line || hasActions) && (
        // Узкой панели не хватает места на причину и кнопку рядом: кнопка уходит на следующую строку, причина не сжимается до буквы.
        <div className="flex min-h-7 min-w-0 flex-wrap items-center justify-end gap-x-2">
          <div className="min-w-0 flex-[1_1_12rem]">{line}</div>
          {hasActions && (
            <div className="flex shrink-0 items-center gap-1">
              {actions.add && (
                <Button size="sm" variant="ghost" className="h-7 px-2 text-[12.5px]" onClick={() => open(actions.add!)} data-testid="step-catalog-add">
                  <Plus aria-hidden />
                  {t('catalog.addToCatalog')}
                </Button>
              )}
              {actions.edit && (
                <Button size="sm" variant="ghost" className="h-7 px-2 text-[12.5px]" onClick={() => open(actions.edit!)} data-testid="step-catalog-edit">
                  <Pencil aria-hidden />
                  {t('catalog.editInCatalog')}
                </Button>
              )}
              {actions.rule && (
                <Button size="sm" variant="ghost" className="h-7 w-7 px-0 text-primary" onClick={() => open(actions.rule!.target)} title={actions.rule.edit ? t('catalog.step.editRule') : t('catalog.step.addRule')} data-testid="step-catalog-rule">
                  <Scale aria-hidden />
                  <span className="sr-only">{actions.rule.edit ? t('catalog.step.editRule') : t('catalog.step.addRule')}</span>
                </Button>
              )}
            </div>
          )}
        </div>
      )}
      {/* Что известно об итоге — одной тихой строкой, полный текст в подсказке. */}
      <p className="min-w-0 truncate text-muted-foreground" title={[t(`catalog.verdict.${verdict}`), byRule, http, name, op, rawText, partner].filter(Boolean).join(' · ')}>
        <Icon className={cn('mr-1 inline size-3.5 align-[-3px]', color)} aria-hidden />
        <span className={cn('font-medium', color)} data-testid="step-verdict">
          {t(`catalog.verdict.${verdict}`)}
        </span>
        {byRule && <span> · {byRule}</span>}
        {http && <span className="tabular"> · {http}</span>}
        <span data-testid="step-source"> · {t('catalog.sourceLabel', { source: t(`catalog.source.${source}`) })}</span>
        {name && (
          <span>
            {' · '}
            <span className="font-medium text-foreground" data-testid="step-name">
              {name}
            </span>
          </span>
        )}
        {op && (
          <span title={!brief && c.status && c.status.value !== c.status.raw ? `${op} (${c.status.raw})` : op}>
            {' · '}
            <span data-testid="step-operation">{op}</span>
          </span>
        )}
        {facts && (
          <span>
            {' · '}
            <span title={rawText} data-testid="step-raw">
              {facts}
            </span>
          </span>
        )}
      </p>
      {text && (
        <p className={cn('line-clamp-2 min-w-0 text-[12.5px] leading-[18px] break-words', verdict === 'error' ? 'text-danger' : 'text-foreground')} title={text} data-testid="step-catalog-text">
          {text}
        </p>
      )}
      {action && (
        <p className="line-clamp-2 min-w-0 text-[12.5px] leading-[18px] break-words text-foreground" title={action} data-testid="step-action">
          <span className="text-muted-foreground">{t('catalog.step.action')}: </span>
          {action}
        </p>
      )}
    </section>
  );
}
