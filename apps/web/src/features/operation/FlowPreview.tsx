// Раскрытая строка таблицы операции: маленький граф потока и
// «Открыть запрос». Записи берутся из задания операции, к хранилищу запросов нет. Код графа грузит FlowSlot при первом раскрытии.
import type { OperationFlow } from '@threadline/core/flow';
import { buildTrace } from '@threadline/core/search';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, RotateCcw } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';
import { Button } from '@/components/ui/button.tsx';
import { CopyIconButton } from '@/components/ui/copy-button.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { FlowSlot } from '@/features/flow/FlowSlot.tsx';
import { isExpired, searchKeys } from '@/features/search/queries.ts';
import { useJobSource } from '@/features/share/mode.ts';
import { ApiError } from '@/lib/api.ts';
import { shortCid } from '@/lib/format.ts';

const NO_APP = { count: 0, warnings: 0, errors: 0 };
const nothing = () => undefined;

export function FlowPreview({
  flow: f,
  target,
  jobId,
  brief,
}: {
  flow: OperationFlow;
  target: { to: string; state: unknown };
  /** Задание операции, на странице ссылки — сама ссылка. */
  jobId: string;
  brief: boolean;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const source = useJobSource();
  // Тот же ключ, что у страницы запроса: переход на неё данные не читает заново.
  const detail = useQuery({
    queryKey: searchKeys.request(jobId, f.cid),
    queryFn: ({ signal }) => source.request(jobId, f.cid, signal),
    staleTime: Infinity,
    retry: false,
  });
  // В сегменте шаги только его записей: остальные сегменты того же correlation_id стоят своими строками таблицы.
  const records = useMemo(
    () => (f.segment === null ? (detail.data?.records ?? []) : (detail.data?.records ?? []).filter((r) => r.timeMs >= f.firstMs && r.timeMs <= f.lastMs)),
    [detail.data, f.segment, f.firstMs, f.lastMs],
  );
  const trace = useMemo(() => buildTrace(records), [records]);
  // Задания больше нет: повторять нечего, страница запроса прочитает записи по своей ссылке.
  const gone = detail.isError && isExpired(detail.error) && !(detail.error instanceof ApiError && detail.error.code === 'request-not-found');
  const [selected, setSelected] = useState<string | null>(null);
  const open = useCallback(() => void navigate(target.to, { state: target.state }), [navigate, target.to, target.state]);

  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-b-[12px] bg-accent px-3 pt-1 pb-4" data-testid="operation-flow-preview">
      <div className="flex min-h-8 min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        {/* «Открыть запрос» не зависит от загрузки графа: при сбое ссылка работает. */}
        <Button asChild variant="secondary">
          <Link to={target.to} state={target.state} data-testid="operation-open-request">
            {t('operation.preview.open')}
            <ArrowRight aria-hidden />
          </Link>
        </Button>
        {!brief && !f.nocid && (
          <span className="flex min-w-0 items-center gap-0.5">
            <code className="min-w-0 truncate font-mono text-[12px] text-muted-foreground" title={f.cid}>
              {shortCid(f.cid)}
            </code>
            <CopyIconButton text={f.cid} label={t('requests.copyCid', { cid: f.cid })} className="size-6" />
          </span>
        )}
      </div>
      {detail.isPending ? (
        <Skeleton className="h-[200px] w-full rounded-[12px]" data-testid="operation-preview-skeleton" />
      ) : detail.isError ? (
        <div className="flex min-h-14 flex-wrap items-center gap-x-3 gap-y-1 rounded-[12px] bg-card px-4 py-2 text-[13px]" role="alert" data-testid="operation-preview-failed">
          <span className="text-danger">{t(gone ? 'operation.preview.expired' : 'operation.preview.failed')}</span>
          {!gone && (
            <Button variant="secondary" size="sm" onClick={() => void detail.refetch()}>
              <RotateCcw aria-hidden />
              {t('states.retry')}
            </Button>
          )}
        </div>
      ) : trace.steps.length === 0 ? (
        <p className="rounded-[12px] bg-card px-4 py-3 text-[13px] text-muted-foreground">{t('trace.empty')}</p>
      ) : (
        <FlowSlot
          trace={trace}
          records={records}
          incomplete={f.incomplete}
          related={[]}
          app={NO_APP}
          logs={false}
          steps={trace.steps.length}
          selected={selected}
          onSelect={setSelected}
          onOpen={open}
          onTimeline={open}
          onRelated={nothing}
          operationKeys={[]}
          onOperation={nothing}
          className="max-h-[360px]"
        />
      )}
    </div>
  );
}
