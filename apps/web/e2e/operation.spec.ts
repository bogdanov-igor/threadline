import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { RequestDetail, SearchState } from '@threadline/core/search';
import { businessDetail, businessState } from '@threadline/core/view/business';
import { MOCK_FLOW, MOCK_SUMMARY_PHONE } from '../../server/src/backends/mock/dataset-pay.ts';
import { closeMenu, modeSwitchInMenu, setViewMode, shareVia } from './helpers.ts';

// Страница операции и переходы между её потоками
// на демо-наборе. Id сценариев — выдуманные, из MOCK_FLOW имитации (apps/server/src/backends/mock/dataset-pay.ts).
// Типы операций и поля id — из набора справочника e2e/catalog/pay.yaml; без справочника наборы с ролями пропускаются.

const H = 3_600_000;
const TRANSFER = MOCK_FLOW.transfer;
// Сценарии лежат за столько часов до запуска сервера сквозных тестов: окно ±3 ч от этого момента их накрывает.
const transferAt = () => Date.now() - 9 * H;
const operationUrl = (value: string = TRANSFER, at = transferAt(), extra = '', type = 'transfer') =>
  `/pay/demo/operations/${type}/${value}?at=${at}&w=6h${extra}`;

const page$ = (page: Page) => page.getByTestId('operation-page');
const flows = (page: Page) => page.getByTestId('operation-flows').locator('a[data-flow]');
const row = (page: Page, role: string) => page.getByTestId('operation-flows').locator(`li[data-role=${role}]`);

/** Справочник включён: роли потоков и типы операций берутся из набора e2e. */
async function catalogOn(page: Page): Promise<boolean> {
  const res = await page.request.get('/api/catalog');
  return res.ok() && ((await res.json()) as { state?: string }).state === 'ok';
}

async function openOperation(page: Page, url = operationUrl()) {
  await page.goto(url);
  await expect(page$(page)).toHaveAttribute('data-status', 'done', { timeout: 30_000 });
}

/** Обращения к API поиска операции: запуски и чтения запросов из задания. */
function countApi(page: Page) {
  const seen = { starts: 0, requests: 0 };
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (r.method() === 'POST' && /\/operations$/.test(u.pathname)) seen.starts++;
    if (/^\/api\/projects\/.+\/requests\//.test(u.pathname)) seen.requests++;
  });
  return seen;
}

function flowFiles(): string[] {
  const manifest = JSON.parse(
    readFileSync(fileURLToPath(new URL('../dist-e2e/.vite/manifest.json', import.meta.url)), 'utf8'),
  ) as Record<string, { file: string; imports?: string[]; css?: string[] }>;
  const closure = (key: string, seen = new Set<string>()) => {
    const c = manifest[key];
    if (!c || seen.has(c.file)) return seen;
    seen.add(c.file);
    for (const css of c.css ?? []) seen.add(css);
    for (const i of c.imports ?? []) closure(i, seen);
    return seen;
  };
  // Общие чанки, которые страница операции грузит сама, не код графа.
  const shared = closure('src/features/operation/OperationPage.tsx', closure('index.html'));
  return [...closure('src/features/flow/canvas/FlowGraph.tsx')].filter((f) => !shared.has(f));
}

test.describe('страница операции в «Кратко»', () => {
  // Режим показа — только в меню профиля: на странице операции переключателя нет.
  const expectBrief = async (page: Page) => {
    const menu = await modeSwitchInMenu(page);
    await expect(menu.getByRole('menuitemradio', { name: 'Кратко', exact: true })).toHaveAttribute('aria-checked', 'true');
    await closeMenu(page);
  };

  test('нет correlation_id, полного id и хостов; поиск заново не запускается; «Обновить» работает по нажатию', async ({ page }) => {
    const api = countApi(page);
    await openOperation(page);
    await expect(page.getByTestId('operation-id')).toBeVisible();
    const text = await page$(page).innerText();
    expect(text).toMatch(/[0-9a-f]{8}…|…[0-9a-f]{4}/);
    await expect(page$(page).getByTestId('detail-switch')).toHaveCount(0);
    const before = api.starts;
    await setViewMode(page, 'Кратко');
    await expect(page.getByTestId('operation-id')).toHaveCount(0);
    expect(api.starts).toBe(before);
    const brief = await page$(page).innerText();
    expect(brief).not.toContain(TRANSFER);
    expect(brief).not.toMatch(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);
    expect(brief).not.toContain('pay.example');
    expect(brief).not.toMatch(/GET |POST /);
    await expect(page.getByTestId('operation-unsearched')).toHaveCount(0);
    const titles = await page.getByTestId('operation-flows').locator('[title]').evaluateAll((els) => els.map((el) => el.getAttribute('title') ?? ''));
    for (const t of titles) expect(t).not.toMatch(/bank\.example|\d+\.\d+\.\d+\.\d+|GET |POST /);
    await page.getByRole('button', { name: 'Обновить' }).click();
    await expect.poll(() => api.starts).toBe(before + 1);
    await expectBrief(page);
  });

  test('код графа и лишние запросы при смене режима не появляются, переход к потоку сохраняет режим', async ({ page }) => {
    await openOperation(page);
    await page.waitForLoadState('networkidle');
    const seen: string[] = [];
    page.on('request', (r) => {
      if (new URL(r.url()).pathname !== '/api/catalog') seen.push(r.url());
    });
    await setViewMode(page, 'Кратко');
    await setViewMode(page, 'Подробно');
    await setViewMode(page, 'Кратко');
    expect(seen).toEqual([]);
    await flows(page).first().click();
    await expect(page.getByTestId('request-header')).toBeVisible();
    await expect(page.getByTestId('request-cid')).toHaveCount(0);
    // У страницы запроса переключателя на странице тоже нет: выбор виден в меню профиля.
    await expectBrief(page);
  });
});

