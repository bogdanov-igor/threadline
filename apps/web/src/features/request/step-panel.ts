// Панель шага от 1280 шириной: ширина и свёрнутость запоминаются в браузере. Сужение окна сохранённое значение не трогает.
// В панели только сводка шага, тела открываются в большом окне: обычная ширина 400 px.
import { useCallback, useEffect, useState } from 'react';
import { storage } from '@/lib/storage.ts';

const KEY = 'threadline.stepPanel';
export const PANEL_DEFAULT = 400;
export const PANEL_MIN = 380;

/** Панель справа, ширина по переменной и не шире половины окна. Сужение окна считает сам браузер, в память это не идёт. */
export const PANEL_WIDTH = 'xl:w-[clamp(380px,var(--step-panel-w,400px),50vw)] xl:shrink-0';

export interface PanelState {
  width: number;
  collapsed: boolean;
}

export const panelMax = (windowWidth: number): number => Math.max(PANEL_MIN, Math.floor(windowWidth / 2));
export const clampPanel = (width: number, windowWidth: number): number => Math.min(panelMax(windowWidth), Math.max(PANEL_MIN, Math.round(width)));

export function parsePanel(raw: string | null): PanelState {
  try {
    const v = JSON.parse(raw ?? 'null') as Partial<PanelState> | null;
    const width = typeof v?.width === 'number' && Number.isFinite(v.width) && v.width >= PANEL_MIN ? Math.round(v.width) : PANEL_DEFAULT;
    return { width, collapsed: v?.collapsed === true };
  } catch {
    return { width: PANEL_DEFAULT, collapsed: false };
  }
}

export const readPanel = (): PanelState => parsePanel(storage.get(KEY));

const innerWidth = () => (typeof window === 'undefined' ? 1440 : window.innerWidth);

export function useStepPanel() {
  const [panel, setPanel] = useState(readPanel);
  const [windowWidth, setWindowWidth] = useState(innerWidth);
  useEffect(() => {
    const onResize = () => setWindowWidth(innerWidth());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const update = useCallback((patch: Partial<PanelState>) => {
    setPanel((prev) => {
      const next = { ...prev, ...patch };
      if (next.width === prev.width && next.collapsed === prev.collapsed) return prev;
      storage.set(KEY, JSON.stringify(next));
      return next;
    });
  }, []);
  return {
    saved: panel.width,
    /** Ширина с учётом окна: её читает разделитель, сохранённое значение остаётся прежним. */
    width: clampPanel(panel.width, windowWidth),
    max: panelMax(windowWidth),
    collapsed: panel.collapsed,
    update,
  };
}
