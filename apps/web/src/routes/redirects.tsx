// Новые адреса и перенаправления со старых. Без записи в истории, параметры запроса сохраняются.
// Правила доступа и вход проверяет новая страница: перенаправление их не обходит.
import { Navigate, useLocation, useMatch, useParams, useSearchParams } from 'react-router';
import { CatalogSlot } from '@/features/catalog/slot.tsx';
import { UnknownPage } from './UnknownPage.tsx';

const enc = encodeURIComponent;

export function ToAddress({ to, hash }: { to: string; hash?: string }) {
  const location = useLocation();
  return <Navigate replace to={{ pathname: to, search: location.search, hash: hash ?? location.hash }} />;
}

/** /projects/:id и /projects/:id?tab=view: вкладка становится пунктом настроек, неизвестная открывает «Основное». */
export function OldProjectAddress() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const section = params.get('tab') === 'view' ? 'view' : 'main';
  params.delete('tab');
  const search = params.toString();
  return <Navigate replace to={{ pathname: `/${enc(id)}/settings/${section}`, search: search ? `?${search}` : '' }} />;
}

/**
 * Адреса зоны «Проект»: /:project/catalog/..., /:project/catalog/systems/:key и /:project/settings/....
 * Один элемент на все три маршрута: при переходе между справочником и настройками меню не монтируется заново.
 */
export function ZoneAddress() {
  const { project = '', section, key } = useParams();
  const inSettings = useMatch('/:project/settings/:section?') !== null;
  if (!inSettings && key === undefined) {
    if (section === 'masking') return <ToAddress to={`/${enc(project)}/settings/masks`} />;
    if (section?.startsWith('system-')) return <ToAddress to={`/${enc(project)}/catalog/systems/${enc(section.slice('system-'.length))}`} />;
  }
  if (inSettings) {
    if (section === undefined) return <ToAddress to={`/${enc(project)}/settings/main`} />;
    if (!['main', 'environments', 'view', 'file', 'masks'].includes(section)) return <UnknownPage />;
  }
  return <CatalogSlot />;
}
