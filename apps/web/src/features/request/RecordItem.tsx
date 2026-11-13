import { recordError } from '@threadline/core/flow';
import { withoutHtmlShown, type ViewRecord } from '@threadline/core/search';
import { ArrowDown, ArrowUp, ChevronRight, ExternalLink } from 'lucide-react';
import { memo, useContext, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Arrow } from '@/components/ui/arrow.tsx';
import { ParamChips, PathTitle, titleParams } from '@/components/path/PathTitle.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Chip, type ChipTone } from '@/components/ui/chip.tsx';
import { Tooltip } from '@/components/ui/tooltip.tsx';
import { useView } from '@/features/view/context.tsx';
import { formatDuration, formatOffset, timeParts } from '@/lib/format.ts';
import { cn } from '@/lib/utils.ts';
import { TeapotSlot } from '@/features/extras/slot.tsx';
import { hasHit } from '@/lib/hits.ts';
import { recordBlocks, visibleBlocks, type Block } from './blocks.ts';
import { PanelStepContext, recordLabel } from './code-window.ts';
import { CodeView } from './CodeView.tsx';
import { HitsContext, RevealContext, withRevealed } from './overlay.ts';
import { recordTitle } from './record-title.ts';

const DANGER_LEVELS = new Set(['ERROR', 'CRITICAL', 'ALERT', 'EMERGENCY']);

function levelTone(level: string): ChipTone {
  const l = level.toUpperCase();
  if (DANGER_LEVELS.has(l)) return 'danger';
  if (l === 'WARNING') return 'warning';
  return 'neutral';
}

// У этих записей сообщение служебное («http request sending»): заголовок уже говорит, что это.
const KNOWN_KINDS = new Set<ViewRecord['kind']>(['incoming', 'call', 'send', 'response']);

/** Список записей одной рамкой: строки через разделитель, без карточки на каждую. */
export const RECORD_LIST = 'overflow-clip rounded-[var(--radius-card)] border border-border bg-card shadow-[var(--shadow-card)] divide-y divide-border';

export interface RecordItemProps {
  record: ViewRecord;
  timeZone: string;
  /** request — запись запроса со смещением; lines — строка «Всех записей» со временем и ссылкой на запрос. */
  mode: 'request' | 'lines';
  expanded: boolean;
  /** Получает id записи: список передаёт одну функцию на все записи, и запись не перерисовывается из-за нового замыкания. */
  onToggle: (id: string) => void;
  highlighted?: boolean;
  onJump?: (id: string) => void;
  requestLink?: { to: string; state?: unknown } | null;
  /** Цель «К первому»: если совпадение только в сырой записи, её блок раскрывается. */
  hitTarget?: boolean;
}

