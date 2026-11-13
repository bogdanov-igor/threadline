// Задание поиска: первый проход подсчётом по кускам, второй — пакетами по окнам своих кусков,
// пределы, точное совпадение номера карты.

import { BackendError, lineTest, negateFilter, type Filter, type LinesQuery, type LogLine, type Matcher } from '@threadline/core/backend';
import type { EnvironmentConfig, SearchConfig } from '@threadline/core/config';
import { isCountKey, type CompiledProfile } from '@threadline/core/profile';
import {
  buildView,
  summarize,
  tsNsToMs,
  type ExploreLink,
  type ParsedRecord,
  type PeriodPreset,
  type RequestSummary,
  type SearchStage,
  type SearchState,
  type SearchStatus,
  type Term,
  type ViewRecord,
} from '@threadline/core/search';
import { SERIES_LIMIT } from '../backends/errors.ts';
import { escapeRegex } from '../backends/logql.ts';
import type { Backends } from '../backends/registry.ts';
import { withQueryTrace, type QueryTrace } from '../backends/trace.ts';
import { runInOrder } from './in-order.ts';
import { JobMemory, lineBytes, type MemoryGate } from './memory.ts';
import { lineHash, readPage, type PageCursor } from './paging.ts';

/** «Все записи»: строк на странице и страниц хранилища на один вызов. */
export const LINES_PAGE_SIZE = 100;
export const LINES_MAX_STORAGE_PAGES = 5;

const MINUTE = 60_000;

export interface SearchPeriod {
  fromMs: number;
  toMs: number;
  preset: PeriodPreset | null;
}

/** Что ищется и где. Всё проверено до создания задания. */
export interface SearchSpec {
  /** Проект: настройка маскирования действует на проект. */
  project: string;
  /** Идентификатор среды: только для журнала. */
  envId?: string | undefined;
  env: EnvironmentConfig;
  /** Селектор среды с подставленным стендом. */
  selector: Matcher[];
  /** Номер стенда: его сохраняет короткая ссылка, селектор она собирает заново. */
  stand?: string | undefined;
  terms: Term[];
  /** «Не содержит»: в списке запросов убирает запрос целиком, во «Всех записях» строки, как `!=` в Grafana. У поиска операции поля нет. */
  excludes?: Term[] | undefined;
  period: SearchPeriod;
  /** Профиль формата проекта: разбор строк и выражение подсчёта. */
  profile: CompiledProfile;
  limits: SearchConfig;
  /** Ссылка в интерфейс хранилища, считается при создании задания. Нет поля — ссылки нет, в том числе у операции. */
  explore?: ExploreLink;
  /**
   * Сколько кусков первого прохода идут сразу. Нет поля — по одному: поиск по нескольким средам и поиск ссылки
   * уже делят места хранилища между своими заданиями.
   */
  parallel?: number;
}

export interface EngineDeps {
  backends: Backends;
  now: () => number;
  /** Журнал сервера. Сюда не попадают ни значения поиска, ни содержимое строк. */
  warn: (message: string) => void;
}

export interface Interval {
  fromMs: number;
  toMs: number;
}

export interface Batch extends Interval {
  cids: string[];
}

/** Записи запроса из второго прохода, немаскированные. */
export interface StoredRequest {
  summary: RequestSummary;
  records: ParsedRecord[];
  readEndMs: number;
  incomplete: boolean;
}

/** Страница «Всех записей», немаскированная. */
export interface LinesPage {
  records: ViewRecord[];
  next: PageCursor | null;
}

type SearchError = NonNullable<SearchState['error']>;

/** Куски первого прохода от конца периода к началу; последний (самый ранний) может быть короче. */
export function countChunks(period: Interval, chunkMinutes: number): Interval[] {
  const size = chunkMinutes * MINUTE;
  const out: Interval[] = [];
  for (let end = period.toMs; end > period.fromMs; end -= size) {
    out.push({ fromMs: Math.max(period.fromMs, end - size), toMs: end });
  }
  return out;
}

