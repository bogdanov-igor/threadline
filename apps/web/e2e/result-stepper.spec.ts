// «1 из 12» на странице запроса: соседние результаты без возврата к списку. Демо-набор, значения выдуманы.
import { expect, test, type Page } from '@playwright/test';
import { MOCK_FLOW, MOCK_PERSONAL } from '../../server/src/backends/mock/dataset-pay.ts';
import { closeViewer, openBlock, openData, pickLanguage, setViewMode, viewerCode } from './helpers.ts';

const ROW_HIT = { position: { x: 8, y: 8 } };
const H = 3_600_000;
const STATE = /\/api\/searches\/[^/?]+(\?.*)?$/;

const rows = (page: Page) => page.getByRole('list', { name: 'Найденные запросы' }).getByRole('listitem');
const position = (page: Page) => page.getByTestId('result-position');
const prev = (page: Page) => page.getByTestId('result-prev');
const next = (page: Page) => page.getByTestId('result-next');
const stepper = (page: Page) => page.getByTestId('result-stepper');
const header = (page: Page) => page.getByTestId('request-header');
const backLink = (page: Page) => page.getByRole('link', { name: 'К результатам' });
const noScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const cidsOf = (page: Page) => rows(page).evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.cid ?? ''));
const hrefsOf = (page: Page) => rows(page).locator('[data-row-link]').evaluateAll((els) => els.map((el) => el.getAttribute('href') ?? ''));
const pathOf = (page: Page) => {
  const u = new URL(page.url());
  return u.pathname + u.search;
};
const openRow = async (page: Page, n: number) => {
  await rows(page).nth(n).locator('[data-row-link]').click(ROW_HIT);
  await expect(header(page)).toBeVisible();
};

async function search(page: Page, value = 'pay.example') {
  await page.goto('/pay/demo');
  const input = page.getByRole('textbox', { name: 'Значения для поиска' });
  await input.fill(value);
  await input.press('Enter');
  await page.getByRole('group', { name: 'Период' }).getByRole('button', { name: '24 ч', exact: true }).click();
  await page.getByRole('button', { name: 'Найти', exact: true }).click();
}

const waitDone = (page: Page) => expect(page.getByTestId('search-results')).toHaveAttribute('data-status', 'done', { timeout: 20_000 });

/** Нажатие как на русской раскладке: физическая клавиша та же, символ другой. */
const pressRussian = (page: Page, code: string, key: string) =>
  page.evaluate(([c, k]) => document.body.dispatchEvent(new KeyboardEvent('keydown', { code: c!, key: k!, bubbles: true, cancelable: true })), [code, key]);

// Ответы, ещё идущие через подмену, не роняют соседний тест после конца этого.
test.afterEach(({ page }) => page.unrouteAll({ behavior: 'ignoreErrors' }));

