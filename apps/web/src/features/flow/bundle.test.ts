import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Бюджет ленивого чанка графа по манифесту сборки: JS и CSS, достижимые из FlowGraph.tsx по
// статическим импортам и не загруженные страницей заранее, — не больше 100 КБ gzip. Общий ui — не больше потолка.

const ENTRY = 'src/features/flow/canvas/FlowGraph.tsx';
const FLOW_BUDGET = 100 * 1024;
// Чанк ui без @xyflow/react и @dagrejs/dagre — 54 244 байт gzip. Radix Dialog боковой формы справочника и иконки
// редактора довели его до 56 997; потолок — плюс 2 КБ.
// zod сюда не попадает: core помечен sideEffects, схемы справочника интерфейсу не нужны.
// Ещё 0,5 КБ: подменю Radix для языка и темы в меню пользователя. Сами меню и строки лежат в ленивых чанках, отказаться можно только от подменю.
// Значки видов значения на карточках примеров стартовой страницы (карта, телефон, UUID, число), около 0,45 КБ: плюс 1 КБ.
const UI_CEILING = 56_997 + 2048 + 512 + 1024;
// Главный чанк без языков интерфейса — 106 672 байт gzip, с языками — 108 464. Потолок — плюс 2 КБ
// к исходному размеру, как у ui, и 0,5 КБ на ссылку и маршрут документации. Строки других языков сюда не попадают.
// Виды маски, 1,5 КБ: новые виды и образцы второго прохода нужны браузеру там же, где и прежние (search/business.ts). Поля раздела лежат в ленивом чанке.
// Роли и вход, 1,75 КБ: проверка входа и 401 стоят до первого кадра, шапка и страницы читают права, у Бизнеса свои слова по виду причины. Экраны входа, меню и выход лежат в ленивом чанке.
// Короткие ссылки, 1 КБ: источник данных и режим страницы, слоты кнопки и двух новых страниц, ветви режима на страницах результатов, запроса и операции. Кнопка, обе страницы и их строки лежат в ленивых чанках.
// Инструменты поддержки, 1,75 КБ: поле «Не содержит» и проверка значений идут через контроллер поиска, логика фильтров живёт там, где список, плюс слоты чанка tools и значок на ссылке «Справочник». Разметка полей и фильтров, cURL, контакт и их строки лежат в ленивом чанке.
// Оформление интерфейса потолок не подняло: страница операции живёт в ленивом чанке, это дало около 5 КБ запаса.
// Дополнения потолок тоже не подняли: их вход (сверка слова, паузы, Konami, ссылка «Титров» на логотипе) — 1 051 байт gzip, показ и строки в ленивом чанке.
// Международные правила маски, 1 КБ: план номеров телефона и образцы раздела regional, IBAN. Браузер получает правила
// уже проверенными и собирает образцы без разбора RE2, поэтому проверка выражений в главный чанк не попадает.
const MAIN_CEILING = 106_672 + 2048 + 512 + 1536 + 1792 + 1024 + 1792 + 1024;

// Редактор файла проекта: страница и библиотеки CodeMirror и yaml в своих ленивых чанках, сверх загруженного страницей.
// Ожидалось 130–170 КБ gzip, бюджет 180 КБ. Замер сборки: страница 11 928 байт, editor 122 008, editor-yaml 30 434, всего 164 370 байт gzip.
// Воркер разбора 30 920 байт gzip считается отдельно: он грузится только для текста больше 512 КБ.
const PROJECT_FILE_ENTRY = 'src/features/project-file/Page.tsx';
const PROJECT_FILE_BUDGET = 180 * 1024;

// Документация: страница, библиотеки показа с таблицами. Текст лежит рядом и растёт вместе с ним, поэтому бюджет только у чанка библиотек.
const DOCS_ENTRY = 'src/features/docs/DocsPage.tsx';
const DOCS_LIBS_BUDGET = 60 * 1024;
// Текст документации — не в чанке страницы, а в чанках по языку и группе страниц, грузится только на языке интерфейса.
// Чанк страницы со всем текстом документации — 305 КБ gzip, без текста — около 32 КБ. С главной, поиском по тексту,
// меню и «На странице» — 41,4 КБ. Бюджет — 44 КБ: текст в чанке страницы всё равно виден сразу.
const DOCS_PAGE_BUDGET = 44 * 1024;
const DOCS_TEXT_CHUNKS = ['en', 'ru'].flatMap((l) => ['admin', 'arch', 'file', 'guide', 'learn'].map((g) => `docs-text-${l}-${g}`)).sort();

// Большое окно кода: своего кода с перетаскиванием около 2,7 КБ gzip, в страницу не входит.
const CODE_WINDOW_BUDGET = 4 * 1024;

