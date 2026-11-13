// Маршруты страниц проектов: список, создание, настройки проекта в зоне «Проект».
import { useParams } from 'react-router';
import { ProjectFormRoute } from './ProjectFormPage.tsx';
import { ProjectSettingsRoute } from './ProjectSettings.tsx';
import { ProjectsList } from './ProjectsList.tsx';

export default function ProjectPages({ page }: { page: 'list' | 'new' | 'edit' }) {
  const { project = '', section } = useParams();
  if (page === 'list') return <ProjectsList />;
  if (page === 'new') return <ProjectFormRoute />;
  return <ProjectSettingsRoute key={project} id={project} section={section} />;
}
