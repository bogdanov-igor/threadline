// Страница /admin/status на разметке. Нажатия и запросы проверяют сквозные тесты shell.spec и projects.spec.
import type { ProjectSettingsResponse } from '@threadline/core';
import { capabilitiesOf, type Role } from '@threadline/core/access';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import '../../i18n/index.ts';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { AccessContext, accessOf } from '@/features/auth/access.tsx';
import { settingsKey } from '@/features/projects/queries.ts';
import i18n from '@/i18n/index.ts';
import projects from '../projects/ru.json';
import ru from './ru.json';
import ServicePage, { checkSide } from './ServicePage.tsx';

i18n.addResourceBundle('ru', 'translation', { service: ru, projects }, true, true);

const settings = (over: Partial<ProjectSettingsResponse> = {}): ProjectSettingsResponse => ({
  state: 'ok',
  editable: true,
  message: null,
  loadedAt: 1,
  projects: [],
  formats: [],
  stores: [
    { id: 'grafana', type: 'loki-grafana', tokenEnv: 'THREADLINE_GRAFANA_TOKEN', tokenSet: false, scope: { label: 'namespace', values: ['pay', 'pay-*'] } },
    { id: 'demo', type: 'mock', scope: null },
  ],
  defaults: { project: 'pay', environment: 'prod' },
  ignoredInFile: [],
  fallbackToFile: false,
  ...over,
});

function html(data: ProjectSettingsResponse, role: Role = 'developer', mode: 'on' | 'off' = 'on'): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(settingsKey, data);
  const router = createMemoryRouter([{ path: 'admin/status', element: <ServicePage /> }], { initialEntries: ['/admin/status'] });
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <AccessContext.Provider value={accessOf({ mode, user: { name: 'Тест' }, role, capabilities: capabilitiesOf(role) })}>
          <RouterProvider router={router} />
        </AccessContext.Provider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe('состояние', () => {
  it('хранилища, база и вход одним списком; до нажатия нет результата проверки, «Проверить» только у хранилищ', () => {
    const page = html(settings());
    expect(page).toContain('data-testid="status-database"');
    expect(page).toContain('Работает');
    expect(page).toContain('OIDC');
    expect(page).toContain('Не проверено');
    expect(page).toContain('data-testid="stores-probe-all"');
    expect(page).not.toContain('data-testid="probe-result"');
    expect((page.match(/data-testid="store-probe"/g) ?? []).length).toBe(2);
    // Сводных карточек и версии больше нет: версия в «О Threadline».
    expect(page).not.toContain('service-summary');
    expect(page).not.toContain('service-version');
  });

  it('вход выключен', () => {
    const row = /data-testid="status-login"[\s\S]*?<\/li>/.exec(html(settings(), 'admin', 'off'))![0];
    expect(row).toContain('Выключен настройкой auth: off');
  });

  it('база не подключена: в сводке сказано, раздела настроек нет с пояснением, причина названа', () => {
    const page = html(settings({ state: 'off', editable: false, loadedAt: null }), 'admin');
    expect(page).toContain('Не подключена');
    expect(page).toContain('data-testid="service-no-settings"');
    expect(page).toContain('THREADLINE_DATABASE_URL');
    expect(page).not.toContain('data-testid="settings-page"');
  });

  it('база не подключена, не администратор: пояснения о настройках нет', () => {
    expect(html(settings({ state: 'off', editable: false, loadedAt: null }))).not.toContain('service-no-settings');
  });

  it('база недоступна: в сводке сказано, причина и таблица на месте', () => {
    const page = html(settings({ state: 'stale', editable: false, message: 'db:5432/x недоступна', loadedAt: Date.UTC(2026, 10, 4, 5, 0) }));
    expect(page).toContain('Недоступна');
    expect(page).toContain('db:5432/x недоступна');
    expect(page).toContain('data-testid="stores-list"');
  });
});

describe('строки хранилищ', () => {
  it('токен не задан: видно без проверки, названа переменная, которую задать', () => {
    const row = /data-store="grafana"[\s\S]*?<\/li>/.exec(html(settings()))![0];
    expect(row).toContain('Токен не задан');
    expect(row).toContain('Задайте переменную THREADLINE_GRAFANA_TOKEN');
  });

  it('Loki напрямую: вид «Loki», без входа о токене ничего нет', () => {
    const page = html(settings({ stores: [{ id: 'logs', type: 'loki', scope: null }] }));
    const row = /data-store="logs"[\s\S]*?<\/li>/.exec(page)![0];
    expect(row).toContain('Loki');
    expect(row).not.toContain('Токен не задан');
    expect(row).not.toContain('data-testid="token-state"');
  });

  it('граница чтения коротко, полный текст в подсказке; у имитации прочерки', () => {
    const page = html(settings());
    expect(page).toContain('namespace: pay, pay-*');
    expect(page).toContain('Форма читает метку namespace');
    expect(page).toContain('Синтетические данные');
  });

  it('хранилищ нет: сообщение, в списке только база и вход', () => {
    const page = html(settings({ stores: [] }));
    expect(page).toContain('data-testid="stores-empty"');
    expect(page).not.toContain('data-testid="store-row"');
    expect(page).not.toContain('data-testid="stores-probe-all"');
    expect(page).toContain('data-testid="status-login"');
  });

  it('пояснение о настройке хранилищ — ссылкой на документацию, без слов файла настроек', () => {
    const page = html(settings());
    expect(page).toContain('href="/docs/admin-grafana"');
    expect(page).not.toContain('formScope');
  });
});

describe('роли', () => {
  it.each(['support', 'developer', 'analyst'] as const)('%s: проверка есть, настроек и пояснения о них нет', (role) => {
    const page = html(settings(), role);
    expect(page).toContain('data-testid="store-probe"');
    expect(page).not.toContain('data-testid="settings-page"');
    expect(page).not.toContain('data-testid="settings-form"');
  });
});

describe('где сбой', () => {
  const at = '2026-11-05T10:00:00Z';
  it.each([
    ['connected', 'ok'],
    ['demo', 'ok'],
    ['not-configured', 'ours'],
    ['unauthorized', 'ours'],
    ['forbidden', 'ours'],
    ['not-found', 'ours'],
    ['certificate', 'ours'],
    ['network', 'remote'],
    ['timeout', 'remote'],
    ['overloaded', 'remote'],
    ['limit', 'remote'],
  ] as const)('%s → %s', (status, side) => {
    expect(checkSide({ pending: false, data: { status, checkedAt: at }, error: null })).toBe(side);
  });

  it('идёт, не нажимали, сервер не ответил', () => {
    expect(checkSide({ pending: true, data: null, error: null })).toBeNull();
    expect(checkSide(undefined)).toBeNull();
    expect(checkSide({ pending: false, data: null, error: new Error('x') })).toBe('self');
  });
});
