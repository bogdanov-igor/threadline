// Найденные проверкой отказы справочника на настоящей базе: «Неизвестное» в таблице без значений, импорт при правленом
// пути метода, инварианты автора и типов, HTTP ниже 400, база недоступна, стенд примера, уборка после импорта командой.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { parse } from 'yaml';
import type { ImportReport, SystemRow, UnknownPage } from '@threadline/core/catalog';
import type { ParsedRecord } from '@threadline/core/search';
import { buildApp } from '../../src/app.ts';
import { Backends } from '../../src/backends/registry.ts';
import { runCatalogCli } from '../../src/catalog/cli-run.ts';
import { UnknownCollector } from '../../src/catalog/collector.ts';
import { DbError, isConnectionError, openDb, type Db } from '../../src/catalog/db.ts';
import { ExportBlocked, exportCatalogText, importCatalog, parseCatalogText } from '../../src/catalog/exchange.ts';
import { migrate, MigrationError } from '../../src/catalog/migrate.ts';
import { CatalogService } from '../../src/catalog/service.ts';
import * as store from '../../src/catalog/store.ts';
import { CATALOG_YAML, service, tempConfig, type Logs } from './fixture.ts';
import { freshDatabase, PG_URL } from './pg.ts';

const PAN = '4111111234557893';
const SECRET = 'SYNTHSECRET0123456789';
const T0 = Date.UTC(2026, 10, 2, 9, 0, 0);

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

let seq = 0;
function rec(p: Partial<ParsedRecord> & Pick<ParsedRecord, 'kind' | 'timeMs'>): ParsedRecord {
  seq++;
  return {
    tsNs: `${p.timeMs}000000`,
    labels: {},
    line: `line ${seq}`,
    message: '',
    level: 'INFO',
    levelNum: 200,
    correlationId: 'cid-regress',
    requestId: null,
    method: null,
    uri: null,
    status: null,
    headers: null,
    body: null,
    payload: null,
    action: null,
    context: null,
    component: 'api',
    gateway: false,
    ...p,
  };
}

const exchange = (uri: string, status: number, resp: unknown, req?: unknown): ParsedRecord[] => [
  rec({ kind: 'send', timeMs: T0, method: 'POST', uri, body: req === undefined ? null : JSON.stringify(req) }),
  rec({ kind: 'response', timeMs: T0 + 10, method: 'POST', uri, status, body: JSON.stringify(resp) }),
];

async function setup(catalog: string | undefined = CATALOG_YAML, logs?: Logs): Promise<{ app: FastifyInstance; svc: CatalogService; url: string; dir: string; collector: UnknownCollector }> {
  const { config, dir } = await tempConfig(catalog === undefined ? {} : { catalog });
  const url = (await freshDatabase())!;
  const svc = service(config, url, logs);
  await svc.start();
  const collector = new UnknownCollector(svc);
  const app = await buildApp({ config, backends: new Backends(config), catalog: svc, collector });
  closers.push(async () => {
    await app.close();
    await svc.close();
  });
  return { app, svc, url, dir, collector };
}

const put = (app: FastifyInstance, section: string, id: number, payload: object) => app.inject({ method: 'PUT', url: `/api/projects/pay/catalog/${section}/${id}`, payload });
const post = (app: FastifyInstance, section: string, payload: object) => app.inject({ method: 'POST', url: `/api/projects/pay/catalog/${section}`, payload });
const importFile = async (app: FastifyInstance, text: string, qs = '') => {
  // Применение несёт версию, с которой открыт текст. База закрыта и версии нет: параметр всё равно верного вида.
  const version = ((await app.inject('/api/projects/pay/file-version')).json() as { version?: string }).version ?? '0|-|-';
  const sep = qs ? '&' : '?';
  return app.inject({ method: 'POST', url: `/api/projects/pay/catalog/import${qs}${qs.includes('dryRun') ? '' : `${sep}baseVersion=${encodeURIComponent(version)}`}`, payload: text, headers: { 'content-type': 'application/yaml' } });
};
const codeOf = (r: { json: () => unknown }) => (r.json() as { error: { code: string } }).error.code;

