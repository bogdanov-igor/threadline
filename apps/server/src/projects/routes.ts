// API страниц проектов.
// Все маршруты правки и проверки подключения — в одном плагине со своим разбором тела. Доступ объявлен у каждого маршрута.

import type { FastifyInstance, FastifyReply } from 'fastify';
import { can } from '@threadline/core/access';
import type { MessageParams, MessageRef, ProbeResponse, ProjectErrorBody, ProjectErrorCode, ProjectSettingsResponse } from '@threadline/core';
import { BackendError } from '@threadline/core/backend';
import { maskText } from '@threadline/core/search';
import { deny, roleOf } from '../auth/access.ts';
import type { Backends } from '../backends/registry.ts';
import { DbError, isConnectionError } from '../catalog/db.ts';
import { CatalogUnavailable } from '../catalog/service.ts';
import { ProjectHttpError, type ProjectsService } from './service.ts';

const NO_KEEP: ReadonlySet<string> = new Set();
const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** Логотипы приходят в теле проекта base64: две версии по 256 КБ и среды. */
export const PROJECT_BODY_LIMIT = 1024 * 1024;
/** Настройка вида — постоянные списки и флаги: полная запись меньше килобайта. */
export const VIEW_BODY_LIMIT = 4 * 1024;

export interface ProjectRoutesContext {
  service: ProjectsService;
  backends: Backends;
  clientSignal: (reply: FastifyReply) => AbortSignal;
}

/** Предупреждение при старте с auth: off и адресом, открытым в сеть. */
export const openNetworkWarning = (host: string, port: number): string =>
  `Threadline открыт в сеть по адресу ${host}:${port}, а вход выключен (auth: off): любой, кто видит этот адрес, получает права администратора. Настройте раздел auth или задайте HOST=127.0.0.1.`;

function send(reply: FastifyReply, status: number, code: ProjectErrorCode, extra: Omit<ProjectErrorBody['error'], 'code'> = {}): FastifyReply {
  return reply.code(status).send({ error: { code, ...extra } } satisfies ProjectErrorBody);
}

const maskParams = (params: MessageParams): MessageParams =>
  Object.fromEntries(Object.entries(params).map(([k, v]) => [k, typeof v === 'string' ? maskText(v, NO_KEEP) : v]));

