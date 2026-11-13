// Записи справочника: типы, zod-схемы для API и файла, пределы, проверки.
// Схема JSON файла (catalog.schema.json) строится из этих же схем: описания и примеры — в .meta().

import type { MessageRef } from '../messages.ts';
import { z } from 'zod';
import { linearIssue, checkRe2 } from '../profile/regex.ts';
import { isMissingField, REQUIRED_FIELD } from '../required-field.ts';
import { maskText } from '../search/masking.ts';
import { BUILTIN_MASKING, maskKindsText, type MaskPolicy } from '../search/mask-pass.ts';
import { normalizeHostPattern, parseHostPattern } from './host.ts';
import { MAX_PATH, PARAM_NAME, pathKey, templateIssue, templateParams } from './path.ts';
import { sensitivePath } from './secure.ts';
import { sha1 } from './sha1.ts';

export const SYSTEM_KINDS = ['project', 'external'] as const;
export const SYSTEM_TYPES = ['service', 'database', 'queue'] as const;
export const METHOD_KINDS = ['call', 'start', 'status', 'callback'] as const;
export const ID_KINDS = ['entity', 'operation'] as const;
export const STATUS_OUTCOMES = ['pending', 'success', 'failure'] as const;
export const SEVERITIES = ['error', 'ok'] as const;
export const OUTCOMES = ['success', 'error', 'pending', 'ignore'] as const;
export const HTTP_VERBS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', '*'] as const;

export type SystemKind = (typeof SYSTEM_KINDS)[number];
export type SystemType = (typeof SYSTEM_TYPES)[number];
export type MethodKind = (typeof METHOD_KINDS)[number];
export type IdKind = (typeof ID_KINDS)[number];
export type StatusOutcome = (typeof STATUS_OUTCOMES)[number];
export type Severity = (typeof SEVERITIES)[number];
export type OutcomeKind = (typeof OUTCOMES)[number];
export type HttpVerb = (typeof HTTP_VERBS)[number];
export type Scalar = string | number | boolean;

/** Пределы записей: длины текстов записи и размеры правила итога. */
export const LIMITS = {
  name: 80,
  domain: 40,
  title: 200,
  long: 500,
  matchMin: 3,
  match: 200,
  code: 64,
  statusValue: 64,
  statuses: 30,
  fields: 10,
  fieldPath: 128,
  hosts: 50,
  priorityMin: 1,
  priorityMax: 1000,
  conditions: 10,
  oneOf: 50,
  value: 200,
  regex: 200,
  outcomeText: 200,
  placeholders: 5,
  rpc: 128,
} as const;

export const DEFAULT_PRIORITY = 100;

export interface StatusDef {
  value: string;
  name: string;
  outcome: StatusOutcome;
}
export interface IdField {
  in: 'query' | 'request' | 'response';
  path: string;
  type: string;
}
export interface StatusAt {
  in: 'request' | 'response';
  path: string;
  map?: Record<string, string>;
}
export interface HttpRange {
  from: number;
  to: number;
}
export type HttpCond = number | HttpRange | (number | HttpRange)[];
export interface FieldCond {
  in?: 'response' | 'request';
  path: string;
  equals?: Scalar;
  oneOf?: Scalar[];
  exists?: boolean;
  regex?: string;
}
export interface Conditions {
  http?: HttpCond;
  fields?: FieldCond[];
}

export interface IdTypeData {
  key: string;
  kind: IdKind;
  name: string;
  statuses: StatusDef[];
}
export interface SystemData {
  key: string;
  kind: SystemKind;
  type: SystemType;
  name: string;
  hosts: string[];
  description: string | null;
}
export interface MethodData {
  http: HttpVerb;
  path: string;
  rpc: string;
  name: string;
  domain: string | null;
  description: string | null;
  kind: MethodKind;
  op: string | null;
  fields: IdField[];
  status: StatusAt | null;
}
export interface ErrorData {
  http: number | null;
  code: string | null;
  /** Подстрока текста ошибки для сличения, без учёта регистра. */
  text: string | null;
  title: string;
  action: string | null;
  severity: Severity;
  partnerCode: string | null;
}
export interface OutcomeData {
  priority: number;
  when: Conditions;
  outcome: OutcomeKind;
  /** Свой текст или шаблон с местами {путь}. */
  text: string | null;
  action: string | null;
}

export interface RowMeta {
  id: number;
  hidden: boolean;
  /** Правили в редакторе: импорт без force не трогает. */
  edited: boolean;
  /** Ключ записи файла; null — запись из редактора. */
  seedKey: string | null;
  updatedAt: string;
}
export type IdTypeRow = IdTypeData & RowMeta;
export type SystemRow = SystemData & RowMeta;
export type MethodRow = MethodData & RowMeta & { systemId: number };
export type ErrorRow = ErrorData & RowMeta & { systemId: number | null; methodId: number | null };
export type OutcomeRow = OutcomeData & RowMeta & { systemId: number | null; methodId: number | null };
/** Настройка вида маски. Строку нельзя удалить или скрыть. */
export interface MaskingRow {
  id: number;
  type: string;
  enabled: boolean;
  /** Поля, добавленные к встроенным. */
  keys: string[];
  edited: boolean;
  updatedAt: string;
}

