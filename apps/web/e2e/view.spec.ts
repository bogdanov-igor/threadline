// Режимы «Подробно» и «Кратко» на основном сервере: у каждого контекста своё хранилище браузера, настройка проекта не меняется.
// Значения синтетические; имитация и подмена ответов, к Grafana браузер не обращается.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { closeMenu, closeViewer, dataRow, modeSwitchInMenu, openData, openMore, openUserMenu, setViewMode, userMenu, viewer, viewerCode, type ViewModeName } from './helpers.ts';
import { MOCK_FLOW } from '../../server/src/backends/mock/dataset-pay.ts';

const ROW_HIT = { position: { x: 8, y: 8 } };
const H = 3_600_000;
const VIEW_KEY = 'threadline.view';
// Длинное название типа операции для проверки шапки на узком экране.
const LONG_TYPE = 'Payout to the recipient card through the payout network';

const rows = (page: Page) => page.getByRole('list', { name: 'Найденные запросы' }).getByRole('listitem');
// Переключатель на странице есть только у короткой ссылки: на своих страницах режим — строка меню профиля.
const sw = (page: Page) => page.getByTestId('detail-switch');
const modeButton = (page: Page, name: ViewModeName) => sw(page).getByRole('button', { name, exact: true });
const modeItem = (page: Page, name: ViewModeName) => userMenu(page).getByTestId('detail-switch').getByRole('menuitemradio', { name, exact: true });
const choose = async (page: Page, name: ViewModeName) => {
  await setViewMode(page, name);
  if ((await modeButton(page, name).count()) > 0) await expect(modeButton(page, name)).toHaveAttribute('aria-pressed', 'true');
};
/** Выбранный режим: кнопка на странице, а где её нет — пункт меню профиля. Меню после проверки закрыто. */
async function expectMode(page: Page, name: ViewModeName) {
  if ((await modeButton(page, name).count()) > 0) return expect(modeButton(page, name)).toHaveAttribute('aria-pressed', 'true');
  await modeSwitchInMenu(page);
  await expect(modeItem(page, name)).toHaveAttribute('aria-checked', 'true');
  await closeMenu(page);
}
const scheme = (page: Page) => page.getByTestId('trace-scheme');
const graphNodes = (page: Page) => scheme(page).locator('button[data-node]');
const details = (page: Page) => page.getByTestId('step-details');
const timeline = (page: Page) => page.getByRole('listbox', { name: 'Шаги трассы' });
const viewTab = (page: Page, name: 'Схема' | 'Шкала времени' | 'Записи') => page.getByRole('tab', { name: new RegExp(`^${name}`) });
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** Размер и место внутри строки без учёта анимации появления меню. */
const size = (loc: Locator) => loc.evaluate((el: HTMLElement) => ({ left: el.offsetLeft, w: el.offsetWidth, h: el.offsetHeight }));

/** Положение в координатах страницы: прокрутка не считается сдвигом. */
const box = (loc: Locator) =>
  loc.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + scrollX), y: Math.round(r.y + scrollY), w: Math.round(r.width), h: Math.round(r.height) };
  });

async function search(page: Page, term: string, preset = '24 ч') {
  await page.goto('/pay/demo');
  const input = page.getByRole('textbox', { name: 'Значения для поиска' });
  await input.fill(term);
  await input.press('Enter');
  await page.getByRole('group', { name: 'Период' }).getByRole('button', { name: preset, exact: true }).click();
  await page.getByRole('button', { name: 'Найти', exact: true }).click();
  await expect(page.getByTestId('search-results')).toHaveAttribute('data-status', 'done', { timeout: 20_000 });
}

async function openRequest(page: Page, term: string, status?: 'error' | 'success') {
  await search(page, term);
  const row = status ? rows(page).and(page.locator(`[data-status=${status}]`)).first() : rows(page).first();
  await row.locator('[data-row-link]').click(ROW_HIT);
  await expect(page.getByTestId('request-header')).toBeVisible();
  await expect(page.getByTestId('flow-canvas')).toBeVisible({ timeout: 15_000 });
}

const catalogOn = async (page: Page) => ((await (await page.request.get('/api/catalog')).json()) as { state?: string }).state === 'ok';

/** Все запросы браузера, в том числе за файлами кода. Опрос состояния справочника идёт по таймеру и от режима не зависит. */
function requestsOf(page: Page) {
  const seen: string[] = [];
  page.on('request', (r) => {
    const path = new URL(r.url()).pathname;
    if (path !== '/api/catalog') seen.push(`${r.method()} ${path}`);
  });
  return seen;
}

/** Строки на экране: текст, подсказки и подписи для диктора. */
const leaks = (page: Page, values: readonly string[]) =>
  page.evaluate((list) => {
    const found: string[] = [];
    const text = document.body.innerText;
    for (const v of list) if (text.includes(v)) found.push(`text:${v}`);
    for (const el of document.querySelectorAll('[title],[aria-label]')) {
      for (const attr of ['title', 'aria-label']) {
        const a = el.getAttribute(attr);
        if (a) for (const v of list) if (a.includes(v)) found.push(`${attr}:${v}:${a.slice(0, 80)}`);
      }
    }
    return found;
  }, values as string[]);

