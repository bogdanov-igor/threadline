// Блок «Что случилось» на странице операции. Одно-два предложения вверху страницы со ссылкой на запрос.
// Записи читаются из задания операции, только у одного запроса и после конца поиска: таблица блок не ждёт, к хранилищу запросов нет.
import type { OperationView } from '@threadline/core/flow';
import { buildTrace } from '@threadline/core/search';
import { useQuery } from '@tanstack/react-query';
import { CircleCheck, CircleX, Info, RotateCcw } from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useAccess } from '@/features/auth/access.tsx';
import { briefReason } from '@/features/catalog/names.ts';
import { reasonWhere, recordReasons, rootReason } from '@/features/request/reasons.ts';
import { operationsByTarget } from '@/features/request/trace-model.ts';
import { WhatToDo } from '@/features/request/WhatToDo.tsx';
import { searchKeys } from '@/features/search/queries.ts';
import { useJobSource, useShareMode } from '@/features/share/mode.ts';
import { masked } from '@/features/share/ticket.ts';
import { SupportContactSlot } from '@/features/tools/slot.tsx';
import { useView } from '@/features/view/context.tsx';
import type { Selection } from '@/lib/selection.ts';
import { cn } from '@/lib/utils.ts';
import { flowKey, flowTarget, positionOf, type OperationLinkState, type SummaryPlan } from './model.ts';

const statusName = (s: { name: string | null; raw: string; value: string }) => s.name ?? (s.raw || s.value);

