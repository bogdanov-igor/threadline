// Единственная точка, откуда интерфейс берёт модель графа потока: чистые функции и типы ядра (@threadline/core/flow).
export {
  attemptStrip,
  buildFlowGraph,
  canvasSize,
  COMPACT_HEIGHT,
  edgeMinlen,
  FRAME,
  GROUP_HEADER,
  hasNote,
  JUNCTION_SIZE,
  LAYOUT,
  locate,
  logsByStep,
  MAX_EXPANDED,
  nextNode,
  NODE_HEIGHT,
  NODE_WIDTH,
  nodeBoxSize,
  nodeSize,
  NOTE_ROOM,
  REF_GAP,
  relatedKey,
  representative,
  RETRY_WIDTH,
  visibleGraph,
} from '@threadline/core/flow';
export type {
  EdgeHint,
  FlowCatalogStatus,
  FlowEdge,
  FlowEdgeKind,
  FlowGraph,
  FlowMark,
  FlowNode,
  FlowRole,
  FlowTone,
  FlowView,
  FlowViewNode,
  NavKey,
  RelatedFlow,
} from '@threadline/core/flow';

/** Где выбранный шаг на видимом графе: свёрнутая группа даёт «шаг index из of». */
export interface Located {
  nodeId: string;
  index: number;
  of: number;
}

/** Рамка проекта на холсте: подписи готовы, раскладка резервирует под неё место. */
export interface FlowFrame {
  title: string;
  duration: string;
  note?: string | undefined;
}

/** Итог запроса для узла входа: «Итог: ошибка», время первой записи. */
export interface FlowEntryInfo {
  status: 'error' | 'success';
  time: string;
}
