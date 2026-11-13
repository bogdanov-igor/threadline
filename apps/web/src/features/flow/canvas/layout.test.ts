import { describe, expect, it } from 'vitest';
import { buildFlowGraph, visibleGraph } from '@threadline/core/flow';
import { buildTrace } from '@threadline/core/search';
import { FlowFixture } from '../../../../../../packages/core/src/flow/test-flow.ts';
import { attemptStrip, canvasSize, GROUP_HEADER, NODE_HEIGHT, nodeBoxSize, RETRY_WIDTH, type FlowView } from '../model.ts';
import { chain, edge, fork, vnode } from '../test-fixtures.ts';
import { constrainViewport, fitViewport, fitZoom, keepInPlace, layoutFlow, revealViewport, stepsToRight, zoomAround, type Box } from './layout.ts';

const overlap = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

function noOverlaps(view: FlowView) {
  const l = layoutFlow(view);
  const top = view.nodes.filter((n) => n.parentId === null);
  for (let i = 0; i < top.length; i++)
    for (let j = i + 1; j < top.length; j++) {
      expect(
        overlap(l.boxes.get(top[i]!.id)!, l.boxes.get(top[j]!.id)!),
        `${top[i]!.id} и ${top[j]!.id}`,
      ).toBe(false);
    }
}

/** Раскрытая группа ×3 в цепочке: рамка g и три попытки внутри с рёбрами повтора. */
function expandedRetry(): FlowView {
  const base = chain(1);
  const group = vnode('g', {
    startMs: 200,
    expanded: true,
    expandable: true,
    group: {
      kind: 'retry',
      count: 3,
      failed: 2,
      errors: 0,
      representative: 'a3',
      children: { nodes: [], edges: [] },
      cost: 3,
    },
    mark: { kind: 'retry', count: 3, failed: 2 },
  });
  const tries = ['a1', 'a2', 'a3'].map((id, i) => vnode(id, { parentId: 'g', startMs: 200 + i * 1000 }));
  return {
    nodes: [...base.nodes, group, ...tries, vnode('end', { startMs: 5000 })],
    edges: [
      ...base.edges,
      edge('s1', 'g'),
      edge('a1', 'a2', 'retry', { kind: 'pause', ms: 1000 }),
      edge('a2', 'a3', 'retry'),
      edge('g', 'end'),
    ],
  };
}

