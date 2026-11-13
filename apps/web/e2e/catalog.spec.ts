import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { closeMenu, goToCatalog, openProjectMenu, projectButton } from './helpers.ts';

// Справочник на демо-среде. Основной сервер e2e запускается с THREADLINE_DATABASE_URL=pglite://memory,
// THREADLINE_CATALOG_DEMO_INBOX=1 и набором e2e/catalog/pay.yaml. Без базы (сервер single или старый конфиг) набор пропускается.
// Правки справочника общие для всех наборов: каждая правка здесь возвращается в конце теста.

const ROW_HIT = { position: { x: 8, y: 8 } };
const rows = (page: Page) => page.getByRole('list', { name: 'Найденные запросы' }).getByRole('listitem');
const timeline = (page: Page) => page.getByRole('listbox', { name: 'Шаги трассы' });
const details = (page: Page) => page.getByTestId('step-details');
const form = (page: Page) => page.getByTestId('catalog-form');

async function catalogOn(request: APIRequestContext): Promise<boolean> {
  const res = await request.get('/api/catalog');
  if (!res.ok()) return false;
  const body = (await res.json()) as { state?: string };
  return body.state === 'ok';
}

test.beforeEach(async ({ request }) => {
  test.skip(!(await catalogOn(request)), 'справочник выключен: у сервера e2e нет THREADLINE_DATABASE_URL');
});

async function search(page: Page, term: string) {
  await page.goto('/pay/demo');
  const input = page.getByRole('textbox', { name: 'Значения для поиска' });
  await input.fill(term);
  await input.press('Enter');
  await page.getByRole('group', { name: 'Период' }).getByRole('button', { name: '24 ч', exact: true }).click();
  await page.getByRole('button', { name: 'Найти', exact: true }).click();
  await expect(page.getByTestId('search-results')).toHaveAttribute('data-status', 'done', { timeout: 20_000 });
}

async function openFirst(page: Page, term: string) {
  await search(page, term);
  await rows(page).first().locator('[data-row-link]').click(ROW_HIT);
  await expect(page.getByTestId('request-header')).toBeVisible();
}

/** Шаг шкалы по тексту строки: подробности шага открываются справа. */
async function selectStep(page: Page, text: string | RegExp) {
  await page.getByRole('tab', { name: /^Шкала времени/ }).click();
  await timeline(page).getByRole('option').filter({ hasText: text }).first().click();
}

interface Snapshot {
  methods: ({ id: number; path: string; name: string; updatedAt: string; seedKey: string | null } & Record<string, unknown>)[];
  errors: { id: number; code: string | null; title: string; updatedAt: string; hidden: boolean }[];
  outcomeRules: { id: number; methodId: number | null; updatedAt: string }[];
}

async function snapshot(request: APIRequestContext): Promise<Snapshot> {
  return (await (await request.get('/api/projects/pay/catalog')).json()) as Snapshot;
}

async function remove(request: APIRequestContext, kind: 'methods' | 'errors' | 'outcome-rules', id: number, updatedAt: string) {
  await request.delete(`/api/projects/pay/catalog/${kind}/${id}?updatedAt=${encodeURIComponent(updatedAt)}`);
}

