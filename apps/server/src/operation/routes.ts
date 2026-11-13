// API поиска операции: запуск и дополнение. Состояние, остановка и потоки — маршруты /api/searches/:id.

import type { FastifyInstance, FastifyReply } from 'fastify';
import { MAX_EPOCH_MS } from '@threadline/core';
import type { Matcher } from '@threadline/core/backend';
import { environmentSelector, selectorExclusions, type EnvironmentConfig, type SearchConfig } from '@threadline/core/config';
import { BUILTIN_FORMAT, BUILTIN_GET_FLAG, type CompiledProfile } from '@threadline/core/profile';
import type { OperationKeyValue, OperationWindowPreset } from '@threadline/core/flow';
import type { OperationRequestBody, OperationSupplementBody, SearchCreated } from '@threadline/core/search';
import { holderOf, ownerOf } from '../auth/access.ts';
import { missingSecret, type ResolvedConfig } from '../config/load.ts';
import type { Backends } from '../backends/registry.ts';
import { withQueryTrace } from '../backends/trace.ts';
import type { CatalogHook } from '../catalog/hook.ts';
import type { SearchJob, SearchSpec } from '../search/engine.ts';
import type { SearchJobs } from '../search/jobs.ts';
import type { EnvParams, ErrorCode, ErrorExtra, JobCreate } from '../search/routes.ts';
import { NO_CATALOG, OperationJob, type OperationCatalog, type OperationDeps, type OperationSpec } from './job.ts';
import { MAX_OP_VALUES, OP_TYPE, operationPattern, VALUE_ISSUE_TEXT, valueIssue, type SearchValue } from './values.ts';
import type { Metrics } from '../metrics.ts';

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const JOB_ID = /^[A-Za-z0-9-]{1,64}$/;
export const WINDOW_HALF: Record<'6h' | '24h', number> = { '6h': 3 * HOUR, '24h': 12 * HOUR };

