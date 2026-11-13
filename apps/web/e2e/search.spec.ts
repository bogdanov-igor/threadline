import AxeBuilder from '@axe-core/playwright';
import { luhnValid } from '@threadline/core';
import { expect, test, type Page } from '@playwright/test';
import { MOCK_FLOW, MOCK_PHONE, MOCK_SPECIAL } from '../../server/src/backends/mock/dataset-pay.ts';
import { epochToLocalInput } from '../src/lib/zoned-time.ts';
import { dataRow, openMore, setViewMode } from './helpers.ts';

// Нажатие у левого края строки: в середине строки может оказаться метка параметра, она копирует, а не открывает.
const ROW_HIT = { position: { x: 8, y: 8 } };

// Сквозные проверки поиска на демо-среде: имитация хранилища с синтетическими записями Demo Pay за последние 24 часа.

const TZ = 'Asia/Karachi';
const H = 60 * 60 * 1000;

const termsInput = (page: Page) => page.getByRole('textbox', { name: 'Значения для поиска' });
const periodGroup = (page: Page) => page.getByRole('group', { name: 'Период' });
const findButton = (page: Page) => page.getByRole('button', { name: 'Найти', exact: true });
const results = (page: Page) => page.getByTestId('search-results');
const rows = (page: Page) => page.getByRole('list', { name: 'Найденные запросы' }).getByRole('listitem');
const alert = (page: Page) => page.getByTestId('search-panel').getByRole('alert');
const noScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const exampleCards = (page: Page) => page.getByTestId('search-example');

type Preset = '15 мин' | '1 ч' | '6 ч' | '24 ч';

async function addTerms(page: Page, terms: string[]) {
  const input = termsInput(page);
  for (const term of terms) {
    await input.fill(term);
    await input.press('Enter');
  }
}

async function search(page: Page, terms: string[], preset?: Preset) {
  // Ждём id нового задания: иначе прежний результат на экране сойдёт за новый.
  const before = new URL(page.url()).searchParams.get('search');
  await addTerms(page, terms);
  if (preset) await periodGroup(page).getByRole('button', { name: preset, exact: true }).click();
  await findButton(page).click();
  await expect(page).toHaveURL((url) => /^\?search=[^&]+$/.test(url.search) && url.searchParams.get('search') !== before);
}

async function waitDone(page: Page, timeout = 20_000) {
  await expect(results(page)).toHaveAttribute('data-status', /^(done|failed|cancelled)$/, { timeout });
}

async function cidsOf(page: Page): Promise<string[]> {
  return rows(page).evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.cid ?? ''));
}

/** Последовательности 15–19 цифр с верной контрольной цифрой Луна: полные номера карт. */
function fullPans(text: string): string[] {
  return [...text.matchAll(/(?<!\d)\d{15,19}(?!\d)/g)].map((m) => m[0]).filter(luhnValid);
}