describe.skipIf(!PG_URL)('«Неизвестное» в таблице без значений', () => {
  it('строки читаются прямо из таблицы: путь, код, действие и хост маскированы', async () => {
    const { svc, collector } = await setup();
    const uri = (p: string) => `http://switch.pay.example:11101${p}`;
    collector.observe('pay', 'demo', false, 'c1', exchange(uri(`/v1/card/4111-1112-3455-7893/info`), 200, {}));
    collector.observe('pay', 'demo', false, 'c2', exchange(uri(`/v1/card/${PAN}.json`), 200, {}));
    collector.observe('pay', 'demo', false, 'c3', exchange(uri(`/v1/card/pan_${PAN}/info`), 200, {}));
    collector.observe('pay', 'demo', false, 'c4', exchange(uri('/reset/password=abc123/x'), 200, {}));
    collector.observe('pay', 'demo', false, 'c5', exchange(uri(`/v2/card/${PAN}`), 200, { error: { code: PAN, message: `card ${PAN}` } }, { jsonrpc: '2.0', method: `card.get ${PAN}` }));
    collector.observe('pay', 'demo', false, 'c6', exchange(uri('/v2/obj'), 200, { error: { code: { password: SECRET, pan: PAN }, message: 'boom' } }));
    collector.observe('pay', 'demo', false, 'c7', [
      rec({ kind: 'incoming', timeMs: T0, method: 'POST', uri: '/v1/users' }),
      rec({ kind: 'log', timeMs: T0 + 1, level: 'ERROR', levelNum: 400, message: `failed ${PAN}`, context: { code: PAN } }),
    ]);
    await collector.flush();
    const rows = await svc.readDb()!.query<Record<string, unknown>>('select path, code, rpc, host, text, key from catalog_unknown');
    expect(rows.length).toBeGreaterThan(5);
    const all = JSON.stringify(rows);
    for (const value of [PAN, SECRET, '4111-1112-3455-7893', 'abc123', PAN.slice(0, 8)]) expect(all).not.toContain(value);
    expect(rows.map((r) => r.path)).toEqual(expect.arrayContaining(['/v1/card/{id}/info', '/v1/card/{id}', '/reset/{id}/x']));
    expect(rows.some((r) => typeof r.code === 'string' && r.code.includes('{'))).toBe(false);
  });

  it('стенд примера сохраняется и уходит в ответ API', async () => {
    const { app, collector } = await setup();
    collector.observe('pay', 'demo', false, 'c1', exchange('http://switch.pay.example:11101/v9/new', 200, {}), '92');
    await collector.flush();
    const page = (await app.inject('/api/projects/pay/catalog/unknown')).json() as UnknownPage;
    expect(page.items[0]).toMatchObject({ stand: '92', exampleCid: 'c1' });
  });
});

