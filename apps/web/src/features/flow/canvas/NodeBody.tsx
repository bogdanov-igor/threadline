// Тело узла графа: чистая разметка без хуков React Flow.
// Handle добавляет обёртка в nodes.tsx. Значки, общие с остальным интерфейсом, — из lucide-react; нужные только графу — из icons.tsx (чанк flow).
import { ArrowLeftRight, ChevronDown, CircleAlert, CircleCheck, Layers, Link2, LogIn, RefreshCw, SquareFunction } from 'lucide-react';
import {
  ArrowUpRight,
  ChartGantt,
  ChevronUp,
  CircleDot,
  Clock,
  Cog,
  Database,
  Ellipsis,
  Hourglass,
  LogLines,
  ParallelBars,
  Repeat,
  SendHorizontal,
  Server,
  Split,
  Undo2,
  Webhook,
  type Glyph,
} from './icons.tsx';
import type { KeyboardEvent, MouseEvent } from 'react';
import i18n from '@/i18n/index.ts';
import { formatInt } from '@/lib/format.ts';
import { cn } from '@/lib/utils.ts';
import type { ViewMode as DetailMode } from '@threadline/core/view';
import { attemptStrip, nodeBoxSize, type FlowEntryInfo, type FlowTone, type FlowViewNode, type Located } from '../model.ts';
import { nodeLines, pauseLabel, type LineTone } from '../node-text.ts';

const GROUP_ICON: Record<string, Glyph> = {
  retry: Repeat,
  poll: RefreshCw,
  call: Layers,
  errors: CircleAlert,
  parallel: Split,
  more: Ellipsis,
  related: Layers,
};

export function nodeIcon(node: FlowViewNode): Glyph {
  if (node.group) return GROUP_ICON[node.group.kind] ?? Layers;
  switch (node.kind) {
    case 'entry':
      return node.entry === 'callback' ? Webhook : node.entry === 'background' ? Cog : LogIn;
    case 'fn':
      return node.stepIds.length > 1 ? Server : SquareFunction;
    case 'db':
      return Database;
    case 'wait':
      return Hourglass;
    case 'async-start':
      return SendHorizontal;
    case 'flow-ref':
      return node.mark?.kind === 'related' ? Layers : Link2;
    case 'exchange':
      return Server;
    default:
      return ArrowLeftRight;
  }
}

const LINE: Record<LineTone, string> = {
  normal: 'text-foreground-2',
  danger: 'text-danger',
  warning: 'text-warning',
  muted: 'text-muted-foreground',
  success: 'text-success',
};

const CELL: Record<FlowTone, string> = {
  success: 'bg-success',
  error: 'bg-danger',
  warning: 'bg-warning',
  pending: 'bg-input',
  none: 'bg-input',
};

/** Штриховка шага без ответа: красная у ошибки, серая у ожидания. */
const hatchOf = (tone: FlowTone) => `repeating-linear-gradient(135deg,var(${tone === 'error' ? '--hatch-err' : '--hatch-neu'}) 0 6px,transparent 6px 12px)`;

const ROUND_BUTTON =
  'z-10 flex size-6 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-[var(--shadow-card)] transition-colors hover:border-primary/60 hover:text-foreground';
// У свёрнутой группы шеврон стоит на правой кромке узла, у раскрытой — в шапке рамки.
export const SIDE_PLACE = 'absolute top-1/2 -right-3 -translate-y-1/2';

const FRAME_BASE =
  'relative flex size-full flex-col overflow-hidden rounded-[10px] border bg-card text-left transition-[border-color,box-shadow] hover:border-muted-foreground focus-visible:outline-offset-4';