test.describe('переходы', () => {
  test('номера, края, свои границы в адресе, «Назад» к предыдущему запросу, возврат к текущей строке', async ({ page }) => {
    await search(page);
    await waitDone(page);
    const cids = await cidsOf(page);
    const hrefs = await hrefsOf(page);
    const total = cids.length;
    expect(total).toBeGreaterThan(3);
    const list = new URL(page.url()).search;

    await openRow(page, 1);
    await expect(position(page)).toHaveText(`2 из ${total}`);
    expect(pathOf(page)).toBe(hrefs[1]);

    await next(page).click();
    await expect(position(page)).toHaveText(`3 из ${total}`);
    expect(pathOf(page)).toBe(hrefs[2]);
    await expect(header(page).getByTestId('request-cid')).toHaveText(cids[2]!);
    // Клавиатура: фокус остаётся на кнопке, можно нажимать дальше.
    await expect(next(page)).toBeFocused();

    await prev(page).click();
    await prev(page).click();
    await expect(position(page)).toHaveText(`1 из ${total}`);
    expect(pathOf(page)).toBe(hrefs[0]);
    await expect(prev(page)).toBeDisabled();
    await expect(next(page)).toBeEnabled();
    await expect(next(page)).toBeFocused();

    // «Назад» — предыдущий открытый запрос, не список.
    await page.goBack();
    await expect(position(page)).toHaveText(`2 из ${total}`);
    expect(pathOf(page)).toBe(hrefs[1]);
    await page.goForward();
    await expect(position(page)).toHaveText(`1 из ${total}`);
    await next(page).click();
    await next(page).click();
    await expect(position(page)).toHaveText(`3 из ${total}`);

    // «К результатам»: через все переходы одним шагом, на текущую строку, а не на ту, с которой начали.
    await backLink(page).click();
    await expect(page).toHaveURL((u) => u.search === list);
    const current = page.locator(`li[data-cid="${cids[2]}"]`);
    await expect(current).toHaveAttribute('data-current', 'true');
    await expect(current.locator('[data-row-link]')).toBeFocused();
    await expect(page.locator(`li[data-cid="${cids[1]}"]`)).not.toHaveAttribute('data-current', 'true');
    // Новой записи нет: «Вперёд» снова открывает запрос, с которого начали.
    await page.goForward();
    await expect(position(page)).toHaveText(`2 из ${total}`);
  });

  test('последняя строка: следующая выключена; «Назад» браузера возвращает к её строке', async ({ page }) => {
    await search(page);
    await waitDone(page);
    const cids = await cidsOf(page);
    await openRow(page, cids.length - 1);
    await expect(position(page)).toHaveText(`${cids.length} из ${cids.length}`);
    await expect(next(page)).toBeDisabled();
    await expect(prev(page)).toBeEnabled();
    await page.goBack();
    await expect(page.locator(`li[data-cid="${cids.at(-1)}"] [data-row-link]`)).toBeFocused();
  });

  test('идёт по списку с «Только с ошибкой»: те же строки и порядок', async ({ page }) => {
    await search(page);
    await waitDone(page);
    await page.getByText('Только с ошибкой').click();
    await expect(rows(page).first()).toHaveAttribute('data-status', 'error');
    const hrefs = await hrefsOf(page);
    expect(hrefs.length).toBeGreaterThan(1);
    await openRow(page, 0);
    await expect(position(page)).toHaveText(`1 из ${hrefs.length}`);
    await next(page).click();
    await expect(position(page)).toHaveText(`2 из ${hrefs.length}`);
    expect(pathOf(page)).toBe(hrefs[1]);
    await expect(header(page).getByText('Ошибка', { exact: true })).toBeVisible();
    await backLink(page).click();
    await expect(page.getByTestId('search-results')).toBeVisible();
    await expect(rows(page)).toHaveCount(hrefs.length);
  });

  test('чтение только открытого запроса: соседи заранее не читаются', async ({ page }) => {
    await search(page);
    await waitDone(page);
    const cids = await cidsOf(page);
    const read: string[] = [];
    page.on('request', (r) => {
      const m = /\/requests\/([^/?]+)/.exec(new URL(r.url()).pathname);
      if (m && new URL(r.url()).pathname.startsWith('/api/')) read.push(m[1]!);
    });
    await openRow(page, 1);
    await expect(position(page)).toHaveText(`2 из ${cids.length}`);
    await page.waitForTimeout(400);
    expect(new Set(read)).toEqual(new Set([cids[1]]));
  });

  test('пока запрос читается, возврат и кнопки на своих местах, фокус остаётся на кнопке', async ({ page }) => {
    await search(page);
    await waitDone(page);
    const cids = await cidsOf(page);
    await openRow(page, 0);
    await expect(position(page)).toHaveText(`1 из ${cids.length}`);
    const box = await next(page).boundingBox();
    const backBox = await backLink(page).boundingBox();
    // Следующий запрос отвечает с задержкой.
    await page.route(/\/api\/searches\/[^/]+\/requests\//, async (route) => {
      await new Promise((done) => setTimeout(done, 800));
      await route.continue();
    });
    await next(page).click();
    await expect(page.getByTestId('request-skeleton')).toBeVisible();
    await expect(position(page)).toHaveText(`2 из ${cids.length}`);
    // Пока запрос читается, возврат и «N из M» стоят там же, где в шапке открытого запроса: стрелка остаётся под указателем.
    await expect(backLink(page)).toBeVisible();
    expect(await backLink(page).boundingBox()).toEqual(backBox);
    expect(await next(page).boundingBox()).toEqual(box);
    await expect(next(page)).toBeFocused();
    await expect(page.getByTestId('request-skeleton')).toBeHidden();
    await expect(next(page)).toBeFocused();
    expect(await next(page).boundingBox()).toEqual(box);
    expect(await backLink(page).boundingBox()).toEqual(backBox);
  });

  test('сосед не открылся: возврат и кнопки на своих местах', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 800 });
    await search(page);
    await waitDone(page);
    const cids = await cidsOf(page);
    await openRow(page, 0);
    const backBox = await backLink(page).boundingBox();
    const box = await next(page).boundingBox();
    await page.route(/\/api\/searches\/[^/]+\/requests\//, (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"internal"}' }));
    await next(page).click();
    await expect(page.getByRole('heading', { name: 'Записи запроса не загрузились' })).toBeVisible();
    await expect(position(page)).toHaveText(`2 из ${cids.length}`);
    // Шапки запроса нет: возврат и «N из M» в той же строке и на тех же местах, идти дальше можно.
    expect(await backLink(page).boundingBox()).toEqual(backBox);
    expect(await next(page).boundingBox()).toEqual(box);
    const nav = (await stepper(page).boundingBox())!;
    expect(nav.y).toBeLessThan(backBox!.y + backBox!.height);
    expect(nav.y + nav.height).toBeGreaterThan(backBox!.y);
    await expect(next(page)).toBeEnabled();
  });

  test('повторы без паузы: один переход и одна запись истории, возврат попадает в список', async ({ page }) => {
    await search(page);
    await waitDone(page);
    const cids = await cidsOf(page);
    const list = pathOf(page);
    await openRow(page, 1);
    await page.evaluate(() => {
      for (let i = 0; i < 4; i++) document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'BracketRight', key: ']', bubbles: true, cancelable: true }));
    });
    await expect(position(page)).toHaveText(`3 из ${cids.length}`);
    await page.goBack();
    await expect(position(page)).toHaveText(`2 из ${cids.length}`);
    await page.goForward();
    await expect(position(page)).toHaveText(`3 из ${cids.length}`);
    // Два нажатия подряд на возврат: первое уводит к списку, второе не идёт дальше него. Страница уже готова: ссылка заготовки уходит из документа.
    await expect(header(page)).toBeVisible();
    await backLink(page).evaluate((link: HTMLElement) => {
      link.click();
      link.click();
    });
    await waitDone(page);
    await page.waitForTimeout(300);
    expect(pathOf(page)).toBe(list);
    await expect(page.locator('li[data-current]')).toHaveAttribute('data-cid', cids[2]!);
  });

  test('окно ниже рабочего режима: строка после переходов видна при возврате', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 700 });
    await search(page);
    await waitDone(page);
    const cids = await cidsOf(page);
    const current = page.locator('li[data-current]');
    const walk = async (button: ReturnType<typeof next>, from: number, delta: 1 | -1) => {
      for (let i = 1; i <= 15; i++) {
        await button.click();
        await expect(position(page)).toHaveText(`${from + delta * i + 1} из ${cids.length}`);
      }
    };

    // Вниз от начала списка: страница списка стояла наверху, строка ушла ниже края.
    await openRow(page, 0);
    await walk(next(page), 0, 1);
    await backLink(page).click();
    await expect(current).toHaveAttribute('data-cid', cids[15]!);
    await expect(current).toBeInViewport();

    // Вверх: страница списка стояла внизу, строка ушла выше края. Тем же путём и кнопкой браузера.
    await current.locator('[data-row-link]').click(ROW_HIT);
    await expect(header(page)).toBeVisible();
    await walk(prev(page), 15, -1);
    await page.evaluate(() => window.history.go(-16));
    await expect(current).toHaveAttribute('data-cid', cids[0]!);
    await expect(current).toBeInViewport();
  });

  test('сменился режим на странице запроса: фильтр компонента забывается, как в списке', async ({ page }) => {
    await search(page);
    await waitDone(page);
    const cids = await cidsOf(page);
    await page.getByTestId('filters-toggle').click();
    await page.getByTestId('filter-component').click();
    await page.getByRole('option', { name: 'api', exact: true }).click();
    await page.keyboard.press('Escape');
    const filtered = (await cidsOf(page)).length;
    expect(filtered).toBeLessThan(cids.length);
    await openRow(page, 3);
    await expect(position(page)).toHaveText(`4 из ${filtered}`);
    // На странице запроса режим — в меню профиля.
    await setViewMode(page, 'Кратко');
    await expect(position(page)).toHaveText(new RegExp(` из ${cids.length}$`));
    await setViewMode(page, 'Подробно');
    await expect(position(page)).toHaveText(new RegExp(` из ${cids.length}$`));
    await backLink(page).click();
    await waitDone(page);
    await expect(rows(page)).toHaveCount(cids.length);
  });
});

