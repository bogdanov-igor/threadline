// Текст страниц: файлы Markdown, название, разделы, порядок. Переводы лежат в папках языков рядом с ru; страница без перевода показывается на русском.
// Текст грузится отдельно от кода страницы, только на языке интерфейса и только своего раздела: loadTexts кладёт его в кэш,
// menuOf, pagesOf и pageText читают кэш. Чанки текста — по языку и группе страниц (vite.config.ts). Картинки грузятся браузером по адресу и только когда до них дошла прокрутка.
import { MENU, type MenuGroup, type Tree } from './menu.ts';

type Load = () => Promise<string>;

const FILES: Readonly<Record<Tree, Record<string, Load>>> = {
  docs: import.meta.glob<string>('./content/*/docs/{guide,file,arch,admin}-*.md', { query: '?raw', import: 'default' }),
  learn: import.meta.glob<string>('./content/*/learn/*.md', { query: '?raw', import: 'default' }),
};
const SHOT_FILES = import.meta.glob<string>('./content/shots/*/*.png', { eager: true, query: '?url', import: 'default' });
const SHOT_SIZES = import.meta.glob<Record<string, { width: number; height: number }>>('./content/shots/*/index.json', { eager: true, import: 'default' });

/** Язык исходного текста: его папка задаёт список страниц. */
const SOURCE = 'ru';

const idOf = (path: string) => /([^/]+)\.md$/.exec(path)![1]!;
const languageOfPath = (path: string) => /^\.\/content\/([^/]+)\//.exec(path)![1]!;
/** Файлы раздела по языкам: список страниц известен без загрузки текста. */
function index(files: Record<string, Load>): Map<string, Map<string, Load>> {
  const out = new Map<string, Map<string, Load>>();
  for (const [path, load] of Object.entries(files)) {
    const language = languageOfPath(path);
    if (!out.has(language)) out.set(language, new Map());
    out.get(language)!.set(idOf(path), load);
  }
  return out;
}
const INDEX: Readonly<Record<Tree, Map<string, Map<string, Load>>>> = { docs: index(FILES.docs), learn: index(FILES.learn) };

const sourceOf = (tree: Tree) => INDEX[tree].get(SOURCE) ?? new Map<string, Load>();
const codeOf = (language: string) => language.split('-')[0]!;
const keyOf = (tree: Tree, language: string) => `${tree}:${codeOf(language)}`;

/** Загруженный текст раздела на языке: страница → текст и язык, на котором он написан. */
const LOADED = new Map<string, Map<string, { text: string; language: string }>>();
const PENDING = new Map<string, Promise<void>>();

/** Текст раздела на этом языке уже в памяти. */
export const textsLoaded = (tree: Tree, language: string): boolean => LOADED.has(keyOf(tree, language));

/**
 * Загрузить текст раздела на языке интерфейса: страницы с переводом — на нём, без перевода — по-русски. Одно и то же обещание,
 * пока загрузка идёт. Обещание со сбоем остаётся: страница получает ту же ошибку и показывает сообщение, а не грузит текст по кругу.
 * Повтор — кнопка сообщения, она перезагружает страницу.
 */
export function loadTexts(tree: Tree, language: string): Promise<void> {
  const key = keyOf(tree, language);
  if (LOADED.has(key)) return Promise.resolve();
  const pending = PENDING.get(key);
  if (pending) return pending;
  const code = codeOf(language);
  const own = INDEX[tree].get(code);
  const source = sourceOf(tree);
  const loading = Promise.all(
    [...source.entries()].map(async ([id, loadSource]) => {
      const loadOwn = own?.get(id);
      return [id, loadOwn ? { text: await loadOwn(), language: code } : { text: await loadSource(), language: SOURCE }] as const;
    }),
  ).then((entries) => {
    LOADED.set(key, new Map(entries));
    PENDING.delete(key);
  });
  PENDING.set(key, loading);
  return loading;
}

