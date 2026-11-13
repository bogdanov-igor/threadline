// API поиска: запуск, состояние, остановка, запрос из задания, «Все записи», запрос по ссылке.
// Каждый ответ с данными логов маскируется на выходе.

import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { MAX_EPOCH_MS, type ApiErrorCode } from '@threadline/core';
import { negateFilter, type ExploreQuery, type Filter, type LinesQuery, type Matcher } from '@threadline/core/backend';
import { environmentSelector, type EnvironmentConfig, type SearchConfig } from '@threadline/core/config';
import type { CompiledProfile } from '@threadline/core/profile';
import {
  buildView,
  MAX_TERM_LENGTH,
  kindsStayingHidden,
  linkFilter,
  markPending,
  MASK_KIND_CODES,
  MAX_SEARCH_ENVS,
  orderEnvSet,
  maskDeep,
  maskDeepOpeningCards,
  maskKindsEnvelope,
  maskKindsRecord,
  MAX_PERIOD_MS,
  notingHiddenCards,
  PERIOD_PRESETS,
  openRecordOf,
  summarize,
  validateExcludes,
  validateTerms,
  viewerMasking,
  type CompiledMasking,
  type ExcludesError,
  type ExploreLink,
  type LinesPageResponse,
  type ParsedRecord,
  type PeriodPreset,
  type OpenRecord,
  type RevealResponse,
  type MaskKind,
  type MaskPolicy,
  type MaskViewer,
  type RequestDetail,
  type RequestSummary,
  type SearchCreated,
  type SearchErrorCode,
  type SearchRequestBody,
  type SearchState,
  type Term,
  type TermsError,
  type ViewerMasking,
  type ViewRecord,
} from '@threadline/core/search';
import { holderOf, ownerOf } from '../auth/access.ts';
import { presentDetail, presentState } from '../auth/present.ts';
import { missingSecret, type ResolvedConfig } from '../config/load.ts';
import type { CatalogHook } from '../catalog/hook.ts';
import { operationKeysOf } from '@threadline/core/flow';
import type { Backends } from '../backends/registry.ts';
import { withQueryTrace } from '../backends/trace.ts';
import { HolderReads } from './holder-reads.ts';
import { readEnd, readLines, readLinesPage, SearchJob, type EngineDeps, type LinesPage, type SearchPeriod, type SearchSpec } from './engine.ts';
import { ownSecretScrubber, scrubOwnSecrets, type OwnSecretScrubber } from './own-secrets.ts';
import { viewerOf } from './viewer.ts';
import { searchKey, type JobScope, type PoolJob, type SearchJobs } from './jobs.ts';
import { readCap } from './memory.ts';
import { MultiSearch, type MultiPart } from './multi.ts';
import { decodeCursor, encodeCursor, type PageCursor } from './paging.ts';
import type { Metrics } from '../metrics.ts';

export type ErrorCode = ApiErrorCode | SearchErrorCode;
export interface ErrorExtra {
  details?: string | undefined;
  retryAfterSeconds?: number | undefined;
}
export interface EnvParams {
  project: string;
  env: string;
}

/** Среда проекта или причина, почему её нет: неверный id, неизвестная или не годится к чтению (not-configured). */
export type EnvLookup = { ok: true; env: EnvironmentConfig } | { ok: false; code: 'bad-request' | 'unknown-environment' | 'not-configured'; details?: string };

