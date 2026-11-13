// Горячие клавиши: один слушатель на документ. Действия регистрируют те же компоненты, что рисуют кнопки: нет кнопки по роли или на этой странице, нет и клавиши.
// Клавиши по event.code: работают и на русской раскладке.
import { useEffect, useRef } from 'react';

export type HotkeyId = 'help' | 'next' | 'prev' | 'nextResult' | 'prevResult' | 'link' | 'ticket';
export type HotkeyAction = (from?: HTMLElement | null) => void;

/** Поле поиска страницы: на него встаёт «/». */
export const SEARCH_FIELD_ATTR = 'data-hotkey-search';

const LETTERS: Readonly<Record<string, HotkeyId>> = { KeyJ: 'next', KeyK: 'prev', BracketRight: 'nextResult', BracketLeft: 'prevResult', KeyL: 'link', KeyT: 'ticket' };

export type KeyParts = Pick<KeyboardEvent, 'code' | 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>;

/**
 * Какое действие у нажатия. «?» и «/» — и по клавише, и по символу: на русской раскладке символы стоят на других клавишах, человек нажимает любую из двух.
 * С Ctrl, ⌘ или Alt клавиш нет: Ctrl+F и остальные клавиши браузера остаются браузеру. Shift — часть «?», у букв его быть не должно.
 */
export function hotkeyOf(e: KeyParts): HotkeyId | 'search' | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if ((e.code === 'Slash' && e.shiftKey) || e.key === '?') return 'help';
  if ((e.code === 'Slash' && !e.shiftKey) || e.key === '/') return 'search';
  return e.shiftKey ? null : (LETTERS[e.code] ?? null);
}

/** Ctrl+Enter и ⌘+Enter: сохранить форму. */
export const isSaveKeys = (e: KeyParts) => e.code === 'Enter' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey;

// В поле ввода буквы — это текст. Выбор Radix ищет значение по буквам, CodeMirror читает свои клавиши и в режиме чтения.
export const TYPING = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], .cm-editor';
// Открытое окно, меню или список. Окно большого кода не модальное: шаги под ним переключаются. Подсказка «скопировано» клавиш не держит.
const OPEN_LAYER = '[role="dialog"]:not([aria-modal="false"]):not([data-hotkeys-through]), [role="alertdialog"], [role="menu"], [data-radix-popper-content-wrapper] [role="listbox"]';

// Большое окно кода: шаги под ним листаются, а уход к другому результату закрыл бы его нажатием мимо. Кнопки перехода работают как обычно.
const CODE_WINDOW = '[role="dialog"][aria-modal="false"]';

/** Клавиши молчат: курсор в поле ввода или открыто окно. */
export function hotkeysOff(target: Element | null, root: ParentNode = document): boolean {
  return !!target?.closest(TYPING) || root.querySelector(OPEN_LAYER) !== null;
}

/** [ и ] молчат ещё и при большом окне кода. */
export const resultKeysOff = (root: ParentNode = document): boolean => root.querySelector(CODE_WINDOW) !== null;

// Первая регистрация важнее: на странице запроса две кнопки «Поделиться», подсказка встаёт у верхней.
const actions = new Map<HotkeyId, HotkeyAction[]>();

export function registerHotkey(id: HotkeyId, action: HotkeyAction): () => void {
  actions.set(id, [...(actions.get(id) ?? []), action]);
  return () => actions.set(id, (actions.get(id) ?? []).filter((x) => x !== action));
}

export function runHotkey(id: HotkeyId, from?: HTMLElement | null): boolean {
  const action = actions.get(id)?.[0];
  action?.(from);
  return !!action;
}

/** Действие живёт, пока смонтирован компонент. null — действие сейчас недоступно: клавиша ничего не делает. */
export function useHotkey(id: HotkeyId, action: HotkeyAction | null): void {
  const latest = useRef(action);
  latest.current = action;
  const on = action !== null;
  useEffect(() => (on ? registerHotkey(id, (from) => latest.current?.(from)) : undefined), [id, on]);
}

/** Сохранение формы: через её кнопку, поэтому занятая или выключенная кнопка не сохраняет, как и нажатие мышью. CodeMirror читает клавиши сам. */
function saveForm(e: KeyboardEvent, target: Element | null): void {
  if (target?.closest('.cm-editor')) return;
  const form = target?.closest('form') ?? document.querySelector<HTMLFormElement>('[role="dialog"]:not([aria-modal="false"]) form');
  if (!form) return;
  const submit = [...form.elements].find((el): el is HTMLButtonElement => el instanceof HTMLButtonElement && el.type === 'submit');
  if (!submit) return;
  e.preventDefault();
  if (!submit.disabled) form.requestSubmit(submit);
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.defaultPrevented || e.isComposing) return;
  const target = e.target instanceof Element ? e.target : null;
  if (isSaveKeys(e)) return saveForm(e, target);
  // Выход из поля поиска, в которое привела «/». Окна и меню Esc закрывают сами, раньше этого слушателя.
  if (e.key === 'Escape') {
    if (target instanceof HTMLElement && target.hasAttribute(SEARCH_FIELD_ATTR)) target.blur();
    return;
  }
  const id = hotkeyOf(e);
  if (!id || hotkeysOff(target)) return;
  if ((id === 'nextResult' || id === 'prevResult') && resultKeysOff()) return;
  // Удержание листает шаги, остальное срабатывает один раз.
  if (e.repeat && id !== 'next' && id !== 'prev') return;
  if (id === 'search') {
    const field = [...document.querySelectorAll<HTMLInputElement>(`[${SEARCH_FIELD_ATTR}]:not([disabled])`)].find((el) => el.getClientRects().length > 0);
    if (!field) return;
    e.preventDefault();
    field.focus();
    field.select();
    return;
  }
  if (runHotkey(id, target instanceof HTMLElement ? target : null)) e.preventDefault();
}

/** Один раз в корне приложения. */
export function useHotkeysListener(): void {
  useEffect(() => {
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);
}

/** Подпись клавиши сохранения для этой системы. */
export const saveKeysLabel = () => (/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘+Enter' : 'Ctrl+Enter');
