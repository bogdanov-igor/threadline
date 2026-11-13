import { Navigate } from 'react-router';
import { PageSkeleton } from '@/components/states/PageSkeleton.tsx';
import { startPath } from '@/lib/selection.ts';
import { useLayout } from './Layout.tsx';

/** Корневой адрес: последний выбор в этом браузере или проект и среда по умолчанию. */
export function Home() {
  const { data } = useLayout();
  if (!data) return <PageSkeleton />;
  return <Navigate replace to={startPath(data)} />;
}
