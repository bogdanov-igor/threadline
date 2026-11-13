// Настройка маскирования в базе, API и файле.
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { CatalogResponse, ImportReport, MaskingSaved } from '@threadline/core/catalog';
import { ALL_KINDS_MASKING, BUILTIN_MASKING, MASK_KIND_CODES, MASK_KINDS } from '@threadline/core/search';
import { buildApp } from '../../src/app.ts';
import { Backends } from '../../src/backends/registry.ts';
import { UnknownCollector } from '../../src/catalog/collector.ts';
import { formatReport } from '../../src/catalog/cli-run.ts';
import { openDb } from '../../src/catalog/db.ts';
import { exportCatalogText, importCatalog, parseCatalogText } from '../../src/catalog/exchange.ts';
import { migrate, readMigrations } from '../../src/catalog/migrate.ts';
import type { CatalogService } from '../../src/catalog/service.ts';
import * as store from '../../src/catalog/store.ts';
import { CATALOG_YAML, service, tempConfig } from './fixture.ts';
import { freshDatabase } from './pg.ts';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

async function setup(url?: string): Promise<{ app: FastifyInstance; svc: CatalogService; url: string }> {
  const { config } = await tempConfig({ catalog: CATALOG_YAML });
  const u = url ?? (await freshDatabase()) ?? 'pglite://memory';
  const svc = service(config, u);
  await svc.start();
  const app = await buildApp({ config, backends: new Backends(config), catalog: svc, collector: new UnknownCollector(svc) });
  closers.push(async () => {
    await app.close();
    await svc.close();
  });
  return { app, svc, url: u };
}

const rows = async (app: FastifyInstance) => ((await app.inject('/api/projects/pay/catalog')).json() as CatalogResponse).masking!;
const edit = (app: FastifyInstance, type: string, payload: object) => app.inject({ method: 'PUT', url: `/api/projects/pay/catalog/masking/${type}`, payload });
const fieldsOf = (r: { json: () => unknown }) => Object.values((r.json() as { error: { fields: Record<string, string> } }).error.fields).join(' ');

