// Задания коротких ссылок: отдельный пул, одно задание на ссылку, не больше трёх идущих и десяти в памяти.
// Открытая поверхность не может вытеснить работу вошедшего: в обычном пуле вытеснение отменяет идущий поиск.

import { BackendError, type LinesQuery } from '@threadline/core/backend';
import type { EnvironmentConfig, SearchConfig } from '@threadline/core/config';
import type { CompiledProfile } from '@threadline/core/profile';
import { summarize, type RequestSummary, type SearchState, type SearchStatus } from '@threadline/core/search';
import { withQueryTrace } from '../backends/trace.ts';
import { readEnd, readLines, type EngineDeps, type SearchJob, type SearchPeriod, type StoredRequest } from '../search/engine.ts';
import type { Metrics } from '../metrics.ts';
import { HEARTBEAT_MS, SearchJobs, type JobScope, type StoredJob } from '../search/jobs.ts';
import { JobMemory, type MemoryBudget, type MemoryGate } from '../search/memory.ts';
import type { MultiSearch } from '../search/multi.ts';

export const LINK_REUSE_MS = 5 * 60_000;
export const LINK_TTL_MS = 15 * 60_000;
export const LINK_MAX_JOBS = 10;
/** При maxConcurrent: 4 у Grafana это оставляет место вошедшим. */
export const LINK_MAX_RUNNING = 3;
/** Через сколько предложить повторить, когда предел занят. */
export const LINK_BUSY_RETRY_SECONDS = 5;

type StateError = NonNullable<SearchState['error']>;

function errorOf(e: unknown): StateError {
  if (e instanceof BackendError) return { code: e.code, stage: 'fetch', ...(e.retryAfterSeconds !== undefined ? { retryAfterSeconds: e.retryAfterSeconds } : {}) };
  return { code: 'unknown', stage: 'fetch' };
}

export interface LinkReadSpec {
  project: string;
  env: EnvironmentConfig;
  selector: LinesQuery['selector'];
  cid: string;
  /** Окно запроса с запасом, в пределах срока хранения. */
  range: { fromMs: number; toMs: number };
  /** Период для ответа состояния: сохранённые границы. */
  period: SearchPeriod;
  profile: CompiledProfile;
  limits: SearchConfig;
}

/** Ссылка на запрос: одно чтение окна на всех смотрящих. Живёт в том же пуле, те же пять минут. */
export class LinkReadJob implements StoredJob {
  readonly id: string;
  readonly key: string;
  readonly spec: LinkReadSpec;
  readonly createdAt: number;
  lastAccess: number;
  lastPoll: number;
  status: SearchStatus = 'running';
  error: StateError | null = null;
  readonly keep: Set<string>;
  readonly requests: RequestSummary[] = [];
  readonly memory = new JobMemory();
  readonly #deps: EngineDeps;
  readonly #controller = new AbortController();
  #stored: StoredRequest | null = null;
  #done: Promise<void> = Promise.resolve();

  constructor(id: string, key: string, spec: LinkReadSpec, deps: EngineDeps) {
    this.id = id;
    this.key = key;
    this.spec = spec;
    this.#deps = deps;
    this.createdAt = deps.now();
    this.lastAccess = this.createdAt;
    this.lastPoll = this.createdAt;
    this.keep = new Set([spec.cid]);
  }

  get done(): Promise<void> {
    return this.#done;
  }

  get bytes(): number {
    return this.memory.bytes;
  }

  limitMemory(gate: MemoryGate): void {
    this.memory.gate = gate;
  }

  start(): Promise<void> {
    this.#done = this.#read().catch((e: unknown) => {
      if (this.status !== 'running') return;
      this.error = errorOf(e);
      this.status = 'failed';
    });
    return this.#done;
  }

  async #read(): Promise<void> {
    const { spec } = this;
    const q: LinesQuery = { selector: spec.selector, filters: [{ kind: 'contains', value: spec.cid }], range: spec.range, limit: spec.limits.maxLinesPerQuery, direction: 'forward' };
    const read = await readLines(this.#deps, spec.env, q, { left: spec.limits.maxLinesPerSearch, memory: this.memory.take }, this.#controller.signal);
    if (this.status !== 'running') return;
    const records = read.lines.map((l) => spec.profile.parse(l)).filter((r) => r.correlationId === spec.cid);
    if (records.length > 0) {
      const opts = { readEndMs: readEnd(read.lines, read.truncated, spec.range.toMs), incomplete: read.truncated };
      const summary = summarize(spec.cid, records, { match: 'exact', ...opts });
      this.#stored = { summary, records, ...opts };
      for (const r of records) if (r.requestId) this.keep.add(r.requestId);
      this.requests.push(summary);
    }
    this.status = 'done';
  }

  cancel(): void {
    if (this.status === 'running') this.status = 'cancelled';
    this.#controller.abort();
  }

  request(cid: string): StoredRequest | undefined {
    return this.#stored && cid === this.spec.cid ? this.#stored : undefined;
  }

  state(from = 0): SearchState {
    return {
      id: this.id,
      status: this.status,
      stage: this.status === 'running' ? 'fetch' : 'done',
      period: { ...this.spec.period },
      terms: [],
      found: this.requests.length,
      tooMany: false,
      truncated: false,
      scannedFromMs: null,
      lines: 'none',
      progress: { chunksDone: 0, chunksTotal: 0, batchesDone: 0, batchesTotal: 0 },
      requests: this.requests.slice(from),
      requestsTotal: this.requests.length,
      error: this.error && { ...this.error },
    };
  }
}

