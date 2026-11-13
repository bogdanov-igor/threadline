// Имя сервера в запросах к API: запросы принимаются только по известному имени сервера. Перепривязка имени (DNS rebinding) при auth: off.
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { hostName, knownHost } from '../../src/auth/access.ts';
import { memoryLog, mockApp } from '../deploy/kit.ts';
import { Browser, rig, type Rig } from './harness.ts';

let app: FastifyInstance | undefined;
let r: Rig | undefined;
afterEach(async () => {
  await app?.close();
  await r?.close();
  app = undefined;
  r = undefined;
});

const SEARCH = { terms: ['447700900123'], period: { preset: '24h' } };
const REBOUND = 'rebind.attacker.example:8080';

describe('имя сервера при auth: off', () => {
  it('перепривязанное имя: Origin и Host совпадают, данных и заданий нет', async () => {
    ({ app } = await mockApp());
    const headers = { origin: `http://${REBOUND}`, host: REBOUND };
    const search = await app.inject({ method: 'POST', url: '/api/projects/pay/envs/demo/searches', headers, payload: SEARCH });
    expect([search.statusCode, search.json()]).toEqual([403, { error: { code: 'forbidden' } }]);
    for (const url of ['/api/auth/me', '/api/settings', '/api/projects', '/api/health']) {
      const res = await app.inject({ url, headers: { host: REBOUND } });
      expect([url, res.statusCode]).toEqual([url, 403]);
    }
  });

  it.each(['localhost', 'localhost:5173', 'LOCALHOST:8080', '127.0.0.1', '127.0.0.1:8099', '[::1]:8080', '192.0.2.10:8080', '[2001:db8::5]', 'localhost.:8080'])('Host %s проходит', async (host) => {
    ({ app } = await mockApp());
    expect((await app.inject({ url: '/api/settings', headers: { host } })).statusCode).toBe(200);
    const search = await app.inject({ method: 'POST', url: '/api/projects/pay/envs/demo/searches', headers: { host, origin: `http://${host}` }, payload: SEARCH });
    expect(search.statusCode, search.body).toBe(200);
  });

  it('пробы, метрики и файлы интерфейса не зависят от Host', async () => {
    ({ app } = await mockApp());
    const host = 'threadline.threadline-ns.svc.cluster.local:8080';
    for (const url of ['/health', '/health/readiness', '/health/liveness', '/metrics']) {
      expect([url, (await app.inject({ url, headers: { host } })).statusCode]).toEqual([url, 200]);
    }
    expect((await app.inject({ url: '/api/no-such-route', headers: { host } })).statusCode).toBe(404);
  });

  it('журнал называет отклонённое имя не чаще раза в минуту', async () => {
    const log = memoryLog();
    ({ app } = await mockApp({ logger: { stream: log.stream } }));
    for (let i = 0; i < 5; i++) await app.inject({ url: '/api/projects', headers: { host: REBOUND } });
    const warned = log.lines.filter((l) => l.includes('неизвестным именем сервера'));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('rebind.attacker.example');
    expect(warned[0]).not.toContain(':8080');
  });
});

describe('имя сервера при включённом входе', () => {
  it('имя из publicUrl проходит, другое доменное имя получает 403 и на публичных адресах', async () => {
    r = await rig({ publicUrl: 'https://threadline.corp.example' });
    const proxied = { 'x-forwarded-proto': 'https' };
    const own = await r.app.inject({ url: '/api/auth/me', headers: { ...proxied, host: 'threadline.corp.example' } });
    expect(own.statusCode).toBe(401);
    for (const url of ['/api/auth/me', '/api/auth/login', '/api/health']) {
      const res = await r.app.inject({ url, headers: { ...proxied, host: 'threadline.attacker.example' } });
      expect([url, res.statusCode]).toEqual([url, 403]);
    }
    const b = new Browser(r.app);
    r.fake.autoUser = 'analyst';
    const login = await b.get('/api/auth/login', { ...proxied, host: 'Threadline.Corp.Example' });
    expect(login.statusCode).toBe(302);
  });
});

describe('разбор Host', () => {
  it.each([
    [undefined, null],
    ['', null],
    [':8080', null],
    ['.', null],
    ['evil.example@127.0.0.1', null],
    ['127.0.0.1/x', null],
    ['[::1', null],
    ['[not-ip]', null],
    ['a b', null],
    ['Example.LOCAL:443', 'example.local'],
    ['[::1]:8080', '[::1]'],
  ])('%j → %j', (host, name) => {
    expect(hostName(host)).toBe(name);
  });

  it.each([
    ['localhost', null, true],
    ['127.0.0.1', null, true],
    ['[::1]', null, true],
    ['198.51.100.7', null, true],
    ['threadline.corp.example', null, false],
    ['threadline.corp.example', 'threadline.corp.example', true],
    ['127.0.0.1.attacker.example', null, false],
    ['localhost.attacker.example', 'threadline.corp.example', false],
    ['0x7f.1', null, false],
    [null, 'threadline.corp.example', false],
  ])('%s при адресе %s: %s', (name, publicHost, ok) => {
    expect(knownHost(name, publicHost)).toBe(ok);
  });
});
