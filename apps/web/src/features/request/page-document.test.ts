import { luhnValid, withLuhnCheckDigit } from '@threadline/core';
import { setRegional } from '@threadline/core/search';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanCss, marksInPage, PAGE_CSP, PAGE_TAG_LIMIT, pageHide, pageShell, pageViewer, tooManyTags, type PageHide, type PageSegment } from './page-document.ts';

// Номера, которые складывает только браузер. Обход DOM даёт отрезки: блок, его предыдущий сосед-элемент и текст по узлам.
const BOTH: PageHide = { cards: true, phones: true };
const CARD = withLuhnCheckDigit('555555123456789');

function seg(nodes: string | string[], block: object = {}, after: object | null = null): PageSegment {
  const starts: number[] = [];
  let text = '';
  for (const part of Array.isArray(nodes) ? nodes : [nodes]) {
    starts.push(text.length);
    text += part;
  }
  return { text, starts, block, after };
}

/** Ячейки одной строки подряд: каждая следующая стоит сразу за предыдущей. */
function row(...cells: (string | string[])[]): PageSegment[] {
  let prev: object | null = null;
  return cells.map((cell) => {
    const block = {};
    const s = seg(cell, block, prev);
    prev = block;
    return s;
  });
}

/** Текст отрезков после замены и счётчики. */
function shown(segments: PageSegment[], hide: PageHide = BOTH) {
  const { marks, cards, phones } = marksInPage(segments, hide);
  const text = segments.map((s, i) => {
    let out = '';
    let at = 0;
    for (const c of s.text) {
      out += marks.get(i)?.has(at) ? '*' : c;
      at += c.length;
    }
    return out;
  });
  return { text, cards, phones };
}

const groups = (digits: string) => digits.match(/.{1,4}/g)!;

describe('номер карты из соседних блоков', () => {
  it('ячейки строки и группы в абзацах', () => {
    expect(shown(row(...groups(CARD)))).toEqual({ text: ['5555', '55**', '****', CARD.slice(-4)], cards: 1, phones: 0 });
    expect(shown(row('5555 5512', `3456-${CARD.slice(-4)}`)).text).toEqual(['5555 55**', `****-${CARD.slice(-4)}`]);
    // Пробел между ячейками в самой строке цепочку не рвёт.
    const [a, b] = row('5555 5512', `3456 ${CARD.slice(-4)}`);
    expect(shown([a!, seg('\n  ', {}), b!]).cards).toBe(1);
  });

  it('19 цифр: последняя группа короче, Луна у всего номера', () => {
    const long = withLuhnCheckDigit('555555123456789012');
    expect(shown(row(...groups(long))).text.join('')).toBe(`${long.slice(0, 6)}${'*'.repeat(9)}${long.slice(-4)}`);
  });

  it('сумма и дата, номер заказа рядом с телефоном: группы не по четыре, хотя Луна сходится', () => {
    let amount = 15_000_000;
    while (!luhnValid(`${amount}20261105`)) amount++;
    expect(shown(row(String(amount), '20261105'))).toEqual({ text: [String(amount), '20261105'], cards: 0, phones: 0 });
    let order = 4521;
    while (!luhnValid(`${order}447700900101`)) order++;
    expect(shown(row(String(order), '447700900101')).cards).toBe(0);
  });

  it('цепочка длиннее номера: ничего не меняется, даже если первые 16 цифр проходят Луну', () => {
    expect(shown(row(...groups(CARD), '3456')).cards).toBe(0);
    expect(shown(row('1111', ...groups(CARD))).cards).toBe(0);
  });

  it('Луна не прошла, короткая группа не в конце', () => {
    expect(luhnValid('2021202220232024')).toBe(false);
    expect(shown(row('2021', '2022', '2023', '2024')).cards).toBe(0);
    expect(shown(row('5555', '551', '23456', '7890')).cards).toBe(0);
  });

  it('части не рядом: слово, пустая ячейка, другая строка, другой родитель', () => {
    const [g1, g2, g3, g4] = groups(CARD) as [string, string, string, string];
    expect(shown(row(g1, g2, 'Visa', g3, g4)).cards).toBe(0);
    // Пустая ячейка без текста: у третьей части сосед — она, а не вторая часть.
    const [b1, b2, empty, b3] = [{}, {}, {}, {}];
    expect(shown([seg(g1, b1), seg(g2, b2, b1), seg(g3, b3, empty), seg(g4, {}, b3)]).cards).toBe(0);
    expect(shown([...row(g1, g2), ...row(g3, g4)]).cards).toBe(0);
    // Абзацы в разных div: каждый первый у своего родителя.
    expect(shown([seg(`${g1} ${g2}`), seg(`${g3} ${g4}`)]).cards).toBe(0);
  });

  it('номер в одной ячейке закрыт как раньше, соседняя ячейка к нему не добавляется', () => {
    expect(shown(row(groups(CARD).join(' '), '1234'))).toEqual({ text: [`5555 55** **** ${CARD.slice(-4)}`, '1234'], cards: 1, phones: 0 });
    // Внутри блока через строчные теги: узлы одного отрезка.
    expect(shown([seg(['5555 ', '5512', ` 3456 ${CARD.slice(-4)}`])]).text).toEqual([`5555 55** **** ${CARD.slice(-4)}`]);
  });

  it('номер карты не закрывается, если зрителю он открыт', () => {
    expect(shown(row(...groups(CARD)), { cards: false, phones: true }).text).toEqual(groups(CARD));
  });
});

