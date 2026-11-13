import { describe, expect, it } from 'vitest';
import { checkCountRegexp, countRegexpOf, isCountKey } from './count.ts';
import { BUILTIN_COUNT_REGEXP, BUILTIN_PROFILE } from './builtin.ts';
import { checkRe2, re2Canonical, re2ToJs, renameGroups } from './regex.ts';
import { ACME_PROFILE } from './test-acme.ts';
import type { Profile } from './types.ts';

const key = (re: string, line: string) => re2ToJs(re).exec(line)?.groups?.cid ?? null;

/** Строка на уровне экранирования n: JSON в строке JSON n раз. */
function nest(obj: unknown, levels: number): string {
  let s = JSON.stringify(obj);
  for (let i = 1; i < levels; i++) s = JSON.stringify({ message: s });
  return s;
}

const derived = (p: Profile) => {
  const r = countRegexpOf(p);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.regexp;
};

const jsonProfile = (correlationId: string | string[], count?: string): Profile => ({
  variants: [{ name: 'app', layers: [{ name: 'rec', decode: 'json' }], fields: { correlationId } }],
  ...(count ? { count: { regexp: count } } : {}),
});

describe('выражение подсчёта', () => {
  it('json: явное выражение встроенного профиля', () => {
    expect(derived(BUILTIN_PROFILE)).toBe(BUILTIN_COUNT_REGEXP);
  });

  it('json: ключ верхнего уровня, пробел после двоеточия, заголовок шлюза; ключ в строке тела не подходит', () => {
    const re = BUILTIN_COUNT_REGEXP;
    expect(key(re, '{"time":"t","msg":"m","correlation_id":"abc-1","ctx":{"correlation_id":"other"}}')).toBe('abc-1');
    expect(key(re, '{"msg": "m", "correlation_id": "py-1"}')).toBe('py-1');
    expect(key(re, JSON.stringify({ msg: 'm', upstream: { body: JSON.stringify({ correlation_id: 'body-1' }) } }))).toBeNull();
    expect(key(re, JSON.stringify({ msg: 'm', raw_request: 'GET /x HTTP/1.1\r\nX-Partner-Correlation-Id: other\r\nx-correlation-id: gw-1\r\n\r\n' }))).toBe('gw-1');
    expect(key(re, JSON.stringify({ msg: 'm', correlation_id: null }))).toBeNull();
  });

  it('acme: выводится из rec.trace_id и находит ключ на трёх уровнях экранирования', () => {
    const re = derived(ACME_PROFILE);
    expect(re).toBe('(?i).*(?:\\\\*"trace_id\\\\*":\\s*\\\\*"?)(?P<cid>[0-9a-z._:-]+)');
    for (const n of [1, 2, 3]) expect(key(re, nest({ ts: 1, trace_id: 'order-77.a1', msg: 'x' }, n)), String(n)).toBe('order-77.a1');
    expect(key(re, nest({ trace_id: 6300014100001 }, 2))).toBe('6300014100001');
    expect(key(re, '{"trace_id": "spaced"}')).toBe('spaced');
    expect(key(re, '{"msg":"no id"}')).toBeNull();
  });

  it('вложенный ключ: перед ним родитель, ключ в другом объекте не подходит', () => {
    const re = derived(jsonProfile('rec.extra.correlation_id'));
    expect(key(re, nest({ context: { correlation_id: 'body-one' }, extra: { uid: 1, correlation_id: 'real' } }, 2))).toBe('real');
    expect(key(re, nest({ context: { correlation_id: 'body-one' } }, 2))).toBeNull();
  });

  it('родитель с пробелами (json.dumps), соседний объект перед ключом; глубже одного уровня — не видит', () => {
    const re = derived(jsonProfile('rec.req.id'));
    expect(key(re, '{"req": {"id": "abc-1"}}')).toBe('abc-1');
    expect(key(re, JSON.stringify({ req: { id: 'abc-1' } }, null, 2))).toBe('abc-1');
    for (const n of [1, 2, 3]) expect(key(re, nest({ req: { headers: { a: 1, b: [2] }, id: 'abc-1' } }, n)), String(n)).toBe('abc-1');
    expect(key(re, '{"req":{"h":{"id":"inner"}}}')).toBeNull();
    // Объект во вложенном объекте или скобка в строке перед ключом: нужно явное count.regexp (config/README.md).
    expect(key(re, '{"req":{"h":{"a":{"b":1}},"id":"abc-1"}}')).toBeNull();
    expect(key(re, '{"req":{"note":"a{b","id":"abc-1"}}')).toBeNull();
  });

  it('литералы null, true и false — не ключ подсчёта', () => {
    const re = derived(ACME_PROFILE);
    for (const v of ['null', 'true', 'false', 'NULL']) {
      const k = key(re, `{"ts":1,"trace_id":${v},"msg":"x"}`);
      expect(k?.toLowerCase()).toBe(v.toLowerCase());
      expect(isCountKey(k), v).toBe(false);
    }
    expect(['nullable-1', '6300014100001', 'true1'].every((k) => isCountKey(k))).toBe(true);
    expect([undefined, null, ''].some((k) => isCountKey(k))).toBe(false);
  });

  it('ключ с точкой: оба написания, ключ id с родителем допустим', () => {
    const re = derived(jsonProfile('rec.trace.id'));
    expect(key(re, nest({ 'trace.id': 'flat-1' }, 2))).toBe('flat-1');
    expect(key(re, nest({ trace: { id: 'nested-1' } }, 2))).toBe('nested-1');
    expect(key(re, nest({ id: 'just-id' }, 2))).toBeNull();
  });

  it('заголовок HTTP: строка заголовка в сыром сообщении на любом уровне', () => {
    const p: Profile = {
      variants: [
        {
          name: 'gw',
          layers: [
            { name: 'g', decode: 'json' },
            { name: 'req', decode: 'http', from: 'g.raw' },
          ],
          fields: { correlationId: 'req.headers.X-Trace-Id' },
        },
      ],
    };
    const re = derived(p);
    const raw = 'GET /x HTTP/1.1\r\nX-Partner-X-Trace-Id: other\r\nx-trace-id: tr-1\r\n\r\n';
    expect(key(re, JSON.stringify({ raw }))).toBe('tr-1');
    expect(key(re, nest({ raw }, 3))).toBe('tr-1');
    expect(key(re, raw)).toBe('tr-1');
    expect(key(re, raw.replace(/\r\n/g, '\n'))).toBe('tr-1');
  });

  it('слой text по строке хранилища: выражение подсчёта — его шаблон с группой cid', () => {
    const p: Profile = {
      variants: [{ name: 'plain', layers: [{ name: 't', decode: 'text', pattern: '(?i)^(?P<lvl>\\w+) rid=(?<rid>[0-9a-f-]+)' }], fields: { correlationId: 't.rid', level: 't.lvl' } }],
    };
    const re = derived(p);
    expect(re).toBe('(?i)^(?:\\w+) rid=(?P<cid>[0-9a-f-]+)');
    expect(key(re, 'INFO rid=ab-12 done')).toBe('ab-12');
  });

  it('нужно явное выражение: слой text с from, ключ id без родителя, индекс массива, не заголовок http', () => {
    const cases: Profile[] = [
      { layers: [{ name: 'rec', decode: 'json' }], variants: [{ name: 'a', layers: [{ name: 't', decode: 'text', from: 'rec.msg', pattern: 'rid=(?P<rid>\\d+)' }], fields: { correlationId: 't.rid' } }] },
      jsonProfile('rec.id'),
      jsonProfile('rec.ids.0'),
      { variants: [{ name: 'a', layers: [{ name: 'r', decode: 'http' }], fields: { correlationId: 'r.uri' } }] },
      // text и json вместе: одно выражение не покроет оба.
      { variants: [{ name: 'a', layers: [{ name: 't', decode: 'text', pattern: 'rid=(?P<rid>\\d+)' }, { name: 'j', decode: 'json' }], fields: { correlationId: ['t.rid', 'j.cid'] } }] },
    ];
    for (const p of cases) {
      const r = countRegexpOf(p);
      expect(r.ok, JSON.stringify(p.variants[0]!.fields)).toBe(false);
      if (!r.ok) expect(r.issues.map((i) => i.message).join()).toContain('count.regexp');
    }
    // С явным выражением те же профили проходят.
    expect(countRegexpOf(jsonProfile('rec.id', 'rid=(?P<cid>\\d+)')).ok).toBe(true);
  });

  it('проверка явного выражения: запрещённые конструкции и группы', () => {
    expect(checkCountRegexp(BUILTIN_COUNT_REGEXP)).toBeNull();
    expect(checkCountRegexp('x(?=y)(?P<cid>\\d+)')).toMatch(/просмотр/);
    expect(checkCountRegexp('(?<!y)(?P<cid>\\d+)')).toMatch(/просмотр/);
    expect(checkCountRegexp('(?P<cid>a)\\1')).toMatch(/обратная ссылка/);
    expect(checkCountRegexp('(?P<cid>a)\\k<cid>')).toMatch(/обратная ссылка/);
    expect(checkCountRegexp('(?P<id>\\d+)')).toMatch(/cid/);
    expect(checkCountRegexp('(?P<cid>\\d+)-(?P<other>\\d+)')).toMatch(/cid/);
    expect(checkCountRegexp('(\\d+)')).toMatch(/cid/);
    expect(checkCountRegexp('(?P<cid>[a-')).toMatch(/не компилируется/);
    expect(checkCountRegexp('a(?i)(?P<cid>b)')).toMatch(/флаги/);
    // Экранированная скобка и класс — не группа и не просмотр.
    expect(checkCountRegexp('\\(?=[(?=](?P<cid>x)')).toBeNull();
  });
});

