import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { closeViewer, goToCatalog, openBlock, openData, openMore, setViewMode, viewer, viewerCode, viewerTab } from './helpers.ts';

// Показ скрытого и раздел «Маскирование» на записях MOCK_PERSONAL из dataset-pay.ts: значения выдуманы.
// Настройка одна на проект, поэтому набор идёт последовательно на своём сервере со своей базой (playwright.config.ts),
// а каждый тест начинает с видов, включённых по умолчанию. Вход выключен, поэтому зритель здесь no-login.
// Что открыто каждой роли, проверяет apps/server/test/reveal-routes.test.ts.
// Данные шага открываются окном тела, адрес шага — в сводке панели. Окно тела модальное: «Показать скрытое» и режим показа меняются при закрытом окне.

const V = {
  cid: 'c1d2e3f4-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
  phone: '447700900101',
  phone2: '+447700900102',
  address: '7 Synthetic Street',
  passportNumber: '7305102',
  nationalId: 'ZZ000101A',
  surname: 'Testerson',
  fullName: 'Testerson Tess Quinn',
  holder: 'TESS TESTERSON',
  expiry: '3101',
  additionalInfo: 'ADD00100000101',
  pan: '5555550001470101',
  password: 'synthetic-pass-0101',
  account: '10500000900123456101',
  accountId: '36999101',
  bankAccountId: '7001112344650101',
  cardToken: '400000SYNTHA0101',
};
const PHONE_MASK = '********0101';
const PAN_MASK = '555555******0101';
const OPEN_VALUES = [V.phone, V.phone2, V.address, V.passportNumber, V.nationalId, V.surname, V.holder, V.additionalInfo, V.password, V.account, V.accountId, V.bankAccountId, V.cardToken];

const API = '/api/projects/pay/catalog';
/** Виды с выключателем, включённые по умолчанию. */
const KINDS = ['card_data', 'card_token', 'account_number', 'phone', 'national_id', 'passport', 'surname', 'address'];
const ROW_HIT = { position: { x: 8, y: 8 } };

const details = (page: Page) => page.getByTestId('step-details');
const button = (page: Page) => page.getByTestId('reveal-button');
/** Адрес шага в сводке панели: без схемы, полный — в подсказке. */
const address = (page: Page) => details(page).getByTestId('step-address');
/** Код в окне тела: та часть данных, что выбрана. */
const code = (page: Page) => viewerCode(page);

const REVEAL_URL = /\/requests\/[^/]+\/reveal(\?|$)/;
const onlyApi = (url: string) => new URL(url).pathname.startsWith('/api/');

interface MaskingRow {
  type: string;
  enabled: boolean;
  keys: string[];
  updatedAt: string;
}

const catalogState = async (request: APIRequestContext) => ((await (await request.get('/api/catalog')).json()) as { state?: string }).state;
/** Сервер отвечает раньше, чем база прошла миграции: первый тест набора ждёт итог подключения. */
async function catalogOn(request: APIRequestContext) {
  await expect.poll(() => catalogState(request), { timeout: 20_000 }).not.toBe('connecting');
  return (await catalogState(request)) === 'ok';
}

/** Правка другого пользователя: страница узнаёт о ней только из опроса. */
async function setKinds(request: APIRequestContext, enabled: boolean, types: readonly string[] = KINDS) {
  const rows = ((await (await request.get(API)).json()) as { masking: MaskingRow[] }).masking;
  for (const row of rows) {
    if (!types.includes(row.type) || row.enabled === enabled) continue;
    const res = await request.put(`${API}/masking/${row.type}`, { data: { enabled, keys: row.keys, updatedAt: row.updatedAt } });
    expect(res.ok()).toBe(true);
  }
}

async function search(page: Page, term: string) {
  await page.goto('/pay/demo');
  const input = page.getByRole('textbox', { name: 'Значения для поиска' });
  await input.fill(term);
  await input.press('Enter');
  await page.getByRole('group', { name: 'Период' }).getByRole('button', { name: '24 ч', exact: true }).click();
  await page.getByRole('button', { name: 'Найти', exact: true }).click();
  await expect(page.getByTestId('search-results')).toHaveAttribute('data-status', 'done', { timeout: 20_000 });
}

async function openRequest(page: Page, term = V.cid) {
  await search(page, term);
  await page.getByRole('list', { name: 'Найденные запросы' }).getByRole('listitem').first().locator('[data-row-link]').click(ROW_HIT);
  await expect(page.getByTestId('request-header')).toBeVisible();
}

const selectStep = async (page: Page, text: string | RegExp) => {
  await page.getByRole('tab', { name: /^Шкала времени/ }).click();
  await page.getByRole('listbox', { name: 'Шаги трассы' }).getByRole('option').filter({ hasText: text }).first().click();
};
const STEP = { entry: /^POST \/v1\/customers/, create: 'core · POST /createCustomer', form: 'core · POST /form', soap: 'core · POST /soap', log: /not found, passport/, account: /core · POST \/v1\/accounts/ };

async function reveal(page: Page) {
  await button(page).click();
  await expect(button(page)).toHaveAttribute('data-status', 'on');
}

/** Шаг создания клиента, данные «Ответ» в окне тела: JSON, вложенный строкой, имя на карте, срок и номер карты. */
async function openResponse(page: Page) {
  await selectStep(page, STEP.create);
  await openData(page, 'Ответ');
  await expect(code(page)).toHaveAttribute('data-block', 'response');
}

/** Вложенное тело ответа — вторая часть данных в окне тела. */
async function openNested(page: Page) {
  await viewer(page).getByTestId('viewer-parts').getByRole('button').nth(1).click();
  await expect(code(page)).toHaveAttribute('data-block', 'nested');
  return code(page);
}

/** Само тело ответа — первая часть. */
async function openBody(page: Page) {
  await viewer(page).getByTestId('viewer-parts').getByRole('button').first().click();
  await expect(code(page)).toHaveAttribute('data-block', 'response');
}

