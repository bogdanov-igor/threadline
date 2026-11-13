import { describe, expect, it } from 'vitest';
import '../../i18n/index.ts';
import type { Outcome } from '@/features/request/trace-model.ts';
import type { CatalogError, CatalogName, ErrorReason, RecordCatalog, RequestSummary, Trace, TraceStep, ViewRecord } from '@threadline/core/search';
import { bannerKind } from './CatalogBanner.tsx';
import { briefReason, catalogLine, catalogReasonView, chainNames, entryName, stepCatalog, stepIsError, stepVerdict } from './names.ts';
import { displayVerdict } from './StepOutcome.tsx';
import { briefSystem, collapseNeighbours } from '@/features/view/brief.ts';

// Названия справочника в списке запросов и в трассе запроса.

const SWITCH: CatalogName = {
  source: 'external',
  system: { key: 'switch', name: 'Коммутатор', type: 'service' },
  method: { id: 3, name: 'Данные карты в коммутаторе', domain: null, kind: 'call', opType: null },
  host: '192.0.2.17:11101',
};
const NOT_FOUND: CatalogError = {
  source: 'external',
  rule: { id: 1, level: 'system', kind: 'error' },
  title: 'Карта не найдена',
  action: 'Проверьте номер карты у клиента',
  severity: 'error',
  partnerCode: '176',
  raw: { http: null, code: '200', text: 'Card not found' },
};

function record(id: string, kind: ViewRecord['kind'], catalog?: RecordCatalog | null, http?: Partial<NonNullable<ViewRecord['http']>>): ViewRecord {
  return {
    id,
    tsNs: '0',
    timeMs: 0,
    offsetMs: 0,
    kind,
    title: '',
    message: '',
    level: null,
    isError: false,
    component: null,
    gateway: false,
    correlationId: 'c1',
    requestId: null,
    http: http ? { method: 'POST', uri: null, status: null, durationMs: null, pairId: null, noResponse: false, pending: false, ...http } : null,
    sections: { headers: null, body: null, payload: null, context: null },
    raw: '',
    match: null,
    ...(catalog !== undefined ? { catalog } : {}),
  };
}

function step(patch: Partial<TraceStep>): TraceStep {
  return { id: 's', parentId: null, depth: 0, kind: 'exchange', title: 'POST http://192.0.2.17:11101/v3/cards/info', system: '192.0.2.17', startMs: 0, endMs: 10, durationMs: 10, status: 200, isError: false, noResponse: false, pending: false, recordIds: ['a', 'b'], ...patch };
}

const cat = (patch: Partial<RecordCatalog>): RecordCatalog => ({ name: null, error: null, outcome: null, ids: [], status: null, ...patch });
const byIdOf = (...rs: ViewRecord[]) => new Map(rs.map((r) => [r.id, r]));

describe('строка списка и причины', () => {
  const summary = (entry?: CatalogName | null): RequestSummary => ({
    correlationId: 'c1',
    firstMs: 0,
    lastMs: 1,
    durationMs: 1,
    incoming: { method: 'GET', path: '/v1/users/u/cards/c' },
    component: 'api',
    recordCount: 3,
    status: 'success',
    kind: 'incoming',
    reasons: [],
    match: 'exact',
    incomplete: false,
    ...(entry !== undefined ? { entry } : {}),
  });

  it('название входящего метода из справочника', () => {
    expect(entryName(summary({ ...SWITCH, source: 'project', method: { ...SWITCH.method!, name: 'Данные карты' } }))).toBe('Данные карты');
  });

  it('справочник выключен или метод не узнан — названия нет', () => {
    expect(entryName(summary())).toBeNull();
    expect(entryName(summary({ ...SWITCH, method: null }))).toBeNull();
  });

  it('причина «Коммутатор · Карта не найдена»', () => {
    const r: ErrorReason = { kind: 'business', text: 'response_code 200: Card not found · POST 192.0.2.17:11101/v3/cards/info', name: SWITCH, error: NOT_FOUND };
    const v = catalogReasonView(r);
    expect(v).toMatchObject({ named: true, system: 'Коммутатор', message: 'Карта не найдена', source: 'external', call: 'Данные карты в коммутаторе' });
  });

  it('причина без справочника — как раньше', () => {
    const v = catalogReasonView({ kind: 'http', text: 'HTTP 500 · POST pay.example/v1/x' });
    expect(v.named).toBe(false);
    expect(v.codes).toEqual(['HTTP 500']);
  });

  it('ошибка по правилу итога — текст правила', () => {
    const v = catalogReasonView({ kind: 'outcome', text: 'Limit exceeded', name: SWITCH, error: { ...NOT_FOUND, rule: { id: 9, level: 'system', kind: 'outcome' }, title: null } });
    expect(v).toMatchObject({ named: true, message: 'Limit exceeded', system: 'Коммутатор' });
  });

  it('ожидание ответа не ошибка и при описанной системе', () => {
    const text = 'ответ ещё не пришёл · POST switch.pay.example/v3';
    expect(catalogReasonView({ kind: 'pending', text, name: SWITCH, error: null })).toMatchObject({ source: 'pending', label: 'pending', message: 'Ответ ещё не пришёл' });
  });
});

