import { expect, test, type Locator, type Page } from '@playwright/test';
import { MOCK_SPECIAL } from '../../server/src/backends/mock/dataset-pay.ts';
import { closeViewer, dataRow, viewer, viewerCode } from './helpers.ts';

// Нажатие у левого края строки: в середине строки может оказаться метка параметра, она копирует, а не открывает.
const ROW_HIT = { position: { x: 8, y: 8 } };

// Раскладка: два режима, одно поле страницы, вся ширина окна, без горизонтальной прокрутки, читаемые пути, ничего не прыгает при выборе шага.

const rows = (page: Page) => page.getByRole('list', { name: 'Найденные запросы' }).getByRole('listitem');
const scheme = (page: Page) => page.getByTestId('trace-scheme');
const graphNodes = (page: Page) => scheme(page).locator('button[data-node]');
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function search(page: Page, term: string) {
  await page.goto('/pay/demo');
  const input = page.getByRole('textbox', { name: 'Значения для поиска' });
  await input.fill(term);
  await input.press('Enter');
  await page.getByRole('group', { name: 'Период' }).getByRole('button', { name: '24 ч', exact: true }).click();
  await page.getByRole('button', { name: 'Найти', exact: true }).click();
  await expect(page.getByTestId('search-results')).toHaveAttribute('data-status', 'done', { timeout: 20_000 });
}

async function openFirst(page: Page, status?: 'error' | 'success') {
  const row = status ? rows(page).and(page.locator(`[data-status=${status}]`)).first() : rows(page).first();
  await row.locator('[data-row-link]').click(ROW_HIT);
  await expect(page.getByTestId('request-header')).toBeVisible();
  // Граф грузится лениво.
  await expect(page.getByTestId('flow-canvas')).toBeVisible({ timeout: 15_000 });
}

/** Положение в координатах страницы: прокрутка не считается сдвигом. */
const box = (loc: Locator) =>
  loc.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + scrollX), y: Math.round(r.y + scrollY), w: Math.round(r.width), h: Math.round(r.height) };
  });
const pageBox = (page: Page, testId: string) => box(page.getByTestId(testId));

/** Заголовки записей, видимые на экране (не в раскрытых блоках), в которых остался UUID. */
const uuidTitles = (page: Page) =>
  page.evaluate(() => {
    const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    return [...document.querySelectorAll('[data-testid=record-title]')]
      .filter((el) => !el.closest('pre, [data-block]') && el.getClientRects().length > 0 && uuid.test(el.textContent ?? ''))
      .map((el) => el.textContent);
  });

const SEVEN = [768, 1024, 1280, 1440, 1536, 1920, 2560];