test.describe('переключатель', () => {
  test('страница запроса, меню профиля: ширина постоянная, выбранный вариант назван, повторный выбор ничего не меняет, меню открыто, адрес без режима', async ({ page }) => {
    await openRequest(page, 'getCard', 'error');
    const url = page.url();
    // На странице запроса своего переключателя нет: режим — строка меню профиля.
    await expect(page.getByTestId('request-page').getByTestId('detail-switch')).toHaveCount(0);
    const menu = await modeSwitchInMenu(page);
    const before = await size(menu);
    await expect(modeItem(page, 'Подробно')).toHaveAttribute('aria-checked', 'true');
    await modeItem(page, 'Кратко').click();
    await expect(modeItem(page, 'Кратко')).toHaveAttribute('aria-checked', 'true');
    // Ширина и высота переключателя те же; меню может сдвинуться на долю пикселя вместе с перерисованной страницей под ним.
    expect({ w: (await size(menu)).w, h: (await size(menu)).h }).toEqual({ w: before.w, h: before.h });
    await expect(modeItem(page, 'Подробно')).toHaveAttribute('aria-checked', 'false');
    // Выбор меню не закрывает: можно сразу сравнить с другим режимом.
    await expect(userMenu(page)).toBeVisible();
    const text = await page.getByTestId('request-page').innerText();
    await modeItem(page, 'Кратко').click();
    expect(await page.getByTestId('request-page').innerText()).toBe(text);
    await closeMenu(page);
    expect(page.url()).toBe(url);
  });

  for (const colorScheme of ['light', 'dark'] as const) {
    test(`нет нарушений axe у режима в меню профиля, ${colorScheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme });
      await openRequest(page, 'getCard', 'error');
      await modeSwitchInMenu(page);
      for (const mode of ['Подробно', 'Кратко'] as const) {
        await modeItem(page, mode).click();
        await expect(modeItem(page, mode)).toHaveAttribute('aria-checked', 'true');
        const r = await new AxeBuilder({ page }).include('[data-testid=user-menu-content] [data-testid=detail-switch]').withTags(['wcag2a', 'wcag2aa']).analyze();
        expect(r.violations).toEqual([]);
      }
    });
  }

  test('клавиатура в меню профиля: стрелки и Enter меняют режим, фокус на том же варианте, меню открыто', async ({ page }) => {
    await openRequest(page, 'getCard', 'error');
    await modeSwitchInMenu(page);
    // Пункты меню идут стрелками: Tab меню не обходит.
    await modeItem(page, 'Подробно').focus();
    await page.keyboard.press('ArrowDown');
    await expect(modeItem(page, 'Кратко')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(modeItem(page, 'Кратко')).toHaveAttribute('aria-checked', 'true');
    await expect(modeItem(page, 'Кратко')).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(modeItem(page, 'Подробно')).toBeFocused();
    await page.keyboard.press('Space');
    await expect(modeItem(page, 'Подробно')).toHaveAttribute('aria-checked', 'true');
    await expect(userMenu(page)).toBeVisible();
  });

  test('подсказка говорит, что это не защита: у строки меню профиля', async ({ page }) => {
    await search(page, 'getCard');
    // В меню подсказка у всей строки «Режим показа».
    const menu = await modeSwitchInMenu(page);
    await expect(menu.locator('xpath=..')).toHaveAttribute('title', /не защищены/);
  });

  test('на странице нет ни до поиска, ни у результатов, ни при пустом результате, в справочнике и на страницах проектов; в меню профиля есть', async ({ page }) => {
    await page.goto('/pay/demo');
    await expect(page.getByRole('textbox', { name: 'Значения для поиска' })).toBeVisible();
    await expect(sw(page)).toHaveCount(0);
    await search(page, 'getCard');
    await expect(rows(page).first()).toBeVisible();
    await expect(sw(page)).toHaveCount(0);
    await search(page, `пусто${Date.now().toString(36)}`);
    await expect(page.locator('[data-notice=empty]')).toBeVisible();
    await expect(sw(page)).toHaveCount(0);
    await page.goto('/pay/catalog');
    await expect(page.getByRole('main')).toBeVisible();
    await expect(sw(page)).toHaveCount(0);
    await page.goto('/admin/projects');
    await expect(page.getByRole('main')).toBeVisible();
    await expect(sw(page)).toHaveCount(0);
    // Выбор один на все проекты: строка режима в меню профиля есть и вне проекта.
    await expect(await modeSwitchInMenu(page)).toBeVisible();
    await closeMenu(page);
  });

  for (const width of [768, 1024, 1280, 2560]) {
    test(`${width}px: на результатах, запросе и операции режим только в меню профиля, прокрутки нет`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await search(page, 'pay.example');
      const row = page.getByRole('tab', { name: 'Запросы' }).locator('xpath=ancestor::div[contains(@class,"h-10")][1]');
      await expect(row).toHaveCount(1);
      await expect(page.getByRole('switch')).toBeVisible();
      await expect(sw(page)).toHaveCount(0);
      await expect(await modeSwitchInMenu(page)).toBeVisible();
      await closeMenu(page);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      expect(await row.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);

      await rows(page).first().locator('[data-row-link]').click(ROW_HIT);
      await expect(page.getByTestId('request-header')).toBeVisible();
      await expect(page.getByTestId('request-page').getByTestId('detail-switch')).toHaveCount(0);
      await expect(await modeSwitchInMenu(page)).toBeVisible();
      await closeMenu(page);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      const height = (await box(page.getByTestId('request-header'))).h;
      await choose(page, 'Кратко');
      expect((await box(page.getByTestId('request-header'))).h).toBe(height);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      await choose(page, 'Подробно');

      await page.goto(`/pay/demo/operations/transfer/${MOCK_FLOW.transfer}?at=${Date.now() - 9 * H}&w=6h`);
      await expect(page.getByTestId('operation-page')).toHaveAttribute('data-status', 'done', { timeout: 30_000 });
      await expect(sw(page)).toHaveCount(0);
      await expect(await modeSwitchInMenu(page)).toBeVisible();
      await closeMenu(page);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
    });
  }

  test('768px: на результатах помещаются вкладки, «Только с ошибкой · ошибок нет» и легенда статусов', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 900 });
    await page.route('**/api/searches/*', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const res = await route.fetch();
      const body = (await res.json()) as { requests: { status: string; reasons: unknown[] }[] };
      for (const r of body.requests ?? []) {
        r.status = 'success';
        r.reasons = [];
      }
      return route.fulfill({ response: res, json: body });
    });
    await search(page, 'pay.example');
    await expect(page.getByText('· ошибок нет', { exact: true })).toBeVisible();
    const row = page.getByRole('tab', { name: 'Запросы' }).locator('xpath=ancestor::div[contains(@class,"h-10")][1]');
    const r = await box(row);
    const label = await box(page.getByText('· ошибок нет', { exact: true }));
    expect(label.x + label.w).toBeLessThanOrEqual(r.x + r.w);
    expect(await row.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });

  test('768px: заголовок операции с длинным названием типа и короткий id видны целиком', async ({ page }) => {
    test.skip(!(await catalogOn(page)), 'нужен справочник: название типа');
    await page.setViewportSize({ width: 768, height: 900 });
    // В справочнике название короткое, как в демо: длинное подставляется в ответ поиска.
    await page.route('**/api/searches/*?*', async (r) => {
      const res = await r.fetch();
      const body = (await res.json()) as { operation?: { key: { name: string | null } } };
      if (body.operation) body.operation.key.name = LONG_TYPE;
      await r.fulfill({ response: res, json: body });
    });
    await page.goto(`/pay/demo/operations/card_payout/${MOCK_FLOW.payoutId}?at=${Date.now() - 9 * H}&w=6h`);
    await expect(page.getByTestId('operation-page')).toHaveAttribute('data-status', 'done', { timeout: 30_000 });
    for (const mode of ['Подробно', 'Кратко'] as const) {
      await choose(page, mode);
      const title = page.getByTestId('operation-title');
      await expect(title).toContainText(LONG_TYPE);
      const t = await box(title);
      expect(t.x + t.w).toBeLessThanOrEqual(768);
      expect(await title.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
    }
  });
});

test.describe('граф и панель шага в «Кратко»', () => {
  test('над графом число шагов шкалы, строка той же высоты, в «Подробно» кнопка логов работает', async ({ page }) => {
    await openRequest(page, 'getCard', 'error');
    const appLogs = page.getByTestId('app-logs');
    await expect(appLogs).toBeVisible();
    const card = await box(scheme(page));
    const bar = await box(appLogs.locator('..'));
    await appLogs.click();
    await expect(details(page)).toHaveAttribute('data-step', 'app');

    // Логи приложения были выбраны: в «Кратко» шаг по умолчанию, при возврате снова логи.
    await choose(page, 'Кратко');
    await expect(page.getByTestId('app-logs')).toHaveCount(0);
    await expect(details(page)).not.toHaveAttribute('data-step', 'app');
    const steps = page.getByTestId('flow-steps');
    await expect(steps).toHaveText(/\d+ шаг/);
    expect(await box(scheme(page))).toEqual(card);
    expect((await box(steps.locator('..'))).h).toBe(bar.h);
    const count = Number((await steps.innerText()).match(/\d+/)![0]);
    await viewTab(page, 'Шкала времени').click();
    await expect(timeline(page).getByRole('option')).toHaveCount(count);
    await viewTab(page, 'Схема').click();
    await choose(page, 'Подробно');
    await expect(details(page)).toHaveAttribute('data-step', 'app');
    await expect(page.getByTestId('app-logs')).toHaveAttribute('aria-pressed', 'true');
  });

  test('туда и обратно: шаг, строка ответа и раскрытые записи на месте; «Как в логе» в окне тела только в «Подробно»', async ({ page }) => {
    await openRequest(page, 'getCard', 'error');
    const step = await details(page).getAttribute('data-step');
    // Вид «как в логе» — в окне тела ответа. Окно модальное: режим меняется после его закрытия, вид окна живёт до закрытия.
    await openData(page, 'Ответ');
    const view = viewer(page).getByRole('group', { name: 'Вид', exact: true });
    await view.getByRole('button', { name: 'Как в логе' }).click();
    await expect(viewerCode(page)).toHaveAttribute('data-block', 'response');
    await expect(viewerCode(page)).toHaveAttribute('data-mode', 'raw');
    await closeViewer(page);
    await choose(page, 'Кратко');
    await expect(details(page)).toHaveAttribute('data-step', step!);
    await expect(dataRow(page, 'Ответ')).toBeVisible();
    // В «Кратко» тело только отформатированное: переключателя вида в окне нет.
    await openData(page, 'Ответ');
    await expect(viewerCode(page)).toHaveAttribute('data-mode', 'pretty');
    await expect(view).toHaveCount(0);
    await closeViewer(page);
    await choose(page, 'Подробно');
    await expect(details(page)).toHaveAttribute('data-step', step!);
    await openData(page, 'Ответ');
    await expect(view.getByRole('button', { name: 'Как в логе' })).toBeVisible();
    await closeViewer(page);

    // Открытая вкладка «Записи»: в «Кратко» её нет, при возврате снова она, раскрытое раскрыто.
    await viewTab(page, 'Записи').click();
    const list = page.getByRole('list', { name: 'Записи запроса' });
    await expect(list).toBeVisible();
    // Только кнопки строк записи: у блоков внутри раскрытой записи свои кнопки.
    const toggles = list.locator(':scope > li > div > button[aria-expanded]');
    const expanded = await list.locator(':scope > li > div > button[aria-expanded=true]').count();
    await toggles.and(page.locator('[aria-expanded=false]')).first().click();
    await choose(page, 'Кратко');
    await expect(viewTab(page, 'Записи')).toHaveCount(0);
    await expect(viewTab(page, 'Схема')).toHaveAttribute('aria-selected', 'true');
    await choose(page, 'Подробно');
    await expect(viewTab(page, 'Записи')).toHaveAttribute('aria-selected', 'true');
    await expect(list.locator(':scope > li > div > button[aria-expanded=true]')).toHaveCount(expanded + 1);
  });

  test('шкала: обычные логи скрыты, лог с ошибкой на месте, ось та же, стрелки только по видимым', async ({ page }) => {
    await openRequest(page, 'pay.example');
    await viewTab(page, 'Шкала времени').click();
    const total = await timeline(page).getByRole('option').count();
    const logs = timeline(page).locator('[data-kind=log]');
    const axis = await page.getByTestId('trace-axis').innerText();
    const logCount = await logs.count();
    const errorLogs = await timeline(page).locator('[data-kind=log][data-error]').count();
    // Выбранная запись-лог: в «Кратко» шаг по умолчанию, при возврате снова она.
    if (logCount > errorLogs) {
      const log = timeline(page).locator('[data-kind=log]:not([data-error])').first();
      await log.click();
      const id = await log.getAttribute('data-step');
      await choose(page, 'Кратко');
      await expect(details(page)).not.toHaveAttribute('data-step', id!);
      await choose(page, 'Подробно');
      await expect(details(page)).toHaveAttribute('data-step', id!);
    }
    await choose(page, 'Кратко');
    await expect(timeline(page).getByRole('option')).toHaveCount(total - logCount + errorLogs);
    await expect(timeline(page).locator('[data-kind=log]:not([data-error])')).toHaveCount(0);
    expect(await page.getByTestId('trace-axis').innerText()).toBe(axis);
    const options = timeline(page).getByRole('option');
    await options.first().focus();
    const n = await options.count();
    for (let i = 1; i < n; i++) {
      await page.keyboard.press('ArrowDown');
      await expect(options.nth(i)).toBeFocused();
    }
    await page.keyboard.press('ArrowDown');
    await expect(options.nth(n - 1)).toBeFocused();
  });

  test('панель: без адреса, параметров и статуса; строки «Запрос» у GET без тела нет; строка с кнопкой «Подробно»', async ({ page }) => {
    await openRequest(page, 'switch.pay.example', 'success');
    const graph = page.getByTestId('trace-scheme');
    await graph.locator('button[data-node][data-kind=entry]').first().click();
    await choose(page, 'Подробно');
    await expect(details(page).getByTestId('param-chips')).not.toHaveCount(0);
    await expect(details(page).getByTestId('step-address')).toBeVisible();
    await choose(page, 'Кратко');
    await expect(details(page).getByTestId('param-chips')).toHaveCount(0);
    await expect(details(page).getByTestId('step-address')).toHaveCount(0);
    await expect(dataRow(page, 'Запрос')).toHaveCount(0);
    await expect(details(page).getByTestId('step-title')).toBeVisible();
    await expect(details(page).getByTestId('step-more-details')).toBeVisible();
    await details(page).getByTestId('step-more-details').getByRole('button', { name: 'Подробно' }).click();
    await expectMode(page, 'Подробно');
    // Адрес — в сводке шага, а не строкой данных; в «Подробно» снова есть и он, и сырые записи.
    await expect(details(page).getByTestId('step-address')).toBeVisible();
    await expect(dataRow(page, 'Сырые записи')).toBeVisible();
  });

  test('итог: текст справочника и «что делать» без кода и партнёрского кода, действия только в «Подробно»', async ({ page }) => {
    test.skip(!(await catalogOn(page)), 'нужен справочник');
    await openRequest(page, 'Insufficient funds', 'error');
    const catalog = details(page).getByTestId('step-catalog');
    await expect(catalog).toBeVisible();
    await expect(details(page).getByTestId('step-raw')).toContainText('150');
    await choose(page, 'Кратко');
    await expect(catalog.getByTestId('step-action')).toBeVisible();
    await expect(catalog).not.toContainText('HTTP');
    await expect(details(page).getByTestId('step-raw')).not.toContainText('150');
    await expect(details(page).getByTestId('step-raw')).toContainText('Insufficient funds');
    await expect(details(page).getByTestId('step-outcome')).not.toContainText(/\b\d{3}\b.*·/);
    for (const id of ['step-catalog-add', 'step-catalog-edit', 'step-catalog-rule']) await expect(page.getByTestId(id)).toHaveCount(0);
    await choose(page, 'Подробно');
    await expect(page.getByTestId('step-catalog-edit').or(page.getByTestId('step-catalog-add')).or(page.getByTestId('step-catalog-rule')).first()).toBeVisible();
  });

  test('шаг, неизвестный справочнику: «Добавить в справочник» только в «Подробно»', async ({ page }) => {
    test.skip(!(await catalogOn(page)), 'нужен справочник');
    await openRequest(page, '/v1/payments/confirm');
    await viewTab(page, 'Шкала времени').click();
    await timeline(page).locator('[data-kind=exchange]').first().click();
    await expect(details(page).getByTestId('step-catalog-add')).toBeVisible();
    await choose(page, 'Кратко');
    await expect(details(page).getByTestId('step-catalog-add')).toHaveCount(0);
  });

  test('шапка: нет correlation_id, метки метода и параметров; цепочка без адресов; ссылка та же; нет предупреждений о ключах', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const warnings: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') warnings.push(m.text());
    });
    await openRequest(page, 'getCard', 'error');
    const header = page.getByTestId('request-header');
    await expect(page.getByTestId('request-cid')).toBeVisible();
    await page.getByRole('button', { name: 'Поделиться' }).click();
    await page.getByTestId('share-item-link').click();
    await expect(page.getByTestId('share-hint')).toContainText('Ссылка скопирована');
    await page.keyboard.press('Escape');
    const fullLink = await page.evaluate(() => navigator.clipboard.readText());
    await choose(page, 'Кратко');
    await expect(page.getByTestId('request-cid')).toHaveCount(0);
    await expect(header.getByTestId('param-chips')).toHaveCount(0);
    await expect(header.locator('h1 span[class*=font-mono]')).toHaveCount(0);
    await page.getByRole('button', { name: 'Поделиться' }).click();
    await page.getByTestId('share-item-link').click();
    await expect(page.getByTestId('share-hint')).toContainText('Ссылка скопирована');
    // Режима в ссылке нет: та же ссылка в обоих режимах.
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(fullLink);
    expect(fullLink).toMatch(/\/s\/[A-Za-z0-9_-]{22}$/);
    expect(warnings.filter((w) => /same key|уникальн/i.test(w))).toEqual([]);
  });
});

test.describe('список и сообщения в «Кратко»', () => {
  test('нет компонента, ID запроса и параметров; строки той же высоты, прокрутка на месте', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 700 });
    await search(page, 'pay.example');
    const n = await rows(page).count();
    expect(n).toBeGreaterThan(10);
    const height = (await box(rows(page).first())).h;
    await page.evaluate(() => window.scrollTo(0, 300));
    const at = await page.evaluate(() => window.scrollY);
    await expect(rows(page).first().getByTestId('request-cid')).toBeVisible();
    // Меню профиля в закреплённой шапке: выбор режима страницу не прокручивает.
    await choose(page, 'Кратко');
    await expect(rows(page).first().getByTestId('request-cid')).toHaveCount(0);
    await expect(rows(page).first().getByTestId('param-chip')).toHaveCount(0);
    await expect(rows(page)).toHaveCount(n);
    expect((await box(rows(page).first())).h).toBe(height);
    expect(await page.evaluate(() => window.scrollY)).toBe(at);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    // Легенда и фильтр на месте.
    await expect(page.getByRole('switch')).toBeVisible();
  });

  test('«Все записи»: смена режима и час времени не дают запроса строк', async ({ page }) => {
    await page.clock.install();
    await search(page, 'pay.example');
    const lines: string[] = [];
    page.on('request', (r) => {
      if (/\/lines(\?|$)/.test(r.url())) lines.push(r.url());
    });
    await page.getByRole('tab', { name: 'Все записи' }).click();
    await expect.poll(() => lines.length).toBe(1);
    await page.getByRole('tab', { name: 'Запросы' }).click();
    await page.getByRole('tab', { name: 'Все записи' }).click();
    lines.length = 0;

    await choose(page, 'Кратко');
    await expect(page.getByRole('tab', { name: 'Все записи' })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Запросы' })).toHaveAttribute('aria-selected', 'true');
    await page.clock.fastForward(H);
    await choose(page, 'Подробно');
    await expect(page.getByRole('tab', { name: 'Запросы' })).toHaveAttribute('aria-selected', 'true');
    await page.clock.fastForward(1000);
    expect(lines).toEqual([]);
  });

  test('«Все записи» открыты, режим сменили на странице запроса: при возврате запросов нет', async ({ page }) => {
    await search(page, 'getCard');
    await page.getByRole('tab', { name: 'Все записи' }).click();
    const list = page.getByRole('list', { name: 'Все найденные строки' });
    await expect(list).toBeVisible();
    // Запрос открыт прямо со вкладки «Все записи»: она запомнена в сессии поиска.
    await list.getByRole('link', { name: 'К запросу' }).first().dispatchEvent('click');
    await expect(page.getByTestId('request-header')).toBeVisible();
    const lines: string[] = [];
    page.on('request', (r) => {
      if (/\/lines(\?|$)/.test(r.url())) lines.push(r.url());
    });
    await choose(page, 'Кратко');
    await page.goBack();
    await expect(page.getByTestId('search-results')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('tab', { name: 'Все записи' })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Запросы' })).toHaveAttribute('aria-selected', 'true');
    await choose(page, 'Подробно');
    await expect(page.getByRole('tab', { name: 'Запросы' })).toHaveAttribute('aria-selected', 'true');
    expect(lines).toEqual([]);
  });

  test('«Все записи» открыты, режим сменили в другой вкладке браузера: запросов нет', async ({ page, context }) => {
    await search(page, 'getCard');
    await page.getByRole('tab', { name: 'Все записи' }).click();
    await expect(page.getByRole('list', { name: 'Все найденные строки' })).toBeVisible();
    const lines: string[] = [];
    page.on('request', (r) => {
      if (/\/lines(\?|$)/.test(r.url())) lines.push(r.url());
    });
    const other = await context.newPage();
    await other.goto('/pay/demo');
    // Выбор один на все проекты: в хранилище просто режим.
    await other.evaluate((key) => localStorage.setItem(key, 'brief'), VIEW_KEY);
    await expect(page.getByRole('tab', { name: 'Все записи' })).toHaveCount(0);
    await other.evaluate((key) => localStorage.setItem(key, 'full'), VIEW_KEY);
    await expectMode(page, 'Подробно');
    await expect(page.getByRole('tab', { name: 'Запросы' })).toHaveAttribute('aria-selected', 'true');
    expect(lines).toEqual([]);
    await other.close();
  });

  test('только строки без запросов: вкладки нет, слова correlation_id нет, «Подробно» открывает строки', async ({ page }) => {
    await page.addInitScript((key) => localStorage.setItem(key, 'brief'), VIEW_KEY);
    const lines: string[] = [];
    page.on('request', (r) => {
      if (/\/lines(\?|$)/.test(r.url())) lines.push(r.url());
    });
    await search(page, 'PHP Warning');
    const notice = page.locator('[data-notice=only-lines]');
    await expect(notice).toBeVisible();
    await expect(notice).not.toContainText('correlation_id');
    await expect(page.getByRole('tab', { name: 'Все записи' })).toHaveCount(0);
    expect(lines).toEqual([]);
    await notice.getByRole('button', { name: 'Подробно' }).click();
    await expect(page.getByRole('list', { name: 'Все найденные строки' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Все записи' })).toHaveAttribute('aria-selected', 'true');
  });

  test('слишком много запросов: строки про вкладку нет, кнопка «Подробно» ведёт к ней', async ({ page }) => {
    await page.route('**/api/searches/*', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const res = await route.fetch();
      return route.fulfill({ response: res, json: { ...(await res.json()), tooMany: true, found: 5000, scannedFromMs: Date.now() - H } });
    });
    await search(page, 'getCard');
    const notice = page.locator('[data-notice=too-many]');
    await expect(notice).toContainText('Найденные строки можно посмотреть');
    await choose(page, 'Кратко');
    await expect(notice).not.toContainText('Найденные строки можно посмотреть');
    await notice.getByRole('button', { name: 'Подробно' }).click();
    await expectMode(page, 'Подробно');
  });

  test('ошибка поиска: заголовок и «Повторить» на месте, раскрывашки нет', async ({ page }) => {
    await page.route('**/api/searches/*', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const res = await route.fetch();
      return route.fulfill({ response: res, json: { ...(await res.json()), error: { code: 'network', stage: 'fetch', details: 'синтетические подробности' } } });
    });
    await search(page, 'getCard');
    const notice = page.locator('[data-notice=error]');
    await expect(notice.locator('details')).toBeAttached();
    await choose(page, 'Кратко');
    await expect(notice.locator('details')).toHaveCount(0);
    await expect(notice.getByRole('button', { name: 'Повторить' })).toBeVisible();
  });

  test('ссылка во внешний интерфейс и сводка совпадений: только в «Подробно», высота та же; на запросе ссылка в меню «⋯»', async ({ page }) => {
    const explore = { url: 'https://grafana.example.internal/explore', store: 'grafana', label: 'Grafana' };
    await page.route('**/api/searches/**', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const res = await route.fetch();
      const body = (await res.json()) as object;
      if (/\/lines/.test(route.request().url())) return route.fulfill({ response: res, json: body });
      return route.fulfill({ response: res, json: { ...body, explore } });
    });
    await search(page, 'getCard');
    const link = page.getByRole('link', { name: /Grafana/ });
    await expect(link).toBeVisible();
    const top = await box(page.getByTestId('results-summary'));
    await choose(page, 'Кратко');
    await expect(link).toHaveCount(0);
    expect((await box(page.getByTestId('results-summary'))).y).toBe(top.y);
    await rows(page).first().locator('[data-row-link]').click(ROW_HIT);
    await expect(page.getByTestId('request-header')).toBeVisible();
    await expect(page.getByTestId('hit-summary')).toHaveCount(0);
    // На запросе ссылка — пункт меню «⋯». В «Кратко» её нет, а на широком окне больше в меню ничего нет: нет и самого меню.
    await expect(page.getByTestId('request-more')).toHaveCount(0);
    await expect(page.getByRole('link', { name: /Grafana/ })).toHaveCount(0);
    await choose(page, 'Подробно');
    await expect(page.getByTestId('hit-summary')).toBeVisible();
    const more = await openMore(page);
    await expect(more.getByRole('link', { name: /Grafana/ })).toBeVisible();
  });
});

test.describe('ни запросов, ни сдвигов', () => {
  /** Двадцать смен подряд. На странице запроса — в меню профиля: меню открыто до счёта, выбор его не закрывает. */
  const twenty = async (page: Page, seen: string[]) => {
    const inline = (await modeButton(page, 'Кратко').count()) > 0;
    if (!inline) await openUserMenu(page);
    const item = (name: ViewModeName) => (inline ? modeButton(page, name) : modeItem(page, name));
    seen.length = 0;
    for (let i = 0; i < 10; i++) {
      await item('Кратко').click();
      await item('Подробно').click();
    }
    if (!inline) await closeMenu(page);
  };

  test('двадцать смен режима на всех экранах дают ноль запросов и ни одной заготовки', async ({ page }) => {
    await search(page, 'pay.example');
    // Код кнопки «Поделиться» грузится один раз при открытии результатов, смена режима тут ни при чём.
    await expect(page.getByTestId('share-button')).toBeVisible();
    const seen = requestsOf(page);
    await twenty(page, seen);
    expect(seen).toEqual([]);

    await rows(page).first().locator('[data-row-link]').click(ROW_HIT);
    await expect(page.getByTestId('flow-canvas')).toBeVisible({ timeout: 15_000 });
    await page.waitForLoadState('networkidle');
    await twenty(page, seen);
    expect(seen).toEqual([]);
    await expect(page.getByTestId('request-skeleton')).toHaveCount(0);

    // По ссылке: данные прочитаны один раз, смена режима их не перечитывает.
    const link = page.url();
    await page.goto(link);
    await expect(page.getByTestId('flow-canvas')).toBeVisible({ timeout: 15_000 });
    await page.waitForLoadState('networkidle');
    await twenty(page, seen);
    expect(seen).toEqual([]);

    await page.goto(`/pay/demo/operations/transfer/${MOCK_FLOW.transfer}?at=${Date.now() - 9 * H}&w=6h`);
    await expect(page.getByTestId('operation-page')).toHaveAttribute('data-status', 'done', { timeout: 30_000 });
    await page.waitForLoadState('networkidle');
    await twenty(page, seen);
    expect(seen).toEqual([]);
  });

  const widths = [768, 1024, 1280, 1440, 2560];
  for (const width of widths) {
    test(`${width}px: шапка, причины, вкладки, граф и узлы на месте в обоих режимах`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openRequest(page, 'getCard', 'error');
      const measure = async () => ({
        header: await box(page.getByTestId('request-header')),
        reasons: await box(page.getByTestId('request-reasons')),
        tabs: await box(page.getByRole('tab', { name: /^Схема/ }).locator('xpath=ancestor::div[contains(@class,"h-10")][1]')),
        card: await box(scheme(page)),
        nodes: await graphNodes(page).evaluateAll((els) => els.map((el) => {
          const r = el.getBoundingClientRect();
          return [el.getAttribute('data-node'), Math.round(r.x), Math.round(r.y), r.width, r.height];
        })),
      });
      const full = await measure();
      await choose(page, 'Кратко');
      expect(await measure()).toEqual(full);
      await choose(page, 'Подробно');
      expect(await measure()).toEqual(full);
    });

    test(`${width}px: заголовок операции и окно на месте`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/pay/demo/operations/transfer/${MOCK_FLOW.transfer}?at=${Date.now() - 9 * H}&w=6h`);
      await expect(page.getByTestId('operation-page')).toHaveAttribute('data-status', 'done', { timeout: 30_000 });
      const measure = async () => ({
        title: await box(page.getByTestId('operation-title')),
        window: await box(page.getByRole('group', { name: 'Окно поиска' })),
      });
      const full = await measure();
      await choose(page, 'Кратко');
      expect(await measure()).toEqual(full);
    });

    test(`${width}px: строки списка на месте`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await search(page, 'pay.example');
      const measure = async () => ({
        rows: await rows(page).evaluateAll((els) => els.map((el) => {
          const r = el.getBoundingClientRect();
          return [Math.round(r.y), r.height];
        })),
      });
      const full = await measure();
      await choose(page, 'Кратко');
      expect(await measure()).toEqual(full);
    });
  }

  test('768px с полосой прокрутки 17px: шапка и вкладки на месте, прокрутки вбок нет', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 900 });
    await openRequest(page, 'getCard', 'error');
    await page.addStyleTag({ content: 'html{overflow-y:scroll} ::-webkit-scrollbar{width:17px}' });
    // Переключателя на странице запроса нет: он в меню профиля, меню на месте страницы не занимает.
    const measure = async () => ({ header: await box(page.getByTestId('request-header')), card: await box(scheme(page)) });
    const full = await measure();
    await choose(page, 'Кратко');
    expect(await measure()).toEqual(full);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });
});

