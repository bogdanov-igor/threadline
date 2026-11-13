// Схема «Как находится метод»: вход ищется в системе проекта, вызов сначала ищет систему по хосту, затем метод.
import { Arrow, Box, Diagram, useDiagramText } from './parts.tsx';

export function FileMethod({ label }: { label: string }) {
  const s = useDiagramText('file-method');
  return (
    <Diagram width={760} height={596} label={label}>
      {(marker) => (
        <>
          <Box x={260} y={8} w={240} h={56} title={s.record} sub={s.recordSub} />

          <Box x={10} y={104} w={240} h={64} title={s.entry} sub={s.entrySub} />
          <Box x={10} y={224} w={240} h={72} title={s.authorMethods} sub={s.authorMethodsSub} tone="main" />

          <Box x={400} y={104} w={280} h={64} title={s.call} sub={s.callSub} />
          <Box x={400} y={208} w={280} h={56} title={s.host} sub={s.hostSub} tone="main" />
          <Box x={300} y={316} w={200} h={64} title={s.oneSystem} sub={s.oneSystemSub} />
          <Box x={530} y={316} w={220} h={64} title={s.allSystems} sub={s.allSystemsSub} />
          <Box x={530} y={428} w={220} h={64} title={s.noSystem} sub={s.noSystemSub} />

          <Box x={60} y={428} w={380} h={64} title={s.compare} sub={s.compareSub} tone="main" />
          <Box x={10} y={532} w={240} h={56} title={s.found} sub={s.foundSub} />
          <Box x={270} y={532} w={340} h={56} title={s.notFound} sub={s.notFoundSub} />

          <Arrow from={[330, 64]} to={[130, 104]} marker={marker} />
          <Arrow from={[430, 64]} to={[540, 104]} marker={marker} />
          <Arrow from={[130, 168]} to={[130, 224]} marker={marker} />
          <Arrow from={[540, 168]} to={[540, 208]} marker={marker} />
          <Arrow from={[480, 264]} to={[400, 316]} label={s.yes} marker={marker} />
          <Arrow from={[600, 264]} to={[640, 316]} label={s.no} marker={marker} />
          <Arrow from={[640, 380]} to={[640, 428]} label={s.manyOrNone} marker={marker} />
          <Arrow from={[530, 368]} to={[440, 436]} label={s.one} marker={marker} />
          <Arrow from={[380, 380]} to={[330, 428]} marker={marker} />
          <Arrow from={[130, 296]} to={[180, 428]} marker={marker} />
          <Arrow from={[170, 492]} to={[130, 532]} label={s.fits} marker={marker} />
          <Arrow from={[350, 492]} to={[400, 532]} label={s.noFit} marker={marker} />
        </>
      )}
    </Diagram>
  );
}
