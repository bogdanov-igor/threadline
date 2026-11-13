// Региональные правила маскирования и поиска: план телефонных номеров страны и дополнительные образцы видов в тексте.
// По умолчанию правил нет: телефон узнаётся только в международной записи (+44…), личный номер и паспорт — по именам полей,
// счёт — по IBAN и пути. Правила задаёт раздел regional файла настроек; сервер передаёт их интерфейсу в ответе /api/projects.
// Только данные и простые выражения: модуль читает и браузер.

import { checkRe2 } from '../profile/regex.ts';

/** План номеров страны: номер узнаётся и без кода страны, и с местным префиксом. */
export interface PhonePlan {
  /** Код страны без плюса: '44', '998'. */
  countryCode: string;
  /** Цифр в национальном номере без префикса: 10 у '44', 9 у '998'. */
  nationalDigits: number;
  /** Местный префикс перед национальным номером: '0', '8'. */
  trunkPrefix?: string;
  /** Группы национального номера: разделители только между ними, первый — обязателен в местной записи. */
  groups?: readonly number[];
}

/** Виды, для которых раздел задаёт образцы в тексте. У номера карты и секретов правила свои. */
export const PATTERN_KINDS = ['phone', 'national_id', 'passport', 'account_number'] as const;
export type PatternKind = (typeof PATTERN_KINDS)[number];

export interface Regional {
  phone: PhonePlan | null;
  patterns: Partial<Record<PatternKind, readonly string[]>>;
}

/** Раздел файла настроек до нормализации: поля необязательны. */
export interface RegionalInput {
  phone?: PhonePlan | null | undefined;
  patterns?: Partial<Record<PatternKind, readonly string[] | undefined>> | undefined;
}

export const DEFAULT_REGIONAL: Regional = { phone: null, patterns: {} };

/** Пределы раздела: их же проверяет файл настроек. */
export const REGIONAL_LIMITS = { patternsPerKind: 10, patternLength: 200 } as const;

let current: Regional = DEFAULT_REGIONAL;
let version = 0;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** План из ответа сервера или файла: битое значение — плана нет. */
function planOf(v: unknown): PhonePlan | null {
  if (!isObj(v)) return null;
  const { countryCode, nationalDigits, trunkPrefix, groups } = v;
  if (typeof countryCode !== 'string' || !/^[1-9]\d{0,2}$/.test(countryCode)) return null;
  if (typeof nationalDigits !== 'number' || !Number.isInteger(nationalDigits) || nationalDigits < 4 || nationalDigits > 14) return null;
  const plan: PhonePlan = { countryCode, nationalDigits };
  if (typeof trunkPrefix === 'string' && /^\d{1,2}$/.test(trunkPrefix)) plan.trunkPrefix = trunkPrefix;
  if (Array.isArray(groups) && groups.length > 0 && groups.every((g) => Number.isInteger(g) && g > 0) && groups.reduce((a: number, g: number) => a + g, 0) === nationalDigits) {
    plan.groups = groups as number[];
  }
  return plan;
}

/** Раздел в проверенный вид: неизвестные виды и выражения, которых не примет проверка, пропускаются. */
export function normalizeRegional(v: unknown): Regional {
  return normalizeWith(v, patternIssue);
}

/** Нормализация с проверкой образца issue: null — образец годится. */
function normalizeWith(v: unknown, issue: (source: string) => string | null): Regional {
  if (!isObj(v)) return DEFAULT_REGIONAL;
  const patterns: Partial<Record<PatternKind, readonly string[]>> = {};
  if (isObj(v.patterns)) {
    for (const k of PATTERN_KINDS) {
      const list = v.patterns[k];
      if (!Array.isArray(list)) continue;
      const ok = list.filter((p): p is string => typeof p === 'string' && p.length > 0 && p.length <= REGIONAL_LIMITS.patternLength && issue(p) === null).slice(0, REGIONAL_LIMITS.patternsPerKind);
      if (ok.length > 0) patterns[k] = ok;
    }
  }
  const phone = planOf(v.phone);
  return phone === null && Object.keys(patterns).length === 0 ? DEFAULT_REGIONAL : { phone, patterns };
}

/** Почему образец не годится: синтаксис RE2 и JS, именованные группы. null — годится. Линейное время проверяет файл настроек. */
export function patternIssue(source: string): string | null {
  const c = checkRe2(source);
  if (!c.ok) return c.reason;
  if (c.info.groups.length > 0) return 'именованные группы в образце не нужны: маска закрывает всё совпадение';
  if (jsPattern(source) === null) return 'образец не собирается в JavaScript: флаги допустимы только в начале, (?i), (?s) или (?is)';
  return null;
}

const LEADING_FLAGS = /^\(\?([is]{1,2})\)/;

/**
 * Образец как выражение JS с флагом g: флаги RE2 в начале становятся флагами JS. Без разбора RE2: им пользуется и браузер,
 * а образец сервер уже проверил. null — выражение не собирается.
 */
export function jsPattern(source: string): RegExp | null {
  const lead = LEADING_FLAGS.exec(source);
  const flags = lead ? [...new Set(lead[1]!)].join('') : '';
  try {
    return new RegExp(lead ? source.slice(lead[0].length) : source, `${flags}g`);
  } catch {
    return null;
  }
}

/** Правила для всего процесса: сервер ставит их при загрузке настроек, браузер — при получении списка проектов. */
export function setRegional(r: RegionalInput | null | undefined): void {
  commit(normalizeRegional(r));
}

/**
 * Правила из ответа сервера: сервер их уже проверил, здесь проверяется только форма. Без разбора RE2: главный пакет
 * интерфейса не тянет проверку выражений, а образец, который JS не соберёт, маска просто пропустит.
 */
export function applyRegional(r: unknown): void {
  commit(normalizeWith(r, () => null));
}

function commit(next: Regional): void {
  if (JSON.stringify(next) === JSON.stringify(current)) return;
  current = next;
  version++;
}

export function regional(): Regional {
  return current;
}

/** Номер версии правил: выражения, построенные по ним, пересобираются при смене. */
export function regionalVersion(): number {
  return version;
}
