// Мягкое удаление, удаление навсегда, импорт и посев, права на файл. На PGlite.

import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Role } from '@threadline/core/access';
import { unknownItems, type CatalogResponse, type ImportReport } from '@threadline/core/catalog';
import { buildApp } from '../../src/app.ts';
import { Backends } from '../../src/backends/registry.ts';
import { UnknownCollector } from '../../src/catalog/collector.ts';
import { importCatalog, parseCatalogText, reportLine } from '../../src/catalog/exchange.ts';
import type { CatalogService } from '../../src/catalog/service.ts';
import * as store from '../../src/catalog/store.ts';
import { exchange } from '../../../../packages/core/src/catalog/test-catalog.ts';
import { CATALOG_YAML, service, tempConfig, type Logs } from './fixture.ts';
import { freshDatabase, PG_URL } from './pg.ts';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

async function setup(): Promise<{ app: FastifyInstance; svc: CatalogService }> {
  const { config } = await tempConfig({ catalog: CATALOG_YAML });
  const svc = service(config, 'pglite://memory');
  await svc.start();
  const app = await buildApp({
    config,
    backends: new Backends(config),
    catalog: svc,
    collector: new UnknownCollector(svc),
    testViewer: (req) => ({ owner: 'test', role: (req.headers['x-test-role'] ?? 'admin') as Role, name: null }),
  });
  closers.push(async () => {
    await app.close();
    await svc.close();
  });
  return { app, svc };
}

const catalog = async (app: FastifyInstance) => (await app.inject('/api/projects/pay/catalog')).json() as CatalogResponse;
const code = (r: { json: () => unknown }) => (r.json() as { error: { code: string } }).error.code;
const as = (role: Role) => ({ 'x-test-role': role });
const del = (app: FastifyInstance, role: Role, section: string, row: { id: number; updatedAt: string }, permanent = false) =>
  app.inject({ method: 'DELETE', url: `/api/projects/pay/catalog/${section}/${row.id}?updatedAt=${encodeURIComponent(row.updatedAt)}${permanent ? '&permanent=1' : ''}`, headers: as(role) });
const put = (app: FastifyInstance, role: Role, section: string, id: number, payload: object) => app.inject({ method: 'PUT', url: `/api/projects/pay/catalog/${section}/${id}`, headers: as(role), payload });
const post = (app: FastifyInstance, role: Role, section: string, payload: object) => app.inject({ method: 'POST', url: `/api/projects/pay/catalog/${section}`, headers: as(role), payload });
const upload = async (app: FastifyInstance, role: Role, text: string, query = '') => {
  // Применение несёт версию, с которой открыт текст. Читает её администратор: роль здесь про загрузку.
  const version = ((await app.inject({ url: '/api/projects/pay/file-version', headers: as('admin') })).json() as { version: string }).version;
  const sep = query ? '&' : '?';
  return app.inject({ method: 'POST', url: `/api/projects/pay/catalog/import${query}${query.includes('dryRun') ? '' : `${sep}baseVersion=${encodeURIComponent(version)}`}`, headers: { ...as(role), 'content-type': 'application/yaml' }, payload: text });
};

