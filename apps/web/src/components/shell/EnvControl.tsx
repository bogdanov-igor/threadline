import type { ConnectionResponse, EnvironmentInfo } from '@threadline/core';
import { useQueryClient } from '@tanstack/react-query';
import { MAX_SEARCH_ENVS } from '@threadline/core/search';
import type { TFunction } from 'i18next';
import { AlertTriangle, Check, ChevronDown, XCircle } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.tsx';
import { Tooltip } from '@/components/ui/tooltip.tsx';
import { useSearchSession } from '@/features/search/session.tsx';
import { useLeaveSearch } from '@/features/search/useLeaveSearch.ts';
import { focusFirstField } from '@/lib/focus.ts';
import { keys } from '@/lib/queries.ts';
import { envPath, envsPath, selectionEnvs, type Selection } from '@/lib/selection.ts';
import { useTruncated } from '@/lib/use-truncated.ts';
import { cn } from '@/lib/utils.ts';
import { ConnectionDetails, lowerFirst, StatusDot } from './ConnectionDetails.tsx';
import { StandChooser } from './StandChooser.tsx';
import { TruncatedLabel } from './Switcher.tsx';
import { TONE_CLASSES, toneOf, type IndicatorStatus } from './status.ts';
import { useConnectionState } from './use-connection-state.ts';

// Рамка как у поля значений. Открытое меню подсвечивает рамку, как select строки поиска.
const FRAME = 'h-8 rounded-[var(--radius-control)] border border-input bg-card';
const OPEN = 'data-[state=open]:border-primary data-[state=open]:shadow-[0_0_0_3px_var(--accent)]';

/**
 * Состояние подключения одно на страницу: у значка и строки причины один useRecheck. Меню с причиной открывают две кнопки,
 * поэтому его состояние выше обеих, а фокус после закрытия возвращается на ту, что его открыла.
 */
export function useConnectionPanel(project: string, env: string | readonly string[]) {
  const state = useConnectionState(project, env);
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const openFrom = useCallback((el: HTMLElement) => {
    opener.current = el;
    setOpen(true);
  }, []);
  return { state, open, setOpen, opener, openFrom };
}

export type ConnectionPanel = ReturnType<typeof useConnectionPanel>;

function StatusGlyph({ status }: { status: IndicatorStatus }) {
  const tone = toneOf(status);
  if (tone === 'danger') return <XCircle className="size-3.5" aria-hidden />;
  if (tone === 'warning') return <AlertTriangle className="size-3.5" aria-hidden />;
  return <StatusDot status={status} />;
}

const glyphColor = (status: IndicatorStatus) => {
  const tone = toneOf(status);
  return tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-warning' : undefined;
};

function useStatusWord() {
  const { t } = useTranslation();
  return (status: IndicatorStatus) => lowerFirst(status === 'checking' ? t('connection.checking') : t(`connection.status.${status}.title`));
}

/**
 * Строка списка сред. Текущая среда показывает точку своей проверки, её слово и время стоят в нижней строке меню: второй раз в строке они не повторяются.
 * Остальные только то, что уже известно: своей проверки меню не отправляет, к Grafana запросов не прибавляется.
 */
function EnvOption({ project, env, current, status, onPick, noted = false }: { project: string; env: EnvironmentInfo; current: boolean; status: IndicatorStatus | null; onPick: () => void; /** Несколько сред: слово состояния и у выбранной строки, нижняя строка меню говорит только о худшей. */ noted?: boolean }) {
  const noteId = useId();
  const word = useStatusWord();
  const last = useQueryClient().getQueryData<ConnectionResponse>(keys.connection(project, env.id))?.status;
  const shown: IndicatorStatus | null = (current ? status : null) ?? (env.notConfigured ? 'not-configured' : (last ?? null));
  const tone = shown ? toneOf(shown) : null;
  const note = current && !noted ? null : shown;
  return (
    <button
      type="button"
      role="option"
      aria-selected={current}
      aria-label={env.name}
      aria-describedby={note ? noteId : undefined}
      onClick={onPick}
      className="flex h-9 w-full min-w-0 items-center gap-2.5 rounded-[8px] px-2.5 text-left text-[13.5px] text-foreground transition-colors hover:bg-sunk focus-visible:-outline-offset-2 aria-selected:bg-sunk"
    >
      <span className={cn('size-2 shrink-0 rounded-full', tone ? TONE_CLASSES[tone].dot : 'bg-dot')} aria-hidden />
      <span className={cn('min-w-0 flex-1 truncate', env.notConfigured && 'text-muted-foreground')} title={env.name}>
        {env.name}
      </span>
      {note && (
        <span id={noteId} className={cn('shrink-0 text-[12px] leading-4', tone === 'warning' ? 'text-warning' : tone === 'danger' ? 'text-danger' : 'text-muted-foreground')}>
          {word(note)}
        </span>
      )}
    </button>
  );
}