function fail(reply: FastifyReply, e: unknown): FastifyReply {
  if (e instanceof ProjectHttpError) {
    const body: Omit<ProjectErrorBody['error'], 'code'> = {};
    if (e.fields) {
      const fields: Record<string, string> = {};
      const fieldKeys: Record<string, MessageRef> = {};
      // Значения из запроса могут быть в тексте, в пути и в параметрах: на выходе та же маска, что у остальных ответов.
      for (const i of e.fields) {
        const path = maskText(i.path, NO_KEEP);
        if (fields[path] !== undefined) continue;
        fields[path] = maskText(i.message, NO_KEEP);
        if (i.key) fieldKeys[path] = { key: i.key, ...(i.params ? { params: maskParams(i.params) } : {}) };
      }
      body.fields = fields;
      if (Object.keys(fieldKeys).length > 0) body.fieldKeys = fieldKeys;
    }
    if (e.current) body.current = e.current;
    return send(reply, e.status, e.code as ProjectErrorCode, body);
  }
  if (e instanceof CatalogUnavailable || (e instanceof DbError && isConnectionError(e))) return send(reply, 503, 'project-readonly');
  throw e;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const invalid = (path: string, message: string) => new ProjectHttpError(422, 'project-invalid', { fields: [{ path, message }] });

export async function registerProjectRoutes(app: FastifyInstance, ctx: ProjectRoutesContext): Promise<void> {
  const { service, backends } = ctx;

  app.get('/api/project-settings', { config: { access: 'details' } }, async (): Promise<ProjectSettingsResponse> => service.settings());

  app.get<{ Params: { project: string } }>('/api/projects/:project/delete-preview', { config: { access: 'deleteForever' } }, async (req, reply) => {
    if (!ID.test(req.params.project)) return send(reply, 404, 'project-not-found');
    try {
      return await service.deletePreview(req.params.project);
    } catch (e) {
      return fail(reply, e);
    }
  });

  await app.register(async (scope) => {
    // Единственный парсер JSON: простая форма чужой страницы получает 415.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: PROJECT_BODY_LIMIT }, (_req, body, done) => {
      try {
        done(null, body === '' ? undefined : JSON.parse(body as string));
      } catch {
        const e = new Error('тело запроса не разобрано') as Error & { statusCode: number };
        e.statusCode = 400;
        done(e, undefined);
      }
    });

    scope.post('/api/projects', { config: { access: 'createProjects' } }, async (req, reply) => {
      try {
        return await reply.code(201).send(await service.create(req.body));
      } catch (e) {
        return fail(reply, e);
      }
    });

    scope.put<{ Params: { project: string } }>('/api/projects/:project', { config: { access: 'editProjects' } }, async (req, reply) => {
      try {
        if (!ID.test(req.params.project)) throw new ProjectHttpError(404, 'project-not-found');
        return await service.update(req.params.project, req.body);
      } catch (e) {
        return fail(reply, e);
      }
    });

    scope.put<{ Params: { project: string } }>('/api/projects/:project/view', { bodyLimit: VIEW_BODY_LIMIT, config: { access: 'editProjects' } }, async (req, reply) => {
      try {
        if (!ID.test(req.params.project)) throw new ProjectHttpError(404, 'project-not-found');
        return await service.saveView(req.params.project, req.body);
      } catch (e) {
        return fail(reply, e);
      }
    });

    scope.put<{ Params: { project: string } }>('/api/projects/:project/visibility', { config: { access: 'editProjects' } }, async (req, reply) => {
      try {
        const b: unknown = req.body;
        if (!isObject(b) || typeof b.hidden !== 'boolean') throw invalid('hidden', 'нужно значение true или false');
        if (typeof b.updatedAt !== 'string') throw invalid('updatedAt', 'нет метки версии');
        return await service.setHidden(req.params.project, b.hidden, b.updatedAt);
      } catch (e) {
        return fail(reply, e);
      }
    });

    scope.post<{ Params: { project: string } }>('/api/projects/:project/file-version', { config: { access: 'editProjects' } }, async (req, reply) => {
      try {
        const b: unknown = req.body;
        if (!isObject(b) || (b.action !== 'take' && b.action !== 'keep')) throw invalid('action', 'действие: take или keep');
        if (typeof b.updatedAt !== 'string') throw invalid('updatedAt', 'нет метки версии');
        return await service.fileAction(req.params.project, b.action, b.updatedAt);
      } catch (e) {
        return fail(reply, e);
      }
    });

    scope.delete<{ Params: { project: string }; Querystring: { updatedAt?: string; confirm?: string } }>('/api/projects/:project', { config: { access: 'deleteForever' } }, async (req, reply) => {
      try {
        await service.remove(req.params.project, req.query.confirm, req.query.updatedAt);
        return await reply.code(204).send();
      } catch (e) {
        return fail(reply, e);
      }
    });

    // Без условий — проверка самого хранилища, с условиями — ещё и наличие записей среды. Форма обращается только по нажатию.
    scope.post<{ Params: { store: string } }>('/api/stores/:store/probe', { config: { access: 'details' } }, async (req, reply): Promise<ProbeResponse | FastifyReply> => {
      try {
        const b: unknown = req.body ?? {};
        if (!isObject(b)) throw invalid('environment', 'нужен объект');
        for (const key of Object.keys(b)) if (key !== 'environment' && key !== 'project') throw invalid(key, `неизвестное поле «${key}»`);
        if (!backends.hasStore(req.params.store)) return send(reply, 404, 'store-not-found');
        const project = typeof b.project === 'string' ? b.project : undefined;
        let env: Parameters<Backends['probe']>[1];
        if (b.environment !== undefined) {
          if (can(roleOf(req), 'editProjects')) env = service.checkProbeEnvironment(req.params.store, project, isObject(b.environment) ? b.environment : {});
          else {
            // Несохранённые условия проверяет только тот, кто правит проект: иначе это чтение произвольного селектора.
            env = service.savedEnvironment(req.params.store, project, b.environment);
            if (!env) return deny(reply, 403, 'forbidden');
          }
        }
        return await backends.probe(req.params.store, env, ctx.clientSignal(reply));
      } catch (e) {
        if (e instanceof BackendError && e.code === 'cancelled') return reply.code(499).send({ error: { code: 'cancelled' } });
        return fail(reply, e);
      }
    });
  });
}
