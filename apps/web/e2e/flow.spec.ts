import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setViewMode } from './helpers.ts';

// Граф потока на вкладке «Схема» на демо-наборе: слева направо, с масштабом и панорамой. Цепочка,
// параллельные ветки, повторы со списком в панели, паузы, 250 шагов, клавиатура, устойчивость раскладки, холст, ленивая загрузка, доступность.

const ROW_HIT = { position: { x: 8, y: 8 } };
const rows = (page: Page) => page.getByRole('list', { name: 'Найденные запросы' }).getByRole('listitem');
const scheme = (page: Page) => page.getByRole('group', { name: 'Схема запроса' });
const nodes = (page: Page) => scheme(page).locator('button[data-node]');
const pressed = (page: Page) => scheme(page).locator('button[data-node][aria-pressed=true]');
const details = (page: Page) => page.getByTestId('step-details');
const canvas = (page: Page) => page.getByTestId('flow-canvas');
const zoomOf = async (page: Page) => Number(await canvas(page).getAttribute('data-zoom'));
const viewTab = (page: Page, name: 'Схема' | 'Шкала времени' | 'Записи') =>
  page.getByRole('tab', { name: new RegExp(`^${name}`) });
const noPageScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** Ищет за 24 часа и открывает запрос: первый, с нужным статусом или с текстом в строке. */
async function openRequest(
  page: Page,
  term: string,
  pick: { status?: 'error' | 'success'; text?: string } = {},
) {
  await page.goto('/pay/demo');
  const input = page.getByRole('textbox', { name: 'Значения для поиска' });
  await input.fill(term);
  await input.press('Enter');
  await page
    .getByRole('group', { name: 'Период' })
    .getByRole('button', { name: '24 ч', exact: true })
    .click();
  await page.getByRole('button', { name: 'Найти', exact: true }).click();
  await expect(page.getByTestId('search-results')).toHaveAttribute('data-status', 'done', {
    timeout: 20_000,
  });
  let row = rows(page);
  if (pick.status) row = row.and(page.locator(`[data-status=${pick.status}]`));
  if (pick.text) row = row.filter({ hasText: pick.text });
  await row.first().locator('[data-row-link]').click(ROW_HIT);
  await expect(page.getByTestId('request-header')).toBeVisible();
  await expect(canvas(page)).toBeVisible({ timeout: 15_000 });
}

const openProcessorError = (page: Page) => openRequest(page, 'getCard', { status: 'error' });
const openParallel = (page: Page) => openRequest(page, 'v1/cards/limits');
const openRetries = (page: Page) => openRequest(page, 'retrying');
const openLong = (page: Page) => openRequest(page, 'cards/sync');

interface Rec {
  id: string;
  kind: string;
  timeMs: number;
  offsetMs: number | null;
  tsNs: string;
  title: string;
  isError: boolean;
  catalog?: unknown;
  http: { uri: string | null; status: number | null; durationMs: number | null; pairId: string | null; noResponse: boolean; pending: boolean } | null;
}
interface Detail {
  records: Rec[];
  summary: { firstMs: number; lastMs: number; reasons: unknown[] };
}

/** Запрос с нужными обменами: вход настоящий, обмены — копии настоящих записей с другими временем, адресом и статусом. */
async function withExchanges(page: Page, list: readonly { at: number; dur: number | null; uri: string; status?: number }[]) {
  await page.route('**/api/searches/*/requests/*', async (route) => {
    if (route.request().url().includes('/reveal')) return route.continue();
    const res = await route.fetch();
    const body = (await res.json()) as Detail;
    const entry = body.records.find((r) => r.kind === 'incoming')!;
    const send = body.records.find((r) => r.kind === 'send')!;
    const resp = body.records.find((r) => r.kind === 'response')!;
    const at = (r: Rec, id: string, t: number, over: Partial<Rec>): Rec => ({ ...r, id, timeMs: entry.timeMs + t, offsetMs: t, tsNs: String(BigInt(Math.round(entry.timeMs + t)) * 1_000_000n), catalog: undefined, ...over });
    const out: Rec[] = [{ ...entry, offsetMs: 0 }];
    list.forEach((e, i) => {
      const noResponse = e.dur === null;
      out.push(at(send, `s${i}`, e.at, { title: `POST ${e.uri}`, http: { ...send.http!, uri: e.uri, status: null, pairId: noResponse ? null : `r${i}`, durationMs: e.dur, noResponse, pending: false } }));
      if (!noResponse) {
        const status = e.status ?? 200;
        out.push(at(resp, `r${i}`, e.at + e.dur!, { title: `POST ${e.uri} → ${status}`, isError: status >= 400, http: { ...resp.http!, uri: e.uri, status, pairId: `s${i}`, durationMs: e.dur, noResponse: false, pending: false } }));
      }
    });
    out.sort((a, b) => a.timeMs - b.timeMs);
    body.records = out;
    body.summary = { ...body.summary, firstMs: entry.timeMs, lastMs: out.at(-1)!.timeMs };
    return route.fulfill({ response: res, json: body });
  });
  await openRequest(page, 'switch.pay.example');
}