/**
 * Пакеты второго прохода: cid по времени самого раннего куска (свежие первыми), подряд не больше batchSize.
 * Окно пакета — его куски ±margin, в пределах периода ±margin и не позже nowMs.
 */
export function planBatches(
  found: ReadonlyMap<string, readonly number[]>,
  chunks: readonly Interval[],
  period: Interval,
  limits: Pick<SearchConfig, 'batchSize' | 'periodMarginMinutes'>,
  nowMs: number,
): Batch[] {
  const span = (cid: string) => {
    const idx = found.get(cid) ?? [];
    return {
      from: Math.min(...idx.map((i) => chunks[i]!.fromMs)),
      to: Math.max(...idx.map((i) => chunks[i]!.toMs)),
    };
  };
  const spans = new Map([...found.keys()].map((cid) => [cid, span(cid)]));
  const sorted = [...found.keys()].sort((a, b) => {
    const x = spans.get(a)!;
    const y = spans.get(b)!;
    return y.from - x.from || y.to - x.to || (a < b ? -1 : a > b ? 1 : 0);
  });
  const margin = limits.periodMarginMinutes * MINUTE;
  const batches: Batch[] = [];
  for (let i = 0; i < sorted.length; i += limits.batchSize) {
    const cids = sorted.slice(i, i + limits.batchSize);
    const from = Math.min(...cids.map((c) => spans.get(c)!.from));
    const to = Math.max(...cids.map((c) => spans.get(c)!.to));
    batches.push({
      cids,
      fromMs: Math.max(from - margin, period.fromMs - margin),
      toMs: Math.min(to + margin, period.toMs + margin, nowMs),
    });
  }
  return batches;
}

const DIGITS_AROUND = (core: string) => new RegExp(`(?<!\\d)${core}(?!\\d)`);

interface NumberCheck {
  full: RegExp;
  masked: RegExp;
}

/** Для pan и number — проверка полного номера и его маски в строке. */
function numberChecks(terms: readonly Term[]): { checks: NumberCheck[]; maskTerm: boolean } {
  const checks: NumberCheck[] = [];
  let maskTerm = false;
  for (const t of terms) {
    if ((t.kind === 'pan' || t.kind === 'number') && t.pan) {
      const p = t.pan;
      checks.push({
        full: DIGITS_AROUND(p),
        masked: DIGITS_AROUND(`${p.slice(0, 6)}\\*{${p.length - 10}}${p.slice(-4)}`),
      });
    }
    if (t.kind === 'pan-mask') maskTerm = true;
  }
  return { checks, maskTerm };
}

/**
 * Совпадение запроса по номеру: полный номер в какой-нибудь строке — exact; только маска — inexact;
 * ни того ни другого (другая карта с теми же краями) — null, запрос отбрасывается. Маска в поиске — всегда inexact.
 */
export function requestMatch(lines: readonly string[], terms: readonly Term[]): 'exact' | 'inexact' | null {
  const { checks, maskTerm } = numberChecks(terms);
  let inexact = maskTerm;
  for (const c of checks) {
    if (lines.some((l) => c.full.test(l))) continue;
    if (!lines.some((l) => c.masked.test(l))) return null;
    inexact = true;
  }
  return inexact ? 'inexact' : 'exact';
}

/** То же для одной строки «Всех записей»: 'drop' — строка другой карты; null — поиск не по номеру. */
export function lineMatch(line: string, terms: readonly Term[]): 'exact' | 'inexact' | null | 'drop' {
  const { checks, maskTerm } = numberChecks(terms);
  if (checks.length === 0 && !maskTerm) return null;
  return requestMatch([line], terms) ?? 'drop';
}

