// Хранилища локального режима: файл storages.json в каталоге данных, права 0600. Токен, имя и пароль лежат только в нём и в памяти
// сервера: в журнал, в ответы и в браузер они не попадают. Запись проверяется теми же правилами, что раздел backends файла настроек.

import { chmod, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LocalDatasource, LocalStorageAuth, LocalStorageInfo } from '@threadline/core';
import { validateBackend, type BackendConfig } from '@threadline/core/config';
import type { ResolvedBackend } from '../config/load.ts';

export const STORAGES_FILE = 'storages.json';
const FILE_VERSION = 1;
const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** Метка сред по умолчанию: так различаются среды в Kubernetes. */
export const DEFAULT_SCOPE_LABEL = 'namespace';

// Имена для проверки схемы файла настроек: в окружении значения не ищутся, секрет берётся из storages.json.
const TOKEN_ENV = 'LOCAL_STORAGE_TOKEN';
const USERNAME_ENV = 'LOCAL_STORAGE_USERNAME';
const PASSWORD_ENV = 'LOCAL_STORAGE_PASSWORD';

const TOKEN_MAX = 8192;
const USERNAME_MAX = 256;
const PASSWORD_MAX = 1024;
const URL_MAX = 2048;

/** Запись файла. Секреты здесь, наружу идёт только present(). */
export interface StoredStorage {
  type: 'loki' | 'loki-grafana';
  url: string;
  tenant?: string;
  datasource?: LocalDatasource;
  auth: LocalStorageAuth;
  token?: string;
  username?: string;
  password?: string;
  scopeLabel: string;
  addedAt: string;
}

export type StorageCheck = { ok: true; id: string; stored: StoredStorage; resolved: ResolvedBackend } | { ok: false; fields: Record<string, string> };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
// Управляющие символы в заголовке запроса недопустимы: значение с переводом строки подменило бы заголовки.
// eslint-disable-next-line no-control-regex -- образец и ищет управляющие символы
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Поле ошибки схемы → поле формы. */
function fieldOf(path: string): string {
  if (path === 'tokenEnv') return 'token';
  if (path === 'usernameEnv') return 'username';
  if (path === 'passwordEnv') return 'password';
  if (path.startsWith('formScope')) return 'scopeLabel';
  if (path.startsWith('datasource')) return 'datasource';
  return path || 'type';
}

/**
 * Проверка записи из формы или из файла. id проверяется отдельно: у проверки подключения его может не быть.
 * Сообщения без значений: ни токен, ни пароль в тексте ошибки не появляются.
 */
