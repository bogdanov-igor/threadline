import { describe, expect, it } from 'vitest';
import { coveredSteps, visibleGraph } from './budget.ts';
import { logsByStep } from './graph.ts';
import { MAX_ERRORS, MAX_VISIBLE, type FlowGraph, type FlowNode, type RelatedFlow } from './model.ts';
import { markText } from './text.ts';
import { BASE_MS, FlowFixture, name, opId, status, sys } from './test-flow.ts';

// Синтетические потоки типичных форм, значения выдуманы.

const PROCESSOR = 'https://processor.pay.example:8443/soap/issuing';
const SWITCH = 'http://switch.pay.example:11101/v3/cards/info';
const FRAUD = 'https://fraud.pay.example/api/v2/risk/check';
const LEDGER = 'https://ledger.pay.example:8443/api/v1/hold';
const soap = (action: string) => `<soapenv:Envelope><soapenv:Body><ws:${action}><ws:card>1</ws:card></ws:${action}></soapenv:Body></soapenv:Envelope>`;
const soapResp = (action: string) => `<soapenv:Envelope><soapenv:Body><ws:${action}Response/></soapenv:Body></soapenv:Envelope>`;

const rootNodes = (g: FlowGraph): FlowNode[] => g.root.nodes.map((id) => g.nodes[id]!);
const rootKinds = (g: FlowGraph) => rootNodes(g).map((n) => n.kind);
const edgeKinds = (g: FlowGraph) => g.root.edges.map((e) => e.kind);
const stepCount = (g: FlowGraph) => g.steps;

/** Каждый шаг трассы — ровно в одном видимом узле или свёрнутой группе. */
function expectEachStepOnce(f: FlowFixture, g: FlowGraph): void {
  const view = visibleGraph(g, new Set());
  const covered = view.nodes.flatMap((n) => n.covers);
  const steps = f.trace().steps.map((s) => s.id);
  expect([...covered].sort()).toEqual([...steps].sort());
  expect(new Set(covered).size).toBe(covered.length);
}

