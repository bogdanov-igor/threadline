// Виды выборки на имитации: labels, background, форма потока, names и список неизвестного. Все значения выдуманы.

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LogLine } from '@threadline/core/backend';
import { methodKey, snapshotFromFile } from '@threadline/core/catalog';
import { cidSegments } from '@threadline/core/flow';
import { BUILTIN_FORMAT, BUILTIN_PROFILE, builtinProfile, compileProfile, type Profile } from '@threadline/core/profile';
import { MockBackend } from '../../src/backends/mock/index.ts';
import { linesLogql } from '../../src/backends/logql.ts';
import { parseCatalogText } from '../../src/catalog/exchange.ts';
import { ROOT } from '../../src/paths.ts';
import { findCandidates, flowShape } from '../../src/sample/background.ts';
import { inspectLine } from '../../src/sample/context.ts';
import { passesForm } from '../../src/sample/gate.ts';
import { gatewayFilters } from '../../src/sample/labels.ts';
import { HTTP_LINE } from '../../src/sample/names.ts';
import { valueOrLabel } from '../../src/sample/structure.ts';
import { APP_LABELS, appLine, box, dropBox, gatewayLine, GW_LABELS, incomingLine, NOW, responseLine, run, Scripted, sendLine, uuid, type Box } from './sample-kit.ts';

let b: Box;
beforeEach(async () => {
  b = await box();
});
afterEach(() => dropBox(b));

const demo = (adapter: Scripted, kind: string, ...more: string[]) => run(b, ['--env', 'demo', '--kind', kind, ...more], { createAdapter: () => adapter });

describe('вид labels', () => {
  it('записи шлюза: группы меток и число строк, ни одного поля записи', async () => {
    const a = new Scripted();
    a.answer = () => [
      gatewayLine({ cid: uuid(1), path: '/v1/users/secretword', headers: [['X-Phone', '+447700900001']] }),
      gatewayLine({ cid: uuid(2) }),
      appLine({ msg: 'not gateway raw_request', cid: uuid(3) }),
    ];
    const r = await demo(a, 'labels');
    expect(r.code).toBe(0);
    const g = r.doc.kinds.labels.gateway;
    expect(g).toMatchObject({ supported: true, read: 3, found: 2 });
    expect(g.streams).toHaveLength(1);
    expect(g.streams[0]).toMatchObject({ count: 2, variant: 'gateway', labels: { container: 'server', app_kubernetes_io_component: 'gateway' } });
    expect(g.streams[0].labels.pod).toMatch(/^<mixed:\d+>$/);
    expect(r.text).not.toContain('secretword');
    expect(r.text).not.toContain('X-Phone');
    expect(JSON.stringify(r.doc.kinds)).not.toContain('"tree"');
  });

  it('фильтры шлюза из условия варианта, значения меток с селектором среды, окно шлюза 1 час', async () => {
    expect(gatewayFilters(BUILTIN_PROFILE)).toEqual([{ kind: 'contains', value: 'raw_request' }]);
    const a = new Scripted();
    await demo(a, 'labels');
    expect(a.calls.map((c) => c.type)).toEqual(['check', 'values', 'values', 'values', 'lines']);
    const q = a.lineCalls[0]!;
    expect(q).toMatchObject({ limit: 5, direction: 'backward' });
    expect(q.range.toMs - q.range.fromMs).toBe(3_600_000);
  });

  it('записей шлюза нет: found 0, код не меняется', async () => {
    const r = await demo(new Scripted(), 'labels');
    expect(r.code).toBe(0);
    expect(r.doc.kinds.labels.gateway).toEqual({ supported: true, read: 0, found: 0, streams: [] });
  });

  it('профиль без шлюза: запроса строк нет', () => {
    const none: Profile = { ...BUILTIN_PROFILE, variants: BUILTIN_PROFILE.variants.filter((v) => !v.gateway) };
    expect(gatewayFilters(none)).toBeNull();
  });

  it('метки нет в именах за 5 минут: значения всё равно запрошены', async () => {
    const a = new Scripted();
    a.names = ['cluster'];
    a.values = { app_kubernetes_io_sub_service: ['cron'] };
    const r = await demo(a, 'labels');
    expect(r.doc.kinds.labels.values.app_kubernetes_io_sub_service).toEqual({ total: 1, list: ['cron'] });
  });

  it('много значений и имён: первые по алфавиту и общее число, данные в значении меткой', async () => {
    const a = new Scripted();
    a.names = Array.from({ length: 250 }, (_, i) => `label_${String(i).padStart(3, '0')}`);
    a.values = { container: Array.from({ length: 60 }, (_, i) => `c-${String(59 - i).padStart(2, '0')}`).concat('ns-1234567') };
    const r = await demo(a, 'labels');
    const l = r.doc.kinds.labels;
    expect(l.names).toMatchObject({ total: 250 });
    expect(l.names.list).toHaveLength(200);
    expect(l.values.container.total).toBe(61);
    expect(l.values.container.list).toHaveLength(50);
    expect(l.values.container.list[0]).toBe('c-00');
    const single = new Scripted();
    single.values = { container: ['ns-1234567'] };
    expect((await demo(single, 'labels')).doc.kinds.labels.values.container.list).toEqual(['<mixed:10>']);
  });
});

