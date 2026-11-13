import type { Trace, TraceStep, ViewRecord } from '@threadline/core/search';
import { ArrowLeftRight, Clock, LogIn, MessageSquareText, SquareFunction, type LucideIcon } from 'lucide-react';
import { useRef, type CSSProperties, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { PathTitle } from '@/components/path/PathTitle.tsx';
import { Card } from '@/components/ui/card.tsx';
import { noAnswerKey } from '@/lib/error-text.ts';
import { formatDuration, upperFirst } from '@/lib/format.ts';
import { cn } from '@/lib/utils.ts';
import { systemLabel } from '@/lib/systems.ts';
import { methodName, stepCatalog, stepIsError, stepVerdict, systemName, type StepCatalog, type StepVerdict } from '@/features/catalog/names.ts';
import { briefMethod, briefSystem } from '@/features/view/brief.ts';
import { useView } from '@/features/view/context.tsx';
import { titleText } from './record-title.ts';
import { axisTicks, exchangeHost, formatTick, operationOf, percent } from './trace-model.ts';

// Название шага — две пятых ширины, шкала — три пятых: при любой ширине у полос больше места.
const COLS = 'grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)]';

const ICONS: Record<TraceStep['kind'], LucideIcon> = {
  incoming: LogIn,
  call: SquareFunction,
  exchange: ArrowLeftRight,
  log: MessageSquareText,
};

/** Полосы шагов на общей шкале: начало — смещение от первой записи, длина — длительность. */
export function TraceTimeline({
  trace,
  byId,
  selected,
  onSelect,
  onOpen,
  className,
}: {
  trace: Trace;
  byId: ReadonlyMap<string, ViewRecord>;
  selected: string | null;
  onSelect: (id: string) => void;
  /** Enter на шаге: перейти к подробностям. */
  onOpen: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLOListElement>(null);
  const steps = trace.steps;
  const index = steps.findIndex((s) => s.id === selected);
  const focusable = index >= 0 ? index : 0;

  const move = (to: number) => {
    const s = steps[Math.max(0, Math.min(steps.length - 1, to))];
    if (!s) return;
    onSelect(s.id);
    listRef.current?.querySelector<HTMLElement>(`[data-step="${CSS.escape(s.id)}"]`)?.focus();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const keys: Record<string, () => void> = {
      ArrowDown: () => move(index + 1),
      ArrowUp: () => move(index < 0 ? 0 : index - 1),
      Home: () => move(0),
      End: () => move(steps.length - 1),
      Enter: onOpen,
      ' ': onOpen,
    };
    const f = keys[e.key];
    if (!f) return;
    e.preventDefault();
    f();
  };

  const ticks = axisTicks(trace.totalMs);

  return (
    <Card className={cn('min-w-0 overflow-hidden', className)} data-testid="trace-timeline">
      <div className={cn(COLS, 'sticky top-0 z-10 rounded-t-[var(--radius-card)] border-b border-border bg-card text-[12px] text-muted-foreground')} aria-hidden>
        <div className="px-3 py-2">{t('trace.timeline.step')}</div>
        {/* Промежуточные деления прячутся, когда шкала узкая и подписи сошлись бы вплотную. */}
        <div className="@container relative mx-3 h-8" data-testid="trace-axis">
          {ticks.map((ms, i) => (
            <span
              key={i}
              className={cn(
                'tabular absolute top-1/2 -translate-y-1/2 whitespace-nowrap',
                i === 0 ? '' : i === ticks.length - 1 ? '-translate-x-full' : '-translate-x-1/2',
                i % 2 === 1 && 'hidden @min-[22rem]:inline',
                i === 2 && 'hidden @min-[11rem]:inline',
              )}
              style={{ left: `${(i / (ticks.length - 1)) * 100}%` }}
              data-tick={i}
            >
              {formatTick(ms, trace.totalMs)}
            </span>
          ))}
        </div>
      </div>
      <ol ref={listRef} role="listbox" aria-label={t('trace.timeline.label')} onKeyDown={onKeyDown} className="py-1">
        {steps.map((s, i) => (
          <StepRow
            key={s.id}
            step={s}
            trace={trace}
            record={byId.get(s.recordIds[0] ?? '')}
            host={s.kind === 'exchange' ? exchangeHost(s, byId) : null}
            catalog={stepCatalog(s, byId)}
            selected={s.id === selected}
            tabIndex={i === focusable ? 0 : -1}
            onSelect={() => onSelect(s.id)}
          />
        ))}
      </ol>
    </Card>
  );
}

function StepRow({
  step: s,
  trace,
  record,
  host,
  catalog,
  selected,
  tabIndex,
  onSelect,
}: {
  step: TraceStep;
  trace: Trace;
  record: ViewRecord | undefined;
  host: string | null;
  /** Разметка справочника: имя системы и метода, итог по правилу. */
  catalog: StepCatalog | null;
  selected: boolean;
  tabIndex: number;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const brief = useView().mode === 'brief';
  const Icon = ICONS[s.kind];
  const op = operationOf(s, trace);
  const isError = stepIsError(s, catalog);
  const tone = isError ? 'text-danger' : 'text-foreground';
  // Имена справочника вместо хоста и пути; без справочника — как раньше.
  const sysName = systemName(catalog) ?? (brief ? briefSystem(s.system) : s.system ? systemLabel(s.system) : '—');
  const method = methodName(catalog);
  // «Кратко»: хоста, метода и адреса нет ни в строке, ни в подсказке.
  // У Бизнеса заголовка записи нет: путь шаблоном из адреса записи.
  // У обмена с одной системой пути нет: второй части подписи тоже нет.
  const briefPath = brief ? (method ?? briefMethod({ uri: s.kind === 'exchange' ? s.title : s.title || record?.http?.uri })) : null;
  const exchangeTail = op ? sysName : (briefPath ?? method ?? <PathTitle title={s.title} />);
  return (
    <li
      role="option"
      aria-selected={selected}
      tabIndex={tabIndex}
      data-step={s.id}
      data-kind={s.kind}
      data-error={isError || undefined}
      data-no-response={s.noResponse || undefined}
      onClick={onSelect}
      className={cn(
        COLS,
        'cursor-pointer outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
        selected && 'bg-accent shadow-[inset_3px_0_0_var(--color-primary)] hover:bg-accent',
      )}
    >
      <div className="flex h-8 min-w-0 items-center gap-1.5 pr-2" style={{ paddingLeft: 12 + s.depth * 14 }}>
        <Icon className={cn('size-3.5 shrink-0', isError ? 'text-danger' : 'text-muted-foreground')} role="img" aria-label={t(`trace.kind.${s.kind}`)} />
        {/* Одна строка при любой ширине: обмен — операцией или системой, за ней приглушённо система или путь. */}
        {s.kind === 'exchange' ? (
          <span className="min-w-0 flex-1 truncate text-[13px]" title={(brief ? [op, sysName, op ? null : briefPath] : [op, method, systemName(catalog), host, s.title]).filter(Boolean).join(' · ')} data-testid="step-row-title">
            <span className={cn('font-medium', tone)}>{op ?? sysName}</span>
            {exchangeTail && (
              <span className="text-muted-foreground">
                {' · '}
                {exchangeTail}
              </span>
            )}
          </span>
        ) : s.kind === 'incoming' ? (
          briefPath || method ? (
            <span className={cn('min-w-0 flex-1 truncate text-[13px] font-medium', tone)} title={briefPath ?? `${method} · ${s.title}`} data-testid="step-row-title">
              {briefPath ?? method}
            </span>
          ) : (
            <PathTitle title={s.title} className={cn('min-w-0 flex-1 truncate text-[13px] font-medium', tone)} data-testid="step-row-title" />
          )
        ) : (
          <span className={cn('min-w-0 flex-1 truncate text-[13px]', tone, s.kind === 'call' && 'font-medium')} title={titleText(s)} data-testid="step-row-title">
            {titleText(s) || upperFirst(t(`trace.kind.${s.kind}`))}
          </span>
        )}
      </div>
      <div className="relative mx-3 h-8 bg-[linear-gradient(to_right,var(--color-border)_1px,transparent_1px)] bg-[length:25%_100%] shadow-[inset_-1px_0_0_var(--color-border)]">
        <Bar step={s} trace={trace} orphan={s.kind === 'exchange' && record?.kind === 'response'} verdict={stepVerdict(s, catalog)} />
      </div>
    </li>
  );
}

const hatch = (color: string): CSSProperties => ({
  backgroundImage: `repeating-linear-gradient(135deg, ${color} 0 2px, transparent 2px 6px)`,
});

function Bar({ step: s, trace, orphan, verdict }: { step: TraceStep; trace: Trace; orphan: boolean; verdict: StepVerdict | null }) {
  const { t } = useTranslation();
  const p0 = percent(s.startMs, trace.totalMs);
  const p1 = percent(s.endMs, trace.totalMs);

  if (s.kind === 'log') {
    return (
      <span
        className={cn('absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-card', (verdict ? verdict === 'error' : s.isError) ? 'bg-danger' : 'bg-muted-foreground/60')}
        style={{ left: `${p0}%` }}
        data-testid="step-bar"
      />
    );
  }

  let fill = 'bg-muted-foreground/70';
  let style: CSSProperties = {};
  let solid = true;
  if (s.kind === 'incoming') {
    fill = 'bg-primary/15 ring-1 ring-inset ring-primary/45';
    solid = false;
  } else if (s.kind === 'call') fill = 'bg-primary/75';
  else if (s.noResponse) {
    const color = s.pending ? 'var(--color-muted-foreground)' : 'var(--color-danger)';
    fill = cn('border border-dashed bg-card', s.pending ? 'border-muted-foreground/60' : 'border-danger/60');
    style = hatch(color);
    solid = false;
  } else if (verdict === 'error' || (verdict === null && s.isError)) fill = 'bg-danger';
  // Справочник: «в обработке» — нейтрально с часами, «успех» — зелёный, «не ошибка» — нейтрально.
  else if (verdict === 'pending' || verdict === 'ignored') fill = 'bg-muted-foreground/50';
  else if (verdict === 'success' || (s.status !== null && s.status >= 200 && s.status < 300)) fill = 'bg-success';

  const label = s.noResponse
    ? t(noAnswerKey(s))
    : orphan
      ? t('trace.noSend')
      : s.durationMs !== null
        ? formatDuration(s.durationMs)
        : null;

  // Подпись — справа от полосы, если есть место; иначе слева; полоса почти во всю шкалу — внутри неё.
  let labelStyle: CSSProperties;
  let inside = false;
  if (p1 <= 72) labelStyle = { left: `calc(${p1}% + 6px)` };
  else if (p0 >= 28) labelStyle = { right: `calc(${100 - p0}% + 6px)` };
  else {
    inside = true;
    labelStyle = s.noResponse ? { left: `calc(${p0}% + 6px)` } : { right: `calc(${100 - p1}% + 6px)` };
  }

  return (
    <>
      <span
        className={cn('absolute top-1/2 h-2.5 -translate-y-1/2 rounded-[3px]', fill, inside && solid && 'h-4', inside && !solid && s.kind === 'incoming' && 'h-4')}
        style={{ ...style, left: `${p0}%`, width: `max(${p1 - p0}%, 3px)` }}
        data-testid="step-bar"
      />
      {label && (
        <span
          className={cn(
            'tabular absolute top-1/2 -translate-y-1/2 text-[11.5px] leading-4 whitespace-nowrap',
            !inside && 'text-muted-foreground',
            inside && solid && 'font-medium text-primary-foreground',
            inside && s.kind === 'incoming' && 'font-medium text-primary',
            inside && s.noResponse && 'rounded-[4px] bg-card px-1 text-foreground',
          )}
          style={labelStyle}
          data-testid="step-label"
        >
          {verdict === 'pending' && <Clock className="mr-0.5 inline size-3 align-[-2px]" aria-hidden />}
          {label}
        </span>
      )}
    </>
  );
}