describe('buildFlowGraph: последовательность и ветки', () => {
  it('последовательная цепочка сервиса карт — вход и три узла, только next, без слияния', () => {
    const f = new FlowFixture();
    f.entry(0);
    f.exchange(10, 100, { uri: PROCESSOR, body: soap('getCard') });
    f.exchange(110, 200, { uri: PROCESSOR, body: soap('getCardholder') });
    f.exchange(210, 300, { uri: PROCESSOR, body: soap('getBalance') });
    const g = f.graph();
    expect(rootKinds(g)).toEqual(['entry', 'exchange', 'exchange', 'exchange']);
    expect(edgeKinds(g)).toEqual(['next', 'next', 'next']);
    expect(rootKinds(g)).not.toContain('junction');
    expectEachStepOnce(f, g);
  });

  it('два пересекающихся обмена — развилка на две ветки и слияние', () => {
    const f = new FlowFixture();
    f.entry(0);
    f.exchange(10, 200, { uri: PROCESSOR, body: soap('getCard') });
    f.exchange(20, 150, { uri: SWITCH });
    f.exchange(260, 300, { uri: FRAUD });
    const g = f.graph();
    expect(rootKinds(g)).toEqual(['entry', 'exchange', 'exchange', 'junction', 'exchange']);
    const forks = g.root.edges.filter((e) => e.kind === 'fork');
    expect(forks).toHaveLength(2);
    expect(forks[0]!.hint).toEqual({ kind: 'parallel', count: 2 });
    expect(g.root.edges.filter((e) => e.kind === 'join')).toHaveLength(2);
    const [a, b] = rootNodes(g).filter((n) => n.kind === 'exchange');
    expect([a!.lane, b!.lane]).toEqual([1, 2]);
    expect(a!.block).toBe(b!.block);
    const last = rootNodes(g)[4]!;
    expect(last.lane).toBe(0);
    expect(g.root.edges.find((e) => e.target === last.id)!.source).toMatch(/^j:/);
  });

  it('касание интервалов в пределах 1 мс — цепочка', () => {
    const f = new FlowFixture();
    f.entry(0);
    f.exchange(10, 100, { uri: PROCESSOR, body: soap('getCard') });
    f.exchange(99.5, 150, { uri: SWITCH });
    f.exchange(100.5, 180, { uri: FRAUD, method: 'GET' });
    const g = f.graph();
    // Второй начался за 0,5 мс до конца первого — в допуске; третий — после конца второго нет, но в допуске от первого.
    expect(rootKinds(g).filter((k) => k === 'junction')).toHaveLength(1);
    const f2 = new FlowFixture();
    f2.entry(0);
    f2.exchange(10, 100, { uri: PROCESSOR, body: soap('getCard') });
    f2.exchange(100.5, 150, { uri: SWITCH });
    expect(rootKinds(f2.graph())).toEqual(['entry', 'exchange', 'exchange']);
  });

  it('обмен без ответа не делает параллельным всё после него', () => {
    const f = new FlowFixture();
    f.entry(0);
    f.exchange(10, null, { uri: FRAUD });
    f.exchange(50, 100, { uri: SWITCH });
    f.exchange(120, 200, { uri: LEDGER });
    f.log(900, 'done');
    const g = f.graph();
    expect(rootKinds(g)).toEqual(['entry', 'exchange', 'exchange', 'exchange']);
    const sv = rootNodes(g)[1]!;
    expect(sv.outcome).toMatchObject({ tone: 'error', noResponse: true });
    expect(sv.endMs).toBe(sv.startMs);
  });

  it('вызов процессинга без ответа, затем два обмена — цепочка, процессинг не растянут', () => {
    const f = new FlowFixture();
    f.entry(0);
    f.call(5, 'getCard', { rid: 'rq-1' });
    f.exchange(10, null, { uri: PROCESSOR, rid: 'rq-1', body: soap('getCard') });
    f.exchange(50, 100, { uri: SWITCH, rid: 'rq-1' });
    f.exchange(120, 200, { uri: LEDGER, rid: 'rq-1' });
    const g = f.graph();
    expect(rootKinds(g)).toEqual(['entry', 'fn', 'exchange', 'exchange']);
    const fn = rootNodes(g)[1]!;
    expect(fn.endMs).toBe(10);
    expect(fn.outcome.noResponse).toBe(true);
    expect(edgeKinds(g)).toEqual(['next', 'next', 'next']);
  });

  it('сервис карт: вызов процессинга, затем отправка в проверку мошенничества с тем же request_id — два узла', () => {
    const f = new FlowFixture();
    f.entry(0);
    f.call(5, 'getCard', { rid: 'rq-1' });
    f.exchange(10, 100, { uri: PROCESSOR, rid: 'rq-1', body: soap('getCard'), respBody: soapResp('getCard') });
    f.exchange(110, 160, { uri: FRAUD, rid: 'rq-1', body: '{"card":"1"}' });
    const g = f.graph();
    expect(rootKinds(g)).toEqual(['entry', 'fn', 'exchange']);
    const fn = rootNodes(g)[1]!;
    expect(fn.stepIds).toHaveLength(2);
    expect(fn.tech).toContain('getCard');
    expect(rootNodes(g)[2]!.name).toBe('fraud.pay.example');
  });

  it('вызов с одним обменом — один узел: система в имени, действие в строке метода', () => {
    const f = new FlowFixture();
    f.entry(0);
    f.call(5, 'getCard', { rid: 'rq-1', catalog: { name: name(sys('processor', 'Процессинг карт')) } });
    f.exchange(10, 100, {
      uri: PROCESSOR,
      rid: 'rq-1',
      body: soap('getCard'),
      status: 200,
      isError: true,
      catalog: { name: name(sys('processor', 'Процессинг карт'), { name: 'Данные карты' }), error: { title: 'Card not found', severity: 'error' } },
    });
    const g = f.graph();
    const fn = rootNodes(g)[1]!;
    expect(fn).toMatchObject({ kind: 'fn', name: 'Процессинг карт', plain: 'Данные карты' });
    expect(fn.tech.startsWith('getCard')).toBe(true);
    expect(fn.outcome).toMatchObject({ tone: 'error', reason: 'Card not found' });
  });

  it('вызов с тремя обменами того же действия — группа вызова, раскрытие показывает три обмена', () => {
    const f = new FlowFixture();
    f.entry(0);
    f.call(5, 'getCardholder', { rid: 'rq-1' });
    for (let i = 0; i < 3; i++) f.exchange(10 + i * 100, 90 + i * 100, { uri: PROCESSOR, rid: 'rq-1', body: soap('getCardholder') });
    const g = f.graph();
    const group = rootNodes(g)[1]!;
    expect(group.kind).toBe('group');
    expect(group.group).toMatchObject({ kind: 'call', count: 3 });
    expect(group.stepIds).toHaveLength(1);
    const open = visibleGraph(g, new Set([group.id]));
    expect(open.nodes.filter((n) => n.parentId === group.id).map((n) => n.kind)).toEqual(['exchange', 'exchange', 'exchange']);
    expectEachStepOnce(f, g);
  });

  it('вызов без обмена — отдельный узел без статуса и длительности', () => {
    const f = new FlowFixture();
    f.entry(0);
    f.call(5, 'getCard', { message: 'processor call getCard' });
    const g = f.graph();
    const fn = rootNodes(g)[1]!;
    expect(fn).toMatchObject({ kind: 'fn', durationMs: null, name: 'processor call getCard' });
    expect(fn.outcome.http).toBeNull();
  });

  it('ответ без отправки — обмен нулевой длительности с пометкой', () => {
    const f = new FlowFixture();
    f.entry(0);
    f.response(30, { uri: SWITCH });
    const n = rootNodes(f.graph())[1]!;
    expect(n.kind).toBe('exchange');
    expect(n.durationMs).toBe(0);
    expect(n.outcome.noSend).toBe(true);
  });

  it('пять веток — видно три и «Ещё 2 параллельных»', () => {
    const f = new FlowFixture();
    f.entry(0);
    for (let i = 0; i < 5; i++) f.exchange(10 + i, 300 + i, { uri: `https://card${i}.pay.example/api` });
    const g = f.graph();
    expect(rootKinds(g)).toEqual(['entry', 'exchange', 'exchange', 'exchange', 'group', 'junction']);
    const p = rootNodes(g).find((n) => n.group)!;
    expect(p.group).toMatchObject({ kind: 'parallel', count: 2 });
    expect(p.lane).toBe(4);
    expect(p.laneCount).toBe(5);
    expect(markText(p.mark!)).toBe('Ещё 2 параллельных');
    expectEachStepOnce(f, g);
  });

  it('двадцать веток, две с ошибкой — упавшие среди видимых, порядок по началу, остальное в группе', () => {
    const f = new FlowFixture();
    f.entry(0);
    const uri = (i: number) => `https://card${i}.pay.example/api`;
    const sends: string[] = [];
    for (let i = 0; i < 20; i++) sends.push(f.exchange(10 + i, 300 + i, { uri: uri(i), status: i === 7 || i === 15 ? 500 : 200 }).send.id);
    const g = f.graph();
    const lanes = rootNodes(g).filter((n) => n.lane > 0);
    expect(lanes.filter((n) => !n.group).map((n) => n.id)).toEqual([sends[0], sends[7], sends[15]]);
    const rest = lanes.find((n) => n.group)!;
    expect(rest.group).toMatchObject({ kind: 'parallel', count: 17 });
    expect(rest.outcome.tone).not.toBe('error');
    expectEachStepOnce(f, g);
    const view = visibleGraph(g, new Set());
    expect(view.nodes.find((n) => n.id === rest.id)).toMatchObject({ listed: true, expandable: false });
  });

  it('упавших больше трёх — красная группа «Ещё N», первая ошибка видна', () => {
    const f = new FlowFixture();
    f.entry(0);
    for (let i = 0; i < 6; i++) f.exchange(10 + i, 300 + i, { uri: `https://card${i}.pay.example/api`, status: 500 });
    const rest = rootNodes(f.graph()).find((n) => n.group)!;
    expect(rest.outcome.tone).toBe('error');
    expect(rest.group!.errors).toBe(3);
  });
});

