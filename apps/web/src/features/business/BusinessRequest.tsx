// Экран запроса для роли «Бизнес»: за 5 секунд видно, прошла ли операция, где сломалась, что это значит и кому передать.
// Строится только из ответа по списку полей.
import { buildTrace, type RequestDetail, type ViewRecord } from '@threadline/core/search';
import { ChevronDown, CircleAlert, CircleCheck, Clock, Info } from 'lucide-react';
import { useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { TimeWithZone } from '@/components/shell/TimeWithZone.tsx';
import { Chip, StatusChip } from '@/components/ui/chip.tsx';
import { Tooltip } from '@/components/ui/tooltip.tsx';
import { briefReason, entryName } from '@/features/catalog/names.ts';
import { OperationButton } from '@/features/operation/OperationButton.tsx';
import { firstReasonText, requestShare } from '@/features/request/RequestPage.tsx';
import { MAX_REASON_ROWS } from '@/features/request/reasons.ts';
import { ShareSlot, type ShareButtonProps } from '@/features/share/slot.tsx';
import { SupportContactSlot } from '@/features/tools/slot.tsx';
import { formatDuration, numberFormat, timeParts } from '@/lib/format.ts';
import { useHotkey } from '@/lib/hotkeys.ts';
import type { Selection } from '@/lib/selection.ts';
import { cn } from '@/lib/utils.ts';
import { businessModel, type BusinessModel, type BusinessState, type BusinessStep, type StepTone } from './model.ts';
import { BUSINESS_GRID, BUSINESS_PAGE } from './slot.tsx';

export interface BusinessRequestProps {
  data: RequestDetail;
  selection: Selection;
  /** Ссылка назад и соседние результаты. */
  back: ReactNode;
}

const DOT: Record<StepTone, string> = {
  ok: 'bg-success-bg text-success',
  error: 'bg-danger-bg text-danger',
  'no-answer': 'bg-danger-bg text-danger',
  pending: 'border-[1.5px] border-dashed border-input text-muted-foreground',
};
const WORD: Record<StepTone, string> = { ok: 'text-success', error: 'text-danger', 'no-answer': 'text-danger', pending: 'text-muted-foreground' };

/** Короткая длительность: одна цифра после запятой без лишнего нуля, «0,2 с», «1,1 с», «20 с». Короче 0,1 с и от минуты общий формат. */
function shortDuration(ms: number, t: TFunction): string {
  if (ms < 100 || ms >= 59_950) return formatDuration(ms);
  return t('units.s', { value: numberFormat({ maximumFractionDigits: 1 }).format(Math.round(ms / 100) / 10) });
}

function StepRow({ step: s, startMs, timeZone, incomplete }: { step: BusinessStep; startMs: number; timeZone: string; /** Записи дочитаны не полностью: ответ не «ждём», а «не прочитан». */ incomplete: boolean }) {
  const { t } = useTranslation();
  const failed = s.tone === 'error' || s.tone === 'no-answer';
  const word = s.word ?? (s.tone === 'ok' ? t('business.step.ok') : s.tone === 'error' ? t('business.step.failed') : s.tone === 'no-answer' ? t('business.step.noAnswer') : t(incomplete ? 'business.step.unread' : 'business.step.pending'));
  const time = timeParts(startMs + s.startMs, timeZone).time.slice(0, 8);
  const spent = s.waitedMs !== null ? t('business.step.waited', { duration: shortDuration(s.waitedMs, t) }) : s.tone !== 'no-answer' && s.durationMs !== null ? shortDuration(s.durationMs, t) : null;
  return (
    <li
      tabIndex={-1}
      data-testid="business-step"
      data-tone={s.tone}
      className="grid scroll-my-3 grid-cols-[28px_minmax(0,1fr)] gap-x-3.5 gap-y-1 py-[11px] not-first:border-t not-first:border-border focus-visible:rounded-[8px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring lg:grid-cols-[28px_minmax(0,1fr)_fit-content(45%)]"
    >
      <span className={cn('flex size-7 items-center justify-center rounded-full text-[12px] font-semibold', DOT[s.tone])} aria-hidden>
        {s.tone === 'ok' ? <CircleCheck className="size-3.5" /> : s.tone === 'error' ? <CircleAlert className="size-3.5" /> : <Clock className="size-3.5" />}
      </span>
      <div className="min-w-0">
        <div className={cn('text-[14px] leading-5 font-semibold [overflow-wrap:anywhere]', failed ? 'text-danger' : 'text-foreground')} data-testid="business-step-name">
          {s.index}. {s.name ?? t('business.step.internal')}
        </div>
        {s.detail && <div className="mt-0.5 text-[13px] leading-[18px] [overflow-wrap:anywhere] text-muted-foreground">{s.detail}</div>}
      </div>
      <div className="col-start-2 flex min-w-0 flex-wrap items-baseline gap-x-2 lg:col-start-auto lg:block lg:text-right">
        {word && <div className={cn('text-[13px] leading-5 font-semibold [overflow-wrap:anywhere]', WORD[s.tone])}>{word}</div>}
        <div className="tabular text-[12.5px] leading-5 whitespace-nowrap text-muted-foreground lg:mt-0.5">{spent ? `${time} · ${spent}` : time}</div>
      </div>
    </li>
  );
}

/** Статус словами экрана: пока итога нет, «Успешно» на экране и в тикете было бы неправдой. */
const statusWord = (state: BusinessState, status: 'error' | 'success', t: TFunction): string => (state === 'pending' || state === 'unread' ? t(`business.status.${state}`) : t(`requests.status.${status}`));

const STATUS_ICON = { error: CircleAlert, success: CircleCheck } as const;

/** Статус в шапке: без подсказки о правилах итога, она для технических ролей. */
function BusinessStatus({ state, status }: { state: BusinessState; status: 'error' | 'success' }) {
  const { t } = useTranslation();
  const waiting = state === 'pending' || state === 'unread';
  const Icon = waiting ? Clock : STATUS_ICON[status];
  return (
    <StatusChip tone={waiting ? 'neutral' : status === 'error' ? 'danger' : 'success'} data-status={waiting ? state : status}>
      <Icon aria-hidden />
      {statusWord(state, status, t)}
    </StatusChip>
  );
}

function whatTitle(m: BusinessModel, t: TFunction): string {
  const step = m.failed && !m.failed.entry ? (m.failed.name ?? t('business.step.internal')) : null;
  if (m.state === 'known' && m.reason) return m.reason.message;
  if (m.state === 'no-answer') {
    if (m.reason?.named) return m.reason.message;
    return m.failed?.system ? t('business.what.noAnswer', { system: m.failed.system }) : t('business.what.noAnswerAny');
  }
  if (step) return t('business.what.failed', { step });
  return m.reason?.message ?? t('business.what.error');
}

/** Блок «Что случилось»: заголовок, что известно, что делать, строка о передаче ссылки. */
function WhatHappened({ model: m, share }: { model: BusinessModel; share: ShareButtonProps }) {
  const { t } = useTranslation();
  const listId = useId();
  const [allShown, setAllShown] = useState(false);
  const step = m.failed ? (m.failed.name ?? t('business.step.internal')) : null;
  const words = m.reason ? briefReason(m.reason) : null;
  const facts: string[] = [];
  if (m.state === 'no-answer' && !m.reason?.named && step && !m.failed?.entry) facts.push(m.failed?.waitedMs ? t('business.what.waited', { step, duration: shortDuration(m.failed.waitedMs, t) }) : t('business.what.notWaited', { step }));
  if (m.state === 'unknown' && m.previous) facts.push(t('business.what.previous', { step: m.previous.name ?? t('business.step.internal') }));
  // Общие слова по виду причины и система. Заголовок уже назвал шаг, а не причину.
  if (m.state === 'unknown' && words && m.failed && !m.failed.entry) facts.push(`${[words.message, words.system].filter(Boolean).join(' · ')}.`);
  const shownOthers = allShown ? m.others : m.others.slice(0, MAX_REASON_ROWS - 1);
  const rest = m.others.slice(MAX_REASON_ROWS - 1).reduce((n, r) => n + r.count, 0);
  return (
    <section aria-label={t('business.what.label')} data-testid="request-reasons" className="grid grid-cols-[20px_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-[12px] bg-danger-bg px-4 py-3.5 text-[14px] leading-[21px] text-foreground lg:px-[18px]">
      <CircleAlert className="mt-[3px] size-3.5 text-danger" aria-hidden />
      <h2 className="min-w-0 font-semibold [overflow-wrap:anywhere]" data-testid="request-what-title">
        {whatTitle(m, t)}
      </h2>
      {facts.length > 0 && <p className="col-start-2 min-w-0 [overflow-wrap:anywhere]">{facts.join(' ')}</p>}
      {m.action && (
        <p className="col-start-2 min-w-0 [overflow-wrap:anywhere]" data-testid="reason-action">
          <b className="font-semibold">{t('catalog.step.action')}:</b> {m.action}
        </p>
      )}
      {shownOthers.length > 0 && (
        <ul id={listId} className="col-start-2 flex min-w-0 flex-col gap-0.5 text-[13px] leading-5 text-foreground-2">
          {shownOthers.map(({ view, count }, i) => {
            const short = briefReason(view);
            return (
              <li key={i} className="[overflow-wrap:anywhere]" data-testid="reason-other">
                {[short.message, short.system].filter(Boolean).join(' · ')}
                {count > 1 && <span className="tabular"> ×{count}</span>}
              </li>
            );
          })}
        </ul>
      )}
      {rest > 0 && (
        <button type="button" aria-expanded={allShown} aria-controls={listId} className="col-start-2 flex w-fit items-center gap-1 text-left text-[13px] text-foreground-2 underline-offset-2 hover:underline" data-testid="reasons-more" onClick={() => setAllShown(!allShown)}>
          <ChevronDown className={cn('size-3.5 shrink-0 transition-transform', allShown && 'rotate-180')} aria-hidden />
          {allShown ? t('request.whatLess') : t('request.moreReasons', { count: rest })}
        </button>
      )}
      {m.undescribed && (
        <>
          <p className="col-start-2 min-w-0 [overflow-wrap:anywhere]" data-testid="reasons-undescribed">
            {t('request.undescribed')}
          </p>
          {!share.target && <p className="col-start-2 min-w-0 [overflow-wrap:anywhere]">{t('business.what.noLink')}</p>}
          <div className="col-start-2 mt-2 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
            <ShareSlot {...share} primary labelled />
            <SupportContactSlot />
          </div>
        </>
      )}
    </section>
  );
}

/** Ждём ответа: это не ошибка, блок спокойный. При неполных записях ждать нечего: предел чтения от времени не меняется. */
function Waiting({ model: m }: { model: BusinessModel }) {
  const { t } = useTranslation();
  const waiting = m.steps.find((x) => x.tone === 'pending');
  const step = waiting ? (waiting.name ?? t('business.step.internal')) : null;
  const unread = m.state === 'unread';
  return (
    <section aria-label={t('business.what.label')} data-testid="request-reasons" className="grid grid-cols-[20px_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-[12px] bg-muted/50 px-4 py-3.5 text-[14px] leading-[21px] text-foreground lg:px-[18px]">
      <Info className="mt-[3px] size-3.5 text-muted-foreground" aria-hidden />
      <h2 className="min-w-0 font-semibold [overflow-wrap:anywhere]" data-testid="request-what-title">
        {step ? t(unread ? 'business.what.unread' : 'business.what.pending', { step }) : t(unread ? 'business.what.unreadAny' : 'business.what.pendingAny')}
      </h2>
      <p className="col-start-2 min-w-0">{t(unread ? 'business.what.unreadText' : 'business.what.pendingText')}</p>
    </section>
  );
}

/** Строка итога под сведениями: что сказать, не выдумывая запланированные шаги. Их в ответе нет. */
function sideNote(m: BusinessModel, incomplete: boolean, t: TFunction): string {
  if (m.state === 'ok') return t('business.side.okNote');
  if (m.state === 'pending') return t('business.side.pendingNote');
  if (m.state === 'unread') return t('business.side.unreadNote');
  if (m.state === 'unknown') return t('business.side.unknownNote');
  // Номер шага с ошибкой уже в строке «Шаги» над этой подписью.
  const head = m.state === 'no-answer' ? t('business.side.noAnswerNote') : '';
  const tail = !m.failed ? '' : !m.lastStep ? t('business.side.continued') : incomplete ? '' : t('business.side.stopped');
  return [head, tail].filter(Boolean).join(' ');
}

export function BusinessRequest({ data, selection, back }: BusinessRequestProps) {
  const { t, i18n } = useTranslation();
  const s = data.summary;
  const { project } = selection;
  const trace = useMemo(() => buildTrace(data.records), [data.records]);
  const byId = useMemo(() => new Map<string, ViewRecord>(data.records.map((r) => [r.id, r])), [data.records]);
  const name = s.incoming ? entryName(s) : null;
  // Пути в заголовке нет: он технический, а строчное слово в нём по форме от значения не отличить. Названия даёт справочник.
  const title = name ?? t(s.incoming ? 'business.noName' : 'request.backgroundTitle');
  // eslint-disable-next-line react-hooks/exhaustive-deps -- общие слова причин и подписи систем на языке интерфейса
  const model = useMemo(() => businessModel(s, trace, byId, title), [s, trace, byId, title, i18n.language]);
  const startMs = trace.startTimeMs || s.firstMs;
  const iso = new Date(startMs).toISOString();
  // ID на этом экране нет ни в каком виде: ни пункта меню, ни строки в тексте для тикета. Статус и причина в тикете теми же словами, что на экране.
  const share = useMemo<ShareButtonProps>(() => {
    const props = requestShare(t, s, selection, { title, atMs: startMs, reason: firstReasonText(s, trace, byId, true) });
    return { ...props, ticket: { ...props.ticket, title: `${title} · ${statusWord(model.state, s.status, t)}`, reason: model.failed || model.reason ? whatTitle(model, t) : null, requestId: null } };
  }, [t, s, selection, title, startMs, trace, byId, model]);

  // J и K: соседний шаг. Панели шага здесь нет, поэтому клавиши только ставят на шаг фокус; первое нажатие ведёт к шагу с ошибкой.
  const list = useRef<HTMLOListElement>(null);
  const move = (delta: 1 | -1) => () => {
    const rows = [...(list.current?.querySelectorAll<HTMLElement>('[data-testid="business-step"]') ?? [])];
    const at = rows.findIndex((row) => row === document.activeElement);
    const start = model.failed ? model.steps.indexOf(model.failed) : 0;
    rows[at < 0 ? start : Math.max(0, Math.min(rows.length - 1, at + delta))]?.focus();
  };
  const hasSteps = model.steps.length > 0;
  const note = sideNote(model, s.incomplete, t);
  useHotkey('next', hasSteps ? move(1) : null);
  useHotkey('prev', hasSteps ? move(-1) : null);

  return (
    <div className={BUSINESS_PAGE} data-testid="request-page" data-business-state={model.state}>
      {back && <div className="flex h-8 min-w-0 items-center [&>*]:mb-0">{back}</div>}
      <header className="flex flex-col gap-1.5" data-testid="request-header">
        <div className="flex min-w-0 items-start gap-4">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2.5 gap-y-1">
            <BusinessStatus state={model.state} status={s.status} />
            <h1 className="min-w-0 text-[20px] leading-7 font-[650] tracking-[-0.01em] [overflow-wrap:anywhere] text-heading lg:text-[22px] lg:leading-[30px]">{name ? <span data-testid="request-name">{name}</span> : title}</h1>
            {s.kind === 'maybe-cached' && (
              <Tooltip content={t('requests.maybeCachedHint')}>
                <Chip>{t('requests.maybeCached')}</Chip>
              </Tooltip>
            )}
            {s.match === 'inexact' && (
              <Tooltip content={t('requests.inexactHint')}>
                <Chip tone="warning">{t('requests.inexact')}</Chip>
              </Tooltip>
            )}
            {s.incomplete && (
              <Tooltip content={t('business.incompleteHint')}>
                <Chip tone="warning">{t('requests.incomplete')}</Chip>
              </Tooltip>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <OperationButton keys={data.operationKeys} selection={selection} atMs={s.firstMs} noId />
            <ShareSlot {...share} labelled />
          </div>
        </div>
        <p className="text-[12px] leading-4 text-muted-foreground" data-testid="request-meta">
          {t('request.start')} <TimeWithZone iso={iso} timeZone={project.timezone} plain /> · {t('business.took', { duration: shortDuration(trace.totalMs, t) })}
        </p>
      </header>

      <div className={BUSINESS_GRID}>
        <div className="flex min-w-0 flex-col gap-4">
          {model.state === 'pending' || model.state === 'unread' ? <Waiting model={model} /> : model.state !== 'ok' && <WhatHappened model={model} share={share} />}
          <section aria-label={t('business.steps.label')} className="min-w-0 rounded-[12px] border border-border px-4 py-1 lg:px-5 lg:py-1.5" data-testid="business-steps">
            {hasSteps ? (
              <ol ref={list}>
                {model.steps.map((step) => (
                  <StepRow key={step.id} step={step} startMs={startMs} timeZone={project.timezone} incomplete={s.incomplete} />
                ))}
              </ol>
            ) : (
              <p className="py-3 text-[13px] text-muted-foreground">{t('trace.empty')}</p>
            )}
            {s.incomplete && <p className="border-t border-border py-2.5 text-[13px] leading-5 text-warning">{t('flow.mark.unread')}</p>}
          </section>
        </div>
        <aside aria-label={t('business.side.label')} className="flex min-w-0 flex-col gap-3 rounded-[12px] border border-border px-4 py-4 lg:px-5" data-testid="business-summary">
          <dl className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-3 gap-y-2.5 text-[13.5px] leading-5">
            <dt className="text-muted-foreground">{t('request.start')}</dt>
            <dd className="min-w-0">
              <TimeWithZone iso={iso} timeZone={project.timezone} plain />
            </dd>
            <dt className="text-muted-foreground">{t('business.side.took')}</dt>
            <dd className="tabular min-w-0 font-semibold" data-testid="request-total">
              {shortDuration(trace.totalMs, t)}
            </dd>
            <dt className="text-muted-foreground">{t('business.side.steps')}</dt>
            <dd className="min-w-0" data-testid="business-steps-count">
              {model.failed ? t('business.side.failedAt', { passed: model.passed, total: model.steps.length, index: model.failed.index }) : t('business.side.passed', { passed: model.passed, total: model.steps.length })}
            </dd>
          </dl>
          {note && (
            <p className="text-[12px] leading-[17px] text-muted-foreground" data-testid="business-note">
              {note}
            </p>
          )}
          {share.target && <p className="border-t border-border pt-3 text-[12px] leading-[17px] text-muted-foreground">{t('business.side.shareNote')}</p>}
          {model.undescribed && <SupportContactSlot label={t('business.side.support', { project: project.name })} className="text-[13px] leading-5 text-foreground-2" />}
        </aside>
      </div>
    </div>
  );
}