/** Стрелки, Home и End двигают фокус по списку; Enter и пробел работают сами: строка — кнопка. */
function moveInList(e: KeyboardEvent<HTMLDivElement>) {
  const options = [...e.currentTarget.querySelectorAll<HTMLElement>('[role=option]')];
  const i = options.indexOf(document.activeElement as HTMLElement);
  const next = e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowUp' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? options.length - 1 : null;
  if (next === null) return;
  e.preventDefault();
  options[Math.max(0, Math.min(options.length - 1, next))]?.focus();
}

/** Почему флажок среды недоступен; null — доступен. */
function alsoReason(t: TFunction, e: EnvironmentInfo, checked: boolean, draft: readonly string[], standsHere: boolean): string | null {
  if (standsHere || e.kind === 'pr-stands') return t('envPicker.stands');
  if (e.notConfigured && !checked) return t('envPicker.notConfigured');
  if (checked && draft.length === 1) return t('envPicker.only');
  if (!checked && draft.length >= MAX_SEARCH_ENVS) return t('envPicker.limit', { count: MAX_SEARCH_ENVS });
  return null;
}

/** Флажок «Искать и здесь» в колонке рядом со строкой списка: в самом списке вариантов других элементов быть не может. */
function AlsoBox({ env, checked, reason, onToggle }: { env: EnvironmentInfo; checked: boolean; reason: string | null; onToggle: () => void }) {
  const { t } = useTranslation();
  const disabled = reason !== null;
  return (
    <Tooltip content={reason ?? t('envPicker.alsoHint')}>
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        aria-disabled={disabled || undefined}
        aria-label={t('envPicker.also', { name: env.name })}
        data-testid="env-also"
        data-env={env.id}
        onClick={() => {
          if (!disabled) onToggle();
        }}
        className="flex size-9 shrink-0 items-center justify-center rounded-[8px] transition-colors hover:bg-sunk focus-visible:-outline-offset-2 aria-disabled:cursor-default aria-disabled:hover:bg-transparent"
      >
        <span className={cn('flex size-4 items-center justify-center rounded-[4px] border', checked ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-card', disabled && 'opacity-50')}>
          {checked && <Check className="size-3" strokeWidth={3} aria-hidden />}
        </span>
      </button>
    </Tooltip>
  );
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));

/**
 * Выбор среды и значок состояния: один элемент постоянной ширины, смена среды поле значений не двигает.
 * Подробности подключения и повторная проверка в том же меню. Стенд выбирается рядом, отдельным элементом: номер не обрезается.
 * Флажки рядом со строками добавляют среды к поиску: набор меняется при закрытии меню, название строки выбирает одну среду.
 */
export function EnvControl({
  selection,
  panel,
  onOutOfView,
}: {
  selection: Selection;
  panel: ConnectionPanel;
  onOutOfView?: (hidden: boolean) => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const session = useSearchSession();
  const leave = useLeaveSearch();
  const word = useStatusWord();
  const { project, env } = selection;
  const { state, open, setOpen, opener } = panel;
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { ref: nameRef, truncated } = useTruncated<HTMLSpanElement>();
  const many = project.environments.length > 1;
  const current = selectionEnvs(selection);
  const multi = current.length > 1;
  const currentKey = current.map((e) => e.id).join(',');
  // Набор в меню: применяется при закрытии. Открытие меню любым путём начинает с текущего набора.
  const [draft, setDraft] = useState<string[]>(() => currentKey.split(','));
  useEffect(() => {
    if (open) setDraft(currentKey.split(','));
  }, [open, currentKey]);
  const standsHere = env.kind === 'pr-stands';
  // Флажки нужны, только если сочетать есть что: хотя бы две настроенные среды не стендов.
  const combinable = multi || project.environments.filter((e) => e.kind !== 'pr-stands' && !e.notConfigured).length >= 2;
  const names = current.map((e) => e.name);
  const worstName = multi ? current.find((e) => e.id === state.env)?.name : undefined;

  // Страница пересоздаётся по ключу среды: фокус переходит на новый выбор.
  useEffect(() => {
    if (session.takeFocus('env')) triggerRef.current?.focus({ preventScroll: true });
  }, [session]);

  // Компактный режим: страница прокручивается, и выбор среды может уйти за край. Рабочий: страница не прокручивается, метка не появляется.
  // Высота шапки вместе с полосой справочника, если она уже показана.
  useEffect(() => {
    const el = rootRef.current;
    if (!el || !onOutOfView) return;
    const top = Math.round(document.querySelector('header')?.getBoundingClientRect().height ?? 56);
    const io = new IntersectionObserver(([e]) => onOutOfView(!e!.isIntersecting), {
      rootMargin: `-${top}px 0px 0px 0px`,
    });
    io.observe(el);
    return () => {
      io.disconnect();
      onOutOfView(false);
    };
  }, [onOutOfView]);

  const go = (ids: readonly string[]) => {
    session.focusAfterChange('env');
    leave();
    navigate(envsPath(project.id, ids));
  };

  const pick = (id: string) => {
    setOpen(false);
    if (!multi && id === env.id) return;
    go([id]);
  };

  /** Закрытие меню применяет набор флажков, если он изменился. */
  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) return;
    const ordered = project.environments.map((e) => e.id).filter((id) => draft.includes(id));
    if (ordered.length > 0 && !sameSet(ordered, currentKey.split(','))) go(ordered);
  };

  const toggle = (id: string) => setDraft((d) => (d.includes(id) ? d.filter((x) => x !== id) : [...d, id]));

  const label = multi ? `${t('header.environments')}: ${names.join(', ')}, ${word(state.status)}` : `${t('header.environment')}: ${env.name}, ${word(state.status)}`;

  return (
    <div ref={rootRef} role="group" aria-label={t('header.environment')} data-testid="env-control" data-envs={currentKey} className={cn(FRAME, 'flex w-[136px] shrink-0 items-stretch min-[2000px]:w-44', many && OPEN)} data-state={open ? 'open' : 'closed'}>
      <Popover open={open} onOpenChange={onOpenChange}>
        {many ? (
          <Tooltip content={multi ? names.join(' + ') : env.name} disabled={!multi && !truncated}>
            <PopoverTrigger asChild>
              <button
                ref={triggerRef}
                type="button"
                role="combobox"
                aria-haspopup="listbox"
                aria-label={label}
                onKeyDown={(e) => {
                  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
                  e.preventDefault();
                  setOpen(true);
                }}
                className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-[calc(var(--radius-control)-1px)] pr-2 pl-2.5 text-[13px] font-[550] text-foreground focus-visible:-outline-offset-2"
              >
                <span data-testid="connection-indicator" data-status={state.status} className={cn('flex size-3.5 shrink-0 items-center justify-center', glyphColor(state.status))}>
                  <StatusGlyph status={state.status} />
                </span>
                <span className="flex min-w-0 flex-1 items-center gap-1">
                  <span ref={nameRef} className="block min-w-0 truncate text-left">
                    {env.name}
                  </span>
                  {multi && (
                    <span className="tabular shrink-0 text-muted-foreground" data-testid="env-more">
                      +{current.length - 1}
                    </span>
                  )}
                </span>
                <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              </button>
            </PopoverTrigger>
          </Tooltip>
        ) : (
          <>
            <PopoverTrigger asChild>
              <button
                ref={triggerRef}
                type="button"
                data-testid="connection-indicator"
                data-status={state.status}
                aria-label={`${t('connection.label')}: ${word(state.status)}`}
                className={cn('flex h-full shrink-0 items-center justify-center rounded-l-[calc(var(--radius-control)-1px)] pr-1.5 pl-2.5 hover:bg-sunk focus-visible:-outline-offset-2', glyphColor(state.status))}
              >
                <span className="flex size-3.5 items-center justify-center">
                  <StatusGlyph status={state.status} />
                </span>
              </button>
            </PopoverTrigger>
            <span className="flex min-w-0 flex-1 items-center pr-2 text-[13px] font-[550] text-foreground">
              <TruncatedLabel text={env.name} className="min-w-0" />
            </span>
          </>
        )}
        <PopoverContent
          align="start"
          className={cn('max-h-[var(--radix-popover-content-available-height)] overflow-y-auto p-1.5', many && combinable ? 'w-[336px]' : 'w-[300px]')}
          onOpenAutoFocus={(e) => {
            // Из строки причины фокус на само окно, а не на время: его подсказка не должна закрывать проверку. Из выбора среды на текущую среду.
            e.preventDefault();
            const content = e.currentTarget as HTMLElement | null;
            const selected = opener.current ? null : content?.querySelector<HTMLElement>('[role=option][aria-selected=true]');
            (selected ?? content)?.focus();
          }}
          onPointerDownOutside={() => {
            opener.current = null;
          }}
          onCloseAutoFocus={(e) => {
            const el = opener.current;
            opener.current = null;
            // «Подробнее» уже нет, потому что проверка прошла: фокус встаёт на выбор среды, это поведение по умолчанию.
            if (el?.isConnected) {
              e.preventDefault();
              el.focus();
            }
          }}
        >
          {many && (
            <>
              <div className="flex min-w-0 gap-0.5">
                <div role="listbox" aria-label={t('header.environment')} onKeyDown={moveInList} className="flex min-w-0 flex-1 flex-col gap-0.5">
                  {project.environments.map((e) => {
                    // Несколько сред: у выбранных их последнее известное состояние, у худшей — живая проверка.
                    const status = !multi || e.id === state.env ? state.status : null;
                    return <EnvOption key={e.id} project={project.id} env={e} current={current.some((x) => x.id === e.id)} status={status} noted={multi} onPick={() => pick(e.id)} />;
                  })}
                </div>
                {combinable && (
                  <div role="group" aria-label={t('envPicker.alsoGroup')} className="flex shrink-0 flex-col gap-0.5" data-testid="env-also-group">
                    {project.environments.map((e) => {
                      const checked = draft.includes(e.id);
                      return <AlsoBox key={e.id} env={e} checked={checked} reason={alsoReason(t, e, checked, draft, standsHere)} onToggle={() => toggle(e.id)} />;
                    })}
                  </div>
                )}
              </div>
              <div className="mx-1.5 my-1 h-px bg-border" />
            </>
          )}
          <ConnectionDetails status={state.status} data={state.data} timeZone={project.timezone} onRecheck={state.recheck} rechecking={state.rechecking} envName={worstName} />
        </PopoverContent>
      </Popover>
    </div>
  );
}

