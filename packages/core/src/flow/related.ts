// Узлы-ссылки на более поздние потоки операции.
import type { Builder } from './graph.ts';
import { edge, newNode } from './graph.ts';
import { MAX_RELATED, TOGETHER_MS, type FlowContainer, type FlowNode, type RelatedFlow } from './model.ts';
import { markText } from './text.ts';

/** Ключ потока: correlation_id и номер сегмента. */
export const relatedKey = (r: { cid: string; segment: number | null }): string => (r.segment === null ? r.cid : `${r.cid}#${r.segment}`);

/** Узел с ключом операции: начало операции, иначе вход с ключом, иначе последний узел с ключом, иначе последний. */
function anchorOf(b: Builder, root: FlowContainer, entry: FlowNode): FlowNode {
  const nodes = root.nodes.map((id) => b.nodes[id]!).filter((n) => n.kind !== 'junction' && n.kind !== 'flow-ref');
  const start = [...nodes].reverse().find((n) => n.kind === 'async-start');
  if (start) return start;
  if (entry.opKey) return entry;
  return [...nodes].reverse().find((n) => n.opKey) ?? nodes[nodes.length - 1] ?? entry;
}

/** До 5 узлов-ссылок; больше — 4 ссылки и «ещё N потоков операции». */
export function attachRelated(b: Builder, root: FlowContainer, entry: FlowNode, related: readonly RelatedFlow[], startTimeMs: number): void {
  if (related.length === 0) return;
  const anchor = anchorOf(b, root, entry);
  const anchorEnd = startTimeMs + anchor.endMs;
  const list = [...related].sort((x, y) => x.firstMs - y.firstMs || (x.cid < y.cid ? -1 : x.cid > y.cid ? 1 : 0) || (x.segment ?? 0) - (y.segment ?? 0));
  const shown = list.length > MAX_RELATED ? list.slice(0, MAX_RELATED - 1) : list;
  for (const r of shown) {
    const gap = r.firstMs - anchorEnd;
    // Сегменты одного correlation_id — разные потоки: узел у каждого свой.
    const id = `ref:${relatedKey(r)}`;
    b.nodes[id] = newNode(id, {
      kind: 'flow-ref',
      name: r.title,
      tech: r.key.name,
      startMs: r.firstMs - startTimeMs,
      endMs: r.lastMs - startTimeMs,
      durationMs: Math.max(0, r.lastMs - r.firstMs),
      outcome: { tone: r.error ? 'error' : 'none', reason: null, http: null, noResponse: false, pending: false, noSend: false },
      opStatus: r.opStatus ? { status: r.opStatus, claimed: r.claimed } : null,
      related: r,
      mark: r.role === 'callback' && anchor.kind === 'async-start' && r.firstMs < anchorEnd ? { kind: 'callback-early' } : null,
    });
    root.nodes.push(id);
    root.edges.push(edge(anchor.id, id, 'link', { kind: 'key', type: r.key.type, name: r.key.name, together: gap < TOGETHER_MS, pauseMs: Math.max(0, Math.round(gap)) }));
  }
  const rest = list.length - shown.length;
  if (rest > 0) {
    const id = 'ref:more';
    const mark = { kind: 'related', count: rest } as const;
    b.nodes[id] = newNode(id, { kind: 'flow-ref', name: markText(mark), mark, startMs: list[shown.length]!.firstMs - startTimeMs });
    root.nodes.push(id);
    root.edges.push(edge(anchor.id, id, 'link'));
  }
}
