// API проектов: правка, скрытие, удаление, источник запроса, ответы без секретов, среды без хранилища.
// Grafana только поддельная: ноль запросов проверяется на её счётчике.

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectSetting, ProjectSettingsResponse, ProjectsResponse } from '@threadline/core';
import type { LinesQuery, LogBackend, LogLine } from '@threadline/core/backend';
import { buildApp } from '../../src/app.ts';
import { Backends } from '../../src/backends/registry.ts';
import { openDb, type Db } from '../../src/catalog/db.ts';
import { migrate } from '../../src/catalog/migrate.ts';
import { sameOrigin } from '../../src/auth/access.ts';
import * as store from '../../src/projects/store.ts';
import { fakeGrafana, grafana85 } from '../fake-grafana.ts';
import { configFile, configYaml, NAMESPACES, PAY_PROJECT, projectYaml, stand, type Stand, TOKEN_ENV } from './harness.ts';

let db: Db;
let open: FastifyInstance[] = [];
let grafana: Awaited<ReturnType<typeof fakeGrafana>>;

const up = async (yaml: string = configYaml({ url: grafana.url }), env?: Record<string, string>): Promise<Stand> => {
  const s = await stand(db, yaml, env ? { env } : {});
  open.push(s.app);
  return s;
};

beforeEach(async () => {
  db = await openDb('pglite://memory');
  await migrate(db);
  grafana = await fakeGrafana(grafana85({ values: NAMESPACES }));
});

afterEach(async () => {
  for (const a of open) await a.close();
  open = [];
  await db.close();
  await grafana.close();
});

const body = (over: Record<string, unknown> = {}) => ({
  id: 'acme',
  name: 'Acme',
  timezone: 'Asia/Karachi',
  retentionDays: 30,
  format: 'json',
  environments: [{ id: 'demo', name: 'Демо', kind: 'single', backend: 'demo', selector: [{ label: 'namespace', op: '=', value: 'acme' }] }],
  ...over,
});

const post = (app: FastifyInstance, url: string, payload: unknown, headers: Record<string, string> = {}) => app.inject({ method: 'POST', url, payload: payload as object, headers });
const put = (app: FastifyInstance, url: string, payload: unknown) => app.inject({ method: 'PUT', url, payload: payload as object });
const settings = async (app: FastifyInstance) => (await app.inject('/api/project-settings')).json<ProjectSettingsResponse>();
const setting = async (app: FastifyInstance, id: string): Promise<ProjectSetting> => (await settings(app)).projects.find((p) => p.id === id)!;
const list = async (app: FastifyInstance) => (await app.inject('/api/projects')).json<ProjectsResponse>();
const codeOf = (r: { json: () => { error: { code: string } } }) => r.json().error.code;
const edited = (p: ProjectSetting, over: Record<string, unknown> = {}) => ({ name: p.name, timezone: p.timezone, retentionDays: p.retentionDays, format: p.format, environments: p.environments, updatedAt: p.updatedAt, ...over });

describe('источник запроса', () => {
  it.each([
    [undefined, 'x', true],
    ['https://x', 'x:443', true],
    ['http://x', 'x:80', true],
    ['https://x:443', 'x', true],
    ['http://localhost:5173', 'localhost:5173', true],
    ['https://evil.example', 'x', false],
    ['null', 'x', false],
    ['not a url', 'x', false],
    ['file:///etc', 'x', false],
    ['http://x:8080', 'x', false],
  ])('Origin %s и Host %s', (origin, host, ok) => {
    expect(sameOrigin(origin, host)).toBe(ok);
  });

  it('чужой источник, Origin: null и простая форма отклонены, без Origin проходит', async () => {
    const { app } = await up();
    for (const origin of ['https://evil.example', 'null', '%%%']) {
      const r = await post(app, '/api/projects', body(), { origin, host: 'localhost' });
      expect([r.statusCode, codeOf(r)]).toEqual([403, 'forbidden']);
    }
    const form = await app.inject({ method: 'POST', url: '/api/projects', headers: { 'content-type': 'text/plain' }, payload: JSON.stringify(body()) });
    expect(form.statusCode).toBe(415);
    const urlencoded = await app.inject({ method: 'POST', url: '/api/projects', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'id=acme' });
    expect(urlencoded.statusCode).toBe(415);
    expect((await list(app)).projects.map((p) => p.id)).toEqual(['pay']);
    expect((await post(app, '/api/projects', body())).statusCode).toBe(201);
    expect((await post(app, '/api/projects', body({ id: 'same' }), { origin: 'http://localhost:5173', host: 'localhost:5173' })).statusCode).toBe(201);
  });

  it('прокси разработки сохраняет Host: иначе pnpm dev не мог бы сохранять', async () => {
    const text = await readFile(resolve(import.meta.dirname, '../../../web/vite.config.ts'), 'utf8');
    expect(text).toMatch(/changeOrigin:\s*false/);
  });
});

