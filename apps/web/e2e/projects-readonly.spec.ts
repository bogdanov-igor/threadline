// Страницы проектов без базы: сервер single запущен без THREADLINE_DATABASE_URL, правка закрыта и причина названа.
import { expect, test, type Page } from '@playwright/test';
import { closeMenu, openProjectMenu } from './helpers.ts';

const source = (page: Page) => page.getByTestId('projects-source');

test('список: проекты из файла видны, кнопок правки нет, причина называет переменную', async ({ page }) => {
  await page.goto('/admin/projects');
  await expect(page.getByTestId('project-row')).toHaveCount(1);
  await expect(page.getByTestId('project-row')).toContainText('Demo Pay');
  await expect(source(page)).toContainText('THREADLINE_DATABASE_URL');
  await expect(page.getByRole('link', { name: 'Добавить проект' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Ещё:/ })).toHaveCount(0);
  await expect(page.getByTestId('project-edit')).toHaveText('Настройки');
  await openProjectMenu(page);
  await expect(page.getByTestId('header-projects')).toHaveAttribute('aria-current', 'page');
  await closeMenu(page);
});

test('форма: значения видны, поля закрыты, сохранения нет, причина та же', async ({ page }) => {
  await page.goto('/pay/settings/main');
  await expect(page.getByTestId('project-name')).toHaveValue('Demo Pay');
  await expect(page.getByTestId('project-name')).toBeDisabled();
  await expect(page.getByTestId('project-id')).toHaveValue('pay');
  await expect(page.getByTestId('project-save')).toHaveCount(0);
  await expect(page.getByTestId('form-hide')).toHaveCount(0);
  await expect(source(page)).toContainText('THREADLINE_DATABASE_URL');
  await page.goto('/pay/settings/environments');
  await page.getByTestId('env-card').first().getByTestId('env-toggle').click();
  await expect(page.getByTestId('env-card').first().getByTestId('matcher-value')).toHaveValue('pay');
  await expect(page.getByTestId('project-save')).toHaveCount(0);
  await expect(page.getByTestId('add-env')).toHaveCount(0);
  await expect(source(page)).toContainText('THREADLINE_DATABASE_URL');
});

test('создание: причина и ссылка к списку вместо пустой формы', async ({ page }) => {
  await page.goto('/admin/projects/new');
  await expect(source(page)).toContainText('THREADLINE_DATABASE_URL');
  await expect(page.getByTestId('project-id')).toHaveCount(0);
  await page.getByRole('main').getByRole('link', { name: 'К проектам' }).click();
  await expect(page).toHaveURL(/\/admin\/projects$/);
});

test('страница сервиса без базы: в «Состоянии» база «Не подключена», раздела настроек нет с пояснением, список хранилищ на месте', async ({ page }) => {
  await page.goto('/admin/status');
  await expect(page.getByTestId('status-database').getByTestId('row-status')).toHaveText('Не подключена');
  await expect(page.getByTestId('status-login').getByTestId('row-status')).toHaveText('Выключен');
  await expect(page.getByTestId('service-no-settings')).toContainText('THREADLINE_DATABASE_URL');
  await expect(page.getByTestId('settings-page')).toHaveCount(0);
  await expect(page.getByTestId('stores-list')).toBeVisible();
});

test('запрос правки в обход интерфейса отклоняет сервер', async ({ request }) => {
  const r = await request.put('/api/projects/pay', { data: { name: 'Новое' } });
  expect(r.status()).toBe(503);
  expect(((await r.json()) as { error: { code: string } }).error.code).toBe('project-readonly');
});

test('база пропала: время снимка, правка закрыта, ответ 503 не теряет введённое', async ({ page }) => {
  // Сначала форма открыта на рабочей базе, ответы подменены: настоящая база есть только у сервера проектов.
  let state: 'ok' | 'stale' = 'ok';
  await page.route('**/api/project-settings', async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { projects: { updatedAt: string | null }[] } & Record<string, unknown>;
    body.state = state;
    body.editable = state === 'ok';
    body.loadedAt = Date.UTC(2026, 10, 4, 7, 30);
    body.message = state === 'ok' ? null : 'база справочника недоступна (db.test:5432/threadline): connect ECONNREFUSED';
    body.projects = body.projects.map((p) => ({ ...p, updatedAt: '2026-11-04T07:30:00.000000Z' }));
    await route.fulfill({ response: res, json: body });
  });
  await page.route('**/api/projects/pay', (route) => route.fulfill({ status: 503, json: { error: { code: 'project-readonly' } } }));

  await page.goto('/pay/settings/main');
  await page.getByTestId('project-name').fill('Введённое название');
  await page.getByTestId('project-save').click();
  await expect(page.getByTestId('form-problem')).toContainText('База недоступна');
  await expect(page.getByTestId('project-name')).toHaveValue('Введённое название');

  state = 'stale';
  page.once('dialog', (d) => void d.accept());
  await page.goto('/admin/projects');
  await expect(source(page)).toContainText('db.test:5432');
  await expect(source(page)).toContainText('2026');
  await expect(page.getByRole('link', { name: 'Добавить проект' })).toHaveCount(0);
});
