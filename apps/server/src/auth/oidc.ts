// Обращения к провайдеру входа OIDC (например, Keycloak): discovery, вход, обмен кода, обновление, выход. Обычный OIDC на openid-client,
// адаптеров под провайдеров нет. В журнал и ответы текст провайдера и значения не попадают.

import * as client from 'openid-client';
import { fetch as undiciFetch, type Dispatcher } from 'undici';
import { strongestRole, type AuthErrorReason, type Role } from '@threadline/core/access';
import type { AuthSettings } from '@threadline/core/config';

export const CLOCK_TOLERANCE_SECONDS = 60;
export const DISCOVERY_TIMEOUT_SECONDS = 5;
export const DISCOVERY_RETRY_MS = 10_000;
const WARM_RETRY_MIN_MS = 1000;
const WARM_RETRY_MAX_MS = 30_000;
/** Срок токена, если провайдер не назвал expires_in. */
const DEFAULT_EXPIRES_SECONDS = 300;

export class AuthFailure extends Error {
  readonly reason: AuthErrorReason;
  constructor(reason: AuthErrorReason) {
    super(reason);
    this.name = 'AuthFailure';
    this.reason = reason;
  }
}

export interface OidcOptions {
  secret: string;
  dispatcher?: Dispatcher | undefined;
  now?: () => number;
  warn?: (message: string) => void;
  /** Для тестов: таймаут ответа провайдера, секунд. */
  timeoutSeconds?: number;
}

export interface BeginResult {
  url: string;
  state: string;
  verifier: string;
  nonce: string;
}

export interface TokenFacts {
  sub: string | null;
  name: string | null;
  role: Role | null;
  refreshToken: string | null;
  idToken: string | null;
  /** Секунд до конца токена доступа: сроки считает сервер от момента получения, а не по времени внутри токена. */
  expiresIn: number;
}

