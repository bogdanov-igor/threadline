// Набор сред поиска по нескольким средам: сегмент адреса `prod,test` и порядок сред проекта.
import { MAX_SEARCH_ENVS } from './api.ts';

/** Набор сред из сегмента адреса через запятую. Повторы склеиваются. null — пустой элемент или сред больше предела. */
export function parseEnvSet(segment: string): string[] | null {
  const ids = segment.split(',');
  if (ids.some((x) => x === '')) return null;
  const out = [...new Set(ids)];
  return out.length > MAX_SEARCH_ENVS ? null : out;
}

/** Набор в порядке сред проекта. Среды не из проекта идут в конец, их отсеивает вызывающий. */
export function orderEnvSet(ids: readonly string[], order: readonly string[]): string[] {
  const at = (id: string) => {
    const i = order.indexOf(id);
    return i < 0 ? order.length : i;
  };
  return [...ids].sort((a, b) => at(a) - at(b));
}
