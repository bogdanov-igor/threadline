import { createContext, useContext, useRef, type ReactNode } from 'react';
import type { PeriodChoice, TermChip } from './model.ts';
import { NO_FILTERS, type RowFilters } from './result-filters.ts';

// Значения поиска живут только в памяти этой вкладки: не в адресе и не в хранилище браузера.
// Сессия переживает переход на страницу запроса и обратно, но не перезагрузку.

export interface PanelSnapshot {
  chips: TermChip[];
  excludes: TermChip[];
  period: PeriodChoice;
}

/** Черновик ещё и с недописанным значением: оно переживает смену среды, но не снимок поиска. */
export interface DraftSnapshot extends PanelSnapshot {
  text: string;
  excludeText: string;
}

type FocusTarget = 'env' | 'stand';

export interface ResultsUi {
  tab: 'requests' | 'lines';
  /** Вкладку выбрал пользователь: сами её больше не переключаем. */
  tabChosen: boolean;
  onlyErrors: boolean;
  cached: boolean;
  /** Фильтры списка: живут, пока жив этот поиск. В ссылку и браузер не идут. */
  filters: RowFilters;
  /** Прокрутка таблицы в рабочем режиме: возврат со страницы запроса приходит на то же место. */
  scrollTop?: number;
  /** Прокрутка страницы с этим списком: ей владеет сам список, см. SearchResults. */
  pageY?: number;
  /** Строка, открытая последней: к ней возвращаются со страницы запроса. Нет поля — в этой вкладке строки этого списка не открывали, переходить на странице запроса не по чему. */
  openedCid?: string;
}

export const DEFAULT_UI: ResultsUi = { tab: 'requests', tabChosen: false, onlyErrors: false, cached: false, filters: NO_FILTERS };

interface SearchSession {
  panel(id: string): PanelSnapshot | undefined;
  savePanel(id: string, p: PanelSnapshot): void;
  draft(): DraftSnapshot | undefined;
  saveDraft(p: DraftSnapshot): void;
  /** Страница пересоздаётся при смене среды: новый выбор забирает фокус. Только память: перезагрузка фокус заново не ставит. */
  focusAfterChange(target: FocusTarget): void;
  takeFocus(target: FocusTarget): boolean;
  ui(id: string): ResultsUi;
  saveUi(id: string, ui: Partial<ResultsUi>): void;
}

const Ctx = createContext<SearchSession | null>(null);

// Хватает на долгую смену дежурного; старые поиски вытесняются.
const LIMIT = 50;

function remember<V>(map: Map<string, V>, key: string, value: V) {
  map.delete(key);
  map.set(key, value);
  if (map.size > LIMIT) map.delete(map.keys().next().value!);
}

export function SearchSessionProvider({ children }: { children: ReactNode }) {
  const ref = useRef<SearchSession | null>(null);
  if (!ref.current) {
    const panels = new Map<string, PanelSnapshot>();
    const uis = new Map<string, ResultsUi>();
    let draft: DraftSnapshot | undefined;
    let focus: FocusTarget | null = null;
    ref.current = {
      panel: (id) => panels.get(id),
      savePanel: (id, p) => remember(panels, id, p),
      draft: () => draft,
      saveDraft: (p) => {
        draft = p;
      },
      focusAfterChange: (target) => {
        focus = target;
      },
      takeFocus: (target) => {
        if (focus !== target) return false;
        focus = null;
        return true;
      },
      ui: (id) => uis.get(id) ?? DEFAULT_UI,
      saveUi: (id, ui) => remember(uis, id, { ...(uis.get(id) ?? DEFAULT_UI), ...ui }),
    };
  }
  return <Ctx.Provider value={ref.current}>{children}</Ctx.Provider>;
}

export function useSearchSession(): SearchSession {
  const s = useContext(Ctx);
  if (!s) throw new Error('SearchSessionProvider отсутствует');
  return s;
}
