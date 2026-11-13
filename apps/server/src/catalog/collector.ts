// Сбор «Неизвестного»: неузнанные методы, хосты и ошибки из запросов, которые видели пользователи.
// Примеры уже маскированы в core (unknownItems), значений из тел в базе нет.

import { unknownItems } from '@threadline/core/catalog';
import type { ParsedRecord } from '@threadline/core/search';
import { DbError, isBusyError, isConnectionError, type Db } from './db.ts';
import { NO_NOTIFIER, type UnknownErrorNotifier } from './notifier.ts';
import type { CatalogService } from './service.ts';
import * as store from './store.ts';

export interface CollectorOptions {
  now?: () => number;
  /** Сброс агрегата в базу, мс. */
  flushMs?: number;
  /** Обрезка таблицы до предела, мс. */
  trimMs?: number;
  /** Демо-среда тоже пишет в «Неизвестное»: только для e2e (THREADLINE_CATALOG_DEMO_INBOX=1). */
  demoInbox?: boolean;
  warn?: (message: string) => void;
  /** Новая неизвестная ошибка, впервые записанная в базу. По умолчанию ничего не делает. */
  notifier?: UnknownErrorNotifier;
}

export const UNKNOWN_LIMITS = {
  lru: 50_000,
  lruMs: 24 * 60 * 60 * 1000,
  aggregate: 1000,
  flushAt: 500,
  table: 5000,
} as const;

export class UnknownCollector {
  readonly #service: CatalogService;
  readonly #now: () => number;
  readonly #opts: CollectorOptions;
  /** key|cid → время: счётчик — число различных запросов. Map хранит порядок вставки — это и есть LRU. */
  readonly #seen = new Map<string, number>();
  readonly #agg = new Map<string, store.UnknownAggregate>();
  #dropped = 0;
  #flushTimer: NodeJS.Timeout | null = null;
  #trimTimer: NodeJS.Timeout | null = null;
  #lastDropLog = 0;
  #flushing: Promise<void> | null = null;
  /** Проекты, забытые за время сброса: неудачный пакет их строки обратно не кладёт. */
  readonly #forgotten = new Set<string>();

  constructor(service: CatalogService, opts: CollectorOptions = {}) {
    this.#service = service;
    this.#now = opts.now ?? Date.now;
    this.#opts = opts;
  }

