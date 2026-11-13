// Настройка вида проекта: хранение, снимок, API, состояния базы, граница с файлом. Grafana только поддельная.

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectSetting, ProjectSettingsResponse, ProjectsResponse } from '@threadline/core';
import { DEFAULT_VIEW, type ViewSettings } from '@threadline/core/view';
import { buildApp } from '../../src/app.ts';
import { Backends } from '../../src/backends/registry.ts';
import { openDb, type Db } from '../../src/catalog/db.ts';
import { migrate } from '../../src/catalog/migrate.ts';
import * as store from '../../src/projects/store.ts';
import { readView, writeView } from '../../src/projects/view.ts';
import { freshDatabase, PG_URL } from '../catalog/pg.ts';
import { fakeGrafana, grafana85 } from '../fake-grafana.ts';
import { configFile, configYaml, NAMESPACES, PAY_PROJECT, projectYaml, stand, type Stand } from './harness.ts';

const edit = (fn: (v: ViewSettings) => void): ViewSettings => {
  const v = structuredClone(DEFAULT_VIEW);
  fn(v);
  return v;
};
const NO_CID = edit((v) => (v.columns.cid.full = false));

const put = (app: FastifyInstance, id: string, view: unknown, updatedAt: string | null, headers: Record<string, string> = {}) =>
  app.inject({ method: 'PUT', url: `/api/projects/${id}/view`, payload: { view, updatedAt } as object, headers });
const settings = async (app: FastifyInstance) => (await app.inject('/api/project-settings')).json<ProjectSettingsResponse>();
const setting = async (app: FastifyInstance, id = 'pay'): Promise<ProjectSetting> => (await settings(app)).projects.find((p) => p.id === id)!;
const list = async (app: FastifyInstance) => (await app.inject('/api/projects')).json<ProjectsResponse>();
const viewIn = async (app: FastifyInstance, id = 'pay') => (await list(app)).projects.find((p) => p.id === id)?.view;
const codeOf = (r: { json: () => { error: { code: string } } }) => r.json().error.code;

const engines: [string, () => Promise<string | null>][] = [
  ['PGlite', async () => 'pglite://memory'],
  ['PostgreSQL', async () => (PG_URL ? await freshDatabase() : null)],
];

