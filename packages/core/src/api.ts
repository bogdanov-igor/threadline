// Ответы API сервера Threadline. Общие для сервера и интерфейса.

import type { MessageRef } from './messages.ts';
import type { ViewIssue, ViewSettings } from './view/index.ts';
import type { PeriodPreset, TermKind } from './search/api.ts';
import type { Regional } from './search/regional.ts';

export type EnvironmentKind = 'single' | 'pr-stands';
export type BackendType = 'loki-grafana' | 'loki' | 'mock';

/** Языки подписи примера поиска: те же, что у интерфейса. */
export const EXAMPLE_LANGUAGES = ['ru', 'en'] as const;
export type ExampleLanguage = (typeof EXAMPLE_LANGUAGES)[number];

/** Подпись примера: одна строка на все языки или своя на каждом языке интерфейса, хотя бы на одном. */
export type ExampleLabel = string | Partial<Record<ExampleLanguage, string>>;

/** Пример поиска на стартовой странице среды: подпись, значения как в строке поиска и период. Нет периода — период поиска по умолчанию. */
export interface SearchExample {
  label: ExampleLabel;
  values: string[];
  period?: PeriodPreset;
}

/** Пределы примеров поиска одной среды. Значений в примере не больше, чем принимает строка поиска (MAX_TERMS). Предел подписи — у каждого языка. */
export const EXAMPLE_LIMITS = { examples: 6, label: 60 } as const;

/** Подпись примера на языке интерфейса. Нет подписи на этом языке — подпись на другом. */
export function exampleLabelText(label: ExampleLabel, language: string): string {
  if (typeof label === 'string') return label;
  return label[language as ExampleLanguage] || EXAMPLE_LANGUAGES.map((l) => label[l]).find(Boolean) || '';
}

export interface EnvironmentInfo {
  id: string;
  name: string;
  kind: EnvironmentKind;
  /** Примеры поиска среды: карточки на стартовой странице. Нет поля — примеров нет. */
  examples?: SearchExample[];
  /** Нет у среды, чьё хранилище убрали из файла. */
  backendType?: BackendType;
  /** Нет секрета, который нужен хранилищу среды. */
  notConfigured: boolean;
  /** Имя переменной окружения, которую нужно задать, если среда не настроена. */
  missingEnv?: string;
  /** Среда ссылается на хранилище, которого нет в файле. */
  missingStore?: string;
  /** Среда вышла за границу хранилища: идентификатор этого хранилища. */
  outOfScope?: string;
}

export interface ProjectInfo {
  id: string;
  name: string;
  timezone: string;
  /** Срок хранения логов: свой период поиска не начинается раньше. */
  retentionDays: number;
  environments: EnvironmentInfo[];
  /** Проверенный логотип: адреса на сервере Threadline и ширина к высоте, при разных версиях большая из двух. */
  logo?: { light: string; dark: string; ratio: number };
  /** Настройка вида: сервер отдаёт всегда полной. Необязательна в типе: заготовки ответов и прежняя версия сервера её не несут, useView тогда отвечает встроенными значениями. */
  view?: ViewSettings;
}

export interface ProjectsResponse {
  projects: ProjectInfo[];
  defaults: { project: string; environment: string };
  /** Скрытые проекты: только идентификатор и название. */
  hidden?: { id: string; name: string }[];
  /** Снимка из базы ещё не было: проект из адреса может быть не показан. */
  incomplete?: boolean;
  /** Региональные правила сервиса (раздел regional): браузер распознаёт по ним телефоны и маскирует страницу из лога. */
  regional?: Regional;
}

/** Коды ошибок хранилища. Тексты для пользователя интерфейс берёт из каталога по коду. */
export type BackendErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not-found'
  | 'network'
  | 'certificate'
  | 'timeout'
  | 'overloaded'
  | 'limit'
  | 'too-large'
  | 'busy'
  | 'bad-response'
  | 'not-configured'
  | 'cancelled'
  | 'unknown';

export type ConnectionStatus = 'connected' | 'demo' | Exclude<BackendErrorCode, 'cancelled'>;

