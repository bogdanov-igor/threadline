// Снимки уроков (content/ru/learn/*.md): по снимку на шаг. Только демо-среда и её синтетические записи.
// Перезапись справочника и файл проекта идут в конце списка: это меняет данные прогона для следующих снимков.
import { search } from './helpers.mjs';
import { mark, openBusinessRow, openInsufficient, openRow, openTransfer } from './guide.list.mjs';

const DEMO = '/pay/demo';
const CARD = '4111111234557893';
const TRANSFER = '5b0e6c3a-2f4d-4a71-9c8e-1d2f3a4b5c6d';
const SUPPORT = { path: DEMO, role: 'support' };
const ROW_HIT = { position: { x: 8, y: 8 } };

const rows = (page) => page.getByRole('list', { name: 'Найденные запросы' }).getByRole('listitem');
const stepDetails = (page) => page.getByTestId('step-details');
const nodes = (page) => page.locator('button[data-node]');
const panel = (page) => page.getByTestId('search-panel');
const field = (page) => page.getByRole('textbox', { name: 'Значения для поиска' });

/** ID запроса с этим текстом в строке: для урока «по ID» значение берётся из самих данных. */
async function requestId(page, term, text) {
  await search(page, [term]);
  const id = await rows(page).filter({ hasText: text }).first().getAttribute('data-cid');
  await page.goto(DEMO);
  await field(page).waitFor();
  return id;
}

async function typeValue(page, value) {
  await field(page).fill(value);
  await field(page).press('Enter');
  await page.getByRole('group', { name: 'Период' }).getByRole('button', { name: '24 ч', exact: true }).click();
}

async function openInsufficientById(page) {
  const id = await requestId(page, 'ledger.pay.example', "Not enough money in the customer's account");
  await search(page, [id]);
  await rows(page).first().locator('[data-row-link]').click(ROW_HIT);
  await page.getByTestId('request-header').waitFor();
  await page.getByTestId('flow-canvas').waitFor();
  await page.waitForTimeout(600);
}

/** Шаг getCardholder: в теле его запроса стоит номер карты, строка «Запрос» в данных шага показывает его. */
const requestRow = (page) => stepDetails(page).locator('[data-testid="data-row"][data-item="request"]');
async function openCardStep(page) {
  await openRow(page, [CARD], /lookup/);
  await nodes(page).nth(3).click();
  await requestRow(page).waitFor();
  await page.waitForTimeout(300);
}

export const FILE_TEXT = `version: 1
project: pay
systems:
  - key: fraud
    name: Проверка мошенничества
    hosts:
      - fraud.pay.example:9090
    errors:
      - http: 500
        title: Проверка не смогла обработать запрос
        action: Повторите позже. Если повторяется, напишите в поддержку сервиса проверки.
`;

async function typeFile(page) {
  await page.locator('.cm-content').first().waitFor();
  await page.waitForTimeout(800);
  await page.locator('.cm-content').first().click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText(FILE_TEXT);
  await page.getByRole('button', { name: /Применить/ }).waitFor({ timeout: 15_000 });
  await page.waitForTimeout(400);
}

