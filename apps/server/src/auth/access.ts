// Таблица доступа на сервере: каждый маршрут API объявляет, кому он доступен, необъявленный закрыт.
// Отказ приходит из корневого хука onRequest: до разбора тела, хранилища и базы.

import { isIP } from 'node:net';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { can, type AccessErrorCode, type Capability, type Role } from '@threadline/core/access';

/** public — без входа; signed-in — любой вошедший, в том числе без роли; право — вошедший с этим правом. Функция — право зависит от адреса. */
export type Access = 'public' | 'signed-in' | Capability | ((req: FastifyRequest) => Capability);

/** Кто делает запрос. owner — учётная запись (sub), от него зависит принадлежность заданий поиска. */
export interface Viewer {
  owner: string;
  role: Role | null;
  name: string | null;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    access?: Access;
  }
  interface FastifyRequest {
    viewer: Viewer | null;
  }
}

/**
 * auth: off — все запросы считаются одним пользователем с правами администратора. Отдельных обходов в маршрутах нет.
 * Исключение одно: для скрытых значений это зритель no-login, а не администратор (таблица видов). Его определяет isNoLogin.
 */
export const LOCAL_VIEWER: Viewer = { owner: 'local', role: 'admin', name: null };

export type ViewerSource = (req: FastifyRequest, reply: FastifyReply) => Viewer | null | Promise<Viewer | null>;

export interface RouteEntry {
  method: string;
  url: string;
  access: Access | undefined;
}

export const roleOf = (req: FastifyRequest): Role | null => req.viewer?.role ?? null;
export const ownerOf = (req: FastifyRequest): string => req.viewer?.owner ?? LOCAL_VIEWER.owner;
export const isBusiness = (req: FastifyRequest): boolean => roleOf(req) === 'business';

/**
 * Кто занимает места пула поисков и чтений по ссылке. При входе — учётная запись: две сессии
 * одного человека делят его места. При auth: off учётной записи и cookie нет: адрес клиента, последний в X-Forwarded-For (его ставит
 * входной прокси), без заголовка — адрес соединения. Подделка заголовка без входа даёт только лишние места: права и так у всех.
 */
export function holderOf(req: FastifyRequest): string {
  if (req.viewer && req.viewer !== LOCAL_VIEWER) return `user:${req.viewer.owner}`;
  const given = req.headers['x-forwarded-for'];
  const forwarded = (Array.isArray(given) ? given.at(-1) : given)?.split(',').at(-1)?.trim();
  return `addr:${forwarded || req.ip}`;
}
/** Запрос без входа, при auth: off: номер карты и секреты такому зрителю не открываются. */
export const isNoLogin = (req: FastifyRequest): boolean => req.viewer === LOCAL_VIEWER;

/** Отказ без подробностей: ни нужной роли, ни сведений о записи. */
export function deny(reply: FastifyReply, status: 401 | 403, code: AccessErrorCode): FastifyReply {
  return reply.code(status).send({ error: { code } });
}

const DEFAULT_PORT: Record<string, string> = { 'http:': '80', 'https:': '443' };

/** Хост без стандартного порта схемы: https://x и Host: x:443 равны. */
function originHost(origin: string): { host: string; protocol: string } | null {
  try {
    const u = new URL(origin);
    return u.host && DEFAULT_PORT[u.protocol] ? { host: u.host.toLowerCase(), protocol: u.protocol } : null;
  } catch {
    return null;
  }
}

/** Чужой источник отклоняется: браузерный межсайтовый запрос всегда несёт Origin, curl и серверные клиенты нет. Origin: null приходит из песочницы. */
export function sameOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (origin === undefined) return true;
  const parsed = originHost(origin);
  if (!parsed || !host) return false;
  const own = host.toLowerCase();
  return parsed.host === own || `${parsed.host}:${DEFAULT_PORT[parsed.protocol]}` === own;
}

const HOST = /^(?:\[([0-9a-f:.]+)\]|([a-z0-9.-]+))(?::\d{1,5})?$/;
const HOST_WARN_MS = 60_000;

/** Имя сервера из Host: без порта, в нижнем регистре, без точки в конце. null — заголовка нет или в нём не имя и порт. */
export function hostName(host: string | undefined): string | null {
  const m = host ? HOST.exec(host.toLowerCase()) : null;
  if (!m) return null;
  if (m[1] !== undefined) return isIP(m[1]) === 6 ? `[${m[1]}]` : null;
  const name = m[2]!.replace(/\.$/, '');
  return name === '' ? null : name;
}

/**
 * Перепривязка имени (DNS rebinding) идёт через доменное имя злоумышленника: тогда Origin и Host совпадают, и проверка источника молчит.
 * Поэтому проходят только имя из publicUrl, localhost и IP-адреса: IP пода, port-forward, локальная сеть при auth: off.
 */
export function knownHost(name: string | null, publicHost: string | null): boolean {
  if (name === null) return false;
  return name === 'localhost' || name === publicHost || name.startsWith('[') || isIP(name) === 4;
}

export interface AccessOptions {
  /** Для тестов: сюда записываются все маршруты с объявленным доступом. */
  routes?: RouteEntry[] | undefined;
  /** Адрес сервиса при включённом входе: его имя проходит проверку Host. */
  publicUrl?: string | null | undefined;
}

/**
 * Ставится до регистрации маршрутов: корневой onRoute видит и маршруты вложенных плагинов, поэтому забыть объявление нельзя.
 * Несуществующий адрес и файлы интерфейса проверку не проходят: у них нет данных, а 404 остаётся 404.
 */
export function registerAccess(app: FastifyInstance, viewerOf: ViewerSource, opts: AccessOptions = {}): void {
  const { routes } = opts;
  const publicHost = opts.publicUrl ? new URL(opts.publicUrl).hostname : null;
  let hostWarnAt = -Infinity;
  app.decorateRequest('viewer', null);
  if (routes) {
    app.addHook('onRoute', (r) => {
      for (const method of [r.method].flat()) routes.push({ method: String(method), url: r.url, access: r.config?.access });
    });
  }
  app.addHook('onRequest', async (req, reply) => {
    const route = req.routeOptions.url;
    if (route === undefined || !route.startsWith('/api/')) return undefined;
    const name = hostName(req.headers.host);
    if (!knownHost(name, publicHost)) {
      if (Date.now() - hostWarnAt >= HOST_WARN_MS) {
        hostWarnAt = Date.now();
        req.log.warn(`запрос к API с неизвестным именем сервера отклонён: ${name ?? 'заголовка Host нет или он неразборчив'}. Проходят имя из адреса сервиса (THREADLINE_PUBLIC_URL), localhost и IP-адреса`);
      }
      return deny(reply, 403, 'forbidden');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req.headers.origin, req.headers.host)) return deny(reply, 403, 'forbidden');
    const access = req.routeOptions.config.access;
    if (access === undefined) {
      req.log.warn(`маршрут без объявленного доступа: ${req.method} ${route}`);
      return deny(reply, 403, 'forbidden');
    }
    if (access === 'public') return undefined;
    const viewer = await viewerOf(req, reply);
    if (!viewer) return deny(reply, 401, 'unauthenticated');
    req.viewer = viewer;
    if (access === 'signed-in') return undefined;
    if (viewer.role === null) return deny(reply, 403, 'no-role');
    return can(viewer.role, typeof access === 'function' ? access(req) : access) ? undefined : deny(reply, 403, 'forbidden');
  });
}
