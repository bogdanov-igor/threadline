import { expect, test, type Page } from '@playwright/test';
import { closeMenu, currentLanguage, expectHeaderFits, goToAllProjects, languageItem as langItem, openUserMenu, pickLanguage as choose, projectButton, userMenu } from './helpers.ts';

// Языки интерфейса: выбор в строке «Язык» меню профиля, запоминание, сбой загрузки. Остальные сквозные тесты идут на русском.
// Пока меню открыто, Radix скрывает остальную страницу от диктора: подписи шапки проверяются после закрытия меню.

const KEY = 'threadline.language';
/** Строка «Язык» меню профиля: группа с вариантами, подпись группы — слово «язык». */
const langRow = (page: Page) => userMenu(page).getByTestId('language-switch');
const readSaved = (page: Page) => page.evaluate((k) => localStorage.getItem(k), KEY);
const lang = (page: Page) => page.evaluate(() => document.documentElement.lang);
// Ленивые файлы строк: основной файл языка, переводы сообщений сервера и файлы страниц.
const FILES = (code: string) => new RegExp(`/assets/${code}-[^/]+\\.js$`);

/** Подпись кнопки проекта: заметна сразу, перевод виден без открытия меню. */
const projectLabel = (page: Page, word: string) => projectButton(page).and(page.getByRole('button', { name: new RegExp(`^${word}:`) }));

/**
 * Проверяемые строки подставляются вместо файлов английского: случай проверяет обновление на месте, а не слова перевода.
 * Остальное берётся из запасного языка.
 */
const withEnglish = (page: Page, strings: object) =>
  page.route(FILES('en'), (route) => route.fulfill({ contentType: 'text/javascript', body: `export default ${JSON.stringify(strings)}` }));

const ROW_HIT = { position: { x: 8, y: 8 } };
const scheme = (page: Page) => page.getByRole('group', { name: 'Схема запроса' });
const details = (page: Page) => page.getByTestId('step-details');

/** Запрос через шлюз на демо-среде: граф открыт, выбран вход. */
async function openGatewayRequest(page: Page) {
  await page.goto('/pay/demo');
  const input = page.getByRole('textbox', { name: 'Значения для поиска' });
  await input.fill('switch.pay.example');
  await input.press('Enter');
  await page.getByRole('group', { name: 'Период' }).getByRole('button', { name: '24 ч', exact: true }).click();
  await page.getByRole('button', { name: 'Найти', exact: true }).click();
  await expect(page.getByTestId('search-results')).toHaveAttribute('data-status', 'done', { timeout: 20_000 });
  await page.getByRole('list', { name: 'Найденные запросы' }).getByRole('listitem').and(page.locator('[data-status=success]')).first().locator('[data-row-link]').click(ROW_HIT);
  await expect(page.getByTestId('flow-canvas')).toBeVisible({ timeout: 15_000 });
}

/** Обращения к API поиска и записей: фоновый опрос состояния не считается. */
function countReads(page: Page) {
  const reads: string[] = [];
  page.on('request', (r) => {
    const { pathname } = new URL(r.url());
    if (pathname.startsWith('/api/') && /\/(searches|requests|operations|lines)\b/.test(pathname)) reads.push(`${r.method()} ${pathname}`);
  });
  return reads;
}

test.describe('первое открытие', () => {
  test.use({ locale: 'en-US' });

  test('браузер с английским языком: интерфейс на русском, файлы других языков не запрашиваются', async ({ page }) => {
    const asked: string[] = [];
    page.on('request', (r) => {
      if (FILES('en').test(r.url())) asked.push(r.url());
    });
    await page.goto('/pay/demo');
    await expect(projectLabel(page, 'Проект')).toBeVisible();
    await openUserMenu(page);
    await expect(langItem(page, 'Русский')).toHaveAttribute('aria-checked', 'true');
    await expect(langRow(page)).toHaveAccessibleName('Язык');
    expect(await lang(page)).toBe('ru');
    expect(asked).toEqual([]);
  });
});

