// Вход, сессия, продление, недоступный провайдер, часы, выход на настоящих маршрутах и ложном сервисе входа.
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuthMe } from '@threadline/core/access';
import { CLOCK_TOLERANCE_SECONDS, DISCOVERY_RETRY_MS } from '../../src/auth/oidc.ts';
import { MAX_PENDING_LOGINS, OFFLINE_MAX_MS, PENDING_MS, REFRESH_RETRY_MS, safeReturnTo, SESSION_MAX_MS } from '../../src/auth/routes.ts';
import { MAX_SESSIONS } from '../../src/auth/session-store.ts';
import { CLIENT_SECRET, FakeOidc } from '../fake-oidc.ts';
import { Browser, PUBLIC_URL, rig, SESSION_SECRET, settle, type Rig } from './harness.ts';

let r: Rig;
afterEach(async () => {
  await r?.close();
});

const me = async (b: Browser) => {
  const res = await b.get('/api/auth/me');
  return { status: res.statusCode, body: res.json() as AuthMe & { error?: { code: string } } };
};

describe('вход', () => {
  it('провайдер не Keycloak: роли в groups у id_token, токен доступа не JWT, своя область запроса', async () => {
    const fake = await new FakeOidc().start();
    fake.roleStyle = 'groups';
    r = await rig({ fake, auth: { roleClaim: 'groups', scopes: ['groups', 'openid'] } });
    const b = new Browser(r.app);
    await b.login(r, 'developer', '/pay/demo');
    // openid и profile всегда, область из настройки один раз.
    expect(r.fake.lastAuthorize!.get('scope')).toBe('openid profile groups');
    expect((await me(b)).body).toMatchObject({ mode: 'on', role: 'developer' });
  });

  it('первый вход: PKCE, state, nonce, cookie и роль из токена Keycloak-вида', async () => {
    r = await rig();
    const b = new Browser(r.app);
    expect((await me(b)).status).toBe(401);
    expect((await me(b)).body.error?.code).toBe('unauthenticated');
    const to = await b.login(r, 'support', '/pay/demo');
    expect(to).toBe('/pay/demo');
    const q = r.fake.lastAuthorize!;
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('state')).toBeTruthy();
    expect(q.get('nonce')).toBeTruthy();
    expect(q.get('redirect_uri')).toBe(`${PUBLIC_URL}/api/auth/callback`);
    expect(b.lastSetCookie).toMatch(/HttpOnly/i);
    expect(b.lastSetCookie).toMatch(/SameSite=Lax/i);
    expect(b.lastSetCookie).not.toMatch(/Secure/i);
    const who = await me(b);
    expect(who.status).toBe(200);
    expect(who.body).toMatchObject({ mode: 'on', role: 'support', user: { name: 'Тест Поддержка' } });
    expect(who.body.capabilities).toContain('editErrors');
    expect(who.body.capabilities).not.toContain('editCatalog');
  });

  it('токенов нет в ответах API', async () => {
    r = await rig();
    const b = new Browser(r.app);
    await b.login(r, 'analyst');
    const text = JSON.stringify((await me(b)).body);
    expect(text).not.toMatch(/eyJ|token/i);
  });

  it('Secure при https и X-Forwarded-Proto; без заголовка вход честно отказывает', async () => {
    r = await rig({ publicUrl: 'https://threadline.corp.example' });
    const direct = await new Browser(r.app).get('/api/auth/login');
    expect(direct.headers.location).toBe('/auth-error?reason=config');
    const b = new Browser(r.app);
    const proxied = { 'x-forwarded-proto': 'https' };
    r.fake.autoUser = 'analyst';
    const login = await b.get('/api/auth/login', proxied);
    expect(login.statusCode).toBe(302);
    expect(b.lastSetCookie).toMatch(/Secure/i);
    const back = await fetch(String(login.headers.location), { redirect: 'manual' });
    const u = new URL(back.headers.get('location')!);
    expect(u.origin).toBe('https://threadline.corp.example');
    const done = await b.get(`${u.pathname}${u.search}`, proxied);
    expect(done.headers.location).toBe('/');
    expect(b.lastSetCookie).toMatch(/Secure/i);
    expect((await b.get('/api/auth/me', proxied)).statusCode).toBe(200);
  });

  it('подделанный state: код не обменивается, сессии нет', async () => {
    r = await rig();
    const b = new Browser(r.app);
    const res = await b.get('/api/auth/callback?state=forged&code=x');
    expect(res.headers.location).toBe('/auth-error?reason=state');
    expect(r.fake.calls.token).toBe(0);
    expect((await me(b)).status).toBe(401);
  });

  it('старый адрес обратного вызова при живой сессии ведёт на главную', async () => {
    r = await rig();
    const b = new Browser(r.app);
    r.fake.autoUser = 'analyst';
    const callback = await b.toCallback('/pay/demo');
    await b.get(callback);
    const again = await b.get(callback);
    expect(again.headers.location).toBe('/');
    expect(r.fake.calls.token).toBe(1);
  });

  it('отказ на стороне провайдера: сессии нет, текста провайдера в адресе нет', async () => {
    r = await rig();
    r.fake.denyLogin = true;
    const b = new Browser(r.app);
    const res = await b.get(await b.toCallback('/pay/demo'));
    expect(res.headers.location).toBe('/auth-error?reason=denied');
    expect((await me(b)).status).toBe(401);
  });

  it('две вкладки: каждая открывает свою ссылку', async () => {
    r = await rig();
    const b = new Browser(r.app);
    r.fake.autoUser = 'analyst';
    const first = await b.toCallback('/pay/demo/requests/a');
    const second = await b.toCallback('/pay/demo/requests/b');
    expect((await b.get(second)).headers.location).toBe('/pay/demo/requests/b');
    expect((await b.get(first)).headers.location).toBe('/pay/demo/requests/a');
    expect((await me(b)).status).toBe(200);
  });

  it('новая сессия при входе: прежнее значение cookie ничего не открывает', async () => {
    r = await rig();
    const b = new Browser(r.app);
    await b.login(r, 'analyst');
    const before = b.cookie!;
    await b.login(r, 'support');
    expect(b.cookie).not.toBe(before);
    expect((await r.app.inject({ url: '/api/auth/me', headers: { cookie: before } })).statusCode).toBe(401);
    expect((await me(b)).body.role).toBe('support');
  });

  it('подпись cookie: значение с чужой подписью не открывает сессию', async () => {
    r = await rig();
    const b = new Browser(r.app);
    await b.login(r, 'analyst');
    const forged = `${b.cookie!.split('.').slice(0, -1).join('.')}.AAAA`;
    expect((await r.app.inject({ url: '/api/auth/me', headers: { cookie: forged } })).statusCode).toBe(401);
  });

  it.each([
    ['https://example.org'],
    ['//example.org'],
    ['/\\example.org'],
    ['example.org'],
    ['/api/projects'],
    ['/a\nb'],
    [`/${'a'.repeat(2048)}`],
    [undefined],
  ])('чужой адрес возврата %j ведёт на главную', (v) => {
    expect(safeReturnTo(v)).toBe('/');
  });

  it('адрес со строкой запроса и якорем возвращается как есть', async () => {
    r = await rig();
    const b = new Browser(r.app);
    const url = '/pay/demo/requests/abc?from=1&to=2&stand=7#step';
    expect(await b.login(r, 'analyst', url)).toBe(url);
  });

  it('роль: посторонние имена и отсутствие поля дают «нет роли», журнал называет только поле', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _e, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    r = await rig({ stream });
    const b = new Browser(r.app);
    await b.login(r, 'norole');
    expect((await me(b)).body).toMatchObject({ role: null, capabilities: [], user: { name: 'Тест Без Роли' } });
    expect((await b.get('/api/projects')).json()).toEqual({ error: { code: 'no-role' } });

    r.fake.setRoles('analyst', undefined);
    const c = new Browser(r.app);
    await c.login(r, 'analyst');
    expect((await me(c)).body.role).toBeNull();
    const warned = lines.join('');
    expect(warned).toContain('в токене нет поля ролей realm_access.roles');
    expect(warned).not.toContain('eyJ');
  });

  it('нет имени: логин, затем только роль', async () => {
    r = await rig();
    r.fake.addUser('nameless', { sub: 's-1', username: 'login-only', roles: ['threadline-admin'] });
    r.fake.addUser('anon', { sub: 's-2', roles: ['threadline-admin'] });
    const a = new Browser(r.app);
    await a.login(r, 'nameless');
    expect((await me(a)).body.user.name).toBe('login-only');
    const b = new Browser(r.app);
    await b.login(r, 'anon');
    expect((await me(b)).body.user.name).toBeNull();
  });
});

