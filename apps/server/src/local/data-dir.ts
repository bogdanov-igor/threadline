// Каталог данных локального режима: права 0700, файл настроек, встроенная база, хранилища.
// Первый запуск пишет настройку из демо-проекта репозитория: проекты на имитации хранилища, чтобы интерфейс не был пустым.

import { chmod, copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parse, stringify } from 'yaml';
import { DEFAULT_CONFIG } from '../paths.ts';
import { CONFIG_FILE, PRODUCT_NAME } from './names.ts';

export const DB_DIR = 'db';

/** Ошибка запуска, понятная человеку: текст идёт в терминал как есть, значений и секретов в нём нет. */
export class LocalStartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalStartError';
  }
}

export interface DataDir {
  dir: string;
  config: string;
  db: string;
  /** Каталог создан этим запуском. */
  created: boolean;
  /** Файл настроек написан этим запуском. */
  configCreated: boolean;
}

export interface DataDirLog {
  warn(message: string): void;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
}

/** Каталог и настройка. Существующий файл настроек не меняется: его мог править человек. */
export async function prepareDataDir(dir: string, log: DataDirLog, source = DEFAULT_CONFIG): Promise<DataDir> {
  const created = !(await exists(dir));
  if (created) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
  } else {
    const s = await stat(dir);
    if (!s.isDirectory()) throw new LocalStartError(`${dir} — это файл, а нужна папка данных: укажите другую через --data`);
    if (process.platform !== 'win32' && (s.mode & 0o077) !== 0) log.warn(`папка данных ${dir} доступна другим пользователям: в ней токены хранилищ, лучше chmod 700`);
  }
  const config = join(dir, CONFIG_FILE);
  const configCreated = !(await exists(config));
  if (configCreated) await writeDemoConfig(dir, config, source);
  return { dir, config, db: join(dir, DB_DIR), created, configCreated };
}

/**
 * Настройка первого запуска: вход выключен, хранилищ кроме имитации нет, проекты демо-набора только со средами на имитации.
 * Логотипы и начальный набор справочника копируются рядом: настройка ссылается на них путями от своей папки.
 */
export async function writeDemoConfig(dir: string, target: string, source = DEFAULT_CONFIG): Promise<void> {
  const from = dirname(source);
  const repo = parse(await readFile(source, 'utf8')) as Record<string, unknown>;
  const allBackends = isObj(repo.backends) ? repo.backends : {};
  const mock = new Set(Object.entries(allBackends).filter(([, b]) => isObj(b) && b.type === 'mock').map(([id]) => id));
  const projects: Record<string, unknown> = {};
  const used = new Set<string>();
  for (const [pid, p] of Object.entries(isObj(repo.projects) ? repo.projects : {})) {
    if (!isObj(p) || !isObj(p.environments)) continue;
    const envs = Object.fromEntries(Object.entries(p.environments).filter(([, e]) => isObj(e) && typeof e.backend === 'string' && mock.has(e.backend)));
    if (Object.keys(envs).length === 0) continue;
    for (const e of Object.values(envs)) used.add((e as { backend: string }).backend);
    projects[pid] = { ...p, environments: envs };
    if (isObj(p.logo)) for (const file of Object.values(p.logo)) if (typeof file === 'string') await copyBeside(from, dir, file);
    await copyBeside(from, dir, `catalog/${pid}.yaml`, true);
  }
  const first = Object.entries(projects)[0] as [string, { environments: Record<string, unknown> }] | undefined;
  const config: Record<string, unknown> = {
    auth: 'off',
    ...(first ? { defaults: { project: first[0], environment: Object.keys(first[1].environments)[0] } } : {}),
    backends: Object.fromEntries([...used].map((id) => [id, allBackends[id]])),
    ...(repo.regional ? { regional: repo.regional } : {}),
    ...(repo.formats ? { formats: repo.formats } : {}),
    projects,
  };
  const header = [
    `# Настройка локального режима ${PRODUCT_NAME}. Создана при первом запуске из демо-проекта репозитория.`,
    '# Вход выключен: адрес только 127.0.0.1. Свои Grafana и Loki подключаются в интерфейсе («Подключить хранилище»),',
    '# их адреса и токены лежат в storages.json рядом, с правами 0600. Проекты и среды правятся на страницах проектов.',
    '# Начать заново: остановите сервер и удалите эту папку.',
    '',
  ].join('\n');
  await writeFile(target, `${header}${stringify(config, { lineWidth: 0 })}`, { mode: 0o600 });
}

/** Файл из папки настроек репозитория в ту же относительную папку каталога данных. Только безопасные относительные пути. */
async function copyBeside(from: string, to: string, file: string, optional = false): Promise<void> {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/.test(file)) return;
  const src = join(from, file);
  if (optional && !(await exists(src))) return;
  const dst = join(to, file);
  await mkdir(dirname(dst), { recursive: true, mode: 0o700 });
  await copyFile(src, dst);
}
