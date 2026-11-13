// Слушатель горячих клавиш в корне приложения, окно со списком в ленивом чанке: грузится при первом открытии. Страница ссылки тоже здесь: она вне Layout.
import { lazy, Suspense, useEffect, useRef, useState, type ComponentType } from 'react';
import { loadBundle } from '@/i18n/bundles.ts';
import { registerHotkey, useHotkeysListener } from '@/lib/hotkeys.ts';

export interface KeysDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocus: HTMLElement | null;
}

// Сбой загрузки: окна нет, страница на месте.
const Dialog = lazy(
  (): Promise<{ default: ComponentType<KeysDialogProps> }> =>
    loadBundle('keys')
      .then(() => import('./KeysDialog.tsx'))
      .catch(() => ({ default: () => null })),
);

export function KeysRoot() {
  useHotkeysListener();
  const [open, setOpen] = useState(false);
  const [everOpened, setEverOpened] = useState(false);
  const from = useRef<HTMLElement | null>(null);
  useEffect(
    () =>
      registerHotkey('help', (target) => {
        from.current = target ?? null;
        setEverOpened(true);
        setOpen(true);
      }),
    [],
  );
  if (!everOpened) return null;
  return (
    <Suspense fallback={null}>
      <Dialog open={open} onOpenChange={setOpen} returnFocus={from.current} />
    </Suspense>
  );
}
