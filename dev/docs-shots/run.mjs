// Снимки экрана для документации, одна команда: pnpm docs:shots [список ...] [--only a,b] [--no-build] [--lang ru|en]
// Сервер только на имитации и базе в памяти, порты свободные, сборка во временной папке: dist, рабочий сервер и живая Grafana не затрагиваются.
// Формат списков и советы: dev/docs-shots/README.md. Сам скрипт в набор тестов не входит.
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dataReplacer, patchLocators, translator } from './translate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const WEB = join(ROOT, 'apps/web');
const SERVER = join(ROOT, 'apps/server');
const TMP = join(tmpdir(), 'threadline-docs-shots');
const DIST = join(TMP, 'dist');
const SHOTS = (lang) => join(WEB, 'src/features/docs/content/shots', lang);
// Два прогона снимков не идут одновременно: каталог-блокировка во временной папке.
const LOCK = process.env.THREADLINE_DOCS_SHOTS_LOCK ?? join(tmpdir(), 'threadline-docs-shots.lock');

const require = createRequire(join(WEB, 'package.json'));
const { chromium } = require('@playwright/test');
const sharp = require('sharp');

const ROLES = ['business', 'support', 'developer', 'analyst', 'admin'];
const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
const SCALE = 2;
const MAX_PNG_WIDTH = 1600;
const BLANK_ENV = ['THREADLINE_GRAFANA_TOKEN', 'THREADLINE_GRAFANA_URL', 'THREADLINE_CA_FILE', 'THREADLINE_PUBLIC_URL', 'THREADLINE_OIDC_ISSUER', 'THREADLINE_OIDC_CLIENT_ID', 'THREADLINE_OIDC_CLIENT_SECRET', 'THREADLINE_SESSION_SECRET', 'THREADLINE_TELEGRAM_BOT_TOKEN', 'THREADLINE_TELEGRAM_CHAT_ID', 'HTTPS_PROXY', 'HTTP_PROXY'];

function parseArgs(argv) {
  const out = { lists: [], only: null, build: true, lang: 'ru', out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') continue;
    if (a === '--no-build') out.build = false;
    else if (a === '--only') out.only = new Set((argv[++i] ?? '').split(',').filter(Boolean));
    else if (a === '--lang') out.lang = argv[++i] ?? 'ru';
    else if (a === '--out') out.out = resolve(argv[++i] ?? '.');
    else if (a.startsWith('--')) fail(`неизвестный ключ ${a}`);
    else out.lists.push(a);
  }
  return out;
}

function fail(message) {
  console.error(`docs-shots: ${message}`);
  process.exit(2);
}

/** Списки: все, кроме образца, или названные. Образец пишется только во временную папку и в сборку не попадает. */
async function loadScenarios(args) {
  const names = args.lists.length > 0 ? args.lists : readdirSync(HERE).filter((f) => f.endsWith('.list.mjs') && f !== 'example.list.mjs').map((f) => f.replace('.list.mjs', ''));
  const scenarios = [];
  for (const list of names) {
    const file = list.includes('/') ? resolve(list) : join(HERE, `${list}.list.mjs`);
    if (!existsSync(file)) fail(`нет списка ${file}`);
    const mod = await import(`${pathToFileURL(file).href}?t=${Date.now()}`);
    for (const s of mod.default ?? []) {
      if (!/^[a-z0-9-]+$/.test(s.name ?? '')) fail(`${list}: имя снимка «${s.name}»: только латиница, цифры и дефис`);
      if (typeof s.path !== 'string' || !s.path.startsWith('/')) fail(`${list}/${s.name}: путь начинается с косой черты`);
      if (s.role && !ROLES.includes(s.role)) fail(`${list}/${s.name}: роль «${s.role}», есть ${ROLES.join(', ')}`);
      const twin = scenarios.find((x) => x.name === s.name);
      if (twin) fail(`снимок ${s.name} есть в двух списках: ${twin.list} и ${list}`);
      scenarios.push({ ...s, list });
    }
  }
  return { scenarios, names };
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

let lockHeld = false;
const children = [];
function cleanup() {
  for (const c of children) if (c.exitCode === null) c.kill();
  if (lockHeld) {
    lockHeld = false;
    try {
      rmdirSync(LOCK);
    } catch {
      // Уже снята.
    }
  }
}
process.on('exit', cleanup);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(130));