describe('вид background', () => {
  it('порядок кандидатов: worker, consumer, cron, остальные; одно значение один раз', () => {
    const c = findCandidates(
      new Map([
        ['container', ['pay-job', 'cron', 'consumer-b', 'worker-a', 'workers', 'api']],
        ['app_kubernetes_io_component', ['worker-a', 'scheduler_x']],
        ['app_kubernetes_io_sub_service', ['queue-z']],
      ]),
    );
    expect(c.map((x) => x.value)).toEqual(['worker-a', 'consumer-b', 'cron', 'pay-job', 'scheduler_x', 'queue-z']);
    expect(c[0]!.label).toBe('container');
  });

  const lineFor = (value: string, o: { cid?: string | null; at?: number; pod?: string } = {}) =>
    appLine({ cid: o.cid ?? null, at: o.at ?? NOW - 10_000, labels: { ...APP_LABELS, container: value, ...(o.pod ? { pod: o.pod } : {}) } });

  const byCandidate = (m: Record<string, LogLine[]>, flows: Record<string, LogLine[]> = {}) => (q: { selector: { label: string; op: string; value: string }[]; filters: { kind: string; value?: string }[] }) => {
    const f = q.filters[0];
    if (f?.kind === 'contains') return flows[f.value!] ?? [];
    const own = q.selector.find((s) => s.op === '=' && m[s.value] !== undefined);
    return own ? m[own.value]! : [];
  };

  it('записи без correlation_id: none, пауза, один под, потока нет', async () => {
    const a = new Scripted();
    a.values = { container: ['worker-a'] };
    a.answer = byCandidate({ 'worker-a': [lineFor('worker-a', { at: NOW - 10_000, pod: 'p1' }), lineFor('worker-a', { at: NOW - 55_000, pod: 'p1' })] });
    const r = await demo(a, 'background');
    const c = r.doc.kinds.background.candidates[0];
    expect(c).toMatchObject({ label: 'container', value: 'worker-a', found: 2, correlation: 'none', between: { gapSec: 45, samePod: true }, flows: [] });
    expect(a.lineCalls).toHaveLength(1);
    expect(a.lineCalls[0]).toMatchObject({ limit: 2, direction: 'backward' });
  });

  it('с correlation_id: present, вид и ссылка, значения нет; смешанные: mixed', async () => {
    const a = new Scripted();
    a.values = { container: ['worker-a', 'worker-b'] };
    a.answer = byCandidate({ 'worker-a': [lineFor('worker-a', { cid: uuid(1) })], 'worker-b': [lineFor('worker-b', { cid: uuid(2) }), lineFor('worker-b')] });
    const r = await demo(a, 'background');
    const [x, y] = r.doc.kinds.background.candidates;
    expect(x.correlation).toBe('present');
    expect(x.entries[0].correlationId).toEqual({ shape: '<uuid:36>', ref: 'cid#1' });
    expect(y.correlation).toBe('mixed');
    expect(r.text).not.toContain(uuid(1));
  });

  it('кандидатов нет: пустой список, запросов строк нет', async () => {
    const a = new Scripted();
    a.values = { container: ['api'] };
    const r = await demo(a, 'background');
    expect(r.code).toBe(0);
    expect(r.doc.kinds.background).toMatchObject({ candidates: [], notRead: [], since: '6h' });
    expect(a.lineCalls).toEqual([]);
  });

  it('кандидат без записей не занимает место в тройке; всего не больше 4 чтений', async () => {
    const a = new Scripted();
    a.values = { container: ['worker-a', 'consumer-b', 'cron', 'job-c', 'queue-d'] };
    a.answer = byCandidate({ 'consumer-b': [lineFor('consumer-b')], cron: [lineFor('cron')], 'job-c': [lineFor('job-c')], 'queue-d': [lineFor('queue-d')] });
    const r = await demo(a, 'background');
    const bg = r.doc.kinds.background;
    expect(bg.candidates.map((c: { value: string; found: number }) => [c.value, c.found])).toEqual([
      ['worker-a', 0],
      ['consumer-b', 1],
      ['cron', 1],
      ['job-c', 1],
    ]);
    expect(bg.notRead).toEqual([{ label: 'container', value: 'queue-d' }]);
  });

  it('пять кандидатов со строками: читаются три, остальные в notRead', async () => {
    const a = new Scripted();
    a.values = { container: ['worker-a', 'consumer-b', 'cron', 'job-c', 'queue-d'] };
    a.answer = byCandidate(Object.fromEntries(a.values.container!.map((v) => [v, [lineFor(v)]])));
    const r = await demo(a, 'background');
    expect(r.doc.kinds.background.candidates).toHaveLength(3);
    expect(r.doc.kinds.background.notRead.map((c: { value: string }) => c.value)).toEqual(['job-c', 'queue-d']);
  });

  it('все четыре чтения пусты: пятый в notRead, код не меняется', async () => {
    const a = new Scripted();
    a.values = { container: ['worker-a', 'consumer-b', 'cron', 'job-c', 'queue-d'] };
    const r = await demo(a, 'background');
    expect(r.code).toBe(0);
    expect(a.lineCalls).toHaveLength(4);
    expect(r.doc.kinds.background.notRead.map((c: { value: string }) => c.value)).toEqual(['queue-d']);
  });

  it('данные в значении кандидата: чтение по значению, в файле метка', async () => {
    const a = new Scripted();
    a.values = { container: ['worker-1234567'] };
    a.answer = () => [lineFor('worker-1234567')];
    const r = await demo(a, 'background');
    expect(a.lineCalls[0]!.selector).toContainEqual({ label: 'container', op: '=', value: 'worker-1234567' });
    expect(r.code).toBe(0);
    expect(r.doc.kinds.background.candidates[0].value).toBe('<mixed:14>');
    expect(r.text).not.toContain('1234567');
  });

  it('строка не раскрылась: метка, вариант null, correlation none', async () => {
    const a = new Scripted();
    a.values = { container: ['worker-a'] };
    a.answer = () => [{ tsNs: `${NOW}000000`, line: '[GIN] 2026/11/04 | 200 | GET /x', labels: APP_LABELS }];
    const r = await demo(a, 'background');
    const c = r.doc.kinds.background.candidates[0];
    expect(c.correlation).toBe('none');
    expect(c.entries[0].variant).toBeNull();
    expect(c.entries[0].tree).toMatch(/^<mixed:\d+>$/);
  });

  it('неверная дата записи и странный статус не отменяют файл', async () => {
    const a = new Scripted();
    a.values = { container: ['worker-a'] };
    a.answer = (q) =>
      q.filters[0]?.kind === 'contains'
        ? []
        : [appLine({ at: 0, cid: null, fields: { upstream: { method: 'POST', url: 'http://ledger.local/x', status: 1234567 } } }), appLine({ at: NOW - 1000, cid: null })];
    const r = await demo(a, 'background');
    expect(r.code).toBe(0);
    expect(r.doc.kinds.background.candidates[0].between.gapSec).toBe(999_999);
    expect(r.text).not.toContain('1234567');
  });

  it('кроны на тесте: кандидат без исключения, остальные условия на месте; порции names с исключением', async () => {
    const a = new Scripted();
    a.values = { app_kubernetes_io_sub_service: ['cron'] };
    a.answer = () => [];
    const r = await run(b, ['--env', 'test', '--kind', 'all', '--live'], { createAdapter: () => a });
    expect(r.code).toBe(0);
    const exclusion = { label: 'app_kubernetes_io_sub_service', op: '!=', value: 'cron' };
    const values = a.calls.flatMap((c) => (c.type === 'values' ? [c] : []));
    for (const v of values) expect(v.scope).not.toContainEqual(exclusion);
    const candidate = a.lineCalls.find((q) => q.selector.some((s) => s.op === '=' && s.value === 'cron'))!;
    expect(candidate.selector).toContainEqual({ label: 'namespace', op: '=', value: 'pay-test' });
    expect(candidate.selector).not.toContainEqual(exclusion);
    const names = a.lineCalls.filter((q) => q.filters.some((f) => f.kind === 'regex' || (f.kind === 'contains' && f.value === 'ERROR')));
    expect(names).toHaveLength(3);
    for (const q of names) expect(q.selector).toContainEqual(exclusion);
  });
});

