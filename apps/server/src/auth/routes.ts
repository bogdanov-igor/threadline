// Вход, сессия и её продление, выход.
// Маршруты под /api/auth: новых занятых идентификаторов проекта нет. Журнал видит только путь: значения не пишутся.

import { randomBytes } from 'node:crypto';
import fastifyCookie from '@fastify/cookie';
import fastifySession from '@fastify/session';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { capabilitiesOf, type AuthErrorReason, type AuthMe, type Role } from '@threadline/core/access';
import type { AuthSettings } from '@threadline/core/config';
import { dispatcherFor } from '../backends/http.ts';
import type { Health } from '../health.ts';
import type { AuthSecrets } from '../config/load.ts';
import { LOCAL_VIEWER, type ViewerSource } from './access.ts';
import { AuthFailure, failureKind, failureReason, isInvalidGrant, Oidc, type TokenFacts } from './oidc.ts';
import { SessionMap } from './session-store.ts';

export const SESSION_COOKIE = 'threadline.sid';
/** Браузер, начавший вход: связывает обратный вызов с тем, кто ушёл к провайдеру входа. Сессии не открывает. */
export const LOGIN_COOKIE = 'threadline.login';
export const SESSION_MAX_MS = 12 * 60 * 60_000;
/** Сколько сессия работает по последней роли, если провайдер входа не отвечает: дольше неизвестно, не отозваны ли права. */
export const OFFLINE_MAX_MS = 30 * 60_000;
export const REFRESH_RETRY_MS = 30_000;
const WARN_EVERY_MS = 60_000;
/** Незавершённые входы живут отдельно от сессий: их поток вытесняет только такие же входы. Срок как «Login timeout» Keycloak по умолчанию: у других провайдеров он того же порядка. */
export const MAX_PENDING_LOGINS = 10_000;
export const PENDING_MS = 30 * 60_000;
const RETURN_MAX = 2048;
const LOGIN_PATH = '/api/auth';
const BROWSER_ID = /^[A-Za-z0-9_-]{43}$/;

export interface PendingLogin {
  state: string;
  verifier: string;
  nonce: string;
  returnTo: string;
  /** Значение cookie браузера, начавшего вход. */
  browser: string;
}

/** Что сессия знает о входе. Хранилище в памяти отдаёт этот объект всем запросам сессии, поэтому фоновое обновление меняет его на месте. */
export interface AuthState {
  sub: string;
  name: string | null;
  role: Role | null;
  loginAt: number;
  accessExpiresAt: number;
  refreshToken: string | null;
  idToken: string | null;
  ended: boolean;
}

declare module 'fastify' {
  interface Session {
    auth?: AuthState;
  }
}

/** Адрес возврата только на самом Threadline, иначе главная страница. */
export function safeReturnTo(v: unknown): string {
  if (typeof v !== 'string' || v.length > RETURN_MAX) return '/';
  // eslint-disable-next-line no-control-regex
  if (!v.startsWith('/') || v.startsWith('//') || v.includes('\\') || /[\u0000-\u001f\u007f]/.test(v) || v.startsWith('/api/')) return '/';
  return v;
}

const errorPage = (reason: AuthErrorReason) => `/auth-error?reason=${reason}`;

export interface AuthRoutesOptions {
  settings: AuthSettings | 'off';
  secrets?: AuthSecrets | undefined;
  ca?: string | undefined;
  now: () => number;
  /** Шутки интерфейса включены (extras.publicEggs): браузер узнаёт это из /api/auth/me. По умолчанию включены. */
  publicEggs?: boolean;
  /** Для тестов: таймаут ответа провайдера и своё хранилище сессий. */
  timeoutSeconds?: number;
  sessions?: SessionMap<unknown>;
  /** Для тестов: своя таблица незавершённых входов. */
  pendingLogins?: SessionMap<PendingLogin>;
  /** Готовность: вход сообщает, получены ли настройки провайдера. */
  health?: Pick<Health, 'add'>;
  /** Локальный режим (cli/local.ts): браузер узнаёт его из /api/auth/me. Только при выключенном входе. */
  local?: boolean;
}

/** Ответ /api/auth/me для того, кто уже прошёл таблицу доступа. */
const meOf = (mode: AuthMe['mode'], req: FastifyRequest, publicEggs: boolean, local = false): AuthMe => ({
  mode,
  user: { name: req.viewer?.name ?? null },
  role: req.viewer?.role ?? null,
  capabilities: capabilitiesOf(req.viewer?.role ?? null),
  publicEggs,
  ...(local ? { local: true } : {}),
});