describe('удаление всегда обратимо', () => {
  it('запись из редактора скрывается, строка на месте; поддержка удаляет ошибку, метод ей закрыт', async () => {
    const { app, svc } = await setup();
    const c = await catalog(app);
    const processor = c.systems.find((s) => s.key === 'processor')!;
    const made = await post(app, 'analyst', 'methods', { systemId: processor.id, http: 'GET', path: '/made/by/hand', name: 'Из редактора' });
    expect(made.statusCode, made.body).toBe(201);
    const method = made.json() as { id: number; updatedAt: string };
    const denied = await del(app, 'support', 'methods', method);
    expect([denied.statusCode, code(denied)]).toEqual([403, 'forbidden']);
    expect((await store.getRow(svc.db(), 'method', 'pay', method.id))?.hidden).toBe(false);

    const r = await del(app, 'analyst', 'methods', method);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ deleted: false, hidden: true });
    expect((await store.getRow(svc.db(), 'method', 'pay', method.id))?.hidden).toBe(true);

    const error = c.errors.find((e) => e.title === 'Система не ответила вовремя')!;
    expect((await del(app, 'support', 'errors', error)).json()).toMatchObject({ deleted: false, hidden: true });
  });

  it('система с зависимыми: числа в ответе, флаги зависимых не меняются, отдельно скрытое остаётся скрытым после возврата', async () => {
    const { app } = await setup();
    let c = await catalog(app);
    const processor = c.systems.find((s) => s.key === 'processor')!;
    const error = c.errors.find((e) => e.systemId === processor.id)!;
    expect((await del(app, 'developer', 'errors', error)).statusCode).toBe(200);
    const r = await del(app, 'developer', 'systems', processor);
    expect(r.json()).toMatchObject({ deleted: false, hidden: true, dependents: { methods: 1, errors: 1, outcomeRules: 0 } });
    c = await catalog(app);
    expect(c.methods.find((m) => m.systemId === processor.id)!.hidden).toBe(false);
    const hidden = c.systems.find((s) => s.id === processor.id)!;
    const back = await put(app, 'developer', 'systems', hidden.id, { key: hidden.key, name: hidden.name, hosts: hidden.hosts, hidden: false, updatedAt: hidden.updatedAt });
    expect(back.statusCode, back.body).toBe(200);
    c = await catalog(app);
    expect(c.errors.find((e) => e.id === error.id)!.hidden).toBe(true);
  });

  it('метод после удаления снова в «Неизвестном», после возврата снова с названием; то же при возврате системы', async () => {
    const { app, svc } = await setup();
    const call = () => exchange(Date.UTC(2026, 10, 2, 9), 'https://processor.pay.example:8443/soap/issuing', { req: '<getCard/>', resp: {} });
    const unknownKinds = () => unknownItems(call(), svc.resolver('pay')!).map((i) => i.kind);
    const c = await catalog(app);
    const method = c.methods.find((m) => m.name === 'Карта по токену')!;
    const system = c.systems.find((s) => s.id === method.systemId)!;
    const known = unknownKinds();
    await del(app, 'developer', 'methods', method);
    expect(unknownKinds()).toContain('method');
    const hiddenMethod = (await catalog(app)).methods.find((m) => m.id === method.id)!;
    const { id: _id, seedKey: _seed, edited: _edited, systemId: _system, ...fields } = hiddenMethod;
    const back = await put(app, 'developer', 'methods', method.id, { ...fields, systemId: method.systemId, hidden: false });
    expect(back.statusCode, back.body).toBe(200);
    expect(unknownKinds()).toEqual(known);

    await del(app, 'developer', 'systems', system);
    expect(unknownKinds()).not.toEqual(known);
    const hiddenSystem = (await catalog(app)).systems.find((s) => s.id === system.id)!;
    await put(app, 'developer', 'systems', system.id, { key: hiddenSystem.key, name: hiddenSystem.name, hosts: hiddenSystem.hosts, hidden: false, updatedAt: hiddenSystem.updatedAt });
    expect(unknownKinds()).toEqual(known);
  });

  it('запись изменили после открытия подтверждения: отказ, запись не меняется', async () => {
    const { app, svc } = await setup();
    const error = (await catalog(app)).errors[0]!;
    const r = await del(app, 'developer', 'errors', { id: error.id, updatedAt: '2020-01-01T00:00:00.000000Z' });
    expect([r.statusCode, code(r)]).toEqual([409, 'catalog-conflict']);
    expect((await store.getRow(svc.db(), 'error', 'pay', error.id))?.hidden).toBe(false);
  });

  it('база недоступна: ничего не изменилось, ответ называет причину', async () => {
    const { app, svc } = await setup();
    const error = (await catalog(app)).errors[0]!;
    await svc.close();
    const r = await del(app, 'developer', 'errors', error);
    expect(r.statusCode).toBe(503);
    expect(code(r)).toBe('catalog-unavailable');
  });
});

