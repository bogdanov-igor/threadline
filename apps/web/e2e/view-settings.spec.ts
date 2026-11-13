// Настройка вида проекта на своём сервере со своей базой: набор меняет настройку и не должен мешать соседям (playwright.config.ts).
// Только имитация; неверные записи подставляются подменой ответа, потому что база сервера браузеру не видна.
import AxeBuilder from '@axe-core/playwright';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { ProjectSetting, ProjectSettingsResponse } from '@threadline/core';
import { DEFAULT_VIEW, type ViewSettings } from '@threadline/core/view';
import { closeMenu, closeViewer, dataRow, goToAllProjects, modeSwitchInMenu, openData, setViewMode, viewer, viewerCode, viewerTab, type ViewModeName } from './helpers.ts';

const ROW_HIT = { position: { x: 8, y: 8 } };
const rows = (page: Page) => page.getByRole('list', { name: 'Найденные запросы' }).getByRole('listitem');
const details = (page: Page) => page.getByTestId('step-details');
const viewTab = (page: Page, name: 'Схема' | 'Шкала времени' | 'Записи') => page.getByRole('tab', { name: new RegExp(`^${name}`) });
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const head = (page: Page) => page.getByRole('list', { name: 'Найденные запросы' }).locator('xpath=preceding-sibling::div[1]');

/** Режим на странице запроса виден в меню профиля: открыть, проверить выбранный вариант, закрыть. */
async function expectMode(page: Page, name: ViewModeName) {
  const sw = await modeSwitchInMenu(page);
  await expect(sw.getByRole('menuitemradio', { name, exact: true })).toHaveAttribute('aria-checked', 'true');
  await closeMenu(page);
}

const settings = async (request: APIRequestContext) => (await (await request.get('/api/project-settings')).json()) as ProjectSettingsResponse;
const pay = async (request: APIRequestContext) => (await settings(request)).projects.find((p) => p.id === 'pay')!;
const edit = (fn: (v: ViewSettings) => void): ViewSettings => {
  const v = structuredClone(DEFAULT_VIEW);
  fn(v);
  return v;
};
/** Правка другого пользователя: тот же запрос, что у формы. */
async function saveView(request: APIRequestContext, view: ViewSettings | null, id = 'pay') {
  const p = (await settings(request)).projects.find((x) => x.id === id)!;
  const r = await request.put(`/api/projects/${id}/view`, { data: { view, updatedAt: p.viewUpdatedAt } });
  expect(r.status(), await r.text()).toBe(200);
  return (await r.json()) as ProjectSetting;
}

let ready: boolean | null = null;
async function databaseOn(request: APIRequestContext) {
  if (ready !== null) return ready;
  await expect.poll(async () => ((await (await request.get('/api/catalog')).json()) as { state: string }).state, { timeout: 20_000 }).not.toBe('connecting');
  ready = (await settings(request)).editable;
  return ready;
}

