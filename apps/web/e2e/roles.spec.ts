// Вход и роли на настоящем сервере с ложным сервисом входа: по одному небольшому сценарию на роль и один на отсутствие роли.
// Значения синтетические, наружу ничего не ходит. Остальные наборы идут с auth: off.
import { expect, test, type Page } from '@playwright/test';
import { MOCK_PERSONAL } from '../../server/src/backends/mock/dataset-pay.ts';
import { closeMenu, helpButton, openHelpMenu, openUserMenu, serviceLink, userMenu } from './helpers.ts';

const ROW_HIT = { position: { x: 8, y: 8 } };

/** Открыть адрес без сессии и войти на странице ложного сервиса. */
async function signIn(page: Page, url: string, user: string) {
  await page.goto(url);
  await page.locator(`a[data-user="${user}"]`).click();
}

async function openRequest(page: Page) {
  const input = page.getByRole('textbox', { name: 'Значения для поиска' });
  await input.fill(MOCK_PERSONAL.cid);
  await input.press('Enter');
  await page.getByRole('group', { name: 'Период' }).getByRole('button', { name: '24 ч', exact: true }).click();
  await page.getByRole('button', { name: 'Найти', exact: true }).click();
  await expect(page.getByTestId('search-results')).toHaveAttribute('data-status', 'done', { timeout: 20_000 });
  await page.getByRole('list', { name: 'Найденные запросы' }).getByRole('listitem').first().locator('[data-row-link]').click(ROW_HIT);
  await expect(page.getByTestId('request-header')).toBeVisible();
}

/** Ответ страницы запроса по ссылке: тот же адрес, что и у открытой страницы. */
const requestApi = (page: Page, suffix = '') => {
  const url = new URL(page.url());
  return `/api/projects/pay/envs/demo/requests/${MOCK_PERSONAL.cid}${suffix}${url.search}`;
};

const api = (page: Page, method: 'get' | 'post' | 'put', url: string, data?: unknown) => page.request[method](url, { headers: { 'content-type': 'application/json' }, ...(data === undefined ? {} : { data }) });

