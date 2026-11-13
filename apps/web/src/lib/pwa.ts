// Устанавливаемое приложение: воркер из сборки (vite.config.ts, VitePWA) держит в кэше только файлы интерфейса, данные идут мимо него.
// Регистрация только в сборке: при разработке воркера нет и кэш не мешает правкам.

const SW_URL = '/sw.js';

export interface PwaEnv {
  prod: boolean;
  container: ServiceWorkerContainer | undefined;
  online: () => boolean;
}

const browserEnv = (): PwaEnv => ({
  prod: import.meta.env.PROD,
  container: typeof navigator === 'undefined' ? undefined : navigator.serviceWorker,
  online: () => navigator.onLine,
});

/**
 * Регистрирует воркер после загрузки страницы, чтобы его кэш не спорил за сеть с первым показом.
 * Новая версия воркера скачивается в фоне и ждёт: открытая страница доживает на своих файлах. На следующей загрузке страница уже новая
 * (разметку всегда отдаёт сервер), и ожидающий воркер включается сразу, не дожидаясь закрытия всех вкладок.
 * Без сети страницу отдал кэш прежней версии: её файлы ей ещё нужны, поэтому воркер ждёт загрузки со связью.
 */
export async function registerServiceWorker(env: PwaEnv = browserEnv()): Promise<ServiceWorkerRegistration | null> {
  if (!env.prod || !env.container) return null;
  try {
    const reg = await env.container.register(SW_URL, { scope: '/' });
    if (env.online()) reg.waiting?.postMessage({ type: 'SKIP_WAITING' });
    return reg;
  } catch {
    // Без воркера интерфейс работает как обычный сайт: например, на http не с localhost браузер воркер не принимает.
    return null;
  }
}

/** Из main.tsx: регистрация после события load. */
export function registerServiceWorkerOnLoad(): void {
  if (!import.meta.env.PROD) return;
  const run = () => void registerServiceWorker();
  if (document.readyState === 'complete') run();
  else window.addEventListener('load', run, { once: true });
}
