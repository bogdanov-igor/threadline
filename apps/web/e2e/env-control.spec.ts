import { expect, test, type Page, type Request } from '@playwright/test';
import { goToCatalog, pickProject, projectButton } from './helpers.ts';

// Выбор среды в карточке поиска, смена среды, метка среды.

const PAN = '4111111111111111';
const TERM = 'getCard';
const SEARCH_POST = /\/api\/projects\/[^/]+\/envs\/[^/]+\/searches$/;
const SEARCH_DELETE = /\/api\/searches\/[^/]+$/;

const main = (page: Page) => page.getByRole('main');
const header = (page: Page) => page.getByRole('banner');
const searchPanel = (page: Page) => page.getByTestId('search-panel');
const control = (page: Page) => page.getByTestId('env-control');
const indicator = (page: Page) => page.getByTestId('connection-indicator');
const envSelect = (page: Page) => main(page).getByRole('combobox', { name: /^Среда:/ });
const standButton = (page: Page) => main(page).getByRole('button', { name: /^Стенд:/ });
const input = (page: Page) => page.getByRole('textbox', { name: 'Значения для поиска' });
const chips = (page: Page) => page.getByTestId('term-chip');
const line = (page: Page) => page.getByTestId('search-line');
const more = (page: Page) => line(page).getByRole('button', { name: 'Подробнее' });
const mark = (page: Page) => page.getByTestId('env-mark');
const results = (page: Page) => page.getByTestId('search-results');
const examples = (page: Page) => page.getByTestId('search-examples');
const preset = (page: Page, name: string) =>
  page.getByRole('group', { name: 'Период' }).getByRole('button', { name, exact: true });
const find = (page: Page) => page.getByRole('button', { name: 'Найти', exact: true });
const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const activeName = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    // Кнопка проекта берёт имя из содержимого.
    return el?.getAttribute('aria-label') ?? (el?.tagName === 'BUTTON' ? el.textContent : el?.tagName);
  });

async function addTerm(page: Page, term: string) {
  await input(page).fill(term);
  await input(page).press('Enter');
}

async function pickEnv(page: Page, name: string) {
  await envSelect(page).click();
  await page.getByRole('option', { name, exact: true }).click();
}

/** Считает запросы запуска и остановки поиска. */
function watchSearches(page: Page) {
  const seen = { posts: 0, deletes: 0 };
  page.on('request', (r: Request) => {
    const path = new URL(r.url()).pathname;
    if (r.method() === 'POST' && SEARCH_POST.test(path)) seen.posts++;
    if (r.method() === 'DELETE' && SEARCH_DELETE.test(path)) seen.deletes++;
  });
  return seen;
}

function holdRoute(page: Page, pattern: string | RegExp) {
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const ready = page.route(pattern, async (route) => {
    await gate;
    await route.continue();
  });
  return { ready, release };
}

async function startSlowSearch(page: Page) {
  await page.goto('/pay/slow');
  // Своё значение: завершённый соседним тестом такой же поиск пришёл бы из памяти уже готовым.
  await addTerm(page, `${TERM}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`);
  await preset(page, '24 ч').click();
  await find(page).click();
  await expect(page).toHaveURL(/\?search=/);
  await expect(results(page)).toHaveAttribute('data-status', 'running');
}

/** Страница с длинным списком результатов на низком окне: карточка поиска уходит под шапку при прокрутке. */
async function longResults(page: Page, path = '/pay/demo') {
  await page.goto(path);
  await addTerm(page, 'pay.example');
  await preset(page, '24 ч').click();
  await find(page).click();
  await expect(results(page)).toHaveAttribute('data-status', 'done', { timeout: 20_000 });
}

const scrollTo = (page: Page, y: number) => page.evaluate((v) => window.scrollTo(0, v), y);