describe('незавершённый вход', () => {
  it('адрес входа не создаёт сессию: cookie входа только для /api/auth', async () => {
    r = await rig();
    const res = await r.app.inject({ url: '/api/auth/login' });
    expect(res.statusCode).toBe(302);
    const set = [res.headers['set-cookie']].flat().join('\n');
    expect(set).not.toContain('threadline.sid');
    expect(set).toMatch(/threadline\.login=[A-Za-z0-9_-]{43}; Max-Age=1800; Path=\/api\/auth; HttpOnly; SameSite=Lax/);
  });

  it(`поток из ${MAX_SESSIONS + 1} анонимных входов: сессии целы, вытеснен только незавершённый вход`, async () => {
    r = await rig();
    const admin = new Browser(r.app);
    await admin.login(r, 'admin');
    const slow = new Browser(r.app);
    r.fake.autoUser = 'analyst';
    const callback = await slow.toCallback('/pay/demo');
    expect(MAX_PENDING_LOGINS).toBeLessThanOrEqual(MAX_SESSIONS);
    let sessions = 0;
    for (let i = 0; i <= MAX_SESSIONS; i++) {
      const res = await r.app.inject({ url: '/api/auth/login' });
      if ([res.headers['set-cookie']].flat().some((c) => String(c).startsWith('threadline.sid='))) sessions++;
    }
    expect(sessions).toBe(0);
    expect((await me(admin)).body.role).toBe('admin');
    // Его вход вытеснен: экран ошибки, повтор проходит.
    expect((await slow.get(callback)).headers.location).toBe('/auth-error?reason=state');
    expect(await slow.login(r, 'analyst', '/pay/demo')).toBe('/pay/demo');
    expect((await me(slow)).body.role).toBe('analyst');
  }, 60_000);

  it('настоящий state из чужого браузера не завершает вход, свой браузер завершает', async () => {
    r = await rig();
    const attacker = new Browser(r.app);
    r.fake.autoUser = 'admin';
    const callback = await attacker.toCallback('/');
    const victim = new Browser(r.app);
    expect((await victim.get(callback)).headers.location).toBe('/auth-error?reason=state');
    const own = new Browser(r.app);
    await own.toCallback('/');
    expect((await own.get(callback)).headers.location).toBe('/auth-error?reason=state');
    expect(r.fake.calls.token).toBe(0);
    expect((await me(victim)).status).toBe(401);
    expect((await attacker.get(callback)).headers.location).toBe('/');
    expect((await me(attacker)).status).toBe(200);
  });

  it('cookie входа с посторонним значением не принимается', async () => {
    r = await rig();
    const b = new Browser(r.app);
    r.fake.autoUser = 'analyst';
    const callback = await b.toCallback('/');
    b.loginCookie = 'threadline.login=x';
    expect((await b.get(callback)).headers.location).toBe('/auth-error?reason=state');
  });

  it('повтор обратного вызова без сессии: код не обменивается второй раз', async () => {
    r = await rig();
    const b = new Browser(r.app);
    r.fake.denyLogin = true;
    const callback = await b.toCallback('/');
    expect((await b.get(callback)).headers.location).toBe('/auth-error?reason=denied');
    expect((await b.get(callback)).headers.location).toBe('/auth-error?reason=state');
    expect(r.fake.calls.token).toBe(0);
  });

  it('вход дольше 30 минут: экран ошибки, код не обменивается', async () => {
    r = await rig();
    const b = new Browser(r.app);
    r.fake.autoUser = 'analyst';
    const callback = await b.toCallback('/pay/demo');
    r.clock.t += PENDING_MS;
    expect((await b.get(callback)).headers.location).toBe('/auth-error?reason=state');
    expect(r.fake.calls.token).toBe(0);
  });
});

