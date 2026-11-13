// Загрузка файла настроек: разбор YAML, проверка схемы, секреты из переменных окружения.

import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import {
  validateConfig,
  type BackendConfig,
  type ConfigIssue,
  type ThreadlineConfig,
  type LokiConfig,
  type LokiGrafanaConfig,
  type MockConfig,
} from '@threadline/core/config';
import { setRegional } from '@threadline/core/search';
import { LOG_LEVELS } from '../logging.ts';
import { DEFAULT_CONFIG, ROOT } from '../paths.ts';
import { SHUTDOWN_TIMEOUT_ENV } from '../shutdown.ts';
import { applyEnvOverlay, CA_FILE_ENV } from './env-overlay.ts';
import { loadProjectLogos, type ProjectLogo } from './logo.ts';

/** Loki через Grafana: токен сервисного аккаунта из tokenEnv. */
export type ResolvedLoki = LokiGrafanaConfig & { token: string | undefined; ca: string | undefined };
/** Loki напрямую: значения переменных tokenEnv или usernameEnv и passwordEnv; переменной нет в настройке — нет и поля. */
export type ResolvedLokiDirect = LokiConfig & { token?: string | undefined; username?: string | undefined; password?: string | undefined; ca: string | undefined };
export type ResolvedBackend = ResolvedLoki | ResolvedLokiDirect | MockConfig;

export interface ResolvedConfig {
  path: string;
  config: ThreadlineConfig;
  backends: Record<string, ResolvedBackend>;
  /** Проверенные логотипы по идентификатору проекта. Нет поля — логотипов нет. */
  logos?: Map<string, ProjectLogo>;
  /** Что не мешает запуску, но о чём нужно сказать администратору. */
  warnings?: ConfigIssue[];
  /** Корневой сертификат для провайдера входа OIDC из auth.caFile или THREADLINE_CA_FILE. */
  authCa?: string;
  /** Какие настройки среды взяты из окружения: только имена переменных. */
  fromEnv?: string[];
}

/** Секреты входа: только из окружения. Читает запуск сервера, командам они не нужны. */
export interface AuthSecrets {
  clientSecret: string;
  sessionSecret: string;
}

export const OIDC_CLIENT_SECRET_ENV = 'THREADLINE_OIDC_CLIENT_SECRET';
export const SESSION_SECRET_ENV = 'THREADLINE_SESSION_SECRET';
export const SESSION_SECRET_MIN = 32;
export const DATABASE_URL_ENV = 'THREADLINE_DATABASE_URL';
/** Строгий запуск: задан в образе. Обязательны адрес базы и токены хранилищ, развёрнутый экземпляр не запустится без них. */
export const STRICT_START_ENV = 'THREADLINE_STRICT_START';
/** Запуск без входа только по явному разрешению: иначе забытые переменные дали бы всем права администратора. */
export const ALLOW_NO_LOGIN_ENV = 'THREADLINE_ALLOW_NO_LOGIN';

export class ConfigError extends Error {
  readonly issues: ConfigIssue[];
  readonly file: string;

  constructor(file: string, issues: ConfigIssue[]) {
    super(`ошибки настройки, файл ${file}`);
    this.name = 'ConfigError';
    this.file = file;
    this.issues = issues;
  }

  format(): string {
    const lines = this.issues.map((i) => `  • ${i.path ? `${i.path}: ` : ''}${i.message}`);
    return [`Threadline не запущен: ${this.message}`, ...lines].join('\n');
  }

  /** Одно сообщение для журнала JSON: все ошибки сразу, в одной строке. */
  oneLine(): string {
    return `Threadline не запущен: ${this.message}: ${this.issues.map((i) => `${i.path ? `${i.path}: ` : ''}${i.message}`).join('; ')}`;
  }
}

export interface LoadOptions {
  path?: string;
  env?: Record<string, string | undefined>;
  /** Запуск сервера: к ошибкам файла добавляется проверка окружения, все вместе одним сообщением. Командам она не нужна. */
  start?: boolean;
}

