// Миграции схемы справочника: SQL-файлы по имени, каждая один раз, под сеансовой блокировкой.

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DbError, type Db, type Queryable } from './db.ts';

export const MIGRATIONS_DIR = join(import.meta.dirname, 'migrations');
/** Ключ pg_advisory_lock миграций: вторая копия сервера ждёт первую. */
const LOCK = 7_310_420_501;

export interface Migration {
  name: string;
  sql: string;
}

export class MigrationError extends Error {
  readonly migration: string;
  constructor(migration: string, message: string) {
    super(message);
    this.name = 'MigrationError';
    this.migration = migration;
  }
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Текст миграции без строк-комментариев. */
const withoutComments = (sql: string) =>
  sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');

/**
 * Прежние суммы миграций, в которых потом поменялись только строки-комментарии. База, где миграция уже применена, хранит
 * сумму прежнего текста. Она считается своей, только пока SQL без комментариев совпадает с записанным здесь (sql — его сумма):
 * правка самого SQL по-прежнему даёт ошибку.
 */
const EARLIER: Readonly<Record<string, { checksum: string; sql: string }>> = {
  '0001_catalog.sql': {
    checksum: '8a625dff5c95f19b3bb80f2ce9da6cdd50cf2b152b4a23d164408f907c1d5ef3',
    sql: 'd390579a7218f8a54f8197212fc56100a6a4fb8bb5ab21b4f4d1ea99dbb9bbe4',
  },
  '0002_unknown_stand.sql': {
    checksum: 'b4176028553b8e097d7945459a989dcd03d1befbdcffd879caa54167a174e422',
    sql: 'bdae74a553dccd955ff32123a4391a206146898effe1e5eaa2b21848175fe209',
  },
  '0004_projects.sql': {
    checksum: 'a5990323fec1a8e84623af1a04b4f948fe857e1d851c75f823c5a005094b0e9f',
    sql: '45c8d99980a9350a075367e2cf99011c3b38a331d23e7c5eba9ec5180fb01a4f',
  },
  '0005_project_view.sql': {
    checksum: 'cc02dadd918ee378503cecf7a36dee60247b83d023028b664d43bfdb1a8c75f3',
    sql: 'fbce8f6f1eea55abe95e5774ffc7b552d35f1adb23c0253c4d9a560a638c99dc',
  },
  '0006_catalog_deleted.sql': {
    checksum: '692ced47abf47841a86702ff69100522d5084b86397a4fd0a3fd7a3fa87e1fd8',
    sql: 'f8b5c7fa9fead4bef72afacb812b1ca91427122a8575580b69575c50a4a454c0',
  },
  '0007_share_links.sql': {
    checksum: 'f9a219e136f63267c6647dde9fd3e0626fbafb8d942c6e5b2706fc6289ae17df',
    sql: 'eb26e7da420bc9c546f86e06ee51cf6c062885314153447c6d4a5e51d04a8695',
  },
};

/** Сумма в учёте подходит к файлу: это сумма его текста или прежняя сумма при том же SQL. */
function sameMigration(was: string, m: Migration): boolean {
  if (was === sha256(m.sql)) return true;
  const earlier = EARLIER[m.name];
  return earlier !== undefined && was === earlier.checksum && sha256(withoutComments(m.sql)) === earlier.sql;
}

/** Код PostgreSQL: таблицы нет. */
const UNDEFINED_TABLE = '42P01';

/** Сверка учёта с файлами: миграция без файла и изменённая применённая миграция дают ошибку с именем. */
function checkApplied(done: ReadonlyMap<string, string>, list: readonly Migration[]): void {
  const files = new Set(list.map((m) => m.name));
  for (const name of done.keys()) {
    if (!files.has(name)) throw new MigrationError(name, `миграция ${name} есть в базе, но файл не найден`);
  }
  for (const m of list) {
    const was = done.get(m.name);
    if (was !== undefined && !sameMigration(was, m)) throw new MigrationError(m.name, `изменена уже применённая миграция ${m.name}`);
  }
}

/** Какие миграции не применены. Только чтение: так сервер проверяет схему при старте. Таблицы учёта нет — не применено ничего. */
export async function pendingMigrations(db: Queryable, migrations?: readonly Migration[]): Promise<string[]> {
  const list = migrations ?? (await readMigrations());
  let rows: { name: string; checksum: string }[];
  try {
    rows = await db.query<{ name: string; checksum: string }>('select name, checksum from threadline_migrations');
  } catch (e) {
    if (e instanceof DbError && e.pgCode === UNDEFINED_TABLE) return list.map((m) => m.name);
    throw e;
  }
  const done = new Map(rows.map((r) => [r.name, r.checksum]));
  checkApplied(done, list);
  return list.filter((m) => !done.has(m.name)).map((m) => m.name);
}

export async function readMigrations(dir = MIGRATIONS_DIR): Promise<Migration[]> {
  const names = (await readdir(dir)).filter((n) => /^\d{4}_[\w-]+\.sql$/.test(n)).sort();
  return Promise.all(names.map(async (name) => ({ name, sql: await readFile(join(dir, name), 'utf8') })));
}

/** Применяет недостающие миграции. Ошибка — MigrationError с именем миграции; упавшая откатывается целиком. */
export async function migrate(db: Db, migrations?: readonly Migration[]): Promise<{ applied: string[] }> {
  const list = migrations ?? (await readMigrations());
  return db.session(async (s) => {
    await s.query('select pg_advisory_lock($1)', [LOCK]);
    try {
      await s.exec(
        'create table if not exists threadline_migrations (name text primary key, checksum text not null, applied_at timestamptz not null default now())',
      );
      const done = new Map((await s.query<{ name: string; checksum: string }>('select name, checksum from threadline_migrations')).map((r) => [r.name, r.checksum]));
      checkApplied(done, list);
      const applied: string[] = [];
      for (const m of list) {
        if (done.has(m.name)) continue;
        const sum = sha256(m.sql);
        try {
          await s.tx(async (q) => {
            await q.exec(m.sql);
            await q.query('insert into threadline_migrations (name, checksum) values ($1, $2)', [m.name, sum]);
          });
        } catch (e) {
          throw new MigrationError(m.name, `миграция ${m.name} не применена: ${e instanceof Error ? e.message : String(e)}`);
        }
        applied.push(m.name);
      }
      return { applied };
    } finally {
      await s.query('select pg_advisory_unlock($1)', [LOCK]).catch(() => undefined);
    }
  });
}