describe.skipIf(!PG_URL)('импорт при правленом пути метода', () => {
  const NEW_RULE = (text: string) => {
    const f = parse(text) as { systems: { key: string; errors?: unknown[] }[] };
    f.systems.find((s) => s.key === 'pay')!.errors = [{ method: { http: 'POST', path: '/v1/cards/lookup' }, code: 'X1', title: 'Новая ошибка метода' }];
    return JSON.stringify(f);
  };

  async function edited(app: FastifyInstance) {
    const c = (await app.inject('/api/projects/pay/catalog')).json() as { methods: { id: number; systemId: number; path: string; http: string; name: string; updatedAt: string; rpc: string }[] };
    const m = c.methods.find((x) => x.path === '/v1/cards/lookup')!;
    const r = await put(app, 'methods', m.id, { systemId: m.systemId, http: m.http, path: '/v1/cards/lookup/v2', name: m.name, updatedAt: m.updatedAt });
    expect(r.statusCode, r.body).toBe(200);
    return m;
  }

  it('без --force: проверка и импорт считают одно и то же, правка метода цела, правило попало на метод', async () => {
    const { app } = await setup();
    const m = await edited(app);
    const text = NEW_RULE(CATALOG_YAML);
    const dry = await importFile(app, text, '?dryRun=1');
    expect(dry.statusCode, dry.body).toBe(200);
    const report = dry.json() as ImportReport;
    expect(report.added.map((a) => a.kind)).toEqual(['error']);
    expect(report.skipped.map((a) => a.kind)).toEqual(['method']);
    const real = await importFile(app, text);
    expect(real.statusCode, real.body).toBe(200);
    expect((real.json() as ImportReport).added.map((a) => a.kind)).toEqual(['error']);
    const after = (await app.inject('/api/projects/pay/catalog')).json() as { methods: { id: number; path: string }[]; errors: { title: string; methodId: number | null }[] };
    expect(after.methods.find((x) => x.id === m.id)!.path).toBe('/v1/cards/lookup/v2');
    expect(after.errors.find((e) => e.title === 'Новая ошибка метода')!.methodId).toBe(m.id);
    // Повтор ничего не меняет.
    const again = (await importFile(app, text)).json() as ImportReport;
    expect(again.added).toEqual([]);
  });

  it('с --force: путь возвращается из файла, правило на том же методе', async () => {
    const { app } = await setup();
    const m = await edited(app);
    const r = await importFile(app, NEW_RULE(CATALOG_YAML), '?force=1');
    expect(r.statusCode, r.body).toBe(200);
    const after = (await app.inject('/api/projects/pay/catalog')).json() as { methods: { id: number; path: string }[]; errors: { title: string; methodId: number | null }[] };
    expect(after.methods.find((x) => x.id === m.id)!.path).toBe('/v1/cards/lookup');
    expect(after.errors.find((e) => e.title === 'Новая ошибка метода')!.methodId).toBe(m.id);
  });

  it('перезапуск с новым набором: справочник работает, ошибка уходит в журнал, повторов нет', async () => {
    const logs: Logs = { info: [], warn: [] };
    const { app, svc, dir, url } = await setup(CATALOG_YAML, logs);
    await edited(app);
    await writeFile(join(dir, 'catalog', 'pay.yaml'), NEW_RULE(CATALOG_YAML));
    await svc.close();
    const { loadConfig } = await import('../../src/config/load.ts');
    const config = await loadConfig({ path: join(dir, 'threadline.yaml'), env: {} });
    const logs2: Logs = { info: [], warn: [] };
    const next = service(config, url, logs2);
    closers.push(() => next.close());
    await next.start();
    expect(next.state()).toMatchObject({ state: 'ok', message: null });
    expect(next.snapshot('pay')!.errors.some((e) => e.title === 'Новая ошибка метода')).toBe(true);
    expect(logs2.warn).toEqual([]);
  });

  it('конфликт данных при наборе не выключает справочник', async () => {
    const logs: Logs = { info: [], warn: [] };
    const { svc, url, dir } = await setup(CATALOG_YAML, logs);
    const db = svc.readDb()!;
    // Метод из редактора занимает путь, на который файл переводит запись набора.
    const snap = await store.loadSnapshot(db, 'pay');
    const author = snap.systems.find((s) => s.key === 'pay')!;
    const seeded = snap.methods.find((m) => m.path === '/v1/cards/lookup')!;
    await store.updateMethod(db, 'pay', seeded.id, author.id, { ...seeded, path: '/v1/moved' }, { edited: false, hidden: false });
    await store.insertMethod(db, 'pay', author.id, { ...seeded, path: '/v1/cards/lookup', name: 'Из редактора' }, { edited: true, hidden: false });
    await writeFile(join(dir, 'catalog', 'pay.yaml'), `${CATALOG_YAML}\n# новый набор`);
    await svc.close();
    const { loadConfig } = await import('../../src/config/load.ts');
    const config = await loadConfig({ path: join(dir, 'threadline.yaml'), env: {} });
    const logs2: Logs = { info: [], warn: [] };
    const next = service(config, url, logs2);
    closers.push(() => next.close());
    await next.start();
    expect(next.state().state).toBe('ok');
    expect(logs2.warn.join('\n')).toContain('начальный набор pay');
    expect(logs2.warn.join('\n')).not.toContain('база справочника недоступна');
  });
});

