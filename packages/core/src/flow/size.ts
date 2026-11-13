// Размеры узлов и холста. Раскладка
// dagre в интерфейсе берёт те же числа: размер заготовки считается здесь, без dagre и без чанка графа.
import type { FlowEdge, FlowNode, FlowView, FlowViewNode } from './model.ts';

/** Обмен, функция, асинхронный шаг. Размер остальных видов — nodeBoxSize. */
export const NODE_WIDTH = 232;
export const NODE_HEIGHT = 104;
export const COMPACT_HEIGHT = 64;
export const ENTRY_WIDTH = 184;
export const DB_WIDTH = 200;
export const RETRY_WIDTH = 280;
export const REF_WIDTH = 268;
export const PARALLEL_WIDTH = 240;
export const PAUSE_WIDTH = 140;
export const PAUSE_HEIGHT = 40;
export const JUNCTION_SIZE = 8;
/** Шапка рамки раскрытой группы над её внутренней раскладкой. */
export const GROUP_HEADER = 28;
/**
 * ranksep вдвое меньше промежутка между узлами: обычное ребро идёт через два слоя (64 px), рёбра слияния через один,
 * поэтому между веткой и следующим шагом 72 px вместе с точкой слияния, как на досках.
 */
export const LAYOUT = { rankdir: 'LR', nodesep: 24, edgesep: 24, ranksep: 32, marginx: 16, marginy: 16 } as const;
/** Узлы-ссылки стоят строкой под графом: столько до неё от нижнего края графа. */
export const REF_GAP = 48;
/** Рамка проекта вокруг шагов: шапка сверху, поля под подвеску операции снизу и по краям. */
export const FRAME = { top: 44, bottom: 24, right: 24, left: 32 } as const;

/** Место под подписью узла «Внешних вызовов нет…»: снизу холста поля marginy на две строки мало. */
export const NOTE_ROOM = 20;

/** Нужен ли холсту запас под подпись: подпись есть только у входа без обменов. */
export const hasNote = (view: FlowView): boolean => view.nodes.some((n) => n.parentId === null && n.mark?.kind === 'no-calls');

export interface Size {
  width: number;
  height: number;
}

/** Размер свёрнутого узла зависит только от его вида: режим, выбор и текст на него не влияют. */
export function nodeBoxSize(node: Pick<FlowNode, 'kind' | 'group'>): Size {
  switch (node.kind) {
    case 'junction':
      return { width: JUNCTION_SIZE, height: JUNCTION_SIZE };
    case 'pause':
    case 'wait':
      return { width: PAUSE_WIDTH, height: PAUSE_HEIGHT };
    case 'entry':
      return { width: ENTRY_WIDTH, height: NODE_HEIGHT };
    case 'db':
      return { width: DB_WIDTH, height: NODE_HEIGHT };
    case 'flow-ref':
      return { width: REF_WIDTH, height: COMPACT_HEIGHT };
    case 'group':
      switch (node.group?.kind) {
        case 'retry':
        case 'poll':
        case 'errors':
          return { width: RETRY_WIDTH, height: NODE_HEIGHT };
        case 'parallel':
        case 'more':
        case 'related':
          return { width: PARALLEL_WIDTH, height: COMPACT_HEIGHT };
        default:
          return { width: NODE_WIDTH, height: NODE_HEIGHT };
      }
    default:
      return { width: NODE_WIDTH, height: NODE_HEIGHT };
  }
}

/** Слоёв на ребре: слияние короче, остальные через два слоя. Значение для dagre и для заготовки одно. */
export const edgeMinlen = (e: Pick<FlowEdge, 'kind'>, junctionSource: boolean): number => (e.kind === 'join' || junctionSource ? 1 : 2);

export function nodeSize(view: FlowView, node: FlowViewNode): Size {
  if (node.expanded) {
    const inner = canvasSize(view, node.id);
    return { width: Math.max(NODE_WIDTH, inner.width), height: inner.height + GROUP_HEADER };
  }
  return nodeBoxSize(node);
}

/**
 * Ширина и высота графа (или внутренности раскрытой группы) по слоям слева направо: слой — длина самого длинного пути
 * от начала, ширина слоя — самый широкий узел, высота — узлы слоя с промежутками nodesep. Отступы — marginx и marginy.
 * Узлы-ссылки стоят строкой ниже графа.
 */
export function canvasSize(view: FlowView, parentId: string | null = null, frame = false): Size {
  const nodes = view.nodes.filter((n) => n.parentId === parentId);
  if (nodes.length === 0) return { width: 2 * LAYOUT.marginx, height: 2 * LAYOUT.marginy };
  const inner = nodes.filter((n) => n.kind !== 'flow-ref');
  const refs = nodes.filter((n) => n.kind === 'flow-ref');
  const ids = new Set(inner.map((n) => n.id));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const rank = new Map<string, number>();
  const incoming = new Map<string, { source: string; minlen: number }[]>();
  for (const e of view.edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) continue;
    const list = incoming.get(e.target) ?? [];
    list.push({ source: e.source, minlen: edgeMinlen(e, byId.get(e.source)?.kind === 'junction') });
    incoming.set(e.target, list);
  }
  // Узлы идут по времени, рёбра — от раннего к позднему: одного прохода хватает.
  for (const n of inner) rank.set(n.id, Math.max(0, ...(incoming.get(n.id) ?? []).map((s) => (rank.get(s.source) ?? 0) + s.minlen)));
  const ranks = new Map<number, Size[]>();
  for (const n of inner) {
    const r = rank.get(n.id)!;
    ranks.set(r, [...(ranks.get(r) ?? []), nodeSize(view, n)]);
  }
  let width = 0;
  let height = 0;
  const keys = [...ranks.keys()].sort((a, b) => a - b);
  for (const r of keys) {
    const sizes = ranks.get(r)!;
    width += Math.max(...sizes.map((s) => s.width));
    height = Math.max(height, sizes.reduce((h, s) => h + s.height, 0) + LAYOUT.nodesep * (sizes.length - 1));
  }
  width += LAYOUT.ranksep * (keys.at(-1) ?? 0);
  if (refs.length > 0) {
    const row = refs.reduce((w, n) => w + nodeBoxSize(n).width, 0) + LAYOUT.nodesep * (refs.length - 1);
    width = Math.max(width, row);
  }
  const withFrame = frame && parentId === null && inner.length > 1;
  const frameRoom = withFrame ? FRAME.top + FRAME.bottom : 0;
  const refRoom = refs.length > 0 ? REF_GAP + COMPACT_HEIGHT : 0;
  const note = parentId === null && hasNote(view) ? NOTE_ROOM : 0;
  return {
    width: width + 2 * LAYOUT.marginx + (withFrame ? FRAME.right : 0),
    height: height + 2 * LAYOUT.marginy + frameRoom + refRoom + note,
  };
}