test.describe('два режима раскладки', () => {
  /** Страница с меткой WorkPage: высоты содержимого хватит на прокрутку, если окно её допускает. */
  const addWorkPage = (page: Page) =>
    page.evaluate(() => {
      const el = document.createElement('div');
      el.setAttribute('data-work-page', '');
      el.style.height = '5000px';
      document.querySelector('main')!.append(el);
    });
  const pageScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollHeight - document.documentElement.clientHeight);

  for (const [width, height] of [
    [1280, 700],
    [1280, 720],
    [1440, 785],
    [1536, 730],
    [1920, 930],
    [2560, 1200],
  ] as const) {
    test(`${width}×${height}: рабочий режим, страница в размер окна не прокручивается, шапка на месте`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.goto('/pay/demo');
      await expect(page.getByTestId('auth-off')).toBeVisible();
      await addWorkPage(page);
      expect(await pageScroll(page)).toBeLessThanOrEqual(0);
      expect((await page.getByRole('banner').boundingBox())!.y).toBe(0);
    });
  }

  for (const [width, height] of [
    [1279, 800],
    [1024, 768],
    [768, 1024],
    [1440, 699],
    [1920, 600],
  ] as const) {
    test(`${width}×${height}: компактный режим, та же страница прокручивается`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.goto('/pay/demo');
      await expect(page.getByTestId('auth-off')).toBeVisible();
      await addWorkPage(page);
      expect(await pageScroll(page)).toBeGreaterThan(0);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
    });
  }

  for (const [width, height] of [
    [1280, 650],
    [1536, 650],
  ] as const) {
    test(`${width}×${height}: низкое широкое окно получает компактные правила, панель шага остаётся справа`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await search(page, 'getCard');
      await openFirst(page, 'error');
      // Подпись «Показать скрытое» видна только в рабочем режиме.
      await expect(page.getByTestId('reveal-button')).toBeVisible();
      await expect(page.getByTestId('reveal-button').locator('span.grid')).toBeHidden();
      const canvas = await pageBox(page, 'flow-canvas');
      const panel = await pageBox(page, 'step-details');
      expect(panel.x).toBeGreaterThanOrEqual(canvas.x + canvas.w);
      // Панель начинается под линией вкладок и на неё не заходит.
      const tabs = await box(page.getByRole('tablist').first());
      expect(panel.y).toBeGreaterThanOrEqual(tabs.y + tabs.h);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
    });
  }

  test('остальные страницы прокручиваются обычным образом и в рабочем режиме, шапка закреплена', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 785 });
    await page.goto('/docs');
    await expect(page.getByRole('main').getByRole('heading').first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeGreaterThan(785);
    await page.evaluate(() => window.scrollTo(0, 400));
    expect((await page.getByRole('banner').boundingBox())!.y).toBe(0);
  });

  test('смена режима не теряет ввод и выбранный период: переключает CSS, а не страница', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 785 });
    await page.goto('/pay/demo');
    const input = page.getByRole('textbox', { name: 'Значения для поиска' });
    await input.fill('черновик');
    const period = page.getByRole('group', { name: 'Период' });
    await period.getByRole('button', { name: '24 ч', exact: true }).click();
    await page.setViewportSize({ width: 1100, height: 600 });
    await expect(input).toHaveValue('черновик');
    await expect(period.getByRole('button', { name: '24 ч', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.setViewportSize({ width: 1440, height: 785 });
    await expect(input).toHaveValue('черновик');
  });

  for (const width of [768, 1023, 1024, 1920, 2560]) {
    test(`${width}px: одно поле страницы у шапки и всех страниц`, async ({ page }) => {
      const gutter = width < 1024 ? 16 : 24;
      await page.setViewportSize({ width, height: 900 });
      for (const [path, testId] of [
        ['/pay/demo', 'search-panel'],
        ['/pay/catalog', 'catalog-page'],
        ['/admin/status', 'service-page'],
        ['/about', 'help-page-about'],
      ] as const) {
        // От 1280 у зоны «Проект» слева боковое меню: поле страницы проверяется только у компактного режима.
        if (path === '/pay/catalog' && width >= 1280) continue;
        await page.goto(path);
        await expect(page.getByTestId(testId), path).toBeVisible();
        expect((await page.getByRole('link', { name: 'Threadline, на главную' }).boundingBox())!.x, path).toBe(gutter);
        // Настройки сервиса — колонка 928 px посередине окна: где окно шире, поля по краям равны и не меньше общего.
        if (path === '/admin/status' && width > 928) {
          const column = (await page.getByTestId(testId).boundingBox())!;
          expect(column.width, path).toBe(928);
          expect(Math.abs(column.x - (width - column.x - column.width)), path).toBeLessThanOrEqual(1);
          expect(column.x, path).toBeGreaterThanOrEqual(gutter);
          continue;
        }
        // У карточки поиска левый край сам стоит на поле, у страницы поле внутри.
        const x = await page.getByTestId(testId).evaluate((el) => (el.getAttribute('data-testid') === 'search-panel' ? el.getBoundingClientRect().x : el.getBoundingClientRect().x + parseFloat(getComputedStyle(el).paddingLeft)));
        expect(x, path).toBe(gutter);
      }
    });
  }

  test('семь ширин: у страниц нет горизонтальной прокрутки', async ({ page }) => {
    test.setTimeout(120_000);
    for (const width of SEVEN) {
      await page.setViewportSize({ width, height: 900 });
      for (const path of ['/pay/demo', '/pay/catalog', '/admin/projects', '/admin/status', '/pay/settings/main', '/about', '/docs']) {
        await page.goto(path);
        await expect(page.getByRole('main'), path).toBeVisible();
        await expect(page.getByTestId('page-skeleton'), path).toHaveCount(0);
        expect(await overflow(page), `${width}px ${path}`).toBeLessThanOrEqual(0);
      }
    }
  });
});

