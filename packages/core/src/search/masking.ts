// Базовое маскирование.
// Выражения без вложенных неограниченных квантификаторов; уровни экранирования и просмотр значения ограничены:
// строка в несколько мегабайт проходит за линейное время.
import { luhnValid } from '../luhn.ts';
import { maskSplitCards } from './mask-markup.ts';

export const SECRET_KEYS: ReadonlySet<string> = new Set([
  'cardholderpassword',
  'password',
  'passwd',
  'pin',
  'pinblock',
  'cvv',
  'cvv2',
  'cvc',
  'cvc2',
  'encrypted_pan',
  'secret',
  'access_token',
  'refresh_token',
  'id_token',
  'client_secret',
]);

/** Поля с номером карты: маскируются 12–19 цифр без проверки Луна. */
export const PAN_KEYS: ReadonlySet<string> = new Set([
  'primaryaccountnumber',
  'rcard',
  'pan',
  'cardnumber',
  'card_number',
]);

export const HIDDEN = '***';

// Одно правило имени для ключа JSON, тега, пары и обхода объекта. Части имени — через «_», «-», «.» и границу camelCase,
// префикс XML отброшен; совпадает хвост из частей: my_app_client_secret, user-pin, spring.datasource.password, accessToken.
// У password и passwd — любой префикс (newpassword). password_expired, token_type и spin — другие имена.
const compact = (keys: Iterable<string>) => [...keys].map((k) => k.replace(/_/g, ''));
const SECRET_TAILS: ReadonlySet<string> = new Set([
  ...compact(SECRET_KEYS),
  'pincode', 'cvvcode', 'cvv2code', 'cvccode', 'cvc2code',
  'token', 'accesstoken', 'refreshtoken', 'idtoken', 'authtoken', 'csrftoken',
  'clientsecret', 'cookie', 'apikey',
]);
const PAN_TAILS: ReadonlySet<string> = new Set([...compact(PAN_KEYS), 'pannumber', 'cardno']);
const MAX_NAME_PARTS = 4;

type NameKind = 'secret' | 'pan' | 'auth' | null;
const nameCache = new Map<string, NameKind>();

function classifyName(name: string): NameKind {
  const hit = nameCache.get(name);
  if (hit !== undefined) return hit;
  const local = name.slice(name.lastIndexOf(':') + 1);
  const parts = local
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[\s_.-]+/)
    .filter((x) => x !== '');
  const tail = (set: ReadonlySet<string>) => {
    for (let k = 1; k <= Math.min(MAX_NAME_PARTS, parts.length); k++) if (set.has(parts.slice(-k).join(''))) return true;
    return false;
  };
  let kind: NameKind = null;
  if (/authorization$/i.test(local) && /^[a-z0-9_.-]*$/i.test(local)) kind = 'auth';
  else if (/pass(?:word|wd)$/i.test(local) || tail(SECRET_TAILS)) kind = 'secret';
  else if (tail(PAN_TAILS)) kind = 'pan';
  if (nameCache.size < 4096) nameCache.set(name, kind);
  return kind;
}

export const isSecretName = (name: string): boolean => classifyName(name) === 'secret';
export const isPanName = (name: string): boolean => classifyName(name) === 'pan';
/** Заголовок с учётными данными: Authorization и родственные имена (Proxy-Authorization, X-Authorization, headers.Authorization). */
export const isAuthName = (name: string): boolean => classifyName(name) === 'auth';

/** Имена вида «Секреты» для раздела «Маскирование». masking-freeze.test.ts сверяет их с SECRET_TAILS и classifyName в обе стороны. */
export const SECRET_FIELD_NAMES: readonly string[] = [
  'cardholderPassword', 'password', 'passwd',
  'pin', 'pin_block', 'pin_code',
  'cvv', 'cvv2', 'cvc', 'cvc2', 'cvv_code', 'cvv2_code', 'cvc_code', 'cvc2_code',
  'encrypted_pan', 'secret', 'client_secret',
  'token', 'access_token', 'refresh_token', 'id_token', 'auth_token', 'csrf_token', 'card_token',
  'cookie', 'api_key', 'Authorization',
];
/** Имена вида «Номер карты» для раздела «Маскирование». Та же сверка с PAN_TAILS и classifyName. */
export const CARD_FIELD_NAMES: readonly string[] = ['primaryAccountNumber', 'rcard', 'pan', 'card_number', 'pan_number', 'card_no'];

// Открытый номер при скрытых секретах. Сопоставление то же, меняется только то, что
// пишется: флаг читают точки выдачи номера. Ставится синхронно и снимается в finally, только в maskDeepOpeningCards.
let openingCards = false;
// Номер действительно скрыт: для списка «есть что показать». На то, что пишется, не влияет.
let cardHidden = false;

function hiddenDigit(): string {
  cardHidden = true;
  return '*';
}

/** Маска номера: первые 6, звёздочки, последние 4. */
export function maskPan(digits: string): string {
  return digits.slice(0, 6) + '*'.repeat(Math.max(digits.length - 10, 0)) + digits.slice(-4);
}

/** Точка выдачи номера целиком в проходе по записи. maskPan остаётся чистой функцией: её зовёт и terms.ts. */
function panOut(digits: string): string {
  if (openingCards) return digits;
  cardHidden = true;
  return maskPan(digits);
}

// Цифры %XX, \uXXXX и &#NN; — запись другого символа, а не часть номера.
const DIGIT_OR_PCT = /%(?:25)*[0-9A-Fa-f]{2}|\\u[0-9A-Fa-f]{4}|&#\w{1,8};|\d/g;

/** Цифры номера с разделителями. */
function digitsOf(s: string): string {
  return (s.match(DIGIT_OR_PCT) ?? []).filter((x) => x.length === 1).join('');
}

/** Номер с разделителями: звёздочки вместо цифр, кроме первых 6 и последних 4; разделители на месте. total — цифр в номере, остальные видны. */
function maskPanGrouped(s: string, total = digitsOf(s).length): string {
  if (openingCards) return s;
  let n = 0;
  return s.replace(DIGIT_OR_PCT, (d) => {
    if (d.length > 1) return d;
    const i = n++;
    return i < 6 || i >= total - 4 ? d : hiddenDigit();
  });
}

/** Значение под именем номера: 12–19 цифр с любыми разделителями маскируются по счёту, иначе — серии цифр. */
function maskPanAny(s: string): string {
  if (openingCards) return s;
  const total = digitsOf(s).length;
  return total >= 12 && total <= 19 ? maskPanGrouped(s, total) : maskDigitRuns(s);
}

const R = String.raw;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Просмотр от открывающей кавычки или скобки ограничен: иначе у каждого уровня экранирования свой просмотр до конца
// строки. Предел — только на просмотр: значение, которому не хватило предела, скрывается до конца текста.
const MAX_SCAN = 8192;
const SCAN = `[\\s\\S]{0,${MAX_SCAN}}?`;
// %25 (повторный percent-encoding) и amp; (повторные сущности) ограничены: без предела у каждого открытия своя
// запись кавычки, и просмотр от каждого идёт до конца строки — O(n·√n). Серия \ у bs не ограничена: разных
// уровней в строке длины n не больше √(2n), а просмотр от каждого ограничен MAX_SCAN; счётчик {0,15} у V8
// вдвое медленнее *.
export const P25 = '(?:25){0,4}';
export const AMP = '(?:amp;){0,4}';
/** JSON в JSON внутри текста XML или строки Go и .NET: уровни 0–3. */
const BSL_ENT = R`\\{0,7}`;
/** Пробелы в percent-encoding и form-urlencoded (+, %20, %09, %0A, %0D) и экранированные в строке JSON (\n). */
export const WS_ENC = R`(?:\s|\+|%${P25}(?:20|0[9AaDd])|\\{1,16}[nrt])*`;

// Ключи JSON встречаются в трёх семействах записи кавычки — столько слоёв раскрывает браузер (format.ts, extractNested):
// - bs: обратные косые черты " \" \\\" … — JSON в строке JSON;
// - ent: сущность XML (&quot; &amp;quot; &#34; &#034; &#x22;), в том числе после \ (JSON в JSON в тексте XML),
//   и \u0022 или \u0026quot; — строка JSON от .NET или Go;
// - pct: percent-encoding (%22 %2522 %5C%22) — JSON в значении form-urlencoded.
// Группы всех семейств: q — кавычка целиком, b — экранирование перед ней (\ или %5C), tail — пары экранирования
// в конце значения перед закрывающей кавычкой, p — %25 у pct.
export type Family = 'bs' | 'ent' | 'pct';