describe.each(engines)('запись настройки на %s', (engineName, urlOf) => {
  const skip = engineName === 'PostgreSQL' && !PG_URL;
  let db: Db;
  let s: Stand;

  beforeEach(async () => {
    if (skip) return;
    db = await openDb((await urlOf())!);
    await migrate(db);
    s = await stand(db, configYaml());
  });
  afterEach(async () => {
    if (skip) return;
    await s.app.close();
    await db.close();
  });

  it.skipIf(skip)('миграция: повтор ничего не применяет, существующие строки получают null', async () => {
    expect((await migrate(db)).applied).toEqual([]);
    expect(await readView(db, 'pay')).toEqual({ raw: null, updatedAt: null });
  });

  it.skipIf(skip)('запись читается, два сохранения подряд со свежей меткой проходят', async () => {
    const first = await put(s.app, 'pay', NO_CID, null);
    expect(first.statusCode, first.body).toBe(200);
    const one = first.json<ProjectSetting>();
    expect(one.view.columns.cid.full).toBe(false);
    // Микросекунды: через Date метка округлилась бы, и второе сохранение получило бы конфликт.
    expect(one.viewUpdatedAt).toMatch(/\.\d{6}Z$/);
    const second = await put(s.app, 'pay', DEFAULT_VIEW, one.viewUpdatedAt);
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json<ProjectSetting>().viewUpdatedAt).not.toBe(one.viewUpdatedAt);
  });

  it.skipIf(skip)('первая запись у двоих: второй получает конфликт, а не перезаписывает', async () => {
    expect((await put(s.app, 'pay', NO_CID, null)).statusCode).toBe(200);
    const second = await put(s.app, 'pay', edit((v) => (v.defaultMode = 'brief')), null);
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('project-conflict');
    expect(second.json().error.current.view.columns.cid.full).toBe(false);
    expect((await viewIn(s.app))?.defaultMode).toBe('full');
  });

  it.skipIf(skip)('null пишет SQL NULL и ставит метку: конфликт после «Вернуть стандартные» работает', async () => {
    const saved = (await put(s.app, 'pay', NO_CID, null)).json<ProjectSetting>();
    const cleared = await put(s.app, 'pay', null, saved.viewUpdatedAt);
    expect(cleared.statusCode, cleared.body).toBe(200);
    const row = await db.query<{ is_null: boolean }>(`select view_settings is null as is_null from project where id = 'pay'`);
    expect(row[0]!.is_null).toBe(true);
    expect((await readView(db, 'pay'))?.updatedAt).toBe(cleared.json<ProjectSetting>().viewUpdatedAt);
    expect(cleared.json<ProjectSetting>().view).toEqual(DEFAULT_VIEW);
    expect((await put(s.app, 'pay', NO_CID, saved.viewUpdatedAt)).statusCode).toBe(409);
  });

  it.skipIf(skip)('метка проекта и отметка правки те же, версия выросла', async () => {
    const before = await store.readProject(db, 'pay');
    const version = await store.readVersion(db);
    await put(s.app, 'pay', NO_CID, null);
    const after = await store.readProject(db, 'pay');
    expect(after?.updatedAt).toBe(before?.updatedAt);
    expect(after?.edited).toBe(before?.edited);
    expect(after?.fileHash).toBe(before?.fileHash);
    expect(await store.readVersion(db)).toBe(version + 1);
    expect((await setting(s.app)).fileState).toBe('same');
  });

  it.skipIf(skip)('writeView: чужая метка и нет проекта — false', async () => {
    expect(await writeView(db, 'нет', null, null)).toBe(false);
    expect(await writeView(db, 'pay', null, '2020-01-01T00:00:00.000000Z')).toBe(false);
    expect(await writeView(db, 'pay', NO_CID, null)).toBe(true);
  });
});