describe('форма потока', () => {
  const G = 300_000;
  const flow = (cid: string) => [
    gatewayLine({ cid, at: NOW - 3 * G, path: '/v1/pay' }),
    appLine({ cid, at: NOW - 2 * G, labels: { ...APP_LABELS, container: 'worker-a', app_kubernetes_io_component: 'worker-a' } }),
    appLine({ cid, at: NOW - G, labels: { ...APP_LABELS, container: 'worker-a', app_kubernetes_io_component: 'worker-a' } }),
  ];

  it('повторы под исходным correlation_id: вход, шлюз, паузы, 3 сегмента', async () => {
    const a = new Scripted();
    a.values = { container: ['worker-a'] };
    const cid = uuid(5);
    a.answer = (q) => (q.filters[0]?.kind === 'contains' ? flow(cid) : [appLine({ cid, at: NOW - G, labels: { ...APP_LABELS, container: 'worker-a' } })]);
    const r = await demo(a, 'background');
    expect(r.doc.kinds.background.candidates[0].flows[0]).toMatchObject({
      ref: 'cid#1',
      read: 3,
      truncated: false,
      mentions: 0,
      hasIncoming: true,
      hasGateway: true,
      gapsOver30s: [300, 300],
      maxGapSec: 300,
      ruleGapSec: 180,
      segmentsByRule: 3,
    });
    const q = a.lineCalls[1]!;
    expect(q).toMatchObject({ limit: 200, direction: 'forward', filters: [{ kind: 'contains', value: cid }] });
    expect(q.range.toMs - q.range.fromMs).toBe(2 * 3_600_000);
  });

  it('свой correlation_id: нет входа, один компонент; короткие паузы не перечисляются', () => {
    const c = builtinProfile();
    const cid = uuid(6);
    const lines = [0, 5_000, 12_000].map((d) => inspectLine(c, appLine({ cid, at: NOW + d })));
    expect(flowShape('cid#1', cid, lines, false)).toMatchObject({ hasIncoming: false, components: { api: 3 }, gapsOver30s: [], maxGapSec: 7, segmentsByRule: 1 });
  });

  it('упоминание считается отдельно; поток больше предела: truncated', async () => {
    const c = builtinProfile();
    const cid = uuid(7);
    const lines = [appLine({ cid, at: NOW }), appLine({ cid: uuid(8), at: NOW, fields: { ctx: { note: cid } } })].map((l) => inspectLine(c, l));
    expect(flowShape('cid#1', cid, lines, true)).toMatchObject({ read: 1, mentions: 1, truncated: true });
  });

  it('один correlation_id у двух строк: поток читается один раз, одна ссылка', async () => {
    const a = new Scripted();
    a.values = { container: ['worker-a', 'worker-b'] };
    const cid = uuid(9);
    a.answer = (q) => (q.filters[0]?.kind === 'contains' ? [] : [appLine({ cid, at: NOW - 1000 }), appLine({ cid, at: NOW - 2000 })]);
    const r = await demo(a, 'background');
    expect(a.lineCalls.filter((q) => q.filters[0]?.kind === 'contains')).toHaveLength(1);
    const refs = r.doc.kinds.background.candidates.flatMap((x: { entries: { correlationId: { ref: string } }[] }) => x.entries.map((e) => e.correlationId.ref));
    expect(new Set(refs)).toEqual(new Set(['cid#1']));
  });

  it('кандидаты заняли 4 чтения, correlation_id два: читается один поток', async () => {
    const a = new Scripted();
    a.values = { container: ['worker-a', 'consumer-b', 'cron', 'job-c'] };
    let n = 0;
    a.answer = (q) => {
      if (q.filters[0]?.kind === 'contains') return [];
      const v = q.selector.find((s) => s.op === '=' && s.label === 'container')?.value;
      if (v === 'worker-a') return [];
      return [appLine({ cid: uuid(++n), at: NOW - n * 1000 })];
    };
    await demo(a, 'background');
    expect(a.lineCalls.filter((q) => q.filters[0]?.kind !== 'contains')).toHaveLength(4);
    expect(a.lineCalls.filter((q) => q.filters[0]?.kind === 'contains')).toHaveLength(1);
  });

  it('три кандидата, два потока: всего 5 запросов', async () => {
    const a = new Scripted();
    a.values = { container: ['worker-a', 'consumer-b', 'cron'] };
    let n = 0;
    a.answer = (q) => (q.filters[0]?.kind === 'contains' ? [] : [appLine({ cid: uuid(++n), at: NOW - n * 1000 })]);
    await demo(a, 'background');
    expect(a.lineCalls).toHaveLength(5);
  });

  it('спецсимволы в correlation_id: буквальный фильтр внутри селектора среды', async () => {
    const a = new Scripted();
    a.values = { container: ['worker-a'] };
    const cid = 'a"b{c}|d';
    const raw = appLine({ cid, at: NOW - 1000 });
    a.answer = (q) => (q.filters[0]?.kind === 'contains' ? [] : [raw]);
    await demo(a, 'background');
    const q = a.lineCalls.find((x) => x.filters[0]?.kind === 'contains')!;
    expect(q.filters).toEqual([{ kind: 'contains', value: cid }]);
    expect(q.selector).toContainEqual({ label: 'namespace', op: '=', value: 'pay' });
    expect(linesLogql(q.selector, q.filters)).toContain('namespace="pay"');
    expect(linesLogql(q.selector, q.filters)).toContain(JSON.stringify(cid));
  });

  it('число сегментов совпадает с cidSegments на демо-наборе ветки (B)', () => {
    const mock = new MockBackend({ type: 'mock', dataset: 'pay', latencyMs: 0 } as never, { anchorMs: NOW });
    const c = compileProfile(BUILTIN_FORMAT, BUILTIN_PROFILE);
    const parsed = mock.records.map((r) => ({ line: { tsNs: r.tsNs.toString(), line: r.line, labels: r.labels }, rec: c.parse({ tsNs: r.tsNs.toString(), line: r.line, labels: r.labels }) }));
    const retry = parsed.find((x) => x.rec.component === 'worker' && x.rec.uri?.includes('/v1/payments/confirm') && x.rec.correlationId !== null);
    expect(retry).toBeDefined();
    const cid = retry!.rec.correlationId!;
    const own = parsed.filter((x) => x.line.line.includes(cid)).map((x) => inspectLine(c, x.line));
    const shape = flowShape('cid#1', cid, own, false);
    expect(shape.segmentsByRule).toBe(cidSegments(own.map((x) => x.record).filter((r) => r.correlationId === cid)).length);
    expect(shape).toMatchObject({ hasIncoming: true, hasGateway: true, segmentsByRule: 3 });
  });
});