test.describe('справочник: страница', () => {
  test('«Справочник» в меню проекта, разделы, «Проект» по умолчанию, без нарушений доступности', async ({ page }) => {
    // Счётчик «Неизвестного» зависит от порядка тестов, а с ним у кнопки проекта появляется подсказка: задан явно.
    await page.route('**/api/catalog', async (route) => {
      const res = await route.fetch();
      return route.fulfill({ response: res, json: { ...((await res.json()) as object), unknownOpen: { pay: 43 } } });
    });
    await page.goto('/pay/demo');
    await goToCatalog(page);
    await expect(page).toHaveURL(/\/pay\/catalog$/);
    const sections = page.getByTestId('catalog-sections');
    await expect(sections).toContainText('Проект · Demo Pay');
    await expect(sections).toContainText('Payment core');
    await expect(sections).toContainText('Неизвестное');
    await expect(page.getByTestId('method-list')).toContainText('Card sync');
    // Фокус вернулся на кнопку проекта, подсказка от этого не открывается.
    await expect(projectButton(page)).toBeFocused();
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    const axe = await new AxeBuilder({ page }).analyze();
    expect(axe.violations).toEqual([]);
    await openProjectMenu(page);
    await expect(page.getByTestId('header-catalog')).toHaveAttribute('aria-current', 'page');
    await closeMenu(page);
    // «Назад» возвращает страницу поиска.
    await page.goBack();
    await expect(page).toHaveURL(/\/pay\/demo/);
  });

  test('раздел по ссылке, вкладка ошибок, неизвестный раздел', async ({ page }) => {
    await page.goto('/pay/catalog/systems/ledger');
    await expect(page.getByTestId('system-header')).toContainText('ledger.pay.example:8080');
    await expect(page.getByTestId('method-list')).toContainText('/v1/payments/charge');
    await page.getByRole('tab', { name: /^Ошибки/ }).click();
    await expect(page.getByTestId('error-list')).toContainText("Not enough money in the customer's account");
    await page.goto('/pay/catalog/systems/gone');
    await expect(page.getByTestId('section-not-found')).toBeVisible();
  });

  test('поиск по справочнику и «Ничего не найдено»', async ({ page }) => {
    await page.goto('/pay/catalog');
    await page.getByTestId('catalog-search').fill('installment');
    await expect(page.getByTestId('catalog-search-results')).toContainText('Installment charge');
    await page.getByTestId('catalog-search').fill('нет-такого-zzz');
    await expect(page.getByTestId('catalog-search-empty')).toContainText('Ничего не найдено');
    await page.getByRole('button', { name: 'Очистить поиск' }).first().click();
    await expect(page.getByTestId('catalog-search')).toHaveValue('');
  });

  test('Много систем: в меню три, текущая среди них, «ещё N» разворачивает список без перехода', async ({ page }) => {
    await page.route('**/api/projects/pay/catalog', async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as { systems: Record<string, unknown>[] };
      const base = body.systems.find((s) => s.kind === 'external')!;
      const extra = Array.from({ length: 12 }, (_, i) => ({ ...base, id: 9000 + i, key: `many-${i}`, name: `Много ${String(i).padStart(2, '0')}`, hosts: [], seedKey: null }));
      await route.fulfill({ response: res, json: { ...body, systems: [...body.systems.filter((s) => s.kind !== 'external'), ...extra] } });
    });
    await page.goto('/pay/catalog/systems/many-11');
    const menu = page.getByTestId('catalog-sections');
    const systems = menu.locator('a[data-section^="system-"]');
    await expect(systems).toHaveCount(3);
    await expect(menu.locator('[data-section="system-many-11"]')).toHaveAttribute('aria-current', 'page');
    const more = page.getByTestId('catalog-systems-more');
    await expect(more).toHaveText('ещё 9');
    await more.click();
    await expect(systems).toHaveCount(12);
    await expect(more).toHaveCount(0);
    await expect(page).toHaveURL(/\/pay\/catalog\/systems\/many-11$/);
    // Порядок групп: «Неизвестное» первым, настройки после справочника, открытие на проекте.
    await expect(menu.locator('a').first()).toHaveAttribute('data-section', 'unknown');
    await expect(menu.getByTestId('project-tab-main')).toHaveAttribute('href', '/pay/settings/main');
    await expect(menu.locator('[data-section=masking]')).toHaveAttribute('href', '/pay/settings/masks');
  });

  test('ширина 768px: разделы выпадающим списком, без горизонтальной прокрутки', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 900 });
    await page.goto('/pay/catalog');
    await expect(page.getByTestId('catalog-sections')).toBeHidden();
    const select = page.getByRole('combobox', { name: 'Разделы справочника' });
    await expect(select).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await select.click();
    await page.getByRole('option', { name: 'Среды', exact: true }).click();
    await expect(page).toHaveURL(/\/pay\/settings\/environments$/);
    await expect(page.getByTestId('env-card').first()).toBeVisible();
  });
});

