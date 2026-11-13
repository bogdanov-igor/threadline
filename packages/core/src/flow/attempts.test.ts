import { describe, expect, it } from 'vitest';
import { attemptStrip, foldAttempts, stepGroups, stepOrder } from './attempts.ts';
import { visibleGraph } from './budget.ts';
import { FlowFixture } from './test-flow.ts';

const LEDGER = 'https://ledger.pay.example:8443/api/v1/hold';

function retries(n: number, last = 500, every = 3_600_000) {
  const f = new FlowFixture();
  f.entry(0);
  const sends: string[] = [];
  for (let i = 0; i < n; i++) sends.push(f.exchange(i * every, i * every + 100, { uri: LEDGER, status: i === n - 1 ? last : 500 }).send.id);
  return { f, sends };
}

describe('полоска попыток', () => {
  it('до 12 — клетки 6 px, до 24 — 4 px, больше — последние 24 и знак «…»', () => {
    const cells = (n: number) => Array.from({ length: n }, (_, i) => ({ stepId: `s${i}`, tone: 'error' as const }));
    expect(attemptStrip(cells(12))).toMatchObject({ size: 6, clipped: false });
    expect(attemptStrip(cells(12)).cells).toHaveLength(12);
    expect(attemptStrip(cells(24))).toMatchObject({ size: 4, clipped: false });
    const many = attemptStrip(cells(99));
    expect(many).toMatchObject({ size: 4, clipped: true });
    expect(many.cells).toHaveLength(24);
    expect(many.cells[23]!.stepId).toBe('s98');
  });

  it('99 попыток: в виде узла 99 клеток по порядку, последняя решает цвет', () => {
    const { f, sends } = retries(99, 200);
    const view = visibleGraph(f.graph(), new Set());
    const group = view.nodes.find((n) => n.group?.kind === 'retry')!;
    expect(group.outcome.tone).toBe('success');
    expect(group.attempts).toHaveLength(99);
    expect(group.attempts![98]).toEqual({ stepId: sends[98], tone: 'success' });
  });
});

describe('список в панели шага', () => {
  it('у второй попытки пауза 10 с, у первой нет; шаг находит свою группу', () => {
    const f = new FlowFixture();
    f.entry(0);
    const a = f.exchange(1000, null, { uri: LEDGER }).send;
    const b = f.exchange(11_000, 12_000, { uri: LEDGER }).send;
    const g = f.graph();
    const group = stepGroups(g).get(b.id)!;
    expect(group.kind).toBe('retry');
    expect(group.entries.map((e) => e.stepId)).toEqual([a.id, b.id]);
    expect(group.entries.map((e) => e.pauseMs)).toEqual([null, 10_000]);
  });

  it('«Ещё N параллельных» — список вызовов без пауз', () => {
    const f = new FlowFixture();
    f.entry(0);
    const sends = Array.from({ length: 6 }, (_, i) => f.exchange(10 + i, 300 + i, { uri: `https://card${i}.pay.example/api` }).send.id);
    const group = stepGroups(f.graph()).get(sends[5]!)!;
    expect(group.kind).toBe('parallel');
    expect(group.entries.map((e) => e.stepId)).toEqual(sends.slice(3));
    expect(group.entries.every((e) => e.pauseMs === null)).toBe(true);
  });

  it('одинаковые подряд свёрнуты; выбранная и раскрытая остаются видны', () => {
    const { f, sends } = retries(99, 200);
    const { entries } = stepGroups(f.graph()).get(sends[0]!)!;
    const kinds = (rows: ReturnType<typeof foldAttempts>) => rows.map((r) => (r.kind === 'fold' ? `…${r.entries.length}` : r.entry.index));
    expect(kinds(foldAttempts(entries))).toEqual([1, 2, '…95', 98, 99]);
    expect(kinds(foldAttempts(entries, sends[49]!))).toEqual([1, 2, '…47', 50, '…47', 98, 99]);
    expect(foldAttempts(entries, null, new Set([1]))).toHaveLength(99);
  });

  it('разные итоги не сворачиваются вместе; три одинаковые не сворачиваются', () => {
    const { f, sends } = retries(3);
    const { entries } = stepGroups(f.graph()).get(sends[0]!)!;
    expect(foldAttempts(entries).every((r) => r.kind === 'entry')).toBe(true);
  });
});

describe('номер шага', () => {
  it('вход — первый, группа — один номер на все попытки', () => {
    const { f, sends } = retries(3);
    const { order, total } = stepOrder(f.graph());
    expect(total).toBe(2);
    expect(order.get(sends[0]!)).toBe(2);
    expect(order.get(sends[2]!)).toBe(2);
  });
});
