import { expect, test as base, type APIRequestContext, type Page } from '@playwright/test';

// Формы редактора через настоящий API. Каждый тест работает в своей системе и убирает её за собой:
// наборы идут параллельно на одном сервере. Без базы набор пропускается.

interface Row {
  id: number;
  key?: string;
  name?: string;
  path?: string;
  updatedAt: string;
}

const API = '/api/projects/pay/catalog';
const FAKE_PAN = '4000000000000002';

async function post(request: APIRequestContext, section: string, data: unknown): Promise<Row> {
  const res = await request.post(`${API}/${section}`, { data });
  expect(res.status(), `${section}: ${await res.text()}`).toBe(201);
  return (await res.json()) as Row;
}

const del = (request: APIRequestContext, section: string, row: Row) => request.delete(`${API}/${section}/${row.id}?updatedAt=${encodeURIComponent(row.updatedAt)}`);

/** Записи больше нет: удаление всегда мягкое, строку стирает только удаление навсегда. */
async function delForever(request: APIRequestContext, section: string, row: Row) {
  const soft = await del(request, section, row);
  expect(soft.ok()).toBe(true);
  const c = (await (await request.get(API)).json()) as Record<'methods', Row[]>;
  const hidden = c.methods.find((x) => x.id === row.id)!;
  const gone = await request.delete(`${API}/${section}/${row.id}?updatedAt=${encodeURIComponent(hidden.updatedAt)}&permanent=1`);
  expect(gone.ok()).toBe(true);
}

async function freshRow(request: APIRequestContext, list: 'systems' | 'idTypes', id: number): Promise<Row | undefined> {
  const s = (await (await request.get(API)).json()) as Record<'systems' | 'idTypes', Row[]>;
  return s[list].find((x) => x.id === id);
}

/** Своя система теста: путь раздела и строка системы. */
const test = base.extend<{ system: Row & { section: string } }>({
  system: async ({ request }, provide, info) => {
    const key = `e2e-${info.testId.slice(-12)}-${info.repeatEachIndex}`;
    const row = await post(request, 'systems', { key, name: `Система ${key}`, hosts: [`${key}.partner.example`] });
    await provide({ ...row, section: `/pay/catalog/systems/${key}` });
    const now = await freshRow(request, 'systems', row.id);
    if (now) await del(request, 'systems', now);
  },
});

test.beforeEach(async ({ request }) => {
  const state = (await (await request.get('/api/catalog')).json()) as { state?: string };
  test.skip(state.state !== 'ok', 'справочник выключен: у сервера e2e нет THREADLINE_DATABASE_URL');
});

const form = (page: Page) => page.getByTestId('catalog-form');
const box = (page: Page, name: string | RegExp) => form(page).getByRole('textbox', { name });
const save = (page: Page) => form(page).getByRole('button', { name: 'Сохранить' }).click();
const fieldError = (page: Page) => form(page).getByTestId('field-error');

async function choose(page: Page, name: string | RegExp, option: string | RegExp) {
  await form(page).getByRole('combobox', { name }).click();
  await page.getByRole('option', { name: option }).click();
}

async function rowMenu(page: Page, testId: string, text: string, item: string) {
  await page.getByTestId(testId).filter({ hasText: text }).getByRole('button', { name: /^Действия/ }).click();
  await page.getByRole('menuitem', { name: item }).click();
}

test.describe('раздел «Маскирование»', () => {
  for (const width of [768, 2560]) {
    test(`${width}px: все виды, замок, без горизонтальной прокрутки; поиск находит вид по кодовому слову`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/pay/settings/masks');
      await expect(page.getByTestId('masking-row')).toHaveCount(13);
      await expect(page.getByTestId('masking-lock')).toHaveCount(2);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      await page.goto('/pay/catalog');
      await page.getByTestId('catalog-search').fill('cardholderPassword');
      await expect(page.getByTestId('catalog-search-results')).toContainText('Секреты');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    });
  }
});

