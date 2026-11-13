import { describe, expect, it } from 'vitest';
import { maskKindsText } from './mask-pass.ts';
import { compileMasking } from './mask-pass.ts';
import { maskDeepOpeningCards, maskText, notingHiddenCards } from './masking.ts';
import { withoutHtml } from './html-text.ts';
import { plainDigits } from './mask-markup.ts';

// Номера выдуманные, проходят проверку Луна.
const CARD = '5555550000051021';
const NO_KEEP = new Set<string>();
const entities = (s: string) => [...s].map((c) => `&#${c.charCodeAt(0)};`).join('');
const hex = (s: string) => [...s].map((c) => `&#x${c.charCodeAt(0).toString(16)};`).join('');
const groups = (s: string, sep: string) => s.match(/.{1,4}/g)!.join(sep);
const page = (inner: string) => `<html><body><p>Card ${inner}</p></body></html>`;
/** То, что браузер покажет: разметка и записи символов убраны. */
const shown = (s: string) =>
  s
    .replace(/<!--[\s\S]*?-->|<[^<>]*>/g, '')
    .replace(/&#x([0-9a-f]+);?/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&(nbsp|shy|thinsp|zwj);/g, ' ')
    .replace(/\\u([0-9a-f]{4})/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/[^\d*]/g, '');

describe('номер, который соберёт браузер', () => {
  it.each([
    ['цифры сущностями', entities(CARD)],
    ['цифры сущностями в шестнадцатеричной записи', hex(CARD)],
    ['цифры сущностями без точки с запятой', [...CARD].map((c) => `&#${c.charCodeAt(0)}`).join(' ')],
    ['цифры в шестнадцатеричной записи без точки с запятой', [...CARD].map((c) => `&#X${c.charCodeAt(0).toString(16)}`).join(' ')],
    ['&nbsp;', groups(CARD, '&nbsp;')],
    ['&nbsp без точки с запятой', groups(CARD, '&nbsp')],
    ['пробел сущностью', groups(CARD, '&#32;')],
    ['&#160;', groups(CARD, '&#160;')],
    ['мягкий перенос', groups(CARD, '&shy;')],
    ['нулевой пробел символом', groups(CARD, '​')],
    ['узкий пробел символом', groups(CARD, ' ')],
  ])('%s', (_name, inner) => {
    const out = maskText(page(inner), NO_KEEP);
    expect(shown(out)).toContain('555555******1021');
    expect(shown(out)).not.toContain(CARD);
  });

  it('теги и комментарии между цифрами не считаются: такую страницу не показывает браузер', () => {
    for (const s of [page(groups(CARD, '</b><b>')), page(groups(CARD, '<!-- x -->')), page([...CARD].map((c) => `<i>${c}</i>`).join(''))]) expect(maskText(s, NO_KEEP)).toBe(s);
  });

  it('вне страницы: невидимые символы и сущности, теги не считаются', () => {
    expect(shown(maskText(`card ${groups(CARD, '​')}`, NO_KEEP))).toBe('555555******1021');
    expect(shown(maskText(`card ${entities(CARD)}`, NO_KEEP))).toBe('555555******1021');
    const xml = `<a>${CARD.slice(0, 4)}</a><b>${CARD.slice(4, 8)}</b><c>${CARD.slice(8, 12)}</c><d>${CARD.slice(12)}</d>`;
    expect(maskText(xml, NO_KEEP)).toBe(xml);
  });

  it('\\uXXXX в строке JSON и JSON в строке', () => {
    const esc = [...CARD].map((c) => `\\u00${c.charCodeAt(0).toString(16)}`).join('');
    expect(shown(maskText(`{"message":"esc ${esc}"}`, NO_KEEP))).toBe('555555******1021');
    const nested = [...CARD].map((c) => `\\\\u00${c.charCodeAt(0).toString(16)}`).join('');
    expect(maskText(`{"m":"{\\"e\\":\\"${nested}\\"}"}`, NO_KEEP)).not.toContain(nested);
  });

  it('другие цифры перед номером его не прячут', () => {
    expect(shown(maskText(page(`1 ${groups(CARD, '&nbsp;')}`), NO_KEEP))).toContain('555555******1021');
    expect(shown(maskText(`1&nbsp;${entities(CARD)}`, NO_KEEP))).toContain('555555******1021');
  });

  it('пробелов между цифрами больше предела: серия кончилась', () => {
    const [head, tail] = [CARD.slice(0, 8), CARD.slice(8)];
    expect(maskText(`${head}${'&nbsp;'.repeat(64)}${tail}`, NO_KEEP)).not.toContain(tail);
    const far = `${head}${'&nbsp;'.repeat(65)}${tail}`;
    expect(maskText(far, NO_KEEP)).toBe(far);
  });

  it('сущность другого символа разрывает серию, её цифры не считаются', () => {
    const s = groups(CARD, '&#65;');
    expect(maskText(s, NO_KEEP)).toBe(s);
    expect(plainDigits('&#65; &#571 &#x39a &#xg')).toBe('&#65; &#571 &#x39a &#xg');
  });

  it('plainDigits читает цифры записи и не трогает остальное', () => {
    expect(plainDigits('&#57;&#x39;&#57&#X39 \\u0039 \\\\\\u0039 &#00000057;')).toBe('9999 9 9 9');
    for (const s of ['a=1&b=2', 'C:\\Users', '\\n\\t', '&amp;', '&#', '&#;', '\\u00', '\\u003']) expect(plainDigits(s)).toBe(s);
  });

  it('плоский текст и номер без проверки Луна не меняются; значение поиска остаётся', () => {
    for (const s of ['a 1234 5678 9012 3456 b', 'id 1234567890123456', page(groups('5555550000001022', '</b><b>'))]) expect(maskText(s, NO_KEEP)).toBe(s);
    const hit = page(groups(CARD, '</b><b>'));
    expect(maskText(hit, new Set([CARD]))).toBe(hit);
  });

  it('проход с открытым номером его не трогает, но помечает скрытый номер в обычном', () => {
    const body = page(entities(CARD));
    expect(maskDeepOpeningCards({ body }, NO_KEEP).body).toBe(body);
    expect(notingHiddenCards(() => maskText(body, NO_KEEP)).cardHidden).toBe(true);
  });

  it('заголовок страницы в причине на сервере: маска после снятия тегов, края номера на месте', () => {
    const text = maskText(withoutHtml(`<title>Card <b>5555</b><b>5500</b><b>0005</b><b>1021</b> declined</title>`), NO_KEEP);
    expect(text).toBe('Card 5555 55** **** 1021 declined');
  });

  it('телефон сущностями находит образец второго прохода', () => {
    const { strict } = compileMasking([]);
    expect(maskKindsText(`phone +${entities('447700900710')}`, strict, NO_KEEP)).not.toMatch(/447700900710|&#/);
  });

  it('цифра и 40 неразрывных пробелов не держат сервер: было экспоненциально', () => {
    const t = performance.now();
    expect(maskText(`1${'\u00a0'.repeat(40)}x`, NO_KEEP)).toBe(`1${'\u00a0'.repeat(40)}x`);
    expect(performance.now() - t).toBeLessThan(100);
  });

  it('линейное время на 3 МБ', () => {
    const cases = [
      `<p>${'<b>1</b>'.repeat(375_000)}</p>`,
      `<p>${'12345678901234x'.repeat(200_000)}</p>`,
      `<p>${`1<!--${'a'.repeat(200)}-->`.repeat(14_000)}</p>`,
      `${'\\'.repeat(3_000_000)}&#57;`,
      `&#57;${' '.repeat(3_000_000)}`,
      `&#57;${'1 '.repeat(1_500_000)}`,
      `<p>${'1<x '.repeat(750_000)}</p>`,
      `1${'&'.repeat(3_000_000)}`,
    ];
    for (const s of cases) {
      const t = performance.now();
      maskText(s, NO_KEEP);
      expect(performance.now() - t, s.slice(0, 30)).toBeLessThan(5000);
    }
  });
});
