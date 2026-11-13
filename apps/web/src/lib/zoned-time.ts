// Время на часах пояса проекта ⇄ момент времени. Только Intl: переходы на летнее время и смены
// смещения берутся из базы поясов браузера, пояс браузера не участвует.

export interface WallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second?: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Показания часов пояса в момент epochMs. */
export function wallTimeAt(epochMs: number, timeZone: string): Required<WallTime> {
  const parts: Record<string, number> = {};
  for (const p of partsFormatter(timeZone).formatToParts(new Date(epochMs))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return {
    year: parts.year ?? 0,
    month: parts.month ?? 1,
    day: parts.day ?? 1,
    // Некоторые движки показывают полночь как 24 даже при h23.
    hour: (parts.hour ?? 0) % 24,
    minute: parts.minute ?? 0,
    second: parts.second ?? 0,
  };
}

/** Смещение пояса от UTC в момент epochMs, мс. */
export function zoneOffsetAt(epochMs: number, timeZone: string): number {
  const w = wallTimeAt(epochMs, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

const sameWall = (a: Required<WallTime>, b: WallTime) =>
  a.year === b.year && a.month === b.month && a.day === b.day && a.hour === b.hour && a.minute === b.minute && a.second === (b.second ?? 0);

const DAY = 24 * 60 * 60 * 1000;

/**
 * Момент, когда часы пояса показывают w.
 * Время в разрыве перехода вперёд сдвигается вперёд на величину перехода; при переходе назад берётся первый из двух моментов.
 */
export function wallTimeToEpoch(w: WallTime, timeZone: string): number {
  const local = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second ?? 0);
  // Смещения за сутки до и после: переходы бывают не чаще раза в несколько недель.
  const before = zoneOffsetAt(local - DAY, timeZone);
  const after = zoneOffsetAt(local + DAY, timeZone);
  const candidates = [...new Set([before, after, zoneOffsetAt(local, timeZone)])]
    .map((o) => local - o)
    .filter((t) => sameWall(wallTimeAt(t, timeZone), w))
    .sort((a, b) => a - b);
  return candidates[0] ?? local - before;
}

const INPUT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/;

/** Значение поля datetime-local: «2026-11-02T14:30». Неверная дата — null. */
export function parseLocalInput(value: string): WallTime | null {
  const m = INPUT.exec(value.trim());
  if (!m) return null;
  const [year, month, day, hour, minute, second] = m.slice(1).map((x) => (x === undefined ? 0 : Number(x))) as number[];
  const w = { year: year!, month: month!, day: day!, hour: hour!, minute: minute!, second: second! };
  const check = new Date(Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second));
  if (
    check.getUTCFullYear() !== w.year ||
    check.getUTCMonth() !== w.month - 1 ||
    check.getUTCDate() !== w.day ||
    check.getUTCHours() !== w.hour ||
    check.getUTCMinutes() !== w.minute
  ) {
    return null;
  }
  return w;
}

/** Значение поля datetime-local для поля в поясе проекта → момент, мс. */
export function localInputToEpoch(value: string, timeZone: string): number | null {
  const w = parseLocalInput(value);
  return w ? wallTimeToEpoch(w, timeZone) : null;
}

const pad = (n: number, len = 2) => String(n).padStart(len, '0');

/** Момент → значение поля datetime-local в поясе проекта, с точностью до минуты. */
export function epochToLocalInput(epochMs: number, timeZone: string): string {
  const w = wallTimeAt(epochMs, timeZone);
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}`;
}

// ---------- Время, вставленное из лога ----------

export type LogTimeError = 'empty' | 'date-only' | 'format';
export type LogTime = { ok: true; atMs: number } | { ok: false; error: LogTimeError };

const QUOTES = /^[\s"'«»`()[\]{}]+|[\s"'«»`()[\]{},;]+$/g;
const LOG_ISO = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)? ?(Z|[+-]\d{2}(?::?\d{2})?)?$/;
const LOG_GIN = /^(\d{4})\/(\d{2})\/(\d{2}) - (\d{2}):(\d{2}):(\d{2})$/;
const LOG_RU = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?$/;
const LOG_RU_SHORT = /^(\d{2})\.(\d{2}) (\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?$/;
const LOG_CLOCK = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;
const DATE_ONLY = /^(?:\d{4}[-/]\d{2}[-/]\d{2}|\d{2}\.\d{2}(?:\.\d{4})?)$/;
/** Запас на расхождение часов браузера и сервера; та же минута, что в проверке границ периода. */
const CLOCK_SLACK_MS = 60_000;
const MAX_OFFSET_MINUTES = 14 * 60;
const BAD: LogTime = { ok: false, error: 'format' };

const fractionMs = (f: string | undefined) => (f ? Number(f.padEnd(3, '0').slice(0, 3)) : 0);

function realWall(w: Required<WallTime>): boolean {
  if (w.hour > 23 || w.minute > 59 || w.second > 59) return false;
  const check = new Date(Date.UTC(w.year, w.month - 1, w.day));
  return check.getUTCFullYear() === w.year && check.getUTCMonth() === w.month - 1 && check.getUTCDate() === w.day;
}

/** Смещение записи в минутах; null — больше ±14:00 или не смещение. */
function offsetMinutes(zone: string): number | null {
  if (zone === 'Z') return 0;
  const sign = zone[0] === '-' ? -1 : 1;
  const digits = zone.slice(1).replace(':', '');
  const hours = Number(digits.slice(0, 2));
  const minutes = Number(digits.slice(2) || '0');
  if (minutes > 59 || hours * 60 + minutes > MAX_OFFSET_MINUTES) return null;
  return sign * (hours * 60 + minutes);
}

/** Текст из лога или интерфейса Threadline → момент. Без смещения — по поясу проекта, пояс браузера не участвует. */
export function parseLogTime(text: string, nowMs: number, timeZone: string): LogTime {
  const s = text.replace(QUOTES, '');
  if (s === '') return { ok: false, error: 'empty' };
  if (DATE_ONLY.test(s)) return { ok: false, error: 'date-only' };

  const iso = LOG_ISO.exec(s);
  if (iso) {
    const w = { year: +iso[1]!, month: +iso[2]!, day: +iso[3]!, hour: +iso[4]!, minute: +iso[5]!, second: +(iso[6] ?? 0) };
    if (!realWall(w)) return BAD;
    const ms = fractionMs(iso[7]);
    if (!iso[8]) return { ok: true, atMs: wallTimeToEpoch(w, timeZone) + ms };
    const offset = offsetMinutes(iso[8]);
    if (offset === null) return BAD;
    return { ok: true, atMs: Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second, ms) - offset * 60_000 };
  }

  const gin = LOG_GIN.exec(s);
  if (gin) {
    const w = { year: +gin[1]!, month: +gin[2]!, day: +gin[3]!, hour: +gin[4]!, minute: +gin[5]!, second: +gin[6]! };
    return realWall(w) ? { ok: true, atMs: wallTimeToEpoch(w, timeZone) } : BAD;
  }

  const ru = LOG_RU.exec(s);
  if (ru) {
    const w = { year: +ru[3]!, month: +ru[2]!, day: +ru[1]!, hour: +ru[4]!, minute: +ru[5]!, second: +(ru[6] ?? 0) };
    return realWall(w) ? { ok: true, atMs: wallTimeToEpoch(w, timeZone) + fractionMs(ru[7]) } : BAD;
  }

  const now = wallTimeAt(nowMs, timeZone);
  const short = LOG_RU_SHORT.exec(s);
  if (short) {
    const ms = fractionMs(short[6]);
    // Ближайший прошедший такой день. 29 февраля ищется до предыдущего високосного года.
    for (let year = now.year; year >= now.year - 8; year--) {
      const w = { year, month: +short[2]!, day: +short[1]!, hour: +short[3]!, minute: +short[4]!, second: +(short[5] ?? 0) };
      if (!realWall(w)) continue;
      const atMs = wallTimeToEpoch(w, timeZone) + ms;
      if (atMs <= nowMs + CLOCK_SLACK_MS) return { ok: true, atMs };
    }
    return BAD;
  }

  const clock = LOG_CLOCK.exec(s);
  if (clock) {
    const w = { year: now.year, month: now.month, day: now.day, hour: +clock[1]!, minute: +clock[2]!, second: +(clock[3] ?? 0) };
    if (!realWall(w)) return BAD;
    const today = wallTimeToEpoch(w, timeZone);
    if (today <= nowMs + CLOCK_SLACK_MS) return { ok: true, atMs: today };
    const y = new Date(Date.UTC(now.year, now.month - 1, now.day - 1));
    return { ok: true, atMs: wallTimeToEpoch({ ...w, year: y.getUTCFullYear(), month: y.getUTCMonth() + 1, day: y.getUTCDate() }, timeZone) };
  }
  return BAD;
}