// Просмотр назад не даёт начинать внутри серии косых черт: иначе длинная серия разбирается за квадрат.
export const BS_OPEN = R`(?<!\\)(?<q>(?<b>\\*)")`;
// Числовая ссылка XML — только с x строчной: &#X22; браузер (format.ts, decodeEntities) не раскрывает.
const ENT_Q = R`${AMP}(?:quot|#0?34|#x0{0,2}22);`;
// У \u0022 и \u0026quot; первая черта — часть уровня: экранированная кавычка .NET — \\\u0022, как \\\" у уровня 1.
export const ENT_OPEN = R`(?<!\\)(?<q>(?<b>${BSL_ENT})(?:&${ENT_Q}|(?<=\\)u00(?:26${ENT_Q}|22)))`;
// Закрывающую кавычку ищет closeOf. С k чертами перед кавычкой литеральная \ в значении — 2k+2 черты,
// экранированная " — 2k+1 черта и ". Значение кончается только на целых группах по 2k+2 черты и ровно k чертах и ":
// \" внутри значения его не обрывает, а \\ в конце значения не продлевает.
// У pct все %XX одной кавычки закодированы одинаково: %25 берётся у самой кавычки (p).
const PCT_LB = R`(?<!%${P25}5[Cc])`;
export const PCT_OPEN = R`${PCT_LB}(?=(?:%${P25}5[Cc]){0,15}%(?<p>${P25})22)(?<q>(?<b>(?:%\k<p>5[Cc]){0,15})%\k<p>22)`;
export const ENC_COLON = R`${WS_ENC}(?::|%${P25}3[Aa])${WS_ENC}`;
export const ENT_QUOTE_ANY = /&(?:amp;)*(?:quot|#0*34|#x0*22);|\\u00(?:22|26)/i;
export const PCT_QUOTE_ANY = /%(?:25)*22/;

// Число в массиве: не часть слова, %XX или &#NN; — перед ним может стоять экранированный перевод строки,
// %2C, %20, %0A или %5B.
// Запятая в списке: и в percent-encoding, и с экранированными пробелами.
const LIST_COMMA = R`(?:\s|\\+[nrt])*(?:,|%${P25}2[Cc])(?:\s|\\+[nrt])*`;

const NUM_ELEM = R`(?:(?<=%${P25}(?:2[Cc]|20|0[9AaDd]|5[Bb]))|(?<!(?<!\\)[A-Za-z0-9_]|[.%#&-]))-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?(?![\w.])`;

interface KeyRules {
  secret: RegExp;
  auth: RegExp;
  pan: RegExp;
  value: RegExp;
  /** Имя в значении: {"name":"password","value":"…"}. */
  named: RegExp;
  /** Плоский список заголовков: ["Authorization","…"]. */
  neighbour: RegExp;
}

export const NUM = R`-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?`;
// Кандидаты в именах: окончательно имя проверяет classifyName. Просмотр от кавычки или скобки ограничен длиной имени.
const NAME_PREFIX = R`[A-Za-z0-9_.-]{0,128}`;
const WS_ = '[_.-]?';
const SECRET_END = R`pass(?:word|wd)|pin(?:${WS_}(?:block|code))?|cv[vc]2?(?:${WS_}code)?|secret|token|cookie|api${WS_}key|encrypted${WS_}pan`;
const PAN_END = R`pan(?:${WS_}number)?|rcard|card${WS_}(?:number|no)|primary${WS_}account${WS_}number`;
const SECRET_ALT = `${NAME_PREFIX}(?:${SECRET_END})`;
const PAN_ALT = `${NAME_PREFIX}(?:${PAN_END})`;
const AUTH_ALT = `${NAME_PREFIX}authorization`;
const ANY_ALT = `${NAME_PREFIX}(?:${SECRET_END}|${PAN_END}|authorization)`;

function keyRules(open: string, colon: string, bracket: string): KeyRules {
  const sep = `(?<sep>${colon})`;
  // Строка: конец находит closeOf, объект или массив — bracketEnd.
  const vq = R`(?<vq>\k<q>)`;
  const br = `(?<br>${bracket})`;
  return {
    // Секреты: строка, число, массив или объект.
    secret: new RegExp(R`${open}(?<key>${SECRET_ALT})\k<q>${sep}(?:${vq}|(?<num>${NUM})|${br})`, 'gi'),
    // Заголовки с учётными данными: строка или массив строк.
    auth: new RegExp(R`${open}(?<key>${AUTH_ALT})\k<q>${sep}(?:${vq}|${br})`, 'gi'),
    pan: new RegExp(R`${open}(?<key>${PAN_ALT})\k<q>${sep}(?:${vq}|(?<num>-?\d{12,19}(?:\.\d+)?)(?![\d.])|${br})`, 'gi'),
    // Value в FilterCondition (выборка SOAP-процессинга): строкой или числом; другой регистр — только внутри FilterCondition (inFilter).
    value: new RegExp(R`${open}(?<key>Value)\k<q>${sep}(?:\k<q>(?<str>[\d\s./_+-]{12,64})\k<q>|(?<num>\d{12,19})(?![\d.]))`, 'gi'),
    named: new RegExp(R`${open}(?:name|key)\k<q>${colon}\k<q>(?<key>${ANY_ALT})\k<q>${LIST_COMMA}\k<q>value\k<q>${sep}(?:${vq}|(?<num>${NUM})|${br})`, 'gi'),
    neighbour: new RegExp(R`${open}(?<key>${ANY_ALT})\k<q>(?<sep>${LIST_COMMA})${vq}`, 'gi'),
  };
}

const BS_RULES = keyRules(BS_OPEN, R`\s*:\s*`, R`[\[{]`);
const ENT_RULES = keyRules(ENT_OPEN, ENC_COLON, R`[\[{]`);
const PCT_RULES = keyRules(PCT_OPEN, ENC_COLON, R`[\[{]|%${P25}(?:5[Bb]|7[Bb])`);

// Имя схемы — без учёта регистра (RFC 7235): bearer и BEARER скрываются так же, как Bearer.
// Разделитель — пробел, перевод строки, в том числе экранированный, + и %20 (form-urlencoded), «Bearer: значение».
const AUTH_WS = R`(?:\s|\\+[nrt]|\+|%${P25}(?:20|0[9AaDd]))`;
// Значение — до пробела, кавычки или конца: запятая, двоеточие и %XX внутри токена его не обрывают.
const AUTH_TOKEN = R`(?:[^\s"'<>\\&%]|%(?!${P25}(?:20|0[9AaDd]|22|26|27|3[Cc]))|\\(?![\\"nrt]))+`;
// Параметры Digest скрываются всем списком: username="u", realm="r", response="…", на любом уровне экранирования;
// кавычка без пары — до конца строки.
const DIGEST_PARAM = R`[\w-]+=(?:\\*"[^"\r\n]*(?:\\*")?|[^\s,"]+)`;
// Digest определяется захваченной схемой, без просмотра назад: тот у каждого пробела серии шёл бы к её началу.
const AUTH_SCHEME = new RegExp(
  R`(?<dg>Digest)(?<dsep>:?${AUTH_WS}+)${DIGEST_PARAM}(?:\s*,\s*${DIGEST_PARAM})*` +
    R`|(?<scheme>Basic|Bearer|Digest)(?<sep>:?${AUTH_WS}+)(?:(?<dq>\\*")(?=[^\s,:}\]\\"])${AUTH_TOKEN}|${AUTH_TOKEN})`,
  'gi',
);
const AUTH_SCHEME_ANY = /basic|bearer|digest/i;

// Учётные данные в адресе. Начало — схема и «//» или «//» без схемы; косые черты и двоеточие на любом уровне
// экранирования. Сами данные находит userinfoAt.
const URI_START = new RegExp(
  R`(?<=[A-Za-z0-9+.-])(?::|%${P25}3[Aa])(?:\\*/|%${P25}2[Ff]){2}|(?<![\w:/\\%.-])(?:\\*/){2}(?=[^\s/\\])`,
  'g',
);
const AT_SIGN = new RegExp(R`@|%${P25}40|&${AMP}#(?:0*64|x0*40);`, 'gi');
const AT_ANY = /@|%(?:25)*40|&(?:amp;)*#(?:0*64|x0*40);/i;
const COLON_ANY = new RegExp(R`:|%${P25}3[Aa]`);
const AUTHORITY_END = /[\s/?#"'<>\\]/g;
// В percent-encoding authority кончается и на %2F, %3F, %23, и на & следующего поля формы.
const AUTHORITY_END_PCT = new RegExp(R`[\s/?#&"'<>\\]|%${P25}(?:2[Ff]|3[Ff]|23)`, 'gi');
// Адрес без схемы: user:пароль@host, в пароле бывают «/», «@» и любая длина. Хост — чтобы не задеть текст вроде «a:b@».
const URI_BARE_HEAD = /(?<![\w.+:/@\\-])[\w.+-]{1,64}:(?!%(?:25)*2[Ff]|\*\*\*@|\\*\/\\*\/)/g;
const BARE_WORD_END = /[\s"'<>\\]/g;
const BARE_VALUE_END = /["\r\n]/g;
const BARE_HOST = /^[\w-]+(?:[.:/]|$)/;
const BARE_PORT = /^\d{1,5}[/?#]/;

/** Последний «@» в отрезке. */
function lastAt(s: string, from: number, to: number): number {
  const w = s.slice(from, to);
  let at = -1;
  AT_SIGN.lastIndex = 0;
  for (let m = AT_SIGN.exec(w); m !== null; m = AT_SIGN.exec(w)) at = from + m.index;
  return at;
}

const VALUE_END_PCT = /[&\s"]/g;
const QUOTE_RUN = /(?<!\\)(\\*)"/g;
const LINE_END = /[\r\n]/g;

/** Следующий «@» и конец последнего значения: кэш, чтобы адреса одной строки не просматривали её заново. */
interface AtCursor {
  next: number;
  /** Конец значения от valueFrom для уровня valueKey: предел просмотра не должен открывать значение. */
  valueKey: string;
  valueFrom: number;
  valueEnd: number;
}

/** Конец значения, в котором стоит адрес: кавычка того же уровня, что и перед схемой, или конец строки. */
function uriValueEnd(s: string, start: number, encoded: boolean, cur: AtCursor): number {
  let i = start;
  while (i > 0 && start - i < 32 && /[A-Za-z0-9+.-]/.test(s[i - 1]!)) i--;
  const before = encoded ? null : /(\\*)"$/.exec(s.slice(Math.max(0, i - 64), i));
  const key = encoded ? 'pct' : before ? `q${before[1]!.length}` : 'line';
  if (cur.valueKey === key && start >= cur.valueFrom && start < cur.valueEnd) return cur.valueEnd;
  let end = s.length;
  if (before) {
    const k = before[1]!.length;
    QUOTE_RUN.lastIndex = start;
    for (let m = QUOTE_RUN.exec(s); m !== null; m = QUOTE_RUN.exec(s)) {
      if (m[1]!.length <= k) {
        end = m.index;
        break;
      }
    }
  } else {
    const re = encoded ? VALUE_END_PCT : LINE_END;
    re.lastIndex = start;
    end = re.exec(s)?.index ?? s.length;
  }
  cur.valueKey = key;
  cur.valueFrom = start;
  cur.valueEnd = end;
  return end;
}

/**
 * Где кончаются учётные данные адреса: индекс последнего «@» части с хостом; -1 — их нет. В пароле бывают «@», «/», «?»,
 * «#», пробел и кавычки: у имени с двоеточием, после которого не порт, данные идут до последнего «@» значения.
 * host:8080/path?mail=a@b — порт, это не учётные данные.
 */
function userinfoAt(s: string, p: number, start: number, encoded: boolean, cur: AtCursor): number {
  const endRe = encoded ? AUTHORITY_END_PCT : AUTHORITY_END;
  endRe.lastIndex = p;
  const e = endRe.exec(s)?.index ?? s.length;
  const strict = lastAt(s, p, e);
  if (strict >= 0) return strict;
  const authority = s.slice(p, e);
  const colon = COLON_ANY.exec(authority);
  if (!colon || colon.index === 0 || authority.startsWith('[')) return -1;
  if (/^\d{1,5}$/.test(authority.slice(colon.index + colon[0].length))) return -1;
  // «@» сущностью начинается раньше конца authority: «#» в &#64; его и обрывает.
  if (cur.next < p) {
    AT_SIGN.lastIndex = p;
    cur.next = AT_SIGN.exec(s)?.index ?? Infinity;
  }
  if (cur.next === Infinity) return -1;
  const end = uriValueEnd(s, start, encoded, cur);
  return cur.next < end ? lastAt(s, p, end) : -1;
}

/** Адрес без схемы: от имени с двоеточием до последнего «@» слова; с пробелом в пароле — только если адрес начинает значение. */
function maskBareUserinfo(s: string): string {
  let out = '';
  let last = 0;
  let wordEnd = -1;
  let wordAt = -1;
  URI_BARE_HEAD.lastIndex = 0;
  for (let m = URI_BARE_HEAD.exec(s); m !== null; m = URI_BARE_HEAD.exec(s)) {
    // mailto: схема, а не имя пользователя: за ним адрес почты, а не пароль.
    if (m[0].toLowerCase() === 'mailto:') continue;
    const p = m.index + m[0].length;
    if (p >= wordEnd) {
      BARE_WORD_END.lastIndex = p;
      wordEnd = BARE_WORD_END.exec(s)?.index ?? s.length;
      wordAt = -1;
      for (let i = wordEnd - 1; i >= p; i--) {
        if (s[i] === '@') {
          wordAt = i;
          break;
        }
      }
    }
    let at = wordAt >= p ? wordAt : -1;
    if (at < 0 && p < s.length && !/\s/.test(s[p]!) && (m.index === 0 || s[m.index - 1] === '"')) {
      BARE_VALUE_END.lastIndex = p;
      const end = BARE_VALUE_END.exec(s)?.index ?? s.length;
      for (let i = end - 1; i >= wordEnd; i--) {
        if (s[i] === '@') {
          at = i;
          break;
        }
      }
    }
    if (at < 0 || BARE_PORT.test(s.slice(p, Math.min(at, p + 8))) || !BARE_HOST.test(s.slice(at + 1, at + 130))) continue;
    out += `${s.slice(last, m.index)}${HIDDEN}@`;
    last = at + 1;
    URI_BARE_HEAD.lastIndex = last;
  }
  return last === 0 ? s : out + s.slice(last);
}

/** Учётные данные адреса заменены на ***: scheme://***@host, ***@host. */
function maskUserinfo(s: string): string {
  if (!AT_ANY.test(s)) return s;
  const cur: AtCursor = { next: -1, valueKey: '', valueFrom: 0, valueEnd: 0 };
  let out = '';
  let last = 0;
  URI_START.lastIndex = 0;
  for (let m = URI_START.exec(s); m !== null; m = URI_START.exec(s)) {
    const p = m.index + m[0].length;
    const at = userinfoAt(s, p, m.index, m[0].includes('%'), cur);
    if (at < 0) continue;
    out += s.slice(last, p) + HIDDEN;
    last = at;
    URI_START.lastIndex = at;
  }
  const res = last === 0 ? s : out + s.slice(last);
  return res.includes(':') ? maskBareUserinfo(res) : res;
}

const URI_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

/**
 * Адрес без схемы и учётных данных: то, что можно показать в заголовке. Адрес идёт сюда до маскирования, поэтому
 * правило то же, что у маски: иначе заголовок откроет пароль, скрытый в http.uri.
 */
export function withoutCredentials(uri: string): string {
  const abs = URI_SCHEME.test(uri) || uri.startsWith('/') ? uri : `//${uri}`;
  return maskUserinfo(abs)
    .replace(URI_SCHEME, '')
    .replace(/^\/\/(?!\/)/, '')
    .replace(/^\*\*\*(?:@|%(?:25)*40|&(?:amp;)*#(?:0*64|x0*40);)/i, '');
}

/** Адрес с учётными данными, заменёнными на *** (для разбора по частям). */
export const uriWithoutUserinfo = maskUserinfo;

// Теги XML секретов, номеров карт, заголовков с учётными данными и Value в FilterCondition SOAP-процессинга.
const XML_KEYS = `${ANY_ALT}|value`;
/** Пробелы между тегами: и экранированные \n, \t — XML в строке JSON. */
const WS_XML = R`(?:\s|\\{1,16}[nrt])*`;
// Открывающий тег. Конец содержимого ищет tagCloser: закрывающий тег с тем же именем, с учётом вложенных; без него —
// конец текста.
const XML_OPEN = new RegExp(R`<(?<name>(?:[\w.-]+:)?(?<key>${XML_KEYS}))(?<attrs>\s[^<>]*)?>`, 'gi');
// Тот же элемент сущностями XML (&lt; &amp;lt; &#60; &#060;), в percent-encoding (%3C %253C) или \u003c (Go):
// одна запись < и > на элемент.
const ENT_LT = R`(?:lt|#0?60|#x0{0,2}3[cC]);`;
const ENT_GT = R`(?:gt|#0?62|#x0{0,2}3[eE]);`;
export const ENC_LT = R`&${AMP}${ENT_LT}|%${P25}3[cC]|(?<!\\)${BSL_ENT}\\u(?:003[cC]|0026${AMP}${ENT_LT})`;
export const ENC_GT = R`&${AMP}${ENT_GT}|%${P25}3[eE]|${BSL_ENT}\\u(?:003[eE]|0026${AMP}${ENT_GT})`;
const ENC_RB = R`(?:\]|%${P25}5[Dd])`;
export const ENC_ATTRS = R`(?:\s|\+|%${P25}20)(?:[^<>&%\\]|&(?!${AMP}(?:[gl]t|#0?6[02]|#x0{0,2}3[ceCE]);)|%(?!${P25}3[ceCE])|\\(?!\\{0,7}u(?:003[ceCE]|0026)))*`;
const XML_OPEN_ENC = new RegExp(
  R`(?<lt>${ENC_LT})(?<name>(?:[\w.-]+(?::|%${P25}3[Aa]))?(?<key>${XML_KEYS}))(?<attrs>${ENC_ATTRS})?(?<gt>${ENC_GT})`,
  'gi',
);
// Тег с атрибутами: имя бывает в атрибуте (<field name="pan">), значение — в атрибуте value.
const XML_ATTRS = /<(?<name>[\w.:-]+)(?<attrs>\s[^<>]*)>/g;
const XML_ATTRS_ENC = new RegExp(R`(?<lt>${ENC_LT})(?<name>[\w.:-]+)(?<attrs>${ENC_ATTRS})(?<gt>${ENC_GT})`, 'gi');
const ATTR_EQ = R`(?:=|%(?:25)*3[Dd]|&(?:amp;)*#0*61;)`;
const ATTR_Q = R`\\*["']|&(?:amp;)*(?:quot|#0*34|#x0*22);|%(?:25)*22|\\+u0022`;
const ATTR_LEFT = R`(?:^|\s|\+|%(?:25)*20)`;
const ATTR_NAME = new RegExp(R`${ATTR_LEFT}(?:name|key)${ATTR_EQ}(?:${ATTR_Q})?([\w.:-]{1,128})`, 'i');
const ATTR_VALUE = new RegExp(R`(${ATTR_LEFT}value${ATTR_EQ})(${ATTR_Q})?`, 'i');
const ATTR_ANY = new RegExp(R`(?:name|key|value)${ATTR_EQ}`, 'i');
export const ENC_LT_ANY = /&(?:amp;)*(?:lt|#0*60|#x0*3c);|%(?:25)*3c|\\u003c|\\u0026(?:amp;)*(?:lt|#0*60|#x0*3c);/i;

// Пары имя=значение и родственные записи: form-urlencoded, строка запроса, атрибут, текст, PHP, JavaScript.
// Перед именем — не буква и не цифра, граница camelCase, либо экранированный \n, \r, \t, \u0026 (& у Go) или %XX разделителя:
// первый параметр вложенного адреса стоит после %3F, поле формы PHP — после %5B. После имени — кавычка, ] или %5D,
// затем =, =>, :, :: (пробелы вокруг допустимы), %3D, %3A, &#61; или &#58;.
// Значение разбирает pairValue: кавычка любого уровня без пары и значение длиннее предела — до конца внешней строки;
// скобка — до парной. Без кавычек значение кончается на &, \u0026, пробеле, экранированном пробеле и кавычке строки;
// %26 — только если и разделитель пары в percent-encoding: в настоящей форме это часть значения.
const PAIR_CLOSER = R`(?<cq>\\*["']|\]|%${P25}5[Dd])?`;
const PAIR_SEP = R`(?<sep>[ \t]*(?:=>|=|::?(?!\\*/))[ \t]*|%${P25}3[DdAa](?:\+|%${P25}20)*|&${AMP}#(?:0*(?:61|58)|x0*3[DdAa]);[ \t]*|\\u003[DdAa][ \t]*)`;
const AFTER_DELIMITER = new RegExp(R`(?:\\[nrt]|\\u0026|%${P25}(?:2[0-9A-Fa-f]|3[A-Fa-f]|5[Bb]|7[BbCc]|0[9AaDd]|40))$`);
const PAIR_VALUE_PLAIN = R`(?:[^&\s"\\]|"(?=\w)|\\+"(?=\w)|\\+(?![\\"nrt]|u0026))*`;
const PAIR_VALUE_ENC = R`(?:[^&\s"\\%]|"(?=\w)|\\+"(?=\w)|%(?!${P25}26)|\\+(?![\\"nrt]|u0026))*`;
const BARE_PLAIN = new RegExp(PAIR_VALUE_PLAIN, 'y');
const BARE_ENC = new RegExp(PAIR_VALUE_ENC, 'y');
const PAIR_QUOTE = /(\\*)(["'])/y;
const PAIR_ENT = new RegExp(R`&${ENT_Q}`, 'yi');
const SECRET_PAIR = new RegExp(
  R`(?<key>pass(?:word|wd)|pin(?:${WS_}(?:block|code))?|cv[vc]2?(?:${WS_}code)?|secret|token|cookie|api${WS_}key|encrypted${WS_}pan|(?:access|refresh|id|auth|csrf)token|clientsecret)${PAIR_CLOSER}${PAIR_SEP}`,
  'gi',
);
const PAN_PAIR = new RegExp(R`(?<key>${PAN_END})${PAIR_CLOSER}${PAIR_SEP}`, 'gi');
// Такие слова бывают и в обычном тексте: «invalid token: expired». Со знаком «:» — только в кавычках.
const WEAK_PAIR_NAME = /^(?:token|cookie|api)|token$/i;
// Кодовое слово бывает из двух слов: без кавычек оно идёт до разделителя пары, а не до пробела.
const CODEWORD_PAIR = /cardholderpassword(?:["']|\])?[ \t]*(?:=>|=|:)[ \t]*(?!\\*["'])[^&\r\n"\\,;]+/gi;
const PAIR_ANY = new RegExp(R`[=:]|%(?:25)*3[da]|&(?:amp;)*#|\\u003[da]`, 'i');
// Заголовок с учётными данными в паре, в одинарных кавычках или с двоеточием в %XX и сущностью.
const AUTH_PAIR = new RegExp(
  R`(?<head>authorization(?:\\*'|\])?(?:[ \t]*=>?[ \t]*|[ \t]*:[ \t]*(?=\\*')|%${P25}3[Aa](?:\+|%${P25}20)*|&${AMP}#(?:0*58|x0*3[Aa]);[ \t]*|%${P25}3[Dd](?:\+|%${P25}20)*))` +
    R`(?<q>\\*['"])?(?<scheme>(?:basic|bearer|digest)(?:[ \t]+|\+|%${P25}20))?(?:[^\r\n&"'\\%]|%(?!${P25}(?:26|22|27))|\\(?![\\"'nrt]))*`,
  'gi',
);
// Номер в паре: цифры сразу за разделителем, группы — и через пробел.
const DIGIT_SEP = R`(?:[ \t\u00a0./_+:,*=;~#|'-]{0,6}|%${P25}20)`;
const PAN_PAIR_DIGITS = new RegExp(R`\d(?:${DIGIT_SEP}\d){11,18}(?!\d)`, 'y');

// После %XX или \uXXXX, которые оканчиваются цифрой, цифры escape в номер не входят.
const AFTER_ESCAPE = R`(?<=%${P25}[0-9A-Fa-f]\d|\\u[0-9A-Fa-f]{3}\d)`;
// Номер в значении PAN-ключа: 12–19 цифр подряд или с любыми разделителями (по имени поля ясно, что это номер).
const DIGIT_RUN = new RegExp(R`(?:${AFTER_ESCAPE}|(?<!\d))\d(?:${DIGIT_SEP}\d){11,18}(?!\d)`, 'g');
const PAN_PATTERN = /(?<!\d)\d{15,19}(?!\d)/g;
// Номер группами: 4-4-4-4 с 1–3 цифрами в конце или 4-6-5 (Amex); разделители — пробелы, дефис, +, %20.
const GROUP_SEP = R`(?:[ \t\u00a0+-]{1,3}|%${P25}20)`;
const PAN_GROUPED = new RegExp(
  R`(?<!\d)\d{4}${GROUP_SEP}\d{4}${GROUP_SEP}\d{4}${GROUP_SEP}\d{4}(?:${GROUP_SEP}?\d{1,3})?(?!\d)|(?<!\d)\d{4}${GROUP_SEP}\d{6}${GROUP_SEP}\d{5}(?!\d)`,
  'g',
);
const PAN_AFTER_ESCAPE = new RegExp(R`${AFTER_ESCAPE}\d{15,19}(?!\d)`, 'g');
const KNOWN_SCHEME = /^\s*(Basic|Bearer|Digest)(?:\s|$)/i;

function maskDigitRuns(s: string): string {
  if (openingCards) return s;
  return s.replace(DIGIT_RUN, (m) => maskPanGrouped(m));
}

function maskAuthValue(v: string): string {
  const m = KNOWN_SCHEME.exec(v);
  return m ? `${m[1]} ${HIDDEN}` : HIDDEN;
}

// Заголовок Authorization в сыром HTTP (request_data шлюза): значение до конца строки заголовка целиком,
// включая " и \ внутри токена. Где конец строки, зависит от уровня экранирования — его выдаёт то, что перед именем.
const AUTH_HEAD = '(?<head>[\\w-]*(?:authorization|cookie|api-?key|[-_]token)[ \\t]*:[ \\t]*)(?:(?<scheme>basic|bearer|digest)(?:[ \\t]+|(?=(?:\\r?\\n|\\\\+[rn])[ \\t])))?';
const SECRET_HEADER_ANY = /(?:authorization|cookie|api-?key|[-_]token)[ \t]*:/i;
// 2k+2 черты — литеральная \ в строке JSON с k чертами перед кавычкой.
const BS_PAIR = '(?:\\k<b>\\k<b>\\\\\\\\)';
const AUTH_HTTP_HEADERS = [
  // Экранированный перевод строки (k+1 черт и r или n) или кавычка строки (k черт и "): строка JSON уровня k.
  // Значение кончается на переводе строки или кавычке этого уровня; " внутри значения — 2k+1 черт и ", \ — 2k+2 черты,
  // в том числе прямо перед концом. Серия черт разбирается только от своего начала: линейное время.
  new RegExp(
    `(?<pre>(?<!\\\\)(?<b>\\\\*)(?:"|\\\\[rn]))${AUTH_HEAD}(?:[^\\r\\n\\\\"]` +
      `|(?<!\\\\)${BS_PAIR}*\\k<b>\\k<b>\\\\"` +
      `|(?<!\\\\)${BS_PAIR}+(?=\\k<b>(?:"|\\\\[rn]))` +
      `|(?<!\\\\)(?!${BS_PAIR}*\\k<b>\\\\[rn])\\\\+(?![\\\\"])` +
      // Значение, перенесённое на следующую строку: за экранированным переводом строки идёт пробел.
      `|(?<!\\\\)\\k<b>\\\\(?:r\\k<b>\\\\n|n)(?=[ \\t]))+`,
    'gi',
  ),
  // Настоящий перевод строки или начало текста: HTTP без экранирования, значение до конца строки и его продолжения
  // на следующих строках, которые начинаются с пробела.
  new RegExp(`(?<=^|[\\r\\n])${AUTH_HEAD}(?:[^\\r\\n]+(?:\\r?\\n[ \\t]+[^\\r\\n]*)*|(?:\\r?\\n[ \\t]+[^\\r\\n]*)+)`, 'gi'),
  // Иначе уровень неизвестен: значение до кавычки, обратной косой черты или перевода строки.
  // У Digest значение — параметры с кавычками на любом уровне экранирования: username="u", response="…".
  // Заголовки, скрытые выражениями выше, это выражение не меняет.
  /(?<head>authorization[ \t]*:[ \t]*)(?:(?<digest>digest)[ \t]+(?:=\\*"[^"\\\r\n]*\\*"|(?!\\[rn])[^\r\n"\\])+|(?:(?<scheme>basic|bearer)[ \t]+)?(?:(?!\\[rn])[^\r\n"\\])+)/gi,
];

export type Groups = Record<string, string | undefined>;

/** replace с именованными группами. */
function replaceNamed(s: string, re: RegExp, fn: (m: string, g: Groups) => string): string {
  return s.replace(re, (...args: unknown[]) => fn(args[0] as string, args[args.length - 1] as Groups));
}

/** Выражения кавычки q одного семейства: элементы массива, строка, токены сканера скобок. */
interface QuoteRes {
  elements: RegExp;
  close: RegExp;
  tokens: RegExp;
}
const quoteRes = new Map<string, QuoteRes>();
/** Длиннее — уровень экранирования, которого в логах не бывает: массив маскируется целиком. */
const MAX_QUOTE = 256;

function quoteRegexps(g: Groups, family: Family): QuoteRes {
  const q = g.q ?? '"';
  const k = `${family}\u0000${q}`;
  let r = quoteRes.get(k);
  if (!r) {
    const qe = escapeRe(q);
    const bb = escapeRe((g.b ?? '') + (g.b ?? ''));
    // Начало серии экранирования и пара экранирования — литеральная \ в значении.
    const unit = family === 'pct' ? `%${escapeRe(g.p ?? '')}5[Cc]` : R`\\`;
    const lb = `(?<!${unit})`;
    const pair = `${bb}(?:${unit}){2}`;
    const brackets = family === 'pct' ? [R`[\[{]|%${P25}(?:5[Bb]|7[Bb])`, R`[\]}]|%${P25}(?:5[Dd]|7[Dd])`] : [R`[\[{]`, R`[\]}]`];
    r = {
      elements: new RegExp(`${lb}${qe}(?<str>${SCAN})${lb}(?<tail>(?:${pair})*)${qe}|(?<num>${NUM_ELEM})`, 'g'),
      close: new RegExp(`${lb}(?<tail>(?:${pair})*)${qe}`, 'g'),
      tokens: new RegExp(`${lb}(?<str>${qe})|(?<open>${brackets[0]})|(?<close>${brackets[1]})`, 'g'),
    };
    if (quoteRes.size < 64) quoteRes.set(k, r);
  }
  return r;
}

/** Строки и числа массива: строка — f, число — num (null — оставить как есть). Результат — новое тело массива. */
export function mapArray(body: string, g: Groups, family: Family, f: (v: string) => string, num: (n: string) => string | null): string {
  const q = g.q ?? '"';
  if (q.length > MAX_QUOTE) return `${q}${HIDDEN}${q}`;
  return replaceNamed(body, quoteRegexps(g, family).elements, (m, e) => {
    if (e.str !== undefined) return `${q}${f(e.str)}${q}`;
    const r = num(m);
    return r === null ? m : `${q}${r}${q}`;
  });
}

interface Bracketed {
  end: number;
  /** Длина закрывающей скобки. */
  close: number;
  /** Внутри есть объект или массив. */
  nested: boolean;
}

/**
 * Объект или массив от скобки в at: строки уровня q пропускаются, скобки считаются до парной.
 * null — пара не нашлась в пределах MAX_SCAN.
 */
export function bracketEnd(s: string, at: number, g: Groups, family: Family): Bracketed | null {
  if ((g.q ?? '').length > MAX_QUOTE) return null;
  const { close, tokens } = quoteRegexps(g, family);
  const limit = at + MAX_SCAN;
  let depth = 0;
  let nested = false;
  tokens.lastIndex = at;
  for (let m = tokens.exec(s); m !== null && m.index <= limit; m = tokens.exec(s)) {
    const t = m.groups!;
    if (t.str !== undefined) {
      close.lastIndex = tokens.lastIndex;
      const c = close.exec(s);
      if (c === null || c.index > limit) return null;
      tokens.lastIndex = close.lastIndex;
    } else if (t.open !== undefined) {
      if (++depth > 1) nested = true;
    } else if (--depth === 0) return { end: tokens.lastIndex, close: m[0].length, nested };
  }
  return null;
}

interface Closed {
  /** Начало закрывающей части. */
  at: number;
  end: number;
  /** Пары экранирования в конце значения: литеральная \ перед кавычкой. */
  tail: string;
}

/** Закрывающая кавычка строки, значение которой начинается в from; null — не нашлась в пределах MAX_SCAN. */
export function closeOf(s: string, from: number, g: Groups, family: Family): Closed | null {
  if ((g.q ?? '').length > MAX_QUOTE) return null;
  const { close } = quoteRegexps(g, family);
  close.lastIndex = 0;
  const c = close.exec(s.slice(from, from + MAX_SCAN));
  return c ? { at: from + c.index, end: from + c.index + c[0].length, tail: c.groups!.tail ?? '' } : null;
}

const OUTER_ENT = /(?<!\\)\\*[<"]/g;
const OUTER_PCT = /[&\s"<]/g;

/** Кавычка строки внешнего уровня: меньше k черт перед ней. Значение с k чертами перед кавычкой дальше неё не идёт. */
function outerQuote(s: string, from: number, k: number): number {
  if (k === 0) return s.length;
  QUOTE_RUN.lastIndex = from;
  for (let m = QUOTE_RUN.exec(s); m !== null; m = QUOTE_RUN.exec(s)) if (m[1]!.length < k) return m.index;
  return s.length;
}

/**
 * Конец строки без закрывающей кавычки (обрезанное тело, значение длиннее предела): конец строки внешнего уровня, а если
 * её нет — конец текста. Значение сущностями кончается на необработанной < или ", в percent-encoding — на & или пробеле.
 */
export function openEnd(s: string, from: number, g: Groups, family: Family): number {
  if (family === 'bs') return outerQuote(s, from, (g.b ?? '').length);
  const re = family === 'ent' ? OUTER_ENT : OUTER_PCT;
  re.lastIndex = from;
  return re.exec(s)?.index ?? s.length;
}

export interface KeyValue {
  /** open — строка без закрывающей кавычки. */
  kind: 'str' | 'open' | 'num' | 'arr' | 'obj';
  /** Где начинается ключ. */
  at: number;
  /** Значение целиком, от первого символа после «ключ:». */
  text: string;
  /** Строка без кавычек. */
  str: string;
  /** Литеральные \ перед закрывающей кавычкой. */
  tail: string;
  /** Для массива и объекта: длина закрывающей скобки; 0 — пара не нашлась, значение до конца строки. */
  close: number;
  nested: boolean;
}

/**
 * Значения по ключу JSON: fn возвращает новое значение или null — оставить как есть.
 * Объект и массив просматриваются сканером скобок; без пары значение — до конца строки, и просмотр на этом кончается.
 */
export function replaceKeyValues(s: string, re: RegExp, family: Family, fn: (g: Groups, v: KeyValue) => string | null): string {
  let out = '';
  let last = 0;
  re.lastIndex = 0;
  for (let m = re.exec(s); m !== null; m = re.exec(s)) {
    const g = m.groups as Groups;
    const start = re.lastIndex - (g.vq ?? g.br ?? g.num ?? '').length;
    const base = { at: m.index, str: '', tail: '', close: 0, nested: false };
    let v: KeyValue;
    if (g.br !== undefined) {
      const kind = g.br === '{' || /7b$/i.test(g.br) ? 'obj' : 'arr';
      const b = bracketEnd(s, start, g, family);
      v = b ? { ...base, kind, text: s.slice(start, b.end), close: b.close, nested: b.nested } : { ...base, kind, text: s.slice(start), nested: true };
    } else if (g.vq !== undefined) {
      const from = start + g.q!.length;
      const c = closeOf(s, from, g, family);
      if (c) v = { ...base, kind: 'str', text: s.slice(start, c.end), str: s.slice(from, c.at), tail: c.tail };
      else {
        const end = openEnd(s, from, g, family);
        v = { ...base, kind: 'open', text: s.slice(start, end), str: s.slice(from, end) };
      }
    } else v = { ...base, kind: 'num', text: s.slice(start, re.lastIndex) };
    const masked = fn(g, v);
    if (masked === null) {
      // Значение другого имени — обычный текст: его кавычка может открывать следующий ключ.
      re.lastIndex = start;
      continue;
    }
    out += s.slice(last, start) + masked;
    last = start + v.text.length;
    re.lastIndex = last;
  }
  return last === 0 ? s : out + s.slice(last);
}

/** Массив только из строк и чисел этого уровня. Иначе элементы не узнать, и он скрывается целиком: ['S'], [S]. */
export function plainArray(body: string, g: Groups, family: Family): boolean {
  if ((g.q ?? '').length > MAX_QUOTE) return false;
  return /^(?:[\s,]|\\+[nrt]|\+|%(?:25)*(?:2[Cc]|20|0[9AaDd]))*$/.test(body.replace(quoteRegexps(g, family).elements, ''));
}

const FILTER_WORD = /filtercondition/gi;
const FILTER_CLOSE = /(?:\/|%(?:25)*2[Ff]|\\u002[fF])(?:[\w.-]+:)?$/;

/**
 * Value другого регистра — номер только внутри FilterCondition: от его имени до закрывающего тега.
 * Конец объекта JSON не ищется: скобка в строке закрыла бы его раньше времени, а лишний скрытый номер безопасен.
 */
function filterLookup(s: string): (at: number) => boolean {
  let marks: { at: number; close: boolean }[] | null = null;
  return (at) => {
    if (marks === null) {
      marks = [];
      FILTER_WORD.lastIndex = 0;
      for (let m = FILTER_WORD.exec(s); m !== null; m = FILTER_WORD.exec(s)) {
        marks.push({ at: m.index, close: FILTER_CLOSE.test(s.slice(Math.max(0, m.index - 64), m.index)) });
      }
    }
    let lo = 0;
    let hi = marks.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (marks[mid]!.at < at) lo = mid + 1;
      else hi = mid;
    }
    return lo > 0 && !marks[lo - 1]!.close;
  };
}

/** Шаги 2–3: секреты, Authorization, номера карт и Value по ключу JSON одного семейства кавычек. */
function maskJsonKeys(s: string, rules: KeyRules, family: Family, keep: ReadonlySet<string>): string {
  const hidden = (g: Groups) => `${g.q}${HIDDEN}${g.q}`;
  const body = (g: Groups, v: KeyValue) => v.text.slice(g.br!.length, v.text.length - v.close);
  const array = (g: Groups, v: KeyValue, f: (x: string) => string, num: (n: string) => string | null) =>
    g.br! + mapArray(body(g, v), g, family, f, num) + v.text.slice(v.text.length - v.close);
  const scalars = (g: Groups, v: KeyValue) => v.kind === 'arr' && !v.nested && plainArray(body(g, v), g, family);
  let out = replaceKeyValues(s, rules.secret, family, (g, v) => {
    if (!isSecretName(g.key!)) return null;
    if (v.kind === 'open') return v.str === '' ? null : `${g.q}${HIDDEN}`;
    return scalars(g, v) ? array(g, v, () => HIDDEN, () => HIDDEN) : hidden(g);
  });
  out = replaceKeyValues(out, rules.auth, family, (g, v) => {
    if (!isAuthName(g.key!)) return null;
    if (v.kind === 'str') return `${g.q}${maskAuthValue(v.str)}${g.q}`;
    if (v.kind === 'open') return v.str === '' ? null : `${g.q}${maskAuthValue(v.str)}`;
    return scalars(g, v) ? array(g, v, maskAuthValue, () => HIDDEN) : hidden(g);
  });
  // Объект и массив под ключом номера карты не скрываются целиком: маскируются цифры в их строках и числах.
  const panValue = (g: Groups, v: KeyValue) => {
    if (v.kind === 'open') return `${g.q}${maskPanAny(v.str)}`;
    if (v.kind === 'str') return `${g.q}${maskPanAny(v.str)}${v.tail}${g.q}`;
    if (v.kind === 'num') return !openingCards && /^-?\d{12,19}(?:\.\d+)?$/.test(v.text) ? `${g.q}${panOut(intDigits(v.text))}${g.q}` : null;
    if (v.close === 0) return maskPanAny(v.text);
    return array(g, v, maskPanAny, (n) => (!openingCards && /^-?\d{12,19}(?:\.\d+)?$/.test(n) ? panOut(intDigits(n)) : null));
  };
  out = replaceKeyValues(out, rules.pan, family, (g, v) => (isPanName(g.key!) ? panValue(g, v) : null));
  // Имя в значении соседнего поля: {"name":"Authorization","value":"…"} и плоский список заголовков.
  const byName = (g: Groups, v: KeyValue): string | null => {
    const kind = classifyName(g.key!);
    if (kind === null) return null;
    if (kind === 'pan') return panValue(g, v);
    if (kind === 'auth' && v.kind === 'str') return `${g.q}${maskAuthValue(v.str)}${g.q}`;
    if (v.kind === 'open') return v.str === '' ? null : `${g.q}${HIDDEN}`;
    return hidden(g);
  };
  if (/name|key/i.test(out)) out = replaceKeyValues(out, rules.named, family, byName);
  // В объекте слово за двоеточием — значение своего ключа, а строка за запятой — следующий ключ, а не значение заголовка.
  const listed = out;
  out = replaceKeyValues(listed, rules.neighbour, family, (g, v) => (isListedHeader(g.key!) && !afterColon(listed, v.at) ? byName(g, v) : null));
  const inFilter = filterLookup(out);
  return out.replace(rules.value, (...args: unknown[]) => {
    const m = args[0] as string;
    const g = args[args.length - 1] as Groups;
    const at = args[args.length - 3] as number;
    if (g.key !== 'Value' && !inFilter(at)) return m;
    const shown = g.str ?? g.num ?? '';
    const d = shown.replace(/\D/g, '');
    if (d.length < 12 || d.length > 19 || keep.has(d)) return m;
    return `${g.q}${g.key}${g.q}${g.sep}${g.q}${maskPanAny(shown)}${g.q}`;
  });
}

/** Перед позицией двоеточие, в том числе в percent-encoding. */
function afterColon(s: string, at: number): boolean {
  let i = at - 1;
  while (i >= 0 && (s[i] === ' ' || s[i] === '\t' || s[i] === '\r' || s[i] === '\n')) i--;
  if (s[i] === ':') return true;
  const tail = s.slice(Math.max(0, i - 4), i + 1).toUpperCase();
  return tail.endsWith('%3A');
}

/** Заголовок с учётными данными в плоском списке: у слова вне списка заголовков соседний элемент — не его значение. */
function isListedHeader(name: string): boolean {
  return isAuthName(name) || /(?:cookie|api[_.-]?key|token)$/i.test(name);
}

/** Цифры целой части числа: без знака и дроби. */
function intDigits(n: string): string {
  return n.replace(/^-/, '').replace(/\..*$/, '');
}

const VALUE_CONTENT = new RegExp(R`^(${WS_ENC})(\d(?:[\s./_+-]{0,3}\d){11,18})(${WS_ENC})$`);

/** Содержимое тега: разметка не цифры номера. Цифры, разбитые разметкой (две CDATA), маскируются как один номер. */
const PAN_MARKUP = /<!\[CDATA\[|\]\]>|<[^<>]*>|\d/g;
function maskPanContent(content: string): string {
  if (openingCards) return content;
  if (!content.includes('<')) return maskPanAny(content);
  const total = (content.match(PAN_MARKUP) ?? []).filter((x) => x.length === 1).length;
  if (total < 12 || total > 19) return maskDigitRuns(content);
  let n = 0;
  return content.replace(PAN_MARKUP, (d) => {
    if (d.length > 1) return d;
    const i = n++;
    return i < 6 || i >= total - 4 ? d : hiddenDigit();
  });
}

/** Значение секрета в теге: обёртка CDATA и пробелы вокруг неё остаются, иначе — *** вместо всего содержимого. */
function hideTagContent(content: string, cdata: RegExp, f: (inner: string) => string): string {
  if (content.trim() === '') return content;
  const c = cdata.exec(content);
  return c && !c[2]!.includes(']]>') ? `${c[1]}${f(c[2]!)}${c[3]}` : f(content);
}

export const CDATA_PLAIN = new RegExp(R`^(${WS_XML}<!\[CDATA\[)([\s\S]*)(\]\]>${WS_XML})$`);

/** Новое содержимое тега. value — Value как номер: только 12–19 цифр. */
function maskTagContent(key: string, content: string, keep: ReadonlySet<string>, cdata: RegExp, value: boolean): string {
  if (isSecretName(key)) return hideTagContent(content, cdata, () => HIDDEN);
  if (isPanName(key)) return maskPanContent(content);
  if (isAuthName(key)) return hideTagContent(content, cdata, maskAuthValue);
  if (!value) return content;
  const c = cdata.exec(content);
  const inner = c ? c[2]! : content;
  const masked = inner.replace(VALUE_CONTENT, (m, a: string, d: string, z: string) => (keep.has(d.replace(/\D/g, '')) ? m : a + maskDigitRuns(d) + z));
  return c ? `${c[1]}${masked}${c[3]}` : masked;
}

const closers = new Map<string, RegExp>();
function cachedRe(key: string, make: () => RegExp): RegExp {
  let r = closers.get(key);
  if (!r) {
    r = make();
    if (closers.size < 256) closers.set(key, r);
  }
  return r;
}

/** Длиннее — не имя тега: такой элемент считается незакрытым. */
const MAX_TAG_NAME = 256;
/** Просмотр содержимого Value: номер короткий, и незакрытый Value ничего не скрывает. */
const MAX_VALUE_SCAN = 256;

/** Конец содержимого тега и начало следующего просмотра: парный закрывающий тег с учётом вложенных, иначе null. */
export function plainClose(s: string, from: number, name: string, limit: number): { at: number; end: number } | null {
  if (name.length > MAX_TAG_NAME) return null;
  const n = escapeRe(name);
  const re = cachedRe(`p\u0000${name.toLowerCase()}`, () => new RegExp(R`(?<o><${n}(?:\s[^<>]*)?>)|(?<c><\\*/${n}${WS_XML}>)`, 'gi'));
  // С пределом — только окно: иначе у каждого имени просмотр шёл бы до конца текста.
  const text = limit === Infinity ? s : s.slice(0, limit + name.length + 64);
  re.lastIndex = from;
  let depth = 1;
  for (let m = re.exec(text); m !== null && m.index <= limit; m = re.exec(text)) {
    if (m.groups!.o !== undefined) {
      if (!m[0].endsWith('/>')) depth++;
    } else if (--depth === 0) return { at: m.index, end: m.index + m[0].length };
  }
  return null;
}

function maskXmlTags(s: string, keep: ReadonlySet<string>): string {
  let out = '';
  let last = 0;
  const inFilter = filterLookup(s);
  XML_OPEN.lastIndex = 0;
  for (let m = XML_OPEN.exec(s); m !== null; m = XML_OPEN.exec(s)) {
    const g = m.groups as Groups;
    if (g.attrs?.endsWith('/')) continue;
    const key = g.key!;
    const from = m.index + m[0].length;
    const lower = key.toLowerCase();
    const value = lower === 'value';
    if (!value && classifyName(key) === null) continue;
    if (value && key !== 'Value' && !inFilter(m.index)) continue;
    const c = plainClose(s, from, g.name!, value ? from + MAX_VALUE_SCAN : Infinity);
    if (!c && value) continue;
    const at = c ? c.at : s.length;
    const content = s.slice(from, at);
    const masked = maskTagContent(key, content, keep, CDATA_PLAIN, value);
    if (masked !== content) {
      out += s.slice(last, from) + masked;
      last = at;
    }
    XML_OPEN.lastIndex = c ? c.end : s.length;
  }
  return last === 0 ? s : out + s.slice(last);
}

/** Значение в атрибуте value рядом с именем: <input name="password" value="…"/>, <password value="…"/>. */
function maskValueAttr(attrs: string, kind: NameKind): string {
  const v = ATTR_VALUE.exec(attrs);
  if (!v) return attrs;
  const from = v.index + v[0].length;
  const q = v[2] ?? '';
  let end = q ? attrs.indexOf(q, from) : -1;
  if (end < 0) end = q ? attrs.length : (/\s|\/$|%(?:25)*2[Ff]$/.exec(attrs.slice(from))?.index ?? attrs.length - from) + from;
  const inner = attrs.slice(from, end);
  return attrs.slice(0, from) + (kind === 'pan' ? maskPanAny(inner) : HIDDEN) + attrs.slice(end);
}

/** Имя в атрибуте name или key, иначе — имя самого тега, если у него есть атрибут value. */
function attrNameOf(name: string, attrs: string): { key: string; kind: NameKind } | null {
  const a = ATTR_NAME.exec(attrs);
  const named = a ? classifyName(a[1]!) : null;
  if (a && named !== null) return { key: a[1]!, kind: named };
  const own = ATTR_VALUE.test(attrs) ? classifyName(name) : null;
  return own === null ? null : { key: name, kind: own };
}

const SELF_CLOSED = /(?:\/|%(?:25)*2[Ff]|\\+u002[fF])$/;

/** Шаг 4а: теги с именем в атрибуте: тот же путь, что у обычного тега, и значение в атрибуте value. */
function maskNamedTags(s: string, keep: ReadonlySet<string>): string {
  let out = '';
  let last = 0;
  XML_ATTRS.lastIndex = 0;
  for (let m = XML_ATTRS.exec(s); m !== null; m = XML_ATTRS.exec(s)) {
    const g = m.groups as Groups;
    const attrs = g.attrs!;
    if (!ATTR_ANY.test(attrs)) continue;
    const found = attrNameOf(g.name!, attrs);
    if (!found) continue;
    const at = m.index + 1 + g.name!.length;
    const newAttrs = maskValueAttr(attrs, found.kind);
    if (newAttrs !== attrs) {
      out += s.slice(last, at) + newAttrs;
      last = at + attrs.length;
    }
    if (attrs.endsWith('/')) continue;
    const from = m.index + m[0].length;
    const c = plainClose(s, from, g.name!, Infinity);
    const end = c ? c.at : s.length;
    const content = s.slice(from, end);
    const masked = maskTagContent(found.key, content, keep, CDATA_PLAIN, false);
    if (masked !== content) {
      out += s.slice(last, from) + masked;
      last = end;
    }
    XML_ATTRS.lastIndex = c ? c.end : s.length;
  }
  return last === 0 ? s : out + s.slice(last);
}

/**
 * Закрывающие теги: следующий запоминается на выражение, чтобы незакрытые элементы не просматривали текст заново.
 * Разных имён может быть много, поэтому просмотр ограничен общим бюджетом: без него элемент считается незакрытым и
 * скрывается до конца внешней строки.
 */
export function closeFinder(s: string): (close: RegExp, from: number) => RegExpExecArray | null {
  const next = new Map<RegExp, RegExpExecArray | null>();
  let budget = 8 * s.length + 65_536;
  return (close, from) => {
    const known = next.get(close);
    if (known === null || (known !== undefined && known.index >= from)) return known;
    if (budget <= 0) return null;
    close.lastIndex = from;
    const c = close.exec(s);
    budget -= (c ? c.index : s.length) - from;
    next.set(close, c);
    return c;
  };
}

/** Выражения элемента в одной записи < и >: закрывающий тег и обёртка CDATA. */
export function encodedRes(lt: string, gt: string, name: string): { close: RegExp; cdata: RegExp } {
  const l = escapeRe(lt);
  const r = escapeRe(gt);
  const n = escapeRe(name);
  return {
    close: cachedRe(`c\u0000${lt}\u0000${gt}\u0000${name.toLowerCase()}`, () =>
      new RegExp(R`${l}(?:\\*/|(?:%${P25}5[Cc]){0,15}%${P25}2[Ff]|${BSL_ENT}\\u002[fF])${n}${WS_ENC}${r}`, 'gi'),
    ),
    cdata: cachedRe(`d\u0000${lt}\u0000${gt}`, () =>
      new RegExp(R`^(${WS_ENC}${l}!(?:\[|%${P25}5[Bb])CDATA(?:\[|%${P25}5[Bb]))((?:(?!${ENC_RB}${ENC_RB}${r}|${l}!)[\s\S])*)(${ENC_RB}${ENC_RB}${r}${WS_ENC})$`, 'i'),
    ),
  };
}

/** Конец незакрытого элемента в записи lt: граница внешнего текста, иначе конец текста. */
export function encodedOpenEnd(s: string, from: number, lt: string): number {
  if (lt.startsWith('%')) {
    OUTER_PCT.lastIndex = from;
    return OUTER_PCT.exec(s)?.index ?? s.length;
  }
  if (lt.startsWith('&')) {
    OUTER_ENT.lastIndex = from;
    return OUTER_ENT.exec(s)?.index ?? s.length;
  }
  return outerQuote(s, from, /^\\*/.exec(lt)![0].length);
}

function maskXmlTagsEncoded(s: string, keep: ReadonlySet<string>): string {
  let out = '';
  let last = 0;
  const inFilter = filterLookup(s);
  const closeAfter = closeFinder(s);
  XML_OPEN_ENC.lastIndex = 0;
  for (let m = XML_OPEN_ENC.exec(s); m !== null; m = XML_OPEN_ENC.exec(s)) {
    const g = m.groups as Groups;
    if (g.attrs && /(?:\/|%(?:25)*2f)$/i.test(g.attrs)) continue;
    const key = g.key!;
    const from = m.index + m[0].length;
    const value = key.toLowerCase() === 'value';
    if (!value && classifyName(key) === null) continue;
    if (value && key !== 'Value' && !inFilter(m.index)) continue;
    if (g.name!.length > MAX_TAG_NAME) continue;
    const { close, cdata } = encodedRes(g.lt!, g.gt!, g.name!);
    let c: RegExpExecArray | null;
    if (value) {
      close.lastIndex = 0;
      const w = s.slice(from, from + MAX_VALUE_SCAN);
      c = close.exec(w);
      if (!c) continue;
      c.index += from;
    } else c = closeAfter(close, from);
    const at = c ? c.index : encodedOpenEnd(s, from, g.lt!);
    const content = s.slice(from, at);
    const masked = maskTagContent(key, content, keep, cdata, value);
    if (masked !== content) {
      out += s.slice(last, from) + masked;
      last = at;
    }
    XML_OPEN_ENC.lastIndex = c ? c.index + c[0].length : at;
  }
  return last === 0 ? s : out + s.slice(last);
}

/** То же в записи сущностями, %XX или \u003c: <field name="password"> как &lt;field name=&quot;password&quot;&gt;. */
function maskNamedTagsEncoded(s: string, keep: ReadonlySet<string>): string {
  let out = '';
  let last = 0;
  const closeAfter = closeFinder(s);
  XML_ATTRS_ENC.lastIndex = 0;
  for (let m = XML_ATTRS_ENC.exec(s); m !== null; m = XML_ATTRS_ENC.exec(s)) {
    const g = m.groups as Groups;
    const attrs = g.attrs!;
    if (!ATTR_ANY.test(attrs)) continue;
    const found = attrNameOf(g.name!, attrs);
    if (!found) continue;
    const at = m.index + g.lt!.length + g.name!.length;
    const newAttrs = maskValueAttr(attrs, found.kind);
    if (newAttrs !== attrs) {
      out += s.slice(last, at) + newAttrs;
      last = at + attrs.length;
    }
    if (SELF_CLOSED.test(attrs) || g.name!.length > MAX_TAG_NAME) continue;
    const from = m.index + m[0].length;
    const { close, cdata } = encodedRes(g.lt!, g.gt!, g.name!);
    const c = closeAfter(close, from);
    const end = c ? c.index : encodedOpenEnd(s, from, g.lt!);
    const content = s.slice(from, end);
    const masked = maskTagContent(found.key, content, keep, cdata, false);
    if (masked !== content) {
      out += s.slice(last, from) + masked;
      last = end;
    }
    XML_ATTRS_ENC.lastIndex = c ? c.index + c[0].length : end;
  }
  return last === 0 ? s : out + s.slice(last);
}

/** Может ли имя начинаться здесь: не внутри слова, кроме границы camelCase и экранированного разделителя. */
function pairStart(s: string, at: number, key: string): boolean {
  if (at === 0 || /^pass/i.test(key)) return true;
  const prev = s[at - 1]!;
  if (!/[A-Za-z0-9]/.test(prev)) return true;
  if (/[a-z0-9]/.test(prev) && /[A-Z]/.test(key[0]!)) return true;
  return AFTER_DELIMITER.test(s.slice(Math.max(0, at - 16), at));
}

export interface PairValue {
  /** quote — значение в кавычках, open — кавычка без пары, bracket — объект или массив, bare — без кавычек. */
  kind: 'quote' | 'open' | 'bracket' | 'bare';
  /** Открывающая кавычка. */
  open: string;
  inner: string;
  /** Закрывающая кавычка. */
  close: string;
  end: number;
}

/**
 * Значение пары от позиции at. Кавычка без пары и значение длиннее предела — до конца внешней строки; скобка — до парной.
 * null — разбирать нечего: скобка за ключом в кавычках уже разобрана как JSON, за кавычкой без пары только конец записи.
 */
export function pairValue(s: string, at: number, cq: string | undefined, bareEnd: (s: string, at: number) => number): PairValue | null {
  PAIR_QUOTE.lastIndex = at;
  const q = PAIR_QUOTE.exec(s);
  if (q) {
    const open = q[0];
    const g: Groups = { q: open, b: q[1]! };
    const from = at + open.length;
    const c = q[2] === "'" ? closeSingle(s, from, q[1]!) : closeOf(s, from, g, 'bs');
    if (c) return { kind: 'quote', open, inner: s.slice(from, c.at), close: open, end: c.end };
    const end = openEnd(s, from, g, 'bs');
    const inner = s.slice(from, end);
    return /^[\s}\]),;]*$/.test(inner) ? null : { kind: 'open', open, inner, close: '', end };
  }
  PAIR_ENT.lastIndex = at;
  const ent = PAIR_ENT.exec(s);
  if (ent) {
    const open = ent[0];
    const from = at + open.length;
    const i = s.slice(from, from + MAX_SCAN).indexOf(open);
    if (i >= 0) return { kind: 'quote', open, inner: s.slice(from, from + i), close: open, end: from + i + open.length };
    const end = openEnd(s, from, { q: open }, 'ent');
    return { kind: 'open', open, inner: s.slice(from, end), close: '', end };
  }
  const ch = s[at];
  if (ch === '{' || ch === '[') {
    if (cq?.includes('"')) return null;
    const g: Groups = { q: cq?.includes("'") ? cq : '"', b: '' };
    const b = bracketEnd(s, at, g, 'bs');
    const end = b ? b.end : openEnd(s, at, g, 'bs');
    return { kind: 'bracket', open: '', inner: s.slice(at, end), close: '', end };
  }
  const end = bareEnd(s, at);
  return { kind: 'bare', open: '', inner: s.slice(at, end), close: '', end };
}

/** Конец значения без кавычек: разделитель пары в percent-encoding — и на %26. */
function bareEndOf(encoded: boolean): (s: string, at: number) => number {
  const re = encoded ? BARE_ENC : BARE_PLAIN;
  return (s, at) => {
    re.lastIndex = at;
    return at + (re.exec(s)?.[0].length ?? 0);
  };
}

/** Закрывающая одинарная кавычка: у неё нет пар экранирования, как у двойной в JSON. */
function closeSingle(s: string, from: number, b: string): Closed | null {
  const re = cachedRe(`s\u0000${b}`, () => new RegExp(`(?<!\\\\)${escapeRe(b)}'`, 'g'));
  re.lastIndex = 0;
  const c = re.exec(s.slice(from, from + MAX_SCAN));
  return c ? { at: from + c.index, end: from + c.index + c[0].length, tail: '' } : null;
}

const LITERAL = /^(?:null|true|false)(?=$|[,;)}\]])/;
const LITERAL_END = /^[,;)}\]]*$|^[,;)}\]]+[\w.-]{1,64}[=:]/;

/** Секреты в парах. null, true и false — не секрет: значение только до разделителя, разбор идёт дальше. */
function maskSecretPairs(s: string): string {
  let out = '';
  let last = 0;
  SECRET_PAIR.lastIndex = 0;
  for (let m = SECRET_PAIR.exec(s); m !== null; m = SECRET_PAIR.exec(s)) {
    const g = m.groups as Groups;
    const key = g.key!;
    if (!pairStart(s, m.index, key)) {
      SECRET_PAIR.lastIndex = m.index + 1;
      continue;
    }
    const at = m.index + m[0].length;
    const sep = (g.sep ?? '').trim();
    const v = pairValue(s, at, g.cq, bareEndOf(sep.includes('%')));
    if (v === null) continue;
    if (v.kind === 'bare') {
      const lit = LITERAL.exec(v.inner);
      if (lit && LITERAL_END.test(v.inner.slice(lit[0].length))) {
        SECRET_PAIR.lastIndex = at + lit[0].length;
        continue;
      }
      // «password:» в конце фразы — значения нет.
      if (v.inner === '' && !/=$|%(?:25)*3d/i.test(sep)) continue;
      if (sep.startsWith(':') && !g.cq && WEAK_PAIR_NAME.test(key)) continue;
    }
    out += s.slice(last, at) + v.open + HIDDEN + v.close;
    last = v.end;
    SECRET_PAIR.lastIndex = v.end;
  }
  return last === 0 ? s : out + s.slice(last);
}

/** Номера в парах: цифры по счёту, значение разбирается до конца. */
function maskPanPairs(s: string): string {
  let out = '';
  let last = 0;
  PAN_PAIR.lastIndex = 0;
  for (let m = PAN_PAIR.exec(s); m !== null; m = PAN_PAIR.exec(s)) {
    const g = m.groups as Groups;
    if (!pairStart(s, m.index, g.key!)) {
      PAN_PAIR.lastIndex = m.index + 1;
      continue;
    }
    const at = m.index + m[0].length;
    PAN_PAIR_DIGITS.lastIndex = at;
    const digits = PAN_PAIR_DIGITS.exec(s);
    const v: PairValue | null = digits
      ? { kind: 'bare', open: '', inner: digits[0], close: '', end: at + digits[0].length }
      : pairValue(s, at, g.cq, bareEndOf((g.sep ?? '').includes('%')));
    if (v === null) continue;
    const masked = maskPanAny(v.inner);
    if (masked !== v.inner) {
      out += s.slice(last, at) + v.open + masked + v.close;
      last = v.end;
    }
    PAN_PAIR.lastIndex = v.end;
  }
  return last === 0 ? s : out + s.slice(last);
}

/** Шаг 5: пары имя=значение и родственные записи. */
function maskPairs(s: string): string {
  let out = s;
  if (/password/i.test(out)) out = out.replace(CODEWORD_PAIR, (m) => m.replace(/(?<=(?:=>|=|:)[ \t]*)[^ \t][\s\S]*$/, HIDDEN));
  out = maskSecretPairs(out);
  if (/authorization/i.test(out)) {
    out = replaceNamed(out, AUTH_PAIR, (_m, g) => `${g.head}${g.q ?? ''}${g.scheme ?? ''}${HIDDEN}`);
  }
  return maskPanPairs(out);
}

export function maskText(s: string, keep: ReadonlySet<string>): string {
  let out = s;
  // 0. Заголовок Authorization в сыром HTTP: схема остаётся, значение — целиком ***.
  if (SECRET_HEADER_ANY.test(out)) {
    for (const re of AUTH_HTTP_HEADERS) {
      out = replaceNamed(out, re, (_m, g) => {
        const scheme = g.scheme ?? g.digest;
        return `${g.pre ?? ''}${g.head}${scheme ? `${scheme} ` : ''}${HIDDEN}`;
      });
    }
  }
  // 1. Схемы учётных данных в любом тексте.
  if (AUTH_SCHEME_ANY.test(out)) out = replaceNamed(out, AUTH_SCHEME, (_m, g) => (g.dg ? `${g.dg}${g.dsep}${HIDDEN}` : `${g.scheme}${g.sep}${g.dq ?? ''}${HIDDEN}`));
  // Учётные данные в адресе: scheme://***@host.
  out = maskUserinfo(out);
  // 2–3. Секреты, Authorization, номера карт и Value в FilterCondition по ключу JSON на любом уровне экранирования:
  // кавычки с косыми чертами, сущностями XML, \u0022 и в percent-encoding.
  if (out.includes('"')) out = maskJsonKeys(out, BS_RULES, 'bs', keep);
  if (ENT_QUOTE_ANY.test(out)) out = maskJsonKeys(out, ENT_RULES, 'ent', keep);
  if (PCT_QUOTE_ANY.test(out)) out = maskJsonKeys(out, PCT_RULES, 'pct', keep);
  // 4. Теги XML: секреты — ***, номера карт и Value — маска, в том числе в CDATA и в записи сущностями, %XX или \u003c.
  if (out.includes('<')) {
    out = maskXmlTags(out, keep);
    if (ATTR_ANY.test(out)) out = maskNamedTags(out, keep);
  }
  if (ENC_LT_ANY.test(out)) {
    out = maskXmlTagsEncoded(out, keep);
    if (ATTR_ANY.test(out)) out = maskNamedTagsEncoded(out, keep);
  }
  // 5. Пары имя=значение: form-urlencoded, строка запроса, текст.
  if (PAIR_ANY.test(out)) out = maskPairs(out);
  // 6. PAN по образцу с проверкой Луна; сначала — сразу после escape, оканчивающегося цифрой; затем группами.
  const pan = (d: string) => (!keep.has(d) && luhnValid(d) ? panOut(d) : d);
  if (out.includes('%') || out.includes('\\u')) out = out.replace(PAN_AFTER_ESCAPE, pan);
  out = out.replace(PAN_PATTERN, pan);
  out = out.replace(PAN_GROUPED, (m) => {
    // 4 группы и хвост, который в номер может и не входить: «4111 1112 3455 7893 12».
    const digits = digitsOf(m);
    const whole = digits.length <= 19 && !keep.has(digits) && luhnValid(digits);
    if (whole) return maskPanGrouped(m);
    const first = digits.slice(0, 16);
    return digits.length > 16 && !keep.has(first) && luhnValid(first) ? maskPanGrouped(m, 16) : m;
  });
  // 7. Номер, который соберёт браузер: сущности, \uXXXX, теги и невидимые символы между цифрами.
  return openingCards ? out : maskSplitCards(out, keep, hiddenDigit);
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Служебные поля ответа Threadline с цифрами (tsNs, id, pairId и firstRecordId записи вида «<tsNs>-<n>»).
 * Наносекунды из 19 цифр иначе в каждом десятом случае прошли бы проверку Луна и сломали бы ссылки на записи.
 * Под DATA_KEYS лежит содержимое лога: там такие имена — обычные данные.
 */
const SERVICE_FIELDS: Readonly<Record<string, RegExp>> = {
  tsNs: /^\d{1,20}$/,
  id: /^\d{1,20}-\d{1,9}$/,
  pairId: /^\d{1,20}-\d{1,9}$/,
  firstRecordId: /^\d{1,20}-\d{1,9}$/,
};
const DATA_KEYS: ReadonlySet<string> = new Set(['sections', 'context', 'payload', 'headers', 'body', 'raw']);

/** Где идёт обход: DATA — внутри содержимого лога, FILTER — внутри FilterCondition. */
const DATA = 1;
const FILTER = 2;

function setKey(o: Obj, k: string, v: unknown): void {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
}

function maskNumber(n: number, keep: ReadonlySet<string>): number | string {
  if (openingCards) return n;
  const a = Math.abs(n);
  if (!Number.isFinite(a) || a < 1e14) return n;
  // Знак и дробная часть номер не скрывают: цифры целой части те же.
  const int = Math.trunc(a);
  const d = String(int);
  if (!/^\d{15,19}$/.test(d) || keep.has(d)) return n;
  // Выше 2^53 JSON.parse уже округлил число: цифры не исходные, проверка Луна по ним ничего не значит.
  return !Number.isSafeInteger(int) || luhnValid(d) ? panOut(d) : n;
}

function maskPanValue(v: unknown, keep: ReadonlySet<string>, flags: number): unknown {
  if (typeof v === 'string') return maskText(maskPanAny(v), keep);
  if (typeof v === 'number') {
    const d = String(Math.trunc(Math.abs(v)));
    return !openingCards && /^\d{12,19}$/.test(d) ? panOut(d) : v;
  }
  if (Array.isArray(v)) return v.map((x) => maskPanValue(x, keep, flags));
  if (isObj(v)) {
    const out: Obj = {};
    for (const [k, x] of Object.entries(v)) {
      const sensitive = x !== null && x !== undefined && (isSecretName(k) || isAuthName(k));
      setKey(out, maskText(k, keep), sensitive ? maskEntry(k, x, keep, flags) : maskPanValue(x, keep, flags));
    }
    return out;
  }
  return v;
}

function maskAuthorization(v: unknown): unknown {
  if (typeof v === 'string') return maskAuthValue(v);
  if (Array.isArray(v)) return v.map(maskAuthorization);
  return HIDDEN;
}

function maskEntry(key: string, v: unknown, keep: ReadonlySet<string>, flags: number): unknown {
  if (v === null || v === undefined) return v;
  const inner = (DATA_KEYS.has(key) ? flags | DATA : flags) | (key.toLowerCase() === 'filtercondition' ? FILTER : 0);
  if (isSecretName(key)) return HIDDEN;
  if (isPanName(key)) return maskPanValue(v, keep, inner);
  if (isAuthName(key)) return maskAuthorization(v);
  // Value в FilterCondition SOAP-процессинга: полный PAN без проверки Луна, строкой или числом; другой регистр — внутри FilterCondition.
  if (key === 'Value' || (flags & FILTER && key.toLowerCase() === 'value')) {
    const shown = typeof v === 'string' ? v : typeof v === 'number' && Number.isInteger(v) && v >= 0 ? String(v) : '';
    const d = /^[\d\s./_+-]+$/.test(shown) ? shown.replace(/\D/g, '') : '';
    if (d.length >= 12 && d.length <= 19 && !keep.has(d)) return maskPanAny(shown);
  }
  const service = flags & DATA ? undefined : SERVICE_FIELDS[key];
  if (service && typeof v === 'string' && service.test(v)) return v;
  return walk(v, keep, inner);
}

/** Имя поля в значении соседнего: {"name":"Authorization","value":"…"}. */
function objectName(o: Obj): string | null {
  const name = o.name ?? o.Name ?? o.key ?? o.Key;
  return typeof name === 'string' && classifyName(name) !== null ? name : null;
}

function walk(v: unknown, keep: ReadonlySet<string>, flags: number): unknown {
  if (typeof v === 'string') return maskText(v, keep);
  if (typeof v === 'number') return maskNumber(v, keep);
  if (Array.isArray(v)) {
    // Плоский список заголовков, как rawHeaders у Node: значение идёт следующим элементом.
    return v.map((x, i) => {
      const prev: unknown = i > 0 ? v[i - 1] : null;
      if (flags & DATA && typeof x === 'string' && typeof prev === 'string' && isListedHeader(prev)) return isAuthName(prev) ? maskAuthValue(x) : HIDDEN;
      return walk(x, keep, flags);
    });
  }
  if (isObj(v)) {
    const out: Obj = {};
    const named = flags & DATA ? objectName(v) : null;
    for (const [k, x] of Object.entries(v)) {
      if (named !== null && (k === 'value' || k === 'Value')) setKey(out, k, maskEntry(named, x, keep, flags));
      else setKey(out, maskText(k, keep), maskEntry(k, x, keep, flags));
    }
    return out;
  }
  return v;
}

/** Новые объекты, исходные не меняются. Ключи-секреты — ***, PAN-ключи — маска, Authorization — схема и ***. */
export function maskDeep<T>(value: T, keep: ReadonlySet<string>): T {
  return walk(value, keep, 0) as T;
}

/**
 * Проход maskDeep, в котором номера карт остаются как есть, а секреты скрыты всеми теми же шагами.
 * Только синхронный вызов: флаг снимается в finally, в том числе при исключении внутри прохода.
 */
export function maskDeepOpeningCards<T>(value: T, keep: ReadonlySet<string>): T {
  openingCards = true;
  try {
    return walk(value, keep, 0) as T;
  } finally {
    openingCards = false;
  }
}

/** Значение fn и признак, скрыт ли за время её вызова хотя бы один номер карты. Только синхронный вызов. */
export function notingHiddenCards<T>(fn: () => T): { value: T; cardHidden: boolean } {
  const outer = cardHidden;
  cardHidden = false;
  try {
    const value = fn();
    return { value, cardHidden };
  } finally {
    cardHidden = outer;
  }
}
