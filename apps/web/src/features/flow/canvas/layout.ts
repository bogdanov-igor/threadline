// Раскладка графа потока dagre слева направо и поведение холста. Знает только
// видимый граф и раскрытые группы: выбор, наведение, фокус, режим и ширина окна сюда не передаются, координаты от них не зависят.
import dagre from '@dagrejs/dagre';
import {
  COMPACT_HEIGHT,
  edgeMinlen,
  FRAME,
  GROUP_HEADER,
  hasNote,
  LAYOUT,
  NODE_WIDTH,
  nodeBoxSize,
  NOTE_ROOM,
  REF_GAP,
  type FlowView,
  type FlowViewNode,
} from '../model.ts';

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FlowLayout {
  width: number;
  height: number;
  /** Верхний левый угол узла в системе холста. */
  boxes: Map<string, Box>;
  /** Позиция для React Flow: у детей раскрытой группы — от угла её рамки. */
  positions: Map<string, { x: number; y: number }>;
  /** Рамка проекта вокруг шагов; null — её нет. */
  frame: Box | null;
}

interface Size {
  width: number;
  height: number;
}

/** Раскладка видимого графа: раскрытая группа — свой проход dagre, снаружи она один узел размером с рамку. */
export function layoutFlow(view: FlowView, options: { frame?: boolean } = {}): FlowLayout {
  const byParent = new Map<string | null, FlowViewNode[]>();
  for (const n of view.nodes) byParent.set(n.parentId, [...(byParent.get(n.parentId) ?? []), n]);
  const local = new Map<string, { x: number; y: number }>();
  const sizes = new Map<string, Size>();

  const place = (parentId: string | null): Size => {
    // Узлы-ссылки стоят строкой под графом: иначе их ребро уводило бы поток вправо.
    const nodes = (byParent.get(parentId) ?? []).filter((n) => n.kind !== 'flow-ref');
    if (nodes.length === 0) return { width: 2 * LAYOUT.marginx, height: 2 * LAYOUT.marginy };
    for (const n of nodes) {
      if (n.expanded) {
        const inner = place(n.id);
        sizes.set(n.id, { width: Math.max(NODE_WIDTH, inner.width), height: inner.height + GROUP_HEADER });
      } else sizes.set(n.id, nodeBoxSize(n));
    }
    const g = new dagre.graphlib.Graph({ multigraph: true });
    g.setGraph({ ...LAYOUT });
    g.setDefaultEdgeLabel(() => ({}));
    const ids = new Map<string, FlowViewNode>();
    for (const n of nodes) {
      g.setNode(n.id, { ...sizes.get(n.id)! });
      ids.set(n.id, n);
    }
    // Слабое ребро слияния забирает слабину: короткая ветка начинается сразу после развилки, а не у слияния.
    for (const e of view.edges) {
      if (ids.has(e.source) && ids.has(e.target))
        g.setEdge(e.source, e.target, { weight: e.kind === 'join' ? 1 : 8, minlen: edgeMinlen(e, ids.get(e.source)!.kind === 'junction') }, e.id);
    }
    // Порядок узлов в столбце — порядок добавления, то есть время: эвристика пересечений переставила бы ветки.
    dagre.layout(g, { disableOptimalOrderHeuristic: true });
    for (const n of nodes) {
      const at = g.node(n.id);
      const s = sizes.get(n.id)!;
      local.set(n.id, {
        x: Math.round((at.x ?? 0) - s.width / 2),
        y: Math.round((at.y ?? 0) - s.height / 2),
      });
    }
    const label = g.graph();
    return { width: Math.round(label.width ?? 0), height: Math.round(label.height ?? 0) };
  };

  const size = place(null);
  const boxes = new Map<string, Box>();
  const positions = new Map<string, { x: number; y: number }>();

  // Рамка проекта: шаги внутри, вход слева от неё. Шапке рамки нужно место над шагами, подвеске операции — под ними.
  const steps = (byParent.get(null) ?? []).filter((n) => n.kind !== 'flow-ref' && n.kind !== 'entry');
  const withFrame = options.frame === true && steps.length > 0;
  const shiftY = withFrame ? FRAME.top : 0;
  let width = size.width + (withFrame ? FRAME.right : 0);
  let height = size.height + (withFrame ? FRAME.top + FRAME.bottom : 0);
  let frame: Box | null = null;
  if (withFrame) {
    const edge = (at: (b: { x: number; y: number; s: Size }) => number, pick: (...v: number[]) => number) =>
      pick(...steps.map((n) => at({ ...local.get(n.id)!, s: sizes.get(n.id)! })));
    const left = edge((b) => b.x, Math.min) - FRAME.left;
    const right = edge((b) => b.x + b.s.width, Math.max) + FRAME.right;
    const top = edge((b) => b.y, Math.min) + shiftY - FRAME.top;
    const bottom = edge((b) => b.y + b.s.height, Math.max) + shiftY + FRAME.bottom;
    frame = { x: left, y: top, width: right - left, height: bottom - top };
  }

  // Рамки идут раньше своих детей: абсолютная позиция родителя уже известна.
  for (const n of view.nodes) {
    if (n.kind === 'flow-ref') continue;
    const l = local.get(n.id) ?? { x: 0, y: 0 };
    const s = sizes.get(n.id) ?? nodeBoxSize(n);
    const pos = n.parentId ? { x: l.x, y: l.y + GROUP_HEADER } : { x: l.x, y: l.y + shiftY };
    const parent = n.parentId ? boxes.get(n.parentId) : undefined;
    positions.set(n.id, pos);
    boxes.set(n.id, {
      x: (parent?.x ?? 0) + pos.x,
      y: (parent?.y ?? 0) + pos.y,
      width: s.width,
      height: s.height,
    });
  }

  // Узлы-ссылки: строка под графом, по центру узла с ключом, если хватает места.
  const refs = (byParent.get(null) ?? []).filter((n) => n.kind === 'flow-ref');
  if (refs.length > 0) {
    const y = height - LAYOUT.marginy + REF_GAP;
    const row = refs.reduce((w, n) => w + nodeBoxSize(n).width, 0) + LAYOUT.nodesep * (refs.length - 1);
    const source = view.edges.find((e) => e.kind === 'link')?.source;
    const anchor = source ? boxes.get(source) : undefined;
    const middle = anchor ? anchor.x + anchor.width / 2 : width / 2;
    let x = Math.max(LAYOUT.marginx, Math.min(middle - row / 2, width - LAYOUT.marginx - row));
    width = Math.max(width, row + 2 * LAYOUT.marginx);
    height += REF_GAP + COMPACT_HEIGHT;
    for (const n of refs) {
      const s = nodeBoxSize(n);
      positions.set(n.id, { x: Math.round(x), y });
      boxes.set(n.id, { x: Math.round(x), y, width: s.width, height: s.height });
      x += s.width + LAYOUT.nodesep;
    }
  }
  return { width, height: height + (hasNote(view) ? NOTE_ROOM : 0), boxes, positions, frame };
}

