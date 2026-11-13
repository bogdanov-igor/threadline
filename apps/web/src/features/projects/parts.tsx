// Общие части страниц проектов: причина закрытой правки, отметки файла, логотип в строке, результат проверки подключения.
import { formatDateTime, type ProbeResponse, type ProjectFileState, type ProjectSetting, type ProjectSettingsResponse } from '@threadline/core';
import { Loader2, PlugZap } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { connectionText } from '@/components/shell/status.ts';
import { Button } from '@/components/ui/button.tsx';
import { Chip, type ChipTone } from '@/components/ui/chip.tsx';
import { Notice } from '@/features/catalog/ui.tsx';
import { useLocalMode } from '@/features/local/slot.tsx';
import { isAccessDenied } from '@/lib/api.ts';
import { fieldTexts, ProjectApiError } from './api.ts';
import { useProbe, type ProbeRequest } from './queries.ts';

/** Почему правка закрыта. Без базы, база ещё не подключилась, ошибка, база пропала: у каждого свой текст. */
export function SourceNotice({ settings }: { settings: ProjectSettingsResponse }) {
  const { t } = useTranslation();
  const { state, message, loadedAt } = settings;
  if (state === 'ok') return null;
  const zone = settings.projects[0]?.timezone ?? 'UTC';
  const time = loadedAt !== null ? formatDateTime(loadedAt, zone) : '';
  return (
    <Notice tone={state === 'off' ? 'neutral' : 'warning'} testId="projects-source">
      {state === 'off' && t('projects.source.off')}
      {state === 'connecting' && t('projects.source.connecting', { message: message ?? '' })}
      {state === 'error' && t('projects.source.error', { message: message ?? '' })}
      {state === 'stale' && t('projects.source.stale', { time, message: message ?? '' })}
    </Notice>
  );
}

/** Как добавить хранилище в список сред: на сервере это делает администратор в файле настроек, в локальном режиме — страница хранилищ. */
export function NewStoreHint() {
  const { t } = useTranslation();
  const local = useLocalMode();
  return (
    <p className="text-[12.5px] leading-[18px] text-muted-foreground">
      {local ? (
        <>
          {t('projects.stores.newLocal')}{' '}
          <Link to="/admin/storages" className="font-medium text-primary underline underline-offset-2" data-testid="projects-storages-link">
            {t('projects.stores.newLocalLink')}
          </Link>
        </>
      ) : (
        t('projects.stores.newGrafana')
      )}
    </p>
  );
}

const FILE_TONE: Record<Exclude<ProjectFileState, 'same'>, ChipTone> = { none: 'neutral', here: 'neutral', 'file-newer': 'warning', removed: 'warning' };

export function FileMark({ state }: { state: ProjectFileState }) {
  const { t } = useTranslation();
  if (state === 'same') return null;
  return (
    <Chip tone={FILE_TONE[state]} data-testid="file-mark" data-state={state}>
      {t(`projects.fileState.${state}`)}
    </Chip>
  );
}

/** Логотип в строке: место занято по пропорции до загрузки, смена темы ничего не двигает. */
export function RowLogo({ logo }: { logo: NonNullable<ProjectSetting['logo']> }) {
  const style = { height: 20, width: Math.min(Math.max(20, 20 * logo.ratio), 96) };
  return (
    <span className="shrink-0" style={style}>
      <img src={logo.light} alt="" width={style.width} height={20} className="h-full w-full object-contain dark:hidden" />
      <img src={logo.dark} alt="" width={style.width} height={20} className="hidden h-full w-full object-contain dark:block" />
    </span>
  );
}

function ProbeResult({ data, error, onField }: { data: ProbeResponse | null; error: unknown; onField?: boolean }) {
  const { t } = useTranslation();
  if (error) {
    const fields = error instanceof ProjectApiError ? Object.values(fieldTexts(error)) : [];
    return <p className="text-danger" data-testid="probe-result" data-status="invalid">{isAccessDenied(error) ? t('projects.problem.forbidden') : (fields[0] ?? t('projects.probe.failed'))}</p>;
  }
  if (!data) return onField ? null : <p className="text-muted-foreground">{t('projects.probe.hint')}</p>;
  const name = data.missingEnv ?? '';
  const ok = data.status === 'connected' || data.status === 'demo';
  return (
    <div data-testid="probe-result" data-status={data.status} className="min-w-0">
      <p className={ok ? 'font-medium text-foreground' : 'font-medium text-warning'}>{t(`connection.status.${data.status}.title`)}</p>
      <p className="text-muted-foreground">
        {data.status === 'connected' && data.hasRecords === true && t('projects.probe.records')}
        {data.status === 'connected' && data.hasRecords === false && t('projects.probe.noRecords')}
        {data.status === 'connected' && data.stands && t('projects.probe.stands', { list: data.stands.join(', ') || '—' })}
        {data.status !== 'connected' && connectionText(t, { ...data, missingEnv: name })}
        {data.retryAfterSeconds !== undefined && <> {t('connection.retryIn', { seconds: data.retryAfterSeconds })}</>}
      </p>
      {data.labelNames && data.labelNames.length > 0 && (
        <details>
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">{t('projects.probe.labels')}</summary>
          <p className="break-words font-mono text-[12px] leading-[18px]">{data.labelNames.join(', ')}</p>
        </details>
      )}
      {data.details && (
        <details>
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">{t('connection.details')}</summary>
          <p className="break-words font-mono text-[12px] leading-[18px]">{data.details}</p>
        </details>
      )}
    </div>
  );
}

/** «Проверить подключение»: запрос только по нажатию, уход со страницы его отменяет. Результат занимает своё место и форму не сдвигает. */
export function ProbeControl({ request }: { request: () => ProbeRequest }) {
  const { t } = useTranslation();
  const probe = useProbe();
  return (
    <div className="flex min-h-[66px] min-w-0 flex-col gap-2 text-[13px] leading-5 sm:flex-row sm:items-start sm:gap-3">
      <Button type="button" variant="secondary" size="sm" disabled={probe.pending} onClick={() => void probe.run(request())} data-testid="probe-button">
        {probe.pending ? <Loader2 className="animate-spin" aria-hidden /> : <PlugZap aria-hidden />}
        {t('projects.probe.action')}
      </Button>
      <div aria-live="polite" className="min-w-0 flex-1 pt-1.5">
        <ProbeResult data={probe.data} error={probe.error} onField />
      </div>
    </div>
  );
}
