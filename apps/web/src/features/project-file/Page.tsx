// Страница файла проекта: текст, подсветка, проверка на лету, отчёт, применение. Логика в controller.ts, здесь только показ.
import { Download, FileJson, FileUp, Loader2, RotateCcw, Search, ServerCrash, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { MAX_FILE_BYTES } from '@threadline/core/catalog';
import { StateMessage } from '@/components/states/StateMessage.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Segmented } from '@/components/ui/segmented.tsx';
import { Switch } from '@/components/ui/switch.tsx';
import { useAccess } from '@/features/auth/access.tsx';
import { useSessionProblem } from '@/features/auth/session.ts';
import { SCHEMA_URL } from '@/features/catalog/api.ts';
import { diffModel } from '@/features/catalog/import-report.ts';
import { afterCatalogChange, useCatalogState } from '@/features/catalog/queries.ts';
import { Notice, UnsavedMark, ZONE_PAGE, ZoneFooter, ZoneHead } from '@/features/catalog/ui.tsx';
import { afterProjectChange } from '@/features/projects/queries.ts';
import { isSaveKeys } from '@/lib/hotkeys.ts';
import { FileController, type CheckState, type FileUi, type LoadProblem, type Problem } from './controller.ts';
import { useFileSession } from './provider.tsx';
import { ReportPanel } from './ReportPanel.tsx';
import { FileSkeleton } from './slot.tsx';

const MB = 1024 * 1024;
const megabytes = (bytes: number) => (bytes / MB).toFixed(1);

function usePhrases() {
  const { t } = useTranslation();
  return () => ({
    label: t('project-file.editorLabel'),
    phrases: {
      Find: t('project-file.search.find'),
      Replace: t('project-file.search.replace'),
      next: t('project-file.search.next'),
      previous: t('project-file.search.previous'),
      all: t('project-file.search.all'),
      'match case': t('project-file.search.matchCase'),
      regexp: t('project-file.search.regexp'),
      'by word': t('project-file.search.byWord'),
      replace: t('project-file.search.replaceOne'),
      'replace all': t('project-file.search.replaceAll'),
      close: t('project-file.search.close'),
      'current match': t('project-file.search.currentMatch'),
      'on line': t('project-file.search.onLine'),
      'Go to line': t('project-file.search.goToLine'),
      go: t('project-file.search.go'),
      syntaxMark: t('project-file.syntax.mark'),
    },
  });
}

function useController(project: string): FileController {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const phrases = usePhrases();
  const session = useFileSession();
  const local = useRef<FileController | null>(null);
  // Подписи и вопросы читаются при вызове: контроллер переживает смену языка, а ссылки ниже всегда свежие.
  const live = useRef({ phrases, t });
  live.current = { phrases, t };
  const create = () =>
    new FileController({
      project,
      phrases: () => live.current.phrases(),
      confirm: (q) => window.confirm(looseT(live.current.t)(`project-file.confirm.${q}`)),
      onApplied: () => {
        void afterCatalogChange(qc, project);
        afterProjectChange(qc, project);
      },
    });
  if (session) return session.controller(create);
  return (local.current ??= create());
}

/** Ключи здесь выбираются по значению, а типы ключей с такой таблицей не справляются (TS2589). Наличие ключей сверяет тест языков. */
type Loose = (key: string, options?: object) => string;
const looseT = (t: unknown) => t as Loose;

const loadText = (t: unknown, reason: LoadProblem, code = ''): string => looseT(t)(`project-file.load.${reason}`, { code });

function problemText(raw: unknown, p: Problem): string {
  const t = looseT(raw);
  const max = MAX_FILE_BYTES / MB;
  const reason = (r: LoadProblem | 'blocked') => (r === 'blocked' ? t('project-file.load.blockedShort') : loadText(raw, r));
  switch (p.kind) {
    case 'format-broken':
      return p.line === null ? t('project-file.problem.formatBrokenNoLine') : t('project-file.problem.formatBroken', { line: p.line });
    case 'format-too-large':
      return t('project-file.problem.formatTooLarge', { max });
    case 'format-failed':
      return t('project-file.problem.formatFailed', { reason: reason(p.reason) });
    case 'fresh-failed':
      return t('project-file.problem.freshFailed', { reason: reason(p.reason) });
    case 'file-type':
      return t('project-file.problem.fileType');
    case 'file-too-big':
      return t('project-file.problem.fileTooBig', { max });
    case 'file-encoding':
      return t('project-file.problem.fileEncoding');
    case 'over-limit':
      return t('project-file.problem.overLimit');
    case 'apply-failed':
      return p.reason === 'too-large' ? t('project-file.problem.fileTooBig', { max }) : t('project-file.problem.applyFailed', { reason: loadText(raw, p.reason, p.code) });
  }
}

function CheckLine({ ui }: { ui: FileUi }) {
  const { t } = useTranslation();
  if (ui.check === 'idle') return null;
  const shown = looseT(t)(`project-file.check.${ui.check satisfies CheckState}`);
  const bad = ui.check !== 'waiting' && ui.check !== 'running' && ui.check !== 'done';
  return (
    <span className={bad ? 'flex min-w-0 items-center gap-1.5 text-[12.5px] text-warning' : 'flex min-w-0 items-center gap-1.5 text-[12.5px] text-muted-foreground'} aria-live="polite" data-testid="file-check-state" data-state={ui.check}>
      {ui.check === 'running' && <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />}
      <span className="min-w-0 truncate" title={shown}>
        {shown}
      </span>
    </span>
  );
}

function Blocked({ ui, project, upload }: { ui: FileUi; project: string; upload: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className={ZONE_PAGE} data-testid="project-file">
      <ZoneHead title={t('catalog.zone.file')} actions={upload} />
      <Notice tone="danger" testId="export-problem">
        <p>{t('project-file.load.blocked')}</p>
        <ul className="mt-1 list-inside list-disc text-[12.5px]">
          {ui.blockedFields.map(([path, message]) => (
            <li key={path}>
              <code className="font-mono">{path || '—'}</code>: {message}
            </li>
          ))}
        </ul>
        <p className="mt-1">{t('project-file.load.blockedHelp', { project })}</p>
      </Notice>
      {ui.problem && <Notice tone="danger" testId="import-problem">{problemText(t, ui.problem)}</Notice>}
    </div>
  );
}

export default function ProjectFilePage({ project, editable, notices }: { project: string; editable: boolean; notices: ReactNode }) {
  const { t, i18n } = useTranslation();
  const { can } = useAccess();
  const session = useFileSession();
  const state = useCatalogState();
  const controller = useController(project);
  const ui = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const canEdit = can('importCatalog');
  const open = editable && (state.data === undefined || state.data.state === 'ok');
  const phrases = usePhrases();
  const phrasesNow = useRef(phrases);
  phrasesNow.current = phrases;
  const host = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const sessionProblem = useSessionProblem();
  const hadExpired = useRef(false);

  useEffect(() => {
    session?.pageShown();
    return () => session?.pageGone();
  }, [session]);

  useEffect(() => controller.setCapabilities(canEdit, open), [controller, canEdit, open]);

  useEffect(() => {
    controller.start();
  }, [controller]);

  // Вид создаётся, когда текст уже есть, а снимается вместе со страницей: состояние остаётся в контроллере.
  const ready = ui.status === 'ready';
  useEffect(() => {
    if (!ready || !host.current) return undefined;
    controller.attach(host.current);
    return () => controller.detach();
  }, [controller, ready]);

  useEffect(() => {
    const { phrases: dict, label } = phrasesNow.current();
    controller.setPhrases(dict, label);
    // Смена языка меняет подписи, текст, курсор и история на месте.
  }, [controller, i18n.language]);

  useEffect(() => {
    const onChange = () => {
      if (document.visibilityState === 'visible') void controller.onVisible();
    };
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, [controller]);

  // После входа в новой вкладке окно закрывается: проверка идёт снова.
  useEffect(() => {
    if (sessionProblem === 'expired') hadExpired.current = true;
    else if (hadExpired.current && sessionProblem === 'none') {
      hadExpired.current = false;
      controller.recheck();
    }
  }, [controller, sessionProblem]);

  const uploadControls = canEdit && open && (
    <>
      <input
        ref={input}
        type="file"
        accept=".yaml,.yml,.json,application/json,application/yaml,text/yaml"
        className="sr-only"
        tabIndex={-1}
        aria-label={t('project-file.upload')}
        data-testid="import-input"
        onChange={(e) => {
          const f = e.target.files?.[0];
          // Тот же файл можно выбрать ещё раз: он читается заново.
          e.target.value = '';
          if (f) void controller.pickFile(f);
        }}
      />
      <Button variant="secondary" disabled={ui.applying} onClick={() => input.current?.click()} data-testid="file-upload">
        <FileUp aria-hidden />
        {t('project-file.upload')}
      </Button>
    </>
  );

  if (ui.status === 'loading') return <FileSkeleton />;
  if (ui.status === 'failed') {
    const problem = ui.loadProblem ?? 'failed';
    return (
      <div className={ZONE_PAGE} data-testid="project-file-failed">
        <StateMessage icon={ServerCrash} tone="danger" title={t('project-file.load.title')} text={loadText(t, problem, ui.loadCode ?? '')}>
          <Button onClick={() => void controller.retryLoad()} data-testid="file-load-retry">
            <RotateCcw aria-hidden />
            {t('states.retry')}
          </Button>
        </StateMessage>
      </div>
    );
  }
  if (ui.status === 'blocked') return <Blocked ui={ui} project={project} upload={uploadControls} />;

  const report = ui.report;
  const model = report && canEdit ? diffModel(report) : null;
  const canApply = !!model && model.canApply && ui.reportFresh && !ui.conflict && !ui.tooLarge && !ui.syntax && !ui.applying && open;
  const showReport = canEdit && open;
  return (
    <div
      className={ZONE_PAGE}
      data-testid="project-file"
      // Ctrl+Enter как у кнопки «Применить», раньше CodeMirror: иначе он вставил бы пустую строку. Кнопки нет, значит и применять нечего.
      onKeyDownCapture={(e) => {
        if (!canEdit || !open || !isSaveKeys(e)) return;
        e.preventDefault();
        e.stopPropagation();
        if (canApply) void controller.apply();
      }}
    >
      <ZoneHead
        title={t('catalog.zone.file')}
        subtitle={t('project-file.subtitle')}
        subtitleText={t('project-file.subtitle')}
        actions={
          <>
            <Segmented
              label={t('project-file.format')}
              value={ui.format}
              options={[
                { value: 'yaml', label: 'YAML', testId: 'format-yaml' },
                { value: 'json', label: 'JSON', testId: 'format-json' },
              ]}
              onChange={(f) => void controller.setFormat(f)}
              data-testid="file-format"
            />
            <Button variant="ghost" size="icon" aria-label={t('project-file.searchButton')} title={t('project-file.searchButton')} onClick={() => controller.openSearch()} data-testid="file-search">
              <Search aria-hidden />
            </Button>
            <Button variant="secondary" onClick={() => controller.download()} data-testid="file-download">
              <Download aria-hidden />
              {t('project-file.download')}
            </Button>
            {uploadControls}
            <Button asChild variant="ghost" className="text-primary">
              <a href={SCHEMA_URL} target="_blank" rel="noreferrer" data-testid="file-schema">
                <FileJson aria-hidden />
                {t('catalog.file.schema')}
              </a>
            </Button>
          </>
        }
      />
      {notices}
      {!canEdit && <Notice testId="file-read-only">{t('project-file.readOnlyRole')}</Notice>}
      {canEdit && !open && <Notice tone="warning" testId="file-read-only">{t('project-file.readOnlyClosed')}</Notice>}
      <Notice testId="file-removal-note">{t('project-file.removal')}</Notice>
      {ui.refreshed && <Notice testId="file-refreshed">{t('project-file.refreshed')}</Notice>}
      {ui.conflict && (
        <Notice
          tone="warning"
          testId="file-conflict"
          actions={
            <>
              <Button size="sm" variant="secondary" onClick={() => void controller.loadFresh()} data-testid="file-fresh">
                {t('project-file.conflict.fresh')}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => controller.keepMine()} data-testid="file-keep">
                {t('project-file.conflict.keep')}
              </Button>
            </>
          }
        >
          <p className="font-medium">{t('project-file.conflict.title')}</p>
          <p className="text-[12.5px]">{t('project-file.conflict.help')}</p>
        </Notice>
      )}
      {ui.tooLarge && (
        <Notice tone="warning" testId="file-too-large">
          {t('project-file.tooLarge', { size: megabytes(ui.bytes), max: MAX_FILE_BYTES / MB })}
        </Notice>
      )}
      {ui.syntax && (
        <Notice tone="danger" icon={TriangleAlert} testId="file-syntax">
          {ui.syntax.line === null ? t('project-file.syntax.noPosition') : t('project-file.syntax.at', { line: ui.syntax.line, col: ui.syntax.col ?? 1 })}
        </Notice>
      )}
      {ui.problem && <Notice tone="danger" testId="import-problem">{problemText(t, ui.problem)}</Notice>}
      {ui.appliedNoText && (
        <Notice
          tone="warning"
          testId="file-no-fresh"
          actions={
            <Button size="sm" variant="secondary" onClick={() => controller.retryAfterApply()} data-testid="file-fresh-retry">
              <RotateCcw aria-hidden />
              {t('states.retry')}
            </Button>
          }
        >
          {t('project-file.appliedNoText')}
        </Notice>
      )}

      <div className={showReport ? 'grid min-w-0 flex-1 gap-4 min-[1280px]:grid-cols-[minmax(0,1fr)_minmax(320px,380px)]' : 'grid min-w-0 flex-1 gap-4'}>
        <div ref={host} className="h-[calc(100dvh-300px)] min-h-[420px] min-w-0 overflow-hidden rounded-[10px] border border-border focus-within:border-ring" data-testid="file-editor" />
        {showReport && (
          <aside className="min-w-0 overflow-y-auto min-[1280px]:h-[calc(100dvh-300px)] min-[1280px]:min-h-[420px]" aria-label={t('project-file.reportLabel')}>
            <ReportPanel project={project} report={report} fresh={ui.reportFresh} force={ui.force} hasComments={ui.hasComments} locations={ui.locations} applied={ui.applied} onJump={(p) => controller.jumpTo(p)} />
          </aside>
        )}
      </div>

      {canEdit && open && (
        <ZoneFooter testId="file-footer">
          {ui.dirty ? <UnsavedMark text={t('project-file.unsaved')} /> : <span className="text-[12.5px] text-muted-foreground">{t('project-file.clean')}</span>}
          <CheckLine ui={ui} />
          <span className="flex-1" />
          {(ui.check === 'timeout' || ui.check === 'unavailable' || ui.check === 'unreachable') && (
            <Button variant="ghost" onClick={() => controller.recheck()} data-testid="file-recheck">
              {t('catalog.file.recheck')}
            </Button>
          )}
          <label className="flex min-w-0 items-center gap-2 text-[13px] text-foreground" title={t('catalog.file.forceHint')}>
            <Switch id="import-force" checked={ui.force} disabled={ui.applying} onCheckedChange={(v) => controller.setForce(v)} />
            <span className="min-w-0">{t('catalog.file.force')}</span>
          </label>
          {canApply && model && (
            <Button disabled={ui.applying} onClick={() => void controller.apply()} data-testid="import-apply">
              {ui.applying && <Loader2 className="animate-spin" aria-hidden />}
              {t('catalog.file.apply', { count: model.changes })}
            </Button>
          )}
          {ui.applying && !canApply && (
            <span className="flex items-center gap-2 text-[13px] text-muted-foreground" data-testid="file-applying">
              <Loader2 className="size-4 animate-spin" aria-hidden />
              {t('project-file.applying')}
            </span>
          )}
        </ZoneFooter>
      )}
    </div>
  );
}
