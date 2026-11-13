// Признаки бизнес-ошибки в теле ответа внешней системы.
// Отдельный модуль: им пользуются и records.ts (isError записи), и status.ts (причины запроса).
import { withoutHtml } from './html-text.ts';
import { maskText } from './masking.ts';
import { BUILTIN_MASKING, maskKindsText } from './mask-pass.ts';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

interface Found {
  marker: string;
  code: unknown;
  message: string | null;
  text: string;
}

const MAX_TEXT = 200;
const MAX_DEPTH = 6;

const RESPONSE_CODE = /<(?:[\w.-]+:)?response_code>\s*(-?\d+)/g;
const ERROR_DESCRIPTION = /<(?:[\w.-]+:)?error_description>([^<]*)</;
const CARD_ACTION =
  /<(?:[\w.-]+:)?type>\s*card\s*<\/(?:[\w.-]+:)?type>\s*<(?:[\w.-]+:)?actionCode>\s*(\w+)\s*<\/(?:[\w.-]+:)?actionCode>(?:\s*<(?:[\w.-]+:)?actionDescription>([^<]*)<)?/g;

/**
 * Бизнес-ошибка ответа. `text` — строка причины без справочника: маскирована и обрезана. `code` и `message` — без
 * маскирования: подстрока правила справочника сравнивается с исходным текстом, в браузер они не уходят.
 */
export interface BusinessError {
  /** Какой признак сработал: `error`, `result`, `response_code`, `actionCode` и другие. */
  marker: string;
  code: string | null;
  message: string | null;
  text: string;
  /** В тексте была страница HTML: `text` без неё, а этот со страницей. Ключ строки «Неизвестного» считается от него и не меняется. */
  keyText?: string;
}

/** Текст бизнес-ошибки в теле ответа внешней системы или null. */
export function businessError(body: string): string | null {
  return businessFact(body)?.text ?? null;
}

/** Бизнес-ошибка в теле ответа внешней системы или null. */
export function businessFact(body: string): BusinessError | null {
  const s = body.trim();
  if (s === '') return null;
  if (s[0] === '{' || s[0] === '[') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(s);
    } catch {
      parsed = undefined;
    }
    if (parsed !== undefined) return clip(jsonError(parsed));
  }
  if (s.includes('<')) return clip(xmlError(s));
  return null;
}

function jsonError(v: unknown): Found | null {
  if (isObj(v)) {
    if (nonEmpty(v.error)) return errorField(v.error);
    if (v.result === 'error') return found('result', v.code ?? v.error_code ?? null, messageOf(v), v.code ?? v.error_code ?? 'error');
    if (v.success === false) return found('success', null, messageOf(v), false);
    if ('res' in v && 'error' in v && Number(v.res) !== 0) return found('res', v.res, messageOf(v));
    if (v.result_code != null && v.result_code !== 'GOOD') return found('result_code', v.result_code, messageOf(v));
    if (v.transStatus === 'N') return found('transStatus', 'N', str(v.transStatusReason));
    const info = isObj(v.resultInfo) ? v.resultInfo : null;
    if (info && info.code != null && Number(info.code) !== 0) return found('resultInfo.code', info.code, messageOf(info));
  }
  return cardStatusError(v, 0);
}

/** statuses.item, где type = card и actionCode не 000. card2 и прочие типы не смотрим. */
function cardStatusError(v: unknown, depth: number): Found | null {
  if (depth > MAX_DEPTH || typeof v !== 'object' || v === null) return null;
  const children = Array.isArray(v) ? v : Object.values(v);
  if (isObj(v) && isObj(v.statuses)) {
    const item = v.statuses.item;
    const items = Array.isArray(item) ? item : isObj(item) ? [item] : [];
    for (const it of items) {
      if (isObj(it) && it.type === 'card' && it.actionCode != null && String(it.actionCode) !== '000') {
        return found('actionCode', it.actionCode, str(it.actionDescription));
      }
    }
  }
  for (const c of children) {
    const e = cardStatusError(c, depth + 1);
    if (e) return e;
  }
  return null;
}

function xmlError(s: string): Found | null {
  for (const m of s.matchAll(RESPONSE_CODE)) {
    if (Number(m[1]) !== 0) return found('response_code', m[1], ERROR_DESCRIPTION.exec(s)?.[1]?.trim() || null);
  }
  for (const m of s.matchAll(CARD_ACTION)) {
    if (m[1] !== '000') return found('actionCode', m[1], m[2]?.trim() || null);
  }
  return null;
}

function nonEmpty(e: unknown): boolean {
  if (typeof e === 'string') return e.trim() !== '';
  if (Array.isArray(e)) return e.length > 0;
  return isObj(e) && Object.keys(e).length > 0;
}

/** Признак непустого поля error: строка, объект с кодом или текстом, иначе JSON как есть. */
function errorField(e: unknown): Found {
  if (typeof e === 'string') return { marker: 'error', code: null, message: e, text: `error: ${e}` };
  if (isObj(e)) {
    const code = e.code ?? e.errorCode ?? e.error_code ?? null;
    const msg = messageOf(e);
    if (code != null || msg) return found('error', code, msg);
  }
  return { marker: 'error', code: null, message: null, text: `error: ${JSON.stringify(e)}` };
}

/** Найденный признак до маскирования. `shown` — что написать в тексте, если это не код: «success: false». */
function found(marker: string, code: unknown, message: string | null, shown: unknown = code): Found {
  return { marker, code, message, text: describe(marker, shown, message) };
}

function describe(name: string, code: unknown, message: string | null): string {
  if (code == null) return message ? `${name}: ${message}` : name;
  const c = typeof code === 'object' ? JSON.stringify(code) : String(code);
  return message ? `${name} ${c}: ${message}` : `${name}: ${c}`;
}

function messageOf(o: Obj): string | null {
  for (const k of ['message', 'description', 'errorMessage', 'error_message', 'error_description', 'title']) {
    const v = str(o[k]);
    if (v) return v;
  }
  if (Array.isArray(o.errors)) {
    const first: unknown = o.errors[0];
    if (typeof first === 'string') return first;
    if (isObj(first)) return str(first.message);
  }
  return null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

const NO_KEEP: ReadonlySet<string> = new Set();

/** Маскирование до обрезки: срез посреди номера карты или секрета маскирование на выходе уже не узнает. */
function maskedLine(s: string): string {
  const one = maskKindsText(maskText(s, NO_KEEP), BUILTIN_MASKING.strict, NO_KEEP).replace(/\s+/g, ' ');
  return one.length > MAX_TEXT ? one.slice(0, MAX_TEXT - 1) + '…' : one;
}

function clip(f: Found | null): BusinessError | null {
  if (f === null) return null;
  const { code } = f;
  const readable = withoutHtml(f.text);
  return {
    marker: f.marker,
    code: code === null || code === undefined ? null : typeof code === 'object' ? JSON.stringify(code) : String(code),
    message: f.message,
    text: maskedLine(readable),
    ...(readable === f.text ? {} : { keyText: maskedLine(f.text) }),
  };
}
