// Запуск сервера Threadline.

import './regexp-guard.ts';
import './env.ts';
import { resolve } from 'node:path';
import { buildApp } from './app.ts';
import { Backends } from './backends/registry.ts';
import { envSourcesMessage } from './config/env-overlay.ts';
import { ConfigError, loadConfig, missingSecret, readAuthSecrets, type AuthSecrets } from './config/load.ts';
import { Health } from './health.ts';
import { logLine, queryLog } from './logging.ts';
import { Metrics } from './metrics.ts';
import { MemoryBudget } from './search/memory.ts';
import { telegramFromEnv } from './notifications/telegram.ts';
import { ROOT, WEB_DIST } from './paths.ts';
import { openNetworkWarning } from './projects/routes.ts';
import { shutdownHandler, shutdownTimeoutMs } from './shutdown.ts';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

/** Необработанная ошибка: запись журнала вместо обычного вывода Node. Только тип и код: текст может повторять значения. */
function fatal(e: unknown): never {
  const facts = e as { name?: unknown; code?: unknown } | null;
  logLine('fatal', `Threadline остановлен необработанной ошибкой: ${String(facts?.name ?? typeof e)}${facts?.code ? ` ${String(facts.code)}` : ''}`);
  process.exit(1);
}

async function main() {
  let config;
  let authSecrets: AuthSecrets | undefined;
  try {
    config = await loadConfig({ start: true });
    authSecrets = readAuthSecrets(config);
  } catch (e) {
    if (e instanceof ConfigError) {
      logLine('fatal', e.oneLine());
      process.exit(1);
    }
    throw e;
  }

  const backends = new Backends(config);
  // Сквозные тесты собирают интерфейс в свой каталог: dist работающего Threadline не меняется.
  const webDist = process.env.THREADLINE_WEB_DIST?.trim() ? resolve(ROOT, process.env.THREADLINE_WEB_DIST.trim()) : WEB_DIST;
  const health = new Health();
  // Бюджет памяти под результаты следует за пределом кучи: --max-old-space-size в NODE_OPTIONS образа.
  const memory = new MemoryBudget();
  const app = await buildApp({ config, backends, webDist, logger: true, databaseUrl: process.env.THREADLINE_DATABASE_URL, authSecrets, telegram: telegramFromEnv(process.env), health, metrics: new Metrics({ runtime: true }), memory });
  const host = process.env.HOST?.trim() || '127.0.0.1';
  const port = Number(process.env.PORT?.trim() || 8080);

  backends.onQuery = queryLog(app.log);
  app.log.info(envSourcesMessage(config.fromEnv ?? []));
  app.log.info(memory.describe());
  for (const [id, b] of Object.entries(config.backends)) {
    const missing = missingSecret(b);
    if (missing) app.log.warn(`хранилище «${id}» не настроено: не задана переменная окружения ${missing}`);
  }
  for (const w of config.warnings ?? []) app.log.warn(`${w.path}: ${w.message}`);
  if (!LOOPBACK.has(host) && config.config.auth === 'off') {
    app.log.warn(openNetworkWarning(host, port));
  }

  const stop = shutdownHandler({ app, health, timeoutMs: shutdownTimeoutMs(process.env) });
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  await app.listen({ host, port });
  app.log.info(`Threadline запущен: http://${host.includes(':') ? `[${host}]` : host}:${port}  (настройка: ${config.path})`);
}

process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);
// В образе Node запущен с --no-warnings: текстом в stderr предупреждения не идут, журнал остаётся JSON. Только вид и код: текст бывает с адресом.
process.on('warning', (w: Error & { code?: string }) => {
  if (w.name !== 'ExperimentalWarning') logLine('warn', `предупреждение Node: ${w.name}${w.code ? ` ${w.code}` : ''}`);
});
await main().catch(fatal);
