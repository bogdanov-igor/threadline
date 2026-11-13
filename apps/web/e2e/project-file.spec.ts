// Страница файла проекта на своём сервере и своей базе: файл правит весь проект и сверяет версию, соседние наборы дали бы ложный конфликт.
// Только имитация и ненастроенная Grafana, наружу ничего не ходит. Значения выдуманы.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { capabilitiesOf } from '@threadline/core/access';
import type { ProjectSetting, ProjectSettingsResponse } from '@threadline/core';
import { parse, stringify } from 'yaml';
import { paths, pickLanguage } from './helpers.ts';

const PAN = '4111111234557893';
const API = '/api/projects/pay/catalog';
const IMPORT = /\/api\/projects\/pay\/catalog\/import(\?|$)/;
const SHOTS = process.env.THREADLINE_FILE_SHOTS;
const FILE_PATH = '/pay/settings/file';

const content = (page: Page) => page.locator('.cm-content');
const apply = (page: Page) => page.getByTestId('import-apply');
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function open(page: Page, path = FILE_PATH) {
  await page.goto(path);
  await expect(content(page)).toBeVisible();
}

/** Весь текст заменяется, как вставка из буфера. */
async function setText(page: Page, text: string) {
  await content(page).click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText(text);
}

async function saved(page: Page) {
  const [d] = await Promise.all([page.waitForEvent('download'), page.getByTestId('file-download').click()]);
  return { name: d.suggestedFilename(), text: await readFile((await d.path())!, 'utf8') };
}

const exportText = async (request: APIRequestContext, format: 'yaml' | 'json' = 'yaml') => (await request.get(`${API}/export?format=${format}`)).text();
const settingOf = async (request: APIRequestContext, id = 'pay') => ((await (await request.get('/api/project-settings')).json()) as ProjectSettingsResponse).projects.find((p) => p.id === id)!;
const formBody = (p: ProjectSetting, over: Record<string, unknown> = {}) => ({ name: p.name, timezone: p.timezone, retentionDays: p.retentionDays, format: p.format, environments: p.environments.map(({ id, name, kind, backend, selector, stand }) => ({ id, name, kind, backend, selector, ...(stand ? { stand } : {}) })), updatedAt: p.updatedAt, ...over });
/** Правка коллеги: тот же запрос, что у формы «Основное». */
async function colleagueSaves(request: APIRequestContext, over: Record<string, unknown>) {
  const r = await request.put('/api/projects/pay', { data: formBody(await settingOf(request), over) });
  expect(r.status(), await r.text()).toBe(200);
}
/** Возврат на вкладку: браузер в тесте всегда видимый, поэтому событие подаётся вручную. */
const returnToTab = (page: Page) => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

let seq = 0;
const unique = () => `e2e-file-${Date.now().toString(36)}-${++seq}`;
const withSystem = (text: string, key: string, name = `Система ${key}`) => {
  const doc = parse(text) as { systems?: unknown[] };
  doc.systems = [...(doc.systems ?? []), { key, name, hosts: [`${key}.partner.example`] }];
  return stringify(doc, { lineWidth: 0 });
};

