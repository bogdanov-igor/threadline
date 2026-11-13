import { rowKey, type ErrorReason, type RequestSummary } from '@threadline/core/search';
import { visibleColumns, type ListColumn } from '@threadline/core/view';
import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, type CSSProperties, type KeyboardEvent, type ReactNode, type Ref } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { ParamChips, PathTitle, titleParams } from '@/components/path/PathTitle.tsx';
import { Chip } from '@/components/ui/chip.tsx';
import { CopyIconButton } from '@/components/ui/copy-button.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { Tooltip } from '@/components/ui/tooltip.tsx';
import { briefReason, catalogReasonView, entryName } from '@/features/catalog/names.ts';
import { shareRequestLink, useShareMode, type ShareMode } from '@/features/share/mode.ts';
import { briefMethod } from '@/features/view/brief.ts';
import { useView } from '@/features/view/context.tsx';
import { formatDuration, formatInt, shortCid, timeParts } from '@/lib/format.ts';
import { patchHistoryState } from '@/lib/history-state.ts';
import { requestPath, type Selection } from '@/lib/selection.ts';
import { cn } from '@/lib/utils.ts';
import { useSearchSession } from './session.tsx';
import { StatusChip, StatusWidthSizer } from './StatusChip.tsx';

// Строки одной высоты. Уже 1280px — две строки: путь, под ним компонент, длительность и итог; correlation_id — значком копирования.
// Шире — одна сетка на всю таблицу (строки — её подсетки), колонки заданной ширины.
// Набор колонок задаёт настройка проекта для режима, поэтому шаблон идёт через переменную, а место ячейки — через --c.
// Крайние колонки шире на отступ строки 20px: в подсетке отступ занимает место крайней колонки.
const FRAME_GRID = 'xl:grid xl:grid-cols-[var(--list-cols)] xl:content-start xl:gap-x-4';
const PAD = 20;
const FIXED: Record<Exclude<ListColumn, 'request' | 'outcome'>, number> = { time: 72, component: 110, duration: 72, records: 60, cid: 170 };
// Статус и длительность шире на языке с длинными словами: ширина колонки от невидимой метки в шапке, постоянная для языка.
const FLEXIBLE: Partial<Record<ListColumn, boolean>> = { duration: true };
// Запрос не зависит от выключенных колонок: всё освободившееся место получает итог. Доли и остаток посчитаны от ширин колонок: 1,3 к 1,6 в «Подробно», 1,3 к 1,9 в «Кратко».
const REQUEST_WIDTH = { full: 'minmax(0,calc((100% - 732px) * 0.448))', brief: 'minmax(0,calc((100% - 344px) * 0.406))' };
const OUTCOME_WIDTH = 'minmax(10rem,1fr)';

function trackOf(c: ListColumn, brief: boolean, last: boolean): string {
  if (c === 'request') return REQUEST_WIDTH[brief ? 'brief' : 'full'];
  if (c === 'outcome') return OUTCOME_WIDTH;
  const px = FIXED[c] + (last ? PAD : 0);
  return FLEXIBLE[c] ? `minmax(${px}px,max-content)` : `${px}px`;
}

const SUB = 'xl:col-span-full xl:grid xl:grid-cols-subgrid';
const ROW = 'grid grid-cols-[minmax(0,1fr)_auto]';
const LINK_SUB = 'xl:[grid-column:span_var(--link-span)/span_var(--link-span)] xl:grid-cols-subgrid';
const COLS = `grid-cols-[24px_64px_auto_auto_minmax(0,1fr)] grid-rows-[24px_20px] xl:grid-rows-[minmax(0,1fr)] ${LINK_SUB}`;
const HEAD_COLS = `grid-cols-[24px_64px_minmax(0,1fr)] ${LINK_SUB}`;
const AT = 'xl:row-[1/2] xl:[grid-column:var(--c)]';
const ROW_H = 'h-[60px] xl:h-11';
// Шапка таблицы закреплена: шапка и строки стоят в одной строке сетки, иначе закреплённой ячейке некуда двигаться. Строки отступают на её высоту.
const HEAD_H = 'h-9';
const UNDER_HEAD = 'xl:[grid-row:1] xl:pt-9';
/** Высота закреплённой шапки приложения: строка под ней не видна. */
const HEADER_PX = 56;

