import { buildTrace, type ViewRecord } from '@threadline/core/search';
import { describe, expect, it } from 'vitest';
import {
  appSummary,
  axisTicks,
  defaultSelection,
  defaultTab,
  errorText,
  formatTick,
  httpStatusText,
  neighbourStep,
  percent,
  stepBlocks,
  stepOutcome,
  visibleSteps,
} from './trace-model.ts';

// Записи выдуманы; вид — как отдаёт сервер (ViewRecord).

let seq = 0;
function rec(kind: ViewRecord['kind'], offsetMs: number, over: Partial<ViewRecord> = {}): ViewRecord {
  seq += 1;
  return {
    id: `r${seq}`,
    tsNs: String(seq),
    timeMs: 1_762_000_000_000 + offsetMs,
    offsetMs,
    kind,
    title: kind,
    message: kind,
    level: 'INFO',
    isError: false,
    component: 'api',
    gateway: false,
    correlationId: 'c1',
    requestId: 'rid',
    http: null,
    sections: { headers: null, body: null, payload: null, context: null },
    raw: '{"message":"x"}',
    match: null,
    ...over,
  };
}

const http = (over: Partial<NonNullable<ViewRecord['http']>> = {}): NonNullable<ViewRecord['http']> => ({
  method: 'POST',
  uri: 'http://switch.pay.example:9191/v3/cards/info',
  status: null,
  durationMs: null,
  pairId: null,
  noResponse: false,
  pending: false,
  ...over,
});

/** Запрос api через шлюз: вход, WARNING, обмен с коммутатором, отправка в проверку мошенничества без ответа. */
function apiRequest(switchBody = '{"id":"1","result":{}}', switchStatus = 200) {
  const incoming = rec('incoming', 0, {
    component: 'gateway',
    gateway: true,
    title: 'GET /v1/users/u1/cards/c1',
    message: 'request received',
    level: 'DEBUG',
    http: http({ method: 'GET', uri: '/v1/users/u1/cards/c1' }),
    sections: { headers: { Host: ['api.pay.example'] }, body: null, payload: null, context: null },
  });
  const warn = rec('log', 5, { level: 'WARNING', isError: true, title: 'Circuit breaker opened', message: 'Circuit breaker opened', sections: { headers: null, body: null, payload: null, context: { service: 'fraud' } } });
  const send = rec('send', 10, { http: http(), sections: { headers: { 'Content-Type': ['application/json'] }, body: '{"id":"1"}', payload: null, context: null } });
  const resp = rec('response', 23, { http: http({ status: switchStatus, durationMs: 13, pairId: send.id }), sections: { headers: null, body: switchBody, payload: null, context: null } });
  send.http = { ...send.http!, pairId: resp.id, durationMs: 13 };
  resp.isError = switchStatus >= 400;
  const sv = rec('send', 25, { http: http({ uri: 'http://fraud.pay.example:9090/', noResponse: true }), sections: { headers: null, body: '{}', payload: null, context: null } });
  const last = rec('log', 33);
  return [incoming, warn, send, resp, sv, last];
}

describe('выбор по умолчанию', () => {
  it('первый шаг с ошибкой, иначе вход', () => {
    const records = apiRequest();
    // Отправка без ответа — неудачная попытка: она важнее записи-лога с ошибкой.
    expect(records[4]!.http?.noResponse).toBe(true);
    expect(defaultSelection(buildTrace(records))).toBe(records[4]!.id);
    // Ответ ещё может прийти: это не ошибка, выбрана запись-лог с ошибкой.
    records[4] = { ...records[4]!, http: { ...records[4]!.http!, pending: true } };
    expect(defaultSelection(buildTrace(records))).toBe(records[1]!.id);
    // Ошибок нет — вход.
    records[1] = { ...records[1]!, isError: false, level: 'INFO' };
    expect(defaultSelection(buildTrace(records))).toBe(records[0]!.id);
    // Без входа и без ошибок — первый шаг.
    expect(defaultSelection(buildTrace(records.slice(1)))).toBe(records[1]!.id);
    expect(defaultSelection(buildTrace([]))).toBeNull();
  });
});

