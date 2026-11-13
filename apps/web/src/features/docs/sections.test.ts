import { describe, expect, it } from 'vitest';
import { groupOf, placeOf, sectionKey } from './sections.ts';

describe('разделы', () => {
  it('группа страницы: из меню, по имени файла, у обучения одна', () => {
    expect(groupOf('docs', 'guide-search')).toBe('guide');
    expect(groupOf('docs', 'file-new-page')).toBe('file');
    expect(groupOf('learn', 'anything')).toBe('learn');
    expect(groupOf('docs', 'nothing')).toBeNull();
  });

  it('место по адресу', () => {
    expect(placeOf('/docs/file-start#x')).toEqual({ tree: 'docs', id: 'file-start' });
    expect(placeOf('/learn/card')).toEqual({ tree: 'learn', id: 'card' });
    expect(placeOf('/about')).toBeNull();
  });

  it('подпись: у обучения название раздела, у документации группа', () => {
    expect(sectionKey('learn', 'learn')).toBe('docs.learnTitle');
    expect(sectionKey('docs', 'file')).toBe('docs.groups.file');
  });
});
