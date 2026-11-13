// Рёбра графа: сплошное без подписи, сплошное с подписью паузы и пунктир связи потоков операции. Развилка и слияние — кривые.
import { BaseEdge, EdgeLabelRenderer, getBezierPath, getStraightPath, type Edge, type EdgeProps } from '@xyflow/react';
import { memo } from 'react';
import { cn } from '@/lib/utils.ts';
import type { FlowEdge } from '../model.ts';
import { edgeLabel } from '../node-text.ts';

export interface EdgeData extends Record<string, unknown> {
  edge: FlowEdge;
  label: string | null;
  /** Ребро ведёт к узлу с ошибкой: красный тон пути сбоя. */
  hot?: boolean;
}

export type FlowRfEdge = Edge<EdgeData, 'solid' | 'labeled' | 'link'>;

/** Вид компонента ребра: связь — пунктир, с подписью — подпись, остальные — сплошные. */
export function edgeType(e: FlowEdge): FlowRfEdge['type'] {
  if (e.kind === 'link') return 'link';
  return edgeLabel(e.hint) ? 'labeled' : 'solid';
}

/** Стрелка на конце ребра: у рёбер в точку слияния её нет. */
export const ARROW = { type: 'arrowclosed', width: 14, height: 14, color: 'var(--color-muted-foreground)' } as const;
/** Стрелка ребра к узлу с ошибкой: тот же красный тон, что у линии. */
export const HOT_ARROW = { ...ARROW, color: 'var(--flow-edge-hot)' } as const;

const edgeClass = (p: EdgeProps<FlowRfEdge>) => cn('threadline-edge', p.data?.hot && 'threadline-edge-hot');

function pathOf(p: EdgeProps<FlowRfEdge>) {
  if (Math.abs(p.sourceY - p.targetY) < 1) return getStraightPath({ sourceX: p.sourceX, sourceY: p.sourceY, targetX: p.targetX, targetY: p.targetY });
  return getBezierPath({
    sourceX: p.sourceX,
    sourceY: p.sourceY,
    sourcePosition: p.sourcePosition,
    targetX: p.targetX,
    targetY: p.targetY,
    targetPosition: p.targetPosition,
    curvature: 0.5,
  });
}

function Label({ x, y, text, link = false }: { x: number; y: number; text: string; link?: boolean }) {
  return (
    <EdgeLabelRenderer>
      <span
        data-testid="edge-label"
        className={cn(
          'tabular pointer-events-none absolute h-5 rounded-[6px] border bg-card px-1.5 text-[12px] leading-[18px] whitespace-nowrap text-muted-foreground',
          link ? 'border-primary/40 text-primary' : 'border-border',
        )}
        style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}
      >
        {text}
      </span>
    </EdgeLabelRenderer>
  );
}

export const SolidEdge = memo(function SolidEdge(p: EdgeProps<FlowRfEdge>) {
  const [path] = pathOf(p);
  return <BaseEdge id={p.id} path={path} className={edgeClass(p)} markerEnd={p.markerEnd} />;
});

export const LabeledEdge = memo(function LabeledEdge(p: EdgeProps<FlowRfEdge>) {
  const [path, x, y] = pathOf(p);
  const label = p.data?.label ?? null;
  return (
    <>
      <BaseEdge id={p.id} path={path} className={edgeClass(p)} markerEnd={p.markerEnd} />
      {label && <Label x={x} y={y} text={label} />}
    </>
  );
});

export const LinkEdge = memo(function LinkEdge(p: EdgeProps<FlowRfEdge>) {
  const [path, x, y] = pathOf(p);
  const label = p.data?.label ?? null;
  return (
    <>
      <BaseEdge id={p.id} path={path} className="threadline-edge threadline-edge-link" />
      {label && <Label x={x} y={y} text={label} link />}
    </>
  );
});

export const EDGE_TYPES = { solid: SolidEdge, labeled: LabeledEdge, link: LinkEdge };
