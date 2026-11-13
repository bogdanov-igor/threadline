import { describe, expect, it } from 'vitest';
import { canPan, clampView, fitScale, fitView, limitsOf, stepScale, toggleScale, wheelScale, zoomAt } from './zoom.ts';

const BOX = { width: 1000, height: 800 };
const BIG = { width: 2000, height: 1000 };
const SMALL = { width: 280, height: 222 };

describe('масштаб картинки', () => {
  it('«Вписать»: большая картинка с полями в окне, по центру', () => {
    const v = fitView(BIG, BOX, 'raster');
    expect(v.scale).toBeCloseTo(0.484, 3);
    expect(v.x).toBeCloseTo((1000 - 2000 * v.scale) / 2);
    expect(v.y).toBeCloseTo((800 - 1000 * v.scale) / 2);
    expect(canPan(v, BIG, BOX)).toBe(false);
  });

  it('маленький снимок растёт только пока резкий, схема дальше', () => {
    expect(fitScale(SMALL, BOX, 'raster')).toBe(2);
    expect(fitScale(SMALL, BOX, 'vector')).toBe(3);
  });

  it('окно меньше полей: масштаб не ноль и не меньше нуля', () => {
    expect(fitScale(BIG, { width: 10, height: 10 }, 'raster')).toBeGreaterThan(0);
  });

  it('пределы: ниже «Вписать» или своего размера нельзя, вверх есть место всегда', () => {
    expect(limitsOf(0.5, 'raster')).toEqual({ min: 0.5, max: 4 });
    expect(limitsOf(2, 'raster')).toEqual({ min: 1, max: 4 });
    expect(limitsOf(3, 'vector')).toEqual({ min: 1, max: 8 });
    expect(limitsOf(5, 'raster').max).toBe(10);
  });

  it('масштаб вокруг точки: точка картинки под указателем остаётся на месте', () => {
    const limits = limitsOf(0.484, 'raster');
    const start = fitView(BIG, BOX, 'raster');
    const point = { x: 300, y: 400 };
    const v = zoomAt(start, 2, point, BIG, BOX, limits);
    expect(v.scale).toBe(2);
    expect((point.x - v.x) / v.scale).toBeCloseTo((point.x - start.x) / start.scale);
    expect((point.y - v.y) / v.scale).toBeCloseTo((point.y - start.y) / start.scale);
  });

  it('масштаб упирается в пределы, сдвиг при этом считается от настоящего масштаба', () => {
    const limits = { min: 0.5, max: 4 };
    const v = zoomAt({ scale: 1, x: 0, y: 0 }, 100, { x: 0, y: 0 }, BIG, BOX, limits);
    expect(v.scale).toBe(4);
    expect(zoomAt(v, 0.01, { x: 0, y: 0 }, BIG, BOX, limits).scale).toBe(0.5);
  });

  it('картинка не уходит краем внутрь окна, меньшая сторона стоит по центру', () => {
    expect(clampView({ scale: 1, x: 50, y: 50 }, BIG, BOX)).toEqual({ scale: 1, x: 0, y: 0 });
    expect(clampView({ scale: 1, x: -5000, y: -5000 }, BIG, BOX)).toEqual({ scale: 1, x: -1000, y: -200 });
    expect(clampView({ scale: 0.25, x: 7, y: 7 }, BIG, BOX)).toEqual({ scale: 0.25, x: 250, y: 275 });
  });

  it('кнопки ведут к ровным четвертям с любого масштаба', () => {
    expect(stepScale(1, 1)).toBe(1.25);
    expect(stepScale(1, -1)).toBe(0.75);
    expect(stepScale(0.87, 1)).toBe(1);
    expect(stepScale(0.87, -1)).toBe(0.75);
  });

  it('колесо: вниз меньше, вверх больше, щипок на тачпаде сильнее, строки Firefox как пиксели', () => {
    const wheel = (deltaY: number, deltaMode = 0, ctrlKey = false) => wheelScale(1, { deltaY, deltaMode, ctrlKey });
    expect(wheel(100)).toBeLessThan(1);
    expect(wheel(-100)).toBeGreaterThan(1);
    expect(wheel(-5, 0, true)).toBeCloseTo(wheel(-50));
    expect(wheel(-3, 1)).toBeCloseTo(wheel(-48));
  });

  it('двойное нажатие: из «Вписать» крупнее, обратно в «Вписать»', () => {
    const limits = limitsOf(0.5, 'raster');
    expect(toggleScale(0.5, 0.5, limits)).toBe(1);
    expect(toggleScale(1.7, 0.5, limits)).toBe(0.5);
    expect(toggleScale(0.9, 0.9, limitsOf(0.9, 'raster'))).toBe(1.8);
    expect(toggleScale(3, 3, limitsOf(3, 'vector'))).toBe(6);
    expect(toggleScale(4, 4, { min: 1, max: 4 })).toBe(4);
  });
});