/** Выбор стенда в строке поиска: постоянная ширина, в неё помещается шестизначный номер. Показан только при выбранном стенде. */
export function StandPicker({ selection }: { selection: Selection & { stand: string } }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const session = useSearchSession();
  const leave = useLeaveSearch();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const label = t('header.standNumber', { number: selection.stand });

  useEffect(() => {
    if (session.takeFocus('stand')) triggerRef.current?.focus({ preventScroll: true });
  }, [session]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          aria-label={`${t('header.stand')}: ${label}`}
          className={cn(
            FRAME,
            OPEN,
            'tabular inline-flex w-[136px] shrink-0 items-center justify-between gap-1 pr-2 pl-2.5 text-[13px] font-[550] whitespace-nowrap text-foreground transition-colors hover:bg-sunk focus-visible:-outline-offset-2',
          )}
        >
          {label}
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        onOpenAutoFocus={(e) => {
          if (focusFirstField(e.currentTarget as HTMLElement)) e.preventDefault();
        }}
      >
        <StandChooser
          project={selection.project.id}
          env={selection.env.id}
          current={selection.stand}
          onPick={(s) => {
            setOpen(false);
            if (s === selection.stand) return;
            session.focusAfterChange('stand');
            leave();
            navigate(envPath(selection.project.id, selection.env.id, s));
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
