import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { ICONS } from './scripts/icons.ts';

type ModuleInfoOf = (id: string) => { importers: readonly string[] } | null;

const FLOW_LIBS = /\/node_modules\/@(xyflow|dagrejs)\//;
const FLOW_SRC = '/src/features/flow/canvas/';
const DOCS_LIBS = /\/node_modules\/react-markdown\//;
const DOCS_SRC = '/src/features/docs/';
// Текст документации: чанк на язык и группу страниц. Страница грузит только язык интерфейса и свой раздел, 4 чанка «Документации»
// и 1 «Обучения» вместо файла на страницу; самая большая группа меньше предела предупреждения сборки.
const DOCS_TEXT = /\/src\/features\/docs\/content\/([a-z]{2})\/(?:docs\/(guide|file|arch|admin)-[^/]+|learn\/[^/]+)\.md\?raw$/;
// Редактор файла проекта. yaml нужен и воркеру разбора: там своя сборка, в этот чанк он не считается.
const EDITOR_LIBS = /\/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?(?:@codemirror\/|@lezer\/|crelt\/|style-mod\/|w3c-keyname\/|yaml\/)/;
const EDITOR_SRC = '/src/features/project-file/';
// Значки одной страницы идут в чанк этой страницы: потолок общего ui не поднимается. Запрос и поле периода — главный чанк, документация и файл проекта — их ленивые чанки.
// Общие файлы значков тоже без ручного чанка: иначе сборка потянула бы за ними в ui всё, что они реэкспортируют.
const PAGE_ICONS = /\/lucide-react\/dist\/esm\/(?:lucide-react|icons\/(?:index|maximize-2|panel-right-close|panel-right-open|chevron-left|calendar-days|download|compass|file-code-corner|hash|lightbulb|network|octagon-alert|panel-left|server-cog))\.m?js$/;

/**
 * Модули чанка flow: библиотеки @xyflow и @dagrejs и всё из node_modules, что
 * импортируют только они или код холста. Так зависимости React Flow (zustand, d3) не уходят в общий ui.
 * Наибольшая неподвижная точка по всему графу модулей: модуль выбывает, если хоть один импортёр не из flow.
 * Циклы внутри пакетов (d3-transition) так остаются во flow, а цикл с импортёром снаружи выбывает целиком.
 */
function ownModules(ids: Iterable<string>, info: ModuleInfoOf, libs: RegExp, src: string): Set<string> {
  const flow = new Set([...ids].filter((id) => id.includes('/node_modules/') || id.includes(src)));
  for (let changed = true; changed; ) {
    changed = false;
    for (const id of flow) {
      if (libs.test(id) || !id.includes('/node_modules/')) continue;
      const importers = info(id)?.importers ?? [];
      if (importers.length === 0 || importers.some((i) => !flow.has(i))) {
        flow.delete(id);
        changed = true;
      }
    }
  }
  return flow;
}

export const flowModules = (ids: Iterable<string>, info: ModuleInfoOf) => ownModules(ids, info, FLOW_LIBS, FLOW_SRC);

/**
 * Какие запросы обслуживает воркер, кроме файлов сборки: только переходы на страницы интерфейса своего адреса. Ответ всегда из сети,
 * без сети — разметка интерфейса из кэша, и страница сама показывает, что сервер недоступен. API, проверки здоровья и метрики
 * идут мимо воркера всегда, ни один их ответ не попадает в кэш. Функция уходит в sw.js своим текстом, поэтому без внешних имён.
 */
export function shellNavigation({ request, url, sameOrigin }: { request: Request; url: URL; sameOrigin: boolean }): boolean {
  return sameOrigin && request.mode === 'navigate' && !/^\/(?:api|health|metrics)(?:\/|$)/.test(url.pathname);
}

