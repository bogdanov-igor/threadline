// Поставщик над содержимым зоны «Проект»: содержимое снимается, когда данные сброшены или недоступны,
// а AuthGate при смене роли делает removeQueries. Текст, защита ухода и отметка несохранённого ввода живут здесь, вне кэша запросов.
// Код редактора сюда не идёт: контроллер создаёт ленивая страница, здесь только ссылка на него.
import { Download } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useBlocker } from 'react-router';
import { Button } from '@/components/ui/button.tsx';
import { useUnsavedInput } from '@/features/auth/session.ts';
import { Notice } from '@/features/catalog/ui.tsx';
import { saveText } from './download.ts';

export interface FileSessionController {
  subscribe(fn: () => void): () => void;
  getSnapshot(): { dirty: boolean };
  text(): string;
  fileName(): string;
  readonly format: 'yaml' | 'json';
  dispose(): void;
}

export interface FileSession {
  controller<C extends FileSessionController>(create: () => C): C;
  /** Страница снята: контроллер без правок больше не нужен, следующий заход читает свежий файл. */
  pageGone(): void;
  pageShown(): void;
}

const Context = createContext<FileSession | null>(null);

export const useFileSession = (): FileSession | null => useContext(Context);

/** Один блокировщик на роутер: на страницах форм свой, поэтому этот стоит, только пока есть правки. */
function LeaveGuard({ onLeave }: { onLeave: () => void }) {
  const { t } = useTranslation();
  // Без отметки любой 401, даже у фонового опроса, увёл бы на вход и текст пропал бы.
  useUnsavedInput(true);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => currentLocation.pathname !== nextLocation.pathname);
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    if (window.confirm(t('catalog.fileDraft.leave'))) {
      blocker.proceed();
      onLeave();
    } else blocker.reset();
  }, [blocker, onLeave, t]);
  useEffect(() => {
    const before = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', before);
    return () => window.removeEventListener('beforeunload', before);
  }, []);
  return null;
}

export function ProjectFileProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const current = useRef<FileSessionController | null>(null);
  const unsubscribe = useRef<(() => void) | null>(null);
  const shown = useRef(false);
  const [dirty, setDirty] = useState(false);
  const [mounted, setMounted] = useState(false);

  const drop = useCallback(() => {
    unsubscribe.current?.();
    unsubscribe.current = null;
    current.current?.dispose();
    current.current = null;
    setDirty(false);
  }, []);

  const session = useMemo<FileSession>(
    () => ({
      controller<C extends FileSessionController>(create: () => C): C {
        if (current.current) return current.current as C;
        const c = create();
        current.current = c;
        unsubscribe.current = c.subscribe(() => setDirty(c.getSnapshot().dirty));
        return c;
      },
      pageShown() {
        shown.current = true;
        setMounted(true);
      },
      pageGone() {
        shown.current = false;
        setMounted(false);
        // Снятие и возврат одного кадра (смена ключа Suspense) решает следующий кадр: страница успеет показаться снова.
        queueMicrotask(() => {
          if (!shown.current && current.current && !current.current.getSnapshot().dirty) drop();
        });
      },
    }),
    [drop],
  );

  // Зона ушла совсем (другой проект, другой раздел): согласие на уход уже получено. Проверка кадром позже: StrictMode снимает и ставит эффекты подряд.
  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      queueMicrotask(() => {
        if (!alive.current) drop();
      });
    };
  }, [drop]);

  const c = current.current;
  return (
    <Context.Provider value={session}>
      {dirty && <LeaveGuard onLeave={drop} />}
      {dirty && !mounted && c && (
        <div className="px-[var(--page-gutter)] pt-4">
          <Notice
            tone="warning"
            testId="file-draft-kept"
            actions={
              <Button size="sm" variant="secondary" onClick={() => saveText(c.fileName(), c.text(), c.format)}>
                <Download aria-hidden />
                {t('catalog.fileDraft.download')}
              </Button>
            }
          >
            {t('catalog.fileDraft.kept')}
          </Notice>
        </div>
      )}
      {children}
    </Context.Provider>
  );
}
