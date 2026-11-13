// Переключатель режима: две кнопки с aria-pressed, ширина постоянная. Отдельная часть Radix не нужна.
import { useTranslation } from 'react-i18next';
import { Tooltip } from '@/components/ui/tooltip.tsx';
import { cn } from '@/lib/utils.ts';
import { useView } from './context.tsx';

const MODES = ['full', 'brief'] as const;

export function DetailSwitch({ className }: { className?: string }) {
  const { t } = useTranslation();
  const { mode, setMode, locked } = useView();
  // Строка вкладок своей высоты: без переключателя она не сжимается.
  if (locked) return null;
  return (
    <Tooltip content={t('view.switch.hint')}>
      <div role="group" aria-label={t('view.switch.label')} data-testid="detail-switch" className={cn('grid h-8 w-[10.5rem] shrink-0 grid-cols-2 items-center gap-0.5 rounded-[9px] bg-sunk p-[3px]', className)}>
        {MODES.map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={mode === m}
            onClick={() => setMode(m)}
            className={cn('h-full min-w-0 rounded-[7px] text-[13px] font-medium transition-colors', mode === m ? 'bg-[var(--seg-on)] text-foreground shadow-[var(--seg-on-shadow)]' : 'text-muted-foreground hover:text-foreground')}
          >
            {t(`view.mode.${m}`)}
          </button>
        ))}
      </div>
    </Tooltip>
  );
}