describe('настройки для страниц', () => {
  it('без токена, адреса, источника и сертификата; переменная из пробелов — не задан', async () => {
    const yaml = configYaml({ url: 'https://grafana.secret.example' });
    const { app } = await up(yaml, { [TOKEN_ENV]: '   ' });
    const text = (await app.inject('/api/project-settings')).body;
    for (const banned of ['grafana.secret.example', 'datasource', 'caFile', 'https://']) expect(text).not.toContain(banned);
    const s = JSON.parse(text) as ProjectSettingsResponse;
    expect(s.stores.find((x) => x.id === 'grafana')).toEqual({ id: 'grafana', type: 'loki-grafana', tokenEnv: TOKEN_ENV, tokenSet: false, scope: expect.objectContaining({ label: 'namespace' }) });
    expect(s.stores.find((x) => x.id === 'demo')).toEqual({ id: 'demo', type: 'mock', scope: null });
    expect(s.formats).toEqual(['acme-json']);
    expect(s.editable).toBe(true);
    expect(s.state).toBe('ok');
  });

  it('токен есть: значения нет ни в настройках, ни в списке', async () => {
    const { app } = await up(configYaml(), { [TOKEN_ENV]: 'синтетический-токен' });
    const s = await app.inject('/api/project-settings');
    expect(s.body).not.toContain('синтетический-токен');
    expect(s.json<ProjectSettingsResponse>().stores.find((x) => x.id === 'grafana')?.tokenSet).toBe(true);
    const l = await app.inject('/api/projects');
    expect(l.body).not.toContain('синтетический-токен');
    expect(l.body).not.toContain('selector');
  });
});

