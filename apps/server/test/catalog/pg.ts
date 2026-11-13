// Настоящий PostgreSQL 16 для тестов справочника: адрес находит pg-setup.ts один раз на прогон.
// Каждый файл тестов получает свою базу. Схему сервер не ставит, поэтому база сразу с миграциями; пустую просит empty.

import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { inject } from 'vitest';
import { openDb, type Db } from '../../src/catalog/db.ts';
import { migrate } from '../../src/catalog/migrate.ts';

const admin = inject('pgAdminUrl');
const failure = inject('pgFailure');
const run = inject('pgRunId');
// Базы нет не из-за Docker: файл падает, а не пропускается.
if (failure) throw new Error(failure);
// Нет значения — прогон без vitest.config.ts этого пакета: тесты молча не пройдут.
if (admin === undefined) throw new Error('[catalog] нет адреса базы от test/catalog/pg-setup.ts: запускайте тесты из apps/server.');

/** Новая база с миграциями, с empty без них; адрес — postgres://… с паролем. null — Docker недоступен. */
export async function freshDatabase(opts: { empty?: boolean } = {}): Promise<string | null> {
  if (!admin) return null;
  const name = `threadline_t_${run}_${randomBytes(5).toString('hex')}`;
  const c = new pg.Client({ connectionString: admin });
  await c.connect();
  try {
    await c.query(`create database ${name}`);
  } finally {
    await c.end();
  }
  const u = new URL(admin);
  u.pathname = `/${name}`;
  const url = u.toString();
  if (!opts.empty) {
    const db = await openDb(url);
    try {
      await migrate(db);
    } finally {
      await db.close();
    }
  }
  return url;
}

/** Тестовая база для файла: адрес и открытое подключение; null — Docker недоступен. */
export async function testDb(): Promise<{ url: string; db: Db } | null> {
  const url = await freshDatabase();
  if (!url) return null;
  return { url, db: await openDb(url) };
}

/** Есть ли PostgreSQL для тестов: для describe.skipIf. */
export const PG_URL = await freshDatabase();
