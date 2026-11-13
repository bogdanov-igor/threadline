// Таблица доступа: каждый маршрут из onRoute каждой ролью, сверка с ожидаемой таблицей ниже. Отказы приходят до хранилища.
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { can, ROLES, type Capability, type Role } from '@threadline/core/access';
import { buildApp } from '../../src/app.ts';
import type { Access, RouteEntry } from '../../src/auth/access.ts';
import { Backends } from '../../src/backends/registry.ts';
import { UnknownCollector } from '../../src/catalog/collector.ts';
import type { CatalogService } from '../../src/catalog/service.ts';
import * as store from '../../src/catalog/store.ts';
import { loadConfig } from '../../src/config/load.ts';
import { CATALOG_YAML, service, tempConfig } from '../catalog/fixture.ts';
import { fakeGrafana, grafana85 } from '../fake-grafana.ts';

type Who = 'public' | 'signed-in' | Capability;

const CID = 'abc-123';
const JOB = 'no-such-job';
const ENV = '/api/projects/pay/envs/prod';
const FROM_TO = '?from=1&to=2';
const LINK = 'A'.repeat(22);

/** [метод, шаблон маршрута, адрес запроса, кому доступен]. Маршрут с правом по адресу стоит здесь строкой на каждый случай. */
const TABLE: [string, string, string, Who][] = [
  ['GET', '/api/health', '/api/health', 'public'],
  ['GET', '/api/auth/me', '/api/auth/me', 'signed-in'],
  ['GET', '/api/support-contact', '/api/support-contact', 'signed-in'],
  ['GET', '/api/auth/login', '/api/auth/login', 'public'],
  ['GET', '/api/auth/callback', '/api/auth/callback', 'public'],
  ['POST', '/api/auth/logout', '/api/auth/logout', 'public'],
  ['GET', '/api/projects/:project/logo/:theme', '/api/projects/pay/logo/light', 'public'],
  // Открытая поверхность короткой ссылки. Лишний открытый маршрут роняет тест «открытые маршруты» ниже.
  ['GET', '/api/s/:id', `/api/s/${LINK}`, 'public'],
  ['POST', '/api/s/:id/run', `/api/s/${LINK}/run`, 'public'],
  ['GET', '/api/s/:id/state', `/api/s/${LINK}/state`, 'public'],
  ['GET', '/api/s/:id/requests/:cid', `/api/s/${LINK}/requests/${CID}`, 'public'],
  ['GET', '/api/s/:id/lines', `/api/s/${LINK}/lines`, 'public'],

  ['POST', '/api/share', '/api/share', 'view'],
  ['POST', '/api/report', '/api/report', 'view'],
  ['GET', '/api/settings', '/api/settings', 'editSettings'],
  ['PUT', '/api/settings/:key', '/api/settings/share.lifetimeDays', 'editSettings'],

  ['GET', '/api/projects', '/api/projects', 'view'],
  ['GET', '/api/projects/:project/envs/:env/connection', `${ENV}/connection`, 'view'],
  ['GET', '/api/projects/:project/envs/:env/stands', `${ENV}/stands`, 'view'],
  ['GET', '/api/projects/:project/envs/:env/stands/:stand', `${ENV}/stands/1`, 'view'],
  ['GET', '/api/catalog', '/api/catalog', 'view'],
  ['POST', '/api/projects/:project/envs/:env/searches', `${ENV}/searches`, 'view'],
  ['POST', '/api/projects/:project/searches', '/api/projects/pay/searches', 'view'],
  ['POST', '/api/projects/:project/envs/:env/operations', `${ENV}/operations`, 'view'],
  ['GET', '/api/searches/:id', `/api/searches/${JOB}`, 'view'],
  ['DELETE', '/api/searches/:id', `/api/searches/${JOB}`, 'view'],
  ['POST', '/api/searches/:id/supplement', `/api/searches/${JOB}/supplement`, 'view'],
  ['GET', '/api/searches/:id/requests/:cid', `/api/searches/${JOB}/requests/${CID}`, 'view'],
  ['GET', '/api/projects/:project/envs/:env/requests/:cid', `${ENV}/requests/${CID}`, 'view'],

  ['GET', '/api/searches/:id/requests/:cid/reveal', `/api/searches/${JOB}/requests/${CID}/reveal`, 'reveal'],
  ['GET', '/api/projects/:project/envs/:env/requests/:cid/reveal', `${ENV}/requests/${CID}/reveal${FROM_TO}`, 'reveal'],
  ['GET', '/api/searches/:id/lines', `/api/searches/${JOB}/lines`, 'details'],

  ['GET', '/api/catalog/schema', '/api/catalog/schema', 'details'],
  ['GET', '/api/projects/:project/catalog', '/api/projects/pay/catalog', 'details'],
  ['GET', '/api/projects/:project/catalog/:section/:id/dependents', '/api/projects/pay/catalog/systems/1/dependents', 'details'],
  ['GET', '/api/projects/:project/catalog/export', '/api/projects/pay/catalog/export', 'details'],
  ['GET', '/api/projects/:project/file-version', '/api/projects/pay/file-version', 'details'],
  ['GET', '/api/projects/:project/catalog/unknown', '/api/projects/pay/catalog/unknown', 'details'],
  ['GET', '/api/project-settings', '/api/project-settings', 'details'],
  ['POST', '/api/stores/:store/probe', '/api/stores/grafana/probe', 'details'],

  ['POST', '/api/projects/:project/catalog/:section', '/api/projects/pay/catalog/errors', 'editErrors'],
  ['POST', '/api/projects/:project/catalog/:section', '/api/projects/pay/catalog/methods', 'editCatalog'],
  ['POST', '/api/projects/:project/catalog/:section', '/api/projects/pay/catalog/systems', 'editCatalog'],
  ['POST', '/api/projects/:project/catalog/:section', '/api/projects/pay/catalog/outcome-rules', 'editCatalog'],
  ['POST', '/api/projects/:project/catalog/:section', '/api/projects/pay/catalog/id-types', 'editCatalog'],
  ['PUT', '/api/projects/:project/catalog/:section/:id', '/api/projects/pay/catalog/errors/1', 'editErrors'],
  ['PUT', '/api/projects/:project/catalog/:section/:id', '/api/projects/pay/catalog/methods/1', 'editCatalog'],
  ['PUT', '/api/projects/:project/catalog/:section/:id', '/api/projects/pay/catalog/unknown/1', 'editErrors'],
  ['DELETE', '/api/projects/:project/catalog/:section/:id', '/api/projects/pay/catalog/errors/1', 'editErrors'],
  ['DELETE', '/api/projects/:project/catalog/:section/:id', '/api/projects/pay/catalog/methods/1', 'editCatalog'],
  ['DELETE', '/api/projects/:project/catalog/:section/:id', '/api/projects/pay/catalog/errors/1?permanent=1', 'deleteForever'],
  ['POST', '/api/projects/:project/catalog/import', '/api/projects/pay/catalog/import', 'importCatalog'],
  ['PUT', '/api/projects/:project/catalog/masking/:type', '/api/projects/pay/catalog/masking/phone', 'editMasking'],

  ['PUT', '/api/projects/:project', '/api/projects/pay', 'editProjects'],
  ['PUT', '/api/projects/:project/view', '/api/projects/pay/view', 'editProjects'],
  ['PUT', '/api/projects/:project/visibility', '/api/projects/pay/visibility', 'editProjects'],
  ['POST', '/api/projects/:project/file-version', '/api/projects/pay/file-version', 'editProjects'],
  ['POST', '/api/projects', '/api/projects', 'createProjects'],
  ['DELETE', '/api/projects/:project', '/api/projects/pay', 'deleteForever'],
  ['GET', '/api/projects/:project/delete-preview', '/api/projects/pay/delete-preview', 'deleteForever'],
];

