// Документ для показа страницы из лога: стили без внешних ссылок и своя политика CSP.
// Номера, которые складывает только браузер (карта по соседним ячейкам, телефон, разбитый тегами), закрываются здесь, после разбора страницы.
import { luhnValid } from '@threadline/core';
import type { AuthMe } from '@threadline/core/access';
import { cardsIn, hiddenInDetails, phonesIn, type MaskViewer } from '@threadline/core/search';

/** Ни сети, ни скриптов, только встроенные стили. */
export const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'";

/** Больше тегов не показывается: на враждебной разметке разбор браузера растёт быстрее размера и держит вкладку десятки секунд. На этом пределе разбор занимает десятки миллисекунд. */
export const PAGE_TAG_LIMIT = 5000;

const DIGIT = /\p{Nd}/u;
const SPACE = /\s/u;
// Между цифрами номера: пробел или дефис. Точка и двоеточие разрывают серию, поэтому дата и время номером не считаются.
const CARD_GAP = /[\s-]/u;
const MIN_CARD_DIGITS = 13;
const KEEP_NOTHING: ReadonlySet<string> = new Set();
// Номер из соседних блоков той же формы, что у сервера для групп через теги: по четыре цифры, последняя группа короче, 16–19 цифр.
const CARD_GROUP = 4;
const MIN_CHAIN = 16;
const MAX_CHAIN = 19;
const KEPT_PHONE_DIGITS = 4;
// Текст в разных таких блоках на экране не складывается в один номер: ячейки таблицы, абзацы, строки списка.
const TEXT_BLOCK = 'td,th,tr,li,p,div,pre,h1,h2,h3,h4,h5,h6,dt,dd,blockquote,section,article,header,footer,body';

/** Какие виды страница закрывает сама. */
export interface PageHide {
  cards: boolean;
  phones: boolean;
}

/** Сколько номеров страница закрыла сама. */
export interface PageHidden {
  cards: number;
  phones: number;
}

/** Зритель как у сервера (viewerOf): короткая ссылка, без входа при auth: off, иначе роль сессии. */
export const pageViewer = (share: boolean, mode: AuthMe['mode'], role: AuthMe['role']): MaskViewer => (share ? 'link' : mode === 'off' ? 'no-login' : (role ?? 'business'));

/** Страница закрывает вид там, где сервер скрыл бы его этому зрителю в блоке подробностей: до показа и после «Показать скрытое». */
export const pageHide = (viewer: MaskViewer, revealed: boolean): PageHide => ({ cards: hiddenInDetails('card_number', viewer, revealed), phones: hiddenInDetails('phone', viewer, revealed) });

/** Текст подряд идущих узлов с одним ближайшим блоком. starts — где в тексте начинается каждый узел; block и after только сравниваются: блок отрезка и его предыдущий сосед-элемент. */
export interface PageSegment {
  text: string;
  starts: readonly number[];
  block: unknown;
  after: unknown;
}

export interface PageMarks extends PageHidden {
  /** Номер отрезка → смещения символов, которые становятся звёздочкой. */
  marks: Map<number, Set<number>>;
}

type Digit = [segment: number, offset: number, value: string];

/** Значение цифры любого письма: нулевая цифра каждого набора стоит на границе десятка, поэтому проверяем ближайшие соседи. */
function digitValue(char: string): string {
  const code = char.codePointAt(0)!;
  if (code < 128) return char;
  for (let value = 0; value <= 9; value++) {
    if (DIGIT.test(String.fromCodePoint(code - value)) && !DIGIT.test(String.fromCodePoint(code - value - 1))) return String(value);
  }
  return '0';
}

/**
 * Что закрыть в тексте страницы, один проход по отрезкам. Номер карты внутри блока: цифры через пробел, дефис и строчные теги, первые шесть и последние четыре видны.
 * Номер из соседних блоков: каждая часть только из цифр и разделителей, части рядом у одного родителя, группы по четыре, 16–19 цифр, Луна у всего номера или у первых 16, как у сервера.
 * Соседняя часть из цифр, ломающая форму, гасит всю цепочку. Телефон: образец маски сервера, только если теги его разбили; видны последние четыре цифры.
 */