/** Колонки режима: шаблон сетки и охват ссылки строки (всё, кроме ID запроса, который стоит вне ссылки). */
function useColumns() {
  const { mode, view } = useView();
  return useMemo(() => {
    const list = visibleColumns(view, mode);
    const inLink = list.filter((c) => c !== 'cid');
    const brief = mode === 'brief';
    const vars = {
      '--list-cols': [`minmax(${96 + PAD}px,max-content)`, ...list.map((c, i) => trackOf(c, brief, i === list.length - 1))].join(' '),
      '--link-span': inLink.length + 1,
    } as CSSProperties;
    const place = (c: Exclude<ListColumn, 'cid'>) => ({ '--c': inLink.indexOf(c) + 2 }) as CSSProperties;
    // ID запроса выключен: последняя колонка не должна упираться в рамку списка.
    const endPad = list.includes('cid') ? undefined : 'pr-5';
    return { list, inLink, vars, place, endPad, has: (c: ListColumn) => list.includes(c), brief };
  }, [mode, view]);
}

/** Запрос открыт строкой этого списка: сколько записей истории лежит между ним и результатами и какая кнопка перехода была в фокусе. */
export interface ResultListMark {
  steps: number;
  focus?: 'prev' | 'next';
}

/** Состояние перехода на страницу запроса: страница берёт записи из задания и ведёт обратно к результатам. */
export interface RequestNavState {
  searchId: string;
  /** Поиск по нескольким средам: его среды. По ним «К результатам» ведёт к общему списку, а запрос читается из части своей среды. */
  envs?: string[];
  /** Статус из строки: заготовка страницы запроса сразу оставляет место под причины. */
  status?: 'error' | 'success';
  /** Нет поля: открыт не из списка, например из «Всех записей». */
  resultList?: ResultListMark;
}

/** Адрес запроса из списка: у строки и у перехода к соседнему результату один и тот же, со своими границами запроса. */
/** Строка поиска по нескольким средам открывает запрос в своей среде; envs — среды поиска, по ним страница запроса ведёт обратно. */
export function rowLink(r: RequestSummary, selection: Selection, searchId: string, share: ShareMode | null, resultList: ResultListMark = { steps: 0 }, envs?: readonly string[]) {
  if (!share) {
    const env = r.env ?? selection.env.id;
    const stand = r.env ? undefined : selection.stand;
    return { to: requestPath(selection.project.id, env, stand, r.correlationId, r.firstMs, r.lastMs), state: { searchId, status: r.status, resultList, ...(r.env && envs ? { envs: [...envs] } : {}) } satisfies RequestNavState };
  }
  const link = shareRequestLink(share, { cid: r.correlationId, status: r.status, env: r.env });
  return { to: link.to, state: { ...link.state, resultList } };
}

const validTime = (ms: number) => Number.isFinite(ms) && ms > 0;

/** Разделитель дня: день первой записи в поясе проекта, «Сегодня · 02.11», «Вчера · 01.11», раньше только дата. */
function useDayLabels(requests: readonly RequestSummary[], timeZone: string): (string | null)[] {
  const { t } = useTranslation();
  const now = Date.now();
  const today = timeParts(now, timeZone).date;
  const yesterday = timeParts(now - 24 * 60 * 60 * 1000, timeZone).date;
  // Ввод в поле поиска и опрос без новых строк не пересчитывают дни всех строк; смена суток — пересчитывает.
  return useMemo(
    () =>
      requests.map((r) => {
        if (!validTime(r.firstMs)) return null;
        const { date } = timeParts(r.firstMs, timeZone);
        const short = date.slice(0, 5);
        if (date === today) return t('requests.day.today', { date: short });
        return date === yesterday ? t('requests.day.yesterday', { date: short }) : short;
      }),
    [requests, timeZone, today, yesterday, t],
  );
}

