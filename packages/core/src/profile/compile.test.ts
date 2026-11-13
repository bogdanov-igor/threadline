import { describe, expect, it } from 'vitest';
import type { LogLine } from '../backend/index.ts';
import { buildView } from '../search/records.ts';
import { summarize } from '../search/status.ts';
import { compileProfile } from './compile.ts';
import { ACME_APP, ACME_CID, ACME_NGINX, ACME_PROFILE, ACME_T0, acmeApp, acmeNginx, acmeRequest } from './test-acme.ts';
import type { Profile } from './types.ts';

const acme = compileProfile('acme', ACME_PROFILE);
const done = { match: 'exact' as const, readEndMs: ACME_T0 + 60_000, incomplete: false };
const line = (text: string, labels: Record<string, string> = ACME_APP, tsNs = '1793180955495000000'): LogLine => ({ tsNs, line: text, labels });
const storageMs = (l: LogLine) => Number(BigInt(l.tsNs) / 1_000_000n) + Number(BigInt(l.tsNs) % 1_000_000n) / 1e6;

describe('профиль acme: новый проект настройкой', () => {
  it('записи сшиваются в запрос по trace_id: вход, отправка и ответ связаны, лог с остальным контекстом', () => {
    const lines = acmeRequest();
    const parsed = lines.map((l) => acme.parse(l));
    expect(parsed.map((r) => [r.kind, r.correlationId])).toEqual([
      ['incoming', ACME_CID],
      ['send', ACME_CID],
      ['response', ACME_CID],
      ['log', ACME_CID],
    ]);
    const view = buildView(parsed, { withOffsets: true });
    expect(view.map((v) => v.title)).toEqual(['POST /api/orders/77/pay', 'POST pay.example.test/v2/charge', 'POST pay.example.test/v2/charge → 200', 'slow charge']);
    expect(view[2]!.http).toMatchObject({ status: 200, pairId: view[1]!.id, durationMs: 30 });
    expect(view[1]!.http?.pairId).toBe(view[2]!.id);
    // Тело объектом — текст JSON; тело строкой — как есть.
    expect(view[1]!.sections.body).toBe('{"amount":100}');
    expect(view[2]!.sections.body).toBe('{"ok":true}');
    expect(view[3]!.sections.context).toEqual({ tookMs: 30, region: 'eu' });
    expect(view.every((v) => v.component === 'app' && v.gateway === false)).toBe(true);
    const s = summarize(ACME_CID, parsed, done);
    expect(s).toMatchObject({ incoming: { method: 'POST', path: '/api/orders/77/pay' }, component: 'app', kind: 'incoming', recordCount: 4 });
    // WARN — во встроенной таблице: запись — ошибка.
    expect(s.status).toBe('error');
    expect(s.reasons).toEqual([{ kind: 'level', text: 'slow charge' }]);
  });

  it('время — эпоха в мс по числу цифр; запись стоит по нему, а не по времени хранилища', () => {
    const r = acme.parse(acmeApp(0, { msg: 'm', trace_id: 'x' }));
    expect(r.timeMs).toBe(ACME_T0);
  });

  it('разные форматы по метке: nginx — слой text, app — JSON', () => {
    const n = acme.parse(acmeNginx(0, 'POST /api/orders/77/pay?x=1 HTTP/1.1', 502));
    expect(n).toMatchObject({ kind: 'log', message: '/api/orders/77/pay?x=1', method: 'POST', uri: '/api/orders/77/pay?x=1', status: 502, component: 'nginx', correlationId: null });
    // Строка nginx в контейнере app не подходит ни под один вариант: текст целиком.
    const asApp = acme.parse({ ...acmeNginx(0), labels: ACME_APP });
    expect(asApp).toMatchObject({ kind: 'text', message: acmeNginx(0).line });
    // JSON в контейнере nginx — тоже текст.
    expect(acme.parse({ ...acmeApp(0, { msg: 'x', trace_id: 'y' }), labels: ACME_NGINX }).kind).toBe('text');
  });

  it('нет correlation_id: запись показана, в запрос не входит; correlation_id числом — строкой', () => {
    expect(acme.parse(acmeApp(0, { msg: 'boot' }))).toMatchObject({ kind: 'log', message: 'boot', correlationId: null });
    expect(acme.parse(acmeApp(0, { msg: 'x', trace_id: 6300014100001 })).correlationId).toBe('6300014100001');
  });

  it('уровни: таблица профиля для чисел, встроенные имена, имя вне таблицы, уровня нет', () => {
    const lvl = (v: unknown) => {
      const r = acme.parse(acmeApp(0, { msg: 'm', trace_id: 'c', lvl: v }));
      return [r.level, r.levelNum];
    };
    expect(lvl(50)).toEqual(['ERROR', 400]);
    expect(lvl('50')).toEqual(['ERROR', 400]);
    expect(lvl('warn')).toEqual(['WARN', 300]);
    expect(lvl('fatal')).toEqual(['FATAL', 600]);
    expect(lvl('verbose')).toEqual(['VERBOSE', null]);
    expect(lvl(30)).toEqual(['30', 30]);
    expect(lvl(undefined)).toEqual([null, null]);
    const severe = compileProfile('x', { ...ACME_PROFILE, levels: { severe: 500 } });
    expect(severe.parse(acmeApp(0, { msg: 'm', trace_id: 'c', lvl: 'Severe' }))).toMatchObject({ level: 'SEVERE', levelNum: 500 });
  });

  it('правило вида: поле условия отсутствует — проверяется следующее; ни одно не подошло — лог', () => {
    expect(acme.parse(acmeApp(0, { trace_id: 'c', http: { url: '/x' } })).kind).toBe('log');
    expect(acme.parse(acmeApp(0, { msg: 'outgoing response', trace_id: 'c' })).kind).toBe('response');
  });

  it('профиль без шлюзов: все записи — записи приложения', () => {
    expect(acmeRequest().map((l) => acme.parse(l).gateway)).toEqual([false, false, false, false]);
  });

  it('профиль без меток компонента: компонент пуст, запрос показан', () => {
    const p = compileProfile('nocomp', { ...ACME_PROFILE, component: undefined } as Profile);
    const parsed = acmeRequest().map((l) => p.parse(l));
    expect(parsed.every((r) => r.component === null)).toBe(true);
    expect(summarize(ACME_CID, parsed, done)).toMatchObject({ component: null, recordCount: 4, kind: 'incoming' });
  });
});

