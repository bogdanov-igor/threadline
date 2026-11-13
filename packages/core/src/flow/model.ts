// Модель графа потока: узлы, рёбра, группы, видимая часть.
// Режима «Технические детали» и ширины окна в модели нет: режим меняет только текст внутри узла.
import type { FlowCatalogStatus } from './catalog.ts';

/** pause — долгая пауза отдельным узлом: шага за ней нет, клавиатура её проходит, как слияние. */
export type FlowNodeKind = 'entry' | 'fn' | 'exchange' | 'db' | 'wait' | 'async-start' | 'group' | 'flow-ref' | 'junction' | 'pause';
export type EntryVariant = 'request' | 'gateway' | 'callback' | 'background';
/** retry — повторы; poll — опрос; call — вызов с несколькими обменами; errors — ошибки подряд;
 *  parallel — «Ещё N параллельных»: ветки сверх трёх видимых; more — «ещё N шагов»; related — «ещё N потоков операции». */
export type GroupKind = 'retry' | 'poll' | 'call' | 'errors' | 'parallel' | 'more' | 'related';
export type FlowTone = 'success' | 'error' | 'pending' | 'warning' | 'none';
export type FlowEdgeKind = 'next' | 'fork' | 'join' | 'retry' | 'poll' | 'link';
export type FlowRole = 'start' | 'call' | 'status' | 'callback' | 'worker' | 'mention';

export interface FlowOutcome {
  tone: FlowTone;
  /** Причина ошибки: текст справочника или правила итога, иначе текст ошибки, иначе «HTTP N». */
  reason: string | null;
  http: number | null;
  /** Отправка без ответа: «ответ в логах не найден»; с pending — «ответ ещё не пришёл». */
  noResponse: boolean;
  pending: boolean;
  /** Ответ без отправки: «отправка в логах не найдена». */
  noSend: boolean;
}

/** Пометка строки итога. Текст — markText. */
export type FlowMark =
  | { kind: 'retry'; count: number; failed: number }
  | { kind: 'call'; count: number; failed: number }
  | { kind: 'poll'; count: number; status: FlowCatalogStatus | null }
  | { kind: 'errors'; count: number; firstMs: number; lastMs: number }
  | { kind: 'parallel'; count: number }
  | { kind: 'more'; count: number; errors: number }
  | { kind: 'related'; count: number }
  | { kind: 'issued'; short: string }
  | { kind: 'no-calls' }
  | { kind: 'callback-early' };

export interface FlowBadges {
  total: number;
  warning: number;
  error: number;
}

export interface FlowGroup {
  kind: GroupKind;
  /** Попыток, опросов, обменов, веток, шагов или потоков. */
  count: number;
  /** Попытки с ошибкой или без ответа. */
  failed: number;
  /** Шагов с ошибкой внутри. */
  errors: number;
  /** Шаг, который выбирает клик по свёрнутой группе: первая ошибка, иначе последняя попытка. */
  representative: string;
  /** Внутренность раскрытой группы: свой проход раскладки. */
  children: FlowContainer;
  /** Узлов станет видно больше при раскрытии. */
  cost: number;
}

/** Более поздний поток операции, открытой со страницы операции. */
/** Название подставляет ядро: поток без входа и обменов; сегмент без correlation_id, где нет ни входа, ни шагов (его cid — внутренний ключ). */
export type FlowTitleCode = 'background' | 'nocid';

export interface RelatedFlow {
  cid: string;
  /** Номер сегмента: у сегментов одного correlation_id один cid. */
  segment: number | null;
  role: FlowRole;
  title: string;
  /** Название подставил сам Threadline: интерфейс показывает его на своём языке. */
  titleCode?: FlowTitleCode;
  /** Время, мс от эпохи. */
  firstMs: number;
  lastMs: number;
  error: boolean;
  opStatus: FlowCatalogStatus | null;
  claimed: boolean;
  /** Ключ связи: тип id и его название, «по transfer_id». */
  key: { type: string; name: string };
}

