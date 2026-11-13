import { formatDateTime, timeZoneOffsetLabel, type ConnectionResponse } from '@threadline/core';
import { RefreshCw } from 'lucide-react';
import { useEffect, useRef, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button.tsx';
import { Tooltip } from '@/components/ui/tooltip.tsx';
import { useAccess } from '@/features/auth/access.tsx';
import { cn } from '@/lib/utils.ts';
import { connectionText, TONE_CLASSES, toneOf, type IndicatorStatus } from './status.ts';

export interface ConnectionDetailsProps {
  status: IndicatorStatus;
  data: ConnectionResponse | undefined;
  timeZone: string;
  onRecheck: () => void;
  rechecking: boolean;
}

export const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** Точка состояния: тот же размер, что у строк списка, поэтому колонки совпадают. */
export function StatusDot({ status }: { status: IndicatorStatus }) {
  const { dot } = TONE_CLASSES[toneOf(status)];
  return (
    <span className="relative flex size-2 shrink-0" aria-hidden>
      {status === 'checking' && <span className={cn('absolute inline-flex size-full animate-ping rounded-full opacity-60', dot)} />}
      <span className={cn('relative inline-flex size-2 rounded-full', dot)} />
    </span>
  );
}

/** Проверка сегодня: только часы и минуты. Другой день: дата целиком, тогда слово «проверено» уже лишнее и строка помещается в ширину меню. */
export function checkedToday(at: number, timeZone: string, now: number): boolean {
  return formatDateTime(at, timeZone).split(' ')[0] === formatDateTime(now, timeZone).split(' ')[0];
}

const hoursMinutes = (at: number, timeZone: string) => formatDateTime(at, timeZone).slice(0, 16);

/** Время проверки. Секунды и пояс в подсказке, с клавиатуры и для диктора тоже: подчёркивание и секунды в строке только мешали. */
function CheckedTime({ iso, timeZone, note, word = false }: { iso: string; timeZone: string; note?: string; word?: boolean }) {
  const { t } = useTranslation();
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  const full = `${t('connection.checkedAt')} ${formatDateTime(at, timeZone)}, ${t('time.zone', { zone: timeZone, offset: timeZoneOffsetLabel(timeZone, new Date(at)) })}`;
  const today = checkedToday(at, timeZone, Date.now());
  const shown = hoursMinutes(at, timeZone);
  return (
    <>
      {word && today && <span aria-hidden>{lowerFirst(t('connection.checkedAt'))} </span>}
      <Tooltip
        content={
          <>
            {note && <span className="block">{note}</span>}
            {full}
          </>
        }
      >
        <time dateTime={iso} tabIndex={0} aria-label={full} className="tabular rounded-[4px] whitespace-nowrap">
          {today ? shown.slice(-5) : shown}
        </time>
      </Tooltip>
    </>
  );
}

const FAILURE = { warning: 'bg-warning-bg text-warning', danger: 'bg-danger-bg text-danger' };

/**
 * Нижняя часть меню среды. Всё в порядке: одна тихая строка в колонках строк списка. Что-то не так: цветной блок с причиной словами и кнопкой со словом, он и должен бросаться в глаза.
 * Демо не ошибка, но без пояснения про синтетические записи её не понять. Строка пояснения стоит под той же строкой.
 */
export function ConnectionDetails({ status, data, timeZone, onRecheck, rechecking, envName }: ConnectionDetailsProps & { /** Несколько сред: чья проверка показана. */ envName?: string | undefined }) {
  const { t } = useTranslation();
  const access = useAccess();
  // Та же проверка, что у маршрута /connection. Страницу среды без неё не открыть, поэтому сейчас кнопку видят все, кто видит меню.
  const mayCheck = access.can('view');
  // Пока идёт повторная проверка, вид прежний: блок с причиной не схлопывается под указателем.
  const shown: IndicatorStatus = rechecking && data ? data.status : status;
  const tone = toneOf(shown);
  const quiet = tone !== 'warning' && tone !== 'danger';
  // Бизнес настройку не правит и имён из неё не получает: текст о файле настроек ему ни о чём.
  const closed = !access.can('details') && (shown === 'not-configured' || shown === 'not-found');

  // Кнопка на время проверки выключена, а при смене вида меняется: фокус не должен упасть на страницу.
  const button = useRef<HTMLButtonElement>(null);
  const pressed = useRef(false);
  useEffect(() => {
    if (rechecking || !pressed.current) return;
    pressed.current = false;
    button.current?.focus();
  }, [rechecking]);
  const recheck = (e: MouseEvent) => {
    // detail 0: нажатие с клавиатуры. После мыши фокус возвращать незачем, зажглось бы кольцо.
    pressed.current = e.detail === 0;
    onRecheck();
  };
  const busy = rechecking || status === 'checking';

  return (
    <div aria-live="polite">
      {quiet ? (
        <>
          <div className="flex min-h-9 items-center gap-2.5 py-1 pr-[3px] pl-2.5 text-[12px] leading-4 text-muted-foreground" data-testid="connection-line">
            <StatusDot status={busy ? 'checking' : shown} />
            <span className="min-w-0 flex-1">
              {busy || shown === 'checking' ? (
                t('connection.checking')
              ) : (
                <>
                  {envName && `${envName} · `}
                  {t(`connection.status.${shown as 'connected' | 'demo'}.title`)}
                  {data?.checkedAt && (
                    <>
                      {' · '}
                      <CheckedTime word iso={data.checkedAt} timeZone={timeZone} note={shown === 'connected' ? connectionText(t, { status: 'connected', backend: data.backend }) : undefined} />
                    </>
                  )}
                </>
              )}
            </span>
            {mayCheck && (
              <Tooltip content={t('connection.recheck')}>
                <Button ref={button} variant="ghost" size="icon" className="size-7 text-muted-foreground" aria-label={t('connection.recheck')} onClick={recheck} disabled={busy}>
                  <RefreshCw className={cn('size-3.5', rechecking && 'animate-spin')} aria-hidden />
                </Button>
              </Tooltip>
            )}
          </div>
          {shown === 'demo' && <p className="pr-2.5 pb-2 pl-7 text-[12px] leading-4 text-muted-foreground">{t('connection.status.demo.text')}</p>}
        </>
      ) : (
        <div data-testid="connection-problem" className={cn('flex flex-col gap-1 rounded-[8px] px-2.5 py-2', FAILURE[tone])}>
          <h3 className="flex items-center gap-2.5 text-[13px] leading-5 font-semibold">
            <StatusDot status={shown} />
            <span className="min-w-0">
              {envName && `${envName}: `}
              {t(`connection.status.${shown as Exclude<IndicatorStatus, 'checking'>}.title`)}
            </span>
          </h3>
          <div className="flex flex-col gap-2 pl-[18px]">
            <p className="text-[12px] leading-4 text-foreground-2">
              {closed ? t('connection.status.not-configured.closed') : connectionText(t, { status: shown as Exclude<IndicatorStatus, 'checking'>, backend: data?.backend, missingEnv: data?.missingEnv, datasource: data?.datasource })}
              {data?.retryAfterSeconds !== undefined && <> {t('connection.retryIn', { seconds: data.retryAfterSeconds })}</>}
            </p>
            {data?.details && (
              <details className="group rounded-[var(--radius-control)] border border-border bg-card">
                <summary className="cursor-pointer select-none rounded-[var(--radius-control)] px-2.5 py-1.5 text-[12px] font-medium text-muted-foreground hover:text-foreground">
                  {t('connection.details')}
                </summary>
                <pre className="max-h-40 overflow-auto border-t border-border px-2.5 py-1.5 font-mono text-[12px] leading-[18px] whitespace-pre-wrap break-all text-foreground">
                  {data.details}
                </pre>
              </details>
            )}
            <div className="flex min-h-7 flex-wrap items-center justify-between gap-x-2 gap-y-1.5">
              {mayCheck && (
                <Button ref={button} variant="secondary" size="sm" onClick={recheck} disabled={busy}>
                  <RefreshCw className={cn(rechecking && 'animate-spin')} aria-hidden />
                  {t('connection.recheck')}
                </Button>
              )}
              <span className="ml-auto text-[12px] leading-4 text-foreground-2">{data?.checkedAt && <CheckedTime iso={data.checkedAt} timeZone={timeZone} />}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