export interface NodeBodyProps {
  node: FlowViewNode;
  mode: DetailMode;
  /** Значок логов виден: блок логов включён в этом режиме. Размер узла от него не зависит. */
  logs?: boolean;
  /** Номер узла среди видимых, с 1. */
  order: number;
  /** Видимых узлов без слияний: «Шаг 4 из 12». */
  total: number;
  selected: boolean;
  /** Где выбранный шаг: клетка полоски у свёрнутой группы. */
  located: Located | null;
  tabIndex: number;
  x?: number;
  y?: number;
  /** Записей шага с найденным значением: значок на рамке. */
  hits?: number;
  /** Итог запроса и время первой записи для узла входа. */
  entry?: FlowEntryInfo | null;
  onClick?: ((e: MouseEvent<HTMLButtonElement>) => void) | undefined;
  onKeyDown?: ((e: KeyboardEvent<HTMLButtonElement>) => void) | undefined;
  onToggle?: (() => void) | undefined;
  onTimeline?: (() => void) | undefined;
  /** Клетка полоски: панель показывает эту попытку, граф не двигается. */
  onAttempt?: ((stepId: string) => void) | undefined;
  /** У узла с ключом операции, если запрос открыт не из неё: «Открыть операцию · Перевод …4821». */
  operation?: { label: string; onOpen: () => void } | null | undefined;
  /** Обмен с внешней системой: метка «внешняя» рядом с именем. */
  external?: boolean;
}

/** Полоска времени: начало и длительность на общей шкале запроса, за дорожку не выходит. */
function TimeBar({ node }: { node: FlowViewNode }) {
  const whole = node.kind === 'entry';
  const none = node.outcome.noResponse;
  const left = whole ? 0 : Math.min(100, node.startShare * 100);
  const width = whole ? 100 : none ? 100 - left : Math.min(100 - left, node.share * 100);
  const tone = node.outcome.tone;
  return (
    <span aria-hidden data-testid="node-time" className="absolute right-3 bottom-1.5 left-3 h-[3px] rounded-[2px] bg-border">
      <span
        className={cn('absolute inset-y-0 min-w-[3px] rounded-[2px]', !none && (whole ? 'bg-input' : tone === 'error' ? 'bg-danger' : 'bg-muted-foreground'))}
        style={{ left: `${left}%`, width: `${width}%`, ...(none ? { backgroundImage: `repeating-linear-gradient(135deg,var(${tone === 'error' ? '--color-danger' : '--color-muted-foreground'}) 0 3px,transparent 3px 6px)` } : {}) }}
      />
    </span>
  );
}

/** Полоска попыток: клетки 6 px до 12 попыток, 4 px до 24, больше — последние 24 и «…». */
function AttemptCells({ node, located, onAttempt }: { node: FlowViewNode; located: Located | null; onAttempt?: ((stepId: string) => void) | undefined }) {
  const strip = attemptStrip(node.attempts ?? []);
  const offset = (node.attempts?.length ?? 0) - strip.cells.length;
  const current = located && located.nodeId === node.id && located.of > 1 ? located.index - 1 : -1;
  return (
    <span className="flex shrink-0 items-center gap-0.5" data-testid="node-attempts" data-size={strip.size} data-clipped={strip.clipped || undefined}>
      {strip.clipped && (
        <span aria-hidden className="pr-0.5 leading-3" data-testid="node-attempts-more">
          …
        </span>
      )}
      {strip.cells.map((c, i) => (
        <span
          key={c.stepId}
          data-testid="node-attempt"
          data-tone={c.tone}
          data-current={offset + i === current || undefined}
          onClick={(e) => {
            e.stopPropagation();
            onAttempt?.(c.stepId);
          }}
          className={cn('block h-3 shrink-0 rounded-[2px]', strip.size === 6 ? 'w-1.5' : 'w-1', CELL[c.tone], offset + i === current && 'outline-2 outline-offset-1 outline-ring')}
        />
      ))}
    </span>
  );
}

