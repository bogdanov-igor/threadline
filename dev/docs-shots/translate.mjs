// Снимки на другом языке теми же списками: строки интерфейса в поиске элементов (getByRole, getByText, getByLabel, filter)
// переводятся по файлам строк. Пара берётся по одному ключу в ru.json и файле языка, данные (названия справочника, тексты
// из логов) находятся как раньше: поиск идёт по русской строке или любому её переводу.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const META = /[\\^$.*+?()[\]{}|]/;
const escape = (text) => text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');

function flatten(value, path, out) {
  if (typeof value === 'string') out.set(path, value);
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) flatten(v, path ? `${path}.${k}` : k, out);
  return out;
}

/**
 * Данные снимков на языке: имена пользователей ложного сервиса входа и русские примеры, которые вводят списки. Словарь
 * dev/docs-shots/data.<язык>.json, замена целыми словами, длинные строки раньше коротких: «Тест» не задевает «Тестовое».
 */
export function dataReplacer(here, lang) {
  let dict;
  try {
    dict = JSON.parse(readFileSync(join(here, `data.${lang}.json`), 'utf8'));
  } catch {
    return null;
  }
  const entries = Object.entries(dict).sort(([a], [b]) => b.length - a.length);
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(?:${entries.map(([ru]) => escape(ru)).join('|')})(?![\\p{L}\\p{N}])`, 'gu');
  const replace = (text) => (typeof text === 'string' ? text.replace(pattern, (m) => dict[m] ?? m) : text);
  return { dict, replace };
}

/** Пары «русская строка → строки языка» из всех файлов строк интерфейса. */
function pairs(web, lang) {
  const dirs = [join(web, 'src/i18n'), ...readdirSync(join(web, 'src/features'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(web, 'src/features', d.name))];
  const out = new Map();
  for (const dir of dirs) {
    let ru;
    let other;
    try {
      ru = flatten(JSON.parse(readFileSync(join(dir, 'ru.json'), 'utf8')), '', new Map());
      other = flatten(JSON.parse(readFileSync(join(dir, `${lang}.json`), 'utf8')), '', new Map());
    } catch {
      continue;
    }
    for (const [key, text] of ru) {
      const translated = other.get(key);
      if (translated === undefined || translated === text) continue;
      if (!out.has(text)) out.set(text, new Set());
      out.get(text).add(translated);
    }
  }
  return out;
}

/** Начало строки до первой подстановки {{…}}, без двоеточия и тире в конце: по нему ищется строка с числом или именем внутри. */
const head = (text) => text.split('{{')[0].replace(/[\s:,.—–-]+$/, '');

export function translator(web, lang, data) {
  const map = pairs(web, lang);
  for (const [ru, other] of Object.entries(data?.dict ?? {})) {
    if (!map.has(ru)) map.set(ru, new Set());
    map.get(ru).add(other);
  }
  const heads = new Map();
  for (const [ru, set] of map) {
    const h = head(ru);
    if (h && h !== ru && !map.has(h)) {
      if (!heads.has(h)) heads.set(h, new Set());
      for (const t of set) if (head(t)) heads.get(h).add(head(t));
    }
  }
  /** Часть строки интерфейса (от 8 символов): переводы строк, в которых она есть, если таких строк не больше трёх. */
  function within(text) {
    if (text.length < 8) return null;
    const found = new Set();
    let strings = 0;
    for (const [ru, set] of map) {
      if (!ru.includes(text)) continue;
      if (++strings > 3) return null;
      for (const t of set) if (head(t)) found.add(head(t));
    }
    return found.size > 0 ? found : null;
  }
  // Без точного совпадения поиск Playwright не различает регистр: «Данные не приняты» находит «данные не приняты».
  const lower = new Map();
  for (const [ru, set] of map) {
    const key = ru.toLowerCase();
    if (!lower.has(key)) lower.set(key, new Set());
    for (const t of set) lower.get(key).add(t);
  }
  const variants = (text) => map.get(text) ?? heads.get(text) ?? lower.get(text.toLowerCase()) ?? within(text);

  /** Строка интерфейса: выражение «она или любой её перевод», так же точное или нет. Прочие строки как есть. */
  function text(value, exact) {
    const found = exact ? map.get(value) : variants(value);
    if (!found) return value;
    const alt = [value, ...found].map(escape).join('|');
    return exact ? new RegExp(`^\\s*(?:${alt})\\s*$`) : new RegExp(alt, 'i');
  }

  /** Выражение: каждая простая ветка «текст» или «^текст» получает перевод рядом с собой, данные находятся как раньше. */
  function regex(value) {
    const branches = value.source.split('|');
    let changed = false;
    const out = branches.map((b) => {
      const anchored = b.startsWith('^');
      const plain = anchored ? b.slice(1) : b;
      if (META.test(plain.replace(/\\./g, ''))) return b;
      const found = variants(plain.replace(/\\(.)/g, '$1'));
      if (!found) return b;
      changed = true;
      return [b, ...[...found].map((t) => (anchored ? '^' : '') + escape(t))].join('|');
    });
    // Перевод может начинаться со строчной буквы в середине названия («Колбэк сети…» → «Payout network callback…»).
    return changed ? new RegExp(out.join('|'), value.flags.includes('i') ? value.flags : `${value.flags}i`) : value;
  }

  const one = (value, exact) => (typeof value === 'string' ? text(value, exact) : value instanceof RegExp ? regex(value) : value);
  return { one, size: map.size, data };
}

/**
 * Подменяет поиск элементов у страницы и локатора Playwright: строки интерфейса уходят в поиск уже переведёнными.
 * Текст, который список вводит в поле или редактор, проходит через словарь данных.
 */
export function patchLocators(page, tr) {
  const replace = tr.data?.replace ?? ((text) => text);
  const typing = [Object.getPrototypeOf(page.locator('body')), Object.getPrototypeOf(page.keyboard)];
  for (const proto of typing) {
    if (proto.__typed) continue;
    proto.__typed = true;
    for (const method of ['fill', 'pressSequentially', 'type', 'insertText']) {
      const original = proto[method];
      if (typeof original !== 'function') continue;
      proto[method] = function (value, ...rest) {
        return original.call(this, replace(value), ...rest);
      };
    }
  }
  const protos = new Set([Object.getPrototypeOf(page), Object.getPrototypeOf(page.locator('body')), Object.getPrototypeOf(page.mainFrame())]);
  for (const proto of protos) {
    if (proto.__translated) continue;
    proto.__translated = true;
    for (const method of ['getByText', 'getByLabel', 'getByPlaceholder', 'getByTitle', 'getByAltText']) {
      const original = proto[method];
      if (typeof original !== 'function') continue;
      proto[method] = function (value, options) {
        return original.call(this, tr.one(value, options?.exact), options);
      };
    }
    const byRole = proto.getByRole;
    if (typeof byRole === 'function')
      proto.getByRole = function (role, options) {
        if (!options || options.name === undefined) return byRole.call(this, role, options);
        const name = tr.one(options.name, options.exact);
        return byRole.call(this, role, { ...options, name, exact: name instanceof RegExp ? undefined : options.exact });
      };
    for (const method of ['filter', 'locator']) {
      const original = proto[method];
      if (typeof original !== 'function') continue;
      proto[method] = function (...args) {
        const options = method === 'filter' ? args[0] : args[1];
        if (options && (options.hasText !== undefined || options.hasNotText !== undefined)) {
          const next = { ...options };
          if (options.hasText !== undefined) next.hasText = tr.one(options.hasText, false);
          if (options.hasNotText !== undefined) next.hasNotText = tr.one(options.hasNotText, false);
          if (method === 'filter') args[0] = next;
          else args[1] = next;
        }
        return original.apply(this, args);
      };
    }
  }
}
