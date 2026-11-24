// Файл справочника версии 1: схема, чтение с проверкой, ключи записей, разница с базой, выгрузка.
// Разбор YAML — на сервере; здесь — уже разобранный объект.

import { z } from 'zod';
import { maskText } from '../search/masking.ts';
import { MASK_KIND_CODES, MASK_KINDS, type MaskKind } from '../search/mask-kinds.ts';
import { maskingKeyIssues, MAX_MASKING_KEYS } from '../search/mask-fields.ts';
import { compileMasking, type MaskingRowLike } from '../search/mask-pass.ts';
import { GENERAL_HTTP_ONLY, hiddenPart, httpOnlyRule, TEXT_HIDDEN } from './general-rule.ts';
import {
  checkError,
  checkIdType,
  checkMethod,
  checkOutcome,
  checkSystem,
  canonicalJson,
  errorInput,
  errorKey,
  errorShape,
  HIDDEN_AUTHOR_MESSAGE,
  idTypeInput,
  maskIssues,
  methodInput,
  methodKey,
  methodShape,
  outcomeInput,
  outcomeKey,
  outcomeShape,
  systemShape,
  toErrorData,
  toIdTypeData,
  toMethodData,
  toOutcomeData,
  toSystemData,
  zodIssues,
  type CatalogSnapshot,
  type ErrorData,
  type IdKind,
  type IdTypeData,
  type Issue,
  type MethodData,
  type OutcomeData,
  type StatusDef,
  type SystemData,
} from './schema.ts';

export const CATALOG_FORMAT_VERSION = 1;

// ---------- Схема файла ----------

const methodRef = z
  .strictObject({ http: methodShape.http, path: methodShape.path, rpc: methodShape.rpc })
  .meta({ description: 'Ссылка на метод этой системы: HTTP-метод, шаблон пути и действие. Без поля — правило всей системы.', examples: [{ http: 'POST', path: '/v3/cards/token' }] });

const fileError = z
  .strictObject({ method: methodRef.optional(), ...errorShape })
  .meta({ description: 'Правило ошибки: условия (HTTP-статус, код, подстрока — хотя бы одно) и человеческий текст.', examples: [{ code: '200', title: 'Карта не найдена', partnerCode: '176' }] });
const fileOutcome = z
  .strictObject({ method: methodRef.optional(), ...outcomeShape })
  .meta({ description: 'Правило итога ответа. Уровни: метод (сильнее), система, весь проект; внутри — по priority. Первое подходящее решает итог вместо общих признаков ошибки.', examples: [{ when: { http: 422, fields: [{ path: 'status', equals: 'OK' }] }, outcome: 'success' }] });
const fileMethod = methodInput.meta({
  description: 'Метод системы.',
  examples: [{ http: 'GET', path: '/v1/users/{userId}/cards/{cardId}', name: 'Данные карты', domain: 'Карты' }],
});
const fileIdType = idTypeInput.meta({
  description: 'Тип id: сущность или операция со словарём статусов.',
  examples: [{ key: 'transfer', kind: 'operation', name: 'Перевод', statuses: [{ value: 'completed', name: 'Выполнен', outcome: 'success' }] }],
});
const fileSystem = z
  .strictObject({
    ...systemShape,
    methods: z.array(fileMethod).optional().meta({ description: 'Методы системы. У базы данных и шины методов нет.' }),
    errors: z.array(fileError).optional().meta({ description: 'Правила ошибок системы и её методов.' }),
    outcomes: z.array(fileOutcome).optional().meta({ description: 'Правила итога системы и её методов. У базы данных и шины не работают: у их записей нет ответа.' }),
  })
  .meta({ description: 'Система: система-автор проекта (kind: project) или внешняя система.', examples: [{ key: 'switch', name: 'Карточный коммутатор', hosts: ['switch.pay.example:9191'] }] });
const fileGeneral = z
  .strictObject({
    errors: z.array(errorInput.meta({ description: 'Общее правило ошибки проекта. Одного HTTP-статуса мало: проверка предупредит, нужны ещё код или подстрока.' })).optional().meta({ description: 'Общие правила ошибок проекта.' }),
    outcomes: z.array(outcomeInput.meta({ description: 'Общее правило итога проекта.' })).optional().meta({ description: 'Общие правила итога проекта.' }),
  })
  .meta({ description: 'Общие правила проекта: проверяются после правил метода и системы, для неузнанных систем — только они.', examples: [{ errors: [{ http: 504, text: 'gateway timeout', title: 'Система не ответила вовремя' }] }] });

const fileMaskingRow = z
  .strictObject({
    type: z.enum(MASK_KIND_CODES).meta({ description: 'Вид маски: номер карты, секреты, данные карты, токен карты, номер счёта, телефон, личный номер, паспорт, фамилия, имя и отчество, дата рождения, e-mail или адрес.', examples: ['phone'] }),
    enabled: z.boolean().meta({ description: 'Включено ли маскирование вида. Выключенный вид открыт в блоках подробностей записи для всех пользователей проекта. У «Номера карты» и «Секретов» выключателя нет: только true.', examples: [true] }),
    keys: z.array(z.string().meta({ description: 'Имя поля: латиница, цифры, «_», «.», «:» и «-».', examples: ['client_mobile_alt'] })).max(MAX_MASKING_KEYS).optional().meta({ description: 'Поля, добавленные к встроенным. Нет поля — пустой список.', examples: [['client_mobile_alt']] }),
  })
  .meta({ description: 'Настройка вида маски. Вид, не названный в файле, не меняется.', examples: [{ type: 'phone', enabled: true, keys: ['client_mobile_alt'] }] });

const projectId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, 'id проекта: строчные латинские буквы, цифры и дефис').meta({ description: 'Id проекта из threadline.yaml.', examples: ['pay'] });

