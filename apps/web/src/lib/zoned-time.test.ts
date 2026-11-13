import { describe, expect, it } from 'vitest';
import { epochToLocalInput, localInputToEpoch, parseLocalInput, parseLogTime, wallTimeAt, wallTimeToEpoch, zoneOffsetAt } from './zoned-time.ts';

const H = 60 * 60 * 1000;

describe('время в поясе проекта', () => {
  it('пояс без перехода на летнее время: UTC+5 круглый год', () => {
    expect(localInputToEpoch('2026-11-02T14:30', 'Asia/Karachi')).toBe(Date.UTC(2026, 10, 2, 9, 30));
    expect(localInputToEpoch('2026-07-01T00:00', 'Asia/Karachi')).toBe(Date.UTC(2026, 5, 30, 19, 0));
    expect(zoneOffsetAt(Date.UTC(2026, 0, 1), 'Asia/Karachi')).toBe(5 * H);
  });

  it('не зависит от пояса браузера: те же поля дают тот же момент', () => {
    const at = localInputToEpoch('2026-11-02T00:15', 'Asia/Karachi');
    expect(at).toBe(Date.UTC(2026, 10, 1, 19, 15));
    expect(epochToLocalInput(at!, 'Asia/Karachi')).toBe('2026-11-02T00:15');
    expect(epochToLocalInput(at!, 'Europe/Moscow')).toBe('2026-11-01T22:15');
  });

  it('смещение не на целый час', () => {
    expect(localInputToEpoch('2026-11-02T12:00', 'Asia/Kathmandu')).toBe(Date.UTC(2026, 10, 2, 6, 15));
    expect(localInputToEpoch('2026-11-02T12:00', 'Asia/Kolkata')).toBe(Date.UTC(2026, 10, 2, 6, 30));
  });

  it('летнее и зимнее время берутся из базы поясов', () => {
    expect(localInputToEpoch('2026-07-15T12:00', 'Europe/Berlin')).toBe(Date.UTC(2026, 6, 15, 10, 0));
    expect(localInputToEpoch('2026-01-15T12:00', 'Europe/Berlin')).toBe(Date.UTC(2026, 0, 15, 11, 0));
    expect(localInputToEpoch('2026-07-15T12:00', 'America/New_York')).toBe(Date.UTC(2026, 6, 15, 16, 0));
    expect(localInputToEpoch('2026-12-15T12:00', 'America/New_York')).toBe(Date.UTC(2026, 11, 15, 17, 0));
  });

  it('время в разрыве перехода вперёд сдвигается вперёд', () => {
    // 29.03.2026 в Берлине часы переводят с 02:00 на 03:00: 02:30 не бывает.
    const t = localInputToEpoch('2026-03-29T02:30', 'Europe/Berlin')!;
    expect(t).toBe(Date.UTC(2026, 2, 29, 1, 30));
    expect(epochToLocalInput(t, 'Europe/Berlin')).toBe('2026-03-29T03:30');
  });

  it('при переходе назад берётся первый из двух моментов', () => {
    // 25.10.2026 в Берлине 02:30 бывает дважды: сначала летнее (UTC+2), потом зимнее (UTC+1).
    expect(localInputToEpoch('2026-10-25T02:30', 'Europe/Berlin')).toBe(Date.UTC(2026, 9, 25, 0, 30));
    expect(localInputToEpoch('2026-10-25T03:30', 'Europe/Berlin')).toBe(Date.UTC(2026, 9, 25, 2, 30));
  });

  it('туда и обратно на каждом часе года', () => {
    for (const tz of ['Asia/Karachi', 'Europe/Berlin', 'America/New_York', 'Australia/Lord_Howe']) {
      for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1); t += 7 * H) {
        const minute = Math.floor(t / 60_000) * 60_000;
        const back = localInputToEpoch(epochToLocalInput(minute, tz), tz)!;
        // Неоднозначное время даёт первый момент, поэтому обратный перевод не позже исходного.
        expect(back <= minute, `${tz} ${new Date(minute).toISOString()}`).toBe(true);
        expect(epochToLocalInput(back, tz)).toBe(epochToLocalInput(minute, tz));
      }
    }
  });

  it('полночь — 00, а не 24', () => {
    expect(wallTimeAt(Date.UTC(2026, 10, 1, 19, 0), 'Asia/Karachi')).toMatchObject({ day: 2, hour: 0, minute: 0 });
    expect(wallTimeToEpoch({ year: 2026, month: 11, day: 2, hour: 0, minute: 0 }, 'Asia/Karachi')).toBe(Date.UTC(2026, 10, 1, 19, 0));
  });

  it('неверные значения поля', () => {
    expect(parseLocalInput('')).toBeNull();
    expect(parseLocalInput('2026-02-30T10:00')).toBeNull();
    expect(parseLocalInput('2026-11-02T25:00')).toBeNull();
    expect(parseLocalInput('02.11.2026 10:00')).toBeNull();
    expect(localInputToEpoch('nope', 'Asia/Karachi')).toBeNull();
    expect(parseLocalInput('2026-11-02T10:05:30')).toEqual({ year: 2026, month: 11, day: 2, hour: 10, minute: 5, second: 30 });
  });
});

