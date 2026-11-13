// Проверки состояния: живость, готовность, адреса не уходят в интерфейс.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { databaseCheck, Health } from '../../src/health.ts';
import { authYaml, CLIENT_SECRET, FakeOidc } from '../fake-oidc.ts';
import { PROJECTS_YAML, PUBLIC_URL, SESSION_SECRET } from '../auth/harness.ts';
import { loadConfig } from '../../src/config/load.ts';
import { buildApp } from '../../src/app.ts';
import { Backends } from '../../src/backends/registry.ts';
import { configDir, mockApp } from './kit.ts';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const SECRET_HOST = 'db-host.corp.example';

type DbState = 'off' | 'ok' | 'stale' | 'connecting' | 'error';

/** Состояние справочника для проверки; loadedAt есть, когда справочник уже загружался. */
function source(state: DbState, loadedAt: number | null = state === 'ok' || state === 'stale' ? 1 : null) {
  const s = { state, loadedAt };
  return {
    enabled: state !== 'off',
    set(next: DbState, at: number | null = s.loadedAt) {
      s.state = next;
      s.loadedAt = at;
    },
    state: () => ({ state: s.state, loadedAt: s.loadedAt, message: `${SECRET_HOST} не отвечает` }),
  };
}

describe('готовность', () => {
  it.each([
    ['off', 'off', 200],
    ['ok', 'ok', 200],
    ['stale', 'stale', 200],
    ['connecting', 'connecting', 503],
    ['error', 'error', 503],
  ] as const)('состояние базы %s: проверка %s, код %i', async (state, check, code) => {
    const health = new Health();
    ({ app } = await mockApp({ health }));
    health.add('database', databaseCheck(source(state)));
    for (const url of ['/health', '/health/readiness']) {
      const r = await app.inject(url);
      expect(r.statusCode).toBe(code);
      expect(r.json().checks).toEqual({ database: check, login: 'off' });
      expect(r.body).not.toContain(SECRET_HOST);
    }
  });

  it('база пропала после первой загрузки: готовность 200 со stale, база в проверке не запрашивается; вернулась — ok', async () => {
    const health = new Health();
    ({ app } = await mockApp({ health }));
    const db = source('connecting');
    health.add('database', databaseCheck(db));
    expect((await app.inject('/health/readiness')).statusCode).toBe(503);
    db.set('ok', 1000);
    expect((await app.inject('/health/readiness')).json().checks.database).toBe('ok');
    db.set('stale');
    const r = await app.inject('/health/readiness');
    expect([r.statusCode, r.json().checks.database]).toEqual([200, 'stale']);
    expect(r.body).not.toContain(SECRET_HOST);
    // Том пересоздан: таблиц нет, схема отстала. Данные в памяти остались, под не снимается.
    db.set('connecting');
    expect((await app.inject('/health/readiness')).json()).toEqual({ status: 'ready', checks: { database: 'stale', login: 'off' } });
    db.set('error');
    expect((await app.inject('/health/readiness')).statusCode).toBe(200);
    db.set('ok');
    expect((await app.inject('/health/readiness')).json().checks.database).toBe('ok');
    expect((await app.inject('/health/liveness')).statusCode).toBe(200);
  });

  it('загрузка прошла между пробами: следующая проба уже не снимает под', async () => {
    const db = source('connecting');
    const check = databaseCheck(db);
    expect(await check()).toBe('connecting');
    // Справочник загрузился и сразу потерял базу: проверка ok не видела, но данные в памяти есть.
    db.set('stale', 1000);
    expect(await check()).toBe('stale');
  });

  it('схема отстала при старте: 503 error, пока справочник не загрузится', async () => {
    const db = source('error');
    const check = databaseCheck(db);
    expect(await check()).toBe('error');
    db.set('ok', 1000);
    expect(await check()).toBe('ok');
  });

  it('после начала остановки 503, в том числе когда зависимости в порядке; живость 200', async () => {
    const health = new Health();
    ({ app } = await mockApp({ health }));
    expect((await app.inject('/health/readiness')).statusCode).toBe(200);
    health.beginShutdown();
    const r = await app.inject('/health/readiness');
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({ status: 'not-ready', checks: { shutdown: 'in-progress' } });
    expect((await app.inject('/health')).statusCode).toBe(503);
    expect((await app.inject('/health/liveness')).json()).toEqual({ status: 'alive' });
  });

  it('сервер без базы: готов, проверка off; Grafana не проверяется', async () => {
    ({ app } = await mockApp());
    const r = await app.inject('/health/readiness');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ status: 'ready', checks: { database: 'off', login: 'off' } });
  });
});

describe('адреса и интерфейс', () => {
  it('интерфейс не перехватывает проверки и метрики, /api/health на месте', async () => {
    const dir = await configDir();
    const dist = join(dir, 'dist');
    await mkdir(dist);
    await writeFile(join(dist, 'index.html'), '<html>интерфейс</html>');
    ({ app } = await mockApp({ webDist: dist }));
    for (const url of ['/health', '/health/liveness', '/health/readiness', '/metrics', '/api/health']) {
      const r = await app.inject(url);
      expect(r.statusCode, url).toBe(200);
      expect(r.body, url).not.toContain('интерфейс');
    }
    expect((await app.inject('/pay/demo')).body).toContain('интерфейс');
  });
});

describe('Keycloak и готовность', () => {
  it('недоступен при старте: сервер работает, 503, поднялся: сам получает настройки, 200; пропал позже: 200', async () => {
    const fake = await new FakeOidc().start();
    const dir = await configDir(`${authYaml(fake.issuer, PUBLIC_URL)}${PROJECTS_YAML}`);
    const config = await loadConfig({ path: join(dir, 'threadline.yaml'), env: {} });
    fake.mode = 'down';
    app = await buildApp({ config, backends: new Backends(config), logger: false, authSecrets: { clientSecret: CLIENT_SECRET, sessionSecret: SESSION_SECRET }, authTimeoutSeconds: 1 });
    try {
      await app.listen({ host: '127.0.0.1', port: 0 });
      const first = await app.inject('/health/readiness');
      expect(first.statusCode).toBe(503);
      expect(first.json().checks.login).toBe('waiting');
      expect((await app.inject('/health/liveness')).statusCode).toBe(200);
      fake.mode = 'ok';
      await expect.poll(async () => (await app!.inject('/health/readiness')).statusCode, { timeout: 8000, interval: 200 }).toBe(200);
      fake.mode = 'down';
      expect((await app.inject('/health/readiness')).statusCode).toBe(200);
    } finally {
      await fake.stop();
    }
  });
});
