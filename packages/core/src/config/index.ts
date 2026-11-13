// Схема файла настроек Threadline: проекты, среды, хранилища.
// Проверка собирает все ошибки сразу, у каждой путь к полю.

import { VALUE_LIST } from './value-list.ts';
import { z } from 'zod';
import { ROLES, type Role } from '../access/index.ts';
import { RESERVED_PROJECT_IDS } from '../api.ts';
import type { MessageRef } from '../messages.ts';
import { BUILTIN_FORMAT } from '../profile/builtin.ts';
import { checkRe2, linearIssue } from '../profile/regex.ts';
import { checkProfile } from '../profile/schema.ts';
import type { Profile } from '../profile/types.ts';
import { isValidTimeZone } from '../time.ts';
import { PATTERN_KINDS, patternIssue, REGIONAL_LIMITS, type PatternKind } from '../search/regional.ts';
import { checkExamples, exampleSchema } from './examples.ts';

z.config(z.locales.ru());

const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const idSchema = z.string().regex(ID, 'идентификатор: строчные латинские буквы, цифры и дефис, до 32 символов');
export const labelSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'имя метки: латинские буквы, цифры и подчёркивание');
const envVarSchema = z
  .string()
  .regex(/^[A-Z_][A-Z0-9_]*$/, 'имя переменной окружения: заглавные латинские буквы, цифры и подчёркивание');
const positiveInt = z.number().int().positive();

const limits = {
  maxConcurrent: z.number().int().min(1).max(32).default(4),
  queueTimeoutSeconds: positiveInt.default(60),
  timeoutSeconds: positiveInt.default(30),
};

export const MOCK_FAIL_MODES = [
  'unauthorized',
  'forbidden',
  'not-found',
  'network',
  'certificate',
  'timeout',
  'overloaded',
  'limit',
  'bad-response',
] as const;

// Граница формы: значение точное, «начало*» или «*». Регулярных выражений нет.
const formScopeSchema = z.strictObject({
  label: labelSchema,
  values: z
    .array(z.string().min(1).refine((v) => !v.slice(0, -1).includes('*'), { message: 'звёздочка бывает только в конце значения' }))
    .min(1, 'нужно хотя бы одно значение'),
});

/** Без имени, пароля, параметров и фрагмента. Сам адрес проверяет z.url, значение в сообщение не попадает. */
function plainUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return !u.username && !u.password && !u.search && !u.hash;
  } catch {
    return true;
  }
}

const lokiGrafanaSchema = z.strictObject({
  type: z.literal('loki-grafana'),
  url: z.url({ protocol: /^https?$/, error: 'адрес Grafana вида https://grafana.corp.example' }),
  /** Адрес Grafana для браузера пользователя, если сервер ходит к ней по другому. По умолчанию url. */
  publicUrl: z
    .url({ protocol: /^https?$/, error: 'адрес Grafana для браузера вида https://grafana.corp.example' })
    .refine(plainUrl, { message: 'адрес Grafana для браузера: без имени, пароля, параметров и фрагмента' })
    .optional(),
  /** false убирает ссылку «Открыть в Grafana» у сред этого хранилища. По умолчанию ссылка есть. */
  exploreLink: z.boolean().optional(),
  datasource: z
    .union([
      z.strictObject({ id: z.number().int().positive() }),
      z.strictObject({ name: z.string().trim().min(1) }),
      z.strictObject({ uid: z.string().trim().min(1) }),
    ])
    .default({ name: 'Loki' }),
  tokenEnv: envVarSchema,
  caFile: z.string().trim().min(1).optional(),
  formScope: formScopeSchema.optional(),
  ...limits,
});

