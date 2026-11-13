// Страница настроек сервиса на разметке. Поведение в браузере проверяет сквозной тест share.spec.
import { capabilitiesOf, type Role } from '@threadline/core/access';
import type { ServiceSetting, ServiceSettingsResponse } from '@threadline/core/settings';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { AccessContext, accessOf } from '@/features/auth/access.tsx';
import SettingsPage, { fieldState } from './SettingsPage.tsx';
import { SettingsSection } from './slot.tsx';

const setting = (over: Partial<ServiceSetting> = {}) => ({ key: 'share.lifetimeDays', kind: 'int', min: 1, max: 400, default: 30, value: 30, updatedAt: null, invalidStored: false, ...over }) as ServiceSetting;

function html(data: ServiceSettingsResponse | null, role: Role = 'admin'): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  if (data) qc.setQueryData(['service-settings'], data);
  const router = createMemoryRouter([{ path: 'settings', element: data ? <SettingsPage /> : <SettingsSection scrollTo={false} /> }], { initialEntries: ['/settings'] });
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

describe('Страница настроек', () => {
  it('одна форма «Общие»: срок жизни, значение по умолчанию, одна «Сохранить» и «Отменить изменения»', () => {
    const s = html({ state: 'ok', editable: true, settings: [setting()] });
    expect(s).toContain('Общие');
    expect(s).toContain('Срок жизни короткой ссылки');
    expect(s).toContain('по умолчанию 30');
    expect((s.match(/data-testid="setting-save"/g) ?? []).length).toBe(1);
    expect(s).toContain('Отменить изменения');
    expect((s.match(/data-testid="setting-/g) ?? []).length).toBeGreaterThan(0);
  });

  it('значение не по умолчанию: «по умолчанию 30» возвращает его, подпись для чтения с экрана называет действие', () => {
    const s = html({ state: 'ok', editable: true, settings: [setting({ value: 14, updatedAt: 't' })] });
    expect(s).toContain('data-testid="setting-reset"');
    expect(s).toContain('Вернуть стандартное: 30');
  });

  it('запись не разобралась: страница называет это', () => {
    expect(html({ state: 'ok', editable: true, settings: [setting({ invalidStored: true })] })).toContain('не прошла проверку');
  });

  it('базы нет: значения только для чтения, названа переменная, кнопок правки нет', () => {
    const s = html({ state: 'off', editable: false, settings: [setting()] });
    expect(s).toContain('THREADLINE_DATABASE_URL');
    expect(s).not.toContain('data-testid="setting-save"');
    expect(s).toContain('disabled=""');
  });

  it('база пропала: причина без адресов, правка закрыта', () => {
    const s = html({ state: 'stale', editable: false, settings: [setting({ value: 7 })] });
    expect(s).toContain('База недоступна');
    expect(s).toContain('value="7"');
  });

  it.each(['business', 'support', 'developer', 'analyst'] as const)('%s: раздел недоступен, запросов настроек нет', (role) => {
    const s = html(null, role);
    expect(s).not.toContain('Срок жизни');
  });
});

describe('Проверка поля', () => {
  const s = setting({ value: 30 });

  it.each([['0'], ['401'], ['1.5'], ['abc'], ['']])('«%s» не сохраняется', (text) => {
    expect(fieldState(s, text).valid).toBe(false);
  });

  it('уменьшение предупреждает, увеличение нет', () => {
    expect(fieldState(s, '7')).toMatchObject({ valid: true, dirty: true, shorten: true, next: 7 });
    expect(fieldState(s, '90')).toMatchObject({ valid: true, dirty: true, shorten: false, next: 90 });
    expect(fieldState(s, '30')).toMatchObject({ dirty: false });
  });

  it('вернуть стандартное: запись удаляется, предупреждение при меньшем значении', () => {
    expect(fieldState(setting({ value: 90, updatedAt: 't' }), null)).toEqual({ dirty: true, valid: true, next: null, shorten: true });
    expect(fieldState(setting({ value: 7, updatedAt: 't' }), null)).toEqual({ dirty: true, valid: true, next: null, shorten: false });
    expect(fieldState(setting(), null).dirty).toBe(false);
  });
});

describe('Настройки контакта поддержки', () => {
  const text = setting({ key: 'support.contactText', kind: 'text', maxLength: 200, default: '', value: '' } as Partial<ServiceSetting>);
  const url = setting({ key: 'support.contactUrl', kind: 'text', maxLength: 500, https: true, default: '', value: '' } as Partial<ServiceSetting>);

  it('поля текста: подпись и подсказка, значения по умолчанию нет', () => {
    const s = html({ state: 'ok', editable: true, settings: [setting(), text, url] });
    expect(s).toContain('Контакт поддержки');
    expect(s).toContain('Ссылка на контакт');
    expect(s).toContain('до 200 символов');
    expect((s.match(/по умолчанию/g) ?? []).length).toBe(1);
  });

  it('текст: длина и одна строка', () => {
    expect(fieldState(text, 'Дежурная смена')).toEqual({ dirty: true, valid: true, next: 'Дежурная смена', shorten: false });
    expect(fieldState(text, 'x'.repeat(201)).valid).toBe(false);
    expect(fieldState(text, 'x'.repeat(200)).valid).toBe(true);
    expect(fieldState(text, 'a\nb').valid).toBe(false);
  });

  it('пустое поле: запись удаляется, пустого значения в базе нет', () => {
    expect(fieldState({ ...text, value: 'было', updatedAt: 't' }, '  ')).toEqual({ dirty: true, valid: true, next: null, shorten: false });
    expect(fieldState(text, '').dirty).toBe(false);
    expect(fieldState({ ...text, value: 'было', updatedAt: 't' }, null)).toMatchObject({ dirty: true, next: null });
  });

  it.each(['http://x.example', 'javascript:alert(1)', '//x.example', 'https://u:p@x.example'])('ссылка %s не сохраняется', (value) => {
    expect(fieldState(url, value).valid).toBe(false);
  });

  it('ссылка https проходит', () => {
    expect(fieldState(url, 'https://x.example/ask')).toMatchObject({ valid: true, next: 'https://x.example/ask' });
  });
});
