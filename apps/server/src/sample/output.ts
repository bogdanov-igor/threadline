// Файл выборки: каталог вне репозитория, имя до первого запроса, атомарная запись, удаление.

import { access, chmod, constants, link, lstat, mkdir, open, readdir, realpath, rmdir, unlink, type FileHandle } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { ROOT } from '../paths.ts';
import { MAX_FILE_BYTES } from './limits.ts';
import { CUT } from './structure.ts';

export const DEFAULT_DIR = 'threadline-samples';
const SAMPLE_NAME = /^sample-[a-z0-9-]+-\d{8}-\d{6}(-\d+)?\.json(\.\d+\.tmp)?$/;

/** Ошибка каталога или записи: сообщение своё, без текста системной ошибки. */
export class OutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutputError';
  }
}

const code = (e: unknown) => (e as NodeJS.ErrnoException).code;

/** Каталог выборки: --out от каталога запуска, иначе домашний. Нет домашнего — просьба задать --out. */
export function resolveDir(out: string | undefined, cwd: string, home: string | undefined): { dir: string; explicit: boolean } {
  if (out !== undefined) return { dir: isAbsolute(out) ? out : resolve(cwd, out), explicit: true };
  if (!home) throw new OutputError('домашний каталог не определён: задайте --out');
  return { dir: join(home, DEFAULT_DIR), explicit: false };
}

async function isInsideRepo(path: string): Promise<boolean> {
  const root = await realpath(ROOT);
  return path === root || path.startsWith(`${root}${sep}`);
}

const REPO_REFUSAL = 'каталог выборки внутри репозитория: задайте --out вне него';