// ---------- Холст ----------

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export interface Canvas {
  width: number;
  height: number;
}

export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 1.5;
/** Масштаб при открытии не ниже этого: мельче текст не читается, остальное двигается панорамой. */
export const FIT_MIN_ZOOM = 0.75;
/** От этого значения масштаб округляется до 1: иначе текст размывается. */
export const FIT_ROUND_FROM = 0.97;
/** Поля холста, которые масштаб не считает. */
export const CANVAS_PAD = 12;
/** Сколько граф может отойти от края холста при панораме. */
const PAN_ROOM = 48;

/** Масштаб при открытии: min(1, ширина холста без полей / ширина графа), не меньше 0,75, от 0,97 — 1. */
export function fitZoom(canvasWidth: number, graphWidth: number): number {
  if (graphWidth <= 0) return 1;
  const raw = Math.min(1, (canvasWidth - 2 * CANVAS_PAD) / graphWidth);
  return raw >= FIT_ROUND_FROM ? 1 : Math.max(FIT_MIN_ZOOM, raw);
}

const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

/** Граф уже холста — по центру, шире — край не отходит от края холста дальше запаса. */
function constrainAxis(at: number, size: number, view: number): number {
  if (size <= view) return (view - size) / 2;
  return Math.min(PAN_ROOM, Math.max(view - size - PAN_ROOM, at));
}

export function constrainViewport(v: Viewport, canvas: Canvas, graph: Size): Viewport {
  return {
    x: constrainAxis(v.x, graph.width * v.zoom, canvas.width),
    y: constrainAxis(v.y, graph.height * v.zoom, canvas.height),
    zoom: v.zoom,
  };
}

/** Сдвиг, при котором узел виден целиком, масштаб тот же; узел и так виден — сдвига нет. */
export function revealViewport(v: Viewport, box: Box, canvas: Canvas, pad = 16): Viewport {
  const fit = (at: number, from: number, size: number, view: number) => {
    const start = at + from * v.zoom;
    const end = start + size * v.zoom;
    if (start - pad < 0) return pad - from * v.zoom;
    if (end + pad > view) return size * v.zoom + 2 * pad > view ? pad - from * v.zoom : view - pad - (from + size) * v.zoom;
    return at;
  };
  return { x: fit(v.x, box.x, box.width, canvas.width), y: fit(v.y, box.y, box.height, canvas.height), zoom: v.zoom };
}

/** Высота панели масштаба в правом нижнем углу холста вместе с отступом: короткий граф встаёт по центру над ней. */
export const CONTROLS_ROOM = 48;

/** Вид при открытии и по «Вписать»: масштаб по правилу, короткий граф по центру, выбранный узел виден. */
export function fitViewport(canvas: Canvas, graph: Size, selected?: Box): Viewport {
  const zoom = fitZoom(canvas.width, graph.width);
  const at = (size: number, view: number) => (size * zoom <= view ? (view - size * zoom) / 2 : 0);
  const v = { x: at(graph.width, canvas.width), y: at(graph.height, Math.max(0, canvas.height - CONTROLS_ROOM)), zoom };
  return selected ? constrainViewport(revealViewport(v, selected, canvas), canvas, graph) : v;
}

/** Масштаб вокруг точки холста: точка под указателем остаётся на месте. */
export function zoomAround(v: Viewport, zoom: number, point: { x: number; y: number }): Viewport {
  const next = clampZoom(zoom);
  const k = next / v.zoom;
  return { x: point.x - (point.x - v.x) * k, y: point.y - (point.y - v.y) * k, zoom: next };
}

/** Раскрытие и сворачивание: переключённый узел остаётся на том же месте экрана. */
export function keepInPlace(v: Viewport, before: Box | undefined, after: Box | undefined): Viewport {
  if (!before || !after) return v;
  return { ...v, x: v.x - (after.x - before.x) * v.zoom, y: v.y - (after.y - before.y) * v.zoom };
}

/** Сколько шагов целиком правее видимой части: подпись на холсте. */
export function stepsToRight(boxes: Iterable<[string, Box]>, isStep: (id: string) => boolean, v: Viewport, canvas: Canvas): number {
  let n = 0;
  for (const [id, b] of boxes) if (isStep(id) && v.x + b.x * v.zoom >= canvas.width) n++;
  return n;
}
