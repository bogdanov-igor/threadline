// Хранилища локального режима: правила проверки как у файла настроек, файл 0600, секреты не возвращаются и не пишутся в журнал,
// подключение без перезапуска, в обычном сервере маршрутов нет. Loki только поддельный, на свободном порту этой машины.

import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LocalStorageInfo, LocalStoragesResponse, ProbeResponse, ProjectSettingsResponse, ProjectsResponse } from '@threadline/core';
import { validateConfig } from '@threadline/core/config';
import { buildApp } from '../../src/app.ts';
import { Backends } from '../../src/backends/registry.ts';
import type { ResolvedConfig } from '../../src/config/load.ts';
import { checkStorage, LocalStorages } from '../../src/local/storages.ts';

const TOKEN = 'glsa_local-test-token-0123456789';
const PASSWORD = 'local-test-password-xyz';
const NOW = '2026-11-12T10:00:00.000Z';

const check = (id: string, input: Record<string, unknown>) => checkStorage(id, input, NOW);
const fieldsOf = (id: string, input: Record<string, unknown>) => {
  const r = check(id, input);
  return r.ok ? {} : r.fields;
};

describe('проверка хранилища', () => {
  it('Grafana: токен обязателен, источник по умолчанию Loki, граница открыта по метке', () => {
    expect(fieldsOf('g', { type: 'loki-grafana', url: 'https://grafana.example' })).toHaveProperty('token');
    const r = check('g', { type: 'loki-grafana', url: 'https://grafana.example', token: ` ${TOKEN} ` });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.stored).toMatchObject({ type: 'loki-grafana', datasource: { name: 'Loki' }, auth: 'bearer', token: TOKEN, scopeLabel: 'namespace' });
    expect(r.resolved).toMatchObject({ type: 'loki-grafana', token: TOKEN, formScope: { label: 'namespace', values: ['*'] }, maxConcurrent: 4 });
  });

  it('те же правила, что у файла настроек: адрес, путь API, арендатор, метка', () => {
    expect(fieldsOf('l', { type: 'loki', url: 'ftp://loki.example' })).toHaveProperty('url');
    expect(fieldsOf('l', { type: 'loki', url: 'http://loki.example:3100/loki/api/v1' }).url).toMatch(/\/loki\/api\/v1/);
    expect(fieldsOf('l', { type: 'loki', url: 'http://user:pw@loki.example' })).toHaveProperty('url');
    expect(fieldsOf('l', { type: 'loki', url: 'http://loki.example', tenant: 'a b' })).toHaveProperty('tenant');
    expect(fieldsOf('l', { type: 'loki', url: 'http://loki.example', scopeLabel: '1bad' })).toHaveProperty('scopeLabel');
    expect(fieldsOf('g', { type: 'loki-grafana', url: 'https://grafana.example', token: TOKEN, tenant: 'x' })).toHaveProperty('tenant');
    expect(fieldsOf('Bad_Id', { type: 'loki', url: 'http://loki.example' })).toHaveProperty('id');
    expect(fieldsOf('x', { type: 'victoria', url: 'http://v.example' })).toHaveProperty('type');
  });

  it('вход в Loki: без входа, Bearer, Basic; секреты без управляющих символов и без значений в сообщениях', () => {
    expect(check('l', { type: 'loki', url: 'http://localhost:3100' }).ok).toBe(true);
    expect(fieldsOf('l', { type: 'loki', url: 'http://localhost:3100', auth: 'bearer' })).toHaveProperty('token');
    expect(fieldsOf('l', { type: 'loki', url: 'http://localhost:3100', auth: 'basic', username: 'u' })).toHaveProperty('password');
    expect(fieldsOf('l', { type: 'loki', url: 'http://localhost:3100', auth: 'basic', username: 'a:b', password: PASSWORD })).toHaveProperty('username');
    const bad = fieldsOf('l', { type: 'loki', url: 'http://localhost:3100', auth: 'bearer', token: `${TOKEN}\nX-Evil: 1` });
    expect(bad).toHaveProperty('token');
    expect(JSON.stringify(bad)).not.toContain(TOKEN);
    expect(fieldsOf('l', { type: 'loki', url: 'http://localhost:3100', auth: 'magic' })).toHaveProperty('auth');
    const basic = check('l', { type: 'loki', url: 'http://localhost:3100', auth: 'basic', username: 'reader', password: PASSWORD, token: 'ignored-token' });
    expect(basic.ok && basic.resolved).toMatchObject({ username: 'reader', password: PASSWORD });
    expect(basic.ok && 'token' in basic.resolved).toBe(false);
  });
});

