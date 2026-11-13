// Бюджет видимых узлов и видимая часть графа: что входит в бюджет, ошибки в бюджете, раскрытие групп.
import type { Builder, Item, Unit } from './graph.ts';
import { isLanes, linkSequence, newNode } from './graph.ts';
import {
  MAX_ERRORS,
  MAX_EXPANDED,
  MAX_RELATED,
  MAX_VISIBLE,
  PAUSE_NODE_MS,
  type FlowAttemptCell,
  type FlowContainer,
  type FlowGraph,
  type FlowNode,
  type FlowView,
  type FlowViewNode,
  type GroupKind,
} from './model.ts';

/** Группы, которые показывают части списком в панели шага и на графе не раскрываются. */
const LISTED: ReadonlySet<GroupKind> = new Set(['retry', 'poll', 'errors', 'parallel']);

const itemCount = (it: Item): number => (isLanes(it) ? it.lanes.reduce((n, l) => n + l.length, 0) + 1 : 1);

const itemNodes = (it: Item): FlowNode[] => (isLanes(it) ? it.lanes.flat().flatMap(itemNodes) : [it.node]);

const itemError = (it: Item): string | null => {
  if (!isLanes(it)) return it.node.outcome.tone === 'error' ? (it.errorKey ?? it.node.id) : null;
  for (const l of it.lanes) for (const u of l) if (!isLanes(u) && u.node.outcome.tone === 'error') return u.errorKey ?? u.node.id;
  return null;
};

const isOperation = (it: Item) => itemNodes(it).some((n) => n.kind === 'async-start' || n.group?.kind === 'poll');

interface Mandatory {
  neighbors: boolean;
  operations: boolean;
  errorsCap: number;
  /** Только первая ошибка каждого ключа. */
  firstOnly: boolean;
}

/** Обязательные единицы: последний шаг, узлы операции, не больше 15 ошибок (первая каждого ключа, затем по времени) и их соседи. */
function mandatory(items: readonly Item[], m: Mandatory): boolean[] {
  const keep = items.map(() => false);
  if (items.length > 0) keep[items.length - 1] = true;
  if (m.operations) items.forEach((it, i) => (keep[i] ||= isOperation(it)));
  const errors = items.map((it, i) => ({ i, key: itemError(it) })).filter((e) => e.key !== null);
  const chosen = new Set<number>();
  const seen = new Set<string>();
  for (const e of errors) {
    if (chosen.size >= m.errorsCap) break;
    if (!seen.has(e.key!)) {
      seen.add(e.key!);
      chosen.add(e.i);
    }
  }
  if (!m.firstOnly) for (const e of errors) if (chosen.size < m.errorsCap) chosen.add(e.i);
  for (const i of chosen) {
    keep[i] = true;
    if (m.neighbors) {
      if (i > 0) keep[i - 1] = true;
      if (i + 1 < items.length) keep[i + 1] = true;
    }
  }
  return keep;
}

// Участок с ветками длиннее этого сворачивается изнутри: один занял бы весь бюджет, а целиком он не сворачивается,
// если стоит последним. Внутри ветки остаются её конец и первая ошибка каждого ключа.
const MAX_LANES_BLOCK = 20;
const LANE_LEVEL: Mandatory = { neighbors: false, operations: false, errorsCap: 5, firstOnly: true };

function shrinkLanes(b: Builder, items: readonly Item[]): Item[] {
  return items.map((it) => {
    if (!isLanes(it) || itemCount(it) <= MAX_LANES_BLOCK) return it;
    return {
      ...it,
      lanes: it.lanes.map((lane) => {
        if (lane.length <= 3) return lane;
        const keep = mandatory(lane, LANE_LEVEL);
        keep[0] = true;
        return collapse(b, lane, planCollapse(lane, keep, Infinity).windows);
      }),
    };
  });
}

/**
 * Свёртка длинных участков без обязательных узлов в «ещё N шагов», пока видимых узлов не больше 60.
 * related — число более поздних потоков операции: их узлы-ссылки тоже занимают бюджет.
 */
