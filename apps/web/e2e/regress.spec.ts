import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { MOCK_FLOW } from '../../server/src/backends/mock/dataset-pay.ts';
import { openMore } from './helpers.ts';

// Сквозные проверки по найденным отказам: цвет записей после правила итога, клавиатура графа, текст узлов, сегменты
// операции, уход со страницы операции, места на первом экране. Данные — демо-набор, значения выдуманы.

const H = 3_600_000;
const API = '/api/projects/pay/catalog';
const TRANSFER = MOCK_FLOW.transfer;
const ROW_HIT = { position: { x: 8, y: 8 } };

const scheme = (page: Page) => page.getByRole('group', { name: 'Схема запроса' });
const details = (page: Page) => page.getByTestId('step-details');
const flowRows = (page: Page) => page.getByTestId('operation-flows').locator('a[data-flow]');

async function catalogOn(page: Page): Promise<boolean> {
  const res = await page.request.get('/api/catalog');
  return res.ok() && ((await res.json()) as { state?: string }).state === 'ok';
}

async function find(page: Page, term: string, env = '/pay/demo') {
  await page.goto(env);
  const input = page.getByRole('textbox', { name: 'Значения для поиска' });
  await input.fill(term);
  await input.press('Enter');
  await page.getByRole('group', { name: 'Период' }).getByRole('button', { name: '24 ч', exact: true }).click();
  await page.getByRole('button', { name: 'Найти', exact: true }).click();
  await expect(page.getByTestId('search-results')).toHaveAttribute('data-status', 'done', { timeout: 20_000 });
}

async function openRequest(page: Page, term: string, text: string | RegExp = /./) {
  await find(page, term);
  const found = page.getByRole('list', { name: 'Найденные запросы' }).getByRole('listitem').filter({ hasText: text });
  await found.first().locator('[data-row-link]').click(ROW_HIT);
  await expect(page.getByTestId('request-header')).toBeVisible();
  await expect(page.getByTestId('flow-canvas')).toBeVisible({ timeout: 15_000 });
}

const transferAt = () => Date.now() - 9 * H;
const paymentAt = () => Date.now() - 10.5 * H;
const operationUrl = (value: string = TRANSFER, at = transferAt(), type = 'transfer', env = 'demo', w = '6h') => `/pay/${env}/operations/${type}/${value}?at=${at}&w=${w}`;

async function openOperation(page: Page, url = operationUrl()) {
  await page.goto(url);
  await expect(page.getByTestId('operation-page')).toHaveAttribute('data-status', 'done', { timeout: 30_000 });
}

test.describe('схема: клавиатура', () => {
  test('пробел на группе бюджета: фокус остаётся на ней, → идёт внутрь, второй пробел сворачивает', async ({ page }) => {
    await openRequest(page, 'cards/sync');
    const group = scheme(page).getByTestId('group-toggle').first().locator('xpath=ancestor::div[1]').locator('button[data-node]');
    const id = await group.getAttribute('data-node');
    await group.focus();
    await page.keyboard.press('Space');
    const frame = scheme(page).locator(`button[data-node="${id}"][data-frame=open]`);
    await expect(frame).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(scheme(page).locator(`button[data-node="${id}"]`)).not.toBeFocused();
    await frame.focus();
    await page.keyboard.press('Space');
    await expect(scheme(page).locator(`button[data-node="${id}"]:not([data-frame])`)).toBeFocused();
  });

  test('группа сверх предела: пробел открывает шкалу на её первом шаге', async ({ page }) => {
    await openRequest(page, 'cards/sync');
    const toTimeline = scheme(page).getByTestId('group-timeline').first();
    await expect(toTimeline).toBeAttached();
    const group = toTimeline.locator('xpath=ancestor::div[1]').locator('button[data-node]');
    await group.focus();
    await page.keyboard.press('Space');
    await expect(page.getByRole('tab', { name: /^Шкала времени/ })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('listbox', { name: 'Шаги трассы' }).getByRole('option', { selected: true })).toHaveCount(1);
  });

  test('узлы-ссылки: → с последнего узла потока, затем →/← между ними', async ({ page }) => {
    test.skip(!(await catalogOn(page)), 'роли потоков — из справочника');
    await openOperation(page);
    await page.getByTestId('operation-flows').locator('li[data-role=call] a[data-flow]').click();
    await expect(page.getByTestId('flow-canvas')).toBeVisible({ timeout: 15_000 });
    const refs = scheme(page).locator('button[data-node][data-kind=flow-ref]');
    await expect(refs.first()).toBeVisible();
    const count = await refs.count();
    const ids = await refs.evaluateAll((els) => els.map((e) => e.getAttribute('data-node')));
    expect(new Set(ids).size).toBe(count);
    await scheme(page).locator('button[data-node]').first().focus();
    await page.keyboard.press('End');
    await expect(refs.last()).toBeFocused();
    await page.keyboard.press('Home');
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press('ArrowRight');
      if (await refs.first().evaluate((e) => e === document.activeElement)) break;
    }
    await expect(refs.first()).toBeFocused();
    if (count > 1) {
      await page.keyboard.press('ArrowRight');
      await expect(refs.nth(1)).toBeFocused();
      await page.keyboard.press('ArrowLeft');
      await expect(refs.first()).toBeFocused();
    }
  });
});

