// Подсветка синтаксиса тел: JSON, XML, HTTP-сообщение, form. Свой разборщик без зависимостей:
// текст режется на токены, интерфейс рисует их span-ами с классами темы, без innerHTML.
// Разбор терпит битый ввод и линеен по длине: склейка токенов всегда даёт исходный текст.

export type HighlightLang = 'json' | 'xml' | 'http' | 'form' | 'text';
export type TokenKind = 'key' | 'string' | 'number' | 'literal' | 'punct' | 'tag' | 'attr' | 'meta';

export interface Token {
  /** null — обычный текст без цвета. */
  kind: TokenKind | null;
  text: string;
}

/** Больше — без подсветки: тысячи span-ов тормозят страницу. */
export const HIGHLIGHT_MAX_BYTES = 300 * 1024;

/** Цвета токенов в светлой и тёмной теме; контраст не ниже 4,5:1 на фоне блока кода. */
export const TOKEN_CLASS: Record<TokenKind, string> = {
  key: 'text-[var(--sx-key)]',
  string: 'text-[var(--sx-str)]',
  number: 'text-[var(--sx-num)]',
  literal: 'text-[var(--sx-num)]',
  punct: 'text-[var(--sx-p)]',
  tag: 'text-[var(--sx-tag)]',
  attr: 'text-[var(--sx-attr)]',
  meta: 'text-muted-foreground italic',
};

/** Сколько переноса выдерживает вкладка: столько стоит одна строка 64 КБ из слов, около трети секунды. Цена переноса растёт как квадрат длины строки: 256 КБ держат вкладку 6 секунд, десять строк по 60 КБ тоже. */
const WRAP_BUDGET = (64 * 1024) ** 2;
/** Строка длиннее не переносится, какие бы в ней ни были символы: там, где нет мест для переноса, бюджет не работает. 16 000 символов «<» держат вкладку 6 секунд, 64 000 почти минуту. */
const WRAP_MAX_LINE = 10_000;

/** Текст, который показывается без переноса: есть строка длиннее предела или сумма квадратов длин строк больше бюджета. */
export function tooLongToWrap(text: string, budget = WRAP_BUDGET): boolean {
  if (text.length <= WRAP_MAX_LINE && text.length ** 2 <= budget) return false;
  let sum = 0;
  for (let from = 0; ; ) {
    const at = text.indexOf('\n', from);
    const length = (at < 0 ? text.length : at) - from;
    if (length > WRAP_MAX_LINE) return true;
    sum += length * length;
    if (sum > budget) return true;
    if (at < 0) return false;
    from = at + 1;
  }
}

/** Длина в байтах UTF-8 больше предела подсветки. */
export function tooBigToHighlight(text: string): boolean {
  if (text.length > HIGHLIGHT_MAX_BYTES) return true;
  // Короче предела в символах может оказаться длиннее в байтах только при не-ASCII.
  if (text.length * 3 <= HIGHLIGHT_MAX_BYTES) return false;
  return new TextEncoder().encode(text).length > HIGHLIGHT_MAX_BYTES;
}

const REQUEST_LINE = /^([A-Z]{3,10}) (\S+) (HTTP\/\d(?:\.\d)?)$/;
const STATUS_LINE = /^(HTTP\/\d(?:\.\d)?) (\d{3})(.*)$/;
const HEADER_LINE = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+)(:)(.*)$/;
const FORM = /^[A-Za-z0-9%+._-]+=[A-Za-z0-9%+._-]*(?:[&\n][A-Za-z0-9%+._-]+=[A-Za-z0-9%+._-]*)+$/;

