// Страницы проектов без браузера: разметка из renderToStaticMarkup. Поведение в браузере проверяют сквозные тесты projects.spec.
import type { ProjectSetting, ProjectSettingsResponse } from '@threadline/core';
import { capabilitiesOf, type Role } from '@threadline/core/access';
import { DEFAULT_VIEW } from '@threadline/core/view';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import '../../i18n/index.ts';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { AccessContext, accessOf } from '@/features/auth/access.tsx';
import ProjectPages from './pages.tsx';
import { settingsKey } from './queries.ts';

const project = (over: Partial<ProjectSetting> = {}): ProjectSetting => ({
  id: 'pay',
  name: 'Demo Pay',
  timezone: 'Asia/Karachi',
  retentionDays: 30,
  format: 'json',
  hidden: null,
  fileState: 'same',
  updatedAt: '2026-11-04T10:00:00.000000Z',
  view: DEFAULT_VIEW,
  viewUpdatedAt: null,
  viewIssues: [],
  environments: [{ id: 'prod', name: 'Прод', kind: 'single', backend: 'grafana', selector: [{ label: 'namespace', op: '=', value: 'pay' }] }],
  ...over,
});

const settings = (over: Partial<ProjectSettingsResponse> = {}): ProjectSettingsResponse => ({
  state: 'ok',
  editable: true,
  message: null,
  loadedAt: 1,
  projects: [project()],
  formats: ['acme-json'],
  stores: [
    { id: 'grafana', type: 'loki-grafana', tokenEnv: 'THREADLINE_GRAFANA_TOKEN', tokenSet: true, scope: { label: 'namespace', values: ['pay', 'pay-*'] } },
    { id: 'demo', type: 'mock', scope: null },
  ],
  defaults: { project: 'pay', environment: 'prod' },
  ignoredInFile: [],
  fallbackToFile: false,
  ...over,
});