export function checkStorage(id: string, input: unknown, addedAt: string): StorageCheck {
  const fields: Record<string, string> = {};
  if (!ID.test(id)) fields.id = 'идентификатор: строчные латинские буквы, цифры и дефис, до 32 символов, первый знак не дефис';
  if (!isObj(input)) return { ok: false, fields: { ...fields, type: 'нужен объект хранилища' } };
  const type = input.type;
  if (type !== 'loki' && type !== 'loki-grafana') return { ok: false, fields: { ...fields, type: 'тип хранилища: loki или loki-grafana' } };

  const url = text(input.url) ?? '';
  if (!url) fields.url = type === 'loki' ? 'адрес Loki вида http://localhost:3100' : 'адрес Grafana вида https://grafana.example';
  else if (url.length > URL_MAX) fields.url = `адрес длиннее ${URL_MAX} символов`;
  const tenant = text(input.tenant);
  if (tenant !== undefined && type !== 'loki') fields.tenant = 'арендатор задаётся только у Loki напрямую: у Grafana он в настройке источника';
  const scopeLabel = text(input.scopeLabel) ?? DEFAULT_SCOPE_LABEL;

  // У Grafana вход всегда токеном сервисного аккаунта.
  let auth: LocalStorageAuth = 'bearer';
  if (type === 'loki') {
    const given = input.auth ?? 'none';
    if (given === 'none' || given === 'bearer' || given === 'basic') auth = given;
    else {
      fields.auth = 'вход в Loki: none, bearer или basic';
      auth = 'none';
    }
  }

  // Токен без пробелов по краям: при вставке из буфера они попадают случайно. Пароль как есть: пробел в нём бывает.
  const token = auth === 'bearer' ? text(input.token) : undefined;
  const username = auth === 'basic' ? text(input.username) : undefined;
  const password = auth === 'basic' && typeof input.password === 'string' && input.password !== '' ? input.password : undefined;
  if (auth === 'bearer') {
    if (!token) fields.token = type === 'loki-grafana' ? 'нужен токен сервисного аккаунта Grafana с ролью Viewer' : 'нужен токен Bearer';
    else if (token.length > TOKEN_MAX || CONTROL.test(token) || /\s/.test(token)) fields.token = `токен: печатные символы без пробелов, до ${TOKEN_MAX}`;
  }
  if (auth === 'basic') {
    if (!username) fields.username = 'нужно имя для входа';
    else if (username.length > USERNAME_MAX || CONTROL.test(username) || username.includes(':')) fields.username = `имя для входа: до ${USERNAME_MAX} символов, без двоеточия`;
    if (!password) fields.password = 'нужен пароль';
    else if (password.length > PASSWORD_MAX || CONTROL.test(password)) fields.password = `пароль: до ${PASSWORD_MAX} символов, без управляющих символов`;
  }

  let datasource: LocalDatasource | undefined;
  if (type === 'loki-grafana') {
    const d = input.datasource;
    if (d === undefined || d === null) datasource = { name: 'Loki' };
    else if (isObj(d) && typeof d.name === 'string') datasource = { name: d.name.trim() };
    else if (isObj(d) && typeof d.uid === 'string') datasource = { uid: d.uid.trim() };
    else if (isObj(d) && typeof d.id === 'number') datasource = { id: d.id };
    else fields.datasource = 'источник Loki в Grafana: имя, uid или id';
  }

  // Те же правила, что у записи backends файла настроек: адрес, арендатор, источник, метка границы.
  const candidate: Record<string, unknown> = {
    type,
    url: url || 'https://url-not-set.invalid',
    ...(type === 'loki' && tenant !== undefined ? { tenant } : {}),
    ...(datasource ? { datasource } : {}),
    ...(auth === 'bearer' ? { tokenEnv: TOKEN_ENV } : {}),
    ...(auth === 'basic' ? { usernameEnv: USERNAME_ENV, passwordEnv: PASSWORD_ENV } : {}),
    // Свой токен — свои данные: граница открыта, среды задаются равенством на эту метку.
    formScope: { label: scopeLabel, values: ['*'] },
  };
  const checked = validateBackend(candidate);
  if (!checked.ok) {
    for (const i of checked.issues) {
      const field = fieldOf(i.path);
      fields[field] ??= i.message;
    }
  }
  if (Object.keys(fields).length > 0 || !checked.ok) return { ok: false, fields };

  const stored: StoredStorage = {
    type,
    url,
    ...(type === 'loki' && tenant !== undefined ? { tenant } : {}),
    ...(datasource ? { datasource } : {}),
    auth,
    ...(token ? { token } : {}),
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
    scopeLabel,
    addedAt,
  };
  return { ok: true, id, stored, resolved: resolve(checked.backend, stored) };
}

/** Настройка хранилища для сервера: секреты из файла, как у файла настроек из переменных. Своего сертификата у локальных хранилищ нет. */
function resolve(backend: BackendConfig, s: StoredStorage): ResolvedBackend {
  if (backend.type === 'loki-grafana') return { ...backend, token: s.token, ca: undefined };
  if (backend.type === 'loki') return { ...backend, ca: undefined, ...(s.auth === 'bearer' ? { token: s.token } : {}), ...(s.auth === 'basic' ? { username: s.username, password: s.password } : {}) };
  throw new Error('локальное хранилище бывает только loki или loki-grafana');
}