test.describe('форма метода', () => {
  test('новый метод: подписи подстановок, строка в списке, повтор отклонён со ссылкой на существующий', async ({ page, system }) => {
    await page.goto(system.section);
    await page.getByTestId('catalog-add').click();
    await box(page, 'Шаблон пути').fill('/forms/users/{user}/transfers/{transfer}/x/{zzz}');
    const places = form(page).getByTestId('placeholder-types');
    await expect(places).toContainText('{user} — User');
    await expect(places).toContainText('{transfer} — Transfer');
    await expect(places).toContainText('{zzz} — без типа');
    await box(page, 'Название').fill('Новый метод (форма)');
    await box(page, /^Домен/).fill('Тест');
    await save(page);
    await expect(form(page)).toBeHidden();
    const row = page.getByTestId('method-row').filter({ hasText: 'Новый метод (форма)' });
    await expect(row).toContainText('/forms/users/{user}/transfers/{transfer}/x/{zzz}');

    await page.getByTestId('catalog-add').click();
    const path = '/forms/users/{a}/transfers/{b}/x/{c}';
    await box(page, 'Шаблон пути').fill(path);
    await box(page, 'Название').fill('Повтор');
    await save(page);
    const dup = form(page).getByTestId('form-duplicate');
    await expect(dup).toContainText('Такая запись уже есть');
    // Введённое на месте.
    await expect(box(page, 'Шаблон пути')).toHaveValue(path);
    await dup.getByRole('button', { name: 'Открыть существующую' }).click();
    await expect(box(page, 'Название')).toHaveValue('Новый метод (форма)');
  });

  test('неверный шаблон пути: объяснение у поля, форма остаётся открытой', async ({ page, system }) => {
    await page.goto(system.section);
    await page.getByTestId('catalog-add').click();
    await box(page, 'Название').fill('Метод');
    for (const [path, text] of [
      ['forms/x', 'начинается с'],
      ['/forms?x=1', 'строки запроса'],
      ['/cards/id{cardId}', 'всю часть пути'],
    ] as const) {
      await box(page, 'Шаблон пути').fill(path);
      await save(page);
      await expect(fieldError(page)).toContainText(text);
      await expect(box(page, 'Шаблон пути')).toHaveAttribute('aria-invalid', 'true');
    }
    await expect(form(page)).toBeVisible();
  });

  test('виды метода: у внешней системы нет колбэка, вид без типа операции не сохраняется', async ({ page, system }) => {
    await page.goto(system.section);
    await page.getByTestId('catalog-add').click();
    await form(page).getByRole('combobox', { name: 'Вид метода' }).click();
    await expect(page.getByRole('option')).toHaveText(['Синхронный', 'Асинхронная отправка', 'Статус']);
    await page.getByRole('option', { name: 'Статус' }).click();
    await box(page, 'Шаблон пути').fill('/forms/status');
    await box(page, 'Название').fill('Статус без типа');
    await save(page);
    await expect(fieldError(page)).toHaveText('У этого вида метода нужен тип операции');
    await expect(form(page).getByRole('combobox', { name: /^Тип операции/ })).toHaveAttribute('aria-invalid', 'true');
    await expect(form(page)).toBeVisible();

    // У системы-автора колбэк есть.
    await page.goto('/pay/catalog/project');
    await page.getByTestId('catalog-add').click();
    await form(page).getByRole('combobox', { name: 'Вид метода' }).click();
    await expect(page.getByRole('option', { name: 'Колбэк' })).toBeVisible();
  });

  test('метод операции: поле id и перевод статуса сохраняются, метка в строке метода', async ({ page, request, system }) => {
    await page.goto(system.section);
    await page.getByTestId('catalog-add').click();
    await box(page, 'Шаблон пути').fill('/forms/transfer-status');
    await box(page, 'Название').fill('Статус перевода (форма)');
    await choose(page, 'Вид метода', 'Статус');
    await choose(page, /^Тип операции/, 'Payout');
    await form(page).getByRole('button', { name: 'Идентификаторы и статус' }).click();
    await form(page).getByRole('button', { name: 'Добавить поле id' }).click();
    const field = form(page).getByTestId('id-field-row');
    await field.getByRole('textbox', { name: 'Путь поля' }).fill('transfer_id');
    await field.getByRole('combobox', { name: 'Тип id' }).click();
    await page.getByRole('option', { name: 'Payout' }).click();
    await form(page).getByRole('switch', { name: 'Поле статуса операции' }).click();
    await box(page, 'Путь поля статуса').fill('data.state');
    await form(page).getByRole('button', { name: 'Добавить перевод значения' }).click();
    const map = form(page).getByTestId('status-map-row');
    await map.getByRole('textbox', { name: 'Значение в записи' }).fill('complete');
    await map.getByRole('combobox', { name: 'Статус словаря' }).click();
    await page.getByRole('option', { name: /^completed/ }).click();
    await save(page);
    await expect(form(page)).toBeHidden();
    await expect(page.getByTestId('method-row').filter({ hasText: 'Статус перевода (форма)' }).getByTestId('method-kind')).toHaveText('Статус · Payout');

    const s = (await (await request.get(API)).json()) as { methods: { path: string; fields: unknown; status: unknown }[] };
    const saved = s.methods.find((m) => m.path === '/forms/transfer-status')!;
    expect(saved.fields).toEqual([expect.objectContaining({ path: 'transfer_id', type: 'card_payout' })]);
    expect(saved.status).toMatchObject({ path: 'data.state', map: { complete: 'completed' } });
  });

  test('сервер отклоняет поле id с неизвестным типом и объясняет почему', async ({ request, system }) => {
    const res = await request.post(`${API}/methods`, {
      data: { systemId: system.id, http: 'POST', path: '/forms/unknown-type', name: 'Метод', fields: [{ in: 'request', path: 'remote_transfer_id', type: 'no_such_type' }] },
    });
    expect(res.status()).toBe(422);
    const body = (await res.json()) as { error: { code: string; fields: Record<string, string> } };
    expect(body.error.code).toBe('catalog-invalid');
    expect(Object.values(body.error.fields).join(' ')).toContain('Идентификатор');
  });
});

