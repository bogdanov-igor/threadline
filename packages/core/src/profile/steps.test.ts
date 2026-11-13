import { describe, expect, it } from 'vitest';
import { buildView } from '../search/records.ts';
import { API_LABELS, app, CARDS_CID, record } from '../search/test-fixtures.ts';
import { builtinProfile, BUILTIN_PROFILE } from './builtin.ts';
import { compileProfile } from './compile.ts';
import { checkProfile } from './schema.ts';
import { ACME_PROFILE } from './test-acme.ts';

// Правила шага графа. Записи выдуманы.

const at = '2026-11-02T15:24:52.110000';
const clone = <T>(v: T): T => structuredClone(v);
const parse = (r: Record<string, unknown>, labels = API_LABELS) => builtinProfile().parse(record(r, labels));

describe('шаг db встроенного профиля json', () => {
  it('запрос к базе с длительностью — подсказка «база данных», вид записи прежний', () => {
    const r = parse(app('db query', { step: 'db', duration_ms: 340, ctx: { host: 'db.pay.example', port: 5432 } }, at, CARDS_CID));
    expect(r.kind).toBe('log');
    expect(r.flow).toEqual({ as: 'db', durationMs: 340, host: null, title: null });
    // Хост базы в подсказку не идёт: систему базы называет справочник. Контекст записи показывается как есть.
    expect(r.context).toEqual({ host: 'db.pay.example', port: 5432 });
    const [v] = buildView([r], { withOffsets: true });
    expect(v!.flow).toEqual({ as: 'db', durationMs: 340, host: null, title: null });
    expect(v!.kind).toBe('log');
  });

  it('длительность строкой из цифр — число; «fast» или нет поля — без длительности', () => {
    expect(parse(app('db query', { step: 'db', duration_ms: '12.5' }, at, CARDS_CID)).flow?.durationMs).toBe(12.5);
    expect(parse(app('db query', { step: 'db', duration_ms: 'fast' }, at, CARDS_CID)).flow).toMatchObject({ as: 'db', durationMs: null });
    expect(parse(app('db query', { step: 'db' }, at, CARDS_CID)).flow).toMatchObject({ as: 'db', durationMs: null });
  });

  it('шаг wait: ожидание с длительностью', () => {
    const r = parse(app('retry backoff', { step: 'wait', duration_ms: 2000, ctx: { attempt: 2 } }, at, CARDS_CID));
    expect(r.kind).toBe('log');
    expect(r.flow).toEqual({ as: 'wait', durationMs: 2000, host: null, title: null });
    expect(r.context).toEqual({ attempt: 2 });
  });

  it('запись без correlation_id — подсказка есть, в запрос она не входит по правилам списка запросов', () => {
    const r = parse(app('db query', { step: 'db', duration_ms: 3 }, at, ''));
    expect(r.correlationId).toBeNull();
    expect(r.flow?.as).toBe('db');
  });

  it('другие записи, другой шаг и запись Kafka — без подсказки', () => {
    expect(parse(app('kafka event consumed', { ctx: { topic: 'cards' } }, at, CARDS_CID)).flow).toBeUndefined();
    expect(parse(app('cache hit', { step: 'cache', duration_ms: 1 }, at, CARDS_CID)).flow).toBeUndefined();
    const [v] = buildView([parse(app('ok', {}, at, CARDS_CID))], { withOffsets: true });
    expect('flow' in v!).toBe(false);
  });

  it('у отправки правило шага не действует', () => {
    const r = parse(app('http request sending', { step: 'db', duration_ms: 5, upstream: { method: 'POST', url: 'http://x/y' } }, at, CARDS_CID));
    expect(r.kind).toBe('send');
    expect(r.flow).toBeUndefined();
  });
});

describe('правила шага в своём профиле', () => {
  it('правило не для лога: условие выполнено у отправки — подсказки нет', () => {
    const p = clone(ACME_PROFILE);
    p.variants[0]!.steps = [{ as: 'wait', when: { has: ['rec.msg'] } }];
    expect(checkProfile(p)).toMatchObject({ ok: true });
    const c = compileProfile('acme', p);
    const line = (msg: string) => ({
      tsNs: '1762078000000000000',
      labels: { container: 'app' },
      line: JSON.stringify({ ts: '2026-11-02T10:00:00Z', msg, trace_id: 'c-1', http: { url: 'https://pay.example/x', method: 'POST' } }),
    });
    const send = c.parse(line('outgoing request'));
    expect(send.kind).toBe('send');
    expect(send.flow).toBeUndefined();
    expect(c.parse(line('sleeping')).flow).toEqual({ as: 'wait', durationMs: null, host: null, title: null });
  });

  it('профиль без правил шага — подсказок нет', () => {
    const c = compileProfile('acme', ACME_PROFILE);
    const r = c.parse({ tsNs: '1762078000000000000', labels: { container: 'app' }, line: JSON.stringify({ ts: '2026-11-02T10:00:00Z', msg: 'hi', trace_id: 'c-1' }) });
    expect(r.kind).toBe('log');
    expect(r.flow).toBeUndefined();
  });

  it('первое выполненное правило; подпись и хост из путей', () => {
    const p = clone(BUILTIN_PROFILE);
    p.variants[0]!.steps = [
      { as: 'wait', when: { equals: { 'rec.msg': 'sleep' } }, fields: { durationMs: 'rec.ctx.delay', title: 'rec.ctx.reason', host: 'rec.ctx.host' } },
      { as: 'db', when: { has: ['rec.ctx.delay'] } },
    ];
    const c = compileProfile('json2', p);
    const r = c.parse(record(app('sleep', { ctx: { delay: 1000, reason: 'retry policy', host: 'q1' } }, at, CARDS_CID)));
    expect(r.flow).toEqual({ as: 'wait', durationMs: 1000, host: 'q1', title: 'retry policy' });
  });
});

describe('проверка правил шага при старте', () => {
  it('неизвестный вид cache или queue и путь к неизвестному слою — ошибки с путём, все сразу', () => {
    const p = clone(BUILTIN_PROFILE) as unknown as { variants: { steps?: unknown[] }[] };
    p.variants[0]!.steps = [
      { as: 'cache', when: { has: ['rec.msg'] } },
      { as: 'queue' },
      // Слой req есть только у варианта шлюза.
      { as: 'db', fields: { durationMs: 'req.ms' } },
      { as: 'db', when: { has: ['nope.x'] } },
    ];
    const r = checkProfile(p);
    expect(r.ok).toBe(false);
    const issues = r.ok ? [] : r.issues;
    expect(issues.map((i) => i.path)).toEqual([
      'variants.0(app).steps.0.as',
      'variants.0(app).steps.1.as',
      'variants.0(app).steps.2.fields.durationMs',
      'variants.0(app).steps.3.when.has.0',
    ]);
    expect(issues[0]!.message).toContain('db, wait');
  });

  it('встроенный профиль json со своими правилами проходит проверку', () => {
    expect(checkProfile(BUILTIN_PROFILE)).toMatchObject({ ok: true });
    expect(BUILTIN_PROFILE.variants[0]!.steps!.map((s) => s.as)).toEqual(['db', 'wait']);
  });
});