test.describe('раскладка карточки', () => {
  for (const { width, height } of [
    { width: 768, height: 90 },
    { width: 1024, height: 90 },
    { width: 1280, height: 50 },
    { width: 2560, height: 50 },
  ]) {
    test(`${width}px: высота строки поиска ${height}, поле не переполняется со стендом и своим периодом`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/pay/demo');
      await expect(indicator(page)).toHaveAttribute('data-status', 'demo');
      expect((await searchPanel(page).boundingBox())!.height).toBe(height);

      await page.goto('/pay/pr/105');
      await expect(indicator(page)).toHaveAttribute('data-status', 'demo');
      expect((await searchPanel(page).boundingBox())!.height).toBe(height);
      await page.getByRole('group', { name: 'Период' }).getByRole('button', { name: 'Свой' }).click();
      await page.getByRole('button', { name: 'Применить' }).click();
      await expect(page.getByRole('button', { name: /^Свой:/ })).toBeVisible();
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      // Поле сужается, но ввод остаётся внутри него и не заходит на период.
      const [field, box, period] = await Promise.all([
        input(page).locator('xpath=..').boundingBox(),
        input(page).boundingBox(),
        page.getByRole('group', { name: 'Период' }).boundingBox(),
      ]);
      expect(box!.x + box!.width).toBeLessThanOrEqual(field!.x + field!.width);
      if (period!.y < field!.y + field!.height)
        expect(field!.x + field!.width).toBeLessThanOrEqual(period!.x);
    });
  }

  test('2560px: выбор среды шире, чем на узком окне', async ({ page }) => {
    await page.setViewportSize({ width: 2560, height: 900 });
    await page.goto('/pay/demo');
    expect((await control(page).boundingBox())!.width).toBe(176);
    await page.setViewportSize({ width: 768, height: 900 });
    await expect.poll(async () => (await control(page).boundingBox())!.width).toBe(136);
  });

  test('выбор среды на том же месте на странице выбора стенда и после выбора стенда', async ({ page }) => {
    await page.goto('/pay/pr');
    const before = await control(page).boundingBox();
    await main(page)
      .getByRole('list', { name: 'Живые стенды за 7 дней' })
      .getByRole('button', { name: '92' })
      .click();
    await expect(page).toHaveURL(/\/pay\/pr\/92$/);
    await expect(input(page)).toBeVisible();
    expect(await control(page).boundingBox()).toEqual(before);
  });

  test('много значений: выбор среды у верхнего края той же высоты', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 900 });
    await page.goto('/pay/demo');
    const before = await control(page).boundingBox();
    for (const v of [
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      'cccccccccccccccccccccccccccccccccccc',
      'dddddddddddddddddddddddddddddddddddd',
    ])
      await addTerm(page, v);
    await expect(chips(page)).toHaveCount(4);
    expect((await input(page).locator('xpath=..').boundingBox())!.height).toBeGreaterThan(44);
    expect(await control(page).boundingBox()).toEqual(before);
  });

  test('ширина элемента одна при проверке и при итоге', async ({ page }) => {
    const hold = holdRoute(page, '**/connection*');
    await hold.ready;
    await page.goto('/pay/unauthorized');
    await expect(indicator(page)).toHaveAttribute('data-status', 'checking');
    const before = [await control(page).boundingBox(), await input(page).boundingBox()];
    hold.release();
    await expect(indicator(page)).toHaveAttribute('data-status', 'unauthorized');
    expect([await control(page).boundingBox(), await input(page).boundingBox()]).toEqual(before);
  });

  test('длинное название среды и длинный номер стенда: ширина та же, номер целиком', async ({ page }) => {
    await page.goto('/pay/demo');
    const width = (await control(page).boundingBox())!.width;
    await page.goto('/pay/long');
    expect((await control(page).boundingBox())!.width).toBe(width);
    await envSelect(page).hover();
    await expect(page.getByRole('tooltip')).toContainText('A very long environment name');

    await page.goto('/pay/pr/92');
    const standWidth = (await standButton(page).boundingBox())!.width;
    await page.goto('/pay/pr/123456');
    expect((await standButton(page).boundingBox())!.width).toBe(standWidth);
    await expect(standButton(page)).toHaveText('Стенд 123456');
    expect(await standButton(page).evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  });

  test('единственная среда: текст вместо списка, та же ширина, значок работает', async ({ page }) => {
    await page.goto('/cards/demo');
    await expect(control(page)).toContainText('Demo');
    await expect(control(page).getByRole('combobox')).toHaveCount(0);
    expect((await control(page).boundingBox())!.width).toBe(136);
    await indicator(page).click();
    await expect(page.getByRole('dialog')).toContainText('Синтетические записи');
  });

  test('клавиатура: среда, стенд, поле; список открывается и закрывается, стрелки двигают выбор, фокус возвращается', async ({
    page,
  }) => {
    await page.goto('/pay/pr/92');
    await expect(indicator(page)).toHaveAttribute('data-status', 'demo');
    await envSelect(page).focus();
    await expect(envSelect(page)).toHaveAccessibleName('Среда: PR stands, демо');
    await page.keyboard.press('Tab');
    expect(await activeName(page)).toBe('Стенд: Стенд 92');
    await page.keyboard.press('Tab');
    await expect(input(page)).toBeFocused();

    await envSelect(page).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('listbox')).toBeVisible();
    await expect(page.getByRole('option', { name: 'PR stands', exact: true })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('option', { name: 'PR stands, none running', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('listbox')).toHaveCount(0);
    await expect(envSelect(page)).toBeFocused();
    await expect(page).toHaveURL(/\/pay\/pr\/92$/);
  });

  test('меню среды: текущая среда со статусом, ненастроенная отмечена, подробности и проверка в нём, чужих проверок нет', async ({ page }) => {
    const checks: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/connection')) checks.push(new URL(r.url()).pathname);
    });
    await page.goto('/pay/demo');
    await expect(indicator(page)).toHaveAttribute('data-status', 'demo');
    await envSelect(page).click();
    const menu = page.getByRole('dialog');
    await expect(menu.getByRole('option', { name: 'Demo', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(menu.getByRole('option', { name: 'Prod', exact: true })).toContainText('не настроено');
    await expect(menu.getByTestId('connection-line')).toContainText(/^Демо · проверено \d\d:\d\d$/);
    await expect(menu.getByRole('button', { name: 'Проверить снова' })).toBeVisible();
    expect(new Set(checks).size).toBe(1);
  });

  test('низ меню: всё в порядке — одна тихая строка в колонках строк, слово не повторяется; другой день — дата; ошибка — причина и кнопка со словом', async ({ page }) => {
    const answer = (json: object) => page.route('**/connection*', (route) => route.fulfill({ json }));
    await answer({ status: 'connected', checkedAt: new Date().toISOString() });
    await page.goto('/pay/demo');
    await envSelect(page).click();
    const menu = page.getByRole('dialog');
    const row = menu.getByRole('option', { name: 'Demo', exact: true });
    const line = menu.getByTestId('connection-line');
    await expect(line).toContainText(/^Подключено · проверено \d\d:\d\d$/);
    await expect(row).toHaveText('Demo');
    await expect(menu.getByRole('heading')).toHaveCount(0);
    const recheck = menu.getByRole('button', { name: 'Проверить снова' });
    await expect(recheck).toHaveText('');
    await recheck.hover();
    await expect(page.getByRole('tooltip')).toHaveText('Проверить снова');
    // Точка и текст в колонках строк списка.
    const column = async (scope: typeof row, i: number) => (await scope.locator(':scope > span').nth(i).boundingBox())!.x;
    expect(await column(line, 0)).toBe(await column(row, 0));
    expect(await column(line, 1)).toBe(await column(row, 1));
    const width = (await menu.boundingBox())!.width;

    await page.unroute('**/connection*');
    await answer({ status: 'connected', checkedAt: '2026-01-15T06:47:51.000Z' });
    await page.goto('/pay/demo');
    await envSelect(page).click();
    await expect(line).toContainText('Подключено · 15.01.2026 11:47');

    await page.unroute('**/connection*');
    // Сервер называет тип хранилища: совет про токен Grafana.
    await answer({ status: 'unauthorized', checkedAt: new Date().toISOString(), backend: 'loki-grafana' });
    await page.goto('/pay/demo');
    await envSelect(page).click();
    await expect(line).toHaveCount(0);
    await expect(menu.getByRole('heading', { name: 'Токен недействителен' })).toBeVisible();
    await expect(menu.getByTestId('connection-problem')).toContainText('Выпустите новый API-ключ');
    await expect(menu.getByRole('button', { name: 'Проверить снова' })).toHaveText('Проверить снова');
    await expect(row).toHaveText('Demo');
    await expect.poll(async () => (await menu.boundingBox())!.width).toBe(width);
  });

  test('заготовка на месте настоящей карточки', async ({ page }) => {
    for (const width of [768, 1024, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      const hold = holdRoute(page, '**/api/projects');
      await hold.ready;
      await page.goto('/pay/demo', { waitUntil: 'commit' });
      const skeleton = page.getByTestId('page-skeleton').locator('[data-slot=skeleton]').first();
      await expect(skeleton).toBeVisible();
      const box = await skeleton.boundingBox();
      hold.release();
      await expect(searchPanel(page)).toBeVisible();
      expect(await searchPanel(page).boundingBox()).toMatchObject({
        x: box!.x,
        y: box!.y,
        height: box!.height,
        width: box!.width,
      });
      await page.unroute('**/api/projects');
    }
  });
});

test.describe('строка на месте подсказки', () => {
  test('приоритет: ошибка значения важнее причины подключения; высота строки не меняется', async ({
    page,
  }) => {
    await page.goto('/pay/unauthorized');
    await expect(line(page)).toContainText('Токен недействителен');
    await expect(more(page)).toBeVisible();
    const before = await searchPanel(page).boundingBox();
    await addTerm(page, 'a');
    await expect(line(page).getByRole('alert')).toContainText('Значение слишком короткое');
    await expect(more(page)).toHaveCount(0);
    expect(await searchPanel(page).boundingBox()).toEqual(before);
    await input(page).fill('ab');
    await expect(line(page)).toContainText('Токен недействителен');
    await expect(line(page)).toHaveAttribute('aria-live', 'polite');
    await expect(find(page)).toBeEnabled();
  });

  test('приоритет: подсказка меняется на ошибку значения без изменения высоты, предупреждение о стенде вместо подсказки', async ({
    page,
  }) => {
    await page.goto('/pay/pr/93');
    await expect(line(page)).toContainText('Стенда 93 нет среди живых');
    const before = await searchPanel(page).boundingBox();
    await addTerm(page, 'a');
    await expect(line(page)).toContainText('Значение слишком короткое');
    expect(await searchPanel(page).boundingBox()).toEqual(before);

    await page.goto('/pay/demo');
    await expect(line(page)).toContainText('Enter или запятая');
    const hint = await searchPanel(page).boundingBox();
    await addTerm(page, 'a');
    await expect(line(page)).toContainText('Значение слишком короткое');
    expect(await searchPanel(page).boundingBox()).toEqual(hint);
  });

  test('ответы подключения и проверки стенда не сдвигают страницу', async ({ page }) => {
    const hold = holdRoute(page, /\/stands\/93$|\/connection/);
    await hold.ready;
    await page.goto('/pay/pr/93');
    await expect(examples(page)).toBeVisible();
    const before = [await searchPanel(page).boundingBox(), await examples(page).boundingBox()];
    hold.release();
    await expect(line(page)).toContainText('Стенда 93 нет среди живых');
    expect([await searchPanel(page).boundingBox(), await examples(page).boundingBox()]).toEqual(before);
  });

  test('«Проверить снова»: подключение восстановилось, снова подсказка, фокус на значке', async ({
    page,
  }) => {
    let healthy = false;
    await page.route('**/connection*', (route) => {
      if (route.request().url().includes('refresh=1')) healthy = true;
      return route.fulfill({
        json: {
          status: healthy ? 'connected' : 'network',
          details: 'нет маршрута',
          checkedAt: new Date().toISOString(),
        },
      });
    });
    await page.goto('/pay/demo');
    await expect(more(page)).toBeVisible();

    // Окно открыто со строки: Escape возвращает на «Подробнее».
    await more(page).click();
    await expect(
      page.getByRole('dialog').getByRole('heading', { name: 'Нет связи с хранилищем' }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(more(page)).toBeFocused();

    await more(page).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Проверить снова' }).click();
    await expect(indicator(page)).toHaveAttribute('data-status', 'connected');
    await expect(line(page)).toContainText('Enter или запятая');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(envSelect(page)).toBeFocused();
  });

  test('сервер Threadline недоступен: значок ошибки, строка называет причину', async ({ page }) => {
    await page.route('**/connection*', (route) => route.abort('connectionrefused'));
    await page.goto('/pay/demo');
    await expect(indicator(page)).toHaveAttribute('data-status', 'server-unreachable', { timeout: 10_000 });
    await expect(line(page)).toContainText('Сервер Threadline недоступен');
    await expect(more(page)).toBeVisible();
  });

  test('среда не настроена: полный блок без дублирования, выбор среды работает', async ({ page }) => {
    await page.goto('/pay/prod');
    await expect(indicator(page)).toHaveAttribute('data-status', 'not-configured');
    await expect(page.getByTestId('search-not-configured')).toBeVisible();
    await expect(more(page)).toHaveCount(0);
    await expect(line(page)).toContainText('Enter или запятая');
    await expect(find(page)).toBeDisabled();
    await pickEnv(page, 'Demo');
    await expect(page).toHaveURL(/\/pay\/demo$/);
  });
});

test.describe('смена среды', () => {
  test('метки, недописанное значение и период переживают смену среды, стенда и проекта; значений нет в адресе, запросах и хранилище', async ({
    page,
  }) => {
    const searches = watchSearches(page);
    const sent: string[] = [];
    page.on('request', (r) => sent.push(`${r.url()} ${r.postData() ?? ''}`));
    await page.goto('/pay/demo');
    await addTerm(page, TERM);
    await preset(page, '24 ч').click();
    await input(page).fill('undersc0re-draft');

    const expectKept = async () => {
      await expect(chips(page)).toHaveCount(1);
      await expect(chips(page)).toContainText(TERM);
      await expect(input(page)).toHaveValue('undersc0re-draft');
      await expect(preset(page, '24 ч')).toHaveAttribute('aria-pressed', 'true');
    };

    await pickEnv(page, 'Slow');
    await expect(page).toHaveURL(/\/pay\/slow$/);
    await expectKept();

    // Через страницу выбора стенда, затем другой стенд.
    await pickEnv(page, 'PR stands');
    await expect(page).toHaveURL(/\/pay\/pr$/);
    await main(page)
      .getByRole('list', { name: 'Живые стенды за 7 дней' })
      .getByRole('button', { name: '105' })
      .click();
    await expect(page).toHaveURL(/\/pay\/pr\/105$/);
    await expectKept();
    await standButton(page).click();
    await page.getByRole('dialog').getByRole('button', { name: '92' }).click();
    await expect(page).toHaveURL(/\/pay\/pr\/92$/);
    await expectKept();

    // Другой проект.
    await pickProject(page, /Card processing/);
    await expect(page).toHaveURL(/\/cards\/demo$/);
    await expectKept();

    expect(searches.posts).toBe(0);
    expect(page.url()).not.toContain(TERM);
    expect(sent.filter((s) => s.includes(TERM) || s.includes('undersc0re-draft'))).toEqual([]);
    expect(await page.evaluate(() => JSON.stringify(Object.entries(localStorage)))).not.toContain(TERM);

    await page.reload();
    await expect(chips(page)).toHaveCount(0);
    await expect(input(page)).toHaveValue('');
  });

  test('свой период остаётся, проверка срока при запуске', async ({ page }) => {
    await page.goto('/pay/demo');
    await page.getByRole('group', { name: 'Период' }).getByRole('button', { name: 'Свой' }).click();
    await page.getByRole('button', { name: 'Применить' }).click();
    const custom = page.getByRole('button', { name: /^Свой:/ });
    const label = await custom.getAttribute('aria-label');
    await pickEnv(page, 'Slow');
    await expect(page.getByRole('button', { name: label! })).toHaveAttribute('aria-pressed', 'true');
  });

  test('идущий поиск останавливается, адрес прежнего вида, «назад» показывает пометку и найденное, новых поисков нет', async ({
    page,
  }) => {
    await startSlowSearch(page);
    const searches = watchSearches(page);
    const del = page.waitForRequest(
      (r) => r.method() === 'DELETE' && SEARCH_DELETE.test(new URL(r.url()).pathname),
    );
    await pickEnv(page, 'Demo');
    await del;
    await expect(page).toHaveURL(/\/pay\/demo$/);
    await expect(results(page)).toHaveCount(0);
    await expect(examples(page)).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/\/pay\/slow\?search=/);
    await expect(results(page)).toHaveAttribute('data-status', 'cancelled', { timeout: 10_000 });
    await expect(page.locator('[data-notice=cancelled]')).toContainText('Поиск остановлен');
    await expect(chips(page)).toContainText(TERM);
    expect(searches.posts).toBe(0);
  });

  test('«назад», логотип и «Справочник» поиск не останавливают', async ({ page }) => {
    await startSlowSearch(page);
    const searches = watchSearches(page);
    await header(page).getByRole('link', { name: 'Threadline, на главную' }).click();
    await expect(page).toHaveURL(/\/pay\/slow$/);
    await page.goBack();
    await expect(page).toHaveURL(/\?search=/);
    await goToCatalog(page);
    await expect(page).toHaveURL(/\/pay\/catalog/);
    await page.goBack();
    await expect(page).toHaveURL(/\?search=/);
    await page.waitForTimeout(300);
    expect(searches.deletes).toBe(0);
  });

  test('фокус переходит на новый выбор и не ставится после перезагрузки', async ({ page }) => {
    await page.goto('/pay/demo');
    await envSelect(page).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('listbox')).toBeVisible();
    await page.getByRole('option', { name: 'Slow', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/pay\/slow$/);
    await expect.poll(() => activeName(page)).toMatch(/^Среда: Slow/);
    await page.reload();
    await expect(indicator(page)).toHaveAttribute('data-status', 'demo');
    expect(await activeName(page)).toBe('BODY');

    // После выбора стенда на странице выбора фокус на кнопке стенда.
    await page.goto('/pay/pr');
    await main(page)
      .getByRole('list', { name: 'Живые стенды за 7 дней' })
      .getByRole('button', { name: '92' })
      .click();
    await expect(page).toHaveURL(/\/pay\/pr\/92$/);
    await expect.poll(() => activeName(page)).toBe('Стенд: Стенд 92');
  });

  for (const how of ['среды', 'стенда'] as const) {
    test(`смена ${how}, пока поиск запускается: адрес новой страницы без id, примеры, созданный поиск остановлен`, async ({
      page,
    }) => {
      const hold = holdRoute(page, SEARCH_POST);
      await hold.ready;
      await page.goto(how === 'среды' ? '/pay/demo' : '/pay/pr/105');
      await addTerm(page, TERM);
      const posted = page.waitForRequest(
        (r) => r.method() === 'POST' && SEARCH_POST.test(new URL(r.url()).pathname),
      );
      await find(page).click();
      await posted;
      if (how === 'среды') {
        await pickEnv(page, 'Slow');
        await expect(page).toHaveURL(/\/pay\/slow$/);
      } else {
        await standButton(page).click();
        await page.getByRole('dialog').getByRole('button', { name: '92' }).click();
        await expect(page).toHaveURL(/\/pay\/pr\/92$/);
      }
      const del = page.waitForRequest(
        (r) => r.method() === 'DELETE' && SEARCH_DELETE.test(new URL(r.url()).pathname),
      );
      hold.release();
      await del;
      await expect(page).not.toHaveURL(/search=/);
      await expect(examples(page)).toBeVisible();
      await expect(results(page)).toHaveCount(0);
    });
  }

  test('ручной ввод стенда при заполненном поле: Enter и «Открыть» открывают стенд, поиск сам не запускается', async ({
    page,
  }) => {
    const searches = watchSearches(page);
    await page.goto('/pay/pr/105');
    await addTerm(page, TERM);
    await standButton(page).click();
    await page.getByRole('dialog').getByLabel('Номер стенда').fill('92');
    await page.getByRole('dialog').getByLabel('Номер стенда').press('Enter');
    await expect(page).toHaveURL(/\/pay\/pr\/92$/);
    await standButton(page).click();
    await page.getByRole('dialog').getByLabel('Номер стенда').fill('105');
    await page.getByRole('dialog').getByRole('button', { name: 'Открыть' }).click();
    await expect(page).toHaveURL(/\/pay\/pr\/105$/);
    await expect(chips(page)).toContainText(TERM);
    expect(searches.posts).toBe(0);
  });

  test('ненастроенная среда и обратно: значения видны, поле недоступно, затем снова работает', async ({
    page,
  }) => {
    await page.goto('/pay/demo');
    await addTerm(page, TERM);
    await pickEnv(page, 'Prod');
    await expect(chips(page)).toContainText(TERM);
    await expect(input(page)).toBeDisabled();
    await expect(find(page)).toBeDisabled();
    await pickEnv(page, 'Demo');
    await expect(input(page)).toBeEnabled();
    await expect(chips(page)).toContainText(TERM);
  });

  test('скрытый номер карты после перезагрузки: метка остаётся, запуск просит ввести заново', async ({
    page,
  }) => {
    await page.goto('/pay/demo');
    await addTerm(page, PAN);
    await find(page).click();
    await expect(page).toHaveURL(/\?search=/);
    await page.reload();
    await expect(chips(page)).toHaveAttribute('data-kind', 'pan');
    await pickEnv(page, 'Slow');
    await expect(chips(page)).toHaveAttribute('data-kind', 'pan');
    await find(page).click();
    await expect(line(page).getByRole('alert')).toContainText('Номер карты не сохраняется');
  });

  test('быстрая смена сред: значок показывает состояние текущей среды, проверка одна на среду', async ({
    page,
  }) => {
    const checks: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/connection')) checks.push(new URL(r.url()).pathname);
    });
    await page.route('**/envs/network/connection*', async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.continue().catch(() => {});
    });
    await page.goto('/pay/demo');
    await expect(indicator(page)).toHaveAttribute('data-status', 'demo');
    await pickEnv(page, 'No network');
    await expect(indicator(page)).toHaveAttribute('data-status', 'checking');
    await pickEnv(page, 'Demo');
    await expect(indicator(page)).toHaveAttribute('data-status', 'demo');
    await page.waitForTimeout(1700);
    await expect(indicator(page)).toHaveAttribute('data-status', 'demo');
    // Возврат в ту же среду в течение минуты новой проверки не отправляет.
    expect(checks.filter((c) => c.includes('/envs/demo/'))).toHaveLength(1);
  });

  test('результат уже вытеснен: при возврате обычное сообщение', async ({ page }) => {
    await page.goto('/pay/demo?search=no-such-search');
    await expect(page.locator('[data-notice=expired]')).toContainText('Результат устарел');
    await pickEnv(page, 'Slow');
    await expect(page).toHaveURL(/\/pay\/slow$/);
    await page.goBack();
    await expect(page.locator('[data-notice=expired]')).toContainText('Результат устарел');
  });
});