describe('возврат записи', () => {
  it('хост занят другой видимой системой: отказ с её названием, запись остаётся скрытой', async () => {
    const { app } = await setup();
    let c = await catalog(app);
    const processor = c.systems.find((s) => s.key === 'processor')!;
    await del(app, 'developer', 'systems', processor);
    // Хост удалённой системы не занят: другой системе его можно поставить.
    const other = await post(app, 'developer', 'systems', { key: 'other', name: 'Другая', hosts: processor.hosts });
    expect(other.statusCode, other.body).toBe(201);
    c = await catalog(app);
    const hidden = c.systems.find((s) => s.id === processor.id)!;
    const r = await put(app, 'developer', 'systems', hidden.id, { key: hidden.key, name: hidden.name, hosts: hidden.hosts, hidden: false, updatedAt: hidden.updatedAt });
    expect([r.statusCode, code(r)]).toEqual([409, 'catalog-host-taken']);
    expect((r.json() as { error: { system: { name: string } } }).error.system.name).toBe('Другая');
    expect((await catalog(app)).systems.find((s) => s.id === processor.id)!.hidden).toBe(true);
  });

  it('родитель скрыт: возврат записи проходит, новая запись и правка отклоняются с ошибкой у поля и ключом', async () => {
    const { app } = await setup();
    let c = await catalog(app);
    const processor = c.systems.find((s) => s.key === 'processor')!;
    const error = c.errors.find((e) => e.systemId === processor.id)!;
    await del(app, 'developer', 'errors', error);
    await del(app, 'developer', 'systems', processor);
    c = await catalog(app);
    const row = c.errors.find((e) => e.id === error.id)!;
    const body = { systemId: processor.id, methodId: null, http: row.http, code: row.code, text: row.text, title: row.title, action: row.action, severity: row.severity, partnerCode: row.partnerCode };
    const back = await put(app, 'developer', 'errors', row.id, { ...body, hidden: false, updatedAt: row.updatedAt });
    expect(back.statusCode, back.body).toBe(200);
    const restored = back.json() as { hidden: boolean; updatedAt: string };
    expect(restored.hidden).toBe(false);

    const edit = await put(app, 'developer', 'errors', row.id, { ...body, title: 'Другой текст', updatedAt: restored.updatedAt });
    expect([edit.statusCode, code(edit)]).toEqual([422, 'catalog-invalid']);
    expect(edit.json()).toMatchObject({ error: { fields: { systemId: expect.any(String) }, fieldKeys: { systemId: { key: 'catalog.systemHidden' } } } });

    const fresh = await post(app, 'developer', 'errors', { systemId: processor.id, http: 418, title: 'Новая' });
    expect([fresh.statusCode, code(fresh)]).toEqual([422, 'catalog-invalid']);
    const method = await post(app, 'developer', 'methods', { systemId: processor.id, http: 'GET', path: '/x', name: 'X' });
    expect([method.statusCode, code(method)]).toEqual([422, 'catalog-invalid']);
    expect(method.json()).toMatchObject({ error: { fieldKeys: { systemId: { key: 'catalog.systemHidden' } } } });
  });

  it('метод скрыт: ошибка метода отклоняется ключом метода', async () => {
    const { app } = await setup();
    const c = await catalog(app);
    const processor = c.systems.find((s) => s.key === 'processor')!;
    const method = c.methods.find((m) => m.systemId === processor.id)!;
    await del(app, 'developer', 'methods', method);
    const r = await post(app, 'developer', 'errors', { systemId: processor.id, methodId: method.id, http: 418, title: 'Новая' });
    expect([r.statusCode, code(r)]).toEqual([422, 'catalog-invalid']);
    expect(r.json()).toMatchObject({ error: { fieldKeys: { methodId: { key: 'catalog.methodHidden' } } } });
  });
});

