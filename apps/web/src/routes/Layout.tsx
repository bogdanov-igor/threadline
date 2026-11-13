import type { ProjectsResponse } from '@threadline/core';
import { RotateCcw, ServerCrash } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Outlet, useLocation, useOutletContext, useParams } from 'react-router';
import { Header } from '@/components/shell/Header.tsx';
import { StateMessage } from '@/components/states/StateMessage.tsx';
import { Button } from '@/components/ui/button.tsx';
import { SearchSessionProvider } from '@/features/search/session.tsx';
import { ViewProvider } from '@/features/view/context.tsx';
import { ApiError } from '@/lib/api.ts';
import { useProjects } from '@/lib/queries.ts';
import { resolveSelection, type Selection } from '@/lib/selection.ts';

export interface LayoutContext {
  data: ProjectsResponse | undefined;
  selection: Selection | null;
  /** Страница поиска сообщает, что выбор среды ушёл за край экрана: шапка показывает метку. */
  setEnvOutOfView: (hidden: boolean) => void;
}

export function useLayout(): LayoutContext {
  return useOutletContext<LayoutContext>();
}

/** Страницы справки не зависят от списка проектов: при его сбое они открыты, кнопки проекта в шапке нет. */
const HELP_PAGE = /^\/(?:docs|about|learn|credits)(?:\/|$)/;

export function Layout() {
  const { t } = useTranslation();
  const projects = useProjects();
  const params = useParams();
  const { pathname } = useLocation();
  const data = projects.data;
  const selection = data ? resolveSelection(data, params) : null;
  const [envOutOfView, setEnvOutOfView] = useState(false);

  return (
    <SearchSessionProvider>
      {/* Режим показа общий у страницы и меню профиля в шапке. */}
      <ViewProvider project={selection?.project ?? null}>
      {/* Страница с меткой WorkPage в рабочем режиме занимает ровно окно, её прокручивают её части. Остальные страницы прокручиваются обычным образом. */}
      <div className="flex min-h-dvh flex-col work:has-[[data-work-page]]:h-dvh work:has-[[data-work-page]]:overflow-hidden work:has-[[data-work-page]]:[&>main]:flex work:has-[[data-work-page]]:[&>main]:min-h-0 work:has-[[data-work-page]]:[&>main]:flex-col">
        <Header data={data} selection={selection} loading={projects.isPending} envOutOfView={envOutOfView} />
        <main className="flex-1">
          {projects.isError && !HELP_PAGE.test(pathname) ? (
            <StateMessage
              icon={ServerCrash}
              tone="danger"
              title={t('states.serverDown.title')}
              text={
                projects.error instanceof ApiError && projects.error.code !== 'server-unreachable'
                  ? `${t('states.serverDown.text')} (${projects.error.code})`
                  : t('states.serverDown.text')
              }
            >
              <Button onClick={() => void projects.refetch()} disabled={projects.isFetching}>
                <RotateCcw className={projects.isFetching ? 'animate-spin' : undefined} aria-hidden />
                {t('states.retry')}
              </Button>
            </StateMessage>
          ) : (
            <Outlet context={{ data, selection, setEnvOutOfView } satisfies LayoutContext} />
          )}
        </main>
      </div>
      </ViewProvider>
    </SearchSessionProvider>
  );
}