test.beforeEach(async ({ request }) => {
  test.skip(!(await databaseOn(request)), 'нет базы: у сервера набора THREADLINE_E2E_DATABASE_URL=off');
  await saveView(request, null);
});
test.afterAll(async ({ request }) => {
  if (ready) await saveView(request, null);
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

async function openRequest(page: Page, term: string, status?: 'error' | 'success') {
  await search(page, term);
  const row = status ? rows(page).and(page.locator(`[data-status=${status}]`)).first() : rows(page).first();
  await row.locator('[data-row-link]').click(ROW_HIT);
  await expect(page.getByTestId('request-header')).toBeVisible();
}

function flowFiles(): string[] {
  const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../dist-e2e/.vite/manifest.json', import.meta.url)), 'utf8')) as Record<string, { file: string; name?: string; imports?: string[] }>;
  const closure = (key: string, seen = new Set<string>()) => {
    const c = manifest[key];
    if (!c || seen.has(c.file)) return seen;
    seen.add(c.file);
    for (const i of c.imports ?? []) closure(i, seen);
    return seen;
  };
  // Общие чанки, которые страница запроса грузит сама, не код графа.
  const requestPage = Object.keys(manifest).find((k) => manifest[k]!.name === 'RequestPage')!;
  const shared = closure(requestPage, closure('index.html'));
  return [...closure('src/features/flow/canvas/FlowGraph.tsx')].filter((f) => !shared.has(f));
}

// ---------- Колонки ----------

test.describe('колонки', () => {
  test('встроенная настройка: шапка и строки как раньше, ссылка строки до ID запроса', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await search(page, 'pay.example');
    await expect(head(page)).toContainText('Компонент');
    await expect(head(page)).toContainText('Записей');
    await expect(head(page)).toContainText('ID запроса');
    await expect(rows(page).first().getByTestId('request-records')).toHaveText(/^\d+$/);
  });

  test('выключенные колонки: нет в шапке и строках, вся строка остаётся одной ссылкой', async ({ page, request }) => {
    await saveView(request, edit((v) => {
      v.columns.component.full = false;
      v.columns.duration.full = false;
    }));
    await page.setViewportSize({ width: 1280, height: 900 });
    await search(page, 'pay.example');
    await expect(head(page)).not.toContainText('Компонент');
    await expect(head(page)).not.toContainText('Длительность');
    await expect(head(page)).toContainText('Итог');
    const first = rows(page).first();
    await expect(first.locator('a[data-row-link]')).toHaveCount(1);
    // Шапка и строка в одной сетке: заголовок итога стоит над ячейкой итога.
    const title = await head(page).getByText('Итог', { exact: true }).boundingBox();
    // Любая строка: в первой по времени демо-данных итог может быть «ожидает», у него нет ни причины, ни OK.
    const cell = await rows(page).getByTestId('request-reason').or(rows(page).getByText('OK', { exact: true })).first().boundingBox();
    expect(Math.abs(title!.x - cell!.x)).toBeLessThan(3);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });

  test('заготовка той же формы, что готовый список', async ({ page, request }) => {
    await saveView(request, edit((v) => (v.columns.component.full = false)));
    await page.setViewportSize({ width: 1280, height: 900 });
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await page.route('**/api/searches/*', async (route) => {
      await held;
      await route.continue();
    });
    await page.goto('/pay/slow');
    const input = page.getByRole('textbox', { name: 'Значения для поиска' });
    await input.fill('pay.example');
    await input.press('Enter');
    await page.getByRole('button', { name: 'Найти', exact: true }).click();
    await expect(page.getByTestId('results-skeleton')).toBeVisible();
    await expect(page.getByTestId('results-skeleton').getByText('Компонент')).toHaveCount(0);
    await expect(page.getByTestId('results-skeleton').getByText('Итог')).toBeVisible();
    release();
  });

  for (const width of [1280, 768]) {
    test(`${width}px: число записей без прокрутки вбок, и когда нет длительности`, async ({ page, request }) => {
      await saveView(request, edit((v) => (v.columns.duration.full = false)));
      await page.setViewportSize({ width, height: 900 });
      await search(page, 'pay.example');
      const first = rows(page).first();
      if (width === 1280) await expect(first.getByTestId('request-records')).toHaveText(/^\d+$/);
      else await expect(first.getByTestId('request-records-inline')).toContainText(/\d+ запис/);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      expect((await first.boundingBox())!.height).toBe(width === 1280 ? 44 : 60);
    });
  }

  test('без ID запроса ссылка на всю строку, стрелки и фокус возврата работают', async ({ page, request }) => {
    await saveView(request, edit((v) => (v.columns.cid.full = false)));
    await page.setViewportSize({ width: 1440, height: 900 });
    await search(page, 'pay.example');
    const first = rows(page).first();
    await expect(first.getByTestId('request-cid')).toHaveCount(0);
    await expect(first.getByRole('button', { name: /Скопировать/ })).toHaveCount(0);
    const row = (await first.boundingBox())!;
    const link = (await first.locator('a[data-row-link]').boundingBox())!;
    expect(Math.abs(row.x + row.width - (link.x + link.width))).toBeLessThan(2);

    await first.locator('a[data-row-link]').focus();
    await page.keyboard.press('ArrowDown');
    await expect(rows(page).nth(1).locator('a[data-row-link]')).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(first.locator('a[data-row-link]')).toBeFocused();

    const cid = await first.getAttribute('data-cid');
    await first.locator('a[data-row-link]').click(ROW_HIT);
    await expect(page.getByTestId('request-header')).toBeVisible();
    await page.getByRole('link', { name: 'К результатам' }).click();
    await expect(page.locator(`li[data-cid="${cid}"] a[data-row-link]`)).toBeFocused();
  });

  test('«Кратко»: проект включил ID запроса и компонент — показаны как есть', async ({ page, request }) => {
    await saveView(request, edit((v) => {
      v.columns.cid.brief = true;
      v.columns.component.brief = true;
    }));
    await page.addInitScript(() => localStorage.setItem('threadline.view', 'brief'));
    await page.setViewportSize({ width: 1440, height: 900 });
    await search(page, 'pay.example');
    await expect(rows(page).first().getByTestId('request-cid')).toBeVisible();
    await expect(head(page)).toContainText('Компонент');
  });
});

// ---------- Вкладки ----------

test.describe('вкладки страницы запроса', () => {
  test('открытие на шкале и на записях', async ({ page, request }) => {
    await saveView(request, edit((v) => (v.defaultTab = 'timeline')));
    await openRequest(page, 'getCard', 'error');
    await expect(viewTab(page, 'Шкала времени')).toHaveAttribute('aria-selected', 'true');
    await expect(details(page)).toBeVisible();

    await saveView(request, edit((v) => (v.defaultTab = 'records')));
    await openRequest(page, 'getCard', 'error');
    await expect(viewTab(page, 'Записи')).toHaveAttribute('aria-selected', 'true');
    const list = page.getByRole('list', { name: 'Записи запроса' });
    await expect(list).toBeVisible();
    await expect(list.locator('li[data-error] > div > button[aria-expanded=true]').first()).toBeVisible();
    // В «Кратко» вкладки «Записи» нет: первая видимая.
    await setViewMode(page, 'Кратко');
    await expect(viewTab(page, 'Схема')).toHaveAttribute('aria-selected', 'true');
  });

  test('единственная вкладка, строка той же высоты', async ({ page, request }) => {
    await saveView(request, edit((v) => {
      v.tabs.scheme = { full: false, brief: false };
      v.tabs.records = { full: false, brief: false };
      v.defaultTab = 'timeline';
    }));
    await openRequest(page, 'getCard', 'error');
    await expect(page.getByRole('tablist', { name: 'Вид запроса' }).getByRole('tab')).toHaveCount(1);
    await expect(viewTab(page, 'Шкала времени')).toHaveAttribute('aria-selected', 'true');
    const line = page.getByRole('tablist', { name: 'Вид запроса' }).locator('xpath=ancestor::div[contains(@class,"h-10")][1]');
    expect((await line.boundingBox())!.height).toBe(40);
  });

  test('схема выключена в обоих режимах: кода графа нет', async ({ page, request }) => {
    await saveView(request, edit((v) => {
      v.tabs.scheme = { full: false, brief: false };
      v.defaultTab = 'timeline';
    }));
    const files = flowFiles();
    const loaded: string[] = [];
    page.on('request', (r) => {
      if (files.some((f) => r.url().endsWith(f))) loaded.push(r.url());
    });
    await openRequest(page, 'getCard', 'error');
    await expect(viewTab(page, 'Схема')).toHaveCount(0);
    await expect(viewTab(page, 'Шкала времени')).toHaveAttribute('aria-selected', 'true');
    await setViewMode(page, 'Кратко');
    await setViewMode(page, 'Подробно');
    await page.waitForLoadState('networkidle');
    expect(loaded).toEqual([]);
  });

  test('схема выключена в одном режиме: код загружен при открытии, смена режима запросов не даёт', async ({ page, request }) => {
    await saveView(request, edit((v) => (v.tabs.scheme.brief = false)));
    await page.addInitScript(() => localStorage.setItem('threadline.view', 'brief'));
    const files = flowFiles();
    const loaded: string[] = [];
    page.on('request', (r) => {
      if (files.some((f) => r.url().endsWith(f))) loaded.push(r.url());
    });
    await openRequest(page, 'getCard', 'error');
    await expect(viewTab(page, 'Схема')).toHaveCount(0);
    await expect(viewTab(page, 'Шкала времени')).toHaveAttribute('aria-selected', 'true');
    await page.waitForLoadState('networkidle');
    expect(loaded.length).toBeGreaterThan(0);
    const after = loaded.length;
    const seen: string[] = [];
    page.on('request', (r) => {
      if (new URL(r.url()).pathname !== '/api/catalog') seen.push(r.url());
    });
    await setViewMode(page, 'Подробно');
    await expect(viewTab(page, 'Схема')).toBeVisible();
    await viewTab(page, 'Схема').click();
    await expect(page.getByTestId('flow-canvas')).toBeVisible({ timeout: 15_000 });
    expect(seen).toEqual([]);
    expect(loaded.length).toBe(after);
  });
});

// ---------- Блоки ----------

test.describe('блоки', () => {
  test('блок выключен в панели, в окне тела и в записях, но есть в ответе сервера', async ({ page, request }) => {
    await saveView(request, edit((v) => (v.blocks.headers.full = false)));
    let served = '';
    page.on('response', async (r) => {
      if (/\/requests\//.test(new URL(r.url()).pathname) && r.request().method() === 'GET' && !/\/reveal/.test(r.url())) served += await r.text().catch(() => '');
    });
    await openRequest(page, 'getCard', 'error');
    await expect(dataRow(page, 'Ответ')).toBeVisible();
    await expect(dataRow(page, 'Заголовки')).toHaveCount(0);
    // В окне тела вкладки заголовков тоже нет.
    await openData(page, 'Ответ');
    await expect(viewerTab(page, 'Заголовки')).toHaveCount(0);
    await expect(viewer(page).locator('[data-block=headers]')).toHaveCount(0);
    await closeViewer(page);
    await viewTab(page, 'Записи').click();
    const list = page.getByRole('list', { name: 'Записи запроса' });
    await expect(list.locator('[data-block=response]').first()).toBeVisible();
    await expect(list.locator('[data-block=headers]')).toHaveCount(0);
    expect(served).toContain('"headers"');
    await expect.poll(() => served.length).toBeGreaterThan(0);
  });

  test('логи включены в «Кратко» и выключены в «Подробно»', async ({ page, request }) => {
    await saveView(request, edit((v) => (v.blocks.logs = { full: false, brief: true })));
    await openRequest(page, 'pay.example');
    await expect(page.getByTestId('app-logs')).toHaveCount(0);
    await expect(page.getByTestId('flow-steps')).toBeVisible();
    await expect(page.getByTestId('node-badge')).toHaveCount(0);
    await viewTab(page, 'Шкала времени').click();
    const timeline = page.getByRole('listbox', { name: 'Шаги трассы' });
    await expect(timeline.locator('[data-kind=log]:not([data-error])')).toHaveCount(0);
    await setViewMode(page, 'Кратко');
    await viewTab(page, 'Схема').click();
    await expect(page.getByTestId('app-logs')).toBeVisible();
    await expect(page.getByTestId('flow-steps')).toHaveCount(0);
  });

  test('в «Кратко» включены «Записи»: заголовки как есть, в подсказках адресов нет, пустое тело строкой', async ({ page, request }) => {
    await saveView(request, edit((v) => {
      v.tabs.records.brief = true;
      v.blocks.headers.brief = true;
    }));
    await page.addInitScript(() => localStorage.setItem('threadline.view', 'brief'));
    await openRequest(page, 'getCard', 'error');
    await viewTab(page, 'Записи').click();
    const list = page.getByRole('list', { name: 'Записи запроса' });
    await expect(list).toBeVisible();
    const titles = await list.getByTestId('record-title').evaluateAll((els) => els.map((el) => `${el.textContent} ${el.getAttribute('title') ?? ''}`));
    for (const t of titles) expect(t).not.toMatch(/processor\.pay\.example|→ \d{3}/);
    await expect(list.getByTestId('param-chip')).toHaveCount(0);
    const send = list.locator('li[data-kind=send]').first();
    await send.locator(':scope > div > button[aria-expanded]').click();
    await expect(send.locator('[data-block=headers]')).toBeVisible();
    await expect(send.locator('[data-block=request]')).toHaveCount(0);
    await expect(send.locator('[data-block=raw]')).toHaveCount(0);
  });

  test('в «Кратко» включены «Записи»: пустое тело входа GET строкой «пусто»', async ({ page, request }) => {
    await saveView(request, edit((v) => (v.tabs.records.brief = true)));
    await page.addInitScript(() => localStorage.setItem('threadline.view', 'brief'));
    await openRequest(page, 'switch.pay.example', 'success');
    await viewTab(page, 'Записи').click();
    const list = page.getByRole('list', { name: 'Записи запроса' });
    const entry = list.locator('li[data-kind=incoming]').first();
    await entry.locator(':scope > div > button[aria-expanded]').click();
    await expect(entry.locator('[data-block=body]')).toContainText('пусто');
  });

  test('в «Кратко» нет ни одного блока: панель с названием и итогом без данных шага, запись говорит, что подробности в «Подробно»', async ({ page, request }) => {
    await saveView(request, edit((v) => {
      for (const b of Object.values(v.blocks)) b.brief = false;
      v.tabs.records.brief = true;
    }));
    await page.addInitScript(() => localStorage.setItem('threadline.view', 'brief'));
    await openRequest(page, 'getCard', 'error');
    await expect(details(page).getByTestId('step-title')).toBeVisible();
    await expect(details(page).getByTestId('step-data')).toHaveCount(0);
    await expect(details(page).getByTestId('data-row')).toHaveCount(0);
    await expect(details(page).getByTestId('step-more-details')).toBeVisible();
    await viewTab(page, 'Записи').click();
    const hidden = page.getByTestId('record-hidden').first();
    await expect(hidden).toBeVisible();
    await hidden.getByRole('button', { name: 'Подробно' }).click();
    await expectMode(page, 'Подробно');
  });
});

// ---------- Вид тел ----------

test.describe('вид тел', () => {
  test('окно тела, записи и все записи открываются как в логе, выбор на странице в настройку не пишется', async ({ page, request, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await saveView(request, edit((v) => (v.bodyView = 'raw')));
    await search(page, 'getCard');
    await page.getByRole('tab', { name: 'Все записи' }).click();
    const allLines = page.getByRole('list', { name: 'Все найденные строки' });
    await expect(allLines).toBeVisible();
    await allLines.locator('li[data-kind=response] > div > button[aria-expanded]').first().click();
    await expect(allLines.locator('[data-block=response]').first()).toHaveAttribute('data-mode', 'raw');
    await page.getByRole('tab', { name: 'Запросы' }).click();

    await rows(page).and(page.locator('[data-status=error]')).first().locator('[data-row-link]').click(ROW_HIT);
    await expect(page.getByTestId('request-header')).toBeVisible();
    // Тело ответа шага — в окне тела: строка «Ответ» панели открывает его.
    await openData(page, 'Ответ');
    const code = viewerCode(page);
    await expect(code).toHaveAttribute('data-block', 'response');
    await expect(code).toHaveAttribute('data-mode', 'raw');
    // Копирование берёт видимое.
    await viewer(page).getByRole('button', { name: /^Копировать/ }).click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied.trim()).toBe((await code.locator('pre').innerText()).trim());
    await viewer(page).getByRole('group', { name: 'Вид', exact: true }).getByRole('button', { name: 'Форматировано', exact: true }).click();
    await expect(code).toHaveAttribute('data-mode', 'pretty');
    expect((await pay(request)).view.bodyView).toBe('raw');
    await closeViewer(page);

    await viewTab(page, 'Записи').click();
    const list = page.getByRole('list', { name: 'Записи запроса' });
    await expect(list.locator('[data-block=response]').first()).toHaveAttribute('data-mode', 'raw');

    // В «Кратко» тело только отформатированное, выбора вида в окне нет.
    await setViewMode(page, 'Кратко');
    await viewTab(page, 'Схема').click();
    await openData(page, 'Ответ');
    await expect(viewerCode(page)).toHaveAttribute('data-mode', 'pretty');
    await expect(viewer(page).getByRole('group', { name: 'Вид', exact: true })).toHaveCount(0);
  });
});

// ---------- Вкладка «Вид» ----------

const section = (page: Page) => page.getByTestId('view-section');
const viewSave = (page: Page) => page.getByTestId('view-save');
const toggle = (page: Page, id: string) => page.getByTestId(id);
/** Запросы браузера, из-за которых сервер пошёл бы в хранилище. */
function storageCalls(page: Page) {
  const calls: string[] = [];
  page.on('request', (r) => {
    if (/\/probe|\/connection|\/searches/.test(new URL(r.url()).pathname)) calls.push(r.url());
  });
  return calls;
}

test.describe('вкладка «Вид»', () => {
  test('адрес открывает вкладку, неизвестная даёт «Основное», запросов к хранилищу нет', async ({ page }) => {
    const calls = storageCalls(page);
    await page.goto('/pay/settings/view');
    await expect(section(page)).toBeVisible();
    await expect(page.getByTestId('project-tab-view')).toHaveAttribute('aria-current', 'page');
    await page.goto('/projects/pay?tab=foo');
    await expect(page.getByTestId('project-tab-main')).toHaveAttribute('aria-current', 'page');
    await expect(section(page)).toBeHidden();
    await page.waitForLoadState('networkidle');
    expect(calls).toEqual([]);
  });

  test('на странице создания вкладки нет', async ({ page }) => {
    await page.goto('/admin/projects/new');
    await expect(page.getByTestId('project-form')).toBeVisible();
    await expect(page.getByTestId('project-tab-view')).toHaveCount(0);
  });

  test('смена пункта с правками спрашивает: отказ оставляет правки, согласие сбрасывает; сохранение вида не трогает «Основное»', async ({ page }) => {
    const calls = storageCalls(page);
    const dialogs: string[] = [];
    let answer = false;
    page.on('dialog', async (d) => {
      dialogs.push(d.message());
      await (answer ? d.accept() : d.dismiss());
    });
    await page.goto('/pay/settings/main');
    await page.getByTestId('project-name').fill('Новое название');
    await expect(page.getByTestId('tab-changed')).toBeVisible();
    await page.getByTestId('project-tab-view').click();
    await expect.poll(() => dialogs.length).toBe(1);
    await expect(page).toHaveURL(/\/settings\/main$/);
    await expect(page.getByTestId('project-name')).toHaveValue('Новое название');

    answer = true;
    await page.getByTestId('project-tab-view').click();
    await expect(page).toHaveURL(/\/settings\/view$/);
    expect(dialogs).toHaveLength(2);
    await toggle(page, 'view-column-component-full').click();
    await expect(page.getByTestId('tab-changed')).toBeVisible();
    await viewSave(page).click();
    await expect(viewSave(page)).toBeDisabled();
    await expect(page.getByTestId('tab-changed')).toHaveCount(0);
    await page.getByTestId('project-tab-main').click();
    await expect(page.getByTestId('project-name')).toHaveValue('Demo Pay');
    expect(dialogs).toHaveLength(2);
    expect(calls).toEqual([]);
  });

  test('уход с правками вида спрашивает подтверждение', async ({ page }) => {
    const dialogs: string[] = [];
    page.on('dialog', async (d) => {
      dialogs.push(d.message());
      await d.dismiss();
    });
    await page.goto('/pay/settings/view');
    await toggle(page, 'view-column-cid-full').click();
    await goToAllProjects(page);
    await expect.poll(() => dialogs.length).toBe(1);
    await expect(page).toHaveURL(/\/pay\/settings/);
  });

  test('обязательные недоступны и объясняют почему; строка про защиту и ссылка на маскирование', async ({ page }) => {
    await page.goto('/pay/settings/view');
    for (const id of ['view-column-time-full', 'view-column-request-brief', 'view-column-outcome-full', 'view-tab-timeline-full', 'view-block-raw-full']) await expect(toggle(page, id)).toBeDisabled();
    await expect(toggle(page, 'view-block-raw-brief')).toBeEnabled();
    await toggle(page, 'view-column-outcome-full-why').hover();
    await expect(page.getByRole('tooltip')).toContainText('не выключается');
    await expect(page.getByTestId('view-boundary')).toContainText('защищает только маскирование');
    await expect(page.getByTestId('view-to-masking')).toHaveAttribute('href', '/pay/settings/masks');
    await expect(page.getByTestId('view-status-always')).toContainText('Статус');
  });

  test('вкладка по умолчанию следует за выключением', async ({ page }) => {
    await page.goto('/pay/settings/view');
    await toggle(page, 'view-tab-scheme-full').click();
    await toggle(page, 'view-tab-scheme-brief').click();
    await expect(section(page)).toContainText('открывается «Шкала времени»');
    await viewSave(page).click();
    await expect(viewSave(page)).toBeDisabled();
  });

  for (const colorScheme of ['light', 'dark'] as const) {
    for (const width of [768, 1024, 1280, 2560]) {
      test(`${width}px, ${colorScheme}: axe без нарушений, прокрутки вбок нет, подписи и переключатели видны`, async ({ page }) => {
        await page.emulateMedia({ colorScheme });
        await page.setViewportSize({ width, height: 900 });
        await page.goto('/pay/settings/view');
        await expect(section(page)).toBeVisible();
        expect(await overflow(page)).toBeLessThanOrEqual(0);
        await expect(section(page).getByTestId('view-columns').getByText('ID запроса', { exact: true })).toBeVisible();
        await expect(toggle(page, 'view-column-cid-brief')).toBeVisible();
        const r = await new AxeBuilder({ page }).include('[data-testid=view-section]').withTags(['wcag2a', 'wcag2aa']).analyze();
        expect(r.violations).toEqual([]);
      });
    }
  }

  test('кнопка сохранения недоступна без правок, двойное нажатие даёт один запрос, запись применяется без перезагрузки', async ({ page }) => {
    await page.goto('/pay/settings/view');
    await expect(viewSave(page)).toBeDisabled();
    await toggle(page, 'view-column-component-full').click();
    await expect(viewSave(page)).toBeEnabled();
    const puts: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'PUT' && r.url().endsWith('/view')) puts.push(r.url());
    });
    await viewSave(page).dblclick();
    await expect(viewSave(page)).toBeDisabled();
    expect(puts).toHaveLength(1);
    // Та же вкладка браузера: переход к результатам без перезагрузки.
    await page.getByRole('link', { name: 'Threadline, на главную' }).click();
    await page.getByRole('textbox', { name: 'Значения для поиска' }).fill('pay.example');
    await page.getByRole('textbox', { name: 'Значения для поиска' }).press('Enter');
    await page.getByRole('group', { name: 'Период' }).getByRole('button', { name: '24 ч', exact: true }).click();
    await page.getByRole('button', { name: 'Найти', exact: true }).click();
    await expect(page.getByTestId('search-results')).toHaveAttribute('data-status', 'done', { timeout: 20_000 });
    await expect(head(page)).not.toContainText('Компонент');
  });

  test('вид скрытого проекта и другой вкладки: другая вкладка получает настройку за минуту', async ({ page, request }) => {
    await page.clock.install();
    await search(page, 'pay.example');
    await expect(head(page)).toContainText('Компонент');
    await saveView(request, edit((v) => (v.columns.component.full = false)));
    await page.clock.fastForward(61_000);
    await expect(head(page)).not.toContainText('Компонент');
  });

  test('конфликт: «Настройку изменили», свежая версия по кнопке, выбранное на месте, раскладка не сдвигается', async ({ page, browser, baseURL, request }) => {
    const other = await browser.newContext({ baseURL: baseURL!, locale: 'ru-RU' });
    const second = await other.newPage();
    await page.goto('/pay/settings/view');
    await second.goto('/pay/settings/view');
    await toggle(page, 'view-column-component-full').click();
    await toggle(second, 'view-column-cid-full').click();
    await viewSave(page).click();
    await expect(viewSave(page)).toBeDisabled();

    const top = (await second.getByTestId('view-columns').boundingBox())!;
    await viewSave(second).click();
    const problem = second.getByTestId('view-problem');
    await expect(problem).toContainText('Настройку изменили, пока вы её правили');
    expect((await second.getByTestId('view-columns').boundingBox())!.y).toBe(top.y);
    await expect(toggle(second, 'view-column-cid-full')).toHaveAttribute('aria-checked', 'false');
    await second.getByTestId('view-reload').click();
    await expect(problem).toHaveCount(0);
    await expect(toggle(second, 'view-column-cid-full')).toHaveAttribute('aria-checked', 'true');
    await expect(toggle(second, 'view-column-component-full')).toHaveAttribute('aria-checked', 'false');
    await other.close();

    // Правка среды параллельно проходит.
    const p = await pay(request);
    const r = await request.put('/api/projects/pay', { data: { name: p.name, timezone: p.timezone, retentionDays: p.retentionDays, format: p.format, environments: p.environments.map(({ missingStore: _m, outOfScope: _o, ...e }) => e), updatedAt: p.updatedAt } });
    expect(r.status()).toBe(200);
  });

  test('проект удалён: сообщение и переход к списку', async ({ page, request }) => {
    const id = `view-${Date.now().toString(36)}`;
    const created = await request.post('/api/projects', { data: { id, name: 'Для удаления', timezone: 'Asia/Karachi', retentionDays: 30, format: 'json', environments: [{ id: 'demo', name: 'Демо', kind: 'single', backend: 'demo', selector: [{ label: 'namespace', op: '=', value: 'acme' }] }] } });
    expect(created.status(), await created.text()).toBe(201);
    await page.goto(`/${id}/settings/view`);
    await toggle(page, 'view-column-cid-full').click();
    const c = (await created.json()) as ProjectSetting;
    const hidden = (await (await request.put(`/api/projects/${id}/visibility`, { data: { hidden: true, updatedAt: c.updatedAt } })).json()) as ProjectSetting;
    expect((await request.delete(`/api/projects/${id}?confirm=${id}&updatedAt=${encodeURIComponent(hidden.updatedAt!)}`)).status()).toBe(204);
    await viewSave(page).click();
    const problem = page.getByTestId('view-problem');
    await expect(problem).toContainText('Проекта больше нет');
    await expect(toggle(page, 'view-column-cid-full')).toHaveAttribute('aria-checked', 'false');
    page.once('dialog', (d) => void d.accept());
    await problem.getByRole('link', { name: 'К списку проектов' }).click();
    await expect(page).toHaveURL(/\/admin\/projects$/);
  });

  test('подмена: при stale время снимка и правка закрыта; ответ 503 сохраняет выбранное', async ({ page }) => {
    await page.goto('/pay/settings/view');
    await toggle(page, 'view-column-cid-full').click();
    await page.route('**/api/projects/pay/view', (route) => route.fulfill({ status: 503, json: { error: { code: 'project-readonly' } } }));
    await viewSave(page).click();
    await expect(page.getByTestId('view-problem')).toContainText('База недоступна, повторите позже');
    await expect(toggle(page, 'view-column-cid-full')).toHaveAttribute('aria-checked', 'false');
    await page.unroute('**/api/projects/pay/view');

    await page.route('**/api/project-settings', async (route) => {
      const res = await route.fetch();
      return route.fulfill({ response: res, json: { ...((await res.json()) as object), state: 'stale', editable: false, message: 'база недоступна', loadedAt: 1_762_000_000_000 } });
    });
    page.once('dialog', (d) => void d.accept());
    await page.reload();
    await expect(page.getByTestId('projects-source')).toContainText('база недоступна');
    await expect(section(page)).toBeVisible();
    await expect(viewSave(page)).toHaveCount(0);
    await expect(toggle(page, 'view-column-component-full')).toBeDisabled();
  });

  test('«Вернуть стандартные» очищает запись при сохранении', async ({ page, request }) => {
    await saveView(request, edit((v) => (v.columns.cid.full = false)));
    await page.goto('/pay/settings/view');
    await expect(toggle(page, 'view-column-cid-full')).toHaveAttribute('aria-checked', 'false');
    await page.getByTestId('view-reset').click();
    await expect(toggle(page, 'view-column-cid-full')).toHaveAttribute('aria-checked', 'true');
    const body = page.waitForRequest((r) => r.method() === 'PUT' && r.url().endsWith('/view'));
    await viewSave(page).click();
    expect((await body).postDataJSON()).toMatchObject({ view: null });
    await expect(viewSave(page)).toBeDisabled();
    // Кнопка выключена и пока запрос идёт, поэтому запись на сервере ждём отдельно.
    await expect.poll(async () => (await pay(request)).view).toEqual(DEFAULT_VIEW);
  });

  test('подмена записи с кодом dropped: сообщение и доступное сохранение, список работает', async ({ page }) => {
    await page.route('**/api/project-settings', async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as ProjectSettingsResponse;
      for (const p of body.projects) if (p.id === 'pay') p.viewIssues = [{ code: 'dropped', field: 'columns', value: 'risk' }];
      return route.fulfill({ response: res, json: body });
    });
    await page.goto('/pay/settings/view');
    await expect(page.getByTestId('view-issues')).toContainText('Убрано при разборе: risk');
    await expect(viewSave(page)).toBeEnabled();
    await search(page, 'pay.example');
    await expect(rows(page).first()).toBeVisible();
  });
});