export interface CatalogSnapshot {
  project: string;
  version: number;
  idTypes: IdTypeRow[];
  systems: SystemRow[];
  methods: MethodRow[];
  errors: ErrorRow[];
  outcomeRules: OutcomeRow[];
  masking?: MaskingRow[];
}

export interface Issue extends Partial<MessageRef> {
  path: string;
  message: string;
}

// ---------- Поля ----------

const str = (max: number, description: string, examples: string[], min = 1) =>
  z.string().trim().min(min, min === 1 ? 'поле не может быть пустым' : `не короче ${min} символов`).max(max, `не длиннее ${max} символов`).meta({ description, examples });
// Описание поля — и на внешней оболочке: иначе в схеме JSON оно уходит внутрь anyOf.
const opt = <T extends z.ZodType>(s: T) => {
  const meta = s.meta();
  const out = s.nullable().optional();
  return meta ? out.meta(meta) : out;
};

export const SYSTEM_KEY = /^[a-z0-9-]{1,32}$/;
export const ID_TYPE_KEY = /^[a-z][a-z0-9_]{0,31}$/;
const FIELD_PATH = /^[A-Za-z0-9_$@:-]+(\.[A-Za-z0-9_$@:-]+)*$/;

const systemKey = z
  .string()
  .regex(SYSTEM_KEY, 'ключ системы: строчные латинские буквы, цифры и дефис, до 32 символов')
  .meta({ description: 'Ключ системы: строчные латинские буквы, цифры и дефис. У системы-автора — id проекта.', examples: ['switch', 'processor', 'pay'] });
const idTypeKey = z
  .string()
  .regex(ID_TYPE_KEY, 'ключ типа: латиница в нижнем регистре, цифры и «_», с буквы, до 32 символов')
  .meta({ description: 'Ключ типа id: латиница в нижнем регистре, цифры и «_», с буквы. Подстановка {transferId}, {transfer_id} или {transferId2} в пути получает тип transfer.', examples: ['user', 'card', 'transfer', 'merchant_payment'] });