function html(path: string, data: ProjectSettingsResponse, page: 'list' | 'new' | 'edit', role: Role = 'admin'): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(settingsKey, data);
  const router = createMemoryRouter(
    [
      { path: 'admin/projects/:rest?', element: <ProjectPages page={page} /> },
      { path: ':project/settings/:section?', element: <ProjectPages page={page} /> },
    ],
    { initialEntries: [path] },
  );
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <AccessContext.Provider value={accessOf({ mode: 'on', user: { name: 'Тест' }, role, capabilities: capabilitiesOf(role) })}>
          <RouterProvider router={router} />
        </AccessContext.Provider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe('список проектов', () => {
  it('таблица и кнопка добавления; хранилищ, проверки подключения и меню строки нет', () => {
    const page = html('/admin/projects', settings(), 'list');
    expect(page).not.toContain('Входа нет');
    expect(page).toContain('Добавить проект');
    expect(page).toContain('Формат логов');
    expect(page).not.toContain('THREADLINE_GRAFANA_TOKEN');
    expect(page).not.toContain('Новая Grafana');
    expect(page).not.toContain('Проверить подключение');
    expect(page).not.toContain('Ещё: Demo Pay');
    expect(page).toContain('href="/pay/prod"');
    expect(page).toContain('href="/pay/settings/main"');
  });

  it('без базы: причина с именем переменной, кнопки добавления нет', () => {
    const page = html('/admin/projects', settings({ state: 'off', editable: false, loadedAt: null }), 'list');
    expect(page).toContain('THREADLINE_DATABASE_URL');
    expect(page).not.toContain('Добавить проект');
    expect(page).toContain('Настройки');
  });

  it('база пропала: время снимка и причина', () => {
    const page = html('/admin/projects', settings({ state: 'stale', editable: false, message: 'db:5432/x недоступна', loadedAt: Date.UTC(2026, 10, 4, 5, 0) }), 'list');
    expect(page).toContain('db:5432/x недоступна');
    expect(page).toContain('04.11.2026 10:00');
  });

  it('скрытый проект по умолчанию не показан, неверная запись: ошибки с путями, ссылки на поиск нет', () => {
    const bad = project({ id: 'acme', name: 'Acme', issues: [{ path: 'projects.acme.format', message: 'профиля нет' }] });
    const hidden = project({ id: 'old', name: 'Старый', hidden: 'file', fileState: 'removed' });
    const page = html('/admin/projects', settings({ projects: [project(), bad, hidden] }), 'list');
    expect(page).toContain('projects.acme.format');
    expect(page).not.toContain('href="/acme/prod"');
    expect(page).toContain('href="/acme/settings/main"');
    expect(page).not.toContain('Старый');
    expect(page).toContain('Скрытые (1)');
  });

  it('отметки файла и разметка в названии как текст', () => {
    const page = html('/admin/projects', settings({ projects: [project({ name: '<b>acme</b>', fileState: 'file-newer' })] }), 'list');
    expect(page).toContain('&lt;b&gt;acme&lt;/b&gt;');
    expect(page).toContain('Файл изменился, не применён');
    // Действия с файлом только на странице настроек проекта.
    expect(page).not.toContain('Взять из файла');
    expect(page).not.toContain('Оставить');
  });

  it('пятьдесят сред: в строке шесть и число остальных, полный список в подсказке', () => {
    const environments = Array.from({ length: 50 }, (_, i) => ({ id: `e${i}`, name: `Среда ${i}`, kind: 'single' as const, backend: 'grafana', selector: [{ label: 'namespace', op: '=' as const, value: 'x' }] }));
    const page = html('/admin/projects', settings({ projects: [project({ environments })] }), 'list');
    expect(page).toContain('Среда 5<');
    expect(page).not.toContain('Среда 6<');
    expect(page).toContain('+44');
    expect(page).toContain('Среда 49"');
  });

  it('видимых проектов нет: сообщение вместо пустой таблицы', () => {
    const page = html('/admin/projects', settings({ projects: [project({ hidden: 'page' })] }), 'list');
    expect(page).toContain('data-testid="projects-empty"');
    expect(page).toContain('Скрытые (1)');
  });

  it('запрошенный файлом проект скрыт и удалённый остался в файле: названы', () => {
    const page = html('/admin/projects', settings({ configuredDefaults: { project: 'pay', environment: 'prod' }, defaults: { project: 'acme', environment: 'demo' }, ignoredInFile: ['gone'] }), 'list');
    expect(page).toContain('pay/prod');
    expect(page).toContain('acme/demo');
    expect(page).toContain('gone');
  });
});