/** Арендатор Loki для X-Scope-OrgID: символы из документации Loki, несколько арендаторов через |. */
const TENANT = /^[A-Za-z0-9!._*'()|-]{1,150}$/;

/** Loki напрямую, без Grafana: HTTP API /loki/api/v1. Учётные данные только из переменных окружения, их имена в tokenEnv или usernameEnv и passwordEnv. */
const lokiSchema = z
  .strictObject({
    type: z.literal('loki'),
    url: z
      .url({ protocol: /^https?$/, error: 'адрес Loki вида http://loki:3100' })
      .refine(plainUrl, { message: 'адрес Loki: без имени, пароля, параметров и фрагмента, учётные данные задаются переменными окружения' })
      .refine((v) => !/\/loki(?:\/api(?:\/v1)?)?\/*$/.test(v), { message: 'адрес Loki без /loki/api/v1 на конце: путь API Threadline добавляет сам' }),
    /** Заголовок X-Scope-OrgID для Loki с несколькими арендаторами. Нет поля — заголовка нет. */
    tenant: z.string().regex(TENANT, 'арендатор Loki: латинские буквы, цифры и !._*\'()-, до 150 символов, несколько через |').optional(),
    /** Токен Bearer. */
    tokenEnv: envVarSchema.optional(),
    /** Basic: имя и пароль, обе переменные вместе. */
    usernameEnv: envVarSchema.optional(),
    passwordEnv: envVarSchema.optional(),
    caFile: z.string().trim().min(1).optional(),
    formScope: formScopeSchema.optional(),
    ...limits,
  })
  .superRefine((b, ctx) => {
    if (b.tokenEnv && (b.usernameEnv || b.passwordEnv)) {
      ctx.addIssue({ code: 'custom', path: ['tokenEnv'], message: 'вход в Loki один: tokenEnv (Bearer) или usernameEnv и passwordEnv (Basic), не оба' });
    } else if (!b.usernameEnv !== !b.passwordEnv) {
      ctx.addIssue({ code: 'custom', path: [b.usernameEnv ? 'passwordEnv' : 'usernameEnv'], message: 'для входа Basic нужны обе переменные: usernameEnv и passwordEnv' });
    }
  });

const mockSchema = z.strictObject({
  type: z.literal('mock'),
  dataset: z.enum(['pay']).default('pay'),
  latencyMs: z.number().int().min(0).max(60_000).default(0),
  fail: z.enum(MOCK_FAIL_MODES).optional(),
  ...limits,
});

const backendSchema = z.discriminatedUnion('type', [lokiGrafanaSchema, lokiSchema, mockSchema]);

const matcherSchema = z.strictObject({
  label: labelSchema,
  op: z.enum(['=', '!=', '=~', '!~']),
  value: z.string(),
  /** Исключение только для обычного поиска: поиск операции это условие не применяет. Только у `!=`. */
  searchOnly: z.boolean().optional(),
});

const environmentSchema = z.strictObject({
  name: z.string().trim().min(1),
  kind: z.enum(['single', 'pr-stands']).default('single'),
  backend: idSchema,
  selector: z.array(matcherSchema).default([]),
  stand: z.strictObject({ label: labelSchema, template: z.string() }).optional(),
  /** Примеры поиска на стартовой странице среды: подпись, значения и период. Правила значений — у строки поиска (checkExamples). */
  examples: z.array(exampleSchema).optional(),
});

// Логотип лежит в папке файла настроек: так отсекаются .., абсолютные пути, ~, обратные косые и адреса.
const logoFileSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/,
    'файл должен лежать в папке файла настроек: путь от неё, сегменты из латинских букв, цифр, точки, дефиса и подчёркивания, сегмент не начинается с точки',
  )
  .regex(/\.(?:png|svg)$/i, 'логотип бывает только в форматах PNG и SVG');

const projectLogoSchema = z.strictObject({ light: logoFileSchema, dark: logoFileSchema.optional() });

export const projectSchema = z.strictObject({
  name: z.string().trim().min(1),
  /** Логотип в шапке: файлы проверяет и раздаёт сервер. */
  logo: projectLogoSchema.optional(),
  /** Профиль формата записей: встроенный json или ключ секции formats. */
  format: idSchema.default(BUILTIN_FORMAT),
  retentionDays: z.number().int().min(1).max(400).default(30),
  timezone: z
    .string()
    .refine(isValidTimeZone, { message: 'неизвестный часовой пояс, нужно имя из базы часовых поясов, например Europe/Berlin' })
    .default('UTC'),
  environments: z.record(idSchema, environmentSchema),
});

const searchSchema = z
  .strictObject({
    countChunkMinutes: z.number().int().min(5).max(24 * 60).default(60),
    maxRequests: z.number().int().min(1).max(1000).default(200),
    batchSize: z.number().int().min(1).max(200).default(50),
    maxLinesPerQuery: z.number().int().min(100).max(50_000).default(5000),
    maxLinesPerSearch: z.number().int().min(100).max(200_000).default(20_000),
    periodMarginMinutes: z.number().int().min(0).max(60).default(5),
  })
  .prefault({});

// Раздел входа: http только на этой машине, адрес без имени, пароля, параметров и фрагмента.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);
const authUrl = (field: string, example: string) =>
  z
    .url({ protocol: /^https?$/, error: `${field} вида ${example}` })
    .refine(plainUrl, { message: `${field}: без имени, пароля, параметров и фрагмента` })
    .refine(
      (v) => {
        try {
          const u = new URL(v);
          return u.protocol === 'https:' || LOCAL_HOSTS.has(u.hostname);
        } catch {
          return true;
        }
      },
      { message: `${field}: нужен https, http только для localhost и 127.0.0.1` },
    );

const roleNames = z.array(z.string().trim().min(1)).min(1, 'нужно хотя бы одно имя роли из токена');

export const authSchema = z.strictObject({
  /** Адрес провайдера OIDC, от которого читается .well-known/openid-configuration. У Keycloak это адрес realm. */
  issuer: authUrl('адрес провайдера OIDC', 'https://sso.corp.example/realms/threadline'),
  clientId: z.string().trim().min(1),
  publicUrl: authUrl('адрес сервиса', 'https://threadline.corp.example').refine(
    (v) => {
      try {
        return new URL(v).pathname === '/';
      } catch {
        return true;
      }
    },
    { message: 'адрес сервиса: без пути, сервис открывается от корня адреса' },
  ),
  /**
   * Поле токена со списком ролей: имя поля или путь через точку. Keycloak: realm_access.roles или resource_access.<клиент>.roles;
   * у других провайдеров обычно groups или roles. Поле с точкой в имени (https://threadline.corp.example/roles) находится по имени целиком.
   */
  roleClaim: z.string().regex(/^[A-Za-z0-9_:/-]+(?:\.[A-Za-z0-9_:/-]+)*$/, 'поле токена: имя или путь через точку, например groups или realm_access.roles'),
  /** Области запроса сверх openid и profile: groups, если провайдер кладёт группы только по ней. */
  scopes: z.array(z.string().regex(/^[\x21\x23-\x5B\x5D-\x7E]+$/, 'область запроса: печатные латинские символы без пробела, кавычек и обратной косой черты')).optional(),
  roles: z.strictObject(Object.fromEntries(ROLES.map((r) => [r, roleNames])) as Record<Role, typeof roleNames>),
  caFile: z.string().trim().min(1).optional(),
});

export type AuthSettings = z.infer<typeof authSchema>;
/** off — вход выключен явно: каждый запрос получает права администратора. */
export type AuthConfig = 'off' | AuthSettings;

// Дополнения интерфейса: выключатель шуток интерфейса.
export const extrasSchema = z.strictObject({
  publicEggs: z.boolean().default(true),
});
export type ExtrasConfig = z.infer<typeof extrasSchema>;

// Региональные правила (search/regional.ts): план номеров страны и образцы видов маски в тексте. Без раздела — международные
// правила: телефон с «+», личный номер и паспорт по именам полей. Выражения проверяет checkRegional.
const phonePlanSchema = z.strictObject({
  countryCode: z.string().regex(/^[1-9]\d{0,2}$/, 'код страны: от 1 до 3 цифр без плюса, первая не ноль'),
  nationalDigits: z.number().int().min(4).max(14),
  trunkPrefix: z.string().regex(/^\d{1,2}$/, 'местный префикс: одна или две цифры').optional(),
  groups: z.array(z.number().int().min(1).max(14)).min(1).max(6).optional(),
});
const patternListSchema = z
  .array(z.string().min(1).max(REGIONAL_LIMITS.patternLength, `образец не длиннее ${REGIONAL_LIMITS.patternLength} символов`))
  .min(1)
  .max(REGIONAL_LIMITS.patternsPerKind, `не больше ${REGIONAL_LIMITS.patternsPerKind} образцов на вид`);
export const regionalSchema = z.strictObject({
  phone: phonePlanSchema.optional(),
  patterns: z
    .strictObject(Object.fromEntries(PATTERN_KINDS.map((k) => [k, patternListSchema.optional()])) as Record<PatternKind, z.ZodOptional<typeof patternListSchema>>)
    .optional(),
});
export type RegionalConfig = z.infer<typeof regionalSchema>;

export const configSchema = z.strictObject({
  // Раздел проверяет checkAuth в перекрёстной проверке: там пути к полям и два варианта значения.
  auth: z.custom<AuthConfig>(() => true),
  // Зарезервировано под оповещения: сейчас любое поле внутри — ошибка.
  notifications: z.strictObject({}).optional(),
  extras: extrasSchema.optional(),
  regional: regionalSchema.optional(),
  defaults: z.strictObject({ project: idSchema, environment: idSchema }),
  search: searchSchema,
  backends: z.record(idSchema, backendSchema),
  // Профиль проверяет checkProfile в перекрёстной проверке: там пути с именами вариантов и проверки ссылок.
  formats: z.record(idSchema, z.custom<Profile>(() => true)).default({}),
  projects: z.record(idSchema, projectSchema),
});

const RESERVED_FORMATS = new Set([BUILTIN_FORMAT]);

export type ThreadlineConfig = z.infer<typeof configSchema>;
export type BackendConfig = z.infer<typeof backendSchema>;
export type LokiGrafanaConfig = z.infer<typeof lokiGrafanaSchema>;
export type LokiConfig = z.infer<typeof lokiSchema>;
export type MockConfig = z.infer<typeof mockSchema>;
export type EnvironmentConfig = z.infer<typeof environmentSchema>;
export type ProjectConfig = z.infer<typeof projectSchema>;
export type MockFailMode = (typeof MOCK_FAIL_MODES)[number];
export type SearchConfig = z.infer<typeof searchSchema>;
export type DatasourceRef = LokiGrafanaConfig['datasource'];
export type FormScope = z.infer<typeof formScopeSchema>;

/**
 * Одно хранилище по тем же правилам, что запись backends файла настроек: локальный режим проверяет так хранилище из формы.
 * Пути ошибок от записи хранилища: url, datasource.name, tokenEnv.
 */
export function validateBackend(input: unknown): { ok: true; backend: BackendConfig } | { ok: false; issues: ConfigIssue[] } {
  const parsed = backendSchema.safeParse(input);
  if (parsed.success) return { ok: true, backend: parsed.data };
  return { ok: false, issues: dedupe(parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }))) };
}

