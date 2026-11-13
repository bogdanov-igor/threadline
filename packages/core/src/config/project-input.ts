// Проект с формы: те же правила, что у файла, и правила ввода сверху; граница хранилища; канонический вид.
// Загрузка из базы правил ввода не применяет.

import { VALUE_LIST } from './value-list.ts';
import { z } from 'zod';
import { LOGO_MAX_BYTES, PROJECT_LIMITS, RESERVED_PROJECT_IDS } from '../api.ts';
import { BUILTIN_FORMAT } from '../profile/builtin.ts';
import { isMissingField, REQUIRED_FIELD } from '../required-field.ts';
import { maskText } from '../search/masking.ts';
import { isValidTimeZone } from '../time.ts';
import { checkExamples, exampleSchema, normalizeExamples, normalizeLabel } from './examples.ts';
import {
  checkEnvironmentBounds,
  regexValueProblem,
  checkEnvironmentId,
  checkSearchOnly,
  idSchema,
  labelSchema,
  projectSchema,
  STAND_PLACEHOLDER,
  type ConfigIssue,
  type EnvironmentConfig,
  type FormScope,
  type ProjectConfig,
} from './index.ts';

export const NAME_MAX = 80;
export const VALUE_MAX = 256;
const LOGO_MAX_BASE64 = Math.ceil(LOGO_MAX_BYTES / 3) * 4;

const NO_KEEP: ReadonlySet<string> = new Set();
const CONTROL = /\p{Cc}/u;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

const matcherInputSchema = z.strictObject({
  label: z.string(),
  // =~ задаёт границу проекта, только если это перечень разрешённых значений: a|b. !~ исключение, как !=: границы не даёт.
  op: z.enum(['=', '!=', '=~', '!~']),
  value: z.string(),
  searchOnly: z.boolean().optional(),
});

/** Строгая схема: url, token, tokenEnv и datasource у среды отклоняются как неизвестные поля. */
export const environmentInputSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['single', 'pr-stands']).default('single'),
  backend: z.string(),
  selector: z.array(matcherInputSchema).default([]),
  stand: z.strictObject({ label: z.string(), template: z.string() }).optional(),
  examples: z.array(exampleSchema).optional(),
});

/** Строгая схема: formats, count, layers и текст профиля отклоняются как неизвестные поля. */
const projectInputSchema = z.strictObject({
  id: z.string().optional(),
  name: z.string(),
  timezone: z.string(),
  retentionDays: z.number(),
  format: z.string(),
  environments: z.array(environmentInputSchema),
  // Форму поля проверяет checkLogoInput: у версий свои пути и своё сообщение про адрес вместо содержимого.
  logo: z.unknown().optional(),
  updatedAt: z.string().optional(),
});

export type EnvironmentDraft = z.output<typeof environmentInputSchema>;

/** Новая версия логотипа: base64 или «оставить как есть». */
export type LogoPart = string;
export const LOGO_KEEP = 'keep';
export type LogoInput = typeof LOGO_KEEP | null | { light: LogoPart; dark?: LogoPart | null | undefined };

export interface ProjectDraft {
  id?: string | undefined;
  name: string;
  timezone: string;
  retentionDays: number;
  format: string;
  environments: EnvironmentDraft[];
  logo: LogoInput | undefined;
  updatedAt?: string | undefined;
}

export interface StoreRef {
  type: string;
  formScope?: FormScope | undefined;
}

export interface ProjectInputContext {
  backends: Readonly<Record<string, StoreRef>>;
  /** Имена профилей секции formats; встроенный json есть всегда. */
  formats: readonly string[];
  /** Версия проекта в файле: условия, совпавшие с ней, доверенные. */
  fileEnvironments?: Readonly<Record<string, EnvironmentConfig>> | undefined;
  /** Сохранённые среды проекта: их идентификаторы не проверяются как новые. */
  savedEnvironmentIds?: ReadonlySet<string> | undefined;
}

export type ProjectInputResult = { ok: true; project: ProjectDraft } | { ok: false; issues: ConfigIssue[] };

