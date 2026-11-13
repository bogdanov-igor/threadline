// Снимки для страниц «Установка и настройка».
export default [
  // Страница «Настройки сервиса» после проверки хранилища.
  {
    name: 'admin-status',
    path: '/admin/status',
    role: 'admin',
    viewport: { width: 1100, height: 720 },
    async actions(page) {
      await page.getByTestId('store-probe').first().click();
      await page.getByText('Работает', { exact: true }).first().waitFor();
    },
    crop: (page) => page.getByRole('main'),
  },
  // Метка в шапке, когда вход выключен.
  {
    name: 'admin-login-off',
    path: '/about',
    viewport: { width: 1280, height: 400 },
    crop: (page) => page.getByTestId('header-actions'),
    pad: 8,
  },
  // Кнопка с инициалами, когда вход включён.
  {
    name: 'admin-login-on',
    path: '/about',
    role: 'admin',
    viewport: { width: 1280, height: 400 },
    crop: (page) => page.getByTestId('header-actions'),
    pad: 8,
  },
];