describe('создание и правка', () => {
  it('создание: сразу в списке, автор справочника есть, запросов к Grafana нет', async () => {
    const { app } = await up();
    const r = await post(app, '/api/projects', body());
    expect(r.statusCode).toBe(201);
    expect(r.json<ProjectSetting>()).toMatchObject({ id: 'acme', fileState: 'none', hidden: null });
    expect((await list(app)).projects.map((p) => p.id)).toEqual(['pay', 'acme']);
    expect(await db.query('select key, name from catalog_system where project_id = $1', ['acme'])).toEqual([{ key: 'acme', name: 'Acme' }]);
    expect(await store.readProject(db, 'acme')).toMatchObject({ fromFile: false, edited: true, fileHash: null });
    expect(grafana.requests).toHaveLength(0);
  });

  it('повтор идентификатора, в том числе скрытого', async () => {
    const { app } = await up();
    await post(app, '/api/projects', body());
    let r = await post(app, '/api/projects', body());
    expect([r.statusCode, codeOf(r)]).toEqual([409, 'project-duplicate']);
    const a = await setting(app, 'acme');
    await put(app, '/api/projects/acme/visibility', { hidden: true, updatedAt: a.updatedAt });
    r = await post(app, '/api/projects', body());
    expect(codeOf(r)).toBe('project-duplicate');
  });

  it('ошибки с путями полей, значения в ответе под маской, номер карты не сохранён', async () => {
    const { app } = await up();
    const r = await post(app, '/api/projects', body({ name: 'карта 4111111111111111', environments: [{ id: 'demo', name: 'Д', kind: 'single', backend: 'demo', selector: [{ label: 'a b', op: '~~', value: 'x' }] }] }));
    expect(r.statusCode).toBe(422);
    expect(Object.keys(r.json<{ error: { fields: Record<string, string> } }>().error.fields)).toContain('environments.0.selector.0.op');
    const named = await post(app, '/api/projects', body({ name: 'карта 4111111111111111' }));
    expect(named.json<{ error: { fields: Record<string, string> } }>().error.fields.name).toContain('скрываемые');
    expect(named.body).not.toContain('4111111111111111');
    expect(await store.readProject(db, 'acme')).toBe(null);
  });

  it('условие !~ принято и сохранено как есть', async () => {
    const { app } = await up();
    const selector = [{ label: 'namespace', op: '=', value: 'acme' }, { label: 'container', op: '!~', value: 'worker-.*' }];
    const r = await post(app, '/api/projects', body({ environments: [{ id: 'demo', name: 'Демо', kind: 'single', backend: 'demo', selector }] }));
    expect(r.statusCode).toBe(201);
    expect(r.json<ProjectSetting>().environments[0]!.selector).toEqual(selector);
  });

  it('другой id в теле правки отклонён, проект не меняется', async () => {
    const { app } = await up();
    const p = await setting(app, 'pay');
    const r = await put(app, '/api/projects/pay', edited(p, { id: 'other', name: 'Другое' }));
    expect(r.statusCode).toBe(422);
    expect((await setting(app, 'pay')).name).toBe('Demo Pay');
  });

  it('устаревшая метка: конфликт со свежей записью; удалённый: 404', async () => {
    const { app } = await up();
    await post(app, '/api/projects', body());
    const was = await setting(app, 'acme');
    expect((await put(app, '/api/projects/acme', edited(was, { name: 'Первый' }))).statusCode).toBe(200);
    const stale = await put(app, '/api/projects/acme', edited(was, { name: 'Второй' }));
    expect([stale.statusCode, codeOf(stale)]).toEqual([409, 'project-conflict']);
    expect(stale.json<{ error: { current: ProjectSetting } }>().error.current.name).toBe('Первый');
    const fresh = await setting(app, 'acme');
    await put(app, '/api/projects/acme/visibility', { hidden: true, updatedAt: fresh.updatedAt });
    const hidden = await setting(app, 'acme');
    await app.inject({ method: 'DELETE', url: `/api/projects/acme?confirm=acme&updatedAt=${encodeURIComponent(hidden.updatedAt!)}` });
    const gone = await put(app, '/api/projects/acme', edited(hidden));
    expect([gone.statusCode, codeOf(gone)]).toEqual([404, 'project-not-found']);
  });

  it('ничего не изменилось: метка версии и отметка прежние', async () => {
    const { app } = await up();
    const p = await setting(app, 'pay');
    const r = await put(app, '/api/projects/pay', edited(p));
    expect(r.statusCode).toBe(200);
    expect(r.json<ProjectSetting>()).toMatchObject({ updatedAt: p.updatedAt, fileState: 'same' });
  });

  it('смена названия переименовывает непроправленного автора', async () => {
    const { app } = await up();
    await post(app, '/api/projects', body());
    await put(app, '/api/projects/acme', edited(await setting(app, 'acme'), { name: 'Новое' }));
    expect(await db.query('select name from catalog_system where project_id = $1', ['acme'])).toEqual([{ name: 'Новое' }]);
    expect((await list(app)).projects.find((p) => p.id === 'acme')?.name).toBe('Новое');
  });

  it('правка скрытого проекта не показывает его', async () => {
    const { app } = await up();
    await post(app, '/api/projects', body());
    await put(app, '/api/projects/acme/visibility', { hidden: true, updatedAt: (await setting(app, 'acme')).updatedAt });
    const r = await put(app, '/api/projects/acme', edited(await setting(app, 'acme'), { name: 'Новое' }));
    expect(r.json<ProjectSetting>()).toMatchObject({ name: 'Новое', hidden: 'page' });
    expect((await list(app)).projects.map((p) => p.id)).toEqual(['pay']);
    expect((await list(app)).hidden).toEqual([{ id: 'acme', name: 'Новое' }]);
  });

  it('предел 100 проектов, в том числе скрытых; введённое не сохранено', async () => {
    const { app } = await up();
    const first = await store.readProject(db, 'pay');
    for (let i = 0; i < 99; i++) await store.insertProject(db, { ...first!, id: `p${i}` }, i + 1, { hiddenBy: 'page', fromFile: false, edited: true, fileHash: null });
    const r = await post(app, '/api/projects', body());
    expect([r.statusCode, codeOf(r)]).toEqual([409, 'project-limit']);
  });

  it.each(['off', 'stale', 'connecting', 'error'] as const)('правка закрыта при состоянии %s: 503, ничего не изменилось', async (state) => {
    const s = await up();
    const p = await setting(s.app, 'pay');
    s.catalog.current = state;
    const r = await put(s.app, '/api/projects/pay', edited(p, { name: 'Новое' }));
    expect([r.statusCode, codeOf(r)]).toEqual([503, 'project-readonly']);
    expect(codeOf(await post(s.app, '/api/projects', body()))).toBe('project-readonly');
    s.catalog.current = 'ok';
    expect((await setting(s.app, 'pay')).name).toBe('Demo Pay');
  });

  it('тело больше 1 МБ отклонено', async () => {
    const { app } = await up();
    const r = await app.inject({ method: 'POST', url: '/api/projects', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(body({ name: 'я'.repeat(1_100_000) })) });
    expect(r.statusCode).toBe(413);
  });

  it('новая среда и порядок сред доезжают до списка на следующий запрос', async () => {
    const { app } = await up();
    await post(app, '/api/projects', body());
    const p = await setting(app, 'acme');
    const next = { id: 'stage', name: 'Стейдж', kind: 'single', backend: 'demo', selector: [{ label: 'namespace', op: '=', value: 'acme' }] };
    await put(app, '/api/projects/acme', edited(p, { environments: [next, ...p.environments] }));
    expect((await list(app)).projects.find((x) => x.id === 'acme')?.environments.map((e) => e.id)).toEqual(['stage', 'demo']);
  });
});

