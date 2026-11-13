// Остановка по сигналу.

import { setTimeout as sleep } from 'node:timers/promises';
import type { Health } from './health.ts';

export const SHUTDOWN_TIMEOUT_ENV = 'THREADLINE_SHUTDOWN_TIMEOUT_SECONDS';
/** Меньше стандартных 30 секунд terminationGracePeriodSeconds: выходим сами, а не от SIGKILL. */
export const DEFAULT_SHUTDOWN_TIMEOUT_SECONDS = 25;
const MAX_DRAIN_MS = 5000;

export function shutdownTimeoutMs(env: Record<string, string | undefined>): number {
  const given = env[SHUTDOWN_TIMEOUT_ENV]?.trim();
  return (given ? Number(given) : DEFAULT_SHUTDOWN_TIMEOUT_SECONDS) * 1000;
}

/** Пауза, чтобы под успел выйти из ротации: новые запросы ещё могут прийти, пока кластер обновляет маршруты. */
export function drainMs(timeoutMs: number): number {
  return Math.min(MAX_DRAIN_MS, Math.floor(timeoutMs / 5));
}

export interface ShutdownTarget {
  log: { info(message: string): void; error(message: string): void };
  close(): Promise<unknown>;
}

export interface ShutdownOptions {
  app: ShutdownTarget;
  health: Pick<Health, 'beginShutdown'>;
  timeoutMs: number;
  /** Для тестов: выход процесса. */
  exit?: (code: number) => void;
}

/** Возвращает обработчик сигнала. Повторный сигнал ничего не меняет: остановка уже идёт, таймер ограничивает её. */
export function shutdownHandler({ app, health, timeoutMs, exit = process.exit }: ShutdownOptions): (signal: NodeJS.Signals) => Promise<void> {
  let running = false;
  return async (signal) => {
    if (running) return;
    running = true;
    health.beginShutdown();
    app.log.info(`получен ${signal}: готовность снята, сервер останавливается, предел ${Math.round(timeoutMs / 1000)} с`);
    const limit = setTimeout(() => {
      app.log.error(`остановка не закончилась за ${Math.round(timeoutMs / 1000)} с: принудительный выход`);
      exit(1);
    }, timeoutMs);
    limit.unref();
    try {
      // Ctrl+C разработчика не ждёт: паузу нужно только кластеру.
      if (signal === 'SIGTERM') await sleep(drainMs(timeoutMs));
      // Новые соединения закрыты, текущие запросы заканчиваются, затем хуки onClose: задания, сборщик, база.
      await app.close();
    } catch (e) {
      clearTimeout(limit);
      app.log.error(`остановка завершилась ошибкой ${e instanceof Error ? e.name : typeof e}`);
      exit(1);
      return;
    }
    clearTimeout(limit);
    app.log.info('сервер остановлен');
    exit(0);
  };
}
