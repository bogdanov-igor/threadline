import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { MOCK_FLOW } from '../../server/src/backends/mock/dataset-pay.ts';
import { closeViewer, dataRow, openData, viewer, viewerCode, viewerTab } from './helpers.ts';

// Нажатие у левого края строки: в середине строки может оказаться метка параметра, она копирует, а не открывает.
const ROW_HIT = { position: { x: 8, y: 8 } };

// Трасса запроса на демо-среде: граф на вкладке «Схема», шкала времени, сводка шага, окно тела, подсветка и вид «как в логе».
// Окно тела модальное: страница под ним скрыта от чтения с экрана, поэтому граф и вкладки страницы ищутся по ролям только при закрытом окне.

const rows = (page: Page) => page.getByRole('list', { name: 'Найденные запросы' }).getByRole('listitem');
const scheme = (page: Page) => page.getByRole('group', { name: 'Схема запроса' });
const timeline = (page: Page) => page.getByRole('listbox', { name: 'Шаги трассы' });
const details = (page: Page) => page.getByTestId('step-details');
const viewTab = (page: Page, name: 'Схема' | 'Шкала времени' | 'Записи') => page.getByRole('tab', { name: new RegExp(`^${name}`) });
const nodes = (page: Page) => scheme(page).locator('button[data-node]');
const node = (page: Page, kind: string) => scheme(page).locator(`button[data-node][data-kind=${kind}]`);
const pressed = (page: Page) => scheme(page).locator('button[data-node][aria-pressed=true]');
const appLogs = (page: Page) => page.getByTestId('app-logs');

/** Ищет за 24 часа и открывает первый запрос с нужным статусом. */
async function openRequest(page: Page, term: string, status?: 'error' | 'success') {
  await page.goto('/pay/demo');
  const input = page.getByRole('textbox', { name: 'Значения для поиска' });
  await input.fill(term);
  await input.press('Enter');
  await page.getByRole('group', { name: 'Период' }).getByRole('button', { name: '24 ч', exact: true }).click();
  await page.getByRole('button', { name: 'Найти', exact: true }).click();
  await expect(page.getByTestId('search-results')).toHaveAttribute('data-status', 'done', { timeout: 20_000 });
  const row = status ? rows(page).and(page.locator(`[data-status=${status}]`)).first() : rows(page).first();
  await row.locator('[data-row-link]').click(ROW_HIT);
  await expect(page.getByTestId('request-header')).toBeVisible();
  // Граф грузится лениво.
  await expect(page.getByTestId('flow-canvas')).toBeVisible({ timeout: 15_000 });
}

/**
 * Источник причины у системы, которой нет в справочнике: без справочника — «внешняя система», со справочником —
 * «неизвестно». Набор e2e не называет процессинг и проверку мошенничества.
 */
async function foreignSource(page: Page): Promise<{ source: 'external' | 'unknown'; label: string }> {
  const state = ((await (await page.request.get('/api/catalog')).json()) as { state?: string }).state;
  return state === 'ok' ? { source: 'unknown', label: 'Система не описана' } : { source: 'external', label: 'Ошибка внешней системы' };
}

const openProcessorError = (page: Page) => openRequest(page, 'getCard', 'error');
const openSwitch = (page: Page) => openRequest(page, 'switch.pay.example', 'success');

