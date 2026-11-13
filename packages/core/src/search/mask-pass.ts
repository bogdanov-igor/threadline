// Второй проход: поля видов маски, образцы значений и форматы маски поверх первого прохода masking.ts.
// Первый проход его не видит: ошибка здесь не откроет номер карты или секрет. Таблица видов — mask-kinds.ts.
// Просмотр идёт от головы с любым именем, имя сверяется с набором: время не зависит от числа полей.

import { sha1 } from '../catalog/sha1.ts';
import { luhnValid } from '../luhn.ts';
import type { ViewRecord } from './api.ts';
import { isMaskKind, MASK_KIND_CODES, MASK_KINDS, type MaskKind, type MaskViewer } from './mask-kinds.ts';
import { plainDigits } from './mask-markup.ts';
import {
  BS_OPEN,
  CARD_FIELD_NAMES,
  CDATA_PLAIN,
  closeFinder,
  ENC_ATTRS,
  ENC_COLON,
  ENC_GT,
  ENC_LT,
  ENC_LT_ANY,
  encodedOpenEnd,
  encodedRes,
  ENT_OPEN,
  ENT_QUOTE_ANY,
  HIDDEN,
  isAuthName,
  isPanName,
  isSecretName,
  mapArray,
  maskPan,
  NUM,
  P25,
  pairValue,
  PCT_OPEN,
  PCT_QUOTE_ANY,
  plainArray,
  plainClose,
  replaceKeyValues,
  type Family,
  type Groups,
  type KeyValue,
} from './masking.ts';
import { maskSecretForms, nameBefore, secretEnd, type SecretForms } from './mask-secret-forms.ts';
import { jsPattern, PATTERN_KINDS, regional, regionalVersion, type PatternKind, type PhonePlan } from './regional.ts';

const normCache = /*#__PURE__*/ new Map<string, string>();

/** Нормальная форма имени: нижний регистр, без «_» и «-», без префикса XML и начального x-. */
export function normalizeFieldName(name: string): string {
  const hit = normCache.get(name);
  if (hit !== undefined) return hit;
  const n = name
    .slice(name.lastIndexOf(':') + 1)
    .replace(/^x-/i, '')
    .replace(/[\s_-]/g, '')
    .toLowerCase();
  if (normCache.size < 8192) normCache.set(name, n);
  return n;
}

export interface MaskPolicy {
  fields: ReadonlyMap<string, MaskKind>;
  /** Какие виды скрываются: образцы значений работают только у них. */
  kinds: ReadonlySet<MaskKind>;
}

export interface CompiledMasking {
  /** Обычные поля записи, сводки, разметка, хранимые данные: включённые по умолчанию и включённые вручную. */
  strict: MaskPolicy;
  /** Поле open: strict без выключенных видов. У зрителя ещё без того, что открыто ему сразу: viewerMasking. */
  shown: MaskPolicy;
  /** Что хранится в базе («Неизвестное»): strict и все остальные виды, включая выключенные по умолчанию. */
  stored: MaskPolicy;
  /** Отпечаток настройки: браузер по нему узнаёт о правке. */
  stamp: string;
}

/** Настройка для одного зрителя: показ скрытого и маска короткой ссылки решаются одной настройкой. */
export interface ViewerMasking extends CompiledMasking {
  viewer: MaskViewer;
  /** Ответ показа: включённые виды, которые этому зрителю не открыты. */
  reveal: MaskPolicy;
  /** Включённые виды, которые открывает глазок этому зрителю. */
  eye: ReadonlySet<MaskKind>;
  /** Что менять в первом проходе при показе. Кто открывает секреты, тот открывает и номер: тест таблицы. */
  opensCards: boolean;
  opensSecrets: boolean;
}

export interface MaskingRowLike {
  type: string;
  enabled: boolean;
  keys: readonly string[];
}

/** Первый проход сам владеет этими именами: сравнивать их второй раз незачем. */
export function firstPassKind(name: string): 'secrets' | 'card_number' | null {
  if (isSecretName(name) || isAuthName(name)) return 'secrets';
  return isPanName(name) ? 'card_number' : null;
}

const placeholderIndex = (): ReadonlyMap<string, MaskKind> => new Map(MASK_KIND_CODES.flatMap((k) => (MASK_KINDS[k].placeholders ?? []).map((p): [string, MaskKind] => [normalizeFieldName(p), k])));
// Пометка чистого вызова: неиспользуемая таблица не остаётся в сборке браузера. Главный чанк ограничен потолком, bundle.test.ts.
const PLACEHOLDERS = /*#__PURE__*/ placeholderIndex();

/** Вид подстановки справочника без поля в словаре. Голого account в полях нет: у коммутатора карт это массив с суммами. */
export function placeholderKind(name: string, strict: MaskPolicy): MaskKind | null {
  const kind = PLACEHOLDERS.get(normalizeFieldName(name));
  return kind && strict.kinds.has(kind) ? kind : null;
}

/** Встроенные имена номера: правило значения у них первого прохода, значение другой формы остаётся открытым. */
const CARD_BUILTIN = /*#__PURE__*/ new Set(CARD_FIELD_NAMES.map(normalizeFieldName));

/** Битая строка не роняет настройку: непонятное значение считается как отсутствующее. */
export function keysOf(row: MaskingRowLike | undefined): string[] {
  return Array.isArray(row?.keys) ? row.keys.filter((k): k is string => typeof k === 'string') : [];
}

function enabledOf(kind: MaskKind, row: MaskingRowLike | undefined): boolean {
  const def = MASK_KINDS[kind];
  // У вида с замком значение строки не действует, даже если в базе его поправили вручную.
  if (!def.switchable) return true;
  return typeof row?.enabled === 'boolean' ? row.enabled : def.defaultEnabled;
}

/**
 * Вид без строки в состоянии по умолчанию и без добавленных полей; строка вида, которого код не знает, пропускается.
 * Выключенный по умолчанию вид, пока он выключен, в strict не входит: иначе e-mail стал бы маской в заголовках.
 */
export function compileMasking(rows: readonly MaskingRowLike[]): CompiledMasking {
  const byKind = new Map<MaskKind, MaskingRowLike>();
  for (const r of rows) if (r && typeof r.type === 'string' && isMaskKind(r.type)) byKind.set(r.type, r);
  const enabled = new Set(MASK_KIND_CODES.filter((k) => enabledOf(k, byKind.get(k))));
  const active = new Set(MASK_KIND_CODES.filter((k) => enabled.has(k) || MASK_KINDS[k].defaultEnabled));
  const fields = new Map<string, MaskKind>();
  for (const k of active) for (const f of MASK_KINDS[k].fields) fields.set(normalizeFieldName(f), k);
  const canonical: unknown[] = [];
  for (const k of MASK_KIND_CODES) {
    const keys = keysOf(byKind.get(k));
    const sorted = [...new Set(keys.map(normalizeFieldName))].sort();
    canonical.push([k, enabled.has(k), sorted]);
    if (!active.has(k)) continue;
    // Поле, стоявшее в строке до обновления: побеждает встроенное поле включённого вида. Имя первого прохода туда не идёт, кроме имени
    // номера у самого номера: шифротекст первый проход не скроет, а правка обещает «значение другой формы — ***».
    for (const key of keys) {
      const n = normalizeFieldName(key);
      const first = firstPassKind(key);
      if (!fields.has(n) && (first === null || (first === 'card_number' && k === first && !CARD_BUILTIN.has(n)))) fields.set(n, k);
    }
  }
  const shown = new Map([...fields].filter(([, k]) => enabled.has(k)));
  const stored = new Map(fields);
  for (const k of MASK_KIND_CODES) for (const f of MASK_KINDS[k].fields) if (!stored.has(normalizeFieldName(f))) stored.set(normalizeFieldName(f), k);
  return { strict: { fields, kinds: active }, shown: { fields: shown, kinds: enabled }, stored: { fields: stored, kinds: new Set(MASK_KIND_CODES) }, stamp: sha1(JSON.stringify(canonical)) };
}

