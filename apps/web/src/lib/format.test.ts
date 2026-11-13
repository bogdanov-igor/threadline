import { describe, expect, it } from 'vitest';
import en from '../i18n/en.json';
import i18n from '../i18n/index.ts';
import { formatDuration, formatHeaders, formatInt, formatOffset, formatSpan, pretty, quoted, shortCid, shortDateTime, timeParts, upperFirst } from './format.ts';

const MIN = 60_000;
const H = 60 * MIN;

describe('кавычки по языку', () => {
  it.each([
    ['ru', '«not found»'],
    ['en', '“not found”'],
  ])('%s', async (lng, expected) => {
    await i18n.changeLanguage(lng);
    try {
      expect(quoted('not found')).toBe(expected);
    } finally {
      await i18n.changeLanguage('ru');
    }
  });
});

describe('числа по языку', () => {
  it.each([
    ['ru', '12\u00a0345', '1,20 с'],
    ['en', '12,345', '1.20 s'],
  ])('%s: разделители групп и дроби', async (lng, int, duration) => {
    i18n.addResourceBundle(lng, 'translation', lng === 'ru' ? {} : { units: { s: '{{value}} s' } }, true, true);
    await i18n.changeLanguage(lng);
    try {
      expect(formatInt(12345)).toBe(int);
      expect(formatDuration(1200)).toBe(duration);
    } finally {
      await i18n.changeLanguage('ru');
    }
  });
});

describe('длительности', () => {
  it('две старшие единицы: от миллисекунд до суток', () => {
    expect(formatDuration(4)).toBe('4 мс');
    expect(formatDuration(312)).toBe('312 мс');
    expect(formatDuration(715)).toBe('715 мс');
    expect(formatDuration(1234)).toBe('1,23 с');
    expect(formatDuration(2870)).toBe('2,87 с');
    expect(formatDuration(20_001)).toBe('20,0 с');
    expect(formatDuration(59_900)).toBe('59,9 с');
    expect(formatDuration(65_000)).toBe('1 м 05 с');
    expect(formatDuration(120_000)).toBe('2 м 00 с');
    expect(formatDuration(H + 5 * MIN)).toBe('1 ч 05 м');
    expect(formatDuration(23 * H + 59 * MIN)).toBe('23 ч 59 м');
    expect(formatDuration(3 * 24 * H + 4 * H)).toBe('3 д 04 ч');
    expect(formatDuration(-5)).toBe('0 мс');
  });

  it('округление не даёт значений за границей единицы', () => {
    expect(formatDuration(999.6)).toBe('1,00 с');
    expect(formatDuration(9996)).toBe('10,0 с');
    expect(formatDuration(59_960)).toBe('1 м 00 с');
    expect(formatDuration(H - 200)).toBe('1 ч 00 м');
    expect(formatDuration(24 * H - 20_000)).toBe('1 д 00 ч');
  });

  it.each([
    ['ru', '23 ч 59 м'],
    ['en', '23 h 59 m'],
  ])('%s: самая долгая длительность суток', async (lng, expected) => {
    i18n.addResourceBundle(lng, 'translation', { units: lng === 'en' ? en.units : {} }, true, true);
    await i18n.changeLanguage(lng);
    try {
      expect(formatDuration(23 * H + 59 * MIN)).toBe(expected);
    } finally {
      await i18n.changeLanguage('ru');
    }
  });

  it('смещение записи от первой', () => {
    expect(formatOffset(31.4)).toBe('+31 мс');
    expect(formatOffset(0)).toBe('+0 мс');
    expect(formatOffset(999.4)).toBe('+999 мс');
    expect(formatOffset(1234)).toBe('+1,23 с');
    expect(formatOffset(5020)).toBe('+5,02 с');
    expect(formatOffset(20_001)).toBe('+20,0 с');
    expect(formatOffset(59_900)).toBe('+59,9 с');
  });

  it('отрезок для фразы «за …»', () => {
    expect(formatSpan(3 * H)).toBe('3 часа');
    expect(formatSpan(H)).toBe('1 час');
    expect(formatSpan(5 * H)).toBe('5 часов');
    expect(formatSpan(45 * MIN)).toBe('45 минут');
    expect(formatSpan(21 * MIN)).toBe('21 минуту');
    expect(formatSpan(2 * H + 30 * MIN)).toBe('2 часа 30 минут');
    expect(formatSpan(H + 59.6 * MIN)).toBe('2 часа');
    expect(formatSpan(10_000)).toBe('1 минуту');
  });
});

describe('время в поясе проекта', () => {
  const at = Date.UTC(2026, 10, 2, 11, 49, 15, 486);
  it('дата и время с миллисекундами по отдельности', () => {
    expect(timeParts(at, 'Asia/Karachi')).toEqual({ date: '02.11.2026', time: '16:49:15,486' });
    expect(timeParts(at, 'Europe/Moscow')).toEqual({ date: '02.11.2026', time: '14:49:15,486' });
  });
  it('короткая дата и время', () => {
    expect(shortDateTime(at, 'Asia/Karachi')).toBe('02.11 16:49');
  });
});

describe('прочее', () => {
  it('короткий correlation_id', () => {
    expect(shortCid('6312345678901')).toBe('6312345678901');
    expect(shortCid('0f8c2b1a-1111-4222-8333-444455556666')).toBe('0f8c2b1a…6666');
  });
  it('заголовки строками', () => {
    expect(formatHeaders({ 'Content-Type': ['text/xml'], SOAPAction: ['""'], 'X-N': 5 })).toBe('Content-Type: text/xml\nSOAPAction: ""\nX-N: 5');
    expect(formatHeaders('raw')).toBe('raw');
    expect(formatHeaders([1, 2])).toBe('[\n  1,\n  2\n]');
  });
  it('JSON с отступами и заглавная буква', () => {
    expect(pretty({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(pretty('as is')).toBe('as is');
    expect(upperFirst('за 6 часов')).toBe('За 6 часов');
  });
});