describe('телефон, разбитый тегами страницы: международные правила', () => {
  it('группы в тегах и номер после кода страны в теге', () => {
    expect(shown([seg(['Phone +44 ', '7700', ' 900101'])])).toEqual({ text: ['Phone +** **** **0101'], cards: 0, phones: 1 });
    expect(shown([seg(['+44', '7700900101'])]).text).toEqual(['+********0101']);
    // Без плана номеров цифры без плюса телефоном не считаются.
    expect(shown([seg(['44', '7700900101'])]).phones).toBe(0);
  });

  it('целый телефон в одном узле решает маска сервера', () => {
    expect(shown([seg('Клиент +447700900101')])).toEqual({ text: ['Клиент +447700900101'], cards: 0, phones: 0 });
  });

  it('часть длинного числа, телефон в разных ячейках, телефон открыт зрителю', () => {
    expect(shown([seg(['1', '+447700900101'])]).phones).toBe(0);
    expect(shown([seg(['+447700', '9001012345'])]).phones).toBe(0);
    expect(shown(row('+44', '7700 900101')).phones).toBe(0);
    expect(shown([seg(['+44 ', '7700', ' 900101'])], { cards: true, phones: false }).phones).toBe(0);
  });
});

describe('телефон, разбитый тегами страницы: пример Узбекистана', () => {
  beforeAll(() => setRegional({ phone: { countryCode: '998', nationalDigits: 9, trunkPrefix: '8', groups: [2, 3, 2, 2] }, patterns: {} }));
  afterAll(() => setRegional(null));

  it('группы в тегах и номер после кода страны в теге', () => {
    expect(shown([seg(['Phone +998 ', '90', ' 000 01 01'])])).toEqual({ text: ['Phone +*** ** *** 01 01'], cards: 0, phones: 1 });
    expect(shown([seg(['998', '900000101'])]).text).toEqual(['********0101']);
  });

  it('целый телефон в одном узле решает маска сервера', () => {
    expect(shown([seg('Клиент 998900000101')])).toEqual({ text: ['Клиент 998900000101'], cards: 0, phones: 0 });
  });

  it('часть длинного числа, телефон в разных ячейках, телефон открыт зрителю', () => {
    expect(shown([seg(['1', '998900000101'])]).phones).toBe(0);
    expect(shown([seg(['998900', '000101234'])]).phones).toBe(0);
    expect(shown(row('+998', '90 000 01 01')).phones).toBe(0);
    expect(shown([seg(['+998 ', '90', ' 000 01 01'])], { cards: true, phones: false }).phones).toBe(0);
  });

  it('много кодов страны — линейно', () => {
    const t = performance.now();
    shown([seg(Array.from({ length: 20_000 }, () => '998 9'))]);
    expect(performance.now() - t).toBeLessThan(2000);
  });
});

describe('что страница закрывает у зрителя', () => {
  it('зритель как у сервера', () => {
    expect(pageViewer(true, 'on', 'admin')).toBe('link');
    expect(pageViewer(false, 'off', 'admin')).toBe('no-login');
    expect(pageViewer(false, 'on', 'support')).toBe('support');
    expect(pageViewer(false, 'on', null)).toBe('business');
  });

  it('до и после показа', () => {
    expect(pageHide('support', false)).toEqual(BOTH);
    expect(pageHide('support', true)).toEqual({ cards: false, phones: false });
    expect(pageHide('no-login', true)).toEqual({ cards: true, phones: false });
    expect(pageHide('analyst', false)).toEqual({ cards: true, phones: false });
    expect(pageHide('link', true)).toEqual(BOTH);
  });
});