export interface FlowNode {
  id: string;
  kind: FlowNodeKind;
  entry: EntryVariant | null;
  /** Свои шаги трассы узла. У группы — шаги самой группы (запись вызова), шаги детей — у детей. */
  stepIds: string[];
  /** Записи-логи, учтённые счётчиком этого узла. */
  logIds: string[];
  /** Имя подставлено самим Threadline, данных нет: интерфейс показывает его на своём языке. У имени из справочника поля нет, даже если оно совпало. */
  fallbackName?: 'entry' | 'db' | 'wait';
  /** Строка имени: система, название метода проекта, «Ожидание». */
  name: string;
  /** Строка метода с техническими деталями: метод и путь, действие, сообщение записи. */
  tech: string;
  /** Строка метода без технических деталей: название из справочника или подпись профиля; null — читаемый путь из path. */
  plain: string | null;
  /** Путь без хоста для читаемого пути. */
  path: string | null;
  /** Компонент или хост: подсказка и «Фоновый запуск · worker». */
  component: string | null;
  /** Смещение от первой записи потока, мс; у ссылки на поток — от первой записи открытого потока. */
  startMs: number;
  endMs: number;
  durationMs: number | null;
  /** Доля длительности во времени запроса, 0–1. */
  share: number;
  outcome: FlowOutcome;
  mark: FlowMark | null;
  /** Записи неполные и это последний узел: «дальше записи не прочитаны», конец потока не выдаётся за итог. */
  unread: boolean;
  opStatus: { status: FlowCatalogStatus; claimed: boolean } | null;
  badges: FlowBadges;
  /** Ключ операции узла: тип, название типа, последние 4 символа. */
  opKey: { type: string; name: string; short: string } | null;
  group: FlowGroup | null;
  /** 0 — основная линия; 1… — номер ветки в развилке. */
  lane: number;
  /** Сколько всего параллельных веток на участке узла, со свёрнутыми: значок на рамке. 0 — вне развилки. */
  laneCount: number;
  /** Параллельный участок, в котором стоит узел ветки: id его слияния или параллельной группы. */
  block: string | null;
  /** Шаг, который выбирает клик по узлу: у вызова с обменом — обмен, у группы — представитель. */
  select: string | null;
  related: RelatedFlow | null;
}

export type EdgeHint =
  | { kind: 'pause'; ms: number }
  | { kind: 'parallel'; count: number }
  | { kind: 'key'; type: string; name: string; together: boolean; pauseMs: number };

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  kind: FlowEdgeKind;
  hint: EdgeHint | null;
}

export interface FlowContainer {
  /** Узлы по времени. */
  nodes: string[];
  edges: FlowEdge[];
}

export interface FlowGraph {
  nodes: Record<string, FlowNode>;
  root: FlowContainer;
  totalMs: number;
  /** Шагов трассы. */
  steps: number;
  incomplete: boolean;
}

export interface FlowOptions {
  /** Более поздние потоки операции, если запрос открыт из неё; иначе пусто. */
  related: readonly RelatedFlow[];
  /** Записи запроса неполные: последний узел подписан «дальше записи не прочитаны». */
  incomplete?: boolean;
}

/** Клетка полоски попыток. */
export interface FlowAttemptCell {
  stepId: string;
  tone: FlowTone;
}

export interface FlowViewNode extends FlowNode {
  /** Рамка раскрытой группы, в которой стоит узел. */
  parentId: string | null;
  expanded: boolean;
  /** Группу можно раскрыть, не превысив 100 видимых узлов; иначе «Открыть на шкале времени». */
  expandable: boolean;
  /** Группа показывает части списком в панели шага и на графе не раскрывается: повторы, опрос, ошибки подряд, «Ещё N параллельных». */
  listed: boolean;
  /** Начало шага на общей шкале запроса, 0–1: полоска времени узла. */
  startShare: number;
  /** Клетки полоски у повторов, опроса и ошибок подряд, по порядку. */
  attempts: FlowAttemptCell[] | null;
  /** Имена свёрнутых веток у «Ещё N параллельных», без повторов. */
  memberNames: string[] | null;
  /** Шаги, которые покрывает видимый узел: у свёрнутой группы — все шаги внутри. */
  covers: string[];
  /** У свёрнутой группы — шаги каждого её узла по порядку: «шаг 2 из 3». */
  parts: string[][] | null;
}

export interface FlowView {
  /** Узлы в порядке времени, рамки раньше своих детей. */
  nodes: FlowViewNode[];
  edges: FlowEdge[];
}

export const MAX_VISIBLE = 60;
export const MAX_EXPANDED = 100;
export const MAX_ERRORS = 15;
export const MAX_LANES = 3;
export const MAX_RELATED = 5;
/** Допуск пересечения интервалов, мс. */
export const OVERLAP_TOLERANCE_MS = 1;
/** Пауза от минуты — отдельный узел; короче — подпись ребра «+3 мс», меньше миллисекунды подписи нет. */
export const PAUSE_NODE_MS = 60_000;
export const PAUSE_MIN_MS = 1;
/** Обращение к базе дольше этого — предупреждение. */
export const DB_WARN_MS = 200;
/** Потоки ближе этого — «одновременно». */
export const TOGETHER_MS = 1000;
