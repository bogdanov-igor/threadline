// Проверка профиля формата на образце строк: виды и варианты, доля строк с correlation_id, согласие подсчёта
// и разбора, поля без значений. Значений и тел не печатает: образец может быть с прода.

import type { LogLine } from '@threadline/core/backend';
import { COUNT_GROUP, FIELD_NAMES, isCountKey, re2ToJs, type CompiledProfile, type FieldName, type Profile } from '@threadline/core/profile';

const NO_VARIANT = '(нет варианта)';
/** Номеров строк с расхождением в отчёте не больше. */
const MAX_LINE_NUMBERS = 10;

/** Поля, которые вариант задаёт сам или в правилах вида. */
function declaredFields(profile: Profile): Map<string, Set<FieldName>> {
  const out = new Map<string, Set<FieldName>>();
  for (const v of profile.variants) {
    const set = new Set<FieldName>();
    for (const f of [v.fields, ...(v.kinds ?? []).map((k) => k.fields)]) for (const k of FIELD_NAMES) if (f?.[k] !== undefined) set.add(k);
    out.set(v.name, set);
  }
  return out;
}

const pct = (n: number, total: number) => (total === 0 ? '0%' : `${Math.round((n / total) * 100)}%`);
const numbers = (xs: number[]) => xs.slice(0, MAX_LINE_NUMBERS).join(', ') + (xs.length > MAX_LINE_NUMBERS ? ` и ещё ${xs.length - MAX_LINE_NUMBERS}` : '');

/** Отчёт по образцу: строки текста для печати. lines — строки хранилища по порядку, номера с 1. */
export function checkSample(compiled: CompiledProfile, profile: Profile, lines: LogLine[]): string[] {
  const re = re2ToJs(compiled.countRegexp);
  const byVariant = new Map<string, Map<string, number>>();
  const found = new Map<string, Set<FieldName>>();
  let withCid = 0;
  const missed: number[] = [];
  const extra: number[] = [];
  const differ: number[] = [];

  lines.forEach((l, i) => {
    const { record, variant, found: f } = compiled.inspect(l);
    const v = variant ?? NO_VARIANT;
    const kinds = byVariant.get(v) ?? new Map<string, number>();
    kinds.set(record.kind, (kinds.get(record.kind) ?? 0) + 1);
    byVariant.set(v, kinds);
    if (variant) {
      const hit = found.get(variant) ?? new Set<FieldName>();
      for (const k of f) hit.add(k);
      found.set(variant, hit);
    }
    if (record.correlationId !== null) withCid++;
    const k = re.exec(l.line)?.groups?.[COUNT_GROUP];
    const key = isCountKey(k) ? k : null;
    const parsed = record.correlationId;
    if (key === parsed || (key === null && parsed === null)) return;
    if (key === null) missed.push(i + 1);
    else if (parsed === null) extra.push(i + 1);
    else differ.push(i + 1);
  });

  const out = [`Формат: ${compiled.name}, строк: ${lines.length}`, 'Варианты и виды записей:'];
  const order = [...profile.variants.map((v) => v.name), NO_VARIANT];
  for (const v of order) {
    const kinds = byVariant.get(v);
    if (!kinds) {
      if (v !== NO_VARIANT) out.push(`  ${v}: 0`);
      continue;
    }
    const total = [...kinds.values()].reduce((a, b) => a + b, 0);
    out.push(`  ${v}: ${total} (${[...kinds.entries()].map(([k, n]) => `${k} ${n}`).join(', ')})`);
  }
  out.push(`correlation_id разобран: ${withCid} из ${lines.length} (${pct(withCid, lines.length)})`);
  out.push(`Выражение подсчёта: ${compiled.countRegexp}`);
  if (missed.length + extra.length + differ.length === 0) out.push('Подсчёт и разбор согласны на всех строках.');
  if (missed.length > 0) {
    out.push(
      `  подсчёт не находит разобранный correlation_id (первый проход потеряет запрос; если ключ стоит после вложенного объекта, задайте count.regexp), строки: ${numbers(missed)}`,
    );
  }
  if (differ.length > 0) out.push(`  подсчёт находит другой ключ, чем разбор (например, обрезанный классом [0-9a-z._:-]), строки: ${numbers(differ)}`);
  if (extra.length > 0) {
    out.push(`  подсчёт находит ключ там, где разбор его не нашёл (лишний запрос занимает место в пакете; если пакет обрежет предел строк, запрос останется пустым), строки: ${numbers(extra)}`);
  }

  const declared = declaredFields(profile);
  const empty: string[] = [];
  for (const [v, fields] of declared) {
    if (!byVariant.has(v)) continue;
    const hit = found.get(v) ?? new Set<FieldName>();
    const none = [...fields].filter((f) => !hit.has(f));
    if (none.length > 0) empty.push(`  ${v}: ${none.join(', ')}`);
  }
  if (empty.length > 0) out.push('Поля, путь которых не дал значения ни на одной строке варианта:', ...empty);
  return out;
}

/** Строки образца: одна строка файла — одна строка хранилища; пустые строки пропускаются. */
export function sampleLines(text: string, labels: Record<string, string>): LogLine[] {
  return text
    .split(/\r?\n/)
    .filter((s) => s.trim() !== '')
    .map((line, i) => ({ tsNs: String(i + 1), line, labels }));
}