async function expectMasked(area: Locator) {
  await expect(area).toBeVisible();
  const text = await area.innerText();
  for (const value of OPEN_VALUES) expect(text).not.toContain(value);
  expect(text).not.toContain(V.pan);
}

const noScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test.beforeEach(async ({ request }) => {
  if (await catalogOn(request)) await setKinds(request, true);
});

test.describe('подсветка и показ вместе', () => {
  const marks = (area: Locator) => area.locator('mark.search-hit');
  const texts = (area: Locator) => marks(area).allTextContents();
  const summary = (page: Page) => page.getByTestId('hit-summary');
  /** Сырая запись входа в окне тела: в ней адрес с телефоном, подсвеченный. В сводке панели адрес без подсветки. */
  const rawOfEntry = async (page: Page) => {
    await selectStep(page, STEP.entry);
    await openData(page, 'Сырые записи');
    return code(page);
  };

  /** Ищет телефон и номер карты: у них разная судьба при показе. */
  async function openByValues(page: Page, terms: string[]) {
    await page.goto('/pay/demo');
    const input = page.getByRole('textbox', { name: 'Значения для поиска' });
    for (const term of terms) {
      await input.fill(term);
      await input.press('Enter');
    }
    await page.getByRole('group', { name: 'Период' }).getByRole('button', { name: '24 ч', exact: true }).click();
    await page.getByRole('button', { name: 'Найти', exact: true }).click();
    await expect(page.getByTestId('search-results')).toHaveAttribute('data-status', 'done', { timeout: 20_000 });
    await page.locator(`li[data-cid="${V.cid}"] [data-row-link]`).click(ROW_HIT);
    await expect(page.getByTestId('request-header')).toBeVisible();
  }

  test('маска подсвечена; показ — открытое значение, номер карты маской; скрытие — снова маска', async ({ page }) => {
    await openByValues(page, [V.phone, V.pan]);
    let raw = await rawOfEntry(page);
    await expect(marks(raw).first()).toBeVisible();
    expect((await texts(raw)).every((text) => text.endsWith(PHONE_MASK))).toBe(true);
    await closeViewer(page);
    await expect(address(page)).toContainText(PHONE_MASK);

    await reveal(page);
    await expect(address(page)).toContainText(V.phone);
    raw = await rawOfEntry(page);
    await expect(raw).toContainText(V.phone);
    expect((await texts(raw)).some((text) => text.includes(V.phone))).toBe(true);
    await closeViewer(page);
    await openResponse(page);
    await expect.poll(() => texts(code(page))).toContain(PAN_MASK);
    expect(await code(page).innerText()).not.toContain(V.pan);
    await closeViewer(page);

    await button(page).click();
    await expect(button(page)).toHaveAttribute('data-status', 'off');
    raw = await rawOfEntry(page);
    await expect(marks(raw).first()).toBeVisible();
    expect((await texts(raw)).every((text) => text.endsWith(PHONE_MASK))).toBe(true);
    await closeViewer(page);
    expect(await page.locator('html').innerHTML()).not.toContain(V.phone);
  });

  test('значение только под маской: фраза при нуле, показ меняет число без других запросов', async ({ page }) => {
    await openByValues(page, [V.surname]);
    await expect(summary(page)).toContainText('В видимом тексте значения нет');
    await expect(summary(page).getByRole('button', { name: 'К первому' })).toHaveCount(0);
    const api: string[] = [];
    page.on('request', (r) => {
      if (onlyApi(r.url())) api.push(r.url());
    });
    await reveal(page);
    await expect(summary(page)).toContainText(/Значение найдено в \d+ запис/);
    expect(api.filter((url) => !REVEAL_URL.test(url))).toEqual([]);
    expect(api).toHaveLength(1);
    await button(page).click();
    await expect(summary(page)).toContainText('В видимом тексте значения нет');
  });

  test('вид выключен: открытое значение подсвечено в подробностях, заголовки и списки без подсветки', async ({ page, request }) => {
    test.skip(!(await catalogOn(request)), 'без справочника настройка маскирования не меняется');
    await setKinds(request, false, ['phone']);
    await openByValues(page, [V.phone]);
    const raw = await rawOfEntry(page);
    await expect.poll(() => texts(raw)).toContain(V.phone);
    await closeViewer(page);
    await expect(marks(page.getByTestId('step-title'))).toHaveCount(0);
    await expect(marks(page.getByRole('listbox', { name: 'Шаги трассы' }))).toHaveCount(0);
    await expect(marks(page.getByTestId('request-header'))).toHaveCount(0);
  });

  test('ответ страницы запроса ничего не знает о совпадениях', async ({ page }) => {
    const answer = page.waitForResponse((r) => /\/api\/searches\/[^/]+\/requests\/[^/?]+$/.test(new URL(r.url()).pathname) && r.request().method() === 'GET');
    await openByValues(page, [V.phone]);
    const detail = (await (await answer).json()) as { records: Record<string, unknown>[] } & Record<string, unknown>;
    const keys = [...Object.keys(detail), ...detail.records.flatMap((r) => Object.keys(r))];
    expect(keys.filter((key) => /hit|match(ed|es)?s?$/i.test(key) && key !== 'match')).toEqual([]);
  });
});

