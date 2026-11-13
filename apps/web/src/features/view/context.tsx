// Режим и настройка вида: фильтр при рендере поверх уже полученных данных, запросов не добавляет.
import type { ProjectInfo } from '@threadline/core';
import { DEFAULT_VIEW, type ViewMode, type ViewSettings } from '@threadline/core/view';
import { createContext, useCallback, useContext, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useAccess } from '@/features/auth/access.tsx';
import { readChoice, subscribeChoice, writeChoice } from './store.ts';

export type { ViewMode as DetailMode } from '@threadline/core/view';

export interface ViewState {
  mode: ViewMode;
  view: ViewSettings;
  setMode: (mode: ViewMode) => void;
  /** Режим закреплён ролью: у Бизнеса всегда «Кратко», переключателя и переходов в «Подробно» нет. */
  locked: boolean;
}

const OUTSIDE: ViewState = { mode: 'full', view: DEFAULT_VIEW, setMode: () => undefined, locked: false };
const ViewContext = createContext<ViewState | null>(null);

/** Вне провайдера (страницы проектов, справочник, модульные тесты) — «Подробно» и встроенная настройка. */
export function useView(): ViewState {
  return useContext(ViewContext) ?? OUTSIDE;
}

/**
 * Выбор человека (один на все проекты) важнее режима проекта. Заготовки ответов без поля view получают встроенные значения.
 * Без проекта значение null: страницы вне проекта видят «Подробно». Разметка одна и та же с проектом и без: провайдер стоит и над шапкой,
 * и смена проекта или приход списка проектов не пересоздаёт её.
 */
export function ViewProvider({ project, children }: { project: ProjectInfo | null; children: ReactNode }) {
  const view = project?.view ?? DEFAULT_VIEW;
  // Бизнесу всегда «Кратко»: выбор браузера не читается и не пишется.
  const fixed = !useAccess().can('details');
  const snapshot = () => (fixed ? null : readChoice());
  const choice = useSyncExternalStore(subscribeChoice, snapshot, snapshot);
  const setMode = useCallback((mode: ViewMode) => {
    if (!fixed) writeChoice(mode);
  }, [fixed]);
  const mode = fixed ? 'brief' : (choice ?? view.defaultMode);
  const value = useMemo(() => (project ? { mode, view, setMode, locked: fixed } : null), [project, mode, view, setMode, fixed]);
  return <ViewContext.Provider value={value}>{children}</ViewContext.Provider>;
}

/** Страница ссылки: начальный режим из настройки проекта, выбор живёт до ухода со страницы и в браузер не пишется. Роль не действует. */
export function LocalViewProvider({ view, children }: { view: ViewSettings; children: ReactNode }) {
  const [mode, setMode] = useState<ViewMode>(view.defaultMode);
  const value = useMemo(() => ({ mode, view, setMode, locked: false }), [mode, view]);
  return <ViewContext.Provider value={value}>{children}</ViewContext.Provider>;
}

/**
 * Переключатель режима в меню профиля: на странице проекта действующий режим этого проекта, вне проекта — выбор человека или «Подробно».
 * Бизнесу переключателя нет: режим закреплён ролью.
 */
export function useModeSwitch(): Pick<ViewState, 'mode' | 'setMode' | 'locked'> {
  const ctx = useContext(ViewContext);
  const fixed = !useAccess().can('details');
  const choice = useSyncExternalStore(subscribeChoice, readChoice, readChoice);
  const setGlobal = useCallback((mode: ViewMode) => {
    if (!fixed) writeChoice(mode);
  }, [fixed]);
  if (ctx) return { mode: ctx.mode, setMode: ctx.setMode, locked: ctx.locked };
  return { mode: fixed ? 'brief' : (choice ?? DEFAULT_VIEW.defaultMode), setMode: setGlobal, locked: fixed };
}