/** Состояния по умолчанию: справочник выключен, настройки не существует. Он же параметр по умолчанию и проверка записей. */
export const BUILTIN_MASKING: CompiledMasking = /*#__PURE__*/ compileMasking([]);

/** Настройка неизвестна (база недоступна, данных нет) и живая выборка: включены все виды. */
export const ALL_KINDS_MASKING: CompiledMasking = /*#__PURE__*/ compileAllKinds();

function compileAllKinds(): CompiledMasking {
  return compileMasking(MASK_KIND_CODES.map((type) => ({ type, enabled: true, keys: [] })));
}

function narrowed(p: MaskPolicy, keep: (k: MaskKind) => boolean): MaskPolicy {
  return { fields: new Map([...p.fields].filter(([, k]) => keep(k))), kinds: new Set([...p.kinds].filter(keep)) };
}

const viewerCache = /*#__PURE__*/ new WeakMap<CompiledMasking, Map<MaskViewer, ViewerMasking>>();

/** Настройка глазами зрителя. Читает только таблицу видов: смена решения о виде меняет одну её строку. */
export function viewerMasking(masking: CompiledMasking, viewer: MaskViewer): ViewerMasking {
  let cached = viewerCache.get(masking);
  if (!cached) viewerCache.set(masking, (cached = new Map()));
  const hit = cached.get(viewer);
  if (hit) return hit;
  const opens = (k: MaskKind) => MASK_KINDS[k].eye.includes(viewer);
  const atOnce = (k: MaskKind) => MASK_KINDS[k].atOnce.includes(viewer);
  const out: ViewerMasking = {
    strict: masking.strict,
    stored: masking.stored,
    stamp: masking.stamp,
    viewer,
    // Ссылка: выключенный вид считается включённым, поэтому поля open нет ни при какой настройке.
    shown: viewer === 'link' ? masking.strict : narrowed(masking.shown, (k) => !atOnce(k)),
    reveal: narrowed(masking.shown, (k) => !opens(k) && !atOnce(k)),
    eye: new Set([...masking.shown.kinds].filter(opens)),
    opensCards: opens('card_number'),
    opensSecrets: opens('secrets'),
  };
  cached.set(viewer, out);
  return out;
}

// ---------- Форматы маски ----------

const OWN_PHONE_MASK = /^[+*\s()-]*\*[*\s()-]*(?:\d[\s()-]*){0,4}$/;
const OWN_NATIONAL_ID_MASK = /^\*{2,}[A-Za-z0-9]{4}$/;
const OWN_PASSPORT_MASK = /^[A-Z]{0,2}\*{1,12}[A-Z0-9]{2}$/;
const OWN_NAME_MASK = /^\p{L}\*{5}(?:\s+\p{L}\*{5})*$/u;
const OWN_ACCOUNT_MASK = /^[*\s-]*\*[*\s-]*(?:\d[\s-]*){0,4}$/;
const OWN_EMAIL_MASK = /^[^\s*]\*{5}(?:@|%(?:25)*40)[A-Za-z0-9.-]+$/;
const OWN_CARD_MASK = /^\d{6}\*{2,9}\d{4}$/;
const PHONE_SHAPE = /^[+\d\s()-]+$/;
// Паспорт: до двух букв серии, затем номер из букв и цифр. Цифр хотя бы две: слово под именем поля паспортом не считается.
const PASSPORT_SHAPE = /^([A-Z]{1,2}(?=[ -]?[A-Z0-9]*\d))?[ -]?([A-Z0-9]{3,12})$/;
// Личный номер: от 6 до 20 букв и цифр, разделители между ними. Цифр хотя бы две.
const NATIONAL_ID_SHAPE = /^[A-Za-z0-9](?:[A-Za-z0-9]|[ ./-](?=[A-Za-z0-9])){5,40}$/;
const OWN_IBAN_MASK = /^[A-Z]{2}[*\s]*\*[*\s]*(?:[A-Z0-9]\s*){0,4}$/;
const NAME_WORDS = /^\p{L}[\p{L}\p{M}'’.-]*(?:\s+\p{L}[\p{L}\p{M}'’.-]*)*$/u;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGITS_SHAPE = /^[\d\s-]+$/;
const CARD_MASK_SHAPE = /^\d{6}\*{2,}\d{4}$/;
// Значение Authorization, которое уже прошёл первый проход: схема и маска.
const AUTH_MASKED = /^(?:basic|bearer|digest)(?:[\s+:]|%(?:25)*20|\\+[nrt]){0,4}\*\*\*$/i;
const EMAIL_SHAPE = /^([^\s@%]{1,64})(@|%(?:25)*40)([A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,8})$/;

function maskPhoneDigits(v: string): string {
  const total = (v.match(/\d/g) ?? []).length;
  let i = 0;
  return v.replace(/\d/g, (d) => (i++ < total - 4 ? '*' : d));
}

/** IBAN: две буквы страны, две контрольные цифры, от 11 до 30 букв и цифр; контрольное число по модулю 97. */
export function ibanValid(compact: string): boolean {
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(compact)) return false;
  const moved = compact.slice(4) + compact.slice(0, 4);
  let rest = 0;
  for (const ch of moved) {
    const code = ch.charCodeAt(0);
    const value = code >= 65 ? String(code - 55) : ch;
    for (const d of value) rest = (rest * 10 + Number(d)) % 97;
  }
  return rest === 1;
}

/** IBAN под маской: буквы страны и последние четыре знака открыты, разделители на месте. */
function maskIban(v: string): string {
  const total = (v.match(/[A-Z0-9]/g) ?? []).length;
  let i = 0;
  return v.replace(/[A-Z0-9]/g, (c) => (i++ < 2 || i > total - 4 ? c : '*'));
}

const digitCount = (v: string) => (v.match(/\d/g) ?? []).length;

const firstLetterWords = (v: string) => (NAME_WORDS.test(v) ? v.split(/\s+/).map((w) => `${[...w][0]}*****`).join(' ') : HIDDEN);