test.describe('страница операции', () => {
  test('шапка с итогом и окном, список потоков по времени, id задания в адресе, код графа не грузится', async ({
    page,
  }) => {
    const files = flowFiles();
    const asked: string[] = [];
    page.on('request', (r) => asked.push(new URL(r.url()).pathname.replace(/^\//, '')));
    await openOperation(page);
    await expect(page).toHaveURL(/[?&]search=[\w-]+/);
    const header = page.getByTestId('operation-header');
    await expect(header.getByRole('heading', { level: 1 })).toContainText('…5c6d');
    await expect(page.getByTestId('operation-outcome')).toBeVisible();
    await expect(
      page.getByRole('group', { name: 'Окно поиска' }).getByRole('link', { name: '±3 ч' }),
    ).toHaveAttribute('aria-current', 'true');
    await expect(flows(page).first()).toBeVisible();
    // Опросы партнёра — одной строкой, эти потоки не читались.
    await expect(page.getByTestId('operation-flows').locator('[data-kind=polls]')).toContainText(
      /Опросы партнёра ×\d+/,
    );
    expect(asked.filter((u) => files.includes(u))).toEqual([]);
  });

  test('переходы: поток → «Запрос N из M» → следующий → «← К операции» без новых чтений хранилища', async ({
    page,
  }) => {
    const api = countApi(page);
    await openOperation(page);
    const search = new URL(page.url()).searchParams.get('search');
    expect(api.starts).toBe(1);
    await flows(page).first().click();
    await expect(page.getByTestId('request-header')).toBeVisible();
    const nav = page.getByTestId('operation-nav');
    await expect(nav.getByTestId('operation-position')).toHaveText(/^Запрос 1 из \d+$/);
    await nav.getByRole('link', { name: 'Следующий запрос операции' }).click();
    await expect(nav.getByTestId('operation-position')).toHaveText(/^Запрос 2 из \d+$/);
    // Возврат — значком: подпись в подсказке и для чтения с экрана, текста на кнопке нет.
    const back = nav.getByRole('link', { name: 'К операции', exact: true });
    await expect(back).toHaveText('');
    // Возврат — к тому же заданию: страница подключается к нему по ссылке, нового поиска нет.
    await back.click();
    await expect(page$(page)).toHaveAttribute('data-status', 'done');
    expect(new URL(page.url()).searchParams.get('search')).toBe(search);
    expect(api.starts).toBe(1);
    // Запросы брались из задания, а не по ссылке с чтением хранилища.
    expect(api.requests).toBe(0);
  });

  test('возврат к операции через 61 с по подменённым часам: поиск из памяти, новых запусков нет', async ({
    page,
  }) => {
    await page.clock.install();
    const api = countApi(page);
    await openOperation(page);
    await flows(page).first().click();
    await expect(page.getByTestId('operation-nav')).toBeVisible();
    await page.clock.fastForward(61_000);
    await page.getByTestId('operation-nav').getByRole('link', { name: 'К операции', exact: true }).click();
    await expect(page$(page)).toHaveAttribute('data-status', 'done');
    expect(api.starts).toBe(1);
  });

  test('ссылка коллеге: задание уже удалено — поиск по тому же значению, моменту и окну заново', async ({
    page,
  }) => {
    const api = countApi(page);
    await openOperation(page, operationUrl(TRANSFER, transferAt(), '&search=nosuchsearch'));
    expect(api.starts).toBe(1);
    await expect(page).not.toHaveURL(/search=nosuchsearch/);
  });

  test('окно ±12 ч: новый поиск и пометка про операции дольше суток', async ({ page }) => {
    await openOperation(page);
    await page.getByRole('group', { name: 'Окно поиска' }).getByRole('link', { name: '±12 ч' }).click();
    await expect(page$(page)).toHaveAttribute('data-status', 'done', { timeout: 30_000 });
    await expect(page).toHaveURL(/w=24h/);
    await expect(page.getByTestId('operation-notices')).toContainText(
      'Операции дольше 24 часов собираются только в окне ±12 часов.',
    );
  });

  test('короткий id — сообщение без обращения к серверу', async ({ page }) => {
    const api = countApi(page);
    await page.goto('/pay/demo/operations/transfer/4821?at=1');
    await expect(page.getByRole('heading', { name: 'id операции слишком короткий' })).toBeVisible();
    expect(api.starts).toBe(0);
  });

  test('номер карты вместо id — «значение не может быть id операции»', async ({ page }) => {
    await page.goto(operationUrl('4000000000000002'));
    await expect(page.getByRole('heading', { name: 'Значение не может быть id операции' })).toBeVisible({
      timeout: 15_000,
    });
  });

  test('768px: нет горизонтальной прокрутки страницы', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1000 });
    await openOperation(page);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
    ).toBeLessThanOrEqual(0);
  });

  for (const colorScheme of ['light', 'dark'] as const) {
    test(`axe на странице операции и на её потоке, ${colorScheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme });
      await openOperation(page);
      const check = async (where: string) => {
        const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
        expect(
          r.violations.map((v) => `${where}: ${v.id} ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
        ).toEqual([]);
      };
      await check('операция');
      await flows(page).first().click();
      await expect(page.getByTestId('flow-canvas')).toBeVisible({ timeout: 15_000 });
      await check('поток');
    });
  }
});

