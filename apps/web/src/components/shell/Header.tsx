import type { ProjectInfo, ProjectsResponse } from '@threadline/core';
import { FolderKanban } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useParams } from 'react-router';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { useAccess } from '@/features/auth/access.tsx';
import { UserMenuLazy } from '@/features/auth/slot.tsx';
import { CatalogBanner } from '@/features/catalog/CatalogBanner.tsx';
import { HelpMenuLazy, ProjectMenuLazy } from '@/features/shell/slot.tsx';
import { envPath, firstEnvOf, resolveSelection, selectionPath, type Selection } from '@/lib/selection.ts';
import { readLastChoice } from '@/lib/storage.ts';
import { cn } from '@/lib/utils.ts';
import { EnvMark } from './EnvMark.tsx';
import { Brand } from './Logo.tsx';
import { GUTTERS } from './Page.tsx';

// Зоны без проекта в адресе: кнопка проекта показывает последний выбранный.
const NEUTRAL = /^\/(?:admin|docs|about|learn|credits)(?:\/|$)/;
const PROJECT_ZONE = /^\/([^/]+)\/(catalog|settings)(?:\/|$)/;

export type ProjectPage = 'search' | 'catalog' | 'settings' | 'projects' | null;

/** Куда ведёт «Поиск» меню проекта: последний выбор этого проекта, иначе среда по умолчанию или первая. */
function searchTarget(data: ProjectsResponse, project: ProjectInfo): string {
  const last = readLastChoice();
  if (last?.project === project.id && resolveSelection(data, last)) return envPath(last.project, last.env, last.stand);
  return envPath(project.id, firstEnvOf(data, project.id) ?? project.environments[0]!.id);
}

/** Проект шапки и текущая страница меню. Без проекта (неизвестный адрес, скрытый проект) кнопки нет. */
function headerProject(data: ProjectsResponse | undefined, selection: Selection | null, path: string, details: boolean): { project: ProjectInfo; toSearch: string; page: ProjectPage } | null {
  if (!data) return null;
  if (selection) return { project: selection.project, toSearch: selectionPath(selection), page: 'search' };
  if (NEUTRAL.test(path)) {
    const last = readLastChoice();
    const project = data.projects.find((p) => p.id === last?.project) ?? data.projects.find((p) => p.id === data.defaults.project) ?? data.projects[0];
    return project ? { project, toSearch: searchTarget(data, project), page: path.startsWith('/admin/projects') ? 'projects' : null } : null;
  }
  const zone = PROJECT_ZONE.exec(path);
  const project = zone && details ? data.projects.find((p) => p.id === decodeURIComponent(zone[1]!)) : undefined;
  return project ? { project, toSearch: searchTarget(data, project), page: zone![2] as 'catalog' | 'settings' } : null;
}

export function Header({
  data,
  selection,
  loading,
  envOutOfView,
}: {
  data: ProjectsResponse | undefined;
  selection: Selection | null;
  loading: boolean;
  envOutOfView: boolean;
}) {
  const { t } = useTranslation();
  const params = useParams();
  const { pathname } = useLocation();
  // Бизнесу справочник и страницы проектов закрыты: пунктов нет, пустого места вместо них тоже.
  const details = useAccess().can('details');
  const current = headerProject(data, selection, pathname, details);
  // Запрос и операция: useParams здесь видит параметры всего маршрута.
  const onDetails = params.cid !== undefined || params.type !== undefined;
  const hasProjectArea = loading || current !== null || (data !== undefined && details);
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background">
      <div className={cn('flex h-[55px] items-center', GUTTERS)}>
        <Brand home />

        {hasProjectArea && <span className="mx-3 h-7 w-px shrink-0 bg-border xl:mx-4" aria-hidden />}

        {loading && (
          <div className="flex items-center" aria-hidden>
            <Skeleton className="h-5 w-28" />
          </div>
        )}

        {data && current && (
          <nav aria-label={t('header.project')} className="flex min-w-0 flex-1 items-center">
            <ProjectMenuLazy data={data} project={current.project} toSearch={current.toSearch} page={current.page} />
            {selection && (onDetails || envOutOfView) && <EnvMark selection={selection} link={onDetails} />}
          </nav>
        )}

        {/* Проект скрыт или неизвестен: кнопки проекта нет, но к списку проектов путь остаётся. */}
        {data && !current && details && (
          <nav aria-label={t('header.project')} className="flex min-w-0 flex-1 items-center">
            <Link to="/admin/projects" data-testid="header-projects" className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-control)] px-2 text-[13.5px] font-medium text-foreground-2 transition-colors hover:bg-sunk">
              <FolderKanban className="size-4 text-muted-foreground" aria-hidden />
              {t('header.projects')}
            </Link>
          </nav>
        )}

        {/* Справа два меню: «?» со справкой и профиль. Режим, язык, тема и страницы администратора — в профиле. */}
        <div className="ml-auto flex shrink-0 items-center gap-1.5 pl-2" data-testid="header-actions">
          <HelpMenuLazy />
          <UserMenuLazy />
        </div>
      </div>
      {selection && <CatalogBanner timeZone={selection.project.timezone} />}
    </header>
  );
}