const httpVerb = z.enum(HTTP_VERBS, { error: `HTTP-метод: ${HTTP_VERBS.join(', ')}` }).meta({ description: 'HTTP-метод заглавными буквами или * — любой.', examples: ['GET', 'POST', '*'] });
// Схема JSON файла видит только выражение и длину: остальное о сегментах проверяет templateIssue.
const PATH_TEMPLATE = /^\/[^?#\s]*$/;

const pathTpl = z
  .string()
  .regex(PATH_TEMPLATE, 'шаблон пути начинается с «/», без «?», «#» и пробелов')
  .max(MAX_PATH, `путь длиннее ${MAX_PATH} символов`)
  .superRefine((v, ctx) => {
    // Начало, запрещённые знаки и длину уже назвали выражение и предел выше.
    if (!PATH_TEMPLATE.test(v) || v.length > MAX_PATH) return;
    const issue = templateIssue(v);
    if (issue) ctx.addIssue({ code: 'custom', message: issue });
  })
  .meta({ description: 'Шаблон пути: начинается с «/», подстановка {имя} занимает сегмент целиком, без строки запроса. Имя подстановки задаёт тип id, на выбор метода не влияет.', examples: ['/v1/users/{userId}/cards/{cardId}', '/v3/cards/info', '/'] });
const rpc = z
  .string()
  .trim()
  .max(LIMITS.rpc)
  .regex(/^[A-Za-z0-9_.:-]*$/, 'действие: латинские буквы, цифры, «_», «.», «:» и «-»')
  .meta({ description: 'Действие SOAP (первый элемент Body без префикса) или метод JSON-RPC. Пусто — метод без действия. У входа в проект действие не читается: у системы проекта проверка предупредит.', examples: ['getCard', 'risk.check', ''] });
const httpStatus = z.number().int('HTTP-статус — целое число').min(100, 'HTTP-статус от 100 до 599').max(599, 'HTTP-статус от 100 до 599');
const code = z
  .union([z.string().trim().min(1).max(LIMITS.code, `код не длиннее ${LIMITS.code} символов`), z.number().int()])
  .meta({ description: 'Код ошибки из тела ответа или контекста записи. Коды из цифр сравниваются как числа: «00» и «0» — один код.', examples: ['200', '-350', 'PRC-ERR-0027'] });
const fieldPath = z
  .string()
  .max(LIMITS.fieldPath, `путь поля не длиннее ${LIMITS.fieldPath} символов`)
  .regex(FIELD_PATH, 'путь поля: имена через точку, например data.status')
  .meta({ description: 'Путь поля. JSON — имена через точку по объектам, без массивов. XML — локальное имя элемента (берётся первый элемент с таким именем; у пути с точками — последнее имя).', examples: ['status', 'data.transfer_data.state', 'response_code'] });
const scalar = z.union([z.string().max(LIMITS.value, `значение не длиннее ${LIMITS.value} символов`), z.number(), z.boolean()]);

const statusDef = z
  .strictObject({
    value: str(LIMITS.statusValue, 'Значение статуса, как в словаре типа операции.', ['processing', 'completed', '2']),
    name: str(LIMITS.name, 'Название статуса для людей.', ['В обработке', 'Выполнен']),
    outcome: z.enum(STATUS_OUTCOMES, { error: 'итог статуса: pending, success или failure' }).meta({ description: 'Итог статуса: pending — в процессе, success — успех, failure — отказ.', examples: ['pending'] }),
  })
  .meta({ description: 'Статус операции в словаре типа.', examples: [{ value: 'processing', name: 'В обработке', outcome: 'pending' }] });

const idField = z
  .strictObject({
    in: z.enum(['query', 'request', 'response'], { error: 'где поле: query, request или response' }).meta({ description: 'Где поле: query — строка запроса, request — тело отправки (у входа — тело входящей записи), response — тело ответа.', examples: ['request'] }),
    path: fieldPath,
    type: idTypeKey,
  })
  .meta({ description: 'Id вне пути: место, путь поля и тип id из idTypes.', examples: [{ in: 'request', path: 'ext_transfer_id', type: 'transfer' }] });

const statusAt = z
  .strictObject({
    in: z.enum(['request', 'response'], { error: 'где статус: request или response' }).meta({ description: 'Тело, где лежит статус: request или response.', examples: ['response'] }),
    path: fieldPath,
    map: z
      .record(z.string().trim().min(1).max(LIMITS.statusValue), z.string().trim().min(1).max(LIMITS.statusValue))
      .optional()
      .meta({ description: 'Перевод значений из записи в значения словаря типа операции, без учёта регистра.', examples: [{ complete: 'completed', error: 'failed' }] }),
  })
  .meta({ description: 'Поле статуса операции. Есть только у метода с op.', examples: [{ in: 'response', path: 'data.transfer_data.state' }] });

const httpRange = z
  .strictObject({
    from: httpStatus.meta({ description: 'Начало диапазона HTTP-статусов, включительно.', examples: [400] }),
    to: httpStatus.meta({ description: 'Конец диапазона HTTP-статусов, включительно.', examples: [499] }),
  })
  .meta({ description: 'Диапазон HTTP-статусов включительно.', examples: [{ from: 400, to: 499 }] });
const httpCond = z
  .union([
    httpStatus.meta({ description: 'Точный HTTP-статус.', examples: [422] }),
    httpRange,
    z
      .array(z.union([httpStatus.meta({ description: 'Точный HTTP-статус в списке.', examples: [200] }), httpRange]).meta({ description: 'Элемент списка: статус или диапазон.' }))
      .min(1)
      .max(20)
      .meta({ description: 'Список HTTP-статусов и диапазонов.', examples: [[200, 202]] }),
  ])
  .meta({ description: 'Условие на HTTP-статус ответа: число, диапазон {from, to} или список.', examples: [422, { from: 400, to: 499 }, [200, 202]] });

const fieldCond = z
  .strictObject({
    in: z.enum(['response', 'request'], { error: 'где поле: response или request' }).optional().meta({ description: 'Тело ответа (по умолчанию) или тело отправки этого обмена.', examples: ['response'] }),
    path: fieldPath,
    equals: scalar.optional().meta({ description: 'Равно: сравнение текстом без пробелов по краям и без учёта регистра; 2 и "2" равны.', examples: ['OK', 'error', 0] }),
    oneOf: z
      .array(scalar.meta({ description: 'Значение из списка.', examples: ['PENDING'] }))
      .min(1)
      .max(LIMITS.oneOf, `не больше ${LIMITS.oneOf} значений`)
      .optional()
      .meta({ description: 'Одно из значений, сравнение как у equals.', examples: [['PENDING', 'PROCESSING']] }),
    exists: z.boolean().optional().meta({ description: 'true — поле есть и не null; false — поля нет или оно null.', examples: [true] }),
    regex: z.string().min(1).max(LIMITS.regex, `выражение не длиннее ${LIMITS.regex} символов`).optional().meta({ description: 'Регулярное выражение по значению поля (читаются первые 1000 символов). Регистр учитывается. Чтобы не учитывать, начните с (?i). Флаги только в начале: (?i), (?s) или (?is).', examples: ['^Timeout', '(?i)timeout'] }),
  })
  .meta({ description: 'Условие на поле тела: ровно одна проверка — equals, oneOf, exists или regex.', examples: [{ path: 'status', equals: 'OK' }] });

const conditions = z
  .strictObject({
    http: httpCond.optional(),
    fields: z.array(fieldCond).max(LIMITS.conditions, `не больше ${LIMITS.conditions} условий на поля`).optional().meta({ description: 'Условия на поля тела ответа или отправки. Правило подходит, если выполнены все.', examples: [[{ path: 'status', equals: 'OK' }]] }),
  })
  .meta({ description: 'Условия правила итога: HTTP-статус и поля тела. Нужно хотя бы одно условие; правило подходит, если выполнены все.', examples: [{ http: 200, fields: [{ path: 'status', equals: 'error' }] }] });

const hidden = z.boolean().optional().meta({ description: 'true — запись скрыта и в сопоставлении не участвует.', examples: [true] });

// ---------- Записи ----------

export const idTypeShape = {
  key: idTypeKey,
  kind: z.enum(ID_KINDS, { error: 'вид типа: entity или operation' }).meta({ description: 'entity — сущность (пользователь, карта, счёт): на страницах запроса и операции не показывается, проверка предупредит. operation — операция (платёж, перевод): от неё появляется кнопка «Открыть операцию».', examples: ['operation'] }),
  name: str(LIMITS.name, 'Название типа.', ['Перевод', 'Пользователь']),
  statuses: z.array(statusDef).max(LIMITS.statuses, `не больше ${LIMITS.statuses} статусов`).optional().meta({ description: 'Словарь статусов операции по порядку жизни. У сущности словаря нет.', examples: [[{ value: 'processing', name: 'В обработке', outcome: 'pending' }]] }),
  hidden,
};

export const systemShape = {
  key: systemKey,
  kind: z.enum(SYSTEM_KINDS, { error: 'вид системы: project или external' }).optional().meta({ description: 'project — система-автор проекта (одна, её key равен id проекта), external — внешняя система (по умолчанию).', examples: ['external'] }),
  type: z.enum(SYSTEM_TYPES, { error: 'тип системы: service, database или queue' }).optional().meta({ description: 'service — HTTP, SOAP, JSON-RPC (по умолчанию), database — база данных, queue — шина сообщений. У базы и шины нет методов и не работают правила итога. Отдельных шагов шины в логах нет, проверка предупредит.', examples: ['service'] }),
  name: str(LIMITS.name, 'Название системы.', ['Карточный коммутатор', 'Процессинг карт']),
  hosts: z
    .array(z.string().trim().min(1).max(255).meta({ description: 'Шаблон хоста.', examples: ['switch.pay.example:11101'] }))
    .max(LIMITS.hosts)
    .optional()
    .meta({ description: 'Шаблоны хостов: host, host:port, [ipv6]:port или *.domain. Регистр не важен. Один шаблон — у одной системы.', examples: [['switch.pay.example:11101', '*.acquirer.example']] }),
  description: opt(str(LIMITS.long, 'Описание системы.', ['REST JSON. Успех: HTTP 200 и непустой result'])),
  hidden,
};

export const methodShape = {
  http: httpVerb,
  path: pathTpl,
  rpc: rpc.optional(),
  name: str(LIMITS.name, 'Название метода.', ['Данные карты', 'Статус перевода']),
  domain: opt(str(LIMITS.domain, 'Домен метода.', ['Карты', 'Переводы'])),
  description: opt(str(LIMITS.long, 'Описание метода.', ['Возвращает реквизиты карты'])),
  kind: z.enum(METHOD_KINDS, { error: 'вид метода: call, start, status или callback' }).optional().meta({ description: 'call — обычный (синхронный), start — создание операции (асинхронная отправка), status — статус операции, callback — колбэк в проект (только у системы-автора).', examples: ['status'] }),
  op: opt(idTypeKey.meta({ description: 'Тип операции — ключ типа вида operation из idTypes. Обязателен у start, status и callback.', examples: ['transfer'] })),
  fields: z.array(idField).max(LIMITS.fields, `не больше ${LIMITS.fields} полей id`).optional().meta({ description: 'Id вне пути: строка запроса, тело отправки или ответа.', examples: [[{ in: 'request', path: 'request_id', type: 'payment' }]] }),
  status: opt(statusAt),
  hidden,
};

export const errorShape = {
  http: opt(httpStatus.meta({ description: 'HTTP-статус ответа, в том числе ниже 400: HTTP 200 с кодом ошибки в теле. У записи приложения статуса нет, правило с этим условием к ней не подходит.', examples: [404, 200] })),
  code: opt(code),
  text: opt(str(LIMITS.match, `Подстрока текста ошибки, от ${LIMITS.matchMin} символов, без учёта регистра, лишних пробелов и переводов строк.`, ['PRC-ERR-0027', 'deadlock detected'], LIMITS.matchMin)),
  title: str(LIMITS.title, 'Человеческий текст ошибки.', ['Карта не найдена']),
  action: opt(str(LIMITS.long, '«Что делать» для второй линии.', ['Проверить статус карты в коммутаторе'])),
  severity: z.enum(SEVERITIES, { error: 'важность: error или ok' }).optional().meta({ description: 'error — ошибка (по умолчанию), ok — «не ошибка»: шаг не красный, запрос не ошибочный.', examples: ['ok'] }),
  partnerCode: opt(z.string().trim().min(1).max(LIMITS.code).meta({ description: 'Код проекта, который по реестру получит партнёр.', examples: ['176'] })),
  hidden,
};

export const outcomeShape = {
  priority: z.number().int().min(LIMITS.priorityMin, 'приоритет от 1 до 1000').max(LIMITS.priorityMax, 'приоритет от 1 до 1000').optional().meta({ description: 'Порядок внутри уровня: меньше — раньше. По умолчанию 100.', examples: [10, 100] }),
  when: conditions,
  outcome: z.enum(OUTCOMES, { error: 'итог: success, error, pending или ignore' }).meta({ description: 'success — успех, error — ошибка, pending — в обработке, ignore — не ошибка.', examples: ['success'] }),
  text: opt(z.string().trim().min(1).max(LIMITS.outcomeText, `текст не длиннее ${LIMITS.outcomeText} символов`).meta({ description: 'Свой текст или шаблон: {путь} подставляет значение поля тела ответа, до 5 мест.', examples: ['{message}', 'Отказ партнёра: {error.message}'] })),
  action: opt(str(LIMITS.long, '«Что делать» для второй линии.', ['Повторить через минуту'])),
  hidden,
};

export const idTypeInput = z.strictObject(idTypeShape);
export const systemInput = z.strictObject(systemShape);
export const methodInput = z.strictObject(methodShape);
export const errorInput = z.strictObject(errorShape);
export const outcomeInput = z.strictObject(outcomeShape);

export type IdTypeInput = z.infer<typeof idTypeInput>;
export type SystemInput = z.infer<typeof systemInput>;
export type MethodInput = z.infer<typeof methodInput>;
export type ErrorInput = z.infer<typeof errorInput>;
export type OutcomeInput = z.infer<typeof outcomeInput>;

// ---------- Нормализация ----------

const orNull = <T>(v: T | null | undefined): T | null => (v === undefined || v === null ? null : v);
const textOrNull = (v: string | null | undefined): string | null => (v === undefined || v === null || v.trim() === '' ? null : v.trim());

export function toIdTypeData(i: IdTypeInput): IdTypeData {
  return { key: i.key, kind: i.kind, name: i.name, statuses: i.statuses ?? [] };
}
export function toSystemData(i: SystemInput): SystemData {
  return {
    key: i.key,
    kind: i.kind ?? 'external',
    type: i.type ?? 'service',
    name: i.name,
    hosts: (i.hosts ?? []).map(normalizeHostPattern),
    description: textOrNull(i.description),
  };
}
export function toMethodData(i: MethodInput): MethodData {
  const status = orNull(i.status);
  return {
    http: i.http,
    path: i.path,
    rpc: i.rpc ?? '',
    name: i.name,
    domain: textOrNull(i.domain),
    description: textOrNull(i.description),
    kind: i.kind ?? 'call',
    op: orNull(i.op),
    fields: i.fields ?? [],
    status: status && (status.map && Object.keys(status.map).length > 0 ? status : { in: status.in, path: status.path }),
  };
}
export function toErrorData(i: ErrorInput): ErrorData {
  return {
    http: orNull(i.http),
    code: i.code === undefined || i.code === null ? null : String(i.code).trim(),
    text: textOrNull(i.text),
    title: i.title,
    action: textOrNull(i.action),
    severity: i.severity ?? 'error',
    partnerCode: textOrNull(i.partnerCode),
  };
}
export function toOutcomeData(i: OutcomeInput): OutcomeData {
  return {
    priority: i.priority ?? DEFAULT_PRIORITY,
    when: normalizeConditions(i.when),
    outcome: i.outcome,
    text: textOrNull(i.text),
    action: textOrNull(i.action),
  };
}

/** Условия в каноническом виде: in по умолчанию response, пустые части убраны. */
export function normalizeConditions(c: Conditions): Conditions {
  const out: Conditions = {};
  if (c.http !== undefined) out.http = c.http;
  if (c.fields && c.fields.length > 0) {
    out.fields = c.fields.map((f) => {
      const g: FieldCond = { in: f.in ?? 'response', path: f.path };
      if (f.equals !== undefined) g.equals = f.equals;
      if (f.oneOf !== undefined) g.oneOf = f.oneOf;
      if (f.exists !== undefined) g.exists = f.exists;
      if (f.regex !== undefined) g.regex = f.regex;
      return g;
    });
  }
  return out;
}

/** JSON с ключами по алфавиту: одинаковые условия дают одну строку. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (typeof v === 'object' && v !== null) {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

/** Ключ условий правила итога: sha1 канонических условий. */
export function condKey(when: Conditions): string {
  return sha1(canonicalJson(normalizeConditions(when)));
}

/** Код для сравнения: число без ведущих нулей или текст без пробелов по краям. */
export function codeKey(code: string | number | null | undefined): string | null {
  if (code === null || code === undefined) return null;
  const s = String(code).trim();
  if (s === '') return null;
  return /^-?\d+$/.test(s) ? BigInt(s).toString() : s;
}

// ---------- Проверки ----------

const NO_KEEP: ReadonlySet<string> = new Set();
const MASK_MESSAGE = 'уберите номер карты, секрет или значение другого вида маски: маскирование скрыло бы часть текста';
const SENSITIVE_MESSAGE = 'это поле маскируется: номер карты, секрет или заголовок авторизации нельзя показывать и сравнивать';
const KIND_MESSAGE = 'это поле маскируется: значение вида маски нельзя показывать и сравнивать';

/** Что-то скрыла бы маска: первый проход или виды, включённые по умолчанию, какое бы значение ни имел переключатель вида. */
const wouldHide = (v: string) => maskText(v, NO_KEEP) !== v || maskKindsText(v, BUILTIN_MASKING.strict, NO_KEEP) !== v;

/** Путь поля, значение которого правило открыло бы в браузере. */
export function sensitivePathIssue(path: string, at: string): Issue[] {
  const kind = sensitivePath(path);
  return kind ? [{ path: at, message: kind === 'kind' ? KIND_MESSAGE : SENSITIVE_MESSAGE }] : [];
}

/**
 * Строки записи, где маскирование что-то скрыло бы. Значение в сообщение не попадает.
 * policy — настройка проекта: добавляется к встроенной проверке, а не заменяет её.
 */
export function maskIssues(value: unknown, path: string, policy?: MaskPolicy): Issue[] {
  const out: Issue[] = [];
  const hides = (v: string) => wouldHide(v) || (policy !== undefined && maskKindsText(v, policy, NO_KEEP) !== v);
  const walk = (v: unknown, at: string) => {
    if (typeof v === 'string') {
      if (hides(v)) out.push({ path: at, message: MASK_MESSAGE });
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, at ? `${at}.${i}` : String(i)));
    else if (typeof v === 'object' && v !== null) {
      for (const [k, x] of Object.entries(v)) {
        // Ключ с номером в путь не идёт: путь уходит в ответ и в журнал.
        const safe = hides(k) ? '***' : k;
        if (safe !== k) out.push({ path: at, message: MASK_MESSAGE });
        walk(x, at ? `${at}.${safe}` : safe);
      }
    } else if (typeof v === 'number' && Math.abs(v) >= 1e11) {
      // Число из 12–19 цифр в значении условия — возможный номер карты; знак и дробная часть его не скрывают.
      const d = String(Math.trunc(Math.abs(v)));
      if (hides(d)) out.push({ path: at, message: MASK_MESSAGE });
    }
  };
  walk(value, path);
  return out;
}