test.describe('схема: текст узлов', () => {
  test('колбэк без обменов: «Declined · заявлено в колбэке» на узле и в подписи, без «Внешних вызовов нет»', async ({ page }) => {
    test.skip(!(await catalogOn(page)), 'без справочника у входа нет статуса');
    await openRequest(page, TRANSFER, /Payout network callback/);
    const entry = scheme(page).locator('button[data-node][data-kind=entry]');
    await expect(entry.getByTestId('node-outcome')).toContainText('Declined · заявлено в колбэке');
    await expect(entry).toHaveAttribute('aria-label', /Declined · заявлено в колбэке/);
    await expect(scheme(page).getByTestId('node-note')).toHaveCount(0);
    await expect(page.getByTestId('request-header')).not.toContainText('возможно, ответ из кэша');
  });

  test('красная группа: число шагов и ошибок видно, имени одной системы нет', async ({ page }) => {
    await openRequest(page, 'cards/sync');
    const more = scheme(page).locator('button[data-node][data-group=more][data-tone=error]').first();
    await expect(more.getByTestId('node-name')).toHaveText(/^ещё \d+ шаг\S* · \d+ ошиб/);
    await expect(more.getByTestId('node-outcome')).not.toBeEmpty();
    const errors = scheme(page).locator('button[data-node][data-group=errors]').first();
    if (await errors.count()) await expect(errors.getByTestId('node-method')).toContainText(/×\d+/);
  });

  test('неполные записи: пометка видна рядом с причиной ошибки', async ({ page }) => {
    await page.route('**/api/searches/*/requests/*', async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as { summary: { incomplete: boolean } };
      body.summary.incomplete = true;
      await route.fulfill({ response: res, json: body });
    });
    await openRequest(page, 'getCard', /./);
    const marked = scheme(page).locator('[data-unread]');
    await expect(marked).toHaveCount(1);
    await expect(marked).toHaveText('дальше записи не прочитаны');
  });

  test('фоновый запуск: компонент отдельной строкой, смещение в секундах, «фоновый» не дублируется в шапке', async ({ page }) => {
    await openRequest(page, 'cards/sync');
    const offsets = await scheme(page).getByTestId('node-outcome').allInnerTexts();
    expect(offsets.join(' ')).not.toMatch(/\+\d{4,} мс/);
    await find(page, MOCK_FLOW.nocidPod);
  });

  test('логи со значка видны в панели шага', async ({ page }) => {
    await openRequest(page, 'Circuit breaker');
    const badged = scheme(page).locator('button[data-node]').filter({ has: page.locator('..').getByTestId('node-badge') });
    await expect(page.getByTestId('node-badge').first()).toBeVisible();
    await expect(badged.first()).toBeAttached();
    const nodes = scheme(page).locator('button[data-node]');
    let shown = false;
    for (let i = 0; i < (await nodes.count()) && !shown; i++) {
      await nodes.nth(i).click();
      shown = (await details(page).getByTestId('step-logs').count()) > 0 && /cURL error 28/.test((await details(page).getByTestId('step-logs').textContent()) ?? '');
    }
    expect(shown).toBe(true);
    await expect(details(page).getByTestId('step-logs')).toContainText('Circuit breaker');
  });

  test('вызовы подряд перед перекрытыми обменами: две ветки, без пустого узла и повтора', async ({ page }) => {
    await openRequest(page, 'parallel-lookup');
    await expect(scheme(page).getByTestId('node-parallel').first()).toHaveText('2');
    await expect(scheme(page).locator('button[data-node][data-group]')).toHaveCount(0);
    await expect(scheme(page).locator('button[data-node]')).toHaveCount(3);
  });

  test('подписи рёбер к узлам-ссылкам не наезжают друг на друга, «по Transfer» нет', async ({ page }) => {
    test.skip(!(await catalogOn(page)), 'роли потоков — из справочника');
    await openOperation(page);
    await page.getByTestId('operation-flows').locator('li[data-role=call] a[data-flow]').click();
    await expect(page.getByTestId('flow-canvas')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('request-page')).not.toContainText('по Transfer');
    const boxes = await page.getByTestId('edge-label').evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ l: r.left, r: r.right, t: r.top, b: r.bottom })));
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        expect(a.r <= b.l || b.r <= a.l || a.b <= b.t || b.b <= a.t, `${JSON.stringify(a)} ${JSON.stringify(b)}`).toBe(true);
      }
    }
  });
});

