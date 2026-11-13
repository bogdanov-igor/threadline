import { SearchPage, SearchPageSkeleton } from '@/features/search/SearchPage.tsx';
import { useLayout } from './Layout.tsx';
import { UnknownEnvironment } from './UnknownPage.tsx';

export function EnvironmentPage() {
  const { data, selection, setEnvOutOfView } = useLayout();
  if (!data) return <SearchPageSkeleton />;
  if (!selection) return <UnknownEnvironment />;
  // Призыв локального режима — на стартовой странице поиска (StartPage): над строкой поиска он сдвигал её при загрузке.
  return <SearchPage key={`${selection.project.id}/${(selection.envs ?? [selection.env]).map((e) => e.id).join(',')}/${selection.stand ?? ''}`} selection={selection} onEnvOutOfView={setEnvOutOfView} />;
}
