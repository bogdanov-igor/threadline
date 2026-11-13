import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { defineConfig } from '@playwright/test';
import { EXTRAS_PORT, prepareExtrasServer } from './e2e/extras-fixture.ts';

// База справочника основного сервера: по умолчанию PGlite в памяти; THREADLINE_E2E_DATABASE_URL — настоящий PostgreSQL
// (pnpm test:e2e:pg поднимает его в docker compose), off — без справочника: набор catalog.spec пропускается.
// Сервер single — всегда без справочника. Значения задаются явно: THREADLINE_DATABASE_URL разработчика сюда не попадает.
const given = process.env.THREADLINE_E2E_DATABASE_URL?.trim();
const catalogDb = given === 'off' ? '' : given || 'pglite://memory';
// Настройка маскирования одна на проект: набор masking правит её на своём сервере со своей базой, соседние наборы её не видят.
const maskingDb = given === 'off' ? '' : given ? `${given}_masking` : 'pglite://memory';
// Набор проектов создаёт и скрывает проекты: свой сервер и своя база, соседние наборы их не видят.
const projectsDb = given === 'off' ? '' : given ? `${given}_projects` : 'pglite://memory';
// Настройка вида одна на проект: набор view-settings правит её на своём сервере со своей базой.
const viewDb = given === 'off' ? '' : given ? `${given}_view` : 'pglite://memory';
// Файл проекта правит весь проект и сверяет версию: соседние наборы дали бы ложный конфликт, поэтому свой сервер и своя база.
const fileDb = given === 'off' ? '' : given ? `${given}_file` : 'pglite://memory';

// Сервер ролей: вход включён, сервис входа ложный. База всегда в памяти: пустая база на каждый прогон, настоящий PostgreSQL здесь ничего не добавляет.
const rolesDb = given === 'off' ? '' : 'pglite://memory';

// Локальный режим: своя команда запуска, папка данных во временном каталоге и заново на каждый прогон, база PGlite в ней.
const LOCAL_PORT = 8495;
const localData = join(tmpdir(), 'threadline-e2e-local');