test.describe('трасса: схема и подробности', () => {
  test('ошибка процессинга: схема по умолчанию, выбран обмен с ошибкой, сводка шага в панели, в окне тела подсвеченный XML', async ({ page }) => {
    await openProcessorError(page);
    await expect(viewTab(page, 'Схема')).toHaveAttribute('aria-selected', 'true');

    // Вход → два обмена с процессингом, второй красный и выбран.
    await expect(node(page, 'entry').getByTestId('node-method')).toContainText('POST /v1/cards/lookup');
    const calls = scheme(page).locator('button[data-node]:not([data-kind=entry])');
    await expect(calls).toHaveCount(2);
    await expect(calls.nth(0)).toHaveAttribute('data-tone', 'success');
    await expect(calls.nth(1)).toHaveAttribute('data-tone', 'error');
    // Узел назван системой, строка метода — операцией; строка итога — код и текст ошибки.
    await expect(calls.nth(1).getByTestId('node-name')).toHaveText('processor');
    await expect(calls.nth(1).getByTestId('node-method')).toContainText('getCard');
    await expect(calls.nth(1).getByTestId('node-outcome')).toContainText('Card not found');
    // HTTP 200 у обмена без ошибки — не красный.
    await expect(calls.nth(0).getByTestId('node-outcome')).toHaveText('Успешно · HTTP 200');
    await expect(calls.nth(0).getByTestId('node-duration')).toHaveText(/^\d+ мс$/);
    expect(await calls.nth(0).getByTestId('node-outcome').evaluate((el) => getComputedStyle(el).color)).not.toBe('rgb(180, 35, 24)');
    await expect(calls.nth(1)).toHaveAttribute('aria-pressed', 'true');
    await expect(pressed(page)).toHaveCount(1);

    // Причина: чья ошибка, смысл вперёд, система и операция вместо адреса с портом.
    const reasons = page.getByTestId('request-reasons');
    const foreign = await foreignSource(page);
    await expect(reasons.locator(`[data-source=${foreign.source}]`)).toContainText(foreign.label);
    await expect(reasons).toContainText('Card not found · processor · getCard · PRC-ERR-0027 · код 8');
    await expect(reasons).not.toContainText('pay.example');

    // Над трассой: цепочка именами систем, всего и время во внешних системах.
    await expect(page.getByTestId('request-chain')).toHaveText('cards → processor');
    await expect(page.getByTestId('request-total')).toHaveText(/^\d+ мс$/);
    await expect(page.getByTestId('request-external')).toHaveText(/^\d+ мс$/);

    // Панель — сводка шага: имя, итог, коды, адрес без схемы и начало.
    await expect(details(page).getByTestId('step-title')).toHaveText('getCard');
    await expect(details(page).getByTestId('step-subtitle')).toHaveText('POST /soap/issuing');
    await expect(details(page).getByTestId('step-error')).toHaveText('Card not found');
    await expect(details(page).getByTestId('step-codes')).toHaveText('PRC-ERR-0027 · код 8');
    await expect(details(page).getByTestId('step-outcome')).toContainText('200');
    await expect(details(page).getByTestId('step-duration')).toHaveText(/^\d+ мс$/);
    const address = details(page).getByTestId('step-address');
    await expect(address).toHaveText('POST processor.pay.example:8443/soap/issuing');
    await expect(address).toHaveAttribute('title', 'POST https://processor.pay.example:8443/soap/issuing');
    await expect(details(page).getByTestId('step-start')).toHaveText(/ · \+.+ от начала$/);
    // Данные шага строками: у заголовков своя строка, адрес — в сводке.
    for (const name of ['Запрос', 'Ответ', 'Заголовки', 'Сырые записи'] as const) await expect(dataRow(page, name)).toBeVisible();
    // В строке «Ответ» — строка причины одной строкой и её номер.
    const excerpt = dataRow(page, 'Ответ').getByTestId('data-excerpt');
    await expect(excerpt).toContainText('<response_code>8</response_code>');

    // Строка «Ответ» открывает окно тела: XML с отступами и подсветкой.
    await openData(page, 'Ответ');
    await expect(viewer(page).getByTestId('viewer-title')).toHaveText('getCard');
    const code = viewerCode(page);
    await expect(code).toHaveAttribute('data-block', 'response');
    const pre = code.locator('pre');
    await expect(pre).toContainText('<response_code>8</response_code>');
    await expect(code.locator('[data-token=tag]', { hasText: /^response_code$/ }).first()).toBeVisible();
    const tagColor = await code.locator('[data-token=tag]').first().evaluate((el) => getComputedStyle(el).color);
    const textColor = await pre.evaluate((el) => getComputedStyle(el).color);
    expect(tagColor).not.toBe(textColor);
    // Строка причины подсвечена и видна внутри кода; её номер тот же, что в строке панели.
    const line = pre.locator('[data-reason]');
    await expect(line).toContainText('response_code');
    await expect(excerpt).toContainText(`строка ${await line.getAttribute('data-n')}`);
    const [preBox, lineBox] = await Promise.all([pre.boundingBox(), line.boundingBox()]);
    expect(lineBox!.y).toBeGreaterThanOrEqual(preBox!.y);
    expect(lineBox!.y + lineBox!.height).toBeLessThanOrEqual(preBox!.y + preBox!.height);
  });

  test('запрос через шлюз: цепочка «шлюз → api → коммутатор», вход через шлюз, обмен со статусом и длительностью', async ({ page }) => {
    await openSwitch(page);
    await expect(page.getByTestId('request-chain')).toHaveText('шлюз → api → switch');
    const entry = node(page, 'entry');
    await expect(entry).toContainText('через шлюз');
    // Путь читаемым шаблоном: uuid — подстановками.
    await expect(entry.getByTestId('node-method')).toContainText('GET /v1/users/{user}/cards/{card}');
    // Ошибок нет — выбран вход.
    await expect(entry).toHaveAttribute('aria-pressed', 'true');
    const sw = node(page, 'exchange').first();
    await expect(sw).toHaveAttribute('data-tone', 'success');
    await expect(sw.getByTestId('node-name')).toHaveText('switch');
    await expect(sw.getByTestId('node-outcome')).toHaveText('Успешно · HTTP 200');
    await expect(sw.getByTestId('node-duration')).toHaveText(/^\d+ мс$/);
    await expect(sw.getByTestId('node-method')).toHaveText('POST /v3/cards/info');

    // Обмен: в окне тела «Ответ» — JSON с подсветкой ключей, строк и чисел, «Запрос» — тело запроса.
    await sw.click();
    await expect(details(page).getByTestId('step-title')).toHaveText('POST /v3/cards/info');
    await openData(page, 'Ответ');
    await expect(viewerCode(page)).toHaveAttribute('data-block', 'response');
    for (const token of ['key', 'string', 'number']) await expect(viewerCode(page).locator(`[data-token=${token}]`).first()).toBeVisible();
    await viewerTab(page, 'Запрос').click();
    await expect(viewerCode(page)).toHaveAttribute('data-block', 'body');
    await expect(viewerCode(page).locator('pre')).toContainText('"params"');
    await closeViewer(page);

    // Шкала: вход — полоса во всю шкалу, обмен с длительностью; выбор общий со схемой.
    await viewTab(page, 'Шкала времени').click();
    const options = timeline(page).getByRole('option');
    await expect(options.first()).toHaveAttribute('data-kind', 'incoming');
    const bar = options.first().getByTestId('step-bar');
    expect(await bar.evaluate((el) => [el.style.left, el.style.width])).toEqual(['0%', 'max(100%, 3px)']);
    const exchange = timeline(page).locator('[data-kind=exchange]');
    await expect(exchange).toHaveAttribute('aria-selected', 'true');
    await expect(exchange.getByTestId('step-label')).toHaveText(/^\d+ мс$/);
    await expect(exchange.getByTestId('step-row-title')).toHaveText('switch · POST /v3/cards/info');
  });

  test('окно тела, «как в логе»: тело одной строкой, «Копировать» копирует этот вид, вид общий для вкладок окна', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openSwitch(page);
    await node(page, 'exchange').first().click();
    const box = await openData(page, 'Ответ');
    const code = viewerCode(page);
    const pre = code.locator('pre');
    const pretty = (await pre.textContent())!;
    expect(pretty.split('\n').length).toBeGreaterThan(10);

    await box.getByRole('group', { name: 'Вид' }).getByRole('button', { name: 'Как в логе' }).click();
    await expect(code).toHaveAttribute('data-mode', 'raw');
    const raw = (await pre.textContent())!;
    expect(raw).not.toContain('\n');
    expect(raw.startsWith('{"id":')).toBe(true);
    await expect(code.locator('[data-token=key]').first()).toBeVisible();
    await box.getByRole('button', { name: /^Копировать/ }).click();
    await expect(box.getByRole('button', { name: /^Скопировано/ })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(raw);

    // На вкладке «Запрос» тот же вид.
    await viewerTab(page, 'Запрос').click();
    await expect(code).toHaveAttribute('data-block', 'body');
    await expect(code).toHaveAttribute('data-mode', 'raw');
    await box.getByRole('button', { name: 'Форматировано' }).click();
    await viewerTab(page, 'Ответ').click();
    await expect(code).toHaveAttribute('data-block', 'response');
    await expect(code).toHaveAttribute('data-mode', 'pretty');
    expect(await pre.textContent()).toBe(pretty);
  });

  test('схема: стрелки и Home переключают узлы, сводка логов приложения показывает логи', async ({ page }) => {
    await openSwitch(page);
    const entry = node(page, 'entry');
    const sw = node(page, 'exchange').first();
    await entry.focus();
    // End — к последнему узлу, Home — к первому; выбор идёт за фокусом.
    await page.keyboard.press('End');
    const last = nodes(page).last();
    await expect(last).toBeFocused();
    await expect(last).toHaveAttribute('aria-pressed', 'true');
    await sw.focus();
    await sw.press('Enter');
    await expect(details(page)).toBeFocused();
    await expect(details(page).getByTestId('step-title')).toHaveText('POST /v3/cards/info');
    await sw.focus();
    await page.keyboard.press('Home');
    await expect(entry).toBeFocused();
    await expect(entry).toHaveAttribute('aria-pressed', 'true');
    await expect(details(page).getByTestId('step-title')).toHaveText(/^GET \/v1\/users\//);
    // db query — свой узел графа; логи приложения — сводкой над графом.
    await expect(node(page, 'db')).toContainText('db query');
    await appLogs(page).click();
    await expect(appLogs(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(pressed(page)).toHaveCount(0);
    await expect(details(page).getByRole('list', { name: 'Логи приложения' })).toBeVisible();
  });
});

test.describe('панель шага', () => {
  for (const [width, height] of [[1440, 785], [1536, 730], [1280, 720]] as const) {
    test(`${width}×${height}: строка причины видна в панели шириной 400 и в окне тела, страница целиком не прокручивается`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await openProcessorError(page);
      // В панели строка причины — в строке «Ответ», видна без прокрутки.
      const excerpt = dataRow(page, 'Ответ').getByTestId('data-excerpt');
      await expect(excerpt).toContainText('response_code');
      await expect(excerpt).toBeInViewport({ ratio: 1 });
      const [panel, row] = await Promise.all([details(page).boundingBox(), excerpt.boundingBox()]);
      expect(row!.y + row!.height).toBeLessThanOrEqual(panel!.y + panel!.height);
      expect(panel!.width).toBe(400);
      expect(await page.evaluate(() => document.documentElement.scrollHeight - document.documentElement.clientHeight)).toBeLessThanOrEqual(0);
      // В окне тела код не меньше пяти строк, строка причины внутри кода и на экране.
      await openData(page, 'Ответ');
      const pre = viewerCode(page).locator('pre');
      await expect(pre.locator('[data-reason]')).toContainText('response_code');
      const [code, line] = await Promise.all([pre.boundingBox(), pre.locator('[data-reason]').boundingBox()]);
      expect(code!.height).toBeGreaterThanOrEqual(5 * 19);
      expect(line!.y).toBeGreaterThanOrEqual(code!.y);
      expect(line!.y + line!.height).toBeLessThanOrEqual(Math.min(code!.y + code!.height, height));
    });
  }

  test('низкое окно: панель прокручивается, логи шага внизу достижимы', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 700 });
    await openRequest(page, 'fraud.pay.example');
    await expect(details(page).getByTestId('step-logs')).toBeVisible();
    await details(page).getByTestId('step-logs').getByRole('button', { name: /Логи шага/ }).click();
    await expect(details(page).getByTestId('step-logs').getByRole('list')).toBeVisible();
    await details(page).getByTestId('step-logs').locator('li').last().scrollIntoViewIfNeeded();
    await expect(details(page).getByTestId('step-logs').locator('li').last()).toBeInViewport();
  });

  test('длинная причина: длительность и кнопки в панели, метка обрезана, полный текст в подсказке', async ({ page }) => {
    const long = `Очень длинная причина ошибки ${'которая не помещается в строку панели шага '.repeat(6)}`;
    await page.route('**/api/searches/*/requests/*', async (route) => {
      if (route.request().url().includes('/reveal')) return route.continue();
      const res = await route.fetch();
      const body = (await res.json()) as { records: { kind: string; isError: boolean; sections: { body: string | null } }[] };
      for (const r of body.records) if (r.kind === 'response' && r.isError) r.sections.body = JSON.stringify({ error: { code: 'E1', message: long } });
      return route.fulfill({ response: res, json: body });
    });
    await openProcessorError(page);
    const panel = (await details(page).boundingBox())!;
    const outcome = details(page).getByTestId('step-outcome');
    await expect(outcome.locator('[title]').first()).toHaveAttribute('title', new RegExp('Очень длинная причина'));
    const duration = (await details(page).getByTestId('step-duration').boundingBox())!;
    expect(duration.x + duration.width).toBeLessThanOrEqual(panel.x + panel.width);
    await expect(details(page).getByTestId('step-error').evaluate((el) => el.scrollWidth > el.clientWidth)).resolves.toBe(true);
    expect(await details(page).evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
    // Кнопка справочника есть, пока справочник включён: она целиком в панели и при длинной причине.
    const state = ((await (await page.request.get('/api/catalog')).json()) as { state?: string }).state;
    if (state !== 'ok') return;
    const inPanel = async () => {
      const add = details(page).getByTestId('step-catalog-add').or(details(page).getByTestId('step-catalog-edit')).first();
      await expect(add).toBeVisible();
      const [box, card] = await Promise.all([add.boundingBox(), details(page).boundingBox()]);
      expect(box!.x + box!.width).toBeLessThanOrEqual(card!.x + card!.width);
      return add;
    };
    await inPanel();
  });
});