const LEDGER = 'https://ledger.pay.example:8443/api/v1/registry';

/** Координаты раскладки и рамки всех узлов в системе холста. */
async function geometry(page: Page) {
  const box = (await canvas(page).boundingBox())!;
  return nodes(page).evaluateAll(
    (els, c) =>
      els.map((e) => {
        const r = e.getBoundingClientRect();
        return {
          id: e.getAttribute('data-node'),
          x: e.getAttribute('data-x'),
          y: e.getAttribute('data-y'),
          left: Math.round(r.left - c.x),
          top: Math.round(r.top - c.y),
          w: r.width,
          h: r.height,
        };
      }),
    box,
  );
}

/**
 * Положение узлов то же. Playwright перед нажатием прокручивает обрезанный холстом узел в видимую часть: `.react-flow` сдвигается
 * и сам возвращается на следующем кадре. Выбор тут ни при чём, поэтому положение сверяется после возврата.
 */
const samePlaces = (page: Page, before: Awaited<ReturnType<typeof geometry>>, message?: string) => expect.poll(() => geometry(page), { message }).toEqual(before);

/** Узел целиком внутри холста. */
async function insideCanvas(page: Page, id: string) {
  const c = (await canvas(page).boundingBox())!;
  const n = (await scheme(page).locator(`button[data-node="${id}"]`).boundingBox())!;
  return n.x >= c.x && n.y >= c.y && n.x + n.width <= c.x + c.width && n.y + n.height <= c.y + c.height;
}

/** Файлы, которые грузит FlowGraph.tsx и не грузит страница запроса сама, — по манифесту сборки. */
function flowFiles(): string[] {
  const manifest = JSON.parse(
    readFileSync(fileURLToPath(new URL('../dist-e2e/.vite/manifest.json', import.meta.url)), 'utf8'),
  ) as Record<string, { file: string; name?: string; imports?: string[]; css?: string[] }>;
  const closure = (key: string, seen = new Set<string>()) => {
    const c = manifest[key];
    if (!c || seen.has(c.file)) return seen;
    seen.add(c.file);
    for (const css of c.css ?? []) seen.add(css);
    for (const i of c.imports ?? []) closure(i, seen);
    return seen;
  };
  // Общие чанки, которые страница запроса грузит сама, не код графа.
  const requestPage = Object.keys(manifest).find((k) => manifest[k]!.name === 'RequestPage')!;
  const shared = closure(requestPage, closure('index.html'));
  return [...closure('src/features/flow/canvas/FlowGraph.tsx')].filter((f) => !shared.has(f));
}

