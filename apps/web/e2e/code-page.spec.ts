import { expect, test, type Locator, type Page } from '@playwright/test';
import { MOCK_HTML } from '../../server/src/backends/mock/dataset-pay.ts';
import { closeMenu, closeViewer, dataRow, modeSwitchInMenu, openBlock, openData, setViewMode, viewer, viewerCode } from './helpers.ts';

// Вид «Как страница» в окне тела и в блоках записей, большое окно кода у записей, причины без HTML. Запрос MOCK_HTML: значения выдуманы, ни один другой набор его не находит.
// Данные шага в панели открываются окном тела; большое окно кода осталось у блоков записей: вкладка «Записи», логи шага.

const ROW_HIT = { position: { x: 8, y: 8 } };
const details = (page: Page) => page.getByTestId('step-details');
const scheme = (page: Page) => page.getByRole('group', { name: 'Схема запроса' });
const exchange = (page: Page, nth: number) => scheme(page).locator('button[data-node][data-kind=exchange]').nth(nth);
/** Шаг с логами: запись-лог в MOCK_HTML одна, она идёт к шагу, во время или после которого написана. */
// Значок логов стоит рядом с кнопкой узла, а не внутри неё: ищем узел-обёртку, где есть и кнопка обмена, и значок.
const withLogs = (page: Page) => scheme(page).locator('div:has(> button[data-node][data-kind=exchange]):has([data-testid=node-badge]) > button[data-node]').first();
const win = (page: Page) => page.getByTestId('code-window');
const title = (page: Page) => page.getByTestId('code-window-title');
const back = (page: Page) => page.getByTestId('code-window-back');
const pageFrame = (scope: Locator) => scope.getByTestId('code-page-frame');
const inside = (scope: Locator) => scope.frameLocator('[data-testid=code-page-frame]');
const recordsTab = (page: Page) => page.getByRole('tab', { name: /^Записи/ });
const reveal = (page: Page) => page.getByTestId('reveal-button');

/** Окно над графом и шапкой: панель шага и узлы графа остаются под рукой. */
const windowAtTop = (page: Page) => page.addInitScript(() => localStorage.setItem('threadline.codeWindow', JSON.stringify({ x: 20, y: 60, width: 620, height: 320 })));
/** Окно ниже шапки и вкладок страницы: они остаются под рукой. */
const windowBelow = (page: Page) => page.addInitScript(() => localStorage.setItem('threadline.codeWindow', JSON.stringify({ x: 20, y: 420, width: 620, height: 320 })));

async function openRequest(page: Page, term: string = MOCK_HTML.cid) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/pay/demo');
  const input = page.getByRole('textbox', { name: 'Значения для поиска' });
  await input.fill(term);
  await input.press('Enter');
  await page.getByRole('group', { name: 'Период' }).getByRole('button', { name: '24 ч', exact: true }).click();
  await page.getByRole('button', { name: 'Найти', exact: true }).click();
  await expect(page.getByTestId('search-results')).toHaveAttribute('data-status', 'done', { timeout: 20_000 });
  await page.getByRole('list', { name: 'Найденные запросы' }).getByRole('listitem').first().locator('[data-row-link]').click(ROW_HIT);
  await expect(page.getByTestId('flow-canvas')).toBeVisible({ timeout: 15_000 });
}

/** Шаг с обменом, данные «Ответ» в окне тела. */
async function openResponse(page: Page, nth: number) {
  await exchange(page, nth).click();
  await openData(page, 'Ответ');
  return viewerCode(page);
}

/** То же в виде «Как страница». */
async function openPage(page: Page, nth: number) {
  const code = await openResponse(page, nth);
  await viewer(page).getByRole('button', { name: 'Как страница' }).click();
  await expect(code).toHaveAttribute('data-mode', 'page');
  return code;
}

/** Окно тела модальное: «Показать скрытое» в шапке нажимается при закрытом окне, затем страница открывается снова. */
async function toggleRevealAndReopen(page: Page, nth: number) {
  await closeViewer(page);
  await reveal(page).click();
  return openPage(page, nth);
}