export function OperationSummary({
  plan,
  op,
  jobId,
  selection,
  link,
  done,
}: {
  plan: SummaryPlan;
  op: OperationView;
  /** Задание операции, на странице ссылки — сама ссылка. */
  jobId: string;
  selection: Selection;
  link: OperationLinkState;
  done: boolean;
}) {
  const { t, i18n } = useTranslation();
  const share = useShareMode();
  const source = useJobSource();
  const brief = useView().mode === 'brief';
  const restricted = !useAccess().can('details');
  const flow = plan.flow;
  const reads = done && plan.kind === 'reason';
  // Тот же ключ, что у страницы запроса: переход на неё и раскрытие строки записи заново не читают.
  const detail = useQuery({
    queryKey: searchKeys.request(jobId, flow?.cid ?? ''),
    queryFn: ({ signal }) => source.request(jobId, flow!.cid, signal),
    enabled: reads,
    staleTime: Infinity,
    retry: false,
  });
  const details = reads ? detail.data : undefined;
  const reason = useMemo(() => {
    if (!details || !flow) return null;
    // В сегменте только его записи: причины сводки относятся ко всему correlation_id.
    const records = flow.segment === null ? details.records : details.records.filter((r) => r.timeMs >= flow.firstMs && r.timeMs <= flow.lastMs);
    const root = rootReason(flow.segment === null ? details.summary.reasons : recordReasons(records, restricted));
    if (!root) return null;
    const v = root.view;
    const operation = (v.target && operationsByTarget(buildTrace(records), new Map(records.map((r) => [r.id, r]))).get(v.target)) || null;
    const short = brief ? briefReason(v, operation) : null;
    return {
      message: masked(short ? short.message : v.message),
      where: masked(reasonWhere(v, operation, brief)),
      codes: short ? [] : v.codes.map(masked),
      hint: masked(short ? short.title : v.raw),
      action: root.action && !root.undescribed ? masked(root.action) : null,
      undescribed: root.undescribed,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- общие слова причины на языке интерфейса
  }, [details, flow, brief, restricted, i18n.language]);

  // Сообщение о причине ещё не готово: поиск идёт или записи читаются. Спокойная строка и строка статуса чтения не ждут.
  const reserved = plan.kind === 'reason' || plan.kind === 'shared';
  const waiting = reserved && (!done || (plan.kind === 'reason' && detail.isPending));
  const failure = !waiting && plan.lead === 'failure';
  const position = flow ? positionOf(op, flowKey(flow)) : null;
  const target = flow && flowTarget(share, selection, link, flow);
  const at = target && position && (
    <Link to={target.to} state={target.state} data-testid="operation-summary-link" className="font-medium text-primary underline underline-offset-2">
      {t('operation.summary.at', { index: position.index, total: position.total })}
    </Link>
  );
  const name = op.key.name ?? op.key.type;
  const lead = <span className="font-semibold text-foreground">{t(`operation.summary.lead.${plan.lead}`, { name })}</span>;

  let body: ReactNode;
  if (waiting) {
    body = (
      <p className="inline-flex min-w-0 items-center gap-2 text-muted-foreground" aria-live="polite" data-testid="operation-summary-loading">
        <RotateCcw className="size-3.5 shrink-0 animate-spin" aria-hidden />
        {t('operation.summary.loading')}
      </p>
    );
  } else if (plan.kind === 'calm') {
    body = (
      <Sentence icon={<CircleCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />}>
        {lead} {t('operation.summary.calm', { count: plan.failed })} {at}.
      </Sentence>
    );
  } else if (plan.kind === 'status') {
    body = (
      <Sentence icon={<CircleX className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />}>
        {lead} {at ? <>{t('operation.summary.status', { status: statusName(plan.status) })} {at}</> : t('operation.summary.statusOnly', { status: statusName(plan.status) })}.
      </Sentence>
    );
  } else {
    const icon = failure ? <CircleX className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden /> : <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />;
    if (plan.kind === 'shared') {
      body = (
        <Sentence icon={icon}>
          {lead} {t('operation.summary.noStep')} {at}: {t('operation.row.ops', { count: plan.flow.ops })}, {t('operation.summary.sharedNote')}.
        </Sentence>
      );
    } else if (reason) {
      body = (
        <>
          <Sentence icon={icon} hint={reason.hint}>
            {lead} {reason.where ? t('operation.summary.step', { step: reason.where }) : t('operation.summary.noStep')} {at}: <span className="font-medium text-foreground">{reason.message}</span>
            {reason.codes.length > 0 && <span className="text-[12px] text-foreground-2"> · {reason.codes.join(' · ')}</span>}
          </Sentence>
          {reason.action && <WhatToDo text={reason.action} />}
          {reason.undescribed && (
            <div className="mt-1 flex max-h-10 min-w-0 flex-wrap items-center gap-x-3 overflow-hidden pl-6">
              <p className="min-w-0 text-foreground" data-testid="reasons-undescribed">
                {t('request.undescribed')}
              </p>
              {/* Маршрут контакта закрыт без входа: со страницы ссылки его ответ увёл бы на вход. */}
              {!share && <SupportContactSlot />}
            </div>
          )}
        </>
      );
    } else {
      // Сбой чтения или сводка без причин: итог и дорога к запросу, логи заново не читаются.
      body = (
        <Sentence icon={icon}>
          {lead} {t('operation.summary.details')} {at}.
        </Sentence>
      );
    }
  }

  // Короткая строка не ниже заготовки, которая держала место блока, пока шёл поиск (OperationBody): min-h-10.
  return (
    <section
      aria-labelledby="operation-summary-title"
      aria-busy={waiting || undefined}
      data-testid="operation-summary"
      data-kind={plan.kind}
      data-lead={plan.lead}
      data-state={waiting ? 'loading' : reason ? 'reason' : 'plain'}
      className={cn('-mt-2 flex min-h-10 min-w-0 flex-col justify-center rounded-[12px] px-4 py-2.5 text-[13px] leading-5', failure ? 'bg-danger-bg' : 'bg-muted/50', reserved && 'min-h-[104px]')}
    >
      <h2 id="operation-summary-title" className="sr-only">
        {t('operation.summary.title')}
      </h2>
      {body}
    </section>
  );
}

/** Два предложения не больше двух строк: высота блока постоянна, полный текст в подсказке. */
function Sentence({ icon, hint, children }: { icon: ReactNode; hint?: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-start gap-2">
      {icon}
      <p className="line-clamp-2 min-w-0 [overflow-wrap:anywhere] text-foreground" title={hint} data-testid="operation-summary-text">
        {children}
      </p>
    </div>
  );
}