describe('файл storages.json', () => {
  let dir: string;
  const warnings: string[] = [];
  const log = { warn: (m: string) => void warnings.push(m) };
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'threadline-local-'));
    warnings.length = 0;
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('запись атомарная с правами 0600, чтение возвращает те же хранилища', async () => {
    const s = new LocalStorages(dir);
    const r = check('g', { type: 'loki-grafana', url: 'https://grafana.example', token: TOKEN });
    if (!r.ok) throw new Error('не прошло');
    await s.add('g', r.stored);
    expect((await stat(s.file)).mode & 0o777).toBe(0o600);
    const again = new LocalStorages(dir);
    const loaded = await again.load(log);
    expect([...loaded.keys()]).toEqual(['g']);
    expect(loaded.get('g')).toMatchObject({ token: TOKEN });
    expect(await again.remove('g')).toBe(true);
    expect(await again.remove('g')).toBe(false);
    expect(JSON.parse(await readFile(s.file, 'utf8'))).toEqual({ version: 1, storages: {} });
  });

  it('файл, открытый другим, сужается до 0600; неверная запись пропускается; испорченный файл откладывается', async () => {
    const file = join(dir, 'storages.json');
    await writeFile(file, JSON.stringify({ version: 1, storages: { ok: { type: 'loki', url: 'http://localhost:3100', auth: 'none', scopeLabel: 'job', addedAt: NOW }, bad: { type: 'loki', url: 'nope', auth: 'bearer', token: TOKEN } } }), { mode: 0o644 });
    const loaded = await new LocalStorages(dir).load(log);
    expect([...loaded.keys()]).toEqual(['ok']);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(warnings.join('\n')).toMatch(/0600/);
    expect(warnings.join('\n')).toMatch(/«bad» пропущено/);
    expect(warnings.join('\n')).not.toContain(TOKEN);

    await writeFile(file, '{ not json', { mode: 0o600 });
    expect((await new LocalStorages(dir).load(log)).size).toBe(0);
    expect(await readFile(`${file}.bad`, 'utf8')).toBe('{ not json');
  });
});

// ---------- API ----------

interface FakeLoki {
  url: string;
  calls: string[];
  close(): Promise<void>;
}

async function fakeLoki(): Promise<FakeLoki> {
  const calls: string[] = [];
  const server: Server = createServer((req, res) => {
    calls.push(req.url ?? '');
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { 'content-type': 'text/plain' }).end('no auth');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'success', data: ['namespace', 'job'] }));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, calls, close: () => new Promise((done) => server.close(() => done())) };
}

function baseConfig(): ResolvedConfig {
  const v = validateConfig({
    auth: 'off',
    defaults: { project: 'pay', environment: 'demo' },
    backends: { demo: { type: 'mock' } },
    projects: { pay: { name: 'Demo Pay', environments: { demo: { name: 'Демо', backend: 'demo', selector: [{ label: 'namespace', op: '=', value: 'pay' }] } } } },
  });
  if (!v.ok) throw new Error(JSON.stringify(v.issues));
  return { path: '/нет/threadline.yaml', config: v.config, backends: { demo: { type: 'mock', dataset: 'pay', latencyMs: 0, maxConcurrent: 4, queueTimeoutSeconds: 60, timeoutSeconds: 30 } } };
}