export function RequestsTable({
  requests,
  selection,
  searchId,
  focusCid,
}: {
  requests: RequestSummary[];
  selection: Selection;
  searchId: string;
  /** Ключ строки запроса, с которого вернулись: correlation_id, у поиска по нескольким средам со средой. Строка получает фокус. */
  focusCid: string | null;
}) {
  const { t } = useTranslation();
  const session = useSearchSession();
  const listRef = useRef<HTMLUListElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const focused = useRef(false);
  const days = useDayLabels(requests, selection.project.timezone);

  // В рабочем режиме прокручивается таблица: браузер её прокрутку при возврате не помнит. Обычная прокрутка страницы этим не затронута.
  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    frame.scrollTop = session.ui(searchId).scrollTop ?? 0;
    return () => session.saveUi(searchId, { scrollTop: frame.scrollTop });
  }, [session, searchId]);

  useEffect(() => {
    if (!focusCid || focused.current) return;
    const row = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-key]') ?? [])].find((el) => el.dataset.key === focusCid);
    const link = row?.querySelector<HTMLElement>('[data-row-link]');
    if (!link) return;
    focused.current = true;
    link.focus({ preventScroll: true });
    // При возврате прокрутка уже прежняя: строка на экране, страница не сдвигается. После переходов между результатами строка могла уйти за край.
    const r = link.getBoundingClientRect();
    const frame = frameRef.current?.getBoundingClientRect();
    const scrolls = !!frameRef.current && frameRef.current.scrollHeight > frameRef.current.clientHeight;
    const top = scrolls && frame ? frame.top + 36 : HEADER_PX;
    const bottom = scrolls && frame ? frame.bottom : window.innerHeight;
    if (r.top < top || r.bottom > bottom) link.scrollIntoView({ block: 'center' });
  }, [focusCid, requests]);

  // Стрелки вверх и вниз переходят между строками.
  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const links = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-row-link]')];
    const i = links.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    e.preventDefault();
    links[Math.max(0, Math.min(links.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
  };

  return (
    <TableFrame frameRef={frameRef}>
      {/* role=list: разделитель дня не элемент списка, а Safari и axe не теряют семантику. */}
      <ul ref={listRef} role="list" aria-label={t('requests.label')} onKeyDown={onKeyDown} className={cn(SUB, UNDER_HEAD)}>
        {requests.map((r, i) => (
          <Fragment key={rowKey(r)}>
            {days[i] && days[i] !== days[i - 1] && (
              <li role="none" data-day className={cn(SUB, 'flex h-7 items-center border-b border-border bg-sub px-5 text-[12px] font-semibold text-muted-foreground')}>
                <span className="tabular xl:col-span-full">{days[i]}</span>
              </li>
            )}
            <Row r={r} selection={selection} searchId={searchId} current={rowKey(r) === focusCid} />
          </Fragment>
        ))}
      </ul>
    </TableFrame>
  );
}

const HEAD_RIGHT: ReadonlySet<ListColumn> = new Set(['duration', 'records']);

function TableFrame({ children, frameRef }: { children: ReactNode; frameRef?: Ref<HTMLDivElement> }) {
  const { t } = useTranslation();
  const { inLink, has, vars, endPad } = useColumns();
  return (
    <div
      ref={frameRef}
      style={vars}
      data-testid="requests-frame"
      className={cn('min-h-0 overflow-hidden rounded-[var(--radius-card)] border border-border bg-card work:overflow-y-auto work:scroll-pt-9', FRAME_GRID)}
    >
      <div aria-hidden className={cn(ROW, SUB, HEAD_H, 'items-center border-b border-border bg-sub text-[12px] font-semibold text-muted-foreground xl:sticky xl:top-0 xl:z-[2] xl:[grid-row:1] xl:self-start')}>
        <div className={cn('grid gap-x-3 pl-5 xl:gap-x-4', endPad, HEAD_COLS)}>
          <span className="invisible xl:visible">
            {t('requests.col.status')}
            <StatusWidthSizer />
          </span>
          {inLink.map((c) => (
            <span key={c} className={cn(c !== 'time' && c !== 'request' && 'hidden xl:block', HEAD_RIGHT.has(c) && 'text-right')}>
              {t(`requests.col.${c}`)}
              {/* Самая долгая длительность суток на этом языке: ширина колонки постоянная. */}
              {c === 'duration' && (
                <span aria-hidden className="invisible block h-0 overflow-hidden text-[13.5px] whitespace-nowrap">
                  {formatDuration(LONGEST_DAY_MS)}
                </span>
              )}
            </span>
          ))}
        </div>
        {has('cid') && (
          <span className="hidden pr-5 xl:block" title={t('requests.col.cidHint')}>
            {t('requests.col.cid')}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

const LONGEST_DAY_MS = (23 * 60 + 59) * 60_000;

/** Заготовка списка той же высоты строк, что и список: при появлении запросов ничего не прыгает. */
export function RequestsTableSkeleton({ rows = 3, text }: { rows?: number; text?: string }) {
  const { inLink, has, endPad } = useColumns();
  const width: Partial<Record<ListColumn, string>> = { time: 'h-4 w-14', request: 'h-4 w-3/4', outcome: 'hidden h-4 w-3/5 xl:block', component: 'hidden h-4 w-3/4 xl:block', duration: 'ml-auto hidden h-4 w-12 xl:block', records: 'ml-auto hidden h-4 w-6 xl:block' };
  return (
    <div aria-busy="true" className="flex min-h-0 flex-col">
      <TableFrame>
        {text && <p className="sr-only">{text}</p>}
        <div className={cn(SUB, UNDER_HEAD)}>
          {Array.from({ length: rows }, (_, i) => (
            <div key={i} className={cn(ROW, SUB, ROW_H, 'items-center border-b border-border last:border-b-0')}>
              <div className={cn('grid items-center gap-x-3 pl-5 xl:gap-x-4', endPad, HEAD_COLS)}>
                <Skeleton className="h-6 w-6 xl:w-20" />
                {inLink.map((c) => (
                  <Skeleton key={c} className={width[c]} />
                ))}
              </div>
              {has('cid') && <Skeleton className="mr-5 h-4 w-6 xl:w-24" />}
            </div>
          ))}
        </div>
      </TableFrame>
    </div>
  );
}

// Строка перерисовывается, только когда изменились её свойства: ввод в поле поиска и опрос без новых строк её не трогают.
// Свойства — только стабильные значения: запрос из состояния поиска, выбор, id задания, признак. Замыкание или объект, собранные при рендере, сняли бы мемоизацию.
const Row = memo(function Row({ r, selection, searchId, current }: { r: RequestSummary; selection: Selection; searchId: string; current: boolean }) {
  const { t } = useTranslation();
  const { has, place, brief, endPad } = useColumns();
  // В строке время без миллисекунд, они в подсказке: дата уже в разделителе дня.
  const parts = validTime(r.firstMs) ? timeParts(r.firstMs, selection.project.timezone) : null;
  const firstError = r.status === 'error' ? r.reasons.find((x) => x.kind !== 'pending') : undefined;
  const pendingOnly = r.status === 'success' && r.reasons.some((x) => x.kind === 'pending');
  const pendingText = t('requests.pending');
  const duration = formatDuration(r.durationMs);
  const session = useSearchSession();
  const link = rowLink(r, selection, searchId, useShareMode(), undefined, selection.envs?.map((e) => e.id));
  const key = rowKey(r);
  // Метка среды: только у поиска по нескольким средам.
  const envName = r.env ? (selection.envs?.find((e) => e.id === r.env)?.name ?? r.env) : null;
  const title = r.incoming ? `${r.incoming.method} ${r.incoming.path}` : null;
  // Название входящего метода из справочника; без него — читаемый путь.
  const name = title ? entryName(r) : null;
  const params = title && !brief ? titleParams(title) : [];

  return (
    <li
      data-cid={r.correlationId}
      data-key={key}
      data-env={r.env}
      data-status={r.status}
      data-match={r.match}
      data-first={r.firstMs}
      data-current={current || undefined}
      className={cn(ROW, SUB, ROW_H, 'items-center border-b border-border transition-colors last:border-b-0 hover:bg-accent/40 focus-within:bg-accent/40 data-[current]:bg-accent data-[current]:shadow-[inset_3px_0_0_var(--primary)]')}
    >
      <Link
        to={link.to}
        state={link.state}
        // На странице ссылки адрес тот же, роутер заменил бы запись истории и «Назад» ушёл бы со страницы.
        replace={false}
        // Возврат «Назад» браузера ставит фокус на эту строку, как и «К результатам».
        onClick={() => {
          patchHistoryState({ focusCid: key });
          session.saveUi(searchId, { openedCid: key });
        }}
        data-row-link
        className={cn('grid h-full min-w-0 content-center items-center gap-x-3 gap-y-0.5 pl-5 text-[13.5px] focus-visible:outline-offset-[-2px] xl:gap-x-4', endPad, COLS)}
      >
        <span className="col-[1/2] row-[1/3] flex xl:row-[1/2]">
          <StatusChip status={r.status} compact />
        </span>
        <span style={place('time')} className={cn('tabular col-[2/3] row-[1/3] min-w-0 text-muted-foreground', AT)} title={parts ? `${parts.date} ${parts.time}` : undefined} data-testid="request-time">
          {parts ? parts.time.slice(0, 8) : '—'}
        </span>
        {/* Путь и параметры в одну строку: не поместившиеся метки уходят на скрытую вторую строку. */}
        <span style={place('request')} className={cn('col-[3/6] row-[1/2] flex h-6 min-w-0 flex-wrap items-center gap-x-2 gap-y-2 overflow-hidden', AT)}>
          {/* Метка среды и название не переносятся: на скрытую вторую строку уходят только параметры, название обрезается раньше метки. */}
          <span className={cn('flex max-w-full min-w-0 items-center gap-1.5', !envName && 'contents')}>
            {envName && (
              <span title={envName} className="max-w-[7rem] shrink-0 truncate rounded-[6px] border border-border px-1.5 text-[11.5px] leading-[18px] font-medium text-foreground-2" data-testid="request-env">
                {envName}
              </span>
            )}
            {name ? (
              <span title={brief ? name : (title ?? undefined)} className="max-w-full min-w-0 truncate leading-6 font-semibold text-foreground" data-testid="request-name">
                {name}
              </span>
            ) : title && brief ? (
              <span title={t('view.brief.noName')} className="max-w-full min-w-0 truncate leading-6 text-muted-foreground" data-testid="request-path">
                {briefMethod({ uri: title })}
              </span>
            ) : title ? (
              <PathTitle title={title} className="max-w-full min-w-0 truncate leading-6 font-semibold text-foreground" data-testid="request-path" />
            ) : (
              <HintChip hint={t('requests.backgroundHint')}>{t('requests.background')}</HintChip>
            )}
          </span>
          <ParamChips params={params} static className="flex-nowrap" />
        </span>
        {has('component') && (
          <span style={place('component')} title={r.component ?? undefined} className={cn('col-[3/4] row-[2/3] max-w-[10rem] truncate font-mono text-[12px] text-muted-foreground xl:max-w-none xl:text-[12.5px]', AT)}>
            {r.component ?? '—'}
          </span>
        )}
        {/* Уже 1280px длительность и число записей стоят рядом во второй строке. */}
        {(has('duration') || has('records')) && (
          <span
            style={has('duration') ? place('duration') : undefined}
            className={cn('tabular col-[4/5] row-[2/3] text-[12px] whitespace-nowrap text-muted-foreground xl:text-[13.5px] xl:text-foreground', has('duration') ? cn(AT, 'xl:text-right') : 'xl:hidden')}
          >
            {has('duration') && duration}
            {has('records') && (
              <span className="xl:hidden" data-testid="request-records-inline">
                {has('duration') && ' · '}
                {t('requests.records', { count: r.recordCount })}
              </span>
            )}
          </span>
        )}
        {has('records') && (
          <span style={place('records')} className={cn('tabular hidden text-right text-muted-foreground xl:block', AT)} data-testid="request-records" title={t('requests.records', { count: r.recordCount })}>
            {formatInt(r.recordCount)}
          </span>
        )}
        <span style={place('outcome')} className={cn('col-[5/6] row-[2/3] flex h-5 min-w-0 items-center overflow-hidden text-[12px] xl:h-6 xl:text-[13.5px]', AT)}>
          {firstError && <Reason reason={firstError} brief={brief} />}
          {pendingOnly && (
            <span className="min-w-0 truncate text-muted-foreground" title={pendingText}>
              {pendingText}
            </span>
          )}
          {r.status === 'success' && !pendingOnly && <span className="shrink-0 text-foreground">{t('requests.status.success')}</span>}
          {r.kind === 'maybe-cached' && <Mark hint={t('requests.maybeCachedHint')}>{t('requests.maybeCached')}</Mark>}
          {r.match === 'inexact' && <Mark hint={t('requests.inexactHint')}>{t('requests.inexact')}</Mark>}
          {r.incomplete && <Mark hint={t('requests.incompleteHint')}>{t('requests.incomplete')}</Mark>}
        </span>
      </Link>
      {/* correlation_id: шире 1280px — коротко и значок, уже — только значок; целиком — в подсказке. */}
      {has('cid') && (
        <div className="flex min-w-0 items-center gap-1 pr-3 xl:pr-5">
          <Tooltip content={r.correlationId}>
            <code className="hidden min-w-0 truncate font-mono text-[12px] text-muted-foreground xl:block" data-testid="request-cid">
              {shortCid(r.correlationId)}
            </code>
          </Tooltip>
          <CopyIconButton text={r.correlationId} label={t('requests.copyCid', { cid: r.correlationId })} className="size-6 [&_svg]:size-3.5" />
        </div>
      )}
    </li>
  );
});

/** Причина: что случилось красным, за ним приглушённо — система и коды. Полный текст — в подсказке. */
function Reason({ reason, brief = false }: { reason: ErrorReason; brief?: boolean }) {
  const v = catalogReasonView(reason);
  const short = brief ? briefReason(v) : null;
  const system = short ? short.system : v.system;
  const hint = short ? short.title : v.raw;
  const rest = short ? (short.system ?? '') : [v.system, ...v.codes].filter(Boolean).join(' · ');
  // Текст справочника идёт за системой: «Коммутатор · Карта не найдена».
  if (v.named) {
    return (
      <span className="min-w-0 truncate" data-testid="request-reason" data-source={v.source} title={hint}>
        {system && <span className="text-muted-foreground">{system} · </span>}
        <span className="text-danger">{v.message}</span>
      </span>
    );
  }
  return (
    <span className="min-w-0 truncate" data-testid="request-reason" data-source={v.source} title={hint}>
      <span className="text-danger">{v.message}</span>
      {rest && <span className="text-muted-foreground"> · {rest}</span>}
    </span>
  );
}

/** Пометка серым продолжением итога: «Успешно · неточное совпадение». На узкой строке сжимается раньше причины, полный текст и пояснение в подсказке. */
function Mark({ hint, children }: { hint: string; children: string }) {
  return (
    <Tooltip content={hint}>
      <span className="min-w-0 shrink-[4] truncate whitespace-pre text-muted-foreground">
        <span aria-hidden>{' · '}</span>
        <span>{children}</span>
      </span>
    </Tooltip>
  );
}

function HintChip({ hint, children }: { hint: string; children: string }) {
  return (
    <Tooltip content={hint}>
      <Chip className="h-5 px-1.5 text-[11.5px]">{children}</Chip>
    </Tooltip>
  );
}
