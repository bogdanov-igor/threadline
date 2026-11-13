// Части схем: прямоугольник, стрелка, рамка. Цвета только из переменных темы: схема работает и в светлой, и в тёмной теме.
import { useId, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import en from './strings/en.json';
import ru from './strings/ru.json';

type Strings = typeof ru;

const STRINGS: Readonly<Record<string, Strings>> = { ru, en };

/** Подписи схемы на языке интерфейса. Новый язык: файл strings/<язык>.json рядом, того же вида, и строка в STRINGS. */
export function useDiagramText<K extends keyof Strings>(name: K): Strings[K] {
  // Подписка на язык: схема сменится вместе с интерфейсом.
  const { i18n } = useTranslation();
  return (STRINGS[i18n.language.split('-')[0]!] ?? ru)[name];
}

const TITLE = 14;
const SUB = 12;
const LINE = 16;

export type BoxTone = 'plain' | 'main' | 'later';

const TONES: Record<BoxTone, { fill: string; stroke: string; title: string; dash?: string }> = {
  plain: { fill: 'var(--card)', stroke: 'var(--input)', title: 'var(--heading)' },
  main: { fill: 'var(--accent)', stroke: 'var(--primary)', title: 'var(--accent-foreground)' },
  later: { fill: 'var(--card)', stroke: 'var(--input)', title: 'var(--muted-foreground)', dash: '5 4' },
};

/** Прямоугольник с названием и строками пояснения. Текст по центру, ширину и высоту задаёт схема. */
export function Box({ x, y, w, h, title, sub, tone = 'plain' }: { x: number; y: number; w: number; h: number; title: string; sub?: string | readonly string[]; tone?: BoxTone }) {
  const t = TONES[tone];
  const lines = sub === undefined ? [] : typeof sub === 'string' ? [sub] : sub;
  const cx = x + w / 2;
  const block = TITLE + 4 + lines.length * LINE;
  const top = y + (h - block) / 2 + TITLE - 2;
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={8} fill={t.fill} stroke={t.stroke} strokeWidth={1.25} strokeDasharray={t.dash} />
      <text x={cx} y={top} textAnchor="middle" fontSize={TITLE} fontWeight={600} fill={t.title}>
        {title}
      </text>
      {lines.map((line, i) => (
        <text key={line} x={cx} y={top + 4 + LINE * (i + 1)} textAnchor="middle" fontSize={SUB} fill="var(--muted-foreground)">
          {line}
        </text>
      ))}
    </g>
  );
}

/** Прямая стрелка. Подпись стоит посередине, на фоне страницы: линия её не перечёркивает. both: стрелки на обоих концах. */
export function Arrow({ from, to, label, labelAt = 0.5, labelDy = 0, both = false, dashed = false, marker }: { from: readonly [number, number]; to: readonly [number, number]; label?: string; labelAt?: number; labelDy?: number; both?: boolean; dashed?: boolean; marker: string }) {
  const lx = from[0] + (to[0] - from[0]) * labelAt;
  const ly = from[1] + (to[1] - from[1]) * labelAt + labelDy;
  return (
    <g>
      <line x1={from[0]} y1={from[1]} x2={to[0]} y2={to[1]} stroke="var(--muted-foreground)" strokeWidth={1.25} strokeDasharray={dashed ? '5 4' : undefined} markerEnd={`url(#${marker})`} markerStart={both ? `url(#${marker})` : undefined} />
      {label && (
        <text x={lx} y={ly + 4} textAnchor="middle" fontSize={SUB} fill="var(--foreground-2)" stroke="var(--background)" strokeWidth={4} paintOrder="stroke">
          {label}
        </text>
      )}
    </g>
  );
}

/** Рамка схемы: масштаб по ширине колонки, описание для диктора из подписи в тексте. children получает имя наконечника стрелки. */
export function Diagram({ width, height, label, children }: { width: number; height: number; label: string; children: (marker: string) => ReactNode }) {
  const marker = `arrow-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label} className="block h-auto w-full font-sans" data-testid="docs-diagram">
      <defs>
        <marker id={marker} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--muted-foreground)" />
        </marker>
      </defs>
      {children(marker)}
    </svg>
  );
}