test.describe('справочник: названия в результатах', () => {
  test('название входящего метода в строке и шапке запроса, полный путь в подсказке', async ({ page }) => {
    await search(page, '/sync/item/3');
    const name = rows(page).first().getByTestId('request-name');
    await expect(name).toHaveText('Card sync');
    await expect(name).toHaveAttribute('title', 'POST /v1/cards/sync');
    await rows(page).first().locator('[data-row-link]').click(ROW_HIT);
    await expect(page.getByTestId('request-header').getByRole('heading', { level: 1 })).toHaveText('Card sync');
  });

  test('ошибка платёжного ядра: причина и «Итог» с текстом справочника, «что делать» и кодом партнёра', async ({ page }) => {
    await search(page, 'Insufficient funds');
    await expect(rows(page).getByTestId('request-reason').filter({ hasText: "Not enough money in the customer's account" }).first()).toContainText('Payment core');
    await rows(page).filter({ hasText: "Not enough money in the customer's account" }).first().locator('[data-row-link]').click(ROW_HIT);
    await selectStep(page, 'Payment core');
    const block = details(page).getByTestId('step-catalog');
    await expect(block).toHaveAttribute('data-verdict', 'error');
    await expect(block).toContainText('внешняя система');
    await expect(block).toContainText("Not enough money in the customer's account");
    await expect(block).toContainText('Offer the customer another card');
    await expect(block).toContainText('партнёр получит код 150 по реестру');
    await expect(block.getByTestId('step-catalog-edit')).toBeVisible();
  });

  test('опрос статуса выплаты: строка «Статус · Payout · Processing»', async ({ page }) => {
    await openFirst(page, 'payout.pay.example');
    await selectStep(page, 'Payout status');
    await expect(details(page).getByTestId('step-operation')).toHaveText(/^Статус · Payout · (Processing|Rejected)$/);
    await expect(timeline(page)).toContainText('Payout network');
  });
});

