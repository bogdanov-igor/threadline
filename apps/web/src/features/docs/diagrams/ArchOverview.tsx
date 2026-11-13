// Схема «Из чего состоит сервис»: браузер, Threadline, Loki через Grafana или напрямую, позже VictoriaLogs, PostgreSQL, вход OIDC (например, Keycloak).
import { Arrow, Box, Diagram, useDiagramText } from './parts.tsx';

export function ArchOverview({ label }: { label: string }) {
  const s = useDiagramText('arch-overview');
  return (
    <Diagram width={760} height={360} label={label}>
      {(marker) => (
        <>
          <Box x={10} y={134} w={140} h={72} title={s.browser} sub={s.browserSub} />
          <Box x={270} y={126} w={180} h={88} title={s.threadline} sub={s.threadlineSub} tone="main" />
          <Box x={570} y={16} w={180} h={64} title={s.grafana} sub={s.grafanaSub} />
          <Box x={570} y={136} w={180} h={64} title={s.loki} sub={s.lokiSub} />
          <Box x={570} y={256} w={180} h={64} title={s.victoria} sub={s.victoriaSub} tone="later" />
          <Box x={270} y={276} w={180} h={72} title={s.postgres} sub={s.postgresSub} />
          <Box x={10} y={16} w={140} h={72} title={s.oidc} sub={s.oidcSub} />

          <Arrow from={[150, 170]} to={[270, 170]} label={s.pages} labelDy={-12} both marker={marker} />
          <Arrow from={[80, 134]} to={[80, 88]} label={s.login} marker={marker} />
          <Arrow from={[300, 126]} to={[150, 56]} label={s.loginServer} marker={marker} />
          <Arrow from={[450, 146]} to={[570, 56]} label={s.read} marker={marker} />
          {/* Хранилище loki: Threadline читает Loki без Grafana. */}
          <Arrow from={[450, 170]} to={[570, 168]} label={s.direct} labelDy={-12} marker={marker} />
          <Arrow from={[660, 80]} to={[660, 136]} marker={marker} />
          <Arrow from={[450, 194]} to={[570, 288]} label={s.later} dashed marker={marker} />
          <Arrow from={[360, 214]} to={[360, 276]} label={s.store} both marker={marker} />
        </>
      )}
    </Diagram>
  );
}