test.describe('форма системы', () => {
  test('новая система из шапки справочника появляется в разделах', async ({ page, request }, info) => {
    const key = `e2e-new-${info.repeatEachIndex}-${info.testId.slice(-8)}`;
    await page.goto('/pay/catalog');
    await page.getByTestId('catalog-add-system').click();
    await box(page, 'Название').fill(`Новая система ${key}`);
    await box(page, 'Ключ системы').fill(key);
    await choose(page, 'Вид системы', 'База данных');
    await box(page, /^Шаблоны хостов/).fill(`${key}.partner.example:5432`);
    await save(page);
    await expect(form(page)).toBeHidden();
    try {
      // Внешних систем в меню видно три: новая может быть за «ещё N».
      const more = page.getByTestId('catalog-systems-more');
      if (await more.isVisible()) await more.click();
      const link = page.getByTestId('catalog-sections').getByRole('link', { name: `Новая система ${key}` });
      await link.click();
      await expect(page.getByTestId('system-header')).toContainText(`${key}.partner.example:5432`);
      // У базы нет вкладки «Методы».
      await expect(page.getByRole('tab', { name: /^Методы/ })).toHaveCount(0);
      await expect(page.getByRole('tab', { name: /^Ошибки/ })).toBeVisible();
    } finally {
      const s = (await (await request.get(API)).json()) as { systems: Row[] };
      const row = s.systems.find((x) => x.key === key);
      if (row) await del(request, 'systems', row);
    }
  });

  test('хост уже у другой системы: отказ с её названием, введённое остаётся', async ({ page, system }) => {
    await page.goto(system.section);
    await page.getByTestId('system-edit').click();
    await box(page, /^Шаблоны хостов/).fill('ledger.pay.example:8080');
    await save(page);
    await expect(fieldError(page)).toContainText('Payment core');
    await expect(box(page, /^Шаблоны хостов/)).toHaveValue('ledger.pay.example:8080');
  });

  test('система-автор: можно переименовать, кнопки удаления нет', async ({ page }) => {
    await page.goto('/pay/catalog/project');
    await page.getByTestId('system-edit').click();
    await expect(box(page, 'Название')).toBeVisible();
    await expect(form(page).getByRole('button', { name: /^(Удалить|Скрыть)$/ })).toHaveCount(0);
  });

  test('удаление системы: подтверждение называет зависимые записи, они удаляются вместе с ней', async ({ page, request, system }) => {
    const m1 = await post(request, 'methods', { systemId: system.id, http: 'GET', path: '/forms/a', name: 'Метод А' });
    await post(request, 'methods', { systemId: system.id, http: 'GET', path: '/forms/b', name: 'Метод Б' });
    await post(request, 'errors', { systemId: system.id, methodId: m1.id, code: '77', title: 'Ошибка метода' });
    await post(request, 'outcome-rules', { systemId: system.id, methodId: null, when: { http: 422 }, outcome: 'success' });
    await page.goto(system.section);
    await page.getByTestId('system-edit').click();
    await form(page).getByRole('button', { name: 'Удалить' }).click();
    const confirm = page.getByTestId('delete-confirm');
    await expect(confirm).toContainText('2 метода');
    await expect(confirm).toContainText('1 ошибка');
    await expect(confirm).toContainText('1 правило итога');
    await confirm.getByRole('button', { name: 'Удалить' }).click();
    await expect(form(page)).toBeHidden();
    await expect(page.getByTestId('section-not-found')).toBeVisible();
    // Удаление мягкое: система скрыта, зависимые записи на месте и вернутся вместе с ней.
    const s = (await (await request.get(API)).json()) as { systems: (Row & { hidden: boolean })[]; methods: Row[]; errors: { title: string }[] };
    expect(s.systems.find((x) => x.id === system.id)?.hidden).toBe(true);
    expect(s.methods.find((x) => x.path === '/forms/a')).toBeDefined();
    expect(s.errors.find((x) => x.title === 'Ошибка метода')).toBeDefined();
  });
});

test.describe('форма ошибки', () => {
  test('общее правило только с HTTP-статусом: форма просит подстроку или код у поля, код снимает отказ', async ({ page, request }) => {
    const title = `Сбой только по статусу ${Date.now()}`;
    await page.goto('/pay/catalog/general');
    await page.getByTestId('catalog-add').first().click();
    await expect(form(page).getByRole('combobox', { name: /^Где действует/ })).toHaveText('Общие правила');
    await box(page, 'HTTP-статус').fill('599');
    await box(page, 'Текст ошибки').fill(title);
    const posts: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().includes(`${API}/errors`)) posts.push(r.url());
    });
    await save(page);
    await expect(fieldError(page)).toContainText('Одного HTTP-статуса для общих правил мало');
    await expect(box(page, /^Подстрока текста/)).toBeFocused();
    expect(posts).toEqual([]);

    await box(page, /^Код(?! для)/).fill('E-599');
    await expect(fieldError(page)).toHaveCount(0);
    await save(page);
    await expect(form(page)).toBeHidden();
    const rows = ((await (await request.get(API)).json()) as { errors: (Row & { title: string })[] }).errors;
    expect((await del(request, 'errors', rows.find((r) => r.title === title)!)).ok()).toBe(true);
  });

  test('без условий и с номером карты не сохраняется; разметка показывается текстом', async ({ page, system }) => {
    await page.goto(`${system.section}?tab=errors`);
    await page.getByTestId('catalog-add').click();
    await box(page, 'Текст ошибки').fill('Карта не найдена');
    await save(page);
    await expect(form(page).getByTestId('no-conditions')).toContainText('хотя бы одно условие');

    await box(page, /^Подстрока текста/).fill(`card ${FAKE_PAN}`);
    await save(page);
    await expect(fieldError(page).first()).toContainText('Уберите номер карты');
    // Номера нет ни в сообщении, ни в запросе к серверу: форма не отправлялась.
    await expect(fieldError(page).first()).not.toContainText(FAKE_PAN);

    await box(page, /^Подстрока текста/).fill('card not found');
    await box(page, 'Текст ошибки').fill('<b>карта</b> не найдена');
    await save(page);
    await expect(form(page)).toBeHidden();
    const row = page.getByTestId('error-row').filter({ hasText: '<b>карта</b> не найдена' });
    await expect(row).toBeVisible();
    await expect(row.locator('b')).toHaveCount(0);
  });

  test('«Добавить ошибку метода» из строки метода: система и метод уже выбраны, ошибка считается у метода', async ({ page, request, system }) => {
    await post(request, 'methods', { systemId: system.id, http: 'GET', path: '/forms/card-number', name: 'Настоящий номер' });
    await page.goto(system.section);
    await rowMenu(page, 'method-row', 'Настоящий номер', 'Добавить ошибку метода');
    await expect(form(page).getByRole('combobox', { name: /^Где действует/ })).toContainText(system.name!);
    await expect(form(page).getByRole('combobox', { name: /^Метод/ })).toContainText('Настоящий номер');
    await box(page, /^Код ·/).fill('200');
    await box(page, 'Текст ошибки').fill('Карта не найдена');
    await save(page);
    await expect(form(page)).toBeHidden();
    await expect(page.getByTestId('method-row').filter({ hasText: 'Настоящий номер' }).getByTestId('method-errors')).toHaveText('1');
    await page.getByRole('tab', { name: /^Ошибки/ }).click();
    await expect(page.getByTestId('error-row').filter({ hasText: 'Карта не найдена' })).toContainText('Настоящий номер');
  });
});

