import { CircleCheck, CircleDashed, CircleX, TriangleAlert, type LucideIcon } from 'lucide-react';
import { TeapotSlot } from '@/features/extras/slot.tsx';
import { errorParts } from '@/lib/error-text.ts';
import { cn } from '@/lib/utils.ts';
import { formatDuration } from '@/lib/format.ts';
import type { Outcome, OutcomeTone } from './trace-model.ts';

const ICON: Record<OutcomeTone, LucideIcon> = { success: CircleCheck, danger: CircleX, warning: TriangleAlert, neutral: CircleDashed };
const CHIP: Record<OutcomeTone, string> = {
  success: 'bg-success-bg text-success',
  danger: 'bg-danger-bg text-danger',
  warning: 'bg-warning-bg text-warning',
  neutral: 'bg-muted text-muted-foreground',
};

/**
 * Итог шага в одну строку: метка с причиной, HTTP-статус и длительность. Метка обрезается многоточием с полным текстом в подсказке,
 * статус и длительность не сжимаются: кнопки справа остаются в панели при любой длине причины.
 */
export function OutcomeLine({ outcome: o, className }: { outcome: Outcome; className?: string }) {
  // Без своего итога (вход, вызов, лог) строки нет: длительность — в строке о шаге.
  if (!o.label) return null;
  const Icon = ICON[o.tone];
  const { message } = o.tone === 'danger' ? errorParts(o.label) : { message: o.label };
  return (
    <p className={cn('flex min-w-0 items-center gap-2 text-[12.5px] leading-5', className)} data-testid="step-outcome" data-tone={o.tone}>
      <span className={cn('inline-flex h-6 min-w-0 items-center gap-1.5 rounded-[12px] pr-[9px] pl-[7px] font-semibold', CHIP[o.tone])} title={o.label}>
        <Icon className="size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 truncate" data-testid={o.tone === 'danger' ? 'step-error' : undefined}>
          {message}
        </span>
      </span>
      {o.status !== null && <span className="tabular shrink-0 text-muted-foreground">{o.status}</span>}
      {o.status === 418 && <TeapotSlot />}
      {o.durationMs !== null && (
        <span className="tabular shrink-0 font-semibold text-foreground" data-testid="step-duration">
          {formatDuration(o.durationMs)}
        </span>
      )}
    </p>
  );
}
