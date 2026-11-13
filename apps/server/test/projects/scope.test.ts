// Граница хранилища при сохранении, загрузке из базы и перезапуске. Хранилище не вызывается.

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectSetting, ProjectSettingsResponse, ProjectsResponse } from '@threadline/core';
import { openDb, type Db } from '../../src/catalog/db.ts';
import { migrate } from '../../src/catalog/migrate.ts';
import * as store from '../../src/projects/store.ts';
import { fakeGrafana, grafana85 } from '../fake-grafana.ts';
import { configYaml, NAMESPACES, projectYaml, stand, type Stand } from './harness.ts';

let db: Db;
let apps: FastifyInstance[] = [];
let grafana: Awaited<ReturnType<typeof fakeGrafana>>;

const up = async (yaml: string): Promise<Stand> => {
  const s = await stand(db, yaml);
  apps.push(s.app);
  return s;
};

beforeEach(async () => {
  db = await openDb('pglite://memory');
  await migrate(db);
  grafana = await fakeGrafana(grafana85({ values: NAMESPACES }));
});

afterEach(async () => {
  for (const a of apps) await a.close();
  apps = [];
  await db.close();
  await grafana.close();
});

const env = (value: string, over: Record<string, unknown> = {}) => ({ id: 'prod', name: 'Прод', kind: 'single', backend: 'grafana', selector: [{ label: 'namespace', op: '=', value }], ...over });
const body = (over: Record<string, unknown> = {}) => ({ id: 'acme', name: 'Acme', timezone: 'Asia/Karachi', retentionDays: 30, format: 'json', environments: [env('acme')], ...over });
const create = (app: FastifyInstance, payload: unknown) => app.inject({ method: 'POST', url: '/api/projects', payload: payload as object });
const setting = async (app: FastifyInstance, id: string): Promise<ProjectSetting> => (await app.inject('/api/project-settings')).json<ProjectSettingsResponse>().projects.find((p) => p.id === id)!;
const edited = (p: ProjectSetting, over: Record<string, unknown> = {}) => ({ name: p.name, timezone: p.timezone, retentionDays: p.retentionDays, format: p.format, environments: p.environments.map(({ outOfScope: _o, missingStore: _m, ...e }) => e), updatedAt: p.updatedAt, ...over });
const fields = (r: { json: () => { error: { fields: Record<string, string> } } }) => r.json().error.fields;

const fileWith = (value: string, scope?: string | null) =>
  configYaml({
    url: grafana.url,
    ...(scope !== undefined ? { scope } : {}),
    projects: `  pay:
    name: Demo Pay
    environments:
      prod:
        name: Прод
        backend: grafana
        selector:
          - { label: namespace, op: '=', value: ${value} }
      demo:
        name: Демо
        backend: demo
        selector:
          - { label: namespace, op: '=', value: demo }
`,
  });

describe('граница при сохранении', () => {
  it('значение вне границы отклонено без обращения к Grafana и называет разрешённое', async () => {
    const { app } = await up(fileWith('pay'));
    const r = await create(app, body({ environments: [env('core-banking')] }));
    expect(r.statusCode).toBe(422);
    const message = fields(r)['environments.0.selector.0.value'];
    expect(message).toContain('acme-*');
    expect(message).toContain('backends.grafana.formScope');
    expect(await store.readProject(db, 'acme')).toBe(null);
    expect(grafana.requests).toHaveLength(0);
  });

  it('значение в границе и исключение рядом проходит', async () => {
    const { app } = await up(fileWith('pay'));
    const r = await create(app, body({ environments: [env('acme-test', { selector: [{ label: 'namespace', op: '=', value: 'acme-test' }, { label: 'container', op: '!=', value: 'pgadmin', searchOnly: true }] })] }));
    expect(r.statusCode).toBe(201);
    expect(grafana.requests).toHaveLength(0);
  });

  it('правка названия среды из файла без границы проходит, смена условий — нет', async () => {
    const { app } = await up(fileWith('файловое-значение', null));
    const p = await setting(app, 'pay');
    const renamed = p.environments.map((e) => (e.id === 'prod' ? { ...e, name: 'Новое имя' } : e));
    expect((await app.inject({ method: 'PUT', url: '/api/projects/pay', payload: edited(p, { environments: renamed }) })).statusCode).toBe(200);
    const q = await setting(app, 'pay');
    const changed = q.environments.map((e) => (e.id === 'prod' ? { ...e, selector: [{ label: 'namespace', op: '=' as const, value: 'другое' }] } : e));
    const r = await app.inject({ method: 'PUT', url: '/api/projects/pay', payload: edited(q, { environments: changed }) });
    expect(r.statusCode).toBe(422);
    expect(fields(r)['environments.0.selector']).toContain('formScope');
  });

  it('* пропускает любое значение', async () => {
    const { app } = await up(configYaml({ url: grafana.url, scope: "{ label: namespace, values: ['*'] }" }));
    expect((await create(app, body({ environments: [env('core-banking')] }))).statusCode).toBe(201);
  });

  it('имитация границы не имеет', async () => {
    const { app } = await up(configYaml({ url: grafana.url, scope: null }));
    expect((await create(app, body({ environments: [env('любое', { backend: 'demo' })] }))).statusCode).toBe(201);
  });

  it('адрес и токен у среды отклоняются по имени поля', async () => {
    const { app } = await up(fileWith('pay'));
    for (const field of ['url', 'token', 'tokenEnv', 'datasource']) {
      const r = await create(app, body({ environments: [env('acme', { [field]: 'https://evil.example' })] }));
      expect(Object.keys(fields(r))).toContain(`environments.0.${field}`);
    }
    expect(grafana.requests).toHaveLength(0);
  });
});

