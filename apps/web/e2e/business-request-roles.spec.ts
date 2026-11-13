// Экран запроса для роли «Бизнес»: сервер ролей, вход ложный, значения выдуманы.
// Четыре состояния экрана идут на подменённом ответе: тот же список полей, что на сервере (fixtures.ts). Настоящий ответ сервера проверяется отдельно.
import { expect, test, type Page } from '@playwright/test';
import { fixture, FIXTURE_ACTION, FIXTURE_LEAKS, FIXTURE_TITLE, type FixtureState } from '../src/features/business/fixtures.ts';
import { shareVia } from './helpers.ts';

const ROW_HIT = { position: { x: 8, y: 8 } };
const REQUEST = '/pay/demo/requests/cid-business-1?from=1793000000000&to=1793000100000';
const steps = (page: Page) => page.getByTestId('business-step');
const screen = (page: Page) => page.getByTestId('request-page');

async function signIn(page: Page, url: string, user: string) {
  await page.goto(url);
  await page.locator(`a[data-user="${user}"]`).click();
}

async function openState(page: Page, state: FixtureState) {
  await page.route('**/api/projects/pay/envs/demo/requests/cid-business-1*', (route) => route.fulfill({ json: fixture(state) }));
  await signIn(page, REQUEST, 'business');
  await expect(page.getByTestId('business-steps')).toBeVisible({ timeout: 20_000 });
}

async function search(page: Page, value: string) {
  const input = page.getByRole('textbox', { name: 'Значения для поиска' });
  await input.fill(value);
  await input.press('Enter');
  await page.getByRole('group', { name: 'Период' }).getByRole('button', { name: '24 ч', exact: true }).click();
  await page.getByRole('button', { name: 'Найти', exact: true }).click();
  await expect(page.getByTestId('search-results')).toHaveAttribute('data-status', 'done', { timeout: 20_000 });
}

const openFirstError = (page: Page) => page.locator('li[data-status="error"] [data-row-link]').first().click(ROW_HIT);

async function nothingTechnical(page: Page) {
  const html = await screen(page).innerHTML();
  for (const bad of FIXTURE_LEAKS) expect(html, bad).not.toContain(bad);
  await expect(screen(page)).not.toContainText(/таймаут|timeout/i);
  for (const id of ['flow-canvas', 'trace-timeline', 'step-details', 'detail-switch', 'reveal-button', 'open-grafana']) await expect(page.getByTestId(id)).toHaveCount(0);
  await expect(page.getByRole('tab')).toHaveCount(0);
}

test('всё прошло: статус, шаги по порядку, блока причины нет', async ({ page }) => {
  await openState(page, 'ok');
  await expect(screen(page)).toHaveAttribute('data-business-state', 'ok');
  await expect(page.getByTestId('request-header')).toContainText('Успешно');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Перевод между картами');
  await expect(steps(page)).toHaveCount(5);
  await expect(steps(page).nth(2)).toContainText('Списано');
  await expect(page.getByTestId('request-reasons')).toHaveCount(0);
  await expect(page.getByTestId('business-summary')).toContainText('Прошло 5 из 5');
  await nothingTechnical(page);
});

test('ошибка описана: что случилось, что делать, шаг отмечен; просьбы передать ссылку нет', async ({ page }) => {
  await openState(page, 'known');
  await expect(screen(page)).toHaveAttribute('data-business-state', 'known');
  await expect(page.getByTestId('request-what-title')).toHaveText(FIXTURE_TITLE);
  await expect(page.getByTestId('reason-action')).toContainText(FIXTURE_ACTION);
  await expect(page.getByTestId('reasons-undescribed')).toHaveCount(0);
  await expect(steps(page).nth(2)).toHaveAttribute('data-tone', 'error');
  await nothingTechnical(page);
  // J ведёт к шагу с ошибкой, K к соседнему: панели шага нет, клавиши ставят фокус на строку.
  await page.getByRole('heading', { level: 1 }).click();
  await page.keyboard.press('KeyJ');
  await expect(steps(page).nth(2)).toBeFocused();
  await page.keyboard.press('KeyK');
  await expect(steps(page).nth(1)).toBeFocused();
});