describe('новая запись с ключом удалённой', () => {
  it('повтор удалённого метода: 409 с existingHidden и id, у видимой записи признака нет', async () => {
    const { app } = await setup();
    const c = await catalog(app);
    const processor = c.systems.find((s) => s.key === 'processor')!;
    const method = c.methods.find((m) => m.systemId === processor.id)!;
    const body = { systemId: processor.id, http: method.http, path: method.path, rpc: method.rpc, name: 'Заново' };
    const visible = await post(app, 'developer', 'methods', body);
    expect([visible.statusCode, code(visible)]).toEqual([409, 'catalog-duplicate']);
    expect((visible.json() as { error: { existingHidden?: boolean } }).error.existingHidden).toBeUndefined();
    await del(app, 'developer', 'methods', method);
    const r = await post(app, 'developer', 'methods', body);
    expect([r.statusCode, code(r)]).toEqual([409, 'catalog-duplicate']);
    expect(r.json()).toMatchObject({ error: { existingId: method.id, existingHidden: true } });
  });
});

describe('удаление навсегда', () => {
  it('видимая запись отклоняется, другим ролям 403, скрытая стирается с зависимыми и оставляет отметки', async () => {
    const { app, svc } = await setup();
    const c = await catalog(app);
    const processor = c.systems.find((s) => s.key === 'processor')!;
    const visible = await del(app, 'admin', 'systems', processor, true);
    expect([visible.statusCode, code(visible)]).toEqual([409, 'catalog-not-hidden']);
    await del(app, 'developer', 'systems', processor);
    const hidden = (await catalog(app)).systems.find((s) => s.id === processor.id)!;
    for (const role of ['business', 'support', 'developer', 'analyst'] as Role[]) {
      const r = await del(app, role, 'systems', hidden, true);
      expect([role, r.statusCode, code(r)]).toEqual([role, 403, 'forbidden']);
    }
    const r = await del(app, 'admin', 'systems', hidden, true);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ deleted: true, hidden: false, dependents: { methods: 1, errors: 1 } });
    const after = await catalog(app);
    expect(after.systems.some((s) => s.id === processor.id)).toBe(false);
    expect(after.methods.some((m) => m.systemId === processor.id)).toBe(false);
    expect(after.errors.some((e) => e.systemId === processor.id)).toBe(false);
    const marks = [...(await store.deletedKeys(svc.db(), 'pay'))].map((k) => k.split('|')[0]).sort();
    expect(marks).toEqual(['error', 'method', 'system']);
  });

  it('система-автор и занятый тип отклоняются с прежним кодом', async () => {
    const { app } = await setup();
    const c = await catalog(app);
    const author = c.systems.find((s) => s.kind === 'project')!;
    expect(code(await del(app, 'admin', 'systems', author, true))).toBe('catalog-author');
    const transfer = c.idTypes.find((t) => t.key === 'transfer')!;
    expect(code(await del(app, 'admin', 'id-types', transfer, true))).toBe('catalog-in-use');
  });

  it('файл не возвращает удалённое навсегда без замены; замена и новое создание снимают отметку', async () => {
    const { app, svc } = await setup();
    const error = (await catalog(app)).errors.find((e) => e.title === 'Система не ответила вовремя')!;
    await del(app, 'admin', 'errors', error);
    const hidden = (await catalog(app)).errors.find((e) => e.id === error.id)!;
    await del(app, 'admin', 'errors', hidden, true);

    const plain = (await upload(app, 'developer', CATALOG_YAML)).json() as ImportReport;
    expect(plain.undeleted?.map((i) => i.title)).toEqual(['Система не ответила вовремя']);
    expect([plain.added.length, plain.applied]).toEqual([0, false]);
    expect(reportLine(plain)).toContain('удалённые не возвращены 1');
    expect((await catalog(app)).errors.some((e) => e.title === 'Система не ответила вовремя')).toBe(false);

    const dry = (await upload(app, 'developer', CATALOG_YAML, '?dryRun=1&force=1')).json() as ImportReport;
    expect(dry.added.map((i) => i.title)).toEqual(['Система не ответила вовремя']);
    const forced = (await upload(app, 'developer', CATALOG_YAML, '?force=1')).json() as ImportReport;
    expect(forced.added.map((i) => i.title)).toEqual(['Система не ответила вовремя']);
    expect(await store.deletedKeys(svc.db(), 'pay')).toEqual(new Set());

    // Новое создание в редакторе снимает отметку.
    await upload(app, 'developer', CATALOG_YAML.replace('general:\n  errors:\n', "general:\n  errors:\n    - { code: '77', title: Общая по коду }\n"));
    const again = (await catalog(app)).errors.find((e) => e.title === 'Общая по коду')!;
    await del(app, 'admin', 'errors', again);
    await del(app, 'admin', 'errors', (await catalog(app)).errors.find((e) => e.id === again.id)!, true);
    expect((await store.deletedKeys(svc.db(), 'pay')).size).toBe(1);
    const made = await post(app, 'admin', 'errors', { systemId: null, code: '77', title: 'Создана заново' });
    expect(made.statusCode, made.body).toBe(201);
    expect(await store.deletedKeys(svc.db(), 'pay')).toEqual(new Set());
  });

  it('запись не из файла отметки не даёт: в файле потом считается новой', async () => {
    const { app, svc } = await setup();
    const made = (await post(app, 'admin', 'errors', { systemId: null, code: '77', title: 'Только в редакторе' })).json() as { id: number; updatedAt: string };
    await del(app, 'admin', 'errors', made);
    await del(app, 'admin', 'errors', (await catalog(app)).errors.find((e) => e.id === made.id)!, true);
    expect(await store.deletedKeys(svc.db(), 'pay')).toEqual(new Set());
    const text = `${CATALOG_YAML.replace('general:\n  errors:\n', "general:\n  errors:\n    - { code: '77', title: Из файла }\n")}`;
    const r = (await upload(app, 'developer', text)).json() as ImportReport;
    expect(r.added.map((i) => i.title)).toEqual(['Из файла']);
  });

  it('метод внутри системы, удалённой навсегда: новый метод в файле файл не ломает', async () => {
    const { app } = await setup();
    const processor = (await catalog(app)).systems.find((s) => s.key === 'processor')!;
    await del(app, 'admin', 'systems', processor);
    await del(app, 'admin', 'systems', (await catalog(app)).systems.find((s) => s.id === processor.id)!, true);
    const text = CATALOG_YAML.replace('rpc: getCard, name: Карта по токену }', 'rpc: getCard, name: Карта по токену }\n      - { http: GET, path: /brand/new, name: Новый метод }');
    const r = await upload(app, 'developer', text);
    expect(r.statusCode, r.body).toBe(200);
    const report = r.json() as ImportReport;
    expect(report.errors).toEqual([]);
    expect(report.undeleted?.map((i) => i.title)).toContain('GET /brand/new · Новый метод');
    expect(report.added).toEqual([]);
  });
});