// Показ страницы из лога: DOMPurify около 9 КБ gzip, грузится при выборе «Как страница».
const SANITIZE_BUDGET = 12 * 1024;

interface Chunk {
  file: string;
  name?: string;
  isEntry?: boolean;
  imports?: string[];
  dynamicImports?: string[];
  css?: string[];
}
type Manifest = Record<string, Chunk>;

const root = fileURLToPath(new URL('../../..', import.meta.url));
let out = '';
let manifest: Manifest = {};
const size = (file: string) => gzipSync(readFileSync(join(out, file))).length;
// Чанков с именем ui может быть несколько: ленивый модуль ui.tsx даёт такое же имя. Общий тот, что страница грузит сразу.
const sharedUi = () => (manifest['index.html']!.imports ?? []).map((k) => manifest[k]!).find((c) => c.name === 'ui');

/** Файлы, которые грузит chunk со всеми статическими импортами: JS и CSS. */
function closure(m: Manifest, key: string, seen = new Set<string>()): Set<string> {
  const c = m[key];
  if (!c || seen.has(c.file)) return seen;
  seen.add(c.file);
  for (const css of c.css ?? []) seen.add(css);
  for (const i of c.imports ?? []) closure(m, i, seen);
  return seen;
}

beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), 'threadline-flow-bundle-'));
  // Меряется то, что получает пользователь: под vitest NODE_ENV=test сборка несла бы отладочный JSX с путями к файлам.
  vi.stubEnv('NODE_ENV', 'production');
  await build({
    root,
    configFile: join(root, 'vite.config.ts'),
    logLevel: 'silent',
    build: { outDir: out, emptyOutDir: true },
  });
  vi.unstubAllEnvs();
  manifest = JSON.parse(readFileSync(join(out, '.vite/manifest.json'), 'utf8')) as Manifest;
}, 240_000);

afterAll(() => {
  if (out) rmSync(out, { recursive: true, force: true });
});