/** Маска значения вида. Форма не узнана — ***; своя готовая маска не меняется. */
export function formatKind(kind: MaskKind, raw: string): string {
  const v = raw.trim();
  if (v === HIDDEN) return raw;
  switch (kind) {
    case 'phone': {
      if (OWN_PHONE_MASK.test(v)) return raw;
      return PHONE_SHAPE.test(v) && (v.match(/\d/g) ?? []).length >= 7 ? maskPhoneDigits(v) : HIDDEN;
    }
    case 'national_id': {
      if (OWN_NATIONAL_ID_MASK.test(v)) return raw;
      const plain = v.replace(/[ ./-]/g, '');
      return NATIONAL_ID_SHAPE.test(v) && plain.length <= 20 && digitCount(plain) >= 2 ? `${'*'.repeat(plain.length - 4)}${plain.slice(-4)}` : HIDDEN;
    }
    case 'passport': {
      if (OWN_PASSPORT_MASK.test(v)) return raw;
      const m = PASSPORT_SHAPE.exec(v);
      if (!m || digitCount(v) < 2) return HIDDEN;
      const num = m[2]!;
      return `${m[1] ?? ''}${'*'.repeat(num.length - 2)}${num.slice(-2)}`;
    }
    case 'account_number': {
      // Uuid под именем счёта — внутренний id. Номер, уже прошедший первым проходом, теряет и первые 6 цифр.
      if (OWN_ACCOUNT_MASK.test(v) || OWN_IBAN_MASK.test(v) || UUID.test(v)) return raw;
      if (ibanValid(v.replace(/ /g, ''))) return maskIban(v);
      if (CARD_MASK_SHAPE.test(v)) return maskPhoneDigits(v);
      const digits = (v.match(/\d/g) ?? []).length;
      return DIGITS_SHAPE.test(v) && digits >= 8 && digits <= 34 ? maskPhoneDigits(v) : HIDDEN;
    }
    case 'card_number': {
      if (OWN_CARD_MASK.test(v)) return raw;
      const digits = v.replace(/\D/g, '');
      return DIGITS_SHAPE.test(v) && digits.length >= 12 && digits.length <= 19 ? maskPan(digits) : HIDDEN;
    }
    case 'surname':
    case 'first_name':
      return OWN_NAME_MASK.test(v) ? raw : firstLetterWords(v);
    case 'email': {
      if (OWN_EMAIL_MASK.test(v)) return raw;
      const m = EMAIL_SHAPE.exec(v);
      return m ? `${[...m[1]!][0]}*****${m[2]}${m[3]}` : HIDDEN;
    }
    case 'address':
      return IPV4.test(v) ? raw : HIDDEN;
    case 'secrets':
      return AUTH_MASKED.test(v) ? raw : HIDDEN;
    case 'card_data':
    case 'card_token':
    case 'birth_date':
      return HIDDEN;
  }
}

/** Значение поля вида: пустое значением не считается. */
function fieldValue(type: MaskKind, raw: string, hits: Set<MaskKind> | null): string {
  if (raw.trim() === '') return raw;
  const m = formatKind(type, raw);
  if (m !== raw) hits?.add(type);
  return m;
}

// Быстрый отбор имён: в тексте их сотни тысяч, разбор имени по частям нужен единицам.
const SECRET_HINT = /pass|pin|cv[vc]|secret|token|cookie|api|pan|auth/i;

/** Имя в записи, которую первый проход не разобрал: другая форма или элемент внутри тега номера карты. Поле вида важнее. */
function fieldOf(name: string, policy: MaskPolicy): MaskKind | undefined {
  return policy.fields.get(normalizeFieldName(name)) ?? (policy.kinds.has('secrets') && SECRET_HINT.test(name) && firstPassKind(name) === 'secrets' ? 'secrets' : undefined);
}

/** Имя номера, которое первый проход в этой записи не узнал: card__number, "Card Number". Значение другой формы остаётся: правило поля номера. */
const isOpenCardName = (name: string, policy: MaskPolicy) => policy.kinds.has('card_number') && /pan|card|primary|rcard/i.test(name) && firstPassKind(name) === 'card_number';

function cardDigits(raw: string, hits: Set<MaskKind> | null): string {
  const digits = raw.replace(/\D/g, '');
  if (!DIGITS_SHAPE.test(raw.trim()) || digits.length < 12 || digits.length > 19) return raw;
  hits?.add('card_number');
  return maskPan(digits);
}

// ---------- Проход по тексту ----------

const R = String.raw;

interface Regexps {
  keys: Record<Family, RegExp>;
  xml: RegExp;
  xmlEnc: RegExp;
  pairSep: RegExp;
  header: RegExp;
  headerEnd: RegExp;
  headerBreak: RegExp;
  bareEndPlain: RegExp;
  bareEndEnc: RegExp;
  accountPath: RegExp;
  iban: RegExp;
  cardToken: RegExp;
  cardGroups: RegExp;
  cardSplit: RegExp;
  emailAt: RegExp;
  emailDomain: RegExp;
}

let compiled: Regexps | null = null;

