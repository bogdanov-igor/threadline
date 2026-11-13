// Эталон разбора синтетического набора Demo Pay встроенным профилем json: запросы, сводки, устройство записей и ключи подсчёта.
// Снимок ловит незаметные изменения разбора, сводок и подсчёта. Поля ViewRecord.gateway и flow в снимок не входят:
// шлюз и подсказку шага графа проверяют свои тесты.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { CountQuery, LogLine } from '@threadline/core/backend';
import { buildView, markPending, parseLine, summarize, type ParsedRecord, type ViewRecord } from '@threadline/core/search';
import { countLogql } from '../src/backends/logql.ts';
import { generatePayDataset } from '../src/backends/mock/dataset-pay.ts';
import { MockBackend } from '../src/backends/mock/index.ts';
import { builtinCountKey } from './count-key.ts';

const ANCHOR = Date.UTC(2026, 10, 2, 9, 0, 0);
const DAY = { fromMs: ANCHOR - 86_400_000, toMs: ANCHOR };
const cfg = { type: 'mock' as const, dataset: 'pay' as const, latencyMs: 0, maxConcurrent: 4, queueTimeoutSeconds: 10, timeoutSeconds: 30 };

/** JSON с ключами по алфавиту: снимок не зависит от порядка полей в объекте. */
function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]]))
      : x,
  );
}

const sha = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');

/** Запись без полей gateway и flow: их нет в эталоне (flow — подсказка шага графа). */
function project(v: ViewRecord): Omit<ViewRecord, 'gateway' | 'flow'> {
  const { gateway: _g, flow: _f, ...rest } = v;
  return rest;
}

/** Устройство записи без значений: вид, есть ли correlation_id, связь отправки и ответа, ошибка, компонент. */
function shape(records: ViewRecord[]) {
  const index = new Map(records.map((r, i) => [r.id, i]));
  return records.map((r) => ({
    kind: r.kind,
    cid: r.correlationId !== null,
    pair: r.http?.pairId ? (index.get(r.http.pairId) ?? null) : null,
    isError: r.isError,
    component: r.component,
  }));
}

function requests(lines: LogLine[], readEndMs: number) {
  const groups = new Map<string, ParsedRecord[]>();
  for (const l of lines) {
    const r = parseLine(l);
    if (r.correlationId === null) continue;
    const g = groups.get(r.correlationId);
    if (g) g.push(r);
    else groups.set(r.correlationId, [r]);
  }
  const opts = { readEndMs, incomplete: false };
  return [...groups.keys()].sort().map((cid) => {
    const recs = groups.get(cid)!;
    const view = markPending(buildView(recs, { withOffsets: true }), opts);
    return { cid, summary: summarize(cid, recs, { match: 'exact', ...opts }), view: view.map(project), shape: shape(view) };
  });
}

describe('эталон разбора Demo Pay: синтетический набор', () => {
  // Формы потоков графа — в своём генераторе: эталон основных сценариев от них не зависит.
  const { records } = generatePayDataset(ANCHOR, { flowScenarios: false });
  const lines: LogLine[] = records.map((r) => ({ tsNs: r.tsNs.toString(), line: r.line, labels: r.labels }));

  it('запросы, записи и сводки', async () => {
    const got = requests(lines, ANCHOR);
    const snapshot = {
      requests: got.map((r) => ({ cid: r.cid, summary: r.summary, shape: r.shape, view: sha(r.view) })),
      // «Все записи»: каждая строка отдельно, в том числе строки-текст.
      flat: sha(lines.map((l) => project(buildView([parseLine(l)], { withOffsets: false })[0]!))),
      kinds: lines.map((l) => buildView([parseLine(l)], { withOffsets: false })[0]!.kind).join(','),
    };
    await expect(JSON.stringify(snapshot, null, 1)).toMatchFileSnapshot('./__golden__/pay-synthetic.json');
  });

  it('ключи подсчёта имитации и строка LogQL подсчёта', async () => {
    const mock = new MockBackend(cfg, { anchorMs: ANCHOR, flowScenarios: false });
    const q: CountQuery = { selector: [], filters: [], range: DAY, ...builtinCountKey() };
    const counts = await mock.countBy(q, AbortSignal.timeout(5000));
    const ordered = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : 1)));
    const logql = countLogql(
      {
        selector: [
          { label: 'cluster', op: '=', value: 'demo' },
          { label: 'namespace', op: '=', value: 'pay' },
        ],
        filters: [
          { kind: 'contains', value: 'v1' },
          { kind: 'regex', pattern: '555555(?:\\d{6}|\\*{6})5727' },
        ],
        range: DAY,
        ...builtinCountKey(),
      },
      3600,
    );
    await expect(JSON.stringify({ counts: ordered, logql }, null, 1)).toMatchFileSnapshot('./__golden__/pay-count.json');
  });
});