describe('время записи', () => {
  const p = compileProfile('t', {
    variants: [{ name: 'a', layers: [{ name: 'r', decode: 'json' }], fields: { time: 'r.t', correlationId: 'r.c' } }],
  });
  const at = (t: unknown) => {
    const l = line(JSON.stringify({ t, c: 'x' }), {});
    return { got: p.parse(l).timeMs, storage: storageMs(l) };
  };

  it('ISO 8601 с микросекундами и поясом', () => {
    expect(at('2026-10-28T16:20:29.952467+05:00').got).toBeCloseTo(Date.UTC(2026, 9, 28, 11, 20, 29, 952) + 0.467, 6);
  });

  it('без пояса, не разобралось, пусто — время хранилища', () => {
    for (const t of ['2026-10-28 16:20:29.952', 'вчера', '', null]) {
      const { got, storage } = at(t);
      expect(got, String(t)).toBe(storage);
    }
  });

  it('эпоха: единица по числу цифр целой части', () => {
    expect(at(1793180955).got).toBe(1793180955000);
    expect(at('1793180955.25').got).toBe(1793180955250);
    expect(at(1793180955495).got).toBe(1793180955495);
    expect(at('1793180955495123').got).toBeCloseTo(1793180955495.123, 3);
    expect(at('1793180955495123456').got).toBeCloseTo(1793180955495 + 0.123456, 3);
    // Восемь цифр — не эпоха.
    expect(at(20261028).got).toBe(at(20261028).storage);
  });
});