describe('buildFlowGraph: повторы, паузы, ошибки подряд', () => {
  it('три попытки к платёжному ядру, последняя успешна — «×3 · 2 неудачные» в цвете успеха', () => {
    const f = new FlowFixture();
    f.entry(0);
    f.exchange(10, null, { uri: LEDGER });
    f.exchange(20, null, { uri: LEDGER });
    f.exchange(30, 100, { uri: LEDGER });
    const g = f.graph();
    const r = rootNodes(g)[1]!;
    expect(r.group).toMatchObject({ kind: 'retry', count: 3, failed: 2 });
    expect(r.outcome.tone).toBe('success');
    expect(markText(r.mark!)).toBe('×3 · 2 неудачные');
  });

  it('все пять попыток без ответа — группа ×5 с пометкой без ответа', () => {
    const f = new FlowFixture();
    f.entry(0);
    for (let i = 0; i < 5; i++) f.exchange(10 + i * 10, null, { uri: LEDGER });
    const r = rootNodes(f.graph())[1]!;
    expect(r.group).toMatchObject({ kind: 'retry', count: 5, failed: 5 });
    expect(r.outcome.noResponse).toBe(true);
  });

  it('повтор с ошибкой последней попытки — причина последней попытки', () => {
    const f = new FlowFixture();
    f.entry(0);
    f.exchange(10, 20, { uri: LEDGER, status: 500 });
    f.exchange(30, 40, { uri: LEDGER, status: 200 });
    f.exchange(50, 60, { uri: LEDGER, status: 503 });
    const r = rootNodes(f.graph())[1]!;
    expect(r.outcome).toMatchObject({ tone: 'error', reason: 'HTTP 503' });
    expect(r.group!.failed).toBe(2);
  });

  it('разные действия процессинга на один адрес — два узла', () => {
    const f = new FlowFixture();
    f.entry(0);
    f.exchange(10, 50, { uri: PROCESSOR, body: soap('getCard') });
    f.exchange(60, 90, { uri: PROCESSOR, body: soap('getCardholder') });
    expect(rootKinds(f.graph())).toEqual(['entry', 'exchange', 'exchange']);
  });

  it('пауза 10 с между попытками — на ребре повтора, в списке панели шага', () => {
    const f = new FlowFixture();
    f.entry(0);
    f.exchange(1000, null, { uri: LEDGER });
    f.exchange(11_000, 12_000, { uri: LEDGER });
    f.log(25_000, 'done');
    const g = f.graph();
    const r = rootNodes(g)[1]!;
    const e = r.group!.children.edges[0]!;
    expect(e.kind).toBe('retry');
    expect(e.hint).toEqual({ kind: 'pause', ms: 10_000 });
  });

  it('пауза короче минуты — подпись ребра; от входа — тоже', () => {
    const f = new FlowFixture();
    f.entry(0);
    f.exchange(3, 100, { uri: SWITCH });
    f.exchange(111, 500, { uri: LEDGER });
    f.exchange(60_499.9, 60_500, { uri: PROCESSOR });
    const hints = f.graph().root.edges.map((e) => e.hint);
    expect(hints).toEqual([{ kind: 'pause', ms: 3 }, { kind: 'pause', ms: 11 }, { kind: 'pause', ms: 59_999.9 }]);
  });

  it('пауза нулевая или отрицательная — подписи нет', () => {
    const f = new FlowFixture();
    f.entry(0);
    f.exchange(0, 100, { uri: SWITCH });
    f.exchange(100, 200, { uri: LEDGER });
    f.exchange(200.5, 300, { uri: PROCESSOR });
    expect(f.graph().root.edges.every((e) => e.hint === null)).toBe(true);
  });

  it('пауза 20 м 15 с — узел «Пауза» между шагами, рёбра идут через него, шагов в нём нет', () => {
    const f = new FlowFixture();
    f.entry(0);
    f.exchange(10, 100, { uri: SWITCH });
    f.exchange(100 + 1_215_000, 1_315_200, { uri: LEDGER });
    const g = f.graph();
    expect(rootKinds(g)).toEqual(['entry', 'exchange', 'pause', 'exchange']);
    const [, a, p, b] = rootNodes(g);
    expect(p).toMatchObject({ durationMs: 1_215_000, stepIds: [] });
    expect(g.root.edges.map((e) => [e.source, e.target])).toEqual([[rootNodes(g)[0]!.id, a!.id], [a!.id, p!.id], [p!.id, b!.id]]);
    expectEachStepOnce(f, g);
  });

  it('долгая пауза перед развилкой — узел, ветки идут от него', () => {
    const f = new FlowFixture();
    f.entry(0);
    f.exchange(10, 100, { uri: SWITCH });
    f.exchange(100_000, 100_300, { uri: LEDGER });
    f.exchange(100_010, 100_400, { uri: PROCESSOR });
    const g = f.graph();
    const p = rootNodes(g).find((n) => n.kind === 'pause')!;
    expect(g.root.edges.filter((e) => e.source === p.id).map((e) => e.kind)).toEqual(['fork', 'fork']);
  });

  it('пять соседних одинаковых ошибок платёжного ядра — одна красная группа ×5 с этой ошибкой', () => {
    const f = new FlowFixture();
    f.entry(0);
    for (let i = 0; i < 5; i++) f.exchange(10 + i * 20, 20 + i * 20, { uri: LEDGER, status: 502 });
    const g = f.graph();
    expect(rootKinds(g)).toEqual(['entry', 'group']);
    const r = rootNodes(g)[1]!;
    expect(r.outcome).toMatchObject({ tone: 'error', reason: 'HTTP 502' });
    expect(r.group!.count).toBe(5);
  });

  it('ошибки подряд по разным адресам с одним ключом — группа ошибок', () => {
    const f = new FlowFixture();
    f.entry(0);
    const held = { name: name(sys('ledger', 'Платёжное ядро'), { name: 'Холд' }), error: { title: 'Нет средств', severity: 'error' as const } };
    // Действия разные — не повтор; система, метод и ошибка одни — ошибки подряд.
    f.exchange(10, 20, { uri: LEDGER, status: 422, catalog: held, body: soap('holdA') });
    f.exchange(30, 40, { uri: LEDGER, status: 422, catalog: held, body: soap('holdB') });
    const r = rootNodes(f.graph())[1]!;
    expect(r.group?.kind).toBe('errors');
    expect(r.outcome.tone).toBe('error');
  });
});

