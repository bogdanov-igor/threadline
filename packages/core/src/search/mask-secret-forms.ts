// Секреты в записях текста, которых нет у первого прохода: двоеточие посреди текста, пробел, флаг команды, разметка, адрес и образец значения.
// Работает во втором проходе, пока вид «Секреты» не открыт зрителю, поэтому показ аналитика открывает их так же, как остальные секреты.
// masking.ts заморожен, поэтому они здесь.

import { HIDDEN, isAuthName, P25, pairValue, type PairValue } from './masking.ts';

const R = String.raw;

export interface SecretForms {
  /** Имя принадлежит виду «Секреты». */
  isSecret: (name: string) => boolean;
  /** Что пишется вместо значения. Готовую маску оставляет как есть. */
  hide: (raw: string) => string;
}

const NAME_CHAR = /[\w.-]/;

/** Имя перед разделителем пары: идём назад от него. Перед именем бывает %XX, \n или \uXXXX: их буквы и цифры не часть имени. */
export function nameBefore(s: string, sepAt: number): { name: string; cq: string | undefined } | null {
  let end = sepAt;
  let cq: string | undefined;
  const ch = s[end - 1];
  if (ch === '"' || ch === "'") {
    let b = end - 1;
    while (b > 0 && s[b - 1] === '\\') b--;
    cq = s.slice(b, end);
    end = b;
  } else if (ch === ']') {
    end--;
    // Значение поля формы PHP: password[]=, phone[0]=.
    const index = /\[\d{0,6}$/.exec(s.slice(Math.max(0, end - 8), end));
    if (index) end -= index[0].length;
  } else {
    const closer = /%(?:25)*5[Dd]$/.exec(s.slice(Math.max(0, end - 12), end));
    if (closer) {
      end -= closer[0].length;
      const index = /%(?:25)*5[Bb]\d{0,6}$/.exec(s.slice(Math.max(0, end - 18), end));
      if (index) end -= index[0].length;
    }
  }
  let start = end;
  while (start > 0 && end - start < 80 && NAME_CHAR.test(s[start - 1]!)) start--;
  if (start === end) return null;
  let run = s.slice(start, end);
  const before = s[start - 1];
  if (before === '%') run = run.replace(/^(?:25){0,4}[0-9A-Fa-f]{2}/, '');
  else if (before === '\\') run = run.replace(/^(?:u[0-9A-Fa-f]{4}|[nrt])/, '');
  return run.length >= 1 && run.length <= 64 && /^[A-Za-z_]/.test(run) ? { name: run, cq } : null;
}

// Значение секрета без кавычек идёт до пробела, как у первого прохода.
const BARE_END = /[\s&"]|\\+(?:u0026|[rnt"])/g;
const BARE_END_ENC = new RegExp(R`[\s&"+]|%${P25}(?:26|20)|\\+(?:u0026|[rnt"])`, 'g');

export const secretEnd =
  (encoded: boolean) =>
  (t: string, at: number): number => {
    const re = encoded ? BARE_END_ENC : BARE_END;
    re.lastIndex = at;
    return re.exec(t)?.index ?? t.length;
  };