async function takeLock() {
  mkdirSync(dirname(LOCK), { recursive: true });
  let told = false;
  for (;;) {
    try {
      mkdirSync(LOCK);
      lockHeld = true;
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (!told) console.log('Жду блокировку: идёт другой прогон снимков.');
      told = true;
      await sleep(15_000);
    }
  }
}

function buildWeb() {
  console.log('Собираю интерфейс во временную папку.');
  // Предупреждения сборки к снимкам не относятся: вывод нужен только при сбое.
  const res = spawnSync('pnpm', ['exec', 'vite', 'build', '--outDir', DIST, '--emptyOutDir', '--logLevel', 'error'], { cwd: WEB, encoding: 'utf8', env: process.env });
  if (res.status !== 0) {
    console.error(`${res.stdout}\n${res.stderr}`);
    fail('сборка интерфейса не удалась');
  }
}

// DOCS_SHOTS_PORT: порты подряд с этого номера (главный сервер, затем сервис входа и сервер ролей) вместо свободных случайных.
let nextPort = Number(process.env.DOCS_SHOTS_PORT) || 0;
const freePort = () =>
  nextPort ? Promise.resolve(nextPort++) : new Promise((done, reject) => {
    const s = createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => done(port));
    });
  });

/** Папка настройки сервера: файл, логотипы и справочник из e2e. Логотипы и справочник читаются от папки файла. */
function writeConfig(name, transform = (text) => text) {
  const dir = join(TMP, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'logos'), { recursive: true });
  for (const f of ['demo-pay-light.png', 'demo-pay-dark.png']) copyFileSync(join(ROOT, 'config/logos', f), join(dir, 'logos', f));
  cpSync(join(WEB, 'e2e/catalog'), join(dir, 'catalog'), { recursive: true });
  const file = join(dir, 'threadline.yaml');
  writeFileSync(file, transform(readFileSync(join(HERE, 'threadline.docs.yaml'), 'utf8')));
  return file;
}

function startProcess(name, args, env) {
  const log = join(TMP, `${name}.log`);
  const out = openSync(log, 'w');
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', ...args], { cwd: SERVER, env: { ...process.env, ...Object.fromEntries(BLANK_ENV.map((k) => [k, ''])), ...env }, stdio: ['ignore', out, out] });
  children.push(child);
  return { child, log };
}

async function waitFor(url, { child, log }) {
  for (let i = 0; i < 300; i++) {
    if (child.exitCode !== null) break;
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // Ещё не поднялся.
    }
    await sleep(100);
  }
  console.error(readFileSync(log, 'utf8').split('\n').slice(-20).join('\n'));
  fail(`сервер не ответил: ${url}`);
}

async function startThreadline(name, configFile, env = {}) {
  const port = env.PORT ?? (await freePort());
  const proc = startProcess(name, ['src/main.ts'], { THREADLINE_CONFIG: configFile, THREADLINE_GRAFANA_URL: '', THREADLINE_ALLOW_NO_LOGIN: '1', THREADLINE_WEB_DIST: DIST, THREADLINE_DATABASE_URL: 'pglite://memory', THREADLINE_CATALOG_DEMO_INBOX: '1', HOST: '127.0.0.1', LOG_LEVEL: 'warn', ...env, PORT: String(port) });
  const base = `http://127.0.0.1:${port}`;
  await waitFor(`${base}/api/health`, proc);
  return base;
}