test.describe('клавиши', () => {
  test('[ и ], русская раскладка, молчат в окне и меню, J и K остаются у шагов, в списке клавиш есть', async ({ page }) => {
    await search(page);
    await waitDone(page);
    const total = (await cidsOf(page)).length;
    await openRow(page, 1);
    await expect(position(page)).toHaveText(`2 из ${total}`);
    await page.getByRole('heading', { level: 1 }).click();

    await page.keyboard.press('BracketRight');
    await expect(position(page)).toHaveText(`3 из ${total}`);
    await page.keyboard.press('BracketLeft');
    await expect(position(page)).toHaveText(`2 из ${total}`);
    await pressRussian(page, 'BracketRight', 'ъ');
    await expect(position(page)).toHaveText(`3 из ${total}`);
    await pressRussian(page, 'BracketLeft', 'х');
    await expect(position(page)).toHaveText(`2 из ${total}`);
    await page.keyboard.press('Control+BracketRight');
    await expect(position(page)).toHaveText(`2 из ${total}`);
    // На первой строке: дальше некуда, адрес не меняется.
    await page.keyboard.press('BracketLeft');
    await expect(position(page)).toHaveText(`1 из ${total}`);
    const first = pathOf(page);
    await page.keyboard.press('BracketLeft');
    await expect(position(page)).toHaveText(`1 из ${total}`);
    expect(pathOf(page)).toBe(first);

    // J и K выбирают шаг, запрос тот же.
    await page.getByRole('tab', { name: /^Шкала времени/ }).click();
    const selected = page.getByRole('listbox', { name: 'Шаги трассы' }).locator('[role=option][aria-selected=true]');
    await expect(selected).toHaveCount(1);
    await page.getByRole('heading', { level: 1 }).click();
    await page.keyboard.press('KeyJ');
    await page.keyboard.press('KeyK');
    expect(pathOf(page)).toBe(first);

    // Открытое окно клавиш: клавиша молчит, в списке есть.
    await page.keyboard.press('Shift+Slash');
    const keys = page.getByTestId('keys-dialog');
    await expect(keys).toContainText('Следующий результат поиска');
    await expect(keys).toContainText('Предыдущий результат поиска');
    await page.keyboard.press('BracketRight');
    await expect(position(page)).toHaveText(`1 из ${total}`);
    await page.keyboard.press('Escape');
    await expect(keys).toBeHidden();

    // Открытое меню тоже.
    await page.getByTestId('share-button').first().click();
    await expect(page.getByTestId('share-menu')).toBeVisible();
    await page.keyboard.press('BracketRight');
    await expect(page.getByTestId('share-menu')).toBeVisible();
    expect(pathOf(page)).toBe(first);
    await page.keyboard.press('Escape');
  });
});