/** Как источник указан в настройке, для сообщений: «имя Loki», «uid abc», «id 3». */
export function describeDatasource(ref: DatasourceRef): string {
  if ('id' in ref) return `id ${ref.id}`;
  if ('name' in ref) return `имя ${ref.name}`;
  return `uid ${ref.uid}`;
}

export interface ConfigIssue extends Partial<MessageRef> {
  path: string;
  message: string;
}

export type ValidationResult = { ok: true; config: ThreadlineConfig } | { ok: false; issues: ConfigIssue[] };

export const STAND_PLACEHOLDER = '{number}';
export const STAND_NUMBER = /^\d{1,6}$/;
const STAND_TEMPLATE_CHARS = /^[A-Za-z0-9._-]*$/;

export type Loose = Record<string, unknown>;
const isObj = (v: unknown): v is Loose => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Проверяет разобранный YAML. Ошибки схемы и перекрёстных ссылок возвращаются вместе. */
export function validateConfig(input: unknown): ValidationResult {
  const issues: ConfigIssue[] = [];
  const raw = stripInlineTokens(input, issues);

  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    for (const i of parsed.error.issues) {
      const path = i.path.map(String).join('.');
      // Раздел входа проверяет checkAuth: своё сообщение называет оба варианта значения.
      if (path === 'auth') continue;
      // Неизвестное поле раздела уведомлений называется полным путём: notifications.telegram.
      if (i.code === 'unrecognized_keys' && path === 'notifications') for (const key of i.keys) issues.push({ path: `${path}.${key}`, message: 'неизвестное поле: раздел зарезервирован и пока пуст' });
      else if (i.code === 'unrecognized_keys' && path === 'extras') for (const key of i.keys) issues.push({ path: `${path}.${key}`, message: 'неизвестное поле: допустимо только publicEggs' });
      else issues.push({ path, message: i.message });
    }
  }
  const formats = checkFormats(raw, issues);
  const auth = checkAuth(raw, issues);
  crossCheck(raw, issues);
  checkRegional(raw, issues);

  if (issues.length > 0 || !parsed.success || !auth) return { ok: false, issues: dedupe(issues) };
  const config = parsed.data;
  config.formats = formats;
  config.auth = auth;
  return { ok: true, config };
}