describe('база', () => {
  it('первое подключение: строки всех видов в состоянии по умолчанию; строка неизвестного вида остаётся и не применяется', async () => {
    const { app, svc } = await setup();
    const list = await rows(app);
    expect(list.map((r) => r.type).sort()).toEqual([...MASK_KIND_CODES].sort());
    expect(list.every((r) => r.enabled === MASK_KINDS[r.type as keyof typeof MASK_KINDS].defaultEnabled && r.keys.length === 0 && !r.edited)).toBe(true);
    expect(list.filter((r) => !r.enabled).map((r) => r.type).sort()).toEqual(['birth_date', 'email', 'first_name']);
    const db = svc.db();
    const before = svc.snapshot('pay')!.version;
    await store.ensureProject(db, 'pay', 'Demo Pay');
    expect((await store.loadSnapshot(db, 'pay')).version).toBe(before);
    await db.query(`insert into catalog_masking (project_id, type, enabled) values ('pay', 'snils', false)`);
    await svc.afterChange('pay');
    expect(svc.masking('pay').stamp).toBe(BUILTIN_MASKING.stamp);
    expect((await rows(app)).some((r) => r.type === 'snils')).toBe(true);
  });

  it('база со старыми шестью строками: они не тронуты, семь новых созданы с состоянием по умолчанию, версия меняется один раз', async () => {
    const { app, svc } = await setup();
    const db = svc.db();
    const old = ['phone', 'address', 'passport', 'national_id', 'surname', 'card_data'];
    const phone = (await rows(app)).find((r) => r.type === 'phone')!;
    expect((await edit(app, 'phone', { enabled: false, keys: ['alt_phone'], updatedAt: phone.updatedAt })).statusCode).toBe(200);
    const before = (await store.loadSnapshot(db, 'pay')).masking!.filter((r) => old.includes(r.type));
    await db.query(`delete from catalog_masking where project_id = 'pay' and not (type = any($1::text[]))`, [old]);
    await store.ensureProject(db, 'pay', 'Demo Pay');
    const after = (await store.loadSnapshot(db, 'pay')).masking!;
    expect(after.filter((r) => old.includes(r.type))).toEqual(before);
    const added = after.filter((r) => !old.includes(r.type));
    expect(added.map((r) => [r.type, r.enabled]).sort()).toEqual(MASK_KIND_CODES.filter((k) => !old.includes(k)).map((k) => [k, MASK_KINDS[k].defaultEnabled]).sort());
    const version = (await store.loadSnapshot(db, 'pay')).version;
    await store.ensureProject(db, 'pay', 'Demo Pay');
    expect((await store.loadSnapshot(db, 'pay')).version).toBe(version);
  });

  it('вид с замком: enabled false в запросе 422 с ошибкой у поля, ничего не сохранено; в базе вручную не действует', async () => {
    const { app, svc } = await setup();
    for (const type of ['secrets', 'card_number']) {
      const row = (await rows(app)).find((r) => r.type === type)!;
      const r = await edit(app, type, { enabled: false, keys: [], updatedAt: row.updatedAt });
      expect(r.statusCode, type).toBe(422);
      const error = (r.json() as { error: { fields: Record<string, string>; fieldKeys: Record<string, { key: string }> } }).error;
      expect(Object.keys(error.fields)).toEqual(['enabled']);
      expect(error.fieldKeys.enabled!.key).toBe('masking.kindLocked');
      expect((await rows(app)).find((x) => x.type === type)!.updatedAt).toBe(row.updatedAt);
    }
    const db = svc.db();
    await db.query(`update catalog_masking set enabled = false where project_id = 'pay' and type = 'card_number'`);
    await svc.afterChange('pay');
    expect(svc.masking('pay').shown.kinds.has('card_number')).toBe(true);
    const yaml = await exportCatalogText(db, 'pay', 'yaml');
    expect(yaml).toMatch(/type: card_number\n\s+enabled: true/);
  });

  it('вид с замком: enabled true с полями принят, своё имя первого прохода считается один раз', async () => {
    const { app } = await setup();
    const row = (await rows(app)).find((r) => r.type === 'secrets')!;
    const r = await edit(app, 'secrets', { enabled: true, keys: ['password', 'partner_key'], updatedAt: row.updatedAt });
    expect(r.statusCode).toBe(200);
  });

  it('поле, уже стоявшее в строке до обновления, при правке не отклоняется; новое такое же отклоняется', async () => {
    const { app, svc } = await setup();
    const db = svc.db();
    await db.query(`update catalog_masking set keys = array['bankAccountId'] where project_id = 'pay' and type = 'passport'`);
    await svc.afterChange('pay');
    const row = (await rows(app)).find((r) => r.type === 'passport')!;
    expect((await edit(app, 'passport', { enabled: true, keys: ['bankAccountId', 'passport_alt'], updatedAt: row.updatedAt })).statusCode).toBe(200);
    const fresh = (await rows(app)).find((r) => r.type === 'passport')!;
    const refused = await edit(app, 'passport', { enabled: true, keys: ['bankAccountId', 'passport_alt', 'accountId'], updatedAt: fresh.updatedAt });
    expect(refused.statusCode).toBe(422);
    expect(fieldsOf(refused)).toContain('Номер счёта');
    expect(svc.masking('pay').strict.fields.get('bankaccountid')).toBe('account_number');
  });

  it('новый вид в новой версии: строка создана, правки других не тронуты; миграция убирает «Неизвестное»', async () => {
    const { app, svc } = await setup();
    const db = svc.db();
    const phone = (await rows(app)).find((r) => r.type === 'phone')!;
    expect((await edit(app, 'phone', { enabled: false, keys: [], updatedAt: phone.updatedAt })).statusCode).toBe(200);
    await db.query(`delete from catalog_masking where project_id = 'pay' and type = 'national_id'`);
    await store.ensureProject(db, 'pay', 'Demo Pay');
    const list = await store.loadSnapshot(db, 'pay');
    expect(list.masking!.find((r) => r.type === 'national_id')!.enabled).toBe(true);
    expect(list.masking!.find((r) => r.type === 'phone')!.enabled).toBe(false);
  });

  it('база со строками «Неизвестного»: установка удаляет их, записи справочника не трогает', async () => {
    const db = await openDb((await freshDatabase({ empty: true })) ?? 'pglite://memory');
    closers.push(() => db.close());
    const all = await readMigrations();
    const before = all.filter((m) => m.name < '0003');
    await migrate(db, before);
    await db.query(`insert into catalog_project (project_id) values ('pay')`);
    await db.query(`insert into catalog_system (project_id, key, kind, type, name) values ('pay', 'pay', 'project', 'service', 'Demo Pay')`);
    await db.query(`insert into catalog_unknown (project_id, key, kind, env, example_cid, example_ms, count, first_seen, last_seen, text) values ('pay', 'k', 'error', 'demo', 'c', 1, 1, now(), now(), 'звонить +447700900001')`);
    await migrate(db, all);
    expect((await db.query('select id from catalog_unknown')).length).toBe(0);
    expect((await db.query('select id from catalog_system')).length).toBe(1);
  });

  it('две копии: правку второй первая видит после опроса', async () => {
    const a = await setup();
    const b = await setup(a.url);
    const row = (await rows(b.app)).find((r) => r.type === 'phone')!;
    expect((await edit(b.app, 'phone', { enabled: false, keys: ['alt_phone'], updatedAt: row.updatedAt })).statusCode).toBe(200);
    expect(a.svc.masking('pay').shown.kinds.has('phone')).toBe(true);
    await a.svc.pollNow();
    expect(a.svc.masking('pay').shown.kinds.has('phone')).toBe(false);
    expect(a.svc.masking('pay').strict.fields.get('altphone')).toBe('phone');
  });
});

