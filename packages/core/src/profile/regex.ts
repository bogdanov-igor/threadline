// Регулярные выражения профиля: один диалект — подмножество RE2, которое JS выполняет так же.
// Группы `(?P<имя>…)` или `(?<имя>…)`, флаги — только ведущей группой `(?i)`, `(?s)`, `(?is)`.
// Без просмотра вперёд и назад и без обратных ссылок: их не выполнит ни RE2 хранилища, ни линейный движок V8.
// Экранирование — только то, что JS без флага u и RE2 читают одинаково.

export interface Re2Info {
  /** Флаги ведущей группы: подмножество «is». */
  flags: string;
  /** Тело без ведущей группы флагов. */
  body: string;
  /** Имена именованных групп по порядку. */
  groups: string[];
}

export type Re2Check = { ok: true; info: Re2Info; js: RegExp } | { ok: false; reason: string };

const LEADING_FLAGS = /^\(\?([is]+)\)/;
/** Знаки препинания ASCII: после \ — сам знак и в JS, и в RE2. */
const PUNCT = /^[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]$/;
/** Предел счётчика повтора в RE2. */
const RE2_MAX_REPEAT = 1000;
/** Больше копий повтора линейный движок V8 не строит. */
const LINEAR_MAX_REPEAT = 16;
/** Флаг линейного движка V8; без --enable-experimental-regexp-engine его нет. */
const LINEAR_FLAG = 'l';

/** Длина допустимого экранирования с \ в позиции i; 0 — запрещено. */
function escapeLength(s: string, i: number, inClass: boolean): number {
  const n = s[i + 1] ?? '';
  if (/^[dDsSwWfnrtv]$/.test(n) || (!inClass && (n === 'b' || n === 'B'))) return 2;
  if (n === 'x' && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 2, i + 4))) return 4;
  return PUNCT.test(n) ? 2 : 0;
}

function escapeReason(esc: string, inClass: boolean): string {
  if (inClass && /^\\[bB]$/.test(esc)) return `${esc} в классе JS читает как символ, а хранилище не принимает`;
  if (/^\\[pP]/.test(esc)) return `${esc}: классы Юникода JS без флага u читает как буквы; перечислите символы классом […]`;
  if (esc === '\\x') return '\\x{…}: JS понимает только \\xHH из двух цифр';
  return `экранирование ${esc} JS и хранилище читают по-разному; допустимы \\d \\w \\s \\b, \\n \\r \\t \\f \\v, \\xHH и знаки препинания`;
}

/** Разбор выражения: ведущие флаги, именованные группы, запрещённые конструкции. */
export function checkRe2(source: string): Re2Check {
  const lead = LEADING_FLAGS.exec(source);
  const flags = lead ? [...new Set(lead[1]!)].sort().join('') : '';
  const body = lead ? source.slice(lead[0].length) : source;
  const groups: string[] = [];
  let inClass = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\\') {
      const n = body[i + 1] ?? '';
      if (!inClass && (/[1-9]/.test(n) || n === 'k')) return { ok: false, reason: 'обратная ссылка: хранилище такое выражение не выполнит' };
      const len = escapeLength(body, i, inClass);
      if (len === 0) return { ok: false, reason: escapeReason(body.slice(i, i + 2), inClass) };
      i += len - 1;
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
      else if (c === '[' && /^\[:\^?[A-Za-z]+:\]/.test(body.slice(i))) return { ok: false, reason: 'класс POSIX [[:…:]] JS не понимает; перечислите символы классом' };
      continue;
    }
    if (c === '[') {
      inClass = true;
      if (body[i + 1] === '^') i++;
      // «[]…]» и «[^]…]» JS читает иначе, чем RE2: «[^]» в JS — любой символ.
      if (body[i + 1] === ']') return { ok: false, reason: 'класс начинается с «]»: JS и хранилище читают его по-разному; пишите \\]' };
      continue;
    }
    if (c === '{') {
      const m = /^\{(\d+)(?:,(\d*))?\}/.exec(body.slice(i, i + 24));
      if (m && Math.max(Number(m[1]), Number(m[2] || 0)) > RE2_MAX_REPEAT) {
        return { ok: false, reason: `повтор ${m[0]} больше ${RE2_MAX_REPEAT}: хранилище такое выражение не выполнит` };
      }
      continue;
    }
    if (c !== '(' || body[i + 1] !== '?') continue;
    const rest = body.slice(i + 2);
    if (/^(?:=|!|<=|<!)/.test(rest)) return { ok: false, reason: 'просмотр вперёд или назад: хранилище такое выражение не выполнит' };
    const named = /^P?<([A-Za-z_][A-Za-z0-9_]*)>/.exec(rest);
    if (named) {
      groups.push(named[1]!);
      continue;
    }
    if (rest.startsWith(':')) continue;
    return { ok: false, reason: 'флаги допускаются только в начале выражения: (?i), (?s) или (?is)' };
  }
  if (new Set(groups).size !== groups.length) return { ok: false, reason: 'имена групп повторяются' };
  let js: RegExp;
  try {
    // Флага i у JS-выражения нет: (?i) раскрыт в классы, иначе линейный движок V8 выражение не возьмёт.
    const jsBody = toJsBody(body);
    js = new RegExp(flags.includes('i') ? foldCase(jsBody) : jsBody, flags.replace('i', ''));
  } catch (e) {
    return { ok: false, reason: `выражение не компилируется: ${e instanceof Error ? e.message.replace(/^Invalid regular expression: /, '') : String(e)}` };
  }
  return { ok: true, info: { flags, body, groups }, js };
}

