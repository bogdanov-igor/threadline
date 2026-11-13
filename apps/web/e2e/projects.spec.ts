// Страницы проектов в браузере на своём сервере и своей базе (playwright.config.ts): только имитация и ненастроенная Grafana.
// Браузер Grafana не видит, поэтому считаются его запросы к /connection, /stands, /searches и /probe.
import AxeBuilder from '@axe-core/playwright';
import { readFileSync } from 'node:fs';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { ProjectSetting, ProjectSettingsResponse } from '@threadline/core';
import { closeMenu, goToAllProjects, goToService, openProjectMenu, projectButton, userButton } from './helpers.ts';

const ru = JSON.parse(readFileSync(new URL('../src/i18n/ru.json', import.meta.url), 'utf8')) as { connection: { status: Record<string, { title: string; text: string }> } };

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const svg = (fill: string) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 10"><rect width="40" height="10" fill="${fill}"/></svg>`);

let seq = 0;
const stamp = Date.now().toString(36);
const uniqueId = (prefix = 'p') => `${prefix}-${stamp}-${++seq}`;
let created: string[] = [];

const envBody = (over: Record<string, unknown> = {}) => ({ id: 'demo', name: 'Демо', kind: 'single', backend: 'demo', selector: [{ label: 'namespace', op: '=', value: 'pay' }], ...over });
const projectBody = (id: string, over: Record<string, unknown> = {}) => ({ id, name: `Проект ${id}`, timezone: 'Asia/Karachi', retentionDays: 30, format: 'json', environments: [envBody()], ...over });

async function createProject(request: APIRequestContext, over: Record<string, unknown> = {}, id = uniqueId()): Promise<ProjectSetting> {
  const r = await request.post('/api/projects', { data: projectBody(id, over) });
  expect(r.status(), await r.text()).toBe(201);
  created.push(id);
  return (await r.json()) as ProjectSetting;
}
const settingsOf = async (request: APIRequestContext) => (await (await request.get('/api/project-settings')).json()) as ProjectSettingsResponse;
const settingOf = async (request: APIRequestContext, id: string) => (await settingsOf(request)).projects.find((p) => p.id === id);

/** Правка другой вкладки: тот же API, что у формы. */
async function editProject(request: APIRequestContext, id: string, over: Record<string, unknown>): Promise<void> {
  const p = (await settingOf(request, id))!;
  const environments = p.environments.map(({ missingStore: _m, outOfScope: _o, ...e }) => e);
  const r = await request.put(`/api/projects/${id}`, { data: { name: p.name, timezone: p.timezone, retentionDays: p.retentionDays, format: p.format, environments, updatedAt: p.updatedAt, ...over } });
  expect(r.status(), await r.text()).toBe(200);
}
async function setHidden(request: APIRequestContext, id: string, hidden: boolean): Promise<void> {
  const p = (await settingOf(request, id))!;
  const r = await request.put(`/api/projects/${id}/visibility`, { data: { hidden, updatedAt: p.updatedAt } });
  expect(r.status(), await r.text()).toBe(200);
}
async function removeProject(request: APIRequestContext, id: string): Promise<void> {
  if (!(await settingOf(request, id))) return;
  if ((await settingOf(request, id))!.hidden === null) await setHidden(request, id, true);
  const p = (await settingOf(request, id))!;
  await request.delete(`/api/projects/${id}?confirm=${id}&updatedAt=${encodeURIComponent(p.updatedAt!)}`);
}

/** База у сервера набора поднимается в фоне: ждём её один раз, без базы набор пропускается. */
let databaseReady: boolean | null = null;
async function databaseOn(request: APIRequestContext): Promise<boolean> {
  if (databaseReady !== null) return databaseReady;
  await expect.poll(async () => ((await (await request.get('/api/catalog')).json()) as { state: string }).state, { timeout: 20_000 }).not.toBe('connecting');
  databaseReady = (await settingsOf(request)).editable;
  return databaseReady;
}

test.beforeEach(async ({ request }) => {
  test.skip(!(await databaseOn(request)), 'нет базы: у сервера набора THREADLINE_E2E_DATABASE_URL=off');
});

test.afterEach(async ({ request }) => {
  for (const id of created) await removeProject(request, id);
  created = [];
});

const header = (page: Page) => page.getByRole('banner');
const row = (page: Page, id: string) => page.locator(`[data-testid=project-row][data-project="${id}"]`);
const envCard = (page: Page, i = 0) => page.getByTestId('env-card').nth(i);
const save = (page: Page) => page.getByTestId('project-save');
/** Страница сред: карточки свёрнуты, нужные раскрываются. Без номеров раскрыта первая. */
async function openEnvs(page: Page, id: string, ...open: number[]): Promise<void> {
  await page.goto(`/${id}/settings/environments`);
  for (const i of open.length > 0 ? open : [0]) await envCard(page, i).getByTestId('env-toggle').click();
}
const problem = (page: Page) => page.getByTestId('form-problem');

/** Запросы браузера, из-за которых сервер пошёл бы в хранилище. */
function storageCalls(page: Page): string[] {
  const calls: string[] = [];
  page.on('request', (r) => {
    const path = new URL(r.url()).pathname;
    if (/\/(connection|stands|searches|probe)(\/|$)/.test(path)) calls.push(`${r.method()} ${path}`);
  });
  return calls;
}

async function choose(page: Page, select: Locator, option: string | RegExp): Promise<void> {
  await select.click();
  await page.getByRole('option', { name: option }).click();
}

async function fillNew(page: Page, id: string, name = `Проект ${id}`): Promise<void> {
  await page.goto('/admin/projects/new');
  await page.getByTestId('project-id').fill(id);
  await page.getByTestId('project-name').fill(name);
  const env = envCard(page);
  await env.getByTestId('env-id').fill('demo');
  await env.getByTestId('env-name').fill('Демо');
  await env.getByTestId('matcher-label').fill('namespace');
  await env.getByTestId('matcher-value').fill('pay');
}

async function startSearch(page: Page, term = 'lookup'): Promise<void> {
  const input = page.getByRole('textbox', { name: 'Значения для поиска' });
  await input.fill(term);
  await input.press('Enter');
  await page.getByRole('button', { name: 'Найти', exact: true }).click();
  await expect(page).toHaveURL(/\?search=/);
}

/** Верх элемента от начала страницы: нажатие прокручивает окно, а раскладка от этого не меняется. */
const pageTop = (l: Locator) => l.evaluate((el) => el.getBoundingClientRect().top + window.scrollY);

/** Нажатие «Сохранить» и ответ сервера: кнопка недоступна и во время запроса, поэтому её состояния мало. */
async function saved(page: Page): Promise<void> {
  const answer = page.waitForResponse((r) => /\/api\/projects(\/[^/]+)?$/.test(new URL(r.url()).pathname) && r.request().method() !== 'GET');
  await save(page).click();
  expect((await answer).ok()).toBe(true);
  await expect(save(page).locator('.animate-spin')).toHaveCount(0);
  await expect(save(page)).toBeDisabled();
}