test.describe('показ скрытого', () => {
  test('один запрос на все шаги и вкладки; заголовки, причины и граф остаются с маской', async ({ page }) => {
    const shows: string[] = [];
    const api: string[] = [];
    page.on('request', (r) => {
      if (!onlyApi(r.url())) return;
      api.push(r.url());
      if (REVEAL_URL.test(r.url())) shows.push(r.url());
    });
    await openRequest(page);
    await expect(page.getByTestId('flow-canvas')).toBeVisible({ timeout: 15_000 });
    await expectMasked(page.getByTestId('request-page'));
    expect(shows).toEqual([]);

    await reveal(page);
    expect(shows).toHaveLength(1);
    expect(shows[0]).toContain(`/searches/`);
    api.length = 0;

    await selectStep(page, STEP.entry);
    await expect(address(page)).toContainText(V.phone);
    await expect(address(page)).toContainText(encodeURIComponent(V.address));
    await openData(page, 'Запрос');
    await expect(code(page)).toContainText(V.phone2);
    await closeViewer(page);
    await expectMasked(page.getByTestId('step-title'));
    await expect(page.getByTestId('step-title')).toContainText('{contact}');

    await selectStep(page, STEP.create);
    await openData(page, 'Запрос');
    for (const value of [V.phone, V.phone2, V.address, V.passportNumber, V.nationalId, V.surname, V.fullName]) await expect(code(page)).toContainText(value);
    await viewerTab(page, 'Ответ').click();
    await expect(code(page)).toHaveAttribute('data-block', 'response');
    for (const value of [V.holder, V.expiry, V.additionalInfo, V.surname]) await expect(code(page)).toContainText(value);
    await expect(code(page)).toContainText(PAN_MASK);
    await expect(code(page)).not.toContainText(V.pan);
    await closeViewer(page);

    await selectStep(page, STEP.form);
    await openData(page, 'Заголовки');
    await expect(code(page)).toContainText(V.phone);
    await closeViewer(page);

    await selectStep(page, STEP.soap);
    await openData(page, 'Ответ');
    await expect(code(page)).toContainText(V.passportNumber);
    await expect(code(page)).toContainText(V.holder);
    await closeViewer(page);

    await selectStep(page, STEP.log);
    await openData(page, 'Контекст');
    await expect(code(page)).toContainText(V.fullName);
    await closeViewer(page);
    await expectMasked(page.getByTestId('step-title'));
    await expectMasked(page.getByTestId('step-catalog'));

    await page.getByRole('tab', { name: /^Записи/ }).click();
    const record = page.locator('[data-record-id][data-kind=incoming]').first();
    await expect(record.getByTestId('record-title')).toBeVisible();
    await expectMasked(record);
    await record.getByRole('button', { expanded: false }).first().click();
    await expect(record).toContainText(V.phone2);
    await expectMasked(record.getByTestId('record-title'));

    await page.getByRole('tab', { name: /^Схема/ }).click();
    await expectMasked(page.getByRole('group', { name: 'Схема запроса' }));
    await expectMasked(page.getByTestId('request-header'));
    await expectMasked(page.getByTestId('request-reasons'));
    expect(api).toEqual([]);
  });

  test('вложенные тела, «как в логе», «Копировать»; «Скрыть» убирает значения, следующий показ — новый запрос', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    let shows = 0;
    page.on('request', (r) => {
      if (REVEAL_URL.test(r.url())) shows++;
    });
    await openRequest(page);
    await reveal(page);
    await openResponse(page);
    const nested = await openNested(page);
    await expect(nested).toContainText(V.nationalId);
    await expect(nested).toContainText(V.phone);
    await expect(nested).toContainText(V.phone2);
    await openBody(page);

    const pre = code(page).locator('pre');
    await viewer(page).getByRole('button', { name: 'Как в логе' }).click();
    await expect(code(page)).toHaveAttribute('data-mode', 'raw');
    const raw = (await pre.textContent())!;
    expect(raw).not.toContain('\n');
    expect(raw).toContain(V.nationalId);
    expect(raw).toContain(V.holder);
    expect(raw).toContain(PAN_MASK);
    await viewer(page).getByRole('button', { name: /^Копировать/ }).click();
    await expect(viewer(page).getByRole('button', { name: /^Скопировано/ })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(raw);
    await closeViewer(page);

    await button(page).click();
    await expect(button(page)).toHaveAttribute('data-status', 'off');
    await openData(page, 'Ответ');
    await expectMasked(code(page));
    await expectMasked(await openNested(page));
    await openBody(page);
    await page.evaluate(() => navigator.clipboard.writeText(''));
    await expect(viewer(page).getByRole('button', { name: /^Копировать/ })).toBeVisible();
    await viewer(page).getByRole('button', { name: /^Копировать/ }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('"nameOnCard"');
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    for (const value of OPEN_VALUES) expect(copied).not.toContain(value);
    await closeViewer(page);

    expect(shows).toBe(1);
    await reveal(page);
    expect(shows).toBe(2);
    await openData(page, 'Ответ');
    await expect(code(page)).toContainText(V.holder);
  });

  test('сбой показа: маска, кнопка называет сбой, повтор открывает значения', async ({ page }) => {
    await openRequest(page);
    await selectStep(page, STEP.create);
    await page.route(REVEAL_URL, (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'internal', message: 'сбой' } }) }));
    await button(page).click();
    await expect(button(page)).toHaveAttribute('data-status', 'failed');
    await expect(page.getByTestId('reveal-message')).not.toBeEmpty();
    await openData(page, 'Ответ');
    await expectMasked(code(page));
    await closeViewer(page);

    await page.unroute(REVEAL_URL);
    await button(page).click();
    await expect(button(page)).toHaveAttribute('data-status', 'on');
    await openData(page, 'Ответ');
    await expect(code(page)).toContainText(V.holder);
  });

  test('уход и «Назад»: на возвращённой странице снова маска', async ({ page }) => {
    await openRequest(page);
    await reveal(page);
    await openResponse(page);
    await expect(code(page)).toContainText(V.holder);
    await closeViewer(page);

    await page.goBack();
    await expect(page.getByTestId('search-results')).toBeVisible();
    await expectMasked(page.getByTestId('search-results'));

    await page.goForward();
    await expect(button(page)).toHaveAttribute('data-status', 'off');
    await expectMasked(page.getByTestId('request-page'));
  });

  test('ссылка от коллеги: показ читает окно запроса по границам из адреса', async ({ page, browser, baseURL }) => {
    await openRequest(page);
    const link = page.url();
    const colleague = await browser.newContext({ baseURL, locale: 'ru-RU', timezoneId: 'Europe/Moscow' });
    const other = await colleague.newPage();
    const shows: string[] = [];
    other.on('request', (r) => {
      if (REVEAL_URL.test(r.url())) shows.push(new URL(r.url()).pathname);
    });
    await other.goto(link);
    await expectMasked(other.getByTestId('request-page'));
    await reveal(other);
    expect(shows).toEqual([`/api/projects/pay/envs/demo/requests/${V.cid}/reveal`]);
    await openResponse(other);
    await expect(code(other)).toContainText(V.holder);
    await colleague.close();
  });

  test('поиск по телефону: значения нет в адресе и хранилищах браузера', async ({ page }) => {
    const stored = () => page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]));
    const check = async () => {
      expect(page.url()).not.toContain(V.phone);
      const text = await stored();
      for (const value of OPEN_VALUES) expect(text).not.toContain(value);
    };
    await search(page, V.phone);
    await expect(page.getByRole('list', { name: 'Найденные запросы' }).getByRole('listitem')).toHaveCount(1);
    await check();
    await page.getByRole('list', { name: 'Найденные запросы' }).getByRole('listitem').first().locator('[data-row-link]').click(ROW_HIT);
    await expect(page.getByTestId('request-header')).toBeVisible();
    await reveal(page);
    await openResponse(page);
    await expect(code(page)).toContainText(V.holder);
    await check();
  });

  for (const width of [768, 1024, 1440, 2560]) {
    test(`${width}px: шапка и кнопка не меняются до, во время и после показа, горизонтальной прокрутки нет`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openRequest(page);
      // Уже 1280 кнопка в меню «⋯» шапки: меню остаётся открытым всё время показа.
      if (width < 1280) await openMore(page);
      await page.route(REVEAL_URL, async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 400));
        await route.continue();
      });
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme });
        const header = page.getByTestId('request-header');
        // Меню «⋯» открывается с анимацией: мерить, когда кнопка встала на место.
        let last = '';
        await expect
          .poll(async () => {
            const now = JSON.stringify(await button(page).boundingBox());
            const steady = now === last;
            last = now;
            return steady;
          })
          .toBe(true);
        const was = { header: await header.boundingBox(), button: await button(page).boundingBox() };
        const same = async () => {
          expect(await header.boundingBox()).toEqual(was.header);
          expect(await button(page).boundingBox()).toEqual(was.button);
          expect(await noScroll(page)).toBe(true);
        };
        await same();
        await button(page).click();
        await expect(button(page)).toHaveAttribute('data-status', 'loading');
        await expect(button(page)).toHaveAttribute('aria-busy', 'true');
        await same();
        await expect(button(page)).toHaveAttribute('data-status', 'on');
        await same();
        await button(page).click();
        await expect(button(page)).toHaveAttribute('data-status', 'off');
        await same();
      }
    });
  }
});

