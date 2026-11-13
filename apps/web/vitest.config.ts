import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Модульные тесты интерфейса. Сквозные тесты в e2e/ запускает Playwright.
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  // Строки страниц в приложении грузит их ленивый маршрут, а тесты открывают страницы напрямую.
  test: { include: ['src/**/*.test.{ts,tsx}'], setupFiles: ['src/i18n/test-setup.ts'] },
});
