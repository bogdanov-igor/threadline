// Пути к полям: `<слой>.<ключ>.<ключ>…`.
import { headerValue } from '../search/http.ts';
import { isObj } from './decoders.ts';

export interface CompiledPath {
  /** Путь как в профиле. */
  source: string;
  layer: string;
  /** Сегменты после имени слоя. */
  segs: string[];
  /** keys[i][j] — ключ из сегментов i…j-1 через точку. */
  keys: string[][];
  /** Путь в заголовок слоя http: имя заголовка. */
  header: string | null;
}

/** Первый сегмент пути — имя слоя. */
export function pathLayer(path: string): string {
  const at = path.indexOf('.');
  return at < 0 ? path : path.slice(0, at);
}

export function compilePath(source: string, decoder: string | undefined): CompiledPath {
  const [layer = '', ...segs] = source.split('.');
  const keys = segs.map((_, i) => {
    const row: string[] = [];
    for (let j = i + 1; j <= segs.length; j++) row[j] = segs.slice(i, j).join('.');
    return row;
  });
  const header = decoder === 'http' && segs[0] === 'headers' && segs.length > 1 ? segs.slice(1).join('.') : null;
  return { source, layer, segs, keys, header };
}

const INDEX = /^\d+$/;

/**
 * Значение по сегментам. На каждом шаге берётся самый длинный ключ, равный остатку пути или его началу по точкам:
 * так `trace.id` находит и `{"trace.id":…}`, и `{"trace":{"id":…}}`. Сегмент из цифр у массива — индекс.
 * Внутрь строки путь не заходит: строку раскрывает только слой.
 */
export function valueAt(root: unknown, p: CompiledPath): unknown {
  if (p.header !== null) {
    const headers = isObj(root) ? root.headers : undefined;
    return isObj(headers) ? (headerValue(headers as Record<string, string[]>, p.header) ?? undefined) : undefined;
  }
  let cur = root;
  let i = 0;
  const n = p.segs.length;
  while (i < n) {
    if (Array.isArray(cur)) {
      const s = p.segs[i]!;
      if (!INDEX.test(s)) return undefined;
      cur = cur[Number(s)];
      i++;
      continue;
    }
    if (!isObj(cur)) return undefined;
    const row = p.keys[i]!;
    let next = -1;
    for (let j = n; j > i; j--) {
      if (Object.hasOwn(cur, row[j]!)) {
        next = j;
        break;
      }
    }
    if (next < 0) return undefined;
    cur = cur[row[next]!];
    i = next;
  }
  return cur;
}
