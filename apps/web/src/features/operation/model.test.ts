import type { OperationFlow, OperationGroup, OperationItem, OperationView } from '@threadline/core/flow';
import type { OperationKey } from '@threadline/core/search';
import { describe, expect, it } from 'vitest';
import {
  barOf,
  chooseOperation,
  cutOf,
  flowPath,
  flowsOf,
  lettersOf,
  linkedTypes,
  linkTo,
  operationKeyOfTerm,
  operationPath,
  parseOperationAddress,
  positionOf,
  readOperationHref,
  readOperationLink,
  relatedAfter,
  rowLetter,
  scaleOf,
  scaleTicks,
  staysInOperation,
  spansDays,
  summaryPlan,
} from './model.ts';

// Модель страницы операции и переходов на синтетических данных: значений из logs.md здесь нет.

const key = (type: string, value: string, over: Partial<OperationKey> = {}): OperationKey => ({
  type,
  name: type === 'transfer' ? 'Перевод' : type === 'installment' ? 'Рассрочка' : null,
  value,
  short: value.slice(-4),
  masked: false,
  ...over,
});

const flow = (cid: string, firstMs: number, over: Partial<OperationFlow> = {}): OperationFlow => ({
  kind: 'flow',
  cid,
  segment: null,
  nocid: false,
  firstMs,
  lastMs: firstMs + 500,
  role: 'call',
  title: 'POST /v1/transfers',
  status: 'success',
  incomplete: false,
  error: false,
  opStatus: null,
  claimed: false,
  noStatus: false,
  ops: 1,
  linkedBy: [{ type: 'transfer', at: 'path' }],
  found: null,
  pauseMs: 0,
  together: false,
  callbackEarly: false,
  firstRecordId: null,
  ...over,
});

function view(items: OperationView['items']): OperationView {
  return {
    key: {
      type: 'transfer',
      name: 'Перевод',
      values: ['tr-0000-4821'],
      also: [{ type: 'payout', name: 'id выплаты', value: '604217' }],
    },
    window: { fromMs: 0, toMs: 6 * 3_600_000, preset: '6h' },
    items,
    trail: [],
    outcome: {
      kind: 'unknown',
      status: null,
      previous: null,
      basis: null,
      cid: null,
      partial: false,
      failed: 0,
    },
    excluded: [],
    extraIds: [],
    unsearchedIds: [],
    supplemented: false,
    unknownType: false,
  };
}

describe('адрес страницы операции', () => {
  it('туда и обратно: тип, значение, момент, окно, id других типов, задание', () => {
    const path = operationPath('pay', 'test', '92', {
      type: 'transfer',
      value: 'tr-0000-4821',
      atMs: 1_762_000_000_000.7,
      window: '24h',
      also: [{ type: 'payout', value: '604217' }],
      searchId: 'abc_123',
    });
    expect(path).toBe(
      '/pay/test/92/operations/transfer/tr-0000-4821?at=1762000000000&w=24h&also=payout%3A604217&search=abc_123',
    );
    const [, qs] = path.split('?');
    const parsed = parseOperationAddress('transfer', 'tr-0000-4821', new URLSearchParams(qs));
    expect(parsed).toEqual({
      ok: true,
      address: {
        type: 'transfer',
        value: 'tr-0000-4821',
        atMs: 1_762_000_000_000,
        window: '24h',
        also: [{ type: 'payout', value: '604217' }],
        searchId: 'abc_123',
      },
    });
  });

  it('окно по умолчанию ±3 ч, неизвестное значение окна — тоже', () => {
    const r = parseOperationAddress('transfer', 'tr-0000-4821', new URLSearchParams('at=1&w=7d'));
    expect(r.ok && r.address.window).toBe('6h');
  });

  it('короткое значение — своё сообщение, без момента или с чужими символами — ссылка неверная', () => {
    expect(parseOperationAddress('transfer', '4821', new URLSearchParams('at=1'))).toEqual({
      ok: false,
      reason: 'short',
    });
    expect(parseOperationAddress('transfer', 'tr-0000-4821', new URLSearchParams(''))).toEqual({
      ok: false,
      reason: 'bad-link',
    });
    expect(parseOperationAddress('transfer', 'tr 0000/4821', new URLSearchParams('at=1'))).toEqual({
      ok: false,
      reason: 'bad-link',
    });
    expect(parseOperationAddress(undefined, 'tr-0000-4821', new URLSearchParams('at=1'))).toEqual({
      ok: false,
      reason: 'bad-link',
    });
  });

  it('лишние и битые also отбрасываются, остаётся не больше двух', () => {
    const r = parseOperationAddress(
      'transfer',
      'tr-0000-4821',
      new URLSearchParams('at=1&also=a:aaaaaa&also=bad&also=b:bbbbbb&also=c:cccccc'),
    );
    expect(r.ok && r.address.also).toEqual([{ type: 'a', value: 'aaaaaa' }]);
  });
});

