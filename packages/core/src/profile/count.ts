// Выражение подсчёта: явное count.regexp или выведенное из путей correlationId.
import { pathLayer } from './paths.ts';
import { checkRe2, quoteMeta, renameGroups } from './regex.ts';
import type { Layer, PathList, Profile } from './types.ts';

export interface ProfileIssue {
  /** Путь внутри профиля: `variants.0.fields.time`. */
  path: string;
  message: string;
}

export type CountResult = { ok: true; regexp: string } | { ok: false; issues: ProfileIssue[] };

/** Группа ключа в выражении подсчёта. */
export const COUNT_GROUP = 'cid';
/** Значение correlation_id в выведенном выражении: цифры, латиница, «.», «_», «:» и «-». */
export const COUNT_VALUE = `(?P<${COUNT_GROUP}>[0-9a-z._:-]+)`;

const NEED_EXPLICIT = 'задайте count.regexp';

/** Проверка выражения подсчёта: RE2 без запрещённых конструкций, ровно одна именованная группа cid. */
export function checkCountRegexp(re: string): string | null {
  const c = checkRe2(re);
  if (!c.ok) return c.reason;
  const g = c.info.groups;
  if (g.length !== 1 || g[0] !== COUNT_GROUP) {
    return `нужна ровно одна именованная группа (?P<${COUNT_GROUP}>…): другие именованные группы стали бы метками хранилища и умножили бы ряды`;
  }
  return null;
}

const asList = (p: PathList | undefined): string[] => (p === undefined ? [] : typeof p === 'string' ? [p] : p);

/** Все пути correlationId профиля с местом в профиле. */
export function correlationPaths(profile: Profile): { path: string; at: string; variant: number }[] {
  const out: { path: string; at: string; variant: number }[] = [];
  profile.variants.forEach((v, i) => {
    asList(v.fields?.correlationId).forEach((p, j, all) =>
      out.push({ path: p, at: `variants.${i}.fields.correlationId${all.length > 1 || typeof v.fields?.correlationId !== 'string' ? `.${j}` : ''}`, variant: i }),
    );
    v.kinds?.forEach((k, ki) =>
      asList(k.fields?.correlationId).forEach((p, j, all) =>
        out.push({
          path: p,
          at: `variants.${i}.kinds.${ki}.fields.correlationId${all.length > 1 || typeof k.fields?.correlationId !== 'string' ? `.${j}` : ''}`,
          variant: i,
        }),
      ),
    );
  });
  return out;
}

/** Ключ JSON на любом уровне экранирования: `\"key\":` при любом числе обратных слэшей перед кавычкой. */
const jsonKey = (key: string) => `\\\\*"${quoteMeta(key)}\\\\*":`;
/** Объект родителя до ключа: пробелы после двоеточия, скаляры и соседние объекты одного уровня вложенности. */
const PARENT_BODY = '\\s*\\{(?:[^{}]|\\{[^{}]*\\})*?';

/**
 * Литералы JSON null, true и false — не ключ: выведенное выражение берёт значение и без кавычек (числовые id),
 * а разбор такое значение correlation_id не считает.
 */
export function isCountKey(key: string | null | undefined): key is string {
  return key !== undefined && key !== null && key !== '' && !/^(?:null|true|false)$/i.test(key);
}

/**
 * Префиксы для пути в слой json: для каждого написания ключа с точкой — ключ и, если есть, родительский ключ
 * внутри слоя (`"родитель": {…"ключ":`). Ключ после объекта, вложенного глубже одного уровня, или после строки
 * со скобкой { } выражение не видит: для такого формата нужно явное count.regexp.
 */
function jsonPrefixes(segs: string[]): string[] | string {
  if (segs.length === 0) return 'путь указывает на слой целиком';
  if (segs.some((s) => /^\d+$/.test(s))) return 'путь с индексом массива';
  const out: string[] = [];
  for (let k = 1; k <= segs.length; k++) {
    const key = segs.slice(segs.length - k).join('.');
    const parent = segs.length - k - 1 >= 0 ? segs[segs.length - k - 1]! : null;
    if (parent === null && key.toLowerCase() === 'id') return 'ключ id без родителя есть почти в каждой строке';
    out.push(`${parent === null ? '' : `${jsonKey(parent)}${PARENT_BODY}`}${jsonKey(key)}\\s*\\\\*"?`);
  }
  return out;
}

/** Выражение подсчёта профиля: явное или выведенное. */
export function countRegexpOf(profile: Profile): CountResult {
  const explicit = profile.count?.regexp;
  if (explicit !== undefined) {
    const err = checkCountRegexp(explicit);
    return err ? { ok: false, issues: [{ path: 'count.regexp', message: err }] } : { ok: true, regexp: explicit };
  }

  const issues: ProfileIssue[] = [];
  const prefixes = new Set<string>();
  const texts = new Map<string, string>();
  for (const { path, at, variant } of correlationPaths(profile)) {
    const v = profile.variants[variant]!;
    const name = pathLayer(path);
    const layer: Layer | undefined = v.layers?.find((l) => l.name === name) ?? profile.layers?.find((l) => l.name === name);
    if (!layer) continue; // неизвестный слой — ошибка проверки путей
    const segs = path.split('.').slice(1);
    if (layer.decode === 'json') {
      const p = jsonPrefixes(segs);
      if (typeof p === 'string') issues.push({ path: at, message: `выражение подсчёта не выводится из пути ${path}: ${p}; ${NEED_EXPLICIT}` });
      else p.forEach((x) => prefixes.add(x));
    } else if (layer.decode === 'http') {
      if (segs[0] === 'headers' && segs.length > 1) prefixes.add(`(?:\\\\+n|\\n)${quoteMeta(segs.slice(1).join('.'))}: *`);
      else issues.push({ path: at, message: `выражение подсчёта выводится только из заголовка слоя http (${name}.headers.<имя>); ${NEED_EXPLICIT}` });
    } else {
      const re = layer.pattern === undefined ? null : checkRe2(layer.pattern);
      if (layer.from !== undefined || segs.length !== 1 || !re?.ok || !re.info.groups.includes(segs[0]!)) {
        issues.push({
          path: at,
          message: `выражение подсчёта выводится из слоя text, только если он читает строку хранилища (без from) и путь — его группа; ${NEED_EXPLICIT}`,
        });
      } else {
        const group = segs[0]!;
        texts.set(`${name}.${group}`, renameGroups(layer.pattern!, (g) => (g === group ? `(?P<${COUNT_GROUP}>` : '(?:')));
      }
    }
  }
  if (issues.length > 0) return { ok: false, issues };
  if (texts.size > 0) {
    if (texts.size > 1 || prefixes.size > 0) {
      return { ok: false, issues: [{ path: 'count', message: `correlation_id берётся из слоя text и из других мест: одно выражение их не покроет; ${NEED_EXPLICIT}` }] };
    }
    return checked([...texts.values()][0]!);
  }
  if (prefixes.size === 0) return { ok: false, issues: [{ path: 'count', message: `нет путей correlationId; ${NEED_EXPLICIT}` }] };
  return checked(`(?i).*(?:${[...prefixes].join('|')})${COUNT_VALUE}`);
}

function checked(re: string): CountResult {
  const err = checkCountRegexp(re);
  return err ? { ok: false, issues: [{ path: 'count', message: `выведенное выражение не годится (${err}); ${NEED_EXPLICIT}` }] } : { ok: true, regexp: re };
}