/** Ответ браузеру: без токена, имени и пароля. */
export function present(id: string, s: StoredStorage, usedBy: string[]): LocalStorageInfo {
  return {
    id,
    type: s.type,
    url: s.url,
    ...(s.tenant !== undefined ? { tenant: s.tenant } : {}),
    ...(s.datasource ? { datasource: s.datasource } : {}),
    auth: s.auth,
    ...(s.auth !== 'none' ? { tokenSet: true as const } : {}),
    scopeLabel: s.scopeLabel,
    usedBy,
    addedAt: s.addedAt,
  };
}

export interface StoragesLog {
  warn(message: string): void;
}

/** Файл хранилищ каталога данных. Запись атомарная, по одной за раз: файл не бывает наполовину записан. */
export class LocalStorages {
  readonly file: string;
  #items = new Map<string, StoredStorage>();
  #queue: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) {
    this.file = join(dataDir, STORAGES_FILE);
  }

  /** Чтение при запуске. Файла нет — хранилищ нет. Неверная запись пропускается с предупреждением, испорченный файл откладывается в сторону. */
  async load(log: StoragesLog): Promise<Map<string, ResolvedBackend>> {
    const out = new Map<string, ResolvedBackend>();
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return out;
      throw e;
    }
    // Файл с токенами открыт другим: права сужаются до владельца.
    if (process.platform !== 'win32' && ((await stat(this.file)).mode & 0o077) !== 0) {
      await chmod(this.file, 0o600);
      log.warn(`${this.file}: файл был доступен другим пользователям, права сужены до 0600`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    const list = isObj(parsed) && parsed.version === FILE_VERSION && isObj(parsed.storages) ? parsed.storages : null;
    if (!list) {
      const aside = `${this.file}.bad`;
      await rename(this.file, aside);
      log.warn(`${this.file} не разобран и отложен в ${aside}: хранилища из него не подключены, подключите их заново`);
      return out;
    }
    for (const [id, entry] of Object.entries(list)) {
      const addedAt = isObj(entry) && typeof entry.addedAt === 'string' ? entry.addedAt : new Date(0).toISOString();
      const checked = checkStorage(id, entry, addedAt);
      if (!checked.ok) {
        log.warn(`${this.file}: хранилище «${ID.test(id) ? id : '?'}» пропущено: ${Object.entries(checked.fields).map(([f, m]) => `${f}: ${m}`).join('; ')}`);
        continue;
      }
      this.#items.set(id, checked.stored);
      out.set(id, checked.resolved);
    }
    return out;
  }

  list(): [string, StoredStorage][] {
    return [...this.#items];
  }

  has(id: string): boolean {
    return this.#items.has(id);
  }

  get(id: string): StoredStorage | undefined {
    return this.#items.get(id);
  }

  /** Сначала файл, потом память: при сбое записи хранилище не появляется. */
  add(id: string, s: StoredStorage): Promise<void> {
    return this.#serial(async () => {
      const next = new Map(this.#items).set(id, s);
      await this.#write(next);
      this.#items = next;
    });
  }

  remove(id: string): Promise<boolean> {
    return this.#serial(async () => {
      if (!this.#items.has(id)) return false;
      const next = new Map(this.#items);
      next.delete(id);
      await this.#write(next);
      this.#items = next;
      return true;
    });
  }

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #write(items: Map<string, StoredStorage>): Promise<void> {
    const body = JSON.stringify({ version: FILE_VERSION, storages: Object.fromEntries(items) }, null, 2);
    const tmp = `${this.file}.${process.pid}.tmp`;
    // Права с первого байта: файл не бывает открыт другим даже на миг. chmod — на случай umask шире ожидаемого.
    await writeFile(tmp, `${body}\n`, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.file);
  }
}
