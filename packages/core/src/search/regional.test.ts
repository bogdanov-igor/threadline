// Региональные правила на весь процесс: нормализация, смена правил, план номеров с группами и без.
import { afterEach, describe, expect, it } from 'vitest';
import { BUILTIN_MASKING, maskKindsText, phonesIn } from './mask-pass.ts';
import { nationalOf, parsePhone, phonePattern, phoneTailPattern } from './phone.ts';
import { DEFAULT_REGIONAL, normalizeRegional, patternIssue, regional, regionalVersion, setRegional, type PhonePlan } from './regional.ts';
import { DEMO, UZBEKISTAN } from './test-regional.ts';

const NONE: ReadonlySet<string> = new Set();
const P = (s: string) => maskKindsText(s, BUILTIN_MASKING.strict, NONE);

afterEach(() => setRegional(null));

describe('правила процесса', () => {
  it('по умолчанию правил нет; пустой раздел — тоже нет', () => {
    expect(regional()).toBe(DEFAULT_REGIONAL);
    setRegional({ phone: null, patterns: {} });
    expect(regional()).toBe(DEFAULT_REGIONAL);
  });

  it('битые значения пропускаются: план без кода, неизвестный вид, выражение с группой', () => {
    const r = normalizeRegional({
      phone: { countryCode: '0', nationalDigits: 10 },
      patterns: { email: ['x'], passport: ['[A-Z]{2}\\d{7}', '(?P<n>\\d)', '(?=x)y', 7], national_id: 'x' },
    });
    expect(r).toEqual({ phone: null, patterns: { passport: ['[A-Z]{2}\\d{7}'] } });
    expect(normalizeRegional({ phone: { countryCode: '44', nationalDigits: 10, groups: [4, 5], trunkPrefix: 'x' } })).toEqual({ phone: { countryCode: '44', nationalDigits: 10 }, patterns: {} });
    expect(patternIssue('[A-Z]{2}\\d{7}')).toBeNull();
    expect(patternIssue('(?P<n>\\d)')).not.toBeNull();
  });

  it('версия растёт только при смене правил; образцы пересобираются', () => {
    const v = regionalVersion();
    setRegional(null);
    expect(regionalVersion()).toBe(v);
    expect(P('passport ZZ0000101')).toBe('passport ZZ0000101');
    setRegional(DEMO);
    expect(regionalVersion()).toBe(v + 1);
    expect(P('passport ZZ0000101')).toBe('passport ZZ*****01');
    setRegional({ ...DEMO });
    expect(regionalVersion()).toBe(v + 1);
    setRegional(UZBEKISTAN);
    expect(P('passport ZZ0000101 id 31201990000011')).toBe('passport ZZ*****01 id **********0011');
    setRegional(null);
    expect(P('passport ZZ0000101')).toBe('passport ZZ0000101');
  });

  it('образец телефона из раздела закрывает номер своим форматом и виден странице', () => {
    setRegional({ phone: null, patterns: { phone: ['7700 9\\d{5}'] } });
    expect(P('call 7700 900101 now')).toBe('call **** **0101 now');
    expect(phonesIn('call 7700 900101 now')).toEqual([[5, 16]]);
  });
});

describe('план номеров', () => {
  const GROUPED: PhonePlan = { countryCode: '44', nationalDigits: 10, trunkPrefix: '0', groups: [4, 6] };

  it('с группами разделители только между ними, первый в местной записи обязателен', () => {
    expect(parsePhone('+44 7700 900001', GROUPED)).toEqual({ digits: '447700900001', national: '7700900001', local: false });
    expect(parsePhone('07700 900001', GROUPED)).toEqual({ digits: '447700900001', national: '7700900001', local: true });
    expect(parsePhone('7700 900001', GROUPED)).toEqual({ digits: '447700900001', national: '7700900001', local: true });
    expect(parsePhone('77 00900001', GROUPED)).toBeNull();
    expect(parsePhone('7700900001', GROUPED)).toBeNull();
    expect(phonePattern('447700900001', GROUPED)).toBe('7700[ ()-]{0,3}900001');
    expect(phoneTailPattern('447700900001', GROUPED)).toBe('(?:\\b|44[ -]?\\(?|\\b0)\\d{4}[ ()-]{0,3}\\d{2}0001\\b');
  });

  it('без плана — только международная запись с плюсом, номер другой страны — всеми цифрами', () => {
    expect(parsePhone('+44 7700 900001', null)).toEqual({ digits: '447700900001', national: null, local: false });
    expect(parsePhone('%2B447700900001', null)).toMatchObject({ digits: '447700900001' });
    expect(parsePhone('447700900001', null)).toBeNull();
    expect(parsePhone('00447700900001', null)).toBeNull();
    expect(parsePhone('+0447700900001', null)).toBeNull();
    expect(parsePhone('+1234567', null)).toBeNull();
    expect(parsePhone('+1234567890123456', null)).toBeNull();
    expect(parsePhone('+1 (202) 555-0101', GROUPED)).toEqual({ digits: '12025550101', national: null, local: false });
    expect(nationalOf('12025550101', GROUPED)).toBeNull();
    expect(nationalOf('447700900001', GROUPED)).toBe('7700900001');
  });

  it('номер страны плана другой длины — не телефон', () => {
    expect(parsePhone('+44 7700 9000', GROUPED)).toBeNull();
    expect(parsePhone('+44 7700 9000012', GROUPED)).toBeNull();
  });

  it('шаблоны без просмотра вперёд и назад: их читает и RE2 хранилища', () => {
    for (const src of [phonePattern('447700900001', GROUPED), phonePattern('447700900001', null), phonePattern('998900000001', UZBEKISTAN.phone)]) {
      expect(src).not.toMatch(/\(\?[<=!]/);
    }
  });
});
