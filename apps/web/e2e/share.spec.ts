// Короткая ссылка на сервере ролей: вошедший нажимает «Поделиться», новый контекст браузера без входа открывает ссылку.
// Значения синтетические, живая Grafana не участвует: хранилище — имитация, сервис входа ложный.
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { MOCK_FLOW, MOCK_PERSONAL } from '../../server/src/backends/mock/dataset-pay.ts';
import { closeViewer, openUserMenu, serviceLink, shareVia, userMenu, viewer, viewerCode } from './helpers.ts';

const ROW_HIT = { position: { x: 8, y: 8 } };
const SHORT = /\/s\/[A-Za-z0-9_-]{22}$/;
const FORMS = [MOCK_PERSONAL.phone, MOCK_PERSONAL.nationalId, MOCK_PERSONAL.pan, MOCK_PERSONAL.password];
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** На странице ссылки браузер обращается только к этому. */
const ALLOWED = [/^\/api\/s\//, /^\/api\/projects\/[^/]+\/logo\//, /^\/(?!api\/)/];

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

const firstRow = (page: Page) => page.getByRole('list', { name: 'Найденные запросы' }).getByRole('listitem').first().locator('[data-row-link]');

async function makeLink(page: Page, context: BrowserContext, value: string = MOCK_PERSONAL.phone, user = 'analyst'): Promise<string> {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await signIn(page, '/pay/demo', user);
  await search(page, value);
  await shareVia(page, 'link', page.getByTestId('search-results'));
  await expect(page.getByTestId('share-hint')).toContainText('Ссылка скопирована');
  await expect(page.getByTestId('share-hint')).toContainText('Действует до');
  await expect(page.getByTestId('share-hint')).toContainText('без входа');
  await page.keyboard.press('Escape');
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(link).toMatch(SHORT);
  return link;
}

/** Новый контекст без сессии, все запросы записываются. */
async function anonymous(browser: import('@playwright/test').Browser) {
  const context = await browser.newContext({ locale: 'ru-RU', timezoneId: 'Europe/Moscow' });
  const seen: string[] = [];
  context.on('request', (r) => {
    const u = new URL(r.url());
    if (u.origin === 'http://127.0.0.1:8094') seen.push(u.pathname);
  });
  return { context, seen, page: await context.newPage() };
}

const outside = (seen: readonly string[]) => seen.filter((p) => !ALLOWED.some((a) => a.test(p)));

test.describe('короткая ссылка без входа', () => {
  // По порядку: идущих поисков ссылок не больше трёх на сервер, параллельные тесты получали бы «Сервис занят».
  test.describe.configure({ mode: 'default' });

  test('результаты и запрос в обоих режимах, под маской, браузер ходит только на разрешённые адреса', async ({ page, context, browser }) => {
    const link = await makeLink(page, context);
    const anon = await anonymous(browser);
    await anon.page.goto(link);

    // Вход не запрашивается, значения поиска маской, период теми же датами.
    await expect(anon.page).toHaveURL(link);
    await expect(anon.page.getByTestId('share-header')).toContainText('Demo Pay');
    await expect(anon.page.getByTestId('share-header')).toContainText('Открыто по ссылке');
    await expect(anon.page.getByTestId('share-term').first()).toContainText(`+********${MOCK_PERSONAL.phone.slice(-4)}`);
    await expect(anon.page.getByTestId('search-results')).toHaveAttribute('data-status', 'done', { timeout: 20_000 });
    await expect(anon.page.getByTestId('user-menu')).toHaveCount(0);
    await expect(anon.page.getByRole('textbox', { name: 'Значения для поиска' })).toHaveCount(0);

    // Запрос из того же поиска на вложенном адресе: к хранилищу ссылки нового запроса нет, данные под маской в обоих режимах.
    const runs = () => anon.seen.filter((p) => p.endsWith('/run')).length;
    const ran = runs();
    await firstRow(anon.page).click(ROW_HIT);
    await expect(anon.page.getByTestId('request-header')).toBeVisible();
    await expect(anon.page).toHaveURL(new RegExp(`^${escape(link)}/requests/[^/]+$`));
    expect(runs()).toBe(ran);
    const inner = anon.page.url();
    for (const mode of ['Подробно', 'Кратко', 'Подробно']) {
      await anon.page.getByTestId('detail-switch').getByRole('button', { name: mode }).click();
      const body = (await anon.page.locator('body').textContent()) ?? '';
      for (const value of FORMS) expect(body, value).not.toContain(value);
    }
    await expect(anon.page.getByRole('button', { name: 'Показать скрытое' })).toHaveCount(0);
    await expect(anon.page.getByTestId('open-operation')).toHaveCount(0);
    await expect(anon.page.getByRole('link', { name: /Grafana/ })).toHaveCount(0);
    // Меню «⋯» держит переход в хранилище логов, «Операцию» и «Показать скрытое»: на ссылке ничего из этого нет, нет и меню.
    await expect(anon.page.getByTestId('request-more')).toHaveCount(0);

    await expect(anon.page.getByTestId('copy-curl')).toHaveCount(0);

    // Перезагрузка на запросе открывает тот же запрос, «Назад» — список той же ссылки.
    await anon.page.reload();
    await expect(anon.page.getByTestId('request-header')).toBeVisible({ timeout: 20_000 });
    await expect(anon.page).toHaveURL(inner);
    await anon.page.goBack();
    await expect(anon.page.getByRole('list', { name: 'Найденные запросы' })).toBeVisible({ timeout: 20_000 });
    await expect(anon.page).toHaveURL(link);

    // Значений нет и в хранилище браузера; выбор режима не записан.
    const stored = await anon.page.evaluate(() => JSON.stringify({ ...window.localStorage, ...window.sessionStorage }));
    expect(stored).not.toContain(MOCK_PERSONAL.phone);
    expect(stored).not.toContain('threadline.last');
    expect(stored).not.toContain('threadline.view');

    expect(outside(anon.seen), 'запросы вне разрешённых адресов').toEqual([]);
    expect(anon.seen.some((p) => p.startsWith('/api/s/'))).toBe(true);
    await anon.context.close();
  });

  test('«Поделиться» на странице ссылки копирует тот же адрес и не обращается к серверу', async ({ page, context, browser }) => {
    const link = await makeLink(page, context);
    const anon = await anonymous(browser);
    await anon.context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await anon.page.goto(link);
    await expect(anon.page.getByTestId('search-results')).toHaveAttribute('data-status', 'done', { timeout: 20_000 });
    anon.seen.length = 0;
    await anon.page.getByTestId('search-results').getByRole('button', { name: 'Поделиться' }).click();
    await expect(anon.page.getByTestId('share-hint')).toContainText('Ссылка скопирована');
    await expect(anon.page.getByTestId('share-menu')).toHaveCount(0);
    expect(await anon.page.evaluate(() => navigator.clipboard.readText())).toBe(link);
    expect(anon.seen.filter((p) => p.startsWith('/api/'))).toEqual([]);
    await anon.page.keyboard.press('Escape');

    // На вложенном адресе то же: копируется текущий адрес, новой ссылки нет.
    await firstRow(anon.page).click(ROW_HIT);
    await expect(anon.page.getByTestId('request-header')).toBeVisible();
    const inner = anon.page.url();
    anon.seen.length = 0;
    await anon.page.getByTestId('request-header').getByRole('button', { name: 'Поделиться' }).click();
    await expect(anon.page.getByTestId('share-hint')).toContainText('Ссылка скопирована');
    expect(await anon.page.evaluate(() => navigator.clipboard.readText())).toBe(inner);
    expect(anon.seen.filter((p) => p.startsWith('/api/'))).toEqual([]);
    await anon.context.close();
  });

  test('вошедший аналитик видит то же: кнопки показа нет, поля open в ответе нет', async ({ page, context }) => {
    const link = await makeLink(page, context);
    const opened = page.waitForResponse((r) => /\/api\/s\/[^/]+\/requests\//.test(r.url()));
    await page.goto(link);
    await expect(page.getByTestId('share-header')).toBeVisible();
    await expect(page.getByTestId('user-menu')).toHaveCount(0);
    await expect(page.getByTestId('search-results')).toHaveAttribute('data-status', 'done', { timeout: 20_000 });
    await firstRow(page).click(ROW_HIT);
    const body = await (await opened).text();
    expect(body).not.toContain('"open"');
    expect(body).not.toContain(MOCK_PERSONAL.phone);
    await expect(page.getByTestId('request-header')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Показать скрытое' })).toHaveCount(0);
  });

  test('вошедший Бизнес видит переключатель и подробности под маской, на своих страницах режим прежний', async ({ page, context }) => {
    const link = await makeLink(page, context, MOCK_PERSONAL.phone, 'business');
    await page.goto(link);
    await expect(page.getByTestId('search-results')).toHaveAttribute('data-status', 'done', { timeout: 20_000 });
    await expect(page.getByTestId('detail-switch')).toBeVisible();
    await page.goto('/pay/demo');
    await expect(page.getByTestId('user-menu')).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Значения для поиска' })).toBeVisible();
    await expect(page.getByTestId('detail-switch')).toHaveCount(0);
    // На своих страницах режим закреплён ролью: в меню профиля строки «Режим показа» нет.
    await openUserMenu(page);
    await expect(userMenu(page).getByTestId('language-switch')).toBeVisible();
    await expect(userMenu(page).getByTestId('detail-switch')).toHaveCount(0);
  });

  test('ссылка на запрос и на операцию', async ({ page, context, browser }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await signIn(page, '/pay/demo', 'analyst');
    await search(page, MOCK_PERSONAL.cid);
    await firstRow(page).click(ROW_HIT);
    await expect(page.getByTestId('request-header')).toBeVisible();
    await shareVia(page, 'link', page.getByTestId('request-header'));
    await expect(page.getByTestId('share-hint')).toContainText('Ссылка скопирована');
    await page.keyboard.press('Escape');
    const requestLink = await page.evaluate(() => navigator.clipboard.readText());
    expect(requestLink).toMatch(SHORT);
    const anon = await anonymous(browser);
    await anon.page.goto(requestLink);
    await expect(anon.page.getByTestId('request-header')).toBeVisible({ timeout: 20_000 });
    await expect(anon.page.getByTestId('share-back')).toHaveCount(0);
    // Окно тела работает и здесь: строка данных шага открывает то же содержимое, под маской.
    await anon.page.getByTestId('step-details').getByTestId('data-row').first().click();
    await expect(viewerCode(anon.page).locator('pre')).toBeVisible();
    for (const form of FORMS) await expect(viewer(anon.page)).not.toContainText(form);
    await closeViewer(anon.page);
    expect(outside(anon.seen)).toEqual([]);

    await page.goto(`/pay/demo/operations/transfer/${MOCK_FLOW.transfer}?at=${Date.now() - 3_600_000}&w=24h`);
    const opHeader = page.getByTestId('operation-header');
    await expect(opHeader).toBeVisible({ timeout: 20_000 });
    await shareVia(page, 'link', opHeader);
    await expect(page.getByTestId('share-hint')).toContainText('Ссылка скопирована');
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).not.toBe(requestLink);
    const operationLink = await page.evaluate(() => navigator.clipboard.readText());
    anon.seen.length = 0;
    await anon.page.goto(operationLink);
    const shared = anon.page.getByTestId('operation-page');
    await expect(shared).toHaveAttribute('data-status', 'done', { timeout: 30_000 });
    await expect(anon.page.getByTestId('operation-header').getByRole('button', { name: 'Обновить' })).toHaveCount(0);
    await expect(anon.page.getByRole('group', { name: 'Окно поиска' })).toHaveCount(0);

    // Поток из операции на адресе операции, адрес можно переслать. «К операции» возвращает к списку потоков.
    const operationAddress = `${operationLink}/operations/transfer/${MOCK_FLOW.transfer}`;
    await anon.page.locator('[data-flow]').first().click();
    await expect(anon.page.getByTestId('request-header')).toBeVisible({ timeout: 20_000 });
    await expect(anon.page.getByTestId('operation-nav')).toBeVisible();
    await expect(anon.page).toHaveURL(new RegExp(`^${escape(operationAddress)}\\?flow=`));
    const flowAddress = anon.page.url();
    await anon.page.getByTestId('operation-nav').getByRole('link', { name: 'К операции', exact: true }).click();
    await expect(shared).toBeVisible();
    await expect(anon.page).toHaveURL(operationAddress);
    expect(outside(anon.seen)).toEqual([]);

    // Коллега открывает присланный адрес потока: тот же поток, путь к операции есть.
    const colleague = await anonymous(browser);
    await colleague.page.goto(flowAddress);
    await expect(colleague.page.getByTestId('request-header')).toBeVisible({ timeout: 30_000 });
    await expect(colleague.page.getByTestId('operation-nav')).toBeVisible();
    await expect(colleague.page).toHaveURL(flowAddress);
    expect(outside(colleague.seen)).toEqual([]);
    await colleague.page.goto(operationAddress);
    await expect(colleague.page.getByTestId('operation-page')).toHaveAttribute('data-status', 'done', { timeout: 30_000 });

    // Чужое значение операции: «не найдено» сразу, поиск не запускается, значение от браузера на сервер не идёт.
    colleague.seen.length = 0;
    await colleague.page.goto(`${operationLink}/operations/transfer/foreign-value`);
    await expect(colleague.page.getByRole('heading', { name: 'Ссылка больше не действует' })).toBeVisible();
    expect(colleague.seen.filter((p) => p.endsWith('/run') || p.includes('foreign-value') && p.startsWith('/api/'))).toEqual([]);
    await colleague.context.close();
    await anon.context.close();
  });

  test('задание удалено при открытой странице: один автоматический запуск заново, при втором отказе кнопка', async ({ page, context, browser }) => {
    const link = await makeLink(page, context);
    const anon = await anonymous(browser);
    let runs = 0;
    anon.page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().endsWith('/run')) runs++;
    });
    let gone = 1;
    await anon.page.route(/\/api\/s\/[^/]+\/state/, (route) => {
      if (gone-- > 0) return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: { code: 'search-expired' } }) });
      return route.continue();
    });
    await anon.page.goto(link);
    await expect(anon.page.getByTestId('search-results')).toHaveAttribute('data-status', 'done', { timeout: 20_000 });
    expect(runs).toBe(2);

    // Второй раз за открытие сам не запускается: страница предлагает повторить.
    await anon.page.unroute(/\/api\/s\/[^/]+\/state/);
    await anon.page.route(/\/api\/s\/[^/]+\/state/, (route) => route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: { code: 'search-expired' } }) }));
    await anon.page.reload();
    await expect(anon.page.locator('[data-notice=expired]')).toBeVisible({ timeout: 20_000 });
    await anon.context.close();
  });

  test('неверная и несуществующая ссылка: одно сообщение, входа нет', async ({ browser }) => {
    const anon = await anonymous(browser);
    for (const id of ['abc', 'A'.repeat(22)]) {
      await anon.page.goto(`/s/${id}`);
      await expect(anon.page.getByRole('heading', { name: 'Ссылка больше не действует' })).toBeVisible();
      await expect(anon.page.getByTestId('share-header-project')).toHaveCount(0);
    }
    expect(outside(anon.seen)).toEqual([]);
    await anon.page.getByTestId('share-sign-in').click();
    await expect(anon.page.locator('a[data-user="analyst"]')).toBeVisible();
    await anon.context.close();
  });

  test('ширина 768 и 2560: без горизонтальной прокрутки, переключатель режима виден', async ({ page, context, browser }) => {
    const link = await makeLink(page, context);
    const anon = await anonymous(browser);
    for (const width of [768, 2560]) {
      await anon.page.setViewportSize({ width, height: 800 });
      await anon.page.goto(link);
      await expect(anon.page.getByTestId('search-results')).toHaveAttribute('data-status', 'done', { timeout: 20_000 });
      await expect(anon.page.getByTestId('detail-switch')).toBeVisible();
      expect(await anon.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
    await anon.context.close();
  });
});