test.describe('смена настройки на открытой странице', () => {
  test.beforeEach(async ({ request }) => {
    test.skip(!(await catalogOn(request)), 'справочник выключен');
  });

  test('другой пользователь включил вид: маска после опроса, шаг и вкладка на месте, заготовки нет, новых поисков нет', async ({ page, request }) => {
    await setKinds(request, false, ['card_data']);
    await page.clock.install();
    await openRequest(page);
    await openResponse(page);
    await expect(code(page)).toContainText(V.additionalInfo);
    const step = await viewer(page).getAttribute('data-step');
    const posts: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST') posts.push(r.url());
    });
    await page.evaluate(() => {
      const w = window as unknown as { __skeleton?: boolean };
      new MutationObserver(() => {
        if (document.querySelector('[data-testid=request-skeleton]')) w.__skeleton = true;
      }).observe(document.body, { childList: true, subtree: true });
    });

    await setKinds(request, true, ['card_data']);
    await page.clock.fastForward(61_000);
    await expect(code(page)).not.toContainText(V.additionalInfo);
    await expect(code(page)).toContainText('"additionalInfo": "***"');
    // Окно тела на том же шаге и тех же данных; под ним выбран тот же шаг.
    await expect(viewer(page)).toHaveAttribute('data-step', step!);
    await expect(viewerTab(page, 'Ответ')).toHaveAttribute('aria-selected', 'true');
    await closeViewer(page);
    await expect(page.getByRole('listbox', { name: 'Шаги трассы' }).getByRole('option', { selected: true })).toContainText(STEP.create);
    expect(await page.evaluate(() => (window as unknown as { __skeleton?: boolean }).__skeleton ?? false)).toBe(false);
    expect(posts).toEqual([]);
  });

  test('другой пользователь выключил вид при показе: показ снят', async ({ page, request }) => {
    await page.clock.install();
    await openRequest(page);
    await reveal(page);
    await openResponse(page);
    await expect(code(page)).toContainText(V.holder);
    await setKinds(request, false, ['address']);
    await page.clock.fastForward(61_000);
    await expect(button(page)).toHaveAttribute('data-status', 'off');
    await expect(code(page)).not.toContainText(V.holder);
    await expect(code(page)).toContainText(V.address);
  });

  test('своя правка и загрузка файла действуют сразу', async ({ page }) => {
    await openRequest(page);
    await openResponse(page);
    await expect(code(page)).not.toContainText(V.additionalInfo);
    await closeViewer(page);

    await goToCatalog(page);
    await page.getByTestId('catalog-sections').getByText('Маскирование').click();
    await page.locator('[data-testid=masking-row][data-type=card_data]').getByTestId('masking-switch').click();
    await page.getByTestId('masking-disable').click();
    await expect(page.locator('[data-testid=masking-row][data-type=card_data]')).toHaveAttribute('data-enabled', 'false');
    await page.goBack();
    await page.goBack();
    await expect(page.getByTestId('request-header')).toBeVisible();
    await openResponse(page);
    await expect(code(page)).toContainText(V.additionalInfo);
    await closeViewer(page);

    await goToCatalog(page);
    await page.getByTestId('catalog-file-open').click();
    const sheet = page.getByTestId('project-file');
    await expect(sheet.locator('.cm-content')).toBeVisible();
    // Вид уже правили в редакторе: файл меняет его только с force.
    await sheet.getByTestId('import-input').setInputFiles({
      name: 'masking.yaml',
      mimeType: 'application/yaml',
      buffer: Buffer.from('version: 1\nproject: pay\nmasking:\n  - { type: card_data, enabled: true }\n'),
    });
    // Загрузка сбрасывает переключатель: он ставится для загруженного текста.
    await sheet.locator('#import-force').click();
    await sheet.getByTestId('import-apply').click();
    await expect(sheet.getByTestId('import-applied')).toBeVisible();
    await page.goBack();
    await page.goBack();
    await expect(page.getByTestId('request-header')).toBeVisible();
    await openResponse(page);
    await expect(code(page)).not.toContainText(V.additionalInfo);
  });

  test('событие pagehide снимает показ', async ({ page }) => {
    await openRequest(page);
    await reveal(page);
    await openResponse(page);
    await expect(code(page)).toContainText(V.holder);
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await expect(button(page)).toHaveAttribute('data-status', 'off');
    await expectMasked(code(page));
  });
});

