import { expect, test, type Page } from '@playwright/test';
import { closeMenu, modeSwitchInMenu, openProjectMenu, setViewMode } from './helpers.ts';

const logo = (page: Page) => page.getByRole('banner').locator('nav img:visible');

test('один проект: меню те же пункты без других проектов; единственная среда в карточке поиска', async ({
  page,
}) => {
  await page.goto('/');
  const header = page.getByRole('banner');
  await expect(header.getByText('Demo Pay', { exact: true })).toBeVisible();
  await expect(header.getByRole('combobox', { name: /^Проект/ })).toHaveCount(0);
  await expect(logo(page)).toHaveCount(1);
  await openProjectMenu(page);
  await expect(page.getByTestId('header-catalog')).toBeVisible();
  await expect(page.getByTestId('header-settings')).toBeVisible();
  await expect(page.getByTestId('header-projects')).toBeVisible();
  await expect(page.getByTestId('project-option')).toHaveCount(0);
  await closeMenu(page);
  // Единственная среда: текст вместо списка, значок состояния работает.
  const control = page.getByRole('main').getByTestId('env-control');
  await expect(control.getByText('Demo', { exact: true })).toBeVisible();
  await expect(control.getByRole('combobox')).toHaveCount(0);
  await expect(control.getByTestId('connection-indicator')).toHaveAttribute('data-status', 'demo');
});

for (const { width, side } of [
  { width: 768, side: 20 },
  { width: 1024, side: 20 },
]) {
  for (const colorScheme of ['light', 'dark'] as const) {
    test(`один проект, ${width}px, ${colorScheme}: логотип проекта целиком, всё в одну строку`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme });
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/pay/demo');
      const header = page.getByRole('banner');
      await expect(header.getByText('Demo Pay', { exact: true })).toBeVisible();
      await expect(logo(page)).toHaveAttribute('src', new RegExp(`/logo/${colorScheme}\\?v=`));
      expect(await logo(page).boundingBox()).toMatchObject({ width: side, height: side });
      expect((await header.boundingBox())!.height).toBeLessThanOrEqual(56);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      ).toBeLessThanOrEqual(0);
    });
  }
}

test('один проект: файл логотипа не загрузился, название не сдвигается, значка битой картинки нет', async ({
  page,
}) => {
  await page.goto('/pay/demo');
  const name = page.getByRole('banner').getByText('Demo Pay', { exact: true });
  const before = await name.boundingBox();
  const broken = await page.context().newPage();
  await broken.route('**/logo/**', (route) => route.abort());
  await broken.goto('/pay/demo');
  const brokenName = broken.getByRole('banner').getByText('Demo Pay', { exact: true });
  await expect(brokenName).toBeVisible();
  await expect(broken.getByRole('banner').locator('nav img')).toHaveCount(0);
  expect(await brokenName.boundingBox()).toEqual(before);
  await broken.close();
});

test('справочник выключен: полосы нет, страница объясняет, кнопок правки и операции в запросе нет', async ({
  page,
}) => {
  await page.goto('/pay/demo');
  await expect(page.getByTestId('catalog-banner')).toHaveCount(0);
  const input = page.getByRole('textbox', { name: 'Значения для поиска' });
  await input.fill('getCard');
  await input.press('Enter');
  await page
    .getByRole('group', { name: 'Период' })
    .getByRole('button', { name: '24 ч', exact: true })
    .click();
  await page.getByRole('button', { name: 'Найти', exact: true }).click();
  await expect(page.getByTestId('search-results')).toHaveAttribute('data-status', 'done', {
    timeout: 20_000,
  });
  // Читаемые пути вместо названий.
  const rows = page.getByRole('list', { name: 'Найденные запросы' }).getByRole('listitem');
  await expect(rows.first().getByTestId('request-path')).toBeVisible();
  await expect(page.getByTestId('request-name')).toHaveCount(0);
  await rows
    .first()
    .locator('[data-row-link]')
    .click({ position: { x: 8, y: 8 } });
  await expect(page.getByTestId('request-header')).toBeVisible();
  await expect(page.getByTestId('step-details')).toBeVisible();
  for (const id of ['step-catalog-add', 'step-catalog-edit', 'step-catalog-rule', 'open-operation'])
    await expect(page.getByTestId(id)).toHaveCount(0);
  await page.goto('/pay/catalog');
  await expect(page.getByRole('heading', { name: 'Справочник выключен' })).toBeVisible();
  await expect(page.getByTestId('catalog-add-system')).toHaveCount(0);
  await expect(page.getByTestId('catalog-file-open')).toHaveCount(0);
});

test('«Кратко» без справочника: панель шага работает, блока «Итог» нет, имена по запасным правилам', async ({ page }) => {
  await page.goto('/pay/demo');
  const input = page.getByRole('textbox', { name: 'Значения для поиска' });
  await input.fill('getCard');
  await input.press('Enter');
  await page.getByRole('group', { name: 'Период' }).getByRole('button', { name: '24 ч', exact: true }).click();
  await page.getByRole('button', { name: 'Найти', exact: true }).click();
  await expect(page.getByTestId('search-results')).toHaveAttribute('data-status', 'done', { timeout: 20_000 });
  await setViewMode(page, 'Кратко');
  const rows = page.getByRole('list', { name: 'Найденные запросы' }).getByRole('listitem');
  await expect(rows.first().getByTestId('request-cid')).toHaveCount(0);
  await rows.first().locator('[data-row-link]').click({ position: { x: 8, y: 8 } });
  const details = page.getByTestId('step-details');
  await expect(details).toBeVisible();
  await expect(details.getByTestId('step-catalog')).toHaveCount(0);
  await expect(details.getByTestId('step-title')).not.toBeEmpty();
  await expect(page.getByTestId('request-chain')).toContainText('processor');
  await expect(page.getByTestId('request-chain')).not.toContainText('pay.example');
});

test('вкладка «Вид» без базы: встроенные значения, причина называет переменную, сохранения нет, переключатель работает и запоминается', async ({ page }) => {
  await page.goto('/pay/settings/view');
  await expect(page.getByTestId('view-section')).toBeVisible();
  await expect(page.getByTestId('projects-source')).toContainText('THREADLINE_DATABASE_URL');
  await expect(page.getByTestId('view-save')).toHaveCount(0);
  await expect(page.getByTestId('view-reset')).toHaveCount(0);
  await expect(page.getByTestId('view-column-component-full')).toBeDisabled();
  await expect(page.getByTestId('view-column-component-full')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('view-column-component-brief')).toHaveAttribute('aria-checked', 'false');

  await page.goto('/pay/demo');
  const input = page.getByRole('textbox', { name: 'Значения для поиска' });
  await input.fill('getCard');
  await input.press('Enter');
  await page.getByRole('group', { name: 'Период' }).getByRole('button', { name: '24 ч', exact: true }).click();
  await page.getByRole('button', { name: 'Найти', exact: true }).click();
  await expect(page.getByTestId('search-results')).toHaveAttribute('data-status', 'done', { timeout: 20_000 });
  // Режим показа — в меню профиля: на странице поиска переключателя нет.
  await expect(page.getByTestId('search-results').getByTestId('detail-switch')).toHaveCount(0);
  const brief = (await modeSwitchInMenu(page)).getByRole('menuitemradio', { name: 'Кратко', exact: true });
  await brief.click();
  await expect(brief).toHaveAttribute('aria-checked', 'true');
  await closeMenu(page);
  // Выбор один на все проекты: в записи только режим.
  expect(await page.evaluate(() => localStorage.getItem('threadline.view'))).toBe('brief');
});