test.describe('адреса не остаются', () => {
  const IP = '10.77.0.1';
  const HOST = 'x-unique-host.partner.example';
  const CODE = 'HTTP 599';

  async function substitute(page: Page) {
    await page.route('**/api/**', async (route) => {
      const url = route.request().url();
      if (route.request().method() !== 'GET' || !/\/(requests|searches)\b/.test(url)) return route.continue();
      const res = await route.fetch();
      const text = (await res.text())
        .replaceAll('processor.pay.example', IP)
        .replaceAll('switch.pay.example', HOST)
        .replaceAll('api.acquirer.example', IP)
        .replaceAll('HTTP 500', CODE)
        .replaceAll('"status":500', '"status":599');
      return route.fulfill({ response: res, body: text });
    });
  }

  /** Обход всех шагов запроса и их данных в текущем режиме: панель шага и окно тела каждой строки данных. */
  async function walk(page: Page) {
    const out: string[] = [];
    const steps = async () => {
      const options = timeline(page).getByRole('option');
      const n = await options.count();
      for (let i = 0; i < n; i++) {
        await options.nth(i).click();
        out.push(...(await leaks(page, [IP, HOST, CODE, cidOf])));
        const data = details(page).getByTestId('data-row');
        const m = await data.count();
        for (let j = 0; j < m; j++) {
          await data.nth(j).click();
          await expect(viewer(page)).toBeVisible();
          out.push(...(await leaks(page, [IP, HOST, CODE, cidOf])));
          await closeViewer(page);
        }
      }
    };
    let cidOf = '';
    cidOf = (await page.locator('[data-testid=request-page]').count()) ? new URL(page.url()).pathname.split('/').pop()! : '';
    out.push(...(await leaks(page, [IP, HOST, CODE, cidOf])));
    await viewTab(page, 'Шкала времени').click();
    await steps();
    await viewTab(page, 'Схема').click();
    out.push(...(await leaks(page, [IP, HOST, CODE, cidOf])));
    return [...new Set(out)];
  }

  test('запрос с обменом по IP и по хосту: в «Кратко» их нет, в «Подробно» есть', async ({ page }) => {
    await substitute(page);
    await search(page, 'getCard');
    // В строке списка хост причины уже подменён.
    const errorRow = rows(page).and(page.locator('[data-status=error]')).first();
    const fullRow = (await errorRow.getByTestId('request-reason').getAttribute('title')) ?? '';
    expect(fullRow).toContain(IP);
    await choose(page, 'Кратко');
    expect(await leaks(page, [IP, HOST, CODE])).toEqual([]);
    await errorRow.locator('[data-row-link]').click(ROW_HIT);
    await expect(page.getByTestId('flow-canvas')).toBeVisible({ timeout: 15_000 });
    expect(await walk(page)).toEqual([]);
    await choose(page, 'Подробно');
    expect((await leaks(page, [IP])).length).toBeGreaterThan(0);
  });

  test('HTTP 599 и хост: только смыслом', async ({ page }) => {
    await substitute(page);
    await search(page, 'api.acquirer.example');
    const errorRow = rows(page).and(page.locator('[data-status=error]')).first();
    expect((await errorRow.getByTestId('request-reason').getAttribute('title')) ?? '').toContain(CODE);
    await choose(page, 'Кратко');
    expect(await leaks(page, [IP, HOST, CODE])).toEqual([]);
    await errorRow.locator('[data-row-link]').click(ROW_HIT);
    await expect(page.getByTestId('flow-canvas')).toBeVisible({ timeout: 15_000 });
    expect(await walk(page)).toEqual([]);
  });

  test('страница операции: хоста и IP нет ни в строках, ни в подсказках, в «Подробно» они есть', async ({ page }) => {
    await page.route('**/api/searches/*', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const res = await route.fetch();
      const text = (await res.text()).replaceAll('ledger.pay.example', IP).replaceAll('payout.pay.example', HOST);
      return route.fulfill({ response: res, body: text });
    });
    await page.goto(`/pay/demo/operations/transfer/${MOCK_FLOW.transfer}?at=${Date.now() - 9 * H}&w=6h`);
    await expect(page.getByTestId('operation-page')).toHaveAttribute('data-status', 'done', { timeout: 30_000 });
    await choose(page, 'Кратко');
    expect(await leaks(page, [IP, HOST, MOCK_FLOW.transfer])).toEqual([]);
    await choose(page, 'Подробно');
    expect((await leaks(page, [MOCK_FLOW.transfer])).length).toBeGreaterThan(0);
  });

  test('хост без справочника: короткое имя, порта и домена нет', async ({ page }) => {
    await substitute(page);
    await search(page, 'switch.pay.example');
    await choose(page, 'Кратко');
    await rows(page).first().locator('[data-row-link]').click(ROW_HIT);
    await expect(page.getByTestId('flow-canvas')).toBeVisible({ timeout: 15_000 });
    expect(await walk(page)).toEqual([]);
    await expect(page.getByTestId('request-chain')).toContainText('x-unique-host');
    await expect(page.getByTestId('request-chain')).not.toContainText('partner.example');
  });
});

