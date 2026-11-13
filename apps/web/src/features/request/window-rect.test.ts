import { describe, expect, it } from 'vitest';
import { defaultRect, fits, MIN_WINDOW, moveRect, parseRect, resizeRect } from './window-rect.ts';

const V = { width: 1440, height: 900 };
const R = { x: 100, y: 100, width: 800, height: 500 };

describe('окно кода: положение и размер', () => {
  it('обычное положение: около 60 % ширины и 70 % высоты, слева, панель шага свободна; на 768 помещается', () => {
    // Сверху остаётся строка действий запроса.
    expect(defaultRect(V)).toEqual({ x: 16, y: 104, width: 864, height: 630 });
    // Панель шага обычной ширины (400) стоит справа от схемы и от 1280 окно её не закрывает.
    expect(defaultRect({ width: 1280, height: 720 })).toEqual({ x: 16, y: 104, width: 768, height: 504 });
    for (const width of [1280, 1366, 1440, 1920, 2560]) {
      const r = defaultRect({ width, height: 900 });
      expect(r.x + r.width, String(width)).toBeLessThanOrEqual(width - 400);
    }
    const small = { width: 768, height: 600 };
    expect(fits(defaultRect(small), small)).toBe(true);
    expect(defaultRect({ width: 500, height: 340 }).width).toBe(MIN_WINDOW.width);
  });

  it.each([
    ['не json', 'нет'],
    ['пусто', null],
    ['null', 'null'],
    ['не числа', '{"x":"1","y":1,"width":800,"height":500}'],
    ['бесконечность', '{"x":1e999,"y":1,"width":800,"height":500}'],
    ['за краем', '{"x":1000,"y":1,"width":800,"height":500}'],
    ['левее окна', '{"x":-700,"y":1,"width":800,"height":500}'],
    ['выше окна', '{"x":1,"y":-1,"width":800,"height":500}'],
    ['шапка ниже окна', '{"x":1,"y":880,"width":800,"height":500}'],
    ['меньше наименьшего', '{"x":1,"y":1,"width":100,"height":100}'],
  ])('плохое значение (%s): null', (_name, raw) => {
    expect(parseRect(raw, V)).toBeNull();
  });

  it('целое значение читается; после сужения окна больше не подходит', () => {
    const raw = JSON.stringify(R);
    expect(parseRect(raw, V)).toEqual(R);
    expect(parseRect(raw, { width: 800, height: 600 })).toBeNull();
  });

  it('сохранённое место частично за левым и нижним краем читается: шапку можно достать', () => {
    const away = { x: -500, y: 800, width: 800, height: 500 };
    expect(parseRect(JSON.stringify(away), V)).toEqual(away);
    expect(fits(away, V)).toBe(true);
  });

  it('перетаскивание: вправо и вверх не выходит, влево и вниз частично, шапку можно достать', () => {
    expect(moveRect(R, 5000, -5000, V)).toEqual({ ...R, x: 640, y: 0 });
    expect(moveRect(R, -5000, 5000, V)).toEqual({ ...R, x: -560, y: 852 });
    // Кнопки шапки: на экране остаются они и место, за которое окно тянут.
    expect(moveRect(R, -5000, 0, V, 500).x).toBe(-300);
    // Кнопки шире окна: влево окно не уходит.
    expect(moveRect(R, -5000, 0, V, 900).x).toBe(0);
    for (const dx of [-5000, 5000]) expect(fits(moveRect(R, dx, 5000, V), V)).toBe(true);
  });

  it('края и углы: не меньше наименьшего, не за окно, противоположный край стоит', () => {
    expect(resizeRect(R, 'e', 5000, 0, V).width).toBe(1340);
    expect(resizeRect(R, 'se', -5000, -5000, V)).toEqual({ ...R, width: 480, height: 320 });
    const w = resizeRect(R, 'w', 5000, 0, V);
    expect([w.width, w.x + w.width]).toEqual([480, 900]);
    const left = resizeRect(R, 'nw', -5000, -5000, V);
    expect(left).toEqual({ x: 0, y: 0, width: 900, height: 600 });
    const top = resizeRect(R, 'n', 0, 5000, V);
    expect([top.height, top.y + top.height]).toEqual([320, 600]);
    // Окно за левым краем: правый край не уходит левее того, что должно остаться на экране.
    const away = { ...R, x: -500 };
    expect(resizeRect(away, 'e', -5000, 0, V).width).toBe(740);
    expect(fits(resizeRect(away, 'e', -5000, 0, V), V)).toBe(true);
  });
});
