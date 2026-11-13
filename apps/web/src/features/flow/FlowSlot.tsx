// Место графа на вкладке «Схема». Модель и бюджет считаются здесь, без чанка: высота
// заготовки известна до прихода кода графа, вкладки и панель шага не прыгают. React Flow и dagre — в чанке flow.
import type { OperationKey, Trace, ViewRecord } from '@threadline/core/search';
import { CircleAlert, MessageSquareText, RotateCcw } from 'lucide-react';
import {
  Component,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
import { useTranslation } from 'react-i18next';
import { StateMessage } from '@/components/states/StateMessage.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { recordCatalog } from '@/features/catalog/names.ts';
import { HitsContext, RevealContext, withRevealed } from '@/features/request/overlay.ts';
import { APP } from '@/features/request/trace-model.ts';
import { hasHit } from '@/lib/hits.ts';
import { cn } from '@/lib/utils.ts';
import { useView } from '@/features/view/context.tsx';
import { loadFlow } from './load.ts';
import {
  buildFlowGraph,
  canvasSize,
  relatedKey,
  visibleGraph,
  type FlowEntryInfo,
  type FlowFrame,
  type FlowGraph,
  type FlowViewNode,
  type RelatedFlow,
} from './model.ts';

export interface AppLogs {
  count: number;
  warnings: number;
  errors: number;
}

export interface FlowSlotProps {
  trace: Trace;
  records: readonly ViewRecord[];
  /** Записи запроса неполные: последний узел подписан «дальше записи не прочитаны». */
  incomplete: boolean;
  /** Более поздние потоки операции, если запрос открыт из неё. */
  related: readonly RelatedFlow[];
  app: AppLogs;
  /** Блок логов виден в этом режиме: иначе вместо кнопки логов приложения — число шагов шкалы. */
  logs: boolean;
  /** Шагов на шкале в этом режиме. */
  steps: number;
  selected: string | null;
  onSelect: (stepId: string) => void;
  onOpen: () => void;
  /** Шкала времени; со шагом — выбрать его. */
  onTimeline: (stepId: string | null) => void;
  /** Поток операции по ключу (correlation_id и сегмент); null — страница операции. */
  onRelated: (key: string | null) => void;
  /** Ключи операций потока: действие «Открыть операцию» на узле с ключом. Пусто — действия нет. */
  operationKeys: readonly OperationKey[];
  onOperation: (key: OperationKey) => void;
  className?: string;
  /** Рабочий режим страницы в размер окна: холст занимает всё место колонки. Без него холст по высоте графа. */
  fill?: boolean;
  /** Рамка проекта вокруг шагов. */
  frame?: FlowFrame | null;
  /** Итог запроса и время первой записи для узла входа. */
  entry?: FlowEntryInfo | null;
  /** Меняется с шириной панели шага: холст вписывает граф заново, если человек не двигал его сам. */
  refitKey?: string;
}

class Boundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

// Холст: рабочий режим страницы запроса отдаёт ему всё место (fill). Вне него — по высоте графа, но не выше 60 % окна и места до конца
// первого экрана: панель шага под ним начинается на первом экране. Лишнее двигается панорамой.
// Холст без рамки: точки на фоне страницы, подпись логов приложения стоит на том же поле.
const CANVAS = 'relative min-h-0 overflow-hidden';
const DOTS = 'bg-background bg-[radial-gradient(var(--color-dot)_1.1px,transparent_1.3px)] bg-[length:20px_20px]';
const FLOW_HEIGHT = 'h-[min(var(--flow-h),60dvh,var(--flow-room,60dvh))]';
// Сколько окна оставить под панелью шага: её начало видно на первом экране. Ниже потолка холст не сжимается.
const PANEL_PEEK = 96;
const MIN_CANVAS = 240;
// На низком окне холст уступает: узел выбранного шага и начало панели важнее высоты графа.
const SHORT_WINDOW = 700;
const MIN_CANVAS_SHORT = 180;
/** Под кнопками масштаба: иначе они закрывают нижний узел короткого графа. */
const CONTROLS_ROOM = 48;
/** Больше записей синхронно не проверяем: значки совпадений не важнее отклика страницы. */
const MAX_HIT_RECORDS = 1000;

/** Потолок холста от места на странице: шапка и причины не отодвигают панель шага за первый экран. */
function useCanvasRoom(ref: RefObject<HTMLDivElement | null>): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      const min = window.innerHeight < SHORT_WINDOW ? MIN_CANVAS_SHORT : MIN_CANVAS;
      el.style.setProperty('--flow-room', `${Math.max(min, window.innerHeight - (rect.top + window.scrollY) - PANEL_PEEK)}px`);
    };
    measure();
    window.addEventListener('resize', measure);
    // Причины и шапка меняют высоту, когда приходят данные.
    const observer = new ResizeObserver(measure);
    observer.observe(document.body);
    return () => {
      window.removeEventListener('resize', measure);
      observer.disconnect();
    };
  }, [ref]);
}