test.describe('ссылка и память', () => {
  test('ссылка из «Кратко» открывается в новом контексте в режиме проекта, адрес без режима', async ({ page, browser }) => {
    await openRequest(page, 'getCard', 'error');
    await choose(page, 'Кратко');
    const url = page.url();
    expect(url).not.toMatch(/brief|view=/);
    const other = await browser.newContext({ baseURL: new URL(url).origin, locale: 'ru-RU' });
    const colleague = await other.newPage();
    await colleague.goto(url);
    await expect(colleague.getByTestId('request-cid')).toBeVisible({ timeout: 15_000 });
    await expectMode(colleague, 'Подробно');
    await other.close();
  });

  test('после перезагрузки в «Кратко» элемента request-cid не было ни разу', async ({ page }) => {
    await openRequest(page, 'getCard', 'error');
    await choose(page, 'Кратко');
    const link = page.url();
    await page.addInitScript(() => {
      (window as unknown as { __cid: boolean }).__cid = false;
      new MutationObserver(() => {
        if (document.querySelector('[data-testid=request-cid]')) (window as unknown as { __cid: boolean }).__cid = true;
      }).observe(document, { childList: true, subtree: true });
    });
    await page.goto(link);
    await expect(page.getByTestId('request-header')).toBeVisible({ timeout: 15_000 });
    await expectMode(page, 'Кратко');
    expect(await page.evaluate(() => (window as unknown as { __cid: boolean }).__cid)).toBe(false);
  });

  test('другая вкладка следует выбору без запросов', async ({ page, context }) => {
    await openRequest(page, 'getCard', 'error');
    const url = page.url();
    const other = await context.newPage();
    await other.goto(url);
    await expect(other.getByTestId('request-cid')).toBeVisible({ timeout: 15_000 });
    await other.waitForLoadState('networkidle');
    const seen = requestsOf(other);
    await choose(page, 'Кратко');
    await expect(other.getByTestId('request-cid')).toHaveCount(0);
    expect(seen).toEqual([]);
    await expectMode(other, 'Кратко');
    await other.close();
  });

  test('запрет localStorage: переключатель работает, ошибок нет, после перезагрузки выбора нет', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        get() {
          throw new Error('запрещено');
        },
      });
    });
    await openRequest(page, 'getCard', 'error');
    await choose(page, 'Кратко');
    await expect(page.getByTestId('request-cid')).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId('request-cid')).toBeVisible({ timeout: 15_000 });
    await expectMode(page, 'Подробно');
    expect(errors).toEqual([]);
  });

  // Прежняя запись по проектам выбором не считается, как и мусор.
  for (const [what, stored] of [['мусор в ключе', '{не json'], ['прежняя запись по проектам', '{"pay":"brief"}']] as const) {
    test(`${what}: режим проекта, следующая смена перезаписывает одним значением на все проекты`, async ({ page }) => {
      await page.goto('/pay/demo');
      await page.evaluate(([key, value]) => localStorage.setItem(key, value), [VIEW_KEY, stored] as const);
      await openRequest(page, 'getCard', 'error');
      await expect(page.getByTestId('request-cid')).toBeVisible();
      await expectMode(page, 'Подробно');
      await choose(page, 'Кратко');
      expect(await page.evaluate((key) => localStorage.getItem(key), VIEW_KEY)).toBe('brief');
    });
  }
});
