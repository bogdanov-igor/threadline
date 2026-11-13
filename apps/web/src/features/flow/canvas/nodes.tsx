// Обёртки узлов для React Flow: Handle для рёбер и тело узла. Выбор, режим и обработчики приходят из контекста,
// поэтому массив узлов при выборе не пересобирается, а раскладка от него не зависит.
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { createContext, memo, useContext, type KeyboardEvent } from 'react';
import i18n from '@/i18n/index.ts';
import { cn } from '@/lib/utils.ts';
import type { ViewMode as DetailMode } from '@threadline/core/view';
import { GROUP_HEADER, type FlowEntryInfo, type FlowFrame, type FlowViewNode, type Located } from '../model.ts';
import { nodeLines, nodeName, shownMark } from '../node-text.ts';
import { Package } from './icons.tsx';
import { GroupToggle, NodeBody, nodeIcon } from './NodeBody.tsx';

export interface FlowContextValue {
  /** Узлы в memo берут текст через i18n.t: новый контекст при смене языка перерисовывает их, данные и раскладка те же. */
  language: string;
  mode: DetailMode;
  /** Значки логов видны в этом режиме. */
  logs: boolean;
  located: Located | null;
  /** Узел с остановкой Tab: выбранный, иначе первый. */
  tabStop: string | null;
  order: ReadonlyMap<string, number>;
  total: number;
  entry: FlowEntryInfo | null;
  frame: FlowFrame | null;
  /** Записей с найденным значением у видимого узла. */
  hits: ReadonlyMap<string, number> | null;
  /** Узлы обменов с внешними системами: метка «внешняя». */
  external: ReadonlySet<string> | null;
  onClick: (node: FlowViewNode) => void;
  onAttempt: (stepId: string) => void;
  onKeyDown: (e: KeyboardEvent<HTMLButtonElement>, node: FlowViewNode) => void;
  onToggle: (node: FlowViewNode) => void;
  onTimeline: (node: FlowViewNode) => void;
  /** Действие «Открыть операцию» у узла с ключом; null — нет. */
  operationOf: (node: FlowViewNode) => { label: string; onOpen: () => void } | null;
}

export const FlowContext = createContext<FlowContextValue | null>(null);

function useFlow(): FlowContextValue {
  const ctx = useContext(FlowContext);
  if (!ctx) throw new Error('FlowContext отсутствует');
  return ctx;
}

export interface NodeData extends Record<string, unknown> {
  node: FlowViewNode;
  x: number;
  y: number;
}

export type FlowRfNode = Node<NodeData, 'step' | 'frame' | 'junction' | 'project'>;

// Точки рёбер: слева вход, справа выход, снизу связь с узлами-ссылками, у которых вход сверху. Не видны и не соединяются.
const HANDLE = '!pointer-events-none !min-h-0 !min-w-0 !size-px !border-0 !bg-transparent';

function Handles({ link = false }: { link?: boolean }) {
  return (
    <>
      <Handle type="target" position={link ? Position.Top : Position.Left} isConnectable={false} className={HANDLE} />
      {!link && <Handle type="source" position={Position.Right} isConnectable={false} className={HANDLE} />}
      {!link && <Handle id="link" type="source" position={Position.Bottom} isConnectable={false} className={HANDLE} />}
    </>
  );
}

export const StepNode = memo(function StepNode({ data }: NodeProps<FlowRfNode>) {
  const ctx = useFlow();
  const n = data.node;
  return (
    <>
      <Handles link={n.kind === 'flow-ref'} />
      <NodeBody
        node={n}
        mode={ctx.mode}
        logs={ctx.logs}
        order={ctx.order.get(n.id) ?? 0}
        total={ctx.total}
        selected={ctx.located?.nodeId === n.id}
        located={ctx.located}
        tabIndex={ctx.tabStop === n.id ? 0 : -1}
        x={data.x}
        y={data.y}
        hits={ctx.hits?.get(n.id) ?? 0}
        external={ctx.external?.has(n.id) ?? false}
        entry={ctx.entry}
        onClick={() => ctx.onClick(n)}
        onKeyDown={(e) => ctx.onKeyDown(e, n)}
        onToggle={() => ctx.onToggle(n)}
        onTimeline={() => ctx.onTimeline(n)}
        onAttempt={ctx.onAttempt}
        operation={ctx.operationOf(n)}
      />
    </>
  );
});

