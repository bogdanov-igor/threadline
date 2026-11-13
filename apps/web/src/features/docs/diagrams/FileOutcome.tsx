// Схема «Как решается итог»: правила итога, затем общие признаки, затем правила ошибок.
import { Arrow, Box, Diagram, useDiagramText } from './parts.tsx';

export function FileOutcome({ label }: { label: string }) {
  const s = useDiagramText('file-outcome');
  return (
    <Diagram width={760} height={560} label={label}>
      {(marker) => (
        <>
          <Box x={270} y={8} w={220} h={48} title={s.response} />
          <Box x={150} y={92} w={460} h={64} title={s.rule} sub={s.ruleSub} tone="main" />

          <Box x={10} y={204} w={230} h={48} title={s.ruleDecides} />
          <Box x={10} y={264} w={230} h={56} title="success" sub={s.success} />
          <Box x={10} y={328} w={230} h={56} title="error" sub={s.error} />
          <Box x={10} y={392} w={230} h={56} title="pending" sub={s.pending} />
          <Box x={10} y={456} w={230} h={56} title="ignore" sub={s.ignore} />

          <Box x={290} y={204} w={460} h={64} title={s.sign} sub={s.signSub} tone="main" />
          <Box x={600} y={320} w={150} h={64} title={s.ok} sub={s.okSub} />
          <Box x={290} y={320} w={270} h={64} title={s.errorRule} sub={s.errorRuleSub} tone="main" />
          <Box x={270} y={440} w={150} h={84} title="severity: ok" sub={s.severityOk} />
          <Box x={432} y={440} w={150} h={84} title="severity: error" sub={s.severityError} />
          <Box x={594} y={440} w={156} h={84} title={s.noRule} sub={s.noRuleSub} />

          <Arrow from={[380, 56]} to={[380, 92]} marker={marker} />
          <Arrow from={[240, 156]} to={[125, 204]} label={s.yes} marker={marker} />
          <Arrow from={[500, 156]} to={[520, 204]} label={s.no} marker={marker} />
          <Arrow from={[640, 268]} to={[675, 320]} label={s.no} marker={marker} />
          <Arrow from={[440, 268]} to={[425, 320]} label={s.yes} marker={marker} />
          <Arrow from={[350, 384]} to={[345, 440]} marker={marker} />
          <Arrow from={[440, 384]} to={[505, 440]} marker={marker} />
          <Arrow from={[530, 384]} to={[650, 440]} marker={marker} />
        </>
      )}
    </Diagram>
  );
}
