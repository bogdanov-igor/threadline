// Сквозные тесты на настоящем PostgreSQL: сервис db из docker-compose.yml в отдельном проекте compose threadline-e2e
// со своим томом, портом 55433 и паролем только для тестов. База разработки и рабочий Threadline на 8080 не трогаются.
// Том пересоздаётся перед прогоном и удаляется после него (THREADLINE_E2E_KEEP_DB=1 оставляет базу для разбора).
// Аргументы передаются Playwright: node scripts/e2e-pg.ts e2e/catalog.spec.ts
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const web = fileURLToPath(new URL('..', import.meta.url));
const port = process.env.THREADLINE_E2E_DB_PORT ?? '55433';
const password = 'threadline-e2e';
const env = { ...process.env, THREADLINE_DB_PASSWORD: password, THREADLINE_DB_PORT: port };

function compose(...args: string[]): void {
  const r = spawnSync('docker', ['compose', '-p', 'threadline-e2e', '-f', `${root}docker-compose.yml`, ...args], { cwd: root, env, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`docker compose ${args.join(' ')} завершился с кодом ${r.status ?? r.error?.message}`);
    process.exit(1);
  }
}

compose('down', '-v');
compose('up', '-d', '--wait', 'db');
// Свои базы у наборов masking, projects, view-settings и project-file: playwright.config.ts.
compose('exec', '-T', 'db', 'psql', '-U', 'threadline', '-d', 'threadline', '-c', 'CREATE DATABASE threadline_masking');
compose('exec', '-T', 'db', 'psql', '-U', 'threadline', '-d', 'threadline', '-c', 'CREATE DATABASE threadline_projects');
compose('exec', '-T', 'db', 'psql', '-U', 'threadline', '-d', 'threadline', '-c', 'CREATE DATABASE threadline_view');
compose('exec', '-T', 'db', 'psql', '-U', 'threadline', '-d', 'threadline', '-c', 'CREATE DATABASE threadline_file');
// Сервер схему не меняет: миграции отдельным шагом для каждой базы, как в развёртывании.
for (const db of ['threadline', 'threadline_masking', 'threadline_projects', 'threadline_view', 'threadline_file']) {
  const migrate = spawnSync('pnpm', ['threadline:migrate'], { cwd: root, stdio: 'inherit', env: { ...process.env, THREADLINE_DATABASE_URL: `postgres://threadline:${password}@127.0.0.1:${port}/${db}` } });
  if (migrate.status !== 0) {
    console.error(`миграции базы ${db} завершились с кодом ${migrate.status ?? migrate.error?.message}`);
    process.exit(1);
  }
}
const run = spawnSync('pnpm', ['test:e2e', ...process.argv.slice(2)], {
  cwd: web,
  stdio: 'inherit',
  env: { ...process.env, THREADLINE_E2E_DATABASE_URL: `postgres://threadline:${password}@127.0.0.1:${port}/threadline` },
});
if (!process.env.THREADLINE_E2E_KEEP_DB) compose('down', '-v');
process.exit(run.status ?? 1);
