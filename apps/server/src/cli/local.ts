#!/usr/bin/env node
// Локальный режим: pnpm local, позже npx <имя из local/names.ts>. Один пользователь, вход выключен, адрес 127.0.0.1,
// база PGlite в каталоге данных, хранилища подключаются из интерфейса. Файл .env репозитория не читается.

import '../regexp-guard.ts';
import { logLine } from '../logging.ts';
import { runLocal } from '../local/run.ts';

// Журнал сервера в этом режиме — только предупреждения и ошибки: человеку в терминале хватает строк запуска.
process.env.LOG_LEVEL ||= 'warn';

/** Необработанная ошибка: тип и код, без текста: он может повторять значения. */
function fatal(e: unknown): never {
  const facts = e as { name?: unknown; code?: unknown; message?: unknown } | null;
  logLine('fatal', `локальный режим остановлен ошибкой: ${String(facts?.name ?? typeof e)}${facts?.code ? ` ${String(facts.code)}` : ''}`);
  process.exit(1);
}

process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);
process.on('warning', (w: Error & { code?: string }) => {
  if (w.name !== 'ExperimentalWarning') logLine('warn', `предупреждение Node: ${w.name}${w.code ? ` ${w.code}` : ''}`);
});

const result = await runLocal(process.argv.slice(2)).catch(fatal);
if (typeof result === 'number') process.exit(result);
