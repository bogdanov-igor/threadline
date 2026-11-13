// Раздел «Неизвестное»: что сервис не узнал, по убыванию счётчика; фильтры вида и среды, страницы по 100.
import { Eye, EyeOff, ExternalLink, Plus, RotateCcw } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { Button } from '@/components/ui/button.tsx';
import { Chip } from '@/components/ui/chip.tsx';
import { Segmented } from '@/components/ui/segmented.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { isAccessDenied } from '@/lib/api.ts';
import { formatInt, shortDateTime } from '@/lib/format.ts';
import { requestPath } from '@/lib/selection.ts';
import type { CatalogResponse, UnknownKind, UnknownRow } from '@threadline/core/catalog';
import { catalogErrorCode } from '../api.ts';
import type { ZoneProject } from '../CatalogPage.tsx';
import { useEditor } from '../editor.tsx';
import { unknownTarget } from '../prefill.ts';
import { useHideUnknown, useUnknown, type UnknownFilter } from '../queries.ts';
import { Cell, EmptyList, Notice, SelectField, TableRow, ZoneTable } from '../ui.tsx';

const KINDS: (UnknownKind | 'all')[] = ['all', 'method', 'host', 'error'];
const ALL_ENVS = '*';
/** Окно ссылки на пример: запрос читается вокруг момента примера. */
const EXAMPLE_WINDOW_MS = 60_000;

// Что встретилось, система, вид, счётчик, среда, действия. На планшете система и среда второй строкой, подпись кнопки уходит.
const GRID = 'grid-cols-[minmax(0,1fr)_84px_120px_136px] lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1.2fr)_84px_136px_minmax(0,0.6fr)_208px]';

/** Ссылка на запрос-пример строки «Неизвестного». */
export function unknownExamplePath(project: string, u: Pick<UnknownRow, 'env' | 'stand' | 'exampleCid' | 'exampleMs'>): string {
  return requestPath(project, u.env, u.stand ?? undefined, u.exampleCid, u.exampleMs - EXAMPLE_WINDOW_MS, u.exampleMs + EXAMPLE_WINDOW_MS);
}

