// Форма «Сообщить о проблеме» в ленивом чанке: грузится при первом открытии. После этого остаётся на месте, чтобы набранный текст не пропал при закрытии.
import { lazy, Suspense, type ComponentType, type RefObject } from 'react';
import { loadBundle } from '@/i18n/bundles.ts';

export interface ReportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Куда вернуть фокус после закрытия. */
  returnFocus?: RefObject<HTMLElement | null>;
}

// Сбой загрузки: формы нет, страница на месте.
const Dialog = lazy(
  (): Promise<{ default: ComponentType<ReportDialogProps> }> =>
    loadBundle('report')
      .then(() => import('./ReportDialog.tsx'))
      .catch(() => ({ default: () => null })),
);

export function ReportSlot(props: ReportDialogProps) {
  return (
    <Suspense fallback={null}>
      <Dialog {...props} />
    </Suspense>
  );
}
