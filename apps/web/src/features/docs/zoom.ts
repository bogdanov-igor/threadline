// Масштаб картинки в окне документации: чистые расчёты без DOM. Масштаб 1 это картинка в своём размере, 100% на кнопках.

export interface Size {
  width: number;
  height: number;
}
/** x и y: левый верхний угол картинки в окне. */
export interface View {
  scale: number;
  x: number;
  y: number;
}
export interface Limits {
  min: number;
  max: number;
}
/** Снимок снят в масштабе 2, широкий уменьшен до 1600 по ширине: маленький резок до 200%. Схема векторная. */
export type PictureKind = 'raster' | 'vector';

// Поля вокруг вписанной картинки: сверху крестик, снизу кнопки масштаба, на картинку они не ложатся.
const PAD_X = 16;
const PAD_Y = 52;
const OPEN_MAX: Readonly<Record<PictureKind, number>> = { raster: 2, vector: 3 };
const ZOOM_MAX: Readonly<Record<PictureKind, number>> = { raster: 4, vector: 8 };
/** Шаг колеса: та же чувствительность, что у графа. Щипок на тачпаде приходит колесом с ctrlKey и мелкими шагами. */
const WHEEL_RATE = 0.002;
const PINCH_BOOST = 10;

/** Масштаб «Вписать»: вся картинка в окне с полями. Маленькую картинку увеличивает, но не больше, чем она останется резкой. */
export function fitScale(size: Size, box: Size, kind: PictureKind): number {
  const fit = Math.min((box.width - 2 * PAD_X) / size.width, (box.height - 2 * PAD_Y) / size.height);
  return Math.max(0.02, Math.min(OPEN_MAX[kind], fit));
}

/** От «Вписать» вниз не дальше своего размера, вверх всегда есть куда увеличить. */
export function limitsOf(fit: number, kind: PictureKind): Limits {
  return { min: Math.min(1, fit), max: Math.max(ZOOM_MAX[kind], fit * 2) };
}

const clampAxis = (at: number, length: number, room: number) => (length <= room ? (room - length) / 2 : Math.min(0, Math.max(room - length, at)));

/** Картинка меньше окна стоит по центру, больше окна не уходит краем внутрь окна. */
export function clampView(v: View, size: Size, box: Size): View {
  return { scale: v.scale, x: clampAxis(v.x, size.width * v.scale, box.width), y: clampAxis(v.y, size.height * v.scale, box.height) };
}

export function fitView(size: Size, box: Size, kind: PictureKind): View {
  return clampView({ scale: fitScale(size, box, kind), x: 0, y: 0 }, size, box);
}

/** Новый масштаб: точка окна остаётся над той же точкой картинки. */
export function zoomAt(v: View, scale: number, point: { x: number; y: number }, size: Size, box: Size, limits: Limits): View {
  const next = Math.min(limits.max, Math.max(limits.min, scale));
  const k = next / v.scale;
  return clampView({ scale: next, x: point.x - (point.x - v.x) * k, y: point.y - (point.y - v.y) * k }, size, box);
}

/** Кнопки: следующая четверть, поэтому с любого масштаба приходим к ровным 75%, 100%, 125%. */
export function stepScale(scale: number, direction: 1 | -1): number {
  const quarters = scale * 4;
  return (direction > 0 ? Math.floor(quarters + 1e-6) + 1 : Math.ceil(quarters - 1e-6) - 1) / 4;
}

/** Строк и страниц колесо может считать вместо пикселей: Firefox. */
export function wheelScale(scale: number, e: Pick<WheelEvent, 'deltaY' | 'deltaMode' | 'ctrlKey'>): number {
  const pixels = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1);
  return scale * Math.pow(2, -pixels * WHEEL_RATE * (e.ctrlKey ? PINCH_BOOST : 1));
}

/** Двойное нажатие: из «Вписать» крупнее, из любого другого масштаба обратно. */
export function toggleScale(scale: number, fit: number, limits: Limits): number {
  return Math.abs(scale - fit) < 0.01 ? Math.min(limits.max, Math.max(1, fit * 2)) : fit;
}

/** Картинка больше окна хотя бы по одной стороне: есть что двигать. */
export const canPan = (v: View, size: Size, box: Size) => size.width * v.scale > box.width + 0.5 || size.height * v.scale > box.height + 0.5;