export function applyBudget(b: Builder, _entry: FlowNode, source: readonly Item[], related: number): Item[] {
  const refs = Math.min(related, MAX_RELATED);
  // Узел паузы тоже занимает место на холсте.
  const pauses = (list: readonly Item[]) => list.reduce((n, it, i) => n + (i > 0 && it.start - list[i - 1]!.end >= PAUSE_NODE_MS ? 1 : 0), 0);
  const count = (list: readonly Item[]) => 1 + refs + pauses(list) + list.reduce((n, it) => n + itemCount(it), 0);
  if (count(source) <= MAX_VISIBLE) return [...source];
  const items = shrinkLanes(b, source);
  const total = count(items);
  if (total <= MAX_VISIBLE) return items;
  const levels: Mandatory[] = [
    { neighbors: true, operations: true, errorsCap: MAX_ERRORS, firstOnly: false },
    { neighbors: false, operations: true, errorsCap: MAX_ERRORS, firstOnly: false },
    { neighbors: false, operations: false, errorsCap: MAX_ERRORS, firstOnly: true },
    { neighbors: false, operations: false, errorsCap: 0, firstOnly: true },
  ];
  for (const level of levels) {
    const plan = planCollapse(items, mandatory(items, level), total - MAX_VISIBLE);
    if (plan.fits || level === levels[levels.length - 1]) return collapse(b, items, plan.windows);
  }
  return [...items];
}

