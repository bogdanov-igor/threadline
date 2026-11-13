import { expect, test, type Page } from '@playwright/test';
import { helpButton } from './helpers.ts';

// Клавиатура и проверка полей: год из шести цифр (202333), порядок Tab, Enter, горячие клавиши.

const DAY_MS = 24 * 60 * 60 * 1000;
const TZ = 'Asia/Karachi';

const period = (page: Page) => page.getByRole('group', { name: 'Период' });
const dialog = (page: Page) => page.getByRole('dialog');
const start = (page: Page) => dialog(page).getByLabel('Начало');
const end = (page: Page) => dialog(page).getByLabel('Конец');
const apply = (page: Page) => dialog(page).getByRole('button', { name: 'Применить' });
const cancel = (page: Page) => dialog(page).getByRole('button', { name: 'Отмена' });

async function openPeriod(page: Page) {
  await page.goto('/pay/demo');
  await period(page).getByRole('button', { name: /^Свой/ }).click();
  await expect(start(page)).toBeFocused();
}

/** Значение поля в поясе проекта. */
function localValue(ms: number): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/** Нажатие как на русской раскладке: физическая клавиша та же, символ другой. */
const pressRussian = (page: Page, code: string, key: string, shiftKey = false) =>
  page.evaluate(([c, k, s]) => (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { code: c as string, key: k as string, shiftKey: s === 'y', bubbles: true, cancelable: true })), [code, key, shiftKey ? 'y' : 'n']);

async function openRequest(page: Page) {
  await page.goto('/pay/demo');
  const input = page.getByRole('textbox', { name: 'Значения для поиска' });
  await input.fill('getCard');
  await input.press('Enter');
  await period(page).getByRole('button', { name: '24 ч', exact: true }).click();
  await page.getByRole('button', { name: 'Найти', exact: true }).click();
  await expect(page.getByTestId('search-results')).toHaveAttribute('data-status', 'done', { timeout: 20_000 });
  await page.getByRole('list', { name: 'Найденные запросы' }).getByRole('listitem').first().locator('[data-row-link]').click({ position: { x: 8, y: 8 } });
  await expect(page.getByTestId('request-header')).toBeVisible();
  await expect(page.getByTestId('flow-canvas')).toBeVisible({ timeout: 15_000 });
}