export interface OperationRoutesContext {
  config: ResolvedConfig;
  metrics: Pick<Metrics, 'trackJob'>;
  profiles: ReadonlyMap<string, CompiledProfile>;
  backends: Backends;
  jobs: SearchJobs;
  now: () => number;
  fail: (reply: FastifyReply, code: ErrorCode, extra?: ErrorExtra) => FastifyReply;
  resolveEnv: (params: EnvParams, reply: FastifyReply) => EnvironmentConfig | undefined;
  catalog?: OperationCatalog;
  /** Разметка сводок и страниц потоков задания и сбор «Неизвестного». */
  catalogHook?: CatalogHook | undefined;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

type Parsed = { ok: true; body: OperationRequestBody } | { ok: false; code: 'bad-request' | 'invalid-operation'; details: string };

function parseValues(list: unknown, at: string): { ok: true; values: SearchValue[] } | { ok: false; code: 'bad-request' | 'invalid-operation'; details: string } {
  if (!Array.isArray(list)) return { ok: false, code: 'bad-request', details: `${at}: список { type, value }` };
  const out: SearchValue[] = [];
  for (const x of list) {
    if (!isObj(x) || typeof x.type !== 'string' || typeof x.value !== 'string') return { ok: false, code: 'bad-request', details: `${at}: список { type, value }` };
    if (!OP_TYPE.test(x.type)) return { ok: false, code: 'invalid-operation', details: 'тип id: строчные латинские буквы, цифры и «_»' };
    const issue = valueIssue(x.value);
    if (issue) return { ok: false, code: 'invalid-operation', details: VALUE_ISSUE_TEXT[issue] };
    out.push({ type: x.type, value: x.value });
  }
  return { ok: true, values: out };
}

/** Тело запуска: тип, 1–3 значения, момент открытого потока и окно. */
export function parseOperationBody(b: unknown): Parsed {
  if (!isObj(b)) return { ok: false, code: 'bad-request', details: 'тело запроса: нужен объект JSON' };
  const { stand, type, values, also, atMs, window, fresh } = b;
  if (typeof type !== 'string' || !OP_TYPE.test(type)) return { ok: false, code: 'invalid-operation', details: 'тип id: строчные латинские буквы, цифры и «_»' };
  if (!Array.isArray(values) || values.length === 0 || !values.every((v) => typeof v === 'string')) {
    return { ok: false, code: 'bad-request', details: 'values: список строк, от 1 до 3' };
  }
  const extra = also === undefined ? { ok: true as const, values: [] } : parseValues(also, 'also');
  if (!extra.ok) return extra;
  if (values.length + extra.values.length > MAX_OP_VALUES) return { ok: false, code: 'invalid-operation', details: 'не больше 3 значений id операции' };
  for (const v of values as string[]) {
    const issue = valueIssue(v);
    if (issue) return { ok: false, code: 'invalid-operation', details: VALUE_ISSUE_TEXT[issue] };
  }
  if (typeof atMs !== 'number' || !Number.isFinite(atMs) || atMs >= MAX_EPOCH_MS) return { ok: false, code: 'bad-request', details: 'atMs: момент открытого запроса, мс, год не позже 2099' };
  if (window !== '6h' && window !== '24h') return { ok: false, code: 'bad-request', details: 'window: 6h или 24h' };
  if (stand !== undefined && typeof stand !== 'string') return { ok: false, code: 'bad-request', details: 'stand: строка' };
  if (fresh !== undefined && typeof fresh !== 'boolean') return { ok: false, code: 'bad-request', details: 'fresh: true или false' };
  return {
    ok: true,
    body: {
      type,
      values: [...new Set(values as string[])],
      also: extra.values,
      atMs,
      window,
      ...(stand !== undefined ? { stand } : {}),
      ...(fresh !== undefined ? { fresh } : {}),
    },
  };
}

/** Окно ±3 ч или ±12 ч от момента потока, обрезанное сроком хранения и текущим временем. null — окно пустое. */
export function operationWindow(atMs: number, preset: '6h' | '24h', nowMs: number, retentionDays: number): { fromMs: number; toMs: number } | null {
  const half = WINDOW_HALF[preset];
  const fromMs = Math.max(atMs - half, nowMs - retentionDays * DAY);
  const toMs = Math.min(atMs + half, nowMs);
  return fromMs < toMs ? { fromMs, toMs } : null;
}

/** Ключ повтора: от момента потока и окна, без обрезки по now. */
export function operationKey(parts: { owner?: string; project: string; env: string; stand: string | undefined; type: string; values: readonly string[]; also: readonly SearchValue[]; atMs: number; window: string }): string {
  const values = [...parts.values].sort().join('\u0000');
  const also = parts.also.map((a) => `${a.type}:${a.value}`).sort().join('\u0000');
  return ['op', parts.owner ?? '', parts.project, parts.env, parts.stand ?? '', parts.type, values, also, String(parts.atMs), parts.window].join('|');
}

/** Значения операции и выражение поиска. null — короткий id, для которого у справочника нет поля. */
export function operationPlan(type: string, values: readonly string[], also: readonly SearchValue[], resolver: ReturnType<OperationCatalog['resolver']>): { searchable: SearchValue[]; pattern: string } | null {
  const all: SearchValue[] = [...values.map((value) => ({ type, value })), ...also];
  const { pattern, searchable } = operationPattern(all, resolver);
  return pattern === null ? null : { searchable, pattern };
}

export interface OperationStart {
  project: string;
  envId: string;
  env: EnvironmentConfig;
  selector: Matcher[];
  stand: string | undefined;
  type: string;
  values: string[];
  also: readonly SearchValue[];
  plan: { searchable: SearchValue[]; pattern: string };
  window: { fromMs: number; toMs: number; preset: OperationWindowPreset };
  profile: CompiledProfile;
  limits: SearchConfig;
  key: string;
  fresh: boolean;
  mock: boolean;
  owner?: string | undefined;
  /** Чьи это места пула (holderOf). Нет — места не считаются отдельно: пул ссылок. */
  holder?: string | undefined;
}

/** Запуск поиска операции: одна логика на маршрут операции и короткую ссылку. Разметку справочника привязывает вызывающий. */
export function startOperation(p: OperationStart, create: JobCreate, deps: OperationDeps): { job: SearchJob; cached: boolean } {
  const { searchable, pattern } = p.plan;
  const resolver = deps.catalog.resolver(p.project);
  const spec: SearchSpec = {
    project: p.project,
    envId: p.envId,
    env: p.env,
    selector: p.selector,
    stand: p.stand,
    terms: searchable.map((s) => ({ kind: 'text', value: s.value, display: s.value, filter: { kind: 'regex', pattern } })),
    period: { fromMs: p.window.fromMs, toMs: p.window.toMs, preset: null },
    profile: p.profile,
    limits: p.limits,
  };
  const op: OperationSpec = {
    project: p.project,
    key: { type: p.type, values: p.values, also: p.also.map((a) => ({ type: a.type, name: resolver?.idTypes.get(a.type)?.name ?? null, value: a.value })) },
    search: { values: searchable, pattern },
    window: p.window,
    excluded: selectorExclusions(p.selector),
    flagRegexp: p.profile.name === BUILTIN_FORMAT ? BUILTIN_GET_FLAG : null,
    envId: p.envId,
    stand: p.stand ?? null,
    mock: p.mock,
  };
  return create(p.key, p.fresh, (id) => new OperationJob(id, p.key, spec, op, deps), { project: p.project, env: p.envId, ...(p.owner !== undefined ? { owner: p.owner } : {}), ...(p.holder !== undefined ? { holder: p.holder } : {}) });
}

export function registerOperationRoutes(app: FastifyInstance, ctx: OperationRoutesContext): void {
  const { config, backends, jobs, fail } = ctx;
  const catalog = ctx.catalog ?? NO_CATALOG;
  const limits = config.config.search;
  const deps: OperationDeps = { backends, now: ctx.now, warn: (m) => app.log.warn(m), catalog };
  /** Живые задания по ключу: повторный запуск подключается к идущему поиску. */
  const live = new Map<string, string>();
  /** Дополнения по ключу операции и значениям: новая вкладка получает готовое на весь срок жизни задания. */
  const supplements = new Map<string, string>();
  const usable = (job: { status: string; error: unknown }) => job.status === 'running' || (job.status === 'done' && !job.error);

  const profileOf = (project: string): CompiledProfile => {
    const p = ctx.profiles.get(project);
    if (!p) throw new Error(`нет профиля формата у проекта ${project}`);
    return p;
  };

  app.post<{ Params: EnvParams }>('/api/projects/:project/envs/:env/operations', { config: { access: 'view' } }, async (req, reply) => {
    const env = ctx.resolveEnv(req.params, reply);
    if (!env) return reply;
    const project = config.config.projects[req.params.project]!;
    const parsed = parseOperationBody(req.body);
    if (!parsed.ok) return fail(reply, parsed.code, { details: parsed.details });
    const body = parsed.body;
    const window = operationWindow(body.atMs, body.window, ctx.now(), project.retentionDays);
    // Окно старше срока хранения: записей уже нет, в хранилище не ходим.
    if (!window) return fail(reply, 'operation-expired', { details: 'записи этого времени уже удалены из хранилища' });
    if (env.kind !== 'pr-stands' && body.stand !== undefined) return fail(reply, 'bad-request', { details: 'у среды нет стендов' });
    // Поиск операции не применяет исключений только для обычного поиска (searchOnly): на тесте и стендах — кроны.
    const selector = environmentSelector(env, body.stand, { operation: true });
    if (!selector.ok) return fail(reply, 'bad-request', { details: selector.reason });
    const missing = missingSecret(backends.slotFor(env).cfg);
    if (missing) return fail(reply, 'not-configured', { details: `не задана переменная окружения ${missing}` });

    const also = body.also ?? [];
    const plan = operationPlan(body.type, body.values, also, catalog.resolver(req.params.project));
    if (plan === null) {
      return fail(reply, 'invalid-operation', { details: 'короткий id ищется только по полю, где справочник ждёт этот тип; такого поля в справочнике нет' });
    }
    const stand = body.stand === undefined ? undefined : String(Number(body.stand));
    const owner = ownerOf(req);
    const key = operationKey({ owner, project: req.params.project, env: req.params.env, stand, type: body.type, values: body.values, also, atMs: body.atMs, window: body.window });
    if (body.fresh !== true) {
      const id = live.get(key);
      const running = id ? jobs.get(id, { owner }) : undefined;
      if (running && running.status === 'running' && running.key === key) return { id: running.id, cached: true } satisfies SearchCreated;
    }
    const mock = backends.slotFor(env).cfg.type === 'mock';
    const { job, cached } = startOperation(
      { project: req.params.project, envId: req.params.env, env, selector: selector.selector, stand, type: body.type, values: body.values, also, plan, window: { ...window, preset: body.window }, profile: profileOf(req.params.project), limits, key, fresh: body.fresh === true, mock, owner, holder: holderOf(req) },
      (k, fresh, make, scope) => jobs.create(k, fresh, make, scope),
      deps,
    );
    ctx.catalogHook?.bind(job, req.params.project, req.params.env, mock, stand ?? null);
    // Задание операции подпись журнала не ставит само: её ставит запуск.
    if (!cached) void withQueryTrace(job.trace, () => ctx.metrics.trackJob('operation', job));
    live.set(key, job.id);
    return { id: job.id, cached } satisfies SearchCreated;
  });

  app.post<{ Params: { id: string } }>('/api/searches/:id/supplement', { config: { access: 'view' } }, async (req, reply) => {
    const owner = ownerOf(req);
    const parent = JOB_ID.test(req.params.id) ? jobs.get(req.params.id, { owner }) : undefined;
    if (!parent) return fail(reply, 'search-expired');
    if (!(parent instanceof OperationJob)) return fail(reply, 'bad-request', { details: 'дополнение бывает только у поиска операции' });
    const b = req.body as OperationSupplementBody | undefined;
    const parsed = parseValues(isObj(b) ? b.values : undefined, 'values');
    if (!parsed.ok) return fail(reply, parsed.code, { details: parsed.details });
    const op = parent.operation;
    const known = new Set([...op.key.values.map((v) => `${op.key.type}:${v}`), ...op.key.also.map((a) => `${a.type}:${a.value}`)]);
    const fresh = parsed.values.filter((v) => !known.has(`${v.type}:${v.value}`));
    if (fresh.length === 0) return fail(reply, 'bad-request', { details: 'новых значений нет' });
    if (known.size + fresh.length > MAX_OP_VALUES) return fail(reply, 'invalid-operation', { details: 'не больше 3 значений id операции' });
    const key = `${parent.key}|+${fresh.map((f) => `${f.type}:${f.value}`).sort().join('\u0000')}`;
    // Та же операция с теми же значениями в другой вкладке: дополнение идёт или готово, повторять поиск не нужно.
    // Живёт столько же, сколько задание. Остановленное и упавшее не отдаётся: такой результат выглядел бы готовым.
    const same = supplements.get(key);
    const ready = same ? jobs.get(same, { owner }) : undefined;
    if (ready && usable(ready)) {
      parent.supplemented = true;
      parent.supplement = ready.id;
      return { id: ready.id, cached: true } satisfies SearchCreated;
    }
    const prior = parent.supplement ? jobs.get(parent.supplement, { owner }) : undefined;
    if (prior && usable(prior)) return fail(reply, 'operation-supplemented', { details: 'поиск операции уже дополнен другими значениями' });
    if (parent.supplemented && !parent.supplement) return fail(reply, 'operation-supplemented', { details: 'поиск операции уже дополнен' });
    if (parent.status === 'running') return fail(reply, 'bad-request', { details: 'поиск операции ещё идёт' });
    const resolver = catalog.resolver(op.project);
    const { pattern, searchable } = operationPattern(fresh, resolver);
    if (pattern === null) return fail(reply, 'invalid-operation', { details: 'короткий id ищется только по полю, где справочник ждёт этот тип' });

    const alsoNext: OperationKeyValue[] = [...op.key.also, ...fresh.map((f) => ({ type: f.type, name: resolver?.idTypes.get(f.type)?.name ?? null, value: f.value }))];
    const spec: SearchSpec = { ...parent.spec, terms: searchable.map((s) => ({ kind: 'text', value: s.value, display: s.value, filter: { kind: 'regex', pattern } })) };
    const next: OperationSpec = { ...op, key: { ...op.key, also: alsoNext }, search: { values: searchable, pattern } };
    parent.supplemented = true;
    const { job } = jobs.create(key, true, (id) => new OperationJob(id, key, spec, next, deps, parent.seed()), { project: op.project, env: op.envId, owner, holder: holderOf(req) });
    parent.supplement = job.id;
    supplements.set(key, job.id);
    ctx.catalogHook?.bind(job, op.project, op.envId, op.mock, op.stand);
    void withQueryTrace(job.trace, () => ctx.metrics.trackJob('operation', job));
    return { id: job.id, cached: false } satisfies SearchCreated;
  });
}