export interface ConnectionResponse {
  status: ConnectionStatus;
  checkedAt: string;
  retryAfterSeconds?: number;
  /** Технические подробности без секретов. */
  details?: string;
  missingEnv?: string;
  /** Как источник указан в настройке, для состояния «источник не найден». */
  datasource?: string;
  /** Тип хранилища: интерфейс подбирает по нему совет, Grafana это или Loki напрямую. Бизнесу не приходит, у него общие слова. */
  backend?: BackendType;
  missingStore?: string;
  outOfScope?: string;
}

export interface StandsResponse {
  /** Номера живых стендов, свежие (большие) первыми. */
  stands: number[];
}

export interface StandResponse {
  stand: number;
  live: boolean;
}

// forbidden здесь значит и отказ хранилища (ответ 502), и отказ по роли (ответ 403): различает HTTP-статус.
export type ApiErrorCode = BackendErrorCode | 'bad-request' | 'unknown-environment' | 'not-pr-stands' | 'unauthenticated' | 'no-role' | ShareErrorCode | ReportErrorCode;

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    details?: string;
    retryAfterSeconds?: number;
  };
}

// ---------- Страницы проектов ----------

/** Имя встроенного профиля формата записей (profile/builtin.ts). Здесь, чтобы интерфейс не тянул разборщик. */
export const BUILTIN_FORMAT = 'json';

/** Идентификаторы проекта, заняты адресами страниц и сервером. Здесь, чтобы интерфейс не тянул zod. */
export const RESERVED_PROJECT_IDS: ReadonlySet<string> = new Set(['about', 'admin', 'api', 'assets', 'catalog', 'credits', 'docs', 'health', 'learn', 'metrics', 'new', 'projects', 's', 'settings']);

/** Идентификаторы среды, заняты адресами /:project/catalog и /:project/settings. */
export const RESERVED_ENV_IDS: ReadonlySet<string> = new Set(['catalog', 'settings']);

/** Входа нет, а каждый проект держит в памяти логотипы и сборку справочника. Файл пределов не получает. */
export const PROJECT_LIMITS = { projects: 100, environments: 50, conditions: 20 } as const;
export const LOGO_MAX_BYTES = 256 * 1024;

export type ProjectsSourceState = 'off' | 'connecting' | 'error' | 'ok' | 'stale';

/** Отношение записи к файлу настроек: same — совпадает, none — только на странице, here — правится здесь. */
export type ProjectFileState = 'same' | 'none' | 'here' | 'file-newer' | 'removed';

/** Хранилище из файла. Адреса, источника, сертификата и токена здесь нет. */
export interface StoreInfo {
  id: string;
  type: BackendType;
  tokenEnv?: string;
  tokenSet?: boolean;
  /** Граница формы; null — форма не сохраняет новые условия. У имитации границы нет. */
  scope: { label: string; values: string[] } | null;
}

export interface EnvironmentSetting {
  id: string;
  name: string;
  kind: EnvironmentKind;
  backend: string;
  selector: { label: string; op: '=' | '!=' | '=~' | '!~'; value: string; searchOnly?: boolean }[];
  stand?: { label: string; template: string };
  examples?: SearchExample[];
  missingStore?: string;
  outOfScope?: string;
}

export interface ProjectSetting {
  id: string;
  name: string;
  timezone: string;
  retentionDays: number;
  format: string;
  environments: EnvironmentSetting[];
  hidden: 'page' | 'file' | null;
  fileState: ProjectFileState;
  /** Метка версии записи; null — проект из файла, записи нет. */
  updatedAt: string | null;
  logo?: { light: string; dark: string; ratio: number };
  /** Запись не прошла проверку при загрузке: в работе не участвует. */
  issues?: ({ path: string; message: string } & Partial<MessageRef>)[];
  /** Настройка вида после разбора: всегда полная. */
  view: ViewSettings;
  /** Метка версии настройки вида; null — настройку ещё не сохраняли. */
  viewUpdatedAt: string | null;
  /** Что разбор записи отбросил или заменил. */
  viewIssues: ViewIssue[];
}

