// Типы API поиска. Общие для сервера и интерфейса.

export type PeriodPreset = '15m' | '1h' | '6h' | '24h';
export const PERIOD_PRESETS: Record<PeriodPreset, number> = {
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '6h': 6 * 60 * 60_000,
  '24h': 24 * 60 * 60_000,
};
export const DEFAULT_PRESET: PeriodPreset = '6h';
export const MAX_PERIOD_MS = 24 * 60 * 60_000;

export type TermKind = 'pan' | 'number' | 'pan-mask' | 'uuid' | 'phone' | 'text';

export interface SearchRequestBody {
  terms: string[];
  /** «Не содержит»: условие на строку, как `!=` в Grafana. */
  excludes?: string[];
  period: { preset: PeriodPreset } | { fromMs: number; toMs: number };
  stand?: string;
  /** «Обновить»: не брать результат из памяти. */
  fresh?: boolean;
}

export interface SearchCreated {
  id: string;
  cached: boolean;
}

/** Сколько сред проекта можно искать одним поиском. */
export const MAX_SEARCH_ENVS = 5;

/** POST /api/projects/:p/searches — поиск по нескольким средам. Стендов в таком поиске нет. */
export interface MultiSearchRequestBody {
  /** Идентификаторы сред проекта, 2–5, без повторов и без стендов PR. */
  envs: string[];
  terms: string[];
  excludes?: string[];
  period: SearchRequestBody['period'];
  fresh?: boolean;
}

/** Ключ строки списка: среда входит в него у поиска по нескольким средам, у одной среды это correlation_id. */
export const rowKey = (r: Pick<RequestSummary, 'correlationId' | 'env'>): string => (r.env ? `${r.env}/${r.correlationId}` : r.correlationId);

export type SearchStatus = 'running' | 'done' | 'failed' | 'cancelled';
export type SearchStage = 'count' | 'fetch' | 'done';

export interface ErrorReason {
  /** pending — отправка без ответа, когда записи могут быть неполными; на статус не влияет. outcome — ошибка по правилу итога справочника. */
  kind: 'level' | 'http' | 'business' | 'no-response' | 'pending' | 'outcome';
  /** Как без справочника; у outcome — текст правила или «HTTP N». */
  text: string;
  /** Справочник: система и метод шага. Нет поля — справочник выключен. */
  name?: CatalogName | null;
  /** Справочник: разрешённая ошибка. */
  error?: CatalogError | null;
}

export interface RequestSummary {
  correlationId: string;
  firstMs: number;
  lastMs: number;
  durationMs: number;
  incoming: { method: string; path: string } | null;
  component: string | null;
  recordCount: number;
  status: 'error' | 'success';
  kind: 'incoming' | 'background' | 'maybe-cached';
  reasons: ErrorReason[];
  match: 'exact' | 'inexact';
  /** Записи запроса дочитаны не полностью (предел строк). */
  incomplete: boolean;
  /** Справочник: входящий метод. Нет поля — справочник выключен; null — запрос без входа. */
  entry?: CatalogName | null;
  /** Среда строки в поиске по нескольким средам. Нет поля — поиск одной среды. */
  env?: string;
}

/**
 * Ссылка в интерфейс хранилища. wider — ссылка может найти больше, чем Threadline; typed — значение попадёт в адрес как введено.
 * narrower — вместо исключённого значения шаблон шире: ссылка может скрыть больше строк. url: null — кнопка недоступна, reason говорит почему.
 */
export type ExploreLink =
  | { url: string; wider: boolean; typed: boolean; narrower?: boolean }
  | { url: null; reason: 'too-long' | 'unsafe' };

export interface SearchState {
  id: string;
  status: SearchStatus;
  stage: SearchStage;
  period: { fromMs: number; toMs: number; preset: PeriodPreset | null };
  terms: { display: string; kind: TermKind }[];
  /** Исключённые значения. Нет поля — исключений нет. */
  excludes?: { display: string; kind: TermKind }[];
  /** Поиск с «Не содержит», значений здесь нет: на странице ссылки их в состоянии не бывает. removed — условие убрало запросы, которые нашёл первый проход. */
  excluding?: { removed: boolean };
  /** Сколько correlation_id нашёл первый проход. */
  found: number | null;
  /** Больше search.maxRequests: второй проход не выполнялся. */
  tooMany: boolean;
  /** Достигнут предел строк или памяти: показаны не все записи. */
  truncated: boolean;
  /** Чтение оборвал предел памяти сервера. Нет поля — предел строк. */
  truncatedBy?: 'memory';
  /** До какого момента (от конца периода) первый проход просмотрел период; null — пока не начат. */
  scannedFromMs: number | null;
  /** Есть ли строки без correlation_id, когда первый проход ничего не нашёл. */
  lines: 'unknown' | 'none' | 'some';
  progress: { chunksDone: number; chunksTotal: number; batchesDone: number; batchesTotal: number };
  /** Сводки запросов начиная с индекса из параметра from. */
  requests: RequestSummary[];
  requestsTotal: number;
  error: { code: string; details?: string; retryAfterSeconds?: number; stage: 'count' | 'fetch' } | null;
  /** Задание поиска операции: итог, ход статусов, потоки. У обычного поиска поля нет. */
  operation?: OperationView | null;
  /** Ссылка в интерфейс хранилища с тем же запросом. Нет поля — у хранилища такой операции нет. */
  explore?: ExploreLink;
  /** Поиск по нескольким средам: ход и итог каждой среды в порядке сред проекта. Нет поля — поиск одной среды. */
  envs?: EnvSearchPart[];
}