/** Вход выключен: те же адреса отвечают без провайдера входа. Настройка права не обходит: роль администратора идёт через ту же таблицу. */
function registerOff(app: FastifyInstance, publicEggs: boolean, local: boolean): ViewerSource {
  app.get('/api/auth/me', { config: { access: 'signed-in' } }, async (req) => meOf('off', req, publicEggs, local));
  app.get<{ Querystring: { returnTo?: string } }>('/api/auth/login', { config: { access: 'public' } }, async (req, reply) => reply.redirect(safeReturnTo(req.query.returnTo)));
  app.get('/api/auth/callback', { config: { access: 'public' } }, async (_req, reply) => reply.redirect('/'));
  app.post('/api/auth/logout', { config: { access: 'public' } }, async () => ({ redirect: '/' }));
  return () => LOCAL_VIEWER;
}

/**
 * Cookie и сессия: их хуки onRequest ставятся раньше таблицы доступа, иначе она не увидит сессию. Хуки идут в порядке регистрации.
 * При auth: off не ставятся: ни cookie, ни записей в памяти нет.
 */
export async function installSession(app: FastifyInstance, opts: AuthRoutesOptions): Promise<void> {
  const { settings } = opts;
  if (settings === 'off') return;
  if (!opts.secrets) throw new Error('при включённом входе нужны секреты входа');
  await app.register(fastifyCookie);
  await app.register(fastifySession, {
    secret: opts.secrets.sessionSecret,
    cookieName: SESSION_COOKIE,
    saveUninitialized: false,
    rolling: false,
    store: new fastifySession.MemoryStore((opts.sessions ?? new SessionMap<unknown>({ ttlMs: SESSION_MAX_MS, now: opts.now })) as unknown as Map<string, never>),
    cookie: { path: '/', httpOnly: true, sameSite: 'lax', secure: settings.publicUrl.startsWith('https:'), maxAge: SESSION_MAX_MS },
  });
}

