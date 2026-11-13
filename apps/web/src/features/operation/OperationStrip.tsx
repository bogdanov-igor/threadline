// Строка операции над результатами поиска по id операции. Ключи операции берутся из записей первого найденного
// запроса в памяти задания: к хранилищу запросов нет. Значение не оказалось id операции или скрыто маскированием: строки нет.
import type { SearchState } from '@threadline/core/search';
import { useQuery } from '@tanstack/react-query';
import { Link2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button.tsx';
import { searchKeys } from '@/features/search/queries.ts';
import { useJobSource, useShareMode } from '@/features/share/mode.ts';
import type { Selection } from '@/lib/selection.ts';
import { chooseOperation, operationKeyOfTerm, operationPath } from './model.ts';

export function OperationStrip({ state, selection }: { state: SearchState; selection: Selection }) {
  const { t } = useTranslation();
  const share = useShareMode();
  const source = useJobSource();
  const first = state.requests[0];
  const cid = first?.correlationId ?? '';
  // Поиск по нескольким средам: операция первой строки в её среде, число — запросы этой среды.
  const rowEnv = first?.env;
  const detail = useQuery({
    queryKey: searchKeys.request(state.id, cid, rowEnv),
    queryFn: ({ signal }) => source.request(state.id, cid, signal, rowEnv),
    enabled: !!cid && !share,
    staleTime: Infinity,
    retry: false,
  });
  const term = state.terms[0]?.display ?? '';
  const key = operationKeyOfTerm(detail.data?.operationKeys, term);
  if (!key || !first || share) return null;
  const also = chooseOperation(detail.data?.operationKeys ?? [])?.also.filter((x) => x.type !== key.type) ?? [];
  const { project, env, stand } = selection;
  const count = rowEnv ? state.requests.filter((r) => r.env === rowEnv).length : state.requests.length;
  return (
    <div className="flex min-w-0 items-center gap-2.5 rounded-[10px] bg-sub px-3.5 py-2.5 text-[13px]" data-testid="operation-strip">
      <Link2 className="size-4 shrink-0 text-foreground-2" aria-hidden />
      <span className="min-w-0 flex-1 truncate">{t('operation.strip.text', { name: key.name ?? key.type, count })}</span>
      <Button asChild variant="secondary">
        <Link to={operationPath(project.id, rowEnv ?? env.id, rowEnv ? undefined : stand, { type: key.type, value: key.value, atMs: first.firstMs, also })}>{t('operation.open')}</Link>
      </Button>
    </div>
  );
}
