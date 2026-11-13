import { expect, test, type Page } from '@playwright/test';
import { goToService, helpButton, openProjectMenu, projectButton } from './helpers.ts';

// Подсказка не висит: показ при наведении и при фокусе с клавиатуры.

const tip = (page: Page) => page.getByRole('tooltip');
const FAR = { x: 700, y: 600 };

/** Дольше задержки показа 400 мс: подсказка, которая должна была появиться, уже видна. */
const noTipAfterDelay = async (page: Page) => {
  await page.waitForTimeout(600);
  await expect(tip(page)).toHaveCount(0);
};

async function open(page: Page) {
  // Счётчик «Неизвестного» даёт кнопке проекта текст подсказки.
  await page.route('**/api/catalog', (route) => route.fulfill({ json: { state: 'ok', loadedAt: Date.now(), unknownOpen: { pay: 9 } } }));
  await page.goto('/pay/demo');
  await expect(projectButton(page)).toBeEnabled();
  await page.mouse.move(FAR.x, FAR.y);
}

test('мышь: меню проекта открыть и закрыть, перейти пунктом меню профиля, увести указатель — подсказки нет', async ({ page }) => {
  await open(page);
  await openProjectMenu(page);
  await page.waitForTimeout(300);
  await page.mouse.click(FAR.x, FAR.y);
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(projectButton(page)).toBeFocused();
  await noTipAfterDelay(page);

  // Меню закрывается переходом и возвращает фокус на кнопку профиля: подсказка от этого не открывается.
  await goToService(page);
  await expect(page).toHaveURL(/\/admin\/status$/);
  await page.mouse.move(FAR.x, FAR.y, { steps: 4 });
  await noTipAfterDelay(page);
});

test('окно вернулось из другой вкладки: фокус на кнопке подсказку не открывает', async ({ page }) => {
  await open(page);
  await helpButton(page).click();
  await page.keyboard.press('Escape');
  await page.mouse.move(FAR.x, FAR.y, { steps: 4 });
  await noTipAfterDelay(page);
  // Браузер шлёт эти события кнопке с фокусом, сквозной браузер всегда в фокусе.
  await page.evaluate(() => {
    const el = document.activeElement!;
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    window.dispatchEvent(new Event('blur'));
    window.dispatchEvent(new Event('focus'));
    el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  });
  await noTipAfterDelay(page);
});

test('наведение: подсказка закрывается, когда указатель ушёл за край окна, и при потере окна', async ({ page }) => {
  await open(page);
  const box = (await helpButton(page).boundingBox())!;
  await helpButton(page).hover();
  await expect(tip(page)).toContainText('Справка');
  await page.mouse.move(box.x + 4, -30);
  await expect(tip(page)).toHaveCount(0);

  await helpButton(page).hover();
  await expect(tip(page)).toContainText('Справка');
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(tip(page)).toHaveCount(0);
});

test('клавиатура: Tab показывает подсказку, Escape и уход фокуса закрывают, закрытие меню с клавиатуры не показывает', async ({ page }) => {
  await open(page);
  await helpButton(page).focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(helpButton(page)).toBeFocused();
  await expect(tip(page)).toContainText('Справка');
  await page.keyboard.press('Escape');
  await expect(tip(page)).toHaveCount(0);

  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(tip(page)).toContainText('Справка');
  await page.keyboard.press('Tab');
  await expect(tip(page)).not.toContainText('Справка');

  await helpButton(page).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(helpButton(page)).toBeFocused();
  await noTipAfterDelay(page);
});

test('тёмная тема: тёмная плашка с рамкой и светлым текстом, светлая остаётся тёмной плашкой', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await open(page);
  await helpButton(page).hover();
  const colors = () => page.locator('[data-radix-popper-content-wrapper] > *').evaluate((el) => {
    const s = getComputedStyle(el);
    return [s.backgroundColor, s.color, s.borderTopColor];
  });
  await expect(tip(page)).toBeVisible();
  expect(await colors()).toEqual(['rgb(42, 47, 55)', 'rgb(230, 232, 235)', 'rgb(61, 67, 77)']);
  await page.mouse.move(FAR.x, FAR.y, { steps: 4 });
  await expect(tip(page)).toHaveCount(0);

  await page.emulateMedia({ colorScheme: 'light' });
  await helpButton(page).hover();
  await expect(tip(page)).toBeVisible();
  expect((await colors()).slice(0, 2)).toEqual(['rgb(11, 27, 51)', 'rgb(255, 255, 255)']);
});
