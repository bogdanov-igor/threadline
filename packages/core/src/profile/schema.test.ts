import { describe, expect, it } from 'vitest';
import { BUILTIN_PROFILE } from './builtin.ts';
import { checkProfile } from './schema.ts';
import { ACME_PROFILE } from './test-acme.ts';

const clone = <T>(v: T): T => structuredClone(v);
const issues = (p: unknown) => {
  const r = checkProfile(p);
  return r.ok ? [] : r.issues;
};
const paths = (p: unknown) => issues(p).map((i) => i.path);

describe('проверка профиля', () => {
  it('json и acme проходят', () => {
    expect(issues(BUILTIN_PROFILE)).toEqual([]);
    expect(issues(ACME_PROFILE)).toEqual([]);
  });

  it('путь к неизвестному слою: путь с именем варианта и известные слои', () => {
    const p = clone(ACME_PROFILE);
    p.variants[0]!.fields!.time = 'rex.ts';
    const [i] = issues(p);
    expect(i).toEqual({ path: 'variants.0(app).fields.time', message: expect.stringContaining('известные слои: rec') });
  });

  it('слой варианта не виден другому варианту', () => {
    const p = clone(ACME_PROFILE);
    p.variants[1]!.fields!.message = 'rec.msg';
    expect(paths(p)).toEqual(['variants.1(nginx).fields.message']);
  });

  it('from — только слой, объявленный раньше', () => {
    const p = { layers: [{ name: 'a', decode: 'json', from: 'b.x' }, { name: 'b', decode: 'json' }], variants: [{ name: 'v', fields: { correlationId: 'b.cid' } }] };
    expect(paths(p)).toEqual(['layers.0.from']);
  });

  it('выражение слоя text: не компилируется, без групп, с просмотром назад; pattern у другого декодера', () => {
    const p = clone(ACME_PROFILE);
    p.variants[1]!.layers![0]!.pattern = '^(?<ip>\\S+';
    expect(issues(p)).toEqual([{ path: 'variants.1(nginx).layers.0.pattern', message: expect.stringContaining('не компилируется') }]);
    p.variants[1]!.layers![0]!.pattern = '^\\S+ (\\d+)';
    expect(issues(p)[0]!.message).toContain('именованных групп');
    p.variants[1]!.layers![0]!.pattern = '(?<=x)(?<status>\\d+)';
    expect(issues(p)[0]!.message).toContain('просмотр');
    const q = clone(ACME_PROFILE);
    q.variants[0]!.layers![0]!.pattern = 'x';
    expect(paths(q)).toEqual(['variants.0(app).layers.0.pattern']);
    const r = clone(ACME_PROFILE);
    delete r.variants[1]!.layers![0]!.pattern;
    expect(paths(r)).toEqual(['variants.1(nginx).layers.0.pattern']);
  });

  it('выражение, которое JS и RE2 читают по-разному: экранирование, класс POSIX, класс с «]» в начале, повтор больше 1000', () => {
    const cases: [string, string][] = [
      ['(?<status>\\p{L}+)', '\\p'],
      ['(?<status>\\P{L}+)', '\\P'],
      ['(?<status>[[:alnum:]]+)', 'POSIX'],
      ['\\A(?<status>\\d+)', '\\A'],
      ['(?<status>\\d+)\\z', '\\z'],
      ['\\Q.\\E(?<status>\\d+)', '\\Q'],
      ['\\C(?<status>\\d+)', '\\C'],
      ['\\x{41}(?<status>\\d+)', '\\x{'],
      ['\\a(?<status>\\d+)', '\\a'],
      ['(?<status>[\\b]\\d+)', '\\b'],
      // [^] в JS — любой символ: просмотр вперёд внутри «класса» прошёл бы проверку.
      ['(?<status>[^](?=x)]y)', '«]»'],
      ['(?<status>[^](?<=x)]y)', '«]»'],
      ['(?<status>[]a]+)', '«]»'],
      ['x(?<status>\\d{1,2000})', '{1,2000}'],
      ['x(?<status>\\d{1001})', '{1001}'],
    ];
    for (const [pattern, word] of cases) {
      const p = clone(ACME_PROFILE);
      p.variants[1]!.layers![0]!.pattern = pattern;
      expect(issues(p), pattern).toEqual([{ path: 'variants.1(nginx).layers.0.pattern', message: expect.stringContaining(word) }]);
    }
    const q = { ...clone(ACME_PROFILE), count: { regexp: 'x(?P<cid>\\d{1,2000})' } };
    expect(issues(q)).toEqual([{ path: 'count.regexp', message: expect.stringContaining('больше 1000') }]);
    q.count.regexp = 'x(?P<cid>\\p{L}+)';
    expect(paths(q)).toEqual(['count.regexp']);
    // Знаки препинания, \xHH, \] в классе и повтор до 1000 допустимы.
    q.count.regexp = '\\-\\/\\x41[\\]a-]\\d{1000}(?P<cid>\\w+)';
    expect(issues(q)).toEqual([]);
  });

  it('имена слоёв и вариантов не повторяются', () => {
    const p = clone(BUILTIN_PROFILE);
    p.variants[1]!.layers![1]!.name = 'rec';
    p.variants[1]!.name = 'app';
    expect(paths(p)).toEqual(expect.arrayContaining(['variants.1(app).layers.1.name', 'variants.1(app).name']));
  });

  it('неизвестный вид: перечисляет допустимые', () => {
    const p = clone(ACME_PROFILE) as unknown as { variants: { kinds: { kind: string }[] }[] };
    p.variants[0]!.kinds[0]!.kind = 'request';
    expect(issues(p)).toEqual([{ path: 'variants.0(app).kinds.0.kind', message: expect.stringContaining('incoming, call, send, response, log') }]);
  });

  it('нет correlationId ни в одном варианте', () => {
    const p = clone(ACME_PROFILE);
    delete p.variants[0]!.fields!.correlationId;
    expect(issues(p)).toEqual([{ path: 'variants', message: expect.stringContaining('correlationId') }]);
  });

  it('выражение подсчёта: без группы cid — путь count.regexp; просмотр — хранилище не выполнит', () => {
    const p = { ...clone(ACME_PROFILE), count: { regexp: 'trace_id":"(?P<id>[a-z0-9.-]+)' } };
    expect(issues(p)).toEqual([{ path: 'count.regexp', message: expect.stringContaining('(?P<cid>') }]);
    p.count.regexp = '(?=x)(?P<cid>\\d+)';
    expect(issues(p)[0]!.message).toContain('хранилище такое выражение не выполнит');
  });

  it('нужно явное выражение подсчёта: correlation_id из слоя text с from', () => {
    const p = {
      layers: [{ name: 'rec', decode: 'json' }],
      variants: [{ name: 'app', layers: [{ name: 't', decode: 'text', from: 'rec.msg', pattern: 'rid=(?<rid>\\d+)' }], fields: { correlationId: 't.rid' } }],
    };
    expect(issues(p)).toEqual([{ path: 'variants.0(app).fields.correlationId', message: expect.stringContaining('count.regexp') }]);
  });

  it('gateways без component, уровни вне шкалы, неизвестное поле, неизвестный декодер', () => {
    expect(paths({ ...clone(ACME_PROFILE), component: undefined, gateways: ['gw'] })).toEqual(['gateways']);
    expect(paths({ ...clone(ACME_PROFILE), levels: { WARN: 3000 } })).toEqual(['levels.WARN']);
    const p = clone(ACME_PROFILE) as unknown as { variants: Record<string, unknown>[]; layers?: unknown };
    p.variants[0]!.extra = 1;
    expect(paths(p)).toEqual(['variants.0(app)']);
    expect(paths({ ...clone(ACME_PROFILE), layers: [{ name: 'x', decode: 'xml' }] })).toEqual(['layers.0.decode']);
  });

  it('пустой сегмент пути, нет вариантов', () => {
    const p = clone(ACME_PROFILE);
    p.variants[0]!.fields!.uri = 'rec..url';
    expect(paths(p)).toEqual(['variants.0(app).fields.uri']);
    expect(paths({ variants: [] })).toEqual(['variants']);
  });

  it('несколько ошибок приходят вместе, у каждой свой путь', () => {
    const p = clone(ACME_PROFILE) as unknown as { variants: { fields: Record<string, unknown>; kinds?: { kind: string }[]; layers?: { pattern?: string }[] }[] };
    p.variants[0]!.fields.time = 'nope.ts';
    p.variants[0]!.kinds![1]!.kind = 'request';
    p.variants[1]!.layers![0]!.pattern = '(';
    expect(paths(p).sort()).toEqual(['variants.0(app).fields.time', 'variants.0(app).kinds.1.kind', 'variants.1(nginx).layers.0.pattern']);
  });
});