/** Ошибки схемы с путями от корня запроса. Лишнее поле называется по имени. */
export function zodIssues(error: z.ZodError, prefix = ''): ConfigIssue[] {
  const out: ConfigIssue[] = [];
  for (const i of error.issues) {
    const path = [prefix, ...i.path.map(String)].filter(Boolean).join('.');
    if (i.code === 'unrecognized_keys') {
      for (const key of i.keys) out.push({ path: path ? `${path}.${key}` : key, message: `неизвестное поле «${key}»`, key: 'field.unknown', params: { field: key } });
    } else if (isMissingField(i)) out.push({ path, ...REQUIRED_FIELD });
    else out.push({ path, message: i.message });
  }
  return out;
}

/** Сообщение проверки без пути: русский текст и ключ рядом. */
type Problem = Omit<ConfigIssue, 'path'>;

/** Название проекта или среды: не пусто, до 80 символов, без управляющих символов и значений, которые скрыла бы маска. */
function nameIssue(name: string): Problem | null {
  const v = name.trim();
  if (v === '') return { message: 'название не может быть пустым', key: 'name.empty' };
  if (v.length > NAME_MAX) return { message: `название длиннее ${NAME_MAX} символов`, key: 'name.tooLong', params: { max: NAME_MAX } };
  if (CONTROL.test(v) || LONE_SURROGATE.test(v)) return { message: 'в названии есть управляющие символы', key: 'name.control' };
  if (maskText(v, NO_KEEP) !== v) return { message: 'название похоже на скрываемые данные, например номер карты: такое значение не сохраняется', key: 'name.masked' };
  return null;
}

function idIssue(id: string, what: 'проекта' | 'среды'): Problem | null {
  const parsed = idSchema.safeParse(id);
  if (!parsed.success) return { message: parsed.error.issues[0]?.message ?? 'неверный идентификатор', key: 'id.format' };
  if (/^\d+$/.test(id)) {
    return { message: `идентификатор ${what} не может состоять только из цифр: порядок такой записи не сохранился бы`, key: what === 'проекта' ? 'id.digitsProject' : 'id.digitsEnvironment' };
  }
  return null;
}

function labelIssue(label: string): Problem | null {
  const parsed = labelSchema.safeParse(label);
  if (!parsed.success) return { message: parsed.error.issues[0]?.message ?? 'неверное имя метки', key: 'label.format' };
  if (label.startsWith('__')) return { message: 'метки с двумя подчёркиваниями в начале служебные: форма их не принимает', key: 'label.reserved' };
  return null;
}

function valueIssue(value: string, op: string): Problem | null {
  if (value.length > VALUE_MAX) return { message: `значение длиннее ${VALUE_MAX} символов`, key: 'value.tooLong', params: { max: VALUE_MAX } };
  if (CONTROL.test(value) || LONE_SURROGATE.test(value)) return { message: 'в значении есть управляющие символы', key: 'value.control' };
  if (op !== '!=' && value !== value.trim()) return { message: 'пробел на краю значения: такое значение почти всегда опечатка и даёт пустой результат', key: 'value.edgeSpace' };
  if (op === '=~' || op === '!~') {
    const problem = regexValueProblem(value);
    if (problem) return { message: `выражение не подходит хранилищу: ${problem}`, key: 'value.regex' };
  }
  return null;
}

function checkLogoInput(logo: unknown, issues: ConfigIssue[]): void {
  if (logo === undefined || logo === null || logo === LOGO_KEEP) return;
  const part = (v: unknown, path: string) => {
    if (v === LOGO_KEEP) return;
    if (typeof v !== 'string' || !BASE64.test(v)) {
      issues.push({ path, message: 'логотип принимается только содержимым файла в base64, адрес не принимается', key: 'logo.notBase64' });
    } else if (v.length > LOGO_MAX_BASE64) {
      issues.push({ path, message: `файл больше предела ${LOGO_MAX_BYTES / 1024} КБ`, key: 'logo.tooBig', params: { max: LOGO_MAX_BYTES / 1024 } });
    }
  };
  if (typeof logo !== 'object' || Array.isArray(logo)) {
    issues.push({ path: 'logo', message: 'логотип принимается только содержимым файла в base64, адрес не принимается', key: 'logo.notBase64' });
    return;
  }
  const { light, dark, ...rest } = logo as Record<string, unknown>;
  for (const key of Object.keys(rest)) issues.push({ path: `logo.${key}`, message: `неизвестное поле «${key}»`, key: 'field.unknown', params: { field: key } });
  if (light === undefined || light === null) issues.push({ path: 'logo.light', message: 'светлая версия логотипа обязательна', key: 'logo.lightRequired' });
  else part(light, 'logo.light');
  if (dark !== undefined && dark !== null) part(dark, 'logo.dark');
}

