// Скачивание текста с экрана: без запроса, поэтому работает и при недоступном сервере. Подключается и над содержимым зоны, без кода редактора.
export function saveText(name: string, text: string, format: 'yaml' | 'json'): void {
  const url = URL.createObjectURL(new Blob([text], { type: format === 'json' ? 'application/json;charset=utf-8' : 'application/yaml;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