/** Номер выбранного шага из панели: «шаг 4 из 4». */
const stepNumber = async (page: Page) => (await details(page).getByTestId('step-number').textContent())?.match(/\d+/)?.[0] ?? '';

/** Логи шага раскрыты, их запись тоже; её сырая запись открывается в большом окне. */
async function openLogInWindow(page: Page) {
  await withLogs(page).click();
  const logs = details(page).getByTestId('step-logs');
  await openBlock(logs);
  const row = logs.locator('li[data-record-id]').first();
  await openBlock(row);
  await row.locator('[data-block=raw]').getByTestId('code-window-open').click();
  await expect(win(page)).toBeVisible();
  return row;
}

/** Ответ /v2/withdraw на вкладке «Записи», раскрытый: тело — JSON, в сообщении страница. */
async function withdrawRecord(page: Page) {
  await recordsTab(page).click();
  const record = page.locator('li[data-record-id][data-kind=response]').filter({ hasText: '/v2/withdraw' });
  await openBlock(record);
  return record;
}

test.describe('большое окно закреплено за блоком', () => {
  test('окно из логов шага: смена шага и окно тела его не меняют, ссылка ведёт обратно к шагу', async ({ page }) => {
    await windowAtTop(page);
    await openRequest(page);
    await openLogInWindow(page);
    const step = await details(page).getAttribute('data-step');
    const n = await stepNumber(page);
    const pre = win(page).locator('pre');
    await expect(pre).toContainText('Upstream answered with a page');
    const pinned = await pre.textContent();
    const box = await win(page).boundingBox();
    // Заголовок говорит, что закреплено: номер и имя шага, логи шага, запись и блок; полный текст в подсказке.
    await expect(title(page)).toContainText(`Шаг ${n} · `);
    await expect(title(page)).toContainText('Логи шага');
    await expect(title(page)).toContainText('Сырая запись');
    await expect(title(page)).toHaveAttribute('title', new RegExp(`^Шаг ${n} · .+ · Логи шага · .+ · Сырая запись$`, 's'));
    const full = (await title(page).getAttribute('title'))!;
    await expect(back(page)).toHaveCount(0);

    // Другой шаг: окно на месте, в панели другой шаг, появилась ссылка.
    await scheme(page).locator('button[data-node][data-kind=entry]').click();
    await expect(details(page)).not.toHaveAttribute('data-step', step!);
    await expect(pre).toHaveText(pinned!);
    await expect(title(page)).toHaveAttribute('title', full);
    await expect(back(page)).toHaveText(`К шагу ${n}`);

    // Окно тела открывается над ним и закрывается по Esc: большое окно остаётся тем же и на том же месте.
    await details(page).getByTestId('data-row').first().click();
    await expect(viewer(page)).toBeVisible();
    await closeViewer(page);
    await expect(win(page)).toBeVisible();
    await expect(pre).toHaveText(pinned!);
    expect(await win(page).boundingBox()).toEqual(box);

    // Ссылка: шаг окна, фокус на панели; ссылка уходит.
    await back(page).click();
    await expect(withLogs(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(details(page)).toHaveAttribute('data-step', step!);
    await expect(details(page)).toBeFocused();
    await expect(back(page)).toHaveCount(0);
  });

  test('вид и перенос принадлежат окну: блок записи и окно их не делят, другой блок приходит с выбором окна', async ({ page }) => {
    await windowBelow(page);
    await openRequest(page);
    const record = await withdrawRecord(page);
    const block = record.locator('[data-block=response]');
    await block.getByTestId('code-window-open').click();
    await win(page).getByRole('button', { name: 'Как в логе' }).click();
    await expect(win(page)).toHaveAttribute('data-mode', 'raw');
    await expect(block).toHaveAttribute('data-mode', 'pretty');
    await win(page).getByRole('button', { name: 'Переносить строки' }).click();
    await expect(win(page).locator('pre')).toHaveCSS('white-space', 'pre');
    await block.getByRole('button', { name: 'Форматировано' }).click();
    await expect(win(page)).toHaveAttribute('data-mode', 'raw');
    await record.locator('[data-block=raw]').getByTestId('code-window-open').click();
    await expect(title(page)).toContainText('Сырая запись');
    await expect(win(page).locator('pre')).toHaveCSS('white-space', 'pre');
  });

  test('запись вкладки «Записи»: заголовок называет её, ссылки на шаг нет; другой блок приходит в то же окно; смена вкладки окно оставляет', async ({ page }) => {
    await windowBelow(page);
    await openRequest(page);
    await recordsTab(page).click();
    const record = page.locator('li[data-record-id][data-error]').first();
    await record.locator('[data-block=response]').getByTestId('code-window-open').click();
    await expect(title(page)).toContainText('Записи · ');
    await expect(back(page)).toHaveCount(0);
    const pre = win(page).locator('pre');
    await expect(pre).not.toBeEmpty();
    const shown = await pre.textContent();
    const box = await win(page).boundingBox();

    // Другой блок: то же окно, то же место, новое содержимое и заголовок.
    await record.locator('[data-block=raw]').getByTestId('code-window-open').click();
    await expect(title(page)).toHaveAttribute('title', /^Записи · .+ · Сырая запись$/s);
    await expect(pre).not.toHaveText(shown!);
    await expect(win(page)).toHaveCount(1);
    expect(await win(page).boundingBox()).toEqual(box);

    await page.getByRole('tab', { name: 'Схема', exact: true }).click();
    await expect(win(page)).toBeVisible();
    await expect(back(page)).toHaveCount(0);
  });

  test('закрывается сам, когда блока больше нет, и при уходе со страницы; фокус остаётся на нажатом', async ({ page }) => {
    await windowBelow(page);
    await openRequest(page);
    await openLogInWindow(page);
    // «Кратко» убирает логи шага: окно закрывается, фокус остаётся на выборе в меню профиля.
    const brief = (await modeSwitchInMenu(page)).getByRole('menuitemradio', { name: 'Кратко', exact: true });
    await brief.click();
    await expect(win(page)).toHaveCount(0);
    await expect(brief).toBeFocused();
    await closeMenu(page);
    await setViewMode(page, 'Подробно');
    await expect(win(page)).toHaveCount(0);

    await openLogInWindow(page);
    await page.getByRole('link', { name: 'К результатам' }).click();
    await expect(page.getByTestId('search-results')).toBeVisible();
    await expect(win(page)).toHaveCount(0);
  });
});

test.describe('вид «Как страница»', () => {
  test('по умолчанию код; страница с текстом вокруг на белом листе в обеих темах; маска и показ те же; копирование', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openRequest(page);
    const code = await openResponse(page, 0);
    await expect(code).toHaveAttribute('data-mode', 'pretty');
    await expect(code.locator('pre')).toBeVisible();
    await expect(pageFrame(code)).toHaveCount(0);
    await viewer(page).getByRole('button', { name: 'Как страница' }).click();
    await expect(code).toHaveAttribute('data-mode', 'page');
    await expect(viewer(page)).toHaveAttribute('data-mode', 'page');

    const frame = pageFrame(code);
    await expect(frame).toHaveAttribute('sandbox', '');
    await expect(code.getByTestId('code-page-before')).toContainText(`Failed to withdraw from card ${MOCK_HTML.card}`);
    await expect(inside(code).locator('h1')).toHaveText('502 Bad Gateway');
    // Текст вокруг над страницей.
    expect((await code.getByTestId('code-page-before').boundingBox())!.y).toBeLessThan((await frame.boundingBox())!.y);

    // Белый лист с рамкой в обеих темах, своя прокрутка: страница не шире окна.
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      await expect(frame).toHaveCSS('background-color', 'rgb(255, 255, 255)');
      await expect(frame).toHaveCSS('border-top-width', '1px');
      expect(await inside(code).locator('html').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(255, 255, 255)');
    }
    await page.emulateMedia({ colorScheme: 'light' });

    // Маска та же, что в коде; показ открывает значение и в странице, «Скрыть» убирает его отовсюду.
    const inPage = inside(code).locator('p');
    await expect(inPage).toContainText('0178');
    await expect(inPage).not.toContainText(MOCK_HTML.phone);
    expect(await frame.getAttribute('srcdoc')).not.toContain(MOCK_HTML.phone);
    await toggleRevealAndReopen(page, 0);
    await expect(inPage).toContainText(MOCK_HTML.phone);
    await viewer(page).getByRole('button', { name: /^Копировать/ }).click();
    await expect(viewer(page).getByRole('button', { name: /^Скопировано/ })).toBeVisible();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain('<html>');
    expect(copied).toContain('Failed to withdraw');
    expect(copied).toContain(MOCK_HTML.phone);
    await toggleRevealAndReopen(page, 0);
    await expect(inPage).toContainText('0178');
    await expect(inPage).not.toContainText(MOCK_HTML.phone);
    expect(await frame.getAttribute('srcdoc')).not.toContain(MOCK_HTML.phone);

    // Другие виды возвращают код.
    await viewer(page).getByRole('button', { name: 'Форматировано' }).click();
    await expect(code.locator('pre')).toContainText('"message"');
    await expect(frame).toHaveCount(0);
  });

  test('в большом окне записи: тот же вид, показ обновляет, у рамки есть имя, Esc работает и после нажатия в страницу', async ({ page }) => {
    await openRequest(page);
    const block = (await withdrawRecord(page)).locator('[data-block=response]');
    await block.getByRole('button', { name: 'Как страница' }).click();
    await expect(inside(block).locator('h1')).toBeVisible();
    await block.getByTestId('code-window-open').click();
    await expect(win(page)).toHaveAttribute('data-mode', 'page');
    const frame = pageFrame(win(page));
    await expect(inside(win(page)).locator('h1')).toHaveText('502 Bad Gateway');
    await expect(win(page).getByRole('button', { name: 'Переносить строки' })).toHaveCount(0);
    // Окно не модальное: «Показать скрытое» нажимается при открытом окне.
    const inPage = inside(win(page)).locator('p');
    await reveal(page).click();
    await expect(inPage).toContainText(MOCK_HTML.phone);
    await reveal(page).click();
    await expect(inPage).not.toContainText(MOCK_HTML.phone);
    // Проверка axe здесь не годится: в рамку без скриптов она зайти не может и ждёт до конца. Имя рамки проверяется прямо.
    await expect(frame).toHaveAttribute('title', '502 Bad Gateway');

    const box = (await frame.boundingBox())!;
    await page.mouse.click(box.x + 40, box.y + 40);
    await expect(win(page).getByTestId('code-page')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(win(page)).toHaveCount(0);
  });

  test('враждебная страница: ни скриптов, ни внешних ссылок, ни запросов наружу, ни переходов', async ({ page }) => {
    const outside: string[] = [];
    const dialogs: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('hostile.example')) outside.push(r.url());
    });
    page.on('dialog', (d) => {
      dialogs.push(d.message());
      void d.dismiss();
    });
    await openRequest(page);
    // Весь ответ страница: текста вокруг нет.
    const code = await openPage(page, 1);
    const frame = pageFrame(code);
    await expect(inside(code).locator('h1')).toHaveText('Service Unavailable');
    await expect(code.getByTestId('code-page-before')).toHaveCount(0);
    const url = page.url();
    const doc = (await frame.getAttribute('srcdoc'))!;
    expect(doc).not.toContain('hostile.example');
    for (const banned of ['<script', 'onload', 'onclick', 'onerror', '<link', '<base', '<iframe', '<object', '<embed', '<form', '<input', '<img', '<svg', 'href=', 'src=', 'javascript:', 'url(']) expect(doc.toLowerCase(), banned).not.toContain(banned);
    expect(doc.match(/http-equiv/g)).toHaveLength(1);
    expect(doc).toContain(`content="default-src 'none'; style-src 'unsafe-inline'"`);
    // Встроенный стиль остаётся, цвет как задала страница.
    expect(await inside(code).locator('h1').evaluate((el) => getComputedStyle(el).color)).toBe('rgb(180, 35, 24)');
    // Нажатие по бывшей ссылке никуда не ведёт, у рамки адрес прежний.
    await inside(code).locator('a').first().click();
    await page.waitForTimeout(200);
    expect(page.url()).toBe(url);
    await expect(inside(code).locator('h1')).toBeVisible();
    expect(await frame.evaluate((el: HTMLIFrameElement) => { try { return el.contentDocument === null; } catch { return true; } })).toBe(true);
    expect(outside).toEqual([]);
    expect(dialogs).toEqual([]);
  });

  test('страница больше предела не показывается, причина названа простыми словами; код виден как раньше', async ({ page }) => {
    await openRequest(page);
    const code = await openPage(page, 2);
    await expect(code.getByTestId('code-page-notice')).toContainText('Страница слишком большая');
    await expect(code.getByTestId('code-page-notice')).toContainText('при пределе 256 КБ');
    await expect(pageFrame(code)).toHaveCount(0);
    await viewer(page).getByRole('button', { name: 'Форматировано' }).click();
    await expect(code.locator('pre')).toContainText('Huge report');
  });

  test('совпадения поиска считаются в коде: на странице счётчика нет, в коде снова есть', async ({ page }) => {
    await openRequest(page, 'edge-proxy');
    await exchange(page, 0).click();
    await expect(dataRow(page, 'Ответ').getByTestId('hit-count')).toBeVisible();
    await openData(page, 'Ответ');
    const matches = viewer(page).getByTestId('viewer-matches');
    const nextMatch = viewer(page).getByRole('button', { name: 'Следующее совпадение' });
    await expect(matches).toHaveText(/^\d+ из \d+$/);
    await expect(nextMatch).toBeEnabled();
    await viewer(page).getByRole('button', { name: 'Как страница' }).click();
    await expect(inside(viewerCode(page)).locator('h1')).toBeVisible();
    await expect(matches).toHaveText('');
    await expect(nextMatch).toBeDisabled();
    await viewer(page).getByRole('button', { name: 'Форматировано' }).click();
    await expect(matches).toHaveText(/^\d+ из \d+$/);
    await expect(nextMatch).toBeEnabled();
  });

  test('«Кратко»: вида нет, «Подробно» его возвращает; 768: окно тела в экране, прокрутки страницы нет', async ({ page }) => {
    await openRequest(page);
    await openResponse(page, 0);
    await expect(viewer(page).getByRole('button', { name: 'Как страница' })).toBeVisible();
    // Режим показа — в меню профиля, а окно тела модальное: режим меняется при закрытом окне.
    await closeViewer(page);
    await setViewMode(page, 'Кратко');
    await openData(page, 'Ответ');
    await expect(viewer(page).getByRole('button', { name: 'Как страница' })).toHaveCount(0);
    await closeViewer(page);
    await setViewMode(page, 'Подробно');
    await page.setViewportSize({ width: 768, height: 1024 });
    const code = await openPage(page, 0);
    await expect(inside(code).locator('h1')).toBeVisible();
    const box = (await viewer(page).boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(768);
    await expect(viewer(page).getByTestId('viewer-close')).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });
});

