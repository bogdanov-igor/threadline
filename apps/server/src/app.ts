// HTTP-сервер Threadline: API и раздача собранного интерфейса.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Writable } from 'node:stream';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import type { ConnectionResponse, ApiErrorBody, ProjectInfo, ProjectsResponse, StandResponse, StandsResponse } from '@threadline/core';
import { BackendError } from '@threadline/core/backend';
import { STAND_NUMBER, type EnvironmentConfig } from '@threadline/core/config';
import { DEFAULT_REGIONAL, regional, setRegional } from '@threadline/core/search';
import { DEFAULT_VIEW } from '@threadline/core/view';
import { isBusiness, registerAccess, type RouteEntry, type ViewerSource } from './auth/access.ts';
import { presentConnection, presentProjects } from './auth/present.ts';
import { installSession, registerAuth } from './auth/routes.ts';
import { missingSecret, type AuthSecrets, type ResolvedConfig } from './config/load.ts';
import { safeText, type Backends } from './backends/registry.ts';
import { readBuildInfo } from './build-info.ts';
import { SearchJobs } from './search/jobs.ts';
import { MemoryBudget } from './search/memory.ts';
import { compileProjectProfiles } from './search/profiles.ts';
import { registerSearchRoutes, type EnvLookup, type EnvParams, type ErrorCode, type ErrorExtra } from './search/routes.ts';
import { ownSecrets } from './search/own-secrets.ts';
import { registerLocalRoutes } from './local/routes.ts';
import type { LocalStorages } from './local/storages.ts';
import type { OperationCatalog } from './operation/job.ts';
import { registerOperationRoutes } from './operation/routes.ts';
import { UnknownCollector } from './catalog/collector.ts';
import type { UnknownErrorNotifier } from './catalog/notifier.ts';
import { CatalogHook } from './catalog/hook.ts';
import { registerCatalogRoutes } from './catalog/routes.ts';
import { createCatalogService, type CatalogService } from './catalog/service.ts';
import { registerProjectRoutes } from './projects/routes.ts';
import { ProjectsService } from './projects/service.ts';
import { registerSettingsRoutes } from './settings/routes.ts';
import { SettingsService } from './settings/service.ts';
import { SharePool } from './share/pool.ts';
import { registerShareRoutes } from './share/routes.ts';
import { startShareSweep, sweepExpired } from './share/sweep.ts';
import { databaseCheck, Health, registerHealthRoutes } from './health.ts';
import { createLogController, loggerOptions, requestId } from './logging.ts';
import { Metrics } from './metrics.ts';
import { registerReportRoutes } from './notifications/report.ts';
import { UnknownErrorNotices } from './notifications/unknown-errors.ts';
import type { MessageSender } from './notifications/telegram.ts';

export interface AppOptions {
  config: ResolvedConfig;
  backends: Backends;
  webDist?: string | undefined;
  logger?: boolean | { stream: Writable };
  /** Часы сервера; для тестов. */
  now?: () => number;
  /** Задания поиска; для тестов. По умолчанию свои, закрываются вместе с сервером. */
  jobs?: SearchJobs;
  /** Адрес базы справочника (THREADLINE_DATABASE_URL). Без него справочник выключен. */
  databaseUrl?: string | undefined;
  /** Для тестов: свой сервис справочника, его запуск и закрытие — на тесте. */
  catalog?: CatalogService;
  /** Для тестов: свой сбор «Неизвестного». */
  collector?: UnknownCollector;
  /** Для тестов: справочник поиска операции; по умолчанию — сервис справочника. */
  operationCatalog?: OperationCatalog;
  /** Для тестов: сервис проектов, чтобы подключить его к базе теста. */
  onProjects?: (service: ProjectsService) => void;
  /** Для тестов: справочник, созданный сервером, и пул коротких ссылок. */
  onCatalog?: (catalog: CatalogService, pool: SharePool) => void;
  /** Секреты входа из окружения: обязательны при включённом входе. */
  authSecrets?: AuthSecrets | undefined;
  /** Для тестов: кто делает запрос, минуя вход. Таблица доступа при этом та же. */
  testViewer?: ViewerSource;
  /** Для тестов: своё уведомление о новой неизвестной ошибке. По умолчанию запись журнала и Telegram. */
  unknownNotifier?: UnknownErrorNotifier;
  /** Куда уходят «Сообщить о проблеме» и оповещения о новых ошибках. Без него форма показывает контакт поддержки, оповещения остаются в журнале. */
  telegram?: MessageSender | null;
  /** Для тестов: сюда записываются все маршруты с объявленным доступом. */
  routeList?: RouteEntry[];
  /** Для тестов: таймаут ответа провайдера входа, секунд. */
  authTimeoutSeconds?: number;
  /** Готовность: запуск сервера снимает её при остановке. По умолчанию своя. */
  health?: Health;
  /** Метрики. По умолчанию свои, у каждого приложения свой реестр. */
  metrics?: Metrics;
  /** Бюджет памяти под результаты. По умолчанию свой: треть предела кучи. Своим заданиям из jobs тест ставит его сам. */
  memory?: MemoryBudget;
  /** Локальный режим (cli/local.ts): вход выключен, хранилища подключаются из интерфейса и лежат в storages.json каталога данных. */
  local?: { storages: LocalStorages };
}

