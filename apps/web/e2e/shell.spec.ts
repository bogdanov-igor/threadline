import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { closeMenu, expectHeaderFits, goToService, header, helpButton, languageItem, openHelpMenu, openProjectMenu, openUserMenu, paths, pickTheme, projectButton, serviceLink, themeItem, userButton, userMenu } from './helpers.ts';

const main = (page: Page) => page.getByRole('main');
const envSelect = (page: Page) => main(page).getByRole('combobox', { name: /^Среда:/ });
const indicator = (page: Page) => page.getByTestId('connection-indicator');

test.describe('оболочка', () => {
  test('корень открывает проект и среду по умолчанию, шапка полная', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/pay\/demo$/);
    await expect(header(page).getByRole('link', { name: 'Threadline, на главную' })).toBeVisible();
    await expect(header(page).getByRole('button', { name: /^Проект: Demo Pay/ })).toBeVisible();
    await expect(header(page).getByTestId('threadline-mark')).toBeVisible();
    await expect(helpButton(page)).toBeVisible();
    await expect(page.getByTestId('auth-off')).toBeVisible();
    // Справа только две кнопки: «Справка» и профиль.
    await expect(page.getByTestId('header-actions').locator('button, a')).toHaveCount(2);
    // Разделов, настроек сервиса, языка и темы в самой шапке нет: они в меню проекта и профиля.
    for (const id of ['header-catalog', 'header-projects', 'header-docs', 'header-service', 'theme-toggle', 'language-switch']) await expect(page.getByTestId(id)).toHaveCount(0);
    await openUserMenu(page);
    await expect(serviceLink(page)).toHaveAttribute('href', '/admin/status');
    await closeMenu(page);
    // Среда и состояние подключения в карточке поиска, а не в шапке.
    await expect(page.getByTestId('search-panel').getByTestId('connection-indicator')).toHaveAttribute('data-status', 'demo');
    await expect(envSelect(page)).toHaveAccessibleName('Среда: Demo, демо');
    await expect(header(page).getByRole('combobox', { name: /^Среда:/ })).toHaveCount(0);
    await expect(header(page).getByTestId('connection-indicator')).toHaveCount(0);
  });

  test('смена среды меняет адрес, «назад» возвращает прежнюю', async ({ page }) => {
    await page.goto('/pay/demo');
    await envSelect(page).click();
    await page.getByRole('option', { name: 'Slow' }).click();
    await expect(page).toHaveURL(/\/pay\/slow$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/pay\/demo$/);
    await expect(envSelect(page)).toHaveAccessibleName(/^Среда: Demo/);
  });

  test('ссылка открывает те же проект и среду', async ({ page }) => {
    await page.goto('/cards/demo');
    await expect(header(page).getByRole('button', { name: /^Проект: Card processing/ })).toBeVisible();
  });

  test('неизвестная среда в адресе', async ({ page }) => {
    await page.goto('/pay/nope');
    await expect(page.getByRole('heading', { name: 'Такой среды нет' })).toBeVisible();
    // Оттуда можно найти скрытый проект, а кнопки проекта в шапке нет. «Настройки сервиса» в меню профиля на месте.
    await expect(header(page).getByRole('link', { name: 'Проекты' })).toHaveAttribute('href', '/admin/projects');
    await expect(projectButton(page)).toHaveCount(0);
    await openUserMenu(page);
    await expect(serviceLink(page)).toBeVisible();
    await closeMenu(page);
    await page.getByRole('link', { name: 'Открыть Demo Pay / Demo' }).click();
    await expect(page).toHaveURL(/\/pay\/demo$/);
  });

  test('неизвестный проект в адресе', async ({ page }) => {
    await page.goto('/zz/demo');
    await expect(page.getByRole('heading', { name: 'Такой среды нет' })).toBeVisible();
    await expect(page.getByRole('main')).toContainText('нет проекта «zz»');
  });

  test('стенд у обычной среды и неверный номер в адресе — неизвестная среда', async ({ page }) => {
    await page.goto('/pay/demo/92');
    await expect(page.getByRole('heading', { name: 'Такой среды нет' })).toBeVisible();
    await page.goto('/pay/pr/92abc');
    await expect(page.getByRole('heading', { name: 'Такой среды нет' })).toBeVisible();
  });

  test('корень открывает последний выбор в этом браузере', async ({ page }) => {
    await page.goto('/pay/pr/92');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Стенд 92');
    await page.goto('/');
    await expect(page).toHaveURL(/\/pay\/pr\/92$/);
  });

  test('без хранилища браузера работает, открывает значения по умолчанию, тема живёт до закрытия вкладки', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        get() {
          throw new DOMException('denied', 'SecurityError');
        },
      });
    });
    await page.goto('/');
    await expect(page).toHaveURL(/\/pay\/demo$/);
    await pickTheme(page, 'Тёмная');
    await expect(page.locator('html')).toHaveClass(/dark/);
    await page.reload();
    await expect(page.locator('html')).not.toHaveClass(/dark/);
  });
});

