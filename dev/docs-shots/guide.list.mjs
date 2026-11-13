// Снимки раздела «Как пользоваться» (content/ru/docs/guide-*.md). Только демо-среда и её синтетические записи.
// Формат списка: dev/docs-shots/README.md. Цифры на снимках ставит mark: текст страницы объясняет их по номерам.
import { search } from './helpers.mjs';

const DEMO = '/pay/demo';
const CARD = '4111111234557893';
const TRANSFER = '5b0e6c3a-2f4d-4a71-9c8e-1d2f3a4b5c6d';
const SUPPORT = { path: DEMO, role: 'support' };
const ROW_HIT = { position: { x: 8, y: 8 } };

const rows = (page) => page.getByRole('list', { name: 'Найденные запросы' }).getByRole('listitem');

/** Цифры на снимке: [элемент, подпись, сторона, сдвиг]. Сторона: left, right, top, below, tl, tr. Сдвиг: [x, y]. Круг стоит поверх страницы и ничего в ней не двигает. */
export async function mark(page, items) {
  for (const [target, label, side = 'tl', [dx, dy] = [0, 0]] of items) {
    const box = await target.first().boundingBox();
    if (!box) throw new Error(`mark: не виден элемент для цифры ${label}`);
    const r = 13;
    const place = {
      left: [box.x - r - 2, box.y + box.height / 2 - r],
      right: [box.x + box.width - r + 2, box.y + box.height / 2 - r],
      top: [box.x + box.width / 2 - r, box.y - r - 2],
      below: [box.x + box.width / 2 - r, box.y + box.height - r + 2],
      tl: [box.x - r + 2, box.y - r + 2],
      tr: [box.x + box.width - r - 2, box.y - r + 2],
    }[side];
    await page.evaluate(
      ({ label, x, y, size }) => {
        const el = document.createElement('div');
        el.textContent = label;
        Object.assign(el.style, {
          position: 'fixed',
          left: `${x}px`,
          top: `${y}px`,
          width: `${size}px`,
          height: `${size}px`,
          zIndex: '2147483000',
          borderRadius: '50%',
          background: '#7c3aed',
          color: '#fff',
          font: '700 14px/26px Inter, sans-serif',
          textAlign: 'center',
          boxShadow: '0 0 0 2px #fff',
          pointerEvents: 'none',
        });
        document.body.appendChild(el);
      },
      { label, x: place[0] + dx, y: place[1] + dy, size: r * 2 },
    );
  }
}

/** Поиск в демо-среде и переход в строку с этим текстом. Ждёт схему: на снимке страница уже собрана. */
export async function openRow(page, terms, text) {
  await search(page, terms);
  const found = text ? rows(page).filter({ hasText: text }) : rows(page);
  await found.first().locator('[data-row-link]').click(ROW_HIT);
  await page.getByTestId('request-header').waitFor();
  await page.getByTestId('flow-canvas').waitFor();
  await page.waitForTimeout(600);
}

/** Запрос глазами Бизнеса: своего экрана со схемой у него нет. */
export async function openBusinessRow(page, terms, text) {
  await search(page, terms);
  await rows(page).filter({ hasText: text }).first().locator('[data-row-link]').click(ROW_HIT);
  await page.getByTestId('business-steps').waitFor();
  await page.waitForTimeout(300);
}

export const openCardNotFound = (page) => openRow(page, ['getCard'], 'Card not found');
export const openInsufficient = (page) => openRow(page, ['ledger.pay.example'], "Not enough money in the customer's account");
const stepDetails = (page) => page.getByTestId('step-details');
const nodes = (page) => page.locator('button[data-node]');

export async function openTransfer(page) {
  await openRow(page, [TRANSFER], 'Payout network callback');
  await page.getByTestId('open-operation').click();
  await page.locator('[data-testid="operation-page"][data-status="done"]').waitFor({ timeout: 40_000 });
  await page.waitForTimeout(400);
}

