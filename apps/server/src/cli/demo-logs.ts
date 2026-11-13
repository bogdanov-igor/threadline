// Генератор демо-логов быстрого старта: пишет записи Demo Pay в Loki через push API, README.ru.md, «Быстрый старт».
// node --disable-warning=ExperimentalWarning apps/server/src/cli/demo-logs.ts --url http://loki:3100 [--interval 10] [--no-history]
// Сначала история за сутки, если в Loki ещё нет записей Demo Pay, затем живой поток до SIGTERM.

import { randomInt } from 'node:crypto';
import { parseArgs } from 'node:util';
import type { MockRecord } from '../backends/mock/dataset-pay.ts';
import { batches, DEMO_IDS, DEMO_NAMESPACE, history, LiveFeed, pushBody } from '../demo-logs/generator.ts';

const USAGE =
  'demo-logs --url <адрес Loki, например http://loki:3100> [--interval <секунды, по умолчанию 10>] [--no-history]';
/** Текста строк в одном push: с запасом под предел запроса Loki в 4 МБ. */
const MAX_BATCH_BYTES = 1024 * 1024;
/** Записей в очереди, пока Loki не принимает: дальше уходят самые старые. */
const MAX_QUEUE = 50_000;
const DAY_MS = 24 * 60 * 60 * 1000;

const log = (msg: string) => console.log(`${new Date().toISOString()} демо-логи: ${msg}`);

function fail(msg: string): never {
  console.error(`демо-логи: ${msg}\n${USAGE}`);
  process.exit(2);
}

let args;
try {
  args = parseArgs({
    options: { url: { type: 'string' }, interval: { type: 'string' }, 'no-history': { type: 'boolean' } },
  }).values;
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}
const base = (args.url ?? '').trim().replace(/\/+$/, '');
if (!/^https?:\/\//.test(base) || !URL.canParse(base))
  fail('нужен --url: адрес Loki вида http://loki:3100, без /loki/api/v1');
const intervalSeconds = Number(args.interval ?? '10');
if (!Number.isFinite(intervalSeconds) || intervalSeconds < 1 || intervalSeconds > 3600)
  fail('--interval: число секунд от 1 до 3600');
const api = `${base}/loki/api/v1`;

const ac = new AbortController();
const { signal } = ac;
process.once('SIGINT', () => ac.abort());
process.once('SIGTERM', () => ac.abort());

class PushError extends Error {
  readonly retry: boolean;
  constructor(message: string, retry: boolean) {
    super(message);
    this.retry = retry;
  }
}

const reason = (e: unknown) => {
  const cause = e instanceof Error ? (e.cause as { code?: string } | undefined) : undefined;
  return cause?.code ?? (e instanceof Error ? e.message : String(e));
};

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });

const timeout = (ms: number) => AbortSignal.any([signal, AbortSignal.timeout(ms)]);

async function push(records: MockRecord[]): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${api}/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(pushBody(records)),
      signal: timeout(30_000),
    });
  } catch (e) {
    throw new PushError(`Loki недоступен: ${reason(e)}`, true);
  }
  if (res.ok) {
    await res.body?.cancel();
    return;
  }
  const text = (await res.text().catch(() => '')).trim().slice(0, 300);
  // 429 и 5xx — Loki просит подождать или не готов. Остальное не исправится повтором: записи отбрасываются.
  throw new PushError(
    `Loki ответил ${res.status}${text ? `: ${text}` : ''}`,
    res.status === 429 || res.status >= 500,
  );
}

/** Пишет записи, повторяя, пока Loki не примет или не откажет окончательно. */
async function pushUntilDone(records: MockRecord[]): Promise<void> {
  for (let attempt = 0; !signal.aborted; attempt++) {
    try {
      await push(records);
      return;
    } catch (e) {
      if (!(e instanceof PushError)) throw e;
      if (!e.retry) return log(`записи не приняты: ${e.message}`);
      if (attempt % 5 === 0) log(`${e.message}, повтор`);
      await sleep(Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)));
    }
  }
}