export function FlowSlot({
  trace,
  records,
  incomplete,
  related,
  app,
  logs,
  steps,
  selected,
  onSelect,
  onOpen,
  onTimeline,
  onRelated,
  operationKeys,
  onOperation,
  className,
  fill = false,
  frame = null,
  entry = null,
  refitKey,
}: FlowSlotProps) {
  const { t } = useTranslation();
  const { mode } = useView();
  const hintId = useId();
  const scroller = useRef<HTMLDivElement>(null);

  // Связанные потоки приходят с каждым опросом задания операции: граф пересобирается только при их изменении.
  const relatedJson = JSON.stringify(related);
  const stableRelated = useMemo(() => JSON.parse(relatedJson) as RelatedFlow[], [relatedJson]);
  const built = useMemo((): { graph: FlowGraph } | { graph: null } => {
    try {
      return { graph: buildFlowGraph(trace, records, { related: stableRelated, incomplete }) };
    } catch {
      return { graph: null };
    }
  }, [trace, records, stableRelated, incomplete]);

  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const view = useMemo(() => (built.graph ? visibleGraph(built.graph, expanded) : null), [built, expanded]);
  const size = useMemo(() => (view ? canvasSize(view, null, frame !== null) : null), [view, frame]);
  useCanvasRoom(scroller);

  // Значок совпадений: записи узла с найденным значением. Текст тот же, что считает сводка над вкладками.
  const forms = useContext(HitsContext);
  const overlay = useContext(RevealContext);
  const hits = useMemo(() => {
    if (!forms || !view || records.length > MAX_HIT_RECORDS) return null;
    const matched = new Set<string>();
    for (const r of records) {
      const shown = withRevealed(r, overlay);
      if (hasHit(shown.raw, forms) || (shown.http?.uri ? hasHit(shown.http.uri, forms) : false)) matched.add(r.id);
    }
    if (matched.size === 0) return null;
    const recordsOf = new Map(trace.steps.map((step) => [step.id, step.recordIds]));
    const out = new Map<string, number>();
    for (const n of view.nodes) {
      const own = new Set(n.covers.flatMap((step) => recordsOf.get(step) ?? []).filter((id) => matched.has(id)));
      if (own.size > 0) out.set(n.id, own.size);
    }
    return out;
  }, [forms, overlay, records, trace, view]);

  // Метка «внешняя»: обмен, вызов с обменом, их повторы или опрос, если система обмена в справочнике не своя для проекта.
  // Без справочника любой обмен — вызов внешней системы: так считает и «Внешние» в шапке запроса.
  const external = useMemo(() => {
    if (!view) return null;
    const stepsById = new Map(trace.steps.map((step) => [step.id, step]));
    const recordsById = new Map(records.map((r) => [r.id, r]));
    const out = new Set<string>();
    for (const n of view.nodes) {
      const exchangeLike = n.kind === 'exchange' || n.kind === 'fn' || (n.kind === 'group' && (n.group?.kind === 'retry' || n.group?.kind === 'poll' || n.group?.kind === 'errors'));
      if (!exchangeLike) continue;
      const exchanges = n.covers.map((id) => stepsById.get(id)).filter((step) => step?.kind === 'exchange');
      if (exchanges.length === 0) continue;
      const own = exchanges.some((step) => step!.recordIds.some((id) => recordCatalog(recordsById.get(id))?.name?.source === 'project'));
      if (!own) out.add(n.id);
    }
    return out.size > 0 ? out : null;
  }, [view, trace, records]);

  // Ключ попытки: «Повторить» даёт новый lazy и сброс Boundary, загрузка действительно идёт заново.
  const [attempt, setAttempt] = useState(0);
  const Lazy = useMemo(() => lazy(() => loadFlow().then((m) => ({ default: m.FlowGraph }))), [attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  const onToggle = useCallback(
    (id: string) =>
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    [],
  );
  const onRelatedNode = useCallback((n: FlowViewNode) => onRelated(n.related ? relatedKey(n.related) : null), [onRelated]);
  const operationOf = useCallback(
    (n: FlowViewNode) => {
      const k = n.opKey
        ? operationKeys.find((x) => x.type === n.opKey!.type && x.short === n.opKey!.short && !x.masked)
        : undefined;
      return k
        ? {
            label: t('operation.openOne', { name: k.name ?? k.type, short: k.short }),
            onOpen: () => onOperation(k),
          }
        : null;
    },
    [operationKeys, onOperation, t],
  );

  const failed = (
    <StateMessage
      icon={CircleAlert}
      tone="warning"
      title={t('flow.loadFailed.title')}
      text={t('flow.loadFailed.text')}
    >
      {built.graph && (
        <Button variant="secondary" onClick={() => setAttempt((a) => a + 1)}>
          <RotateCcw aria-hidden />
          {t('states.retry')}
        </Button>
      )}
      <Button variant="secondary" onClick={() => onTimeline(null)}>
        {t('request.tabs.timeline')}
      </Button>
    </StateMessage>
  );

  const placeholder = size && (
    <div className="absolute inset-3" aria-busy="true" data-testid="flow-placeholder">
      <span className="sr-only">{t('flow.loading')}</span>
      <Skeleton className="size-full rounded-[12px] opacity-60" />
    </div>
  );

  // Логи приложения — псевдошаг APP: кнопка-сводка выбирает его, панель шага показывает все логи.
  const appPressed = selected === APP;
  return (
    <section className={cn('flex min-w-0 flex-col', DOTS, className)} data-testid="trace-scheme">
      <div className={cn('flex h-9 shrink-0 items-center', fill && 'mt-1.5 pl-[var(--page-gutter)]')}>
        {!logs ? (
          <span className="tabular text-[13px] text-muted-foreground" data-testid="flow-steps">
            {t('view.steps', { count: steps })}
          </span>
        ) : (
          <button
            type="button"
            aria-pressed={appPressed}
            onClick={() => onSelect(APP)}
            data-testid="app-logs"
            data-level={app.errors > 0 ? 'error' : app.warnings > 0 ? 'warning' : undefined}
            className={cn(
              'tabular inline-flex h-7 min-w-0 items-center gap-2 rounded-[8px] px-2 text-[13px] transition-colors hover:bg-accent',
              appPressed && 'bg-accent ring-2 ring-primary',
            )}
          >
            <MessageSquareText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="truncate">
              <span className="font-medium text-foreground">{t('flow.logs.title')}</span>
              <span className="text-muted-foreground">
                {' '}
                · {app.count > 0 ? t('requests.records', { count: app.count }) : t('flow.logs.none')}
              </span>
              {app.warnings > 0 && (
                <span className="text-warning">
                  {' '}
                  · {t('flow.logs.level', { count: app.warnings, level: 'WARNING' })}
                </span>
              )}
              {app.errors > 0 && (
                <span className="text-danger">
                  {' '}
                  · {t('flow.logs.level', { count: app.errors, level: 'ERROR' })}
                </span>
              )}
            </span>
          </button>
        )}
      </div>
      <div
        ref={scroller}
        role="group"
        aria-label={t('flow.label')}
        aria-describedby={hintId}
        className={cn(CANVAS, FLOW_HEIGHT, fill && 'work:h-auto work:flex-1')}
        style={{ '--flow-h': `${(size?.height ?? 0) + CONTROLS_ROOM}px` } as CSSProperties}
      >
        <span id={hintId} className="sr-only">
          {t('flow.labelHint')}
        </span>
        {!view ? (
          <div className="absolute inset-0 overflow-auto">{failed}</div>
        ) : (
          <Boundary key={attempt} fallback={<div className="absolute inset-0 overflow-auto">{failed}</div>}>
            <Suspense fallback={placeholder}>
              <Lazy
                view={view}
                mode={mode}
                logs={logs}
                selected={selected}
                entry={entry}
                frame={frame}
                hits={hits}
                external={external}
                onSelect={onSelect}
                onOpen={onOpen}
                onToggle={onToggle}
                onTimeline={onTimeline}
                onRelated={onRelatedNode}
                operationOf={operationOf}
                refitKey={refitKey}
              />
            </Suspense>
          </Boundary>
        )}
      </div>
    </section>
  );
}