describe('кнопка «Открыть операцию»', () => {
  it('нет ключей — нет кнопки', () => {
    expect(chooseOperation([])).toBeNull();
  });

  it('наш id и id внешней системы на одном шаге — одна операция, второй идёт в also', () => {
    expect(chooseOperation([key('transfer', 'tr-0000-4821'), key('payout', '604217')])).toEqual({
      choices: [key('transfer', 'tr-0000-4821')],
      also: [{ type: 'payout', value: '604217' }],
    });
  });

  it('джоба по трём рассрочкам — выбор из трёх', () => {
    const keys = [
      key('installment', 'inst-000001'),
      key('installment', 'inst-000002'),
      key('installment', 'inst-000003'),
    ];
    const r = chooseOperation(keys)!;
    expect(r.choices).toHaveLength(3);
    expect(r.also).toEqual([]);
  });

  it('id, скрытый маскированием, в also не идёт', () => {
    const r = chooseOperation([
      key('transfer', 'tr-0000-4821'),
      key('payout', '60****', { masked: true }),
    ])!;
    expect(r.also).toEqual([]);
  });
});

describe('потоки операции', () => {
  const group = {
    kind: 'group' as const,
    role: 'worker' as const,
    title: 'Платёжное ядро · Подтверждение',
    cids: ['w1', 'w2'],
    firstMs: 2000,
    lastMs: 4000,
    failed: 1,
    lastStatus: null,
    flows: [flow('w1', 2000, { role: 'worker' }), flow('w2', 3000, { role: 'worker', error: true })],
    pauseMs: 0,
    together: false,
  };
  const v = view([
    flow('c1', 1000, { role: 'start' }),
    group,
    { kind: 'polls', count: 40, fromMs: 4000, toMs: 8000 },
    flow('cb', 5000, { role: 'callback', linkedBy: [{ type: 'payout', at: 'request' }] }),
    flow('m1', 9000, { role: 'mention', found: 'log-body' }),
  ]);

  it('группы раскрыты в потоки, опросы партнёра — не потоки', () => {
    expect(flowsOf(v).map((f) => f.cid)).toEqual(['c1', 'w1', 'w2', 'cb', 'm1']);
    expect(flowsOf(null)).toEqual([]);
  });

  it('«Запрос N из M» и соседи', () => {
    expect(positionOf(v, 'w2')).toMatchObject({
      index: 3,
      total: 5,
      prev: { cid: 'w1' },
      next: { cid: 'cb' },
    });
    expect(positionOf(v, 'c1')?.prev).toBeNull();
    expect(positionOf(v, 'чужой')).toBeNull();
  });

  it('узлы-ссылки — только более поздние потоки, без «id в тексте записи», с названием типа ключа', () => {
    const r = relatedAfter(v, 'w1');
    expect(r.map((x) => x.cid)).toEqual(['w2', 'cb']);
    expect(r[1]).toMatchObject({
      role: 'callback',
      key: { type: 'payout', name: 'id выплаты' },
    });
    expect(relatedAfter(v, 'cb')).toEqual([]);
    expect(relatedAfter(null, 'c1')).toEqual([]);
  });
});