test.describe('поиск: панель', () => {
  test('до первого поиска: поле, период 6 ч, «Найти», примеры среды и что можно искать', async ({ page }) => {
    await page.goto('/pay/demo');
    await expect(termsInput(page)).toBeVisible();
    await expect(periodGroup(page).getByRole('button', { name: '6 ч', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(findButton(page)).toBeEnabled();
    await expect(page.getByTestId('start-page').getByRole('heading', { level: 2 })).toHaveText('Найдите запрос по любому значению из обращения');
    const cards = exampleCards(page);
    await expect(cards).toHaveCount(5);
    await expect(cards.nth(0)).toContainText('User: successful and failed requests');
    // Номер карты на карточке маской, полного номера на странице нет.
    await expect(cards.nth(1)).toContainText('411111******7893');
    await expect(cards.nth(2)).toContainText('07700 900001');
    await expect(cards.nth(3)).toContainText('24 ч');
    expect(fullPans(await page.locator('body').innerText())).toEqual([]);
    const examples = page.getByTestId('search-examples');
    for (const name of ['user_id', 'card_id', 'токен карты', 'PAN или его маска', 'correlation_id', 'id операции']) {
      await expect(examples).toContainText(name);
    }
  });

  test('пример среды: щелчок заполняет поле и сразу ищет, запросы на экране', async ({ page }) => {
    await page.goto('/pay/demo');
    await exampleCards(page).filter({ hasText: 'User: successful and failed requests' }).click();
    await expect(page).toHaveURL(/\?search=[^&]+$/);
    await expect(page.getByTestId('term-chip')).toHaveCount(1);
    await expect(page.getByTestId('term-chip')).toContainText(MOCK_SPECIAL.gatewayUserId);
    await expect(periodGroup(page).getByRole('button', { name: '6 ч', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await waitDone(page);
    await expect(rows(page)).toHaveCount(3);
    await expect(rows(page).and(page.locator('[data-status=error]'))).toHaveCount(1);
    await expect(rows(page).and(page.locator('[data-status=success]'))).toHaveCount(2);
    // Назад — снова стартовая страница с примерами.
    await page.goBack();
    await expect(exampleCards(page)).toHaveCount(5);
  });

  test('пример с номером карты и своим периодом: прежние значения и исключения заменены, номер нигде не виден', async ({ page }) => {
    await page.goto('/pay/demo');
    await addTerms(page, ['что-то-своё']);
    await exampleCards(page).filter({ hasText: 'Card: successful requests and a failure' }).click();
    await waitDone(page);
    await expect(page.getByTestId('term-chip')).toHaveCount(1);
    await expect(page.getByTestId('term-chip')).toHaveText(/номер карты\s*411111\*{6}7893/);
    await expect(rows(page).and(page.locator('[data-status=error]'))).not.toHaveCount(0);
    expect(fullPans(await page.locator('body').innerText())).toEqual([]);

    // Новый поиск с карточкой за сутки: период переключается на 24 ч.
    await page.goto('/pay/demo');
    await exampleCards(page).filter({ hasText: 'Transfer with a payout: every request of the operation' }).click();
    await waitDone(page);
    await expect(periodGroup(page).getByRole('button', { name: '24 ч', exact: true })).toHaveAttribute('aria-pressed', 'true');
    expect(await rows(page).count()).toBeGreaterThan(3);
  });

  test('пример с телефоном в местной записи: все написания найдены, ошибок нет — «Только с ошибкой» недоступен', async ({ page }) => {
    await page.goto('/pay/demo');
    await exampleCards(page).filter({ hasText: 'Phone number in national format' }).click();
    await waitDone(page);
    await expect(page.getByTestId('term-chip')).toHaveText(/телефон\s*447700900001/);
    await expect(rows(page)).toHaveCount(MOCK_PHONE.spellings.length);
    const onlyErrors = page.getByRole('switch', { name: /Только с ошибкой/ });
    await expect(onlyErrors).toBeDisabled();
    await expect(page.locator('label').filter({ has: onlyErrors })).toContainText('ошибок нет');
  });

  test('английский интерфейс: подписи примеров по-английски, щелчок ищет то же', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('threadline.language', 'en'));
    await page.goto('/pay/demo');
    await expect(page.getByTestId('start-page').getByRole('heading', { level: 2 })).toHaveText('Find a request by any value from a support ticket');
    const cards = exampleCards(page);
    await expect(cards).toHaveCount(5);
    await expect(cards.nth(0)).toContainText('User: successful and failed requests');
    await expect(page.getByTestId('search-examples-try')).not.toContainText(/[а-яё]/i);
    await cards.nth(0).click();
    await expect(page.getByTestId('term-chip')).toContainText(MOCK_SPECIAL.gatewayUserId);
  });

  test('среда без примеров: блока примеров нет, что можно искать — на месте', async ({ page }) => {
    await page.goto('/pay/long');
    await expect(page.getByTestId('search-examples')).toBeVisible();
    await expect(page.getByTestId('search-examples-try')).toHaveCount(0);
  });

  test('среда не настроена: «Найти» недоступна, названа переменная', async ({ page }) => {
    await page.goto('/pay/prod');
    await expect(findButton(page)).toBeDisabled();
    await expect(page.getByTestId('search-not-configured')).toContainText('THREADLINE_E2E_TOKEN_NOT_SET');
    // Призыв «вставьте в строку поиска» противоречил бы предупреждению: его нет, справка на месте.
    await expect(page.getByTestId('start-intro')).toHaveCount(0);
    await expect(page.getByTestId('search-examples')).toBeVisible();
  });

  test('среда стендов без стенда: вместо поиска выбор стенда', async ({ page }) => {
    await page.goto('/pay/pr');
    await expect(page.getByRole('main').getByRole('list', { name: 'Живые стенды за 7 дней' })).toBeVisible();
    await expect(termsInput(page)).toHaveCount(0);
  });

  test('вид значения: номер карты маской, 16 цифр, телефон, маска, UUID', async ({ page }) => {
    await page.goto('/pay/demo');
    await addTerms(page, ['4111111234557893', '4111111234557894', '+447700900123', '676712******1234', '0199a1b2-3c4d-7e5f-8a9b-0c1d2e3f4a5b']);
    const chips = page.getByTestId('term-chip');
    await expect(chips).toHaveCount(5);
    await expect(chips.nth(0)).toHaveText(/номер карты\s*411111\*{6}7893/);
    await expect(chips.nth(1)).toHaveText(/16 цифр\s*4111111234557894/);
    await expect(chips.nth(2)).toHaveText(/телефон\s*447700900123/);
    await expect(chips.nth(3)).toHaveText(/маска карты\s*676712\*{6}1234/);
    await expect(chips.nth(4)).toHaveText(/UUID/);
    // Полного номера нет нигде на странице.
    expect(await page.locator('body').innerText()).not.toContain('4111111234557893');
    await expect(termsInput(page)).toHaveValue('');
  });

  test('запятая и вставка добавляют значения, Backspace в пустом поле убирает последнее', async ({ page }) => {
    await page.goto('/pay/demo');
    const input = termsInput(page);
    await input.click();
    await page.keyboard.type('abcdef,qwerty,');
    await expect(page.getByTestId('term-chip')).toHaveCount(2);
    await input.press('Backspace');
    await expect(page.getByTestId('term-chip')).toHaveCount(1);
    await input.evaluate((el) => {
      const data = new DataTransfer();
      data.setData('text/plain', 'one111, two222\nthree3');
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await expect(page.getByTestId('term-chip')).toHaveCount(4);
    await page.getByRole('button', { name: 'Убрать значение abcdef' }).click();
    await expect(page.getByTestId('term-chip')).toHaveCount(3);
  });

  test('проверки значений: короткое, кавычки, шестое, нет длинного', async ({ page }) => {
    await page.goto('/pay/demo');
    await addTerms(page, ['7']);
    await expect(alert(page)).toHaveText(/не меньше 2 символов/);
    await expect(page.getByTestId('term-chip')).toHaveCount(0);
    await expect(termsInput(page)).toHaveValue('7');

    await addTerms(page, ['ab"cd']);
    await expect(alert(page)).toContainText('Кавычки и обратная косая черта не подходят');
    await addTerms(page, ['ab\\cd']);
    await expect(alert(page)).toContainText('Кавычки и обратная косая черта не подходят');

    await termsInput(page).fill('');
    await addTerms(page, ['aa1', 'aa2', 'aa3', 'aa4', 'aa5', 'aa6']);
    await expect(page.getByTestId('term-chip')).toHaveCount(5);
    await expect(alert(page)).toContainText('Не больше 5 значений');

    await page.reload();
    await addTerms(page, ['ab', 'pay']);
    await findButton(page).click();
    await expect(alert(page)).toContainText('хотя бы одно значение длиной от 6 символов');
    await expect(page).not.toHaveURL(/search=/);
  });

  test('свой период: длиннее 24 часов, начало позже конца, раньше срока хранения', async ({ page }) => {
    await page.goto('/pay/demo');
    const now = Date.now();
    const open = async (from: number, to: number) => {
      await periodGroup(page).getByRole('button', { name: /^Свой/ }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('Начало').fill(epochToLocalInput(from, TZ));
      await dialog.getByLabel('Конец').fill(epochToLocalInput(to, TZ));
      await dialog.getByRole('button', { name: 'Применить' }).click();
      return dialog;
    };
    let dialog = await open(now - 30 * H, now);
    await expect(dialog.getByRole('alert')).toHaveText(/длиннее 24 часов/);
    await dialog.getByRole('button', { name: 'Отмена' }).click();

    dialog = await open(now - H, now - 3 * H);
    await expect(dialog.getByRole('alert')).toHaveText(/Поменяйте границы местами/);
    await dialog.getByRole('button', { name: 'Отмена' }).click();

    dialog = await open(now - 40 * 24 * H, now - 40 * 24 * H + H);
    await expect(dialog.getByRole('alert')).toHaveText(/записи хранятся 30 дней/);
    await dialog.getByRole('button', { name: 'Отмена' }).click();
    await expect(periodGroup(page).getByRole('button', { name: '6 ч', exact: true })).toHaveAttribute('aria-pressed', 'true');
  });

  test('свой период с концом в будущем: поиск идёт до текущего момента', async ({ page }) => {
    await page.goto('/pay/demo');
    const now = Date.now();
    await periodGroup(page).getByRole('button', { name: /^Свой/ }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Начало').fill(epochToLocalInput(now - 3 * H, TZ));
    await dialog.getByLabel('Конец').fill(epochToLocalInput(now + 2 * H, TZ));
    await dialog.getByRole('button', { name: 'Применить' }).click();
    await expect(periodGroup(page).getByRole('button', { name: /^Свой/ })).toHaveAttribute('aria-pressed', 'true');
    const body = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/searches'));
    await search(page, ['getCard']);
    const sent = (await body).postDataJSON() as { period: { fromMs: number; toMs: number } };
    expect(sent.period.toMs - sent.period.fromMs).toBeGreaterThan(4 * H);
    await waitDone(page);
    await expect(results(page)).toHaveAttribute('data-status', 'done');
  });
});

test.describe('поиск: результаты', () => {
  test('getCard за 24 часа: статусы, «Только с ошибкой», подсказка статуса, в адресе только id', async ({ page }) => {
    await page.goto('/pay/demo');
    await search(page, ['getCard'], '24 ч');
    await waitDone(page);
    expect(new URL(page.url()).search).toMatch(/^\?search=[^&]+$/);
    expect(page.url()).not.toContain('getCard');

    const total = await rows(page).count();
    expect(total).toBeGreaterThan(1);
    const errors = await rows(page).and(page.locator('[data-status=error]')).count();
    expect(errors).toBeGreaterThan(0);
    expect(errors).toBeLessThan(total);
    await expect(page.getByTestId('results-summary')).toContainText(`${errors} с ошибкой`);
    // Свежие первыми.
    const firsts = await rows(page).evaluateAll((els) => els.map((el) => Number((el as HTMLElement).dataset.first)));
    expect(firsts).toEqual([...firsts].sort((a, b) => b - a));
    // Запрос сервиса карт: метод и путь, компонент.
    await expect(rows(page).first()).toContainText('POST /v1/cards/lookup');
    await expect(rows(page).locator('[data-status=error]').first()).toBeVisible();
    await expect(rows(page).and(page.locator('[data-status=error]')).first().getByTestId('request-reason')).toContainText('PRC-ERR-0027');

    await page.getByRole('switch', { name: /Только с ошибкой/ }).click();
    await expect(rows(page)).toHaveCount(errors);
    await expect(rows(page).and(page.locator('[data-status=success]'))).toHaveCount(0);
    await page.getByRole('switch', { name: /Только с ошибкой/ }).click();
    await expect(rows(page)).toHaveCount(total);

    await rows(page).and(page.locator('[data-status=success]')).first().locator('[data-status=success]').hover();
    await expect(page.getByRole('tooltip')).toContainText('Ответ проекта партнёру виден, только если он записан в логи');

    // В браузере значения поиска не оседают.
    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
    expect(stored).not.toContain('getCard');
  });

  test('копирование correlation_id из строки', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/pay/demo');
    await search(page, ['getCard'], '24 ч');
    await waitDone(page);
    const row = rows(page).first();
    const cid = await row.getAttribute('data-cid');
    const button = row.getByRole('button', { name: /^Скопировать correlation_id/ });
    await button.click();
    await expect(button).toHaveAttribute('data-copied', 'true');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(cid);
    // Копирование не открывает запрос.
    await expect(page).toHaveURL(/\?search=/);
  });

  test('запрос с ошибкой: первая ошибка раскрыта, XML с отступами, «Копировать», назад к результатам, ссылка', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/pay/demo');
    await search(page, ['getCard'], '24 ч');
    await waitDone(page);
    const resultsUrl = page.url();
    const errorRow = rows(page).and(page.locator('[data-status=error]')).first();
    const cid = (await errorRow.getAttribute('data-cid'))!;
    await errorRow.locator('[data-row-link]').click(ROW_HIT);

    await expect(page).toHaveURL(new RegExp(`/pay/demo/requests/${cid}\\?from=\\d+&to=\\d+$`));
    const header = page.getByTestId('request-header');
    await expect(header.getByRole('heading', { level: 1 })).toHaveText('POST /v1/cards/lookup');
    await expect(header.locator('[data-status=error]')).toBeVisible();
    await expect(header.getByTestId('request-cid')).toHaveText(cid);
    await expect(page.getByTestId('request-reasons')).toContainText('PRC-ERR-0027');

    // Записи запроса — на своей вкладке; по умолчанию открыта схема.
    await page.getByRole('tab', { name: /^Записи/ }).click();
    // Смещения от первой записи.
    await expect(page.getByTestId('record-offset').first()).toHaveText('+0 мс');
    const firstError = page.locator('li[data-error]').first();
    await expect(firstError.locator('button[aria-expanded]').first()).toHaveAttribute('aria-expanded', 'true');
    // Раскрыта и видна на экране без прокрутки руками.
    await expect(firstError).toBeInViewport();
    const response = firstError.locator('[data-block=response]');
    await expect(response).toContainText('Ответ · HTTP 200');
    const pre = response.locator('pre');
    const text = (await pre.textContent())!;
    expect(text).toContain('PRC-ERR-0027');
    // SOAP одной строкой показан с отступами по тегам.
    expect(text.split('\n').length).toBeGreaterThan(5);
    expect(text).toMatch(/\n {2,}<ns1:getCardResponse>/);
    await response.getByRole('button', { name: /^Копировать/ }).click();
    await expect(response.getByRole('button', { name: /^Скопировано/ })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(text);

    // Отправка связана с ответом.
    await firstError.getByRole('button', { name: 'К отправке' }).click();
    await expect(page.locator('li[data-kind=send]').filter({ has: page.getByRole('button', { name: 'К ответу' }) }).first()).toBeVisible();

    // Адрес страницы запроса работает у вошедших: в нём только correlation_id и границы запроса.
    const link = page.url();
    expect(link).toMatch(new RegExp(`/pay/demo/requests/${cid}\\?from=\\d+&to=\\d+$`));
    expect(link).not.toContain('getCard');
    // «Поделиться» создаёт короткую ссылку: в адресе нет ни значений, ни идентификаторов логов.
    await page.getByRole('button', { name: 'Поделиться' }).click();
    await page.getByTestId('share-item-link').click();
    await expect(page.getByTestId('share-hint')).toContainText('Ссылка скопирована');
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/\/s\/[A-Za-z0-9_-]{22}$/);

    await page.getByRole('link', { name: 'К результатам' }).click();
    await expect(page).toHaveURL(resultsUrl);
    await expect(rows(page).first()).toBeVisible();
    await expect(page.locator(`li[data-cid="${cid}"] [data-row-link]`)).toBeFocused();

    // По ссылке без результатов поиска записи забираются заново.
    const other = await context.newPage();
    await other.goto(link);
    await expect(other.getByTestId('request-header').getByTestId('request-cid')).toHaveText(cid);
    await expect(other.getByRole('link', { name: 'К результатам' })).toHaveCount(0);
    await other.getByRole('tab', { name: /^Записи/ }).click();
    await expect(other.locator('li[data-error]').first()).toBeInViewport();
    await expect(other.locator('li[data-error]').first().locator('[data-block=response]')).toContainText('PRC-ERR-0027');
  });

  test('эквайер ответил HTTP 500: причина и красный статус', async ({ page }) => {
    await page.goto('/pay/demo');
    await search(page, ['api.acquirer.example'], '24 ч');
    await waitDone(page);
    const row = rows(page).and(page.locator('[data-status=error]')).first();
    await expect(row).toBeVisible();
    // Запрос api: метод и путь — из записи шлюза, компонент — api.
    await expect(row.getByTestId('request-path')).toHaveText(/^POST \/v1\/users\/[^/]+\/merchant-payments$/);
    await expect(row).toContainText('api');
    await row.locator('[data-row-link]').click(ROW_HIT);
    await page.getByRole('tab', { name: /^Записи/ }).click();
    // Статус — в заголовке «… → 500» красным, без повтора отдельной меткой.
    const http = page.locator('li[data-kind=response]').filter({ has: page.getByTestId('record-title').filter({ hasText: /→ 500$/ }) }).first();
    await expect(http).toBeVisible();
    const color = await http.getByTestId('record-title').evaluate((el) => getComputedStyle(el).color);
    expect(color).toBe('rgb(180, 35, 24)');
    await expect(http.getByText('HTTP 500', { exact: true })).toHaveCount(0);
  });

  test('клавиатура: стрелки между строками, Enter открывает запрос', async ({ page }) => {
    await page.goto('/pay/demo');
    await search(page, ['getCard'], '24 ч');
    await waitDone(page);
    const links = page.locator('[data-row-link]');
    await links.first().focus();
    await page.keyboard.press('ArrowDown');
    await expect(links.nth(1)).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(links.first()).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/requests\//);
  });

  test('«Все записи» загружаются только при открытии вкладки, «Показать ещё» без повторов', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    let linesRequests = 0;
    page.on('request', (r) => {
      if (/\/api\/searches\/[^/]+\/lines/.test(r.url())) linesRequests++;
    });
    await page.goto('/pay/demo');
    await search(page, ['pay.example'], '24 ч');
    await waitDone(page);
    await page.waitForTimeout(300);
    expect(linesRequests).toBe(0);

    await page.getByRole('tab', { name: 'Все записи' }).click();
    const list = page.getByRole('list', { name: 'Все найденные строки' });
    await expect(list.getByRole('listitem').first()).toBeVisible();
    expect(linesRequests).toBeGreaterThan(0);
    const first = await list.getByRole('listitem').count();

    const more = page.getByRole('button', { name: 'Показать ещё' });
    await expect(more).toBeVisible();
    await more.click();
    await expect.poll(() => list.getByRole('listitem').count()).toBeGreaterThan(first);
    const ids = await list.locator('[data-record-id]').evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.recordId));
    expect(new Set(ids).size).toBe(ids.length);
    // Свежие первыми: показанное время записи не растёт вниз по списку.
    const times = await list.locator('[data-record-id]').evaluateAll((els) => els.map((el) => Number((el as HTMLElement).dataset.time)));
    expect(times.every((v, i) => i === 0 || v <= times[i - 1]!)).toBe(true);
    // Пока страница грузится, кнопка недоступна, а после последней страницы исчезает.
    // После нажатия ждём новые строки или конец списка: кнопка становится недоступной не сразу.
    const end = page.getByText('Это все записи за период.');
    const ready = page.getByRole('button', { name: 'Показать ещё', disabled: false });
    for (let i = 0; i < 30; i++) {
      await expect(end.or(ready).first()).toBeVisible();
      if (await end.isVisible()) break;
      const n = await list.getByRole('listitem').count();
      await ready.click();
      await expect(end.or(list.getByRole('listitem').nth(n)).first()).toBeVisible();
    }
    await expect(end).toBeVisible();
    await expect(more).toHaveCount(0);

    // Строка раскрывается и ведёт к своему запросу. Ответ — не первая запись запроса: время строки не годится в границы.
    const item = list.locator('li[data-kind=response]').filter({ has: page.getByRole('link', { name: 'К запросу' }) }).first();
    await item.locator('button[aria-expanded]').first().click();
    await expect(item.locator('[data-block=raw]')).toBeVisible();
    await item.getByRole('link', { name: 'К запросу' }).click();
    await expect(page).toHaveURL(/\/pay\/demo\/requests\/[^?]+\?from=\d+&to=\d+$/);
    await expect(page.getByTestId('request-header')).toBeVisible();
    // В адресе — границы самого запроса.
    const url = new URL(page.url());
    expect(Number(url.searchParams.get('from'))).toBeLessThan(Number(url.searchParams.get('to')));
    await page.getByRole('button', { name: 'Поделиться' }).click();
    await page.getByTestId('share-item-link').click();
    await expect(page.getByTestId('share-hint')).toContainText('Ссылка скопирована');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/\/s\/[A-Za-z0-9_-]{22}$/);
  });

  test('только строки без correlation_id: вкладка «Все записи» открывается сама', async ({ page }) => {
    await page.goto('/pay/demo');
    await search(page, ['PHP Warning']);
    await waitDone(page);
    await expect(page.locator('[data-notice=only-lines]')).toContainText('Запросов с correlation_id нет');
    await expect(page.getByRole('tab', { name: 'Все записи' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('list', { name: 'Все найденные строки' })).toContainText('PHP Warning');
  });

  test('пустой результат: «За 6 часов ничего не нашлось» и поиск за 24 часа', async ({ page }) => {
    const value = `zq${Math.random().toString(36).slice(2, 12).padEnd(10, 'x')}`;
    await page.goto('/pay/demo');
    await search(page, [value]);
    await waitDone(page);
    const empty = page.locator('[data-notice=empty]');
    await expect(empty).toContainText('За 6 часов ничего не нашлось');
    await empty.getByRole('button', { name: 'Искать за 24 часа' }).click();
    await expect(page.locator('[data-notice=empty]')).toContainText('За 24 часа ничего не нашлось');
    await expect(page.getByRole('button', { name: 'Искать за 24 часа' })).toHaveCount(0);
    await expect(periodGroup(page).getByRole('button', { name: '24 ч', exact: true })).toHaveAttribute('aria-pressed', 'true');
  });

  test('повтор из памяти и «Обновить»', async ({ page }) => {
    await page.goto('/pay/demo');
    await search(page, ['getCard'], '24 ч');
    await waitDone(page);
    const firstUrl = page.url();
    await findButton(page).click();
    await expect(page.getByTestId('cached-note')).toBeVisible();
    expect(page.url()).toBe(firstUrl);

    const post = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/searches'));
    await page.getByRole('button', { name: 'Обновить' }).click();
    expect((await post).postDataJSON()).toMatchObject({ terms: ['getCard'], period: { preset: '24h' }, fresh: true });
    await expect(page).not.toHaveURL(firstUrl);
    await waitDone(page);
    await expect(page.getByTestId('cached-note')).toHaveCount(0);
  });

  test('«Стоп» прерывает поиск, найденное остаётся с пометкой', async ({ page }) => {
    await page.goto('/pay/slow');
    // Своё значение: соседний набор мог завершить такой же поиск, и он пришёл бы из памяти уже готовым.
    await search(page, [`stop${Date.now().toString(36)}`], '24 ч');
    await expect(results(page)).toHaveAttribute('data-status', 'running');
    await expect(page.getByTestId('search-progress')).toBeVisible();
    const del = page.waitForRequest((r) => r.method() === 'DELETE' && /\/api\/searches\/[^/]+$/.test(r.url()));
    await page.getByRole('button', { name: 'Стоп', exact: true }).click();
    await del;
    await expect(results(page)).toHaveAttribute('data-status', 'cancelled', { timeout: 10_000 });
    await expect(page.locator('[data-notice=cancelled]')).toContainText('Поиск остановлен');
    await expect(page.getByRole('button', { name: 'Стоп', exact: true })).toHaveCount(0);
  });

  test('новый поиск останавливает прежний', async ({ page }) => {
    await page.goto('/pay/slow');
    const value = `prev${Date.now().toString(36)}`;
    await search(page, [value], '24 ч');
    await expect(results(page)).toHaveAttribute('data-status', 'running');
    const firstId = new URL(page.url()).searchParams.get('search')!;
    const del = page.waitForRequest((r) => r.method() === 'DELETE' && r.url().endsWith(`/api/searches/${firstId}`));
    await page.getByRole('button', { name: `Убрать значение ${value}` }).click();
    await search(page, ['retrieveData'], '1 ч');
    await del;
    await expect(page).not.toHaveURL(new RegExp(firstId));
  });

  test('скрытая вкладка: опрос продолжается, поиск завершается', async ({ page }) => {
    let polls = 0;
    page.on('request', (r) => {
      if (r.method() === 'GET' && /\/api\/searches\/[^/?]+\?from=/.test(r.url())) polls++;
    });
    await page.goto('/pay/slow');
    // Своё значение на каждый запуск: повтор из памяти завершил бы поиск сразу, без опроса.
    // За 6 часов шесть подсчётов по 1,5 с: поиск идёт заметно дольше окна проверки.
    await search(page, [`hidden${Date.now().toString(36)}`], '6 ч');
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
    });
    const before = polls;
    await page.waitForTimeout(3000);
    expect(polls - before).toBeGreaterThanOrEqual(3);
    await waitDone(page, 30_000);
    await expect(results(page)).toHaveAttribute('data-status', 'done');
  });

  test('запрос открыт из идущего поиска: опрос состояния продолжается, без удвоения', async ({ page }) => {
    await page.goto('/pay/demo');
    await search(page, ['getCard'], '24 ч');
    await waitDone(page);
    const id = new URL(page.url()).searchParams.get('search')!;
    const STATE = new RegExp(`/api/searches/${id}\\?from=`);
    let polls = 0;
    page.on('request', (r) => {
      if (r.method() === 'GET' && STATE.test(r.url())) polls++;
    });
    // Поиск будто ещё идёт: в имитации он кончается раньше, чем появляются строки.
    await page.route(STATE, async (route) => {
      const res = await route.fetch();
      await route.fulfill({ response: res, json: { ...((await res.json()) as object), status: 'running' } });
    });
    await rows(page).first().locator('[data-row-link]').click(ROW_HIT);
    await expect(page.getByTestId('request-header')).toBeVisible();
    const before = polls;
    await page.waitForTimeout(2000);
    // Опрос раз в 500 мс: за 2 с около четырёх, вдвое больше — опрос удвоился.
    expect(polls - before).toBeGreaterThanOrEqual(3);
    expect(polls - before).toBeLessThanOrEqual(6);

    // Поиск завершился — опрос прекращается.
    await page.unroute(STATE);
    await page.waitForTimeout(700);
    const after = polls;
    await page.waitForTimeout(1500);
    expect(polls).toBe(after);
  });

  test('результат устарел: сообщение и новый поиск', async ({ page }) => {
    await page.goto('/pay/demo?search=no-such-search');
    const notice = page.locator('[data-notice=expired]');
    await expect(notice).toContainText('Результат устарел');
    await notice.getByRole('button', { name: 'Новый поиск' }).click();
    await expect(page).toHaveURL(/\/pay\/demo$/);
    await expect(termsInput(page)).toBeFocused();
  });

  test('ошибка хранилища: понятная причина и «Повторить»', async ({ page }) => {
    await page.goto('/pay/network');
    await search(page, ['getCard']);
    await waitDone(page);
    const notice = page.locator('[data-notice=error]');
    await expect(notice).toContainText('Нет связи с хранилищем');
    await expect(notice.getByRole('button', { name: 'Повторить' })).toBeVisible();
  });
});

test.describe('страница запроса и возврат к результатам', () => {
  for (const [width, height] of [
    [768, 700],
    [1280, 600],
  ] as const) {
    test(`${width}×${height}: запрос из прокрученного списка — с начала страницы; «Назад» — прокрутка и фокус строки`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.goto('/pay/demo');
      await search(page, ['getCard'], '24 ч');
      await waitDone(page);
      const last = rows(page).last();
      await last.scrollIntoViewIfNeeded();
      const cid = (await last.getAttribute('data-cid'))!;
      const scrolled = await page.evaluate(() => window.scrollY);
      expect(scrolled).toBeGreaterThan(100);

      // Мышью: шапка запроса, причины и вкладки видны без прокрутки.
      await last.locator('[data-row-link]').click(ROW_HIT);
      await expect(page.getByTestId('request-header')).toBeVisible();
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
      await expect(page.getByRole('link', { name: 'К результатам' })).toBeInViewport();
      await expect(page.getByTestId('request-header').getByRole('heading', { level: 1 })).toBeInViewport();
      await expect(page.getByRole('tab', { name: 'Схема' })).toBeInViewport();

      // «Назад» браузера: результаты из памяти, прокрутка на месте, открытая строка в фокусе.
      await page.goBack();
      const link = page.locator(`li[data-cid="${cid}"] [data-row-link]`);
      await expect(link).toBeFocused();
      await expect(link).toBeInViewport();
      expect(Math.abs((await page.evaluate(() => window.scrollY)) - scrolled)).toBeLessThanOrEqual(1);

      // Клавиатурой: Enter на строке в фокусе — тоже с начала страницы.
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('request-header')).toBeVisible();
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
      await expect(page.getByRole('link', { name: 'К результатам' })).toBeInViewport();

      // «К результатам» — шаг назад по истории, без новой записи: «Вперёд» снова открывает запрос.
      const entries = await page.evaluate(() => history.length);
      await page.getByRole('link', { name: 'К результатам' }).click();
      await expect(link).toBeFocused();
      expect(await page.evaluate(() => history.length)).toBe(entries);
      await page.goForward();
      await expect(page.getByTestId('request-header').getByTestId('request-cid')).toHaveText(cid);
    });
  }
});

