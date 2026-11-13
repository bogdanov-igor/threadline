// Зона «Проект»: боковое меню и содержимое на обоих деревьях адресов, /:project/catalog/... и /:project/settings/....
import type { ProjectInfo } from '@threadline/core';
import { BookX, FileStack, MapPinOff, RotateCcw, Search, ServerCrash, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useMatch, useNavigate, useParams } from 'react-router';
import { PageSkeleton } from '@/components/states/PageSkeleton.tsx';
import { StateMessage } from '@/components/states/StateMessage.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Chip } from '@/components/ui/chip.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { Switch } from '@/components/ui/switch.tsx';
import { useProjectSettings } from '@/features/projects/queries.ts';
import { ProjectsSlot } from '@/features/projects/slot.tsx';
import { formatInt } from '@/lib/format.ts';
import { SEARCH_FIELD_ATTR } from '@/lib/hotkeys.ts';
import { readableDetails } from '@/lib/server-text.ts';
import { UnknownEnvironment } from '@/routes/UnknownPage.tsx';
import { useLayout } from '@/routes/Layout.tsx';
import type { CatalogResponse, SystemRow } from '@threadline/core/catalog';
import { MASK_KIND_CODES, type CatalogState } from '@threadline/core/search';
import { catalogErrorCode } from './api.ts';
import { ProjectFileProvider } from '@/features/project-file/provider.tsx';
import { EditorProvider, loadEditorSheet, useEditor } from './editor.tsx';
import { useCatalogWords } from './labels.ts';
import { catalogPath, hiddenCount, resolveSection, sectionParam, sections, type Section, type SectionId } from './model.ts';
import { useCatalog, useCatalogState } from './queries.ts';
import { IdsAddButton, IdsSection } from './sections/IdsSection.tsx';
import { MaskingAddField, MaskingProvider, MaskingSection } from './sections/MaskingSection.tsx';
import { SearchView } from './sections/SearchView.tsx';
import { SystemAddButton, SystemSection } from './sections/SystemSection.tsx';
import { UnknownSection } from './sections/UnknownSection.tsx';
import { EmptyList, Notice, ZONE_PAGE, ZoneHead } from './ui.tsx';
import { SETTINGS_PAGES, ZoneCompactMenu, ZoneSideMenu, zonePath, type ZoneKey } from './zone.tsx';

/** Что нужно зоне от проекта: скрытый проект приходит из настроек, а не из списка шапки. */
export type ZoneProject = Pick<ProjectInfo, 'id' | 'name' | 'timezone'> & { environments: readonly Pick<ProjectInfo['environments'][number], 'id' | 'name'>[] };

/** Поставщик текста файла проекта выше всех развилок зоны: сброс данных не снимает правки. Смену проекта ловит ключ. */
export function CatalogRoute() {
  const { project = '' } = useParams();
  return (
    <ProjectFileProvider key={project}>
      <ZoneRoute />
    </ProjectFileProvider>
  );
}

/** Неизвестный проект в справочнике — как неизвестная среда, настройки открываются и у скрытого проекта. */
function ZoneRoute() {
  const { t } = useTranslation();
  const { data } = useLayout();
  const { project = '', section } = useParams();
  const inSettings = useMatch('/:project/settings/:section?') !== null && section !== 'masks';
  const visible = data?.projects.find((x) => x.id === project);
  const settings = useProjectSettings(inSettings && !!data && !visible);
  const fromSettings = settings.data?.projects.find((x) => x.id === project);
  // Открытая форма не исчезает, когда проект скрыли или удалили другие: о его судьбе говорит сохранение.
  const opened = useRef<{ id: string; project: ZoneProject } | null>(null);
  const known: ZoneProject | undefined = visible ?? fromSettings ?? (inSettings && opened.current?.id === project ? opened.current.project : undefined);
  if (known) opened.current = { id: project, project: known };
  if (!data) return <PageSkeleton />;
  if (known) return <Zone key={project} project={known} full={!!visible} />;
  if (!inSettings) return <UnknownEnvironment />;
  if (settings.isPending) return <PageSkeleton />;
  if (settings.isError) {
    return (
      <StateMessage icon={ServerCrash} tone="danger" title={t('projects.loadFailed.title')} text={t('projects.loadFailed.text')}>
        <Button onClick={() => void settings.refetch()} disabled={settings.isFetching}>
          <RotateCcw className={settings.isFetching ? 'animate-spin' : undefined} aria-hidden />
          {t('states.retry')}
        </Button>
      </StateMessage>
    );
  }
  return (
    <StateMessage icon={MapPinOff} tone="warning" title={t('projects.form.notFound.title')} text={t('projects.form.notFound.text', { id: project })}>
      <Button asChild>
        <Link to="/admin/projects">{t('projects.form.toList')}</Link>
      </Button>
    </StateMessage>
  );
}