test.describe('выбор языка в меню профиля', () => {
  test('меняет подписи и атрибут lang без перезагрузки, ширина меню та же, варианты называют языки на них самих', async ({ page }) => {
    await page.goto('/pay/demo');
    await page.evaluate(() => {
      (window as unknown as { sameDocument: boolean }).sameDocument = true;
    });
    // offsetWidth, а не рамка: меню открывается с анимацией масштаба.
    const menuWidth = () => userMenu(page).evaluate((el) => (el as HTMLElement).offsetWidth);
    await openUserMenu(page);
    const width = await menuWidth();
    await closeMenu(page);

    await choose(page, 'English');
    await expect(projectLabel(page, 'Project')).toBeVisible();
    expect(await lang(page)).toBe('en');
    await openUserMenu(page);
    await expect(langItem(page, 'English')).toHaveAttribute('aria-checked', 'true');
    await expect(langRow(page)).toHaveAccessibleName('Language');
    expect(await menuWidth()).toBe(width);
    await expect(langRow(page).getByRole('menuitemradio')).toHaveText(['Русский', 'English']);
    await expect(langItem(page, 'English')).toHaveAttribute('lang', 'en');
    await expect(langItem(page, 'Русский')).toHaveAttribute('lang', 'ru');

    // Выбор меню не закрывает: подписи меню сменились на месте.
    await langItem(page, 'Русский').click();
    await expect(langItem(page, 'Русский')).toHaveAttribute('aria-checked', 'true');
    await expect(langRow(page)).toHaveAccessibleName('Язык');
    await expect(userMenu(page)).toBeVisible();
    await closeMenu(page);
    await expect(projectLabel(page, 'Проект')).toBeVisible();
    expect(await lang(page)).toBe('ru');

    expect(await page.evaluate(() => (window as unknown as { sameDocument?: boolean }).sameDocument)).toBe(true);
  });

  test('с клавиатуры: стрелками до строки «Язык», Enter выбирает, меню остаётся открытым, Escape возвращает фокус на кнопку', async ({ page }) => {
    await page.goto('/pay/demo');
    await page.getByTestId('auth-off').focus();
    await page.keyboard.press('Enter');
    // Первая строка меню — режим показа, за ней язык. Radix переводит фокус после нажатия, поэтому ждём его на каждом шаге.
    await expect(userMenu(page).getByTestId('detail-switch').getByRole('menuitemradio').first()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(userMenu(page).getByTestId('detail-switch').getByRole('menuitemradio').nth(1)).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(langItem(page, 'Русский')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(langItem(page, 'English')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(langItem(page, 'English')).toHaveAttribute('aria-checked', 'true');
    await expect(langRow(page)).toHaveAccessibleName('Language');
    await expect(userMenu(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(page.getByTestId('auth-off')).toBeFocused();
    await expect(projectLabel(page, 'Project')).toBeVisible();
  });

  test('выбор переживает перезагрузку, первая отрисовка сразу на выбранном языке', async ({ page }) => {
    await page.goto('/pay/demo');
    await choose(page, 'English');
    await expect(projectLabel(page, 'Project')).toBeVisible();
    expect(await page.evaluate((k) => localStorage.getItem(k), KEY)).toBe('en');
    // Запись всего, что шапка показала от начала загрузки: русской подписи быть не должно.
    await page.addInitScript(() => {
      const seen: string[] = [];
      (window as unknown as { seen: string[] }).seen = seen;
      new MutationObserver(() => {
        const link = document.querySelector('[data-testid=header-help]');
        if (link) seen.push(link.getAttribute('aria-label') ?? '');
      }).observe(document, { childList: true, subtree: true, attributes: true });
    });
    await page.reload();
    await expect(projectLabel(page, 'Project')).toBeVisible();
    expect(await lang(page)).toBe('en');
    const seen = await page.evaluate(() => (window as unknown as { seen: string[] }).seen);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter((text) => text !== 'Help')).toEqual([]);
  });

  test('в хранилище язык, которого нет (например, прежний uz): русский без ошибки', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript((k) => localStorage.setItem(k, 'uz'), KEY);
    await page.goto('/pay/demo');
    await expect(projectLabel(page, 'Проект')).toBeVisible();
    expect(await currentLanguage(page)).toBe('Русский');
    expect(errors).toEqual([]);
  });

  test('хранилище запрещено: выбор действует до закрытия вкладки', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        get() {
          throw new DOMException('denied', 'SecurityError');
        },
      });
    });
    await page.goto('/pay/demo');
    await choose(page, 'English');
    await expect(projectLabel(page, 'Project')).toBeVisible();
    await page.reload();
    await expect(projectLabel(page, 'Проект')).toBeVisible();
  });

  test('двойная смена: действует последний выбор', async ({ page }) => {
    await page.route(FILES('en'), async (route) => {
      await new Promise((r) => setTimeout(r, 600));
      await route.continue();
    });
    await page.goto('/pay/demo');
    await openUserMenu(page);
    await langItem(page, 'English').click();
    // Английский ещё грузится: русский выбран вторым и остаётся, когда файлы английского приходят. Меню открыто всё время.
    await langItem(page, 'Русский').click();
    await expect.poll(() => readSaved(page)).toBe('ru');
    await expect(langItem(page, 'Русский')).toHaveAttribute('aria-checked', 'true');
    await page.waitForTimeout(800);
    await expect(langItem(page, 'Русский')).toHaveAttribute('aria-checked', 'true');
    await closeMenu(page);
    await expect(projectLabel(page, 'Проект')).toBeVisible();
    expect(await lang(page)).toBe('ru');
    expect(await readSaved(page)).toBe('ru');
  });
});

