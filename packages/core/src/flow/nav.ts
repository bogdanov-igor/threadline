// Клавиатура графа и выбор шага: граф идёт слева направо, →/← — вдоль рёбер, ↑/↓ — соседняя ветка.
import type { FlowEdge, FlowView, FlowViewNode } from './model.ts';

export type NavKey = 'ArrowDown' | 'ArrowUp' | 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End';

/** Слияние и долгая пауза шага не несут: клавиатура проходит сквозь них. */
const transit = (n: FlowViewNode | undefined) => n?.kind === 'junction' || n?.kind === 'pause';
const focusable = (n: FlowViewNode) => !transit(n);

/** Узел, куда ведёт клавиша, или null: выбор не меняется. */
export function nextNode(view: FlowView, key: NavKey, current: string | null): string | null {
  const nodes = view.nodes.filter(focusable);
  if (nodes.length === 0) return null;
  if (key === 'Home') return nodes[0]!.id;
  if (key === 'End') return nodes[nodes.length - 1]!.id;
  const byId = new Map(view.nodes.map((n) => [n.id, n]));
  const cur = current ? byId.get(current) : undefined;
  if (!cur) return nodes[0]!.id;
  const out = (id: string, kinds?: FlowEdge['kind'][]) =>
    view.edges.filter((e) => e.source === id && (!kinds || kinds.includes(e.kind)));
  const into = (id: string) => view.edges.filter((e) => e.target === id && e.kind !== 'link');
  const flow: FlowEdge['kind'][] = ['next', 'fork', 'join', 'retry', 'poll'];
  // Узлы-ссылки на потоки операции идут списком: рёбра у них только от узла с ключом.
  const refs = nodes.filter((n) => n.kind === 'flow-ref');
  const refAt = refs.findIndex((n) => n.id === cur.id);

  /** Вперёд от узла: первая ветка развилки; через слияние и паузу — к узлу за ними. */
  const forward = (id: string): string | null => {
    const e = out(id, flow)[0];
    if (!e) return null;
    return transit(byId.get(e.target)) ? forward(e.target) : e.target;
  };
  /** Назад от узла: первое входящее ребро; через слияние и паузу — к узлу перед ними. */
  const backward = (id: string): string | null => {
    const e = into(id)[0];
    if (!e) return null;
    return transit(byId.get(e.source)) ? backward(e.source) : e.source;
  };

  switch (key) {
    case 'ArrowRight': {
      if (refAt >= 0) return refs[refAt + 1]?.id ?? null;
      if (cur.expanded) {
        const child = view.nodes.find((n) => n.parentId === cur.id && focusable(n));
        if (child) return child.id;
      }
      for (let n: FlowViewNode | undefined = cur; n; n = n.parentId ? byId.get(n.parentId) : undefined) {
        const next = forward(n.id);
        if (next) return next;
        if (!n.parentId) break;
      }
      // С последнего узла потока — к первой ссылке, откуда бы ни шло её ребро.
      return refs[0]?.id ?? null;
    }
    case 'ArrowLeft': {
      if (refAt > 0) return refs[refAt - 1]!.id;
      const prev = backward(cur.id);
      if (prev) return prev;
      const link = view.edges.find((x) => x.target === cur.id && x.kind === 'link');
      if (link) return link.source;
      return cur.parentId;
    }
    case 'ArrowUp':
    case 'ArrowDown': {
      if (refAt >= 0) return refs[refAt + (key === 'ArrowDown' ? 1 : -1)]?.id ?? null;
      if (cur.lane === 0 || cur.block === null) return null;
      const lane = cur.lane + (key === 'ArrowDown' ? 1 : -1);
      const peers = view.nodes.filter((n) => n.block === cur.block && n.lane === lane && n.parentId === cur.parentId && focusable(n));
      if (peers.length === 0) return null;
      let best = peers[0]!;
      for (const p of peers) if (Math.abs(p.startMs - cur.startMs) < Math.abs(best.startMs - cur.startMs)) best = p;
      return best.id;
    }
  }
  return null;
}

/** Шаг, который выбирает клик по узлу: у группы — первая ошибка, иначе последняя попытка. */
export function representative(node: FlowViewNode): string | null {
  return node.group && !node.expanded ? node.group.representative : (node.select ?? node.stepIds[0] ?? null);
}

/** Видимый узел шага: свёрнутая группа даёт «шаг index из of» и не раскрывается. */
export function locate(view: FlowView, stepId: string): { nodeId: string; index: number; of: number } | null {
  for (let i = view.nodes.length - 1; i >= 0; i--) {
    const n = view.nodes[i]!;
    if (!n.covers.includes(stepId)) continue;
    if (n.parts) {
      const k = n.parts.findIndex((p) => p.includes(stepId));
      // Запись-лог группы шагом не считается: «шаг N из M» к ней не относится.
      if (k < 0) return { nodeId: n.id, index: 1, of: 1 };
      return { nodeId: n.id, index: k + 1, of: n.parts.length };
    }
    return { nodeId: n.id, index: 1, of: 1 };
  }
  return null;
}