test.describe('таблица запросов', () => {
  /** Подменяет состав операции в ответе: поведение страницы настоящее, строки выдуманные. */
  async function withFlows(page: Page, build: (at: number) => unknown[]) {
    await page.route('**/api/searches/*', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const res = await route.fetch();
      const body = (await res.json()) as { operation?: { items: unknown[]; trail: unknown[] } };
      if (body.operation) body.operation.items = build(Date.now() - 9 * H);
      return route.fulfill({ response: res, json: body });
    });
  }
  const flow = (i: number, firstMs: number, lastMs: number) => ({
    kind: 'flow',
    cid: `cid-${i}`,
    segment: null,
    nocid: false,
    firstMs,
    lastMs,
    role: 'call',
    title: `Запрос ${i}`,
    status: 'success',
    incomplete: false,
    error: false,
    opStatus: null,
    claimed: false,
    noStatus: false,
    ops: 1,
    linkedBy: [],
    found: null,
    pauseMs: i === 0 ? null : 1000,
    together: false,
    callbackEarly: false,
    firstRecordId: null,
  });
  const rows = (page: Page) => page.getByTestId('operation-flows').locator('> li');

  test('строка 56 px, буквы по порядку, шкала от 200 до 360 px и общая для всех строк', async ({ page }) => {
    await withFlows(page, (at) => [flow(0, at, at + 500), flow(1, at + 60_000, at + 90_000), flow(2, at + 120_000, at + 120_020)]);
    await openOperation(page);
    const list = rows(page);
    await expect(list).toHaveCount(3);
    for (let i = 0; i < 3; i++) {
      expect((await list.nth(i).locator('> div').first().boundingBox())?.height).toBe(56);
      await expect(list.nth(i).locator('> div > span').first()).toHaveText('ABC'[i]!);
    }
    const tracks = page.getByTestId('operation-flows').getByRole('img');
    const first = (await tracks.first().boundingBox())!;
    expect(first.width).toBeGreaterThanOrEqual(200);
    expect(first.width).toBeLessThanOrEqual(360);
    // Последний запрос у конца шкалы, короткий не уже 4 px; расстояние показывает паузу.
    const bars = tracks.locator('i');
    const last = (await bars.nth(2).boundingBox())!;
    expect(last.width).toBeGreaterThanOrEqual(4);
    expect(last.x + last.width).toBeCloseTo(first.x + first.width, 0);
    const second = (await bars.nth(1).boundingBox())!;
    expect(second.x - first.x).toBeCloseTo(first.width / 2, -1);
  });

  test('768px: шкалы и «Кто позвал» нет, начало и длительность числом, вбок страница не едет', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 900 });
    await withFlows(page, (at) => [flow(0, at, at + 500), flow(1, at + 60_000, at + 90_000)]);
    await openOperation(page);
    await expect(page.getByTestId('operation-flows').getByRole('img')).toHaveCount(0);
    await expect(page.getByText('Кто позвал')).toBeHidden();
    await expect(rows(page).first()).toContainText(/\d\d:\d\d:\d\d/);
    await expect(rows(page).first()).toContainText('500');
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  });

  test('длинная операция: 2 часа и 50 запросов, таблица растёт вниз, метки не уже 4 px', async ({ page }) => {
    const step = (2 * H) / 49;
    await withFlows(page, (at) => Array.from({ length: 50 }, (_, i) => flow(i, at + i * step, at + i * step + 20)));
    await openOperation(page);
    await expect(rows(page)).toHaveCount(50);
    await expect(page.getByTestId('operation-show-all')).toHaveCount(0);
    const widths = await page.getByTestId('operation-flows').getByRole('img').locator('i').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width));
    expect(Math.min(...widths)).toBeGreaterThanOrEqual(4);
  });

  test('больше 50 запросов: видно 50 и «Показать все», нажатие к хранилищу не обращается', async ({ page }) => {
    const api = countApi(page);
    await withFlows(page, (at) => Array.from({ length: 51 }, (_, i) => flow(i, at + i * 1000, at + i * 1000 + 20)));
    await openOperation(page);
    await expect(rows(page)).toHaveCount(50);
    const starts = api.starts;
    await page.getByTestId('operation-show-all').click();
    await expect(rows(page)).toHaveCount(51);
    await expect(page.getByTestId('operation-show-all')).toHaveCount(0);
    expect(api.starts).toBe(starts);
    expect(api.requests).toBe(0);
  });

  test('раскрытие строки: граф потока и «Открыть запрос», код графа только теперь, хранилище не читается', async ({ page }) => {
    const files = flowFiles();
    const asked: string[] = [];
    page.on('request', (r) => asked.push(new URL(r.url()).pathname.replace(/^\//, '')));
    const api = countApi(page);
    await openOperation(page);
    expect(asked.filter((u) => files.includes(u))).toEqual([]);
    const first = rows(page).first();
    await expect(page.getByTestId('operation-flow-preview')).toHaveCount(0);
    await first.getByRole('button', { expanded: false }).click();
    const preview = page.getByTestId('operation-flow-preview');
    await expect(preview.getByTestId('flow-canvas')).toBeVisible({ timeout: 15_000 });
    expect(asked.filter((u) => files.includes(u)).length).toBeGreaterThan(0);
    expect(api.starts).toBe(1);
    expect(api.requests).toBe(0);
    // Вся строка раскрывает так же, как кнопка; название по-прежнему ведёт на запрос.
    await first.locator('> div').first().click({ position: { x: 4, y: 4 } });
    await expect(preview).toHaveCount(0);
    await first.locator('> div').first().click({ position: { x: 4, y: 4 } });
    await expect(preview).toBeVisible();
    await preview.getByTestId('operation-open-request').click();
    await expect(page.getByTestId('request-header')).toBeVisible();
    await expect(page.getByTestId('operation-nav').getByTestId('operation-position')).toHaveText(/^Запрос 1 из \d+$/);
    expect(api.requests).toBe(0);
  });

  test('граф не загрузился: под строкой сообщение и «Повторить», «Открыть запрос» работает, страница на месте', async ({ page }) => {
    const files = flowFiles();
    const block = (url: URL) => files.some((f) => url.pathname.endsWith(f));
    await page.route(block, (r) => r.abort());
    // Без этого первый сбой перезагружает страницу один раз: так обновляется устаревшая выкладка (flow/load.ts).
    await page.addInitScript(() => sessionStorage.setItem('threadline.flow.reloaded', '1'));
    await openOperation(page);
    await rows(page).first().getByRole('button', { expanded: false }).click();
    const preview = page.getByTestId('operation-flow-preview');
    await expect(preview.getByText('Схему не удалось загрузить')).toBeVisible({ timeout: 15_000 });
    await expect(preview.getByTestId('operation-open-request')).toHaveAttribute('href', /\/requests\//);
    await expect(page.getByTestId('operation-header')).toBeVisible();
    await expect(rows(page).nth(1)).toBeVisible();
    await page.unroute(block);
    await preview.getByRole('button', { name: 'Повторить' }).click();
    await expect(preview.getByTestId('flow-canvas')).toBeVisible({ timeout: 15_000 });
  });
});

test.describe('сценарии операции', () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!(await catalogOn(page)), 'справочник выключен: типы операций и поля id задаёт набор e2e/catalog/pay.yaml');
  });

  test('колбэк раньше ответа на создание: итог «Declined» по колбэку, ход статусов «заявлено в колбэке»', async ({ page }) => {
    await openOperation(page);
    await expect(page.getByTestId('operation-outcome')).toContainText('Declined');
    await expect(page.getByTestId('operation-outcome')).toContainText('по колбэку');
    await expect(page.getByTestId('operation-trail')).toContainText('заявлено в колбэке');
    await expect(row(page, 'call')).toContainText('POST /v1/users/{user}/transfers');
    await expect(row(page, 'worker')).toContainText('Card payout');
    await expect(row(page, 'callback')).toContainText('колбэк раньше ответа на создание');
  });

  test('дополнение по id выплаты: новое задание, значение в адресе, второй раз не предлагается', async ({ page }) => {
    const supplements: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && /\/supplement$/.test(new URL(r.url()).pathname)) supplements.push(r.url());
    });
    await openOperation(page);
    const before = new URL(page.url()).searchParams.get('search');
    const count = await flows(page).count();
    const button = page.getByTestId('operation-supplement');
    await expect(button).toHaveText('Искать и по id «Payout»');
    await button.click();
    await expect(page).toHaveURL(new RegExp(`also=card_payout%3A${MOCK_FLOW.payoutId}`));
    await expect(page$(page)).toHaveAttribute('data-status', 'done', { timeout: 30_000 });
    expect(new URL(page.url()).searchParams.get('search')).not.toBe(before);
    expect(supplements).toHaveLength(1);
    await expect(page.getByTestId('operation-supplement')).toHaveCount(0);
    // Короткий id искался с привязкой к полю transfer_id: запись с теми же цифрами во времени в операцию не попала.
    await expect(flows(page)).toHaveCount(count);
  });

  test('опросы партнёра: 40 опросов одной строкой, потоки опросов не читались', async ({ page }) => {
    await openOperation(page, operationUrl(MOCK_FLOW.polledPayment, Date.now() - 16 * H, '', 'payment'));
    await expect(page.getByTestId('operation-flows').locator('[data-kind=polls]')).toContainText('Опросы партнёра ×40');
    await expect(flows(page)).toHaveCount(2);
    await expect(row(page, 'call')).toContainText('POST /v1/users/{user}/payments');
  });

  test('фоновые потоки: попытки без correlation_id свёрнуты, сегмент открывается своей страницей', async ({ page }) => {
    await openOperation(page, operationUrl(MOCK_FLOW.payment, Date.now() - 10.5 * H, '', 'payment'));
    // Ветка A: два запуска воркера без correlation_id — одна группа «×2».
    const group = page.getByTestId('operation-flows').locator('li[data-kind=group][data-role=worker]');
    await expect(group).toContainText('Payment hold');
    await expect(group).toContainText('×2');
    await group.getByRole('button', { expanded: false }).click();
    const attempts = group.locator('a[data-flow]');
    await expect(attempts).toHaveCount(2);
    await expect(group.locator('ol > li').first()).toContainText('записи без correlation_id');
    // Ветка B: подтверждение и две попытки под одним correlation_id — три сегмента, у каждого своя ссылка.
    const segments = page.getByTestId('operation-flows').locator('a[data-flow*="#"]');
    await expect(segments).toHaveCount(3);
    expect(new Set(await segments.evaluateAll((els) => els.map((e) => e.getAttribute('href'))))).toHaveProperty('size', 3);
    await attempts.first().click();
    await expect(page.getByTestId('request-header')).toBeVisible();
    await expect(page.getByTestId('operation-nav').getByTestId('operation-position')).toHaveText(/^Запрос 1 из \d+$/);
    await expect(page.getByTestId('trace-scheme')).toContainText('Payment hold');
  });

  test('джоба по трём рассрочкам: поток обрабатывает 3 операции, ошибка видна в строке', async ({ page }) => {
    await openOperation(page, operationUrl(MOCK_FLOW.installments[1], Date.now() - 12 * H, '', 'installment'));
    const job = row(page, 'worker');
    await expect(job).toContainText('Installment charge');
    await expect(job).toContainText('обрабатывает 3 операции');
    await expect(job.locator('[data-status=error]')).toHaveCount(1);
  });

  /** Поиск в демо-среде и запрос первой строки с нужным текстом. */
  async function openRequest(page: Page, term: string, text: string | RegExp) {
    await page.goto('/pay/demo');
    const input = page.getByRole('textbox', { name: 'Значения для поиска' });
    await input.fill(term);
    await input.press('Enter');
    await page.getByRole('group', { name: 'Период' }).getByRole('button', { name: '24 ч', exact: true }).click();
    await page.getByRole('button', { name: 'Найти', exact: true }).click();
    await expect(page.getByTestId('search-results')).toHaveAttribute('data-status', 'done', { timeout: 20_000 });
    const found = page.getByRole('list', { name: 'Найденные запросы' }).getByRole('listitem').filter({ hasText: text });
    await found.first().locator('[data-row-link]').click({ position: { x: 8, y: 8 } });
    await expect(page.getByTestId('request-header')).toBeVisible();
  }

  test('«Операция» из запроса: только по кнопке → итог и ход → поток → «К операции» через 61 с без нового поиска', async ({ page }) => {
    await page.clock.install();
    const api = countApi(page);
    await openRequest(page, TRANSFER, /Payout network callback/);
    // В шапке тихая кнопка «Операция»: тип и конец id — в её имени и подсказке.
    const button = page.getByTestId('request-header').getByTestId('open-operation');
    await expect(button).toHaveText('Операция');
    await expect(button).toHaveAccessibleName('Открыть операцию · Transfer …5c6d');
    // Открытие запроса операцию не ищет: хранилище не нагружается.
    await page.getByRole('tab', { name: 'Схема' }).click();
    expect(api.starts).toBe(0);
    await button.click();
    await expect(page.getByTestId('operation-page')).toHaveAttribute('data-status', 'done', { timeout: 30_000 });
    await expect(page).toHaveURL(/\/pay\/demo\/operations\/transfer\/5b0e6c3a-[\w-]+\?.*w=6h/);
    expect(api.starts).toBe(1);
    await expect(page.getByTestId('operation-outcome')).toBeVisible();
    await expect(page.getByTestId('operation-trail')).toBeVisible();
    await flows(page).first().click();
    const nav = page.getByTestId('operation-nav');
    await expect(nav.getByTestId('operation-position')).toHaveText(/^Запрос 1 из \d+$/);
    await page.clock.fastForward(61_000);
    await nav.getByRole('link', { name: 'К операции', exact: true }).click();
    await expect(page.getByTestId('operation-page')).toHaveAttribute('data-status', 'done');
    expect(api.starts).toBe(1);
    expect(api.requests).toBe(0);
  });

  test('полный id с копированием во второй строке шапки, у кнопки «Операция» копии нет; у запроса без ключа операции кнопки нет', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openRequest(page, TRANSFER, /Payout network callback/);
    const header = page.getByTestId('request-header');
    const meta = page.getByTestId('request-meta');
    await expect(meta.getByTestId('request-operation-id')).toHaveText(TRANSFER);
    // Кнопка копирования id одна на шапку — в строке сведений.
    await expect(header.getByRole('button', { name: new RegExp(TRANSFER) })).toHaveCount(1);
    await meta.getByRole('button', { name: `Скопировать id операции ${TRANSFER}` }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(TRANSFER);
    await openRequest(page, 'switch.pay.example', /./);
    await expect(page.getByTestId('open-operation')).toHaveCount(0);
  });

  test('поток джобы с тремя рассрочками: кнопка даёт выбрать из трёх id', async ({ page }) => {
    await openRequest(page, MOCK_FLOW.installments[1], /./);
    const button = page.getByTestId('open-operation');
    await expect(button).toHaveText('Операция');
    await expect(button).toHaveAccessibleName('Открыть операцию · Installment: 3');
    await button.click();
    const choices = page.getByTestId('operation-choice');
    await expect(choices).toHaveCount(3);
    await choices.nth(1).click();
    await expect(page).toHaveURL(new RegExp(`/operations/installment/${MOCK_FLOW.installments[1]}`));
    await expect(page.getByTestId('operation-page')).toHaveAttribute('data-status', 'done', { timeout: 30_000 });
  });

  test('действие на узле графа с ключом операции ведёт на её страницу', async ({ page }) => {
    await openRequest(page, TRANSFER, /Payout network callback/);
    await expect(page.getByTestId('flow-canvas')).toBeVisible({ timeout: 15_000 });
    const action = page.getByTestId('trace-scheme').getByTestId('node-operation').first();
    await expect(action).toBeVisible();
    await action.click();
    await expect(page).toHaveURL(/\/operations\/transfer\//);
    await expect(page.getByTestId('operation-page')).toHaveAttribute('data-status', 'done', { timeout: 30_000 });
  });

  test('значение скрыто маскированием: ключ не становится поиском, подсказка на кнопке', async ({ page }) => {
    // Маскирование значения id зависит от правил среды: разметка подменяется в ответе, поведение кнопки — настоящее.
    await page.route('**/api/searches/*/requests/*', async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as { operationKeys?: { masked: boolean; value: string }[] };
      for (const k of body.operationKeys ?? []) {
        k.masked = true;
        k.value = '****';
      }
      await route.fulfill({ response: res, json: body });
    });
    await openRequest(page, TRANSFER, /Payout network callback/);
    const button = page.getByTestId('open-operation');
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    await expect(button.getByRole('button')).toBeDisabled();
    await expect(button.getByRole('button')).toHaveAccessibleName(/id скрыт маскированием/);
  });

  test('«Обновить» ищет заново с новым заданием, «Поделиться» копирует короткую ссылку', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const api = countApi(page);
    await openOperation(page);
    const first = new URL(page.url()).searchParams.get('search');
    expect(api.starts).toBe(1);
    await page.getByTestId('operation-header').getByRole('button', { name: 'Обновить' }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('search')).not.toBe(first);
    await expect(page$(page)).toHaveAttribute('data-status', 'done', { timeout: 30_000 });
    expect(api.starts).toBe(2);
    await page.getByTestId('operation-header').getByRole('button', { name: 'Поделиться' }).click();
    await page.getByTestId('share-item-link').click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toMatch(/\/s\/[A-Za-z0-9_-]{22}$/);
  });

  test('ссылка старше срока хранения: записей уже нет, поиска в хранилище нет', async ({ page }) => {
    await page.goto(operationUrl(TRANSFER, Date.now() - 120 * 24 * H));
    await expect(page.getByRole('heading', { name: 'Записей операции уже нет' })).toBeVisible({ timeout: 15_000 });
  });

  test('тип не описан: ключ типа вместо названия, потоки как найденные по тексту, итог не прочитан', async ({ page }) => {
    await openOperation(page, operationUrl(TRANSFER, transferAt(), '', 'no_such_type'));
    await expect(page.getByTestId('operation-notices')).toContainText('Тип id «no_such_type» не описан в справочнике');
    await expect(page.getByTestId('operation-outcome')).toContainText('Итог не прочитан');
    await expect(page.getByTestId('operation-flows').locator('li[data-role=mention]').first()).toContainText(/id в тексте записи/i);
  });

  test('в окне ничего не нашлось: «других запросов нет» и предложение окна ±12 ч', async ({ page }) => {
    await openOperation(page, operationUrl('ffffffff-ffff-4fff-8fff-ffffffffffff'));
    const notices = page.getByTestId('operation-notices');
    await expect(notices).toContainText('Других запросов в окне не найдено');
    await notices.getByRole('link', { name: 'Искать в окне ±12 ч' }).click();
    await expect(page).toHaveURL(/w=24h/);
  });

  test('сегмент без correlation_id по сохранённой ссылке: предлагает открыть операцию заново, поиска нет', async ({ page }) => {
    const api = countApi(page);
    const reads: string[] = [];
    page.on('request', (r) => {
      if (/\/requests\//.test(new URL(r.url()).pathname) && new URL(r.url()).pathname.startsWith('/api/')) reads.push(r.url());
    });
    const op = encodeURIComponent(operationUrl(MOCK_FLOW.payment, Date.now() - 10.5 * H, '', 'payment'));
    await page.goto(`/pay/demo/requests/nocid:${MOCK_FLOW.nocidPod}:${Date.now() - 10.5 * H}?op=${op}`);
    await expect(page.getByRole('heading', { name: 'Поиск операции истёк: откройте операцию заново' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Открыть операцию' })).toHaveAttribute('href', /\/operations\/payment\//);
    expect(api.starts).toBe(0);
    expect(reads).toEqual([]);
  });

  test('сообщения пределов и исключений селектора видны на странице, итог подписан «по неполным данным»', async ({ page }) => {
    await page.route('**/api/searches/*', async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as { operation?: { excluded: string[]; items: unknown[]; outcome: { partial: boolean } } };
      if (body.operation) {
        const at = Date.now() - 9 * H;
        body.operation.excluded = ['container != pgadmin'];
        body.operation.outcome.partial = true;
        body.operation.items.push({ kind: 'unread', count: 12, fromMs: at, toMs: at + H, reason: 'limit' });
      }
      await route.fulfill({ response: res, json: body });
    });
    await openOperation(page);
    await expect(page.getByTestId('operation-notices')).toContainText('Не ищутся записи: container != pgadmin');
    await expect(page.getByTestId('operation-outcome')).toContainText('по неполным данным');
    await expect(page.getByTestId('operation-flows').locator('[data-kind=unread]')).toContainText(/12 запросов в (\d\d\.\d\d )?\d\d:\d\d–(\d\d\.\d\d )?\d\d:\d\d не прочитаны/);
  });

  test('ошибка хранилища: сообщение и «Повторить», на странице нет пустого итога', async ({ page }) => {
    await page.goto(`/pay/network/operations/transfer/${TRANSFER}?at=${transferAt()}&w=6h`);
    await expect(page.getByRole('alert').or(page.getByRole('heading', { name: 'Операцию не удалось собрать' })).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('alert')).toContainText('Поиск остановлен');
    await expect(page.getByTestId('operation-retry')).toBeVisible();
    // Логи не прочитаны: вывода об операции на странице нет.
    await expect(page.getByTestId('operation-page')).not.toContainText('Статусов операции в логах нет');
    await expect(page.getByTestId('operation-page')).not.toContainText('0 запросов');
    await expect(page.getByTestId('operation-trail-empty')).toContainText('Не прочитано: поиск остановлен');
    await expect(page.getByTestId('operation-flows-empty')).toContainText('Не прочитано: поиск остановлен');
    await expect(page.getByTestId('operation-outcome')).toContainText('Поиск не завершён');
  });

  test('граф потока из операции: более поздние потоки — узлами-ссылками, переход к следующему потоку', async ({ page }) => {
    await openOperation(page);
    await row(page, 'call').locator('a[data-flow]').click();
    await expect(page.getByTestId('flow-canvas')).toBeVisible({ timeout: 15_000 });
    const refs = page.getByTestId('trace-scheme').locator('button[data-node][data-kind=flow-ref]');
    await expect(refs.first()).toBeVisible();
    await refs.first().click();
    await expect(page.getByTestId('operation-nav').getByTestId('operation-position')).toHaveText(/^Запрос [2-9] из \d+$/);
  });
});

// Блок «Что случилось» на сценариях MOCK_FLOW: failedTransfer, undescribedPayment, retriedPayout, plainPayout.
test.describe('блок «Что случилось»', () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!(await catalogOn(page)), 'справочник выключен: типы операций и поля id задаёт набор e2e/catalog/pay.yaml');
  });

  const summary = (page: Page) => page.getByTestId('operation-summary');
  const text = (page: Page) => page.getByTestId('operation-summary-text');
  const summaryLink = (page: Page) => page.getByTestId('operation-summary-link');
  const failedUrl = () => operationUrl(MOCK_FLOW.failedTransfer, Date.now() - 18.2 * H);
  const undescribedUrl = () => operationUrl(MOCK_FLOW.undescribedPayment, Date.now() - 18.7 * H, '', 'payment');

  /** Чтения записей запроса браузером: из задания и со страницы короткой ссылки. */
  function countReads(page: Page) {
    const seen: string[] = [];
    page.on('request', (r) => {
      const path = new URL(r.url()).pathname;
      if (/^\/api\/(searches|s)\/[^/]+\/requests\//.test(path)) seen.push(path);
    });
    return seen;
  }

  /** Страница глазами Бизнеса: те же функции ответов, что на сервере ролей (auth/present.ts). Набор идёт с auth: off. */
  async function asBusiness(page: Page) {
    await page.route('**/api/auth/me', (route) => route.fulfill({ json: { mode: 'on', user: { name: 'Тест Бизнес' }, role: 'business', capabilities: ['view'] } }));
    await page.route('**/api/searches/*', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      const res = await route.fetch();
      await route.fulfill({ response: res, json: res.ok() ? businessState((await res.json()) as SearchState) : await res.json() });
    });
    await page.route('**/api/searches/*/requests/*', async (route) => {
      const res = await route.fetch();
      await route.fulfill({ response: res, json: res.ok() ? businessDetail((await res.json()) as RequestDetail) : await res.json() });
    });
  }

  test('операция не прошла: самая ранняя ошибка, одно чтение, таблица не ждёт и не двигается', async ({ page }) => {
    const reads = countReads(page);
    let release = () => undefined as void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/searches/*/requests/*', async (route) => {
      await held;
      await route.continue();
    });
    await openOperation(page, failedUrl());
    await expect(summary(page)).toHaveAttribute('data-state', 'loading');
    await expect(flows(page)).toHaveCount(3);
    const table = page.getByTestId('operation-flows');
    const before = (await table.boundingBox())!.y;
    release();
    await expect(summary(page)).toHaveAttribute('data-state', 'reason');
    expect((await table.boundingBox())!.y).toBe(before);

    await expect(summary(page)).toHaveAttribute('data-lead', 'failure');
    await expect(text(page)).toContainText("Операция «Transfer» не прошла. Шаг «Payment core · Transfer hold» в запросе 1 из 3: Not enough money in the customer's account");
    await expect(summary(page).getByTestId('reason-action')).toContainText('Что делать: Offer the customer another card');
    await expect(summary(page)).not.toContainText('Transfer processing failed');
    await expect(summary(page).getByRole('heading', { name: 'Что случилось' })).toBeAttached();
    expect(reads).toHaveLength(1);
    const axe = await new AxeBuilder({ page }).include('[data-testid=operation-summary]').withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(axe.violations).toEqual([]);

    // Смена режима: слова этого режима, нового чтения нет, таблица на месте.
    await setViewMode(page, 'Кратко');
    await expect(text(page)).toContainText("Not enough money in the customer's account");
    await expect(summary(page)).not.toContainText('HTTP');
    expect((await table.boundingBox())!.y).toBe(before);
    expect(reads).toHaveLength(1);

    // Ключ тот же, что у страницы запроса: переход не читает записи заново.
    await summaryLink(page).click();
    await expect(page.getByTestId('operation-nav').getByTestId('operation-position')).toHaveText('Запрос 1 из 3');
    await expect(page.getByTestId('request-reasons')).toContainText("Not enough money in the customer's account");
    expect(reads).toHaveLength(1);
  });

  test('чтение не удалось: короткая строка со ссылкой, сообщения об ошибке нет, логи не читаются', async ({ page }) => {
    const api = countApi(page);
    await page.route('**/api/searches/*/requests/*', (route) => route.fulfill({ status: 500, json: { code: 'unknown' } }));
    await openOperation(page, failedUrl());
    await expect(summary(page)).toHaveAttribute('data-state', 'plain');
    await expect(text(page)).toHaveText('Операция «Transfer» не прошла. Подробности в запросе 1 из 3.');
    await expect(summary(page).locator('[role=alert]')).toHaveCount(0);
    expect(api.requests).toBe(0);
    await page.unroute('**/api/searches/*/requests/*');
    await summaryLink(page).click();
    await expect(page.getByTestId('request-reasons')).toContainText("Not enough money in the customer's account");
  });

  test('успех без ошибок: блока нет, записи не запрашиваются', async ({ page }) => {
    const reads = countReads(page);
    await openOperation(page, operationUrl(MOCK_FLOW.plainPayout, Date.now() - 19.7 * H, '', 'card_payout'));
    await expect(page.getByTestId('operation-outcome')).toHaveAttribute('data-kind', 'success');
    await expect(flows(page)).toHaveCount(1);
    await expect(summary(page)).toHaveCount(0);
    expect(reads).toEqual([]);
  });

  test('без чтения записей: прошла после ошибки, отказ статусом, запрос на несколько операций', async ({ page }) => {
    const reads = countReads(page);
    await openOperation(page, operationUrl(MOCK_FLOW.retriedPayout, Date.now() - 19.2 * H, '', 'card_payout'));
    await expect(text(page)).toHaveText('Операция «Payout» прошла. Запросов с ошибкой: 1, первая ошибка в запросе 1 из 2.');
    await expect(summary(page)).toHaveAttribute('data-kind', 'calm');

    await openOperation(page);
    await expect(text(page)).toHaveText('Операция «Transfer» не прошла. Статус «Declined» в запросе 3 из 3.');

    await openOperation(page, operationUrl(MOCK_FLOW.installments[1], Date.now() - 12 * H, '', 'installment'));
    await expect(summary(page)).toHaveAttribute('data-kind', 'shared');
    await expect(text(page)).toContainText('обрабатывает 3 операции, причина может относиться к другой');
    expect(reads).toEqual([]);
  });

  test('ошибки нет в справочнике: текст лога под маской, у Бизнеса общие слова и «передайте ссылку»', async ({ page, browser }) => {
    await openOperation(page, undescribedUrl());
    await expect(summary(page)).toHaveAttribute('data-lead', 'unknown');
    await expect(text(page)).toContainText('Итог операции «Payment» не прочитан.');
    await expect(text(page)).toContainText('Gateway refused client');
    await expect(summary(page)).not.toContainText(MOCK_SUMMARY_PHONE);
    expect(await text(page).getAttribute('title')).not.toContain(MOCK_SUMMARY_PHONE);
    await expect(summary(page).getByTestId('reasons-undescribed')).toHaveCount(0);

    const context = await browser.newContext({ baseURL: new URL(page.url()).origin, locale: 'ru-RU' });
    const business = await context.newPage();
    await asBusiness(business);
    await openOperation(business, undescribedUrl());
    await expect(text(business)).toContainText('Внешняя система ответила ошибкой');
    await expect(summary(business).getByTestId('reasons-undescribed')).toHaveText('Ошибка ещё не описана, передайте ссылку в поддержку');
    await expect(summary(business)).not.toContainText('Gateway refused');
    await context.close();
  });

  test('Бизнес: только слова справочника, без кодов, адресов и текста логов', async ({ page }) => {
    await asBusiness(page);
    await openOperation(page, failedUrl());
    await expect(page.getByTestId('detail-switch')).toHaveCount(0);
    await expect(text(page)).toContainText('Операция «Transfer» не прошла.');
    await expect(text(page)).toContainText("в запросе 1 из 3: Not enough money in the customer's account");
    await expect(summary(page).getByTestId('reason-action')).toContainText('Offer the customer another card');
    await expect(summary(page).getByTestId('reasons-undescribed')).toHaveCount(0);
    for (const word of ['HTTP', 'ledger.pay.example', '/v1/transfers', 'Insufficient funds on account', 'POST']) await expect(summary(page)).not.toContainText(word);
    expect(await text(page).getAttribute('title')).not.toMatch(/Insufficient funds on account|ledger\.pay|\/v1\/transfers/);
  });

  test('короткая ссылка: блок есть, записи только через /api/s/, глазка и контакта нет', async ({ page, context, browser }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openOperation(page, failedUrl());
    await shareVia(page, 'link', page.getByTestId('operation-header'));
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toMatch(/\/s\/[A-Za-z0-9_-]{22}$/);
    const link = await page.evaluate(() => navigator.clipboard.readText());

    const anonymous = await browser.newContext({ locale: 'ru-RU' });
    const shared = await anonymous.newPage();
    const paths: string[] = [];
    shared.on('request', (r) => paths.push(new URL(r.url()).pathname));
    await shared.goto(link);
    await expect(shared.getByTestId('operation-page')).toHaveAttribute('data-status', 'done', { timeout: 30_000 });
    await expect(text(shared)).toContainText('Операция «Transfer» не прошла.');
    await expect(text(shared)).toContainText("Not enough money in the customer's account");
    await expect(shared.getByTestId('reveal-button')).toHaveCount(0);
    await expect(shared.getByTestId('support-contact')).toHaveCount(0);
    expect(paths.filter((p) => /\/requests\//.test(p))).toHaveLength(1);
    expect(paths.filter((p) => p.startsWith('/api/searches') || p.startsWith('/api/support-contact'))).toEqual([]);

    const id = new URL(link).pathname.split('/')[2];
    expect(await summaryLink(shared).getAttribute('href')).toMatch(new RegExp(`^/s/${id}/operations/transfer/${MOCK_FLOW.failedTransfer}\\?flow=`));
    await summaryLink(shared).click();
    await expect(shared.getByTestId('request-header')).toBeVisible({ timeout: 20_000 });
    await expect(shared.getByTestId('reveal-button')).toHaveCount(0);
    await expect(shared.getByTestId('operation-nav').getByTestId('operation-position')).toHaveText('Запрос 1 из 3');
    expect(paths.filter((p) => /\/requests\//.test(p))).toHaveLength(1);
    await anonymous.close();
  });
});