test.describe('первый экран запроса', () => {
  for (const [width, height] of [[1280, 800], [768, 1024]] as const) {
    test(`панель шага начинается на первом экране, ${width}×${height}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await openRequest(page, 'cards/sync');
      const top = (await details(page).boundingBox())!.y;
      expect(top).toBeLessThan(height);
      const canvas = (await page.getByRole('group', { name: 'Схема запроса' }).boundingBox())!;
      // Под схемой панель стоит только уже 1280: там холст не выше 60 % окна. Шире панель справа, а холст занимает всю колонку.
      if (width < 1280) expect(canvas.height).toBeLessThanOrEqual(height * 0.6 + 1);
      // Выбранный узел виден внутри холста.
      const node = (await scheme(page).locator('button[data-node][aria-pressed=true]').boundingBox())!;
      expect(node.y).toBeGreaterThanOrEqual(canvas.y - 1);
      expect(node.y + node.height).toBeLessThanOrEqual(canvas.y + canvas.height + 1);
    });
  }

  test('причины: одна строка, повторы схлопнуты, остальное числом', async ({ page }) => {
    await openRequest(page, 'cards/sync');
    const reasons = page.getByTestId('request-reasons');
    await expect(reasons.locator('li[data-source]').first()).toBeVisible();
    // Остальные причины в свёрнутой части: на экране одна строка.
    await expect(reasons.locator('li[data-source]:visible')).toHaveCount(1);
    await expect(reasons.getByTestId('reasons-body')).toBeHidden();
    await expect(reasons.getByTestId('reasons-more')).toHaveText(/^ещё \d+ ошиб/);
  });

  test('«ещё N ошибок»: кнопка раскрывает все причины на месте и сворачивает обратно, страница двигается только на добавленный текст', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openRequest(page, 'cards/sync');
    const reasons = page.getByTestId('request-reasons');
    const more = reasons.getByTestId('reasons-more');
    await expect(more).toHaveRole('button');
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    const count = Number(/\d+/.exec((await more.innerText()).trim())![0]);
    // Строки свёрнутой части в документе есть всегда, считаются только видимые.
    const rows = reasons.locator('li[data-source]:visible');
    const before = await rows.count();
    const counted = async () => {
      const texts = await rows.allInnerTexts();
      return texts.reduce((n, text) => n + Number(/×(\d+)/.exec(text)?.[1] ?? 1), 0);
    };
    const shownBefore = await counted();
    const header = (await page.getByTestId('request-header').boundingBox())!;
    const top = (await reasons.boundingBox())!;
    const tabs = (await page.getByRole('tab', { name: 'Схема' }).boundingBox())!;
    await more.click();
    await expect(more).toHaveAttribute('aria-expanded', 'true');
    // Прежняя подпись остаётся для чтения с экрана, видно «свернуть».
    await expect(more).toContainText('свернуть');
    await expect(reasons.getByTestId('reasons-body')).toBeVisible();
    await expect(more).toBeFocused();
    // Строки того же вида: число на кнопке — ровно то, что раскрылось.
    expect(await rows.count()).toBeGreaterThan(before);
    expect((await counted()) - shownBefore).toBe(count);
    await expect(rows.nth(before).locator('svg')).toBeVisible();
    // Выше блока ничего не сдвинулось, ниже — только на его прирост.
    expect(await page.getByTestId('request-header').boundingBox()).toEqual(header);
    const open = (await reasons.boundingBox())!;
    expect(open.y).toBe(top.y);
    const moved = (await page.getByRole('tab', { name: 'Схема' }).boundingBox())!;
    expect(moved.y - tabs.y).toBeCloseTo(open.height - top.height, 0);
    expect(await page.evaluate(() => document.documentElement.scrollHeight - document.documentElement.clientHeight)).toBeLessThanOrEqual(0);
    await more.click();
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await expect(more).not.toContainText('свернуть');
    await expect(rows).toHaveCount(before);
    expect(await reasons.boundingBox()).toEqual(top);
    expect(await page.getByRole('tab', { name: 'Схема' }).boundingBox()).toEqual(tabs);
  });
});

test.describe('сегменты одного correlation_id в операции', () => {
  test('«Запрос N из M» идёт по сегментам и доходит до конца; у каждого свой шаг', async ({ page }) => {
    test.skip(!(await catalogOn(page)), 'типы операции — из набора справочника');
    await openOperation(page, operationUrl(MOCK_FLOW.payment, paymentAt(), 'payment'));
    await flowRows(page).first().click();
    await expect(page.getByTestId('request-header')).toBeVisible();
    const nav = page.getByTestId('operation-nav');
    const position = nav.getByTestId('operation-position');
    const total = Number(/из (\d+)/.exec((await position.innerText()).trim())![1]);
    const seen: number[] = [];
    const steps = new Set<string>();
    for (let i = 0; i < total; i++) {
      const n = Number(/Запрос (\d+)/.exec(await position.innerText())![1]);
      seen.push(n);
      steps.add((await details(page).getAttribute('data-step')) ?? '');
      const next = nav.getByRole('link', { name: 'Следующий запрос операции' });
      if ((await next.count()) === 0) break;
      await next.click();
      await expect(position).toHaveText(new RegExp(`^Запрос ${n + 1} из`));
    }
    expect(seen).toEqual(Array.from({ length: seen.length }, (_, i) => seen[0]! + i));
    expect(seen[seen.length - 1]).toBe(total);
    expect(steps.size).toBeGreaterThan(1);
  });
});

test.describe('поиск операции', () => {
  // Свой момент у каждого теста: одинаковый адрес подключил бы параллельные тесты к одному заданию.
  const slowUrl = () => operationUrl(TRANSFER, transferAt() - Math.floor(Math.random() * 600_000), 'transfer', 'slow');

  test('пока идёт поиск: нейтральный итог и заготовки вместо «Статусов нет» и «0 запросов»', async ({ page }) => {
    await page.goto(slowUrl());
    const body = page.getByTestId('operation-page');
    await expect(body).toHaveAttribute('data-status', 'running', { timeout: 15_000 });
    await expect(page.getByTestId('operation-outcome')).toContainText('Ищем…');
    await expect(page.getByTestId('operation-outcome')).not.toContainText('Итог не прочитан');
    await expect(body).not.toContainText('Статусов операции в логах нет');
    await expect(body).not.toContainText('0 запросов');
    await expect(page.getByTestId('operation-flow-skeleton').first()).toBeVisible();
    await expect(page.getByTestId('operation-trail-skeleton')).toBeVisible();
  });

  test('уход со страницы останавливает поиск: задание отменено', async ({ page }) => {
    await page.goto(slowUrl());
    await expect(page.getByTestId('operation-page')).toHaveAttribute('data-status', 'running', { timeout: 15_000 });
    const id = new URL(page.url()).searchParams.get('search')!;
    const stop = page.waitForRequest((r) => r.method() === 'DELETE' && r.url().includes(`/api/searches/${id}`));
    await page.getByRole('link', { name: 'Threadline' }).first().click();
    await stop;
    await expect.poll(async () => ((await (await page.request.get(`/api/searches/${id}`)).json()) as { status: string }).status).toBe('cancelled');
  });

  test('«Искать и по id» и та же операция в новой вкладке: кнопка на месте, итог получается дополнением', async ({ page, context }) => {
    test.skip(!(await catalogOn(page)), 'дополнение — по типам справочника');
    await openOperation(page);
    const supplement = page.getByTestId('operation-supplement');
    await expect(supplement).toBeVisible();
    await supplement.click();
    await expect(page).toHaveURL(/also=card_payout/);
    await expect(page.getByTestId('operation-page')).toHaveAttribute('data-status', 'done', { timeout: 30_000 });
    const outcome = await page.getByTestId('operation-outcome').innerText();
    const other = await context.newPage();
    const base = new URL(page.url());
    base.searchParams.delete('also');
    base.searchParams.delete('search');
    await openOperation(other, `${base.pathname}${base.search}`);
    const again = other.getByTestId('operation-supplement');
    await expect(again).toBeVisible();
    await again.click();
    await expect(other).toHaveURL(/also=card_payout/);
    await expect(other.getByTestId('operation-page')).toHaveAttribute('data-status', 'done', { timeout: 30_000 });
    await expect(other.getByTestId('operation-outcome')).toContainText(outcome.split('\n').slice(1, 2).join(''));
  });

  test('строка потока: статус операции без зелёной метки; 768px — заголовок целиком', async ({ page }) => {
    test.skip(!(await catalogOn(page)), 'статусы операции — из справочника');
    await page.setViewportSize({ width: 768, height: 1024 });
    await openOperation(page);
    const withStatus = page.getByTestId('operation-flows').locator('li[data-role=callback]');
    await expect(withStatus).toContainText('заявлено в колбэке');
    await expect(withStatus.locator('[data-status=success]')).toHaveCount(0);
    const title = page.getByTestId('operation-title');
    await expect(title).toContainText('…5c6d');
    expect(await title.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
  });

  test('«Операция» на 768px — в меню «⋯», на экране короткое слово, полный текст в подписи', async ({ page }) => {
    test.skip(!(await catalogOn(page)), 'ключ операции — из справочника');
    await page.setViewportSize({ width: 768, height: 1024 });
    await openRequest(page, TRANSFER, /Payout network callback/);
    // Уже 1280 кнопки в строке шапки нет: она в меню «⋯».
    await expect(page.getByTestId('request-header').getByTestId('open-operation')).toHaveCount(0);
    const button = (await openMore(page)).getByTestId('open-operation');
    await expect(button).toHaveAccessibleName(/Открыть операцию · Transfer …5c6d/);
    await expect(button).toHaveText('Операция');
  });
});

test.describe('справочник: правила на шаге и разделы', () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!(await catalogOn(page)), 'справочник выключен');
  });

  let seq = 0;
  /** Своя система теста; хост KYC занят только на время теста. */
  async function ownSystem(request: APIRequestContext, name: string, host?: string) {
    const key = `e2e-reg-${Date.now() % 1_000_000}-${++seq}`;
    const res = await request.post(`${API}/systems`, { data: { key, name, hosts: [host ?? `${key}.partner.example`] } });
    expect(res.status(), await res.text()).toBe(201);
    return (await res.json()) as { id: number; key: string; updatedAt: string };
  }
  const drop = async (request: APIRequestContext, section: string, id: number) => {
    const list = (await (await request.get(API)).json()) as Record<string, { id: number; updatedAt: string }[]>;
    const key = section === 'systems' ? 'systems' : 'errors';
    const row = list[key]!.find((x) => x.id === id);
    if (row) await request.delete(`${API}/${section}/${id}?updatedAt=${encodeURIComponent(row.updatedAt)}`);
  };

  test.describe('один хост KYC', () => {
    test.describe.configure({ mode: 'serial' });

  test('HTTP 200 и код в теле: «Неизвестное» → форма → правило сработало и строка ушла', async ({ page, request }) => {
    const system = await ownSystem(request, 'KYC регрессия', 'kyc.pay.example');
    try {
      await find(page, 'Face does not match document photo');
      const pending = () => request.get(`${API}/unknown?kind=error`).then((r) => r.json() as Promise<{ items: { systemId: number; httpStatus: number; code: string; text: string }[] }>);
      await expect.poll(async () => (await pending()).items.filter((i) => i.systemId === system.id).length, { timeout: 25_000 }).toBeGreaterThan(0);
      await page.goto('/pay/catalog/unknown');
      const row = page.locator('[data-testid=unknown-row][data-kind=error]').filter({ hasText: 'KYC регрессия' }).first();
      await row.getByRole('button', { name: 'Добавить в справочник' }).click();
      const form = page.getByTestId('catalog-form');
      await expect(form.getByRole('textbox', { name: /^HTTP/ })).toHaveValue('200');
      await form.getByRole('textbox', { name: 'Текст ошибки' }).fill('Лицо не совпало с документом (тест)');
      await form.getByRole('button', { name: 'Сохранить' }).click();
      await expect(form).toBeHidden();
      await expect(page.locator('[data-testid=unknown-row][data-kind=error]').filter({ hasText: 'KYC регрессия' })).toHaveCount(0);
      await find(page, 'Face does not match document photo');
      await page.getByRole('list', { name: 'Найденные запросы' }).getByRole('listitem').first().locator('[data-row-link]').click(ROW_HIT);
      await expect(page.getByTestId('request-reasons')).toContainText('Лицо не совпало с документом (тест)');
    } finally {
      await drop(request, 'systems', system.id);
    }
  });

  test('правило итога «успех»: запись на вкладке «Записи» не красная, шаг не выбран как первая ошибка', async ({ page, request }) => {
    const system = await ownSystem(request, 'KYC правило', 'kyc.pay.example');
    try {
      const rule = await request.post(`${API}/outcome-rules`, { data: { systemId: system.id, methodId: null, when: { http: 200, fields: [{ path: 'result_code', equals: 'BAD' }] }, outcome: 'success' } });
      expect(rule.status()).toBe(201);
      await find(page, 'Face does not match document photo');
      await page.getByRole('list', { name: 'Найденные запросы' }).getByRole('listitem').first().locator('[data-row-link]').click(ROW_HIT);
      await expect(page.getByTestId('request-header')).toBeVisible();
      await page.getByRole('tab', { name: /^Записи/ }).click();
      const response = page.locator('li[data-kind=response]').filter({ hasText: 'kyc' });
      await expect(response.first()).toBeVisible();
      await expect(response.first()).not.toHaveAttribute('data-error', /.*/);
      await expect(page.locator('li[data-kind=response][data-error]')).toHaveCount(0);
    } finally {
      await drop(request, 'systems', system.id);
    }
  });

  });

  test('метод с полем статуса без типа операции сохраняется, а не молчит', async ({ page, request }) => {
    const system = await ownSystem(request, 'Регрессия формы');
    try {
      const m = await request.post(`${API}/methods`, { data: { systemId: system.id, http: 'POST', path: '/regress/status', name: 'Статус регрессии', op: 'transfer', status: { in: 'response', path: 'state' } } });
      expect(m.status(), await m.text()).toBe(201);
      const created = (await m.json()) as { id: number };
      await page.goto(`/pay/catalog/systems/${system.key}`);
      await page.getByTestId('method-row').filter({ hasText: 'Статус регрессии' }).getByRole('button').first().click();
      const form = page.getByTestId('catalog-form');
      await form.getByRole('combobox', { name: /^Тип операции/ }).click();
      await page.getByRole('option', { name: 'Без типа операции' }).click();
      await form.getByRole('button', { name: 'Сохранить' }).click();
      await expect(form).toBeHidden();
      const row = ((await (await request.get(API)).json()) as { methods: { id: number; status: unknown; op: unknown }[] }).methods.find((x) => x.id === created.id);
      expect(row).toMatchObject({ op: null, status: null });
    } finally {
      await drop(request, 'systems', system.id);
    }
  });

  test('«Скрыть» не удалось: сообщение над списком, строка на месте', async ({ page, request }) => {
    await find(page, 'pay.example');
    await expect.poll(async () => ((await (await request.get(`${API}/unknown`)).json()) as { total: number }).total, { timeout: 25_000 }).toBeGreaterThan(0);
    await page.route('**/catalog/unknown/*', (route) => route.fulfill({ status: 409, json: { error: { code: 'catalog-conflict' } } }));
    await page.goto('/pay/catalog/unknown');
    const row = page.getByTestId('unknown-row').first();
    await row.getByRole('button', { name: 'Скрыть' }).click();
    await expect(page.getByTestId('unknown-hide-failed')).toContainText('catalog-conflict');
    await expect(row).toBeVisible();
  });

  test('«Вернуть» устаревшей записи: сообщение видно, форма открыта', async ({ page, request }) => {
    const system = await ownSystem(request, 'Регрессия возврата');
    try {
      const created = await request.post(`${API}/errors`, { data: { systemId: system.id, methodId: null, code: 'REG1', title: 'Скрытая запись', hidden: true } });
      expect(created.status(), await created.text()).toBe(201);
      const row = (await created.json()) as { id: number; updatedAt: string; title: string };
      await page.goto(`/pay/catalog/systems/${system.key}?tab=errors`);
      await page.getByTestId('catalog-hidden-filter').click();
      await page.getByTestId('error-row').filter({ hasText: 'Скрытая запись' }).getByRole('button').first().click();
      const form = page.getByTestId('catalog-form');
      await expect(form.getByRole('button', { name: 'Вернуть' })).toBeVisible();
      const put = await request.put(`${API}/errors/${row.id}`, { data: { systemId: system.id, methodId: null, code: 'REG1', title: 'Скрытая запись 2', hidden: true, updatedAt: row.updatedAt } });
      expect(put.status(), await put.text()).toBe(200);
      await form.getByRole('button', { name: 'Вернуть' }).click();
      await expect(page.getByTestId('form-conflict')).toBeVisible();
      await expect(form).toBeVisible();
    } finally {
      await drop(request, 'systems', system.id);
    }
  });

  test('«Открыть пример» из стендов PR ведёт на запрос этого стенда', async ({ page, request }) => {
    await find(page, 'switch.pay.example', '/pay/pr/92').catch(() => undefined);
    await expect
      .poll(async () => ((await (await request.get(`${API}/unknown?env=pr`)).json()) as { total: number }).total, { timeout: 25_000 })
      .toBeGreaterThan(0);
    const page1 = ((await (await request.get(`${API}/unknown?env=pr`)).json()) as { items: { stand: string | null }[] }).items;
    expect(page1[0]!.stand).toBe('92');
    await page.goto('/pay/catalog/unknown');
    await page.getByRole('combobox', { name: 'Среда', exact: true }).click();
    await page.getByRole('option', { name: 'PR stands', exact: true }).click();
    const row = page.getByTestId('unknown-row').first();
    await row.getByRole('button', { name: 'Открыть пример' }).click();
    await expect(page).toHaveURL(/\/pay\/pr\/92\/requests\//);
    await expect(page.getByTestId('request-header')).toBeVisible();
  });

  test('список разделов не выше окна: нижние разделы доступны прокруткой списка', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 420 });
    await page.goto('/pay/catalog');
    const list = page.getByTestId('catalog-sections');
    await expect(list).toBeVisible();
    expect(await list.evaluate((e) => getComputedStyle(e).overflowY)).toBe('auto');
    const box = (await list.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(420);
    const last = list.locator('a[data-section=unknown]');
    await last.scrollIntoViewIfNeeded();
    await expect(last).toBeInViewport();
  });

  test('ключ типа виден целиком, «Операция» не повторяется; метка вида метода видна на 768px', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto('/pay/catalog/ids');
    const row = page.getByTestId('id-type-row').filter({ hasText: 'card_payout' });
    const code = row.locator('code');
    await expect(code).toHaveText('card_payout');
    expect(await code.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
    expect(((await row.innerText()).match(/Операция/g) ?? []).length).toBe(1);
    await page.goto('/pay/catalog/project');
    const callback = page.getByTestId('method-row').filter({ hasText: 'Payout network callback' });
    await expect(callback.getByTestId('method-kind')).toBeVisible();
  });
});

test.describe('уход со страницы операции', () => {
  // Свой момент у каждого теста: одинаковый адрес подключил бы параллельные тесты к одному заданию.
  const slowUrl = () => operationUrl(TRANSFER, transferAt() - Math.floor(Math.random() * 600_000), 'transfer', 'slow');
  const searchOf = (page: Page) => new URL(page.url()).searchParams.get('search');

  test('уход и «Назад»: остановленный поиск запускается заново, ложного вывода нет', async ({ page }) => {
    await page.goto(slowUrl());
    await expect(page.getByTestId('operation-page')).toHaveAttribute('data-status', 'running', { timeout: 15_000 });
    await expect.poll(() => searchOf(page)).toBeTruthy();
    const first = searchOf(page)!;
    const left = page.waitForResponse((r) => r.request().method() === 'DELETE' && r.url().includes(first));
    await page.getByRole('link', { name: /домой|главн|Threadline/i }).first().click();
    await left;
    await expect.poll(async () => ((await (await page.request.get(`/api/searches/${first}`)).json()) as { status: string }).status).toBe('cancelled');
    await page.goBack();
    await expect.poll(() => searchOf(page), { timeout: 15_000 }).not.toBe(first);
    await expect(page.getByTestId('operation-page')).toHaveAttribute('data-status', 'running', { timeout: 15_000 });
    await expect(page.getByTestId('operation-page')).not.toContainText('Не прочитано');
    await expect(page.getByTestId('operation-page')).not.toContainText('Статусов операции в логах нет');
  });

  test('две вкладки одного поиска: уход одной не останавливает другую', async ({ page, context }) => {
    const url = slowUrl();
    await page.goto(url);
    await expect.poll(() => searchOf(page), { timeout: 15_000 }).toBeTruthy();
    const id = searchOf(page)!;
    const second = await context.newPage();
    await second.goto(`${url}&search=${id}`);
    await expect(second.getByTestId('operation-page')).toHaveAttribute('data-status', 'running', { timeout: 15_000 });
    const left = page.waitForResponse((r) => r.request().method() === 'DELETE' && r.url().includes(id));
    await page.getByRole('link', { name: /домой|главн|Threadline/i }).first().click();
    await left;
    await new Promise((r) => setTimeout(r, 800));
    const state = (await (await second.request.get(`/api/searches/${id}`)).json()) as { status: string };
    expect(state.status).not.toBe('cancelled');
    await expect(second.getByTestId('operation-page')).not.toContainText('Не прочитано');
    await second.close();
  });

  test('строка хода поиска постоянной высоты: блоки ниже не сдвигаются в конце поиска', async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(slowUrl());
    await expect(page.getByTestId('operation-page')).toHaveAttribute('data-status', 'running', { timeout: 15_000 });
    const trail = page.getByRole('heading', { name: 'Ход операции' });
    const before = (await trail.boundingBox())!.y;
    await expect(page.getByTestId('operation-page')).toHaveAttribute('data-status', 'done', { timeout: 80_000 });
    expect(Math.abs((await trail.boundingBox())!.y - before)).toBeLessThanOrEqual(1);
  });
});

test.describe('список запросов', () => {
  test('в строке есть число записей, в колонке и в узкой раскладке', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await find(page, 'cards/lookup');
    const row = page.locator('li[data-cid]').first();
    await expect(row.getByTestId('request-records')).toHaveText(/^\d+$/);
    await page.setViewportSize({ width: 768, height: 1024 });
    await expect(row.getByTestId('request-records-inline')).toContainText(/\d+ запис/);
  });

  test('колонка «Итог» стоит на одном месте: и в заготовке, и со строками', async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto('/pay/slow');
    const input = page.getByRole('textbox', { name: 'Значения для поиска' });
    await input.fill('pay.example');
    await input.press('Enter');
    await page.getByRole('button', { name: 'Найти', exact: true }).click();
    const head = page.getByText('Итог', { exact: true }).first();
    await expect(head).toBeVisible({ timeout: 15_000 });
    const before = (await head.boundingBox())!.x;
    await expect(page.getByTestId('search-results')).toHaveAttribute('data-status', 'done', { timeout: 80_000 });
    expect(Math.abs((await head.boundingBox())!.x - before)).toBeLessThanOrEqual(1);
  });

  test('ошибка хранилища: заголовок «Поиск не выполнен», пустых вкладок нет', async ({ page }) => {
    await page.goto('/pay/network');
    const input = page.getByRole('textbox', { name: 'Значения для поиска' });
    await input.fill('getCard');
    await input.press('Enter');
    await page.getByRole('button', { name: 'Найти', exact: true }).click();
    await expect(page.getByTestId('results-summary')).toHaveText('Поиск не выполнен', { timeout: 30_000 });
    await expect(page.getByRole('tab', { name: 'Запросы' })).toHaveCount(0);
  });
});

test.describe('первый экран страницы запроса', () => {
  for (const [width, height] of [[1536, 864], [1440, 780], [1440, 900]] as const) {
    test(`${width}×${height}: выбранный красный узел виден без прокрутки`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await openRequest(page, 'cards/sync');
      const node = scheme(page).locator('button[data-node][aria-pressed=true]');
      await expect(node).toBeVisible({ timeout: 15_000 });
      await expect.poll(async () => (await node.boundingBox())!.y + (await node.boundingBox())!.height).toBeLessThanOrEqual(height);
      expect((await node.boundingBox())!.y).toBeGreaterThanOrEqual(56);
    });
  }

  test('1366×650: выбранный узел и начало панели шага на первом экране', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 650 });
    await openRequest(page, 'cards/sync');
    const node = scheme(page).locator('button[data-node][aria-pressed=true]');
    await expect(node).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => (await node.boundingBox())!.y + (await node.boundingBox())!.height).toBeLessThanOrEqual(650);
    expect((await details(page).boundingBox())!.y).toBeLessThan(650);
  });

  test('id запроса целиком, когда хватает места; панель вкладки не в порядке Tab', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openRequest(page, 'retrying');
    const cid = page.getByTestId('request-cid');
    await expect(cid).toBeVisible();
    expect(await cid.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
    await expect(page.getByRole('tabpanel').first()).toHaveAttribute('tabindex', '-1');
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollPaddingTop)).toBe('72px');
  });

  test('клик мышью по вкладке не рисует кольцо фокуса', async ({ page }) => {
    await openRequest(page, 'retrying');
    const tab = page.getByRole('tab', { name: /^Шкала времени/ });
    await tab.click();
    expect(await tab.evaluate((e) => e.matches(':focus-visible'))).toBe(false);
  });
});

test.describe('шапка на узком экране', () => {
  test('768: проект и среда читаются, значок состояния постоянной ширины', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto('/pay/network');
    const nav = page.getByRole('navigation', { name: /Проект/ });
    await expect(nav).toContainText('Demo Pay');
    const clipped = await nav.locator('span.truncate').evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth).length);
    expect(clipped).toBe(0);
    const dot = page.getByTestId('connection-indicator');
    await expect(dot).toHaveAttribute('data-status', /.+/);
    expect((await dot.boundingBox())!.width).toBe(14);
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect.poll(async () => (await dot.boundingBox())!.width).toBe(14);
  });
});

test.describe('справочник: разделы и выгрузка', () => {
  test('текущий раздел в видимой части списка при открытии по ссылке', async ({ page }) => {
    test.skip(!(await catalogOn(page)), 'справочник выключен');
    await page.setViewportSize({ width: 1280, height: 420 });
    await page.goto('/pay/catalog/unknown');
    const list = page.getByTestId('catalog-sections');
    const current = list.locator('[aria-current=page]');
    await expect(current).toBeVisible();
    const l = (await list.boundingBox())!;
    const c = (await current.boundingBox())!;
    expect(c.y).toBeGreaterThanOrEqual(l.y - 1);
    expect(c.y + c.height).toBeLessThanOrEqual(l.y + l.height + 1);
  });

  test('заготовка на тех же местах: строка заголовка и начало разделов', async ({ page }) => {
    test.skip(!(await catalogOn(page)), 'справочник выключен');
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.route('**/api/projects/pay/catalog', async (r) => {
      await new Promise((f) => setTimeout(f, 800));
      await r.continue();
    });
    await page.goto('/pay/catalog/ids');
    const sk = page.getByTestId('catalog-skeleton');
    await expect(sk).toBeVisible();
    const top = (await sk.boundingBox())!;
    await expect(page.getByTestId('catalog-sections')).toBeVisible({ timeout: 15_000 });
    expect(Math.abs((await page.getByRole('heading', { name: 'Идентификаторы' }).boundingBox())!.y - top.y)).toBeLessThanOrEqual(4);
  });

  test('отказ выгрузки: страница называет поля, текста нет', async ({ page }) => {
    test.skip(!(await catalogOn(page)), 'справочник выключен');
    await page.route('**/api/projects/pay/catalog/export*', (r) =>
      r.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: { code: 'catalog-invalid', fields: { 'systems.2.methods.0.rpc': 'уберите номер карты' } } }) }),
    );
    await page.goto('/pay/catalog');
    await page.getByTestId('catalog-file-open').click();
    await expect(page.getByTestId('export-problem')).toContainText('systems.2.methods.0.rpc');
    await expect(page.locator('.cm-content')).toHaveCount(0);
  });

  test('ключ типа id виден целиком', async ({ page }) => {
    test.skip(!(await catalogOn(page)), 'справочник выключен');
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/pay/catalog/ids');
    const rows = page.getByTestId('id-type-row').locator('code');
    await expect(rows.first()).toBeVisible();
    expect(await rows.evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth).length)).toBe(0);
  });
});

test.describe('новые id сверх трёх значений', () => {
  test('показаны на странице с копированием, дополнения нет', async ({ page }) => {
    await page.route('**/api/searches/*?*', async (r) => {
      const res = await r.fetch();
      const body = (await res.json()) as { operation?: { unsearchedIds: unknown[]; extraIds: unknown[] } };
      if (body.operation) {
        body.operation.extraIds = [];
        body.operation.unsearchedIds = [{ type: 'card_payout', name: 'Payout', value: 'synthetic-4th-id' }];
      }
      await r.fulfill({ response: res, json: body });
    });
    await openOperation(page);
    await expect(page.getByTestId('operation-unsearched')).toContainText('synthetic-4th-id');
    await expect(page.getByTestId('operation-supplement')).toHaveCount(0);
  });
});

test.describe('шапка запроса', () => {
  for (const width of [768, 1024, 1280]) {
    test(`${width}: id операции во второй строке шапки с копированием, где хватает места — целиком`, async ({ page }) => {
      test.skip(!(await catalogOn(page)), 'ключ операции — из справочника');
      await page.setViewportSize({ width, height: 900 });
      await openRequest(page, TRANSFER, /Payout network callback/);
      const id = page.getByTestId('request-meta').getByTestId('request-operation-id');
      await expect(id).toBeVisible();
      await expect(id).toHaveText(TRANSFER);
      await expect(page.getByTestId('request-meta').getByRole('button', { name: `Скопировать id операции ${TRANSFER}` })).toBeVisible();
      // Вторая строка не переносится: на узком окне длинный id обрезается, полностью он в подсказке и при копировании.
      if (width >= 1024) expect(await id.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });
  }
});