// ---------- Настройка под открытой страницей ----------

test.describe('настройка сменилась при открытой странице', () => {
  test('за минуту меняется вид, шаг и вкладка на месте, записи не перечитаны, выбор пользователя важнее', async ({ page, request }) => {
    await page.clock.install();
    await openRequest(page, 'getCard', 'error');
    await expect(page.getByTestId('request-cid')).toBeVisible();
    const step = await details(page).getAttribute('data-step');
    const reads: string[] = [];
    page.on('request', (r) => {
      const path = new URL(r.url()).pathname;
      if (r.method() === 'GET' && /\/requests\//.test(path)) reads.push(path);
    });
    await saveView(request, edit((v) => (v.defaultMode = 'brief')));
    await page.clock.fastForward(61_000);
    await expect(page.getByTestId('request-cid')).toHaveCount(0);
    await expectMode(page, 'Кратко');
    await expect(details(page)).toHaveAttribute('data-step', step!);
    await expect(viewTab(page, 'Схема')).toHaveAttribute('aria-selected', 'true');
    expect(reads).toEqual([]);

    // Выбор пользователя важнее режима проекта.
    await setViewMode(page, 'Подробно');
    await saveView(request, edit((v) => {
      v.defaultMode = 'brief';
      v.columns.cid.brief = true;
    }));
    await page.clock.fastForward(61_000);
    await expect(page.getByTestId('request-cid')).toBeVisible();
    await expectMode(page, 'Подробно');
  });

  test('показ снимается, если настройка выключила все блоки', async ({ page, request }) => {
    await page.clock.install();
    await openRequest(page, 'getCard', 'error');
    const none = edit((v) => {
      for (const b of Object.values(v.blocks)) b.brief = false;
    });
    await saveView(request, none);
    await page.clock.fastForward(61_000);
    await expectMode(page, 'Подробно');
    await setViewMode(page, 'Кратко');
    await expect(page.getByTestId('reveal-button')).toHaveCount(0);
  });
});
