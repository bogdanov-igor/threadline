// Локальный режим (cli/local.ts): свой сервер на 8495 со свежей временной папкой данных и базой PGlite в ней.
// Хранилище подключается на адрес без Loki: проверка честно говорит «нет связи», сохранение без проверки подключает его без перезапуска.
import { expect, test } from '@playwright/test';
import { openUserMenu, userMenu } from './helpers.ts';

const TOKEN = 'e2e-local-token-0123456789';

test.describe.configure({ mode: 'serial' });

test.describe('локальный режим', () => {
  test('призыв на стартовой странице, проверка, сохранение, список без токена, удаление', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/pay\/demo$/);
    const callout = page.getByTestId('local-storage-callout');
    await expect(callout).toBeVisible();
    await callout.getByRole('link', { name: 'Подключить хранилище' }).click();
    await expect(page).toHaveURL(/\/admin\/storages$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Подключить хранилище' })).toBeVisible();
    await expect(page.getByTestId('local-storages-file')).toContainText('storages.json');
    await expect(page.getByTestId('local-storages-empty')).toBeVisible();

    const form = page.getByTestId('local-storage-form');
    await form.getByTestId('local-type-loki').click();
    await expect(form.getByLabel('Имя хранилища')).toHaveValue('loki');
    // Пустой адрес: ошибка у поля без запроса.
    await form.getByTestId('local-storage-check').click();
    await expect(form.getByTestId('field-error')).toHaveText('Заполните поле');
    await form.getByLabel('Адрес Loki').fill('http://127.0.0.1:9');
    await form.getByTestId('local-auth-bearer').click();
    await form.getByLabel('Токен Bearer').fill(TOKEN);

    await form.getByTestId('local-storage-check').click();
    await expect(form.getByTestId('local-check-result')).toHaveAttribute('data-status', 'network');
    await expect(form.getByTestId('local-check-result')).toContainText('Нет связи');

    const saved = page.waitForResponse((r) => r.url().endsWith('/api/local/storages') && r.request().method() === 'POST');
    await form.getByTestId('local-storage-save').click();
    const response = await saved;
    expect(response.status()).toBe(201);
    expect(await response.text()).not.toContain(TOKEN);
    await expect(page.getByTestId('local-storage-saved')).toContainText('Хранилище «loki» подключено.');
    const row = page.locator('[data-testid=local-storage-row][data-storage=loki]');
    await expect(row).toContainText('токен задан');
    await expect(row).toContainText('http://127.0.0.1:9');
    await expect(page.locator('body')).not.toContainText(TOKEN);
    // Форма снова пустая, имя по умолчанию свободное.
    await expect(form.getByLabel('Адрес Grafana')).toHaveValue('');

    // Без перезапуска: хранилище на странице сервиса, призыва на стартовой странице больше нет.
    await page.goto('/admin/status');
    await expect(page.locator('[data-testid=store-row][data-store=loki]')).toBeVisible();
    // Кнопка в шапке «Состояния» рядом с «Проверить всё» и пункт меню профиля ведут на ту же страницу.
    await expect(page.getByTestId('local-storages-link')).toHaveAttribute('href', '/admin/storages');
    await openUserMenu(page);
    await userMenu(page).getByTestId('user-menu-storages').click();
    await expect(page).toHaveURL(/\/admin\/storages$/);
    await expect(page.getByTestId('user-menu-content')).toHaveCount(0);
    const listed = page.waitForResponse((r) => r.url().endsWith('/api/local/storages') && r.request().method() === 'GET');
    await page.goto('/pay/demo');
    await listed;
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.getByTestId('local-storage-callout')).toHaveCount(0);

    await page.goto('/admin/storages');
    await row.getByTestId('local-storage-delete').click();
    await row.getByTestId('local-storage-delete-yes').click();
    await expect(page.getByTestId('local-storages-empty')).toBeVisible();
  });

  test('стартовая страница демо-проекта: примеры из настройки, призыв скрывается крестиком и не возвращается в этом браузере', async ({ page }) => {
    await page.goto('/pay/demo');
    await expect(page.getByTestId('search-example')).toHaveCount(5);
    const callout = page.getByTestId('local-storage-callout');
    await expect(callout).toBeVisible();
    // Призыв первым на странице: «записи выдуманные» видно до щелчка по примеру.
    const top = async (testId: string) => (await page.getByTestId(testId).boundingBox())!.y;
    expect(await top('local-storage-callout')).toBeLessThan(await top('start-intro'));
    expect(await top('start-intro')).toBeLessThan(await top('search-examples-try'));
    await callout.getByTestId('local-storage-callout-hide').click();
    await expect(callout).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId('search-example')).toHaveCount(5);
    await expect(page.getByTestId('local-storage-callout')).toHaveCount(0);
  });
});