test.describe.serial('справочник: правка из шага', () => {
  test('«Добавить в справочник» у неизвестного метода платёжного ядра: шаг показывает новое название', async ({ page, request }) => {
    await openFirst(page, 'Processing temporarily unavailable');
    await selectStep(page, /payments\/confirm/);
    await details(page).getByTestId('step-catalog-add').click();
    await expect(form(page).getByRole('textbox', { name: 'Шаблон пути' })).toHaveValue('/v1/payments/confirm');
    await form(page).getByRole('textbox', { name: 'Название' }).fill('Payment confirmation (test)');
    await form(page).getByRole('button', { name: 'Сохранить' }).click();
    await expect(form(page)).toBeHidden();
    try {
      await expect(timeline(page)).toContainText('Payment confirmation (test)');
    } finally {
      const m = (await snapshot(request)).methods.find((x) => x.path === '/v1/payments/confirm');
      if (m) await remove(request, 'methods', m.id, m.updatedAt);
    }
  });

  test('правило итога из шага: HTTP 422 → успех снимает красный цвет', async ({ page, request }) => {
    await openFirst(page, 'installments/charge');
    await selectStep(page, /Installment charge/);
    const failing = timeline(page).locator('[data-error]').filter({ hasText: 'Installment charge' });
    await expect(failing).toHaveCount(1);
    await failing.first().click();
    await details(page).getByTestId('step-catalog-rule').click();
    await expect(form(page)).toContainText('Метод');
    await form(page).getByRole('button', { name: 'Сохранить' }).click();
    await expect(form(page)).toBeHidden();
    try {
      await expect(failing).toHaveCount(0);
      await expect(details(page).getByTestId('step-catalog')).toContainText('по правилу итога метода');
    } finally {
      const s = await snapshot(request);
      const method = s.methods.find((x) => x.path === '/v1/installments/charge');
      for (const r of s.outcomeRules) if (r.methodId === method?.id) await remove(request, 'outcome-rules', r.id, r.updatedAt);
    }
  });

  test('конфликт одновременной правки: «Загрузить свежую версию»', async ({ browser, request }) => {
    const a = await browser.newPage();
    const b = await browser.newPage();
    const before = (await snapshot(request)).methods.find((x) => x.path === '/v1/installments/charge')!;
    try {
      for (const p of [a, b]) {
        await p.goto('/pay/catalog/systems/ledger');
        await p.getByTestId('method-row').filter({ hasText: 'Installment charge' }).getByRole('button').first().click();
        await expect(form(p)).toBeVisible();
      }
      await form(a).getByRole('textbox', { name: 'Название' }).fill('Installment charge (A)');
      await form(a).getByRole('button', { name: 'Сохранить' }).click();
      await expect(form(a)).toBeHidden();
      await form(b).getByRole('textbox', { name: 'Название' }).fill('Installment charge (B)');
      await form(b).getByRole('button', { name: 'Сохранить' }).click();
      await expect(form(b).getByTestId('form-conflict')).toContainText('Запись изменили, пока вы её правили');
      // Введённое остаётся в форме до загрузки свежей версии.
      await expect(form(b).getByRole('textbox', { name: 'Название' })).toHaveValue('Installment charge (B)');
      await form(b).getByRole('button', { name: 'Загрузить свежую версию' }).click();
      await expect(form(b).getByRole('textbox', { name: 'Название' })).toHaveValue('Installment charge (A)');
    } finally {
      // Возврат названия: тело правки — поля записи без служебных и с updatedAt.
      const now = (await snapshot(request)).methods.find((x) => x.id === before.id)!;
      const { id, seedKey: _s, edited: _e, hidden: _h, ...fields } = now as typeof now & { edited?: boolean; hidden?: boolean };
      await request.put(`/api/projects/pay/catalog/methods/${id}`, { data: { ...fields, name: before.name } });
      await a.close();
      await b.close();
    }
  });

  test('скрытие записи набора и возврат из фильтра «Скрытые»', async ({ page }) => {
    await page.goto('/pay/catalog/systems/ledger?tab=errors');
    await page.getByTestId('error-row').filter({ hasText: "Not enough money in the customer's account" }).getByRole('button').first().click();
    await form(page).getByRole('button', { name: 'Скрыть' }).click();
    await expect(page.getByTestId('delete-confirm')).toContainText('фильтре «Скрытые»');
    await page.getByTestId('delete-confirm').getByRole('button', { name: 'Скрыть' }).click();
    await expect(form(page)).toBeHidden();
    await expect(page.getByTestId('errors-empty')).toBeVisible();
    await page.getByTestId('catalog-hidden-filter').click();
    await page.getByTestId('error-row').filter({ hasText: "Not enough money in the customer's account" }).getByRole('button').first().click();
    await form(page).getByRole('button', { name: 'Вернуть' }).click();
    await expect(form(page)).toBeHidden();
    await page.getByTestId('catalog-hidden-filter').click();
    await expect(page.getByTestId('error-list')).toContainText("Not enough money in the customer's account");
  });
});

