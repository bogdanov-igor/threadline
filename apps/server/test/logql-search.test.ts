import { describe, expect, it } from 'vitest';
import type { CountQuery } from '@threadline/core/backend';
import { BUILTIN_COUNT_REGEXP } from '@threadline/core/profile';
import { countLogql, escapeRegex, linesLogql, lokiCountRegexp, pipeline, quote } from '../src/backends/logql.ts';

// Выражение подсчёта встроенного формата json в запросе Loki: группа cid становится threadline_key, остальное символ в символ.
const CORRELATION_ID_REGEXP = lokiCountRegexp(BUILTIN_COUNT_REGEXP);

const sel = [
  { label: 'cluster', op: '=' as const, value: 'demo' },
  { label: 'namespace', op: '=' as const, value: 'pay' },
];

const count = (over: Partial<CountQuery> = {}): CountQuery => ({
  selector: sel,
  filters: [],
  range: { fromMs: 0, toMs: 3_600_000 },
  key: { regexp: BUILTIN_COUNT_REGEXP },
  ...over,
});

describe('LogQL подсчёта', () => {
  // Регулярное выражение по сырой строке, без | json.
  const REGEXP_LOGQL = String.raw`| regexp "(?i)(?:\"correlation_id\":\\s*\"|\\\\r\\\\nX-Correlation-Id:\\s*)(?P<threadline_key>[0-9a-z._:-]+)"`;

  it('строит запрос подсчёта', () => {
    const q = count({
      filters: [
        { kind: 'contains', value: 'v1' },
        { kind: 'regex', pattern: 're' },
      ],
    });
    expect(countLogql(q, 3600)).toBe(
      'sum by (threadline_key) (count_over_time({cluster="demo", namespace="pay"} |= "v1" |~ "re"' +
        ` ${REGEXP_LOGQL}` +
        ' | threadline_key!="" [3600s]))',
    );
  });

  it('текст выражения до экранирования строкой Go и после', () => {
    expect(CORRELATION_ID_REGEXP).toBe(String.raw`(?i)(?:"correlation_id":\s*"|\\r\\nX-Correlation-Id:\s*)(?P<threadline_key>[0-9a-z._:-]+)`);
    expect(quote(CORRELATION_ID_REGEXP)).toBe(String.raw`"(?i)(?:\"correlation_id\":\\s*\"|\\\\r\\\\nX-Correlation-Id:\\s*)(?P<threadline_key>[0-9a-z._:-]+)"`);
  });

  it('без фильтров идёт сразу выражение', () => {
    expect(countLogql(count(), 60)).toBe(
      `sum by (threadline_key) (count_over_time({cluster="demo", namespace="pay"} ${REGEXP_LOGQL} | threadline_key!="" [60s]))`,
    );
  });

  it('экранирует значения фильтров', () => {
    const q = countLogql(count({ filters: [{ kind: 'contains', value: 'a"} or {x="y\\' }] }), 1);
    expect(q).toContain('|= "a\\"} or {x=\\"y\\\\"');
    expect(q).not.toContain('| json');
  });

  it('отклоняет неверную длину интервала и выражение, которое хранилище не выполнит или не даст ключа', () => {
    expect(() => countLogql(count(), 0)).toThrow();
    expect(() => countLogql(count(), 1.5)).toThrow();
    expect(() => countLogql(count({ key: { regexp: '"level_name":"(?P<level>[A-Z]+)' } }), 60)).toThrow(/cid/);
    expect(() => countLogql(count({ key: { regexp: '(?=x)(?P<cid>\\d+)' } }), 60)).toThrow(/просмотр/);
    expect(() => countLogql(count({ key: { regexp: '(?P<cid>a)\\1' } }), 60)).toThrow(/обратная ссылка/);
  });

  it('группа (?<cid>…) в форме JS тоже уходит в Loki как (?P<threadline_key>…)', () => {
    expect(countLogql(count({ key: { regexp: 'trace=(?<cid>[0-9a-f]+)' } }), 60)).toContain('| regexp "trace=(?P<threadline_key>[0-9a-f]+)" | threadline_key!=""');
  });
});

describe('LogQL чтения', () => {
  it('селектор и фильтры без разбора', () => {
    expect(linesLogql(sel, [{ kind: 'contains', value: '5555 55' }, { kind: 'regex', pattern: '555555(?:\\d{6}|\\*{6})5727' }])).toBe(
      '{cluster="demo", namespace="pay"} |= "5555 55" |~ "555555(?:\\\\d{6}|\\\\*{6})5727"',
    );
  });

  it('исключение: `!=` и `!~` после условий поиска, значения в кавычках', () => {
    expect(linesLogql(sel, [{ kind: 'contains', value: 'abcdef' }, { kind: 'not-contains', value: 'a"b' }, { kind: 'not-regex', pattern: '555555(?:\\d{6}|\\*{6})5727' }])).toBe(
      '{cluster="demo", namespace="pay"} |= "abcdef" != "a\\"b" !~ "555555(?:\\\\d{6}|\\\\*{6})5727"',
    );
  });

  it('не даёт выйти за селектор', () => {
    expect(() => linesLogql([{ label: 'container', op: '!=', value: 'x' }], [])).toThrow();
  });
});

describe('escapeRegex', () => {
  it('экранирует все метасимволы RE2', () => {
    expect(escapeRegex('a.b*c+d?e(f)g|h[i]j{k}l^m$n\\o')).toBe('a\\.b\\*c\\+d\\?e\\(f\\)g\\|h\\[i\\]j\\{k\\}l\\^m\\$n\\\\o');
  });

  it('не трогает обычные символы', () => {
    expect(escapeRegex('7f3c2a1e-9b4d-4c8e-a5f6-0123456789ab')).toBe('7f3c2a1e-9b4d-4c8e-a5f6-0123456789ab');
    expect(escapeRegex('корр_id:42/x')).toBe('корр_id:42/x');
  });

  it('экранированное значение совпадает только буквально', () => {
    for (const s of ['a.b', 'x+y', '(a|b)', '^$', 'a\\d']) {
      const re = new RegExp(`^${escapeRegex(s)}$`);
      expect(re.test(s)).toBe(true);
    }
    expect(new RegExp(escapeRegex('a.b')).test('axb')).toBe(false);
  });

  it('список correlation_id: каждый экранирован, вместе — одно выражение в кавычках', () => {
    const cids = ['1730.5', 'a+b', 'plain-id', 'x"y'];
    const pattern = `(?:${cids.map(escapeRegex).join('|')})`;
    expect(pattern).toBe('(?:1730\\.5|a\\+b|plain-id|x"y)');
    expect(pipeline([{ kind: 'regex', pattern }])).toBe(' |~ "(?:1730\\\\.5|a\\\\+b|plain-id|x\\"y)"');
    const re = new RegExp(pattern);
    expect(re.test('id 1730.5 x')).toBe(true);
    expect(re.test('id 1730x5 x')).toBe(false);
    expect(re.test('aab')).toBe(false);
  });
});

describe('значения с формы проекта только как данные', () => {
  it.each([
    ['"} or {x="1', '{namespace="\\"} or {x=\\"1"}'],
    ['конец\\', '{namespace="конец\\\\"}'],
    ['а\nб', '{namespace="а\\nб"}'],
    ['{', '{namespace="{"}'],
    ['`', '{namespace="`"}'],
    ['\u2028', '{namespace="\u2028"}'],
  ])('%j не меняет структуру запроса', (value, expected) => {
    expect(linesLogql([{ label: 'namespace', op: '=', value }], [])).toBe(expected);
  });
});
