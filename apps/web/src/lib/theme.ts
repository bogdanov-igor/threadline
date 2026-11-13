import { useEffect, useSyncExternalStore } from 'react';
import { storage } from './storage.ts';

export type ThemeChoice = 'light' | 'dark' | 'system';

const KEY = 'threadline.theme';
const media = () => window.matchMedia('(prefers-color-scheme: dark)');

export function readTheme(): ThemeChoice {
  const v = storage.get(KEY);
  return v === 'light' || v === 'dark' ? v : 'system';
}

export function applyTheme(choice: ThemeChoice): void {
  const dark = choice === 'dark' || (choice === 'system' && media().matches);
  const root = document.documentElement;
  root.classList.toggle('dark', dark);
  root.style.colorScheme = dark ? 'dark' : 'light';
  // Заголовок окна установленного приложения в цвет фона темы, а не системы.
  const background = getComputedStyle(root).getPropertyValue('--background').trim();
  if (background) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', background);
}

// Выбор один на вкладку: меню пользователя открывается и закрывается, а тема и слежение за системой живут дальше.
let current: ThemeChoice | null = null;
const listeners = new Set<() => void>();
const choice = () => (current ??= readTheme());

/** В корне приложения: выбор «как в системе» идёт за системой без перезагрузки на любой странице. */
export function useThemeWatch(): void {
  useEffect(() => {
    applyTheme(choice());
    const m = media();
    const onChange = () => {
      if (choice() === 'system') applyTheme('system');
    };
    m.addEventListener('change', onChange);
    return () => m.removeEventListener('change', onChange);
  }, []);
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Если хранилище браузера запрещено, выбор живёт до закрытия вкладки. */
function setTheme(t: ThemeChoice): void {
  storage.set(KEY, t);
  current = t;
  applyTheme(t);
  for (const listener of listeners) listener();
}

export function useTheme(): [ThemeChoice, (t: ThemeChoice) => void] {
  return [useSyncExternalStore(subscribe, choice, choice), setTheme];
}
