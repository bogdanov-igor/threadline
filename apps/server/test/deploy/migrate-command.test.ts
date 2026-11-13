// Команда миграций и сервер, который схему не меняет.
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/catalog/db.ts';
import { pendingMigrations, migrate, MigrationError, readMigrations } from '../../src/catalog/migrate.ts';
import { runMigrate } from '../../src/catalog/migrate-run.ts';
import { CatalogService, createCatalogService } from '../../src/catalog/service.ts';
import { databaseCheck } from '../../src/health.ts';
import { freshDatabase, PG_URL } from '../catalog/pg.ts';

type Level = 'info' | 'warn' | 'error' | 'fatal';
const collect = () => {
  const out: { level: Level; message: string }[] = [];
  return { out, log: (level: Level, message: string) => void out.push({ level, message }) };
};

describe('команда без базы', () => {
  it('адрес не задан: код 2, сообщение называет переменную', async () => {
    const { out, log } = collect();
    expect(await runMigrate({ env: {}, log })).toBe(2);
    expect(out[0]!.level).toBe('fatal');
    expect(out[0]!.message).toContain('THREADLINE_DATABASE_URL');
  });

  it('база не отвечает: повторы с нарастающей паузой, затем код 2, пароля в сообщениях нет', { timeout: 30_000 }, async () => {
    const { out, log } = collect();
    const pauses: number[] = [];
    const code = await runMigrate({
      env: { THREADLINE_DATABASE_URL: 'postgres://threadline:Top-Secret-9@127.0.0.1:1/threadline' },
      log,
      // Подключение идёт дольше под нагрузкой: предел с запасом, а паузы короткие, настоящих секунд тест не ждёт.
      waitMs: 3000,
      pause: async (ms) => {
        pauses.push(ms);
        await new Promise((done) => setTimeout(done, 300));
      },
    });
    expect(code).toBe(2);
    expect(pauses.slice(0, 2)).toEqual([1000, 2000]);
    expect(out.map((o) => o.message).join('\n')).not.toContain('Top-Secret-9');
    expect(out.at(-1)!.level).toBe('fatal');
  });
});

describe.skipIf(!PG_URL)('команда на PostgreSQL', () => {
  it('пустая база: все миграции, код 0, повтор ничего не делает', async () => {
    const url = (await freshDatabase({ empty: true }))!;
    const { out, log } = collect();
    expect(await runMigrate({ env: { THREADLINE_DATABASE_URL: url }, log })).toBe(0);
    expect(out[0]!.message).toContain('0001_catalog.sql');
    expect(await runMigrate({ env: { THREADLINE_DATABASE_URL: url }, log })).toBe(0);
    expect(out[1]!.message).toContain('применять нечего');
    expect(out.map((o) => o.message).join('\n')).not.toContain('postgres://');
  });

  it('два запуска вместе: оба код 0, каждая миграция применена один раз', async () => {
    const url = (await freshDatabase({ empty: true }))!;
    const a = collect();
    const b = collect();
    const codes = await Promise.all([runMigrate({ env: { THREADLINE_DATABASE_URL: url }, log: a.log }), runMigrate({ env: { THREADLINE_DATABASE_URL: url }, log: b.log })]);
    expect(codes).toEqual([0, 0]);
    expect([a.out[0]!.message, b.out[0]!.message].filter((m) => m.includes('применять нечего'))).toHaveLength(1);
    const db = await openDb(url);
    try {
      const names = (await db.query<{ name: string }>('select name from threadline_migrations')).map((r) => r.name);
      expect(names).toHaveLength((await readMigrations()).length);
    } finally {
      await db.close();
    }
  });

  it('изменённая применённая миграция: код 1, сообщение называет её', async () => {
    const url = (await freshDatabase())!;
    const db = await openDb(url);
    await db.query("update threadline_migrations set checksum = 'другая' where name = '0001_catalog.sql'");
    await db.close();
    const { out, log } = collect();
    expect(await runMigrate({ env: { THREADLINE_DATABASE_URL: url }, log })).toBe(1);
    expect(out[0]!.message).toContain('0001_catalog.sql');
  });

  it('пул команды без пределов на запрос: долгое ожидание не обрывается', async () => {
    const url = (await freshDatabase())!;
    const db = await openDb(url, { noQueryLimits: true });
    try {
      expect(await db.query<{ v: string }>('show statement_timeout').then((r) => r[0] as unknown as { statement_timeout: string })).toEqual({ statement_timeout: '0' });
    } finally {
      await db.close();
    }
  });
});

