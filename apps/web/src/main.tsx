import './styles/index.css';
import './i18n/index.ts';
import { applySavedLanguage } from './i18n/bundles.ts';
import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, Outlet } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { FatalError } from '@/components/states/FatalError.tsx';
import { AuthGate } from '@/features/auth/AuthGate.tsx';
import { DocsSlot } from '@/features/docs/slot.tsx';
import { useExtras } from '@/features/extras/hub.ts';
import { HelpSlot } from '@/features/help/slot.tsx';
import { KeysRoot } from '@/features/keys/slot.tsx';
import { LocalStoragesSlot } from '@/features/local/slot.tsx';
import { OperationSlot } from '@/features/operation/slot.tsx';
import { ProjectsSlot } from '@/features/projects/slot.tsx';
import { ServiceSlot } from '@/features/service/slot.tsx';
import { SharePageSlot } from '@/features/share/page-slot.tsx';
import { useProjectsWatch } from '@/features/projects/use-projects-watch.ts';
import { useCatalogState } from '@/features/catalog/queries.ts';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { useMaskingWatch } from '@/features/request/reveal.ts';
import { registerServiceWorkerOnLoad } from '@/lib/pwa.ts';
import { queryClient } from '@/lib/queries.ts';
import { useThemeWatch } from '@/lib/theme.ts';
import { EnvironmentPage } from '@/routes/EnvironmentPage.tsx';
import { Home } from '@/routes/Home.tsx';
import { Layout } from '@/routes/Layout.tsx';
import { OldProjectAddress, ToAddress, ZoneAddress } from '@/routes/redirects.tsx';
import { RequestRoute } from '@/routes/RequestRoute.tsx';
import { UnknownPage } from '@/routes/UnknownPage.tsx';

/** Смена настройки маскирования при открытой странице: в корне, чтобы уход между страницами не сбрасывал сравнение отпечатков. */
function MaskingWatch() {
  useMaskingWatch();
  return null;
}

/** Правка проектов в другой вкладке: версия приходит в уже идущем опросе состояния справочника. */
function ProjectsWatch() {
  useProjectsWatch(useCatalogState().data?.projectsVersion);
  return null;
}

/** Шутки по времени и код Konami. */
function ExtrasWatch() {
  useExtras();
  return null;
}

/** Всё, кроме страницы ссылки: проверка входа и опросы. На странице ссылки их нет, иначе опрос получил бы 401 и увёл бы на вход. */
function SignedIn() {
  return (
    <AuthGate>
      <MaskingWatch />
      <ProjectsWatch />
      <ExtrasWatch />
      <Outlet />
    </AuthGate>
  );
}

function ThemeWatch() {
  useThemeWatch();
  return null;
}

const router = createBrowserRouter([
  // Короткая ссылка: вне проверки входа и вне Layout со списком проектов.
  // Вложенные адреса без своего элемента: страница одна и не монтируется заново, поиск ссылки не запускается второй раз.
  { path: 's/:id', element: <SharePageSlot />, errorElement: <FatalError />, children: [{ path: 'requests/:cid', element: null }, { path: 'operations/:type/:value', element: null }] },
  {
    element: <SignedIn />,
    errorElement: <FatalError />,
    children: [
      {
    element: <Layout />,
    errorElement: <FatalError />,
    children: [
      { index: true, element: <Home /> },
      // Страницы зон «Управление» и «Справка» первыми: /admin/status и /:project/:env у роутера не должны совпасть.
      { path: 'admin', element: <ToAddress to="/admin/projects" /> },
      { path: 'admin/projects', element: <ProjectsSlot page="list" />, errorElement: <FatalError inLayout /> },
      { path: 'admin/projects/new', element: <ProjectsSlot page="new" />, errorElement: <FatalError inLayout /> },
      { path: 'admin/status', element: <ServiceSlot />, errorElement: <FatalError inLayout /> },
      { path: 'admin/storages', element: <LocalStoragesSlot />, errorElement: <FatalError inLayout /> },
      { path: 'admin/settings', element: <ToAddress to="/admin/status" hash="#settings" /> },
      { path: 'admin/*', element: <UnknownPage /> },
      // Страница документации и обучения: один сегмент, имя файла. Выше /:project/catalog: при равном весе роутер берёт первый маршрут, а проект docs и learn запрещён.
      { path: 'docs', element: <DocsSlot tree="docs" />, errorElement: <FatalError inLayout /> },
      { path: 'docs/:page', element: <DocsSlot tree="docs" />, errorElement: <FatalError inLayout /> },
      { path: 'docs/*', element: <UnknownPage /> },
      { path: 'learn', element: <DocsSlot tree="learn" />, errorElement: <FatalError inLayout /> },
      { path: 'learn/:page', element: <DocsSlot tree="learn" />, errorElement: <FatalError inLayout /> },
      { path: 'learn/*', element: <UnknownPage /> },
      { path: 'about', element: <HelpSlot page="about" />, errorElement: <FatalError inLayout /> },
      { path: 'credits', element: <HelpSlot page="credits" />, errorElement: <FatalError inLayout /> },
      // Старые адреса.
      { path: 'settings', element: <ToAddress to="/admin/status" hash="#settings" /> },
      { path: 'projects', element: <ToAddress to="/admin/projects" /> },
      { path: 'projects/new', element: <ToAddress to="/admin/projects/new" /> },
      { path: 'projects/:id', element: <OldProjectAddress /> },
      // Страница запроса раньше страницы среды: иначе «requests» примется за номер стенда.
      // Справочник и настройки проекта — статические сегменты выше страницы среды: среды «catalog» и «settings» запрещены в настройке.
      { path: ':project/catalog/systems/:key', element: <ZoneAddress />, errorElement: <FatalError inLayout /> },
      { path: ':project/catalog/:section?', element: <ZoneAddress />, errorElement: <FatalError inLayout /> },
      { path: ':project/settings/:section?', element: <ZoneAddress />, errorElement: <FatalError inLayout /> },
      { path: ':project/:env/requests/:cid', element: <RequestRoute />, errorElement: <FatalError inLayout /> },
      { path: ':project/:env/:stand/requests/:cid', element: <RequestRoute />, errorElement: <FatalError inLayout /> },
      // Страница операции — тоже раньше страницы среды.
      { path: ':project/:env/operations/:type/:value', element: <OperationSlot />, errorElement: <FatalError inLayout /> },
      { path: ':project/:env/:stand/operations/:type/:value', element: <OperationSlot />, errorElement: <FatalError inLayout /> },
      { path: ':project/:env/:stand?', element: <EnvironmentPage />, errorElement: <FatalError inLayout /> },
      { path: '*', element: <UnknownPage /> },
    ],
      },
    ],
  },
]);

registerServiceWorkerOnLoad();

// До первой отрисовки: страница сразу на сохранённом языке. Не верхнеуровневый await: с ним сборка разбивает главный чанк на десяток файлов.
void applySavedLanguage().then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider delayDuration={400}>
          <ThemeWatch />
          <KeysRoot />
          <RouterProvider router={router} />
        </TooltipProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
});
