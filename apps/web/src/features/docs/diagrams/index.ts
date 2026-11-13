// Схемы по имени: в тексте ![Подпись](diagram:<имя>). Новая схема: компонент рядом и строка здесь, описание в dev/docs-shots/README.md.
import type { ComponentType } from 'react';
import { ArchOverview } from './ArchOverview.tsx';
import { ArchRequest } from './ArchRequest.tsx';
import { FileFlow } from './FileFlow.tsx';
import { FileMethod } from './FileMethod.tsx';
import { FileOutcome } from './FileOutcome.tsx';
import { FileSections } from './FileSections.tsx';
import { GuideOperation } from './GuideOperation.tsx';
import { GuideStatus } from './GuideStatus.tsx';
import { GuideStep } from './GuideStep.tsx';
import { LearnPostman } from './LearnPostman.tsx';

export const DIAGRAMS: Readonly<Record<string, ComponentType<{ label: string }>>> = {
  'arch-overview': ArchOverview,
  'arch-request': ArchRequest,
  'file-flow': FileFlow,
  'file-method': FileMethod,
  'file-outcome': FileOutcome,
  'file-sections': FileSections,
  'guide-operation': GuideOperation,
  'guide-status': GuideStatus,
  'guide-step': GuideStep,
  'learn-postman': LearnPostman,
};
