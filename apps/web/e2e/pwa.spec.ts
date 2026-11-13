import { expect, test, type Page, type Response } from '@playwright/test';

// Устанавливаемое приложение: манифест, воркер сборки и работа без сети. Остальные наборы воркер запрещают (playwright.config.ts).
test.use({ serviceWorkers: 'allow' });

/** Воркер установлен и управляет страницей: с первой установки он берёт открытую вкладку сам. */
async function controlled(page: Page): Promise<string> {
  const script = await page.evaluate(async () => (await navigator.serviceWorker.ready).active?.scriptURL ?? '');
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  return script;
}

/** Адреса всего, что лежит в кэшах воркера. */
const cachedUrls = (page: Page) =>
  page.evaluate(async () => {
    const out: string[] = [];
    for (const name of await caches.keys()) {
      for (const req of await (await caches.open(name)).keys()) out.push(new URL(req.url).pathname);
    }
    return out;
  });

test.describe('устанавливаемое приложение', () => {
  test('манифест: свой тип, название, адрес запуска, окно приложения и значки', async ({ page, request }) => {
    const r = await request.get('/manifest.webmanifest');
    expect(r.status()).toBe(200);
    expect(r.headers()['content-type']).toContain('application/manifest+json');
    const m = (await r.json()) as { name: string; short_name: string; start_url: string; scope: string; display: string; theme_color: string; background_color: string; icons: { src: string; sizes: string; purpose: string }[] };
    expect(m).toMatchObject({ name: 'Threadline', short_name: 'Threadline', start_url: '/', scope: '/', display: 'standalone' });
    expect(m.theme_color).toMatch(/^#[0-9a-f]{6}$/);
    expect(m.background_color).toMatch(/^#[0-9a-f]{6}$/);
    expect(m.icons.map((i) => `${i.sizes} ${i.purpose}`)).toEqual(['192x192 any', '512x512 any', '512x512 maskable']);
    for (const src of [...m.icons.map((i) => i.src), '/apple-touch-icon.png', '/favicon-32.png']) {
      const icon = await request.get(src);
      expect(icon.status(), src).toBe(200);
      expect(icon.headers()['content-type'], src).toBe('image/png');
    }
    const doc = (await page.goto('/pay/demo'))!;
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest');
    await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute('href', '/apple-touch-icon.png');
    const csp = doc.headers()['content-security-policy'];
    expect(csp).toContain("worker-src 'self'");
    expect(csp).toContain("manifest-src 'self'");
  });

  test('воркер сборки регистрируется и берёт страницу; цвет окна идёт за темой', async ({ page }) => {
    await page.goto('/pay/demo');
    expect(await controlled(page)).toMatch(/\/sw\.js$/);
    // Цвет фона темы как его отдают стили: сборка пишет белый коротко.
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', /^#f{3}(?:f{3})?$/);
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#121417');
  });

  test('воркер не обслуживает и не кэширует /api, /health и /metrics; файлы сборки отдаёт из кэша', async ({ page }) => {
    await page.goto('/pay/demo');
    await controlled(page);
    const seen: Response[] = [];
    page.on('response', (r) => seen.push(r));
    await page.reload();
    await expect(page.getByTestId('search-panel').getByTestId('connection-indicator')).toHaveAttribute('data-status', 'demo');
    const api = seen.filter((r) => new URL(r.url()).pathname.startsWith('/api/'));
    expect(api.length).toBeGreaterThan(0);
    for (const r of api) expect(r.fromServiceWorker(), r.url()).toBe(false);
    // Файлы сборки — из кэша воркера: значит, воркер в этой вкладке работает.
    expect(seen.some((r) => /\/assets\/.+\.js$/.test(r.url()) && r.fromServiceWorker())).toBe(true);

    // Запросы страницы к служебным адресам тоже мимо воркера.
    for (const path of ['/api/health', '/health', '/metrics']) {
      const [r] = await Promise.all([page.waitForResponse((x) => new URL(x.url()).pathname === path), page.evaluate((p) => fetch(p).then((x) => x.status), path)]);
      expect(r.fromServiceWorker(), path).toBe(false);
    }
    // И переходы на них.
    for (const path of ['/api/health', '/health', '/metrics']) {
      const r = (await page.goto(path))!;
      expect(r.status(), path).toBe(200);
      expect(r.fromServiceWorker(), path).toBe(false);
    }
    // Переход на страницу интерфейса обслуживает воркер, но ответ идёт из сети.
    const nav = (await page.goto('/pay/demo'))!;
    expect(nav.fromServiceWorker()).toBe(true);
    await expect(page.getByTestId('search-panel').getByTestId('connection-indicator')).toHaveAttribute('data-status', 'demo');

    const cached = await cachedUrls(page);
    expect(cached).toContain('/index.html');
    for (const path of cached) expect(path, path).not.toMatch(/^\/(?:api|health|metrics|s)(?:\/|$)/);
  });

  test('без сети: интерфейс из кэша и понятное сообщение «Сервер недоступен», со связью — снова работает', async ({ page, context }) => {
    await page.goto('/pay/demo');
    await controlled(page);
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Сервер Threadline недоступен' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('banner')).toBeVisible();
    // Документация без сервера тоже открывается: её текст в кэше.
    await page.goto('/docs');
    await expect(page.getByTestId('docs-home-sections')).toBeVisible();
    await expect(page.locator('main h1').first()).toBeVisible();
    await page.goto('/docs/guide-start');
    await expect(page.getByTestId('docs-nav').locator('a[aria-current="page"]')).toBeVisible();
    await context.setOffline(false);
    await page.goto('/pay/demo');
    await expect(page.getByTestId('search-panel').getByTestId('connection-indicator')).toHaveAttribute('data-status', 'demo');
  });
});

test.describe('нет связи с сервером с первой загрузки', () => {
  test.use({ serviceWorkers: 'block' });

  test('вместо бесконечной заготовки — «Сервер недоступен», «Повторить» возвращает страницу', async ({ page }) => {
    await page.route('**/api/**', (route) => route.abort('connectionrefused'));
    await page.goto('/pay/demo');
    await expect(page.getByRole('heading', { name: 'Сервер Threadline недоступен' })).toBeVisible({ timeout: 15_000 });
    // Заготовка проверки сессии не возвращается, пока сервер молчит.
    await page.waitForTimeout(3000);
    await expect(page.getByRole('heading', { name: 'Сервер Threadline недоступен' })).toBeVisible();
    await page.unroute('**/api/**');
    await page.getByRole('button', { name: 'Повторить' }).click();
    await expect(page.getByTestId('search-panel').getByTestId('connection-indicator')).toHaveAttribute('data-status', 'demo');
  });
});