test.describe('форма правила итога', () => {
  test('правило HTTP 422 и status = OK: строка коротким текстом, порядок проверки — метод, затем приоритет', async ({ page, request, system }) => {
    const method = await post(request, 'methods', { systemId: system.id, http: 'POST', path: '/v1/check', name: 'Проверка' });
    await post(request, 'outcome-rules', { systemId: system.id, methodId: null, priority: 10, when: { http: 500 }, outcome: 'error' });
    await post(request, 'outcome-rules', { systemId: system.id, methodId: method.id, priority: 500, when: { http: 200 }, outcome: 'success' });
    await page.goto(`${system.section}?tab=outcomes`);
    await page.getByTestId('catalog-add').click();
    await box(page, 'Приоритет').fill('100');
    await choose(page, /^HTTP-статус/, 'Равен');
    await form(page).getByRole('textbox', { name: 'HTTP-статус' }).fill('422');
    await form(page).getByRole('button', { name: 'Добавить условие на поле' }).click();
    const cond = form(page).getByTestId('condition-row');
    await cond.getByRole('textbox', { name: 'Путь поля' }).fill('status');
    await cond.getByRole('textbox', { name: 'Значение' }).fill('OK');
    await choose(page, /^Итог/, 'успех');
    await box(page, /^Текст или шаблон/).fill('Принято: {message}');
    await save(page);
    await expect(form(page)).toBeHidden();
    const rules = page.getByTestId('outcome-row').getByTestId('row-title');
    await expect(rules).toHaveCount(3);
    await expect(rules.nth(0)).toContainText('HTTP 200');
    await expect(rules.nth(1)).toContainText('HTTP 500');
    await expect(rules.nth(2)).toHaveText('HTTP 422 · status = OK → успех');
    await expect(page.getByTestId('outcome-row').nth(0)).toContainText('Проверка');
  });

  test('пределы: без условий, 51 значение, номер карты, неразбираемое и опасное выражение — отказ у поля', async ({ page, system }) => {
    await page.goto(`${system.section}?tab=outcomes`);
    await page.getByTestId('catalog-add').click();
    await save(page);
    await expect(form(page).getByTestId('no-conditions')).toContainText('хотя бы одно условие');

    await form(page).getByRole('button', { name: 'Добавить условие на поле' }).click();
    const cond = form(page).getByTestId('condition-row');
    const value = cond.getByRole('textbox', { name: 'Значение' });
    await cond.getByRole('textbox', { name: 'Путь поля' }).fill('status');

    await cond.getByRole('combobox', { name: 'Проверка' }).click();
    await page.getByRole('option', { name: 'одно из' }).click();
    await value.fill(Array.from({ length: 51 }, (_, i) => `v${i}`).join(', '));
    await save(page);
    await expect(cond).toContainText('Не больше 50 значений');

    await cond.getByRole('combobox', { name: 'Проверка' }).click();
    await page.getByRole('option', { name: 'равно' }).click();
    await value.fill(FAKE_PAN);
    await save(page);
    await expect(cond).toContainText('Уберите номер карты');

    await cond.getByRole('combobox', { name: 'Проверка' }).click();
    await page.getByRole('option', { name: 'рег. выражение' }).click();
    await value.fill('(');
    await save(page);
    await expect(cond).toContainText('Выражение не разбирается');

    // Разбирается в браузере, но хранилище такое не выполнит: отказ приходит с сервера и ложится на то же поле.
    await value.fill('(a)\\1');
    await save(page);
    await expect(cond).toContainText('обратная ссылка');
    await expect(value).toHaveValue('(a)\\1');
    await expect(form(page)).toBeVisible();
    await expect(page.getByTestId('outcome-row')).toHaveCount(0);
  });

  test('повтор правила того же уровня с теми же условиями отклонён со ссылкой на существующее', async ({ page, request, system }) => {
    await post(request, 'outcome-rules', { systemId: system.id, methodId: null, when: { http: 422 }, outcome: 'success' });
    await page.goto(`${system.section}?tab=outcomes`);
    await page.getByTestId('catalog-add').click();
    await choose(page, /^HTTP-статус/, 'Равен');
    await form(page).getByRole('textbox', { name: 'HTTP-статус' }).fill('422');
    await save(page);
    const dup = form(page).getByTestId('form-duplicate');
    await expect(dup).toContainText('Такая запись уже есть');
    await dup.getByRole('button', { name: 'Открыть существующую' }).click();
    await expect(form(page).getByRole('button', { name: 'Удалить' })).toBeVisible();
  });

  test('«Добавить правило итога метода» из строки метода: уровень и метод выбраны', async ({ page, request, system }) => {
    await post(request, 'methods', { systemId: system.id, http: 'POST', path: '/forms/rule', name: 'Метод с правилом' });
    await page.goto(system.section);
    await rowMenu(page, 'method-row', 'Метод с правилом', 'Добавить правило итога метода');
    await expect(form(page).getByRole('combobox', { name: 'Уровень' })).toContainText('Метод');
    await expect(form(page).getByRole('combobox', { name: 'Метод' })).toContainText('Метод с правилом');
  });
});