/** Вид текста по первому символу и форме. */
export function detectLang(text: string): HighlightLang {
  const s = text.trimStart();
  const c = s[0];
  // «[GIN] …» — текст, а не массив JSON.
  if (c === '{' || /^\[\s*[[{"\d\-tfn\]]/.test(s)) return 'json';
  if (c === '<') return 'xml';
  const first = /^[^\r\n]*/.exec(s)?.[0] ?? '';
  if (REQUEST_LINE.test(first) || STATUS_LINE.test(first)) return 'http';
  if (FORM.test(s.trimEnd())) return 'form';
  return 'text';
}

export class Out {
  readonly tokens: Token[] = [];
  push(kind: TokenKind | null, text: string) {
    if (text === '') return;
    const last = this.tokens.at(-1);
    // Пробелы без цвета приклеиваются к пунктуации и тексту: меньше span-ов, вид тот же.
    const blank = kind === null && /^\s+$/.test(text);
    if (last && (last.kind === kind || (blank && (last.kind === null || last.kind === 'punct')))) last.text += text;
    else this.tokens.push({ kind, text });
  }
}

export function highlight(text: string, lang: HighlightLang): Token[] {
  const out = new Out();
  if (lang === 'json') json(text, out);
  else if (lang === 'xml') xml(text, out);
  else if (lang === 'http') http(text, out);
  else if (lang === 'form') form(text, out);
  else out.push(null, text);
  return out.tokens;
}

const NUMBER = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const WORD = /[A-Za-z_][A-Za-z0-9_]*/y;
const JSON_PLAIN = /[^"{}[\],:\-0-9A-Za-z_]+/y;

function sticky(re: RegExp, s: string, i: number): string | null {
  re.lastIndex = i;
  return re.exec(s)?.[0] ?? null;
}

/** Конец строки JSON: за закрывающей кавычкой, на переводе строки или в конце текста. */
function stringEnd(s: string, i: number): number {
  let j = i + 1;
  while (j < s.length) {
    const ch = s[j];
    if (ch === '\\') j += 2;
    else if (ch === '"') return j + 1;
    else if (ch === '\n') return j;
    else j++;
  }
  return s.length;
}

function json(s: string, out: Out) {
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '"') {
      const j = stringEnd(s, i);
      let k = j;
      while (k < s.length && (s[k] === ' ' || s[k] === '\t' || s[k] === '\r' || s[k] === '\n')) k++;
      out.push(s[k] === ':' ? 'key' : 'string', s.slice(i, j));
      i = j;
    } else if ('{}[],:'.includes(c)) {
      out.push('punct', c);
      i++;
    } else if (c === '-' || (c >= '0' && c <= '9')) {
      const m = sticky(NUMBER, s, i);
      out.push(m ? 'number' : null, m ?? c);
      i += m ? m.length : 1;
    } else {
      const w = sticky(WORD, s, i);
      if (w) {
        out.push(w === 'true' || w === 'false' || w === 'null' ? 'literal' : null, w);
        i += w.length;
      } else {
        const p = sticky(JSON_PLAIN, s, i) ?? c;
        out.push(null, p);
        i += p.length;
      }
    }
  }
}

const XML_NAME = /[A-Za-z_][\w:.-]*/y;
const XML_ATTR = /[^\s=>/<"']+/y;
const XML_SPACE = /\s+/y;
const XML_TEXT = /[^<&]+/y;
const XML_ENTITY = /&(?:#\d+|#x[0-9a-fA-F]+|\w+);/y;

/** Кусок до закрывающей последовательности включительно или до конца текста. */
function until(s: string, i: number, close: string): number {
  const end = s.indexOf(close, i);
  return end < 0 ? s.length : end + close.length;
}

function xml(s: string, out: Out) {
  let i = 0;
  while (i < s.length) {
    if (s.startsWith('<!--', i)) {
      const j = until(s, i + 4, '-->');
      out.push('meta', s.slice(i, j));
      i = j;
    } else if (s.startsWith('<![CDATA[', i)) {
      const end = s.indexOf(']]>', i + 9);
      const stop = end < 0 ? s.length : end;
      out.push('meta', '<![CDATA[');
      out.push('string', s.slice(i + 9, stop));
      if (end >= 0) out.push('meta', ']]>');
      i = end < 0 ? s.length : end + 3;
    } else if (s.startsWith('<?', i) || s.startsWith('<!', i)) {
      const j = until(s, i + 2, '>');
      out.push('meta', s.slice(i, j));
      i = j;
    } else if (s[i] === '<' && sticky(XML_NAME, s, s[i + 1] === '/' ? i + 2 : i + 1)) {
      i = xmlTag(s, i, out);
    } else if (s[i] === '&') {
      const e = sticky(XML_ENTITY, s, i);
      out.push(e ? 'literal' : null, e ?? '&');
      i += e ? e.length : 1;
    } else if (s[i] === '<') {
      out.push(null, '<');
      i++;
    } else {
      const t = sticky(XML_TEXT, s, i)!;
      out.push(null, t);
      i += t.length;
    }
  }
}

function xmlTag(s: string, i: number, out: Out): number {
  const open = s[i + 1] === '/' ? '</' : '<';
  out.push('punct', open);
  i += open.length;
  const name = sticky(XML_NAME, s, i)!;
  out.push('tag', name);
  i += name.length;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '>') {
      out.push('punct', '>');
      return i + 1;
    }
    if (c === '/' && s[i + 1] === '>') {
      out.push('punct', '/>');
      return i + 2;
    }
    // Битый тег: новый «<» начинает следующий разбор.
    if (c === '<') return i;
    if (c === '"' || c === "'") {
      const j = until(s, i + 1, c);
      out.push('string', s.slice(i, j));
      i = j;
      continue;
    }
    if (c === '=') {
      out.push('punct', '=');
      i++;
      continue;
    }
    const sp = sticky(XML_SPACE, s, i);
    if (sp) {
      out.push(null, sp);
      i += sp.length;
      continue;
    }
    const a = sticky(XML_ATTR, s, i);
    if (a) {
      out.push('attr', a);
      i += a.length;
    } else {
      out.push(null, c);
      i++;
    }
  }
  return i;
}

/** Строки с переводами: последний элемент — хвост без перевода. */
function lines(s: string): string[] {
  return s.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function header(line: string, out: Out) {
  const body = line.replace(/\r?\n$/, '');
  const eol = line.slice(body.length);
  const m = HEADER_LINE.exec(body);
  if (m) {
    out.push('key', m[1]!);
    out.push('punct', m[2]!);
    out.push(null, m[3]!);
  } else out.push(null, body);
  out.push(null, eol);
}

/** HTTP-сообщение: стартовая строка, заголовки, пустая строка, тело с подсветкой по его виду. Без стартовой строки — только заголовки. */
function http(s: string, out: Out) {
  const all = lines(s);
  let k = 0;
  const first = all[0]?.replace(/\r?\n$/, '') ?? '';
  const req = REQUEST_LINE.exec(first);
  const status = req ? null : STATUS_LINE.exec(first);
  if (req || status) {
    if (req) {
      out.push('key', req[1]!);
      out.push(null, ' ');
      out.push('string', req[2]!);
      out.push(null, ' ');
      out.push('meta', req[3]!);
    } else if (status) {
      out.push('meta', status[1]!);
      out.push(null, ' ');
      out.push('number', status[2]!);
      out.push(null, status[3]!);
    }
    out.push(null, all[0]!.slice(first.length));
    k = 1;
  }
  for (; k < all.length; k++) {
    const line = all[k]!;
    if (/^\r?\n$/.test(line)) {
      out.push(null, line);
      const body = all.slice(k + 1).join('');
      const lang = detectLang(body);
      if (lang === 'json' || lang === 'xml' || lang === 'form') {
        const lead = /^\s*/.exec(body)![0];
        out.push(null, lead);
        for (const t of highlight(body.slice(lead.length), lang)) out.push(t.kind, t.text);
      } else out.push(null, body);
      return;
    }
    header(line, out);
  }
}

function form(s: string, out: Out) {
  for (const part of s.split(/([&\n])/)) {
    if (part === '&' || part === '\n') {
      out.push('punct', part);
      continue;
    }
    const eq = part.indexOf('=');
    if (eq < 0) {
      out.push(null, part);
      continue;
    }
    out.push('key', part.slice(0, eq));
    out.push('punct', '=');
    out.push('string', part.slice(eq + 1));
  }
}