test.describe('граф потока: узлы и рёбра', () => {
  test('ошибка процессинга: цепочка слева направо, узел с ошибкой красный, выбран и показывает причину', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openProcessorError(page);
    await expect(viewTab(page, 'Схема')).toHaveAttribute('aria-selected', 'true');
    await expect(nodes(page).first()).toHaveAttribute('data-kind', 'entry');
    await expect(nodes(page).first().getByTestId('node-method')).toContainText('POST /v1/cards/lookup');
    const error = scheme(page).locator('button[data-node][data-tone=error]');
    await expect(error).toHaveCount(1);
    await expect(error).toHaveAttribute('aria-pressed', 'true');
    await expect(error.getByTestId('node-outcome')).toContainText('Card not found');
    await expect(error.getByTestId('node-method')).toContainText('getCard');
    await expect(pressed(page)).toHaveCount(1);
    // Обмен с внешней системой помечен рядом с именем, путь к ошибке — красным ребром.
    await expect(error.getByTestId('node-external')).toHaveText('внешняя');
    await expect(scheme(page).locator('.threadline-edge-hot')).toHaveCount(1);
    // Слева направо: x узлов растёт, развилок нет.
    const g = await geometry(page);
    const xs = g.map((n) => Number(n.x));
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    expect(new Set(g.map((n) => n.y)).size).toBe(1);
    // Панель шага показывает выбранный обмен.
    await expect(details(page)).toContainText('Card not found');
    // Размер задан видом.
    expect(g[0]).toMatchObject({ w: 184, h: 104 });
    expect(g[1]).toMatchObject({ w: 232, h: 104 });
  });

  test('рамка проекта вокруг шагов, вход снаружи, полоска времени внутри дорожки', async ({ page }) => {
    await openProcessorError(page);
    const frame = (await page.getByTestId('flow-frame').boundingBox())!;
    const entry = (await nodes(page).first().boundingBox())!;
    expect(entry.x + entry.width).toBeLessThanOrEqual(frame.x);
    await expect(page.getByTestId('flow-frame-title')).toContainText('Demo Pay');
    for (const n of await nodes(page).all()) {
      const bar = n.getByTestId('node-time').locator('span');
      const [left, width] = await bar.evaluate((el) => [parseFloat(el.style.left), parseFloat(el.style.width)]);
      expect(left! + width!).toBeLessThanOrEqual(100.001);
    }
  });

  test('параллельные обмены: значок на рамке, ветки одна под другой, слияние перед следующим шагом', async ({
    page,
  }) => {
    await openParallel(page);
    const g = await geometry(page);
    expect(g).toHaveLength(4);
    const [entry, a, b, last] = g as [(typeof g)[0], (typeof g)[0], (typeof g)[0], (typeof g)[0]];
    expect(a.left).toBe(b.left);
    expect(a.top).toBeLessThan(b.top);
    expect(entry.left).toBeLessThan(a.left);
    expect(last.left).toBeGreaterThan(a.left + a.w);
    await expect(scheme(page).getByTestId('node-parallel')).toHaveCount(2);
    await expect(scheme(page).getByTestId('node-parallel').first()).toHaveText('2');
    // ↑/↓ переходят между ветками, вне развилки ничего не делают.
    await scheme(page).locator(`button[data-node="${a.id}"]`).click();
    await page.keyboard.press('ArrowDown');
    await expect(pressed(page)).toHaveAttribute('data-node', b.id!);
    await page.keyboard.press('ArrowUp');
    await expect(pressed(page)).toHaveAttribute('data-node', a.id!);
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowDown');
    await expect(pressed(page)).toHaveAttribute('data-node', entry.id!);
    // → на развилке — в первую ветку, из конца ветки — к узлу после слияния.
    await page.keyboard.press('ArrowRight');
    await expect(pressed(page)).toHaveAttribute('data-node', a.id!);
    await page.keyboard.press('ArrowRight');
    await expect(pressed(page)).toHaveAttribute('data-node', last.id!);
    await page.keyboard.press('ArrowLeft');
    await expect(pressed(page)).toHaveAttribute('data-node', a.id!);
  });

  test('повторы платёжного ядра: один узел 280 px, клик выбирает представителя, попытки списком в панели, граф не двигается', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openRetries(page);
    const group = scheme(page).locator('button[data-node][data-group=retry]');
    await expect(group).toHaveCount(1);
    await expect(group.getByTestId('node-method')).toHaveText('3 попытки · 2 неудачные');
    await expect(group.getByTestId('node-attempt')).toHaveCount(3);
    await expect(group.getByTestId('node-attempts')).toHaveAttribute('data-size', '6');
    await expect(group.getByTestId('node-attempt').last()).toHaveAttribute('data-tone', 'success');
    expect((await group.boundingBox())!.width).toBe(280);
    // Повтор на графе не раскрывается: шеврона нет.
    await expect(scheme(page).getByTestId('group-toggle')).toHaveCount(0);
    const before = await geometry(page);
    // Логи приложения — кнопкой-сводкой над холстом, WARNING — отметкой на значке узла.
    await expect(page.getByTestId('app-logs')).toContainText('Логи приложения · 2 записи · 2 WARNING');
    await page.getByTestId('app-logs').click();
    await expect(page.getByTestId('app-logs')).toHaveAttribute('aria-pressed', 'true');
    await expect(pressed(page)).toHaveCount(0);
    await expect(details(page)).toContainText('Логи приложения');
    // Клик по свёрнутой группе: выбрана первая неудачная попытка, панель показывает список.
    await group.click();
    await expect(group).toHaveAttribute('aria-pressed', 'true');
    await expect(group).toHaveAttribute('aria-label', /шаг 1 из 3/);
    await expect(group.getByTestId('node-attempt').first()).toHaveAttribute('data-current', 'true');
    const list = details(page).getByTestId('step-attempts');
    await expect(list.getByTestId('attempt-row')).toHaveCount(3);
    await expect(list.getByTestId('attempt-row').nth(0)).toHaveAttribute('aria-current', 'true');
    // У второй попытки пауза перед ней, у первой нет.
    await expect(list.getByTestId('attempt-pause').nth(0)).toHaveText('—');
    await expect(list.getByTestId('attempt-pause').nth(1)).not.toHaveText('—');
    // Строка списка и клетка полоски выбирают попытку, узел на месте, пробел не раскрывает.
    await list.getByTestId('attempt-row').nth(2).click();
    await expect(group.getByTestId('node-attempt').last()).toHaveAttribute('data-current', 'true');
    await expect(details(page).getByTestId('step-outcome')).toHaveAttribute('data-tone', 'success');
    await group.getByTestId('node-attempt').nth(1).click();
    await expect(list.getByTestId('attempt-row').nth(1)).toHaveAttribute('aria-current', 'true');
    await group.focus();
    await page.keyboard.press('Space');
    await expect(scheme(page).locator('button[data-frame=open]')).toHaveCount(0);
    await samePlaces(page, before);
  });

  test('шаг со шкалы внутри свёрнутой группы: группа и её клетка подсвечены, граф не сдвинулся', async ({
    page,
  }) => {
    await openRetries(page);
    const before = await geometry(page);
    await viewTab(page, 'Шкала времени').click();
    await page
      .getByRole('listbox', { name: 'Шаги трассы' })
      .getByRole('option')
      .filter({ hasText: 'payments/confirm' })
      .nth(1)
      .click();
    await viewTab(page, 'Схема').click();
    const group = scheme(page).locator('button[data-node][data-group=retry]');
    await expect(group).toHaveAttribute('aria-pressed', 'true');
    await expect(group.getByTestId('node-attempt').nth(1)).toHaveAttribute('data-current', 'true');
    await samePlaces(page, before);
  });

  test('99 попыток за 23 ч 59 м: узел того же размера, 24 клетки по 4 px и «…», заголовок и длительность видны, список свёрнут', async ({
    page,
  }) => {
    const every = (23 * 3_600_000 + 59 * 60_000) / 98;
    await withExchanges(page, Array.from({ length: 99 }, (_, i) => ({ at: i * every, dur: null, uri: LEDGER })));
    const group = scheme(page).locator('button[data-node][data-group=retry]');
    await expect(group.getByTestId('node-method')).toHaveText('99 попыток · все неудачные');
    await expect(group.getByTestId('node-attempt')).toHaveCount(24);
    await expect(group.getByTestId('node-attempts')).toHaveAttribute('data-size', '4');
    await expect(group.getByTestId('node-attempts-more')).toBeVisible();
    await expect(group.getByTestId('node-outcome')).toHaveText('ответ в логах не найден');
    const box = (await group.boundingBox())!;
    const zoom = await zoomOf(page);
    expect(box.width / zoom).toBeCloseTo(280, 0);
    expect(box.height / zoom).toBeCloseTo(104, 0);
    // Заголовок и длительность не обрезаны, полоска в узле.
    expect(await group.getByTestId('node-method').evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
    const strip = (await group.getByTestId('node-attempts').boundingBox())!;
    expect(strip.x + strip.width).toBeLessThanOrEqual(box.x + box.width);
    await group.click();
    const list = details(page).getByTestId('step-attempts');
    await expect(list.getByTestId('attempt-fold')).toContainText('96 попыток');
    await expect(list.getByTestId('attempt-row')).toHaveCount(3);
    await list.getByRole('button', { name: 'Показать 96' }).click();
    await expect(list.getByTestId('attempt-row')).toHaveCount(99);
    expect(await noPageScroll(page)).toBeLessThanOrEqual(0);
  });

  for (const width of [768, 1920]) {
    test(`20 параллельных, две упали: видно три ветки с упавшими и «Ещё 17 параллельных», ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await withExchanges(page, Array.from({ length: 20 }, (_, i) => ({ at: 10 + i, dur: 300 + i, uri: `https://card${i}.partner.example/api`, status: i === 4 || i === 11 ? 500 : 200 })));
      await expect(scheme(page).locator('button[data-node][data-kind=exchange]')).toHaveCount(3);
      await expect(scheme(page).locator('button[data-node][data-kind=exchange][data-tone=error]')).toHaveCount(2);
      const rest = scheme(page).locator('button[data-node][data-group=parallel]');
      await expect(rest.getByTestId('node-name')).toHaveText('Ещё 17 параллельных');
      await expect(rest.getByTestId('node-outcome')).toContainText('все успешно');
      await expect(scheme(page).getByTestId('node-parallel').first()).toHaveText('20');
      const before = await geometry(page);
      await rest.click();
      await expect(details(page).getByTestId('step-attempts')).toHaveAttribute('data-kind', 'parallel');
      await expect(details(page).getByTestId('attempt-row')).toHaveCount(17);
      await samePlaces(page, before);
      expect(await noPageScroll(page)).toBeLessThanOrEqual(0);
    });
  }

  test('паузы: короткая на ребре, от минуты — узел, через него идут рёбра, нулевая без подписи', async ({ page }) => {
    await withExchanges(page, [
      { at: 3, dur: 100, uri: 'https://a.partner.example/x' },
      { at: 103, dur: 100, uri: 'https://b.partner.example/x' },
      { at: 214, dur: 100, uri: 'https://c.partner.example/x' },
      { at: 214 + 100 + 1_215_000, dur: 100, uri: 'https://d.partner.example/x' },
    ]);
    const labels = await scheme(page).getByTestId('edge-label').allInnerTexts();
    expect(labels).toEqual(['+3 мс', '+11 мс']);
    for (const l of labels) expect(l.length).toBeLessThanOrEqual(7);
    const pause = scheme(page).getByTestId('node-pause');
    await expect(pause).toHaveCount(1);
    await expect(pause).toContainText('Пауза');
    expect((await pause.boundingBox())!.width / (await zoomOf(page))).toBeLessThanOrEqual(140.5);
    // Узел паузы не шаг: клавиатура идёт сквозь него.
    const g = await geometry(page);
    await scheme(page).locator(`button[data-node="${g[3]!.id}"]`).click();
    await page.keyboard.press('ArrowRight');
    await expect(pressed(page)).toHaveAttribute('data-node', g[4]!.id!);
  });

  test('шаг без ответа: штриховка, прочерк вместо длительности, размер тот же', async ({ page }) => {
    await openRequest(page, 'fraud.pay.example');
    const node = scheme(page).locator('button[data-node][data-kind=exchange]');
    await expect(node.getByTestId('node-duration')).toHaveText('—');
    expect(await node.evaluate((el) => el.style.backgroundImage)).toContain('repeating-linear-gradient');
    expect(await node.getByTestId('node-time').locator('span').evaluate((el) => el.style.backgroundImage)).toContain('repeating-linear-gradient');
    expect((await node.boundingBox())!.height).toBe(104);
  });

  test('250 шагов: не больше 60 узлов, ошибки и их соседи видны, длинные участки в «ещё N шагов»', async ({
    page,
  }) => {
    await openLong(page);
    const count = await nodes(page).count();
    expect(count).toBeLessThanOrEqual(60);
    expect(count).toBeGreaterThan(10);
    await expect(scheme(page).locator('button[data-node][data-group=more]').first()).toBeAttached();
    await expect(pressed(page)).toHaveAttribute('data-tone', 'error');
    // Страница по горизонтали не прокручивается, лишнее двигается панорамой.
    expect(await noPageScroll(page)).toBeLessThanOrEqual(0);
    // End — последний узел, Enter — к подробностям.
    await pressed(page).focus();
    await page.keyboard.press('End');
    await expect(pressed(page)).toHaveAttribute('data-node', (await nodes(page).last().getAttribute('data-node'))!);
    await page.keyboard.press('Enter');
    await expect(details(page)).toBeFocused();
  });

  test('группа бюджета раскрывается рамкой пробелом; фокус на ней, второй пробел сворачивает', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1000 });
    await openLong(page);
    const toggle = scheme(page).getByTestId('group-toggle').first();
    const group = toggle.locator('xpath=ancestor::div[1]').locator('button[data-node]');
    const id = (await group.getAttribute('data-node'))!;
    await group.focus();
    await page.keyboard.press('Space');
    const frame = scheme(page).locator(`button[data-node="${id}"][data-frame=open]`);
    await expect(frame).toBeFocused();
    await page.keyboard.press('Space');
    await expect(scheme(page).locator(`button[data-node="${id}"]:not([data-frame])`)).toBeFocused();
  });
});

