// Форматирование тел для показа.
import { looksLikeHttp, parseHttpMessage, type HttpMessage } from './http.ts';

export interface FormattedBody {
  text: string;
  lang: 'json' | 'xml' | 'text' | 'empty';
}

const INDENT = '  ';
/** Глубже — тело без отступов, как есть. */
const MAX_PRETTY_DEPTH = 100;

export function formatBody(body: string | null | undefined): FormattedBody {
  if (body === null || body === undefined) return { text: '', lang: 'empty' };
  const s = body.trim();
  // У GET бывает тело строкой из двух кавычек.
  if (s === '' || s === '""') return { text: '', lang: 'empty' };
  if (s[0] === '{' || s[0] === '[') {
    const json = prettyJson(s);
    return json === null ? { text: body, lang: 'text' } : { text: json, lang: 'json' };
  }
  if (s[0] === '<') {
    const xml = prettyXml(s);
    return xml === null ? { text: body, lang: 'text' } : { text: xml, lang: 'xml' };
  }
  return { text: body, lang: 'text' };
}

/** XML с отступами по тегам; неразбираемый — как есть. */
export function formatXml(xml: string): string {
  return prettyXml(xml.trim()) ?? xml;
}

const isWs = (c: string | undefined) => c === ' ' || c === '\n' || c === '\r' || c === '\t';

/**
 * Отступы в 2 пробела, как JSON.stringify(v, null, 2), но числа остаются как в исходном тексте:
 * JSON.parse теряет точность длинных чисел, а показывать нужно то, что записано в логе.
 */
function prettyJson(src: string): string | null {
  try {
    JSON.parse(src);
  } catch {
    return null;
  }
  const out: string[] = [];
  let depth = 0;
  const newline = () => out.push('\n', INDENT.repeat(depth));
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === '"') {
      let j = i + 1;
      while (src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
      // Перекодировка строки раскрывает \uXXXX и \/, остальное экранирование сохраняется.
      out.push(JSON.stringify(JSON.parse(src.slice(i, j + 1))));
      i = j + 1;
    } else if (c === '{' || c === '[') {
      let j = i + 1;
      while (isWs(src[j])) j++;
      if (src[j] === (c === '{' ? '}' : ']')) {
        out.push(c, src[j]!);
        i = j + 1;
      } else {
        // Глубже предела отступы растут квадратично: такое тело показывается как есть.
        if (++depth > MAX_PRETTY_DEPTH) return null;
        out.push(c);
        newline();
        i++;
      }
    } else if (c === '}' || c === ']') {
      depth--;
      newline();
      out.push(c);
      i++;
    } else if (c === ',') {
      out.push(',');
      newline();
      i++;
    } else if (c === ':') {
      out.push(': ');
      i++;
    } else if (isWs(c)) {
      i++;
    } else {
      let j = i;
      while (j < src.length && !isWs(src[j]) && !',:]}'.includes(src[j]!)) j++;
      out.push(src.slice(i, j));
      i = j;
    }
  }
  return out.join('');
}

interface XmlToken {
  type: 'open' | 'close' | 'self' | 'text' | 'other';
  text: string;
  name: string;
}

/** Разбор на теги и текст; CDATA — текст. null — незакрытый тег, комментарий или CDATA. */
function tokenizeXml(src: string): XmlToken[] | null {
  const tokens: XmlToken[] = [];
  const special: [string, string][] = [
    ['<!--', '-->'],
    ['<![CDATA[', ']]>'],
    ['<?', '?>'],
    ['<!', '>'],
  ];
  let i = 0;
  outer: while (i < src.length) {
    if (src[i] !== '<') {
      const next = src.indexOf('<', i);
      const end = next < 0 ? src.length : next;
      const text = src.slice(i, end).trim();
      if (text) tokens.push({ type: 'text', text, name: '' });
      i = end;
      continue;
    }
    for (const [open, close] of special) {
      if (!src.startsWith(open, i)) continue;
      const end = src.indexOf(close, i + open.length);
      if (end < 0) return null;
      const text = src.slice(i, end + close.length);
      tokens.push({ type: open === '<![CDATA[' ? 'text' : 'other', text, name: '' });
      i = end + close.length;
      continue outer;
    }
    // Тег: до «>» вне кавычек атрибутов.
    let j = i + 1;
    let quote = '';
    for (; j < src.length; j++) {
      const c = src[j];
      if (quote) {
        if (c === quote) quote = '';
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
      else if (c === '<') return null;
    }
    if (j >= src.length) return null;
    const text = src.slice(i, j + 1);
    const closing = text[1] === '/';
    const name = /^<\/?\s*([^\s/>]+)/.exec(text)?.[1];
    if (!name) return null;
    tokens.push({ type: closing ? 'close' : text.endsWith('/>') ? 'self' : 'open', text, name });
    i = j + 1;
  }
  return tokens;
}

/** Элемент только с текстом — одной строкой; с вложенными элементами — по строке на тег. */
function prettyXml(src: string): string | null {
  const tokens = tokenizeXml(src);
  if (!tokens || tokens.length === 0) return null;
  const lines: string[] = [];
  const stack: string[] = [];
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]!;
    const pad = INDENT.repeat(stack.length);
    if (t.type === 'open') {
      const a = tokens[k + 1];
      const b = tokens[k + 2];
      if (a?.type === 'close' && a.name === t.name) {
        lines.push(pad + t.text + a.text);
        k += 1;
      } else if (a?.type === 'text' && b?.type === 'close' && b.name === t.name) {
        lines.push(pad + t.text + a.text + b.text);
        k += 2;
      } else {
        if (stack.length >= MAX_PRETTY_DEPTH) return null;
        lines.push(pad + t.text);
        stack.push(t.name);
      }
    } else if (t.type === 'close') {
      if (stack.pop() !== t.name) return null;
      lines.push(INDENT.repeat(stack.length) + t.text);
    } else {
      lines.push(pad + t.text);
    }
  }
  return stack.length === 0 ? lines.join('\n') : null;
}