test.describe('вход', () => {
  test('глубокая ссылка: после входа тот же адрес со строкой запроса и якорем', async ({ page }) => {
    await signIn(page, '/pay/demo?x=1#part', 'support');
    await expect(page).toHaveURL(/\/pay\/demo\?x=1#part$/);
    await expect(page.getByTestId('user-menu')).toBeVisible();
    const cookies = await page.context().cookies();
    const session = cookies.find((c) => c.name === 'threadline.sid');
    expect(session?.httpOnly).toBe(true);
    expect(session?.sameSite).toBe('Lax');
    expect(await page.evaluate(() => document.cookie)).not.toContain('threadline.sid');
  });

  test('выход: сессия завершена, страница «Вы вышли», вход сам не запускается, назад не открывает данные', async ({ page }) => {
    await signIn(page, '/pay/demo', 'analyst');
    await page.getByTestId('user-menu').click();
    await expect(page.getByTestId('user-menu-name')).toContainText('Тест Аналитик');
    await expect(page.getByTestId('user-menu-role')).toHaveText('Аналитик');
    await page.getByTestId('user-menu-logout').click();
    await expect(page.getByTestId('auth-screen-logged-out')).toBeVisible();
    await expect(page).toHaveURL(/\/logged-out$/);
    expect((await api(page, 'get', '/api/projects')).status()).toBe(401);
    await page.getByTestId('auth-login').click();
    await expect(page.locator('a[data-user="analyst"]')).toBeVisible();
  });

  test('ошибка входа: свои слова, текста из адреса нет, «Войти снова» работает', async ({ page }) => {
    await page.goto('/auth-error?reason=clock&error_description=keycloak-text');
    await expect(page.getByTestId('auth-screen-auth-error')).toContainText('Часы сервера');
    await expect(page.locator('body')).not.toContainText('keycloak-text');
    await page.getByTestId('auth-login').click();
    await expect(page.locator('a[data-user="admin"]')).toBeVisible();
  });

  test('подделанный ответ сервиса входа ведёт на экран ошибки', async ({ page }) => {
    await page.goto('/api/auth/callback?state=forged&code=x');
    await expect(page).toHaveURL(/\/auth-error\?reason=state$/);
    await expect(page.getByTestId('auth-screen-auth-error')).toBeVisible();
  });

  test('сессия пропала при открытой странице: 401 ведёт на вход с возвратом на тот же адрес', async ({ page }) => {
    await signIn(page, '/pay/demo', 'developer');
    await expect(page.getByTestId('user-menu')).toBeVisible();
    await page.context().clearCookies();
    await page.goto('/admin/projects');
    await page.locator('a[data-user="developer"]').click();
    await expect(page).toHaveURL(/\/admin\/projects$/);
    await expect(page.getByTestId('projects-list')).toBeVisible();
  });
});

test.describe('сессия при открытой странице', () => {
  const name = (page: Page) => page.getByTestId('project-name');

  test('несохранённая форма: страница не уходит, вход в новой вкладке, возврат закрывает окно, сохранение работает', async ({ page, context }) => {
    await signIn(page, '/pay/settings/main', 'analyst');
    await expect(name(page)).toBeVisible();
    const typed = `Demo Pay ${Date.now() % 1000}`;
    await name(page).fill(typed);
    const cookies = await context.cookies();
    await context.clearCookies();
    await page.getByTestId('project-save').click();
    await expect(page.getByTestId('session-expired')).toBeVisible();
    await expect(page).toHaveURL(/\/pay\/settings\/main$/);
    await expect(name(page)).toHaveValue(typed);
    const [tab] = await Promise.all([context.waitForEvent('page'), page.getByTestId('session-expired-login').click()]);
    await tab.locator('a[data-user="analyst"]').click();
    await expect(tab.getByTestId('auth-screen-auth-done')).toBeVisible();
    await tab.close();
    await page.bringToFront();
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByTestId('session-expired')).toHaveCount(0);
    await expect(name(page)).toHaveValue(typed);
    expect(cookies.length).toBeGreaterThan(0);
    await page.getByTestId('project-save').click();
    await expect(page.getByTestId('project-save')).toBeDisabled();
    expect(((await (await api(page, 'get', '/api/project-settings')).json()) as { projects: { id: string; name: string }[] }).projects.find((p) => p.id === 'pay')?.name).toBe(typed);
  });

  test('браузер не сохраняет сессию: цикла переходов нет, экран предлагает повторить', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 401, json: { error: { code: 'unauthenticated' } } }));
    await page.goto('/pay/demo');
    await page.locator('a[data-user="support"]').click();
    await expect(page.getByTestId('auth-screen-lost')).toBeVisible();
    await expect(page).toHaveURL(/\/pay\/demo$/);
  });

  test('сервер отвечает 5xx: это не конец сессии, на вход страница не уходит', async ({ page }) => {
    await signIn(page, '/pay/demo', 'support');
    await expect(page.getByTestId('user-menu')).toBeVisible();
    const down = { status: 503, json: { error: { code: 'unknown' } } };
    await page.route('**/api/auth/me', (route) => route.fulfill(down));
    await page.route('**/api/projects', (route) => route.fulfill(down));
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Сервер Threadline недоступен' })).toBeVisible();
    await expect(page).toHaveURL(/\/pay\/demo$/);
  });

  test('отказ 403 при открытой форме: ввод на месте, сообщение называет отказ, кнопки больше нет', async ({ page }) => {
    await signIn(page, '/pay/settings/main', 'analyst');
    await expect(name(page)).toBeVisible();
    await name(page).fill('Правка без права');
    await page.route('**/api/auth/me', (route) => route.fulfill({ json: { mode: 'on', user: { name: 'Тест Аналитик' }, role: 'developer', capabilities: ['view', 'details', 'reveal', 'editErrors', 'editCatalog', 'importCatalog'] } }));
    await page.route('**/api/projects/pay', (route) => route.fulfill({ status: 403, json: { error: { code: 'forbidden' } } }));
    await page.getByTestId('project-save').click();
    await expect(page.getByTestId('project-save')).toHaveCount(0);
    await expect(name(page)).toHaveValue('Правка без права');
    await expect(page).toHaveURL(/\/pay\/settings\/main$/);
  });

  test('роль сменилась: не позже чем через 60 секунд страница перечитана по новой роли', async ({ page }) => {
    await page.clock.install();
    await signIn(page, '/pay/demo', 'support');
    await openUserMenu(page);
    await expect(serviceLink(page)).toBeVisible();
    await expect(userMenu(page).getByTestId('detail-switch')).toBeVisible();
    await closeMenu(page);
    await page.route('**/api/auth/me', (route) => route.fulfill({ json: { mode: 'on', user: { name: 'Тест Поддержка' }, role: 'business', capabilities: ['view'] } }));
    // Новая роль перечитывает страницу: меню открывается уже после этого, иначе перезагрузка закрыла бы его.
    const reloaded = page.waitForEvent('load');
    await page.clock.fastForward(61_000);
    await reloaded;
    // Меню профиля по новой роли: без «Настроек сервиса» и без режима показа.
    await openUserMenu(page);
    await expect(userMenu(page).getByTestId('user-menu-role')).toHaveText('Бизнес');
    await expect(serviceLink(page)).toHaveCount(0);
    await expect(userMenu(page).getByTestId('detail-switch')).toHaveCount(0);
  });
});

