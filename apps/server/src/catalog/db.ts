// Подключение к базе справочника: пул pg для postgres://, PGlite в памяти для pglite://memory (тесты и e2e),
// PGlite в каталоге для pglite:file:///каталог (локальный режим).
// Пароль из адреса не попадает ни в журнал, ни в тексты ошибок.

import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';

export type Row = Record<string, unknown>;

export interface Queryable {
  query<R = Row>(sql: string, params?: readonly unknown[]): Promise<R[]>;
  /** Несколько команд без параметров: файл миграции. */
  exec(sql: string): Promise<void>;
}

/** Одно соединение: сеансовая блокировка и транзакции на нём. */
export interface Session extends Queryable {
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
}

export interface Db extends Session {
  /** host:port/db без учётных данных: для журнала и состояния справочника. */
  readonly label: string;
  session<T>(fn: (s: Session) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export class DbError extends Error {
  /** Код ошибки PostgreSQL (23505 — повтор), если есть. */
  readonly pgCode: string | undefined;
  constructor(message: string, pgCode?: string) {
    super(message);
    this.name = 'DbError';
    this.pgCode = pgCode;
  }
}

/** Адрес для журнала: хост, порт и база, без пользователя и пароля. */
export function describeUrl(url: string): string {
  if (url.startsWith('pglite:')) return url === 'pglite://memory' ? 'pglite (в памяти)' : 'pglite (каталог данных)';
  try {
    const u = new URL(url);
    const host = u.hostname || 'localhost';
    const db = decodeURIComponent(u.pathname.replace(/^\//, '')) || '—';
    return `${host}:${u.port || '5432'}/${db}`;
  } catch {
    return 'адрес не разобран';
  }
}

/** Пароль адреса в обоих видах: как в адресе и раскодированный. */
function secretsOf(url: string): string[] {
  try {
    const u = new URL(url);
    const out = [u.password, decodeURIComponent(u.password), u.username && u.password ? `${u.username}:${u.password}` : ''];
    return out.filter((s) => s.length >= 1);
  } catch {
    return [];
  }
}

/** Текст ошибки базы без пароля: пароль вырезается, даже если драйвер его повторил. */
export function safeMessage(e: unknown, url: string): string {
  const raw = e instanceof Error ? e.message : String(e);
  let out = raw;
  for (const s of secretsOf(url).sort((a, b) => b.length - a.length)) out = out.split(s).join('***');
  return out.replace(/postgres(?:ql)?:\/\/[^\s'"]*/gi, '<адрес>').slice(0, 300) || 'ошибка без описания';
}

function wrapError(e: unknown, url: string): DbError {
  if (e instanceof DbError) return e;
  const code = typeof (e as { code?: unknown })?.code === 'string' ? (e as { code: string }).code : undefined;
  return new DbError(safeMessage(e, url), code);
}

export function isUniqueViolation(e: unknown): boolean {
  return e instanceof DbError && e.pgCode === '23505';
}

// SQLSTATE: 08 — соединение, 53 — нет ресурсов, 57P — сервер останавливается, 57014 — истёк statement_timeout.
const CONNECTION_STATE = /^(?:08|53|57P)|^57014$/;
// Системный код Node: ENOTFOUND, EAI_AGAIN, EHOSTUNREACH, EPIPE. ERR_* — ошибка программы, а не связи.
const SYSTEM_CODE = /^E(?!RR_)[A-Z0-9_]+$/;

/** Ошибка соединения, а не данных: системный код, обрыв, таймаут или ошибка без SQLSTATE. */
export function isConnectionError(e: DbError): boolean {
  if (e.pgCode === undefined) return true;
  return SYSTEM_CODE.test(e.pgCode) || CONNECTION_STATE.test(e.pgCode);
}

// 55P03 — истёк lock_timeout, 57014 — истёк statement_timeout: база отвечает, но занята.
const BUSY_STATE = /^(?:55P03|57014)$/;

/** Ожидание блокировки или запрос не уложились в предел: идёт другая правка или импорт, повтор поможет. */
export function isBusyError(e: unknown): boolean {
  return e instanceof DbError && e.pgCode !== undefined && BUSY_STATE.test(e.pgCode);
}

/** Сколько правка ждёт блокировку: меньше statement_timeout, чтобы ожидание кончалось кодом блокировки, а не таймаутом запроса. */
export const LOCK_WAIT = '4s';

/** Предел ожидания блокировок до конца транзакции: долгий импорт в другой копии даёт «занято», а не «база недоступна». */
export async function limitLockWait(q: Queryable): Promise<void> {
  await q.exec(`set local lock_timeout = '${LOCK_WAIT}'`);
}

export interface OpenOptions {
  /** Журнал сервера: ошибки простаивающих соединений. */
  warn?: (message: string) => void;
  /** Команда миграций: без statement_timeout и query_timeout, ожидание блокировки и долгая миграция не обрываются. */
  noQueryLimits?: boolean;
}

/** Пул pg или PGlite по схеме адреса. Подключение проверяется отдельно: open соединений не открывает. */
export async function openDb(url: string, opts: OpenOptions = {}): Promise<Db> {
  if (url.startsWith('pglite:')) return openPglite(url);
  if (!/^postgres(?:ql)?:\/\//.test(url)) throw new DbError('THREADLINE_DATABASE_URL: адрес вида postgres://пользователь:пароль@хост:порт/база');
  // Неразбираемый адрес повтором не исправится: это ошибка настройки. Текст без адреса: в нём пароль.
  if (!URL.canParse(url)) {
    throw new DbError('THREADLINE_DATABASE_URL: адрес не разобран. Символы пароля / ? # @ : % нужно кодировать (encodeURIComponent)');
  }
  return openPg(url, opts);
}

const CLOSE_TIMEOUT_MS = 3000;

function openPg(url: string, opts: OpenOptions): Db {
  const pool = new pg.Pool({
    connectionString: url,
    max: 4,
    connectionTimeoutMillis: 5000,
    ...(opts.noQueryLimits
      ? {}
      : {
          statement_timeout: 5000,
          // statement_timeout работает на стороне базы: зависшая база его не выполнит, запрос ждал бы вечно.
          query_timeout: 8000,
        }),
    application_name: 'threadline',
    idleTimeoutMillis: 30_000,
  });
  // Соединение оборвалось в простое: без обработчика процесс бы упал.
  pool.on('error', (e) => opts.warn?.(`база справочника: соединение оборвалось (${safeMessage(e, url)})`));
  const label = describeUrl(url);

  const on = (c: pg.PoolClient | pg.Pool): Queryable => ({
    async query<R>(sql: string, params: readonly unknown[] = []) {
      try {
        return (await c.query(sql, params as unknown[])).rows as R[];
      } catch (e) {
        throw wrapError(e, url);
      }
    },
    async exec(sql: string) {
      try {
        await c.query(sql);
      } catch (e) {
        throw wrapError(e, url);
      }
    },
  });

  const txOn = async <T>(client: pg.PoolClient, fn: (q: Queryable) => Promise<T>): Promise<T> => {
    const q = on(client);
    await q.exec('begin');
    try {
      const out = await fn(q);
      await q.exec('commit');
      return out;
    } catch (e) {
      try {
        await client.query('rollback');
      } catch {
        // соединение уже потеряно — откат сделает сервер
      }
      throw e;
    }
  };

  const connect = async () => {
    try {
      return await pool.connect();
    } catch (e) {
      throw wrapError(e, url);
    }
  };

  const session = async <T>(fn: (s: Session) => Promise<T>): Promise<T> => {
    const client = await connect();
    let broken = false;
    // Взятое соединение пул не слушает: обрыв между командами или во время запроса без обработчика уронил бы процесс.
    // Идущий запрос отклоняется сам, следующий получает ошибку соединения: обработчику остаётся пометить соединение.
    const onError = () => {
      broken = true;
    };
    client.on('error', onError);
    try {
      return await fn({ ...on(client), tx: (f) => txOn(client, f) });
    } catch (e) {
      broken ||= e instanceof DbError;
      throw e;
    } finally {
      client.removeListener('error', onError);
      // Соединение с ошибкой не возвращается в пул: на нём могла остаться сеансовая блокировка.
      client.release(broken);
    }
  };

  return {
    label,
    ...on(pool),
    session,
    tx: (fn) => session((s) => s.tx(fn)),
    // Зависшая база не отпускает соединения: остановка сервера её не ждёт.
    close: () => Promise.race([pool.end(), new Promise<void>((resolve) => setTimeout(resolve, CLOSE_TIMEOUT_MS).unref())]),
  };
}

interface PgliteLike {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<unknown>;
  transaction<T>(fn: (tx: { query<U>(sql: string, params?: unknown[]): Promise<{ rows: U[] }>; exec(sql: string): Promise<unknown> }) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const PGLITE_FILE = 'pglite:file:';

/** Встроенная база в каталоге на диске: локальный режим (cli/local.ts). Путь любой, в том числе с пробелами и не латиницей. */
export const pgliteDirUrl = (dir: string): string => `pglite:${pathToFileURL(dir).href}`;

async function openPglite(url: string): Promise<Db> {
  const dir = url === 'pglite://memory' ? undefined : url.startsWith(PGLITE_FILE) ? fileURLToPath(url.slice('pglite:'.length)) : null;
  if (dir === null) throw new DbError('PGlite: поддерживаются адреса pglite://memory и pglite:file:///каталог');
  let mod: { PGlite: new (dataDir?: string) => PgliteLike };
  try {
    // Модуль грузится только для адреса pglite: серверу с PostgreSQL он не нужен.
    const name = '@electric-sql/pglite';
    mod = (await import(name)) as { PGlite: new (dataDir?: string) => PgliteLike };
  } catch {
    throw new DbError('PGlite не установлен: выполните pnpm install');
  }
  const db = dir === undefined ? new mod.PGlite() : new mod.PGlite(dir);
  const on = (c: Pick<PgliteLike, 'exec'> & { query<U>(sql: string, params?: unknown[]): Promise<{ rows: U[] }> }): Queryable => ({
    async query<R>(sql: string, params: readonly unknown[] = []) {
      try {
        return (await c.query<R>(sql, [...params])).rows;
      } catch (e) {
        throw wrapError(e, url);
      }
    },
    async exec(sql: string) {
      try {
        await c.exec(sql);
      } catch (e) {
        throw wrapError(e, url);
      }
    },
  });
  const tx = <T>(fn: (q: Queryable) => Promise<T>): Promise<T> => db.transaction((t) => fn(on(t)));
  const self: Session = { ...on(db), tx };
  return {
    label: describeUrl(url),
    ...self,
    session: (fn) => fn(self),
    close: () => db.close(),
  };
}