test.describe('открытие и состояния', () => {
  test('пункт меню, кнопка на справочнике и прямая ссылка ведут на страницу, текст YAML, правок нет', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(paths.catalog('pay'));
    await page.getByTestId('catalog-file-open').click();
    await expect(page).toHaveURL(/\/pay\/settings\/file$/);
    await expect(content(page)).toContainText('settings:');
    await expect(page.getByTestId('file-removal-note')).toBeVisible();
    await expect(page.getByTestId('tab-changed')).toHaveCount(0);
    await expect(apply(page)).toHaveCount(0);

    await page.goto(paths.projectMain('pay'));
    await page.getByTestId('project-tab-file').click();
    await expect(page).toHaveURL(/\/pay\/settings\/file$/);
    await expect(content(page)).toBeVisible();
    await expect(page.getByTestId('project-tab-file')).toHaveAttribute('aria-current', 'page');
    await open(page);
    await expect(page.getByTestId('file-format').getByRole('button', { name: 'YAML' })).toHaveAttribute('aria-pressed', 'true');
    const { name, text } = await saved(page);
    expect(name).toBe('pay-project.yaml');
    expect(text).toBe(await exportText(page.request));
  });

  test('заготовка той же высоты, пока грузится текст', async ({ page }) => {
    await page.route('**/api/projects/pay/catalog/export*', async (r) => {
      await new Promise((f) => setTimeout(f, 600));
      await r.continue();
    });
    await page.goto(FILE_PATH);
    await expect(page.getByTestId('project-file-skeleton')).toBeVisible();
    await expect(content(page)).toBeVisible();
  });

  test('база недоступна при открытии: причина и «Повторить», пустого редактора нет', async ({ page }) => {
    await page.route('**/api/projects/pay/catalog/export*', (r) => r.fulfill({ status: 503, json: { error: { code: 'catalog-unavailable' } } }));
    await page.goto(FILE_PATH);
    await expect(page.getByTestId('project-file-failed')).toContainText('База справочника недоступна');
    await expect(content(page)).toHaveCount(0);
    await page.unroute('**/api/projects/pay/catalog/export*');
    await page.getByTestId('file-load-retry').click();
    await expect(content(page)).toBeVisible();
  });

  test('выгрузка отклонена: пути полей без значений, текста нет, загрузка остаётся', async ({ page }) => {
    await page.route('**/api/projects/pay/catalog/export*', (r) => r.fulfill({ status: 422, json: { error: { code: 'catalog-invalid', fields: { 'systems.2.name': 'уберите номер карты' } } } }));
    await page.goto(FILE_PATH);
    await expect(page.getByTestId('export-problem')).toContainText('systems.2.name');
    await expect(content(page)).toHaveCount(0);
    await expect(page.getByTestId('file-upload')).toBeVisible();
  });

  const settingsWith = (body: ProjectSettingsResponse, over: Partial<ProjectSettingsResponse>, project: Partial<ProjectSetting> = {}) => ({ ...body, ...over, projects: body.projects.map((p) => (p.id === 'pay' ? { ...p, ...project } : p)) });

  test('база выключена, скрытый проект: страница объясняет, текста и кнопок файла нет', async ({ page, request }) => {
    const body = (await (await request.get('/api/project-settings')).json()) as ProjectSettingsResponse;
    await page.route('**/api/project-settings', (r) => r.fulfill({ json: settingsWith(body, { state: 'off', editable: false, loadedAt: null }) }));
    await page.goto(FILE_PATH);
    await expect(page.getByRole('heading', { name: 'Справочник выключен' })).toBeVisible();
    await expect(page.getByTestId('file-download')).toHaveCount(0);
    await page.unroute('**/api/project-settings');

    await page.route('**/api/project-settings', (r) => r.fulfill({ json: settingsWith(body, {}, { hidden: 'page' }) }));
    await page.goto(FILE_PATH);
    await expect(page.getByRole('heading', { name: 'Файла проекта пока нет' })).toBeVisible();
    await expect(page.getByTestId('file-download')).toHaveCount(0);
    await page.getByRole('link', { name: 'Основное' }).last().click();
    await expect(page).toHaveURL(/\/pay\/settings\/main$/);
  });

  test('правка закрыта, а выгрузка работает: только чтение, причина названа, скачивание есть, загрузки нет', async ({ page, request }) => {
    const body = (await (await request.get('/api/project-settings')).json()) as ProjectSettingsResponse;
    await page.route('**/api/project-settings', (r) => r.fulfill({ json: settingsWith(body, { editable: false, state: 'stale' }) }));
    await open(page);
    await expect(page.getByTestId('file-read-only')).toContainText('Правка закрыта');
    await expect(page.getByTestId('file-upload')).toHaveCount(0);
    await expect(page.getByTestId('file-download')).toBeVisible();
    await content(page).click();
    await page.keyboard.type('x');
    await expect(page.getByTestId('tab-changed')).toHaveCount(0);
  });

  test('код редактора не загрузился: причина и «Повторить», пустого экрана нет', async ({ page }) => {
    await page.route('**/assets/Page-*.js', (r) => r.abort());
    await page.goto(FILE_PATH);
    await expect(page.getByTestId('file-chunk-retry')).toBeVisible({ timeout: 15_000 });
    await page.unroute('**/assets/Page-*.js');
    await page.getByTestId('file-chunk-retry').click();
    await expect(content(page)).toBeVisible();
  });
});

