// Держит большое окно кода выше панели шага: смена шага и вкладки не закрывает окно и не меняет его. Сам код окна в ленивом чанке.
import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type ComponentType, type ReactNode } from 'react';
import { CodeModeContext, type CodeChoice } from './CodeView.tsx';
import { CodeWindowContext, type CodeWindowApi, type WindowBlock, type WindowTarget } from './code-window.ts';

interface CodeWindowProps {
  block: WindowBlock;
  nonce: number;
  initial: CodeChoice;
  onBack: (() => void) | null;
  onClose: () => void;
}

// Сбой загрузки чанка: окна нет, страница работает дальше.
const CodeWindow = lazy((): Promise<{ default: ComponentType<CodeWindowProps> }> => import('./CodeWindow.tsx').catch(() => ({ default: () => null })));

interface Opened {
  target: WindowTarget;
  opener: HTMLElement | null;
  choice: CodeChoice;
  /** Повторное открытие снова ставит фокус в окно. */
  nonce: number;
}

export function CodeWindowScope({ resolve, back = null, children }: { resolve: (target: WindowTarget) => WindowBlock | null; /** Страница с панелью шага: какой шаг выбран и как вернуться к шагу окна. */ back?: { current: string | null; go: (target: WindowTarget) => void } | null; children: ReactNode }) {
  const [opened, setOpened] = useState<Opened | null>(null);
  const api = useMemo<CodeWindowApi>(() => ({ open: (target, opener, choice) => setOpened((prev) => ({ target, opener, choice, nonce: (prev?.nonce ?? 0) + 1 })) }), []);
  const block = useMemo(() => (opened ? resolve(opened.target) : null), [opened, resolve]);
  const close = useCallback(() => {
    if (opened) returnFocus(opened);
    setOpened(null);
  }, [opened]);
  // Блока больше нет: режим или роль его скрыли, записи обновились без него. Окно закрывается само, фокус не уводится от того, что человек нажал.
  const gone = opened !== null && block === null;
  useEffect(() => {
    if (!gone) return;
    if (document.activeElement === document.body) returnFocus(opened);
    setOpened(null);
  }, [gone, opened]);
  const target = opened?.target;
  const away = !!back && !!target && target.step !== null && target.step !== back.current;
  const onBack = useMemo(() => (away ? () => back.go(target) : null), [away, back, target]);
  return (
    <CodeWindowContext.Provider value={api}>
      {children}
      {opened && block && (
        // Вид и перенос принадлежат окну: панель и окно их не делят.
        <CodeModeContext.Provider value={null}>
          <Suspense fallback={null}>
            <CodeWindow block={block} nonce={opened.nonce} initial={opened.choice} onBack={onBack} onClose={close} />
          </Suspense>
        </CodeModeContext.Provider>
      )}
    </CodeWindowContext.Provider>
  );
}

/** Кнопка могла исчезнуть вместе со шагом: тогда такая же кнопка другого шага, иначе панель. Панель свёрнута: скрытому фокус не поставить, он идёт на кнопку, которая её открывает. */
function returnFocus({ opener, target }: Opened): void {
  const panel = document.getElementById('step-details');
  const same = panel?.querySelector<HTMLElement>(`[data-block="${CSS.escape(target.name)}"] [data-testid="code-window-open"]`);
  const want = opener?.isConnected ? opener : (same ?? panel);
  want?.focus({ preventScroll: true });
  if (document.activeElement !== want) document.querySelector<HTMLElement>('[data-testid="panel-open"]')?.focus({ preventScroll: true });
}