describe('вид names', () => {
  const LEDGER = 'http://ledger.local';

  /** Первая порция отдаёт записи, остальные пусто. */
  const once = (a: Scripted, lines: LogLine[]) => {
    let done = false;
    a.answer = () => {
      if (done) return [];
      done = true;
      return lines;
    };
  };

  it('запросы: две порции по 200 и 50 с ошибками, окна из плана', async () => {
    const a = new Scripted();
    await demo(a, 'names');
    expect(a.lineCalls.map((q) => [q.limit, q.filters[0], q.range.toMs - q.range.fromMs, NOW - q.range.toMs])).toEqual([
      [200, { kind: 'regex', pattern: HTTP_LINE }, 900_000, 0],
      [200, { kind: 'regex', pattern: HTTP_LINE }, 900_000, 3 * 3_600_000],
      [50, { kind: 'contains', value: 'ERROR' }, 3_600_000, 0],
    ]);
  });

  it('строк нет: вид с нулями, код 0', async () => {
    const r = await demo(new Scripted(), 'names');
    expect(r.code).toBe(0);
    expect(r.doc.kinds.names).toMatchObject({ read: 0, unknown: [], more: 0, catalog: { source: 'file' } });
    expect(r.doc.kinds.names.summary.incoming.total).toBe(0);
  });

  it('группа «вход»: два разных шаблона, а не две записи одного', async () => {
    const a = new Scripted();
    const paths = ['/v1/users/a1/cards', '/v1/users/a2/cards', '/v1/other/one', '/v1/third/two'];
    once(a, paths.map((p, i) => incomingLine('POST', p, { cid: uuid(i + 1), at: NOW - i * 1000 })));
    const r = await demo(a, 'names');
    const list = r.doc.kinds.names.entries.incoming;
    expect(list).toHaveLength(2);
    expect(new Set(list.map((e: { http: { path: string } }) => e.http.path)).size).toBe(2);
  });

  it('сводка и разметка справочника: ключи, итог, уровень; текста правила и названий нет', async () => {
    const a = new Scripted();
    const uri = `${LEDGER}/v1/hold`;
    once(a, [
      // Ответ раньше отправки: в группу идут разные шаблоны, и здесь первым должен попасть он.
      responseLine(uri, 200, { cid: uuid(1), at: NOW - 3000, requestId: 'r1', body: { result: { payment_state: 'CONFIRMED' } } }),
      sendLine(uri, { cid: uuid(1), at: NOW - 2900, requestId: 'r1' }),
      sendLine(`${LEDGER}/v1/pay`, { cid: uuid(2), at: NOW - 2000, requestId: 'r2' }),
      responseLine(`${LEDGER}/v1/pay`, 500, { cid: uuid(2), at: NOW - 1900, requestId: 'r2', body: { error: { code: '51', message: 'Недостаточно' } } }),
      appLine({ msg: 'внутренняя ошибка', level: 400, cid: uuid(3), at: NOW - 1000 }),
    ]);
    const r = await demo(a, 'names');
    expect(r.code).toBe(0);
    const n = r.doc.kinds.names;
    expect(n.summary.exchange).toMatchObject({ total: 3, named: 3, outcomeRule: 1 });
    expect(n.summary.errorResponse).toMatchObject({ total: 1, named: 1 });
    expect(n.summary.logError.total).toBe(1);
    const ok = n.entries.exchange.find((e: { kind: string }) => e.kind === 'response');
    expect(ok.catalog).toMatchObject({ system: 'ledger', method: 'ledger|POST|/v1/hold|', outcome: 'success', outcomeLevel: 'system' });
    expect(ok.tree.upstream.body.$json.result.payment_state).toBe('CONFIRMED');
    expect(n.entries.errorResponse[0].http).toMatchObject({ host: 'system:ledger', path: '/v1/pay', status: 500 });
    expect(r.text).not.toMatch(/\p{Script=Cyrillic}/u);
  });

  it('ответ без отправки: сопоставляется по адресу, запуск не падает', async () => {
    const a = new Scripted();
    once(a, [responseLine(`${LEDGER}/v1/hold`, 200, { cid: uuid(1), body: { result: {} } })]);
    const r = await demo(a, 'names');
    expect(r.code).toBe(0);
    expect(r.doc.kinds.names.entries.exchange[0].catalog.system).toBe('ledger');
  });

  it('файла набора нет и файл с ошибками: все методы в неизвестных, код 0', async () => {
    await dropBox(b);
    b = await box({ catalog: null });
    const a = new Scripted();
    once(a, [incomingLine('POST', '/v1/users/x/cards', { cid: uuid(1) })]);
    const none = await demo(a, 'names');
    expect(none.code).toBe(0);
    expect(none.doc.kinds.names.catalog).toEqual({ source: 'none' });
    expect(none.doc.kinds.names.unknown[0]).toMatchObject({ kind: 'method', http: 'POST', count: 1 });
    await dropBox(b);
    b = await box({ catalog: { version: 1, project: 'pay', systems: [{ key: 'x', name: 'Y', methods: [{ http: 'BAD', path: 'no-slash', name: 'Z' }] }] } });
    const c = new Scripted();
    once(c, [incomingLine('POST', '/v1/users/x/cards', { cid: uuid(1) })]);
    const invalid = await demo(c, 'names');
    expect(invalid.code).toBe(0);
    expect(invalid.doc.kinds.names.catalog.source).toBe('invalid');
    expect(invalid.doc.kinds.names.catalog.errors).toBeGreaterThan(0);
    expect(invalid.doc.kinds.names.unknown).toHaveLength(1);
  });

  it('ключ метода и код проходят проверку содержимого на всём pay.yaml', async () => {
    const text = await readFile(resolve(ROOT, 'config/catalog/pay.yaml'), 'utf8');
    const parsed = parseCatalogText(text);
    if (!parsed.ok) throw new Error('файл набора не разобрался');
    const s = snapshotFromFile(parsed.value, 'pay');
    const key = new Map(s.systems.map((x) => [x.id, x.key]));
    const bad = s.methods.filter((m) => !passesForm(methodKey(key.get(m.systemId)!, m)));
    expect(bad).toHaveLength(0);
    for (const e of s.errors) if (e.code !== null) expect(passesForm(valueOrLabel(e.code))).toBe(true);
    for (const x of s.systems) expect(passesForm(x.key)).toBe(true);
  });
});

