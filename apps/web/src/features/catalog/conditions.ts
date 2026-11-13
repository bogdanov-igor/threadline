// Модель редактора условий правила итога: поля формы ↔ условия API, проверки, короткий текст.
import type { Conditions, FieldCond, HttpCond, HttpRange, OutcomeKind, Scalar } from '@threadline/core/catalog';

export const MAX_FIELDS = 10;
export const MAX_ONE_OF = 50;
export const MAX_VALUE = 200;
export const MAX_TEMPLATE = 200;
export const MAX_PLACES = 5;

export type HttpMode = 'any' | 'equals' | 'oneOf' | 'range';
export type CheckKind = 'equals' | 'oneOf' | 'exists' | 'missing' | 'regex';

export interface HttpModel {
  mode: HttpMode;
  /** «равен»: одно число. */
  equals: string;
  /** «один из»: числа и диапазоны через запятую: «200, 202, 400-499». */
  oneOf: string;
  from: string;
  to: string;
}

export interface FieldModel {
  /** Ключ строки для React: строки переставляются и удаляются. */
  key: string;
  in: 'response' | 'request';
  path: string;
  check: CheckKind;
  /** Значение; у «одно из» — через запятую или с новой строки. */
  value: string;
  /** Исходное значение: число или логическое значение остаются собой, если текст не меняли. */
  original?: Scalar | Scalar[];
}

export interface ConditionsModel {
  http: HttpModel;
  fields: FieldModel[];
}

/** Ключи ошибок — строки catalog.validation.* в ru.json. */
export type CondError =
  | 'required'
  | 'httpRange'
  | 'httpOrder'
  | 'httpList'
  | 'tooLong'
  | 'tooManyValues'
  | 'tooManyFields'
  | 'regexInvalid'
  | 'noConditions'
  | 'masked'
  | 'pathTooLong'
  | 'sensitive';

let seq = 0;
export const newFieldKey = () => `f${++seq}`;

export const emptyHttp = (): HttpModel => ({ mode: 'any', equals: '', oneOf: '', from: '', to: '' });

export function emptyField(): FieldModel {
  return { key: newFieldKey(), in: 'response', path: '', check: 'equals', value: '' };
}

const rangeText = (r: HttpRange) => `${r.from}-${r.to}`;

export function httpToModel(h: HttpCond | undefined): HttpModel {
  const m = emptyHttp();
  if (h === undefined) return m;
  if (typeof h === 'number') return { ...m, mode: 'equals', equals: String(h) };
  if (!Array.isArray(h)) return { ...m, mode: 'range', from: String(h.from), to: String(h.to) };
  if (h.length === 1 && typeof h[0] === 'number') return { ...m, mode: 'equals', equals: String(h[0]) };
  if (h.length === 1 && h[0] && typeof h[0] === 'object') return { ...m, mode: 'range', from: String(h[0].from), to: String(h[0].to) };
  return { ...m, mode: 'oneOf', oneOf: h.map((x) => (typeof x === 'number' ? String(x) : rangeText(x))).join(', ') };
}

function fieldToModel(f: FieldCond): FieldModel {
  const base = { key: newFieldKey(), in: f.in ?? 'response', path: f.path } as const;
  if (f.exists !== undefined) return { ...base, check: f.exists ? 'exists' : 'missing', value: '' };
  if (f.regex !== undefined) return { ...base, check: 'regex', value: f.regex };
  if (f.oneOf !== undefined) return { ...base, check: 'oneOf', value: f.oneOf.map(String).join(', '), original: f.oneOf };
  return { ...base, check: 'equals', value: f.equals === undefined ? '' : String(f.equals), ...(f.equals !== undefined ? { original: f.equals } : {}) };
}

export function conditionsToModel(c: Conditions | undefined): ConditionsModel {
  return { http: httpToModel(c?.http), fields: (c?.fields ?? []).map(fieldToModel) };
}