const join = (a: string, b: string) => (a && b ? `${a}.${b}` : a || b);

/** Ошибки zod с путём; лишнее поле — путь до него самого. */
export function zodIssues(error: z.ZodError, prefix = ''): Issue[] {
  const out: Issue[] = [];
  flattenIssues(error.issues, [], prefix, out);
  return out;
}

function flattenIssues(issues: readonly z.core.$ZodIssue[], base: readonly PropertyKey[], prefix: string, out: Issue[]): void {
  for (const i of issues) {
    const full = [...base, ...i.path];
    const at = join(prefix, full.map(String).join('.'));
    if (i.code === 'unrecognized_keys') {
      for (const k of i.keys) out.push({ path: join(at, k), message: 'неизвестное поле' });
    } else if (i.code === 'invalid_union' && i.errors.length > 0) {
      // Ошибки самого близкого варианта объединения: меньше всего ошибок.
      const best = [...i.errors].sort((a, b) => a.length - b.length)[0]!;
      const typeOnly = best.every((x) => x.code === 'invalid_type' && x.path.length === 0);
      if (typeOnly) out.push({ path: at, message: 'неверный тип значения' });
      else flattenIssues(best, full, prefix, out);
    } else if (isMissingField(i)) out.push({ path: at, ...REQUIRED_FIELD });
    else out.push({ path: at, message: i.message });
  }
}

