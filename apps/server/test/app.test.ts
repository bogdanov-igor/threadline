import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MOCK_FAIL_MODES } from '@threadline/core/config';
import { buildApp } from '../src/app.ts';
import { Backends } from '../src/backends/registry.ts';
import { readBuildInfo } from '../src/build-info.ts';
import { loadConfig, missingSecret } from '../src/config/load.ts';
import { ROOT } from '../src/paths.ts';
import { fakeGrafana, grafana85, json } from './fake-grafana.ts';

const TOKEN = 'eyJrIjoiYXBwLXRlc3QtdG9rZW4ifQ==';
// Переменная без префикса THREADLINE_ не читается.
const BARE_TOKEN_ENV = 'GRAFANA_TOKEN';

function yaml(grafanaUrl = 'https://grafana.corp.example') {
  const fails = MOCK_FAIL_MODES.map((m) => `  fail-${m}:\n    type: mock\n    fail: ${m}\n`).join('');
  const failEnvs = MOCK_FAIL_MODES.map(
    (m) => `      fail-${m}:\n        name: ${m}\n        backend: fail-${m}\n        selector: [{ label: namespace, op: "=", value: pay }]\n`,
  ).join('');
  return `
auth: off
defaults: { project: pay, environment: prod }
backends:
  grafana:
    type: loki-grafana
    url: ${grafanaUrl}
    tokenEnv: THREADLINE_TEST_TOKEN
  demo:
    type: mock
${fails}
projects:
  pay:
    name: Demo Pay
    environments:
      prod:
        name: Прод
        backend: grafana
        selector: [{ label: cluster, op: "=", value: demo-cluster }, { label: namespace, op: "=", value: pay }]
      pr:
        name: Стенды PR
        kind: pr-stands
        backend: grafana
        stand: { label: namespace, template: "pay-pr-{number}" }
      demo:
        name: Демо
        backend: demo
        selector: [{ label: namespace, op: "=", value: pay }]
      demo-pr:
        name: Демо стенды
        kind: pr-stands
        backend: demo
        stand: { label: namespace, template: "pay-pr-{number}" }
${failEnvs}`;
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup(opts: { token?: string; grafanaUrl?: string; webDist?: string; logs?: string[] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'threadline-app-'));
  await writeFile(join(dir, 'threadline.yaml'), yaml(opts.grafanaUrl));
  const config = await loadConfig({ path: join(dir, 'threadline.yaml'), env: opts.token ? { THREADLINE_TEST_TOKEN: opts.token } : {} });
  const backends = new Backends(config);
  const logger = opts.logs
    ? {
        stream: new Writable({
          write(chunk, _enc, cb) {
            opts.logs!.push(String(chunk));
            cb();
          },
        }),
      }
    : false;
  const app = await buildApp({ config, backends, webDist: opts.webDist, logger });
  cleanups.push(() => app.close());
  return app;
}

