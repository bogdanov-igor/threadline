// Страница файла проекта по ролям на сервере с настоящим входом: у каждой роли только свои кнопки, сервер отказывает по разделам.
import { expect, test, type Page } from '@playwright/test';
import { parse, stringify } from 'yaml';

// Файл сверяет версию всего проекта: тесты идут по очереди на своём сервере, иначе соседний дал бы настоящий конфликт.
test.describe.configure({ mode: 'serial' });

const API = '/api/projects/pay/catalog';
const FILE = '/pay/settings/file';
const IMPORT = /\/api\/projects\/pay\/catalog\/import(\?|$)/;
const content = (page: Page) => page.locator('.cm-content');

async function signIn(page: Page, user: string) {
  await page.goto(FILE);
  await page.locator(`a[data-user="${user}"]`).click();
  await expect(content(page)).toBeVisible();
}

async function setText(page: Page, text: string) {
  await content(page).click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText(text);
}

type Doc = { settings: { retentionDays: number; environments: unknown[] }; masking: { type: string; enabled: boolean }[]; systems?: unknown[] };
const load = async (page: Page) => parse(await (await page.request.get(`${API}/export`)).text()) as Doc;

test('Поддержка: только чтение, поиск, скачивание и схема; загрузки, замены, отчёта и проверки нет', async ({ page }) => {
  const seen: string[] = [];
  page.on('request', (r) => {
    if (IMPORT.test(r.url())) seen.push(r.url());
  });
  await signIn(page, 'support');
  await expect(page.getByTestId('file-read-only')).toBeVisible();
  for (const id of ['file-upload', 'import-input', 'import-report', 'import-apply', 'file-footer']) await expect(page.getByTestId(id)).toHaveCount(0);
  await expect(page.locator('#import-force')).toHaveCount(0);
  await expect(page.getByTestId('file-download')).toBeVisible();
  await expect(page.getByTestId('file-schema')).toBeVisible();
  await expect(page.getByTestId('file-format')).toBeVisible();
  await content(page).click();
  await page.keyboard.type('x');
  await expect(page.getByTestId('tab-changed')).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+f');
  await expect(page.locator('.cm-search')).toBeVisible();
  await page.waitForTimeout(1800);
  expect(seen).toEqual([]);
  const res = await page.request.post(`${API}/import?dryRun=1`, { headers: { 'content-type': 'application/yaml' }, data: 'version: 1' });
  expect(res.status()).toBe(403);
});

test('Бизнес: страница закрыта, выгрузка 403', async ({ page }) => {
  await page.goto(FILE);
  await page.locator('a[data-user="business"]').click();
  await expect(page.getByTestId('section-closed')).toBeVisible();
  await expect(content(page)).toHaveCount(0);
  expect((await page.request.get(`${API}/export`)).status()).toBe(403);
  expect((await page.request.get('/api/projects/pay/file-version')).status()).toBe(403);
});

test('Разработчик: разделы настроек и маскирования называют отказ, справочник применяется', async ({ page }) => {
  await signIn(page, 'developer');
  const doc = await load(page);
  doc.settings.retentionDays += 1;
  doc.masking.find((m) => m.type === 'email')!.enabled = true;
  await setText(page, stringify(doc, { lineWidth: 0 }));
  const errors = page.getByTestId('import-errors');
  await expect(errors).toContainText('settings');
  await expect(errors).toContainText('masking');
  await expect(page.getByTestId('import-apply')).toHaveCount(0);

  const clean = await load(page);
  clean.systems = [...(clean.systems ?? []), { key: 'e2e-role-dev', name: 'Система разработчика' }];
  await setText(page, stringify(clean, { lineWidth: 0 }));
  await expect(page.getByTestId('import-added')).toContainText('Система разработчика');
  await page.getByTestId('import-apply').click();
  await expect(page.getByTestId('import-applied')).toBeVisible();
});

test('Аналитик: настройки применяются, маскирование отклоняет файл целиком', async ({ page }) => {
  await signIn(page, 'analyst');
  const doc = await load(page);
  const days = doc.settings.retentionDays + 1;
  doc.settings.retentionDays = days;
  doc.masking.find((m) => m.type === 'email')!.enabled = true;
  await setText(page, stringify(doc, { lineWidth: 0 }));
  await expect(page.getByTestId('import-errors')).toContainText('masking');
  await expect(page.getByTestId('import-apply')).toHaveCount(0);
  doc.masking.find((m) => m.type === 'email')!.enabled = false;
  await setText(page, stringify(doc, { lineWidth: 0 }));
  await expect(page.getByTestId('import-changed')).toContainText('retentionDays');
  await page.getByTestId('import-apply').click();
  await expect(page.getByTestId('import-applied')).toBeVisible();
  expect((await load(page)).settings.retentionDays).toBe(days);
});

test('Администратор меняет все разделы одной кнопкой', async ({ page }) => {
  await signIn(page, 'admin');
  const doc = await load(page);
  doc.settings.retentionDays += 1;
  const first = doc.masking.find((m) => m.type === 'birth_date')!;
  first.enabled = !first.enabled;
  doc.systems = [...(doc.systems ?? []), { key: 'e2e-role-admin', name: 'Система администратора' }];
  await setText(page, stringify(doc, { lineWidth: 0 }));
  await expect(page.getByTestId('import-apply')).toContainText('Применить 3');
  await page.getByTestId('import-apply').click();
  await expect(page.getByTestId('import-applied')).toBeVisible();
});