describe('вкладки подробностей', () => {
  it('обмен: запрос, ответ, сырые записи; адрес, заголовки и тело — блоки внутри; сразу открыт ответ', () => {
    const records = apiRequest();
    const trace = buildTrace(records);
    const byId = new Map(records.map((r) => [r.id, r]));
    const sw = trace.steps.find((s) => s.kind === 'exchange' && s.status === 200)!;
    const blocks = stepBlocks(sw, byId);
    expect([...blocks.keys()]).toEqual(['request', 'response', 'raw']);
    expect(blocks.get('request')!.map((b) => b.block.name)).toEqual(['request', 'headers', 'body']);
    expect(blocks.get('response')!.map((b) => b.block.name)).toEqual(['request', 'response']);
    expect(blocks.get('raw')).toHaveLength(2);
    expect(defaultTab(sw, [...blocks.keys()])).toBe('response');
  });

  it('отправка без ответа — запрос; лог — контекст; вход — запрос', () => {
    const records = apiRequest();
    const trace = buildTrace(records);
    const byId = new Map(records.map((r) => [r.id, r]));
    const tabs = (id: string) => {
      const s = trace.steps.find((x) => x.id === id)!;
      return defaultTab(s, [...stepBlocks(s, byId).keys()]);
    };
    expect(tabs(records[4]!.id)).toBe('request');
    expect(tabs(records[1]!.id)).toBe('context');
    expect(tabs(records[5]!.id)).toBe('raw');
    expect(tabs(records[0]!.id)).toBe('request');
  });
});

describe('текст ошибки шага', () => {
  it('бизнес-ошибка из тела, HTTP-статус, уровень записи', () => {
    const processor =
      '<Envelope><Body><ResponseInfo><response_code>8</response_code><error_description>PRC-ERR-0027 Card not found</error_description></ResponseInfo></Body></Envelope>';
    let records = apiRequest(processor);
    records[3] = { ...records[3]!, isError: true };
    let trace = buildTrace(records);
    let byId = new Map(records.map((r) => [r.id, r]));
    const ex = (t: typeof trace) => t.steps.find((s) => s.id === records[2]!.id)!;
    expect(errorText(ex(trace), byId)).toContain('Card not found');

    records = apiRequest('{}', 500);
    trace = buildTrace(records);
    byId = new Map(records.map((r) => [r.id, r]));
    // Статус — со смыслом, а не голым числом.
    expect(errorText(ex(trace), byId)).toBe('HTTP 500 — внутренняя ошибка сервера');
    expect(errorText(trace.steps.find((s) => s.id === records[1]!.id)!, byId)).toBe('WARNING: Circuit breaker opened');
    expect(errorText(trace.steps[0]!, byId)).toBeNull();
  });

  it('у Бизнеса нет ни тела, ни статуса, ни текста записи: одного уровня в тексте нет, итог общим словом', () => {
    const send = rec('send', 0, { http: http({ uri: '/x', status: null }), message: '' });
    const resp = rec('response', 10, { http: http({ uri: '/x', pairId: send.id, status: null }), message: '', level: 'INFO', isError: true });
    send.http = { ...send.http!, pairId: resp.id };
    const records = [send, resp];
    const trace = buildTrace(records);
    const byId = new Map(records.map((r) => [r.id, r]));
    expect(errorText(trace.steps[0]!, byId)).toBeNull();
    expect(stepOutcome(trace.steps[0]!, byId)).toMatchObject({ tone: 'danger', label: 'Ошибка' });
    const call = rec('call', 0, { title: 'getCard', message: '', level: 'ERROR', isError: true });
    expect(stepOutcome(buildTrace([call]).steps[0]!, new Map([[call.id, call]]))).toMatchObject({ tone: 'danger', label: 'Ошибка' });
  });
});

describe('итог шага', () => {
  it('обмен: OK со статусом и длительностью, ошибка — текстом, без ответа — «ответ в логах не найден»', () => {
    let records = apiRequest();
    let trace = buildTrace(records);
    let byId = new Map(records.map((r) => [r.id, r]));
    const sw = () => trace.steps.find((s) => s.id === records[2]!.id)!;
    expect(stepOutcome(sw(), byId)).toEqual({ tone: 'success', label: 'OK', status: 200, durationMs: 13 });

    const sv = trace.steps.find((s) => s.id === records[4]!.id)!;
    expect(stepOutcome(sv, byId)).toMatchObject({ tone: 'danger', label: 'ответ в логах не найден', status: null });

    records = apiRequest('{}', 404);
    trace = buildTrace(records);
    byId = new Map(records.map((r) => [r.id, r]));
    expect(stepOutcome(sw(), byId)).toMatchObject({ label: 'Не найдено', status: 404, durationMs: 13 });

    // Вход и вызов без своего итога: только длительность.
    expect(stepOutcome(trace.steps[0]!, byId)).toMatchObject({ tone: 'neutral', label: null });
  });

  it('смысл HTTP-статуса: известный, по классу, без смысла', () => {
    expect(httpStatusText(503)).toBe('HTTP 503 — сервис недоступен');
    expect(httpStatusText(418)).toBe('HTTP 418 — ошибка в запросе');
    expect(httpStatusText(599)).toBe('HTTP 599 — ошибка на стороне системы');
    expect(httpStatusText(302)).toBe('HTTP 302');
  });
});

