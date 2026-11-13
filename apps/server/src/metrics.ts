// Метрики Prometheus: RED для HTTP и заданий поиска.
// Метки только из шаблона маршрута: идентификаторы, значения поиска и короткие ссылки в них не попадают, число значений ограничено.

import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { FastifyInstance } from 'fastify';
import { routeLabel } from './logging.ts';
import type { MemoryBudget } from './search/memory.ts';

export type JobKind = 'search' | 'operation' | 'link';

export interface TrackedJob {
  start(): Promise<void>;
  readonly status: string;
}

export interface MetricsOptions {
  /**
   * Метрики процесса Node из prom-client: память, куча, сборка мусора, задержка цикла событий. Только у процесса
   * сервера: каждый вызов заводит свой наблюдатель сборки мусора, а тесты создают сотни приложений.
   */
  runtime?: boolean;
}

/** Свой реестр на приложение: общий мешал бы приложениям одного процесса, например в тестах. */
export class Metrics {
  readonly registry = new Registry();

  constructor(opts: MetricsOptions = {}) {
    if (opts.runtime) collectDefaultMetrics({ register: this.registry });
  }

  readonly #requests = new Counter({ name: 'http_requests_total', help: 'Завершённые HTTP-запросы', labelNames: ['method', 'route', 'status_code'], registers: [this.registry] });
  readonly #duration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'Длительность HTTP-запроса, секунды',
    labelNames: ['method', 'route', 'status_code'],
    buckets: [0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
    registers: [this.registry],
  });
  readonly #inProgress = new Gauge({ name: 'http_requests_in_progress', help: 'HTTP-запросы в работе', labelNames: ['method', 'route'], registers: [this.registry] });
  readonly #jobsProcessed = new Counter({ name: 'jobs_processed_total', help: 'Завершённые задания поиска, включая отменённые и упавшие', labelNames: ['kind'], registers: [this.registry] });
  readonly #jobsFailed = new Counter({ name: 'jobs_failed_total', help: 'Упавшие задания поиска', labelNames: ['kind'], registers: [this.registry] });
  readonly #jobsDuration = new Histogram({
    name: 'jobs_duration_seconds',
    help: 'Длительность задания поиска, секунды',
    labelNames: ['kind'],
    buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300],
    registers: [this.registry],
  });

  /** Запускает задание и учитывает его завершение. Обещание задания не отклоняется, поэтому учёт всегда срабатывает. */
  trackJob(kind: JobKind, job: TrackedJob): Promise<void> {
    const end = this.#jobsDuration.startTimer({ kind });
    return job.start().finally(() => {
      end();
      this.#jobsProcessed.inc({ kind });
      if (job.status === 'failed') this.#jobsFailed.inc({ kind });
    });
  }

  /** Память под результаты: оценка, бюджет и вытесненные ради памяти. Значения берутся при опросе. */
  watchMemory(budget: MemoryBudget): void {
    const registers = [this.registry];
    new Gauge({ name: 'jobs_memory_bytes', help: 'Оценка памяти под результаты поиска, операции и ссылок, байты', registers, collect() { this.set(budget.used()); } });
    new Gauge({ name: 'jobs_memory_limit_bytes', help: 'Бюджет памяти под результаты: треть предела кучи, байты', registers, collect() { this.set(budget.limit); } });
    new Counter({
      name: 'jobs_memory_evicted_total',
      help: 'Завершённые результаты, вытесненные ради памяти',
      registers,
      collect() {
        this.reset();
        this.inc(budget.evicted);
      },
    });
  }

  /** Ставится раньше всех хуков запроса: отказ входа и 404 тоже считаются. */
  install(app: FastifyInstance): void {
    app.addHook('onRequest', async (req, reply) => {
      const route = routeLabel(req.routeOptions.url);
      const labels = { method: req.method, route };
      this.#inProgress.inc(labels);
      const started = performance.now();
      let counted = false;
      const count = (status: string) => {
        if (counted) return;
        counted = true;
        this.#inProgress.dec(labels);
        const full = { ...labels, status_code: status };
        this.#requests.inc(full);
        this.#duration.observe(full, (performance.now() - started) / 1000);
      };
      reply.raw.once('finish', () => count(String(reply.raw.statusCode)));
      // finish не приходит, если клиент закрыл соединение раньше ответа: такой запрос виден как 499, как и в кодах API.
      reply.raw.once('close', () => count('499'));
    });
  }

  registerRoute(app: FastifyInstance): void {
    app.get('/metrics', { config: { access: 'public' }, logLevel: 'warn' }, async (_req, reply) => reply.type(this.registry.contentType).send(await this.registry.metrics()));
  }
}