describe('сессия и опрос', () => {
  it('опрос не пишет в хранилище и не ставит cookie заново', async () => {
    r = await rig();
    const b = new Browser(r.app);
    await b.login(r, 'analyst');
    const cookie = b.cookie;
    for (let i = 0; i < 5; i++) {
      const res = await b.get('/api/auth/me');
      expect(res.headers['set-cookie']).toBeUndefined();
    }
    expect(b.cookie).toBe(cookie);
  });
});

describe('продление', () => {
  it('токен истёк: ответ сразу, одно обновление на сессию при опросе, роль перечитана', async () => {
    r = await rig();
    const b = new Browser(r.app);
    await b.login(r, 'analyst');
    r.fake.setRoles('analyst', ['threadline-business']);
    r.clock.t += 301_000;
    await Promise.all([me(b), me(b), me(b), me(b)]);
    await settle(() => r.fake.calls.refresh > 0);
    expect(r.fake.calls.refresh).toBe(1);
    await settle(() => false, 100);
    expect((await me(b)).body.role).toBe('business');
    expect(r.fake.calls.refresh).toBe(1);
  });

  it('роль сняли: без роли сразу после обновления, новый вход не нужен', async () => {
    r = await rig();
    const b = new Browser(r.app);
    await b.login(r, 'developer');
    r.fake.setRoles('developer', ['offline_access']);
    r.clock.t += 301_000;
    await me(b);
    await settle(() => r.fake.calls.refresh > 0);
    await settle(() => false, 100);
    expect((await me(b)).body.role).toBeNull();
  });

  it('invalid_grant: сессия удалена, следующий запрос 401', async () => {
    r = await rig();
    const b = new Browser(r.app);
    await b.login(r, 'analyst');
    r.fake.refreshMode = 'invalid_grant';
    r.clock.t += 301_000;
    expect((await me(b)).status).toBe(200);
    await settle(() => r.fake.calls.refresh > 0);
    await settle(() => false, 100);
    expect((await me(b)).status).toBe(401);
  });

  it('верхний предел 12 часов', async () => {
    r = await rig();
    r.fake.expiresIn = SESSION_MAX_MS / 1000 + 1000;
    const b = new Browser(r.app);
    await b.login(r, 'analyst');
    r.clock.t += SESSION_MAX_MS - 1;
    expect((await me(b)).status).toBe(200);
    r.clock.t += 1;
    expect((await me(b)).status).toBe(401);
  });

  it('перезапуск сервера: сессии нет, следующий запрос 401', async () => {
    r = await rig();
    const b = new Browser(r.app);
    await b.login(r, 'analyst');
    const fake = r.fake;
    await r.app.close();
    r = await rig({ fake });
    const res = await r.app.inject({ url: '/api/auth/me', headers: { cookie: b.cookie! } });
    expect(res.statusCode).toBe(401);
  });
});