test.describe('стенды PR', () => {
  test('список живых стендов, выбор и ручной ввод', async ({ page }) => {
    await page.goto('/pay/pr');
    const list = page.getByRole('main').getByRole('list', { name: 'Живые стенды за 7 дней' });
    await expect(list.getByRole('button')).toHaveText(['105', '92']);
    await list.getByRole('button', { name: '92' }).click();
    await expect(page).toHaveURL(/\/pay\/pr\/92$/);
    await expect(main(page).getByRole('button', { name: 'Стенд: Стенд 92' })).toBeVisible();
  });

  test('неверный номер не принимается', async ({ page }) => {
    await page.goto('/pay/pr');
    const input = page.getByRole('main').getByLabel('Номер стенда');
    for (const bad of ['92a', '1234567', '']) {
      await input.fill(bad);
      await page.getByRole('main').getByRole('button', { name: 'Открыть' }).click();
      await expect(page.getByRole('main').getByRole('alert')).toHaveText('Номер стенда — от одной до шести цифр');
      await expect(page).toHaveURL(/\/pay\/pr$/);
    }
  });

  test('ручной ввод стенда, которого нет среди живых, предупреждает', async ({ page }) => {
    await page.goto('/pay/pr');
    await page.getByRole('main').getByLabel('Номер стенда').fill('93');
    await page.getByRole('main').getByRole('button', { name: 'Открыть' }).click();
    await expect(page).toHaveURL(/\/pay\/pr\/93$/);
    await expect(page.getByTestId('search-line')).toContainText('Стенда 93 нет среди живых');
  });

  test('живых стендов нет: сообщение и ручной ввод', async ({ page }) => {
    await page.goto('/pay/pr-empty');
    await expect(page.getByRole('main')).toContainText('Живых стендов за 7 дней нет');
    await expect(page.getByRole('main').getByLabel('Номер стенда')).toBeVisible();
  });

  test('список стендов не загрузился: причина и ручной ввод', async ({ page }) => {
    await page.goto('/pay/pr-broken');
    await expect(page.getByRole('main').getByRole('alert')).toContainText('Список стендов не загрузился: нет связи с хранилищем');
    await page.getByRole('main').getByLabel('Номер стенда').fill('7');
    await page.getByRole('main').getByRole('button', { name: 'Открыть' }).click();
    await expect(page).toHaveURL(/\/pay\/pr-broken\/7$/);
  });

  test('выбор стенда из карточки поиска', async ({ page }) => {
    await page.goto('/pay/pr/105');
    await main(page).getByRole('button', { name: 'Стенд: Стенд 105' }).click();
    await page.getByRole('dialog').getByRole('button', { name: '92' }).click();
    await expect(page).toHaveURL(/\/pay\/pr\/92$/);
  });
});

test.describe('индикатор подключения', () => {
  test('ошибка: причина, совет, «Проверить снова»', async ({ page }) => {
    await page.goto('/pay/unauthorized');
    await expect(indicator(page)).toHaveAttribute('data-status', 'unauthorized');
    await indicator(page).click();
    const pop = page.getByRole('dialog');
    await expect(pop.getByRole('heading', { name: 'Токен недействителен' })).toBeVisible();
    // Имитация не Grafana и не Loki: общий совет.
    await expect(pop).toContainText('Хранилище не приняло учётные данные');
    await expect(pop.getByRole('button', { name: 'Проверить снова' })).toBeVisible();
  });

  test('не настроено: называет переменную', async ({ page }) => {
    await page.goto('/pay/prod');
    await expect(indicator(page)).toHaveAttribute('data-status', 'not-configured');
    await expect(page.getByTestId('search-not-configured')).toContainText('THREADLINE_E2E_TOKEN_NOT_SET');
    await indicator(page).click();
    await expect(page.getByRole('dialog')).toContainText('THREADLINE_E2E_TOKEN_NOT_SET');
  });

  test('демо поясняет, что данные синтетические', async ({ page }) => {
    await page.goto('/pay/demo');
    await indicator(page).click();
    await expect(page.getByRole('dialog')).toContainText('Синтетические записи');
  });

  for (const [env, title] of [
    ['network', 'Нет связи с хранилищем'],
    ['certificate', 'Сертификат не доверен'],
    ['not-found', 'Источник не найден'],
  ] as const) {
    test(`состояние ${env}`, async ({ page }) => {
      await page.goto(`/pay/${env}`);
      await expect(indicator(page)).toHaveAttribute('data-status', env);
      await indicator(page).click();
      await expect(page.getByRole('dialog').getByRole('heading', { name: title })).toBeVisible();
    });
  }

  test('перегрузка называет срок повтора', async ({ page }) => {
    await page.goto('/pay/overloaded');
    await expect(indicator(page)).toHaveAttribute('data-status', 'overloaded');
    await indicator(page).click();
    await expect(page.getByRole('dialog')).toContainText('Повторите через 15 с.');
  });

  test('за час открытой вкладки уходит одна проверка', async ({ page }) => {
    await page.clock.install();
    let checks = 0;
    page.on('request', (r) => {
      if (r.url().includes('/connection')) checks++;
    });
    await page.goto('/pay/demo');
    await expect(indicator(page)).toHaveAttribute('data-status', 'demo');
    await page.clock.fastForward('01:00:00');
    await page.waitForTimeout(300);
    expect(checks).toBe(1);
  });

  test('«Проверить снова» обходит кэш', async ({ page }) => {
    await page.goto('/pay/demo');
    await expect(indicator(page)).toHaveAttribute('data-status', 'demo');
    const req = page.waitForRequest((r) => r.url().includes('/connection?refresh=1'));
    await indicator(page).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Проверить снова' }).click();
    await req;
  });

  test('время в поясе проекта при браузере в другом поясе', async ({ page }) => {
    await page.goto('/pay/demo');
    await expect(indicator(page)).toHaveAttribute('data-status', 'demo');
    await indicator(page).click();
    const time = page.getByRole('dialog').locator('time');
    const iso = await time.getAttribute('datetime');
    const expected = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Karachi', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso!));
    await expect(time).toContainText(expected);
    await time.hover();
    await expect(page.getByRole('tooltip')).toContainText('Asia/Karachi, UTC+05:00');
  });
});

