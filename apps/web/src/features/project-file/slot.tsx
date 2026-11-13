// Страница файла проекта в настройках зоны: состояния без файла и ленивая загрузка кода редактора.
import type { ProjectSetting, ProjectSettingsResponse } from '@threadline/core';
import { BookX, EyeOff, FileWarning, RotateCcw } from 'lucide-react';
import { Component, lazy, Suspense, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { StateMessage } from '@/components/states/StateMessage.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { ZONE_PAGE } from '@/features/catalog/ui.tsx';
import { loadBundle } from '@/i18n/bundles.ts';

const loadPage = () => loadBundle('project-file').then(() => import('./Page.tsx'));

/** Заготовка той же высоты, что редактор: страница не прыгает. */
export function FileSkeleton() {
  return (
    <div className={ZONE_PAGE} aria-busy="true" data-testid="project-file-skeleton">
      <Skeleton className="h-11 w-72" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-[calc(100dvh-280px)] min-h-[420px] w-full" />
    </div>
  );
}

class ChunkBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** Код редактора не загрузился, например после обновления сервиса: причина и «Повторить», пустого экрана нет. */
function ChunkFailed({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <StateMessage icon={FileWarning} tone="danger" title={t('catalog.fileDraft.chunkTitle')} text={t('catalog.fileDraft.chunkText')}>
      <Button onClick={onRetry} data-testid="file-chunk-retry">
        <RotateCcw aria-hidden />
        {t('states.retry')}
      </Button>
    </StateMessage>
  );
}

export function ProjectFileSlot({ data, project, notices, onRetry }: { data: ProjectSettingsResponse; project: ProjectSetting; notices: ReactNode; onRetry: () => void }) {
  const { t } = useTranslation();
  const [attempt, setAttempt] = useState(0);
  const [Page] = useState(() => ({ current: lazy(loadPage) }));

  if (data.state === 'off') return <StateMessage icon={BookX} title={t('catalog.off.title')} text={t('catalog.off.text')} />;
  if (data.loadedAt === null) {
    return (
      <StateMessage icon={BookX} tone="warning" title={t('catalog.unavailable.title')} text={t('catalog.unavailable.text')}>
        <Button onClick={onRetry}>
          <RotateCcw aria-hidden />
          {t('states.retry')}
        </Button>
      </StateMessage>
    );
  }
  if (project.hidden !== null || project.issues) {
    return (
      <StateMessage icon={EyeOff} tone="warning" title={t('catalog.fileDraft.hiddenTitle')} text={t('catalog.fileDraft.hiddenText')}>
        <Button asChild>
          <Link to={`/${encodeURIComponent(project.id)}/settings/main`}>{t('catalog.zone.main')}</Link>
        </Button>
      </StateMessage>
    );
  }
  return (
    <ChunkBoundary
      key={attempt}
      fallback={
        <ChunkFailed
          onRetry={() => {
            Page.current = lazy(loadPage);
            setAttempt((n) => n + 1);
          }}
        />
      }
    >
      <Suspense fallback={<FileSkeleton />}>
        <Page.current project={project.id} editable={data.editable} notices={notices} />
      </Suspense>
    </ChunkBoundary>
  );
}