describe.skipIf(!PG_URL)('инварианты справочника', () => {
  const author = async (app: FastifyInstance) => ((await app.inject('/api/projects/pay/catalog')).json() as { systems: SystemRow[] }).systems.find((s) => s.key === 'pay')!;

  it('файл без kind и файл со скрытием автора отклонены, автор остаётся', async () => {
    const { app, svc } = await setup();
    for (const row of ['{ key: pay, name: Ломаю }', '{ key: pay, kind: project, name: Скрываю, hidden: true }']) {
      const r = await importFile(app, `version: 1\nproject: pay\nsystems:\n  - ${row}\n`);
      expect([r.statusCode, codeOf(r)]).toEqual([422, 'catalog-invalid-file']);
    }
    expect(svc.resolver('pay')!.author?.key).toBe('pay');
    expect((await author(app)).kind).toBe('project');
  });

  it('PUT: автора не скрыть', async () => {
    const { app } = await setup();
    const a = await author(app);
    const r = await put(app, 'systems', a.id, { key: a.key, kind: 'project', type: 'service', name: a.name, hosts: a.hosts, hidden: true, updatedAt: a.updatedAt });
    expect([r.statusCode, codeOf(r)]).toEqual([422, 'catalog-invalid']);
    expect((r.json() as { error: { fields: Record<string, string> } }).error.fields.hidden).toContain('нельзя скрыть');
  });

  it('файл не скрывает тип, на который ссылается метод базы', async () => {
    const { app } = await setup();
    const r = await importFile(app, `version: 1\nproject: pay\nidTypes:\n  - { key: transfer, kind: operation, name: Перевод, hidden: true }\n`);
    expect(r.statusCode).toBe(422);
    const report = (r.json() as { error: { report: ImportReport } }).error.report;
    expect(report.errors.map((e) => e.path)).toEqual(['idTypes.0.hidden']);
  });

  it('тип базы или шины не ставится системе с методами: через файл и через PUT', async () => {
    const { app } = await setup();
    const f = await importFile(app, `version: 1\nproject: pay\nsystems:\n  - { key: processor, type: database, name: База }\n`);
    expect(f.statusCode).toBe(422);
    expect((f.json() as { error: { report: ImportReport } }).error.report.errors.map((e) => e.path)).toEqual(['systems.0.type']);
    const c = (await app.inject('/api/projects/pay/catalog')).json() as { systems: SystemRow[] };
    const s = c.systems.find((x) => x.key === 'processor')!;
    const p = await put(app, 'systems', s.id, { key: s.key, type: 'queue', name: s.name, hosts: s.hosts, updatedAt: s.updatedAt });
    expect([p.statusCode, codeOf(p)]).toEqual([422, 'catalog-invalid']);
    expect((p.json() as { error: { fields: Record<string, string> } }).error.fields.type).toContain('методов');
  });

  it('ensureProject возвращает автора, сломанного старым файлом', async () => {
    const { svc } = await setup();
    const db = svc.readDb()!;
    await db.query(`update catalog_system set kind = 'external', hidden = true where project_id = 'pay' and key = 'pay'`);
    await db.tx((q) => store.ensureProject(q, 'pay', 'Demo Pay'));
    const s = await store.loadSnapshot(db, 'pay');
    expect(s.systems.find((x) => x.key === 'pay')).toMatchObject({ kind: 'project', hidden: false });
    expect(s.systems.filter((x) => x.kind === 'project')).toHaveLength(1);
  });
});

describe.skipIf(!PG_URL)('правило ошибки с HTTP ниже 400', () => {
  it('строка «Неизвестного» с HTTP 200 → правило из формы → строка ушла', async () => {
    const { app, collector } = await setup();
    collector.observe('pay', 'demo', false, 'c1', exchange('http://switch.pay.example:11101/v9/new', 200, { error: { code: 12, message: 'Boom' } }));
    await collector.flush();
    const page = (await app.inject('/api/projects/pay/catalog/unknown?kind=error')).json() as UnknownPage;
    const row = page.items[0]!;
    expect(row).toMatchObject({ httpStatus: 200, code: '12' });
    const r = await post(app, 'errors', { systemId: row.systemId, methodId: row.methodId, http: row.httpStatus, code: row.code, title: 'Код 12' });
    expect(r.statusCode, r.body).toBe(201);
    const after = (await app.inject('/api/projects/pay/catalog/unknown?kind=error')).json() as UnknownPage;
    expect(after.items).toEqual([]);
  });
});

describe.skipIf(!PG_URL)('база недоступна', () => {
  it('«Неизвестное» копится при stale и пишется после восстановления', async () => {
    const { svc, url } = await setup();
    const collector = new UnknownCollector(svc);
    collector.observe('pay', 'demo', false, 'c0', exchange('http://switch.pay.example:11101/v9/a', 200, {}));
    const down = svc.readDb()!;
    const real = down.query.bind(down);
    const spy = vi.spyOn(down, 'query').mockRejectedValue(new DbError('terminating connection', '57P01'));
    await svc.pollNow();
    expect(svc.state().state).toBe('stale');
    const before = collector.pending;
    collector.observe('pay', 'demo', false, 'c1', exchange('http://switch.pay.example:11101/v9/b', 200, {}));
    collector.observe('pay', 'demo', false, 'c2', exchange('http://switch.pay.example:11101/v9/c', 200, {}));
    collector.observe('pay', 'demo', false, 'c3', exchange('http://switch.pay.example:11101/v9/d', 200, {}));
    expect(collector.pending).toBe(before + 3);
    await collector.flush();
    expect(collector.pending).toBe(before + 3);
    spy.mockRestore();
    expect(real).toBeTypeOf('function');
    await svc.pollNow();
    expect(svc.state().state).toBe('ok');
    await collector.flush();
    expect(collector.pending).toBe(0);
    const check = await openDb(url);
    closers.push(() => check.close());
    expect(Number((await check.query<{ n: unknown }>('select count(*) as n from catalog_unknown'))[0]!.n)).toBeGreaterThanOrEqual(4);
  });

  it('ошибка соединения по имени хоста — 503, а не 500', async () => {
    const { config } = await tempConfig({ catalog: CATALOG_YAML });
    const url = (await freshDatabase())!;
    let broken = false;
    const open = async (u: string): Promise<Db> => {
      const db = await openDb(u);
      const fail = (code: string) => new DbError(`getaddrinfo ${code} db`, code);
      const wrapped: Db = {
        ...db,
        label: db.label,
        query: (sql: string, params?: readonly unknown[]) => (broken ? Promise.reject(fail('ENOTFOUND')) : db.query(sql, params)) as never,
        tx: (fn) => (broken ? Promise.reject(fail('EAI_AGAIN')) : db.tx(fn)),
        session: (fn) => db.session(fn),
        close: () => db.close(),
      };
      return wrapped;
    };
    const svc = new CatalogService({ url, projects: [{ id: 'pay', name: 'Demo Pay', seedFile: null }], log: { info: () => undefined, warn: () => undefined }, open });
    await svc.start();
    const app = await buildApp({ config, backends: new Backends(config), catalog: svc, collector: new UnknownCollector(svc) });
    closers.push(async () => {
      await app.close();
      await svc.close();
    });
    broken = true;
    const list = await app.inject('/api/projects/pay/catalog/unknown');
    expect([list.statusCode, codeOf(list)]).toEqual([503, 'catalog-unavailable']);
    const edit = await post(app, 'systems', { key: 'x-new', name: 'Новая' });
    expect([edit.statusCode, codeOf(edit)]).toEqual([503, 'catalog-unavailable']);
  });
});