describe('граница при загрузке из базы', () => {
  it('сужение границы при перезапуске: «не настроено», запись остаётся, запросов нет', async () => {
    const first = await up(fileWith('pay'));
    expect((await create(first.app, body())).statusCode).toBe(201);
    const narrow = await up(fileWith('pay', '{ label: namespace, values: [pay] }'));
    const env0 = (await narrow.app.inject('/api/projects')).json<ProjectsResponse>().projects.find((p) => p.id === 'acme')!.environments[0]!;
    expect(env0).toMatchObject({ notConfigured: true, outOfScope: 'grafana' });
    const conn = await narrow.app.inject('/api/projects/acme/envs/prod/connection');
    expect(conn.json()).toMatchObject({ status: 'not-configured', outOfScope: 'grafana' });
    const search = await narrow.app.inject({ method: 'POST', url: '/api/projects/acme/envs/prod/searches', payload: { terms: ['x'], period: { preset: '1h' } } });
    expect(search.json<{ error: { code: string } }>().error.code).toBe('not-configured');
    expect((await store.readProject(db, 'acme'))?.environments[0]?.selector[0]?.value).toBe('acme');
    expect(grafana.requests).toHaveLength(0);
  });

  it('смена условий в файле у правленого проекта: «не настроено», file-newer, «Взять из файла» возвращает среду', async () => {
    const first = await up(fileWith('вне-границы', null));
    const p = await setting(first.app, 'pay');
    await first.app.inject({ method: 'PUT', url: '/api/projects/pay', payload: edited(p, { name: 'Правленый' }) });

    const second = await up(fileWith('другое-вне-границы', null));
    const stale = await setting(second.app, 'pay');
    expect(stale).toMatchObject({ name: 'Правленый', fileState: 'file-newer' });
    expect(stale.environments.find((e) => e.id === 'prod')).toMatchObject({ outOfScope: 'grafana' });
    expect((await second.app.inject('/api/projects/pay/envs/prod/connection')).json()).toMatchObject({ status: 'not-configured', outOfScope: 'grafana' });

    const taken = await second.app.inject({ method: 'POST', url: '/api/projects/pay/file-version', payload: { action: 'take', updatedAt: stale.updatedAt } });
    expect(taken.statusCode).toBe(200);
    expect((await second.app.inject('/api/projects/pay/envs/prod/connection')).json<{ status: string }>().status).not.toBe('not-configured');
  });

  it('показанный после уборки из файла проект вне границы не читает хранилище', async () => {
    const yaml = (extra: string) => configYaml({ url: grafana.url, defaults: '{ project: pay, environment: demo }', scope: '{ label: namespace, values: [pay] }', projects: `  pay:
    name: Demo Pay
    environments:
      demo:
        name: Демо
        backend: demo
        selector:
          - { label: namespace, op: '=', value: demo }
${extra}` });
    await up(yaml(projectYaml('old', 'Старый', 'prod', 'grafana', 'core-banking')));
    const second = await up(yaml(''));
    const removed = await setting(second.app, 'old');
    expect(removed).toMatchObject({ hidden: 'file', fileState: 'removed' });
    await second.app.inject({ method: 'PUT', url: '/api/projects/old/visibility', payload: { hidden: false, updatedAt: removed.updatedAt } });
    const conn = await second.app.inject('/api/projects/old/envs/prod/connection');
    expect(conn.json()).toMatchObject({ status: 'not-configured', outOfScope: 'grafana' });
    expect(grafana.requests).toHaveLength(0);
  });

  it('среда файла вне границы работает: файл доверенный', async () => {
    const { app } = await up(fileWith('файловое', '{ label: namespace, values: [другое] }'));
    expect((await setting(app, 'pay')).environments.find((e) => e.id === 'prod')?.outOfScope).toBeUndefined();
  });
});