/** Часть поиска по нескольким средам: те же поля хода и итога, что у поиска одной среды. */
export interface EnvSearchPart {
  env: string;
  status: SearchStatus;
  stage: SearchStage;
  found: number | null;
  tooMany: boolean;
  truncated: boolean;
  truncatedBy?: 'memory';
  scannedFromMs: number | null;
  lines: SearchState['lines'];
  progress: SearchState['progress'];
  requestsTotal: number;
  error: SearchState['error'];
  excluding?: { removed: boolean };
  explore?: ExploreLink;
}

export type RecordKind = 'incoming' | 'call' | 'send' | 'response' | 'log' | 'text' | 'raw';

/** Заголовок записи подставил сам Threadline, а не лог: интерфейс показывает его на своём языке. raw — не разобрана, mask-failed — заглушка маскирования, record — запись без текста у Бизнеса. */
export type RecordTitleCode = 'raw' | 'mask-failed' | 'record';

export interface ViewRecord {
  id: string;
  tsNs: string;
  timeMs: number;
  /** Смещение от первой записи запроса; null во «Всех записях». */
  offsetMs: number | null;
  kind: RecordKind;
  title: string;
  titleCode?: RecordTitleCode;
  message: string;
  level: string | null;
  isError: boolean;
  component: string | null;
  /** Запись шлюза: открывает запрос, но компонентом запроса не считается. Определяется профилем формата. */
  gateway: boolean;
  correlationId: string | null;
  requestId: string | null;
  http: {
    method: string | null;
    uri: string | null;
    status: number | null;
    durationMs: number | null;
    /** id связанной записи: у отправки — её ответ, у ответа — его отправка. */
    pairId: string | null;
    /** Отправка без ответа. */
    noResponse: boolean;
    /** Отправка без ответа, но записи могут быть неполными: «ответ ещё не пришёл» вместо «ответ не найден». */
    pending: boolean;
  } | null;
  sections: {
    headers: unknown | null;
    body: string | null;
    payload: unknown | null;
    context: Record<string, unknown> | null;
  };
  raw: string;
  /** Во «Всех записях» при поиске по номеру: точное совпадение или только маска. */
  match: 'exact' | 'inexact' | null;
  /** Разметка справочника у входа, отправок, ответов и записей с ошибкой. Нет поля — справочник выключен. */
  catalog?: RecordCatalog | null;
  /** Подсказка шага графа из профиля формата: база или ожидание. Только у записей вида log. */
  flow?: FlowHint | null;
  /** Конец оси запроса, мс: только у записей вида для Бизнеса, где записи-логи убраны, а ось та же. */
  axisEndMs?: number;
  /** Содержимое с открытым выключенным видом и видами, открытыми пользователю сразу. Читают только блоки подробностей. */
  open?: OpenContent | null;
}

export interface RequestDetail {
  summary: RequestSummary;
  records: ViewRecord[];
  /** Ключи операций потока: по немаскированным записям с разметкой. Нет поля — справочник выключен. */
  operationKeys?: OperationKey[];
  /** Показ для этого пользователя: что глазок откроет на этой странице и что останется скрытым при любом нажатии. Только коды видов, без значений и счётчиков. */
  reveal?: { kinds: string[]; stays: string[] };
  /** Ссылка в интерфейс хранилища на записи этого запроса. Нет поля — у хранилища такой операции нет или correlation_id нет. */
  explore?: ExploreLink;
}

/** GET …/requests/:cid/reveal: содержимое записей с тем, что глазок открывает этому пользователю. */
export interface RevealResponse {
  records: OpenRecord[];
}

export interface LinesPageResponse {
  records: ViewRecord[];
  nextCursor: string | null;
}

export type SearchErrorCode =
  | 'search-expired'
  | 'request-not-found'
  | 'invalid-terms'
  | 'invalid-period'
  // Поиск операции: значение не годится в id, окно старше срока хранения, дополнение уже было.
  | 'invalid-operation'
  | 'operation-expired'
  | 'operation-supplemented';

// ---------- Граф потока и операция ----------

