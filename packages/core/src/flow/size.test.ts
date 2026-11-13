import { describe, expect, it } from 'vitest';
import { visibleGraph } from './budget.ts';
import { canvasSize, COMPACT_HEIGHT, DB_WIDTH, ENTRY_WIDTH, FRAME, GROUP_HEADER, JUNCTION_SIZE, LAYOUT, NODE_HEIGHT, NODE_WIDTH, nodeBoxSize, nodeSize, PARALLEL_WIDTH, PAUSE_HEIGHT, PAUSE_WIDTH, REF_WIDTH, RETRY_WIDTH } from './size.ts';
import { FlowFixture } from './test-flow.ts';

const M = 2 * LAYOUT.marginx;
/** Промежуток между обычными узлами: ребро идёт через два слоя. */
const GAP = 2 * LAYOUT.ranksep;

describe('canvasSize', () => {
  it('цепочка из четырёх узлов — одна строка', () => {
    const f = new FlowFixture();
    f.entry(0);
    f.exchange(10, 20, { uri: 'https://a.pay.example/x' });
    f.exchange(30, 40, { uri: 'https://b.pay.example/x' });
    f.exchange(50, 60, { uri: 'https://c.pay.example/x' });
    const view = visibleGraph(f.graph(), new Set());
    expect(canvasSize(view)).toEqual({ width: ENTRY_WIDTH + 3 * NODE_WIDTH + 3 * GAP + M, height: NODE_HEIGHT + 2 * LAYOUT.marginy });
  });

  it('рамка проекта добавляет шапку и поля', () => {
    const f = new FlowFixture();
    f.entry(0);
    f.exchange(10, 20, { uri: 'https://a.pay.example/x' });
    const view = visibleGraph(f.graph(), new Set());
    const plain = canvasSize(view);
    expect(canvasSize(view, null, true)).toEqual({ width: plain.width + FRAME.right, height: plain.height + FRAME.top + FRAME.bottom });
  });

  it('развилка на две ветки — два узла в столбце и точка слияния', () => {
    const f = new FlowFixture();
    f.entry(0);
    f.exchange(10, 100, { uri: 'https://a.pay.example/x' });
    f.exchange(20, 90, { uri: 'https://b.pay.example/x' });
    f.exchange(200, 220, { uri: 'https://c.pay.example/x' });
    const view = visibleGraph(f.graph(), new Set());
    const s = canvasSize(view);
    expect(s.height).toBe(2 * NODE_HEIGHT + LAYOUT.nodesep + 2 * LAYOUT.marginy);
    // Столбцы: вход, ветки, слияние, следующий шаг. Через слияние — по слою с каждой стороны.
    expect(s.width).toBe(ENTRY_WIDTH + GAP + NODE_WIDTH + LAYOUT.ranksep + JUNCTION_SIZE + LAYOUT.ranksep + NODE_WIDTH + M);
  });

  it('раскрытая группа — рамка по своей раскладке и шапке', () => {
    const f = new FlowFixture();
    f.entry(0);
    f.call(5, 'hold');
    for (let i = 0; i < 3; i++) f.exchange(10 + i * 20, 20 + i * 20, { uri: 'https://ledger.pay.example/hold', body: '<Envelope><Body><hold/></Body></Envelope>' });
    const g = f.graph();
    const group = g.root.nodes[1]!;
    const closed = visibleGraph(g, new Set());
    const open = visibleGraph(g, new Set([group]));
    const inner = canvasSize(open, group);
    expect(inner.width).toBe(3 * NODE_WIDTH + 2 * GAP + M);
    const frame = nodeSize(open, open.nodes.find((n) => n.id === group)!);
    expect(frame).toEqual({ width: Math.max(NODE_WIDTH, inner.width), height: inner.height + GROUP_HEADER });
    expect(canvasSize(open).width - canvasSize(closed).width).toBe(frame.width - NODE_WIDTH);
  });

  it('размер узла задан его видом', () => {
    const group = (kind: 'retry' | 'poll' | 'errors' | 'parallel' | 'more' | 'call') => ({ kind: 'group' as const, group: { kind } as never });
    expect(nodeBoxSize({ kind: 'entry', group: null })).toEqual({ width: ENTRY_WIDTH, height: NODE_HEIGHT });
    expect(nodeBoxSize({ kind: 'db', group: null })).toEqual({ width: DB_WIDTH, height: NODE_HEIGHT });
    for (const kind of ['exchange', 'fn', 'async-start'] as const) expect(nodeBoxSize({ kind, group: null })).toEqual({ width: NODE_WIDTH, height: NODE_HEIGHT });
    expect(nodeBoxSize(group('retry'))).toEqual({ width: RETRY_WIDTH, height: NODE_HEIGHT });
    expect(nodeBoxSize({ kind: 'flow-ref', group: null })).toEqual({ width: REF_WIDTH, height: COMPACT_HEIGHT });
    expect(nodeBoxSize(group('parallel'))).toEqual({ width: PARALLEL_WIDTH, height: COMPACT_HEIGHT });
    for (const kind of ['pause', 'wait'] as const) expect(nodeBoxSize({ kind, group: null })).toEqual({ width: PAUSE_WIDTH, height: PAUSE_HEIGHT });
    expect(nodeBoxSize({ kind: 'junction', group: null })).toEqual({ width: JUNCTION_SIZE, height: JUNCTION_SIZE });
  });

  it('пустой вид — только поля', () => {
    expect(canvasSize({ nodes: [], edges: [] })).toEqual({ width: M, height: 2 * LAYOUT.marginy });
  });
});
