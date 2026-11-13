import { describe, expect, it } from 'vitest';
import { clampPanel, panelMax, parsePanel, PANEL_DEFAULT } from './step-panel.ts';

describe('панель шага: что запоминается', () => {
  it.each([['нет значения', null], ['не json', '{'], ['не число', '{"width":"a"}'], ['меньше наименьшего', '{"width":100}'], ['бесконечность', '{"width":1e999}']])('%s: обычная ширина', (_name, raw) => {
    expect(parsePanel(raw)).toEqual({ width: PANEL_DEFAULT, collapsed: false });
  });

  it('ширина и свёрнутость читаются; большее окна значение остаётся в памяти как есть', () => {
    expect(parsePanel('{"width":960,"collapsed":true}')).toEqual({ width: 960, collapsed: true });
    expect(parsePanel('{"collapsed":"да"}').collapsed).toBe(false);
  });

  it('действующая ширина: от 380 до половины окна', () => {
    expect(panelMax(1440)).toBe(720);
    expect(clampPanel(960, 1280)).toBe(640);
    expect(clampPanel(100, 1280)).toBe(380);
    expect(clampPanel(500, 1280)).toBe(500);
  });
});
