// Схема «Из Threadline в Postman»: скопировать команду, вставить в Import, подставить свой ключ, отправить.
import { Arrow, Box, Diagram, useDiagramText } from './parts.tsx';

const BOX = { y: 12, w: 164, h: 96 };

export function LearnPostman({ label }: { label: string }) {
  const s = useDiagramText('learn-postman');
  const steps = [
    { x: 8, title: s.copyTitle, sub: s.copySub, tone: 'main' as const },
    { x: 200, title: s.importTitle, sub: s.importSub, tone: 'plain' as const },
    { x: 392, title: s.keyTitle, sub: s.keySub, tone: 'plain' as const },
    { x: 584, title: s.sendTitle, sub: s.sendSub, tone: 'plain' as const },
  ];
  return (
    <Diagram width={760} height={120} label={label}>
      {(marker) => (
        <>
          {steps.map((step) => (
            <Box key={step.x} x={step.x} y={BOX.y} w={BOX.w} h={BOX.h} title={step.title} sub={step.sub} tone={step.tone} />
          ))}
          {steps.slice(0, -1).map((step) => (
            <Arrow key={step.x} from={[step.x + BOX.w, BOX.y + BOX.h / 2]} to={[step.x + BOX.w + 28, BOX.y + BOX.h / 2]} marker={marker} />
          ))}
        </>
      )}
    </Diagram>
  );
}
