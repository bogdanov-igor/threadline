// Ложный провайдер OIDC на node:http и jose: discovery, JWKS, authorize, token с проверкой PKCE, end_session.
// Режимы отказа: недоступен, 5xx, invalid_grant, сдвиг часов. Роли кладёт как Keycloak (realm_access.roles в токене доступа)
// или как большинство других провайдеров (groups в id_token, токен доступа не JWT). Настоящего провайдера тесты не трогают.

import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';

export interface FakeUser {
  sub: string;
  /** Нет — в токене нет имени. */
  name?: string;
  username?: string;
  /** Нет — в токене нет поля ролей. */
  roles?: string[];
}

export const CLIENT_SECRET = 'fake-client-secret';

/** Синтетические пользователи: по одному на роль и один без роли. */
export const FAKE_USERS: Record<string, FakeUser> = {
  business: { sub: 'sub-business', name: 'Тест Бизнес', username: 'business', roles: ['threadline-business', 'offline_access'] },
  support: { sub: 'sub-support', name: 'Тест Поддержка', username: 'support', roles: ['threadline-tech-support'] },
  developer: { sub: 'sub-developer', name: 'Тест Разработчик', username: 'developer', roles: ['threadline-developer'] },
  analyst: { sub: 'sub-analyst', name: 'Тест Аналитик', username: 'analyst', roles: ['threadline-analyst'] },
  admin: { sub: 'sub-admin', name: 'Тест Администратор', username: 'admin', roles: ['threadline-admin'] },
  norole: { sub: 'sub-norole', name: 'Тест Без Роли', username: 'norole', roles: ['offline_access', 'uma_authorization'] },
};

/** Как провайдер кладёт роли: keycloak — realm_access.roles в токене доступа; groups — groups в id_token, токен доступа не JWT. */
export type RoleStyle = 'keycloak' | 'groups';

/** Настройка auth для тестов: те же имена ролей, что у пользователей выше. */
export const authYaml = (issuer: string, publicUrl: string, opts: { roleClaim?: string; scopes?: string[] } = {}) => `
auth:
  issuer: ${issuer}
  clientId: threadline
  publicUrl: ${publicUrl}
  roleClaim: ${opts.roleClaim ?? 'realm_access.roles'}${opts.scopes ? `\n  scopes: [${opts.scopes.join(', ')}]` : ''}
  roles:
    business: [threadline-business]
    support: [threadline-tech-support, threadline-customer-support]
    developer: [threadline-developer]
    analyst: [threadline-analyst]
    admin: [threadline-admin]
`;

interface Grant {
  user: FakeUser;
  challenge: string;
  nonce: string;
  redirect: string;
}

export interface FakeOidcOptions {
  port?: number;
  /** Адрес issuer для браузера и сервера: localhost или 127.0.0.1. */
  host?: string;
}

export class FakeOidc {
  /** Своя копия: сценарии меняют роли пользователей. */
  readonly #users = new Map(Object.entries(FAKE_USERS).map(([login, u]) => [login, { ...u }]));
  readonly #grants = new Map<string, Grant>();
  readonly #refresh = new Map<string, FakeUser>();
  readonly #sockets = new Set<Socket>();
  #server: Server | null = null;
  #key: Parameters<SignJWT['sign']>[0] | null = null;
  #jwk: JWK | null = null;
  #port = 0;
  readonly #host: string;
  readonly #wantPort: number;

  /** Кто вошёл на странице входа. Нет — страница показывает выбор пользователя, как настоящий провайдер показывает форму. */
  autoUser: string | null = null;
  /** ok; down — обрывает соединение; 503 — отвечает ошибкой; hang — не отвечает. */
  mode: 'ok' | 'down' | '503' | 'hang' = 'ok';
  /** Ответ на обновление токена: invalid_grant или сетевой сбой, независимо от mode. */
  refreshMode: 'ok' | 'invalid_grant' | 'down' = 'ok';
  /** Сдвиг часов сервиса входа, секунд. */
  /** Где роли: как у Keycloak или в groups, как у большинства других провайдеров. */
  roleStyle: RoleStyle = 'keycloak';
  skewSeconds = 0;
  expiresIn = 300;
  /** Другой issuer в discovery: настройка неверна. */
  wrongIssuer = false;
  /** Отвечать на authorize отказом access_denied. */
  denyLogin = false;
  /** Отклонять клиента при обмене кода: неверный секрет или клиента нет. */
  rejectClient = false;
  readonly calls = { discovery: 0, authorize: 0, token: 0, refresh: 0, endSession: 0 };
  lastAuthorize: URLSearchParams | null = null;
  lastLogout: URLSearchParams | null = null;

  constructor(opts: FakeOidcOptions = {}) {
    this.#host = opts.host ?? '127.0.0.1';
    this.#wantPort = opts.port ?? 0;
  }

  get issuer(): string {
    return `http://${this.#host}:${this.#port}/realms/test`;
  }

  /** Сменить набор ролей пользователя: «роль сменили у провайдера». */
  setRoles(login: string, roles: string[] | undefined): void {
    const u = this.#users.get(login);
    if (!u) throw new Error(`нет пользователя ${login}`);
    if (roles) u.roles = roles;
    else delete u.roles;
  }

  addUser(login: string, user: FakeUser): void {
    this.#users.set(login, user);
  }