test.describe('счётчик «Неизвестного»', () => {
  /** Ответ опроса подменён: число точное, сосед по серверу его не меняет. */
  async function withCount(page: Page, count: Record<string, number> | undefined) {
    await page.route('**/api/catalog', async (route) => {
      const res = await route.fetch();
      const { unknownOpen: _u, ...body } = (await res.json()) as Record<string, unknown>;
      await route.fulfill({ json: { ...body, ...(count ? { unknownOpen: count } : {}) } });
    });
  }
  const badge = (page: Page) => page.getByTestId('header-unknown');

  test('значок и число раздела: число, 99+, ноль и другой проект', async ({ page }) => {
    await withCount(page, { pay: 3 });
    await page.goto('/pay/catalog/unknown');
    await expect(badge(page)).toHaveText('3');
    await expect(page.getByTestId('catalog-sections').locator('[data-section="unknown"]')).toHaveText(/Неизвестное\s*3$/);
    await page.unroute('**/api/catalog');

    await withCount(page, { pay: 150 });
    await page.reload();
    await expect(badge(page)).toHaveText('99+');
    await page.unroute('**/api/catalog');

    await withCount(page, { other: 5 });
    await page.reload();
    await expect(projectButton(page)).toBeVisible();
    await expect(badge(page)).toHaveCount(0);
    await expect(page.getByTestId('catalog-sections').locator('[data-section="unknown"]')).toHaveText('Неизвестное');
    await page.unroute('**/api/catalog');
  });

  test('базы нет или опрос не ответил: значка нет, ссылка работает', async ({ page }) => {
    await page.route('**/api/catalog', (route) => route.fulfill({ status: 500, json: { error: { code: 'unknown' } } }));
    await page.goto('/pay/demo');
    await openProjectMenu(page);
    await expect(page.getByTestId('header-catalog')).toBeVisible();
    await closeMenu(page);
    await expect(badge(page)).toHaveCount(0);
  });

  for (const width of [768, 1280]) {
    test(`${width} пикселей: значок не меняет шапку`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      const edges = async () => page.getByTestId('header-actions').locator('> *').evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right), Math.round(r.top)]; }));
      await withCount(page, undefined);
      await page.goto('/pay/demo');
      await expect(projectButton(page)).toBeVisible();
      await expect(page.getByTestId('user-menu').or(page.getByTestId('auth-off'))).toBeVisible();
      const without = await edges();
      const height = await page.locator('header').first().evaluate((el) => el.getBoundingClientRect().height);
      await page.unroute('**/api/catalog');
      await withCount(page, { pay: 150 });
      await page.reload();
      await expect(badge(page)).toHaveText('99+');
      await expect(page.getByTestId('user-menu').or(page.getByTestId('auth-off'))).toBeVisible();
      expect(await edges()).toEqual(without);
      expect(await page.locator('header').first().evaluate((el) => el.getBoundingClientRect().height)).toBe(height);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });
  }

  test('скрытие строки: опрос состояния перечитан сразу', async ({ page, request }) => {
    await search(page, '/sync/item/3');
    await expect.poll(async () => ((await (await request.get('/api/catalog')).json()) as { unknownOpen?: Record<string, number> }).unknownOpen?.pay ?? 0, { timeout: 25_000 }).toBeGreaterThan(0);
    await page.goto('/pay/catalog/unknown');
    await expect(badge(page)).toBeVisible();
    await expect(page.getByTestId('unknown-row').first()).toBeVisible();
    // Правка подменена: соседние наборы на этом сервере строку не теряют.
    await page.route('**/api/projects/pay/catalog/unknown/*', (route) => route.fulfill({ json: {} }));
    const polled = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/catalog');
    await page.getByTestId('unknown-row').first().getByTestId('unknown-hide').click();
    await polled;
  });
});

