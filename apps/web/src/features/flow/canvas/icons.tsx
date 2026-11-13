// Значки lucide (lucide-react 1.66.0, лицензия ISC), которые нужны только графу. Данные SVG лежат здесь, чтобы
// значки шли в чанк flow, а не в общий ui: общий модуль lucide стоит импортёром у каждого своего значка.
// Значки, общие с остальным интерфейсом, граф берёт из lucide-react.
import { createElement, type ComponentType, type SVGProps } from 'react';
import { cn } from '@/lib/utils.ts';

export type Glyph = ComponentType<Pick<SVGProps<SVGSVGElement>, 'className' | 'aria-hidden'>>;

type Shape = readonly (readonly [string, Readonly<Record<string, string>>])[];

const SHAPES = {
  ArrowUpRight: [
    ['path', { d: 'M7 7h10v10' }],
    ['path', { d: 'M7 17 17 7' }],
  ],
  CircleDot: [
    ['circle', { cx: '12', cy: '12', r: '9' }],
    ['circle', { cx: '12', cy: '12', r: '3' }],
  ],
  Clock: [
    ['circle', { cx: '12', cy: '12', r: '9' }],
    ['path', { d: 'M12 7v5l3.5 2' }],
  ],
  Fit: [['path', { d: 'M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3' }]],
  LogLines: [
    ['path', { d: 'M4 6h16' }],
    ['path', { d: 'M4 12h16' }],
    ['path', { d: 'M4 18h16' }],
  ],
  Minus: [['path', { d: 'M5 12h14' }]],
  Package: [
    ['path', { d: 'M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z' }],
    ['path', { d: 'm3.3 7 8.7 5 8.7-5' }],
    ['path', { d: 'M12 22V12' }],
  ],
  ParallelBars: [
    ['path', { d: 'M9 5v14' }],
    ['path', { d: 'M15 5v14' }],
  ],
  Plus: [
    ['path', { d: 'M5 12h14' }],
    ['path', { d: 'M12 5v14' }],
  ],
  Server: [
    ['rect', { x: '3', y: '3', width: '18', height: '7', rx: '2' }],
    ['rect', { x: '3', y: '14', width: '18', height: '7', rx: '2' }],
    ['path', { d: 'M7 6.5h.01M7 17.5h.01' }],
  ],
  Undo2: [
    ['path', { d: 'M9 14 4 9l5-5' }],
    ['path', { d: 'M4 9h10.5a5.5 5.5 0 0 1 0 11H11' }],
  ],
  ChartGantt: [
    ['path', { d: 'M10 6h8' }],
    ['path', { d: 'M12 16h6' }],
    ['path', { d: 'M3 3v16a2 2 0 0 0 2 2h16' }],
    ['path', { d: 'M8 11h7' }],
  ],
  ChevronUp: [['path', { d: 'm18 15-6-6-6 6' }]],
  Cog: [
    ['path', { d: 'M11 10.27 7 3.34' }],
    ['path', { d: 'm11 13.73-4 6.93' }],
    ['path', { d: 'M12 22v-2' }],
    ['path', { d: 'M12 2v2' }],
    ['path', { d: 'M14 12h8' }],
    ['path', { d: 'm17 20.66-1-1.73' }],
    ['path', { d: 'm17 3.34-1 1.73' }],
    ['path', { d: 'M2 12h2' }],
    ['path', { d: 'm20.66 17-1.73-1' }],
    ['path', { d: 'm20.66 7-1.73 1' }],
    ['path', { d: 'm3.34 17 1.73-1' }],
    ['path', { d: 'm3.34 7 1.73 1' }],
    ['circle', { cx: '12', cy: '12', r: '2' }],
    ['circle', { cx: '12', cy: '12', r: '8' }],
  ],
  Database: [
    ['ellipse', { cx: '12', cy: '5', rx: '9', ry: '3' }],
    ['path', { d: 'M3 5V19A9 3 0 0 0 21 19V5' }],
    ['path', { d: 'M3 12A9 3 0 0 0 21 12' }],
  ],
  Ellipsis: [
    ['circle', { cx: '12', cy: '12', r: '1' }],
    ['circle', { cx: '19', cy: '12', r: '1' }],
    ['circle', { cx: '5', cy: '12', r: '1' }],
  ],
  Hourglass: [
    ['path', { d: 'M5 22h14' }],
    ['path', { d: 'M5 2h14' }],
    ['path', { d: 'M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22' }],
    ['path', { d: 'M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2' }],
  ],
  Repeat: [
    ['path', { d: 'm17 2 4 4-4 4' }],
    ['path', { d: 'M3 11v-1a4 4 0 0 1 4-4h14' }],
    ['path', { d: 'm7 22-4-4 4-4' }],
    ['path', { d: 'M21 13v1a4 4 0 0 1-4 4H3' }],
  ],
  SendHorizontal: [
    [
      'path',
      {
        d: 'M3.714 3.048a.498.498 0 0 0-.683.627l2.843 7.627a2 2 0 0 1 0 1.396l-2.842 7.627a.498.498 0 0 0 .682.627l18-8.5a.5.5 0 0 0 0-.904z',
      },
    ],
    ['path', { d: 'M6 12h16' }],
  ],
  Split: [
    ['path', { d: 'M16 3h5v5' }],
    ['path', { d: 'M8 3H3v5' }],
    ['path', { d: 'M12 22v-8.3a4 4 0 0 0-1.172-2.872L3 3' }],
    ['path', { d: 'm15 9 6-6' }],
  ],
  Webhook: [
    ['path', { d: 'M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2' }],
    ['path', { d: 'm6 17 3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06' }],
    ['path', { d: 'm12 6 3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8' }],
  ],
} satisfies Record<string, Shape>;