describe('API', () => {
  it('отвечает на проверку здоровья с заголовками безопасности', async () => {
    const app = await setup();
    const r = await app.inject('/api/health');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: 'ok' });
    expect(r.headers['content-security-policy']).toContain("default-src 'self'");
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
  });

  it('версия из корневого package.json; ревизия и дата только из образа, нечитаемой даты нет', async () => {
    const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
    expect(readBuildInfo({})).toEqual({ version });
    expect(readBuildInfo({ THREADLINE_REVISION: ' ', THREADLINE_BUILD_DATE: '' })).toEqual({ version });
    expect(readBuildInfo({ THREADLINE_REVISION: 'abc123', THREADLINE_BUILD_DATE: 'вчера' })).toEqual({ version, revision: 'abc123' });
    expect(readBuildInfo({ THREADLINE_REVISION: 'abc123', THREADLINE_BUILD_DATE: '2026-11-06T09:30:00Z' })).toEqual({ version, revision: 'abc123', builtAt: '2026-11-06T09:30:00.000Z' });
    const app = await setup();
    expect((await app.inject('/api/health')).json()).toMatchObject({ status: 'ok', version });
  });

  it('отдаёт проекты без токенов, адресов и селекторов', async () => {
    const app = await setup({ token: TOKEN });
    const r = await app.inject('/api/projects');
    const text = r.body;
    expect(r.json()).toMatchObject({ defaults: { project: 'pay', environment: 'prod' } });
    for (const secret of [TOKEN, 'grafana.corp.example', 'selector', 'demo-cluster', 'pay-pr-{number}', 'THREADLINE_TEST_TOKEN']) {
      expect(text).not.toContain(secret);
    }
    const envs = r.json().projects[0].environments;
    expect(envs.find((e: { id: string }) => e.id === 'pr')).toMatchObject({ kind: 'pr-stands', backendType: 'loki-grafana', notConfigured: false });
  });

  it('называет переменную для ненастроенной среды', async () => {
    const app = await setup();
    const prod = (await app.inject('/api/projects')).json().projects[0].environments[0];
    expect(prod).toMatchObject({ notConfigured: true, missingEnv: 'THREADLINE_TEST_TOKEN' });
    const r = await app.inject('/api/projects/pay/envs/prod/connection');
    expect(r.json()).toMatchObject({ status: 'not-configured', missingEnv: 'THREADLINE_TEST_TOKEN' });
  });

  describe('задана только переменная без префикса', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('сервер запускается, значение не использует, среды хранилища не настроены с именем переменной из файла', async () => {
      const g = await fakeGrafana(grafana85({ values: ['pay', 'pay-pr-92', 'pay-pr-105', 'pay-pr-test'] }));
      cleanups.push(g.close);
      const dir = await mkdtemp(join(tmpdir(), 'threadline-bare-env-'));
      await writeFile(join(dir, 'threadline.yaml'), yaml(g.url).replace('tokenEnv: THREADLINE_TEST_TOKEN', 'tokenEnv: THREADLINE_GRAFANA_TOKEN'));
      // Как при настоящем запуске: main.ts читает process.env.
      vi.stubEnv(BARE_TOKEN_ENV, TOKEN);
      vi.stubEnv('THREADLINE_GRAFANA_TOKEN', undefined);

      const config = await loadConfig({ path: join(dir, 'threadline.yaml') });
      expect(config.backends.grafana).toMatchObject({ token: undefined });
      const app = await buildApp({ config, backends: new Backends(config), logger: false });
      cleanups.push(() => app.close());
      await app.listen({ port: 0, host: '127.0.0.1' });
      expect((await app.inject('/api/health')).statusCode).toBe(200);

      const projects = await app.inject('/api/projects');
      const envs = projects.json().projects[0].environments as { id: string }[];
      for (const id of ['prod', 'pr']) {
        expect(envs.find((e) => e.id === id)).toMatchObject({ notConfigured: true, missingEnv: 'THREADLINE_GRAFANA_TOKEN' });
        const r = await app.inject(`/api/projects/pay/envs/${id}/connection`);
        expect(r.json()).toMatchObject({ status: 'not-configured', missingEnv: 'THREADLINE_GRAFANA_TOKEN' });
        expect(r.body).not.toContain(TOKEN);
      }
      expect(projects.body).not.toContain(TOKEN);
      expect((await app.inject('/api/projects/pay/envs/demo/connection')).json().status).toBe('demo');
      expect(g.requests).toHaveLength(0);
    });

    it('config/threadline.yaml ждёт токен только в переменной с префиксом', async () => {
      const c = await loadConfig({ env: { [BARE_TOKEN_ENV]: TOKEN, THREADLINE_GRAFANA_URL: 'https://grafana.corp.example' } });
      expect(missingSecret(c.backends.grafana!)).toBe('THREADLINE_GRAFANA_TOKEN');
    });
  });

  it('отвечает «демо» для демо-среды', async () => {
    const app = await setup();
    expect((await app.inject('/api/projects/pay/envs/demo/connection')).json().status).toBe('demo');
  });

  it.each(MOCK_FAIL_MODES)('передаёт состояние %s', async (mode) => {
    const app = await setup();
    const r = await app.inject(`/api/projects/pay/envs/fail-${mode}/connection`);
    expect(r.statusCode).toBe(200);
    expect(r.json().status).toBe(mode);
  });

  it('отвечает на неизвестную среду и неверный идентификатор', async () => {
    const app = await setup();
    const unknown = await app.inject('/api/projects/pay/envs/nope/connection');
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: { code: 'unknown-environment' } });
    expect((await app.inject('/api/projects/BAD_/envs/prod/connection')).statusCode).toBe(400);
  });

  it('отдаёт живые стенды и проверяет номер', async () => {
    const app = await setup();
    expect((await app.inject('/api/projects/pay/envs/demo-pr/stands')).json()).toEqual({ stands: [105, 92] });
    expect((await app.inject('/api/projects/pay/envs/demo-pr/stands/92')).json()).toEqual({ stand: 92, live: true });
    expect((await app.inject('/api/projects/pay/envs/demo-pr/stands/93')).json()).toEqual({ stand: 93, live: false });
    expect((await app.inject('/api/projects/pay/envs/demo/stands')).json().error.code).toBe('not-pr-stands');
  });

  it('отклоняет номер стенда с недопустимыми символами, не обращаясь к хранилищу', async () => {
    const g = await fakeGrafana(grafana85({ values: ['pay', 'pay-pr-92', 'pay-pr-105', 'pay-pr-test'] }));
    cleanups.push(g.close);
    const app = await setup({ token: TOKEN, grafanaUrl: g.url });
    const r = await app.inject(`/api/projects/pay/envs/pr/stands/${encodeURIComponent('92"} or {x="1')}`);
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('bad-request');
    expect(g.requests).toHaveLength(0);
  });

  it('ходит в Grafana за стендами и отвечает понятной ошибкой хранилища', async () => {
    const g = await fakeGrafana((_q, res) => json(res, 429, { message: 'too many outstanding requests' }, { 'retry-after': '20' }));
    cleanups.push(g.close);
    const app = await setup({ token: TOKEN, grafanaUrl: g.url });
    const r = await app.inject('/api/projects/pay/envs/pr/stands');
    expect(r.statusCode).toBe(503);
    expect(g.requests).toHaveLength(1);
    expect(r.headers['retry-after']).toBe('20');
    expect(r.json()).toMatchObject({ error: { code: 'overloaded', retryAfterSeconds: 20 } });
  });

  it('прерывает запрос к Grafana не позже чем через секунду после закрытия соединения', async () => {
    const g = await fakeGrafana((req, res) => {
      if (req.url!.startsWith('/api/datasources/id/')) return json(res, 200, { id: 7 });
      // прокси «висит»
    });
    cleanups.push(g.close);
    const app = await setup({ token: TOKEN, grafanaUrl: g.url });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    const ac = new AbortController();
    const pending = fetch(`http://127.0.0.1:${port}/api/projects/pay/envs/prod/connection`, { signal: ac.signal }).catch(() => {});
    for (let i = 0; i < 50 && !g.requests.some((r) => r.url.includes('/proxy/')); i++) await new Promise((r) => setTimeout(r, 20));
    const abortedAt = Date.now();
    ac.abort();
    await pending;
    for (let i = 0; i < 50 && !g.requests.find((r) => r.url.includes('/proxy/'))?.closedEarly; i++) await new Promise((r) => setTimeout(r, 20));
    const proxied = g.requests.find((r) => r.url.includes('/proxy/'))!;
    expect(proxied.closedEarly).toBe(true);
    expect(proxied.closedAt! - abortedAt).toBeLessThan(1000);
  });

  it('не пишет в журнал токен и параметры запроса', async () => {
    const logs: string[] = [];
    const g = await fakeGrafana((req, res) => json(res, 401, { message: `Invalid API key ${req.headers.authorization}` }));
    cleanups.push(g.close);
    const app = await setup({ token: TOKEN, grafanaUrl: g.url, logs });
    await app.inject({ url: '/api/projects/pay/envs/prod/connection?refresh=1&q=4111110000000000', headers: { authorization: 'Bearer client-secret' } });
    const all = logs.join('\n');
    expect(all).toContain('/api/projects/:project/envs/:env/connection');
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain('client-secret');
    expect(all).not.toContain('4111110000000000');
  });

  it('не отдаёт токен в ответе об ошибке', async () => {
    const g = await fakeGrafana((req, res) => json(res, 401, { message: `Invalid API key ${req.headers.authorization}` }));
    cleanups.push(g.close);
    const app = await setup({ token: TOKEN, grafanaUrl: g.url });
    const r = await app.inject('/api/projects/pay/envs/prod/connection');
    expect(r.json().status).toBe('unauthorized');
    expect(r.body).not.toContain(TOKEN);
  });
});

