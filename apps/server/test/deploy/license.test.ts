// Файлы открытого репозитория: лицензия MIT в LICENSE и во всех package.json, ссылки README и соседних файлов ведут на файлы,
// которые есть в репозитории.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { ROOT } from '../../src/paths.ts';

const read = (name: string) => readFileSync(join(ROOT, name), 'utf8');

/** package.json корня и каждого пакета рабочей области из pnpm-workspace.yaml. */
function packageFiles(): string[] {
  const { packages } = parse(read('pnpm-workspace.yaml')) as { packages: string[] };
  const found = ['package.json'];
  for (const glob of packages) {
    const base = glob.replace(/\/\*$/, '');
    for (const name of readdirSync(join(ROOT, base))) {
      const file = join(base, name, 'package.json');
      if (existsSync(join(ROOT, file))) found.push(file);
    }
  }
  return found;
}

describe('лицензия', () => {
  it('LICENSE: MIT с авторами', () => {
    const text = read('LICENSE');
    expect(text.split('\n')[0]).toBe('MIT License');
    expect(text).toContain('Copyright (c) 2026 Igor Bogdanov, Aleksandr Ivanov');
    expect(text).toContain('THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND');
  });

  it('каждый package.json: license MIT', () => {
    const files = packageFiles();
    expect(files.length).toBeGreaterThanOrEqual(4);
    for (const file of files)
      expect((JSON.parse(read(file)) as { license?: string }).license, file).toBe('MIT');
  });

  it('корневой package.json называет авторов и адрес репозитория', () => {
    const pkg = JSON.parse(read('package.json')) as {
      author?: string;
      contributors?: string[];
      repository?: { url?: string };
      homepage?: string;
      bugs?: { url?: string };
    };
    expect([pkg.author, ...(pkg.contributors ?? [])].sort()).toEqual(['Aleksandr Ivanov', 'Igor Bogdanov']);
    const repo = /^https:\/\/github\.com\/[^/]+\/threadline/;
    expect(pkg.repository?.url?.replace(/^git\+/, '')).toMatch(repo);
    expect(pkg.homepage).toMatch(repo);
    expect(pkg.bugs?.url).toMatch(repo);
  });
});

describe('ссылки открытых файлов', () => {
  const FILES = [
    'README.md',
    'README.ru.md',
    'CONTRIBUTING.md',
    'SECURITY.md',
    '.github/pull_request_template.md',
  ];

  it.each(FILES)('%s: относительные ссылки ведут на существующие файлы', (file) => {
    const text = read(file);
    const broken: string[] = [];
    for (const m of text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const target = m[1]!;
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      const path = join(dirname(join(ROOT, file)), decodeURI(target.split('#')[0]!));
      if (!existsSync(path)) broken.push(target);
    }
    expect(broken).toEqual([]);
  });

  it.each(FILES)('%s: относительные ссылки не выходят за корень репозитория', (file) => {
    const text = read(file);
    for (const m of text.matchAll(/\]\((\.\.?\/[^)\s#]+)/g))
      expect(relative(ROOT, join(dirname(join(ROOT, file)), m[1]!)), m[1]).not.toMatch(/^\.\./);
  });
});