type Claims = Record<string, unknown>;
const isObj = (v: unknown): v is Claims => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Содержимое JWT без проверки подписи: токен сервер получил прямо от провайдера по TLS. Не JWT — null. */
export function jwtClaims(token: string | undefined): Claims | null {
  const part = token?.split('.')[1];
  if (!part) return null;
  try {
    const v: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
}

/** Значение поля: по имени целиком (https://threadline.corp.example/roles), иначе по пути через точку (realm_access.roles). */
export function claimAt(claims: Claims | null | undefined, path: string): unknown {
  if (isObj(claims) && Object.hasOwn(claims, path)) return claims[path];
  let at: unknown = claims;
  for (const key of path.split('.')) {
    if (!isObj(at) || !Object.hasOwn(at, key)) return undefined;
    at = at[key];
  }
  return at;
}

const isLocal = (url: URL) => url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');

/** Причина экрана по ошибке библиотеки. Сеть, таймаут и 5xx — сервис входа недоступен; всё, на что провайдер ответил отказом, — настройка. */
export function failureReason(e: unknown): AuthErrorReason {
  if (e instanceof AuthFailure) return e.reason;
  if (e instanceof client.AuthorizationResponseError) return 'denied';
  if (e instanceof client.ResponseBodyError) return e.status >= 500 ? 'unavailable' : e.error === 'invalid_grant' ? 'denied' : 'config';
  if (e instanceof client.ClientError) {
    const code = e.code ?? '';
    if (code === 'OAUTH_JWT_TIMESTAMP_CHECK_FAILED') return 'clock';
    const cause = e.cause as { status?: unknown; name?: unknown } | undefined;
    if (typeof cause?.status === 'number' && cause.status >= 500) return 'unavailable';
    if (cause?.name === 'TimeoutError' || cause?.name === 'AbortError' || cause?.name === 'TypeError') return 'unavailable';
    if (code === 'OAUTH_RESPONSE_IS_NOT_JSON' || code === 'OAUTH_RESPONSE_IS_NOT_CONFORM') return 'unavailable';
    return 'config';
  }
  return 'unavailable';
}

const kindOf = (e: unknown) => (e instanceof client.ResponseBodyError ? `${e.name} ${e.error}` : e instanceof client.ClientError ? `${e.name} ${e.code ?? ''}`.trim() : e instanceof Error ? e.name : typeof e);

export class Oidc {
  readonly #settings: AuthSettings;
  readonly #opts: OidcOptions;
  readonly #now: () => number;
  #config: client.Configuration | null = null;
  #lastTry = 0;
  #lastFailure: AuthErrorReason = 'unavailable';
  #running: Promise<client.Configuration> | null = null;
  #warmTimer: NodeJS.Timeout | null = null;
  #stopped = false;

  constructor(settings: AuthSettings, opts: OidcOptions) {
    this.#settings = settings;
    this.#opts = opts;
    this.#now = opts.now ?? Date.now;
  }

  get #redirectUri(): string {
    return new URL('/api/auth/callback', this.#settings.publicUrl).href;
  }

  /** openid и profile всегда, сверх них — области из настройки, без повторов. */
  get #scope(): string {
    return [...new Set(['openid', 'profile', ...(this.#settings.scopes ?? [])])].join(' ');
  }

  get #timeout(): number {
    return this.#opts.timeoutSeconds ?? DISCOVERY_TIMEOUT_SECONDS;
  }

  #fetch(): client.CustomFetch | undefined {
    const dispatcher = this.#opts.dispatcher;
    if (!dispatcher) return undefined;
    return ((url: string, init: Parameters<typeof undiciFetch>[1]) => undiciFetch(url, { ...init, dispatcher })) as unknown as client.CustomFetch;
  }

  /** Discovery лениво, с таймаутом и не чаще раза в 10 секунд: кнопка повтора не отправляет лишних запросов. Успех хранится в памяти. */
  configuration(): Promise<client.Configuration> {
    if (this.#config) return Promise.resolve(this.#config);
    if (this.#running) return this.#running;
    const now = this.#now();
    if (this.#lastTry !== 0 && now - this.#lastTry < DISCOVERY_RETRY_MS) return Promise.reject(new AuthFailure(this.#lastFailure));
    this.#lastTry = now;
    const issuer = new URL(this.#settings.issuer);
    const custom = this.#fetch();
    this.#running = client
      .discovery(issuer, this.#settings.clientId, { [client.clockTolerance]: CLOCK_TOLERANCE_SECONDS }, client.ClientSecretPost(this.#opts.secret), {
        timeout: this.#timeout,
        ...(isLocal(issuer) ? { execute: [client.allowInsecureRequests] } : {}),
        ...(custom ? { [client.customFetch]: custom } : {}),
      })
      .then(
        (config) => {
          this.#config = config;
          return config;
        },
        (e: unknown) => {
          this.#lastFailure = failureReason(e);
          this.#opts.warn?.(`вход: провайдер OIDC ${issuer.origin} не дал настройки: ${kindOf(e)}`);
          throw new AuthFailure(this.#lastFailure);
        },
      )
      .finally(() => {
        this.#running = null;
      });
    return this.#running;
  }

  /** Настройки провайдера уже получены: от этого зависит готовность сервиса. */
  get discovered(): boolean {
    return this.#config !== null;
  }

  /**
   * Сервер уже запущен: журнал сразу называет адрес и причину, если провайдер недоступен. Запуск этого не ждёт.
   * Повторы с нарастающей паузой до первого успеха: готовность не должна ждать первого входа человека.
   */
  warmUp(): void {
    let pause = WARM_RETRY_MIN_MS;
    const later = () => {
      this.#warmTimer = setTimeout(attempt, pause);
      this.#warmTimer.unref();
      pause = Math.min(pause * 2, WARM_RETRY_MAX_MS);
    };
    const attempt = () => {
      if (this.#stopped || this.#config) return;
      // Окно занял человек кнопкой повтора: фоновая попытка его не сбрасывает.
      if (this.#lastTry !== 0 && this.#now() - this.#lastTry < DISCOVERY_RETRY_MS) return later();
      this.configuration().catch(() => {
        // Запрос в фоне не занимает окно в 10 секунд: первый вход человека идёт к провайдеру сам, а не повторяет старую причину.
        this.#lastTry = 0;
        later();
      });
    };
    attempt();
  }

  /** Остановка сервера: фоновые повторы больше не идут. */
  stop(): void {
    this.#stopped = true;
    if (this.#warmTimer) clearTimeout(this.#warmTimer);
  }

  async begin(): Promise<BeginResult> {
    const config = await this.configuration();
    const verifier = client.randomPKCECodeVerifier();
    const state = client.randomState();
    const nonce = client.randomNonce();
    const url = client.buildAuthorizationUrl(config, {
      redirect_uri: this.#redirectUri,
      scope: this.#scope,
      response_type: 'code',
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      state,
      nonce,
    });
    return { url: url.href, state, verifier, nonce };
  }

  #facts(tokens: client.TokenEndpointResponse & client.TokenEndpointResponseHelpers): TokenFacts {
    const id = tokens.claims();
    return {
      sub: typeof id?.sub === 'string' ? id.sub : null,
      name: typeof id?.name === 'string' && id.name ? id.name : typeof id?.preferred_username === 'string' && id.preferred_username ? id.preferred_username : null,
      role: this.#role(jwtClaims(tokens.access_token), id ?? null),
      refreshToken: tokens.refresh_token ?? null,
      idToken: tokens.id_token ?? null,
      expiresIn: typeof tokens.expires_in === 'number' && tokens.expires_in > 0 ? tokens.expires_in : DEFAULT_EXPIRES_SECONDS,
    };
  }

  /**
   * Поле ролей: из токена доступа, у лёгких токенов — из id_token. Список, одна строка или объект с ролями в ключах (так кладёт Zitadel).
   * Поля нет — роли нет, журнал называет только имя поля.
   */
  #role(access: Claims | null, id: Claims | null): Role | null {
    const path = this.#settings.roleClaim;
    for (const claims of [access, id]) {
      const list = claimAt(claims, path);
      if (Array.isArray(list)) return strongestRole(list, this.#settings.roles);
      if (typeof list === 'string' && list) return strongestRole([list], this.#settings.roles);
      if (isObj(list)) return strongestRole(Object.keys(list), this.#settings.roles);
    }
    this.#opts.warn?.(`вход: в токене нет поля ролей ${path}`);
    return null;
  }

  /** Обмен кода. Адрес ответа собирается от publicUrl: адрес из запроса подделывается. */
  async finish(pathAndQuery: string, pending: { state: string; verifier: string; nonce: string }): Promise<TokenFacts> {
    const config = await this.configuration();
    try {
      const tokens = await client.authorizationCodeGrant(config, new URL(pathAndQuery, this.#settings.publicUrl), {
        pkceCodeVerifier: pending.verifier,
        expectedNonce: pending.nonce,
        expectedState: pending.state,
        idTokenExpected: true,
      });
      const iat = tokens.claims()?.iat;
      // Библиотека сверяет только конец срока, поэтому часы, отстающие от провайдера, проверяются здесь.
      if (typeof iat === 'number') {
        const skew = Math.round(this.#now() / 1000 - iat);
        if (Math.abs(skew) > CLOCK_TOLERANCE_SECONDS) {
          this.#opts.warn?.(`вход: часы сервера и провайдера OIDC расходятся на ${skew} с`);
          throw new AuthFailure('clock');
        }
      }
      return this.#facts(tokens);
    } catch (e) {
      const reason = failureReason(e);
      if (reason === 'clock' && !(e instanceof AuthFailure)) {
        // Библиотека кладёт время и утверждения в причину своей ошибки, значений пользователя там не берём.
        type Check = { claims?: { iat?: unknown }; now?: unknown };
        const wrapped = (e as { cause?: Check & { cause?: Check } }).cause;
        const cause = wrapped?.cause ?? wrapped;
        const skew = typeof cause?.claims?.iat === 'number' && typeof cause.now === 'number' ? ` на ${Math.round(cause.now - cause.claims.iat)} с` : '';
        this.#opts.warn?.(`вход: часы сервера и провайдера OIDC расходятся${skew}`);
      } else if (!(e instanceof AuthFailure)) this.#opts.warn?.(`вход не выполнен: ${kindOf(e)}`);
      throw new AuthFailure(reason);
    }
  }

  /** Обновление токенов. Ошибку разбирает вызывающий: invalid_grant завершает сессию, остальное не считается её концом. */
  async refresh(refreshToken: string): Promise<TokenFacts> {
    return this.#facts(await client.refreshTokenGrant(await this.configuration(), refreshToken));
  }

  /** Адрес выхода у провайдера, без подсказки он задал бы лишний вопрос. null — провайдер сейчас не отвечает или выхода не объявил. */
  async logoutUrl(idToken: string | null | undefined): Promise<string | null> {
    try {
      const config = await this.configuration();
      const custom = this.#fetch();
      const check = await (custom ?? fetch)(new URL('.well-known/openid-configuration', `${this.#settings.issuer.replace(/\/+$/, '')}/`).href, { signal: AbortSignal.timeout(this.#timeout * 1000) } as never);
      if (!check.ok) return null;
      return client.buildEndSessionUrl(config, {
        post_logout_redirect_uri: new URL('/logged-out', this.#settings.publicUrl).href,
        client_id: this.#settings.clientId,
        ...(idToken ? { id_token_hint: idToken } : {}),
      }).href;
    } catch {
      return null;
    }
  }
}

/** Провайдер отказал в обновлении: сессии больше нет. */
export const isInvalidGrant = (e: unknown): boolean => e instanceof client.ResponseBodyError && e.error === 'invalid_grant';
export { kindOf as failureKind };
