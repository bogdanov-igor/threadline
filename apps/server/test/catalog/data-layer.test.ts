// Слой данных справочника: обрыв во взятом соединении, строка, которую база не примет,
// импорт оператора и начальный набор, ошибка базы при сверке проектов, занятая блокировка, чтение справочника одним снимком.
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { exchange } from '../../../../packages/core/src/catalog/test-catalog.ts';
import { UnknownCollector } from '../../src/catalog/collector.ts';
import { DbError, isBusyError, isConnectionError, openDb, type Db, type Queryable } from '../../src/catalog/db.ts';
import { importCatalog, parseCatalogText } from '../../src/catalog/exchange.ts';
import { CatalogBusy, CatalogService, CatalogUnavailable } from '../../src/catalog/service.ts';
import * as store from '../../src/catalog/store.ts';
import { Backends } from '../../src/backends/registry.ts';
import { ProjectsService } from '../../src/projects/service.ts';
import { compileProjectProfiles } from '../../src/search/profiles.ts';
import { configFile, configYaml } from '../projects/harness.ts';
import { CATALOG_YAML, service, tempConfig, type Logs } from './fixture.ts';
import { freshDatabase, PG_URL } from './pg.ts';

const T0 = Date.UTC(2026, 10, 2, 9, 0, 0);

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

// ---------- 1. Обрыв во взятом соединении ----------

type DropMode = 'between' | 'active';