/** Выражение условия: диалект профиля формата и линейный движок. */
export function regexIssue(source: string): string | null {
  const c = checkRe2(source);
  if (!c.ok) return c.reason;
  return linearIssue(source);
}

const PLACEHOLDER = /\{([A-Za-z0-9_.:-]+)\}/g;

/** Места {путь} шаблона текста или ошибка шаблона. */
export function templatePlaceholders(text: string): { ok: true; paths: string[] } | { ok: false; message: string } {
  const paths: string[] = [];
  const rest = text.replace(PLACEHOLDER, (_m, p: string) => {
    paths.push(p);
    return '';
  });
  if (/[{}]/.test(rest)) return { ok: false, message: 'незакрытая или пустая «{»: место подстановки пишется {путь}' };
  if (paths.length > LIMITS.placeholders) return { ok: false, message: `не больше ${LIMITS.placeholders} мест подстановки` };
  return { ok: true, paths };
}

export function checkIdType(d: IdTypeData, at = ''): Issue[] {
  const out: Issue[] = [];
  if (d.kind === 'entity' && d.statuses.length > 0) out.push({ path: join(at, 'statuses'), message: 'у сущности нет словаря статусов' });
  const seen = new Set<string>();
  d.statuses.forEach((s, i) => {
    const v = s.value.toLowerCase();
    if (seen.has(v)) out.push({ path: join(at, `statuses.${i}.value`), message: 'статус уже есть в словаре' });
    seen.add(v);
  });
  out.push(...maskIssues({ key: d.key, name: d.name, statuses: d.statuses }, at));
  return out;
}