test.describe('граф потока: устойчивость', () => {
  for (const width of [768, 1440, 1920, 2560]) {
    test(`выбор не сдвигает граф, ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 });
      await openParallel(page);
      const before = await geometry(page);
      for (const id of before.map((g) => g.id!)) {
        await scheme(page).locator(`button[data-node="${id}"]`).click();
        await samePlaces(page, before, `выбран ${id}`);
      }
    });
  }

  test('окно 1440 → 1280: координаты узлов на холсте те же, меняется масштаб', async ({ page }) => {
    // Панель шага пошире обычной (640): на 1280 она упирается в половину окна, холст сужается и граф уменьшается.
    await page.addInitScript(() => localStorage.setItem('threadline.stepPanel', JSON.stringify({ width: 640, collapsed: false })));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openParallel(page);
    const coords = async () => (await geometry(page)).map((g) => [g.id, g.x, g.y]);
    const before = await coords();
    await page.setViewportSize({ width: 1280, height: 1000 });
    await expect.poll(() => zoomOf(page)).toBeLessThan(1);
    expect(await coords()).toEqual(before);
  });

  for (const width of [768, 1440]) {
    test(`имена узлов не обрезаны, ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 });
      await openParallel(page);
      const cut = await scheme(page)
        .getByTestId('node-name')
        .evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth || e.scrollHeight > e.clientHeight).map((e) => e.textContent));
      expect(cut).toEqual([]);
    });
  }

  test('смена режима не двигает узлы: размер и место те же', async ({ page }) => {
    await openRetries(page);
    const before = await geometry(page);
    // Режим — в меню профиля: узлы сверяются после его закрытия.
    await setViewMode(page, 'Кратко');
    expect(await geometry(page)).toEqual(before);
  });
});

