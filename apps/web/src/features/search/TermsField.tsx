import type { TermKind } from '@threadline/core/search';
import { X } from 'lucide-react';
import { useRef, type ClipboardEvent, type KeyboardEvent, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { extras } from '@/features/extras/hub.ts';
import { SEARCH_FIELD_ATTR } from '@/lib/hotkeys.ts';
import { cn } from '@/lib/utils.ts';
import { addTerms, type InputError, type TermChip } from './model.ts';

export interface TermsFieldProps {
  id: string;
  chips: TermChip[];
  onChipsChange: (chips: TermChip[]) => void;
  text: string;
  onTextChange: (text: string) => void;
  onInputError: (e: InputError | null) => void;
  onSubmit: () => void;
  invalid: boolean;
  invalidChipId: string | undefined;
  describedBy: string;
  disabled: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  /** Подпись и подсказка поля «Не содержит». По умолчанию — основное поле. */
  label?: string;
  placeholder?: string;
  /** Основное поле страницы: на него встаёт «/». */
  hotkeyTarget?: boolean;
  /** Поле значений поиска: слово шутки не становится значением. */
  extras?: boolean;
}

export function useKindLabel() {
  const { t } = useTranslation();
  return (kind: TermKind, value: string) => (kind === 'number' ? t('search.kind.number', { count: value.length }) : t(`search.kind.${kind}`));
}

/**
 * Поле значений: каждое значение — метка с видом. Enter или запятая добавляет, Backspace в пустом поле убирает последнее, Ctrl+Enter сразу ищет.
 * Крестики меток не занимают остановки Tab: стрелка влево из пустого поля ведёт на них, Delete или Enter убирает метку.
 */
export function TermsField(p: TermsFieldProps) {
  const { t } = useTranslation();
  const kindLabel = useKindLabel();
  const chipsRef = useRef<HTMLDivElement>(null);
  const removeButtons = () => [...(chipsRef.current?.querySelectorAll<HTMLButtonElement>('[data-chip-remove]') ?? [])];

  const commit = (value: string) => {
    const r = addTerms(p.chips, value);
    p.onChipsChange(r.chips);
    p.onTextChange(r.rest);
    p.onInputError(r.error);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (p.extras && !e.ctrlKey && !e.metaKey && extras.take(p.text)) {
        p.onTextChange('');
        p.onInputError(null);
      } else if (p.text.trim() && !e.ctrlKey && !e.metaKey) commit(p.text);
      else p.onSubmit();
    } else if (e.key === 'ArrowLeft' && p.text === '' && p.chips.length > 0) {
      e.preventDefault();
      removeButtons().at(-1)?.focus();
    } else if (e.key === ',') {
      e.preventDefault();
      if (p.text.trim()) commit(p.text);
    } else if (e.key === 'Backspace' && p.text === '' && p.chips.length > 0) {
      e.preventDefault();
      p.onChipsChange(p.chips.slice(0, -1));
      p.onInputError(null);
    }
  };

  const onChipKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const list = removeButtons();
    const i = list.indexOf(e.currentTarget);
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      list[Math.max(0, i - 1)]?.focus();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      (list[i + 1] ?? p.inputRef.current)?.focus();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      e.currentTarget.click();
    } else if (e.key === 'Escape') p.inputRef.current?.focus();
  };

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData('text');
    if (!/[,\n\r\t]/.test(pasted)) return;
    e.preventDefault();
    const el = e.currentTarget;
    const start = el.selectionStart ?? p.text.length;
    const end = el.selectionEnd ?? p.text.length;
    commit(p.text.slice(0, start) + pasted + p.text.slice(end));
  };

  return (
    <div
      ref={chipsRef}
      // Значения переносятся: до трёх строк, дальше прокручивается само поле.
      className={cn(
        'flex max-h-[88px] min-h-8 w-full min-w-0 cursor-text flex-wrap items-center gap-1 overflow-y-auto rounded-[var(--radius-control)] border bg-card py-[3px] pr-1 pl-1 transition-colors focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring',
        p.invalid ? 'border-danger' : 'border-input',
        p.disabled && 'cursor-not-allowed bg-muted',
      )}
      onMouseDown={(e) => {
        // Клик по свободному месту поля ставит курсор в ввод.
        if (e.target === e.currentTarget) {
          e.preventDefault();
          p.inputRef.current?.focus();
        }
      }}
    >
      {p.chips.map((c) => (
        <span
          key={c.id}
          data-testid="term-chip"
          data-kind={c.kind}
          className={cn(
            'inline-flex h-6 max-w-full min-w-0 items-center gap-1.5 rounded-[7px] pr-[3px] pl-2 text-[13px] whitespace-nowrap',
            p.invalidChipId === c.id ? 'bg-danger-bg' : 'bg-accent',
          )}
        >
          <span className="shrink-0 text-[12px] text-foreground-2">{kindLabel(c.kind, c.value)}</span>
          {/* Введённое написание — только у телефона: у номера карты raw — полный номер, в разметку он не идёт. */}
          <span className="truncate font-mono text-[12.5px] text-foreground" title={c.kind === 'phone' && c.raw !== null && c.raw !== c.display ? c.raw : undefined}>
            {c.display}
          </span>
          <button
            type="button"
            tabIndex={-1}
            data-chip-remove
            disabled={p.disabled}
            onKeyDown={onChipKeyDown}
            aria-label={t('search.field.remove', { value: c.display })}
            className="flex size-5 shrink-0 items-center justify-center rounded-[5px] text-foreground-2 hover:bg-card"
            onClick={() => {
              p.onChipsChange(p.chips.filter((x) => x.id !== c.id));
              p.onInputError(null);
              p.inputRef.current?.focus();
            }}
          >
            <X className="size-3.5" aria-hidden />
          </button>
        </span>
      ))}
      <input
        ref={p.inputRef}
        id={p.id}
        type="text"
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        disabled={p.disabled}
        {...(p.hotkeyTarget ? { [SEARCH_FIELD_ATTR]: '' } : {})}
        value={p.text}
        placeholder={p.placeholder ?? t('search.field.placeholder')}
        aria-label={p.label ?? t('search.field.label')}
        aria-invalid={p.invalid || undefined}
        aria-describedby={p.describedBy}
        onChange={(e) => {
          p.onTextChange(e.target.value);
          if (p.invalid) p.onInputError(null);
        }}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        className="h-6 min-w-[7rem] flex-1 overflow-hidden bg-transparent px-1.5 font-mono text-[13px] text-ellipsis text-foreground outline-none placeholder:font-sans placeholder:text-[13px] placeholder:text-muted-foreground disabled:cursor-not-allowed"
      />
    </div>
  );
}
