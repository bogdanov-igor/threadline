// Знак Threadline «Маршрут» одним описанием: по нему рисуются знак в шапке, значок вкладки и значки приложения (scripts/icons.ts).
// Нить через три узла на разной высоте, последний узел закрашен основным цветом темы: это причина.

/** Сторона квадрата, в котором нарисован знак. */
export const MARK_VIEWBOX = 32;

/** Нить: кривая через три узла. */
export const MARK_THREAD = { d: 'M5 25 C 9 25, 10 9, 16 9 S 21 23, 26.5 23', strokeWidth: 2.6 } as const;

/** Узлы на пути: обводка без заливки. */
export const MARK_NODES = [
  { cx: 5, cy: 25, r: 3 },
  { cx: 16, cy: 9, r: 3 },
] as const;
export const MARK_NODE_STROKE = 2.4;
/** Пустая середина узлов: нить в ней не видна, узел читается кольцом и на крупном значке. */
export const MARK_HOLES = MARK_NODES.map((n) => ({ cx: n.cx, cy: n.cy, r: n.r - MARK_NODE_STROKE / 2 }));

/** Последний узел, причина: залит основным цветом. */
export const MARK_CAUSE = { cx: 26.5, cy: 23, r: 3.4 } as const;

/** Круги с внешним краем: узлы с половиной обводки и причина. Нить лежит внутри них по высоте и между ними по ширине. */
export const MARK_DISCS = [...MARK_NODES.map((n) => ({ cx: n.cx, cy: n.cy, r: n.r + MARK_NODE_STROKE / 2 })), { ...MARK_CAUSE }];

/** Видимые границы знака: по ним знак ставится в середину значка. */
export const MARK_BOUNDS = (() => {
  const x = Math.min(...MARK_DISCS.map((d) => d.cx - d.r));
  const y = Math.min(...MARK_DISCS.map((d) => d.cy - d.r));
  const right = Math.max(...MARK_DISCS.map((d) => d.cx + d.r));
  const bottom = Math.max(...MARK_DISCS.map((d) => d.cy + d.r));
  return { x, y, width: right - x, height: bottom - y };
})();
