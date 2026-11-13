import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BUILTIN_MASKING, maskDeep, maskKindsText, setRegional, type Regional, type TermKind } from '@threadline/core/search';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { highlight } from './highlight.ts';
import { applyHits, compileForms, findHits, formsOf, tallyHits, MAX_MARKS, type HitSource } from './hits.ts';

const NONE: ReadonlySet<string> = new Set();
const forms = (...terms: [TermKind, string][]) => compileForms(terms.map(([kind, display]) => ({ kind, display })));
const parts = (text: string, f: ReturnType<typeof forms>) => findHits(text, f).ranges.map(([a, b]) => text.slice(a, b));

const PHONE = forms(['phone', '447700900001']);

/** Пример Узбекистана из config/README.md и правила демо-проекта: формы строятся после установки правил. */
const UZBEKISTAN: Regional = {
  phone: { countryCode: '998', nationalDigits: 9, trunkPrefix: '8', groups: [2, 3, 2, 2] },
  patterns: { national_id: ['[3-6](?:0[1-9]|[12]\\d|3[01])(?:0[1-9]|1[0-2])\\d{9}'], passport: ['[A-Z]{2}\\d{7}'], account_number: ['\\d{20}'] },
};
const DEMO: Regional = { phone: { countryCode: '44', nationalDigits: 10, trunkPrefix: '0' }, patterns: { passport: ['[A-Z]{2}\\d{7}'], national_id: ['[A-Z]{2}\\d{6}[A-D]'] } };
const useRegional = (r: Regional) => {
  beforeAll(() => setRegional(r));
  afterAll(() => setRegional(null));
};

describe('подсветка найденного значения', () => {
  it('UUID в теле', () => {
    const id = '1b33b84b-3dd3-4de7-b5de-1c3b1128df6e';
    expect(parts(`{"id":"${id}","x":"${id}"}`, forms(['uuid', id]))).toEqual([id, id]);
  });

  it('значения пересекаются: один сплошной участок и одно совпадение', () => {
    const r = findHits('..abcdefgh..', forms(['text', 'abcdef'], ['text', 'cdefgh']));
    expect(r).toEqual({ count: 1, ranges: [[2, 10]] });
  });

  it('значение на нескольких токенах подсвечено без разрывов', () => {
    const text = 'X-Id: 5\nOther: 1';
    const f = forms(['text', 'X-Id: 5']);
    const pieces = applyHits(highlight(text, 'http'), findHits(text, f).ranges);
    expect(pieces.filter((p) => p.hit).map((p) => p.text).join('')).toBe('X-Id: 5');
    expect(pieces.map((p) => p.text).join('')).toBe(text);
  });

  it('косая черта: экранирование любой глубины и код', () => {
    const f = forms(['text', '/v1/users']);
    for (const s of ['/v1/users', '\\/v1\\/users', '\\\\\\/v1\\\\\\/users', '%2Fv1%2Fusers', '%2fv1%2fusers']) expect(parts(`a ${s} b`, f), s).toEqual([s]);
  });

  it('пробел, @, =, :, +, & в кодах', () => {
    const mail = forms(['text', 'a b@c.com']);
    for (const s of ['a b@c.com', 'a%20b%40c.com', 'a+b%40c.com', 'a b\\u0040c.com']) expect(parts(s, mail), s).toEqual([s]);
    expect(parts('a&amp;b', forms(['text', 'a&b']))).toEqual(['a&amp;b']);
    expect(parts('a%26b', forms(['text', 'a&b']))).toEqual(['a%26b']);
    expect(parts('a\\u0026b', forms(['text', 'a&b']))).toEqual(['a\\u0026b']);
    expect(parts('x%3Dy', forms(['text', 'x=y']))).toEqual(['x%3Dy']);
    expect(parts('x%3Ay', forms(['text', 'x:y']))).toEqual(['x%3Ay']);
    expect(parts('x%2By', forms(['text', 'x+y']))).toEqual(['x%2By']);
  });

  it('кириллица в кодах и с тройным экранированием', () => {
    const f = forms(['text', 'Те']);
    for (const s of ['Те', '\\u0422\\u0435', '\\\\\\u0422\\\\\\u0435', '%D0%A2%D0%B5', '%d0%a2%d0%b5', 'Т\\u0435']) expect(parts(`"${s}"`, f), s).toEqual([s]);
  });

  it('значение из одной буквы и другой регистр', () => {
    expect(parts('Т и т', forms(['text', 'Т']))).toEqual(['Т']);
    expect(parts('PROCESSOR', forms(['text', 'Processor']))).toEqual([]);
  });

  it('телефон открытым: все международные написания', () => {
    for (const s of ['447700900001', '+447700900001', '%2B447700900001', '+44 (7700) 900-001', '+44 7700 900001', '44-7700-900001']) {
      expect(parts(`"phone":"${s}"`, PHONE), s).toEqual([s]);
    }
  });

  it('значение со звёздочками — только такие же символы', () => {
    expect(parts('a** ab**cd ab***cd', forms(['text', 'ab**cd']))).toEqual(['ab**cd']);
  });
});