test.describe('«Как страница»: стойкость', () => {
  /** Подмена тела ответа третьего шага на клиенте, и в ответе показа: сервер такие тела не хранит, а проверяется только показ. */
  const withBody = async (page: Page, body: string) => {
    const ids = new Set<string>();
    await page.route(new RegExp(`/api/.*/requests/${MOCK_HTML.cid}(\\?.*)?$`), async (route) => {
      const res = await route.fetch();
      const json = (await res.json()) as { records: { id: string; http?: { status?: number }; sections?: { body: string } }[] };
      for (const r of json.records) {
        if (r.http?.status !== 503 || !r.sections) continue;
        r.sections.body = body;
        ids.add(r.id);
      }
      await route.fulfill({ response: res, body: JSON.stringify(json) });
    });
    await page.route(new RegExp(`/api/.*/requests/${MOCK_HTML.cid}/reveal(\\?.*)?$`), async (route) => {
      const res = await route.fetch();
      const json = (await res.json()) as { records: { id: string; sections: { body: string | null } }[] };
      for (const r of json.records) if (ids.has(r.id)) r.sections.body = body;
      await route.fulfill({ response: res, body: JSON.stringify(json) });
    });
  };

  test('номер из ячеек и телефон в тегах: страница закрывает их сама, показ открывает телефон, номер без входа закрыт', async ({ page }) => {
    // Номер выдуман и проходит Луну; ячейки с атрибутами, поэтому маска сервера его не видит.
    const cells = ['5555', '5512', '3451', '7803'].map((g) => `<td class="n">${g}</td>`).join('');
    await withBody(page, `<html><body><table><tr>${cells}</tr><tr><td>150000</td><td>20261105</td></tr></table><p>Phone +44 <b>7700</b> 900 179</p></body></html>`);
    await openRequest(page);
    const code = await openPage(page, 1);
    const td = inside(code).locator('td');
    const phone = inside(code).locator('p');
    const caption = code.getByTestId('code-page-caption');
    const masked = ['5555', '55**', '****', '7803', '150000', '20261105'];
    await expect(td).toHaveText(masked);
    await expect(phone).toHaveText('Phone +** **** **0 179');
    await expect(caption).toContainText('На странице скрыто: 1 номер карты, 1 телефон.');

    await toggleRevealAndReopen(page, 1);
    await expect(phone).toHaveText('Phone +44 7700 900 179');
    await expect(td).toHaveText(masked);
    await expect(caption).toContainText('На странице скрыто: 1 номер карты.');
    await expect(caption).not.toContainText('телефон');
    await toggleRevealAndReopen(page, 1);
    await expect(phone).toHaveText('Phone +** **** **0 179');
  });

  test('номер в тегах и сущностях под маской: сервер закрыл его в коде и в странице', async ({ page }) => {
    await openRequest(page);
    await exchange(page, 1).click();
    // Вид тела назван в строке данных шага и внизу окна тела.
    await expect(dataRow(page, 'Ответ').getByTestId('data-meta')).toHaveText(/^HTML · /);
    const code = await openResponse(page, 1);
    await expect(viewer(page).getByTestId('viewer-meta')).toContainText('HTML');
    const text = (await code.locator('pre').innerText()).replace(/<[^<>]*>/g, '');
    expect(text).not.toContain(MOCK_HTML.splitCard);
    await viewer(page).getByRole('button', { name: 'Как страница' }).click();
    const body = await inside(code).locator('body').innerText();
    expect(body).toContain('555555******1021');
    expect(body).toContain('555555******1039');
    for (const card of [MOCK_HTML.splitCard, MOCK_HTML.entityCard]) expect(body.replace(/\s/g, ''), card).not.toContain(card);
  });

  test('«Показать скрытое» в виде страницы блока записи не добавляет шагов в историю браузера', async ({ page }) => {
    await openRequest(page);
    const block = (await withdrawRecord(page)).locator('[data-block=response]');
    await block.getByRole('button', { name: 'Как страница' }).click();
    const inPage = inside(block).locator('p');
    await expect(inPage).toContainText('0178');
    const before = await page.evaluate(() => history.length);
    await reveal(page).click();
    await expect(inPage).toContainText(MOCK_HTML.phone);
    await reveal(page).click();
    await expect(inPage).not.toContainText(MOCK_HTML.phone);
    expect(await page.evaluate(() => history.length)).toBe(before);
  });

  test('на ноутбуке страница в окне тела читается: рамка не щель', async ({ page }) => {
    await openRequest(page);
    const code = await openPage(page, 0);
    await expect(inside(code).locator('h1')).toBeAttached();
    for (const [width, height] of [[1280, 720], [1366, 768]] as const) {
      await page.setViewportSize({ width, height });
      await expect.poll(async () => (await pageFrame(code).boundingBox())!.height, `${width}×${height}`).toBeGreaterThan(150);
    }
    await expect(code.getByTestId('code-page-caption')).toContainText('Страница из лога');
  });

  test('разметка, которую браузер разбирает десятки секунд, не показывается; причина названа, вкладка отвечает', async ({ page }) => {
    await withBody(page, `<html><body><table>${'<a><b>'.repeat(43_000)}`);
    await openRequest(page);
    const code = await openPage(page, 1);
    await expect(code.getByTestId('code-page-notice')).toContainText('слишком много тегов', { timeout: 2000 });
    await expect(pageFrame(code)).toHaveCount(0);
  });

  test('очень длинная строка показана без переноса, вкладка не замирает', async ({ page }) => {
    await withBody(page, 'word '.repeat(52_000));
    await openRequest(page);
    const code = await openResponse(page, 1);
    await expect(code.getByTestId('code-long-line')).toContainText('без переноса', { timeout: 3000 });
    await expect(code.locator('pre')).toHaveCSS('text-wrap-mode', 'nowrap');
    await expect(viewer(page).getByRole('button', { name: 'Переносить строки' })).toHaveCount(0);
  });

  test('окно наименьшей ширины: кнопки в окне, закрытие достижимо, название блока в заголовке видно', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('threadline.codeWindow', JSON.stringify({ x: 960, y: 200, width: 480, height: 320 })));
    await openRequest(page);
    const record = await withdrawRecord(page);
    await record.locator('[data-block=response]').getByTestId('code-window-open').click();
    const box = (await win(page).boundingBox())!;
    const close = (await win(page).getByTestId('code-window-close').boundingBox())!;
    expect(close.x + close.width).toBeLessThanOrEqual(box.x + box.width);
    const name = (await title(page).getByText(/^Ответ · /).boundingBox())!;
    expect(name.x + name.width).toBeLessThanOrEqual(box.x + box.width);
    await win(page).getByTestId('code-window-close').click();
    await expect(win(page)).toHaveCount(0);
  });

  test('панель свёрнута: при закрытии окна фокус на кнопке, которая её открывает', async ({ page }) => {
    await openRequest(page);
    await openLogInWindow(page);
    await page.getByTestId('panel-collapse').evaluate((el: HTMLElement) => el.click());
    await expect(details(page)).toBeHidden();
    await win(page).getByTestId('code-window-close').click();
    await expect(page.getByTestId('panel-open')).toBeFocused();
  });
});