describe.skipIf(!PG_URL)('сервер и схема', () => {
  const service = (url: string, warn: string[]) =>
    new CatalogService({ url, projects: [], log: { info: () => undefined, warn: (m) => warn.push(m) }, retryMs: 50 });

  it('пустая база: схема не меняется, журнал называет команду, готовности нет; команда выполнена: сервер сам готов', async () => {
    const url = (await freshDatabase({ empty: true }))!;
    const warn: string[] = [];
    const svc = service(url, warn);
    const check = databaseCheck(svc);
    await svc.start();
    expect(svc.state().state).toBe('error');
    expect(svc.state().message).toContain('threadline:migrate');
    expect(warn.join('\n')).toContain('apps/server/src/cli/migrate.ts');
    expect(await check()).toBe('error');
    const db = await openDb(url);
    try {
      expect(await db.query("select 1 from information_schema.tables where table_schema = 'public'")).toEqual([]);
      await migrate(db);
      await expect.poll(() => svc.state().state, { timeout: 3000, interval: 20 }).toBe('ok');
      expect(await check()).toBe('ok');
    } finally {
      await db.close();
      await svc.close();
    }
  });

  it('новая миграция не применена: отстала; применена: нет', async () => {
    const url = (await freshDatabase())!;
    const db = await openDb(url);
    try {
      const list = [...(await readMigrations()), { name: '9999_new.sql', sql: 'select 1' }];
      expect(await pendingMigrations(db, list)).toEqual(['9999_new.sql']);
      await migrate(db, list);
      expect(await pendingMigrations(db, list)).toEqual([]);
      await expect(pendingMigrations(db, list.map((m) => (m.name === '9999_new.sql' ? { ...m, sql: 'select 2' } : m)))).rejects.toBeInstanceOf(MigrationError);
      await expect(pendingMigrations(db, list.slice(0, -1))).rejects.toThrow(/есть в базе, но файл не найден/);
    } finally {
      await db.close();
    }
  });
});

describe('повтор подключения и PGlite', () => {
  it('база не отвечает: пауза растёт и журнал её называет', async () => {
    const warn: string[] = [];
    let opens = 0;
    const svc = new CatalogService({
      url: 'postgres://x@127.0.0.1:1/x',
      projects: [],
      log: { info: () => undefined, warn: (m) => warn.push(m) },
      open: async () => {
        opens++;
        return { query: async () => Promise.reject(new Error('нет связи')), close: async () => undefined } as never;
      },
    });
    await svc.start();
    expect(svc.state().state).toBe('connecting');
    expect(warn[0]).toContain('повтор через 1 с');
    await expect.poll(() => warn.length, { timeout: 3000, interval: 50 }).toBeGreaterThan(1);
    expect(warn[1]).toContain('повтор через 2 с');
    expect(opens).toBe(1);
    await svc.close();
  });

  it('PGlite в памяти ставит схему сам', { timeout: 30_000 }, async () => {
    const svc = createCatalogService({ path: '/нет/threadline.yaml', config: { projects: {} } }, 'pglite://memory', { info: () => undefined, warn: () => undefined });
    await svc.start();
    try {
      expect(svc.state().state).toBe('ok');
    } finally {
      await svc.close();
    }
  });
});