test.describe('граф потока: холст', () => {
  test('короткий поток на 1440×785: 100 %, граф по центру холста', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 785 });
    await openProcessorError(page);
    expect(await zoomOf(page)).toBe(1);
    await expect(page.getByTestId('flow-zoom-value')).toHaveText(/100\s?%/);
    const c = (await canvas(page).boundingBox())!;
    const frame = (await page.getByTestId('flow-frame').boundingBox())!;
    const first = (await nodes(page).first().boundingBox())!;
    const left = first.x - c.x;
    const right = c.x + c.width - (frame.x + frame.width);
    expect(Math.abs(left - right)).toBeLessThanOrEqual(34);
  });

  test('широкий экран 2560: 100 %, не больше, панель шага 400', async ({ page }) => {
    await page.setViewportSize({ width: 2560, height: 1000 });
    await openProcessorError(page);
    expect(await zoomOf(page)).toBe(1);
    expect((await details(page).boundingBox())!.width).toBe(400);
  });

  for (const width of [1280, 1440, 1920]) {
    test(`панель шага 400 px справа, ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await openProcessorError(page);
      const d = (await details(page).boundingBox())!;
      const s = (await scheme(page).boundingBox())!;
      expect(d.width).toBe(400);
      expect(s.x + s.width).toBeLessThanOrEqual(d.x);
      expect(d.x + d.width).toBe(width);
    });
  }

  test('длинный поток на 1280: 75 %, выбранный узел виден, подпись называет шаги правее', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await withExchanges(page, Array.from({ length: 39 }, (_, i) => ({ at: 10 + i * 100, dur: 20, uri: `https://s${i}.partner.example/x`, status: i === 20 ? 500 : 200 })));
    expect(await zoomOf(page)).toBe(0.75);
    const id = (await pressed(page).getAttribute('data-node'))!;
    await expect(pressed(page)).toHaveAttribute('data-tone', 'error');
    expect(await insideCanvas(page, id)).toBe(true);
    await expect(page.getByTestId('flow-more-right')).toContainText(/ещё \d+ шаг\S* правее/);
    expect(await noPageScroll(page)).toBeLessThanOrEqual(0);
  });

  test('«Вписать» и кнопки: 0,5–1,5, снова по правилу открытия, выбранный узел виден; это отдельные остановки Tab', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 785 });
    await openProcessorError(page);
    const plus = page.getByTestId('flow-zoom-in');
    const minus = page.getByTestId('flow-zoom-out');
    await plus.click();
    await expect.poll(() => zoomOf(page)).toBeCloseTo(1.1);
    for (let i = 0; i < 6; i++) if (await plus.isEnabled()) await plus.click();
    await expect.poll(() => zoomOf(page)).toBe(1.5);
    await expect(plus).toBeDisabled();
    for (let i = 0; i < 12; i++) if (await minus.isEnabled()) await minus.click();
    await expect.poll(() => zoomOf(page)).toBe(0.5);
    await expect(minus).toBeDisabled();
    await page.getByTestId('flow-zoom-fit').click();
    await expect.poll(() => zoomOf(page)).toBe(1);
    expect(await insideCanvas(page, (await pressed(page).getAttribute('data-node'))!)).toBe(true);
    // Остановка узла, затем кнопки масштаба.
    await pressed(page).focus();
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('flow-zoom-fit')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(minus).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(plus).toBeFocused();
  });

  test('Ctrl и ⌘ с колесом масштабируют; колесо без них и двойной клик — нет, страница прокручивается дальше', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 700 });
    await openRetries(page);
    const box = (await canvas(page).boundingBox())!;
    const point = { x: box.x + 12, y: box.y + 12 };
    await page.mouse.move(point.x, point.y);
    const start = await zoomOf(page);
    await page.mouse.dblclick(point.x, point.y);
    expect(await zoomOf(page)).toBe(start);
    await page.mouse.wheel(0, 120);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    expect(await zoomOf(page)).toBe(start);
    await page.evaluate(() => window.scrollTo(0, 0));
    const again = (await canvas(page).boundingBox())!;
    await page.mouse.move(again.x + 12, again.y + 12);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -200);
    await page.keyboard.up('Control');
    await expect.poll(() => zoomOf(page)).toBeGreaterThan(start);
    const zoomed = await zoomOf(page);
    await page.keyboard.down('Meta');
    await page.mouse.wheel(0, 200);
    await page.keyboard.up('Meta');
    await expect.poll(() => zoomOf(page)).toBeLessThan(zoomed);
  });

  test('панорама: перетаскивание фона двигает граф, размер узлов и координаты на холсте те же', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1000 });
    await withExchanges(page, Array.from({ length: 8 }, (_, i) => ({ at: 10 + i * 100, dur: 20, uri: `https://s${i}.partner.example/x` })));
    const before = await geometry(page);
    const box = (await canvas(page).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 6);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 200, box.y + 6, { steps: 4 });
    await page.mouse.up();
    await expect.poll(async () => (await geometry(page))[3]!.left).toBeLessThan(before[3]!.left);
    const after = await geometry(page);
    expect(after.map((g) => [g.x, g.y, g.w, g.h])).toEqual(before.map((g) => [g.x, g.y, g.w, g.h]));
    expect(await noPageScroll(page)).toBeLessThanOrEqual(0);
  });

  test('стрелка за край холста: сдвиг до узла, масштаб не меняется; выбор на шкале — узел виден на «Схеме»', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await withExchanges(page, Array.from({ length: 14 }, (_, i) => ({ at: 10 + i * 100, dur: 20, uri: `https://s${i}.partner.example/x` })));
    const zoom = await zoomOf(page);
    await nodes(page).first().focus();
    await page.keyboard.press('End');
    const lastId = (await pressed(page).getAttribute('data-node'))!;
    await expect.poll(() => insideCanvas(page, lastId)).toBe(true);
    expect(await zoomOf(page)).toBe(zoom);
    await viewTab(page, 'Шкала времени').click();
    await page.getByRole('listbox', { name: 'Шаги трассы' }).getByRole('option').nth(7).click();
    await viewTab(page, 'Схема').click();
    await expect(canvas(page)).toBeVisible();
    const id = (await pressed(page).getAttribute('data-node'))!;
    await expect.poll(() => insideCanvas(page, id)).toBe(true);
  });

  test('компактный режим 1024: холст на всю ширину, не выше 60 % окна, панель шага на первом экране', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await openLong(page);
    const c = (await canvas(page).boundingBox())!;
    const d = (await details(page).boundingBox())!;
    expect(c.height).toBeLessThanOrEqual(768 * 0.6 + 1);
    expect(d.y).toBeGreaterThanOrEqual(c.y + c.height);
    expect(d.y).toBeLessThan(768);
    expect(d.width).toBeGreaterThan(900);
  });

  test('768: слева направо, страница не прокручивается вбок, широкая развилка внутри холста', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1000 });
    await openParallel(page);
    const g = await geometry(page);
    expect(Number(g[1]!.x)).toBeGreaterThan(Number(g[0]!.x));
    expect(g[1]!.x).toBe(g[2]!.x);
    expect(Number(g[2]!.y)).toBeGreaterThan(Number(g[1]!.y));
    expect(await noPageScroll(page)).toBeLessThanOrEqual(0);
  });
});