test.describe('сбой загрузки', () => {
  test('при смене: язык и выбор не меняются, сообщение в меню, выбрать можно снова', async ({ page }) => {
    await page.goto('/pay/demo');
    // Перезагрузка из flow/load.ts при сбое чанка потеряла бы значения поиска.
    let reloads = 0;
    page.on('framenavigated', () => reloads++);
    await page.route(FILES('en'), (route) => route.abort('connectionrefused'));
    await openUserMenu(page);
    await langItem(page, 'English').click();
    await expect(page.getByRole('alert').filter({ hasText: 'Язык не загрузился' })).toBeVisible();
    await expect(langItem(page, 'Русский')).toHaveAttribute('aria-checked', 'true');
    expect(await lang(page)).toBe('ru');
    expect(await readSaved(page)).toBeNull();
    expect(reloads).toBe(0);

    await page.unroute(FILES('en'));
    await langItem(page, 'English').click();
    await expect(langItem(page, 'English')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('alert').filter({ hasText: 'Язык не загрузился' })).toHaveCount(0);
    await closeMenu(page);
    await expect(projectLabel(page, 'Project')).toBeVisible();
  });

  test('при открытии: страница работает на русском, выбор в хранилище остаётся', async ({ page }) => {
    await page.addInitScript((k) => localStorage.setItem(k, 'en'), KEY);
    await page.route(FILES('en'), (route) => route.abort('connectionrefused'));
    await page.goto('/pay/demo');
    await expect(projectLabel(page, 'Проект')).toBeVisible();
    expect(await lang(page)).toBe('ru');
    expect(await page.evaluate((k) => localStorage.getItem(k), KEY)).toBe('en');
  });

  test('файл страницы на выбранном языке не загрузился: страница работает с русскими строками', async ({ page }) => {
    await page.addInitScript((k) => localStorage.setItem(k, 'en'), KEY);
    await page.goto('/pay/demo');
    await expect(projectLabel(page, 'Project')).toBeVisible();
    // Основной файл уже загружен: новая страница не найдёт только свой файл.
    await page.route(FILES('en'), (route) => route.abort('connectionrefused'));
    await goToAllProjects(page);
    await expect(page.getByRole('heading', { level: 1, name: 'Все проекты' })).toBeVisible();
    expect(await lang(page)).toBe('en');
  });
});