test('ошибка не описана: какой шаг, просьба передать ссылку, «Поделиться»', async ({ page }) => {
  await openState(page, 'unknown');
  await expect(screen(page)).toHaveAttribute('data-business-state', 'unknown');
  const what = page.getByTestId('request-reasons');
  await expect(page.getByTestId('request-what-title')).toHaveText('Шаг «Зачисление на карту получателя» не прошёл');
  await expect(what).toContainText('Внешняя система ответила ошибкой');
  await expect(page.getByTestId('reasons-undescribed')).toHaveText('Ошибка ещё не описана, передайте ссылку в поддержку');
  await expect(what.getByRole('button', { name: 'Поделиться' })).toBeVisible();
  await nothingTechnical(page);
});

test('система не ответила: кто и какой шаг, слова без «таймаута», просьба передать ссылку на месте', async ({ page }) => {
  await openState(page, 'noresp');
  await expect(screen(page)).toHaveAttribute('data-business-state', 'no-answer');
  await expect(page.getByTestId('request-what-title')).toHaveText('Система «Процессинг карт» не ответила');
  await expect(page.getByTestId('request-reasons')).toContainText('Шаг «Проверка карты получателя» ждал ответа');
  await expect(steps(page).nth(1)).toContainText('Нет ответа');
  await expect(steps(page).nth(1)).toHaveAttribute('data-tone', 'no-answer');
  await expect(page.getByTestId('reasons-undescribed')).toBeVisible();
  await nothingTechnical(page);
});