describe('импорт и мягко удалённое', () => {
  it('файл без замены не возвращает и не меняет, с заменой возвращает той же группой в проверке и применении', async () => {
    const { app } = await setup();
    const c = await catalog(app);
    const processor = c.systems.find((s) => s.key === 'processor')!;
    const method = c.methods.find((m) => m.systemId === processor.id)!;
    await del(app, 'developer', 'methods', method);
    const renamed = CATALOG_YAML.replace('name: Карта по токену', 'name: Новое название');
    const plain = (await upload(app, 'developer', renamed)).json() as ImportReport;
    expect(plain.undeleted?.map((i) => i.kind)).toEqual(['method']);
    expect(plain.restored).toEqual([]);
    const still = (await catalog(app)).methods.find((m) => m.id === method.id)!;
    expect([still.hidden, still.name]).toEqual([true, 'Карта по токену']);

    const dry = (await upload(app, 'developer', renamed, '?dryRun=1&force=1')).json() as ImportReport;
    expect(dry.restored?.map((i) => i.kind)).toEqual(['method']);
    expect((await catalog(app)).methods.find((m) => m.id === method.id)!.hidden).toBe(true);
    const applied = (await upload(app, 'developer', renamed, '?force=1')).json() as ImportReport;
    expect(applied.restored?.map((i) => i.kind)).toEqual(['method']);
    const back = (await catalog(app)).methods.find((m) => m.id === method.id)!;
    expect([back.hidden, back.name]).toEqual([false, 'Новое название']);
  });

  it('запись пропала из файла: строка на месте и считается в «нет в файле»', async () => {
    const { app } = await setup();
    const error = (await catalog(app)).errors.find((e) => e.title === 'Система не ответила вовремя')!;
    await del(app, 'developer', 'errors', error);
    const text = CATALOG_YAML.slice(0, CATALOG_YAML.indexOf('general:'));
    const r = (await upload(app, 'developer', text)).json() as ImportReport;
    expect(r.missing).toBe(1);
    expect(r.undeleted).toEqual([]);
    expect((await catalog(app)).errors.find((e) => e.id === error.id)!.hidden).toBe(true);
  });

  it('выгрузка и обратная загрузка: всё без изменений, удалённые остаются скрытыми', async () => {
    const { app } = await setup();
    const error = (await catalog(app)).errors[0]!;
    await del(app, 'developer', 'errors', error);
    const text = (await app.inject({ url: '/api/projects/pay/catalog/export', headers: as('support') })).body;
    const r = (await upload(app, 'developer', text)).json() as ImportReport;
    expect([r.added.length, r.changed.length, r.hidden.length, r.skipped.length, r.restored?.length, r.undeleted?.length, r.applied]).toEqual([0, 0, 0, 0, 0, 0, false]);
    expect((await catalog(app)).errors.find((e) => e.id === error.id)!.hidden).toBe(true);
  });

  it('файл скрывает неправленую запись, следующий файл без скрытия возвращает её группой «возвращено»', async () => {
    const { app } = await setup();
    const hiding = CATALOG_YAML.replace('- { http: 504, title: Система не ответила вовремя }', '- { http: 504, title: Система не ответила вовремя, hidden: true }');
    const first = (await upload(app, 'developer', hiding)).json() as ImportReport;
    expect(first.hidden.map((i) => i.title)).toEqual(['Система не ответила вовремя']);
    const second = (await upload(app, 'developer', CATALOG_YAML)).json() as ImportReport;
    expect(second.restored?.map((i) => i.title)).toEqual(['Система не ответила вовремя']);
    expect(second.changed).toEqual([]);
    expect((await upload(app, 'developer', CATALOG_YAML)).json()).toMatchObject({ applied: false, restored: [], undeleted: [] });
  });
});

