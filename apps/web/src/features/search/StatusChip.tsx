import { CircleAlert, CircleCheck, CircleHelp } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button.tsx';
import { StatusChip as StatusCapsule } from '@/components/ui/chip.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.tsx';
import { Tooltip } from '@/components/ui/tooltip.tsx';

/** Что проверено при определении статуса и что нет. */
export function StatusLegendText() {
  const { t } = useTranslation();
  return (
    <span className="flex flex-col gap-1.5">
      <span>{t('results.legend.error')}</span>
      <span>{t('results.legend.notYet')}</span>
      <span>{t('results.legend.partner')}</span>
    </span>
  );
}

const ICONS = { error: CircleAlert, success: CircleCheck } as const;

/** Статус запроса: красный — ошибка, зелёный — успех. Подсказка объясняет, как он определён. */
export function StatusChip({ status, focusable = false, compact = false }: { status: 'error' | 'success'; focusable?: boolean; compact?: boolean }) {
  const { t } = useTranslation();
  const Icon = ICONS[status];
  return (
    <Tooltip content={<StatusLegendText />}>
      <StatusCapsule tone={status === 'error' ? 'danger' : 'success'} data-status={status} tabIndex={focusable ? 0 : undefined} className={compact ? 'max-xl:px-1' : undefined}>
        <Icon aria-hidden />
        {/* В узкой строке списка — только значок, слово остаётся для чтения с экрана. */}
        <span className={compact ? 'max-xl:sr-only' : undefined}>{t(`requests.status.${status}`)}</span>
      </StatusCapsule>
    </Tooltip>
  );
}

/**
 * Невидимые метки обоих статусов: задают ширину колонки по самому длинному названию текущего языка, какие бы строки ни были на экране.
 * Ставится в ячейку шапки колонки шириной max-content.
 */
export function StatusWidthSizer() {
  const { t } = useTranslation();
  return (
    <span aria-hidden className="invisible hidden h-0 flex-col overflow-hidden xl:flex">
      {(['error', 'success'] as const).map((status) => {
        const Icon = ICONS[status];
        return (
          <StatusCapsule key={status}>
            <Icon />
            {t(`requests.status.${status}`)}
          </StatusCapsule>
        );
      })}
    </span>
  );
}

export function StatusLegendButton() {
  const { t } = useTranslation();
  return (
    <Popover>
      <Tooltip content={t('results.legend.button')}>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="icon" className="size-7 text-foreground-2" aria-label={t('results.legend.button')}>
            <CircleHelp aria-hidden />
          </Button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent className="text-[13px] leading-5" data-testid="status-legend">
        <StatusLegendText />
      </PopoverContent>
    </Popover>
  );
}