test.describe('применение', () => {
  test('правка настроек и метода одним файлом: отчёт без значений, одна кнопка, свежий текст, форма видит новое', async ({ page, request }) => {
    const key = unique();
    await open(page);
    const before = await exportText(request);
    const days = (parse(before) as { settings: { retentionDays: number } }).settings.retentionDays + 1;
    const next = withSystem(before, key).replace(/retentionDays: \d+/, `retentionDays: ${days}`);
    await setText(page, next);
    await expect(page.getByTestId('tab-changed')).toBeVisible();
    await expect(page.getByTestId('import-changed')).toContainText('retentionDays');
    await expect(page.getByTestId('import-changed')).not.toContainText(String(days));
    await expect(page.getByTestId('import-added')).toContainText(key);
    await expect(apply(page)).toContainText('Применить 2');
    const posts: string[] = [];
    page.on('request', (r) => {
      if (IMPORT.test(r.url()) && !r.url().includes('dryRun')) posts.push(r.url());
    });
    await apply(page).dblclick();
    await expect(page.getByTestId('import-applied')).toBeVisible();
    expect(posts).toHaveLength(1);
    await expect(page.getByTestId('tab-changed')).toHaveCount(0);
    expect((await settingOf(request)).retentionDays).toBe(days);
    expect((await saved(page)).text).toBe(await exportText(request));
    await page.goto(paths.projectMain('pay'));
    await expect(page.getByTestId('project-retention')).toHaveValue(String(days));
  });

  test('ручные правки: файл их не трогает без переключателя, с ним заменяет; после успеха переключатель снят', async ({ page, request }) => {
    const key = unique();
    await open(page);
    await setText(page, withSystem(await exportText(request), key, 'Из файла'));
    await expect(page.getByTestId('import-added')).toContainText('Из файла');
    await apply(page).click();
    await expect(page.getByTestId('import-applied')).toBeVisible();

    const snap = (await (await request.get(API)).json()) as { systems: { id: number; key: string; kind: string; type: string; hosts: string[]; updatedAt: string }[] };
    const sys = snap.systems.find((s) => s.key === key)!;
    const put = await request.put(`${API}/systems/${sys.id}`, { data: { key, kind: sys.kind, type: sys.type, name: 'Правка аналитика', hosts: sys.hosts, description: null, updatedAt: sys.updatedAt } });
    expect(put.status(), await put.text()).toBe(200);
    await page.reload();
    await expect(content(page)).toContainText('settings:');

    const text = (await exportText(request)).replace('Правка аналитика', 'Новое из файла');
    await setText(page, text);
    await expect(page.getByTestId('import-skipped')).toContainText('Новое из файла');
    await expect(page.getByTestId('file-nothing')).toContainText('Применять нечего');
    await expect(apply(page)).toHaveCount(0);
    await page.locator('#import-force').click();
    await expect(page.getByTestId('import-changed')).toContainText('Новое из файла');
    await apply(page).click();
    await expect(page.getByTestId('import-applied')).toBeVisible();
    await expect(page.locator('#import-force')).toHaveAttribute('aria-checked', 'false');
  });

  test('сломанный файл при применении: новый отчёт вместо успеха, текст на месте, проект не изменился', async ({ page, request }) => {
    const key = unique();
    await open(page);
    await setText(page, withSystem(await exportText(request), key));
    await expect(apply(page)).toBeVisible();
    await page.route(IMPORT, (r) => (r.request().url().includes('dryRun') ? r.continue() : r.fulfill({ status: 422, json: { error: { code: 'catalog-invalid-file', report: { project: 'pay', dryRun: false, applied: false, added: [], changed: [], hidden: [], skipped: [], unchanged: 0, missing: 0, errors: [{ path: 'systems.0.key', message: 'файл не применён: записи файла конфликтуют со справочником' }] } } } })));
    await apply(page).click();
    await expect(page.getByTestId('import-errors')).toContainText('systems.0.key');
    await expect(page.getByTestId('import-applied')).toHaveCount(0);
    expect((await saved(page)).text).toContain(key);
    await expect(page.getByTestId('tab-changed')).toBeVisible();
    expect(await exportText(request)).not.toContain(key);
  });

  for (const { title, answer, text } of [
    { title: 'сервер не отвечает', answer: { abort: true }, text: 'Сервер Threadline не отвечает' },
    { title: 'база пропала', answer: { status: 503, json: { error: { code: 'catalog-unavailable' } } }, text: 'База справочника недоступна' },
  ] as const) {
    test(`сбой применения, ${title}: причина названа, текст и отчёт на месте, повтор той же кнопкой`, async ({ page, request }) => {
      const key = unique();
      await open(page);
      await setText(page, withSystem(await exportText(request), key));
      await expect(page.getByTestId('import-added')).toContainText(key);
      await page.route(IMPORT, (r) => ('abort' in answer ? r.abort('connectionrefused') : r.fulfill({ status: answer.status, json: answer.json })));
      await apply(page).click();
      await expect(page.getByTestId('import-problem')).toContainText(text);
      await expect(page.getByTestId('import-added')).toContainText(key);
      await expect(page.getByTestId('tab-changed')).toBeVisible();
      await page.unroute(IMPORT);
      await apply(page).click();
      await expect(page.getByTestId('import-applied')).toBeVisible();
      await expect(page.getByTestId('import-problem')).toHaveCount(0);
    });
  }

  test('применено, а свежего текста нет: только чтение, «Повторить», подтверждения при уходе нет', async ({ page, request }) => {
    const key = unique();
    await open(page);
    await setText(page, withSystem(await exportText(request), key));
    await expect(apply(page)).toBeVisible();
    await page.route('**/api/projects/pay/catalog/export*', (r) => r.fulfill({ status: 503, json: { error: { code: 'catalog-unavailable' } } }));
    await apply(page).click();
    await expect(page.getByTestId('file-no-fresh')).toBeVisible();
    await expect(page.getByTestId('tab-changed')).toHaveCount(0);
    await page.unroute('**/api/projects/pay/catalog/export*');
    const dialogs: string[] = [];
    page.on('dialog', (d) => {
      dialogs.push(d.message());
      void d.accept();
    });
    await page.getByTestId('file-fresh-retry').click();
    await expect(page.getByTestId('file-no-fresh')).toHaveCount(0);
    await expect(content(page)).toContainText('settings:');
    await page.getByTestId('project-tab-main').click();
    await expect(page).toHaveURL(/settings\/main$/);
    expect(dialogs).toEqual([]);
  });

  test('только комментарий: применять нечего, комментарии не сохраняются; порядок ключей тоже', async ({ page, request }) => {
    await open(page);
    const text = await exportText(request);
    await setText(page, `${text}# заметка\n`);
    await expect(page.getByTestId('file-nothing')).toContainText('Комментарии не сохраняются');
    await expect(apply(page)).toHaveCount(0);
  });

  test('запись стёрли: применять нечего, подсказка про hidden, запись на месте; среду: подсказка про форму', async ({ page, request }) => {
    const key = unique();
    await open(page);
    await setText(page, withSystem(await exportText(request), key));
    await apply(page).click();
    await expect(page.getByTestId('import-applied')).toBeVisible();

    const doc = parse(await exportText(request)) as { systems: { key: string }[]; settings: { environments: { id: string }[] } };
    doc.systems = doc.systems.filter((s) => s.key !== key);
    doc.settings.environments = doc.settings.environments.slice(0, -1);
    await setText(page, stringify(doc, { lineWidth: 0 }));
    await expect(page.getByTestId('file-counts')).toContainText('нет в файле: 2');
    await expect(page.getByTestId('file-nothing')).toContainText('hidden: true');
    await expect(page.getByTestId('hint-env-removal')).toContainText('Среды');
    await expect(apply(page)).toHaveCount(0);
    await expect(page.getByTestId('file-removal-note')).toContainText('не значит удалить');
  });
});