const YAML = `
auth: off
defaults: { project: pay, environment: prod }
backends:
  grafana: { type: loki-grafana, url: GRAFANA_URL, tokenEnv: THREADLINE_TABLE_TOKEN }
projects:
  pay:
    name: Demo Pay
    environments:
      prod: { name: Прод, backend: grafana, selector: [{ label: namespace, op: '=', value: pay }] }
`;

let app: FastifyInstance;
let grafana: Awaited<ReturnType<typeof fakeGrafana>>;
const routes: RouteEntry[] = [];

beforeAll(async () => {
  grafana = await fakeGrafana(grafana85({ values: ['pay', 'pay-pr-92', 'pay-pr-105', 'pay-pr-test'] }));
  const dir = await mkdtemp(join(tmpdir(), 'threadline-table-'));
  await writeFile(join(dir, 'threadline.yaml'), YAML.replace('GRAFANA_URL', grafana.url));
  const config = await loadConfig({ path: join(dir, 'threadline.yaml'), env: { THREADLINE_TABLE_TOKEN: 'synthetic-token' } });
  app = await buildApp({
    config,
    backends: new Backends(config),
    routeList: routes,
    testViewer: (req) => {
      const role = req.headers['x-test-role'];
      if (role === undefined) return null;
      return { owner: 'test', role: role === 'none' ? null : (role as Role), name: null };
    },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await grafana.close();
});

const hit = (method: string, url: string, role?: string) =>
  app.inject({
    method: method as 'GET',
    url,
    headers: role === undefined ? {} : { 'x-test-role': role },
    ...(method === 'POST' || method === 'PUT' ? { payload: {} } : {}),
  });

describe('таблица маршрутов', () => {
  it('у каждого маршрута API есть объявление, и он есть в таблице', () => {
    const api = routes.filter((r) => r.url.startsWith('/api/') && r.method !== 'OPTIONS');
    const missing = api.filter((r) => r.access === undefined).map((r) => `${r.method} ${r.url}`);
    expect(missing, 'маршруты без объявленного доступа').toEqual([]);
    const known = new Set(TABLE.map(([m, u]) => `${m} ${u}`));
    const unlisted = api.filter((r) => r.method !== 'HEAD' && !known.has(`${r.method} ${r.url}`)).map((r) => `${r.method} ${r.url}`);
    expect(unlisted, 'маршруты, которых нет в таблице').toEqual([]);
    const present = new Set(api.map((r) => `${r.method} ${r.url}`));
    expect([...known].filter((k) => !present.has(k)), 'строки таблицы без маршрута').toEqual([]);
  });

  it('открытые маршруты: полный список, лишний маршрут роняет тест', () => {
    const open = routes.filter((r) => r.url.startsWith('/api/') && r.access === 'public' && r.method !== 'HEAD' && r.method !== 'OPTIONS').map((r) => `${r.method} ${r.url}`).sort();
    expect(open).toEqual(
      [
        'GET /api/health',
        'GET /api/auth/login',
        'GET /api/auth/callback',
        'POST /api/auth/logout',
        'GET /api/projects/:project/logo/:theme',
        'GET /api/s/:id',
        'POST /api/s/:id/run',
        'GET /api/s/:id/state',
        'GET /api/s/:id/requests/:cid',
        'GET /api/s/:id/lines',
      ].sort(),
    );
  });

  it('вложенные адреса ссылки не прибавляют открытых маршрутов: значение операции сервер не принимает, форма проблемы только за входом', () => {
    const open = [...new Set(routes.filter((r) => r.access === 'public').map((r) => r.url))];
    expect(open.filter((u) => u.includes('/operations'))).toEqual([]);
    expect(open.filter((u) => u.startsWith('/api/s/')).sort()).toEqual(['/api/s/:id', '/api/s/:id/lines', '/api/s/:id/requests/:cid', '/api/s/:id/run', '/api/s/:id/state']);
    expect(open).not.toContain('/api/report');
  });

  it('HEAD закрыт так же, как GET', async () => {
    const gets = routes.filter((r) => r.method === 'GET' && r.url.startsWith('/api/'));
    const heads = routes.filter((r) => r.method === 'HEAD' && r.url.startsWith('/api/'));
    for (const h of heads) expect(gets.find((g) => g.url === h.url)?.access as Access, h.url).toBe(h.access);
    expect((await hit('HEAD', '/api/project-settings', 'business')).statusCode).toBe(403);
  });

  describe.each(TABLE)('%s %s → %s %s', (method, _route, url, who) => {
    it.each(ROLES)('роль %s', async (role) => {
      const before = grafana.requests.length;
      const r = await hit(method, url, role);
      const allowed = who === 'public' || who === 'signed-in' || can(role, who);
      if (allowed) {
        expect([401, 403], r.body).not.toContain(r.statusCode);
      } else {
        expect(r.statusCode, r.body).toBe(403);
        expect(r.json()).toEqual({ error: { code: 'forbidden' } });
        expect(grafana.requests.length, 'запрос к хранилищу при отказе').toBe(before);
      }
    });

    it('без сессии и без роли', async () => {
      const before = grafana.requests.length;
      const anon = await hit(method, url);
      const none = await hit(method, url, 'none');
      if (who === 'public') {
        expect([401, 403]).not.toContain(anon.statusCode);
        return;
      }
      expect(anon.statusCode).toBe(401);
      expect(anon.json()).toEqual({ error: { code: 'unauthenticated' } });
      if (who === 'signed-in') expect(none.statusCode).toBe(200);
      else {
        expect(none.statusCode).toBe(403);
        expect(none.json()).toEqual({ error: { code: 'no-role' } });
      }
      expect(grafana.requests.length).toBe(before);
    });
  });
});

describe('отказ по умолчанию', () => {
  it('маршрут без объявления отвечает 403 всем и виден в списке', async () => {
    const list: RouteEntry[] = [];
    const dir = await mkdtemp(join(tmpdir(), 'threadline-table-'));
    await writeFile(join(dir, 'threadline.yaml'), YAML.replace('GRAFANA_URL', grafana.url));
    const config = await loadConfig({ path: join(dir, 'threadline.yaml'), env: {} });
    const local = await buildApp({ config, backends: new Backends(config), routeList: list });
    local.get('/api/forgotten', async () => ({ secret: true }));
    expect(list.find((r) => r.url === '/api/forgotten')?.access).toBeUndefined();
    const r = await local.inject('/api/forgotten');
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ error: { code: 'forbidden' } });
    await local.close();
  });

  it('несуществующий адрес остаётся 404 без проверки входа', async () => {
    expect((await hit('GET', '/api/no-such-route')).statusCode).toBe(404);
  });
});

