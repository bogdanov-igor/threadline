// Генератор демо-логов быстрого старта: тело push Loki, метки потоков, куски и живой поток (deploy/quickstart).
import { describe, expect, it } from 'vitest';
import {
  LIVE_SCENARIOS,
  MOCK_FLOW,
  MOCK_PHONE,
  payScenario,
  type MockRecord,
} from '../src/backends/mock/dataset-pay.ts';
import {
  batches,
  DEMO_IDS,
  history,
  LiveFeed,
  MAX_CATCH_UP_MS,
  pushBody,
  STABLE_EVERY_MS,
  streamLabels,
} from '../src/demo-logs/generator.ts';

const NOW = Date.UTC(2026, 10, 12, 9, 0, 0);
const ns = (ms: number) => BigInt(ms) * 1_000_000n;
const LABEL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Записи живого потока за minutes минут с шагом в секунду, как их забирает цикл генератора. */
function run(feed: LiveFeed, fromMs: number, minutes: number): MockRecord[] {
  const out: MockRecord[] = [];
  for (let t = fromMs; t <= fromMs + minutes * 60_000; t += 1000) out.push(...feed.due(t));
  return out;
}

describe('тело push', () => {
  const records = history(NOW);
  const body = pushBody(records);

  it('в формате push API Loki: потоки с метками и значения [время в нс строкой, строка]', () => {
    const parsed = JSON.parse(JSON.stringify(body)) as typeof body;
    expect(parsed.streams.length).toBeGreaterThan(0);
    for (const s of parsed.streams) {
      for (const [k, v] of Object.entries(s.stream)) {
        expect(k).toMatch(LABEL_NAME);
        expect(typeof v).toBe('string');
      }
      for (const value of s.values) {
        expect(value).toHaveLength(2);
        expect(value[0]).toMatch(/^\d{19}$/);
        expect(typeof value[1]).toBe('string');
      }
    }
  });

  it('переносит каждую запись ровно один раз, строку как есть', () => {
    const lines = body.streams.flatMap((s) => s.values.map(([t, line]) => `${t} ${line}`)).sort();
    expect(lines).toEqual(records.map((r) => `${r.tsNs} ${r.line}`).sort());
  });

  it('внутри потока время не убывает', () => {
    for (const s of body.streams) {
      const ts = s.values.map(([t]) => BigInt(t));
      expect(ts.every((t, i) => i === 0 || t >= ts[i - 1]!)).toBe(true);
    }
  });

  it('потоков немного: под постоянный у компонента, а не свой у каждой записи', () => {
    expect(records.length).toBeGreaterThan(500);
    expect(body.streams.length).toBeLessThan(40);
    const keys = body.streams.map((s) => JSON.stringify(Object.entries(s.stream).sort()));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('метки как у пода в Kubernetes: namespace, container, компонент, под', () => {
    const pay = body.streams.filter((s) => s.stream.namespace === 'pay').map((s) => s.stream);
    expect(new Set(pay.map((s) => s.container))).toEqual(new Set(['api', 'cards', 'gateway', 'worker']));
    for (const s of pay) {
      expect(s.app_kubernetes_io_component).toBe(s.container);
      expect(s.pod).toMatch(new RegExp(`^pay-app-${s.container}-[0-9a-z]+-[0-9a-z]{5}$`));
    }
  });
});

describe('метки потока', () => {
  const base = {
    cluster: 'demo',
    namespace: 'pay',
    container: 'api',
    pod: 'pay-app-api-6f8d9c7b5d-abcde',
    host: 'demo-node-2',
  };

  it('случайный под набора становится постоянным у компонента в namespace', () => {
    const a = streamLabels(base);
    const b = streamLabels({ ...base, pod: 'pay-app-api-6f8d9c7b5d-zyxwv', host: 'demo-node-0' });
    expect(a).toEqual(b);
    expect(a.pod).toMatch(/^pay-app-api-6f8d9c7b5d-[a-z]{5}$/);
    expect(a.host).toMatch(/^demo-node-[0-3]$/);
    expect(streamLabels({ ...base, namespace: 'pay-test' }).pod).not.toBe(a.pod);
    expect(streamLabels({ ...base, container: 'cards', pod: 'pay-app-cards-6f8d9c7b5d-abcde' }).pod).not.toBe(
      a.pod,
    );
  });

  it('постоянный под воркера без correlation_id и остальные метки не меняются', () => {
    const own = {
      ...base,
      container: 'worker',
      pod: MOCK_FLOW.nocidPod,
      app_kubernetes_io_sub_service: 'cron',
    };
    expect(streamLabels(own)).toEqual(own);
    expect(streamLabels(base)).toMatchObject({ cluster: 'demo', namespace: 'pay', container: 'api' });
  });
});

describe('куски', () => {
  const rec = (i: number, size: number): MockRecord => ({
    tsNs: ns(NOW + i),
    labels: { namespace: 'pay' },
    line: 'x'.repeat(size),
  });

  it('не больше предела, порядок и все записи на месте; запись больше предела идёт одна', () => {
    const records = [rec(0, 400), rec(1, 400), rec(2, 400), rec(3, 2000), rec(4, 100)];
    const parts = batches(records, 1000);
    expect(parts.map((p) => p.map((r) => Number((r.tsNs - ns(NOW)) / 1_000_000n)))).toEqual([
      [0, 1],
      [2],
      [3],
      [4],
    ]);
    expect(parts.flat()).toEqual(records);
  });

  it('история за сутки кусками по 1 МБ', () => {
    const records = history(NOW);
    const parts = batches(records, 1024 * 1024);
    expect(parts.flat()).toHaveLength(records.length);
    for (const p of parts)
      if (p.length > 1)
        expect(p.reduce((n, r) => n + Buffer.byteLength(r.line), 0)).toBeLessThanOrEqual(1024 * 1024);
  });
});

describe('живой поток', () => {
  it('отдаёт записи, когда их время пришло, по возрастанию, ничего из будущего', () => {
    const feed = new LiveFeed({ startMs: NOW, intervalMs: 10_000, seed: 7 });
    let last = 0n;
    for (let t = NOW; t <= NOW + 10 * 60_000; t += 1000) {
      const due = feed.due(t);
      for (const r of due) {
        expect(r.tsNs <= ns(t)).toBe(true);
        expect(r.tsNs >= last).toBe(true);
        last = r.tsNs;
      }
    }
    expect(last > ns(NOW + 9 * 60_000)).toBe(true);
  });

  it('шаг запроса отдаётся в тот опрос, когда пришло его время: ответ через 20 секунд ждёт 20 секунд', () => {
    const feed = new LiveFeed({ startMs: NOW, intervalMs: 10_000, seed: 1 });
    const spans = new Map<string, [bigint, bigint]>();
    for (let t = NOW; t <= NOW + 5 * 60_000; t += 1000) {
      for (const r of feed.due(t)) {
        expect(r.tsNs > ns(t - 1000) && r.tsNs <= ns(t)).toBe(true);
        const cid = /"correlation_id":"([^"]+)"/.exec(r.line)?.[1];
        if (!cid) continue;
        const [from, to] = spans.get(cid) ?? [r.tsNs, r.tsNs];
        spans.set(cid, [from < r.tsNs ? from : r.tsNs, to > r.tsNs ? to : r.tsNs]);
      }
    }
    expect([...spans.values()].some(([from, to]) => to - from > ns(15_000))).toBe(true);
    expect(feed.pending).toBeGreaterThan(0);
  });

  it('пишет постоянные значения README: пользователь, карта и телефон каждые 3 минуты', () => {
    const feed = new LiveFeed({ startMs: NOW, intervalMs: 10_000, seed: 3 });
    const lines = run(feed, NOW, 3).map((r) => r.line);
    expect(lines.some((l) => l.includes(DEMO_IDS.user))).toBe(true);
    expect(lines.some((l) => l.includes(DEMO_IDS.card))).toBe(true);
    expect(lines.some((l) => l.includes(MOCK_PHONE.spellings[0]))).toBe(true);
    expect(DEMO_IDS.phone).toBe(MOCK_PHONE.value);
  });

  it('за 6 часов на постоянное значение меньше 200 запросов: поиск по умолчанию их показывает', () => {
    const perValue = (6 * 60 * 60_000) / (3 * STABLE_EVERY_MS);
    expect(perValue).toBeLessThan(200);
    const feed = new LiveFeed({ startMs: NOW, intervalMs: 10_000, seed: 5 });
    const cids = new Set<string>();
    for (const r of run(feed, NOW, 60)) {
      if (!r.line.includes(DEMO_IDS.card)) continue;
      const cid = /"correlation_id":"([^"]+)"/.exec(r.line)?.[1];
      if (cid) cids.add(cid);
    }
    expect(cids.size).toBe(20);
  });

  it('у каждого запроса свои id: два потока с разным началом не совпадают', () => {
    const a = new Set(
      run(new LiveFeed({ startMs: NOW, intervalMs: 10_000, seed: 11 }), NOW, 2).map((r) => r.line),
    );
    const b = run(new LiveFeed({ startMs: NOW, intervalMs: 10_000, seed: 12 }), NOW, 2).map((r) => r.line);
    expect(b.filter((l) => a.has(l))).toEqual([]);
  });

  it('после долгого простоя не догоняет пропущенное', () => {
    const feed = new LiveFeed({ startMs: NOW, intervalMs: 10_000, seed: 9 });
    run(feed, NOW, 1);
    const gap = NOW + 60_000 + 2 * MAX_CATCH_UP_MS;
    const after = [...feed.due(gap), ...run(feed, gap + 1000, 1)];
    // Пропущенных запросов нет: только хвосты начатых до простоя и новые после него.
    expect(after.filter((r) => r.tsNs >= ns(NOW + 2 * 60_000) && r.tsNs < ns(gap))).toEqual([]);
    expect(after.filter((r) => r.tsNs > ns(gap)).length).toBeGreaterThan(0);
  });
});