test.describe('раскладка во всю ширину', () => {
  test('1920px: результаты и запрос шире 1600px, края совпадают с шапкой', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await search(page, 'pay.example');
    const results = (await page.getByTestId('search-results').boundingBox())!;
    expect(results.width).toBeGreaterThan(1600);
    expect(results.x).toBe(24);
    // Колонки итога, компонента и длительности видны в одной строке с путём.
    const row = rows(page).and(page.locator('[data-status=error]')).first();
    const [pathBox, reasonBox, rowBox] = await Promise.all([row.getByTestId('request-path').boundingBox(), row.getByTestId('request-reason').boundingBox(), row.boundingBox()]);
    expect(rowBox!.height).toBeLessThanOrEqual(48);
    expect(Math.abs(pathBox!.y + pathBox!.height / 2 - (reasonBox!.y + reasonBox!.height / 2))).toBeLessThan(3);
    expect(reasonBox!.x).toBeGreaterThan(pathBox!.x + pathBox!.width);
    await openFirst(page, 'error');
    const request = (await page.getByTestId('request-page').boundingBox())!;
    expect(request.width).toBeGreaterThan(1600);
    // В рабочем режиме схема и панель шага рядом, панель стоит прямо под вкладками; обычная ширина панели 400 px.
    const [s, d] = await Promise.all([scheme(page).boundingBox(), page.getByTestId('step-details').boundingBox()]);
    expect(d!.x).toBeGreaterThanOrEqual(s!.x + s!.width);
    expect(Math.abs(d!.y - s!.y)).toBeLessThan(8);
    expect(d!.width).toBe(400);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });

  test('768px: результаты с параметрами и страница запроса без горизонтальной прокрутки', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await search(page, 'pay.example');
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    // Поля 16px, строки одной высоты.
    expect((await page.getByTestId('search-results').boundingBox())!.x).toBe(16);
    const heights = await rows(page).evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().height)));
    expect(new Set(heights).size).toBe(1);
    await openFirst(page, 'error');
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await page.getByRole('tab', { name: 'Шкала времени' }).click();
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });
});

test.describe('читаемые пути', () => {
  const user = MOCK_SPECIAL.gatewayUserId;

  test('путь шаблоном и параметры метками: в списке, в шапке запроса, на схеме и в подробностях', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.setViewportSize({ width: 1920, height: 1080 });
    await search(page, user);
    const row = rows(page).first();
    await expect(row.getByTestId('request-path')).toHaveText('POST /v1/users/{user}/transfers/{transfer}/fee');
    const chips = row.getByTestId('param-chip');
    await expect(chips).toHaveCount(2);
    await expect(chips.first()).toHaveAttribute('data-name', 'user');
    await expect(chips.first()).toHaveAttribute('data-value', user);
    // Коротко на экране, целиком — в подсказке.
    await expect(chips.first()).toHaveText(`user${user.slice(0, 4)}…${user.slice(-5)}`);
    await chips.first().hover();
    await expect(page.getByRole('tooltip')).toContainText(user);
    // Нажатие на метку в строке копирует значение и не открывает запрос.
    await chips.first().click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(user);
    await expect(page).toHaveURL(/\?search=/);

    // Остальная строка открывает запрос.
    await row.getByTestId('request-path').click();
    const header = page.getByTestId('request-header');
    await expect(header.getByRole('heading', { level: 1 })).toHaveText('POST /v1/users/{user}/transfers/{transfer}/fee');
    const headerChip = header.getByRole('button', { name: `Скопировать user: ${user}` });
    await expect(headerChip).toBeVisible();
    await page.evaluate(() => navigator.clipboard.writeText(''));
    await headerChip.click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(user);
    // Вход на графе и в подробностях — тоже шаблоном.
    const entry = scheme(page).locator('button[data-node][data-kind=entry]');
    await expect(entry.getByTestId('node-method')).toContainText('POST /v1/users/{user}/transfers/{transfer}/fee');
    await entry.click();
    await expect(page.getByTestId('step-details').getByTestId('step-title')).toHaveText('POST /v1/users/{user}/transfers/{transfer}/fee');
    await expect(page.getByTestId('step-details').getByTestId('param-chip')).toHaveCount(2);
  });

  test('итог шага одной строкой: «OK», статус и длительность', async ({ page }) => {
    await search(page, 'switch.pay.example');
    await openFirst(page, 'success');
    await scheme(page).locator('button[data-node][data-kind=exchange]').first().click();
    const outcome = page.getByTestId('step-details').getByTestId('step-outcome');
    await expect(outcome).toContainText('OK');
    await expect(outcome).toContainText('200');
    await expect(outcome.getByTestId('step-duration')).toHaveText(/^\d+ мс$/);
  });
});