describe('шаг трассы', () => {
  it('имя с отправки, ошибка и итог с ответа', () => {
    const byId = byIdOf(record('a', 'send', cat({ name: SWITCH })), record('b', 'response', cat({ name: SWITCH, error: NOT_FOUND })));
    const c = stepCatalog(step({ isError: true }), byId);
    expect(c?.name?.system?.name).toBe('Коммутатор');
    expect(c?.error?.title).toBe('Карта не найдена');
  });

  it('без разметки — null, шаг по своим признакам', () => {
    const s = step({ isError: true });
    expect(stepCatalog(s, byIdOf(record('a', 'send'), record('b', 'response')))).toBeNull();
    expect(stepIsError(s, null)).toBe(true);
  });

  it('«не ошибка» снимает красный', () => {
    const s = step({ isError: true });
    const c = stepCatalog(s, byIdOf(record('a', 'send', cat({ name: SWITCH })), record('b', 'response', cat({ error: { ...NOT_FOUND, severity: 'ok' } }))));
    expect(stepVerdict(s, c)).toBe('ignored');
    expect(stepIsError(s, c)).toBe(false);
  });

  it('правило итога: 422 и OK — успех, 200 и error — ошибка, 202 — в обработке', () => {
    const rule = { id: 1, level: 'system' as const };
    const withOutcome = (s: TraceStep, kind: 'success' | 'error' | 'pending', text: string | null = null) =>
      stepCatalog(s, byIdOf(record('a', 'send', cat({ name: SWITCH })), record('b', 'response', cat({ outcome: { kind, rule, text, action: null } }))));
    const s422 = step({ status: 422, isError: true });
    expect(stepIsError(s422, withOutcome(s422, 'success'))).toBe(false);
    const s200 = step({ status: 200 });
    expect(stepIsError(s200, withOutcome(s200, 'error', 'Лимит превышен'))).toBe(true);
    const s202 = step({ status: 202 });
    expect(stepVerdict(s202, withOutcome(s202, 'pending'))).toBe('pending');
  });

  it('строка итога: текст правила и цвет', () => {
    const o: Outcome = { tone: 'neutral', label: 'HTTP 200', status: 200, durationMs: 10 };
    const words = { ok: 'OK', pending: 'в обработке', ignored: 'по справочнику не ошибка' };
    const s = step({ status: 200 });
    const c = stepCatalog(s, byIdOf(record('a', 'send', cat({ name: SWITCH })), record('b', 'response', cat({ outcome: { kind: 'error', rule: { id: 1, level: 'method' }, text: 'Лимит превышен', action: null } }))));
    expect(catalogLine(o, s, c, words)).toMatchObject({ tone: 'danger', label: 'Лимит превышен' });
    expect(catalogLine(o, s, null, words)).toBe(o);
  });

  it('итог блока: успешно, ошибка, ответ ещё не пришёл', () => {
    const c = { name: SWITCH, error: null, outcome: null, status: null, ids: [] };
    expect(displayVerdict(step({}), c)).toBe('success');
    expect(displayVerdict(step({ isError: true }), c)).toBe('error');
    expect(displayVerdict(step({ noResponse: true, pending: true }), c)).toBe('pending');
  });

  it('итог блока: у входа — итог запроса, как на его узле', () => {
    const c = { name: SWITCH, error: null, outcome: null, status: null, ids: [] };
    expect(displayVerdict(step({ kind: 'incoming' }), c, 'error')).toBe('error');
    expect(displayVerdict(step({ kind: 'incoming', parentId: 'x' }), c, 'error')).toBe('success');
    expect(displayVerdict(step({}), c, 'error')).toBe('success');
  });

  it('цепочка именами систем', () => {
    const s = step({});
    const trace: Trace = { steps: [s], totalMs: 10, externalMs: 10, chain: ['шлюз', 'api', '192.0.2.17'], startTimeMs: 0 };
    expect(chainNames(trace, byIdOf(record('a', 'send', cat({ name: SWITCH })), record('b', 'response')), (h) => h)).toEqual(['шлюз', 'api', 'Коммутатор']);
    expect(chainNames(trace, byIdOf(record('a', 'send'), record('b', 'response')), (h) => `host ${h}`)).toEqual(['шлюз', 'api', 'host 192.0.2.17']);
  });
});

