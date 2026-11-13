// Схема «Один перевод в логах»: четыре запроса со своими ID запроса, общий у них только id перевода.
import { Arrow, Box, Diagram, useDiagramText } from './parts.tsx';

const BOX = { y: 16, w: 170, h: 112 };

export function GuideOperation({ label }: { label: string }) {
  const s = useDiagramText('guide-operation');
  const steps = [
    { x: 10, title: s.createTitle, sub: s.createSub },
    { x: 200, title: s.sendTitle, sub: s.sendSub },
    { x: 390, title: s.callbackTitle, sub: s.callbackSub },
    { x: 580, title: s.pollTitle, sub: s.pollSub },
  ];
  return (
    <Diagram width={760} height={270} label={label}>
      {(marker) => (
        <>
          {steps.map((step) => (
            <Box key={step.x} x={step.x} y={BOX.y} w={BOX.w} h={BOX.h} title={step.title} sub={step.sub} />
          ))}
          <Box x={10} y={190} w={740} h={68} title={s.operationTitle} sub={s.operationSub} tone="main" />
          {steps.slice(0, -1).map((step) => (
            <Arrow key={step.x} from={[step.x + BOX.w, BOX.y + BOX.h / 2]} to={[step.x + BOX.w + 20, BOX.y + BOX.h / 2]} marker={marker} />
          ))}
          {steps.map((step) => (
            <Arrow key={step.x} from={[step.x + BOX.w / 2, BOX.y + BOX.h]} to={[step.x + BOX.w / 2, 190]} marker={marker} />
          ))}
        </>
      )}
    </Diagram>
  );
}