describe('пока правка закрыта, сервер отвечает 503 и на выгрузку, и на загрузку', () => {
  const answers = async (svc: CatalogService) => {
    const { config } = await tempConfig({ catalog: CATALOG_YAML });
    const app = await buildApp({ config, backends: new Backends(config), catalog: svc, collector: new UnknownCollector(svc) });
    closers.push(async () => {
      await app.close();
      await svc.close();
    });
    const list = [await app.inject('/api/projects/pay/catalog/export?format=yaml'), await app.inject('/api/projects/pay/catalog/export?format=json'), await importFile(app, CATALOG_YAML, '?dryRun=1'), await importFile(app, CATALOG_YAML)];
    return list.map((r) => [r.statusCode, codeOf(r)]);
  };
  const closed = Array.from({ length: 4 }, () => [503, 'catalog-unavailable']);
  const options = (open: () => Promise<Db>) => ({ url: 'postgres://synthetic@127.0.0.1:1/x', projects: [{ id: 'pay', name: 'Demo Pay', seedFile: null }], log: { info: () => undefined, warn: () => undefined }, open });

  it('миграция не применилась', async () => {
    const db = {
      label: 'test',
      query: () => Promise.resolve([]),
      session: () => Promise.reject(new MigrationError('0001_test.sql', 'миграция 0001_test.sql не применена')),
      close: () => Promise.resolve(),
    } as unknown as Db;
    const svc = new CatalogService(options(() => Promise.resolve(db)));
    await svc.start();
    expect(svc.state().state).toBe('error');
    expect(await answers(svc)).toEqual(closed);
  });

  it('база недоступна с самого старта', async () => {
    const db = { label: 'test', query: () => Promise.reject(new DbError('connect ECONNREFUSED', 'ECONNREFUSED')), close: () => Promise.resolve() } as unknown as Db;
    const svc = new CatalogService(options(() => Promise.resolve(db)));
    await svc.start();
    expect(svc.state().state).toBe('connecting');
    expect(await answers(svc)).toEqual(closed);
  });

  it.skipIf(!PG_URL)('база пропала после загрузки', async () => {
    const url = (await freshDatabase())!;
    let down = false;
    const svc = new CatalogService({
      ...options(async () => {
        const real = await openDb(url);
        const guard = <T>(fn: () => Promise<T>) => (down ? Promise.reject(new DbError('connect ECONNREFUSED', 'ECONNREFUSED')) : fn());
        return {
          ...real,
          label: real.label,
          query: (sql: string, p?: readonly unknown[]) => guard(() => real.query(sql, p)) as never,
          tx: (fn) => guard(() => real.tx(fn)),
          session: (fn) => real.session(fn),
          close: () => real.close(),
        };
      }),
      url,
    });
    await svc.start();
    expect(svc.state().state).toBe('ok');
    down = true;
    await svc.pollNow();
    expect(svc.state().state).toBe('stale');
    expect(await answers(svc)).toEqual(closed);
  });
});

