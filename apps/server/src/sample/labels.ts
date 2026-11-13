// Вид labels: имена меток, значения трёх меток и метки потоков записей шлюза. Содержимое строк шлюза в файл не идёт.

import type { Filter } from '@threadline/core/backend';
import type { Profile } from '@threadline/core/profile';
import { normalizeFieldName } from '@threadline/core/search';
import { inspectLine, type KindContext } from './context.ts';
import { GATEWAY_LINES, GATEWAY_WINDOW_MS, MAX_LABEL_NAMES, MAX_LABEL_VALUES, TEXT_FIELDS, VALUE_LABELS } from './limits.ts';
import { flowLabels, labelValue, uniqueKey, valueOrLabel } from './structure.ts';

/** Значения меток за окно выборки. Метка могла молчать последние 5 минут: запрос идёт независимо от списка имён. */
export async function readLabelValues(ctx: KindContext): Promise<Map<string, string[]>> {
  for (const label of VALUE_LABELS) {
    if (ctx.labelValues.has(label)) continue;
    const values = await ctx.reader.labelValues(label, ctx.opSelector, { fromMs: ctx.nowMs - ctx.sinceMs, toMs: ctx.nowMs });
    ctx.labelValues.set(label, [...new Set(values)].sort());
  }
  return ctx.labelValues;
}

/** Фильтры шлюза: имена из условия варианта. Текстовое message есть почти в каждой строке и ничего не отбирает. */
export function gatewayFilters(profile: Profile): Filter[] | null {
  const variant = profile.variants.find((v) => v.gateway === true);
  if (!variant) return null;
  return (variant.when?.has ?? [])
    .map((p) => p.slice(p.lastIndexOf('.') + 1))
    .filter((n) => !TEXT_FIELDS.has(normalizeFieldName(n)))
    .map((value) => ({ kind: 'contains', value }));
}

export async function sampleLabels(ctx: KindContext, out: Record<string, unknown>): Promise<void> {
  const names = await ctx.reader.labelNames();
  const sorted = [...new Set(names)].sort();
  const seen = new Map<string, number>();
  out.names = { scope: 'all-loki-5m', total: sorted.length, list: sorted.slice(0, MAX_LABEL_NAMES).map((n) => uniqueKey(n, seen)) };

  const values = await readLabelValues(ctx);
  const shown: Record<string, unknown> = {};
  out.values = shown;
  for (const label of VALUE_LABELS) {
    const list = values.get(label) ?? [];
    shown[label] = { total: list.length, list: list.slice(0, MAX_LABEL_VALUES).map(labelValue) };
  }

  const filters = gatewayFilters(ctx.profile);
  if (!filters) {
    out.gateway = { supported: false };
    return;
  }
  const lines = await ctx.reader.lines({
    selector: ctx.selector,
    filters,
    range: { fromMs: ctx.nowMs - GATEWAY_WINDOW_MS, toMs: ctx.nowMs },
    limit: GATEWAY_LINES,
    direction: 'backward',
  });
  const groups = new Map<string, { count: number; variant: string | null; labels: Record<string, string> }>();
  let found = 0;
  for (const line of lines) {
    const x = inspectLine(ctx.compiled, line);
    if (!x.record.gateway) continue;
    found++;
    const labels = flowLabels(line.labels);
    const key = JSON.stringify([x.variant, labels]);
    const g = groups.get(key);
    if (g) g.count++;
    else groups.set(key, { count: 1, variant: x.variant === null ? null : valueOrLabel(x.variant), labels });
  }
  out.gateway = { supported: true, read: lines.length, found, streams: [...groups.values()] };
}
