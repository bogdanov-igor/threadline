import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { header, homeLink, pickTheme, projectButton } from './helpers.ts';

// Блок Threadline в шапке: знак и название.

const indicator = (page: Page) => page.getByTestId('connection-indicator');
const fatal = (page: Page) => page.locator('[data-fatal-error]');
const lockup = (scope: Page | Locator) => scope.getByTestId('threadline-lockup');

/** Видимые картинки: адрес и загружена ли. */
const shown = (scope: Locator) =>
  scope.locator('img').evaluateAll((els) =>
    (els as HTMLImageElement[])
      .filter((el) => el.getClientRects().length > 0)
      .map((el) => ({ file: el.src, loaded: el.complete && el.naturalWidth > 0 })),
  );

/** Точные прямоугольники всего, что стоит в шапке: доли пикселя тоже считаются сдвигом. */
const layoutOf = (page: Page) =>
  page.locator('header a, header nav, header nav > *, header button, header img, header span').evaluateAll((els) =>
    els
      .filter((el) => el.getClientRects().length > 0)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return [el.tagName, r.x, r.y, r.width, r.height].join(' ');
      }),
  );

/** Сдвиги раскладки с начала загрузки страницы, источники внутри шапки. */
const headerShifts = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<string[]>((resolve) => {
        const out: string[] = [];
        new PerformanceObserver((list) => {
          for (const e of list.getEntries() as unknown as { value: number; sources: { node: Node | null }[] }[]) {
            for (const s of e.sources) {
              const el = s.node instanceof Element ? s.node : (s.node?.parentElement ?? null);
              if (el?.closest('header')) out.push(`${e.value.toFixed(5)} ${el.outerHTML.slice(0, 80)}`);
            }
          }
        }).observe({ type: 'layout-shift', buffered: true });
        setTimeout(() => resolve(out), 100);
      }),
  );

async function saveTheme(page: Page, saved: string) {
  await page.addInitScript((value) => localStorage.setItem('threadline.theme', value), saved);
}

const verticalOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollHeight - document.documentElement.clientHeight);
const horizontalOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test.describe('блок Threadline', () => {
  for (const width of [768, 1280, 2560]) {
    // Поле страницы 16px уже 1024, шире 24px: шапка берёт его же.
    const gutter = width < 1024 ? 16 : 24;
    for (const scheme of ['light', 'dark'] as const) {
      test(`${width}px, ${scheme}: знак и Threadline в одну строку, картинок в блоке нет, затем линия и проект`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await page.setViewportSize({ width, height: 800 });
        await page.goto('/pay/demo');
        const mark = (await header(page).getByTestId('threadline-mark').boundingBox())!;
        const name = (await homeLink(page).getByText('Threadline', { exact: true }).boundingBox())!;
        expect(mark).toMatchObject({ x: gutter, width: 22, height: 22 });
        expect(name.x).toBeGreaterThanOrEqual(mark.x + mark.width);
        const middle = (b: { y: number; height: number }) => b.y + b.height / 2;
        expect(Math.abs(middle(name) - middle(mark))).toBeLessThanOrEqual(1);
        expect(await shown(lockup(page))).toEqual([]);
        // Блок целиком в шапке 56px, справа линия и проект.
        const box = (await lockup(page).boundingBox())!;
        const head = (await header(page).boundingBox())!;
        expect(head.height).toBe(56);
        expect(box.y).toBeGreaterThanOrEqual(head.y);
        expect(box.y + box.height).toBeLessThanOrEqual(head.y + 55);
        const project = (await projectButton(page).boundingBox())!;
        expect(project.x).toBeGreaterThan(box.x + box.width + 16);
        expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
      });
    }
  }

  test('язык en: название помечено как английское, ссылка на языке интерфейса', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.addInitScript(() => localStorage.setItem('threadline.language', 'en'));
    await page.goto('/pay/demo');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(lockup(page).getByText('Threadline', { exact: true })).toHaveAttribute('lang', 'en');
    await expect(lockup(page)).toHaveText('Threadline');
  });

  test('русский: название помечено как английское', async ({ page }) => {
    await page.goto('/pay/demo');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
    await expect(lockup(page).getByText('Threadline', { exact: true })).toHaveAttribute('lang', 'en');
  });

  for (const width of [768, 1280]) {
    test(`${width}px: смена темы ничего не докачивает и не сдвигает`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/pay/demo');
      await expect(indicator(page)).toHaveAttribute('data-status', 'demo');
      await expect.poll(() => page.locator('img').evaluateAll((els) => (els as HTMLImageElement[]).every((el) => el.complete && el.naturalWidth > 0))).toBe(true);
      // Две версии логотипа проекта. Логотип cards не грузится до открытия меню.
      await expect(page.locator('img')).toHaveCount(2);
      const asked: string[] = [];
      page.on('request', (r) => {
        if (r.url().endsWith('.png') || r.url().includes('/logo/')) asked.push(r.url());
      });
      const markBefore = await header(page).getByTestId('threadline-mark').innerHTML();
      // Кнопка профиля приходит ленивым чанком на занятое место: раскладку меряем, когда она уже на месте.
      await expect(header(page).getByTestId('auth-off')).toBeVisible();
      const before = await layoutOf(page);
      for (const [name, theme] of [
        ['Тёмная', 'dark'],
        ['Светлая', 'light'],
      ] as const) {
        await pickTheme(page, name);
        expect(await shown(header(page).locator('nav'))).toEqual([{ file: expect.stringContaining(`/logo/${theme}?v=`), loaded: true }]);
        expect(await header(page).getByTestId('threadline-mark').innerHTML()).toBe(markBefore);
        expect(await layoutOf(page)).toEqual(before);
      }
      // «Как в системе» идёт за системой без перезагрузки.
      await pickTheme(page, 'Как в системе');
      for (const theme of ['dark', 'light'] as const) {
        await page.emulateMedia({ colorScheme: theme });
        expect(await layoutOf(page)).toEqual(before);
      }
      expect(asked).toEqual([]);
    });
  }

  test('знак встроен в разметку: шапка не сдвигается при загрузке', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/pay/demo');
    await expect(indicator(page)).toHaveAttribute('data-status', 'demo');
    await expect(header(page).getByTestId('auth-off')).toBeVisible();
    expect(await headerShifts(page)).toEqual([]);
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`${scheme}: разбор доступности шапки чистый, ссылка на главную работает`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto('/pay/long');
      await expect(indicator(page)).toHaveAttribute('data-status', 'demo');
      await expect(header(page).getByTestId('threadline-mark')).toBeVisible();
      await expect(header(page).locator('nav img:visible')).toHaveCount(1);
      expect((await header(page).boundingBox())!.height).toBe(56);
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
      const r = await new AxeBuilder({ page }).include('header').withTags(['wcag2a', 'wcag2aa']).analyze();
      expect(r.violations.map((v) => v.id)).toEqual([]);

      await page.goto('/zz/demo');
      await homeLink(page).click();
      await expect(page).toHaveURL(/\/pay\/long$/);
    });
  }

  test('ссылка называется «Threadline, на главную» и одна на весь блок, нажатие в любое место блока ведёт на главную', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/pay/pr');
    await expect(homeLink(page)).toHaveAccessibleName('Threadline, на главную');
    await expect(homeLink(page)).toHaveAttribute('href', '/');
    await expect(homeLink(page).getByRole('img')).toHaveCount(0);
    await expect(lockup(page).getByRole('link')).toHaveCount(1);
    await page.keyboard.press('Tab');
    await expect(homeLink(page)).toBeFocused();
    // Пока идёт проверка сессии, в шапке тот же блок без ссылки: он заменится, поэтому нажимать можно только после появления ссылки.
    await page.goto('/admin/projects');
    await expect(homeLink(page)).toBeVisible();
    const b = (await lockup(page).boundingBox())!;
    await page.mouse.click(b.x + b.width - 2, b.y + b.height / 2);
    await expect(page).toHaveURL(/\/pay\/pr$/);
  });

  for (const { saved, system } of [
    { saved: 'dark', system: 'light' },
    { saved: 'light', system: 'dark' },
  ] as const) {
    test(`экран непредвиденной ошибки: блок Threadline, тема ${saved}`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.emulateMedia({ colorScheme: system });
      await saveTheme(page, saved);
      await page.route('**/api/projects', (route) => route.fulfill({ json: { projects: null, defaults: { project: 'pay', environment: 'demo' } } }));
      await page.goto('/pay/demo');
      await expect(page.getByRole('heading', { name: 'Что-то пошло не так' })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(saved === 'dark');
      await expect(fatal(page).getByText('Threadline', { exact: true })).toBeVisible();
      await expect(fatal(page).getByTestId('threadline-mark')).toBeVisible();
      await expect(fatal(page).locator('img')).toHaveCount(0);
      // Вне Layout своей шапки нет: блок один, и экран ровно в окно.
      await expect(page.getByRole('banner')).toHaveCount(0);
      expect(await verticalOverflow(page)).toBeLessThanOrEqual(0);
    });
  }
});

