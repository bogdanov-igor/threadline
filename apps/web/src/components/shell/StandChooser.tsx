import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { ApiError } from '@/lib/api.ts';
import { useStands } from '@/lib/queries.ts';
import { STAND_NUMBER } from '@/lib/selection.ts';
import { readableDetails } from '@/lib/server-text.ts';
import { cn } from '@/lib/utils.ts';

export interface StandChooserProps {
  project: string;
  env: string;
  current: string | undefined;
  onPick: (stand: string) => void;
}

/** Список живых стендов и ручной ввод номера. */
export function StandChooser({ project, env, current, onPick }: StandChooserProps) {
  const { t } = useTranslation();
  const stands = useStands(project, env, true);
  const [value, setValue] = useState('');
  const [invalid, setInvalid] = useState(false);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    // Окно стенда в портале, но событие всплывает по дереву компонентов: иначе Enter запустил бы ещё и поиск.
    e.stopPropagation();
    const v = value.trim();
    if (!STAND_NUMBER.test(v)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    onPick(String(Number(v)));
  };

  const errorCode = stands.error instanceof ApiError ? stands.error.code : undefined;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <h3 className="text-[13px] font-semibold text-heading">{t('stands.title')}</h3>
          {stands.data && stands.data.stands.length > 0 && (
            <span className="text-[12px] text-muted-foreground">{t('stands.count', { count: stands.data.stands.length })}</span>
          )}
        </div>
        {stands.isPending && (
          <div className="flex flex-wrap gap-2" aria-busy="true">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-8 w-14" />
            ))}
          </div>
        )}
        {stands.data && stands.data.stands.length === 0 && <p className="text-muted-foreground">{t('stands.empty')}</p>}
        {stands.data && stands.data.stands.length > 0 && (
          <ul className="flex max-h-40 flex-wrap gap-2 overflow-y-auto p-0.5" aria-label={t('stands.title')}>
            {stands.data.stands.map((n) => (
              <li key={n}>
                <button
                  type="button"
                  onClick={() => onPick(String(n))}
                  aria-current={current === String(n) ? 'true' : undefined}
                  className={cn(
                    'tabular h-8 min-w-14 rounded-[var(--radius-chip)] border px-3 text-[13px] font-medium transition-colors',
                    current === String(n)
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border bg-card hover:border-primary/40 hover:bg-accent hover:text-accent-foreground',
                  )}
                >
                  {n}
                </button>
              </li>
            ))}
          </ul>
        )}
        {stands.isError && (
          <p className="rounded-[var(--radius-control)] bg-danger-bg px-3 py-2 text-[13px] text-danger" role="alert">
            {t('stands.failed')}
            {errorCode && errorCode !== 'unknown' && errorCode in STATUS_TITLES ? `: ${lowerFirst(t(`connection.status.${errorCode as StatusKey}.title`))}` : ''}
            {stands.error instanceof ApiError && readableDetails(stands.error.details) ? ` (${stands.error.details})` : ''}
          </p>
        )}
      </div>

      <form onSubmit={submit} noValidate className="flex flex-col gap-1.5">
        <label htmlFor={`stand-${env}`} className="text-[13px] font-semibold text-heading">
          {t('stands.manual')}
        </label>
        <div className="flex gap-2">
          <Input
            id={`stand-${env}`}
            inputMode="numeric"
            autoComplete="off"
            placeholder={t('stands.manualPlaceholder')}
            value={value}
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? `stand-${env}-error` : undefined}
            onChange={(e) => {
              setValue(e.target.value);
              if (invalid) setInvalid(false);
            }}
            className="tabular"
          />
          <Button type="submit">{t('stands.open')}</Button>
        </div>
        {invalid && (
          <p id={`stand-${env}-error`} className="text-[13px] text-danger" role="alert">
            {t('stands.invalid')}
          </p>
        )}
      </form>
    </div>
  );
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

const STATUS_TITLES = {
  unauthorized: 1,
  forbidden: 1,
  'not-found': 1,
  network: 1,
  certificate: 1,
  timeout: 1,
  overloaded: 1,
  limit: 1,
  'too-large': 1,
  busy: 1,
  'bad-response': 1,
  'not-configured': 1,
  'server-unreachable': 1,
} as const;
type StatusKey = keyof typeof STATUS_TITLES;