describe('запросы с чужого источника', () => {
  it.each([['POST', `${ENV}/searches`], ['DELETE', `/api/searches/${JOB}`], ['POST', '/api/projects/pay/catalog/import'], ['POST', '/api/auth/logout']])('%s %s', async (method, url) => {
    for (const origin of ['https://evil.example', 'null', '%%%']) {
      const before = grafana.requests.length;
      const r = await app.inject({ method: method as 'POST', url, headers: { origin, host: 'localhost', 'x-test-role': 'admin' }, ...(method === 'POST' ? { payload: {} } : {}) });
      expect([r.statusCode, r.json()]).toEqual([403, { error: { code: 'forbidden' } }]);
      expect(grafana.requests.length).toBe(before);
    }
  });

  it('свой источник проходит, GET с чужим Origin не проверяется', async () => {
    const own = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { origin: 'http://localhost', host: 'localhost', 'x-test-role': 'admin' } });
    expect(own.statusCode).toBe(200);
    const read = await app.inject({ url: '/api/health', headers: { origin: 'https://evil.example', host: 'localhost' } });
    expect(read.statusCode).toBe(200);
  });
});

describe('проверка подключения по роли', () => {
  const saved = { kind: 'single', selector: [{ label: 'namespace', op: '=', value: 'pay' }] };
  const probe = (role: Role, body: object) => app.inject({ method: 'POST', url: '/api/stores/grafana/probe', headers: { 'x-test-role': role }, payload: body });

  it.each(['support', 'developer'] as const)('%s: сохранённые условия проверяются, ничего не сохранено', async (role) => {
    const r = await probe(role, { project: 'pay', environment: saved });
    expect(r.statusCode, r.body).toBe(200);
    expect((r.json() as { status: string }).status).toBeTruthy();
  });

  it.each(['support', 'developer'] as const)('%s: несохранённые условия отклонены до Grafana', async (role) => {
    const before = grafana.requests.length;
    const r = await probe(role, { project: 'pay', environment: { kind: 'single', selector: [{ label: 'namespace', op: '=', value: 'other' }] } });
    expect(r.statusCode).toBe(403);
    expect(grafana.requests.length).toBe(before);
    const noProject = await probe(role, { environment: saved });
    expect(noProject.statusCode).toBe(403);
    expect(grafana.requests.length).toBe(before);
  });

  it('поддержка проверяет само хранилище без условий', async () => {
    expect((await probe('support', {})).statusCode).toBe(200);
  });

  it('аналитик проверяет несохранённые условия', async () => {
    const r = await probe('analyst', { project: 'pay', environment: { kind: 'single', selector: [{ label: 'namespace', op: '=', value: 'pay-new' }] } });
    expect(r.statusCode).not.toBe(403);
  });
});

