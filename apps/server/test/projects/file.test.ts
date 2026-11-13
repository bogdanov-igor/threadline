// Файл проекта на настоящем CatalogService и PGlite: версия и её сверка, раздел settings, права по разделам, маски проекта, команда и посев.
// Grafana не вызывается: хранилище в настройке недостижимо, условия проверяются статически. Значения выдуманы.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse, stringify } from 'yaml';
import type { ProjectSetting, ProjectSettingsResponse, ProjectsResponse } from '@threadline/core';
import type { Role } from '@threadline/core/access';
import type { ImportReport } from '@threadline/core/catalog';
import { projectFileJsonSchema } from '@threadline/core/catalog/project-file';
import { BUILTIN_MASKING, MASK_KIND_CODES, MASK_KINDS, maskKindsText, type MaskKind } from '@threadline/core/search';
import { DEFAULT_VIEW } from '@threadline/core/view';
import { convertFileText } from '../../../web/src/features/project-file/convert.ts';
import { buildApp } from '../../src/app.ts';
import { Backends } from '../../src/backends/registry.ts';
import { runCatalogCli } from '../../src/catalog/cli-run.ts';
import { openDb, type Db } from '../../src/catalog/db.ts';
import { exportCatalogText, FileVersionConflict, importCatalog, parseCatalogText } from '../../src/catalog/exchange.ts';
import { migrate } from '../../src/catalog/migrate.ts';
import type { CatalogService } from '../../src/catalog/service.ts';
import * as catalogStore from '../../src/catalog/store.ts';
import { readFileVersion } from '../../src/projects/file.ts';
import { ProjectsService } from '../../src/projects/service.ts';
import * as projectStore from '../../src/projects/store.ts';
import { CATALOG_YAML, service as catalogService } from '../catalog/fixture.ts';
import { freshDatabase, PG_URL } from '../catalog/pg.ts';
import { configFile, configYaml, logoFile, logoPair, PAY_PROJECT, pngBytes, projectYaml, TestCatalog } from './harness.ts';

const PAN = '4111111234557893';
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

interface Up {
  app: FastifyInstance;
  catalog: CatalogService;
  projects: ProjectsService;
}

async function up(yaml: string = configYaml({ projects: `${PAY_PROJECT}${projectYaml('acme')}` })): Promise<Up> {
  const config = await configFile(yaml);
  let catalog!: CatalogService;
  let projects!: ProjectsService;
  const app = await buildApp({
    config,
    backends: new Backends(config),
    logger: false,
    databaseUrl: 'pglite://memory',
    testViewer: (req) => ({ owner: 'test', role: (req.headers['x-test-role'] ?? 'admin') as Role, name: null }),
    onProjects: (s) => {
      projects = s;
    },
    onCatalog: (c) => {
      catalog = c;
    },
  });
  closers.push(() => app.close());
  for (let i = 0; i < 200 && catalog.state().state !== 'ok'; i++) await new Promise((r) => setTimeout(r, 25));
  expect(catalog.state().state).toBe('ok');
  return { app, catalog, projects };
}

type Doc = { version: number; project: string; settings: { name: string; timezone: string; retentionDays: number; format: string; environments: { id: string; name: string; kind?: string; backend: string; selector?: { label: string; op: string; value: string }[] }[]; view: typeof DEFAULT_VIEW }; systems?: { key: string; name: string; methods?: { http: string; path: string; name: string }[] }[]; masking?: { type: string; enabled: boolean; keys?: string[] }[] };

const as = (role: Role) => ({ 'x-test-role': role });
const qs = (o: Record<string, string | undefined>) => new URLSearchParams(Object.entries(o).filter((e): e is [string, string] => e[1] !== undefined)).toString();

async function exported(app: FastifyInstance, format: 'yaml' | 'json' = 'yaml', role: Role = 'admin') {
  const r = await app.inject({ url: `/api/projects/pay/catalog/export?format=${format}`, headers: as(role) });
  return { status: r.statusCode, text: r.body, version: r.headers['x-project-file-version'] as string, disposition: r.headers['content-disposition'] as string };
}
const docOf = async (app: FastifyInstance) => parse((await exported(app)).text) as Doc;
const check = (app: FastifyInstance, doc: unknown, opts: { role?: Role; force?: boolean } = {}) =>
  app.inject({ method: 'POST', url: `/api/projects/pay/catalog/import?${qs({ dryRun: '1', format: 'yaml', force: opts.force ? '1' : undefined })}`, headers: { ...as(opts.role ?? 'admin'), 'content-type': 'application/yaml' }, payload: typeof doc === 'string' ? doc : stringify(doc) });
const apply = (app: FastifyInstance, doc: unknown, baseVersion: string | undefined, opts: { role?: Role; force?: boolean } = {}) =>
  app.inject({ method: 'POST', url: `/api/projects/pay/catalog/import?${qs({ format: 'yaml', baseVersion, force: opts.force ? '1' : undefined })}`, headers: { ...as(opts.role ?? 'admin'), 'content-type': 'application/yaml' }, payload: typeof doc === 'string' ? doc : stringify(doc) });
const reportOf = (r: { statusCode: number; json: () => unknown }): ImportReport => (r.statusCode === 422 ? (r.json() as { error: { report: ImportReport } }).error.report : (r.json() as ImportReport));
const version = async (app: FastifyInstance, role: Role = 'admin') => (await app.inject({ url: '/api/projects/pay/file-version', headers: as(role) })).json<{ version: string }>().version;
const setting = async (app: FastifyInstance, id = 'pay'): Promise<ProjectSetting> => (await app.inject('/api/project-settings')).json<ProjectSettingsResponse>().projects.find((p) => p.id === id)!;
const formBody = (p: ProjectSetting, over: Record<string, unknown> = {}) => ({ name: p.name, timezone: p.timezone, retentionDays: p.retentionDays, format: p.format, environments: p.environments.map(({ id, name, kind, backend, selector, stand }) => ({ id, name, kind, backend, selector, ...(stand ? { stand } : {}) })), updatedAt: p.updatedAt, ...over });
const paths = (r: ImportReport) => r.errors.map((e) => e.path);