/** Готовит каталог до первого запроса. Возвращает, создан ли он этим запуском. */
export async function prepareDir(dir: string, explicit: boolean): Promise<{ created: boolean }> {
  const unavailable = () => new OutputError(explicit ? 'каталог выборки недоступен для записи' : 'домашний каталог недоступен для записи: задайте --out');
  let parent: string;
  try {
    parent = await realpath(dirname(dir));
  } catch {
    throw explicit ? new OutputError('родительский каталог --out не существует') : unavailable();
  }
  let st;
  try {
    st = await lstat(dir);
  } catch (e) {
    if (code(e) !== 'ENOENT') throw unavailable();
    if (await isInsideRepo(join(parent, basename(dir)))) throw new OutputError(REPO_REFUSAL);
    try {
      await mkdir(dir, { mode: 0o700 });
    } catch {
      throw unavailable();
    }
    return { created: true };
  }
  if (st.isSymbolicLink()) throw new OutputError('каталог выборки — символическая ссылка');
  if (!st.isDirectory()) throw new OutputError('путь --out не каталог');
  if (await isInsideRepo(await realpath(dir))) throw new OutputError(REPO_REFUSAL);
  if (process.getuid && st.uid !== process.getuid()) throw new OutputError('каталог выборки принадлежит другому пользователю');
  if ((st.mode & 0o077) !== 0) {
    try {
      await chmod(dir, 0o700);
    } catch {
      throw new OutputError('права каталога выборки не сузить');
    }
  }
  try {
    await access(dir, constants.W_OK);
  } catch {
    throw unavailable();
  }
  return { created: false };
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** Имя файла из настройки и часов, значений из записей в нём нет. */
export function sampleName(project: string, env: string, atMs: number): string {
  const d = new Date(atMs);
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `sample-${project}-${env}-${stamp}.json`;
}

const numbered = (name: string, n: number) => (n === 1 ? name : name.replace(/\.json$/, `-${n}.json`));
/** Окончание занятого имени стоит после времени запуска, само время окончанием не считается. */
const TAKEN_SUFFIX = /(-\d{8}-\d{6})-(\d+)\.json$/;

/** Свободное имя до первого запроса. Символическая ссылка на месте файла — отказ. */
export async function reserveName(dir: string, name: string): Promise<string> {
  for (let n = 1; ; n++) {
    const candidate = numbered(name, n);
    try {
      const st = await lstat(join(dir, candidate));
      if (st.isSymbolicLink()) throw new OutputError('имя файла выборки занято символической ссылкой');
    } catch (e) {
      if (code(e) === 'ENOENT') return candidate;
      throw e instanceof OutputError ? e : new OutputError('каталог выборки не читается');
    }
  }
}

export interface WriteOptions {
  /** Для тестов: сбой записи. */
  writeContent?: (handle: FileHandle, text: string) => Promise<void>;
  signal?: AbortSignal;
}

/**
 * Запись: временный файл с 0600 и wx, затем link в итоговое имя. rename молча заменил бы файл второго запуска в ту же секунду,
 * а link на занятое имя даёт ошибку, и берётся следующий номер. Сбой не оставляет частичного файла.
 */
export async function writeSample(dir: string, name: string, text: string, opts: WriteOptions = {}): Promise<string> {
  const tmp = join(dir, `${name}.${process.pid}.tmp`);
  const fail = () => new OutputError('файл выборки не записан');
  let handle: FileHandle;
  try {
    handle = await open(tmp, 'wx', 0o600);
  } catch {
    throw fail();
  }
  try {
    try {
      await (opts.writeContent ?? ((h, t) => h.writeFile(t)))(handle, text);
      await handle.chmod(0o600);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (opts.signal?.aborted) throw fail();
    const taken = TAKEN_SUFFIX.exec(name);
    const base = taken ? name.replace(TAKEN_SUFFIX, '$1.json') : name;
    for (let n = taken ? Number(taken[2]) : 1; ; n++) {
      const final = numbered(base, n);
      try {
        await link(tmp, join(dir, final));
        return join(dir, final);
      } catch (e) {
        if (code(e) !== 'EEXIST') throw e;
        if ((await lstat(join(dir, final))).isSymbolicLink()) throw fail();
      }
    }
  } catch {
    throw fail();
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}

/** Каталог создан этим запуском, а файла нет: пустой каталог не остаётся. */
export async function removeIfCreated(dir: string, created: boolean): Promise<void> {
  if (created) await rmdir(dir).catch(() => undefined);
}

const textOf = (doc: unknown) => JSON.stringify(doc, null, 2);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Записи с деревом: только в содержимом kinds. */
function treeHolders(v: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(v)) for (const x of v) treeHolders(x, out);
  else if (isObj(v)) {
    if ('tree' in v) out.push(v);
    else for (const x of Object.values(v)) treeHolders(x, out);
  }
  return out;
}

/** Файл не больше предела: деревья самых больших записей заменяются на <cut>. Возвращает число заменённых. */
export function fitFile(doc: { kinds: unknown; treesCut: number }, maxBytes: number = MAX_FILE_BYTES): number {
  let cut = 0;
  const holders = treeHolders(doc.kinds)
    .map((h) => ({ h, size: textOf(h.tree).length }))
    .sort((a, b) => b.size - a.size);
  for (const { h } of holders) {
    doc.treesCut = cut;
    if (Buffer.byteLength(textOf(doc)) <= maxBytes) break;
    h.tree = CUT;
    cut++;
  }
  doc.treesCut = cut;
  return cut;
}

/** Удаление по шаблону имени: файл, ссылка как ссылка, временный файл после kill -9. Чужое не трогается, пустой каталог удаляется. */
export async function cleanSamples(dir: string): Promise<{ removed: number; left: number }> {
  let st;
  try {
    st = await lstat(dir);
  } catch (e) {
    if (code(e) === 'ENOENT') return { removed: 0, left: 0 };
    throw new OutputError('каталог выборки не читается');
  }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new OutputError('путь выборки не каталог');
  let removed = 0;
  let left = 0;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    throw new OutputError('каталог выборки не читается');
  }
  for (const name of names) {
    const path = join(dir, name);
    const file = await lstat(path).catch(() => null);
    if (!SAMPLE_NAME.test(name) || !file || file.isDirectory()) {
      left++;
      continue;
    }
    try {
      await unlink(path);
      removed++;
    } catch {
      left++;
    }
  }
  if (left === 0) await rmdir(dir).catch(() => undefined);
  return { removed, left };
}