/** Рамка раскрытой группы: шапка-кнопка с именем и пометкой, шеврон сворачивания, внутри — свои узлы. */
export const FrameNode = memo(function FrameNode({ data, width, height }: NodeProps<FlowRfNode>) {
  const ctx = useFlow();
  const n = data.node;
  const Icon = nodeIcon(n);
  const name = nodeName(n, ctx.mode);
  const mark = shownMark(n.mark, ctx.mode);
  const selected = ctx.located?.nodeId === n.id;
  const error = n.outcome.tone === 'error';
  const lines = nodeLines(n, ctx.mode, ctx.order.get(n.id) ?? 0, ctx.total, ctx.located, ctx.logs);
  return (
    <div
      id={`flow-group-${n.id}`}
      role="group"
      aria-label={[name, mark].filter(Boolean).join(' · ')}
      className={cn('relative rounded-[14px] border border-dashed bg-muted/30', error ? 'border-danger/50' : 'border-border')}
      style={{ width, height }}
    >
      <Handles />
      <button
        type="button"
        data-node={n.id}
        data-kind="group"
        data-frame="open"
        data-group={n.group?.kind}
        data-tone={n.outcome.tone}
        data-x={data.x}
        data-y={data.y}
        aria-pressed={selected}
        aria-label={lines.aria}
        title={lines.title}
        tabIndex={ctx.tabStop === n.id ? 0 : -1}
        onClick={() => ctx.onClick(n)}
        onKeyDown={(e) => ctx.onKeyDown(e, n)}
        className={cn('flex w-full min-w-0 items-center gap-2 rounded-t-[14px] pr-9 pl-3 text-left text-[12px] leading-5 hover:text-heading', selected && 'outline-2 outline-offset-2 outline-ring')}
        style={{ height: GROUP_HEADER }}
      >
        <Icon className={cn('size-3.5 shrink-0', error ? 'text-danger' : 'text-muted-foreground')} aria-hidden />
        <span className="min-w-0 truncate font-semibold text-heading">{name}</span>
        {mark && <span className={cn('tabular shrink-0', error ? 'text-danger' : 'text-muted-foreground')}>{mark}</span>}
        {n.unread && (
          <span className="tabular min-w-0 truncate text-warning" data-unread>
            {i18n.t('flow.mark.unread')}
          </span>
        )}
      </button>
      <GroupToggle node={n} name={name} onToggle={() => ctx.onToggle(n)} className="absolute top-0.5 right-1" />
    </div>
  );
});

/** Точка слияния параллельных веток. */
export const JunctionNode = memo(function JunctionNode() {
  return (
    <div aria-hidden className="threadline-junction size-2 rounded-full">
      <Handles />
    </div>
  );
});

/** Рамка проекта вокруг шагов: имя проекта и запроса, длительность, подпись. Заголовок в одну строку, многоточие. */
export const ProjectFrame = memo(function ProjectFrame({ width, height }: NodeProps<FlowRfNode>) {
  const frame = useFlow().frame;
  return (
    <div data-testid="flow-frame" className="rounded-[14px] border border-accent-line bg-group" style={{ width, height }}>
      {frame && (
        <div className="flex h-9 min-w-0 items-center gap-2 px-3.5 text-[12.5px] whitespace-nowrap text-foreground-2">
          <Package className="size-3.5 shrink-0 text-primary" aria-hidden />
          <span className="min-w-0 truncate text-[13px] font-semibold text-foreground" title={frame.title} data-testid="flow-frame-title">
            {frame.title}
          </span>
          <span className="tabular shrink-0 font-semibold text-foreground">· {frame.duration}</span>
          {frame.note && <span className="shrink-0 text-muted-foreground">· {frame.note}</span>}
        </div>
      )}
    </div>
  );
});

export const NODE_TYPES = { step: StepNode, frame: FrameNode, junction: JunctionNode, project: ProjectFrame };