export async function loadConfig(opts: LoadOptions = {}): Promise<ResolvedConfig> {
  const env = opts.env ?? process.env;
  const given = opts.path ?? (env.THREADLINE_CONFIG?.trim() || undefined);
  const file = given ? (isAbsolute(given) ? given : resolve(ROOT, given)) : DEFAULT_CONFIG;

  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    const message =
      code === 'ENOENT' ? `файл настроек не найден по пути ${file}` : `файл настроек не читается (${code ?? 'ошибка'}): ${file}`;
    throw new ConfigError(file, [{ path: '', message }]);
  }

  const doc = parseDocument(text, { uniqueKeys: true, prettyErrors: true });
  if (doc.errors.length > 0) {
    throw new ConfigError(
      file,
      doc.errors.map((err) => {
        const pos = err.linePos?.[0];
        const where = pos ? `строка ${pos.line}, колонка ${pos.col}` : '';
        if (err.code === 'DUPLICATE_KEY') {
          const key = /^[^\s:]+/.exec(text.slice(err.pos[0]))?.[0] ?? '';
          return { path: where, message: `повторяется ключ «${key}»: идентификаторы проектов, сред и хранилищ должны быть уникальны` };
        }
        return { path: where, message: `файл не разбирается как YAML: ${err.message.split('\n')[0]}` };
      }),
    );
  }

  const overlay = applyEnvOverlay(doc.toJS(), env);
  const result = validateConfig(overlay.raw);
  if (!result.ok) {
    const named = result.issues.map((i) => ({ ...i, path: overlay.fields.get(i.path) ?? i.path }));
    throw new ConfigError(file, [...overlay.issues, ...named, ...(opts.start ? startIssues(null, env) : [])]);
  }

  const issues: ConfigIssue[] = [...overlay.issues];
  const envCa = await readEnvCa(env, issues);
  let envCaUsed = false;
  const backends: Record<string, ResolvedBackend> = {};
  for (const [id, b] of Object.entries(result.config.backends) as [string, BackendConfig][]) {
    if (b.type === 'mock') {
      backends[id] = b;
      continue;
    }
    const read = (name: string | undefined) => (name ? env[name]?.trim() || undefined : undefined);
    let ca: string | undefined;
    if (b.caFile) {
      const caPath = isAbsolute(b.caFile) ? b.caFile : resolve(dirname(file), b.caFile);
      try {
        ca = await readFile(caPath, 'utf8');
      } catch {
        issues.push({ path: `backends.${id}.caFile`, message: `файл сертификата не найден или не читается: ${caPath}` });
      }
    } else if (envCa) {
      ca = envCa;
      envCaUsed = true;
    }
    backends[id] =
      b.type === 'loki'
        ? { ...b, ca, ...(b.tokenEnv ? { token: read(b.tokenEnv) } : {}), ...(b.usernameEnv ? { username: read(b.usernameEnv), password: read(b.passwordEnv) } : {}) }
        : { ...b, token: read(b.tokenEnv), ca };
  }
  let authCa: string | undefined;
  const auth = result.config.auth;
  if (auth !== 'off' && auth.caFile) {
    const caPath = isAbsolute(auth.caFile) ? auth.caFile : resolve(dirname(file), auth.caFile);
    try {
      authCa = await readFile(caPath, 'utf8');
    } catch {
      issues.push({ path: 'auth.caFile', message: `файл сертификата не найден или не читается: ${caPath}` });
    }
  } else if (auth !== 'off' && envCa) {
    authCa = envCa;
    envCaUsed = true;
  }
  if (opts.start) issues.push(...startIssues(result.config, env));
  if (issues.length > 0) throw new ConfigError(file, issues);

  const fromEnv = [...overlay.applied];
  const envWarnings = [...overlay.warnings];
  if (envCaUsed) fromEnv.push(CA_FILE_ENV);
  else if (envCa) envWarnings.push({ path: CA_FILE_ENV, message: 'переменная не применена: у хранилищ loki-grafana и loki и у входа свой caFile, либо их нет' });

  const { logos, warnings } = await loadProjectLogos(dirname(file), result.config);
  // Команды маскируют без сервера: правила ставятся сразу при чтении настроек.
  setRegional(result.config.regional);
  return { path: file, config: result.config, backends, logos, warnings: [...envWarnings, ...warnings], fromEnv, ...(authCa ? { authCa } : {}) };
}

/** Сертификат из THREADLINE_CA_FILE. Относительный путь считается от корня проекта, как THREADLINE_CONFIG. */
async function readEnvCa(env: Record<string, string | undefined>, issues: ConfigIssue[]): Promise<string | undefined> {
  const given = env[CA_FILE_ENV]?.trim();
  if (!given) return undefined;
  const caPath = isAbsolute(given) ? given : resolve(ROOT, given);
  try {
    const text = await readFile(caPath, 'utf8');
    if (text.trim()) return text;
    issues.push({ path: CA_FILE_ENV, message: `файл сертификата пуст: ${caPath}` });
  } catch {
    issues.push({ path: CA_FILE_ENV, message: `файл сертификата не найден или не читается: ${caPath}` });
  }
  return undefined;
}

function authSecretIssues(env: Record<string, string | undefined>): ConfigIssue[] {
  const clientSecret = env[OIDC_CLIENT_SECRET_ENV]?.trim() ?? '';
  const sessionSecret = env[SESSION_SECRET_ENV]?.trim() ?? '';
  const issues: ConfigIssue[] = [];
  if (!clientSecret) issues.push({ path: OIDC_CLIENT_SECRET_ENV, message: 'при включённом входе переменная обязательна: задайте секрет клиента OIDC' });
  if (!sessionSecret) issues.push({ path: SESSION_SECRET_ENV, message: 'при включённом входе переменная обязательна: задайте ключ подписи сессии' });
  else if (sessionSecret.length < SESSION_SECRET_MIN) issues.push({ path: SESSION_SECRET_ENV, message: `ключ сессии короче ${SESSION_SECRET_MIN} символов` });
  return issues;
}

