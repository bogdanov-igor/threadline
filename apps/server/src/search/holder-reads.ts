// Чтения запроса по ссылке одного владельца мест (holderOf): каждое идёт в хранилище, кэша у них нет. Не больше трёх сразу,
// следующие ждут места, ждущих не больше десяти.

import { BackendError } from '@threadline/core/backend';
import { Semaphore } from '../backends/guard.ts';

/** maxConcurrent − 1 при лимите хранилища по умолчанию. */
export const HOLDER_READS = 3;
export const HOLDER_READS_WAITING = 10;
export const HOLDER_READ_WAIT_MS = 10_000;
/** Через сколько предложить повторить: как у пула коротких ссылок. */
export const HOLDER_READ_RETRY_SECONDS = 5;

export interface HolderReadsOptions {
  max?: number;
  waiting?: number;
  waitMs?: number;
}

interface Slot {
  sem: Semaphore;
  /** Идут и ждут: запись владельца живёт, пока здесь не ноль. */
  users: number;
}

export class HolderReads {
  readonly #max: number;
  readonly #waiting: number;
  readonly #waitMs: number;
  readonly #slots = new Map<string, Slot>();

  constructor(opts: HolderReadsOptions = {}) {
    this.#max = opts.max ?? HOLDER_READS;
    this.#waiting = opts.waiting ?? HOLDER_READS_WAITING;
    this.#waitMs = opts.waitMs ?? HOLDER_READ_WAIT_MS;
  }

  /** Владельцев с идущими или ждущими чтениями. */
  get size(): number {
    return this.#slots.size;
  }

  /** work в пределах владельца. busy — ждущих уже десять или место не освободилось вовремя; cancelled — signal сработал в ожидании. */
  async run<T>(holder: string, signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    let slot = this.#slots.get(holder);
    if (!slot) this.#slots.set(holder, (slot = { sem: new Semaphore(this.#max), users: 0 }));
    if (slot.sem.waiting >= this.#waiting) throw new BackendError('busy', { retryAfterSeconds: HOLDER_READ_RETRY_SECONDS });
    slot.users++;
    try {
      let release: () => void;
      try {
        release = await slot.sem.acquire(signal, this.#waitMs);
      } catch (e) {
        if (e instanceof BackendError && e.code === 'busy') throw new BackendError('busy', { retryAfterSeconds: HOLDER_READ_RETRY_SECONDS });
        throw e;
      }
      try {
        return await work();
      } finally {
        release();
      }
    } finally {
      if (--slot.users === 0) this.#slots.delete(holder);
    }
  }
}