test('строки меню шапки: одна высота 36px и один левый край, у меню проекта и заголовок', async ({ page }) => {
  await page.goto('/pay/demo');
  await expect(indicator(page)).toHaveAttribute('data-status', 'demo');
  // Размеры раскладки, а не прямоугольник: меню появляется с масштабом 95%.
  const rows = (selector: string) => page.locator(selector).evaluateAll((els) => els.map((el) => ({ left: (el as HTMLElement).offsetLeft, height: (el as HTMLElement).offsetHeight })));
  const expectSame = (seen: { left: number; height: number }[]) => {
    expect(seen.length).toBeGreaterThan(1);
    for (const r of seen) expect(r).toEqual({ left: seen[0]!.left, height: 36 });
  };

  await page.getByTestId('project-menu').click();
  expectSame(await rows('[data-testid=project-menu-content] > [role=menuitem], [data-testid=project-menu-current]'));
  await page.keyboard.press('Escape');

  await page.getByTestId('header-help').click();
  expectSame(await rows('[data-testid=help-menu-content] > [role=menuitem]'));
  await page.keyboard.press('Escape');

  // В профиле пункты — «Настройки сервиса» и «Проекты»: строки с переключателями пунктами не считаются.
  await page.getByTestId('auth-off').click();
  expectSame(await rows('[data-testid=user-menu-content] > [role=menuitem]'));
  await page.keyboard.press('Escape');

  await main(page).getByRole('combobox', { name: /^Среда:/ }).click();
  expectSame(await rows('[role=listbox] > [role=option]'));
});

test.describe('темы', () => {
  test('сохранённая тёмная тема без вспышки светлой', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('threadline.theme', 'dark');
      const seen: string[] = [];
      (window as unknown as { __firstPaint: string[] }).__firstPaint = seen;
      new MutationObserver((_m, obs) => {
        if (document.body) {
          seen.push(document.documentElement.className);
          obs.disconnect();
        }
      }).observe(document, { childList: true, subtree: true });
    });
    await page.goto('/pay/demo');
    const first = await page.evaluate(() => (window as unknown as { __firstPaint: string[] }).__firstPaint[0]);
    expect(first).toContain('dark');
  });

  test('выбор темы сохраняется', async ({ page }) => {
    await page.goto('/pay/demo');
    await pickTheme(page, 'Тёмная');
    await expect(page.locator('html')).toHaveClass(/dark/);
    await page.reload();
    await expect(page.locator('html')).toHaveClass(/dark/);
  });

  test('«как в системе» следует за системой без перезагрузки', async ({ page }) => {
    await page.goto('/pay/demo');
    await expect(page.locator('html')).not.toHaveClass(/dark/);
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveClass(/dark/);
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`доступность и контраст, ${scheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      for (const path of ['/pay/demo', '/pay/pr', '/pay/unauthorized', '/pay/prod']) {
        await page.goto(path);
        await expect(indicator(page)).not.toHaveAttribute('data-status', 'checking');
        const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
        expect(r.violations.map((v) => `${path}: ${v.id} ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
      }
    });
  }
});

test.describe('раскладка и доступ', () => {
  test('768px: без горизонтальной прокрутки, длинное название с многоточием и подсказкой', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    for (const path of ['/pay/long', '/pay/pr/105', '/cards/demo', '/pay/certificate']) {
      await page.goto(path);
      await expect(indicator(page)).not.toHaveAttribute('data-status', 'checking');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, path).toBeLessThanOrEqual(0);
      expect((await header(page).boundingBox())!.height, path).toBe(56);
    }
    await page.goto('/pay/long');
    const text = envSelect(page).locator('span.truncate');
    await expect.poll(() => text.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    await envSelect(page).hover();
    await expect(page.getByRole('tooltip')).toContainText('A very long environment name to check truncation with an ellipsis');
  });

  // 751 и 1007 — те же 768 и 1024 с местом под полосу прокрутки 17px.
  for (const [width, scheme] of [751, 768, 1007, 1023, 1024, 1279, 1280].flatMap((w) => (['light', 'dark'] as const).map((c) => [w, c] as const))) {
    test(`${width}px, ${scheme}: блок Threadline, «Справка» и профиль целиком, обрезаются только проект и среда, всё в одну строку`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width, height: 900 });
      const gutter = width < 1024 ? 16 : 24;
      for (const path of ['/pay/long', '/pay/pr/105', '/pay/long/requests/c1?from=1000&to=2000']) {
        await page.goto(path);
        await expect(page.getByTestId('auth-off')).toBeVisible();
        await expectHeaderFits(page, path);
        const side = 20;
        expect(await header(page).locator('nav img:visible').boundingBox(), path).toMatchObject({ width: side, height: side });
        const name = header(page).getByRole('link', { name: 'Threadline, на главную' }).getByText('Threadline', { exact: true });
        expect(await name.evaluate((el) => el.scrollWidth <= el.clientWidth && getComputedStyle(el).flexShrink === '0'), path).toBe(true);
        // «?» — квадрат 32px, профиль — круглая кнопка высотой 34px.
        expect(await helpButton(page).boundingBox(), path).toMatchObject({ width: 32, height: 32 });
        expect((await userButton(page).boundingBox())!.height, path).toBe(34);
        const actions = (await page.getByTestId('header-actions').boundingBox())!;
        expect(actions.x + actions.width, path).toBeLessThanOrEqual(width - gutter);
      }
    });
  }

  test('768px: «Demo Pay» целиком, среда и стенд читаются; длинное название проекта обрезано, целиком в подсказке', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 900 });
    await page.goto('/pay/pr/105');
    const projectText = (name: RegExp) => header(page).getByRole('button', { name }).locator('span.truncate');
    await expect.poll(() => projectText(/^Проект:/).evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await expect.poll(() => envSelect(page).locator('span.truncate').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await expect(main(page).getByRole('button', { name: 'Стенд: Стенд 105' })).toContainText('Стенд 105');
    await page.goto('/cards/demo');
    await expect.poll(() => projectText(/^Проект:/).evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    await expect(projectButton(page)).toBeEnabled();
    await projectButton(page).hover();
    await expect(page.getByRole('tooltip')).toContainText('Card processing, payment gateways and payouts of the demo group of companies');
  });

  test('загрузка страницы не сдвигает шапку и карточку поиска', async ({ page }) => {
    for (const width of [768, 1280, 1920]) {
      for (const scheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.setViewportSize({ width, height: 900 });
        await page.goto('/pay/demo');
        await expect(indicator(page)).toHaveAttribute('data-status', 'demo');
        // Сдвиги с начала загрузки страницы: источники внутри шапки и карточки поиска.
        const shifts = await page.evaluate(
          () =>
            new Promise<string[]>((resolve) => {
              const out: string[] = [];
              new PerformanceObserver((list) => {
                for (const e of list.getEntries() as unknown as { value: number; sources: { node: Node | null }[] }[]) {
                  for (const s of e.sources) {
                    const el = s.node instanceof Element ? s.node : (s.node?.parentElement ?? null);
                    if (el?.closest('header, [data-testid=search-panel]')) out.push(`${e.value.toFixed(5)} ${el.outerHTML.slice(0, 80)}`);
                  }
                }
              }).observe({ type: 'layout-shift', buffered: true });
              setTimeout(() => resolve(out), 100);
            }),
        );
        expect(shifts, `${width}px, ${scheme}`).toEqual([]);
      }
    }
  });

  test('2560px: данные во всю ширину, текст не растягивается шире удобной строки', async ({ page }) => {
    await page.setViewportSize({ width: 2560, height: 1440 });
    await page.goto('/pay/demo');
    // Узкой колонки посередине нет: поиск во всю ширину с полем страницы 24px.
    const content = await page.getByTestId('search-panel').boundingBox();
    const viewport = await page.evaluate(() => document.documentElement.clientWidth);
    expect(content!.x).toBe(24);
    expect(content!.width).toBe(viewport - 48);
    const para = await page.getByTestId('search-examples').getByText('Любое значение, которое попадает в логи').boundingBox();
    expect(para!.width).toBeLessThanOrEqual(720);
    // Края шапки и содержимого совпадают.
    const logo = await header(page).getByRole('link', { name: 'Threadline, на главную' }).boundingBox();
    expect(logo!.x).toBe(24);
  });

  test('основное действие синее, статусы своими цветами', async ({ page }) => {
    await page.goto('/pay/pr');
    const bg = await page.getByRole('main').getByRole('button', { name: 'Открыть' }).evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).toBe('rgb(0, 68, 173)');
    await page.goto('/pay/unauthorized');
    await expect(indicator(page)).toHaveAttribute('data-status', 'unauthorized');
    // Цвет меняется плавно: ждём конца перехода.
    await expect.poll(() => indicator(page).evaluate((el) => getComputedStyle(el).color)).toBe('rgb(180, 35, 24)');
  });

  test('600px: всё доступно', async ({ page }) => {
    await page.setViewportSize({ width: 600, height: 900 });
    await page.goto('/pay/demo');
    await expect(page.getByTestId('auth-off')).toBeVisible();
    await expect(indicator(page)).toBeVisible();
  });

  test('Tab проходит шапку по порядку', async ({ page }) => {
    await page.goto('/pay/pr/92');
    await expect(indicator(page)).toHaveAttribute('data-status', 'demo');
    await expect(page.getByTestId('auth-off')).toBeVisible();
    await expect(projectButton(page)).toBeEnabled();
    await expect(helpButton(page)).toBeEnabled();
    const names: string[] = [];
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Tab');
      names.push(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent ?? ''));
    }
    expect(names).toEqual([
      'Threadline, на главную',
      // Соседние наборы наполняют «Неизвестное»: за названием может идти счётчик для диктора.
      expect.stringMatching(/^Проект: Demo Pay/),
      'Справка',
      'Вход выключен',
      expect.stringMatching(/^Среда: PR stands/),
      'Стенд: Стенд 92',
    ]);
  });

  test('уменьшение анимации выключает переходы', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/pay/demo');
    const d = await page.getByTestId('header-help').evaluate((el) => getComputedStyle(el).transitionDuration);
    expect(parseFloat(d)).toBeLessThan(0.001);
  });
});

