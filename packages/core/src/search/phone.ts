// Телефон: распознавание значения поиска и шаблоны фильтра по плану номеров страны (regional.ts).
// Без плана телефон — только международная запись: «+» или «%2B», затем от 8 до 15 цифр, первая не ноль. Префикс «00» не
// принимается: с ним телефоном стали бы id с ведущими нулями.
// С планом ещё номер с кодом страны без плюса, местный номер с разделителем и номер с местным префиксом.
// Шаблоны фильтра идут и в JS, и в RE2 хранилища: без просмотра вперёд и назад.

import { regional, type PhonePlan } from './regional.ts';

/** Телефон из значения поиска: все цифры (код страны и номер), национальный номер по плану и признак местной записи. */
export interface PhoneValue {
  digits: string;
  /** Национальный номер, если номер этой страны по плану; иначе null. */
  national: string | null;
  /** Записан без кода страны: местный номер или номер с местным префиксом. */
  local: boolean;
}

const WIDE_SPACE = /[\u00a0\u2007\u2009\u200a\u202f]/g;
const INTL = /^\(?(?:\+|%2[Bb])\)?[ ]?\(?([1-9](?:[ ()-]{0,3}\d){7,14})$/;
const E164_MIN = 8;
const E164_MAX = 15;

/** Группы номера по плану: заданные или одна группа на весь номер. */
const groupsOf = (plan: PhonePlan): readonly number[] => plan.groups ?? [plan.nationalDigits];

/** Тело национального номера для разбора значения: группы, разделитель после первой обязателен или нет. */
function nationalSource(plan: PhonePlan, firstRequired: boolean): string {
  const groups = groupsOf(plan);
  if (groups.length === 1) {
    // Без групп разделитель допустим между любыми цифрами.
    return `(\\d(?:[ ()-]{0,3}\\d){${plan.nationalDigits - 1}})`;
  }
  return groups.map((g, i) => `(\\d{${g}})${i === groups.length - 1 ? '' : i === 0 ? (firstRequired ? '[ ()-]{1,3}' : '[ ()-]{0,3}') : '[ -]?'}`).join('');
}

const quote = (s: string) => s.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');

interface PlanRes {
  full: RegExp;
  local: RegExp;
  trunk: RegExp | null;
}

let planCache: { plan: PhonePlan; res: PlanRes } | null = null;

function planRes(plan: PhonePlan): PlanRes {
  if (planCache?.plan === plan) return planCache.res;
  const cc = quote(plan.countryCode);
  const res: PlanRes = {
    full: new RegExp(`^\\(?\\+?${cc}[ ()-]{0,3}${nationalSource(plan, false)}$`),
    local: new RegExp(`^\\(?${nationalSource(plan, true)}$`),
    trunk: plan.trunkPrefix ? new RegExp(`^${quote(plan.trunkPrefix)}[ ()-]{0,2}${nationalSource(plan, true)}$`) : null,
  };
  planCache = { plan, res };
  return res;
}

const digitsOf = (m: RegExpExecArray) => m.slice(1).join('').replace(/\D/g, '');
/** Местная запись без групп: без хотя бы одного разделителя это просто число. */
const hasSeparator = (s: string) => /[ ()-]/.test(s.replace(/^\(/, ''));

/** Телефон из значения поиска; null — не телефон. Девять и десять цифр подряд без кода страны — текст. */
export function parsePhone(raw: string, plan: PhonePlan | null = regional().phone): PhoneValue | null {
  const v = raw.trim().replace(WIDE_SPACE, ' ');
  if (plan) {
    const r = planRes(plan);
    const full = r.full.exec(v);
    if (full) return { digits: plan.countryCode + digitsOf(full), national: digitsOf(full), local: false };
    const single = groupsOf(plan).length === 1;
    const local = r.local.exec(v);
    if (local && (!single || hasSeparator(v))) return { digits: plan.countryCode + digitsOf(local), national: digitsOf(local), local: true };
    const trunk = r.trunk?.exec(v);
    if (trunk && (!single || hasSeparator(v.slice(plan.trunkPrefix!.length).trim()))) return { digits: plan.countryCode + digitsOf(trunk), national: digitsOf(trunk), local: true };
  }
  const intl = INTL.exec(v);
  if (!intl) return null;
  const digits = intl[1]!.replace(/\D/g, '');
  if (digits.length < E164_MIN || digits.length > E164_MAX) return null;
  // Номер страны плана другой длины — опечатка, а не телефон.
  if (plan && digits.startsWith(plan.countryCode)) return null;
  return { digits, national: null, local: false };
}

/** Национальный номер из цифр телефона по плану; null — номер не этой страны. */
export function nationalOf(digits: string, plan: PhonePlan | null = regional().phone): string | null {
  if (!plan || !digits.startsWith(plan.countryCode) || digits.length !== plan.countryCode.length + plan.nationalDigits) return null;
  return digits.slice(plan.countryCode.length);
}

/**
 * Шаблон из цифр и классов `\d`: части — цифры или `\d`. С планом и номером его длины — группы плана, разделитель после первой
 * шире; иначе разделитель допустим между любыми цифрами.
 */
function shapeSource(parts: readonly string[], plan: PhonePlan | null): string {
  const groups = plan && parts.length === plan.nationalDigits ? groupsOf(plan) : null;
  if (!groups || groups.length === 1) return parts.join('[ ()-]{0,2}');
  let out = '';
  let at = 0;
  groups.forEach((g, i) => {
    out += parts.slice(at, at + g).join('');
    at += g;
    if (i < groups.length - 1) out += i === 0 ? '[ ()-]{0,3}' : '[ -]?';
  });
  // Серия классов внутри группы короче счётчиком: \d\d\d → \d{3}.
  return out.replace(/(?:\\d){2,}/g, (m) => `\\d{${m.length / 2}}`);
}

/**
 * Шаблон фильтра по цифрам телефона: один на все написания. Номер страны плана ищется по национальному номеру, код страны
 * и префикс перед ним могут быть любыми; другой номер — всеми цифрами с разделителями.
 */
export function phonePattern(digits: string, plan: PhonePlan | null = regional().phone): string {
  if (!/^\d{4,15}$/.test(digits)) throw new Error('phonePattern: нужны цифры телефона');
  const national = nationalOf(digits, plan);
  return shapeSource([...(national ?? digits)], national === null ? null : plan);
}

/** Шаблон по последним четырём цифрам: остальные цифры любые, разделители те же. */
export function phoneTailPattern(digits: string, plan: PhonePlan | null = regional().phone): string {
  const national = nationalOf(digits, plan);
  const own = national ?? digits;
  const parts = [...own].map((d, i) => (i < own.length - 4 ? '\\d' : d));
  const shape = shapeSource(parts, national === null ? null : plan);
  // Перед национальным номером граница, код страны или местный префикс: «07700 900001» пишется без разделителя после 0.
  if (national === null) return `\\b${shape}\\b`;
  const trunk = plan!.trunkPrefix ? `|\\b${quote(plan!.trunkPrefix)}` : '';
  return `(?:\\b|${quote(plan!.countryCode)}[ -]?\\(?${trunk})${shape}\\b`;
}

/** Цифр в национальном номере плана, если значение из одних цифр этой длины; для решения о ссылке. */
export function isNationalDigits(v: string, plan: PhonePlan | null = regional().phone): boolean {
  return plan !== null && /^\d+$/.test(v) && v.length === plan.nationalDigits;
}
