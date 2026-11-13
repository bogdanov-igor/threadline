// Защитный слой вокруг любого хранилища: склейка одинаковых запросов, лимит параллельности
// с очередью, тайм-аут, отмена по счётчику подписчиков.

import { BackendError } from '@threadline/core/backend';

export interface GuardOptions {
  maxConcurrent: number;
  queueTimeoutMs: number;
  timeoutMs: number;
}

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (e: unknown) => void;
}

export class Semaphore {
  #free: number;
  readonly #queue: Waiter[] = [];

  constructor(max: number) {
    this.#free = max;
  }

  get waiting(): number {
    return this.#queue.length;
  }

  acquire(signal: AbortSignal, queueTimeoutMs: number): Promise<() => void> {
    if (signal.aborted) return Promise.reject(new BackendError('cancelled'));
    if (this.#free > 0) {
      this.#free--;
      return Promise.resolve(this.#releaser());
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resolve: (release) => {
          cleanup();
          resolve(release);
        },
        reject: (e) => {
          cleanup();
          reject(e);
        },
      };
      const remove = () => {
        const i = this.#queue.indexOf(waiter);
        if (i >= 0) this.#queue.splice(i, 1);
      };
      const timer = setTimeout(() => {
        remove();
        waiter.reject(new BackendError('busy', { details: `ожидание в очереди дольше ${Math.round(queueTimeoutMs / 1000)} с` }));
      }, queueTimeoutMs);
      const onAbort = () => {
        remove();
        waiter.reject(new BackendError('cancelled'));
      };
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.#queue.push(waiter);
    });
  }

  #releaser(): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const next = this.#queue.shift();
      if (next) next.resolve(this.#releaser());
      else this.#free++;
    };
  }
}

interface Flight {
  promise: Promise<unknown>;
  controller: AbortController;
  subscribers: number;
}

export class Guard {
  readonly #opts: GuardOptions;
  readonly #sem: Semaphore;
  readonly #flights = new Map<string, Flight>();

  constructor(opts: GuardOptions) {
    this.#opts = opts;
    this.#sem = new Semaphore(opts.maxConcurrent);
  }

  get inFlight(): number {
    return this.#flights.size;
  }

  /** Выполняет запрос. Одинаковые одновременные запросы (по ключу) уходят в хранилище один раз. */
  run<T>(key: string, fn: (signal: AbortSignal) => Promise<T>, clientSignal: AbortSignal): Promise<T> {
    let flight = this.#flights.get(key);
    if (!flight || flight.controller.signal.aborted) {
      flight = this.#start(key, fn);
    }
    return this.#subscribe(flight, clientSignal) as Promise<T>;
  }

  #start<T>(key: string, fn: (signal: AbortSignal) => Promise<T>): Flight {
    const controller = new AbortController();
    const flight: Flight = { controller, subscribers: 0, promise: Promise.resolve() };
    flight.promise = (async () => {
      try {
        const release = await this.#sem.acquire(controller.signal, this.#opts.queueTimeoutMs);
        try {
          if (controller.signal.aborted) throw new BackendError('cancelled');
          const timeout = AbortSignal.timeout(this.#opts.timeoutMs);
          try {
            return await fn(AbortSignal.any([controller.signal, timeout]));
          } catch (e) {
            if (timeout.aborted && !controller.signal.aborted) {
              throw new BackendError('timeout', {
                details: `хранилище не ответило за ${Math.round(this.#opts.timeoutMs / 1000)} с`,
              });
            }
            if (controller.signal.aborted) throw new BackendError('cancelled');
            throw e;
          }
        } finally {
          release();
        }
      } finally {
        if (this.#flights.get(key) === flight) this.#flights.delete(key);
      }
    })();
    flight.promise.catch(() => {});
    this.#flights.set(key, flight);
    return flight;
  }

  #subscribe(flight: Flight, clientSignal: AbortSignal): Promise<unknown> {
    flight.subscribers++;
    return new Promise((resolve, reject) => {
      let settled = false;
      const leave = () => {
        flight.subscribers--;
        if (flight.subscribers === 0) flight.controller.abort();
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        leave();
        reject(new BackendError('cancelled'));
      };
      if (clientSignal.aborted) {
        onAbort();
        return;
      }
      clientSignal.addEventListener('abort', onAbort, { once: true });
      flight.promise.then(
        (v) => {
          if (settled) return;
          settled = true;
          flight.subscribers--;
          clientSignal.removeEventListener('abort', onAbort);
          resolve(v);
        },
        (e) => {
          if (settled) return;
          settled = true;
          flight.subscribers--;
          clientSignal.removeEventListener('abort', onAbort);
          reject(e);
        },
      );
    });
  }
}
