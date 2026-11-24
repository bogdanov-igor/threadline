import { describe, expect, it } from 'vitest';
import { ALL_KINDS_MASKING } from './mask-pass.ts';
import { DEMO, UZBEKISTAN, useRegional } from './test-regional.ts';
import { detectTerm, edgesPattern, linkFilter, phonePattern, validateExcludes, validateTerms, type Term } from './terms.ts';

const term = (raw: string): Term => {
  const t = detectTerm(raw);
  if ('error' in t) throw new Error(`ожидалось значение, получено ${t.error}`);
  return t;
};

describe('detectTerm: вид значения', () => {
  it('слишком длинное значение отклоняется до сервера', () => {
    expect(detectTerm('a'.repeat(1001))).toEqual({ error: 'too-long' });
    expect(detectTerm('a'.repeat(1000))).toMatchObject({ kind: 'text' });
  });

  it('номер карты: маска в поле, в хранилище только края', () => {
    const t = term('4111111234557893');
    expect(t).toEqual({
      kind: 'pan',
      value: '4111111234557893',
      display: '411111******7893',
      filter: { kind: 'regex', pattern: '411111(?:\\d{6}|\\*{6})7893' },
      pan: '4111111234557893',
    });
    expect(JSON.stringify(t.filter)).not.toContain('4111111234557893');
  });

  it('номер карты с пробелами и с дефисами склеивается', () => {
    expect(term('5555 5512 3457 5728')).toMatchObject({
      kind: 'pan',
      value: '5555551234575728',
      pan: '5555551234575728',
    });
    expect(term('5555-5512-3457-5728')).toMatchObject({ kind: 'pan', value: '5555551234575728' });
    expect(term('  4111 1112-3455 7893  ')).toMatchObject({ kind: 'pan', display: '411111******7893' });
  });

  it('номер в другой записи — тоже номер: уходит шаблоном краёв, а не текстом', () => {
    for (const raw of ['5555  5512 3457 5728', '5555\u00a05512\u00a03457\u00a05728', '5555.5512.3457.5728', '+5555551234575728']) {
      expect(term(raw)).toMatchObject({ kind: 'pan', value: '5555551234575728', filter: { kind: 'regex' } });
    }
    expect(term('2026.11.04.12.30')).toMatchObject({ kind: 'text' });
  });

  it('16 цифр без проверки Луна — длинное число с тем же шаблоном краёв', () => {
    const t = term('5100123440473348');
    expect(t).toMatchObject({
      kind: 'number',
      value: '5100123440473348',
      display: '5100123440473348',
      filter: { kind: 'regex', pattern: '510012(?:\\d{6}|\\*{6})3348' },
      pan: '5100123440473348',
    });
  });

  it('19 цифр — номер, 20 цифр — текст, в том числе с пробелами и дефисами', () => {
    expect(term('1050 0000 9001 2345 6001')).toMatchObject({ kind: 'text', value: '10500000900123456001' });
    expect(term('1050-0000-9001-2345-6001')).toMatchObject({ kind: 'text', filter: { kind: 'contains', value: '10500000900123456001' } });
    expect(term('4111111234567890123').kind).toMatch(/^(pan|number)$/);
    expect(term('41111112345678901234')).toMatchObject({
      kind: 'text',
      filter: { kind: 'contains', value: '41111112345678901234' },
    });
  });

  it('13-значный correlation_id сервиса карт — текст; разделители склеиваются', () => {
    expect(term('6300014100001')).toEqual({
      kind: 'text',
      value: '6300014100001',
      display: '6300014100001',
      filter: { kind: 'contains', value: '6300014100001' },
    });
    expect(term('6300 0141 00001')).toMatchObject({ kind: 'text', value: '6300014100001' });
  });

  it('маска с разным числом звёздочек', () => {
    expect(term('676712******1234')).toEqual({
      kind: 'pan-mask',
      value: '676712******1234',
      display: '676712******1234',
      filter: { kind: 'regex', pattern: '676712(?:\\d{6}|\\*{6})1234' },
    });
    expect(term('676712***1234').filter).toEqual({ kind: 'regex', pattern: '676712(?:\\d{3}|\\*{3})1234' });
    expect(term('676712*1234').filter).toEqual({ kind: 'regex', pattern: '676712(?:\\d{1}|\\*{1})1234' });
    expect(term('676712*********1234').kind).toBe('pan-mask');
    expect(term('676712**********1234').kind).toBe('text');
    expect(term('86004******1234').kind).toBe('text');
  });

  it('UUID', () => {
    expect(term('1b33b84b-3dd3-4de7-b5de-1c3b1128df6e')).toEqual({
      kind: 'uuid',
      value: '1b33b84b-3dd3-4de7-b5de-1c3b1128df6e',
      display: '1b33b84b-3dd3-4de7-b5de-1c3b1128df6e',
      filter: { kind: 'contains', value: '1b33b84b-3dd3-4de7-b5de-1c3b1128df6e' },
    });
    expect(term('0192F3A4-5B6C-7D8E-9F01-23456789ABCD').kind).toBe('uuid');
  });

  it('телефон с плюсом ищется без плюса: без плана номеров — всеми цифрами', () => {
    expect(term('+447700900123')).toEqual({
      kind: 'phone',
      value: '447700900123',
      display: '447700900123',
      filter: { kind: 'regex', pattern: phonePattern('447700900123') },
    });
    expect(phonePattern('447700900123')).toBe('4[ ()-]{0,2}4[ ()-]{0,2}7[ ()-]{0,2}7[ ()-]{0,2}0[ ()-]{0,2}0[ ()-]{0,2}9[ ()-]{0,2}0[ ()-]{0,2}0[ ()-]{0,2}1[ ()-]{0,2}2[ ()-]{0,2}3');
    expect(term('+1 (202) 555-0101')).toMatchObject({ kind: 'phone', value: '12025550101' });
    expect(term('%2B447700900123')).toMatchObject({ kind: 'phone', value: '447700900123' });
    // Без плюса цифры — текст: код страны не отделить от номера.
    expect(term('447700900123')).toMatchObject({ kind: 'text', value: '447700900123' });
    expect(term('0044 7700 900123').kind).toBe('text');
    expect(term('+1234567').kind).toBe('text');
  });

  it('текст ищется как есть', () => {
    expect(term('  getCard ')).toEqual({
      kind: 'text',
      value: 'getCard',
      display: 'getCard',
      filter: { kind: 'contains', value: 'getCard' },
    });
    expect(term('/v1/cards/lookup').kind).toBe('text');
  });

  it('короткие значения', () => {
    expect(detectTerm('7')).toEqual({ error: 'too-short' });
    expect(detectTerm('  a  ')).toEqual({ error: 'too-short' });
    expect(detectTerm('')).toEqual({ error: 'too-short' });
    expect(term('pa').kind).toBe('text');
  });

  it('кавычки и обратная косая черта не принимаются', () => {
    expect(detectTerm('"result":"error"')).toEqual({ error: 'forbidden-char' });
    expect(detectTerm('Http\\Exception')).toEqual({ error: 'forbidden-char' });
  });
});