describe('сценарии живого потока', () => {
  it.each(LIVE_SCENARIOS)('%s: записи от начала, строки набора, по возрастанию', (kind) => {
    const records = payScenario(kind, NOW, 42);
    expect(records.length).toBeGreaterThan(0);
    expect(records.every((r) => r.tsNs >= ns(NOW))).toBe(true);
    expect(records.every((r, i) => i === 0 || r.tsNs >= records[i - 1]!.tsNs)).toBe(true);
    expect(records.every((r) => r.labels.namespace === 'pay')).toBe(true);
    expect(payScenario(kind, NOW, 42).map((r) => r.line)).toEqual(records.map((r) => r.line));
  });

  it('постоянный пользователь в запросах api, постоянная карта в поиске карт', () => {
    for (const kind of [
      'card-info',
      'transfer-fee',
      'payment-declined',
      'acquirer-error',
      'fraud-timeout',
      'kyc-rejected',
    ] as const) {
      expect(
        payScenario(kind, NOW, 1, { user: DEMO_IDS.user }).some((r) =>
          r.line.includes(`/v1/users/${DEMO_IDS.user}/`),
        ),
        kind,
      ).toBe(true);
    }
    expect(
      payScenario('card-lookup-failed', NOW, 1, { pan: DEMO_IDS.card }).some((r) =>
        r.line.includes(`<cardNumber>${DEMO_IDS.card}</cardNumber>`),
      ),
    ).toBe(true);
    expect(
      payScenario('card-lookup-failed', NOW, 1, { pan: DEMO_IDS.card }).some((r) =>
        r.line.includes('PRC-ERR-0027'),
      ),
    ).toBe(true);
  });
});