describe('настройка во время работы', () => {
  it('изменения файла применяются только после перезапуска', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'threadline-live-'));
    const file = join(dir, 'threadline.yaml');
    await writeFile(file, yaml());
    const config = await loadConfig({ path: file, env: {} });
    const app = await buildApp({ config, backends: new Backends(config) });
    cleanups.push(() => app.close());
    await writeFile(file, yaml().replace('name: Demo Pay', 'name: Переименован'));
    expect((await app.inject('/api/projects')).json().projects[0].name).toBe('Demo Pay');
  });

  it('демо-среды нет, если её нет в файле', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'threadline-nodemo-'));
    const file = join(dir, 'threadline.yaml');
    await writeFile(file, yaml().replace(/ {6}demo:\n {8}name: Демо\n {8}backend: demo\n {8}selector: \[[^\n]*\]\n/, ''));
    const config = await loadConfig({ path: file, env: {} });
    const app = await buildApp({ config, backends: new Backends(config) });
    cleanups.push(() => app.close());
    const ids = (await app.inject('/api/projects')).json().projects[0].environments.map((e: { id: string }) => e.id);
    expect(ids).not.toContain('demo');
    expect((await app.inject('/api/projects/pay/envs/demo/connection')).statusCode).toBe(404);
  });
});

describe('раздача интерфейса', () => {
  async function dist() {
    const d = await mkdtemp(join(tmpdir(), 'threadline-web-'));
    await mkdir(join(d, 'assets'));
    await writeFile(join(d, 'index.html'), '<!doctype html><title>Threadline</title>');
    await writeFile(join(d, 'assets', 'app-abc123.js'), 'console.log(1)');
    await writeFile(join(d, 'theme-init.js'), '1');
    await writeFile(join(d, 'manifest.webmanifest'), '{"name":"Threadline"}');
    await writeFile(join(d, 'sw.js'), 'self.addEventListener("fetch", () => {})');
    return d;
  }

  it('отдаёт index.html на адреса страниц интерфейса', async () => {
    const app = await setup({ webDist: await dist() });
    const r = await app.inject('/pay/prod');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/html');
    expect(r.body).toContain('<title>Threadline</title>');
    expect(r.headers['cache-control']).toBe('no-cache');
  });

  it('отдаёт файлы сборки с долгим кэшем, остальные без кэша', async () => {
    const app = await setup({ webDist: await dist() });
    expect((await app.inject('/assets/app-abc123.js')).headers['cache-control']).toContain('immutable');
    expect((await app.inject('/theme-init.js')).headers['cache-control']).toBe('no-cache');
  });

  it('манифест и воркер приложения: свой тип, без долгого кэша, политика разрешает их со своего адреса', async () => {
    const app = await setup({ webDist: await dist() });
    const manifest = await app.inject('/manifest.webmanifest');
    expect(manifest.statusCode).toBe(200);
    expect(manifest.headers['content-type']).toContain('application/manifest+json');
    expect(manifest.headers['cache-control']).toBe('no-cache');
    // Воркер без долгого кэша: браузер видит новую версию на следующей загрузке.
    const sw = await app.inject('/sw.js');
    expect(sw.statusCode).toBe(200);
    expect(sw.headers['content-type']).toMatch(/^(?:text|application)\/javascript/);
    expect(sw.headers['cache-control']).toBe('no-cache');
    const csp = (await app.inject('/pay/prod')).headers['content-security-policy'];
    expect(csp).toContain("worker-src 'self'");
    expect(csp).toContain("manifest-src 'self'");
  });

  it('отвечает JSON на неизвестный метод API', async () => {
    const app = await setup({ webDist: await dist() });
    const r = await app.inject('/api/nope');
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe('bad-request');
  });
});
