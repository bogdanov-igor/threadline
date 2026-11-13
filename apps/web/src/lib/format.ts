// Числа, длительности и время для экранов поиска. Единицы — из каталога строк.
import { formatDateTime } from '@threadline/core';
import i18n from '../i18n/index.ts';
import { languageOf } from '../i18n/languages.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;

const formatters = new Map<string, Intl.NumberFormat>();

/** Форматтер чисел на языке интерфейса: разделители следуют языку. Создание форматтера дорого, поэтому кэш на язык и настройку. */
export function numberFormat(options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${i18n.language}|${JSON.stringify(options)}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.NumberFormat(languageOf(i18n.language).tag, options);
    formatters.set(key, f);
  }
  return f;
}

const int = () => numberFormat({ maximumFractionDigits: 0, useGrouping: 'min2' });
const twoDecimals = () => numberFormat({ maximumFractionDigits: 2 });
const fixed = (digits: number) => numberFormat({ minimumFractionDigits: digits, maximumFractionDigits: digits });
/** Младшая единица всегда двумя цифрами: «1 м 05 с». */
const two = (n: number) => String(n).padStart(2, '0');

export const formatInt = (n: number) => int().format(n);

/**
 * Длительность: две старшие единицы, не длиннее девяти знаков.
 * «715 мс», «2,87 с», «20,0 с», «1 м 05 с», «23 ч 59 м», «3 д 04 ч». Границы считаются после округления: «59,96 с» уже «1 м 00 с».
 */
export function formatDuration(ms: number): string {
  const t = i18n.t;
  const v = Math.max(0, ms);
  if (Math.round(v) < 1000) return t('units.ms', { value: int().format(Math.round(v)) });
  if (v < 9995) return t('units.s', { value: fixed(2).format(Math.round(v / 10) / 100) });
  if (v < 59_950) return t('units.s', { value: fixed(1).format(Math.round(v / 100) / 10) });
  const totalS = Math.round(v / 1000);
  if (totalS < 3600) return `${t('units.m', { value: Math.floor(totalS / 60) })} ${t('units.s', { value: two(totalS % 60) })}`;
  const totalM = Math.round(v / MIN);
  if (totalM < 24 * 60) return `${t('units.h', { value: Math.floor(totalM / 60) })} ${t('units.m', { value: two(totalM % 60) })}`;
  const totalH = Math.round(v / HOUR);
  return `${t('units.d', { value: Math.floor(totalH / 24) })} ${t('units.h', { value: two(totalH % 24) })}`;
}

/** Размер текста: «640 Б», «0,6 КБ», «1,2 МБ». Одна цифра после запятой, как в строке данных шага. */
export function formatSize(bytes: number): string {
  const t = i18n.t;
  const one = numberFormat({ minimumFractionDigits: 1, maximumFractionDigits: 1 });
  if (bytes < 512) return t('units.b', { value: int().format(bytes) });
  if (bytes < 1024 * 1024) return t('units.kb', { value: one.format(bytes / 1024) });
  return t('units.mb', { value: one.format(bytes / 1024 / 1024) });
}

/** Смещение записи от первой: «+31 мс», «+1,24 с», дальше 10 секунд — как длительность. */
export function formatOffset(ms: number): string {
  const v = Math.max(0, ms);
  if (Math.round(v) < 1000) return `+${i18n.t('units.ms', { value: int().format(Math.round(v)) })}`;
  if (v < 10_000) return `+${i18n.t('units.s', { value: twoDecimals().format(v / 1000) })}`;
  return `+${formatDuration(v)}`;
}

/** Отрезок времени для фразы «за …»: «3 часа», «45 минут», «2 часа 30 минут». */
export function formatSpan(ms: number): string {
  const t = i18n.t;
  let h = Math.floor(ms / HOUR);
  let m = Math.round((ms - h * HOUR) / MIN);
  if (m === 60) {
    h += 1;
    m = 0;
  }
  if (h === 0) return t('units.spanMinutes', { count: Math.max(m, 1) });
  return m ? `${t('units.spanHours', { count: h })} ${t('units.spanMinutes', { count: m })}` : t('units.spanHours', { count: h });
}

/** Дата и время с миллисекундами в поясе проекта по отдельности: «02.11.2026» и «16:49:15,486». */
export function timeParts(epochMs: number, timeZone: string): { date: string; time: string } {
  const [date = '', time = ''] = formatDateTime(epochMs, timeZone, { ms: true }).split(' ');
  return { date, time };
}

/** Короткая дата и время без секунд: «02.11 14:30». */
export function shortDateTime(epochMs: number, timeZone: string): string {
  const [date = '', time = ''] = formatDateTime(epochMs, timeZone).split(' ');
  return `${date.slice(0, 5)} ${time.slice(0, 5)}`;
}

/** Длинный correlation_id обрезается посередине: начало и конец различают запросы. 13-значные числовые id видны целиком. */
export function shortCid(cid: string): string {
  return cid.length > 13 ? `${cid.slice(0, 8)}…${cid.slice(-4)}` : cid;
}

/** Заголовки Guzzle {Имя: [значения]} — строками «Имя: значение». */
export function formatHeaders(headers: unknown): string {
  if (headers && typeof headers === 'object' && !Array.isArray(headers)) {
    return Object.entries(headers as Record<string, unknown>)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.map(scalar).join(', ') : scalar(v)}`)
      .join('\n');
  }
  return pretty(headers);
}

const scalar = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

/** Значение для блока с кодом: строка как есть, остальное — JSON с отступами 2. */
export function pretty(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2) ?? String(value);
}

/** Текст в кавычках языка интерфейса: «…» на русском, “…” на английском. */
export function quoted(text: string): string {
  const [open, close] = languageOf(i18n.language).quotes;
  return `${open}${text}${close}`;
}

export const upperFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
