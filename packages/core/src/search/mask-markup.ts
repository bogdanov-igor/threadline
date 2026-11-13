// Номер карты в записи, которую браузер соберёт обратно: цифры сущностями и \uXXXX, группы через невидимые символы и их сущности.
// Цифры с обычными пробелами и дефисами разбирает masking.ts, они здесь не меняются.
// Один проход по строке без выражений и без возвратов: время линейно на любом вводе. Теги между цифрами здесь не считаются: страницу перед показом проверяет браузер.
import { luhnValid } from '../luhn.ts';

/** Кроме цифры от 0 до 9 лексема бывает разрывом серии, пробелом вида masking.ts и пробелом, которого он не знает. */
const BREAK = -1;
const PLAIN_GAP = -2;
const GAP = -3;

/** Столько пробелов подряд ещё считается одним номером. */
const MAX_GAP = 64;
const MIN_CARD = 15;
const MAX_CARD = 19;
const WINDOW = 16;

// Неразрывные, узкие и нулевые пробелы, мягкий перенос: на экране номера их не видно.
const GAP_ENTITIES = ['nbsp', 'shy', 'ensp', 'emsp', 'numsp', 'puncsp', 'thinsp', 'hairsp', 'zwj', 'zwnj', 'lrm', 'rlm', 'ZeroWidthSpace', 'ThinSpace', 'NonBreakingSpace'];
const GAP_ENTITY: ReadonlySet<string> = new Set(GAP_ENTITIES);
const LONGEST_ENTITY = Math.max(...GAP_ENTITIES.map((e) => e.length));
// Сначала быстрый отбор: почти весь поток записей дальше не идёт. Каждая ветка начинается с одного символа и не повторяется, возвратов нет.
const MAYBE_SPECIAL = new RegExp(`[\\f\\v\\u00a0\\u00ad\\u1680\\u2000-\\u206f\\u3000\\ufeff]|\\\\u|&#|&(?:${GAP_ENTITIES.join('|')})`);

const isPlainGap = (c: number) => c === 32 || c === 9 || c === 10 || c === 13 || c === 43 || c === 45;
const isGap = (c: number) => c === 11 || c === 12 || c === 0xa0 || c === 0xad || c === 0x1680 || (c >= 0x2000 && c <= 0x206f) || c === 0x3000 || c === 0xfeff;

/** Символ, записанный сущностью или \uXXXX. Такой пробел masking.ts не разбирает, поэтому он всегда особый. */
function kindOfEncoded(c: number): number {
  if (c >= 48 && c <= 57) return c - 48;
  return isPlainGap(c) || isGap(c) ? GAP : BREAK;
}

function hexValue(c: number): number {
  if (c >= 48 && c <= 57) return c - 48;
  const lower = c | 32;
  return lower >= 97 && lower <= 102 ? lower - 87 : -1;
}

/** Конец только что прочитанной лексемы: без выделения памяти на каждый символ. */
let tokenEnd = 0;

/** &#57; &#x39; с точкой с запятой и без, &nbsp; и другие имена из списка. Значение читается до конца цифр: разбор идёт дальше с него. */
function readEntity(s: string, at: number): number {
  tokenEnd = at + 1;
  if (s.charCodeAt(at + 1) === 35) {
    const hex = (s.charCodeAt(at + 2) | 32) === 120;
    const from = at + (hex ? 3 : 2);
    let value = 0;
    let i = from;
    for (; i < s.length; i++) {
      const c = s.charCodeAt(i);
      const d = hex ? hexValue(c) : c >= 48 && c <= 57 ? c - 48 : -1;
      if (d < 0) break;
      value = Math.min(value * (hex ? 16 : 10) + d, 0x110000);
    }
    if (i === from) return BREAK;
    tokenEnd = s.charCodeAt(i) === 59 ? i + 1 : i;
    return kindOfEncoded(value);
  }
  // Браузер читает эти два имени и без точки с запятой.
  if (s.startsWith('nbsp', at + 1) || s.startsWith('shy', at + 1)) {
    const end = at + (s[at + 1] === 'n' ? 5 : 4);
    tokenEnd = s.charCodeAt(end) === 59 ? end + 1 : end;
    return GAP;
  }
  // Просмотр ограничен длиной самого длинного имени: серия «&» не читает строку заново с каждого.
  const name = s.slice(at + 1, at + 2 + LONGEST_ENTITY);
  const semi = name.indexOf(';');
  if (semi < 0 || !GAP_ENTITY.has(name.slice(0, semi))) return BREAK;
  tokenEnd = at + semi + 2;
  return GAP;
}

