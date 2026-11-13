// Схема «Что происходит после “Найти”»: два прохода к Loki, сборка, память сервера, список и страница запроса.
import { Arrow, Box, Diagram, useDiagramText } from './parts.tsx';

export function ArchRequest({ label }: { label: string }) {
  const s = useDiagramText('arch-request');
  return (
    <Diagram width={760} height={420} label={label}>
      {(marker) => (
        <>
          <Box x={10} y={16} w={180} h={64} title={s.user} sub={s.userSub} />
          <Box x={290} y={16} w={210} h={72} title={s.first} sub={s.firstSub} tone="main" />
          <Box x={290} y={128} w={210} h={72} title={s.second} sub={s.secondSub} tone="main" />
          <Box x={290} y={240} w={210} h={72} title={s.build} sub={s.buildSub} tone="main" />
          <Box x={590} y={72} w={160} h={72} title={s.loki} sub={s.lokiSub} />
          <Box x={590} y={240} w={160} h={72} title={s.database} sub={s.databaseSub} />
          <Box x={290} y={348} w={210} h={60} title={s.memory} sub={s.memorySub} />
          <Box x={10} y={240} w={180} h={72} title={s.list} sub={s.listSub} />
          <Box x={10} y={348} w={180} h={60} title={s.request} sub={s.requestSub} />

          <Arrow from={[190, 50]} to={[290, 50]} marker={marker} />
          <Arrow from={[500, 56]} to={[590, 96]} both marker={marker} />
          <Arrow from={[500, 160]} to={[590, 124]} both marker={marker} />
          <Arrow from={[395, 88]} to={[395, 128]} marker={marker} />
          <Arrow from={[395, 200]} to={[395, 240]} marker={marker} />
          <Arrow from={[500, 276]} to={[590, 276]} both marker={marker} />
          <Arrow from={[395, 312]} to={[395, 348]} marker={marker} />
          <Arrow from={[290, 276]} to={[190, 276]} marker={marker} />
          <Arrow from={[100, 312]} to={[100, 348]} marker={marker} />
        </>
      )}
    </Diagram>
  );
}