/** Запись «Всех записей»: без смещения и без связи отправки и ответа — соседние строки из разных запросов. */
export function flatRecord(rec: ParsedRecord, match: 'exact' | 'inexact' | null): ViewRecord {
  const v = buildView([rec], { withOffsets: false })[0]!;
  // id уникален между страницами: время и хэш строки, а не номер в странице.
  const id = `${rec.tsNs}-${parseInt(lineHash(rec.tsNs, rec.line).slice(0, 7), 16)}`;
  const http = v.http && { ...v.http, durationMs: null, pairId: null, noResponse: false, pending: false };
  return { ...v, id, http, match };
}

/** Условия исключения задания: только «Все записи». Первый проход и записи запроса идут без них: окно чтения и пределы те же, что у поиска без условия, а открытый запрос всегда целый. */
const excludeFilters = (spec: SearchSpec): Filter[] => (spec.excludes ?? []).map((t) => negateFilter(t.filter));

/** Запись запроса с исключённым значением убирает из списка весь запрос. Условия те же, что уходят в хранилище: номер карты — по шаблону краёв. */
function excludeCheck(spec: SearchSpec): (line: string) => boolean {
  const tests = (spec.excludes ?? []).map((t) => lineTest(t.filter));
  return (line) => tests.some((hits) => hits(line));
}

/** Фильтры значений поиска: первый проход. */
const termFilters = (spec: SearchSpec): Filter[] => spec.terms.map((t) => t.filter);

/** Фильтры «Всех записей»: значения поиска и исключения. */
const lineFilters = (spec: SearchSpec): Filter[] => [...termFilters(spec), ...excludeFilters(spec)];

/** Страница «Всех записей»: от новых к старым, отсев чужих карт, дочитывание до LINES_MAX_STORAGE_PAGES страниц. */
export async function readLinesPage(
  deps: EngineDeps,
  spec: SearchSpec,
  cursor: PageCursor | null,
  signal: AbortSignal,
): Promise<LinesPage> {
  const q: LinesQuery = {
    selector: spec.selector,
    filters: lineFilters(spec),
    range: { fromMs: spec.period.fromMs, toMs: spec.period.toMs },
    limit: LINES_PAGE_SIZE,
    direction: 'backward',
  };
  const out: ViewRecord[] = [];
  let cur = cursor;
  // Страницы хранилища всегда полные: с меньшим пределом уже отданные строки на границе
  // занимают всю страницу, и чтение решило бы, что в одной наносекунде строк больше предела.
  for (let page = 0; page < LINES_MAX_STORAGE_PAGES; page++) {
    const res = await readPage(deps.backends, spec.env, q, cur, signal, { warn: deps.warn });
    let used = res.lines.length;
    for (const [i, l] of res.lines.entries()) {
      const m = lineMatch(l.line, spec.terms);
      if (m !== 'drop') out.push(flatRecord(spec.profile.parse(l), m));
      if (out.length === LINES_PAGE_SIZE) {
        used = i + 1;
        break;
      }
    }
    if (used < res.lines.length) return { records: out, next: cursorAfter(res.lines.slice(0, used), cur) };
    cur = res.next;
    if (!cur || out.length === LINES_PAGE_SIZE) break;
  }
  return { records: out, next: cur };
}

/** Граница сразу после отданных строк, когда страница набрана посреди ответа хранилища. */
function cursorAfter(used: LogLine[], prev: PageCursor | null): PageCursor {
  const last = BigInt(used[used.length - 1]!.tsNs);
  const seen = new Set(prev && BigInt(prev.tsNs) === last ? prev.seen : []);
  for (const l of used) if (BigInt(l.tsNs) === last) seen.add(lineHash(l.tsNs, l.line));
  return { tsNs: last.toString(), seen: [...seen] };
}

/** Предел строк, общий для нескольких чтений, идущих сразу: каждое берёт из него строки страница за страницей. */
export interface LineBudget {
  left: number;
  /** Память под строки (JobMemory.take): сколько байт из запрошенных чтение может оставить. Нет поля — без предела памяти. */
  memory?: (want: number) => number;
}

/** Итог чтения: truncated — оборвано пределом, memory — пределом памяти, а не строк. */
export interface ReadResult {
  lines: LogLine[];
  truncated: boolean;
  memory: boolean;
}

