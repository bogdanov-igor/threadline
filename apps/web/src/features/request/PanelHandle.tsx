import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { PANEL_DEFAULT, PANEL_MIN } from './step-panel.ts';

const KEY_STEP = 16;
// Панель с запасом места в низком окне стоит через отступ 20 px: ручка остаётся у её левого края.
const LOW_GAP = '[@media(min-width:1280px)_and_(max-height:699.98px)]:-mr-5';

/**
 * Разделитель на левом крае панели шага. При перетаскивании двигается только линия, ширина меняется при отпускании:
 * граф и тело в 2 МБ не перекладываются на каждый пиксель.
 */
export function PanelHandle({ width, max, onWidth }: { width: number; max: number; onWidth: (width: number) => void }) {
  const { t } = useTranslation();
  const [dragging, setDragging] = useState(false);
  const guide = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; next: number } | null>(null);
  const clamp = (w: number) => Math.min(max, Math.max(PANEL_MIN, Math.round(w)));

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, next: width };
    setDragging(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    d.next = clamp(width + d.x - e.clientX);
    if (guide.current) guide.current.style.transform = `translateX(${width - d.next}px)`;
  };
  const finish = (commit: boolean) => {
    const d = drag.current;
    drag.current = null;
    setDragging(false);
    if (guide.current) guide.current.style.transform = '';
    if (commit && d && d.next !== width) onWidth(d.next);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = { ArrowLeft: width + KEY_STEP, ArrowRight: width - KEY_STEP, Home: PANEL_MIN, End: max }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    if (clamp(next) !== width) onWidth(clamp(next));
  };

  return (
    <div className={`relative z-10 hidden w-0 shrink-0 self-stretch xl:block ${LOW_GAP}`}>
      {dragging && <div ref={guide} aria-hidden className="pointer-events-none absolute inset-y-0 -left-px w-0.5 bg-primary" data-testid="panel-guide" />}
      <div
        role="separator"
        tabIndex={0}
        aria-orientation="vertical"
        aria-label={t('trace.panel.resize')}
        aria-valuenow={width}
        aria-valuemin={PANEL_MIN}
        aria-valuemax={max}
        title={t('trace.panel.resize')}
        data-testid="panel-handle"
        className="group absolute inset-y-0 -left-1 w-2 cursor-col-resize touch-none outline-none select-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => finish(true)}
        onPointerCancel={() => finish(false)}
        onDoubleClick={() => onWidth(clamp(PANEL_DEFAULT))}
        onKeyDown={onKeyDown}
      >
        <span aria-hidden className="absolute inset-y-0 left-[3px] w-0.5 bg-primary opacity-0 transition-opacity group-hover:opacity-60 group-focus-visible:opacity-100" />
      </div>
    </div>
  );
}
