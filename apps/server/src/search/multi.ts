// Поиск по нескольким средам: по заданию поиска на среду, параллельно в пределах
// лимита каждого хранилища. Для пула это одно задание: один id, опрос, остановка, повтор из памяти и короткая ссылка.
// Дочерние задания в пул не попадают, их id наружу не уходят. Записи разных сред не склеиваются: сводка помнит свою часть.

import type { EnvSearchPart, RequestSummary, SearchStage, SearchState, SearchStatus } from '@threadline/core/search';
import type { SearchJob, SearchPeriod } from './engine.ts';
import type { StoredJob } from './jobs.ts';
import type { MemoryGate } from './memory.ts';

type StateError = NonNullable<SearchState['error']>;

/** Часть поиска: среда и её задание. Без задания среда не настроена, часть сразу завершена ошибкой. */
export interface MultiPart {
  env: string;
  /** Хранилище среды: очередь параллельности общая у сред одного хранилища. */
  store: string;
  job: SearchJob | null;
  /** Ошибка части без задания. */
  error?: StateError;
}

export interface MultiOptions {
  /** Проект: настройка маскирования действует на проект. */
  project: string;
  now: () => number;
  /** Сколько заданий одного хранилища идут сразу (parallelFor). */
  parallel: (store: string) => number;
  /** Строго по очереди, одна среда за другой: открытая поверхность короткой ссылки. */
  sequential?: boolean;
  period: SearchPeriod;
  terms: SearchState['terms'];
  excludes?: SearchState['excludes'] | undefined;
}

/** Сводка общего списка и часть, из которой она пришла. */
export interface MultiEntry {
  part: number;
  summary: RequestSummary;
}

const NO_PROGRESS = { chunksDone: 0, chunksTotal: 0, batchesDone: 0, batchesTotal: 0 };

/** Работа идёт по очереди, не больше limit сразу. Остановленное до начала задание не запускается. */
async function runQueue(jobs: readonly SearchJob[], limit: number): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++]!;
      if (job.status !== 'running') continue;
      await job.start();
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, jobs.length)) }, worker));
}

export class MultiSearch implements StoredJob {
  readonly id: string;
  readonly key: string;
  readonly createdAt: number;
  lastAccess: number;
  lastPoll: number;
  readonly parts: readonly MultiPart[];
  readonly #opts: MultiOptions;
  /** Общий список в порядке поступления: только дописывается, опрос с ?from=n получает хвост. */
  readonly #merged: MultiEntry[] = [];
  readonly #taken: number[];
  #cancelled = false;
  #done: Promise<void> = Promise.resolve();

  constructor(id: string, key: string, parts: readonly MultiPart[], opts: MultiOptions) {
    this.id = id;
    this.key = key;
    this.parts = parts;
    this.#opts = opts;
    this.createdAt = opts.now();
    this.lastAccess = this.createdAt;
    this.lastPoll = this.createdAt;
    this.#taken = parts.map(() => 0);
  }

  get project(): string {
    return this.#opts.project;
  }

  /** Вес в пуле: память под результаты та же, что у стольких поисков по одной среде. */
  get weight(): number {
    return this.parts.length;
  }

  /** Память под прочитанное всеми средами. */
  get bytes(): number {
    return this.parts.reduce((n, p) => n + (p.job?.bytes ?? 0), 0);
  }

  /** Шлюз бюджета у каждой среды: предел одного задания считается по среде, доля владельца — по всему поиску. */
  limitMemory(gate: MemoryGate): void {
    for (const p of this.parts) p.job?.limitMemory(gate);
  }

  get done(): Promise<void> {
    return this.#done;
  }

  /** Идёт, пока идёт хоть одна среда; остановлен, если остановлена хоть одна; failed — не удалось ни в одной. */
  get status(): SearchStatus {
    const statuses = this.parts.map(partStatus);
    if (statuses.includes('running')) return 'running';
    if (statuses.includes('cancelled')) return 'cancelled';
    if (statuses.every((s) => s === 'failed')) return 'failed';
    return 'done';
  }

  /** Ошибка хоть одной среды: такой поиск из памяти не повторяется. */
  get error(): StateError | null {
    for (const p of this.parts) {
      const e = partError(p);
      if (e) return e;
    }
    return null;
  }

