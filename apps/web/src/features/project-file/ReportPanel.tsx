// Отчёт проверки: группы, ошибки с переходом к строке, подсказки. Группы пришли из боковой панели; показ ограничен: по 200 строк на группу.
import { CheckCircle2 } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import type { ImportItem, ImportReport } from '@threadline/core/catalog';
import { diffModel, type DiffGroup } from '@/features/catalog/import-report.ts';
import { Notice } from '@/features/catalog/ui.tsx';
import { formatInt } from '@/lib/format.ts';
import type { Applied } from './controller.ts';
import type { Location } from './syntax.ts';

const LIMIT = 200;

function Group({ group }: { group: DiffGroup }) {
  const { t } = useTranslation();
  let left = LIMIT;
  const rows = group.byKind.flatMap((k) => {
    const items = k.items.slice(0, Math.max(0, left));
    left -= items.length;
    return items.map((x) => ({ kind: k.kind, x }));
  });
  const more = group.count - rows.length;
  return (
    <section className="flex flex-col gap-1.5" data-testid={`import-${group.key}`}>
      <h3 className="text-[12.5px] font-semibold text-foreground">
        {t(`catalog.file.group.${group.key}`)} <span className="tabular font-normal text-muted-foreground">{formatInt(group.count)}</span>
      </h3>
      <ul className="flex flex-col gap-0.5 text-[12.5px] leading-5">
        {rows.map(({ kind, x }, i) => (
          <li key={`${kind}-${x.key}-${i}`} className="flex min-w-0 flex-col" data-kind={kind}>
            <span className="flex min-w-0 gap-2">
              <span className="w-24 shrink-0 text-muted-foreground">{t(`catalog.kind.${kind}`)}</span>
              <span className="min-w-0 truncate text-foreground" title={x.key}>
                {x.title}
                {x.fields.length > 0 && <span className="text-muted-foreground"> · {x.fields.join(', ')}</span>}
              </span>
            </span>
            {x.stopsSearches && <span className="pl-[6.5rem] text-[12px] leading-4 text-warning">{t('project-file.report.stopsSearches')}</span>}
          </li>
        ))}
      </ul>
      {more > 0 && <p className="text-[12px] text-muted-foreground">{t('project-file.report.more', { count: formatInt(more) })}</p>}
    </section>
  );
}

const names = (list: readonly ImportItem[]) => list.slice(0, LIMIT).map((x) => x.title || x.key);