export function marksInPage(segments: readonly PageSegment[], hide: PageHide): PageMarks {
  const marks = new Map<number, Set<number>>();
  const out: PageMarks = { cards: 0, phones: 0, marks };
  const mark = (segment: number, at: number) => {
    const set = marks.get(segment);
    if (set) set.add(at);
    else marks.set(segment, new Set([at]));
  };
  const hideCard = (digits: readonly Digit[], from: number, to: number) => {
    out.cards++;
    for (let at = from + 6; at < to - 4; at++) mark(digits[at]![0], digits[at]![1]);
  };
  // Цепочка соседних блоков: цифры частей, сколько частей, блок последней, последняя группа короче четырёх, форма сломана.
  let chain: Digit[] = [];
  let pieces = 0;
  let last: unknown = null;
  let closed = false;
  let broken = false;
  const endChain = () => {
    if (!broken && pieces >= 2 && chain.length >= MIN_CHAIN) {
      const all = chain.map((d) => d[2]).join('');
      const n = luhnValid(all) ? all.length : luhnValid(all.slice(0, MIN_CHAIN)) ? MIN_CHAIN : 0;
      if (n > 0) hideCard(chain, 0, n);
    }
    chain = [];
    pieces = 0;
    last = null;
    closed = false;
    broken = false;
  };

  segments.forEach((seg, i) => {
    const { text, starts } = seg;
    if (hide.phones) {
      let k = 0;
      for (const [a, b] of phonesIn(text)) {
        while (k < starts.length && starts[k]! <= a) k++;
        // Целый телефон в одном узле решает маска сервера: он закрыт или открыт ей намеренно.
        if (k >= starts.length || starts[k]! >= b) continue;
        out.phones++;
        const digits: number[] = [];
        for (let at = a; at < b; at++) if (text.charCodeAt(at) >= 48 && text.charCodeAt(at) <= 57) digits.push(at);
        for (const at of digits.slice(0, -KEPT_PHONE_DIGITS)) mark(i, at);
      }
    }
    if (!hide.cards) return;

    let run: Digit[] = [];
    const flush = () => {
      if (run.length >= MIN_CARD_DIGITS) for (const [from, to] of cardsIn(run.map((d) => d[2]).join(''), KEEP_NOTHING)) hideCard(run, from, to);
      run = [];
    };
    // Часть цепочки: её цифры и длины групп. Часть из 16 цифр в цепочку не идёт, больше хранить незачем.
    const piece: Digit[] = [];
    const groups: number[] = [];
    let digits = 0;
    let group = 0;
    let pure = true;
    let blank = true;
    for (let at = 0; at < text.length; ) {
      const char = String.fromCodePoint(text.codePointAt(at)!);
      if (DIGIT.test(char)) {
        const d: Digit = [i, at, digitValue(char)];
        run.push(d);
        if (piece.length < MIN_CHAIN) piece.push(d);
        digits++;
        group++;
        blank = false;
      } else if (CARD_GAP.test(char)) {
        if (group > 0) groups.push(group);
        group = 0;
        if (!SPACE.test(char)) blank = false;
      } else {
        flush();
        pure = false;
        blank = false;
      }
      at += char.length;
    }
    if (group > 0) groups.push(group);
    flush();

    // Пробельный текст между ячейками и блоками цепочку не рвёт.
    if (blank) return;
    const isPiece = pure && digits > 0;
    if (!(isPiece && pieces > 0 && seg.after !== null && seg.after === last)) {
      endChain();
      if (!isPiece) return;
    }
    pieces++;
    last = seg.block;
    if (broken) return;
    // Часть из 16 цифр и больше — номер сама по себе, его закрыл разбор внутри блока.
    if (digits >= MIN_CHAIN || chain.length + digits > MAX_CHAIN) {
      broken = true;
      return;
    }
    for (const g of groups) {
      if (closed || g > CARD_GROUP) {
        broken = true;
        return;
      }
      closed = g < CARD_GROUP;
    }
    chain.push(...piece);
  });
  endChain();
  return out;
}

/**
 * Сервер закрывает номера в тексте; номер, который складывает только браузер, он не видит: группы в тегах, ячейках и соседних блоках. Поэтому номер ищется по тексту, который соберёт браузер.
 * Что закрывать, решает hide: виды, которые сервер скрыл бы этому зрителю (pageHide). Стили не считаются: текст из них не рисуется. Возвращает число скрытых номеров.
 */