test.describe('поиск по номеру карты', () => {
  test('полный номер: только запросы этой карты, вторая карта с теми же краями не попадает, номера нигде нет', async ({ page }) => {
    const exactRows = (p: Page) => rows(p).and(p.locator('[data-match=exact]'));
    const inexactRows = (p: Page) => rows(p).and(p.locator('[data-match=inexact]'));
    await page.goto('/pay/demo');
    await search(page, [MOCK_SPECIAL.twinPan], '24 ч');
    await waitDone(page);
    const twin = await cidsOf(page);
    const twinExact = await exactRows(page).evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.cid ?? ''));
    expect(twinExact.length).toBeGreaterThan(0);

    await page.getByRole('button', { name: /^Убрать значение/ }).click();
    const post = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/searches'));
    await search(page, [MOCK_SPECIAL.exactPan], '24 ч');
    expect((await post).postDataJSON()).toMatchObject({ terms: [MOCK_SPECIAL.exactPan] });
    await waitDone(page);
    const exact = await exactRows(page).evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.cid ?? ''));
    expect(exact.length).toBeGreaterThan(0);
    // Запросы второй карты не попадают. Общий у обеих карт только запрос, где номер уже стоит маской: он неточный.
    expect(exact.filter((c) => twin.includes(c))).toEqual([]);
    const inexact = await inexactRows(page).evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.cid ?? ''));
    expect(inexact.length).toBeGreaterThan(0);
    expect(inexact.filter((c) => twinExact.includes(c))).toEqual([]);
    await expect(inexactRows(page).first()).toContainText('неточное совпадение');

    expect(page.url()).not.toContain(MOCK_SPECIAL.exactPan);
    expect(page.url()).not.toContain('411111');
    const text = await page.locator('body').innerText();
    expect(text).not.toContain(MOCK_SPECIAL.exactPan);
    expect(text).not.toContain(MOCK_SPECIAL.nonLuhnPan);
    expect(fullPans(text)).toEqual([]);
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain(MOCK_SPECIAL.exactPan);

    // «Все записи»: строк второй карты нет, строка с номером маской помечена неточной.
    await page.getByRole('tab', { name: 'Все записи' }).click();
    const lines = page.getByRole('list', { name: 'Все найденные строки' });
    await expect(page.getByText('Это все записи за период.')).toBeVisible();
    const lineCids = await lines
      .getByRole('link', { name: 'К запросу' })
      .evaluateAll((els) => els.map((el) => decodeURIComponent(/\/requests\/([^?]+)/.exec(el.getAttribute('href') ?? '')?.[1] ?? '')));
    expect(lineCids.length).toBeGreaterThan(0);
    expect(lineCids.filter((c) => twinExact.includes(c))).toEqual([]);
    await expect(lines.getByText('неточное совпадение').first()).toBeVisible();
    for (const b of await lines.locator('li[data-record-id] button[aria-expanded=false]').all()) await b.click();
    const linesText = await page.locator('body').innerText();
    expect(linesText).not.toContain(MOCK_SPECIAL.exactPan);
    expect(fullPans(linesText)).toEqual([]);
    await page.getByRole('tab', { name: 'Запросы' }).click();

    // На странице запроса номер тоже только маской, и в раскрытых блоках тоже.
    await exactRows(page).first().locator('[data-row-link]').click(ROW_HIT);
    await expect(page.getByTestId('request-header')).toBeVisible();
    await page.getByRole('tab', { name: /^Записи/ }).click();
    await expect(page.locator('li[data-record-id]').first()).toBeVisible();
    for (const b of await page.locator('li[data-record-id] button[aria-expanded=false]').all()) await b.click();
    const requestText = await page.locator('body').innerText();
    expect(requestText).not.toContain(MOCK_SPECIAL.exactPan);
    expect(requestText).not.toContain(MOCK_SPECIAL.twinPan);
    expect(requestText).not.toContain(MOCK_SPECIAL.nonLuhnPan);
    expect(fullPans(requestText)).toEqual([]);
  });

  test('маска: запросы обеих карт с пометкой «неточное совпадение»', async ({ page }) => {
    await page.goto('/pay/demo');
    await search(page, ['411111******7893'], '24 ч');
    await waitDone(page);
    const total = await rows(page).count();
    expect(total).toBeGreaterThan(0);
    await expect(rows(page).and(page.locator('[data-match=inexact]'))).toHaveCount(total);
    await expect(rows(page).first()).toContainText('неточное совпадение');
    // Подсказка объясняет, что маске могут соответствовать несколько карт.
    await rows(page).first().getByText('неточное совпадение').hover();
    await expect(page.getByRole('tooltip')).toContainText('Маске могут соответствовать несколько карт');
    expect(fullPans(await page.locator('body').innerText())).toEqual([]);
  });
});

