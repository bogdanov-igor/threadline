import { timeZoneOffsetLabel } from '@threadline/core';
import { PERIOD_PRESETS, type PeriodPreset } from '@threadline/core/search';
import { useId, useRef, useState, type FormEvent, type Ref } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button.tsx';
import { DateTimeField } from '@/components/ui/date-time-field.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.tsx';
import { Segmented } from '@/components/ui/segmented.tsx';
import { shortDateTime, timeParts } from '@/lib/format.ts';
import { focusFirstField, moveInGroup } from '@/lib/focus.ts';
import { cn } from '@/lib/utils.ts';
import { epochToLocalInput, parseLogTime } from '@/lib/zoned-time.ts';
import { AROUND_MINUTES, aroundBounds, checkAround, checkPeriodFields, DEFAULT_AROUND, isPreset, type AroundMinutes, type PeriodChoice, type PeriodError, type PeriodField } from './model.ts';

const PRESETS = Object.keys(PERIOD_PRESETS) as PeriodPreset[];

type WindowMode = 'range' | 'around';
const WINDOW_MODES: WindowMode[] = ['range', 'around'];

/** «02.11 08:30 – 14:30»: дата конца не повторяется, если день тот же. */
export function customRangeLabel(fromMs: number, toMs: number, timeZone: string): { from: string; to: string } {
  const from = shortDateTime(fromMs, timeZone);
  const to = shortDateTime(toMs, timeZone);
  return { from, to: to.slice(0, 5) === from.slice(0, 5) ? to.slice(6) : to };
}

const segment =
  'inline-flex h-[26px] items-center gap-1 rounded-[7px] px-2.5 text-[13px] font-medium whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground aria-pressed:bg-[var(--seg-on)] aria-pressed:text-foreground aria-pressed:shadow-[var(--seg-on-shadow)] disabled:pointer-events-none disabled:opacity-50';

