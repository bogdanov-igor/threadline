// Схема «Как читать шаг на схеме запроса»: один шаг и подписи к его частям. Рисунок повторяет шаг с ошибкой, цвета только из темы.
import { Arrow, Box, Diagram, useDiagramText } from './parts.tsx';

const X = 250;
const Y = 112;
const W = 260;
const H = 112;

export function GuideStep({ label }: { label: string }) {
  const s = useDiagramText('guide-step');
  return (
    <Diagram width={760} height={350} label={label}>
      {(marker) => (
        <>
          <rect x={X} y={Y} width={W} height={H} rx={10} fill="var(--card)" stroke="var(--danger)" strokeWidth={2} />
          <text x={X + 14} y={Y + 26} fontSize={12} fontFamily="var(--font-mono, monospace)" fill="var(--muted-foreground)">
            {s.method}
          </text>
          <text x={X + W - 14} y={Y + 26} textAnchor="end" fontSize={13} fontWeight={600} fill="var(--heading)">
            {s.duration}
          </text>
          <text x={X + 14} y={Y + 52} fontSize={14} fontWeight={600} fill="var(--heading)">
            {s.system}
          </text>
          <circle cx={X + 21} cy={Y + 77} r={6} fill="none" stroke="var(--danger)" strokeWidth={1.5} />
          <text x={X + 34} y={Y + 81} fontSize={13} fontWeight={500} fill="var(--danger)">
            {s.error}
          </text>
          <rect x={X + 14} y={Y + 96} width={W - 28} height={4} rx={2} fill="var(--border)" />
          <rect x={X + 130} y={Y + 96} width={W - 158} height={4} rx={2} fill="var(--danger)" />

          <rect x={X + 102} y={Y - 11} width={40} height={22} rx={11} fill="var(--card)" stroke="var(--input)" />
          <text x={X + 122} y={Y + 4} textAnchor="middle" fontSize={12} fontWeight={600} fill="var(--foreground-2)">
            {s.hitsChip}
          </text>
          <rect x={X + 148} y={Y - 11} width={100} height={22} rx={11} fill="var(--card)" stroke="var(--warning)" />
          <text x={X + 198} y={Y + 4} textAnchor="middle" fontSize={12} fontWeight={600} fill="var(--warning)">
            {s.logsChip}
          </text>

          <Box x={10} y={64} w={190} h={72} title={s.methodTitle} sub={s.methodSub} />
          <Box x={10} y={160} w={190} h={72} title={s.systemTitle} sub={s.systemSub} />
          <Box x={560} y={10} w={190} h={88} title={s.badgesTitle} sub={s.badgesSub} />
          <Box x={560} y={120} w={190} h={88} title={s.outcomeTitle} sub={s.outcomeSub} />
          <Box x={275} y={272} w={210} h={68} title={s.barTitle} sub={s.barSub} />

          <Arrow from={[200, 106]} to={[X + 10, Y + 22]} marker={marker} />
          <Arrow from={[200, 190]} to={[X + 10, Y + 48]} marker={marker} />
          <Arrow from={[560, 54]} to={[X + 250, Y - 6]} marker={marker} />
          <Arrow from={[560, 164]} to={[X + 158, Y + 76]} marker={marker} />
          <Arrow from={[380, 272]} to={[380, Y + 104]} marker={marker} />
        </>
      )}
    </Diagram>
  );
}