describe('полоса справочника', () => {
  it('нет полосы в off и ok', () => {
    expect(bannerKind({ state: 'off', loadedAt: null, message: null })).toBe('none');
    expect(bannerKind({ state: 'ok', loadedAt: 1, message: null })).toBe('none');
    expect(bannerKind(undefined)).toBe('none');
  });

  it('без данных — «названия не показаны», с данными — «данные на HH:MM»', () => {
    expect(bannerKind({ state: 'connecting', loadedAt: null, message: null })).toBe('unavailable');
    expect(bannerKind({ state: 'error', loadedAt: null, message: 'x' })).toBe('unavailable');
    expect(bannerKind({ state: 'stale', loadedAt: 1, message: null })).toBe('stale');
  });
});

describe('цепочка в «Кратко»', () => {
  it('две системы по IP без справочника дают одно имя', () => {
    const exchange = (id: string, system: string): TraceStep => ({ id, kind: 'exchange', system, recordIds: [] }) as unknown as TraceStep;
    const trace = { chain: ['api', '10.77.0.1', '10.77.0.2', 'switch.pay.example'], steps: [exchange('a', '10.77.0.1'), exchange('b', '10.77.0.2'), exchange('c', 'switch.pay.example')] } as unknown as Trace;
    expect(collapseNeighbours(chainNames(trace, new Map(), (host) => briefSystem(host)))).toEqual(['api', 'Внешняя система', 'switch']);
  });
});

describe('причина в «Кратко»', () => {
  const brief = (r: ErrorReason, operation: string | null = null) => briefReason(catalogReasonView(r), operation);
  const clean = (b: ReturnType<typeof brief>, bad: readonly string[]) => {
    for (const x of bad) {
      expect(b.message).not.toContain(x);
      expect(b.title).not.toContain(x);
      expect(b.system ?? '').not.toContain(x);
    }
  };

  it('коды и адрес не попадают ни в текст, ни в подсказку', () => {
    const b = brief({ kind: 'business', text: 'response_code 8: PRC-ERR-0027 Card not found · POST 192.0.2.17:8443/soap/issuing' });
    expect(b.message).toBe('Card not found');
    expect(b.system).toBe('Внешняя система');
    expect(b.call).toBeNull();
    clean(b, ['192.0.2.17', '8443', 'PRC-ERR', 'response_code', 'POST']);
  });

  it('HTTP 500 — смысл статуса словами', () => {
    const b = brief({ kind: 'http', text: 'HTTP 500 · POST switch.pay.example:11101/v3' });
    expect(b.message).not.toContain('500');
    expect(b.message).not.toBe('');
    expect(b.system).toBe('switch');
    clean(b, ['HTTP', '500', '11101']);
  });

  it('текст справочника и имена без изменений, метод — только название', () => {
    const named: ErrorReason = { kind: 'business', text: 'response_code 200: Card not found · POST 192.0.2.17:11101/v3/cards/info', name: SWITCH, error: NOT_FOUND };
    const v = catalogReasonView(named);
    expect(v.callNamed).toBe(!!SWITCH.method?.name);
    const b = briefReason(v);
    expect(b.message).toBe(v.message);
    expect(b.system).toBe(SWITCH.system?.name);
    clean(b, ['192.0.2.17', '11101', 'response_code']);
  });

  it('операция из трассы важнее названия', () => {
    const b = brief({ kind: 'business', text: 'response_code 8: Card not found · POST 192.0.2.17:8443/soap/issuing' }, 'getCard');
    expect(b.call).toBe('getCard');
    expect(b.title).toBe('Card not found · Внешняя система · getCard');
  });

  it('путь без названия справочника в подсказку не идёт', () => {
    const v = catalogReasonView({ kind: 'http', text: 'HTTP 502 · POST /v1/secret-path' });
    expect(v.callNamed).toBe(false);
    expect(briefReason(v).title).not.toContain('secret-path');
  });
});