export default [
  // ---- guide-start
  {
    name: 'guide-start-screen',
    ...SUPPORT,
    viewport: { width: 1280, height: 470 },
    async actions(page) {
      await page.getByTestId('search-example').first().waitFor();
      await mark(page, [
        [page.getByTestId('project-menu'), '1', 'right', [10, 0]],
        [page.getByTestId('header-help'), '2', 'below', [0, 6]],
        [page.getByTestId('user-menu'), '3', 'below', [0, 6]],
        [page.getByTestId('search-panel').getByRole('combobox').first(), '4', 'below', [0, 8]],
        [page.getByRole('textbox', { name: 'Значения для поиска' }), '5', 'below', [0, 8]],
        [page.getByRole('group', { name: 'Период' }), '6', 'below', [0, 8]],
        [page.getByRole('button', { name: 'Найти', exact: true }), '7', 'below', [0, 8]],
        [page.getByTestId('search-examples-try').locator('p').first(), '8', 'right', [16, 0]],
      ]);
    },
  },
  {
    name: 'guide-start-search',
    ...SUPPORT,
    viewport: { width: 1280, height: 400 },
    async actions(page) {
      const input = page.getByRole('textbox', { name: 'Значения для поиска' });
      await input.fill('getCard');
      await input.press('Enter');
      await page.getByRole('group', { name: 'Период' }).getByRole('button', { name: '24 ч', exact: true }).click();
    },
    crop: (page) => page.getByTestId('search-panel'),
  },
  {
    name: 'guide-start-results',
    ...SUPPORT,
    viewport: { width: 1280, height: 520 },
    async actions(page) {
      await search(page, ['getCard']);
    },
    crop: (page) => page.getByTestId('search-results'),
  },
  {
    name: 'guide-start-request',
    ...SUPPORT,
    viewport: { width: 1280, height: 720 },
    actions: openCardNotFound,
  },

  // ---- guide-search
  {
    name: 'guide-search-values',
    ...SUPPORT,
    viewport: { width: 1280, height: 400 },
    async actions(page) {
      const input = page.getByRole('textbox', { name: 'Значения для поиска' });
      for (const value of [CARD, 'getCard', '+44 7700 900101']) {
        await input.fill(value);
        await input.press('Enter');
      }
    },
    crop: (page) => page.getByTestId('search-panel'),
  },
  {
    name: 'guide-search-env',
    ...SUPPORT,
    viewport: { width: 1280, height: 460 },
    async actions(page) {
      await page.getByTestId('search-panel').getByRole('combobox').first().click();
      await page.waitForTimeout(300);
    },
    crop: (page) => page.getByRole('dialog').first(),
    pad: 12,
  },
  {
    name: 'guide-search-period',
    ...SUPPORT,
    viewport: { width: 1280, height: 640 },
    async actions(page) {
      await page.getByRole('group', { name: 'Период' }).getByRole('button', { name: 'Свой' }).click();
      const dialog = page.getByRole('dialog').first();
      await dialog.getByText('Вокруг времени').click();
      await dialog.getByLabel('Время', { exact: true }).fill('10:30');
      await page.waitForTimeout(300);
    },
    crop: (page) => page.getByRole('dialog').first(),
    pad: 12,
  },
  {
    name: 'guide-search-exclude',
    ...SUPPORT,
    viewport: { width: 1280, height: 400 },
    async actions(page) {
      const input = page.getByRole('textbox', { name: 'Значения для поиска' });
      await input.fill('getCard');
      await input.press('Enter');
      await page.getByRole('button', { name: 'Уточнить' }).click();
      const exclude = page.getByLabel('Не содержит');
      await exclude.fill('Card not found');
      await exclude.press('Enter');
    },
    crop: (page) => page.getByTestId('search-panel'),
  },
  {
    name: 'guide-search-filters',
    ...SUPPORT,
    viewport: { width: 1280, height: 520 },
    async actions(page) {
      await search(page, ['ledger.pay.example']);
      await page.getByTestId('filters-toggle').click();
      await page.waitForTimeout(200);
      const popup = page.getByRole('group', { name: 'Фильтры результатов' });
      await popup.getByRole('combobox').first().click();
      await page.getByRole('option').nth(1).click();
      await page.waitForTimeout(300);
    },
    crop: (page) => page.getByTestId('search-results'),
  },
  {
    name: 'guide-search-empty',
    ...SUPPORT,
    viewport: { width: 1280, height: 400 },
    async actions(page) {
      await search(page, ['nothing-here-zzz'], '1 ч');
    },
    crop: (page) => page.getByTestId('search-results'),
  },
  {
    name: 'guide-search-lines',
    ...SUPPORT,
    viewport: { width: 1280, height: 460 },
    async actions(page) {
      await search(page, ['getCard']);
      await page.getByRole('tab', { name: /Все записи/ }).click();
      await page.getByTestId('lines').waitFor();
      await page.waitForTimeout(400);
    },
  },

  // ---- guide-request
  {
    name: 'guide-request-page',
    ...SUPPORT,
    viewport: { width: 1280, height: 760 },
    async actions(page) {
      await openInsufficient(page);
      // «Что делать» и чья ошибка видны в раскрытой полосе причин.
      await page.getByTestId('reasons-more').click();
      await page.getByTestId('reason-action').waitFor();
      await mark(page, [
        [page.getByTestId('request-header').getByTestId('param-chip').first(), '1', 'right', [6, 0]],
        [page.getByTestId('request-chain'), '2', 'left', [-11, 0]],
        [page.getByTestId('request-reasons'), '3', 'left', [-6, -16]],
        [page.getByTestId('request-total'), '4', 'right', [2, 0]],
        [page.getByTestId('reason-action'), '5', 'left', [-8, 0]],
      ]);
    },
  },
  {
    name: 'guide-request-scheme',
    ...SUPPORT,
    viewport: { width: 1440, height: 760 },
    actions: openCardNotFound,
    crop: (page) => page.getByTestId('flow-canvas'),
  },
  {
    name: 'guide-request-retries',
    ...SUPPORT,
    viewport: { width: 1440, height: 900 },
    async actions(page) {
      await openRow(page, ['retrying']);
    },
    crop: (page) => page.getByTestId('trace-scheme'),
  },
  {
    name: 'guide-request-attempts',
    ...SUPPORT,
    viewport: { width: 1440, height: 900 },
    async actions(page) {
      await openRow(page, ['retrying']);
    },
    crop: (page) => page.getByTestId('step-attempts'),
    pad: 8,
  },
  {
    name: 'guide-request-parallel',
    ...SUPPORT,
    viewport: { width: 1440, height: 760 },
    async actions(page) {
      await openRow(page, ['v1/cards/limits']);
    },
    crop: (page) => page.getByTestId('flow-canvas'),
  },
  {
    name: 'guide-request-zoom',
    ...SUPPORT,
    viewport: { width: 1280, height: 720 },
    actions: openCardNotFound,
    crop: (page) => page.getByTestId('flow-zoom'),
    pad: 6,
  },
  {
    name: 'guide-request-panel',
    ...SUPPORT,
    viewport: { width: 1440, height: 900 },
    async actions(page) {
      await openInsufficient(page);
      await mark(page, [
        [page.getByTestId('panel-collapse'), '1', 'tl'],
        [page.getByTestId('step-outcome'), '2', 'tl'],
        [page.getByTestId('step-data'), '3', 'tl'],
        [page.getByTestId('copy-curl'), '4', 'tl'],
      ]);
    },
    crop: (page) => stepDetails(page),
    pad: 14,
  },
  {
    name: 'guide-request-window',
    ...SUPPORT,
    viewport: { width: 1280, height: 720 },
    async actions(page) {
      await openInsufficient(page);
      await page.locator('[data-testid="data-row"][data-item="response"]').first().click();
      await page.getByTestId('viewer-title').waitFor();
      await page.waitForTimeout(500);
    },
  },
  {
    name: 'guide-request-collapsed',
    ...SUPPORT,
    viewport: { width: 1280, height: 620 },
    async actions(page) {
      await openCardNotFound(page);
      await page.getByTestId('panel-collapse').click();
      await page.waitForTimeout(600);
    },
  },
  {
    name: 'guide-request-timeline',
    ...SUPPORT,
    viewport: { width: 1280, height: 620 },
    async actions(page) {
      await openCardNotFound(page);
      await page.getByRole('tab', { name: 'Шкала времени' }).click();
      await page.waitForTimeout(400);
    },
  },
  {
    name: 'guide-request-records',
    ...SUPPORT,
    viewport: { width: 1280, height: 720 },
    async actions(page) {
      await openCardNotFound(page);
      await page.getByRole('tab', { name: /Записи/ }).first().click();
      await page.waitForTimeout(400);
    },
  },

  // ---- guide-operation
  {
    name: 'guide-operation-button',
    ...SUPPORT,
    viewport: { width: 1280, height: 720 },
    async actions(page) {
      await openRow(page, [TRANSFER], 'Payout network callback');
    },
    crop: (page) => page.getByTestId('request-header'),
  },
  {
    name: 'guide-operation-page',
    ...SUPPORT,
    viewport: { width: 1280, height: 820 },
    async actions(page) {
      await openTransfer(page);
      await mark(page, [
        [page.getByTestId('operation-outcome'), '1', 'left', [-8, 0]],
        [page.getByTestId('operation-summary'), '2', 'left', [-8, 0]],
        [page.getByText('Ход операции', { exact: true }), '3', 'left', [-8, 0]],
        [page.getByText(/^Запросы операции/), '4', 'left', [-8, 0]],
        [page.getByText('±3 ч', { exact: true }), '5', 'below', [12, 8]],
      ]);
    },
  },
  {
    name: 'guide-operation-row',
    ...SUPPORT,
    viewport: { width: 1280, height: 760 },
    async actions(page) {
      await openTransfer(page);
      await page.getByTestId('operation-flows').getByRole('button', { name: /Показать шаги запроса/ }).nth(1).click();
      await page.waitForTimeout(1200);
    },
    crop: (page) => page.getByTestId('operation-flows'),
  },

  // ---- guide-share
  {
    name: 'guide-share-menu',
    ...SUPPORT,
    viewport: { width: 1280, height: 720 },
    async actions(page) {
      await openCardNotFound(page);
      await page.getByTestId('share-button').first().click();
      await page.waitForTimeout(300);
    },
    crop: (page) => page.getByRole('menu').first(),
    pad: 10,
  },
  {
    name: 'guide-share-open',
    ...SUPPORT,
    viewport: { width: 1280, height: 720 },
    async actions(page) {
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
      await openCardNotFound(page);
      await page.getByTestId('share-button').first().click();
      await page.getByRole('menuitem', { name: 'Короткая ссылка' }).click();
      await page.waitForTimeout(600);
      const link = await page.evaluate(() => navigator.clipboard.readText());
      await page.goto(link);
      await page.getByTestId('flow-canvas').waitFor();
      await page.waitForTimeout(800);
    },
  },

  // ---- guide-roles
  {
    name: 'guide-roles-menu',
    ...SUPPORT,
    viewport: { width: 1280, height: 360 },
    async actions(page) {
      await page.getByTestId('user-menu').click();
      await page.waitForTimeout(300);
    },
    crop: (page) => page.getByTestId('user-menu-content'),
    pad: 10,
  },
  // У Бизнеса свой экран запроса, без схемы.
  {
    name: 'guide-roles-business',
    path: DEMO,
    role: 'business',
    viewport: { width: 1280, height: 720 },
    async actions(page) {
      await openBusinessRow(page, ['getCard'], 'ответила ошибкой');
    },
  },
  {
    name: 'guide-roles-mask',
    ...SUPPORT,
    viewport: { width: 1440, height: 900 },
    async actions(page) {
      await openRow(page, [CARD], /Получение|lookup/);
      await nodes(page).nth(3).click();
      await stepDetails(page).locator('[data-testid="data-row"][data-item="request"]').waitFor();
      await page.waitForTimeout(300);
    },
    crop: (page) => stepDetails(page),
    pad: 8,
  },
  {
    name: 'guide-roles-open',
    ...SUPPORT,
    viewport: { width: 1440, height: 900 },
    async actions(page) {
      await openRow(page, [CARD], /Получение|lookup/);
      await nodes(page).nth(3).click();
      await stepDetails(page).locator('[data-testid="data-row"][data-item="request"]').waitFor();
      await page.waitForTimeout(300);
      await page.getByTestId('reveal-button').click();
      await page.waitForTimeout(800);
    },
    crop: (page) => stepDetails(page),
    pad: 8,
  },
  {
    name: 'guide-roles-hint',
    ...SUPPORT,
    viewport: { width: 1280, height: 280 },
    async actions(page) {
      await openRow(page, [CARD], /Получение|lookup/);
      await page.getByTestId('reveal-button').hover();
      await page.getByRole('tooltip').first().waitFor();
      await page.waitForTimeout(200);
    },
  },

  // ---- guide-modes
  {
    name: 'guide-modes-full',
    ...SUPPORT,
    viewport: { width: 1280, height: 460 },
    async actions(page) {
      await search(page, ['getCard']);
      // Режим показа — строка меню профиля: выбрать и закрыть меню.
      await page.getByTestId('user-menu').click();
      await page.getByTestId('user-menu-content').getByTestId('detail-switch').getByRole('menuitemradio', { name: 'Подробно' }).click();
      await page.keyboard.press('Escape');
      // Меню закрыто клавишей: фокус и указатель остались на кнопке профиля, её рамка на снимке не нужна.
      await page.waitForTimeout(200);
      await page.evaluate(() => document.activeElement?.blur());
      await page.mouse.move(640, 700);
    },
    crop: (page) => page.getByTestId('search-results'),
  },
  {
    name: 'guide-modes-brief',
    ...SUPPORT,
    viewport: { width: 1280, height: 460 },
    async actions(page) {
      await search(page, ['getCard']);
      // Режим показа — строка меню профиля: выбрать и закрыть меню.
      await page.getByTestId('user-menu').click();
      await page.getByTestId('user-menu-content').getByTestId('detail-switch').getByRole('menuitemradio', { name: 'Кратко' }).click();
      await page.keyboard.press('Escape');
      // Меню закрыто клавишей: фокус и указатель остались на кнопке профиля, её рамка на снимке не нужна.
      await page.waitForTimeout(200);
      await page.evaluate(() => document.activeElement?.blur());
      await page.mouse.move(640, 700);
    },
    crop: (page) => page.getByTestId('search-results'),
  },
  {
    name: 'guide-modes-language',
    ...SUPPORT,
    viewport: { width: 900, height: 300 },
    async actions(page) {
      // Режим показа, язык и тема — строки меню профиля.
      await page.getByTestId('user-menu').click();
      await page.getByTestId('user-menu-content').getByTestId('language-switch').waitFor();
      await page.waitForTimeout(300);
    },
  },
  {
    name: 'guide-modes-dark',
    ...SUPPORT,
    viewport: { width: 1280, height: 640 },
    async actions(page) {
      await page.evaluate(() => localStorage.setItem('threadline.theme', 'dark'));
      await openCardNotFound(page);
      await page.evaluate(() => {
        document.documentElement.classList.add('dark');
        document.documentElement.setAttribute('data-theme', 'dark');
      });
      await page.waitForTimeout(300);
    },
  },

  // ---- guide-catalog
  {
    name: 'guide-catalog-page',
    path: '/pay/catalog',
    role: 'support',
    viewport: { width: 1280, height: 520 },
  },
  {
    name: 'guide-catalog-unknown',
    ...SUPPORT,
    viewport: { width: 1280, height: 560 },
    async actions(page) {
      await search(page, ['ledger.pay.example']);
      await page.goto('/pay/catalog/unknown');
      await page.getByText('Что сервис встретил').waitFor();
      await page.getByRole('button', { name: 'Ошибки', exact: true }).click();
      await page.waitForTimeout(500);
    },
  },
  {
    name: 'guide-catalog-form',
    ...SUPPORT,
    viewport: { width: 1280, height: 860 },
    async actions(page) {
      await openRow(page, ['ledger.pay.example'], 'Данные не приняты');
      await stepDetails(page).getByRole('button', { name: /Добавить в справочник/ }).click();
      const form = page.getByRole('dialog').first();
      await form.getByLabel('Текст ошибки').fill('Платёжная система не приняла данные платежа');
      await form.getByLabel(/Что делать/).fill('Проверьте сумму и реквизиты. Если всё верно, передайте ссылку в поддержку платёжной системы.');
      await page.waitForTimeout(300);
      await mark(page, [
        [form.getByRole('combobox').first(), '1', 'tr'],
        [form.getByLabel('Текст ошибки'), '2', 'tr'],
        [form.getByLabel(/Что делать/), '3', 'tr'],
        [form.getByRole('button', { name: 'Сохранить' }), '4', 'tr'],
      ]);
    },
    crop: (page) => page.getByRole('dialog').first(),
  },
  {
    name: 'guide-catalog-before',
    ...SUPPORT,
    viewport: { width: 1280, height: 720 },
    async actions(page) {
      await openRow(page, ['ledger.pay.example'], 'Данные не приняты');
    },
    crop: (page) => page.getByTestId('request-reasons'),
    pad: 8,
  },
  {
    name: 'guide-catalog-after',
    ...SUPPORT,
    viewport: { width: 1280, height: 720 },
    async actions(page) {
      await openRow(page, ['ledger.pay.example'], 'Данные не приняты');
      await stepDetails(page).getByRole('button', { name: /Добавить в справочник/ }).click();
      const form = page.getByRole('dialog').first();
      await form.getByLabel('Текст ошибки').fill('Платёжная система не приняла данные платежа');
      await form.getByLabel(/Что делать/).fill('Проверьте сумму и реквизиты. Если всё верно, передайте ссылку в поддержку платёжной системы.');
      await form.getByRole('button', { name: 'Сохранить' }).click();
      await page.getByTestId('step-action').waitFor();
      await page.waitForTimeout(500);
    },
    crop: (page) => page.getByTestId('request-reasons'),
    pad: 8,
  },
  {
    name: 'guide-catalog-general',
    ...SUPPORT,
    viewport: { width: 1280, height: 720 },
    async actions(page) {
      await openCardNotFound(page);
      await stepDetails(page).getByRole('button', { name: /Добавить в справочник/ }).click();
      const form = page.getByRole('dialog').first();
      await form.getByRole('combobox').first().click();
      await page.getByRole('option', { name: 'Общие правила' }).click();
      await page.waitForTimeout(300);
    },
    crop: (page) => page.getByRole('dialog').first(),
  },

  // ---- guide-status
  {
    name: 'guide-status-service',
    path: '/admin/status',
    role: 'support',
    viewport: { width: 1280, height: 520 },
    async actions(page) {
      await page.getByRole('button', { name: 'Проверить' }).first().click();
      await page.waitForTimeout(600);
    },
  },
  {
    name: 'guide-status-report',
    ...SUPPORT,
    viewport: { width: 1280, height: 620 },
    async actions(page) {
      await page.getByTestId('header-help').click();
      await page.getByRole('menuitem', { name: 'Сообщить о проблеме' }).click();
      await page.waitForTimeout(500);
    },
    crop: (page) => page.getByRole('dialog').first(),
    pad: 10,
  },
];