const server = (config: string, port: number, env: Record<string, string>) => ({
  command: 'node --disable-warning=ExperimentalWarning src/main.ts',
  cwd: '../server',
  // Токен и адрес Grafana из .env сюда не попадают, интерфейс — из dist-e2e: живая Grafana и dist рабочего Threadline не затрагиваются.
  env: { THREADLINE_CONFIG: isAbsolute(config) ? config : `apps/web/e2e/${config}`, THREADLINE_WEB_DIST: 'apps/web/dist-e2e', THREADLINE_GRAFANA_TOKEN: '', THREADLINE_GRAFANA_URL: '', THREADLINE_ALLOW_NO_LOGIN: '1', THREADLINE_TELEGRAM_BOT_TOKEN: '', THREADLINE_TELEGRAM_CHAT_ID: '', PORT: String(port), LOG_LEVEL: 'warn', ...env },
  url: `http://127.0.0.1:${port}/api/health`,
  reuseExistingServer: false,
  timeout: 30_000,
});

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  retries: 0,
  reporter: 'list',
  use: {
    locale: 'ru-RU',
    // Браузер в другом поясе: интерфейс всё равно показывает время проекта.
    timezoneId: 'Europe/Moscow',
    colorScheme: 'light',
    // Воркер приложения ставит кэш оболочки в каждом новом контексте: лишняя нагрузка на каждый тест. Его проверяет pwa.spec.ts, там он разрешён.
    serviceWorkers: 'block',
  },
  projects: [
    { name: 'main', testIgnore: /single\.spec|masking\.spec|projects\.spec|projects-readonly\.spec|view-settings\.spec|roles\.spec|share\.spec|project-file\.spec|extras\.spec|local\.spec/, use: { baseURL: 'http://127.0.0.1:8099' } },
    { name: 'local', testMatch: /local\.spec/, fullyParallel: false, workers: 1, use: { baseURL: `http://127.0.0.1:${LOCAL_PORT}` } },
    { name: 'masking', testMatch: /masking\.spec/, fullyParallel: false, use: { baseURL: 'http://127.0.0.1:8097' } },
    { name: 'single', testMatch: /single\.spec|projects-readonly\.spec/, use: { baseURL: 'http://127.0.0.1:8098' } },
    { name: 'projects', testMatch: /projects\.spec/, fullyParallel: false, workers: 1, use: { baseURL: 'http://127.0.0.1:8096' } },
    { name: 'view-settings', testMatch: /view-settings\.spec/, fullyParallel: false, workers: 1, use: { baseURL: 'http://127.0.0.1:8095' } },
    { name: 'roles', testMatch: /(?<!project-file-)roles\.spec|share\.spec/, use: { baseURL: 'http://127.0.0.1:8094' } },
    { name: 'project-file', testMatch: /project-file\.spec/, fullyParallel: false, workers: 1, use: { baseURL: 'http://127.0.0.1:8092' } },
    // Файл сверяет версию проекта: правка из соседнего набора ролей законно давала «Проект изменили» и убирала кнопку применения.
    { name: 'project-file-roles', testMatch: /project-file-roles\.spec/, fullyParallel: false, workers: 1, use: { baseURL: 'http://127.0.0.1:8091' } },
    // Дополнения: шутки включены только здесь, часы браузера задаёт тест. Настройка во временной папке.
    { name: 'extras', testMatch: /extras\.spec/, use: { baseURL: `http://127.0.0.1:${EXTRAS_PORT}` } },
  ],
  webServer: [
    // «Неизвестное» демо-среды пишется только здесь: THREADLINE_CATALOG_DEMO_INBOX=1.
    server('threadline.e2e.yaml', 8099, { THREADLINE_DATABASE_URL: catalogDb, THREADLINE_CATALOG_DEMO_INBOX: '1' }),
    server('threadline.e2e-single.yaml', 8098, { THREADLINE_DATABASE_URL: '' }),
    server('threadline.e2e.yaml', 8097, { THREADLINE_DATABASE_URL: maskingDb }),
    server('threadline.e2e-projects.yaml', 8096, { THREADLINE_DATABASE_URL: projectsDb }),
    server('threadline.e2e-projects.yaml', 8095, { THREADLINE_DATABASE_URL: viewDb }),
    server('threadline.e2e-projects.yaml', 8092, { THREADLINE_DATABASE_URL: fileDb }),
    server('threadline.e2e-roles.yaml', 8091, { THREADLINE_DATABASE_URL: rolesDb, THREADLINE_PUBLIC_URL: 'http://127.0.0.1:8091', THREADLINE_OIDC_ISSUER: 'http://127.0.0.1:8093/realms/test', THREADLINE_OIDC_CLIENT_ID: 'threadline', THREADLINE_OIDC_CLIENT_SECRET: 'fake-client-secret', THREADLINE_SESSION_SECRET: 'fake-session-secret-for-e2e-only-0123456789' }),
    server(prepareExtrasServer(), EXTRAS_PORT, { THREADLINE_DATABASE_URL: '' }),
    {
      command: `node -e "require('node:fs').rmSync(process.argv[1], { recursive: true, force: true })" "${localData}" && node --disable-warning=ExperimentalWarning src/cli/local.ts --port ${LOCAL_PORT} --no-open --data "${localData}"`,
      cwd: '../server',
      env: { THREADLINE_WEB_DIST: 'apps/web/dist-e2e', LOG_LEVEL: 'warn' },
      url: `http://127.0.0.1:${LOCAL_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    server('threadline.e2e-roles.yaml', 8094, { THREADLINE_DATABASE_URL: rolesDb, THREADLINE_OIDC_CLIENT_SECRET: 'fake-client-secret', THREADLINE_SESSION_SECRET: 'fake-session-secret-for-e2e-only-0123456789' }),
    {
      command: 'node --disable-warning=ExperimentalWarning test/fake-oidc-main.ts',
      cwd: '../server',
      env: { PORT: '8093' },
      url: 'http://127.0.0.1:8093/realms/test/.well-known/openid-configuration',
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