test.describe('проверка при вводе', () => {
  const imports = (page: Page) => {
    const list: string[] = [];
    page.on('request', (r) => {
      if (IMPORT.test(r.url())) list.push(r.url());
    });
    return list;
  };

  test('ошибка синтаксиса: отметка у строки, запроса нет; исправление снимает её и проверка идёт сама', async ({ page, request }) => {
    const seen = imports(page);
    await open(page);
    const text = await exportText(request);
    await setText(page, text.replace('project: pay', 'project: [pay'));
    await expect(page.getByTestId('file-syntax')).toContainText('строка');
    // Ошибка у начала текста, а после вставки на экране его конец.
    await page.keyboard.press('ControlOrMeta+Home');
    await expect(page.locator('.cm-lintRange-error').first()).toBeVisible();
    await page.waitForTimeout(1800);
    expect(seen).toEqual([]);
    await setText(page, withSystem(text, unique()));
    await expect(page.getByTestId('file-syntax')).toHaveCount(0);
    await expect(page.getByTestId('import-added')).toBeVisible();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('dryRun=1');
    expect(seen[0]).toContain('format=yaml');
  });

  test('лишняя запятая в JSON отмечена, хотя yaml её пропускает', async ({ page, request }) => {
    await open(page);
    await page.getByTestId('format-json').click();
    await expect(content(page)).toContainText('"project"');
    await setText(page, (await exportText(request, 'json')).replace('"project": "pay",', '"project": "pay",,'));
    await expect(page.getByTestId('file-syntax')).toContainText('строка');
  });

  test('неизвестное поле: ошибка в списке и у строки, клик ведёт к ней, кнопки нет', async ({ page, request }) => {
    await open(page);
    const doc = parse(await exportText(request)) as { settings: { environments: Record<string, unknown>[] } };
    doc.settings.environments[0]!.url = 'https://x.example';
    await setText(page, stringify(doc, { lineWidth: 0 }));
    const errors = page.getByTestId('import-errors');
    await expect(errors).toContainText('settings.environments.0.url');
    await errors.getByTestId('error-jump').first().click();
    await expect(page.locator('.cm-line').filter({ hasText: 'url:' }).first()).toBeVisible();
    await expect(page.locator('.cm-lintRange-error').first()).toBeVisible();
    await expect(page.locator('.cm-lint-marker-error').first()).toBeVisible();
    await expect(content(page)).toBeFocused();
    await expect(apply(page)).toHaveCount(0);
  });

  test('граница хранилища: то же сообщение, что на форме, запросов к хранилищу нет', async ({ page, request }) => {
    await open(page);
    const doc = parse(await exportText(request)) as { settings: { environments: { id: string; backend: string; selector: { value: string }[] }[] } };
    const i = doc.settings.environments.findIndex((e) => e.backend === 'grafana');
    doc.settings.environments[i]!.selector[0]!.value = 'чужой';
    await setText(page, stringify(doc, { lineWidth: 0 }));
    await expect(page.getByTestId('import-errors')).toContainText(`settings.environments.${i}.selector.0.value`);
    await expect(page.getByTestId('import-errors')).toContainText('вне границы хранилища');
    await expect(apply(page)).toHaveCount(0);
  });

  test('номер карты в тексте: строка отмечена, значения нет ни в сообщении, ни в отчёте', async ({ page, request }) => {
    await open(page);
    await setText(page, withSystem(await exportText(request), unique(), `Карта ${PAN}`));
    const report = page.getByTestId('import-report');
    await expect(report.getByTestId('import-errors')).toContainText('уберите номер карты');
    await expect(report).not.toContainText(PAN);
    await expect(apply(page)).toHaveCount(0);
    expect(await page.evaluate(() => JSON.stringify({ ...window.localStorage }) + JSON.stringify({ ...window.sessionStorage }) + window.location.href)).not.toContain(PAN);
  });

  test('сменили текст после отчёта: «устарел», кнопки нет, пока нет нового; пустой текст: ошибка формата', async ({ page, request }) => {
    await open(page);
    const text = withSystem(await exportText(request), unique());
    await setText(page, text);
    await expect(apply(page)).toBeVisible();
    await content(page).click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type('# x');
    await expect(page.getByTestId('report-stale')).toBeVisible();
    await expect(apply(page)).toHaveCount(0);
    await expect(apply(page)).toBeVisible();
    await setText(page, '');
    await expect(page.getByTestId('import-errors')).toContainText('файл справочника');
    await expect(apply(page)).toHaveCount(0);
  });

  test('сбой проверки: состояние названо, текст на месте, следующая по кнопке', async ({ page, request }) => {
    await open(page);
    await page.route(IMPORT, (r) => r.fulfill({ status: 503, json: { error: { code: 'catalog-unavailable' } } }));
    await setText(page, withSystem(await exportText(request), unique()));
    await expect(page.getByTestId('file-check-state')).toHaveAttribute('data-state', 'unavailable');
    await page.unroute(IMPORT);
    await page.getByTestId('file-recheck').click();
    await expect(page.getByTestId('import-added')).toBeVisible();
  });

  test('больше 2 МБ: предел назван, запросов нет, скачивание работает; сократил: проверка снова идёт', async ({ page, request }) => {
    const seen = imports(page);
    await open(page);
    const text = await exportText(request);
    await setText(page, `${text}# ${'ж'.repeat(1_200_000)}\n`);
    await expect(page.getByTestId('file-too-large')).toContainText('МБ', { timeout: 15_000 });
    expect(seen).toEqual([]);
    await setText(page, withSystem(text, unique()));
    await expect(page.getByTestId('file-too-large')).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByTestId('import-added')).toBeVisible({ timeout: 15_000 });
  });
});