test.describe('раздел «Маскирование»', () => {
  const row = (page: Page, type: string) => page.locator(`[data-testid=masking-row][data-type=${type}]`);
  const toggle = (page: Page, type: string) => row(page, type).getByTestId('masking-switch');
  const MASKING_PUT = /\/catalog\/masking\/[a-z_]+$/;

  test.beforeEach(async ({ request }) => {
    test.skip(!(await catalogOn(request)), 'справочник выключен');
  });

  test('все виды; выключение с подтверждением, отмена без запроса, включение сразу, сбой возвращает переключатель', async ({ page }) => {
    const puts: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'PUT') puts.push(r.url());
    });
    await page.goto('/pay/settings/masks');
    await expect(page.getByTestId('masking-row')).toHaveCount(13);
    await expect(row(page, 'surname')).toContainText('Фамилия');
    await expect(row(page, 'card_data')).toContainText('Данные карты');
    await expect(page.getByTestId('catalog-section')).toContainText('Включено 10 из 13');

    await toggle(page, 'phone').click();
    await expect(page.getByTestId('masking-confirm')).toContainText('Выключить вид «Телефон»?');
    await page.getByTestId('masking-cancel').click();
    await expect(page.getByTestId('masking-confirm')).toHaveCount(0);
    await expect(toggle(page, 'phone')).toBeChecked();
    expect(puts).toEqual([]);

    await page.route(MASKING_PUT, (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'internal', message: 'сбой' } }) }));
    await toggle(page, 'phone').click();
    await page.getByTestId('masking-disable').click();
    await expect(page.getByTestId('masking-problem')).toBeVisible();
    await expect(toggle(page, 'phone')).toBeChecked();
    await page.unroute(MASKING_PUT);

    await toggle(page, 'phone').click();
    await page.getByTestId('masking-disable').click();
    await expect(row(page, 'phone')).toHaveAttribute('data-enabled', 'false');
    await expect(row(page, 'phone')).toContainText('Выключено');
    await expect(page.getByTestId('masking-problem')).toHaveCount(0);
    await expect(page.getByTestId('catalog-section')).toContainText('Включено 9 из 13');

    await toggle(page, 'phone').click();
    await expect(page.getByTestId('masking-confirm')).toHaveCount(0);
    await expect(row(page, 'phone')).toHaveAttribute('data-enabled', 'true');
  });

  test('замок у номера и секретов, кто открывает; панель с кодовым словом; поиск по кодовому слову; запрос в обход формы отклонён', async ({ page, request }) => {
    await page.goto('/pay/settings/masks');
    for (const type of ['card_number', 'secrets']) {
      await expect(row(page, type).getByTestId('masking-lock')).toBeVisible();
      await expect(toggle(page, type)).toHaveCount(0);
    }
    await expect(row(page, 'card_number')).toContainText('глазком: поддержка, разработчик, аналитик, администратор');
    await expect(row(page, 'secrets')).toContainText('глазком: аналитик, администратор');
    await expect(row(page, 'phone')).toContainText('глазком: поддержка, разработчик; сразу: аналитик, администратор');
    for (const type of ['first_name', 'birth_date', 'email']) await expect(toggle(page, type)).toHaveAttribute('data-state', 'unchecked');

    await row(page, 'secrets').getByRole('button').first().click();
    const sheet = page.getByTestId('masking-sheet');
    await expect(sheet.getByTestId('masking-builtin')).toContainText('cardholderPassword');
    await expect(sheet.getByTestId('masking-locked-note')).toContainText('пароль в адресе');
    await sheet.getByTestId('masking-key-input').fill('mobile_phone');
    await expect(sheet.getByTestId('masking-key-error')).toContainText('Телефон');
    await page.keyboard.press('Escape');

    await page.goto('/pay/catalog');
    await page.getByTestId('catalog-search').fill('cardholderPassword');
    await expect(page.getByTestId('catalog-search-results')).toContainText('Секреты');
    await page.getByTestId('catalog-search').fill('primaryAccountNumber');
    await expect(page.getByTestId('catalog-search-results')).toContainText('Номер карты');

    const rows = ((await (await request.get(API)).json()) as { masking: MaskingRow[] }).masking;
    const secrets = rows.find((r) => r.type === 'secrets')!;
    const refused = await request.put(`${API}/masking/secrets`, { data: { enabled: false, keys: secrets.keys, updatedAt: secrets.updatedAt } });
    expect(refused.status()).toBe(422);
  });

  test('конфликт показывает настоящее состояние; при недоступной базе правка закрыта', async ({ page, request }) => {
    await page.goto('/pay/settings/masks');
    await expect(toggle(page, 'address')).toBeChecked();
    await setKinds(request, false, ['address']);
    await toggle(page, 'address').click();
    await page.getByTestId('masking-disable').click();
    await expect(page.getByTestId('masking-problem')).toContainText('изменил другой пользователь');
    await expect(row(page, 'address')).toHaveAttribute('data-enabled', 'false');
    await expect(toggle(page, 'address')).not.toBeChecked();

    await page.route('**/api/catalog', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ state: 'stale', loadedAt: Date.now(), message: 'база недоступна', masking: {} }) }));
    await page.reload();
    await expect(page.getByTestId('catalog-readonly')).toBeVisible();
    await expect(page.getByTestId('masking-row')).toHaveCount(13);
    for (const type of KINDS) await expect(toggle(page, type)).toBeDisabled();
  });

  test('файл: вид в отчёте, предупреждение о выключении, применение', async ({ page }) => {
    await page.goto('/pay/catalog');
    await page.getByTestId('catalog-file-open').click();
    const sheet = page.getByTestId('project-file');
    await expect(sheet.locator('.cm-content')).toBeVisible();
    await sheet.getByTestId('import-input').setInputFiles({
      name: 'masking.yaml',
      mimeType: 'application/yaml',
      buffer: Buffer.from('version: 1\nproject: pay\nmasking:\n  - { type: surname, enabled: false, keys: [client_last_name_alt] }\n'),
    });
    // Вид уже правили в редакторе: файл меняет его только с force. Загрузка сбрасывает переключатель, поэтому он ставится после неё.
    await sheet.locator('#import-force').click();
    await expect(sheet.getByTestId('import-masking-off')).toContainText('Файл выключает вид «Фамилия»');
    await expect(sheet.getByTestId('import-report')).toContainText('Фамилия');
    await sheet.getByTestId('import-apply').click();
    await expect(sheet.getByTestId('import-applied')).toBeVisible();
    await page.goto('/pay/settings/masks');
    await expect(row(page, 'surname')).toHaveAttribute('data-enabled', 'false');
    await expect(row(page, 'surname')).toContainText('Выключено');
  });

  test('выключенный вид открыт только в подробностях шага; все выключены — кнопки нет; включить — снова маска', async ({ page, request }) => {
    await setKinds(request, false, ['phone']);
    await openRequest(page);
    await selectStep(page, STEP.entry);
    await expect(address(page)).toContainText(V.phone);
    await openData(page, 'Запрос');
    await expect(code(page)).toContainText(V.phone2);
    await closeViewer(page);
    await expect(button(page)).toBeVisible();
    await expect(details(page)).toContainText(PHONE_MASK);
    await expectMasked(page.getByTestId('step-title'));
    await expectMasked(page.getByTestId('request-header'));
    await expectMasked(page.getByTestId('request-reasons'));

    // Итог шага и подсказка строки.
    await selectStep(page, STEP.log);
    await expectMasked(page.getByTestId('step-catalog'));
    await page.getByRole('tab', { name: /^Записи/ }).click();
    const logRow = page.locator('[data-record-id][data-error]').last();
    await expectMasked(logRow.getByTestId('record-title'));
    expect(await logRow.getByTestId('record-title').getAttribute('title')).not.toContain(V.phone);

    // Форма справочника из шага.
    await selectStep(page, STEP.entry);
    await details(page).getByTestId('step-catalog-add').click();
    const form = page.getByTestId('catalog-form');
    await expect(form).toBeVisible();
    // Форма заполняется после появления.
    const values = () => form.locator('input, textarea').evaluateAll((els) => els.map((el) => (el as HTMLInputElement).value).join(' '));
    await expect.poll(values).toContain('/contacts/');
    expect(await values()).not.toContain(V.phone);
    await expectMasked(form);
    await page.keyboard.press('Escape');

    // «Все записи»: блок открыт, заголовок и подсказка с маской.
    await page.goBack();
    await page.goto('/pay/demo');
    await search(page, V.cid);
    await page.getByRole('tab', { name: 'Все записи' }).click();
    const list = page.getByRole('list', { name: 'Все найденные строки' });
    const incoming = list.locator('[data-record-id][data-kind=incoming]').first();
    await expectMasked(incoming);
    await incoming.getByRole('button', { expanded: false }).first().click();
    await expect(incoming).toContainText(V.phone2);
    await expectMasked(incoming.getByTestId('record-title'));

    // Все виды выключены: показывать нечего, номер карты по-прежнему скрыт.
    await setKinds(request, false);
    await openRequest(page);
    await expect(button(page)).toHaveCount(0);
    await openResponse(page);
    for (const value of [V.holder, V.additionalInfo, V.expiry]) await expect(code(page)).toContainText(value);
    await expect(code(page)).toContainText(PAN_MASK);
    await expect(code(page)).not.toContainText(V.pan);
    await closeViewer(page);

    await setKinds(request, true);
    await openRequest(page);
    await expect(button(page)).toBeVisible();
    await openResponse(page);
    await expectMasked(code(page));
  });

  for (const width of [768, 2560]) {
    test(`${width}px: выключенный вид без горизонтальной прокрутки, светлая и тёмная тема`, async ({ page, request }) => {
      await setKinds(request, false, ['phone']);
      await page.setViewportSize({ width, height: 900 });
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme });
        await page.goto('/pay/settings/masks');
        await expect(page.getByTestId('masking-row')).toHaveCount(13);
        expect(await noScroll(page)).toBe(true);
        await openRequest(page);
        await openResponse(page);
        await expect(await openNested(page)).toContainText(V.phone);
        expect(await noScroll(page)).toBe(true);
        await closeViewer(page);
      }
    });
  }
});