describe('форма проекта', () => {
  it('новая: поля, кнопка «Создать», шаблон границы у хранилища', () => {
    const page = html('/admin/projects/new', settings(), 'new');
    expect(page).toContain('data-testid="project-id"');
    expect(page).toContain('Создать');
    expect(page).toContain('pay, pay-*');
    expect(page).not.toContain('formats:');
  });

  it('новая без базы: причина и ссылка к списку, пустой формы нет', () => {
    const page = html('/admin/projects/new', settings({ state: 'off', editable: false, loadedAt: null }), 'new');
    expect(page).toContain('THREADLINE_DATABASE_URL');
    expect(page).not.toContain('data-testid="project-id"');
    expect(page).toContain('href="/admin/projects"');
  });

  it('правка: идентификатор только для чтения, условия нейтральным текстом, значение буквально', () => {
    const data = settings({ projects: [project({ environments: [{ id: 'prod', name: 'Прод', kind: 'single', backend: 'grafana', selector: [{ label: 'app', op: '=', value: '"} or {x="1' }] }] })] });
    const page = html('/pay/settings/main', data, 'edit');
    expect(page).toMatch(/<input[^>]*readOnly[^>]*data-testid="project-id"|<input[^>]*data-testid="project-id"[^>]*readOnly/i);
    expect(page).toContain('Не меняется');
    expect(html('/pay/settings/environments', data, 'edit')).toContain('app = &quot;&quot;} or {x=&quot;1&quot;');
  });

  it('только для чтения: значения видны, сохранения нет', () => {
    const page = html('/pay/settings/main', settings({ state: 'off', editable: false, loadedAt: null }), 'edit');
    expect(page).toContain('value="Demo Pay"');
    expect(page).toContain('THREADLINE_DATABASE_URL');
    expect(page).not.toContain('data-testid="project-save"');
    expect(page).not.toContain('data-testid="add-env"');
  });

  it('неизвестный проект: сообщение и ссылка к списку', () => {
    const page = html('/nope/settings/main', settings(), 'edit');
    expect(page).toContain('Такого проекта нет');
    expect(page).toContain('href="/admin/projects"');
  });

  it('пропавший профиль и пропавшее хранилище названы, ошибка записи стоит у поля', () => {
    const data = settings({ projects: [project({ format: 'gone', issues: [{ path: 'projects.pay.format', message: 'профиля формата нет' }], environments: [{ id: 'prod', name: 'Прод', kind: 'single', backend: 'old', selector: [{ label: 'namespace', op: '=', value: 'x' }], missingStore: 'old' }] })] });
    expect(html('/pay/settings/main', data, 'edit')).toContain('профиля формата нет');
    expect(html('/pay/settings/environments', data, 'edit')).toContain('Этого хранилища больше нет');
  });

  it('скрытый проект предлагает показать и удалить', () => {
    const page = html('/pay/settings/main', settings({ projects: [project({ hidden: 'page' }), project({ id: 'other' })] }), 'edit');
    expect(page).toContain('data-testid="form-show"');
    expect(page).toContain('data-testid="form-delete"');
  });
});

describe('страницы проектов по роли: недоступных кнопок нет в разметке', () => {
  const fileNewer = settings({ projects: [project({ fileState: 'file-newer' })] });

  it.each(['support', 'developer', 'analyst'] as const)('%s: в списке поиск и настройки, добавления нет', (role) => {
    const page = html('/admin/projects', fileNewer, 'list', role);
    expect(page).not.toContain('Добавить проект');
    expect(page).not.toContain('Взять из файла');
    expect(page).toContain('href="/pay/prod"');
    expect(page).toContain('href="/pay/settings/main"');
  });

  it('администратор: добавление есть', () => {
    expect(html('/admin/projects', fileNewer, 'list', 'admin')).toContain('Добавить проект');
  });

  it.each(['support', 'developer'] as const)('%s: форма только для чтения, кнопка проверки и значения на месте, вкладка «Вид» без сохранения', (role) => {
    const page = ['main', 'environments', 'view'].map((section) => html(`/pay/settings/${section}`, fileNewer, 'edit', role)).join('');
    expect(page).toContain('value="Demo Pay"');
    expect(page).toContain('data-testid="probe-button"');
    for (const id of ['project-save', 'add-env', 'env-remove', 'add-condition', 'form-hide', 'view-save', 'view-reset']) expect(page, id).not.toContain(`data-testid="${id}"`);
    expect(page).not.toContain('Взять из файла');
    expect(page).toContain('data-testid="view-section"');
    expect(page).not.toContain('Входа нет');
  });

  it('аналитик: сохранение и скрытие есть, у скрытого проекта показать можно, удалить навсегда нет', () => {
    const page = html('/pay/settings/main', settings(), 'edit', 'analyst');
    expect(page).toContain('data-testid="project-save"');
    expect(html('/pay/settings/view', settings(), 'edit', 'analyst')).toContain('data-testid="view-save"');
    expect(page).toContain('data-testid="form-hide"');
    const hidden = html('/pay/settings/main', settings({ projects: [project({ hidden: 'page' }), project({ id: 'other' })] }), 'edit', 'analyst');
    expect(hidden).toContain('data-testid="form-show"');
    expect(hidden).not.toContain('data-testid="form-delete"');
  });
});