/** Проверка только формы среды и правил файла: общая для сохранения и проверки подключения. */
function checkEnvironment(e: EnvironmentDraft, at: string, ctx: ProjectInputContext, issues: ConfigIssue[]): void {
  const saved = ctx.savedEnvironmentIds?.has(e.id) === true || (ctx.fileEnvironments !== undefined && e.id in ctx.fileEnvironments);
  const idProblem: Problem | null = saved ? (idSchema.safeParse(e.id).success ? null : { message: 'неверный идентификатор', key: 'id.format' }) : idIssue(e.id, 'среды');
  if (idProblem) issues.push({ path: `${at}.id`, ...idProblem });
  checkEnvironmentId(e.id, `${at}.id`, issues);

  const nameProblem = nameIssue(e.name);
  if (nameProblem) issues.push({ path: `${at}.name`, ...nameProblem });

  const store = ctx.backends[e.backend];
  if (!Object.hasOwn(ctx.backends, e.backend) || !store) {
    const known = Object.keys(ctx.backends).join(', ');
    issues.push({ path: `${at}.backend`, message: `хранилища «${e.backend}» нет в файле настроек, известные: ${known || 'нет'}`, key: 'store.unknown', params: { store: e.backend, known: known || '—' } });
  }

  // Примеры не задают, что читает среда: их правила действуют и у среды, совпавшей с файлом.
  checkExamples(e.examples, at, issues);

  const before = issues.length;
  checkEnvironmentBounds(e, at, e.id, issues);
  checkSearchOnly(e, at, issues);
  const fileEnv = ctx.fileEnvironments && Object.hasOwn(ctx.fileEnvironments, e.id) ? ctx.fileEnvironments[e.id] : undefined;
  // Условия, совпавшие с файлом, правил ввода не проходят: значение из файла с пробелом на краю закрыло бы всю форму.
  if (fileEnv && sameScope(e, fileEnv)) return;

  if (e.selector.length > PROJECT_LIMITS.conditions) {
    issues.push({ path: `${at}.selector`, message: `в среде не больше ${PROJECT_LIMITS.conditions} условий`, key: 'selector.tooMany', params: { max: PROJECT_LIMITS.conditions } });
  }
  const equal = new Map<string, string>();
  e.selector.forEach((m, j) => {
    const label = labelIssue(m.label);
    if (label) issues.push({ path: `${at}.selector.${j}.label`, ...label });
    const value = valueIssue(m.value, m.op);
    if (value) issues.push({ path: `${at}.selector.${j}.value`, ...value });
    if (m.op !== '=') return;
    const other = equal.get(m.label);
    if (other !== undefined && other !== m.value) {
      issues.push({ path: `${at}.selector.${j}`, message: `два разных равенства на метку ${m.label}: такая среда всегда пуста`, key: 'selector.twoEqualities', params: { label: m.label } });
    }
    equal.set(m.label, m.value);
  });
  if (e.stand) {
    const label = labelIssue(e.stand.label);
    if (label) issues.push({ path: `${at}.stand.label`, ...label });
    if (e.stand.template.split(STAND_PLACEHOLDER).join('') === '') {
      issues.push({ path: `${at}.stand.template`, message: 'у шаблона стенда нет постоянной части: он читал бы любое числовое значение метки', key: 'stand.noConstant' });
    }
  }
  // Граница проверяется только у верной формы: иначе ошибка селектора и границы стояли бы вместе.
  if (issues.length === before && store && store.type !== 'mock') {
    const scope = scopeIssue(e, at, e.backend, store.formScope);
    if (scope) issues.push(scope);
  }
}

