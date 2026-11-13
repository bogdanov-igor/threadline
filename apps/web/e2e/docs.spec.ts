// Страницы справки и «Сообщить о проблеме». Настоящего Telegram нет: сервер без токена, успешный ответ подставлен на адресе формы.
import { chromium, expect, test, type Page } from '@playwright/test';
import { closeMenu, helpButton, languageItem, openHelpMenu, openProjectMenu, openUserMenu, pickLanguage } from './helpers.ts';

const PAGES = ['/docs/admin-variables', '/docs/admin-install', '/about', '/learn', '/credits'];

async function openReport(page: Page) {
  await openHelpMenu(page);
  await page.getByTestId('header-report').click();
  await expect(page.getByTestId('report-dialog')).toBeVisible();
}

async function search(page: Page) {
  await page.goto('/pay/demo');
  const input = page.getByRole('textbox', { name: 'Значения для поиска' });
  await input.fill('getCard');
  await input.press('Enter');
  await page.getByRole('group', { name: 'Период' }).getByRole('button', { name: '24 ч', exact: true }).click();
  await page.getByRole('button', { name: 'Найти', exact: true }).click();
  await expect(page.getByTestId('search-results')).toHaveAttribute('data-status', 'done', { timeout: 20_000 });
}

/** Подставленный ответ формы и всё, что в неё ушло. */
async function acceptReports(page: Page) {
  const bodies: unknown[] = [];
  await page.route('**/api/report', async (route) => {
    bodies.push(route.request().postDataJSON());
    await route.fulfill({ json: { sent: true } });
  });
  return bodies;
}