export function hideDigitsInPage(root: Element, hide: PageHide): PageHidden {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const segments: { text: string; starts: number[]; block: Element | null; after: Element | null }[] = [];
  const nodes: Text[][] = [];
  let block: Element | null | undefined;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const parent = node.parentElement;
    if (parent?.closest('style')) continue;
    const nodeBlock = parent?.closest(TEXT_BLOCK) ?? null;
    if (nodeBlock !== block) {
      segments.push({ text: '', starts: [], block: nodeBlock, after: nodeBlock?.previousElementSibling ?? null });
      nodes.push([]);
      block = nodeBlock;
    }
    const seg = segments[segments.length - 1]!;
    seg.starts.push(seg.text.length);
    seg.text += node.data;
    nodes[nodes.length - 1]!.push(node);
  }
  const found = marksInPage(segments, hide);
  for (const [i, offsets] of found.marks) {
    const seg = segments[i]!;
    nodes[i]!.forEach((node, k) => {
      const start = seg.starts[k]!;
      let out = '';
      let changed = false;
      for (let at = 0; at < node.data.length; ) {
        const char = String.fromCodePoint(node.data.codePointAt(at)!);
        changed ||= offsets.has(start + at);
        out += offsets.has(start + at) ? '*' : char;
        at += char.length;
      }
      if (changed) node.data = out;
    });
  }
  return { cards: found.cards, phones: found.phones };
}

/** Считает теги дешевле любого разбора. */
export function tooManyTags(html: string, limit = PAGE_TAG_LIMIT): boolean {
  let n = 0;
  for (let at = html.indexOf('<'); at >= 0; at = html.indexOf('<', at + 1)) {
    const c = html.charCodeAt(at + 1);
    // Буква, / ! или ?: то, что браузер считает разметкой.
    if (((c | 32) >= 97 && (c | 32) <= 122) || c === 47 || c === 33 || c === 63) {
      if (++n > limit) return true;
    }
  }
  return false;
}

// Начало значения, которое браузер пошёл бы загружать: значение до парной скобки, а без неё до конца, заменяется на none. @import и @font-face убираются целиком.
const CSS_FETCH = /(?:url|image-set|-webkit-image-set|image|cross-fade|element|paint|src|expression)\s*\(/gi;
const CSS_RULES = /@import[^;]*;?|@font-face\s*\{[^}]*(?:\}|$)|@namespace[^;]*;?/gi;
// content: текст, нарисованный стилем, маска не видит: цифры можно сложить из отдельных строк.
const CSS_OTHER = /behavior\s*:[^;}]*;?|-moz-binding\s*:[^;}]*;?|(?<![\w-])content\s*:[^;}]*;?/gi;
/** Удаление одного правила может собрать другое: столько проходов хватает честному стилю, остальное убирается целиком. */
const CSS_PASSES = 3;

function withoutFetches(css: string): string {
  let out = '';
  let at = 0;
  CSS_FETCH.lastIndex = 0;
  for (let m = CSS_FETCH.exec(css); m !== null; m = CSS_FETCH.exec(css)) {
    let i = CSS_FETCH.lastIndex;
    for (let depth = 1; i < css.length && depth > 0; i++) {
      if (css[i] === '(') depth++;
      else if (css[i] === ')') depth--;
    }
    out += `${css.slice(at, m.index)}none`;
    at = i;
    CSS_FETCH.lastIndex = i;
  }
  return at === 0 ? css : out + css.slice(at);
}

/** Стиль страницы без внешних ссылок. Экранирование в CSS прячет имя функции от проверки: такой стиль убирается целиком. */
export function cleanCss(css: string): string {
  if (css.includes('\\')) return '';
  let out = css;
  for (let i = 0; i < CSS_PASSES; i++) {
    const next = withoutFetches(out.replace(CSS_RULES, '').replace(CSS_OTHER, ''));
    if (next === out) return out;
    out = next;
  }
  return '';
}

/** Белый лист как в браузере в обеих темах, значения страницы могут это поменять. Политика стоит первой: всё остальное уже под ней. */
export function pageShell(head: string, body: string): string {
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${PAGE_CSP}"><meta name="referrer" content="no-referrer"><style>html{background:#fff;color:#000;color-scheme:light}</style>${head}</head><body>${body}</body></html>`;
}