describe('какая ошибка считается ошибкой соединения', () => {
  const conn = (code: string | undefined) => isConnectionError(new DbError('x', code));
  it('системные коды и ошибки без кода — соединение, ошибки данных и программы — нет', () => {
    for (const c of ['ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'EPIPE', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', '08006', '57P01', '57P03', '57014', '53300', undefined]) expect(conn(c)).toBe(true);
    for (const c of ['23505', '22P02', '42P01', 'ERR_INVALID_ARG_TYPE']) expect(conn(c)).toBe(false);
  });
});

describe.skipIf(!PG_URL)('уборка «Неизвестного»', () => {
  it('импорт командой: опрос версии уже убирает покрытую строку', async () => {
    const { app, svc, collector, url } = await setup();
    collector.observe('pay', 'demo', false, 'c1', exchange('http://switch.pay.example:11101/v9/new', 200, {}));
    await collector.flush();
    expect(((await app.inject('/api/projects/pay/catalog/unknown')).json() as UnknownPage).total).toBe(1);
    const other = await openDb(url);
    closers.push(() => other.close());
    const f = parse(CATALOG_YAML) as { systems: { key: string; methods?: unknown[] }[] };
    f.systems.find((s) => s.key === 'switch')!.methods = [{ http: 'POST', path: '/v9/new', name: 'Новый' }];
    const r = await importCatalog(other, 'pay', 'Demo Pay', f, { dryRun: false, force: false });
    expect(r.applied).toBe(true);
    await svc.pollNow();
    expect(((await app.inject('/api/projects/pay/catalog/unknown')).json() as UnknownPage).total).toBe(0);
  });

  it('набор при старте убирает покрытую строку', async () => {
    const { dir, svc, url, collector } = await setup();
    collector.observe('pay', 'demo', false, 'c1', exchange('http://switch.pay.example:11101/v9/new', 200, {}));
    await collector.flush();
    await svc.close();
    const f = parse(CATALOG_YAML) as { systems: { key: string; methods?: unknown[] }[] };
    f.systems.find((s) => s.key === 'switch')!.methods = [{ http: 'POST', path: '/v9/new', name: 'Новый' }];
    await writeFile(join(dir, 'catalog', 'pay.yaml'), JSON.stringify(f));
    const { loadConfig } = await import('../../src/config/load.ts');
    const next = service(await loadConfig({ path: join(dir, 'threadline.yaml'), env: {} }), url);
    closers.push(() => next.close());
    await next.start();
    expect((await store.allUnknown(next.readDb()!, 'pay', 10)).length).toBe(0);
  });
});

describe.skipIf(!PG_URL)('выгрузка и записи с номером карты', () => {
  it('rpc, hosts и key с номером не проходят проверку API и импорта', async () => {
    const { app } = await setup();
    const m = await post(app, 'methods', { systemId: 1, http: 'POST', path: '/x', rpc: PAN, name: 'x' });
    expect(m.statusCode).toBe(422);
    const s = await post(app, 'systems', { key: PAN, name: 'x', hosts: [`${PAN}.pay.example`] });
    expect([s.statusCode, codeOf(s)]).toEqual([422, 'catalog-invalid']);
    const i = await importFile(app, `version: 1\nproject: pay\nidTypes:\n  - { key: a${PAN}, kind: entity, name: x }\n`);
    expect(i.statusCode).toBe(422);
    const c = JSON.stringify((await app.inject('/api/projects/pay/catalog/export?format=json')).body);
    expect(c).not.toContain(PAN);
  });

  it('старая строка с номером: выгрузка отказывает', async () => {
    const { app, svc } = await setup();
    await svc.readDb()!.query(`update catalog_method set rpc = $1 where id = (select min(id) from catalog_method)`, [PAN]);
    await expect(exportCatalogText(svc.readDb()!, 'pay', 'json')).rejects.toBeInstanceOf(ExportBlocked);
    const r = await app.inject('/api/projects/pay/catalog/export?format=json');
    expect([r.statusCode, codeOf(r)]).toEqual([422, 'catalog-invalid']);
    expect(r.body).not.toContain(PAN);
  });
});

describe.skipIf(!PG_URL)('разделы API только свои', () => {
  it('POST, PUT и DELETE на ключи прототипа — 404, версия не растёт', async () => {
    const { app, svc } = await setup();
    const before = svc.snapshot('pay')!.version;
    for (const section of ['constructor', '__proto__', 'toString']) {
      expect((await post(app, section, {})).statusCode).toBe(404);
      expect((await put(app, section, 1, {})).statusCode).toBe(404);
      expect((await app.inject({ method: 'DELETE', url: `/api/projects/pay/catalog/${section}/1?updatedAt=x` })).statusCode).toBe(404);
    }
    expect((await svc.readDb()!.query<{ version: unknown }>('select version from catalog_project'))[0]!.version).toBe(String(before));
  });
});