test.describe('причины без HTML', () => {
  test('блок причин, схема, панель шага, записи и текст для тикета: заголовок страницы вместо кода', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openRequest(page);
    const reasons = page.getByTestId('request-reasons');
    await expect(reasons).toContainText(`Failed to withdraw from card ${MOCK_HTML.card}. HttpStatusCode = BadGateway for Content: 502 Bad Gateway`);
    await page.getByTestId('reasons-more').click();
    await expect(page.getByTestId('reasons-body')).toBeVisible();
    await expect(reasons).toContainText('Upstream answered with a page: 502 Bad Gateway');
    for (const text of await reasons.locator('li').allInnerTexts()) expect(text).not.toMatch(/<\/?[a-z]/i);
    expect(await reasons.locator('li span[title]').evaluateAll((els) => els.map((el) => el.getAttribute('title')).join(' '))).not.toMatch(/<\/?[a-z]/i);

    await expect(exchange(page, 0).getByTestId('node-outcome')).toContainText('502 Bad Gateway');
    await expect(exchange(page, 0).getByTestId('node-outcome')).not.toContainText('<');
    await exchange(page, 0).click();
    await expect(details(page).getByTestId('step-title')).toContainText('/v2/withdraw');
    await expect(details(page)).toContainText('Failed to withdraw');
    expect((await details(page).locator('[title]').evaluateAll((els) => els.map((el) => el.getAttribute('title')).join(' ')))).not.toMatch(/<\/?(html|head|body|center)/i);

    await recordsTab(page).click();
    const rows = page.locator('li[data-record-id]');
    await expect(rows.first()).toBeVisible();
    await expect(page.locator('li[data-record-id][data-kind=log]').first()).toContainText('Upstream answered with a page: 502 Bad Gateway');
    // Строки записей; код страницы виден только в раскрытых блоках подробностей.
    for (const text of await page.locator('li[data-record-id] > div:first-child').allInnerTexts()) expect(text).not.toMatch(/<\/?(html|head|body|center)/i);

    await page.getByRole('tab', { name: 'Схема', exact: true }).click();
    await page.getByTestId('request-header').getByRole('button', { name: 'Поделиться' }).first().click();
    await page.getByTestId('share-item-ticket').click();
    await expect(page.getByTestId('share-hint')).toContainText('Текст для тикета скопирован');
    const ticket = await page.evaluate(() => navigator.clipboard.readText());
    expect(ticket).toContain('for Content: 502 Bad Gateway');
    expect(ticket).not.toMatch(/<\/?(html|head|body|center)/i);
  });
});