test.describe('исключённые значения и инструменты на странице ссылки', () => {
  test('значения маской, строк с ними нет, cURL и контакта нет, фильтры в ссылку не идут', async ({ page, context, browser }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await signIn(page, '/pay/demo', 'analyst');
    await page.getByTestId('exclude-toggle').click();
    const left = page.getByRole('textbox', { name: 'Не содержит' });
    for (const value of [MOCK_PERSONAL.pan, 'getCardResponse']) {
      await left.fill(value);
      await left.press('Enter');
    }
    await search(page, 'getCard');
    await shareVia(page, 'link', page.getByTestId('search-results'));
    await expect(page.getByTestId('share-hint')).toContainText('Ссылка скопирована');
    await page.keyboard.press('Escape');
    const link = await page.evaluate(() => navigator.clipboard.readText());

    const anon = await anonymous(browser);
    await anon.page.goto(link);
    await expect(anon.page.getByTestId('search-results')).toHaveAttribute('data-status', 'done', { timeout: 20_000 });
    const excluded = anon.page.getByTestId('share-exclude');
    await expect(excluded).toHaveText([`${MOCK_PERSONAL.pan.slice(0, 6)}******${MOCK_PERSONAL.pan.slice(-4)}`, '***']);
    const body = await anon.page.locator('body').innerText();
    expect(body).not.toContain(MOCK_PERSONAL.pan);
    expect(body).not.toContain('getCardResponse');
    expect(new URL(anon.page.url()).search).toBe('');
    // Строка о неописанной ошибке видна и здесь: контакт за входом, его запрос увёл бы страницу на вход.
    await anon.page.route('**/api/s/*/requests/*', async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as { summary: { status: string; reasons: unknown[] } };
      await route.fulfill({ json: { ...body, summary: { ...body.summary, status: 'error', reasons: [{ kind: 'http', text: '' }] } } });
    });
    await anon.page.getByRole('list', { name: 'Найденные запросы' }).getByRole('listitem').first().locator('[data-row-link]').click(ROW_HIT);
    await expect(anon.page.getByTestId('request-header')).toBeVisible();
    // Строка о неописанной ошибке — в раскрываемой части причин.
    await anon.page.getByTestId('reasons-more').click();
    await expect(anon.page.getByTestId('reasons-undescribed')).toBeVisible();
    await expect(anon.page.getByTestId('copy-curl')).toHaveCount(0);
    await expect(anon.page.getByTestId('request-page')).not.toContainText('getCardResponse');
    for (const path of anon.seen) expect(ALLOWED.some((re) => re.test(path)), path).toBe(true);
    await anon.context.close();
  });
});

