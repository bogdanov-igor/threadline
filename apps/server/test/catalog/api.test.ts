import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ImportReport, MethodRow, SystemRow } from '@threadline/core/catalog';
import { BUILTIN_MASKING, type CatalogState } from '@threadline/core/search';
import { buildApp } from '../../src/app.ts';
import { Backends } from '../../src/backends/registry.ts';
import { UnknownCollector } from '../../src/catalog/collector.ts';
import type { CatalogService } from '../../src/catalog/service.ts';
import * as store from '../../src/catalog/store.ts';
import { CATALOG_YAML, service, tempConfig } from './fixture.ts';
import { freshDatabase, PG_URL } from './pg.ts';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

interface Catalog {
  version: number;
  systems: SystemRow[];
  methods: MethodRow[];
  idTypes: { id: number; key: string; updatedAt: string; kind: string; name: string; statuses: unknown[] }[];
  errors: { id: number; title: string; updatedAt: string }[];
  outcomeRules: unknown[];
}

async function setup(opts: { url?: string | undefined; seed?: boolean } = {}): Promise<{ app: FastifyInstance; svc: CatalogService }> {
  const { config } = await tempConfig(opts.seed === false ? {} : { catalog: CATALOG_YAML });
  const url = 'url' in opts ? opts.url : (await freshDatabase())!;
  const svc = service(config, url);
  await svc.start();
  const app = await buildApp({ config, backends: new Backends(config), catalog: svc, collector: new UnknownCollector(svc) });
  closers.push(async () => {
    await app.close();
    await svc.close();
  });
  return { app, svc };
}

const code = (r: { json: () => unknown }) => (r.json() as { error: { code: string } }).error.code;
/** Применение файла несёт версию, с которой открыт текст. */
const applyUrl = async (app: FastifyInstance) => `/api/projects/pay/catalog/import?baseVersion=${encodeURIComponent(((await app.inject('/api/projects/pay/file-version')).json() as { version: string }).version)}`;
const get = async (app: FastifyInstance): Promise<Catalog> => (await app.inject('/api/projects/pay/catalog')).json() as Catalog;

describe('справочник выключен', () => {
  it('состояние off, маршруты проекта — 404 catalog-off, схема доступна', async () => {
    const { app } = await setup({ url: undefined, seed: false });
    // Базы нет: поля счётчика в ответе нет.
    expect((await app.inject('/api/catalog')).json()).toEqual({ state: 'off', loadedAt: null, message: null, masking: { pay: BUILTIN_MASKING.stamp } });
    const r = await app.inject('/api/projects/pay/catalog');
    expect([r.statusCode, code(r)]).toEqual([404, 'catalog-off']);
    const s = await app.inject('/api/catalog/schema');
    expect(s.statusCode).toBe(200);
    expect(s.headers['content-type']).toContain('application/schema+json');
    expect((s.json() as { title: string }).title).toContain('Файл справочника Threadline');
  });
});