/** Проверка запроса создания или правки. Пути вида environments.1.selector.0.value. */
export function validateProjectInput(input: unknown, ctx: ProjectInputContext): ProjectInputResult {
  const parsed = projectInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, issues: zodIssues(parsed.error) };
  const p = parsed.data;
  const issues: ConfigIssue[] = [];

  if (p.id !== undefined) {
    const problem = idIssue(p.id, 'проекта');
    if (problem) issues.push({ path: 'id', ...problem });
    else if (RESERVED_PROJECT_IDS.has(p.id)) issues.push({ path: 'id', message: `идентификатор «${p.id}» занят адресом страницы: выберите другой`, key: 'id.reservedProject', params: { id: p.id } });
  }
  const nameProblem = nameIssue(p.name);
  if (nameProblem) issues.push({ path: 'name', ...nameProblem });
  if (!isValidTimeZone(p.timezone)) issues.push({ path: 'timezone', message: 'неизвестный часовой пояс, нужно имя из базы часовых поясов, например Europe/Berlin', key: 'project.timezone' });
  if (!Number.isInteger(p.retentionDays) || p.retentionDays < 1 || p.retentionDays > 400) {
    issues.push({ path: 'retentionDays', message: 'срок хранения: целое число дней от 1 до 400', key: 'project.retention' });
  }
  const format = p.format;
  if (format !== BUILTIN_FORMAT && !ctx.formats.includes(format)) {
    const known = [BUILTIN_FORMAT, ...ctx.formats].join(', ');
    issues.push({ path: 'format', message: `формата логов «${p.format}» нет: известные форматы — ${known}`, key: 'project.format', params: { format: p.format, known } });
  }
  checkLogoInput(p.logo, issues);

  const fileCount = ctx.fileEnvironments ? Object.keys(ctx.fileEnvironments).length : 0;
  if (p.environments.length === 0) issues.push({ path: 'environments', message: 'нужна хотя бы одна среда', key: 'project.noEnvironments' });
  else if (p.environments.length > Math.max(PROJECT_LIMITS.environments, fileCount)) {
    issues.push({ path: 'environments', message: `в проекте не больше ${PROJECT_LIMITS.environments} сред`, key: 'project.tooManyEnvironments', params: { max: PROJECT_LIMITS.environments } });
  }

  const seen = new Map<string, number[]>();
  p.environments.forEach((e, i) => seen.set(e.id, [...(seen.get(e.id) ?? []), i]));
  for (const [id, rows] of seen) {
    if (rows.length > 1) for (const i of rows) issues.push({ path: `environments.${i}.id`, message: `идентификатор среды «${id}» повторяется`, key: 'id.duplicateEnvironment', params: { id } });
  }
  p.environments.forEach((e, i) => checkEnvironment(e, `environments.${i}`, ctx, issues));

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    project: {
      ...(p.id !== undefined ? { id: p.id } : {}),
      name: p.name.trim(),
      timezone: p.timezone,
      retentionDays: p.retentionDays,
      format,
      environments: p.environments.map(({ examples, ...e }) => {
        const list = normalizeExamples(examples);
        return { ...e, name: e.name.trim(), ...(list ? { examples: list } : {}) };
      }),
      logo: p.logo as LogoInput | undefined,
      ...(p.updatedAt !== undefined ? { updatedAt: p.updatedAt } : {}),
    },
  };
}

/** Условия одной среды для проверки подключения: форма, правила и граница, без обращения к хранилищу. */
export function validateEnvironmentInput(input: unknown, ctx: ProjectInputContext): { ok: true; environment: EnvironmentDraft } | { ok: false; issues: ConfigIssue[] } {
  const parsed = environmentInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, issues: zodIssues(parsed.error, 'environment') };
  const issues: ConfigIssue[] = [];
  checkEnvironment(parsed.data, 'environment', ctx, issues);
  return issues.length > 0 ? { ok: false, issues } : { ok: true, environment: parsed.data };
}

// ---------- Граница хранилища ----------

