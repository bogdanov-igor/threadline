// Параметры команды локального режима. Чистые функции: их читает тест.

import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DATA_DIR_ENV, DATA_DIR_NAME, PRODUCT_NAME } from './names.ts';

/** Единственный адрес локального режима: вход выключен, открытый в сеть адрес дал бы любому права администратора. */
export const LOCAL_HOST = '127.0.0.1';
export const DEFAULT_PORT = 8080;
/** Сколько портов подряд от 8080 пробуется, если порт не задан. */
export const PORT_TRIES = 20;

export interface LocalOptions {
  /** null — 8080 или следующий свободный. */
  port: number | null;
  dataDir: string;
  open: boolean;
  host: typeof LOCAL_HOST;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export function usage(): string {
  return [
    `${PRODUCT_NAME} на своём компьютере: один пользователь, вход выключен, адрес только ${LOCAL_HOST}.`,
    '',
    '  pnpm local [-- параметры]',
    '',
    'Параметры:',
    `  --port <номер>    порт; по умолчанию ${DEFAULT_PORT} или следующий свободный`,
    `  --data <папка>    каталог данных; по умолчанию ~/${DATA_DIR_NAME} или переменная ${DATA_DIR_ENV}`,
    '  --no-open         не открывать браузер',
    `  --host ${LOCAL_HOST}  другой адрес в этом режиме не принимается`,
    '  -h, --help        эта справка',
  ].join('\n');
}

/** ~ в начале пути из переменной окружения: оболочка его не раскрывает. */
function expandHome(path: string, home: string): string {
  if (path === '~') return home;
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(home, path.slice(2));
  return path;
}

function parsePort(value: string): number {
  if (!/^\d{1,5}$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw new UsageError(`--port: нужно целое число от 1 до 65535, получено «${value}»`);
  return Number(value);
}

/** Разбор параметров. 'help' — показать справку. Ошибка — UsageError с понятным текстом. */
export function parseLocalArgs(argv: readonly string[], env: Record<string, string | undefined>, opts: { home?: string; cwd?: string } = {}): LocalOptions | 'help' {
  let values;
  // pnpm local -- --port 8085: разделитель, который оставил менеджер пакетов, параметром не считается.
  const args = argv[0] === '--' ? argv.slice(1) : [...argv];
  try {
    ({ values } = parseArgs({
      args,
      strict: true,
      allowPositionals: false,
      options: {
        port: { type: 'string' },
        data: { type: 'string' },
        'no-open': { type: 'boolean' },
        host: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e));
  }
  if (values.help) return 'help';
  const host = values.host?.trim();
  if (host !== undefined && host !== LOCAL_HOST && host !== 'localhost') {
    throw new UsageError(`--host ${host}: локальный режим слушает только ${LOCAL_HOST}. Вход в нём выключен, и адрес в сети дал бы любому права администратора. Для работы в сети нужен сервер со входом (README.ru.md, «Вход: OIDC»).`);
  }
  const home = opts.home ?? homedir();
  const cwd = opts.cwd ?? process.cwd();
  const given = values.data?.trim() || env[DATA_DIR_ENV]?.trim() || '';
  if (values.data !== undefined && !values.data.trim()) throw new UsageError('--data: укажите папку');
  const dataDir = given ? expandHome(given, home) : join(home, DATA_DIR_NAME);
  return {
    port: values.port === undefined ? null : parsePort(values.port.trim()),
    dataDir: isAbsolute(dataDir) ? resolve(dataDir) : resolve(cwd, dataDir),
    open: !values['no-open'],
    host: LOCAL_HOST,
  };
}