describe('подсветка и маска', () => {
  it('телефон под маской: маска целиком, имя поля не подсвечено', () => {
    expect(parts('{"phone":"+********0001"}', PHONE)).toEqual(['+********0001']);
    expect(parts('+*** (**) ***-00-01', PHONE)).toEqual(['+*** (**) ***-00-01']);
  });

  it('маска после экранирования: цифры кода не подсвечены', () => {
    expect(parts('%22********0001%22', PHONE)).toEqual(['********0001']);
    expect(parts('"********0001', PHONE)).toEqual(['********0001']);
    expect(parts('\\u0022********0001', PHONE)).toEqual(['********0001']);
  });

  it('хвост маски номера карты и другие цифры не подсвечены', () => {
    expect(parts('411111******0001', PHONE)).toEqual([]);
    expect(parts('+********0002', PHONE)).toEqual([]);
  });

  it('другой телефон с теми же цифрами на конце подсвечен так же', () => {
    expect(parts('+********0001 ********0001', PHONE)).toEqual(['+********0001', '********0001']);
  });

  it('номер карты: маска с группами и другая карта с теми же краями', () => {
    const f = forms(['pan', '411111******7893']);
    expect(parts('411111******7893', f)).toEqual(['411111******7893']);
    expect(parts('"cardNumber":"4111 11** **** 7893"', f)).toEqual(['4111 11** **** 7893']);
    expect(parts('4111-11**-****-7893', f)).toEqual(['4111-11**-****-7893']);
    expect(parts('411111******7890', f)).toEqual([]);
    expect(parts('676712******1234', forms(['pan-mask', '676712******1234']))).toEqual(['676712******1234']);
  });

  it('длинное число: цифры с разделителями и маска', () => {
    const f = forms(['number', '5100123440473348']);
    expect(parts('5100123440473348', f)).toEqual(['5100123440473348']);
    expect(parts('5100 1234 4047 3348', f)).toEqual(['5100 1234 4047 3348']);
    expect(parts('510012******3348', f)).toEqual(['510012******3348']);
  });

  it('серия цифр как текст: маска личного номера или счёта той же длины', () => {
    expect(parts('**********0011', forms(['text', '30101900000011']))).toEqual(['**********0011']);
    expect(parts('*****0001', forms(['text', '900000001']))).toEqual(['*****0001']);
    expect(parts('********0001', forms(['text', '900000001']))).toEqual([]);
    // Без образца паспорта маски паспорта нет и в подсветке.
    expect(parts('AA*****01', forms(['text', 'AA0000001']))).toEqual([]);
  });

  it('фамилия под маской и значение под *** не подсвечиваются; открытая фамилия — да', () => {
    const f = forms(['text', 'Тестов']);
    expect(parts('"family":"Т*****"', f)).toEqual([]);
    expect(parts('"address":"***"', f)).toEqual([]);
    expect(parts('"family":"Тестов"', f)).toEqual(['Тестов']);
  });
});