test.describe('состояния и сеть', () => {
  test('долгая загрузка показывает заготовку', async ({ page }) => {
    await page.route('**/api/projects', async (route) => {
      await new Promise((r) => setTimeout(r, 1200));
      await route.continue();
    });
    await page.goto('/pay/demo');
    await expect(page.getByTestId('page-skeleton').locator('[data-slot=skeleton]').first()).toBeVisible();
    await expect(indicator(page)).toBeVisible();
  });

  test('сервер Threadline недоступен', async ({ page }) => {
    await page.route('**/api/projects', (route) => route.abort('connectionrefused'));
    await page.goto('/pay/demo');
    await expect(page.getByRole('heading', { name: 'Сервер Threadline недоступен' })).toBeVisible({ timeout: 10_000 });
    // Кнопки проекта нет: «Справка» и профиль там же, где будут после ответа.
    await expect(projectButton(page)).toHaveCount(0);
    await expect(userButton(page)).toBeVisible();
    const help = await helpButton(page).boundingBox();
    const profile = await userButton(page).boundingBox();
    await page.unroute('**/api/projects');
    await page.getByRole('button', { name: 'Повторить' }).click();
    await expect(indicator(page)).toHaveAttribute('data-status', 'demo');
    expect((await helpButton(page).boundingBox())!.x).toBe(help!.x);
    expect((await userButton(page).boundingBox())!.x).toBe(profile!.x);
  });

  test('непредвиденная ошибка показывает экран с перезагрузкой', async ({ page }) => {
    await page.route('**/api/projects', (route) => route.fulfill({ json: { projects: null, defaults: { project: 'pay', environment: 'demo' } } }));
    await page.goto('/pay/demo');
    await expect(page.getByRole('heading', { name: 'Что-то пошло не так' })).toBeVisible();
    await page.unroute('**/api/projects');
    await page.getByRole('button', { name: 'Перезагрузить' }).click();
    await expect(page).toHaveURL(/\/pay\/demo$/);
    await expect(indicator(page)).toHaveAttribute('data-status', 'demo');
  });

  test('без интернета загружается полностью и не ходит на сторонние адреса', async ({ page, baseURL }) => {
    const foreign: string[] = [];
    await page.context().route('**/*', (route) => {
      const url = route.request().url();
      if (!url.startsWith(baseURL!)) {
        foreign.push(url);
        return route.abort('internetdisconnected');
      }
      return route.continue();
    });
    await page.goto('/pay/pr');
    await expect(indicator(page)).toHaveAttribute('data-status', 'demo');
    await page.getByRole('main').getByRole('button', { name: '92' }).click();
    await pickTheme(page, 'Тёмная');
    expect(await page.evaluate(async () => (await document.fonts.ready, document.fonts.check('14px "Inter Variable"')))).toBe(true);
    expect(await page.evaluate(() => [...document.fonts].some((f) => f.family.includes('Inter') && f.status === 'loaded'))).toBe(true);
    expect(foreign).toEqual([]);
  });
});

