// Память режима: запись только при выборе, мусор и запрет хранилища не ломают страницу, выбор один на все проекты.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readChoice, resetChoiceMemory, subscribeChoice, VIEW_KEY, writeChoice } from './store.ts';

function fakeWindow(opts: { denied?: boolean } = {}) {
  const data = new Map<string, string>();
  const handlers = new Set<(e: { key: string | null }) => void>();
  const localStorage = {
    getItem: (k: string) => {
      if (opts.denied) throw new Error('запрещено');
      return data.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (opts.denied) throw new Error('запрещено');
      data.set(k, v);
    },
  };
  vi.stubGlobal('window', {
    localStorage,
    addEventListener: (_: string, fn: (e: { key: string | null }) => void) => handlers.add(fn),
    removeEventListener: (_: string, fn: (e: { key: string | null }) => void) => handlers.delete(fn),
  });
  return { data, fire: (key: string | null) => handlers.forEach((h) => h({ key })), handlers };
}

beforeEach(() => resetChoiceMemory());
afterEach(() => vi.unstubAllGlobals());

describe('память режима', () => {
  it('без выбора записи нет, чтение ничего не пишет', () => {
    const w = fakeWindow();
    expect(readChoice()).toBeNull();
    expect(w.data.size).toBe(0);
  });

  it('запись только при вызове, один выбор на все проекты', () => {
    const w = fakeWindow();
    writeChoice('brief');
    expect(readChoice()).toBe('brief');
    expect(w.data.get(VIEW_KEY)).toBe('brief');
    writeChoice('full');
    expect(w.data.get(VIEW_KEY)).toBe('full');
  });

  it('повторный выбор ничего не пишет и не будит подписчиков', () => {
    fakeWindow();
    writeChoice('brief');
    const fn = vi.fn();
    const off = subscribeChoice(fn);
    writeChoice('brief');
    expect(fn).not.toHaveBeenCalled();
    writeChoice('full');
    expect(fn).toHaveBeenCalledOnce();
    off();
  });

  it.each(['{не json', '[]', '"brief"', 'null', '{"pay":"brief"}', 'compact', ''])('мусор и прежняя запись по проектам %s не считаются выбором, следующая смена перезаписывает', (text) => {
    const w = fakeWindow();
    w.data.set(VIEW_KEY, text);
    expect(readChoice()).toBeNull();
    writeChoice('brief');
    expect(w.data.get(VIEW_KEY)).toBe('brief');
  });

  it('запрет хранилища: работает до перезагрузки, ошибок нет', () => {
    fakeWindow({ denied: true });
    expect(readChoice()).toBeNull();
    const fn = vi.fn();
    const off = subscribeChoice(fn);
    writeChoice('brief');
    expect(readChoice()).toBe('brief');
    expect(fn).toHaveBeenCalledOnce();
    off();
    resetChoiceMemory();
    expect(readChoice()).toBeNull();
  });

  it('другая вкладка: событие storage будит подписчика и новое значение читается', () => {
    const w = fakeWindow();
    const fn = vi.fn();
    const off = subscribeChoice(fn);
    w.data.set(VIEW_KEY, 'brief');
    w.fire('threadline.other');
    expect(fn).not.toHaveBeenCalled();
    w.fire(VIEW_KEY);
    expect(fn).toHaveBeenCalledOnce();
    expect(readChoice()).toBe('brief');
    off();
    expect(w.handlers.size).toBe(0);
  });
});