/** Поиск ссылки по нескольким средам идёт по очереди среда за средой и считается одним идущим заданием. */
export type LinkJob = SearchJob | LinkReadJob | MultiSearch;

export interface SharePoolOptions {
  now?: () => number;
  /** false — без таймера чистки: тест зовёт sweep() сам. */
  timer?: boolean;
  metrics?: Pick<Metrics, 'trackJob'>;
  /** Общий бюджет памяти под результаты: пул ссылок в нём один владелец и вытесняет только свои задания. */
  memory?: MemoryBudget;
}

export class SharePool {
  readonly #now: () => number;
  readonly #metrics: Pick<Metrics, 'trackJob'> | undefined;
  readonly #jobs: SearchJobs<LinkJob>;
  /** Живые задания по идентификатору ссылки. Наружу идентификатор задания не выходит. */
  readonly #live = new Map<string, string>();
  readonly #active = new Set<LinkJob>();
  readonly #finished = new WeakMap<LinkJob, number>();
  /** Идущие чтения «Всех записей»: не больше одного на ссылку и в пределах трёх идущих. */
  readonly #reads = new Set<string>();

  constructor(opts: SharePoolOptions = {}) {
    this.#now = opts.now ?? Date.now;
    this.#metrics = opts.metrics;
    this.#jobs = new SearchJobs<LinkJob>({
      now: this.#now,
      maxJobs: LINK_MAX_JOBS,
      reuseMs: LINK_REUSE_MS,
      ttlMs: LINK_TTL_MS,
      heartbeatMs: HEARTBEAT_MS,
      ...(opts.timer === false ? { timer: false } : {}),
      ...(opts.memory ? { memory: opts.memory, guest: true } : {}),
    });
  }

  #running(): number {
    let n = this.#reads.size;
    for (const j of this.#active) if (j.status === 'running') n++;
    return n;
  }

  /**
   * Присоединиться к идущему заданию ссылки, взять завершённое без ошибки из памяти или запустить новое.
   * null — идёт три поиска: запросов к хранилищу нет. Запускает задание сам пул.
   */
  run(linkId: string, make: (create: (m: (id: string) => LinkJob, scope: JobScope) => LinkJob) => LinkJob): { job: LinkJob; cached: boolean } | null {
    this.#forgetGone();
    const id = this.#live.get(linkId);
    const cur = id ? this.#jobs.get(id) : undefined;
    if (cur?.status === 'running') return { job: cur, cached: true };
    if (cur?.status === 'done' && !cur.error && this.#now() - (this.#finished.get(cur) ?? cur.createdAt) < LINK_REUSE_MS) return { job: cur, cached: true };
    if (this.#running() >= LINK_MAX_RUNNING) return null;
    const key = `link:${linkId}`;
    const job = make((m, scope) => this.#jobs.create(key, true, m, scope).job);
    this.#live.set(linkId, job.id);
    this.#active.add(job);
    // Подпись журнала для заданий, которые не ставят её сами: поиск операции и чтение запроса. Поиск ставит свою внутри.
    const scope = this.#jobs.scope(job.id);
    const trace = { search: job.id, ...(scope ? { project: scope.project, env: scope.env } : {}) };
    void withQueryTrace(trace, () => (this.#metrics ? this.#metrics.trackJob('link', job) : job.start())).then(() => {
      this.#finished.set(job, this.#now());
      this.#active.delete(job);
    });
    return { job, cached: false };
  }

  /** Задание ссылки. poll — опрос состояния: контроль опроса останавливает поиск, который никто не смотрит. */
  find(linkId: string, opts: { poll?: boolean } = {}): LinkJob | undefined {
    const id = this.#live.get(linkId);
    return id ? this.#jobs.get(id, opts) : undefined;
  }

  /** Начать чтение страницы «Всех записей». false — предел занят или эта ссылка уже читает. */
  beginRead(linkId: string): boolean {
    if (this.#reads.has(linkId) || this.#running() >= LINK_MAX_RUNNING) return false;
    this.#reads.add(linkId);
    return true;
  }

  endRead(linkId: string): void {
    this.#reads.delete(linkId);
  }

  dropScope(project: string, env?: string): void {
    this.#jobs.dropScope(project, env);
  }

  sweep(): void {
    this.#jobs.sweep();
  }

  close(): void {
    this.#jobs.close();
  }

  get size(): number {
    return this.#jobs.size;
  }

  #forgetGone(): void {
    for (const [link, id] of this.#live) if (!this.#jobs.has(id)) this.#live.delete(link);
  }
}