describe('сводка входа и логов приложения', () => {
  it('вход от шлюза, приложение без записей шлюза, логи с уровнями', () => {
    const records = apiRequest();
    const s = appSummary(buildTrace(records), records);
    expect(s.entrySource).toBe('шлюз');
    expect(s.app).toMatchObject({ component: 'api', recordCount: 5, warnings: 1, errors: 0 });
    expect(s.app.logs).toHaveLength(2);
  });

  it('шлюз узнаётся по флагу записи, а не по компоненту: у шлюза бывает контейнер server', () => {
    const records = apiRequest();
    records[0] = { ...records[0]!, component: 'server' };
    const trace = buildTrace(records);
    const s = appSummary(trace, records);
    expect(s.entrySource).toBe('шлюз');
    expect(s.app).toMatchObject({ component: 'api', recordCount: 5 });
    expect(trace.chain).toEqual(['шлюз', 'api', 'switch.pay.example', 'fraud.pay.example']);
    // Запись приложения с компонентом gateway — не шлюз: вход из приложения, источник — компонент.
    const plain = apiRequest().map((r) => ({ ...r, component: 'gateway', gateway: false }));
    const p = appSummary(buildTrace(plain), plain);
    expect(p.entrySource).toBe('gateway');
    expect(p.app).toMatchObject({ component: 'gateway', recordCount: 6 });
  });

  it('только запись шлюза: вход из шлюза, компонента приложения нет', () => {
    const [incoming] = apiRequest();
    const records = [{ ...incoming!, component: 'server' }];
    const s = appSummary(buildTrace(records), records);
    expect(s.entrySource).toBe('шлюз');
    expect(s.app).toMatchObject({ component: null, recordCount: 0 });
  });

  it('без входа — источник не указан', () => {
    const call = rec('call', 2, { title: 'getCard', component: 'cards' });
    const send = rec('send', 3, { component: 'cards', http: http({ uri: 'https://processor.pay.example:8443/soap/issuing' }) });
    const resp = rec('response', 9, { component: 'cards', http: http({ uri: 'https://processor.pay.example:8443/soap/issuing', status: 200, pairId: send.id, durationMs: 6 }) });
    send.http = { ...send.http!, pairId: resp.id };
    const records = [call, send, resp];
    const s = appSummary(buildTrace(records), records);
    expect(s.entrySource).toBeNull();
    expect(s.app).toMatchObject({ component: 'cards', recordCount: 3 });
  });
});

describe('шкала', () => {
  it('деления и подписи', () => {
    expect(axisTicks(33)).toEqual([0, 8.25, 16.5, 24.75, 33]);
    expect(axisTicks(33).map((v) => formatTick(v, 33))).toEqual(['0 мс', '8 мс', '17 мс', '25 мс', '33 мс']);
    expect(axisTicks(5).map((v) => formatTick(v, 5))).toEqual(['0 мс', '1,3 мс', '2,5 мс', '3,8 мс', '5 мс']);
    expect(axisTicks(1250).map((v) => formatTick(v, 1250))).toEqual(['0 с', '0,31 с', '0,63 с', '0,94 с', '1,25 с']);
    expect(formatTick(30_000, 30_000)).toBe('30 с');
  });

  it('проценты: деление на ноль и края', () => {
    expect(percent(5, 0)).toBe(0);
    expect(percent(-1, 10)).toBe(0);
    expect(percent(20, 10)).toBe(100);
    expect(percent(5, 10)).toBe(50);
  });
});

describe('выбор при открытии с учётом справочника', () => {
  const uri = 'http://ledger.pay.example/x';
  const failing = (offset: number, over: Partial<ViewRecord> = {}) => {
    const send = rec('send', offset, { http: http({ uri }) });
    const resp = rec('response', offset + 5, { isError: true, http: http({ uri, status: 500, pairId: send.id }), ...over });
    send.http = { ...send.http!, pairId: resp.id };
    return [send, resp];
  };
  const byId = (records: readonly ViewRecord[]) => new Map(records.map((r) => [r.id, r]));

  it('шаг, снятый правилом итога, не перекрывает настоящую ошибку', () => {
    const catalog = { name: null, error: null, outcome: { kind: 'success', rule: { id: 1, level: 'method' }, text: null, action: null }, ids: [], status: null };
    const lifted = failing(10, { catalog } as Partial<ViewRecord>);
    const real = failing(100);
    const records = [rec('incoming', 0, { http: http({ uri: '/v1/x' }) }), ...lifted, ...real];
    const trace = buildTrace(records);
    const id = defaultSelection(trace, byId(records));
    expect(trace.steps.find((s) => s.id === id)!.recordIds).toContain(real[1]!.id);
  });

  it('обмен с ошибкой раньше записи-лога с ошибкой, даже если лог идёт первым', () => {
    const log = rec('log', 5, { level: 'WARNING', isError: true });
    const real = failing(50);
    const records = [rec('incoming', 0, { http: http({ uri: '/v1/x' }) }), log, ...real];
    const trace = buildTrace(records);
    const id = defaultSelection(trace, byId(records));
    expect(trace.steps.find((s) => s.id === id)!.recordIds).toContain(real[1]!.id);
  });
});

