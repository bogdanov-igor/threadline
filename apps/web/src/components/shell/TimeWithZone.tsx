import { formatDateTime, timeZoneOffsetLabel } from '@threadline/core';
import { useTranslation } from 'react-i18next';
import { Tooltip } from '@/components/ui/tooltip.tsx';

/** Время в часовом поясе проекта; подсказка называет пояс. */
export function TimeWithZone({ iso, timeZone, ms = false, plain = false }: { iso: string; timeZone: string; ms?: boolean; /** Без пунктира: подсказка остаётся, а строка читается обычным текстом. */ plain?: boolean }) {
  const { t } = useTranslation();
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  const zone = t('time.zone', { zone: timeZone, offset: timeZoneOffsetLabel(timeZone, new Date(at)) });
  return (
    <Tooltip content={zone}>
      <time dateTime={iso} tabIndex={0} aria-label={`${formatDateTime(at, timeZone, { ms })}, ${zone}`} className={plain ? 'tabular rounded-[4px]' : 'tabular rounded-[4px] underline decoration-dotted decoration-muted-foreground/60 underline-offset-[3px]'}>
        {formatDateTime(at, timeZone, { ms })}
      </time>
    </Tooltip>
  );
}