describe('сегменты одного correlation_id', () => {
  const seg = (segment: number | null, t: number) => flow('same', t, { role: 'worker', segment });
  const v = view([flow('c1', 1000, { role: 'start' }), seg(0, 2000), seg(1, 3000), seg(2, 4000), flow('cb', 5000, { role: 'callback' })]);

  it('«Запрос N из M» и соседи различают сегменты', () => {
    expect(positionOf(v, 'same#0')).toMatchObject({ index: 2, next: { cid: 'same', segment: 1 } });
    expect(positionOf(v, 'same#1')).toMatchObject({ index: 3, prev: { segment: 0 }, next: { segment: 2 } });
    expect(positionOf(v, 'same#2')).toMatchObject({ index: 4, next: { cid: 'cb' } });
    // Ссылка без состояния: первый сегмент.
    expect(positionOf(v, 'same')).toMatchObject({ index: 2 });
  });

  it('узлы-ссылки: сегменты другого correlation_id — отдельно, свои сегменты — нет', () => {
    expect(relatedAfter(v, 'c1').map((x) => [x.cid, x.segment])).toEqual([
      ['same', 0],
      ['same', 1],
      ['same', 2],
      ['cb', null],
    ]);
    expect(relatedAfter(v, 'same#1').map((x) => x.cid)).toEqual(['cb']);
  });

  it('состояние перехода несёт сегмент', () => {
    const base = { searchId: 's1', operation: { href: '/pay/x' } };
    const next = linkTo(base, { firstRecordId: 'r9', segment: 2 });
    expect(readOperationLink(next)?.operation).toEqual({ href: '/pay/x', step: 'r9', segment: 2 });
  });
});

describe('уход со страницы операции', () => {
  const href = '/pay/demo/operations/transfer/tr-1?at=100&w=6h&search=s1';
  const to = (pathname: string, search = '', state: unknown = null) => ({ pathname, search, state });

  it('своя страница с тем же окном и свой поток — поиск продолжается', () => {
    expect(staysInOperation(href, 's1', to('/pay/demo/operations/transfer/tr-1', '?at=100&w=6h'))).toBe(true);
    expect(staysInOperation(href, 's1', to('/pay/demo/requests/c1', '?from=1&to=2', { searchId: 's1' }))).toBe(true);
  });

  it('поиск, другой поток без задания, другое окно — останавливается', () => {
    expect(staysInOperation(href, 's1', to('/pay/demo'))).toBe(false);
    expect(staysInOperation(href, 's1', to('/pay/demo/requests/c1', '?from=1&to=2', { searchId: 's2' }))).toBe(false);
    expect(staysInOperation(href, 's1', to('/pay/demo/operations/transfer/tr-1', '?at=100&w=24h'))).toBe(false);
    expect(staysInOperation(href, 's1', to('/pay/demo/operations/transfer/tr-2', '?at=100&w=6h'))).toBe(false);
  });
});

describe('переходы и ссылки', () => {
  it('состояние перехода читается только целиком', () => {
    expect(
      readOperationLink({
        searchId: 's1',
        operation: { href: '/pay/test/operations/transfer/x?search=s1', step: 'r7' },
      }),
    ).toEqual({
      searchId: 's1',
      operation: { href: '/pay/test/operations/transfer/x?search=s1', step: 'r7', segment: null },
    });
    expect(readOperationLink({ searchId: 's1', operation: { href: '/pay/x' } })?.operation.step).toBeNull();
    expect(readOperationLink({ searchId: 's1' })).toBeNull();
    expect(readOperationLink({ searchId: 's1', operation: { href: 'https://evil.example/' } })).toBeNull();
    expect(readOperationLink(null)).toBeNull();
  });

  it('сегмент без correlation_id несёт адрес операции без задания; обычный поток — только свою ссылку', () => {
    const href = '/pay/test/operations/transfer/tr-0000-4821?at=1&w=6h&search=s1';
    const seg = flowPath('pay', 'test', undefined, flow('nocid:worker-1:1000', 1000, { nocid: true }), href);
    expect(seg).toContain('/pay/test/requests/nocid%3Aworker-1%3A1000?from=1000&to=1500&op=');
    expect(readOperationHref(new URLSearchParams(seg.split('?')[1]).get('op'))).toBe(
      '/pay/test/operations/transfer/tr-0000-4821?at=1&w=6h',
    );
    expect(flowPath('pay', 'test', undefined, flow('c1', 1000), href)).toBe(
      '/pay/test/requests/c1?from=1000&to=1500',
    );
  });

  it('адрес операции из ссылки — только путь этого приложения', () => {
    expect(readOperationHref('//evil.example/operations/x')).toBeNull();
    expect(readOperationHref('/pay/test/requests/x')).toBeNull();
    expect(readOperationHref(null)).toBeNull();
  });
});

