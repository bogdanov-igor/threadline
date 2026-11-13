// Состояние редактора без DOM: режим чтения, Tab, предел и отмена после замены.
import { redo, undo } from '@codemirror/commands';
import { EditorState } from '@codemirror/state';
import { describe, expect, it, vi } from 'vitest';
import { createFileState, insertSpaces, MAX_DOC_CHARS, readOnlyCompartment } from './setup.ts';

const hooks = () => ({ onDocChange: vi.fn(), onOverLimit: vi.fn(), onDropFile: vi.fn() });
const make = (doc = 'a: 1\n', readOnly = false, h = hooks()) => createFileState({ doc, format: 'yaml', readOnly, phrases: {}, label: 'x', hooks: h });

const run = (state: EditorState, cmd: typeof undo) => {
  let next = state;
  const ok = cmd({ state, dispatch: (tr) => (next = tr.state) });
  return { ok, state: next };
};

describe('состояние редактора', () => {
  it('режим чтения через readOnly и его можно менять без потери текста и истории', () => {
    const s = make('a: 1\n', true);
    expect(s.readOnly).toBe(true);
    const open = s.update({ effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(false)) }).state;
    expect(open.readOnly).toBe(false);
    expect(open.doc.toString()).toBe('a: 1\n');
  });

  it('Tab вставляет два пробела, символа табуляции нет; в режиме чтения Tab не перехватывается', () => {
    const { ok, state } = run(make('a'), insertSpaces as never);
    expect(ok).toBe(true);
    expect(state.doc.toString()).toBe('  a');
    expect(state.doc.toString()).not.toContain('\t');
    expect(run(make('a', true), insertSpaces as never).ok).toBe(false);
  });

  it('вставка сверх предела не принята: текст и история на месте, причина уходит на страницу', async () => {
    const h = hooks();
    const s = make('a', false, h);
    const typed = s.update({ changes: { from: 1, insert: 'b' } }).state;
    const refused = typed.update({ changes: { from: 0, insert: 'x'.repeat(MAX_DOC_CHARS + 1) } }).state;
    expect(refused.doc.toString()).toBe('ab');
    await Promise.resolve();
    expect(h.onOverLimit).toHaveBeenCalled();
    expect(run(refused, undo).state.doc.toString()).toBe('a');
  });

  it('новое состояние не несёт историю: отмена не вернёт прежний текст', () => {
    const typed = make('a').update({ changes: { from: 1, insert: 'b' } }).state;
    expect(run(typed, undo).ok).toBe(true);
    const replaced = make('другой текст');
    expect(run(replaced, undo).ok).toBe(false);
    expect(run(replaced, redo).ok).toBe(false);
    expect(replaced.doc.toString()).toBe('другой текст');
  });
});