describe('наложение открытых значений', () => {
  it('блоки шага берут открытое значение, запись остаётся строгой: заголовок, итог и граф читают её', () => {
    const r = rec('log', 0, { raw: 'raw ********0001', open: { uri: null, sections: { headers: null, body: null, payload: null, context: null }, raw: 'raw 447700900001' } });
    const trace = buildTrace([r]);
    const byId = new Map([[r.id, r]]);
    const step = trace.steps[0]!;
    const items = [...stepBlocks(step, byId).values()].flat();
    expect(items.find((b) => b.block.name === 'raw')!.block.text).toBe('raw 447700900001');
    for (const b of items) expect(b.record).toBe(r);
    const shown = [...stepBlocks(step, byId, new Map([[r.id, { id: r.id, uri: null, sections: r.sections, raw: 'показ' }]])).values()].flat();
    expect(shown.find((b) => b.block.name === 'raw')!.block.text).toBe('показ');
  });
});

describe('шаги в режиме', () => {
  const log = (offset: number, over: Partial<ViewRecord> = {}) => rec('log', offset, over);
  const exchange = (offset: number) => [
    rec('send', offset, { http: { method: 'POST', uri: 'https://x.example/a', status: null, durationMs: null, noResponse: false, pending: false, pairId: null } as never }),
  ];

  it('обычные логи скрыты, лог с ошибкой на месте, ось та же', () => {
    const records = [rec('incoming', 0), log(1), log(2, { level: 'ERROR', isError: true }), ...exchange(3), log(4)];
    const t = buildTrace(records);
    const byId = new Map(records.map((r) => [r.id, r]));
    const shown = visibleSteps(t, byId, false);
    expect(shown.filter((s) => s.kind === 'log')).toHaveLength(1);
    expect(shown.find((s) => s.kind === 'log')?.isError).toBe(true);
    expect(shown.length).toBeLessThan(t.steps.length);
    expect(visibleSteps(t, byId, true)).toHaveLength(t.steps.length);
  });

  it('поток только из логов показывается целиком, выбрана первая запись', () => {
    const records = [log(0), log(1), log(2)];
    const t = buildTrace(records);
    const byId = new Map(records.map((r) => [r.id, r]));
    const shown = visibleSteps(t, byId, false);
    expect(shown).toHaveLength(3);
    expect(defaultSelection(t, byId, shown)).toBe(records[0]!.id);
  });

  it('скрытый выбранный шаг: выбор по умолчанию считается среди видимых', () => {
    const records = [rec('incoming', 0), log(1, { level: 'WARNING', isError: true }), log(2)];
    const t = buildTrace(records);
    const byId = new Map(records.map((r) => [r.id, r]));
    const shown = visibleSteps(t, byId, false);
    expect(defaultSelection(t, byId, shown)).toBe(records[1]!.id);
    const clean = [rec('incoming', 0), log(1)];
    const tc = buildTrace(clean);
    const byC = new Map(clean.map((r) => [r.id, r]));
    expect(defaultSelection(tc, byC, visibleSteps(tc, byC, false))).toBe(clean[0]!.id);
  });
});

describe('neighbourStep: J и K', () => {
  const steps = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  it('следующий и предыдущий, на краю на месте', () => {
    expect(neighbourStep(steps, 'a', 1)).toBe('b');
    expect(neighbourStep(steps, 'b', -1)).toBe('a');
    expect(neighbourStep(steps, 'c', 1)).toBe('c');
    expect(neighbourStep(steps, 'a', -1)).toBe('a');
  });
  it('выбран шаг не из списка: первый; пустой список: ничего', () => {
    expect(neighbourStep(steps, 'app', 1)).toBe('a');
    expect(neighbourStep([], null, 1)).toBeNull();
  });
});