describe('номер счёта и открытый номер карты', () => {
  it('маска счёта для 20 цифр и для 16 цифр без проверки Луна', () => {
    expect(parts('"x":"****************6001"', forms(['text', '20208000900123456001']))).toEqual(['****************6001']);
    expect(parts('"x":"****************6002"', forms(['text', '20208000900123456001']))).toEqual([]);
    expect(parts('"x":"************0819"', forms(['number', '3501112344650819']))).toEqual(['************0819']);
    expect(parts('"x":"20208000900123456001"', forms(['text', '20208000900123456001']))).toEqual(['20208000900123456001']);
  });

  it('маска другой длины и хвост маски номера карты не подсвечены', () => {
    expect(parts('"x":"************6001"', forms(['text', '20208000900123456001']))).toEqual([]);
    expect(parts('"x":"411111******0819"', forms(['number', '3501112344650819']))).toEqual([]);
  });

  it.each([
    ['pan', '411111******7893'],
    ['pan-mask', '411111******7893'],
    ['number', '4111111234557893'],
  ] as [TermKind, string][])('%s: открытый номер с теми же краями подсвечен, с другими нет', (kind, display) => {
    const f = forms([kind, display]);
    expect(parts('"pan":"4111111234557893"', f)).toEqual(['4111111234557893']);
    expect(parts('"pan":"4111119999957893"', f)).toEqual(['4111119999957893']);
    expect(parts('"pan":"4111 1112 3455 7893"', f)).toEqual(['4111 1112 3455 7893']);
    expect(parts('"pan":"4111111234557000"', f)).toEqual([]);
    if (kind !== 'number') expect(parts('x14111111234557893', f)).toEqual([]);
  });

  it('значение, скрытое целиком, не подсвечено', () => {
    expect(parts('"card_tokens":["***"]', forms(['text', '400000ABCDEF1234']))).toEqual([]);
  });
});

describe('свойство: подсветка не зависит от скрытых цифр', () => {
  const mask = (s: string) => maskKindsText(maskDeep(s, NONE), BUILTIN_MASKING.strict, NONE);
  const CASES: [string, TermKind, string, string, string][] = [
    ['телефон', 'phone', '447700900001', JSON.stringify({ phone: '+442079460001', note: 'x' }), JSON.stringify({ phone: '+441614960001', note: 'x' })],
    ['телефон с разделителями', 'phone', '447700900001', JSON.stringify({ phone: '+44 (2079) 460-001' }), JSON.stringify({ phone: '+44 (1614) 960-001' })],
    ['номер карты', 'pan', '411111******7893', JSON.stringify({ cardNumber: '4111111234557893' }), JSON.stringify({ cardNumber: '4111119999957893' })],
    ['личный номер', 'text', '30101900000011', JSON.stringify({ national_id: '30101900000011' }), JSON.stringify({ national_id: '40202800000011' })],
    ['счёт', 'text', '20208000900123456001', JSON.stringify({ bankAccountId: '20208000900123456001' }), JSON.stringify({ bankAccountId: '11111000900123456001' })],
    ['сырая запись', 'phone', '447700900001', JSON.stringify(JSON.stringify({ phone: '+442079460001' })), JSON.stringify(JSON.stringify({ phone: '+441614960001' }))],
  ];

  it.each(CASES)('%s: один текст после маски, те же участки и счётчик', (_name, kind, display, a, b) => {
    const [ma, mb] = [mask(a), mask(b)];
    expect(ma).toBe(mb);
    expect(ma).not.toBe(a);
    const f = forms([kind, display]);
    const hits = findHits(ma, f);
    expect(hits.count).toBeGreaterThan(0);
    expect(findHits(mb, f)).toEqual(hits);
    // Граница участка не лежит внутри серии звёздочек: участок не намекает на скрытые цифры.
    for (const [s, e] of hits.ranges) {
      expect(ma[s - 1] === '*' && ma[s] === '*').toBe(false);
      expect(ma[e - 1] === '*' && ma[e] === '*').toBe(false);
    }
  });

  it('в коде подсветки нет сети, хранилища браузера и значений поля', () => {
    const code = readFileSync(fileURLToPath(new URL('./hits.ts', import.meta.url)), 'utf8');
    expect(code).not.toMatch(/\b(fetch|XMLHttpRequest|localStorage|sessionStorage|indexedDB|chip)\b/);
  });
});