test.describe('справочник: «Неизвестное» и файл', () => {
  test('«Неизвестное» по убыванию счётчика, «Добавить в справочник» открывает форму', async ({ page, request }) => {
    // Поиск наполняет «Неизвестное»: THREADLINE_CATALOG_DEMO_INBOX=1 снимает пропуск демо-среды.
    await search(page, 'switch.pay.example');
    // Сборщик пишет в базу раз в 10 с: страница открывается, когда строки уже есть.
    await expect
      .poll(async () => ((await (await request.get('/api/projects/pay/catalog/unknown')).json()) as { total: number }).total, { timeout: 25_000 })
      .toBeGreaterThan(0);
    await page.goto('/pay/catalog/unknown');
    const counts = page.getByTestId('unknown-row').getByTestId('unknown-count');
    await expect(counts.first()).toBeVisible({ timeout: 20_000 });
    const values = (await counts.allTextContents()).map((s) => Number(s.replace(/\D/g, '')));
    expect(values).toEqual([...values].sort((x, y) => y - x));
    await page.getByTestId('unknown-row').first().getByTestId('unknown-add').click();
    await expect(form(page)).toBeVisible();
    await form(page).getByRole('button', { name: 'Отмена' }).click();
  });

  test('проверка файла без записи и выгрузка', async ({ page }) => {
    await page.goto('/pay/catalog');
    await page.getByTestId('catalog-file-open').click();
    await expect(page).toHaveURL(/\/pay\/settings\/file$/);
    const sheet = page.getByTestId('project-file');
    await expect(page.getByTestId('file-editor').locator('.cm-content')).toBeVisible();
    const [file] = await Promise.all([page.waitForEvent('download'), sheet.getByTestId('file-download').click()]);
    expect(file.suggestedFilename()).toBe('pay-project.yaml');
    await sheet.getByTestId('import-input').setInputFiles({
      name: 'pay-check.yaml',
      mimeType: 'application/yaml',
      buffer: Buffer.from('version: 1\nproject: pay\nsystems:\n  - key: ledger\n    name: Test payment core\n    hosts: [\'ledger.pay.example:8080\']\n    methods:\n      - { http: POST, path: /v1/payments/charge, titel: x }\n'),
    });
    await expect(sheet.getByTestId('import-errors')).toContainText('systems.0.methods.0.titel');
    await expect(sheet.getByTestId('import-apply')).toHaveCount(0);
  });
});

test.describe('шапка справочника: среды нет', () => {
  const toSearch = (page: Page) => page.getByTestId('header-to-search');

  test('ни выбора среды, ни метки, ни проверки подключения; «Поиск» первым в меню проекта', async ({ page }) => {
    let checks = 0;
    page.on('request', (r) => {
      if (r.url().includes('/connection')) checks++;
    });
    await page.addInitScript(() => localStorage.setItem('threadline.last', JSON.stringify({ project: 'pay', env: 'pr', stand: '92' })));
    await page.goto('/pay/catalog');
    await expect(projectButton(page)).toBeVisible();
    await expect(page.getByRole('combobox', { name: /^Среда:/ })).toHaveCount(0);
    await expect(page.getByTestId('env-mark')).toHaveCount(0);
    await expect(page.getByTestId('connection-indicator')).toHaveCount(0);
    await expect(projectButton(page)).toBeEnabled();
    await projectButton(page).focus();
    await page.keyboard.press('Enter');
    await expect(toSearch(page)).toBeFocused();
    await page.waitForTimeout(200);
    expect(checks).toBe(0);
    // Последний стенд этого проекта.
    await toSearch(page).click();
    await expect(page).toHaveURL(/\/pay\/pr\/92$/);
  });

  test('последний выбор другого проекта или удалённая среда: среда по умолчанию или первая', async ({ page }) => {
    await page.goto('/cards/catalog');
    await page.evaluate(() => localStorage.setItem('threadline.last', JSON.stringify({ project: 'pay', env: 'slow' })));
    await page.reload();
    await openProjectMenu(page);
    await expect(toSearch(page)).toHaveAttribute('href', '/cards/demo');
    await page.evaluate(() => localStorage.setItem('threadline.last', JSON.stringify({ project: 'pay', env: 'removed' })));
    await page.goto('/pay/catalog');
    await openProjectMenu(page);
    await expect(toSearch(page)).toHaveAttribute('href', '/pay/demo');
  });

  test('хранилище браузера недоступно: среда по умолчанию', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        get() {
          throw new DOMException('denied', 'SecurityError');
        },
      });
    });
    await page.goto('/pay/catalog');
    await openProjectMenu(page);
    await expect(toSearch(page)).toHaveAttribute('href', '/pay/demo');
  });
});