describe('layoutFlow', () => {
  it('цепочка: узлы слева направо по времени, прямоугольники не пересекаются', () => {
    const view = chain(5);
    const l = layoutFlow(view);
    const xs = view.nodes.map((n) => l.boxes.get(n.id)!.x);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    expect(new Set(xs).size).toBe(xs.length);
    // Все на одной линии: центры совпадают, хотя высоты могут отличаться.
    expect(new Set(view.nodes.map((n) => l.boxes.get(n.id)!.y)).size).toBe(1);
    for (const n of view.nodes) expect(l.boxes.get(n.id)).toMatchObject(nodeBoxSize(n));
    noOverlaps(view);
  });

  it('промежуток между шагами не меньше 64 px: на нём помещается подпись паузы', () => {
    const view = chain(2);
    const l = layoutFlow(view);
    const a = l.boxes.get('s1')!;
    const b = l.boxes.get('s2')!;
    expect(b.x - (a.x + a.width)).toBeGreaterThanOrEqual(64);
  });

  it('развилка: ветки одна под другой по началу, внутри ветки x растёт', () => {
    const view = fork([2, 1, 3]);
    const l = layoutFlow(view);
    const firstOf = (lane: number) => l.boxes.get(`b${lane}.1`)!;
    expect(firstOf(1).y).toBeLessThan(firstOf(2).y);
    expect(firstOf(2).y).toBeLessThan(firstOf(3).y);
    expect(firstOf(1).x).toBe(firstOf(2).x);
    expect(l.boxes.get('b3.2')!.x).toBeGreaterThan(l.boxes.get('b3.1')!.x);
    expect(l.boxes.get('b3.3')!.x).toBeGreaterThan(l.boxes.get('b3.2')!.x);
    expect(l.boxes.get('last')!.x).toBeGreaterThan(l.boxes.get('b3.3')!.x);
    noOverlaps(view);
  });

  it('размер графа равен canvasSize ядра: цепочка, ровная развилка, раскрытая группа', () => {
    for (const view of [chain(1), chain(7), fork([1, 1]), fork([2, 2, 2]), expandedRetry()]) {
      const l = layoutFlow(view);
      expect({ width: l.width, height: l.height }).toEqual(canvasSize(view));
      const framed = layoutFlow(view, { frame: true });
      expect({ width: framed.width, height: framed.height }).toEqual(canvasSize(view, null, true));
    }
  });

  it('раскрытая группа: дети внутри рамки под шапкой, позиции детей от угла рамки', () => {
    const view = expandedRetry();
    const l = layoutFlow(view);
    const frame = l.boxes.get('g')!;
    for (const id of ['a1', 'a2', 'a3']) {
      const b = l.boxes.get(id)!;
      expect(b.x).toBeGreaterThanOrEqual(frame.x);
      expect(b.y).toBeGreaterThanOrEqual(frame.y + GROUP_HEADER);
      expect(b.x + b.width).toBeLessThanOrEqual(frame.x + frame.width);
      expect(b.y + b.height).toBeLessThanOrEqual(frame.y + frame.height);
      const p = l.positions.get(id)!;
      expect({ x: frame.x + p.x, y: frame.y + p.y }).toEqual({ x: b.x, y: b.y });
    }
    expect(l.boxes.get('end')!.x).toBeGreaterThanOrEqual(frame.x + frame.width);
    noOverlaps(view);
  });

  it('один и тот же граф даёт те же координаты', () => {
    expect([...layoutFlow(fork([2, 3])).boxes]).toEqual([...layoutFlow(fork([2, 3])).boxes]);
  });

  it('раскрытие не двигает узлы левее группы', () => {
    const collapsed: FlowView = {
      nodes: [...chain(1).nodes, vnode('g', { startMs: 200, expandable: true }), vnode('end', { startMs: 5000 })],
      edges: [...chain(1).edges, edge('s1', 'g'), edge('g', 'end')],
    };
    const a = layoutFlow(collapsed);
    const b = layoutFlow(expandedRetry());
    expect(b.boxes.get('in')!.x).toBe(a.boxes.get('in')!.x);
    expect(b.boxes.get('s1')!.x).toBe(a.boxes.get('s1')!.x);
    expect(b.boxes.get('g')!.x).toBe(a.boxes.get('g')!.x);
  });

  it('рамка проекта: вокруг шагов, вход снаружи, узлы её не пересекают и подвеске есть место', () => {
    const view = chain(2);
    const l = layoutFlow(view, { frame: true });
    const f = l.frame!;
    const entry = l.boxes.get('in')!;
    expect(entry.x + entry.width).toBeLessThanOrEqual(f.x);
    for (const id of ['s1', 's2']) {
      const b = l.boxes.get(id)!;
      expect(b.y - f.y).toBeGreaterThanOrEqual(36);
      expect(f.y + f.height - (b.y + b.height)).toBeGreaterThanOrEqual(22);
      expect(f.x + f.width - (b.x + b.width)).toBeGreaterThanOrEqual(16);
    }
    expect(f.y).toBeGreaterThanOrEqual(0);
    expect(f.y + f.height).toBeLessThanOrEqual(l.height);
    expect(layoutFlow(chain(0), { frame: true }).frame).toBeNull();
  });

  it('пауза от минуты: узел до 140 px с местом в раскладке, рёбра через него', () => {
    const f = new FlowFixture();
    f.entry(0);
    f.exchange(10, 100, { uri: 'https://switch.pay.example/x' });
    f.exchange(1_215_100, 1_215_200, { uri: 'https://ledger.pay.example/y' });
    const view = visibleGraph(f.graph(), new Set());
    const pause = view.nodes.find((n) => n.kind === 'pause')!;
    const l = layoutFlow(view);
    const [a, b] = view.nodes.filter((n) => n.kind === 'exchange').map((n) => l.boxes.get(n.id)!);
    const p = l.boxes.get(pause.id)!;
    expect(p.width).toBeLessThanOrEqual(140);
    expect(p.height).toBe(40);
    expect(p.x).toBeGreaterThanOrEqual(a!.x + a!.width);
    expect(b!.x).toBeGreaterThanOrEqual(p.x + p.width);
  });
});

