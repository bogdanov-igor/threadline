import { describe, expect, it } from 'vitest';
import { luhnValid } from '@threadline/core';
import { BackendError, type CountQuery, type LinesQuery } from '@threadline/core/backend';
import { MOCK_FAIL_MODES } from '@threadline/core/config';
import { BUILTIN_COUNT_REGEXP } from '@threadline/core/profile';
import { buildTrace, buildView, edgesPattern, parseLine } from '@threadline/core/search';
import { generatePayDataset, MOCK_BINS, MOCK_SPECIAL } from '../src/backends/mock/dataset-pay.ts';
import { matches, MockBackend } from '../src/backends/mock/index.ts';

const anchor = Date.UTC(2026, 10, 2, 9, 0, 0);
const cfg = (over: object = {}) => ({ type: 'mock' as const, dataset: 'pay' as const, latencyMs: 0, maxConcurrent: 4, queueTimeoutSeconds: 10, timeoutSeconds: 30, ...over });

describe('набор Demo Pay', () => {
  const { records, pans } = generatePayDataset(anchor);

  it('одинаков при каждом запуске', () => {
    expect(generatePayDataset(anchor).records.map((r) => r.line)).toEqual(records.map((r) => r.line));
  });

  it('лежит в последних 24 часах от момента запуска', () => {
    const from = BigInt(anchor - 24 * 60 * 60 * 1000) * 1_000_000n;
    const to = BigInt(anchor) * 1_000_000n;
    expect(records.length).toBeGreaterThan(100);
    expect(records.every((r) => r.tsNs >= from && r.tsNs <= to)).toBe(true);
  });

  it('сдвигается вместе с моментом запуска', () => {
    const later = generatePayDataset(anchor + 3_600_000).records;
    expect(later[0]!.tsNs - records[0]!.tsNs).toBe(3_600_000n * 1_000_000n);
  });

  it('пишет одну запись JSON на строку: шлюз — сырой HTTP, строки не JSON — текст', () => {
    let app = 0;
    let bodies = 0;
    let text = 0;
    let broken = 0;
    let gateway = 0;
    for (const r of records) {
      let rec: Record<string, unknown>;
      try {
        rec = JSON.parse(r.line) as Record<string, unknown>;
      } catch {
        if (r.line.startsWith('{')) broken++;
        else text++;
        continue;
      }
      if (r.labels.container === 'gateway') {
        // Запись шлюза: в raw_request — сырой HTTP-запрос партнёра.
        expect(Object.keys(rec)).toEqual(['time', 'level', 'msg', 'raw_request']);
        expect(rec).toMatchObject({ level: 'debug' });
        expect(rec.raw_request).toMatch(/^(GET|POST) \/v1\/users\/\S+ HTTP\/1\.1\r\n.*\r\nX-Correlation-Id: [0-9a-f-]{36}\r\n.*\r\n\r\n/s);
        gateway++;
        continue;
      }
      expect(Object.keys(rec).slice(0, 3)).toEqual(['time', 'level', 'msg']);
      expect(String(rec.time)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
      app++;
      const http = (rec.upstream ?? rec.request) as { body?: unknown } | undefined;
      const body = http?.body;
      if (typeof body === 'string' && body.length > 2) {
        // XML, JSON или форма application/x-www-form-urlencoded.
        expect(body, body.slice(0, 40)).toMatch(/^(?:<|\{|\w+=)/);
        if (body.startsWith('{')) JSON.parse(body);
        bodies++;
      }
    }
    expect(app).toBeGreaterThan(100);
    expect(bodies).toBeGreaterThan(30);
    expect(text).toBeGreaterThan(5);
    expect(broken).toBe(1);
    expect(gateway).toBeGreaterThan(10);
  });

  it('запрос api начинается записью шлюза, сервис карт пишет вход сам, строки [GIN] на месте', () => {
    const parsed = records.map((r) => parseLine({ tsNs: String(r.tsNs), line: r.line, labels: r.labels }));
    const byCid = new Map<string, typeof parsed>();
    for (const p of parsed) if (p.correlationId) byCid.set(p.correlationId, [...(byCid.get(p.correlationId) ?? []), p]);
    let api = 0;
    let cards = 0;
    for (const group of byCid.values()) {
      const incoming = group.filter((p) => p.kind === 'incoming');
      const containers = new Set(group.map((p) => p.labels.container));
      if (containers.has('api')) {
        api++;
        expect(incoming).toHaveLength(1);
        expect(incoming[0]!.labels.container).toBe('gateway');
        expect(incoming[0]!.timeMs).toBeLessThanOrEqual(Math.min(...group.map((p) => p.timeMs)));
        const sends = group.filter((p) => p.kind === 'send');
        expect(sends.length).toBeGreaterThan(0);
        expect(sends.every((p) => p.requestId === incoming[0]!.requestId)).toBe(true);
      }
      if (containers.has('cards')) {
        cards++;
        expect(containers.has('gateway')).toBe(false);
        expect(incoming.map((p) => p.labels.container)).toEqual(['cards']);
      }
    }
    expect(api).toBeGreaterThan(10);
    expect(cards).toBeGreaterThan(5);
    expect(parsed.filter((p) => p.kind === 'text' && p.message.startsWith('[GIN]')).length).toBeGreaterThan(10);
  });

  it('вложенные тела: SOAP строкой в JSON, JSON в теге, JSON в CDATA', () => {
    const lines = records.map((r) => r.line).filter((l) => l.includes('soap-proxy'));
    expect(lines.some((l) => l.includes('SOAP-ENV:Envelope') && l.includes('&quot;card&quot;'))).toBe(true);
    expect(lines.some((l) => l.includes('<![CDATA[{'))).toBe(true);
  });

  it('номера карт выдуманы, проходят проверку Луна и начинаются с выдуманных BIN', () => {
    expect(pans.length).toBeGreaterThan(20);
    for (const p of pans) {
      expect(luhnValid(p)).toBe(true);
      expect(Object.values(MOCK_BINS).some((bin) => p.startsWith(bin))).toBe(true);
    }
    // PAN без проверки Луна — отдельно: его нет в списке карт, он маскируется только по имени поля.
    expect(luhnValid(MOCK_SPECIAL.nonLuhnPan)).toBe(false);
    expect(pans).not.toContain(MOCK_SPECIAL.nonLuhnPan);
  });

  describe('особые номера для поиска', () => {
    const cidsWith = (s: string) =>
      new Set(records.filter((r) => r.line.includes(s)).map((r) => parseLine({ tsNs: String(r.tsNs), line: r.line, labels: r.labels }).correlationId));

    it('PAN без проверки Луна лежит в primaryAccountNumber ответа коммутатора', () => {
      const lines = records.map((r) => r.line).filter((l) => l.includes(MOCK_SPECIAL.nonLuhnPan));
      expect(lines.some((l) => l.includes('v3/cards/info') && l.includes('http response received'))).toBe(true);
      expect(lines.every((l) => new RegExp(`primaryAccountNumber[\\\\"]*:[\\\\"]*${MOCK_SPECIAL.nonLuhnPan}`).test(l))).toBe(true);
    });

    it('две карты с одинаковыми краями: точная в двух запросах, вторая — в одном', () => {
      const { exactPan, twinPan } = MOCK_SPECIAL;
      expect(luhnValid(exactPan) && luhnValid(twinPan)).toBe(true);
      expect(exactPan).not.toBe(twinPan);
      expect(exactPan.slice(0, 6) + exactPan.slice(-4)).toBe(twinPan.slice(0, 6) + twinPan.slice(-4));
      expect(cidsWith(exactPan).size).toBe(2);
      expect(cidsWith(twinPan).size).toBe(1);
      const edges = new RegExp(edgesPattern(exactPan));
      // Случайные карты набора не попадают на те же края.
      const generated = pans.filter((p) => p !== exactPan && p !== twinPan);
      expect(generated.some((p) => edges.test(p))).toBe(false);
    });

    it('запрос, где номер только маской', () => {
      const masked = cidsWith(MOCK_SPECIAL.maskedPan);
      expect(masked.size).toBe(1);
      const [cid] = [...masked];
      const lines = records.map((r) => r.line).filter((l) => l.includes(String(cid)));
      expect(lines.some((l) => l.includes(MOCK_SPECIAL.exactPan))).toBe(false);
    });

    it('отказ проверки личности result_code = BAD и отправка без ответа за секунды до конца набора', () => {
      const all = records.map((r) => r.line).join('\n');
      expect(all).toMatch(/result_code\\+":\\+"BAD/);
      const parsed = records.map((r) => parseLine({ tsNs: String(r.tsNs), line: r.line, labels: r.labels }));
      const lastSend = parsed.filter((p) => p.kind === 'send').at(-1)!;
      expect(anchor - lastSend.timeMs).toBeLessThan(20_000);
      expect(parsed.some((p) => p.kind === 'response' && p.correlationId === lastSend.correlationId)).toBe(false);
    });
  });

  it('содержит все сценарии набора', () => {
    const all = records.map((r) => r.line).join('\n');
    for (const s of ['getCard', 'getCardholder', 'getBalance', 'v3/cards/info', 'PRC-ERR-0027', 'Decline, no card record', 'v1/payments/charge', 'api/payments', 'cURL error 28', '[GIN]', 'PHP Warning', 'db query', 'tokenization callback']) {
      expect(all, s).toContain(s);
    }
  });

  it('тайм-аут проверки мошенничества: одна отправка без ответа, запись cURL — лог ERROR, а не второй обмен', () => {
    const parsed = records.map((r) => parseLine({ tsNs: String(r.tsNs), line: r.line, labels: r.labels }));
    const curl = parsed.filter((p) => p.message.startsWith('cURL error 28'));
    expect(curl.length).toBeGreaterThan(0);
    for (const c of curl) {
      expect(c).toMatchObject({ kind: 'log', level: 'ERROR' });
      const trace = buildTrace(buildView(parsed.filter((p) => p.correlationId === c.correlationId), { withOffsets: true }));
      const exchanges = trace.steps.filter((s) => s.kind === 'exchange');
      expect(exchanges).toHaveLength(1);
      expect(exchanges[0]).toMatchObject({ system: 'fraud.pay.example', title: 'POST /', noResponse: true });
      expect(trace.steps.filter((s) => s.kind === 'log' && s.isError)).toHaveLength(2);
    }
  });
});

describe('хранилище-имитация', () => {
  it('отвечает на проверку и значения метки', async () => {
    const m = new MockBackend(cfg(), { anchorMs: anchor });
    expect((await m.check(AbortSignal.timeout(1000))).labelNames).toContain('namespace');
    const ns = await m.labelValues('namespace', [{ label: 'namespace', op: '=~', value: 'pay-pr-[0-9]{1,6}' }], { fromMs: anchor - 7 * 86_400_000, toMs: anchor }, AbortSignal.timeout(1000));
    expect(ns).toEqual(['pay-pr-105', 'pay-pr-92']);
  });

  it('условие !~ отбрасывает значение, совпавшее целиком; неверное выражение записей не пропускает', () => {
    const labels = { namespace: 'pay-test', container: 'worker-payouts' };
    expect(matches(labels, [{ label: 'container', op: '!~', value: 'worker-.*' }])).toBe(false);
    expect(matches(labels, [{ label: 'container', op: '!~', value: 'worker' }])).toBe(true);
    expect(matches(labels, [{ label: 'app', op: '!~', value: 'x' }])).toBe(true);
    expect(matches(labels, [{ label: 'app', op: '!~', value: '' }])).toBe(false);
    expect(matches(labels, [{ label: 'container', op: '!~', value: 'worker-(' }])).toBe(false);
    expect(matches(labels, [{ label: 'container', op: '=~', value: 'worker-(' }])).toBe(false);
  });

  it('выдерживает заданную задержку', async () => {
    const m = new MockBackend(cfg({ latencyMs: 120 }), { anchorMs: anchor });
    const t = performance.now();
    await m.check(AbortSignal.timeout(1000));
    expect(performance.now() - t).toBeGreaterThanOrEqual(115);
  });

  it.each(MOCK_FAIL_MODES)('имитирует ошибку %s', async (mode) => {
    const m = new MockBackend(cfg({ fail: mode }), { anchorMs: anchor });
    await expect(m.check(AbortSignal.timeout(1000))).rejects.toMatchObject({ code: mode });
    await expect(m.check(AbortSignal.timeout(1000))).rejects.toBeInstanceOf(BackendError);
  });

  const sel = [{ label: 'namespace', op: '=' as const, value: 'pay' }];
  const day = { fromMs: anchor - 86_400_000, toMs: anchor };
  const lines = (m: MockBackend, over: Partial<LinesQuery> = {}) =>
    m.queryLines({ selector: sel, filters: [], range: day, limit: 5000, direction: 'forward', ...over }, AbortSignal.timeout(1000));
  const count = (m: MockBackend, over: Partial<CountQuery> = {}) =>
    m.countBy({ selector: sel, filters: [], range: day, key: { regexp: BUILTIN_COUNT_REGEXP }, ...over }, AbortSignal.timeout(1000));

  it('читает строки по фильтру «содержит» с учётом регистра', async () => {
    const m = new MockBackend(cfg(), { anchorMs: anchor });
    const got = await lines(m, { filters: [{ kind: 'contains', value: 'getCard' }] });
    expect(got.length).toBeGreaterThan(5);
    expect(got.every((l) => l.line.includes('getCard'))).toBe(true);
    expect(await lines(m, { filters: [{ kind: 'contains', value: 'GETCARD' }] })).toEqual([]);
    // Исключение действует на каждую строку; отрицание шаблона так же.
    expect(await lines(m, { filters: [{ kind: 'contains', value: 'getCard' }, { kind: 'not-contains', value: 'getCard' }] })).toEqual([]);
    expect(await lines(m, { filters: [{ kind: 'contains', value: 'getCard' }, { kind: 'not-regex', pattern: 'getC.rd' }] })).toEqual([]);
    expect((await lines(m, { filters: [{ kind: 'contains', value: 'getCard' }, { kind: 'not-contains', value: 'нет такого значения' }] })).length).toBe(got.length);
    expect(got[0]!.labels.namespace).toBe('pay');
  });

  it('читает строки по выражению и по нескольким фильтрам сразу', async () => {
    const m = new MockBackend(cfg(), { anchorMs: anchor });
    const byEdges = await lines(m, { filters: [{ kind: 'regex', pattern: edgesPattern(MOCK_SPECIAL.exactPan) }] });
    const text = byEdges.map((l) => l.line).join('\n');
    for (const s of [MOCK_SPECIAL.exactPan, MOCK_SPECIAL.twinPan, MOCK_SPECIAL.maskedPan]) expect(text).toContain(s);
    const both = await lines(m, { filters: [{ kind: 'regex', pattern: edgesPattern(MOCK_SPECIAL.exactPan) }, { kind: 'contains', value: 'cardNumber' }] });
    expect(both.length).toBeGreaterThan(0);
    expect(both.length).toBeLessThan(byEdges.length);
  });

  it('держит порядок, предел и селектор', async () => {
    const m = new MockBackend(cfg(), { anchorMs: anchor });
    const fwd = await lines(m);
    const back = await lines(m, { direction: 'backward' });
    const ts = (xs: { tsNs: string }[]) => xs.map((l) => BigInt(l.tsNs));
    expect(ts(fwd)).toEqual([...ts(fwd)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    expect(ts(back)).toEqual([...ts(fwd)].reverse());
    expect(await lines(m, { limit: 7 })).toEqual(fwd.slice(0, 7));
    expect(await lines(m, { limit: 7, direction: 'backward' })).toEqual(back.slice(0, 7));
    const test = await lines(m, { selector: [{ label: 'namespace', op: '=', value: 'pay-test' }] });
    expect(test.length).toBeGreaterThan(0);
    expect(test.every((l) => l.labels.namespace === 'pay-test')).toBe(true);
  });

  it('границы периода включительно, с точностью до наносекунды', async () => {
    const m = new MockBackend(cfg(), { anchorMs: anchor });
    const target = (await lines(m))[10]!;
    const at = (fromNs: string, toNs: string) => lines(m, { range: { ...day, fromNs, toNs } });
    expect((await at(target.tsNs, target.tsNs)).map((l) => l.tsNs)).toEqual([target.tsNs]);
    const t = BigInt(target.tsNs);
    expect(await at((t + 1n).toString(), (t + 1_000n).toString())).not.toContainEqual(target);
    expect(await at((t - 1_000n).toString(), (t - 1n).toString())).not.toContainEqual(target);
    const ms = Number(t / 1_000_000n);
    expect(await lines(m, { range: { fromMs: ms + 1, toMs: ms + 1000 } })).not.toContainEqual(target);
  });

  it('считает записи по correlation_id, без строк-текста', async () => {
    const m = new MockBackend(cfg(), { anchorMs: anchor });
    const counts = await count(m);
    const expected: Record<string, number> = {};
    for (const l of await lines(m)) {
      const cid = parseLine(l).correlationId;
      if (cid) expected[cid] = (expected[cid] ?? 0) + 1;
    }
    expect(counts).toEqual(expected);
    expect(Object.keys(counts).length).toBeGreaterThan(20);
    expect(Object.keys(counts)).not.toContain('');
    const gin = await count(m, { filters: [{ kind: 'contains', value: '[GIN]' }] });
    expect(gin).toEqual({});
  });

  it('считает и записи шлюза: значение только в пути на шлюзе находит correlation_id', async () => {
    const m = new MockBackend(cfg(), { anchorMs: anchor });
    const gw = (await lines(m, { filters: [{ kind: 'contains', value: 'raw_request' }] })).map(parseLine);
    expect(gw.length).toBeGreaterThan(5);
    const g = gw[0]!;
    const user = /^\/v1\/users\/([^/]+)\//.exec(g.uri!)![1]!;
    // user_id есть только в строках шлюза: записи с сырым HTTP и строке [GIN].
    const withUser = await lines(m, { filters: [{ kind: 'contains', value: user }] });
    expect(withUser.every((l) => l.labels.container === 'gateway')).toBe(true);
    expect(await count(m, { filters: [{ kind: 'contains', value: user }] })).toEqual({ [g.correlationId!]: 1 });
    const all = (await lines(m, { filters: [{ kind: 'contains', value: g.correlationId! }] })).filter((l) => parseLine(l).correlationId === g.correlationId);
    expect(new Set(all.map((l) => l.labels.container))).toEqual(new Set(['gateway', 'api']));
  });

  it('по correlation_id находятся все записи запроса', async () => {
    const m = new MockBackend(cfg(), { anchorMs: anchor });
    const [cid, n] = Object.entries(await count(m, { filters: [{ kind: 'contains', value: 'getCard' }] }))[0]!;
    expect(n).toBeGreaterThan(0);
    const all = await lines(m, { filters: [{ kind: 'contains', value: cid }] });
    const own = all.filter((l) => parseLine(l).correlationId === cid);
    expect(own.length).toBeGreaterThanOrEqual(7);
    expect(own.map((l) => parseLine(l).kind)).toContain('incoming');
    expect((await count(m, { filters: [{ kind: 'contains', value: cid }] }))[cid]).toBe(own.length);
  });

  it('подсчёт по другому ключу: выражение с группой cid над level', async () => {
    const m = new MockBackend(cfg(), { anchorMs: anchor });
    const byLevel = await count(m, { key: { regexp: '"level":"(?P<cid>[a-z]+)"' } });
    expect(Object.keys(byLevel).sort()).toEqual(['debug', 'error', 'info', 'warning']);
  });

  it.each(['queryLines', 'countBy'] as const)('%s имитирует ошибку и отмену', async (op) => {
    const call = (m: MockBackend, signal: AbortSignal) =>
      op === 'queryLines'
        ? m.queryLines({ selector: sel, filters: [], range: day, limit: 10, direction: 'forward' }, signal)
        : m.countBy({ selector: sel, filters: [], range: day, key: { regexp: BUILTIN_COUNT_REGEXP } }, signal);
    await expect(call(new MockBackend(cfg({ fail: 'timeout' }), { anchorMs: anchor }), AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'timeout' });
    const c = new AbortController();
    const p = call(new MockBackend(cfg({ latencyMs: 5000 }), { anchorMs: anchor }), c.signal);
    c.abort();
    await expect(p).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('прерывает задержку при отмене', async () => {
    const m = new MockBackend(cfg({ latencyMs: 5000 }), { anchorMs: anchor });
    const c = new AbortController();
    const p = m.check(c.signal);
    c.abort();
    await expect(p).rejects.toMatchObject({ code: 'cancelled' });
  });
});
