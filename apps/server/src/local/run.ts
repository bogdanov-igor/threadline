// Запуск локального режима: каталог данных, встроенная база PGlite, хранилища из storages.json, порт, браузер.
// Тот же сервер, что в кластере (buildApp): другие только источник настройки, база и адрес 127.0.0.1.

import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { open, readFile, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { buildApp } from '../app.ts';
import { Backends } from '../backends/registry.ts';
import { pgliteDirUrl } from '../catalog/db.ts';
import { ConfigError, loadConfig } from '../config/load.ts';
import { Health } from '../health.ts';
import { queryLog } from '../logging.ts';
import { Metrics } from '../metrics.ts';
import { ROOT, WEB_DIST } from '../paths.ts';
import { MemoryBudget } from '../search/memory.ts';
import { shutdownHandler } from '../shutdown.ts';
import { LocalStartError, prepareDataDir } from './data-dir.ts';
import { PRODUCT_NAME } from './names.ts';
import { DEFAULT_PORT, parseLocalArgs, PORT_TRIES, usage, UsageError, type LocalOptions } from './options.ts';
import { LocalStorages } from './storages.ts';

export const LOCK_FILE = 'local.lock';

export interface Out {
  info(message: string): void;
  error(message: string): void;
}

const consoleOut: Out = { info: (m) => console.log(m), error: (m) => console.error(m) };

/** Свободен ли порт на адресе: пробное занятие и сразу освобождение. */
export function portFree(port: number, host: string): Promise<boolean> {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.unref();
    probe.once('error', (e: NodeJS.ErrnoException) => (e.code === 'EADDRINUSE' ? done(false) : fail(e)));
    probe.listen({ port, host, exclusive: true }, () => probe.close(() => done(true)));
  });
}

/** Первый свободный порт от start. null — все tries заняты. */
export async function findPort(start: number, host: string, tries = PORT_TRIES): Promise<number | null> {
  for (let port = start; port < start + tries && port <= 65535; port++) if (await portFree(port, host)) return port;
  return null;
}

/** Команда, которая открывает адрес в браузере по умолчанию. */
export function openCommand(platform: NodeJS.Platform, url: string): [string, string[]] {
  if (platform === 'darwin') return ['open', [url]];
  // start — команда cmd; первая строка в кавычках — заголовок окна, без неё адрес принялся бы за него.
  if (platform === 'win32') return ['cmd', ['/c', 'start', '""', url]];
  return ['xdg-open', [url]];
}

function openBrowser(url: string, out: Out): void {
  const [cmd, args] = openCommand(process.platform, url);
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => out.info(`Браузер не открылся сам: откройте ${url}`));
    child.unref();
  } catch {
    out.info(`Браузер не открылся сам: откройте ${url}`);
  }
}