  start(): void {
    if (!this.#service.enabled) return;
    this.#flushTimer = setInterval(() => void this.flush(), this.#opts.flushMs ?? 10_000);
    this.#flushTimer.unref();
    this.#trimTimer = setInterval(() => void this.trim(), this.#opts.trimMs ?? 60_000);
    this.#trimTimer.unref();
  }

  async close(): Promise<void> {
    if (this.#flushTimer) clearInterval(this.#flushTimer);
    if (this.#trimTimer) clearInterval(this.#trimTimer);
    await this.flush();
  }

  get pending(): number {
    return this.#agg.size;
  }

  get dropped(): number {
    return this.#dropped;
  }

  /**
   * Факты одного запроса. mock — среда с хранилищем-имитацией: в «Неизвестное» не пишет. stand — номер стенда PR.
   * Пока база недоступна, агрегат копится по загруженному справочнику, до 1000 записей: в базу он уйдёт после восстановления.
   */
  observe(project: string, env: string, mock: boolean, cid: string, records: readonly ParsedRecord[], stand: string | null = null): void {
    if (mock && !this.#opts.demoInbox) return;
    const resolver = this.#service.resolver(project);
    if (!resolver || records.length === 0) return;
    const now = this.#now();
    const exampleMs = Math.min(...records.map((r) => r.timeMs));
    for (const item of unknownItems(records, resolver)) {
      const seenKey = `${project}|${item.key}|${cid}`;
      const at = this.#seen.get(seenKey);
      if (at !== undefined && now - at < UNKNOWN_LIMITS.lruMs) continue;
      this.#seen.delete(seenKey);
      this.#seen.set(seenKey, now);
      if (this.#seen.size > UNKNOWN_LIMITS.lru) this.#seen.delete(this.#seen.keys().next().value!);
      const aggKey = `${project}|${item.key}`;
      const was = this.#agg.get(aggKey);
      if (was) {
        was.count++;
        was.lastSeen = now;
        was.item = item;
        was.env = env;
        was.stand = stand;
        was.exampleCid = cid;
        was.exampleMs = exampleMs;
        continue;
      }
      if (this.#agg.size >= UNKNOWN_LIMITS.aggregate) {
        this.#dropped++;
        this.#logDropped(now);
        continue;
      }
      this.#agg.set(aggKey, { project, item, count: 1, env, stand, exampleCid: cid, exampleMs, firstSeen: now, lastSeen: now });
    }
    if (this.#agg.size >= UNKNOWN_LIMITS.flushAt) void this.flush();
  }

  #logDropped(now: number): void {
    if (now - this.#lastDropLog < 60_000) return;
    this.#lastDropLog = now;
    this.#opts.warn?.(`«Неизвестное»: буфер полон, записи ждут базу, отброшено записей: ${this.#dropped}`);
  }

  /** Проект удалён: строки в памяти не должны попасть в проект, созданный заново с тем же идентификатором. */
  forget(project: string): void {
    for (const [k, a] of [...this.#agg]) if (a.project === project) this.#agg.delete(k);
    const prefix = `${project}|`;
    for (const k of [...this.#seen.keys()]) if (k.startsWith(prefix)) this.#seen.delete(k);
    if (this.#flushing) this.#forgotten.add(project);
  }

  /**
   * Сброс одним запросом. Обрыв оставляет агрегат в памяти до следующей попытки. Ошибка данных (символ, который база не
   * принимает, число вне колонки) не повторяется по кругу: строки пишутся по одной, отклонённая отбрасывается с записью в журнал.
   */
  flush(): Promise<void> {
    if (this.#flushing) return this.#flushing;
    if (this.#agg.size === 0) return Promise.resolve();
    const db = this.#service.state().state === 'ok' ? this.#service.readDb() : null;
    if (!db) return Promise.resolve();
    const batch = [...this.#agg.entries()];
    this.#agg.clear();
    /** Ещё не записанные строки: при обрыве они возвращаются в агрегат. */
    let left = batch;
    this.#flushing = this.#write(db, batch, (rest) => (left = rest))
      .then((rows) => {
        const fresh = new Set(rows.filter((r) => r.inserted).map((r) => `${r.project}|${r.key}`));
        for (const [k, a] of batch) if (a.item.kind === 'error' && fresh.has(k)) this.#notify(a);
      })
      .catch(() => {
        // Вернуть несохранённое, не теряя то, что пришло за время сброса.
        for (const [k, a] of left) {
          if (this.#forgotten.has(a.project)) continue;
          const now = this.#agg.get(k);
          if (now) {
            now.count += a.count;
            now.firstSeen = Math.min(now.firstSeen, a.firstSeen);
          } else if (this.#agg.size < UNKNOWN_LIMITS.aggregate) this.#agg.set(k, a);
          else this.#dropped++;
        }
      })
      .finally(() => {
        this.#flushing = null;
        this.#forgotten.clear();
      });
    return this.#flushing;
  }

  /** Пакет целиком; ошибка данных — по одной строке. rest получает ещё не записанные строки перед каждой записью. */
  async #write(db: Db, batch: readonly [string, store.UnknownAggregate][], rest: (left: [string, store.UnknownAggregate][]) => void): Promise<store.UnknownWritten[]> {
    try {
      return await store.upsertUnknown(
        db,
        batch.map(([, a]) => a),
      );
    } catch (e) {
      if (!(e instanceof DbError) || isConnectionError(e) || isBusyError(e)) throw e;
    }
    const out: store.UnknownWritten[] = [];
    const rejected = new Map<string, number>();
    for (let i = 0; i < batch.length; i++) {
      rest(batch.slice(i));
      try {
        out.push(...(await store.upsertUnknown(db, [batch[i]![1]])));
      } catch (e) {
        if (!(e instanceof DbError) || isConnectionError(e) || isBusyError(e)) throw e;
        const code = e.pgCode ?? '—';
        rejected.set(code, (rejected.get(code) ?? 0) + 1);
      }
    }
    rest([]);
    // Без значений: только число и коды. Строка вернётся при следующем запросе, если её данные станут верными.
    if (rejected.size > 0) {
      const total = [...rejected.values()].reduce((n, x) => n + x, 0);
      this.#opts.warn?.(`«Неизвестное»: база отклонила записей: ${total} (коды ${[...rejected.keys()].join(', ')}), они отброшены, остальные сохранены`);
    }
    return out;
  }

  /** Один вызов без ожидания и повторов. Сбой уведомления не мешает записи, в журнал идёт только тип ошибки. */
  #notify(a: store.UnknownAggregate): void {
    const failed = (e: unknown) => this.#opts.warn?.(`уведомление о новой неизвестной ошибке не удалось: ${e instanceof Error ? e.name : typeof e}`);
    try {
      const out: unknown = (this.#opts.notifier ?? NO_NOTIFIER).unknownError({
        project: a.project,
        env: a.env,
        stand: a.stand,
        systemId: a.item.systemId,
        methodId: a.item.methodId,
        httpStatus: a.item.httpStatus,
        code: a.item.code,
        text: a.item.text,
        exampleCid: a.exampleCid,
        exampleMs: a.exampleMs,
      });
      if (out instanceof Promise) out.catch(failed);
    } catch (e) {
      failed(e);
    }
  }

  async trim(): Promise<number> {
    const db = this.#service.state().state === 'ok' ? this.#service.readDb() : null;
    if (!db) return 0;
    try {
      return await store.trimUnknown(db, UNKNOWN_LIMITS.table);
    } catch {
      return 0;
    }
  }
}