const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test.describe('адреса', () => {
  test('/pay/settings/main открывает форму, /catalog/settings/main — «такого проекта нет», а не справочник', async ({ page }) => {
    await page.goto('/pay/settings/main');
    await expect(page.getByTestId('project-name')).toHaveValue('Demo Pay');
    await openProjectMenu(page);
    await expect(page.getByTestId('header-settings')).toHaveAttribute('aria-current', 'page');
    await closeMenu(page);
    await page.goto('/catalog/settings/main');
    await expect(page.getByRole('heading', { name: 'Такого проекта нет' })).toBeVisible();
    await expect(page.getByTestId('catalog-page')).toHaveCount(0);
  });

  test('шапка видна до загрузки чанка, сбой чанка показывает экран ошибки в шапке', async ({ page }) => {
    let release = () => {};
    const held = new Promise<void>((r) => (release = r));
    await page.route(/\/assets\/pages-[^/]*\.js$/, async (route) => {
      await held;
      await route.fallback();
    });
    await page.goto('/admin/projects');
    await expect(projectButton(page)).toBeVisible();
    await expect(page.getByTestId('project-row')).toHaveCount(0);
    release();
    await expect(page.getByTestId('project-row').first()).toBeVisible();

    const broken = await page.context().newPage();
    await broken.route(/\/assets\/pages-[^/]*\.js$/, (route) => route.abort());
    await broken.goto('/admin/projects');
    await expect(broken.locator('[data-fatal-error]')).toBeVisible();
    await expect(header(broken).getByRole('link', { name: 'Threadline, на главную' })).toBeVisible();
    await broken.close();
  });

  test('неизвестный адрес: скрытый проект назван и ведёт к странице, запросов к хранилищу нет', async ({ page, request }) => {
    const p = await createProject(request, { name: 'Скрытый портал' });
    await setHidden(request, p.id, true);
    const calls = storageCalls(page);
    await page.goto(`/${p.id}/demo`);
    await expect(page.getByRole('heading', { name: 'Проект скрыт' })).toBeVisible();
    await expect(page.getByRole('main')).toContainText('Скрытый портал');
    await expect(page.getByRole('link', { name: 'Открыть Demo Pay / Demo' })).toBeVisible();
    await page.getByRole('link', { name: 'Открыть страницу проекта' }).click();
    await expect(page).toHaveURL(new RegExp(`/${p.id}/settings/main$`));
    await expect(page.getByTestId('project-name')).toHaveValue('Скрытый портал');
    // Ссылка на запрос скрытого проекта: записи не показаны.
    await page.goto(`/${p.id}/demo/requests/cid-synthetic?from=1&to=2`);
    await expect(page.getByRole('heading', { name: 'Проект скрыт' })).toBeVisible();
    expect(calls).toEqual([]);
  });

  test('неполный список: сказано прямо и есть «Повторить»', async ({ page }) => {
    await page.route('**/api/projects', async (route) => {
      const res = await route.fetch();
      await route.fulfill({ response: res, json: { ...((await res.json()) as object), incomplete: true } });
    });
    const calls = storageCalls(page);
    await page.goto('/from-database/demo');
    await expect(page.getByRole('heading', { name: 'Список проектов неполон' })).toBeVisible();
    const again = page.waitForResponse('**/api/projects');
    await page.getByRole('button', { name: 'Повторить' }).click();
    await again;
    await expect(page.getByRole('heading', { name: 'Список проектов неполон' })).toBeVisible();
    expect(calls).toEqual([]);
  });
});

test.describe('шапка и другая вкладка', () => {
  test('правка в другой вкладке: список обновился за минуту, только к серверу Threadline, проверки подключения нет', async ({ page, request }) => {
    await page.clock.install();
    const first = page.waitForResponse('**/api/catalog');
    await page.goto('/pay/demo');
    await first;
    const text = header(page).getByText('Demo Pay', { exact: true });
    await expect(text).toBeVisible();
    await expect(page.getByTestId('connection-indicator')).toHaveAttribute('data-status', 'demo');
    // Кнопка профиля приходит ленивым чанком: меряем, когда она на месте.
    await expect(userButton(page)).toBeVisible();
    const before = await page.getByTestId('header-actions').boundingBox();

    const urls: string[] = [];
    page.on('request', (r) => {
      if (r.resourceType() === 'fetch') urls.push(new URL(r.url()).pathname);
    });
    // Был один проект: появление второго делает список, шапка не сдвигается.
    const second = await createProject(request, { name: 'Второй портал' });
    await page.clock.fastForward(61_000);
    await expect(header(page).getByRole('button', { name: /^Проект: Demo Pay/ })).toBeVisible();
    expect(await page.getByTestId('header-actions').boundingBox()).toEqual(before);
    expect(urls.filter((u) => /\/connection$/.test(u))).toEqual([]);
    expect(urls.every((u) => u.startsWith('/api/'))).toBe(true);

    await setHidden(request, second.id, true);
    await page.clock.fastForward(61_000);
    await expect(text).toBeVisible();
    expect(await page.getByTestId('header-actions').boundingBox()).toEqual(before);
    expect(urls.filter((u) => /\/connection$/.test(u))).toEqual([]);
  });

  test('768px: длинные название проекта и среды обрезаются, шапка в одну строку', async ({ page, request }) => {
    const long = 'Очень длинное название проекта для проверки обрезки в шапке сервиса';
    const p = await createProject(request, { name: long, environments: [envBody({ name: 'Очень длинное название среды для проверки обрезки' })] });
    await page.setViewportSize({ width: 768, height: 900 });
    await page.goto(`/${p.id}/demo/requests/cid-synthetic?from=${Date.now() - 60_000}&to=${Date.now()}`);
    await expect(page.getByTestId('env-mark')).toBeVisible();
    expect(await noHorizontalScroll(page)).toBeLessThanOrEqual(0);
    expect((await header(page).boundingBox())!.height).toBeLessThanOrEqual(56);
    await expect(projectButton(page)).toBeVisible();
    await expect(page.getByTestId('auth-off')).toBeVisible();
    const actions = await page.getByTestId('header-actions').boundingBox();
    expect(actions!.x + actions!.width).toBeLessThanOrEqual(768 - 16);
  });
});