// Запись перерисовывается, только когда изменились её свойства: опрос поиска и раскрытие соседней записи её не трогают.
// Свойства — только стабильные значения: функции из useCallback, ссылка «К запросу» из кэша списка.
export const RecordItem = memo(function RecordItem({ record: r, timeZone, mode, expanded, onToggle, highlighted = false, onJump, requestLink, hitTarget = false }: RecordItemProps) {
  const { t } = useTranslation();
  const { mode: viewMode } = useView();
  const brief = viewMode === 'brief';
  const http = r.http;
  const bodyId = `record-body-${r.id}`;
  const showLevel = r.level && r.level.toUpperCase() !== 'INFO';
  const when = timeParts(r.timeMs, timeZone);
  const title = useMemo(() => recordTitle(r), [r]);
  const status = title.status ?? http?.status ?? null;
  // Страница HTML в сообщении сюда не идёт: на её месте заголовок, как в причине ошибки.
  const message = useMemo(() => withoutHtmlShown(r.message), [r.message]);
  const note = KNOWN_KINDS.has(r.kind) || title.http || message === r.title ? null : message;
  const aside = [mode === 'lines' ? r.component : null, note].filter(Boolean).join(' · ');
  // Цвет задаёт правило итога и отметка «не ошибка», а не только общий признак записи.
  const isError = recordError(r);

  return (
    <li
      id={`record-${r.id}`}
      data-record-id={r.id}
      data-kind={r.kind}
      data-ts={r.tsNs}
      data-time={r.timeMs}
      data-error={isError || undefined}
      className={cn(
        'hover-reveal-group scroll-mt-32',
        isError && 'shadow-[inset_3px_0_0_var(--color-danger)]',
        highlighted && 'bg-accent/60',
      )}
    >
      <div className="flex h-9 min-w-0 items-center">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={() => onToggle(r.id)}
          className="flex h-full min-w-0 flex-1 items-center gap-2.5 pr-2 pl-3 text-left outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          <ChevronRight className={cn('size-4 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-90')} aria-hidden />
          {mode === 'request' ? (
            <Tooltip content={`${when.date} ${when.time}`}>
              <span className="tabular w-[68px] shrink-0 text-[13px] text-muted-foreground" data-testid="record-offset">
                {formatOffset(r.offsetMs ?? 0)}
              </span>
            </Tooltip>
          ) : (
            <span className="tabular w-[84px] shrink-0 text-[13px] text-foreground" title={`${when.date} ${when.time}`}>
              {when.time}
            </span>
          )}
          <span className="flex min-w-[4.75rem] shrink-0">
            <Chip tone={r.kind === 'raw' ? 'warning' : r.kind === 'incoming' ? 'accent' : 'neutral'} className="h-5 px-1.5 text-[11.5px]">
              {t(`record.kind.${r.kind}`)}
            </Chip>
          </span>
          {/* Одна строка: что не поместилось, уходит на скрытую вторую; параметры пути — последними. */}
          <span className="flex h-6 min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-4 overflow-hidden">
            {showLevel && (
              <Chip tone={levelTone(r.level!)} className="h-5 px-1.5 text-[11.5px]">
                {r.level}
              </Chip>
            )}
            <Title record={r} title={title} status={status} isError={isError} brief={brief} />
            {title.gateway && <span className="shrink-0 text-[12px] text-muted-foreground">{t('trace.scheme.gateway')}</span>}
            {r.kind === 'response' && http?.durationMs != null && (
              <Tooltip content={t('record.exchange')}>
                <span className="tabular shrink-0 text-[13px] text-muted-foreground">{formatDuration(http.durationMs)}</span>
              </Tooltip>
            )}
            {http?.noResponse && (
              <Chip tone={http.pending ? 'neutral' : 'danger'} className="h-5 px-1.5 text-[11.5px]">
                {http.pending ? t('record.pending') : t('record.noResponse')}
              </Chip>
            )}
            {r.match === 'inexact' && (
              <Tooltip content={t('requests.inexactHint')}>
                <Chip tone="warning" className="h-5 px-1.5 text-[11.5px]">
                  {t('requests.inexact')}
                </Chip>
              </Tooltip>
            )}
            {!brief && title.http && <ParamChips params={titleParams(title.http)} static copy={false} className="flex-nowrap" />}
          </span>
          {aside && (
            <span className="hidden max-w-[40%] min-w-0 shrink truncate text-[12.5px] text-muted-foreground sm:block" title={aside}>
              {aside}
            </span>
          )}
        </button>
        {(http?.pairId && onJump) || requestLink ? (
          // Действия строки — по наведению или фокусу; на сенсорных экранах видны всегда.
          <div className="hover-reveal flex shrink-0 items-center gap-0.5 pr-1.5">
            {http?.pairId && onJump && (
              <Button type="button" variant="ghost" size="sm" className="h-7 text-primary" onClick={() => onJump(http.pairId!)}>
                {r.kind === 'send' ? <ArrowDown aria-hidden /> : <ArrowUp aria-hidden />}
                {r.kind === 'send' ? t('record.toResponse') : t('record.toSend')}
              </Button>
            )}
            {requestLink && (
              <Button asChild variant="ghost" size="sm" className="h-7 text-primary">
                <Link to={requestLink.to} state={requestLink.state} replace={false}>
                  <ExternalLink aria-hidden />
                  {t('record.openRequest')}
                </Link>
              </Button>
            )}
          </div>
        ) : null}
      </div>
      <div id={bodyId} hidden={!expanded}>
        {expanded && <RecordBody record={r} hitTarget={hitTarget} />}
      </div>
    </li>
  );
});

