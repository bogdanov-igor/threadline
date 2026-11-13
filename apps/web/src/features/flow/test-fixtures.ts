// Синтетические узлы и графы для модульных тестов графа. Данных из logs.md здесь нет.
import type { FlowEdge, FlowView, FlowViewNode } from './model.ts';

export function vnode(id: string, over: Partial<FlowViewNode> = {}): FlowViewNode {
  return {
    id,
    kind: 'exchange',
    entry: null,
    stepIds: [id],
    logIds: [],
    unread: false,
    name: 'Карточный коммутатор',
    tech: 'POST /v3/cards/info',
    plain: 'Данные карты',
    path: '/v3/cards/info',
    component: 'switch.pay.example',
    startMs: 100,
    endMs: 113,
    durationMs: 13,
    share: 0.1,
    outcome: { tone: 'success', reason: null, http: 200, noResponse: false, pending: false, noSend: false },
    mark: null,
    opStatus: null,
    badges: { total: 0, warning: 0, error: 0 },
    opKey: null,
    group: null,
    lane: 0,
    laneCount: 0,
    block: null,
    select: id,
    related: null,
    parentId: null,
    expanded: false,
    expandable: false,
    listed: false,
    startShare: 0,
    attempts: null,
    memberNames: null,
    covers: [id],
    parts: null,
    ...over,
  };
}

export const edge = (
  source: string,
  target: string,
  kind: FlowEdge['kind'] = 'next',
  hint: FlowEdge['hint'] = null,
): FlowEdge => ({
  id: `${source}>${target}`,
  source,
  target,
  kind,
  hint,
});

/** Цепочка: вход и n обменов по порядку. */
export function chain(n: number): FlowView {
  const nodes = [vnode('in', { kind: 'entry', entry: 'request', startMs: 0, name: 'Вход' })];
  const edges: FlowEdge[] = [];
  for (let i = 1; i <= n; i++) {
    nodes.push(vnode(`s${i}`, { startMs: i * 100 }));
    edges.push(edge(nodes[i - 1]!.id, `s${i}`));
  }
  return { nodes, edges };
}

/** Развилка: вход → ветки (по узлу на ветку, кроме длин из lengths) → слияние → последний шаг. */
export function fork(lengths: number[]): FlowView {
  const nodes: FlowViewNode[] = [vnode('in', { kind: 'entry', entry: 'request', startMs: 0, name: 'Вход' })];
  const edges: FlowEdge[] = [];
  lengths.forEach((len, li) => {
    let prev = 'in';
    for (let k = 0; k < len; k++) {
      const id = `b${li + 1}.${k + 1}`;
      nodes.push(vnode(id, { startMs: 100 + li * 5 + k * 50, lane: li + 1, block: 'j' }));
      edges.push(
        edge(
          prev,
          id,
          prev === 'in' ? 'fork' : 'next',
          prev === 'in' && li === 0 ? { kind: 'parallel', count: lengths.length } : null,
        ),
      );
      prev = id;
    }
    edges.push(edge(prev, 'j', 'join'));
  });
  nodes.push(vnode('j', { kind: 'junction', stepIds: [], covers: [] }));
  nodes.push(vnode('last', { startMs: 900 }));
  edges.push(edge('j', 'last'));
  return { nodes, edges };
}