/** Секрет в файле: значение убирается до проверки схемы, сообщение называет поле для имени переменной. */
const INLINE_SECRETS: Readonly<Record<string, { what: string; env: string }>> = {
  token: { what: 'токен', env: 'tokenEnv' },
  username: { what: 'имя для входа', env: 'usernameEnv' },
  password: { what: 'пароль', env: 'passwordEnv' },
};

function stripInlineTokens(input: unknown, issues: ConfigIssue[]): unknown {
  if (!isObj(input) || !isObj(input.backends)) return input;
  const backends: Loose = {};
  for (const [id, b] of Object.entries(input.backends)) {
    if (!isObj(b)) {
      backends[id] = b;
      continue;
    }
    const rest: Loose = { ...b };
    for (const [field, { what, env }] of Object.entries(INLINE_SECRETS)) {
      if (!(field in rest)) continue;
      // Имя и пароль бывают только у хранилища loki: у остальных поле остаётся неизвестным, как раньше.
      if (field !== 'token' && b.type !== 'loki') continue;
      issues.push({
        path: `backends.${id}.${field}`,
        message: `${what} нельзя писать в файл настроек: задайте его переменной окружения и укажите её имя в поле ${env}`,
      });
      delete rest[field];
    }
    backends[id] = rest;
  }
  return { ...input, backends };
}

