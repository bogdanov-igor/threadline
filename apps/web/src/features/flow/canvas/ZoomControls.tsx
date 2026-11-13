// Кнопки масштаба: «Вписать», минус, проценты, плюс. Одни и те же у графа и у картинки в документации. Файл без React Flow: чанк графа за ним не идёт.
import { useTranslation } from 'react-i18next';
import { numberFormat } from '@/lib/format.ts';
import { cn } from '@/lib/utils.ts';
import { Fit, Minus, Plus } from './icons.tsx';

const CONTROL = 'inline-flex h-7 min-w-7 items-center justify-center gap-1 rounded-[6px] px-1.5 text-[12.5px] font-medium text-foreground-2 transition-colors hover:bg-sunk aria-disabled:opacity-40';

// Кнопка у предела не disabled: браузер снимает фокус с выключенной кнопки, и следующий Tab шёл с начала страницы, а из окна с картинкой уходил наружу.
export function ZoomControls({ zoom, canZoomOut, canZoomIn, onFit, onZoomOut, onZoomIn, testId, className }: { zoom: number; canZoomOut: boolean; canZoomIn: boolean; onFit: () => void; onZoomOut: () => void; onZoomIn: () => void; testId: string; className?: string }) {
  const { t } = useTranslation();
  const percent = numberFormat({ style: 'percent', maximumFractionDigits: 0 }).format(zoom);
  return (
    <div className={cn('z-[5] flex gap-0.5 rounded-[9px] border border-border bg-card p-[3px]', className)} role="group" aria-label={t('flow.rf.controls')} data-testid={testId}>
      <button type="button" className={CONTROL} onClick={onFit} data-testid={`${testId}-fit`}>
        <Fit className="size-3.5" aria-hidden />
        {t('flow.rf.fitView')}
      </button>
      <button type="button" className={CONTROL} onClick={canZoomOut ? onZoomOut : undefined} aria-disabled={!canZoomOut} aria-label={t('flow.rf.zoomOut')} title={t('flow.rf.zoomOut')} data-testid={`${testId}-out`}>
        <Minus className="size-3.5" aria-hidden />
      </button>
      <span className="tabular inline-flex h-7 min-w-11 items-center justify-center text-[12.5px] font-medium text-foreground-2" data-testid={`${testId}-value`}>
        {percent}
      </span>
      <button type="button" className={CONTROL} onClick={canZoomIn ? onZoomIn : undefined} aria-disabled={!canZoomIn} aria-label={t('flow.rf.zoomIn')} title={t('flow.rf.zoomIn')} data-testid={`${testId}-in`}>
        <Plus className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}