export interface ScopeEnvironment {
  kind: string;
  backend: string;
  selector: readonly { label: string; op: string; value: string; searchOnly?: boolean | undefined }[];
  stand?: { label: string; template: string } | undefined;
}

const scopeMatches = (value: string, entry: string) => (entry.endsWith('*') ? value.startsWith(entry.slice(0, -1)) : value === entry);

/** Среда читает только разрешённое: «!=» и «!~» границу не дают, лишние условия только сужают. =~ даёт границу, только если это перечень разрешённых значений. */
export function environmentWithinScope(env: ScopeEnvironment, scope: FormScope | undefined): boolean {
  if (!scope) return false;
  const allowed = (value: string) => scope.values.some((v) => scopeMatches(value, v));
  const own = env.selector.some(
    (m) => m.label === scope.label && ((m.op === '=' && m.value !== '' && allowed(m.value)) || (m.op === '=~' && VALUE_LIST.test(m.value) && m.value.split('|').every(allowed))),
  );
  if (own) return true;
  if (env.kind !== 'pr-stands' || env.stand?.label !== scope.label) return false;
  const head = env.stand.template.split(STAND_PLACEHOLDER)[0] ?? '';
  // Точное значение не покрывает шаблон: номер стенда меняет значение метки.
  return scope.values.some((v) => v.endsWith('*') && head.startsWith(v.slice(0, -1)));
}

/** Ошибка границы для формы: где стоит и что разрешено. */
export function scopeIssue(env: ScopeEnvironment, at: string, backendId: string, scope: FormScope | undefined): ConfigIssue | null {
  if (!scope) {
    return {
      path: `${at}.selector`,
      message: `форма не сохраняет условия для хранилища «${backendId}», пока в файле настроек не задана граница: администратор добавляет backends.${backendId}.formScope, например formScope: { label: namespace, values: [acme, 'acme-*'] }`,
      key: 'scope.none',
      params: { store: backendId },
    };
  }
  if (environmentWithinScope(env, scope)) return null;
  const where = `backends.${backendId}.formScope`;
  const values = scope.values.join(', ');
  const allowed = `разрешены ${values} (${where})`;
  const j = env.selector.findIndex((m) => m.op === '=' && m.label === scope.label);
  if (j >= 0) return { path: `${at}.selector.${j}.value`, message: `значение вне границы хранилища: ${allowed}`, key: 'scope.value', params: { values, where } };
  if (env.kind === 'pr-stands' && env.stand?.label === scope.label) {
    return { path: `${at}.stand.template`, message: `шаблон стенда вне границы хранилища: ${allowed}`, key: 'scope.template', params: { values, where } };
  }
  return { path: `${at}.selector`, message: `нужно условие равенства на метку ${scope.label}: ${allowed}`, key: 'scope.equality', params: { label: scope.label, values, where } };
}

const scopeKey = (e: ScopeEnvironment): string =>
  stableJson({
    kind: e.kind,
    backend: e.backend,
    selector: e.selector.map((m) => ({ label: m.label, op: m.op, value: m.value, ...(m.searchOnly === true ? { searchOnly: true } : {}) })),
    ...(e.stand ? { stand: { label: e.stand.label, template: e.stand.template } } : {}),
  });

/** Условия совпали с версией из файла побайтно: такая среда доверенная, граница к ней не применяется. */
export function sameScope(a: ScopeEnvironment, b: ScopeEnvironment): boolean {
  return scopeKey(a) === scopeKey(b);
}

/** Смена условий, которая меняет то, что читается. Название и порядок сюда не входят. */
export const scopeChanged = (a: ScopeEnvironment, b: ScopeEnvironment): boolean => !sameScope(a, b);

// ---------- Канонический вид и запись из базы ----------

/** Среда в базе лежит массивом: в jsonb объект потерял бы порядок ключей. */
export interface EnvironmentRecord extends EnvironmentConfig {
  id: string;
}

export const environmentList = (record: Readonly<Record<string, EnvironmentConfig>>): EnvironmentRecord[] => Object.entries(record).map(([id, e]) => ({ ...e, id }));