test.describe('когда кнопок нет', () => {
  test('прямая ссылка и перезагрузка: нет кнопок и пустого места, возврат после перезагрузки работает', async ({ page, context }) => {
    await search(page);
    await waitDone(page);
    const cids = await cidsOf(page);
    await openRow(page, 1);
    await expect(position(page)).toHaveText(`2 из ${cids.length}`);
    await next(page).click();
    await expect(position(page)).toHaveText(`3 из ${cids.length}`);
    await expect(header(page)).toBeVisible();
    const link = page.url();

    const other = await context.newPage();
    await other.goto(link);
    await expect(other.getByTestId('request-header').getByTestId('request-cid')).toHaveText(cids[2]!);
    await expect(other.getByTestId('result-stepper')).toHaveCount(0);
    await expect(other.getByRole('link', { name: 'К результатам' })).toHaveCount(0);
    await other.keyboard.press('BracketRight');
    expect(other.url()).toBe(link);
    await other.close();

    await page.reload();
    await expect(header(page)).toBeVisible();
    await expect(stepper(page)).toHaveCount(0);
    // Запись истории помнит, сколько шагов до результатов.
    await backLink(page).click();
    await expect(page).toHaveURL(/\?search=/);
    await expect(rows(page).first()).toBeVisible({ timeout: 20_000 });
  });

  test('запрос из «Всех записей» и из операции: своего списка результатов у них нет', async ({ page }) => {
    await search(page);
    await waitDone(page);
    await page.getByRole('tab', { name: 'Все записи' }).click();
    const item = page.locator('li[data-kind=response]').filter({ has: page.getByRole('link', { name: 'К запросу' }) }).first();
    await item.locator('button[aria-expanded]').first().click();
    await item.getByRole('link', { name: 'К запросу' }).click();
    await expect(header(page)).toBeVisible();
    await expect(stepper(page)).toHaveCount(0);

    await page.goto(`/pay/demo/operations/transfer/${MOCK_FLOW.transfer}?at=${Date.now() - 9 * H}&w=6h`);
    await expect(page.getByTestId('operation-page')).toHaveAttribute('data-status', 'done', { timeout: 30_000 });
    await page.getByTestId('operation-flows').locator('a[data-flow]').first().click();
    await expect(header(page)).toBeVisible();
    await expect(page.getByTestId('operation-position')).toBeVisible();
    await expect(stepper(page)).toHaveCount(0);
  });
});

