import { Check, Copy, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useCopy } from '@/lib/clipboard.ts';
import { cn } from '@/lib/utils.ts';
import { Tooltip } from './tooltip.tsx';

/** Кнопка-значок копирования: после нажатия показывает галочку и объявляет «Скопировано»; не вышло — крестик и «Не удалось скопировать». */
export function CopyIconButton({ text, label, className }: { text: string; label: string; className?: string }) {
  const { t } = useTranslation();
  const { state, copy } = useCopy();
  const done = state === 'copied';
  const status = done ? t('requests.copied') : state === 'failed' ? t('requests.copyFailed') : '';
  return (
    <Tooltip content={status || label}>
      <button
        type="button"
        aria-label={label}
        data-copied={done || undefined}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          void copy(text);
        }}
        className={cn(
          'relative flex size-7 shrink-0 items-center justify-center rounded-[8px] text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground',
          done && 'text-primary',
          state === 'failed' && 'text-danger',
          className,
        )}
      >
        {done ? <Check className="size-4" aria-hidden /> : state === 'failed' ? <X className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
        <span className="sr-only" aria-live="polite">
          {status}
        </span>
      </button>
    </Tooltip>
  );
}
