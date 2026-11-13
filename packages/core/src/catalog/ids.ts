// Id шага с типами и статус операции.
// Статус не входит ни в isError, ни в статус запроса.

import { readField, readQuery, scalarText, type ParsedBody } from './body.ts';
import { templateValues, type TemplateSegment } from './path.ts';
import { maskField } from './secure.ts';
import type { CatalogId, CatalogStatus } from '../search/api.ts';
import { BUILTIN_MASKING, formatKind, placeholderKind, type MaskPolicy } from '../search/mask-pass.ts';
import type { IdField, IdTypeData, StatusAt } from './schema.ts';

export type { CatalogId, CatalogStatus };

/** Имя подстановки → ключ типа: camelCase → snake_case (MerchantPayment → merchant_payment), «-» → «_», без «_id» и цифр в конце в любом порядке (cardId2, card2Id → card). */
export function typeKeyOf(name: string): string {
  return name
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toLowerCase()
    .replace(/[\d_]+$/, '')
    .replace(/_id$/, '')
    .replace(/[\d_]+$/, '');
}

const MAX_ID = 128;

function idValue(v: string | null): string | null {
  if (v === null) return null;
  const s = v.trim();
  return s.length >= 1 && s.length <= MAX_ID ? s : null;
}

export interface StepBodies {
  query: string | null;
  request: ParsedBody;
  response: ParsedBody;
}

/** Id шага: подстановки пути с найденным типом и поля метода. Повторы type + value схлопываются. */
export function stepIds(
  tpl: readonly TemplateSegment[],
  segs: readonly string[],
  fields: readonly IdField[],
  bodies: StepBodies,
  idTypes: ReadonlyMap<string, Pick<IdTypeData, 'kind' | 'name'>>,
  strict: MaskPolicy = BUILTIN_MASKING.strict,
): CatalogId[] {
  const out: CatalogId[] = [];
  const seen = new Set<string>();
  const push = (type: string, value: string | null, at: CatalogId['at']) => {
    const t = idTypes.get(type);
    const v = idValue(value);
    if (!t || v === null) return;
    const k = `${type}\u0000${v}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ type, name: t.name, kind: t.kind, value: v, at });
  };
  // Подстановка — тоже имя: {phone} из пути уходит маской. {account} не поле: без него значение ушло бы в keep, и образец не скрыл бы счёт.
  for (const p of templateValues(tpl, segs)) {
    const kind = placeholderKind(p.name, strict);
    push(typeKeyOf(p.name), kind ? formatKind(kind, p.value) : maskField(p.name, p.value, strict), 'path');
  }
  for (const f of fields) {
    const v = f.in === 'query' ? readQuery(bodies.query, f.path) : readField(f.in === 'request' ? bodies.request : bodies.response, f.path);
    const text = scalarText(v);
    push(f.type, text === null ? null : maskField(f.path, text, strict), f.in);
  }
  return out;
}

/** Статус операции: поле статуса, перевод map без учёта регистра, словарь типа. null — поля нет. */
export function stepStatus(
  op: string,
  at: StatusAt,
  bodies: StepBodies,
  idTypes: ReadonlyMap<string, Pick<IdTypeData, 'statuses'>>,
  strict: MaskPolicy = BUILTIN_MASKING.strict,
): CatalogStatus | null {
  const text = scalarText(readField(at.in === 'request' ? bodies.request : bodies.response, at.path))?.trim() ?? '';
  if (text === '' || text.length > MAX_ID) return null;
  const raw = maskField(at.path, text, strict);
  let value = raw;
  if (at.map) {
    const lower = raw.toLowerCase();
    for (const [k, v] of Object.entries(at.map)) {
      if (k.toLowerCase() === lower) {
        value = v;
        break;
      }
    }
  }
  const statuses = idTypes.get(op)?.statuses ?? [];
  const lower = value.toLowerCase();
  const order = statuses.findIndex((s) => s.value.toLowerCase() === lower);
  if (order < 0) return { type: op, value: raw, raw, name: null, outcome: null, order: null };
  const s = statuses[order]!;
  return { type: op, value: s.value, raw, name: s.name, outcome: s.outcome, order: order + 1 };
}
