// Цвета кода из дизайна. Зелёный, красный и оранжевый заняты статусами: среди обычных токенов их нет.
export type CodeToken = 'xk' | 'string' | 'number' | 'tag' | 'secondary';
export type CodePalette = Record<CodeToken | 'background', string>;

export const CODE_COLORS: { light: CodePalette; dark: CodePalette } = {
  light: { background: '#F8FAFC', xk: '#1D3E6E', string: '#0B6680', number: '#8A4B14', tag: '#0044AD', secondary: '#5A6C85' },
  dark: { background: '#0D0F12', xk: '#C7D2E0', string: '#96D0E0', number: '#E0B98F', tag: '#6CB6FF', secondary: '#8A939F' },
};

export const CODE_TOKENS: readonly CodeToken[] = ['xk', 'string', 'number', 'tag', 'secondary'];

const channel = (v: number) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const rgb = (hex: string) => [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)].map((x) => parseInt(x, 16)) as [number, number, number];
const luminance = (hex: string) => {
  const [r, g, b] = rgb(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};

/** Контраст двух цветов по WCAG. */
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

/** Оттенок цвета в градусах и насыщенность: тест проверяет, что цвет не из статусных. */
export function hueOf(hex: string): { hue: number; saturation: number } {
  const [r, g, b] = rgb(hex).map((v) => v / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return { hue: 0, saturation: 0 };
  const hue = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { hue: hue * 60, saturation: d / (1 - Math.abs(max + min - 1)) };
}