/** Правка открыта только при загруженном справочнике и доступной базе. */
export const canEdit = (s: CatalogState | undefined) => s?.state === 'ok';

export function CatalogPage({ project }: { project: ProjectInfo }) {
  return <Zone project={project} full />;
}

/** Боковое меню и содержимое. Страницы настроек лежат в чанке проектов, справочник здесь. */
function Zone({ project, full }: { project: ZoneProject; full: boolean }) {
  const { t } = useTranslation();
  const state = useCatalogState();
  const off = state.data?.state === 'off';
  const catalog = useCatalog(project.id, full && !!state.data && !off);
  const readOnly = !canEdit(state.data);
  const params = useParams();
  const inSettings = useMatch('/:project/settings/:section?') !== null;
  const settingsPage = inSettings && (SETTINGS_PAGES as readonly (string | undefined)[]).includes(params.section);
  const [hidden, setHidden] = useState(false);
  const [query, setQuery] = useState('');
  const snapshot = catalog.data;
  const list = useMemo(() => sections(snapshot, hidden), [snapshot, hidden]);
  const { section, notFound } = resolveSection(sectionParam(params), list);
  const unknownCount = state.data?.unknownOpen?.[project.id] || null;
  const current: ZoneKey = settingsPage ? `settings:${params.section!}` : section.id;
  const clearQuery = () => setQuery('');

  // На этой странице формы открывают постоянно: их чанк грузится сразу, панель открывается без задержки.
  useEffect(() => {
    if (!settingsPage) loadEditorSheet().catch(() => undefined);
  }, [settingsPage]);

  let body: ReactNode;
  if (state.isPending || (catalog.isPending && !off && !state.isError)) body = <CatalogSkeleton />;
  else if (off) {
    body = <StateMessage icon={BookX} title={t('catalog.off.title')} text={t('catalog.off.text')} />;
  } else if (!snapshot) {
    const code = catalogErrorCode(catalog.error ?? state.error);
    body = (
      <StateMessage icon={BookX} tone="warning" title={t('catalog.unavailable.title')} text={code === 'catalog-off' ? t('catalog.off.text') : (readableDetails(state.data?.message ?? undefined) ?? <span title={state.data?.message ?? undefined}>{t('catalog.unavailable.text')}</span>)}>
        <Button
          onClick={() => {
            void state.refetch();
            void catalog.refetch();
          }}
          disabled={catalog.isFetching}
        >
          <RotateCcw className={catalog.isFetching ? 'animate-spin' : undefined} aria-hidden />
          {t('states.retry')}
        </Button>
      </StateMessage>
    );
  } else {
    body = <CatalogContent project={project} snapshot={snapshot} state={state.data} readOnly={readOnly} section={section} notFound={notFound} hidden={hidden} setHidden={setHidden} query={query} setQuery={setQuery} />;
  }

  const menu = { project: project.id, current, searching: !settingsPage && query.trim() !== '', snapshot, loading: full && catalog.isPending && !off && !state.isError, hidden, unknownCount, full, onPick: clearQuery };
  return (
    <EditorProvider project={project.id} readOnly={readOnly}>
      <div className="flex min-h-[calc(100dvh-56px)] min-w-0 flex-col min-[1280px]:flex-row" data-testid="project-zone">
        <ZoneSideMenu {...menu} />
        <div className="flex min-w-0 flex-1 flex-col">
          <ZoneCompactMenu {...menu} />
          {settingsPage ? (
            <ProjectsSlot page="edit" />
          ) : (
            <div className={ZONE_PAGE} data-testid="catalog-page">
              {body}
            </div>
          )}
        </div>
      </div>
    </EditorProvider>
  );
}

