// Выражение слоя text с катастрофическим перебором не вешает разбор: сервер включает линейный движок V8.
import '../src/regexp-guard.ts';
import { describe, expect, it } from 'vitest';
import { BUILTIN_COUNT_REGEXP, checkProfile, compileProfile, re2ToJs, type Profile } from '@threadline/core/profile';

const profile = (pattern: string): Profile => ({
  variants: [{ name: 'plain', when: { has: ['t.status'] }, layers: [{ name: 't', decode: 'text', pattern }], fields: { correlationId: 't.cid', status: 't.status' } }],
  count: { regexp: 'cid=(?P<cid>\\w+)' },
});

const NGINX = '^(?<ip>\\S+) .* \\[(?<time>.*)\\] "(?<method>.*) (?<uri>.*) (?<proto>.*)" (?<status>\\d+) .*$';
const NGINX_LINE = `1.2.3.4 - - [x] "GET /a b c" ${'x '.repeat(3200)}`;

/** Время разбора строк в мс. */
function parseMs(p: Profile, line: string, times: number): number {
  const c = compileProfile('x', p);
  const t = performance.now();
  for (let i = 0; i < times; i++) expect(c.parse({ tsNs: '1', line, labels: {} }).kind).toBe('text');
  return performance.now() - t;
}

describe('защита от перебора', () => {
  it('вложенный повтор на несовпавшей строке', () => {
    expect(parseMs(profile('^(?<cid>(\\w+\\s?)+)(?<status>!)$'), `${'a'.repeat(40)}?`, 1)).toBeLessThan(500);
  });

  it('шаблон nginx с несколькими .*: 1000 несовпавших строк по 6 КБ', () => {
    expect(parseMs(profile(NGINX), NGINX_LINE, 1000)).toBeLessThan(3000);
  });

  // С флагом i линейный движок выражение не берёт: (?i) раскрывается в классы, и защита работает.
  it('(?i) не отключает защиту: вложенный повтор и шаблон nginx', () => {
    expect(checkProfile(profile('(?i)^(?<cid>(\\w+\\s?)+)(?<status>!)$')).ok).toBe(true);
    expect(parseMs(profile('(?i)^(?<cid>(\\w+\\s?)+)(?<status>!)$'), `${'a'.repeat(40)}?`, 1)).toBeLessThan(500);
    expect(checkProfile(profile(`(?i)${NGINX}`)).ok).toBe(true);
    expect(parseMs(profile(`(?i)${NGINX}`), NGINX_LINE, 200)).toBeLessThan(3000);
  });

  it('повтор больше 16 линейный движок не выполнит: профиль не проходит проверку с путём и подсказкой', () => {
    const rid = NGINX.replace(/ \.\*\$$/, ' (?<rid>[0-9a-f]{32})$');
    expect(checkProfile(profile(rid))).toEqual({
      ok: false,
      issues: [{ path: 'variants.0(plain).layers.0.pattern', message: 'не выполняется линейным движком (повтор больше 16 — замените {32} на +)' }],
    });
    const nested = checkProfile(profile('^(?<cid>(?:ab{4}){5})(?<status>!)$'));
    expect(nested.ok === false && nested.issues[0]!.message).toMatch(/вложенные повторы/);
    // До 16 — можно; выражение подсчёта в хранилище выполняет RE2, его счётчик не ограничен шестнадцатью.
    expect(checkProfile(profile('^(?<cid>[0-9a-f]{16})(?<status>!)$')).ok).toBe(true);
    expect(checkProfile({ ...profile(NGINX), count: { regexp: 'rid=(?P<cid>[0-9a-f]{32})' } }).ok).toBe(true);
  });

  it('выражение подсчёта встроенного формата json (с (?i) и \\s*) на несовпавшей строке 34 КБ — линейно', () => {
    const re = re2ToJs(BUILTIN_COUNT_REGEXP);
    const line = `{"msg":"${'"correlation_id": 1,\\r\\nX-Correlation-Id: !'.repeat(800)}"}`;
    expect(line.length).toBeGreaterThan(34_000);
    const t = performance.now();
    for (let i = 0; i < 20; i++) expect(re.exec(line)).toBeNull();
    expect(performance.now() - t).toBeLessThan(500);
  });
});