test.describe('трасса: шкала времени', () => {
  test('↑/↓ переключают шаг, Home — к началу, Enter — к подробностям', async ({ page }) => {
    await openProcessorError(page);
    await viewTab(page, 'Шкала времени').click();
    const options = timeline(page).getByRole('option');
    const selected = timeline(page).locator('[aria-selected=true]');
    await expect(selected).toHaveAttribute('data-error', 'true');
    const count = await options.count();
    const errorIndex = await options.evaluateAll((els) => els.findIndex((el) => el.getAttribute('aria-selected') === 'true'));
    await selected.focus();

    await page.keyboard.press('ArrowUp');
    await expect(options.nth(errorIndex - 1)).toBeFocused();
    await expect(options.nth(errorIndex - 1)).toHaveAttribute('aria-selected', 'true');
    await expect(details(page).getByTestId('step-title')).toHaveText('getCard');
    await page.keyboard.press('ArrowDown');
    await expect(options.nth(errorIndex)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Home');
    await expect(options.first()).toBeFocused();
    await expect(details(page).getByTestId('step-title')).toHaveText('POST /v1/cards/lookup');
    await page.keyboard.press('End');
    await expect(options.nth(count - 1)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(details(page)).toBeFocused();

    // Вызов вложен во вход, обмен — в вызов.
    const depths = await options.evaluateAll((els) => els.map((el) => `${el.getAttribute('data-kind')}:${parseInt((el.firstElementChild as HTMLElement).style.paddingLeft, 10)}`));
    expect(depths.slice(0, 3)).toEqual(['incoming:12', 'call:26', 'exchange:40']);
  });

  test('Проверка мошенничества не ответила: штрихованная полоса до конца и «ответ в логах не найден»', async ({ page }) => {
    await openRequest(page, 'fraud.pay.example');
    // Один обмен с проверкой мошенничества; запись cURL ERROR — лог на узле обмена, а не второй обмен.
    const fraud = node(page, 'exchange');
    await expect(fraud).toHaveCount(1);
    await expect(fraud.getByTestId('node-method')).toHaveText('POST /');
    await expect(fraud.getByTestId('node-outcome')).toHaveText('ответ в логах не найден');
    await expect(fraud).toHaveAttribute('data-tone', 'error');
    await expect(scheme(page).getByTestId('node-badge')).toHaveAttribute('data-level', 'error');
    await expect(appLogs(page)).toContainText('1 WARNING');
    await expect(appLogs(page)).toContainText('1 ERROR');
    // Выбран обмен без ответа, запись cURL — в его логах: первая причина и панель шага об одном и том же.
    await expect(fraud).toHaveAttribute('aria-pressed', 'true');
    await expect(details(page).getByTestId('step-title')).toHaveText('POST /');
    await expect(details(page).getByTestId('step-logs')).toContainText('cURL error 28');
    const foreign = await foreignSource(page);
    await expect(page.getByTestId('request-reasons').locator(`[data-source=${foreign.source}]`).filter({ hasText: 'Ответ не найден' })).toHaveCount(1);
    // Ошибка в логах приложения — проекта; со справочником без правила для неё источник «неизвестно».
    const own = foreign.source === 'unknown' ? { source: 'unknown', label: 'Demo Pay' } : { source: 'project', label: 'Ошибка Demo Pay' };
    await expect(page.getByTestId('request-reasons').locator(`[data-source=${own.source}]`).filter({ hasText: 'CURL error 28' })).toContainText(own.label);

    // «Нет ответа» — ошибка: метка в подробностях красная, как штриховка и причины.
    await fraud.click();
    const noResponse = details(page).getByText('ответ в логах не найден', { exact: true });
    expect(await noResponse.evaluate((el) => getComputedStyle(el).color)).toBe('rgb(180, 35, 24)');

    await viewTab(page, 'Шкала времени').click();
    const rows = timeline(page).locator('[data-no-response]');
    await expect(rows).toHaveCount(1);
    const row = rows.first();
    await expect(row.getByTestId('step-label')).toHaveText('ответ в логах не найден');
    const bar = row.getByTestId('step-bar');
    expect(await bar.evaluate((el) => el.style.backgroundImage)).toContain('repeating-linear-gradient');
    const [left, width] = await bar.evaluate((el) => [parseFloat(el.style.left), parseFloat(el.style.width.replace('max(', ''))]);
    expect(left! + width!).toBeCloseTo(100, 1);

    // В «Записях» та же метка тоже красная.
    await viewTab(page, 'Записи').click();
    const send = page.locator('li[data-kind=send]').filter({ hasText: 'ответ в логах не найден' });
    await expect(send).toHaveCount(1);
    expect(await send.getByText('ответ в логах не найден', { exact: true }).evaluate((el) => getComputedStyle(el).color)).toBe('rgb(180, 35, 24)');
  });

  test('узкая панель подробностей: заголовок блока виден целиком, кнопки прижаты вправо', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openRequest(page, 'fraud.pay.example');
    await appLogs(page).click();
    await viewTab(page, 'Шкала времени').click();
    // На ширине от 1280px панель справа от шкалы. Строки логов свёрнуты до нажатия.
    await details(page).locator('li[data-error] > div > button[aria-expanded]').first().click();
    const block = details(page).locator('li[data-error] [data-block=context]').first();
    await expect(block).toBeVisible();
    const title = block.locator('button[aria-expanded] > span.truncate');
    await expect(title).toHaveText('Остальной контекст');
    const [scroll, client] = await title.evaluate((el) => [el.scrollWidth, el.clientWidth]);
    expect(scroll).toBeLessThanOrEqual(client);
    // Кнопки одной группой прижаты вправо.
    const controls = block.getByTestId('code-controls');
    const [titleBox, controlsBox, blockBox] = await Promise.all([title.boundingBox(), controls.boundingBox(), block.boundingBox()]);
    expect(blockBox!.x + blockBox!.width - (controlsBox!.x + controlsBox!.width)).toBeLessThan(8);
    expect(titleBox!.width).toBeGreaterThan(100);
  });
});

test.describe('трасса: записи и раскладка', () => {
  test('вкладка «Записи»: все записи по порядку со смещениями', async ({ page }) => {
    await openSwitch(page);
    await viewTab(page, 'Записи').click();
    const records = page.getByRole('list', { name: 'Записи запроса' }).locator('li[data-record-id]');
    await expect(records).toHaveCount(4);
    expect(await records.evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.kind))).toEqual(['incoming', 'log', 'send', 'response']);
    await expect(records.first().getByTestId('record-offset')).toHaveText('+0 мс');
    // Тела в записях — с той же подсветкой и переключателем вида.
    const response = records.nth(3);
    await response.locator('button[aria-expanded]').first().click();
    await expect(response.locator('[data-block=response] [data-token=key]').first()).toBeVisible();
    await expect(response.locator('[data-block=response]').getByRole('button', { name: 'Как в логе' })).toBeVisible();
    // Раскрытое остаётся раскрытым после возврата со схемы.
    await viewTab(page, 'Схема').click();
    await viewTab(page, 'Записи').click();
    await expect(response.locator('[data-block=response] pre')).toBeVisible();
  });

  test('768px: схема, шкала и записи без горизонтальной прокрутки страницы', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await openProcessorError(page);
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    // Граф слева направо: обмены правее входа.
    const entryBox = (await node(page, 'entry').boundingBox())!;
    const firstCall = (await scheme(page).locator('button[data-node]:not([data-kind=entry])').first().boundingBox())!;
    expect(firstCall.x).toBeGreaterThan(entryBox.x + entryBox.width);
    expect(await overflow()).toBeLessThanOrEqual(0);
    await viewTab(page, 'Шкала времени').click();
    await expect(timeline(page)).toBeVisible();
    expect(await overflow()).toBeLessThanOrEqual(0);
    await viewTab(page, 'Записи').click();
    await page.locator('li[data-record-id] > div > button[aria-expanded=false]').first().click();
    expect(await overflow()).toBeLessThanOrEqual(0);
  });

  for (const colorScheme of ['light', 'dark'] as const) {
    test(`доступность и контраст схемы, шкалы, подробностей и окна тела, ${colorScheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme });
      await openProcessorError(page);
      // Окно тела проверяется само: страница под модальным окном скрыта от чтения с экрана.
      const check = async (where: string, only?: string) => {
        const axe = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']);
        const r = await (only ? axe.include(only) : axe).analyze();
        expect(r.violations.map((v) => `${where}: ${v.id} ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
      };
      await check('scheme');
      const box = await openData(page, 'Ответ');
      await box.getByRole('button', { name: 'Как в логе' }).click();
      await expect(viewerCode(page)).toHaveAttribute('data-mode', 'raw');
      await check('viewer raw', '[data-testid=body-viewer]');
      await closeViewer(page);
      await viewTab(page, 'Шкала времени').click();
      await check('timeline');
      await viewTab(page, 'Записи').click();
      await check('records');
    });
  }
});