export default [
  // ---- find-error
  {
    name: 'learn-find-paste',
    ...SUPPORT,
    viewport: { width: 1280, height: 400 },
    async actions(page) {
      const id = await requestId(page, 'ledger.pay.example', "Not enough money in the customer's account");
      await typeValue(page, id);
      await mark(page, [[field(page), '1', 'tl'], [page.getByRole('button', { name: '24 ч', exact: true }), '2', 'below', [0, 6]], [page.getByRole('button', { name: 'Найти', exact: true }), '3', 'below', [0, 6]]]);
    },
    crop: panel,
    pad: 16,
  },
  {
    name: 'learn-find-results',
    ...SUPPORT,
    viewport: { width: 1280, height: 480 },
    async actions(page) {
      const id = await requestId(page, 'ledger.pay.example', "Not enough money in the customer's account");
      await search(page, [id]);
    },
    crop: (page) => page.getByTestId('search-results'),
  },
  {
    name: 'learn-find-request',
    ...SUPPORT,
    viewport: { width: 1280, height: 720 },
    actions: openInsufficientById,
  },
  {
    name: 'learn-find-reason',
    ...SUPPORT,
    viewport: { width: 1280, height: 720 },
    actions: openInsufficientById,
    crop: (page) => page.getByTestId('request-reasons'),
    pad: 8,
  },
  {
    name: 'learn-find-body',
    ...SUPPORT,
    viewport: { width: 1440, height: 900 },
    async actions(page) {
      await openInsufficientById(page);
      await stepDetails(page).locator('[data-testid="data-row"][data-item="response"]').click();
      await page.getByTestId('viewer-title').waitFor();
      await page.waitForTimeout(500);
    },
    crop: (page) => page.getByTestId('body-viewer'),
  },

  // ---- card
  {
    name: 'learn-card-field',
    ...SUPPORT,
    viewport: { width: 1280, height: 400 },
    async actions(page) {
      await typeValue(page, CARD);
    },
    crop: panel,
  },
  {
    name: 'learn-card-results',
    ...SUPPORT,
    viewport: { width: 1280, height: 480 },
    async actions(page) {
      await search(page, [CARD]);
    },
    crop: (page) => page.getByTestId('search-results'),
  },
  {
    name: 'learn-card-hit',
    ...SUPPORT,
    viewport: { width: 1280, height: 720 },
    async actions(page) {
      await openRow(page, [CARD], /lookup/);
      await mark(page, [[page.getByTestId('hit-summary'), '1', 'left', [-8, 0]]]);
    },
    crop: (page) => page.getByTestId('request-page'),
  },
  {
    name: 'learn-card-records',
    ...SUPPORT,
    viewport: { width: 1280, height: 720 },
    async actions(page) {
      await openRow(page, [CARD], /lookup/);
      await page.getByTestId('hit-summary').getByRole('button', { name: 'К первому' }).click();
      await page.waitForTimeout(800);
    },
  },

  // ---- transfer
  {
    name: 'learn-transfer-results',
    ...SUPPORT,
    viewport: { width: 1280, height: 620 },
    async actions(page) {
      await search(page, [TRANSFER]);
    },
    crop: (page) => page.getByTestId('search-results'),
  },
  {
    name: 'learn-transfer-button',
    ...SUPPORT,
    viewport: { width: 1280, height: 720 },
    async actions(page) {
      await openRow(page, [TRANSFER], 'Payout network callback');
      await mark(page, [[page.getByTestId('open-operation'), '1', 'left', [-8, 0]]]);
    },
    crop: (page) => page.getByTestId('request-header'),
    pad: 14,
  },
  {
    name: 'learn-transfer-outcome',
    ...SUPPORT,
    viewport: { width: 1280, height: 420 },
    actions: openTransfer,
  },
  {
    name: 'learn-transfer-table',
    ...SUPPORT,
    viewport: { width: 1280, height: 720 },
    actions: openTransfer,
    crop: (page) => page.getByTestId('operation-flows'),
    pad: 8,
  },
  {
    name: 'learn-transfer-row',
    ...SUPPORT,
    viewport: { width: 1280, height: 760 },
    async actions(page) {
      await openTransfer(page);
      await page.getByTestId('operation-flows').getByRole('button', { name: /Показать шаги запроса/ }).nth(2).click();
      await page.waitForTimeout(1200);
    },
    crop: (page) => page.getByTestId('operation-flows'),
    pad: 8,
  },
  {
    name: 'learn-transfer-position',
    ...SUPPORT,
    viewport: { width: 1280, height: 720 },
    async actions(page) {
      await openTransfer(page);
      await page.getByTestId('operation-flows').getByRole('button', { name: /Показать шаги запроса/ }).nth(2).click();
      await page.getByRole('link', { name: 'Открыть запрос' }).click();
      await page.getByTestId('request-header').waitFor();
      await page.getByTestId('flow-canvas').waitFor();
      await page.waitForTimeout(600);
    },
    crop: (page) => page.getByTestId('request-header'),
    pad: 14,
  },

  // ---- share
  {
    name: 'learn-share-menu',
    ...SUPPORT,
    viewport: { width: 1280, height: 720 },
    async actions(page) {
      await openInsufficient(page);
      await page.getByTestId('share-button').first().click();
      await page.waitForTimeout(300);
    },
    crop: (page) => page.getByRole('menu').first(),
    pad: 10,
  },
  {
    name: 'learn-share-done',
    ...SUPPORT,
    viewport: { width: 1280, height: 280 },
    async actions(page) {
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
      await openInsufficient(page);
      await page.getByTestId('share-button').first().click();
      await page.getByRole('menuitem', { name: 'Текст для тикета' }).click();
      await page.waitForTimeout(700);
    },
  },
  {
    name: 'learn-share-open',
    ...SUPPORT,
    viewport: { width: 1280, height: 720 },
    async actions(page) {
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
      await openInsufficient(page);
      await page.getByTestId('share-button').first().click();
      await page.getByRole('menuitem', { name: 'Короткая ссылка' }).click();
      await page.waitForTimeout(600);
      const link = await page.evaluate(() => navigator.clipboard.readText());
      await page.goto(link);
      await page.getByTestId('flow-canvas').waitFor();
      await page.waitForTimeout(800);
    },
  },

  // ---- postman
  {
    name: 'learn-postman-step',
    ...SUPPORT,
    viewport: { width: 1440, height: 900 },
    async actions(page) {
      await openCardStep(page);
      await mark(page, [[nodes(page).nth(3), '1', 'tl'], [requestRow(page), '2', 'tl']]);
    },
  },
  {
    name: 'learn-postman-open',
    ...SUPPORT,
    viewport: { width: 1440, height: 900 },
    async actions(page) {
      await openCardStep(page);
      await page.getByTestId('reveal-button').click();
      await page.waitForTimeout(900);
      await mark(page, [[page.getByTestId('reveal-button'), '1', 'left', [-8, 0]]]);
    },
  },
  {
    name: 'learn-postman-curl',
    ...SUPPORT,
    viewport: { width: 1440, height: 900 },
    async actions(page) {
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
      await openCardStep(page);
      await page.getByTestId('reveal-button').click();
      await page.waitForTimeout(900);
      await page.getByTestId('copy-curl').click();
      await page.mouse.move(0, 0);
      await page.waitForTimeout(300);
      await mark(page, [[page.getByTestId('copy-curl'), '1', 'left', [4, 0]]]);
    },
    crop: stepDetails,
    pad: 8,
  },
  {
    name: 'learn-postman-hide',
    ...SUPPORT,
    viewport: { width: 1280, height: 720 },
    async actions(page) {
      await openCardStep(page);
      await page.getByTestId('reveal-button').click();
      await page.waitForTimeout(900);
      await mark(page, [[page.getByTestId('reveal-button'), '1', 'left', [-8, 0]]]);
    },
    crop: (page) => page.getByTestId('request-header'),
    pad: 14,
  },

  // ---- business
  {
    name: 'learn-business-results',
    path: DEMO,
    role: 'business',
    viewport: { width: 1280, height: 520 },
    async actions(page) {
      await search(page, ['ledger.pay.example']);
    },
    crop: (page) => page.getByTestId('search-results'),
  },
  // Экран запроса у Бизнеса: блок причины и меню без пункта «ID запроса». Следующие три снимка.
  {
    name: 'learn-business-described',
    path: DEMO,
    role: 'business',
    viewport: { width: 1280, height: 720 },
    actions: (page) => openBusinessRow(page, ['ledger.pay.example'], "Not enough money in the customer's account"),
  },
  {
    name: 'learn-business-undescribed',
    path: DEMO,
    role: 'business',
    viewport: { width: 1280, height: 720 },
    async actions(page) {
      await openBusinessRow(page, ['getCard'], 'ответила ошибкой');
      await mark(page, [[page.getByTestId('request-reasons').getByTestId('share-button'), '1', 'right', [10, 0]]]);
    },
    crop: (page) => page.getByTestId('request-reasons'),
    pad: 14,
  },
  {
    name: 'learn-business-share',
    path: DEMO,
    role: 'business',
    viewport: { width: 1280, height: 720 },
    async actions(page) {
      await openBusinessRow(page, ['getCard'], 'ответила ошибкой');
      await page.getByTestId('share-button').first().click();
      await page.waitForTimeout(300);
    },
    crop: (page) => page.getByRole('menu').first(),
    pad: 10,
  },

  // ---- describe-error
  {
    name: 'learn-describe-unknown',
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
    name: 'learn-describe-request',
    ...SUPPORT,
    viewport: { width: 1280, height: 720 },
    async actions(page) {
      await openRow(page, ['ledger.pay.example'], 'Внутренняя ошибка сервера');
      await mark(page, [[stepDetails(page).getByRole('button', { name: /Добавить в справочник/ }), '1', 'left', [-8, 0]]]);
    },
  },
  {
    name: 'learn-describe-form',
    ...SUPPORT,
    viewport: { width: 1280, height: 860 },
    async actions(page) {
      await openRow(page, ['ledger.pay.example'], 'Внутренняя ошибка сервера');
      await stepDetails(page).getByRole('button', { name: /Добавить в справочник/ }).click();
      const form = page.getByRole('dialog').first();
      await form.getByLabel('Текст ошибки').fill('Платёжная система временно не работает');
      await form.getByLabel(/Что делать/).fill('Повторите позже. Если повторяется, напишите в поддержку платёжной системы.');
      await page.waitForTimeout(300);
      await mark(page, [[form.getByRole('button', { name: 'Сохранить' }), '1', 'tl']]);
    },
    crop: (page) => page.getByRole('dialog').first(),
  },
  {
    name: 'learn-describe-after',
    ...SUPPORT,
    viewport: { width: 1280, height: 720 },
    async actions(page) {
      await openRow(page, ['ledger.pay.example'], 'Внутренняя ошибка сервера');
      await stepDetails(page).getByRole('button', { name: /Добавить в справочник/ }).click();
      const form = page.getByRole('dialog').first();
      await form.getByLabel('Текст ошибки').fill('Платёжная система временно не работает');
      await form.getByLabel(/Что делать/).fill('Повторите позже. Если повторяется, напишите в поддержку платёжной системы.');
      await form.getByRole('button', { name: 'Сохранить' }).click();
      await page.getByTestId('step-action').waitFor();
      await page.waitForTimeout(500);
    },
  },

  // ---- file-first
  {
    name: 'learn-file-open',
    path: '/pay/settings/file',
    role: 'analyst',
    viewport: { width: 1280, height: 620 },
    async actions(page) {
      await page.locator('.cm-content').first().waitFor();
      await page.waitForTimeout(800);
    },
  },
  {
    name: 'learn-file-typed',
    path: '/pay/settings/file',
    role: 'analyst',
    viewport: { width: 1280, height: 720 },
    async actions(page) {
      await typeFile(page);
      await mark(page, [[page.getByRole('button', { name: /Применить/ }), '1', 'tl']]);
    },
  },
  {
    name: 'learn-file-applied',
    path: '/pay/settings/file',
    role: 'analyst',
    viewport: { width: 1280, height: 620 },
    async actions(page) {
      await typeFile(page);
      await page.getByRole('button', { name: /Применить/ }).click();
      await page.getByText(/Файл загружен/).waitFor({ timeout: 15_000 });
      await page.waitForTimeout(400);
    },
  },
  {
    name: 'learn-file-result',
    path: DEMO,
    role: 'analyst',
    viewport: { width: 1280, height: 720 },
    async actions(page) {
      await openRow(page, ['fraud.pay.example'], /не смогла обработать/);
    },
  },
];
