import AxeBuilder from '@axe-core/playwright';
import { fileURLToPath } from 'node:url';
import type { ProjectInfo } from '@threadline/core';
import { expect, test, type Page } from '@playwright/test';
import { openProjectMenu, pickProject, pickTheme, userButton } from './helpers.ts';

// Логотип проекта в шапке. pay — копии заглушки Demo Pay, cards — широкий синтетический файл только со светлой версией.

const NARROW = fileURLToPath(new URL('logos/narrow.svg', import.meta.url));

const header = (page: Page) => page.getByRole('banner');
const logo = (page: Page) => header(page).locator('nav img:visible');
const select = (page: Page) => header(page).getByRole('button', { name: /^Проект:/ });
const nameText = (page: Page) => select(page).locator('span.truncate');

/** Подмена ответа: проекта без логотипа и узкого файла в настройке нет. */
async function withProjects(page: Page, change: (projects: ProjectInfo[]) => void) {
  await page.route('**/api/projects', async (route) => {
    const res = await route.fetch();
    const json = (await res.json()) as { projects: ProjectInfo[] };
    change(json.projects);
    await route.fulfill({ response: res, json });
  });
}

test.describe('логотип проекта', () => {
  for (const { width, side } of [
    { width: 768, side: 20 },
    { width: 1023, side: 20 },
    { width: 1024, side: 20 },
    { width: 2560, side: 20 },
  ]) {
    for (const scheme of ['light', 'dark'] as const) {
      test(`${width}px, ${scheme}: логотип Demo Pay ${side}×${side}, версия своей темы, название целиком`, async ({
        page,
      }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await page.setViewportSize({ width, height: 800 });
        await page.goto('/pay/demo');
        await expect(logo(page)).toHaveAttribute('src', new RegExp(`/api/projects/pay/logo/${scheme}\\?v=`));
        expect(await logo(page).boundingBox()).toMatchObject({ width: side, height: side });
        await expect.poll(() => nameText(page).evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
        await expect(nameText(page)).toHaveText('Demo Pay');
      });
    }
  }

  test('одна версия: в обеих темах один файл, смена темы ничего не двигает', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/cards/demo');
    const srcLight = await logo(page).getAttribute('src');
    const before = await logo(page).boundingBox();
    await page.emulateMedia({ colorScheme: 'dark' });
    await pickTheme(page, 'Тёмная');
    await expect(page.locator('html')).toHaveClass(/dark/);
    await expect(logo(page)).toHaveAttribute('src', srcLight!);
    expect(await logo(page).boundingBox()).toEqual(before);
  });

  test('широкий логотип: по пропорции в пределах места, без искажения, название обрезается и видно в подсказке', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 768, height: 800 });
    await page.goto('/cards/demo');
    expect(await logo(page).boundingBox()).toMatchObject({ width: 80, height: 20 });
    expect(await logo(page).evaluate((el) => getComputedStyle(el).objectFit)).toBe('contain');
    await expect.poll(() => nameText(page).evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    await expect(select(page)).toBeEnabled();
    await select(page).hover();
    await expect(page.getByRole('tooltip')).toContainText('Card processing');
    expect((await header(page).boundingBox())!.height).toBe(56);
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect.poll(async () => (await logo(page).boundingBox())!.width).toBe(100);
  });

  test('очень широкий файл упирается в предел 120px', async ({ page }) => {
    await withProjects(page, (p) => {
      p.find((x) => x.id === 'cards')!.logo!.ratio = 10;
    });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/cards/demo');
    expect(await logo(page).boundingBox()).toMatchObject({ width: 120, height: 20 });
  });

  test('узкий файл вписывается в квадрат и виден', async ({ page }) => {
    await page.route('**/synthetic/narrow.svg', (route) =>
      route.fulfill({ path: NARROW, contentType: 'image/svg+xml' }),
    );
    await withProjects(page, (p) => {
      p.find((x) => x.id === 'pay')!.logo = {
        light: '/synthetic/narrow.svg',
        dark: '/synthetic/narrow.svg',
        ratio: 0.25,
      };
    });
    await page.setViewportSize({ width: 768, height: 800 });
    await page.goto('/pay/demo');
    expect(await logo(page).boundingBox()).toMatchObject({ width: 20, height: 20 });
    await page.setViewportSize({ width: 1024, height: 800 });
    await expect.poll(async () => await logo(page).boundingBox()).toMatchObject({ width: 20, height: 20 });
  });

  test('логотипа нет: только название, без пустого места и картинок', async ({ page }) => {
    await withProjects(page, (p) => {
      delete p.find((x) => x.id === 'pay')!.logo;
    });
    await page.goto('/pay/demo');
    await expect(nameText(page)).toHaveText('Demo Pay');
    await expect(header(page).locator('nav img')).toHaveCount(0);
    const [trigger, text] = await Promise.all([select(page).boundingBox(), nameText(page).boundingBox()]);
    expect(text!.x - trigger!.x).toBeLessThanOrEqual(9);
  });

  test('место занято до загрузки файла, после неё ничего не сдвигается', async ({ page }) => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route('**/logo/**', async (route) => {
      await gate;
      await route.continue();
    });
    await page.goto('/pay/demo', { waitUntil: 'domcontentloaded' });
    await expect(nameText(page)).toHaveText('Demo Pay');
    const before = [await logo(page).boundingBox(), await nameText(page).boundingBox()];
    expect(before[0]).toMatchObject({ width: 20, height: 20 });
    release();
    await expect
      .poll(() => logo(page).evaluate((el) => (el as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);
    expect([await logo(page).boundingBox(), await nameText(page).boundingBox()]).toEqual(before);
  });

  test('файл не загрузился: значка битой картинки нет, место того же размера, название на месте', async ({
    page,
  }) => {
    await page.goto('/pay/demo');
    const before = await nameText(page).boundingBox();
    const broken = await page.context().newPage();
    await broken.route('**/logo/**', (route) => route.abort());
    await broken.goto('/pay/demo');
    await expect(header(broken).locator('nav img')).toHaveCount(0);
    await expect(nameText(broken)).toBeVisible();
    expect(await nameText(broken).boundingBox()).toEqual(before);
    await broken.close();
  });

  test('открытое меню: логотипы только при открытии, строки одной высоты, логотип 20px и при окне шире 1024px', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const asked: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/logo/')) asked.push(r.url());
    });
    await page.goto('/pay/demo');
    await expect(logo(page)).toBeVisible();
    expect(asked.filter((u) => u.includes('/cards/'))).toEqual([]);
    await openProjectMenu(page);
    const options = page.getByTestId('project-option');
    await expect(options).toHaveCount(1);
    // offsetHeight, а не рамка: меню открывается с анимацией масштаба.
    expect(await options.evaluate((el) => (el as HTMLElement).offsetHeight)).toBe(await page.getByTestId('header-catalog').evaluate((el) => (el as HTMLElement).offsetHeight));
    for (const img of await options.locator('img:visible').all())
      expect(await img.evaluate((el) => (el as HTMLElement).offsetHeight)).toBe(20);
    await expect.poll(() => asked.filter((u) => u.includes('/cards/')).length).toBeGreaterThan(0);
  });

  test('проект без логотипа в открытом меню: строка той же высоты', async ({ page }) => {
    await withProjects(page, (p) => {
      delete p.find((x) => x.id === 'cards')!.logo;
    });
    await page.goto('/pay/demo');
    await openProjectMenu(page);
    expect(await page.getByTestId('project-option').evaluate((el) => (el as HTMLElement).offsetHeight)).toBe(await page.getByTestId('header-catalog').evaluate((el) => (el as HTMLElement).offsetHeight));
  });

  test('смена проекта: «Справка» и профиль на месте, логотип нового проекта', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/pay/demo');
    // Кнопка профиля приходит ленивым чанком: меряем, когда она на месте.
    await expect(userButton(page)).toBeVisible();
    const actions = page.getByTestId('header-actions');
    const before = await actions.boundingBox();
    await pickProject(page, /Card processing/);
    await expect(page).toHaveURL(/\/cards\/demo$/);
    await expect(logo(page)).toHaveAttribute('src', /\/api\/projects\/cards\/logo\//);
    expect(await actions.boundingBox()).toEqual(before);
  });

  test('имя для диктора — название проекта, логотип не озвучивается', async ({ page }) => {
    await page.goto('/pay/demo');
    await expect(select(page)).toHaveAccessibleName(/^Проект: Demo Pay/);
    expect(
      await header(page)
        .locator('nav img')
        .evaluateAll((els) => els.map((el) => el.getAttribute('alt'))),
    ).toEqual(['', '']);
  });

  test('логотип виден на странице справочника', async ({ page }) => {
    await page.goto('/pay/catalog');
    await expect(logo(page)).toBeVisible();
  });

  test('запросы только к серверу Threadline', async ({ page, baseURL }) => {
    const foreign: string[] = [];
    await page.context().route('**/*', (route) => {
      const url = route.request().url();
      if (url.startsWith(baseURL!)) return route.continue();
      foreign.push(url);
      return route.abort('internetdisconnected');
    });
    await page.goto('/cards/demo');
    await expect
      .poll(() => logo(page).evaluate((el) => (el as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);
    expect(foreign).toEqual([]);
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`доступность, ${scheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      for (const path of ['/pay/demo', '/cards/demo']) {
        await page.goto(path);
        await expect(logo(page)).toBeVisible();
        const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
        expect(
          r.violations.map((v) => `${path}: ${v.id} ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
        ).toEqual([]);
      }
    });
  }
});