/** Значки на рамке узла: совпадения, логи, параллельный вызов. Поверх рамки, размер узла не меняют. */
function Badges({ node, logs, hits, mode }: { node: FlowViewNode; logs: boolean; hits: number; mode: DetailMode }) {
  const badge = node.badges;
  const level = badge.error > 0 ? 'error' : badge.warning > 0 ? 'warning' : undefined;
  const showLogs = logs && badge.total > 0;
  const showHits = mode === 'full' && hits > 0;
  const parallel = node.lane > 0 && node.laneCount > 1 && node.group?.kind !== 'parallel';
  if (!showLogs && !showHits && !parallel) return null;
  const chip = 'tabular inline-flex h-5 items-center gap-1 rounded-[10px] border bg-card px-1.5 text-[11.5px] leading-4 font-semibold whitespace-nowrap';
  return (
    <span aria-hidden className="pointer-events-none absolute -top-2.5 right-2.5 z-[1] flex gap-1">
      {parallel && (
        <span data-testid="node-parallel" className={cn(chip, 'border-input text-foreground-2')}>
          <ParallelBars className="size-3" />
          {formatInt(node.laneCount)}
        </span>
      )}
      {showHits && (
        <span data-testid="node-hits" className={cn(chip, 'border-input text-foreground-2')}>
          <CircleDot className="size-3" />
          {formatInt(hits)}
        </span>
      )}
      {showLogs && (
        <span
          data-testid="node-badge"
          data-level={level}
          className={cn(chip, level === 'error' ? 'border-danger text-danger' : level === 'warning' ? 'border-warning text-warning' : 'border-input text-foreground-2')}
        >
          <LogLines className="size-3" />
          {formatInt(badge.total)}
          {level && <span>· {level === 'error' ? 'ERROR' : 'WARNING'}</span>}
        </span>
      )}
    </span>
  );
}

/** Значок итога: у входа — ответ запроса, у шага — исход. */
function OutcomeIcon({ node, tone }: { node: FlowViewNode; tone: LineTone }) {
  if (tone === 'normal' || tone === 'muted') {
    return node.outcome.pending ? <Clock className="size-3.5 shrink-0" aria-hidden /> : null;
  }
  if (node.kind === 'entry') return <Undo2 className="size-3.5 shrink-0" aria-hidden />;
  if (tone === 'success') return <CircleCheck className="size-3.5 shrink-0" aria-hidden />;
  return <CircleAlert className="size-3.5 shrink-0" aria-hidden />;
}

