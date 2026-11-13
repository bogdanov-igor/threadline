// Задания поиска в памяти: повтор из памяти 60 с, срок жизни 15 мин, не больше 50 мест и 25 на владельца, бюджет памяти, контроль опроса.

import { randomUUID } from 'node:crypto';
import type { SearchStatus } from '@threadline/core/search';
import type { SearchJob } from './engine.ts';
import type { MemoryBudget, MemoryGate, MemoryPool } from './memory.ts';
import type { MultiSearch } from './multi.ts';

/** Задания обычного пула: поиск одной среды, поиск операции и поиск по нескольким средам. */
export type PoolJob = SearchJob | MultiSearch;

/** Что хранилищу нужно от задания. */
export interface StoredJob {
  readonly id: string;
  readonly key: string;
  readonly createdAt: number;
  readonly status: SearchStatus;
  readonly error: unknown;
  lastAccess: number;
  lastPoll: number;
  /** Сколько мест пула занимает задание: поиск по нескольким средам весит по числу сред. Нет поля — одно. */
  readonly weight?: number;
  /** Оценка памяти под прочитанное, байты. Нет поля — задание памяти не держит. */
  readonly bytes?: number;
  /** Пул с бюджетом памяти ставит шлюз: чтение задания спрашивает его, сколько ещё можно оставить. */
  limitMemory?(gate: MemoryGate): void;
  cancel(): void;
}

export interface JobsOptions {
  now?: () => number;
  /** Сколько завершённый поиск отдаётся из памяти. */
  reuseMs?: number;
  /** Срок жизни с последнего обращения. */
  ttlMs?: number;
  maxJobs?: number;
  /** Сколько мест занимает один владелец мест (JobScope.holder). */
  maxPerHolder?: number;
  /** Идущий поиск без опроса состояния дольше этого останавливается: вкладку закрыли. */
  heartbeatMs?: number;
  sweepMs?: number;
  /** false — без таймера чистки, sweep() зовёт вызывающий. */
  timer?: boolean;
  /** Общий бюджет памяти под результаты. Нет — память не ограничена, как раньше. */
  memory?: MemoryBudget;
  /** Пул открытой поверхности коротких ссылок: в бюджете один владелец, вытесняет только свои задания. */
  guest?: boolean;
}

export const REUSE_MS = 60_000;
export const TTL_MS = 15 * 60_000;
export const MAX_JOBS = 50;
/** Половина пула: один человек не держит весь пул. */
export const MAX_JOBS_PER_HOLDER = 25;
export const HEARTBEAT_MS = 90_000;
export const SWEEP_MS = 30_000;
/** Вкладка считается открытой, пока опрашивала состояние так недавно. Опрос идёт раз в 0,5 с, в фоне браузер реже — раз в 1 с. */
export const VIEWER_ALIVE_MS = 3000;

/** Ключ повтора: пользователь, среда, стенд, значения без учёта порядка, выбор периода. Чужой результат другому не отдаётся. Набор сред — env через запятую в порядке проекта. */
export function searchKey(parts: {
  owner?: string;
  project: string;
  env: string;
  stand: string | undefined;
  values: readonly string[];
  /** Исключённые значения: другой набор — другой поиск. Без них ключ прежний. */
  excludes?: readonly string[];
  period: { preset: string } | { fromMs: number; toMs: number };
}): string {
  const values = [...parts.values].sort().join('\u0000');
  const period = 'preset' in parts.period ? parts.period.preset : `${parts.period.fromMs}-${parts.period.toMs}`;
  const key = [parts.owner ?? '', parts.project, parts.env, parts.stand ?? '', values, period];
  if (parts.excludes?.length) key.push(`!${[...parts.excludes].sort().join('\u0000')}`);
  return key.join('|');
}

/** Какой среде принадлежит задание. Отдельно от ключа: ключи бывают проект|среда|… и op|проект|среда|…, разбирать их нельзя. */
export interface JobScope {
  project: string;
  env: string;
  /** Поиск по нескольким средам: все его среды, первая — env. Правка любой из них убирает задание. */
  envs?: readonly string[];
  /** Учётная запись, запустившая задание: для другого пользователя задание выглядит как истёкшее. */
  owner?: string;
  /** Чьи это места пула (holderOf): при auth: off владелец у всех один, а места — по адресу клиента. Нет поля — общий владелец. */
  holder?: string;
}