test.describe('поля даты: год из шести цифр', () => {
  test('год 202333 ввести нельзя: после четвёртой цифры курсор уходит к часам', async ({ page }) => {
    await openPeriod(page);
    await page.keyboard.type('06112023');
    await page.keyboard.type('33');
    // Порядок дня и месяца зависит от языка браузера, год нет: шесть цифр в него не поместились.
    await expect(start(page)).toHaveValue(/^2023-/);
    await expect(start(page)).toHaveAttribute('max', '2099-12-31T23:59');
    await expect(start(page)).toHaveAttribute('min', '2000-01-01T00:00');
  });

  test('Tab: Начало, Конец, Применить, Отмена; на экране кнопки на своих местах', async ({ page }) => {
    await openPeriod(page);
    await page.keyboard.press('Tab');
    await expect(end(page)).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(apply(page)).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(cancel(page)).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(apply(page)).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(end(page)).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(start(page)).toBeFocused();
    const a = (await apply(page).boundingBox())!;
    const c = (await cancel(page).boundingBox())!;
    expect(c.x + c.width).toBeLessThanOrEqual(a.x);
  });

  test('значок календаря нажимается мышью и не занимает остановку Tab', async ({ page }) => {
    await openPeriod(page);
    const calendar = dialog(page).getByTestId('date-time-calendar').first();
    await expect(calendar).toHaveAttribute('tabindex', '-1');
    await page.evaluate(() => {
      (window as unknown as { pickerOpened: number }).pickerOpened = 0;
      HTMLInputElement.prototype.showPicker = function () {
        (window as unknown as { pickerOpened: number }).pickerOpened++;
      };
    });
    await calendar.click();
    expect(await page.evaluate(() => (window as unknown as { pickerOpened: number }).pickerOpened)).toBe(1);
  });

  test('Enter применяет период, Esc закрывает и возвращает фокус', async ({ page }) => {
    await openPeriod(page);
    const now = Date.now();
    await start(page).fill(localValue(now - 2 * 60 * 60 * 1000));
    await end(page).fill(localValue(now - 60 * 60 * 1000));
    await end(page).press('Enter');
    await expect(dialog(page)).toBeHidden();
    await expect(period(page).getByRole('button', { name: /^Свой/ })).toHaveAttribute('aria-pressed', 'true');
    await expect(period(page).getByRole('button', { name: /^Свой/ })).toBeFocused();

    await period(page).getByRole('button', { name: /^Свой/ }).press('Enter');
    await expect(start(page)).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeHidden();
    await expect(period(page).getByRole('button', { name: /^Свой/ })).toBeFocused();
  });

  test('начало позже конца: сообщение, окно открыто, фокус на начале', async ({ page }) => {
    await openPeriod(page);
    const now = Date.now();
    await start(page).fill(localValue(now - 60 * 60 * 1000));
    await end(page).fill(localValue(now - 2 * 60 * 60 * 1000));
    await end(page).focus();
    await page.keyboard.press('Enter');
    await expect(dialog(page).getByRole('alert')).toHaveText(/Начало позже конца/);
    await expect(start(page)).toBeFocused();
    await expect(start(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(end(page)).not.toHaveAttribute('aria-invalid', 'true');
  });

  test('пустой конец и год вне границ: своё сообщение и фокус на неверном поле', async ({ page }) => {
    await openPeriod(page);
    await end(page).fill('');
    await apply(page).click();
    await expect(dialog(page).getByRole('alert')).toHaveText(/Укажите дату и время/);
    await expect(end(page)).toBeFocused();
    await end(page).fill(localValue(Date.now()));
    await start(page).fill('1999-01-01T00:00');
    await apply(page).click();
    await expect(dialog(page).getByRole('alert')).toHaveText(/Год должен быть от 2000 до 2099/);
    await expect(start(page)).toBeFocused();
  });

  test('сервер и адрес: год 202333 получает отказ, в хранилище запроса нет', async ({ page, request }) => {
    const junk = Date.UTC(2099, 11, 31) + 200_000 * 365 * DAY_MS;
    const res = await request.post('/api/projects/pay/envs/demo/searches', { data: { terms: ['getCard'], period: { fromMs: junk, toMs: junk + 1000 } } });
    expect(res.status()).toBe(400);
    const body = (await res.json()) as { error: { code: string; details: string } };
    expect(body.error.code).toBe('invalid-period');
    expect(body.error.details).toContain('от 2000 до 2099');

    const link = await request.get(`/api/projects/pay/envs/demo/requests/c1?from=${junk}&to=${junk + 1000}`);
    expect(link.status()).toBe(400);

    // Огромное число не роняет запись короткой ссылки: тот же отказ, а не ошибка базы.
    const share = await request.post('/api/share', { data: { kind: 'request', project: 'pay', env: 'demo', cid: 'c1', fromMs: 1e300, toMs: 1e300 } });
    expect(share.status()).toBe(400);

    const asked: string[] = [];
    page.on('request', (r) => asked.push(r.url()));
    await page.goto(`/pay/demo/requests/c1?from=${junk}&to=${junk + 1000}`);
    await expect(page.getByRole('heading', { name: /ссылк/i })).toBeVisible();
    expect(asked.filter((u) => u.includes('/requests/c1') && u.includes('/api/'))).toEqual([]);
  });
});

test.describe('горячие клавиши', () => {
  test('? открывает окно, Esc закрывает; то же из меню «Справка»', async ({ page }) => {
    await page.goto('/pay/demo');
    await expect(page.getByRole('textbox', { name: 'Значения для поиска' })).toBeVisible();
    await page.keyboard.press('Shift+Slash');
    const keys = page.getByTestId('keys-dialog');
    await expect(keys).toBeVisible();
    await expect(keys).toContainText('Следующий шаг');
    await page.keyboard.press('Escape');
    await expect(keys).toBeHidden();

    await helpButton(page).click();
    await expect(page.getByTestId('header-keys')).toContainText('?');
    await page.getByTestId('header-keys').click();
    await expect(keys).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(keys).toBeHidden();
    await expect(helpButton(page)).toBeFocused();
  });

  test('/ ставит фокус в поле поиска и не печатается; русская раскладка; в поле буквы остаются текстом', async ({ page }) => {
    await page.goto('/pay/demo');
    const input = page.getByRole('textbox', { name: 'Значения для поиска' });
    await expect(input).toBeVisible();
    await input.blur();
    await page.keyboard.press('Slash');
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('');
    await page.keyboard.type('jk?/');
    await expect(input).toHaveValue('jk?/');
    await page.keyboard.press('Escape');
    await expect(input).not.toBeFocused();
    await pressRussian(page, 'Slash', '.');
    await expect(input).toBeFocused();
    await input.blur();
    await pressRussian(page, 'Digit7', '?', true);
    await expect(page.getByTestId('keys-dialog')).toBeVisible();
  });

  test('J и K переключают шаг, на краю остаются; с Ctrl и в открытом меню молчат; L и T копируют', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openRequest(page);
    await page.getByRole('tab', { name: /^Шкала времени/ }).click();
    const selected = page.getByRole('listbox', { name: 'Шаги трассы' }).locator('[role=option][aria-selected=true]');
    await expect(selected).toHaveCount(1);
    const all = await page.getByRole('listbox', { name: 'Шаги трассы' }).locator('[role=option]').evaluateAll((els) => els.map((el) => el.getAttribute('data-step')));
    expect(all.length).toBeGreaterThan(1);
    const stepOf = () => selected.getAttribute('data-step');
    await page.getByRole('heading', { level: 1 }).click();

    for (let i = 0; i < all.length; i++) await page.keyboard.press('KeyK');
    expect(await stepOf()).toBe(all[0]);
    await page.keyboard.press('KeyJ');
    expect(await stepOf()).toBe(all[1]);
    await pressRussian(page, 'KeyK', 'л');
    expect(await stepOf()).toBe(all[0]);
    await page.keyboard.press('Control+KeyJ');
    expect(await stepOf()).toBe(all[0]);

    await page.getByTestId('share-button').first().click();
    await expect(page.getByTestId('share-menu')).toBeVisible();
    await page.getByTestId('share-menu').press('KeyJ');
    await expect(page.getByTestId('share-menu')).toBeVisible();
    await page.keyboard.press('Escape');
    expect(await stepOf()).toBe(all[0]);

    await page.getByRole('heading', { level: 1 }).click();
    await page.keyboard.press('KeyL');
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toMatch(/\/s\/[A-Za-z0-9_-]+$/);
    await page.keyboard.press('KeyT');
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('ID запроса');
  });

  test('граф: фокус на узле идёт за выбором, стрелки дальше работают', async ({ page }) => {
    await openRequest(page);
    const nodes = page.locator('button[data-node]');
    await nodes.first().waitFor();
    await page.locator('button[data-node][tabindex="0"]').focus();
    const pressed = () => page.locator('button[data-node][aria-pressed=true]').first().getAttribute('data-node');
    const before = await pressed();
    await page.keyboard.press(before === (await nodes.first().getAttribute('data-node')) ? 'KeyJ' : 'KeyK');
    await expect.poll(pressed).not.toBe(before);
    await expect(page.locator('button[data-node][aria-pressed=true]').first()).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('button[data-node][aria-pressed=true]').first()).toBeFocused();
  });

  test('CodeMirror: буквы и «/» печатаются, клавиши не срабатывают', async ({ page, request }) => {
    const res = await request.get('/api/projects/pay/catalog');
    test.skip(!res.ok(), 'без базы справочника');
    await page.goto('/pay/settings/file');
    const content = page.locator('.cm-content');
    await expect(content).toBeVisible({ timeout: 15_000 });
    await content.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('# jklt/');
    await expect(content).toContainText('# jklt/');
    await expect(page.getByTestId('keys-dialog')).toHaveCount(0);
  });

  test('окно тела: J и K листают шаги, окно остаётся; Esc закрывает его первым, фокус в панели шага', async ({ page }) => {
    await openRequest(page);
    const viewer = page.getByTestId('body-viewer');
    await page.getByTestId('step-details').getByTestId('data-row').first().click();
    await expect(viewer).toBeVisible();
    const step = (await viewer.getAttribute('data-step'))!;
    // У первого шага предыдущего нет: тогда вперёд.
    await page.keyboard.press((await page.getByTestId('viewer-prev').isDisabled()) ? 'KeyJ' : 'KeyK');
    await expect(viewer).not.toHaveAttribute('data-step', step);
    await expect(viewer).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(viewer).toHaveCount(0);
    // Строка данных, с которой открыли окно, ушла вместе со шагом: фокус на панели.
    await expect(page.getByTestId('step-details')).toBeFocused();
  });
});