/** Узел своего размера по виду: верхняя строка, имя, итог, полоска времени. Размер не зависит от режима, выбора и текста. */
export function NodeBody({ node, mode, logs = true, order, total, selected, located, tabIndex, x, y, hits = 0, entry = null, onClick, onKeyDown, onToggle, onTimeline, onAttempt, operation, external = false }: NodeBodyProps) {
  if (node.kind === 'pause') return <PauseBody node={node} />;
  const lines = nodeLines(node, mode, order, total, located, logs, entry);
  const size = nodeBoxSize(node);
  const common = {
    id: `flow-node-${node.id}`,
    'data-node': node.id,
    'data-kind': node.kind,
    'data-tone': node.outcome.tone,
    'data-group': node.group?.kind,
    'data-x': x,
    'data-y': y,
    'data-width': size.width,
    'data-height': size.height,
    'aria-pressed': selected,
    'aria-label': lines.aria,
    title: lines.title,
    tabIndex,
    onClick,
    onKeyDown,
    type: 'button' as const,
  };
  const ring = selected && 'outline-2 outline-offset-[3px] outline-ring';
  const error = node.outcome.tone === 'error' || (node.kind === 'flow-ref' && node.related?.error === true);

  if (node.kind === 'wait') {
    return (
      <div className="relative" style={size}>
        <button {...common} className={cn('flex size-full flex-col justify-center overflow-hidden rounded-[20px] border border-input bg-card px-2.5 text-left text-muted-foreground hover:border-muted-foreground', ring)}>
          <span className="flex min-w-0 items-center gap-1 text-[12px] leading-3.5" data-testid="node-name">
            <Clock className="size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 truncate">{pauseLabel(node.durationMs)}</span>
          </span>
          {lines.method && (
            <span className="block min-w-0 truncate font-mono text-[11.5px] leading-3.5" data-testid="node-method">
              {lines.method}
            </span>
          )}
        </button>
      </div>
    );
  }

  const Icon = nodeIcon(node);
  const link = node.kind === 'flow-ref';
  const compact = size.height < 100;
  const hatched = node.outcome.noResponse;
  const stacked = node.attempts !== null;
  // Итог на две строки — только у ошибки без полоски, имя тогда одной строкой.
  const twoLines = !compact && !stacked && lines.outcomeTone === 'danger' && node.kind !== 'entry';
  const showStrip = stacked && mode === 'full';

  return (
    <div className="relative" style={size}>
      {stacked && (
        <>
          <span aria-hidden className="absolute top-2 left-2 size-full rounded-[10px] border border-input bg-card" />
          <span aria-hidden className="absolute top-1 left-1 size-full rounded-[10px] border border-input bg-card" />
        </>
      )}
      <button
        {...common}
        className={cn(FRAME_BASE, 'border-input', compact ? 'gap-1 px-3 py-[9px]' : 'gap-1.5 px-3 py-[11px]', error && 'border-danger shadow-[inset_0_0_0_1px_var(--color-danger)]', ring)}
        style={hatched ? { backgroundImage: hatchOf(node.outcome.tone) } : undefined}
      >
        {compact ? (
          <>
            <span className="flex h-[18px] min-w-0 items-center gap-1.5 text-[12px] leading-4 text-muted-foreground">
              <Icon className={cn('size-3.5 shrink-0', error && 'text-danger', link && !error && 'text-primary')} aria-hidden />
              {link ? (
                <span className="min-w-0 flex-1 truncate" data-testid="node-method" data-unread={node.unread || undefined}>
                  {lines.method}
                </span>
              ) : (
                <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground" data-testid="node-name">
                  {lines.name}
                </span>
              )}
              {link ? <ArrowUpRight className="size-3.5 shrink-0" aria-hidden /> : lines.duration && <span className="tabular shrink-0 font-semibold text-foreground-2">{lines.duration}</span>}
            </span>
            {link ? (
              <span className="flex min-w-0 items-center gap-2 text-[12px] leading-4">
                <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground" data-testid="node-name">
                  {lines.name}
                </span>
                <span className={cn('tabular shrink-0 font-semibold', LINE[lines.outcomeTone])} data-testid="node-outcome">
                  {lines.outcome}
                </span>
              </span>
            ) : (
              <span className={cn('tabular block min-w-0 truncate text-[12px] leading-4', LINE[lines.outcomeTone])} data-testid="node-outcome">
                {lines.outcome}
              </span>
            )}
          </>
        ) : (
          <>
            <span className="flex h-4 min-w-0 items-center gap-1.5 text-[12px] leading-4 text-muted-foreground">
              {!lines.methodMono && <Icon className={cn('size-3.5 shrink-0', error && 'text-danger')} aria-hidden />}
              <span className={cn('min-w-0 flex-1 truncate', lines.methodMono && 'font-mono', LINE[lines.methodTone])} data-testid="node-method" data-unread={node.unread || undefined}>
                {lines.method}
              </span>
              {lines.duration && (
                <span className={cn('tabular shrink-0 font-semibold', node.outcome.tone === 'warning' ? 'text-warning' : 'text-foreground-2')} data-testid="node-duration">
                  {lines.duration}
                </span>
              )}
            </span>
            {external ? (
              // Имя рядом с меткой: метка не обрезается, имя переносится на вторую строку, как у узла без метки, и только дальше — многоточие.
              <span className={cn('flex min-w-0 items-start gap-1.5', twoLines ? 'h-[18px]' : 'h-9')}>
                <span className={cn('min-w-0 text-[13.5px] leading-[18px] font-semibold text-foreground', twoLines ? 'truncate' : 'line-clamp-2')} data-testid="node-name">
                  {lines.name}
                </span>
                <span className="mt-px shrink-0 rounded-[4px] border border-border px-1 text-[10.5px] leading-[15px] font-medium text-muted-foreground" data-testid="node-external">
                  {i18n.t('flow.external')}
                </span>
              </span>
            ) : (
              <span
                className={cn('block min-w-0 overflow-hidden text-[13.5px] leading-[18px] font-semibold text-foreground', twoLines ? 'line-clamp-1 h-[18px]' : 'line-clamp-2 h-9')}
                data-testid="node-name"
              >
                {lines.name}
              </span>
            )}
            <span className={cn('flex min-w-0 gap-1.5 text-[12px] leading-4 font-semibold', twoLines ? 'items-start' : 'items-center', LINE[lines.outcomeTone])}>
              {showStrip ? <AttemptCells node={node} located={located} onAttempt={onAttempt} /> : <OutcomeIcon node={node} tone={lines.outcomeTone} />}
              <span className={cn('tabular min-w-0 flex-1', twoLines ? 'line-clamp-2' : 'truncate')} data-testid="node-outcome">
                {lines.outcome}
              </span>
            </span>
          </>
        )}
        {!link && !compact && <TimeBar node={node} />}
      </button>
      {/* Подпись под узлом: промежуток свободен, размер узла от неё не меняется. */}
      {lines.note && (
        <span data-testid="node-note" className="absolute top-full left-0 mt-1 w-full text-[11px] leading-[14px] text-muted-foreground">
          {lines.note}
        </span>
      )}
      <Badges node={node} logs={logs} hits={hits} mode={mode} />
      {/* Шеврон группы — отдельная кнопка рядом с узлом, не внутри; с клавиатуры группа раскрывается пробелом. */}
      {node.group && !node.listed && <GroupToggle node={node} name={lines.name} onToggle={onToggle} onTimeline={onTimeline} className={SIDE_PLACE} />}
      {/* Подвеска операции: с клавиатуры операцию открывает кнопка в шапке запроса, здесь — короткий путь мышью. */}
      {operation && (
        <button
          type="button"
          tabIndex={-1}
          aria-label={operation.label}
          title={operation.label}
          data-testid="node-operation"
          onClick={operation.onOpen}
          className="absolute -bottom-[11px] left-1/2 z-10 inline-flex h-[22px] -translate-x-1/2 items-center gap-1 rounded-[11px] border border-accent-line bg-card px-2 text-[11.5px] leading-4 font-semibold whitespace-nowrap text-primary transition-colors hover:bg-accent"
        >
          <Link2 className="size-3" aria-hidden />
          {i18n.t('flow.mark.openOperation')}
        </button>
      )}
    </div>
  );
}

