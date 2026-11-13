// Чтение выборки: строго по одному, бюджет запросов и строк, окно, общий дедлайн. Первая ошибка закрывает все следующие чтения.

import { BackendError, type LinesQuery, type LogLine, type Matcher, type TimeRange } from '@threadline/core/backend';
import type { BackendErrorCode } from '@threadline/core';
import type { EnvironmentConfig } from '@threadline/core/config';
import type { Backends } from '../backends/registry.ts';
import { MAX_LINES, MAX_QUERIES, MAX_WINDOW_MS, RUN_DEADLINE_MS } from './limits.ts';

export type StopCode = BackendErrorCode | 'query-limit' | 'line-limit' | 'deadline';

/** Остановка запуска. Сообщение только код: текст ошибки хранилища может цитировать запрос. */
export class SampleStop extends Error {
  readonly code: StopCode;

  constructor(code: StopCode) {
    super(code);
    this.name = 'SampleStop';
    this.code = code;
  }
}

export interface ReaderOptions {
  signal?: AbortSignal;
  /** Для тестов: в работе всегда RUN_DEADLINE_MS. */
  deadlineMs?: number;
}

const clampRange = (r: TimeRange): TimeRange => ({ ...r, fromMs: Math.max(r.fromMs, r.toMs - MAX_WINDOW_MS) });

export class SampleReader {
  readonly #backends: Backends;
  readonly #env: EnvironmentConfig;
  readonly #ac = new AbortController();
  readonly #timer: NodeJS.Timeout;
  #deadlineHit = false;
  #closed: SampleStop | null = null;
  #tail: Promise<unknown> = Promise.resolve();
  #queries = 0;
  #lines = 0;
  #answered = 0;
  #interrupted = false;

  constructor(backends: Backends, env: EnvironmentConfig, opts: ReaderOptions = {}) {
    this.#backends = backends;
    this.#env = env;
    this.#timer = setTimeout(() => {
      this.#deadlineHit = true;
      this.#ac.abort();
    }, opts.deadlineMs ?? RUN_DEADLINE_MS);
    this.#timer.unref();
    const outer = opts.signal;
    if (outer) {
      const interrupt = () => {
        this.#interrupted = true;
        this.#ac.abort();
      };
      if (outer.aborted) interrupt();
      else outer.addEventListener('abort', interrupt, { once: true });
    }
  }

  get used(): { queries: number; lines: number } {
    return { queries: this.#queries, lines: this.#lines };
  }

  /** Хранилище ответило хотя бы раз: есть что записать. */
  get answered(): number {
    return this.#answered;
  }

  get interrupted(): boolean {
    return this.#interrupted;
  }

  close(): void {
    clearTimeout(this.#timer);
  }

  async labelNames(): Promise<string[]> {
    return this.#run((signal) => this.#backends.labelNames(this.#env, signal));
  }

  async labelValues(label: string, scope: Matcher[], range: TimeRange): Promise<string[]> {
    return this.#run((signal) => this.#backends.labelValues(this.#env, label, scope, clampRange(range), signal));
  }

  /** Строки запроса. Ответ обрезается до предела: хранилище могло вернуть больше. */
  async lines(q: LinesQuery): Promise<LogLine[]> {
    return this.#run(async (signal) => {
      const limit = Math.min(q.limit, MAX_LINES - this.#lines);
      if (limit <= 0) throw this.#stop('line-limit');
      const found = await this.#backends.queryLines(this.#env, { ...q, limit, range: clampRange(q.range) }, signal);
      const kept = found.slice(0, limit);
      this.#lines += kept.length;
      return kept;
    });
  }

  #run<T>(read: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const turn = this.#tail.then(() => this.#once(read));
    this.#tail = turn.catch(() => undefined);
    return turn;
  }

  async #once<T>(read: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.#closed) throw this.#closed;
    if (this.#interrupted) throw this.#stop('cancelled');
    if (this.#deadlineHit) throw this.#stop('deadline');
    if (this.#queries >= MAX_QUERIES) throw this.#stop('query-limit');
    if (this.#lines >= MAX_LINES) throw this.#stop('line-limit');
    this.#queries++;
    try {
      const value = await read(this.#ac.signal);
      this.#answered++;
      return value;
    } catch (e) {
      if (e instanceof SampleStop) throw e;
      if (this.#deadlineHit) throw this.#stop('deadline');
      if (this.#interrupted) throw this.#stop('cancelled');
      throw this.#stop(e instanceof BackendError ? e.code : 'unknown');
    }
  }

  #stop(code: StopCode): SampleStop {
    this.#closed = new SampleStop(code);
    return this.#closed;
  }
}
