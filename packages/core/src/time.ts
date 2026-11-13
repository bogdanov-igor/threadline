// Время всегда показывается в часовом поясе проекта, а не браузера.

// Границы момента в полях ввода, адресах и API: всё, что позже, считается мусором и до хранилища не доходит.
// Смысловые правила (срок хранения, 24 часа, начало раньше конца) проверяются отдельно: слишком старый момент отклоняет срок хранения.
export const MIN_INPUT_YEAR = 2000;
export const MAX_INPUT_YEAR = 2099;
export const MIN_EPOCH_MS = Date.UTC(MIN_INPUT_YEAR, 0, 1);
export const MAX_EPOCH_MS = Date.UTC(MAX_INPUT_YEAR + 1, 0, 1);

/** Момент в допустимых границах: конечное число от 2000 до конца 2099 года. */
export const isSaneEpochMs = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= MIN_EPOCH_MS && v < MAX_EPOCH_MS;

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string, withMs: boolean): Intl.DateTimeFormat {
  const key = `${timeZone}|${withMs}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('ru-RU', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
      ...(withMs ? { fractionalSecondDigits: 3 } : {}),
    });
    formatters.set(key, f);
  }
  return f;
}

/** «30.10.2026 16:49:15» или с миллисекундами «30.10.2026 16:49:15,486». */
export function formatDateTime(epochMs: number, timeZone: string, opts: { ms?: boolean } = {}): string {
  return formatter(timeZone, !!opts.ms).format(new Date(epochMs)).replace(', ', ' ');
}

/** «UTC+05:00» для часового пояса в заданный момент. */
export function timeZoneOffsetLabel(timeZone: string, at: Date = new Date()): string {
  const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(at)
    .find((p) => p.type === 'timeZoneName')?.value;
  if (!part || part === 'GMT') return 'UTC+00:00';
  return part.replace('GMT', 'UTC');
}