test.describe('подписи в конце страницы нет', () => {
  for (const [width, height] of [
    [1280, 720],
    [768, 1024],
  ] as const) {
    test(`${width}×${height}: нет ни на одном экране, короткая страница без прокрутки`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      for (const path of ['/pay/demo', '/pay/pr', '/pay/nope', '/zz/demo']) {
        await page.goto(path);
        await expect(page.getByTestId('page-skeleton')).toHaveCount(0);
        await expect(page.getByRole('contentinfo')).toHaveCount(0);
        await expect(page.getByText('Powered by', { exact: true })).toHaveCount(0);
        expect(await verticalOverflow(page), path).toBeLessThanOrEqual(0);
      }
    });
  }

  test('сервер недоступен: подписи нет, блок Threadline виден', async ({ page }) => {
    await page.route('**/api/projects', (route) => route.abort('connectionrefused'));
    await page.goto('/pay/demo');
    await expect(page.getByRole('heading', { name: 'Сервер Threadline недоступен' })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('contentinfo')).toHaveCount(0);
    await expect(homeLink(page)).toBeVisible();
  });

  for (const [width, height] of [
    [1280, 720],
    [768, 1024],
  ] as const) {
    test(`ошибка страницы внутри Layout, ${width}×${height}: блок один, в шапке, и экран не выше окна`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.route(/\/api\/projects\/.+\/requests\//, (route) => route.fulfill({ json: { summary: null, records: null } }));
      await page.goto(`/pay/demo/requests/synthetic-cid?from=${Date.now() - 3_600_000}&to=${Date.now()}`);
      await expect(page.getByRole('heading', { name: 'Что-то пошло не так' })).toBeVisible();
      await expect(homeLink(page)).toBeVisible();
      await expect(fatal(page).locator('img')).toHaveCount(0);
      await expect(fatal(page).getByText('Threadline', { exact: true })).toHaveCount(0);
      expect(await verticalOverflow(page)).toBeLessThanOrEqual(0);
    });
  }

  test('сторонних запросов нет', async ({ page, baseURL }) => {
    const foreign: string[] = [];
    await page.context().route('**/*', (route) => {
      const url = route.request().url();
      if (!url.startsWith(baseURL!)) {
        foreign.push(url);
        return route.abort('internetdisconnected');
      }
      return route.continue();
    });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/pay/pr');
    await expect(indicator(page)).toHaveAttribute('data-status', 'demo');
    expect(foreign).toEqual([]);
  });
});

test.describe('закреплённые панели', () => {
  // Колонка во всю доступную высоту: в конце прокрутки её верх не уходит под шапку.
  for (const [width, height] of [
    [1440, 900],
    [1440, 600],
    [1920, 1080],
  ] as const) {
    test(`страница запроса ${width}×${height}: в конце прокрутки верх панелей не уходит под шапку`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.goto('/pay/demo');
      const input = page.getByRole('textbox', { name: 'Значения для поиска' });
      await input.fill('cards/sync');
      await input.press('Enter');
      await page.getByRole('group', { name: 'Период' }).getByRole('button', { name: '24 ч', exact: true }).click();
      await page.getByRole('button', { name: 'Найти', exact: true }).click();
      await expect(page.getByTestId('search-results')).toHaveAttribute('data-status', 'done', { timeout: 20_000 });
      await page.getByRole('list', { name: 'Найденные запросы' }).getByRole('listitem').first().locator('[data-row-link]').click({ position: { x: 8, y: 8 } });
      await expect(page.getByTestId('flow-canvas')).toBeVisible({ timeout: 15_000 });
      for (const [tab, panel] of [
        ['Схема', 'trace-scheme'],
        ['Шкала времени', 'trace-timeline'],
      ] as const) {
        await page.getByRole('tab', { name: tab }).click();
        await expect(page.getByTestId(panel)).toBeVisible();
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        const [box, head] = await Promise.all([page.getByTestId(panel).boundingBox(), header(page).boundingBox()]);
        expect(box!.y, tab).toBeGreaterThanOrEqual(head!.y + head!.height);
        expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
      }
    });
  }
});