const ALL = new Map<string, Promise<void>>();

/** Текст нескольких разделов сразу, для главной документации: одно обещание на набор разделов и язык, как у loadTexts. */
export function loadAll(trees: readonly Tree[], language: string): Promise<void> {
  const key = `${trees.join('+')}:${codeOf(language)}`;
  let loading = ALL.get(key);
  if (!loading) {
    loading = Promise.all(trees.map((tree) => loadTexts(tree, language))).then(() => undefined);
    ALL.set(key, loading);
  }
  return loading;
}

/** Текст на языке интерфейса и язык, на котором он написан: перевода нет, значит русский. До загрузки раздела — null. */
function localized(tree: Tree, id: string, language: string): { text: string; language: string } | null {
  return LOADED.get(keyOf(tree, language))?.get(id) ?? null;
}

export interface DocPage {
  id: string;
  title: string;
}
export interface DocGroup {
  id: MenuGroup['id'];
  pages: DocPage[];
}
export interface Heading {
  id: string;
  level: 2 | 3;
  title: string;
  /** Номер строки в тексте страницы, с единицы: по нему заголовок находит свой якорь. */
  line: number;
}

/** Первая строка «# Название». Остальной текст идёт в показ: заголовок страницы рисует оболочка. */
function split(text: string): { title: string | null; body: string } {
  const m = /^\s*#\s+(.+?)\s*(?:\r?\n|$)/.exec(text);
  return m ? { title: m[1]!, body: text.slice(m[0].length) } : { title: null, body: text };
}

/** Группы и страницы по порядку: сначала названные в menu.ts и существующие, потом остальные файлы группы по имени. */
export function menuOf(tree: Tree, language: string = SOURCE): DocGroup[] {
  const known = sourceOf(tree);
  const groups = MENU[tree];
  const listed = new Set(groups.flatMap((g) => g.pages));
  return groups.map((g, i) => {
    const rest = [...known.keys()].filter((id) => !listed.has(id) && (tree === 'learn' ? i === 0 : id.startsWith(`${g.id}-`))).sort();
    const ids = [...g.pages.filter((id) => known.has(id)), ...rest];
    // До загрузки текста раздела названий нет: на их месте имя файла. Страница документации ждёт загрузки и так не показывается.
    return { id: g.id, pages: ids.map((id) => ({ id, title: split(localized(tree, id, language)?.text ?? '').title ?? id })) };
  });
}

/** Все страницы подряд: так читается документация, по ним идут «Назад» и «Дальше». */
export const pagesOf = (tree: Tree, language: string = SOURCE): DocPage[] => menuOf(tree, language).flatMap((g) => g.pages);

/** language в ответе: на каком языке текст на самом деле. Другой, чем просили, значит перевода этой страницы нет. */
export function pageText(tree: Tree, id: string, language: string = SOURCE): { title: string; body: string; language: string } | null {
  const found = localized(tree, id, language);
  if (!found) return null;
  const { title, body } = split(found.text);
  return { title: title ?? id, body, language: found.language };
}

const slug = (title: string) =>
  title
    .replace(/[*`_]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '');

/** Заголовки разделов и их якоря. Строки внутри блоков кода заголовками не считаются. У одинаковых заголовков разные якоря. */
export function headingsOf(body: string): Heading[] {
  const out: Heading[] = [];
  const seen = new Map<string, number>();
  let fence: string | null = null;
  body.split(/\r?\n/).forEach((line, i) => {
    const mark = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (mark) {
      if (fence === null) fence = mark[0]!;
      else if (mark[0] === fence) fence = null;
      return;
    }
    if (fence !== null) return;
    const m = /^(##|###)\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) return;
    const title = m[2]!.replace(/[*`_]/g, '').trim();
    const base = slug(title) || 'section';
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    out.push({ id: n === 1 ? base : `${base}-${n}`, level: m[1]!.length as 2 | 3, title, line: i + 1 });
  });
  return out;
}