for (const [width, scheme, language] of [[768, 'light', 'ru'], [768, 'light', 'en'], [1536, 'dark', 'ru']] as const) {
  test(`одна колонка без сдвига вбок: ${width}px, ${scheme}, ${language}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript((value) => localStorage.setItem('threadline.language', value), language);
    const long = 'Проверка возможности зачисления денежных средств на карту получателя в банке-эмитенте с повторным подтверждением'.repeat(2);
    const detail = JSON.parse(JSON.stringify(fixture('unknown')).replaceAll('Зачисление на карту получателя', long).replaceAll('Процессинг карт', long).replaceAll('Перевод между картами', long)) as ReturnType<typeof fixture>;
    await page.route('**/api/projects/pay/envs/demo/requests/cid-business-1*', (route) => route.fulfill({ json: detail }));
    await signIn(page, REQUEST, 'business');
    await expect(page.getByTestId('business-steps')).toBeVisible({ timeout: 20_000 });
    for (const el of [page.locator('html'), screen(page)]) expect(await el.evaluate((node) => node.scrollWidth - node.clientWidth)).toBe(0);
    const [stepsBox, sideBox] = await Promise.all([page.getByTestId('business-steps').boundingBox(), page.getByTestId('business-summary').boundingBox()]);
    if (width < 1024) expect(sideBox!.y).toBeGreaterThan(stepsBox!.y + stepsBox!.height - 1);
    else expect(sideBox!.x).toBeGreaterThan(stepsBox!.x + stepsBox!.width - 1);
    await expect(steps(page).first()).toBeVisible();
  });
}

test('настоящий ответ сервера: новый экран, переход между результатами, меню без ID, код схемы не грузится', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const scripts: string[] = [];
  page.on('request', (r) => {
    if (r.resourceType() === 'script') scripts.push(new URL(r.url()).pathname);
  });
  await signIn(page, '/pay/demo', 'business');
  await search(page, 'pay.example');
  await openFirstError(page);
  await expect(page.getByTestId('business-steps')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('result-position')).toBeVisible();
  await expect(page.getByRole('link', { name: 'К результатам' })).toBeVisible();
  await expect(page.getByTestId('flow-canvas')).toHaveCount(0);
  expect(scripts.filter((path) => /\/flow-[^/]*\.js$/.test(path))).toEqual([]);
  await expect(screen(page)).not.toContainText(/bank\.example|HTTP \d|POST/);

  const before = page.url();
  await page.getByRole('heading', { level: 1 }).click();
  await page.keyboard.press('BracketRight');
  await expect.poll(() => page.url()).not.toBe(before);
  await expect(page.getByTestId('business-steps')).toBeVisible({ timeout: 20_000 });

  await page.getByTestId('request-header').getByRole('button', { name: 'Поделиться' }).click();
  await expect(page.getByTestId('share-menu').getByRole('menuitem')).toHaveText(['Короткая ссылкаL', 'Текст для тикетаT']);
  await page.keyboard.press('Escape');
});

test('настоящий ответ: обмен без названия подписан системой, запрос словами, путей и имени действия нет', async ({ page }) => {
  await signIn(page, '/pay/demo', 'business');
  await search(page, 'getCard');
  await page.getByRole('list', { name: 'Найденные запросы' }).getByRole('listitem').and(page.locator('[data-status=success]')).first().locator('[data-row-link]').click(ROW_HIT);
  await expect(page.getByTestId('business-steps')).toBeVisible({ timeout: 20_000 });
  await expect(steps(page).first()).toContainText('processor');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Запрос без названия');
  await expect(screen(page)).not.toContainText(/getCard|getBalance|soap|issuing|\{value\}/);
  const url = new URL(page.url());
  const cid = url.pathname.split('/').at(-1)!;
  const answer = await (await page.request.get(`/api/projects/pay/envs/demo/requests/${cid}${url.search}`)).text();
  expect(answer).not.toMatch(/getCard|getBalance|soap\/issuing|"rpc"/);
  expect(answer).toContain('processor');
  expect(answer).not.toContain('/v1/');
});

test('настоящий ответ: нет ответа и запись ERROR об этом же, один шаг и никаких слов о следующих шагах', async ({ page }) => {
  await signIn(page, '/pay/demo', 'business');
  await search(page, 'fraud.pay.example');
  await openFirstError(page);
  await expect(page.getByTestId('business-steps')).toBeVisible({ timeout: 20_000 });
  await expect(screen(page)).toHaveAttribute('data-business-state', 'no-answer');
  await expect(page.getByTestId('business-steps')).not.toContainText('Запись');
  await expect(page.getByTestId('business-note')).not.toContainText('Следующие шаги');
  await expect(page.getByTestId('reason-other')).toHaveCount(0);
});

test('ответ ещё не пришёл: не «Успешно» ни на экране, ни в тексте для тикета', async ({ page }) => {
  const d = fixture('noresp');
  const json = { ...d, records: d.records.map((r) => (r.http?.noResponse ? { ...r, http: { ...r.http, pending: true } } : r)), summary: { ...d.summary, status: 'success', reasons: [{ kind: 'pending', text: '' }] } };
  await page.route('**/api/projects/pay/envs/demo/requests/cid-business-1*', (route) => route.fulfill({ json }));
  await signIn(page, REQUEST, 'business');
  await expect(screen(page)).toHaveAttribute('data-business-state', 'pending', { timeout: 20_000 });
  await expect(page.getByTestId('request-header')).toContainText('Ждём ответа');
  await expect(page.getByTestId('request-header')).not.toContainText('Успешно');
  await page.getByTestId('request-header').getByRole('button', { name: 'Поделиться' }).click();
  await expect(page.getByTestId('share-preview')).toContainText('Ждём ответа');
  await expect(page.getByTestId('share-preview')).not.toContainText('Успешно');
});

test('остальные роли и короткая ссылка: прежняя страница', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await signIn(page, '/pay/demo', 'business');
  await search(page, 'pay.example');
  await openFirstError(page);
  await expect(page.getByTestId('business-steps')).toBeVisible({ timeout: 20_000 });
  await shareVia(page, 'link', page.getByTestId('request-header'));
  await expect(page.getByTestId('share-hint')).toContainText('Ссылка скопирована');
  const link = await page.evaluate(() => navigator.clipboard.readText());
  await page.keyboard.press('Escape');

  await page.goto(link);
  await expect(page.getByTestId('request-header')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('detail-switch')).toBeVisible();
  await expect(page.getByTestId('business-steps')).toHaveCount(0);
});

test('Поддержка: прежняя страница со схемой', async ({ page }) => {
  await signIn(page, '/pay/demo', 'support');
  await search(page, 'pay.example');
  await openFirstError(page);
  await expect(page.getByTestId('flow-canvas')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('business-steps')).toHaveCount(0);
});