test.describe('стабильность', () => {
  for (const width of [1280, 1920]) {
    test(`${width}px: схема не сдвигается при выборе шагов`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 });
      await search(page, 'getCard');
      await openFirst(page, 'error');
      const nodes = graphNodes(page);
      await expect(nodes.first()).toBeVisible();
      const before = await pageBox(page, 'trace-scheme');
      const count = await nodes.count();
      expect(count).toBeGreaterThan(2);
      for (let i = 0; i < count; i++) {
        await nodes.nth(i).click();
        await expect(nodes.nth(i)).toHaveAttribute('aria-pressed', 'true');
        expect(await pageBox(page, 'trace-scheme'), `шаг ${i}`).toEqual(before);
      }
    });
  }

  test('шкала времени: панель шагов не сдвигается при выборе шага', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await search(page, 'getCard');
    await openFirst(page, 'error');
    await page.getByRole('tab', { name: 'Шкала времени' }).click();
    const before = await pageBox(page, 'trace-timeline');
    const options = page.getByRole('listbox', { name: 'Шаги трассы' }).getByRole('option');
    for (let i = 0; i < (await options.count()); i++) {
      await options.nth(i).click();
      expect(await pageBox(page, 'trace-timeline'), `шаг ${i}`).toEqual(before);
    }
  });

  test('поиск: заготовка той же высоты, результат не сдвигает панель поиска, поле и период', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/pay/slow');
    const panel = await pageBox(page, 'search-panel');
    const input = page.getByRole('textbox', { name: 'Значения для поиска' });
    const period = page.getByRole('group', { name: 'Период' });
    await input.fill('getCard');
    await input.press('Enter');
    await period.getByRole('button', { name: '6 ч', exact: true }).click();
    // Поле и период на месте до поиска, во время него («Стоп») и после.
    const controls = async () => ({ input: await box(input), period: await box(period) });
    const before = await controls();
    await page.getByRole('button', { name: 'Найти', exact: true }).click();
    await expect(page.getByTestId('search-progress')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Стоп', exact: true })).toBeVisible();
    expect(await controls()).toEqual(before);
    const tabs = await page.getByTestId('search-results').getByRole('tablist').evaluate((el) => Math.round(el.getBoundingClientRect().y + scrollY));
    await expect(page.getByTestId('search-results')).toHaveAttribute('data-status', 'done', { timeout: 30_000 });
    // Полоса хода поиска исчезла, а вкладки и панель остались на месте.
    expect(await page.getByTestId('search-results').getByRole('tablist').evaluate((el) => Math.round(el.getBoundingClientRect().y + scrollY))).toBe(tabs);
    expect(await pageBox(page, 'search-panel')).toEqual(panel);
    await expect(page.getByRole('button', { name: 'Обновить' })).toBeVisible();
    expect(await controls()).toEqual(before);
  });

  for (const width of [1280, 1920]) {
    test(`${width}px: подробности на схеме и на шкале — на одном месте и одной ширины`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 });
      await search(page, 'getCard');
      await openFirst(page, 'error');
      const onScheme = await pageBox(page, 'step-details');
      await page.getByRole('tab', { name: 'Шкала времени' }).click();
      await expect(page.getByTestId('trace-timeline')).toBeVisible();
      const onTimeline = await pageBox(page, 'step-details');
      expect({ x: onTimeline.x, w: onTimeline.w }).toEqual({ x: onScheme.x, w: onScheme.w });
    });
  }

  test('1280px: шапка запроса в две строки одной высоты у разных запросов, вкладка «Записи» не прокручивает страницу', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await search(page, 'pay.example');
    const heights: number[] = [];
    for (const text of ['/lookup', '/transfers/']) {
      await rows(page).filter({ hasText: text }).first().locator('[data-row-link]').click(ROW_HIT);
      await expect(page.getByTestId('request-header')).toBeVisible();
      const head = await pageBox(page, 'request-header');
      heights.push(head.h);
      // Первая строка 36 px, под ней сведения в 22 px: ими шапка кончается, перенос строк её не растит.
      const meta = await pageBox(page, 'request-meta');
      expect(meta.h, text).toBe(22);
      expect(Math.abs(meta.y + meta.h - (head.y + head.h)), text).toBeLessThanOrEqual(1);
      expect(Math.abs(meta.y - head.y - 40), text).toBeLessThanOrEqual(1);
      await page.getByRole('link', { name: 'К результатам' }).click();
      await expect(rows(page).first()).toBeVisible();
    }
    expect(heights[0]).toBe(heights[1]);

    // Нужен запрос с записью-ошибкой. Первая ошибка в «pay.example» может оказаться отправкой без ответа: через 30 с
    // после старта набора она из «ждёт ответа» становится ошибкой, а записи-ошибки у неё нет.
    await search(page, 'getCard');
    await openFirst(page, 'error');
    await page.getByRole('tab', { name: /^Записи/ }).click();
    await expect(page.locator('li[data-error]').first()).toBeInViewport();
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => scrollY)).toBe(0);
  });
});