export const catalogFileV1 = z
  .strictObject({
    $schema: z.string().optional().meta({ description: 'Ссылка на эту схему для редактора кода (необязательно).' }),
    version: z.literal(CATALOG_FORMAT_VERSION).meta({ description: 'Версия формата файла справочника. Поддерживается 1.' }),
    project: projectId,
    idTypes: z.array(fileIdType).optional().meta({ description: 'Типы id проекта.' }),
    systems: z.array(fileSystem).optional().meta({ description: 'Системы: система-автор и внешние системы.' }),
    general: fileGeneral.optional(),
    masking: z.array(fileMaskingRow).optional().meta({ description: 'Маскирование проекта: переключатель и добавленные поля каждого вида маски. Раздела нет — настройка не меняется. Начальный набор этот раздел пропускает.' }),
  })
  .meta({
    title: 'Файл справочника Threadline, версия 1',
    description:
      'Справочник проекта: типы id, системы с методами, ошибками и правилами итога, общие правила. YAML или JSON одной структуры. Импорт идемпотентный: запись ищется по смысловому ключу, ручные правки редактора без --force не меняются, записи не удаляются.',
    examples: [
      {
        version: 1,
        project: 'pay',
        systems: [{ key: 'switch', name: 'Карточный коммутатор', methods: [{ http: 'POST', path: '/v3/cards/info', name: 'Данные карты в коммутаторе' }], errors: [{ code: '200', title: 'Карта не найдена' }] }],
      },
    ],
  });

export type CatalogFileV1 = z.infer<typeof catalogFileV1>;

// Правила, которых нет в типах zod: сервер проверяет их кодом, а редактору и модели их видно только здесь. Что схемой
// не выразить — другие записи файла, диапазон from–to, разбор regex, номер карты в тексте — проверяет только сервер.
const PATH_PATTERN = '^/$|^(?:/(?:\\{[^{}/\\s]+\\}|[^{}/?#\\s]+))+$';
const NAME_PART = '[A-Za-z0-9_](?:[A-Za-z0-9_-]*[A-Za-z0-9_])?';
const HOST_PATTERN = `^\\s*(?:\\*\\.[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)+|\\[[0-9A-Fa-f:.]+\\](?::[0-9]{1,5})?|${NAME_PART}(?:\\.${NAME_PART})*(?::[0-9]{1,5})?)\\s*$`;
const TEMPLATE_PATTERN = '^[^{]*(?:\\{[^{]*){0,5}$';
const requiredOne = (keys: string[]) => keys.map((k) => ({ required: [k] }));

type Node = Record<string, unknown>;
const props = (o: Node): Node => (o.properties ?? {}) as Node;
const isNode = (v: unknown): v is Node => typeof v === 'object' && v !== null;

function addSchemaRules(o: Node): void {
  const p = props(o);
  // Условие на поле: ровно одна проверка.
  if (p.path && p.equals && p.oneOf && p.exists && p.regex) o.oneOf = requiredOne(['equals', 'oneOf', 'exists', 'regex']);
  // Условия правила итога: хотя бы одно.
  else if (p.http && p.fields && !p.title && !p.name) {
    o.anyOf = [{ required: ['http'] }, { required: ['fields'], properties: { fields: { minItems: 1, description: 'Хотя бы одно условие на поле.' } } }];
  }
  // Ошибка: хотя бы одно условие.
  else if (p.title && p.code && p.text && p.http) o.anyOf = requiredOne(['http', 'code', 'text']);
  // Правило итога: шаблон текста — не больше пяти мест подстановки.
  else if (p.when && p.outcome && isNode(p.text)) p.text = withPattern(p.text, TEMPLATE_PATTERN);
  // Метод: шаблон пути; start, status и callback — с типом операции.
  else if (p.path && p.http && p.name && p.kind) {
    p.path = withPattern(p.path as Node, PATH_PATTERN);
    o.if = { properties: { kind: { enum: ['start', 'status', 'callback'] } }, required: ['kind'] };
    o.then = { required: ['op'] };
  }
  // Тип id: статусы только у операции.
  else if (p.statuses && p.kind) {
    o.if = { properties: { kind: { const: 'entity' } }, required: ['kind'] };
    o.then = { properties: { statuses: { maxItems: 0 } } };
  }
  // Система: шаблоны хостов; у базы и шины методов нет; колбэк — только у системы-автора.
  else if (p.hosts && p.key && p.methods) {
    const items = (p.hosts as Node).items;
    if (isNode(items)) (p.hosts as Node).items = withPattern(items, HOST_PATTERN);
    o.allOf = [
      { if: { properties: { type: { enum: ['database', 'queue'] } }, required: ['type'] }, then: { properties: { methods: { maxItems: 0 } } } },
      {
        if: { not: { properties: { kind: { const: 'project' } }, required: ['kind'] } },
        then: { properties: { methods: { items: { properties: { kind: { not: { const: 'callback' } } } } } } },
      },
    ];
  }
}

/** Значение с pattern. У необязательного поля zod даёт anyOf со строкой и null: pattern — у строки. */
function withPattern(schema: Node, pattern: string): Node {
  const variants = schema.anyOf;
  if (Array.isArray(variants)) return { ...schema, anyOf: variants.map((v) => (isNode(v) && v.type === 'string' ? { ...v, pattern } : v)) };
  return { ...schema, pattern };
}

function walkSchema(v: unknown): void {
  if (Array.isArray(v)) v.forEach(walkSchema);
  else if (isNode(v)) {
    addSchemaRules(v);
    Object.values(v).forEach(walkSchema);
  }
}

/** Схема JSON файла справочника: config/catalog/catalog.schema.json. */
export function catalogJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(catalogFileV1, { io: 'input', target: 'draft-2020-12' }) as Record<string, unknown>;
  walkSchema(schema);
  return schema;
}

// ---------- Записи файла ----------

interface EntryBase {
  key: string;
  hidden: boolean;
  /** Путь записи в файле: systems.2.methods.5. */
  at: string;
}
export interface IdTypeEntry extends EntryBase {
  data: IdTypeData;
}
export interface SystemEntry extends EntryBase {
  data: SystemData;
}
export interface MethodEntry extends EntryBase {
  systemKey: string;
  data: MethodData;
}
export interface ErrorEntry extends EntryBase {
  systemKey: string | null;
  methodKey: string | null;
  data: ErrorData;
}
export interface OutcomeEntry extends EntryBase {
  systemKey: string | null;
  methodKey: string | null;
  data: OutcomeData;
}
export interface MaskingEntry {
  type: MaskKind;
  enabled: boolean;
  keys: string[];
  at: string;
}
export interface FileEntries {
  idTypes: IdTypeEntry[];
  systems: SystemEntry[];
  methods: MethodEntry[];
  errors: ErrorEntry[];
  outcomes: OutcomeEntry[];
  masking: MaskingEntry[];
}