export function PeriodControl({
  value,
  onChange,
  timeZone,
  retentionDays,
  disabled,
  triggerRef,
}: {
  value: PeriodChoice;
  onChange: (p: PeriodChoice) => void;
  timeZone: string;
  retentionDays: number;
  disabled: boolean;
  /** Кнопка своего периода: на неё встаёт фокус, когда период отклонён уже при запуске поиска. */
  triggerRef?: Ref<HTMLButtonElement>;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [formError, setFormError] = useState<PeriodError | null>(null);
  // У какого поля ошибка: рамка и фокус только у него.
  const [errorField, setErrorField] = useState<PeriodField | null>(null);
  const fromRef = useRef<HTMLInputElement>(null);
  const toRef = useRef<HTMLInputElement>(null);
  const atRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<WindowMode>('range');
  const [timeText, setTimeText] = useState('');
  const [minutes, setMinutes] = useState<AroundMinutes>(DEFAULT_AROUND);
  const id = useId();

  const custom = !isPreset(value);
  const around = custom ? (value.around ?? null) : null;
  const range = custom ? customRangeLabel(value.fromMs, value.toMs, timeZone) : null;
  const buttonRange = around ? t('period.aroundLabel', { at: shortDateTime(around.atMs, timeZone), minutes: around.minutes }) : range ? t('period.customRange', range) : null;

  const openCustom = (next: boolean) => {
    if (next) {
      const now = Date.now();
      const f = custom ? value.fromMs : now - PERIOD_PRESETS[value.preset];
      const tt = custom ? value.toMs : now;
      setFrom(epochToLocalInput(f, timeZone));
      setTo(epochToLocalInput(tt, timeZone));
      setFormError(null);
      setErrorField(null);
      setMode(around ? 'around' : 'range');
      setTimeText(around?.text ?? '');
      setMinutes(around?.minutes ?? DEFAULT_AROUND);
    }
    setOpen(next);
  };

  const applyAround = () => {
    const now = Date.now();
    const parsed = parseLogTime(timeText, now, timeZone);
    const err = parsed.ok ? checkAround(parsed.atMs, minutes, now, retentionDays) : parsed.error;
    if (!parsed.ok || err) {
      setFormError(err);
      atRef.current?.focus();
      return;
    }
    onChange({ ...aroundBounds(parsed.atMs, minutes), around: { atMs: parsed.atMs, minutes, text: timeText } });
    setOpen(false);
  };

  const apply = (e: FormEvent) => {
    e.preventDefault();
    // Окно в портале, но событие React всплывает по дереву компонентов — до формы поиска.
    e.stopPropagation();
    if (mode === 'around') {
      applyAround();
      return;
    }
    const checked = checkPeriodFields(from, to, timeZone, Date.now(), retentionDays);
    if (!checked.ok) {
      setFormError(checked.error);
      setErrorField(checked.field);
      (checked.field === 'from' ? fromRef : toRef).current?.focus();
      return;
    }
    onChange({ fromMs: checked.fromMs, toMs: checked.toMs });
    setOpen(false);
  };

  const message = (e: PeriodError) => (e === 'too-old' ? t('period.error.too-old', { count: retentionDays }) : t(`period.error.${e}`));

  // Итог под полем виден до применения: дата времени без даты, конец, обрезанный текущим моментом.
  const preview = () => {
    if (mode !== 'around' || formError) return null;
    const now = Date.now();
    const parsed = parseLogTime(timeText, now, timeZone);
    if (!parsed.ok) return null;
    const bounds = aroundBounds(parsed.atMs, minutes);
    const at = timeParts(parsed.atMs, timeZone);
    const line = t('period.aroundResult', { at: `${at.date} ${at.time.slice(0, 8)}`, from: timeParts(bounds.fromMs, timeZone).time.slice(0, 8), to: timeParts(bounds.toMs, timeZone).time.slice(0, 8) });
    return bounds.toMs > now ? `${line} ${t('period.aroundToNow')}` : line;
  };
  const shown = preview();

  return (
    <div role="group" aria-label={t('period.label')} onKeyDown={moveInGroup} className="inline-flex max-w-full min-w-0 flex-wrap items-center gap-0.5 self-start rounded-[9px] bg-sunk p-[3px]">
        {PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            tabIndex={!custom && value.preset === p ? 0 : -1}
            disabled={disabled}
            aria-pressed={!custom && value.preset === p}
            onClick={() => onChange({ preset: p })}
            className={cn(segment, 'tabular')}
          >
            {t(`period.preset.${p}`)}
          </button>
        ))}
        <Popover open={open} onOpenChange={openCustom}>
          <PopoverTrigger asChild>
            <button
              ref={triggerRef}
              type="button"
              tabIndex={custom ? 0 : -1}
              disabled={disabled}
              aria-pressed={custom}
              aria-label={buttonRange ? `${t('period.custom')}: ${buttonRange}` : t('period.custom')}
              className={segment}
            >
              {t('period.custom')}
              {buttonRange && <span className="tabular">{buttonRange}</span>}
            </button>
          </PopoverTrigger>
          {/* Низкое окно: своя прокрутка, кнопки остаются доступны с клавиатуры. */}
          <PopoverContent
            align="end"
            className="max-h-[var(--radix-popover-content-available-height)] w-[31rem] overflow-y-auto"
            onOpenAutoFocus={(e) => {
              if (focusFirstField(e.currentTarget as HTMLElement)) e.preventDefault();
            }}
          >
            <form onSubmit={apply} noValidate className="flex flex-col gap-3" aria-labelledby={`${id}-title`}>
              <div>
                <h3 id={`${id}-title`} className="text-[14px] leading-5 font-semibold text-heading">
                  {t('period.customTitle')}
                </h3>
                <p id={`${id}-zone`} className="mt-0.5 text-[12px] leading-4 text-muted-foreground">
                  {t('period.zone', { zone: `${timeZone}, ${timeZoneOffsetLabel(timeZone)}` })}
                </p>
              </div>
              <Segmented
                label={t('period.modeLabel')}
                value={mode}
                options={WINDOW_MODES.map((m) => ({ value: m, label: t(`period.mode.${m}`) }))}
                onChange={(m) => {
                  setMode(m);
                  setFormError(null);
                  setErrorField(null);
                }}
                className="self-start"
              />
              {mode === 'range' ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="flex min-w-0 flex-col gap-1">
                    <label htmlFor={`${id}-from`} className="text-[12px] leading-4 text-muted-foreground">
                      {t('period.from')}
                    </label>
                    <DateTimeField
                      id={`${id}-from`}
                      inputRef={fromRef}
                      calendarLabel={t('period.calendar')}
                      value={from}
                      aria-invalid={errorField === 'from' || undefined}
                      aria-describedby={errorField === 'from' ? `${id}-error` : `${id}-zone`}
                      onChange={(e) => {
                        setFrom(e.target.value);
                        setFormError(null);
                        setErrorField(null);
                      }}
                    />
                  </div>
                  <div className="flex min-w-0 flex-col gap-1">
                    <label htmlFor={`${id}-to`} className="text-[12px] leading-4 text-muted-foreground">
                      {t('period.to')}
                    </label>
                    <DateTimeField
                      id={`${id}-to`}
                      inputRef={toRef}
                      calendarLabel={t('period.calendar')}
                      value={to}
                      aria-invalid={errorField === 'to' || undefined}
                      aria-describedby={errorField === 'to' ? `${id}-error` : `${id}-zone`}
                      onChange={(e) => {
                        setTo(e.target.value);
                        setFormError(null);
                        setErrorField(null);
                      }}
                    />
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  <div className="flex min-w-0 flex-col gap-1">
                    <label htmlFor={`${id}-at`} className="text-[12px] leading-4 text-muted-foreground">
                      {t('period.at')}
                    </label>
                    <Input
                      ref={atRef}
                      id={`${id}-at`}
                      type="text"
                      autoComplete="off"
                      spellCheck={false}
                      value={timeText}
                      placeholder={t('period.atPlaceholder')}
                      aria-invalid={!!formError || undefined}
                      aria-describedby={formError ? `${id}-error` : `${id}-zone`}
                      onChange={(e) => {
                        setTimeText(e.target.value);
                        setFormError(null);
                      }}
                      className="tabular"
                    />
                  </div>
                  <div className="flex min-w-0 flex-col gap-1">
                    <span id={`${id}-margin`} className="text-[12px] leading-4 text-muted-foreground">
                      {t('period.margin')}
                    </span>
                    <div role="group" aria-labelledby={`${id}-margin`} onKeyDown={moveInGroup} className="grid h-8 grid-cols-4 gap-0.5 rounded-[9px] bg-sunk p-[3px]">
                      {AROUND_MINUTES.map((m) => (
                        <button
                          key={m}
                          type="button"
                          tabIndex={minutes === m ? 0 : -1}
                          aria-pressed={minutes === m}
                          onClick={() => {
                            setMinutes(m);
                            setFormError(null);
                          }}
                          className={cn(segment, 'tabular h-full justify-center px-0')}
                        >
                          {t('period.marginValue', { minutes: m })}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}
              {/* Постоянное место на две строки: ни ошибка, ни итог, ни смена режима не сдвигают кнопки и не меняют размер окна. */}
              <div className="h-10 overflow-hidden text-[13px] leading-5" data-testid="period-message">
                {formError ? (
                  <p id={`${id}-error`} role="alert" className="text-danger">
                    {message(formError)}
                  </p>
                ) : shown ? (
                  <p className="tabular text-foreground">{shown}</p>
                ) : null}
              </div>
              {/* С поля Tab идёт сначала на главную кнопку: в разметке она первая, на экране стоит справа. */}
              <div className="flex flex-row-reverse justify-start gap-2">
                <Button type="submit">{t('period.apply')}</Button>
                <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                  {t('period.cancel')}
                </Button>
              </div>
            </form>
          </PopoverContent>
      </Popover>
    </div>
  );
}