test.describe('подсветка найденного значения', () => {
  const marks = (area: Locator) => area.locator('mark.search-hit');
  const records = (page: Page) => page.getByRole('list', { name: 'Записи запроса' }).locator('li[data-record-id]');
  const expand = (record: Locator) => record.locator('button[aria-expanded]').first().click();
  const summary = (page: Page) => page.getByTestId('hit-summary');
  const toFirst = (page: Page) => summary(page).getByRole('button', { name: 'К первому' });
  const noScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

  async function find(page: Page, terms: string[]) {
    await page.goto('/pay/demo');
    const input = page.getByRole('textbox', { name: 'Значения для поиска' });
    for (const term of terms) {
      await input.fill(term);
      await input.press('Enter');
    }
    await page.getByRole('group', { name: 'Период' }).getByRole('button', { name: '24 ч', exact: true }).click();
    await page.getByRole('button', { name: 'Найти', exact: true }).click();
    await expect(page.getByTestId('search-results')).toHaveAttribute('data-status', 'done', { timeout: 20_000 });
  }
  async function open(page: Page, row: Locator) {
    await row.locator('[data-row-link]').click(ROW_HIT);
    await expect(page.getByTestId('request-header')).toBeVisible();
  }

  type Detail = { records: { id: string; kind: string; raw: string; http: { uri: string | null } | null; sections: { body: string | null } }[] };
  /** Страница запроса получает записи с правками: синтетические длинные тела и значения, которых нет в имитации. */
  const rewriteDetail = (page: Page, edit: (d: Detail) => void) =>
    page.route('**/api/searches/*/requests/*', async (route) => {
      if (route.request().url().includes('/reveal')) return route.continue();
      const res = await route.fetch();
      const body = (await res.json()) as Detail;
      edit(body);
      return route.fulfill({ response: res, json: body });
    });
  /** Длинное тело с совпадением в самом конце: первая отправка запроса. */
  const longBody = (size: number, term: string) => (d: Detail) => {
    const send = d.records.find((r) => r.kind === 'send')!;
    send.sections.body = `${'строка лога без значения\n'.repeat(Math.ceil(size / 44))}${term}\n`;
  };

  /** Первая отправка, раскрытая на вкладке «Записи». */
  async function openSend(page: Page) {
    await viewTab(page, 'Записи').click();
    const send = page.locator('li[data-kind=send]').first();
    await expand(send);
    return send;
  }

  test('тело, заголовки, сырая запись и «как в логе» на вкладке «Записи»', async ({ page }) => {
    await find(page, ['getCard', 'text/xml']);
    await open(page, rows(page).first());
    const send = await openSend(page);
    const body = send.locator('[data-block=body]');
    await expect(marks(body).first()).toHaveText('getCard');
    await expect(body.getByTestId('hit-count')).toHaveAttribute('title', /подсвечено по видимой части/);
    // Блок заголовков раскрыт совпадением.
    const headers = send.locator('[data-block=headers]');
    await expect(headers.locator('button[aria-expanded]')).toHaveAttribute('aria-expanded', 'true');
    await expect(marks(headers).first()).toHaveText('text/xml');
    // Сырая запись совпадением не раскрывается, счётчик виден сразу.
    const raw = send.locator('[data-block=raw]');
    await expect(raw.locator('button[aria-expanded]')).toHaveAttribute('aria-expanded', 'false');
    await expect(raw.getByTestId('hit-count')).toBeVisible();
    await raw.locator('button[aria-expanded]').click();
    await expect(marks(raw).first()).toBeVisible();
    await body.getByRole('button', { name: 'Как в логе' }).click();
    await expect(body).toHaveAttribute('data-mode', 'raw');
    await expect(marks(body).first()).toBeVisible();
  });

  test('вложенное тело раскрыто совпадением', async ({ page }) => {
    await find(page, ['check_iss_acq_fees']);
    await open(page, rows(page).first());
    await viewTab(page, 'Записи').click();
    const response = page.locator('li[data-kind=response]').first();
    await expand(response);
    const nested = response.getByRole('group', { name: 'Вложенные тела' }).locator('[data-block=nested]');
    await expect(marks(nested).first()).toHaveText('check_iss_acq_fees');
    await expect(marks(nested).first()).toBeVisible();
  });

  test('«Все записи»: значение подсвечено', async ({ page }) => {
    await find(page, ['getCard']);
    await page.getByRole('tab', { name: 'Все записи' }).click();
    const first = page.getByTestId('lines').locator('li[data-record-id]').first();
    await expand(first);
    await expect(first.getByTestId('hit-count').first()).toBeVisible();
  });

  test('по ссылке подсветки и сводки нет; страница не двигается при открытии', async ({ page, context }) => {
    await find(page, ['getCard']);
    await open(page, rows(page).first());
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await expect(summary(page)).toBeVisible();
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    const send = await openSend(page);
    await expect(marks(send.locator('[data-block=body]')).first()).toBeVisible();
    const other = await context.newPage();
    await other.goto(page.url());
    await expect(other.getByTestId('request-header')).toBeVisible();
    await viewTab(other, 'Записи').click();
    await other.locator('li[data-kind=send]').first().locator('button[aria-expanded]').first().click();
    await expect(other.locator('li[data-kind=send]').first().locator('[data-block=body]')).toContainText('getCard');
    await expect(marks(other.getByTestId('request-page'))).toHaveCount(0);
    await expect(summary(other)).toHaveCount(0);
    await other.close();
  });

  test('запрос со страницы операции: подсвечен id', async ({ page }) => {
    const state = ((await (await page.request.get('/api/catalog')).json()) as { state?: string }).state;
    test.skip(state !== 'ok', 'без справочника нет типов операций');
    await page.goto(`/pay/demo/operations/transfer/${MOCK_FLOW.transfer}?at=${Date.now() - 9 * 3_600_000}&w=6h`);
    await expect(page.getByTestId('operation-page')).toHaveAttribute('data-status', 'done', { timeout: 30_000 });
    await page.getByTestId('operation-flows').locator('a[data-flow]').first().click();
    await expect(page.getByTestId('request-header')).toBeVisible();
    await expect(summary(page)).toContainText('Значение найдено');
    await toFirst(page).click();
    await expect(marks(page.getByRole('list', { name: 'Записи запроса' })).first()).toContainText(MOCK_FLOW.transfer);
  });

  test('перезагрузка после истечения поиска: без подсветки', async ({ page }) => {
    await find(page, ['getCard']);
    await open(page, rows(page).first());
    await expect(summary(page)).toBeVisible();
    const gone = await page.request.get('/api/searches/no-such-search');
    const json = (await gone.json()) as object;
    await page.route('**/api/searches/*', (route) => route.fulfill({ status: gone.status(), json }));
    await page.route('**/api/searches/*/requests/*', (route) => route.fulfill({ status: gone.status(), json }));
    await page.reload();
    await expect(page.getByTestId('request-header')).toBeVisible();
    await expect(summary(page)).toHaveCount(0);
    await viewTab(page, 'Записи').click();
    await page.locator('li[data-kind=send]').first().locator('button[aria-expanded]').first().click();
    await expect(page.locator('li[data-kind=send]').first().locator('[data-block=body]')).toContainText('getCard');
    await expect(marks(page.getByTestId('request-page'))).toHaveCount(0);
  });

  test('длинное тело: совпадение в области блока, прокрутка переживает опрос, копия без разметки', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await find(page, ['getCard']);
    const id = new URL(page.url()).searchParams.get('search')!;
    await rewriteDetail(page, longBody(40_000, 'getCard'));
    // Поиск будто ещё идёт: состояние опрашивается раз в 500 мс.
    const STATE = new RegExp(`/api/searches/${id}\\?from=`);
    let polls = 0;
    await page.route(STATE, async (route) => {
      polls++;
      const res = await route.fetch();
      await route.fulfill({ response: res, json: { ...((await res.json()) as object), status: 'running' } });
    });
    await open(page, rows(page).first());
    const send = await openSend(page);
    const before = await page.evaluate(() => window.scrollY);
    const body = send.locator('[data-block=body]');
    const pre = body.locator('pre');
    const mark = marks(pre).first();
    await expect(mark).toBeVisible();
    await expect.poll(() => pre.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    const [preBox, markBox] = await Promise.all([pre.boundingBox(), mark.boundingBox()]);
    expect(markBox!.y).toBeGreaterThanOrEqual(preBox!.y);
    expect(markBox!.y + markBox!.height).toBeLessThanOrEqual(preBox!.y + preBox!.height);
    expect(await page.evaluate(() => window.scrollY)).toBe(before);

    await pre.evaluate((el) => {
      el.scrollTop = 120;
    });
    const seen = polls;
    await expect.poll(() => polls, { timeout: 5000 }).toBeGreaterThanOrEqual(seen + 2);
    expect(await pre.evaluate((el) => el.scrollTop)).toBe(120);

    await body.getByRole('button', { name: /^Копировать/ }).click();
    await expect(body.getByRole('button', { name: /^Скопировано/ })).toBeVisible();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toBe(await pre.textContent());
    expect(copied).not.toContain('<mark');
    // Опрос ещё идёт: без этого обработчик может получить ответ уже после закрытия страницы.
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('тело 2 МБ открывается, совпадение видно', async ({ page }) => {
    test.setTimeout(60_000);
    await find(page, ['getCard']);
    await rewriteDetail(page, longBody(2_000_000, 'getCard'));
    await open(page, rows(page).first());
    const send = await openSend(page);
    const pre = send.locator('[data-block=body] pre');
    const mark = marks(pre).first();
    await expect(mark).toBeVisible({ timeout: 15_000 });
    const [preBox, markBox] = await Promise.all([pre.boundingBox(), mark.boundingBox()]);
    expect(markBox!.y).toBeGreaterThanOrEqual(preBox!.y);
    expect(markBox!.y + markBox!.height).toBeLessThanOrEqual(preBox!.y + preBox!.height);
  });

  for (const colorScheme of ['light', 'dark'] as const) {
    for (const width of [768, 1440, 2560]) {
      test(`${width}px, ${colorScheme}: высота блоков и их положение те же с подсветкой и без`, async ({ page, context }) => {
        const blocksOf = async (p: Page) => {
          await viewTab(p, 'Записи').click();
          const send = p.locator('li[data-kind=send]').first();
          await expand(send);
          const body = send.locator('[data-block=body]');
          await expect(body.locator('pre')).toBeVisible();
          const top = (await body.boundingBox())!.y;
          const all = send.locator('[data-block=body], [data-block=raw]');
          return all.evaluateAll((els, y) => els.map((el) => ({ name: el.getAttribute('data-block'), top: el.getBoundingClientRect().top - y, height: el.getBoundingClientRect().height })), top);
        };
        await page.emulateMedia({ colorScheme });
        await page.setViewportSize({ width, height: 900 });
        await find(page, ['getCard']);
        await open(page, rows(page).first());
        const hit = await blocksOf(page);
        await expect(marks(page.locator('li[data-kind=send]').first().locator('[data-block=body]')).first()).toBeVisible();

        const plain = await context.newPage();
        await plain.emulateMedia({ colorScheme });
        await plain.setViewportSize({ width, height: 900 });
        await plain.goto(page.url());
        await expect(plain.getByTestId('request-header')).toBeVisible();
        expect(await blocksOf(plain)).toEqual(hit);
        await expect(marks(plain.getByTestId('request-page'))).toHaveCount(0);
        await plain.close();
      });
    }
  }

  test('совпадение только в сырой записи: «К первому» раскрывает её, фокус на записи', async ({ page }) => {
    await find(page, ['contacts updated']);
    await open(page, page.locator('li[data-cid="phone-spelling-0"]'));
    await expect(summary(page)).toContainText('Значение найдено в 1 записи из 2');
    await toFirst(page).click();
    await expect(viewTab(page, 'Записи')).toHaveAttribute('aria-selected', 'true');
    const record = records(page).nth(1);
    const raw = record.locator('[data-block=raw]');
    await expect(marks(raw).first()).toHaveText('contacts updated');
    await expect(marks(raw).first()).toBeVisible();
    await expect(record.locator('button[aria-expanded]').first()).toBeFocused();
  });

  test('ошибка выше совпадения: страница у совпадения и при первом открытии вкладки, и при повторном нажатии', async ({ page }) => {
    await find(page, ['cards/sync']);
    // В длинном запросе значение остаётся в одной записи далеко за первой ошибкой.
    await rewriteDetail(page, (d) => {
      for (const r of d.records) {
        r.raw = r.raw.replaceAll('cards/sync', 'cards/x');
        if (r.http?.uri) r.http.uri = r.http.uri.replaceAll('cards/sync', 'cards/x');
      }
      const r = d.records[400]!;
      r.raw = `${r.raw} cards/sync`;
      r.sections.body = 'cards/sync';
    });
    await open(page, rows(page).first());
    await expect(summary(page)).toContainText('Значение найдено в 1 записи из 501');
    const target = records(page).nth(400);
    const firstError = page.locator('li[data-error]').first();
    await toFirst(page).click();
    await expect(target).toBeInViewport();
    await expect(target.locator('button[aria-expanded]').first()).toBeFocused();
    await expect(marks(target).first()).toBeVisible();
    await expect(firstError).not.toBeInViewport();
    await page.getByTestId('records-tab').evaluate((el) => el.scrollTo(0, 0));
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(target).not.toBeInViewport();
    await toFirst(page).click();
    await expect(target).toBeInViewport();
    await expect(target.locator('button[aria-expanded]').first()).toBeFocused();
  });

  for (const width of [768, 2560]) {
    test(`${width}px: строка вкладок одной высоты со сводкой и без, горизонтальной прокрутки нет`, async ({ page, context }) => {
      await page.setViewportSize({ width, height: 900 });
      await find(page, ['getCard']);
      await open(page, rows(page).first());
      await expect(summary(page)).toBeVisible();
      const strip = (p: Page) => p.getByRole('tablist', { name: 'Вид запроса' }).boundingBox();
      const withSummary = (await strip(page))!;
      expect(await noScroll(page)).toBe(true);
      const plain = await context.newPage();
      await plain.setViewportSize({ width, height: 900 });
      await plain.goto(page.url());
      await expect(plain.getByTestId('request-header')).toBeVisible();
      await expect(summary(plain)).toHaveCount(0);
      expect((await strip(plain))!.height).toBe(withSummary.height);
      expect(await noScroll(plain)).toBe(true);
      await plain.close();
    });
  }
});

test.describe('панель шага: сводка и свёрнутые логи', () => {
  const toggle = (block: Locator) => block.locator('button[aria-expanded]').first();

  test('кода в панели нет: ни вкладок, ни блоков; данные строками с видом и размером, причина и итог видны', async ({ page }) => {
    await openProcessorError(page);
    await expect(details(page).getByTestId('step-error')).toHaveText('Card not found');
    await expect(details(page).getByTestId('step-duration')).toBeVisible();
    await expect(details(page).getByRole('tab')).toHaveCount(0);
    await expect(details(page).locator('[data-block]')).toHaveCount(0);
    await expect(details(page).locator('pre')).toHaveCount(0);
    await expect(dataRow(page, 'Запрос').getByTestId('data-meta')).toHaveText(/^XML · [\d\s,]+ (Б|КБ)$/);
    await expect(dataRow(page, 'Ответ').getByTestId('data-meta')).toHaveText(/^XML · [\d\s,]+ (Б|КБ)$/);
    // У заголовков — число строк, у сырых записей — число записей.
    await expect(dataRow(page, 'Заголовки').getByTestId('data-meta')).toHaveText(/^\d+$/);
    await expect(dataRow(page, 'Сырые записи').getByTestId('data-meta')).toHaveText(/^\d+$/);
  });

  test('логи шага и строки логов приложения свёрнуты, значки ошибок видны', async ({ page }) => {
    await openRequest(page, 'fraud.pay.example');
    const logs = details(page).getByTestId('step-logs');
    await expect(toggle(logs)).toHaveAttribute('aria-expanded', 'false');
    await expect(logs.getByRole('list')).toBeHidden();
    await expect(logs.getByRole('button', { name: /Логи шага/ })).toContainText(/\d+ (ERROR|WARNING)/);
    await appLogs(page).click();
    await expect(details(page).getByRole('list', { name: 'Логи приложения' }).locator('li > div > button[aria-expanded=true]')).toHaveCount(0);
    await scheme(page).locator('button[data-node][data-tone=error]').first().click();
    // Раскрытые логи и строка запоминаются на странице: другой шаг и возврат их не сворачивают.
    const selected = pressed(page);
    const step = await selected.getAttribute('data-node');
    await toggle(logs).click();
    const row = logs.locator('li > div > button[aria-expanded]').first();
    await expect(row).toHaveAttribute('aria-expanded', 'false');
    await row.click();
    await node(page, 'entry').click();
    await scheme(page).locator(`button[data-node="${step}"]`).click();
    await expect(toggle(logs)).toHaveAttribute('aria-expanded', 'true');
    await expect(row).toHaveAttribute('aria-expanded', 'true');
  });

  test('окно тела: J и K листают шаги, окно остаётся на тех же данных; у шага без них — первые данные, выбор вкладки помнится', async ({ page }) => {
    await openSwitch(page);
    const exchange = node(page, 'exchange').first();
    const exchangeStep = (await exchange.getAttribute('data-node'))!;
    await exchange.click();
    await openData(page, 'Ответ');
    await expect(viewer(page)).toHaveAttribute('data-step', exchangeStep);
    const position = await viewer(page).getByTestId('viewer-position').textContent();
    // У соседнего шага ([DB] connection) ответа нет: окно показывает его первые данные.
    await page.keyboard.press('KeyK');
    await expect(viewer(page)).not.toHaveAttribute('data-step', exchangeStep);
    await expect(viewer(page).getByTestId('viewer-position')).not.toHaveText(position!);
    await expect(viewer(page)).not.toHaveAttribute('data-item', 'response');
    await expect(viewer(page).getByRole('tab').first()).toHaveAttribute('aria-selected', 'true');
    // Обратно — снова «Ответ».
    await page.keyboard.press('KeyJ');
    await expect(viewer(page)).toHaveAttribute('data-step', exchangeStep);
    await expect(viewerTab(page, 'Ответ')).toHaveAttribute('aria-selected', 'true');
    // Выбранная вкладка переживает листание.
    await viewerTab(page, 'Запрос').click();
    await page.keyboard.press('KeyK');
    await expect(viewer(page)).not.toHaveAttribute('data-step', exchangeStep);
    await page.keyboard.press('KeyJ');
    await expect(viewer(page)).toHaveAttribute('data-step', exchangeStep);
    await expect(viewerTab(page, 'Запрос')).toHaveAttribute('aria-selected', 'true');
    await expect(viewerCode(page)).toHaveAttribute('data-block', 'body');
    // Шаг окна — выбранный на странице.
    await closeViewer(page);
    await expect(exchange).toHaveAttribute('aria-pressed', 'true');
  });

  test('геометрия: строки данных шага на месте после окна тела и при смене шага', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openProcessorError(page);
    const calls = scheme(page).locator('button[data-node]:not([data-kind=entry])');
    const response = dataRow(page, 'Ответ');
    const place = async () => {
      const b = (await response.boundingBox())!;
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    };
    const section = async () => (await details(page).getByTestId('step-data').boundingBox())!;
    await expect(response).toBeVisible();
    const before = { row: await place(), section: await section() };
    await openData(page, 'Ответ');
    await closeViewer(page);
    expect(await place()).toEqual(before.row);
    await calls.nth(0).click();
    await expect(response).toBeVisible();
    expect((await section()).x).toBe(before.section.x);
    expect((await section()).width).toBe(before.section.width);
    await calls.nth(1).click();
    await expect(details(page).getByTestId('step-error')).toHaveText('Card not found');
    expect(await place()).toEqual(before.row);
  });

  test('«К первому» прокручивает к совпадению на вкладке «Записи»; в панели у строки «Запрос» счётчик совпадений', async ({ page }) => {
    await page.goto('/pay/demo');
    const input = page.getByRole('textbox', { name: 'Значения для поиска' });
    await input.fill('getCard');
    await input.press('Enter');
    await page.getByRole('group', { name: 'Период' }).getByRole('button', { name: '24 ч', exact: true }).click();
    await page.getByRole('button', { name: 'Найти', exact: true }).click();
    await expect(page.getByTestId('search-results')).toHaveAttribute('data-status', 'done', { timeout: 20_000 });
    await rows(page).and(page.locator('[data-status=error]')).first().locator('[data-row-link]').click(ROW_HIT);
    await expect(page.getByTestId('request-header')).toBeVisible();
    // В панели только число: тело открывается в окне.
    await expect(dataRow(page, 'Запрос').getByTestId('hit-count')).toBeVisible();
    await expect(details(page).locator('mark.search-hit')).toHaveCount(0);
    await page.getByTestId('hit-summary').getByRole('button', { name: 'К первому' }).click();
    const record = page.locator('li[data-record-id] [data-block] mark.search-hit').first();
    await expect(record).toBeVisible();
    await expect(record).toBeInViewport();
  });
});

// Большое окно кода открывается из блоков строк записей: вкладка «Записи», логи шага и логи приложения. У данных шага в панели его нет, там окно тела.
test.describe('большое окно кода', () => {
  const win = (page: Page) => page.getByTestId('code-window');
  const opener = (block: Locator) => block.getByTestId('code-window-open');
  const box = async (page: Page) => (await win(page).boundingBox())!;
  const drag = async (page: Page, from: { x: number; y: number }, to: { x: number; y: number }) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2);
    await page.mouse.move(to.x, to.y);
    await page.waitForTimeout(50);
    await page.mouse.up();
  };
  /** Тело ответа с ошибкой на вкладке «Записи»: запись с первой ошибкой раскрыта сразу. */
  async function errorResponse(page: Page): Promise<Locator> {
    await viewTab(page, 'Записи').click();
    const block = page.locator('li[data-record-id][data-error]').first().locator('[data-block=response]');
    await expect(block).toBeVisible();
    return block;
  }
  /** Ответ коммутатора на вкладке «Записи»: запись раскрывается нажатием. */
  async function switchResponse(page: Page): Promise<Locator> {
    await viewTab(page, 'Записи').click();
    const record = page.locator('li[data-record-id][data-kind=response]').first();
    await record.locator('button[aria-expanded]').first().click();
    return record.locator('[data-block=response]');
  }
  /** Запись «cURL error 28» в логах шага проверки мошенничества: логи и запись раскрыты в панели, схема рядом. */
  async function stepLogContext(page: Page): Promise<Locator> {
    await openRequest(page, 'fraud.pay.example');
    const logs = details(page).getByTestId('step-logs');
    await logs.getByRole('button', { name: /Логи шага/ }).click();
    const record = logs.locator('li[data-record-id]').filter({ hasText: 'cURL error 28' }).first();
    await record.locator('button[aria-expanded]').first().click();
    const block = record.locator('[data-block=context]');
    await expect(block).toBeVisible();
    return block;
  }

  test('кнопка со значком и подсказкой, окно без затемнения, диалог с именем, граф нажимается', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const block = await stepLogContext(page);
    await opener(block).hover();
    await expect(page.getByRole('tooltip').first()).toContainText('Открыть в большом окне');
    await opener(block).click();
    const dialog = page.getByRole('dialog', { name: /Остальной контекст/ });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'false');
    // Около 80 % окна, по центру, затемнения нет.
    const b = await box(page);
    expect(b.width).toBeCloseTo(864, -1);
    expect(b.height).toBeCloseTo(630, -1);
    expect(await page.locator('[data-radix-dialog-overlay], .fixed.inset-0').count()).toBe(0);
    // Тот же код: номера строк, подсветка, вид и перенос.
    await expect(dialog.locator('pre [data-token=key]').first()).toBeVisible();
    await expect(dialog.locator('pre span[data-n="1"]')).toBeAttached();
    await expect(dialog.getByRole('button', { name: 'Форматировано' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Переносить строки' })).toHaveAttribute('aria-pressed', 'true');
    await dialog.getByRole('button', { name: 'Переносить строки' }).click();
    await expect(dialog.locator('pre')).toHaveCSS('white-space', 'pre');
    // Окно не закрывает страницу от нажатий: граф нажимается, если его часть видна.
    await drag(page, { x: b.x + 60, y: b.y + 20 }, { x: 1440, y: 900 });
    const moved = await box(page);
    await node(page, 'entry').click();
    await expect(node(page, 'entry')).toHaveAttribute('aria-pressed', 'true');
    await expect(win(page)).toBeVisible();
    expect(await box(page)).toEqual(moved);
  });

  test('Esc и кнопка закрывают, фокус входит в окно и возвращается к кнопке', async ({ page }) => {
    await openProcessorError(page);
    const block = await errorResponse(page);
    await opener(block).focus();
    await page.keyboard.press('Enter');
    await expect(win(page).locator('pre')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(win(page)).toHaveCount(0);
    await expect(opener(block)).toBeFocused();
    await opener(block).click();
    await expect(win(page)).toBeVisible();
    await win(page).getByTestId('code-window-close').click();
    await expect(win(page)).toHaveCount(0);
    await expect(opener(block)).toBeFocused();
  });

  test('другой шаг по K: окно остаётся на своём блоке, вид свой у окна', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    // Окно в углу: узлы графа остаются под рукой.
    await page.addInitScript(() => localStorage.setItem('threadline.codeWindow', JSON.stringify({ x: 900, y: 500, width: 500, height: 350 })));
    const block = await stepLogContext(page);
    const step = (await details(page).getAttribute('data-step'))!;
    await opener(block).click();
    await expect(win(page).locator('pre')).toContainText('cURL error 28');
    const first = await win(page).locator('pre').textContent();
    // Фокус в окне, K выбирает соседний шаг: окно немодальное, клавиши шагов работают. Окно показывает тот же блок.
    await expect(win(page).locator('pre')).toBeFocused();
    await page.keyboard.press('KeyK');
    await expect(details(page)).not.toHaveAttribute('data-step', step);
    await expect(win(page).locator('pre')).toHaveText(first!);
    await expect(page.getByRole('dialog', { name: /Остальной контекст/ })).toBeVisible();
    // Вид окна не меняет вид того же блока в логах шага.
    await win(page).getByRole('button', { name: 'Как в логе' }).click();
    await expect(win(page)).toHaveAttribute('data-mode', 'raw');
    await node(page, 'exchange').click();
    await expect(details(page)).toHaveAttribute('data-step', step);
    await expect(block).toHaveAttribute('data-mode', 'pretty');
  });

  test('копирование берёт то, что на экране окна', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openSwitch(page);
    await opener(await switchResponse(page)).click();
    await win(page).getByRole('button', { name: 'Как в логе' }).click();
    await win(page).getByRole('button', { name: /^Копировать/ }).click();
    await expect(win(page).getByRole('button', { name: /^Скопировано/ })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(await win(page).locator('pre').textContent());
  });

  for (const language of ['ru', 'en']) {
    test(`«Копировать» одной ширины, ${language}: окно тела, вкладка «Записи» и большое окно, соседняя кнопка на месте, отказ буфера тоже`, async ({ page, context }) => {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await openSwitch(page);
      await page.evaluate((value) => localStorage.setItem('threadline.language', value), language);
      await page.reload();
      await expect(page.getByTestId('request-header')).toBeVisible();
      const steady = async (area: Locator) => {
        const copy = area.getByRole('button', { name: /^(Копировать|Copy)/ });
        const wrap = area.locator('button[aria-pressed]').first();
        const width = (await copy.boundingBox())!.width;
        const x = (await wrap.boundingBox())!.x;
        const unchanged = async (state: Locator) => {
          await expect(state).toBeVisible();
          expect((await state.boundingBox())!.width).toBeCloseTo(width, 1);
          expect((await wrap.boundingBox())!.x).toBeCloseTo(x, 1);
          await expect(copy).toBeVisible({ timeout: 3000 });
        };
        await copy.click();
        await unchanged(area.getByRole('button', { name: /^(Скопировано|Copied)/ }));
        await page.evaluate(() => {
          navigator.clipboard.writeText = () => Promise.reject(new Error('отказ'));
          document.execCommand = () => false;
        });
        await copy.click();
        await unchanged(area.getByRole('button', { name: /^(Не удалось|Failed)/ }));
        await page.evaluate(() => {
          delete (navigator.clipboard as unknown as Record<string, unknown>).writeText;
          delete (document as unknown as Record<string, unknown>).execCommand;
        });
      };
      // Окно тела: строка данных находится по виду данных, подпись на языке страницы.
      await page.locator('button[data-node][data-kind=exchange]').first().click();
      await dataRow(page, 'Ответ').click();
      await expect(viewer(page)).toBeVisible();
      await steady(viewer(page));
      await closeViewer(page);
      await page.getByRole('tab', { name: /^(Записи|Records|Yozuvlar)/ }).click();
      const response = page.locator('li[data-record-id][data-kind=response]').first();
      await response.locator('button[aria-expanded]').first().click();
      const block = response.locator('[data-block=response]');
      await steady(block);
      await opener(block).click();
      await steady(win(page).getByTestId('code-controls'));
      await page.getByTestId('code-window-close').click();
    });
  }

  test('перетаскивание и края: не выходит за окно, не меньше 480×320, положение запоминается', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openProcessorError(page);
    const block = await errorResponse(page);
    await opener(block).click();
    const start = await box(page);
    // За правый нижний угол окна не выходит.
    await drag(page, { x: start.x + 60, y: start.y + 20 }, { x: 3000, y: 3000 });
    let b = await box(page);
    expect(b.x + b.width).toBeLessThanOrEqual(1440);
    // Вниз окно уходит, но шапка остаётся на экране.
    expect(b.y).toBeLessThanOrEqual(852);
    // За левый верхний — тоже.
    await drag(page, { x: b.x + 60, y: b.y + 20 }, { x: 60, y: -2000 });
    b = await box(page);
    expect(b.x).toBe(0);
    expect(b.y).toBe(0);
    // Все края и углы; наименьший размер.
    for (const edge of ['e', 's', 'se', 'n', 'w', 'nw', 'ne', 'sw']) await expect(win(page).locator(`[data-edge=${edge}]`)).toBeAttached();
    await drag(page, { x: b.x + b.width, y: b.y + b.height }, { x: b.x + 10, y: b.y + 10 });
    b = await box(page);
    expect(b.width).toBeGreaterThanOrEqual(480);
    expect(b.height).toBeGreaterThanOrEqual(320);
    expect(b.width).toBeLessThan(482);
    // Левый край: правый стоит на месте.
    await drag(page, { x: b.x + 200, y: b.y + 20 }, { x: 500, y: 200 });
    const placed = await box(page);
    await drag(page, { x: placed.x, y: placed.y + 100 }, { x: placed.x - 100, y: placed.y + 100 });
    const wider = await box(page);
    expect(wider.x + wider.width).toBeCloseTo(placed.x + placed.width, 0);
    expect(wider.width).toBeCloseTo(placed.width + 100, 0);
    // После закрытия и открытия там же.
    await page.keyboard.press('Escape');
    await opener(block).click();
    expect(await box(page)).toEqual(wider);
  });

  test('плохое и чужое сохранённое значение и сужение окна: обычное положение', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    for (const saved of ['не json', '{"x":"a"}', JSON.stringify({ x: 5000, y: 5000, width: 800, height: 500 }), JSON.stringify({ x: 0, y: 0, width: 10, height: 10 })]) {
      await page.addInitScript((value) => localStorage.setItem('threadline.codeWindow', value), saved);
      await openProcessorError(page);
      await opener(await errorResponse(page)).click();
      const b = await box(page);
      expect(b.width).toBeCloseTo(864, -1);
      expect(b.x).toBeCloseTo(16, -1);
    }
    await page.evaluate(() => localStorage.setItem('threadline.codeWindow', JSON.stringify({ x: 900, y: 500, width: 500, height: 350 })));
    await page.keyboard.press('Escape');
    await opener(await errorResponse(page)).click();
    expect((await box(page)).x).toBe(900);
    // Панель шага обычной ширины 400: на 1280 окну остаётся 1280 − 400 − 2 × 16 = 848, обычная ширина — 60 % окна.
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect.poll(async () => (await box(page)).width).toBe(768);
    const b = await box(page);
    expect(b.x + b.width).toBeLessThanOrEqual(1280);
    expect(b.y + b.height).toBeLessThanOrEqual(720);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });

  test('768: окно из блока записи на вкладке «Записи» помещается', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await openProcessorError(page);
    await opener(await errorResponse(page)).click();
    const b = await box(page);
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width).toBeLessThanOrEqual(768);
    expect(b.width).toBeGreaterThanOrEqual(480);
    await expect(win(page).locator('pre')).toContainText('response_code');
    await page.keyboard.press('Escape');
    await expect(win(page)).toHaveCount(0);
  });

  test('«Все записи»: окно показывает строку, панели шага здесь нет', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/pay/demo');
    const input = page.getByRole('textbox', { name: 'Значения для поиска' });
    await input.fill('getCard');
    await input.press('Enter');
    await page.getByRole('group', { name: 'Период' }).getByRole('button', { name: '24 ч', exact: true }).click();
    await page.getByRole('button', { name: 'Найти', exact: true }).click();
    await expect(page.getByTestId('search-results')).toHaveAttribute('data-status', 'done', { timeout: 20_000 });
    await page.getByRole('tab', { name: 'Все записи' }).click();
    const line = page.getByRole('list', { name: 'Все найденные строки' }).locator('li[data-kind=response]').first();
    await line.locator('button[aria-expanded]').first().click();
    await opener(line.locator('[data-block=response]')).click();
    await expect(win(page).locator('pre')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(win(page)).toHaveCount(0);
  });
});