/** Сервер ролей: вход включён, сервис входа ложный, из сквозных тестов. Поднимается, только если снимку нужна роль. */
async function startRolesServer() {
  const oidcPort = await freePort();
  const port = await freePort();
  const oidc = startProcess('oidc', ['test/fake-oidc-main.ts'], { PORT: String(oidcPort) });
  await waitFor(`http://127.0.0.1:${oidcPort}/realms/test/.well-known/openid-configuration`, oidc);
  const auth = ['auth:', `  issuer: http://127.0.0.1:${oidcPort}/realms/test`, '  clientId: threadline', `  publicUrl: http://127.0.0.1:${port}`, '  roleClaim: realm_access.roles', '  roles:', '    business: [threadline-business]', '    support: [threadline-tech-support, threadline-customer-support]', '    developer: [threadline-developer]', '    analyst: [threadline-analyst]', '    admin: [threadline-admin]'].join('\n');
  const file = writeConfig('config-roles', (text) => text.replace(/^auth: off$/m, auth));
  return startThreadline('threadline-roles', file, { PORT: port, THREADLINE_OIDC_CLIENT_SECRET: 'fake-client-secret', THREADLINE_SESSION_SECRET: 'fake-session-secret-for-docs-only-0123456789' });
}

async function shoot(browser, s, base, lang, tr) {
  const viewport = s.viewport ?? DEFAULT_VIEWPORT;
  const context = await browser.newContext({ baseURL: base, viewport, deviceScaleFactor: SCALE, locale: lang === 'ru' ? 'ru-RU' : 'en-US', timezoneId: 'UTC', colorScheme: 'light', serviceWorkers: 'block' });
  try {
    await context.addInitScript((code) => {
      localStorage.setItem('threadline.theme', 'light');
      localStorage.setItem('threadline.language', code);
    }, lang);
    // Наружу из снимка ничего не уходит: только сервер этого прогона и его сервис входа.
    await context.route(
      (url) => url.hostname !== '127.0.0.1',
      (route) => route.abort(),
    );
    // Данные на языке снимка: ответы API с именами пользователей и русскими примерами проходят через словарь.
    if (tr?.data)
      await context.route('**/api/**', async (route) => {
        // Вход и переходы страницы идут как есть: ответ с перенаправлением подменять нельзя.
        if (route.request().isNavigationRequest() || route.request().method() !== 'GET') return route.fallback();
        const res = await route.fetch({ maxRedirects: 0 });
        if (!/json|yaml|text/.test(res.headers()['content-type'] ?? '')) return route.fulfill({ response: res });
        return route.fulfill({ response: res, body: tr.data.replace(await res.text()) });
      });
    const page = await context.newPage();
    if (tr) patchLocators(page, tr);
    page.setDefaultTimeout(20_000);
    await page.goto(s.path);
    if (s.role) {
      await page.locator(`a[data-user="${s.role}"]`).click();
      await page.waitForURL((url) => url.href.startsWith(base));
    }
    await page.waitForLoadState('networkidle').catch(() => {});
    if (s.actions) await s.actions(page);
    await page.evaluate(() => document.fonts.ready);
    await sleep(150);
    const options = { animations: 'disabled', caret: 'hide', type: 'png' };
    let raw;
    if (s.crop) {
      const target = s.crop(page);
      await target.waitFor();
      if (s.pad) {
        await target.scrollIntoViewIfNeeded();
        const box = await target.boundingBox();
        raw = await page.screenshot({ ...options, clip: { x: Math.max(0, box.x - s.pad), y: Math.max(0, box.y - s.pad), width: box.width + 2 * s.pad, height: box.height + 2 * s.pad } });
      } else raw = await target.screenshot(options);
    } else raw = await page.screenshot({ ...options, fullPage: Boolean(s.fullPage) });
    return raw;
  } finally {
    await context.close();
  }
}

