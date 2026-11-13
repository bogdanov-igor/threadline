// Перевод нейтральной модели запроса в LogQL. Значения всегда идут строками в кавычках.

import { FLAG_GROUP, type CountQuery, type Filter, type Matcher } from '@threadline/core/backend';
import { checkCountRegexp, COUNT_GROUP, renameGroups } from '@threadline/core/profile';

/** Строка LogQL в двойных кавычках с экранированием по правилам Go. */
export function quote(value: string): string {
  let out = '"';
  for (const ch of value) {
    const c = ch.codePointAt(0)!;
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (c < 0x20 || c === 0x7f) out += `\\x${c.toString(16).padStart(2, '0')}`;
    else out += ch;
  }
  return out + '"';
}

const LABEL = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function selector(matchers: Matcher[]): string {
  if (!matchers.some((m) => (m.op === '=' && m.value !== '') || m.op === '=~')) {
    throw new Error('селектору нужно условие равенства');
  }
  return `{${matchers
    .map((m) => {
      if (!LABEL.test(m.label)) throw new Error(`недопустимое имя метки: ${m.label}`);
      return `${m.label}${m.op}${quote(m.value)}`;
    })
    .join(', ')}}`;
}

function lineFilter(f: Filter): string {
  switch (f.kind) {
    case 'contains':
      return ` |= ${quote(f.value)}`;
    case 'regex':
      return ` |~ ${quote(f.pattern)}`;
    case 'not-contains':
      return ` != ${quote(f.value)}`;
    case 'not-regex':
      return ` !~ ${quote(f.pattern)}`;
  }
}

export function pipeline(filters: Filter[]): string {
  return filters.map(lineFilter).join('');
}

/** Литерал для регулярного выражения RE2: экранирует все метасимволы, как regexp.QuoteMeta в Go. */
export function escapeRegex(s: string): string {
  return s.replace(/[\\.+*?()|[\]{}^$]/g, '\\$&');
}

/** Запрос чтения строк: селектор и фильтры, без разбора. Строки целиком разбирает сервис. */
export function linesLogql(matchers: Matcher[], filters: Filter[]): string {
  return selector(matchers) + pipeline(filters);
}

/** Имя группы ключа в запросе Loki: группа cid профиля переименовывается, чтобы не спорить с метками потока. */
export const LOKI_KEY = 'threadline_key';

/** Выражение подсчёта профиля для Loki: группа cid → threadline_key, все группы в форме `(?P<имя>`. */
export function lokiCountRegexp(regexp: string): string {
  const err = checkCountRegexp(regexp);
  if (err) throw new Error(`выражение подсчёта не годится: ${err}`);
  return renameGroups(regexp, (name) => `(?P<${name === COUNT_GROUP ? LOKI_KEY : name}>`);
}

/**
 * Подсчёт записей по ключу без чтения строк: одно регулярное выражение профиля по сырой строке, без `| json`.
 * Строки без ключа (например, `[GIN]`) отбрасываются.
 */
export function countLogql(q: CountQuery, rangeSeconds: number): string {
  if (!Number.isSafeInteger(rangeSeconds) || rangeSeconds < 1) throw new Error(`недопустимая длина интервала: ${rangeSeconds}`);
  if (q.keepEmpty || q.flag) return anyCountLogql(q, rangeSeconds);
  return (
    `sum by (${LOKI_KEY}) (count_over_time(${linesLogql(q.selector, q.filters)}` +
    ` | regexp ${quote(lokiCountRegexp(q.key.regexp))} | ${LOKI_KEY}!="" [${rangeSeconds}s]))`
  );
}

/** Имя группы признака строки в запросе Loki. */
export const LOKI_FLAG = 'threadline_flag';

/**
 * Подсчёт поиска операции: без отбрасывания пустого ключа и с признаком строки вторым
 * извлечением. Строка, где признак не совпал, остаётся без метки threadline_flag.
 */
function anyCountLogql(q: CountQuery, rangeSeconds: number): string {
  const by = q.flag ? `${LOKI_KEY}, ${LOKI_FLAG}` : LOKI_KEY;
  let flag = '';
  if (q.flag) {
    const re = renameGroups(q.flag.regexp, (name) => `(?P<${name === FLAG_GROUP ? LOKI_FLAG : name}>`);
    if (!re.includes(`(?P<${LOKI_FLAG}>`)) throw new Error('в выражении признака нет группы flag');
    flag = ` | regexp ${quote(re)}`;
  }
  const empty = q.keepEmpty ? '' : ` | ${LOKI_KEY}!=""`;
  return (
    `sum by (${by}) (count_over_time(${linesLogql(q.selector, q.filters)}` +
    ` | regexp ${quote(lokiCountRegexp(q.key.regexp))}${flag}${empty} [${rangeSeconds}s]))`
  );
}