test.describe('читаемые записи', () => {
  test('в «Всех записях» и «Записях» заголовки без UUID: пути шаблоном, строка шлюза разобрана', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await search(page, 'pay.example');
    await page.getByRole('tab', { name: 'Все записи' }).click();
    const lines = page.getByRole('list', { name: 'Все найденные строки' });
    await expect(lines.locator('li[data-record-id]').first()).toBeVisible();
    expect(await uuidTitles(page)).toEqual([]);
    await expect(lines).not.toContainText('[GIN]');

    await page.getByRole('tab', { name: 'Запросы' }).click();
    await rows(page).filter({ hasText: '/transfers/' }).first().locator('[data-row-link]').click(ROW_HIT);
    await page.getByRole('tab', { name: /^Записи/ }).click();
    await expect(page.locator('li[data-record-id]').first()).toBeVisible();
    expect(await uuidTitles(page)).toEqual([]);
    // Отправка — именем системы, без хоста и порта.
    await expect(page.locator('li[data-kind=send]').getByTestId('record-title')).toHaveText('esb · POST /soap-proxy/FeeService');
  });
});

test.describe('панель шага: сворачивание и ширина', () => {
  const details = (page: Page) => page.getByTestId('step-details');
  const handle = (page: Page) => page.getByTestId('panel-handle');
  const width = async (page: Page) => (await details(page).boundingBox())!.width;
  const canvasWidth = async (page: Page) => (await page.getByTestId('flow-canvas').boundingBox())!.width;
  const zoom = (page: Page) => page.getByTestId('flow-canvas').getAttribute('data-zoom');
  const saved = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('threadline.stepPanel') ?? 'null') as { width: number; collapsed: boolean } | null);
  const open = async (page: Page, w: number, h = 900) => {
    await page.setViewportSize({ width: w, height: h });
    await search(page, 'getCard');
    await openFirst(page, 'error');
    await expect(page.getByTestId('flow-canvas')).toBeVisible({ timeout: 15_000 });
  };
  const dragHandle = async (page: Page, x: number) => {
    const b = (await handle(page).boundingBox())!;
    await page.mouse.move(b.x + b.width / 2, b.y + 100);
    await page.mouse.down();
    await page.mouse.move(x, b.y + 100);
    await expect(page.getByTestId('panel-guide')).toBeVisible();
    await page.mouse.up();
    await expect(page.getByTestId('panel-guide')).toHaveCount(0);
  };

  test('свернуть, вернуть кнопкой и нажатием на узел; граф на всю ширину; состояние запоминается', async ({ page }) => {
    await open(page, 1440);
    const before = await canvasWidth(page);
    const panel = await width(page);
    await page.getByTestId('panel-collapse').click();
    await expect(details(page)).toBeHidden();
    await expect(page.getByTestId('panel-open')).toBeFocused();
    // Граф забирает всё место панели.
    await expect.poll(() => canvasWidth(page)).toBeGreaterThanOrEqual(before + panel - 1);
    expect((await saved(page))?.collapsed).toBe(true);
    await page.reload();
    await expect(page.getByTestId('request-header')).toBeVisible();
    await expect(page.getByTestId('panel-open')).toBeVisible();
    await expect(details(page)).toBeHidden();
    await page.getByTestId('panel-open').click();
    await expect(details(page)).toBeVisible();
    await expect(details(page)).toBeFocused();
    await page.getByTestId('panel-collapse').click();
    await scheme(page).locator('button[data-node]').first().click();
    await expect(details(page)).toBeVisible();
    expect((await saved(page))?.collapsed).toBe(false);
  });

  test('перетаскивание: при движении ширина та же, при отпускании новая; 380 и половина окна; двойное нажатие — 400', async ({ page }) => {
    await open(page, 1440);
    const b = (await handle(page).boundingBox())!;
    await page.mouse.move(b.x + 4, b.y + 100);
    await page.mouse.down();
    await page.mouse.move(b.x - 100, b.y + 100);
    expect(await width(page)).toBe(400);
    await page.mouse.up();
    await expect.poll(() => width(page)).toBeCloseTo(504, -1);
    await dragHandle(page, 1400);
    await expect.poll(() => width(page)).toBe(380);
    await dragHandle(page, 10);
    await expect.poll(() => width(page)).toBe(720);
    expect((await saved(page))?.width).toBe(720);
    await handle(page).dblclick();
    await expect.poll(() => width(page)).toBe(400);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });

  test('клавиатура: разделитель, стрелки, Home и End', async ({ page }) => {
    await open(page, 1440);
    const sep = page.getByRole('separator', { name: /Ширина панели шага/ });
    await expect(sep).toHaveAttribute('aria-valuenow', '400');
    await expect(sep).toHaveAttribute('aria-valuemin', '380');
    await expect(sep).toHaveAttribute('aria-valuemax', '720');
    await sep.focus();
    await page.keyboard.press('ArrowLeft');
    await expect(sep).toHaveAttribute('aria-valuenow', '416');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(sep).toHaveAttribute('aria-valuenow', '384');
    await page.keyboard.press('Home');
    await expect.poll(() => width(page)).toBe(380);
    await page.keyboard.press('End');
    await expect.poll(() => width(page)).toBe(720);
  });

  test('сужение окна: панель не шире половины, память не меняется; широкое окно возвращает ширину', async ({ page }) => {
    await open(page, 1920);
    await dragHandle(page, 10);
    await expect.poll(() => width(page)).toBe(960);
    await page.setViewportSize({ width: 1400, height: 900 });
    await expect.poll(() => width(page)).toBe(700);
    expect((await saved(page))?.width).toBe(960);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await page.setViewportSize({ width: 1920, height: 900 });
    await expect.poll(() => width(page)).toBe(960);
  });

  test('компактная раскладка: панель под графом, кнопок и разделителя нет, свёрнутая панель видна', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('threadline.stepPanel', JSON.stringify({ width: 700, collapsed: true })));
    await open(page, 1100);
    await expect(details(page)).toBeVisible();
    await expect(handle(page)).toBeHidden();
    await expect(page.getByTestId('panel-collapse')).toBeHidden();
    await expect(page.getByTestId('panel-open')).toBeHidden();
    const [s, d] = await Promise.all([scheme(page).boundingBox(), details(page).boundingBox()]);
    expect(d!.y).toBeGreaterThan(s!.y + s!.height - 1);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });

  test('граф вписывается заново, пока человек его не двигал; потом его вид остаётся', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    // Самая широкая панель: узкому холсту график вписывается мельче.
    await page.addInitScript(() => localStorage.setItem('threadline.stepPanel', JSON.stringify({ width: 640, collapsed: false })));
    await search(page, 'getCard');
    await openFirst(page, 'error');
    const narrow = await zoom(page);
    await page.getByTestId('panel-collapse').click();
    await expect.poll(() => canvasWidth(page)).toBeGreaterThan(1100);
    await expect.poll(() => zoom(page)).not.toBe(narrow);
    const wide = await zoom(page);
    await page.getByTestId('panel-open').click();
    await expect.poll(() => canvasWidth(page)).toBeLessThan(700);
    await expect.poll(() => zoom(page)).toBe(narrow);
    await page.getByTestId('flow-zoom-in').click();
    const mine = await zoom(page);
    expect(mine).not.toBe(narrow);
    await page.getByTestId('panel-collapse').click();
    await expect.poll(() => canvasWidth(page)).toBeGreaterThan(1100);
    expect(await zoom(page)).toBe(mine);
    expect(mine).not.toBe(wide);
    await page.getByTestId('panel-open').click();
    await expect.poll(() => canvasWidth(page)).toBeLessThan(700);
    expect(await zoom(page)).toBe(mine);
  });

  test('самая узкая панель: «Скопировать как cURL» своей строкой с подписью, внутри панели, с подсказкой', async ({ page }) => {
    await open(page, 1440);
    const curl = page.getByTestId('copy-curl');
    await expect(curl).toBeVisible();
    await page.getByRole('separator', { name: /Ширина панели шага/ }).focus();
    await page.keyboard.press('Home');
    await expect.poll(() => width(page)).toBe(380);
    // Вкладок в панели нет: кнопке не с кем делить строку, подпись не уходит в значок.
    await expect(curl).toHaveText('Скопировать как cURL');
    await expect(curl).not.toHaveAttribute('data-icon-only', 'true');
    const [c, p] = await Promise.all([curl.boundingBox(), details(page).boundingBox()]);
    expect(c!.x).toBeGreaterThanOrEqual(p!.x);
    expect(c!.x + c!.width).toBeLessThanOrEqual(p!.x + p!.width);
    await curl.hover();
    await expect(page.getByRole('tooltip').first()).toContainText('как на экране');
  });

  test('длинное имя класса в заголовке шага переносится по «\\», а не посреди слова', async ({ page }) => {
    const long = 'App\\Services\\Payments\\Processing\\CardPaymentProcessorService';
    await page.route('**/api/searches/*/requests/*', async (route) => {
      if (route.request().url().includes('/reveal')) return route.continue();
      const res = await route.fetch();
      const body = (await res.json()) as { records: { kind: string; title: string }[] };
      for (const r of body.records) if (r.kind === 'call') r.title = long;
      await route.fulfill({ response: res, json: body });
    });
    await page.addInitScript(() => localStorage.setItem('threadline.stepPanel', JSON.stringify({ width: 380, collapsed: false })));
    await open(page, 1280);
    const title = details(page).getByTestId('step-title');
    await expect(title).toHaveText(long);
    const pieces = await title.evaluate((el) =>
      [...el.childNodes]
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => {
          const r = document.createRange();
          r.selectNodeContents(n);
          return { text: n.textContent, lines: new Set([...r.getClientRects()].map((c) => Math.round(c.top))).size };
        }),
    );
    expect(pieces.map((p) => p.text).join('')).toBe(long);
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) expect(piece.lines, piece.text ?? '').toBe(1);
  });

  for (const language of ['ru', 'en']) {
    test(`380 px, ${language}: строки панели помещаются на всех шагах, тело ответа открывается в окне`, async ({ page }) => {
      await open(page, 1280);
      await page.evaluate((lang) => {
        localStorage.setItem('threadline.language', lang);
        localStorage.setItem('threadline.stepPanel', JSON.stringify({ width: 380, collapsed: false }));
      }, language);
      await page.reload();
      await expect(details(page)).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId('flow-canvas')).toBeVisible({ timeout: 15_000 });
      expect(await width(page)).toBe(380);
      for (const node of await graphNodes(page).all()) {
        await node.click();
        const panel = (await details(page).boundingBox())!;
        // Строка о шаге, сводка, строки данных и cURL не заходят за правый край панели.
        for (const part of await details(page).locator('[data-testid=step-meta], [data-testid=step-facts], [data-testid=data-row], [data-testid=step-curl]').all()) {
          const b = (await part.boundingBox())!;
          expect(b.x + b.width).toBeLessThanOrEqual(panel.x + panel.width + 0.5);
        }
        // Строка данных — подпись и выдержка, не больше двух строк: длинное обрезается, а не переносится.
        for (const row of await details(page).getByTestId('data-row').all()) expect((await row.boundingBox())!.height).toBeLessThanOrEqual(60);
      }
      // Итог не сжат до буквы; тело ответа в окне, кода в нём не меньше пяти строк.
      await page.locator('[data-tone=error]').first().click();
      const error = details(page).getByTestId('step-error');
      await expect(error).toBeVisible();
      expect((await error.boundingBox())!.width).toBeGreaterThan(60);
      // Строка находится по виду данных, а не по подписи: подписи на языке страницы.
      await dataRow(page, 'Ответ').click();
      await expect(viewer(page)).toHaveAttribute('data-item', 'response');
      expect((await viewerCode(page).locator('pre').boundingBox())!.height).toBeGreaterThanOrEqual(5 * 19);
      await closeViewer(page);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
    });
  }
});