export function UnknownSection({ project, snapshot, hidden, hiddenSwitch, available }: { project: ZoneProject; snapshot: CatalogResponse; hidden: boolean; hiddenSwitch: ReactNode; available: boolean }) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<UnknownKind | 'all'>('all');
  const [env, setEnv] = useState<string>(ALL_ENVS);
  const filter: UnknownFilter = { kind, env: env === ALL_ENVS ? '' : env, hidden };
  const list = useUnknown(project.id, filter, available);
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  const total = list.data?.pages[0]?.total ?? null;
  const unavailable = !available || ['catalog-unavailable', 'server-unreachable'].includes(catalogErrorCode(list.error) ?? '');
  // Неудача «Скрыть» и «Вернуть» — над списком: строка сама ничего не показывает.
  const [hideFailed, setHideFailed] = useState<string | null>(null);

  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="catalog-section" data-section="unknown">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <Segmented label={t('catalog.unknown.kind')} value={kind} onChange={setKind} options={KINDS.map((x) => ({ value: x, label: t(`catalog.unknown.filter.${x}`), testId: `unknown-kind-${x}` }))} />
        <SelectField ariaLabel={t('catalog.unknown.env')} className="h-8 w-44" value={env} onChange={setEnv} options={[{ value: ALL_ENVS, label: t('catalog.unknown.allEnvs') }, ...project.environments.map((e) => ({ value: e.id, label: e.name }))]} />
        <span className="flex-1" />
        {hiddenSwitch}
      </div>
      {hideFailed && (
        <Notice tone="danger" testId="unknown-hide-failed">
          {hideFailed === 'catalog-unavailable' ? t('catalog.unknown.hideUnavailable') : hideFailed === 'forbidden' ? t('catalog.unknown.hideForbidden') : t('catalog.unknown.hideFailed', { code: hideFailed })}
        </Notice>
      )}
      {unavailable ? (
        <Notice tone="warning" testId="unknown-unavailable">
          {t('catalog.unknown.unavailable')}
        </Notice>
      ) : list.isError ? (
        <Notice
          tone="danger"
          actions={
            <Button size="sm" variant="secondary" onClick={() => void list.refetch()}>
              <RotateCcw aria-hidden />
              {t('states.retry')}
            </Button>
          }
        >
          {t('catalog.unknown.failed')}
        </Notice>
      ) : list.isPending ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <EmptyList testId="unknown-empty">{hidden ? t('catalog.empty.hidden') : kind !== 'all' || env !== ALL_ENVS ? t('catalog.unknown.emptyFiltered') : t('catalog.unknown.empty')}</EmptyList>
      ) : (
        <>
          <ZoneTable
            label={t('catalog.section.unknown')}
            grid={GRID}
            testId="unknown-list"
            head={
              <>
                <span>{t('catalog.col.seen')}</span>
                <span className="max-lg:hidden">{t('catalog.col.system')}</span>
                <span>{t('catalog.col.kind')}</span>
                <span>{t('catalog.col.countLast')}</span>
                <span className="max-lg:hidden">{t('catalog.unknown.env')}</span>
                <span />
              </>
            }
          >
            {rows.map((u) => (
              <UnknownItem key={u.id} project={project} snapshot={snapshot} u={u} onHideResult={setHideFailed} />
            ))}
          </ZoneTable>
          <div className="flex items-center justify-between gap-3 text-[12.5px] text-muted-foreground">
            <span className="tabular">{total !== null ? t('catalog.unknown.shown', { shown: formatInt(rows.length), total: formatInt(total) }) : null}</span>
            {list.hasNextPage && (
              <Button size="sm" variant="secondary" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()} data-testid="unknown-more">
                {t('catalog.unknown.more')}
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function UnknownItem({ project, snapshot, u, onHideResult }: { project: ZoneProject; snapshot: CatalogResponse; u: UnknownRow; onHideResult: (code: string | null) => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { open, canEdit } = useEditor();
  // Строку правит та же роль, что и записи её вида: поддержка работает только с ошибками.
  const editable = canEdit(u.kind);
  const hide = useHideUnknown(project.id);
  const system = u.systemId !== null ? snapshot.systems.find((x) => x.id === u.systemId) : undefined;
  const envName = project.environments.find((e) => e.id === u.env)?.name ?? u.env;
  const code = [u.httpStatus !== null ? `HTTP ${u.httpStatus}` : null, u.code !== null ? t('catalog.unknown.code', { code: u.code }) : null].filter(Boolean).join(' · ');
  const title = u.kind === 'host' ? (u.host ?? '—') : u.kind === 'method' ? [u.httpMethod, `${u.path ?? ''}${u.rpc ? ` · ${u.rpc}` : ''}`].filter(Boolean).join(' ') : [code, u.text].filter(Boolean).join(' · ') || '—';
  const systemName = system?.name ?? (u.kind === 'host' ? '—' : t('catalog.unknown.noSystem'));
  const last = shortDateTime(Date.parse(u.lastSeen), project.timezone);
  const example = unknownExamplePath(project.id, u);
  const hideLabel = u.hidden ? t('catalog.unknown.unhide') : t('catalog.unknown.hide');
  return (
    <TableRow
      grid={GRID}
      testId="unknown-row"
      data={{ kind: u.kind, count: u.count }}
      muted={u.hidden}
      onOpen={() => (editable ? open(unknownTarget(u)) : navigate(example))}
      actions={
        <>
          <Button variant="ghost" size="icon" className="size-7" aria-label={t('catalog.unknown.openExample')} title={t('catalog.unknown.openExample')} onClick={() => void navigate(example)} data-testid="unknown-example">
            <ExternalLink aria-hidden />
          </Button>
          {editable && (
            <>
              <Button variant="ghost" size="icon" className="size-7" aria-label={hideLabel} title={hideLabel} onClick={() => hide.mutate({ row: u, hidden: !u.hidden }, { onSuccess: () => onHideResult(null), onError: (e) => onHideResult(isAccessDenied(e) ? 'forbidden' : (catalogErrorCode(e) ?? 'unknown')) })} data-testid="unknown-hide">
                {u.hidden ? <Eye aria-hidden /> : <EyeOff aria-hidden />}
              </Button>
              <Button variant="secondary" size="sm" aria-label={t('catalog.addToCatalog')} title={t('catalog.addToCatalog')} onClick={() => open(unknownTarget(u))} data-testid="unknown-add">
                <Plus aria-hidden />
                <span className="max-lg:hidden">{t('catalog.unknown.add')}</span>
              </Button>
            </>
          )}
        </>
      }
    >
      <span className="block min-w-0">
        <Cell text={title} className="font-mono text-[12.5px]" testId="row-title" />
        <Cell text={`${systemName} · ${envName}`} className="text-[12px] leading-4 text-muted-foreground lg:hidden" />
      </span>
      <Cell text={systemName} className="text-foreground-2 max-lg:hidden" />
      <Chip className="justify-self-start">{t(`catalog.unknown.kinds.${u.kind}`)}</Chip>
      <span className="tabular block min-w-0 truncate text-[12.5px] text-muted-foreground" title={t('catalog.unknown.countHint', { count: u.count })}>
        <b className="text-[13.5px] font-semibold text-foreground" data-testid="unknown-count">
          {formatInt(u.count)}
        </b>{' '}
        · {last}
      </span>
      <Cell text={envName} className="text-foreground-2 max-lg:hidden" />
    </TableRow>
  );
}