/**
 * Все строки запроса страницами forward, пока не кончатся или не исчерпан предел строк или памяти: число — свой предел чтения,
 * LineBudget — общий с другими чтениями. truncated — чтение оборвано пределом, часть строк не прочитана. Отказ памяти обнуляет
 * предел строк: другие чтения того же предела дальше не идут.
 */
export async function readLines(deps: EngineDeps, env: EnvironmentConfig, q: LinesQuery, budget: number | LineBudget, signal: AbortSignal): Promise<ReadResult> {
  const pool: LineBudget = typeof budget === 'number' ? { left: budget } : budget;
  const lines: LogLine[] = [];
  if (pool.left <= 0) return { lines, truncated: true, memory: false };
  let cursor: PageCursor | null = null;
  let query = q;
  // Страницы полные, лишнее отрезается здесь: см. readLinesPage.
  for (;;) {
    const page = await readPage(deps.backends, env, query, cursor, signal, { warn: deps.warn });
    // Страница не поместилась в предел ответа: дальше чтение идёт меньшими страницами.
    if (page.limit !== undefined) query = { ...query, limit: page.limit };
    let take = Math.min(page.lines.length, Math.max(0, pool.left));
    let denied = false;
    if (pool.memory && take > 0) {
      const costs = page.lines.slice(0, take).map((l) => lineBytes(l.line));
      const want = costs.reduce((n, c) => n + c, 0);
      const granted = pool.memory(want);
      if (granted < want) {
        let n = 0;
        for (let acc = 0; n < take && acc + costs[n]! <= granted; n++) acc += costs[n]!;
        take = n;
        denied = true;
      }
    }
    for (let i = 0; i < take; i++) lines.push(page.lines[i]!);
    pool.left -= take;
    if (denied) {
      pool.left = 0;
      return { lines, truncated: true, memory: true };
    }
    if (take < page.lines.length) return { lines, truncated: true, memory: false };
    if (!page.next) return { lines, truncated: false, memory: false };
    if (pool.left <= 0) return { lines, truncated: true, memory: false };
    cursor = page.next;
  }
}

/** Конец прочитанного: конец окна или время последней строки, если чтение оборвано пределом. */
export function readEnd(lines: readonly LogLine[], truncated: boolean, windowEndMs: number): number {
  const last = lines[lines.length - 1];
  return truncated && last ? tsNsToMs(last.tsNs) : windowEndMs;
}

const isCancel = (e: unknown, signal: AbortSignal) => signal.aborted || (e instanceof BackendError && e.code === 'cancelled');

function errorOf(e: unknown, stage: SearchError['stage']): SearchError {
  if (e instanceof BackendError) {
    const out: SearchError = { code: e.code, stage };
    if (e.details) out.details = e.details;
    if (e.retryAfterSeconds !== undefined) out.retryAfterSeconds = e.retryAfterSeconds;
    return out;
  }
  return { code: 'unknown', stage };
}

const errorName = (e: unknown) => (e instanceof Error ? e.name : typeof e);

export class SearchJob {
  readonly id: string;
  readonly key: string;
  readonly spec: SearchSpec;
  readonly createdAt: number;
  lastAccess: number;
  lastPoll: number;
  /** Каким поиском подписаны запросы к хранилищу в журнале: у среды поиска по нескольким средам — общий поиск. */
  traceId: string;

  status: SearchStatus = 'running';
  stage: SearchStage = 'count';
  found: number | null = null;
  tooMany = false;
  truncated = false;
  scannedFromMs: number | null = null;
  lines: SearchState['lines'] = 'unknown';
  error: SearchError | null = null;
  /** Чтение оборвал предел памяти, а не строк. */
  truncatedBy: 'memory' | null = null;
  /** Память под прочитанное: предел задания и бюджет пула. */
  readonly memory = new JobMemory();
  readonly progress = { chunksDone: 0, chunksTotal: 0, batchesDone: 0, batchesTotal: 0 };

