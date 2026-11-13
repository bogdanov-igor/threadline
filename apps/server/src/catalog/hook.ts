// Справочник в ответах поиска: разметка на выходе, до maskDeep, и сбор «Неизвестного».
// Без справочника ответы байт в байт прежние.
// Правка справочника видна при следующем опросе без нового чтения Loki: разметка считается из записей задания.

import { annotateRecords, finalizeSummary } from '@threadline/core/catalog';
import type { ParsedRecord, RequestSummary, ViewRecord } from '@threadline/core/search';
import type { UnknownCollector } from './collector.ts';
import type { CatalogService } from './service.ts';

interface Bound {
  project: string;
  env: string;
  mock: boolean;
  stand: string | null;
  /** Сколько сводок задания уже передано в «Неизвестное». */
  collected: number;
  /** false — разметка без сбора: открытие короткой ссылки ничего не пишет в базу. */
  collect: boolean;
}

interface StoredLike {
  records: ParsedRecord[];
  readEndMs: number;
  incomplete: boolean;
}

export class CatalogHook {
  readonly #service: CatalogService;
  readonly #collector: UnknownCollector | null;
  readonly #jobs = new WeakMap<object, Bound>();
  /** Итог сводки по версии справочника: опрос раз в 500 мс записи заново не разбирает. */
  readonly #summaries = new WeakMap<RequestSummary, { project: string; version: number; value: RequestSummary }>();

  constructor(service: CatalogService, collector: UnknownCollector | null) {
    this.#service = service;
    this.#collector = collector;
  }

  /** Задание поиска → проект и среда. Повторный вызов для задания из кэша ничего не меняет. */
  bind(job: object, project: string, env: string, mock: boolean, stand: string | null = null, opts: { collect?: boolean } = {}): void {
    if (!this.#jobs.has(job)) this.#jobs.set(job, { project, env, mock, stand, collected: 0, collect: opts.collect !== false });
  }

  #summary(project: string, base: RequestSummary, stored: StoredLike | undefined): RequestSummary {
    const resolver = this.#service.resolver(project);
    if (!resolver || !stored) return base;
    const hit = this.#summaries.get(base);
    if (hit && hit.project === project && hit.version === resolver.version) return hit.value;
    const value = finalizeSummary(base, stored.records, resolver, { readEndMs: stored.readEndMs, incomplete: stored.incomplete });
    this.#summaries.set(base, { project, version: resolver.version, value });
    return value;
  }

  /** Сводки состояния задания; новые сводки заодно идут в «Неизвестное». */
  summaries(job: object, list: readonly RequestSummary[], all: readonly RequestSummary[], request: (cid: string) => StoredLike | undefined): RequestSummary[] {
    const b = this.#jobs.get(job);
    if (!b) return [...list];
    if (this.#collector && b.collect && b.collected < all.length) {
      for (const s of all.slice(b.collected)) {
        const stored = request(s.correlationId);
        if (stored) this.#collector.observe(b.project, b.env, b.mock, s.correlationId, stored.records, b.stand);
      }
      b.collected = all.length;
    }
    return list.map((s) => this.#summary(b.project, s, request(s.correlationId)));
  }

  /** Страница запроса из задания. */
  jobDetail(job: object, summary: RequestSummary, stored: StoredLike, view: ViewRecord[]): { summary: RequestSummary; view: ViewRecord[] } {
    const b = this.#jobs.get(job);
    if (!b) return { summary, view };
    return { summary: this.#summary(b.project, summary, stored), view: annotateRecords(view, this.#service.resolver(b.project)) };
  }

  /** Страница запроса по ссылке: задания нет, факты идут в «Неизвестное» сразу. */
  linkDetail(project: string, env: string, mock: boolean, stand: string | null, summary: RequestSummary, stored: StoredLike, view: ViewRecord[]): { summary: RequestSummary; view: ViewRecord[] } {
    const resolver = this.#service.resolver(project);
    if (!resolver) return { summary, view };
    this.#collector?.observe(project, env, mock, summary.correlationId, stored.records, stand);
    return {
      summary: finalizeSummary(summary, stored.records, resolver, { readEndMs: stored.readEndMs, incomplete: stored.incomplete }),
      view: annotateRecords(view, resolver),
    };
  }

  /** «Все записи»: подписи и ошибки без связи отправки с ответом. */
  lines(job: object, view: ViewRecord[]): ViewRecord[] {
    const b = this.#jobs.get(job);
    return b ? annotateRecords(view, this.#service.resolver(b.project)) : view;
  }
}
