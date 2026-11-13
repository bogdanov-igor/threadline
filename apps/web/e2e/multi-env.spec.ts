// Поиск по нескольким средам: флажки в списке сред, адрес, одна строка на среду, частичный сбой, запрос в своей среде,
// «Все записи» по среде, короткая ссылка, 768px. Хранилища — имитации: «Demo» и «A very long environment name…» на одной имитации, «No network» падает сразу.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { MOCK_PERSONAL } from '../../server/src/backends/mock/dataset-pay.ts';
import { shareVia } from './helpers.ts';

const CID = MOCK_PERSONAL.cid;
const LONG = 'A very long environment name to check truncation with an ellipsis';

const control = (page: Page) => page.getByTestId('env-control');
const trigger = (page: Page) => control(page).getByRole('combobox');
const also = (page: Page, name: string) => page.getByRole('checkbox', { name: `Искать и в среде ${name}`, exact: true });
const results = (page: Page) => page.getByTestId('search-results');
const rows = (page: Page) => page.getByRole('list', { name: 'Найденные запросы' }).getByRole('listitem');
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function search(page: Page, value = CID) {
  const input = page.getByRole('textbox', { name: 'Значения для поиска' });
  await input.fill(value);
  await input.press('Enter');
  await page.getByRole('group', { name: 'Период' }).getByRole('button', { name: '24 ч', exact: true }).click();
  await page.getByRole('button', { name: 'Найти', exact: true }).click();
  await expect(results(page)).toHaveAttribute('data-status', /^(done|failed|cancelled)$/, { timeout: 20_000 });
}