/** `(?P<имя>` → `(?<имя>`: в JS группа пишется без P. */
function toJsBody(body: string): string {
  return renameGroups(body, (name) => `(?<${name}>`);
}

/** Символ и его другой регистр (один символ UTF-16). */
function caseVariants(ch: string): string[] {
  const out = new Set([ch]);
  for (const v of [ch.toLowerCase(), ch.toUpperCase()]) if (v.length === 1) out.add(v);
  return [...out];
}

const classChar = (code: number) => (/[A-Za-z0-9]/.test(String.fromCharCode(code)) ? String.fromCharCode(code) : `\\u${code.toString(16).padStart(4, '0')}`);

/** Индекс «]», которая закрывает класс с «[» в позиции at. Тело проверено: класс не начинается с «]». */
function classEnd(s: string, at: number): number {
  let i = at + 1;
  if (s[i] === '^') i++;
  for (; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === ']') return i;
  }
  return s.length;
}

/** Класс с обоими регистрами букв. Символы — \uXXXX: добавленные диапазоны не склеиваются с «-» исходного класса. */
function foldClass(content: string): string {
  const neg = content.startsWith('^');
  const s = neg ? content.slice(1) : content;
  const items: string[] = [];
  const extra = new Set<number>();
  let i = 0;
  const atom = (): number | string => {
    if (s[i] !== '\\') return s.charCodeAt(i++);
    const n = s[i + 1]!;
    if (n === 'x') {
      i += 4;
      return parseInt(s.slice(i - 2, i), 16);
    }
    i += 2;
    const ctrl: Record<string, number> = { f: 12, n: 10, r: 13, t: 9, v: 11 };
    if (n in ctrl) return ctrl[n]!;
    return /[dDsSwW]/.test(n) ? `\\${n}` : n.charCodeAt(0);
  };
  const range = (lo: number, hi: number) => {
    items.push(lo === hi ? classChar(lo) : `${classChar(lo)}-${classChar(hi)}`);
    for (let c = lo; c <= hi; c++) {
      const ch = String.fromCharCode(c);
      for (const v of caseVariants(ch)) if (v !== ch) extra.add(v.charCodeAt(0));
    }
  };
  while (i < s.length) {
    const a = atom();
    if (typeof a === 'string') {
      items.push(a);
      continue;
    }
    if (s[i] === '-' && i + 1 < s.length) {
      i++;
      const b = atom();
      if (typeof b === 'number') range(a, b);
      else items.push(classChar(a), classChar(45), b); // [a-\d] в JS: a, «-» и \d
      continue;
    }
    range(a, a);
  }
  const codes = [...extra].sort((x, y) => x - y);
  for (let k = 0; k < codes.length; ) {
    let j = k;
    while (j + 1 < codes.length && codes[j + 1] === codes[j]! + 1) j++;
    items.push(j === k ? classChar(codes[k]!) : `${classChar(codes[k]!)}-${classChar(codes[j]!)}`);
    k = j + 1;
  }
  return `[${neg ? '^' : ''}${items.join('')}]`;
}

