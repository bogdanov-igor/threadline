import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Контраст рёбер графа с фоном карточки: значимая графика, не меньше 3:1 в обеих темах (WCAG 1.4.11).
// axe обводку SVG не проверяет, поэтому смесь считается здесь по токенам из CSS.
// Пары текста и фона токенов дизайна: не меньше 4,5:1 в обеих темах.

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const theme = read('../../styles/index.css');
const flow = read('./canvas/flow.css');

function block(css: string, selector: string): string {
  const i = css.search(new RegExp(`(^|\\n)${selector.replace('.', '\\.')}\\s*\\{`));
  if (i < 0) throw new Error(`нет блока ${selector}`);
  const start = css.indexOf('{', i);
  return css.slice(start + 1, css.indexOf('}', start));
}

function token(css: string, selector: string, name: string): [number, number, number] {
  const m = new RegExp(`--${name}:\\s*#([0-9a-fA-F]{6})\\s*;`).exec(block(css, selector));
  if (!m) throw new Error(`нет токена --${name} в ${selector}`);
  const hex = m[1]!;
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

const lin = (c: number) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]: [number, number, number]) =>
  0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const contrast = (a: [number, number, number], b: [number, number, number]) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};
/** color-mix(in srgb, color p%, transparent) поверх фона. */
const over = (c: [number, number, number], p: number, bg: [number, number, number]) =>
  c.map((v, i) => v * p + bg[i]! * (1 - p)) as [number, number, number];

const share =
  Number(
    /--xy-edge-stroke:\s*color-mix\(in srgb, var\(--color-muted-foreground\) (\d+)%, transparent\)/.exec(
      flow,
    )?.[1],
  ) / 100;

describe('контраст рёбер графа', () => {
  it('ребро берёт muted-foreground с долей из flow.css', () => {
    expect(share).toBeGreaterThan(0);
    expect(share).toBeLessThanOrEqual(1);
  });

  for (const [name, selector] of [
    ['светлая', ':root'],
    ['тёмная', '.dark'],
  ] as const) {
    it(`${name} тема: обычное ребро и связь потоков не меньше 3:1 с --card`, () => {
      const card = token(theme, selector, 'card');
      const stroke = over(token(theme, selector, 'muted-foreground'), share, card);
      expect(contrast(stroke, card)).toBeGreaterThanOrEqual(3);
      expect(contrast(token(theme, selector, 'primary'), card)).toBeGreaterThanOrEqual(3);
    });
  }

  it('при прежних 55 % светлая тема не проходила: тест ловит слабую смесь', () => {
    const card = token(theme, ':root', 'card');
    expect(contrast(over(token(theme, ':root', 'muted-foreground'), 0.55, card), card)).toBeLessThan(3);
  });
});

describe('контраст пар токенов', () => {
  const PAIRS: readonly [string, string][] = [
    ['foreground', 'background'],
    ['foreground', 'bg-sub'],
    ['foreground-2', 'background'],
    ['heading', 'background'],
    ['muted-foreground', 'background'],
    ['muted-foreground', 'bg-sub'],
    ['muted-foreground', 'accent'],
    ['muted-foreground', 'muted'],
    ['primary', 'background'],
    ['primary-foreground', 'primary'],
    ['btn-foreground', 'btn'],
    ['btn-foreground', 'btn-hover'],
    ['accent-foreground', 'accent'],
    ['success', 'success-bg'],
    ['danger', 'danger-bg'],
    ['warning', 'warning-bg'],
    ['hit-fg', 'hit-bg'],
    ['sx-tag', 'code'],
    ['sx-attr', 'code'],
    ['sx-str', 'code'],
    ['sx-num', 'code'],
    ['sx-key', 'code'],
    ['sx-p', 'code'],
  ];

  for (const [name, selector] of [
    ['светлая', ':root'],
    ['тёмная', '.dark'],
  ] as const) {
    it.each(PAIRS)(`${name} тема: %s на %s не меньше 4,5:1`, (fg, bg) => {
      expect(contrast(token(theme, selector, fg), token(theme, selector, bg))).toBeGreaterThanOrEqual(4.5);
    });

    it(`${name} тема: граница полей и кольцо фокуса не меньше 3:1 на фоне`, () => {
      const bg = token(theme, selector, 'background');
      expect(contrast(token(theme, selector, 'input'), bg)).toBeGreaterThanOrEqual(3);
      expect(contrast(token(theme, selector, 'ring'), bg)).toBeGreaterThanOrEqual(3);
    });
  }

  it('тёмная тема нейтральная серая: фон не синий', () => {
    const [r, g, b] = token(theme, '.dark', 'background');
    expect(b - r).toBeLessThanOrEqual(6);
    expect(Math.abs(b - g)).toBeLessThanOrEqual(6);
  });
});