describe('buildFlowGraph: вход, база, логи', () => {
  it('только запись шлюза — граф из одного узла входа', () => {
    const f = new FlowFixture();
    f.entry(0, { gateway: true, component: null });
    const g = f.graph();
    expect(rootKinds(g)).toEqual(['entry']);
    expect(rootNodes(g)[0]!.entry).toBe('gateway');
  });

  it('вход колбэка — узел колбэка с названием и статусом «заявлено в колбэке»', () => {
    const f = new FlowFixture();
    f.entry(0, {
      method: 'POST',
      uri: '/v1/callbacks/payout',
      catalog: {
        name: name(null, { name: 'Колбэк сети выплат', kind: 'callback', op: 'payout' }),
        ids: [opId('payout', '604821', 'request', 'id выплаты')],
        status: status('payout', 'failed', 'Отказ', 'failure'),
      },
    });
    const e = rootNodes(f.graph())[0]!;
    expect(e).toMatchObject({ entry: 'callback', name: 'Колбэк сети выплат' });
    expect(e.opKey).toEqual({ type: 'payout', name: 'id выплаты', short: '4821' });
    expect(e.opStatus).toMatchObject({ claimed: true, status: { name: 'Отказ' } });
  });

  it('поток без входа — «Фоновый запуск · worker»; без компонента — без него', () => {
    const f = new FlowFixture();
    f.exchange(0, 50, { uri: LEDGER, component: 'worker' });
    expect(rootNodes(f.graph())[0]).toMatchObject({ kind: 'entry', entry: 'background', name: 'Фоновый запуск · worker' });
    const g = new FlowFixture();
    g.exchange(0, 50, { uri: LEDGER, component: null });
    expect(rootNodes(g.graph())[0]!.name).toBe('Фоновый запуск');
  });

  it('вход без обменов — пометка «Внешних вызовов нет»', () => {
    const f = new FlowFixture();
    f.entry(0);
    f.log(5, 'cached');
    const e = rootNodes(f.graph())[0]!;
    expect(markText(e.mark!)).toBe('Внешних вызовов нет: ответ из базы или кэша');
  });

  it('db query с 340 мс — узел базы в тоне предупреждения; без длительности тоже узел', () => {
    const f = new FlowFixture();
    f.entry(0);
    f.db(5, 340);
    f.db(400, null);
    f.exchange(500, 520, { uri: SWITCH });
    const g = f.graph();
    expect(rootKinds(g)).toEqual(['entry', 'db', 'db', 'exchange']);
    expect(rootNodes(g)[1]).toMatchObject({ name: 'База данных', durationMs: 340, outcome: { tone: 'warning' } });
    expect(rootNodes(g)[2]).toMatchObject({ durationMs: null, outcome: { tone: 'none' } });
  });

  it('запасное имя помечено; метод справочника с именем «Вход» — это данные', () => {
    const f = new FlowFixture();
    f.entry(0);
    f.db(5, 30);
    expect(rootNodes(f.graph())[0]).toMatchObject({ name: 'Вход', fallbackName: 'entry' });
    expect(rootNodes(f.graph())[1]).toMatchObject({ name: 'База данных', fallbackName: 'db' });
    const named = new FlowFixture();
    named.entry(0, { catalog: { name: name(null, { name: 'Вход' }) } });
    expect(rootNodes(named.graph())[0]).toMatchObject({ name: 'Вход' });
    expect(rootNodes(named.graph())[0]!.fallbackName).toBeUndefined();
  });

  it('узел базы подписан системой справочника', () => {
    const f = new FlowFixture();
    f.entry(0);
    const r = f.db(5, 30);
    r.catalog = { name: { source: 'project', system: sys('pg', 'PostgreSQL Demo Pay', 'database'), method: null, host: null }, error: null, outcome: null, ids: [], status: null };
    expect(rootNodes(f.graph())[1]!.name).toBe('PostgreSQL Demo Pay');
  });

  it('записей базы нет — узла базы нет', () => {
    const f = new FlowFixture();
    f.entry(0);
    f.log(5, 'select users');
    expect(rootKinds(f.graph())).toEqual(['entry']);
  });

  it('ERROR между обменами коммутатора и платёжного ядра — отметка на значке коммутатора; запись до первого шага — на входе', () => {
    const f = new FlowFixture();
    f.entry(0);
    f.log(1, 'start');
    f.exchange(10, 30, { uri: SWITCH });
    f.log(40, 'boom', { level: 'ERROR' });
    f.log(45, 'warn', { level: 'WARNING' });
    f.exchange(50, 90, { uri: LEDGER });
    f.raw(60);
    const g = f.graph();
    const [entry, sw, ledger] = rootNodes(g);
    expect(entry!.badges).toEqual({ total: 1, warning: 0, error: 0 });
    expect(sw!.badges).toEqual({ total: 2, warning: 1, error: 1 });
    // Нераспознанная запись в интервале платёжного ядра учтена на нём.
    expect(ledger!.badges.total).toBe(1);
    expect(rootKinds(g)).toEqual(['entry', 'exchange', 'exchange']);
    expectEachStepOnce(f, g);
  });

  it('два прогона на одном входе дают равный граф; сдвиг часов шлюза не ломает порядок', () => {
    const f = new FlowFixture();
    f.exchange(10, 50, { uri: SWITCH });
    f.exchange(60, 90, { uri: LEDGER });
    // Шлюз записал вход на 30 мс позже первой записи приложения.
    f.entry(40, { gateway: true });
    const a = f.graph();
    const b = f.graph();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(rootKinds(a)).toEqual(['entry', 'exchange', 'exchange']);
    expect(rootNodes(a)[1]!.name).toBe('switch.pay.example');
  });

  it('режима в модели нет: граф не зависит от параметров отображения', () => {
    const f = new FlowFixture();
    f.entry(0);
    f.exchange(10, 50, { uri: SWITCH });
    const g = f.graph();
    expect(Object.keys(g).sort()).toEqual(['incomplete', 'nodes', 'root', 'steps', 'totalMs']);
  });
});