const REQUEST = (env: string) =>
  `/pay/${env}/requests/synthetic-cid?from=${Date.now() - 3_600_000}&to=${Date.now()}`;

test.describe('метка среды на страницах запроса и операции', () => {
  test('запрос: среда из адреса, ссылка на поиск, выбора среды нет; проверки подключения нет; последний выбор не меняется', async ({
    page,
  }) => {
    let checks = 0;
    page.on('request', (r) => {
      if (r.url().includes('/connection')) checks++;
    });
    await page.goto('/pay/slow');
    await expect(indicator(page)).toHaveAttribute('data-status', 'demo');
    await page.goto(REQUEST('demo'));
    checks = 0;
    await page.reload();
    await expect(mark(page)).toHaveText('Demo');
    await expect(mark(page)).toHaveAttribute('href', '/pay/demo');
    await expect(mark(page)).toHaveAccessibleName('Среда: Demo. Искать в этой среде');
    await expect(header(page).getByRole('combobox', { name: /^Среда:/ })).toHaveCount(0);
    await expect(page.getByTestId('connection-indicator')).toHaveCount(0);
    await page.waitForTimeout(200);
    expect(checks).toBe(0);
    expect(await page.evaluate(() => localStorage.getItem('threadline.last'))).toContain('"slow"');
  });

  test('операция: метка и никакой проверки подключения', async ({ page }) => {
    let checks = 0;
    page.on('request', (r) => {
      if (r.url().includes('/connection')) checks++;
    });
    await page.goto(`/pay/demo/operations/transfer/synthetic-value?at=${Date.now() - 3_600_000}&w=6h`);
    await expect(mark(page)).toHaveText('Demo');
    await page.waitForTimeout(200);
    expect(checks).toBe(0);
  });

  test('стенд: номер отдельно и не обрезается; битая ссылка и единственная среда — метка на месте', async ({
    page,
  }) => {
    await page.goto('/pay/pr/92/requests/synthetic-cid');
    await expect(mark(page)).toHaveText('PR stands · 92');
    await expect(mark(page)).toHaveAttribute('href', '/pay/pr/92');
    await page.goto('/cards/demo/requests/synthetic-cid');
    await expect(mark(page)).toHaveText('Demo');
  });

  test('заготовка и ошибка загрузки: метка видна', async ({ page }) => {
    const hold = holdRoute(page, /\/api\/projects\/.+\/requests\//);
    await hold.ready;
    await page.goto(REQUEST('demo'));
    await expect(mark(page)).toBeVisible();
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    hold.release();
    await page.route(/\/api\/projects\/.+\/requests\//, (route) =>
      route.fulfill({ status: 502, json: { error: { code: 'network' } } }),
    );
    await page.goto(REQUEST('demo'));
    await expect(mark(page)).toBeVisible();
  });

  test('неизвестная среда: метки нет', async ({ page }) => {
    await page.goto('/pay/nope/requests/synthetic-cid');
    await expect(page.getByRole('heading', { name: 'Такой среды нет' })).toBeVisible();
    await expect(mark(page)).toHaveCount(0);
  });

  test('768px: длинное название обрезано, полное в подсказке, проект не сжат, шапка в одну строку', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 768, height: 900 });
    await page.goto(REQUEST('long'));
    await expect(mark(page)).toBeVisible();
    const name = mark(page).locator('span.truncate');
    await expect.poll(() => name.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    await mark(page).hover();
    await expect(page.getByRole('tooltip')).toContainText('A very long environment name');
    const project = header(page)
      .getByRole('button', { name: /^Проект:/ })
      .locator('span.truncate');
    await expect.poll(() => project.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect((await header(page).boundingBox())!.height).toBe(56);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });

  test('закреплена при прокрутке, порядок Tab: сразу после проекта', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 400 });
    await page.goto(REQUEST('demo'));
    await expect(mark(page)).toBeVisible();
    await expect(projectButton(page)).toBeEnabled();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    // Соседние наборы наполняют «Неизвестное»: за названием может идти счётчик для диктора.
    expect(await activeName(page)).toMatch(/^Проект: Demo Pay/);
    await page.keyboard.press('Tab');
    expect(await activeName(page)).toBe('Среда: Demo. Искать в этой среде');
    await scrollTo(page, 2000);
    await expect(mark(page)).toBeInViewport();
  });

  test('переход по метке: значения и период на месте, результатов нет, поиск не создан, страница с начала; «назад» возвращает запрос', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 600 });
    await page.goto('/pay/demo');
    await addTerm(page, TERM);
    await preset(page, '24 ч').click();
    await find(page).click();
    await expect(results(page)).toHaveAttribute('data-status', 'done', { timeout: 20_000 });
    const searches = watchSearches(page);
    await page
      .getByRole('list', { name: 'Найденные запросы' })
      .getByRole('listitem')
      .first()
      .locator('[data-row-link]')
      .click({ position: { x: 8, y: 8 } });
    await expect(page.getByTestId('request-header')).toBeVisible();
    const requestUrl = page.url();
    await scrollTo(page, 200);
    await mark(page).click();
    await expect(page).toHaveURL(/\/pay\/demo$/);
    await expect(chips(page)).toContainText(TERM);
    await expect(preset(page, '24 ч')).toHaveAttribute('aria-pressed', 'true');
    await expect(results(page)).toHaveCount(0);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    expect(searches.posts).toBe(0);
    await page.goBack();
    await expect(page).toHaveURL(requestUrl);
  });

  test('возврат «К результатам» сохраняет прокрутку списка', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 500 });
    await longResults(page);
    await scrollTo(page, 400);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(400);
    await page
      .getByRole('list', { name: 'Найденные запросы' })
      .getByRole('listitem')
      .nth(8)
      .locator('[data-row-link]')
      .click({ position: { x: 8, y: 8 } });
    await expect(page.getByTestId('request-header')).toBeVisible();
    await page.getByRole('link', { name: 'К результатам' }).click();
    await expect(page).toHaveURL(/\?search=/);
    await expect(results(page)).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(300);
  });
});

