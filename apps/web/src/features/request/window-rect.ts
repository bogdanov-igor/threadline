// Положение и размер большого окна кода. Вправо и вверх окно за область просмотра не выходит, влево и вниз может уйти частично: шапка остаётся под рукой.
import { PANEL_DEFAULT } from './step-panel.ts';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export const MIN_WINDOW = { width: 480, height: 320 };
const WIDTH_SHARE = 0.6;
const HEIGHT_SHARE = 0.7;
const EDGE = 16;
/** С этой ширины панель шага стоит справа от схемы. */
const PANEL_BESIDE = 1280;
/** Столько ширины окна всегда остаётся на экране у левого края. */
const MIN_ON_SCREEN = 240;
/** Столько высоты остаётся на экране у нижнего края: шапка. */
const TITLE_BAR = 48;
/** Шапка приложения и строка действий запроса: «Показать скрытое» остаётся под рукой, пока окно открыто. */
const TOP_ROOM = 104;

const minWidth = (v: Viewport) => Math.min(MIN_WINDOW.width, v.width);
const minHeight = (v: Viewport) => Math.min(MIN_WINDOW.height, v.height);
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(min, max), Math.max(min, value));

/** Около 60 % ширины и 70 % высоты, слева над схемой: панель шага справа свободна. Не меньше наименьшего размера; строка действий запроса над окном. */
export function defaultRect(v: Viewport): Rect {
  const beside = v.width >= PANEL_BESIDE ? v.width - PANEL_DEFAULT - 2 * EDGE : Infinity;
  const width = Math.max(minWidth(v), Math.min(Math.round(v.width * WIDTH_SHARE), beside));
  const height = Math.max(minHeight(v), Math.round(v.height * HEIGHT_SHARE));
  return { x: Math.min(EDGE, v.width - width), y: Math.min(TOP_ROOM, v.height - height), width, height };
}

export function fits(r: Rect, v: Viewport): boolean {
  return r.width >= minWidth(v) && r.height >= minHeight(v) && r.y >= 0 && r.y + TITLE_BAR <= v.height && r.x + r.width <= v.width && r.x + r.width >= Math.min(MIN_ON_SCREEN, r.width);
}

/** Сохранённое значение, только если оно целое и окно можно достать; иначе null. */
export function parseRect(raw: string | null, v: Viewport): Rect | null {
  try {
    const p = JSON.parse(raw ?? 'null') as Partial<Rect> | null;
    if (!p) return null;
    const { x, y, width, height } = p;
    if (![x, y, width, height].every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
    const rect = { x: x!, y: y!, width: width!, height: height! };
    return fits(rect, v) ? rect : null;
  } catch {
    return null;
  }
}

/** keep — сколько ширины остаётся на экране у левого края: в шапке окно тянут не за кнопки. */
export function moveRect(start: Rect, dx: number, dy: number, v: Viewport, keep = MIN_ON_SCREEN): Rect {
  return { ...start, x: clamp(start.x + dx, Math.min(0, Math.max(keep, MIN_ON_SCREEN) - start.width), v.width - start.width), y: clamp(start.y + dy, 0, v.height - TITLE_BAR) };
}

/** edge — стороны из букв n, s, e, w. Противоположный край стоит на месте. */
export function resizeRect(start: Rect, edge: string, dx: number, dy: number, v: Viewport): Rect {
  const right = start.x + start.width;
  const bottom = start.y + start.height;
  const r = { ...start };
  if (edge.includes('e')) r.width = clamp(start.width + dx, Math.max(minWidth(v), MIN_ON_SCREEN - start.x), v.width - start.x);
  if (edge.includes('s')) r.height = clamp(start.height + dy, minHeight(v), v.height - start.y);
  if (edge.includes('w')) {
    r.x = clamp(start.x + dx, 0, right - minWidth(v));
    r.width = right - r.x;
  }
  if (edge.includes('n')) {
    r.y = clamp(start.y + dy, 0, bottom - minHeight(v));
    r.height = bottom - r.y;
  }
  return r;
}