describe('buildFlowGraph: асинхронная операция', () => {
  const payout = sys('payout', 'Сеть выплат');
  function payoutTransfer(polls: number, last = status('payout', 'completed', 'Выполнен', 'success')) {
    const f = new FlowFixture();
    f.entry(0);
    f.exchange(10, 300, {
      uri: 'https://payout.pay.example/v3/transfer',
      catalog: { name: name(payout, { name: 'Перевод', kind: 'start', op: 'transfer' }), ids: [opId('transfer', 'tr-00000001')] },
      respCatalog: {
        name: name(payout, { name: 'Перевод', kind: 'start', op: 'transfer' }),
        ids: [opId('transfer', 'tr-00000001'), opId('payout', '604821', 'response')],
      },
    });
    for (let i = 0; i < polls; i++) {
      const st = i === polls - 1 ? last : status('payout', 'processing', 'В обработке', 'pending');
      f.exchange(1000 + i * 1000, 1100 + i * 1000, {
        uri: 'https://payout.pay.example/v1/transfer_info',
        catalog: { name: name(payout, { id: 2, name: 'Статус выплаты', kind: 'status', op: 'payout' }), ids: [opId('payout', '604821')] },
        respCatalog: { name: name(payout, { id: 2, name: 'Статус выплаты', kind: 'status', op: 'payout' }), ids: [opId('payout', '604821')], status: st },
      });
    }
    return f;
  }

  it('начало операции «id выдан …4821» и группа «опрос ×5 · Выполнен» с ребром опроса', () => {
    const g = payoutTransfer(5).graph();
    expect(rootKinds(g)).toEqual(['entry', 'async-start', 'group']);
    const [, start, poll] = rootNodes(g);
    expect(markText(start!.mark!)).toBe('id выдан …4821');
    expect(start!.opKey).toMatchObject({ type: 'transfer' });
    expect(poll!.group).toMatchObject({ kind: 'poll', count: 5 });
    expect(markText(poll!.mark!)).toBe('опрос ×5 · Выполнен');
    expect(g.root.edges.find((e) => e.target === poll!.id)!.kind).toBe('poll');
    expect(poll!.group!.children.edges.every((e) => e.kind === 'poll')).toBe(true);
  });

  it('статус «отказ» не делает группу опроса красной', () => {
    const g = payoutTransfer(3, status('payout', 'failed', 'Отклонён', 'failure')).graph();
    const poll = rootNodes(g)[2]!;
    expect(poll.outcome.tone).toBe('success');
    expect(markText(poll.mark!)).toBe('опрос ×3 · Отклонён');
  });

  it('статус вне словаря — значение как есть', () => {
    const g = payoutTransfer(2, status('payout', 'waiting_cancel', null, null)).graph();
    expect(markText(rootNodes(g)[2]!.mark!)).toBe('опрос ×2 · waiting_cancel');
  });

  it('справочник выключен — обычные узлы и повторы, без начала операции', () => {
    const f = payoutTransfer(5);
    for (const r of f.records) delete r.catalog;
    const g = f.graph();
    expect(rootKinds(g)).toEqual(['entry', 'exchange', 'group']);
    expect(rootNodes(g)[2]!.group!.kind).toBe('retry');
  });
});

