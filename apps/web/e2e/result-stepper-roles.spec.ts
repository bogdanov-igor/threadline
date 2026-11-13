// «1 из 12» у Бизнеса и на короткой ссылке: сервер ролей, вход ложный, значения выдуманы.
import { expect, test, type Page } from '@playwright/test';
import { shareVia } from './helpers.ts';

const ROW_HIT = { position: { x: 8, y: 8 } };
const SHORT = /\/s\/[A-Za-z0-9_-]{22}$/;
const rows = (page: Page) => page.getByRole('list', { name: 'Найденные запросы' }).getByRole('listitem');
const position = (page: Page) => page.getByTestId('result-position');
const cidsOf = (page: Page) => rows(page).evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.cid ?? ''));

async function signIn(page: Page, url: string, user: string) {
  await page.goto(url);
  await page.locator(`a[data-user="${user}"]`).click();
}

async function search(page: Page, value: string) {
  const input = page.getByRole('textbox', { name: 'Значения для поиска' });
  await input.fill(value);
  await input.press('Enter');
  await page.getByRole('group', { name: 'Период' }).getByRole('button', { name: '24 ч', exact: true }).click();
  await page.getByRole('button', { name: 'Найти', exact: true }).click();
  await expect(page.getByTestId('search-results')).toHaveAttribute('data-status', 'done', { timeout: 20_000 });
}

// По порядку: идущих поисков ссылок не больше трёх на сервер.
test.describe.configure({ mode: 'default' });

test('Бизнес ходит по результатам так же, клавиши работают', async ({ page }) => {
  await signIn(page, '/pay/demo', 'business');
  await search(page, 'pay.example');
  const cids = await cidsOf(page);
  await rows(page).nth(1).locator('[data-row-link]').click(ROW_HIT);
  await expect(position(page)).toHaveText(`2 из ${cids.length}`);
  await page.getByRole('heading', { level: 1 }).click();
  await page.keyboard.press('BracketRight');
  await expect(page).toHaveURL(new RegExp(`/requests/${cids[2]}\\?from=\\d+&to=\\d+$`));
  await expect(position(page)).toHaveText(`3 из ${cids.length}`);
  await page.getByRole('link', { name: 'К результатам' }).click();
  await expect(page.locator(`li[data-cid="${cids[2]}"]`)).toHaveAttribute('data-current', 'true');
});

test('на короткой ссылке: остаётся внутри адреса, возврат к текущей строке, присланный адрес без кнопок', async ({ page, context, browser }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await signIn(page, '/pay/demo', 'analyst');
  await search(page, 'pay.example');
  await shareVia(page, 'link', page.getByTestId('search-results'));
  await expect(page.getByTestId('share-hint')).toContainText('Ссылка скопирована');
  await page.keyboard.press('Escape');
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(link).toMatch(SHORT);

  const anon = await browser.newContext({ locale: 'ru-RU', timezoneId: 'Europe/Moscow' });
  const guest = await anon.newPage();
  const apiSeen: string[] = [];
  guest.on('request', (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith('/api/')) apiSeen.push(u.pathname);
  });
  await guest.goto(link);
  await expect(guest.getByTestId('search-results')).toHaveAttribute('data-status', 'done', { timeout: 20_000 });
  const cids = await cidsOf(guest);
  expect(cids.length).toBeGreaterThan(2);

  await rows(guest).nth(0).locator('[data-row-link]').click(ROW_HIT);
  await expect(guest).toHaveURL(`${link}/requests/${cids[0]}`);
  await expect(position(guest)).toHaveText(`1 из ${cids.length}`);
  await expect(guest.getByTestId('result-prev')).toBeDisabled();

  await guest.getByTestId('result-next').click();
  await expect(guest).toHaveURL(`${link}/requests/${cids[1]}`);
  await expect(position(guest)).toHaveText(`2 из ${cids.length}`);
  await expect(guest.getByTestId('request-header')).toBeVisible({ timeout: 20_000 });
  await guest.getByRole('heading', { level: 1 }).click();
  await guest.keyboard.press('BracketRight');
  await expect(guest).toHaveURL(`${link}/requests/${cids[2]}`);

  // «Назад» возвращает к предыдущему запросу той же ссылки.
  await guest.goBack();
  await expect(guest).toHaveURL(`${link}/requests/${cids[1]}`);
  await expect(position(guest)).toHaveText(`2 из ${cids.length}`);

  // Сервер только с поверхностью ссылки, поиск не запускался снова.
  expect(apiSeen.filter((p) => !p.startsWith('/api/s/') && !/^\/api\/projects\/[^/]+\/logo\//.test(p))).toEqual([]);
  expect(apiSeen.filter((p) => p.endsWith('/run'))).toHaveLength(1);

  await guest.getByTestId('share-back').click();
  await expect(guest).toHaveURL(link);
  await expect(guest.locator(`li[data-cid="${cids[1]}"]`)).toHaveAttribute('data-current', 'true');
  await expect(guest.locator(`li[data-cid="${cids[1]}"] [data-row-link]`)).toBeFocused();

  // Сосед не открылся: возврат и кнопки на своих местах — там же, где в шапке открытого запроса. Этот сосед ещё не читался, из памяти его не взять.
  await rows(guest).nth(2).locator('[data-row-link]').click(ROW_HIT);
  await expect(guest.getByTestId('request-header')).toBeVisible({ timeout: 20_000 });
  const box = await guest.getByTestId('result-next').boundingBox();
  await guest.route(new RegExp(`/api/s/[^/]+/requests/${cids[3]}`), (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"internal"}' }));
  await guest.getByTestId('result-next').click();
  await expect(guest.locator('[role=alert]').first()).toBeVisible();
  await expect(position(guest)).toHaveText(`4 из ${cids.length}`);
  expect(await guest.getByTestId('result-next').boundingBox()).toEqual(box);
  await expect(guest.getByTestId('share-back')).toBeVisible();
  await expect(guest.getByTestId('result-prev')).toBeEnabled();

  // Присланный адрес вложенного запроса: списка в этой вкладке не открывали.
  const colleague = await anon.newPage();
  await colleague.goto(`${link}/requests/${cids[1]}`);
  await expect(colleague.getByTestId('request-header')).toBeVisible({ timeout: 20_000 });
  await expect(colleague.getByTestId('result-stepper')).toHaveCount(0);
  await colleague.close();
  await anon.close();
});
