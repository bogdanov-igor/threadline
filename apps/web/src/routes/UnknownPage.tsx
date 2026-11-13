import { EyeOff, MapPinOff, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { PageSkeleton } from '@/components/states/PageSkeleton.tsx';
import { StateMessage } from '@/components/states/StateMessage.tsx';
import { Button } from '@/components/ui/button.tsx';
import { useProjects } from '@/lib/queries.ts';
import { defaultLabel, defaultPath } from '@/lib/selection.ts';
import { useLayout } from './Layout.tsx';

/** Неизвестный проект, среда или стенд в адресе. Скрытый проект и неполный список называются отдельно: ссылка коллеги не сломана. */
export function UnknownEnvironment() {
  const { t } = useTranslation();
  const { data } = useLayout();
  const params = useParams();
  const projects = useProjects();
  if (!data) return <PageSkeleton />;
  const toDefault = (
    <Button variant="secondary" asChild>
      <Link to={defaultPath(data)} replace>
        {t('states.unknownEnv.action', { target: defaultLabel(data) })}
      </Link>
    </Button>
  );
  const hidden = data.hidden?.find((p) => p.id === params.project);
  if (hidden) {
    return (
      <StateMessage icon={EyeOff} tone="warning" title={t('states.hiddenProject.title')} text={t('states.hiddenProject.text', { name: hidden.name })}>
        <Button asChild>
          <Link to={`/${encodeURIComponent(hidden.id)}/settings/main`}>{t('states.hiddenProject.action')}</Link>
        </Button>
        {toDefault}
      </StateMessage>
    );
  }
  if (data.incomplete && !data.projects.some((p) => p.id === params.project)) {
    return (
      <StateMessage icon={MapPinOff} tone="warning" title={t('states.incompleteList.title')} text={t('states.incompleteList.text', { project: params.project ?? '' })}>
        <Button onClick={() => void projects.refetch()} disabled={projects.isFetching}>
          <RotateCcw className={projects.isFetching ? 'animate-spin' : undefined} aria-hidden />
          {t('states.retry')}
        </Button>
        {toDefault}
      </StateMessage>
    );
  }
  return (
    <StateMessage
      icon={MapPinOff}
      tone="warning"
      title={t('states.unknownEnv.title')}
      text={t('states.unknownEnv.text', { project: params.project ?? '', env: params.stand ? `${params.env}/${params.stand}` : (params.env ?? '') })}
    >
      <Button asChild>
        <Link to={defaultPath(data)} replace>
          {t('states.unknownEnv.action', { target: defaultLabel(data) })}
        </Link>
      </Button>
    </StateMessage>
  );
}

export function UnknownPage() {
  const { t } = useTranslation();
  return (
    <StateMessage icon={MapPinOff} tone="warning" title={t('states.unknownPage.title')} text={t('states.unknownPage.text')}>
      <Button asChild>
        <Link to="/" replace>
          {t('states.unknownPage.action')}
        </Link>
      </Button>
    </StateMessage>
  );
}