describe('провайдер недоступен', () => {
  it('сервер запускается и отвечает, обращения к провайдеру при старте нет', async () => {
    const fake = await new FakeOidc().start();
    fake.mode = 'down';
    r = await rig({ fake });
    expect(fake.calls.discovery).toBe(0);
    expect((await r.app.inject({ url: '/api/health' })).statusCode).toBe(200);
    expect((await r.app.inject({ url: '/api/auth/me' })).statusCode).toBe(401);
  });

  it.each([['down'], ['503'], ['hang']] as const)('вход при %s: экран недоступности, повтор не чаще раза в 10 секунд, потом заработал', async (mode) => {
    const fake = await new FakeOidc().start();
    fake.mode = mode;
    r = await rig({ fake, timeoutSeconds: 1 });
    const b = new Browser(r.app);
    expect((await b.get('/api/auth/login')).headers.location).toBe('/auth-error?reason=unavailable');
    fake.mode = 'ok';
    // Повтор внутри 10 секунд: запроса к провайдеру нет.
    expect((await b.get('/api/auth/login')).headers.location).toBe('/auth-error?reason=unavailable');
    expect(fake.calls.discovery).toBe(0);
    r.clock.t += DISCOVERY_RETRY_MS;
    expect(await b.login(r, 'analyst', '/pay/demo')).toBe('/pay/demo');
    expect(fake.calls.discovery).toBe(1);
  });

  it('пропал во время работы: запросы идут по последней роли, журнал не чаще раза в минуту, повтор не чаще раза в 30 секунд', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _e, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    r = await rig({ stream });
    const b = new Browser(r.app);
    await b.login(r, 'analyst');
    r.fake.refreshMode = 'down';
    r.clock.t += 301_000;
    expect((await me(b)).body.role).toBe('analyst');
    await settle(() => r.fake.calls.refresh >= 1);
    await settle(() => lines.some((l) => l.includes('не обновил')));
    expect(r.fake.calls.refresh).toBe(1);
    r.clock.t += REFRESH_RETRY_MS - 1;
    await me(b);
    await settle(() => false, 50);
    expect(r.fake.calls.refresh).toBe(1);
    r.clock.t += 1;
    await me(b);
    await settle(() => r.fake.calls.refresh >= 2);
    expect(r.fake.calls.refresh).toBe(2);
    expect(lines.filter((l) => l.includes('не обновил')).length).toBe(1);
  });

  it('провайдер вернулся: обновление работает без перезапуска', async () => {
    r = await rig();
    const b = new Browser(r.app);
    await b.login(r, 'analyst');
    r.fake.refreshMode = 'down';
    r.clock.t += 301_000;
    await me(b);
    await settle(() => r.fake.calls.refresh >= 1);
    r.fake.refreshMode = 'ok';
    r.fake.setRoles('analyst', ['threadline-developer']);
    r.clock.t += REFRESH_RETRY_MS;
    await me(b);
    await settle(() => r.fake.calls.refresh >= 2);
    await settle(() => false, 100);
    expect((await me(b)).body.role).toBe('developer');
  });

  it('пропал надолго: через 30 минут после срока токена сессия закрыта', async () => {
    r = await rig();
    const b = new Browser(r.app);
    await b.login(r, 'analyst');
    r.fake.refreshMode = 'down';
    r.clock.t += 300_000 + OFFLINE_MAX_MS - 1;
    expect((await me(b)).status).toBe(200);
    r.clock.t += 1;
    expect((await me(b)).status).toBe(401);
  });

  it.each([
    ['неверный секрет клиента', (f: FakeOidc) => f, 'secret'],
    ['issuer не совпал', (f: FakeOidc) => ((f.wrongIssuer = true), f), 'issuer'],
  ] as const)('настроено неверно: %s', async (_n, prepare, kind) => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _e, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const fake = prepare(await new FakeOidc().start());
    r = await rig({ fake, stream });
    const b = new Browser(r.app);
    if (kind === 'issuer') {
      expect((await b.get('/api/auth/login')).headers.location).toBe('/auth-error?reason=config');
      return;
    }
    // Секрет проверяется при обмене кода.
    fake.autoUser = 'analyst';
    const callback = await b.toCallback('/');
    fake.rejectClient = true;
    expect((await b.get(callback)).headers.location).toBe('/auth-error?reason=config');
    expect((await me(b)).status).toBe(401);
    expect(lines.join('')).not.toContain(CLIENT_SECRET);
  });
});

