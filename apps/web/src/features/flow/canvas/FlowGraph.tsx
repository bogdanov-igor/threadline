// Точка ленивого чанка flow: холст React Flow с панорамой и масштабом, раскладка dagre, узлы и рёбра.
// Модель, бюджет и клавиши — в ядре; здесь только рисование, фокус и вид холста.
import '@xyflow/react/dist/base.css';
import './flow.css';
import { ReactFlow } from '@xyflow/react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { ViewMode as DetailMode } from '@threadline/core/view';
import { locate, nextNode, representative, type FlowEntryInfo, type FlowFrame, type FlowView, type FlowViewNode, type NavKey } from '../model.ts';
import { edgeLabel } from '../node-text.ts';
import { ARROW, EDGE_TYPES, edgeType, HOT_ARROW, type FlowRfEdge } from './edges.tsx';
import { ZoomControls } from './ZoomControls.tsx';
import { constrainViewport, fitViewport, keepInPlace, layoutFlow, MAX_ZOOM, MIN_ZOOM, revealViewport, stepsToRight, zoomAround, type Box, type Canvas, type Viewport } from './layout.ts';
import { FlowContext, NODE_TYPES, type FlowContextValue, type FlowRfNode } from './nodes.tsx';

export interface FlowGraphProps {
  view: FlowView;
  mode: DetailMode;
  /** Значки логов видны в этом режиме. */
  logs: boolean;
  /** Выбранный шаг трассы: общий со шкалой времени и записями. */
  selected: string | null;
  /** Итог запроса и время первой записи для узла входа. */
  entry?: FlowEntryInfo | null | undefined;
  /** Рамка проекта вокруг шагов. */
  frame?: FlowFrame | null | undefined;
  /** Записей с найденным значением у видимого узла. */
  hits?: ReadonlyMap<string, number> | null | undefined;
  /** Узлы обменов с внешними системами: метка «внешняя». */
  external?: ReadonlySet<string> | null | undefined;
  onSelect: (stepId: string) => void;
  /** Enter: к подробностям шага. */
  onOpen: () => void;
  onToggle: (nodeId: string) => void;
  /** Группа больше предела раскрытия: шкала времени с её первым шагом. */
  onTimeline: (stepId: string) => void;
  /** Узел-ссылка на поток операции или «ещё N потоков операции». */
  onRelated: (node: FlowViewNode) => void;
  /** Действие «Открыть операцию» у узла с ключом; null — нет. */
  operationOf: (node: FlowViewNode) => { label: string; onOpen: () => void } | null;
  /** Панель шага свернули или поменяли её ширину: следующий размер холста вписывает граф заново. */
  refitKey?: string | undefined;
}

const PRO = { hideAttribution: true };
const NAV_KEYS: ReadonlySet<string> = new Set(['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End']);
const ZOOM_STEP = 0.1;
/** Шаг колеса к масштабу: та же чувствительность, что у d3-zoom. */
const WHEEL_RATE = 0.002;
const FRAME_ID = '__project';

