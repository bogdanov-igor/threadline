// Собственные секреты Threadline: их не показывает никому ни один ответ.
// Подмена нужна, потому что у записи, которая несёт токен Grafana или пароль Loki, поле может называться как угодно.
// Строки логов проходят её при чтении из хранилища (backends/registry.ts), ответ показа ещё раз: значения нет ни в одном пути выдачи.
import type { OpenRecord } from '@threadline/core/search';
import type { ResolvedConfig } from '../config/load.ts';

const HIDDEN = '***';
const OWN_ENV = ['THREADLINE_OIDC_CLIENT_SECRET', 'THREADLINE_SESSION_SECRET', 'THREADLINE_TELEGRAM_BOT_TOKEN'] as const;
/** Короче секретов не бывает: у такого значения подмена портила бы сами записи. */
const MIN_SECRET = 6;

/** Пароль из адреса базы: как записан и раскодированный. Адрес, который не разобрать, секрета не даёт: он есть и в его значении как есть. */
function databasePassword(url: string | undefined): string[] {
  if (!url?.trim()) return [];
  try {
    const { password } = new URL(url);
    return password ? [password, decodeURIComponent(password)] : [];
  } catch {
    return [url];
  }
}

/** Значения собираются при старте. Переменная не задана — подмены для неё нет. */
export function ownSecrets(config: ResolvedConfig, env: NodeJS.ProcessEnv = process.env): string[] {
  const values = [
    ...Object.values(config.backends).flatMap((b) => [('token' in b ? b.token : undefined), ('password' in b ? b.password : undefined)]),
    ...OWN_ENV.map((name) => env[name]),
    ...databasePassword(env.THREADLINE_DATABASE_URL),
  ];
  return [...new Set(values.map((v) => v?.trim()).filter((v): v is string => !!v && v.length >= MIN_SECRET))];
}

const R = String.raw;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hexDigit = (h: string) => (/[a-f]/.test(h) ? `[${h}${h.toUpperCase()}]` : h);

/** Один символ в любой записи: как есть, в percent-encoding любого уровня и регистра, с экранированием JSON любого уровня. */
function charForms(ch: string): string {
  if (/^[A-Za-z0-9]$/.test(ch)) return ch;
  const hex = [...Buffer.from(ch, 'utf8')].map((b) => b.toString(16).padStart(2, '0'));
  const forms = [escapeRe(ch), hex.map((h) => `%(?:25){0,4}${hexDigit(h[0]!)}${hexDigit(h[1]!)}`).join('')];
  if (ch === '"' || ch === '/') forms.push(R`\\{1,15}${escapeRe(ch)}`);
  if (ch === '\\') forms.push(R`\\{2,16}`);
  if (ch === ' ') forms.push(R`\+`);
  if (ch.charCodeAt(0) > 0x7f) forms.push(R`\\{1,8}u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return `(?:${forms.join('|')})`;
}

const base64Forms = (s: string) => {
  const std = Buffer.from(s, 'utf8').toString('base64');
  return [std, std.replace(/=+$/, ''), Buffer.from(s, 'utf8').toString('base64url')];
};

/**
 * Неизменная часть base64 значения при любом выравнивании в строке. Без неё пришлось бы раскодировать каждое длинное слово каждой строки лога.
 * Первые знаки при сдвиге и последний неполный зависят от соседних байтов.
 */
function base64Cores(s: string): string[] {
  const bytes = Buffer.from(s, 'utf8');
  return [0, 1, 2].flatMap((pad) => {
    const b64 = Buffer.concat([Buffer.alloc(pad), bytes]).toString('base64').replace(/=+$/, '');
    const core = b64.slice([0, 2, 3][pad]!, b64.length - ((pad + bytes.length) % 3 === 0 ? 0 : 1));
    return [core, core.replace(/\+/g, '-').replace(/\//g, '_')];
  });
}

export interface OwnSecretScrubber {
  (text: string): string;
}

/** Что перед строкой base64 слилось с ней и остаётся на месте: буквы %0A, \n и \u000a, схема с + вместо пробела. */
function headLength(text: string, at: number, run: string): number {
  if (text[at - 1] === '%') return /^(?:25){0,4}[0-9A-Fa-f]{2}/.exec(run)?.[0].length ?? 0;
  if (text[at - 1] === '\\') return /^(?:u[0-9A-Fa-f]{4}|[nrt])/.exec(run)?.[0].length ?? 0;
  return /^(?:basic|bearer|digest)\+/i.exec(run)?.[0].length ?? 0;
}

/**
 * Подмена по списку значений: как есть, в percent-encoding, экранировании JSON и base64. Выражение из одних значений: проход линейный.
 * Строка base64 раскодируется целиком: внутри бывает «логин:секрет», и base64 всей строки не равен base64 секрета. С разделителем слева строка
 * могла слиться, поэтому раскодируется от четырёх начал: одно из них совпадёт с её настоящим началом.
 */
export function ownSecretScrubber(secrets: readonly string[]): OwnSecretScrubber {
  if (secrets.length === 0) return (text) => text;
  const forms = new Set(secrets.flatMap((s) => [[...s].map(charForms).join(''), ...base64Forms(s).map(escapeRe)]));
  const any = new RegExp([...forms].sort((a, b) => b.length - a.length).join('|'), 'g');
  const inBase64 = new RegExp([...new Set(secrets.flatMap(base64Cores))].map(escapeRe).join('|'));
  const run = /[A-Za-z0-9+/_-]{6,}={0,2}/g;
  const holdsSecret = (b64: string) => {
    for (let from = 0; from < 4; from++) {
      const text = Buffer.from(b64.slice(from), 'base64').toString('utf8');
      if (secrets.some((s) => text.includes(s))) return true;
    }
    return false;
  };
  return (text) => {
    const decoded = inBase64.test(text)
      ? text.replace(run, (m: string, at: number) => (holdsSecret(m) ? `${m.slice(0, headLength(text, at, m))}${HIDDEN}` : m))
      : text;
    return decoded.replace(any, HIDDEN);
  };
}

function scrubDeep(v: unknown, scrub: OwnSecretScrubber): unknown {
  if (typeof v === 'string') return scrub(v);
  if (typeof v === 'number') {
    const text = String(v);
    return scrub(text) === text ? v : HIDDEN;
  }
  if (Array.isArray(v)) return v.map((x) => scrubDeep(x, scrub));
  if (typeof v === 'object' && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [scrub(k), scrubDeep(x, scrub)]));
  return v;
}

/** Содержимое записи в ответе показа после подмены. */
export function scrubOwnSecrets(r: OpenRecord, scrub: OwnSecretScrubber): OpenRecord {
  return { id: r.id, uri: r.uri === null ? null : scrub(r.uri), sections: scrubDeep(r.sections, scrub) as OpenRecord['sections'], raw: scrub(r.raw) };
}
