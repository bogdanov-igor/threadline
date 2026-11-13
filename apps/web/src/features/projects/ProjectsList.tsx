// Страница /admin/projects: все проекты таблицей, отметки файла, скрытые. Действия и хранилища живут на настройках проекта и странице сервиса. Открытие не обращается к Grafana.
import type { ProjectSetting, ProjectSettingsResponse } from '@threadline/core';
import { Plus, RotateCcw, Search, ServerCrash } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Page } from '@/components/shell/Page.tsx';
import { StateMessage } from '@/components/states/StateMessage.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Card } from '@/components/ui/card.tsx';
import { Chip } from '@/components/ui/chip.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { Switch } from '@/components/ui/switch.tsx';
import { useAccess } from '@/features/auth/access.tsx';
import { Notice } from '@/features/catalog/ui.tsx';
import { envPath } from '@/lib/selection.ts';
import { readLastChoice } from '@/lib/storage.ts';
import { useDelayed } from '@/lib/use-delayed.ts';
import { fieldText } from '@/lib/server-text.ts';
import { cn } from '@/lib/utils.ts';
import { FileMark, RowLogo, SourceNotice } from './parts.tsx';
import { useProjectSettings } from './queries.ts';

/** Метка строки. Те же размеры у сред и у отметок. */
const MARK = 'h-5 max-w-full rounded-[5px] border-0 px-1.5 font-normal';

/** Сред до 50: в строке первые шесть, остальные числом с подсказкой. */
const SHOWN_ENVS = 6;

export function ProjectsList() {
  const { t } = useTranslation();
  const settings = useProjectSettings();
  const shown = useDelayed(settings.isPending, 300);

  if (settings.isPending) {
    return (
      <Page className="flex flex-col gap-3.5" aria-busy="true" data-testid="projects-skeleton">
        {shown && (
          <>
            <div className="flex flex-col gap-1">
              <Skeleton className="h-[26px] w-40" />
              <Skeleton className="h-[18px] w-[min(80%,36rem)]" />
            </div>
            <Skeleton className="h-40 w-full rounded-[var(--radius-card)]" />
          </>
        )}
      </Page>
    );
  }
  if (settings.isError || !settings.data) {
    return (
      <StateMessage icon={ServerCrash} tone="danger" title={t('projects.loadFailed.title')} text={t('projects.loadFailed.text')}>
        <Button onClick={() => void settings.refetch()} disabled={settings.isFetching}>
          <RotateCcw className={settings.isFetching ? 'animate-spin' : undefined} aria-hidden />
          {t('states.retry')}
        </Button>
      </StateMessage>
    );
  }
  return <ListBody data={settings.data} />;
}

// Колонки списка проектов. Уже 1024 профиль и срок скрыты: иначе на ширине 768px строка не помещается. Ширина действий одна на все языки, колонки строк и шапки совпадают.
const ROW = 'grid items-center gap-x-4 px-5 grid-cols-[minmax(0,1.6fr)_minmax(64px,0.5fr)_minmax(0,1.4fr)_204px] lg:grid-cols-[minmax(0,1.6fr)_minmax(80px,0.5fr)_minmax(0,1.6fr)_minmax(0,1fr)_96px_204px]';

function ListBody({ data }: { data: ProjectSettingsResponse }) {
  const { t } = useTranslation();
  const { can } = useAccess();
  const [showHidden, setShowHidden] = useState(false);
  const hidden = data.projects.filter((p) => p.hidden !== null);
  const rows = data.projects.filter((p) => showHidden || p.hidden === null);
  const configured = data.configuredDefaults;
  // Тот же проект, что на кнопке в шапке: последний выбор в этом браузере, иначе проект по умолчанию.
  const last = readLastChoice()?.project;
  const current = data.projects.some((p) => p.id === last && p.hidden === null) ? last : data.defaults.project;

  return (
    <Page className="flex flex-col gap-3.5">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-title font-semibold text-heading">{t('projects.list.title')}</h1>
          <p className="max-w-[46rem] text-[13px] leading-[18px] text-muted-foreground">{t('projects.list.lead')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {hidden.length > 0 && (
            <label className="flex items-center gap-2 text-[12.5px] text-foreground-2">
              <Switch checked={showHidden} onCheckedChange={setShowHidden} data-testid="show-hidden" />
              {t('projects.list.showHidden', { count: hidden.length })}
            </label>
          )}
          {data.editable && can('createProjects') && (
            <Button asChild>
              <Link to="/admin/projects/new">
                <Plus aria-hidden />
                {t('projects.list.add')}
              </Link>
            </Button>
          )}
        </div>
      </div>

      <SourceNotice settings={data} />
      {data.fallbackToFile && <Notice tone="danger">{t('projects.fallbackToFile')}</Notice>}
      {configured && <Notice>{t('projects.defaultMoved', { configured: `${configured.project}/${configured.environment}`, actual: `${data.defaults.project}/${data.defaults.environment}` })}</Notice>}
      {data.ignoredInFile.length > 0 && <Notice tone="warning">{t('projects.ignoredInFile', { list: data.ignoredInFile.join(', ') })}</Notice>}

      {rows.length === 0 ? (
        <Notice testId="projects-empty">{t('projects.list.empty')}</Notice>
      ) : (
        <Card className="min-w-0 overflow-hidden">
          <div aria-hidden className={cn(ROW, 'min-h-9 border-b border-border bg-sub text-[12px] leading-4 font-semibold text-muted-foreground')}>
            <span>{t('projects.list.colProject')}</span>
            <span>{t('projects.list.colId')}</span>
            <span>{t('projects.list.colEnvironments')}</span>
            <span className="max-lg:hidden">{t('projects.list.colFormat')}</span>
            <span className="max-lg:hidden">{t('projects.list.colRetention')}</span>
            <span />
          </div>
          <ul aria-label={t('projects.title')} data-testid="projects-list">
            {rows.map((p) => (
              <ProjectRow key={p.id} project={p} current={p.id === current} />
            ))}
          </ul>
        </Card>
      )}
    </Page>
  );
}

/** Знак проекта без логотипа: буквы названия на плашке, названия в строках стоят ровно. */
function Initials({ name }: { name: string }) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words.slice(0, 2).map((w) => Array.from(w)[0]) : Array.from(words[0] ?? '').slice(0, 2);
  return (
    <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-[7px] bg-sunk text-[10px] font-bold text-muted-foreground uppercase">
      {letters.join('')}
    </span>
  );
}

