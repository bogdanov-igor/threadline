// Схема «Из чего состоит файл»: разделы файла слева, места на экране, где они видны, справа.
import { Arrow, Box, Diagram, useDiagramText } from './parts.tsx';

const LEFT = { x: 10, w: 270 };
const RIGHT = { x: 430, w: 320 };
const ROW = 68;
const H = 56;

export function FileSections({ label }: { label: string }) {
  const s = useDiagramText('file-sections');
  return (
    <Diagram width={760} height={10 + s.rows.length * ROW} label={label}>
      {(marker) =>
        s.rows.map((row, i) => {
          const y = 10 + i * ROW;
          return (
            <g key={row.section}>
              <Box x={LEFT.x} y={y} w={LEFT.w} h={H} title={row.section} sub={row.what} tone="main" />
              <Box x={RIGHT.x} y={y} w={RIGHT.w} h={H} title={row.where} sub={row.detail} />
              <Arrow from={[LEFT.x + LEFT.w, y + H / 2]} to={[RIGHT.x, y + H / 2]} marker={marker} />
            </g>
          );
        })
      }
    </Diagram>
  );
}