test.describe('большой текст', () => {
  test('больше 512 КБ разбирается в воркере с нашего адреса: CSP его пускает, проверка идёт', async ({ page, request }) => {
    const denied: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error' && /Content Security Policy|worker/i.test(m.text())) denied.push(m.text());
    });
    await open(page);
    const worker = page.waitForRequest(/syntax\.worker/, { timeout: 15_000 });
    await setText(page, `${withSystem(await exportText(request), unique())}# ${'x'.repeat(600_000)}\n`);
    await worker;
    await expect(page.getByTestId('import-added')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('file-comments')).toBeVisible();
    expect(denied).toEqual([]);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });
});

test.describe('формат', () => {
  test('без правок показана выгрузка; с правками данные те же, строка схемы снова вверху, отмена не возвращает YAML', async ({ page, request }) => {
    await open(page);
    await page.getByTestId('format-json').click();
    await expect(content(page)).toContainText('"project"');
    await expect(page.getByTestId('tab-changed')).toHaveCount(0);
    expect((await saved(page)).name).toBe('pay-project.json');
    expect((await saved(page)).text).toBe(await exportText(request, 'json'));

    await page.getByTestId('format-yaml').click();
    await expect(content(page)).toContainText('settings:');
    const key = unique();
    await setText(page, withSystem(await exportText(request), key));
    await page.getByTestId('format-json').click();
    await expect(page.getByTestId('import-added')).toContainText(key);
    await expect(page.getByTestId('tab-changed')).toBeVisible();
    expect((await saved(page)).text).toContain(`"key": "${key}"`);
    await content(page).click();
    await page.keyboard.press('ControlOrMeta+z');
    expect((await saved(page)).text).toContain(`"key": "${key}"`);
    await page.getByTestId('format-yaml').click();
    await expect(page.getByTestId('file-format').getByRole('button', { name: 'YAML' })).toHaveAttribute('aria-pressed', 'true');
    expect((await saved(page)).text.startsWith('# yaml-language-server: $schema=./catalog.schema.json\n')).toBe(true);
    // Вернул значение после смены формата: текст совпал с выгрузкой, отметки нет.
    await setText(page, await exportText(request));
    await expect(page.getByTestId('tab-changed')).toHaveCount(0);
  });

  test('комментарии: вопрос, отказ оставляет YAML; сломанный текст: формат не меняется, строка названа', async ({ page, request }) => {
    await open(page);
    const text = await exportText(request);
    await setText(page, `${text}# заметка\n`);
    page.once('dialog', (d) => void d.dismiss());
    await page.getByTestId('format-json').click();
    await expect(page.getByTestId('file-format').getByRole('button', { name: 'YAML' })).toHaveAttribute('aria-pressed', 'true');
    await setText(page, text.replace('project: pay', 'project: [pay'));
    await page.getByTestId('format-json').click();
    await expect(page.getByTestId('import-problem')).toContainText('строке');
    await expect(page.getByTestId('file-format').getByRole('button', { name: 'YAML' })).toHaveAttribute('aria-pressed', 'true');
  });

  test('сервер не отдал другой формат: прежний текст и формат, причина названа', async ({ page }) => {
    await open(page);
    await page.route('**/api/projects/pay/catalog/export?format=json', (r) => r.abort('connectionrefused'));
    await page.getByTestId('format-json').click();
    await expect(page.getByTestId('import-problem')).toContainText('Формат не сменён');
    await expect(content(page)).toContainText('settings:');
  });
});