// Граф модулей одной сборки не меняется: множества считаются один раз на сборку.
let flowCache: { info: unknown; set: Set<string> } | null = null;
let docsCache: { info: unknown; set: Set<string> } | null = null;
let editorCache: { info: unknown; set: Set<string> } | null = null;

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // Устанавливаемое приложение: манифест и воркер только в сборке, регистрацию делает lib/pwa.ts.
    VitePWA({
      mode: 'production',
      injectRegister: false,
      manifest: {
        name: 'Threadline',
        short_name: 'Threadline',
        description: 'Путь каждого запроса по логам: откуда пришёл, через какие системы прошёл, где ждал и где остановился.',
        lang: 'ru',
        dir: 'ltr',
        id: '/',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        theme_color: '#ffffff',
        background_color: '#ffffff',
        icons: ICONS.filter((i) => i.file.startsWith('icons/')).map((i) => ({
          src: `/${i.file}`,
          sizes: `${i.size}x${i.size}`,
          type: 'image/png',
          purpose: i.maskable ? 'maskable' : 'any',
        })),
      },
      workbox: {
        // Только оболочка: разметка, код, стили и шрифты сборки, значки. Картинки документации и прочие файлы — по сети, как раньше.
        globPatterns: ['index.html', 'theme-init.js', 'favicon.svg', 'favicon-32.png', 'apple-touch-icon.png', 'assets/**/*.{js,css,woff2}'],
        // Разметка из кэша только без сети: переход на страницу всегда идёт на сервер (shellNavigation).
        navigateFallback: null,
        // Иначе адрес «/» совпал бы с разметкой в кэше и открывался бы из него даже при живом сервере.
        directoryIndex: null,
        runtimeCaching: [{ urlPattern: shellNavigation, handler: 'NetworkOnly', options: { precacheFallback: { fallbackURL: 'index.html' } } }],
        cleanupOutdatedCaches: true,
        // Первая установка сразу берёт открытую вкладку. Новая версия ждёт следующей загрузки страницы: lib/pwa.ts.
        clientsClaim: true,
        skipWaiting: false,
        disableDevLogs: true,
      },
    }),
  ],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5173,
    strictPort: true,
    // changeOrigin: false — запрос правки проектов сверяет Origin и Host.
    proxy: { '/api': { target: 'http://127.0.0.1:8080', changeOrigin: false } },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    // Манифест сборки читает тест бюджета ленивого чанка графа (features/flow/bundle.test.ts).
    manifest: true,
    // Снимки документации всегда файлами: маленький снимок, встроенный строкой, попал бы в код страницы на всех языках сразу.
    assetsInlineLimit: (file) => (file.includes('/features/docs/content/shots/') ? false : undefined),
    // Библиотеки отдельно от кода Threadline: при обновлении Threadline браузер перекачивает только своё.
    rollupOptions: {
      output: {
        manualChunks(id, { getModuleInfo, getModuleIds }) {
          const text = DOCS_TEXT.exec(id);
          if (text) return `docs-text-${text[1]}-${text[2] ?? 'learn'}`;
          if (!id.includes('/node_modules/') || PAGE_ICONS.test(id)) return undefined;
          // Граф потока грузится только на странице запроса: его библиотеки — в своём чанке.
          if (flowCache?.info !== getModuleInfo) flowCache = { info: getModuleInfo, set: flowModules(getModuleIds(), getModuleInfo) };
          if (flowCache.set.has(id)) return 'flow';
          // Показ документации: библиотека и всё, что нужно только ей, не идут в общий ui.
          if (docsCache?.info !== getModuleInfo) docsCache = { info: getModuleInfo, set: ownModules(getModuleIds(), getModuleInfo, DOCS_LIBS, DOCS_SRC) };
          if (docsCache.set.has(id)) return 'docs';
          // Редактор файла проекта: библиотеки не идут ни в главный чанк, ни в общий ui.
          if (editorCache?.info !== getModuleInfo) editorCache = { info: getModuleInfo, set: ownModules(getModuleIds(), getModuleInfo, EDITOR_LIBS, EDITOR_SRC) };
          // Чанк редактора был бы больше chunkSizeWarningLimit (470 КБ без сжатия): yaml отдельно, предел не поднимается.
          if (editorCache.set.has(id)) return /\/node_modules\/(?:\.pnpm\/yaml@[^/]+\/node_modules\/)?yaml\//.test(id) ? 'editor-yaml' : 'editor';
          // Защита показа страницы из лога: нужна, только когда человек выбрал «Как страница».
          if (/\/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?dompurify\//.test(id)) return 'sanitize';
          if (/\/node_modules\/(react|react-dom|scheduler|react-router|cookie|set-cookie-parser)\//.test(id)) return 'react';
          if (/\/node_modules\/(@tanstack|i18next|react-i18next|html-parse-stringify|void-elements)\//.test(id)) return 'data';
          return 'ui';
        },
      },
    },
    chunkSizeWarningLimit: 400,
  },
});