/** Заготовка повторяет раздел: заголовок и таблица на тех же местах. */
function CatalogSkeleton() {
  return (
    <>
      <div className="flex h-11 items-start gap-4" aria-busy="true" data-testid="catalog-skeleton">
        <Skeleton className="h-7 w-44" />
        <span className="flex-1" />
        <Skeleton className="h-8 w-60 max-md:hidden" />
        <Skeleton className="h-8 w-24" />
      </div>
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-64 w-full" />
    </>
  );
}

/** Подпись под названием системы: вид, ключ и хосты в одну строку. */
function SystemSubtitle({ system }: { system: SystemRow }) {
  const { t } = useTranslation();
  const parts = [t(system.kind === 'project' ? 'catalog.systemKind.project' : 'catalog.systemKind.external'), ...(system.type !== 'service' ? [t(`catalog.systemType.${system.type}`)] : []), system.key, ...(system.hosts.length > 0 ? system.hosts : [t('catalog.noHosts')])];
  return <>{parts.join(' · ')}</>;
}

function CatalogContent({
  project,
  snapshot,
  state,
  readOnly,
  section,
  notFound,
  hidden,
  setHidden,
  query,
  setQuery,
}: {
  project: ZoneProject;
  snapshot: CatalogResponse;
  state: CatalogState | undefined;
  readOnly: boolean;
  section: Section;
  notFound: boolean;
  hidden: boolean;
  setHidden: (v: boolean) => void;
  query: string;
  setQuery: (v: string) => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { open, canEdit: canEditKind } = useEditor();
  const words = useCatalogWords();
  const unknownAvailable = state?.state === 'ok';
  const hiddenTotal = hiddenCount(snapshot);
  const go = (id: SectionId) => {
    setQuery('');
    void navigate(catalogPath(project.id, id));
  };
  const searching = query.trim() !== '';
  const system = section.kind === 'system' ? section.system : null;

  const hiddenSwitch = (
    <label className="flex shrink-0 items-center gap-2 text-[13px] text-foreground">
      <Switch checked={hidden} onCheckedChange={setHidden} data-testid="catalog-hidden-filter" />
      {t('catalog.hiddenFilter')}
      {hiddenTotal > 0 && <span className="tabular text-muted-foreground">{formatInt(hiddenTotal)}</span>}
    </label>
  );

  const add = searching || hidden ? null : section.kind === 'system' || section.kind === 'general' ? <SystemAddButton system={section.system} /> : section.kind === 'ids' ? <IdsAddButton /> : section.kind === 'masking' ? <MaskingAddField snapshot={snapshot} /> : null;

  // Заголовок один на все разделы: при вводе в поле поиска оно не монтируется заново и не теряет фокус.
  const subtitle =
    section.kind === 'unknown'
      ? t('catalog.unknown.intro')
      : section.kind === 'ids'
        ? t('catalog.ids.intro')
        : section.kind === 'general'
          ? t('catalog.zone.generalHint')
          : section.kind === 'masking'
            ? t('catalog.zone.masksHint', { count: MASK_KIND_CODES.length })
            : null;

  return (
    <MaskingProvider>
      <ZoneHead
        title={system ? system.name : words.sectionLabel(section.id, snapshot)}
        titleText={system ? system.name : words.sectionLabel(section.id, snapshot)}
        titleExtra={
          system && (
            <>
              {system.hidden && <Chip tone="warning">{t('catalog.hidden')}</Chip>}
              <Button size="sm" variant="ghost" className="shrink-0" onClick={() => open({ kind: 'system', id: system.id })} data-testid="system-edit">
                {canEditKind('system') ? t('catalog.edit') : t('catalog.open')}
              </Button>
            </>
          )
        }
        subtitle={system ? <SystemSubtitle system={system} /> : subtitle}
        {...(subtitle ? { subtitleText: subtitle } : {})}
        {...(system ? { testId: 'system-header' } : {})}
        actions={
          <>
            {section.kind !== 'masking' && (
              <div className="relative w-60 max-w-full min-w-0">
                <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('catalog.search.label')} title={t('catalog.search.placeholder')} aria-label={t('catalog.search.label')} className={query ? 'pr-9 pl-9' : 'pr-3 pl-9'} data-testid="catalog-search" {...{ [SEARCH_FIELD_ATTR]: '' }} />
                {query && (
                  <Button variant="ghost" size="icon" tabIndex={-1} className="absolute top-1/2 right-0.5 size-7 -translate-y-1/2 text-muted-foreground" aria-label={t('catalog.search.clear')} onClick={() => setQuery('')}>
                    <X aria-hidden />
                  </Button>
                )}
              </div>
            )}
            {section.kind !== 'masking' && (
              <Button asChild variant="secondary">
                <Link to={zonePath(project.id, 'settings:file')} data-testid="catalog-file-open">
                  <FileStack aria-hidden />
                  {t('catalog.zone.file')}
                </Link>
              </Button>
            )}
            {add}
          </>
        }
      />

      {system?.description && (
        <p className="-mt-2 line-clamp-2 text-[13px] leading-5 text-muted-foreground" title={system.description}>
          {system.description}
        </p>
      )}

      {state?.state === 'stale' || state?.state === 'error' ? (
        <Notice tone="warning" testId="catalog-readonly">
          {state.state === 'stale' ? (
            t('catalog.readOnly.stale')
          ) : readableDetails(state.message ?? '') === undefined ? (
            // Текст ошибки с адресом базы не переводится: на других языках он только в подсказке.
            <span title={state.message ?? undefined}>{t('catalog.readOnly.errorPlain')}</span>
          ) : (
            t('catalog.readOnly.error', { message: state.message ?? '' })
          )}
        </Notice>
      ) : null}
      {notFound && (
        <Notice tone="warning" testId="section-not-found">
          {t('catalog.sectionNotFound')}
        </Notice>
      )}

      {searching ? (
        <SearchView snapshot={snapshot} query={query} hidden={hidden} hiddenSwitch={hiddenSwitch} onClear={() => setQuery('')} onSection={go} />
      ) : section.kind === 'system' ? (
        section.system ? (
          <SystemSection snapshot={snapshot} system={section.system} hidden={hidden} zone={project.timezone} hiddenSwitch={hiddenSwitch} onUnknown={() => go('unknown')} />
        ) : (
          <EmptyList testId="no-author">{t('catalog.noAuthor')}</EmptyList>
        )
      ) : section.kind === 'general' ? (
        <SystemSection snapshot={snapshot} system={null} hidden={hidden} zone={project.timezone} hiddenSwitch={hiddenSwitch} onUnknown={() => go('unknown')} />
      ) : section.kind === 'ids' ? (
        <IdsSection snapshot={snapshot} hidden={hidden} zone={project.timezone} hiddenSwitch={hiddenSwitch} />
      ) : section.kind === 'masking' ? (
        <MaskingSection project={project.id} snapshot={snapshot} readOnly={readOnly} />
      ) : (
        <UnknownSection project={project} snapshot={snapshot} hidden={hidden} hiddenSwitch={hiddenSwitch} available={unknownAvailable} />
      )}
    </MaskingProvider>
  );
}