test.describe('обновление на месте', () => {
  test('граф потока: подписи узла, ребра и диктора на новом языке, выбранный шаг и положение узлов те же', async ({ page }) => {
    await withEnglish(page, { flow: { node: { entryGateway: 'Entry through gateway' }, aria: { step: 'Node {{order}} of {{total}}' }, rf: { edge: 'Graph edge' } }, units: { ms: '{{value}} ms' } });
    await openGatewayRequest(page);
    const nodes = scheme(page).locator('button[data-node]');
    const entry = scheme(page).locator('button[data-node][data-kind=entry]');
    const places = () => nodes.evaluateAll((els) => els.map((el) => [el.getAttribute('data-node'), el.getAttribute('data-x'), el.getAttribute('data-y'), el.getAttribute('aria-pressed')]));
    await expect(entry.getByTestId('node-name')).toHaveText('Вход через шлюз');
    await expect(entry).toHaveAttribute('aria-label', /Шаг 1 из/);
    const before = await places();
    const reads = countReads(page);

    await choose(page, 'English');
    await expect(entry.getByTestId('node-name')).toHaveText('Entry through gateway');
    await expect(entry).toHaveAttribute('aria-label', /Node 1 of/);
    await expect(scheme(page).locator('button[data-node][data-kind=exchange]').first().getByTestId('node-duration')).toContainText(' ms');
    await expect(scheme(page).locator('.react-flow__edge').first()).toHaveAttribute('aria-label', /^Graph edge/);
    expect(await places()).toEqual(before);
    await expect(entry).toHaveAttribute('aria-pressed', 'true');
    expect(reads).toEqual([]);
  });

  test('подробности шага: заголовок блока и подпись шлюза на новом языке, блок остаётся раскрытым', async ({ page }) => {
    await withEnglish(page, {
      record: { section: { request: 'Request block', headers: 'Headers block', body: 'Body block', payload: 'Payload block', response: 'Response block', context: 'Context block', raw: 'Raw block' } },
      trace: { scheme: { gateway: 'gateway' } },
    });
    await openGatewayRequest(page);
    await expect(details(page)).toContainText('шлюз');
    await expect(details(page)).not.toContainText('request received');
    await expect(page.getByTestId('request-chain')).toHaveText('шлюз → api → switch');
    await page.getByRole('tab', { name: /^Записи/ }).click();
    const record = page.locator('li[data-record-id]').first();
    await record.locator('> div > button[aria-expanded=false]').click();
    const block = record.locator('[data-block] button[aria-expanded]').first();
    await expect(block).toBeVisible();
    await expect(block).not.toContainText(' block');
    const expanded = await block.getAttribute('aria-expanded');

    await choose(page, 'English');
    await expect(block).toContainText(/ block$/);
    await expect(block).toHaveAttribute('aria-expanded', expanded!);
    await expect(record.locator('> div > button').first()).toHaveAttribute('aria-expanded', 'true');
    await page.getByRole('tab', { name: /^Схема/ }).click();
    await expect(details(page)).toContainText('gateway');
    await expect(details(page)).not.toContainText('request received');
    await expect(page.getByTestId('request-chain')).toHaveText('gateway → api → switch');
  });

  test('поиск идёт: не останавливается и не запускается заново, результаты те же', async ({ page }) => {
    await page.goto('/pay/slow');
    const starts: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && /\/searches$/.test(new URL(r.url()).pathname)) starts.push(r.url());
    });
    const input = page.getByRole('textbox', { name: 'Значения для поиска' });
    await input.fill('switch.pay.example');
    await input.press('Enter');
    await page.getByRole('button', { name: 'Найти', exact: true }).click();
    await expect(page.getByTestId('search-results')).toBeVisible();
    await choose(page, 'English');
    await expect(projectLabel(page, 'Project')).toBeVisible();
    await expect(page.getByTestId('search-results')).toHaveAttribute('data-status', /done|too-many/, { timeout: 30_000 });
    expect(starts).toHaveLength(1);
  });

  test('черновик формы проекта остаётся', async ({ page }) => {
    await page.goto('/admin/projects/new');
    const name = page.locator('form input[type=text], form input:not([type])').first();
    await name.fill('Черновик проекта');
    await choose(page, 'English');
    await expect(projectLabel(page, 'Project')).toBeVisible();
    await expect(name).toHaveValue('Черновик проекта');
  });
});

test.describe('текст сервера', () => {
  const REQUEST_LINK = '/pay/demo/requests/c1?from=1000&to=2000';
  const answer = (page: Page, details: string) =>
    page.route('**/api/projects/pay/envs/demo/requests/c1*', (route) => route.fulfill({ status: 400, json: { error: { code: 'bad-request', details } } }));

  test('обрезанная ссылка на запрос: на русском пояснение сервера, на английском общий текст по коду', async ({ page }) => {
    await answer(page, 'границы запроса заданы неверно');
    await page.goto(REQUEST_LINK);
    await expect(page.getByRole('main')).toContainText('границы запроса заданы неверно');

    await withEnglish(page, { request: { badLink: { title: 'The link is wrong', text: 'Copy the link again from the request page.' } } });
    await choose(page, 'English');
    await expect(page.getByRole('heading', { name: 'The link is wrong' })).toBeVisible();
    await expect(page.getByRole('main')).toContainText('Copy the link again from the request page.');
    await expect(page.getByRole('main')).not.toContainText('границы запроса заданы неверно');
  });

  test('справочник только для чтения: причина с адресом базы только в подсказке', async ({ page }) => {
    const message = 'база db.example недоступна';
    await page.route('**/api/catalog', async (route) => {
      const res = await route.fetch();
      await route.fulfill({ response: res, json: { ...((await res.json()) as object), state: 'error', message } });
    });
    await page.goto('/pay/catalog');
    await expect(page.getByTestId('catalog-readonly')).toContainText(message);

    await withEnglish(page, { catalog: { readOnly: { errorPlain: 'Read only: the catalog loaded with an error.' } } });
    await choose(page, 'English');
    const notice = page.getByTestId('catalog-readonly');
    await expect(notice).toContainText('Read only: the catalog loaded with an error.');
    await expect(notice).not.toContainText(message);
    await expect(notice.locator(`[title="${message}"]`)).toBeVisible();
  });
});

