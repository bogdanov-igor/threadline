// Пункт «Вид» зоны проекта: шесть частей настройки вида, своё сохранение и своя метка версии.
// Настройка не защищает данные: об этом постоянная строка и ссылка на маскирование.
import type { ProjectSetting } from '@threadline/core';
import { DEFAULT_VIEW, LIST_COLUMNS, OPTIONAL_TABS, REQUEST_TABS, REQUIRED_COLUMNS, sameView, tabOffEverywhere, VIEW_BLOCKS, type BodyView, type ListColumn, type RequestTab, type Shown, type ViewBlock, type ViewMode, type ViewSettings } from '@threadline/core/view';
import { Loader2, RotateCcw } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button.tsx';
import { Card } from '@/components/ui/card.tsx';
import { Segmented } from '@/components/ui/segmented.tsx';
import { Switch } from '@/components/ui/switch.tsx';
import { Tooltip } from '@/components/ui/tooltip.tsx';
import { Field, Notice, SelectField, UnsavedMark, ZoneFooter, ZoneHead } from '@/features/catalog/ui.tsx';
import { isAccessDenied } from '@/lib/api.ts';
import { fieldTexts, ProjectApiError, projectErrorCode } from './api.ts';
import { useSaveView } from './queries.ts';

type Problem = { kind: 'conflict'; fresh: ProjectSetting | undefined } | { kind: 'forbidden' } | { kind: 'gone' } | { kind: 'unavailable' } | { kind: 'invalid'; fields: Record<string, string> } | { kind: 'failed'; code: string };

const MODES: readonly ViewMode[] = ['full', 'brief'];
const ROW = 'grid grid-cols-[minmax(0,1fr)_72px_72px] items-center gap-x-2 px-5 sm:grid-cols-[minmax(0,1fr)_120px_120px]';

/** Строка таблицы: подпись и два переключателя. Недоступный — с подсказкой, почему. */
function ShownRow({ label, shown, locked, onChange, testId, readOnly }: { label: string; shown: Shown; locked?: Partial<Record<ViewMode, string>>; onChange?: (mode: ViewMode, on: boolean) => void; testId: string; readOnly: boolean }) {
  const { t } = useTranslation();
  return (
    <div className={`${ROW} min-h-10 border-b border-border last:border-b-0`}>
      <span className="min-w-0 py-1.5 text-[13.5px] leading-5 break-words text-foreground">{label}</span>
      {MODES.map((m) => {
        const why = locked?.[m];
        const control = (
          <Switch
            checked={shown[m]}
            disabled={readOnly || !!why}
            onCheckedChange={(on) => onChange?.(m, on)}
            aria-label={`${label}: ${t(`projects.view.mode.${m}`)}`}
            data-testid={`${testId}-${m}`}
          />
        );
        return (
          <span key={m} className="flex items-center">
            {why ? (
              <Tooltip content={why}>
                <span tabIndex={0} className="inline-flex rounded-full" data-testid={`${testId}-${m}-why`} aria-label={why}>
                  {control}
                </span>
              </Tooltip>
            ) : (
              control
            )}
          </span>
        );
      })}
    </div>
  );
}

/** Часть таблицы: шапка с подписями режимов и строки. */
function ShownTable({ title, testId, children }: { title: string; testId: string; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div data-testid={testId} className="border-b border-border last:border-b-0">
      <div className={`${ROW} min-h-[34px] border-b border-border bg-sub text-[12px] font-semibold text-muted-foreground`}>
        <span className="min-w-0 truncate" title={title}>
          {title}
        </span>
        {MODES.map((m) => (
          <span key={m} className="truncate">
            {t(`projects.view.mode.${m}`)}
          </span>
        ))}
      </div>
      {children}
    </div>
  );
}

