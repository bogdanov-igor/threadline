// HTML в тексте ошибки: шлюз отвечает страницей, а приложение кладёт её в сообщение.
// Здесь только поиск в тексте. Показ страницы под защитой лежит в ленивом чанке интерфейса.
import { plainDigits } from './mask-markup.ts';

export interface HtmlFragment {
  start: number;
  end: number;
  /** <title> страницы, иначе её первый <h1>. */
  title: string | null;
}

export interface HtmlFind {
  /** Код первой страницы. */
  html: string;
  /** Текст вокруг неё в той же строке. */
  before: string;
  after: string;
  title: string | null;
  /** Сколько ещё других страниц в этом тексте: повтор той же страницы не считается. */
  more: number;
  /** Строка, где лежит страница, целиком: её берёт копирование. */
  source: string;
}

/** Страница больше этого не показывается: разбор и защита заняли бы заметное время, а код виден в «Форматировано». */
export const HTML_PAGE_LIMIT = 256 * 1024;

const DOCUMENT = /(?:<\?xml[^<>]*>\s*)?(?:<!doctype\s+html\b|<html[\s>])/gi;
const DOCUMENT_END = /<\/html\s*>/gi;
// Только то, чего в XML внутренних систем не бывает или что само по себе похоже на страницу. Строчные теги (<b>, <a>) страницу не делают.
// Заголовок XML перед началом входит в обрывок: в причине его не остаётся.
const BLOCK = /(?:<\?xml[^<>]*>\s*)?<(?:head|title|body|h[1-6]|center|div|table|p|pre|ul|ol|hr)(?:\s[^<>]*)?>/gi;
const CLOSING = /<\/[a-z][\w-]*\s*>/gi;
const ANY_TAG = /<\/?[a-z][^<>]*>/i;
const TITLE = [/<title[^<>]*>/i, /<\/title\s*>/gi] as const;
const H1 = [/<h1[^<>]*>/i, /<\/h1\s*>/gi] as const;
const MAX_TITLE = 120;
/** Столько текста заголовка читается: всё равно обрезается до MAX_TITLE. */
const MAX_TITLE_SOURCE = 4096;
const MAX_DEPTH = 8;
const ENTITIES: Record<string, string> = { amp: '&', quot: '"', '#39': "'", apos: "'", nbsp: ' ' };
// Для вида «Как страница» нужны теги страницы строчными буквами или doctype и нет заголовка XML: <Body> и <Title> бывают в XML внутренних систем. Причине это неважно: там теги просто убираются.
const PAGE_TAG = /<(?:html|head|body|title)[\s>]/;
const PAGE_DOCTYPE = /<!doctype\s+html\b/i;
const XML_PROLOG = /^\s*<\?xml/i;

/** С такой серии цифр страница в браузере не показывается, а текст из неё скрывается: это может быть номер карты или другие личные данные. */
export const PAGE_DIGIT_RUN = 9;
const DIGIT_CHAR = /\p{Nd}/u;
const LETTER_CHAR = /\p{L}/u;
const HIDDEN_RUN = '***';

const isDigitChar = (c: number) => (c < 128 ? c >= 48 && c <= 57 : DIGIT_CHAR.test(String.fromCodePoint(c)));
const isLetterChar = (c: number) => (c < 128 ? (c | 32) >= 97 && (c | 32) <= 122 : LETTER_CHAR.test(String.fromCodePoint(c)));
/** Широкие цифры становятся обычными, записанные сущностью или \\uXXXX тоже. */
const digitForm = (text: string) => plainDigits(text.normalize('NFKC'));

/** Серии от PAGE_DIGIT_RUN цифр за один проход: разрывает серию только буква, всё остальное между цифрами не считается. */
function digitRuns(text: string): [number, number][] {
  const out: [number, number][] = [];
  let first = 0;
  let end = 0;
  let count = 0;
  for (let i = 0; i < text.length; ) {
    const c = text.codePointAt(i)!;
    const size = c > 0xffff ? 2 : 1;
    if (isDigitChar(c)) {
      if (count === 0) first = i;
      count++;
      end = i + size;
    } else if (count > 0 && isLetterChar(c)) {
      if (count >= PAGE_DIGIT_RUN) out.push([first, end]);
      count = 0;
    }
    i += size;
  }
  if (count >= PAGE_DIGIT_RUN) out.push([first, end]);
  return out;
}

/** В тексте страницы есть длинная серия цифр: такую страницу браузер не показывает. */
export const holdsDigitRun = (text: string): boolean => digitRuns(digitForm(text)).length > 0;

/** Текст из страницы для показа вне рамки: длинная серия цифр заменена маской. Без такой серии та же строка. */
export function hideDigitRuns(text: string): string {
  const plain = digitForm(text);
  const runs = digitRuns(plain);
  if (runs.length === 0) return text;
  let out = '';
  let at = 0;
  for (const [a, b] of runs) {
    out += plain.slice(at, a) + HIDDEN_RUN;
    at = b;
  }
  return out + plain.slice(at);
}

function nextMatch(re: RegExp, text: string, from: number): RegExpExecArray | null {
  re.lastIndex = from;
  return re.exec(text);
}

/** Текст первого такого элемента. Открытие и закрытие ищутся по отдельности: на враждебной строке из тысяч открытий поиск остаётся линейным. */
function elementText(html: string, [open, close]: readonly [RegExp, RegExp]): string {
  const start = open.exec(html);
  if (!start) return '';
  const from = start.index + start[0].length;
  const end = nextMatch(close, html, from);
  return end ? html.slice(from, Math.min(end.index, from + MAX_TITLE_SOURCE)) : '';
}

