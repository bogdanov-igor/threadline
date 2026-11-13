import { defineConfig } from 'vitest/config';

// PostgreSQL для тестов справочника: один поиск на прогон, до запуска файлов.
export default defineConfig({
  test: { globalSetup: ['test/catalog/pg-setup.ts'] },
});