test.describe('раздел «Идентификаторы»', () => {
  test('новый тип операции со словарём, порядок статусов, ключ только при создании, повтор ключа', async ({ page, request }, info) => {
    const key = `e2e_op_${info.repeatEachIndex}_${info.testId.slice(-8).replace(/\W/g, '')}`;
    await page.goto('/pay/catalog/ids');
    await page.getByTestId('catalog-add').click();
    await box(page, 'Ключ типа').fill(key);
    await box(page, 'Название').first().fill('QR-платёж (форма)');
    await choose(page, 'Вид типа', 'Операция');
    for (const [i, [value, name, outcome]] of [
      ['processing', 'В обработке', 'В процессе'],
      ['completed', 'Выполнен', 'Успех'],
      ['error', 'Ошибка', 'Отказ'],
    ].entries()) {
      await form(page).getByRole('button', { name: 'Добавить статус' }).click();
      const row = form(page).getByTestId('status-row').nth(i);
      await row.getByRole('textbox', { name: 'Значение' }).fill(value!);
      await row.getByRole('textbox', { name: 'Название' }).fill(name!);
      await row.getByRole('combobox', { name: 'Итог статуса' }).click();
      await page.getByRole('option', { name: outcome! }).click();
    }
    await form(page).getByRole('button', { name: 'Поднять статус completed' }).click();
    await save(page);
    await expect(form(page)).toBeHidden();
    const row = page.locator(`[data-testid=id-type-row][data-key=${key}]`);
    await expect(row).toContainText('3 статуса');
    try {
      const s = (await (await request.get(API)).json()) as { idTypes: (Row & { statuses: { value: string }[] })[] };
      expect(s.idTypes.find((x) => x.key === key)!.statuses.map((x) => x.value)).toEqual(['completed', 'processing', 'error']);

      // Ключ при правке не меняется.
      await row.getByRole('button').first().click();
      await expect(box(page, 'Ключ типа')).toBeDisabled();
      await form(page).getByRole('button', { name: 'Отмена' }).click();
      await expect(form(page)).toBeHidden();

      // Повтор ключа — со ссылкой на существующий.
      await page.getByTestId('catalog-add').click();
      await box(page, 'Ключ типа').fill(key);
      await box(page, 'Название').first().fill('Повтор');
      await save(page);
      await form(page).getByTestId('form-duplicate').getByRole('button', { name: 'Открыть существующую' }).click();
      await expect(box(page, 'Название').first()).toHaveValue('QR-платёж (форма)');
    } finally {
      const s = (await (await request.get(API)).json()) as { idTypes: Row[] };
      const t = s.idTypes.find((x) => x.key === key);
      if (t) await del(request, 'id-types', t);
    }
  });

  test('тип занят методами: удаление отклонено с числом методов', async ({ page, request, system }, info) => {
    const key = `e2e_used_${info.repeatEachIndex}_${info.testId.slice(-8).replace(/\W/g, '')}`;
    const type = await post(request, 'id-types', { key, kind: 'operation', name: 'Занятый тип' });
    const method = await post(request, 'methods', { systemId: system.id, http: 'POST', path: '/forms/used', name: 'Метод типа', kind: 'start', op: key });
    try {
      await page.goto('/pay/catalog/ids');
      await page.locator(`[data-testid=id-type-row][data-key=${key}]`).getByRole('button').first().click();
      await form(page).getByRole('button', { name: 'Удалить' }).click();
      await page.getByTestId('delete-confirm').getByRole('button', { name: 'Удалить' }).click();
      await expect(form(page)).toContainText('Тип используется в 1 методе');
    } finally {
      await del(request, 'methods', method);
      const t = await freshRow(request, 'idTypes', type.id);
      if (t) await del(request, 'id-types', t);
    }
  });
});