describe('слои и варианты: ничего не теряется', () => {
  const p = compileProfile('layers', {
    layers: [
      { name: 'outer', decode: 'json' },
      { name: 'inner', decode: 'json', from: 'outer.message' },
    ],
    variants: [{ name: 'app', when: { has: ['inner.msg'] }, fields: { message: 'inner.msg', correlationId: 'inner.cid' } }],
  });

  it('битая и пустая строка — «не разобрана» со строкой целиком и временем хранилища', () => {
    for (const text of ['{"message":"{\\"msg', '', '   ']) {
      const l = line(text);
      expect(p.parse(l)).toMatchObject({ kind: 'raw', message: text, timeMs: storageMs(l) });
    }
  });

  it('следующий слой не раскрылся — текст его входа; поля нет — строка целиком', () => {
    expect(p.parse(line('{"message":"PHP Warning: x"}'))).toMatchObject({ kind: 'text', message: 'PHP Warning: x' });
    expect(p.parse(line('{"other":1}'))).toMatchObject({ kind: 'text', message: '{"other":1}' });
  });

  it('ни один вариант не подошёл — текст последнего общего слоя', () => {
    expect(p.parse(line(JSON.stringify({ message: '{"foo":1}' })))).toMatchObject({ kind: 'text', message: '{"foo":1}' });
  });

  it('исключение при разборе: «не разобрана», в журнал — имя профиля и тип ошибки без содержимого', () => {
    const log: string[] = [];
    const q = compileProfile('acme', ACME_PROFILE, { onError: (m) => log.push(m) });
    const labels = new Proxy({} as Record<string, string>, {
      get() {
        throw new TypeError('secret 4000000000001234');
      },
    });
    const text = '{"ts":1,"trace_id":"secret-cid"}';
    expect(q.parse({ tsNs: '1', line: text, labels })).toMatchObject({ kind: 'raw', message: text, component: null, gateway: false });
    expect(log).toEqual(['формат «acme»: разбор строки прерван ошибкой TypeError']);
  });

  it('мягкий слой варианта не раскрылся: вариант подходит, пути слоя пусты', () => {
    const q = compileProfile('soft', {
      layers: [{ name: 'r', decode: 'json' }],
      variants: [{ name: 'a', when: { has: ['r.msg'] }, layers: [{ name: 'b', decode: 'json', from: 'r.msg' }], fields: { message: 'r.msg', correlationId: 'b.cid' } }],
    });
    expect(q.parse(line('{"msg":"plain text"}'))).toMatchObject({ kind: 'log', message: 'plain text', correlationId: null });
    expect(q.parse(line('{"msg":"{\\"cid\\":\\"c1\\"}"}')).correlationId).toBe('c1');
  });

  it('ключ с точкой в пути поля', () => {
    const q = compileProfile('dot', { variants: [{ name: 'a', layers: [{ name: 'rec', decode: 'json' }], fields: { correlationId: 'rec.trace.id' } }] });
    expect(q.parse(line('{"trace.id":"flat"}')).correlationId).toBe('flat');
    expect(q.parse(line('{"trace":{"id":"nested"}}')).correlationId).toBe('nested');
  });

  it('метки проверяются раньше путей: слой варианта не раскрывается на чужих строках', () => {
    let calls = 0;
    const q = compileProfile('lazy', ACME_PROFILE);
    const appLines = Array.from({ length: 50 }, (_, i) => acmeApp(i, { msg: 'm', trace_id: `c${i}` }));
    const orig = RegExp.prototype.exec;
    RegExp.prototype.exec = function (this: RegExp, s: string) {
      if (this.source.startsWith('^(?<ip>')) calls++;
      return orig.call(this, s);
    };
    try {
      for (const l of appLines) q.parse({ ...l, labels: { container: 'sidecar' } });
    } finally {
      RegExp.prototype.exec = orig;
    }
    expect(calls).toBe(0);
  });

  it('inspect: вариант и поля, давшие значение, без значений', () => {
    const r = acme.inspect(acmeRequest()[1]!);
    expect(r.variant).toBe('app');
    expect(r.found.sort()).toEqual(['body', 'correlationId', 'level', 'message', 'method', 'requestId', 'time', 'uri'].sort());
    expect(acme.inspect(line('nope', {})).variant).toBeNull();
  });
});

describe('скорость разбора', () => {
  it('20 000 строк — меньше секунды', () => {
    const base = [...acmeRequest(), acmeNginx(1), line('garbage'), line('')];
    const lines = Array.from({ length: 20_000 }, (_, i) => base[i % base.length]!);
    const t = performance.now();
    for (const l of lines) acme.parse(l);
    expect(performance.now() - t).toBeLessThan(1000);
  });
});