describe('время, вставленное из лога', () => {
  const TZ = 'Asia/Karachi';
  // 18:00 в поясе +05:00.
  const NOW = Date.UTC(2026, 10, 4, 13, 0);
  const AT = Date.UTC(2026, 10, 2, 11, 20, 29);
  const at = (text: string, now = NOW, tz = TZ) => {
    const r = parseLogTime(text, now, tz);
    if (!r.ok) throw new Error(`не разобрано: ${text}`);
    return r.atMs;
  };
  const error = (text: string, now = NOW) => {
    const r = parseLogTime(text, now, TZ);
    return r.ok ? null : r.error;
  };

  it('ISO со смещением: смещение из записи, разные написания', () => {
    expect(at('2026-11-02T16:20:29+05:00')).toBe(AT);
    expect(at('2026-11-02T16:20:29+0500')).toBe(AT);
    expect(at('2026-11-02T16:20:29+05')).toBe(AT);
    expect(at('2026-11-02T11:20:29Z')).toBe(AT);
    expect(at('2026-11-02T14:20:29+03:00')).toBe(AT);
    expect(at('2026-11-02T14:20:29+0300')).toBe(AT);
    expect(at('2026-11-02T14:20:29+03')).toBe(AT);
    expect(at('2026-11-02T06:20:29-05:00')).toBe(AT);
  });

  it('доли секунды отсекаются до миллисекунд', () => {
    expect(at('2026-11-02T16:20:29.927123+05:00')).toBe(AT + 927);
    expect(at('2026-11-02T16:20:29.927123456Z')).toBe(Date.UTC(2026, 10, 2, 16, 20, 29, 927));
    expect(at('2026-11-02T16:20:29.5+05:00')).toBe(AT + 500);
  });

  it('запись с пробелом и без смещения — по поясу проекта, а не браузера', () => {
    expect(at('2026-11-02 16:20:29')).toBe(AT);
    expect(at('2026-11-02T16:20')).toBe(Date.UTC(2026, 10, 2, 11, 20));
    expect(at('2026-11-02 16:20:29', NOW, 'Europe/Moscow')).toBe(Date.UTC(2026, 10, 2, 13, 20, 29));
  });

  it('строка шлюза GIN', () => {
    expect(at('2026/11/02 - 16:20:29')).toBe(AT);
  });

  it('запись интерфейса Threadline', () => {
    expect(at('02.11.2026 16:20:29,927')).toBe(AT + 927);
    expect(at('02.11 16:20')).toBe(Date.UTC(2026, 10, 2, 11, 20));
  });

  it('без года — ближайший прошедший, в том числе прошлого года', () => {
    expect(at('15.12 10:00')).toBe(Date.UTC(2025, 11, 15, 5, 0));
  });

  it('29 февраля без года в невисокосный год — предыдущий високосный', () => {
    expect(at('29.02 10:00')).toBe(Date.UTC(2024, 1, 29, 5, 0));
  });

  it('только время: сегодня, а позже текущего — вчера', () => {
    expect(at('16:20')).toBe(Date.UTC(2026, 10, 4, 11, 20));
    expect(at('16:20:29')).toBe(Date.UTC(2026, 10, 4, 11, 20, 29));
    // 00:10 в поясе +05:00: 23:50 — ещё вчера.
    expect(at('23:50', Date.UTC(2026, 10, 3, 19, 10))).toBe(Date.UTC(2026, 10, 3, 18, 50));
  });

  it('за 10 секунд до этого времени остаётся сегодня', () => {
    expect(at('16:20', Date.UTC(2026, 10, 4, 11, 19, 50))).toBe(Date.UTC(2026, 10, 4, 11, 20));
  });

  it('кавычки и скобки отбрасываются', () => {
    expect(at('"2026-11-02T16:20:29+05:00"')).toBe(AT);
    expect(at('[2026-11-02 16:20:29]')).toBe(AT);
    expect(at(' (2026-11-02 16:20:29), ')).toBe(AT);
  });

  it('смещение больше ±14:00 и несуществующее время — ошибка', () => {
    expect(error('2026-11-02T16:20:29+15:00')).toBe('format');
    expect(error('2026-11-02T16:20:29-14:30')).toBe('format');
    expect(at('2026-11-02T16:20:29+14:00')).toBe(Date.UTC(2026, 10, 2, 2, 20, 29));
    expect(error('2026-02-31 10:00')).toBe('format');
    expect(error('25:61')).toBe('format');
    expect(error('2026-11-02 24:00')).toBe('format');
  });

  it('неразобранный текст и обрывки — ошибка, только дата и пусто — свои подсказки', () => {
    expect(error('вчера')).toBe('format');
    expect(error('2026-11')).toBe('format');
    expect(error('2026-11-02')).toBe('date-only');
    expect(error('02.11.2026')).toBe('date-only');
    expect(error('')).toBe('empty');
    expect(error('  ""  ')).toBe('empty');
  });
});