function glyph(name: string, shape: Shape): Glyph {
  function Icon({
    className,
    'aria-hidden': hidden,
  }: Pick<SVGProps<SVGSVGElement>, 'className' | 'aria-hidden'>) {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={cn('lucide', className)}
        aria-hidden={hidden}
      >
        {shape.map(([tag, attrs], i) => createElement(tag, { key: i, ...attrs }))}
      </svg>
    );
  }
  Icon.displayName = name;
  return Icon;
}

export const ArrowUpRight = glyph('ArrowUpRight', SHAPES.ArrowUpRight);
export const ChartGantt = glyph('ChartGantt', SHAPES.ChartGantt);
export const CircleDot = glyph('CircleDot', SHAPES.CircleDot);
export const Clock = glyph('Clock', SHAPES.Clock);
export const Fit = glyph('Fit', SHAPES.Fit);
export const LogLines = glyph('LogLines', SHAPES.LogLines);
export const Minus = glyph('Minus', SHAPES.Minus);
export const Package = glyph('Package', SHAPES.Package);
export const ParallelBars = glyph('ParallelBars', SHAPES.ParallelBars);
export const Plus = glyph('Plus', SHAPES.Plus);
export const Server = glyph('Server', SHAPES.Server);
export const Undo2 = glyph('Undo2', SHAPES.Undo2);
export const ChevronUp = glyph('ChevronUp', SHAPES.ChevronUp);
export const Cog = glyph('Cog', SHAPES.Cog);
export const Database = glyph('Database', SHAPES.Database);
export const Ellipsis = glyph('Ellipsis', SHAPES.Ellipsis);
export const Hourglass = glyph('Hourglass', SHAPES.Hourglass);
export const Repeat = glyph('Repeat', SHAPES.Repeat);
export const SendHorizontal = glyph('SendHorizontal', SHAPES.SendHorizontal);
export const Split = glyph('Split', SHAPES.Split);
export const Webhook = glyph('Webhook', SHAPES.Webhook);