describe('разбор файла не цитирует содержимое', () => {
  const spill = (r: ReturnType<typeof parseCatalogText>) => JSON.stringify(r);

  it('JSON и YAML: значения в сообщении нет', () => {
    expect(spill(parseCatalogText(`x${PAN}`, 'json'))).not.toContain(PAN);
    expect(spill(parseCatalogText(`{"client_secret":${SECRET}}`, 'json'))).not.toContain(SECRET.slice(0, 8));
    expect(spill(parseCatalogText(`a: *${PAN}`, 'yaml'))).not.toContain(PAN);
    expect(spill(parseCatalogText(`version: [1\n${PAN}: x`, 'yaml'))).not.toContain(PAN);
  });

  it('предупреждение YAML не идёт в stderr процесса', async () => {
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    parseCatalogText(`password: !x ${SECRET}`, 'yaml');
    await new Promise((r) => setImmediate(r));
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it.skipIf(!PG_URL)('ответ API на файл с номером — без значения', async () => {
    const { app } = await setup();
    const r = await app.inject({ method: 'POST', url: '/api/projects/pay/catalog/import?format=json&dryRun=1', payload: `x${PAN}`, headers: { 'content-type': 'application/json' } });
    expect([r.statusCode, codeOf(r)]).toEqual([422, 'catalog-invalid-file']);
    expect(r.body).not.toContain(PAN);
  });
});

describe.skipIf(!PG_URL)('команда threadline:catalog', () => {
  async function cli(argv: string[], dir: string, url: string | undefined) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCatalogCli(argv, { env: { THREADLINE_CONFIG: join(dir, 'threadline.yaml'), THREADLINE_DATABASE_URL: url }, cwd: dir, out: (l) => out.push(l), err: (l) => err.push(l) });
    return { code, out: out.join('\n'), err: err.join('\n') };
  }

  it('ошибка ссылки на метод не печатает номер карты', async () => {
    const { dir, url } = await setup();
    await writeFile(join(dir, 'bad.yaml'), `version: 1\nproject: pay\nsystems:\n  - key: switch\n    name: Коммутатор\n    errors:\n      - { method: { http: POST, path: /v1/card/${PAN} }, code: '1', title: x }\n`);
    const r = await cli(['import', 'pay', 'bad.yaml', '--dry-run'], dir, url);
    expect(r.code).toBe(1);
    expect(r.out).not.toContain(PAN);
    expect(r.out).toContain('systems.0.errors.0.method');
  });

  it('export печатает число записей по видам', async () => {
    const { dir, url } = await setup();
    const r = await cli(['export', 'pay', 'out.yaml'], dir, url);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/типов id 2, систем 3, методов 3, ошибок 2, правил итога 1/);
  });

  it('база недоступна: хост и порт названы, пароля нет', async () => {
    const { dir } = await tempConfig();
    const r = await cli(['export', 'pay', 'x.yaml'], dir, 'postgres://threadline:Top-Secret-9@no-such-host.invalid:5433/threadline');
    expect(r.code).toBe(2);
    expect(r.err).toContain('no-such-host.invalid:5433');
    expect(r.err).not.toContain('Top-Secret-9');
  });
});

describe.skipIf(!PG_URL)('правило итога покрывает строку «Неизвестного»', () => {
  it('условие по HTTP-статусу — строка уходит; условие по полю тела — остаётся до следующего ответа', async () => {
    const { app, collector } = await setup();
    collector.observe('pay', 'demo', false, 'c1', exchange('http://switch.pay.example:11101/v9/new', 200, { error: { code: 12, message: 'Boom' } }));
    collector.observe('pay', 'demo', false, 'c2', exchange('http://switch.pay.example:11101/v9/other', 500, { error: { code: 13, message: 'Bang' } }));
    await collector.flush();
    const page = (await app.inject('/api/projects/pay/catalog/unknown?kind=error')).json() as UnknownPage;
    expect(page.items).toHaveLength(2);
    const http500 = page.items.find((x) => x.httpStatus === 500)!;
    const http200 = page.items.find((x) => x.httpStatus === 200)!;
    const byField = await post(app, 'outcome-rules', { systemId: http200.systemId, methodId: http200.methodId, when: { fields: [{ path: 'error', exists: true }] }, outcome: 'ignore' });
    expect(byField.statusCode, byField.body).toBe(201);
    expect(((await app.inject('/api/projects/pay/catalog/unknown?kind=error')).json() as UnknownPage).items).toHaveLength(2);
    const byHttp = await post(app, 'outcome-rules', { systemId: http500.systemId, methodId: http500.methodId, when: { http: 500 }, outcome: 'ignore' });
    expect(byHttp.statusCode, byHttp.body).toBe(201);
    const after = (await app.inject('/api/projects/pay/catalog/unknown?kind=error')).json() as UnknownPage;
    expect(after.items.map((x) => x.httpStatus)).toEqual([200]);
  });
});