export class SearchJobs<J extends StoredJob = PoolJob> {
  readonly #now: () => number;
  readonly #reuseMs: number;
  readonly #ttlMs: number;
  readonly #max: number;
  readonly #maxPerHolder: number;
  readonly #heartbeatMs: number;
  /** Порядок вставки — порядок последнего обращения: первым идёт самое давнее. */
  readonly #jobs = new Map<string, J>();
  /** Вкладки, опрашивающие задание: id вкладки → время последнего опроса. */
  readonly #viewers = new Map<string, Map<string, number>>();
  readonly #scopes = new Map<string, JobScope>();
  readonly #timer: ReturnType<typeof setInterval> | undefined;
  readonly #memory: { budget: MemoryBudget; pool: MemoryPool } | undefined;

  constructor(opts: JobsOptions = {}) {
    this.#now = opts.now ?? Date.now;
    this.#reuseMs = opts.reuseMs ?? REUSE_MS;
    this.#ttlMs = opts.ttlMs ?? TTL_MS;
    this.#max = opts.maxJobs ?? MAX_JOBS;
    this.#maxPerHolder = opts.maxPerHolder ?? MAX_JOBS_PER_HOLDER;
    this.#heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
    if (opts.memory) {
      const pool: MemoryPool = {
        guest: opts.guest === true,
        entries: () => [...this.#jobs.values()].map((job) => ({ job, holder: this.#scopes.get(job.id)?.holder })),
        has: (job) => this.#jobs.get(job.id) === job,
        evict: (job) => this.#remove(this.#jobs.get(job.id)!),
      };
      opts.memory.attach(pool);
      this.#memory = { budget: opts.memory, pool };
    }
    if (opts.timer !== false) {
      this.#timer = setInterval(() => this.sweep(), opts.sweepMs ?? SWEEP_MS);
      this.#timer.unref();
    }
  }

  get size(): number {
    return this.#jobs.size;
  }

  /** Бюджет памяти пула: запрос по ссылке берёт отсюда предел одного задания. */
  get memory(): MemoryBudget | undefined {
    return this.#memory?.budget;
  }

  /**
   * Новое задание или завершённое без ошибки с тем же ключом, моложе reuseMs. К идущему заданию
   * новый поиск не присоединяется. fresh — всегда новое. Новое задание запускает вызывающий.
   */
  create<K extends J>(key: string, fresh: boolean, make: (id: string) => K, scope?: JobScope): { job: K; cached: boolean } {
    this.sweep();
    const now = this.#now();
    if (!fresh) {
      let reuse: J | undefined;
      for (const j of this.#jobs.values()) {
        if (j.key !== key || j.status !== 'done' || j.error || now - j.createdAt >= this.#reuseMs) continue;
        if (!reuse || j.createdAt > reuse.createdAt) reuse = j;
      }
      if (reuse) {
        this.#touch(reuse, now);
        // Ключ задаёт вид задания: у поиска по нескольким средам среды через запятую, у операции префикс op|.
        return { job: reuse as K, cached: true };
      }
    }
    const job = make(randomUUID());
    job.lastAccess = now;
    job.lastPoll = now;
    this.#jobs.set(job.id, job);
    if (scope) this.#scopes.set(job.id, scope);
    if (this.#memory) {
      const { budget, pool } = this.#memory;
      job.limitMemory?.((own, want) => budget.grant(pool, job, own, want));
    }
    this.#fit(job);
    return { job, cached: false };
  }

  /**
   * Пределы по весу. Сначала владелец мест сверх своего предела теряет свои самые давние задания. Если мест всё равно больше
   * общего предела, вытесняется самое давнее задание того, кто занимает больше всех: чужой поиск теряется, только если его
   * владелец сам занял больше всех. Новое задание само себя не вытесняет.
   */
  #fit(job: J): void {
    const holderOf = (j: J) => this.#scopes.get(j.id)?.holder;
    const weights = new Map<string | undefined, number>();
    let total = 0;
    for (const j of this.#jobs.values()) {
      const w = j.weight ?? 1;
      weights.set(holderOf(j), (weights.get(holderOf(j)) ?? 0) + w);
      total += w;
    }
    const evict = (j: J) => {
      const w = j.weight ?? 1;
      weights.set(holderOf(j), weights.get(holderOf(j))! - w);
      total -= w;
      this.#remove(j);
    };
    const holder = holderOf(job);
    if (holder !== undefined) {
      for (const j of [...this.#jobs.values()]) {
        if (weights.get(holder)! <= this.#maxPerHolder) break;
        if (j !== job && holderOf(j) === holder) evict(j);
      }
    }
    while (total > this.#max) {
      // Порядок обхода — от самого давнего обращения: строгое «больше» берёт самое давнее задание самого занятого.
      let victim: J | undefined;
      let top = 0;
      for (const j of this.#jobs.values()) {
        const w = weights.get(holderOf(j))!;
        if (j !== job && w > top) {
          victim = j;
          top = w;
        }
      }
      if (!victim) break;
      evict(victim);
    }
  }

  /** Задание по id; обращение продлевает срок жизни. poll — опрос состояния, для контроля опроса; viewer — чья вкладка; owner — кто спрашивает. */
  get(id: string, opts: { poll?: boolean; viewer?: string | undefined; owner?: string | undefined } = {}): J | undefined {
    const job = this.#jobs.get(id);
    if (!job) return undefined;
    // Чужое задание: ответ как при отсутствии, срок жизни и список вкладок не меняются.
    if (opts.owner !== undefined && this.#scopes.get(id)?.owner !== opts.owner) return undefined;
    const now = this.#now();
    if (now - job.lastAccess > this.#ttlMs) {
      this.#remove(job);
      return undefined;
    }
    this.#touch(job, now);
    if (opts.poll) job.lastPoll = now;
    if (opts.poll && opts.viewer) {
      let v = this.#viewers.get(id);
      if (!v) this.#viewers.set(id, (v = new Map()));
      v.set(opts.viewer, now);
    }
    return job;
  }

  /** Какой среде принадлежит задание: короткая ссылка берёт отсюда идентификатор среды. */
  scope(id: string): JobScope | undefined {
    return this.#scopes.get(id);
  }

  /** Задание ещё в памяти. Срок жизни не продлевает. */
  has(id: string): boolean {
    return this.#jobs.has(id);
  }

  /**
   * Вкладка ушла со страницы: задание останавливается, только если других опрашивающих вкладок нет. Ссылка с search=
   * и вторая вкладка подключаются к тому же заданию; их поиск чужой уход не трогает.
   */
  leave(id: string, viewer: string): J | undefined {
    const job = this.get(id);
    if (!job) return undefined;
    const now = this.#now();
    const v = this.#viewers.get(id);
    v?.delete(viewer);
    const others = v ? [...v.values()].some((t) => now - t <= VIEWER_ALIVE_MS) : false;
    if (!others) job.cancel();
    return job;
  }

  /** Остановка задания. Остановленное остаётся в памяти до конца срока. */
  cancel(id: string): J | undefined {
    const job = this.get(id);
    job?.cancel();
    return job;
  }

  /**
   * Правка проекта изменила то, что читается: задания среды (без env — всего проекта) останавливаются и уходят из памяти.
   * Повтор не найдёт их, а открытая страница получит search-expired и покажет «результаты устарели».
   */
  dropScope(project: string, env?: string): void {
    for (const [id, scope] of [...this.#scopes]) {
      if (scope.project !== project || (env !== undefined && scope.env !== env && !scope.envs?.includes(env))) continue;
      const job = this.#jobs.get(id);
      if (job) this.#remove(job);
    }
  }

  /** Удаляет устаревшие задания и останавливает идущие без опроса. */
  sweep(): void {
    const now = this.#now();
    for (const job of [...this.#jobs.values()]) {
      if (now - job.lastAccess > this.#ttlMs) this.#remove(job);
      else if (job.status === 'running' && now - job.lastPoll > this.#heartbeatMs) job.cancel();
    }
  }

  /** Остановка сервера: таймер и все идущие задания. */
  close(): void {
    if (this.#timer) clearInterval(this.#timer);
    for (const job of this.#jobs.values()) if (job.status === 'running') job.cancel();
  }

  #touch(job: J, now: number): void {
    job.lastAccess = now;
    this.#jobs.delete(job.id);
    this.#jobs.set(job.id, job);
  }

  #remove(job: J): void {
    this.#jobs.delete(job.id);
    this.#viewers.delete(job.id);
    this.#scopes.delete(job.id);
    if (job.status === 'running') job.cancel();
  }
}
