import { MESSAGE_KEYS } from '@threadline/core';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LANGUAGE, LANGUAGES, type Language } from './languages.ts';

// Сверка ключей между языками. Файлы находит сама: новый features/<имя>/ru.json
// попадает под проверку без правки этого файла. Значения, равные русским (Threadline, UUID, OK), разрешены.

type Tree = { [key: string]: string | Tree };

// Сырой текст: i18next вливает строки страниц в тот же импортированный объект ru.json, и сверка видела бы чужие ключи.
const RAW = import.meta.glob<string>('../**/{ru,en}.json', { eager: true, query: '?raw', import: 'default' });
const FILES = Object.fromEntries(Object.entries(RAW).map(([path, text]) => [path, JSON.parse(text) as Tree]));
const SERVER_DIR = './server/';

const TRANSLATIONS = LANGUAGES.filter((l) => l.code !== DEFAULT_LANGUAGE);
const FORM = /_(zero|one|two|few|many|other)$/;
const CYRILLIC = /[Ѐ-ӿ]/;

function flatten(tree: Tree, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out.set(path, value);
    else for (const [k, v] of flatten(value, path)) out.set(k, v);
  }
  return out;
}

/** Ключи со свёрнутыми формами числа: основа → форма ('' у ключа без форм) → значение. */
function fold(flat: Map<string, string>): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  for (const [key, value] of flat) {
    const form = FORM.exec(key)?.[1] ?? '';
    const base = form ? key.slice(0, -form.length - 1) : key;
    if (!out.has(base)) out.set(base, new Map());
    out.get(base)!.set(form, value);
  }
  return out;
}

const placeholders = (value: string) => [...new Set([...value.matchAll(/\{\{\s*([^}\s,]+)[^}]*\}\}/g)].map((m) => m[1]!))].sort();
const sameList = (a: readonly string[], b: readonly string[]) => a.join() === b.join();

/** Значения перевода: пустые, чужая письменность. */
function valueProblems(lang: Language, flat: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [key, value] of flat) {
    if (value.trim() === '') out.push(`пустое значение: ${key}`);
    if (lang.script === 'latin' && CYRILLIC.test(value)) out.push(`кириллица в значении: ${key}`);
  }
  return out;
}

/** Расхождения перевода с русским файлом: ключи, формы числа, подстановки, значения. */
function compare(ru: Tree, other: Tree, lang: Language): string[] {
  const out: string[] = [];
  const source = fold(flatten(ru));
  const flat = flatten(other);
  const target = fold(flat);
  for (const [base, forms] of source) {
    const got = target.get(base);
    if (!got) {
      out.push(`нет ключа: ${base}`);
      continue;
    }
    const plural = !forms.has('');
    const wanted = plural ? ['one', 'other'] : [''];
    for (const form of wanted) if (!got.has(form)) out.push(`нет формы ${form || 'без числа'}: ${base}`);
    for (const form of got.keys()) if (!wanted.includes(form)) out.push(`лишняя форма ${form || 'без числа'}: ${base}`);
    for (const [form, value] of got) {
      // У русского форма other есть не у всех групп: сравнение с many.
      const ruValue = forms.get(form) ?? forms.get('many');
      if (ruValue !== undefined && !sameList(placeholders(value), placeholders(ruValue))) {
        out.push(`подстановки {{${placeholders(value).join(', ')}}} вместо {{${placeholders(ruValue).join(', ')}}}: ${form ? `${base}_${form}` : base}`);
      }
    }
  }
  for (const base of target.keys()) if (!source.has(base)) out.push(`лишний ключ: ${base}`);
  return [...out, ...valueProblems(lang, flat)];
}

/** Формы числа в самом русском файле: one, few и many есть у каждой группы. */
function russianForms(ru: Tree): string[] {
  const out: string[] = [];
  for (const [base, forms] of fold(flatten(ru))) {
    if (forms.has('')) continue;
    for (const form of ['one', 'few', 'many']) if (!forms.has(form)) out.push(`нет формы ${form}: ${base}`);
  }
  return out;
}

/** Переводы сообщений сервера сверяются с таблицей ключей ядра: русского файла у них нет, русский текст присылает сервер. */
function compareServer(tree: Tree, lang: Language, keys: Readonly<Record<string, readonly string[]>> = MESSAGE_KEYS): string[] {
  const out: string[] = [];
  const flat = flatten(tree);
  for (const [key, params] of Object.entries(keys)) {
    const value = flat.get(key);
    if (value === undefined) {
      out.push(`нет ключа: ${key}`);
      continue;
    }
    if (!sameList(placeholders(value), [...params].sort())) out.push(`подстановки {{${placeholders(value).join(', ')}}} вместо {{${[...params].sort().join(', ')}}}: ${key}`);
  }
  for (const key of flat.keys()) if (!(key in keys)) out.push(`лишний ключ: ${key}`);
  return [...out, ...valueProblems(lang, flat)];
}