describe('наложение на токены', () => {
  it('склейка равна исходному тексту на случайных входах', () => {
    let seed = 20261104;
    const rnd = (n: number) => {
      seed = (seed * 48271) % 2147483647;
      return seed % n;
    };
    const ABC = 'ab{}":, \n<>/=x1';
    for (let round = 0; round < 500; round++) {
      const text = Array.from({ length: rnd(120) }, () => ABC[rnd(ABC.length)]).join('');
      const tokens = highlight(text, (['json', 'xml', 'http', 'form', 'text'] as const)[rnd(5)]!);
      const needle = ABC[rnd(ABC.length)]! + ABC[rnd(ABC.length)]!;
      const f = forms(['text', needle.replace(/["\\]/g, 'x')], ['text', 'ab']);
      const pieces = applyHits(tokens, findHits(text, f).ranges);
      expect(pieces.map((p) => p.text).join('')).toBe(text);
    }
  });

  it('за краями участка токены прежние', () => {
    const pieces = applyHits([{ kind: 'key', text: 'abcd' }, { kind: null, text: 'ef' }], [[1, 5]]);
    expect(pieces).toEqual([
      { kind: 'key', text: 'a', hit: false },
      { kind: 'key', text: 'bcd', hit: true },
      { kind: null, text: 'e', hit: true },
      { kind: null, text: 'f', hit: false },
    ]);
  });

  it('те же значения в новом массиве дают те же формы', () => {
    const a = [{ kind: 'text' as const, display: 'abcdef' }];
    expect(formsOf([...a])).toBe(formsOf([{ ...a[0]! }]));
    expect(formsOf([{ kind: 'text', display: 'другое' }])).not.toBe(formsOf(a));
  });
});

describe('время и большие тела', () => {
  const fastest = (f: () => unknown) => {
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const t = performance.now();
      f();
      best = Math.min(best, performance.now() - t);
    }
    return best;
  };
  const MB2 = 2 * 1024 * 1024;
  const json = (() => {
    const item = JSON.stringify({ id: '1b33b84b-3dd3-4de7-b5de-1c3b1128df6e', uri: 'https://x.example/v1/users', phone: '+********0002', n: 123456789, note: 'текст записи' });
    return `[${Array.from({ length: Math.ceil(MB2 / item.length) }, () => item).join(',')}]`;
  })();
  const FIVE = forms(['uuid', '2b33b84b-3dd3-4de7-b5de-1c3b1128df6e'], ['phone', '447700900001'], ['pan', '411111******7893'], ['text', 'a/b c@d.com'], ['text', 'Тестов']);

  it('пять значений на JSON 2 МБ — не дольше 100 мс', () => {
    expect(fastest(() => findHits(json, FIVE))).toBeLessThan(100);
  });

  it.each([
    ['обратные черты', '\\'],
    ['звёздочки', '*'],
    ['цифры', '7'],
  ])('вырожденная строка: %s — не дольше 500 мс', (_n, ch) => {
    const text = ch.repeat(MB2);
    expect(fastest(() => findHits(text, FIVE))).toBeLessThan(500);
  });

  it('24 000 совпадений: счётчик точный, участков 1000', () => {
    const text = 'token '.repeat(24_000);
    const r = findHits(text, forms(['text', 'token']));
    expect(r.count).toBe(24_000);
    expect(r.ranges).toHaveLength(MAX_MARKS);
  });

  it('значение в 2 МБ в конце тела находится', () => {
    const big = `${json},"needle-value"`;
    const r = findHits(big, forms(['text', 'needle-value']));
    expect(r.count).toBe(1);
    expect(big.slice(r.ranges[0]![0], r.ranges[0]![1])).toBe('needle-value');
  });

  it('значение в 1000 символов с кодируемыми символами не ломает остальные', () => {
    const f = forms(['text', 'ж /'.repeat(333)], ['text', 'abcdef']);
    expect(parts('x abcdef y', f)).toEqual(['abcdef']);
  });

  it('подсчёт по записям: порция не дольше 50 мс, неполные считаются как прочитанные', () => {
    const records: HitSource[] = Array.from({ length: 20_000 }, (_, i) => ({ id: `r${i}`, raw: i % 100 === 7 ? 'x needle y' : `{"line":${i},"text":"${'z'.repeat(800)}"}`, http: i === 3 ? { uri: '/v1/needle' } : null }));
    const f = forms(['text', 'needle']);
    expect(fastest(() => tallyHits(records, f, 0, 200, { matched: 0, first: null }))).toBeLessThan(50);
    let tally = { matched: 0, first: null as string | null };
    for (let at = 0; at < records.length; at += 200) tally = tallyHits(records, f, at, at + 200, tally);
    expect(tally).toEqual({ matched: 201, first: 'r3' });
  });
});

describe('цвет подсветки', () => {
  const css = readFileSync(fileURLToPath(new URL('../styles/index.css', import.meta.url)), 'utf8');
  const block = (selector: string) => {
    const i = css.search(new RegExp(`(^|\\n)${selector.replace('.', '\\.')}\\s*\\{`));
    const start = css.indexOf('{', i);
    return css.slice(start + 1, css.indexOf('}', start));
  };
  const token = (selector: string, name: string) => {
    const m = new RegExp(`--${name}:\\s*#([0-9a-fA-F]{6})\\s*;`).exec(block(selector));
    if (!m) throw new Error(`нет токена --${name}`);
    return m[1]!.toLowerCase();
  };
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const lum = (hex: string) => {
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  };
  const contrast = (a: string, b: string) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
    return (hi + 0.05) / (lo + 0.05);
  };

  it.each([
    ['светлая', ':root'],
    ['тёмная', '.dark'],
  ])('%s тема: контраст не ниже 4,5:1, цвет отличается от статусов', (_n, selector) => {
    const bg = token(selector, 'hit-bg');
    expect(contrast(bg, token(selector, 'hit-fg'))).toBeGreaterThanOrEqual(4.5);
    for (const status of ['warning', 'danger', 'success', 'warning-bg', 'danger-bg', 'success-bg']) expect(bg, status).not.toBe(token(selector, status));
  });

  it('класс задаёт только фон и цвет: символы не двигаются', () => {
    const rule = /\.search-hit\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    const props = rule.split(';').map((p) => p.split(':')[0]!.trim()).filter(Boolean).sort();
    expect(props).toEqual(['background-color', 'color']);
  });
});

describe('подсветка с правилами Узбекистана', () => {
  useRegional(UZBEKISTAN);
  const mask = (t: string) => maskKindsText(maskDeep(t, NONE), BUILTIN_MASKING.strict, NONE);

  it('телефон открытым: все написания, и без кода страны', () => {
    const phone = forms(['phone', '998900000001']);
    for (const s of ['998900000001', '+998900000001', '%2B998900000001', '900000001', '8900000001', '+998 (90) 000-00-01', '90-000-00-01', '90 0000001', '(90) 000-00-01']) {
      expect(parts(`"phone":"${s}"`, phone), s).toEqual([s]);
    }
    expect(parts('+*** (**) ***-00-01', phone)).toEqual(['+*** (**) ***-00-01']);
  });

  it('ПИНФЛ, паспорт, девять цифр как текст, номер с 8', () => {
    expect(parts('**********0011', forms(['text', '30101900000011']))).toEqual(['**********0011']);
    expect(parts('AA*****01', forms(['text', 'AA0000001']))).toEqual(['AA*****01']);
    expect(parts('********0001', forms(['text', '900000001']))).toEqual(['********0001']);
    expect(parts('********0001', forms(['text', '8900000001']))).toEqual(['********0001']);
    expect(parts('BB*****01', forms(['text', 'AA0000001']))).toEqual([]);
  });

  it.each([
    ['паспорт', 'AA0000001', 'Паспорт AA1234501', 'Паспорт AA9876501'],
    ['ПИНФЛ', '30101900000011', 'ПИНФЛ 30101900000011', 'ПИНФЛ 40202800000011'],
    ['телефон без плюса', '998900000001', 'Клиент 998901110001', 'Клиент 998335550001'],
  ])('%s в тексте: один текст после маски, участок на маске', (_name, display, a, b) => {
    const [ma, mb] = [mask(a), mask(b)];
    expect(ma).toBe(mb);
    expect(ma).not.toBe(a);
    const kind: TermKind = display.startsWith('998') ? 'phone' : 'text';
    expect(findHits(ma, forms([kind, display])).count).toBeGreaterThan(0);
  });
});

describe('подсветка с правилами демо-проекта', () => {
  useRegional(DEMO);

  it('телефон: национальные написания и маска', () => {
    const phone = forms(['phone', '447700900001']);
    for (const s of ['447700900001', '+447700900001', '7700900001', '07700900001', '07700 900001', '+44 7700 900001']) expect(parts(`"phone":"${s}"`, phone), s).toEqual([s]);
    expect(parts('********0001', forms(['text', '7700900001']))).toEqual(['********0001']);
  });

  it('личный номер и паспорт по образцам: маска подсвечена', () => {
    expect(parts('*****101A', forms(['text', 'ZZ000101A']))).toEqual(['*****101A']);
    expect(parts('ZZ*****01', forms(['text', 'ZZ0000101']))).toEqual(['ZZ*****01']);
    expect(parts('*****101B', forms(['text', 'ZZ000101A']))).toEqual([]);
  });
});