export type { OpenContent, OpenRecord } from './mask-pass.ts';
import type { OpenContent, OpenRecord } from './mask-pass.ts';
export type { OperationKey } from '../flow/facts.ts';
export type { OperationView } from '../flow/operation.ts';
import type { OperationKey } from '../flow/facts.ts';
import type { OperationView } from '../flow/operation.ts';

/** Подсказка шага из профиля формата: запись-лог — обращение к базе или ожидание. */
export interface FlowHint {
  as: 'db' | 'wait';
  durationMs: number | null;
  host: string | null;
  title: string | null;
}

/** POST /api/projects/:p/envs/:e/operations — поиск потоков операции. */
export interface OperationRequestBody {
  stand?: string;
  /** Тип id вида «операция» из справочника. */
  type: string;
  /** 1–3 значения этого типа. */
  values: string[];
  /** Значения других типов той же операции («also» в адресе страницы), всего значений не больше трёх. */
  also?: { type: string; value: string }[];
  /** Момент открытого потока, мс: окно считается от него. */
  atMs: number;
  /** ±3 ч или ±12 ч. */
  window: '6h' | '24h';
  fresh?: boolean;
}

/** POST /api/searches/:id/supplement — дополнение поиска операции новыми id. */
export interface OperationSupplementBody {
  values: { type: string; value: string }[];
}

// ---------- Справочник ----------

export type CatalogSource = 'project' | 'external' | 'unknown';
export type CatalogSystemType = 'service' | 'database' | 'queue';
export type CatalogMethodKind = 'call' | 'start' | 'status' | 'callback';
export type CatalogStatusOutcome = 'pending' | 'success' | 'failure';
export type CatalogOutcomeKind = 'success' | 'error' | 'pending' | 'ignore';
export type CatalogRuleLevel = 'method' | 'system' | 'general';

/** Система и метод шага по справочнику. */
export interface CatalogName {
  source: CatalogSource;
  system: { key: string; name: string; type: CatalogSystemType } | null;
  method: {
    id: number;
    name: string;
    domain: string | null;
    kind: CatalogMethodKind;
    opType: { key: string; name: string } | null;
  } | null;
  /** host:port обмена; null у входа. */
  host: string | null;
}

/** Id шага с типом: по type + value склеиваются потоки одной операции. */
export interface CatalogId {
  type: string;
  name: string;
  kind: 'entity' | 'operation';
  value: string;
  at: 'path' | 'query' | 'request' | 'response';
}

/** Статус операции по словарю op_type. raw — значение из записи до перевода map; order — место в словаре с 1. */
export interface CatalogStatus {
  type: string;
  value: string;
  raw: string;
  name: string | null;
  outcome: CatalogStatusOutcome | null;
  order: number | null;
}

/** Ошибка шага по справочнику. Без правила — source unknown, severity error, исходные код и текст в raw. */
export interface CatalogError {
  source: CatalogSource;
  rule: { id: number; level: CatalogRuleLevel; kind: 'error' | 'outcome' } | null;
  title: string | null;
  action: string | null;
  /** ok — «не ошибка»: от правила ошибки или от правила итога ignore. */
  severity: 'error' | 'ok';
  partnerCode: string | null;
  raw: { http: number | null; code: string | null; text: string | null };
  /** Только у ошибки по правилу итога: заголовок без значений из ответа. title там может быть текстом ответа, это читает вид для Бизнеса. */
  safeTitle?: string | null;
}

/** Итог ответа по правилу итога. text — готовый текст шаблона (маскируется вместе с ответом). */
export interface CatalogOutcome {
  kind: CatalogOutcomeKind;
  rule: { id: number; level: CatalogRuleLevel };
  text: string | null;
  action: string | null;
  /** В шаблоне текста нет мест подстановки: значений из ответа в нём быть не может. */
  fixed?: boolean;
}

export interface RecordCatalog {
  name: CatalogName | null;
  error: CatalogError | null;
  /** Только у ответов. */
  outcome: CatalogOutcome | null;
  ids: CatalogId[];
  status: CatalogStatus | null;
}

/** Состояние справочника: GET /api/catalog. */
export interface CatalogState {
  state: 'off' | 'connecting' | 'ok' | 'stale' | 'error';
  /** Время загрузки данных в памяти, мс; null — данных нет. */
  loadedAt: number | null;
  /** Причина для журнала и редактора: хост, порт, база, без пароля. */
  message: string | null;
  /** Отпечаток настройки маскирования по проектам: браузер по нему узнаёт о правке. Только в ответе GET /api/catalog. */
  masking?: Record<string, string>;
  /** Версия проектов из базы: вкладки по ней узнают о правке. */
  projectsVersion?: number;
  /** Открытые строки «Неизвестного» по проектам. Нет поля — база недоступна или ответ для Бизнеса. Нет проекта — ноль. */
  unknownOpen?: Record<string, number>;
}