/** Ложный PostgreSQL: вход без пароля, простые запросы. between — рвёт соединение после begin, active — на запросе select 1. */
async function fakePg(mode: DropMode): Promise<{ url: string; close: () => Promise<void> }> {
  const msg = (type: string, body: Buffer) => {
    const h = Buffer.alloc(5);
    h.write(type, 0);
    h.writeInt32BE(body.length + 4, 1);
    return Buffer.concat([h, body]);
  };
  const ready = (s: string) => msg('Z', Buffer.from(s));
  const sockets = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    let started = false;
    let buf = Buffer.alloc(0);
    sock.on('error', () => undefined);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!started) {
        if (buf.length < 4 || buf.length < buf.readInt32BE(0)) return;
        buf = buf.subarray(buf.readInt32BE(0));
        started = true;
        sock.write(Buffer.concat([msg('R', Buffer.alloc(4)), ready('I')]));
      }
      while (buf.length >= 5) {
        const type = String.fromCharCode(buf[0]!);
        const len = buf.readInt32BE(1);
        if (buf.length < len + 1) return;
        const sql = buf.subarray(5, len + 1).toString('utf8').replace(/\0$/, '');
        buf = buf.subarray(len + 1);
        if (type === 'X') return void sock.end();
        if (type !== 'Q') continue;
        if (mode === 'active' && sql === 'select 1') return void sock.destroy();
        sock.write(Buffer.concat([msg('C', Buffer.from(`${(sql.split(' ')[0] ?? '').toUpperCase()}\0`)), ready(sql === 'begin' ? 'T' : 'I')]));
        if (mode === 'between' && sql === 'begin') setTimeout(() => sock.destroy(), 30);
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  return {
    url: `postgres://threadline:secret-pass@127.0.0.1:${port}/db`,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

describe('обрыв базы во взятом соединении', () => {
  it.each(['between', 'active'] as const)('%s: транзакция отклонена ошибкой соединения, процесс жив, пароля в тексте нет', async (mode) => {
    const fake = await fakePg(mode);
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown) => uncaught.push(e);
    process.on('uncaughtException', onUncaught);
    const warns: string[] = [];
    const db = await openDb(fake.url, { warn: (m) => warns.push(m) });
    closers.push(async () => {
      process.off('uncaughtException', onUncaught);
      await db.close();
      await fake.close();
    });
    const err = await db
      .tx(async (q) => {
        // Работа между командами: diffCatalog считает разницу, пока соединение взято.
        await new Promise((r) => setTimeout(r, 120));
        await q.query('select 1');
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    await new Promise((r) => setTimeout(r, 50));
    expect(uncaught).toEqual([]);
    expect(err).toBeInstanceOf(DbError);
    // Без SQLSTATE: маршрут ответит 503 catalog-unavailable, справочник перейдёт в stale.
    expect(isConnectionError(err as DbError)).toBe(true);
    expect((err as DbError).message).not.toContain('secret-pass');
  });
});

// ---------- 2. «Неизвестное»: строка, которую база не примет ----------

/** Ответ с ошибкой без правила: своя строка «Неизвестного» на каждый текст. */
const failure = (cid: string, message: string) =>
  exchange(T0, 'https://processor.pay.example:8443/a', { status: 200, resp: { status: 'error', error: { code: 78, message } } }).map((r) => ({ ...r, correlationId: cid }));

describe('«Неизвестное»: ошибка данных не отравляет сброс', () => {
  async function ready(logs?: Logs): Promise<CatalogService> {
    const { config } = await tempConfig({ catalog: CATALOG_YAML });
    const s = service(config, 'pglite://memory', logs);
    closers.push(() => s.close());
    await s.start();
    return s;
  }
  const texts = async (db: Queryable) => (await db.query<{ text: string | null }>("select text from catalog_unknown where kind = 'error' order by text")).map((r) => r.text);

  it('символ 0 в тексте ответа: строка записана без него, пакет с хорошей строкой сохранён', async () => {
    const s = await ready();
    const warns: string[] = [];
    const c = new UnknownCollector(s, { warn: (m) => warns.push(m) });
    c.observe('pay', 'demo', false, 'cid-good', failure('cid-good', 'normal failure'));
    c.observe('pay', 'demo', false, 'cid-bad', failure('cid-bad', 'CARD NOT FOUND\u0000\u0000\u0000'));
    await c.flush();
    expect(c.pending).toBe(0);
    expect(await texts(s.readDb()!)).toEqual(['CARD NOT FOUND', 'normal failure']);
    expect(warns).toEqual([]);
  });

  it('строка, которую база отклонила: остальные сохранены, она отброшена с записью в журнал без значений и не повторяется', async () => {
    const s = await ready();
    const warns: string[] = [];
    const c = new UnknownCollector(s, { warn: (m) => warns.push(m) });
    // Идентификатор запроса из лога с символом 0: пример строки база не примет.
    c.observe('pay', 'demo', false, 'cid-1', failure('cid-1', 'first'));
    c.observe('pay', 'demo', false, 'cid\u0000bad', failure('cid\u0000bad', 'second'));
    c.observe('pay', 'demo', false, 'cid-3', failure('cid-3', 'third'));
    // Три ошибки и неописанный метод системы.
    expect(c.pending).toBe(4);
    await c.flush();
    expect(c.pending).toBe(0);
    expect(await texts(s.readDb()!)).toEqual(['first', 'third']);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('отклонила записей: 1 (коды 22021)');
    expect(warns[0]).not.toContain('cid');
    // Следующий сброс ничего не повторяет, новые записи принимаются.
    await c.flush();
    c.observe('pay', 'demo', false, 'cid-4', failure('cid-4', 'fourth'));
    await c.flush();
    expect(warns).toHaveLength(1);
    expect(await texts(s.readDb()!)).toEqual(['first', 'fourth', 'third']);
  });

  it('обрыв во время записи по одной: незаписанные строки возвращаются в агрегат', async () => {
    const s = await ready();
    const real = s.readDb()!;
    let calls = 0;
    // Первый вызов — пакет с ошибкой данных, второй — первая строка, третий — обрыв.
    const flaky = {
      ...real,
      query: async (sql: string, params?: readonly unknown[]) => {
        if (!sql.includes('insert into catalog_unknown')) return real.query(sql, params);
        calls++;
        if (calls === 1) throw new DbError('invalid byte sequence', '22021');
        if (calls === 3) throw new DbError('Connection terminated unexpectedly');
        return real.query(sql, params);
      },
    } as Db;
    const view = { enabled: true, resolver: (p: string) => s.resolver(p), state: () => s.state(), readDb: () => flaky } as unknown as CatalogService;
    const c = new UnknownCollector(view);
    for (const t of ['a1', 'a2', 'a3']) c.observe('pay', 'demo', false, `cid-${t}`, failure(`cid-${t}`, t));
    const total = c.pending;
    await c.flush();
    // Первая строка записана, на второй связь оборвалась: она и следующие ждут следующего сброса.
    expect(c.pending).toBe(total - 1);
    expect((await real.query('select 1 from catalog_unknown')).length).toBe(1);
  });
});

// ---------- 3. Импорт оператора и начальный набор ----------

const REAL_HOST = 'processor.corp.internal:8443';
const withHost = (yaml: string) => yaml.replace('processor.pay.example:8443', REAL_HOST);

describe('справочник, загруженный командой, начальный набор не переписывает', () => {
  /** Одна база PGlite на несколько запусков сервиса: close у сервиса её не закрывает. */
  async function shared(): Promise<{ db: Db; start: (seed: string) => Promise<Logs> }> {
    const db = await openDb('pglite://memory');
    closers.push(() => db.close());
    const keep = { ...db, close: async () => undefined } as Db;
    const { dir } = await tempConfig();
    const { writeFile, mkdir } = await import('node:fs/promises');
    const { join } = await import('node:path');
    await mkdir(join(dir, 'catalog'), { recursive: true });
    const file = join(dir, 'catalog', 'pay.yaml');
    return {
      db,
      start: async (seed: string) => {
        await writeFile(file, seed);
        const logs: Logs = { info: [], warn: [] };
        const svc = new CatalogService({ url: 'pglite://memory', projects: [{ id: 'pay', name: 'Demo Pay', seedFile: file }], log: { info: (m) => logs.info.push(m), warn: (m) => logs.warn.push(m) }, open: async () => keep });
        await svc.start();
        expect(svc.state().state).toBe('ok');
        await svc.close();
        return logs;
      },
    };
  }
  const hosts = async (db: Db) => (await store.loadSnapshot(db, 'pay')).systems.flatMap((x) => x.hosts);
  const importText = async (db: Db, text: string, opts: { dryRun?: boolean } = {}) => {
    const p = parseCatalogText(text);
    if (!p.ok) throw new Error('файл не разобран');
    return importCatalog(db, 'pay', 'Demo Pay', p.value, { dryRun: opts.dryRun ?? false, force: false });
  };

  it('новая база получает набор; после импорта командой новый набор (даже правка комментария) не применяется, журнал это называет', async () => {
    const { db, start } = await shared();
    await start(CATALOG_YAML);
    expect(await hosts(db)).toContain('processor.pay.example:8443');
    // Проверка без записи проект оператору не передаёт.
    await importText(db, withHost(CATALOG_YAML), { dryRun: true });
    expect(await store.seedHash(db, 'pay')).not.toBe(store.OPERATOR_SEED);
    const r = await importText(db, withHost(CATALOG_YAML));
    expect(r.applied).toBe(true);
    expect(await store.seedHash(db, 'pay')).toBe(store.OPERATOR_SEED);
    const same = await start(CATALOG_YAML);
    expect(same.info.join('\n')).toContain('начальный набор pay не применяется');
    const logs = await start(`${CATALOG_YAML}\n# новый выпуск\n`);
    expect(await hosts(db)).toContain(REAL_HOST);
    expect(await hosts(db)).not.toContain('processor.pay.example:8443');
    expect(logs.info.join('\n')).toContain('pnpm threadline:catalog import pay');
    expect(logs.warn).toEqual([]);
  });

  it('файл с ошибкой проект оператору не передаёт: набор применяется как раньше', async () => {
    const { db, start } = await shared();
    await start(CATALOG_YAML);
    const bad = await importText(db, 'version: 1\nproject: pay\nsystems:\n  - { key: pay, name: Без вида }\n');
    expect(bad.errors.length).toBeGreaterThan(0);
    expect(await store.seedHash(db, 'pay')).not.toBe(store.OPERATOR_SEED);
    await start(withHost(CATALOG_YAML));
    expect(await hosts(db)).toContain(REAL_HOST);
  });

  it('повтор того же файла командой без изменений тоже передаёт проект оператору', async () => {
    const { db, start } = await shared();
    await start(CATALOG_YAML);
    const r = await importText(db, CATALOG_YAML);
    expect(r.applied).toBe(false);
    expect(await store.seedHash(db, 'pay')).toBe(store.OPERATOR_SEED);
  });
});

// ---------- 4. Ошибка базы при сверке проектов ----------

describe('ошибка базы при сверке проектов', () => {
  it('база только для чтения при старте: повтор с паузой, справочник сам становится ok', async () => {
    const config = await configFile(configYaml());
    const logs: string[] = [];
    const log = { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m) };
    const projects = new ProjectsService({ config, profiles: compileProjectProfiles(config.config, () => undefined), backends: new Backends(config), log });
    let readOnly = true;
    const open = async (u: string) => {
      const db = await openDb(u);
      closers.push(() => db.close());
      return { ...db, tx: <T>(fn: (q: Queryable) => Promise<T>) => db.tx(async (q) => (readOnly && (await q.query('set transaction read only')), fn(q))) } as Db;
    };
    const catalog = new CatalogService({ url: 'pglite://memory', projects: projects.catalogProjects(), log, projectsSource: projects, retryMs: 30, pollMs: 60_000, open });
    projects.attach(catalog);
    closers.push(() => catalog.close());
    await catalog.start();
    expect(catalog.state().state).toBe('connecting');
    expect(logs.join('\n')).toContain('повтор через');
    readOnly = false;
    await expect.poll(() => catalog.state().state, { timeout: 3000, interval: 20 }).toBe('ok');
    expect(projects.editable).toBe(true);
  });
});

// ---------- 6. Занятая блокировка и чтение справочника ----------

describe('занятая блокировка не выключает справочник', () => {
  /** Сервис на PGlite с переключаемым отказом транзакций: код busy — ожидание блокировки или запрос не уложились в предел. */
  async function ready(): Promise<{ svc: CatalogService; real: Db; fail: (code: string | null) => void }> {
    const real = await openDb('pglite://memory');
    closers.push(() => real.close());
    let code: string | null = null;
    const db = { ...real, close: async () => undefined, tx: <T>(fn: (q: Queryable) => Promise<T>) => (code ? Promise.reject(new DbError('canceling statement due to lock timeout', code)) : real.tx(fn)) } as Db;
    const svc = new CatalogService({ url: 'pglite://memory', projects: [{ id: 'pay', name: 'Demo Pay', seedFile: null }], log: { info: () => undefined, warn: () => undefined }, open: async () => db });
    closers.push(() => svc.close());
    await svc.start();
    return { svc, real, fail: (c) => (code = c) };
  }

  it.each(['55P03', '57014'])('%s в правке и записи: отказ только ей, состояние ok, запись открыта', async (code) => {
    const { svc, fail } = await ready();
    fail(code);
    const edit = await svc.edit('pay', async () => 1).catch((e: unknown) => e);
    const write = await svc.transaction(async () => 1).catch((e: unknown) => e);
    for (const e of [edit, write]) {
      expect(e).toBeInstanceOf(CatalogBusy);
      // Маршруты справочника, проектов и настроек отвечают на это 503, как раньше на обрыв.
      expect(e).toBeInstanceOf(CatalogUnavailable);
    }
    expect(svc.state()).toMatchObject({ state: 'ok', message: null });
    fail(null);
    expect(await svc.edit('pay', async () => 2)).toBe(2);
  });

  it('обрыв в правке по-прежнему переводит справочник в stale', async () => {
    const { svc, fail } = await ready();
    fail('08006');
    await expect(svc.edit('pay', async () => 1)).rejects.not.toBeInstanceOf(CatalogBusy);
    expect(svc.state().state).toBe('stale');
  });

  it('блокировка проекта ставит предел ожидания в той же транзакции', async () => {
    const seen: string[] = [];
    const q = { query: async (sql: string) => (seen.push(sql), []), exec: async (sql: string) => void seen.push(sql) } as unknown as Queryable;
    await store.lockProject(q, 'pay');
    expect(seen).toEqual(["set local lock_timeout = '4s'", 'select pg_advisory_xact_lock($1, hashtext($2))']);
  });

  it('импорт, упёршийся в блокировку: не «записи конфликтуют», а ошибка занятости для ответа 503', async () => {
    const real = await openDb('pglite://memory');
    closers.push(() => real.close());
    const busy = { ...real, tx: () => Promise.reject(new DbError('lock timeout', '55P03')) } as unknown as Db;
    const p = parseCatalogText(CATALOG_YAML);
    if (!p.ok) throw new Error('файл не разобран');
    const err = await importCatalog(busy, 'pay', 'Demo Pay', p.value, { dryRun: false, force: false }).catch((e: unknown) => e);
    expect(isBusyError(err)).toBe(true);
  });
});

describe('чтение справочника одним снимком', () => {
  it('шесть запросов в одной транзакции только для чтения с повторяемым чтением', async () => {
    const base = await openDb('pglite://memory');
    closers.push(() => base.close());
    const inTx: string[] = [];
    const record = (q: Queryable): Queryable => ({ query: (sql, p) => (inTx.push(sql), q.query(sql, p)), exec: (sql) => (inTx.push(sql), q.exec(sql)) }) as Queryable;
    const db = { ...base, close: async () => undefined, tx: <T>(fn: (q: Queryable) => Promise<T>) => base.tx((q) => fn(record(q))) } as Db;
    const svc = new CatalogService({ url: 'pglite://memory', projects: [{ id: 'pay', name: 'Demo Pay', seedFile: null }], log: { info: () => undefined, warn: () => undefined }, open: async () => db });
    closers.push(() => svc.close());
    await svc.start();
    inTx.length = 0;
    await svc.afterChange('pay');
    expect(inTx[0]).toBe('set transaction isolation level repeatable read, read only');
    expect(inTx.filter((s) => /from catalog_/.test(s) && s.startsWith('select')).length).toBeGreaterThanOrEqual(6);
  });

  it('раньше начатое чтение, закончившееся позже, не возвращает старую версию; проект, созданный заново, загружается', async () => {
    const base = await openDb('pglite://memory');
    closers.push(() => base.close());
    let hold: Promise<void> | null = null;
    const db = {
      ...base,
      close: async () => undefined,
      tx: async <T>(fn: (q: Queryable) => Promise<T>) => {
        const gate = hold;
        hold = null;
        const out = await base.tx(fn);
        if (gate) await gate;
        return out;
      },
    } as Db;
    const svc = new CatalogService({ url: 'pglite://memory', projects: [{ id: 'pay', name: 'Demo Pay', seedFile: null }], log: { info: () => undefined, warn: () => undefined }, open: async () => db });
    closers.push(() => svc.close());
    await svc.start();
    const v1 = svc.snapshot('pay')!.version;
    let release!: () => void;
    hold = new Promise<void>((r) => (release = r));
    // Чтение A прочитало v1 и задержалось.
    const slow = svc.afterChange('pay');
    await new Promise((r) => setTimeout(r, 20));
    await store.bumpVersion(base, 'pay');
    // Чтение B началось позже и прочитало v1 + 1.
    await svc.afterChange('pay');
    expect(svc.snapshot('pay')!.version).toBe(v1 + 1);
    release();
    await slow;
    expect(svc.snapshot('pay')!.version).toBe(v1 + 1);
    // Проект удалён и создан заново другой копией: версия снова маленькая, позднее чтение её принимает.
    await base.query('delete from catalog_project where project_id = $1', ['pay']);
    await base.tx(async (q) => store.ensureProject(q, 'pay', 'Demo Pay'));
    const fresh = (await store.versions(base)).get('pay')!;
    expect(fresh).toBeLessThan(v1 + 1);
    await svc.afterChange('pay');
    expect(svc.snapshot('pay')!.version).toBe(fresh);
  });
});

describe.skipIf(!PG_URL)('настоящий PostgreSQL: ожидание блокировки', () => {
  it('долгая правка в другом соединении: ожидание кончается кодом блокировки, справочник остаётся ok', async () => {
    const url = (await freshDatabase())!;
    const { config } = await tempConfig({ catalog: CATALOG_YAML });
    const svc = service(config, url);
    closers.push(() => svc.close());
    await svc.start();
    expect(svc.state().state).toBe('ok');
    // Импорт в другой копии держит блокировку проекта дольше предела ожидания.
    const other = new pg.Client({ connectionString: url });
    await other.connect();
    closers.push(() => other.end());
    await other.query('begin');
    await other.query('select pg_advisory_xact_lock($1, hashtext($2))', [store.EDIT_LOCK_NS, 'pay']);
    // Ожидание кончается кодом блокировки (55P03), а не пределом запроса через 5 секунд (57014).
    const started = Date.now();
    const raw = await svc.db().tx((q) => store.lockProject(q, 'pay')).catch((e: unknown) => e);
    expect(Date.now() - started).toBeGreaterThanOrEqual(3500);
    expect((raw as DbError).pgCode).toBe('55P03');
    const err = await svc.edit('pay', async () => 1).catch((e: unknown) => e);
    await other.query('rollback');
    expect(err).toBeInstanceOf(CatalogBusy);
    expect(svc.state()).toMatchObject({ state: 'ok', message: null });
    expect(await svc.edit('pay', async () => 2)).toBe(2);
  }, 30_000);
});