test.describe('вложенные адреса ссылки', () => {
  test.describe.configure({ mode: 'default' });

  test('пересланный адрес запроса: поиск идёт заново, открыт этот запрос под маской, «К результатам» ведёт на результаты', async ({ page, context, browser }) => {
    const link = await makeLink(page, context);
    const first = await anonymous(browser);
    await first.page.goto(link);
    await expect(first.page.getByTestId('search-results')).toHaveAttribute('data-status', 'done', { timeout: 20_000 });
    await firstRow(first.page).click(ROW_HIT);
    await expect(first.page.getByTestId('request-header')).toBeVisible();
    const address = first.page.url();
    await first.context.close();

    const colleague = await anonymous(browser);
    await colleague.page.goto(address);
    await expect(colleague.page.getByTestId('request-header')).toBeVisible({ timeout: 20_000 });
    await expect(colleague.page).toHaveURL(address);
    await expect(colleague.page.getByTestId('share-until')).toContainText('всё под маской');
    const body = (await colleague.page.locator('body').textContent()) ?? '';
    for (const value of FORMS) expect(body, value).not.toContain(value);
    await expect(colleague.page.getByRole('button', { name: 'Показать скрытое' })).toHaveCount(0);
    expect(outside(colleague.seen)).toEqual([]);
    await colleague.page.getByTestId('share-back').click();
    await expect(colleague.page).toHaveURL(link);
    await expect(colleague.page.getByRole('list', { name: 'Найденные запросы' })).toBeVisible({ timeout: 20_000 });
    await colleague.context.close();
  });

  test('чужой идентификатор: то же «не найдено», что у неизвестной ссылки, ответ сервера тот же, путь к результатам есть', async ({ page, context, browser }) => {
    const link = await makeLink(page, context);
    const anon = await anonymous(browser);
    const unknown = await anon.page.request.get(`/api/s/${'A'.repeat(22)}`);
    let answer: { status: number; body: string } | null = null;
    anon.page.on('response', (r) => {
      if (/\/api\/s\/[^/]+\/requests\//.test(r.url())) void r.text().then((body) => (answer = { status: r.status(), body }));
    });
    await anon.page.goto(`${link}/requests/${encodeURIComponent('foreign-correlation-id')}`);
    await expect(anon.page.getByRole('heading', { name: 'Ссылка больше не действует' })).toBeVisible({ timeout: 20_000 });
    await expect(anon.page.getByRole('main')).toContainText('Срок истёк или такой ссылки нет');
    await expect.poll(() => answer).toEqual({ status: unknown.status(), body: await unknown.text() });
    await expect(anon.page.getByTestId('request-header')).toHaveCount(0);
    await anon.page.getByTestId('share-to-results').click();
    await expect(anon.page).toHaveURL(link);
    await expect(anon.page.getByRole('list', { name: 'Найденные запросы' })).toBeVisible({ timeout: 20_000 });

    // Адрес операции у ссылки на результаты: операции в её поиске нет.
    await anon.page.goto(`${link}/operations/transfer/${MOCK_FLOW.transfer}`);
    await expect(anon.page.getByRole('heading', { name: 'Ссылка больше не действует' })).toBeVisible();
    await anon.page.goto(`/s/${'A'.repeat(22)}/requests/foreign-correlation-id`);
    await expect(anon.page.getByRole('heading', { name: 'Ссылка больше не действует' })).toBeVisible();
    await expect(anon.page.getByTestId('share-to-results')).toHaveCount(0);
    await anon.context.close();
  });
});

test.describe('меню «Поделиться»', () => {
  async function openRequest(page: Page, context: BrowserContext) {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await signIn(page, '/pay/demo', 'analyst');
    await search(page, MOCK_PERSONAL.cid);
    await firstRow(page).click(ROW_HIT);
    await expect(page.getByTestId('request-header')).toBeVisible();
  }
  const clip = (page: Page) => page.evaluate(() => navigator.clipboard.readText());

  test('три пункта на запросе, два на результатах, рядом видно, что будет скопировано, клавиши L и T подписаны', async ({ page, context }) => {
    await openRequest(page, context);
    await page.getByTestId('request-header').getByRole('button', { name: 'Поделиться' }).click();
    const menu = page.getByTestId('share-menu');
    await expect(menu.getByRole('menuitem')).toHaveText(['Короткая ссылкаL', 'Текст для тикетаT', 'ID запроса']);
    await expect(page.getByTestId('share-preview')).toContainText('**');
    await expect(page.getByTestId('share-preview')).toContainText(`ID запроса: ${MOCK_PERSONAL.cid}`);
    await expect(page.getByTestId('share-menu-note')).toContainText('без входа');
    await page.getByTestId('share-item-id').hover();
    await expect(page.getByTestId('share-preview')).toHaveText(MOCK_PERSONAL.cid);
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await page.goBack();
    await expect(page.getByTestId('search-results')).toBeVisible();
    await page.getByTestId('search-results').getByRole('button', { name: 'Поделиться' }).click();
    await expect(page.getByTestId('share-menu').getByRole('menuitem')).toHaveText(['Короткая ссылкаL', 'Текст для тикетаT']);
  });

  test('«Текст для тикета»: название, время с поясом, среда, ID и ссылка; при открытом скрытом значения под маской', async ({ page, context }) => {
    await openRequest(page, context);
    await page.getByRole('button', { name: 'Показать скрытое' }).click();
    await expect(page.getByRole('button', { name: 'Скрыть' })).toBeVisible();
    await shareVia(page, 'ticket', page.getByTestId('request-header'));
    await expect(page.getByTestId('share-hint')).toContainText('Текст для тикета скопирован');
    await expect(page.getByTestId('share-hint')).toContainText('Действует до');
    const text = await clip(page);
    expect(text).toMatch(/^\*\*.+\*\*\n\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}:\d{2} \(UTC\+05:00\) · /);
    expect(text).toContain(`ID запроса: ${MOCK_PERSONAL.cid}`);
    expect(text).toMatch(/http:\/\/127\.0\.0\.1:8094\/s\/[A-Za-z0-9_-]{22}$/);
    for (const value of FORMS) expect(text, value).not.toContain(value);
    await page.keyboard.press('Escape');

    // Ссылка одна: короткая ссылка из меню та же, что в тексте.
    const link = /\S+$/.exec(text)![0];
    await shareVia(page, 'link', page.getByTestId('request-header'));
    await expect(page.getByTestId('share-hint')).toContainText('Ссылка скопирована');
    expect(await clip(page)).toBe(link);
  });

  test('«ID запроса»: копируется id, новой ссылки нет', async ({ page, context }) => {
    await openRequest(page, context);
    const made: string[] = [];
    page.on('request', (r) => {
      if (r.url().endsWith('/api/share')) made.push(r.url());
    });
    await shareVia(page, 'id', page.getByTestId('request-header'));
    await expect(page.getByTestId('share-hint')).toContainText('ID запроса скопирован');
    expect(await clip(page)).toBe(MOCK_PERSONAL.cid);
    expect(made).toEqual([]);
  });

  test('база недоступна: пункт ссылки закрыт с причиной, текст копируется без ссылки и сообщает об этом', async ({ page, context }) => {
    await page.route('**/api/catalog', async (route) => {
      const res = await route.fetch();
      await route.fulfill({ json: { ...(await res.json()), state: 'down' } });
    });
    await openRequest(page, context);
    await page.getByTestId('request-header').getByRole('button', { name: 'Поделиться' }).click();
    await expect(page.getByTestId('share-item-link')).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByTestId('share-unavailable')).toContainText('сейчас недоступна');
    await page.getByTestId('share-item-ticket').click();
    await expect(page.getByTestId('share-no-link')).toContainText('без короткой ссылки');
    const text = await clip(page);
    expect(text).toContain(`ID запроса: ${MOCK_PERSONAL.cid}`);
    expect(text).not.toMatch(/\/s\//);
  });

  for (const user of ['business', 'support', 'admin']) {
    test(`роль ${user}: то же меню «Поделиться», в «Справке» пять пунктов, форма открывается`, async ({ page, context }) => {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await signIn(page, '/pay/demo', user);
      await search(page, MOCK_PERSONAL.cid);
      await page.getByTestId('search-results').getByRole('button', { name: 'Поделиться' }).click();
      await expect(page.getByTestId('share-menu').getByRole('menuitem')).toHaveText(['Короткая ссылкаL', 'Текст для тикетаT']);
      await page.keyboard.press('Escape');
      await firstRow(page).click(ROW_HIT);
      await expect(page.getByTestId('request-header')).toBeVisible();
      await page.getByTestId('request-header').getByRole('button', { name: 'Поделиться' }).click();
      // У Бизнеса на экране запроса ID нет ни в каком виде: ни пункта меню, ни строки в тексте для тикета.
      await expect(page.getByTestId('share-menu').getByRole('menuitem')).toHaveText(user === 'business' ? ['Короткая ссылкаL', 'Текст для тикетаT'] : ['Короткая ссылкаL', 'Текст для тикетаT', 'ID запроса']);
      // Текст тикета теми же словами, что на экране этой роли: у Бизнеса без адресов систем.
      if (user === 'business') await expect(page.getByTestId('share-preview')).not.toContainText('pay.example');
      await page.keyboard.press('Escape');
      await page.getByTestId('header-help').click();
      // У «О Threadline» справа версия сборки, если сервер её прислал.
      await expect(page.getByTestId('help-menu-content').getByRole('menuitem')).toHaveText(['Документация', 'Обучение', /^О Threadline\s*(версия .+)?$/, 'Горячие клавиши?', 'Сообщить о проблеме']);
      await page.getByTestId('header-report').click();
      await expect(page.getByTestId('report-dialog')).toBeVisible();
      await expect(page.getByTestId('report-link-note')).toHaveAttribute('data-link', 'will');
    });
  }

  test('двойной выбор не создаёт второй ссылки', async ({ page, context }) => {
    await openRequest(page, context);
    let made = 0;
    await page.route('**/api/share', async (route) => {
      made++;
      await route.continue();
    });
    await shareVia(page, 'link', page.getByTestId('request-header'));
    await expect(page.getByTestId('share-hint')).toContainText('Ссылка скопирована');
    await page.keyboard.press('Escape');
    await shareVia(page, 'ticket', page.getByTestId('request-header'));
    await expect(page.getByTestId('share-hint')).toContainText('Текст для тикета скопирован');
    expect(made).toBe(1);
  });
});

