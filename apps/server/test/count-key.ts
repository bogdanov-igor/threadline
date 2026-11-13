// Часть запроса подсчёта, которая задаёт ключ: для встроенного формата json — та же, что строит движок поиска.
import type { CountQuery } from '@threadline/core/backend';
import { builtinProfile } from '@threadline/core/profile';

export function builtinCountKey(): Omit<CountQuery, 'selector' | 'filters' | 'range'> {
  return { key: { regexp: builtinProfile().countRegexp } };
}