test.describe('запрос api через шлюз и вложенные тела', () => {
  const user = MOCK_SPECIAL.gatewayUserId;
  const TRANSFER_FEE = /^POST \/v1\/users\/\{user\}\/transfers\/\{transfer\}\/fee$/;
  // У клиента в наборе и другие запросы, с ошибками тоже: запрос через шлюз — один из них.
  const feeRow = (page: Page) => rows(page).filter({ has: page.getByTestId('request-path').filter({ hasText: TRANSFER_FEE }) });

  /** Открывает запрос по user_id, который есть только в пути входа на шлюзе. */
  async function openGatewayRequest(page: Page) {
    await page.goto('/pay/demo');
    await search(page, [user], '24 ч');
    await waitDone(page);
    const row = feeRow(page);
    await expect(row).toHaveCount(1);
    await row.locator('[data-row-link]').click(ROW_HIT);
    await expect(page.getByTestId('request-header')).toBeVisible();
    await page.getByRole('tab', { name: /^Записи/ }).click();
  }

  test('user_id только в записи шлюза: запрос найден со всеми записями, вход из шлюза, компонент api', async ({ page }) => {
    await page.goto('/pay/demo');
    await search(page, [user], '24 ч');
    await waitDone(page);
    const row = feeRow(page);
    await expect(row).toHaveCount(1);
    // Путь шаблоном, user_id — меткой параметра, полный путь — в подсказке.
    await expect(row.getByTestId('request-path')).toHaveText(TRANSFER_FEE);
    await expect(row.getByTestId('request-path')).toHaveAttribute('title', new RegExp(`^POST /v1/users/${user}/transfers/[^/]+/fee$`));
    await expect(row.locator('[data-testid=param-chip][data-name=user]')).toHaveAttribute('data-value', user);
    await expect(row).toContainText('api');
    await expect(row).not.toContainText('фоновый');
    await expect(row).toHaveAttribute('data-status', 'success');

    await row.locator('[data-row-link]').click(ROW_HIT);
    const header = page.getByTestId('request-header');
    await expect(header.getByRole('heading', { level: 1 })).toHaveText(TRANSFER_FEE);
    await expect(header.getByRole('list', { name: 'Параметры пути' }).locator('[data-name=user]')).toHaveAttribute('data-value', user);
    // Вход шлюза, отправка и ответ api.
    await page.getByRole('tab', { name: /^Записи/ }).click();
    const records = page.locator('li[data-record-id]');
    await expect(records).toHaveCount(3);
    expect(await records.evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.kind))).toEqual(['incoming', 'send', 'response']);
    const incoming = records.first();
    // Путь — шаблоном, user_id — меткой параметра.
    await expect(incoming.getByTestId('record-title')).toHaveText(TRANSFER_FEE);
    await expect(incoming.locator('[data-testid=param-chip][data-name=user]')).toHaveAttribute('data-value', user);
    await expect(incoming).toContainText('DEBUG');
    await incoming.locator('button[aria-expanded]').first().click();
    // Заголовок Authorization из сырого HTTP-запроса шлюза замаскирован.
    const headers = incoming.locator('[data-block=headers]');
    await headers.locator('button[aria-expanded]').click();
    await expect(headers.locator('pre')).toContainText('Authorization: Bearer ***');
    await expect(headers.locator('pre')).toContainText('X-Correlation-Id: ');

    // В «Всех записях» есть и строка шлюза [GIN] без correlation_id: методом и путём шаблоном, с пометкой «шлюз».
    // В имитации она из контейнера gateway — шлюз по метке профиля; без флага сервера текст [GIN] остаётся текстом.
    await page.goBack();
    await page.getByRole('tab', { name: 'Все записи' }).click();
    const gin = page.getByRole('list', { name: 'Все найденные строки' }).locator('li[data-kind=text]').filter({ hasText: 'шлюз' });
    await expect(gin.filter({ hasText: '/transfers/' }).first().getByTestId('record-title')).toHaveText(/^POST \/v1\/users\/\{user\}\/transfers\/\{transfer\}\/fee → 200$/);
  });

  test('вложенные тела: SOAP в JSON, JSON в теге и в CDATA — отдельными блоками, номер карты замаскирован', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openGatewayRequest(page);

    const send = page.locator('li[data-kind=send]').first();
    await send.locator('button[aria-expanded]').first().click();
    const sendNested = send.getByRole('group', { name: 'Вложенные тела' });
    await expect(sendNested.locator('[data-block=nested]')).toHaveCount(3);
    const titles = await sendNested.locator('[data-block=nested] button[aria-expanded] span').allTextContents();
    expect(titles).toEqual([
      'envelope · XML',
      'envelope.Envelope.Body.checkFee.payload · JSON',
      'envelope.Envelope.Body.checkFee.payload.card · JSON',
    ]);
    // SOAP-конверт — с отступами по тегам, JSON третьего уровня — с отступами и маской номера.
    expect(await sendNested.locator('[data-block=nested] pre').first().textContent()).toMatch(/\n {4}<fs:checkFee>/);
    const card = sendNested.locator('[data-block=nested]').nth(2);
    await expect(card.locator('pre')).toHaveText(/"number": "676712\*{6}\d{4}"/);
    await card.getByRole('button', { name: /^Копировать/ }).click();
    await expect(card.getByRole('button', { name: /^Скопировано/ })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/^\{\n {2}"number": "676712\*{6}\d{4}"/);

    const response = page.locator('li[data-kind=response]').first();
    await response.locator('button[aria-expanded]').first().click();
    const responseNested = response.getByRole('group', { name: 'Вложенные тела' });
    await expect(responseNested.locator('[data-block=nested] button[aria-expanded] span')).toHaveText(['Envelope.Body.checkFeeResponse.details · JSON']);
    await expect(responseNested.locator('pre')).toContainText('"check_iss_acq_fees": "confirmed"');

    for (const b of await page.locator('li[data-record-id] > div > button[aria-expanded=false]').all()) await b.click();
    expect(fullPans(await page.locator('body').innerText())).toEqual([]);
  });
});