describe('строка «Неизвестного» по виду', () => {
  let svc: CatalogService;
  let cat: FastifyInstance;

  beforeAll(async () => {
    const { config } = await tempConfig({ catalog: CATALOG_YAML });
    svc = service(config, 'pglite://memory');
    await svc.start();
    cat = await buildApp({
      config,
      backends: new Backends(config),
      catalog: svc,
      collector: new UnknownCollector(svc),
      testViewer: (req) => ({ owner: 'test', role: req.headers['x-test-role'] as Role, name: null }),
    });
    const at = Date.now();
    const item = (kind: 'method' | 'error', key: string) => ({ project: 'pay', count: 1, env: 'demo', stand: null, exampleCid: 'cid-1', exampleMs: at, firstSeen: at, lastSeen: at, item: { key, kind, systemId: null, methodId: null, httpMethod: null, path: null, rpc: null, host: null, httpStatus: null, code: null, text: null } });
    await store.upsertUnknown(svc.db(), [item('method', 'm|x'), item('error', 'e|x')]);
  }, 60_000);

  afterAll(async () => {
    await cat.close();
    await svc.close();
  });

  const rows = async () => (await cat.inject({ url: '/api/projects/pay/catalog/unknown', headers: { 'x-test-role': 'admin' } })).json() as { items: { id: number; kind: string }[] };
  const hide = (id: number, role: Role) => cat.inject({ method: 'PUT', url: `/api/projects/pay/catalog/unknown/${id}`, headers: { 'x-test-role': role }, payload: { hidden: true } });

  it('поддержка скрывает только ошибку, разработчик — и метод', async () => {
    const { items } = await rows();
    const method = items.find((i) => i.kind === 'method')!;
    const error = items.find((i) => i.kind === 'error')!;
    expect((await hide(method.id, 'support')).statusCode).toBe(403);
    expect((await rows()).items.map((i) => i.id)).toContain(method.id);
    expect((await hide(error.id, 'support')).statusCode).toBe(200);
    expect((await hide(method.id, 'developer')).statusCode).toBe(200);
  });

  it('Бизнес не доходит до базы', async () => {
    expect((await hide(1, 'business')).statusCode).toBe(403);
  });
});