/** Палитра вместо полного цвета: снимок интерфейса от этого почти не меняется, файл становится в несколько раз меньше. */
async function optimize(raw) {
  const meta = await sharp(raw).metadata();
  const width = Math.round(meta.width / SCALE);
  const height = Math.round(meta.height / SCALE);
  const png = await sharp(raw).resize({ width: MAX_PNG_WIDTH, withoutEnlargement: true }).png({ palette: true, quality: 85, compressionLevel: 9, effort: 10 }).toBuffer();
  return { png, width, height };
}

const readIndex = (dir) => {
  try {
    return JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
  } catch {
    return {};
  }
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { scenarios, names } = await loadScenarios(args);
  const chosen = args.only ? scenarios.filter((s) => args.only.has(s.name)) : scenarios;
  if (chosen.length === 0) fail(`нечего снимать: списки ${names.join(', ') || 'не найдены'}`);

  await takeLock();
  mkdirSync(TMP, { recursive: true });
  if (args.build) buildWeb();
  else if (!existsSync(join(DIST, 'index.html'))) fail('сборки ещё нет: запустите без --no-build');

  const main = await startThreadline('threadline', writeConfig('config'));
  const roles = chosen.some((s) => s.role) ? await startRolesServer() : null;
  const browser = await chromium.launch();
  // Списки написаны по русскому интерфейсу: на другом языке строки интерфейса в поиске элементов переводятся.
  const tr = args.lang === 'ru' ? null : translator(WEB, args.lang, dataReplacer(HERE, args.lang));
  // Свою подмену ответов список ставит поверх общей: словарь данных ему нужен тоже.
  globalThis.docsShotsData = tr?.data?.replace ?? null;

  const onlyExample = names.length === 1 && names[0] === 'example';
  const dir = args.out ?? (onlyExample ? join(TMP, 'example-shots') : SHOTS(args.lang));
  mkdirSync(dir, { recursive: true });
  const index = readIndex(dir);
  const failed = [];
  let bytes = 0;
  for (const s of chosen) {
    try {
      const raw = await shoot(browser, s, s.role ? roles : main, args.lang, tr);
      const { png, width, height } = await optimize(raw);
      writeFileSync(join(dir, `${s.name}.png`), png);
      index[s.name] = { width, height };
      bytes += png.length;
      console.log(`  ${s.name}: ${width}×${height}, ${Math.round(png.length / 1024)} КБ`);
    } catch (e) {
      failed.push(s.name);
      console.error(`  ${s.name}: СБОЙ, ${String(e.message ?? e).split('\n')[0]}`);
    }
  }
  await browser.close();

  // Полный прогон убирает снимки, которых больше нет ни в одном списке.
  if (!args.out && !onlyExample && args.lists.length === 0 && !args.only) {
    const known = new Set(scenarios.map((s) => s.name));
    for (const f of readdirSync(dir)) {
      const name = f.replace(/\.png$/, '');
      if (f.endsWith('.png') && !known.has(name)) {
        rmSync(join(dir, f));
        delete index[name];
        console.log(`  ${name}: убран, его нет в списках`);
      }
    }
  }
  const sorted = Object.fromEntries(Object.entries(index).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(join(dir, 'index.json'), `${JSON.stringify(sorted, null, 2)}\n`);

  const total = readdirSync(dir).filter((f) => f.endsWith('.png')).reduce((n, f) => n + statSync(join(dir, f)).size, 0);
  console.log(`Готово: ${chosen.length - failed.length} из ${chosen.length}, этот прогон ${Math.round(bytes / 1024)} КБ, всего в папке ${Math.round(total / 1024)} КБ. Папка: ${dir}`);
  if (failed.length > 0) {
    console.error(`Сбои: ${failed.join(', ')}. Журнал сервера: ${join(TMP, 'threadline.log')}`);
    process.exit(1);
  }
  process.exit(0);
}

await main();