// Вложенные тела: строки внутри тела, которые сами JSON, XML, HTTP или form-urlencoded.

export type NestedLang = 'json' | 'xml' | 'http' | 'form';

export interface NestedBody {
  /** Путь от корня тела: «result.payload», «Envelope.Body.data», «request_data», «items[0]». */
  path: string;
  lang: NestedLang;
  /** Отформатированный текст: JSON и XML с отступами, HTTP с переводами строк, form — пара на строку. */
  text: string;
}

export interface NestedOptions {
  /** Сколько уровней раскрывать; строка уровнем глубже остаётся как есть. */
  maxDepth?: number;
  /** Строка длиннее (в байтах UTF-8) не разбирается. */
  maxBytes?: number;
}

export const NESTED_MAX_DEPTH = 6;
export const NESTED_MAX_BYTES = 2 * 1024 * 1024;
/** Больше блоков интерфейс не покажет: тело с тысячами вложенных строк не должно вешать страницу. */
export const NESTED_MAX_BLOCKS = 100;

type Detected =
  | { lang: 'json'; src: string; value: unknown }
  | { lang: 'xml'; src: string; tokens: XmlToken[] }
  | { lang: 'http'; src: string; msg: HttpMessage }
  | { lang: 'form'; src: string; pairs: [string, string][] };

// `*` и `~` кодировщики оставляют как есть; `*` к тому же стоит в масках сервера (`***`, `411111******7893`),
// которые попадают в значения раньше, чем браузер раскрывает тело.
const FORM = /^[A-Za-z0-9%+._~*-]+=[A-Za-z0-9%+._~*-]*(?:&[A-Za-z0-9%+._~*-]+=[A-Za-z0-9%+._~*-]*)+$/;

export interface NestedResult {
  blocks: NestedBody[];
  /** Вложенных тел больше NESTED_MAX_BLOCKS: показаны первые по порядку документа, остальные нет. */
  truncated: boolean;
}

/**
 * Раскрывает строки внутри тела рекурсивно, до maxDepth уровней. Само тело блоком не считается:
 * его показывает formatBody. Порядок — как в документе, родитель перед своими вложенными.
 */
export function extractNested(body: string, opts: NestedOptions = {}): NestedBody[] {
  return extractNestedResult(body, opts).blocks;
}

/** То же, что extractNested, и пометка, что вложенных тел больше NESTED_MAX_BLOCKS. */
export function extractNestedResult(body: string, opts: NestedOptions = {}): NestedResult {
  const maxDepth = opts.maxDepth ?? NESTED_MAX_DEPTH;
  const maxBytes = opts.maxBytes ?? NESTED_MAX_BYTES;
  const out: NestedBody[] = [];
  let truncated = false;
  const visit = (s: string, path: string, depth: number): boolean => {
    if (depth > maxDepth) return true;
    const d = detect(s, maxBytes);
    if (!d) return true;
    // Предел проверяется после распознавания: пометка только если есть ещё одно настоящее вложенное тело.
    if (out.length >= NESTED_MAX_BLOCKS) {
      truncated = true;
      return false;
    }
    out.push({ path, lang: d.lang, text: render(d) });
    return children(d, path, (cs, cp) => visit(cs, cp, depth + 1));
  };
  const root = detect(body, maxBytes);
  if (root) children(root, '', (s, p) => visit(s, p, 1));
  return { blocks: out, truncated };
}