interface ErrorBody {
  error: { code: ErrorCode; details?: string; retryAfterSeconds?: number };
}

const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

// Логотип, открытый прямо во вкладке: SVG не исполняет скрипты и не грузит внешнее.
const LOGO_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

const STATUS_BY_CODE: Partial<Record<ErrorCode, number>> = {
  'bad-request': 400,
  'not-pr-stands': 400,
  'invalid-terms': 400,
  'invalid-period': 400,
  'search-expired': 404,
  'request-not-found': 404,
  'unknown-environment': 404,
  'not-configured': 409,
  busy: 503,
  overloaded: 503,
  timeout: 504,
  cancelled: 499,
  // Поиск операции.
  'invalid-operation': 400,
  'operation-expired': 410,
  'operation-supplemented': 409,
  // Короткие ссылки.
  'share-not-found': 404,
  'share-project-hidden': 409,
  'share-outdated': 410,
  'share-unavailable': 503,
  'logs-gone': 410,
  // «Сообщить о проблеме».
  'report-not-configured': 503,
  'report-failed': 502,
  'report-rate-limited': 429,
};

/** Поле logo для списка проектов: адреса с хешем файла и пропорция, путей на диске нет. Без тёмной версии адреса совпадают. */
function projectLogoInfo(config: ResolvedConfig, project: string): Pick<ProjectInfo, 'logo'> {
  const logo = config.logos?.get(project);
  if (!logo) return {};
  const url = (theme: 'light' | 'dark') => `/api/projects/${encodeURIComponent(project)}/logo/${theme}?v=${logo[theme].hash}`;
  return { logo: { light: url('light'), dark: logo.dark === logo.light ? url('light') : url('dark'), ratio: logo.ratio } };
}

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const logger = opts.logger === undefined || opts.logger === false ? false : loggerOptions(opts.logger === true ? undefined : opts.logger.stream);
  const { config, backends } = opts;
  // Региональные правила маски и поиска — на весь процесс: один файл настроек на сервер.
  setRegional(config.config.regional);
  const authSettings = config.config.auth;
  const ownValues = ownSecrets(config);
  // Набор секретов у хранилищ: в локальном режиме он растёт без перезапуска.
  const scrubOwn = (s: string) => backends.scrubOwn(s);
  const safe = (s: string) => safeText(scrubOwn(s));
  if (opts.local && authSettings !== 'off') throw new Error('локальный режим только без входа');
  // correlation_id в адресе — до 128 символов, по умолчанию Fastify пропускает только 100.
  // trustProxy только для https за обратным прокси: @fastify/session ставит Secure-cookie лишь при протоколе https в запросе.
  // Адреса из запроса сервер не читает: адрес сервиса задан в publicUrl, подделанный заголовок ничего не даёт.
  const app = Fastify({ logger, logController: createLogController(), genReqId: requestId, trustProxy: authSettings !== 'off' && authSettings.publicUrl.startsWith('https:'), routerOptions: { maxParamLength: 512 } });
  const now = opts.now ?? Date.now;
  const health = opts.health ?? new Health();
  const metrics = opts.metrics ?? new Metrics();
  metrics.install(app);
  // Порядок важен: сессия раньше таблицы доступа, таблица раньше всех маршрутов, иначе её onRoute их не увидит.
  const authOptions = { settings: authSettings, secrets: opts.authSecrets, ca: config.authCa, now, health, publicEggs: config.config.extras?.publicEggs ?? true, local: !!opts.local, ...(opts.authTimeoutSeconds ? { timeoutSeconds: opts.authTimeoutSeconds } : {}) };
  await installSession(app, authOptions);
  let viewerSource: ViewerSource = () => null;
  registerAccess(app, (req, reply) => viewerSource(req, reply), { routes: opts.routeList, publicUrl: authSettings === 'off' ? null : authSettings.publicUrl });
  const fromLogin = registerAuth(app, authOptions);
  viewerSource = opts.testViewer ?? fromLogin;
  // Один бюджет памяти на оба пула: результаты вошедших и задания ссылок.
  const memory = opts.memory ?? new MemoryBudget();
  metrics.watchMemory(memory);
  const jobs = opts.jobs ?? new SearchJobs({ now, memory });
  if (!opts.jobs) app.addHook('onClose', async () => jobs.close());
  // Задания ссылок живут отдельно: не вытесняют и не видят задания вошедших.
  const sharePool = new SharePool({ now, metrics, memory });
  app.addHook('onClose', async () => sharePool.close());

  app.addHook('onSend', async (req, reply) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
      // Своя политика маршрута логотипа остаётся, остальные общие заголовки ставятся всегда.
      if (k === 'Content-Security-Policy' && reply.hasHeader(k)) continue;
      reply.header(k, v);
    }
    // Ответы с данными логов браузер не кэширует: при выключенном виде открытые значения идут и обычным ответом.
    if (req.url.startsWith('/api/') && !reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'no-store');
  });

  // Текст ошибки не пишется в журнал и не уходит в браузер: в нём может быть тело запроса со значениями
  // поиска или строка лога. В журнал — тип, код и место.
  app.setErrorHandler((err: { name?: string; code?: string; statusCode?: number; stack?: string }, req, reply) => {
    const status = typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
    const where = err.stack?.split('\n').slice(1, 6).join('\n');
    req.log[status >= 500 ? 'error' : 'info']({ name: err.name, code: err.code, status, where }, 'запрос завершился ошибкой');
    const body: ErrorBody = { error: { code: status >= 500 ? 'unknown' : 'bad-request' } };
    return reply.code(status).send(body);
  });

  const fail = (reply: FastifyReply, code: ErrorCode, extra: ErrorExtra = {}): FastifyReply => {
    const body: ErrorBody = { error: { code } };
    // Текст ошибки хранилища может повторять запрос или строку лога: маскируется, как и данные. Бизнесу только код и время повтора.
    if (extra.details && !isBusiness(reply.request)) body.error.details = safe(extra.details);
    if (extra.retryAfterSeconds !== undefined) {
      body.error.retryAfterSeconds = extra.retryAfterSeconds;
      reply.header('Retry-After', String(extra.retryAfterSeconds));
    }
    return reply.code(STATUS_BY_CODE[code] ?? 502).send(body);
  };

  const failBackend = (reply: FastifyReply, e: unknown): FastifyReply => {
    if (e instanceof BackendError) return fail(reply, e.code, { details: e.details, retryAfterSeconds: e.retryAfterSeconds });
    throw e;
  };

  /** Сигнал отмены: срабатывает, если клиент закрыл соединение раньше ответа. */
  const clientSignal = (reply: FastifyReply) => {
    const ac = new AbortController();
    reply.raw.on('close', () => {
      if (!reply.raw.writableFinished) ac.abort();
    });
    return ac.signal;
  };

  const knownEnv = ({ project, env }: EnvParams, reply: FastifyReply): EnvironmentConfig | undefined => {
    if (!ID.test(project) || !ID.test(env)) {
      void fail(reply, 'bad-request', { details: 'неверный идентификатор проекта или среды' });
      return undefined;
    }
    const found = backends.environment(project, env);
    if (!found) void fail(reply, 'unknown-environment');
    return found;
  };

  // Единая точка маршрутов среды: среда на убранном хранилище или вне границы в хранилище не ходит.
  const lookupEnv = (params: EnvParams): EnvLookup => {
    if (!ID.test(params.project) || !ID.test(params.env)) return { ok: false, code: 'bad-request', details: 'неверный идентификатор проекта или среды' };
    const found = backends.environment(params.project, params.env);
    if (!found) return { ok: false, code: 'unknown-environment' };
    const problem = projectsService.unusable(params.project, params.env);
    if (!problem) return { ok: true, env: found };
    return {
      ok: false,
      code: 'not-configured',
      details: problem.missingStore ? `хранилища «${problem.missingStore}» нет в файле настроек` : `условия среды вышли за границу хранилища «${problem.outOfScope}»: backends.${problem.outOfScope}.formScope`,
    };
  };

  const resolveEnv = (params: EnvParams, reply: FastifyReply): EnvironmentConfig | undefined => {
    const r = lookupEnv(params);
    if (r.ok) return r.env;
    void fail(reply, r.code, r.details ? { details: r.details } : {});
    return undefined;
  };

  const build = readBuildInfo();
  app.get('/api/health', { config: { access: 'public' } }, async () => ({ status: 'ok', ...build }));
  registerHealthRoutes(app, health);
  metrics.registerRoute(app);

  app.get('/api/projects', { config: { access: 'view' } }, async (req): Promise<ProjectsResponse> => presentProjects(req, {
    defaults: config.config.defaults,
    hidden: projectsService.hiddenList(),
    incomplete: projectsService.incomplete,
    // Без раздела regional поля нет: браузер берёт международные правила.
    ...(regional() === DEFAULT_REGIONAL ? {} : { regional: regional() }),
    projects: Object.entries(config.config.projects).map(([id, p]) => ({
      id,
      name: p.name,
      timezone: p.timezone,
      retentionDays: p.retentionDays,
      view: projectsService.viewOf(id) ?? DEFAULT_VIEW,
      ...projectLogoInfo(config, id),
      environments: Object.entries(p.environments).map(([eid, e]) => {
        const b = config.backends[e.backend];
        const missing = b && missingSecret(b);
        const problem = projectsService.unusable(id, eid);
        return {
          id: eid,
          name: e.name,
          kind: e.kind,
          ...(e.examples && e.examples.length > 0 ? { examples: e.examples } : {}),
          ...(b ? { backendType: b.type } : {}),
          notConfigured: !!missing || !!problem,
          ...(missing ? { missingEnv: missing } : {}),
          ...problem,
        };
      }),
    })),
  }));

  // Файлы прочитаны при старте: project и theme только ключи, диск и хранилище логов не трогаются. fail() дал бы здесь 502.
  app.get<{ Params: { project: string; theme: string }; Querystring: { v?: string } }>('/api/projects/:project/logo/:theme', { config: { access: 'public' } }, async (req, reply) => {
    const logo = config.logos?.get(req.params.project);
    const file = req.params.theme === 'light' ? logo?.light : req.params.theme === 'dark' ? logo?.dark : undefined;
    if (!file) return reply.code(404).send({ error: { code: 'bad-request', details: 'логотипа нет' } } satisfies ApiErrorBody);
    return reply
      .header('Cache-Control', req.query.v === file.hash ? 'public, max-age=31536000, immutable' : 'no-cache')
      .header('Content-Security-Policy', LOGO_CSP)
      .type(file.type)
      .send(file.body);
  });

  app.get<{ Params: EnvParams; Querystring: { refresh?: string } }>('/api/projects/:project/envs/:env/connection', { config: { access: 'view' } }, async (req, reply) => {
    const env = knownEnv(req.params, reply);
    if (!env) return reply;
    const problem = projectsService.unusable(req.params.project, req.params.env);
    if (problem) return presentConnection(req, { status: 'not-configured', checkedAt: new Date(now()).toISOString(), ...problem } satisfies ConnectionResponse);
    try {
      return presentConnection(req, await backends.connection(env, { refresh: req.query.refresh === '1', signal: clientSignal(reply) }));
    } catch (e) {
      return failBackend(reply, e);
    }
  });

  app.get<{ Params: EnvParams }>('/api/projects/:project/envs/:env/stands', { config: { access: 'view' } }, async (req, reply): Promise<StandsResponse | FastifyReply> => {
    const env = resolveEnv(req.params, reply);
    if (!env) return reply;
    if (env.kind !== 'pr-stands') return fail(reply, 'not-pr-stands');
    try {
      return { stands: await backends.stands(req.params.project, req.params.env, env, clientSignal(reply)) };
    } catch (e) {
      return failBackend(reply, e);
    }
  });

  app.get<{ Params: EnvParams & { stand: string } }>(
    '/api/projects/:project/envs/:env/stands/:stand',
    { config: { access: 'view' } },
    async (req, reply): Promise<StandResponse | FastifyReply> => {
      const env = resolveEnv(req.params, reply);
      if (!env) return reply;
      if (env.kind !== 'pr-stands') return fail(reply, 'not-pr-stands');
      if (!STAND_NUMBER.test(req.params.stand)) return fail(reply, 'bad-request', { details: 'номер стенда: от одной до шести цифр' });
      const stand = Number(req.params.stand);
      try {
        const live = await backends.stands(req.params.project, req.params.env, env, clientSignal(reply));
        return { stand, live: live.includes(stand) };
      } catch (e) {
        return failBackend(reply, e);
      }
    },
  );

  const profiles = compileProjectProfiles(config.config, (m) => app.log.warn(m), now);
  // Раньше справочника: сверка проектов с файлом идёт в его подключении. Без адреса базы — проекты из файла, правка закрыта.
  const projectsService = new ProjectsService({
    config,
    profiles,
    backends,
    now,
    log: { info: (m) => app.log.info(m), warn: (m) => app.log.warn(m) },
    effects: {
      dropScope: (project, env) => {
        jobs.dropScope(project, env);
        sharePool.dropScope(project, env);
      },
      forgetUnknown: (project) => collector.forget(project),
    },
  });
  // Справочник: подключение в фоне, сервер не ждёт базу. Без адреса — состояние off, ответы прежние.
  // Свой сервис теста остаётся с проектами из файла: подключить проекты к базе теста можно через onProjects.
  const catalog = opts.catalog ?? createCatalogService(config, opts.databaseUrl, { info: (m) => app.log.info(m), warn: (m) => app.log.warn(m) }, now, projectsService);
  if (!opts.catalog) projectsService.attach(catalog);
  health.add('database', databaseCheck(catalog));
  opts.onProjects?.(projectsService);
  opts.onCatalog?.(catalog, sharePool);
  const settingsService = new SettingsService(catalog);
  const sweepOptions = { readDb: () => catalog.readDb(), settings: settingsService, now, warn: (m: string) => app.log.warn(m) };
  catalog.onConnected(() => void sweepExpired(sweepOptions));
  const stopSweep = startShareSweep(sweepOptions);
  app.addHook('onClose', async () => stopSweep());
  const unknownNotices = new UnknownErrorNotices({
    log: app.log,
    sender: opts.telegram ?? null,
    // THREADLINE_PUBLIC_URL попадает сюда через настройку входа. При auth: off адреса нет: одна эта переменная без двух других сервер не запускает.
    publicUrl: authSettings === 'off' ? null : authSettings.publicUrl,
    mask: safe,
    names: (project, systemId, methodId) => {
      const resolver = catalog.resolver(project);
      return {
        system: systemId === null ? null : (resolver?.systems.get(systemId)?.name ?? null),
        method: methodId === null ? null : (resolver?.methods.get(methodId)?.name ?? null),
      };
    },
  });
  // Раньше сборщика: при закрытии он ещё успевает записать и сообщить о новых строках.
  app.addHook('onClose', async () => unknownNotices.close());
  const collector = opts.collector ?? new UnknownCollector(catalog, { now, demoInbox: process.env.THREADLINE_CATALOG_DEMO_INBOX === '1', warn: (m) => app.log.warn(m), notifier: opts.unknownNotifier ?? unknownNotices });
  // Хуки onClose идут в обратном порядке: сборщик закрывается первым и успевает записать накопленное, пока база открыта.
  if (!opts.catalog) {
    void catalog.start();
    app.addHook('onClose', async () => catalog.close());
  }
  if (!opts.collector) {
    collector.start();
    app.addHook('onClose', async () => collector.close());
  }
  registerCatalogRoutes(app, { service: catalog, projects: projectsService, ...(opts.catalog ? {} : { projectsVersion: () => projectsService.version }) });

  await registerProjectRoutes(app, { service: projectsService, backends, clientSignal });
  const catalogHook = catalog.enabled ? new CatalogHook(catalog, collector) : undefined;
  registerSearchRoutes(app, { config, metrics, profiles, backends, jobs, now, fail, failBackend, resolveEnv, lookupEnv, clientSignal, catalog: catalogHook, masking: (p) => catalog.masking(p), ownSecrets: ownValues, scrubOwn });
  registerOperationRoutes(app, { config, metrics, profiles, backends, jobs, now, fail, resolveEnv, catalog: opts.operationCatalog ?? catalog, catalogHook });
  registerSettingsRoutes(app, settingsService);
  registerShareRoutes(app, {
    config,
    profiles,
    backends,
    jobs,
    pool: sharePool,
    now,
    fail,
    resolveEnv,
    clientSignal,
    catalog,
    catalogHook,
    operationCatalog: opts.operationCatalog ?? catalog,
    masking: (p) => catalog.masking(p),
    projects: projectsService,
    settings: settingsService,
    logos: (p) => projectLogoInfo(config, p).logo,
  });
  registerReportRoutes(app, { sender: opts.telegram ?? null, now, fail, mask: safe });
  if (opts.local) {
    registerLocalRoutes(app, {
      storages: opts.local.storages,
      backends,
      config,
      clientSignal,
      now,
      usedBy: (store) => projectsService.settings().projects.flatMap((p) => p.environments.filter((e) => e.backend === store).map((e) => `${p.id}/${e.id}`)),
    });
  }

  const dist = opts.webDist;
  const hasWeb = !!dist && existsSync(join(dist, 'index.html'));
  if (hasWeb) {
    await app.register(fastifyStatic, {
      root: dist,
      index: false,
      wildcard: false,
      cacheControl: false,
      // С версии 10 сюда приходит ответ Fastify, а не ответ Node.
      setHeaders: (reply, path) => {
        void reply.header('Cache-Control', path.includes(`${join(dist, 'assets')}`) ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
    // Файлы интерфейса без сессии: данных в них нет, проверку входа выполняет уже загруженный интерфейс.
    app.get('/*', { config: { access: 'public' } }, async (req, reply) => {
      const path = req.url.split('?')[0]!;
      if (path.startsWith('/api/')) return reply.code(404).send({ error: { code: 'bad-request', details: 'нет такого метода API' } } satisfies ApiErrorBody);
      const file = path.slice(1);
      if (file && !file.includes('..') && existsSync(join(dist, file))) return reply.sendFile(file);
      return reply.header('Cache-Control', 'no-cache').type('text/html; charset=utf-8').sendFile('index.html');
    });
  }

  app.setNotFoundHandler((_req, reply) => {
    void reply.code(404).send({ error: { code: 'bad-request', details: 'нет такого метода API' } } satisfies ApiErrorBody);
  });

  return app;
}