const SECRET_FIELDS: Readonly<Record<string, string>> = { clientSecret: 'THREADLINE_OIDC_CLIENT_SECRET', sessionSecret: 'THREADLINE_SESSION_SECRET' };

/** Раздел auth: значение off или настройки OIDC. Значения секретов в сообщения не попадают. Проверка без обращения к провайдеру. */
function checkAuth(raw: unknown, issues: ConfigIssue[]): AuthConfig | null {
  const value = isObj(raw) ? raw.auth : undefined;
  if (value === 'off') return 'off';
  if (value === undefined || value === null) {
    issues.push({ path: 'auth', message: 'раздел входа обязателен: задайте настройки OIDC (issuer, clientId, publicUrl, roleClaim, roles) или напишите auth: off' });
    return null;
  }
  if (typeof value === 'boolean') {
    issues.push({ path: 'auth', message: 'логическое значение не принимается: чтобы выключить вход, напишите auth: off' });
    return null;
  }
  if (!isObj(value)) {
    issues.push({ path: 'auth', message: 'нужны настройки OIDC или значение off' });
    return null;
  }
  const fields: Loose = {};
  let ok = true;
  for (const [k, v] of Object.entries(value)) {
    const env = Object.hasOwn(SECRET_FIELDS, k) ? SECRET_FIELDS[k] : undefined;
    if (env) {
      issues.push({ path: `auth.${k}`, message: `значение нельзя писать в файл настроек: оно задаётся только переменной окружения ${env}` });
      ok = false;
    } else fields[k] = v;
  }
  const parsed = authSchema.safeParse(fields);
  if (!parsed.success) {
    for (const i of parsed.error.issues) {
      const path = ['auth', ...i.path.map(String)].join('.');
      if (i.code === 'unrecognized_keys') for (const key of i.keys) issues.push({ path: `${path}.${key}`, message: 'неизвестное поле' });
      else issues.push({ path, message: i.message });
    }
    return null;
  }
  const owners = new Map<string, Role>();
  for (const role of ROLES) {
    for (const name of parsed.data.roles[role]) {
      const other = owners.get(name);
      if (other && other !== role) {
        issues.push({ path: 'auth.roles', message: `роль из токена «${name}» стоит у двух ролей: ${other} и ${role}` });
        ok = false;
      }
      owners.set(name, role);
    }
  }
  return ok ? parsed.data : null;
}