test.describe('большое окно кода и показ', () => {
  const win = (page: Page) => page.getByTestId('code-window');

  // Большое окно кода есть у блоков записей: окно не модальное, «Показать скрытое» нажимается при открытом окне.
  test('маска остаётся маской, «Показать скрытое» обновляет окно записи, копирование берёт то, что на экране, «Скрыть» возвращает маску', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openRequest(page);
    await page.getByRole('tab', { name: /^Записи/ }).click();
    const record = page.locator('li[data-record-id][data-kind=response]').filter({ hasText: '/createCustomer' });
    await openBlock(record);
    await record.locator('[data-block=response]').getByTestId('code-window-open').click();
    const pre = win(page).locator('pre');
    await expect(pre).toContainText(PAN_MASK);
    await expect(pre).not.toContainText(V.holder);
    await reveal(page);
    await expect(pre).toContainText(V.holder);
    await expect(pre).toContainText(PAN_MASK);
    await expect(pre).not.toContainText(V.pan);
    await win(page).getByRole('button', { name: /^Копировать/ }).click();
    await expect(win(page).getByRole('button', { name: /^Скопировано/ })).toBeVisible();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain(V.holder);
    expect(copied).not.toContain(V.pan);
    await button(page).click();
    await expect(button(page)).toHaveAttribute('data-status', 'off');
    await expect(pre).not.toContainText(V.holder);
    await expect(pre).toContainText(PAN_MASK);
  });
});

