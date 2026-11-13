// Таблица запросов операции: строка 56 px,
// буква, название с ролью, кто позвал, начало, длительность, общая шкала, итог. Опросы партнёра одной строкой, больше 50 строк
// показываются кнопкой. Название ведёт на запрос, остальная строка раскрывает шаги потока: код графа грузится при первом раскрытии.
import type { FlowRole, OperationFlow, OperationGroup, OperationItem, OperationView } from '@threadline/core/flow';
import type { SearchState } from '@threadline/core/search';
import type { ViewMode } from '@threadline/core/view';
import type { TFunction } from 'i18next';
import { ChevronDown, CircleCheck, CircleX, Clock, Repeat, Timer, TriangleAlert } from 'lucide-react';
import { useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { Tooltip } from '@/components/ui/tooltip.tsx';
import { StatusLegendText } from '@/features/search/StatusChip.tsx';
import { useShareMode } from '@/features/share/mode.ts';
import { briefTitle } from '@/features/view/brief.ts';
import { formatDuration, shortCid, shortDateTime, timeParts, upperFirst } from '@/lib/format.ts';
import { readableTitle } from '@/lib/path-template.ts';
import type { Selection } from '@/lib/selection.ts';
import { cn } from '@/lib/utils.ts';
import { FlowPreview } from './FlowPreview.tsx';
import {
  barOf,
  cutOf,
  flowKey,
  flowTarget,
  lettersOf,
  scaleTicks,
  typeName,
  type OperationLinkState,
  type OperationScale,
} from './model.ts';

/** Больше стольких строк таблица показывает кнопкой «Показать все»: всё уже в памяти, к хранилищу запросов нет. */
export const ROW_LIMIT = 50;

// Колонки: начало шириной 72 или 92 px, если окно идёт через полночь, длительность шире по языку: «23 soat 59 daq» длиннее «23 ч 59 м».
// Шкала 200–360 px растёт вместе с центром. В компактном режиме шкалы и «Кто позвал» нет.
const GRID =
  'grid items-center gap-x-4 px-5 [grid-template-columns:28px_minmax(0,1.2fr)_minmax(0,1fr)_var(--op-start)_var(--op-dur)_clamp(200px,14vw,360px)_minmax(0,1.4fr)_24px] compact:gap-x-3 compact:px-3 compact:[grid-template-columns:28px_minmax(0,1.2fr)_var(--op-start)_var(--op-dur)_minmax(0,1fr)_24px]';
const ROW = 'h-14 border-b border-border transition-colors';
const SUBLINE = 'block min-w-0 truncate text-[12px] leading-4 text-muted-foreground';

const statusName = (s: { name: string | null; raw: string; value: string }) => s.name ?? (s.raw || s.value);

interface RowContext {
  op: OperationView;
  s: SearchState;
  selection: Selection;
  link: OperationLinkState;
  tz: string;
  mode: ViewMode;
  multiDay: boolean;
  scale: OperationScale | null;
  letters: ReadonlyMap<string, string>;
}

export function OperationFlows({
  op,
  s,
  selection,
  link,
  tz,
  mode,
  multiDay,
  done,
  scale,
}: Omit<RowContext, 'letters'> & { done: boolean }) {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  const { rows, flows } = lettersOf(op.items);
  const shown = all ? op.items : op.items.slice(0, ROW_LIMIT);
  const context: RowContext = { op, s, selection, link, tz, mode, multiDay, scale, letters: flows };
  const columns = { '--op-start': multiDay ? '92px' : '72px', '--op-dur': '76px' } as CSSProperties;
  return (
    <div className="min-w-0" style={columns}>
      {/* Подписи колонок только для глаза: каждая строка читается сама. */}
      <div aria-hidden className={cn(GRID, 'h-8 border-b border-border text-[12px] leading-4 font-medium text-muted-foreground')}>
        <span />
        <span className="truncate">{t('operation.table.request')}</span>
        <span className="truncate compact:hidden">{t('operation.table.caller')}</span>
        <span className="truncate">{t('operation.table.start')}</span>
        <span className="truncate text-right">{t('operation.table.duration')}</span>
        <Ticks scale={scale} />
        <span className="truncate">{t('operation.table.outcome')}</span>
        <span />
      </div>
      <ol className="flex min-w-0 flex-col" data-testid="operation-flows">
        {/* Пока поиск идёт и потоков нет, пустая таблица читалась бы как вывод: заготовки той же высоты. */}
        {!done &&
          op.items.length === 0 &&
          [0, 1, 2].map((i) => (
            <li key={i} className={cn(GRID, ROW)} data-testid="operation-flow-skeleton">
              <Skeleton className="size-6 rounded-[6px]" />
              <Skeleton className="h-4 w-full max-w-64" />
            </li>
          ))}
        {shown.map((item, i) => (
          <ItemRow key={itemKey(item, i)} item={item} first={i === 0} letter={rows[i] ?? null} {...context} />
        ))}
      </ol>
      {!all && op.items.length > ROW_LIMIT && (
        <div className="flex justify-center pt-3">
          <Button variant="secondary" onClick={() => setAll(true)} data-testid="operation-show-all">
            {t('operation.table.showAll', { count: op.items.length })}
          </Button>
        </div>
      )}
    </div>
  );
}

const itemKey = (it: OperationItem, i: number) =>
  it.kind === 'flow' ? flowKey(it) : it.kind === 'group' ? `g:${it.cids[0] ?? i}` : `${it.kind}:${it.fromMs}:${i}`;

/** Подпись шкалы круглая: «10 с», а не «10,0 с», «1 ч», а не «1 ч 00 м». */
const tickLabel = (ms: number) => formatDuration(ms).replace(/[.,]0+(?=\s)/, '').replace(/\s0+\s\S+$/, '');

function Ticks({ scale }: { scale: OperationScale | null }) {
  return (
    <div className="tabular relative h-4 min-w-0 compact:hidden">
      {scale &&
        scaleTicks(scale.spanMs).map((tick, i) => (
          <span key={tick.ms} className={cn('absolute top-0 whitespace-nowrap', i > 0 && '-translate-x-1/2')} style={{ left: `${tick.left}%` }}>
            {i === 0 ? '0' : tickLabel(tick.ms)}
          </span>
        ))}
    </div>
  );
}

type BarTone = 'ok' | 'error' | 'neutral';

/** Открытый край полосы растворяется на 12 px, но не больше чем на половину: метка 4 px у края остаётся видна. */
function openMask({ start, end }: { start: boolean; end: boolean }): string | undefined {
  if (!start && !end) return undefined;
  const from = start ? 'transparent, #000 min(12px, 50%)' : '#000';
  const to = end ? '#000 max(50%, calc(100% - 12px)), transparent' : '#000';
  return `linear-gradient(to right, ${from}, ${to})`;
}

/**
 * Дорожка: положение — начало, ширина — длительность, не уже 4 px. Параллельные запросы перекрываются, пауза видна расстоянием.
 * open: отрезок может выйти за шкалу (опросы партнёра), на обрезанной стороне полоса без скругления и растворяется.
 */
function Track({ scale, label, bars, selected }: { scale: OperationScale | null; label: string; bars: { fromMs: number; toMs: number; tone: BarTone; open?: boolean }[]; selected?: boolean }) {
  return (
    <div role="img" aria-label={label} className="relative h-5 min-w-0 compact:hidden">
      <span aria-hidden className="absolute inset-x-0 top-[9px] h-0.5 rounded-[1px] bg-border" />
      {scale &&
        bars.map((b, i) => {
          const { left, width } = barOf(scale, b.fromMs, b.toMs);
          const cut = b.open ? cutOf(scale, b.fromMs, b.toMs) : { start: false, end: false };
          return (
            <i
              key={i}
              data-tone={b.tone}
              data-open={cut.start && cut.end ? 'both' : cut.start ? 'start' : cut.end ? 'end' : undefined}
              className={cn(
                'absolute top-1 block h-3 min-w-1',
                cut.start && cut.end ? 'rounded-none' : cut.start ? 'rounded-r-[3px]' : cut.end ? 'rounded-l-[3px]' : 'rounded-[3px]',
                b.tone === 'error' ? 'bg-danger' : b.tone === 'neutral' ? 'bg-input/50' : 'bg-muted-foreground',
                selected && 'shadow-[0_0_0_2px_var(--background),0_0_0_4px_var(--ring)]',
              )}
              style={{ left: `min(${left}%, calc(100% - 4px))`, width: `${width}%`, maskImage: openMask(cut) }}
            />
          );
        })}
    </div>
  );
}

function Letter({ text, error }: { text: string; error?: boolean }) {
  return (
    <span className={cn('tabular flex h-6 min-w-6 items-center justify-center justify-self-start rounded-[6px] px-1 text-[12px] font-[650]', error ? 'bg-danger-bg text-danger' : 'bg-sunk text-foreground-2')}>
      {text}
    </span>
  );
}

function Expand({ open, label, onToggle }: { open: boolean; label: string; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-label={label}
      onClick={onToggle}
      className="flex size-6 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-sunk hover:text-foreground"
    >
      <ChevronDown className={cn('size-4 transition-transform', open && 'rotate-180')} aria-hidden />
    </button>
  );
}

/** Вся строка раскрывает так же, как кнопка: кроме ссылок, кнопок и выделения текста. */
const rowToggle = (toggle: () => void) => (e: MouseEvent) => {
  if ((e.target as Element).closest('a, button')) return;
  if (window.getSelection()?.toString()) return;
  toggle();
};

/** Пауза и ключ связи: «через 5 мин · связь: id перевода», «одновременно». В «Кратко» ключ только названием типа. */
function gapText(t: TFunction, item: OperationFlow | OperationGroup, op: OperationView, brief: boolean): string {
  const flow = item.kind === 'flow' ? item : item.flows[0];
  const type = flow?.linkedBy[0]?.type;
  const named = type ? typeName(op, type) : null;
  const key = brief && named === type ? null : named;
  // У первого потока предыдущего нет: времени нет, остаётся ключ связи.
  return [
    item.pauseMs === null ? null : item.together ? t('operation.gap.together') : t('operation.gap.after', { duration: formatDuration(item.pauseMs) }),
    key ? t('operation.gap.by', { key }) : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

const CALLER: Record<FlowRole, 'partner' | 'external' | 'worker' | null> = {
  start: 'partner',
  call: 'partner',
  status: 'partner',
  callback: 'external',
  worker: 'worker',
  mention: null,
};

/** Кто позвал: роль потока, у фоновой задачи в «Подробно» ещё компонент из сводки запроса. */
function callerText(t: TFunction, role: FlowRole, component: string | null): string {
  const who = CALLER[role];
  if (!who) return '—';
  const name = t(`operation.caller.${who}`);
  return who === 'worker' && component ? `${name} · ${component}` : name;
}

function ItemRow({ item, first, letter, ...p }: RowContext & { item: OperationItem; first: boolean; letter: string | null }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const brief = p.mode === 'brief';
  const clock = (ms: number) => (p.multiDay ? shortDateTime(ms, p.tz) : timeParts(ms, p.tz).time.slice(0, 5));

  if (item.kind === 'polls') {
    return (
      <li className={cn(GRID, ROW, 'bg-sub text-foreground-2')} data-kind="polls">
        <span className="flex h-6 w-6 items-center justify-center text-muted-foreground">
          <Repeat className="size-3.5" aria-hidden />
        </span>
        <span className="flex min-w-0 flex-col items-start">
          <Tooltip content={t('operation.polls.hint')}>
            <span tabIndex={0} className="block max-w-full truncate font-semibold text-foreground">
              {t('operation.polls.title', { count: item.count })}
            </span>
          </Tooltip>
          <span className={cn(SUBLINE, 'tabular')}>
            {clock(item.fromMs)}–{clock(item.toMs)}
          </span>
        </span>
        <span className="truncate compact:hidden">{t('operation.caller.partner')}</span>
        <span className="tabular whitespace-nowrap text-muted-foreground">{clock(item.fromMs)}</span>
        <span />
        {/* Время опросов известно с точностью до куска подсчёта: часть отрезка на шкале, за краем полоса открыта. */}
        <Track scale={p.scale} label={t('operation.table.scaleNoLetter')} bars={[{ fromMs: item.fromMs, toMs: item.toMs, tone: 'neutral', open: true }]} />
        <span className="truncate text-muted-foreground">{t('operation.polls.notRead')}</span>
        <span />
      </li>
    );
  }

  if (item.kind === 'unread') {
    return (
      <li className="flex min-h-14 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-warning-bg/50 px-5 py-2 text-[13px] compact:px-3" data-kind="unread">
        <TriangleAlert className="size-4 shrink-0 text-warning" aria-hidden />
        <span className="font-medium text-warning">
          {t('operation.unread.title', { count: item.count, from: clock(item.fromMs), to: clock(item.toMs) })}
        </span>
        <span className="text-muted-foreground">{t(item.reason === 'segments' ? 'operation.unread.segments' : 'operation.unread.limit')}</span>
      </li>
    );
  }

  if (item.kind === 'flow') {
    return (
      <li data-kind="flow" data-role={item.role}>
        <FlowRow flow={item} letter={letter ?? ''} gap={!first && item.role !== 'mention' ? gapText(t, item, p.op, brief) : ''} {...p} />
      </li>
    );
  }

  const shownTitle = item.titleCode ? t(`operation.flowTitle.${item.titleCode}`) : brief ? briefTitle(item.title, item.role === 'worker') : readableTitle(item.title);
  const gap = first ? '' : gapText(t, item, p.op, brief);
  const role = upperFirst(t(`operation.role.${item.role}`));
  const sub = [role, t('operation.row.group', { count: item.cids.length }), gap].filter(Boolean).join(' · ');
  const toggle = () => setOpen((v) => !v);
  return (
    <li data-kind="group" data-role={item.role}>
      <div className={cn(GRID, ROW, 'cursor-pointer', open ? 'bg-accent' : 'hover:bg-sub')} onClick={rowToggle(toggle)}>
        <Letter text={letter ?? ''} error={item.failed > 0} />
        <span className="flex min-w-0 flex-col">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 truncate font-semibold text-heading" title={shownTitle}>
              {shownTitle}
            </span>
            {item.role === 'worker' && <Timer className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
          </span>
          <span className={SUBLINE} title={sub}>
            {sub}
          </span>
        </span>
        <span className="min-w-0 truncate text-foreground-2 compact:hidden">{callerText(t, item.role, null)}</span>
        <StartCell ms={item.firstMs} tz={p.tz} multiDay={p.multiDay} />
        <DurationCell ms={item.lastMs - item.firstMs} />
        <Track
          scale={p.scale}
          label={letter ? t('operation.table.scale', { letter }) : t('operation.table.scaleNoLetter')}
          bars={item.flows.map((f) => ({ fromMs: f.firstMs, toMs: f.lastMs, tone: f.error ? 'error' : 'ok' }))}
          selected={open}
        />
        <span className="flex min-w-0 flex-col">
          {item.lastStatus && <StatusLine status={item.lastStatus} />}
          {item.failed > 0 && <span className="truncate text-danger">{t('operation.row.failed', { count: item.failed })}</span>}
        </span>
        <Expand open={open} label={t(open ? 'operation.row.collapse' : 'operation.row.expand', { title: shownTitle })} onToggle={toggle} />
      </div>
      {open && (
        <ol className="min-w-0 bg-sub">
          {item.flows.map((f) => (
            <li key={flowKey(f)}>
              <FlowRow flow={f} letter={p.letters.get(flowKey(f)) ?? ''} gap="" {...p} nested />
            </li>
          ))}
        </ol>
      )}
    </li>
  );
}

function StartCell({ ms, tz, multiDay }: { ms: number; tz: string; multiDay: boolean }) {
  const parts = timeParts(ms, tz);
  return (
    <span className="tabular whitespace-nowrap text-muted-foreground" title={`${parts.date} ${parts.time}`}>
      {multiDay ? shortDateTime(ms, tz) : parts.time.slice(0, 8)}
    </span>
  );
}

function DurationCell({ ms }: { ms: number }) {
  return <span className="tabular whitespace-nowrap text-right">{formatDuration(Math.max(0, ms))}</span>;
}

/** Значок и слово статуса операции: красный только у отказа, у остальных цветной лишь значок. */
function StatusLine({ status, note, title }: { status: { name: string | null; raw: string; value: string; outcome?: string | null }; note?: ReactNode; title?: string }) {
  const { icon: Icon, color } =
    status.outcome === 'failure'
      ? { icon: CircleX, color: 'text-danger' }
      : status.outcome === 'success'
        ? { icon: CircleCheck, color: 'text-success' }
        : { icon: Clock, color: 'text-muted-foreground' };
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <Icon className={cn('size-3.5 shrink-0', color)} aria-hidden />
      <span className="min-w-0 truncate" title={title ?? statusName(status)}>
        <span className={status.outcome === 'failure' ? 'text-danger' : 'text-foreground'}>{statusName(status)}</span>
        {note}
      </span>
    </span>
  );
}

/** Итог строки: статус операции, рядом приглушённое «обмен без ошибок»; красная метка только при настоящей ошибке потока. */
function FlowResult({ flow: f }: { flow: OperationFlow }) {
  const { t } = useTranslation();
  const failed = f.error || f.status === 'error';
  const ownStatus = (
    <Tooltip content={<StatusLegendText />}>
      <span className={cn('flex min-w-0 items-center gap-1.5', failed ? 'text-danger' : 'text-foreground')} data-status={failed ? 'error' : 'success'}>
        {failed ? <CircleX className="size-3.5 shrink-0" aria-hidden /> : <CircleCheck className="size-3.5 shrink-0 text-success" aria-hidden />}
        <span className="min-w-0 truncate">{upperFirst(t(`requests.status.${failed ? 'error' : 'success'}`))}</span>
      </span>
    </Tooltip>
  );
  if (!f.opStatus) return f.role === 'mention' ? null : ownStatus;
  const full = [statusName(f.opStatus), f.claimed ? t('operation.trail.claimed') : null, f.role !== 'mention' && !failed ? t('operation.row.exchangeOk') : null].filter(Boolean).join(' · ');
  const notes = (
    <>
      {f.claimed && <span className="text-muted-foreground"> · {t('operation.trail.claimed')}</span>}
      {f.role !== 'mention' && !failed && (
        <span className="text-muted-foreground" data-testid="flow-exchange-ok">
          {' '}
          · {t('operation.row.exchangeOk')}
        </span>
      )}
    </>
  );
  return (
    <span className="flex min-w-0 items-center gap-2">
      <StatusLine status={f.opStatus} note={notes} title={full} />
      {f.role !== 'mention' && failed && <span className="shrink-0">{ownStatus}</span>}
    </span>
  );
}

function FlowRow({
  flow: f,
  letter,
  gap,
  selection,
  link,
  s,
  tz,
  mode,
  multiDay,
  scale,
  nested = false,
}: RowContext & { flow: OperationFlow; letter: string; gap: string; nested?: boolean }) {
  const { t } = useTranslation();
  const share = useShareMode();
  const [open, setOpen] = useState(false);
  const brief = mode === 'brief';
  const target = flowTarget(share, selection, link, f);
  const shownTitle = f.titleCode ? t(`operation.flowTitle.${f.titleCode}`) : brief ? briefTitle(f.title, f.role === 'worker') : readableTitle(f.title);
  const marks = [
    // Название из кода nocid уже говорит то же самое.
    f.nocid && !brief && f.titleCode !== 'nocid' ? { text: t('operation.row.nocid') } : null,
    f.ops > 1 ? { text: t('operation.row.ops', { count: f.ops }) } : null,
    f.noStatus ? { text: t('operation.row.noStatus') } : null,
    // У «id в тексте записи» роль уже в строке: здесь только место совпадения.
    f.role === 'mention' && f.found && !brief ? { text: t(`operation.foundPlace.${f.found}`) } : null,
    f.callbackEarly ? { text: t('operation.row.callbackEarly'), warn: true } : null,
    f.incomplete ? { text: t('requests.incomplete'), warn: true } : null,
  ].filter((x): x is { text: string; warn?: boolean } => x !== null);
  const role = upperFirst(t(`operation.role.${f.role}`));
  const component = !brief && f.role === 'worker' ? (s.requests.find((r) => r.correlationId === f.cid)?.component ?? null) : null;
  const toggle = () => setOpen((v) => !v);
  const error = f.error || f.status === 'error';
  return (
    <>
      <div className={cn(GRID, ROW, 'cursor-pointer', open ? 'bg-accent' : 'hover:bg-sub')} onClick={rowToggle(toggle)}>
        <Letter text={letter} error={error} />
        <span className="flex min-w-0 flex-col">
          <span className="flex min-w-0 items-center gap-1.5">
            <Link
              to={target.to}
              state={target.state}
              replace={false}
              data-flow={flowKey(f)}
              title={brief || f.titleCode ? shownTitle : f.title}
              className={cn('block min-w-0 truncate font-semibold text-heading hover:underline', nested && 'font-medium')}
            >
              {shownTitle}
            </Link>
            {f.role === 'worker' && <Timer className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
          </span>
          <span className={SUBLINE} title={gap ? `${role} · ${gap}` : role}>
            {role}
            {gap && (
              <>
                {' · '}
                <span data-testid="operation-gap">{gap}</span>
              </>
            )}
          </span>
        </span>
        <span className="flex min-w-0 flex-col compact:hidden">
          <span className="truncate text-foreground-2" title={callerText(t, f.role, component)}>
            {callerText(t, f.role, component)}
          </span>
          {!brief && !f.nocid && <code className="truncate font-mono text-[12px] leading-4 text-muted-foreground">{shortCid(f.cid)}</code>}
        </span>
        <StartCell ms={f.firstMs} tz={tz} multiDay={multiDay} />
        <DurationCell ms={f.lastMs - f.firstMs} />
        <Track scale={scale} label={t('operation.table.scale', { letter })} bars={[{ fromMs: f.firstMs, toMs: f.lastMs, tone: error ? 'error' : 'ok' }]} selected={open} />
        <span className="flex min-w-0 flex-col">
          <FlowResult flow={f} />
          {marks.length > 0 && (
            <span className={SUBLINE} title={marks.map((m) => m.text).join(' · ')}>
              {marks.map((m, i) => (
                <span key={m.text} className={m.warn ? 'text-warning' : undefined}>
                  {i > 0 ? ' · ' : ''}
                  {m.text}
                </span>
              ))}
            </span>
          )}
        </span>
        <Expand open={open} label={t(open ? 'operation.row.close' : 'operation.row.open', { title: shownTitle })} onToggle={toggle} />
      </div>
      {open && <FlowPreview flow={f} target={target} jobId={share?.id ?? s.id} brief={brief} />}
    </>
  );
}