export function ReportPanel({
  project,
  report,
  fresh,
  force,
  hasComments,
  locations,
  applied,
  onJump,
}: {
  project: string;
  report: ImportReport | null;
  fresh: boolean;
  force: boolean;
  hasComments: boolean;
  locations: Readonly<Record<string, Location>>;
  applied: Applied | null;
  onJump: (path: string) => void;
}) {
  const { t, i18n } = useTranslation();
  // Подписи строк зависят от языка: смена языка пересобирает отчёт, а текст и курсор не трогает.
  const language = i18n.language;
  const model = useMemo(() => {
    void language;
    return report ? diffModel(report) : null;
  }, [report, language]);
  return (
    <div className="flex flex-col gap-3" data-testid="import-report" data-fresh={fresh || undefined}>
      {applied && (
        <Notice tone="neutral" icon={CheckCircle2} testId="import-applied">
          {t('catalog.file.applied', { count: applied.count })}
        </Notice>
      )}
      {applied && (applied.skipped.length > 0 || applied.undeleted.length > 0) && (
        <Notice tone="warning" testId="file-not-applied">
          <p>{t('project-file.report.notApplied')}</p>
          <ul className="mt-1 list-inside list-disc text-[12.5px]">
            {names([...applied.skipped, ...applied.undeleted]).map((n, i) => (
              <li key={`${n}-${i}`}>{n}</li>
            ))}
          </ul>
        </Notice>
      )}
      {!model && !applied && <p className="text-[12.5px] leading-5 text-muted-foreground">{t('project-file.report.empty')}</p>}
      {model && (
        <>
          {!fresh && (
            <p className="text-[12.5px] font-medium text-warning" data-testid="report-stale">
              {t('project-file.report.stale')}
            </p>
          )}
          {model.errors.length > 0 ? (
            <Notice tone="danger">{t('catalog.file.hasErrors', { count: model.errors.length })}</Notice>
          ) : model.changes === 0 ? (
            <Notice tone="neutral" testId="file-nothing">
              <p>{t('catalog.file.nothing')}</p>
              {hasComments && <p>{t('project-file.report.onlyComments')}</p>}
              <p className="text-[12.5px] text-muted-foreground">{t('project-file.report.orderNotKept')}</p>
              {model.missing > 0 && <p className="text-[12.5px] text-muted-foreground">{t('project-file.report.missingStay')}</p>}
            </Notice>
          ) : (
            <Notice tone="neutral">{t('catalog.file.willChange', { count: model.changes })}</Notice>
          )}

          {model.errors.length > 0 && (
            <ul className="flex flex-col gap-1 rounded-[10px] border border-danger/25 bg-danger-bg px-3 py-2 text-[12.5px] leading-5" data-testid="import-errors">
              {model.errors.slice(0, LIMIT).map((e, i) => (
                <li key={i} className="min-w-0 break-words">
                  {locations[e.path] ? (
                    <button type="button" className="text-left font-mono text-danger underline-offset-2 hover:underline" onClick={() => onJump(e.path)} data-testid="error-jump">
                      {e.path || t('catalog.file.root')}
                    </button>
                  ) : (
                    <code className="font-mono text-danger">{e.path || t('catalog.file.root')}</code>
                  )}
                  <span className="text-foreground"> — {e.message}</span>
                </li>
              ))}
              {model.errors.length > LIMIT && <li className="text-muted-foreground">{t('project-file.report.more', { count: formatInt(model.errors.length - LIMIT) })}</li>}
            </ul>
          )}

          {model.warnings.length > 0 && (
            <div className="flex flex-col gap-1 rounded-[10px] border border-warning/30 bg-warning-bg px-3 py-2 text-[12.5px] leading-5" data-testid="import-warnings">
              <p>{t('project-file.report.warnings')}</p>
              <ul className="flex flex-col gap-1">
                {model.warnings.slice(0, LIMIT).map((w, i) => (
                  <li key={i} className="min-w-0 break-words">
                    {locations[w.path] ? (
                      <button type="button" className="text-left font-mono text-warning underline-offset-2 hover:underline" onClick={() => onJump(w.path)} data-testid="warning-jump">
                        {w.path || t('catalog.file.root')}
                      </button>
                    ) : (
                      <code className="font-mono text-warning">{w.path || t('catalog.file.root')}</code>
                    )}
                    <span className="text-foreground"> — {w.message}</span>
                  </li>
                ))}
                {model.warnings.length > LIMIT && <li className="text-muted-foreground">{t('project-file.report.more', { count: formatInt(model.warnings.length - LIMIT) })}</li>}
              </ul>
            </div>
          )}

          {model.disables.map((name) => (
            <Notice key={name} tone="warning" testId="import-masking-off">
              {t('catalog.masking.fileDisables', { name })}
            </Notice>
          ))}
          {hasComments && model.errors.length === 0 && model.changes > 0 && (
            <Notice tone="warning" testId="file-comments">
              {t('project-file.report.comments')}
            </Notice>
          )}
          {model.groups.map((g) => (
            <Group key={g.key} group={g} />
          ))}
          <p className="tabular text-[12.5px] text-muted-foreground" data-testid="file-counts">
            {t('catalog.file.unchanged', { count: model.unchanged })} · {t('catalog.file.missing', { count: model.missing })}
          </p>
          {model.errors.length === 0 && report!.added.length > 0 && model.missing > 0 && <p className="text-[12.5px] leading-5 text-muted-foreground" data-testid="hint-key-change">{t('project-file.report.keyChange')}</p>}
          {model.missingEnvironments > 0 && (
            <p className="text-[12.5px] leading-5 text-muted-foreground" data-testid="hint-env-removal">
              {t('project-file.report.envRemoval')}{' '}
              <Link className="text-primary underline-offset-2 hover:underline" to={`/${encodeURIComponent(project)}/settings/environments`}>
                {t('catalog.zone.environments')}
              </Link>
            </p>
          )}
          {model.forceWouldHelp && !force && <p className="text-[12.5px] leading-5 text-muted-foreground">{t('catalog.file.skippedHint')}</p>}
          {model.undeleted > 0 && !force && <p className="text-[12.5px] leading-5 text-muted-foreground" data-testid="import-undeleted-hint">{t('catalog.file.undeletedHint')}</p>}
        </>
      )}
    </div>
  );
}
