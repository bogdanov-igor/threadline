import { AlertTriangle, Loader2, Search, Square } from 'lucide-react';
import { useId, type ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import { EnvControl, StandPicker, type ConnectionPanel } from '@/components/shell/EnvControl.tsx';
import { GUTTERS } from '@/components/shell/Page.tsx';
import { toneOf } from '@/components/shell/status.ts';
import { Button } from '@/components/ui/button.tsx';
import { useAccess } from '@/features/auth/access.tsx';
import { ExcludeFieldSlot, ExcludeToggleSlot } from '@/features/tools/slot.tsx';
import { useStandLive } from '@/lib/queries.ts';
import { selectionEnvs } from '@/lib/selection.ts';
import { readableDetails } from '@/lib/server-text.ts';
import { cn } from '@/lib/utils.ts';
import { PeriodControl } from './PeriodControl.tsx';
import { TermsField } from './TermsField.tsx';
import type { SearchController } from './useSearchController.ts';

/**
 * Строка поиска под шапкой. search-panel внутри полей страницы: линия снизу идёт на всю ширину, края содержимого совпадают с шапкой и таблицей.
 * Нижний отступ меньше верхнего: под полем уже есть строка подсказки.
 */
export function SearchBar({ className, children, ...props }: ComponentProps<'div'>) {
  return (
    <div className={cn('shrink-0 border-b border-border pt-3 pb-1.5', GUTTERS)}>
      <div className={className} {...props}>
        {children}
      </div>
    </div>
  );
}

/** Одна строка постоянной высоты под полем: ошибка значения или периода, отказ сервера, причина ошибки подключения, стенд не среди живых или подсказка. Раскладка не сдвигается. */
function PanelLine({ id, c, panel }: { id: string; c: SearchController; panel: ConnectionPanel }) {
  const { t } = useTranslation();
  const { project, env, stand } = c.selection;
  const live = useStandLive(project.id, env.id, stand);
  const err = c.error;
  const status = panel.state.status;
  // Несколько сред: строка называет среду, у которой худшее состояние.
  const worstName = c.selection.envs ? c.selection.envs.find((e) => e.id === panel.state.env)?.name : undefined;
  const tone = toneOf(status);
  // У not-configured уже есть полный блок.
  const problem =
    (tone === 'danger' || tone === 'warning') && status !== 'not-configured' && status !== 'checking'
      ? status
      : null;
  const line = 'truncate';
  const failure =
    err?.kind === 'term'
      ? t(`search.error.${err.code}`)
      : err?.kind === 'period'
        ? err.code === 'too-old'
          ? t('period.error.too-old', { count: project.retentionDays })
          : t(`period.error.${err.code}`)
        : err?.kind === 'server'
          ? `${t('search.error.server', { reason: err.title })}${readableDetails(err.details) ? ` (${err.details})` : ''}`
          : null;
  return (
    <div className="h-4 min-w-0 text-[12px] leading-4" aria-live="polite" data-testid="search-line">
      {failure ? (
        <p id={`${id}-error`} role="alert" className={cn(line, 'text-danger')} title={failure}>
          {failure}
        </p>
      ) : problem ? (
        <p
          id={`${id}-hint`}
          className={cn('flex min-w-0 gap-2', tone === 'danger' ? 'text-danger' : 'text-warning')}
        >
          <span className={line}>
            {worstName && `${worstName}: `}
            {t(`connection.status.${problem}.title`)}
          </span>
          <button
            type="button"
            className="relative shrink-0 font-medium underline underline-offset-2 before:absolute before:-inset-x-1 before:-inset-y-2"
            onClick={(e) => panel.openFrom(e.currentTarget)}
          >
            {t('search.connection.more')}
          </button>
        </p>
      ) : stand && live.data && !live.data.live ? (
        <p
          id={`${id}-hint`}
          className={cn(line, 'text-warning')}
          title={t('stands.notLive', { number: stand })}
        >
          {t('stands.notLive', { number: stand })}
        </p>
      ) : (
        <p id={`${id}-hint`} className={cn(line, 'text-muted-foreground')} title={t('search.field.hint')}>
          {t('search.field.hint')}
        </p>
      )}
    </div>
  );
}

/** Одна кнопка на месте «Найти»: пока идёт этот же поиск, она «Стоп»; изменили значения — снова «Найти», и новый поиск остановит прежний. Обе подписи занимают одну ячейку: ширина постоянная. */
function FindButton({ c, disabled }: { c: SearchController; disabled: boolean }) {
  const { t } = useTranslation();
  const stop = c.canStop;
  const cell = 'col-start-1 row-start-1 inline-flex items-center justify-center gap-1.5';
  return (
    <Button
      type={stop ? 'button' : 'submit'}
      variant={stop ? 'secondary' : 'default'}
      disabled={stop ? c.stopping : c.starting || disabled}
      // Второе нажатие двойного щелчка по «Найти» не должно остановить только что запущенный поиск.
      onClick={stop ? (e) => e.detail < 2 && c.stop() : undefined}
      // Рамка есть у обеих: иначе смена варианта прибавила бы ширине 2px.
      className={cn('grid shrink-0 grid-cols-1', !stop && 'border border-transparent')}
    >
      <span className={cn(cell, stop && 'invisible')}>
        {c.starting ? <Loader2 className="animate-spin" aria-hidden /> : <Search aria-hidden />}
        {t('search.find')}
      </span>
      <span className={cn(cell, !stop && 'invisible')}>
        <Square className="size-3.5 fill-current" aria-hidden />
        {t('search.stop')}
      </span>
    </Button>
  );
}

export function SearchPanel({
  c,
  panel,
  onEnvOutOfView,
}: {
  c: SearchController;
  panel: ConnectionPanel;
  onEnvOutOfView: (hidden: boolean) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const { project, env, stand } = c.selection;
  // Несколько сред: поле закрыто, только если не настроена ни одна. Ненастроенная среда набора станет частью с ошибкой.
  const notConfigured = selectionEnvs(c.selection).every((e) => e.notConfigured);
  const details = useAccess().can('details');
  const err = c.error;
  const termError = err?.kind === 'term' ? err : null;
  const lineError = termError || err?.kind === 'period' || err?.kind === 'server';

  return (
    <SearchBar data-testid="search-panel">
      <form
        role="search"
        aria-label={t('search.title')}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void c.run();
        }}
        className="flex flex-col gap-2"
      >
        {/* От 1280px выбор среды, поле, период и кнопка одной строкой; уже — выбор среды и поле сверху, под ними период и кнопка.
            items-start оставляет их у верха, когда поле занимает несколько строк. */}
        <div className="flex flex-col gap-2 xl:flex-row xl:items-start xl:gap-2.5">
          <div className="flex min-w-0 flex-1 items-start gap-2.5">
            <EnvControl selection={c.selection} panel={panel} onOutOfView={onEnvOutOfView} />
            {stand && <StandPicker selection={{ ...c.selection, stand }} />}
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <TermsField
                id={`${id}-terms`}
                chips={c.chips}
                onChipsChange={c.setChips}
                text={c.text}
                onTextChange={c.setText}
                onInputError={(code) => c.setError(code ? { kind: 'term', code } : null)}
                onSubmit={() => void c.run()}
                invalid={!!termError}
                invalidChipId={termError?.chipId}
                describedBy={lineError ? `${id}-error` : `${id}-hint`}
                disabled={notConfigured}
                inputRef={c.inputRef}
                hotkeyTarget
                extras
              />
              <div className="flex min-w-0 items-start gap-3">
                <div className="min-w-0 flex-1">
                  <PanelLine id={id} c={c} panel={panel} />
                </div>
                <ExcludeToggleSlot c={c} />
              </div>
              {c.refineOpen && (
                <div className="mt-1.5 mb-1">
                  <ExcludeFieldSlot c={c} id={`${id}-excludes`} disabled={notConfigured} />
                </div>
              )}
            </div>
          </div>
          <div className="flex items-start justify-between gap-2.5">
            <PeriodControl
              value={c.period}
              onChange={(p) => {
                c.setPeriod(p);
                if (err?.kind === 'period') c.setError(null);
              }}
              timeZone={project.timezone}
              retentionDays={project.retentionDays}
              disabled={notConfigured}
              triggerRef={c.periodRef}
            />
            <FindButton c={c} disabled={notConfigured} />
          </div>
        </div>

        {notConfigured && (
          <div
            className="mb-1.5 flex items-start gap-3 rounded-[var(--radius-control)] bg-warning-bg px-3 py-2 text-[13px] text-warning"
            data-testid="search-not-configured"
          >
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <p>
              <span className="font-semibold">{t('search.notConfigured')}</span>{' '}
              {details ? t('connection.status.not-configured.text', { name: env.missingEnv ?? '' }) : t('connection.status.not-configured.closed')}
            </p>
          </div>
        )}
      </form>
    </SearchBar>
  );
}