export interface SystemContext {
  project: string;
  /** Шаблоны хостов других систем проекта → название системы. */
  otherHosts: ReadonlyMap<string, string>;
}

export const HIDDEN_AUTHOR_MESSAGE = 'систему-автора нельзя скрыть: без неё входы проекта остаются неизвестными';

export function checkSystem(d: SystemData, ctx: SystemContext, at = ''): Issue[] {
  const out: Issue[] = [];
  if (d.kind === 'project' && d.key !== ctx.project) out.push({ path: join(at, 'key'), message: `ключ системы-автора равен id проекта «${ctx.project}»` });
  // Ключ занят автором: иначе файл без kind сделал бы автора внешней системой, и проект остался бы без автора.
  if (d.kind !== 'project' && d.key === ctx.project) out.push({ path: join(at, 'kind'), message: 'система с ключом проекта — система-автор: нужен kind: project' });
  if (d.kind === 'project' && d.type !== 'service') out.push({ path: join(at, 'type'), message: 'система-автор — сервис' });
  const seen = new Set<string>();
  d.hosts.forEach((h, i) => {
    const p = join(at, `hosts.${i}`);
    if (!parseHostPattern(h)) out.push({ path: p, message: 'шаблон хоста: host, host:port, [ipv6]:port или *.domain' });
    else if (seen.has(h)) out.push({ path: p, message: 'шаблон хоста повторяется' });
    else {
      const other = ctx.otherHosts.get(h);
      if (other !== undefined) out.push({ path: p, message: `хост уже у системы «${other}»` });
    }
    seen.add(h);
  });
  out.push(...maskIssues({ key: d.key, hosts: d.hosts, name: d.name, description: d.description }, at));
  return out;
}