const russianFiles = Object.keys(FILES).filter((path) => path.endsWith('/ru.json'));
const dirOf = (path: string) => path.slice(0, path.lastIndexOf('/') + 1);
const en = LANGUAGES.find((l) => l.code === 'en')!;

describe('файлы строк', () => {
  it('найдены основной файл и файлы страниц', () => {
    expect(russianFiles).toEqual(expect.arrayContaining(['./ru.json', '../features/catalog/ru.json', '../features/projects/ru.json']));
  });

  describe.each(russianFiles)('%s', (ruPath) => {
    const ru = FILES[ruPath]!;

    it('русские формы числа: one, few, many', () => {
      expect(russianForms(ru)).toEqual([]);
    });

    it.each(TRANSLATIONS.map((l) => [l.code, l] as const))('%s: файл есть, ключи, формы и подстановки совпадают', (code, lang) => {
      const path = `${dirOf(ruPath)}${code}.json`;
      const other = FILES[path];
      expect(other ? compare(ru, other, lang) : [`нет файла: ${path}`], path).toEqual([]);
    });
  });

  describe.each(TRANSLATIONS.map((l) => [l.code, l] as const))('сообщения сервера %s', (code, lang) => {
    it('совпадают с MESSAGE_KEYS по ключам и параметрам', () => {
      const path = `${SERVER_DIR}${code}.json`;
      const other = FILES[path];
      expect(other ? compareServer(other, lang) : [`нет файла: ${path}`], path).toEqual([]);
    });
  });
});

// Сама проверка: расхождение называется по имени, даже пока переводы не готовы.
describe('что сверка считает ошибкой', () => {
  const ru: Tree = { a: { title: 'Заголовок', named: 'Имя {{name}}', requests_one: '{{count}} запрос', requests_few: '{{count}} запроса', requests_many: '{{count}} запросов', requests_other: '{{count}} запроса' } };
  const good: Tree = { a: { title: 'Title', named: 'Name {{name}}', requests_one: '{{count}} request', requests_other: '{{count}} requests' } };
  const withA = (over: Tree) => ({ a: { ...(good.a as Tree), ...over } });

  it('верный перевод и значение, равное русскому', () => {
    expect(compare(ru, good, en)).toEqual([]);
    expect(compare({ a: 'OK' }, { a: 'OK' }, en)).toEqual([]);
  });

  it('нет перевода и лишний ключ', () => {
    expect(compare(ru, { a: { named: 'Name {{name}}', requests_one: '{{count}}', requests_other: '{{count}}' } }, en)).toEqual(['нет ключа: a.title']);
    expect(compare(ru, withA({ extra: 'x' }), en)).toEqual(['лишний ключ: a.extra']);
  });

  it('подстановка потеряна', () => {
    expect(compare(ru, withA({ named: 'Name' }), en)).toEqual(['подстановки {{}} вместо {{name}}: a.named']);
  });

  it('кириллица и пустое значение', () => {
    expect(compare(ru, withA({ title: 'Заголовок' }), en)).toEqual(['кириллица в значении: a.title']);
    expect(compare(ru, withA({ title: ' ' }), en)).toEqual(['пустое значение: a.title']);
  });

  it('форма few лишняя, формы other нет', () => {
    expect(compare(ru, withA({ requests_few: '{{count}} requests' }), en)).toEqual(['лишняя форма few: a.requests']);
    expect(compare(ru, { a: { title: 'T', named: '{{name}}', requests_one: '{{count}}' } }, en)).toEqual(['нет формы other: a.requests']);
  });

  it('русская группа без формы few', () => {
    expect(russianForms({ requests_one: '{{count}}', requests_many: '{{count}}' })).toEqual(['нет формы few: requests']);
  });

  it('ключ сообщения сервера без перевода, лишний и с другими параметрами', () => {
    const keys = { 'a.one': ['max'], 'a.two': [] };
    expect(compareServer({ a: { one: 'up to {{max}}', two: 'x' } }, en, keys)).toEqual([]);
    expect(compareServer({ a: { one: 'up to {{max}}' } }, en, keys)).toEqual(['нет ключа: a.two']);
    expect(compareServer({ a: { one: 'up to', two: 'x', three: 'y' } }, en, keys)).toEqual(['подстановки {{}} вместо {{max}}: a.one', 'лишний ключ: a.three']);
  });
});