describe('настройка в снимке', () => {
  let db: Db;
  let s: Stand;
  let grafana: Awaited<ReturnType<typeof fakeGrafana>>;
  const open: FastifyInstance[] = [];

  beforeEach(async () => {
    db = await openDb('pglite://memory');
    await migrate(db);
    grafana = await fakeGrafana(grafana85({ values: NAMESPACES }));
    s = await stand(db, configYaml({ url: grafana.url, projects: PAY_PROJECT + projectYaml('acme') }));
    open.push(s.app);
  });
  afterEach(async () => {
    for (const a of open.splice(0)) await a.close();
    await db.close();
    await grafana.close();
  });

  const breakRow = async (json: string, id = 'pay') => {
    await db.query(`update project set view_settings = $1::jsonb where id = $2`, [json, id]);
    await store.bumpVersion(db);
    await s.service.poll(db);
  };

  it('битая запись не делает проект неверным и не роняет снимок', async () => {
    await breakRow('"строка"');
    const p = await setting(s.app);
    expect(p.issues).toBeUndefined();
    expect(p.view).toEqual(DEFAULT_VIEW);
    expect(p.viewIssues).toEqual([{ code: 'unparsed', field: 'view' }]);
    expect(s.config.config.projects.pay).toBeDefined();
    expect(await viewIn(s.app)).toEqual(DEFAULT_VIEW);
  });

  it('неизвестная колонка: код dropped с обрезанным значением, запись в базе та же, сервер её не переписывает', async () => {
    const name = `risk-${'x'.repeat(80)}`;
    await breakRow(JSON.stringify({ columns: { [name]: { full: true, brief: true } } }));
    const p = await setting(s.app);
    expect(p.viewIssues).toHaveLength(1);
    expect(p.viewIssues[0]).toMatchObject({ code: 'dropped', field: 'columns' });
    expect(p.viewIssues[0]!.value!.length).toBeLessThanOrEqual(40);
    expect(p.view).toEqual(DEFAULT_VIEW);
    expect(((await readView(db, 'pay'))?.raw as { columns: Record<string, unknown> }).columns[name]).toBeDefined();
  });

  it('устаревшая запись сохраняется без отказа и сообщение исчезает', async () => {
    await breakRow(JSON.stringify({ defaultMode: 'compact' }));
    const p = await setting(s.app);
    expect(p.viewIssues).toHaveLength(1);
    const r = await put(s.app, 'pay', p.view, p.viewUpdatedAt);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json<ProjectSetting>().viewIssues).toEqual([]);
    expect((await setting(s.app)).viewIssues).toEqual([]);
  });

  it('посев и «Взять из файла» её сохраняют', async () => {
    await put(s.app, 'acme', NO_CID, null);
    await s.service.sync(db);
    expect((await viewIn(s.app, 'acme'))?.columns.cid.full).toBe(false);
    // Правка делает проект «правленым», «Взять из файла» возвращает среды и название, настройка вида прежняя.
    const c = await setting(s.app, 'acme');
    const edited = await s.app.inject({
      method: 'PUT',
      url: '/api/projects/acme',
      payload: { name: 'Другое', timezone: c.timezone, retentionDays: c.retentionDays, format: c.format, environments: c.environments, updatedAt: c.updatedAt } as object,
    });
    expect(edited.statusCode, edited.body).toBe(200);
    const take = await s.app.inject({ method: 'POST', url: '/api/projects/acme/file-version', payload: { action: 'take', updatedAt: edited.json<ProjectSetting>().updatedAt } as object });
    expect(take.statusCode, take.body).toBe(200);
    expect(take.json<ProjectSetting>().name).toBe('acme');
    expect(take.json<ProjectSetting>().view.columns.cid.full).toBe(false);
  });

  it('правка проекта и настройка вида не конфликтуют', async () => {
    const opened = await setting(s.app, 'acme');
    await put(s.app, 'acme', NO_CID, null);
    const r = await s.app.inject({
      method: 'PUT',
      url: '/api/projects/acme',
      payload: { name: 'Новое', timezone: opened.timezone, retentionDays: opened.retentionDays, format: opened.format, environments: opened.environments, updatedAt: opened.updatedAt } as object,
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json<ProjectSetting>().view.columns.cid.full).toBe(false);
  });

  it('отметка «Правится здесь» не появляется, файл продолжает применяться', async () => {
    await put(s.app, 'acme', NO_CID, null);
    const p = await setting(s.app, 'acme');
    expect(p.fileState).toBe('same');
    expect((await store.readProject(db, 'acme'))?.edited).toBe(false);
  });

  it('скрытие сохраняет настройку, скрытый проект её показывает', async () => {
    await put(s.app, 'acme', NO_CID, null);
    const c = await setting(s.app, 'acme');
    const hide = await s.app.inject({ method: 'PUT', url: '/api/projects/acme/visibility', payload: { hidden: true, updatedAt: c.updatedAt } as object });
    expect(hide.statusCode, hide.body).toBe(200);
    expect((await setting(s.app, 'acme')).view.columns.cid.full).toBe(false);
    const show = await s.app.inject({ method: 'PUT', url: '/api/projects/acme/visibility', payload: { hidden: false, updatedAt: hide.json<ProjectSetting>().updatedAt } as object });
    expect(show.statusCode, show.body).toBe(200);
    expect((await viewIn(s.app, 'acme'))?.columns.cid.full).toBe(false);
  });

  it('у неверного проекта настройка видна и сохраняется, в работу он не входит', async () => {
    await put(s.app, 'acme', NO_CID, null);
    await db.query(`update project set environments = '[{"id":"demo","name":"Д","kind":"single","backend":"demo","selector":[{"label":"x","op":"!=","value":"1"}]}]'::jsonb where id = 'acme'`);
    await store.bumpVersion(db);
    await s.service.poll(db);
    const p = await setting(s.app, 'acme');
    expect(p.issues).toBeDefined();
    expect(p.view.columns.cid.full).toBe(false);
    const r = await put(s.app, 'acme', DEFAULT_VIEW, p.viewUpdatedAt);
    expect(r.statusCode, r.body).toBe(200);
    expect((await setting(s.app, 'acme')).view).toEqual(DEFAULT_VIEW);
    expect(s.config.config.projects.acme).toBeUndefined();
  });

  it('удаление и новое создание дают встроенные значения', async () => {
    await put(s.app, 'acme', NO_CID, null);
    const c = await setting(s.app, 'acme');
    const hide = (await s.app.inject({ method: 'PUT', url: '/api/projects/acme/visibility', payload: { hidden: true, updatedAt: c.updatedAt } as object })).json<ProjectSetting>();
    const del = await s.app.inject({ method: 'DELETE', url: `/api/projects/acme?confirm=acme&updatedAt=${encodeURIComponent(hide.updatedAt!)}` });
    expect(del.statusCode, del.body).toBe(204);
    const created = await s.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { id: 'acme', name: 'Acme', timezone: 'Asia/Karachi', retentionDays: 30, format: 'json', environments: [{ id: 'demo', name: 'Демо', kind: 'single', backend: 'demo', selector: [{ label: 'namespace', op: '=', value: 'acme' }] }] },
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json<ProjectSetting>()).toMatchObject({ view: DEFAULT_VIEW, viewUpdatedAt: null, viewIssues: [] });
  });

  it('идущий поиск продолжается, кэш стендов на месте', async () => {
    const known = grafana85({ values: NAMESPACES });
    const hanging = await fakeGrafana((req, res, rec) => {
      if (/\/loki\/api\/v1\/query/.test(req.url ?? '')) return;
      known(req, res, rec);
    });
    try {
      const h = await stand(db, configYaml({ url: hanging.url }));
      open.push(h.app);
      const started = await h.app.inject({ method: 'POST', url: '/api/projects/pay/envs/prod/searches', payload: { terms: ['lookup'], period: { preset: '24h' } } });
      expect(started.statusCode, started.body).toBe(200);
      const { id } = started.json<{ id: string }>();
      await expect.poll(() => hanging.requests.filter((r) => r.url.includes('/loki/api/v1/query')).length).toBeGreaterThanOrEqual(1);
      const stands = await h.app.inject('/api/projects/pay/envs/pr/stands');
      expect(stands.statusCode, stands.body).toBe(200);
      const atStart = hanging.requests.length;

      expect((await put(h.app, 'pay', NO_CID, null)).statusCode).toBe(200);

      expect((await h.app.inject(`/api/searches/${id}`)).json()).toMatchObject({ status: 'running' });
      expect(hanging.requests.some((r) => r.closedEarly)).toBe(false);
      expect((await h.app.inject('/api/projects/pay/envs/pr/stands')).statusCode).toBe(200);
      // Сохранение и повтор стендов из кэша: к хранилищу ни одного нового запроса, кроме шедших от поиска.
      expect(hanging.requests.filter((r, i) => i >= atStart && !r.url.includes('/loki/api/v1/query'))).toEqual([]);
      await h.app.inject({ method: 'POST', url: `/api/searches/${id}/cancel`, payload: {} });
    } finally {
      await hanging.close();
    }
  });

  it('две копии: вторая видит правку после опроса версии', async () => {
    const other = await stand(db, configYaml({ url: grafana.url, projects: PAY_PROJECT + projectYaml('acme') }));
    open.push(other.app);
    expect((await put(s.app, 'pay', NO_CID, null)).statusCode).toBe(200);
    expect((await viewIn(other.app))?.columns.cid.full).toBe(true);
    await other.service.poll(db);
    expect((await viewIn(other.app))?.columns.cid.full).toBe(false);
  });
});

