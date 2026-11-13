// Строки других языков и страниц грузятся лениво. Русский основной файл лежит в главном
// чанке и служит запасным языком.
//
// Новая страница со своими строками: создать features/<имя>/{ru,en}.json, грузить её код через
// `loadBundle('<имя>').then(() => import('./Page.tsx'))` и добавить строку в i18next.d.ts. Этот модуль и тест сверки менять не нужно.
// Не верхнеуровневый await: с ним сборка выносит общий код из главного чанка в отдельные файлы.
import { storage } from '../lib/storage.ts';
import i18n from './index.ts';
import { DEFAULT_LANGUAGE, isLanguage, languageOf, type LanguageCode } from './languages.ts';

type Strings = Record<string, unknown>;
type StringsFile = { default: Strings };
type Files = Record<string, () => Promise<StringsFile>>;

const KEY = 'threadline.language';
const MAIN_FILES = import.meta.glob<StringsFile>('./en.json');
const SERVER_FILES = import.meta.glob<StringsFile>('./server/en.json');
const PAGE_FILES = import.meta.glob<StringsFile>('../features/*/{ru,en}.json');

let reading = 0;

/** Идёт загрузка файла строк. Сбой такого файла обрабатывается здесь, перезагрузка страницы из flow/load.ts ему не нужна: она потеряла бы поиск. */
export const readingStrings = () => reading > 0;

async function read(files: Files, path: string): Promise<Strings> {
  const load = files[path];
  if (!load) throw new Error(`Нет файла строк ${path}`);
  reading++;
  try {
    return (await load()).default;
  } finally {
    reading--;
  }
}

// Глубокое слияние: раздел catalog есть и в основном файле, и в файле страницы.
const add = (code: string, strings: Strings) => i18n.addResourceBundle(code, 'translation', strings, true, true);

/** Основной файл языка и переводы сообщений сервера. Загружаются вместе; сбой любого означает сбой языка. */
async function loadMain(code: LanguageCode): Promise<void> {
  if (code === DEFAULT_LANGUAGE) return;
  const [main, server] = await Promise.all([read(MAIN_FILES, `./${code}.json`), read(SERVER_FILES, `./server/${code}.json`)]);
  add(code, main);
  add(code, { server });
}

/** Файл страницы на языке, при сбое русский: он ложится в запасной язык, и i18next находит его строки сам. */
async function addPage(name: string, code: string): Promise<void> {
  try {
    add(code, { [name]: await read(PAGE_FILES, `../features/${name}/${code}.json`) });
  } catch (e) {
    if (code === DEFAULT_LANGUAGE) throw e;
    add(DEFAULT_LANGUAGE, { [name]: await read(PAGE_FILES, `../features/${name}/${DEFAULT_LANGUAGE}.json`) });
  }
}

// Страницы, уже открытые в этой вкладке: при смене языка их файлы грузятся вместе с основным.
const opened = new Set<string>();

/** Строки страницы на текущем языке. Вызывается перед ленивым импортом её кода, поэтому страница сразу видна на этом языке. */
export async function loadBundle(name: string): Promise<void> {
  opened.add(name);
  try {
    await addPage(name, i18n.language);
  } catch (e) {
    opened.delete(name);
    throw e;
  }
}

/** Страница могла открыться, пока файлы языка грузятся: круг повторяется, пока новых страниц нет. */
async function loadOpenedPages(code: LanguageCode): Promise<void> {
  const done = new Set<string>();
  for (let todo = [...opened]; todo.length > 0; todo = [...opened].filter((name) => !done.has(name))) {
    await Promise.all(todo.map((name) => addPage(name, code)));
    for (const name of todo) done.add(name);
  }
}

let lastChoice = 0;

/**
 * Смена языка на месте. Сбой загрузки отклоняет обещание: язык и выбор в хранилище не меняются.
 * При двойной смене действует последний выбор, устаревший вызов возвращает false и ничего не применяет.
 */
export async function setLanguage(code: LanguageCode): Promise<boolean> {
  const choice = ++lastChoice;
  try {
    await loadMain(code);
    await loadOpenedPages(code);
  } catch (e) {
    if (choice !== lastChoice) return false;
    throw e;
  }
  if (choice !== lastChoice) return false;
  await i18n.changeLanguage(code);
  storage.set(KEY, code);
  document.documentElement.lang = languageOf(code).tag;
  return true;
}

/**
 * Сохранённый выбор при открытии страницы, до первой отрисовки: вспышки русского нет. Для русского ждать нечего.
 * Сбой загрузки оставляет русский, а выбор в хранилище остаётся для следующего открытия.
 */
export async function applySavedLanguage(): Promise<void> {
  const saved = storage.get(KEY);
  if (!isLanguage(saved) || saved === DEFAULT_LANGUAGE) return;
  try {
    await loadMain(saved);
    await i18n.changeLanguage(saved);
    document.documentElement.lang = languageOf(saved).tag;
  } catch {
    // Страница работает на русском.
  }
}
