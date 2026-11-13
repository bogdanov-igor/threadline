// Меню шапки в ленивом чанке: в главном чанке только кнопки, строки и пункты приходят отдельно и сразу. Кнопка та же, поэтому появление меню шапку не сдвигает.
// До загрузки кнопка недоступна: нажатие не пропадает молча, вида она при этом не меняет.
import { lazy, Suspense, type ComponentType } from 'react';
import { useLocation } from 'react-router';
import { HelpButton, ProjectButton } from '@/components/shell/ProjectButton.tsx';
import { loadBundle } from '@/i18n/bundles.ts';
import { useBuildInfo } from '@/lib/build-line.tsx';
import type { ProjectMenuProps } from './menus.tsx';

const HELP_PATH = /^\/(?:docs|about|learn|credits)(?:\/|$)/;

const parts = () => loadBundle('shell').then(() => import('./menus.tsx'));

/** Чанк меню не загрузился: страница работает, кнопка остаётся без меню. */
const orInert = <P extends object>(load: () => Promise<ComponentType<P>>, Inert: ComponentType<P>) =>
  lazy(() => load().then((Component) => ({ default: Component }), () => ({ default: Inert })));

const InertProject = ({ project }: ProjectMenuProps) => <ProjectButton project={project} disabled />;
const InertHelp = ({ current }: { current: boolean }) => <HelpButton current={current} disabled />;
const Project = orInert<ProjectMenuProps>(() => parts().then((m) => m.ProjectMenu), InertProject);
const Help = orInert<{ current: boolean }>(() => parts().then((m) => m.HelpMenu), InertHelp);

export function ProjectMenuLazy(props: ProjectMenuProps) {
  return (
    <Suspense fallback={<InertProject {...props} />}>
      <Project {...props} />
    </Suspense>
  );
}

export function HelpMenuLazy() {
  const current = HELP_PATH.test(useLocation().pathname);
  // Версия для пункта «О Threadline» читается вместе с шапкой: открытие меню запросов не отправляет.
  useBuildInfo();
  return (
    <Suspense fallback={<InertHelp current={current} />}>
      <Help current={current} />
    </Suspense>
  );
}