test.describe('страница запроса по ссылке', () => {
  test('неверный correlation_id в адресе', async ({ page }) => {
    await page.goto(`/pay/demo/requests/${encodeURIComponent('a b"c')}?from=1&to=2`);
    await expect(page.getByRole('heading', { name: 'Ссылка на запрос неверная' })).toBeVisible();
    // Следующий шаг — новый поиск в этой среде.
    await expect(page.getByRole('link', { name: 'Искать в среде' })).toHaveAttribute('href', '/pay/demo');
  });

  test('записей нет', async ({ page }) => {
    const now = Date.now();
    await page.goto(`/pay/demo/requests/no-such-cid?from=${now - 60_000}&to=${now}`);
    await expect(page.getByRole('heading', { name: 'Записей запроса за этот период нет' })).toBeVisible();
    await page.getByRole('link', { name: 'Искать в среде' }).click();
    await expect(page).toHaveURL(/\/pay\/demo$/);
    await expect(page.getByRole('textbox', { name: 'Значения для поиска' })).toBeVisible();
  });
});

test.describe('поиск: раскладка и доступность', () => {
  test('путь запроса в строке — шаблоном целиком, строки одной высоты, причина — по наведению', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/pay/demo');
    await search(page, ['fraud.pay.example'], '24 ч');
    await waitDone(page);
    const row = rows(page).first();
    const path = row.getByTestId('request-path');
    // Конец пути отличает запросы друг от друга: идентификаторы заменены параметрами, и путь помещается без обрезки.
    await expect(path).toHaveText('GET /v1/users/{user}/cards/{card}/balance');
    await expect(path).toHaveAttribute('title', /^GET \/v1\/users\/[0-9a-f-]{36}\/cards\/[0-9a-f-]{36}\/balance$/);
    const [scroll, client] = await path.evaluate((el) => [el.scrollWidth, el.clientWidth]);
    expect(scroll).toBeLessThanOrEqual(client);
    // Длинная причина не переносится и не меняет высоту строки: все строки одной высоты.
    const heights = await rows(page).evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().height)));
    expect(new Set(heights).size).toBe(1);
    const reason = row.getByTestId('request-reason');
    await expect(reason).toHaveAttribute('title', /ответ не найден/);
  });

  test('768px: результаты и запрос без горизонтальной прокрутки', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto('/pay/demo');
    await search(page, ['getCard'], '24 ч');
    await waitDone(page);
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(await overflow()).toBeLessThanOrEqual(0);
    await rows(page).and(page.locator('[data-status=error]')).first().locator('[data-row-link]').click(ROW_HIT);
    // По умолчанию — схема и подробности шага с ошибкой: в данных шага есть строка его ответа.
    await expect(dataRow(page, 'Ответ')).toBeVisible();
    expect(await overflow()).toBeLessThanOrEqual(0);
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`доступность и контраст результатов и запроса, ${scheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto('/pay/demo');
      await search(page, ['getCard'], '24 ч');
      await waitDone(page);
      const check = async (where: string) => {
        const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
        expect(r.violations.map((v) => `${where}: ${v.id} ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
      };
      await check('results');
      await rows(page).and(page.locator('[data-status=error]')).first().locator('[data-row-link]').click(ROW_HIT);
      await expect(page.getByTestId('request-header')).toBeVisible();
      await check('request');
    });
  }
});

test.describe('поиск по телефону: одна метка, все написания', () => {
  const PHONE = '+44 7700 900001';

  test('метка показывает 447700900001, в подсказке введённое, 768px без горизонтальной прокрутки', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 900 });
    await page.goto('/pay/demo');
    await addTerms(page, [PHONE]);
    const chips = page.getByTestId('term-chip');
    await expect(chips).toHaveCount(1);
    await expect(chips.first()).toHaveText(/телефон\s*447700900001/);
    await expect(chips.first().locator('[title]')).toHaveAttribute('title', PHONE);
    // Другое написание того же номера второй метки не даёт.
    await addTerms(page, ['07700 900001']);
    await expect(chips).toHaveCount(1);
    expect(await noScroll(page)).toBe(true);
    // Полного номера карты нет ни в тексте, ни в атрибутах метки.
    await addTerms(page, [MOCK_SPECIAL.exactPan]);
    await expect(chips).toHaveCount(2);
    expect(await page.getByTestId('search-panel').innerHTML()).not.toContain(MOCK_SPECIAL.exactPan);
    expect(await noScroll(page)).toBe(true);
  });

  test('поиск находит все написания, в поле 447700900001, в теле маска', async ({ page }) => {
    await page.goto('/pay/demo');
    await search(page, [PHONE]);
    await waitDone(page);
    expect((await cidsOf(page)).sort()).toEqual(MOCK_PHONE.spellings.map((_, i) => MOCK_PHONE.cid(i)).sort());
    await expect(page.getByTestId('term-chip').first()).toHaveText(/телефон\s*447700900001/);
    await page.locator(`li[data-cid="${MOCK_PHONE.cid(1)}"] [data-row-link]`).click(ROW_HIT);
    await expect(page.getByTestId('request-header')).toBeVisible();
    await page.getByRole('tab', { name: /^Записи/ }).click();
    const incoming = page.locator('li[data-kind=incoming]').first();
    await incoming.locator('button[aria-expanded]').first().click();
    await expect(incoming.locator('[data-block=body] pre')).toContainText('+********0001');
    expect(await page.locator('body').innerText()).not.toContain('+447700900001');
  });
});

