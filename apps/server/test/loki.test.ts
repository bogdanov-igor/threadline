// Loki напрямую, без Grafana: ложный Loki на локальном порту. Адреса и значения выдуманы.
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { BackendError, type CountQuery, type LinesQuery } from '@threadline/core/backend';
import { validateConfig } from '@threadline/core/config';
import { BUILTIN_COUNT_REGEXP } from '@threadline/core/profile';
import { LokiBackend, TENANT_HEADER } from '../src/backends/loki.ts';
import { countLogql, linesLogql } from '../src/backends/logql.ts';
import { Backends } from '../src/backends/registry.ts';
import { loadConfig, missingSecret, startIssues, type ResolvedLokiDirect } from '../src/config/load.ts';
import { ownSecrets } from '../src/search/own-secrets.ts';
import { fakeGrafana as fakeHttp, json, type Handler } from './fake-grafana.ts';

const TOKEN = 'loki-test-token-0123456789';
const PASSWORD = 'loki-test-password-0123';
let servers: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
});

const signal = () => AbortSignal.timeout(5000);
const API = '/loki/api/v1';

/** Типовой Loki: метки, значения метки, строки и подсчёт. */
function loki(opts: { labels?: string[] | null; values?: string[]; streams?: unknown[]; vector?: unknown[] } = {}): Handler {
  return (req, res) => {
    const u = new URL(req.url ?? '', 'http://x');
    // Подпуть обратного прокси: Loki за ним отвечает по тем же путям.
    const path = u.pathname.replace(/^\/logs(?=\/loki\/)/, '');
    if (path === `${API}/labels`) return json(res, 200, opts.labels === null ? { status: 'success' } : { status: 'success', data: opts.labels ?? ['namespace', 'container', 'app'] });
    if (path === `${API}/label/namespace/values`) return json(res, 200, { status: 'success', data: opts.values ?? ['acme', 'acme-pr-7'] });
    if (path === `${API}/query_range`) return json(res, 200, { status: 'success', data: { resultType: 'streams', result: opts.streams ?? [] } });
    if (path === `${API}/query`) return json(res, 200, { status: 'success', data: { resultType: 'vector', result: opts.vector ?? [] } });
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('404 page not found\n');
  };
}

async function setup(handler: Handler, over: Partial<ResolvedLokiDirect> = {}, prefix = '') {
  const g = await fakeHttp(handler);
  servers.push(g);
  const cfg: ResolvedLokiDirect = { type: 'loki', url: g.url + prefix, ca: undefined, maxConcurrent: 4, queueTimeoutSeconds: 10, timeoutSeconds: 30, ...over };
  const path = (i: number) => new URL(g.requests[i]!.url, 'http://x');
  return { g, path, backend: new LokiBackend(cfg, { env: {} }) };
}

async function failure(p: Promise<unknown>): Promise<BackendError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof BackendError) return e;
    throw e;
  }
  throw new Error('ожидалась ошибка');
}

const T0 = 1_793_180_000_000;
const selector = [{ label: 'namespace', op: '=' as const, value: 'acme' }];
const lines = (over: Partial<LinesQuery> = {}): LinesQuery => ({ selector, filters: [{ kind: 'contains', value: 'abc' }], range: { fromMs: T0, toMs: T0 + 60_000 }, limit: 100, direction: 'forward', ...over });
const count = (over: Partial<CountQuery> = {}): CountQuery => ({ selector, filters: [], range: { fromMs: T0, toMs: T0 + 3_600_000 }, key: { regexp: BUILTIN_COUNT_REGEXP }, ...over });