/** Что уже есть в справочнике: на типы и методы базы файл может ссылаться. */
export interface KnownCatalog {
  idTypes: ReadonlyMap<string, { kind: IdKind; statuses: StatusDef[] }>;
  /** Ключи методов: нынешний и ключ записи файла. Метод, у которого поправили путь, файл знает по старому. */
  methodKeys: ReadonlySet<string>;
  /** Шаблон хоста → ключ и название системы базы. */
  hosts: ReadonlyMap<string, { key: string; name: string }>;
  /** Сколько видимых методов базы ссылаются на тип id: op или поле id. */
  typeUses: ReadonlyMap<string, number>;
  /** Сколько методов у системы базы: тип базы или шины ей уже не поставить. */
  systemMethods: ReadonlyMap<string, number>;
  /** Настройка маскирования базы: поле другого вида файл не добавит. */
  masking: readonly MaskingRowLike[];
}

export const EMPTY_KNOWN: KnownCatalog = { idTypes: new Map(), methodKeys: new Set(), hosts: new Map(), typeUses: new Map(), systemMethods: new Map(), masking: [] };

/** Настоящее состояние вида: нет строки — состояние по умолчанию, у вида с замком значение строки не действует. */
function maskingEnabled(type: MaskKind, row: { enabled: boolean } | undefined): boolean {
  if (!MASK_KINDS[type].switchable) return true;
  return row?.enabled ?? MASK_KINDS[type].defaultEnabled;
}

/** Типы id, на которые ссылается метод. */
const methodTypes = (m: Pick<MethodData, 'op' | 'fields'>): Set<string> => new Set([...(m.op ? [m.op] : []), ...m.fields.map((f) => f.type)]);

/** Известное из строк базы: видимые типы, методы и хосты. */
export function knownOf(s: CatalogSnapshot): KnownCatalog {
  const sysKey = new Map(s.systems.map((x) => [x.id, x.key]));
  const hosts = new Map<string, { key: string; name: string }>();
  for (const x of s.systems) if (!x.hidden) for (const h of x.hosts) hosts.set(h, { key: x.key, name: x.name });
  const methodKeys = new Set<string>();
  const typeUses = new Map<string, number>();
  const systemMethods = new Map<string, number>();
  for (const m of s.methods) {
    const sys = sysKey.get(m.systemId) ?? '';
    systemMethods.set(sys, (systemMethods.get(sys) ?? 0) + 1);
    if (m.hidden) continue;
    methodKeys.add(methodKey(sys, m));
    if (m.seedKey !== null) methodKeys.add(m.seedKey);
    for (const t of methodTypes(m)) typeUses.set(t, (typeUses.get(t) ?? 0) + 1);
  }
  return {
    idTypes: new Map(s.idTypes.filter((t) => !t.hidden).map((t) => [t.key, { kind: t.kind, statuses: t.statuses }])),
    methodKeys,
    hosts,
    typeUses,
    systemMethods,
    masking: s.masking ?? [],
  };
}

type Loose = Record<string, unknown>;
const isObj = (v: unknown): v is Loose => typeof v === 'object' && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const topLevel = z.strictObject({
  $schema: z.string().optional(),
  version: z.literal(CATALOG_FORMAT_VERSION),
  project: projectId,
  // Раздел настроек проверяет @threadline/core/catalog/project-file: сюда он не идёт, иначе zod и проверки форм попали бы в этот модуль.
  settings: z.unknown().optional(),
  idTypes: z.array(z.unknown()).optional(),
  systems: z.array(z.unknown()).optional(),
  general: z.strictObject({ errors: z.array(z.unknown()).optional(), outcomes: z.array(z.unknown()).optional() }).optional(),
  masking: z.array(z.unknown()).optional(),
});
const systemTop = z.strictObject({ ...systemShape, methods: z.array(z.unknown()).optional(), errors: z.array(z.unknown()).optional(), outcomes: z.array(z.unknown()).optional() });

export type ReadResult = { ok: true; entries: FileEntries; warnings: Issue[] } | { ok: false; errors: Issue[]; warnings: Issue[] };

/**
 * Поля, которые проверка принимает, но которые ничего не делают: файл применяется, автор об этом знает.
 * Скрытая запись и запись скрытой системы и так не действуют, о них не говорим.
 */
function fileWarnings(e: FileEntries): Issue[] {
  const out: Issue[] = [];
  const systems = new Map(e.systems.map((s) => [s.key, s]));
  const acts = (x: { hidden: boolean; systemKey: string | null }) => !x.hidden && !(x.systemKey !== null && systems.get(x.systemKey)?.hidden);
  const entities = e.idTypes.filter((t) => !t.hidden && t.data.kind === 'entity');
  if (entities.length > 0) {
    const types = entities.map((t) => t.key).join(', ');
    out.push({
      path: `${entities[0]!.at}.kind`,
      message: `типы вида entity (${types}) на страницах запроса и операции не показываются: они видны только в разделе «Идентификаторы». Нужна кнопка «Открыть операцию»: поставьте kind: operation. Иначе ничего делать не нужно`,
      key: 'catalog.entityNotShown',
      params: { types },
    });
  }
  for (const s of e.systems) {
    if (s.hidden || s.data.type !== 'queue') continue;
    out.push({ path: `${s.at}.type`, message: 'отдельных шагов шины в логах Threadline не находит: система видна в справочнике и на HTTP-вызовах на её хост. Если это HTTP-сервис, уберите type', key: 'catalog.queueNoSteps' });
  }
  for (const m of e.methods) {
    if (!acts(m) || m.data.rpc === '' || systems.get(m.systemKey)?.data.kind !== 'project') continue;
    out.push({ path: `${m.at}.rpc`, message: 'у входа в проект действие не читается: на входе этот метод не сработает. Оставьте на этом адресе один метод без rpc', key: 'catalog.rpcOnEntry' });
  }
  const typeOf = (x: { systemKey: string | null }) => (x.systemKey === null ? undefined : systems.get(x.systemKey)?.data.type);
  for (const r of e.errors) {
    if (!acts(r) || r.data.http === null || typeOf(r) !== 'database') continue;
    out.push({ path: `${r.at}.http`, message: 'у записи базы нет HTTP-статуса: правило с этим условием не сработает. Уберите http', key: 'catalog.errorHttpOnDatabase' });
  }
  // Форма такое правило не сохранит. Файл применяется: прежние файлы должны загружаться.
  for (const r of e.errors) {
    if (acts(r) && r.systemKey === null && httpOnlyRule(r.data)) out.push({ path: `${r.at}.http`, ...GENERAL_HTTP_ONLY });
    if (acts(r) && hiddenPart(r.data.text)) out.push({ path: `${r.at}.text`, ...TEXT_HIDDEN });
  }
  for (const r of e.outcomes) {
    const type = typeOf(r);
    if (!acts(r) || (type !== 'database' && type !== 'queue')) continue;
    out.push({ path: r.at, message: 'правила итога проверяются только на HTTP-ответах: у записи базы данных и шины ответа нет, это правило не сработает. Уберите его', key: 'catalog.outcomeNoResponse' });
  }
  return out;
}