test.describe('шрифты', () => {
  test('ʻ в моноширинном блоке берётся из Inter, символ виден; в стеке JetBrains Mono, затем Inter', async ({ page }) => {
    await page.goto('/pay/demo');
    await expect(page.getByTestId('auth-off')).toBeVisible();
    const { stack, mono, inter } = await page.evaluate(async () => {
      const measure = (font: string) => {
        const el = document.createElement('span');
        el.textContent = 'ʻʻʻʻʻʻʻʻ';
        el.style.fontFamily = font;
        el.style.fontSize = '16px';
        document.body.append(el);
        const width = el.getBoundingClientRect().width;
        el.remove();
        return width;
      };
      const probe = document.createElement('span');
      probe.className = 'font-mono';
      document.body.append(probe);
      const family = getComputedStyle(probe).fontFamily;
      probe.remove();
      await document.fonts.load('16px "Inter Variable"', 'ʻ');
      await document.fonts.load('16px "JetBrains Mono"', 'ʻ');
      await document.fonts.ready;
      return { stack: family, mono: measure(family), inter: measure('"Inter Variable"') };
    });
    expect(stack).toMatch(/^"?JetBrains Mono"?, "?Inter Variable"?/);
    expect(mono).toBeGreaterThan(0);
    expect(mono).toBe(inter);
  });
});

test.describe('меню проекта', () => {
  test('пункты: текущий проект, «Поиск», «Справочник», «Настройки проекта», другие проекты, «Все проекты»; адреса верные', async ({ page }) => {
    await page.goto('/pay/demo');
    await openProjectMenu(page);
    await expect(page.getByTestId('project-menu-current')).toContainText('Demo Pay');
    await expect(page.getByTestId('header-to-search')).toHaveAttribute('href', '/pay/demo');
    await expect(page.getByTestId('header-to-search')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('header-catalog')).toHaveAttribute('href', '/pay/catalog');
    await expect(page.getByTestId('header-settings')).toHaveAttribute('href', '/pay/settings/main');
    await expect(page.getByTestId('header-projects')).toHaveAttribute('href', paths.projects);
    await expect(page.getByTestId('project-option')).toHaveCount(1);
    await expect(page.getByTestId('project-option')).toContainText('Card processing');
  });

  test('открытие меню не отправляет запросов к серверу', async ({ page }) => {
    await page.goto('/pay/demo');
    await expect(indicator(page)).toHaveAttribute('data-status', 'demo');
    await expect(projectButton(page)).toBeVisible();
    const asked: string[] = [];
    page.on('request', (r) => {
      if (new URL(r.url()).pathname.startsWith('/api/')) asked.push(r.url());
    });
    await openProjectMenu(page);
    await closeMenu(page);
    await openHelpMenu(page);
    await closeMenu(page);
    await openUserMenu(page);
    await closeMenu(page);
    expect(asked.filter((u) => !u.includes('/api/catalog') && !u.includes('/api/auth/me') && !u.includes('/logo/'))).toEqual([]);
  });

  test('клавиатура: Enter открывает, первым «Поиск», стрелки двигают, Escape возвращает на кнопку', async ({ page }) => {
    await page.goto('/pay/catalog');
    await expect(projectButton(page)).toBeEnabled();
    await projectButton(page).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('header-to-search')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId('header-catalog')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(projectButton(page)).toBeFocused();
  });

  test('на страницах зон проекта отмечен текущий пункт, другой проект открывается там же', async ({ page }) => {
    await page.goto('/pay/catalog');
    await openProjectMenu(page);
    await expect(page.getByTestId('header-catalog')).toHaveAttribute('aria-current', 'page');
    await page.getByTestId('project-option').click();
    await expect(page).toHaveURL(/\/cards\/catalog$/);
    await page.goto('/pay/settings/main');
    await openProjectMenu(page);
    await expect(page.getByTestId('header-settings')).toHaveAttribute('aria-current', 'page');
    await page.getByTestId('project-option').click();
    await expect(page).toHaveURL(/\/cards\/settings\/main$/);
  });

  test('зоны без проекта в адресе: кнопка показывает последний выбранный проект, полосы справочника нет', async ({ page }) => {
    await page.goto('/cards/demo');
    await expect(projectButton(page)).toContainText('Card processing');
    for (const path of [paths.projects, paths.status, '/docs', '/about', '/learn', '/credits']) {
      await page.goto(path);
      await expect(projectButton(page), path).toContainText('Card processing');
      await expect(page.getByTestId('catalog-banner'), path).toHaveCount(0);
    }
    await openProjectMenu(page);
    await expect(page.getByTestId('header-to-search')).toHaveAttribute('href', '/cards/demo');
  });

  test('проекты ещё загружаются: появление кнопки не сдвигает «Справку» и профиль', async ({ page }) => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route('**/api/projects', async (route) => {
      await gate;
      await route.continue();
    });
    await page.goto('/pay/demo');
    await expect(helpButton(page)).toBeVisible();
    await expect(userButton(page)).toBeVisible();
    await expect(projectButton(page)).toHaveCount(0);
    const before = await page.getByTestId('header-actions').boundingBox();
    release();
    await expect(projectButton(page)).toBeVisible();
    expect(await page.getByTestId('header-actions').boundingBox()).toEqual(before);
  });
});