describe('список неизвестного', () => {
  const LEDGER = 'http://ledger.local';
  const answerOnce = (a: Scripted, lines: LogLine[]) => {
    let done = false;
    a.answer = () => {
      if (done) return [];
      done = true;
      return lines;
    };
  };

  it('неизвестный метод у пяти correlation_id: одна строка с числом', async () => {
    const a = new Scripted();
    answerOnce(a, [1, 2, 3, 4, 5].map((i) => sendLine(`${LEDGER}/v1/internal/${uuid(100 + i)}/sync`, { cid: uuid(i), at: NOW - i * 1000 })));
    const r = await demo(a, 'names');
    expect(r.doc.kinds.names.unknown).toEqual([{ kind: 'method', system: 'ledger', http: 'POST', path: '/v1/internal/{internal}/sync', count: 5 }]);
  });

  it('неизвестный метод RPC: ключ системы и действие', async () => {
    const a = new Scripted();
    answerOnce(a, [sendLine('http://fraud.local/', { cid: uuid(1), body: { jsonrpc: '2.0', id: 1, method: 'risk.report', params: {} } })]);
    const r = await demo(a, 'names');
    expect(r.doc.kinds.names.unknown[0]).toMatchObject({ kind: 'method', system: 'fraud', rpc: 'risk.report', path: '/' });
  });

  it('неизвестная ошибка: статус и код, текст меткой; данные в коде меткой', async () => {
    const a = new Scripted();
    const uri = `${LEDGER}/v1/pay`;
    answerOnce(a, [
      sendLine(uri, { cid: uuid(1), at: NOW - 3000 }),
      responseLine(uri, 500, { cid: uuid(1), at: NOW - 2900, body: { error: { code: 'E77', message: 'Клиент Тестов не найден' } } }),
      sendLine(uri, { cid: uuid(2), at: NOW - 2000 }),
      responseLine(uri, 500, { cid: uuid(2), at: NOW - 1900, body: { error: { code: 'Тестов', message: 'x' } } }),
      sendLine(uri, { cid: uuid(3), at: NOW - 1000 }),
      responseLine(uri, 500, { cid: uuid(3), at: NOW - 900, body: { error: { code: '1234567', message: 'x' } } }),
    ]);
    const r = await demo(a, 'names');
    expect(r.code).toBe(0);
    const rows = r.doc.kinds.names.unknown.filter((u: { kind: string }) => u.kind === 'error');
    const named = rows.find((u: { code: string }) => u.code === 'E77');
    expect(named).toMatchObject({ system: 'ledger', status: 500, path: '/v1/pay', count: 1 });
    expect(named.text).toMatch(/^<\w+:\d+>$/);
    expect(r.text).not.toContain('Тестов');
    expect(r.text).not.toContain('1234567');
    expect(rows.some((u: { code: string }) => u.code === '<cyr:6>')).toBe(true);
  });

  it('строки совпали после замены: одна строка, число correlation_id без повторов', async () => {
    const a = new Scripted();
    const u = (w: string) => `${LEDGER}/v1/clients/${w}/x`;
    answerOnce(a, [
      sendLine(u('testov'), { cid: uuid(1), at: NOW - 3000 }),
      sendLine(u('petrov'), { cid: uuid(2), at: NOW - 2000 }),
      sendLine(u('petrov'), { cid: uuid(2), at: NOW - 1000 }),
    ]);
    const r = await demo(a, 'names');
    expect(r.doc.kinds.names.unknown).toEqual([{ kind: 'method', system: 'ledger', http: 'POST', path: '/v1/{seg}/{seg}/{seg}', count: 2 }]);
    expect(r.text).not.toContain('testov');
  });

  it('записи с одним шаблоном у разных correlation_id и частое слово', async () => {
    const a = new Scripted();
    answerOnce(a, [1, 2, 3].map((i) => sendLine(`${LEDGER}/v1/bind/${uuid(i)}`, { cid: uuid(i), at: NOW - i * 1000 })));
    const r = await demo(a, 'names');
    expect(r.doc.kinds.names.unknown[0]).toMatchObject({ path: '/v1/bind/{bind}', count: 3 });
  });

  it('больше 50 строк: самые частые и more', async () => {
    const a = new Scripted();
    const lines: LogLine[] = [];
    let cid = 0;
    // Слово остаётся в шаблоне только у 3 разных correlation_id, поэтому у каждого метода их три.
    for (let i = 0; i < 60; i++) for (let k = 0; k < 3; k++) lines.push(sendLine(`http://ledger.local/w${i}`, { cid: uuid(++cid), at: NOW - cid }));
    for (let k = 0; k < 5; k++) lines.push(sendLine('http://ledger.local/popular', { cid: uuid(++cid), at: NOW - cid }));
    answerOnce(a, lines);
    const r = await demo(a, 'names');
    const n = r.doc.kinds.names;
    expect(n.unknown).toHaveLength(50);
    expect(n.more).toBe(11);
    expect(n.unknown[0]).toMatchObject({ path: '/popular', count: 5 });
    expect(n.unknown[49].count).toBe(3);
  });
});