describe('чанк графа потока', () => {
  it('FlowGraph.tsx — отдельный ленивый вход, не в статическом замыкании страницы', () => {
    expect(manifest[ENTRY], 'вход графа в манифесте').toBeDefined();
    const page = closure(manifest, 'index.html');
    expect(page.has(manifest[ENTRY]!.file)).toBe(false);
    const flowChunk = Object.values(manifest).find((c) => c.name === 'flow');
    expect(flowChunk, 'чанк библиотек flow').toBeDefined();
    expect(page.has(flowChunk!.file)).toBe(false);
  });

  it('замыкание FlowGraph.tsx сверх загруженного страницей — не больше 100 КБ gzip', () => {
    const page = closure(manifest, 'index.html');
    const own = [...closure(manifest, ENTRY)].filter((f) => !page.has(f));
    expect(
      own.some((f) => f.endsWith('.css')),
      'base.css и flow.css в замыкании',
    ).toBe(true);
    const total = own.reduce((n, f) => n + size(f), 0);
    expect(total).toBeLessThanOrEqual(FLOW_BUDGET);
  });

  it('общий чанк ui не несёт код React Flow и dagre', () => {
    const ui = sharedUi();
    expect(ui).toBeDefined();
    const code = readFileSync(join(out, ui!.file), 'utf8');
    expect(code).not.toContain('react-flow__');
    expect(code).not.toContain('dagre');
  });

  it('страница не грузит zod: схемы справочника и настройки остаются на сервере', () => {
    const page = closure(manifest, 'index.html');
    const js = [...page].filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(out, f), 'utf8'));
    // Метка из ядра zod 4: есть в любой сборке с zod.
    expect(js.some((c) => c.includes('ZodType'))).toBe(false);
  });

  it('общий чанк ui не больше потолка', () => {
    const ui = sharedUi();
    expect(ui).toBeDefined();
    // Рост ui — это новые библиотеки в общем коде страниц: каждая страница грузит их сразу.
    expect(size(ui!.file), `ui ${ui!.file}: потолок ${UI_CEILING} байт gzip`).toBeLessThanOrEqual(UI_CEILING);
  });

  it('главный чанк не больше потолка и не распался на части', () => {
    const main = manifest['index.html']!.file;
    // Потолок ничего не значит, если код ушёл в соседние файлы: страница грузит главный чанк и библиотеки react, data, ui.
    const page = closure(manifest, 'index.html');
    const names = Object.values(manifest).filter((c) => page.has(c.file) && c.file.endsWith('.js')).map((c) => c.name);
    expect(names.sort()).toEqual(['data', 'index', 'react', 'ui']);
    expect(size(main), `${main}: потолок ${MAIN_CEILING} байт gzip`).toBeLessThanOrEqual(MAIN_CEILING);
  });

  it('редактор файла проекта: свой ленивый чанк, не в странице и не в ui, в бюджете', () => {
    const page = closure(manifest, 'index.html');
    const editor = Object.values(manifest).find((c) => c.name === 'editor');
    const yamlChunk = Object.values(manifest).find((c) => c.name === 'editor-yaml');
    expect(manifest[PROJECT_FILE_ENTRY], 'вход страницы файла в манифесте').toBeDefined();
    expect(editor, 'чанк editor').toBeDefined();
    expect(yamlChunk, 'чанк editor-yaml').toBeDefined();
    for (const c of [manifest[PROJECT_FILE_ENTRY]!, editor!, yamlChunk!]) expect(page.has(c.file), c.file).toBe(false);

    const ui = readFileSync(join(out, sharedUi()!.file), 'utf8');
    const main = readFileSync(join(out, manifest['index.html']!.file), 'utf8');
    // Метки из кода библиотек: класс редактора CodeMirror и узел разбора yaml.
    for (const code of [ui, main]) {
      expect(code).not.toContain('cm-scroller');
      expect(code).not.toContain('yaml-language-server');
    }
    const own = [...closure(manifest, PROJECT_FILE_ENTRY)].filter((f) => !page.has(f));
    const editorParts = [manifest[PROJECT_FILE_ENTRY]!.file, editor!.file, yamlChunk!.file];
    for (const f of editorParts) expect(own).toContain(f);
    const total = editorParts.reduce((n, f) => n + size(f), 0);
    expect(total, `страница и библиотеки: бюджет ${PROJECT_FILE_BUDGET} байт gzip`).toBeLessThanOrEqual(PROJECT_FILE_BUDGET);
    // Оба чанка не больше предела предупреждения сборки: предел не поднимался.
    for (const f of editorParts) expect(readFileSync(join(out, f)).length, f).toBeLessThanOrEqual(400 * 1024);
  });

  it('чанк документации: ленивый, текст и снимки не в странице, чанк библиотек в бюджете', () => {
    const page = closure(manifest, 'index.html');
    const entry = manifest[DOCS_ENTRY];
    expect(entry, 'вход документации в манифесте').toBeDefined();
    const docs = Object.values(manifest).find((c) => c.name === 'docs');
    expect(docs, 'чанк docs').toBeDefined();
    for (const c of [entry!, docs!]) expect(page.has(c.file), c.file).toBe(false);
    expect([...page].some((f) => f.endsWith('.png') && f.includes('admin-status'))).toBe(false);
    expect(size(docs!.file), `docs ${docs!.file}: бюджет ${DOCS_LIBS_BUDGET} байт gzip`).toBeLessThanOrEqual(DOCS_LIBS_BUDGET);
  });

  it('текст документации: не в чанке страницы, чанк на язык и группу страниц, только по требованию', () => {
    const entry = manifest[DOCS_ENTRY]!;
    expect(size(entry.file), `${entry.file}: бюджет ${DOCS_PAGE_BUDGET} байт gzip`).toBeLessThanOrEqual(DOCS_PAGE_BUDGET);
    // Строка из английского текста: в коде страницы её нет.
    const title = readFileSync(join(root, 'src/features/docs/content/en/docs/arch-overview.md'), 'utf8').split('\n')[0]!.slice(2);
    expect(readFileSync(join(out, entry.file), 'utf8')).not.toContain(title);
    const texts = Object.entries(manifest).filter(([, c]) => c.name?.startsWith('docs-text-'));
    expect(texts.map(([, c]) => c.name).sort()).toEqual(DOCS_TEXT_CHUNKS);
    const statics = closure(manifest, DOCS_ENTRY);
    const page = closure(manifest, 'index.html');
    for (const [key, c] of texts) {
      expect(statics.has(c.file) || page.has(c.file), c.file).toBe(false);
      expect(entry.dynamicImports ?? [], c.file).toContain(key);
    }
    // Ни один чанк текста не больше предела предупреждения сборки.
    for (const [, c] of texts) expect(readFileSync(join(out, c.file)).length, c.file).toBeLessThanOrEqual(400 * 1024);
  });

  it('большое окно кода: свой ленивый чанк, код перетаскивания не в странице и не в ui', () => {
    const entry = manifest['src/features/request/CodeWindow.tsx'];
    expect(entry, 'вход окна в манифесте').toBeDefined();
    const page = closure(manifest, 'index.html');
    expect(page.has(entry!.file)).toBe(false);
    expect(size(entry!.file)).toBeLessThanOrEqual(CODE_WINDOW_BUDGET);
    const shared = [manifest['index.html']!.file, sharedUi()!.file].map((f) => readFileSync(join(out, f), 'utf8'));
    for (const code of shared) expect(code).not.toContain('threadline.codeWindow');
  });

  it('показ страницы из лога: свой ленивый чанк, DOMPurify не в странице и не в окне', () => {
    const entry = manifest['src/features/request/HtmlPage.tsx'];
    expect(entry, 'вход показа в манифесте').toBeDefined();
    const page = closure(manifest, 'index.html');
    expect(page.has(entry!.file)).toBe(false);
    const sanitize = Object.values(manifest).find((c) => c.name === 'sanitize');
    expect(sanitize, 'чанк sanitize').toBeDefined();
    expect(page.has(sanitize!.file)).toBe(false);
    expect(closure(manifest, 'src/features/request/CodeWindow.tsx').has(sanitize!.file)).toBe(false);
    expect(size(sanitize!.file)).toBeLessThanOrEqual(SANITIZE_BUDGET);
  });

  it('файла с zod нет ни в одном чанке интерфейса: раздел настроек файла проекта остаётся на сервере', () => {
    const js = Object.values(manifest).filter((c) => c.file.endsWith('.js')).map((c) => readFileSync(join(out, c.file), 'utf8'));
    expect(js.some((c) => c.includes('ZodType'))).toBe(false);
  });

  it('файлы en не входят в статическое замыкание страницы', () => {
    const page = closure(manifest, 'index.html');
    const files = Object.entries(manifest).filter(([key]) => /\/en\.json$/.test(key));
    for (const key of ['src/i18n/en.json', 'src/i18n/server/en.json']) {
      expect(manifest[key], `${key} в манифесте`).toBeDefined();
    }
    for (const [key, chunk] of files) expect(page.has(chunk.file), key).toBe(false);
  });
});