/**
 * Проверка файла: версия и проект, схема каждой записи, ссылки, повторы ключей, хосты, маскирование.
 * Все ошибки сразу, у каждой путь к полю; значений, которые скрыло бы маскирование, в сообщениях нет.
 */
export function readCatalogFile(input: unknown, project: string, known: KnownCatalog = EMPTY_KNOWN): ReadResult {
  if (!isObj(input)) return { ok: false, errors: [{ path: '', message: 'файл справочника — объект YAML или JSON с полями version и project' }], warnings: [] };
  if (input.version !== CATALOG_FORMAT_VERSION) return { ok: false, errors: [{ path: 'version', message: `поддерживается версия формата ${CATALOG_FORMAT_VERSION}` }], warnings: [] };
  if (typeof input.project === 'string' && input.project !== project) {
    return { ok: false, errors: [{ path: 'project', message: `файл проекта «${input.project}», а загрузка в справочник «${project}»` }], warnings: [] };
  }
  const errors: Issue[] = [];
  const top = topLevel.safeParse(input);
  if (!top.success) errors.push(...zodIssues(top.error));
  const entries: FileEntries = { idTypes: [], systems: [], methods: [], errors: [], outcomes: [], masking: [] };
  const seen = new Map<string, string>();
  const unique = (key: string, at: string, what: string) => {
    const first = seen.get(key);
    if (first !== undefined) errors.push({ path: at, message: `${what} повторяется: та же запись в ${first}` });
    else seen.set(key, at);
    return first === undefined;
  };

  // Типы id
  arr(input.idTypes).forEach((raw, i) => {
    const at = `idTypes.${i}`;
    const r = idTypeInput.safeParse(raw);
    if (!r.success) return void errors.push(...zodIssues(r.error, at));
    const data = toIdTypeData(r.data);
    errors.push(...checkIdType(data, at));
    if (unique(`t|${data.key}`, at, `тип «${data.key}»`)) entries.idTypes.push({ key: data.key, hidden: r.data.hidden ?? false, at, data });
  });
  const types = new Map<string, { kind: IdKind; statuses: StatusDef[] }>(known.idTypes);
  for (const t of entries.idTypes) types.set(t.data.key, { kind: t.data.kind, statuses: t.data.statuses });

  // Системы
  const hostOwner = new Map<string, { key: string; name: string; at: string }>();
  const systemsRaw = arr(input.systems);
  const parsedSystems: { at: string; data: SystemData; raw: Loose }[] = [];
  let projectSystems = 0;
  systemsRaw.forEach((raw, i) => {
    const at = `systems.${i}`;
    const r = systemTop.safeParse(raw);
    if (!r.success) {
      errors.push(...zodIssues(r.error, at));
      return;
    }
    const { methods: _m, errors: _e, outcomes: _o, ...rest } = r.data;
    const data = toSystemData(rest);
    if (data.kind === 'project') projectSystems++;
    if (projectSystems > 1 && data.kind === 'project') errors.push({ path: `${at}.kind`, message: 'система-автор (kind: project) в файле одна' });
    const others = new Map<string, string>();
    for (const [h, o] of hostOwner) if (o.key !== data.key) others.set(h, o.name);
    for (const [h, o] of known.hosts) if (o.key !== data.key && !others.has(h)) others.set(h, o.name);
    errors.push(...checkSystem(data, { project, otherHosts: others }, at));
    if (data.key === project && rest.hidden === true) errors.push({ path: `${at}.hidden`, message: HIDDEN_AUTHOR_MESSAGE });
    // Методы файла проверяет checkMethod; здесь — те, что уже в базе.
    const stored = known.systemMethods.get(data.key) ?? 0;
    if (data.type !== 'service' && stored > 0) errors.push({ path: `${at}.type`, message: `у системы ${stored} методов в справочнике: у базы данных и шины сообщений методов нет` });
    for (const h of data.hosts) if (!hostOwner.has(h)) hostOwner.set(h, { key: data.key, name: data.name, at });
    if (unique(`s|${data.key}`, at, `система «${data.key}»`)) {
      entries.systems.push({ key: data.key, hidden: rest.hidden ?? false, at, data });
      parsedSystems.push({ at, data, raw: raw as Loose });
    }
  });

  // Методы, затем ошибки и правила: ссылки на методы своей системы
  for (const { at: sat, data: sys, raw } of parsedSystems) {
    const methodKeys = new Set<string>();
    arr(raw.methods).forEach((m, j) => {
      const at = `${sat}.methods.${j}`;
      const r = methodInput.safeParse(m);
      if (!r.success) return void errors.push(...zodIssues(r.error, at));
      const data = toMethodData(r.data);
      errors.push(...checkMethod(data, { system: sys, idTypes: types }, at));
      const key = methodKey(sys.key, data);
      if (unique(`m|${key}`, at, `метод ${data.http} ${data.path}${data.rpc ? ` ${data.rpc}` : ''}`)) {
        methodKeys.add(key);
        entries.methods.push({ key, systemKey: sys.key, hidden: r.data.hidden ?? false, at, data });
      }
    });
    const ref = (m: { http: MethodData['http']; path: string; rpc?: string | undefined } | undefined, at: string): string | null | false => {
      if (!m) return null;
      const key = methodKey(sys.key, { http: m.http, path: m.path, rpc: m.rpc ?? '' });
      if (methodKeys.has(key) || known.methodKeys.has(key)) return key;
      errors.push({ path: `${at}.method`, message: `у системы «${sys.key}» нет метода ${m.http} ${m.path}${m.rpc ? ` ${m.rpc}` : ''}` });
      return false;
    };
    arr(raw.errors).forEach((e, j) => {
      const at = `${sat}.errors.${j}`;
      const r = fileError.safeParse(e);
      if (!r.success) return void errors.push(...zodIssues(r.error, at));
      const { method, ...rest } = r.data;
      const mk = ref(method, at);
      const data = toErrorData(rest);
      errors.push(...checkError(data, at));
      if (mk === false) return;
      const key = errorKey(sys.key, mk, data);
      if (unique(`e|${key}`, at, 'правило ошибки с теми же условиями')) entries.errors.push({ key, systemKey: sys.key, methodKey: mk, hidden: rest.hidden ?? false, at, data });
    });
    arr(raw.outcomes).forEach((o, j) => {
      const at = `${sat}.outcomes.${j}`;
      const r = fileOutcome.safeParse(o);
      if (!r.success) return void errors.push(...zodIssues(r.error, at));
      const { method, ...rest } = r.data;
      const mk = ref(method, at);
      const data = toOutcomeData(rest);
      errors.push(...checkOutcome(data, at));
      if (mk === false) return;
      const key = outcomeKey(sys.key, mk, data);
      if (unique(`o|${key}`, at, 'правило итога с теми же условиями')) entries.outcomes.push({ key, systemKey: sys.key, methodKey: mk, hidden: rest.hidden ?? false, at, data });
    });
  }

  // Скрытый тип не должен держать методы: ни из файла, ни из базы.
  const uses = new Map(known.typeUses);
  for (const m of entries.methods) {
    if (m.hidden) continue;
    for (const t of methodTypes(m.data)) uses.set(t, (uses.get(t) ?? 0) + 1);
  }
  for (const t of entries.idTypes) {
    const n = uses.get(t.data.key) ?? 0;
    if (t.hidden && n > 0) errors.push({ path: `${t.at}.hidden`, message: `тип «${t.data.key}» используется в методах (${n}): скрыть нельзя` });
  }

  // Общие правила
  const general = isObj(input.general) ? input.general : {};
  arr(general.errors).forEach((e, j) => {
    const at = `general.errors.${j}`;
    const r = errorInput.safeParse(e);
    if (!r.success) return void errors.push(...zodIssues(r.error, at));
    const data = toErrorData(r.data);
    errors.push(...checkError(data, at));
    const key = errorKey(null, null, data);
    if (unique(`e|${key}`, at, 'правило ошибки с теми же условиями')) entries.errors.push({ key, systemKey: null, methodKey: null, hidden: r.data.hidden ?? false, at, data });
  });
  arr(general.outcomes).forEach((o, j) => {
    const at = `general.outcomes.${j}`;
    const r = outcomeInput.safeParse(o);
    if (!r.success) return void errors.push(...zodIssues(r.error, at));
    const data = toOutcomeData(r.data);
    errors.push(...checkOutcome(data, at));
    const key = outcomeKey(null, null, data);
    if (unique(`o|${key}`, at, 'правило итога с теми же условиями')) entries.outcomes.push({ key, systemKey: null, methodKey: null, hidden: r.data.hidden ?? false, at, data });
  });

  // Маскирование
  const parsedMasking: { row: MaskingEntry; i: number }[] = [];
  arr(input.masking).forEach((raw, i) => {
    const at = `masking.${i}`;
    if (isObj(raw) && 'hidden' in raw) errors.push({ path: `${at}.hidden`, message: 'вид нельзя скрыть, только выключить' });
    const r = fileMaskingRow.safeParse(isObj(raw) ? Object.fromEntries(Object.entries(raw).filter(([k]) => k !== 'hidden')) : raw);
    if (!r.success) return void errors.push(...zodIssues(r.error, at));
    if (!r.data.enabled && !MASK_KINDS[r.data.type].switchable) errors.push({ path: `${at}.enabled`, message: `у вида «${MASK_KINDS[r.data.type].label}» нет выключателя` });
    if (unique(`mask|${r.data.type}`, at, 'вид маскирования')) parsedMasking.push({ i, row: { type: r.data.type, enabled: r.data.enabled, keys: r.data.keys ?? [], at } });
  });
  const named = new Set(parsedMasking.map((m) => m.row.type));
  const fileRows: MaskingRowLike[] = [...parsedMasking.map((m) => m.row), ...known.masking.filter((m) => !named.has(m.type as MaskKind))];
  for (const { row } of parsedMasking) {
    errors.push(...maskingKeyIssues(row.type, row.keys, fileRows, `${row.at}.keys`));
    entries.masking.push(row);
  }

  // Встроенную проверку прошла каждая запись выше. Настройка проекта вместе с правкой этого же файла: файл с таким значением применился бы, а следующая выгрузка отказала.
  // Раздел masking не проверяется: в нём имена полей. Настройка вида тоже: в ней постоянные значения.
  const { view: _view, ...settingsText } = isObj(input.settings) ? input.settings : {};
  errors.push(...maskIssues({ idTypes: input.idTypes, systems: input.systems, general: input.general, settings: withoutExampleValues(settingsText) }, '', compileMasking(fileRows).strict));

  const warnings = fileWarnings(entries).map(maskedIssue);
  return errors.length > 0 ? { ok: false, errors: dedupe(errors).map(maskedIssue), warnings } : { ok: true, entries, warnings };
}