describe('права на файл', () => {
  const MASKING = (enabled: boolean) => `\nmasking:\n  - { type: phone, enabled: ${String(enabled)} }\n`;

  it('файл от аналитика и разработчика, меняющий маскирование: ошибка с путём masking, ни одна запись не применена', async () => {
    const { app, svc } = await setup();
    const text = `${CATALOG_YAML.replace('name: Карта по токену }', 'name: Карта по токену }\n      - { http: GET, path: /fresh/one, name: Новый }')}${MASKING(false)}`;
    for (const role of ['developer', 'analyst'] as Role[]) {
      for (const query of ['', '?dryRun=1']) {
        const r = await upload(app, role, text, query);
        expect([role, query, r.statusCode, code(r)]).toEqual([role, query, 422, 'catalog-invalid-file']);
        const report = (r.json() as { error: { report: ImportReport } }).error.report;
        expect(report.errors).toEqual([expect.objectContaining({ path: 'masking', key: 'catalog.maskingAdminOnly' })]);
        expect(report.added).toEqual([]);
      }
    }
    expect((await catalog(app)).methods.some((m) => m.name === 'Новый')).toBe(false);
    expect((await store.getMasking(svc.db(), 'pay', 'phone'))?.enabled).toBe(true);
    const admin = await upload(app, 'admin', text);
    expect(admin.statusCode, admin.body).toBe(200);
    expect((await store.getMasking(svc.db(), 'pay', 'phone'))?.enabled).toBe(false);
  });

  it('выгрузка и загрузка у аналитика: совпадающий раздел принят', async () => {
    const { app } = await setup();
    const text = (await app.inject({ url: '/api/projects/pay/catalog/export', headers: as('analyst') })).body;
    expect(text).toContain('masking');
    const r = await upload(app, 'analyst', text);
    expect(r.statusCode, r.body).toBe(200);
    expect((r.json() as ImportReport).applied).toBe(false);
  });

  it('загрузка поддержкой и Бизнесом: 403 до разбора файла, в том числе в режиме проверки; выгрузка у поддержки есть', async () => {
    const { app } = await setup();
    for (const role of ['support', 'business'] as Role[]) {
      for (const query of ['', '?dryRun=1']) {
        const r = await upload(app, role, 'не файл: [', query);
        expect([role, r.statusCode, code(r)]).toEqual([role, 403, 'forbidden']);
      }
    }
    expect((await app.inject({ url: '/api/projects/pay/catalog/export', headers: as('support') })).statusCode).toBe(200);
    const business = await app.inject({ url: '/api/projects/pay/catalog/export', headers: as('business') });
    expect([business.statusCode, code(business)]).toEqual([403, 'forbidden']);
  });
});

