import { describe, expect, it } from 'vitest';
import { hotkeyOf, isSaveKeys, type KeyParts } from './hotkeys.ts';

// Поля ввода, окна и CodeMirror проверяет настоящий браузер: e2e/keyboard.spec.ts.

const press = (over: Partial<KeyParts>): KeyParts => ({ code: '', key: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...over });

describe('hotkeyOf', () => {
  it('буквы по физической клавише: латиница, кириллица, CapsLock', () => {
    expect(hotkeyOf(press({ code: 'KeyJ', key: 'j' }))).toBe('next');
    expect(hotkeyOf(press({ code: 'KeyJ', key: 'о' }))).toBe('next');
    expect(hotkeyOf(press({ code: 'KeyK', key: 'Л' }))).toBe('prev');
    expect(hotkeyOf(press({ code: 'KeyL', key: 'д' }))).toBe('link');
    expect(hotkeyOf(press({ code: 'KeyT', key: 'е' }))).toBe('ticket');
  });

  it('[ и ] по физической клавише: на русской раскладке там х и ъ, с Shift и модификатором клавиш нет', () => {
    expect(hotkeyOf(press({ code: 'BracketLeft', key: '[' }))).toBe('prevResult');
    expect(hotkeyOf(press({ code: 'BracketRight', key: ']' }))).toBe('nextResult');
    expect(hotkeyOf(press({ code: 'BracketLeft', key: 'х' }))).toBe('prevResult');
    expect(hotkeyOf(press({ code: 'BracketRight', key: 'ъ' }))).toBe('nextResult');
    expect(hotkeyOf(press({ code: 'BracketRight', key: '}', shiftKey: true }))).toBeNull();
    expect(hotkeyOf(press({ code: 'BracketLeft', key: '[', metaKey: true }))).toBeNull();
    // Символ на другой клавише не считается: на русской раскладке это буквы.
    expect(hotkeyOf(press({ code: 'KeyX', key: '[' }))).toBeNull();
  });

  it('«?» и «/» по клавише и по символу: на русской раскладке символы на других клавишах', () => {
    expect(hotkeyOf(press({ code: 'Slash', key: '?', shiftKey: true }))).toBe('help');
    expect(hotkeyOf(press({ code: 'Slash', key: ',', shiftKey: true }))).toBe('help');
    expect(hotkeyOf(press({ code: 'Digit7', key: '?', shiftKey: true }))).toBe('help');
    expect(hotkeyOf(press({ code: 'Slash', key: '/' }))).toBe('search');
    expect(hotkeyOf(press({ code: 'Slash', key: '.' }))).toBe('search');
    expect(hotkeyOf(press({ code: 'Backslash', key: '/', shiftKey: true }))).toBe('search');
  });

  it('с модификатором клавиш нет: Ctrl+F и Ctrl+T остаются браузеру', () => {
    for (const mod of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      expect(hotkeyOf(press({ code: 'KeyT', key: 't', ...mod }))).toBeNull();
      expect(hotkeyOf(press({ code: 'Slash', key: '/', ...mod }))).toBeNull();
    }
    expect(hotkeyOf(press({ code: 'KeyJ', key: 'J', shiftKey: true }))).toBeNull();
    expect(hotkeyOf(press({ code: 'KeyF', key: 'f' }))).toBeNull();
  });

  it('Ctrl+Enter и ⌘+Enter сохраняют, просто Enter и Shift+Enter нет', () => {
    expect(isSaveKeys(press({ code: 'Enter', ctrlKey: true }))).toBe(true);
    expect(isSaveKeys(press({ code: 'Enter', metaKey: true }))).toBe(true);
    expect(isSaveKeys(press({ code: 'Enter' }))).toBe(false);
    expect(isSaveKeys(press({ code: 'Enter', ctrlKey: true, shiftKey: true }))).toBe(false);
  });
});