for (const [code, name] of [['en', 'English']] as const) {
  test.describe(`длинные строки: ${code}`, () => {
    test.use({ viewport: { width: 768, height: 900 } });

    const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

    test('768px: результаты, страница запроса, справочник и проекты без горизонтальной прокрутки', async ({ page }) => {
      // Поиск по русским подписям формы, затем смена языка: результаты остаются на экране.
      await page.goto('/pay/demo');
      const input = page.getByRole('textbox', { name: 'Значения для поиска' });
      await input.fill('switch.pay.example');
      await input.press('Enter');
      await page.getByRole('group', { name: 'Период' }).getByRole('button', { name: '24 ч', exact: true }).click();
      await page.getByRole('button', { name: 'Найти', exact: true }).click();
      await expect(page.getByTestId('search-results')).toHaveAttribute('data-status', 'done', { timeout: 20_000 });
      await choose(page, name);
      await expect(page.locator('html')).toHaveAttribute('lang', code);
      await expect(page.getByRole('menu')).toHaveCount(0);
      await expect(page.locator('[data-row-link]').first()).toBeVisible();
      await expectHeaderFits(page, 'результаты');

      await page.locator('[data-row-link]').first().click(ROW_HIT);
      await expect(page.getByTestId('flow-canvas')).toBeVisible({ timeout: 15_000 });
      await expectHeaderFits(page, 'запрос');
      // Все вкладки запроса: на шкале и в записях своя вёрстка длинных подписей.
      const tabs = page.getByRole('main').getByRole('tab');
      await expect(tabs.first()).toBeVisible();
      expect(await tabs.count()).toBeGreaterThanOrEqual(3);
      for (let i = 0; i < (await tabs.count()); i++) {
        await tabs.nth(i).click();
        expect(await overflow(page), `запрос, вкладка ${i}`).toBeLessThanOrEqual(0);
      }

      for (const section of ['', '/ids', '/masking', '/general']) {
        await page.goto(`/pay/catalog${section}`);
        await expect(page.getByTestId('catalog-skeleton')).toHaveCount(0);
        await expect(page.getByTestId('catalog-page')).toBeVisible();
        await expectHeaderFits(page, `справочник${section}`);
      }

      await page.goto('/admin/projects');
      await expect(page.getByTestId('projects-skeleton')).toHaveCount(0);
      await expect(page.getByRole('main').getByRole('link').first()).toBeVisible();
      await expectHeaderFits(page, 'проекты');
      await page.goto('/admin/projects/new');
      await expect(page.locator('form input').first()).toBeVisible();
      await expectHeaderFits(page, 'новый проект');
    });

    for (const width of [768, 1024]) {
      test(`шапка на ${width}px: в одну строку, без наложения, с длинными названиями проекта и среды`, async ({ page }) => {
        await page.addInitScript(([k, c]) => localStorage.setItem(k!, c!), [KEY, code]);
        await page.setViewportSize({ width, height: 900 });
        for (const path of ['/pay/long', '/pay/pr/105', '/cards/demo', '/pay/catalog', '/cards/catalog', '/admin/projects', '/pay/long/requests/c1?from=1000&to=2000', '/pay/pr/105/requests/c1?from=1000&to=2000']) {
          await page.goto(path);
          await expect(page.getByTestId('auth-off')).toBeVisible();
          await expect(page.locator('html')).toHaveAttribute('lang', code);
          await expectHeaderFits(page, path);
        }
      });
    }
  });
}

