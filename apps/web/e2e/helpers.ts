import { expect, type Locator, type Page } from '@playwright/test';

// Адреса и открытие меню шапки в одном месте: правка шапки меняет их один раз.

export const paths = {
  projects: '/admin/projects',
  newProject: '/admin/projects/new',
  status: '/admin/status',
  projectMain: (id: string) => `/${id}/settings/main`,
  projectEnvironments: (id: string) => `/${id}/settings/environments`,
  projectView: (id: string) => `/${id}/settings/view`,
  masks: (id: string) => `/${id}/settings/masks`,
  catalog: (id: string) => `/${id}/catalog`,
  system: (id: string, key: string) => `/${id}/catalog/systems/${key}`,
};

export const header = (page: Page) => page.getByRole('banner');
export const homeLink = (page: Page) => header(page).getByRole('link', { name: 'Threadline, на главную' });
export const projectButton = (page: Page) => page.getByTestId('project-menu');
export const projectMenu = (page: Page) => page.getByTestId('project-menu-content');
export const userButton = (page: Page) => page.getByTestId('user-menu').or(page.getByTestId('auth-off'));
export const userMenu = (page: Page) => page.getByTestId('user-menu-content');
export const helpButton = (page: Page) => page.getByTestId('header-help');
export const serviceLink = (page: Page) => page.getByTestId('header-service');
export const languageItem = (page: Page, name: string) => page.getByRole('menuitemradio', { name, exact: true });

export async function openProjectMenu(page: Page) {
  await projectButton(page).click();
  await expect(projectMenu(page)).toBeVisible();
}

export async function closeMenu(page: Page) {
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
}

/** Пункт меню проекта. Меню открывается и переходит по адресу: сам переход проверяет тест. */
const viaProjectMenu = (testId: string) => async (page: Page) => {
  await openProjectMenu(page);
  await page.getByTestId(testId).click();
};
export const goToCatalog = viaProjectMenu('header-catalog');
export const goToProjectSettings = viaProjectMenu('header-settings');
export const goToSearch = viaProjectMenu('header-to-search');
export const goToAllProjects = viaProjectMenu('header-projects');

export async function pickProject(page: Page, name: RegExp | string) {
  await openProjectMenu(page);
  await projectMenu(page).getByRole('menuitem', { name }).click();
}

export async function openHelpMenu(page: Page) {
  await helpButton(page).click();
  await expect(page.getByTestId('help-menu-content')).toBeVisible();
}

export async function openUserMenu(page: Page) {
  await userButton(page).click();
  await expect(userMenu(page)).toBeVisible();
}

// Профиль: режим показа, язык и тема — строки меню с переключателями. Варианты — пункты menuitemradio, выбор меню не закрывает.
export const openThemeMenu = openUserMenu;
export const openLanguageMenu = openUserMenu;
export const themeItem = (page: Page, name: 'Светлая' | 'Тёмная' | 'Как в системе') => userMenu(page).getByTestId('theme-toggle').getByRole('menuitemradio', { name, exact: true });

export async function pickTheme(page: Page, name: 'Светлая' | 'Тёмная' | 'Как в системе') {
  await openUserMenu(page);
  await themeItem(page, name).click();
  await expect(themeItem(page, name)).toHaveAttribute('aria-checked', 'true');
  await closeMenu(page);
}

/** Язык из меню профиля. Меню закрывается, когда язык уже применён: строки страницы на новом языке. */
export async function pickLanguage(page: Page, name: string) {
  await openUserMenu(page);
  await languageItem(page, name).click();
  await expect(languageItem(page, name)).toHaveAttribute('aria-checked', 'true');
  await closeMenu(page);
}

/** Текущий язык — выбранный вариант в строке «Язык» меню профиля: открыть, прочитать, закрыть. */
export async function currentLanguage(page: Page): Promise<string> {
  await openUserMenu(page);
  const name = (await userMenu(page).getByTestId('language-switch').getByRole('menuitemradio', { checked: true }).textContent()) ?? '';
  await closeMenu(page);
  return name;
}

/** «Настройки сервиса» — пункт меню профиля: значка в шапке больше нет. */
export async function goToService(page: Page) {
  await openUserMenu(page);
  await serviceLink(page).click();
}

export type ViewModeName = 'Подробно' | 'Кратко';

/**
 * Режим показа. На своих страницах он только в меню профиля; на странице короткой ссылки профиля нет, переключатель стоит на странице.
 * Выбор один на все проекты: меню закрывается после выбора.
 */