describe('таблица операции: буквы и общая шкала', () => {
  const H = 3_600_000;
  const group = (flows: OperationFlow[]): OperationView['items'][number] => ({
    kind: 'group',
    role: 'worker',
    title: 'Холд',
    cids: flows.map((f) => f.cid),
    firstMs: flows[0]!.firstMs,
    lastMs: flows[flows.length - 1]!.lastMs,
    failed: 0,
    lastStatus: null,
    flows,
    pauseMs: null,
    together: false,
  });

  it('буквы идут за Z без повторов', () => {
    expect([0, 25, 26, 27, 51, 52, 701, 702].map(rowLetter)).toEqual(['A', 'Z', 'AA', 'AB', 'AZ', 'BA', 'ZZ', 'AAA']);
  });

  it('у опросов буквы нет, у потока группы буква и номер', () => {
    const items: OperationView['items'] = [
      flow('a', 1000),
      { kind: 'polls', count: 40, fromMs: 1000, toMs: 2000 },
      group([flow('b', 3000), flow('c', 4000)]),
      { kind: 'unread', count: 3, fromMs: 5000, toMs: 6000, reason: 'limit' },
      flow('d', 7000, { segment: 2 }),
    ];
    const { rows, flows } = lettersOf(items);
    expect(rows).toEqual(['A', null, 'B', null, 'C']);
    expect([...flows.entries()]).toEqual([['a', 'A'], ['b', 'B1'], ['c', 'B2'], ['d#2', 'C']]);
  });

  it('шкала от первого запроса до последнего, час опросов её не растягивает', () => {
    const items: OperationView['items'] = [
      flow('a', H, { lastMs: H + 500 }),
      { kind: 'polls', count: 40, fromMs: H, toMs: 2 * H },
      flow('b', H + 20_000, { lastMs: H + 21_000 }),
    ];
    expect(scaleOf(items)).toEqual({ fromMs: H, spanMs: 21_000 });
    expect(scaleOf([{ kind: 'polls', count: 1, fromMs: H, toMs: 2 * H }])).toEqual({ fromMs: H, spanMs: H });
    expect(scaleOf([])).toBeNull();
  });

  it('положение и ширина в процентах, вне шкалы метка у края, нулевая шкала не делит на ноль', () => {
    const scale = { fromMs: 1000, spanMs: 1000 };
    expect(barOf(scale, 1250, 1500)).toEqual({ left: 25, width: 25 });
    expect(barOf(scale, 0, 500)).toEqual({ left: 0, width: 0 });
    expect(barOf(scale, 1500, 9000)).toEqual({ left: 50, width: 50 });
    expect(barOf({ fromMs: 1000, spanMs: 0 }, 1000, 1000)).toEqual({ left: 0, width: 0 });
  });

  it('опросы на шкале: часть отрезка подсчёта на шкале, обрезанная сторона открыта', () => {
    // Запросы заняли 47 с, подсчёт знает опросы в часе, который начался через 27 с после первого запроса.
    const scale = { fromMs: H, spanMs: 47_090 };
    const polls = { from: H + 27_124, to: H + 27_124 + H };
    expect(barOf(scale, polls.from, polls.to).left).toBeCloseTo(57.6, 1);
    expect(barOf(scale, polls.from, polls.to).left + barOf(scale, polls.from, polls.to).width).toBe(100);
    expect(cutOf(scale, polls.from, polls.to)).toEqual({ start: false, end: true });
    // Операция шла 6 часов, опросы внутри: оба конца закрыты.
    expect(cutOf({ fromMs: 0, spanMs: 6 * H }, 2 * H, 3 * H)).toEqual({ start: false, end: false });
    // Час опросов начался после конца шкалы: метка у правого края, открыта справа.
    expect(barOf(scale, H + 60_000, 2 * H)).toEqual({ left: 100, width: 0 });
    expect(cutOf(scale, H + 60_000, 2 * H)).toEqual({ start: false, end: true });
    // Час кончился раньше первого запроса: метка у левого края, открыта слева.
    expect(barOf(scale, 0, H - 1)).toEqual({ left: 0, width: 0 });
    expect(cutOf(scale, 0, H - 1)).toEqual({ start: true, end: false });
    // Отрезок шире шкалы с обеих сторон.
    expect(cutOf(scale, 0, 3 * H)).toEqual({ start: true, end: true });
  });

  it('опросы на шкале: только опросы — шкала по ним, концы закрыты; запрос без длительности — открыт справа', () => {
    const only: OperationView['items'] = [{ kind: 'polls', count: 6, fromMs: H, toMs: 2 * H }];
    const scale = scaleOf(only)!;
    expect(barOf(scale, H, 2 * H)).toEqual({ left: 0, width: 100 });
    expect(cutOf(scale, H, 2 * H)).toEqual({ start: false, end: false });
    const point = { fromMs: H, spanMs: 0 };
    expect(barOf(point, H, 2 * H)).toEqual({ left: 0, width: 0 });
    expect(cutOf(point, H, 2 * H)).toEqual({ start: false, end: true });
  });

  it('подписи шкалы круглые: 21,7 с — 10 и 20 с; 2 ч 14 мин — 1 и 2 ч; короткая шкала — только ноль', () => {
    expect(scaleTicks(21_700).map((t) => t.ms)).toEqual([0, 10_000, 20_000]);
    expect(scaleTicks(21_700)[1]!.left).toBeCloseTo(46.08, 1);
    expect(scaleTicks(2 * H + 14 * 60_000).map((t) => t.ms)).toEqual([0, H, 2 * H]);
    expect(scaleTicks(1).map((t) => t.ms)).toEqual([0]);
    expect(scaleTicks(0).map((t) => t.ms)).toEqual([0]);
    expect(scaleTicks(60 * H).map((t) => t.ms)).toEqual([0, 24 * H, 48 * H]);
  });

  it('типы связи без повторов, ключ первым', () => {
    const v = view([flow('a', 1, { linkedBy: [{ type: 'payout', at: 'path' }] }), flow('b', 2)]);
    expect(linkedTypes(v)).toEqual(['transfer', 'payout']);
  });

  it('строка операции над результатами: только открытый ключ, совпавший со значением', () => {
    const keys = [key('transfer', 'tr-0000-4821'), key('payout', '604217', { masked: true })];
    expect(operationKeyOfTerm(keys, 'tr-0000-4821')?.type).toBe('transfer');
    expect(operationKeyOfTerm(keys, '604217')).toBeNull();
    expect(operationKeyOfTerm(keys, 'other')).toBeNull();
    expect(operationKeyOfTerm(undefined, 'tr-0000-4821')).toBeNull();
  });
});

