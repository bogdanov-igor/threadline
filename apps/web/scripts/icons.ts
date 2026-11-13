// Значки из знака «Маршрут»: значок вкладки SVG и PNG, значок для iOS и значки устанавливаемого приложения.
// Рисунок берётся из src/components/shell/mark.ts, цвета — из токенов тем в src/styles/index.css. Готовые файлы лежат в public/ и хранятся в git.
// Запуск после смены знака или цветов: pnpm --filter @threadline/web icons. Внешних сервисов нет, PNG рисует sharp.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MARK_BOUNDS, MARK_CAUSE, MARK_HOLES, MARK_NODE_STROKE, MARK_NODES, MARK_THREAD, MARK_VIEWBOX } from '../src/components/shell/mark.ts';

const WEB = fileURLToPath(new URL('..', import.meta.url));
export const PUBLIC_DIR = join(WEB, 'public');
export const TOKENS_CSS = join(WEB, 'src/styles/index.css');

export interface ThemeColors {
  background: string;
  heading: string;
  primary: string;
}

/** Цвета светлой (:root) и тёмной (.dark) темы из файла стилей. */
export function themeTokens(css: string): { light: ThemeColors; dark: ThemeColors } {
  const block = (selector: string) => {
    const start = css.search(new RegExp(`^${selector.replace('.', '\\.')} \\{$`, 'm'));
    if (start < 0) throw new Error(`нет блока ${selector} в стилях`);
    const body = css.slice(start, css.indexOf('}', start));
    const token = (name: string) => {
      const m = new RegExp(`--${name}:\\s*(#[0-9a-f]{6});`, 'i').exec(body);
      if (!m) throw new Error(`нет цвета --${name} в блоке ${selector}`);
      return m[1]!.toLowerCase();
    };
    return { background: token('background'), heading: token('heading'), primary: token('primary') };
  };
  return { light: block(':root'), dark: block('.dark') };
}

const num = (n: number) => String(Math.round(n * 1000) / 1000);

/** Фигуры знака: нить и узлы с классом t, причина с классом c, либо с цветами прямо в атрибутах. */
function shapes(colors: { thread: string; cause: string } | null): string {
  const thread = colors ? ` stroke="${colors.thread}"` : ' class="t"';
  const cause = colors ? ` fill="${colors.cause}"` : ' class="c"';
  // Маска убирает нить из пустой середины узлов, как у знака в шапке.
  const holes = MARK_HOLES.map((h) => `<circle cx="${h.cx}" cy="${h.cy}" r="${h.r}" fill="#000"/>`).join('');
  return [
    `<mask id="h" maskUnits="userSpaceOnUse" x="0" y="0" width="${MARK_VIEWBOX}" height="${MARK_VIEWBOX}"><rect width="${MARK_VIEWBOX}" height="${MARK_VIEWBOX}" fill="#fff"/>${holes}</mask>`,
    `<path${thread} d="${MARK_THREAD.d}" fill="none" stroke-width="${MARK_THREAD.strokeWidth}" stroke-linecap="round" mask="url(#h)"/>`,
    ...MARK_NODES.map((n) => `<circle${thread} cx="${n.cx}" cy="${n.cy}" r="${n.r}" fill="none" stroke-width="${MARK_NODE_STROKE}"/>`),
    `<circle${cause} cx="${MARK_CAUSE.cx}" cy="${MARK_CAUSE.cy}" r="${MARK_CAUSE.r}"/>`,
  ].join('');
}

/**
 * Значок вкладки: знак на тёмной подложке, как значок приложения. Без подложки тёмный знак терялся на тёмной вкладке
 * браузера: тема вкладки не всегда совпадает с темой системы, по которой SVG выбирает цвета.
 */
export function faviconSvg(t: { light: ThemeColors; dark: ThemeColors }): string {
  return `${tileSvg(FAVICON, t.dark)}\n`;
}

export interface IconSpec {
  /** Путь от public/. */
  file: string;
  size: number;
  /** Скругление подложки, доля стороны; 0 — квадрат до края. */
  radius: number;
  /** Сколько стороны занимает знак по большей из своих сторон. */
  scale: number;
  /** Значок под маску ОС: знак внутри безопасного круга диаметром 80% стороны. */
  maskable?: boolean;
}

/**
 * Растровые значки на тёмной подложке: видны и на светлом, и на тёмном фоне. Значок вкладки PNG для браузеров без SVG-значка,
 * apple-touch-icon квадратный (iOS скругляет сам), значки приложения со скруглением и отдельный под маску.
 */
/** Значок вкладки: SVG и PNG одного вида. */
const FAVICON: IconSpec = { file: 'favicon-32.png', size: 32, radius: 7 / 32, scale: 0.78 };

export const ICONS: readonly IconSpec[] = [
  FAVICON,
  { file: 'apple-touch-icon.png', size: 180, radius: 0, scale: 0.64 },
  { file: 'icons/icon-192.png', size: 192, radius: 0.22, scale: 0.68 },
  { file: 'icons/icon-512.png', size: 512, radius: 0.22, scale: 0.68 },
  { file: 'icons/icon-maskable-512.png', size: 512, radius: 0, scale: 0.56, maskable: true },
];

/** Масштаб и сдвиг знака в значке: видимые границы знака по середине стороны. */
export function placement(spec: IconSpec): { k: number; dx: number; dy: number } {
  const k = (spec.size * spec.scale) / Math.max(MARK_BOUNDS.width, MARK_BOUNDS.height);
  const dx = spec.size / 2 - k * (MARK_BOUNDS.x + MARK_BOUNDS.width / 2);
  const dy = spec.size / 2 - k * (MARK_BOUNDS.y + MARK_BOUNDS.height / 2);
  return { k, dx, dy };
}

/** Значок на подложке тёмной темы: нить цвета заголовка, причина основного цвета. */
export function tileSvg(spec: IconSpec, colors: ThemeColors): string {
  const { size } = spec;
  const { k, dx, dy } = placement(spec);
  const rx = spec.radius > 0 ? ` rx="${num(size * spec.radius)}"` : '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<rect width="${size}" height="${size}"${rx} fill="${colors.background}"/>` +
    `<g transform="translate(${num(dx)} ${num(dy)}) scale(${num(k)})">${shapes({ thread: colors.heading, cause: colors.primary })}</g></svg>`
  );
}

async function main(): Promise<void> {
  const { default: sharp } = await import('sharp');
  const tokens = themeTokens(readFileSync(TOKENS_CSS, 'utf8'));
  writeFileSync(join(PUBLIC_DIR, 'favicon.svg'), faviconSvg(tokens));
  for (const spec of ICONS) {
    const out = join(PUBLIC_DIR, spec.file);
    mkdirSync(dirname(out), { recursive: true });
    await sharp(Buffer.from(tileSvg(spec, tokens.dark))).png({ compressionLevel: 9 }).toFile(out);
    console.log(`${spec.file}: ${spec.size}×${spec.size}`);
  }
  console.log('favicon.svg: знак на тёмной подложке');
}

if (import.meta.main) await main();
