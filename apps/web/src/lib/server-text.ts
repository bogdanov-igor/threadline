// Текст сервера и ядра в интерфейсе: сервер о языке не знает и присылает русский текст.
import type { MessageRef } from '@threadline/core';
import i18n from '../i18n/index.ts';
import { DEFAULT_LANGUAGE } from '../i18n/languages.ts';

/** На русском текст сервера как есть. На других языках перевод по ключу, если ключ известен; иначе запасной текст. */
export function fieldText(m: { message: string } & Partial<MessageRef>): string {
  if (i18n.language === DEFAULT_LANGUAGE || !m.key) return m.message;
  const key = `server.${m.key}`;
  // Ключи server.* лежат только в файле en, а типы ключей выводятся из русских файлов.
  return i18n.exists(key) ? (i18n.t as unknown as (k: string, o?: object) => string)(key, m.params) : m.message;
}

/** На русском пояснение сервера, на других языках undefined: тогда срабатывает общий текст по коду ошибки. */
export function readableDetails(details: string | undefined): string | undefined {
  return i18n.language === DEFAULT_LANGUAGE ? details : undefined;
}