interface LockFacts {
  pid: number;
  port: number | null;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function answers(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function readLock(path: string): Promise<LockFacts | null> {
  try {
    const v = JSON.parse(await readFile(path, 'utf8')) as Partial<LockFacts>;
    return typeof v.pid === 'number' ? { pid: v.pid, port: typeof v.port === 'number' ? v.port : null } : null;
  } catch {
    return null;
  }
}

/**
 * Одна копия на каталог данных: база PGlite открывается одним процессом. Уже запущенная копия — её адрес.
 * Запись блокировки исключительная: два запуска подряд не откроют базу вдвоём.
 */
export async function takeLock(dataDir: string): Promise<{ ok: true; path: string } | { ok: false; port: number | null }> {
  const path = join(dataDir, LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = await open(path, 'wx', 0o600);
      await file.writeFile(JSON.stringify({ pid: process.pid, port: null }));
      await file.close();
      return { ok: true, path };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    const held = await readLock(path);
    if (held && alive(held.pid)) {
      // Копия ещё запускается и порта не записала: подождать немного.
      for (let i = 0; i < 20 && held.port === null; i++) {
        await new Promise((r) => setTimeout(r, 250));
        held.port = (await readLock(path))?.port ?? null;
      }
      if (held.port === null || (await answers(held.port))) return { ok: false, port: held.port };
    }
    // Процесса нет или он не наш: блокировка осталась от упавшего запуска.
    await unlink(path).catch(() => undefined);
  }
  throw new LocalStartError(`Не удалось занять ${path}: удалите файл, если ${PRODUCT_NAME} с этой папкой не запущен`);
}

export interface RunOptions {
  env?: NodeJS.ProcessEnv;
  out?: Out;
  /** Для тестов: не ставить обработчики сигналов и не выходить из процесса. */
  signals?: boolean;
}

export interface Running {
  url: string;
  port: number;
  dataDir: string;
  close(): Promise<void>;
}

/** Запуск по параметрам командной строки. Число — код выхода без запуска сервера; Running — сервер работает. */
export async function runLocal(argv: readonly string[], opts: RunOptions = {}): Promise<number | Running> {
  const env = opts.env ?? process.env;
  const out = opts.out ?? consoleOut;
  let options: LocalOptions | 'help';
  try {
    options = parseLocalArgs(argv, env);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    out.error(e.message);
    out.error('');
    out.error(usage());
    return 2;
  }
  if (options === 'help') {
    out.info(usage());
    return 0;
  }
  try {
    return await start(options, env, out, opts.signals ?? true);
  } catch (e) {
    if (e instanceof LocalStartError) {
      out.error(e.message);
      return 1;
    }
    const code = (e as NodeJS.ErrnoException | null)?.code;
    if (code && FS_CODES.has(code)) {
      out.error(`Папка данных недоступна (${code}): ${options.dataDir}. Укажите другую через --data`);
      return 1;
    }
    throw e;
  }
}

/** Ошибки файловой системы, понятные без подробностей: нет прав, только чтение, путь не папка, нет места. */
const FS_CODES = new Set(['EACCES', 'EPERM', 'EROFS', 'ENOTDIR', 'ENOSPC', 'EEXIST']);

async function start(options: LocalOptions, env: NodeJS.ProcessEnv, out: Out, signals: boolean): Promise<number | Running> {
  const { host } = options;
  // Интерфейс собирается командой pnpm build; сквозные тесты подставляют свой каталог, как у обычного сервера.
  const webDist = env.THREADLINE_WEB_DIST?.trim() ? resolve(ROOT, env.THREADLINE_WEB_DIST.trim()) : WEB_DIST;
  if (!existsSync(join(webDist, 'index.html'))) {
    out.error(`Интерфейс не собран: нет ${join(webDist, 'index.html')}. Выполните pnpm build в корне репозитория.`);
    return 1;
  }
  const warn = (m: string) => out.error(`Внимание: ${m}`);
  const data = await prepareDataDir(options.dataDir, { warn });
  const lock = await takeLock(data.dir);
  if (!lock.ok) {
    const url = lock.port === null ? null : `http://${host}:${lock.port}/`;
    out.info(url ? `${PRODUCT_NAME} уже запущен с папкой ${data.dir}: ${url}` : `${PRODUCT_NAME} с папкой ${data.dir} ещё запускается`);
    if (url && options.open) openBrowser(url, out);
    return 0;
  }
  const releaseLock = () => {
    try {
      unlinkSync(lock.path);
    } catch {
      // уже удалён
    }
  };
  try {
    return await serve(options, data, webDist, lock.path, releaseLock, out, warn, signals);
  } catch (e) {
    releaseLock();
    throw e;
  }
}

async function serve(
  options: LocalOptions,
  data: Awaited<ReturnType<typeof prepareDataDir>>,
  webDist: string,
  lockPath: string,
  releaseLock: () => void,
  out: Out,
  warn: (m: string) => void,
  signals: boolean,
): Promise<number | Running> {
  const { host } = options;
  if (options.port !== null && !(await portFree(options.port, host))) {
    out.error(`Порт ${options.port} занят: укажите другой, например --port ${options.port + 1}`);
    releaseLock();
    return 1;
  }
  let config;
  try {
    // Окружение разработчика (адрес базы, вход, токены Grafana) в локальный режим не попадает: всё задаёт каталог данных.
    config = await loadConfig({ path: data.config, env: {} });
  } catch (e) {
    if (e instanceof ConfigError) {
      out.error(e.format());
      releaseLock();
      return 1;
    }
    throw e;
  }
  if (config.config.auth !== 'off') {
    out.error(`В локальном режиме вход выключен: замените раздел auth на auth: off в ${data.config}`);
    releaseLock();
    return 1;
  }

  const storages = new LocalStorages(data.dir);
  for (const [id, b] of await storages.load({ warn })) {
    if (Object.hasOwn(config.backends, id)) warn(`хранилище «${id}» из storages.json пропущено: такое имя уже есть в ${data.config}`);
    else config.backends[id] = b;
  }

  const backends = new Backends(config);
  const health = new Health();
  const app = await buildApp({ config, backends, webDist, logger: true, databaseUrl: pgliteDirUrl(data.db), health, metrics: new Metrics(), memory: new MemoryBudget(), local: { storages } });
  backends.onQuery = queryLog(app.log);
  for (const w of config.warnings ?? []) warn(`${w.path}: ${w.message}`);

  let port = options.port;
  if (port === null) {
    port = await findPort(DEFAULT_PORT, host);
    if (port === null) {
      out.error(`Порты ${DEFAULT_PORT}–${DEFAULT_PORT + PORT_TRIES - 1} заняты: укажите свободный через --port`);
      await app.close();
      releaseLock();
      return 1;
    }
  }
  await app.listen({ host, port });
  await writeFile(lockPath, JSON.stringify({ pid: process.pid, port }), { mode: 0o600 });
  const url = `http://${host}:${port}/`;
  out.info(`${PRODUCT_NAME} работает: ${url}`);
  out.info(`Папка данных: ${data.dir}${data.configCreated ? ' (создана настройка с демо-проектом)' : ''}`);
  out.info('Остановить: Ctrl+C');
  if (options.open) openBrowser(url, out);

  const close = async () => {
    try {
      await app.close();
    } finally {
      releaseLock();
    }
  };
  if (signals) {
    const stop = shutdownHandler({ app: { log: { info: () => undefined, error: (m) => out.error(m) }, close }, health, timeoutMs: 10_000 });
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    process.on('exit', releaseLock);
  }
  return { url, port, dataDir: data.dir, close };
}
