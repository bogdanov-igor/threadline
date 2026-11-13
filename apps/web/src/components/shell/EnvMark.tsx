import type { ConnectionResponse } from '@threadline/core';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Tooltip } from '@/components/ui/tooltip.tsx';
import { keys } from '@/lib/queries.ts';
import { envSetName, selectionEnvs, selectionPath, type Selection } from '@/lib/selection.ts';
import { useTruncated } from '@/lib/use-truncated.ts';
import { cn } from '@/lib/utils.ts';
import { TONE_CLASSES, toneOf } from './status.ts';

// Сжимается первой, номер стенда не обрезается.
const MARK =
  'flex h-8 max-w-[180px] min-w-0 shrink-[100] items-center gap-1.5 rounded-[var(--radius-control)] px-1.5 text-[13.5px] font-medium text-foreground-2 xl:max-w-[260px]';

/**
 * Метка среды в шапке: среда, стенд и состояние по последней проверке, если она была: своей проверки метка не отправляет.
 * На страницах запроса и операции это ссылка на поиск этой среды, на прокрученной странице поиска — обычный текст:
 * остановка Tab не появляется и не исчезает при прокрутке.
 */
export function EnvMark({ selection, link }: { selection: Selection; link: boolean }) {
  const { t } = useTranslation();
  const { ref, truncated } = useTruncated<HTMLSpanElement>();
  const { project, stand } = selection;
  const qc = useQueryClient();
  // Несколько сред: «Прод + Тест», точка — худшее из последних проверок.
  const name = envSetName(selection);
  const RANK = { danger: 4, warning: 3, neutral: 2, success: 1, demo: 0 } as const;
  const last = selectionEnvs(selection)
    .map((e) => qc.getQueryData<ConnectionResponse>(keys.connection(project.id, e.id))?.status)
    .reduce<ConnectionResponse['status'] | undefined>((worst, s) => (s && (!worst || RANK[toneOf(s)] > RANK[toneOf(worst)]) ? s : worst), undefined);
  const content = (
    <>
      {last && <span aria-hidden data-testid="env-mark-status" className={cn('size-[7px] shrink-0 rounded-full', TONE_CLASSES[toneOf(last)].dot)} />}
      <span ref={ref} className="min-w-0 truncate">
        {name}
      </span>
      {stand && <span className="tabular -ml-1.5 shrink-0 whitespace-pre"> · {stand}</span>}
    </>
  );
  return (
    <>
      <span className="shrink-0 px-0.5 text-muted-foreground" aria-hidden>
        ·
      </span>
      <Tooltip content={name} disabled={!truncated}>
        {link ? (
          <Link
            to={selectionPath(selection)}
            data-testid="env-mark"
            aria-label={t('header.envMark', { name: stand ? `${name} · ${stand}` : name })}
            className={cn(MARK, 'transition-colors hover:bg-sunk')}
          >
            {content}
          </Link>
        ) : (
          <span data-testid="env-mark" className={MARK}>
            {content}
          </span>
        )}
      </Tooltip>
    </>
  );
}