test.describe('неполный и исчезнувший список', () => {
  /** Поиск будто идёт и нашёл только limit самых новых строк. Снятие предела отдаёт весь список как есть. */
  async function holdRows(page: Page, limit: number) {
    const hold = { on: true };
    await page.route(STATE, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const url = new URL(route.request().url());
      url.searchParams.set('from', '0');
      const res = await route.fetch({ url: url.toString() });
      const json = (await res.json()) as { requests: { firstMs: number }[]; requestsTotal: number; status: string };
      if (json.status === 'running' || !hold.on) return route.fulfill({ response: res, json });
      const newest = [...json.requests].sort((a, b) => b.firstMs - a.firstMs).slice(0, limit);
      await route.fulfill({ response: res, json: { ...json, requests: newest, requestsTotal: newest.length, status: 'running' } });
    });
    return hold;
  }

  test('идёт поиск: «2 из 2+», новые строки дают следующий результат, в конце число точное', async ({ page }) => {
    await search(page);
    await waitDone(page);
    const total = (await cidsOf(page)).length;
    const hold = await holdRows(page, 2);
    await page.reload();
    await expect(rows(page)).toHaveCount(2, { timeout: 20_000 });
    await openRow(page, 1);
    await expect(position(page)).toHaveText('2 из 2+');
    await expect(next(page)).toBeDisabled();
    await page.getByRole('heading', { level: 1 }).click();
    await page.keyboard.press('BracketRight');
    await expect(position(page)).toHaveText('2 из 2+');

    hold.on = false;
    await expect(position(page)).toHaveText(`2 из ${total}`);
    await expect(next(page)).toBeEnabled();
    await next(page).click();
    await expect(position(page)).toHaveText(`3 из ${total}`);
  });

  test('поиск остановлен: «+» остаётся', async ({ page }) => {
    await search(page);
    await waitDone(page);
    const total = (await cidsOf(page)).length;
    await openRow(page, 0);
    await page.route(STATE, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const res = await route.fetch();
      await route.fulfill({ response: res, json: { ...((await res.json()) as object), status: 'cancelled' } });
    });
    await next(page).click();
    await expect(position(page)).toHaveText(`2 из ${total}+`);
  });

  test('задание истекло: кнопки уходят без ошибок, запрос и возврат на месте', async ({ page }) => {
    await search(page);
    await waitDone(page);
    await openRow(page, 0);
    await expect(stepper(page)).toBeVisible();
    await page.route(STATE, (route) => (route.request().method() === 'GET' ? route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: { code: 'search-expired', message: 'Поиск истёк' } }) }) : route.continue()));
    await next(page).click();
    await expect(header(page)).toBeVisible();
    await expect(stepper(page)).toHaveCount(0);
    await expect(backLink(page)).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
});

