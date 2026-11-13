// Развилки проверки входа: что показать, цикл переходов, адрес возврата, экраны без текста сервиса входа.
import type { AuthMe } from '@threadline/core/access';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import i18n from '@/i18n/index.ts';
import ru from './ru.json';
import { accessOf } from './access.tsx';
import { gateView, publicScreen } from './AuthGate.tsx';
import { AuthScreen, errorReason, initialsOf } from './screens.tsx';
import { isLoop, loginUrl, LOOP_MS, LOOP_PARAM, returnAddress } from './session.ts';

i18n.addResourceBundle('ru', 'translation', { auth: ru }, true, true);

const me = (over: Partial<AuthMe> = {}): AuthMe => ({ mode: 'on', user: { name: 'Тест' }, role: 'support', capabilities: ['view', 'details'], ...over });

describe('инициалы меню пользователя', () => {
  it.each([
    ['Игорь Богданов', 'ИБ'],
    ['Игорь', 'И'],
    ['  тест   аналитик  третий ', 'ТА'],
    ['oʻktam Rahimov', 'OR'],
    ['', null],
    ['   ', null],
    [null, null],
  ])('%s → %s', (name, initials) => {
    expect(initialsOf(name)).toBe(initials);
  });
});

describe('что показать', () => {
  it.each([
    ['нет ответа', { data: undefined, unauthenticated: false, failed: false }, 'none', 'wait'],
    ['401: уже ушли на вход', { data: undefined, unauthenticated: true, failed: true }, 'none', 'wait'],
    ['сервер недоступен: страница со своим сообщением', { data: undefined, unauthenticated: false, failed: true }, 'none', 'app'],
    ['роль есть', { data: me(), unauthenticated: false, failed: false }, 'none', 'app'],
    ['роли нет', { data: me({ role: null, capabilities: [] }), unauthenticated: false, failed: false }, 'none', 'no-access'],
    ['истекла при несохранённой форме: страница на месте', { data: me(), unauthenticated: true, failed: true }, 'expired', 'app'],
    ['браузер не сохранил сессию', { data: undefined, unauthenticated: true, failed: true }, 'lost', 'lost'],
  ] as const)('%s', (_n, state, problem, kind) => {
    expect(gateView(state, problem).kind).toBe(kind);
  });

  it('роль не проверяется только на экранах без сессии', () => {
    expect(['/auth-error', '/logged-out', '/auth-done'].map(publicScreen)).toEqual(['auth-error', 'logged-out', 'auth-done']);
    for (const p of ['/', '/docs', '/about', '/credits', '/projects', '/pay/demo', '/constructor']) expect(publicScreen(p)).toBeNull();
  });

  it('права берутся из ответа сервера', () => {
    const a = accessOf(me());
    expect(a.can('details')).toBe(true);
    expect(a.can('editCatalog')).toBe(false);
  });
});

describe('вход и цикл переходов', () => {
  const at = { pathname: '/pay/demo/requests/a', search: '?from=1&to=2', hash: '#step' };

  it('адрес возврата с запросом и якорем', () => {
    expect(returnAddress(at, true)).toBe('/pay/demo/requests/a?from=1&to=2#step');
    expect(decodeURIComponent(loginUrl(returnAddress(at, true)))).toContain('returnTo=/pay/demo/requests/a?from=1&to=2#step');
  });

  it('без хранилища браузера отметка едет в адресе', () => {
    const back = returnAddress(at, false);
    expect(back).toContain(`${LOOP_PARAM}=1`);
    expect(back.endsWith('#step')).toBe(true);
    const u = new URL(back, 'http://x');
    expect(isLoop({ pathname: u.pathname, search: u.search, hash: u.hash }, null, 1000)).toBe(true);
  });

  it('повтор 401 быстрее 10 секунд считается циклом, позже нет', () => {
    expect(isLoop(at, 1000, 1000 + LOOP_MS - 1)).toBe(true);
    expect(isLoop(at, 1000, 1000 + LOOP_MS)).toBe(false);
    expect(isLoop(at, null, 1000)).toBe(false);
  });
});

describe('экраны', () => {
  const html = (screen: Parameters<typeof AuthScreen>[0]['screen'], search = '', name: string | null = null) => renderToStaticMarkup(<AuthScreen screen={screen} search={search} name={name} />);

  it.each(['denied', 'unavailable', 'config', 'clock', 'state'] as const)('причина %s своими словами', (reason) => {
    const text = html('auth-error', `?reason=${reason}`);
    expect(text).toContain(ru.error[reason]);
    expect(text).toContain(ru.error.retry);
  });

  it('посторонняя причина и текст в адресе на экран не попадают', () => {
    expect(errorReason('?reason=<b>evil</b>')).toBeNull();
    const text = html('auth-error', '?reason=evil&error_description=keycloak-text');
    expect(text).toContain(ru.error.unknown);
    expect(text).not.toContain('keycloak-text');
    expect(text).not.toContain('evil');
  });

  it('«Вы вышли»: без недоступного сервиса входа и с ним, сам вход не запускается', () => {
    expect(html('logged-out')).not.toContain(ru.loggedOut.providerUnreachable);
    const text = html('logged-out', '?provider=unreachable');
    expect(text).toContain(ru.loggedOut.providerUnreachable);
    expect(text).toContain('/api/auth/login');
  });

  it('«Нет доступа»: кто вошёл и кнопка выхода', () => {
    const text = html('no-access', '', 'Тест Без Роли');
    expect(text).toContain(ru.noAccess.title);
    expect(text).toContain('Тест Без Роли');
    expect(text).toContain('auth-logout');
  });

  it('несохранённая сессия: цикла нет, повтор по кнопке', () => {
    expect(html('lost')).toContain(ru.lost.retry);
  });
});
