// Память режима в браузере: один выбор человека на все проекты, как тема и язык. Записывается только при нажатии.
// Хранилище может быть запрещено: выбор живёт в памяти страницы до перезагрузки.
import { VIEW_MODES, type ViewMode } from '@threadline/core/view';
import { storage } from '@/lib/storage.ts';

export const VIEW_KEY = 'threadline.view';

let memory: ViewMode | null = null;
const listeners = new Set<() => void>();

const isMode = (v: unknown): v is ViewMode => typeof v === 'string' && (VIEW_MODES as readonly string[]).includes(v);

/** Выбор пользователя; null — не выбирал, действует режим проекта. Мусор и прежняя запись по проектам выбором не считаются. */
export function readChoice(): ViewMode | null {
  if (memory) return memory;
  const text = storage.get(VIEW_KEY);
  return isMode(text) ? text : null;
}

export function writeChoice(mode: ViewMode): void {
  if (readChoice() === mode) return;
  memory = storage.set(VIEW_KEY, mode) ? null : mode;
  for (const fn of listeners) fn();
}

const onStorage = (e: StorageEvent) => {
  // Другая вкладка сменила режим: запись браузера важнее, запасная память уже не нужна.
  if (e.key !== VIEW_KEY && e.key !== null) return;
  for (const fn of listeners) fn();
};

export function subscribeChoice(fn: () => void): () => void {
  if (listeners.size === 0 && typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0 && typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  };
}

/** Только для тестов: память модуля между случаями. */
export function resetChoiceMemory(): void {
  memory = null;
}