function ProjectRow({ project: p, current }: { project: ProjectSetting; current: boolean }) {
  const { t } = useTranslation();
  const envs = p.environments.map((e) => e.name).join(', ');
  const first = p.environments[0];
  const usable = !p.issues && p.hidden === null && first;
  const unusable = p.environments.some((e) => e.missingStore || e.outOfScope);
  const marks = p.fileState !== 'same' || p.hidden || p.issues || unusable;
  const extra = p.environments.length - SHOWN_ENVS;

  return (
    <li className="flex min-w-0 flex-col gap-1.5 border-b border-border py-2.5 last:border-b-0" data-testid="project-row" data-project={p.id}>
      <div className={cn(ROW, 'min-h-7 text-[13.5px] leading-[18px]')}>
        <div className="flex min-w-0 items-center gap-2.5">
          {p.logo ? <RowLogo logo={p.logo} /> : <Initials name={p.name} />}
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 truncate font-semibold text-foreground" title={p.name}>
                {p.name}
              </span>
              {current && p.hidden === null && <Chip className={cn(MARK, 'max-w-none')}>{t('projects.list.current')}</Chip>}
            </div>
            {marks && (
              <div className="flex min-w-0 flex-wrap items-center gap-1 [&>[data-slot=chip]]:h-auto [&>[data-slot=chip]]:min-h-5 [&>[data-slot=chip]]:shrink [&>[data-slot=chip]]:py-0.5 [&>[data-slot=chip]]:whitespace-normal">
                <FileMark state={p.fileState} />
                {p.hidden && <Chip>{t(`projects.hidden.${p.hidden}`)}</Chip>}
                {p.issues && <Chip tone="danger">{t('projects.list.invalid')}</Chip>}
                {unusable && <Chip tone="warning">{t('projects.list.notConfigured')}</Chip>}
              </div>
            )}
          </div>
        </div>
        <span className="min-w-0 truncate font-mono text-[12.5px] text-foreground-2" title={p.id}>
          {p.id}
        </span>
        <div className="flex min-w-0 flex-wrap items-center gap-1" title={envs}>
          {p.environments.slice(0, SHOWN_ENVS).map((e) => (
            <Chip key={e.id} className={cn(MARK, 'min-w-0')}>
              {(e.missingStore || e.outOfScope) && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warning" />}
              <span className="min-w-0 truncate">{e.name}</span>
            </Chip>
          ))}
          {extra > 0 && <Chip className={MARK}>+{extra}</Chip>}
        </div>
        <span className="min-w-0 truncate text-foreground-2 max-lg:hidden" title={p.format}>
          {p.format}
        </span>
        <span className="tabular text-foreground-2 max-lg:hidden">{t('projects.list.retention', { count: p.retentionDays })}</span>
        <div className="flex items-center justify-end gap-1.5">
          {usable && (
            <Button size="sm" variant="secondary" asChild>
              <Link to={envPath(p.id, first.id)}>
                <Search aria-hidden />
                {t('projects.list.search')}
              </Link>
            </Button>
          )}
          <Button size="sm" variant="ghost" asChild>
            <Link to={`/${encodeURIComponent(p.id)}/settings/main`} data-testid="project-edit">
              {t('projects.list.settings')}
            </Link>
          </Button>
        </div>
      </div>
      {p.issues && (
        <ul className="flex flex-col gap-0.5 px-5 text-[12px] leading-4 text-danger" data-testid="project-issues">
          {p.issues.map((i) => (
            <li key={i.path} className="break-words">
              <span className="font-mono">{i.path}</span>: {fieldText(i)}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