describe.skipIf(!PG_URL)('API справочника', () => {
  it('чтение: состояние ok, справочник проекта из памяти, неизвестный проект', async () => {
    const { app } = await setup();
    expect((await app.inject('/api/catalog')).json()).toMatchObject({ state: 'ok', message: null });
    const c = await get(app);
    expect(c.systems.map((s) => s.key).sort()).toEqual(['pay', 'processor', 'switch']);
    expect(c.idTypes.find((t) => t.key === 'transfer')!.statuses).toHaveLength(3);
    const r = await app.inject('/api/projects/zz/catalog');
    expect([r.statusCode, code(r)]).toEqual([404, 'project-unknown']);
  });

  it('создание, проверки, повтор, хост другой системы', async () => {
    const { app } = await setup();
    const ok = await app.inject({ method: 'POST', url: '/api/projects/pay/catalog/systems', payload: { key: 'acquirer', name: 'Эквайер-тест', hosts: ['*.acquirer.example'] } });
    expect(ok.statusCode, ok.body).toBe(201);
    const created = ok.json() as SystemRow;
    expect(created).toMatchObject({ key: 'acquirer', kind: 'external', type: 'service', edited: true, seedKey: null });

    const dup = await app.inject({ method: 'POST', url: '/api/projects/pay/catalog/systems', payload: { key: 'acquirer', name: 'Ещё раз' } });
    expect([dup.statusCode, code(dup)]).toEqual([409, 'catalog-duplicate']);
    expect((dup.json() as { error: { existingId: number } }).error.existingId).toBe(created.id);

    const host = await app.inject({ method: 'POST', url: '/api/projects/pay/catalog/systems', payload: { key: 'other', name: 'Другая', hosts: ['SWITCH.pay.example:11101'] } });
    expect([host.statusCode, code(host)]).toEqual([409, 'catalog-host-taken']);
    expect((host.json() as { error: { system: { key: string } } }).error.system.key).toBe('switch');

    const bad = await app.inject({ method: 'POST', url: '/api/projects/pay/catalog/systems', payload: { key: 'Bad Key', name: '' } });
    expect([bad.statusCode, code(bad)]).toEqual([422, 'catalog-invalid']);
    expect(Object.keys((bad.json() as { error: { fields: Record<string, string> } }).error.fields)).toEqual(expect.arrayContaining(['key', 'name']));

    const pan = await app.inject({ method: 'POST', url: '/api/projects/pay/catalog/errors', payload: { systemId: created.id, text: '4111111234557893', title: 'Карта' } });
    expect([pan.statusCode, code(pan)]).toEqual([422, 'catalog-invalid']);
    expect(pan.body).not.toContain('4111111234557893');
  });

  it('метод: вид без типа операции, колбэк у внешней системы, неизвестный тип', async () => {
    const { app } = await setup();
    const c = await get(app);
    const sw = c.systems.find((s) => s.key === 'switch')!;
    const post = (payload: object) => app.inject({ method: 'POST', url: '/api/projects/pay/catalog/methods', payload: { systemId: sw.id, http: 'POST', path: '/v3/x', name: 'Х', ...payload } });
    const fields = async (payload: object) => {
      const r = await post(payload);
      expect(r.statusCode, r.body).toBe(422);
      return Object.keys((r.json() as { error: { fields: Record<string, string> } }).error.fields);
    };
    expect(await fields({ kind: 'status' })).toContain('op');
    expect(await fields({ kind: 'callback', op: 'transfer' })).toContain('kind');
    expect(await fields({ fields: [{ in: 'request', path: 'id', type: 'nope' }] })).toContain('fields.0.type');
    const ok = await post({ kind: 'start', op: 'transfer', fields: [{ in: 'request', path: 'request_id', type: 'transfer' }] });
    expect(ok.statusCode, ok.body).toBe(201);
  });

  it('правка с updatedAt, конфликт со свежей записью, правка видна сразу', async () => {
    const { app, svc } = await setup();
    const m = (await get(app)).methods.find((x) => x.name === 'Карты по токенам')!;
    const body = { systemId: m.systemId, http: m.http, path: m.path, name: 'Новое имя', updatedAt: m.updatedAt };
    const r = await app.inject({ method: 'PUT', url: `/api/projects/pay/catalog/methods/${m.id}`, payload: body });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ name: 'Новое имя', edited: true, seedKey: m.seedKey });
    expect(svc.resolver('pay')!.methods.get(m.id)!.name).toBe('Новое имя');
    const stale = await app.inject({ method: 'PUT', url: `/api/projects/pay/catalog/methods/${m.id}`, payload: { ...body, name: 'Третье' } });
    expect([stale.statusCode, code(stale)]).toEqual([409, 'catalog-conflict']);
    expect((stale.json() as { error: { current: { name: string } } }).error.current.name).toBe('Новое имя');
    const none = await app.inject({ method: 'PUT', url: '/api/projects/pay/catalog/methods/999999', payload: body });
    expect([none.statusCode, code(none)]).toEqual([404, 'catalog-not-found']);
  });

  it('удаление: запись набора и своя запись скрываются, автор и занятый тип — 409', async () => {
    const { app } = await setup();
    let c = await get(app);
    const author = c.systems.find((s) => s.kind === 'project')!;
    const r1 = await app.inject({ method: 'DELETE', url: `/api/projects/pay/catalog/systems/${author.id}?updatedAt=${encodeURIComponent(author.updatedAt)}` });
    expect([r1.statusCode, code(r1)]).toEqual([409, 'catalog-author']);

    const transfer = c.idTypes.find((t) => t.key === 'transfer')!;
    const r2 = await app.inject({ method: 'DELETE', url: `/api/projects/pay/catalog/id-types/${transfer.id}?updatedAt=${encodeURIComponent(transfer.updatedAt)}` });
    expect([r2.statusCode, code(r2)]).toEqual([409, 'catalog-in-use']);
    expect((r2.json() as { error: { count: number } }).error.count).toBe(1);

    const processor = c.systems.find((s) => s.key === 'processor')!;
    const deps = (await app.inject(`/api/projects/pay/catalog/systems/${processor.id}/dependents`)).json();
    expect(deps).toEqual({ methods: 1, errors: 1, outcomeRules: 0 });
    const r3 = await app.inject({ method: 'DELETE', url: `/api/projects/pay/catalog/systems/${processor.id}?updatedAt=${encodeURIComponent(processor.updatedAt)}` });
    expect(r3.json()).toMatchObject({ deleted: false, hidden: true });
    c = await get(app);
    const hidden = c.systems.find((s) => s.key === 'processor')!;
    expect(hidden.hidden).toBe(true);
    // Возврат: hidden: false.
    const back = await app.inject({ method: 'PUT', url: `/api/projects/pay/catalog/systems/${hidden.id}`, payload: { key: hidden.key, name: hidden.name, hosts: hidden.hosts, hidden: false, updatedAt: hidden.updatedAt } });
    expect(back.statusCode, back.body).toBe(200);
    expect((back.json() as SystemRow).hidden).toBe(false);

    const own = (await app.inject({ method: 'POST', url: '/api/projects/pay/catalog/errors', payload: { systemId: null, http: 502, text: 'bad gateway', title: 'Шлюз не ответил' } })).json() as { id: number; updatedAt: string };
    const r4 = await app.inject({ method: 'DELETE', url: `/api/projects/pay/catalog/errors/${own.id}?updatedAt=${encodeURIComponent(own.updatedAt)}` });
    expect(r4.json()).toMatchObject({ deleted: false, hidden: true });
  });

  it('общее правило только с HTTP-статусом: новое отклонено у поля, прежнее правится, пока статус тот же', async () => {
    const { app } = await setup();
    const url = '/api/projects/pay/catalog/errors';
    const save = (payload: object) => app.inject({ method: 'POST', url, payload });
    const bad = await save({ systemId: null, http: 500, title: 'Сбой' });
    expect([bad.statusCode, code(bad)]).toEqual([422, 'catalog-invalid']);
    expect((bad.json() as { error: { fieldKeys: unknown } }).error.fieldKeys).toEqual({ text: { key: 'catalog.generalHttpOnly' } });
    expect((await save({ systemId: null, code: '15', title: 'По коду' })).statusCode).toBe(201);
    expect((await save({ systemId: null, http: 500, text: 'gateway timeout', title: 'С подстрокой' })).statusCode).toBe(201);

    const c = (await app.inject('/api/projects/pay/catalog')).json() as { errors: { id: number; title: string; updatedAt: string }[]; systems: { id: number; key: string }[] };
    expect((await save({ systemId: c.systems.find((x) => x.key === 'switch')!.id, http: 500, title: 'На системе' })).statusCode).toBe(201);

    const seeded = c.errors.find((e) => e.title === 'Система не ответила вовремя')!;
    const put = (payload: object, updatedAt = seeded.updatedAt) => app.inject({ method: 'PUT', url: `${url}/${seeded.id}`, payload: { systemId: null, methodId: null, updatedAt, ...payload } });
    const other = await put({ http: 502, title: 'Другой статус' });
    expect([other.statusCode, code(other)]).toEqual([422, 'catalog-invalid']);
    const edited = await put({ http: 504, title: 'Новый текст' });
    expect(edited.statusCode, edited.body).toBe(200);
  });

  it('подстрока со скрытой частью отклонена у поля, разные только пробелами это повтор', async () => {
    const { app } = await setup();
    const save = (payload: object) => app.inject({ method: 'POST', url: '/api/projects/pay/catalog/errors', payload });
    for (const text of ['card … not found', 'card 860012******3456 not found']) {
      const bad = await save({ systemId: null, text, title: 'Скрытая часть' });
      expect([bad.statusCode, code(bad)]).toEqual([422, 'catalog-invalid']);
      expect((bad.json() as { error: { fieldKeys: unknown } }).error.fieldKeys).toEqual({ text: { key: 'catalog.textHidden' } });
    }
    expect((await save({ systemId: null, text: 'gateway  went down', title: 'Первая' })).statusCode).toBe(201);
    expect((await save({ systemId: null, text: 'Gateway went down', title: 'Вторая' })).statusCode).toBe(409);
  });

  it('загрузка и выгрузка файла через API', async () => {
    const { app, svc } = await setup({ seed: false });
    const dry = await app.inject({ method: 'POST', url: '/api/projects/pay/catalog/import?dryRun=1', headers: { 'content-type': 'application/yaml' }, payload: CATALOG_YAML });
    expect(dry.statusCode, dry.body).toBe(200);
    expect((dry.json() as ImportReport).dryRun).toBe(true);
    expect(svc.snapshot('pay')!.methods).toHaveLength(0);

    const r = await app.inject({ method: 'POST', url: await applyUrl(app), headers: { 'content-type': 'text/plain' }, payload: CATALOG_YAML });
    expect(r.statusCode, r.body).toBe(200);
    expect((r.json() as ImportReport).applied).toBe(true);
    expect(svc.snapshot('pay')!.methods).toHaveLength(3);

    const ex = await app.inject('/api/projects/pay/catalog/export?format=json');
    expect(ex.statusCode).toBe(200);
    expect(ex.headers['content-disposition']).toContain('attachment');
    const again = await app.inject({ method: 'POST', url: await applyUrl(app), headers: { 'content-type': 'application/json' }, payload: ex.body });
    expect((again.json() as ImportReport).applied).toBe(false);

    const bad = await app.inject({ method: 'POST', url: await applyUrl(app), headers: { 'content-type': 'application/yaml' }, payload: 'version: 2\nproject: pay\n' });
    expect([bad.statusCode, code(bad)]).toEqual([422, 'catalog-invalid-file']);
    expect((bad.json() as { error: { report: ImportReport } }).error.report.errors[0]!.path).toBe('version');

    const big = await app.inject({ method: 'POST', url: await applyUrl(app), headers: { 'content-type': 'application/yaml' }, payload: `#${'x'.repeat(2 * 1024 * 1024 + 10)}` });
    expect([big.statusCode, code(big)]).toEqual([413, 'catalog-file-too-large']);
  });

  it('база недоступна — правка 503, чтение из памяти', async () => {
    const { app, svc } = await setup();
    const db = svc.readDb()!;
    await db.close();
    await svc.pollNow();
    expect(svc.state().state).toBe('stale');
    const r = await app.inject({ method: 'POST', url: '/api/projects/pay/catalog/errors', payload: { systemId: null, http: 502, title: 'Шлюз' } });
    expect([r.statusCode, code(r)]).toEqual([503, 'catalog-unavailable']);
    expect((await app.inject('/api/projects/pay/catalog')).statusCode).toBe(200);
    // Выгрузка читает базу, а не память: файла нет и при открытом из памяти справочнике.
    const ex = await app.inject('/api/projects/pay/catalog/export?format=yaml');
    expect([ex.statusCode, code(ex)]).toEqual([503, 'catalog-unavailable']);
  });

  it('«Неизвестное»: строка со страницей HTML, записанная раньше, показывается заголовком страницы, ключ тот же', async () => {
    const { app, svc } = await setup();
    const db = svc.readDb()!;
    const row = { key: 'old-html', kind: 'error' as const, systemId: null, methodId: null, httpMethod: 'POST', path: '/v1/a', rpc: '', host: null, httpStatus: 502, code: null, text: 'Failed for Content: <html> <head><title>502 Bad Gateway</title></head> <body> <center><h1>502 Bad Ga' };
    await store.upsertUnknown(db, [{ project: 'pay', item: row, count: 3, env: 'demo', stand: null, exampleCid: 'c1', exampleMs: 1, firstSeen: 1, lastSeen: 1 }]);
    const page = (await app.inject('/api/projects/pay/catalog/unknown')).json() as { items: { key?: string; text: string | null; count: number }[] };
    expect(page.items).toEqual([expect.objectContaining({ text: 'Failed for Content: 502 Bad Gateway', count: 3 })]);
    await store.upsertUnknown(db, [{ project: 'pay', item: { ...row, text: 'Failed for Content: 502 Bad Gateway' }, count: 1, env: 'demo', stand: null, exampleCid: 'c2', exampleMs: 2, firstSeen: 2, lastSeen: 2 }]);
    const after = (await app.inject('/api/projects/pay/catalog/unknown')).json() as { items: { text: string | null; count: number }[] };
    expect(after.items).toEqual([expect.objectContaining({ text: 'Failed for Content: 502 Bad Gateway', count: 4 })]);
  });

  it('«Неизвестное»: страница по частоте, скрытие', async () => {
    const { app, svc } = await setup();
    const db = svc.readDb()!;
    const item = (key: string, path: string) => ({ key, kind: 'method' as const, systemId: null, methodId: null, httpMethod: 'GET', path, rpc: '', host: null, httpStatus: null, code: null, text: null });
    await store.upsertUnknown(db, [
      { project: 'pay', item: item('a', '/v1/a'), count: 1, env: 'demo', stand: null, exampleCid: 'c1', exampleMs: 1, firstSeen: 1, lastSeen: 1 },
      { project: 'pay', item: item('b', '/v1/b'), count: 5, env: 'demo', stand: null, exampleCid: 'c2', exampleMs: 2, firstSeen: 2, lastSeen: 2 },
    ]);
    const page = (await app.inject('/api/projects/pay/catalog/unknown')).json() as { items: { id: number; path: string }[]; total: number };
    // Счётчик значка: только открытые строки, из ответа опроса состояния.
    expect(((await app.inject('/api/catalog')).json() as CatalogState).unknownOpen).toEqual({ pay: 2 });
    expect(page.total).toBe(2);
    expect(page.items.map((i) => i.path)).toEqual(['/v1/b', '/v1/a']);
    const h = await app.inject({ method: 'PUT', url: `/api/projects/pay/catalog/unknown/${page.items[0]!.id}`, payload: { hidden: true } });
    expect((h.json() as { hidden: boolean }).hidden).toBe(true);
    expect(((await app.inject('/api/projects/pay/catalog/unknown')).json() as { total: number }).total).toBe(1);
    expect(((await app.inject('/api/projects/pay/catalog/unknown?hidden=1')).json() as { total: number }).total).toBe(1);
    expect(((await app.inject('/api/catalog')).json() as CatalogState).unknownOpen).toEqual({ pay: 1 });
    // Сбой чтения счётчика не роняет опрос: поля нет, состояние прежнее.
    await db.query('alter table catalog_unknown rename to catalog_unknown_away');
    const broken = await app.inject('/api/catalog');
    expect(broken.statusCode).toBe(200);
    expect(broken.json()).toMatchObject({ state: 'ok' });
    expect('unknownOpen' in (broken.json() as object)).toBe(false);
    await db.query('alter table catalog_unknown_away rename to catalog_unknown');
  });
});