const COLON = new RegExp(R`:|%${P25}3[Aa]|&(?:amp;){0,4}#(?:0*58|x0*3[Aa]);|\\u003[Aa]`, 'g');
const CYRILLIC_NAME = /(?<![\p{L}\p{N}_-])(?:парол[ья]|пин(?:[- ]?код)?|токен|секрет)[ \t]*[:=]/giu;
/** Такие слова бывают и в обычном тексте: «invalid token: expired». Обычное слово за ними значением не считается. */
const WEAK_NAMES: ReadonlySet<string> = new Set(['token', 'cookie']);
const PLAIN_WORD = /^\p{L}\p{Ll}{0,19}[.,;:!?)]*$/u;
const CYRILLIC_WORD = /^[\p{Script=Cyrillic}-]+[.,;:!?)]*$/u;
const LITERAL = /^(?:null|true|false)[,;)}\]]*$/;
const CLOSING_TAGS = /^(?:<\\*\/[\w.:-]+>)+$/;
const NEXT_LINE = /(?:\r?\n|\\+r(?:\\+n)?|\\+n)[ \t]*/y;
const QUOTE_AHEAD = /[ \t]*(?:\\*["']|&(?:amp;)*quot;)/y;

/** Значение пары. За двоеточием бывает перевод строки или закрывающий тег: `password:\nS`, `<b>token:</b> S`. */
function valueAfter(s: string, from: number, encoded: boolean, cq: string | undefined): { at: number; v: PairValue } | null {
  let at = from;
  while (s[at] === ' ' || s[at] === '\t') at++;
  if (s[at] === '/' || s.startsWith('\\/', at)) return null;
  const end = secretEnd(encoded);
  const v = pairValue(s, at, cq, end);
  if (v === null) return null;
  if (v.kind !== 'bare' || (v.inner !== '' && !CLOSING_TAGS.test(v.inner))) return { at, v };
  let next = v.end;
  NEXT_LINE.lastIndex = next;
  const line = NEXT_LINE.exec(s);
  if (line) next += line[0].length;
  else {
    if (v.inner === '') return null;
    while (s[next] === ' ' || s[next] === '\t') next++;
  }
  const after = pairValue(s, next, undefined, end);
  return after === null || (after.kind === 'bare' && after.inner === '') ? null : { at: next, v: after };
}

/** `имя: значение` посреди текста, в YAML и в карте Go: первый проход берёт двоеточие не у всех имён. */
function maskColons(s: string, f: SecretForms): string {
  let out = '';
  let last = 0;
  COLON.lastIndex = 0;
  for (let m = COLON.exec(s); m !== null; m = COLON.exec(s)) {
    let end = m.index;
    while (end > 0 && m.index - end < 4 && (s[end - 1] === ' ' || s[end - 1] === '\t')) end--;
    const head = nameBefore(s, end);
    if (!head || !f.isSecret(head.name)) continue;
    // Значение Authorization без кавычек со схемой разбирает первый проход. Проверка раньше просмотра значения: без неё серия таких имён без пробелов просматривала бы текст заново.
    QUOTE_AHEAD.lastIndex = m.index + m[0].length;
    if (isAuthName(head.name) && !QUOTE_AHEAD.test(s)) continue;
    const found = valueAfter(s, m.index + m[0].length, m[0].includes('%'), head.cq);
    if (!found) continue;
    const { at, v } = found;
    if (v.kind === 'bare' && (LITERAL.test(v.inner) || (WEAK_NAMES.has(head.name.toLowerCase()) && PLAIN_WORD.test(v.inner)))) continue;
    const masked = f.hide(v.inner);
    if (masked !== v.inner) {
      out += s.slice(last, at) + v.open + masked + v.close;
      last = v.end;
    }
    COLON.lastIndex = Math.max(v.end, COLON.lastIndex);
  }
  return last === 0 ? s : out + s.slice(last);
}

/** То же с русским именем. Русское слово за ним значением не считается: «Неверный пароль: проверьте раскладку». */
function maskCyrillicNames(s: string, f: SecretForms): string {
  let out = '';
  let last = 0;
  CYRILLIC_NAME.lastIndex = 0;
  for (let m = CYRILLIC_NAME.exec(s); m !== null; m = CYRILLIC_NAME.exec(s)) {
    const found = valueAfter(s, m.index + m[0].length, false, undefined);
    if (!found) continue;
    const { at, v } = found;
    if (v.kind === 'bare' && (LITERAL.test(v.inner) || CYRILLIC_WORD.test(v.inner))) continue;
    const masked = f.hide(v.inner);
    if (masked !== v.inner) {
      out += s.slice(last, at) + v.open + masked + v.close;
      last = v.end;
    }
    CYRILLIC_NAME.lastIndex = Math.max(v.end, CYRILLIC_NAME.lastIndex);
  }
  return last === 0 ? s : out + s.slice(last);
}

// Без разделителя: `pin 7788`, `cvv 987`. Цифры за таким именем значением считаются всегда, в том числе номер: это не номер карты, а ПИН.
const PIN_DIGITS = /(?<![\p{L}\p{N}_-])(pin(?:[-_ ]?code)?|пин(?:[- ]?код)?|cv[vc]2?)([ \t]+)[\d*]{3,19}(?![\p{L}\p{N}*])/giu;
// Слово за именем: `password is S`, `password - S`, `cvv S`. Обычное слово («password is required») значением не считается.
const SPACED_VALUE = /(?<![\p{L}\p{N}_-])(pass(?:word|wd|code|phrase)|pwd|парол[ья]|cv[vc]2?|pin|secret)((?:[ \t]+(?:is|[-–—]))?[ \t]+)((?!\*\*\*(?:\s|$))[^\s"'<>()[\]{}\\]+)/giu;
const SPACED_HINT = /pass|pwd|парол|пин|pin|cv[vc]|secret/i;
const CLI_FLAG = /(?<![\w-])--([A-Za-z][\w-]{1,40})([ \t]+|=)(?!-)([^\s"'\\]+)/g;
const CLI_USER = /(?<![\w-])(-u|--user)([ \t]+|=)[^\s"':\\]{1,64}:[^\s"'\\]+/g;

function secretShaped(word: string): boolean {
  const w = word.replace(/[.,;:!?]+$/, '');
  return w.length >= 3 && (/\d/.test(w) || /\p{Ll}\p{Lu}/u.test(w) || /[^\p{L}\p{M}-]/u.test(w));
}

// Первый проход принял закрывающий тег за значение: `<b>password:*** S`.
const AFTER_TAG = /(<[A-Za-z][\w.:-]*(?:\s[^<>]*)?>[ \t]*[\w.-]{0,40}(?:pass(?:word|wd)|pin|secret|cv[vc]2?)[ \t]*[:=]\*\*\*[ \t]+)[^\s<"]+/gi;
// Первый проход остановился на кавычке: `Authorization=***&quot;S&quot;`, `{Authorization:***"S", x: 1}`.
const AUTH_ENTITY = /(authorization(?:=|%(?:25)*3[Dd]))\*\*\*(&(?:amp;)*(?:quot|#0*34|#x0*22);)[^&]*\2/gi;
const AUTH_QUOTE = /(authorization[ \t]*:)\*\*\*(\\*["'])[^"'\r\n]*\2/gi;
const JWT = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*)?/g;
const PEM = /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]{0,40}PRIVATE KEY-----|$)/g;
const BARE_HOST = /[\w-]{1,64}(?=[\s"'<>,;)\\]|$)/y;
const BARE_USER = /(?:^|[=,;([{])([\w.+-]{1,64}):/;
const MAX_USERINFO = 320;
const ENT_USERINFO = /((?:&#0*47;|&#x0*2[Ff];){2})[^\s&"'<>]{1,256}(?=&#(?:0*64|x0*40);)/g;
const ESCAPED_AT_USERINFO = /(\/\/)[^\s&"'<>]{1,256}(?=\\+u0040)/g;

// Тег с именем секрета в атрибуте: <input type="password" value="S">, <meta name="csrf-token" content="S">, <field id="password">S</field>.
const TAG = /<([A-Za-z][\w.:-]{0,63})(\s[^<>]{0,2048})>([^<]{0,8192})/g;
const TAG_NAME_ATTR = /(?:^|\s)(?:name|id|key|type|property)\s*=\s*\\*["']?([\w.:-]{1,64})/gi;
const TAG_VALUE_ATTR = /(\s(?:value|content)\s*=\s*)(\\*["'])([\s\S]*?)\2/gi;
const VOID_TAG = /^(?:input|meta|img|link|br|hr)$/i;

// Имя и значение в соседних элементах: <name>password</name><value>S</value>, <td>Password</td><td>S</td>, <dt>…</dt><dd>…</dd>.
const elementPairs = (lt: string, gt: string, text: string) => {
  const ws = R`(?:\s|\\+[nrt]){0,16}`;
  const key = R`(?<key>[\w.-](?:[\w. -]{0,62}[\w.-])?)`;
  const element = R`${lt}[A-Za-z][\w.:-]{0,63}${gt}${text}${lt}\\*/[A-Za-z][\w.:-]{0,63}${gt}${ws}`;
  const nameEl = R`${lt}(?<n>name|key|field|td|th|dt)${gt}${ws}${key}${ws}:?${ws}${lt}\\*/\k<n>${gt}${ws}`;
  const valueEl = R`${lt}(?<v>value|val|td|dd)${gt}`;
  return {
    forward: new RegExp(R`(?<head>${nameEl}(?:${element}){0,2}${valueEl})(?<value>${text})`, 'gi'),
    backward: new RegExp(R`(?<open>${lt}(?<a>value|val)${gt})(?<value>${text})(?<tail>${lt}\\*/\k<a>${gt}${ws}${lt}(?<b>name|key|field)${gt}${ws}${key}${ws}${lt}\\*/\k<b>${gt})`, 'gi'),
  };
};
const PLAIN_PAIRS = elementPairs('<', '>', '[^<]{1,8192}');
const ENT_PAIRS = elementPairs('&lt;', '&gt;', '(?:(?!&lt;)[^<]){1,8192}');

/** Адрес без схемы, хост из одного слова и текст за ним: `connect u:S@dbhost failed`. Хост с точкой и адрес со схемой разбирает первый проход. Просмотр идёт от «@» назад. */
function maskBareUserinfo(s: string, f: SecretForms): string {
  let out = '';
  let last = 0;
  for (let at = s.indexOf('@'); at >= 0; at = s.indexOf('@', at + 1)) {
    BARE_HOST.lastIndex = at + 1;
    if (!BARE_HOST.test(s)) continue;
    let start = at;
    while (start > last && at - start < MAX_USERINFO && !/[\s"'<>@]/.test(s[start - 1]!)) start--;
    const word = s.slice(start, at);
    const user = BARE_USER.exec(word);
    if (!user) continue;
    const from = user.index + user[0].length;
    const value = word.slice(from);
    if (value === '' || value.includes(HIDDEN) || user[1]!.toLowerCase() === 'mailto' || /^\d{1,5}$/.test(value)) continue;
    out += s.slice(last, start + user.index + user[0].length - user[1]!.length - 1) + f.hide(value);
    last = at;
  }
  return last === 0 ? s : out + s.slice(last);
}

type Named = Record<string, string>;

function maskElementPairs(s: string, pairs: typeof PLAIN_PAIRS, f: SecretForms): string {
  const forward = s.replace(pairs.forward, (...args: unknown[]) => {
    const g = args[args.length - 1] as Named;
    return f.isSecret(g.key!) ? `${g.head}${f.hide(g.value!)}` : (args[0] as string);
  });
  return forward.replace(pairs.backward, (...args: unknown[]) => {
    const g = args[args.length - 1] as Named;
    return f.isSecret(g.key!) ? `${g.open}${f.hide(g.value!)}${g.tail}` : (args[0] as string);
  });
}

/** Все записи секрета вне первого прохода. Каждое выражение линейно: просмотр назад короткий, просмотр вперёд ограничен. */
export function maskSecretForms(s: string, f: SecretForms): string {
  let out = maskColons(s, f);
  if (/[а-яё]/i.test(out)) out = maskCyrillicNames(out, f);
  if (SPACED_HINT.test(out)) {
    out = out.replace(PIN_DIGITS, (_m, name: string, gap: string) => `${name}${gap}${f.hide('value')}`);
    out = out.replace(SPACED_VALUE, (m, name: string, gap: string, value: string) => (secretShaped(value) ? `${name}${gap}${f.hide(value)}` : m));
    if (out.includes('***')) out = out.replace(AFTER_TAG, (_m, head: string) => `${head}${f.hide('value')}`);
  }
  if (out.includes('--') || out.includes('-u')) {
    out = out.replace(CLI_FLAG, (m, name: string, gap: string, value: string) => (f.isSecret(name) ? `--${name}${gap}${f.hide(value)}` : m));
    out = out.replace(CLI_USER, (_m, flag: string, gap: string) => `${flag}${gap}${f.hide('value')}`);
  }
  if (out.includes('***&')) out = out.replace(AUTH_ENTITY, (_m, head: string, q: string) => `${head}${q}${f.hide('value')}${q}`);
  if (out.includes(':***')) out = out.replace(AUTH_QUOTE, (_m, head: string, q: string) => `${head} ${q}${f.hide('value')}${q}`);
  if (out.includes('eyJ')) out = out.replace(JWT, () => f.hide('value'));
  if (out.includes('PRIVATE KEY')) out = out.replace(PEM, () => f.hide('value'));
  if (out.includes('@')) out = maskBareUserinfo(out, f);
  if (out.includes('&#')) out = out.replace(ENT_USERINFO, (_m, slashes: string) => `${slashes}${f.hide('value')}`);
  if (out.includes('u0040')) out = out.replace(ESCAPED_AT_USERINFO, (_m, slashes: string) => `${slashes}${f.hide('value')}`);
  if (out.includes('<')) {
    out = out.replace(TAG, (m, name: string, attrs: string, body: string) => {
      if (!attrs.includes('=') || ![...attrs.matchAll(TAG_NAME_ATTR)].some((a) => f.isSecret(a[1]!))) return m;
      const open = attrs.replace(TAG_VALUE_ATTR, (_a, head: string, q: string, v: string) => `${head}${q}${f.hide(v)}${q}`);
      const noBody = VOID_TAG.test(name) || attrs.endsWith('/') || body.trim() === '';
      return `<${name}${open}>${noBody ? body : f.hide(body)}`;
    });
    out = maskElementPairs(out, PLAIN_PAIRS, f);
  }
  if (out.includes('&lt;')) out = maskElementPairs(out, ENT_PAIRS, f);
  return out;
}