describe('расхождение часов', () => {
  it('допуск id_token 60 секунд', () => {
    expect(CLOCK_TOLERANCE_SECONDS).toBe(60);
  });

  it.each([[40], [-40]])('%d секунд: вход проходит, сессия обновляется вовремя', async (skew) => {
    r = await rig();
    r.fake.skewSeconds = skew;
    const b = new Browser(r.app);
    await b.login(r, 'analyst');
    expect((await me(b)).status).toBe(200);
    r.clock.t += 299_000;
    await me(b);
    expect(r.fake.calls.refresh).toBe(0);
    r.clock.t += 1_000;
    await me(b);
    await settle(() => r.fake.calls.refresh >= 1);
    expect(r.fake.calls.refresh).toBe(1);
  });

  it.each([[600], [-600]])('%d секунд: вход не проходит, журнал называет разницу', async (skew) => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _e, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    r = await rig({ stream });
    r.fake.skewSeconds = skew;
    const b = new Browser(r.app);
    r.fake.autoUser = 'analyst';
    const res = await b.get(await b.toCallback('/'));
    expect(res.headers.location).toBe('/auth-error?reason=clock');
    expect((await me(b)).status).toBe(401);
    expect(lines.join('')).toMatch(/расходятся на -?\d+ с/);
  });

  it('часы сервера ушли вперёд: срок считается от получения токена, лишних отказов нет', async () => {
    r = await rig();
    r.fake.expiresIn = 600;
    const b = new Browser(r.app);
    await b.login(r, 'analyst');
    r.clock.t += 599_000;
    expect((await me(b)).status).toBe(200);
    expect(r.fake.calls.refresh).toBe(0);
  });
});