describe('скрытие и удаление', () => {
  const yaml = () => configYaml({ url: grafana.url, projects: PAY_PROJECT + projectYaml('acme') });

  it('скрытый: нет в списке, API отвечает как о неизвестном; показ возвращает', async () => {
    const { app } = await up(yaml());
    const p = await setting(app, 'acme');
    const r = await put(app, '/api/projects/acme/visibility', { hidden: true, updatedAt: p.updatedAt });
    expect(r.json<ProjectSetting>().hidden).toBe('page');
    expect((await list(app)).projects.map((x) => x.id)).toEqual(['pay']);
    expect((await app.inject('/api/projects/acme/envs/demo/connection')).statusCode).toBe(404);
    const h = await setting(app, 'acme');
    await put(app, '/api/projects/acme/visibility', { hidden: false, updatedAt: h.updatedAt });
    expect((await list(app)).hidden).toEqual([]);
    expect((await app.inject('/api/projects/acme/envs/demo/connection')).statusCode).toBe(200);
  });

  it('устаревшая метка при скрытии: тот же конфликт', async () => {
    const { app } = await up(yaml());
    const p = await setting(app, 'acme');
    await put(app, '/api/projects/acme', edited(p, { name: 'Другое' }));
    const r = await put(app, '/api/projects/acme/visibility', { hidden: true, updatedAt: p.updatedAt });
    expect(codeOf(r)).toBe('project-conflict');
    expect((await setting(app, 'acme')).hidden).toBe(null);
  });

  it('два одновременных скрытия при двух проектах оставляют один видимый', async () => {
    const { app } = await up(yaml());
    const [a, b] = [await setting(app, 'pay'), await setting(app, 'acme')];
    const out = await Promise.all([put(app, '/api/projects/pay/visibility', { hidden: true, updatedAt: a.updatedAt }), put(app, '/api/projects/acme/visibility', { hidden: true, updatedAt: b.updatedAt })]);
    expect(out.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(codeOf(out.find((r) => r.statusCode === 409)!)).toBe('project-last');
    expect((await list(app)).projects).toHaveLength(1);
  });

  it('последний рабочий рядом с неверными скрыть нельзя', async () => {
    const s = await up(yaml());
    await db.query(`update project set format = 'gone' where id = 'acme'`);
    await store.bumpVersion(db);
    await s.service.poll(db);
    const p = await setting(s.app, 'pay');
    expect(codeOf(await put(s.app, '/api/projects/pay/visibility', { hidden: true, updatedAt: p.updatedAt }))).toBe('project-last');
  });

  it('удаление видимого и с неверным подтверждением отклонено, предпросмотр считает записи, каскад убирает справочник', async () => {
    const { app } = await up(yaml());
    await db.query(`insert into catalog_method (project_id, system_id, http_method, path, path_key, name) select 'acme', id, 'GET', '/x', '/x', 'М' from catalog_system where project_id = 'acme'`);
    await db.query(`insert into catalog_masking (project_id, type) values ('acme', 'test_kind') on conflict do nothing`);
    const visible = await setting(app, 'acme');
    let r = await app.inject({ method: 'DELETE', url: `/api/projects/acme?confirm=acme&updatedAt=${encodeURIComponent(visible.updatedAt!)}` });
    expect([r.statusCode, codeOf(r)]).toEqual([409, 'project-not-hidden']);
    await put(app, '/api/projects/acme/visibility', { hidden: true, updatedAt: visible.updatedAt });
    const hidden = await setting(app, 'acme');
    r = await app.inject({ method: 'DELETE', url: `/api/projects/acme?confirm=wrong&updatedAt=${encodeURIComponent(hidden.updatedAt!)}` });
    expect(r.statusCode).toBe(422);
    expect((await app.inject('/api/projects/acme/delete-preview')).json()).toEqual({ systems: 1, methods: 1, errors: 0, unknown: 0 });
    expect((await store.readProject(db, 'acme'))?.hiddenBy).toBe('page');

    r = await app.inject({ method: 'DELETE', url: `/api/projects/acme?confirm=acme&updatedAt=${encodeURIComponent(hidden.updatedAt!)}` });
    expect(r.statusCode).toBe(204);
    expect(await store.readProject(db, 'acme')).toBe(null);
    expect(await db.query('select 1 from catalog_project where project_id = $1', ['acme'])).toEqual([]);
    expect(await db.query('select 1 from catalog_system where project_id = $1', ['acme'])).toEqual([]);
    expect(await db.query('select 1 from catalog_method where project_id = $1', ['acme'])).toEqual([]);
    expect(await db.query('select 1 from catalog_masking where project_id = $1', ['acme'])).toEqual([]);
    expect((await setting(app, 'pay')).id).toBe('pay');
    expect((await settings(app)).ignoredInFile).toEqual(['acme']);
    expect((await app.inject('/api/projects/acme/envs/demo/connection')).statusCode).toBe(404);
  });

  it('запрет не даёт вернуться из файла, новое создание снимает его', async () => {
    const first = await up(yaml());
    const v = await setting(first.app, 'acme');
    await put(first.app, '/api/projects/acme/visibility', { hidden: true, updatedAt: v.updatedAt });
    const h = await setting(first.app, 'acme');
    await first.app.inject({ method: 'DELETE', url: `/api/projects/acme?confirm=acme&updatedAt=${encodeURIComponent(h.updatedAt!)}` });

    const second = await up(yaml());
    expect((await settings(second.app)).ignoredInFile).toEqual(['acme']);
    expect(await store.readProject(db, 'acme')).toBe(null);

    expect((await post(second.app, '/api/projects', body({ name: 'Заново' }))).statusCode).toBe(201);
    expect((await settings(second.app)).ignoredInFile).toEqual([]);
    expect(await db.query('select name from catalog_system where project_id = $1', ['acme'])).toEqual([{ name: 'Заново' }]);
    const third = await up(yaml());
    const again = await setting(third.app, 'acme');
    expect(again).toMatchObject({ name: 'Заново', fileState: 'file-newer' });
  });

  it('«Взять из файла» и «Оставить» из состояния file-newer', async () => {
    const first = await up(yaml());
    await put(first.app, '/api/projects/acme', edited(await setting(first.app, 'acme'), { name: 'Со страницы' }));
    const changed = configYaml({ url: grafana.url, projects: PAY_PROJECT + projectYaml('acme', 'Из файла 2') });
    const second = await up(changed);
    const stale = await setting(second.app, 'acme');
    expect(stale.fileState).toBe('file-newer');

    const keep = await post(second.app, '/api/projects/acme/file-version', { action: 'keep', updatedAt: stale.updatedAt });
    expect(keep.json<ProjectSetting>()).toMatchObject({ name: 'Со страницы', fileState: 'here' });
    const third = await up(configYaml({ url: grafana.url, projects: PAY_PROJECT + projectYaml('acme', 'Из файла 3') }));
    const again = await setting(third.app, 'acme');
    expect(again.fileState).toBe('file-newer');

    const take = await post(third.app, '/api/projects/acme/file-version', { action: 'take', updatedAt: again.updatedAt });
    expect(take.json<ProjectSetting>()).toMatchObject({ name: 'Из файла 3', fileState: 'same' });
    expect(await store.readProject(db, 'acme')).toMatchObject({ edited: false });
  });

  it('«Показать» убранный из файла: остаётся видимым после перезапуска', async () => {
    await up(yaml());
    const only = configYaml({ url: grafana.url });
    const second = await up(only);
    const removed = await setting(second.app, 'acme');
    expect(removed).toMatchObject({ hidden: 'file', fileState: 'removed' });
    await put(second.app, '/api/projects/acme/visibility', { hidden: false, updatedAt: removed.updatedAt });
    const third = await up(only);
    expect(await setting(third.app, 'acme')).toMatchObject({ hidden: null, fileState: 'none' });
    expect((await list(third.app)).projects.map((p) => p.id)).toEqual(['pay', 'acme']);
  });
});

describe('среда без хранилища', () => {
  const OLD = '  old:\n    type: mock\n';

  it('хранилище убрано из файла: список 200, поиск и стенды «не настроено», остальные работают, запросов нет', async () => {
    const first = await up(configYaml({ url: grafana.url, backendsExtra: OLD }));
    await post(first.app, '/api/projects', body({ environments: [{ id: 'gone', name: 'Старая', kind: 'single', backend: 'old', selector: [{ label: 'namespace', op: '=', value: 'acme' }] }, { id: 'demo', name: 'Демо', kind: 'single', backend: 'demo', selector: [{ label: 'namespace', op: '=', value: 'acme' }] }] }));
    const second = await up(configYaml({ url: grafana.url }));
    const l = await second.app.inject('/api/projects');
    expect(l.statusCode).toBe(200);
    const envs = l.json<ProjectsResponse>().projects.find((p) => p.id === 'acme')!.environments;
    expect(envs[0]).toEqual({ id: 'gone', name: 'Старая', kind: 'single', notConfigured: true, missingStore: 'old' });
    expect(envs[1]).toMatchObject({ id: 'demo', backendType: 'mock', notConfigured: false });

    const conn = await second.app.inject('/api/projects/acme/envs/gone/connection');
    expect(conn.statusCode).toBe(200);
    expect(conn.json()).toMatchObject({ status: 'not-configured', missingStore: 'old' });
    const search = await post(second.app, '/api/projects/acme/envs/gone/searches', { terms: ['x'], period: { preset: '1h' } });
    expect([search.statusCode, codeOf(search)]).toEqual([409, 'not-configured']);
    expect((await second.app.inject('/api/projects/acme/envs/gone/stands')).statusCode).toBe(409);
    expect((await second.app.inject('/api/projects/acme/envs/demo/connection')).json()).toMatchObject({ status: 'demo' });
    expect((await setting(second.app, 'acme')).environments[0]).toMatchObject({ missingStore: 'old' });
    expect(grafana.requests).toHaveLength(0);
  });

  it('хранилище вернули: среда снова работает', async () => {
    const first = await up(configYaml({ url: grafana.url, backendsExtra: OLD }));
    await post(first.app, '/api/projects', body({ environments: [{ id: 'gone', name: 'Старая', kind: 'single', backend: 'old', selector: [{ label: 'namespace', op: '=', value: 'acme' }] }] }));
    await up(configYaml({ url: grafana.url }));
    const third = await up(configYaml({ url: grafana.url, backendsExtra: OLD }));
    expect((await third.app.inject('/api/projects/acme/envs/gone/connection')).json()).toMatchObject({ status: 'demo' });
  });
});

describe('поиски при правке', () => {
  const TWO = `  pay:
    name: Demo Pay
    environments:
      prod:
        name: Прод
        backend: grafana
        selector:
          - { label: namespace, op: '=', value: pay }
      dev:
        name: Дев
        backend: grafana
        selector:
          - { label: namespace, op: '=', value: pay-test }
`;
  const MOCKS = `  pay:
    name: Demo Pay
    environments:
      demo:
        name: Демо
        backend: demo
        selector:
          - { label: namespace, op: '=', value: pay }
      copy:
        name: Копия
        backend: demo
        selector:
          - { label: namespace, op: '=', value: pay }
`;
  const DEMO_DEFAULTS = '{ project: pay, environment: demo }';
  const search = async (app: FastifyInstance, env: string, terms = ['lookup'], project = 'pay') => {
    const r = await post(app, `/api/projects/${project}/envs/${env}/searches`, { terms, period: { preset: '24h' } });
    expect(r.statusCode, r.body).toBe(200);
    return r.json<{ id: string; cached: boolean }>();
  };
  const statusOf = async (app: FastifyInstance, id: string) => {
    const r = await app.inject(`/api/searches/${id}`);
    return r.statusCode === 200 ? r.json<{ status: string }>().status : codeOf(r);
  };
  const done = (app: FastifyInstance, id: string) => expect.poll(() => statusOf(app, id), { timeout: 10_000 }).toBe('done');
  const envOf = (p: ProjectSetting, id: string) => p.environments.find((e) => e.id === id)!;
  const withSelector = (p: ProjectSetting, id: string, value: string) => p.environments.map((e) => (e.id === id ? { ...e, selector: [{ label: 'namespace', op: '=', value }] } : e));

  it('смена селектора останавливает идущий поиск и прерывает его запросы, чужая среда не задета', async () => {
    // Запросы к логам зависают: поиск остаётся идущим, пока его не остановят.
    const known = grafana85({ values: NAMESPACES });
    const hanging = await fakeGrafana((req, res, rec) => {
      if (/\/loki\/api\/v1\/query/.test(req.url ?? '')) return;
      known(req, res, rec);
    });
    try {
      const { app } = await up(configYaml({ url: hanging.url, projects: TWO }));
      const prod = await search(app, 'prod');
      const dev = await search(app, 'dev');
      await expect.poll(() => hanging.requests.filter((r) => r.url.includes('/loki/api/v1/query')).length).toBeGreaterThanOrEqual(2);
      const p = await setting(app, 'pay');
      expect((await put(app, '/api/projects/pay', edited(p, { environments: withSelector(p, 'prod', 'pay-pr-1') }))).statusCode).toBe(200);
      expect(await statusOf(app, prod.id)).toBe('search-expired');
      expect(await statusOf(app, dev.id)).toBe('running');
      await expect.poll(() => hanging.requests.filter((r) => r.closedEarly).length).toBeGreaterThanOrEqual(1);
      const decoded = (r: { url: string }) => decodeURIComponent(r.url);
      expect(hanging.requests.filter((r) => r.closedEarly).every((r) => decoded(r).includes('pay'))).toBe(true);
      expect(hanging.requests.filter((r) => decoded(r).includes('pay-test')).some((r) => r.closedEarly)).toBe(false);
      await post(app, `/api/searches/${dev.id}/cancel`, {});
    } finally {
      await hanging.close();
    }
  });

  it('повтор в течение минуты идёт заново только после смены селектора; название и срок поиски не трогают', async () => {
    const { app } = await up(configYaml({ projects: MOCKS, defaults: DEMO_DEFAULTS }));
    const first = await search(app, 'demo');
    await done(app, first.id);
    expect(await search(app, 'demo')).toEqual({ id: first.id, cached: true });

    let p = await setting(app, 'pay');
    expect((await put(app, '/api/projects/pay', edited(p, { name: 'Новое', retentionDays: 7 }))).statusCode).toBe(200);
    expect(await search(app, 'demo')).toEqual({ id: first.id, cached: true });
    expect(await statusOf(app, first.id)).toBe('done');

    p = await setting(app, 'pay');
    expect((await put(app, '/api/projects/pay', edited(p, { environments: withSelector(p, 'demo', 'pay-test') }))).statusCode).toBe(200);
    expect(await statusOf(app, first.id)).toBe('search-expired');
    expect((await search(app, 'demo')).cached).toBe(false);
  });

  it('смена профиля останавливает все среды проекта, скрытие и удаление тоже убирают результаты', async () => {
    const { app } = await up(configYaml({ projects: MOCKS + projectYaml('acme'), defaults: DEMO_DEFAULTS }));
    const a = await search(app, 'demo');
    const b = await search(app, 'copy');
    const other = await search(app, 'demo', ['lookup'], 'acme');
    let p = await setting(app, 'pay');
    expect((await put(app, '/api/projects/pay', edited(p, { format: 'acme-json' }))).statusCode).toBe(200);
    expect([await statusOf(app, a.id), await statusOf(app, b.id)]).toEqual(['search-expired', 'search-expired']);
    expect(await statusOf(app, other.id)).not.toBe('search-expired');

    p = await setting(app, 'pay');
    const again = await search(app, 'demo');
    await put(app, '/api/projects/pay/visibility', { hidden: true, updatedAt: p.updatedAt });
    expect(await statusOf(app, again.id)).toBe('search-expired');
    expect(codeOf(await post(app, '/api/projects/pay/envs/demo/searches', { terms: ['lookup'], period: { preset: '24h' } }))).toBe('unknown-environment');
  });

  it('список стендов читается заново после правки шаблона и смены хранилища, но не после смены названия', async () => {
    const { app } = await up();
    const reads = () => grafana.requests.filter((r) => r.url.includes('/label/namespace/values')).length;
    const stands = () => app.inject('/api/projects/pay/envs/pr/stands');
    expect((await stands()).json()).toEqual({ stands: [105, 92] });
    expect(reads()).toBe(1);
    await stands();
    expect(reads()).toBe(1);

    let p = await setting(app, 'pay');
    await put(app, '/api/projects/pay', edited(p, { name: 'Новое' }));
    await stands();
    expect(reads()).toBe(1);

    p = await setting(app, 'pay');
    const template = p.environments.map((e) => (e.id === 'pr' ? { ...e, stand: { label: 'namespace', template: 'pay-pr-x{number}' } } : e));
    expect((await put(app, '/api/projects/pay', edited(p, { environments: template }))).statusCode).toBe(200);
    await stands();
    expect(reads()).toBe(2);

    p = await setting(app, 'pay');
    const moved = p.environments.map((e) => (e.id === 'pr' ? { ...e, backend: 'demo' } : e));
    expect((await put(app, '/api/projects/pay', edited(p, { environments: moved }))).statusCode).toBe(200);
    expect((await stands()).statusCode).toBe(200);
    expect(reads()).toBe(2);
    expect(envOf(await setting(app, 'pay'), 'pr').backend).toBe('demo');
  });

  it('скрытие за время чтения по ссылке не даёт 500, следующий запрос говорит о неизвестной среде', async () => {
    const yaml = configYaml({ projects: PAY_PROJECT + projectYaml('acme', 'Acme', 'slow', 'slow'), backendsExtra: '  slow:\n    type: mock\n    latencyMs: 300\n' });
    const { app } = await up(yaml);
    const now = Date.now();
    const url = `/api/projects/acme/envs/slow/requests/cid-none?from=${now - 60_000}&to=${now}`;
    const reading = app.inject(url);
    await new Promise((r) => setTimeout(r, 50));
    const p = await setting(app, 'acme');
    expect((await put(app, '/api/projects/acme/visibility', { hidden: true, updatedAt: p.updatedAt })).statusCode).toBe(200);
    const r = await reading;
    expect([r.statusCode, codeOf(r)]).toEqual([404, 'request-not-found']);
    expect(codeOf(await app.inject(url))).toBe('unknown-environment');
  });
});

describe('версия проектов в состоянии справочника', () => {
  it('без базы постоянна, остальные поля прежние', async () => {
    const config = await configFile(configYaml());
    const app = await buildApp({ config, backends: new Backends(config), logger: false });
    open.push(app);
    const first = (await app.inject('/api/catalog')).json<Record<string, unknown>>();
    expect(first).toMatchObject({ state: 'off', loadedAt: null, message: null, projectsVersion: 0 });
    expect(Object.keys(first).sort()).toEqual(['loadedAt', 'masking', 'message', 'projectsVersion', 'state']);
    expect((await app.inject('/api/catalog')).json<Record<string, unknown>>().projectsVersion).toBe(0);
  });

  it('после правки растёт, чтение не меняет', async () => {
    const { app } = await up();
    const version = async () => (await app.inject('/api/catalog')).json<{ projectsVersion: number }>().projectsVersion;
    const before = await version();
    expect(before).toBeGreaterThan(0);
    expect(await version()).toBe(before);
    await post(app, '/api/projects', body());
    expect(await version()).toBeGreaterThan(before);
  });
});

describe('маска при профиле из файла', () => {
  it('поиск в проекте с профилем из файла отдаёт синтетические секреты с маской', async () => {
    const CID = 'order-1.mask';
    const PAN = '4111111234557893';
    const SECRET = 'Synthetic-Pass-77';
    const at = Date.now() - 60_000;
    const line = (offset: number, rec: Record<string, unknown>): LogLine => ({
      tsNs: (BigInt(at + offset) * 1_000_000n).toString(),
      line: JSON.stringify({ ts: at + offset, trace_id: CID, ...rec }),
      labels: { namespace: 'acme', container: 'app' },
    });
    const lines = [
      line(0, { lvl: 'info', msg: 'incoming request', http: { method: 'POST', url: '/pay', body: { password: SECRET, pan: PAN } } }),
      line(5, { lvl: 'warn', msg: `card ${PAN}`, extra: { password: SECRET } }),
    ];
    // Конец чтения — только пустой ответ, поэтому граница продолжения соблюдается, как у хранилища.
    const after = (q: LinesQuery) => BigInt(q.range.fromNs ?? BigInt(q.range.fromMs) * 1_000_000n);
    const adapter: LogBackend = { check: async () => ({ labelNames: [] }), queryLines: async (q) => lines.filter((l) => BigInt(l.tsNs) >= after(q) + (q.range.fromNs ? 1n : 0n)), countBy: async () => ({ [CID]: lines.length }), labelValues: async () => [] };
    const s = await stand(db, configYaml({ url: grafana.url }), { createAdapter: () => adapter });
    open.push(s.app);
    expect((await post(s.app, '/api/projects', body({ format: 'acme-json' }))).statusCode).toBe(201);
    const r = await s.app.inject(`/api/projects/acme/envs/demo/requests/${CID}?from=${at - 1000}&to=${at + 1000}`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.body).toContain('incoming request');
    expect(r.body).not.toContain(SECRET);
    expect(r.body).not.toContain(PAN);
  });
});
