// Настройка CodeMirror: цвета через CSS-переменные (тема меняется без пересоздания редактора), чтение через readOnly, Tab и Esc, предел текста.
// Состояние создаётся без DOM: его держит контроллер, вид создаётся из него при возврате на страницу.
import { defaultKeymap, history, historyKeymap, indentLess } from '@codemirror/commands';
import { json } from '@codemirror/lang-json';
import { yaml } from '@codemirror/lang-yaml';
import { HighlightStyle, indentUnit, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { lintGutter } from '@codemirror/lint';
import { search, searchKeymap } from '@codemirror/search';
import { Compartment, EditorSelection, EditorState, RangeSetBuilder, type Extension } from '@codemirror/state';
import { Decoration, EditorView, keymap, lineNumbers, ViewPlugin, type Command, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { CODE_COLORS, CODE_TOKENS, type CodePalette } from './colors.ts';
import type { FileFormat } from './convert.ts';

/** Предел вкладки: сверх него ввод не принимается. */
export const MAX_DOC_CHARS = 8_000_000;

const FOCUS_MS = 4000;

const variables = (p: CodePalette) => ({ '--pf-bg': p.background, ...Object.fromEntries(CODE_TOKENS.map((k) => [`--pf-${k}`, p[k]])) });

const theme = EditorView.theme({
  '&': { ...variables(CODE_COLORS.light), height: '100%', fontSize: '12.5px', backgroundColor: 'var(--pf-bg)', color: 'var(--pf-secondary)', borderRadius: '10px' },
  '.dark &': variables(CODE_COLORS.dark),
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '20px', overflow: 'auto', borderRadius: '10px' },
  '.cm-content': { caretColor: 'var(--foreground)' },
  '.cm-cursor': { borderLeftColor: 'var(--foreground)' },
  '.cm-gutters': { backgroundColor: 'var(--pf-bg)', color: 'var(--pf-secondary)', border: 'none' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: 'color-mix(in srgb, var(--pf-tag) 22%, transparent)' },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--pf-number) 28%, transparent)', outline: 'none' },
  '.cm-searchMatch-selected': { backgroundColor: 'color-mix(in srgb, var(--pf-number) 48%, transparent)' },
  '.cm-panels': { backgroundColor: 'var(--card)', color: 'var(--foreground)', borderColor: 'var(--border)', fontFamily: 'var(--font-sans)', fontSize: '13px' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border)' },
  '.cm-textfield': { backgroundColor: 'var(--card)', color: 'var(--foreground)', border: '1px solid var(--input)', borderRadius: '6px' },
  '.cm-button': { backgroundImage: 'none', backgroundColor: 'var(--card)', color: 'var(--foreground)', border: '1px solid var(--input)', borderRadius: '6px' },
  '.cm-yaml-const': { color: 'var(--pf-number)' },
});

const highlight = HighlightStyle.define([
  { tag: [tags.propertyName, tags.definition(tags.propertyName)], color: 'var(--pf-xk)' },
  { tag: [tags.string, tags.content, tags.special(tags.string), tags.attributeValue], color: 'var(--pf-string)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--pf-number)' },
  { tag: [tags.typeName, tags.labelName, tags.keyword], color: 'var(--pf-tag)' },
  { tag: [tags.lineComment, tags.separator, tags.punctuation, tags.squareBracket, tags.brace, tags.meta], color: 'var(--pf-secondary)' },
]);

/** Разборщик YAML считает все простые значения текстом: числа, true, false и null выделяются здесь, только в видимых строках. */
const YAML_CONST = /^(?:true|false|null|~|[-+]?(?:\d[\d_]*)(?:\.\d+)?(?:[eE][-+]?\d+)?)$/i;
const constMark = Decoration.mark({ class: 'cm-yaml-const' });

function yamlConstants(view: EditorView): DecorationSet {
  const out = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (n) => {
        if (n.name !== 'Literal' || n.node.parent?.name === 'Key') return;
        if (n.to - n.from <= 40 && YAML_CONST.test(view.state.sliceDoc(n.from, n.to))) out.add(n.from, n.to, constMark);
      },
    });
  }
  return out.finish();
}

const yamlConstHighlight = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = yamlConstants(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) this.decorations = yamlConstants(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

/** Tab вставляет два пробела: символа табуляции в файле нет. В режиме чтения Tab уводит фокус. */
export const insertSpaces: Command = ({ state, dispatch }) => {
  if (state.readOnly) return false;
  dispatch(state.update(state.changeByRange((r) => ({ changes: { from: r.from, to: r.to, insert: '  ' }, range: EditorSelection.cursor(r.from + 2) })), { scrollIntoView: true, userEvent: 'input' }));
  return true;
};

/** Esc, затем Tab: выход с клавиатуры. На время Tab не перехватывается. */
const focusEscape: Command = (view) => {
  view.setTabFocusMode(FOCUS_MS);
  return false;
};

export interface EditorHooks {
  /** Текст изменился: контроллер считает правки и ставит проверки. */
  onDocChange: () => void;
  /** Вставка сделала бы текст длиннее предела: текст и история на месте. */
  onOverLimit: () => void;
  /** На текст перетащили файл: дальше обычный путь загрузки. */
  onDropFile: (file: File) => void;
}

export const readOnlyCompartment = new Compartment();
export const phrasesCompartment = new Compartment();

export function phrasesExtension(phrases: Readonly<Record<string, string>>, label: string): Extension {
  // tabindex: у прокручиваемой области должен быть элемент в порядке табуляции, contenteditable сам axe не засчитывает.
  return [EditorState.phrases.of(phrases), EditorView.contentAttributes.of({ 'aria-label': label, tabindex: '0' })];
}

export interface StateOptions {
  doc: string;
  format: FileFormat;
  readOnly: boolean;
  phrases: Readonly<Record<string, string>>;
  label: string;
  hooks: EditorHooks;
}

/** Новое состояние: новая история, поэтому отмена не вернёт прежний текст и формат не разойдётся с текстом. */
export function createFileState(o: StateOptions): EditorState {
  return EditorState.create({
    doc: o.doc,
    extensions: [
      readOnlyCompartment.of(EditorState.readOnly.of(o.readOnly)),
      phrasesCompartment.of(phrasesExtension(o.phrases, o.label)),
      lineNumbers(),
      lintGutter(),
      history(),
      search({ top: true }),
      indentUnit.of('  '),
      EditorState.tabSize.of(2),
      o.format === 'yaml' ? yaml() : json(),
      o.format === 'yaml' ? yamlConstHighlight : [],
      syntaxHighlighting(highlight),
      theme,
      keymap.of([{ key: 'Tab', run: insertSpaces, shift: indentLess }, { key: 'Escape', run: focusEscape }, ...historyKeymap, ...searchKeymap, ...defaultKeymap]),
      // Предел проверяется до применения: при отказе текст и история отмены не меняются.
      EditorState.changeFilter.of((tr) => {
        if (tr.newDoc.length <= MAX_DOC_CHARS) return true;
        queueMicrotask(o.hooks.onOverLimit);
        return false;
      }),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) o.hooks.onDocChange();
      }),
      // CodeMirror сам читает перетащенный файл целиком, минуя предел и проверку кодировки: файл идёт общим путём загрузки.
      EditorView.domEventHandlers({
        drop: (e) => {
          const file = e.dataTransfer?.files?.[0];
          if (!file) return false;
          e.preventDefault();
          o.hooks.onDropFile(file);
          return true;
        },
        dragover: (e) => {
          if (!e.dataTransfer?.types.includes('Files')) return false;
          e.preventDefault();
          return true;
        },
      }),
    ],
  });
}