describe('порядок маскирования', () => {
  it('фамилия, e-mail и дата рождения отмечены маской: виды идут все, в том числе выключенные по умолчанию', async () => {
    const a = new Scripted();
    a.values = { container: ['worker-a'] };
    const body = { family_name: 'Тестов', last_name: 'Testov', email: 'user@example.com', birth_date: '1990-01-01', phone: '447700900001', note: 'строка\nс переводом' };
    a.answer = () => [appLine({ cid: uuid(1), fields: { upstream: { method: 'POST', url: 'http://core.local/customers', body: JSON.stringify(body) } } })];
    const r = await run(b, ['--env', 'demo', '--kind', 'background'], { createAdapter: () => a });
    const t = r.doc.kinds.background.candidates[0].entries[0].tree.upstream.body.$json;
    expect(t.family_name).toBe('<masked:6>');
    expect(t.last_name).toBe('<masked:6>');
    expect(t.phone).toMatch(/^<masked:\d+>$/);
    expect(t.email).toMatch(/^<masked:\d+>$/);
    expect(t.birth_date).toBe('<masked:3>');
    for (const v of ['Тестов', 'Testov', 'user@example.com', '1990-01-01', '447700900001']) expect(r.text).not.toContain(v);
  });

  it('номер счёта и токен карты: значений нет в файле, ни в поле, ни в адресе', async () => {
    const a = new Scripted();
    a.values = { container: ['worker-a'] };
    const account = '10500000900123456777';
    const token = '400000ABCDEF1234';
    const body = { accountId: '36999719', bankAccountId: '7001112344650819', card_tokens: [token], first_name: 'Testname', middle_name: 'Testovich' };
    a.answer = () => [appLine({ cid: uuid(1), fields: { upstream: { method: 'POST', url: `http://h.example/v1/accounts/${account}/00001/${token}`, body: JSON.stringify(body) } } })];
    const r = await run(b, ['--env', 'demo', '--kind', 'background'], { createAdapter: () => a });
    for (const v of [account, token, '36999719', '7001112344650819', 'Testname', 'Testovich']) expect(r.text).not.toContain(v);
  });

  it('команда не обращается к настройке маскирования: выключить вид негде', async () => {
    await dropBox(b);
    b = await box({ catalog: { version: 1, project: 'pay', masking: [{ type: 'phone', enabled: false }], systems: [{ key: 'pay', kind: 'project', name: 'Demo Pay' }] } });
    const a = new Scripted();
    a.values = { container: ['worker-a'] };
    a.answer = () => [appLine({ cid: uuid(1), fields: { ctx: { phone: '447700900001' } } })];
    const r = await run(b, ['--env', 'demo', '--kind', 'background'], { createAdapter: () => a });
    expect(r.text).not.toContain('447700900001');
    expect(r.doc.kinds.background.candidates[0].entries[0].tree.ctx.phone).toMatch(/^<masked:\d+>$/);
  });

  it('метки записи: шлюзовые значения проходят только через фильтр', async () => {
    const a = new Scripted();
    a.values = { container: ['worker-a'] };
    a.answer = () => [gatewayLine({ cid: uuid(1), labels: { ...GW_LABELS, namespace: '192.0.2.40' } })];
    const r = await run(b, ['--env', 'demo', '--kind', 'background'], { createAdapter: () => a });
    expect(r.doc.kinds.background.candidates[0].entries[0].labels.namespace).toMatch(/^<mixed:10>$/);
  });
});