describe('edgesPattern', () => {
  it('находит полный номер, номер с теми же краями и маску', () => {
    const re = new RegExp(edgesPattern('4111111234557893'));
    expect(re.test('"RCARD":"4111111234557893"')).toBe(true);
    expect(re.test('4111119999957893')).toBe(true);
    expect(re.test('411111******7893')).toBe(true);
    expect(re.test('4111111234557890')).toBe(false);
    expect(re.test('411111****7893')).toBe(false);
  });

  it('по маске строит шаблон с тем же числом цифр', () => {
    expect(edgesPattern('676712******1234')).toBe('676712(?:\\d{6}|\\*{6})1234');
    expect(new RegExp(edgesPattern('676712******1234')).test('6767121234561234')).toBe(true);
  });

  it('отклоняет не номер', () => {
    expect(() => edgesPattern('abc')).toThrow();
    expect(() => edgesPattern('1234567890')).toThrow();
  });
});

describe('validateTerms', () => {
  it('несколько значений', () => {
    const r = validateTerms(['account', 'customer', 'pa']);
    expect(r.ok && r.terms.map((t) => t.value)).toEqual(['account', 'customer', 'pa']);
  });

  it('все значения короткие — нужно значение от 6 символов', () => {
    expect(validateTerms(['pa', 'pay'])).toEqual({ ok: false, error: 'need-long' });
    expect(validateTerms(['pa', 'abcdef']).ok).toBe(true);
  });

  it('значение из одного символа — ошибка с индексом', () => {
    expect(validateTerms(['abcdef', '7'])).toEqual({ ok: false, error: { index: 1, error: 'too-short' } });
  });

  it('кавычки — ошибка с индексом', () => {
    expect(validateTerms(['a"bcdef'])).toEqual({ ok: false, error: { index: 0, error: 'forbidden-char' } });
    expect(validateTerms(['', 'abc\\def'])).toEqual({
      ok: false,
      error: { index: 1, error: 'forbidden-char' },
    });
  });

  it('шесть значений — предел пять', () => {
    expect(validateTerms(['aaaaaa', 'bb', 'cc', 'dd', 'ee', 'ff'])).toEqual({ ok: false, error: 'too-many' });
    expect(validateTerms(['aaaaaa', 'bb', 'cc', 'dd', 'ee']).ok).toBe(true);
  });

  it('повторы убираются, в том числе после нормализации', () => {
    const r = validateTerms([
      'abcdef',
      ' abcdef ',
      '+447700900123',
      '+44 7700 900123',
      '5555 5512 3457 5728',
      '5555551234575728',
    ]);
    expect(r.ok && r.terms.map((t) => t.kind)).toEqual(['text', 'phone', 'pan']);
  });

  it('повторы не считаются в предел', () => {
    expect(validateTerms(['aaaaaa', 'bb', 'cc', 'dd', 'ee', 'bb']).ok).toBe(true);
  });

  it('регистр различается', () => {
    const r = validateTerms(['Account', 'account']);
    expect(r.ok && r.terms).toHaveLength(2);
  });

  it('пусто', () => {
    expect(validateTerms([])).toEqual({ ok: false, error: 'empty' });
    expect(validateTerms(['  ', ''])).toEqual({ ok: false, error: 'empty' });
  });

  it('номер считается длинным значением', () => {
    const r = validateTerms(['4111111234557893', 'pa']);
    expect(r.ok && r.terms.map((t) => t.kind)).toEqual(['pan', 'text']);
  });
});

