// Пределы команды выборки и белые списки. Настройкой не меняются.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const MAX_QUERIES = 13;
export const MAX_LINES = 1000;
export const MAX_WINDOW_MS = 24 * HOUR;
export const MIN_WINDOW_MS = MINUTE;
export const RUN_DEADLINE_MS = 120_000;
export const DEFAULT_SINCE = '6h';

export const MAX_LABEL_NAMES = 200;
export const MAX_LABEL_VALUES = 50;

export const GATEWAY_WINDOW_MS = HOUR;
export const GATEWAY_LINES = 5;

export const CANDIDATE_LINES = 2;
export const MAX_CANDIDATES_WITH_LINES = 3;
export const MAX_CANDIDATE_READS = 4;
export const MAX_FLOWS = 2;
/** У background на кандидатов и потоки вместе. */
export const MAX_BACKGROUND_READS = 5;
export const FLOW_WINDOW_MS = HOUR;
export const FLOW_LINES = 200;
export const MAX_FLOW_GAPS = 20;
export const FLOW_GAP_MIN_SEC = 30;

export const NAMES_WINDOW_MS = 15 * MINUTE;
export const NAMES_OLD_OFFSET_MS = 3 * HOUR;
export const NAMES_LINES = 200;
export const ERROR_WINDOW_MS = HOUR;
export const ERROR_LINES = 50;
export const MAX_GROUP_ENTRIES = 2;
export const MAX_UNKNOWN = 50;
export const MIN_WORD_CIDS = 3;

export const MAX_ARRAY_ITEMS = 2;
export const MAX_OBJECT_KEYS = 100;
export const MAX_DEPTH = 10;
export const MAX_TREE_BYTES = 16 * 1024;
export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_NESTED_BYTES = 1024 * 1024;
export const MAX_XML_TAGS = 100;
export const MAX_FORM_NAMES = 100;
/** Длина в метке: 7 цифр подряд остановили бы файл на проверке содержимого. */
export const MAX_SHOWN_LENGTH = 999_999;

/** Значения этих меток нужны кандидатам: остальные в файле только именем или меткой значения. */
export const VALUE_LABELS = ['container', 'app_kubernetes_io_component', 'app_kubernetes_io_sub_service'] as const;

export const BACKGROUND_WORDS = ['worker', 'consumer', 'cron', 'job', 'queue', 'scheduler'] as const;

/** Метки среды и компонента: значение остаётся, если прошло форму. */
export const FLOW_LABELS: ReadonlySet<string> = new Set([
  'cluster',
  'namespace',
  'container',
  'app_kubernetes_io_component',
  'app_kubernetes_io_sub_service',
  'app_kubernetes_io_instance',
  'app_kubernetes_io_name',
  'app_kubernetes_io_project',
  'job',
  'stream',
]);

/** Сравнение как в словаре масок: нижний регистр, без «_» и «-», имя целиком. */
export const TECHNICAL_FIELDS: ReadonlySet<string> = new Set([
  'level',
  'levelname',
  'channel',
  'module',
  'method',
  'status',
  'statuscode',
  'httpstatus',
  'code',
  'errorcode',
  'errcode',
  'error',
  'resultcode',
  'responsecode',
  'rc',
  'retcode',
  'returncode',
  'result',
  'state',
  'paymentstatus',
  'operationstatus',
  'transactionstatus',
  'orderstatus',
  'cardstatus',
  'success',
  'action',
  'type',
  'contentlength',
  'stream',
  'ms',
  'attempt',
  'retry',
  'duration',
]);

/** Текстовые поля: правило справочника по такому полю не открывает его значение. */
export const TEXT_FIELDS: ReadonlySet<string> = new Set(['message', 'text', 'name', 'title', 'description', 'comment', 'reason', 'details']);

export const KEY_SHAPE = /^[@$]?[A-Za-z_][A-Za-z0-9_.:-]{0,63}$/;
export const VALUE_SHAPE = /^[A-Za-z0-9_.:-]{1,64}$/;
export const LABEL_VALUE_SHAPE = /^[A-Za-z0-9_.:/-]{1,128}$/;
export const WORD_SHAPE = /^[A-Za-z][A-Za-z0-9_.-]{0,40}$/;
/** Целое значение белого списка: до 6 цифр. */
export const MAX_KEPT_INT = 999_999;
