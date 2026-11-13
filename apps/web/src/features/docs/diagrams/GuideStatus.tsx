// Схема «Что сломалось»: два вопроса и пять ответов. Threadline, Grafana или ваша сеть.
import { Arrow, Box, Diagram, useDiagramText } from './parts.tsx';

const LEAF = { y: 266, w: 142, h: 104 };

export function GuideStatus({ label }: { label: string }) {
  const s = useDiagramText('guide-status');
  return (
    <Diagram width={760} height={380} label={label}>
      {(marker) => (
        <>
          <Box x={280} y={8} w={200} h={56} title={s.opens} tone="main" />
          <Box x={10} y={130} w={280} h={64} title={s.otherSites} sub={s.otherSitesSub} />
          <Box x={410} y={130} w={320} h={64} title={s.check} sub={s.checkSub} />

          <Box x={8} y={LEAF.y} w={LEAF.w} h={LEAF.h} title={s.networkTitle} sub={s.networkSub} />
          <Box x={158} y={LEAF.y} w={LEAF.w} h={LEAF.h} title={s.downTitle} sub={s.downSub} />
          <Box x={308} y={LEAF.y} w={LEAF.w} h={LEAF.h} title={s.okTitle} sub={s.okSub} />
          <Box x={458} y={LEAF.y} w={LEAF.w} h={LEAF.h} title={s.oursTitle} sub={s.oursSub} />
          <Box x={608} y={LEAF.y} w={LEAF.w} h={LEAF.h} title={s.remoteTitle} sub={s.remoteSub} />

          <Arrow from={[310, 64]} to={[170, 130]} label={s.no} marker={marker} />
          <Arrow from={[450, 64]} to={[570, 130]} label={s.yes} marker={marker} />
          <Arrow from={[100, 194]} to={[79, LEAF.y]} label={s.no} marker={marker} />
          <Arrow from={[210, 194]} to={[229, LEAF.y]} label={s.yes} marker={marker} />
          <Arrow from={[470, 194]} to={[379, LEAF.y]} label={s.resultOk} marker={marker} />
          <Arrow from={[570, 194]} to={[529, LEAF.y]} label={s.resultOurs} labelAt={0.6} marker={marker} />
          <Arrow from={[670, 194]} to={[679, LEAF.y]} label={s.resultRemote} marker={marker} />
        </>
      )}
    </Diagram>
  );
}