describe('настройка при недоступном справочнике', () => {
  it('справочник выключен: состояния по умолчанию, отпечаток в GET /api/catalog, форма state() прежняя', async () => {
    const { config } = await tempConfig({});
    const svc = service(config, undefined);
    const app = await buildApp({ config, backends: new Backends(config), catalog: svc, collector: new UnknownCollector(svc) });
    closers.push(() => app.close());
    expect(svc.masking('pay')).toBe(BUILTIN_MASKING);
    expect(Object.keys(svc.state()).sort()).toEqual(['loadedAt', 'message', 'state']);
    expect((await app.inject('/api/catalog')).json()).toMatchObject({ state: 'off', masking: { pay: BUILTIN_MASKING.stamp } });
  });

  it('состояния: connecting и ошибка без данных — все виды включены, stale — последняя настройка', async () => {
    const { app, svc, url } = await setup();
    const row = (await rows(app)).find((r) => r.type === 'phone')!;
    await edit(app, 'phone', { enabled: false, keys: [], updatedAt: row.updatedAt });
    expect(svc.masking('pay').shown.kinds.has('phone')).toBe(false);
    const { config } = await tempConfig({});
    const fresh = service(config, url);
    expect(fresh.state().state).toBe('connecting');
    expect(fresh.masking('pay')).toBe(ALL_KINDS_MASKING);
    const db = svc.db();
    const q = db.query.bind(db);
    db.query = () => Promise.reject(new Error('connection terminated'));
    await svc.pollNow();
    db.query = q;
    expect(svc.state().state).toBe('stale');
    expect(svc.masking('pay').shown.kinds.has('phone')).toBe(false);
    expect((await edit(app, 'phone', { enabled: true, keys: [], updatedAt: row.updatedAt })).statusCode).toBe(503);
  });
});

