import { describe, expect, it } from 'vitest';
import { describeUrl, openDb, safeMessage } from '../../src/catalog/db.ts';
import { migrate, MigrationError, readMigrations } from '../../src/catalog/migrate.ts';
import { freshDatabase, PG_URL } from './pg.ts';

describe('адрес базы в журнале', () => {
  it('без пользователя и пароля', () => {
    expect(describeUrl('postgres://threadline:s3cr%40t@db.internal:5433/threadline?sslmode=verify-full')).toBe('db.internal:5433/threadline');
    expect(describeUrl('postgres://threadline@localhost/threadline')).toBe('localhost:5432/threadline');
  });

  it('пароль вырезается из текста ошибки в обоих видах', () => {
    const url = 'postgres://threadline:p%40ss-42@db:5432/threadline';
    const text = safeMessage(new Error('password authentication failed for "threadline:p%40ss-42" p@ss-42 at postgres://threadline:p%40ss-42@db:5432/threadline'), url);
    expect(text).not.toContain('p@ss-42');
    expect(text).not.toContain('p%40ss-42');
  });

  it('адрес другого вида — ошибка без адреса', async () => {
    await expect(openDb('mysql://threadline:secret@db/threadline')).rejects.toThrow(/postgres:\/\//);
  });
});

describe('миграции на PGlite', () => {
  it('все применяются, таблица отметок удаления на месте и стирается вместе с проектом', async () => {
    const db = await openDb('pglite://memory');
    try {
      const { applied } = await migrate(db);
      expect(applied).toContain('0006_catalog_deleted.sql');
      expect(applied).toContain('0007_share_links.sql');
      expect(await db.query('select id from share_link')).toEqual([]);
      expect(await db.query('select key from service_setting')).toEqual([]);
      await expect(db.query(`insert into share_link (id, kind, project_id, env_id, from_at, to_at, expires_at) values ('x', 'other', 'p', 'e', now(), now(), now())`)).rejects.toThrow();
      await db.query("insert into catalog_project (project_id) values ('pay')");
      await db.query("insert into catalog_deleted (project_id, kind, seed_key) values ('pay', 'error', 'k')");
      await db.query("insert into catalog_deleted (project_id, kind, seed_key) values ('pay', 'error', 'k') on conflict do nothing");
      expect(await db.query('select seed_key from catalog_deleted')).toEqual([{ seed_key: 'k' }]);
      await db.query("delete from catalog_project where project_id = 'pay'");
      expect(await db.query('select seed_key from catalog_deleted')).toEqual([]);
      expect((await migrate(db)).applied).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it('прежняя сумма миграции с другими комментариями принимается, правка её SQL — нет', { timeout: 20_000 }, async () => {
    const db = await openDb('pglite://memory');
    try {
      await migrate(db);
      await db.query("update threadline_migrations set checksum = '8a625dff5c95f19b3bb80f2ce9da6cdd50cf2b152b4a23d164408f907c1d5ef3' where name = '0001_catalog.sql'");
      expect((await migrate(db)).applied).toEqual([]);
      const list = await readMigrations();
      const edited = list.map((m) => (m.name === '0001_catalog.sql' ? { ...m, sql: `${m.sql}\nselect 1;\n` } : m));
      const err = await migrate(db, edited).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MigrationError);
      expect((err as MigrationError).migration).toBe('0001_catalog.sql');
    } finally {
      await db.close();
    }
  });

  it('схема есть, а таблицы учёта нет: первая миграция падает и откатывается, данные на месте', async () => {
    const db = await openDb('pglite://memory');
    try {
      await migrate(db);
      await db.query("insert into catalog_project (project_id) values ('pay')");
      await db.query('drop table threadline_migrations');
      const err = await migrate(db).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MigrationError);
      expect((err as MigrationError).migration).toBe('0001_catalog.sql');
      expect(await db.query('select project_id from catalog_project')).toEqual([{ project_id: 'pay' }]);
      expect(await db.query('select name from threadline_migrations')).toEqual([]);
    } finally {
      await db.close();
    }
  });
});

describe.skipIf(!PG_URL)('подключение к PostgreSQL', () => {
  it('ошибка подключения с паролем в адресе не содержит пароля', async () => {
    const u = new URL(PG_URL!);
    u.password = 'wrong-Pa55word-xyz';
    const db = await openDb(u.toString());
    try {
      const e = await db.query('select 1').then(
        () => null,
        (x: unknown) => x as Error,
      );
      expect(e).toBeInstanceOf(Error);
      expect(e!.message).not.toContain('wrong-Pa55word-xyz');
    } finally {
      await db.close();
    }
  });
});

describe.skipIf(!PG_URL)('миграции', () => {
  const open = async () => openDb((await freshDatabase({ empty: true }))!);

  it('пустая база → все миграции, повтор ничего не делает', async () => {
    const db = await open();
    try {
      const files = await readMigrations();
      expect((await migrate(db)).applied).toEqual(files.map((f) => f.name));
      expect((await migrate(db)).applied).toEqual([]);
      const tables = await db.query<{ t: string }>("select table_name as t from information_schema.tables where table_schema = 'public' order by 1");
      expect(tables.map((r) => r.t)).toEqual(expect.arrayContaining(['catalog_project', 'catalog_system', 'catalog_method', 'catalog_error', 'catalog_id_type', 'catalog_outcome_rule', 'catalog_unknown', 'threadline_migrations']));
    } finally {
      await db.close();
    }
  });

  it('изменённая применённая миграция — ошибка с именем', async () => {
    const db = await open();
    try {
      await migrate(db, [{ name: '0001_a.sql', sql: 'create table a (x int)' }]);
      await expect(migrate(db, [{ name: '0001_a.sql', sql: 'create table a (x bigint)' }])).rejects.toThrow(/изменена уже применённая миграция 0001_a\.sql/);
    } finally {
      await db.close();
    }
  });

  it('миграция есть в базе, а файла нет', async () => {
    const db = await open();
    try {
      await migrate(db, [{ name: '0001_a.sql', sql: 'create table a (x int)' }]);
      await expect(migrate(db, [])).rejects.toThrow(/есть в базе, но файл не найден/);
    } finally {
      await db.close();
    }
  });

  it('упавшая миграция откатывается целиком', async () => {
    const db = await open();
    try {
      const err = await migrate(db, [{ name: '0001_bad.sql', sql: 'create table b (x int); select * from no_such_table;' }]).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MigrationError);
      expect((err as MigrationError).migration).toBe('0001_bad.sql');
      const left = await db.query("select 1 from information_schema.tables where table_name = 'b'");
      expect(left).toHaveLength(0);
      expect(await db.query('select name from threadline_migrations')).toHaveLength(0);
    } finally {
      await db.close();
    }
  });

  it('две копии сервера применяют миграцию один раз', async () => {
    const url = (await freshDatabase({ empty: true }))!;
    const [a, b] = [await openDb(url), await openDb(url)];
    try {
      const list = [{ name: '0001_slow.sql', sql: 'select pg_sleep(0.3); create table once (x int);' }];
      const [ra, rb] = await Promise.all([migrate(a, list), migrate(b, list)]);
      expect([...ra.applied, ...rb.applied]).toEqual(['0001_slow.sql']);
    } finally {
      await a.close();
      await b.close();
    }
  });
});