export function ViewSection({ project, readOnly, onDirty, notices }: { project: ProjectSetting; readOnly: boolean; onDirty: (dirty: boolean) => void; notices?: ReactNode }) {
  const { t } = useTranslation();
  const save = useSaveView();
  const [base, setBase] = useState({ view: project.view, updatedAt: project.viewUpdatedAt, issues: project.viewIssues });
  const [form, setForm] = useState<ViewSettings>(project.view);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [moved, setMoved] = useState(false);

  const dirty = !sameView(form, base.view);
  const canSave = !readOnly && (dirty || base.issues.length > 0) && !save.isPending;

  useEffect(() => onDirty(dirty), [dirty, onDirty]);

  // Пока правок нет, вкладка следует за свежей записью: иначе чужое сохранение давало бы конфликт при первой же правке.
  const freshStamp = project.viewUpdatedAt;
  useEffect(() => {
    if (dirty || freshStamp === base.updatedAt) return;
    setBase({ view: project.view, updatedAt: freshStamp, issues: project.viewIssues });
    setForm(project.view);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- следует только за меткой
  }, [freshStamp]);

  /** sent: какой форма ушла на сервер. Отметка, изменённая после отправки, остаётся и считается несохранённой: форма сравнивается с новой записью. */
  const apply = (fresh: ProjectSetting, sent?: ViewSettings) => {
    setBase({ view: fresh.view, updatedAt: fresh.viewUpdatedAt, issues: fresh.viewIssues });
    setForm((now) => (sent && !sameView(now, sent) ? now : fresh.view));
    setProblem(null);
    setMoved(false);
  };

  // Двойное нажатие: второе приходит раньше, чем кнопка стала занятой.
  const sending = useRef(false);
  const submit = () => {
    if (!canSave || sending.current) return;
    sending.current = true;
    setProblem(null);
    // Форма, равная встроенной, уходит как null: запись очищается.
    save.mutate(
      { id: project.id, view: sameView(form, DEFAULT_VIEW) ? null : form, updatedAt: base.updatedAt },
      {
        onSuccess: (fresh) => {
          if (fresh) apply(fresh, form);
        },
        onError: (e) => {
          const code = projectErrorCode(e);
          if (isAccessDenied(e)) setProblem({ kind: 'forbidden' });
          else if (code === 'project-conflict') setProblem({ kind: 'conflict', fresh: e instanceof ProjectApiError ? e.current : undefined });
          else if (code === 'project-not-found') setProblem({ kind: 'gone' });
          else if (code === 'project-readonly' || code === 'server-unreachable') setProblem({ kind: 'unavailable' });
          else if (code === 'project-invalid' && e instanceof ProjectApiError) setProblem({ kind: 'invalid', fields: fieldTexts(e) });
          else setProblem({ kind: 'failed', code: code ?? 'unknown' });
        },
        onSettled: () => {
          sending.current = false;
        },
      },
    );
  };

  const setColumn = (c: ListColumn, mode: ViewMode, on: boolean) => setForm((f) => ({ ...f, columns: { ...f.columns, [c]: { ...f.columns[c], [mode]: on } } }));
  const setBlock = (b: ViewBlock, mode: ViewMode, on: boolean) => setForm((f) => ({ ...f, blocks: { ...f.blocks, [b]: { ...f.blocks[b], [mode]: on } } }));
  const setTab = (tab: (typeof OPTIONAL_TABS)[number], mode: ViewMode, on: boolean) => {
    const next = { ...form, tabs: { ...form.tabs, [tab]: { ...form.tabs[tab], [mode]: on } } };
    // Вкладка по умолчанию не может быть выключена в обоих режимах: выбор уходит на шкалу, рядом с полем об этом сказано.
    if (tabOffEverywhere(next, next.defaultTab)) {
      setMoved(true);
      setForm({ ...next, defaultTab: 'timeline' });
    } else setForm(next);
  };

  const issueText = (i: ProjectSetting['viewIssues'][number]) => t(`projects.view.issue.${i.code}`, { value: i.value ?? '', field: i.field });

  return (
    <form
      noValidate
      className="flex min-w-0 flex-1 flex-col gap-4"
      data-testid="view-section"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <ZoneHead
        title={t('projects.tabs.view')}
        subtitle={t('projects.zone.viewHint')}
        actions={
          !readOnly && (
            <Button
              type="button"
              variant="ghost"
              disabled={save.isPending}
              onClick={() => {
                setMoved(false);
                setForm(structuredClone(DEFAULT_VIEW));
              }}
              data-testid="view-reset"
            >
              <RotateCcw aria-hidden />
              {t('projects.view.reset')}
            </Button>
          )
        }
      />
      {notices}

      {base.issues.length > 0 && (
        <Notice tone="warning" testId="view-issues">
          <ul className="flex flex-col gap-0.5">
            {base.issues.map((i, n) => (
              <li key={n} className="break-words">
                {issueText(i)}
              </li>
            ))}
          </ul>
        </Notice>
      )}

      <div className="grid min-w-0 items-start gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-3">
          <Card className="flex min-w-0 flex-col gap-2.5 px-5 py-4">
            <h2 className="text-section font-semibold text-heading">{t('projects.view.defaultMode')}</h2>
            <fieldset disabled={readOnly} className="flex min-w-0 disabled:opacity-60">
              <Segmented
                label={t('projects.view.defaultMode')}
                value={form.defaultMode}
                data-testid="view-default-mode"
                onChange={(defaultMode) => setForm((f) => ({ ...f, defaultMode }))}
                options={MODES.map((m) => ({ value: m, label: t(`projects.view.mode.${m}`), testId: `view-default-mode-${m}` }))}
              />
            </fieldset>
            <p className="text-[12.5px] leading-[18px] text-muted-foreground">{t('projects.view.defaultModeHint')}</p>
          </Card>
          <Card className="flex min-w-0 flex-col gap-2.5 px-5 py-4">
            <h2 className="text-section font-semibold text-heading">{t('projects.view.bodyView')}</h2>
            <fieldset disabled={readOnly} className="flex min-w-0 disabled:opacity-60">
              <Segmented<BodyView>
                label={t('projects.view.bodyView')}
                value={form.bodyView}
                data-testid="view-body-view"
                onChange={(bodyView) => setForm((f) => ({ ...f, bodyView }))}
                options={[
                  { value: 'pretty', label: t('projects.view.body.pretty'), testId: 'view-body-pretty' },
                  { value: 'raw', label: t('projects.view.body.raw'), testId: 'view-body-raw' },
                ]}
              />
            </fieldset>
            <p className="text-[12.5px] leading-[18px] text-muted-foreground">{t('projects.view.bodyViewHint')}</p>
          </Card>
          <Card className="flex min-w-0 flex-col gap-2.5 px-5 py-4">
            <Field label={t('projects.view.defaultTab')} hint={moved ? t('projects.view.defaultTabMoved') : ' '}>
              {(c) => (
                <SelectField<RequestTab>
                  control={{ ...c, disabled: readOnly }}
                  value={form.defaultTab}
                  onChange={(defaultTab) => {
                    setMoved(false);
                    setForm((f) => ({ ...f, defaultTab }));
                  }}
                  options={REQUEST_TABS.map((x) => ({ value: x, label: t(`projects.view.tab.${x}`), disabled: tabOffEverywhere(form, x) }))}
                />
              )}
            </Field>
          </Card>
          <Notice tone="warning" testId="view-boundary">
            {t('projects.view.boundary')}{' '}
            <Link to={`/${encodeURIComponent(project.id)}/settings/masks`} className="font-medium underline" data-testid="view-to-masking">
              {t('projects.view.toMasking')}
            </Link>
          </Notice>
        </div>

        <Card className="min-w-0 overflow-hidden">
          <ShownTable title={t('projects.view.columns')} testId="view-columns">
            <p className="border-b border-border px-5 py-2 text-[12.5px] leading-[18px] text-muted-foreground" data-testid="view-status-always">
              {t('projects.view.statusAlways')}
            </p>
            {LIST_COLUMNS.map((c) => (
              <ShownRow
                key={c}
                label={t(`projects.view.column.${c}`)}
                shown={form.columns[c]}
                readOnly={readOnly}
                testId={`view-column-${c}`}
                onChange={(m, on) => setColumn(c, m, on)}
                {...(REQUIRED_COLUMNS.includes(c) ? { locked: { full: t('projects.view.requiredColumn'), brief: t('projects.view.requiredColumn') } } : {})}
              />
            ))}
          </ShownTable>
          <ShownTable title={t('projects.view.tabsTitle')} testId="view-tabs">
            <ShownRow label={t('projects.view.tab.scheme')} shown={form.tabs.scheme} readOnly={readOnly} testId="view-tab-scheme" onChange={(m, on) => setTab('scheme', m, on)} />
            <ShownRow label={t('projects.view.tab.timeline')} shown={{ full: true, brief: true }} readOnly={readOnly} testId="view-tab-timeline" locked={{ full: t('projects.view.timelineAlways'), brief: t('projects.view.timelineAlways') }} />
            <ShownRow label={t('projects.view.tab.records')} shown={form.tabs.records} readOnly={readOnly} testId="view-tab-records" onChange={(m, on) => setTab('records', m, on)} />
          </ShownTable>
          <ShownTable title={t('projects.view.blocksTitle')} testId="view-blocks">
            {VIEW_BLOCKS.map((b) => (
              <ShownRow
                key={b}
                label={t(`projects.view.block.${b}`)}
                shown={form.blocks[b]}
                readOnly={readOnly}
                testId={`view-block-${b}`}
                onChange={(m, on) => setBlock(b, m, on)}
                {...(b === 'raw' ? { locked: { full: t('projects.view.rawRequired') } } : {})}
              />
            ))}
          </ShownTable>
        </Card>
      </div>

      {!readOnly && (
        <ZoneFooter>
          {problem ? <ProblemText problem={problem} onReload={apply} /> : dirty && <UnsavedMark text={t('projects.zone.unsaved')} />}
          <span className="flex-1" />
          {/* Главная кнопка первая в разметке: Tab идёт на неё, на экране она справа. */}
          <Button type="submit" disabled={!canSave} className="order-last" data-testid="view-save">
            {save.isPending && <Loader2 className="animate-spin" aria-hidden />}
            {t('projects.view.save')}
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={!dirty || save.isPending}
            onClick={() => {
              setForm(base.view);
              setMoved(false);
              setProblem(null);
            }}
            data-testid="view-cancel"
          >
            {t('projects.zone.cancel')}
          </Button>
        </ZoneFooter>
      )}
    </form>
  );
}

