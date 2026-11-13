import type { ProjectInfo } from '@threadline/core';
import { ChevronDown, CircleHelp } from 'lucide-react';
import type { ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import { Tooltip } from '@/components/ui/tooltip.tsx';
import { useCatalogState } from '@/features/catalog/queries.ts';
import { useTruncated } from '@/lib/use-truncated.ts';
import { cn } from '@/lib/utils.ts';
import { ProjectLogo } from './Logo.tsx';

export const HEADER_ICON = 'inline-flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-control)] text-foreground-2 transition-colors hover:bg-sunk data-[state=open]:bg-sunk [&_svg]:size-4';
export const HEADER_ICON_CURRENT = 'bg-accent text-accent-foreground';

// Обрезается только название: логотип, счётчик и стрелка стоят целиком. Сначала место отдаёт метка среды.
const PROJECT_BOX = 'flex h-8 max-w-[260px] min-w-[4rem] shrink items-center gap-2 rounded-[var(--radius-control)] px-2 text-sm font-semibold text-foreground xl:max-w-[320px]';

/** Открытые строки «Неизвестного» текущего проекта: из уже идущего опроса состояния, отдельного запроса нет. Бизнесу сервер поле не отдаёт. */
export function useUnknownOpen(project: string): { unknown: number; unknownText: string | null } {
  const { t } = useTranslation();
  const unknown = useCatalogState().data?.unknownOpen?.[project] ?? 0;
  return { unknown, unknownText: unknown > 0 ? t('header.unknown', { n: unknown }) : null };
}

export function UnknownBadge({ unknown, className, ...props }: ComponentProps<'span'> & { unknown: number }) {
  return (
    <span aria-hidden className={cn('tabular inline-flex h-[18px] shrink-0 items-center rounded-full bg-warning-bg px-1.5 text-[12px] leading-none font-semibold text-warning', className)} {...props}>
      {unknown > 99 ? '99+' : unknown}
    </span>
  );
}

/**
 * Кнопка проекта в главном чанке. Меню приходит ленивым чанком на ту же кнопку, поэтому его появление шапку не сдвигает.
 * Положение значков справа от счётчика не зависит: он стоит внутри кнопки.
 */
export function ProjectButton({ project, plain = false, className, ref, ...props }: ComponentProps<'button'> & { project: ProjectInfo; plain?: boolean }) {
  const { t } = useTranslation();
  const { ref: nameRef, truncated } = useTruncated<HTMLSpanElement>();
  const { unknown, unknownText } = useUnknownOpen(project.id);
  const logo = project.logo && <ProjectLogo logo={project.logo} />;
  const name = (
    <span ref={nameRef} className="block min-w-0 truncate">
      {project.name}
    </span>
  );
  if (plain) {
    return (
      <Tooltip content={project.name} disabled={!truncated}>
        <span className={cn(PROJECT_BOX, className)} data-testid="header-project-name" tabIndex={truncated ? 0 : undefined}>
          {logo}
          {name}
        </span>
      </Tooltip>
    );
  }
  return (
    <Tooltip content={unknownText ? `${project.name} · ${unknownText}` : project.name} disabled={!truncated && !unknownText}>
      <button ref={ref} type="button" data-testid="project-menu" className={cn(PROJECT_BOX, 'transition-colors hover:bg-sunk data-[state=open]:bg-sunk', className)} {...props}>
        {/* Имя из содержимого, а не aria-label: в нём всё, что видно на кнопке (WCAG 2.5.3). */}
        <span className="sr-only">{t('header.project')}: </span>
        {logo}
        {name}
        {unknownText && <span className="sr-only">. {unknownText}</span>}
        {unknown > 0 && <UnknownBadge unknown={unknown} data-testid="header-unknown" />}
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      </button>
    </Tooltip>
  );
}

/** Значок «Справка». Подпись и подсказка на текущем языке. */
export function HelpButton({ current = false, className, ref, ...props }: ComponentProps<'button'> & { current?: boolean }) {
  const { t } = useTranslation();
  return (
    <Tooltip content={t('header.help')}>
      <button ref={ref} type="button" aria-label={t('header.help')} aria-current={current ? 'true' : undefined} data-testid="header-help" className={cn(HEADER_ICON, current && HEADER_ICON_CURRENT, className)} {...props}>
        <CircleHelp aria-hidden />
      </button>
    </Tooltip>
  );
}