/** Долгая пауза отдельным узлом: шага за ней нет, выбрать её нельзя. */
function PauseBody({ node }: { node: FlowViewNode }) {
  const label = pauseLabel(node.durationMs);
  return (
    <div
      data-testid="node-pause"
      data-kind="pause"
      title={label}
      style={nodeBoxSize(node)}
      className="flex items-center gap-1 overflow-hidden rounded-[20px] border border-input bg-card px-2.5 text-[12px] leading-4 text-muted-foreground"
    >
      <Clock className="size-3.5 shrink-0" aria-hidden />
      <span className="tabular min-w-0 truncate">{label}</span>
    </div>
  );
}

export function GroupToggle({
  node,
  name,
  onToggle,
  onTimeline,
  className,
}: {
  node: FlowViewNode;
  name: string;
  onToggle?: (() => void) | undefined;
  onTimeline?: (() => void) | undefined;
  className: string;
}) {
  if (!node.expandable) {
    const label = i18n.t('flow.group.toTimeline');
    return (
      <button
        type="button"
        tabIndex={-1}
        aria-label={label}
        title={label}
        data-testid="group-timeline"
        onClick={onTimeline}
        className={cn(ROUND_BUTTON, className)}
      >
        <ChartGantt className="size-3.5" aria-hidden />
      </button>
    );
  }
  const label = i18n.t(node.expanded ? 'flow.group.collapse' : 'flow.group.expand', { name });
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-expanded={node.expanded}
      aria-controls={node.expanded ? `flow-group-${node.id}` : undefined}
      aria-label={label}
      title={label}
      data-testid="group-toggle"
      onClick={onToggle}
      className={cn(ROUND_BUTTON, className)}
    >
      {node.expanded ? <ChevronUp className="size-4" aria-hidden /> : <ChevronDown className="size-4" aria-hidden />}
    </button>
  );
}
