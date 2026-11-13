// Память под результаты: оценка прочитанного, общий бюджет от предела кучи V8,
// предел одного задания, доля владельца мест и вытеснение самых давних завершённых результатов.

import { getHeapStatistics } from 'node:v8';

/** Доля предела кучи под результаты: остальное — сам сервер, ответы хранилища в разборе и запас сборщику мусора. */
export const BUDGET_SHARE = 1 / 3;
/** Одно задание держит не больше этой доли бюджета: своё чтение, без записей прежнего задания у дополнения операции. */
export const JOB_SHARE = 1 / 4;
/** Один владелец мест держит не больше этой доли бюджета, как 25 мест из 50. */
export const HOLDER_SHARE = 1 / 2;
/** Сверх текста на запись: сводка, поля разбора, у операции хэши строк и сборка (замер). */
export const RECORD_OVERHEAD = 512;

/**
 * Оценка памяти под одну прочитанную строку, байты (замер). Запись держит текст дважды. Сама строка: V8 хранит строку
 * только из Latin-1 по байту на знак, с любым другим знаком по два (Latin-1 вне ASCII считается по два, в запас). Разобранные поля —
 * отдельные строки, кириллица в них по два байта, латиница по одному: это размер в UTF-8.
 */
export function lineBytes(line: string): number {
  const n = line.length;
  const utf8 = Buffer.byteLength(line, 'utf8');
  return (utf8 === n ? n : 2 * n) + utf8 + RECORD_OVERHEAD;
}

/** Сколько из want байт задание может оставить в памяти; own — сколько оно уже прочитало само. */
export type MemoryGate = (own: number, want: number) => number;

/** Память одного читающего задания: поиск одной среды, среда поиска по нескольким средам, поиск операции, чтение ссылки. */
export class JobMemory {
  /** Прочитано самим заданием: от этого считается предел задания. */
  read = 0;
  /** Держится без своего чтения: записи прежнего задания у дополнения операции, первая страница «Всех записей». */
  extra = 0;
  gate: MemoryGate | null = null;

  get bytes(): number {
    return this.read + this.extra;
  }

  /** Сколько из want байт задание оставит. Без пула с бюджетом — всё. */
  readonly take = (want: number): number => {
    const granted = this.gate ? Math.max(0, Math.min(want, this.gate(this.read, want))) : want;
    this.read += granted;
    return granted;
  };
}

/** Что бюджету нужно от задания пула. */
export interface MemoryJob {
  readonly id: string;
  readonly status: string;
  readonly lastAccess: number;
  readonly bytes?: number;
}

/** Пул заданий, подключённый к бюджету. */
export interface MemoryPool {
  /** Открытая поверхность коротких ссылок: один владелец, её чтение вытесняет только свои задания. */
  readonly guest: boolean;
  /** Задания пула и их владельцы мест. */
  entries(): Iterable<{ job: MemoryJob; holder: string | undefined }>;
  has(job: MemoryJob): boolean;
  evict(job: MemoryJob): void;
}

export interface MemoryBudgetOptions {
  /** Бюджет, байты. Нет — треть предела кучи процесса. */
  limitBytes?: number;
}

interface Entry {
  pool: MemoryPool;
  job: MemoryJob;
  key: string;
  bytes: number;
}

export class MemoryBudget {
  /** Предел кучи процесса, байты: от него взят бюджет. */
  readonly heapLimit = getHeapStatistics().heap_size_limit;
  readonly limit: number;
  readonly jobLimit: number;
  readonly holderLimit: number;
  /** Сколько результатов вытеснено ради памяти с запуска: метрика. */
  evicted = 0;
  readonly #pools: MemoryPool[] = [];

  constructor(opts: MemoryBudgetOptions = {}) {
    this.limit = Math.floor(opts.limitBytes ?? this.heapLimit * BUDGET_SHARE);
    this.jobLimit = Math.floor(this.limit * JOB_SHARE);
    this.holderLimit = Math.floor(this.limit * HOLDER_SHARE);
  }