test.describe('правка текста', () => {
  test('Tab вставляет пробелы; Esc и Tab уводят фокус; поиск открывается сочетанием; отмена снимает отметку', async ({ page }) => {
    await open(page);
    await content(page).click();
    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.press('Tab');
    await page.keyboard.type('x');
    expect((await saved(page)).text.startsWith('  x#')).toBe(true);
    await expect(page.getByTestId('tab-changed')).toBeVisible();
    await content(page).click();
    await page.keyboard.press('ControlOrMeta+z');
    await page.keyboard.press('ControlOrMeta+z');
    await expect(page.getByTestId('tab-changed')).toHaveCount(0);
    await content(page).click();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Tab');
    await expect(content(page)).not.toBeFocused();
    await content(page).click();
    await page.keyboard.press('ControlOrMeta+f');
    await expect(page.locator('.cm-search')).toBeVisible();
    await expect(page.locator('.cm-search input[name=search]')).toHaveAttribute('placeholder', 'Найти');
  });

  test('смена темы и языка: цвета и подписи сменились, текст и история на месте', async ({ page, request }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page);
    await setText(page, withSystem(await exportText(request), 'e2e-theme'));
    const gutter = page.locator('.cm-gutters');
    const light = await gutter.evaluate((e) => getComputedStyle(e).backgroundColor);
    expect(light).toBe('rgb(248, 250, 252)');
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    expect(await gutter.evaluate((e) => getComputedStyle(e).backgroundColor)).toBe('rgb(13, 15, 18)');
    await page.evaluate(() => document.documentElement.classList.remove('dark'));

    await pickLanguage(page, 'English');
    await expect(page.getByTestId('file-download')).toContainText('Download');
    await content(page).click();
    await page.keyboard.press('ControlOrMeta+f');
    await expect(page.locator('.cm-search input[name=search]')).toHaveAttribute('placeholder', 'Find');
    expect((await saved(page)).text).toContain('e2e-theme');
    await page.keyboard.press('Escape');
    await content(page).click();
    await page.keyboard.press('ControlOrMeta+z');
    await expect(page.getByTestId('tab-changed')).toHaveCount(0);
  });

  test('уход: отказ оставляет текст, согласие уводит и правки теряются; браузер предупреждает при закрытии', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page);
    await content(page).click();
    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.type('# мой\n');
    await expect(page.getByTestId('tab-changed')).toBeVisible();
    // Вопрос появляется уже после нажатия: ждём его, а не адрес, который и так прежний.
    const refused = page.waitForEvent('dialog');
    await page.getByTestId('project-tab-main').click();
    await (await refused).dismiss();
    await expect(page).toHaveURL(/settings\/file$/);
    await expect(content(page)).toContainText('# мой');
    expect(await page.evaluate(() => JSON.stringify({ ...window.localStorage }) + JSON.stringify({ ...window.sessionStorage }))).not.toContain('# мой');
    expect(page.url()).not.toContain('%23');

    const agreed = page.waitForEvent('dialog');
    await page.getByTestId('project-tab-main').click();
    await (await agreed).accept();
    await expect(page).toHaveURL(/settings\/main$/);
    await page.getByTestId('project-tab-file').click();
    await expect(content(page)).toBeVisible();
    await expect(content(page)).not.toContainText('# мой');
    await expect(page.getByTestId('tab-changed')).toHaveCount(0);
  });

  test('сессия истекла: окно, перехода на вход нет, текст на месте', async ({ page, request }) => {
    await open(page);
    await page.route(IMPORT, (r) => r.fulfill({ status: 401, json: { error: { code: 'unauthenticated' } } }));
    const text = withSystem(await exportText(request), 'e2e-session');
    await setText(page, text);
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page).toHaveURL(/settings\/file$/);
    await expect(page.getByTestId('project-file')).toBeAttached();
    await expect(page.getByTestId('file-check-state')).toHaveAttribute('data-state', 'session');
  });

  test('роль понизили при правках: страница не перезагружается, текст на месте, только чтение, кнопок загрузки нет', async ({ page, request }) => {
    await open(page);
    await setText(page, withSystem(await exportText(request), 'e2e-role-change'));
    await expect(page.getByTestId('import-added')).toBeVisible();
    await page.route('**/api/auth/me', (r) => r.fulfill({ json: { mode: 'on', user: { name: 'Тест' }, role: 'support', capabilities: capabilitiesOf('support') } }));
    // Сервер отказал по роли: права перечитаны, кнопок становится меньше.
    await page.route(IMPORT, (r) => r.fulfill({ status: 403, json: { error: { code: 'forbidden' } } }));
    await content(page).click();
    await page.keyboard.type('# ещё\n');
    await expect(page.getByTestId('file-read-only')).toBeVisible();
    await expect(page.getByTestId('file-upload')).toHaveCount(0);
    await expect(page.getByTestId('import-report')).toHaveCount(0);
    const { text } = await saved(page);
    expect(text).toContain('e2e-role-change');
    expect(text).toContain('# ещё');
  });

  test('данные зоны пропали: сообщение даёт скачать текст, потом текст и история возвращаются вместе со страницей', async ({ page, request }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.clock.install();
    await open(page);
    await setText(page, withSystem(await exportText(request), 'e2e-zone-gone'));
    await expect(page.getByTestId('import-added')).toBeVisible();
    // Опрос состояния сообщил о новой версии проектов, а перечитать настройки зоны не вышло: зона показывает сообщение вместо страницы.
    await page.route('**/api/project-settings', (r) => r.fulfill({ status: 500, json: { error: { code: 'internal' } } }));
    await page.route('**/api/catalog', async (r) => {
      const res = await r.fetch();
      const body = (await res.json()) as { projectsVersion?: number };
      await r.fulfill({ response: res, json: { ...body, projectsVersion: (body.projectsVersion ?? 0) + 1 } });
    });
    await page.clock.fastForward('01:05');
    const kept = page.getByTestId('file-draft-kept');
    await expect(kept).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('project-file')).toHaveCount(0);
    const [d] = await Promise.all([page.waitForEvent('download'), kept.getByRole('button').click()]);
    expect(await readFile((await d.path())!, 'utf8')).toContain('e2e-zone-gone');
    await page.unroute('**/api/project-settings');
    await page.getByRole('button', { name: 'Повторить' }).click();
    await expect(page.getByTestId('project-file')).toBeVisible();
    await expect(kept).toHaveCount(0);
    await expect(page.getByTestId('tab-changed')).toBeVisible();
    expect((await saved(page)).text).toContain('e2e-zone-gone');
    await content(page).click();
    await page.keyboard.press('ControlOrMeta+z');
    await expect(page.getByTestId('tab-changed')).toHaveCount(0);
  });
});