test.describe('одновременная правка', () => {
  test('запись удалили: «Записи больше нет», введённое на месте, «Создать заново» создаёт её', async ({ page, request, system }) => {
    const m = await post(request, 'methods', { systemId: system.id, http: 'POST', path: '/forms/gone', name: 'Удаляемый метод' });
    await page.goto(system.section);
    await page.getByTestId('method-row').filter({ hasText: 'Удаляемый метод' }).getByRole('button').first().click();
    await box(page, 'Название').fill('Правка удалённого');
    await delForever(request, 'methods', m);
    await save(page);
    const gone = form(page).getByTestId('form-gone');
    await expect(gone).toContainText('Записи больше нет');
    await expect(box(page, 'Название')).toHaveValue('Правка удалённого');
    await gone.getByRole('button', { name: 'Создать заново' }).click();
    await save(page);
    await expect(form(page)).toBeHidden();
    await expect(page.getByTestId('method-row').filter({ hasText: 'Правка удалённого' })).toBeVisible();
  });

  test('запись удалили, справочник обновился при открытой форме: форма и введённое не пропадают', async ({ page, request, system }) => {
    const m = await post(request, 'methods', { systemId: system.id, http: 'POST', path: '/forms/gone2', name: 'Метод в форме' });
    await page.clock.install();
    await page.goto(system.section);
    await expect(page.getByTestId('method-row').filter({ hasText: 'Метод в форме' })).toBeVisible();
    // Данные устарели: открытие формы перечитывает справочник. Ответ придёт уже без удалённой записи.
    await page.clock.fastForward(31_000);
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route(`**${API}`, async (route) => {
      await gate;
      await route.continue();
    });
    const refreshed = page.waitForResponse((r) => new URL(r.url()).pathname === API);
    await page.getByTestId('method-row').filter({ hasText: 'Метод в форме' }).getByRole('button').first().click();
    await box(page, 'Название').fill('Введённое');
    await delForever(request, 'methods', m);
    release();
    await refreshed;
    await expect(page.getByTestId('method-row').filter({ hasText: 'Метод в форме' })).toHaveCount(0);
    await expect(box(page, 'Название')).toHaveValue('Введённое');
    await save(page);
    await expect(form(page).getByTestId('form-gone')).toBeVisible();
    await expect(box(page, 'Название')).toHaveValue('Введённое');
  });
});

test.describe('мягкое удаление в форме', () => {
  const row = (page: Page, text: string) => page.getByTestId('method-row').filter({ hasText: text });

  test('удаление из редактора скрывает запись, «Скрытые» показывают её, удалить навсегда с подтверждением', async ({ page, request, system }) => {
    const m = await post(request, 'methods', { systemId: system.id, http: 'POST', path: '/forms/soft', name: 'Мягкий метод' });
    await page.goto(system.section);
    await row(page, 'Мягкий метод').getByRole('button').first().click();
    await form(page).getByRole('button', { name: 'Удалить' }).click();
    await form(page).getByRole('button', { name: 'Удалить', exact: true }).last().click();
    await expect(form(page)).toBeHidden();
    await expect(row(page, 'Мягкий метод')).toHaveCount(0);
    await page.getByTestId('catalog-hidden-filter').click();
    await row(page, 'Мягкий метод').getByRole('button').first().click();
    await form(page).getByRole('button', { name: 'Удалить навсегда' }).click();
    await expect(form(page)).toContainText('Это не отменить');
    await form(page).getByRole('button', { name: 'Удалить навсегда' }).last().click();
    await expect(form(page)).toBeHidden();
    await expect(row(page, 'Мягкий метод')).toHaveCount(0);
    const c = (await (await request.get(API)).json()) as Record<'methods', Row[]>;
    expect(c.methods.some((x) => x.id === m.id)).toBe(false);
  });

  test('повтор ключа удалённой записи: ввод на месте, «Вернуть» возвращает её', async ({ page, request, system }) => {
    const m = await post(request, 'methods', { systemId: system.id, http: 'GET', path: '/forms/again', name: 'Удалённый метод' });
    await del(request, 'methods', m);
    await page.goto(system.section);
    await expect(row(page, 'Удалённый метод')).toHaveCount(0);
    const made = await request.post(`${API}/methods`, { data: { systemId: system.id, http: 'GET', path: '/forms/again', name: 'Новый метод' } });
    expect(made.status()).toBe(409);
    expect(((await made.json()) as { error: { existingHidden?: boolean; existingId?: number } }).error).toMatchObject({ existingHidden: true, existingId: m.id });
    await page.getByTestId('catalog-add').click();
    await box(page, 'Шаблон пути').fill('/forms/again');
    await box(page, 'Название').fill('Новый метод');
    await save(page);
    const notice = form(page).getByTestId('form-duplicate-hidden');
    await expect(notice).toBeVisible();
    await expect(box(page, 'Название')).toHaveValue('Новый метод');
    await notice.getByRole('button', { name: 'Вернуть' }).click();
    await expect(form(page)).toBeHidden();
    await expect(row(page, 'Удалённый метод')).toBeVisible();
  });
});