test.describe('метка среды при прокрутке поиска', () => {
  for (const { width, pad } of [
    { width: 768, pad: 0 },
    { width: 1280, pad: 0 },
    { width: 2560, pad: 0 },
    { width: 768, pad: 17 },
    { width: 1024, pad: 17 },
  ]) {
    test(`${width}px${pad ? ', место под полосу прокрутки' : ''}: метка появляется и исчезает, другие элементы шапки не двигаются`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 400 });
      // Сквозной браузер полосы прокрутки не показывает: её место отнимает стиль.
      if (pad)
        await page.addInitScript(
          (p) =>
            document.addEventListener('DOMContentLoaded', () => {
              document.body.style.paddingRight = `${p}px`;
            }),
          pad,
        );
      await longResults(page);
      await expect(mark(page)).toHaveCount(0);
      const layout = () =>
        Promise.all([
          header(page).getByRole('link', { name: 'Threadline, на главную' }).boundingBox(),
          header(page)
            .getByRole('button', { name: /^Проект:/ })
            .boundingBox(),
          page.getByTestId('header-actions').boundingBox(),
        ]);
      const before = await layout();
      await scrollTo(page, 900);
      await expect(mark(page)).toHaveText('Demo');
      // Текст, а не ссылка.
      expect(await mark(page).evaluate((el) => el.tagName)).toBe('SPAN');
      expect(await layout()).toEqual(before);
      expect((await header(page).boundingBox())!.height).toBe(56);
      await scrollTo(page, 0);
      await expect(mark(page)).toHaveCount(0);
      expect(await layout()).toEqual(before);
    });
  }

  test('порядок Tab тот же: метка фокус не получает; уход и возврат метку не оставляют; без анимации', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 1280, height: 400 });
    await longResults(page);
    await scrollTo(page, 900);
    await expect(mark(page)).toBeVisible();
    expect(await mark(page).evaluate((el) => el.getAttribute('tabindex'))).toBeNull();
    expect(
      parseFloat(await mark(page).evaluate((el) => getComputedStyle(el).transitionDuration)),
    ).toBeLessThan(0.001);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await expect(projectButton(page)).toBeEnabled();
    await expect(page.getByTestId('header-help')).toBeEnabled();
    await page.getByTestId('header-help').focus();
    await page.keyboard.press('Shift+Tab');
    expect(await activeName(page)).toMatch(/^Проект: Demo Pay/);

    await goToCatalog(page);
    await expect(page).toHaveURL(/\/pay\/catalog/);
    await expect(mark(page)).toHaveCount(0);
    await page.getByRole('button', { name: /^Проект:/ }).focus();
    await page.goto('/pay/demo');
    await expect(mark(page)).toHaveCount(0);
  });

  test('единственная среда: метка показывает эту среду', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 400 });
    await longResults(page, '/cards/demo');
    await scrollTo(page, 900);
    await expect(mark(page)).toHaveText('Demo');
  });

  test('с полосой справочника: метка видна, когда выбор среды ушёл под полосу', async ({ page }) => {
    await page.route('**/api/catalog', (route) =>
      route.fulfill({ json: { state: 'stale', loadedAt: Date.now(), message: 'синтетика' } }),
    );
    await page.setViewportSize({ width: 1280, height: 400 });
    await longResults(page);
    await expect(page.getByTestId('catalog-banner')).toBeVisible();
    await expect(mark(page)).toHaveCount(0);
    await scrollTo(page, 120);
    await expect(mark(page)).toBeVisible();
  });
});
