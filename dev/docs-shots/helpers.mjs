// Общие действия для списков снимков. Подписи те же, что в сквозных тестах (apps/web/e2e).
const ROW_HIT = { position: { x: 8, y: 8 } };

/** Поиск на открытой странице среды: значения, период, «Найти». Ждёт конца поиска. */
export async function search(page, terms, preset = '24 ч') {
  const input = page.getByRole('textbox', { name: 'Значения для поиска' });
  for (const term of terms) {
    await input.fill(term);
    await input.press('Enter');
  }
  if (preset) await page.getByRole('group', { name: 'Период' }).getByRole('button', { name: preset, exact: true }).click();
  await page.getByRole('button', { name: 'Найти', exact: true }).click();
  await page.locator('[data-testid="search-results"][data-status="done"]').waitFor({ timeout: 20_000 });
}

/** Открыть запрос из списка результатов: номер строки с нуля. */
export async function openRequest(page, row = 0) {
  await page.getByRole('list', { name: 'Найденные запросы' }).getByRole('listitem').nth(row).locator('[data-row-link]').click(ROW_HIT);
  await page.getByTestId('request-header').waitFor();
}