export interface ProjectSettingsResponse {
  state: ProjectsSourceState;
  editable: boolean;
  /** Причина закрытой правки: хост, порт и текст ошибки без пароля. */
  message: string | null;
  /** Время снимка, мс; null — снимка из базы нет. */
  loadedAt: number | null;
  projects: ProjectSetting[];
  /** Имена профилей секции formats; встроенный json есть всегда. */
  formats: string[];
  stores: StoreInfo[];
  defaults: { project: string; environment: string };
  /** Что задано в файле, если вместо него открывается другое. */
  configuredDefaults?: { project: string; environment: string };
  /** Проекты, удалённые на странице и оставшиеся в файле. */
  ignoredInFile: string[];
  /** Ни одна запись базы не прошла проверку, действуют проекты из файла. */
  fallbackToFile: boolean;
}

export type ProjectErrorCode =
  | 'project-invalid'
  | 'project-conflict'
  | 'project-not-found'
  | 'project-duplicate'
  | 'project-last'
  | 'project-not-hidden'
  | 'project-limit'
  | 'project-readonly'
  | 'store-not-found';

export interface ProjectErrorBody {
  error: {
    code: ProjectErrorCode;
    details?: string;
    /** Путь поля → сообщение. */
    fields?: Record<string, string>;
    /** Путь поля → ключ сообщения: браузер на других языках показывает перевод вместо fields. */
    fieldKeys?: Record<string, MessageRef>;
    /** Свежая запись при конфликте. */
    current?: ProjectSetting;
  };
}

export interface DeletePreview {
  systems: number;
  methods: number;
  errors: number;
  unknown: number;
}

/** Ответ проверки подключения со страницы проектов. Тел записей здесь нет. */
export interface ProbeResponse extends ConnectionResponse {
  /** Имена индексных меток. */
  labelNames?: string[];
  /** Есть ли записи среды за 5 минут. */
  hasRecords?: boolean;
  /** Живые стенды за 7 дней, у среды стендов. */
  stands?: number[];
}

// ---------- Сообщить о проблеме ----------

/** Предел описания: сообщение Telegram вмещает 4096 символов, остаток на заголовок и ссылку. */
export const REPORT_MAX_TEXT = 2000;

export type ReportErrorCode = 'report-not-configured' | 'report-failed' | 'report-rate-limited';

/** POST /api/report. link: адрес короткой ссылки текущей страницы или null. page: шаблон текущей страницы из reportPage, только для журнала. */
export interface ReportBody {
  text: string;
  link: string | null;
  page?: string | null;
}

const REPORT_PAGE_SEGMENT = /^[a-z0-9][a-z0-9-]{0,63}$/;
const REPORT_PAGE_LONG_NUMBER = /\d{7}/;
const REPORT_PAGE_MAX_SEGMENTS = 8;
const REPORT_PAGE_HIDDEN = '***';

/**
 * Страница формы для журнала: путь без строки запроса и без значений. В пути бывают correlation_id, значение операции и идентификатор короткой ссылки.
 * Повторный вызов результат не меняет: одну функцию зовут и браузер, и сервер, потому что сервер браузеру не доверяет.
 */
