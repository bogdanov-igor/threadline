// Список частей свёрнутой группы в панели шага и полоска попыток на узле.
import type { FlowAttemptCell, FlowGraph, FlowNode, FlowOutcome, GroupKind } from './model.ts';

/** До 12 попыток клетки 6 px, до 24 — 4 px; больше — последние 24 и знак «…». */
export const MAX_ATTEMPT_CELLS = 24;

export interface AttemptStrip {
  cells: FlowAttemptCell[];
  /** Ширина клетки, px. */
  size: 6 | 4;
  /** Показаны не все: перед клетками стоит «…». */
  clipped: boolean;
}

export function attemptStrip(attempts: readonly FlowAttemptCell[]): AttemptStrip {
  return {
    cells: attempts.slice(-MAX_ATTEMPT_CELLS),
    size: attempts.length <= 12 ? 6 : 4,
    clipped: attempts.length > MAX_ATTEMPT_CELLS,
  };
}

/** Строка списка: попытка группы или вызов из свёрнутых веток. */
export interface GroupEntry {
  /** Номер в группе, с 1. */
  index: number;
  /** Шаг, который выбирает строка. */
  stepId: string;
  name: string;
  plain: string | null;
  startMs: number;
  durationMs: number | null;
  /** Пауза от конца предыдущей части; null — у первой и при пересечении. */
  pauseMs: number | null;
  outcome: FlowOutcome;
}

export interface StepGroup {
  id: string;
  kind: GroupKind;
  entries: GroupEntry[];
}

const LISTED: ReadonlySet<GroupKind> = new Set(['retry', 'poll', 'errors', 'parallel']);

function stepsUnder(graph: FlowGraph, n: FlowNode): string[] {
  const own = [...n.stepIds, ...n.logIds];
  return n.group ? [...own, ...n.group.children.nodes.flatMap((c) => stepsUnder(graph, graph.nodes[c]!))] : own;
}

/**
 * Группа каждого шага: панель шага показывает список её частей. Группа внутри свёрнутых веток важнее самих веток:
 * выбранная там попытка показывает свои соседние попытки.
 */
export function stepGroups(graph: FlowGraph): Map<string, StepGroup> {
  const out = new Map<string, StepGroup>();
  const visit = (n: FlowNode) => {
    const g = n.group;
    if (!g) return;
    if (LISTED.has(g.kind)) {
      let prevEnd: number | null = null;
      const entries: GroupEntry[] = [];
      for (const id of g.children.nodes) {
        const c = graph.nodes[id]!;
        if (c.kind === 'junction' || c.kind === 'pause') continue;
        const gap: number | null = prevEnd === null ? null : c.startMs - prevEnd;
        entries.push({
          index: entries.length + 1,
          stepId: c.group ? c.group.representative : (c.select ?? c.stepIds[0] ?? c.id),
          name: c.name,
          plain: c.plain,
          startMs: c.startMs,
          durationMs: c.durationMs,
          pauseMs: gap !== null && gap > 0 && g.kind !== 'parallel' ? gap : null,
          outcome: c.outcome,
        });
        prevEnd = c.endMs;
      }
      const group: StepGroup = { id: n.id, kind: g.kind, entries };
      for (const step of stepsUnder(graph, n)) if (!out.has(step)) out.set(step, group);
    }
    // Вложенная группа записывается раньше: первой ставится самая внутренняя.
  };
  const walk = (n: FlowNode) => {
    for (const id of n.group?.children.nodes ?? []) walk(graph.nodes[id]!);
    visit(n);
  };
  for (const id of graph.root.nodes) walk(graph.nodes[id]!);
  return out;
}

/** Номер видимого шага среди узлов потока: «шаг 3 из 3» в панели шага и в «Что случилось». */
export function stepOrder(graph: FlowGraph): { order: Map<string, number>; total: number } {
  const order = new Map<string, number>();
  let total = 0;
  for (const id of graph.root.nodes) {
    const n = graph.nodes[id]!;
    if (n.kind === 'junction' || n.kind === 'pause' || n.kind === 'flow-ref') continue;
    total++;
    for (const step of stepsUnder(graph, n)) if (!order.has(step)) order.set(step, total);
  }
  return { order, total };
}

const sameResult = (a: GroupEntry, b: GroupEntry) =>
  a.name === b.name &&
  a.outcome.tone === b.outcome.tone && a.outcome.reason === b.outcome.reason && a.outcome.http === b.outcome.http && a.outcome.noResponse === b.outcome.noResponse;

export type AttemptRow = { kind: 'entry'; entry: GroupEntry } | { kind: 'fold'; entries: GroupEntry[] };

/** Одинаковые попытки подряд свёрнуты: видны две первые и последняя. Выбранная остаётся видна всегда. */
export function foldAttempts(entries: readonly GroupEntry[], selected: string | null = null, opened: ReadonlySet<number> = new Set()): AttemptRow[] {
  const rows: AttemptRow[] = [];
  const row = (entry: GroupEntry) => rows.push({ kind: 'entry', entry });
  let i = 0;
  while (i < entries.length) {
    let j = i + 1;
    while (j < entries.length && sameResult(entries[i]!, entries[j]!)) j++;
    const run = entries.slice(i, j);
    if (run.length < 5 || run.some((e) => opened.has(e.index))) run.forEach(row);
    else {
      const middle = run.slice(2, -1);
      const at = middle.findIndex((e) => e.stepId === selected);
      row(run[0]!);
      row(run[1]!);
      if (at < 0) rows.push({ kind: 'fold', entries: middle });
      else {
        if (at > 0) rows.push({ kind: 'fold', entries: middle.slice(0, at) });
        row(middle[at]!);
        if (at < middle.length - 1) rows.push({ kind: 'fold', entries: middle.slice(at + 1) });
      }
      row(run[run.length - 1]!);
    }
    i = j;
  }
  return rows;
}