describe('API хранилищ', () => {
  let dir: string;
  let app: FastifyInstance;
  let loki: FakeLoki;
  let logs: string;

  const up = async (local = true) => {
    const config = baseConfig();
    logs = '';
    const stream = new Writable({
      write(chunk, _enc, done) {
        logs += String(chunk);
        done();
      },
    });
    app = await buildApp({ config, backends: new Backends(config), databaseUrl: 'pglite://memory', logger: { stream }, ...(local ? { local: { storages: new LocalStorages(dir) } } : {}) });
    // Правка проектов открывается, когда база подключена и сверена с файлом.
    for (let i = 0; i < 100 && !(await app.inject('/api/project-settings')).json<ProjectSettingsResponse>().editable; i++) await new Promise((r) => setTimeout(r, 50));
  };
  const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, payload: payload as object });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'threadline-local-api-'));
    loki = await fakeLoki();
  });
  afterEach(async () => {
    await app?.close();
    await loki.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('в обычном сервере маршрутов нет', async () => {
    await up(false);
    expect((await app.inject('/api/local/storages')).statusCode).toBe(404);
    expect((await post('/api/local/storages', { id: 'x', type: 'loki', url: loki.url })).statusCode).toBe(404);
    expect((await post('/api/local/storages/check', { id: 'x', type: 'loki', url: loki.url })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: '/api/local/storages/x' })).statusCode).toBe(404);
    expect((await app.inject('/api/auth/me')).json()).not.toHaveProperty('local');
  });

  it('проверка, сохранение без перезапуска, проект на новом хранилище, удаление', async () => {
    await up();
    expect((await app.inject('/api/auth/me')).json()).toMatchObject({ local: true, role: 'admin' });
    expect((await app.inject('/api/local/storages')).json<LocalStoragesResponse>()).toMatchObject({ storages: [], realStores: 0, file: join(dir, 'storages.json') });

    const input = { id: 'mine', type: 'loki', url: loki.url, auth: 'bearer', token: TOKEN, scopeLabel: 'namespace' };
    const wrong = (await post('/api/local/storages/check', { ...input, token: 'wrong-token-value' })).json<ProbeResponse>();
    expect(wrong.status).toBe('unauthorized');
    const ok = (await post('/api/local/storages/check', input)).json<ProbeResponse>();
    expect(ok).toMatchObject({ status: 'connected', backend: 'loki', labelNames: ['job', 'namespace'] });
    // Проверка ничего не сохраняет.
    expect((await app.inject('/api/local/storages')).json<LocalStoragesResponse>().storages).toEqual([]);

    const saved = await post('/api/local/storages', input);
    expect(saved.statusCode).toBe(201);
    expect(saved.json<LocalStorageInfo>()).toEqual({ id: 'mine', type: 'loki', url: loki.url, auth: 'bearer', tokenSet: true, scopeLabel: 'namespace', usedBy: [], addedAt: expect.any(String) });
    expect((await stat(join(dir, 'storages.json'))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(dir, 'storages.json'), 'utf8')).toContain(TOKEN);

    // Без перезапуска: страница сервиса и форма проекта видят хранилище, проверка подключения идёт в него.
    const settings = (await app.inject('/api/project-settings')).json<ProjectSettingsResponse>();
    expect(settings.stores.find((s) => s.id === 'mine')).toMatchObject({ type: 'loki', tokenSet: true, scope: { label: 'namespace', values: ['*'] } });
    expect((await post('/api/stores/mine/probe', {})).json<ProbeResponse>()).toMatchObject({ status: 'connected' });

    const project = await post('/api/projects', {
      id: 'shop',
      name: 'Shop',
      timezone: 'UTC',
      retentionDays: 30,
      format: 'json',
      environments: [{ id: 'prod', name: 'Прод', kind: 'single', backend: 'mine', selector: [{ label: 'namespace', op: '=', value: 'shop' }] }],
    });
    expect(project.statusCode).toBe(201);
    const env = (await app.inject('/api/projects')).json<ProjectsResponse>().projects.find((p) => p.id === 'shop')?.environments[0];
    expect(env).toMatchObject({ id: 'prod', backendType: 'loki', notConfigured: false });
    expect((await app.inject('/api/projects/shop/envs/prod/connection')).json()).toMatchObject({ status: 'connected' });
    expect((await app.inject('/api/local/storages')).json<LocalStoragesResponse>()).toMatchObject({ realStores: 1, storages: [{ id: 'mine', usedBy: ['shop/prod'] }] });

    // Имя занято: этим же и хранилищем файла настроек.
    expect((await post('/api/local/storages', input)).json()).toMatchObject({ error: { code: 'storage-exists' } });
    expect((await post('/api/local/storages', { ...input, id: 'demo' })).statusCode).toBe(409);

    expect((await app.inject({ method: 'DELETE', url: '/api/local/storages/demo' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: '/api/local/storages/mine' })).statusCode).toBe(204);
    expect((await app.inject('/api/project-settings')).json<ProjectSettingsResponse>().stores.map((s) => s.id)).toEqual(['demo']);
    expect((await app.inject('/api/projects')).json<ProjectsResponse>().projects.find((p) => p.id === 'shop')?.environments[0]).toMatchObject({ notConfigured: true, missingStore: 'mine' });
    expect((await app.inject({ method: 'DELETE', url: '/api/local/storages/mine' })).json()).toMatchObject({ error: { code: 'storage-not-found' } });

    // Секретов нет ни в одном ответе и ни в одной записи журнала.
    for (const url of ['/api/local/storages', '/api/project-settings', '/api/projects']) expect((await app.inject(url)).body).not.toContain(TOKEN);
    expect(saved.body).not.toContain(TOKEN);
    expect(logs).not.toContain(TOKEN);
    expect(logs).toContain('подключено хранилище «mine»');
  });

  it('неверное хранилище: 422 с полями и без значений секрета', async () => {
    await up();
    const r = await post('/api/local/storages', { id: 'g', type: 'loki-grafana', url: 'grafana', token: `${TOKEN} x` });
    expect(r.statusCode).toBe(422);
    expect(Object.keys(r.json().error.fields).sort()).toEqual(['token', 'url']);
    expect(r.body).not.toContain(TOKEN);
    expect((await post('/api/local/storages/check', { type: 'loki' })).json()).toMatchObject({ error: { code: 'storage-invalid', fields: { url: expect.any(String) } } });
    // Ошибка хранилища в подробностях проверки тоже без токена: поддельный Loki отвечает своим текстом.
    const basic = (await post('/api/local/storages/check', { type: 'loki', url: loki.url, auth: 'basic', username: 'u', password: PASSWORD })).json<ProbeResponse>();
    expect(basic.status).toBe('unauthorized');
    expect(JSON.stringify(basic)).not.toContain(PASSWORD);
  });
});