/** Секция formats целиком, даже профили, на которые не ссылается ни один проект. */
function checkFormats(raw: unknown, issues: ConfigIssue[]): Record<string, Profile> {
  const out: Record<string, Profile> = {};
  if (!isObj(raw) || !isObj(raw.formats)) return out;
  for (const [id, f] of Object.entries(raw.formats)) {
    if (RESERVED_FORMATS.has(id)) {
      issues.push({ path: `formats.${id}`, message: `имя «${id}» занято встроенным профилем ${BUILTIN_FORMAT}: дайте профилю другое имя` });
      continue;
    }
    const r = checkProfile(f);
    if (r.ok) out[id] = r.profile;
    else for (const i of r.issues) issues.push({ path: i.path ? `formats.${id}.${i.path}` : `formats.${id}`, message: i.message });
  }
  return out;
}

/** Раздел regional: группы номера складываются в его длину, номер не длиннее 15 цифр, образцы — RE2 без групп и с линейным временем. */
function checkRegional(raw: unknown, issues: ConfigIssue[]): void {
  const r = isObj(raw) && isObj(raw.regional) ? raw.regional : null;
  if (!r) return;
  const phone = isObj(r.phone) ? r.phone : null;
  if (phone && typeof phone.countryCode === 'string' && typeof phone.nationalDigits === 'number') {
    if (phone.countryCode.length + phone.nationalDigits > 15) issues.push({ path: 'regional.phone.nationalDigits', message: 'код страны и номер вместе — не больше 15 цифр' });
    const groups = phone.groups;
    if (Array.isArray(groups) && groups.every((g) => typeof g === 'number') && groups.reduce((a: number, g: number) => a + g, 0) !== phone.nationalDigits) {
      issues.push({ path: 'regional.phone.groups', message: 'сумма групп должна быть равна nationalDigits' });
    }
  }
  if (!isObj(r.patterns)) return;
  for (const k of PATTERN_KINDS) {
    const list = r.patterns[k];
    if (!Array.isArray(list)) continue;
    list.forEach((p, i) => {
      if (typeof p !== 'string' || p === '') return;
      const issue = patternIssue(p) ?? linearIssue(p);
      if (issue) issues.push({ path: `regional.patterns.${k}.${i}`, message: issue });
    });
  }
}