test.describe('кнопка «Открыть в Grafana»', () => {
  const LINK = 'https://grafana.example.internal/explore?left=%7B%7D';
  const link = (page: Page) => page.getByTestId('explore-link');
  const ok = { url: LINK, wider: true, typed: true };

  /** В имитации ссылки нет: поле подставляется в ответы состояния поиска и страницы запроса. */
  async function injectExplore(page: Page, explore: object, extra: object = {}) {
    await page.route(/\/api\/searches\/[^/?]+(\?.*|\/requests\/[^/?]+)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const res = await route.fetch();
      if (!res.ok()) return route.fulfill({ response: res });
      return route.fulfill({ response: res, json: { ...((await res.json()) as object), explore, ...extra } });
    });
  }

  async function geometry(page: Page) {
    const [summary, tabs] = await Promise.all([page.getByTestId('results-summary').boundingBox(), page.getByRole('tablist').first().boundingBox()]);
    return { summaryY: summary!.y, tabsY: tabs!.y };
  }

  test('в демо кнопки нет ни в результатах, ни в запросе', async ({ page }) => {
    await page.goto('/pay/demo');
    await search(page, ['getCard'], '24 ч');
    await waitDone(page);
    await expect(link(page)).toHaveCount(0);
    await rows(page).first().locator('[data-row-link]').click(ROW_HIT);
    await expect(page.getByTestId('request-header')).toBeVisible();
    // В запросе переход в хранилище — пункт меню «⋯». На широком окне в меню больше ничего нет: без ссылки нет и меню.
    await expect(page.getByTestId('request-more')).toHaveCount(0);
    await expect(link(page)).toHaveCount(0);
  });

  test('атрибуты ссылки, подсказки, страница сама никуда не обращается', async ({ page }) => {
    const hosts = new Set<string>();
    page.on('request', (r) => hosts.add(new URL(r.url()).host));
    await injectExplore(page, ok);
    await page.goto('/pay/demo');
    await search(page, ['getCard'], '24 ч');
    await waitDone(page);
    await expect(link(page)).toHaveAttribute('href', LINK);
    await expect(link(page)).toHaveAttribute('target', '_blank');
    await expect(link(page)).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(link(page)).toHaveAttribute('data-wider', 'true');
    await expect(link(page)).toHaveAttribute('data-typed', 'true');
    await link(page).hover();
    await expect(page.getByRole('tooltip').first()).toContainText('Grafana может показать больше строк');
    await expect(page.getByRole('tooltip').first()).toContainText('адрес и историю браузера');
    await rows(page).first().locator('[data-row-link]').click(ROW_HIT);
    await expect(page.getByTestId('request-header')).toBeVisible();
    // В запросе ссылка — в меню «⋯» шапки.
    const more = await openMore(page);
    await expect(more.getByTestId('explore-link')).toHaveAttribute('href', LINK);
    expect([...hosts]).toEqual([new URL(page.url()).host]);
  });

  test('недоступное состояние: без адреса, причина и с клавиатуры', async ({ page }) => {
    await injectExplore(page, { url: null, reason: 'unsafe' });
    await page.goto('/pay/demo');
    await search(page, ['getCard'], '24 ч');
    await waitDone(page);
    await expect(link(page)).toHaveAttribute('aria-disabled', 'true');
    expect(await link(page).getAttribute('href')).toBeNull();
    await link(page).focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(link(page)).toBeFocused();
    await expect(page.getByRole('tooltip').first()).toContainText('значение поиска нельзя передать в адресе');
  });

  for (const width of [768, 2560]) {
    test(`${width}px: строка итога и шапка запроса те же с кнопкой и без, завершение поиска ничего не сдвигает`, async ({ page, context }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/pay/demo');
      await search(page, ['getCard'], '24 ч');
      await waitDone(page);
      const resultsUrl = page.url();
      // Отметка «из памяти» есть только во вкладке, запустившей поиск: сравниваются две открытые по адресу страницы.
      await page.reload();
      await waitDone(page);
      const plain = await geometry(page);
      const firstCid = (await cidsOf(page))[0]!;
      await rows(page).first().locator('[data-row-link]').click(ROW_HIT);
      await expect(page.getByTestId('request-header')).toBeVisible();
      const headerPlain = (await page.getByTestId('request-header').boundingBox())!;
      const requestUrl = page.url();

      const shown = await context.newPage();
      await shown.setViewportSize({ width, height: 900 });
      await injectExplore(shown, ok);
      await shown.goto(resultsUrl);
      await expect(link(shown)).toBeVisible();
      expect(await geometry(shown)).toEqual(plain);
      expect(await noScroll(shown)).toBe(true);
      await shown.locator(`li[data-cid="${firstCid}"] [data-row-link]`).click(ROW_HIT);
      await expect(shown.getByTestId('request-header')).toBeVisible();
      // Ссылка в запросе — пункт меню «⋯»: меню открывается поверх, шапка той же высоты.
      const more = await openMore(shown);
      await expect(more.getByTestId('explore-link')).toBeVisible();
      await shown.keyboard.press('Escape');
      await expect(more).toHaveCount(0);
      expect((await shown.getByTestId('request-header').boundingBox())!.height).toBe(headerPlain.height);
      expect(await noScroll(shown)).toBe(true);
      expect(shown.url()).toBe(requestUrl);
      await shown.close();

      // Поиск будто идёт, потом завершается: кнопка на месте, строка не меняет высоту.
      const running = await context.newPage();
      await running.setViewportSize({ width, height: 900 });
      await injectExplore(running, ok, { status: 'running' });
      await running.goto(resultsUrl);
      await expect(link(running)).toBeVisible();
      const during = await geometry(running);
      await running.unroute(/\/api\/searches\/[^/?]+(\?.*|\/requests\/[^/?]+)?$/);
      await injectExplore(running, ok);
      await expect(results(running)).toHaveAttribute('data-status', 'done');
      expect(await geometry(running)).toEqual(during);
      await running.close();
    });
  }
});

test.describe('свой период: вокруг времени', () => {
  const custom = (page: Page) => periodGroup(page).getByRole('button', { name: /^Свой/ });
  const dialogOf = (page: Page) => page.getByRole('dialog');
  const modeButton = (page: Page, name: 'Границы' | 'Вокруг времени') => dialogOf(page).getByRole('group', { name: 'Как задать период' }).getByRole('button', { name });
  const timeField = (page: Page) => dialogOf(page).getByLabel('Время', { exact: true });
  const iso = (ms: number) => new Date(ms + 5 * H).toISOString().replace('Z', '+05:00');
  /** «02.11 16:20»: так время пишется на кнопке периода. */
  const label = (ms: number) => {
    const [date, time] = epochToLocalInput(ms, TZ).split('T') as [string, string];
    const [, month, day] = date.split('-');
    return `${day}.${month} ${time.slice(0, 5)}`;
  };
  const postsOf = (page: Page) => {
    const posts: unknown[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().endsWith('/searches')) posts.push(r.postDataJSON());
    });
    return posts;
  };
  async function openAround(page: Page) {
    await custom(page).click();
    await modeButton(page, 'Вокруг времени').click();
  }
  /** Свой период внутри вчерашнего дня: на кнопке дата одна. */
  async function setOneDay(page: Page) {
    const day = epochToLocalInput(Date.now() - 24 * H, TZ).slice(0, 10);
    await custom(page).click();
    await modeButton(page, 'Границы').click();
    await dialogOf(page).getByLabel('Начало').fill(`${day}T09:00`);
    await dialogOf(page).getByLabel('Конец').fill(`${day}T10:00`);
    await dialogOf(page).getByRole('button', { name: 'Применить' }).click();
    await expect(dialogOf(page)).toBeHidden();
  }

  test('вставка времени со смещением: итог, запись на кнопке, поиск за нужные границы', async ({ page }) => {
    const at = Date.now() - 2 * H;
    await page.goto('/pay/demo');
    await openAround(page);
    await timeField(page).fill(iso(at));
    await expect(page.getByTestId('period-message')).toContainText('→');
    await dialogOf(page).getByRole('button', { name: '±30', exact: true }).click();
    await dialogOf(page).getByRole('button', { name: 'Применить' }).click();
    await expect(custom(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(custom(page)).toContainText(`${label(at)} ±30 мин`);
    const body = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/searches'));
    await search(page, ['getCard']);
    const sent = (await body).postDataJSON() as { period: Record<string, number> };
    expect(sent.period).toEqual({ fromMs: at - 30 * 60_000, toMs: at + 30 * 60_000 });
    await waitDone(page);
  });

  test('размер окна не меняется при смене режима и при самом длинном сообщении', async ({ page }) => {
    await page.goto('/pay/demo');
    await custom(page).click();
    const size = async () => {
      // Окно появляется с анимацией масштаба: мерить после неё.
      await dialogOf(page).evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
      const b = (await dialogOf(page).boundingBox())!;
      return { width: b.width, height: b.height };
    };
    const start = await size();
    await modeButton(page, 'Вокруг времени').click();
    expect(await size()).toEqual(start);
    const message = page.getByTestId('period-message');
    for (const text of ['вчера', '2026-11-04', iso(Date.now() + 3 * H), iso(Date.now() - 40 * 24 * H)]) {
      await timeField(page).fill(text);
      await dialogOf(page).getByRole('button', { name: 'Применить' }).click();
      await expect(dialogOf(page).getByRole('alert')).toBeVisible();
      expect(await size()).toEqual(start);
      // Сообщение помещается целиком.
      expect(await message.evaluate((el) => el.scrollHeight <= el.clientHeight)).toBe(true);
    }
    await modeButton(page, 'Границы').click();
    expect(await size()).toEqual(start);
  });

  test('Enter применяет и не запускает поиск, адрес не меняется', async ({ page }) => {
    const posts = postsOf(page);
    await page.goto('/pay/demo');
    await addTerms(page, ['getCard']);
    const url = page.url();
    await openAround(page);
    await timeField(page).fill(iso(Date.now() - H));
    await timeField(page).press('Enter');
    await expect(dialogOf(page)).toBeHidden();
    await expect(custom(page)).toHaveAttribute('aria-pressed', 'true');
    await page.waitForTimeout(300);
    expect(posts).toEqual([]);
    expect(page.url()).toBe(url);
  });

  test('смена среды и возврат из запроса сохраняют режим и текст, перезагрузка показывает границы', async ({ page }) => {
    // Окно 1–3 ч назад: телефонные запросы имитации лежат в нём всё время прогона.
    const text = iso(Date.now() - 2 * H);
    const envSelect = page.getByRole('main').getByRole('combobox', { name: /^Среда:/ });
    const expectAround = async () => {
      await custom(page).click();
      await expect(modeButton(page, 'Вокруг времени')).toHaveAttribute('aria-pressed', 'true');
      await expect(timeField(page)).toHaveValue(text);
      await dialogOf(page).getByRole('button', { name: 'Отмена' }).click();
      await expect(dialogOf(page)).toBeHidden();
    };
    await page.goto('/pay/demo');
    await openAround(page);
    await timeField(page).fill(text);
    await dialogOf(page).getByRole('button', { name: '±60', exact: true }).click();
    await dialogOf(page).getByRole('button', { name: 'Применить' }).click();
    await envSelect.click();
    await page.getByRole('option', { name: 'Slow', exact: true }).click();
    await expect(page).toHaveURL(/\/pay\/slow/);
    await expectAround();
    await envSelect.click();
    await page.getByRole('option', { name: 'Demo', exact: true }).click();
    await expect(page).toHaveURL(/\/pay\/demo/);
    await expectAround();

    await search(page, ['+44 7700 900001']);
    await waitDone(page);
    await rows(page).first().locator('[data-row-link]').click(ROW_HIT);
    await expect(page.getByTestId('request-header')).toBeVisible();
    await page.getByRole('link', { name: 'К результатам' }).click();
    await expect(rows(page).first()).toBeVisible();
    await expectAround();

    await page.reload();
    await waitDone(page);
    await expect(custom(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(custom(page)).toContainText('–');
    await expect(custom(page)).not.toContainText('±');
  });

  for (const width of [768, 2560]) {
    test(`${width}px: высота карточки та же, что при своём периоде в один день`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/pay/demo');
      const panel = page.getByTestId('search-panel');
      await setOneDay(page);
      const range = (await panel.boundingBox())!;
      const find = (await findButton(page).boundingBox())!;
      await openAround(page);
      await timeField(page).fill(iso(Date.now() - H));
      await dialogOf(page).getByRole('button', { name: 'Применить' }).click();
      await expect(dialogOf(page)).toBeHidden();
      await expect(custom(page)).toContainText('±15 мин');
      expect((await panel.boundingBox())!.height).toBe(range.height);
      expect((await findButton(page).boundingBox())!.y).toBe(find.y);
      expect(await noScroll(page)).toBe(true);
    });
  }

  test('низкое окно: окно периода на экране и доступно с клавиатуры', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 480 });
    await page.goto('/pay/demo');
    await openAround(page);
    const box = (await dialogOf(page).boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(480);
    await timeField(page).focus();
    const apply = dialogOf(page).getByRole('button', { name: 'Применить' });
    for (let i = 0; i < 10; i++) {
      if (await apply.evaluate((el) => el === document.activeElement)) break;
      await page.keyboard.press('Tab');
    }
    await expect(apply).toBeFocused();
    await expect(apply).toBeInViewport({ ratio: 1 });
  });

  test('часы браузера спешат: панель показывает ошибку периода от сервера', async ({ page }) => {
    const ahead = Date.now() + 3 * 24 * H;
    await page.clock.setFixedTime(ahead);
    await page.goto('/pay/demo');
    await openAround(page);
    await timeField(page).fill(iso(ahead - H));
    await dialogOf(page).getByRole('button', { name: 'Применить' }).click();
    await expect(dialogOf(page)).toBeHidden();
    await addTerms(page, ['getCard']);
    await findButton(page).click();
    await expect(alert(page)).toContainText('период');
    await expect(results(page)).toHaveCount(0);
  });
});