  /** Запись журнала при старте: предел кучи и бюджет. */
  describe(): string {
    const mb = (n: number) => Math.round(n / 2 ** 20);
    return `память под результаты поиска: ${mb(this.limit)} МБ, треть предела кучи ${mb(this.heapLimit)} МБ; одно задание до ${mb(this.jobLimit)} МБ, один пользователь до ${mb(this.holderLimit)} МБ`;
  }

  attach(pool: MemoryPool): void {
    this.#pools.push(pool);
  }

  /** Оценка памяти под все результаты, байты. */
  used(): number {
    let n = 0;
    for (const e of this.#entries()) n += e.bytes;
    return n;
  }

  /**
   * Сколько из want байт может оставить чтение задания job пула pool, которое уже прочитало own. Место освобождается вытеснением
   * завершённых: сначала у владельца job сверх его доли, затем у того, кто держит больше всех. Идущие не вытесняются.
   */
  grant(pool: MemoryPool, job: MemoryJob, own: number, want: number): number {
    // Задания нет в пуле: его вытеснили или убрали, держать прочитанное некому.
    if (!pool.has(job)) return 0;
    const ask = Math.max(0, Math.min(want, this.jobLimit - own));
    if (ask === 0) return 0;
    const all = [...this.#entries()];
    const key = all.find((e) => e.job === job)?.key ?? keyOf(pool, undefined);
    const held = (k: string) => all.reduce((n, e) => n + (e.key === k ? e.bytes : 0), 0);
    let total = all.reduce((n, e) => n + e.bytes, 0);
    const evict = (e: Entry) => {
      all.splice(all.indexOf(e), 1);
      total -= e.bytes;
      e.pool.evict(e.job);
      this.evicted++;
    };
    while (held(key) + ask > this.holderLimit) {
      const victim = oldestFinished(all, (e) => e.key === key);
      if (!victim) break;
      evict(victim);
    }
    while (total + ask > this.limit) {
      // Чтение открытой поверхности вытесняет только задания ссылок.
      const victim = this.#victim(all, (e) => !pool.guest || e.pool === pool);
      if (!victim) break;
      evict(victim);
    }
    return Math.max(0, Math.min(ask, this.limit - total, this.holderLimit - held(key)));
  }

  /** Самое давнее завершённое задание того, кто держит больше всех. Владелец только с идущими заданиями пропускается. */
  #victim(all: Entry[], allowed: (e: Entry) => boolean): Entry | undefined {
    const byKey = new Map<string, number>();
    for (const e of all) byKey.set(e.key, (byKey.get(e.key) ?? 0) + e.bytes);
    let best: Entry | undefined;
    let top = -1;
    for (const [k, bytes] of byKey) {
      const v = oldestFinished(all, (e) => e.key === k && allowed(e));
      if (v && (bytes > top || (bytes === top && v.job.lastAccess < best!.job.lastAccess))) {
        best = v;
        top = bytes;
      }
    }
    return best;
  }

  *#entries(): Generator<Entry> {
    for (const pool of this.#pools) for (const { job, holder } of pool.entries()) yield { pool, job, key: keyOf(pool, holder), bytes: job.bytes ?? 0 };
  }
}

const keyOf = (pool: MemoryPool, holder: string | undefined) => (pool.guest ? 'guest' : `holder:${holder ?? ''}`);

function oldestFinished(all: readonly Entry[], match: (e: Entry) => boolean): Entry | undefined {
  let out: Entry | undefined;
  for (const e of all) if (e.job.status !== 'running' && match(e) && (!out || e.job.lastAccess < out.job.lastAccess)) out = e;
  return out;
}

/** Предел одного чтения без задания (запрос по ссылке): своя память до ответа, в бюджет не входит. */
export function readCap(limit: number): (want: number) => number {
  let left = limit;
  return (want) => {
    const granted = Math.max(0, Math.min(want, left));
    left -= granted;
    return granted;
  };
}