const NO_KEEP: ReadonlySet<string> = new Set();

/**
 * Значения примеров поиска — то, что вводят в строку поиска: номер карты или телефон в них законны, как в самой строке.
 * Маскирование их не проверяет, подписи проверяет. Места значений остаются пустыми списками: пути остальных полей прежние.
 */
export function withoutExampleValues(settings: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(settings.environments)) return settings;
  const environments = settings.environments.map((e: unknown) =>
    isObj(e) && Array.isArray(e.examples) ? { ...e, examples: e.examples.map((x: unknown) => (isObj(x) ? { ...x, values: [] } : x)) } : e,
  );
  return { ...settings, environments };
}

/** Ошибка цитирует ссылку или ключ из файла: значение, которое скрыла бы маска, в неё не попадает. */
const maskedIssue = (i: Issue): Issue => ({ ...i, path: maskText(i.path, NO_KEEP), message: maskText(i.message, NO_KEEP) });

function dedupe(issues: Issue[]): Issue[] {
  const seen = new Set<string>();
  return issues.filter((i) => {
    const k = `${i.path}|${i.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---------- Разница с базой ----------

/** Вид записи справочника в файле. */
export type EntryKind = 'idType' | 'system' | 'method' | 'error' | 'outcome' | 'masking';
/** Вид строки отчёта: записи справочника и раздел настроек проекта. */
export type ImportKind = EntryKind | 'settings' | 'environment' | 'view';

export interface ImportItem {
  kind: ImportKind;
  key: string;
  title: string;
  fields?: string[];
  /** Файл выключает вид маскирования: отчёт предупреждает отдельной строкой. */
  disables?: boolean;
  /** Правка меняет то, что читается: идущие поиски остановятся, как при сохранении формы. */
  stopsSearches?: boolean;
}

export interface ImportReport {
  project: string;
  dryRun: boolean;
  applied: boolean;
  added: ImportItem[];
  changed: ImportItem[];
  hidden: ImportItem[];
  skipped: ImportItem[];
  /** Импорт возвращает эти записи из скрытых. Сервер отдаёт поле всегда. */
  restored?: ImportItem[];
  /** Удалённые записи, которые файл не возвращает: скрытые человеком и удалённые навсегда. Сервер отдаёт поле всегда. */
  undeleted?: ImportItem[];
  unchanged: number;
  missing: number;
  /** Сколько сред из числа missing: их убирают на форме «Среды». */
  missingEnvironments?: number;
  errors: Issue[];
  /** Поля без действия и повторы: файл они не останавливают. Сервер отдаёт поле всегда. */
  warnings?: Issue[];
  /** Версия файла проекта: есть у всех отчётов, дошедших до базы. Клиент только сравнивает её на равенство. */
  version?: string;
}

export type PlanAction = 'add' | 'change' | 'hide';

interface PlanBase {
  action: PlanAction;
  rowId: number | null;
  key: string;
  hidden: boolean;
}
export type PlanItem =
  | (PlanBase & { kind: 'idType'; data: IdTypeData })
  | (PlanBase & { kind: 'system'; data: SystemData })
  | (PlanBase & { kind: 'method'; systemKey: string; data: MethodData })
  | (PlanBase & { kind: 'error'; systemKey: string | null; methodKey: string | null; data: ErrorData })
  | (PlanBase & { kind: 'outcome'; systemKey: string | null; methodKey: string | null; data: OutcomeData })
  | (PlanBase & { kind: 'masking'; data: { type: string; enabled: boolean; keys: string[] } });

export interface CatalogDiff {
  added: ImportItem[];
  changed: ImportItem[];
  hidden: ImportItem[];
  skipped: ImportItem[];
  restored: ImportItem[];
  undeleted: ImportItem[];
  unchanged: number;
  missing: number;
  /** Что применить, по порядку: типы → системы → методы → ошибки → правила, внутри — по порядку файла. */
  plan: PlanItem[];
}

interface RowLike {
  id: number;
  hidden: boolean;
  edited: boolean;
  seedKey: string | null;
}

/** Строки базы со смысловыми ключами. */
export function rowKeys(s: CatalogSnapshot) {
  const sysKey = new Map(s.systems.map((x) => [x.id, x.key]));
  const mKey = new Map(s.methods.map((m) => [m.id, methodKey(sysKey.get(m.systemId) ?? '', m)]));
  const sk = (id: number | null) => (id === null ? null : (sysKey.get(id) ?? null));
  const mk = (id: number | null) => (id === null ? null : (mKey.get(id) ?? null));
  return {
    idTypes: s.idTypes.map((r) => ({ row: r, key: r.key })),
    systems: s.systems.map((r) => ({ row: r, key: r.key })),
    methods: s.methods.map((r) => ({ row: r, key: mKey.get(r.id)! })),
    errors: s.errors.map((r) => ({ row: r, key: errorKey(sk(r.systemId), mk(r.methodId), r) })),
    outcomes: s.outcomeRules.map((r) => ({ row: r, key: outcomeKey(sk(r.systemId), mk(r.methodId), r) })),
  };
}

const IDTYPE_FIELDS = ['kind', 'name', 'statuses'] as const;
const SYSTEM_FIELDS = ['kind', 'type', 'name', 'hosts', 'description'] as const;
const METHOD_FIELDS = ['http', 'path', 'rpc', 'name', 'domain', 'description', 'kind', 'op', 'fields', 'status'] as const;
const ERROR_FIELDS = ['http', 'code', 'text', 'title', 'action', 'severity', 'partnerCode'] as const;
const OUTCOME_FIELDS = ['priority', 'when', 'outcome', 'text', 'action'] as const;

function differing<T extends object>(a: T, b: T, fields: readonly (keyof T)[]): string[] {
  return fields.filter((f) => canonicalJson(a[f] ?? null) !== canonicalJson(b[f] ?? null)).map(String);
}

/**
 * Разница файла и строк базы: запись файла ищет строку по seed_key, иначе по смысловому ключу строки.
 * Строки нет — added; равны — unchanged; различаются у ручной строки (edited или без seed_key) без force — skipped;
 * иначе changed с полями; видимая строка с hidden: true в файле — hidden. Строки набора без записи файла — missing.
 * Скрытая строка, которую файл не скрывает: ручная без force — undeleted, иначе restored. Ключ из deleted (удалена навсегда,
 * формат kind|ключ) и запись внутри такого родителя без force — undeleted, с force — added.
 */
export function diffCatalog(rows: CatalogSnapshot, entries: FileEntries, opts: { force: boolean; deleted?: ReadonlySet<string> }): CatalogDiff {
  const keyed = rowKeys(rows);
  const out: CatalogDiff = { added: [], changed: [], hidden: [], skipped: [], restored: [], undeleted: [], unchanged: 0, missing: 0, plan: [] };
  const matched = new Set<string>();
  // Родитель не добавлен: его метод или ошибку тоже некуда добавить.
  const refused = new Set<string>();
  const refusedParent = (e: { systemKey?: string | null; methodKey?: string | null }) =>
    (typeof e.systemKey === 'string' && refused.has(`system|${e.systemKey}`)) || (typeof e.methodKey === 'string' && refused.has(`method|${e.methodKey}`));

  const step = <R extends RowLike, D extends object>(
    kind: ImportKind,
    list: readonly { row: R; key: string }[],
    items: readonly (EntryBase & { data: D })[],
    fields: readonly (keyof D)[],
    dataOf: (r: R) => D,
    title: (d: D) => string,
    plan: (e: EntryBase & { data: D }, action: PlanAction, rowId: number | null) => PlanItem,
  ) => {
    const bySeed = new Map<string, R>();
    const byKey = new Map<string, R>();
    for (const { row, key } of list) {
      if (row.seedKey !== null) bySeed.set(row.seedKey, row);
      if (!byKey.has(key)) byKey.set(key, row);
    }
    for (const e of items) {
      const row = bySeed.get(e.key) ?? byKey.get(e.key);
      const item: ImportItem = { kind, key: e.key, title: title(e.data) };
      if (!row) {
        if (!opts.force && (opts.deleted?.has(`${kind}|${e.key}`) || refusedParent(e as { systemKey?: string | null; methodKey?: string | null }))) {
          refused.add(`${kind}|${e.key}`);
          out.undeleted.push(item);
          continue;
        }
        out.added.push(item);
        out.plan.push(plan(e, 'add', null));
        continue;
      }
      matched.add(`${kind}|${row.id}`);
      const diff = differing(dataOf(row), e.data, fields);
      if (row.hidden !== e.hidden) diff.push('hidden');
      if (diff.length === 0) {
        out.unchanged++;
        continue;
      }
      const manual = (row.edited || row.seedKey === null) && !opts.force;
      if (row.hidden && !e.hidden) {
        if (manual) {
          out.undeleted.push(item);
          continue;
        }
        out.restored.push(item);
        out.plan.push(plan(e, 'change', row.id));
        continue;
      }
      if (manual) {
        out.skipped.push({ ...item, fields: diff });
        continue;
      }
      if (e.hidden && !row.hidden) {
        out.hidden.push(item);
        out.plan.push(plan(e, 'hide', row.id));
      } else {
        out.changed.push({ ...item, fields: diff });
        out.plan.push(plan(e, 'change', row.id));
      }
    }
    for (const { row } of list) if (row.seedKey !== null && !matched.has(`${kind}|${row.id}`)) out.missing++;
  };

  step('idType', keyed.idTypes, entries.idTypes, IDTYPE_FIELDS, (r) => ({ key: r.key, kind: r.kind, name: r.name, statuses: r.statuses }), (d) => d.name, (e, action, rowId) => ({ kind: 'idType', action, rowId, key: e.key, hidden: e.hidden, data: e.data }));
  step('system', keyed.systems, entries.systems, SYSTEM_FIELDS, (r) => ({ key: r.key, kind: r.kind, type: r.type, name: r.name, hosts: r.hosts, description: r.description }), (d) => d.name, (e, action, rowId) => ({ kind: 'system', action, rowId, key: e.key, hidden: e.hidden, data: e.data }));
  step(
    'method',
    keyed.methods,
    entries.methods,
    METHOD_FIELDS,
    (r) => ({ http: r.http, path: r.path, rpc: r.rpc, name: r.name, domain: r.domain, description: r.description, kind: r.kind, op: r.op, fields: r.fields, status: r.status }),
    (d) => `${d.http} ${d.path}${d.rpc ? ` ${d.rpc}` : ''} · ${d.name}`,
    (e, action, rowId) => ({ kind: 'method', action, rowId, key: e.key, hidden: e.hidden, systemKey: (e as MethodEntry).systemKey, data: e.data }),
  );
  step(
    'error',
    keyed.errors,
    entries.errors,
    ERROR_FIELDS,
    (r) => ({ http: r.http, code: r.code, text: r.text, title: r.title, action: r.action, severity: r.severity, partnerCode: r.partnerCode }),
    (d) => d.title,
    (e, action, rowId) => ({ kind: 'error', action, rowId, key: e.key, hidden: e.hidden, systemKey: (e as ErrorEntry).systemKey, methodKey: (e as ErrorEntry).methodKey, data: e.data }),
  );
  step(
    'outcome',
    keyed.outcomes,
    entries.outcomes,
    OUTCOME_FIELDS,
    (r) => ({ priority: r.priority, when: r.when, outcome: r.outcome, text: r.text, action: r.action }),
    (d) => `${describeConditions(d.when)} → ${d.outcome}`,
    (e, action, rowId) => ({ kind: 'outcome', action, rowId, key: e.key, hidden: e.hidden, systemKey: (e as OutcomeEntry).systemKey, methodKey: (e as OutcomeEntry).methodKey, data: e.data }),
  );
  // Маскирование — свой шаг: ключ — вид, строка без seed_key не считается ручной, а «нет в файле» здесь не считается.
  const maskingRows = new Map((rows.masking ?? []).map((r) => [r.type, r]));
  const sorted = (k: readonly string[]) => [...k].sort();
  for (const e of entries.masking) {
    const row = maskingRows.get(e.type);
    const item: ImportItem = { kind: 'masking', key: e.type, title: MASK_KINDS[e.type].label };
    const data = { type: e.type, enabled: e.enabled, keys: e.keys };
    const was = { enabled: maskingEnabled(e.type, row), keys: row?.keys ?? [] };
    const fields = [...(was.enabled !== e.enabled ? ['enabled'] : []), ...(canonicalJson(sorted(was.keys)) !== canonicalJson(sorted(e.keys)) ? ['keys'] : [])];
    if (fields.length === 0) {
      out.unchanged++;
      continue;
    }
    const disables = was.enabled && !e.enabled;
    if (row?.edited && !opts.force) {
      out.skipped.push({ ...item, fields });
      continue;
    }
    out.changed.push({ ...item, fields, ...(disables ? { disables } : {}) });
    out.plan.push({ kind: 'masking', action: 'change', rowId: row?.id ?? null, key: e.type, hidden: false, data });
  }
  return out;
}

/** Условия правила итога коротким текстом: «HTTP 422 · status = OK». */
export function describeConditions(when: OutcomeData['when']): string {
  const parts: string[] = [];
  if (when.http !== undefined) {
    const one = (h: number | { from: number; to: number }) => (typeof h === 'number' ? String(h) : `${h.from}–${h.to}`);
    parts.push(`HTTP ${Array.isArray(when.http) ? when.http.map(one).join(', ') : one(when.http)}`);
  }
  for (const f of when.fields ?? []) {
    const where = f.in === 'request' ? 'запрос.' : '';
    if (f.equals !== undefined) parts.push(`${where}${f.path} = ${String(f.equals)}`);
    else if (f.oneOf !== undefined) parts.push(`${where}${f.path} ∈ ${f.oneOf.map(String).join(', ')}`);
    else if (f.exists !== undefined) parts.push(f.exists ? `${where}${f.path} есть` : `${where}${f.path} нет`);
    else if (f.regex !== undefined) parts.push(`${where}${f.path} ~ ${f.regex}`);
  }
  return parts.join(' · ');
}

// ---------- Выгрузка ----------

type Out = Record<string, unknown>;
const set = (o: Out, k: string, v: unknown, skip: unknown = null) => {
  if (v !== undefined && canonicalJson(v) !== canonicalJson(skip)) o[k] = v;
};

/** Условия без значений по умолчанию: in: response не пишется. */
function exportConditions(when: OutcomeData['when']): Out {
  const o: Out = {};
  if (when.http !== undefined) o.http = when.http;
  if (when.fields && when.fields.length > 0) {
    o.fields = when.fields.map((f) => {
      const g: Out = {};
      if (f.in === 'request') g.in = 'request';
      g.path = f.path;
      for (const k of ['equals', 'oneOf', 'exists', 'regex'] as const) if (f[k] !== undefined) g[k] = f[k];
      return g;
    });
  }
  return o;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Справочник проекта в файл версии 1 с устойчивым порядком: система-автор, затем системы по key; методы —
 * по пути, HTTP-методу и действию; ошибки и правила итога — правила метода по порядку методов, затем системы,
 * внутри — по порядку создания (порядок проверки правил при равном приоритете). Скрытые — с hidden: true.
 */
export function exportCatalog(s: CatalogSnapshot, settings?: Readonly<Record<string, unknown>>): CatalogFileV1 {
  const file: Out = { version: CATALOG_FORMAT_VERSION, project: s.project };
  // Сразу после project: короткие настройки в начале текста. Посев раздела не пишет.
  if (settings) file.settings = settings;
  const idTypes = [...s.idTypes].sort((a, b) => cmp(a.key, b.key));
  if (idTypes.length > 0) {
    file.idTypes = idTypes.map((t) => {
      const o: Out = { key: t.key, kind: t.kind, name: t.name };
      if (t.statuses.length > 0) o.statuses = t.statuses.map((x) => ({ value: x.value, name: x.name, outcome: x.outcome }));
      set(o, 'hidden', t.hidden, false);
      return o;
    });
  }
  const systems = [...s.systems].sort((a, b) => Number(b.kind === 'project') - Number(a.kind === 'project') || cmp(a.key, b.key));
  const methodsOf = (id: number) => s.methods.filter((m) => m.systemId === id).sort((a, b) => cmp(a.path, b.path) || cmp(a.http, b.http) || cmp(a.rpc, b.rpc));
  const methodById = new Map(s.methods.map((m) => [m.id, m]));
  const methodOrder = new Map<number, number>();
  const ref = (id: number | null) => {
    if (id === null) return undefined;
    const m = methodById.get(id)!;
    const o: Out = { http: m.http, path: m.path };
    if (m.rpc) o.rpc = m.rpc;
    return o;
  };
  const byLevel = <R extends { id: number; methodId: number | null }>(list: R[]) =>
    [...list].sort((a, b) => (a.methodId === null ? 1e9 : (methodOrder.get(a.methodId) ?? 0)) - (b.methodId === null ? 1e9 : (methodOrder.get(b.methodId) ?? 0)) || a.id - b.id);
  const errorOut = (e: CatalogSnapshot['errors'][number]): Out => {
    const o: Out = {};
    set(o, 'method', ref(e.methodId), undefined);
    set(o, 'http', e.http);
    set(o, 'code', e.code);
    set(o, 'text', e.text);
    o.title = e.title;
    set(o, 'action', e.action);
    set(o, 'severity', e.severity, 'error');
    set(o, 'partnerCode', e.partnerCode);
    set(o, 'hidden', e.hidden, false);
    return o;
  };
  const outcomeOut = (r: CatalogSnapshot['outcomeRules'][number]): Out => {
    const o: Out = {};
    set(o, 'method', ref(r.methodId), undefined);
    set(o, 'priority', r.priority, 100);
    o.when = exportConditions(r.when);
    o.outcome = r.outcome;
    set(o, 'text', r.text);
    set(o, 'action', r.action);
    set(o, 'hidden', r.hidden, false);
    return o;
  };
  if (systems.length > 0) {
    file.systems = systems.map((x) => {
      const o: Out = { key: x.key };
      set(o, 'kind', x.kind, 'external');
      set(o, 'type', x.type, 'service');
      o.name = x.name;
      set(o, 'hosts', x.hosts, []);
      set(o, 'description', x.description);
      set(o, 'hidden', x.hidden, false);
      const methods = methodsOf(x.id);
      methods.forEach((m, i) => methodOrder.set(m.id, i));
      if (methods.length > 0) {
        o.methods = methods.map((m) => {
          const mo: Out = { http: m.http, path: m.path };
          set(mo, 'rpc', m.rpc, '');
          mo.name = m.name;
          set(mo, 'domain', m.domain);
          set(mo, 'description', m.description);
          set(mo, 'kind', m.kind, 'call');
          set(mo, 'op', m.op);
          set(mo, 'fields', m.fields.map((f) => ({ in: f.in, path: f.path, type: f.type })), []);
          if (m.status) mo.status = m.status.map ? { in: m.status.in, path: m.status.path, map: m.status.map } : { in: m.status.in, path: m.status.path };
          set(mo, 'hidden', m.hidden, false);
          return mo;
        });
      }
      const errors = byLevel(s.errors.filter((e) => e.systemId === x.id));
      if (errors.length > 0) o.errors = errors.map(errorOut);
      const outcomes = byLevel(s.outcomeRules.filter((r) => r.systemId === x.id));
      if (outcomes.length > 0) o.outcomes = outcomes.map(outcomeOut);
      return o;
    });
  }
  const gErrors = s.errors.filter((e) => e.systemId === null).sort((a, b) => a.id - b.id);
  const gOutcomes = s.outcomeRules.filter((r) => r.systemId === null).sort((a, b) => a.priority - b.priority || a.id - b.id);
  if (gErrors.length > 0 || gOutcomes.length > 0) {
    const g: Out = {};
    if (gErrors.length > 0) g.errors = gErrors.map(errorOut);
    if (gOutcomes.length > 0) g.outcomes = gOutcomes.map(outcomeOut);
    file.general = g;
  }
  // Только виды, которые знает код, в порядке словаря: строка другого вида не загрузилась бы обратно.
  const maskingRows = new Map((s.masking ?? []).map((r) => [r.type, r]));
  file.masking = MASK_KIND_CODES.map((type) => {
    const r = maskingRows.get(type);
    const o: Out = { type, enabled: maskingEnabled(type, r) };
    if (r && r.keys.length > 0) o.keys = r.keys;
    return o;
  });
  return file as CatalogFileV1;
}

/** Число записей выгрузки по видам: для отчёта команды. */
export function countEntries(s: CatalogSnapshot): Record<EntryKind, number> {
  return { idType: s.idTypes.length, system: s.systems.length, method: s.methods.length, error: s.errors.length, outcome: s.outcomeRules.length, masking: MASK_KIND_CODES.length };
}