describe('телефон по плану номеров: пример Узбекистана', () => {
  useRegional(UZBEKISTAN);

  const FULL = ['+998 90 111 22 33', '998-90-111-22-33', '+998 (90) 111-22-33', '(+998) 90 1112233', '998901112233', '+998901112233'];
  const LOCAL = ['(90) 111-22-33', '90 111 22 33', '90-111-22-33', '90 1112233', '8 90 111 22 33', '8(90)111-22-33', '8-90-111-22-33', '90\u00a0111\u00a022\u00a033', '90\u202f111\u202f22\u202f33'];

  it('с кодом страны: метка в общем виде, признака местного номера нет', () => {
    for (const raw of FULL) {
      const t = term(raw);
      expect(t, raw).toMatchObject({ kind: 'phone', value: '998901112233', display: '998901112233', filter: { kind: 'regex', pattern: '90[ ()-]{0,3}111[ -]?22[ -]?33' } });
      expect(t.local, raw).toBeUndefined();
    }
  });

  it('местный номер и номер с 8: тот же телефон с признаком', () => {
    for (const raw of LOCAL) {
      expect(term(raw), raw).toMatchObject({ kind: 'phone', value: '998901112233', display: '998901112233', local: true });
    }
    expect(term('12-345-67-89')).toMatchObject({ kind: 'phone', value: '998123456789', local: true });
  });

  it('остальное — текст как введено', () => {
    const texts = ['901112233', '8901112233', '901 112 233', '123456789012', '+998 90 111 22', '+998 90 000 00 01 02', '+998 90 000 00 01 доб. 5', '90.111.22.33', '2026-11-04', '10:15:33', '********2233'];
    for (const raw of texts) expect(term(raw), raw).toMatchObject({ kind: 'text', value: raw, display: raw, filter: { kind: 'contains', value: raw } });
  });

  it('номер другой страны с плюсом — международный телефон всеми цифрами', () => {
    expect(term('+7 901 111 22 33')).toMatchObject({ kind: 'phone', value: '79011112233', filter: { kind: 'regex', pattern: phonePattern('79011112233') } });
    expect(term('+79011112233')).toMatchObject({ kind: 'phone', value: '79011112233' });
  });

  it('номер карты и UUID телефоном не становятся', () => {
    expect(term('998 90 111 22 33 12 34').kind).toMatch(/^(pan|number)$/);
    expect(term('+4111111234557893')).toMatchObject({ kind: 'pan', value: '4111111234557893' });
    expect(term('99890123-4567-4abc-8def-0123456789ab').kind).toBe('uuid');
  });

  it('все написания дают одно значение: повторы убираются', () => {
    const r = validateTerms(['(90) 111-22-33', '+998901112233', '8 90 111 22 33']);
    expect(r.ok && r.terms.map((t) => t.value)).toEqual(['998901112233']);
  });
});