describe('spansDays', () => {
  const TZ = 'Asia/Karachi';
  const at = (iso: string) => Date.parse(`${iso}+05:00`);
  const flow = (first: string, last: string) => ({ kind: 'flow', firstMs: at(first), lastMs: at(last) }) as unknown as OperationItem;

  it('запросы в один день: окно поиска значения не имеет', () => {
    expect(spansDays([flow('2026-11-06T02:16:00', '2026-11-06T02:17:00')], TZ)).toBe(false);
  });

  it('запросы через полночь', () => {
    expect(spansDays([flow('2026-11-05T23:58:00', '2026-11-06T00:03:00')], TZ)).toBe(true);
    expect(spansDays([flow('2026-11-05T23:58:00', '2026-11-05T23:59:00'), flow('2026-11-06T00:03:00', '2026-11-06T00:04:00')], TZ)).toBe(true);
  });

  it('непрочитанный участок через полночь не считается, опросы считаются', () => {
    const unread = { kind: 'unread', count: 1, fromMs: at('2026-11-05T20:00:00'), toMs: at('2026-11-06T02:00:00'), reason: 'limit' } as OperationItem;
    expect(spansDays([flow('2026-11-06T02:16:00', '2026-11-06T02:17:00'), unread], TZ)).toBe(false);
    const polls = { kind: 'polls', count: 2, fromMs: at('2026-11-05T23:59:00'), toMs: at('2026-11-06T00:01:00') } as OperationItem;
    expect(spansDays([polls], TZ)).toBe(true);
  });

  it('полночь считается в часовом поясе проекта', () => {
    expect(spansDays([flow('2026-11-06T04:59:00', '2026-11-06T05:01:00')], TZ)).toBe(false);
    expect(spansDays([flow('2026-11-06T04:59:00', '2026-11-06T05:01:00')], 'UTC')).toBe(true);
  });
});

