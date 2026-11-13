// Условие ширины окна для разметки, которую CSS не переставит: одна и та же кнопка в строке или в меню «⋯», без двойников в документе.
import { useSyncExternalStore } from 'react';

/** Ширина, с которой страница запроса стоит в две колонки и действия шапки помещаются в строку. */
export const WIDE = '(min-width: 1280px)';

export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window === 'undefined' || !window.matchMedia) return () => undefined;
      const m = window.matchMedia(query);
      m.addEventListener('change', onChange);
      return () => m.removeEventListener('change', onChange);
    },
    () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : true),
    () => true,
  );
}
