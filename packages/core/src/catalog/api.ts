// HTTP API справочника: тела правки и ответы, общие для сервера и интерфейса.
import type { MessageRef } from '../messages.ts';
import type { CatalogState } from '../search/api.ts';
import type { ImportReport } from './file.ts';
import type {
  CatalogSnapshot,
  ErrorData,
  ErrorRow,
  IdTypeData,
  IdTypeRow,
  MaskingRow,
  MethodData,
  MethodRow,
  OutcomeData,
  OutcomeRow,
  SystemData,
  SystemRow,
} from './schema.ts';
import type { UnknownKind } from './unknown.ts';

/** Вид записи справочника. */
export type RowKind = 'idType' | 'system' | 'method' | 'error' | 'outcome';

/** Сегмент адреса API правки: /api/projects/:p/catalog/<сегмент>. */
export const ROW_PATH: Record<RowKind, string> = {
  idType: 'id-types',
  system: 'systems',
  method: 'methods',
  error: 'errors',
  outcome: 'outcome-rules',
};

/** Тело POST и PUT. Метод несёт систему; ошибка и правило итога — систему и метод (null — общее правило). */
export interface DraftOf {
  idType: IdTypeData;
  system: SystemData;
  method: MethodData & { systemId: number };
  error: ErrorData & { systemId: number | null; methodId: number | null };
  outcome: OutcomeData & { systemId: number | null; methodId: number | null };
}

/** PUT несёт ещё updatedAt правленой версии; hidden: false возвращает скрытую запись. */
export type EditBody<K extends RowKind> = DraftOf[K] & { updatedAt: string; hidden?: boolean };

export interface RowOf {
  idType: IdTypeRow;
  system: SystemRow;
  method: MethodRow;
  error: ErrorRow;
  outcome: OutcomeRow;
}

/** PUT /api/projects/:p/catalog/masking/:type: вид целиком. */
export interface MaskingEditBody {
  enabled: boolean;
  keys: string[];
  updatedAt: string;
}

/** Ответ PUT: строка вида и сколько методов и правил читают его добавленные поля. */
export interface MaskingSaved {
  row: MaskingRow;
  readers: number;
}

/** GET /api/projects/:p/catalog — всё, включая скрытые записи. */
export type CatalogResponse = Omit<CatalogSnapshot, 'project'> & Pick<CatalogState, 'state' | 'loadedAt'>;

/** GET …/{systems|methods}/:id/dependents; methods — только у системы. */
export interface Dependents {
  methods?: number;
  errors: number;
  outcomeRules: number;
}

/** DELETE: запись всегда скрывается (hidden). С permanent=1 скрытая запись стирается вместе с зависимыми (deleted), только у администратора. */
export interface DeleteResult {
  deleted: boolean;
  hidden: boolean;
  dependents?: Dependents;
}

// ---------- «Неизвестное» ----------

export interface UnknownRow {
  id: number;
  kind: UnknownKind;
  systemId: number | null;
  methodId: number | null;
  httpMethod: string | null;
  path: string | null;
  rpc: string | null;
  host: string | null;
  httpStatus: number | null;
  code: string | null;
  /** Пример текста, уже маскированный. */
  text: string | null;
  env: string;
  /** Номер стенда примера у среды со стендами PR. */
  stand: string | null;
  exampleCid: string;
  exampleMs: number;
  count: number;
  firstSeen: string;
  lastSeen: string;
  hidden: boolean;
}

/** Строк «Неизвестного» в одном ответе. */
export const UNKNOWN_PAGE = 100;

/** GET …/catalog/unknown?kind&env&hidden&offset: по убыванию счётчика, затем последнего появления. */
export interface UnknownPage {
  items: UnknownRow[];
  /** Всего строк по фильтру. */
  total: number;
  offset: number;
  limit: number;
}

/** Предел файла справочника для загрузки: 2 МБ. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

// ---------- Ошибки ----------

export type CatalogErrorCode =
  | 'catalog-off'
  | 'project-unknown'
  | 'catalog-not-found'
  | 'catalog-conflict'
  | 'catalog-duplicate'
  | 'catalog-host-taken'
  | 'catalog-author'
  | 'catalog-in-use'
  | 'catalog-not-hidden'
  | 'catalog-file-too-large'
  | 'catalog-invalid'
  | 'catalog-invalid-file'
  | 'catalog-unavailable'
  | 'project-file-conflict'
  | 'bad-request';

/** Данные ошибки сверх кода: тело ответа { error: { code, ...CatalogErrorExtra } }. */
export interface CatalogErrorExtra {
  details?: string;
  /** 422 catalog-invalid: путь поля → текст. */
  fields?: Record<string, string>;
  /** 422 catalog-invalid: путь поля → ключ сообщения, браузер на других языках показывает перевод вместо fields. */
  fieldKeys?: Record<string, MessageRef>;
  /** 409 catalog-conflict: свежая версия записи. */
  current?: RowOf[RowKind] | MaskingRow;
  /** 409 catalog-duplicate: id записи с тем же ключом. */
  existingId?: number;
  /** 409 catalog-duplicate: запись с этим ключом удалена мягко, форма предлагает её вернуть. */
  existingHidden?: boolean;
  /** 409 catalog-host-taken: хост и система, у которой он уже есть. */
  host?: string;
  system?: { id: number; key: string; name: string };
  /** 409 catalog-in-use: сколько методов ссылаются на тип id. */
  count?: number;
  /** 422 catalog-invalid-file: отчёт проверки. */
  report?: ImportReport;
  /** 409 project-file-conflict: текущая версия файла проекта. */
  version?: string;
}

export interface CatalogErrorBody {
  error: { code: CatalogErrorCode } & CatalogErrorExtra;
}
