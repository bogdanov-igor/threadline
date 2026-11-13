// Распознавание и проверка значений поиска.
import type { Filter } from '../backend/index.ts';
import { luhnValid } from '../luhn.ts';
import type { TermKind } from './api.ts';
import { maskPan, maskText } from './masking.ts';
import { BUILTIN_MASKING, maskKindsText, regionalMatch, type MaskPolicy } from './mask-pass.ts';
import { isNationalDigits, parsePhone, phonePattern, phoneTailPattern } from './phone.ts';
import { regional } from './regional.ts';

export { phonePattern } from './phone.ts';

export interface Term {
  kind: TermKind;
  /** Что ищется (телефон — цифры с кодом страны без плюса, PAN целиком — только на сервере). */
  value: string;
  /** Что показывать пользователю (PAN — маской, телефон — в общем виде). */
  display: string;
  /** Что уходит в хранилище. */
  filter: Filter;
  /** Полный номер (pan, number) для точной проверки на сервере. */
  pan?: string;
  /** Телефон без кода страны, в том числе с 8 впереди: такой вид не закрывает id операции. */
  local?: boolean;
}

export type TermError = 'too-short' | 'too-long' | 'forbidden-char';
export type TermsError = 'empty' | 'too-many' | 'need-long' | { index: number; error: TermError };
export type ExcludesError = 'too-many' | { index: number; error: TermError | 'conflict' };

export const MAX_TERMS = 5;
export const MIN_TERM_LENGTH = 2;
/** Длиннее сервер не примет: поле говорит об этом само, а не сообщением об отказе. */
export const MAX_TERM_LENGTH = 1000;
/** Хотя бы одно значение не короче этого, иначе поиск слишком дорог для Loki. */
export const MIN_LONG_TERM_LENGTH = 6;

const SEPARATED_DIGITS = /^\d+(?:[ -]\d+)*$/;
// Номер в другой записи: +4111111234557893, 4111.1112.3455.7893, двойной или неразрывный пробел. Только длина номера карты:
// 13–14 цифр с точками — это дата или версия, а не номер.
const CARD_LIKE = /^\+?\d+(?:[\s._/-]+\d+)*$/;
const NUMBER = /^\d{15,19}$/;
const PAN_MASK = /^\d{6}\*{1,9}\d{4}$/;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
// Телефон распознаёт phone.ts по плану номеров страны (regional.ts); без плана — только международная запись с «+».

export function detectTerm(raw: string): Term | { error: TermError } {
  let s = raw.trim();
  if (s.length < MIN_TERM_LENGTH) return { error: 'too-short' };
  if (s.length > MAX_TERM_LENGTH) return { error: 'too-long' };
  if (s.includes('"') || s.includes('\\')) return { error: 'forbidden-char' };

  if (SEPARATED_DIGITS.test(s)) {
    const digits = s.replace(/[ -]/g, '');
    // Двадцать цифр — номер счёта: вид остаётся text, отдельного вида значения не нужно.
    if ((digits.length >= 13 && digits.length <= 19) || digits.length === 20) s = digits;
  } else if (CARD_LIKE.test(s)) {
    const digits = s.replace(/\D/g, '');
    if (digits.length >= 15 && digits.length <= 19) s = digits;
  }

  if (NUMBER.test(s)) {
    const filter: Filter = { kind: 'regex', pattern: edgesPattern(s) };
    return luhnValid(s)
      ? { kind: 'pan', value: s, display: maskPan(s), filter, pan: s }
      : { kind: 'number', value: s, display: s, filter, pan: s };
  }
  if (PAN_MASK.test(s))
    return { kind: 'pan-mask', value: s, display: s, filter: { kind: 'regex', pattern: edgesPattern(s) } };
  if (UUID.test(s)) return { kind: 'uuid', value: s, display: s, filter: { kind: 'contains', value: s } };
  const phone = parsePhone(s);
  if (phone) {
    const value = phone.digits;
    return { kind: 'phone', value, display: value, filter: { kind: 'regex', pattern: phonePattern(value) }, ...(phone.local ? { local: true } : {}) };
  }
  return { kind: 'text', value: s, display: s, filter: { kind: 'contains', value: s } };
}

// ---------- Значение в ссылке на Grafana ----------

/** Что идёт в ссылку: wider — ссылка может найти больше, typed — значение попадёт в адрес как введено. */
export interface LinkFilter {
  filter: Filter;
  wider: boolean;
  typed: boolean;
}