describe('buildFlowGraph: связанные потоки операции', () => {
  const related = (i: number, over: Partial<RelatedFlow> = {}): RelatedFlow => ({
    cid: `cid-r${i}`,
    segment: null,
    role: 'status',
    title: `Опрос ${i}`,
    firstMs: BASE_MS + 60_000 + i * 1000,
    lastMs: BASE_MS + 60_500 + i * 1000,
    error: false,
    opStatus: null,
    claimed: false,
    key: { type: 'transfer', name: 'transfer_id' },
    ...over,
  });
  const start = () => {
    const f = new FlowFixture();
    f.entry(0);
    f.exchange(10, 300, {
      uri: 'https://payout.pay.example/v3/transfer',
      catalog: { name: name(sys('payout', 'Сеть выплат'), { name: 'Выплата', kind: 'start', op: 'transfer' }), ids: [opId('transfer', 'tr-1')] },
    });
    return f;
  };

  it('колбэк в другом потоке через 42 с — пунктир от начала операции с ключом связи', () => {
    const g = start().graph({ related: [related(0, { role: 'callback', title: 'Колбэк сети выплат', firstMs: BASE_MS + 300 + 42_000, lastMs: BASE_MS + 42_400 })] });
    const ref = rootNodes(g).find((n) => n.kind === 'flow-ref')!;
    expect(ref.name).toBe('Колбэк сети выплат');
    const link = g.root.edges.find((e) => e.kind === 'link')!;
    expect(g.nodes[link.source]!.kind).toBe('async-start');
    expect(link.hint).toEqual({ kind: 'key', type: 'transfer', name: 'transfer_id', together: false, pauseMs: 42_000 });
  });

  it('колбэк на 300 мс раньше ответа на создание — «одновременно», пауза 0, пометка', () => {
    const g = start().graph({ related: [related(0, { role: 'callback', firstMs: BASE_MS + 0, lastMs: BASE_MS + 100 })] });
    const link = g.root.edges.find((e) => e.kind === 'link')!;
    expect(link.hint).toMatchObject({ together: true, pauseMs: 0 });
    const ref = rootNodes(g).find((n) => n.kind === 'flow-ref')!;
    expect(markText(ref.mark!)).toBe('колбэк раньше ответа на создание');
  });

  it('12 потоков после открытого — 4 узла-ссылки и «ещё 8 потоков операции»', () => {
    const g = start().graph({ related: Array.from({ length: 12 }, (_, i) => related(i)) });
    const refs = rootNodes(g).filter((n) => n.kind === 'flow-ref');
    expect(refs).toHaveLength(5);
    expect(refs.filter((n) => n.related)).toHaveLength(4);
    expect(markText(refs[4]!.mark!)).toBe('ещё 8 потоков операции');
  });

  it('операция не открывалась — узлов-ссылок нет', () => {
    expect(rootKinds(start().graph())).not.toContain('flow-ref');
  });
});

describe('бюджет видимых узлов', () => {
  function long(n: number, errorAt: (i: number) => number | null): FlowFixture {
    const f = new FlowFixture();
    f.entry(0);
    for (let i = 0; i < n; i++) {
      const err = errorAt(i);
      f.exchange(10 + i * 20, 20 + i * 20, { uri: `https://s${i % 7}.pay.example/api/m${i % 5}`, status: err ?? 200, isError: err !== null });
    }
    return f;
  }

  it('250 шагов и одна ошибка — не больше 60 видимых, ошибка и соседи видны, каждый шаг ровно в одном месте', () => {
    const f = long(250, (i) => (i === 125 ? 500 : null));
    const g = f.graph();
    const view = visibleGraph(g, new Set());
    expect(view.nodes.filter((n) => n.kind !== 'junction').length).toBeLessThanOrEqual(MAX_VISIBLE);
    const err = view.nodes.find((n) => !n.group && n.outcome.tone === 'error');
    expect(err).toBeDefined();
    const i = view.nodes.indexOf(err!);
    expect(view.nodes[i - 1]!.group).toBeNull();
    expect(view.nodes[i + 1]!.group).toBeNull();
    // Последний шаг виден.
    expect(view.nodes[view.nodes.length - 1]!.group).toBeNull();
    expect(stepCount(g)).toBe(251);
    expectEachStepOnce(f, g);
  });

  it('250 шагов и 50 ошибок трёх видов — не больше 60 видимых, первая ошибка каждого вида видна, остальные в красных группах', () => {
    const codes = [500, 502, 503];
    const f = long(250, (i) => (i % 5 === 2 ? codes[Math.floor(i / 5) % 3]! : null));
    const g = f.graph();
    const view = visibleGraph(g, new Set());
    expect(view.nodes.filter((n) => n.kind !== 'junction').length).toBeLessThanOrEqual(MAX_VISIBLE);
    const visibleErrors = view.nodes.filter((n) => !n.group && n.outcome.tone === 'error');
    expect(visibleErrors.length).toBeLessThanOrEqual(MAX_ERRORS);
    for (const c of codes) expect(visibleErrors.some((n) => n.outcome.reason === `HTTP ${c}`)).toBe(true);
    const red = view.nodes.filter((n) => n.group?.kind === 'more' && n.group.errors > 0);
    expect(red.length).toBeGreaterThan(0);
    for (const r of red) {
      expect(r.outcome.tone).toBe('error');
      expect(markText(r.mark!)).toMatch(/^ещё \d+ шаг(а|ов)? · \d+ ошиб/);
    }
    const errorsTotal = visibleErrors.length + view.nodes.filter((n) => n.group).reduce((s, n) => s + n.group!.errors, 0);
    expect(errorsTotal).toBe(50);
    expectEachStepOnce(f, g);
  });

  it('раскрытие сверх 100 узлов недоступно', () => {
    const f = long(250, () => null);
    const g = f.graph();
    const view = visibleGraph(g, new Set());
    const big = view.nodes.find((n) => n.group && n.group.cost > 50)!;
    expect(big.expandable).toBe(false);
    const after = visibleGraph(g, new Set([big.id]));
    expect(after.nodes.find((n) => n.id === big.id)!.expanded).toBe(false);
    expect(after.nodes.length).toBeLessThanOrEqual(100);
  });

  it('записи неполные — последний узел «дальше записи не прочитаны»', () => {
    const f = new FlowFixture();
    f.entry(0);
    f.exchange(10, 50, { uri: SWITCH });
    const g = f.graph({ incomplete: true });
    expect(g.incomplete).toBe(true);
    expect(rootNodes(g)[1]!.unread).toBe(true);
    expect(rootNodes(g)[0]!.unread).toBe(false);
  });

  it('coveredSteps группы включает шаги детей', () => {
    const f = new FlowFixture();
    f.entry(0);
    f.exchange(10, null, { uri: LEDGER });
    f.exchange(20, 30, { uri: LEDGER });
    const g = f.graph();
    const r = rootNodes(g)[1]!;
    expect(coveredSteps(g, r.id)).toHaveLength(2);
  });
});

