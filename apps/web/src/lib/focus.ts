// Куда встаёт фокус: следующее поле по Tab, первое поле окна, первое неверное поле, переход стрелками внутри группы кнопок.
// Только DOM, состояния нет.

const CANDIDATES = 'a[href], button, input, select, textarea, [tabindex]';
const TEXT_FIELD = 'input:not([type=hidden],[type=file],[type=checkbox],[type=radio],[readonly],[disabled],[tabindex="-1"]), textarea:not([readonly],[disabled])';
const OTHER_FIELD = '[role=combobox]:not([disabled]), input[type=radio]:not([disabled]), input[type=checkbox]:not([disabled])';

const visible = (el: Element) => el.getClientRects().length > 0;

/** Куда можно попасть клавишей Tab: без выключенных, скрытых и помощников с tabIndex={-1}. */
export function tabbablesIn(root: Element): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(CANDIDATES)].filter((el) => el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled && (el as HTMLInputElement).type !== 'hidden' && el.getAttribute('aria-hidden') !== 'true' && visible(el));
}

/**
 * Tab и Shift+Tab мимо внутренних частей поля: сегменты даты браузер считает отдельными остановками.
 * Внутри окна переход идёт по кругу, как у самого окна. false — соседа нет, решает браузер.
 */
export function moveTab(from: HTMLElement, backwards: boolean): boolean {
  const dialog = from.closest<HTMLElement>('[role=dialog]');
  const list = tabbablesIn(dialog ?? document.body);
  const i = list.indexOf(from);
  if (i < 0) return false;
  const next = list[i + (backwards ? -1 : 1)] ?? (dialog ? list[backwards ? list.length - 1 : 0] : undefined);
  if (!next) return false;
  next.focus();
  return true;
}

/** Первое поле окна: сначала поле для текста, потому что выбор с него открывался бы лишним нажатием, потом выбор и отметки. */
export function focusFirstField(root: Element | null | undefined): boolean {
  if (!root) return false;
  const first = [...root.querySelectorAll<HTMLElement>(TEXT_FIELD)].find(visible) ?? [...root.querySelectorAll<HTMLElement>(OTHER_FIELD)].find(visible);
  if (!first) return false;
  first.focus();
  return true;
}

/**
 * Первое неверное поле после неудачной отправки. После кадра: отметки появляются при следующей отрисовке, свёрнутый блок с ошибкой к этому времени раскрыт.
 * Ошибка без поля: фокус остаётся, сообщение прокручивается в вид.
 */
export function focusFirstInvalid(root: ParentNode | null = document): void {
  const before = document.activeElement;
  requestAnimationFrame(() => {
    // Кадр мог задержаться, а человек уже ушёл в другое поле: фокус у него не забираем.
    if (document.activeElement !== before) return;
    const scope = root ?? document;
    const field = [...scope.querySelectorAll<HTMLElement>('[aria-invalid="true"]:not([disabled])')].find(visible);
    if (field) {
      field.focus();
      field.scrollIntoView({ block: 'nearest' });
      return;
    }
    scope.querySelector('[data-testid="field-error"], [role="alert"]')?.scrollIntoView({ block: 'nearest' });
  });
}

/** Стрелки внутри группы кнопок: группа — одна остановка Tab, выбор по-прежнему нажатием или пробелом. */
export function moveInGroup(e: { key: string; target: EventTarget; currentTarget: HTMLElement; preventDefault: () => void }): void {
  // Окно внутри группы лежит в портале, но событие всплывает по дереву компонентов: его стрелки не наши.
  if (!e.currentTarget.contains(e.target as Node)) return;
  const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
  if (step === 0) return;
  const list = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not([disabled])')];
  if (list.length === 0) return;
  e.preventDefault();
  const i = list.indexOf(document.activeElement as HTMLButtonElement);
  list[(i + step + list.length) % list.length]?.focus();
}
