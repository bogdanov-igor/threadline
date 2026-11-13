import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useNavigationType, useSearchParams } from 'react-router';
import { EnvControl, useConnectionPanel } from '@/components/shell/EnvControl.tsx';
import { GUTTERS, WorkPage } from '@/components/shell/Page.tsx';
import { StandChooser } from '@/components/shell/StandChooser.tsx';
import { Card } from '@/components/ui/card.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { envPath, envSetName, type Selection } from '@/lib/selection.ts';
import { writeLastChoice } from '@/lib/storage.ts';
import { useDelayed } from '@/lib/use-delayed.ts';
import { cn } from '@/lib/utils.ts';
import { SearchBar, SearchPanel } from './SearchPanel.tsx';
import { SearchResults } from './SearchResults.tsx';
import { StartPage } from './StartPage.tsx';
import { useSearchSession } from './session.tsx';
import { useSearchController } from './useSearchController.ts';

type OnEnvOutOfView = (hidden: boolean) => void;

/** Под строкой поиска: в рабочем режиме занимает остаток окна, прокручивают его части. */
function SearchBody({ scroll = false, children }: { scroll?: boolean; children: ReactNode }) {
  return <div className={cn('flex min-h-0 flex-1 flex-col py-4', GUTTERS, scroll && 'work:overflow-y-auto')}>{children}</div>;
}

/** Страница среды — страница поиска. */
export function SearchPage({
  selection,
  onEnvOutOfView,
}: {
  selection: Selection;
  onEnvOutOfView: OnEnvOutOfView;
}) {
  const { t } = useTranslation();
  const { project, env, stand } = selection;
  const needStand = env.kind === 'pr-stands' && !stand;
  const navigationType = useNavigationType();
  const [params] = useSearchParams();

  useEffect(() => {
    writeLastChoice({ project: project.id, env: env.id, ...(stand ? { stand } : {}) });
  }, [project.id, env.id, stand]);

  // Со страницы запроса окно пришло бы прокрученным, и выбор среды оказался бы за краем. Возврат к результатам идёт через историю.
  const opened = useRef({ navigationType, search: params.get('search') });
  useLayoutEffect(() => {
    if (opened.current.navigationType !== 'POP' && !opened.current.search) window.scrollTo(0, 0);
  }, []);

  return (
    <WorkPage>
      {/* Проект в шапке, среда в строке поиска: заголовок — только для чтения с экрана. */}
      <h1 className="sr-only">
        {project.name} · {envSetName(selection)}
        {stand && ` · ${t('header.standNumber', { number: stand })}`}
      </h1>
      {needStand ? (
        <StandPage selection={selection} onEnvOutOfView={onEnvOutOfView} />
      ) : (
        <Search selection={selection} onEnvOutOfView={onEnvOutOfView} />
      )}
    </WorkPage>
  );
}

/** Заготовка той же высоты, что строка поиска: после загрузки списка проектов строка не сдвигается. */
export function SearchPageSkeleton() {
  const shown = useDelayed(true, 300);
  return (
    <div aria-busy="true" data-testid="page-skeleton">
      <SearchBar>{shown ? <Skeleton className="h-[90px] w-full xl:h-[50px]" /> : <div className="h-[90px] xl:h-[50px]" />}</SearchBar>
    </div>
  );
}

/** Выбор среды над выбором стенда, на том же месте, что и в строке поиска: иначе из среды стендов нельзя было бы уйти. */
function StandPage({ selection, onEnvOutOfView }: { selection: Selection; onEnvOutOfView: OnEnvOutOfView }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const session = useSearchSession();
  const { project, env } = selection;
  const panel = useConnectionPanel(project.id, env.id);
  return (
    <>
      <SearchBar className="pb-1.5">
        <EnvControl selection={selection} panel={panel} onOutOfView={onEnvOutOfView} />
      </SearchBar>
      <SearchBody scroll>
        <Card className="max-w-[880px] p-6">
          <h2 className="text-section font-semibold text-heading">{t('stands.pickTitle')}</h2>
          <p className="mt-1 mb-5 max-w-prose text-muted-foreground">{t('stands.pickText')}</p>
          <StandChooser
            project={project.id}
            env={env.id}
            current={undefined}
            onPick={(s) => {
              session.focusAfterChange('stand');
              navigate(envPath(project.id, env.id, s));
            }}
          />
        </Card>
      </SearchBody>
    </>
  );
}

function Search({ selection, onEnvOutOfView }: { selection: Selection; onEnvOutOfView: OnEnvOutOfView }) {
  const c = useSearchController(selection);
  const panel = useConnectionPanel(selection.project.id, selection.envs ? selection.envs.map((e) => e.id) : selection.env.id);
  return (
    <>
      <SearchPanel c={c} panel={panel} onEnvOutOfView={onEnvOutOfView} />
      <SearchBody scroll={!c.searchId}>
        {c.searchId ? <SearchResults key={`${c.searchId}:${c.runs}`} c={c} searchId={c.searchId} run={c.runs} /> : <StartPage c={c} />}
      </SearchBody>
    </>
  );
}