test.describe('исключённые значения', () => {
  const excludeInput = (page: Page) => page.getByRole('textbox', { name: 'Не содержит' });
  const toggle = (page: Page) => page.getByTestId('exclude-toggle');

  test('подсказка в «Кратко» без «Всех записей» и Grafana', async ({ page }) => {
    await page.goto('/pay/demo');
    await addTerms(page, ['getCard']);
    await findButton(page).click();
    await setViewMode(page, 'Кратко');
    await toggle(page).click();
    const hint = page.getByTestId('exclude-hint');
    await expect(hint).toContainText('Убирает из списка запрос целиком');
    await expect(hint).not.toContainText('Все');
    await expect(hint).not.toContainText('Grafana');
    await setViewMode(page, 'Подробно');
    await expect(hint).toContainText('Grafana');
  });

  test('поле за «Уточнить»: закрыто сначала, пустое закрывается, заполненное нет, подсказка про другие записи', async ({ page }) => {
    await page.goto('/pay/demo');
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(excludeInput(page)).toHaveCount(0);
    await toggle(page).click();
    await expect(excludeInput(page)).toBeFocused();
    await expect(page.getByTestId('exclude-hint')).toContainText('убирает запрос целиком');
    await toggle(page).click();
    await expect(excludeInput(page)).toHaveCount(0);
    await toggle(page).click();
    await excludeInput(page).fill('ok');
    await excludeInput(page).press('Enter');
    await expect(toggle(page)).toContainText('1');
    await toggle(page).click();
    await expect(excludeInput(page)).toBeVisible();
  });

  test('значение есть в запросе: его нет в списке, строк нет во «Всех записях»; значения нет в адресе и браузере', async ({ page }) => {
    await page.goto('/pay/demo');
    await search(page, ['getCard'], '24 ч');
    await waitDone(page);
    const before = await rows(page).count();
    await page.goto('/pay/demo');
    await toggle(page).click();
    // Значение остаётся в поле без Enter: оно идёт в поиск, как и недописанное значение основного поля.
    await excludeInput(page).fill('getCardResponse');
    await search(page, ['getCard'], '24 ч');
    await waitDone(page);
    await expect(page.getByTestId('exclude-field').getByTestId('term-chip')).toHaveCount(1);
    expect(new URL(page.url()).search).toMatch(/^\?search=[^&]+$/);
    const stored = await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }, history.state]));
    expect(stored).not.toContain('getCardResponse');
    const after = await rows(page).count();
    expect(after).toBeGreaterThan(0);
    expect(after).toBeLessThan(before);
    await page.getByRole('tab', { name: 'Все записи' }).click();
    await expect(page.getByTestId('search-results').locator('[data-record-id]').first()).toBeVisible();
    await expect(page.getByTestId('search-results')).not.toContainText('getCardResponse');
  });

  test('оставшийся запрос открыт целиком: те же статус и записи, надписей о скрытых строках нет', async ({ page }) => {
    await page.goto('/pay/demo');
    await search(page, ['getCard'], '24 ч');
    await waitDone(page);
    const plain = await rows(page).evaluateAll((els) => Object.fromEntries(els.map((el) => [(el as HTMLElement).dataset.cid, (el as HTMLElement).dataset.status])));
    await page.goto('/pay/demo');
    await toggle(page).click();
    await excludeInput(page).fill('getBalance');
    await search(page, ['getCard'], '24 ч');
    await waitDone(page);
    const left = await rows(page).evaluateAll((els) => Object.fromEntries(els.map((el) => [(el as HTMLElement).dataset.cid, (el as HTMLElement).dataset.status])));
    expect(Object.keys(left).length).toBeGreaterThan(0);
    expect(Object.keys(left).length).toBeLessThan(Object.keys(plain).length);
    for (const [cid, status] of Object.entries(left)) expect(status).toBe(plain[cid]);
    await expect(page.getByTestId('search-results')).not.toContainText('скрыть');
    await rows(page).and(page.locator('[data-status=error]')).first().locator('[data-row-link]').click(ROW_HIT);
    const request = page.getByTestId('request-page');
    await expect(page.getByTestId('request-header')).toContainText('Ошибка');
    await expect(request).not.toContainText('Показать запрос целиком');
    await expect(request).not.toContainText('скрыть ответ', { ignoreCase: true });
    await expect(request).not.toContainText('ответ ещё не пришёл', { ignoreCase: true });
  });

  test('условие убрало все найденные запросы: сообщение об этом, строки во «Всех записях», «К запросу» открывает запрос целиком', async ({ page }) => {
    await page.goto('/pay/demo');
    await search(page, ['getCard'], '24 ч');
    await waitDone(page);
    const cid = await rows(page).and(page.locator('[data-status=success]')).first().getAttribute('data-cid');
    await page.goto('/pay/demo');
    await toggle(page).click();
    await excludeInput(page).fill('getCardResponse');
    await search(page, [cid!], '24 ч');
    await waitDone(page);
    const notice = page.locator('[data-notice=only-lines]');
    await expect(notice).toContainText('Запросов не осталось');
    await expect(notice).toContainText('Не содержит');
    await expect(notice).not.toContainText('correlation_id');
    const line = page.getByTestId('lines').locator('[data-record-id]').first();
    await expect(line).toBeVisible();
    await expect(page.getByTestId('search-results')).not.toContainText('getCardResponse');
    await page.getByTestId('lines').getByRole('link', { name: 'К запросу' }).first().click();
    await expect(page.getByTestId('request-header')).toContainText('Успешно');
    await page.getByRole('tab', { name: /^Записи/ }).click();
    await expect(page.getByRole('list', { name: 'Записи запроса' }).locator('li[data-record-id]').first()).toBeVisible();
    await expect(page.getByTestId('request-page')).toContainText('getCard');
  });

  test('только короткое значение поиска: исключённое правило о 6 символах не закрывает', async ({ page }) => {
    await page.goto('/pay/demo');
    await toggle(page).click();
    await excludeInput(page).fill('getCard');
    await excludeInput(page).press('Enter');
    await addTerms(page, ['pay']);
    await findButton(page).click();
    await expect(alert(page)).toContainText('от 6 символов');
    await expect(page).toHaveURL(/\/pay\/demo$/);
  });

  test('неверные значения: один символ, шестое значение и значение из поиска не проходят', async ({ page }) => {
    await page.goto('/pay/demo');
    await toggle(page).click();
    await excludeInput(page).fill('7');
    await excludeInput(page).press('Enter');
    await expect(page.getByTestId('exclude-error')).toContainText('2 символов');
    await excludeInput(page).fill('aa, bb, cc, dd, ee, ff');
    await excludeInput(page).press('Enter');
    await expect(page.getByTestId('exclude-error')).toContainText('Не больше 5');
    await expect(excludeInput(page)).toHaveValue('ff');
    await excludeInput(page).fill('');
    await addTerms(page, ['abcdef-значение']);
    await page.getByRole('button', { name: 'Убрать значение aa' }).click();
    await excludeInput(page).fill('abcdef');
    await excludeInput(page).press('Enter');
    await findButton(page).click();
    await expect(page.getByTestId('exclude-error')).toContainText('есть в поиске');
    await expect(page).toHaveURL(/\/pay\/demo$/);
  });

  test('перезагрузка: значения из состояния, номер карты маской, новый поиск просит ввести его заново', async ({ page }) => {
    await page.goto('/pay/demo');
    await toggle(page).click();
    await excludeInput(page).fill(MOCK_SPECIAL.exactPan);
    await excludeInput(page).press('Enter');
    await expect(page.getByTestId('exclude-field')).not.toContainText(MOCK_SPECIAL.exactPan);
    await search(page, ['getCard'], '24 ч');
    await waitDone(page);
    await page.reload();
    await waitDone(page);
    await expect(page.getByTestId('exclude-field').getByTestId('term-chip')).toContainText(MOCK_SPECIAL.maskedPan);
    await findButton(page).click();
    await expect(page.getByTestId('exclude-error')).toContainText('введите заново');
  });
});

