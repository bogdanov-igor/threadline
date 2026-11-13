import { afterEach, describe, expect, it } from 'vitest';
import { detectTerm, phonePattern, setRegional } from '@threadline/core/search';
import { countLogql, linesLogql, pipeline, quote, selector } from '../src/backends/logql.ts';
import { builtinCountKey } from './count-key.ts';

describe('LogQL', () => {
  afterEach(() => setRegional(null));

  it('экранирует значения', () => {
    expect(quote('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(quote('line\nnext\ttab')).toBe('"line\\nnext\\ttab"');
    expect(quote('|{}^$.*+?()[]')).toBe('"|{}^$.*+?()[]"');
    expect(quote('\u0001')).toBe('"\\x01"');
  });

  it('строит селектор', () => {
    expect(
      selector([
        { label: 'cluster', op: '=', value: 'demo' },
        { label: 'container', op: '!=', value: 'pgadmin' },
      ]),
    ).toBe('{cluster="demo", container!="pgadmin"}');
  });

  it('не даёт выйти за селектор', () => {
    const q = selector([{ label: 'namespace', op: '=', value: 'pay' }]) + pipeline([{ kind: 'contains', value: '"} or {namespace="other' }]);
    expect(q).toBe('{namespace="pay"} |= "\\"} or {namespace=\\"other"');
  });

  it('шаблон телефона: строка в запросе чтения и подсчёта, без плана номеров — все цифры с разделителями', () => {
    const t = detectTerm('+44 7700 900001');
    if ('error' in t) throw new Error('ожидалось значение');
    expect(t.filter).toEqual({ kind: 'regex', pattern: phonePattern('447700900001') });
    const sel = [{ label: 'namespace', op: '=' as const, value: 'pay' }];
    const pipe = `|~ "${[...'447700900001'].join('[ ()-]{0,2}')}"`;
    expect(linesLogql(sel, [t.filter])).toBe(`{namespace="pay"} ${pipe}`);
    expect(countLogql({ selector: sel, filters: [t.filter], range: { fromMs: 0, toMs: 1 }, ...builtinCountKey() }, 3600)).toContain(`{namespace="pay"} ${pipe} | regexp`);
  });

  it('шаблон телефона с планом номеров страны — по национальному номеру', () => {
    setRegional({ phone: { countryCode: '44', nationalDigits: 10, trunkPrefix: '0' }, patterns: {} });
    const t = detectTerm('+44 7700 900001');
    if ('error' in t) throw new Error('ожидалось значение');
    const sel = [{ label: 'namespace', op: '=' as const, value: 'pay' }];
    expect(linesLogql(sel, [t.filter])).toBe(`{namespace="pay"} |~ "${[...'7700900001'].join('[ ()-]{0,2}')}"`);
  });

  it('строит исключение по выражению с экранированием, одно !~ селектором не считается', () => {
    const ns = { label: 'namespace', op: '=' as const, value: 'pay-test' };
    expect(selector([ns, { label: 'container', op: '!~', value: 'worker-.*|a"b\\d' }])).toBe('{namespace="pay-test", container!~"worker-.*|a\\"b\\\\d"}');
    expect(selector([ns, { label: 'container', op: '!~', value: '"} or {namespace="other' }])).toBe('{namespace="pay-test", container!~"\\"} or {namespace=\\"other"}');
    expect(() => selector([{ label: 'container', op: '!~', value: 'x' }])).toThrow();
    expect(() => selector([{ label: 'container', op: '!~', value: '' }, { label: 'app', op: '!=', value: 'x' }])).toThrow();
  });

  it('отклоняет селектор без равенства и неверную метку', () => {
    expect(() => selector([{ label: 'container', op: '!=', value: 'x' }])).toThrow();
    expect(() => selector([{ label: 'a"b', op: '=', value: 'x' }])).toThrow();
  });
});