/** Значения «одно из»: через запятую или с новой строки, пустые отброшены. */
export function splitValues(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Текст поля — в значение: число и логическое значение исходного правила остаются собой, если текст тот же. */
function scalarOf(text: string, original: Scalar | undefined): Scalar {
  const t = text.trim();
  return original !== undefined && typeof original !== 'string' && String(original) === t ? original : t;
}

const HTTP_NUMBER = /^\d{3}$/;
const inHttpRange = (n: number) => n >= 100 && n <= 599;

function parseHttpNumber(s: string): number | null {
  const t = s.trim();
  if (!HTTP_NUMBER.test(t)) return null;
  const n = Number(t);
  return inHttpRange(n) ? n : null;
}

function parseHttpItem(s: string): number | HttpRange | null {
  const m = /^(\d{3})\s*[-–…]\s*(\d{3})$/.exec(s.trim());
  if (!m) return parseHttpNumber(s);
  const from = parseHttpNumber(m[1]!);
  const to = parseHttpNumber(m[2]!);
  return from !== null && to !== null && from <= to ? { from, to } : null;
}

export interface ModelResult {
  conditions: Conditions;
  /** Ошибки по полям формы: «http.equals», «fields.0.path», «fields.0.value», «conditions». */
  errors: Record<string, CondError>;
}

/** Строки формы — в условия API с проверками на клиенте. masked — «маскирование что-то скрыло бы». */
export function modelToConditions(m: ConditionsModel, masked: (s: string) => boolean = () => false, sensitive: (path: string) => boolean = () => false): ModelResult {
  const errors: Record<string, CondError> = {};
  const out: Conditions = {};
  const h = m.http;
  if (h.mode === 'equals') {
    const n = parseHttpNumber(h.equals);
    if (n === null) errors['http.equals'] = h.equals.trim() ? 'httpRange' : 'required';
    else out.http = n;
  } else if (h.mode === 'range') {
    const from = parseHttpNumber(h.from);
    const to = parseHttpNumber(h.to);
    if (from === null) errors['http.from'] = h.from.trim() ? 'httpRange' : 'required';
    if (to === null) errors['http.to'] = h.to.trim() ? 'httpRange' : 'required';
    if (from !== null && to !== null) {
      if (from > to) errors['http.to'] = 'httpOrder';
      else out.http = { from, to };
    }
  } else if (h.mode === 'oneOf') {
    const items = splitValues(h.oneOf);
    const parsed = items.map(parseHttpItem);
    if (items.length === 0) errors['http.oneOf'] = 'required';
    else if (parsed.some((x) => x === null)) errors['http.oneOf'] = 'httpList';
    else if (items.length > MAX_ONE_OF) errors['http.oneOf'] = 'tooManyValues';
    else out.http = parsed as (number | HttpRange)[];
  }

  if (m.fields.length > MAX_FIELDS) errors.conditions = 'tooManyFields';
  const fields: FieldCond[] = [];
  m.fields.forEach((f, i) => {
    const at = `fields.${i}`;
    const path = f.path.trim();
    if (!path) errors[`${at}.path`] = 'required';
    else if (path.length > 128) errors[`${at}.path`] = 'pathTooLong';
    // «Есть» и «нет» значение не открывают, сравнение с образцом позволило бы его подобрать.
    else if (f.check !== 'exists' && f.check !== 'missing' && sensitive(path)) errors[`${at}.path`] = 'sensitive';
    const cond: FieldCond = { ...(f.in === 'request' ? { in: 'request' as const } : {}), path };
    if (f.check === 'exists' || f.check === 'missing') cond.exists = f.check === 'exists';
    else if (f.check === 'oneOf') {
      const values = splitValues(f.value);
      const originals = Array.isArray(f.original) ? f.original : [];
      if (values.length === 0) errors[`${at}.value`] = 'required';
      else if (values.length > MAX_ONE_OF) errors[`${at}.value`] = 'tooManyValues';
      else if (values.some((v) => v.length > MAX_VALUE)) errors[`${at}.value`] = 'tooLong';
      else if (values.some(masked)) errors[`${at}.value`] = 'masked';
      cond.oneOf = values.map((v) => scalarOf(v, originals.find((o) => String(o) === v)));
    } else {
      const value = f.value.trim();
      if (!value) errors[`${at}.value`] = 'required';
      else if (value.length > MAX_VALUE) errors[`${at}.value`] = 'tooLong';
      else if (masked(value)) errors[`${at}.value`] = 'masked';
      else if (f.check === 'regex' && !regexParses(value)) errors[`${at}.value`] = 'regexInvalid';
      if (f.check === 'regex') cond.regex = value;
      else cond.equals = scalarOf(value, Array.isArray(f.original) ? undefined : f.original);
    }
    fields.push(cond);
  });
  if (fields.length > 0) out.fields = fields;
  if (out.http === undefined && fields.length === 0 && Object.keys(errors).length === 0) errors.conditions = 'noConditions';
  return { conditions: out, errors };
}

/** Выражение разбирается движком браузера; долгий перебор проверяет сервер линейным движком. */
export function regexParses(source: string): boolean {
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
}

// ---------- Шаблон текста ----------

export type TemplateError = 'tooLong' | 'templateUnclosed' | 'templateTooMany' | 'templatePlace';

/** Шаблон текста: места {путь} (`[A-Za-z0-9_.:-]+`), не больше 5, незакрытая «{» — ошибка. */
export function checkTemplate(text: string): TemplateError | null {
  if (text.length > MAX_TEMPLATE) return 'tooLong';
  let places = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '}') return 'templateUnclosed';
    if (text[i] !== '{') continue;
    const end = text.indexOf('}', i);
    if (end < 0) return 'templateUnclosed';
    if (!/^[A-Za-z0-9_.:-]+$/.test(text.slice(i + 1, end))) return 'templatePlace';
    places++;
    i = end;
  }
  return places > MAX_PLACES ? 'templateTooMany' : null;
}

/** Места подстановки шаблона: «{message}», «{error.code}». */
export const templatePlaces = (text: string) => [...text.matchAll(/\{([A-Za-z0-9_.:-]+)\}/g)].map((m) => m[1]!);

// ---------- Короткий текст ----------

export interface SummaryWords {
  http: string;
  equals: string;
  oneOf: string;
  exists: string;
  missing: string;
  regex: string;
  request: string;
  outcome: Record<OutcomeKind, string>;
}

function httpText(h: HttpCond): string {
  const list = Array.isArray(h) ? h : [h];
  return list.map((x) => (typeof x === 'number' ? String(x) : `${x.from}–${x.to}`)).join(', ');
}

/** Условия коротким текстом: «HTTP 422 · status = OK → успех». */
export function conditionsSummary(c: Conditions, w: SummaryWords, outcome?: OutcomeKind): string {
  const parts: string[] = [];
  if (c.http !== undefined) parts.push(`${w.http} ${httpText(c.http)}`);
  for (const f of c.fields ?? []) {
    const path = f.in === 'request' ? `${w.request} ${f.path}` : f.path;
    if (f.exists !== undefined) parts.push(`${path} ${f.exists ? w.exists : w.missing}`);
    else if (f.regex !== undefined) parts.push(`${path} ${w.regex} ${f.regex}`);
    else if (f.oneOf !== undefined) parts.push(`${path} ${w.oneOf} ${f.oneOf.map(String).join(', ')}`);
    else parts.push(`${path} ${w.equals} ${String(f.equals)}`);
  }
  const head = parts.join(' · ');
  return outcome ? `${head} → ${w.outcome[outcome]}` : head;
}
