// API справочника: состояние, схема файла, чтение справочника проекта, правка записей, «Неизвестное»,
// загрузка и выгрузка файла.
// Все маршруты объявляют доступ: чтение — details, правка — по виду записи.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { can, type Capability } from '@threadline/core/access';
import { MAX_FILE_BYTES, UNKNOWN_PAGE, type CatalogErrorBody, type CatalogErrorExtra, type CatalogResponse, type UnknownKind, type UnknownPage } from '@threadline/core/catalog';
import { projectFileJsonSchema } from '@threadline/core/catalog/project-file';
import { BUILTIN_MASKING, maskDeep, maskKindsEnvelope, maskKindsText, maskText, MASK_KIND_CODES, type MaskKind } from '@threadline/core/search';
import { deny, isBusiness, roleOf } from '../auth/access.ts';
import { presentCatalogState } from '../auth/present.ts';
import { DbError, isBusyError, isConnectionError } from './db.ts';
import { CatalogHttpError, removeForever, removeRow, routeKind, saveMasking, saveRow, type CatalogErrorCode, type EntityKind } from './edit.ts';
import { emptyReport, ExportBlocked, exportCatalogText, FileVersionConflict, importCatalog, parseCatalogText, type FileFormat } from './exchange.ts';
import { FILE_VERSION, readFileVersion, type ProjectFileContext } from '../projects/file.ts';
import { CatalogBusy, CatalogUnavailable, type CatalogService } from './service.ts';
import * as store from './store.ts';

const NO_KEEP: ReadonlySet<string> = new Set();
const EDIT_BODY_LIMIT = 64 * 1024;
const UNKNOWN_KINDS = new Set<UnknownKind>(['method', 'host', 'error']);

/** Что маршрутам файла проекта нужно от проектов: контекст раздела settings и хвост записи. */
export interface CatalogProjects {
  fileContext(): ProjectFileContext;
  afterCommit(): Promise<void>;
}

export interface CatalogRoutesContext {
  service: CatalogService;
  projects: CatalogProjects;
  /** Версия проектов из базы: вкладки сравнивают её в ответе, своего опроса нет. Без базы постоянна. */
  projectsVersion?: () => number;
}

/** Право на правку записи: ошибки правит поддержка, всё остальное разработчик и старше. */
const sectionCapability = (section: string): Capability => (section === 'errors' ? 'editErrors' : 'editCatalog');

/** Право правки по адресу. Вид строки «Неизвестного» известен только после чтения базы: здесь наименьшее право, остальное проверяет маршрут. */
export function canEditCatalog(req: FastifyRequest): Capability {
  const { section } = req.params as { section: string };
  if (req.method === 'DELETE' && (req.query as { permanent?: string }).permanent === '1') return 'deleteForever';
  return section === 'unknown' ? 'editErrors' : sectionCapability(section);
}

interface ProjectParams {
  project: string;
}

function send(reply: FastifyReply, status: number, code: CatalogErrorCode, extra: CatalogErrorExtra = {}): FastifyReply {
  const body: CatalogErrorBody = { error: { code, ...extra } };
  return reply.code(status).send(body);
}

/** Всё, что уходит из API справочника: оба прохода маски, какое бы значение ни имел переключатель. */
const masked = <T>(v: T, strict = BUILTIN_MASKING.strict): T => maskKindsEnvelope(maskDeep(v, NO_KEEP), strict, NO_KEEP);

/** Ошибки правки → ответ: свои коды, база недоступна — 503, прочее пробрасывается. */
function failCatalog(reply: FastifyReply, e: unknown): FastifyReply {
  if (e instanceof CatalogHttpError) return send(reply, e.status, e.code, masked(e.extra));
  // Версия не проходит через маску: клиент сравнивает её на равенство.
  if (e instanceof FileVersionConflict) return send(reply, 409, 'project-file-conflict', { version: e.version });
  // Занято: тот же ответ 503, пояснение для API. Интерфейс показывает «недоступен, повторите позже».
  if (e instanceof CatalogBusy || isBusyError(e)) return send(reply, 503, 'catalog-unavailable', { details: new CatalogBusy().message });
  if (e instanceof CatalogUnavailable || (e instanceof DbError && isConnectionError(e))) return send(reply, 503, 'catalog-unavailable');
  if (e instanceof ExportBlocked) {
    return send(reply, 422, 'catalog-invalid', { fields: Object.fromEntries(e.issues.map((i) => [maskKindsText(maskText(i.path, NO_KEEP), BUILTIN_MASKING.strict, NO_KEEP), i.message])) });
  }
  throw e;
}

const positiveId = (v: string): number | null => (/^\d{1,15}$/.test(v) && Number(v) > 0 ? Number(v) : null);

