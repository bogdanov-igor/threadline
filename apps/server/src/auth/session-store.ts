// Хранилище сессий в памяти: срок записи и предел числа. Встроенный MemoryStore брошенные записи не удаляет.
// Опрос сюда не пишет: saveUninitialized и rolling выключены.

export const MAX_SESSIONS = 10_000;

/** Прослойка под MemoryStore из @fastify/session: тот же get, set, delete, а записи живут не дольше ttlMs и не больше max. */
export class SessionMap<T> {
  readonly #entries = new Map<string, { value: T; until: number }>();
  readonly #ttlMs: number;
  readonly #max: number;
  readonly #now: () => number;
  /** Сколько раз писали: тест проверяет, что опрос не пишет. */
  writes = 0;

  constructor(opts: { ttlMs: number; max?: number; now?: () => number }) {
    this.#ttlMs = opts.ttlMs;
    this.#max = opts.max ?? MAX_SESSIONS;
    this.#now = opts.now ?? Date.now;
  }

  get size(): number {
    return this.#entries.size;
  }

  get(id: string): T | undefined {
    const e = this.#entries.get(id);
    if (!e) return undefined;
    if (this.#now() >= e.until) {
      this.#entries.delete(id);
      return undefined;
    }
    return e.value;
  }

  set(id: string, value: T): this {
    this.writes++;
    const now = this.#now();
    // Порядок вставки — порядок последней записи: первым идёт самое давнее, вытеснение и чистка идут с начала.
    this.#entries.delete(id);
    this.#entries.set(id, { value, until: now + this.#ttlMs });
    for (const [k, e] of this.#entries) {
      if (this.#entries.size <= this.#max && now < e.until) break;
      this.#entries.delete(k);
    }
    return this;
  }

  delete(id: string): boolean {
    return this.#entries.delete(id);
  }
}