/** \uXXXX и \n \r \t с любым числом косых черт: JSON в строке JSON. Серия черт это одна лексема, разбор идёт дальше с её конца. */
function readEscape(s: string, at: number): number {
  let i = at + 1;
  while (s.charCodeAt(i) === 92) i++;
  tokenEnd = i;
  const c = s.charCodeAt(i);
  if (c === 110 || c === 114 || c === 116) {
    tokenEnd = i + 1;
    return PLAIN_GAP;
  }
  if (c !== 117) return BREAK;
  let value = 0;
  for (let k = 1; k <= 4; k++) {
    const d = hexValue(s.charCodeAt(i + k));
    if (d < 0) return BREAK;
    value = value * 16 + d;
  }
  tokenEnd = i + 5;
  return kindOfEncoded(value);
}

function readToken(s: string, at: number): number {
  const c = s.charCodeAt(at);
  if (c >= 48 && c <= 57) {
    tokenEnd = at + 1;
    return c - 48;
  }
  if (c === 38) return readEntity(s, at);
  if (c === 92) return readEscape(s, at);
  tokenEnd = at + 1;
  if (isPlainGap(c)) return PLAIN_GAP;
  return isGap(c) ? GAP : BREAK;
}

/** Цифра записанная сущностью или \uXXXX как обычная цифра: тогда образцы видов маски её узнают. */
export function plainDigits(s: string): string {
  if (!s.includes('&#') && !s.includes('\\')) return s;
  let out = '';
  let last = 0;
  for (let i = 0; i < s.length; ) {
    const c = s.charCodeAt(i);
    if (c !== 38 && c !== 92) {
      i++;
      continue;
    }
    const kind = readToken(s, i);
    const end = tokenEnd;
    if (kind >= 0) {
      out += `${s.slice(last, i)}${kind}`;
      last = end;
    }
    i = end;
  }
  return last === 0 ? s : out + s.slice(last);
}

/** Где в серии цифр номера: вся серия или окна по 16 цифр, если перед номером стоят другие цифры. */
export function cardsIn(digits: string, keep: ReadonlySet<string>): [number, number][] {
  const n = digits.length;
  if (n >= MIN_CARD && n <= MAX_CARD && !keep.has(digits) && luhnValid(digits)) return [[0, n]];
  const out: [number, number][] = [];
  for (let i = 0; i + WINDOW <= n; ) {
    const w = digits.slice(i, i + WINDOW);
    if (!keep.has(w) && luhnValid(w)) {
      out.push([i, i + WINDOW]);
      i += WINDOW;
    } else i++;
  }
  return out;
}

/** Первые 6 и последние 4 цифры на месте, остальные звёздочками. hide отмечает, что номер скрыт. Серия только из обычных цифр и пробелов остаётся masking.ts. */
export function maskSplitCards(s: string, keep: ReadonlySet<string>, hide: () => string): string {
  if (!MAYBE_SPECIAL.test(s)) return s;
  let out = '';
  let last = 0;
  let starts: number[] = [];
  let ends: number[] = [];
  let digits = '';
  let special = false;
  // Пробелы после последней цифры серии в неё не входят, пока не пришла следующая цифра.
  let gaps = 0;
  let specialGap = false;
  const flush = () => {
    if (special && starts.length >= MIN_CARD) {
      for (const [a, b] of cardsIn(digits, keep)) {
        for (let at = a + 6; at < b - 4; at++) {
          out += s.slice(last, starts[at]!) + hide();
          last = ends[at]!;
        }
      }
    }
    starts = [];
    ends = [];
    digits = '';
    special = false;
    gaps = 0;
    specialGap = false;
  };
  for (let i = 0; i < s.length; ) {
    const kind = readToken(s, i);
    const end = tokenEnd;
    if (kind >= 0) {
      if (gaps > MAX_GAP) flush();
      special ||= specialGap || end - i > 1;
      starts.push(i);
      ends.push(end);
      digits += kind;
      gaps = 0;
      specialGap = false;
    } else if (kind === BREAK) {
      if (starts.length > 0) flush();
    } else if (starts.length > 0) {
      gaps++;
      specialGap ||= kind === GAP;
    }
    i = end;
  }
  flush();
  return last === 0 ? s : out + s.slice(last);
}