export function environmentRecord(list: readonly (EnvironmentConfig & { id: string })[]): Record<string, EnvironmentConfig> {
  return Object.fromEntries(list.map(({ id, ...e }) => [id, e]));
}

function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const entries = Object.entries(v).filter(([, x]) => x !== undefined);
    return `{${entries
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, x]) => `${JSON.stringify(k)}:${stableJson(x)}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

export interface CanonicalProjectInput {
  name: string;
  timezone: string;
  retentionDays: number;
  format: string;
  environments: readonly (EnvironmentConfig & { id: string })[];
}

/** Канон проекта: ключи объектов отсортированы, среды в своём порядке, вместо логотипа хеши версий. */
export function canonicalProject(p: CanonicalProjectInput, logo: { light: string; dark: string | null } | null): string {
  return stableJson({
    name: p.name,
    timezone: p.timezone,
    retentionDays: p.retentionDays,
    format: p.format,
    environments: p.environments.map((e) => ({
      id: e.id,
      name: e.name,
      kind: e.kind ?? 'single',
      backend: e.backend,
      selector: (e.selector ?? []).map((m) => ({ label: m.label, op: m.op, value: m.value, ...(m.searchOnly === true ? { searchOnly: true } : {}) })),
      ...(e.stand ? { stand: { label: e.stand.label, template: e.stand.template } } : {}),
      // Пустой список и отсутствие поля одно и то же: канон проектов без примеров не меняется.
      ...(e.examples && e.examples.length > 0 ? { examples: e.examples.map((x) => ({ label: normalizeLabel(x.label), values: x.values, ...(x.period ? { period: x.period } : {}) })) } : {}),
    })),
    logo,
  });
}

/** Поля верхнего уровня, которыми отличаются два канона: журнал называет их без значений. */
export function changedFields(a: string, b: string): string[] {
  const x = JSON.parse(a) as Record<string, unknown>;
  const y = JSON.parse(b) as Record<string, unknown>;
  return [...new Set([...Object.keys(x), ...Object.keys(y)])].filter((k) => stableJson(x[k]) !== stableJson(y[k]));
}

export type StoredProjectResult = { ok: true; project: ProjectConfig } | { ok: false; issues: ConfigIssue[] };

/**
 * Проверка записи при загрузке из базы: правила файла, без правил ввода. Хранилище здесь не проверяется:
 * среда на убранном хранилище остаётся в снимке и отвечает «не настроено».
 */
export function validateStoredProject(id: string, stored: CanonicalProjectInput, formats: readonly string[]): StoredProjectResult {
  const at = `projects.${id}`;
  const issues: ConfigIssue[] = [];
  if (RESERVED_PROJECT_IDS.has(id)) issues.push({ path: at, message: `идентификатор проекта «${id}» занят адресом страницы`, key: 'id.reservedProject', params: { id } });
  const format = stored.format;
  if (format !== BUILTIN_FORMAT && !formats.includes(format)) {
    const known = [BUILTIN_FORMAT, ...formats].join(', ');
    issues.push({ path: `${at}.format`, message: `формата логов «${stored.format}» нет: известные форматы — ${known}`, key: 'project.format', params: { format: stored.format, known } });
  }
  const list = Array.isArray(stored.environments) ? stored.environments : [];
  if (list.length === 0) issues.push({ path: `${at}.environments`, message: `у проекта «${id}» нет ни одной среды`, key: 'project.noEnvironmentsStored', params: { id } });
  const parsed = projectSchema.safeParse({
    name: stored.name,
    format,
    retentionDays: stored.retentionDays,
    timezone: stored.timezone,
    environments: environmentRecord(list),
  });
  if (!parsed.success) for (const i of parsed.error.issues) issues.push({ path: [at, ...i.path.map(String)].join('.'), message: i.message });
  for (const { id: eid, ...e } of list) {
    const envAt = `${at}.environments.${eid}`;
    checkEnvironmentId(eid, envAt, issues);
    checkEnvironmentBounds(e, envAt, eid, issues);
    checkSearchOnly(e, envAt, issues);
  }
  if (issues.length > 0 || !parsed.success) return { ok: false, issues };
  return { ok: true, project: parsed.data };
}