export interface Shot {
  url: string;
  width: number | undefined;
  height: number | undefined;
}

/** Снимок на языке, если его нет, русский. Размеры нужны, чтобы страница не прыгала, пока картинка грузится. */
export function shotOf(name: string, language: string): Shot | null {
  for (const code of [language, 'ru']) {
    const url = SHOT_FILES[`./content/shots/${code}/${name}.png`];
    if (url) {
      const size = SHOT_SIZES[`./content/shots/${code}/index.json`]?.[name];
      return { url, width: size?.width, height: size?.height };
    }
  }
  return null;
}

/** Страницы на карточке раздела на главной: из списка featured, которые есть. */
export function featuredOf(tree: Tree, group: MenuGroup['id'], language: string = SOURCE): DocPage[] {
  const wanted = MENU[tree].find((g) => g.id === group)?.featured ?? [];
  const pages = menuOf(tree, language).find((g) => g.id === group)?.pages ?? [];
  return wanted.map((id) => pages.find((p) => p.id === id)).filter((p): p is DocPage => !!p);
}

/** Регистр и «ё» не важны: «Ёлка» находится по «елка». Длина строки не меняется, поэтому места совпадений в исходном тексте те же. */
export const normalize = (text: string) => text.toLowerCase().replace(/ё/g, 'е');

const WORD = /[\p{L}\p{N}]+/gu;
const CYRILLIC = /[а-я]/;
// Окончания русских слов, длинные первыми. Основа остаётся не короче трёх букв: «роль» → «рол», «карта» → «карт», «тёмная» → «темн».
const ENDING_RU = /(?:ами|ями|ого|его|ому|ему|ыми|ими|ая|яя|ое|ее|ые|ие|ый|ий|ой|ей|ам|ям|ах|ях|ом|ем|ов|ев|ую|юю|ья|ье|ью|а|я|о|е|ы|и|у|ю|ь|й)$/;

/**
 * Основа слова запроса: «карта» находит «карты» и «карту», «роль» — «роли», «masking» — «masks». Слово сравнивается с началом
 * слов текста, поэтому недописанное слово тоже находит. Словарь не нужен: отбрасывается только окончание.
 */
export function stemOf(word: string): string {
  if (CYRILLIC.test(word)) {
    if (word.length < 4) return word;
    const cut = word.replace(ENDING_RU, '');
    return cut.length >= 3 ? cut : word;
  }
  if (/^[a-z]+$/.test(word)) {
    const cut = word.length >= 6 ? word.replace(/(?:ing|ed|es|s)$/, '') : word.length >= 4 ? word.replace(/s$/, '') : word;
    return cut.length >= 3 ? cut : word;
  }
  return word;
}

/** Слова запроса: основы без повторов. */
export const termsOf = (query: string): string[] => [...new Set((normalize(query).match(WORD) ?? []).map(stemOf))];

/** Слова текста без повторов, в нижнем регистре и без «ё». */
const wordsIn = (text: string): string[] => [...new Set(normalize(text).match(WORD) ?? [])];

/** Хотя бы одно слово начинается с основы. */
const hasTerm = (words: readonly string[], term: string) => words.some((w) => w.startsWith(term));
const hasAll = (words: readonly string[], terms: readonly string[]) => terms.every((t) => hasTerm(words, t));

/** Где в тексте слова, которые начинаются с основ запроса: для выделения и отрывка. Конец — конец слова целиком. */
export function matchesIn(text: string, terms: readonly string[]): { at: number; end: number }[] {
  if (terms.length === 0) return [];
  const out: { at: number; end: number }[] = [];
  for (const m of normalize(text).matchAll(WORD)) if (terms.some((t) => m[0].startsWith(t))) out.push({ at: m.index, end: m.index + m[0].length });
  return out;
}

