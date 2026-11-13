// Журналы сервера не попадают в образ: на любой глубине, а не только в корне.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from '../src/paths.ts';

describe('журналы вне образа', () => {
  it('.dockerignore исключает *.log на любой глубине: без **/ шаблон действует только в корне', () => {
    expect(readFileSync(join(ROOT, '.dockerignore'), 'utf8').split('\n')).toContain('**/*.log');
  });
});
