import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { faviconSvg, ICONS, placement, PUBLIC_DIR, themeTokens, TOKENS_CSS } from '../../../scripts/icons.ts';
import { MARK_BOUNDS, MARK_DISCS } from './mark.ts';

// Значки в public/ сделаны scripts/icons.ts из знака и токенов тем. Тест ловит знак или цвета, поменянные без новых значков.

const tokens = themeTokens(readFileSync(TOKENS_CSS, 'utf8'));

/** Ширина и высота PNG из заголовка IHDR. */
function pngSize(file: string): { width: number; height: number } {
  const b = readFileSync(file);
  expect(b.subarray(1, 4).toString('latin1'), `${file}: PNG`).toBe('PNG');
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

describe('знак и значки', () => {
  it('цвета значков — токены тем: нить цвета заголовка, причина основного цвета', () => {
    expect(tokens.light).toEqual({ background: '#ffffff', heading: '#0b1b33', primary: '#0044ad' });
    expect(tokens.dark).toEqual({ background: '#121417', heading: '#e6e8eb', primary: '#4c8dff' });
  });

  it('favicon.svg совпадает с тем, что рисует скрипт: pnpm --filter @threadline/web icons', () => {
    expect(readFileSync(join(PUBLIC_DIR, 'favicon.svg'), 'utf8')).toBe(faviconSvg(tokens));
  });

  it('значок вкладки на тёмной подложке: виден и на светлой, и на тёмной вкладке', () => {
    const svg = faviconSvg(tokens);
    expect(svg).toContain(`fill="${tokens.dark.background}"`);
    expect(svg).toContain(`stroke="${tokens.dark.heading}"`);
    expect(svg).not.toContain('prefers-color-scheme');
  });

  for (const spec of ICONS) {
    it(`${spec.file}: PNG ${spec.size}×${spec.size}`, () => {
      const file = join(PUBLIC_DIR, spec.file);
      expect(existsSync(file), `${spec.file}: запустите pnpm --filter @threadline/web icons`).toBe(true);
      expect(pngSize(file)).toEqual({ width: spec.size, height: spec.size });
    });
  }

  it('значок под маску: весь знак внутри безопасного круга диаметром 80% стороны', () => {
    const maskable = ICONS.filter((s) => s.maskable);
    expect(maskable.map((s) => s.size)).toEqual([512]);
    for (const spec of maskable) {
      const { k, dx, dy } = placement(spec);
      const c = spec.size / 2;
      for (const d of MARK_DISCS) {
        const far = Math.hypot(dx + k * d.cx - c, dy + k * d.cy - c) + k * d.r;
        expect(far).toBeLessThanOrEqual(spec.size * 0.4);
      }
    }
  });

  it('знак по середине значка и с полем со всех сторон', () => {
    for (const spec of ICONS) {
      const { k, dx, dy } = placement(spec);
      const left = dx + k * MARK_BOUNDS.x;
      const top = dy + k * MARK_BOUNDS.y;
      const right = spec.size - (left + k * MARK_BOUNDS.width);
      const bottom = spec.size - (top + k * MARK_BOUNDS.height);
      expect(Math.abs(left - right)).toBeLessThan(1e-6);
      expect(Math.abs(top - bottom)).toBeLessThan(1e-6);
      expect(Math.min(left, top)).toBeGreaterThanOrEqual(spec.size * 0.1);
    }
  });
});