test.describe('несколько сред', () => {
  test('флажок добавляет среду при закрытии списка; название выбирает одну среду; поиск сам не запускается', async ({ page }) => {
    const posts: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && /\/searches$/.test(new URL(r.url()).pathname)) posts.push(new URL(r.url()).pathname);
    });
    await page.goto('/pay/demo');
    await trigger(page).click();
    // Единственная выбранная среда: её флажок отмечен и недоступен.
    await expect(also(page, 'Demo')).toHaveAttribute('aria-checked', 'true');
    await expect(also(page, 'Demo')).toHaveAttribute('aria-disabled', 'true');
    // Стенды и ненастроенная среда не сочетаются.
    await expect(also(page, 'PR stands')).toHaveAttribute('aria-disabled', 'true');
    await expect(also(page, 'Prod')).toHaveAttribute('aria-disabled', 'true');
    await also(page, LONG).click();
    await expect(also(page, LONG)).toHaveAttribute('aria-checked', 'true');
    await expect(page).toHaveURL(/\/pay\/demo$/);
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(/\/pay\/demo,long$/);
    await expect(control(page).getByTestId('env-more')).toHaveText('+1');
    await expect(trigger(page)).toHaveAccessibleName(new RegExp(`^Среды: Demo, ${LONG}, `));
    await expect(page.getByTestId('search-examples')).toBeVisible();

    // Нажатие на название — одна среда.
    await trigger(page).click();
    await page.getByRole('option', { name: LONG, exact: true }).click();
    await expect(page).toHaveURL(/\/pay\/long$/);
    expect(posts).toEqual([]);
  });

  test('предел пять сред: шестой флажок недоступен', async ({ page }) => {
    await page.goto('/pay/demo,long,network,certificate,overloaded');
    await trigger(page).click();
    await expect(also(page, 'Slow')).toHaveAttribute('aria-disabled', 'true');
    await also(page, 'Slow').hover();
    await expect(page.getByRole('tooltip')).toHaveText('Не больше 5 сред');
  });

  test('одна строка на среду, метки сред, строка сред; запрос в своей среде и возврат к общему списку', async ({ page }) => {
    // Порядок в адресе любой: среды показаны в порядке проекта.
    await page.goto('/pay/long,demo');
    await expect(trigger(page)).toHaveAccessibleName(new RegExp(`^Среды: Demo, ${LONG}, `));
    await page.goto('/pay/demo,long');
    await search(page);
    await expect(rows(page)).toHaveCount(2);
    expect(await rows(page).evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.key).sort())).toEqual([`demo/${CID}`, `long/${CID}`]);
    expect((await rows(page).getByTestId('request-env').allInnerTexts()).sort()).toEqual(['Demo', LONG].sort());
    const parts = page.getByTestId('env-parts');
    await expect(parts.locator('li[data-env="demo"]')).toHaveAttribute('aria-label', 'Demo: 1 запрос');
    await expect(parts.locator('li[data-env="long"]')).toHaveAttribute('aria-label', `${LONG}: 1 запрос`);

    // Строка среды «long» открывает запрос в этой среде.
    await page.locator(`li[data-key="long/${CID}"] [data-row-link]`).click();
    await expect(page).toHaveURL(new RegExp(`/pay/long/requests/${CID}\\?from=\\d+&to=\\d+$`));
    await expect(page.getByTestId('result-position')).toHaveText(/из 2$/);
    await page.getByRole('link', { name: 'К результатам' }).click();
    await expect(page).toHaveURL(/\/pay\/demo,long\?search=/);
    await expect(page.locator(`li[data-key="long/${CID}"]`)).toHaveAttribute('data-current', 'true');
  });

  test('сбой одной среды: найденное в другой на месте, сообщение называет среду', async ({ page }) => {
    await page.goto('/pay/demo,network');
    await search(page);
    await expect(results(page)).toHaveAttribute('data-status', 'done');
    await expect(rows(page)).toHaveCount(1);
    const notice = page.locator('[data-notice="error"][data-env="network"]');
    await expect(notice).toContainText('No network:');
    await expect(notice.getByRole('button', { name: 'Повторить' })).toBeVisible();
    await expect(page.getByTestId('env-parts').locator('li[data-env="network"]')).toContainText('не выполнен');
    await expect(page.getByTestId('results-summary')).not.toHaveText('Поиск не выполнен');
  });

  test('не удалось ни в одной: «Поиск не выполнен» и сообщения сред', async ({ page }) => {
    await page.goto('/pay/network,certificate');
    await search(page);
    await expect(results(page)).toHaveAttribute('data-status', 'failed');
    await expect(page.getByTestId('results-summary')).toHaveText('Поиск не выполнен');
    await expect(page.locator('[data-notice="error"][data-env="network"]')).toBeVisible();
    await expect(page.locator('[data-notice="error"][data-env="certificate"]')).toBeVisible();
  });

  test('«Все записи»: строки одной среды, переключатель над ними', async ({ page }) => {
    const reads: string[] = [];
    page.on('request', (r) => {
      const u = new URL(r.url());
      if (u.pathname.endsWith('/lines')) reads.push(u.searchParams.get('env') ?? '');
    });
    await page.goto('/pay/demo,long');
    await search(page);
    await page.getByRole('tab', { name: 'Все записи' }).click();
    const sw = page.getByTestId('lines-env');
    await expect(sw.getByTestId('lines-env-demo')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('lines')).toBeVisible();
    await sw.getByTestId('lines-env-long').click();
    await expect(sw.getByTestId('lines-env-long')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('lines')).toBeVisible();
    // Каждая среда читается при её выборе, по разу.
    expect(reads.sort()).toEqual(['demo', 'long']);
  });

  test('короткая ссылка хранит обе среды; запрос внутри ссылки в своей среде', async ({ page, context, browser }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/pay/demo,long');
    await search(page);
    await shareVia(page, 'link', results(page));
    await expect(page.getByTestId('share-hint')).toContainText('Ссылка скопирована');
    await page.keyboard.press('Escape');
    const link = await page.evaluate(() => navigator.clipboard.readText());
    const anon = await browser.newContext({ locale: 'ru-RU', timezoneId: 'Europe/Moscow' });
    const other = await anon.newPage();
    await other.goto(link);
    await expect(other.getByTestId('share-env')).toHaveText(`Demo + ${LONG}`);
    await expect(other.getByTestId('search-results')).toHaveAttribute('data-status', 'done', { timeout: 20_000 });
    await expect(rows(other)).toHaveCount(2);
    await other.locator(`li[data-key="long/${CID}"] [data-row-link]`).click();
    await expect(other).toHaveURL(new RegExp(`/s/[A-Za-z0-9_-]{22}/requests/${CID}\\?env=long$`));
    await expect(other.getByTestId('share-header-project')).toContainText(LONG);
    await anon.close();
  });

  test('768px: выбор среды той же ширины, строка сред в одну строку, горизонтальной прокрутки нет', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 900 });
    await page.goto('/pay/demo');
    const width = (await control(page).boundingBox())!.width;
    await page.goto('/pay/demo,long,network,certificate,overloaded');
    expect((await control(page).boundingBox())!.width).toBe(width);
    await expect(control(page).getByTestId('env-more')).toHaveText('+4');
    await search(page);
    const parts = page.getByTestId('env-parts');
    await expect(parts.locator('li')).toHaveCount(5);
    expect((await parts.boundingBox())!.height).toBeLessThanOrEqual(24);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });

  test('доступность: результаты по двум средам со сбоем одной и открытый список сред', async ({ page }) => {
    await page.goto('/pay/demo,network');
    await search(page);
    const check = async (where: string) => {
      // Меню появляется с затуханием: контраст считается после него. Бесконечные анимации (значок проверки) не ждём.
      await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity));
      const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
      expect(r.violations.map((v) => `${where}: ${v.id} ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
    };
    await check('results');
    await trigger(page).click();
    await expect(page.getByRole('listbox')).toBeVisible();
    await check('menu');
  });
});