test.describe('раздел «Неизвестное»: действия', () => {
  /** Строки уже собраны: основной сервер e2e пишет неизвестное и из демо-среды. */
  async function ready(page: Page, request: APIRequestContext) {
    const term = page.getByRole('textbox', { name: 'Значения для поиска' });
    await page.goto('/pay/demo');
    await term.fill('switch.pay.example');
    await term.press('Enter');
    await page.getByRole('group', { name: 'Период' }).getByRole('button', { name: '24 ч', exact: true }).click();
    await page.getByRole('button', { name: 'Найти', exact: true }).click();
    await expect(page.getByTestId('search-results')).toHaveAttribute('data-status', 'done', { timeout: 20_000 });
    await expect
      .poll(async () => ((await (await request.get(`${API}/unknown`)).json()) as { total: number }).total, { timeout: 25_000 })
      .toBeGreaterThan(0);
  }

  test('фильтры вида и среды, пустой фильтр объяснён', async ({ page, request }) => {
    await ready(page, request);
    await page.goto('/pay/catalog/unknown');
    const rows = page.getByTestId('unknown-row');
    await expect(rows.first()).toBeVisible();
    const all = await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-kind')));
    const kind = all[0]!;
    await page.getByRole('group', { name: 'Вид', exact: true }).getByRole('button', { name: { method: 'Методы', host: 'Хосты', error: 'Ошибки' }[kind]! }).click();
    await expect.poll(async () => new Set(await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-kind')))).size).toBe(1);
    // Среда, где поисков нет ни у одного теста: строки других тестов сюда не попадают.
    await page.getByRole('combobox', { name: 'Среда', exact: true }).click();
    await page.getByRole('option', { name: 'PR stands, none running', exact: true }).click();
    await expect(page.getByTestId('unknown-empty')).toContainText('По этим фильтрам неизвестного нет');
  });

  test('«Скрыть» убирает строку, «Скрытые» показывает её, «Вернуть» возвращает; «Открыть пример» ведёт на запрос', async ({ page, request }) => {
    await ready(page, request);
    await page.goto('/pay/catalog/unknown');
    const rows = page.getByTestId('unknown-row');
    await expect(rows.first()).toBeVisible();
    // Строка по значению её заголовка: порядок может измениться, пока другие наборы ищут.
    const titles = (await rows.getByTestId('row-title').allInnerTexts()).map((x) => x.trim());
    const title = [...titles].reverse().find((x) => titles.filter((y) => y.includes(x)).length === 1)!;
    const row = rows.filter({ hasText: title });
    await row.getByRole('button', { name: 'Скрыть' }).click();
    await expect(row).toHaveCount(0);
    await page.getByTestId('catalog-hidden-filter').click();
    await row.getByRole('button', { name: 'Вернуть' }).click();
    await expect(row).toHaveCount(0);
    await page.getByTestId('catalog-hidden-filter').click();
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Открыть пример' }).click();
    await expect(page).toHaveURL(/\/pay\/demo\/requests\//);
  });
});

test.describe('«Добавить в справочник» из «Неизвестного» и из шага', () => {
  async function find(page: Page, term: string) {
    await page.goto('/pay/demo');
    const input = page.getByRole('textbox', { name: 'Значения для поиска' });
    await input.fill(term);
    await input.press('Enter');
    await page.getByRole('group', { name: 'Период' }).getByRole('button', { name: '24 ч', exact: true }).click();
    await page.getByRole('button', { name: 'Найти', exact: true }).click();
    await expect(page.getByTestId('search-results')).toHaveAttribute('data-status', 'done', { timeout: 20_000 });
  }
  const collected = async (request: APIRequestContext, kind: string) => ((await (await request.get(`${API}/unknown?kind=${kind}`)).json()) as { total: number }).total;

  test('хост: выбор между новой системой и существующей', async ({ page, request }) => {
    await find(page, 'pay.example');
    await expect.poll(() => collected(request, 'host'), { timeout: 25_000 }).toBeGreaterThan(0);
    await page.goto('/pay/catalog/unknown');
    await page.locator('[data-testid=unknown-row][data-kind=host]').first().getByRole('button', { name: 'Добавить в справочник' }).click();
    const choice = form(page).getByTestId('host-choice');
    await expect(choice).toContainText('Новая система с этим хостом');
    await expect(choice).toContainText('Добавить хост к существующей системе');
    // Новая система заполнена из строки: хост уже в поле, ключ и название предложены.
    await expect(box(page, /^Шаблоны хостов/)).not.toHaveValue('');
    await expect(box(page, 'Ключ системы')).not.toHaveValue('');
  });

  test('ошибка известной системы: система и код из строки, пример в подсказке, подстрока пустая', async ({ page, request }) => {
    await find(page, 'Processing temporarily unavailable');
    await expect.poll(() => collected(request, 'error'), { timeout: 25_000 }).toBeGreaterThan(0);
    await page.goto('/pay/catalog/unknown');
    const row = page.locator('[data-testid=unknown-row][data-kind=error]').filter({ hasText: 'Payment core' }).filter({ hasText: 'Processing temporarily unavailable' }).first();
    await row.getByRole('button', { name: 'Добавить в справочник' }).click();
    await expect(form(page).getByRole('combobox', { name: /^Где действует/ })).toContainText('Payment core');
    await expect(box(page, /^Подстрока текста/)).toHaveValue('');
    await expect(form(page)).toContainText('Processing temporarily unavailable');
  });

  test('шаг с известной ошибкой: «Изменить в справочнике» открывает её форму поверх страницы запроса', async ({ page }) => {
    await find(page, 'Insufficient funds');
    await page.getByRole('list', { name: 'Найденные запросы' }).getByRole('listitem').filter({ hasText: "Not enough money in the customer's account" }).first().locator('[data-row-link]').click({ position: { x: 8, y: 8 } });
    await page.getByRole('tab', { name: /^Шкала времени/ }).click();
    await page.getByRole('listbox', { name: 'Шаги трассы' }).getByRole('option').filter({ hasText: 'Payment core' }).first().click();
    await page.getByTestId('step-details').getByTestId('step-catalog-edit').click();
    await expect(box(page, 'Текст ошибки')).toHaveValue("Not enough money in the customer's account");
    await expect(page.getByTestId('request-header')).toBeAttached();
    await form(page).getByRole('button', { name: 'Отмена' }).click();
    await expect(form(page)).toBeHidden();
    await expect(page.getByTestId('request-header')).toBeVisible();
  });
});

test.describe('состояния справочника', () => {
  const state = (page: Page, body: unknown) =>
    page.route('**/api/catalog', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }));

  test('база пропала: полоса с временем данных, редактор без кнопок правки, «Неизвестное» недоступно', async ({ page }) => {
    await state(page, { state: 'stale', loadedAt: Date.now() - 600_000, message: 'база недоступна' });
    await page.goto('/pay/demo');
    const banner = page.getByTestId('catalog-banner');
    await expect(banner).toHaveAttribute('data-kind', 'stale');
    await expect(banner).toHaveText(/Справочник недоступен, данные на \d\d:\d\d/);
    await page.goto('/pay/catalog/systems/ledger');
    await expect(page.getByTestId('catalog-readonly')).toBeVisible();
    await expect(page.getByTestId('method-list')).toContainText('Payment charge');
    await expect(page.getByTestId('catalog-add')).toHaveCount(0);
    await expect(page.getByTestId('catalog-add-system')).toHaveCount(0);
    await page.goto('/pay/catalog/unknown');
    await expect(page.getByTestId('unknown-unavailable')).toBeVisible();
  });

  for (const [name, message] of [
    ['stale', 'база недоступна'],
    ['error', 'миграция 0001_test.sql не применена'],
  ] as const) {
    test(`правка закрыта (${name}): страница файла только для чтения, загрузки, замены и применения нет, скачивание и формат есть`, async ({ page }) => {
      await state(page, { state: name, loadedAt: Date.now(), message });
      const checks: string[] = [];
      page.on('request', (r) => {
        if (r.url().includes('/catalog/import')) checks.push(r.url());
      });
      await page.goto('/pay/catalog');
      await expect(page.getByTestId('catalog-readonly')).toBeVisible();
      await page.getByTestId('catalog-file-open').click();
      await expect(page).toHaveURL(/\/pay\/settings\/file$/);
      const file = page.getByTestId('project-file');
      await expect(file.getByTestId('file-read-only')).toContainText('Правка закрыта');
      await expect(file.getByTestId('import-input')).toHaveCount(0);
      await expect(file.getByTestId('file-upload')).toHaveCount(0);
      await expect(file.getByRole('switch')).toHaveCount(0);
      await expect(file.getByTestId('import-apply')).toHaveCount(0);
      await expect(file.getByTestId('file-download')).toBeVisible();
      await expect(file.getByTestId('file-format')).toBeVisible();
      // Текст только для чтения: ввод не даёт правок и запросов проверки.
      await file.locator('.cm-content').click();
      await page.keyboard.type('x');
      await expect(file.getByTestId('tab-changed')).toHaveCount(0);
      await page.waitForTimeout(1800);
      expect(checks).toEqual([]);
    });
  }

  test('справочник выключен: страница объясняет, кнопки «Файл справочника» нет', async ({ page }) => {
    await state(page, { state: 'off', loadedAt: null, message: null });
    await page.goto('/pay/catalog');
    await expect(page.getByRole('heading', { name: 'Справочник выключен' })).toBeVisible();
    await expect(page.getByTestId('catalog-file-open')).toHaveCount(0);
  });

  test('данные справочника ещё ни разу не загрузились: страница объясняет, кнопки «Файл справочника» нет', async ({ page }) => {
    await state(page, { state: 'connecting', loadedAt: null, message: 'база справочника недоступна' });
    await page.route('**/api/projects/pay/catalog', (route) => route.fulfill({ status: 503, json: { error: { code: 'catalog-unavailable' } } }));
    await page.goto('/pay/catalog');
    await expect(page.getByRole('heading', { name: 'Справочник недоступен' })).toBeVisible();
    await expect(page.getByTestId('catalog-file-open')).toHaveCount(0);
  });

  test('база недоступна с самого старта: «названия не показаны»', async ({ page }) => {
    await state(page, { state: 'connecting', loadedAt: null, message: 'подключение' });
    await page.goto('/pay/demo');
    await expect(page.getByTestId('catalog-banner')).toHaveText('Справочник недоступен: названия не показаны');
  });

  test('768px: шапка в одну строку, полоса под ней', async ({ page }) => {
    await state(page, { state: 'stale', loadedAt: Date.now(), message: 'база недоступна' });
    await page.setViewportSize({ width: 768, height: 900 });
    await page.goto('/pay/demo');
    const link = page.getByTestId('project-menu');
    const brand = page.getByRole('link', { name: 'Threadline, на главную' });
    await expect(link).toBeVisible();
    const [a, b, banner] = await Promise.all([link.boundingBox(), brand.boundingBox(), page.getByTestId('catalog-banner').boundingBox()]);
    expect(Math.abs(a!.y + a!.height / 2 - (b!.y + b!.height / 2))).toBeLessThan(3);
    expect(banner!.y).toBeGreaterThanOrEqual(a!.y + a!.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