/** Текст Markdown без разметки: так его видит читатель. Блоки кода остаются: в них имена полей и команды, их тоже ищут. */
function plainOf(markdown: string): string {
  return markdown
    .replace(/^\s{0,3}(?:`{3,}|~{3,}).*$/gm, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^\s*(?:[-*+]|\d+\.|>|#{1,6})\s+/gm, '')
    .replace(/^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/gm, ' ')
    // Звёздочки, обратные кавычки и обратная косая черта убираются без пробела: иначе «`url`,» в отрывке становится «url ,».
    .replace(/[*`\\]+/g, '')
    .replace(/\|+/g, ' ')
    // Подчёркивание выделения (_слово_) убирается, внутри имени (THREADLINE_LOKI_PASSWORD, user_id) остаётся.
    .replace(/(^|\s)_+|_+(?=\s|$)/g, '$1')
    .replace(/\[!\w+\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Раздел страницы в поиске: его заголовок (у вступления нет), слова заголовка, слова текста и сам текст для отрывка. */
interface Section {
  heading: Heading | null;
  titleWords: string[];
  words: string[];
  text: string;
}

/** Страница в поиске: название и разделы. Строится один раз на раздел документации и язык, после загрузки текста. */
interface Indexed {
  group: MenuGroup['id'];
  page: DocPage;
  titleWords: string[];
  sections: Section[];
}

function sectionsOf(body: string): Section[] {
  const lines = body.split(/\r?\n/);
  const headings = headingsOf(body);
  const parts: { heading: Heading | null; from: number; to: number }[] = [{ heading: null, from: 0, to: headings[0] ? headings[0].line - 1 : lines.length }];
  headings.forEach((h, i) => parts.push({ heading: h, from: h.line, to: headings[i + 1] ? headings[i + 1]!.line - 1 : lines.length }));
  return parts.map(({ heading, from, to }) => {
    const text = plainOf(lines.slice(from, to).join('\n'));
    return { heading, titleWords: heading ? wordsIn(heading.title) : [], words: wordsIn(text), text };
  });
}

const INDEXES = new Map<string, Indexed[]>();

function indexOf(tree: Tree, language: string): Indexed[] {
  if (!textsLoaded(tree, language)) return [];
  const key = keyOf(tree, language);
  const found = INDEXES.get(key);
  if (found) return found;
  const out = menuOf(tree, language).flatMap((g) =>
    g.pages.map((page) => ({ group: g.id, page, titleWords: wordsIn(page.title), sections: sectionsOf(pageText(tree, page.id, language)?.body ?? '') })),
  );
  INDEXES.set(key, out);
  return out;
}

export interface SearchHit {
  tree: Tree;
  group: MenuGroup['id'];
  page: DocPage;
  /** Совпал раздел страницы, а не её название. */
  heading: Heading | null;
  /** Слова нашлись в тексте, а не в названии: отрывок текста вокруг первого совпадения. */
  snippet: string | null;
}

/** Отрывок текста вокруг первого совпадения: с начала слова, с многоточием там, где текст обрезан. */
function snippetOf(text: string, terms: readonly string[], size = 140): string {
  const first = matchesIn(text, terms)[0];
  if (!first) return text.slice(0, size);
  let from = Math.max(0, first.at - 40);
  if (from > 0) from = text.indexOf(' ', from) + 1 || from;
  const to = Math.min(text.length, from + size);
  return `${from > 0 ? '…' : ''}${text.slice(from, to).trim()}${to < text.length ? '…' : ''}`;
}

/** Сколько слов раздела совпало: раздел, где слов запроса больше, выше. */
const weightOf = (section: Section, terms: readonly string[]) => section.words.filter((w) => terms.some((t) => w.startsWith(t))).length;

/**
 * Поиск по названиям страниц, разделам и тексту: все слова запроса должны найтись, слово находит свои формы и продолжения.
 * Порядок: страницы, чьё название начинается с запроса, другие страницы по названию, разделы по заголовку, потом совпадения в тексте:
 * у страницы одно, в разделе, где слов запроса больше всего. Внутри одного уровня порядок меню.
 */
export function searchDocs(trees: readonly Tree[], language: string, query: string, limit = 8): SearchHit[] {
  const terms = termsOf(query);
  if (terms.length === 0) return [];
  const first = terms[0]!;
  const ranked: { hit: SearchHit; rank: number; weight: number; at: number }[] = [];
  const add = (hit: SearchHit, rank: number, weight = 0) => ranked.push({ hit, rank, weight, at: ranked.length });
  for (const tree of trees)
    for (const entry of indexOf(tree, language)) {
      const base = { tree, group: entry.group, page: entry.page };
      const byTitle = hasAll(entry.titleWords, terms);
      if (byTitle) add({ ...base, heading: null, snippet: null }, entry.titleWords[0]?.startsWith(first) ? 0 : 1);
      const byHeading = new Set<Section>();
      for (const section of entry.sections)
        if (section.heading && hasAll(section.titleWords, terms)) {
          byHeading.add(section);
          add({ ...base, heading: section.heading, snippet: null }, section.titleWords[0]?.startsWith(first) ? 2 : 3);
        }
      if (byTitle || byHeading.size > 0) continue;
      // В тексте: раздел, где нашлись все слова; если они разбросаны по разным разделам — страница целиком.
      const inSection = entry.sections
        .filter((sec) => hasAll([...sec.titleWords, ...sec.words], terms))
        .map((sec) => ({ sec, weight: weightOf(sec, terms) }))
        .sort((a, b) => b.weight - a.weight)[0];
      if (inSection) add({ ...base, heading: inSection.sec.heading, snippet: snippetOf(inSection.sec.text, terms) }, 4, inSection.weight);
      else if (hasAll(entry.sections.flatMap((sec) => sec.words), terms))
        add({ ...base, heading: null, snippet: snippetOf(entry.sections.find((sec) => terms.some((t) => hasTerm(sec.words, t)))?.text ?? '', terms) }, 5);
    }
  return ranked
    .sort((a, b) => a.rank - b.rank || b.weight - a.weight || a.at - b.at)
    .slice(0, limit)
    .map((r) => r.hit);
}

export interface FilteredGroup {
  id: MenuGroup['id'];
  pages: { page: DocPage; headings: Heading[] }[];
}

/** Разделов под страницей в фильтре, найденных по тексту, не больше этого: список остаётся списком страниц. */
const FILTER_SECTIONS = 3;

/**
 * Меню по фильтру: так же, как поиск. Страница остаётся, если совпало название, раздел или текст. Под страницей — разделы
 * с совпавшим заголовком, а если таких нет — разделы, где слова нашлись в тексте.
 */
export function filterMenu(tree: Tree, language: string, query: string): FilteredGroup[] {
  const terms = termsOf(query);
  if (terms.length === 0) return [];
  const entries = indexOf(tree, language);
  return MENU[tree]
    .map((g) => ({
      id: g.id,
      pages: entries
        .filter((e) => e.group === g.id)
        .map((e) => {
          const titled = e.sections.filter((sec) => sec.heading && hasAll(sec.titleWords, terms));
          const inText = titled.length > 0 ? [] : e.sections.filter((sec) => sec.heading && hasAll([...sec.titleWords, ...sec.words], terms)).slice(0, FILTER_SECTIONS);
          const found = hasAll(e.titleWords, terms) || titled.length > 0 || inText.length > 0 || hasAll(e.sections.flatMap((sec) => sec.words), terms);
          return { page: e.page, found, headings: [...titled, ...inText].map((sec) => sec.heading!) };
        })
        .filter((p) => p.found)
        .map(({ page, headings }) => ({ page, headings })),
    }))
    .filter((g) => g.pages.length > 0);
}
