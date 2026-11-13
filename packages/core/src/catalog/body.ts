// Чтение полей из тела и строки запроса: один readField для id, статуса операции и правил итога.

import { isAuthName, isPanName, isSecretName } from '../search/masking.ts';
import { BUILTIN_MASKING, normalizeFieldName } from '../search/mask-pass.ts';

export type ParsedBody = { kind: 'json'; value: unknown } | { kind: 'xml'; text: string } | { kind: 'none' };

/** Значение поля: нет поля; есть — строка, число, логическое, null или OBJECT для объекта и массива. */
export type FieldValue = { found: false } | { found: true; value: string | number | boolean | null | typeof OBJECT };

/** Метка объекта или массива: для «равно», «одно из» и выражения это «значения нет». */
export const OBJECT: unique symbol = Symbol('object');

const NONE: ParsedBody = { kind: 'none' };
const MISSING: FieldValue = { found: false };

export function parseBody(body: string | null | undefined): ParsedBody {
  if (!body) return NONE;
  const s = body.trim();
  if (s.startsWith('{') || s.startsWith('[')) {
    try {
      return { kind: 'json', value: JSON.parse(s) };
    } catch {
      return NONE;
    }
  }
  if (s.startsWith('<')) return { kind: 'xml', text: s };
  return NONE;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function fromJson(v: unknown): FieldValue {
  if (v === undefined) return MISSING;
  if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return { found: true, value: v };
  return { found: true, value: OBJECT };
}

const ESC = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeXml(s: string): string {
  return s.replace(/&(lt|gt|amp|quot|apos);/g, (_m, e: string) => ENTITIES[e]!);
}

const XML_TAG = /<(\/?)(?:[\w.-]+:)?([\w.-]+)(?:\s[^<>]*)?>/g;

/** Лежит ли позиция внутри элемента с секретом, номером или полем вида маски: маска скрывает такой элемент целиком. */
function underSensitive(text: string, at: number): boolean {
  const stack: string[] = [];
  XML_TAG.lastIndex = 0;
  for (let m = XML_TAG.exec(text); m !== null && m.index < at; m = XML_TAG.exec(text)) {
    if (m[1]) stack.pop();
    else if (!m[0].endsWith('/>')) stack.push(m[2]!);
  }
  return stack.some((n) => isSecretName(n) || isPanName(n) || isAuthName(n) || BUILTIN_MASKING.strict.fields.has(normalizeFieldName(n)));
}

/** Первый элемент XML с таким локальным именем: текст, null при xsi:nil, OBJECT при дочерних элементах. */
function fromXml(text: string, name: string): FieldValue {
  const open = new RegExp(`<(?:[\\w.-]+:)?${ESC(name)}(?=[\\s/>])([^>]*)>`);
  const m = open.exec(text);
  if (!m) return MISSING;
  if (underSensitive(text, m.index)) return { found: true, value: OBJECT };
  const attrs = m[1] ?? '';
  if (/\bnil\s*=\s*["']true["']/.test(attrs)) return { found: true, value: null };
  if (attrs.trimEnd().endsWith('/')) return { found: true, value: '' };
  const rest = text.slice(m.index + m[0].length);
  const close = new RegExp(`</(?:[\\w.-]+:)?${ESC(name)}\\s*>`).exec(rest);
  if (!close) return MISSING;
  const inner = rest.slice(0, close.index);
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(inner);
  if (cdata) return { found: true, value: cdata[1]! };
  if (inner.includes('<')) return { found: true, value: OBJECT };
  return { found: true, value: decodeXml(inner) };
}

/** Поле тела: JSON — путь через точку по объектам, без массивов; XML — локальное имя (последний сегмент пути). */
export function readField(body: ParsedBody, path: string): FieldValue {
  if (body.kind === 'json') {
    let cur: unknown = body.value;
    for (const key of path.split('.')) {
      if (!isObj(cur) || !Object.hasOwn(cur, key)) return MISSING;
      cur = cur[key];
    }
    return fromJson(cur);
  }
  if (body.kind === 'xml') return fromXml(body.text, path.slice(path.lastIndexOf('.') + 1));
  return MISSING;
}

/** Параметр строки запроса по имени; первое значение. */
export function readQuery(query: string | null, name: string): FieldValue {
  if (!query) return MISSING;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(query);
  } catch {
    return MISSING;
  }
  const v = params.get(name);
  return v === null ? MISSING : { found: true, value: v };
}

/** Строка значения поля для сравнения и подстановки: строка, число и логическое; остальное — null. */
export function scalarText(v: FieldValue): string | null {
  if (!v.found) return null;
  const x = v.value;
  return typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean' ? String(x) : null;
}