// Устанавливаемое приложение (vite.config.ts, VitePWA): та же сборка. Поведение воркера в браузере — e2e/pwa.spec.ts.
describe('устанавливаемое приложение', () => {
  const precached = () => [...readFileSync(join(out, 'sw.js'), 'utf8').matchAll(/url:"([^"]+)"/g)].map((m) => m[1]!);

  it('манифест: название, адрес запуска, окно приложения и значки', () => {
    const m = JSON.parse(readFileSync(join(out, 'manifest.webmanifest'), 'utf8')) as Record<string, unknown> & { icons: { src: string; sizes: string; purpose: string }[] };
    expect(m).toMatchObject({ name: 'Threadline', short_name: 'Threadline', start_url: '/', scope: '/', display: 'standalone', theme_color: '#ffffff', background_color: '#ffffff' });
    expect(m.description).toEqual(expect.any(String));
    expect(m.icons.map((i) => `${i.src} ${i.sizes} ${i.purpose}`)).toEqual(['/icons/icon-192.png 192x192 any', '/icons/icon-512.png 512x512 any', '/icons/icon-maskable-512.png 512x512 maskable']);
    for (const i of m.icons) expect(readFileSync(join(out, i.src)).length, i.src).toBeGreaterThan(0);
  });

  it('страница ссылается на манифест и значок iOS, встроенных скриптов нет: их запрещает CSP', () => {
    const html = readFileSync(join(out, 'index.html'), 'utf8');
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest">');
    expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
  });

  it('кэш воркера — только оболочка: разметка, код, стили, шрифты и значки; картинок документации и данных нет', () => {
    const urls = precached();
    expect(urls).toContain('index.html');
    expect(urls.filter((u) => u.startsWith('assets/') && u.endsWith('.js')).length).toBeGreaterThan(50);
    for (const u of urls) {
      expect(u, u).toMatch(/^(?:index\.html|theme-init\.js|favicon\.svg|favicon-32\.png|apple-touch-icon\.png|manifest\.webmanifest|icons\/icon-[a-z0-9-]+\.png|assets\/[^/]+\.(?:js|css|woff2))$/);
    }
  });

  it('переходы на страницы всегда идут на сервер, разметка из кэша — только без сети; /api, /health, /metrics мимо воркера', () => {
    const sw = readFileSync(join(out, 'sw.js'), 'utf8');
    // «/» не совпадает с разметкой в кэше, общего ответа на все переходы из кэша нет.
    expect(sw).toContain('directoryIndex:null');
    expect(sw).not.toContain('NavigationRoute');
    expect(sw).toMatch(/new \w+\.NetworkOnly\(\{plugins:\[new \w+\.PrecacheFallbackPlugin\(\{fallbackURL:"index\.html"\}\)\]\}\)/);
    expect(sw).toContain(String.raw`/^\/(?:api|health|metrics)(?:\/|$)/`);
    // Других маршрутов и кэшей во время работы нет.
    expect(sw.match(/registerRoute\(/g)).toHaveLength(1);
    expect(sw).not.toMatch(/CacheFirst|StaleWhileRevalidate|NetworkFirst/);
    // Новая версия ждёт следующей загрузки страницы: lib/pwa.ts.
    expect(sw).toContain('"SKIP_WAITING"===');
  });
});