describe.skipIf(!PG_URL)('посев', () => {
  it('новый начальный набор не возвращает удалённое навсегда и мягко удалённое, журнал называет их число', async () => {
    const url = (await freshDatabase())!;
    const first = await tempConfig({ catalog: CATALOG_YAML });
    const s1 = service(first.config, url);
    await s1.start();
    const snapshot = await store.loadSnapshot(s1.db(), 'pay');
    const gone = snapshot.errors.find((e) => e.title === 'Карта не найдена в процессинге')!;
    const { removeForever, removeRow } = await import('../../src/catalog/edit.ts');
    await s1.edit('pay', (q) => removeRow(q, 'pay', 'error', gone.id, gone.updatedAt));
    await s1.edit('pay', async (q) => removeForever(q, 'pay', 'error', gone.id, (await store.getRow(q, 'error', 'pay', gone.id))!.updatedAt));
    const method = snapshot.methods.find((m) => m.name === 'Карта по токену')!;
    await s1.edit('pay', (q) => removeRow(q, 'pay', 'method', method.id, method.updatedAt));
    await s1.close();

    const next = await tempConfig({ catalog: CATALOG_YAML.replace('name: Карта по токену', 'name: Другое название') });
    const logs: Logs = { info: [], warn: [] };
    const s2 = service(next.config, url, logs);
    closers.push(() => s2.close());
    await s2.start();
    expect(logs.info.join('\n')).toContain('удалённые не возвращены 2');
    const after = await store.loadSnapshot(s2.db(), 'pay');
    expect(after.errors.some((e) => e.title === 'Карта не найдена в процессинге')).toBe(false);
    const row = after.methods.find((m) => m.id === method.id)!;
    expect([row.hidden, row.name]).toEqual([true, 'Карта по токену']);
  });
});

it('разбор файла для импорта без роли: команда раздел masking применяет', async () => {
  const { svc } = await setup();
  const parsed = parseCatalogText('version: 1\nproject: pay\nmasking:\n  - { type: phone, enabled: false }\n');
  if (!parsed.ok) throw new Error('fixture');
  const r = await importCatalog(svc.db(), 'pay', 'Demo Pay', parsed.value, { dryRun: false, force: false });
  expect(r.errors).toEqual([]);
  expect((await store.getMasking(svc.db(), 'pay', 'phone'))?.enabled).toBe(false);
});
