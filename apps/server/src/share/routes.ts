// Короткие ссылки: создание за входом и открытая поверхность /api/s/*.
// Открытые маршруты не принимают значений, периода, среды и стенда от браузера, роль не читают: ответ одинаков для всех.
// Записи маскируются как у зрителя link, технические подробности остаются. Текстов хранилища и имён переменных в ответах нет.

import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ShareBody, ShareCreated, ShareErrorCode, ShareInfo, ShareKind, ShareRun } from '@threadline/core';
import { BackendError } from '@threadline/core/backend';
import { environmentSelector, STAND_NUMBER, type EnvironmentConfig } from '@threadline/core/config';
import { MAX_SEARCH_ENVS } from '@threadline/core/search';
import type { CompiledProfile } from '@threadline/core/profile';
import { maskPan, maskText, validateExcludes, validateTerms, viewerMasking, type CompiledMasking, type SearchState, type Term, type TermKind } from '@threadline/core/search';
import { DEFAULT_VIEW } from '@threadline/core/view';
import { ownerOf } from '../auth/access.ts';
import type { Backends } from '../backends/registry.ts';
import { withQueryTrace } from '../backends/trace.ts';
import { DbError } from '../catalog/db.ts';
import type { CatalogHook } from '../catalog/hook.ts';
import { CatalogUnavailable, type CatalogService } from '../catalog/service.ts';
import { missingSecret, type ResolvedConfig } from '../config/load.ts';
import { OperationJob, type OperationCatalog, type OperationDeps } from '../operation/job.ts';
import { operationPlan, startOperation } from '../operation/routes.ts';
import { MAX_OP_VALUES, OP_TYPE, valueIssue, type SearchValue } from '../operation/values.ts';
import type { ProjectsService } from '../projects/service.ts';
import { readLinesPage, SearchJob, type EngineDeps, type LinesPage } from '../search/engine.ts';
import type { JobScope, SearchJobs } from '../search/jobs.ts';
import { MultiSearch } from '../search/multi.ts';
import { checkRequestBounds, CID, detail, linesResponse, maskState, multiStateOut, parseFrom, parseLinesCursor, standSelector, startMulti, startSearch, type EnvParams, type ErrorCode, type ErrorExtra, type MultiEnv } from '../search/routes.ts';
import type { SettingsService } from '../settings/service.ts';
import { LINK_BUSY_RETRY_SECONDS, LinkReadJob, type LinkJob, type SharePool } from './pool.ts';
import { insertLink, readLink, type ShareRow } from './store.ts';

const DAY = 24 * 60 * 60_000;
const MINUTE = 60_000;
/** 128 случайных бит в base64url. Формат проверяется до обращения к базе. */
const LINK_ID = /^[A-Za-z0-9_-]{22}$/;
const JOB_ID = /^[A-Za-z0-9-]{1,64}$/;
const NO_DETAILS = {};
const NO_KEEP: ReadonlySet<string> = new Set();
// Маска номера внутри текста: с разделителями или без. Края номера — всё, что о нём можно хранить.
const MASK_IN_TEXT = /\d(?:[\s+-]{0,3}[\d*]){10,24}/;