describe('API настройки', () => {
  let db: Db;
  let s: Stand;
  let grafana: Awaited<ReturnType<typeof fakeGrafana>>;

  beforeEach(async () => {
    db = await openDb('pglite://memory');
    await migrate(db);
    grafana = await fakeGrafana(grafana85({ values: NAMESPACES }));
    s = await stand(db, configYaml({ url: grafana.url }));
  });
  afterEach(async () => {
    await s.app.close();
    await db.close();
    await grafana.close();
  });

  it('список: поле всегда полное, метки и сообщений нет, запреты на секреты те же', async () => {
    await db.query(`update project set view_settings = '{"columns":{"risk":{"full":true}}}'::jsonb where id = 'pay'`);
    await store.bumpVersion(db);
    await s.service.poll(db);
    const r = await s.app.inject('/api/projects');
    const pay = r.json<ProjectsResponse>().projects[0]!;
    expect(pay.view).toEqual(DEFAULT_VIEW);
    expect(r.body).not.toContain('viewUpdatedAt');
    expect(r.body).not.toContain('viewIssues');
    for (const secret of ['selector', 'risk', grafana.url]) expect(r.body).not.toContain(secret);
  });

  it('настройки проекта: view, метка и сообщения', async () => {
    expect(await setting(s.app)).toMatchObject({ view: DEFAULT_VIEW, viewUpdatedAt: null, viewIssues: [] });
  });

  it('успех: действует на следующий ответ со списком, ноль запросов к Grafana', async () => {
    const before = grafana.requests.length;
    const r = await put(s.app, 'pay', NO_CID, null);
    expect(r.statusCode, r.body).toBe(200);
    expect((await viewIn(s.app))?.columns.cid.full).toBe(false);
    expect(grafana.requests.length).toBe(before);
  });

  it('422 с путём на каждое обязательное', async () => {
    const cases: [ViewSettings, string][] = [
      [edit((v) => (v.columns.time.full = false)), 'view.columns.time.full'],
      [edit((v) => (v.columns.request.brief = false)), 'view.columns.request.brief'],
      [edit((v) => (v.columns.outcome.full = false)), 'view.columns.outcome.full'],
      [edit((v) => (v.blocks.raw.full = false)), 'view.blocks.raw.full'],
      [
        edit((v) => {
          v.defaultTab = 'records';
          v.tabs.records = { full: false, brief: false };
        }),
        'view.defaultTab',
      ],
    ];
    for (const [view, path] of cases) {
      const r = await put(s.app, 'pay', view, null);
      expect(r.statusCode, path).toBe(422);
      expect(codeOf(r)).toBe('project-invalid');
      expect(Object.keys(r.json().error.fields)).toEqual([path]);
    }
    expect((await setting(s.app)).viewUpdatedAt).toBeNull();
  });

  it('409 со свежей записью, 404 после удаления и у неверного адреса', async () => {
    const saved = (await put(s.app, 'pay', NO_CID, null)).json<ProjectSetting>();
    const stale = await put(s.app, 'pay', DEFAULT_VIEW, '2020-01-01T00:00:00.000000Z');
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.current.viewUpdatedAt).toBe(saved.viewUpdatedAt);
    expect(stale.json().error.current.view.columns.cid.full).toBe(false);
    expect((await put(s.app, 'нет-такого', DEFAULT_VIEW, null)).statusCode).toBe(404);
    expect((await put(s.app, 'unknown', DEFAULT_VIEW, null)).statusCode).toBe(404);
  });

  it('чужой Origin 403, text/plain 415, тело больше 4 КБ отклонено, тело не объект 422', async () => {
    expect((await put(s.app, 'pay', DEFAULT_VIEW, null, { origin: 'https://evil.example', host: 'localhost' })).statusCode).toBe(403);
    expect((await s.app.inject({ method: 'PUT', url: '/api/projects/pay/view', payload: 'x', headers: { 'content-type': 'text/plain' } })).statusCode).toBe(415);
    const big = await s.app.inject({ method: 'PUT', url: '/api/projects/pay/view', payload: JSON.stringify({ view: null, updatedAt: null, pad: 'x'.repeat(5000) }), headers: { 'content-type': 'application/json' } });
    expect(big.statusCode).toBe(413);
    expect((await s.app.inject({ method: 'PUT', url: '/api/projects/pay/view', payload: '[]', headers: { 'content-type': 'application/json' } })).statusCode).toBe(422);
    expect((await setting(s.app)).viewUpdatedAt).toBeNull();
  });

  it('поле view в правке проекта отклоняется с путём, ничего не меняется', async () => {
    const c = await setting(s.app);
    const r = await s.app.inject({
      method: 'PUT',
      url: '/api/projects/pay',
      payload: { name: c.name, timezone: c.timezone, retentionDays: c.retentionDays, format: c.format, environments: c.environments, updatedAt: c.updatedAt, view: NO_CID } as object,
    });
    expect(r.statusCode).toBe(422);
    expect(Object.keys(r.json().error.fields).join(' ')).toContain('view');
    expect((await setting(s.app)).view).toEqual(DEFAULT_VIEW);
    expect((await store.readProject(db, 'pay'))?.edited).toBe(false);
  });
});

