import { Eye, EyeOff, Loader2 } from 'lucide-react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button.tsx';
import { Tooltip } from '@/components/ui/tooltip.tsx';
import { describeError } from '@/features/search/errors.ts';
import { ApiError } from '@/lib/api.ts';
import { cn } from '@/lib/utils.ts';
import type { RevealStatus } from './reveal.ts';

export interface RevealButtonProps {
  status: RevealStatus;
  partial: boolean;
  error: unknown;
  /** Коды видов, которые показ этому пользователю не откроет: подсказка их называет. */
  stays: readonly string[];
  onToggle: () => void;
  /** В меню «⋯» узкой шапки: подпись видна всегда, кнопка во всю ширину меню. */
  inMenu?: boolean;
}

const STAY_KINDS = ['card_number', 'secrets'] as const;

/** Подсказка кнопки: что показ не вернёт и какие виды останутся под маской у этого пользователя. */
export function revealHint(t: TFunction, stays: readonly string[]): string {
  const named = STAY_KINDS.filter((k) => stays.includes(k)).map((k) => t(`request.reveal.kind.${k}`));
  return named.length > 0 ? `${t('request.reveal.hint')} ${t('request.reveal.stays', { kinds: named.join(', ') })}` : t('request.reveal.hint');
}

/** Одна кнопка на страницу. Подписи лежат в одной ячейке сетки: ширина не меняется при смене подписи. */
export function RevealButton({ status, partial, error, stays, onToggle, inMenu = false }: RevealButtonProps) {
  const { t } = useTranslation();
  const on = status === 'on';
  const failed = status === 'failed';
  const loading = status === 'loading';
  const show = t('request.reveal.show');
  const hide = t('request.reveal.hide');
  const fail = t('request.reveal.failed');
  const label = failed ? fail : on ? hide : show;
  const expired = error instanceof ApiError && error.code === 'search-expired';
  const gone = error instanceof ApiError && error.code === 'request-not-found';
  const reason = failed ? (expired ? t('request.reveal.expired') : gone ? t('request.reveal.gone') : describeError(t, error).title) : null;
  const hint = reason ?? (partial ? t('request.reveal.partial') : revealHint(t, stays));
  const Icon = loading ? Loader2 : on ? EyeOff : Eye;
  const cell = (visible: boolean) => cn('col-start-1 row-start-1 whitespace-nowrap', !visible && 'invisible');
  return (
    <>
      <Tooltip content={hint}>
        <Button
          variant="ghost"
          className={cn('h-[30px] shrink-0 px-2.5 text-[13px] font-medium', inMenu && 'w-full justify-start')}
          onClick={onToggle}
          aria-label={label}
          aria-busy={loading || undefined}
          aria-disabled={loading || undefined}
          data-testid="reveal-button"
          data-status={status}
        >
          <Icon className={cn(loading && 'animate-spin', failed && 'text-danger', partial && !failed && 'text-warning')} aria-hidden />
          <span className={cn('grid', !inMenu && 'compact:hidden')} aria-hidden>
            <span className={cell(!on && !failed)}>{show}</span>
            <span className={cell(on)}>{hide}</span>
            <span className={cell(failed)}>{fail}</span>
          </span>
        </Button>
      </Tooltip>
      <span className="sr-only" aria-live="polite" data-testid="reveal-message">
        {reason ?? (partial ? t('request.reveal.partial') : '')}
      </span>
    </>
  );
}