export interface ShareRoutesContext {
  config: ResolvedConfig;
  profiles: ReadonlyMap<string, CompiledProfile>;
  backends: Backends;
  jobs: SearchJobs;
  pool: SharePool;
  now: () => number;
  fail: (reply: FastifyReply, code: ErrorCode, extra?: ErrorExtra) => FastifyReply;
  resolveEnv: (params: EnvParams, reply: FastifyReply) => EnvironmentConfig | undefined;
  clientSignal: (reply: FastifyReply) => AbortSignal;
  catalog: Pick<CatalogService, 'db' | 'readDb'>;
  catalogHook?: CatalogHook | undefined;
  operationCatalog: OperationCatalog;
  masking: (project: string) => CompiledMasking;
  projects: Pick<ProjectsService, 'unusable' | 'viewOf'>;
  settings: Pick<SettingsService, 'lifetimeDays'>;
  logos: (project: string) => ShareInfo['project']['logo'];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

const newId = () => randomBytes(16).toString('base64url');

/**
 * Что уходит в базу: номера карт только краями, поэтому полного номера нет ни в базе, ни в копии. Номер внутри текста хранится так же,
 * без остального текста: `pan=<номер>` искался бы буквально и не нашёл ничего, а края номера находят те же записи.
 */
export function storedTerm(t: Pick<Term, 'kind' | 'value'>): string {
  if (t.kind === 'pan' || t.kind === 'number') return maskPan(t.value);
  const masked = maskText(t.value, NO_KEEP);
  if (masked === t.value) return t.value;
  const edges = MASK_IN_TEXT.exec(masked)?.[0].replace(/[^\d*]/g, '');
  return edges && /^\d{6}\*{2,9}\d{4}$/.test(edges) ? edges : masked;
}

/** Значение на странице ссылки: настоящих значений браузер не получает, поэтому и подсветки нет. */
export function shownTerm(t: Pick<Term, 'kind' | 'value'>): { display: string; kind: TermKind } {
  const { kind, value } = t;
  if (kind === 'uuid') return { display: value, kind };
  if (kind === 'phone') return { display: `+${'*'.repeat(Math.max(value.length - 4, 0))}${value.slice(-4)}`, kind };
  if (kind === 'pan' || kind === 'number') return { display: maskPan(value), kind };
  if (kind === 'pan-mask') return { display: value, kind };
  return { display: '***', kind };
}

/** Исключённые значения из target ссылки на результаты. Пусто — ссылка без них или старой версии; null — запись не разбирается. */
function storedExcludes(target: unknown): string[] | null {
  if (target === null) return [];
  if (!isObj(target) || !Array.isArray(target.excludes) || !target.excludes.every((t) => typeof t === 'string')) return null;
  return target.excludes as string[];
}

/** Среды ссылки на поиск по нескольким средам. undefined — ссылка одной среды; null — запись не разбирается. */
function storedEnvs(target: unknown): string[] | null | undefined {
  if (!isObj(target) || target.envs === undefined) return undefined;
  const envs = target.envs;
  if (!Array.isArray(envs) || envs.length < 2 || envs.length > MAX_SEARCH_ENVS) return null;
  if (!envs.every((e) => typeof e === 'string' && /^[a-z0-9][a-z0-9-]{0,31}$/.test(e)) || new Set(envs).size !== envs.length) return null;
  return envs as string[];
}

interface OperationTarget {
  type: string;
  values: string[];
  also: SearchValue[];
  window: '6h' | '24h';
}

function operationTarget(v: unknown): OperationTarget | null {
  if (!isObj(v) || typeof v.type !== 'string' || !OP_TYPE.test(v.type) || !Array.isArray(v.values) || v.values.length === 0) return null;
  if (v.window !== '6h' && v.window !== '24h') return null;
  if (!v.values.every((x) => typeof x === 'string' && valueIssue(x) === null)) return null;
  const also: SearchValue[] = [];
  for (const a of Array.isArray(v.also) ? (v.also as unknown[]) : []) {
    if (!isObj(a) || typeof a.type !== 'string' || !OP_TYPE.test(a.type) || typeof a.value !== 'string' || valueIssue(a.value) !== null) return null;
    also.push({ type: a.type, value: a.value });
  }
  if (v.values.length + also.length > MAX_OP_VALUES) return null;
  return { type: v.type, values: v.values as string[], also, window: v.window };
}

/** Тело создания: посторонние поля отклоняются, значения браузер не присылает. */
function parseBody(b: unknown): { ok: true; body: ShareBody } | { ok: false; details: string } {
  if (!isObj(b)) return { ok: false, details: 'тело запроса: нужен объект JSON' };
  const allowed = b.kind === 'request' ? ['kind', 'project', 'env', 'stand', 'cid', 'fromMs', 'toMs'] : ['kind', 'searchId'];
  for (const name of Object.keys(b)) if (!allowed.includes(name)) return { ok: false, details: `неизвестное поле «${name}»` };
  if (b.kind === 'results' || b.kind === 'operation') {
    if (typeof b.searchId !== 'string' || !JOB_ID.test(b.searchId)) return { ok: false, details: 'searchId: идентификатор своего задания' };
    return { ok: true, body: { kind: b.kind, searchId: b.searchId } };
  }
  if (b.kind !== 'request') return { ok: false, details: 'kind: results, request или operation' };
  const { project, env, stand, cid, fromMs, toMs } = b;
  if (typeof project !== 'string' || typeof env !== 'string') return { ok: false, details: 'project и env: строки' };
  if (stand !== undefined && (typeof stand !== 'string' || !STAND_NUMBER.test(stand))) return { ok: false, details: 'номер стенда: от одной до шести цифр' };
  if (typeof cid !== 'string' || !CID.test(cid) || cid.startsWith('nocid:')) return { ok: false, details: 'неверный correlation_id' };
  if (typeof fromMs !== 'number' || typeof toMs !== 'number') return { ok: false, details: 'fromMs и toMs: границы запроса, мс' };
  return { ok: true, body: { kind: 'request', project, env, ...(stand !== undefined ? { stand: String(Number(stand)) } : {}), cid, fromMs, toMs } };
}

interface Draft {
  kind: ShareKind;
  projectId: string;
  envId: string;
  stand: string | null;
  terms: string[];
  fromMs: number;
  toMs: number;
  target: unknown;
}

/** Открытая ссылка: всё проверено, можно читать хранилище. */
interface Opened {
  row: ShareRow;
  env: EnvironmentConfig;
  profile: CompiledProfile;
  period: { fromMs: number; toMs: number };
  periodCut: boolean;
  /** results */
  terms: Term[];
  excludes: Term[];
  /** operation */
  operation: (OperationTarget & { plan: { searchable: SearchValue[]; pattern: string } }) | null;
  /** request */
  cid: string | null;
  /** results по нескольким средам: среды, которые ещё есть в проекте, в порядке проекта; dropped — часть убрали. Нет поля — одна среда. */
  multi?: { envs: { id: string; env: EnvironmentConfig; usable: boolean }[] } | undefined;
  /** Ссылка на несколько сред, часть которых убрали из проекта: поиск идёт по оставшимся. */
  envsDropped: boolean;
}

type OpenResult = { ok: true; link: Opened } | { ok: false; code: ShareErrorCode | 'unknown-environment' | 'not-configured' };

export function registerShareRoutes(app: FastifyInstance, ctx: ShareRoutesContext): void {
  const { config, backends, jobs, pool, fail } = ctx;
  const limits = () => config.config.search;
  const deps: EngineDeps = { backends, now: ctx.now, warn: (m) => app.log.warn(m) };
  const opDeps: OperationDeps = { ...deps, catalog: ctx.operationCatalog };

  // ---------- Создание ----------

  /** Условия из своего задания: значения второй раз не идут по сети, описать чужой поиск нельзя. */
  const fromJob = (body: { kind: 'results' | 'operation'; searchId: string }, owner: string, reply: FastifyReply): Draft | null => {
    const job = jobs.get(body.searchId, { owner });
    const scope = job && jobs.scope(job.id);
    if (!job || !scope) {
      void fail(reply, 'search-expired');
      return null;
    }
    const isOperation = job instanceof OperationJob;
    if (isOperation !== (body.kind === 'operation')) {
      void fail(reply, 'bad-request', { details: 'задание другого вида' });
      return null;
    }
    if (job instanceof MultiSearch) {
      // Значения и период у частей одни: берутся у первой части с заданием. Список исключений пишется и пустым: прежняя сборка откроет ссылку по первой среде.
      const spec = job.parts.find((p) => p.job)!.job!.spec;
      const terms = spec.terms.map(storedTerm);
      const excludes = (spec.excludes ?? []).map(storedTerm).filter((x) => !terms.includes(x));
      return { kind: 'results', projectId: scope.project, envId: scope.env, stand: null, terms, fromMs: spec.period.fromMs, toMs: spec.period.toMs, target: { envs: job.parts.map((p) => p.env), excludes } };
    }
    const stand = job.spec.stand ?? null;
    if (isOperation) {
      const op = job.operation;
      return {
        kind: 'operation',
        projectId: scope.project,
        envId: scope.env,
        stand,
        terms: [],
        fromMs: op.window.fromMs,
        toMs: op.window.toMs,
        target: { type: op.key.type, values: op.key.values, also: op.key.also.map((a) => ({ type: a.type, value: a.value })), window: op.window.preset },
      };
    }
    // Исключённые значения лежат в target: у ссылки на результаты он пуст, отдельная колонка ради них не нужна.
    const terms = job.spec.terms.map(storedTerm);
    // Два написания одного номера стали одним значением: значение в поиске и в исключённых закрыло бы ссылку как устаревшую.
    const excludes = (job.spec.excludes ?? []).map(storedTerm).filter((x) => !terms.includes(x));
    return { kind: 'results', projectId: scope.project, envId: scope.env, stand, terms, fromMs: job.spec.period.fromMs, toMs: job.spec.period.toMs, target: excludes.length > 0 ? { excludes } : null };
  };

  const fromRequest = (body: Extract<ShareBody, { kind: 'request' }>, reply: FastifyReply): Draft | null => {
    const env = ctx.resolveEnv({ project: body.project, env: body.env }, reply);
    if (!env) return null;
    const selector = standSelector(env, body.stand);
    if (!selector.ok) {
      void fail(reply, 'bad-request', { details: selector.reason });
      return null;
    }
    const checked = checkRequestBounds(body.fromMs, body.toMs, ctx.now(), config.config.projects[body.project]!.retentionDays);
    if (checked !== 'ok') {
      void (checked === 'old' ? fail(reply, 'request-not-found') : fail(reply, 'bad-request', { details: checked.details }));
      return null;
    }
    return { kind: 'request', projectId: body.project, envId: body.env, stand: body.stand ?? null, terms: [], fromMs: body.fromMs, toMs: body.toMs, target: { cid: body.cid } };
  };

  app.post('/api/share', { config: { access: 'view' } }, async (req, reply) => {
    const parsed = parseBody(req.body);
    if (!parsed.ok) return fail(reply, 'bad-request', { details: parsed.details });
    const { body } = parsed;
    const draft = body.kind === 'request' ? fromRequest(body, reply) : fromJob(body, ownerOf(req), reply);
    if (!draft) return reply;
    try {
      const db = ctx.catalog.db();
      const now = ctx.now();
      const days = await ctx.settings.lifetimeDays(db);
      const id = newId();
      const expiresMs = now + days * DAY;
      await insertLink(db, { id, ...draft, fromMs: Math.floor(draft.fromMs), toMs: Math.ceil(draft.toMs), createdMs: now, expiresMs });
      return await reply.code(201).send({ path: `/s/${id}`, expiresAt: new Date(expiresMs).toISOString() } satisfies ShareCreated);
    } catch (e) {
      if (e instanceof CatalogUnavailable || e instanceof DbError) return fail(reply, 'share-unavailable');
      throw e;
    }
  });

  // ---------- Открытие ----------

  /** Проверки до хранилища: ссылка, база, проект, среда, стенд, срок хранения и значения. Значения и период только из строки базы. */
  const open = async (id: string): Promise<OpenResult> => {
    if (!LINK_ID.test(id)) return { ok: false, code: 'share-not-found' };
    const db = ctx.catalog.readDb();
    if (!db) return { ok: false, code: 'share-unavailable' };
    const now = ctx.now();
    let row: ShareRow | null;
    try {
      row = await readLink(db, id, now, await ctx.settings.lifetimeDays(db));
    } catch (e) {
      if (e instanceof DbError) return { ok: false, code: 'share-unavailable' };
      throw e;
    }
    if (!row) return { ok: false, code: 'share-not-found' };
    const projects = config.config.projects;
    if (!Object.hasOwn(projects, row.projectId)) return { ok: false, code: 'share-project-hidden' };
    const project = projects[row.projectId]!;
    const usable = (envId: string, env: EnvironmentConfig) => !ctx.projects.unusable(row.projectId, envId) && !missingSecret(backends.slotFor(env).cfg);
    // Ссылка на несколько сред: убранные среды пропускаются, ненастроенная становится частью с ошибкой. Осталась одна — обычный поиск этой среды.
    const listed = row.kind === 'results' ? storedEnvs(row.target) : undefined;
    if (listed === null) return { ok: false, code: 'share-outdated' };
    let multi: Opened['multi'];
    let envId = row.envId;
    let envsDropped = false;
    if (listed) {
      const kept = listed.flatMap((id) => {
        const env = backends.environment(row.projectId, id);
        return env && env.kind !== 'pr-stands' ? [{ id, env, usable: usable(id, env) }] : [];
      });
      const ordered = kept.sort((a, b) => Object.keys(project.environments).indexOf(a.id) - Object.keys(project.environments).indexOf(b.id));
      if (ordered.length === 0) return { ok: false, code: 'unknown-environment' };
      if (!ordered.some((e) => e.usable)) return { ok: false, code: 'not-configured' };
      envsDropped = ordered.length < listed.length;
      if (ordered.length > 1) multi = { envs: ordered };
      envId = ordered[0]!.id;
    }
    const env = multi ? multi.envs[0]!.env : backends.environment(row.projectId, envId);
    if (!env) return { ok: false, code: 'unknown-environment' };
    if (!multi && !usable(envId, env)) return { ok: false, code: 'not-configured' };
    const profile = ctx.profiles.get(row.projectId);
    if (!profile) return { ok: false, code: 'not-configured' };
    if (!multi && !standSelector(env, row.stand ?? undefined).ok) return { ok: false, code: 'not-configured' };
    const floor = now - project.retentionDays * DAY;
    if (row.toMs <= floor) return { ok: false, code: 'logs-gone' };
    const period = { fromMs: Math.max(row.fromMs, floor), toMs: row.toMs };
    // Осталась одна среда из нескольких: дальше ссылка живёт как ссылка этой среды, страница говорит о пропущенных.
    const base = { row: envId === row.envId ? row : { ...row, envId }, env, profile, period, periodCut: row.fromMs < floor, terms: [], excludes: [], operation: null, cid: null, envsDropped, ...(multi ? { multi } : {}) };
    if (row.kind === 'results') {
      const raw = Array.isArray(row.terms) && row.terms.every((t) => typeof t === 'string') ? (row.terms as string[]) : null;
      const checked = raw && validateTerms(raw);
      if (!checked || !checked.ok) return { ok: false, code: 'share-outdated' };
      const left = storedExcludes(row.target);
      const excluded = left && validateExcludes(left, checked.terms);
      if (!excluded || !excluded.ok) return { ok: false, code: 'share-outdated' };
      return { ok: true, link: { ...base, terms: checked.terms, excludes: excluded.excludes } };
    }
    if (row.kind === 'operation') {
      const target = operationTarget(row.target);
      const plan = target && operationPlan(target.type, target.values, target.also, ctx.operationCatalog.resolver(row.projectId));
      if (!target || !plan) return { ok: false, code: 'share-outdated' };
      return { ok: true, link: { ...base, operation: { ...target, plan } } };
    }
    const cid = isObj(row.target) && typeof row.target.cid === 'string' && CID.test(row.target.cid) ? row.target.cid : null;
    if (!cid) return { ok: false, code: 'share-outdated' };
    return { ok: true, link: { ...base, cid } };
  };

  const answer = (reply: FastifyReply, code: ErrorCode) => fail(reply, code, NO_DETAILS);

  /** Ответ описания собран по списку полей: имён хранилищ, переменных и селекторов здесь быть не может. */
  const describe = ({ row, period, periodCut, terms, excludes, operation, cid, multi, envsDropped }: Opened): ShareInfo => {
    const project = config.config.projects[row.projectId]!;
    const env = project.environments[row.envId]!;
    const logo = ctx.logos(row.projectId);
    return {
      kind: row.kind,
      project: { id: row.projectId, name: project.name, timezone: project.timezone, retentionDays: project.retentionDays, ...(logo ? { logo } : {}), view: ctx.projects.viewOf(row.projectId) ?? DEFAULT_VIEW },
      env: { id: row.envId, name: env.name, kind: env.kind },
      ...(multi ? { envs: multi.envs.map((e) => ({ id: e.id, name: e.env.name, kind: e.env.kind })) } : {}),
      ...(envsDropped ? { envsDropped: true } : {}),
      stand: row.stand,
      period,
      periodCut,
      terms: terms.map(shownTerm),
      ...(excludes.length > 0 ? { excludes: excludes.map(shownTerm) } : {}),
      expiresAt: new Date(row.untilMs).toISOString(),
      target: cid ? { cid } : operation ? { type: operation.type, value: operation.values[0]!, window: operation.window } : null,
    };
  };

  const bindLink = (job: object, link: Opened) => {
    if (job instanceof MultiSearch) {
      for (const p of job.parts) if (p.job) ctx.catalogHook?.bind(p.job, link.row.projectId, p.env, backends.slotFor(p.job.spec.env).cfg.type === 'mock', null, { collect: false });
      return;
    }
    ctx.catalogHook?.bind(job, link.row.projectId, link.row.envId, backends.slotFor(link.env).cfg.type === 'mock', link.row.stand, { collect: false });
  };

  /** Новое задание ссылки. Период зафиксирован при создании, селектор собирается заново из текущей настройки среды. */
  const start = (link: Opened, create: (make: (id: string) => LinkJob, scope: JobScope) => LinkJob): LinkJob => {
    const { row, env, profile, period } = link;
    const stand = row.stand ?? undefined;
    const scope = { project: row.projectId, env: row.envId };
    const key = `link:${row.id}`;
    const toSearch = (make: (id: string) => SearchJob) => ({ job: create(make, scope) as SearchJob, cached: false });
    // Проверено в open: стенд подходит среде.
    const selectorOf = (operation: boolean) => {
      const selector = environmentSelector(env, stand, { operation });
      return selector.ok ? selector.selector : [];
    };
    let job: LinkJob;
    if (link.operation) {
      const op = link.operation;
      job = startOperation(
        { project: row.projectId, envId: row.envId, env, selector: selectorOf(true), stand, type: op.type, values: op.values, also: op.also, plan: op.plan, window: { ...period, preset: op.window }, profile, limits: limits(), key, fresh: true, mock: backends.slotFor(env).cfg.type === 'mock' },
        (_k, _f, make) => toSearch(make),
        opDeps,
      ).job;
    } else if (link.cid) {
      const margin = limits().periodMarginMinutes * MINUTE;
      const now = ctx.now();
      const floor = now - config.config.projects[row.projectId]!.retentionDays * DAY;
      const range = { fromMs: Math.max(period.fromMs - margin, floor), toMs: Math.min(period.toMs + margin, now) };
      const spec = { project: row.projectId, env, selector: selectorOf(false), cid: link.cid, range, period: { ...period, preset: null }, profile, limits: limits() };
      job = create((id) => new LinkReadJob(id, key, spec, deps), scope);
    } else if (link.multi) {
      // Ссылка на несколько сред: среды по очереди, ссылок в Grafana нет, ненастроенная среда — часть с ошибкой без имён переменных.
      const envs: MultiEnv[] = link.multi.envs.map((e) => {
        const selector = e.usable ? environmentSelector(e.env, undefined) : null;
        return selector?.ok ? { id: e.id, env: e.env, selector: selector.selector } : { id: e.id, env: e.env, selector: null, error: { code: 'not-configured', stage: 'count' } };
      });
      job = startMulti(
        { project: row.projectId, envs, terms: link.terms, excludes: link.excludes, period: { ...period, preset: null }, profile, limits: limits(), key, fresh: true, sequential: true },
        (_k, _f, make, multiScope) => ({ job: create(make, multiScope) as MultiSearch, cached: false }),
        deps,
      ).job;
    } else {
      job = startSearch(
        { project: row.projectId, envId: row.envId, env, selector: selectorOf(false), stand, terms: link.terms, excludes: link.excludes, period: { ...period, preset: null }, profile, limits: limits(), key, fresh: true },
        (_k, _f, make) => toSearch(make),
        deps,
      ).job;
    }
    bindLink(job, link);
    return job;
  };

  /** Ошибка для страницы ссылки: только код, этап и время повтора. */
  const bareError = (e: SearchState['error']): SearchState['error'] => e && { code: e.code, stage: e.stage, ...(e.retryAfterSeconds !== undefined ? { retryAfterSeconds: e.retryAfterSeconds } : {}) };

  /** Состояние для браузера: идентификатора задания и значений нет, у ошибки только код и время повтора. */
  const stateOut = (linkId: string, job: Exclude<LinkJob, MultiSearch>, state: SearchState): SearchState => {
    // Исключённые значения уходят так же, как значения поиска: на странице они только маской из описания ссылки.
    const { error, excludes: _excludes, ...rest } = state;
    const masked = maskState(rest as SearchState, job.keep, app.log, ctx.masking(job.spec.project));
    const out: SearchState = {
      ...masked,
      id: linkId,
      terms: [],
      error: bareError(error),
    };
    if (out.operation) out.operation = { ...out.operation, excluded: [] };
    return out;
  };

  app.get<{ Params: { id: string } }>('/api/s/:id', { config: { access: 'public' } }, async (req, reply) => {
    const opened = await open(req.params.id);
    if (!opened.ok) return answer(reply, opened.code);
    return describe(opened.link);
  });

  // Тело не читается: условия поиска только из строки базы. Чужой сайт поиск не запустит: Origin проверяет таблица доступа.
  app.post<{ Params: { id: string } }>('/api/s/:id/run', { config: { access: 'public' } }, async (req, reply) => {
    const opened = await open(req.params.id);
    if (!opened.ok) return answer(reply, opened.code);
    const run = pool.run(opened.link.row.id, (create) => start(opened.link, create));
    if (!run) return fail(reply, 'busy', { retryAfterSeconds: LINK_BUSY_RETRY_SECONDS });
    return { cached: run.cached } satisfies ShareRun;
  });

  // Опрос и подробности работают из памяти: без базы и без проверки срока, её выполняет следующее открытие.
  // Опрос хода раз в 0,5 с: без строк info, предупреждения и ошибки остаются.
  app.get<{ Params: { id: string }; Querystring: { from?: string } }>('/api/s/:id/state', { config: { access: 'public' }, logLevel: 'warn' }, async (req, reply) => {
    if (!LINK_ID.test(req.params.id)) return answer(reply, 'share-not-found');
    const job = pool.find(req.params.id, { poll: true });
    if (!job) return answer(reply, 'search-expired');
    const from = parseFrom(req.query.from);
    if (from === null) return fail(reply, 'bad-request');
    if (job instanceof MultiSearch) {
      const { error, excludes: _excludes, envs, ...rest } = multiStateOut(job, from, ctx.catalogHook, app.log, ctx.masking(job.project));
      return { ...rest, id: req.params.id, terms: [], error: bareError(error), envs: (envs ?? []).map(({ explore: _explore, ...p }) => ({ ...p, error: bareError(p.error) })) } satisfies SearchState;
    }
    const state = job.state(from);
    if (ctx.catalogHook) state.requests = ctx.catalogHook.summaries(job, state.requests, job.requests, (cid) => job.request(cid));
    return stateOut(req.params.id, job, state);
  });

  app.get<{ Params: { id: string; cid: string }; Querystring: { env?: string } }>('/api/s/:id/requests/:cid', { config: { access: 'public' } }, async (req, reply) => {
    if (!LINK_ID.test(req.params.id)) return answer(reply, 'share-not-found');
    const found = pool.find(req.params.id);
    if (!found) return answer(reply, 'search-expired');
    // Ссылка на несколько сред: запрос из части среды ?env=. Среды нет в ссылке — ответ как у запроса не из этой ссылки.
    const job = found instanceof MultiSearch ? (req.query.env !== undefined ? found.part(req.query.env)?.job : undefined) : found;
    if (!job) return answer(reply, 'share-not-found');
    const { cid } = req.params;
    const stored = CID.test(cid) ? job.request(cid) : undefined;
    // Запроса нет в поиске этой ссылки: ответ байт в байт как у неизвестной ссылки, адрес не даёт узнать, существует ли такой запрос.
    // Свой запрос ссылки на запрос, у которого записи кончились: это отдельное сообщение, идентификатор и так лежит в ссылке.
    if (!stored) return answer(reply, job instanceof LinkReadJob && job.spec.cid === cid ? 'request-not-found' : 'share-not-found');
    const masking = viewerMasking(ctx.masking(job.spec.project), 'link');
    const { reveal: _reveal, ...res } = detail(stored.summary, stored.records, stored, new Set([cid]), app.log, masking, ctx.catalogHook && ((s, v) => ctx.catalogHook!.jobDetail(job, s, stored, v)));
    return res;
  });

  app.get<{ Params: { id: string }; Querystring: { cursor?: string; env?: string } }>('/api/s/:id/lines', { config: { access: 'public' } }, async (req, reply) => {
    if (!LINK_ID.test(req.params.id)) return answer(reply, 'share-not-found');
    const found = pool.find(req.params.id);
    if (!found) return answer(reply, 'search-expired');
    const job = found instanceof MultiSearch ? (req.query.env !== undefined ? found.part(req.query.env)?.job : undefined) : found;
    if (!job) return fail(reply, 'bad-request');
    // Вкладка есть только у результатов поиска.
    if (!(job instanceof SearchJob) || job instanceof OperationJob) return fail(reply, 'bad-request');
    const parsed = parseLinesCursor(req.query.cursor, job.spec.period);
    if ('error' in parsed) return fail(reply, 'bad-request');
    const { cursor } = parsed;
    const masking = viewerMasking(ctx.masking(job.spec.project), 'link');
    const annotated = (page: LinesPage): LinesPage => (ctx.catalogHook ? { ...page, records: ctx.catalogHook.lines(job, page.records) } : page);
    if (!cursor && job.firstLinesPage) return linesResponse(annotated(job.firstLinesPage), app.log, masking);
    // Новое чтение хранилища идёт только у живой ссылки. Открытой странице остаётся уже прочитанное в памяти.
    const opened = await open(req.params.id);
    if (!opened.ok) return answer(reply, opened.code);
    if (!pool.beginRead(req.params.id)) return fail(reply, 'busy', { retryAfterSeconds: LINK_BUSY_RETRY_SECONDS });
    try {
      const signal = ctx.clientSignal(reply);
      const page = await withQueryTrace({ ...job.trace, requestId: req.id }, () => readLinesPage(deps, job.spec, cursor, signal));
      return linesResponse(annotated(page), app.log, masking);
    } catch (e) {
      // Только код и время повтора: текст хранилища наружу не идёт.
      if (e instanceof BackendError) return fail(reply, e.code, e.retryAfterSeconds !== undefined ? { retryAfterSeconds: e.retryAfterSeconds } : {});
      throw e;
    } finally {
      pool.endRead(req.params.id);
    }
  });
}
