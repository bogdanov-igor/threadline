import { expect, test, type Page } from '@playwright/test';
import { fixture } from '../src/features/business/fixtures.ts';
import { homeLink } from './helpers.ts';

// Шутки интерфейса на своём сервере: они включены настройкой extras.publicEggs.
// Часы браузера задаёт тест: шутки по времени не появляются сами.

const termsInput = (page: Page) => page.getByRole('textbox', { name: 'Значения для поиска' });
const overlay = (page: Page) => page.getByTestId('extras-overlay');
const chips = (page: Page) => page.getByTestId('term-chip');

// Среда, 11 ноября, полдень по Москве: не ночь, не пятница, не 13 сентября.
const NOON = new Date('2026-11-11T12:00:00+03:00');

/** Страница поиска с полем значений в фокусе. Выключатель шуток приходит в ответе /api/auth/me до первого кадра приложения. */
async function open(page: Page, at = NOON) {
  await page.clock.setFixedTime(at);
  await page.goto('/pay/demo');
  await termsInput(page).focus();
}

async function enter(page: Page, text: string) {
  await termsInput(page).fill(text);
  await termsInput(page).press('Enter');
}

test.describe('общие шутки', () => {
  test('sudo забирается, 42 показывается и остаётся значением', async ({ page }) => {
    await open(page);
    await enter(page, 'SUDO');
    await expect(overlay(page)).toHaveText('Вас нет в sudoers. Об этом инциденте будет доложено.');
    await expect(termsInput(page)).toHaveValue('');
    await expect(chips(page)).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(overlay(page)).toHaveCount(0);

    await enter(page, '42');
    await expect(overlay(page)).toHaveText('Ответ найден. Вопрос — нет.');
    await expect(chips(page)).toHaveCount(1);
    await expect(chips(page)).toContainText('42');
  });

  test('ночью раз в день: чашка кофе при открытии, после перезагрузки шутки нет', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-11-11T03:10:00+03:00'));
    await page.goto('/pay/demo');
    await expect(overlay(page)).toHaveText('Иди спать. Инцидент подождёт до утра.');
    await page.reload();
    await expect(termsInput(page)).toBeVisible();
    await page.waitForTimeout(1500);
    await expect(overlay(page)).toHaveCount(0);
  });

  test('семь нажатий на логотип: «Титры» с бегущим текстом, Escape — обычная страница; без движения — сразу обычная', async ({
    page,
  }) => {
    await open(page);
    const seven = () =>
      homeLink(page).evaluate((a) => Array.from({ length: 7 }, () => (a as HTMLElement).click()));
    await seven();
    await expect(page).toHaveURL(/\/credits$/);
    await expect(page.getByTestId('credits-crawl')).toBeVisible();
    await expect(page.getByTestId('help-page-credits')).toBeAttached();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('credits-crawl')).toHaveCount(0);
    await expect(page.getByTestId('help-page-credits')).toBeVisible();
    await expect(page.locator('a[href="/credits"]')).toHaveCount(0);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page);
    // Новая загрузка страницы: паузы прежней загрузки нет.
    await seven();
    await expect(page).toHaveURL(/\/credits$/);
    await expect(page.getByTestId('help-page-credits')).toBeVisible();
    await expect(page.getByTestId('credits-crawl')).toHaveCount(0);
  });

  test('чайник у шага с HTTP 418 на странице запроса', async ({ page }) => {
    // Подменённый ответ запроса без справочника: заголовок записи — метод, путь и статус; у ответа с ошибкой статус 418.
    const base = fixture('known');
    const records = base.records.map(({ catalog: _catalog, ...r }) => {
      if (!r.http || r.kind === 'incoming') return r;
      const status = r.kind === 'response' ? (r.isError ? 418 : 200) : null;
      return {
        ...r,
        http: { ...r.http, status },
        title: `POST /v3/card${status === null ? '' : ` → ${status}`}`,
      };
    });
    const json = { ...base, records };
    await page.route('**/api/projects/pay/envs/demo/requests/cid-business-1*', (route) =>
      route.fulfill({ json }),
    );
    await page.clock.setFixedTime(NOON);
    await page.goto('/pay/demo/requests/cid-business-1?from=1793000000000&to=1793000100000');
    await page.getByRole('tab', { name: /^Записи/ }).click();
    const titles = page.getByTestId('record-title');
    await expect(titles.filter({ hasText: '418' }).first().getByTestId('teapot')).toBeVisible({
      timeout: 20_000,
    });
    // Чайник только у 418: у записей с другим статусом его нет.
    await expect(titles.filter({ hasNotText: '418' }).getByTestId('teapot')).toHaveCount(0);
    await expect(titles.filter({ hasText: '418' }).getByTestId('teapot')).toHaveCount(
      await titles.filter({ hasText: '418' }).count(),
    );
  });

  test('код Konami вне поля: дождь, Escape останавливает; в поле — ничего', async ({ page }) => {
    await open(page);
    const konami = async () => {
      for (const key of [
        'ArrowUp',
        'ArrowUp',
        'ArrowDown',
        'ArrowDown',
        'ArrowLeft',
        'ArrowRight',
        'ArrowLeft',
        'ArrowRight',
        'b',
        'a',
      ])
        await page.keyboard.press(key);
    };
    await konami();
    await page.waitForTimeout(300);
    await expect(page.getByTestId('extras-matrix')).toHaveCount(0);
    await termsInput(page).fill('');
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await konami();
    await expect(page.getByTestId('extras-matrix')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('extras-matrix')).toHaveCount(0);
  });
});