describe('разбор страницы линейный', () => {
  it('тысячи ячеек, длинная серия цифр и много кодов страны', () => {
    const t = performance.now();
    shown(row(...Array.from({ length: 50_000 }, () => '1234')));
    shown([seg('1 '.repeat(100_000))]);
    shown([seg(Array.from({ length: 20_000 }, () => '+44 9'))]);
    expect(performance.now() - t).toBeLessThan(2000);
  });
});

describe('стиль страницы', () => {
  it('внешние ссылки убраны, остальное на месте', () => {
    const css = cleanCss('@import "https://evil.example/a.css"; body{color:red;background:url(https://evil.example/a.png) no-repeat} @font-face{font-family:x;src:url(//evil.example/f.woff)} h1{background-image:image-set("https://evil.example/b.png" 1x)}');
    expect(css).not.toContain('evil.example');
    expect(css).not.toContain('@import');
    expect(css).not.toContain('@font-face');
    expect(css).toContain('color:red');
    expect(css).toContain('background:none no-repeat');
  });

  it('разное написание и скобки внутри адреса', () => {
    for (const css of ['a{background:URL("x")}', 'a{background:url( (x) )}', 'a{width:expression(alert(1))}', 'a{behavior:url(x.htc)}', 'a{-moz-binding:url(x)}', 'a{background:-webkit-image-set(url(x) 1x)}']) {
      const out = cleanCss(css);
      expect(out, css).not.toMatch(/url\s*\(|expression/i);
    }
  });

  it('экранирование: стиль убран целиком', () => {
    expect(cleanCss('a{background:u\\72l(https://evil.example/)}')).toBe('');
  });
});

describe('стиль страницы: то, что собиралось обратно или пряталось от проверки', () => {
  it('правило, собранное удалением другого', () => {
    for (const css of ['@im@import x;port "http://evil.example/a.css";', '@im@namespace y;port "http://evil.example/a.css";']) expect(cleanCss(css), css).not.toMatch(/@import|evil\.example/);
    // Вложений больше, чем проходов: стиль убран целиком.
    expect(cleanCss(`${'@im'.repeat(5)}@import x;${'port y;'.repeat(5)}`)).toBe('');
  });

  it('значение без закрывающей скобки и скобки любой глубины', () => {
    for (const css of ['body{background:url(http://evil.example/b.png', 'a{background:url(http://evil.example/((1)))}']) {
      const out = cleanCss(css);
      expect(out, css).not.toMatch(/url|evil\.example/);
    }
    expect(cleanCss('a{background:url(x) no-repeat;color:red}')).toBe('a{background:none no-repeat;color:red}');
  });

  it('текст, нарисованный стилем, убран; align-content остаётся', () => {
    const out = cleanCss('p::before{content:"9860" "3100" "0000" "1027";color:red} div{align-content:center;justify-content:end}');
    expect(out).not.toContain('9860');
    expect(out).toContain('color:red');
    expect(out).toContain('align-content:center');
    expect(out).toContain('justify-content:end');
  });

  it('@font-face без конца не растит время квадратично', () => {
    const t = performance.now();
    cleanCss('@font-face{'.repeat(25_000));
    expect(performance.now() - t).toBeLessThan(200);
  });
});

describe('число тегов', () => {
  it('считаются только теги, предел включён', () => {
    expect(tooManyTags('<b>'.repeat(PAGE_TAG_LIMIT))).toBe(false);
    expect(tooManyTags('<b>'.repeat(PAGE_TAG_LIMIT + 1))).toBe(true);
    expect(tooManyTags('a < b '.repeat(PAGE_TAG_LIMIT * 2))).toBe(false);
    expect(tooManyTags('</a><!x><?y'.repeat(PAGE_TAG_LIMIT))).toBe(true);
  });
});

describe('документ страницы', () => {
  it('своя политика стоит первой, до стилей страницы, белый лист', () => {
    const doc = pageShell('<style>h1{}</style>', '<h1>x</h1>');
    expect(doc.startsWith('<!doctype html><html><head><meta http-equiv="Content-Security-Policy"')).toBe(true);
    expect(PAGE_CSP).toBe("default-src 'none'; style-src 'unsafe-inline'");
    expect(doc).toContain(`content="${PAGE_CSP}"`);
    expect(doc.indexOf('background:#fff')).toBeLessThan(doc.indexOf('h1{}'));
    expect(doc).toContain('<body><h1>x</h1></body>');
  });
});