describe('крайние случаи графа', () => {
  const uri = 'https://ledger.pay.example:8443/api/v1/hold';
  const flow = (fill: (f: FlowFixture) => void) => {
    const f = new FlowFixture();
    f.entry(0);
    fill(f);
    const records = f.view();
    return visibleGraph(buildFlowGraph(buildTrace(records), records, { related: [] }), new Set());
  };

  it('99 попыток, все неудачные, 23 ч 59 м: один узел 280 px, в полоске 24 клетки по 4 px и «…»', () => {
    const view = flow((f) => {
      for (let i = 0; i < 99; i++) f.exchange(i * 871_000, i * 871_000 + 30_000, { uri, status: 500 });
    });
    const group = view.nodes.find((n) => n.group)!;
    expect(group.group).toMatchObject({ kind: 'retry', count: 99, failed: 99 });
    expect(nodeBoxSize(group)).toEqual({ width: RETRY_WIDTH, height: NODE_HEIGHT });
    expect(group.durationMs).toBeGreaterThan(23 * 3_600_000);
    const strip = attemptStrip(group.attempts!);
    expect(strip).toMatchObject({ size: 4, clipped: true });
    expect(strip.cells).toHaveLength(24);
    // Клетка и промежуток 2 px: полоска входит в узел вместе с подписью.
    expect(24 * (4 + 2) + 10).toBeLessThan(RETRY_WIDTH - 24 - 60);
    expect(layoutFlow(view).boxes.get(group.id)).toMatchObject({ width: RETRY_WIDTH, height: NODE_HEIGHT });
  });

  it('20 параллельных, два упали: три ветки с упавшими и «Ещё 17 параллельных», раскладка та же на любой ширине', () => {
    const view = flow((f) => {
      for (let i = 0; i < 20; i++) f.exchange(10 + i, 400 + i, { uri: `https://card${i}.pay.example/x`, status: i === 4 || i === 11 ? 500 : 200 });
    });
    const lanes = view.nodes.filter((n) => n.lane > 0);
    expect(lanes).toHaveLength(4);
    expect(lanes.filter((n) => !n.group && n.outcome.tone === 'error')).toHaveLength(2);
    const rest = lanes.find((n) => n.group)!;
    expect(rest.group).toMatchObject({ kind: 'parallel', count: 17 });
    expect(nodeBoxSize(rest)).toEqual({ width: 240, height: 64 });
    const l = layoutFlow(view);
    const ys = [...lanes].sort((a, b) => a.lane - b.lane).map((n) => l.boxes.get(n.id)!.y);
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
    expect(new Set(ys).size).toBe(4);
    noOverlaps(view);
  });

  it('связанные потоки — строкой под графом, не правее его', () => {
    const f = new FlowFixture();
    f.entry(0);
    f.exchange(10, 100, { uri });
    const related = [1, 2].map((i) => ({ cid: `c${i}`, segment: null, role: 'status' as const, title: `Опрос ${i}`, firstMs: 1e12 + i, lastMs: 1e12 + i + 1, error: false, opStatus: null, claimed: false, key: { type: 't', name: 'T' } }));
    const records = f.view();
    const view = visibleGraph(buildFlowGraph(buildTrace(records), records, { related }), new Set());
    const l = layoutFlow(view, { frame: true });
    const refs = view.nodes.filter((n) => n.kind === 'flow-ref').map((n) => l.boxes.get(n.id)!);
    expect(refs).toHaveLength(2);
    expect(refs[0]!.y).toBeGreaterThan(l.frame!.y + l.frame!.height);
    expect(refs[0]!.y).toBe(refs[1]!.y);
    expect(refs[1]!.x).toBeGreaterThan(refs[0]!.x + refs[0]!.width);
    expect(refs[0]!.y + refs[0]!.height).toBeLessThanOrEqual(l.height);
    expect(canvasSize(view, null, true).height).toBe(l.height);
  });
});