test.describe('граф потока: ленивая загрузка', () => {
  test('страница поиска не запрашивает файлов графа, страница запроса — запрашивает', async ({ page }) => {
    const files = flowFiles();
    expect(files.length).toBeGreaterThan(0);
    const asked: string[] = [];
    page.on('request', (r) => asked.push(new URL(r.url()).pathname.replace(/^\//, '')));
    await page.goto('/pay/demo');
    await expect(page.getByRole('textbox', { name: 'Значения для поиска' })).toBeVisible();
    expect(asked.filter((u) => files.includes(u))).toEqual([]);
    await openParallel(page);
    expect(asked.filter((u) => files.includes(u)).length).toBeGreaterThan(0);
  });

  test('сеть оборвалась: «Схему не удалось загрузить», «Шкала времени» работает, «Повторить» загружает заново', async ({
    page,
  }) => {
    const files = flowFiles();
    const block = (url: URL) => files.some((f) => url.pathname.endsWith(f));
    await page.route(block, (r) => r.abort());
    await openRequest(page, 'getCard', { status: 'error' }).catch(() => undefined);
    await expect(page.getByText('Схему не удалось загрузить')).toBeVisible({ timeout: 15_000 });
    // Остальная страница работает: панель шага на месте.
    await expect(details(page)).toBeVisible();
    await page.getByRole('button', { name: 'Шкала времени' }).click();
    await expect(viewTab(page, 'Шкала времени')).toHaveAttribute('aria-selected', 'true');
    await viewTab(page, 'Схема').click();
    // Возврат на вкладку заново грузит граф: блокировка снимается после отказа, иначе граф загрузился бы сам.
    await expect(page.getByText('Схему не удалось загрузить')).toBeVisible({ timeout: 15_000 });
    await page.unroute(block);
    await page.getByRole('button', { name: 'Повторить' }).click();
    await expect(canvas(page)).toBeVisible({ timeout: 15_000 });
    await expect(nodes(page).first()).toBeVisible();
  });
});

test.describe('граф потока: «Кратко»', () => {
  // На странице запроса режим — в меню профиля.
  const switchTo = (page: Page, name: 'Подробно' | 'Кратко') => setViewMode(page, name);
  const coords = (page: Page) =>
    nodes(page).evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        return [el.getAttribute('data-node'), Math.round(r.x), Math.round(r.y), r.width, r.height];
      }),
    );

  test('координаты узлов равны в обоих режимах, числа попыток нет ни текстом, ни клетками', async ({ page }) => {
    await openRetries(page);
    const before = await coords(page);
    const group = scheme(page).locator('button[data-node][data-group=retry]').first();
    await expect(group).toContainText('3 попытки');
    await switchTo(page, 'Кратко');
    expect(await coords(page)).toEqual(before);
    await expect(group).not.toContainText('попыт');
    await expect(group.getByTestId('node-attempt')).toHaveCount(0);
    expect(await group.getAttribute('title')).not.toContain('попыт');
  });

  test('значков логов нет, размеры прежние; вверху вид шага, без метода и хоста', async ({ page }) => {
    await openProcessorError(page);
    const before = await coords(page);
    await switchTo(page, 'Кратко');
    await expect(scheme(page).getByTestId('node-badge')).toHaveCount(0);
    expect(await coords(page)).toEqual(before);
    await expect(nodes(page).first().getByTestId('node-method')).not.toContainText('POST');
    await expect(nodes(page).first().getByTestId('node-method')).toContainText('Вход');
    const error = scheme(page).locator('button[data-node][data-tone=error]');
    await expect(error.getByTestId('node-outcome')).toHaveText('Card not found');
    expect((await error.getAttribute('aria-label')) ?? '').not.toContain('pay.example');
  });
});