/** Loki готов принимать записи: /ready отвечает 200. Сразу после старта он отвечает 503 ещё около 15 секунд. */
async function waitReady(): Promise<void> {
  let told = 0;
  while (!signal.aborted) {
    try {
      const res = await fetch(`${base}/ready`, { signal: timeout(5000) });
      await res.body?.cancel();
      if (res.ok) return;
    } catch {
      // Loki ещё не слушает порт.
    }
    if (Date.now() - told >= 15_000) {
      log(`жду Loki: ${base}/ready`);
      told = Date.now();
    }
    await sleep(2000);
  }
}

/** В Loki уже есть записи Demo Pay за сутки: история писалась при прошлом запуске, второй раз её писать не нужно. */
async function hasDemoLogs(nowMs: number): Promise<boolean> {
  const ns = (ms: number) => (BigInt(ms) * 1_000_000n).toString();
  const q = new URLSearchParams({
    query: `{namespace="${DEMO_NAMESPACE}"}`,
    start: ns(nowMs - DAY_MS),
    end: ns(nowMs),
    limit: '1',
  });
  try {
    const res = await fetch(`${api}/query_range?${q}`, { signal: timeout(30_000) });
    if (!res.ok) return false;
    const body = (await res.json()) as { data?: { result?: { values?: unknown[] }[] } };
    return (body.data?.result ?? []).some((s) => Array.isArray(s.values) && s.values.length > 0);
  } catch {
    return false;
  }
}

async function writeHistory(): Promise<void> {
  const now = Date.now();
  if (await hasDemoLogs(now)) return log('в Loki уже есть записи Demo Pay за сутки, история не пишется');
  const records = history(now);
  for (const batch of batches(records, MAX_BATCH_BYTES)) {
    if (signal.aborted) return;
    await pushUntilDone(batch);
  }
  log(`история за сутки записана: ${records.length} записей`);
}

async function live(): Promise<void> {
  const feed = new LiveFeed({
    startMs: Date.now(),
    intervalMs: intervalSeconds * 1000,
    seed: randomInt(1, 2_147_483_647),
  });
  log(
    `живой поток: запрос каждые ${intervalSeconds} с; постоянные значения: пользователь ${DEMO_IDS.user}, карта ${DEMO_IDS.card}, телефон ${DEMO_IDS.phone}`,
  );
  let queue: MockRecord[] = [];
  let failing = false;
  let written = 0;
  let reported = Date.now();
  while (!signal.aborted) {
    queue.push(...feed.due(Date.now()));
    if (queue.length > MAX_QUEUE) {
      log(`Loki долго не принимает записи: отброшено ${queue.length - MAX_QUEUE} самых старых`);
      queue = queue.slice(queue.length - MAX_QUEUE);
    }
    for (const batch of batches(queue, MAX_BATCH_BYTES)) {
      try {
        await push(batch);
        written += batch.length;
        queue = queue.slice(batch.length);
        if (failing) log('Loki снова принимает записи');
        failing = false;
      } catch (e) {
        if (!(e instanceof PushError)) throw e;
        if (signal.aborted) break;
        if (!e.retry) {
          log(`записи не приняты: ${e.message}`);
          queue = queue.slice(batch.length);
          continue;
        }
        if (!failing) log(`${e.message}: записи ждут в очереди`);
        failing = true;
        break;
      }
    }
    if (Date.now() - reported >= 10 * 60_000) {
      log(`за 10 минут записано ${written} записей`);
      written = 0;
      reported = Date.now();
    }
    await sleep(1000);
  }
}

log(`Loki: ${base}`);
await waitReady();
if (!signal.aborted) log('Loki готов');
if (!signal.aborted && args['no-history'] !== true) await writeHistory();
if (!signal.aborted) await live();
log('остановлен');