test('Бизнес: вид без подробностей, закрытые разделы и ответы сервера', async ({ page }) => {
  await signIn(page, '/pay/demo', 'business');
  await expect(page.getByTestId('user-menu')).toBeVisible();
  // В меню профиля нет «Настроек сервиса», «Проектов» и режима показа: он закреплён ролью. «Справка» есть.
  await openUserMenu(page);
  await expect(userMenu(page).getByTestId('user-menu-role')).toHaveText('Бизнес');
  await expect(serviceLink(page)).toHaveCount(0);
  await expect(userMenu(page).getByTestId('user-menu-projects')).toHaveCount(0);
  await expect(userMenu(page).getByTestId('detail-switch')).toHaveCount(0);
  await closeMenu(page);
  await expect(helpButton(page)).toBeVisible();
  // В настройке один проект: название текстом, без кнопки и меню.
  await expect(page.getByTestId('header-unknown')).toHaveCount(0);
  await expect(page.getByTestId('header-project-name')).toContainText('Demo Pay');
  await expect(page.getByTestId('project-menu')).toHaveCount(0);
  await openRequest(page);
  await expect(page.getByTestId('detail-switch')).toHaveCount(0);
  await expect(page.getByTestId('reveal-button')).toHaveCount(0);
  await expect(page.getByTestId('copy-curl')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(MOCK_PERSONAL.surname);

  const read = await api(page, 'get', requestApi(page));
  expect(read.status()).toBe(200);
  const text = await read.text();
  for (const value of [MOCK_PERSONAL.phone, MOCK_PERSONAL.surname, MOCK_PERSONAL.nationalId, MOCK_PERSONAL.pan, MOCK_PERSONAL.password]) expect(text).not.toContain(value);
  expect((await api(page, 'get', requestApi(page, '/reveal'))).status()).toBe(403);
  expect((await api(page, 'get', '/api/project-settings')).status()).toBe(403);
  expect((await api(page, 'get', '/api/projects/pay/catalog')).status()).toBe(403);

  await page.goto('/pay/catalog');
  await expect(page.getByTestId('section-closed')).toBeVisible();
  await page.goto('/admin/projects');
  await expect(page.getByTestId('section-closed')).toBeVisible();
  await expect(page.getByRole('link', { name: 'К поиску' })).toBeVisible();
  // Старый адрес ведёт на новый, правила доступа у него те же.
  for (const path of ['/settings', '/admin/settings', '/admin/status']) {
    await page.goto(path);
    await expect(page.getByTestId('section-closed')).toBeVisible();
  }
});

test('Поддержка: ошибки правит, остальное только читает, глазок есть', async ({ page }) => {
  await signIn(page, '/pay/catalog', 'support');
  await expect(page.getByTestId('catalog-page')).toBeVisible();
  await expect(page.getByTestId('catalog-add-system')).toHaveCount(0);
  await page.getByTestId('catalog-file-open').click();
  await expect(page.getByTestId('project-file').locator('.cm-content')).toBeVisible();
  await expect(page.getByTestId('import-input')).toHaveCount(0);
  await expect(page.getByTestId('file-download')).toBeVisible();
  await page.goto('/pay/demo');
  await openRequest(page);
  await expect(page.getByTestId('reveal-button')).toBeVisible();
  const read = await api(page, 'get', requestApi(page));
  expect(read.status()).toBe(200);
  expect(await read.text()).not.toContain(MOCK_PERSONAL.nationalId);
  await page.goto('/admin/projects');
  await expect(page.getByTestId('projects-list')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Добавить проект' })).toHaveCount(0);
  expect((await api(page, 'post', '/api/projects/pay/catalog/methods', {})).status()).toBe(403);
  expect((await api(page, 'put', '/api/projects/pay', {})).status()).toBe(403);
  expect((await api(page, 'post', '/api/projects/pay/catalog/import', 'version: 1')).status()).toBe(403);
});

test('Поддержка: ошибка на неописанной системе описывается с первого раза', async ({ page }) => {
  await signIn(page, '/pay/demo', 'support');
  const input = page.getByRole('textbox', { name: 'Значения для поиска' });
  await input.fill('getCard');
  await input.press('Enter');
  await page.getByRole('group', { name: 'Период' }).getByRole('button', { name: '24 ч', exact: true }).click();
  await page.getByRole('button', { name: 'Найти', exact: true }).click();
  await expect(page.getByTestId('search-results')).toHaveAttribute('data-status', 'done', { timeout: 20_000 });
  await page.getByRole('list', { name: 'Найденные запросы' }).getByRole('listitem').filter({ hasText: 'Ошибка' }).first().locator('[data-row-link]').click(ROW_HIT);
  const details = page.getByTestId('step-details');
  await details.getByTestId('step-catalog-add').click();
  const form = page.getByTestId('catalog-form');
  await expect(form.getByTestId('error-no-system')).toBeVisible();
  await expect(form.getByRole('combobox', { name: 'Где действует' })).toHaveText('Общие правила');
  await expect(form.getByRole('textbox', { name: 'Подстрока текста' })).toHaveValue('PRC-ERR-0027 Card not found');
  await form.getByRole('textbox', { name: 'Текст ошибки' }).fill('Карта не найдена в процессинге (тест)');
  await form.getByRole('button', { name: 'Сохранить' }).click();
  await expect(form).toBeHidden();
  const saved = () => details.getByTestId('step-catalog-text');
  await expect(saved()).toHaveText('Карта не найдена в процессинге (тест)');
  await page.reload();
  await expect(saved()).toHaveText('Карта не найдена в процессинге (тест)');
  await expect(details.getByTestId('step-catalog-edit')).toBeVisible();
  // Запись общая для сервера ролей: остальным сценариям она не нужна.
  const catalog = (await (await api(page, 'get', '/api/projects/pay/catalog')).json()) as { errors: { id: number; title: string; updatedAt: string }[] };
  const row = catalog.errors.find((e) => e.title.endsWith('(тест)'))!;
  expect((await page.request.delete(`/api/projects/pay/catalog/errors/${row.id}?updatedAt=${encodeURIComponent(row.updatedAt)}`)).ok()).toBe(true);
});

test('Разработчик: справочник правит, проекты и маскирование только читает', async ({ page }) => {
  await signIn(page, '/pay/catalog', 'developer');
  await expect(page.getByTestId('catalog-page')).toBeVisible();
  await expect(page.getByTestId('catalog-add-system')).toBeVisible();
  await page.goto('/pay/settings/main');
  await expect(page.getByRole('button', { name: /^Сохранить/ })).toHaveCount(0);
  expect((await api(page, 'put', '/api/projects/pay/view', {})).status()).toBe(403);
  expect((await api(page, 'put', '/api/projects/pay/catalog/masking/phone', {})).status()).toBe(403);
});

test('Аналитик: значения сразу в блоках, проект правит, создавать нельзя', async ({ page }) => {
  await signIn(page, '/pay/demo', 'analyst');
  await openRequest(page);
  const read = await api(page, 'get', requestApi(page));
  expect(read.status()).toBe(200);
  const detail = (await read.json()) as { records: { title: string; open?: unknown }[] };
  expect(JSON.stringify(detail.records.map((r) => r.open ?? null))).toContain(MOCK_PERSONAL.nationalId);
  expect(JSON.stringify(detail.records.map((r) => r.title))).not.toContain(MOCK_PERSONAL.nationalId);
  await page.goto('/admin/projects/new');
  await expect(page.getByTestId('section-closed')).toBeVisible();
  await page.getByRole('main').getByRole('link', { name: 'К списку проектов' }).click();
  await expect(page).toHaveURL(/\/admin\/projects$/);
  await expect(page.getByTestId('projects-list')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Добавить проект' })).toHaveCount(0);
  expect((await api(page, 'post', '/api/projects', {})).status()).toBe(403);
  expect((await api(page, 'get', '/api/projects/pay/delete-preview')).status()).toBe(403);
});

test('старый адрес без сессии: вход, затем новый адрес', async ({ page }) => {
  await signIn(page, '/projects/pay?tab=view', 'analyst');
  await expect(page).toHaveURL(/\/pay\/settings\/view$/);
  await expect(page.getByTestId('project-form')).toBeVisible();
});

test('Администратор: все разделы открыты', async ({ page }) => {
  await signIn(page, '/admin/projects/new', 'admin');
  await expect(page.getByTestId('section-closed')).toHaveCount(0);
  await expect(page).toHaveURL(/\/admin\/projects\/new$/);
  await page.goto('/pay/settings/masks');
  await expect(page.getByTestId('masking-switch').first()).toBeVisible();
  expect((await api(page, 'get', '/api/projects/pay/delete-preview')).status()).not.toBe(403);
});

test('без роли: «Нет доступа» на каждой странице, запросов данных нет, выход работает', async ({ page }) => {
  const dataRequests: string[] = [];
  page.on('request', (r) => {
    const path = new URL(r.url()).pathname;
    // Контакт поддержки — единственный маршрут для пользователя без роли: в нём только этот текст и ссылка.
    if (path.startsWith('/api/') && !path.startsWith('/api/auth/') && path !== '/api/support-contact') dataRequests.push(path);
  });
  await signIn(page, `/pay/demo/requests/${MOCK_PERSONAL.cid}?from=1&to=2`, 'norole');
  await expect(page.getByTestId('auth-screen-no-access')).toContainText('Тест Без Роли');
  for (const path of ['/', '/docs', '/admin/projects', '/pay/catalog', '/about']) {
    await page.goto(path);
    await expect(page.getByTestId('auth-screen-no-access')).toBeVisible();
  }
  expect(dataRequests).toEqual([]);
  expect((await api(page, 'get', '/api/projects')).status()).toBe(403);
  await page.getByTestId('auth-logout').click();
  await expect(page.getByTestId('auth-screen-logged-out')).toBeVisible();
});

test.describe('ширина и темы', () => {
  for (const [width, scheme] of [[768, 'light'], [768, 'dark'], [2560, 'light'], [2560, 'dark']] as const) {
    test(`шапка и экраны: ${width}px, ${scheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width, height: 800 });
      await signIn(page, '/pay/demo', 'support');
      const menu = page.getByTestId('user-menu');
      await expect(menu).toBeVisible();
      const box = await menu.boundingBox();
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      const header = await page.locator('header').first().boundingBox();
      expect(header!.height).toBeLessThanOrEqual(58);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
      await page.goto('/logged-out?provider=unreachable');
      await expect(page.getByTestId('auth-screen-logged-out')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    });
  }
});

test.describe.serial('контакт поддержки', () => {
  const setting = (page: Page, name: string) => page.getByTestId(`setting-support-${name}`);
  const fill = (page: Page, name: string, value: string) => setting(page, name).getByTestId('setting-input').fill(value);
  /** «Общие» — одна форма: одна «Сохранить» сохраняет все изменённые поля. */
  const save = async (page: Page) => {
    await page.getByTestId('setting-save').click();
    await expect(page.getByTestId('setting-saved')).toBeVisible();
  };

  test('администратор задаёт, без роли и у Бизнеса он виден, ссылка безопасна; очищен — прежний текст', async ({ page, browser }) => {
    await signIn(page, '/settings', 'admin');
    // Неверная ссылка не сохраняется: пока поле с ошибкой, кнопка формы закрыта.
    await fill(page, 'contactUrl', 'http://support.example');
    await expect(setting(page, 'contactUrl').getByTestId('setting-invalid')).toBeVisible();
    await expect(page.getByTestId('setting-save')).toBeDisabled();
    await fill(page, 'contactText', 'Дежурная смена, тел. 1234');
    await expect(page.getByTestId('setting-save')).toBeDisabled();
    await fill(page, 'contactUrl', 'https://support.example/ask');
    await expect(page.getByTestId('settings-dirty')).toHaveText('Изменено 2 поля');
    await save(page);

    const noRole = await browser.newContext({ locale: 'ru-RU' });
    const none = await noRole.newPage();
    await signIn(none, '/pay/demo', 'norole');
    const screen = none.getByTestId('auth-screen-no-access');
    await expect(screen.getByTestId('support-contact')).toContainText('Дежурная смена, тел. 1234');
    await expect(screen).toContainText('Обратитесь к администратору сервиса входа (OIDC)');
    const link = screen.getByTestId('support-contact-link');
    await expect(link).toHaveAttribute('href', 'https://support.example/ask');
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    await none.setViewportSize({ width: 768, height: 800 });
    expect(await none.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    const biz = await browser.newContext({ locale: 'ru-RU' });
    const business = await biz.newPage();
    await signIn(business, '/pay/demo', 'business');
    await expect(business.getByTestId('user-menu')).toBeVisible();
    const input = business.getByRole('textbox', { name: 'Значения для поиска' });
    await input.fill('pay.example');
    await input.press('Enter');
    await business.getByRole('group', { name: 'Период' }).getByRole('button', { name: '24 ч', exact: true }).click();
    await business.getByRole('button', { name: 'Найти', exact: true }).click();
    await expect(business.getByTestId('search-results')).toHaveAttribute('data-status', 'done', { timeout: 20_000 });
    await business.locator('li[data-status="error"] [data-row-link]').first().click(ROW_HIT);
    await expect(business.getByTestId('reasons-undescribed')).toBeVisible();
    await expect(business.getByTestId('request-reasons').getByTestId('support-contact')).toContainText('Дежурная смена');

    // Очищено: прежний текст, пустой подписи нет.
    await page.reload();
    await fill(page, 'contactText', '');
    await fill(page, 'contactUrl', '');
    await save(page);
    await none.reload();
    await expect(none.getByTestId('auth-screen-no-access')).toContainText('Обратитесь к администратору сервиса входа (OIDC)');
    await expect(none.getByTestId('support-contact')).toHaveCount(0);
    await business.reload();
    await expect(business.getByTestId('reasons-undescribed')).toBeVisible();
    await expect(business.getByTestId('support-contact')).toHaveCount(0);
    await noRole.close();
    await biz.close();
  });

  test('несохранённое значение в первой настройке тоже спрашивает при уходе', async ({ page }) => {
    await signIn(page, '/settings', 'admin');
    await page.getByTestId('setting-share-lifetimeDays').getByTestId('setting-input').fill('7');
    // Окно браузера открывается во время нажатия в пункт меню: ответ задаётся заранее.
    let asked = 0;
    page.once('dialog', (dialog) => {
      asked++;
      void dialog.dismiss();
    });
    await openHelpMenu(page);
    await page.getByTestId('header-docs').click();
    await expect.poll(() => asked).toBe(1);
    await expect(page).toHaveURL(/\/admin\/status#settings$/);
  });
});