function crossCheck(raw: unknown, issues: ConfigIssue[]): void {
  if (!isObj(raw)) return;
  const backends = isObj(raw.backends) ? raw.backends : {};
  const projects = isObj(raw.projects) ? raw.projects : {};
  const formats = isObj(raw.formats) ? Object.keys(raw.formats).filter((f) => !RESERVED_FORMATS.has(f)) : [];

  if (isObj(raw.projects) && Object.keys(projects).length === 0) {
    issues.push({ path: 'projects', message: 'нужен хотя бы один проект' });
  }

  for (const [pid, p] of Object.entries(projects)) {
    if (RESERVED_PROJECT_IDS.has(pid)) issues.push({ path: `projects.${pid}`, message: `идентификатор проекта «${pid}» занят адресом страницы: выберите другой` });
    if (!isObj(p)) continue;
    if (typeof p.format === 'string' && !RESERVED_FORMATS.has(p.format) && !formats.includes(p.format)) {
      issues.push({
        path: `projects.${pid}.format`,
        message: `формата логов «${p.format}» нет: известные форматы — ${[BUILTIN_FORMAT, ...formats].join(', ')}`,
      });
    }
    const envs = isObj(p.environments) ? p.environments : null;
    if (!envs || Object.keys(envs).length === 0) {
      issues.push({ path: `projects.${pid}.environments`, message: `у проекта «${pid}» нет ни одной среды` });
      continue;
    }
    for (const [eid, e] of Object.entries(envs)) {
      const at = `projects.${pid}.environments.${eid}`;
      checkEnvironmentId(eid, at, issues);
      if (!isObj(e)) continue;
      if (typeof e.backend === 'string' && !(e.backend in backends)) {
        issues.push({ path: `${at}.backend`, message: `среда «${eid}» ссылается на хранилище «${e.backend}», которого нет в backends` });
      }
      checkEnvironmentBounds(e, at, eid, issues);
      checkSearchOnly(e, at, issues);
      checkRegexValues(e, at, issues);
      const examples = z.array(exampleSchema).safeParse(e.examples);
      if (examples.success) checkExamples(examples.data, at, issues);
    }
  }

  const d = isObj(raw.defaults) ? raw.defaults : null;
  if (d && typeof d.project === 'string') {
    const p = projects[d.project];
    if (!isObj(p)) {
      issues.push({ path: 'defaults.project', message: `проекта по умолчанию «${d.project}» нет в projects` });
    } else if (typeof d.environment === 'string') {
      const envs = isObj(p.environments) ? p.environments : {};
      if (!(d.environment in envs)) {
        issues.push({
          path: 'defaults.environment',
          message: `среды по умолчанию «${d.environment}» нет в проекте «${d.project}»`,
        });
      }
    }
  }
}

/** Адреса справочника /:project/catalog и настроек проекта /:project/settings. */
export function checkEnvironmentId(eid: string, at: string, issues: ConfigIssue[]): void {
  if (eid === 'catalog') issues.push({ path: at, message: 'идентификатор среды «catalog» занят справочником: выберите другой' });
  if (eid === 'settings') issues.push({ path: at, message: 'идентификатор среды «settings» занят настройками проекта: выберите другой' });
}

/**
 * Почему значение `=~` или `!~` не годится как выражение; null — годится.
 * Диалект тот же, что у профилей (`checkRe2`): его выполняют и RE2 хранилища, и имитация в JS.
 */
export function regexValueProblem(value: string): string | null {
  const c = checkRe2(value);
  return c.ok ? null : c.reason;
}

/** Выражения условий файла: неверное выражение ломало бы каждый запрос среды ошибкой хранилища. */
function checkRegexValues(e: Loose, at: string, issues: ConfigIssue[]): void {
  if (!Array.isArray(e.selector)) return;
  (e.selector as unknown[]).forEach((m, j) => {
    if (!isObj(m) || (m.op !== '=~' && m.op !== '!~') || typeof m.value !== 'string') return;
    const problem = regexValueProblem(m.value);
    if (problem) issues.push({ path: `${at}.selector.${j}.value`, message: `выражение «${m.value}» не подходит хранилищу: ${problem}` });
  });
}