describe('диалект выражений', () => {
  it('флаги и группы в JS', () => {
    const re = re2ToJs('(?is)a.(?P<x>b)');
    // (?i) раскрыт в классы: с флагом i линейный движок V8 выражение не берёт.
    expect(re.flags).toBe('s');
    expect(re.exec('A\nB')?.groups?.x).toBe('B');
    expect(checkRe2('(?P<a>x)(?<b>y)').ok && checkRe2('(?P<a>x)(?<b>y)')).toMatchObject({ info: { groups: ['a', 'b'] } });
    expect(checkRe2('(?P<a>x)(?<a>y)')).toMatchObject({ ok: false });
  });

  it('(?i) без флага i: буквы вне классов и в классах, \\xHH, кириллица, отрицание; имена групп не меняются', () => {
    const re = re2ToJs('(?i)abc[0-9a-f._:-]+\\x41(?P<Name>z)[^q]');
    expect(re.flags).toBe('');
    expect(re.exec('ABC9F.:-aZ!')?.groups).toEqual({ Name: 'Z' });
    expect(re.test('abcxAz!')).toBe(false);
    expect(re.test('abc0azq')).toBe(false);
    expect(re.test('abc0azQ')).toBe(false);
    expect(re.test('abc0az ')).toBe(true);
    expect(re2ToJs('(?i)ошибка').test('ОшИбКа')).toBe(true);
    // Дефис в конце класса остаётся символом: добавленный A-Z с ним не склеивается.
    const cls = re2ToJs('(?i)^[a-c:-]+$');
    expect(['aBc:-', 'C-'].map((s) => cls.test(s))).toEqual([true, true]);
    expect(cls.test('9')).toBe(false);
    expect(re2ToJs('(?i)[\\]\\-x]').test('X')).toBe(true);
    expect(re2ToJs(BUILTIN_COUNT_REGEXP).flags).toBe('');
    expect(key(BUILTIN_COUNT_REGEXP, '{"MSG":"m","Correlation_ID":"AbC-1"}')).toBe('AbC-1');
  });

  it('для хранилища — форма (?P<имя>…), переименование групп вне классов', () => {
    expect(re2Canonical('a(?<x>b)[(?<y>]')).toBe('a(?P<x>b)[(?<y>]');
    expect(renameGroups('(?P<a>1)(?<b>2)', (n) => (n === 'a' ? '(?P<cid>' : '(?:'))).toBe('(?P<cid>1)(?:2)');
  });
});
