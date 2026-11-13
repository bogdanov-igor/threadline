// Файлы для развёртывания: полный файл переменных, в репозитории нет настоящих адресов.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from '../../src/paths.ts';

const read = (name: string) => readFileSync(join(ROOT, name), 'utf8');
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-e2e', 'test-results', 'playwright-report', '.git', 'coverage']);
const SKIP_FILES = new Set(['.env', 'logs.md', 'pnpm-lock.yaml', '.DS_Store']);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || SKIP_FILES.has(name) || name.endsWith('.log')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      // Вложенная рабочая копия git (свой файл .git): полная копия репозитория, проверка шла бы по каждой из них.
      if (existsSync(join(path, '.git'))) continue;
      walk(path, out);
    } else out.push(path);
  }
  return out;
}

// Сами переменные системы и тестов, а не настройки: их задаёт pnpm, ОС или прогон vitest.
const NOT_SETTINGS = new Set(['HOME', 'INIT_CWD', 'VITEST']);

function variablesInCode(): string[] {
  const found = new Set<string>();
  for (const file of [...walk(join(ROOT, 'apps/server/src')), ...walk(join(ROOT, 'packages/core/src'))]) {
    if (!file.endsWith('.ts') || /\.test\.ts$|\/test-[^/]*\.ts$/.test(file)) continue;
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/\b(THREADLINE_[A-Z0-9_]+)\b/g)) found.add(m[1]!);
    for (const m of text.matchAll(/\b(?:process\.env|env)\.([A-Z][A-Z0-9_]+)\b/g)) found.add(m[1]!);
    for (const m of text.matchAll(/\benv\[['"]([A-Z][A-Z0-9_]+)['"]\]/g)) found.add(m[1]!);
  }
  // Имена прокси идут списком: PROXY_VARS в backends/http.ts.
  for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS']) found.add(name);
  for (const name of readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8').matchAll(/\$\{(THREADLINE_[A-Z0-9_]+)/g)) found.add(name[1]!);
  return [...found].filter((n) => !NOT_SETTINGS.has(n) && !n.endsWith('_NOT_SET')).sort();
}

describe('.env.example', () => {
  const example = read('.env.example');
  const documented = new Set([...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]!));

  it('называет каждую переменную, которую читает код', () => {
    const names = variablesInCode();
    expect(names.length).toBeGreaterThan(15);
    expect(names.filter((n) => !documented.has(n))).toEqual([]);
  });

  it('у каждой переменной есть описание с обязательностью', () => {
    const lines = example.split('\n');
    const missing: string[] = [];
    lines.forEach((line, i) => {
      const m = /^#?\s*([A-Z][A-Z0-9_]+)=/.exec(line);
      if (!m) return;
      let at = i - 1;
      // Подряд идущие переменные делят одно описание над первой из них.
      while (at >= 0 && /^#?\s*[A-Z][A-Z0-9_]+=/.test(lines[at]!)) at--;
      const about = lines.slice(Math.max(0, at - 4), at + 1).join(' ');
      if (!/Обязательн|Необязательн|Только для/.test(about)) missing.push(m[1]!);
    });
    expect(missing).toEqual([]);
  });

  it('значений секретов нет', () => {
    for (const name of ['THREADLINE_GRAFANA_TOKEN', 'THREADLINE_OIDC_CLIENT_SECRET', 'THREADLINE_SESSION_SECRET', 'THREADLINE_TELEGRAM_BOT_TOKEN', 'THREADLINE_DB_PASSWORD']) {
      expect(example).toMatch(new RegExp(`^#?\\s*${name}=$`, 'm'));
    }
  });
});

describe('исключения', () => {
  it('.gitignore закрывает .env и журналы', () => {
    const lines = read('.gitignore').split('\n');
    for (const line of ['.env', '.env.*', '!.env.example', 'logs.md', '*.log']) expect(lines).toContain(line);
  });

  it('.dockerignore закрывает лишнее', () => {
    const lines = read('.dockerignore').split('\n');
    for (const line of ['.git', '.env', '.env.*', '**/*.log', 'logs.md', 'dev', '**/*.pem', '**/*.key', 'apps/server/test', 'apps/web/e2e', '**/*.test.ts']) expect(lines).toContain(line);
  });
});

describe('Dockerfile', () => {
  it('предел кучи под под 1 ГиБ в последнем этапе, переменной пода его можно заменить', () => {
    const final = read('Dockerfile').split(/^FROM /m).at(-1)!;
    expect(final).toMatch(/^ENV NODE_OPTIONS=--max-old-space-size=640$/m);
    // В CMD флага нет: иначе NODE_OPTIONS пода его бы не заменила.
    expect(final.match(/^CMD .*$/m)?.[0]).not.toContain('max-old-space-size');
  });
});

describe('настоящие адреса', () => {
  it('внутренней подсети нет в файлах, которые попадут в репозиторий', () => {
    // Шаблон собран из частей, чтобы этот файл сам под него не попадал.
    const pattern = new RegExp(`\\b${'10'}\\.${'10'}\\.\\d+\\.\\d+`);
    const found = walk(ROOT)
      .filter((file) => {
        try {
          return pattern.test(readFileSync(file, 'utf8'));
        } catch {
          return false;
        }
      })
      .map((file) => relative(ROOT, file));
    expect(found).toEqual([]);
  });
});