/** Окна свёртки [from, to) по участкам без обязательных узлов: длинные сначала, из середины участка. */
function planCollapse(items: readonly Item[], keep: readonly boolean[], excess: number): { windows: [number, number][]; fits: boolean } {
  const runs: [number, number][] = [];
  for (let i = 0; i < items.length; ) {
    if (keep[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < items.length && !keep[j]) j++;
    runs.push([i, j]);
    i = j;
  }
  const sum = (a: number, z: number) => items.slice(a, z).reduce((n, it) => n + itemCount(it), 0);
  runs.sort((x, y) => sum(y[0], y[1]) - sum(x[0], x[1]) || x[0] - y[0]);
  const windows: [number, number][] = [];
  let left = excess;
  for (const [a, z] of runs) {
    if (left <= 0) break;
    const n = sum(a, z);
    if (n <= 1) continue;
    if (n - 1 <= left) {
      windows.push([a, z]);
      left -= n - 1;
      continue;
    }
    // Хватает части участка: окно из середины, чтобы края у обязательных узлов остались видны.
    const mid = Math.floor((a + z - 1) / 2);
    let lo = mid;
    let hi = mid + 1;
    while (sum(lo, hi) - 1 < left) {
      if (lo > a && (hi >= z || mid - lo <= hi - mid - 1)) lo--;
      else if (hi < z) hi++;
      else break;
    }
    windows.push([lo, hi]);
    left -= sum(lo, hi) - 1;
  }
  windows.sort((x, y) => x[0] - y[0]);
  return { windows, fits: left <= 0 };
}

function collapse(b: Builder, items: readonly Item[], windows: readonly [number, number][]): Item[] {
  const out: Item[] = [];
  let i = 0;
  for (const [a, z] of windows) {
    out.push(...items.slice(i, a));
    out.push(moreGroup(b, items.slice(a, z)));
    i = z;
  }
  out.push(...items.slice(i));
  return out;
}

/** Группа «ещё N шагов»: своя последовательность с ветками и группами; с ошибками — красная. */
function moreGroup(b: Builder, part: readonly Item[]): Unit {
  const nodes = part.flatMap(itemNodes);
  const first = nodes[0]!;
  let id = `g:${first.stepIds[0] ?? first.id}`;
  while (b.nodes[id]) id = `g:${id}`;
  const children: FlowContainer = { nodes: [], edges: [] };
  linkSequence(b, children, part, { from: null, end: null });
  for (const c of children.nodes) b.parent.set(c, id);
  const leaves: FlowNode[] = [];
  const walk = (n: FlowNode) => {
    if (n.kind === 'junction' || n.kind === 'pause') return;
    if (n.group) n.group.children.nodes.forEach((c) => walk(b.nodes[c]!));
    else leaves.push(n);
  };
  nodes.forEach(walk);
  const errors = nodes.reduce((n, x) => n + (x.group ? x.group.errors : x.outcome.tone === 'error' ? 1 : 0), 0);
  const firstError = nodes.find((n) => n.outcome.tone === 'error');
  const last = nodes[nodes.length - 1]!;
  const rep = firstError ?? last;
  const representative = rep.group?.representative ?? rep.select ?? rep.stepIds[0] ?? rep.id;
  const start = Math.min(...part.map((p) => p.start));
  const end = Math.max(...part.map((p) => p.end));
  const node = newNode(id, {
    kind: 'group',
    select: representative,
    name: rep.name,
    tech: rep.tech,
    plain: rep.plain,
    path: rep.path,
    component: rep.component,
    startMs: start,
    endMs: end,
    durationMs: Math.round((end - start) * 1000) / 1000,
    share: b.totalMs > 0 ? Math.min(1, (end - start) / b.totalMs) : 0,
    outcome: errors > 0 ? { ...(firstError?.outcome ?? rep.outcome), tone: 'error' } : { tone: 'none', reason: null, http: null, noResponse: false, pending: false, noSend: false },
    mark: { kind: 'more', count: leaves.length, errors },
    badges: nodes.reduce(
      (acc, n) => ({ total: acc.total + n.badges.total, warning: acc.warning + n.badges.warning, error: acc.error + n.badges.error }),
      { total: 0, warning: 0, error: 0 },
    ),
    group: {
      kind: 'more',
      count: leaves.length,
      failed: errors,
      errors,
      representative,
      children,
      cost: children.nodes.length,
    },
  });
  b.nodes[id] = node;
  const order = isLanes(part[0]!) ? part[0]!.order : part[0]!.order;
  return { node, start, end, order, retryKey: null, pollKey: null, errorKey: null, failed: errors > 0, asyncStart: false };
}

// ---------- Видимая часть ----------

function attemptCells(graph: FlowGraph, children: readonly string[]): FlowAttemptCell[] {
  return children.map((id) => {
    const n = graph.nodes[id]!;
    return { stepId: n.group ? n.group.representative : (n.select ?? n.stepIds[0] ?? n.id), tone: n.outcome.tone };
  });
}

function memberNames(graph: FlowGraph, children: readonly string[]): string[] {
  return [...new Set(children.map((id) => graph.nodes[id]!).filter((n) => n.kind !== 'junction' && n.kind !== 'pause').map((n) => n.name))];
}

/** Все шаги и записи-логи под узлом. */
export function coveredSteps(graph: FlowGraph, id: string): string[] {
  const n = graph.nodes[id];
  if (!n) return [];
  const own = [...n.stepIds, ...n.logIds];
  if (!n.group) return own;
  return [...own, ...n.group.children.nodes.flatMap((c) => coveredSteps(graph, c))];
}

/** Шаги под узлом без записей-логов: «шаг 2 из 3» считает только их. */
function stepsOnly(graph: FlowGraph, id: string): string[] {
  const n = graph.nodes[id];
  if (!n) return [];
  return n.group ? [...n.stepIds, ...n.group.children.nodes.flatMap((c) => stepsOnly(graph, c))] : n.stepIds;
}

/**
 * Видимый граф при раскрытых группах. Раскрытие не поднимает число видимых узлов выше 100: такая группа
 * не раскрывается, у неё expandable = false («Открыть на шкале времени»).
 */
export function visibleGraph(graph: FlowGraph, expanded: ReadonlySet<string>): FlowView {
  const nodes: FlowViewNode[] = [];
  const edges = [...graph.root.edges];
  let total = graph.root.nodes.length;
  const part = (c: string) => graph.nodes[c]!.kind !== 'junction' && graph.nodes[c]!.kind !== 'pause';
  const startShare = (n: FlowNode) => (graph.totalMs > 0 ? Math.min(1, Math.max(0, n.startMs / graph.totalMs)) : 0);
  const emit = (container: FlowContainer, parentId: string | null) => {
    for (const id of container.nodes) {
      const n = graph.nodes[id]!;
      const g = n.group;
      const listed = g !== null && LISTED.has(g.kind);
      const fits = g !== null && !listed && total + g.cost <= MAX_EXPANDED;
      const open = g !== null && expanded.has(id) && fits;
      if (open) total += g.cost;
      nodes.push({
        ...n,
        parentId,
        expanded: open,
        expandable: g !== null && (open || fits),
        listed,
        startShare: startShare(n),
        attempts: g && listed && g.kind !== 'parallel' ? attemptCells(graph, g.children.nodes) : null,
        memberNames: g?.kind === 'parallel' ? memberNames(graph, g.children.nodes) : null,
        covers: open ? [...n.stepIds, ...n.logIds] : coveredSteps(graph, id),
        parts: g && !open ? g.children.nodes.filter(part).map((c) => stepsOnly(graph, c)) : null,
      });
      if (open) {
        edges.push(...g.children.edges);
        emit(g.children, id);
      }
    }
  };
  emit(graph.root, null);
  return { nodes, edges };
}