test.describe('список', () => {
  test('строки и столбцы, хранилища на странице сервиса; запросов к хранилищу нет', async ({ page, request }) => {
    const p = await createProject(request, { name: 'Acme портал', retentionDays: 7, environments: [envBody(), envBody({ id: 'test', name: 'Тест' })] });
    const calls = storageCalls(page);
    await page.goto('/pay/demo');
    await expect(page.getByTestId('connection-indicator')).toHaveAttribute('data-status', 'demo');
    calls.length = 0;
    await goToAllProjects(page);
    await expect(page).toHaveURL(/\/admin\/projects$/);
    const r = row(page, p.id);
    await expect(r).toContainText('Acme портал');
    await expect(r).toContainText(p.id);
    await expect(r).toContainText('Демо');
    await expect(r).toContainText('Тест');
    await expect(r).toContainText('json');
    await expect(r).toContainText('7 дней');
    await expect(r).toContainText('Только на странице');
    await expect(r.getByRole('link', { name: /Поиск/ })).toHaveAttribute('href', `/${p.id}/demo`);
    await expect(r.getByTestId('project-edit')).toHaveAttribute('href', `/${p.id}/settings/main`);
    await expect(page.getByTestId('show-hidden')).toHaveCount(0);
    await expect(page.getByTestId('stores-list')).toHaveCount(0);
    await expect(page.getByTestId('service-settings-link')).toHaveCount(0);
    await goToService(page);
    const grafana = page.locator('[data-store=grafana]');
    await expect(grafana.getByTestId('row-status')).toHaveText('Токен не задан');
    await expect(grafana).toContainText('Задайте переменную THREADLINE_E2E_TOKEN_NOT_SET и перезапустите сервис');
    // Для диктора состояние токена ещё и в строке вида хранилища.
    await expect(grafana.getByTestId('token-state')).toContainText('Токен: не задан');
    await expect(page.locator('[data-store=demo]')).toContainText('Синтетические данные');
    await expect(page.getByTestId('stores-docs')).toHaveAttribute('href', '/docs/admin-grafana');
    expect(calls).toEqual([]);
  });

  test('скрытые показывает переключатель, логотип скрытого виден', async ({ page, request }) => {
    const p = await createProject(request, { logo: { light: PNG.toString('base64') } });
    await setHidden(request, p.id, true);
    await page.goto('/admin/projects');
    await expect(row(page, p.id)).toHaveCount(0);
    await page.getByTestId('show-hidden').click();
    await expect(row(page, p.id)).toContainText('Скрыт');
    await expect(row(page, p.id).getByRole('link', { name: /Поиск/ })).toHaveCount(0);
    const logo = row(page, p.id).locator('img:visible');
    await expect(logo).toHaveAttribute('src', new RegExp(`/api/projects/${p.id}/logo/`));
    await expect.poll(() => logo.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
  });

  test('длинные названия обрезаны с подсказкой, ширина без прокрутки', async ({ page, request }) => {
    const long = 'Очень длинное название проекта для проверки обрезки многоточием в списке проектов';
    const p = await createProject(request, { name: long.slice(0, 80) });
    for (const width of [768, 1024, 1280, 2560]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/admin/projects');
      await expect(row(page, p.id)).toBeVisible();
      expect(await noHorizontalScroll(page), `${width}px`).toBeLessThanOrEqual(0);
    }
    await page.setViewportSize({ width: 768, height: 900 });
    await page.goto('/admin/projects');
    const title = row(page, p.id).locator(`[title="${long.slice(0, 80)}"]`);
    await expect(title).toBeVisible();
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`доступность, ${scheme}`, async ({ page, request }) => {
      const p = await createProject(request);
      await page.emulateMedia({ colorScheme: scheme });
      for (const width of [768, 1024, 1280, 2560]) {
        await page.setViewportSize({ width, height: 900 });
        for (const path of ['/admin/projects', `/${p.id}/settings/main`, '/admin/projects/new']) {
          await page.goto(path);
          await expect(projectButton(page)).toBeVisible();
          await expect(page.getByRole('main').getByRole('heading').first()).toBeVisible();
          const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
          expect(r.violations.map((v) => `${width}px ${path}: ${v.id} ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
        }
      }
    });
  }

  test('заготовка не двигает раскладку, ошибка сервера с «Повторить»', async ({ page }) => {
    await page.route('**/api/project-settings', async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.fallback();
    });
    await page.goto('/admin/projects');
    await expect(page.getByTestId('projects-skeleton').locator('[data-slot=skeleton]').first()).toBeVisible();
    const atSkeleton = await pageTop(page.getByTestId('projects-skeleton').locator('[data-slot=skeleton]').first());
    await expect(page.getByTestId('project-row').first()).toBeVisible();
    expect(await pageTop(page.getByRole('main').locator('h1'))).toBe(atSkeleton);
    await page.unroute('**/api/project-settings');

    await page.route('**/api/project-settings', (route) => route.fulfill({ status: 500, json: { error: { code: 'unknown' } } }));
    await page.goto('/admin/projects');
    await expect(page.getByRole('heading', { name: 'Не удалось загрузить проекты' })).toBeVisible();
    await page.unroute('**/api/project-settings');
    await page.getByRole('button', { name: 'Повторить' }).click();
    await expect(page.getByTestId('project-row').first()).toBeVisible();
  });
});

test.describe('форма: создание и правка', () => {
  test('создание без перезагрузки: страница правки, в выборе проекта, запросов к хранилищу нет', async ({ page }) => {
    const id = uniqueId('new');
    created.push(id);
    const calls = storageCalls(page);
    await fillNew(page, id, 'Новый портал');
    await page.evaluate(() => ((window as unknown as { mark: number }).mark = 1));
    await save(page).click();
    await expect(page).toHaveURL(new RegExp(`/${id}/settings/main$`));
    await expect(page.getByRole('heading', { name: 'Основное' })).toBeVisible();
    await expect(page.getByTestId('project-name')).toHaveValue('Новый портал');
    await expect(page.getByTestId('project-id')).toHaveAttribute('readonly');
    expect(calls).toEqual([]);
    await goToAllProjects(page);
    await row(page, id).getByRole('link', { name: /Поиск/ }).click();
    await expect(header(page).getByRole('button', { name: 'Проект: Новый портал' })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { mark?: number }).mark)).toBe(1);
  });

  test('ошибки идентификатора у поля, занятые адреса, запроса нет', async ({ page }) => {
    const id = uniqueId('bad');
    let posts = 0;
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().endsWith('/api/projects')) posts++;
    });
    await fillNew(page, id);
    const idField = page.getByTestId('project-id');
    const zone = await pageTop(page.getByTestId('project-timezone'));
    for (const [value, text] of [
      ['BadId', 'строчные латинские'],
      ['кириллица', 'строчные латинские'],
      ['a b', 'строчные латинские'],
      ['-abc', 'строчные латинские'],
      ['x'.repeat(33), 'строчные латинские'],
      ['projects', 'занят адресом'],
      ['admin', 'занят адресом'],
      ['learn', 'занят адресом'],
      ['new', 'занят адресом'],
      ['catalog', 'занят адресом'],
      ['api', 'занят адресом'],
      ['assets', 'занят адресом'],
      ['2024', 'только из цифр'],
    ] as const) {
      await idField.fill(value);
      await save(page).click();
      await expect(page.getByTestId('field-error').first(), value).toContainText(text);
    }
    expect(posts).toBe(0);
    expect(await pageTop(page.getByTestId('project-timezone'))).toBe(zone);
  });

  test('двойное нажатие создаёт один проект, кнопка занята до ответа', async ({ page }) => {
    const id = uniqueId('dbl');
    created.push(id);
    let posts = 0;
    await page.route('**/api/projects', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      posts++;
      await new Promise((r) => setTimeout(r, 300));
      return route.fallback();
    });
    await fillNew(page, id);
    await save(page).dblclick();
    await expect(page).toHaveURL(new RegExp(`/${id}/settings/main$`));
    expect(posts).toBe(1);
  });

  test('ввод во время сохранения остаётся, форма не сохранена; следующее сохранение его отправляет', async ({ page, request }) => {
    const p = await createProject(request);
    await page.goto(`/${p.id}/settings/main`);
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    await page.route(`**/api/projects/${p.id}`, async (route) => {
      if (route.request().method() === 'PUT') await gate;
      return route.fallback();
    });
    await page.getByTestId('project-name').fill('Первое');
    await save(page).click();
    await page.getByTestId('project-timezone').fill('Europe/Lisbon');
    const answer = page.waitForResponse((r) => r.url().endsWith(`/api/projects/${p.id}`) && r.request().method() === 'PUT');
    release();
    await answer;
    await expect(save(page).locator('.animate-spin')).toHaveCount(0);
    await expect(page.getByTestId('project-timezone')).toHaveValue('Europe/Lisbon');
    await expect(page.getByTestId('project-name')).toHaveValue('Первое');
    await expect(save(page)).toBeEnabled();
    await expect(page.getByTestId('project-form')).toContainText('Есть несохранённые изменения');
    await saved(page);
    const stored = await settingOf(request, p.id);
    expect([stored?.name, stored?.timezone]).toEqual(['Первое', 'Europe/Lisbon']);
  });

  test('ошибка сервера не очищает форму; повтор идентификатора предлагает открыть существующий', async ({ page, request }) => {
    const id = uniqueId('err');
    await page.route('**/api/projects', (route) => (route.request().method() === 'POST' ? route.fulfill({ status: 500, json: { error: { code: 'unknown' } } }) : route.fallback()));
    await fillNew(page, id, 'Введённое');
    await save(page).click();
    await expect(problem(page)).toContainText('Не удалось сохранить');
    await expect(page.getByTestId('project-name')).toHaveValue('Введённое');
    await page.unroute('**/api/projects');

    const taken = await createProject(request);
    await page.getByTestId('project-id').fill(taken.id);
    await save(page).click();
    await expect(problem(page)).toContainText('уже есть');
    await expect(problem(page).getByRole('link', { name: 'Открыть его' })).toBeVisible();
    await expect(page.getByTestId('project-name')).toHaveValue('Введённое');
  });

  test('предупреждение при уходе и закрытии вкладки', async ({ page, request }) => {
    const p = await createProject(request);
    await page.goto(`/${p.id}/settings/main`);
    await page.getByTestId('project-name').fill('Несохранённое');
    let asked = 0;
    page.once('dialog', (d) => {
      asked++;
      void d.dismiss();
    });
    await goToAllProjects(page);
    await expect.poll(() => asked).toBe(1);
    await expect(page).toHaveURL(new RegExp(`/${p.id}/settings/main$`));
    await expect(page.getByTestId('project-name')).toHaveValue('Несохранённое');

    const unload = new Promise<string>((resolve) =>
      page.once('dialog', (d) => {
        resolve(d.type());
        void d.dismiss();
      }),
    );
    await page.close({ runBeforeUnload: true });
    expect(await unload).toBe('beforeunload');
  });

  test('Tab проходит форму по порядку; ничего не изменилось — кнопка недоступна', async ({ page, request }) => {
    const p = await createProject(request);
    await page.goto(`/${p.id}/settings/main`);
    await expect(save(page)).toBeDisabled();
    await page.getByTestId('project-name').fill('Другое');
    await expect(save(page)).toBeEnabled();
    await page.getByTestId('project-name').fill(p.name);
    await expect(save(page)).toBeDisabled();

    await page.goto('/admin/projects/new');
    await page.getByTestId('project-name').focus();
    const order: (string | null)[] = [];
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Tab');
      order.push(await page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.textContent ?? null));
    }
    expect(order).toEqual(['project-id', 'project-timezone', 'project-retention', 'json', 'Выбрать файл']);
  });

  test('часовой пояс и срок хранения: ошибка у поля', async ({ page, request }) => {
    const p = await createProject(request);
    await page.goto(`/${p.id}/settings/main`);
    await page.getByTestId('project-timezone').fill('Karachi');
    await page.getByTestId('project-retention').fill('401');
    await save(page).click();
    await expect(page.getByTestId('field-error')).toHaveCount(2);
    expect((await settingOf(request, p.id))!.timezone).toBe('Asia/Karachi');
  });

  test('разметка в названии показана как текст', async ({ page, request }) => {
    const p = await createProject(request, { name: '<b>acme</b>' });
    await page.goto('/admin/projects');
    await expect(row(page, p.id)).toContainText('<b>acme</b>');
    await expect(row(page, p.id).locator('b')).toHaveCount(0);
  });
});

test.describe('форма: среды', () => {
  test('сохранённая среда только для чтения, новая с цифрами отклонена, последнюю не убрать', async ({ page, request }) => {
    const p = await createProject(request);
    await openEnvs(page, p.id);
    await expect(envCard(page).getByTestId('env-id')).toHaveAttribute('readonly');
    await expect(envCard(page)).toContainText('в адресах и ссылках');
    await expect(envCard(page).getByTestId('env-remove')).toBeDisabled();
    await expect(envCard(page).getByTestId('env-remove')).toHaveAttribute('title', /Последнюю среду/);

    await page.getByTestId('add-env').click();
    await envCard(page, 1).getByTestId('env-id').fill('2024');
    await envCard(page, 1).getByTestId('env-name').fill('Цифры');
    await envCard(page, 1).getByTestId('matcher-label').fill('namespace');
    await envCard(page, 1).getByTestId('matcher-value').fill('acme');
    await save(page).click();
    await expect(envCard(page, 1).getByTestId('field-error')).toContainText('только из цифр');
    for (const reserved of ['catalog', 'settings']) {
      await envCard(page, 1).getByTestId('env-id').fill(reserved);
      await save(page).click();
      await expect(envCard(page, 1).getByTestId('field-error')).toContainText('занят адресом страницы проекта');
    }
    await envCard(page, 1).getByTestId('env-id').fill('demo');
    await save(page).click();
    await expect(envCard(page, 1).getByTestId('field-error')).toContainText('уже есть');
    await expect(envCard(page, 0).getByTestId('field-error')).toContainText('уже есть');
  });

  test('порядок кнопками доезжает до выбора среды, с клавиатуры тоже', async ({ page, request }) => {
    const p = await createProject(request, { environments: [envBody({ id: 'first', name: 'Первая' }), envBody({ id: 'second', name: 'Вторая' })] });
    await openEnvs(page, p.id, 1);
    await envCard(page, 1).getByRole('button', { name: 'Выше: Вторая' }).focus();
    await page.keyboard.press('Enter');
    await expect(envCard(page, 0).getByTestId('env-name')).toHaveValue('Вторая');
    await saved(page);
    await goToAllProjects(page);
    await row(page, p.id).getByRole('link', { name: /Поиск/ }).click();
    await page.getByRole('main').getByRole('combobox', { name: /^Среда:/ }).click();
    // Текущая среда показывает состояние: начало строки — название.
    await expect(page.getByRole('option')).toHaveText([/^Вторая/, /^Первая/]);
  });

  test('ошибка стоит в нужной строке, предпросмотр показывает значение буквально', async ({ page, request }) => {
    const p = await createProject(request, { environments: [envBody({ id: 'first', name: 'Первая' }), envBody({ id: 'second', name: 'Вторая' })] });
    await openEnvs(page, p.id, 1);
    const value = envCard(page, 1).getByTestId('matcher-value');
    await value.fill(' с пробелом');
    await save(page).click();
    await expect(envCard(page, 1).getByTestId('field-error')).toBeVisible();
    await expect(envCard(page, 0).getByTestId('field-error')).toHaveCount(0);
    await expect(value).toHaveValue(' с пробелом');

    await value.fill('"} or {x="1');
    await expect(envCard(page, 1).getByTestId('env-preview')).toContainText('namespace = ""} or {x="1"');
    await expect(envCard(page, 1).getByTestId('env-preview')).not.toContainText('{namespace');
  });

  test('768px: без горизонтальной прокрутки при длинных значениях', async ({ page, request }) => {
    const p = await createProject(request);
    await page.setViewportSize({ width: 768, height: 900 });
    await openEnvs(page, p.id);
    await envCard(page).getByTestId('matcher-value').fill('a'.repeat(256));
    await envCard(page).getByTestId('env-name').fill('б'.repeat(80));
    await expect(envCard(page).getByTestId('env-preview')).toContainText('a'.repeat(50));
    expect(await noHorizontalScroll(page)).toBeLessThanOrEqual(0);
  });

  test('смена вида: поля стенда и предупреждение про ссылки', async ({ page, request }) => {
    const p = await createProject(request);
    await openEnvs(page, p.id);
    await choose(page, envCard(page).getByRole('combobox', { name: 'Вид' }), 'Стенды PR');
    await expect(envCard(page)).toContainText('откроют выбор стенда');
    await expect(envCard(page).getByTestId('stand-template')).toBeVisible();
    await envCard(page).getByTestId('stand-template').fill('demo-{number}');
    await expect(envCard(page).getByTestId('env-preview')).toContainText('namespace = "demo-{number}"');
  });
});

test.describe('форма: хранилища', () => {
  test('значение вне границы показывает разрешённое, запросов к хранилищу нет', async ({ page, request }) => {
    const p = await createProject(request);
    const calls = storageCalls(page);
    await openEnvs(page, p.id);
    await choose(page, envCard(page).getByRole('combobox', { name: 'Хранилище' }), /^grafana/);
    await expect(envCard(page).getByTestId('store-hint')).toContainText('THREADLINE_E2E_TOKEN_NOT_SET');
    await envCard(page).getByTestId('matcher-value').fill('core-banking');
    await save(page).click();
    await expect(envCard(page).getByTestId('field-error')).toContainText('pay');
    await expect(envCard(page).getByTestId('field-error')).toContainText('backends.grafana.formScope');
    expect((await settingOf(request, p.id))!.environments[0]!.backend).toBe('demo');
    expect(calls).toEqual([]);
  });

  test('имитация отмечена, токена и адреса нет ни в ответах, ни на странице', async ({ page, request }) => {
    const p = await createProject(request);
    await page.goto(`/${p.id}/settings/environments`);
    await expect(envCard(page)).toContainText('Синтетические данные');
    const body = await (await request.get('/api/project-settings')).text();
    expect(body).not.toContain('grafana.example.internal');
    expect(body).not.toContain('"url"');
    expect(await page.content()).not.toContain('grafana.example.internal');
    await page.goto('/admin/status');
    await expect(page.locator('[data-store=grafana]').getByTestId('store-scope')).toContainText('pay-pr-*');
  });
});

test.describe('форма: логотип', () => {
  const pick = (page: Page, theme: 'light' | 'dark', file: { name: string; mimeType: string; buffer: Buffer }) => page.getByTestId(`logo-${theme}`).locator('input[type=file]').setInputFiles(file);

  test('PNG и SVG: предпросмотр без нарушений политики, шапка показывает новый без перезагрузки, смена темы без сдвига', async ({ page, request, baseURL }) => {
    const p = await createProject(request);
    const problems: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') problems.push(m.text());
    });
    const foreign: string[] = [];
    page.on('request', (r) => {
      if (!r.url().startsWith(baseURL!) && !r.url().startsWith('data:')) foreign.push(r.url());
    });
    await page.goto(`/${p.id}/settings/main`);
    await pick(page, 'light', { name: 'light.svg', mimeType: 'image/svg+xml', buffer: svg('#0a84ff') });
    await pick(page, 'dark', { name: 'dark.png', mimeType: 'image/png', buffer: PNG });
    await expect(page.getByTestId('logo-light').locator('img')).toHaveAttribute('src', /^data:image\/svg\+xml/);
    await expect(page.getByTestId('logo-dark').locator('img')).toHaveAttribute('src', /^data:image\/png/);
    await saved(page);
    await expect(page.getByTestId('logo-light').locator('img')).toHaveAttribute('src', new RegExp(`/api/projects/${p.id}/logo/light`));

    await goToAllProjects(page);
    await row(page, p.id).getByRole('link', { name: /Поиск/ }).click();
    const logo = header(page).locator('nav img:visible');
    await expect(logo).toHaveAttribute('src', /\/logo\/light\?v=/);
    const before = await page.getByTestId('header-actions').boundingBox();
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(logo).toHaveAttribute('src', /\/logo\/dark\?v=/);
    expect(await page.getByTestId('header-actions').boundingBox()).toEqual(before);
    expect(problems).toEqual([]);
    expect(foreign).toEqual([]);

    // Замена и уборка: адрес новый, старый больше не отвечает.
    const old = await logo.getAttribute('src');
    await page.goto(`/${p.id}/settings/main`);
    await page.getByTestId('logo-light').getByRole('button', { name: 'Убрать' }).click();
    await saved(page);
    expect((await request.get(old!)).status()).toBe(404);
  });

  test('файл больше предела не отправляется, чужой формат называет допустимые', async ({ page, request }) => {
    const p = await createProject(request);
    await page.goto(`/${p.id}/settings/main`);
    await pick(page, 'light', { name: 'big.png', mimeType: 'image/png', buffer: Buffer.alloc(300 * 1024) });
    await expect(page.getByTestId('logo-light').getByTestId('field-error')).toContainText('больше предела 256');
    await expect(save(page)).toBeDisabled();
    await pick(page, 'light', { name: 'photo.gif', mimeType: 'image/gif', buffer: Buffer.from('GIF89a') });
    await expect(page.getByTestId('logo-light').getByTestId('field-error')).toContainText('PNG и SVG');
    await expect(save(page)).toBeDisabled();
  });

  test('ошибка сервера стоит у своей версии, ничего не сохранено', async ({ page, request }) => {
    const p = await createProject(request);
    await page.goto(`/${p.id}/settings/main`);
    await pick(page, 'light', { name: 'ok.svg', mimeType: 'image/svg+xml', buffer: svg('#0a84ff') });
    await pick(page, 'dark', { name: 'bad.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>') });
    await save(page).click();
    await expect(page.getByTestId('logo-dark').getByTestId('field-error')).toBeVisible();
    await expect(page.getByTestId('logo-light').getByTestId('field-error')).toHaveCount(0);
    expect((await settingOf(request, p.id))!.logo).toBeUndefined();
  });
});

test.describe('форма: профиль', () => {
  test('список совпадает с файлом, смена сохраняется и новый поиск идёт без перезапуска, редактора нет', async ({ page, request }) => {
    const p = await createProject(request);
    await page.goto(`/${p.id}/settings/main`);
    const select = page.getByRole('combobox', { name: 'Формат логов' });
    await select.click();
    await expect(page.getByRole('option')).toHaveText(['json', 'acme-json']);
    await page.keyboard.press('Escape');
    await expect(page.locator('textarea')).toHaveCount(0);
    await expect(page.getByRole('main')).toContainText('pnpm threadline:check');
    await choose(page, select, 'acme-json');
    await saved(page);
    expect((await settingOf(request, p.id))!.format).toBe('acme-json');
    const r = await request.post(`/api/projects/${p.id}/envs/demo/searches`, { data: { terms: ['lookup'], period: { preset: '1h' } } });
    expect(r.status()).toBe(200);
  });

  test('пропавший профиль показан у поля, проект можно починить', async ({ page, request }) => {
    const p = await createProject(request);
    await page.route('**/api/project-settings', async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as ProjectSettingsResponse;
      body.projects = body.projects.map((x) => (x.id === p.id ? { ...x, format: 'gone-format', issues: [{ path: `projects.${p.id}.format`, message: 'неизвестный профиль формата' }] } : x));
      await route.fulfill({ response: res, json: body });
    });
    await page.goto(`/${p.id}/settings/main`);
    await expect(page.getByRole('combobox', { name: 'Формат логов' })).toContainText('gone-format');
    await expect(page.getByTestId('field-error').first()).toContainText('неизвестный профиль');
    await page.goto('/admin/projects');
    await expect(row(page, p.id)).toContainText('Не прошёл проверку');
    await expect(row(page, p.id).getByTestId('project-issues')).toContainText(`projects.${p.id}.format`);
    await expect(row(page, p.id).getByRole('link', { name: /Поиск/ })).toHaveCount(0);
  });
});

test.describe('проверка подключения', () => {
  test('ноль запросов при вводе, сохранении и за час открытой страницы; результат по нажатию не двигает форму', async ({ page, request }) => {
    const p = await createProject(request, { environments: [envBody(), envBody({ id: 'second', name: 'Вторая' })] });
    const calls = storageCalls(page);
    await page.clock.install();
    await page.goto(`/${p.id}/settings/main`);
    await page.getByTestId('project-name').fill('Другое имя');
    await saved(page);
    await page.clock.fastForward('01:00:00');
    await page.goto('/admin/projects');
    await page.clock.fastForward('01:00:00');
    expect(calls).toEqual([]);

    await page.goto(`/${p.id}/settings/environments`);
    const next = await pageTop(envCard(page, 1));
    await envCard(page, 0).getByTestId('probe-button').click();
    await expect(envCard(page, 0).getByTestId('probe-result')).toHaveAttribute('data-status', 'demo');
    await expect(envCard(page, 0).getByTestId('probe-result')).toContainText('Демо');
    expect(await pageTop(envCard(page, 1))).toBe(next);
    expect(calls).toHaveLength(1);
  });

  test('несохранённая среда и хранилище без токена: имя переменной; условие вне границы — ошибка', async ({ page, request }) => {
    const p = await createProject(request);
    await openEnvs(page, p.id);
    await choose(page, envCard(page).getByRole('combobox', { name: 'Хранилище' }), /^grafana/);
    await envCard(page).getByTestId('matcher-value').fill('core-banking');
    await envCard(page).getByTestId('probe-button').click();
    await expect(envCard(page).getByTestId('probe-result')).toHaveAttribute('data-status', 'invalid');
    await expect(envCard(page).getByTestId('probe-result')).toContainText('вне границы');
    await envCard(page).getByTestId('matcher-value').fill('acme-test');
    await envCard(page).getByTestId('probe-button').click();
    await expect(envCard(page).getByTestId('probe-result')).toHaveAttribute('data-status', 'not-configured');
    await expect(envCard(page).getByTestId('probe-result')).toContainText('THREADLINE_E2E_TOKEN_NOT_SET');

    await page.goto('/admin/status');
    page.once('dialog', (d) => void d.accept());
    const store = page.locator('[data-store=grafana]');
    await store.getByTestId('store-probe').click();
    await expect(store.getByTestId('probe-result')).toHaveAttribute('data-status', 'not-configured');
  });

  test('состояния ошибок теми же текстами, что индикатор', async ({ page, request }) => {
    const p = await createProject(request);
    let status = 'unauthorized';
    await page.route('**/probe', (route) => route.fulfill({ json: { status, checkedAt: new Date().toISOString() } }));
    await page.goto(`/${p.id}/settings/environments`);
    for (status of ['unauthorized', 'forbidden', 'network', 'certificate', 'timeout', 'overloaded']) {
      await envCard(page).getByTestId('probe-button').click();
      const result = envCard(page).getByTestId('probe-result');
      await expect(result).toHaveAttribute('data-status', status);
      await expect(result).toContainText(ru.connection.status[status]!.title);
      await expect(result).toContainText(ru.connection.status[status]!.text.slice(0, 40));
    }
  });

  test('уход со страницы отменяет запрос', async ({ page, request }) => {
    const p = await createProject(request, { environments: [envBody({ backend: 'slow' })] });
    await page.goto(`/${p.id}/settings/environments`);
    // Имитация отвечает сразу, поэтому ответ придерживается: важно, что браузер сам закрывает запрос.
    await page.route('**/probe', () => undefined);
    const cancelled = page.waitForEvent('requestfailed', (r) => r.url().endsWith('/probe'));
    await envCard(page).getByTestId('probe-button').click();
    await goToAllProjects(page);
    await expect(page).toHaveURL(/\/admin\/projects$/);
    await cancelled;
  });
});

test.describe('скрытие и удаление', () => {
  test('последний видимый скрыть нельзя, с пояснением', async ({ page }) => {
    await page.goto('/admin/projects');
    await expect(page.getByTestId('project-row')).toHaveCount(1);
    await expect(page.getByRole('button', { name: /^Ещё:/ })).toHaveCount(0);
    await page.goto('/pay/settings/main');
    await expect(page.getByTestId('form-hide')).toBeDisabled();
    await expect(page.getByTestId('form-hide')).toHaveAttribute('title', /других видимых проектов нет/);
  });

  test('скрыть, править скрытый без показа, показать, удалить с вводом идентификатора; корень открывает проект по умолчанию', async ({ page, request }) => {
    const p = await createProject(request, { name: 'Временный портал' });
    await page.goto(`/${p.id}/demo`);
    await expect(header(page).getByRole('button', { name: 'Проект: Временный портал' })).toBeVisible();

    await page.goto(`/${p.id}/settings/main`);
    await page.getByTestId('form-hide').click();
    await expect(page.getByTestId('form-show')).toBeVisible();
    await page.goto('/admin/projects');
    await expect(row(page, p.id)).toHaveCount(0);
    await page.getByTestId('show-hidden').click();
    await expect(row(page, p.id)).toContainText('Скрыт');

    await page.goto(`/${p.id}/settings/main`);
    await page.getByTestId('project-name').fill('Переименованный портал');
    await saved(page);
    expect((await settingOf(request, p.id))!.hidden).toBe('page');

    await page.getByTestId('form-show').click();
    await expect(page.getByTestId('form-hide')).toBeVisible();
    expect((await settingOf(request, p.id))!.hidden).toBeNull();
    await page.getByTestId('form-hide').click();
    await expect(page.getByTestId('form-delete')).toBeVisible();

    await page.getByTestId('form-delete').click();
    const sheet = page.getByTestId('delete-sheet');
    await expect(sheet.getByTestId('delete-counts')).toContainText('систем 1');
    await expect(sheet.getByTestId('delete-confirm')).toBeDisabled();
    await sheet.getByTestId('delete-input').fill('другой');
    await expect(sheet.getByTestId('delete-confirm')).toBeDisabled();
    await sheet.getByTestId('delete-input').fill(p.id);
    await sheet.getByTestId('delete-confirm').click();
    await expect(page).toHaveURL(/\/admin\/projects$/);
    await expect(row(page, p.id)).toHaveCount(0);

    await page.goto('/');
    await expect(page).toHaveURL(/\/pay\/demo$/);
    await page.goto(`/${p.id}/demo`);
    await expect(page.getByRole('heading', { name: 'Такой среды нет' })).toBeVisible();

    // Создание заново: справочник пуст, старые записи не вернулись.
    await createProject(request, {}, p.id);
    const catalog = (await (await request.get(`/api/projects/${p.id}/catalog`)).json()) as { methods: unknown[] };
    expect(catalog.methods).toEqual([]);
  });

  test('скрытие из другой вкладки: идущий поиск остановлен, результаты показывают «устарел»', async ({ page, request }) => {
    const p = await createProject(request, { environments: [envBody({ backend: 'slow', name: 'Медленная' })] });
    await page.goto(`/${p.id}/demo`);
    await startSearch(page);
    await setHidden(request, p.id, true);
    await expect(page.getByText('Результат устарел')).toBeVisible({ timeout: 10_000 });
  });
});

test.describe('одновременная правка', () => {
  test('второй видит конфликт, введённое на месте, логотип не теряется; запись удалена — «Создать заново»', async ({ page, request, browser, baseURL }) => {
    const p = await createProject(request, { logo: { light: svg('#0a84ff').toString('base64') } });
    const other = await browser.newContext({ baseURL: baseURL!, locale: 'ru-RU' });
    const second = await other.newPage();
    await page.goto(`/${p.id}/settings/main`);
    await second.goto(`/${p.id}/settings/main`);

    await page.getByTestId('project-name').fill('Первая правка');
    await saved(page);

    await second.getByTestId('project-name').fill('Вторая правка');
    await save(second).click();
    await expect(problem(second)).toContainText('Проект изменили');
    await expect(second.getByTestId('project-name')).toHaveValue('Вторая правка');
    await problem(second).getByRole('button', { name: 'Загрузить свежую версию' }).click();
    await expect(problem(second)).toHaveCount(0);
    await expect(second.getByTestId('project-name')).toHaveValue('Вторая правка');
    await saved(second);
    const after = (await settingOf(request, p.id))!;
    expect(after.name).toBe('Вторая правка');
    expect(after.logo).toBeDefined();
    await second.getByTestId('project-name').fill('Третья правка');
    await removeProject(request, p.id);
    await save(second).click();
    await expect(problem(second)).toContainText('больше нет');
    await expect(second.getByTestId('project-name')).toHaveValue('Третья правка');
    await problem(second).getByRole('button', { name: 'Создать заново' }).click();
    await expect(save(second)).toHaveText('Создать');
    await save(second).click();
    await expect(second.getByTestId('project-name')).toHaveValue('Третья правка');
    await expect.poll(async () => (await settingOf(request, p.id))?.name).toBe('Третья правка');
    await other.close();
  });
});

test.describe('отметки файла', () => {
  test('все состояния и действия; просьба про удалённый проект', async ({ page, request }) => {
    const ids = { here: uniqueId('here'), newer: uniqueId('newer'), removed: uniqueId('removed'), none: uniqueId('none') };
    for (const id of Object.values(ids)) await createProject(request, {}, id);
    const sent: unknown[] = [];
    await page.route('**/api/project-settings', async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as ProjectSettingsResponse;
      body.projects = body.projects.map((x) => {
        if (x.id === ids.here) return { ...x, fileState: 'here' as const };
        if (x.id === ids.newer) return { ...x, fileState: 'file-newer' as const };
        if (x.id === ids.removed) return { ...x, fileState: 'removed' as const, hidden: 'file' as const };
        return x;
      });
      body.ignoredInFile = ['old-project'];
      await route.fulfill({ response: res, json: body });
    });
    await page.route('**/file-version', async (route) => {
      sent.push(route.request().postDataJSON());
      await route.fulfill({ json: { ...(await settingOf(request, ids.newer))!, fileState: 'file-newer' } });
    });

    await page.goto('/admin/projects');
    await expect(page.getByRole('main')).toContainText('old-project');
    await page.getByTestId('show-hidden').click();
    const mark = (id: string) => row(page, id).getByTestId('file-mark');
    await expect(mark(ids.here)).toHaveAttribute('data-state', 'here');
    await expect(mark(ids.newer)).toHaveText('Файл изменился, не применён');
    await expect(mark(ids.removed)).toHaveText('Убран из файла');
    await expect(mark(ids.none)).toHaveText('Только на странице');
    await expect(page.locator('[data-project=pay]').getByTestId('file-mark')).toHaveCount(0);

    // Действия с файлом и показ только на странице настроек проекта.
    await expect(page.getByRole('main').getByRole('button', { name: 'Взять из файла' })).toHaveCount(0);
    await page.goto(`/${ids.here}/settings/main`);
    await expect(page.getByRole('button', { name: 'Взять из файла' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Оставить' })).toHaveCount(0);
    await page.goto(`/${ids.newer}/settings/main`);
    await page.getByRole('button', { name: 'Оставить' }).click();
    await expect.poll(() => sent.length).toBe(1);
    await page.getByRole('button', { name: 'Взять из файла' }).click();
    await expect.poll(() => sent.length).toBe(2);
    expect(sent).toMatchObject([{ action: 'keep' }, { action: 'take' }]);
    await page.goto(`/${ids.removed}/settings/main`);
    await expect(page.getByTestId('form-show')).toBeVisible();
  });
});

test.describe('живые эффекты', () => {
  const NEAR = { selector: [{ label: 'namespace', op: '=', value: 'other-namespace' }] };

  test('смена условий среды в другой вкладке останавливает поиск, название не трогает', async ({ page, request }) => {
    const p = await createProject(request, { environments: [envBody({ backend: 'slow', name: 'Медленная' })] });
    await page.goto(`/${p.id}/demo`);
    await startSearch(page);
    await editProject(request, p.id, { name: 'Новое имя' });
    await expect(page.getByTestId('search-results')).toHaveAttribute('data-status', /^(running|done)$/);
    await expect(page.getByText('Результат устарел')).toHaveCount(0);

    const environments = (await settingOf(request, p.id))!.environments.map((e) => ({ ...e, ...NEAR }));
    await editProject(request, p.id, { environments });
    await expect(page.getByText('Результат устарел')).toBeVisible({ timeout: 10_000 });
  });

  test('страница запроса читает по новому селектору, новое название среды, убранная среда — неизвестная', async ({ page, request }) => {
    const p = await createProject(request, { environments: [envBody(), envBody({ id: 'second', name: 'Вторая' })] });
    await page.goto(`/${p.id}/demo`);
    await page.getByRole('group', { name: 'Период' }).getByRole('button', { name: '24 ч', exact: true }).click();
    await startSearch(page, 'getCard');
    const first = page.getByRole('list', { name: 'Найденные запросы' }).getByRole('listitem').first();
    await expect(first).toBeVisible({ timeout: 20_000 });
    const cid = (await first.getAttribute('data-cid'))!;
    const now = Date.now();
    const link = `/${p.id}/demo/requests/${encodeURIComponent(cid)}?from=${now - 24 * 3_600_000}&to=${now}`;

    await editProject(request, p.id, { environments: (await settingOf(request, p.id))!.environments.map((e) => (e.id === 'demo' ? { ...e, name: 'Переименованная' } : e)) });
    await page.goto(link);
    await expect(page.getByTestId('env-mark')).toContainText('Переименованная');
    await expect(page.getByRole('heading', { name: 'Записей запроса за этот период нет' })).toHaveCount(0);

    await editProject(request, p.id, { environments: (await settingOf(request, p.id))!.environments.map((e) => (e.id === 'demo' ? { ...e, ...NEAR } : e)) });
    await page.goto(link);
    await expect(page.getByRole('heading', { name: 'Записей запроса за этот период нет' })).toBeVisible();

    await editProject(request, p.id, { environments: (await settingOf(request, p.id))!.environments.filter((e) => e.id !== 'demo') });
    await page.goto(link);
    await expect(page.getByRole('heading', { name: 'Такой среды нет' })).toBeVisible();
  });

  test('среду убрали, пока открыта её страница: ответ сервера перечитывает список', async ({ page, request }) => {
    const p = await createProject(request, { environments: [envBody(), envBody({ id: 'second', name: 'Вторая' })] });
    await page.goto(`/${p.id}/second`);
    await expect(page.getByRole('textbox', { name: 'Значения для поиска' })).toBeVisible();
    await editProject(request, p.id, { environments: (await settingOf(request, p.id))!.environments.filter((e) => e.id !== 'second') });
    await startSearch(page).catch(() => undefined);
    await expect(page.getByRole('heading', { name: 'Такой среды нет' })).toBeVisible();
  });

  test('форма другого пользователя не теряет введённое при обновлении списка', async ({ page, request }) => {
    const p = await createProject(request);
    await page.clock.install();
    const first = page.waitForResponse('**/api/catalog');
    await page.goto(`/${p.id}/settings/main`);
    await first;
    await page.getByTestId('project-name').fill('Моё название');
    await editProject(request, p.id, { name: 'Чужое название' });
    const settings = page.waitForResponse('**/api/project-settings');
    await page.clock.fastForward(61_000);
    await settings;
    await expect(page.getByTestId('project-name')).toHaveValue('Моё название');
    await removeProject(request, p.id);
    const again = page.waitForResponse('**/api/project-settings');
    await page.clock.fastForward(61_000);
    await again;
    await expect(page.getByTestId('project-name')).toHaveValue('Моё название');
  });

  test('база поднялась: вкладка обновляет список и открывает правку без перезагрузки', async ({ page }) => {
    let up = false;
    const projectsAsked: number[] = [];
    await page.route('**/api/project-settings', async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as ProjectSettingsResponse;
      await route.fulfill({ response: res, json: up ? body : { ...body, state: 'connecting', editable: false, message: 'база справочника недоступна (db.test:5432/x)', loadedAt: null } });
    });
    await page.route('**/api/projects', async (route) => {
      projectsAsked.push(1);
      const res = await route.fetch();
      await route.fulfill({ response: res, json: { ...((await res.json()) as object), incomplete: !up } });
    });
    await page.route('**/api/catalog', async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as { projectsVersion: number };
      await route.fulfill({ response: res, json: up ? body : { ...body, state: 'connecting', projectsVersion: 0 } });
    });
    await page.clock.install();
    const first = page.waitForResponse('**/api/catalog');
    await page.goto('/admin/projects');
    await first;
    await expect(page.getByTestId('projects-source')).toContainText('db.test:5432');
    await expect(page.getByRole('link', { name: 'Добавить проект' })).toHaveCount(0);

    await projectButton(page).focus();
    up = true;
    await page.clock.fastForward(61_000);
    await expect(page.getByRole('link', { name: 'Добавить проект' })).toBeVisible();
    await expect(page.getByTestId('projects-source')).toHaveCount(0);
  });

  test('при connecting ссылка на проект из базы говорит «список неполон»', async ({ page }) => {
    await page.route('**/api/projects', async (route) => {
      const res = await route.fetch();
      await route.fulfill({ response: res, json: { ...((await res.json()) as object), incomplete: true } });
    });
    await page.goto('/acme/prod/requests/cid-synthetic?from=1&to=2');
    await expect(page.getByRole('heading', { name: 'Список проектов неполон' })).toBeVisible();
  });
});