export function FlowGraph({ view, mode, logs, selected, entry = null, frame = null, hits = null, external = null, onSelect, onOpen, onToggle, onTimeline, onRelated, operationOf, refitKey }: FlowGraphProps) {
  const { t, i18n } = useTranslation();
  const language = i18n.language;
  const aria = useMemo(
    () => ({
      'node.a11yDescription.default': t('flow.rf.node'),
      'node.a11yDescription.keyboardDisabled': t('flow.rf.node'),
      'node.a11yDescription.ariaLiveMessage': () => '',
      'edge.a11yDescription.default': t('flow.rf.edge'),
      'controls.ariaLabel': t('flow.rf.controls'),
      'controls.zoomIn.ariaLabel': t('flow.rf.zoomIn'),
      'controls.zoomOut.ariaLabel': t('flow.rf.zoomOut'),
      'controls.fitView.ariaLabel': t('flow.rf.fitView'),
      'controls.interactive.ariaLabel': t('flow.rf.interactive'),
      'minimap.ariaLabel': t('flow.rf.minimap'),
      'handle.ariaLabel': t('flow.rf.handle'),
    }),
    [t],
  );
  const withFrame = frame !== null;
  const layout = useMemo(() => layoutFlow(view, { frame: withFrame }), [view, withFrame]);
  const wrapper = useRef<HTMLDivElement>(null);
  const byId = useMemo(() => new Map(view.nodes.map((n) => [n.id, n])), [view]);
  const expandedNow = useCallback((id: string) => byId.get(id)?.expanded === true, [byId]);

  const nodes = useMemo<FlowRfNode[]>(() => {
    const list: FlowRfNode[] = view.nodes.map((n) => {
      const box = layout.boxes.get(n.id)!;
      const pos = layout.positions.get(n.id)!;
      return {
        id: n.id,
        type: n.kind === 'junction' ? 'junction' : n.expanded ? 'frame' : 'step',
        position: pos,
        ...(n.parentId ? { parentId: n.parentId } : {}),
        // Перетаскивание по узлу не двигает холст: нажатие выбирает узел.
        className: n.kind === 'pause' || n.kind === 'junction' ? undefined : 'nopan',
        data: { node: n, x: box.x, y: box.y },
        width: box.width,
        height: box.height,
        draggable: false,
        selectable: false,
        connectable: false,
        focusable: false,
        ariaRole: 'group',
      } as FlowRfNode;
    });
    if (layout.frame) {
      const b = layout.frame;
      list.unshift({
        id: FRAME_ID,
        type: 'project',
        position: { x: b.x, y: b.y },
        data: { node: view.nodes[0]!, x: b.x, y: b.y },
        width: b.width,
        height: b.height,
        zIndex: -1,
        draggable: false,
        selectable: false,
        connectable: false,
        focusable: false,
        ariaRole: 'presentation',
      });
    }
    return list;
  }, [view, layout]);

  const edges = useMemo<FlowRfEdge[]>(
    () =>
      view.edges.map((e) => {
        const label = edgeLabel(e.hint);
        // Путь сбоя: ребро к узлу с ошибкой красным тоном.
        const hot = e.kind !== 'link' && byId.get(e.target)?.outcome.tone === 'error';
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          type: edgeType(e),
          data: { edge: e, label, hot },
          ...(e.kind === 'link' ? { sourceHandle: 'link' } : {}),
          ...(e.kind === 'link' || e.kind === 'join' ? {} : { markerEnd: hot ? HOT_ARROW : ARROW }),
          selectable: false,
          focusable: false,
          ariaLabel: label ? `${t('flow.rf.edge')} ${label}` : t('flow.rf.edge'),
        };
      }),
    // t меняется вместе с языком: подпись ребра строит и edgeLabel.
    [view, byId, t],
  );

  const located = useMemo(() => (selected ? locate(view, selected) : null), [view, selected]);
  const order = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of view.nodes) if (n.kind !== 'junction' && n.kind !== 'pause') m.set(n.id, m.size + 1);
    return m;
  }, [view]);
  const tabStop = located?.nodeId ?? view.nodes.find((n) => n.kind !== 'junction' && n.kind !== 'pause')?.id ?? null;

  // ---------- Вид холста ----------

  const [canvas, setCanvas] = useState<Canvas>({ width: 0, height: 0 });
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
  // Вид, который пользователь сам поменял, не сбрасывается при изменении размера окна.
  const moved = useRef(false);
  const fitted = useRef(false);
  // Нажатие по видимому узлу холст не двигает: выбор не меняет положение узлов.
  const quiet = useRef(false);
  // Раскрытие и сворачивание: переключённый узел остаётся на том же месте экрана, фокус — на нём.
  const pending = useRef<{ id: string; before: Box; focus: boolean } | null>(null);
  const live = useRef({ canvas, layout, locatedId: located?.nodeId ?? null, viewport });
  live.current = { canvas, layout, locatedId: located?.nodeId ?? null, viewport };

  useLayoutEffect(() => {
    const el = wrapper.current;
    if (!el) return;
    const measure = () => setCanvas((prev) => (prev.width === el.clientWidth && prev.height === el.clientHeight ? prev : { width: el.clientWidth, height: el.clientHeight }));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const selectedBox = useCallback(() => {
    const { layout: l, locatedId } = live.current;
    return locatedId ? l.boxes.get(locatedId) : undefined;
  }, []);

  const refit = useRef(false);
  const lastRefitKey = useRef(refitKey);
  if (lastRefitKey.current !== refitKey) {
    lastRefitKey.current = refitKey;
    refit.current = true;
  }

  // Открытие, смена размера холста и раскрытие групп.
  const shownLayout = useRef(layout);
  useLayoutEffect(() => {
    if (canvas.width === 0) return;
    const p = pending.current;
    const previous = shownLayout.current;
    shownLayout.current = layout;
    if (p && previous !== layout) {
      moved.current = true;
      setViewport((v) => constrainViewport(keepInPlace(v, p.before, layout.boxes.get(p.id)), canvas, layout));
      return;
    }
    const fitAgain = refit.current;
    refit.current = false;
    if (moved.current) return setViewport((v) => constrainViewport(v, canvas, layout));
    // Смена размера без смены масштаба (полоса прокрутки страницы, панель шага выросла) вид не сбрасывает: выбор не двигает граф.
    const next = fitViewport(canvas, layout, selectedBox());
    setViewport((v) => (!fitAgain && fitted.current && v.zoom === next.zoom ? constrainViewport(v, canvas, layout) : next));
    fitted.current = true;
  }, [canvas, layout, selectedBox]);

  // Фокус после раскрытия: тип узла меняется, кнопка пересоздаётся на одном из следующих кадров.
  useEffect(() => {
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    if (!p.focus) return;
    const target = () => wrapper.current?.querySelector<HTMLElement>(`button[data-node="${CSS.escape(p.id)}"]`) ?? null;
    let frames = 0;
    let handle = 0;
    const tryFocus = () => {
      const button = target();
      if (button && button.dataset.frame === (expandedNow(p.id) ? 'open' : undefined)) {
        button.focus({ preventScroll: true });
        return;
      }
      if (frames++ < 10) handle = requestAnimationFrame(tryFocus);
    };
    tryFocus();
    return () => cancelAnimationFrame(handle);
  }, [layout, expandedNow]);

  const reveal = useCallback((id: string) => {
    const { canvas: c, layout: l } = live.current;
    const box = l.boxes.get(id);
    if (!box || c.width === 0) return;
    setViewport((v) => {
      const next = revealViewport(v, box, c);
      return next.x === v.x && next.y === v.y ? v : next;
    });
  }, []);

  // Выбор на шкале, в панели шага или стрелками — узел виден. Раскрытие переносит выбор внутрь рамки: сдвигать нечего.
  const shown = useRef<string | null>(null);
  useLayoutEffect(() => {
    const id = located?.nodeId ?? null;
    if (id === shown.current) return;
    shown.current = id;
    if (quiet.current) {
      quiet.current = false;
      return;
    }
    if (id && !pending.current) reveal(id);
  }, [located, reveal]);

  const fit = useCallback(() => {
    const { canvas: c, layout: l } = live.current;
    moved.current = false;
    setViewport(fitViewport(c, l, selectedBox()));
  }, [selectedBox]);

  const zoomBy = useCallback((delta: number) => {
    const { canvas: c, layout: l } = live.current;
    moved.current = true;
    setViewport((v) => {
      const z = Math.round((v.zoom + delta) * 10) / 10;
      return constrainViewport(zoomAround(v, z, { x: c.width / 2, y: c.height / 2 }), c, l);
    });
  }, []);

  // Ctrl или ⌘ с колесом и щипок на тачпаде: масштаб вокруг указателя. Без них колесо идёт дальше, как на странице.
  useEffect(() => {
    const el = wrapper.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      e.stopPropagation();
      const rect = el.getBoundingClientRect();
      const { canvas: c, layout: l } = live.current;
      moved.current = true;
      setViewport((v) => constrainViewport(zoomAround(v, v.zoom * Math.pow(2, -e.deltaY * WHEEL_RATE), { x: e.clientX - rect.left, y: e.clientY - rect.top }), c, l));
    };
    el.addEventListener('wheel', onWheel, { passive: false, capture: true });
    return () => el.removeEventListener('wheel', onWheel, { capture: true });
  }, []);

  const onViewportChange = useCallback((v: Viewport) => {
    const { canvas: c, layout: l } = live.current;
    setViewport(constrainViewport(v, c, l));
  }, []);
  // Сдвиг, который пришёл из пропа viewport, тоже начинает движение: у него в событии отметка sync.
  const onMoveStart = useCallback((event: unknown) => {
    if (event && !(event as { sync?: boolean }).sync) moved.current = true;
  }, []);

  const ctx = useMemo<FlowContextValue>(() => {
    const activate = (n: FlowViewNode, open = false) => {
      if (n.kind === 'flow-ref') return onRelated(n);
      const step = representative(n);
      if (step) onSelect(step);
      if (open) onOpen();
    };
    const toggle = (n: FlowViewNode) => {
      const box = layout.boxes.get(n.id);
      const focus = document.activeElement?.closest('button[data-node]') === wrapper.current?.querySelector(`button[data-node="${CSS.escape(n.id)}"]`);
      if (box) pending.current = { id: n.id, before: box, focus };
      onToggle(n.id);
    };
    const focus = (id: string) => wrapper.current?.querySelector<HTMLElement>(`button[data-node="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
    return {
      language,
      mode,
      logs,
      located,
      tabStop,
      order,
      total: order.size,
      entry,
      frame,
      hits,
      external,
      onClick: (n) => {
        quiet.current = true;
        activate(n);
      },
      onAttempt: (stepId) => {
        quiet.current = true;
        onSelect(stepId);
      },
      onToggle: toggle,
      operationOf,
      onTimeline: (n) => {
        const first = n.covers[0] ?? n.group?.representative;
        if (first) onTimeline(first);
      },
      onKeyDown: (e: KeyboardEvent<HTMLButtonElement>, n: FlowViewNode) => {
        if (NAV_KEYS.has(e.key)) {
          e.preventDefault();
          const next = nextNode(view, e.key as NavKey, n.id);
          const target = next ? byId.get(next) : undefined;
          if (!target) return;
          if (target.kind !== 'flow-ref') {
            const step = representative(target);
            if (step) onSelect(step);
          }
          focus(target.id);
          reveal(target.id);
        } else if (e.key === 'Enter') {
          e.preventDefault();
          activate(n, true);
        } else if (e.key === ' ') {
          // Пробел раскрывает группу бюджета; группу сверх предела открывает на шкале; остальные узлы выбирает, как клик.
          e.preventDefault();
          if (n.group && n.expandable) toggle(n);
          else if (n.group && !n.listed) {
            const first = n.covers[0] ?? n.group.representative;
            if (first) onTimeline(first);
          } else activate(n);
        }
      },
    };
  }, [language, mode, logs, located, tabStop, order, entry, frame, hits, external, view, byId, layout, reveal, onSelect, onOpen, onToggle, onTimeline, onRelated, operationOf]);

  const right = useMemo(() => {
    const steps = (id: string) => order.has(id) && byId.get(id)?.parentId === null;
    return stepsToRight(layout.boxes, steps, viewport, canvas);
  }, [layout, order, byId, viewport, canvas]);

  return (
    <div
      ref={wrapper}
      className="threadline-flow absolute inset-0"
      data-testid="flow-canvas"
      data-width={layout.width}
      data-height={layout.height}
      data-zoom={viewport.zoom}
    >
      <FlowContext value={ctx}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          viewport={viewport}
          onViewportChange={onViewportChange}
          onMoveStart={onMoveStart}
          minZoom={MIN_ZOOM}
          maxZoom={MAX_ZOOM}
          panOnDrag
          panOnScroll={false}
          zoomOnScroll={false}
          zoomOnPinch={false}
          zoomOnDoubleClick={false}
          zoomActivationKeyCode={null}
          panActivationKeyCode={null}
          selectionKeyCode={null}
          multiSelectionKeyCode={null}
          deleteKeyCode={null}
          autoPanOnNodeFocus={false}
          preventScrolling={false}
          elementsSelectable={false}
          nodesDraggable={false}
          nodesConnectable={false}
          nodesFocusable={false}
          edgesFocusable={false}
          disableKeyboardA11y
          proOptions={PRO}
          ariaLabelConfig={aria}
        />
      </FlowContext>
      {right > 0 && (
        <p className="pointer-events-none absolute bottom-4 left-4 z-[5] flex max-w-[calc(100%-13rem)] items-center gap-2 text-[12px] leading-4 text-muted-foreground">
          <span className="tabular shrink-0 rounded-[5px] bg-muted px-1.5 py-0.5 whitespace-nowrap" data-testid="flow-more-right">
            {t('flow.moreRight', { count: right })}
          </span>
          <span className="min-w-0 truncate max-[767.98px]:hidden" data-testid="flow-pan-hint">
            {t('flow.panHint')}
          </span>
        </p>
      )}
      <ZoomControls zoom={viewport.zoom} canZoomOut={viewport.zoom > MIN_ZOOM} canZoomIn={viewport.zoom < MAX_ZOOM} onFit={fit} onZoomOut={() => zoomBy(-ZOOM_STEP)} onZoomIn={() => zoomBy(ZOOM_STEP)} testId="flow-zoom" className="absolute right-3 bottom-3" />
    </div>
  );
}