  async start(): Promise<this> {
    const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
    this.#key = privateKey;
    this.#jwk = { ...(await exportJWK(publicKey)), kid: 'test', alg: 'RS256', use: 'sig' };
    this.#server = createServer((req, res) => void this.#handle(req, res));
    this.#server.on('connection', (s) => {
      this.#sockets.add(s);
      s.on('close', () => this.#sockets.delete(s));
    });
    await new Promise<void>((r) => this.#server!.listen(this.#wantPort, this.#host === 'localhost' ? 'localhost' : '127.0.0.1', r));
    this.#port = (this.#server.address() as AddressInfo).port;
    return this;
  }

  async stop(): Promise<void> {
    for (const s of this.#sockets) s.destroy();
    await new Promise<void>((r) => (this.#server ? this.#server.close(() => r()) : r()));
    this.#server = null;
  }

  async #token(user: FakeUser, nonce: string | null): Promise<{ access: string; id: string }> {
    const t = Math.floor(Date.now() / 1000) + this.skewSeconds;
    const sign = (claims: Record<string, unknown>, aud: string) =>
      new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer(this.issuer).setAudience(aud).setSubject(user.sub).setIssuedAt(t).setExpirationTime(t + this.expiresIn).sign(this.#key!);
    const groups = this.roleStyle === 'groups';
    // Токен доступа у многих провайдеров не JWT: роли тогда только в id_token.
    const access = groups ? randomUUID() : await sign(user.roles ? { realm_access: { roles: user.roles } } : {}, 'account');
    const id = await sign(
      { ...(nonce ? { nonce } : {}), ...(user.name ? { name: user.name } : {}), ...(user.username ? { preferred_username: user.username } : {}), ...(groups && user.roles ? { groups: user.roles } : {}) },
      'threadline',
    );
    return { access, id };
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '', this.issuer);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const redirect = (to: string) => {
      res.writeHead(302, { location: to });
      res.end();
    };
    if (this.mode === 'down') {
      req.socket.destroy();
      return;
    }
    if (this.mode === 'hang') return;
    if (this.mode === '503') return json(503, { error: 'unavailable' });
    const base = '/realms/test';
    if (url.pathname === `${base}/.well-known/openid-configuration`) {
      this.calls.discovery++;
      return json(200, {
        issuer: this.wrongIssuer ? 'http://other.example/realms/test' : this.issuer,
        authorization_endpoint: `${this.issuer}/auth`,
        token_endpoint: `${this.issuer}/token`,
        jwks_uri: `${this.issuer}/jwks`,
        end_session_endpoint: `${this.issuer}/logout`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
      });
    }
    if (url.pathname === `${base}/jwks`) return json(200, { keys: [this.#jwk] });
    if (url.pathname === `${base}/auth`) {
      this.calls.authorize++;
      this.lastAuthorize = url.searchParams;
      const q = url.searchParams;
      const back = new URL(q.get('redirect_uri') ?? '');
      back.searchParams.set('state', q.get('state') ?? '');
      if (this.denyLogin) {
        back.searchParams.set('error', 'access_denied');
        back.searchParams.set('error_description', 'Текст провайдера, который нельзя показывать');
        return redirect(back.href);
      }
      if (q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge') || !q.get('nonce')) return json(400, { error: 'invalid_request' });
      const login = q.get('login') ?? this.autoUser;
      if (!login) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        const links = [...this.#users.keys()].map((u) => {
          const to = new URL(url);
          to.searchParams.set('login', u);
          return `<p><a data-user="${u}" href="${to.pathname}${to.search}">${u}</a></p>`;
        });
        res.end(`<!doctype html><title>Ложный вход</title>${links.join('')}`);
        return;
      }
      const user = this.#users.get(login);
      if (!user) return json(400, { error: 'unknown user' });
      const code = randomUUID();
      this.#grants.set(code, { user, challenge: q.get('code_challenge')!, nonce: q.get('nonce')!, redirect: q.get('redirect_uri')! });
      back.searchParams.set('code', code);
      return redirect(back.href);
    }
    if (url.pathname === `${base}/token`) {
      let raw = '';
      for await (const chunk of req) raw += String(chunk);
      const form = new URLSearchParams(raw);
      if (this.rejectClient || form.get('client_secret') !== CLIENT_SECRET) return json(401, { error: 'invalid_client' });
      if (form.get('grant_type') === 'refresh_token') {
        this.calls.refresh++;
        if (this.refreshMode === 'down') {
          req.socket.destroy();
          return;
        }
        const user = this.#refresh.get(form.get('refresh_token') ?? '');
        if (this.refreshMode === 'invalid_grant' || !user) return json(400, { error: 'invalid_grant', error_description: 'Текст провайдера' });
        return json(200, await this.#issue(user, null));
      }
      this.calls.token++;
      const code = form.get('code') ?? '';
      const grant = this.#grants.get(code);
      this.#grants.delete(code);
      if (!grant) return json(400, { error: 'invalid_grant' });
      const challenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
      if (challenge !== grant.challenge || form.get('redirect_uri') !== grant.redirect) return json(400, { error: 'invalid_grant' });
      return json(200, await this.#issue(grant.user, grant.nonce));
    }
    if (url.pathname === `${base}/logout`) {
      this.calls.endSession++;
      this.lastLogout = url.searchParams;
      return redirect(url.searchParams.get('post_logout_redirect_uri') ?? '/');
    }
    json(404, { error: 'not found' });
  }

  async #issue(user: FakeUser, nonce: string | null) {
    const { access, id } = await this.#token(user, nonce);
    const refresh = randomUUID();
    this.#refresh.set(refresh, user);
    return { access_token: access, id_token: id, refresh_token: refresh, token_type: 'Bearer', expires_in: this.expiresIn };
  }
}
