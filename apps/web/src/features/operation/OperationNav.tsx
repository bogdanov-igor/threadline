// Переходы страницы запроса, открытой из операции: «← К операции», «Поток N из M» и соседние
// потоки. Запросы берутся из задания операции: переходы и возврат не читают хранилище, пока задание живо.
import type { OperationView } from '@threadline/core/flow';
import { ArrowLeft, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Tooltip } from '@/components/ui/tooltip.tsx';
import { shareRequestLink, useShareMode } from '@/features/share/mode.ts';
import type { Selection } from '@/lib/selection.ts';
import { cn } from '@/lib/utils.ts';
import { flowKey, flowPath, linkTo, positionOf, type OperationLinkState } from './model.ts';

const STEP = 'flex size-7 items-center justify-center rounded-[8px] text-muted-foreground transition-colors';

/** Соседний поток; у первого и последнего — неактивный значок без ссылки. */
function StepLink({
  to,
  state,
  label,
  back = false,
}: {
  to: string;
  state: unknown;
  label: string;
  back?: boolean;
}) {
  if (!to) {
    return (
      <span aria-hidden className={cn(STEP, 'opacity-40')}>
        <ChevronRight className={cn('size-4', back && 'rotate-180')} />
      </span>
    );
  }
  return (
    <Link
      to={to}
      state={state}
      replace={false}
      aria-label={label}
      className={cn(STEP, 'hover:bg-accent hover:text-accent-foreground')}
    >
      <ChevronRight className={cn('size-4', back && 'rotate-180')} aria-hidden />
    </Link>
  );
}

export function OperationNav({
  link,
  operation,
  cid,
  selection,
}: {
  link: OperationLinkState;
  /** Живое задание операции; null — истекло или ещё не пришло. */
  operation: OperationView | null;
  cid: string;
  selection: Selection;
}) {
  const { t } = useTranslation();
  const share = useShareMode();
  const pos = positionOf(operation, flowKey({ cid, segment: link.operation.segment ?? null }));
  const { project, env, stand } = selection;
  const shared = (f: NonNullable<NonNullable<typeof pos>['prev']>) => shareRequestLink(share!, { cid: f.cid, segment: f.segment, step: f.firstRecordId });
  const to = (f: NonNullable<typeof pos>['prev']) => {
    if (!f) return '';
    return share ? shared(f).to : flowPath(project.id, env.id, stand, f, link.operation.href);
  };
  const stateOf = (f: NonNullable<typeof pos>['prev']) => {
    if (!f) return link;
    return share ? shared(f).state : linkTo(link, f);
  };
  return (
    <nav
      aria-label={t('operation.kicker')}
      className="mb-3 flex h-[30px] items-center gap-1.5"
      data-testid="operation-nav"
    >
      {/* Возврат значком, как «К результатам» в шапке запроса: подпись в подсказке и для чтения с экрана. */}
      <Tooltip content={t('operation.back')}>
        <Link
          to={link.operation.href}
          replace={false}
          aria-label={t('operation.back')}
          className="inline-flex size-[30px] shrink-0 items-center justify-center rounded-[8px] text-foreground-2 transition-colors hover:bg-sunk hover:text-foreground"
        >
          <ArrowLeft className="size-4" aria-hidden />
        </Link>
      </Tooltip>
      {pos && (
        <span className="flex items-center gap-0.5 text-[13px] text-muted-foreground">
          <StepLink to={to(pos.prev)} state={stateOf(pos.prev)} label={t('operation.prev')} back />
          <span className="tabular px-1" data-testid="operation-position">
            {t('operation.position', { index: pos.index, total: pos.total })}
          </span>
          <StepLink to={to(pos.next)} state={stateOf(pos.next)} label={t('operation.next')} />
        </span>
      )}
    </nav>
  );
}