describe('блок «Что случилось»: какой запрос и какие слова', () => {
  const STATUS = { type: 'transfer', value: 'failed', raw: 'failed', name: 'Отказ', outcome: 'failure', order: 1 } as OperationView['outcome']['status'];
  const outcome = (kind: OperationView['outcome']['kind'], basis: OperationView['outcome']['basis'] = null, over: Partial<OperationView['outcome']> = {}): OperationView['outcome'] => ({
    kind,
    status: kind === 'failure' || kind === 'success' ? STATUS : null,
    previous: null,
    basis,
    cid: 'late',
    partial: false,
    failed: 0,
    ...over,
  });
  const op = (items: OperationView['items'], o = outcome('unknown')): OperationView => ({ ...view(items), outcome: o });
  const failed = (cid: string, at: number, over: Partial<OperationFlow> = {}) => flow(cid, at, { error: true, status: 'error', ...over });

  it('ошибок нет: блока нет', () => {
    expect(summaryPlan(op([flow('a', 1), flow('b', 2)]), false)).toBeNull();
    expect(summaryPlan(op([flow('a', 1)], outcome('success', 'confirmed')), false)).toBeNull();
    expect(summaryPlan(op([]), false)).toBeNull();
  });

  it('самый ранний запрос с ошибкой, даже если в списке он не первый и лежит в группе', () => {
    const group = { kind: 'group', role: 'status', title: 'Статус', cids: ['g1', 'g2'], firstMs: 5, lastMs: 9, failed: 1, lastStatus: null, flows: [flow('g1', 5), failed('g2', 7)], pauseMs: 0, together: false } as OperationGroup;
    const plan = summaryPlan(op([failed('late', 30), group, flow('ok', 1)], outcome('failure', 'confirmed')), false);
    expect(plan).toMatchObject({ kind: 'reason', lead: 'failure', flow: { cid: 'g2' } });
    expect(summaryPlan(op([failed('late', 30), failed('early', 10)], outcome('failure', 'confirmed')), false)?.flow?.cid).toBe('early');
  });

  it('при равном времени первый в списке', () => {
    expect(summaryPlan(op([failed('x', 10), failed('y', 10)], outcome('failure', 'confirmed')), false)?.flow?.cid).toBe('x');
  });

  it('упавшая строка с сегментом выбирается сама, а не первая строка того же correlation_id', () => {
    const plan = summaryPlan(op([flow('c', 1, { segment: 0 }), failed('c', 400, { segment: 1 }), flow('c', 800, { segment: 2 })]), false);
    expect(plan?.flow).toMatchObject({ cid: 'c', segment: 1 });
  });

  it('подтверждённый успех после ошибки: спокойная строка с числом, записи не читаются', () => {
    const plan = summaryPlan(op([failed('a', 1), failed('b', 2), flow('c', 3)], outcome('success', 'confirmed')), false);
    expect(plan).toMatchObject({ kind: 'calm', lead: 'success', failed: 2, flow: { cid: 'a' } });
  });

  it('успех только по колбэку не считается успехом: причина нужна, слов «не прошла» нет', () => {
    expect(summaryPlan(op([failed('a', 1)], outcome('success', 'claimed')), false)).toMatchObject({ kind: 'reason', lead: 'claimed' });
  });

  it('итог неизвестен или операция идёт: причина есть, слов о неудаче нет', () => {
    expect(summaryPlan(op([failed('a', 1)], outcome('pending')), false)).toMatchObject({ kind: 'reason', lead: 'pending' });
    expect(summaryPlan(op([failed('a', 1)]), false)).toMatchObject({ kind: 'reason', lead: 'unknown' });
    expect(summaryPlan(op([failed('a', 1)]), true)).toMatchObject({ kind: 'reason', lead: 'notRead' });
  });

  it('упоминание в тексте записи не считается: чужая ошибка не становится причиной', () => {
    expect(summaryPlan(op([flow('m', 1, { role: 'mention', status: 'error' })]), false)).toBeNull();
    expect(summaryPlan(op([flow('m', 1, { role: 'mention', status: 'error' }), failed('a', 5)], outcome('failure', 'confirmed')), false)?.flow?.cid).toBe('a');
  });

  it('запрос на несколько операций: ошибка в шагах другой не считается, своя не даёт читать записи', () => {
    expect(summaryPlan(op([flow('j', 1, { ops: 3, status: 'error' })]), false)).toBeNull();
    expect(summaryPlan(op([failed('j', 1, { ops: 3 })]), false)).toMatchObject({ kind: 'shared', flow: { cid: 'j' } });
  });

  it('отказ только статусом: строка из статуса, записи не читаются', () => {
    const plan = summaryPlan(op([flow('early', 1), flow('late', 2)], outcome('failure', 'claimed')), false);
    expect(plan).toMatchObject({ kind: 'status', lead: 'failure', flow: { cid: 'late' }, status: { name: 'Отказ' } });
    expect(summaryPlan(op([flow('other', 1)], outcome('failure', 'confirmed')), false)).toMatchObject({ kind: 'status', flow: null });
  });
});
