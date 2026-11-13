// Подсветка найденного значения: формы значений, поиск совпадений, наложение на токены, сводка по записям.
// Функции чистые: на входе только текст на экране и значения поиска из состояния. Сервер о подсветке не знает,
// поэтому она не может открыть ничего сверх того, что уже показано.

import { nationalOf, phonePattern, regional, regionalMatch, type SearchState, type TermKind } from '@threadline/core/search';
import type { Token, TokenKind } from './highlight.ts';

export type HitTerm = SearchState['terms'][number];
/** По выражению на значение. */
export type HitForms = readonly RegExp[];

export interface Hits {
  /** Всего участков: точное число, даже если отмечены не все. */
  count: number;
  /** Участки для отметки, не больше предела. */
  ranges: readonly (readonly [number, number])[];
}

export interface HitPiece {
  kind: TokenKind | null;
  text: string;
  hit: boolean;
}

/** Больше — без отметок: та же причина, что у предела подсветки синтаксиса. Счётчик остаётся точным. */
export const MAX_MARKS = 1000;

const R = String.raw;
const esc = (s: string) => s.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');

/** Шестнадцатеричные цифры в любом регистре. */
const anyCase = (hex: string) => hex.replace(/[a-f]/gi, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`);
// Просмотр обратных черт ограничен числом: без предела серия черт разбиралась бы за квадрат. 63 — шесть уровней вложения.
const BS = R`\\{1,63}`;
const unicodeEscape = (ch: string) => {
  let out = '';
  for (let i = 0; i < ch.length; i++) out += `${BS}u${anyCase(ch.charCodeAt(i).toString(16).padStart(4, '0'))}`;
  return out;
};
const percent = (ch: string) => [...new TextEncoder().encode(ch)].map((b) => `%${anyCase(b.toString(16).padStart(2, '0'))}`).join('');

const ENCODED: Readonly<Record<string, string>> = {
  '/': R`(?:\\{0,63}/|%2[fF])`,
  ' ': R`(?: |\+|%20)`,
  '@': `(?:@|%40|${BS}u0040)`,
  '=': `(?:=|%3[dD]|${BS}u003[dD])`,
  ':': '(?::|%3[aA])',
  '+': R`(?:\+|%2[bB])`,
  '&': `(?:&|&amp;|%26|${BS}u0026)`,
  '<': `(?:<|&lt;|%3[cC]|${BS}u003[cC])`,
  '>': `(?:>|&gt;|%3[eE]|${BS}u003[eE])`,
};

/** Значение как выражение: символ совпадает и со своей записью в экранировании. Кавычки и обратной черты в значениях нет. */
function tolerant(value: string): string {
  let out = '';
  for (const ch of value) {
    const encoded = ENCODED[ch];
    if (encoded) out += encoded;
    else if (ch.codePointAt(0)! > 0x7f) out += `(?:${ch}|${unicodeEscape(ch)}|${percent(ch)})`;
    else out += esc(ch);
  }
  return out;
}

/**
 * Маска телефона по последним четырём цифрам. Перед ней не звёздочка и не цифра, иначе совпал бы хвост маски номера карты.
 * Цифра разрешена только как конец %XX или \uXXXX: маскирование ставит маску и сразу после закодированной кавычки.
 */
function phoneMask(last4: string): string {
  const [a, b, c, d] = [...last4];
  return R`(?<!\*)(?<!(?<!%[0-9A-Fa-f]|\\u[0-9A-Fa-f]{3})\d)\+?(?:\*[ ()-]{0,2}){5,}${a}[ -]?${b}[ -]?${c}[ -]?${d}(?!\d)`;
}

/** Маска номера: первые 6, звёздочки той же длины, последние 4, в записи бывают группы через пробел или дефис. */
const cardMask = (mask: string) => [...mask].map(esc).join('[ -]{0,2}');

/** Открытый номер с теми же краями: при открытом показе подсветка стоит на нём, а не пропадает. */
const openCard = (mask: string) => `(?<!\\d)${[...mask].map((c) => (c === '*' ? R`\d` : esc(c))).join('[ -]{0,2}')}(?!\\d)`;

/** Маска счёта: всё, кроме последних четырёх цифр. По четырём цифрам другие маски не отличить, поэтому длина должна совпасть. */
const accountMask = (digits: string) => R`(?<![*\d])\*{${digits.length - 4}}${digits.slice(-4)}(?!\d)`;

/** Маска личного номера: всё, кроме последних четырёх знаков, звёздочками той же длины. */
const nationalIdMask = (plain: string) => R`(?<![*\w])\*{${plain.length - 4}}${esc(plain.slice(-4))}(?!\w)`;

/** Выражение значения: открытая форма и форма маски. Маска содержит только то, что показывает сама маска. */
function source({ display: v, kind }: { display: string; kind: TermKind }): string {
  if (kind === 'pan' || kind === 'pan-mask') return `${cardMask(v)}|${openCard(v)}`;
  if (kind === 'number') {
    if (v.includes('*')) return `${cardMask(v)}|${openCard(v)}`;
    const mask = `${v.slice(0, 6)}${'*'.repeat(Math.max(0, v.length - 10))}${v.slice(-4)}`;
    return `${[...v].map(esc).join('[ -]?')}|${cardMask(mask)}|${openCard(mask)}|${accountMask(v)}`;
  }
  if (kind === 'phone' && /^\d{8,15}$/.test(v)) {
    const plan = regional().phone;
    // Номер страны плана: перед национальным номером код страны, местный префикс или скобка. Другой номер — всеми цифрами.
    const prefix = nationalOf(v, plan) !== null ? `(?:(?:\\+|%2[bB])?${plan!.countryCode}[ ()-]{0,3}${plan!.trunkPrefix ? `|${plan!.trunkPrefix}[ ()-]{0,2}` : ''}|\\()?` : '(?:\\+|%2[bB])?';
    return `${prefix}${phonePattern(v, plan)}|${phoneMask(v.slice(-4))}`;
  }
  const open = tolerant(v);
  if (kind === 'text') {
    const plan = regional().phone;
    // Номер плана без кода страны и с местным префиксом: маска телефона по последним четырём цифрам.
    if (plan && (new RegExp(`^\\d{${plan.nationalDigits}}$`).test(v) || (plan.trunkPrefix && v.startsWith(plan.trunkPrefix) && new RegExp(`^\\d{${plan.trunkPrefix.length + plan.nationalDigits}}$`).test(v)))) {
      return `${open}|${phoneMask(v.slice(-4))}`;
    }
    // Серия цифр под маской личного номера или счёта: всё, кроме последних четырёх цифр.
    if (/^\d{9,20}$/.test(v)) return `${open}|${accountMask(v)}`;
    // Личный номер и паспорт по образцам раздела regional: на экране они маской.
    const own = regionalMatch(v, ['national_id', 'passport']);
    const plain = v.replace(/[^A-Za-z0-9]/g, '');
    if (own === 'national_id' && plain.length > 4) return `${open}|${nationalIdMask(plain)}`;
    const passport = own === 'passport' ? /^([A-Z]{0,2})[ -]?([A-Z0-9]{3,12})$/.exec(v) : null;
    if (passport) return R`${open}|${passport[1]}\*{${passport[2]!.length - 2}}${esc(passport[2]!.slice(-2))}(?![\w])`;
  }
  return open;
}

/** Формы значений. Значение, для которого выражение не строится, отбрасывается: остальные работают. */
export function compileForms(terms: readonly HitTerm[]): HitForms {
  const forms: RegExp[] = [];
  for (const t of terms) {
    try {
      forms.push(new RegExp(source(t), 'g'));
    } catch {
      // Предельно длинное значение: его нет в подсветке.
    }
  }
  return forms;
}

let cachedKey: string | null = null;
let cachedForms: HitForms = [];

/** Те же значения — те же формы: опрос раз в 500 мс приносит новый массив, а подсветка не пересчитывается. */
export function formsOf(terms: readonly HitTerm[]): HitForms {
  const key = JSON.stringify(terms.map((t) => [t.kind, t.display]));
  if (key !== cachedKey) {
    cachedKey = key;
    cachedForms = compileForms(terms);
  }
  return cachedForms;
}

/** Плоский список начал и концов совпадений одного выражения. */
function collect(text: string, re: RegExp): number[] {
  const out: number[] = [];
  re.lastIndex = 0;
  try {
    for (let m = re.exec(text); m; m = re.exec(text)) {
      if (m[0] === '') re.lastIndex++;
      else out.push(m.index, m.index + m[0].length);
    }
  } catch {
    // Вырожденная строка исчерпала стек выражения: найденное до этого остаётся.
  }
  re.lastIndex = 0;
  return out;
}

/** Слияние двух упорядоченных списков. Пересечения дают один участок, касание — два. */
function merge(a: readonly number[], b: readonly number[]): number[] {
  const out: number[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const fromA = j >= b.length || (i < a.length && a[i]! <= b[j]!);
    const start = fromA ? a[i]! : b[j]!;
    const end = fromA ? a[i + 1]! : b[j + 1]!;
    if (fromA) i += 2;
    else j += 2;
    const last = out.length - 1;
    if (last > 0 && start < out[last]!) out[last] = Math.max(out[last]!, end);
    else out.push(start, end);
  }
  return out;
}

/** Участки совпадений в тексте. Каждое значение ищется своим выражением, участки объединяются. */
export function findHits(text: string, forms: HitForms, cap: number = MAX_MARKS): Hits {
  let merged: number[] = [];
  for (const re of forms) merged = merge(merged, collect(text, re));
  const ranges: (readonly [number, number])[] = [];
  for (let i = 0; i < merged.length && ranges.length < cap; i += 2) ranges.push([merged[i]!, merged[i + 1]!]);
  return { count: merged.length / 2, ranges };
}

/** Есть ли совпадение: без подсчёта, на первом найденном выражении останавливается. */
export function hasHit(text: string, forms: HitForms): boolean {
  return forms.some((re) => {
    re.lastIndex = 0;
    try {
      return re.test(text);
    } catch {
      return false;
    } finally {
      re.lastIndex = 0;
    }
  });
}

/** Токены, разрезанные по границам участков: склейка кусков всегда равна исходному тексту. */
export function applyHits(tokens: readonly Token[], ranges: Hits['ranges']): HitPiece[] {
  const out: HitPiece[] = [];
  let pos = 0;
  let r = 0;
  for (const { kind, text } of tokens) {
    const end = pos + text.length;
    let at = pos;
    while (at < end) {
      while (r < ranges.length && ranges[r]![1] <= at) r++;
      const range = ranges[r];
      if (!range || range[0] >= end) {
        out.push({ kind, text: text.slice(at - pos), hit: false });
        at = end;
      } else if (range[0] > at) {
        out.push({ kind, text: text.slice(at - pos, range[0] - pos), hit: false });
        at = range[0];
      } else {
        const stop = Math.min(range[1], end);
        out.push({ kind, text: text.slice(at - pos, stop - pos), hit: true });
        at = stop;
      }
    }
    pos = end;
  }
  return out;
}

// ---------- Сводка над вкладками запроса ----------

export interface HitSource {
  id: string;
  raw: string;
  http: { uri: string | null } | null;
}

export interface HitTally {
  /** Записей с совпадением. */
  matched: number;
  /** Первая по порядку запись с совпадением. */
  first: string | null;
}

/** Порция подсчёта: совпадение ищется в сырой записи и адресе, этого достаточно, потому что сырая запись содержит всё. */
export function tallyHits(records: readonly HitSource[], forms: HitForms, start: number, end: number, tally: HitTally): HitTally {
  let { matched, first } = tally;
  for (let i = start; i < Math.min(end, records.length); i++) {
    const r = records[i]!;
    if (hasHit(r.raw, forms) || (r.http?.uri ? hasHit(r.http.uri, forms) : false)) {
      matched++;
      first ??= r.id;
    }
  }
  return { matched, first };
}