export async function setViewMode(page: Page, name: ViewModeName) {
  const inline = page.getByTestId('detail-switch').getByRole('button', { name, exact: true });
  if ((await inline.count()) > 0) return inline.click();
  await openUserMenu(page);
  const item = userMenu(page).getByTestId('detail-switch').getByRole('menuitemradio', { name, exact: true });
  await item.click();
  await expect(item).toHaveAttribute('aria-checked', 'true');
  await closeMenu(page);
}

/** Переключатель режима в меню профиля: открыть меню и вернуть строку с вариантами. */
export async function modeSwitchInMenu(page: Page): Promise<Locator> {
  await openUserMenu(page);
  return userMenu(page).getByTestId('detail-switch');
}

// ---------- Страница запроса ----------

/** Меню «⋯» шапки запроса: переход в хранилище логов, на узком окне ещё «Операция» и «Показать скрытое». */
export async function openMore(page: Page): Promise<Locator> {
  await page.getByTestId('request-more').click();
  const menu = page.getByTestId('request-more-menu');
  await expect(menu).toBeVisible();
  return menu;
}

/** Данные шага в панели: строки «Запрос», «Ответ», «Заголовки», «Контекст», «Сырые записи». */
export type DataName = 'Запрос' | 'Ответ' | 'Заголовки' | 'Контекст' | 'Сырые записи';
export const DATA_KEY: Record<DataName, string> = { Запрос: 'request', Ответ: 'response', Заголовки: 'headers', Контекст: 'context', 'Сырые записи': 'raw' };
export const dataRow = (page: Page, name: DataName) => page.getByTestId('step-details').locator(`[data-testid=data-row][data-item=${DATA_KEY[name]}]`);
export const viewer = (page: Page) => page.getByTestId('body-viewer');
/** Код в окне тела: у контейнера data-block вида блока и data-mode вида кода, как у прежнего блока панели. */
export const viewerCode = (page: Page) => viewer(page).getByTestId('viewer-code');
export const viewerTab = (page: Page, name: DataName) => viewer(page).getByRole('tab', { name: new RegExp(`^${name}`) });

/** Строка данных шага открывает большое окно с телом на этих данных. */
export async function openData(page: Page, name: DataName): Promise<Locator> {
  await dataRow(page, name).click();
  await expect(viewer(page)).toBeVisible();
  await expect(viewerTab(page, name)).toHaveAttribute('aria-selected', 'true');
  return viewer(page);
}

export async function closeViewer(page: Page) {
  await page.keyboard.press('Escape');
  await expect(viewer(page)).toHaveCount(0);
}

/** Шапка: в одну строку, 56px с границей, элементы идут слева направо и не налезают. Прокрутки нет и при наложении, поэтому считаем рамки. */
export async function expectHeaderFits(page: Page, where: string) {
  const row = header(page).locator('> div').first();
  expect((await row.boundingBox())!.height + 1, where).toBe(56);
  const items = await row.locator('a, nav > *, button').evaluateAll((els) =>
    els
      .filter((el) => el.getClientRects().length > 0 && !el.parentElement?.closest('a, button'))
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { name: el.getAttribute('aria-label') ?? el.textContent ?? '', left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      }),
  );
  const box = (await row.boundingBox())!;
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    expect(it.top, `${where}: ${it.name} в строке шапки`).toBeGreaterThanOrEqual(box.y);
    expect(it.bottom, `${where}: ${it.name} в строке шапки`).toBeLessThanOrEqual(box.y + box.height);
    if (i > 0) expect(it.left, `${where}: ${it.name} после ${items[i - 1]!.name}`).toBeGreaterThanOrEqual(items[i - 1]!.right);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), where).toBeLessThanOrEqual(0);
}

/** «Поделиться» → пункт меню. scope: где искать кнопку, на странице запроса их может быть две. */
export async function shareVia(page: Page, item: 'link' | 'ticket' | 'id', scope: Page | Locator = page) {
  await scope.getByRole('button', { name: 'Поделиться' }).first().click();
  await page.getByTestId(`share-item-${item}`).click();
}

/** Блок панели шага свёрнут до нажатия, а выбор человека общий на страницу: раскрыть, только если ещё не раскрыт. */
export async function openBlock(block: Locator) {
  const toggle = block.locator('button[aria-expanded]').first();
  if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
}