test.describe('формы', () => {
  test('панель системы: фокус на первом поле, неверное поле получает фокус, Ctrl+Enter отправляет из многострочного поля, Esc возвращает фокус', async ({ page, request }) => {
    const res = await request.get('/api/projects/pay/catalog');
    test.skip(!res.ok(), 'без базы справочника');
    await page.goto('/pay/catalog');
    const add = page.getByTestId('catalog-add-system').first();
    await add.click();
    const form = page.getByTestId('catalog-form');
    const name = form.getByLabel('Название');
    await expect(name).toBeFocused();
    await name.fill('   ');
    await name.press('Enter');
    await expect(name).toHaveAttribute('aria-invalid', 'true');
    await expect(name).toBeFocused();
    await name.fill('Система клавиатуры');
    const description = form.getByLabel(/Описание/);
    await description.fill('первая строка');
    await description.press('Enter');
    await expect(description).toHaveValue('первая строка\n');
    await description.press('Control+Enter');
    const key = form.getByLabel(/Ключ/);
    await expect(key).toHaveAttribute('aria-invalid', 'true');
    await expect(key).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(form).toBeHidden();
    await expect(add).toBeFocused();
  });

  test('значения поиска: Tab мимо крестиков, стрелка и Delete убирают значение, Ctrl+Enter ищет сразу', async ({ page }) => {
    await page.goto('/pay/demo');
    const input = page.getByRole('textbox', { name: 'Значения для поиска' });
    await input.fill('abcdef,qwerty');
    await input.press('Enter');
    await expect(page.getByTestId('term-chip')).toHaveCount(2);
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByRole('button', { name: 'Убрать значение qwerty' })).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByRole('button', { name: 'Убрать значение abcdef' })).toBeFocused();
    await page.keyboard.press('Delete');
    await expect(page.getByTestId('term-chip')).toHaveCount(1);
    await input.focus();
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByRole('button', { name: /^Убрать значение/ })).not.toBeFocused();
    await input.fill('getCard');
    await input.press('Control+Enter');
    await expect(page).toHaveURL(/\?search=/);
  });

  test('срок хранения принимает только цифры', async ({ page }) => {
    await page.goto('/admin/projects/new');
    const days = page.getByTestId('project-retention');
    await days.fill('');
    await days.pressSequentially('-1e5.x');
    await expect(days).toHaveValue('15');
  });

  test('настройка сервиса: 0 отклонён у поля, Enter сохраняет', async ({ page, request }) => {
    const settings = await request.get('/api/settings');
    test.skip(!settings.ok() || !((await settings.json()) as { editable: boolean }).editable, 'без базы настроек');
    await page.goto('/admin/status');
    // Раздел «Общие» — одна форма: кнопка «Сохранить» и отметка «Сохранено» у формы, а не у строки.
    const form = page.getByTestId('settings-form');
    const row = page.getByTestId('setting-share-lifetimeDays');
    const input = row.getByTestId('setting-input');
    await input.fill('0');
    await expect(row.getByTestId('setting-invalid')).toBeVisible();
    await input.press('Enter');
    await expect(form.getByTestId('setting-saved')).toHaveCount(0);
    await input.fill('31');
    await input.press('Enter');
    await expect(form.getByTestId('setting-saved')).toBeVisible();
    await row.getByTestId('setting-reset').click();
    await form.getByTestId('setting-save').click();
    await expect(form.getByTestId('setting-saved')).toBeVisible();
  });

  test('сообщить о проблеме: фокус в поле, Tab на «Отправить», затем «Отмена», Esc возвращает фокус', async ({ page }) => {
    await page.goto('/pay/demo');
    await helpButton(page).click();
    await page.getByTestId('header-report').click();
    const text = page.getByTestId('report-text');
    await expect(text).toBeFocused();
    await text.fill('описание');
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('report-send')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('report-cancel')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(helpButton(page)).toBeFocused();
  });
});