describe('состояния базы', () => {
  it('без базы: встроенные значения, правка 503', async () => {
    const config = await configFile(configYaml());
    const app = await buildApp({ config, backends: new Backends(config), logger: false });
    try {
      expect((await list(app)).projects[0]!.view).toEqual(DEFAULT_VIEW);
      const p = await setting(app);
      expect(p).toMatchObject({ view: DEFAULT_VIEW, viewUpdatedAt: null, viewIssues: [] });
      const r = await put(app, 'pay', NO_CID, null);
      expect(r.statusCode).toBe(503);
      expect(codeOf(r)).toBe('project-readonly');
    } finally {
      await app.close();
    }
  });

  it('снимок при обрыве, 503 на правку, восстановление без перезапуска', async () => {
    const db = await openDb('pglite://memory');
    await migrate(db);
    const s = await stand(db, configYaml());
    try {
      const saved = (await put(s.app, 'pay', NO_CID, null)).json<ProjectSetting>();
      s.catalog.current = 'stale';
      expect((await viewIn(s.app))?.columns.cid.full).toBe(false);
      const during = await settings(s.app);
      expect(during).toMatchObject({ state: 'stale', editable: false });
      expect(during.loadedAt).not.toBeNull();
      expect(during.projects[0]!.view.columns.cid.full).toBe(false);
      const r = await put(s.app, 'pay', DEFAULT_VIEW, saved.viewUpdatedAt);
      expect(r.statusCode).toBe(503);
      expect(codeOf(r)).toBe('project-readonly');
      s.catalog.current = 'ok';
      expect((await put(s.app, 'pay', DEFAULT_VIEW, saved.viewUpdatedAt)).statusCode).toBe(200);
    } finally {
      await s.app.close();
      await db.close();
    }
  });

  it('база ещё не подключилась: встроенные значения, правка закрыта; после подключения — настройка из базы', async () => {
    const db = await openDb('pglite://memory');
    await migrate(db);
    const seed = await stand(db, configYaml());
    await put(seed.app, 'pay', NO_CID, null);
    await seed.app.close();

    const config = await configFile(configYaml());
    const backends = new Backends(config);
    let service!: Stand['service'];
    const { TestCatalog } = await import('./harness.ts');
    const catalog = new TestCatalog(db);
    catalog.current = 'connecting';
    const app = await buildApp({ config, backends, logger: false, onProjects: (x) => { service = x; x.attach(catalog); } });
    try {
      for (const state of ['connecting', 'error'] as const) {
        catalog.current = state;
        expect((await viewIn(app))).toEqual(DEFAULT_VIEW);
        expect(codeOf(await put(app, 'pay', NO_CID, null))).toBe('project-readonly');
      }
      catalog.current = 'ok';
      await service.sync(db);
      expect((await viewIn(app))?.columns.cid.full).toBe(false);
    } finally {
      await app.close();
      await db.close();
    }
  });
});