export function registerCatalogRoutes(app: FastifyInstance, ctx: CatalogRoutesContext): void {
  const { service } = ctx;

  /** Проект и включённый справочник; иначе ответ уже отправлен. */
  const check = (project: string, reply: FastifyReply): boolean => {
    if (!service.enabled) {
      void send(reply, 404, 'catalog-off');
      return false;
    }
    if (!service.project(project)) {
      void send(reply, 404, 'project-unknown');
      return false;
    }
    return true;
  };

  /** Счётчик для значка: своя база, хранилище логов не читается. Сбой убирает поле и не роняет опрос: от него зависят полоса состояния и сброс показа. Бизнесу база не читается. */
  const unknownOpen = async (req: FastifyRequest): Promise<{ unknownOpen?: Record<string, number> }> => {
    const db = service.state().state === 'ok' && !isBusiness(req) ? service.readDb() : null;
    if (!db) return {};
    try {
      return { unknownOpen: await store.openUnknownCounts(db) };
    } catch {
      return {};
    }
  };

  // Отпечатки добавляет маршрут: форма service.state() остаётся прежней.
  app.get('/api/catalog', { config: { access: 'view' } }, async (req) => presentCatalogState(req, { ...service.state(), masking: service.maskingStamps(), ...(ctx.projectsVersion ? { projectsVersion: ctx.projectsVersion() } : {}), ...(await unknownOpen(req)) }));

  app.get('/api/catalog/schema', { config: { access: 'details' } }, async (_req, reply) => reply.type('application/schema+json; charset=utf-8').send(projectFileJsonSchema()));

  // Без опроса: поддержке и при возврате на вкладку, чтобы не гонять весь файл ради сравнения.
  app.get<{ Params: ProjectParams }>('/api/projects/:project/file-version', { config: { access: 'details' } }, async (req, reply) => {
    if (!check(req.params.project, reply)) return reply;
    const db = service.readDb();
    if (!db) return send(reply, 503, 'catalog-unavailable');
    try {
      return { version: await readFileVersion(db, req.params.project) };
    } catch (e) {
      return failCatalog(reply, e);
    }
  });

  app.get<{ Params: ProjectParams }>('/api/projects/:project/catalog', { config: { access: 'details' } }, async (req, reply) => {
    if (!check(req.params.project, reply)) return reply;
    const s = service.snapshot(req.params.project);
    if (!s) return send(reply, 503, 'catalog-unavailable');
    const st = service.state();
    return {
      ...masked<CatalogResponse>(
        {
          version: s.version,
          state: st.state,
          loadedAt: st.loadedAt,
          idTypes: s.idTypes,
          systems: s.systems,
          methods: s.methods,
          errors: s.errors,
          outcomeRules: s.outcomeRules,
        },
        service.masking(req.params.project).strict,
      ),
      // Имена полей, а не значения: маска к ним не относится.
      masking: s.masking ?? [],
    };
  });

  app.get<{ Params: ProjectParams & { section: string; id: string } }>('/api/projects/:project/catalog/:section/:id/dependents', { config: { access: 'details' } }, async (req, reply) => {
    if (!check(req.params.project, reply)) return reply;
    const kind = routeKind(req.params.section);
    const id = positiveId(req.params.id);
    if ((kind !== 'system' && kind !== 'method') || id === null) return send(reply, 404, 'catalog-not-found');
    const db = service.readDb();
    if (!db) return send(reply, 503, 'catalog-unavailable');
    try {
      if (!(await store.getRow(db, kind, req.params.project, id))) return send(reply, 404, 'catalog-not-found');
      return masked(await store.dependents(db, kind, req.params.project, id));
    } catch (e) {
      return failCatalog(reply, e);
    }
  });

  app.get<{ Params: ProjectParams; Querystring: { format?: string } }>('/api/projects/:project/catalog/export', { config: { access: 'details' } }, async (req, reply) => {
    if (!check(req.params.project, reply)) return reply;
    const format: FileFormat = req.query.format === 'json' ? 'json' : 'yaml';
    if (req.query.format !== undefined && req.query.format !== 'json' && req.query.format !== 'yaml') {
      return send(reply, 400, 'bad-request', { details: 'format: yaml или json' });
    }
    const db = service.readDb();
    if (!db) return send(reply, 503, 'catalog-unavailable');
    try {
      // Версия раньше данных: текст не старше своей версии, этот порядок менять нельзя.
      const version = await readFileVersion(db, req.params.project);
      const text = await exportCatalogText(db, req.params.project, format);
      return reply
        .header('Content-Disposition', `attachment; filename="${req.params.project}-project.${format === 'json' ? 'json' : 'yaml'}"`)
        .header('X-Project-File-Version', version)
        .type(format === 'json' ? 'application/json; charset=utf-8' : 'application/yaml; charset=utf-8')
        .send(text);
    } catch (e) {
      return failCatalog(reply, e);
    }
  });

  app.get<{ Params: ProjectParams; Querystring: { kind?: string; env?: string; hidden?: string; offset?: string } }>(
    '/api/projects/:project/catalog/unknown',
    { config: { access: 'details' } },
    async (req, reply) => {
      if (!check(req.params.project, reply)) return reply;
      const { kind, env, hidden, offset } = req.query;
      if (kind !== undefined && !UNKNOWN_KINDS.has(kind as UnknownKind)) return send(reply, 400, 'bad-request', { details: 'kind: method, host или error' });
      if (env !== undefined && !/^[a-z0-9][a-z0-9-]{0,31}$/.test(env)) return send(reply, 400, 'bad-request', { details: 'неверный идентификатор среды' });
      const off = offset === undefined ? 0 : /^\d{1,6}$/.test(offset) ? Number(offset) : -1;
      if (off < 0) return send(reply, 400, 'bad-request', { details: 'offset: целое число от 0' });
      const db = service.readDb();
      if (!db) return send(reply, 503, 'catalog-unavailable');
      try {
        const page = await store.listUnknown(db, req.params.project, {
          kind: kind as UnknownKind | undefined,
          env,
          hidden: hidden === '1' || hidden === 'true',
          offset: off,
          limit: UNKNOWN_PAGE,
        });
        return masked<UnknownPage>({ items: page.rows, total: page.total, offset: off, limit: UNKNOWN_PAGE }, service.masking(req.params.project).strict);
      } catch (e) {
        return failCatalog(reply, e);
      }
    },
  );

  // ---------- Правка: один префикс ----------

  void app.register(async (edit) => {
    edit.setErrorHandler((err: { code?: string; statusCode?: number }, _req, reply) => {
      if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE') return send(reply, 413, 'catalog-file-too-large');
      if (err.statusCode && err.statusCode < 500) return send(reply, err.statusCode, 'bad-request', { details: 'тело запроса не разобрано' });
      throw err;
    });

    edit.post<{ Params: ProjectParams & { section: string } }>('/api/projects/:project/catalog/:section', { bodyLimit: EDIT_BODY_LIMIT, config: { access: canEditCatalog } }, async (req, reply) => {
      if (!check(req.params.project, reply)) return reply;
      const kind: EntityKind | undefined = routeKind(req.params.section);
      if (!kind) return send(reply, 404, 'catalog-not-found');
      try {
        const id = await service.edit(req.params.project, (q) => saveRow(q, req.params.project, kind, req.body, null));
        return reply.code(201).send(masked(await store.getRow(service.db(), kind, req.params.project, id), service.masking(req.params.project).strict));
      } catch (e) {
        return failCatalog(reply, e);
      }
    });

    // Статический сегмент выше /:section/:id. POST и DELETE на раздел дают 404: routeKind('masking') пуст.
    edit.put<{ Params: ProjectParams & { type: string } }>('/api/projects/:project/catalog/masking/:type', { bodyLimit: EDIT_BODY_LIMIT, config: { access: 'editMasking' } }, async (req, reply) => {
      if (!check(req.params.project, reply)) return reply;
      const { project, type } = req.params;
      if (!(MASK_KIND_CODES as readonly string[]).includes(type)) return send(reply, 404, 'catalog-not-found');
      try {
        return await service.edit(project, (q) => saveMasking(q, project, type as MaskKind, req.body));
      } catch (e) {
        return failCatalog(reply, e);
      }
    });

    edit.put<{ Params: ProjectParams & { section: string; id: string } }>('/api/projects/:project/catalog/:section/:id', { bodyLimit: EDIT_BODY_LIMIT, config: { access: canEditCatalog } }, async (req, reply) => {
      if (!check(req.params.project, reply)) return reply;
      const { project, section } = req.params;
      const id = positiveId(req.params.id);
      if (section === 'unknown') {
        if (id === null) return send(reply, 404, 'catalog-not-found');
        const body = req.body as { hidden?: unknown } | null;
        if (!body || typeof body.hidden !== 'boolean') return send(reply, 422, 'catalog-invalid', { fields: { hidden: 'нужно true или false' } });
        const db = service.readDb();
        if (!db) return send(reply, 503, 'catalog-unavailable');
        try {
          // Поддержка скрывает только строки вида «ошибка»: вид строки есть только в базе.
          const kind = await store.unknownKind(db, project, id);
          if (kind === null) return send(reply, 404, 'catalog-not-found');
          if (!can(roleOf(req), kind === 'error' ? 'editErrors' : 'editCatalog')) return deny(reply, 403, 'forbidden');
          const row = await store.setUnknownHidden(db, project, id, body.hidden);
          return row ? masked(row, service.masking(project).strict) : send(reply, 404, 'catalog-not-found');
        } catch (e) {
          return failCatalog(reply, e);
        }
      }
      const kind: EntityKind | undefined = routeKind(section);
      if (!kind || id === null) return send(reply, 404, 'catalog-not-found');
      try {
        await service.edit(project, (q) => saveRow(q, project, kind, req.body, id));
        return masked(await store.getRow(service.db(), kind, project, id), service.masking(project).strict);
      } catch (e) {
        return failCatalog(reply, e);
      }
    });

    edit.delete<{ Params: ProjectParams & { section: string; id: string }; Querystring: { updatedAt?: string; permanent?: string } }>(
      '/api/projects/:project/catalog/:section/:id',
      { config: { access: canEditCatalog } },
      async (req, reply) => {
        if (!check(req.params.project, reply)) return reply;
        const kind: EntityKind | undefined = routeKind(req.params.section);
        const id = positiveId(req.params.id);
        if (!kind || id === null) return send(reply, 404, 'catalog-not-found');
        try {
          const remove = req.query.permanent === '1' ? removeForever : removeRow;
          return await service.edit(req.params.project, (q) => remove(q, req.params.project, kind, id, req.query.updatedAt));
        } catch (e) {
          return failCatalog(reply, e);
        }
      },
    );

    // Загрузка файла: тело — текст YAML или JSON до 2 МБ, разбирается здесь, а не парсером Fastify.
    void edit.register(async (file) => {
      file.removeAllContentTypeParsers();
      file.addContentTypeParser('*', { parseAs: 'string', bodyLimit: MAX_FILE_BYTES + 1024 }, (_req, body, done) => done(null, body));
      file.post<{ Params: ProjectParams; Querystring: { dryRun?: string; force?: string; format?: string; baseVersion?: string } }>(
        '/api/projects/:project/catalog/import',
        { bodyLimit: MAX_FILE_BYTES + 1024, config: { access: 'importCatalog' } },
        async (req, reply) => {
          if (!check(req.params.project, reply)) return reply;
          const flag = (v: string | undefined) => v === '1' || v === 'true';
          const dryRun = flag(req.query.dryRun);
          const force = flag(req.query.force);
          const project = service.project(req.params.project)!;
          // Применение без сверки обойти нельзя. В режиме проверки параметр не читается: отчёт по текущему состоянию.
          const baseVersion = req.query.baseVersion;
          if (!dryRun) {
            if (baseVersion === undefined) return send(reply, 400, 'bad-request', { details: 'нужен параметр baseVersion: версию файла дают выгрузка (заголовок X-Project-File-Version) и проверка (поле version отчёта)' });
            if (!FILE_VERSION.test(baseVersion)) return send(reply, 400, 'bad-request', { details: 'baseVersion: это не версия файла проекта' });
          }
          const text = typeof req.body === 'string' ? req.body : '';
          const ct = String(req.headers['content-type'] ?? '');
          const format: FileFormat | undefined = req.query.format === 'json' || ct.includes('json') ? 'json' : req.query.format === 'yaml' || ct.includes('yaml') ? 'yaml' : undefined;
          const parsed = parseCatalogText(text, format);
          if (!parsed.ok) {
            if (parsed.tooLarge) return send(reply, 413, 'catalog-file-too-large');
            return send(reply, 422, 'catalog-invalid-file', { report: masked(emptyReport(project.id, dryRun, parsed.errors)) });
          }
          try {
            const db = dryRun ? service.readDb() : service.db();
            if (!db) return send(reply, 503, 'catalog-unavailable');
            const role = roleOf(req);
            const report = await importCatalog(db, project.id, project.name, parsed.value, {
              dryRun,
              force,
              allowMasking: can(role, 'editMasking'),
              allowSettings: can(role, 'editProjects'),
              settings: ctx.projects.fileContext(),
              warnings: parsed.warnings,
              ...(dryRun ? {} : { baseVersion: baseVersion! }),
            });
            // Версия не проходит через маску: клиент сравнивает её на равенство.
            const version = report.version !== undefined ? { version: report.version } : {};
            if (report.errors.length > 0) return send(reply, 422, 'catalog-invalid-file', { report: { ...masked(report, service.masking(project.id).strict), ...version } });
            if (report.applied) {
              if ([...report.added, ...report.changed].some((i) => i.kind === 'settings' || i.kind === 'environment' || i.kind === 'view')) await ctx.projects.afterCommit();
              await service.afterChange(project.id);
            }
            return { ...masked(report, service.masking(project.id).strict), ...version };
          } catch (e) {
            return failCatalog(reply, e);
          }
        },
      );
    });
  });
}