/** Сообщение в подвале: место занято заранее, раскладка не сдвигается, выбранное на месте. */
function ProblemText({ problem, onReload }: { problem: Problem; onReload: (fresh: ProjectSetting) => void }) {
  const { t } = useTranslation();
  const cls = 'flex min-w-0 flex-wrap items-center gap-x-2 text-[13px] text-danger';
  if (problem.kind === 'conflict') {
    const fresh = problem.fresh;
    return (
      <span role="alert" className={cls} data-testid="view-problem" data-kind="conflict">
        {t('projects.view.problem.conflict')}
        {fresh && (
          <Button type="button" size="sm" variant="secondary" onClick={() => onReload(fresh)} data-testid="view-reload">
            {t('projects.view.problem.reload')}
          </Button>
        )}
      </span>
    );
  }
  if (problem.kind === 'gone') {
    return (
      <span role="alert" className={cls} data-testid="view-problem" data-kind="gone">
        {t('projects.view.problem.gone')}
        <Button size="sm" variant="secondary" asChild>
          <Link to="/admin/projects">{t('projects.view.problem.toList')}</Link>
        </Button>
      </span>
    );
  }
  const text = problem.kind === 'forbidden' ? t('projects.view.problem.forbidden') : problem.kind === 'unavailable' ? t('projects.view.problem.unavailable') : problem.kind === 'invalid' ? Object.entries(problem.fields).map(([k, v]) => `${k}: ${v}`).join('; ') : t('projects.view.problem.failed', { code: problem.code });
  return (
    <span role="alert" className={cls} data-testid="view-problem" data-kind={problem.kind}>
      {text}
    </span>
  );
}