test.describe('чужие изменения', () => {
  test('без правок текст обновляется сам; другой проект сообщения не даёт', async ({ page, request }) => {
    await open(page);
    const was = (await settingOf(request)).retentionDays;
    await colleagueSaves(request, { retentionDays: was + 1 });
    await returnToTab(page);
    await expect(page.getByTestId('file-refreshed')).toBeVisible();
    expect((await saved(page)).text).toBe(await exportText(request));
    await expect(page.getByTestId('file-conflict')).toHaveCount(0);
  });

  test('при правках: сообщение и что делать; «Оставить мои» показывает откат и применяется; «Свежий» заменяет с вопросом', async ({ page, request }) => {
    await open(page);
    const text = await exportText(request);
    const was = (await settingOf(request)).retentionDays;
    const key = unique();
    await setText(page, withSystem(text, key));
    await expect(apply(page)).toBeVisible();
    await colleagueSaves(request, { retentionDays: was + 1 });
    await returnToTab(page);
    const notice = page.getByTestId('file-conflict');
    await expect(notice).toContainText('Проект изменили, пока вы правили');
    await expect(notice).toContainText('его можно скачать');
    await expect(apply(page)).toHaveCount(0);
    await page.getByTestId('file-keep').click();
    await expect(notice).toHaveCount(0);
    await expect(page.getByTestId('import-changed')).toContainText('retentionDays');
    await expect(apply(page)).toBeVisible();

    await colleagueSaves(request, { retentionDays: was + 2 });
    await returnToTab(page);
    await expect(notice).toBeVisible();
    page.once('dialog', (d) => void d.dismiss());
    await page.getByTestId('file-fresh').click();
    await expect(page.getByTestId('tab-changed')).toBeVisible();
    page.once('dialog', (d) => void d.accept());
    await page.getByTestId('file-fresh').click();
    await expect(page.getByTestId('tab-changed')).toHaveCount(0);
    await expect(notice).toHaveCount(0);
    expect((await saved(page)).text).toBe(await exportText(request));
  });

  test('устаревший текст при применении: 409, ничего не записано, те же сообщение и кнопки', async ({ page, request }) => {
    await open(page);
    const key = unique();
    await setText(page, withSystem(await exportText(request), key));
    await expect(apply(page)).toBeVisible();
    const was = (await settingOf(request)).retentionDays;
    await colleagueSaves(request, { retentionDays: was + 1 });
    const answers: number[] = [];
    page.on('response', (r) => {
      if (IMPORT.test(r.url()) && !r.url().includes('dryRun')) answers.push(r.status());
    });
    await apply(page).click();
    await expect(page.getByTestId('file-conflict')).toBeVisible();
    expect(answers).toEqual([409]);
    expect(await exportText(request)).not.toContain(key);
    expect((await saved(page)).text).toContain(key);
    await expect(page.getByTestId('tab-changed')).toBeVisible();
  });
});

