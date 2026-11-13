// Тема до первой отрисовки, чтобы не было вспышки светлой темы. Отдельный файл: CSP запрещает встроенные скрипты.
(function () {
  var theme = 'system';
  try {
    theme = window.localStorage.getItem('threadline.theme') || 'system';
  } catch {
    theme = 'system';
  }
  var dark = theme === 'dark' || (theme !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  var root = document.documentElement;
  if (dark) root.classList.add('dark');
  root.style.colorScheme = dark ? 'dark' : 'light';
})();