describe('бюджет при любых входных данных', () => {
  const ledger = (i: number) => `https://ledger.pay.example:8443/api/v1/op${i}`;

  it('долгий обмен параллельно 200 коротким в конце потока: не больше 60 узлов, последний шаг виден', () => {
    const f = new FlowFixture();
    f.entry(0);
    f.exchange(10, 20_000, { uri: 'https://long.pay.example/wait' });
    let last: string | null = null;
    for (let i = 0; i < 200; i++) last = f.exchange(20 + i * 90, 100 + i * 90, { uri: ledger(i) }).send.id;
    const g = f.graph();
    const view = visibleGraph(g, new Set());
    expect(view.nodes.length).toBeLessThanOrEqual(60);
    expect(view.nodes.some((n) => n.stepIds.includes(last!))).toBe(true);
    expect(view.nodes.some((n) => n.group?.kind === 'more')).toBe(true);
    // Ни один шаг не потерян: всё лежит под видимыми узлами.
    const covered = new Set(view.nodes.flatMap((n) => n.covers));
    for (const s of f.trace().steps) expect(covered.has(s.id)).toBe(true);
  });

  it('случайные потоки с ветками, ошибками и логами', () => {
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let run = 0; run < 40; run++) {
      const f = new FlowFixture();
      f.entry(0);
      let t = 10;
      const steps = 20 + rnd(400);
      for (let i = 0; i < steps; i++) {
        const d = 1 + rnd(50);
        const overlap = rnd(3) === 0;
        f.exchange(t, rnd(7) === 0 ? null : t + d, { uri: ledger(rnd(30)), status: rnd(5) === 0 ? 500 : 200 });
        if (rnd(9) === 0) f.log(t, 'лог', { level: rnd(2) ? 'WARNING' : 'ERROR' });
        t += overlap ? 1 : d + 1;
      }
      const g = f.graph({ related: [] });
      expect(visibleGraph(g, new Set()).nodes.length).toBeLessThanOrEqual(60);
      const all = new Set(Object.keys(g.nodes).flatMap((id) => g.nodes[id]!.stepIds));
      for (const s of f.trace().steps) if (s.kind !== 'log') expect(all.has(s.id)).toBe(true);
    }
  });
});

describe('параллельные обмены внутри вызова', () => {
  const PROCESSOR = 'https://processor.pay.example/soap';

  it('«вызов, вызов, отправка 10–300, отправка 20–250»: две ветки, а не пустой узел и цепочка', () => {
    const f = new FlowFixture();
    f.entry(0);
    f.call(5, 'getCard', { rid: 'rq-1' });
    f.call(6, 'getCard', { rid: 'rq-1' });
    const a = f.exchange(10, 300, { uri: `${PROCESSOR}/1`, title: 'POST a', body: '<Envelope><Body><getCard/></Body></Envelope>' });
    const b = f.exchange(20, 250, { uri: `${PROCESSOR}/2`, title: 'POST b', body: '<Envelope><Body><getCard/></Body></Envelope>' });
    const g = f.graph();
    const nodes = Object.values(g.nodes);
    const lanes = nodes.filter((n) => n.lane > 0);
    expect(lanes).toHaveLength(2);
    expect(nodes.filter((n) => n.kind === 'junction')).toHaveLength(1);
    expect(lanes.every((n) => n.select === a.send.id || n.select === b.send.id)).toBe(true);
    expect(nodes.some((n) => n.kind === 'fn' && n.select === null)).toBe(false);
    expect(g.root.edges.filter((e) => e.kind === 'retry')).toEqual([]);
  });

  it('один вызов и два перекрытых обмена: группа с ветками без ребра повтора', () => {
    const f = new FlowFixture();
    f.entry(0);
    f.call(5, 'getCard', { rid: 'rq-1' });
    f.exchange(10, 300, { uri: PROCESSOR, body: '<Envelope><Body><getCard/></Body></Envelope>' });
    f.exchange(20, 250, { uri: PROCESSOR, body: '<Envelope><Body><getCard/></Body></Envelope>' });
    const g = f.graph();
    const group = Object.values(g.nodes).find((n) => n.group?.kind === 'call')!;
    expect(group.group!.children.edges.map((e) => e.kind).sort()).toEqual(['join', 'join']);
    expect(group.group!.children.nodes.filter((id) => g.nodes[id]!.kind === 'junction')).toHaveLength(1);
    const view = visibleGraph(g, new Set([group.id]));
    expect(view.nodes.filter((n) => n.parentId === group.id && n.lane > 0)).toHaveLength(2);
  });

  it('последовательные обмены вызова: цепочка повторов, как раньше', () => {
    const f = new FlowFixture();
    f.entry(0);
    f.call(5, 'getCard', { rid: 'rq-1' });
    f.exchange(10, 20, { uri: PROCESSOR, body: '<Envelope><Body><getCard/></Body></Envelope>' });
    f.exchange(30, 40, { uri: PROCESSOR, body: '<Envelope><Body><getCard/></Body></Envelope>' });
    const g = f.graph();
    const group = Object.values(g.nodes).find((n) => n.group?.kind === 'call')!;
    expect(group.group!.children.edges.map((e) => e.kind)).toEqual(['retry']);
  });
});