/** Что ещё нужно для запуска сервера: зависит от настройки и строгого запуска. config null: файл с ошибками, остаётся то, что от него не зависит. Значений в сообщениях нет. */
export function startIssues(config: ThreadlineConfig | null, env: Record<string, string | undefined>): ConfigIssue[] {
  const issues: ConfigIssue[] = !config || config.auth === 'off' ? [] : authSecretIssues(env);
  if (config?.auth === 'off' && env[ALLOW_NO_LOGIN_ENV]?.trim() !== '1') {
    issues.push({
      path: 'auth',
      message: `вход не настроен, у каждого запроса были бы права администратора: задайте THREADLINE_PUBLIC_URL, THREADLINE_OIDC_ISSUER, THREADLINE_OIDC_CLIENT_ID, THREADLINE_OIDC_CLIENT_SECRET и THREADLINE_SESSION_SECRET. Только для локальной работы без входа: ${ALLOW_NO_LOGIN_ENV}=1`,
    });
  }
  if (env[STRICT_START_ENV]?.trim() === '1') {
    for (const [id, b] of Object.entries(config?.backends ?? {}) as [string, BackendConfig][]) {
      for (const [name, what] of secretEnvs(b)) if (!env[name]?.trim()) issues.push({ path: name, message: `переменная не задана: ${what} хранилища «${id}»` });
    }
    const db = env[DATABASE_URL_ENV]?.trim();
    if (!db) issues.push({ path: DATABASE_URL_ENV, message: 'переменная не задана: адрес PostgreSQL вида postgres://пользователь:пароль@хост:5432/база' });
    else if (!/^postgres(?:ql)?:\/\//.test(db) || !URL.canParse(db)) issues.push({ path: DATABASE_URL_ENV, message: 'адрес не разобран: нужен вид postgres://пользователь:пароль@хост:5432/база, символы пароля / ? # @ : % кодируются' });
  }
  const port = env.PORT?.trim();
  if (port && !(/^\d+$/.test(port) && Number(port) <= 65535)) issues.push({ path: 'PORT', message: 'нужно целое число от 0 до 65535' });
  const level = env.LOG_LEVEL?.trim();
  if (level && !LOG_LEVELS.includes(level)) issues.push({ path: 'LOG_LEVEL', message: `допустимо: ${LOG_LEVELS.join(', ')}` });
  const timeout = env[SHUTDOWN_TIMEOUT_ENV]?.trim();
  if (timeout && !(/^\d+$/.test(timeout) && Number(timeout) > 0)) issues.push({ path: SHUTDOWN_TIMEOUT_ENV, message: 'нужно целое число секунд больше нуля' });
  return issues;
}

/**
 * Секреты входа из окружения. При auth: off не нужны. В отличие от токена хранилища, без них сервер не запускается:
 * открытый запуск был бы хуже простоя. Значений в сообщениях нет.
 */
export function readAuthSecrets(config: ResolvedConfig, env: Record<string, string | undefined> = process.env): AuthSecrets | undefined {
  if (config.config.auth === 'off') return undefined;
  const issues = authSecretIssues(env);
  if (issues.length > 0) throw new ConfigError(config.path, issues);
  return { clientSecret: env[OIDC_CLIENT_SECRET_ENV]!.trim(), sessionSecret: env[SESSION_SECRET_ENV]!.trim() };
}

/** Переменные с учётными данными хранилища и что в каждой. У имитации и у Loki без входа их нет. */
export function secretEnvs(b: BackendConfig): [name: string, what: string][] {
  if (b.type === 'loki-grafana') return [[b.tokenEnv, 'токен']];
  if (b.type !== 'loki') return [];
  if (b.tokenEnv) return [[b.tokenEnv, 'токен']];
  return b.usernameEnv && b.passwordEnv ? [[b.usernameEnv, 'имя для входа'], [b.passwordEnv, 'пароль']] : [];
}

/** Имя переменной окружения, которой не хватает хранилищу, или undefined. */
export function missingSecret(b: ResolvedBackend): string | undefined {
  if (b.type === 'loki-grafana') return b.token ? undefined : b.tokenEnv;
  if (b.type !== 'loki') return undefined;
  if (b.tokenEnv) return b.token ? undefined : b.tokenEnv;
  if (b.usernameEnv && !b.username) return b.usernameEnv;
  if (b.passwordEnv && !b.password) return b.passwordEnv;
  return undefined;
}