export function checkEnvironmentBounds(e: Loose, at: string, eid: string, issues: ConfigIssue[]): void {
  const kind = e.kind ?? 'single';
  const selector = Array.isArray(e.selector) ? (e.selector as unknown[]) : null;
  const hasEquality = (selector ?? []).some(
    (m) => isObj(m) && typeof m.value === 'string' && ((m.op === '=' && m.value.trim() !== '') || (m.op === '=~' && VALUE_LIST.test(m.value))),
  );

  if (kind === 'pr-stands') {
    const stand = isObj(e.stand) ? e.stand : null;
    if (!stand) {
      issues.push({ path: `${at}.stand`, message: `у среды стендов «${eid}» нет поля stand с меткой и шаблоном`, key: 'stand.missing', params: { id: eid } });
      return;
    }
    if (typeof stand.template === 'string') {
      const parts = stand.template.split(STAND_PLACEHOLDER);
      if (parts.length !== 2) {
        issues.push({
          path: `${at}.stand.template`,
          message: `шаблон стенда должен содержать ровно одно место для номера ${STAND_PLACEHOLDER}, например pr-{number}`,
          key: 'stand.placeholder',
        });
      } else if (!parts.every((s) => STAND_TEMPLATE_CHARS.test(s))) {
        issues.push({
          path: `${at}.stand.template`,
          message: 'в шаблоне стенда допустимы латинские буквы, цифры, точка, дефис и подчёркивание',
          key: 'stand.templateChars',
        });
      }
    }
    return;
  }

  if ('stand' in e) {
    issues.push({ path: `${at}.stand`, message: 'поле stand бывает только у среды стендов (kind: pr-stands)', key: 'stand.onlyForStands' });
  }
  if (!selector || selector.length === 0) {
    issues.push({ path: `${at}.selector`, message: `у среды «${eid}» нет условий`, key: 'selector.missing', params: { id: eid } });
  } else if (!hasEquality) {
    issues.push({
      path: `${at}.selector`,
      message: `среде «${eid}» нужно хотя бы одно условие равенства (op: "=") с непустым значением, чтобы не читать логи за пределами проекта`,
      key: 'selector.noEquality',
      params: { id: eid },
    });
  }
}

/** Отметка searchOnly — только у условия «не равно»: границы проекта не расширяются. */
export function checkSearchOnly(e: Loose, at: string, issues: ConfigIssue[]): void {
  if (!Array.isArray(e.selector)) return;
  e.selector.forEach((m, i) => {
    if (isObj(m) && m.searchOnly === true && m.op !== '!=') {
      issues.push({
        path: `${at}.selector.${i}`,
        message: 'searchOnly бывает только у условия «не равно» (op: "!="): исключение для обычного поиска не расширяет границы проекта',
      });
    }
  });
}

function dedupe(issues: ConfigIssue[]): ConfigIssue[] {
  const seen = new Set<string>();
  return issues.filter((i) => {
    const k = `${i.path}|${i.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Селектор среды с подставленным стендом. Номер стенда проверяется до любых обращений к хранилищу. */
export function environmentSelector(
  env: EnvironmentConfig,
  stand?: string,
  opts: { operation?: boolean } = {},
): { ok: true; selector: { label: string; op: '=' | '!=' | '=~' | '!~'; value: string }[] } | { ok: false; reason: string } {
  // Поиск операции не применяет исключений только для обычного поиска (searchOnly).
  const own = env.selector
    .filter((m) => !(opts.operation && m.searchOnly === true && m.op === '!='))
    .map(({ label, op, value }) => ({ label, op, value }));
  if (env.kind !== 'pr-stands') return { ok: true, selector: own };
  if (stand === undefined || !STAND_NUMBER.test(stand)) {
    return { ok: false, reason: 'номер стенда: от одной до шести цифр' };
  }
  const s = env.stand!;
  return {
    ok: true,
    selector: [{ label: s.label, op: '=', value: s.template.replace(STAND_PLACEHOLDER, String(Number(stand))) }, ...own],
  };
}

/** Условия «не равно» селектора текстом: «container != pgadmin». Для строки «Не ищутся записи: …». */
export function selectorExclusions(selector: readonly { label: string; op: string; value: string }[]): string[] {
  return selector.filter((m) => m.op === '!=' || m.op === '!~').map((m) => `${m.label} ${m.op} ${m.value}`);
}

/** Регулярное выражение для значений метки стенда, номер в первой группе. */
export function standPattern(template: string): RegExp {
  const [before = '', after = ''] = template.split(STAND_PLACEHOLDER);
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
  return new RegExp(`^${esc(before)}(\\d{1,6})${esc(after)}$`);
}
