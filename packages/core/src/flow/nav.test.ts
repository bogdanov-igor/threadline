import { describe, expect, it } from 'vitest';
import { visibleGraph } from './budget.ts';
import { locate, nextNode, representative } from './nav.ts';
import { FlowFixture } from './test-flow.ts';

const LEDGER = 'https://ledger.pay.example:8443/api/v1/hold';

/** Вход → A → развилка (B ∥ C, D после C в той же ветке) → слияние → E. */
function forked() {
  const f = new FlowFixture();
  f.entry(0);
  const a = f.exchange(10, 50, { uri: 'https://a.pay.example/x' }).send;
  const b = f.exchange(60, 200, { uri: 'https://b.pay.example/card/1' }).send;
  const c = f.exchange(65, 90, { uri: 'https://c.pay.example/card/2' }).send;
  const d = f.exchange(100, 150, { uri: 'https://d.pay.example/card/3' }).send;
  const e = f.exchange(300, 350, { uri: 'https://e.pay.example/y' }).send;
  const view = visibleGraph(f.graph(), new Set());
  return { view, entry: view.nodes[0]!.id, a: a.id, b: b.id, c: c.id, d: d.id, e: e.id };
}

describe('nextNode', () => {
  it('→ на развилке — в первую ветку, из конца ветки — к узлу после слияния, ← обратно', () => {
    const { view, a, b, e } = forked();
    expect(nextNode(view, 'ArrowRight', a)).toBe(b);
    // Первая ветка из одного узла: второе нажатие — узел после слияния.
    expect(nextNode(view, 'ArrowRight', b)).toBe(e);
    expect(nextNode(view, 'ArrowLeft', e)).toBe(b);
    expect(nextNode(view, 'ArrowLeft', b)).toBe(a);
  });

  it('↑/↓ — узел соседней ветки с ближайшим началом; вне развилки ничего', () => {
    const { view, a, b, c, d } = forked();
    expect(nextNode(view, 'ArrowDown', b)).toBe(c);
    expect(nextNode(view, 'ArrowUp', d)).toBe(b);
    expect(nextNode(view, 'ArrowUp', b)).toBeNull();
    expect(nextNode(view, 'ArrowUp', a)).toBeNull();
    expect(nextNode(view, 'ArrowDown', a)).toBeNull();
  });

  it('→ внутри ветки идёт по ней', () => {
    const { view, c, d, e } = forked();
    expect(nextNode(view, 'ArrowRight', c)).toBe(d);
    expect(nextNode(view, 'ArrowRight', d)).toBe(e);
  });

  it('Home и End — первый и последний узел, слияния пропускаются', () => {
    const { view, entry, e } = forked();
    expect(nextNode(view, 'Home', e)).toBe(entry);
    expect(nextNode(view, 'End', entry)).toBe(e);
    expect(view.nodes.some((n) => n.kind === 'junction')).toBe(true);
  });

  it('без выбора — первый узел', () => {
    const { view, entry } = forked();
    expect(nextNode(view, 'ArrowRight', null)).toBe(entry);
  });

  it('→ в раскрытой группе — к первой её части', () => {
    const f = new FlowFixture();
    f.entry(0);
    f.call(5, 'hold');
    const first = f.exchange(10, null, { uri: LEDGER, title: 'hold', body: '<Envelope><Body><hold/></Body></Envelope>' }).send;
    const second = f.exchange(20, 30, { uri: LEDGER, title: 'hold', body: '<Envelope><Body><hold/></Body></Envelope>' }).send;
    const g = f.graph();
    const group = g.root.nodes[1]!;
    const view = visibleGraph(g, new Set([group]));
    expect(nextNode(view, 'ArrowRight', group)).toBe(first.id);
    expect(nextNode(view, 'ArrowRight', first.id)).toBe(second.id);
  });
});