function detect(s: string, maxBytes: number): Detected | null {
  if (s.length < 2 || tooBig(s, maxBytes)) return null;
  const src = s.trim();
  const c = src[0];
  if (c === '{' || c === '[') {
    let value: unknown;
    try {
      value = JSON.parse(src);
    } catch {
      return null;
    }
    const empty = typeof value !== 'object' || value === null || Object.keys(value).length === 0;
    return empty ? null : { lang: 'json', src, value };
  }
  if (c === '<') {
    const tokens = tokenizeXml(src);
    return tokens && xmlBalanced(tokens) ? { lang: 'xml', src, tokens } : null;
  }
  if (looksLikeHttp(src)) {
    const msg = parseHttpMessage(src);
    return msg ? { lang: 'http', src, msg } : null;
  }
  if (FORM.test(src)) {
    const pairs = src.split('&').map((p): [string, string] => {
      const i = p.indexOf('=');
      return [decodeForm(p.slice(0, i)), decodeForm(p.slice(i + 1))];
    });
    return { lang: 'form', src, pairs };
  }
  return null;
}

function render(d: Detected): string {
  switch (d.lang) {
    case 'json':
      return prettyJson(d.src) ?? d.src;
    case 'xml':
      return prettyXml(d.src) ?? d.src;
    case 'http':
      return d.src.replace(/\r\n/g, '\n');
    case 'form':
      return d.pairs.map(([k, v]) => `${k}=${v}`).join('\n');
  }
}

/** Обходит строки-кандидаты разобранного тела. visit возвращает false — обход прекращается. */
function children(d: Detected, base: string, visit: (s: string, path: string) => boolean): boolean {
  switch (d.lang) {
    case 'json':
      return jsonStrings(d.value, base, visit);
    case 'xml':
      return xmlTexts(d.tokens, base, visit);
    case 'http':
      return d.msg.body === '' ? true : visit(d.msg.body, join(base, 'body'));
    case 'form':
      for (const [k, v] of d.pairs) if (!visit(v, join(base, k))) return false;
      return true;
  }
}

const join = (base: string, key: string) => (base === '' ? key : `${base}.${key}`);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Строки JSON по порядку документа. Обход стеком: глубокий JSON не переполняет стек вызовов. */
function jsonStrings(value: unknown, base: string, visit: (s: string, path: string) => boolean): boolean {
  const stack: [unknown, string][] = [[value, base]];
  while (stack.length > 0) {
    const [v, p] = stack.pop()!;
    if (typeof v === 'string') {
      if (!visit(v, p)) return false;
    } else if (Array.isArray(v)) {
      for (let i = v.length - 1; i >= 0; i--) stack.push([v[i], `${p}[${i}]`]);
    } else if (isObject(v)) {
      const keys = Object.keys(v);
      for (let i = keys.length - 1; i >= 0; i--) stack.push([v[keys[i]!], join(p, keys[i]!)]);
    }
  }
  return true;
}

/** Текст и CDATA элементов XML; путь — имена тегов без префикса пространства имён. */
function xmlTexts(tokens: XmlToken[], base: string, visit: (s: string, path: string) => boolean): boolean {
  const stack: string[] = [];
  for (const t of tokens) {
    if (t.type === 'open') stack.push(localName(t.name));
    else if (t.type === 'close') stack.pop();
    else if (t.type === 'text' && stack.length > 0) {
      const text = t.text.startsWith('<![CDATA[') ? t.text.slice(9, -3) : decodeEntities(t.text);
      if (!visit(text, join(base, stack.join('.')))) return false;
    }
  }
  return true;
}

function xmlBalanced(tokens: XmlToken[]): boolean {
  const stack: string[] = [];
  let elements = 0;
  for (const t of tokens) {
    if (t.type === 'open') {
      stack.push(t.name);
      elements++;
    } else if (t.type === 'close') {
      if (stack.pop() !== t.name) return false;
    } else if (t.type === 'self') elements++;
  }
  return stack.length === 0 && elements > 0;
}

const localName = (name: string) => name.slice(name.indexOf(':') + 1);

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(?:#(\d{1,7})|#x([0-9a-fA-F]{1,6})|(lt|gt|amp|quot|apos));/g, (m, dec?: string, hex?: string, name?: string) => {
    if (name) return ENTITIES[name] ?? m;
    const code = dec ? Number(dec) : parseInt(hex ?? '', 16);
    return code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });
}

function decodeForm(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
}

/** Длина в байтах UTF-8 больше max. Считает только когда длина в символах не решает сама. */
function tooBig(s: string, max: number): boolean {
  if (s.length > max) return true;
  if (s.length * 3 <= max) return false;
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
    if (n > max) return true;
  }
  return false;
}