describe('phonePattern: пример Узбекистана', () => {
  useRegional(UZBEKISTAN);
  const re = () => new RegExp(phonePattern('998900000001'));

  it('строится только из цифр', () => {
    expect(phonePattern('998901112233')).toBe('90[ ()-]{0,3}111[ -]?22[ -]?33');
    expect(() => phonePattern('99890111223x')).toThrow();
    expect(() => phonePattern('901')).toThrow();
  });

  it('находит все написания номера', () => {
    for (const line of ['998900000001', '+998900000001', '%2B998900000001', '900000001', '8900000001', '+998 (90) 000-00-01', '90-000-00-01', '90 0000001']) {
      expect(re().test(line), line).toBe(true);
    }
    expect(new RegExp(phonePattern('998123456789')).test('12-345-67-89')).toBe(true);
  });

  it('девять цифр внутри длинного числа совпадают, другие группы — нет', () => {
    expect(re().test('12345678900000001234')).toBe(true);
    expect(re().test('900 000 001')).toBe(false);
  });

  it('каждое распознанное написание находит само себя', () => {
    for (const raw of ['+998 90 111 22 33', '998-90-111-22-33', '+998 (90) 111-22-33', '(+998) 90 1112233', '998901112233', '+998901112233', '(90) 111-22-33', '90 111 22 33', '90-111-22-33', '90 1112233', '8 90 111 22 33', '8(90)111-22-33', '8-90-111-22-33']) {
      const t = term(raw);
      expect(t.kind, raw).toBe('phone');
      expect(t.filter.kind === 'regex' && new RegExp(t.filter.pattern).test(raw), raw).toBe(true);
    }
  });

  it('подходит и для JS, и для RE2: нет просмотра назад и вперёд', () => {
    expect(phonePattern('998901112233')).not.toMatch(/\(\?[<=!]/);
    expect(phonePattern('447700900001')).not.toMatch(/\(\?[<=!]/);
  });
});

describe('телефон по плану номеров: демо-проект без групп', () => {
  useRegional(DEMO);

  it('все написания номера дают одно значение и один фильтр', () => {
    const spellings = ['+447700900001', '447700900001', '+44 (7700) 900001', '+44 7700 900-001', '7700 900001', '7700-900001', '07700 900001', '0 7700 900001'];
    for (const raw of spellings) {
      const t = term(raw);
      expect(t, raw).toMatchObject({ kind: 'phone', value: '447700900001', display: '447700900001' });
      expect(t.filter.kind === 'regex' && new RegExp(t.filter.pattern).test(raw), raw).toBe(true);
    }
    expect(term('7700 900001').local).toBe(true);
    expect(term('+447700900001').local).toBeUndefined();
    const re = new RegExp(phonePattern('447700900001'));
    for (const line of ['%2B447700900001', '07700900001', '7700900001', '+44 (7700) 900-001']) expect(re.test(line), line).toBe(true);
  });

  it('национальные цифры подряд и номер другой длины — текст', () => {
    for (const raw of ['7700900001', '07700900001', '4477009000012', '+44 7700 9000']) expect(term(raw), raw).toMatchObject({ kind: 'text' });
  });

  it('ссылка: последние четыре цифры, код страны перед номером любой', () => {
    const l = linkFilter(term('+44 7700 900001'))!;
    expect(l.filter.kind === 'regex' && new RegExp(l.filter.pattern).test('"phone":"447700900001"')).toBe(true);
    expect(l.filter.kind === 'regex' && new RegExp(l.filter.pattern).test('07700 900001')).toBe(true);
    expect(JSON.stringify(l)).not.toContain('7700900');
    expect(linkFilter(term('7700900001'))!.filter).toEqual(l.filter);
  });

  it('паспорт и личный номер по образцам: в ссылку только края', () => {
    expect(linkFilter(term('ZZ0000101'))).toEqual({ filter: { kind: 'regex', pattern: '\\bZZ[ -]?\\d{5}01\\b' }, wider: true, typed: false });
    expect(linkFilter(term('ZZ000101A'))).toEqual({ filter: { kind: 'regex', pattern: '\\b[A-Za-z0-9]{5}101A\\b' }, wider: true, typed: false });
  });
});

describe('linkFilter: какие значения идут в ссылку на Grafana', () => {
  const link = (raw: string) => linkFilter(term(raw));
  const pattern = (raw: string) => {
    const l = link(raw);
    if (!l || l.filter.kind !== 'regex') throw new Error(`ожидался шаблон: ${raw}`);
    return l.filter.pattern;
  };

  it('номер карты и длинное число: шаблон краёв, шире', () => {
    expect(link('4111111234557893')).toEqual({ filter: { kind: 'regex', pattern: '411111(?:\\d{6}|\\*{6})7893' }, wider: true, typed: false });
    expect(link('5100123440473348')).toEqual({ filter: { kind: 'regex', pattern: '510012(?:\\d{6}|\\*{6})3348' }, wider: true, typed: false });
  });

  it('номер в необычной записи уже распознан как номер: в адресе только края', () => {
    for (const raw of ['4111.1112.3455.7893', '+4111111234557893', '4111  1112 3455 7893', '4111\u00a01112\u00a03455\u00a07893']) {
      expect(link(raw), raw).toEqual({ filter: { kind: 'regex', pattern: '411111(?:\\d{6}|\\*{6})7893' }, wider: true, typed: false });
    }
  });

  it('маска номера: тот же шаблон, не шире', () => {
    expect(link('411111******7893')).toEqual({ filter: { kind: 'regex', pattern: '411111(?:\\d{6}|\\*{6})7893' }, wider: false, typed: false });
  });

  it('UUID как есть', () => {
    expect(link('1b33b84b-3dd3-4de7-b5de-1c3b1128df6e')).toEqual({ filter: { kind: 'contains', value: '1b33b84b-3dd3-4de7-b5de-1c3b1128df6e' }, wider: false, typed: true });
  });

  it('телефон: только последние четыре, разделители между любыми цифрами', () => {
    const l = link('+44 7700 900001');
    expect(l).toEqual({ filter: { kind: 'regex', pattern: `\\b${[...'44770090'].map(() => '\\d').join('[ ()-]{0,2}')}[ ()-]{0,2}0[ ()-]{0,2}0[ ()-]{0,2}0[ ()-]{0,2}1\\b` }, wider: true, typed: false });
    expect(JSON.stringify(l)).not.toContain('7700');
  });

  it('числа длиной 9, 10, 11, 12, 14: только последние четыре', () => {
    expect(pattern('900000001')).toBe('\\b\\d{5}0001\\b');
    expect(pattern('8900000001')).toBe('\\b\\d{6}0001\\b');
    expect(pattern('79010000001')).toBe('\\b\\d{7}0001\\b');
    expect(pattern('123456789012')).toBe('\\b\\d{8}9012\\b');
    expect(pattern('30101900000011')).toBe('\\b\\d{10}0011\\b');
  });

  it('паспорт без образца раздела regional — как есть', () => {
    expect(link('AA0000001')).toEqual({ filter: { kind: 'contains', value: 'AA0000001' }, wider: false, typed: true });
  });

  it('свойство: значения с одной маской дают один фильтр', () => {
    const same = (a: string, b: string) => expect(link(a)!.filter, `${a} и ${b}`).toEqual(link(b)!.filter);
    same('+44 7700 900001', '+44 2079 460001');
    same('4111111234557893', '4111119999957893');
    same('30101900000011', '40202800000011');
  });

  it('отказ: значение нельзя отделить от номера или секрета', () => {
    for (const raw of ['pay 4111.1112.3455.7893', 'card 4111111234557893', 'тел 900000001', 'phone=+447700900001', 'call +447700900001', 'password=abc', '$abc', '${abc}', '[[abc]]', '2026-11-04 10:15:33']) {
      expect(link(raw), raw).toBeNull();
    }
  });

  it('как есть: адреса, обозначения, даты, длинные числа, обычный текст', () => {
    for (const raw of ['192.168.100.200', '192.168.100.200:8080', '6300014100001', 'TXN20261104000123', 'ORDER-2026-000123', '2026-11-04', 'processor', 'Тестов']) {
      expect(link(raw), raw).toEqual({ filter: { kind: 'contains', value: raw }, wider: false, typed: true });
    }
  });

  it('счёт из 20 цифр: в адрес только последние 4 цифры, тем же шаблоном при любой записи', () => {
    const a = link('10500000900123456001')!;
    expect(a).toEqual({ filter: { kind: 'regex', pattern: '\\b\\d{16}6001\\b' }, wider: true, typed: false });
    expect(link('1050 0000 9001 2345 6001')).toEqual(a);
    expect(link('1050-0000-9001-2345-6001')).toEqual(a);
    expect(JSON.stringify(a)).not.toContain('1050000090012345');
  });

  it('токен карты закрывает ссылку; e-mail закрывает, только если вид включён в настройке проекта', () => {
    expect(link('400000ABCDEF1234')).toBeNull();
    expect(link('user@example.com')).toEqual({ filter: { kind: 'contains', value: 'user@example.com' }, wider: false, typed: true });
    expect(linkFilter(term('user@example.com'), ALL_KINDS_MASKING.strict)).toBeNull();
  });

  it('шаблоны не совпадают с отметкой времени в наносекундах и с числом внутри длинного', () => {
    const ts = '1793000000000000001';
    for (const raw of ['+44 7700 900001', '900000001', '8900000001', '30101900000011']) {
      const re = new RegExp(pattern(raw));
      expect(re.test(ts), raw).toBe(false);
      expect(re.test('55512345678900000001'), raw).toBe(false);
    }
    expect(new RegExp(pattern('+44 7700 900001')).test('"phone":"+44 7700 900001"')).toBe(true);
  });
});

describe('linkFilter: пример Узбекистана', () => {
  useRegional(UZBEKISTAN);
  const link = (raw: string) => linkFilter(term(raw));
  const pattern = (raw: string) => {
    const l = link(raw);
    if (!l || l.filter.kind !== 'regex') throw new Error(`ожидался шаблон: ${raw}`);
    return l.filter.pattern;
  };

  it('телефон и девять цифр: только последние четыре', () => {
    const expected = '(?:\\b|998[ -]?\\(?|\\b8)\\d{2}[ ()-]{0,3}\\d{3}[ -]?00[ -]?01\\b';
    expect(link('+998 90 000 00 01')).toEqual({ filter: { kind: 'regex', pattern: expected }, wider: true, typed: false });
    expect(link('900000001')).toEqual({ filter: { kind: 'regex', pattern: expected }, wider: true, typed: false });
  });

  it('паспорт целиком: серия и две цифры; ПИНФЛ — последние четыре', () => {
    expect(link('AA0000001')).toEqual({ filter: { kind: 'regex', pattern: '\\bAA[ -]?\\d{5}01\\b' }, wider: true, typed: false });
    expect(pattern('30101900000011')).toBe('\\b\\d{10}0011\\b');
  });

  it('свойство: значения с одной маской дают один фильтр', () => {
    const same = (a: string, b: string) => expect(link(a)!.filter, `${a} и ${b}`).toEqual(link(b)!.filter);
    same('+998 90 000 00 01', '+998 33 777 00 01');
    same('(90) 000-00-01', '998337770001');
    same('AA0000001', 'AA9999901');
  });

  it('отказ: значение нельзя отделить от номера', () => {
    for (const raw of ['90 000 00 01 доб. 5', 'тел 900000001', 'phone=998900000001']) expect(link(raw), raw).toBeNull();
  });

  it('шаблоны не совпадают с отметкой времени и находят номер в любой записи', () => {
    const ts = '1793000000000000001';
    for (const raw of ['+998 90 000 00 01', '900000001', '8900000001', '30101900000011']) {
      const re = new RegExp(pattern(raw));
      expect(re.test(ts), raw).toBe(false);
      expect(re.test('55512345678900000001'), raw).toBe(false);
    }
    expect(new RegExp(pattern('900000001')).test('"phone":"998900000001"')).toBe(true);
    expect(new RegExp(pattern('900000001')).test('+998 (90) 000-00-01')).toBe(true);
  });
});

describe('исключённые значения', () => {
  const terms = (raws: string[]) => {
    const v = validateTerms(raws);
    if (!v.ok) throw new Error('значения поиска не приняты');
    return v.terms;
  };
  const SEARCH = terms(['getCard']);

  it('короткое значение проходит: правило о 6 символах к нему не относится', () => {
    expect(validateExcludes(['ok'], SEARCH)).toMatchObject({ ok: true, excludes: [{ kind: 'text', value: 'ok' }] });
  });

  it('пустой список и пустые значения допустимы, повторы убираются', () => {
    expect(validateExcludes([], SEARCH)).toEqual({ ok: true, excludes: [] });
    expect(validateExcludes(['  ', 'ok', ' ok '], SEARCH)).toMatchObject({ ok: true, excludes: [{ value: 'ok' }] });
  });

  it('те же запреты: один символ, кавычка, обратная косая черта, шестое значение', () => {
    expect(validateExcludes(['x'], SEARCH)).toEqual({ ok: false, error: { index: 0, error: 'too-short' } });
    expect(validateExcludes(['ok', 'a"b'], SEARCH)).toEqual({ ok: false, error: { index: 1, error: 'forbidden-char' } });
    expect(validateExcludes(['a\\b'], SEARCH)).toEqual({ ok: false, error: { index: 0, error: 'forbidden-char' } });
    expect(validateExcludes(['aa', 'bb', 'cc', 'dd', 'ee', 'ff'], SEARCH)).toEqual({ ok: false, error: 'too-many' });
  });

  it('номер карты — шаблоном краёв, полного номера в фильтре нет', () => {
    const v = validateExcludes(['4111111234557893'], SEARCH);
    expect(v).toMatchObject({ ok: true, excludes: [{ kind: 'pan', display: '411111******7893', filter: { kind: 'regex', pattern: edgesPattern('4111111234557893') } }] });
    expect(v.ok && JSON.stringify(v.excludes[0]!.filter)).not.toContain('4111111234557893');
  });

  it('значение есть в поиске или входит в него: результат заведомо пуст', () => {
    expect(validateExcludes(['getCard'], SEARCH)).toEqual({ ok: false, error: { index: 0, error: 'conflict' } });
    expect(validateExcludes(['ok', 'Card'], SEARCH)).toEqual({ ok: false, error: { index: 1, error: 'conflict' } });
    // Тот же шаблон краёв: маска исключает всё, что нашёл номер.
    expect(validateExcludes(['411111******7893'], terms(['4111111234557893']))).toEqual({ ok: false, error: { index: 0, error: 'conflict' } });
  });

  it('значение длиннее искомого не конфликтует: строка может содержать только искомое', () => {
    expect(validateExcludes(['getCardFailed'], SEARCH)).toMatchObject({ ok: true });
  });
});
