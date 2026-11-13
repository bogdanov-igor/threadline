// Правила итога ответа: условия по HTTP-статусу и полям тела, шаблон текста.
// Порядок уровней и приоритет — в resolve.ts (compileCatalog).

import { checkRe2 } from '../profile/regex.ts';
import type { CatalogOutcome, CatalogRuleLevel } from '../search/api.ts';
import { withoutHtml } from '../search/html-text.ts';
import { BUILTIN_MASKING, type MaskPolicy } from '../search/mask-pass.ts';
import { readField, scalarText, type FieldValue, type ParsedBody } from './body.ts';
import { clipMasked, maskField } from './secure.ts';
import { templatePlaceholders, type Conditions, type FieldCond, type HttpCond } from './schema.ts';

export interface OutcomeContext {
  http: number | null;
  response: ParsedBody;
  /** Тело отправки этого обмена. */
  request: ParsedBody;
}

export type RuleLevel = CatalogRuleLevel;
export type { CatalogOutcome };

const MAX_REGEX_INPUT = 1000;
const MAX_TEXT = 200;

export function httpMatches(cond: HttpCond, status: number | null): boolean {
  if (status === null) return false;
  const list = Array.isArray(cond) ? cond : [cond];
  return list.some((c) => (typeof c === 'number' ? c === status : status >= c.from && status <= c.to));
}

const regexCache = new Map<string, RegExp | null>();

function compiled(source: string): RegExp | null {
  let re = regexCache.get(source);
  if (re === undefined) {
    const c = checkRe2(source);
    re = c.ok ? c.js : null;
    if (regexCache.size > 1000) regexCache.clear();
    regexCache.set(source, re);
  }
  return re;
}

const norm = (v: string | number | boolean) => String(v).trim().toLowerCase();

export function fieldMatches(f: FieldCond, v: FieldValue): boolean {
  if (f.exists !== undefined) {
    const present = v.found && v.value !== null;
    return f.exists ? present : !present;
  }
  const text = scalarText(v);
  if (text === null) return false;
  if (f.equals !== undefined) return norm(text) === norm(f.equals);
  if (f.oneOf !== undefined) {
    const t = norm(text);
    return f.oneOf.some((x) => norm(x) === t);
  }
  if (f.regex !== undefined) {
    const re = compiled(f.regex);
    return re !== null && re.test(text.slice(0, MAX_REGEX_INPUT));
  }
  return false;
}

/** Выполнены ли все условия. Условий нет — не подходит: такое правило не сохраняется. */
export function conditionsMatch(when: Conditions, ctx: OutcomeContext): boolean {
  const fields = when.fields ?? [];
  if (when.http === undefined && fields.length === 0) return false;
  if (when.http !== undefined && !httpMatches(when.http, ctx.http)) return false;
  for (const f of fields) {
    const body = f.in === 'request' ? ctx.request : ctx.response;
    if (!fieldMatches(f, readField(body, f.path))) return false;
  }
  return true;
}

/**
 * Текст правила: {путь} — значение поля тела ответа; не строка, число или логическое — пустая строка. До 200 символов.
 * Поле-секрет даёт ***, номер карты — маску; весь текст маскируется до обрезки.
 */
export function renderTemplate(text: string, response: ParsedBody, strict: MaskPolicy = BUILTIN_MASKING.strict): string {
  const t = templatePlaceholders(text);
  if (!t.ok) return '';
  const out = text
    .replace(/\{([A-Za-z0-9_.:-]+)\}/g, (_m, p: string) => {
      const v = scalarText(readField(response, p));
      return v === null ? '' : maskField(p, withoutHtml(v), strict);
    })
    .replace(/\s+/g, ' ')
    .trim();
  const masked = clipMasked(out, MAX_TEXT + 1, strict);
  return masked.length > MAX_TEXT ? masked.slice(0, MAX_TEXT - 1) + '…' : masked;
}

/** Пути полей, которые читают условия и шаблон правила: для кэша значений. */
export function rulePaths(when: Conditions, text: string | null): { in: 'request' | 'response'; path: string }[] {
  const out = (when.fields ?? []).map((f) => ({ in: f.in ?? 'response', path: f.path }));
  if (text) {
    const t = templatePlaceholders(text);
    if (t.ok) for (const p of t.paths) out.push({ in: 'response', path: p });
  }
  return out;
}