  /**
   * Сводки в порядке поступления, только дописываются: опрос с ?from=n получает хвост.
   * От новых к старым сортирует интерфейс; внутри пакета сводки уже идут от новых к старым.
   */
  readonly requests: RequestSummary[] = [];
  /** correlation_id и request_id задания: маскирование их не трогает. */
  readonly keep = new Set<string>();
  /** Первая страница «Всех записей», если её загрузил пустой первый проход. */
  firstLinesPage: LinesPage | null = null;

  readonly #deps: EngineDeps;
  readonly #controller = new AbortController();
  readonly #stored = new Map<string, StoredRequest>();
  #linesRead = 0;
  /** «Не содержит» убрало хотя бы один запрос, который первый проход нашёл. */
  #removed = false;
  #done: Promise<void> = Promise.resolve();

  constructor(id: string, key: string, spec: SearchSpec, deps: EngineDeps) {
    this.id = id;
    this.key = key;
    this.spec = spec;
    this.#deps = deps;
    this.createdAt = deps.now();
    this.lastAccess = this.createdAt;
    this.lastPoll = this.createdAt;
    this.traceId = id;
  }

  /** Подпись запросов задания к хранилищу. */
  get trace(): QueryTrace {
    return { search: this.traceId, project: this.spec.project, ...(this.spec.envId ? { env: this.spec.envId } : {}) };
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  /** Завершение задания, в том числе остановкой. Не отклоняется. */
  get done(): Promise<void> {
    return this.#done;
  }

  start(): Promise<void> {
    this.#done = withQueryTrace(this.trace, () => this.#run()).catch((e: unknown) => {
      // Непредвиденная ошибка кода: в журнал только тип, текст может содержать строки логов.
      this.#deps.warn(`поиск ${this.id} прерван ошибкой ${errorName(e)}`);
      if (this.status === 'running') {
        this.error = { code: 'unknown', stage: this.stage === 'count' ? 'count' : 'fetch' };
        this.#finish();
      }
    });
    return this.#done;
  }

  /** Остановка: прерывает запросы к хранилищу, найденное остаётся. */
  cancel(): void {
    if (this.status === 'running') {
      this.status = 'cancelled';
      this.stage = 'done';
    }
    this.#controller.abort();
  }

  request(cid: string): StoredRequest | undefined {
    return this.#stored.get(cid);
  }

  /** Оценка памяти под прочитанное, байты. */
  get bytes(): number {
    return this.memory.bytes;
  }

  limitMemory(gate: MemoryGate): void {
    this.memory.gate = gate;
  }

  /** Предел чтения: строки и память под них. Память общая на все чтения задания. */
  protected readBudget(lines: number): LineBudget {
    return { left: lines, memory: this.memory.take };
  }

  /** Итог чтения: предел памяти запоминается как причина обрыва. */
  protected noteRead(read: ReadResult): void {
    if (read.truncated) this.truncated = true;
    if (read.memory) this.truncatedBy = 'memory';
  }

  state(from = 0): SearchState {
    return {
      id: this.id,
      status: this.status,
      stage: this.stage,
      period: { ...this.spec.period },
      terms: this.spec.terms.map((t) => ({ display: t.display, kind: t.kind })),
      ...(this.spec.excludes?.length ? { excludes: this.spec.excludes.map((t) => ({ display: t.display, kind: t.kind })), excluding: { removed: this.#removed } } : {}),
      found: this.found,
      tooMany: this.tooMany,
      truncated: this.truncated,
      ...(this.truncatedBy ? { truncatedBy: this.truncatedBy } : {}),
      scannedFromMs: this.scannedFromMs,
      lines: this.lines,
      progress: { ...this.progress },
      requests: this.requests.slice(from),
      requestsTotal: this.requests.length,
      error: this.error && { ...this.error },
    };
  }

  #finish(): void {
    if (this.status !== 'running') return;
    this.status = this.error ? 'failed' : 'done';
    this.stage = 'done';
  }

  async #run(): Promise<void> {
    const { spec } = this;
    const signal = this.signal;
    const found = await this.#countPass(signal);
    if (found === null || this.status !== 'running') return;

    if (found.size === 0) {
      if (!this.error) await this.#probeLines(signal);
      return this.#finish();
    }

    this.stage = 'fetch';
    const chunks = countChunks(spec.period, spec.limits.countChunkMinutes);
    const batches = planBatches(found, chunks, spec.period, spec.limits, this.#deps.now());
    this.progress.batchesTotal = batches.length;
    for (const batch of batches) {
      // Предел строк исчерпан ровно на границе пакета: следующий не читается и не считается прочитанным.
      if (this.#linesRead >= spec.limits.maxLinesPerSearch) {
        this.truncated = true;
        break;
      }
      try {
        await this.#fetchBatch(batch, signal);
      } catch (e) {
        if (isCancel(e, signal)) return;
        // Ошибка первого прохода важнее: с ней и граница просмотренного периода (scannedFromMs).
        if (!this.error) this.error = errorOf(e, 'fetch');
        return this.#finish();
      }
      if (this.status !== 'running') return;
      this.progress.batchesDone++;
      // Предел строк: остальные пакеты не читаются.
      if (this.truncated) break;
    }
    // Все найденные первым проходом запросы отсеяны вторым (другая карта с теми же краями или correlation_id,
    // который разбор записи не назначает): как при пустом первом проходе, проверяются строки без запросов.
    if (this.requests.length === 0 && !this.truncated && !this.error) await this.#probeLines(signal);
    this.#finish();
  }

  /**
   * Первый проход. null — остановлен или результата для второго прохода нет (слишком много). Куски идут параллельно, не больше
   * spec.parallel, а итоги складываются строго по порядку: предел запросов, ошибка куска и просмотренный период те же, что
   * при подсчёте по одному. Остановка прерывает уже начатые куски, их итог не учитывается.
   */
  async #countPass(signal: AbortSignal): Promise<Map<string, number[]> | null> {
    const { spec } = this;
    const chunks = countChunks(spec.period, spec.limits.countChunkMinutes);
    this.progress.chunksTotal = chunks.length;
    const filters = termFilters(spec);
    const found = new Map<string, number[]>();
    const stage = new AbortController();
    const counting = AbortSignal.any([signal, stage.signal]);
    let stop = null as 'cancel' | 'finish' | null;
    const halt = (how: typeof stop): false => {
      stop = how;
      stage.abort();
      return false;
    };

    await runInOrder(
      chunks,
      spec.parallel ?? 1,
      async (chunk): Promise<{ counts: Record<string, number> } | { failure: unknown }> => {
        try {
          return { counts: await this.#deps.backends.countBy(spec.env, { selector: spec.selector, filters, range: { ...chunk }, key: { regexp: spec.profile.countRegexp } }, counting) };
        } catch (failure) {
          return { failure };
        }
      },
      (result, i) => {
        if ('failure' in result) {
          const e = result.failure;
          if (isCancel(e, signal)) return halt('cancel');
          if (e instanceof BackendError && e.code === 'limit' && SERIES_LIMIT.test(e.details ?? '')) {
            // Лимит рядов Loki: запросов в куске больше, чем хранилище согласно посчитать.
            // Другие лимиты (байты, строки, длина интервала) — обычная ошибка куска ниже.
            this.tooMany = true;
            this.found = null;
            return halt('finish');
          }
          // Второй проход идёт по тому, что уже найдено.
          this.error = errorOf(e, 'count');
          return halt(null);
        }
        if (this.status !== 'running') return halt('cancel');
        for (const [cid, n] of Object.entries(result.counts)) {
          // null, true, false: выведенное выражение взяло литерал JSON — такой «запрос» занял бы место в пакете.
          if (!isCountKey(cid) || !(n > 0)) continue;
          const at = found.get(cid);
          if (at) at.push(i);
          else found.set(cid, [i]);
        }
        this.scannedFromMs = chunks[i]!.fromMs;
        this.progress.chunksDone = i + 1;
        if (found.size > spec.limits.maxRequests) {
          this.tooMany = true;
          this.found = found.size;
          return halt('finish');
        }
        return true;
      },
    );
    if (stop === 'cancel') return null;
    if (stop === 'finish') {
      this.#finish();
      return null;
    }
    this.found = found.size;
    for (const cid of found.keys()) this.keep.add(cid);
    return found;
  }

  async #fetchBatch(batch: Batch, signal: AbortSignal): Promise<void> {
    const { spec } = this;
    const q: LinesQuery = {
      selector: spec.selector,
      filters: [{ kind: 'regex', pattern: batch.cids.map(escapeRegex).join('|') }],
      range: { fromMs: batch.fromMs, toMs: batch.toMs },
      limit: spec.limits.maxLinesPerQuery,
      direction: 'forward',
    };
    const read = await readLines(this.#deps, spec.env, q, this.readBudget(spec.limits.maxLinesPerSearch - this.#linesRead), signal);
    if (signal.aborted) return;
    const { lines, truncated } = read;
    this.#linesRead += lines.length;
    const readEndMs = readEnd(lines, truncated, batch.toMs);
    this.noteRead(read);

    const inBatch = new Set(batch.cids);
    const groups = new Map<string, ParsedRecord[]>();
    for (const l of lines) {
      const rec = spec.profile.parse(l);
      if (rec.correlationId === null || !inBatch.has(rec.correlationId)) continue;
      const g = groups.get(rec.correlationId);
      if (g) g.push(rec);
      else groups.set(rec.correlationId, [rec]);
    }

    const excluded = excludeCheck(spec);
    const summaries: RequestSummary[] = [];
    for (const cid of batch.cids) {
      const records = groups.get(cid) ?? [];
      // Пакет оборван пределом: запрос не отбрасывается ни без прочитанных строк, ни без строки с номером —
      // полный номер может быть в непрочитанной части. Такой запрос — «записи неполные», при поиске по номеру неточный.
      if (records.length === 0 && !truncated) continue;
      const match =
        requestMatch(
          records.map((r) => r.line),
          spec.terms,
        ) ?? (truncated ? 'inexact' : null);
      if (match === null) continue;
      const summarized = summarize(cid, records, { match, readEndMs, incomplete: truncated });
      // Ничего не прочитано: время запроса — место обрыва.
      const summary = records.length > 0 ? summarized : { ...summarized, firstMs: readEndMs, lastMs: readEndMs };
      // Запрос с исключённым значением остаётся открываемым: к нему ведёт «К запросу» из «Всех записей».
      this.#stored.set(cid, { summary, records, readEndMs, incomplete: truncated });
      for (const r of records) if (r.requestId) this.keep.add(r.requestId);
      if (records.some((r) => excluded(r.line))) this.#removed = true;
      else summaries.push(summary);
    }
    summaries.sort((a, b) => b.firstMs - a.firstMs);
    this.requests.push(...summaries);
  }

  /**
   * Запросов нет (пустой первый проход или все найденные отсеяны вторым): есть ли строки без запросов.
   * Первая страница сохраняется для вкладки «Все записи».
   */
  async #probeLines(signal: AbortSignal): Promise<void> {
    try {
      const page = await readLinesPage(this.#deps, this.spec, null, signal);
      if (this.status !== 'running') return;
      this.firstLinesPage = page;
      // До 100 записей: держатся без шлюза, но входят в память задания.
      this.memory.extra += page.records.reduce((n, r) => n + lineBytes(r.raw), 0);
      this.lines = page.records.length > 0 || page.next !== null ? 'some' : 'none';
    } catch (e) {
      if (isCancel(e, signal)) return;
      if (!this.error) this.error = errorOf(e, 'fetch');
    }
  }
}
