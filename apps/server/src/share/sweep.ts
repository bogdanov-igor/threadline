// Уборка истёкших ссылок: таймер раз в час и один проход при подключении базы.
// Открытие всё равно проверяет срок в запросе, поэтому задержка уборки на доступ не влияет. Отдельного процесса нет.

import type { Db } from '../catalog/db.ts';
import type { SettingsService } from '../settings/service.ts';
import { sweepLinks } from './store.ts';

export const SWEEP_MS = 60 * 60_000;

export interface ShareSweepOptions {
  readDb: () => Db | null;
  settings: Pick<SettingsService, 'lifetimeDays'>;
  now: () => number;
  warn: (message: string) => void;
}

/** Один проход. База не ответила: строки удалит следующий, а истёкшая ссылка и так не открывается. */
export async function sweepExpired(o: ShareSweepOptions): Promise<number> {
  const db = o.readDb();
  if (!db) return 0;
  try {
    return await sweepLinks(db, o.now(), await o.settings.lifetimeDays(db));
  } catch (e) {
    o.warn(`уборка коротких ссылок не прошла: ${e instanceof Error ? e.name : typeof e}`);
    return 0;
  }
}

/** Возвращает остановку таймера. */
export function startShareSweep(o: ShareSweepOptions): () => void {
  const timer = setInterval(() => void sweepExpired(o), SWEEP_MS);
  timer.unref();
  return () => clearInterval(timer);
}