/** (?i) без флага i: буквы вне классов → [aA], в классах добавлен другой регистр. Тело проверено checkRe2. */
function foldCase(body: string): string {
  let out = '';
  const literal = (ch: string, text: string) => {
    const v = caseVariants(ch);
    return v.length === 1 ? text : `[${v.join('')}]`;
  };
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c === '\\') {
      if (body[i + 1] === 'x') {
        out += literal(String.fromCharCode(parseInt(body.slice(i + 2, i + 4), 16)), body.slice(i, i + 4));
        i += 3;
      } else {
        out += body.slice(i, i + 2);
        i++;
      }
      continue;
    }
    if (c === '[') {
      const end = classEnd(body, i);
      out += foldClass(body.slice(i + 1, end));
      i = end;
      continue;
    }
    const group = c === '(' ? /^\(\?(?:<[A-Za-z_][A-Za-z0-9_]*>|:)/.exec(body.slice(i, i + 40)) : null;
    if (group) {
      out += group[0];
      i += group[0].length - 1;
      continue;
    }
    out += literal(c, c);
  }
  return out;
}

/**
 * Выражение, которое линейный движок V8 не выполнит: от перебора на сервере его ничто не защитит.
 * null — выполнит, выражение не проходит checkRe2 или движок не включён (флаг --enable-experimental-regexp-engine).
 */
export function linearIssue(source: string): string | null {
  const c = checkRe2(source);
  if (!c.ok) return null;
  try {
    new RegExp('', LINEAR_FLAG);
  } catch {
    return null;
  }
  try {
    new RegExp(c.js.source, c.js.flags + LINEAR_FLAG);
    return null;
  } catch {
    // ниже — понятная причина
  }
  let inClass = false;
  const body = c.info.body;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\\') i++;
    else if (inClass) inClass = body[i] !== ']';
    else if (body[i] === '[') inClass = true;
    else if (body[i] === '{') {
      const m = /^\{(\d+)(?:,(\d*))?\}/.exec(body.slice(i, i + 24));
      if (m && Math.max(Number(m[1]), Number(m[2] || 0)) > LINEAR_MAX_REPEAT) {
        return `не выполняется линейным движком (повтор больше ${LINEAR_MAX_REPEAT} — замените ${m[0]} на +)`;
      }
    }
  }
  return `не выполняется линейным движком (вложенные повторы дают больше ${LINEAR_MAX_REPEAT} копий — замените счётчики на + или *)`;
}

/**
 * Переписывает открытия именованных групп вне классов и экранирования. to(имя) — новое открытие группы:
 * `(?P<имя>`, `(?<имя>` или `(?:`.
 */
export function renameGroups(source: string, to: (name: string) => string): string {
  let out = '';
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (c === '\\') {
      out += c + (source[i + 1] ?? '');
      i++;
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
      out += c;
      continue;
    }
    if (c === '[') inClass = true;
    if (c === '(' && source[i + 1] === '?') {
      const m = /^P?<([A-Za-z_][A-Za-z0-9_]*)>/.exec(source.slice(i + 2));
      if (m) {
        out += to(m[1]!);
        i += 1 + m[0].length;
        continue;
      }
    }
    out += c;
  }
  return out;
}

/** Выражение профиля в JS. Выражение уже проверено checkRe2; иначе исключение. */
export function re2ToJs(source: string): RegExp {
  const c = checkRe2(source);
  if (!c.ok) throw new Error(c.reason);
  return c.js;
}

/** Для хранилища: все именованные группы в форме `(?P<имя>`, которую понимает любой RE2. */
export function re2Canonical(source: string): string {
  return renameGroups(source, (name) => `(?P<${name}>`);
}

/** Литерал для RE2 и JS: экранирует метасимволы, как regexp.QuoteMeta в Go. */
export function quoteMeta(s: string): string {
  return s.replace(/[\\.+*?()|[\]{}^$]/g, '\\$&');
}