test.describe('новый запрос с чистого листа', () => {
  test('выбранная вкладка и большое окно записи сбрасываются', async ({ page }) => {
    await search(page);
    await waitDone(page);
    await openRow(page, 0);
    // Плавающее окно кода есть у блоков записи; окно тела из панели шага модальное, с ним к соседу не перейти.
    await page.getByRole('tab', { name: /^Записи/ }).click();
    const records = page.getByRole('list', { name: 'Записи запроса' });
    await openBlock(records.locator(':scope > li').first());
    await records.getByTestId('code-window-open').first().click();
    await expect(page.getByTestId('code-window')).toBeVisible();

    await next(page).click();
    await expect(page.getByTestId('code-window')).toHaveCount(0);
    await expect(header(page)).toBeVisible();
    await expect(page.getByRole('tab', { name: /^Схема/ })).toHaveAttribute('aria-selected', 'true');
  });

  test('показ скрытого не переходит к соседу и не возвращается по «Назад»', async ({ page }) => {
    const reveal = page.getByTestId('reveal-button');
    await search(page);
    await waitDone(page);
    const row = page.locator(`li[data-cid="${MOCK_PERSONAL.cid}"]`);
    const cids = await cidsOf(page);
    const at = cids.indexOf(MOCK_PERSONAL.cid);
    expect(at).toBeGreaterThanOrEqual(0);
    await row.locator('[data-row-link]').click(ROW_HIT);
    await expect(header(page)).toBeVisible();
    await reveal.click();
    await expect(reveal).toHaveAttribute('data-status', 'on');

    // Тело ответа шага — в окне тела: строка «Ответ» панели открывает его. Окно модальное, к соседу — после закрытия.
    const open = async () => {
      await page.getByRole('tab', { name: /^Шкала времени/ }).click();
      await page.getByRole('listbox', { name: 'Шаги трассы' }).getByRole('option').filter({ hasText: 'core · POST /createCustomer' }).first().click();
      await openData(page, 'Ответ');
      return viewerCode(page);
    };
    await expect(await open()).toContainText(MOCK_PERSONAL.holder);
    await closeViewer(page);

    const asked: string[] = [];
    page.on('request', (r) => {
      if (/\/requests\/[^/]+\/reveal(\?|$)/.test(r.url())) asked.push(r.url());
    });
    const neighbour = at + 1 < cids.length ? next(page) : prev(page);
    await neighbour.click();
    await expect(header(page).getByTestId('request-cid')).not.toHaveText(MOCK_PERSONAL.cid);
    await expect(page.locator('body')).not.toContainText(MOCK_PERSONAL.holder);
    await expect(reveal.and(page.locator('[data-status=on]'))).toHaveCount(0);

    await page.goBack();
    await expect(header(page).getByTestId('request-cid')).toHaveText(MOCK_PERSONAL.cid);
    await expect(reveal).toHaveAttribute('data-status', 'off');
    await expect(await open()).not.toContainText(MOCK_PERSONAL.holder);
    await closeViewer(page);
    expect(asked).toEqual([]);
  });
});

test.describe('шапка', () => {
  test('следующая кнопка не сдвигается от шага к шагу', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 800 });
    await search(page);
    await waitDone(page);
    await openRow(page, 0);
    const before = await next(page).boundingBox();
    for (let i = 0; i < 3; i++) await next(page).click();
    await expect(header(page)).toBeVisible();
    expect(await next(page).boundingBox()).toEqual(before);
  });

  for (const [name, text] of [['Русский', /^2 из \d+$/], ['English', /^2 of \d+$/]] as const) {
    test(`ширина 768, ${name}: одна строка, страница вбок не прокручивается`, async ({ page }) => {
      await page.setViewportSize({ width: 768, height: 800 });
      await search(page);
      await waitDone(page);
      await openRow(page, 1);
      if (name !== 'Русский') await pickLanguage(page, name);
      await expect(position(page)).toHaveText(text);
      // Первая строка шапки запроса: назад, статус, название, «N из M», действия.
      const row = await header(page).locator('> div').first().boundingBox();
      const box = await stepper(page).boundingBox();
      expect(row!.height).toBe(36);
      expect(box!.y).toBeGreaterThanOrEqual(row!.y);
      expect(box!.y + box!.height).toBeLessThanOrEqual(row!.y + row!.height);
      expect(await noScroll(page)).toBe(true);
    });
  }
});
