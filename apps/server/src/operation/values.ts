// Значения id операции: проверка, привязка коротких значений к полям справочника, одно выражение поиска.

import { parseTemplate, typeKeyOf, type Resolver } from '@threadline/core/catalog';
import { detectTerm, maskText } from '@threadline/core/search';
import { escapeRegex } from '../backends/logql.ts';

export const OP_VALUE = /^[A-Za-z0-9._:-]{6,128}$/;
export const OP_TYPE = /^[a-z][a-z0-9_]{0,31}$/;
export const MAX_OP_VALUES = 3;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
/** Номер карты, длинное число, маска номера и телефон не бывают id операции. */
const FORBIDDEN = new Set(['pan', 'number', 'pan-mask', 'phone']);

export type ValueIssue = 'short' | 'format' | 'kind';

const NO_KEEP: ReadonlySet<string> = new Set();

/** Почему значение не годится в id операции; null — годится. */
export function valueIssue(v: string): ValueIssue | null {
  if (v.length < 6) return 'short';
  if (!OP_VALUE.test(v)) return 'format';
  // Номер или секрет внутри значения: card:<номер>. Иначе он целиком лёг бы в короткую ссылку и в её открытый ответ.
  if (maskText(v, NO_KEEP) !== v) return 'kind';
  const t = detectTerm(v);
  // Местный номер — форма, а не смысл: у id вида 12-345-67-89 только разделители как у телефона.
  if ('kind' in t && FORBIDDEN.has(t.kind) && !t.local) return 'kind';
  return null;
}

export const VALUE_ISSUE_TEXT: Record<ValueIssue, string> = {
  short: 'id операции короче 6 символов',
  format: 'id операции: от 6 до 128 символов A–Z, a–z, 0–9, «.», «_», «:», «-»',
  kind: 'значение не может быть id операции: это номер карты, длинное число, маска номера или телефон',
};

/** Короткое значение: не UUID и только из цифр или короче 16 символов. Голым оно не ищется. */
export const isShort = (v: string): boolean => !UUID.test(v) && (/^\d+$/.test(v) || v.length < 16);

/** Где справочник ждёт id типа: последние имена полей тела, имена параметров строки запроса, подстановка пути. */
export interface Places {
  fields: string[];
  query: string[];
  path: boolean;
}

export function placesOf(resolver: Resolver | null, type: string): Places {
  const fields = new Set<string>();
  const query = new Set<string>();
  let path = false;
  if (!resolver) return { fields: [], query: [], path };
  for (const m of resolver.methods.values()) {
    for (const f of m.fields) {
      if (f.type !== type) continue;
      const last = f.path.split('.').pop()?.replace(/\[.*$/, '') ?? '';
      if (!FIELD_NAME.test(last)) continue;
      (f.in === 'query' ? query : fields).add(last);
    }
    if (!path && parseTemplate(m.path).some((s) => s.param !== null && typeKeyOf(s.param) === type)) path = true;
  }
  return { fields: [...fields].sort(), query: [...query].sort(), path };
}

export const hasPlaces = (p: Places): boolean => p.fields.length > 0 || p.query.length > 0 || p.path;

/**
 * Выражение RE2 для одного значения. Длинное значение и UUID — литералом. Короткое — только с привязкой:
 * поле JSON с любым уровнем экранирования, поле XML, параметр строки запроса, сегмент пути. Без мест — null:
 * значение не становится ключом поиска и только склеивает уже найденные потоки.
 */
export function valuePattern(value: string, places: Places): string | null {
  const v = escapeRegex(value);
  if (!isShort(value)) return v;
  const end = '(?:[^0-9A-Za-z]|$)';
  const parts: string[] = [];
  for (const name of places.fields) {
    const n = escapeRegex(name);
    parts.push(`"${n}\\\\*"\\s*:\\s*\\\\*"?${v}${end}`);
    parts.push(`<(?:\\w+:)?${n}>${v}<`);
  }
  for (const name of places.query) parts.push(`[?&]${escapeRegex(name)}=${v}${end}`);
  if (places.path) parts.push(`/${v}(?:[/?#"\\\\]|$)`);
  return parts.length > 0 ? parts.join('|') : null;
}

export interface SearchValue {
  type: string;
  value: string;
}

/** Одно выражение на все значения: `a|b|c`. Значения без мест пропускаются; нет ни одного — null. */
export function operationPattern(values: readonly SearchValue[], resolver: Resolver | null): { pattern: string | null; searchable: SearchValue[] } {
  const parts: string[] = [];
  const searchable: SearchValue[] = [];
  for (const sv of values) {
    const p = valuePattern(sv.value, placesOf(resolver, sv.type));
    if (p === null) continue;
    parts.push(p);
    searchable.push(sv);
  }
  return { pattern: parts.length > 0 ? parts.join('|') : null, searchable };
}

/** Можно ли искать значение типа: длинное — всегда, короткое — только с местом в справочнике. */
export function canSearch(resolver: Resolver | null, type: string, value: string): boolean {
  return !isShort(value) || hasPlaces(placesOf(resolver, type));
}