/** Разметка в обычный текст, не длиннее MAX_TITLE. Тег, обрезанный концом строки, тоже убирается. */
function readable(html: string): string | null {
  const text = html
    .replace(/<[^<>]*(?:>|$)/g, ' ')
    .replace(/&(amp|quot|#39|apos|nbsp);/g, (_m, e: string) => ENTITIES[e]!)
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, MAX_TITLE) || null;
}

const pageTitle = (html: string): string | null => readable(elementText(html, TITLE) || elementText(html, H1));

/** Начало видимого текста страницы: у короткого блока это и есть текст ошибки. Просмотр ограничен, скрипты и стили не текст. */
const pageText = (html: string): string | null => readable(html.slice(0, MAX_TITLE_SOURCE).replace(/<(script|style)\b[^<>]*>[\s\S]*?(?:<\/\1\s*>|$)|<!--[\s\S]*?(?:-->|$)/gi, ' '));

/** Конец страницы без <html>: последний закрывающий тег до следующего документа. Такого тега нет — это не страница, а обрывок вроде «List<p>». */
function blockEnd(text: string, start: number, limit: number): number | null {
  let end: number | null = null;
  CLOSING.lastIndex = start;
  for (let m = CLOSING.exec(text); m && m.index < limit; m = CLOSING.exec(text)) end = m.index + m[0].length;
  return end;
}

/** Страницы в строке по порядку. Документ без </html> идёт до конца строки: текст бывает обрезан посреди страницы. */
export function htmlFragments(text: string): HtmlFragment[] {
  const out: HtmlFragment[] = [];
  if (!text.includes('<')) return out;
  // Найденное начало запоминается, пока до него не дошли: иначе строка из тысяч страниц читалась бы до конца на каждой, а это текст из логов и на сервере.
  let doc = nextMatch(DOCUMENT, text, 0);
  let block = nextMatch(BLOCK, text, 0);
  for (let at = 0; at < text.length; ) {
    if (doc && doc.index < at) doc = nextMatch(DOCUMENT, text, at);
    if (block && block.index < at) block = nextMatch(BLOCK, text, at);
    let start: number;
    let end: number | null;
    if (doc && (!block || doc.index <= block.index)) {
      start = doc.index;
      const close = nextMatch(DOCUMENT_END, text, start);
      end = close ? close.index + close[0].length : text.length;
    } else if (block) {
      start = block.index;
      // Тег перед блоком: это XML или разметка внутри текста, а не страница. Документ дальше ещё может быть.
      end = ANY_TAG.test(text.slice(at, start)) ? null : blockEnd(text, start, doc?.index ?? text.length);
      if (end === null) {
        if (!doc) break;
        at = doc.index;
        continue;
      }
    } else break;
    out.push({ start, end, title: pageTitle(text.slice(start, end)) });
    at = end;
  }
  return out;
}

/** Текст причины без страницы: на её месте заголовок страницы, а без заголовка начало её текста. Нет страницы — та же строка, без единого изменения. pagePart меняет текст, взятый из страницы. */
export function withoutHtml(text: string, pagePart: (fromPage: string) => string = (s) => s): string {
  const parts = htmlFragments(text);
  if (parts.length === 0) return text;
  let out = '';
  let at = 0;
  for (const p of parts) {
    out += `${text.slice(at, p.start)}${pagePart(p.title ?? pageText(text.slice(p.start, p.end)) ?? '')} `;
    at = p.end;
  }
  return `${out}${text.slice(at)}`.replace(/\s+/g, ' ').trim();
}

/** То же для показа в браузере: после этого текста маски уже не будет. Сервер маскирует причину сам, после withoutHtml, и номер в ней остаётся с краями. */
export const withoutHtmlShown = (text: string): string => withoutHtml(text, hideDigitRuns);

interface Place {
  fragment: HtmlFragment;
  source: string;
}

function parsed(s: string): unknown {
  if (!/^\s*["{[]/.test(s)) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

const isPage = (html: string) => !XML_PROLOG.test(html) && (PAGE_TAG.test(html) || PAGE_DOCTYPE.test(html));

/** Строки JSON на любой глубине, в том числе JSON внутри строки. Строка не JSON: ищем в ней самой. */
function collect(value: unknown, depth: number, out: Place[]): void {
  if (depth > MAX_DEPTH) return;
  if (typeof value === 'string') {
    const inner = parsed(value);
    if (inner !== undefined) collect(inner, depth + 1, out);
    else if (!XML_PROLOG.test(value)) {
      for (const fragment of htmlFragments(value)) if (isPage(value.slice(fragment.start, fragment.end))) out.push({ fragment, source: value });
    }
  } else if (Array.isArray(value)) {
    for (const x of value) collect(x, depth + 1, out);
  } else if (typeof value === 'object' && value !== null) {
    for (const x of Object.values(value)) collect(x, depth + 1, out);
  }
}

const sliceOf = ({ fragment: f, source }: Place) => source.slice(f.start, f.end);

/**
 * Страница в теле: всё тело или строка JSON с ней. Несколько страниц: показывается первая, остальные считаются в `more`,
 * одинаковые за одну. В тексте вокруг страницы других страниц нет: на их месте заголовок, как в причине.
 */
export function findHtml(body: string): HtmlFind | null {
  // В JSON «<» бывает записан как <.
  if (!body.includes('<') && !/\\u003c/i.test(body)) return null;
  const places: Place[] = [];
  collect(body, 0, places);
  const first = places[0];
  if (!first) return null;
  const html = sliceOf(first);
  const { fragment: f, source } = first;
  return {
    html,
    before: withoutHtmlShown(source.slice(0, f.start)).trim(),
    after: withoutHtmlShown(source.slice(f.end)).trim(),
    title: f.title === null ? null : hideDigitRuns(f.title),
    more: new Set(places.slice(1).map(sliceOf).filter((x) => x !== html)).size,
    source,
  };
}
