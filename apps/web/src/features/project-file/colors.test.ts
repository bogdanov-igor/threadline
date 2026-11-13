import { describe, expect, it } from 'vitest';
import { CODE_COLORS, CODE_TOKENS, contrast, hueOf } from './colors.ts';

describe('цвета кода', () => {
  it.each(['light', 'dark'] as const)('%s: каждый токен не ниже 4.5:1 на фоне кода', (theme) => {
    const p = CODE_COLORS[theme];
    for (const k of CODE_TOKENS) expect(contrast(p[k], p.background), k).toBeGreaterThanOrEqual(4.5);
  });

  it.each(['light', 'dark'] as const)('%s: нет зелёного, красного и оранжевого, они заняты статусами', (theme) => {
    const p = CODE_COLORS[theme];
    for (const k of CODE_TOKENS) {
      const { hue, saturation } = hueOf(p[k]);
      // Цвет числа в дизайне коричневый: приглушённый, не статусный. Красный и зелёный исключены по оттенку, оранжевый по яркости.
      expect(hue >= 345 || hue < 12, `${k}: красный`).toBe(false);
      expect(hue >= 80 && hue < 165, `${k}: зелёный`).toBe(false);
      if (hue >= 12 && hue < 45) expect(saturation, `${k}: оранжевый`).toBeLessThan(0.75);
    }
  });
});
