// Справочник файлом: pnpm threadline:catalog import <проект> <файл> [--dry-run] [--force] | export <проект> <файл> | schema <файл>.
// Пути — от каталога запуска (INIT_CWD). Из подкаталога без package.json pnpm сам переходит в корень репозитория,
// исходный каталог ему уже неизвестен: памятка велит запускать из корня или давать абсолютный путь. Пароль базы не печатается.

import '../regexp-guard.ts';
import '../env.ts';
import { runCatalogCli } from '../catalog/cli-run.ts';

const code = await runCatalogCli(process.argv.slice(2), {
  env: process.env,
  cwd: process.env.INIT_CWD ?? process.cwd(),
  out: (l) => console.log(l),
  err: (l) => console.error(l),
});
process.exit(code);
