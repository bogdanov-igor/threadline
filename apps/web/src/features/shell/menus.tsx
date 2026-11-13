// Меню проекта и меню «Справка» по доскам T-project и T-help. Открытие запросов не отправляет: все данные уже есть в шапке.
import type { ProjectInfo, ProjectsResponse } from '@threadline/core';
import { BookOpen, GraduationCap, Info, Keyboard, MessageSquareWarning } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';
import { ProjectLogo } from '@/components/shell/Logo.tsx';
import { HelpButton, ProjectButton, UnknownBadge, useUnknownOpen } from '@/components/shell/ProjectButton.tsx';
import type { ProjectPage } from '@/components/shell/Header.tsx';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, MENU_ROW_LABEL } from '@/components/ui/dropdown-menu.tsx';
import { Kbd } from '@/components/ui/kbd.tsx';
import { useAccess } from '@/features/auth/access.tsx';
import { ReportSlot } from '@/features/report/slot.tsx';
import { useLeaveSearch } from '@/features/search/useLeaveSearch.ts';
import { useBuildInfo } from '@/lib/build-line.tsx';
import { runHotkey } from '@/lib/hotkeys.ts';
import { envPath, firstEnvOf } from '@/lib/selection.ts';

export interface ProjectMenuProps {
  data: ProjectsResponse;
  project: ProjectInfo;
  toSearch: string;
  page: ProjectPage;
}

/** Пункт-ссылка: Radix даёт роль и клавиатуру, адрес видит браузер. */
function LinkItem({ to, current, testId, children }: { to: string; current: boolean; testId?: string; children: ReactNode }) {
  return (
    <DropdownMenuItem asChild>
      <Link to={to} aria-current={current ? 'page' : undefined} data-testid={testId} className={current ? 'bg-accent data-[highlighted]:bg-accent' : undefined}>
        {children}
      </Link>
    </DropdownMenuItem>
  );
}

/** Логотип другого проекта грузится только при открытом меню: закрытого меню Radix в документе нет. */
function ProjectRow({ project }: { project: ProjectInfo }) {
  return (
    <>
      {project.logo && <ProjectLogo logo={project.logo} inRow />}
      <span className="min-w-0 truncate" title={project.name}>
        {project.name}
      </span>
    </>
  );
}

export function ProjectMenu({ data, project, toSearch, page }: ProjectMenuProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const leave = useLeaveSearch();
  const details = useAccess().can('details');
  const { unknown, unknownText } = useUnknownOpen(project.id);
  const others = data.projects.filter((p) => p.id !== project.id);
  // Бизнесу открывать нечего, если проект один: название стоит текстом.
  if (!details && others.length === 0) return <ProjectButton project={project} plain />;
  const base = `/${encodeURIComponent(project.id)}`;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <ProjectButton project={project} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[300px]" data-testid="project-menu-content">
        <DropdownMenuLabel className={`${MENU_ROW_LABEL} font-semibold`} data-testid="project-menu-current">
          <ProjectRow project={project} />
          <span className="ml-auto shrink-0 text-[12px] font-normal text-muted-foreground">{t('shell.project.current')}</span>
        </DropdownMenuLabel>
        {/* Заголовок отделён линией: это не пункт, нажимать в нём нечего. */}
        <DropdownMenuSeparator />
        {details && (
          <>
            <LinkItem to={toSearch} current={page === 'search'} testId="header-to-search">
              {t('shell.project.search')}
            </LinkItem>
            <LinkItem to={`${base}/catalog`} current={page === 'catalog'} testId="header-catalog">
              {t('shell.project.catalog')}
              {unknown > 0 && <span className="sr-only">{unknownText}</span>}
              {unknown > 0 && <UnknownBadge unknown={unknown} className="ml-auto" data-testid="menu-unknown" title={unknownText ?? undefined} />}
            </LinkItem>
            <LinkItem to={`${base}/settings/main`} current={page === 'settings'} testId="header-settings">
              {t('shell.project.settings')}
            </LinkItem>
          </>
        )}
        {others.length > 0 && (
          <>
            {details && <DropdownMenuSeparator />}
            <DropdownMenuLabel>{t('shell.project.others')}</DropdownMenuLabel>
            {others.map((p) => (
              <DropdownMenuItem
                key={p.id}
                data-testid="project-option"
                onSelect={() => {
                  // На страницах зоны проекта другой проект открывается там же.
                  if (page === 'catalog' || page === 'settings') return void navigate(`/${encodeURIComponent(p.id)}/${page === 'catalog' ? 'catalog' : 'settings/main'}`);
                  const env = firstEnvOf(data, p.id);
                  if (!env) return;
                  leave();
                  void navigate(envPath(p.id, env));
                }}
              >
                <ProjectRow project={p} />
              </DropdownMenuItem>
            ))}
          </>
        )}
        {details && (
          <>
            <DropdownMenuSeparator />
            <LinkItem to="/admin/projects" current={page === 'projects'} testId="header-projects">
              {t('shell.project.all')}
            </LinkItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const HELP_ITEMS = [
  { to: '/docs', key: 'docs', testId: 'header-docs', icon: BookOpen },
  { to: '/learn', key: 'learn', testId: 'header-learn', icon: GraduationCap },
  { to: '/about', key: 'about', testId: 'header-about', icon: Info },
] as const;

export function HelpMenu({ current }: { current: boolean }) {
  const { t } = useTranslation();
  // Версия у пункта «О Threadline»: тот же ответ сервера, что у страницы «О Threadline».
  const version = useBuildInfo().data?.version;
  const [report, setReport] = useState(false);
  const [everOpened, setEverOpened] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  // Форма и окно клавиш открываются, когда меню уже закрылось и отдало фокус: иначе два окна Radix спорят о фокусе и блокировке страницы.
  const opening = useRef<'report' | 'keys' | null>(null);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <HelpButton ref={button} current={current} />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-[252px]"
          data-testid="help-menu-content"
          onCloseAutoFocus={(e) => {
            const next = opening.current;
            if (!next) return;
            opening.current = null;
            e.preventDefault();
            if (next === 'keys') {
              runHotkey('help', button.current);
              return;
            }
            setEverOpened(true);
            setReport(true);
          }}
        >
          {HELP_ITEMS.map(({ to, key, testId, icon: Icon }) => (
            <DropdownMenuItem key={to} asChild>
              <Link to={to} data-testid={testId}>
                <Icon aria-hidden />
                {t(`shell.help.${key}`)}
                {key === 'about' && version && (
                  <span className="ml-auto text-[12px] text-muted-foreground" data-testid="header-version">
                    {t('shell.help.version', { version })}
                  </span>
                )}
              </Link>
            </DropdownMenuItem>
          ))}
          <DropdownMenuItem
            data-testid="header-keys"
            onSelect={() => {
              opening.current = 'keys';
            }}
          >
            <Keyboard aria-hidden />
            {t('shell.help.keys')}
            <Kbd className="ml-auto">?</Kbd>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            data-testid="header-report"
            onSelect={() => {
              opening.current = 'report';
            }}
          >
            <MessageSquareWarning aria-hidden />
            {t('shell.help.report')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {everOpened && <ReportSlot open={report} onOpenChange={setReport} returnFocus={button} />}
    </>
  );
}