const NO_KEEP: ReadonlySet<string> = new Set();
const IPV4 = /(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?(?![\d.])/g;
// Отдельная серия из 9–19 цифр с любыми разделителями, не примыкающая к букве или цифре.
const DIGIT_SERIES = /(?<![\p{L}\d][-.]?)(?<!\d)\d(?:[\s.()+-]{0,3}\d){8,18}(?![\p{L}\d])/u;
/** Длины серии цифр, которую ссылка передаёт только последними четырьмя: телефоны, личные номера, счета. 13 — id запросов. */
const TAIL_LENGTHS: ReadonlySet<number> = new Set([9, 10, 11, 12, 14, 20]);

const tail = (digits: string) => digits.slice(-4);
const tailOnly = (pattern: string): LinkFilter => ({ filter: { kind: 'regex', pattern }, wider: true, typed: false });
const digitsTail = (v: string) => tailOnly(`\\b\\d{${v.length - 4}}${tail(v)}\\b`);

/** Значение целиком совпало с образцом личного номера или паспорта из региональных правил: в адрес только края. */
function regionalTail(v: string): LinkFilter | null {
  const kind = regionalMatch(v, ['passport', 'national_id']);
  if (kind === 'passport') {
    const m = /^([A-Z]{0,2})[ -]?([A-Z0-9]+)$/.exec(v);
    if (m && m[2]!.length > 2) {
      const cls = /^\d+$/.test(m[2]!) ? '\\d' : '[A-Z0-9]';
      return tailOnly(`\\b${m[1]}${m[1] ? '[ -]?' : ''}${cls}{${m[2]!.length - 2}}${m[2]!.slice(-2)}\\b`);
    }
  }
  if (kind === 'national_id') {
    const plain = v.replace(/[^A-Za-z0-9]/g, '');
    if (plain.length > 4) return tailOnly(`\\b[A-Za-z0-9]{${plain.length - 4}}${plain.slice(-4)}\\b`);
  }
  return null;
}

/**
 * Что можно передать в адресе Grafana; null — значение закрывает ссылку. В адрес попадает только то, что показывает маска,
 * поэтому два значения с одной маской дают посимвольно один адрес. Строки таблицы проверяются сверху вниз.
 */
export function linkFilter(term: Term, strict: MaskPolicy = BUILTIN_MASKING.strict): LinkFilter | null {
  if (term.kind === 'pan' || term.kind === 'number') return { filter: term.filter, wider: true, typed: false };
  if (term.kind === 'pan-mask') return { filter: term.filter, wider: false, typed: false };
  if (term.kind === 'uuid') return { filter: term.filter, wider: false, typed: true };
  const v = term.value;
  if (term.kind === 'phone') return tailOnly(phoneTailPattern(v));
  if (/^\d+$/.test(v)) {
    // Национальный номер плана без кода страны — телефон по последним четырём цифрам.
    if (isNationalDigits(v)) return tailOnly(phoneTailPattern(regional().phone!.countryCode + v));
    if (TAIL_LENGTHS.has(v.length)) return digitsTail(v);
    if (v.length === 13) return { filter: { kind: 'contains', value: v }, wider: false, typed: true };
  }
  const own = regionalTail(v);
  if (own) return own;
  // Grafana подставит вместо них переменную.
  if (v.includes('$') || v.includes('[[')) return null;
  if (maskText(v, NO_KEEP) !== v || maskKindsText(v, strict, NO_KEEP) !== v) return null;
  if (DIGIT_SERIES.test(v.replace(IPV4, ' '))) return null;
  return { filter: { kind: 'contains', value: v }, wider: false, typed: true };
}

/** Шаблон краёв номера: первые 6, затем k цифр или k звёздочек, затем последние 4. */
export function edgesPattern(digitsOrMask: string): string {
  const m = /^(\d{6})(\d+|\*+)(\d{4})$/.exec(digitsOrMask);
  if (!m) throw new Error('edgesPattern: нужен номер или маска номера');
  const k = m[2]!.length;
  return `${m[1]}(?:\\d{${k}}|\\*{${k}})${m[3]}`;
}

/** Пустые после обрезки значения пропускаются; индекс ошибки — по исходному массиву. */
export function validateTerms(
  raws: string[],
): { ok: true; terms: Term[] } | { ok: false; error: TermsError } {
  const detected: Term[] = [];
  for (const [index, raw] of raws.entries()) {
    if (raw.trim() === '') continue;
    const t = detectTerm(raw);
    if ('error' in t) return { ok: false, error: { index, error: t.error } };
    detected.push(t);
  }
  if (detected.length === 0) return { ok: false, error: 'empty' };

  const seen = new Set<string>();
  const terms = detected.filter((t) => {
    if (seen.has(t.value)) return false;
    seen.add(t.value);
    return true;
  });
  if (terms.length > MAX_TERMS) return { ok: false, error: 'too-many' };
  if (!terms.some((t) => t.value.length >= MIN_LONG_TERM_LENGTH)) return { ok: false, error: 'need-long' };
  return { ok: true, terms };
}

/** Строка с искомым значением всегда содержит и исключённое: результат заведомо пуст. Сравнение по тому, что уходит в хранилище. */
function excludeConflict(term: Term, exclude: Term): boolean {
  const [a, b] = [term.filter, exclude.filter];
  if (a.kind === 'contains' && b.kind === 'contains') return a.value.includes(b.value);
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Исключённые значения: те же распознавание и запреты, что у значений поиска, но без правила о 6 символах.
 * Пустой список допустим. Индекс ошибки — по исходному массиву.
 */
export function validateExcludes(raws: string[], terms: readonly Term[]): { ok: true; excludes: Term[] } | { ok: false; error: ExcludesError } {
  const excludes: Term[] = [];
  for (const [index, raw] of raws.entries()) {
    if (raw.trim() === '') continue;
    const t = detectTerm(raw);
    if ('error' in t) return { ok: false, error: { index, error: t.error } };
    if (terms.some((term) => excludeConflict(term, t))) return { ok: false, error: { index, error: 'conflict' } };
    if (!excludes.some((x) => x.value === t.value)) excludes.push(t);
  }
  return excludes.length > MAX_TERMS ? { ok: false, error: 'too-many' } : { ok: true, excludes };
}