describe('representative и locate', () => {
  function retries() {
    const f = new FlowFixture();
    f.entry(0);
    const one = f.exchange(10, 20, { uri: LEDGER }).send;
    const two = f.exchange(30, 40, { uri: LEDGER, status: 500 }).send;
    const three = f.exchange(50, 60, { uri: LEDGER }).send;
    const g = f.graph();
    return { g, one, two, three, group: g.root.nodes[1]! };
  }

  it('клик по свёрнутой группе — первая ошибка; без ошибок — последняя попытка', () => {
    const { g, two, group } = retries();
    const view = visibleGraph(g, new Set());
    expect(representative(view.nodes.find((n) => n.id === group)!)).toBe(two.id);

    const f = new FlowFixture();
    f.entry(0);
    f.exchange(10, 20, { uri: LEDGER });
    const last = f.exchange(30, 40, { uri: LEDGER }).send;
    const v2 = visibleGraph(f.graph(), new Set());
    expect(representative(v2.nodes[1]!)).toBe(last.id);
  });

  it('шаг внутри свёрнутой группы — «шаг 2 из 3», группа не раскрывается', () => {
    const { g, two, group } = retries();
    const view = visibleGraph(g, new Set());
    expect(locate(view, two.id)).toEqual({ nodeId: group, index: 2, of: 3 });
    // Повторы не раскрываются на графе: попытки — списком в панели шага.
    const asked = visibleGraph(g, new Set([group]));
    expect(asked.nodes.find((n) => n.id === group)).toMatchObject({ expanded: false, expandable: false, listed: true });
    expect(locate(asked, two.id)).toEqual({ nodeId: group, index: 2, of: 3 });
  });

  it('неизвестный шаг — null', () => {
    const { g } = retries();
    expect(locate(visibleGraph(g, new Set()), 'nope')).toBeNull();
  });
});

describe('nextNode: узлы-ссылки на потоки операции', () => {
  const related = (i: number) => ({
    cid: `cid-${i}`,
    segment: null,
    role: 'status' as const,
    title: `Опрос ${i}`,
    firstMs: 1e12 + i,
    lastMs: 1e12 + i + 1,
    error: false,
    opStatus: null,
    claimed: false,
    key: { type: 't', name: 'T' },
  });

  function chain() {
    const f = new FlowFixture();
    f.entry(0, { catalog: { ids: [{ type: 't', name: 'T', kind: 'operation', value: 'op-1', at: 'path' }] } });
    const a = f.exchange(10, 20, { uri: 'https://a.pay.example/x' }).send;
    const b = f.exchange(30, 40, { uri: 'https://b.pay.example/y' }).send;
    const g = f.graph({ related: [related(1), related(2), related(3), related(4)] });
    return { view: visibleGraph(g, new Set()), a: a.id, b: b.id };
  }

  it('→ с последнего узла потока — первая ссылка, хотя её ребро идёт от входа', () => {
    const { view, b } = chain();
    expect(nextNode(view, 'ArrowRight', b)).toBe('ref:cid-1');
  });

  it('←/→ и ↑/↓ между ссылками: все доступны', () => {
    const { view } = chain();
    expect(nextNode(view, 'ArrowDown', 'ref:cid-1')).toBe('ref:cid-2');
    expect(nextNode(view, 'ArrowDown', 'ref:cid-2')).toBe('ref:cid-3');
    expect(nextNode(view, 'ArrowUp', 'ref:cid-3')).toBe('ref:cid-2');
    expect(nextNode(view, 'ArrowUp', 'ref:cid-1')).toBeNull();
    expect(nextNode(view, 'ArrowRight', 'ref:cid-3')).toBe('ref:cid-4');
    expect(nextNode(view, 'ArrowRight', 'ref:cid-4')).toBeNull();
    expect(nextNode(view, 'ArrowLeft', 'ref:cid-2')).toBe('ref:cid-1');
  });

  it('← с первой ссылки — к узлу с ключом', () => {
    const { view } = chain();
    expect(nextNode(view, 'ArrowLeft', 'ref:cid-1')).toBe(view.nodes[0]!.id);
  });
});

describe('locate: запись-лог группы', () => {
  it('лог группы выбирает узел, но не «шаг N из M»', () => {
    const f = new FlowFixture();
    f.entry(0);
    const uri = 'https://ledger.pay.example:8443/api/v1/hold';
    const s1 = f.exchange(10, 20, { uri, status: 500 }).send;
    f.exchange(30, 40, { uri, status: 500 });
    f.exchange(50, 60, { uri, status: 500 });
    const log = f.log(35, 'повтор', { level: 'WARNING' });
    const view = visibleGraph(f.graph(), new Set());
    const group = view.nodes.find((n) => n.group);
    expect(locate(view, log.id)).toEqual({ nodeId: group!.id, index: 1, of: 1 });
    expect(locate(view, s1.id)).toEqual({ nodeId: group!.id, index: 1, of: 3 });
  });
});
