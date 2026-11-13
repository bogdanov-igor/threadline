// Вид background: кандидаты по значениям меток, их последние строки и форма потока по correlation_id. В файл идут только числа и устройство.

import { cidSegments, SEGMENT_GAP_MS } from '@threadline/core/flow';
import { buildEntry, inspectLine, type Inspected, type KindContext } from './context.ts';
import { readLabelValues } from './labels.ts';
import {
  BACKGROUND_WORDS,
  CANDIDATE_LINES,
  FLOW_GAP_MIN_SEC,
  FLOW_LINES,
  FLOW_WINDOW_MS,
  MAX_BACKGROUND_READS,
  MAX_CANDIDATE_READS,
  MAX_CANDIDATES_WITH_LINES,
  MAX_FLOW_GAPS,
  MAX_FLOWS,
  MAX_KEPT_INT,
  VALUE_LABELS,
} from './limits.ts';
import { flowLabelValue, labelValue, type ShapeOptions } from './structure.ts';

export interface Candidate {
  label: string;
  value: string;
}

/** Кандидаты: слово фоновой работы, отделённое «-» или «_». Порядок: worker, consumer, cron, остальные; одно значение — один раз. */
export function findCandidates(values: ReadonlyMap<string, readonly string[]>): Candidate[] {
  const seen = new Set<string>();
  const out: { c: Candidate; rank: number }[] = [];
  for (const label of VALUE_LABELS) {
    for (const value of values.get(label) ?? []) {
      if (seen.has(value)) continue;
      const words = value.toLowerCase().split(/[-_]/);
      const rank = BACKGROUND_WORDS.findIndex((w) => words.includes(w));
      if (rank < 0) continue;
      seen.add(value);
      out.push({ c: { label, value }, rank: Math.min(rank, 3) });
    }
  }
  return out.sort((a, b) => a.rank - b.rank).map((x) => x.c);
}

/** Паузы в секундах. Время записи с неверной датой не должно дать серию цифр и отменить файл. */
const roundSec = (ms: number) => Math.min(Math.round(ms / 1000), MAX_KEPT_INT);

/** Форма потока: только числа. Записи с другим разобранным correlation_id считаются упоминанием. */
export function flowShape(ref: string, cid: string, records: readonly Inspected[], truncated: boolean): Record<string, unknown> {
  const own = records.map((x) => x.record).filter((r) => r.correlationId === cid);
  const sorted = [...own].sort((a, b) => a.timeMs - b.timeMs);
  const gaps: number[] = [];
  let maxGap = 0;
  sorted.forEach((r, i) => {
    if (i === 0) return;
    const gap = roundSec(r.timeMs - sorted[i - 1]!.timeMs);
    if (gap > maxGap) maxGap = gap;
    if (gap > FLOW_GAP_MIN_SEC && gaps.length < MAX_FLOW_GAPS) gaps.push(gap);
  });
  const components: Record<string, number> = {};
  const kinds: Record<string, number> = {};
  for (const r of own) {
    const name = r.component === null ? '<none>' : flowLabelValue('container', r.component);
    Object.defineProperty(components, name, { value: (components[name] ?? 0) + 1, enumerable: true, writable: true, configurable: true });
    kinds[r.kind] = (kinds[r.kind] ?? 0) + 1;
  }
  return {
    ref,
    read: own.length,
    truncated,
    mentions: records.length - own.length,
    hasIncoming: own.some((r) => r.kind === 'incoming'),
    hasGateway: own.some((r) => r.gateway),
    components,
    kinds,
    gapsOver30s: gaps,
    maxGapSec: maxGap,
    ruleGapSec: SEGMENT_GAP_MS / 1000,
    segmentsByRule: cidSegments(own).length,
  };
}

export async function sampleBackground(ctx: KindContext, out: Record<string, unknown>): Promise<void> {
  const shape: ShapeOptions = { ...ctx.catalog.shape, frequent: new Set() };
  const candidates = findCandidates(await readLabelValues(ctx));
  const results: Record<string, unknown>[] = [];
  out.since = ctx.sinceText;
  out.candidates = results;
  out.notRead = candidates.map(named);

  let reads = 0;
  let withLines = 0;
  /** Потоки по correlation_id: ключ — значение, только в памяти. */
  const flows = new Map<string, { atMs: number; owner: Record<string, unknown>[] }>();
  for (const c of candidates) {
    if (reads >= MAX_CANDIDATE_READS || withLines >= MAX_CANDIDATES_WITH_LINES) break;
    reads++;
    const lines = await ctx.reader.lines({
      selector: [...ctx.opSelector, { label: c.label, op: '=', value: c.value }],
      filters: [],
      range: { fromMs: ctx.nowMs - ctx.sinceMs, toMs: ctx.nowMs },
      limit: CANDIDATE_LINES,
      direction: 'backward',
    });
    out.notRead = candidates.slice(reads).map(named);
    const inspected = lines.map((l) => inspectLine(ctx.compiled, l));
    if (lines.length > 0) withLines++;
    const flowList: Record<string, unknown>[] = [];
    const result: Record<string, unknown> = {
      ...named(c),
      found: lines.length,
      correlation: correlationOf(inspected),
      entries: inspected.map((x) => buildEntry(ctx, x, shape)),
      flows: flowList,
    };
    const between = betweenOf(inspected);
    if (between) result.between = between;
    results.push(result);
    for (const x of inspected) {
      const cid = x.record.correlationId;
      if (cid !== null && !flows.has(cid)) flows.set(cid, { atMs: x.record.timeMs, owner: flowList });
    }
  }

  const room = Math.min(MAX_FLOWS, MAX_BACKGROUND_READS - reads);
  for (const [cid, f] of [...flows].slice(0, Math.max(0, room))) {
    const lines = await ctx.reader.lines({
      selector: ctx.opSelector,
      filters: [{ kind: 'contains', value: cid }],
      range: { fromMs: f.atMs - FLOW_WINDOW_MS, toMs: f.atMs + FLOW_WINDOW_MS },
      limit: FLOW_LINES,
      direction: 'forward',
    });
    f.owner.push(flowShape(ctx.refs.ref(cid), cid, lines.map((l) => inspectLine(ctx.compiled, l)), lines.length >= FLOW_LINES));
  }
}

const named = (c: Candidate) => ({ label: c.label, value: labelValue(c.value) });

function correlationOf(lines: readonly Inspected[]): 'present' | 'none' | 'mixed' | null {
  if (lines.length === 0) return null;
  const withCid = lines.filter((x) => x.record.correlationId !== null).length;
  return withCid === 0 ? 'none' : withCid === lines.length ? 'present' : 'mixed';
}

function betweenOf(lines: readonly Inspected[]): { gapSec: number; samePod: boolean } | null {
  const [a, b] = lines;
  if (!a || !b) return null;
  const pod = a.line.labels.pod;
  return { gapSec: roundSec(Math.abs(a.record.timeMs - b.record.timeMs)), samePod: pod !== undefined && pod === b.line.labels.pod };
}