  start(): Promise<void> {
    const jobs = this.parts.flatMap((p) => (p.job ? [p.job] : []));
    if (this.#opts.sequential) {
      this.#done = runQueue(jobs, 1);
      return this.#done;
    }
    const byStore = new Map<string, SearchJob[]>();
    for (const p of this.parts) {
      if (!p.job) continue;
      const list = byStore.get(p.store);
      if (list) list.push(p.job);
      else byStore.set(p.store, [p.job]);
    }
    this.#done = Promise.all([...byStore].map(([store, list]) => runQueue(list, this.#opts.parallel(store)))).then(() => undefined);
    return this.#done;
  }

  /** Остановка всех сред, в том числе ещё не начатых. Найденное остаётся. */
  cancel(): void {
    this.#cancelled = true;
    for (const p of this.parts) p.job?.cancel();
  }

  get cancelled(): boolean {
    return this.#cancelled;
  }

  part(env: string): MultiPart | undefined {
    return this.parts.find((p) => p.env === env);
  }

  /** Новые сводки частей дописываются в общий список. */
  #sync(): void {
    for (const [i, p] of this.parts.entries()) {
      const list = p.job?.requests ?? [];
      while (this.#taken[i]! < list.length) this.#merged.push({ part: i, summary: list[this.#taken[i]!++]! });
    }
  }

  /** Общий список с индекса from. */
  entries(from = 0): MultiEntry[] {
    this.#sync();
    return this.#merged.slice(from);
  }

  /** Ход и итог каждой среды. */
  partStates(): EnvSearchPart[] {
    return this.parts.map((p) => {
      if (!p.job) {
        return { env: p.env, status: 'failed', stage: 'done', found: null, tooMany: false, truncated: false, scannedFromMs: null, lines: 'unknown', progress: { ...NO_PROGRESS }, requestsTotal: 0, error: p.error ? { ...p.error } : { code: 'unknown', stage: 'count' } };
      }
      const s = p.job.state(p.job.requests.length);
      return {
        env: p.env,
        status: s.status,
        stage: s.stage,
        found: s.found,
        tooMany: s.tooMany,
        truncated: s.truncated,
        ...(s.truncatedBy ? { truncatedBy: s.truncatedBy } : {}),
        scannedFromMs: s.scannedFromMs,
        lines: s.lines,
        progress: s.progress,
        requestsTotal: s.requestsTotal,
        error: s.error,
        ...(s.excluding ? { excluding: s.excluding } : {}),
        ...(p.job.spec.explore ? { explore: p.job.spec.explore } : {}),
      };
    });
  }

  /** Состояние без сводок: их собирает вызывающий из entries(), со справочником и маской своей части. */
  state(): SearchState {
    const parts = this.partStates();
    const status = this.status;
    const running = parts.filter((p) => p.status === 'running');
    const stage: SearchStage = running.length === 0 ? 'done' : running.some((p) => p.stage === 'count') ? 'count' : 'fetch';
    const found = parts.some((p) => p.found !== null) ? parts.reduce((n, p) => n + (p.found ?? 0), 0) : null;
    const lines = parts.some((p) => p.lines === 'some') ? 'some' : parts.every((p) => p.lines === 'none') ? 'none' : 'unknown';
    const progress = { ...NO_PROGRESS };
    for (const p of parts) {
      progress.chunksDone += p.progress.chunksDone;
      progress.chunksTotal += p.progress.chunksTotal;
      progress.batchesDone += p.progress.batchesDone;
      progress.batchesTotal += p.progress.batchesTotal;
    }
    const excluding = parts.some((p) => p.excluding) ? { removed: parts.some((p) => p.excluding?.removed) } : undefined;
    this.#sync();
    const total = this.#merged.length;
    const firstError = parts.find((p) => p.error)?.error ?? null;
    return {
      id: this.id,
      status,
      stage,
      period: { ...this.#opts.period },
      terms: this.#opts.terms.map((t) => ({ ...t })),
      ...(this.#opts.excludes?.length ? { excludes: this.#opts.excludes.map((t) => ({ ...t })) } : {}),
      ...(excluding ? { excluding } : {}),
      found,
      // Предел запросов и строк, граница просмотренного — у каждой части свои.
      tooMany: false,
      truncated: false,
      scannedFromMs: null,
      lines,
      progress,
      requests: [],
      requestsTotal: total,
      // Общая ошибка только когда не удалось ни в одной среде.
      error: status === 'failed' && firstError ? { ...firstError } : null,
      envs: parts,
    };
  }
}

function partStatus(p: MultiPart): SearchStatus {
  return p.job ? p.job.status : 'failed';
}

function partError(p: MultiPart): StateError | null {
  if (!p.job) return p.error ?? { code: 'unknown', stage: 'count' };
  return p.job.error;
}
