// Смысл HTTP-статуса человеческими словами: «HTTP 404 — не найдено».
import i18n from '../i18n/index.ts';

const STATUS_MEANING = new Set([400, 401, 403, 404, 405, 408, 409, 422, 429, 500, 502, 503, 504]);

/** Смысл HTTP-статуса ошибки: «не найдено»; неизвестный — по классу; не ошибка — null. */
export function statusMeaning(status: number): string | null {
  const t = i18n.t;
  if (STATUS_MEANING.has(status)) return t(`httpStatus.${String(status) as '404'}`);
  if (status >= 500) return t('httpStatus.5xx');
  if (status >= 400) return t('httpStatus.4xx');
  return null;
}

/** «HTTP 404 — не найдено»: статус и его смысл. */
export function httpStatusText(status: number): string {
  const meaning = statusMeaning(status);
  const base = i18n.t('record.responseStatus', { status });
  return meaning ? `${base} — ${meaning}` : base;
}