/** Заголовок записи: «processor · POST /soap/issuing → 200», путь шаблоном; не HTTP — текст как есть. */
function Title({ record: r, title, status, isError, brief }: { record: ViewRecord; title: ReturnType<typeof recordTitle>; status: number | null; isError: boolean; brief: boolean }) {
  const cls = cn('max-w-full min-w-0 truncate text-[13.5px] leading-6', isError ? 'text-danger' : 'text-foreground');
  if (!title.http) {
    return (
      <span className={cn(cls, r.kind === 'call' && 'font-medium')} title={title.text} data-testid="record-title">
        {title.text}
      </span>
    );
  }
  // В «Кратко» система и название или шаблон пути; метода, хоста и статуса нет ни в тексте, ни в подсказке.
  if (brief) {
    const text = recordLabel(r, true);
    return (
      <span className={cn(cls, 'font-medium')} title={text} data-testid="record-title">
        {text}
      </span>
    );
  }
  // Статус ответа — в заголовке; красный, только если запись с ошибкой.
  return (
    <span className={cn(cls, 'font-medium')} title={title.host ? `${title.host} · ${r.title}` : r.title} data-testid="record-title">
      {title.system && (
        <>
          {title.system}
          <span className="font-normal text-muted-foreground"> · </span>
        </>
      )}
      <PathTitle title={title.http} />
      {status !== null && <span className="tabular font-normal"><Arrow />{status}</span>}
      {status === 418 && <TeapotSlot />}
    </span>
  );
}

function RecordBody({ record, hitTarget }: { record: ViewRecord; hitTarget: boolean }) {
  const { t, i18n } = useTranslation();
  const { mode, view, setMode, locked } = useView();
  const overlay = useContext(RevealContext);
  const forms = useContext(HitsContext);
  // Строка логов панели шага: большое окно закрепляется за этим шагом.
  const panelStep = useContext(PanelStepContext);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- заголовки блоков на языке интерфейса
  const blocks = useMemo(() => visibleBlocks(recordBlocks(withRevealed(record, overlay)), view, mode), [record, overlay, view, mode, i18n.language]);
  const onlyRaw = useMemo(() => {
    if (!hitTarget || !forms) return false;
    const shows = (b: Block) => hasHit(b.text, forms) || (b.raw !== null && hasHit(b.raw, forms)) || (b.nested?.items.some((n) => hasHit(n.text, forms)) ?? false);
    return !blocks.some((b) => b.name !== 'raw' && shows(b));
  }, [hitTarget, forms, blocks]);
  // Запись раскрыта в режиме, где ни один её блок не виден: не пустота, а куда идти.
  if (blocks.length === 0) {
    if (locked) return null;
    return (
      <p className="flex min-w-0 flex-wrap items-center gap-x-2 border-t border-border bg-muted/30 px-3 py-2 text-[13px] text-muted-foreground sm:pl-10" data-testid="record-hidden">
        {t('view.recordHidden')}
        <Button type="button" variant="ghost" size="sm" className="h-7 text-primary" onClick={() => setMode('full')}>
          {t('view.toFull')}
        </Button>
      </p>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-2 border-t border-border bg-muted/30 px-3 py-3 sm:pl-10">
      {blocks.map((b) => (
        <CodeView key={b.name} name={b.name} title={b.title} text={b.text} lang={b.lang} raw={b.raw} empty={b.empty} defaultOpen={b.open} nested={b.nested} forceOpen={onlyRaw && b.name === 'raw'} target={{ step: panelStep, tab: null, name: b.name, nth: 0, record: record.id, nested: null }} />
      ))}
    </div>
  );
}
