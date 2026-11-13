// Декодеры слоёв: json, text, http. Нераскрытый слой — undefined.
import { parseHttpMessage } from '../search/http.ts';

export type Obj = Record<string, unknown>;
export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Предел входа слоя text: защита памяти. От перебора защищает линейный движок V8. */
export const TEXT_MAX = 64 * 1024;

/**
 * Целое больше 2^53 — строкой исходных цифр: JSON.parse округлил бы его, длинный номер показался бы с чужими
 * цифрами, а номер карты числом прошёл бы мимо проверки Луна.
 */
function exactInts(_key: string, v: unknown, ctx?: { source?: string }): unknown {
  return typeof v === 'number' && !Number.isSafeInteger(v) && ctx?.source !== undefined && /^-?\d+$/.test(ctx.source)
    ? ctx.source
    : v;
}

/** Объект JSON из строки; null — не объект или не разбирается. */
export function parseJsonObject(s: string): Obj | null {
  if (!s.trimStart().startsWith('{')) return null;
  try {
    // Целое больше 2^53 — не меньше 16 цифр подряд; без них разбор без reviver, он быстрее.
    const v: unknown = /\d{16}/.test(s) ? JSON.parse(s, exactInts) : JSON.parse(s);
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
}

/** json: строка с объектом JSON или уже разобранный объект. */
export function decodeJson(input: unknown): Obj | undefined {
  if (typeof input === 'string') return parseJsonObject(input) ?? undefined;
  return isObj(input) ? input : undefined;
}

/** text: именованные группы совпадения; не совпавшие группы отсутствуют. Поиск по строке, якоря ставит автор. */
export function decodeText(input: unknown, re: RegExp): Obj | undefined {
  if (typeof input !== 'string' || input.length > TEXT_MAX) return undefined;
  const m = re.exec(input);
  if (!m) return undefined;
  const out: Obj = {};
  for (const [k, v] of Object.entries(m.groups ?? {})) {
    if (v !== undefined) Object.defineProperty(out, k, { value: v, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/** http: сырое HTTP-сообщение — { method, uri, status, headers, body }. */
export function decodeHttp(input: unknown): Obj | undefined {
  if (typeof input !== 'string') return undefined;
  const m = parseHttpMessage(input);
  if (!m) return undefined;
  return { method: m.method, uri: m.uri, status: m.status, headers: m.headers, body: m.body };
}
