// Схема «Путь файла»: открыть, править, проверка, отчёт, применить; ошибки ведут назад, чужая правка останавливает.
import { Arrow, Box, Diagram, useDiagramText } from './parts.tsx';

const W = 131;
const GAP = 26;
const X = [0, W + GAP, 2 * (W + GAP), 3 * (W + GAP), 4 * (W + GAP)] as const;

export function FileFlow({ label }: { label: string }) {
  const s = useDiagramText('file-flow');
  return (
    <Diagram width={760} height={236} label={label}>
      {(marker) => (
        <>
          <Box x={X[0]} y={10} w={W} h={72} title={s.open} sub={s.openSub} />
          <Box x={X[1]} y={10} w={W} h={72} title={s.edit} sub={s.editSub} />
          <Box x={X[2]} y={10} w={W} h={72} title={s.check} sub={s.checkSub} tone="main" />
          <Box x={X[3]} y={10} w={W} h={72} title={s.report} sub={s.reportSub} tone="main" />
          <Box x={X[4]} y={10} w={W} h={72} title={s.apply} sub={s.applySub} />
          <Box x={X[1]} y={150} w={W + GAP + W} h={72} title={s.errors} sub={s.errorsSub} />
          <Box x={X[3]} y={150} w={W + GAP + W} h={72} title={s.conflict} sub={s.conflictSub} />

          <Arrow from={[X[0] + W, 46]} to={[X[1], 46]} marker={marker} />
          <Arrow from={[X[1] + W, 46]} to={[X[2], 46]} marker={marker} />
          <Arrow from={[X[2] + W, 46]} to={[X[3], 46]} marker={marker} />
          <Arrow from={[X[3] + W, 46]} to={[X[4], 46]} marker={marker} />
          <Arrow from={[X[2] + W / 2, 82]} to={[X[2] + W / 2, 150]} marker={marker} />
          <Arrow from={[X[1] + W / 2, 150]} to={[X[1] + W / 2, 82]} marker={marker} />
          <Arrow from={[X[4] + W / 2, 82]} to={[X[4] + W / 2, 150]} dashed marker={marker} />
        </>
      )}
    </Diagram>
  );
}