describe('выход', () => {
  it('сессия удалена, адрес выхода провайдера с подсказкой и возвратом', async () => {
    r = await rig();
    const b = new Browser(r.app);
    await b.login(r, 'analyst');
    const res = await b.post('/api/auth/logout');
    expect(res.statusCode).toBe(200);
    const url = new URL((res.json() as { redirect: string }).redirect);
    expect(url.origin + url.pathname).toBe(`${r.fake.issuer}/logout`);
    expect(url.searchParams.get('id_token_hint')).toBeTruthy();
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe(`${PUBLIC_URL}/logged-out`);
    expect((await me(b)).status).toBe(401);
  });

  it('провайдер недоступен при выходе: сессия всё равно удалена, страница об этом говорит', async () => {
    r = await rig();
    const b = new Browser(r.app);
    await b.login(r, 'analyst');
    r.fake.mode = 'down';
    const res = await b.post('/api/auth/logout');
    expect((res.json() as { redirect: string }).redirect).toBe('/logged-out?provider=unreachable');
    expect((await me(b)).status).toBe(401);
  });

  it('вторая вкладка после выхода получает 401, чужой источник отклонён', async () => {
    r = await rig();
    const b = new Browser(r.app);
    await b.login(r, 'analyst');
    const foreign = await b.post('/api/auth/logout', { origin: 'https://evil.example', host: 'localhost:8090' });
    expect(foreign.statusCode).toBe(403);
    expect((await me(b)).status).toBe(200);
    const other = b.cookie!;
    await b.post('/api/auth/logout');
    expect((await r.app.inject({ url: '/api/projects', headers: { cookie: other } })).statusCode).toBe(401);
  });
});

describe('журнал', () => {
  it('токены, код, state, cookie и имя в журнал не попадают', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _e, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    r = await rig({ stream });
    const b = new Browser(r.app);
    r.fake.autoUser = 'analyst';
    const callback = await b.toCallback('/pay/demo?secretquery=1');
    const browser = b.loginCookie!.split('=')[1]!;
    await b.get(callback);
    const q = new URLSearchParams(callback.split('?')[1]);
    await b.get('/api/projects');
    r.clock.t += 301_000;
    await b.get('/api/auth/me');
    await settle(() => r.fake.calls.refresh >= 1);
    await b.post('/api/auth/logout');
    const text = lines.join('');
    expect(text).toContain('/api/auth/callback');
    for (const value of [q.get('code')!, q.get('state')!, b.cookie ?? 'нет', browser, 'Тест Аналитик', 'analyst', 'fake-client-secret', SESSION_SECRET, 'secretquery', 'eyJ']) {
      expect(text, value).not.toContain(value);
    }
  });
});