export interface MethodContext {
  system: Pick<SystemData, 'kind' | 'type'>;
  idTypes: ReadonlyMap<string, Pick<IdTypeData, 'kind' | 'statuses'>>;
}

export function checkMethod(d: MethodData, ctx: MethodContext, at = ''): Issue[] {
  const out: Issue[] = [];
  const p = (k: string) => join(at, k);
  if (ctx.system.type !== 'service') out.push({ path: p('path'), message: 'у базы данных и шины сообщений нет методов' });
  if (d.kind === 'callback' && ctx.system.kind !== 'project') out.push({ path: p('kind'), message: 'колбэк бывает только у системы-автора' });
  if (d.kind !== 'call' && !d.op) out.push({ path: p('op'), message: 'у этого вида метода нужен тип операции' });
  const op = d.op ? ctx.idTypes.get(d.op) : undefined;
  if (d.op && !op) out.push({ path: p('op'), message: `типа «${d.op}» нет: сначала заведите его в «Идентификаторах»` });
  else if (op && op.kind !== 'operation') out.push({ path: p('op'), message: `тип «${d.op}» — сущность, а нужен тип операции` });
  d.fields.forEach((f, i) => {
    if (!ctx.idTypes.has(f.type)) out.push({ path: p(`fields.${i}.type`), message: `типа «${f.type}» нет: сначала заведите его в «Идентификаторах»` });
    out.push(...sensitivePathIssue(f.path, p(`fields.${i}.path`)));
  });
  if (d.status) {
    out.push(...sensitivePathIssue(d.status.path, p('status.path')));
    if (!d.op) out.push({ path: p('status'), message: 'поле статуса бывает только у метода с типом операции' });
    else if (op && op.kind === 'operation' && d.status.map) {
      const values = new Set(op.statuses.map((s) => s.value.toLowerCase()));
      for (const [k, v] of Object.entries(d.status.map)) {
        if (!values.has(v.toLowerCase())) out.push({ path: p(`status.map.${k}`), message: `значения «${v}» нет в словаре статусов типа «${d.op}»` });
      }
    }
  }
  for (const name of templateParams(d.path)) {
    if (!PARAM_NAME.test(name)) out.push({ path: p('path'), message: 'имя подстановки: латиница, цифры, «_» и «-»' });
  }
  out.push(...maskIssues({ path: d.path, rpc: d.rpc, name: d.name, domain: d.domain, description: d.description, fields: d.fields, status: d.status }, at));
  return out;
}