export function reportPage(path: string): string {
  const parts = path
    .replace(/[?#].*$/s, '')
    .split('/')
    .filter(Boolean)
    .slice(0, REPORT_PAGE_MAX_SEGMENTS);
  if (parts[0] === 's') return `/s/${REPORT_PAGE_HIDDEN}`;
  const out: string[] = [];
  for (const part of parts) {
    out.push(REPORT_PAGE_SEGMENT.test(part) && !REPORT_PAGE_LONG_NUMBER.test(part) ? part : REPORT_PAGE_HIDDEN);
    if (part === 'requests' || part === 'operations') {
      if (parts.length > out.length) out.push(REPORT_PAGE_HIDDEN);
      break;
    }
  }
  return `/${out.join('/')}`;
}

export interface ReportSent {
  sent: true;
}

// ---------- Короткие ссылки ----------

export type ShareKind = 'results' | 'request' | 'operation';

/** Коды отказа ссылки. Текстов сервер не шлёт: браузер берёт их из каталога строк. */
export type ShareErrorCode = 'share-not-found' | 'share-project-hidden' | 'share-outdated' | 'share-unavailable' | 'logs-gone';

/** POST /api/share. У результатов и операции только идентификатор своего задания: значения и период сервер берёт из него. */
export type ShareBody =
  | { kind: 'results' | 'operation'; searchId: string }
  | { kind: 'request'; project: string; env: string; stand?: string; cid: string; fromMs: number; toMs: number };

export interface ShareCreated {
  /** /s/<id>: других частей в адресе нет. */
  path: string;
  /** До какого момента действует ссылка, ISO. */
  expiresAt: string;
}

/** GET /api/s/:id: ответ собран по списку полей. Селекторов, имён хранилищ и настоящих значений поиска в нём нет. */
export interface ShareInfo {
  kind: ShareKind;
  project: Pick<ProjectInfo, 'id' | 'name' | 'timezone' | 'retentionDays' | 'logo'> & { view: ViewSettings };
  env: Pick<EnvironmentInfo, 'id' | 'name' | 'kind'>;
  /** Ссылка на поиск по нескольким средам: среды, которые ещё есть в проекте, первая — env. Нет поля — одна среда. */
  envs?: Pick<EnvironmentInfo, 'id' | 'name' | 'kind'>[];
  /** Часть сред ссылки убрали из проекта: поиск идёт по оставшимся. */
  envsDropped?: boolean;
  stand: string | null;
  /** Сохранённые точные даты, начало срезано сроком хранения логов. */
  period: { fromMs: number; toMs: number };
  /** Начало периода старше срока хранения: более ранние записи уже удалены. */
  periodCut: boolean;
  /** Значения поиска с маской. */
  terms: { display: string; kind: TermKind }[];
  /** Исключённые значения с маской. Нет поля — исключений нет. */
  excludes?: { display: string; kind: TermKind }[];
  expiresAt: string;
  /** Цель ссылки на запрос и на операцию. */
  target: { cid: string } | { type: string; value: string; window: '6h' | '24h' } | null;
}

/** POST /api/s/:id/run: поиск ссылки идёт. cached — результат отдан из памяти или поиск уже шёл. */
export interface ShareRun {
  cached: boolean;
}

// ---------- Локальный режим: хранилища из интерфейса ----------

/** Вход в Loki напрямую: без входа, токен Bearer или имя и пароль Basic. У Grafana всегда токен. */
export type LocalStorageAuth = 'none' | 'bearer' | 'basic';

export type LocalDatasource = { name: string } | { uid: string } | { id: number };

/** Хранилище из файла storages.json каталога данных. Токена, имени и пароля в ответе нет: только то, что они заданы. */
export interface LocalStorageInfo {
  id: string;
  type: 'loki' | 'loki-grafana';
  url: string;
  tenant?: string;
  datasource?: LocalDatasource;
  auth: LocalStorageAuth;
  /** Секрет задан и хранится на этом компьютере. У Loki без входа поля нет. */
  tokenSet?: true;
  /** Метка, равенство на которую задаёт среды этого хранилища. */
  scopeLabel: string;
  /** Среды проектов на этом хранилище: «проект/среда». */
  usedBy: string[];
  addedAt: string;
}

/** GET /api/local/storages. */
export interface LocalStoragesResponse {
  storages: LocalStorageInfo[];
  /** Полный путь к storages.json: где лежат токены. */
  file: string;
  /** Хранилищ кроме имитации, вместе с файлом настроек. Ноль — на стартовой странице призыв подключить хранилище. */
  realStores: number;
}

/** POST /api/local/storages и POST /api/local/storages/check. Секреты только в запросе, обратно не возвращаются. */
export interface LocalStorageInput {
  id: string;
  type: 'loki' | 'loki-grafana';
  url: string;
  tenant?: string;
  datasource?: LocalDatasource;
  auth?: LocalStorageAuth;
  token?: string;
  username?: string;
  password?: string;
  scopeLabel?: string;
}

export type LocalStorageErrorCode = 'storage-invalid' | 'storage-exists' | 'storage-not-found' | 'storage-save-failed';

export interface LocalStorageErrorBody {
  error: { code: LocalStorageErrorCode; fields?: Record<string, string> };
}