describe('холст', () => {
  it('масштаб при открытии: не больше 1, не меньше 0,75, от 0,97 — 1', () => {
    expect(fitZoom(1000, 600)).toBe(1);
    expect(fitZoom(2536, 600)).toBe(1);
    expect(fitZoom(876, 868)).toBe(1);
    expect(fitZoom(845, 844)).toBe(1);
    expect(fitZoom(800, 1000)).toBeCloseTo(0.776);
    expect(fitZoom(716, 4000)).toBe(0.75);
  });

  it('короткий граф по центру над панелью масштаба, длинный при 75 % показывает выбранный узел', () => {
    expect(fitViewport({ width: 1000, height: 500 }, { width: 600, height: 200 })).toEqual({ x: 200, y: 126, zoom: 1 });
    const v = fitViewport({ width: 716, height: 400 }, { width: 4000, height: 136 }, { x: 3000, y: 16, width: 232, height: 104 });
    expect(v.zoom).toBe(0.75);
    const left = v.x + 3000 * v.zoom;
    expect(left).toBeGreaterThanOrEqual(0);
    expect(left + 232 * v.zoom).toBeLessThanOrEqual(716);
  });

  it('узел за краем — сдвиг до него, видимый — вид тот же, масштаб не меняется', () => {
    const canvas = { width: 600, height: 400 };
    const v = { x: 0, y: 0, zoom: 1 };
    expect(revealViewport(v, { x: 16, y: 100, width: 232, height: 104 }, canvas)).toEqual(v);
    expect(revealViewport(v, { x: 900, y: 100, width: 232, height: 104 }, canvas)).toEqual({ x: 600 - 16 - 1132, y: 0, zoom: 1 });
    expect(revealViewport({ x: -800, y: 0, zoom: 0.75 }, { x: 16, y: 100, width: 232, height: 104 }, canvas).zoom).toBe(0.75);
  });

  it('панорама не уводит граф: узкий по центру, широкий не отходит от края дальше запаса', () => {
    const canvas = { width: 600, height: 400 };
    expect(constrainViewport({ x: -500, y: 900, zoom: 1 }, canvas, { width: 200, height: 100 })).toEqual({ x: 200, y: 150, zoom: 1 });
    const wide = constrainViewport({ x: 500, y: 0, zoom: 1 }, canvas, { width: 2000, height: 100 });
    expect(wide.x).toBe(48);
    expect(constrainViewport({ x: -5000, y: 0, zoom: 1 }, canvas, { width: 2000, height: 100 }).x).toBe(600 - 2000 - 48);
  });

  it('масштаб вокруг точки: точка остаётся на месте, пределы 0,5 и 1,5', () => {
    const v = zoomAround({ x: 100, y: 50, zoom: 1 }, 1.2, { x: 300, y: 200 });
    expect((300 - v.x) / v.zoom).toBeCloseTo(200);
    expect(zoomAround(v, 9, { x: 0, y: 0 }).zoom).toBe(1.5);
    expect(zoomAround(v, 0.1, { x: 0, y: 0 }).zoom).toBe(0.5);
  });

  it('раскрытие: переключённый узел на том же месте экрана', () => {
    const before: Box = { x: 16, y: 300, width: 240, height: 84 };
    const after: Box = { x: 40, y: 280, width: 272, height: 400 };
    const v = keepInPlace({ x: 10, y: 20, zoom: 0.5 }, before, after);
    expect(v.x + after.x * v.zoom).toBe(10 + before.x * 0.5);
    expect(v.y + after.y * v.zoom).toBe(20 + before.y * 0.5);
    expect(keepInPlace({ x: 1, y: 2, zoom: 1 }, undefined, after)).toEqual({ x: 1, y: 2, zoom: 1 });
  });

  it('считает шаги правее видимой части', () => {
    const boxes = new Map<string, Box>([
      ['a', { x: 0, y: 0, width: 100, height: 100 }],
      ['b', { x: 700, y: 0, width: 100, height: 100 }],
      ['j', { x: 900, y: 0, width: 8, height: 8 }],
    ]);
    expect(stepsToRight(boxes, (id) => id !== 'j', { x: 0, y: 0, zoom: 1 }, { width: 600, height: 400 })).toBe(1);
    expect(stepsToRight(boxes, (id) => id !== 'j', { x: -300, y: 0, zoom: 1 }, { width: 600, height: 400 })).toBe(0);
  });
});