test.describe('глазок на номере карты', () => {
  // Набор идёт без входа, таким зрителем номер закрыт. Ответ показа поддержки подставляется здесь: проверяется путь браузера, а сервер и роли проверяет свой тест.
  const asSupport = (page: Page) =>
    page.route(REVEAL_URL, async (route) => {
      const res = await route.fetch();
      await route.fulfill({ response: res, body: (await res.text()).replaceAll(PAN_MASK, V.pan) });
    });
  /** Копирование кнопкой окна тела: то, что в нём на экране. */
  const copy = async (page: Page) => {
    await page.evaluate(() => navigator.clipboard.writeText(''));
    await viewer(page).getByRole('button', { name: /^Копировать/ }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).not.toBe('');
    return page.evaluate(() => navigator.clipboard.readText());
  };

  test('без входа: глазок открывает виды с выключателем, номер и пароль остаются; новые виды открыты', async ({ page }) => {
    await openRequest(page);
    await selectStep(page, STEP.account);
    await openData(page, 'Запрос');
    await expect(code(page)).toContainText('****9101');
    await expect(code(page)).toContainText(PAN_MASK);
    await closeViewer(page);
    await reveal(page);
    await openData(page, 'Запрос');
    for (const value of [V.accountId, V.bankAccountId, V.cardToken]) await expect(code(page)).toContainText(value);
    await expect(code(page)).toContainText(PAN_MASK);
    await expect(code(page)).not.toContainText(V.pan);
    await expect(code(page)).not.toContainText(V.password);
    await closeViewer(page);
    await expect(address(page)).toContainText(V.account);
    await expectMasked(page.getByTestId('step-title'));
  });

  test('подсказка кнопки: что показ не вернёт и что останется под маской', async ({ page }) => {
    await openRequest(page);
    await button(page).hover();
    const tip = page.getByRole('tooltip').first();
    await expect(tip).toContainText('Значение, скрытое приложением до записи в лог, показ не вернёт');
    await expect(tip).toContainText('Останутся под маской: номер карты, секреты');
  });

  test('копирование: при показе номер в буфере, пароль маской; после «Скрыть» в буфере маска', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await asSupport(page);
    await openRequest(page);
    await selectStep(page, STEP.account);
    await reveal(page);
    await openData(page, 'Запрос');
    await expect(code(page)).toContainText(V.pan);

    const open = await copy(page);
    expect(open).toContain(V.pan);
    expect(open).toContain(V.accountId);
    expect(open).not.toContain(V.password);
    expect(open).toMatch(/"password":\s*"\*\*\*"/);

    await viewer(page).getByRole('button', { name: 'Как в логе' }).click();
    await expect(code(page)).toHaveAttribute('data-mode', 'raw');
    const raw = await copy(page);
    expect(raw).toContain(V.pan);
    expect(raw).not.toContain(V.password);
    await closeViewer(page);

    // Окно тела открывается снова в виде «Форматировано».
    await button(page).click();
    await expect(button(page)).toHaveAttribute('data-status', 'off');
    await openData(page, 'Запрос');
    await expect(code(page)).toHaveAttribute('data-mode', 'pretty');
    await expect(code(page)).not.toContainText(V.pan);
    await expect(viewer(page).getByRole('button', { name: /^Копировать/ })).toBeVisible();
    const masked = await copy(page);
    expect(masked).not.toContain(V.pan);
    expect(masked).toContain(PAN_MASK);
    expect(masked).not.toContain(V.accountId);
  });
});

