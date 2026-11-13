// Ленивая загрузка чанка графа. Загрузка держится в переменной модуля и сбрасывается при ошибке:
// «Повторить» действительно идёт в сеть. Страница запроса начинает загрузку при монтировании, вместе с данными.
import { readingStrings } from '@/i18n/bundles.ts';

type FlowModule = typeof import('./canvas/FlowGraph.tsx');

let flowImport: Promise<FlowModule> | null = null;

const RELOADED = 'threadline.flow.reloaded';

// Флаг одной перезагрузки — в sessionStorage; хранилище может быть запрещено, каждое обращение в try/catch.
const session = {
  get(): string | null {
    try {
      return window.sessionStorage.getItem(RELOADED);
    } catch {
      return null;
    }
  },
  set(): boolean {
    try {
      window.sessionStorage.setItem(RELOADED, '1');
      return true;
    } catch {
      return false;
    }
  },
  clear(): void {
    try {
      window.sessionStorage.removeItem(RELOADED);
    } catch {
      // Хранилища нет — и флага нет.
    }
  },
};

export function loadFlow(): Promise<FlowModule> {
  flowImport ??= import('./canvas/FlowGraph.tsx').then(
    (m) => {
      session.clear();
      return m;
    },
    (e: unknown) => {
      flowImport = null;
      throw e;
    },
  );
  return flowImport;
}

/** Загрузка заранее: ошибку покажет сам граф, здесь её глотаем. */
export function preloadFlow(): void {
  loadFlow().catch(() => undefined);
}

// Новая выкладка: старый хеш чанка отвечает 404. Страница перезагружается один раз; без хранилища — не
// перезагружается, остаётся «Повторить». Сбой файла строк перезагрузки не вызывает: язык остаётся прежним, поиск не теряется.
if (typeof window !== 'undefined') {
  window.addEventListener('vite:preloadError', (event) => {
    if (readingStrings() || session.get() !== null || !session.set()) return;
    event.preventDefault();
    window.location.reload();
  });
}