export function checkError(d: ErrorData, at = ''): Issue[] {
  const out: Issue[] = [];
  if (d.http === null && d.code === null && d.text === null) out.push({ path: at, message: 'нужно хотя бы одно условие: HTTP-статус, код или подстрока' });
  out.push(...maskIssues({ code: d.code, text: d.text, title: d.title, action: d.action, partnerCode: d.partnerCode }, at));
  return out;
}

export function checkConditions(c: Conditions, at = ''): Issue[] {
  const out: Issue[] = [];
  const fields = c.fields ?? [];
  if (c.http === undefined && fields.length === 0) out.push({ path: at, message: 'нужно хотя бы одно условие: HTTP-статус или поле' });
  const ranges = c.http === undefined ? [] : Array.isArray(c.http) ? c.http : [c.http];
  ranges.forEach((r, i) => {
    if (typeof r === 'object' && r.from > r.to) out.push({ path: join(at, Array.isArray(c.http) ? `http.${i}` : 'http'), message: 'начало диапазона больше конца' });
  });
  fields.forEach((f, i) => {
    const fp = join(at, `fields.${i}`);
    const checks = [f.equals !== undefined, f.oneOf !== undefined, f.exists !== undefined, f.regex !== undefined].filter(Boolean).length;
    if (checks !== 1) out.push({ path: fp, message: 'у условия ровно одна проверка: equals, oneOf, exists или regex' });
    if (f.regex !== undefined) {
      const issue = regexIssue(f.regex);
      if (issue) out.push({ path: join(fp, 'regex'), message: issue });
    }
    // «Есть» значение не открывает, сравнение с образцом позволило бы его подобрать.
    if (f.exists === undefined) out.push(...sensitivePathIssue(f.path, join(fp, 'path')));
  });
  out.push(...maskIssues(fields, join(at, 'fields')));
  return out;
}

export function checkOutcome(d: OutcomeData, at = ''): Issue[] {
  const out = checkConditions(d.when, join(at, 'when'));
  if (d.text !== null) {
    const t = templatePlaceholders(d.text);
    if (!t.ok) out.push({ path: join(at, 'text'), message: t.message });
    else if (t.paths.some((p) => sensitivePath(p))) out.push({ path: join(at, 'text'), message: `в шаблоне: ${t.paths.some((p) => sensitivePath(p) !== 'kind') ? SENSITIVE_MESSAGE : KIND_MESSAGE}` });
  }
  out.push(...maskIssues({ text: d.text, action: d.action }, at));
  return out;
}

/** Смысловой ключ метода внутри системы: HTTP, путь без имён подстановок, действие. */
export function methodKey(systemKey: string, m: Pick<MethodData, 'http' | 'path' | 'rpc'>): string {
  return `${systemKey}|${m.http}|${pathKey(m.path)}|${m.rpc}`;
}
/** Текст для сравнения подстроки: регистр, лишние пробелы и переводы строк не важны, в том числе `\n` и `\r`, записанные буквами в сыром JSON. */
export const matchText = (s: string): string => s.replace(/(?:\s|\\+[nr])+/g, ' ').trim().toLowerCase();

export function errorKey(systemKey: string | null, methodKeyOrNull: string | null, e: Pick<ErrorData, 'http' | 'code' | 'text'>): string {
  return `${systemKey ?? '*'}|${methodKeyOrNull ?? '*'}|${e.http ?? ''}|${codeKey(e.code) ?? ''}|${matchText(e.text ?? '')}`;
}
export function outcomeKey(systemKey: string | null, methodKeyOrNull: string | null, o: Pick<OutcomeData, 'when'>): string {
  return `${systemKey ?? '*'}|${methodKeyOrNull ?? '*'}|o|${condKey(o.when)}`;
}