export interface SearchRoutesContext {
  config: ResolvedConfig;
  metrics: Pick<Metrics, 'trackJob'>;
  /** Профиль формата каждого проекта, собран при старте. */
  profiles: ReadonlyMap<string, CompiledProfile>;
  backends: Backends;
  jobs: SearchJobs;
  now: () => number;
  fail: (reply: FastifyReply, code: ErrorCode, extra?: ErrorExtra) => FastifyReply;
  /** Ошибка хранилища — её код и HTTP-статус; прочие исключения пробрасываются. */
  failBackend: (reply: FastifyReply, e: unknown) => FastifyReply;
  resolveEnv: (params: EnvParams, reply: FastifyReply) => EnvironmentConfig | undefined;
  /** То же без ответа: поиск по нескольким средам проверяет каждую среду сам. */
  lookupEnv: (params: EnvParams) => EnvLookup;
  clientSignal: (reply: FastifyReply) => AbortSignal;
  /** Справочник: разметка ответов до маскирования. Без него ответы прежние. */
  catalog?: CatalogHook | undefined;
  /** Настройка маскирования проекта: есть и без справочника, тогда это состояния по умолчанию. */
  masking: (project: string) => CompiledMasking;
  /** Значения собственных секретов сервиса: собраны при старте. */
  ownSecrets: readonly string[];
  /** Подмена с текущим набором секретов, вместе с хранилищами локального режима. Нет — подмена по ownSecrets. */
  scrubOwn?: (text: string) => string;
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const JOB_ID = /^[A-Za-z0-9-]{1,64}$/;
export const CID = /^[A-Za-z0-9._:-]{1,128}$/;

export const MASK_PLACEHOLDER_TITLE = 'запись скрыта: ошибка маскирования';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const errorName = (e: unknown) => (e instanceof Error ? e.name : typeof e);

function days(n: number): string {
  const d = n % 10;
  const dd = n % 100;
  const word = d === 1 && dd !== 11 ? 'день' : d >= 2 && d <= 4 && (dd < 12 || dd > 14) ? 'дня' : 'дней';
  return `${n} ${word}`;
}

// ---------- Проверки ----------

type BodyResult = { ok: true; body: SearchRequestBody } | { ok: false; code: 'bad-request' | 'invalid-terms'; details: string };

function parseBody(b: unknown): BodyResult {
  if (!isObj(b)) return { ok: false, code: 'bad-request', details: 'тело запроса: нужен объект JSON' };
  const { terms, excludes, period, stand, fresh } = b;
  const strings = (v: unknown[]) => v.every((t) => typeof t === 'string' && t.length <= MAX_TERM_LENGTH);
  if (!Array.isArray(terms) || !strings(terms)) {
    return { ok: false, code: 'bad-request', details: `terms: список строк длиной до ${MAX_TERM_LENGTH} символов` };
  }
  if (excludes !== undefined && (!Array.isArray(excludes) || !strings(excludes))) {
    return { ok: false, code: 'bad-request', details: `excludes: список строк длиной до ${MAX_TERM_LENGTH} символов` };
  }
  if (terms.length > 5) return { ok: false, code: 'invalid-terms', details: termsErrorText('too-many') };
  if (excludes !== undefined && excludes.length > 5) return { ok: false, code: 'invalid-terms', details: excludesErrorText('too-many') };
  if (stand !== undefined && typeof stand !== 'string') return { ok: false, code: 'bad-request', details: 'stand: строка' };
  if (fresh !== undefined && typeof fresh !== 'boolean') return { ok: false, code: 'bad-request', details: 'fresh: true или false' };
  return {
    ok: true,
    body: {
      terms: terms as string[],
      ...(excludes !== undefined ? { excludes: excludes as string[] } : {}),
      period: period as SearchRequestBody['period'],
      ...(stand !== undefined ? { stand } : {}),
      ...(fresh !== undefined ? { fresh } : {}),
    },
  };
}

export function termsErrorText(e: TermsError): string {
  if (e === 'empty') return 'нет ни одного значения для поиска';
  if (e === 'too-many') return 'не больше 5 значений';
  if (e === 'need-long') return 'нужно хотя бы одно значение длиной от 6 символов';
  if (e.error === 'too-long') return `значение ${e.index + 1}: не длиннее ${MAX_TERM_LENGTH} символов`;
  return e.error === 'too-short'
    ? `значение ${e.index + 1}: нужно не меньше 2 символов`
    : `значение ${e.index + 1}: кавычки и обратная косая черта не допускаются`;
}

export function excludesErrorText(e: ExcludesError): string {
  if (e === 'too-many') return 'не больше 5 исключённых значений';
  if (e.error === 'too-short') return `исключённое значение ${e.index + 1}: нужно не меньше 2 символов`;
  if (e.error === 'too-long') return `исключённое значение ${e.index + 1}: не длиннее ${MAX_TERM_LENGTH} символов`;
  if (e.error === 'conflict') return `исключённое значение ${e.index + 1}: оно есть в значениях поиска, результат будет пустым`;
  return `исключённое значение ${e.index + 1}: кавычки и обратная косая черта не допускаются`;
}

/** Период поиска: пресет или свои границы не длиннее 24 ч, не раньше срока хранения; конец — не позже now. */
export function resolvePeriod(
  p: unknown,
  nowMs: number,
  retentionDays: number,
): { ok: true; period: SearchPeriod } | { ok: false; details: string } {
  if (isObj(p) && typeof p.preset === 'string' && Object.hasOwn(PERIOD_PRESETS, p.preset)) {
    const preset = p.preset as PeriodPreset;
    return { ok: true, period: { fromMs: nowMs - PERIOD_PRESETS[preset], toMs: nowMs, preset } };
  }
  if (!isObj(p) || 'preset' in p || !Number.isFinite(p.fromMs) || !Number.isFinite(p.toMs)) {
    return { ok: false, details: 'период: preset 15m, 1h, 6h или 24h либо границы fromMs и toMs в мс' };
  }
  const fromMs = p.fromMs as number;
  const toMs = p.toMs as number;
  // Год 202333 и прочий мусор: понятный отказ раньше смысловых проверок. Слишком старое отклоняет срок хранения ниже.
  if (fromMs >= MAX_EPOCH_MS || toMs >= MAX_EPOCH_MS) return { ok: false, details: 'год в границах периода: от 2000 до 2099' };
  if (fromMs >= toMs) return { ok: false, details: 'начало периода должно быть раньше конца' };
  if (toMs - fromMs > MAX_PERIOD_MS) return { ok: false, details: 'период длиннее 24 часов' };
  if (fromMs < nowMs - retentionDays * DAY) {
    return { ok: false, details: `начало периода раньше срока хранения логов: логи хранятся ${days(retentionDays)}` };
  }
  const end = Math.min(toMs, nowMs);
  if (fromMs >= end) return { ok: false, details: 'начало периода позже текущего момента' };
  return { ok: true, period: { fromMs, toMs: end, preset: null } };
}

/** Селектор среды со стендом. Стенд бывает только у среды стендов. */
export function standSelector(env: EnvironmentConfig, stand: string | undefined) {
  if (env.kind !== 'pr-stands' && stand !== undefined) return { ok: false as const, reason: 'у среды нет стендов' };
  return environmentSelector(env, stand);
}

export function parseFrom(v: unknown): number | null {
  if (v === undefined) return 0;
  return typeof v === 'string' && /^\d{1,9}$/.test(v) ? Number(v) : null;
}

// ---------- Маскирование на выходе ----------

type Mask = <T>(value: T, keep: ReadonlySet<string>) => T;

function placeholder(r: ViewRecord): ViewRecord {
  return {
    id: r.id,
    tsNs: r.tsNs,
    timeMs: r.timeMs,
    offsetMs: r.offsetMs,
    kind: 'raw',
    title: MASK_PLACEHOLDER_TITLE,
    titleCode: 'mask-failed',
    message: '',
    level: null,
    isError: false,
    component: null,
    gateway: false,
    correlationId: null,
    requestId: null,
    http: null,
    sections: { headers: null, body: null, payload: null, context: null },
    raw: '',
    match: null,
  };
}

/** Каждая запись отдельно; при исключении — заглушка, в журнал — только тип ошибки. */
export function maskRecords(records: ViewRecord[], keep: ReadonlySet<string>, log: Pick<FastifyBaseLogger, 'error'>, mask: Mask = maskDeep): ViewRecord[] {
  return records.map((r) => {
    try {
      return mask(r, keep);
    } catch (e) {
      log.error(`маскирование записи не удалось: ${errorName(e)}`);
      return placeholder(r);
    }
  });
}

export function maskSummary(s: RequestSummary, keep: ReadonlySet<string>, log: Pick<FastifyBaseLogger, 'error'>, mask: Mask = maskDeep): RequestSummary {
  try {
    return mask(s, keep);
  } catch (e) {
    log.error(`маскирование сводки запроса не удалось: ${errorName(e)}`);
    return { ...s, incoming: null, component: null, reasons: [] };
  }
}

/** Id вкладки из параметра запроса; другой вид не учитывается. */
const tabOf = (v: string | undefined): string | undefined => (v && /^[A-Za-z0-9-]{1,64}$/.test(v) ? v : undefined);

/** Сводка: базовая маска, затем строгий проход. Показ её не открывает, переключатель вида не меняет. */
function summaryOut(s: RequestSummary, keep: ReadonlySet<string>, log: Pick<FastifyBaseLogger, 'error'>, masking: CompiledMasking): RequestSummary {
  const base = maskSummary(s, keep, log);
  try {
    return maskKindsEnvelope(base, masking.strict, keep);
  } catch (e) {
    log.error(`маскирование сводки запроса не удалось: ${errorName(e)}`);
    return { ...base, incoming: null, component: null, reasons: [] };
  }
}

export function maskState(state: SearchState, keep: ReadonlySet<string>, log: FastifyBaseLogger, masking: CompiledMasking): SearchState {
  const { requests, terms, excludes, ...rest } = state;
  // Id операции открыт: значения ключа и разметки справочника образец не трогает.
  const shown = new Set(keep);
  if (rest.operation) collectIds(rest.operation, shown);
  // Значения поиска — то, что ввёл сам пользователь: из них собирается «Обновить», проход по видам их не трогает.
  return { ...maskKindsEnvelope(maskDeep(rest, keep), masking.strict, shown), terms: maskDeep(terms, keep), ...(excludes ? { excludes: maskDeep(excludes, keep) } : {}), requests: requests.map((s) => summaryOut(s, new Set([s.correlationId]), log, masking)) };
}

/** Значения id в представлении операции: values ключа и поля value рядом с type. */
function collectIds(v: unknown, out: Set<string>): void {
  if (Array.isArray(v)) {
    for (const x of v) collectIds(x, out);
  } else if (isObj(v)) {
    if (typeof v.value === 'string' && typeof v.type === 'string') out.add(v.value);
    if (Array.isArray(v.values)) for (const x of v.values) if (typeof x === 'string') out.add(x);
    for (const x of Object.values(v)) collectIds(x, out);
  }
}

type KindMask = typeof maskKindsRecord;

/** Второй проход по записям после базовой маски; исключение — заглушка, в журнал — только тип ошибки. */
export function kindRecords(records: readonly ViewRecord[], masking: CompiledMasking, keep: ReadonlySet<string>, log: Pick<FastifyBaseLogger, 'error'>, mask: KindMask = maskKindsRecord): { records: ViewRecord[]; hits: Set<MaskKind> } {
  const hits = new Set<MaskKind>();
  const out = records.map((r) => {
    try {
      const m = mask(r, masking, keep);
      for (const t of m.hits) hits.add(t);
      return m.record;
    } catch (e) {
      log.error(`маскирование записи не удалось: ${errorName(e)}`);
      return placeholder(r);
    }
  });
  return { records: out, hits };
}

/** keep второго прохода: ещё значения id из разметки справочника. */
function withCatalogIds(base: ReadonlySet<string>, records: readonly ViewRecord[]): Set<string> {
  const keep = new Set(base);
  for (const r of records) for (const id of r.catalog?.ids ?? []) keep.add(id.value);
  return keep;
}

const NO_IDS: ReadonlySet<string> = new Set();

/** correlation_id и request_id записей: их маскирование не трогает. Набор всегда только по записям этого запроса: id чужого запроса маску не снимает. */
function withIds(base: ReadonlySet<string>, records: readonly { correlationId: string | null; requestId: string | null }[]): Set<string> {
  const keep = new Set(base);
  for (const r of records) {
    if (r.correlationId) keep.add(r.correlationId);
    if (r.requestId) keep.add(r.requestId);
  }
  return keep;
}

export function detail(
  summary: RequestSummary,
  records: ParsedRecord[],
  read: { readEndMs: number; incomplete: boolean },
  keep: ReadonlySet<string>,
  log: FastifyBaseLogger,
  masking: ViewerMasking,
  annotate?: (summary: RequestSummary, view: ViewRecord[]) => { summary: RequestSummary; view: ViewRecord[] },
): RequestDetail {
  const built = markPending(buildView(records, { withOffsets: true, strict: masking.strict }), read);
  const out = annotate ? annotate(summary, built) : { summary, view: built };
  const k = withIds(keep, records);
  const shown = withCatalogIds(k, out.view);
  const first = notingHiddenCards(() => maskRecords(out.view, k, log));
  const second = kindRecords(first.value, masking, shown, log);
  const res: RequestDetail = {
    summary: summaryOut(out.summary, k, log, masking),
    records: second.records,
    reveal: { kinds: eyeKinds(masking, second.hits, first.cardHidden, out.view, k), stays: kindsStayingHidden(masking.viewer) },
  };
  // Ключи операций потока: по немаскированной разметке, наружу — после маскирования.
  if (annotate) res.operationKeys = maskKindsEnvelope(maskDeep(operationKeysOf(out.view, k), k), masking.strict, shown);
  return res;
}

export function linesResponse(page: LinesPage, log: FastifyBaseLogger, masking: ViewerMasking): LinesPageResponse {
  // Id открыт только в своей записи: request_id одной записи не снимает маску с того же значения в чужой.
  const records = page.records.flatMap((r) => {
    const k = withIds(NO_IDS, [r]);
    return kindRecords(maskRecords([r], k, log), masking, withCatalogIds(k, [r]), log).records;
  });
  // Курсор — время и хэши строк, данных логов в нём нет.
  return { records, nextCursor: page.next ? encodeCursor(page.next) : null };
}

/** Запись изменилась бы на первом проходе без номеров карт: значит, на ней скрыт секрет. Считается только у зрителей с правом на секреты. */
function secretHidden(r: ViewRecord, keep: ReadonlySet<string>): boolean {
  const content = { uri: r.http?.uri ?? null, sections: r.sections, raw: r.raw };
  try {
    return JSON.stringify(maskDeepOpeningCards(content, keep)) !== JSON.stringify(content);
  } catch {
    return false;
  }
}

/** Что глазок откроет этому зрителю на этой странице: пересечение скрытого с таблицей видов. */
export function eyeKinds(masking: ViewerMasking, hits: ReadonlySet<MaskKind>, cardHidden: boolean, view: readonly ViewRecord[], keep: ReadonlySet<string>): MaskKind[] {
  const hidden = new Set(hits);
  if (cardHidden) hidden.add('card_number');
  if (masking.opensSecrets && !hidden.has('secrets') && view.some((r) => secretHidden(r, keep))) hidden.add('secrets');
  return MASK_KIND_CODES.filter((k) => masking.eye.has(k) && hidden.has(k));
}

/** Первый проход зрителя: кто открывает секреты, тому прохода нет; кто открывает номер, тому номер как есть. */
function firstPassOf(masking: ViewerMasking): <T>(value: T, keep: ReadonlySet<string>) => T {
  if (masking.opensSecrets) return (value) => value;
  return masking.opensCards ? maskDeepOpeningCards : maskDeep;
}

type OpenMask = (r: ViewRecord, reveal: MaskPolicy, keep: ReadonlySet<string>) => OpenRecord;

/** Записи ответа показа: первый проход зрителя, проход по видам, которые ему не открыты, подмена своих секретов. Запись, упавшая на маске, в ответ не идёт. */
export function revealRecords(view: readonly ViewRecord[], masking: ViewerMasking, keep: ReadonlySet<string>, scrub: OwnSecretScrubber, log: Pick<FastifyBaseLogger, 'error'>, mask: OpenMask = openRecordOf): OpenRecord[] {
  const first = firstPassOf(masking);
  const out: OpenRecord[] = [];
  for (const r of view) {
    try {
      out.push(scrubOwnSecrets(mask(first(r, keep), masking.reveal, keep), scrub));
    } catch (e) {
      log.error(`маскирование записи не удалось: ${errorName(e)}`);
    }
  }
  return out;
}

function revealResponse(records: ParsedRecord[], read: { readEndMs: number; incomplete: boolean }, keep: ReadonlySet<string>, log: FastifyBaseLogger, masking: ViewerMasking, scrub: OwnSecretScrubber): RevealResponse {
  const view = markPending(buildView(records, { withOffsets: true }), read);
  return { records: revealRecords(view, masking, withIds(keep, records), scrub, log) };
}

// ---------- Ссылка в интерфейс хранилища ----------

/**
 * Ссылка поиска. Сначала доступность ссылки: у имитации поля нет и на значении, которое закрыло бы ссылку.
 * Без сети. Поле ставится на выходе, после маскирования: маска портила бы закодированный адрес, а значения в нём уже безопасны.
 */
function searchExplore(backends: Backends, env: EnvironmentConfig, selector: Matcher[], terms: readonly Term[], excludes: readonly Term[], range: ExploreQuery['range'], strict: MaskPolicy): ExploreLink | undefined {
  if (backends.exploreUrl(env, { selector, filters: [], range }) === undefined) return undefined;
  const parts = terms.map((t) => linkFilter(t, strict));
  const left = excludes.map((t) => linkFilter(t, strict));
  if (parts.some((p) => p === null) || left.some((p) => p === null)) return { url: null, reason: 'unsafe' };
  const shown = parts.filter((p) => p !== null);
  const out = left.filter((p) => p !== null);
  const filters: Filter[] = [...shown.map((p) => p.filter), ...out.map((p) => negateFilter(p.filter))];
  const url = backends.exploreUrl(env, { selector, filters, range });
  if (url === undefined) return undefined;
  if (url === null) return { url: null, reason: 'too-long' };
  // Шаблон шире значения у исключения значит «скроет больше», а не «найдёт больше». Номер карты уходит тем же шаблоном, что в хранилище: расхождения нет.
  const narrower = out.some((p, i) => JSON.stringify(p.filter) !== JSON.stringify(excludes[i]!.filter));
  return { url, wider: shown.some((p) => p.wider), typed: shown.some((p) => p.typed) || out.some((p) => p.typed), ...(narrower ? { narrower } : {}) };
}

/** Ссылка запроса: его correlation_id за окно запроса. Значений поиска в ней нет, у сегмента без correlation_id её нет. */
function requestExplore(backends: Backends, env: EnvironmentConfig, selector: Matcher[], cid: string, range: ExploreQuery['range']): ExploreLink | undefined {
  if (cid.startsWith('nocid:')) return undefined;
  const url = backends.exploreUrl(env, { selector, filters: [{ kind: 'contains', value: cid }], range });
  if (url === undefined) return undefined;
  return url === null ? { url: null, reason: 'too-long' } : { url, wider: false, typed: false };
}

const withExplore = <T extends object>(res: T, explore: ExploreLink | undefined): T & { explore?: ExploreLink } => (explore ? { ...res, explore } : res);

// ---------- Запуск ----------

/** Как создать задание: обычный пул или пул коротких ссылок. */
export type JobCreate = (key: string, fresh: boolean, make: (id: string) => SearchJob, scope: JobScope) => { job: SearchJob; cached: boolean };

export interface SearchStart {
  project: string;
  envId: string;
  env: EnvironmentConfig;
  selector: Matcher[];
  stand: string | undefined;
  terms: Term[];
  excludes?: Term[] | undefined;
  period: SearchPeriod;
  profile: CompiledProfile;
  limits: SearchConfig;
  key: string;
  fresh: boolean;
  owner?: string | undefined;
  /** Чьи это места пула (holderOf). Нет — места не считаются отдельно: пул ссылок. */
  holder?: string | undefined;
  explore?: ExploreLink | undefined;
  /** Кусков первого прохода сразу. Нет — по одному: поиск ссылки. */
  parallel?: number | undefined;
}

/** Запуск обычного поиска: одна логика на маршрут поиска и короткую ссылку. Разметку справочника привязывает вызывающий. */
export function startSearch(p: SearchStart, create: JobCreate, deps: EngineDeps): { job: SearchJob; cached: boolean } {
  const spec: SearchSpec = { project: p.project, envId: p.envId, env: p.env, selector: p.selector, stand: p.stand, terms: p.terms, ...(p.excludes?.length ? { excludes: p.excludes } : {}), period: p.period, profile: p.profile, limits: p.limits, ...(p.explore ? { explore: p.explore } : {}), ...(p.parallel ? { parallel: p.parallel } : {}) };
  return create(p.key, p.fresh, (id) => new SearchJob(id, p.key, spec, deps), { project: p.project, env: p.envId, ...(p.owner !== undefined ? { owner: p.owner } : {}), ...(p.holder !== undefined ? { holder: p.holder } : {}) });
}

// ---------- Поиск по нескольким средам ----------

type StateError = NonNullable<SearchState['error']>;

/** Среда поиска по нескольким средам: с селектором, если её можно читать, иначе с ошибкой части. */
export interface MultiEnv {
  id: string;
  env: EnvironmentConfig;
  selector: Matcher[] | null;
  error?: StateError;
  explore?: ExploreLink | undefined;
}

export interface MultiStart {
  project: string;
  /** В порядке сред проекта. */
  envs: MultiEnv[];
  terms: Term[];
  excludes?: Term[] | undefined;
  period: SearchPeriod;
  profile: CompiledProfile;
  limits: SearchConfig;
  key: string;
  fresh: boolean;
  owner?: string | undefined;
  /** Чьи это места пула (holderOf). */
  holder?: string | undefined;
  /** Среды строго по очереди: страница короткой ссылки. */
  sequential?: boolean;
}

export type MultiCreate = (key: string, fresh: boolean, make: (id: string) => MultiSearch, scope: JobScope) => { job: MultiSearch; cached: boolean };

/** Запуск поиска по нескольким средам: одна логика на маршрут поиска и короткую ссылку. Разметку справочника привязывает вызывающий. */
export function startMulti(p: MultiStart, create: MultiCreate, deps: EngineDeps): { job: MultiSearch; cached: boolean } {
  const scope: JobScope = { project: p.project, env: p.envs[0]!.id, envs: p.envs.map((e) => e.id), ...(p.owner !== undefined ? { owner: p.owner } : {}), ...(p.holder !== undefined ? { holder: p.holder } : {}) };
  const parallel = new Map<string, number>();
  for (const e of p.envs) if (e.selector && !parallel.has(e.env.backend)) parallel.set(e.env.backend, deps.backends.parallelFor(e.env));
  return create(
    p.key,
    p.fresh,
    (id) => {
      const parts: MultiPart[] = p.envs.map((e) => {
        if (!e.selector) return { env: e.id, store: e.env.backend, job: null, ...(e.error ? { error: e.error } : {}) };
        // Среда считает по одному куску: среды и так идут параллельно в пределах хранилища.
        const spec: SearchSpec = { project: p.project, envId: e.id, env: e.env, selector: e.selector, terms: p.terms, ...(p.excludes?.length ? { excludes: p.excludes } : {}), period: p.period, profile: p.profile, limits: p.limits, ...(e.explore ? { explore: e.explore } : {}) };
        const job = new SearchJob(randomUUID(), p.key, spec, deps);
        // Журнал называет общий поиск: id среды наружу не уходит.
        job.traceId = id;
        return { env: e.id, store: e.env.backend, job };
      });
      const shown = (t: Term) => ({ display: t.display, kind: t.kind });
      return new MultiSearch(id, p.key, parts, {
        project: p.project,
        now: deps.now,
        parallel: (store) => parallel.get(store) ?? 1,
        ...(p.sequential ? { sequential: true } : {}),
        period: p.period,
        terms: p.terms.map(shown),
        ...(p.excludes?.length ? { excludes: p.excludes.map(shown) } : {}),
      });
    },
    scope,
  );
}

/** Задание среды строки: у поиска одной среды само задание, у поиска по нескольким средам — часть из параметра env. */
export function childOf(job: SearchJob | MultiSearch, env: string | undefined): { job: SearchJob } | { code: 'bad-request' | 'request-not-found'; details?: string } {
  if (!(job instanceof MultiSearch)) return { job };
  if (env === undefined) return { code: 'bad-request', details: 'env: среда строки поиска по нескольким средам' };
  const part = job.part(env);
  if (!part) return { code: 'bad-request', details: 'env: этой среды нет в поиске' };
  return part.job ? { job: part.job } : { code: 'request-not-found' };
}

/**
 * Состояние поиска по нескольким средам: сводки размечает справочник своей части, маска как у одной среды, затем у сводки и части
 * ставится среда. Ссылка части в Grafana ставится после маскирования: маска портила бы закодированный адрес.
 */
export function multiStateOut(job: MultiSearch, from: number, catalog: CatalogHook | undefined, log: FastifyBaseLogger, masking: CompiledMasking): SearchState {
  const state = job.state();
  const entries = job.entries(from);
  const requests = entries.map((e) => e.summary);
  if (catalog) {
    for (const [i, p] of job.parts.entries()) {
      const child = p.job;
      if (!child) continue;
      const at = entries.flatMap((e, k) => (e.part === i ? [k] : []));
      // И с пустым списком: новые сводки части уходят в «Неизвестное», как у одной среды.
      const annotated = catalog.summaries(child, at.map((k) => requests[k]!), child.requests, (cid) => child.request(cid));
      at.forEach((k, n) => (requests[k] = annotated[n]!));
    }
  }
  const keep = new Set<string>();
  for (const p of job.parts) for (const id of p.job?.keep ?? []) keep.add(id);
  const parts = state.envs ?? [];
  const masked = maskState({ ...state, requests, envs: parts.map(({ explore: _explore, ...rest }) => rest) }, keep, log, masking);
  return {
    ...masked,
    requests: masked.requests.map((s, k) => ({ ...s, env: job.parts[entries[k]!.part]!.env })),
    envs: (masked.envs ?? []).map((p, i) => ({ ...p, env: job.parts[i]!.env, ...(parts[i]?.explore ? { explore: parts[i].explore } : {}) })),
  };
}

type MultiBody = SearchRequestBody & { envs: string[] };

function parseMultiBody(b: unknown): { ok: true; body: MultiBody } | { ok: false; code: 'bad-request' | 'invalid-terms'; details: string } {
  if (!isObj(b)) return { ok: false, code: 'bad-request', details: 'тело запроса: нужен объект JSON' };
  const { envs, stand, ...rest } = b;
  if (stand !== undefined) return { ok: false, code: 'bad-request', details: 'stand: у поиска по нескольким средам стендов нет' };
  if (!Array.isArray(envs) || !envs.every((e) => typeof e === 'string')) return { ok: false, code: 'bad-request', details: 'envs: список идентификаторов сред' };
  if (envs.length < 2 || envs.length > MAX_SEARCH_ENVS) return { ok: false, code: 'bad-request', details: `envs: от 2 до ${MAX_SEARCH_ENVS} сред` };
  if (new Set(envs).size !== envs.length) return { ok: false, code: 'bad-request', details: 'envs: среда указана дважды' };
  const parsed = parseBody(rest);
  if (!parsed.ok) return parsed;
  return { ok: true, body: { ...parsed.body, envs: envs as string[] } };
}

/** Граница страницы «Всех записей»: null — ошибка, текст для ответа в поле error. */
export function parseLinesCursor(raw: string | undefined, period: { fromMs: number; toMs: number }): { cursor: PageCursor | null } | { error: string } {
  if (raw === undefined) return { cursor: null };
  let cursor: PageCursor;
  try {
    cursor = decodeCursor(raw);
  } catch {
    return { error: 'неверная граница страницы' };
  }
  const t = BigInt(cursor.tsNs);
  if (t < BigInt(Math.trunc(period.fromMs)) * 1_000_000n || t > BigInt(Math.trunc(period.toMs)) * 1_000_000n) return { error: 'граница страницы вне периода поиска' };
  return { cursor };
}

/** Границы запроса: одни правила у ссылки на страницу и у создания короткой ссылки. old — старше срока хранения, в хранилище не ходим. */
export function checkRequestBounds(from: number, to: number, nowMs: number, retentionDays: number): 'ok' | 'old' | { details: string } {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return { details: 'в ссылке нет границ запроса' };
  if (from >= MAX_EPOCH_MS || to >= MAX_EPOCH_MS) return { details: 'в ссылке неверные границы запроса' };
  if (from > to) return { details: 'в ссылке начало запроса позже конца' };
  if (to - from > MAX_PERIOD_MS) return { details: 'в ссылке запрос длиннее 24 часов' };
  return from < nowMs - retentionDays * DAY ? 'old' : 'ok';
}

// ---------- Маршруты ----------

export function registerSearchRoutes(app: FastifyInstance, ctx: SearchRoutesContext): void {
  const { config, backends, jobs, fail } = ctx;
  const limits = config.config.search;
  const deps: EngineDeps = { backends, now: ctx.now, warn: (m) => app.log.warn(m) };
  const notConfigured = (env: EnvironmentConfig) => missingSecret(backends.slotFor(env).cfg);
  const scrub = ctx.scrubOwn ?? ownSecretScrubber(ctx.ownSecrets);
  const maskingFor = (req: FastifyRequest, project: string, viewer: MaskViewer = viewerOf(req)) => viewerMasking(ctx.masking(project), viewer);
  /** Чтения запроса по ссылке: не больше трёх сразу у одного владельца мест. */
  const reads = new HolderReads();

  const profileOf = (project: string): CompiledProfile => {
    const p = ctx.profiles.get(project);
    if (!p) throw new Error(`нет профиля формата у проекта ${project}`);
    return p;
  };

  /** Задание спрашивающего: чужое выглядит как истёкшее. */
  const findJob = (req: FastifyRequest, id: string, poll = false, viewer?: string) => (JOB_ID.test(id) ? jobs.get(id, { poll, viewer, owner: ownerOf(req) }) : undefined);

  app.post<{ Params: EnvParams }>('/api/projects/:project/envs/:env/searches', { config: { access: 'view' } }, async (req, reply) => {
    const env = ctx.resolveEnv(req.params, reply);
    if (!env) return reply;
    const project = config.config.projects[req.params.project]!;
    const parsed = parseBody(req.body);
    if (!parsed.ok) return fail(reply, parsed.code, { details: parsed.details });
    const body = parsed.body;
    const terms = validateTerms(body.terms);
    if (!terms.ok) return fail(reply, 'invalid-terms', { details: termsErrorText(terms.error) });
    const excludes = validateExcludes(body.excludes ?? [], terms.terms);
    if (!excludes.ok) return fail(reply, 'invalid-terms', { details: excludesErrorText(excludes.error) });
    const period = resolvePeriod(body.period, ctx.now(), project.retentionDays);
    if (!period.ok) return fail(reply, 'invalid-period', { details: period.details });
    const selector = standSelector(env, body.stand);
    if (!selector.ok) return fail(reply, 'bad-request', { details: selector.reason });
    const missing = notConfigured(env);
    if (missing) return fail(reply, 'not-configured', { details: `не задана переменная окружения ${missing}` });

    const owner = ownerOf(req);
    const key = searchKey({
      owner,
      project: req.params.project,
      env: req.params.env,
      stand: body.stand === undefined ? undefined : String(Number(body.stand)),
      values: terms.terms.map((t) => t.value),
      excludes: excludes.excludes.map((t) => t.value),
      period: body.period,
    });
    const explore = searchExplore(backends, env, selector.selector, terms.terms, excludes.excludes, period.period, ctx.masking(req.params.project).strict);
    const stand = body.stand === undefined ? undefined : String(Number(body.stand));
    const { job, cached } = startSearch(
      { project: req.params.project, envId: req.params.env, env, selector: selector.selector, stand, terms: terms.terms, excludes: excludes.excludes, period: period.period, profile: profileOf(req.params.project), limits, key, fresh: body.fresh === true, owner, holder: holderOf(req), explore, parallel: backends.parallelFor(env) },
      (k, fresh, make, scope) => jobs.create(k, fresh, make, scope),
      deps,
    );
    ctx.catalog?.bind(job, req.params.project, req.params.env, backends.slotFor(env).cfg.type === 'mock', stand ?? null);
    if (!cached) void ctx.metrics.trackJob('search', job);
    const res: SearchCreated = { id: job.id, cached };
    return res;
  });

  // Поиск по нескольким средам: среды проверяются до значений, неизвестная среда — тот же ответ, что у одной среды.
  app.post<{ Params: { project: string } }>('/api/projects/:project/searches', { config: { access: 'view' } }, async (req, reply) => {
    const parsed = parseMultiBody(req.body);
    if (!parsed.ok) return fail(reply, parsed.code, { details: parsed.details });
    const body = parsed.body;
    const looked = new Map<string, EnvLookup>();
    for (const id of body.envs) {
      const r = ctx.lookupEnv({ project: req.params.project, env: id });
      if (!r.ok && r.code !== 'not-configured') return fail(reply, r.code, r.details ? { details: r.details } : {});
      if (r.ok && r.env.kind === 'pr-stands') return fail(reply, 'bad-request', { details: 'стенды PR ищутся отдельно от других сред' });
      looked.set(id, r);
    }
    const projectId = req.params.project;
    const project = config.config.projects[projectId]!;
    const terms = validateTerms(body.terms);
    if (!terms.ok) return fail(reply, 'invalid-terms', { details: termsErrorText(terms.error) });
    const excludes = validateExcludes(body.excludes ?? [], terms.terms);
    if (!excludes.ok) return fail(reply, 'invalid-terms', { details: excludesErrorText(excludes.error) });
    const period = resolvePeriod(body.period, ctx.now(), project.retentionDays);
    if (!period.ok) return fail(reply, 'invalid-period', { details: period.details });
    const strict = ctx.masking(projectId).strict;
    const ids = orderEnvSet(body.envs, Object.keys(project.environments));
    const envs: MultiEnv[] = ids.map((id) => {
      const r = looked.get(id)!;
      const notReady = (details: string | undefined): MultiEnv => ({ id, env: project.environments[id]!, selector: null, error: { code: 'not-configured', stage: 'count', ...(details ? { details } : {}) } });
      if (!r.ok) return notReady(r.details);
      const missing = notConfigured(r.env);
      if (missing) return notReady(`не задана переменная окружения ${missing}`);
      const selector = standSelector(r.env, undefined);
      if (!selector.ok) return notReady(selector.reason);
      return { id, env: r.env, selector: selector.selector, explore: searchExplore(backends, r.env, selector.selector, terms.terms, excludes.excludes, period.period, strict) };
    });
    // Ни одну среду нельзя читать: ответ тот же, что у одной ненастроенной среды.
    if (envs.every((e) => e.selector === null)) return fail(reply, 'not-configured', { details: envs[0]!.error?.details });
    const owner = ownerOf(req);
    const key = searchKey({ owner, project: projectId, env: ids.join(','), stand: undefined, values: terms.terms.map((t) => t.value), excludes: excludes.excludes.map((t) => t.value), period: body.period });
    const { job, cached } = startMulti(
      { project: projectId, envs, terms: terms.terms, excludes: excludes.excludes, period: period.period, profile: profileOf(projectId), limits, key, fresh: body.fresh === true, owner, holder: holderOf(req) },
      (k, fresh, make, scope) => jobs.create(k, fresh, make, scope),
      deps,
    );
    for (const p of job.parts) if (p.job) ctx.catalog?.bind(p.job, projectId, p.env, backends.slotFor(p.job.spec.env).cfg.type === 'mock', null);
    if (!cached) void ctx.metrics.trackJob('search', job);
    const res: SearchCreated = { id: job.id, cached };
    return res;
  });

  // Опрос хода раз в 0,5 с: строки info на каждый опрос забивали бы журнал, предупреждения и ошибки остаются.
  app.get<{ Params: { id: string }; Querystring: { from?: string; viewer?: string } }>('/api/searches/:id', { config: { access: 'view' }, logLevel: 'warn' }, async (req, reply) => {
    const job = findJob(req, req.params.id, true, tabOf(req.query.viewer));
    if (!job) return fail(reply, 'search-expired');
    const from = parseFrom(req.query.from);
    if (from === null) return fail(reply, 'bad-request', { details: 'from: номер первой сводки, целое число от 0' });
    if (job instanceof MultiSearch) return presentState(req, multiStateOut(job, from, ctx.catalog, app.log, ctx.masking(job.project)));
    const state = job.state(from);
    if (ctx.catalog) state.requests = ctx.catalog.summaries(job, state.requests, job.requests, (cid) => job.request(cid));
    return presentState(req, withExplore(maskState(state, job.keep, app.log, ctx.masking(job.spec.project)), job.spec.explore));
  });

  app.delete<{ Params: { id: string }; Querystring: { leave?: string } }>('/api/searches/:id', { config: { access: 'view' } }, async (req, reply) => {
    const job = findJob(req, req.params.id);
    if (!job) return fail(reply, 'search-expired');
    // leave — вкладка ушла со страницы: другие вкладки этого задания продолжают; без него — явная остановка.
    const leaving = tabOf(req.query.leave);
    if (leaving) jobs.leave(job.id, leaving);
    else job.cancel();
    return reply.code(204).send();
  });

  /** Задание среды строки: у поиска по нескольким средам — часть из ?env=. null — ответ уже отправлен. */
  const childJob = (reply: FastifyReply, job: PoolJob, env: string | undefined): SearchJob | null => {
    const child = childOf(job, env);
    if ('job' in child) return child.job;
    void fail(reply, child.code, child.details ? { details: child.details } : {});
    return null;
  };

  app.get<{ Params: { id: string; cid: string }; Querystring: { env?: string } }>('/api/searches/:id/requests/:cid', { config: { access: 'view' } }, async (req, reply) => {
    const found = findJob(req, req.params.id);
    if (!found) return fail(reply, 'search-expired');
    if (!CID.test(req.params.cid)) return fail(reply, 'bad-request', { details: 'неверный correlation_id' });
    const job = childJob(reply, found, req.query.env);
    if (!job) return reply;
    const stored = job.request(req.params.cid);
    if (!stored) return fail(reply, 'request-not-found');
    const res = detail(stored.summary, stored.records, stored, new Set([req.params.cid]), app.log, maskingFor(req, job.spec.project), ctx.catalog && ((s, v) => ctx.catalog!.jobDetail(job, s, stored, v)));
    const margin = limits.periodMarginMinutes * MINUTE;
    const range = { fromMs: stored.summary.firstMs - margin, toMs: Math.min(stored.summary.lastMs + margin, ctx.now()) };
    return presentDetail(req, withExplore(res, requestExplore(backends, job.spec.env, job.spec.selector, req.params.cid, range)));
  });

  // Показ из задания: записи уже в памяти, к хранилищу не обращается. Разметка и «Неизвестное» не вызываются.
  app.get<{ Params: { id: string; cid: string }; Querystring: { env?: string } }>('/api/searches/:id/requests/:cid/reveal', { config: { access: 'reveal' } }, async (req, reply) => {
    const found = findJob(req, req.params.id);
    if (!found) return fail(reply, 'search-expired');
    if (!CID.test(req.params.cid)) return fail(reply, 'bad-request', { details: 'неверный correlation_id' });
    const job = childJob(reply, found, req.query.env);
    if (!job) return reply;
    const stored = job.request(req.params.cid);
    if (!stored) return fail(reply, 'request-not-found');
    return revealResponse(stored.records, stored, new Set([req.params.cid]), app.log, maskingFor(req, job.spec.project), scrub);
  });

  app.get<{ Params: { id: string }; Querystring: { cursor?: string; env?: string } }>('/api/searches/:id/lines', { config: { access: 'details' } }, async (req, reply) => {
    const found = findJob(req, req.params.id);
    if (!found) return fail(reply, 'search-expired');
    const job = childJob(reply, found, req.query.env);
    if (!job) return reply;
    const parsed = parseLinesCursor(req.query.cursor, job.spec.period);
    if ('error' in parsed) return fail(reply, 'bad-request', { details: parsed.error });
    const { cursor } = parsed;
    const annotated = (page: LinesPage): LinesPage => (ctx.catalog ? { ...page, records: ctx.catalog.lines(job, page.records) } : page);
    const masking = maskingFor(req, job.spec.project);
    if (!cursor && job.firstLinesPage) return linesResponse(annotated(job.firstLinesPage), app.log, masking);
    try {
      const signal = ctx.clientSignal(reply);
      const page = await withQueryTrace({ ...job.trace, requestId: req.id }, () => readLinesPage(deps, job.spec, cursor, signal));
      return linesResponse(annotated(page), app.log, masking);
    } catch (e) {
      return ctx.failBackend(reply, e);
    }
  });

  type LinkRequest = FastifyRequest<{ Params: EnvParams & { cid: string }; Querystring: { from?: string; to?: string; stand?: string } }>;
  interface LinkRead {
    records: ParsedRecord[];
    opts: { readEndMs: number; incomplete: boolean };
    env: EnvironmentConfig;
    selector: Matcher[];
    range: { fromMs: number; toMs: number };
  }

  /** Запрос по ссылке: проверки до обращения к хранилищу и одно чтение окна. null — ответ уже отправлен. */
  const readLink = async (req: LinkRequest, reply: FastifyReply): Promise<LinkRead | null> => {
    const answered = (code: ErrorCode, details?: string) => {
      void fail(reply, code, details === undefined ? {} : { details });
      return null;
    };
    const env = ctx.resolveEnv(req.params, reply);
    if (!env) return null;
    const project = config.config.projects[req.params.project]!;
    // Профиль до чтения, вместе с проектом: скрытие за время чтения не даёт 500, запрос завершается с прежней настройкой.
    const profile = profileOf(req.params.project);
    const { cid } = req.params;
    if (!CID.test(cid)) return answered('bad-request', 'в ссылке неверный correlation_id');
    const selector = standSelector(env, typeof req.query.stand === 'string' ? req.query.stand : undefined);
    if (!selector.ok) return answered('bad-request', selector.reason);
    const bound = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
    const from = bound(req.query.from);
    const to = bound(req.query.to);
    const now = ctx.now();
    const checked = checkRequestBounds(from, to, now, project.retentionDays);
    if (typeof checked === 'object') return answered('bad-request', checked.details);
    // Старше срока хранения: записей в хранилище уже нет, в хранилище не ходим.
    if (checked === 'old') return answered('request-not-found');
    const missing = notConfigured(env);
    if (missing) return answered('not-configured', `не задана переменная окружения ${missing}`);

    const margin = limits.periodMarginMinutes * MINUTE;
    const range = { fromMs: from - margin, toMs: Math.min(to + margin, now) };
    if (range.fromMs > range.toMs) return answered('request-not-found');
    const q: LinesQuery = {
      selector: selector.selector,
      filters: [{ kind: 'contains', value: cid }],
      range,
      limit: limits.maxLinesPerQuery,
      direction: 'forward',
    };
    let read: Awaited<ReturnType<typeof readLines>>;
    const signal = ctx.clientSignal(reply);
    const trace = { project: req.params.project, env: req.params.env, requestId: req.id };
    try {
      // Предел владельца — только вокруг чтения: отказ проверок выше мест не занимает.
      // Записи держатся до ответа: без бюджета, но в пределе памяти одного задания.
      const memory = jobs.memory;
      const budget = memory ? { left: limits.maxLinesPerSearch, memory: readCap(memory.jobLimit) } : limits.maxLinesPerSearch;
      read = await reads.run(holderOf(req), signal, () => withQueryTrace(trace, () => readLines(deps, env, q, budget, signal)));
    } catch (e) {
      void ctx.failBackend(reply, e);
      return null;
    }
    const records = read.lines.map((l) => profile.parse(l)).filter((r) => r.correlationId === cid);
    if (records.length === 0) return answered('request-not-found');
    return { records, opts: { readEndMs: readEnd(read.lines, read.truncated, range.toMs), incomplete: read.truncated }, env, selector: selector.selector, range };
  };

  app.get<{ Params: EnvParams & { cid: string }; Querystring: { from?: string; to?: string; stand?: string } }>(
    '/api/projects/:project/envs/:env/requests/:cid',
    { config: { access: 'view' } },
    async (req, reply) => {
      const read = await readLink(req, reply);
      if (!read) return reply;
      const { cid } = req.params;
      const { records, opts, env } = read;
      const summary = summarize(cid, records, { match: 'exact', ...opts });
      const mock = backends.slotFor(env).cfg.type === 'mock';
      const stored = { records, ...opts };
      const stand = typeof req.query.stand === 'string' ? String(Number(req.query.stand)) : null;
      const res = detail(summary, records, opts, new Set([cid]), app.log, maskingFor(req, req.params.project), ctx.catalog && ((s, v) => ctx.catalog!.linkDetail(req.params.project, req.params.env, mock, stand, s, stored, v)));
      return presentDetail(req, withExplore(res, requestExplore(backends, env, read.selector, cid, read.range)));
    },
  );

  // Показ по ссылке: те же проверки и то же одно чтение окна; кэша открытых записей нет. «Неизвестное» не меняется.
  app.get<{ Params: EnvParams & { cid: string }; Querystring: { from?: string; to?: string; stand?: string } }>(
    '/api/projects/:project/envs/:env/requests/:cid/reveal',
    { config: { access: 'reveal' } },
    async (req, reply) => {
      const read = await readLink(req, reply);
      if (!read) return reply;
      return revealResponse(read.records, read.opts, new Set([req.params.cid]), app.log, maskingFor(req, req.params.project), scrub);
    },
  );
}