describe('API правки', () => {
  it('имя, повтор, поле другого вида, встроенное, секрет, предел, неизвестный вид, конфликт', async () => {
    const { app } = await setup();
    const row = (await rows(app)).find((r) => r.type === 'address')!;
    const send = (keys: string[], updatedAt = row.updatedAt) => edit(app, 'address', { enabled: true, keys, updatedAt });
    for (const k of ['bad name', '', 'x'.repeat(65)]) expect((await send([k])).statusCode, k).toBe(422);
    expect((await send(['phoneAlt', 'phone_alt'])).statusCode).toBe(422);
    const other = await send(['mobile_phone']);
    expect(fieldsOf(other)).toContain('Телефон');
    for (const k of ['password', 'my_app_password', 'Authorization']) expect(fieldsOf(await send([k]))).toContain('Секреты');
    expect(fieldsOf(await send(['pan']))).toContain('Номер карты');
    expect(fieldsOf(await send(['first_name']))).toContain('Имя и отчество');
    expect((await send(Array.from({ length: 201 }, (_, i) => `f_${i}`))).statusCode).toBe(422);
    const ok = await send(['post_address', 'client_home_addr']);
    expect(ok.statusCode).toBe(200);
    const saved = ok.json() as MaskingSaved;
    expect(saved.row.edited).toBe(true);
    expect(saved.row.keys).toEqual(['post_address', 'client_home_addr']);
    const conflict = await send(['x_y']);
    expect([conflict.statusCode, (conflict.json() as { error: { code: string; current: { updatedAt: string } } }).error.current.updatedAt]).toEqual([409, saved.row.updatedAt]);
    expect((await edit(app, 'snils', { enabled: true, keys: [], updatedAt: 't' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/projects/pay/catalog/masking', payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: '/api/projects/pay/catalog/masking/1?updatedAt=t' })).statusCode).toBe(404);
  });

  it('поле читает правило: readers в ответе, запись остаётся верной', async () => {
    const { app, svc } = await setup();
    const db = svc.db();
    const system = svc.snapshot('pay')!.systems[0]!;
    await store.insertMethod(db, 'pay', system.id, { http: 'GET', path: '/v9/read', rpc: '', name: 'M', domain: null, description: null, kind: 'call', op: null, fields: [{ in: 'request', path: 'data.client_alt', type: 'nope' }], status: null }, { edited: true, hidden: false });
    await svc.afterChange('pay');
    const row = (await rows(app)).find((r) => r.type === 'phone')!;
    const r = await edit(app, 'phone', { enabled: true, keys: ['client_alt'], updatedAt: row.updatedAt });
    expect((r.json() as MaskingSaved).readers).toBe(1);
  });

  it('старая строка с телефоном показана маской, значение в базе; выгрузка отклонена без значения', async () => {
    const { app, svc } = await setup();
    const db = svc.db();
    const system = svc.snapshot('pay')!.systems[0]!;
    await db.query(`update catalog_system set description = 'звонить +447700900001' where id = $1`, [system.id]);
    await svc.afterChange('pay');
    const r = await app.inject('/api/projects/pay/catalog');
    expect(r.body).not.toContain('447700900001');
    expect(r.body).toContain('********0001');
    expect((await db.query<{ description: string }>('select description from catalog_system where id = $1', [system.id]))[0]!.description).toContain('447700900001');
    const out = await app.inject('/api/projects/pay/catalog/export');
    expect(out.statusCode).toBe(422);
    expect(out.body).not.toContain('447700900001');
  });
});

describe('файл', () => {
  const FILE = (masking: unknown) => ({ version: 1, project: 'pay', masking });

  it('первая загрузка без force, ручная правка пропущена, с force применена; выгрузка обратно без изменений', async () => {
    const { app, svc } = await setup();
    const db = svc.db();
    const run = (input: unknown, o: { dryRun?: boolean; force?: boolean } = {}): Promise<ImportReport> => importCatalog(db, 'pay', 'Demo Pay', input, { dryRun: o.dryRun ?? false, force: o.force ?? false });
    const dry = await run(FILE([{ type: 'phone', enabled: false }, { type: 'address', enabled: true, keys: ['client_home_addr'] }]), { dryRun: true });
    expect(dry.changed.map((i) => i.key)).toEqual(['phone', 'address']);
    expect(dry.changed[0]!.disables).toBe(true);
    expect((await store.loadSnapshot(db, 'pay')).masking!.find((r) => r.type === 'phone')!.enabled).toBe(true);
    expect((await run(FILE([{ type: 'phone', enabled: false }]))).applied).toBe(true);
    const row = (await store.loadSnapshot(db, 'pay')).masking!.find((r) => r.type === 'phone')!;
    expect([row.enabled, row.edited]).toEqual([false, false]);
    await svc.afterChange('pay');
    const fresh = (await rows(app)).find((r) => r.type === 'phone')!;
    expect((await edit(app, 'phone', { enabled: false, keys: ['alt_phone'], updatedAt: fresh.updatedAt })).statusCode).toBe(200);
    const skipped = await run(FILE([{ type: 'phone', enabled: true }]));
    expect(skipped.skipped.map((i) => i.key)).toEqual(['phone']);
    expect((await run(FILE([{ type: 'phone', enabled: true }]), { force: true })).applied).toBe(true);
    await db.query(`insert into catalog_masking (project_id, type) values ('pay', 'snils')`);
    const yaml = await exportCatalogText(db, 'pay', 'yaml');
    expect(await exportCatalogText(db, 'pay', 'yaml')).toBe(yaml);
    expect(yaml).not.toContain('snils');
    const parsed = parseCatalogText(yaml);
    if (!parsed.ok) throw new Error('файл не разобран');
    const again = await run(parsed.value, { dryRun: true });
    expect(again.changed.concat(again.added, again.skipped)).toEqual([]);
    const json = parseCatalogText(await exportCatalogText(db, 'pay', 'json'), 'json');
    if (!json.ok) throw new Error('файл не разобран');
    expect(await run(json.value, { dryRun: true })).toEqual(again);
  });

  it('отчёт команды: значения нет, выключение вида отдельной строкой', () => {
    const lines = formatReport({ project: 'pay', dryRun: true, applied: false, added: [{ kind: 'method', key: 'k', title: 'звонить +447700900001' }], changed: [{ kind: 'masking', key: 'phone', title: 'Телефон', fields: ['enabled'], disables: true }], hidden: [], skipped: [], unchanged: 0, missing: 0, errors: [] }).join('\n');
    expect(lines).not.toContain('447700900001');
    expect(lines).toContain('вид «Телефон» выключается');
  });

  it('начальный набор без раздела настройку не меняет', async () => {
    const { svc } = await setup();
    expect(svc.masking('pay').stamp).toBe(BUILTIN_MASKING.stamp);
  });
});