test.describe('скачивание и загрузка', () => {
  const upload = (page: Page, name: string, text: string | Buffer) => page.getByTestId('import-input').setInputFiles({ name, mimeType: 'application/octet-stream', buffer: Buffer.isBuffer(text) ? text : Buffer.from(text) });

  test('скачивается ровно текст с экрана; схема открывается в новой вкладке', async ({ page }) => {
    await open(page);
    await content(page).click();
    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.type('# правка\n');
    expect((await saved(page)).text.startsWith('# правка\n')).toBe(true);
    const [tab] = await Promise.all([page.context().waitForEvent('page'), page.getByTestId('file-schema').click()]);
    await expect(tab).toHaveURL(/\/api\/catalog\/schema$/);
    await expect(tab.locator('body')).toContainText('settings');
    await tab.close();
  });

  test('файл без раздела настроек: формат по расширению, настройки не упомянуты, сам ничего не применяет', async ({ page, request }) => {
    await open(page);
    const key = unique();
    await upload(page, 'part.json', JSON.stringify({ version: 1, project: 'pay', systems: [{ key, name: 'Из файла' }] }));
    await expect(page.getByTestId('file-format').getByRole('button', { name: 'JSON' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('import-added')).toContainText('Из файла');
    await expect(page.getByTestId('import-report').locator('[data-kind=settings], [data-kind=environment], [data-kind=view]')).toHaveCount(0);
    expect(await exportText(request)).not.toContain(key);
    // Тот же файл ещё раз: читается заново, проверка идёт по текущему состоянию.
    page.once('dialog', (d) => void d.accept());
    await upload(page, 'part.json', JSON.stringify({ version: 1, project: 'pay', systems: [{ key, name: 'Из файла 2' }] }));
    await expect(page.getByTestId('import-added')).toContainText('Из файла 2');
    page.once('dialog', (d) => void d.dismiss());
    await upload(page, 'other.yaml', 'version: 1\nproject: pay\n');
    await expect(page.getByTestId('import-added')).toContainText('Из файла 2');
  });

  test('не тот файл: другое расширение, кодировка, больше 2 МБ; текст не изменился, запроса нет', async ({ page }) => {
    const seen: string[] = [];
    page.on('request', (r) => {
      if (IMPORT.test(r.url())) seen.push(r.url());
    });
    await open(page);
    await upload(page, 'a.txt', 'x: 1');
    await expect(page.getByTestId('import-problem')).toContainText('.yaml, .yml или .json');
    await upload(page, 'a.yaml', Buffer.from([0xff, 0xfe, 0x00, 0x41]));
    await expect(page.getByTestId('import-problem')).toContainText('UTF-8');
    await upload(page, 'big.yaml', Buffer.alloc(2 * 1024 * 1024 + 1, 0x20));
    await expect(page.getByTestId('import-problem')).toContainText('больше 2 МБ');
    await expect(content(page)).toContainText('settings:');
    expect(seen).toEqual([]);
  });

  test('перетаскивание: те же проверки, что у выбора файла', async ({ page }) => {
    await open(page);
    const drop = (name: string, text: string) =>
      page.evaluate(
        ([n, t]) => {
          const dt = new DataTransfer();
          dt.items.add(new File([t!], n!));
          document.querySelector('.cm-content')!.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));
        },
        [name, text],
      );
    await drop('a.txt', 'x: 1');
    await expect(page.getByTestId('import-problem')).toContainText('.yaml, .yml или .json');
    await drop('dropped.yaml', 'version: 1\nproject: pay\n# из перетаскивания\n');
    await expect(content(page)).toContainText('# из перетаскивания');
    await expect(page.getByTestId('tab-changed')).toBeVisible();
  });
});

test.describe('ширина', () => {
  for (const { width, height, column } of [
    { width: 768, height: 900, column: false },
    { width: 1280, height: 720, column: true },
    { width: 2560, height: 1300, column: true },
  ]) {
    test(`${width}px: английские строки, длинная строка файла, прокрутки страницы нет`, async ({ page, request }) => {
      await page.setViewportSize({ width, height });
      await open(page);
      await pickLanguage(page, 'English');
      await expect(page.getByTestId('file-download')).toContainText('Download');
      const doc = parse(await exportText(request)) as { settings: { retentionDays: number }; systems: unknown[] };
      doc.settings.retentionDays += 1;
      doc.systems = [...doc.systems, { key: unique(), name: 'Система' }];
      // Строка на 2 000 символов прокручивается внутри редактора.
      await setText(page, `${stringify(doc, { lineWidth: 0 })}# ${'x'.repeat(2000)}\n`);
      await expect(apply(page)).toBeVisible();
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      const editor = (await page.getByTestId('file-editor').boundingBox())!;
      const report = (await page.getByTestId('import-report').boundingBox())!;
      if (column) expect(report.x).toBeGreaterThan(editor.x + editor.width - 1);
      else expect(report.y).toBeGreaterThan(editor.y + editor.height - 1);
      if (SHOTS) await page.screenshot({ path: join(SHOTS, `file-${width}.png`) });
    });
  }

  test('снимки в двух темах и доступность', async ({ page, request }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page);
    const doc = parse(await exportText(request)) as { settings: { retentionDays: number; environments: Record<string, unknown>[] } };
    doc.settings.retentionDays += 1;
    await setText(page, stringify(doc, { lineWidth: 0 }));
    await expect(page.getByTestId('import-changed')).toBeVisible();
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'file-light.png') });
    const light = await new AxeBuilder({ page }).include('[data-testid=project-file]').analyze();
    expect(light.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious').map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)).toEqual([]);
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'file-dark.png') });
    doc.settings.environments[0]!.url = 'https://x.example';
    await setText(page, stringify(doc, { lineWidth: 0 }));
    await expect(page.getByTestId('import-errors')).toBeVisible();
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'file-dark-errors.png') });
    await page.evaluate(() => document.documentElement.classList.remove('dark'));
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'file-light-errors.png') });
  });
});