describe('логи узла по шагам панели', () => {
  it('логи у шага, который выбирает клик по узлу, и у шага вызова', () => {
    const f = new FlowFixture();
    f.entry(0);
    f.call(5, 'getCard', { rid: 'rq-1' });
    const ex = f.exchange(10, 100, { uri: 'https://processor.pay.example/x', body: '<Envelope><Body><getCard/></Body></Envelope>' });
    const log = f.log(50, 'cURL error 28', { level: 'ERROR' });
    const g = f.graph();
    const map = logsByStep(g);
    expect(map.get(ex.send.id)).toEqual([log.id]);
  });

  it('запись до первого шага — у входа; лог с группой не сбивает «шаг N из M»', () => {
    const f = new FlowFixture();
    const entry = f.entry(10);
    f.log(0, 'рано', { level: 'WARNING' });
    const g = f.graph();
    expect(logsByStep(g).get(entry.id)?.length).toBe(1);
  });
});

describe('узел входа', () => {
  it('колбэк без обменов: без пометки «Внешних вызовов нет», статус на месте', () => {
    const f = new FlowFixture();
    f.entry(0, { method: 'POST', uri: '/internal/callbacks/vd', catalog: { name: name(null, { name: 'Колбэк', kind: 'callback', op: 'transfer' }), ids: [opId('transfer', 'tr-1')], status: status('transfer', 'failed', 'Отказ', 'failure') } });
    const entry = rootNodes(f.graph())[0]!;
    expect(entry.mark).toBeNull();
    expect(entry.opStatus).toMatchObject({ claimed: true });
  });

  it('обычный вход без обменов: пометка остаётся', () => {
    const f = new FlowFixture();
    f.entry(0);
    expect(rootNodes(f.graph())[0]!.mark).toEqual({ kind: 'no-calls' });
  });
});

describe('сегменты одного correlation_id как связанные потоки', () => {
  it('три сегмента — три узла-ссылки с разными id', () => {
    const f = new FlowFixture();
    f.entry(0);
    const rel = (segment: number, offset: number): RelatedFlow => ({
      cid: 'cid-other',
      segment,
      role: 'worker',
      title: `Попытка ${segment}`,
      firstMs: BASE_MS + offset,
      lastMs: BASE_MS + offset + 100,
      error: false,
      opStatus: null,
      claimed: false,
      key: { type: 'payment', name: 'Платёж' },
    });
    const g = f.graph({ related: [rel(0, 60_000), rel(1, 360_000), rel(2, 660_000)] });
    const refs = g.root.nodes.filter((id) => g.nodes[id]!.kind === 'flow-ref');
    expect(new Set(refs).size).toBe(3);
    expect(refs).toEqual(['ref:cid-other#0', 'ref:cid-other#1', 'ref:cid-other#2']);
    expect(g.root.edges.filter((e) => e.kind === 'link').map((e) => e.id)).toHaveLength(3);
  });
});

describe('обращение к базе с ошибкой', () => {
  it('узел красный с причиной, в бюджете обязателен', () => {
    const f = new FlowFixture('c');
    f.entry(0);
    f.exchange(10, 20, { uri: 'https://a.pay.example/x', catalog: { name: name(sys('a', 'Альфа'), { name: 'X' }), ids: [] } });
    f.log(30, 'ERROR: deadlock detected', { isError: true, level: 'ERROR', flow: { as: 'db', durationMs: null, host: null, title: null } });
    const g = f.graph();
    const db = rootNodes(g).find((n) => n.kind === 'db')!;
    expect(db.outcome).toMatchObject({ tone: 'error', reason: 'ERROR: deadlock detected' });
  });

  it('правило базы: текст правила, «не ошибка» — не красный', () => {
    const f = new FlowFixture('c');
    f.entry(0);
    f.log(30, 'ERROR: deadlock detected', {
      isError: true,
      level: 'ERROR',
      flow: { as: 'db', durationMs: null, host: null, title: null },
      catalog: { name: name(sys('pg', 'PostgreSQL Demo Pay')), error: { title: 'Взаимная блокировка в базе', severity: 'error' } as never, ids: [] },
    });
    const db = rootNodes(f.graph()).find((n) => n.kind === 'db')!;
    expect(db).toMatchObject({ name: 'PostgreSQL Demo Pay', outcome: { tone: 'error', reason: 'Взаимная блокировка в базе' } });
    const ok = new FlowFixture('c');
    ok.entry(0);
    ok.log(30, 'ERROR: x', {
      isError: true,
      level: 'ERROR',
      flow: { as: 'db', durationMs: null, host: null, title: null },
      catalog: { name: name(sys('pg', 'PostgreSQL Demo Pay')), error: { title: null, severity: 'ok' } as never, ids: [] },
    });
    expect(rootNodes(ok.graph()).find((n) => n.kind === 'db')!.outcome.tone).not.toBe('error');
  });
});

describe('шаг нулевой длины внутри долгого обмена', () => {
  it('идёт в цепочке за обменом, ветка ему не нужна', () => {
    const f = new FlowFixture('c');
    f.entry(0);
    f.exchange(10, 60, { uri: 'https://a.pay.example/x' });
    f.db(30, null);
    const g = f.graph();
    expect(rootNodes(g).filter((n) => n.lane > 0)).toEqual([]);
    expect(rootKinds(g)).toEqual(['entry', 'exchange', 'db']);
  });

  it('два пересекающихся обмена остаются ветками, шаг — за ними', () => {
    const f = new FlowFixture('c');
    f.entry(0);
    f.exchange(10, 100, { uri: 'https://a.pay.example/x' });
    f.db(20, null);
    f.exchange(30, 90, { uri: 'https://b.pay.example/y' });
    const nodes = rootNodes(f.graph()).filter((n) => n.kind !== 'junction');
    expect(nodes.filter((n) => n.lane > 0).map((n) => n.kind)).toEqual(['exchange', 'exchange']);
    expect(nodes.at(-1)!.kind).toBe('db');
  });
});