describe('журнал начального набора', () => {
  it('называет все ошибки файла, больше пяти тоже', async () => {
    const bad = `version: 1\nproject: pay\nsystems:\n  - key: pay\n    kind: project\n    name: Шлюз\n    methods:\n${Array.from({ length: 7 }, (_, i) => `      - { http: GET, name: "m${i}" }`).join('\n')}\n`;
    const logs: Logs = { info: [], warn: [] };
    const { config } = await tempConfig({ catalog: bad });
    const svc = service(config, 'pglite://memory', logs);
    closers.push(() => svc.close());
    await svc.start();
    const line = logs.warn.find((x) => x.includes('начальный набор'))!;
    expect(line).toContain('ошибок в файле: 7');
    for (let i = 0; i < 7; i++) expect(line).toContain(`systems.0.methods.${i}.path`);
  });
});

describe('адрес базы и пустая база', () => {
  it('адрес, который не разобрать: состояние error, повтора нет, пароля в тексте нет', async () => {
    const logs: Logs = { info: [], warn: [] };
    const { config } = await tempConfig();
    const svc = service(config, 'postgres://threadline:p@ss:w/SYNTHPW#1?x%y@127.0.0.1:5432/threadline', logs);
    closers.push(() => svc.close());
    await svc.start();
    expect(svc.state().state).toBe('error');
    expect(svc.state().message).toContain('encodeURIComponent');
    expect(JSON.stringify([svc.state(), logs])).not.toContain('SYNTHPW');
  });
});

describe.skipIf(!PG_URL)('том базы пересоздан под работающим сервером', () => {
  it('опрос версии находит пустую базу: схему не меняет, называет команду, после неё сам загружает набор', async () => {
    const { svc, url } = await setup();
    await svc.pollNow();
    expect(svc.state().state).toBe('ok');
    const db = await openDb(url);
    await db.exec('drop schema public cascade; create schema public;');
    await svc.pollNow();
    await vi.waitFor(() => expect(svc.state().message).toContain('threadline:migrate'), { timeout: 10_000, interval: 50 });
    expect(svc.state().state).toBe('error');
    expect(await db.query("select 1 from information_schema.tables where table_schema = 'public'")).toEqual([]);
    await migrate(db);
    await db.close();
    await vi.waitFor(() => expect(svc.state().state).toBe('ok'), { timeout: 40_000, interval: 50 });
    expect(svc.resolver('pay')?.systemByKey('pay')).toBeTruthy();
  });
});

describe.skipIf(!PG_URL)('остановка сервера', () => {
  it('сбор «Неизвестного» пишет накопленное до закрытия базы', async () => {
    const url = (await freshDatabase())!;
    const { config } = await tempConfig({ catalog: CATALOG_YAML });
    const inbox = process.env.THREADLINE_CATALOG_DEMO_INBOX;
    process.env.THREADLINE_CATALOG_DEMO_INBOX = '1';
    const app = await buildApp({ config, backends: new Backends(config), databaseUrl: url, logger: false });
    if (inbox === undefined) delete process.env.THREADLINE_CATALOG_DEMO_INBOX;
    else process.env.THREADLINE_CATALOG_DEMO_INBOX = inbox;
    await app.ready();
    await vi.waitFor(async () => expect(((await app.inject('/api/catalog')).json() as { state: string }).state).toBe('ok'), { timeout: 15_000, interval: 50 });
    const created = await app.inject({ method: 'POST', url: '/api/projects/pay/envs/demo/searches', payload: { terms: ['pay.example'], period: { preset: '24h' }, fresh: true } });
    expect(created.statusCode, created.body).toBe(200);
    const id = (created.json() as { id: string }).id;
    await vi.waitFor(async () => expect(((await app.inject(`/api/searches/${id}`)).json() as { status: string }).status).toBe('done'), { timeout: 20_000, interval: 50 });
    // Период сброса — 10 с: строки есть только благодаря записи при остановке.
    await app.close();
    const db = await openDb(url);
    closers.push(() => db.close());
    const rows = await db.query<{ n: string }>('select count(*) as n from catalog_unknown');
    expect(Number(rows[0]!.n)).toBeGreaterThan(0);
  });
});