test.describe('граф потока: доступность', () => {
  for (const colorScheme of ['light', 'dark'] as const) {
    test(`axe на схеме, списке попыток и раскрытой группе, ${colorScheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme });
      await openRetries(page);
      const check = async (where: string) => {
        const r = await new AxeBuilder({ page })
          .include('[data-testid=trace-scheme]')
          .include('[data-testid=step-details]')
          .withTags(['wcag2a', 'wcag2aa'])
          .analyze();
        expect(
          r.violations.map((v) => `${where}: ${v.id} ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
        ).toEqual([]);
      };
      await check('свёрнуто');
      await scheme(page).locator('button[data-node][data-group=retry]').click();
      await check('список попыток');
      await openLong(page);
      await scheme(page).getByTestId('group-toggle').first().click();
      await expect(scheme(page).locator('button[data-frame=open]').first()).toBeAttached();
      await check('раскрыто');
    });
  }

  test('подпись узла называет номер, имя, итог и длительность; одна остановка Tab', async ({ page }) => {
    await openProcessorError(page);
    const error = scheme(page).locator('button[data-node][data-tone=error]');
    await expect(error).toHaveAttribute('aria-label', /^.+Card not found.*Шаг с ошибкой.*\d+ мс.*Шаг \d+ из \d+$/);
    expect(
      await nodes(page).evaluateAll((els) => els.filter((e) => e.getAttribute('tabindex') === '0').length),
    ).toBe(1);
  });
});