export function registerAuth(app: FastifyInstance, opts: AuthRoutesOptions): ViewerSource {
  const { settings, now } = opts;
  if (settings === 'off') {
    opts.health?.add('login', () => 'off');
    return registerOff(app, opts.publicEggs ?? true, opts.local === true);
  }
  if (!opts.secrets) throw new Error('при включённом входе нужны секреты входа');
  const warn = (m: string) => app.log.warn(m);
  const dispatcher = dispatcherFor(opts.ca, process.env);
  const oidc = new Oidc(settings, { secret: opts.secrets.clientSecret, dispatcher, now, warn, ...(opts.timeoutSeconds ? { timeoutSeconds: opts.timeoutSeconds } : {}) });
  const secure = settings.publicUrl.startsWith('https:');
  const pendingLogins = opts.pendingLogins ?? new SessionMap<PendingLogin>({ ttlMs: PENDING_MS, max: MAX_PENDING_LOGINS, now });
  const browserOf = (req: FastifyRequest): string | null => {
    const v = req.cookies[LOGIN_COOKIE];
    return typeof v === 'string' && BROWSER_ID.test(v) ? v : null;
  };

  app.addHook('onListen', async () => oidc.warmUp());
  app.addHook('onClose', async () => oidc.stop());
  // Настройки провайдера нужны один раз: позже его обрыв не снимает под, живые сессии работают и без него.
  opts.health?.add('login', () => (oidc.discovered ? 'ok' : 'waiting'));

  /** Одно фоновое обновление на сессию, повтор не чаще раза в 30 секунд. Ответ пользователю его не ждёт. */
  const refreshing = new WeakMap<AuthState, { running: boolean; lastTry: number }>();
  let lastWarn = 0;
  const applyTokens = (auth: AuthState, t: TokenFacts) => {
    auth.accessExpiresAt = now() + t.expiresIn * 1000;
    auth.role = t.role;
    if (t.refreshToken) auth.refreshToken = t.refreshToken;
    if (t.idToken) auth.idToken = t.idToken;
  };
  const refreshInBackground = (auth: AuthState) => {
    if (!auth.refreshToken) {
      auth.ended = true;
      return;
    }
    const at = now();
    const state = refreshing.get(auth) ?? { running: false, lastTry: 0 };
    refreshing.set(auth, state);
    if (state.running || (state.lastTry !== 0 && at - state.lastTry < REFRESH_RETRY_MS)) return;
    state.running = true;
    state.lastTry = at;
    oidc
      .refresh(auth.refreshToken)
      .then(
        (t) => applyTokens(auth, t),
        (e: unknown) => {
          if (isInvalidGrant(e)) {
            auth.ended = true;
            return;
          }
          if (now() - lastWarn >= WARN_EVERY_MS) {
            lastWarn = now();
            warn(`вход: провайдер OIDC не обновил сессию, работа идёт по последней роли: ${failureKind(e)}`);
          }
        },
      )
      .finally(() => {
        state.running = false;
      });
  };

  const alive = (auth: AuthState | undefined): auth is AuthState => {
    if (!auth || auth.ended) return false;
    const at = now();
    return at - auth.loginAt < SESSION_MAX_MS && at - auth.accessExpiresAt < OFFLINE_MAX_MS;
  };

  const viewerOf: ViewerSource = async (req) => {
    const auth = req.session?.auth;
    if (!auth) return null;
    if (!alive(auth)) {
      await req.session.destroy();
      return null;
    }
    if (now() >= auth.accessExpiresAt) refreshInBackground(auth);
    // Обновление могло кончиться сразу: invalid_grant завершает сессию уже следующим запросом.
    return { owner: auth.sub, role: auth.role, name: auth.name };
  };

  app.get('/api/auth/me', { config: { access: 'signed-in' } }, async (req) => meOf('on', req, opts.publicEggs ?? true));

  app.get<{ Querystring: { returnTo?: string } }>('/api/auth/login', { config: { access: 'public' } }, async (req, reply) => {
    // За обратным прокси без X-Forwarded-Proto плагин не поставит Secure-cookie: вход зациклился бы.
    if (secure && req.protocol !== 'https') {
      warn('вход: сервис настроен на https, а запрос пришёл без X-Forwarded-Proto: https, cookie сессии не будет поставлена');
      return reply.redirect(errorPage('config'));
    }
    try {
      const begun = await oidc.begin();
      // Сессия здесь не создаётся. Тот же браузер получает то же значение: две вкладки входят одновременно.
      const browser = browserOf(req) ?? randomBytes(32).toString('base64url');
      pendingLogins.set(begun.state, { state: begun.state, verifier: begun.verifier, nonce: begun.nonce, returnTo: safeReturnTo(req.query.returnTo), browser });
      void reply.setCookie(LOGIN_COOKIE, browser, { path: LOGIN_PATH, httpOnly: true, sameSite: 'lax', secure, maxAge: PENDING_MS / 1000 });
      return await reply.redirect(begun.url);
    } catch (e) {
      return reply.redirect(errorPage(failureReason(e)));
    }
  });

  app.get<{ Querystring: { state?: string; code?: string; error?: string } }>('/api/auth/callback', { config: { access: 'public' } }, async (req, reply: FastifyReply) => {
    const { state, error } = req.query;
    const browser = browserOf(req);
    const found = typeof state === 'string' ? pendingLogins.get(state) : undefined;
    // Чужой браузер с настоящим state: вход злоумышленника в браузере жертвы не завершается.
    const pending = found && browser !== null && found.browser === browser ? found : undefined;
    if (!pending) {
      // Кнопка «назад» на использованный адрес при живой сессии: ошибки нет.
      if (alive(req.session.auth)) return reply.redirect('/');
      return reply.redirect(errorPage('state'));
    }
    pendingLogins.delete(pending.state);
    if (error) return reply.redirect(errorPage('denied'));
    try {
      const t = await oidc.finish(req.url, pending);
      if (!t.sub) throw new AuthFailure('config');
      // Идентификатор меняется при входе: прежнее значение cookie ничего не открывает. Вход другой вкладки лежит в таблице входов и продолжается.
      await req.session.regenerate();
      const at = now();
      req.session.auth = { sub: t.sub, name: t.name, role: t.role, loginAt: at, accessExpiresAt: at + t.expiresIn * 1000, refreshToken: t.refreshToken, idToken: t.idToken, ended: false };
      return await reply.redirect(pending.returnTo);
    } catch (e) {
      return reply.redirect(errorPage(failureReason(e)));
    }
  });

  // Запрос идёт из интерфейса, а не формой: форма при no-referrer шлёт Origin: null, а form-action блокирует переход к провайдеру входа.
  app.post('/api/auth/logout', { config: { access: 'public' } }, async (req, reply) => {
    const idToken = req.session?.auth?.idToken;
    if (req.session) await req.session.destroy();
    void reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { redirect: (await oidc.logoutUrl(idToken)) ?? '/logged-out?provider=unreachable' };
  });

  return viewerOf;
}
