// Команда миграций: отдельный шаг, сервер схему не меняет.
// Коды выхода: 0 — схема актуальна, 1 — миграция не применена, 2 — база недоступна или адрес не задан.

import { setTimeout as sleep } from 'node:timers/promises';
import { logLine } from '../logging.ts';
import { DbError, describeUrl, isConnectionError, openDb, safeMessage, type Db } from './db.ts';
import { migrate, MigrationError } from './migrate.ts';

export interface MigrateIo {
  env: Record<string, string | undefined>;
  /** Для тестов. */
  log?: (level: 'info' | 'warn' | 'error' | 'fatal', message: string) => void;
  open?: (url: string) => Promise<Db>;
  /** Сколько ждать появления базы, мс. */
  waitMs?: number;
  pause?: (ms: number) => Promise<unknown>;
}

const WAIT_MS = 60_000;
const MAX_PAUSE_MS = 16_000;

export async function runMigrate(io: MigrateIo): Promise<number> {
  const log = io.log ?? logLine;
  const url = io.env.THREADLINE_DATABASE_URL?.trim();
  if (!url) {
    log('fatal', 'миграции не запущены: не задана переменная THREADLINE_DATABASE_URL');
    return 2;
  }
  const label = describeUrl(url);
  const pause = io.pause ?? sleep;
  const waitMs = io.waitMs ?? WAIT_MS;
  const started = Date.now();
  let db: Db | null = null;
  try {
    // Без пределов на запрос: ожидание блокировки и долгая миграция не должны обрываться через 5 секунд.
    db = await (io.open ?? ((u: string) => openDb(u, { noQueryLimits: true })))(url);
    for (let wait = 1000; ; wait = Math.min(wait * 2, MAX_PAUSE_MS)) {
      try {
        const { applied } = await migrate(db);
        log('info', applied.length > 0 ? `миграции применены (${label}): ${applied.join(', ')}` : `схема актуальна, применять нечего (${label})`);
        return 0;
      } catch (e) {
        // Ошибка миграции и отказ по паролю повтором не исправятся.
        if (!(e instanceof DbError) || !isConnectionError(e) || Date.now() - started >= waitMs) throw e;
        log('warn', `база недоступна (${label}): ${e.message}; повтор через ${Math.round(wait / 1000)} с`);
        await pause(wait);
      }
    }
  } catch (e) {
    if (e instanceof MigrationError) {
      log('fatal', `миграции не применены: ${e.message}`);
      return 1;
    }
    log('fatal', `миграции не запущены, база недоступна (${label}): ${e instanceof DbError ? e.message : safeMessage(e, url)}`);
    return 2;
  } finally {
    await db?.close().catch(() => undefined);
  }
}