test.describe('меню «Справка» и «Настройки сервиса»', () => {
  test('пять пунктов на текущем языке, версия у «О Threadline», клавиатура, титров нет', async ({ page }) => {
    await page.goto('/pay/demo');
    await expect(helpButton(page)).toBeEnabled();
    await helpButton(page).focus();
    await page.keyboard.press('Enter');
    const items = page.getByTestId('help-menu-content').getByRole('menuitem');
    await expect(items).toHaveText(['Документация', 'Обучение', /^О Threadline/, 'Горячие клавиши?', 'Сообщить о проблеме']);
    await expect(page.getByTestId('header-about').getByTestId('header-version')).toHaveText(/^версия \S+$/);
    await expect(items.first()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(items.nth(1)).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(helpButton(page)).toBeFocused();
    await expect(page.getByRole('link', { name: 'Титры' })).toHaveCount(0);
  });

  for (const [testId, path, title] of [
    ['header-docs', '/docs', null],
    ['header-learn', '/learn', null],
    ['header-about', '/about', 'Threadline'],
  ] as const) {
    test(`пункт ведёт на ${path}, значок отмечен`, async ({ page }) => {
      await page.goto('/pay/demo');
      await openHelpMenu(page);
      await page.getByTestId(testId).click();
      await expect(page).toHaveURL(new RegExp(`${path}(/|$)`));
      await expect(helpButton(page)).toHaveAttribute('aria-current', 'true');
      if (title) {
        await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
      }
    });
  }

  test('/credits открывается по адресу, ссылок на него нет', async ({ page }) => {
    await page.goto('/credits');
    await expect(page.getByRole('heading', { level: 1, name: 'Титры' })).toBeVisible();
    await openHelpMenu(page);
    await expect(page.locator('a[href="/credits"]')).toHaveCount(0);
  });

  test('«Настройки сервиса» в меню профиля ведут на /admin/status и отмечены, к хранилищу запросов нет', async ({ page }) => {
    await page.goto('/pay/demo');
    await expect(indicator(page)).toHaveAttribute('data-status', 'demo');
    const reads: string[] = [];
    page.on('request', (r) => {
      if (/\/(connection|probe|stands)/.test(r.url())) reads.push(r.url());
    });
    await goToService(page);
    await expect(page).toHaveURL(/\/admin\/status$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Настройки сервиса' })).toBeVisible();
    await expect(page.getByTestId('stores-list')).toBeVisible();
    await expect(page.getByTestId('settings-page')).toBeVisible();
    await openUserMenu(page);
    await expect(serviceLink(page)).toHaveAttribute('aria-current', 'page');
    await closeMenu(page);
    expect(reads).toEqual([]);
  });

  test('подсказки и подписи на текущем языке', async ({ page }) => {
    await page.goto('/pay/demo');
    await expect(helpButton(page)).toHaveAccessibleName('Справка');
    await expect(userButton(page)).toHaveAccessibleName('Вход выключен');
    await expect(helpButton(page)).toBeEnabled();
    await helpButton(page).hover();
    await expect(page.getByRole('tooltip')).toContainText('Справка');
    // Мышь уходит шагами, как рука: подсказка Radix держится, пока указатель идёт к ней.
    await page.mouse.move(700, 600, { steps: 8 });
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    // Пояснение про выключенный вход — в подсказке кнопки профиля.
    await userButton(page).hover();
    await expect(page.getByRole('tooltip')).toContainText('Вход выключен настройкой auth: off');
    await openUserMenu(page);
    await expect(serviceLink(page)).toHaveAccessibleName('Настройки сервиса');
    await closeMenu(page);
  });
});

// Страница состояния сервиса: «это у нас или в Grafana?». Настоящая Grafana в наборе не трогается, ответы проверки подменены.
test.describe('страница сервиса', () => {
  const probes = (page: Page) => {
    const sent: string[] = [];
    page.on('request', (r) => {
      if (r.url().endsWith('/probe')) sent.push(r.url());
    });
    return sent;
  };
  const answer = (page: Page, json: object, delay = 0) =>
    page.route('**/api/stores/*/probe', async (route) => {
      if (delay) await new Promise((r) => setTimeout(r, delay));
      await route.fulfill({ json: { checkedAt: '2026-11-05T09:30:12.000Z', ...json } }).catch(() => undefined);
    });

  test('открытие: список «Состояние», версия в меню «Справка», запросов проверки нет, час без нажатий тоже', async ({ page }) => {
    const sent = probes(page);
    await page.clock.install();
    await page.goto('/admin/status');
    await expect(main(page).getByRole('heading', { level: 1, name: 'Настройки сервиса' })).toBeVisible();
    const list = page.getByTestId('stores-list');
    await expect(list.getByTestId('store-row').first()).toBeVisible();
    // До проверки строка хранилища говорит «Не проверено», у хранилища без токена — какую переменную задать.
    await expect(list.locator('[data-store=demo]').getByTestId('row-status')).toHaveText('Не проверено');
    const grafana = list.locator('[data-store=grafana]');
    await expect(grafana.getByTestId('row-status')).toHaveText('Токен не задан');
    await expect(grafana).toContainText('Задайте переменную THREADLINE_E2E_TOKEN_NOT_SET и перезапустите сервис');
    // База и вход — строки того же списка.
    await expect(list.getByTestId('status-database')).toBeVisible();
    await expect(list.getByTestId('status-login').getByTestId('row-status')).toHaveText('Выключен');
    await expect(page.getByTestId('probe-result')).toHaveCount(0);
    await expect(page.getByTestId('stores-docs')).toHaveAttribute('href', '/docs/admin-grafana');
    // Версия — у пункта «О Threadline» меню «Справка».
    await openHelpMenu(page);
    await expect(page.getByTestId('header-version')).toHaveText(/^версия \S+$/);
    await closeMenu(page);
    await page.clock.fastForward('01:00:00');
    await page.getByTestId('status-login').click();
    expect(sent).toEqual([]);
  });

  test('успех: итог и время, ответ на вопрос страницы, ушёл один запрос; двойное нажатие тоже один', async ({ page }) => {
    await answer(page, { status: 'connected' }, 300);
    const sent = probes(page);
    await page.goto('/admin/status');
    const store = page.getByTestId('store-row').first();
    await store.getByTestId('store-probe').dblclick();
    await expect(store.getByTestId('store-probe')).toBeDisabled();
    await expect(store.getByTestId('probe-result')).toHaveAttribute('data-status', 'connected');
    await expect(store.getByTestId('row-status')).toHaveText('Работает');
    await expect(store.getByTestId('probe-result')).toHaveText(/^проверено в \d\d:\d\d$/);
    await expect(store.getByTestId('store-detail')).toHaveCount(0);
    await expect(page.getByTestId('service-verdict')).toContainText('работают');
    expect(sent).toHaveLength(1);
  });

  for (const [status, title, side] of [
    ['not-configured', 'Нет токена', 'у нас'],
    ['forbidden', 'Нет прав', 'у нас'],
    ['timeout', 'Тайм-аут', 'хранилища или сети'],
    ['overloaded', 'Хранилище перегружено', 'хранилища или сети'],
    ['limit', 'Лимит хранилища', 'хранилища или сети'],
  ] as const) {
    test(`${status}: итог в строке, другие строки не затронуты, повтора нет`, async ({ page }) => {
      await answer(page, { status, missingEnv: 'THREADLINE_X_TOKEN' });
      const sent = probes(page);
      await page.goto('/admin/status');
      const stores = page.getByTestId('store-row');
      await stores.first().getByTestId('store-probe').click();
      await expect(stores.first().getByTestId('probe-result')).toHaveAttribute('data-status', status);
      await expect(stores.first().getByTestId('row-status')).toHaveText(title);
      // Что сделать — под строкой, только у проверенного хранилища.
      await expect(stores.first().getByTestId('store-detail')).toBeVisible();
      await expect(page.getByTestId('service-verdict')).toContainText(side);
      await expect(stores.nth(1).getByTestId('probe-result')).toHaveCount(0);
      await expect(stores.nth(1).getByTestId('row-status')).toHaveText('Не проверено');
      await expect(stores.nth(1).getByTestId('store-detail')).toHaveCount(0);
      expect(sent).toHaveLength(1);
    });
  }

  test('уход со страницы: результат не сохранён, при возврате строка без результата', async ({ page }) => {
    await answer(page, { status: 'connected' });
    await page.goto('/admin/status');
    await page.getByTestId('store-probe').first().click();
    await expect(page.getByTestId('probe-result').first()).toBeVisible();
    await openHelpMenu(page);
    await page.getByTestId('header-docs').click();
    await expect(page).toHaveURL(/\/docs$/);
    await goToService(page);
    await expect(page.getByTestId('store-row').first()).toBeVisible();
    await expect(page.getByTestId('probe-result')).toHaveCount(0);
  });

  test('сервер не ответил на проверку: страница говорит, что проблема у нас', async ({ page }) => {
    await page.route('**/api/stores/*/probe', (route) => route.abort('connectionrefused'));
    await page.goto('/admin/status');
    await page.getByTestId('store-probe').first().click();
    await expect(page.getByTestId('service-verdict')).toContainText('Сервер Threadline не ответил');
  });

  test('база недоступна, данные не загрузились, заготовка без скачка, хранилищ нет', async ({ page }) => {
    const change = (over: object) =>
      page.route('**/api/project-settings', async (route) => {
        const res = await route.fetch();
        await route.fulfill({ response: res, json: { ...((await res.json()) as object), ...over } });
      });
    await change({ state: 'stale', editable: false, message: 'база справочника недоступна', loadedAt: Date.UTC(2026, 10, 5, 7, 0) });
    await page.goto('/admin/status');
    await expect(page.getByTestId('status-database').getByTestId('row-status')).toHaveText('Недоступна');
    await expect(page.getByTestId('projects-source')).toContainText('база справочника недоступна');
    await expect(page.getByTestId('stores-list')).toBeVisible();
    await page.unroute('**/api/project-settings');

    await change({ stores: [] });
    await page.goto('/admin/status');
    await expect(page.getByTestId('stores-empty')).toContainText('backends');
    await page.unroute('**/api/project-settings');

    await page.route('**/api/project-settings', (route) => route.fulfill({ status: 500, json: { error: { code: 'unknown' } } }));
    await page.goto('/admin/status');
    await expect(page.getByRole('heading', { name: 'Состояние сервиса не загрузилось' })).toBeVisible();
    // Шапка работает: «Настройки сервиса» в меню профиля на месте.
    await openUserMenu(page);
    await expect(serviceLink(page)).toBeVisible();
    await closeMenu(page);
    await page.unroute('**/api/project-settings');
    await page.getByRole('button', { name: 'Повторить' }).click();
    await expect(page.getByTestId('service-page')).toBeVisible();

    await page.route('**/api/project-settings', async (route) => {
      await new Promise((r) => setTimeout(r, 1200));
      await route.fallback();
    });
    await page.goto('/admin/status');
    const skeleton = page.getByTestId('page-skeleton').locator('[data-slot=skeleton]').first();
    await expect(skeleton).toBeVisible();
    const top = (await skeleton.boundingBox())!.y;
    await expect(page.getByTestId('service-page')).toBeVisible();
    expect((await main(page).getByRole('heading', { level: 1 }).boundingBox())!.y).toBe(top);
  });

  test('семь ширин: без горизонтальной прокрутки при результатах проверки и длинном имени', async ({ page }) => {
    await answer(page, { status: 'timeout', details: 'x'.repeat(300) });
    await page.route('**/api/project-settings', async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as { stores: { id: string }[] };
      body.stores = body.stores.map((s, i) => (i === 0 ? { ...s, id: 'long-store-name-'.repeat(6) } : s));
      await route.fulfill({ response: res, json: body });
    });
    await page.goto('/admin/status');
    await page.getByTestId('store-probe').first().click();
    await expect(page.getByTestId('probe-result').first()).toBeVisible();
    for (const width of [768, 1024, 1280, 1440, 1536, 1920, 2560]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), `${width}px`).toBeLessThanOrEqual(0);
    }
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`доступность, ${scheme}`, async ({ page }) => {
      await answer(page, { status: 'connected' });
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto('/admin/status');
      await page.getByTestId('store-probe').first().click();
      await expect(page.getByTestId('probe-result').first()).toBeVisible();
      const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
      expect(r.violations.map((v) => `${v.id} ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
    });
  }
});

test.describe('меню профиля при выключенном входе', () => {
  test('кнопка с меткой; в меню пояснение, режим, язык, тема и страницы администратора, «Выйти» нет', async ({ page }) => {
    await page.goto('/pay/demo');
    const button = page.getByTestId('auth-off');
    await expect(button).toHaveAccessibleName('Вход выключен');
    await expect(button.getByTestId('auth-off-mark')).toBeVisible();
    // Надписи «Вход выключен» в шапке нет: янтарная метка и подпись для диктора.
    await expect(header(page).getByText('Вход выключен')).toHaveCount(0);
    await openUserMenu(page);
    await expect(page.getByTestId('user-menu-name')).toHaveText('Вход выключен');
    await expect(page.getByTestId('user-menu-role')).toHaveText('У всех права администратора, кроме показа номеров карт и секретов');
    await expect(userMenu(page).getByTestId('detail-switch').getByRole('menuitemradio')).toHaveText(['Подробно', 'Кратко']);
    await expect(languageItem(page, 'Русский')).toHaveAttribute('aria-checked', 'true');
    await expect(themeItem(page, 'Как в системе')).toHaveAttribute('aria-checked', 'true');
    await expect(serviceLink(page)).toHaveAttribute('href', '/admin/status');
    await expect(page.getByTestId('user-menu-projects')).toHaveAttribute('href', '/admin/projects');
    await expect(page.getByTestId('user-menu-logout')).toHaveCount(0);
  });

  test('с клавиатуры: Enter, стрелки идут по переключателям, выбор меню не закрывает, Escape возвращает фокус', async ({ page }) => {
    await page.goto('/pay/demo');
    await page.getByTestId('auth-off').focus();
    await page.keyboard.press('Enter');
    const mode = userMenu(page).getByTestId('detail-switch').getByRole('menuitemradio');
    await expect(mode.first()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(mode.nth(1)).toBeFocused();
    // Дальше «Русский», «English», затем тема: «Как в системе», «Светлая», «Тёмная». Radix переводит фокус после нажатия: ждём его на каждом шаге.
    const order = [languageItem(page, 'Русский'), languageItem(page, 'English'), themeItem(page, 'Как в системе'), themeItem(page, 'Светлая'), themeItem(page, 'Тёмная')];
    for (const item of order) {
      await page.keyboard.press('ArrowDown');
      await expect(item).toBeFocused();
    }
    await page.keyboard.press('Enter');
    await expect(page.locator('html')).toHaveClass(/dark/);
    await expect(themeItem(page, 'Тёмная')).toHaveAttribute('aria-checked', 'true');
    await expect(userMenu(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(page.getByTestId('auth-off')).toBeFocused();
  });
});

test.describe('перенаправления со старых адресов', () => {
  for (const [from, to] of [
    ['/projects', /\/admin\/projects$/],
    ['/projects/new', /\/admin\/projects\/new$/],
    ['/projects/pay', /\/pay\/settings\/main$/],
    ['/projects/pay?tab=view', /\/pay\/settings\/view$/],
    ['/projects/pay?tab=foo', /\/pay\/settings\/main$/],
    ['/projects/pay?tab=view&x=1', /\/pay\/settings\/view\?x=1$/],
    ['/settings', /\/admin\/status#settings$/],
    ['/admin/settings', /\/admin\/status#settings$/],
    ['/admin', /\/admin\/projects$/],
    ['/pay/catalog/masking', /\/pay\/settings\/masks$/],
    ['/pay/catalog/system-ledger', /\/pay\/catalog\/systems\/ledger$/],
    ['/pay/catalog/system-ledger?tab=errors', /\/pay\/catalog\/systems\/ledger\?tab=errors$/],
    ['/pay/settings', /\/pay\/settings\/main$/],
  ] as const) {
    test(`${from} → ${to.source}`, async ({ page }) => {
      await page.goto(from);
      await expect(page).toHaveURL(to);
    });
  }

  test('новые адреса открывают свои страницы', async ({ page }) => {
    await page.goto('/pay/settings/masks');
    await expect(page.getByTestId('catalog-page')).toBeVisible();
    await page.goto('/pay/catalog/systems/ledger');
    await expect(page.getByTestId('catalog-section')).toBeVisible();
    await page.goto('/pay/settings/view');
    await expect(page.getByTestId('project-form')).toBeVisible();
    await page.goto('/pay/settings/environments');
    await expect(page.getByTestId('project-form')).toBeVisible();
    await page.goto('/pay/settings/nope');
    await expect(page.getByRole('heading', { name: 'Такой страницы нет' })).toBeVisible();
    await page.goto('/admin/nope');
    await expect(page.getByRole('heading', { name: 'Такой страницы нет' })).toBeVisible();
  });

  test('/projects/nope: страница сообщает, что такого проекта нет, и ведёт к списку', async ({ page }) => {
    await page.goto('/projects/nope');
    await expect(page).toHaveURL(/\/nope\/settings\/main$/);
    await expect(page.getByRole('heading', { name: 'Такого проекта нет' })).toBeVisible();
    await page.getByRole('main').getByRole('link').first().click();
    await expect(page).toHaveURL(/\/admin\/projects$/);
  });

  test('«назад» с перенаправления ведёт на страницу, откуда пришли, а не на старый адрес', async ({ page }) => {
    await page.goto('/pay/demo');
    await expect(projectButton(page)).toBeVisible();
    await page.evaluate(() => {
      window.history.pushState({}, '', '/projects/pay');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect(page).toHaveURL(/\/pay\/settings\/main$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/pay\/demo$/);
  });
});