describe('версия файла проекта', () => {
  it('две выгрузки совпадают байт в байт, версия одна, файл называется по проекту', async () => {
    const { app } = await up();
    const a = await exported(app);
    const b = await exported(app);
    expect(a.status).toBe(200);
    expect(a.text).toBe(b.text);
    expect(a.version).toBe(b.version);
    expect(a.version).toMatch(/^\d+\|/);
    expect(a.disposition).toContain('pay-project.yaml');
    expect(await version(app)).toBe(a.version);
  });

  it('форма и вид меняют версию, другой проект нет, текст от версии не зависит', async () => {
    const { app } = await up();
    const v0 = await version(app);
    const acme = await setting(app, 'acme');
    expect((await app.inject({ method: 'PUT', url: '/api/projects/acme', payload: formBody(acme, { retentionDays: 31 }) })).statusCode).toBe(200);
    expect(await version(app)).toBe(v0);
    const before = (await exported(app)).text;
    const pay = await setting(app);
    expect((await app.inject({ method: 'PUT', url: '/api/projects/pay', payload: formBody(pay, { retentionDays: 31 }) })).statusCode).toBe(200);
    const v1 = await version(app);
    expect(v1).not.toBe(v0);
    const ob2 = await setting(app);
    expect((await app.inject({ method: 'PUT', url: '/api/projects/pay/view', payload: { view: { ...DEFAULT_VIEW, bodyView: 'raw' }, updatedAt: ob2.viewUpdatedAt } })).statusCode).toBe(200);
    expect(await version(app)).not.toBe(v1);
    expect((await exported(app)).text).not.toBe(before);
    expect(/^version: 1$/m.test((await exported(app)).text)).toBe(true);
  });

  it('отчёт проверки несёт версию, неразобранный файл нет, Бизнесу маршрут закрыт', async () => {
    const { app } = await up();
    const doc = await docOf(app);
    const v = await version(app);
    expect(reportOf(await check(app, doc)).version).toBe(v);
    doc.settings.retentionDays = 0;
    const invalid = reportOf(await check(app, doc));
    expect(paths(invalid)).toContain('settings.retentionDays');
    expect(invalid.version).toBe(v);
    const broken = await check(app, 'version: 1\nproject: [pay\n');
    expect(reportOf(broken).version).toBeUndefined();
    expect((await app.inject({ url: '/api/projects/pay/file-version', headers: as('business') })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/projects/pay/file-version', headers: as('support') })).statusCode).toBe(200);
  });
});

describe('сверка версии при применении', () => {
  it('без параметра и с неверным значением 400 до разбора файла', async () => {
    const { app } = await up();
    const none = await apply(app, 'не разбирается: [', undefined);
    expect([none.statusCode, none.json().error.code]).toEqual([400, 'bad-request']);
    expect(none.json().error.details).toContain('baseVersion');
    expect((await apply(app, 'не разбирается: [', 'abc')).statusCode).toBe(400);
  });

  it('совпала: применено; устарела: 409 с текущей версией, ничего не записано', async () => {
    const { app } = await up();
    const { version: base, text } = await exported(app);
    const doc = parse(text) as Doc;
    doc.settings.retentionDays = 77;
    const ok = await apply(app, doc, base);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(reportOf(ok).applied).toBe(true);
    expect((await setting(app)).retentionDays).toBe(77);

    const now = await version(app);
    expect(now).not.toBe(base);
    doc.settings.retentionDays = 88;
    const stale = await apply(app, doc, base);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toMatchObject({ code: 'project-file-conflict', version: now });
    expect((await setting(app)).retentionDays).toBe(77);
    expect(await version(app)).toBe(now);
  });

  it('коллега сохранил форму, файл меняет только методы: 409', async () => {
    const { app } = await up();
    const { version: base, text } = await exported(app);
    const p = await setting(app);
    await app.inject({ method: 'PUT', url: '/api/projects/pay', payload: formBody(p, { name: 'Другое название' }) });
    const doc = parse(text) as Doc;
    const { settings: _s, ...withoutSettings } = doc;
    expect((await apply(app, { ...withoutSettings, systems: [{ key: 'x', name: 'Система X' }] }, base)).statusCode).toBe(409);
    expect((await docOf(app)).systems?.some((s) => s.key === 'x')).toBeFalsy();
  });

  it('проверка не сверяет версию, а гонка двух применений даёт один 409', async () => {
    const { app } = await up();
    const { version: base, text } = await exported(app);
    const a = parse(text) as Doc;
    a.settings.retentionDays = 41;
    const b = parse(text) as Doc;
    b.settings.retentionDays = 42;
    const results = await Promise.all([apply(app, a, base), apply(app, b, base)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const again = await app.inject({ method: 'POST', url: `/api/projects/pay/catalog/import?dryRun=1&baseVersion=${encodeURIComponent(base)}`, headers: { 'content-type': 'application/yaml' }, payload: text });
    expect(again.statusCode).toBe(200);
  });

  it('первое применение в пустой справочник без ложного 409 и версия не растёт, когда применять нечего', async () => {
    const db = await openDb('pglite://memory');
    closers.push(() => db.close());
    await migrate(db);
    const base = await readFileVersion(db, 'fresh');
    const file = { version: 1, project: 'fresh', systems: [{ key: 'x', name: 'X' }] };
    const r = await importCatalog(db, 'fresh', 'Fresh', file, { dryRun: false, force: false, baseVersion: base });
    expect(r.applied).toBe(true);
    const v = await readFileVersion(db, 'fresh');
    expect(v).not.toBe(base);
    const same = await importCatalog(db, 'fresh', 'Fresh', file, { dryRun: false, force: false, baseVersion: v });
    expect(same.applied).toBe(false);
    expect(await readFileVersion(db, 'fresh')).toBe(v);
    await expect(importCatalog(db, 'fresh', 'Fresh', file, { dryRun: false, force: false, baseVersion: base })).rejects.toBeInstanceOf(FileVersionConflict);
  });
});

describe('раздел настроек проекта', () => {
  it('выгрузка: раздел сразу после project, без логотипа и секретов; обратно без изменений', async () => {
    const { app } = await up();
    const { text } = await exported(app);
    expect(Object.keys(parse(text) as object).slice(0, 3)).toEqual(['version', 'project', 'settings']);
    expect(JSON.stringify((parse(text) as Doc).settings)).not.toMatch(/token|grafana\.|logo|updatedAt|hidden/i);
    const r = reportOf(await check(app, text));
    expect(r.errors).toEqual([]);
    expect([...r.added, ...r.changed, ...r.hidden]).toEqual([]);
  });

  it('старое значение, которое форма не примет, не мешает обратной загрузке и правке справочника', async () => {
    const { app, catalog, projects } = await up();
    const db = catalog.readDb()!;
    const row = (await projectStore.readProject(db, 'pay'))!;
    const environments = row.environments.map((e) => (e.id === 'demo' ? { ...e, selector: [{ label: 'namespace', op: '=' as const, value: ' край ' }] } : e));
    await projectStore.updateProject(db, { ...row, environments }, { hiddenBy: null, fromFile: true, edited: true, fileHash: row.fileHash });
    await projects.afterCommit();
    const doc = await docOf(app);
    const same = reportOf(await check(app, doc));
    expect(same.errors).toEqual([]);
    expect(same.changed).toEqual([]);
    doc.systems = [{ key: 'x', name: 'Система X' }];
    const r = reportOf(await check(app, doc));
    expect(r.errors).toEqual([]);
    expect(r.added.map((i) => i.key)).toContain('x');
  });

  it('файла без раздела настройки не касаются, в том числе правами', async () => {
    const { app } = await up();
    const r = reportOf(await check(app, CATALOG_YAML, { role: 'developer' }));
    expect(r.errors).toEqual([]);
    expect([...r.added, ...r.changed].some((i) => ['settings', 'environment', 'view'].includes(i.kind))).toBe(false);
  });

  it('граница хранилища: путь и то же сообщение, что на форме, ни один раздел не применён', async () => {
    const { app } = await up();
    const { text, version: base } = await exported(app);
    const doc = parse(text) as Doc;
    doc.settings.environments[0]!.selector = [{ label: 'namespace', op: '=', value: 'чужой' }];
    doc.systems = [{ key: 'x', name: 'X' }];
    const form = await app.inject({ method: 'PUT', url: '/api/projects/pay', payload: formBody(await setting(app), { environments: doc.settings.environments.map((e) => ({ kind: 'single', selector: [], ...e })) }) });
    const formMessage = (form.json().error.fields as Record<string, string>)['environments.0.selector.0.value'];
    const r = reportOf(await apply(app, doc, base));
    expect(r.applied).toBe(false);
    expect(r.errors.find((e) => e.path === 'settings.environments.0.selector.0.value')?.message).toBe(formMessage);
    expect((await docOf(app)).systems?.some((s) => s.key === 'x')).toBeFalsy();
  });

  it.each([
    ['занятый идентификатор среды', (d: Doc) => void d.settings.environments.push({ id: 'catalog', name: 'Занятая', backend: 'demo', selector: [{ label: 'namespace', op: '=', value: 'x' }] }), 'settings.environments.3.id'],
    ['неизвестное хранилище', (d: Doc) => void (d.settings.environments[0]!.backend = 'nope'), 'settings.environments.0.backend'],
    ['вкладка по умолчанию выключена', (d: Doc) => void Object.assign(d.settings.view, { defaultTab: 'records', tabs: { scheme: { full: true, brief: true }, records: { full: false, brief: false } } }), 'settings.view.defaultTab'],
    ['срок хранения', (d: Doc) => void (d.settings.retentionDays = 500), 'settings.retentionDays'],
    ['неизвестный профиль', (d: Doc) => void (d.settings.format = 'nope'), 'settings.format'],
    ['профиль не строка', (d: Doc) => void ((d.settings as { format: unknown }).format = { layers: [] }), 'settings.format'],
  ])('%s: ошибка с путём', async (_name, edit, path) => {
    const { app } = await up();
    const doc = await docOf(app);
    edit(doc);
    const r = reportOf(await check(app, doc));
    expect(paths(r)).toContain(path);
    if (path === 'settings.format') expect(r.errors.find((e) => e.path === path)?.message).toContain('acme-json');
    if (path.endsWith('.backend')) expect(r.errors.find((e) => e.path === path)?.message).toContain('grafana');
  });

  it.each([
    ['url', 'settings.environments.0.url'],
    ['token', 'settings.environments.0.token'],
    ['tokenEnv', 'settings.environments.0.tokenEnv'],
    ['datasource', 'settings.environments.0.datasource'],
  ])('поле %s у среды отклонено', async (field, path) => {
    const { app } = await up();
    const doc = await docOf(app);
    Object.assign(doc.settings.environments[0]!, { [field]: 'x' });
    expect(paths(reportOf(await check(app, doc)))).toContain(path);
  });

  it.each([
    ['settings.logo', { logo: { light: 'x' } }],
    ['settings.backends', { backends: {} }],
    ['settings.formats', { formats: {} }],
    ['settings.id', { id: 'pay' }],
    ['settings.hidden', { hidden: true }],
    ['settings.updatedAt', { updatedAt: 'x' }],
  ])('%s: неизвестное поле', async (path, extra) => {
    const { app } = await up();
    const doc = await docOf(app);
    Object.assign(doc.settings, extra);
    expect(paths(reportOf(await check(app, doc)))).toContain(path);
  });

  it('раздел backends на верхнем уровне и view: null отклонены', async () => {
    const { app } = await up();
    const doc = await docOf(app);
    expect(paths(reportOf(await check(app, { ...doc, backends: {} })))).toContain('backends');
    expect(paths(reportOf(await check(app, { ...doc, settings: { ...doc.settings, view: null } })))).toContain('settings.view');
  });

  it('раздел без вида вид не меняет; только вид: метка проекта и отметка на месте, метка вида новая', async () => {
    const { app } = await up();
    const before = await setting(app);
    const { text, version: base } = await exported(app);
    const doc = parse(text) as Doc;
    const { view: _v, ...noView } = doc.settings;
    expect(reportOf(await check(app, { ...doc, settings: noView })).changed).toEqual([]);
    doc.settings.view = { ...doc.settings.view, bodyView: 'raw' };
    const r = reportOf(await apply(app, doc, base));
    expect(r.changed).toEqual([{ kind: 'view', key: 'view', title: 'Вид', fields: ['bodyView'] }]);
    const after = await setting(app);
    expect(after.view.bodyView).toBe('raw');
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.fileState).toBe(before.fileState);
    expect(after.viewUpdatedAt).not.toBe(before.viewUpdatedAt);
  });

  it('среду стёрли: она остаётся, считается в «нет в файле» и порядок не меняется', async () => {
    const { app } = await up();
    const { text, version: base } = await exported(app);
    const doc = parse(text) as Doc;
    const ids = doc.settings.environments.map((e) => e.id);
    doc.settings.environments = doc.settings.environments.filter((e) => e.id !== ids[1]);
    const only = reportOf(await check(app, doc));
    expect(only.changed).toEqual([]);
    expect(only.missing).toBe(1);
    expect(only.missingEnvironments).toBe(1);
    doc.settings.retentionDays = 55;
    const r = reportOf(await apply(app, doc, base));
    expect(r.changed.map((i) => i.key)).toEqual(['settings']);
    expect((await setting(app)).environments.map((e) => e.id)).toEqual(ids);
    expect(((await docOf(app)).settings.environments).map((e) => e.id)).toEqual(ids);
  });

  it('раздел стёрли целиком: настройки на месте, строк нет', async () => {
    const { app } = await up();
    const { settings: _s, ...doc } = await docOf(app);
    const r = reportOf(await check(app, doc));
    expect(r.errors).toEqual([]);
    expect(r.missing).toBe(0);
    expect(r.changed).toEqual([]);
  });

  it('перестановка сред: изменение порядка, файл задаёт порядок, неназванные за ним', async () => {
    const { app } = await up();
    const { text, version: base } = await exported(app);
    const doc = parse(text) as Doc;
    const [a, b, c] = doc.settings.environments;
    doc.settings.environments = [c!, a!];
    const r = reportOf(await apply(app, doc, base));
    expect(r.changed.some((i) => i.kind === 'environment' && i.key === 'order')).toBe(true);
    expect((await setting(app)).environments.map((e) => e.id)).toEqual([c!.id, a!.id, b!.id]);
  });

  it('смена условий и профиля: строка говорит про поиски, значений в отчёте нет', async () => {
    const { app } = await up();
    const doc = await docOf(app);
    doc.settings.environments[0]!.selector = [{ label: 'namespace', op: '=', value: 'pay-test' }];
    doc.settings.format = 'acme-json';
    const r = reportOf(await check(app, doc));
    expect(r.errors).toEqual([]);
    const env = r.changed.find((i) => i.kind === 'environment')!;
    expect(env.stopsSearches).toBe(true);
    expect(env.fields).toEqual(['selector']);
    expect(r.changed.find((i) => i.kind === 'settings')).toMatchObject({ fields: ['format'], stopsSearches: true });
    expect(JSON.stringify(r)).not.toContain('pay-test');
  });

  it('название: система-автор идёт за ним, а явное имя в файле побеждает; новый снимок сразу действует', async () => {
    const { app } = await up();
    const first = await exported(app);
    const doc = parse(first.text) as Doc;
    doc.settings.name = 'Новое имя';
    expect((await apply(app, doc, first.version)).statusCode).toBe(200);
    expect((await docOf(app)).systems?.find((s) => s.key === 'pay')?.name).toBe('Новое имя');
    expect((await app.inject('/api/projects')).json<ProjectsResponse>().projects.find((p) => p.id === 'pay')?.name).toBe('Новое имя');

    const second = await exported(app);
    const next = parse(second.text) as Doc;
    next.settings.name = 'Ещё имя';
    next.systems!.find((s) => s.key === 'pay')!.name = 'Своё имя системы';
    expect((await apply(app, next, second.version)).statusCode).toBe(200);
    expect((await docOf(app)).systems?.find((s) => s.key === 'pay')?.name).toBe('Своё имя системы');
  });

  it('отметка «Правится здесь» как у формы: правка ставит, возврат к файлу снимает', async () => {
    const { app } = await up();
    const one = await exported(app);
    const original = (parse(one.text) as Doc).settings.retentionDays;
    const doc = parse(one.text) as Doc;
    doc.settings.retentionDays = original + 1;
    await apply(app, doc, one.version);
    expect((await setting(app)).fileState).toBe('here');
    const two = await exported(app);
    const back = parse(two.text) as Doc;
    back.settings.retentionDays = original;
    await apply(app, back, two.version);
    expect((await setting(app)).fileState).toBe('same');
  });

  it('замена ручных правок на раздел не действует: без force раздел применяется', async () => {
    const { app } = await up();
    const { text, version: base } = await exported(app);
    const doc = parse(text) as Doc;
    doc.settings.retentionDays = 66;
    const r = reportOf(await apply(app, doc, base));
    expect(r.skipped).toEqual([]);
    expect(r.changed.map((i) => i.kind)).toEqual(['settings']);
  });

  it('одна транзакция: метод упёрся в другую запись, настройки и маскирование не изменились', async () => {
    const { app } = await up();
    const seed = await exported(app);
    const seeded = parse(seed.text) as Doc;
    seeded.systems = [{ key: 'x', name: 'X', methods: [{ http: 'GET', path: '/a', name: 'A' }] }];
    expect((await apply(app, seeded, seed.version)).statusCode).toBe(200);
    const snap = (await app.inject('/api/projects/pay/catalog')).json<{ systems: { id: number; key: string }[]; methods: { id: number; path: string; updatedAt: string }[] }>();
    const method = snap.methods.find((m) => m.path === '/a')!;
    const sys = snap.systems.find((s) => s.key === 'x')!;
    // Метод с записи файла уехал на другой путь, а на старом появился ручной: возврат пути файлом упрётся в него.
    expect((await app.inject({ method: 'PUT', url: `/api/projects/pay/catalog/methods/${method.id}`, payload: { systemId: sys.id, http: 'GET', path: '/b', name: 'A', updatedAt: method.updatedAt } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/projects/pay/catalog/methods', payload: { systemId: sys.id, http: 'GET', path: '/a', name: 'Ручной' } })).statusCode).toBe(201);

    const now = await exported(app);
    const doc = parse(now.text) as Doc;
    doc.settings.retentionDays = 99;
    doc.masking!.find((m) => m.type === 'email')!.enabled = true;
    doc.systems!.find((s) => s.key === 'x')!.methods = [{ http: 'GET', path: '/a', name: 'Из файла' }];
    const before = await setting(app);
    const r = await apply(app, doc, now.version, { force: true });
    expect(r.statusCode).toBe(422);
    const report = reportOf(r);
    expect(report.applied).toBe(false);
    expect(report.errors[0]!.message).toContain('файл не применён');
    expect(report.version).toBe(now.version);
    expect((await setting(app)).retentionDays).toBe(before.retentionDays);
    expect((await docOf(app)).masking!.find((m) => m.type === 'email')!.enabled).toBe(false);
    expect(await version(app)).toBe(now.version);
  });
});

describe('запись настроек файлом', () => {
  it('логотип и его хэш не меняются, поиски останавливаются как при сохранении формы, хранилище не вызывается', async () => {
    const db = await openDb('pglite://memory');
    closers.push(() => db.close());
    await migrate(db);
    const config = await configFile(configYaml({ projects: PAY_PROJECT }));
    const dropScope = vi.fn();
    const catalog = new TestCatalog(db);
    const backends = new Backends(config);
    const probe = vi.spyOn(backends, 'probe');
    const service = new ProjectsService({ config, profiles: new Map(), backends, log: { info: () => undefined, warn: () => undefined }, effects: { dropScope } });
    service.attach(catalog);
    await service.sync(db);
    const logo = logoPair(logoFile(pngBytes(), 'hash-light'));
    await projectStore.replaceLogo(db, 'pay', logo);
    const base = await readFileVersion(db, 'pay');

    const row = (await projectStore.readProject(db, 'pay'))!;
    const environments = row.environments.map((e) => ({ id: e.id, name: e.name, kind: e.kind, backend: e.backend, selector: e.selector, ...(e.stand ? { stand: e.stand } : {}) }));
    const prod = environments.find((e) => e.id === 'prod')!;
    prod.selector = [{ label: 'namespace', op: '=', value: 'pay-test' }];
    const file = { version: 1, project: 'pay', settings: { name: row.name, timezone: row.timezone, retentionDays: row.retentionDays, format: row.format, environments } };
    const r = await importCatalog(db, 'pay', row.name, file, { dryRun: false, force: false, settings: service.fileContext(), baseVersion: base });
    expect(r.errors).toEqual([]);
    expect(r.applied).toBe(true);
    await service.afterCommit();

    expect(dropScope).toHaveBeenCalledWith('pay', 'prod');
    expect(probe).not.toHaveBeenCalled();
    expect((await projectStore.readLogos(db)).get('pay')?.light.hash).toBe('hash-light');
    expect(catalog.lists.at(-1)).toContain('pay');
    expect(service.settings().projects.find((p) => p.id === 'pay')?.environments.find((e) => e.id === 'prod')?.selector[0]?.value).toBe('pay-test');
  });

  it('журнал: ни тело запроса, ни значение из него не пишутся', async () => {
    const config = await configFile(configYaml({ projects: PAY_PROJECT }));
    const lines: string[] = [];
    let catalog!: CatalogService;
    const app = await buildApp({
      config,
      backends: new Backends(config),
      logger: {
        stream: new Writable({
          write(chunk, _encoding, done) {
            lines.push(String(chunk));
            done();
          },
        }),
      },
      databaseUrl: 'pglite://memory',
      onCatalog: (c) => {
        catalog = c;
      },
    });
    closers.push(() => app.close());
    for (let i = 0; i < 200 && catalog.state().state !== 'ok'; i++) await new Promise((res) => setTimeout(res, 25));
    const doc = await docOf(app);
    doc.systems = [{ key: 'x', name: `Карта ${PAN}` }];
    await check(app, doc);
    const version = (await exported(app)).version;
    await apply(app, doc, version);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('')).not.toContain(PAN);
    expect(lines.join('')).not.toContain('Карта');
  });
});

describe('права на разделы файла', () => {
  it('разработчик: настройки и маскирование закрыты, оба названы, справочник открыт', async () => {
    const { app } = await up();
    const { text, version: base } = await exported(app);
    const doc = parse(text) as Doc;
    doc.settings.retentionDays = 11;
    const settingsOnly = reportOf(await check(app, doc, { role: 'developer' }));
    expect(paths(settingsOnly)).toEqual(['settings']);
    doc.masking!.find((m) => m.type === 'email')!.enabled = true;
    const both = reportOf(await apply(app, doc, base, { role: 'developer' }));
    expect(paths(both).sort()).toEqual(['masking', 'settings']);
    expect(both.applied).toBe(false);

    const same = parse(text) as Doc;
    same.systems = [{ key: 'x', name: 'X' }];
    const ok = await apply(app, same, base, { role: 'developer' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(reportOf(ok).applied).toBe(true);
  });

  it('раздел без права, но с ошибкой правил: называется право, а не ошибка поля', async () => {
    const { app } = await up();
    const doc = await docOf(app);
    doc.settings.retentionDays = 500;
    expect(paths(reportOf(await check(app, doc, { role: 'developer' })))).toEqual(['settings']);
  });

  it('аналитик меняет настройки; с маскированием файл отклонён целиком', async () => {
    const { app } = await up();
    const { text, version: base } = await exported(app);
    const doc = parse(text) as Doc;
    doc.settings.retentionDays = 12;
    doc.systems = [{ key: 'x', name: 'X' }];
    doc.masking!.find((m) => m.type === 'email')!.enabled = true;
    expect(paths(reportOf(await apply(app, doc, base, { role: 'analyst' })))).toEqual(['masking']);
    expect((await setting(app)).retentionDays).not.toBe(12);
    doc.masking!.find((m) => m.type === 'email')!.enabled = false;
    expect(reportOf(await apply(app, doc, base, { role: 'analyst' })).applied).toBe(true);
    expect((await setting(app)).retentionDays).toBe(12);
  });

  it('администратор меняет всё одной транзакцией; поддержка и Бизнес получают 403 до разбора', async () => {
    const { app } = await up();
    const { text, version: base } = await exported(app);
    const doc = parse(text) as Doc;
    doc.settings.retentionDays = 13;
    doc.systems = [{ key: 'x', name: 'X' }];
    doc.masking!.find((m) => m.type === 'email')!.enabled = true;
    expect(reportOf(await apply(app, doc, base)).applied).toBe(true);
    expect((await check(app, 'не разбирается: [', { role: 'support' })).statusCode).toBe(403);
    expect((await check(app, 'не разбирается: [', { role: 'business' })).statusCode).toBe(403);
    expect((await exported(app, 'yaml', 'support')).status).toBe(200);
    expect((await exported(app, 'yaml', 'business')).status).toBe(403);
  });
});

describe('значения и настройка маскирования проекта', () => {
  const email = 'someone@mail.example';

  it('вид не включён: значение проходит; включён файлом: ошибка с путём этой записи и без значения', async () => {
    const { app } = await up();
    const doc = await docOf(app);
    doc.systems = [{ key: 'x', name: `Контакт ${email}` }];
    expect(reportOf(await check(app, doc)).errors).toEqual([]);
    doc.masking!.find((m) => m.type === 'email')!.enabled = true;
    const r = await check(app, doc);
    expect(paths(reportOf(r))).toContain('systems.0.name');
    expect(r.body).not.toContain(email);
  });

  it('в базе значение под видом, включённым потом: выгрузка отклонена с путём и без значения', async () => {
    const { app } = await up();
    const one = await exported(app);
    const doc = parse(one.text) as Doc;
    doc.systems = [{ key: 'x', name: `Контакт ${email}` }];
    expect((await apply(app, doc, one.version)).statusCode).toBe(200);
    const two = await exported(app);
    expect(two.status).toBe(200);
    const on = parse(two.text) as Doc;
    on.masking!.find((m) => m.type === 'email')!.enabled = true;
    on.systems!.find((s) => s.key === 'x')!.name = 'Без значения';
    expect((await apply(app, on, two.version)).statusCode).toBe(200);
    const three = await exported(app);
    expect(three.status).toBe(200);
    // Значение, записанное в обход файла, такое же, как старая строка базы.
    const snap = (await app.inject('/api/projects/pay/catalog')).json<{ systems: { id: number; key: string; updatedAt: string; kind: string; type: string; hosts: string[] }[] }>();
    const sys = snap.systems.find((s) => s.key === 'x')!;
    await app.inject({ method: 'PUT', url: `/api/projects/pay/catalog/systems/${sys.id}`, payload: { key: 'x', kind: sys.kind, type: sys.type, name: 'Система', hosts: [], description: `Контакт ${email}`, updatedAt: sys.updatedAt } });
    const blocked = await exported(app);
    expect(blocked.status).toBe(422);
    expect(blocked.text).not.toContain(email);
  });

  it('встроенная маска не слабеет при выключенном виде; номер карты в настройках: путь от settings, без значения', async () => {
    const { app } = await up();
    const doc = await docOf(app);
    const phone = doc.masking!.find((m) => m.type === 'phone')!;
    phone.enabled = false;
    doc.systems = [{ key: 'x', name: 'phone=+447700900123' }];
    expect(paths(reportOf(await check(app, doc)))).toContain('systems.0.name');

    const clean = await docOf(app);
    clean.settings.environments[0]!.name = `Среда ${PAN}`;
    clean.settings.environments[1]!.selector = [{ label: 'namespace', op: '=', value: PAN }];
    const r = await check(app, clean);
    const list = paths(reportOf(r));
    expect(list).toContain('settings.environments.0.name');
    expect(list).toContain('settings.environments.1.selector.0.value');
    expect(r.body).not.toContain(PAN);
  });

  it('примеры поиска: номер карты и телефон в значениях — как ввод строки поиска, выгрузка и обратная загрузка работают; подпись проверяется', async () => {
    const { app } = await up();
    const doc = await docOf(app);
    doc.masking!.find((m) => m.type === 'phone')!.enabled = true;
    // Подпись строкой и по языкам: обе формы проходят выгрузку и загрузку как есть.
    const examples = [
      { label: 'Карта', values: [PAN] },
      { label: { ru: 'Телефон', en: 'Phone' }, values: ['+447700900123'], period: '24h' },
    ];
    (doc.settings.environments[0] as Record<string, unknown>).examples = examples;
    const one = await exported(app);
    expect((await apply(app, doc, one.version)).statusCode).toBe(200);
    const two = await exported(app);
    expect(two.status).toBe(200);
    expect((parse(two.text) as { settings: { environments: { examples?: unknown }[] } }).settings.environments[0]!.examples).toEqual(examples);
    const same = reportOf(await check(app, two.text));
    expect(same.errors).toEqual([]);
    expect(same.changed).toEqual([]);

    const bad = parse(two.text) as { settings: { environments: { examples: { label: string }[] }[] } };
    bad.settings.environments[0]!.examples[0]!.label = `Карта ${PAN}`;
    const r = await check(app, bad);
    // Маска файла и правило подписи примера называют одно поле.
    expect([...new Set(paths(reportOf(r)))]).toEqual(['settings.environments.0.examples.0.label']);
    expect(r.body).not.toContain(PAN);
  });

  it('настройка вида и раздел masking не проверяются', async () => {
    const { app } = await up();
    const doc = await docOf(app);
    doc.masking!.find((m) => m.type === 'phone')!.keys = ['client_mobile_alt'];
    doc.systems = [{ key: 'x', name: 'X' }];
    expect(reportOf(await check(app, doc)).errors).toEqual([]);
  });
});

describe('форматы и схема', () => {
  it('преобразование в браузере совпадает с выгрузкой сервера байт в байт', async () => {
    const { app } = await up();
    const one = await exported(app);
    const doc = parse(one.text) as Doc & { systems: unknown[] };
    doc.systems = [{ key: 'x', name: 'Система «X»', hosts: ['x.pay.example:8080'], methods: [{ http: 'GET', path: '/v1/{id}', name: 'Метод', hidden: true }] }, { key: 'y', name: 'Скрытая', hidden: true }];
    expect((await apply(app, doc, one.version)).statusCode).toBe(200);
    const yamlText = (await exported(app, 'yaml')).text;
    const jsonText = (await exported(app, 'json')).text;
    expect(yamlText).toContain('settings:');
    expect(yamlText).toContain('hidden: true');
    expect(convertFileText(yamlText, 'yaml', 'json')).toBe(jsonText);
    expect(convertFileText(jsonText, 'json', 'yaml')).toBe(yamlText);
  });

  it('схема описывает раздел и совпадает с файлом в репозитории', async () => {
    const schema = projectFileJsonSchema() as { properties: Record<string, { description?: string; additionalProperties?: unknown; properties?: Record<string, unknown> }> };
    expect(Object.keys(schema.properties).slice(0, 4)).toEqual(['$schema', 'version', 'project', 'settings']);
    expect(schema.properties.settings!.description).toContain('Токенов');
    expect(schema.properties.settings!.additionalProperties).toBe(false);
    const root = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
    expect(JSON.parse(await readFile(join(root, 'config/catalog/catalog.schema.json'), 'utf8'))).toEqual(schema);
  });
});

describe('предупреждения в ответе проверки', () => {
  it('поле без действия и повтор в JSON доходят до страницы, файл применяется', async () => {
    const { app } = await up();
    const text = '{"version":1,"project":"pay","systems":[{"key":"bus","type":"queue","name":"Шина","name":"Шина 2"}]}';
    const post = (q: string) => app.inject({ method: 'POST', url: `/api/projects/pay/catalog/import?${q}`, headers: { 'content-type': 'application/json' }, payload: text });
    const dry = reportOf(await post('dryRun=1'));
    expect(dry.errors).toEqual([]);
    expect(dry.warnings).toMatchObject([
      { path: 'systems.0.name', key: 'catalog.duplicateField' },
      { path: 'systems.0.type', key: 'catalog.queueNoSteps' },
    ]);
    const done = reportOf(await post(`baseVersion=${encodeURIComponent(await version(app))}`));
    expect(done.applied).toBe(true);
    expect(done.added.map((i) => i.title)).toContain('Шина 2');
  });

  it('рядом с ошибкой файла: отказ называет и ошибку, и предупреждение; типы entity без значений под маской', async () => {
    const { app } = await up();
    const r = reportOf(await check(app, { version: 1, project: 'pay', idTypes: [{ key: 'user', kind: 'entity', name: 'Клиент' }], systems: [{ key: 'x' }] }));
    expect(paths(r)).toEqual(['systems.0.name']);
    expect(r.warnings).toMatchObject([{ path: 'idTypes.0.kind', params: { types: 'user' } }]);
  });
});

describe('посев и файл без записи проекта', () => {
  it('начальный набор с разделом settings: раздел пропущен с предупреждением, остальное применено', async () => {
    const db = await openDb('pglite://memory');
    closers.push(() => db.close());
    await migrate(db);
    const parsed = parseCatalogText(`version: 1\nproject: pay\nsettings: { name: X }\nsystems:\n  - { key: x, name: X }\n`);
    if (!parsed.ok) throw new Error('fixture');
    const r = await importCatalog(db, 'pay', 'Demo Pay', parsed.value, { dryRun: false, force: false, seedHash: 'h' });
    expect(paths(r)).toEqual([]);
    expect(r.warnings).toMatchObject([{ path: 'settings', key: 'catalog.settingsInSeed' }]);
    expect(r.applied).toBe(true);
    expect(r.added.map((i) => i.key)).toContain('x');
    expect(await catalogStore.seedHash(db, 'pay')).toBe('h');
    expect(await projectStore.readProject(db, 'pay')).toBeNull();
  });

  it('начальный набор не меняет настроенное маскирование; неверный раздел набор не держит', async () => {
    const db = await openDb('pglite://memory');
    closers.push(() => db.close());
    await migrate(db);
    await catalogStore.lockProject(db, 'pay');
    await catalogStore.ensureProject(db, 'pay', 'Demo Pay');
    await catalogStore.writeMasking(db, 'pay', 'phone', false, [], false);
    const r = await importCatalog(db, 'pay', 'Demo Pay', { version: 1, project: 'pay', masking: [{ type: 'phone', enabled: true }, { type: 'нет такого', enabled: 1 }] }, { dryRun: false, force: false, seedHash: 'h' });
    expect(paths(r)).toEqual([]);
    expect(r.warnings).toMatchObject([{ path: 'masking', key: 'catalog.maskingInSeed' }]);
    expect((await catalogStore.getMasking(db, 'pay', 'phone'))?.enabled).toBe(false);
    expect(await catalogStore.seedHash(db, 'pay')).toBe('h');
  });

  it('начальный набор: значение под маской в разделе settings останавливает набор, как и раньше', async () => {
    const db = await openDb('pglite://memory');
    closers.push(() => db.close());
    await migrate(db);
    const r = await importCatalog(db, 'pay', 'Demo Pay', { version: 1, project: 'pay', settings: { name: PAN } }, { dryRun: false, force: false, seedHash: 'h' });
    expect(paths(r)).toEqual(['settings.name']);
    expect(r.applied).toBe(false);
  });

  it('выгрузка с разделом settings годится как начальный набор: настройки не меняются, повтор ничего не делает', async () => {
    const { app, catalog } = await up();
    const text = (await exported(app)).text;
    expect(text).toContain('settings:');
    const before = await projectStore.readProject(catalog.db(), 'pay');
    const parsed = parseCatalogText(text.replace(/^(\s+name: )Demo Pay$/m, '$1Другое название'));
    if (!parsed.ok) throw new Error('fixture');
    const r = await importCatalog(catalog.db(), 'pay', 'Demo Pay', parsed.value, { dryRun: false, force: false, seedHash: 'h' });
    expect(r.errors).toEqual([]);
    expect(r.warnings?.map((w) => w.path)).toEqual(expect.arrayContaining(['settings', 'masking']));
    expect((await projectStore.readProject(catalog.db(), 'pay'))?.name).toBe(before?.name);
  });

  it('файла настроек без справочника: выгрузка без раздела, загрузка с разделом даёт ошибку с путём', async () => {
    const db = await openDb('pglite://memory');
    closers.push(() => db.close());
    await migrate(db);
    const config = await configFile(configYaml());
    const ctx = { backends: config.backends, formats: Object.keys(config.config.formats), file: { projects: config.config.projects, logos: new Map() } };
    const r = await importCatalog(db, 'nowhere', 'X', { version: 1, project: 'nowhere', settings: { name: 'X' } }, { dryRun: true, force: false, settings: ctx });
    expect(paths(r)).toEqual(['settings']);
  });
});

describe.skipIf(!PG_URL)('команда threadline:catalog', () => {
  async function cli(extra: string) {
    const dir = dirname((await configFile(configYaml({ projects: PAY_PROJECT }))).path);
    const yamlPath = join(dir, 'threadline.yaml');
    const url = (await freshDatabase())!;
    const env = { THREADLINE_CONFIG: yamlPath, THREADLINE_DATABASE_URL: url, THREADLINE_PROJECTS_TEST_TOKEN: 'x' };
    const run = async (argv: string[]) => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await runCatalogCli(argv, { env, cwd: dir, out: (l) => out.push(l), err: (l) => err.push(l) });
      return { code, out: out.join('\n'), err: err.join('\n') };
    };
    await mkdir(join(dir, 'x'), { recursive: true });
    await writeFile(join(dir, 'f.yaml'), extra);
    return { run, dir, url };
  }

  it('запись проекта ещё нет: выгрузка без раздела с предупреждением, загрузка с разделом код 1', async () => {
    const { run, dir } = await cli('version: 1\nproject: pay\nsettings: { name: X, timezone: Asia/Karachi, retentionDays: 1, format: json, environments: [] }\n');
    const ex = await run(['export', 'pay', 'out.yaml']);
    expect(ex.code).toBe(0);
    expect(ex.err).toContain('без раздела settings');
    expect(await readFile(join(dir, 'out.yaml'), 'utf8')).not.toContain('settings:');
    const imp = await run(['import', 'pay', 'f.yaml']);
    expect(imp.code).toBe(1);
    expect(imp.out).toContain('settings');
  });

  it('запись есть: те же проверки и пути, что у маршрута, сверки нет, отчёт называет поля', async () => {
    const { run, dir, url } = await cli('');
    const db: Db = await openDb(url);
    closers.push(() => db.close());
    await migrate(db);
    const config = await configFile(configYaml({ projects: PAY_PROJECT }));
    const p = config.config.projects.pay!;
    await projectStore.insertProject(db, { id: 'pay', name: p.name, timezone: p.timezone, retentionDays: p.retentionDays, format: p.format, environments: Object.entries(p.environments).map(([id, e]) => ({ ...e, id })) }, 0, { hiddenBy: null, fromFile: true, edited: false, fileHash: null });
    expect((await run(['export', 'pay', 'out.yaml'])).code).toBe(0);
    const doc = parse(await readFile(join(dir, 'out.yaml'), 'utf8')) as Doc;
    expect(doc.settings.name).toBe('Demo Pay');

    doc.settings.environments[0]!.selector = [{ label: 'namespace', op: '=', value: 'чужой' }];
    await writeFile(join(dir, 'bad.yaml'), stringify(doc));
    const bad = await run(['import', 'pay', 'bad.yaml']);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain('settings.environments.0.selector.0.value');

    const good = parse(await readFile(join(dir, 'out.yaml'), 'utf8')) as Doc;
    good.settings.retentionDays = 21;
    await writeFile(join(dir, 'good.yaml'), stringify(good));
    const dry = await run(['import', 'pay', 'good.yaml', '--dry-run']);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain('настройки проекта');
    expect(dry.out).toContain('retentionDays');
    expect((await run(['import', 'pay', 'good.yaml'])).code).toBe(0);
    expect((await projectStore.readProject(db, 'pay'))!.retentionDays).toBe(21);
  });
});

describe('посев через сервис', () => {
  it('новая база и набор, который выключает маску: встроенные маски, телефон скрыт, справочник применён', async () => {
    const config = await configFile(configYaml({ projects: PAY_PROJECT }));
    const dir = dirname(config.path);
    await mkdir(join(dir, 'catalog'));
    await writeFile(join(dir, 'catalog', 'pay.yaml'), 'version: 1\nproject: pay\nmasking:\n  - { type: phone, enabled: false }\n  - { type: first_name, enabled: true, keys: [nick] }\nsystems:\n  - { key: x, name: X }\n');
    const logs = { info: [] as string[], warn: [] as string[] };
    const svc = catalogService(config, 'pglite://memory', logs);
    closers.push(() => svc.close());
    await svc.start();
    expect(svc.state().state).toBe('ok');
    expect(logs.info.join('\n')).toContain('masking: начальный набор не меняет маскирование');
    expect(logs.warn).toEqual([]);
    const snapshot = await catalogStore.loadSnapshot(svc.db(), 'pay');
    expect(snapshot.systems.map((s) => s.key)).toContain('x');
    expect(snapshot.masking?.filter((m) => m.enabled !== MASK_KINDS[m.type as MaskKind].defaultEnabled || m.keys.length > 0)).toEqual([]);
    expect(svc.masking('pay').stamp).toBe(BUILTIN_MASKING.stamp);
    expect(maskKindsText('{"phone":"+447700900123"}', svc.masking('pay').strict, new Set())).not.toContain('447700900123');
    const out = parse(await exportCatalogText(svc.db(), 'pay', 'yaml')) as Doc;
    expect(out.masking?.map((m) => [m.type, m.enabled])).toEqual(MASK_KIND_CODES.map((t) => [t, MASK_KINDS[t].defaultEnabled]));
    expect(out.masking?.find((m) => m.type === 'phone')?.enabled).toBe(true);
  });

  it('набор с разделом settings: журнал называет путь, справочник применён, сервер работает', async () => {
    const config = await configFile(configYaml({ projects: PAY_PROJECT }));
    const dir = dirname(config.path);
    await mkdir(join(dir, 'catalog'));
    await writeFile(join(dir, 'catalog', 'pay.yaml'), 'version: 1\nproject: pay\nsettings: { name: X }\nsystems:\n  - { key: x, type: queue, name: X }\n');
    const logs = { info: [] as string[], warn: [] as string[] };
    const svc = catalogService(config, 'pglite://memory', logs);
    closers.push(() => svc.close());
    await svc.start();
    expect(svc.state().state).toBe('ok');
    expect(logs.info.join('\n')).toContain('settings: начальный набор не меняет настройки');
    expect(logs.info.join('\n')).toContain('systems.0.type');
    expect(logs.warn).toEqual([]);
    expect((await catalogStore.loadSnapshot(svc.db(), 'pay')).systems.map((s) => s.key)).toContain('x');
  });
});
