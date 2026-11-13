// Проверки для Kubernetes: живость без зависимостей, готовность с зависимостями.
// В ответе только имена проверок и состояния: адреса и тексты ошибок остаются в журнале.

import type { FastifyInstance } from 'fastify';
import type { CatalogState } from '@threadline/core/search';

/** Состояние проверки: ok, off и stale проходят, всё остальное значит «не готов». */
export type Check = () => string | Promise<string>;

// stale — справочник работает по данным в памяти: поиску база не нужна, единственная копия не должна уходить из балансировки.
const PASSING = new Set(['ok', 'off', 'stale']);

export interface Readiness {
  status: 'ready' | 'not-ready';
  checks: Record<string, string>;
}

export class Health {
  readonly #checks = new Map<string, Check>();
  #stopping = false;

  add(name: string, check: Check): void {
    this.#checks.set(name, check);
  }

  /** После этого готовность больше не вернётся: под выводится из ротации. */
  beginShutdown(): void {
    this.#stopping = true;
  }

  async readiness(): Promise<Readiness> {
    if (this.#stopping) return { status: 'not-ready', checks: { shutdown: 'in-progress' } };
    const names = [...this.#checks.keys()];
    const states = await Promise.all(names.map(async (name) => {
      try {
        return await this.#checks.get(name)!();
      } catch {
        return 'error';
      }
    }));
    const checks = Object.fromEntries(names.map((name, i) => [name, states[i]!]));
    return { status: states.every((s) => PASSING.has(s)) ? 'ready' : 'not-ready', checks };
  }
}

export interface DatabaseSource {
  readonly enabled: boolean;
  state(): CatalogState;
}

/**
 * База проверяется только до первой загрузки справочника, как провайдер входа до первых настроек. До неё: off, connecting или error.
 * После неё в базу проверка не ходит: ok, пока база отвечает опросу версии, иначе stale — работа по загруженным данным.
 */
export function databaseCheck(catalog: DatabaseSource): Check {
  let loaded = false;
  return () => {
    if (!catalog.enabled) return 'off';
    const s = catalog.state();
    // loadedAt есть и в connecting после пересоздания тома: данные в памяти остались.
    loaded ||= s.state === 'ok' || s.state === 'stale' || s.loadedAt !== null;
    if (!loaded) return s.state;
    return s.state === 'ok' ? 'ok' : 'stale';
  };
}

/** Пробы идут каждые несколько секунд: на уровне info журнал они не засоряют. */
const ROUTE = { config: { access: 'public' as const }, logLevel: 'warn' as const };

export function registerHealthRoutes(app: FastifyInstance, health: Health): void {
  const ready = async (_req: unknown, reply: { code(n: number): unknown; header(k: string, v: string): unknown }) => {
    const r = await health.readiness();
    reply.code(r.status === 'ready' ? 200 : 503);
    reply.header('Cache-Control', 'no-store');
    return r;
  };
  app.get('/health', ROUTE, ready);
  app.get('/health/readiness', ROUTE, ready);
  app.get('/health/liveness', ROUTE, async (_req, reply) => {
    void reply.header('Cache-Control', 'no-store');
    return { status: 'alive' };
  });
}