test.describe('настройки сервиса', () => {
  test('администратор меняет срок, другая роль видит закрытый раздел и не видит ссылку', async ({ page, browser }) => {
    await signIn(page, '/admin/settings', 'admin');
    await expect(page).toHaveURL(/\/admin\/status#settings$/);
    // Прямой адрес раздела: страница прокручена к разделу «Общие», фокус на его заголовке.
    await expect(page.getByRole('heading', { name: 'Общие', exact: true })).toBeFocused();
    // «Общие» — одна форма: поля строками, внизу одна «Сохранить» и счётчик изменённых полей.
    const form = page.getByTestId('settings-form');
    const save = form.getByTestId('setting-save');
    const card = page.getByTestId('setting-share-lifetimeDays');
    const input = card.getByTestId('setting-input');
    await expect(input).toHaveValue('30');
    await expect(save).toBeDisabled();
    await input.fill('401');
    await expect(card.getByTestId('setting-invalid')).toBeVisible();
    await expect(save).toBeDisabled();
    await input.fill('7');
    await expect(card.getByTestId('setting-shorten')).toContainText('перестанут открываться');
    await expect(form.getByTestId('settings-dirty')).toHaveText('Изменено 1 поле');
    await save.click();
    await expect(form.getByTestId('setting-saved')).toBeVisible();
    await page.reload();
    await expect(input).toHaveValue('7');
    const reset = card.getByTestId('setting-reset');
    await expect(reset).toHaveText('по умолчанию 30');
    await expect(reset).toHaveAccessibleName('Вернуть стандартное: 30');
    await reset.click();
    await save.click();
    await expect(form.getByTestId('setting-saved')).toBeVisible();
    await expect(input).toHaveValue('30');

    const other = await browser.newContext({ locale: 'ru-RU' });
    const second = await other.newPage();
    const asked: string[] = [];
    second.on('request', (r) => {
      if (new URL(r.url()).pathname === '/api/settings') asked.push(r.url());
    });
    await signIn(second, '/settings', 'analyst');
    await expect(second.getByTestId('user-menu')).toBeVisible();
    await expect(second).toHaveURL(/\/admin\/status#settings$/);
    await expect(second.getByTestId('service-settings-closed')).toBeVisible();
    await expect(second.getByTestId('stores-list')).toBeVisible();
    await expect(second.getByTestId('setting-input')).toHaveCount(0);
    expect(asked).toEqual([]);
    await second.goto('/admin/projects');
    await expect(second.getByTestId('projects-list')).toBeVisible();
    // Ссылки на форму нет: «Настройки сервиса» в меню профиля ведёт к состоянию сервиса, раздел «Общие» там закрыт.
    await openUserMenu(second);
    await expect(serviceLink(second)).toHaveAttribute('href', '/admin/status');
    await other.close();
  });
});