test.describe('кнопка показа и режимы', () => {
  // Режим показа на странице запроса — в меню профиля. Шаг выбирается в «Подробно»: в «Кратко» у шагов другие подписи.
  const viewSetting = async (request: APIRequestContext) => {
    const body = (await (await request.get('/api/project-settings')).json()) as { projects: { id: string; view: { blocks: Record<string, { full: boolean; brief: boolean }> }; viewUpdatedAt: string | null }[] };
    return body.projects.find((p) => p.id === 'pay')!;
  };
  const putView = async (request: APIRequestContext, view: unknown) => {
    const p = await viewSetting(request);
    const r = await request.put('/api/projects/pay/view', { data: { view, updatedAt: p.viewUpdatedAt } });
    expect(r.status(), await r.text()).toBe(200);
  };
  const noBriefBlocks = async (request: APIRequestContext) => {
    const p = await viewSetting(request);
    const blocks = Object.fromEntries(Object.entries(p.view.blocks).map(([k, v]) => [k, { ...v, brief: false }]));
    await putView(request, { ...p.view, blocks });
  };
  test.afterEach(async ({ request }) => {
    if (await catalogOn(request)) await putView(request, null);
  });

  test('кнопка в «Кратко» с блоками: значения в видимых телах открыты, новых запросов нет', async ({ page, request }) => {
    test.skip(!(await catalogOn(request)), 'нужен справочник');
    const shows: string[] = [];
    page.on('request', (r) => {
      if (REVEAL_URL.test(new URL(r.url()).pathname + new URL(r.url()).search)) shows.push(r.url());
    });
    await openRequest(page);
    await selectStep(page, STEP.create);
    await reveal(page);
    expect(shows).toHaveLength(1);
    await setViewMode(page, 'Кратко');
    await expect(button(page)).toHaveAttribute('data-status', 'on');
    await openData(page, 'Ответ');
    await expect(code(page)).toContainText(V.holder);
    await expect(code(page)).not.toContainText(V.pan);
    await closeViewer(page);
    expect(shows).toHaveLength(1);
    await setViewMode(page, 'Подробно');
    await expect(button(page)).toHaveAttribute('data-status', 'on');
    expect(shows).toHaveLength(1);
  });

  test('без блоков кнопки нет, показ снят, значения удалены, возврат показывает маску, запроса нет', async ({ page, request }) => {
    test.skip(!(await catalogOn(request)), 'нужен справочник');
    await noBriefBlocks(request);
    const shows: string[] = [];
    page.on('request', (r) => {
      if (REVEAL_URL.test(new URL(r.url()).pathname + new URL(r.url()).search)) shows.push(r.url());
    });
    await openRequest(page);
    await reveal(page);
    await openResponse(page);
    await expect(code(page)).toContainText(V.holder);
    await closeViewer(page);
    const before = shows.length;
    const header = (await page.getByTestId('request-header').boundingBox())!.height;
    await setViewMode(page, 'Кратко');
    await expect(button(page)).toHaveCount(0);
    expect((await page.getByTestId('request-header').boundingBox())!.height).toBe(header);
    await setViewMode(page, 'Подробно');
    await expect(button(page)).toHaveAttribute('data-status', 'off');
    await openResponse(page);
    await expectMasked(code(page));
    expect(shows.length).toBe(before);
  });

  test('идущий запрос показа отменяется при переходе в режим без блоков', async ({ page, request }) => {
    test.skip(!(await catalogOn(request)), 'нужен справочник');
    await noBriefBlocks(request);
    let hold!: () => void;
    const held = new Promise<void>((r) => (hold = r));
    await page.route(REVEAL_URL, async (route) => {
      await held;
      await route.continue().catch(() => undefined);
    });
    await openRequest(page);
    await selectStep(page, STEP.create);
    const aborted = page.waitForEvent('requestfailed', { predicate: (r) => REVEAL_URL.test(r.url()) });
    await button(page).click();
    await expect(button(page)).toHaveAttribute('data-status', 'loading');
    await setViewMode(page, 'Кратко');
    await aborted;
    hold();
    await setViewMode(page, 'Подробно');
    await expect(button(page)).toHaveAttribute('data-status', 'off');
    await openResponse(page);
    await expectMasked(code(page));
  });

  test('при всех включённых блоках номера карт и секреты маской', async ({ page, request }) => {
    test.skip(!(await catalogOn(request)), 'нужен справочник');
    const p = await viewSetting(request);
    await putView(request, { ...p.view, blocks: Object.fromEntries(Object.entries(p.view.blocks).map(([k]) => [k, { full: true, brief: true }])) });
    await openRequest(page);
    await selectStep(page, STEP.create);
    await setViewMode(page, 'Кратко');
    await reveal(page);
    await openData(page, 'Ответ');
    await expect(code(page)).toContainText(PAN_MASK);
    await expect(viewer(page)).not.toContainText(V.pan);
    await closeViewer(page);
    await expect(details(page)).not.toContainText(V.pan);
  });
});

test.describe('Скопировать как cURL', () => {
  const copied = async (page: Page) => {
    await page.getByTestId('copy-curl').click();
    await expect(page.getByTestId('copy-curl')).toHaveAttribute('data-copied', 'true');
    // Подтверждение видно без подсказки: и слово, и галочка; ширина кнопки та же.
    await expect(page.getByTestId('copy-curl').getByText('Скопировано', { exact: true }).first()).toBeVisible();
    await expect(page.getByTestId('copy-curl').locator('svg.lucide-check')).toBeVisible();
    return page.evaluate(() => navigator.clipboard.readText());
  };

  test('под маской, после показа открыто, после «Скрыть» снова под маской; настоящая оболочка получила бы то же', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openRequest(page);
    await selectStep(page, STEP.create);
    await expect(page.getByTestId('copy-curl')).toHaveAttribute('data-masked', 'true');
    const masked = await copied(page);
    expect(masked).toMatch(/^curl -g -X POST --url '/);
    expect(masked).not.toMatch(/content-length/i);
    for (const value of [V.phone, V.pan, V.password]) expect(masked).not.toContain(value);

    await reveal(page);
    const open = await copied(page);
    expect(open).not.toBe(masked);
    expect(open).toContain(V.phone.slice(-9));

    await button(page).click();
    await expect(button(page)).toHaveAttribute('data-status', 'off');
    expect(await copied(page)).toBe(masked);
  });

  test('отказ буфера: крестик и короткие слова, ширина кнопки та же, полный текст у диктора', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openRequest(page);
    await selectStep(page, STEP.create);
    const curl = page.getByTestId('copy-curl');
    const width = (await curl.boundingBox())!.width;
    await page.evaluate(() => {
      navigator.clipboard.writeText = () => Promise.reject(new Error('отказ'));
      document.execCommand = () => false;
    });
    await curl.click();
    await expect(curl.locator('svg.lucide-x')).toBeVisible();
    await expect(curl.getByText('Не удалось', { exact: true })).toBeVisible();
    await expect(curl.getByText('Не удалось скопировать', { exact: true })).toHaveCount(1);
    expect((await curl.boundingBox())!.width).toBeCloseTo(width, 1);
  });

  test('запись-лог и режим «Кратко»: кнопки нет', async ({ page }) => {
    await openRequest(page);
    await selectStep(page, STEP.log);
    await expect(page.getByTestId('copy-curl')).toHaveCount(0);
    await selectStep(page, STEP.create);
    await expect(page.getByTestId('copy-curl')).toBeVisible();
    await setViewMode(page, 'Кратко');
    await expect(page.getByTestId('copy-curl')).toHaveCount(0);
  });
});
