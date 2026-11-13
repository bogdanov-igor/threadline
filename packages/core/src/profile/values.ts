// Приведение значений полей записи: время, уровень, идентификаторы, статус, текст.

/** Уровни по шкале Monolog (PHP), она же встроенная шкала Threadline. */
export const LEVELS: Readonly<Record<string, number>> = {
  DEBUG: 100,
  INFO: 200,
  NOTICE: 250,
  WARNING: 300,
  ERROR: 400,
  CRITICAL: 500,
  ALERT: 550,
  EMERGENCY: 600,
};

/** Частые имена вне Monolog (log4j, logback, zap, syslog). TRACE числа не получает. */
export const LEVEL_ALIASES: Readonly<Record<string, number>> = { WARN: 300, ERR: 400, CRIT: 500, FATAL: 600 };

/** Запись этого уровня и выше — ошибка. */
export const WARNING_LEVEL = 300;

/** Время Loki в мс с дробью. */
export function tsNsToMs(tsNs: string): number {
  if (!/^\d+$/.test(tsNs)) return 0;
  const ns = BigInt(tsNs);
  return Number(ns / 1_000_000n) + Number(ns % 1_000_000n) / 1e6;
}

const DATETIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:[.,](\d+))?(Z|[+-]\d{2}:?\d{2})$/;

/** Время ISO 8601 с поясом («2026-10-30T16:49:15.486322+05:00») в мс с дробью; null, если не разобралось. */
export function parseDatetime(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const m = DATETIME.exec(v.trim());
  if (!m) return null;
  let ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  if (Number.isNaN(ms)) return null;
  const frac = m[7];
  if (frac) ms += Number(frac.slice(0, 9).padEnd(9, '0')) / 1e6;
  const tz = m[8] ?? 'Z';
  if (tz !== 'Z') {
    const hhmm = tz.slice(1).replace(':', '');
    const offsetMin = Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(2, 4));
    ms -= (tz[0] === '-' ? -1 : 1) * offsetMin * 60_000;
  }
  return ms;
}

const EPOCH = /^(\d{9,20})(?:\.(\d+))?$/;

/**
 * Число от эпохи Unix в мс с дробью. Единица — по числу цифр целой части: 9–11 — секунды, 12–14 — мс,
 * 15–17 — мкс, 18–20 — нс. Иное число цифр — null.
 */
export function epochMs(v: unknown): number | null {
  let text: string;
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v < 0) return null;
    text = Number.isInteger(v) ? BigInt(v).toString() : String(v);
  } else if (typeof v === 'string') text = v.trim();
  else return null;
  const m = EPOCH.exec(text);
  if (!m) return null;
  const int = m[1]!;
  const frac = m[2] ?? '';
  const digits = int.length;
  if (digits <= 11) return Number(`${int}.${frac || '0'}`) * 1000;
  if (digits <= 14) return Number(`${int}.${frac || '0'}`);
  const n = BigInt(int);
  const perMs = digits <= 17 ? 1_000n : 1_000_000n;
  return Number(n / perMs) + Number(n % perMs) / Number(perMs);
}

/** Время записи: ISO 8601 с поясом или число от эпохи; null — берётся время хранилища. */
export function timeValue(v: unknown): number | null {
  return parseDatetime(v) ?? epochMs(v);
}

const DIGITS = /^\d+$/;

/** Таблица уровней проекта поверх встроенной: имя в верхнем регистре или число строкой → число по шкале Monolog. */
export function levelTable(levels: Readonly<Record<string, number>> | undefined): Map<string, number> {
  const t = new Map<string, number>([...Object.entries(LEVELS), ...Object.entries(LEVEL_ALIASES)]);
  for (const [k, v] of Object.entries(levels ?? {})) t.set(DIGITS.test(k.trim()) ? String(Number(k.trim())) : k.trim().toUpperCase(), v);
  return t;
}

const MONOLOG_BY_NUM = new Map(Object.entries(LEVELS).map(([k, v]) => [v, k]));

/**
 * Уровень по значениям из списка путей, по порядку:
 * - имя — первая непустая строка не из цифр, без пробелов по краям, в верхнем регистре;
 * - число — первое число или строка из цифр (число переводится таблицей, если в ней есть такой ключ),
 *   иначе число первой строки-имени, которая есть в таблице.
 * Имени нет — обратный поиск по таблице Monolog, иначе число строкой.
 */
export function levelOf(values: readonly unknown[], table: ReadonlyMap<string, number>): { level: string | null; levelNum: number | null } {
  let name: string | null = null;
  let num: number | null = null;
  let byName: number | null = null;
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v)) {
      num ??= v;
    } else if (typeof v === 'string') {
      const s = v.trim();
      if (s === '') continue;
      if (DIGITS.test(s)) {
        num ??= Number(s);
        continue;
      }
      const upper = s.toUpperCase();
      name ??= upper;
      byName ??= table.get(upper) ?? null;
    }
  }
  if (num !== null) num = table.get(String(num)) ?? num;
  else num = byName;
  if (name === null && num !== null) name = MONOLOG_BY_NUM.get(num) ?? String(num);
  return { level: name, levelNum: num };
}

/** correlation_id и request_id: непустая строка как есть, конечное число строкой. */
export function idValue(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() === '' ? null : v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

/** HTTP-статус: число или непустая строка, которая читается конечным числом. */
export function statusValue(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** Текст поля: строка как есть, иное — текст JSON, нет значения — null. */
export function textValue(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  return typeof v === 'string' ? v : (JSON.stringify(v) ?? null);
}