/** Выражения общие, компилируются при первом вызове: политика меняет только набор имён. */
function regexps(): Regexps {
  if (compiled) return compiled;
  const head = (open: string, colon: string, bracket: string) =>
    new RegExp(R`${open}(?<key>[A-Za-z0-9_][\w.: -]{0,63})\k<q>(?<sep>${colon})(?:(?<vq>\k<q>)|(?<num>${NUM})(?![\w.])|(?<br>${bracket}))`, 'gi');
  const pairStop = R`&|\\+u0026|[\r\n"<]|\\+[rnt"]|[\s+](?=[\w.-]{1,64}(?:=|%(?:25)*3[Dd]))`;
  compiled = {
    keys: {
      bs: head(BS_OPEN, R`\s*:\s*`, R`[\[{]`),
      ent: head(ENT_OPEN, ENC_COLON, R`[\[{]`),
      pct: head(PCT_OPEN, ENC_COLON, R`[\[{]|%${P25}(?:5[Bb]|7[Bb])`),
    },
    xml: /<(?<name>(?:[\w.-]+:)?(?<key>[A-Za-z0-9_][\w.-]{0,63}))(?<attrs>\s[^<>]*)?>/g,
    xmlEnc: new RegExp(R`(?<lt>${ENC_LT})(?<name>(?:[\w.-]+(?::|%${P25}3[Aa]))?(?<key>[A-Za-z0-9_][\w.-]{0,63}))(?<attrs>${ENC_ATTRS})?(?<gt>${ENC_GT})`, 'gi'),
    pairSep: new RegExp(R`=>?|%(?:25){0,4}3[Dd]|&(?:amp;){0,4}#0*61;|\\u003[Dd]`, 'g'),
    header: /(?:[\r\n]|\\+[rn])(?<name>[A-Za-z][\w-]{0,63})[ \t]*:[ \t]*/g,
    headerEnd: /[\r\n"]|\\+[rn"]/g,
    headerBreak: /\r\n?|\n|\\+r(?:\\+n)?|\\+n/y,
    bareEndPlain: new RegExp(pairStop, 'g'),
    bareEndEnc: new RegExp(R`%(?:25)*26|${pairStop}`, 'g'),
    // IBAN слитно или группами по четыре через пробел; контрольное число проверяет ibanValid.
    iban: /[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?(?![A-Za-z0-9])/g,
    // Сегмент пути и за ним серия цифр; номер, уже скрытый первым проходом, тоже. Косая черта бывает экранированной и в %2F.
    accountPath: new RegExp(R`accounts?(?<sep>\\*/|%${P25}2[Ff])(?<value>\d{8,34}|\d{6}\*{2,24}\d{4})(?![\w-])`, 'gi'),
    cardToken: /\d{6}[A-Za-z]{6}\d{4}(?![A-Za-z0-9])/g,
    // Номер группами с разделителем, которого нет у первого прохода: 4111.1112.3455.7893, &nbsp;, <br>. Разделитель один на весь номер:
    // иначе под образец попадают время и версии, а цепочка групп дальше конца номера (IPv6) номером не считается.
    cardGroups: new RegExp(R`(?<!\d)\d{4}(?<s>[./_:,*\u2009\u202f\u2013\u2014\u200b\n]|\r\n| {4,8}|\\+[nrt]|%${P25}(?:2[DdFfEe]|[Cc]2%${P25}[Aa]0)|&(?:amp;)?(?:nbsp|#160|#[xX][aA]0);|<br\s*/?>|</\w+>\s*<\w+>)\d{4}\k<s>\d{4}\k<s>\d{4}(?:\k<s>\d{1,3})?(?!\d|\k<s>\d)`, 'g'),
    cardSplit: /(?<![\d.])(?:\d{8} \d{8}|\d{6} \d{10}|\d{4} \d{6} \d{6})(?![\d.])/g,
    emailAt: new RegExp(R`@|%${P25}40`, 'g'),
    emailDomain: /[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,8}/y,
  };
  return compiled;
}

// ---------- Региональные правила: план номеров и образцы видов ----------

interface RegionalRes {
  version: number;
  /** Номер страны плана с кодом страны, с плюсом и без. */
  planPhone: RegExp | null;
  /** Образцы видов из раздела regional. */
  patterns: ReadonlyMap<PatternKind, readonly RegExp[]>;
  /** Код страны плана: быстрый отбор текста. */
  countryCode: string | null;
}

// Международная запись: «+» или %2B, затем от 8 до 15 цифр, первая не ноль. Цифры без плюса телефоном не считаются.
const E164 = /(\+|%2[Bb])(\(?[1-9](?:[ \u00a0()-]{0,2}\d){7,14})(?![\w-]|\.[\w])/g;

let regionalCompiled: RegionalRes | null = null;

/** Национальный номер плана для текста: скобки вокруг первой группы, один разделитель между группами. */
function planNational(plan: PhonePlan): string {
  const groups = plan.groups ?? [plan.nationalDigits];
  if (groups.length === 1) return `\\(?\\d\\)?(?:[ \\u00a0.-]?\\d){${plan.nationalDigits - 1}}`;
  return groups.map((g, i) => (i === 0 ? `\\(?\\d{${g}}\\)?` : `[ \\u00a0.-]?\\d{${g}}`)).join('');
}

function regionalRes(): RegionalRes {
  const version = regionalVersion();
  if (regionalCompiled?.version === version) return regionalCompiled;
  const r = regional();
  const plan = r.phone;
  const cc = plan ? plan.countryCode : null;
  const patterns = new Map<PatternKind, RegExp[]>();
  for (const k of PATTERN_KINDS) {
    const list: RegExp[] = [];
    for (const source of r.patterns[k] ?? []) {
      const js = jsPattern(source);
      // Справа от совпадения не буква и не цифра: движок сам пробует следующее начало, а не обрывает серию.
      if (js) list.push(new RegExp(`(?:${js.source})(?![A-Za-z0-9])`, js.flags));
    }
    if (list.length > 0) patterns.set(k, list);
  }
  regionalCompiled = {
    version,
    planPhone: plan ? new RegExp(`(?:\\+|00)?\\(?\\+?${cc}\\)?[ \\u00a0.-]?${planNational(plan)}(?![\\w-]|\\.[\\w])`, 'g') : null,
    patterns,
    countryCode: cc,
  };
  return regionalCompiled;
}

/** Вид, образец которого из раздела regional совпал со значением целиком; null — ни один. */
export function regionalMatch(value: string, kinds: readonly PatternKind[]): PatternKind | null {
  const res = regionalRes();
  for (const k of kinds) {
    for (const re of res.patterns.get(k) ?? []) {
      re.lastIndex = 0;
      const m = re.exec(value);
      if (m && m.index === 0 && m[0].length === value.length) return k;
    }
  }
  return null;
}

function maskKeys(s: string, family: Family, policy: MaskPolicy, hits: Set<MaskKind> | null): string {
  return replaceKeyValues(s, regexps().keys[family], family, (g: Groups, v: KeyValue) => {
    const type = fieldOf(g.key!, policy);
    const q = g.q!;
    if (!type) {
      if ((v.kind !== 'str' && v.kind !== 'num') || !isOpenCardName(g.key!, policy)) return null;
      const raw = v.kind === 'str' ? v.str : v.text;
      const m = cardDigits(raw, hits);
      return m === raw ? null : `${q}${m}${q}`;
    }
    const hidden = () => {
      hits?.add(type);
      return `${q}${HIDDEN}${q}`;
    };
    switch (v.kind) {
      case 'str': {
        const m = fieldValue(type, v.str, hits);
        return m === v.str ? null : `${q}${m}${q}`;
      }
      case 'open':
        if (v.str.trim() === '') return null;
        hits?.add(type);
        return `${q}${HIDDEN}`;
      case 'num':
        return `${q}${fieldValue(type, v.text, hits)}${q}`;
      default: {
        const body = v.text.slice(g.br!.length, v.text.length - v.close);
        if (v.close > 0 && /^(?:\s|%(?:25)*(?:20|0[9AaDd]))*$/.test(body)) return null;
        if (v.kind === 'arr' && !v.nested && v.close > 0 && plainArray(body, g, family)) {
          const tail = v.text.slice(v.text.length - v.close);
          return g.br! + mapArray(body, g, family, (x) => fieldValue(type, x, hits), (n) => fieldValue(type, n, hits)) + tail;
        }
        return hidden();
      }
    }
  });
}

/** Содержимое элемента под именем поля: вложенный элемент — *** целиком, CDATA раскрывается. */
function tagValue(type: MaskKind, content: string, cdata: RegExp, nestedMark: string, hits: Set<MaskKind> | null): string {
  if (content.trim() === '') return content;
  const c = cdata.exec(content);
  if (c && !c[2]!.includes(']]>')) {
    const inner = fieldValue(type, c[2]!, hits);
    return inner === c[2] ? content : inner;
  }
  if (content.includes(nestedMark)) {
    hits?.add(type);
    return HIDDEN;
  }
  return fieldValue(type, content, hits);
}

function maskXml(s: string, policy: MaskPolicy, hits: Set<MaskKind> | null): string {
  const re = regexps().xml;
  let out = '';
  let last = 0;
  re.lastIndex = 0;
  for (let m = re.exec(s); m !== null; m = re.exec(s)) {
    const g = m.groups as Groups;
    if (g.attrs?.endsWith('/')) continue;
    const type = fieldOf(g.key!, policy);
    if (!type) continue;
    const from = m.index + m[0].length;
    const c = plainClose(s, from, g.name!, Infinity);
    const at = c ? c.at : s.length;
    const content = s.slice(from, at);
    const masked = tagValue(type, content, CDATA_PLAIN, '<', hits);
    if (masked !== content) {
      out += s.slice(last, from) + masked;
      last = at;
    }
    re.lastIndex = c ? c.end : s.length;
  }
  return last === 0 ? s : out + s.slice(last);
}

function maskXmlEncoded(s: string, policy: MaskPolicy, hits: Set<MaskKind> | null): string {
  const re = regexps().xmlEnc;
  const closeAfter = closeFinder(s);
  let out = '';
  let last = 0;
  re.lastIndex = 0;
  for (let m = re.exec(s); m !== null; m = re.exec(s)) {
    const g = m.groups as Groups;
    if (g.attrs && /(?:\/|%(?:25)*2f)$/i.test(g.attrs)) continue;
    const type = fieldOf(g.key!, policy);
    if (!type) continue;
    const from = m.index + m[0].length;
    const { close, cdata } = encodedRes(g.lt!, g.gt!, g.name!);
    const c = closeAfter(close, from);
    const at = c ? c.index : encodedOpenEnd(s, from, g.lt!);
    const content = s.slice(from, at);
    const masked = tagValue(type, content, cdata, g.lt!, hits);
    if (masked !== content) {
      out += s.slice(last, from) + masked;
      last = at;
    }
    re.lastIndex = c ? c.index + c[0].length : at;
  }
  return last === 0 ? s : out + s.slice(last);
}

// Кавычка внутри значения без кавычек открывается перед буквой или цифрой и закрывается на той же строке: `address=ул."Примерная-77" 1`.
const VALUE_START = /[\p{L}\p{N}]/u;
const MAX_INNER_QUOTE = 1024;

/** Конец такой кавычки; -1 — это не она, значение на ней кончается. */
function pastInnerQuote(t: string, quote: string, at: number): number {
  if (!VALUE_START.test(t[at] ?? '')) return -1;
  const w = t.slice(at, at + MAX_INNER_QUOTE);
  const close = w.indexOf(quote);
  return close < 0 || /[\r\n]/.test(w.slice(0, close)) ? -1 : at + close + quote.length;
}

const LITERAL = /^(?:null|true|false)$/;
// Пробелы вокруг знака пары, в том числе экранированные: <a password\n=\n"S"/> в строке JSON.
const SECRET_GAP_BEFORE = /(?:\s|\\+[nrt]){1,8}$/;
const SECRET_GAP_AFTER = /(?:\s|\\+[nrt]){1,8}/y;

function maskPairs(s: string, policy: MaskPolicy, hits: Set<MaskKind> | null): string {
  const r = regexps();
  const re = r.pairSep;
  const bareEnd = (stop: RegExp) => (t: string, at: number) => {
    stop.lastIndex = at;
    for (let e = stop.exec(t); e !== null; e = stop.exec(t)) {
      if (!e[0].endsWith('"')) return e.index;
      const past = pastInnerQuote(t, e[0], e.index + e[0].length);
      if (past < 0) return e.index;
      stop.lastIndex = past;
    }
    return t.length;
  };
  let out = '';
  let last = 0;
  re.lastIndex = 0;
  for (let m = re.exec(s); m !== null; m = re.exec(s)) {
    let head = nameBefore(s, m.index);
    let type = head ? fieldOf(head.name, policy) : undefined;
    if (!type) {
      // С пробелами вокруг знака: только у секрета, значения других видов так не распознаются.
      const gap = SECRET_GAP_BEFORE.exec(s.slice(Math.max(0, m.index - 16), m.index));
      head = gap ? nameBefore(s, m.index - gap[0].length) : null;
      type = head && fieldOf(head.name, policy) === 'secrets' ? 'secrets' : undefined;
    }
    if (!type || !head) continue;
    const secret = type === 'secrets';
    let at = m.index + m[0].length;
    if (secret || m[0] === '=>') {
      SECRET_GAP_AFTER.lastIndex = at;
      at += SECRET_GAP_AFTER.exec(s)?.[0].length ?? 0;
    }
    const encoded = m[0].includes('%');
    const v = pairValue(s, at, head.cq, secret ? secretEnd(encoded) : bareEnd(encoded ? r.bareEndEnc : r.bareEndPlain));
    if (v === null) continue;
    const inner = v.inner.trim();
    let masked: string;
    if (v.kind === 'bare' && (inner === '' || LITERAL.test(inner) || (secret && isAuthName(head.name)))) {
      re.lastIndex = Math.max(re.lastIndex, v.end);
      continue;
    }
    if (v.kind === 'open' || v.kind === 'bracket') {
      hits?.add(type);
      masked = HIDDEN;
    } else masked = fieldValue(type, v.inner, hits);
    if (masked !== v.inner || v.kind === 'open' || v.kind === 'bracket') {
      out += s.slice(last, at) + v.open + masked + v.close;
      last = v.end;
    }
    re.lastIndex = v.end;
  }
  return last === 0 ? s : out + s.slice(last);
}

/** Конец значения заголовка: продолжение на следующей строке начинается с пробела, кавычка внутри значения его не обрывает. */
function headerValueEnd(s: string, at: number, r: Regexps): number {
  const end = r.headerEnd;
  end.lastIndex = at;
  for (let e = end.exec(s); e !== null; e = end.exec(s)) {
    if (e[0].endsWith('"')) {
      const past = pastInnerQuote(s, e[0], e.index + e[0].length);
      if (past < 0) return e.index;
      end.lastIndex = past;
      continue;
    }
    r.headerBreak.lastIndex = e.index;
    const next = e.index + (r.headerBreak.exec(s)?.[0].length ?? e[0].length);
    if (s[next] !== ' ' && s[next] !== '\t') return e.index;
    end.lastIndex = next;
  }
  return s.length;
}

function maskHeaders(s: string, policy: MaskPolicy, hits: Set<MaskKind> | null): string {
  const r = regexps();
  const re = r.header;
  let out = '';
  let last = 0;
  re.lastIndex = 0;
  for (let m = re.exec(s); m !== null; m = re.exec(s)) {
    const type = fieldOf(m.groups!.name!, policy);
    if (!type) continue;
    const at = m.index + m[0].length;
    const end = headerValueEnd(s, at, r);
    const value = s.slice(at, end);
    const masked = fieldValue(type, value, hits);
    if (masked !== value) {
      out += s.slice(last, at) + masked;
      last = end;
    }
    re.lastIndex = Math.max(end, re.lastIndex);
  }
  return last === 0 ? s : out + s.slice(last);
}

const AFTER_ESCAPE = /(?:%[0-9A-Fa-f]{2}|\\u[0-9A-Fa-f]{4}|\\[nrt])$/;
const afterEscape = (s: string, at: number) => AFTER_ESCAPE.test(s.slice(Math.max(0, at - 6), at));

const EMAIL_LOCAL_CHAR = /[A-Za-z0-9._+-]/;
const MAX_EMAIL_LOCAL = 64;

/** Локальная часть перед @: просмотр назад ограничен. Буквы и цифры %XX и \\uXXXX перед ней в неё не входят. */
function emailLocalStart(s: string, at: number): number {
  let start = at;
  while (start > 0 && at - start < MAX_EMAIL_LOCAL && EMAIL_LOCAL_CHAR.test(s[start - 1]!)) start--;
  if (start === at) return -1;
  const before = s[start - 1];
  const run = s.slice(start, at);
  const skipped = before === '%' ? /^(?:25){0,4}[0-9A-Fa-f]{2}/.exec(run) : before === '\\' ? /^(?:u[0-9A-Fa-f]{4}|[nrt])/.exec(run) : null;
  const from = start + (skipped?.[0].length ?? 0);
  return from < at ? from : -1;
}

/** E-mail в тексте и адресе: первая буква и домен. Адрес без домена с точкой не узнаётся; учётные данные адреса скрыл первый проход. */
function maskEmails(s: string, keep: ReadonlySet<string>, hits: Set<MaskKind> | null): string {
  const r = regexps();
  let out = '';
  let last = 0;
  r.emailAt.lastIndex = 0;
  for (let m = r.emailAt.exec(s); m !== null; m = r.emailAt.exec(s)) {
    const from = emailLocalStart(s, m.index);
    if (from < 0 || from < last) continue;
    const domainAt = m.index + m[0].length;
    r.emailDomain.lastIndex = domainAt;
    const domain = r.emailDomain.exec(s);
    if (!domain) continue;
    const whole = s.slice(from, domainAt + domain[0].length);
    if (keep.has(whole)) continue;
    hits?.add('email');
    out += `${s.slice(last, from)}${s[from]}*****${m[0]}${domain[0]}`;
    last = domainAt + domain[0].length;
    r.emailAt.lastIndex = last;
  }
  return last === 0 ? s : out + s.slice(last);
}

// Перед номером — имя поля номера: проверка Луна там не нужна, как и у первого прохода.
const PAN_BEFORE = /(?:pan|rcard|card[_-]?(?:number|no)|primary[_-]?account[_-]?number)["'\]]?\s*(?:[=:]|%(?:25)*3[DdAa])\s*["']?$/i;

/** Номер с разделителем, которого нет у первого прохода: края открыты, разделители на месте. */
function maskCardGroups(s: string, keep: ReadonlySet<string>, hits: Set<MaskKind> | null): string {
  const r = regexps();
  const masked = (m: string, sep: string, at: number, t: string): string => {
    // Цепочка групп дальше начала номера: IPv6, а не номер.
    if (at > sep.length && t.startsWith(sep, at - sep.length) && /\d/.test(t[at - sep.length - 1]!)) return m;
    const parts = m.split(sep);
    const all = parts.join('');
    const named = PAN_BEFORE.test(t.slice(Math.max(0, at - 40), at));
    const total = !named && !luhnValid(all) && all.length > 16 && luhnValid(all.slice(0, 16)) ? 16 : all.length;
    if (keep.has(all) || (!named && !luhnValid(all.slice(0, total)))) return m;
    hits?.add('card_number');
    let n = 0;
    return parts.map((p) => [...p].map((d) => (n++ >= 6 && n <= total - 4 ? '*' : d)).join('')).join(sep);
  };
  const out = s.replace(r.cardGroups, (...args: unknown[]) => masked(args[0] as string, (args[args.length - 1] as Groups).s!, args[args.length - 3] as number, args[args.length - 2] as string));
  return out.replace(r.cardSplit, (m: string, at: number, t: string) => masked(m, ' ', at, t));
}

/** Слева от образца: не цифра, не дробная часть и не блок id. Буква и «_» не мешают: U447700900102, id_447700900102. */
function leftNumber(t: string, at: number): boolean {
  if (at === 0 || afterEscape(t, at)) return true;
  const prev = t[at - 1]!;
  if (/\d/.test(prev)) return false;
  if (prev === '.') return !/\d/.test(t[at - 2] ?? '');
  // Хвост uuid и других id из блоков, конец длинной шестнадцатеричной строки.
  if (prev === '-') return !/[0-9a-fA-F]{4}-$/.test(t.slice(Math.max(0, at - 5), at));
  return !/[0-9a-fA-F]{8}$/.test(t.slice(Math.max(0, at - 8), at));
}

/** Быстрый отбор текста для образцов телефона: плюс, %2B или код страны плана. */
const mayHavePhone = (text: string, res: RegionalRes) => text.includes('+') || text.includes('%2') || (res.countryCode !== null && text.includes(res.countryCode)) || res.patterns.has('phone');

/** Телефоны в тексте теми же образцами и той же проверкой слева, что у маски: границы [начало, конец). Страница из лога ищет так телефон, разбитый тегами. */
export function phonesIn(text: string): [number, number][] {
  const res = regionalRes();
  if (!mayHavePhone(text, res)) return [];
  const found: [number, number][] = [];
  if (res.planPhone) for (const m of text.matchAll(res.planPhone)) if (leftNumber(text, m.index)) found.push([m.index, m.index + m[0].length]);
  for (const m of text.matchAll(E164)) if (leftNumber(text, m.index)) found.push([m.index, m.index + m[0].length]);
  for (const re of res.patterns.get('phone') ?? []) for (const [a, b] of regionalHits(text, re)) found.push([a, b]);
  found.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const out: [number, number][] = [];
  for (const r of found) if (out.length === 0 || r[0] >= out[out.length - 1]![1]) out.push(r);
  return out;
}

/** Перед образцом с буквами нет заглавной и цифры: TXN1234567 — код, а не паспорт XN1234567; строчная не мешает: passportAA0000123. */
const leftUpper = (t: string, at: number) => at === 0 || !/[A-Z0-9]/.test(t[at - 1]!) || afterEscape(t, at);
/** Граница слева для образца раздела regional: с цифры — как у числа, с буквы — как у кода. */
const leftClear = (t: string, at: number, m: string) => (/^\d/.test(m) ? leftNumber(t, at) : leftUpper(t, at));
/** Граница справа: за совпадением не буква и не цифра. */
const rightClear = (t: string, end: number) => !/[A-Za-z0-9]/.test(t[end] ?? '');

/** Образец внутри значения из keep: id `U447700900102` открыт целиком, значит и номер в нём. */
function insideKept(t: string, at: number, length: number, keep: ReadonlySet<string>): boolean {
  if (keep.size === 0) return false;
  let a = at;
  let b = at + length;
  while (a > 0 && at - a < 128 && /[\w.:-]/.test(t[a - 1]!)) a--;
  while (b < t.length && b - at < 128 && /[\w.:-]/.test(t[b]!)) b++;
  return keep.has(t.slice(a, b));
}

/** Образцы вида из раздела regional: маска по формату вида, значения из keep открыты. */
/** Совпадения образца с границами слева и справа. Отклонённое совпадение не съедает текст: следующее начало — со второго символа. */
function regionalHits(t: string, re: RegExp): [number, number][] {
  const out: [number, number][] = [];
  re.lastIndex = 0;
  for (let m = re.exec(t); m !== null; m = re.exec(t)) {
    const end = m.index + m[0].length;
    if (m[0] === '' || !leftClear(t, m.index, m[0]) || !rightClear(t, end)) {
      re.lastIndex = m.index + 1;
      continue;
    }
    out.push([m.index, end]);
  }
  return out;
}

function maskRegional(out: string, kind: PatternKind, res: RegionalRes, keep: ReadonlySet<string>, hits: Set<MaskKind> | null): string {
  for (const re of res.patterns.get(kind) ?? []) {
    const found = regionalHits(out, re);
    if (found.length === 0) continue;
    let next = '';
    let last = 0;
    for (const [a, b] of found) {
      const m = out.slice(a, b);
      if (keep.has(m) || keep.has(m.replace(/\D/g, '')) || insideKept(out, a, m.length, keep)) continue;
      const masked = kind === 'phone' && (m.match(/\d/g) ?? []).length >= 7 ? maskPhoneDigits(m) : formatKind(kind, m);
      if (masked === m) continue;
      hits?.add(kind);
      next += out.slice(last, a) + masked;
      last = b;
    }
    if (last > 0) out = next + out.slice(last);
  }
  return out;
}

function maskPatterns(s: string, policy: MaskPolicy, keep: ReadonlySet<string>, hits: Set<MaskKind> | null): string {
  const r = regexps();
  const res = regionalRes();
  let out = s;
  const digits = (m: string) => m.replace(/\D/g, '');
  if (policy.kinds.has('card_number')) out = maskCardGroups(out, keep, hits);
  if (policy.kinds.has('account_number')) {
    if (/account/i.test(out)) {
      out = out.replace(r.accountPath, (m: string, ...rest: unknown[]) => {
        const g = rest[rest.length - 1] as Groups;
        const at = rest[rest.length - 3] as number;
        const left = at === 0 || !/[\w-]/.test(out[at - 1]!) || afterEscape(out, at);
        if (!left || keep.has(g.value!)) return m;
        hits?.add('account_number');
        return m.slice(0, m.length - g.value!.length) + maskPhoneDigits(g.value!);
      });
    }
    if (/[A-Z]{2}\d{2}/.test(out)) {
      out = out.replace(r.iban, (m, at: number, t: string) => {
        const compact = m.replace(/ /g, '');
        if (!leftUpper(t, at) || !ibanValid(compact) || keep.has(m) || keep.has(compact) || insideKept(t, at, m.length, keep)) return m;
        hits?.add('account_number');
        return maskIban(m);
      });
    }
    out = maskRegional(out, 'account_number', res, keep, hits);
  }
  if (policy.kinds.has('card_token')) {
    out = out.replace(r.cardToken, (m, at: number, t: string) => {
      if (!leftUpper(t, at) || keep.has(m) || insideKept(t, at, m.length, keep)) return m;
      hits?.add('card_token');
      return HIDDEN;
    });
  }
  if (policy.kinds.has('phone') && mayHavePhone(out, res)) {
    if (res.planPhone) {
      out = out.replace(res.planPhone, (m, at: number, t: string) => {
        if (!leftNumber(t, at) || keep.has(m) || keep.has(digits(m)) || insideKept(t, at, m.length, keep)) return m;
        hits?.add('phone');
        return maskPhoneDigits(m);
      });
    }
    out = out.replace(E164, (m, prefix: string, number: string, at: number, t: string) => {
      if (!leftNumber(t, at) || keep.has(m) || keep.has(digits(number)) || insideKept(t, at, m.length, keep)) return m;
      hits?.add('phone');
      return prefix + maskPhoneDigits(number);
    });
    out = maskRegional(out, 'phone', res, keep, hits);
  }
  if (policy.kinds.has('national_id')) out = maskRegional(out, 'national_id', res, keep, hits);
  if (policy.kinds.has('passport')) out = maskRegional(out, 'passport', res, keep, hits);
  if (policy.kinds.has('email') && (out.includes('@') || out.includes('%'))) out = maskEmails(out, keep, hits);
  return out;
}

// Имя в соседнем поле того же объекта, в любом порядке: {"value":"S","name":"password"}, {"type":"token","value":"S"}, [{"k":"Authorization","v":"S"}].
const FLAT_OBJECT = /\{[^{}]{2,4096}\}/g;
const NAMED_HINT = /pass|pwd|pin|cv[vc]|secret|token|cookie|key|auth|pan|card|otp|jwt|session/i;
const NAME_FIELD = /^(?:name|key|field|type|k|n|param|parameter|header|attribute)$/i;
const VALUE_FIELD = /^(?:value|val|v|content)$/i;

/** Секрет или номер по имени из соседнего поля. Остальные виды так не распознаются: это известное ограничение. */
function namedKind(name: string, policy: MaskPolicy): 'secrets' | 'card_number' | null {
  const own = policy.fields.get(normalizeFieldName(name));
  if (own) return own === 'secrets' || own === 'card_number' ? own : null;
  if (fieldOf(name, policy) === 'secrets') return 'secrets';
  return isOpenCardName(name, policy) ? 'card_number' : null;
}

function maskNamedObject(obj: string, family: Family, policy: MaskPolicy, hits: Set<MaskKind> | null): string {
  const re = regexps().keys[family];
  let kind: 'secrets' | 'card_number' | null = null;
  replaceKeyValues(obj, re, family, (g, v) => {
    if (kind === null && v.kind === 'str' && NAME_FIELD.test(g.key!)) kind = namedKind(v.str, policy);
    return null;
  });
  if (kind === null) return obj;
  const named: 'secrets' | 'card_number' = kind;
  return replaceKeyValues(obj, re, family, (g, v) => {
    if (!VALUE_FIELD.test(g.key!) || (v.kind !== 'str' && v.kind !== 'num')) return null;
    const raw = v.kind === 'str' ? v.str : v.text;
    const m = named === 'card_number' ? cardDigits(raw, hits) : fieldValue('secrets', raw, hits);
    return m === raw ? null : `${g.q}${m}${g.q}`;
  });
}

function maskNamedObjects(s: string, policy: MaskPolicy, hits: Set<MaskKind> | null): string {
  return s.replace(FLAT_OBJECT, (obj) => {
    if (!NAMED_HINT.test(obj)) return obj;
    const out = obj.includes('"') ? maskNamedObject(obj, 'bs', policy, hits) : obj;
    return ENT_QUOTE_ANY.test(out) ? maskNamedObject(out, 'ent', policy, hits) : out;
  });
}

// Маска числа в JSON: без кавычек тело перестаёт разбираться и теряет форматирование.
const BARE_MASK = /(\\*")(\s*:\s*)(\+?[\d*]*\*[\d*]*)(?=\s*[,}\]])/g;

/** Текст: поля видов, затем образцы. Значения из keep образец не трогает, по именам полей keep не действует. */
export function maskKindsText(s: string, policy: MaskPolicy, keep: ReadonlySet<string>, hits: Set<MaskKind> | null = null): string {
  if (s === '') return s;
  // Цифры сущностями и \uXXXX браузер покажет цифрами: образец телефона или личного номера должен их узнать.
  let out = plainDigits(s);
  if (out.includes('{') && (policy.kinds.has('secrets') || policy.kinds.has('card_number'))) out = maskNamedObjects(out, policy, hits);
  if (out.includes('"')) out = maskKeys(out, 'bs', policy, hits);
  if (ENT_QUOTE_ANY.test(out)) out = maskKeys(out, 'ent', policy, hits);
  if (PCT_QUOTE_ANY.test(out)) out = maskKeys(out, 'pct', policy, hits);
  if (out.includes('<')) out = maskXml(out, policy, hits);
  if (ENC_LT_ANY.test(out)) out = maskXmlEncoded(out, policy, hits);
  out = maskPairs(out, policy, hits);
  if (/[\r\n]|\\[rn]/.test(out)) out = maskHeaders(out, policy, hits);
  if (policy.kinds.has('secrets')) out = maskSecretForms(out, secretFormsOf(policy, hits));
  out = maskPatterns(out, policy, keep, hits);
  return out.includes('*') && out.includes('"') ? out.replace(BARE_MASK, '$1$2$1$3$1') : out;
}

function secretFormsOf(policy: MaskPolicy, hits: Set<MaskKind> | null): SecretForms {
  return { isSecret: (name) => fieldOf(name, policy) === 'secrets', hide: (raw) => fieldValue('secrets', raw, hits) };
}

// ---------- Обход объекта ----------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function setKey(o: Obj, k: string, v: unknown): void {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
}

function numberPattern(n: number, policy: MaskPolicy, keep: ReadonlySet<string>, hits: Set<MaskKind> | null): number | string {
  // 20 цифр числом под образцом счёта из раздела regional: число уже округлено при разборе, хвост не настоящий.
  if (n >= 1e19 && n < 1e20 && policy.kinds.has('account_number') && regionalMatch(String(n), ['account_number'])) {
    hits?.add('account_number');
    return HIDDEN;
  }
  if (!Number.isSafeInteger(n) || n < 1e11) return n;
  const s = String(n);
  const m = maskPatterns(s, policy, keep, hits);
  return m === s ? n : m;
}

function fieldDeep(type: MaskKind, v: unknown, hits: Set<MaskKind> | null): unknown {
  if (typeof v === 'string') return fieldValue(type, v, hits);
  if (typeof v === 'number') return fieldValue(type, String(v), hits);
  if (Array.isArray(v)) {
    if (v.length === 0) return v;
    if (v.some((x) => typeof x === 'object' && x !== null)) {
      hits?.add(type);
      return HIDDEN;
    }
    return v.map((x) => fieldDeep(type, x, hits));
  }
  if (isObj(v)) {
    if (Object.keys(v).length === 0) return v;
    hits?.add(type);
    return HIDDEN;
  }
  return v;
}

/** Содержимое записи: заголовки, payload, контекст. Имена сравниваются, сами имена и числа смотрит образец. */
export function maskKindsDeep(v: unknown, policy: MaskPolicy, keep: ReadonlySet<string>, hits: Set<MaskKind> | null = null): unknown {
  if (typeof v === 'string') return maskKindsText(v, policy, keep, hits);
  if (typeof v === 'number') return numberPattern(v, policy, keep, hits);
  if (Array.isArray(v)) return v.map((x) => maskKindsDeep(x, policy, keep, hits));
  if (isObj(v)) {
    const out: Obj = {};
    const named = namedOf(v, policy);
    for (const [k, x] of Object.entries(v)) {
      const type = policy.fields.get(normalizeFieldName(k));
      const key = maskPatterns(k, policy, keep, hits);
      if (named && VALUE_FIELD.test(k)) setKey(out, key, named === 'card_number' && typeof x === 'string' ? cardDigits(x, hits) : named === 'card_number' ? maskKindsDeep(x, policy, keep, hits) : fieldDeep('secrets', x, hits));
      else setKey(out, key, type ? fieldDeep(type, x, hits) : maskKindsDeep(x, policy, keep, hits));
    }
    return out;
  }
  return v;
}

/** Вид значения объекта по имени в соседнем поле: {type:'token',value:'S'}. Сам объект первый проход читает только с name и key. */
function namedOf(o: Obj, policy: MaskPolicy): 'secrets' | 'card_number' | null {
  for (const [k, x] of Object.entries(o)) {
    if (typeof x !== 'string' || !NAME_FIELD.test(k)) continue;
    const kind = namedKind(x, policy);
    if (kind) return kind;
  }
  return null;
}

/** Служебные поля ответа: их проход не трогает. */
const ENVELOPE_SKIP: ReadonlySet<string> = new Set(['id', 'tsNs', 'pairId', 'firstRecordId', 'correlationId', 'requestId', 'cid', 'kind', 'type']);

/** Конверт: только проход по тексту, имена его собственных полей не сравниваются и не меняются. */
export function maskKindsEnvelope<T>(v: T, policy: MaskPolicy, keep: ReadonlySet<string>): T {
  const walk = (x: unknown): unknown => {
    if (typeof x === 'string') return maskKindsText(x, policy, keep);
    if (Array.isArray(x)) return x.map(walk);
    if (isObj(x)) {
      const out: Obj = {};
      for (const [k, y] of Object.entries(x)) setKey(out, k, ENVELOPE_SKIP.has(k) ? y : walk(y));
      return out;
    }
    return x;
  };
  return walk(v) as T;
}

// ---------- Запись ----------

/** Содержимое записи без разметки: ответ показа и поле open. */
export interface OpenContent {
  uri: string | null;
  sections: ViewRecord['sections'];
  raw: string;
}

export interface OpenRecord extends OpenContent {
  id: string;
}

function contentOf(r: ViewRecord, policy: MaskPolicy, keep: ReadonlySet<string>, hits: Set<MaskKind> | null): OpenContent {
  const s = r.sections;
  return {
    uri: r.http?.uri ? maskKindsText(r.http.uri, policy, keep, hits) : (r.http?.uri ?? null),
    sections: {
      headers: maskKindsDeep(s.headers, policy, keep, hits),
      body: s.body === null ? null : maskKindsText(s.body, policy, keep, hits),
      payload: maskKindsDeep(s.payload, policy, keep, hits),
      context: maskKindsDeep(s.context, policy, keep, hits) as ViewRecord['sections']['context'],
    },
    raw: maskKindsText(r.raw, policy, keep, hits),
  };
}

/**
 * Запись после базовой маски: все обычные поля строгие, в hits — виды, которые маска действительно скрыла в содержимом.
 * Значение выключенного вида приходит только полем open: браузер сам строит итог шага и подсказки из обычных полей.
 */
export function maskKindsRecord(r: ViewRecord, masking: CompiledMasking, keep: ReadonlySet<string>): { record: ViewRecord; hits: Set<MaskKind> } {
  const hits = new Set<MaskKind>();
  const content = contentOf(r, masking.strict, keep, hits);
  const record: ViewRecord = {
    ...r,
    title: maskKindsText(r.title, masking.strict, keep),
    message: maskKindsText(r.message, masking.strict, keep),
    component: r.component === null ? null : maskKindsText(r.component, masking.strict, keep),
    http: r.http ? { ...r.http, uri: content.uri } : null,
    sections: content.sections,
    raw: content.raw,
  };
  if (r.catalog) record.catalog = maskKindsEnvelope(r.catalog, masking.strict, keep);
  if (r.flow) record.flow = maskKindsEnvelope(r.flow, masking.strict, keep);
  if ([...hits].some((t) => !masking.shown.kinds.has(t))) record.open = contentOf(r, masking.shown, keep, null);
  return { record, hits };
}

/** Ответ показа: запись после первого прохода зрителя и прохода по видам, которые ему не открыты. Только содержимое, без разметки. */
export function openRecordOf(r: ViewRecord, reveal: MaskPolicy, keep: ReadonlySet<string>): OpenRecord {
  return { id: r.id, ...contentOf(r, reveal, keep, null) };
}