test.describe('оболочки страниц', () => {
  test('документация: главная с разделами и поиском, «Дальше» с начала страницы, якорь под шапкой', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/docs');
    await expect(page).toHaveURL(/\/docs$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Документация' })).toBeVisible();
    for (const group of ['guide', 'learn', 'file', 'admin', 'arch']) await expect(page.getByTestId(`docs-home-${group}`)).toBeVisible();
    await expect(page.getByTestId('docs-home-learn').getByRole('link', { name: 'Найти причину ошибки по ID запроса' })).toBeVisible();
    // Поиск по названиям страниц и разделов обоих разделов: список поверх страницы, стрелки и Enter.
    const search = page.getByTestId('docs-search-input');
    const cards = await page.getByTestId('docs-home-sections').boundingBox();
    await search.fill('поиск');
    await expect(page.getByTestId('docs-search-hit').first()).toContainText('Поиск');
    expect(await page.getByTestId('docs-home-sections').boundingBox()).toEqual(cards);
    await search.press('ArrowDown');
    await search.press('ArrowUp');
    await search.press('Enter');
    await expect(page).toHaveURL(/\/docs\/guide-search$/);
    await expect(page.getByTestId('docs-nav').locator('a[aria-current="page"]')).toHaveAttribute('href', '/docs/guide-search');

    // Мышью по второму результату: список поверх подложки и карточек, его ничто не закрывает.
    await page.goto('/docs');
    await search.fill('роль');
    const second = page.getByTestId('docs-search-hit').nth(1);
    await expect(second).toBeVisible();
    const box = (await second.boundingBox())!;
    expect(await second.evaluate((el, [x, y]) => el.contains(document.elementFromPoint(x!, y!)), [box.x + box.width / 2, box.y + box.height / 2])).toBe(true);
    const href = await second.evaluate((el) => el.textContent);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page).toHaveURL(/\/docs\/guide-roles#/);
    expect(href).toContain('Роли и маски');
    // Пустой результат виден целиком.
    await page.goto('/docs');
    await search.fill('зюзюкавр');
    const empty = page.getByTestId('docs-search-empty');
    await expect(empty).toContainText('ничего не нашлось');
    const e = (await empty.boundingBox())!;
    for (const y of [e.y + 2, e.y + e.height - 2]) expect(await empty.evaluate((el, [x, yy]) => el.contains(document.elementFromPoint(x!, yy!)), [e.x + e.width / 2, y])).toBe(true);

    await page.goto('/docs/arch-overview');
    await expect(page.getByRole('heading', { level: 1, name: 'Из чего состоит Threadline' })).toBeVisible();
    await expect(page.getByTestId('docs-diagram').first()).toBeVisible();
    await expect(page.getByTestId('docs-breadcrumb')).toContainText('Как устроен сервис');
    // Следующая страница уже в карточках «Что читать дальше»: второй карточкой «Дальше» она не повторяется.
    await expect(page.getByTestId('docs-link-cards').locator('a[href="/docs/arch-request"]')).toHaveCount(1);
    await expect(page.getByTestId('docs-next')).toHaveCount(0);
    await expect(page.getByTestId('docs-prev')).toContainText('Установка и настройка');
    await page.goto('/docs/file-all-fields');
    await page.getByTestId('docs-next').scrollIntoViewIfNeeded();
    await expect(page.getByTestId('docs-next')).toContainText('Установка и настройка');
    await page.getByTestId('docs-next').click();
    await expect(page).toHaveURL(/\/docs\/admin-install$/);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);

    // Раздел из «На странице» встаёт под шапку: 56 шапки и зазор 24; отметка списка на нём.
    const toc = page.getByTestId('docs-toc');
    await toc.getByRole('link').nth(3).click();
    const id = decodeURIComponent(new URL(page.url()).hash.slice(1));
    const top = () => page.locator(`[id="${id}"]`).evaluate((el) => Math.round(el.getBoundingClientRect().top));
    await expect.poll(top).toBe(80);
    await expect(toc.locator('a[aria-current="location"]')).toHaveAttribute('data-toc', id);
    // Якорь работает и при открытии адреса напрямую: текст появляется после загрузки чанка.
    await page.reload();
    await expect.poll(top).toBe(80);
  });

  test('текст только на языке интерфейса и своего раздела; при смене языка прежний текст стоит, пока не пришёл новый', async ({ page }) => {
    const texts = new Set<string>();
    page.on('request', (r) => {
      const m = /\/assets\/docs-text-([a-z]{2})-([a-z]+)-/.exec(r.url());
      if (m) texts.add(`${m[1]}-${m[2]}`);
    });
    await page.goto('/docs/arch-overview');
    await expect(page.getByRole('heading', { level: 1, name: 'Из чего состоит Threadline' })).toBeVisible();
    expect([...texts].sort()).toEqual(['ru-admin', 'ru-arch', 'ru-file', 'ru-guide']);

    let release = () => {};
    const held = new Promise<void>((r) => (release = r));
    await page.route('**/assets/docs-text-en-*', async (route) => {
      await held;
      await route.continue();
    });
    await pickLanguage(page, 'English');
    // Строки оболочки уже английские, текст ещё русский: без заготовки и без пометки о переводе.
    await expect(page.getByTestId('docs-group-guide').getByRole('heading')).toHaveText('How to use');
    await expect(page.getByRole('heading', { level: 1, name: 'Из чего состоит Threadline' })).toBeVisible();
    await expect(page.getByTestId('page-skeleton')).toHaveCount(0);
    await expect(page.getByTestId('docs-not-translated')).toHaveCount(0);
    release();
    await expect(page.getByRole('heading', { level: 1, name: 'What Threadline is made of' })).toBeVisible();
    await expect(page.getByTestId('docs-not-translated')).toHaveCount(0);
    expect([...texts].filter((x) => !/^(ru|en)-(admin|arch|file|guide)$/.test(x))).toEqual([]);
  });

  test('текст страницы не загрузился: сообщение с повтором, шапка работает', async ({ page }) => {
    await page.route('**/assets/docs-text-*', (route) => route.abort());
    await page.goto('/docs/arch-overview');
    await expect(page.getByRole('main').getByRole('button')).toBeVisible();
    await expect(page.locator('[data-fatal-error]')).toBeVisible();
    await expect(helpButton(page)).toBeEnabled();
  });

  test('неизвестная страница и адрес глубже: экран неизвестного адреса, не проект', async ({ page }) => {
    for (const path of ['/docs/nothing', '/docs/catalog', '/docs/arch-overview/more', '/learn/nothing']) {
      await page.goto(path);
      await expect(page.getByTestId('docs-text'), path).toHaveCount(0);
      await expect(page.getByRole('main').getByRole('link').first(), path).toBeVisible();
    }
  });

  test('768: меню выдвигается слева из полосы над текстом, выбор страницы его закрывает; «На странице» — список в полосе; прокрутки вбок нет', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 800 });
    await page.goto('/docs/admin-keycloak');
    await expect(page.getByTestId('docs-sidebar')).toBeHidden();
    await expect(page.getByTestId('docs-toc')).toBeHidden();
    await expect(page.getByTestId('docs-bar')).toBeVisible();

    // «На странице»: список в полосе; раздел встаёт под шапку 56 и полосу 48 с зазором 24, на кнопке его название.
    await page.getByTestId('docs-toc-menu').click();
    const list = page.getByTestId('docs-toc-menu-list');
    await expect(list).toBeVisible();
    const link = list.getByRole('link').nth(2);
    const name = (await link.textContent())!;
    await link.click();
    await expect(list).toBeHidden();
    const id = decodeURIComponent(new URL(page.url()).hash.slice(1));
    await expect.poll(() => page.locator(`[id="${id}"]`).evaluate((el) => Math.round(el.getBoundingClientRect().top))).toBe(128);
    await expect(page.getByTestId('docs-toc-menu')).toContainText(name);

    // Меню: панель слева поверх страницы, текущая страница отмечена; Escape закрывает и возвращает фокус на кнопку.
    const toggle = page.getByTestId('docs-nav-toggle');
    const box = (await toggle.boundingBox())!;
    // Мышью по месту: click() Playwright сам прокручивает страницу к закреплённой кнопке.
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    const drawer = page.getByTestId('docs-drawer');
    await expect(drawer).toBeVisible();
    await expect.poll(async () => (await drawer.boundingBox())!.x).toBe(0);
    await expect(drawer.locator('a[aria-current="page"]')).toHaveAttribute('href', '/docs/admin-keycloak');
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
    await expect(toggle).toBeFocused();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await drawer.getByRole('link', { name: 'Установка', exact: true }).click();
    await expect(page).toHaveURL(/\/docs\/admin-install$/);
    await expect(drawer).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    // Широкая таблица и длинный код прокручиваются в своём блоке.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test('О Threadline: что это, зачем, для кого; версия с сервера, при сбое её нет', async ({ page }) => {
    await page.goto('/about');
    await expect(page.getByRole('heading', { level: 1, name: 'Threadline' })).toBeVisible();
    for (const block of ['about-what', 'about-why', 'about-whom']) await expect(page.getByTestId(block)).toBeVisible();
    await expect(page.getByTestId('about-version')).toContainText(/Версия \S+/);
    await expect(page.getByRole('main')).not.toContainText('Powered by');

    await page.route('**/api/health', (route) => route.abort());
    await page.goto('/about');
    await expect(page.getByTestId('about-what')).toBeVisible();
    await expect(page.getByTestId('about-version')).toHaveCount(0);
    // В меню «Справка» пункт «О Threadline» на месте, без версии.
    await openHelpMenu(page);
    await expect(page.getByTestId('header-about')).toBeVisible();
    await expect(page.getByTestId('header-version')).toHaveCount(0);
    await closeMenu(page);
  });

  test('версия с ревизией и датой сборки на «О Threadline», номер версии в меню «Справка»; чего нет в ответе, того нет в строке', async ({ page }) => {
    const health = (body: Record<string, string>) => page.route('**/api/health', (route) => route.fulfill({ json: { status: 'ok', ...body } }));
    await health({ version: '1.2.3', revision: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', builtAt: '2026-11-06T09:30:00.000Z' });
    // Браузер сквозных тестов в поясе Москвы.
    const full = 'Версия 1.2.3 · a1b2c3d · собрана 06.11.2026 12:30';
    await page.goto('/about');
    await expect(page.getByTestId('about-version')).toHaveText(full);
    // У пункта «О Threadline» меню «Справка» только номер версии.
    await openHelpMenu(page);
    await expect(page.getByTestId('header-about').getByTestId('header-version')).toHaveText('версия 1.2.3');
    await closeMenu(page);
    await page.unroute('**/api/health');
    await health({ version: '1.2.3' });
    await page.goto('/about');
    await expect(page.getByTestId('about-version')).toHaveText('Версия 1.2.3');
  });

  test('Обучение: та же оболочка, «Пройти» и фильтра ролей нет', async ({ page }) => {
    await page.goto('/learn');
    await expect(page.getByTestId('docs-page')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Пройти' })).toHaveCount(0);
  });

  test('Титры: только по адресу, ссылок нет ни на одной странице, авторы и благодарности, поисковикам закрыта', async ({ page }) => {
    for (const path of ['/pay/demo', ...PAGES]) {
      await page.goto(path);
      await expect(page.getByRole('main')).toBeVisible();
      await openHelpMenu(page);
      await expect(page.locator('a[href="/credits"]')).toHaveCount(0);
      await page.keyboard.press('Escape');
    }
    await page.goto('/credits');
    await expect(page.getByRole('heading', { level: 1, name: 'Титры' })).toBeVisible();
    await expect(page.getByTestId('credits-person')).toHaveCount(2);
    await expect(page.getByTestId('credits-person').first()).toContainText('Александр Иванов');
    await expect(page.getByTestId('credits-person').last()).toContainText('Игорь Богданов');
    await expect(page.getByRole('heading', { level: 2, name: 'Благодарности' })).toBeVisible();
    await expect(page.getByTestId('credits-thanks')).toHaveText(['Суннатила Анваров', 'Евгений Фоменко', 'Умар Акмалов']);
    await expect(page.getByRole('main')).not.toContainText('Имя Фамилия');
    await expect(page.locator('head meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  });

  test('список проектов недоступен: страницы открыты, кнопки проекта нет; к хранилищу запросов нет', async ({ page }) => {
    const asked: string[] = [];
    page.on('request', (r) => asked.push(new URL(r.url()).pathname));
    await page.route('**/api/projects', (route) => route.fulfill({ status: 500, json: { error: { code: 'unknown' } } }));
    for (const [path, testId] of [
      ['/docs', 'docs-page'],
      ['/docs/arch-request', 'docs-text'],
      ['/about', 'help-page-about'],
      ['/learn', 'docs-page'],
      ['/credits', 'help-page-credits'],
    ] as const) {
      await page.goto(path);
      await expect(page.getByTestId(testId), path).toBeVisible();
      await expect(page.getByTestId('project-menu'), path).toHaveCount(0);
      await expect(helpButton(page), path).toBeEnabled();
    }
    expect(asked.filter((p) => /\/(connection|stands|searches|operations)/.test(p))).toEqual([]);
    await page.goto('/pay/demo');
    await expect(page.getByTestId('search-panel')).toHaveCount(0);
  });

  test('код страницы не загрузился: сообщение с повтором, шапка работает', async ({ page }) => {
    await page.route('**/assets/DocsPage*', (route) => route.abort());
    await page.goto('/about');
    await expect(page.getByTestId('help-page-about')).toBeVisible();
    await openHelpMenu(page);
    await page.getByTestId('header-docs').click();
    await expect(page.getByRole('main').getByRole('button')).toBeVisible();
    await expect(helpButton(page)).toBeEnabled();
  });

  test('семь ширин, все страницы: прокрутки вбок нет', async ({ page }) => {
    for (const width of [768, 1024, 1280, 1440, 1536, 1920, 2560]) {
      await page.setViewportSize({ width, height: 800 });
      for (const path of PAGES) {
        await page.goto(path);
        await expect(page.getByRole('main')).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${path} ${width}`).toBe(true);
      }
    }
  });
});

/** Положение колонок: меню, текст и список «На странице». */
const columns = (page: Page) =>
  page.evaluate(() => {
    const box = (id: string) => {
      const el = document.querySelector(`[data-testid="${id}"]`);
      if (!el || el.getClientRects().length === 0) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width };
    };
    return { nav: box('docs-sidebar'), text: box('docs-text'), toc: box('docs-toc') };
  });

const scrollTo = async (page: Page, part: number) => {
  await page.evaluate((p) => window.scrollTo(0, (document.documentElement.scrollHeight - window.innerHeight) * p), part);
  await page.evaluate(() => new Promise(requestAnimationFrame));
};

test.describe('вёрстка документации', () => {
  // Разные по длине: длинные, с таблицами, короткие, без списка «На странице», обучение.
  const LAYOUT_PAGES = ['/docs/file-outcomes', '/docs/file-all-fields', '/docs/admin-backup', '/docs/guide-keys', '/docs/arch-overview', '/docs/guide-roles', '/learn/business', '/learn/file-first', '/learn/find-error'];

  test('колонки стоят на месте: настоящие размеры на трёх ширинах, в начале, середине и конце страницы, короткая страница, переход, окно поверх страницы', async ({ baseURL }) => {
    test.setTimeout(120_000);
    // Настоящие полосы прокрутки в 15 px, как на экране у людей: обычный запуск их скрывает, и сдвига от полосы не видно.
    const browser = await chromium.launch({ ignoreDefaultArgs: ['--hide-scrollbars'] });
    try {
      for (const [width, height] of [
        [1280, 800],
        [1280, 2600],
        [1536, 864],
        [1920, 1080],
      ] as const) {
        const context = await browser.newContext({ viewport: { width, height }, baseURL: baseURL!, locale: 'ru-RU' });
        await context.addInitScript(() => {
          document.addEventListener('DOMContentLoaded', () => {
            const style = document.createElement('style');
            style.textContent = '::-webkit-scrollbar{width:15px;height:15px;background:#ddd}';
            document.head.append(style);
          });
        });
        const page = await context.newPage();
        const seen: { path: string; at: string; boxes: Awaited<ReturnType<typeof columns>> }[] = [];
        for (const path of LAYOUT_PAGES) {
          await page.goto(path);
          await expect(page.getByTestId('docs-text')).toBeVisible();
          seen.push({ path, at: 'начало', boxes: await columns(page) });
          await scrollTo(page, 0.5);
          seen.push({ path, at: 'середина', boxes: await columns(page) });
          await scrollTo(page, 1);
          seen.push({ path, at: 'конец', boxes: await columns(page) });
        }
        const size = `${width}x${height}`;
        const one = (values: (number | undefined)[], name: string) => expect(new Set(values.filter((v) => v !== undefined)).size, `${name} ${size}`).toBe(1);
        // Ни одна колонка не двигается вбок ни между страницами, ни на странице без своей прокрутки, ни на странице без списка.
        one(seen.map((s) => s.boxes.nav?.x), 'меню x');
        one(seen.map((s) => s.boxes.text?.x), 'текст x');
        one(seen.map((s) => s.boxes.text?.width), 'текст ширина');
        one(seen.map((s) => s.boxes.toc?.x), 'список x');
        // Верх закреплённых колонок один и тот же в начале, середине и конце страницы: сразу под шапкой.
        for (const s of seen) {
          expect(s.boxes.nav?.y, `меню ${s.path} ${s.at} ${size}`).toBe(56);
          if (s.boxes.toc) expect(s.boxes.toc.y, `список ${s.path} ${s.at} ${size}`).toBe(56);
        }

        // Окно поверх страницы: место полосы прокрутки не удваивается, шапка и колонки стоят.
        await page.goto('/docs/guide-roles');
        await page.getByTestId('docs-zoomable').first().scrollIntoViewIfNeeded();
        const before = await columns(page);
        const help = await helpButton(page).boundingBox();
        await page.getByTestId('docs-zoomable').first().click();
        await expect(page.getByTestId('docs-viewer')).toBeVisible();
        expect(await columns(page), size).toEqual(before);
        expect(await helpButton(page).boundingBox(), size).toEqual(help);
        await page.keyboard.press('Escape');
        await context.close();
      }
    } finally {
      await browser.close();
    }
  });

  test('меню: своя прокрутка переживает переход, текущая страница видна, на странице без прокрутки и с малой высотой тоже', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 600 });
    await page.goto('/docs/guide-start');
    const nav = page.getByTestId('docs-nav');
    await expect.poll(() => nav.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    await nav.evaluate((el) => (el.scrollTop = 40));
    // Переход по видимому пункту: прокрутка меню остаётся.
    await nav.locator('a[href="/docs/guide-modes"]').click();
    await expect(page).toHaveURL(/guide-modes$/);
    expect(await nav.evaluate((el) => el.scrollTop)).toBe(40);
    // Пункт вне видимой части: меню само прокручивается к нему, группа открывается, страница остаётся в начале.
    await page.goto('/docs/file-all-fields');
    await nav.evaluate((el) => (el.scrollTop = 0));
    await page.getByTestId('docs-next').scrollIntoViewIfNeeded();
    await page.getByTestId('docs-next').click();
    await expect(page).toHaveURL(/admin-install$/);
    await expect(page.getByTestId('docs-group-admin').getByTestId('docs-group-toggle')).toHaveAttribute('aria-expanded', 'true');
    await expect(nav.locator('a[aria-current="page"]')).toBeInViewport({ ratio: 1 });
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    // Открытие адреса напрямую: текущая страница тоже видна.
    await page.goto('/docs/admin-backup');
    await expect(nav.locator('a[aria-current="page"]')).toBeInViewport({ ratio: 1 });
  });

  test('сдвига нет, когда приходит чанк и когда приходит картинка; с 768 колонка на том же месте', async ({ page }) => {
    for (const width of [1280, 768]) {
      await page.setViewportSize({ width, height: 800 });
      let release = () => {};
      const held = new Promise<void>((r) => (release = r));
      await page.route('**/assets/DocsPage*', async (route) => {
        await held;
        await route.continue();
      });
      await page.route('**/*.png', async (route) => {
        await held;
        await route.continue();
      });
      await page.goto('/docs/guide-roles');
      // Заготовка показывается через 300 мс: последняя её часть лежит в колонке текста.
      const skeleton = page.getByTestId('page-skeleton').locator('[data-slot=skeleton]').last();
      await expect(skeleton).toBeVisible();
      const reserved = (await skeleton.boundingBox())!;
      release();
      await expect(page.getByTestId('docs-text')).toBeVisible();
      const text = (await page.getByTestId('docs-text').boundingBox())!;
      expect(reserved.x, `${width}`).toBe(text.x);
      await page.unrouteAll();

      // Снимок ещё не загружен: место под него занято, позже текст ниже него не сдвигается.
      let showPictures = () => {};
      const pictures = new Promise<void>((r) => (showPictures = r));
      await page.route('**/*.png', async (route) => {
        await pictures;
        await route.continue();
      });
      await page.goto('/docs/guide-roles');
      const shot = page.getByTestId('docs-shot').first();
      await expect(shot).toBeVisible();
      await shot.scrollIntoViewIfNeeded();
      const top = () => page.getByTestId('docs-neighbours').evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
      const place = await top();
      const size = await shot.boundingBox();
      expect(await shot.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(false);
      showPictures();
      await expect.poll(() => shot.evaluate((img: HTMLImageElement) => img.naturalWidth > 0)).toBe(true);
      expect(await top(), `${width}`).toBe(place);
      expect(await shot.boundingBox(), `${width}`).toEqual(size);
      await page.unrouteAll();
    }
  });

  test('фокус в шапке не двигает страницу, фокус в тексте не уходит под шапку', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/docs/file-how');
    await expect(page.getByTestId('docs-text')).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 1500));
    // Мышью, не click(): Playwright сам прокручивает страницу к кнопке.
    const help = (await helpButton(page).boundingBox())!;
    await page.mouse.click(help.x + help.width / 2, help.y + help.height / 2);
    await expect(page.getByTestId('help-menu-content')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(helpButton(page)).toBeFocused();
    expect(await page.evaluate(() => window.scrollY)).toBe(1500);

    await page.getByTestId('docs-trees').getByRole('link').first().focus();
    await page.evaluate(() => window.scrollTo(0, 1500));
    await page.keyboard.press('Shift+Tab');
    await expect(page.locator('header :focus')).toHaveCount(1);
    expect(await page.evaluate(() => window.scrollY)).toBe(1500);

    await page.goto('/docs/guide-roles');
    const picture = page.getByTestId('docs-zoomable').first();
    await expect(picture).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, window.scrollY + document.querySelector('[data-testid="docs-zoomable"]')!.getBoundingClientRect().top - 20));
    await picture.focus();
    expect((await picture.boundingBox())!.y).toBeGreaterThanOrEqual(56);
  });

  test('первое открытие: моноширинный шрифт не двигает текст', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.addInitScript(() => {
      const seen: number[] = [];
      (window as unknown as { shifts: number[] }).shifts = seen;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) seen.push((entry as unknown as { value: number }).value);
      }).observe({ type: 'layout-shift', buffered: true });
    });
    await page.goto('/docs/admin-install');
    await expect(page.getByTestId('docs-text').locator('p code').first()).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);
    const shifts = await page.evaluate(() => (window as unknown as { shifts: number[] }).shifts);
    expect(shifts.reduce((a, b) => a + b, 0)).toBeLessThan(0.01);
  });

  test('якорь: обрезанный не роняет страницу, несуществующий на новой странице открывает её начало', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    for (const hash of ['#%', '#%E0%A4%A']) {
      await page.goto(`/docs/guide-start${hash}`);
      await expect(page.getByRole('heading', { level: 1, name: 'С чего начать' })).toBeVisible();
    }
    await page.goto('/docs/file-outcomes');
    await expect(page.getByTestId('docs-text')).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 3000));
    await page.evaluate(() => {
      history.pushState(null, '', '/docs/file-how#no-such-anchor');
      dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect(page).toHaveURL(/file-how#no-such-anchor$/);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  });

  test('с 768: текст на одном месте на всех страницах, полоса над текстом на всю ширину и закреплена под шапкой', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 900 });
    const seen: { x: number; width: number }[] = [];
    for (const path of LAYOUT_PAGES) {
      await page.goto(path);
      await expect(page.getByTestId('docs-text')).toBeVisible();
      const box = (await page.getByTestId('docs-text').boundingBox())!;
      seen.push({ x: box.x, width: box.width });
      // Полоса во всю ширину шапки: от края до края окна, без поля страницы.
      const bar = page.getByTestId('docs-bar');
      const header = (await page.getByRole('banner').boundingBox())!;
      expect(await bar.evaluate((el) => [el.getBoundingClientRect().x, el.getBoundingClientRect().width]), path).toEqual([header.x, header.width]);
      await scrollTo(page, 0.6);
      expect(await bar.evaluate((el) => el.getBoundingClientRect().y), path).toBe(56);
    }
    expect(new Set(seen.map((s) => `${s.x} ${s.width}`)).size).toBe(1);
  });
});

/** Сумма сдвигов вёрстки без недавнего ввода, как CLS у браузера. */
async function watchShifts(page: Page) {
  await page.addInitScript(() => {
    const seen: number[] = [];
    (window as unknown as { shifts: number[] }).shifts = seen;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as unknown as { value: number; hadRecentInput: boolean }[]) if (!entry.hadRecentInput) seen.push(entry.value);
    }).observe({ type: 'layout-shift', buffered: true });
  });
  return () => page.evaluate(() => (window as unknown as { shifts: number[] }).shifts.reduce((a, b) => a + b, 0));
}

/** Части страницы, которые прокручиваются сами, кроме самой страницы. */
const scrollers = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('main *')]
      .filter((el) => /(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 1)
      .map((el) => ({ id: el.getAttribute('data-testid'), overflow: el.hasAttribute('data-overflow'), contain: getComputedStyle(el).overscrollBehaviorY })),
  );

test.describe('чтение документации', () => {
  test('одна прокрутка: колонки закреплены, своя прокрутка только у колонки выше окна, и колесо из неё не уходит на страницу', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/docs/guide-search');
    await expect(page.getByTestId('docs-text')).toBeVisible();
    expect(await scrollers(page)).toEqual([]);
    // Колесо над меню, которое помещается в окно, прокручивает страницу.
    const nav = page.getByTestId('docs-nav');
    const box = (await nav.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 120);
    await page.mouse.wheel(0, 400);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);

    // Все группы открыты: меню выше окна и прокручивается само; страница под ним стоит.
    for (const toggle of await nav.getByTestId('docs-group-toggle').all()) if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
    await expect.poll(() => scrollers(page)).toEqual([{ id: 'docs-nav', overflow: true, contain: 'contain' }]);
    const before = await page.evaluate(() => window.scrollY);
    await page.mouse.move(box.x + box.width / 2, box.y + 120);
    for (let i = 0; i < 8; i++) await page.mouse.wheel(0, 400);
    await expect.poll(() => nav.evaluate((el) => Math.round(el.scrollTop + el.clientHeight - el.scrollHeight))).toBeGreaterThanOrEqual(-1);
    expect(await page.evaluate(() => window.scrollY)).toBe(before);
  });

  test('сдвигов нет: открытие, прокрутка до конца и переход на 1440 и 768, в светлой и тёмной теме, на главной тоже', async ({ page }) => {
    const total = await watchShifts(page);
    for (const [width, colorScheme] of [
      [1440, 'light'],
      [768, 'dark'],
    ] as const) {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme });
      for (const path of ['/docs', '/docs/guide-request', '/learn/transfer']) {
        await page.goto(path);
        await expect(page.getByTestId('docs-page')).toBeVisible();
        await page.evaluate(() => document.fonts.ready);
        for (let i = 0; i < 40; i++) {
          await page.mouse.wheel(0, 600);
          if (await page.evaluate(() => window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2)) break;
        }
        await page.waitForTimeout(300);
        expect(await total(), `${path} ${width} ${colorScheme}`).toBeLessThan(0.01);
      }
    }
  });

  test('место чтения: новая страница с начала, «Назад» и «Вперёд» возвращают место, без второго прыжка', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/docs/guide-roles');
    await expect(page.getByTestId('docs-text')).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 1500));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(1500);
    await page.getByTestId('docs-nav').locator('a[href="/docs/guide-modes"]').click();
    await expect(page).toHaveURL(/guide-modes$/);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    await page.evaluate(() => window.scrollTo(0, 700));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(700);
    // Событие прокрутки до 700 приходит в следующем кадре: под нагрузкой оно попало бы в список ниже.
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    // Все положения прокрутки после «Назад»: одно, без промежуточного начала страницы.
    await page.evaluate(() => {
      const seen: number[] = [];
      (window as unknown as { ys: number[] }).ys = seen;
      addEventListener('scroll', () => seen.push(Math.round(window.scrollY)), { passive: true });
    });
    await page.goBack();
    await expect(page).toHaveURL(/guide-roles$/);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(1500);
    // Событие прокрутки приходит кадром позже самого положения: без ожидания список под нагрузкой ещё пуст.
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    expect(await page.evaluate(() => (window as unknown as { ys: number[] }).ys)).toEqual([1500]);
    await page.goForward();
    await expect(page).toHaveURL(/guide-modes$/);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(700);
  });

  test('«На странице»: отметка и черта идут за местом чтения; без анимации при reduced motion переход сразу', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/docs/guide-roles');
    const toc = page.getByTestId('docs-toc');
    await expect(toc.locator('a[data-toc]').first()).toBeVisible();
    const ids = await toc.locator('a[data-toc]').evaluateAll((els) => els.map((e) => e.getAttribute('data-toc')!));
    expect(ids.length).toBeGreaterThan(5);
    await expect(toc.locator('[aria-current="location"]')).toHaveAttribute('data-toc', ids[0]!);
    const target = ids[3]!;
    await page.locator(`[id="${target}"]`).evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 80));
    await expect(toc.locator('[aria-current="location"]')).toHaveAttribute('data-toc', target);
    const offset = async () => {
      const [mark, item] = await Promise.all([toc.getByTestId('docs-toc-mark').boundingBox(), toc.locator(`[data-toc="${target}"]`).boundingBox()]);
      return Math.round(mark!.y - item!.y);
    };
    await expect.poll(offset).toBe(0);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(() => window.scrollTo(0, 0));
    const last = toc.locator('a[data-toc]').nth(ids.length - 2);
    const id = (await last.getAttribute('data-toc'))!;
    await last.click();
    await page.evaluate(() => new Promise(requestAnimationFrame));
    expect(await page.locator(`[id="${id}"]`).evaluate((el) => Math.round(el.getBoundingClientRect().top))).toBe(80);
  });

  test('меню: группы со значками, текущая страница — цвет акцента, фон и черта; фильтр по названиям страниц и разделов', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/docs/file-outcomes');
    const nav = page.getByTestId('docs-nav');
    const current = nav.locator('a[aria-current="page"]');
    await expect(current).toHaveAttribute('href', '/docs/file-outcomes');
    const look = await current.evaluate((el) => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--primary)';
      document.body.append(probe);
      const primary = getComputedStyle(probe).color;
      probe.remove();
      return { color: getComputedStyle(el).color, primary, background: getComputedStyle(el).backgroundColor, line: getComputedStyle(el, '::before').backgroundColor };
    });
    expect(look.color).toBe(look.primary);
    expect(look.line).toBe(look.primary);
    expect(look.background).not.toBe('rgba(0, 0, 0, 0)');
    await expect(page.getByTestId('docs-group-file').getByTestId('docs-group-toggle')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId('docs-group-guide').getByTestId('docs-group-toggle')).toHaveAttribute('aria-expanded', 'false');
    // Свёрнутая группа вне обхода Tab и чтения с экрана.
    await expect(nav.locator('[inert] a[href="/docs/guide-search"]')).toHaveCount(1);
    await page.getByTestId('docs-group-guide').getByTestId('docs-group-toggle').click();
    await expect(nav.locator('[inert] a[href="/docs/guide-search"]')).toHaveCount(0);
    await expect(nav.locator('a[href="/docs/guide-search"]')).toBeInViewport();

    const filter = page.getByTestId('docs-filter');
    await filter.fill('маск');
    const results = page.getByTestId('docs-filter-results');
    await expect(results.locator('a[href="/docs/file-masks"]')).toBeVisible();
    await expect(results.locator('a[href="/docs/guide-roles#маски"]')).toBeVisible();
    await filter.press('Escape');
    await expect(filter).toHaveValue('');
    await expect(results).toHaveCount(0);
    await filter.fill('несуществующее слово');
    await expect(page.getByTestId('docs-filter-empty')).toBeVisible();
  });

  test('окна поверх страницы не двигают место чтения: меню профиля, «?», выбор проекта, выдвижное меню, смена языка', async ({ page }) => {
    for (const [width, height] of [
      [1440, 900],
      [768, 900],
    ] as const) {
      await page.setViewportSize({ width, height });
      const menus: [string, () => Promise<void>][] = [
        ['профиль', () => openUserMenu(page)],
        ['?', () => openHelpMenu(page)],
        ['проект', () => openProjectMenu(page)],
      ];
      if (width < 1024)
        menus.push([
          'выдвижное меню',
          async () => {
            const toggle = (await page.getByTestId('docs-nav-toggle').boundingBox())!;
            await page.mouse.click(toggle.x + toggle.width / 2, toggle.y + toggle.height / 2);
            await expect(page.getByTestId('docs-drawer')).toBeVisible();
          },
        ]);
      for (const [name, open] of menus) {
        // Каждое окно — первое на только что открытой странице: прыжок был при первом открытии.
        await page.goto('/docs/guide-roles');
        await expect(page.getByTestId('docs-text')).toBeVisible();
        await page.evaluate(() => window.scrollTo(0, 2000));
        await open();
        await page.waitForTimeout(200);
        expect(await page.evaluate(() => window.scrollY), `${name} ${width}`).toBe(2000);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(200);
        expect(await page.evaluate(() => window.scrollY), `${name} ${width} после`).toBe(2000);
      }
    }
    await page.goto('/docs/guide-roles');
    await expect(page.getByTestId('docs-text')).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 1200));
    await openUserMenu(page);
    await languageItem(page, 'English').click();
    // Выбор языка меню не закрывает, а открытое меню прячет страницу от чтения с экрана: сначала закрыть.
    await page.keyboard.press('Escape');
    await expect(page.getByRole('heading', { level: 1, name: 'Roles and masks' })).toBeVisible();
    expect(await page.evaluate(() => window.scrollY)).toBe(1200);
  });

  test('переключатель «Документация · Обучение» возвращает на страницу, которую читали; путь урока — «Обучение › Урок N из M»', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/docs/file-methods');
    const trees = page.getByTestId('docs-trees');
    await trees.getByRole('link', { name: 'Обучение' }).click();
    await expect(page).toHaveURL(/\/learn\/find-error$/);
    await page.getByTestId('docs-nav').locator('a[href="/learn/card"]').click();
    await expect(page.getByTestId('docs-breadcrumb')).toHaveText(/^Обучение\s*Урок 2 из \d+$/);
    await expect(page.getByTestId('docs-group-learn')).toContainText('Обучение');
    await trees.getByRole('link', { name: 'Документация' }).click();
    await expect(page).toHaveURL(/\/docs\/file-methods$/);
    await expect(page.getByTestId('docs-sidebar')).toBeVisible();
    await trees.getByRole('link', { name: 'Обучение' }).click();
    await expect(page).toHaveURL(/\/learn\/card$/);
  });

  test('поиск находит формы слова и текст страниц; в коде лигатур нет', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/docs');
    const search = page.getByTestId('docs-search-input');
    for (const [query, href] of [
      ['роль', '/docs/guide-roles'],
      ['тёмная', null],
      ['темная', null],
      ['пароль', null],
      ['Keycloak', '/docs/admin-keycloak'],
    ] as const) {
      await search.fill(query);
      await expect(page.getByTestId('docs-search-hit').first(), query).toBeVisible();
      if (href) await expect(page.getByTestId('docs-search-hit').filter({ hasText: href === '/docs/guide-roles' ? 'Роли и маски' : 'OIDC' }).first(), query).toBeVisible();
    }
    await search.fill('пароль');
    await expect(page.getByTestId('docs-search-snippet').first().locator('mark').first()).toBeVisible();

    await page.goto('/docs/guide-start');
    const code = page.getByTestId('docs-text').locator('code').first();
    await expect(code).toBeVisible();
    expect(await code.evaluate((el) => getComputedStyle(el).fontVariantLigatures)).toBe('none');
  });

  test('главная: списки и нижние ссылки карточек одного ряда на одной линии; на 390 ничего не вылезает, у страницы короткая полоса', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    for (const lang of ['ru', 'en'] as const) {
      if (lang === 'en') {
        await openUserMenu(page);
        await languageItem(page, 'English').click();
      } else await page.goto('/docs');
      await expect(page.getByTestId('docs-home-arch')).toBeVisible();
      const rows = await page.evaluate(() =>
        [['guide', 'learn'], ['file', 'admin', 'arch']].map((row) =>
          row.map((g) => {
            const card = document.querySelector(`[data-testid="docs-home-${g}"]`)!;
            return [Math.round(card.querySelector('ul')!.getBoundingClientRect().top), Math.round(card.querySelector('[data-testid="docs-home-all"]')!.getBoundingClientRect().top)];
          }),
        ),
      );
      for (const row of rows) {
        expect(new Set(row.map((c) => c[0])).size, `${lang} списки`).toBe(1);
        expect(new Set(row.map((c) => c[1])).size, `${lang} нижние ссылки`).toBe(1);
      }
    }
    await page.goto('/');
    // Выбор сохраняется после загрузки строк: следующий переход ждёт отметки в меню.
    await pickLanguage(page, 'Русский');

    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto('/docs');
    await expect(page.getByTestId('docs-home-arch')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.goto('/docs/guide-roles');
    await expect(page.getByTestId('docs-text')).toBeVisible();
    // Кнопка ссылки — только значок, путь над заголовком не обрезан; названия страницы в полосе нет, «На странице» занимает остаток.
    expect((await page.getByTestId('docs-copy-link').boundingBox())!.width).toBeLessThanOrEqual(40);
    await expect(page.getByTestId('docs-breadcrumb')).toContainText('Как пользоваться');
    await expect(page.getByTestId('docs-bar-title')).toBeHidden();
    expect((await page.getByTestId('docs-toc-menu').boundingBox())!.width).toBeGreaterThan(200);
    // 768: название в полосе появляется, только когда заголовок ушёл под шапку.
    await page.setViewportSize({ width: 768, height: 900 });
    await page.evaluate(() => window.scrollTo(0, 0));
    const opacity = () => page.getByTestId('docs-bar-title').evaluate((el) => getComputedStyle(el).opacity);
    await expect.poll(opacity).toBe('0');
    await page.evaluate(() => window.scrollTo(0, 1500));
    await expect.poll(opacity).toBe('1');
  });

  test('переход в обучение: прежняя страница стоит, пока не пришёл текст, без заготовки и пустого кадра', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    let release = () => {};
    const held = new Promise<void>((r) => (release = r));
    await page.route('**/assets/docs-text-*-learn-*', async (route) => {
      await held;
      await route.continue();
    });
    await page.goto('/docs/guide-roles');
    await expect(page.getByRole('heading', { level: 1, name: 'Роли и маски' })).toBeVisible();
    await page.getByTestId('docs-trees').getByRole('link', { name: 'Обучение' }).click();
    await page.waitForTimeout(400);
    await expect(page.getByRole('heading', { level: 1, name: 'Роли и маски' })).toBeVisible();
    await expect(page.getByTestId('page-skeleton')).toHaveCount(0);
    release();
    await expect(page).toHaveURL(/\/learn\/find-error$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Найти причину ошибки по ID запроса' })).toBeVisible();
    await expect(page.getByTestId('docs-trees').locator('a[aria-current="true"]')).toHaveText('Обучение');
  });
});

test.describe('блоки кода документации', () => {
  test('копия без номеров, перенос включён и выключается, номера строк, подсветка в обеих темах, отметка примера не видна', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/docs/admin-backup');
    const bash = page.getByTestId('docs-code').first();
    await expect(bash).toHaveAttribute('data-lang', 'bash');
    await expect(bash.locator('[data-token="key"]').first()).toBeVisible();

    // Кнопки в том же порядке, что на странице запроса: перенос, потом «Копировать».
    const controls = bash.getByTestId('code-controls').getByRole('button');
    await expect(controls.nth(0)).toHaveAttribute('aria-label', 'Переносить строки');
    await expect(controls.nth(1)).toContainText('Копировать');

    // С переносом длинная команда читается без прокрутки вбок, номера стоят у каждой строки.
    const pre = bash.locator('pre');
    await expect(controls.nth(0)).toHaveAttribute('aria-pressed', 'true');
    const fits = () => pre.evaluate((el) => el.scrollWidth <= el.clientWidth);
    expect(await fits()).toBe(true);
    await expect(pre.locator('[data-n="1"]')).toBeVisible();
    await page.setViewportSize({ width: 768, height: 900 });
    expect(await fits()).toBe(true);

    await controls.nth(1).click();
    await expect(controls.nth(1)).toContainText('Скопировано');
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toBe(await pre.evaluate((el) => el.textContent));
    expect(copied.split('\n')).toHaveLength(await pre.locator('[data-n]').count());
    expect(copied).not.toMatch(/^\d/);
    await expect(controls.nth(1)).toContainText('Копировать', { timeout: 3000 });

    // Выбор переноса у каждого блока свой.
    await controls.nth(0).click();
    await expect(controls.nth(0)).toHaveAttribute('aria-pressed', 'false');
    expect(await pre.evaluate((el) => getComputedStyle(el).whiteSpaceCollapse)).toBe('preserve');
    await expect(pre).toHaveAttribute('tabindex', '0');
    await expect(page.getByTestId('docs-code').nth(1).getByTestId('code-controls').getByRole('button').first()).toHaveAttribute('aria-pressed', 'true');

    // На другой странице выбор не остаётся, отметки примеров не видны, цвета те же, что на странице запроса, в обеих темах.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByTestId('docs-group-file').getByTestId('docs-group-toggle').click();
    await page.getByTestId('docs-nav').locator('a[href="/docs/file-outcomes"]').click();
    await expect(page.getByRole('heading', { level: 1, name: 'Правила итога' })).toBeVisible();
    const yaml = page.getByTestId('docs-code').and(page.locator('[data-lang="yaml"]')).first();
    await expect(yaml.locator('pre')).not.toContainText(/\b(?:yaml|full|part)\b\s*\n/);
    await expect(yaml.getByTestId('code-controls').getByRole('button').first()).toHaveAttribute('aria-pressed', 'true');
    const key = yaml.locator('[data-token="key"]').first();
    for (const dark of [false, true]) {
      await page.evaluate((on) => document.documentElement.classList.toggle('dark', on), dark);
      const colours = await key.evaluate((el) => {
        const probe = document.createElement('span');
        probe.style.color = 'var(--sx-key)';
        document.body.append(probe);
        const want = getComputedStyle(probe).color;
        probe.remove();
        return { got: getComputedStyle(el).color, want };
      });
      expect(colours.got).toBe(colours.want);
    }
  });

  test('выделение мышью сохраняет пустые строки, номеров в нём нет', async ({ page }) => {
    await page.goto('/docs/file-start');
    const code = page.getByTestId('docs-code').first().locator('code');
    const { text, selected } = await code.evaluate((el) => {
      getSelection()!.selectAllChildren(el);
      return { text: el.textContent!, selected: getSelection()!.toString() };
    });
    expect(text).toMatch(/\n\n/);
    expect(selected.trimEnd()).toBe(text.trimEnd());
  });

  test('простой http: копия с клавиатуры оставляет фокус на кнопке', async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(window, 'isSecureContext', { value: false }));
    await page.goto('/docs/admin-grafana');
    const copy = page.getByTestId('docs-code').first().getByRole('button', { name: /Копировать/ });
    await copy.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('docs-code').first().getByRole('button', { name: /Скопировано/ })).toBeFocused();
  });

  test('код в строке остаётся кодом в строке', async ({ page }) => {
    await page.goto('/docs/admin-backup');
    await expect(page.getByTestId('docs-text').locator('p code').first()).toBeVisible();
    await expect(page.getByTestId('docs-text').locator('p [data-testid="docs-code"]')).toHaveCount(0);
  });
});

test.describe('картинка крупно', () => {
  const zoom = (page: Page) => page.getByTestId('docs-viewer-zoom-value');
  const percent = async (page: Page) => Number((await zoom(page).innerText()).replace(/\D/g, ''));
  const picture = (page: Page) => page.getByTestId('docs-viewer-picture');

  test('снимок: окно в странице, кнопки, колесо, перетаскивание, двойное нажатие, подпись, Esc и фокус на картинке; файл не открывается, ссылки нет', async ({ page, context }) => {
    let opened = 0;
    context.on('page', () => opened++);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/docs/file-start');
    const inPage = page.getByTestId('docs-zoomable').first();
    await expect(inPage.getByTestId('docs-shot')).toBeVisible();
    await expect(page.getByTestId('docs-text').locator('a[href*=".png"]')).toHaveCount(0);
    const sizeBefore = await inPage.getByTestId('docs-shot').boundingBox();

    await inPage.click();
    const viewer = page.getByTestId('docs-viewer');
    await expect(viewer).toBeVisible();
    expect(opened).toBe(0);
    const scrolled = await page.evaluate(() => window.scrollY);
    await expect(page.getByTestId('docs-viewer-caption')).toHaveText(/\S/);
    await expect(page.getByTestId('docs-viewer-zoom-fit')).toContainText('Вписать');

    // Вписано: вся картинка в окне, ничего не обрезано.
    const stage = (await page.getByTestId('docs-viewer-stage').boundingBox())!;
    const fitted = (await picture(page).boundingBox())!;
    expect(fitted.x).toBeGreaterThanOrEqual(stage.x);
    expect(fitted.x + fitted.width).toBeLessThanOrEqual(stage.x + stage.width);
    expect(fitted.y).toBeGreaterThanOrEqual(stage.y);
    expect(fitted.y + fitted.height).toBeLessThanOrEqual(stage.y + stage.height);
    const fit = await percent(page);

    // Кнопки.
    await page.getByTestId('docs-viewer-zoom-in').click();
    expect(await percent(page)).toBeGreaterThan(fit);
    await page.getByTestId('docs-viewer-zoom-out').click();
    await page.getByTestId('docs-viewer-zoom-fit').click();
    expect(await percent(page)).toBe(fit);

    // Колесо: точка под указателем остаётся на месте.
    const at = { x: fitted.x + fitted.width * 0.75, y: fitted.y + fitted.height * 0.25 };
    await page.mouse.move(at.x, at.y);
    await page.mouse.wheel(0, -400);
    await expect.poll(() => percent(page)).toBeGreaterThan(fit);
    const zoomed = (await picture(page).boundingBox())!;
    expect(Math.abs((at.x - zoomed.x) / zoomed.width - 0.75)).toBeLessThan(0.02);
    expect(Math.abs((at.y - zoomed.y) / zoomed.height - 0.25)).toBeLessThan(0.02);
    // Страница под окном не прокрутилась.
    expect(await page.evaluate(() => window.scrollY)).toBe(scrolled);

    // Перетаскивание.
    await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2);
    await page.mouse.down();
    await page.mouse.move(stage.x + stage.width / 2 + 120, stage.y + stage.height / 2 + 60, { steps: 4 });
    await page.mouse.up();
    const dragged = (await picture(page).boundingBox())!;
    expect(dragged.x - zoomed.x).toBeGreaterThan(100);
    await expect(viewer).toBeVisible();
    const notDragged = await picture(page).boundingBox();
    // Двойное нажатие: обратно в «Вписать» и снова крупнее.
    await page.mouse.dblclick(stage.x + stage.width / 2, stage.y + stage.height / 2);
    await expect.poll(() => percent(page)).toBe(fit);
    expect(await picture(page).boundingBox()).not.toEqual(notDragged);
    const center = (await picture(page).boundingBox())!;
    await page.mouse.dblclick(center.x + center.width / 2, center.y + center.height / 2);
    await expect.poll(() => percent(page)).toBeGreaterThan(fit);

    // Горячие клавиши приложения молчат.
    await page.keyboard.press('Shift+Slash');
    await expect(page.getByTestId('keys-dialog')).toHaveCount(0);
    await expect(viewer).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(viewer).toHaveCount(0);
    await expect(inPage).toBeFocused();
    // В колонке снимок прежнего размера: окно его не трогает.
    const sizeAfter = (await inPage.getByTestId('docs-shot').boundingBox())!;
    expect([sizeAfter.width, sizeAfter.height]).toEqual([sizeBefore!.width, sizeBefore!.height]);
    expect(opened).toBe(0);

    // Нажатие мимо картинки и мимо окна закрывает.
    await inPage.click();
    await expect(viewer).toBeVisible();
    // Первые полсекунды окно защищено от случайного нажатия.
    await page.waitForTimeout(600);
    const free = (await page.getByTestId('docs-viewer-stage').boundingBox())!;
    await page.mouse.click(free.x + 6, free.y + 6);
    await expect(viewer).toHaveCount(0);
    await inPage.click();
    await expect(viewer).toBeVisible();
    await page.waitForTimeout(600);
    await page.mouse.click(4, 4);
    await expect(viewer).toHaveCount(0);
    await expect(page).toHaveURL(/file-start$/);
  });

  test('с клавиатуры: Enter открывает, плюс, минус, ноль, стрелки, Tab до кнопок, Esc возвращает на картинку', async ({ page }) => {
    await page.goto('/docs/guide-roles');
    const inPage = page.getByTestId('docs-zoomable').first();
    await inPage.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('docs-viewer')).toBeVisible();
    await expect(page.getByTestId('docs-viewer-stage')).toBeFocused();
    const fit = await percent(page);
    await page.keyboard.press('Equal');
    await expect.poll(() => percent(page)).toBeGreaterThan(fit);
    await page.keyboard.press('Digit0');
    await expect.poll(() => percent(page)).toBe(fit);
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('docs-viewer-close')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('docs-viewer-zoom-fit')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(inPage).toBeFocused();
  });

  test('двойной щелчок по картинке оставляет окно открытым, позже нажатие мимо закрывает', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/docs/guide-roles');
    const shot = page.getByTestId('docs-shot').first();
    await shot.scrollIntoViewIfNeeded();
    const box = (await shot.boundingBox())!;
    // Второе нажатие у края снимка попадает в окно мимо картинки.
    await page.mouse.dblclick(box.x + box.width * 0.05, box.y + box.height / 2, { delay: 20 });
    await expect(page.getByTestId('docs-viewer')).toBeVisible();
    await page.waitForTimeout(150);
    await expect(page.getByTestId('docs-viewer')).toBeVisible();
    await page.waitForTimeout(500);
    const stage = (await page.getByTestId('docs-viewer-stage').boundingBox())!;
    await page.mouse.click(stage.x + 4, stage.y + 4);
    await expect(page.getByTestId('docs-viewer')).toHaveCount(0);
  });

  test('плюс у предела: фокус на кнопке, Tab ходит только внутри окна', async ({ page }) => {
    await page.goto('/docs/guide-roles');
    await page.getByTestId('docs-zoomable').first().focus();
    await page.keyboard.press('Enter');
    const plus = page.getByTestId('docs-viewer-zoom-in');
    await plus.focus();
    for (let i = 0; i < 20 && (await percent(page)) < 400; i++) await page.keyboard.press('Enter');
    await expect(plus).toBeDisabled();
    await expect(plus).toBeFocused();
    await page.keyboard.press('Enter');
    expect(await percent(page)).toBe(400);
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Tab');
      await expect(page.getByTestId('docs-viewer').locator(':focus')).toHaveCount(1);
    }
  });

  test('«Назад» на запись с якорем закрывает окно и снимает блокировку прокрутки', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/docs/guide-roles');
    await page.getByTestId('docs-toc').getByRole('link').nth(1).click();
    await expect(page).toHaveURL(/#/);
    await page.getByTestId('docs-zoomable').last().click();
    await expect(page.getByTestId('docs-viewer')).toBeVisible();
    await page.goBack();
    await expect(page.getByTestId('docs-viewer')).toHaveCount(0);
    await expect(page.locator('body[data-scroll-locked]')).toHaveCount(0);
  });

  test('вписанная картинка после сдвига вписывается в новое окно; щипок над подписью страницу не масштабирует', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/docs/guide-roles');
    await page.getByTestId('docs-zoomable').first().click();
    await expect(page.getByTestId('docs-viewer')).toBeVisible();
    const pinch = await page.getByTestId('docs-viewer-caption').evaluate((el) => {
      const e = new WheelEvent('wheel', { ctrlKey: true, deltaY: -10, bubbles: true, cancelable: true });
      el.dispatchEvent(e);
      return e.defaultPrevented;
    });
    expect(pinch).toBe(true);
    const box = (await picture(page).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2, { steps: 4 });
    await page.mouse.up();
    await page.setViewportSize({ width: 800, height: 500 });
    await expect.poll(async () => (await picture(page).boundingBox())!.height).toBeLessThan(box.height);
    const stage = (await page.getByTestId('docs-viewer-stage').boundingBox())!;
    expect((await picture(page).boundingBox())!.height).toBeLessThanOrEqual(stage.height);
  });

  test('схема: масштаб настоящим размером, а не растяжением, тёмная тема; окно на 768; щипок двумя пальцами', async ({ page, browser, baseURL }) => {
    await page.setViewportSize({ width: 768, height: 800 });
    await page.goto('/docs/arch-overview');
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    const inPage = page.getByTestId('docs-zoomable').first();
    await inPage.scrollIntoViewIfNeeded();
    const before = await inPage.boundingBox();
    await inPage.click();
    const box = (await page.getByTestId('docs-viewer').boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(768);
    expect(box.y + box.height).toBeLessThanOrEqual(800);
    const svg = page.getByTestId('docs-viewer').getByTestId('docs-diagram');
    const small = await svg.evaluate((el) => el.clientWidth);
    await page.getByTestId('docs-viewer-zoom-in').click();
    await page.getByTestId('docs-viewer-zoom-in').click();
    // clientWidth не видит transform: вектор рисуется заново в новом размере.
    await expect.poll(() => svg.evaluate((el) => el.clientWidth)).toBeGreaterThan(small);
    expect(await page.getByTestId('docs-viewer-picture').evaluate((el) => getComputedStyle(el).transform)).toMatch(/^matrix\(1, 0, 0, 1,/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.keyboard.press('Escape');
    expect(await inPage.boundingBox()).toEqual(before);

    // Щипок: настоящие касания двумя пальцами.
    const context = await browser.newContext({ viewport: { width: 1024, height: 800 }, hasTouch: true, baseURL: baseURL!, locale: 'ru-RU' });
    const touch = await context.newPage();
    await touch.goto('/docs/arch-overview');
    await touch.getByTestId('docs-zoomable').first().click();
    await expect(touch.getByTestId('docs-viewer')).toBeVisible();
    const start = await percent(touch);
    const stage = (await touch.getByTestId('docs-viewer-stage').boundingBox())!;
    const cx = stage.x + stage.width / 2;
    const cy = stage.y + stage.height / 2;
    const cdp = await context.newCDPSession(touch);
    const fingers = (d: number) => [
      { x: cx - d, y: cy, id: 0 },
      { x: cx + d, y: cy, id: 1 },
    ];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: fingers(60) });
    for (const d of [80, 100, 120, 140]) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: fingers(d) });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(() => percent(touch)).toBeGreaterThan(start);
    await expect(touch.getByTestId('docs-viewer')).toBeVisible();
    await context.close();
  });
});

test.describe('сообщить о проблеме', () => {
  test('в меню четыре пункта, форма предупреждает о персональных данных, отправить пустое нельзя, Escape возвращает фокус', async ({ page }) => {
    await page.goto('/about');
    await openReport(page);
    await expect(page.getByTestId('report-warning')).toContainText('Не вставляйте персональные данные');
    await expect(page.getByTestId('report-text')).toBeFocused();
    await expect(page.getByTestId('report-send')).toBeDisabled();
    await page.getByTestId('report-text').fill('   ');
    await expect(page.getByTestId('report-send')).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('report-dialog')).toHaveCount(0);
    await expect(helpButton(page)).toBeFocused();
  });

  test('на странице результатов: уходит текст и короткая ссылка этой страницы, форма сообщает об успехе, одно сообщение', async ({ page }) => {
    const bodies = await acceptReports(page);
    await search(page);
    await openReport(page);
    await expect(page.getByTestId('report-link-note')).toHaveAttribute('data-link', 'will');
    await page.getByTestId('report-text').fill('Граф показывает не тот шаг');
    await page.getByTestId('report-send').click();
    await expect(page.getByTestId('report-sent')).toContainText('Сообщение отправлено');
    expect(bodies).toEqual([{ text: 'Граф показывает не тот шаг', link: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/s\/[A-Za-z0-9_-]{22}$/), page: '/pay/demo' }]);
  });

  test('на странице запроса: в сообщении нет тел, заголовков и значений поиска, только текст и ссылка', async ({ page }) => {
    const bodies = await acceptReports(page);
    await search(page);
    await page.getByRole('list', { name: 'Найденные запросы' }).getByRole('listitem').first().locator('[data-row-link]').click({ position: { x: 8, y: 8 } });
    await expect(page.getByTestId('request-header')).toBeVisible();
    await openReport(page);
    await page.getByTestId('report-text').fill('Неточный текст');
    await page.getByTestId('report-send').click();
    await expect(page.getByTestId('report-sent')).toBeVisible();
    const body = bodies[0] as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['link', 'page', 'text']);
    // Страница для журнала: шаблон, correlation_id из адреса в запрос не идёт.
    expect(body.page).toBe('/pay/demo/requests/***');
    expect(JSON.stringify(body)).not.toContain('getCard');
  });

  test('на странице без короткой ссылки уходит только описание, форма говорит об этом заранее', async ({ page }) => {
    const bodies = await acceptReports(page);
    await page.goto('/about');
    await openReport(page);
    await expect(page.getByTestId('report-link-note')).toHaveAttribute('data-link', 'none');
    await page.getByTestId('report-text').fill('Описание');
    await page.getByTestId('report-send').click();
    await expect(page.getByTestId('report-sent')).toContainText('короткой ссылки в нём нет');
    expect(bodies).toEqual([{ text: 'Описание', link: null, page: '/about' }]);
  });

  test('ссылка не создалась: описание уходит без неё, итог об этом говорит', async ({ page }) => {
    const bodies = await acceptReports(page);
    await search(page);
    await page.route('**/api/share', (route) => route.fulfill({ status: 503, json: { error: { code: 'share-unavailable' } } }));
    await openReport(page);
    await page.getByTestId('report-text').fill('Описание');
    await page.getByTestId('report-send').click();
    await expect(page.getByTestId('report-sent')).toContainText('короткой ссылки в нём нет');
    expect(bodies).toEqual([{ text: 'Описание', link: null, page: '/pay/demo' }]);
  });

  test('Telegram не настроен: настоящий ответ сервера, контакт поддержки, текст на экране', async ({ page }) => {
    await page.route('**/api/support-contact', (route) => route.fulfill({ json: { text: 'Группа сопровождения', url: null } }));
    await page.goto('/about');
    await openReport(page);
    await page.getByTestId('report-text').fill('Мой длинный текст');
    await page.getByTestId('report-send').click();
    await expect(page.getByTestId('report-failure')).toHaveAttribute('data-kind', 'notConfigured');
    await expect(page.getByTestId('support-contact')).toContainText('Группа сопровождения');
    await expect(page.getByTestId('report-text')).toHaveValue('Мой длинный текст');
  });

  test('отправка не удалась: причина без подробностей, текст на экране, повтор только по нажатию', async ({ page }) => {
    let posts = 0;
    await page.route('**/api/report', async (route) => {
      posts++;
      if (posts === 1) return route.fulfill({ status: 502, json: { error: { code: 'report-failed' } } });
      await route.fulfill({ json: { sent: true } });
    });
    await page.goto('/about');
    await openReport(page);
    await page.getByTestId('report-text').fill('Текст');
    await page.getByTestId('report-send').click();
    await expect(page.getByTestId('report-failure')).toHaveAttribute('data-kind', 'failed');
    await expect(page.getByTestId('report-text')).toHaveValue('Текст');
    await page.waitForTimeout(300);
    expect(posts).toBe(1);
    await page.getByTestId('report-send').click();
    await expect(page.getByTestId('report-sent')).toBeVisible();
    expect(posts).toBe(2);
  });

  test('предел сообщений: время повтора названо', async ({ page }) => {
    await page.route('**/api/report', (route) => route.fulfill({ status: 429, headers: { 'Retry-After': '120' }, json: { error: { code: 'report-rate-limited', retryAfterSeconds: 120 } } }));
    await page.goto('/about');
    await openReport(page);
    await page.getByTestId('report-text').fill('Текст');
    await page.getByTestId('report-send').click();
    await expect(page.getByTestId('report-failure')).toContainText('через 2 мин');
  });

  test('длинный текст ограничен, счётчик виден у предела; форма помещается в окно 768', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 700 });
    await page.goto('/about');
    await openReport(page);
    await page.getByTestId('report-text').fill('я'.repeat(2500));
    await expect(page.getByTestId('report-text')).toHaveValue('я'.repeat(2000));
    await expect(page.getByTestId('report-counter')).toContainText('2000 из 2000');
    const box = (await page.getByTestId('report-dialog').boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(768);
    expect(box.y + box.height).toBeLessThanOrEqual(700);
  });

  test('кнопка на «О Threadline» открывает ту же форму и возвращает фокус', async ({ page }) => {
    await page.goto('/about');
    await page.getByTestId('about-report').click();
    await expect(page.getByTestId('report-dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('about-report')).toBeFocused();
  });
});
