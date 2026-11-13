// Инструменты поддержки в ленивом чанке: главный чанк от их разметки и строк не растёт.
import type { ViewRecord } from '@threadline/core/search';
import { safeHttpsUrl, type SupportContact as Contact } from '@threadline/core/settings';
import { useQuery } from '@tanstack/react-query';
import { Check, Copy, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button.tsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select.tsx';
import { Tooltip } from '@/components/ui/tooltip.tsx';
import { NO_VALUE, type FilterOptions, type RowFacet, type RowFilters } from '@/features/search/result-filters.ts';
import { TermsField } from '@/features/search/TermsField.tsx';
import type { SearchController } from '@/features/search/useSearchController.ts';
import { useView } from '@/features/view/context.tsx';
import { apiGet } from '@/lib/api.ts';
import { useCopy } from '@/lib/clipboard.ts';
import { formatInt } from '@/lib/format.ts';
import { cn } from '@/lib/utils.ts';
import { buildCurl, curlSource } from './curl.ts';

// ---------- «Не содержит» ----------

// Поле монтируется после загрузки своей части чанка: фокус, который просил «Уточнить», оно берёт само.
let focusOnMount = false;

/** Закрыть можно только пустое поле: скрытое условие молча меняло бы результат. */
export function ExcludeToggle({ c }: { c: SearchController }) {
  const { t } = useTranslation();
  const filled = c.excludes.length > 0 || c.excludeText !== '';
  return (
    <button
      type="button"
      aria-expanded={c.refineOpen}
      data-testid="exclude-toggle"
      onClick={() => {
        if (c.refineOpen && !filled) return c.setRefine(false);
        c.setRefine(true);
        if (c.excludeRef.current) c.excludeRef.current.focus();
        else focusOnMount = true;
      }}
      className="relative h-4 shrink-0 text-[12px] leading-4 font-medium text-primary before:absolute before:-inset-x-1 before:-inset-y-2 hover:underline"
    >
      {t('tools.exclude.toggle')}
      {c.excludes.length > 0 && <span className="tabular"> · {c.excludes.length}</span>}
    </button>
  );
}

export function ExcludeField({ c, id, disabled }: { c: SearchController; id: string; disabled: boolean }) {
  const { t } = useTranslation();
  // В «Кратко» и у Бизнеса вкладки «Все записи» нет: подсказка только о списке запросов.
  const { mode } = useView();
  const error = c.error?.kind === 'exclude' ? c.error : null;
  const { excludeRef } = c;
  useEffect(() => {
    if (!focusOnMount) return;
    focusOnMount = false;
    excludeRef.current?.focus();
  }, [excludeRef]);
  return (
    <div className="flex min-w-0 flex-col gap-1" data-testid="exclude-field">
      <label htmlFor={id} className="text-[12px] leading-4 font-medium text-muted-foreground">
        {t('tools.exclude.label')}
      </label>
      <TermsField
        id={id}
        label={t('tools.exclude.label')}
        placeholder={t('tools.exclude.placeholder')}
        chips={c.excludes}
        onChipsChange={c.setExcludes}
        text={c.excludeText}
        onTextChange={c.setExcludeText}
        onInputError={(code) => c.setError(code ? { kind: 'exclude', code } : null)}
        onSubmit={() => void c.run()}
        invalid={!!error}
        invalidChipId={error?.chipId}
        describedBy={`${id}-note`}
        disabled={disabled}
        inputRef={c.excludeRef}
      />
      {error ? (
        <p id={`${id}-note`} role="alert" className="text-[12px] leading-4 text-danger" data-testid="exclude-error">
          {t(`tools.exclude.error.${error.code}`)}
        </p>
      ) : (
        <p id={`${id}-note`} className="text-[12px] leading-4 text-muted-foreground" data-testid="exclude-hint">
          {t(mode === 'brief' ? 'tools.exclude.hintBrief' : 'tools.exclude.hint')}
        </p>
      )}
    </div>
  );
}

// ---------- Фильтры результатов ----------

const FACETS: readonly RowFacet[] = ['method', 'system', 'component'];
// В выборе значение не может быть пустым: «все» — служебное значение из личной области символов, строки с таким не бывает.
const ALL = '\uE001';

/** Выбор фильтров: в окне кнопки «Фильтр». Сколько скрыто и сброс стоят над списком, окно может быть закрыто. */
export function ResultFiltersBar({ options, value, onChange }: { options: FilterOptions; value: RowFilters; onChange: (next: RowFilters) => void }) {
  const { t } = useTranslation();
  return (
    <div role="group" aria-label={t('tools.filters.label')} className="flex min-w-0 flex-col gap-2" data-testid="result-filters">
      {FACETS.filter((f) => options[f].length > 1 || value[f] !== null).map((f) => (
        <Select key={f} value={value[f] ?? ALL} onValueChange={(v) => onChange({ ...value, [f]: v === ALL ? null : v })}>
          <SelectTrigger aria-label={t(`tools.filters.${f}`)} data-testid={`filter-${f}`} className={cn('h-8 w-full justify-between border border-border text-[13px] font-normal', value[f] !== null && 'border-primary')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t(`tools.filters.all.${f}`)}</SelectItem>
            {options[f].map((v) => (
              <SelectItem key={v} value={v}>
                {v === NO_VALUE ? t(`tools.filters.none.${f}`) : v}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ))}
    </div>
  );
}

export function ResultFiltersStatus({ hidden, shown, onReset }: { hidden: number; shown: number; onReset: () => void }) {
  const { t } = useTranslation();
  return (
    <p className="flex min-h-7 min-w-0 flex-wrap items-center gap-x-2 text-[13px] text-muted-foreground" role="status">
      <span className="tabular" data-testid="filters-hidden">
        {shown === 0 ? t('tools.filters.allHidden') : t('tools.filters.hidden', { n: formatInt(hidden) })}
      </span>
      <Button type="button" variant="ghost" size="sm" className="text-primary" onClick={onReset} data-testid="filters-reset">
        <X aria-hidden />
        {t('tools.filters.reset')}
      </Button>
    </p>
  );
}

// ---------- cURL ----------

// Значок, зазор и поля кнопки с подписью, сдвиг влево.
const CURL_CHROME = 46;

export function CurlButton({ record, withHeaders, room }: { record: ViewRecord; withHeaders: boolean; /** Сколько места у кнопки в строке вкладок: подпись не помещается — значок с подсказкой. */ room?: number }) {
  const { t } = useTranslation();
  const { state, copy } = useCopy();
  const curl = buildCurl(curlSource(record, withHeaders));
  const label = t('tools.curl.label');
  const measure = useRef<HTMLSpanElement>(null);
  const [labelWidth, setLabelWidth] = useState(0);
  useLayoutEffect(() => setLabelWidth(measure.current?.offsetWidth ?? 0), [label]);
  const iconOnly = room !== undefined && labelWidth + CURL_CHROME > room;
  const status = state === 'copied' ? t('requests.copied') : state === 'failed' ? t('requests.copyFailed') : '';
  // На кнопке короткие слова: они у́же подписи на всех языках. Полное «Не удалось скопировать» в подсказке и у диктора.
  const word = state === 'copied' ? t('record.copied') : state === 'failed' ? t('record.copyFailed') : '';
  const hint = status || [iconOnly ? `${label}.` : null, t('tools.curl.hint'), curl.masked ? t('tools.curl.masked') : null, curl.noHost ? t('tools.curl.noHost') : null].filter(Boolean).join(' ');
  return (
    <>
      <span ref={measure} aria-hidden className="invisible absolute text-[12.5px] font-[550] whitespace-nowrap">
        {label}
      </span>
      <Tooltip content={hint}>
        <Button type="button" variant="ghost" size="sm" className={cn('h-7 text-primary', iconOnly ? 'w-7 px-0' : '-translate-x-2', state === 'failed' && 'text-danger')} aria-label={iconOnly ? label : undefined} data-testid="copy-curl" data-icon-only={iconOnly || undefined} data-masked={curl.masked || undefined} data-copied={state === 'copied' || undefined} onClick={() => void copy(curl.command)}>
          {state === 'copied' ? <Check aria-hidden /> : state === 'failed' ? <X aria-hidden /> : <Copy aria-hidden />}
          {/* Слова подтверждения поверх подписи: ширина кнопки и соседние вкладки не меняются. */}
          {!iconOnly && (
            <span className="grid">
              <span className={cn('col-start-1 row-start-1', status && 'invisible')}>{label}</span>
              <span aria-hidden className="col-start-1 row-start-1">
                {word}
              </span>
            </span>
          )}
          <span className="sr-only" aria-live="polite">
            {status}
          </span>
        </Button>
      </Tooltip>
    </>
  );
}

// ---------- Контакт поддержки ----------

const hostOf = (url: string) => new URL(url).host;

/** Пустого контакта нет: на его месте остаётся прежний текст. Ссылка проверяется и здесь: ответ не единственная защита. Текст идёт как текст, разметка не выполняется. */
export function SupportContact({ className, label }: { className?: string; /** Своя подпись строкой над контактом вместо «Поддержка:»: на экране Бизнеса с именем проекта. */ label?: string }) {
  const { t } = useTranslation();
  const { data } = useQuery({ queryKey: ['support-contact'], queryFn: ({ signal }) => apiGet<Contact>('/api/support-contact', signal), staleTime: 5 * 60_000, retry: false });
  const text = data?.text || null;
  const url = data?.url && safeHttpsUrl(data.url) ? data.url : null;
  if (!text && !url) return null;
  return (
    <span className={cn('min-w-0 text-[13px] [overflow-wrap:anywhere] text-foreground', className)} data-testid="support-contact">
      {label ? <span className="block text-[12.5px] leading-[17px] text-muted-foreground">{label}</span> : t('tools.contact.label')} {text}{' '}
      {url && (
        <a href={url} target="_blank" rel="noopener noreferrer" title={url} className="font-medium text-primary underline underline-offset-2" data-testid="support-contact-link">
          {text ? t('tools.contact.open') : hostOf(url)}
        </a>
      )}
    </span>
  );
}
