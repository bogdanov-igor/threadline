// Выборка живых записей: pnpm threadline:sample --env <среда> --kind <вид> [--live]; удаление: --clean. docs/DEVELOPMENT.md, «Выборка живых записей».
// В файл идёт устройство записей без значений, в терминал только путь и числа. Текст ошибки не печатается даже здесь: он может цитировать запись.

import '../regexp-guard.ts';
import { homedir } from 'node:os';
import { reportFatal, runSample } from '../sample/run.ts';

const fatal = (e: unknown) => {
  reportFatal(e, (l) => console.error(l));
  process.exit(2);
};
process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);

const argv = process.argv.slice(2);
// --clean работает без настройки и токена, даже если .env не читается.
if (!argv.includes('--clean')) await import('../env.ts');

function home(): string | undefined {
  try {
    return homedir() || undefined;
  } catch {
    return undefined;
  }
}

const ac = new AbortController();
process.once('SIGINT', () => ac.abort());
process.once('SIGTERM', () => ac.abort());

const code = await runSample(argv, {
  env: process.env,
  cwd: process.env.INIT_CWD ?? process.cwd(),
  home: home(),
  out: (l) => console.log(l),
  err: (l) => console.error(l),
  signal: ac.signal,
});
process.exit(code);