describe('Loki напрямую: запросы', () => {
  it('проверка читает метки из /loki/api/v1/labels, без входа заголовков нет', async () => {
    const { g, path, backend } = await setup(loki());
    expect((await backend.check(signal())).labelNames).toEqual(['app', 'container', 'namespace']);
    expect(path(0).pathname).toBe(`${API}/labels`);
    expect(path(0).searchParams.get('start')).toMatch(/^\d+$/);
    expect(g.requests[0]!.headers.authorization).toBeUndefined();
    expect(g.requests[0]!.headers['x-scope-orgid']).toBeUndefined();
  });

  it('пустой Loki без меток отвечает без data: подключение есть, меток нет', async () => {
    const { backend } = await setup(loki({ labels: null }));
    expect((await backend.check(signal())).labelNames).toEqual([]);
  });

  it('Bearer и арендатор в заголовках', async () => {
    const { g, backend } = await setup(loki(), { tokenEnv: 'T', token: TOKEN, tenant: 'team-a|team-b' });
    await backend.check(signal());
    expect(g.requests[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(g.requests[0]!.headers[TENANT_HEADER.toLowerCase()]).toBe('team-a|team-b');
  });

  it('Basic из имени и пароля', async () => {
    const { g, backend } = await setup(loki(), { usernameEnv: 'U', passwordEnv: 'P', username: '12345', password: PASSWORD });
    await backend.check(signal());
    expect(g.requests[0]!.headers.authorization).toBe(`Basic ${Buffer.from(`12345:${PASSWORD}`).toString('base64')}`);
  });

  it('адрес с подпутём за обратным прокси и косой чертой на конце', async () => {
    const { path, backend } = await setup(loki(), {}, '/logs/');
    await backend.check(signal());
    expect(path(0).pathname).toBe(`/logs${API}/labels`);
  });

  it('значения метки с селектором и границами в наносекундах', async () => {
    const { path, backend } = await setup(loki());
    expect(await backend.labelValues('namespace', [{ label: 'namespace', op: '=~', value: 'acme-pr-[0-9]{1,6}' }], { fromMs: 0, toMs: 1000 }, signal())).toEqual(['acme', 'acme-pr-7']);
    const q = path(0).searchParams;
    expect(q.get('query')).toBe('{namespace=~"acme-pr-[0-9]{1,6}"}');
    expect([q.get('start'), q.get('end')]).toEqual(['0', '1000000000']);
  });

  it('строки: то же выражение и границы, что через Grafana; конец включительно; порядок по времени', async () => {
    const streams = [
      { stream: { container: 'main' }, values: [['1793180000000000300', 'a3'], ['1793180000000000100', 'a1']] },
      { stream: { container: 'worker' }, values: [['1793180000000000200', 'b2']] },
    ];
    const { path, backend } = await setup(loki({ streams }));
    const got = await backend.queryLines(lines(), signal());
    expect(got.map((l) => l.line)).toEqual(['a1', 'b2', 'a3']);
    expect(got[1]!.labels).toEqual({ container: 'worker' });
    const q = path(0).searchParams;
    expect(path(0).pathname).toBe(`${API}/query_range`);
    expect(q.get('query')).toBe(linesLogql(selector, [{ kind: 'contains', value: 'abc' }]));
    expect(q.get('start')).toBe(`${T0}000000`);
    expect(q.get('end')).toBe(`${T0 + 60_000}000001`);
    expect([q.get('limit'), q.get('direction')]).toEqual(['100', 'forward']);
  });

  it('подсчёт: мгновенный запрос с окном длиннее периода, ключи из вектора', async () => {
    const vector = [
      { metric: { threadline_key: 'cid-1' }, value: [1793183600, '3'] },
      { metric: { threadline_key: 'cid-2' }, value: [1793183600, '1'] },
    ];
    const { path, backend } = await setup(loki({ vector }));
    expect(await backend.countBy(count(), signal())).toEqual({ 'cid-1': 3, 'cid-2': 1 });
    const q = path(0).searchParams;
    expect(path(0).pathname).toBe(`${API}/query`);
    expect(q.get('query')).toBe(countLogql(count(), 3601));
    expect(q.get('time')).toBe(`${T0 + 3_600_000}000001`);
  });

  it('ссылки в Grafana Explore нет', async () => {
    const { backend } = await setup(loki());
    expect(backend.exploreUrl()).toBeUndefined();
  });
});

describe('Loki напрямую: ошибки как у Grafana', () => {
  it.each([
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [503, 'overloaded'],
  ])('HTTP %i → %s', async (status, expected) => {
    const { backend } = await setup((_q, res) => json(res, status, { message: 'x' }));
    expect((await failure(backend.check(signal()))).code).toBe(expected);
  });

  it('401 «no org id» без арендатора подсказывает поле tenant', async () => {
    const { backend } = await setup((_q, res) => (res.writeHead(401, { 'content-type': 'text/plain' }), res.end('no org id\n')));
    const e = await failure(backend.check(signal()));
    expect(e.code).toBe('unauthorized');
    expect(e.details).toContain('tenant');
  });

  it('404: по адресу нет API Loki, совет про url', async () => {
    const { g, backend } = await setup(loki(), {}, '/wrong');
    const e = await failure(backend.check(signal()));
    expect(e.code).toBe('not-found');
    expect(e.details).toContain(`${g.url}/wrong${API}`);
    expect(e.details).toContain('url');
  });

  it('срок повтора у перегруженного Loki', async () => {
    const { backend } = await setup((_q, res) => json(res, 429, { message: 'too many outstanding requests' }, { 'retry-after': '7' }));
    expect(await failure(backend.check(signal()))).toMatchObject({ code: 'overloaded', retryAfterSeconds: 7 });
  });

  it('лимит Loki', async () => {
    const { backend } = await setup((_q, res) => (res.writeHead(400), res.end('max entries limit per query exceeded, limit > max_entries_limit (5001 > 5000)')));
    expect((await failure(backend.queryLines(lines(), signal()))).code).toBe('limit');
  });

  it('HTML-страница и перенаправление — отказ в правах, текст называет Loki', async () => {
    const html = await setup((_q, res) => (res.writeHead(200, { 'content-type': 'text/html' }), res.end('<html>login</html>')));
    const a = await failure(html.backend.check(signal()));
    expect(a.code).toBe('forbidden');
    expect(a.details).toContain('Loki');
    const redirect = await setup((_q, res) => (res.writeHead(302, { location: '/sso/login' }), res.end()));
    const b = await failure(redirect.backend.check(signal()));
    expect(b.code).toBe('forbidden');
    expect(b.details).toContain('/sso/login');
  });

  it('статус не success — битый ответ', async () => {
    const { backend } = await setup((_q, res) => json(res, 200, { status: 'error', data: [] }));
    expect((await failure(backend.check(signal()))).code).toBe('bad-response');
  });

  it.each([
    ['токен', { tokenEnv: 'T', token: TOKEN }, [TOKEN]],
    ['пароль', { usernameEnv: 'U', passwordEnv: 'P', username: 'user', password: PASSWORD }, [PASSWORD, Buffer.from(`user:${PASSWORD}`).toString('base64')]],
  ])('%s не попадает в текст ошибки', async (_name, over, secrets) => {
    const { backend } = await setup((req, res) => (res.writeHead(500, { 'content-type': 'text/plain' }), res.end(`proxy error, header: ${req.headers.authorization}, ${PASSWORD}`)), over);
    const text = JSON.stringify(await failure(backend.check(signal())));
    for (const s of secrets) expect(text).not.toContain(s);
  });

  it('сеть недоступна', async () => {
    const { g, backend } = await setup(loki());
    await g.close();
    servers = [];
    expect((await failure(backend.check(signal()))).code).toBe('network');
  });

  it('корпоративный прокси из HTTP_PROXY: туннель к адресу Loki', async () => {
    const target = await fakeHttp(loki());
    servers.push(target);
    const tunnels: string[] = [];
    const proxy = createServer();
    proxy.on('connect', (req, client, head) => {
      tunnels.push(req.url ?? '');
      const upstream = connect(Number(new URL(target.url).port), '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
    });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
    servers.push({ close: () => new Promise<void>((r) => (proxy.closeAllConnections(), proxy.close(() => r()))) });
    const backend = new LokiBackend(
      { type: 'loki', url: 'http://loki.example.invalid:3100', ca: undefined, maxConcurrent: 4, queueTimeoutSeconds: 10, timeoutSeconds: 30 },
      { env: { HTTP_PROXY: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}` } },
    );
    expect((await backend.check(signal())).labelNames).toContain('namespace');
    expect(tunnels[0]).toBe('loki.example.invalid:3100');
  });
});

describe('хранилище loki в файле настроек', () => {
  const file = (store: string) => `
auth: off
defaults: { project: acme, environment: prod }
backends:
  logs:
${store}
projects:
  acme:
    name: Acme
    environments:
      prod: { name: Прод, backend: logs, selector: [{ label: namespace, op: '=', value: acme }] }
`;
  const issues = (store: string) => {
    const r = validateConfig(parse(file(store)));
    return r.ok ? [] : r.issues;
  };
  const paths = (store: string) => issues(store).map((i) => i.path);

  it('без входа, с токеном, с именем и паролем, с арендатором: принято', () => {
    for (const store of [
      '    type: loki\n    url: http://loki:3100',
      '    type: loki\n    url: https://loki.corp.example\n    tokenEnv: THREADLINE_LOKI_TOKEN\n    tenant: team-a',
      '    type: loki\n    url: https://logs.corp.example/loki-proxy\n    usernameEnv: THREADLINE_LOKI_USERNAME\n    passwordEnv: THREADLINE_LOKI_PASSWORD',
    ]) expect(issues(store)).toEqual([]);
  });

  it.each([
    ['токен и Basic вместе', '    type: loki\n    url: http://loki:3100\n    tokenEnv: A\n    usernameEnv: B\n    passwordEnv: C', 'backends.logs.tokenEnv'],
    ['имя без пароля', '    type: loki\n    url: http://loki:3100\n    usernameEnv: B', 'backends.logs.passwordEnv'],
    ['учётные данные в адресе', '    type: loki\n    url: http://user:secret@loki:3100', 'backends.logs.url'],
    ['путь API в адресе', '    type: loki\n    url: http://loki:3100/loki/api/v1', 'backends.logs.url'],
    ['арендатор с пробелом', '    type: loki\n    url: http://loki:3100\n    tenant: team a', 'backends.logs.tenant'],
    ['поле Grafana', '    type: loki\n    url: http://loki:3100\n    datasource: { name: Loki }', 'backends.logs'],
  ])('%s: ошибка называет поле', (_name, store, path) => {
    expect(paths(store)).toContain(path);
  });

  it.each(['token', 'password', 'username'])('%s в файле: просит переменную, значения в сообщении нет', (field) => {
    const all = issues(`    type: loki\n    url: http://loki:3100\n    ${field}: value-that-must-not-appear`);
    expect(all.find((i) => i.path === `backends.logs.${field}`)?.message).toContain(`${field}Env`);
    expect(JSON.stringify(all)).not.toContain('value-that-must-not-appear');
  });

  async function loaded(store: string, env: Record<string, string>) {
    const dir = await mkdtemp(join(tmpdir(), 'threadline-loki-'));
    await writeFile(join(dir, 'threadline.yaml'), file(store));
    return loadConfig({ path: join(dir, 'threadline.yaml'), env });
  }

  it('секреты из окружения; нет переменной — среда «не настроена» и называет её; строгий запуск их требует', async () => {
    const store = '    type: loki\n    url: http://127.0.0.1:1\n    usernameEnv: THREADLINE_LOKI_USERNAME\n    passwordEnv: THREADLINE_LOKI_PASSWORD';
    const full = await loaded(store, { THREADLINE_LOKI_USERNAME: 'user', THREADLINE_LOKI_PASSWORD: PASSWORD });
    expect(full.backends.logs).toMatchObject({ username: 'user', password: PASSWORD });
    expect(missingSecret(full.backends.logs!)).toBeUndefined();
    expect(ownSecrets(full, {})).toContain(PASSWORD);
    const half = await loaded(store, { THREADLINE_LOKI_USERNAME: 'user' });
    expect(missingSecret(half.backends.logs!)).toBe('THREADLINE_LOKI_PASSWORD');
    expect(startIssues(half.config, { THREADLINE_STRICT_START: '1', THREADLINE_ALLOW_NO_LOGIN: '1', THREADLINE_LOKI_USERNAME: 'user' }).map((i) => i.path)).toEqual(['THREADLINE_LOKI_PASSWORD', 'THREADLINE_DATABASE_URL']);
    const open = await loaded('    type: loki\n    url: http://127.0.0.1:1', {});
    expect(missingSecret(open.backends.logs!)).toBeUndefined();
  });

  it('проверка подключения и проверка со страницы проектов: тип loki в ответе, метки и наличие записей', async () => {
    const g = await fakeHttp(loki({ streams: [{ stream: { namespace: 'acme' }, values: [['1793180000000000100', 'line']] }] }));
    servers.push(g);
    const c = await loaded(`    type: loki\n    url: ${g.url}\n    tokenEnv: THREADLINE_LOKI_TOKEN\n    tenant: acme`, { THREADLINE_LOKI_TOKEN: TOKEN });
    const backends = new Backends(c);
    const env = c.config.projects.acme!.environments.prod!;
    expect(await backends.connection(env, { signal: signal() })).toMatchObject({ status: 'connected', backend: 'loki' });
    const probe = await backends.probe('logs', { kind: 'single', selector: env.selector }, signal());
    expect(probe).toMatchObject({ status: 'connected', backend: 'loki', hasRecords: true, labelNames: ['app', 'container', 'namespace'] });
    expect(g.requests.every((r) => r.headers['x-scope-orgid'] === 'acme' && r.headers.authorization === `Bearer ${TOKEN}`)).toBe(true);

    const missing = await loaded(`    type: loki\n    url: ${g.url}\n    tokenEnv: THREADLINE_LOKI_TOKEN`, {});
    expect(await new Backends(missing).connection(env, { signal: signal() })).toMatchObject({ status: 'not-configured', missingEnv: 'THREADLINE_LOKI_TOKEN', backend: 'loki' });
  });
});