test.describe('фильтры результатов', () => {
  const filter = (page: Page, name: string) => page.getByTestId(`filter-${name}`);
  const openFilters = (page: Page) => page.getByTestId('filters-toggle').click();
  const pick = async (page: Page, name: string, option: string) => {
    await openFilters(page);
    await filter(page, name).click();
    await page.getByRole('option', { name: option, exact: true }).click();
  };

  test('компонент: скрытые строки посчитаны, сброс возвращает, запросов к серверу нет, новый поиск сбрасывает', async ({ page }) => {
    await page.goto('/pay/demo');
    // Строка операции читает первый запрос после окончания поиска: фильтр к этому не относится. Состояние networkidle одно на документ и наступает ещё до поиска, поэтому ждём сам ответ.
    const stripRead = page.waitForResponse((r) => /^\/api\/searches\/[^/]+\/requests\//.test(new URL(r.url()).pathname));
    await search(page, ['pay.example'], '24 ч');
    await waitDone(page);
    const total = await rows(page).count();
    expect(total).toBeGreaterThan(1);
    await stripRead;
    const asked: string[] = [];
    page.on('request', (r) => {
      if (new URL(r.url()).pathname.startsWith('/api/search')) asked.push(r.url());
    });
    await pick(page, 'component', 'cards');
    await expect(rows(page).first()).toBeVisible();
    const shown = await rows(page).count();
    expect(shown).toBeLessThan(total);
    await expect(page.getByTestId('filters-hidden')).toHaveText(`Скрыто фильтрами: ${total - shown}`);
    await expect(page.getByTestId('results-summary')).toContainText(String(total));
    expect(new URL(page.url()).search).toMatch(/^\?search=[^&]+$/);
    await page.getByTestId('filters-reset').click();
    await expect(rows(page)).toHaveCount(total);
    await expect(page.getByTestId('filters-hidden')).toHaveCount(0);
    expect(asked).toEqual([]);

    await page.keyboard.press('Escape');
    await pick(page, 'component', 'cards');
    await expect(page.getByTestId('filters-hidden')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Обновить' }).click();
    await waitDone(page);
    await expect(page.getByTestId('filters-hidden')).toHaveCount(0);
    await expect(rows(page)).toHaveCount(total);
  });

  test('сочетание с «Только с ошибкой», возврат со страницы запроса оставляет фильтр', async ({ page }) => {
    await page.goto('/pay/demo');
    await search(page, ['pay.example'], '24 ч');
    await waitDone(page);
    await pick(page, 'component', 'cards');
    await page.keyboard.press('Escape');
    await page.getByRole('switch', { name: /Только с ошибкой/ }).click();
    const shown = await rows(page).count();
    expect(shown).toBeGreaterThan(0);
    for (const status of await rows(page).evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.status))) expect(status).toBe('error');
    await rows(page).first().locator('[data-row-link]').click(ROW_HIT);
    await expect(page.getByTestId('request-header')).toBeVisible();
    await page.goBack();
    await expect(rows(page)).toHaveCount(shown);
    await openFilters(page);
    await expect(filter(page, 'component')).toContainText('cards');
  });

  test('«Кратко»: фильтра компонента нет, скрытые им строки вернулись; в значениях системы нет адреса', async ({ page }) => {
    await page.goto('/pay/demo');
    await search(page, ['pay.example'], '24 ч');
    await waitDone(page);
    const total = await rows(page).count();
    await pick(page, 'component', 'cards');
    await expect(page.getByTestId('filters-hidden')).toBeVisible();
    await page.keyboard.press('Escape');
    await setViewMode(page, 'Кратко');
    await expect(rows(page)).toHaveCount(total);
    await openFilters(page);
    await expect(filter(page, 'component')).toHaveCount(0);
    await filter(page, 'system').click();
    const names = await page.getByRole('option').allTextContents();
    expect(names.length).toBeGreaterThan(1);
    for (const name of names) expect(name).not.toMatch(/\d+\.\d+\.\d+\.\d+|:\d{2,5}/);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await setViewMode(page, 'Подробно');
    await openFilters(page);
    await expect(filter(page, 'component')).not.toContainText('cards');
  });

  test('768 пикселей: фильтры переносятся, горизонтальной прокрутки нет', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 900 });
    await page.goto('/pay/demo');
    await search(page, ['pay.example'], '24 ч');
    await waitDone(page);
    await pick(page, 'component', 'cards');
    await expect(page.getByTestId('result-filters')).toBeVisible();
    expect(await noScroll(page)).toBe(true);
  });
});

test.describe('строка поиска и таблица в рабочем режиме', () => {
  const firstRow = (page: Page) => page.locator('[data-row-link]').first();

  test('прокручивается только таблица, шапка закреплена, время без миллисекунд, день разделителем', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 785 });
    await page.goto('/pay/demo');
    await search(page, ['pay.example'], '24 ч');
    await waitDone(page);
    const frame = page.getByTestId('requests-frame');
    const head = frame.locator('> div').first();
    const headY = (await head.boundingBox())!.y;
    await frame.evaluate((el) => el.scrollTo(0, 400));
    await expect.poll(() => frame.evaluate((el) => el.scrollTop)).toBe(400);
    expect((await head.boundingBox())!.y).toBe(headY);
    expect(await page.evaluate(() => [window.scrollY, document.documentElement.scrollHeight - innerHeight])).toEqual([0, 0]);

    const time = rows(page).first().getByTestId('request-time');
    await expect(time).toHaveText(/^\d\d:\d\d:\d\d$/);
    await expect(time).toHaveAttribute('title', /^\d\d\.\d\d\.\d{4} \d\d:\d\d:\d\d,\d{3}$/);
    // Разделитель не строка списка и не ссылка.
    const day = page.locator('[data-day]').first();
    await expect(day).toHaveText(/^(Сегодня|Вчера) · \d\d\.\d\d$/);
    expect(await rows(page).evaluateAll((els) => els.every((el) => (el as HTMLElement).dataset.cid))).toBe(true);
  });

  test('возврат со страницы запроса: прокрутка таблицы и фокус строки на месте', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 785 });
    await page.goto('/pay/demo');
    await search(page, ['pay.example'], '24 ч');
    await waitDone(page);
    const frame = page.getByTestId('requests-frame');
    await frame.evaluate((el) => el.scrollTo(0, 400));
    const row = rows(page).nth(10);
    const cid = (await row.getAttribute('data-cid'))!;
    await row.locator('[data-row-link]').click(ROW_HIT);
    await expect(page.getByTestId('request-header')).toBeVisible();
    await page.goBack();
    await expect(page.locator(`li[data-cid="${cid}"] [data-row-link]`)).toBeFocused();
    await expect(page.locator(`li[data-cid="${cid}"]`)).toHaveAttribute('data-current', 'true');
    expect(await frame.evaluate((el) => el.scrollTop)).toBe(400);
  });

  test('сообщение после поиска не двигает таблицу', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 785 });
    const STATE = /\/api\/searches\/[^/?]+(\?.*)?$/;
    await page.route(STATE, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const res = await route.fetch();
      await route.fulfill({ response: res, json: { ...((await res.json()) as object), status: 'running' } });
    });
    await page.goto('/pay/demo');
    await search(page, ['pay.example'], '24 ч');
    await expect(firstRow(page)).toBeVisible();
    await expect(page.getByTestId('search-progress-text')).toBeVisible();
    await expect(page.getByTestId('results-summary')).toContainText('пока');
    const before = (await firstRow(page).boundingBox())!.y;
    await page.unroute(STATE);
    await page.route(STATE, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const res = await route.fetch();
      await route.fulfill({ response: res, json: { ...((await res.json()) as object), truncated: true } });
    });
    await expect(page.locator('[data-notice=truncated]')).toBeVisible();
    expect((await firstRow(page).boundingBox())!.y).toBe(before);
  });

  test('поиск по id операции: строка операции под таблицей, таблица на месте', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 785 });
    // Ключ подставлен: в наборе имитации он есть не у первого найденного запроса, а строка читает только его.
    await page.route(/\/api\/searches\/[^/]+\/requests\//, async (route) => {
      const res = await route.fetch();
      await route.fulfill({ response: res, json: { ...((await res.json()) as object), operationKeys: [{ type: 'transfer', name: 'Transfer', value: MOCK_FLOW.transfer, short: '…5c6d', masked: false }] } });
    });
    await page.goto('/pay/demo');
    await search(page, [MOCK_FLOW.transfer], '24 ч');
    await waitDone(page);
    const strip = page.getByTestId('operation-strip');
    await expect(strip).toBeVisible();
    await expect(strip.getByRole('link')).toHaveAttribute('href', /\/operations\//);
    const [tabs, frame, box] = await Promise.all([results(page).getByRole('tablist').boundingBox(), page.getByTestId('requests-frame').boundingBox(), strip.boundingBox()]);
    expect(frame!.y - (tabs!.y + tabs!.height)).toBeLessThanOrEqual(13);
    expect(box!.y).toBeGreaterThanOrEqual(frame!.y + frame!.height);
    expect(await page.evaluate(() => document.documentElement.scrollHeight - innerHeight)).toBe(0);
  });

  test('смена режима таблицу не двигает', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 785 });
    await page.goto('/pay/demo');
    await search(page, ['pay.example'], '24 ч');
    await waitDone(page);
    const before = (await firstRow(page).boundingBox())!.y;
    await setViewMode(page, 'Кратко');
    await expect(rows(page).first().getByTestId('request-records')).toHaveCount(0);
    expect((await firstRow(page).boundingBox())!.y).toBe(before);
  });

  test('пять длинных значений: поле растёт до трёх строк и дальше прокручивается, под «Найти» не заходит', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 785 });
    await page.goto('/pay/demo');
    const values = ['a', 'b', 'c', 'd', 'e'].map((c) => c.repeat(70));
    await addTerms(page, values);
    const field = termsInput(page).locator('xpath=..');
    const [box, period] = await Promise.all([field.boundingBox(), periodGroup(page).boundingBox()]);
    expect(box!.x + box!.width).toBeLessThanOrEqual(period!.x);
    expect(box!.height).toBeLessThanOrEqual(88);
    expect(await noScroll(page)).toBe(true);
    await expect(findButton(page)).toBeInViewport({ ratio: 1 });
    await expect(page.getByTestId('term-chip').last()).toBeAttached();
    expect(await field.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  });

  test('«Найти» и «Стоп» одной ширины; условия изменились — снова «Найти»', async ({ page }) => {
    await page.goto('/pay/slow');
    await addTerms(page, [`same${Date.now().toString(36)}`]);
    const before = (await findButton(page).boundingBox())!;
    await findButton(page).click();
    const stop = page.getByRole('button', { name: 'Стоп', exact: true });
    await expect(stop).toBeVisible();
    expect(await stop.boundingBox()).toEqual(before);
    await periodGroup(page).getByRole('button', { name: '1 ч', exact: true }).click();
    await expect(findButton(page)).toBeVisible();
    await expect(stop).toHaveCount(0);
    expect(await findButton(page).boundingBox()).toEqual(before);
  });

  test('Английский статус: виден целиком, время не задето, длительность суток в колонке', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 785 });
    await page.addInitScript(() => localStorage.setItem('threadline.language', 'en'));
    await page.route(/\/api\/searches\/[^/?]+(\?.*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const res = await route.fetch();
      const body = (await res.json()) as { requests: { durationMs: number }[] };
      if (body.requests[0]) body.requests[0].durationMs = (23 * 60 + 59) * 60_000;
      await route.fulfill({ response: res, json: body });
    });
    await page.goto('/pay/demo');
    await page.getByRole('textbox').first().fill('pay.example');
    await page.getByRole('textbox').first().press('Enter');
    await page.locator('form[role=search] button[type=submit]').click();
    await waitDone(page);
    const row = page.locator('li[data-cid][data-status=success]').first();
    await expect(row.locator('[data-status=success]')).toHaveText('Success');
    const [chip, time] = await Promise.all([row.locator('[data-status=success]').boundingBox(), row.getByTestId('request-time').boundingBox()]);
    expect(chip!.x + chip!.width).toBeLessThanOrEqual(time!.x);
    const first = page.locator('li[data-cid]').first();
    const duration = first.getByText('23 h 59 m');
    await expect(duration).toBeVisible();
    expect(await duration.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    expect(await noScroll(page)).toBe(true);
  });
});
