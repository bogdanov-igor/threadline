import { describe, expect, it, vi } from 'vitest';
import { shellNavigation } from '../../vite.config.ts';
import { registerServiceWorker, type PwaEnv } from './pwa.ts';

// Поведение настоящего воркера в браузере: e2e/pwa.spec.ts.

function fakeContainer(waiting: { postMessage: (m: unknown) => void } | null, fail = false) {
  const register = vi.fn(async () => {
    if (fail) throw new Error('SecurityError');
    return { waiting } as unknown as ServiceWorkerRegistration;
  });
  return { register, container: { register } as unknown as ServiceWorkerContainer };
}

const env = (over: Partial<PwaEnv>): PwaEnv => ({ prod: true, container: undefined, online: () => true, ...over });

describe('регистрация воркера', () => {
  it('только в сборке: при разработке воркера нет', async () => {
    const { register, container } = fakeContainer(null);
    expect(await registerServiceWorker(env({ prod: false, container }))).toBeNull();
    expect(register).not.toHaveBeenCalled();
  });

  it('в сборке: /sw.js на весь адрес', async () => {
    const { register, container } = fakeContainer(null);
    expect(await registerServiceWorker(env({ container }))).not.toBeNull();
    expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
  });

  it('браузер без воркеров: ничего не делает', async () => {
    expect(await registerServiceWorker(env({ container: undefined }))).toBeNull();
  });

  it('ожидающая новая версия включается на следующей загрузке', async () => {
    const postMessage = vi.fn();
    const { container } = fakeContainer({ postMessage });
    await registerServiceWorker(env({ container }));
    expect(postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
  });

  it('без сети новая версия ждёт: страницу отдал кэш прежней, её файлы ей ещё нужны', async () => {
    const postMessage = vi.fn();
    const { container } = fakeContainer({ postMessage });
    await registerServiceWorker(env({ container, online: () => false }));
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('отказ регистрации не ломает страницу', async () => {
    const { container } = fakeContainer(null, true);
    expect(await registerServiceWorker(env({ container }))).toBeNull();
  });
});

describe('что обслуживает воркер, кроме файлов сборки', () => {
  const nav = (path: string, mode: RequestMode = 'navigate', sameOrigin = true) =>
    shellNavigation({ request: { mode } as Request, url: new URL(path, 'http://127.0.0.1:8080'), sameOrigin });

  it('переходы на страницы интерфейса, включая страницу ссылки', () => {
    for (const path of ['/', '/pay/demo', '/pay/demo/requests/abc', '/admin/status', '/docs/guide-search', '/s/abc123', '/apis', '/healthy-page']) {
      expect(nav(path), path).toBe(true);
    }
  });

  it('никогда: API, проверки здоровья, метрики', () => {
    for (const path of ['/api', '/api/health', '/api/s/abc', '/api/auth/login', '/api/auth/callback?code=1', '/health', '/health/readiness', '/health/liveness', '/metrics']) {
      expect(nav(path), path).toBe(false);
    }
  });

  it('никогда: запросы страницы и чужие адреса', () => {
    expect(nav('/pay/demo', 'cors')).toBe(false);
    expect(nav('/pay/demo', 'same-origin')).toBe(false);
    expect(nav('/pay/demo', 'navigate', false)).toBe(false);
  });

  it('текст функции самодостаточен: так она и работает внутри sw.js', () => {
    const copy = new Function(`return (${shellNavigation.toString()})`)() as typeof shellNavigation;
    expect(copy({ request: { mode: 'navigate' } as Request, url: new URL('http://h/api/x'), sameOrigin: true })).toBe(false);
    expect(copy({ request: { mode: 'navigate' } as Request, url: new URL('http://h/pay'), sameOrigin: true })).toBe(true);
  });
});
