// Экран Бизнеса: состояние, шаги и причина из ответа по списку полей. Значения выдуманы.
import { buildTrace, type ErrorReason, type RecordCatalog, type RequestDetail, type RequestSummary, type ViewRecord } from '@threadline/core/search';
import { businessDetail, businessRecords } from '@threadline/core/view/business';
import { describe, expect, it } from 'vitest';
import { fixture, FIXTURE_ACTION, FIXTURE_ENTRY, FIXTURE_TITLE } from './fixtures.ts';
import { businessModel, businessSteps } from './model.ts';

const modelOf = (d: RequestDetail) => {
  const trace = buildTrace(d.records);
  return businessModel(d.summary, trace, new Map(d.records.map((r) => [r.id, r])), FIXTURE_ENTRY);
};

const raw = (over: Partial<ViewRecord> & Pick<ViewRecord, 'id' | 'kind'>): ViewRecord => ({ tsNs: '1', timeMs: 1000 + (over.offsetMs ?? 0), offsetMs: 0, title: '', message: '', level: 'INFO', isError: false, component: null, gateway: false, correlationId: 'c', requestId: null, http: null, sections: { headers: null, body: null, payload: null, context: null }, raw: '', match: 'exact', ...over });
const http = (uri: string, over: Partial<NonNullable<ViewRecord['http']>> = {}) => ({ method: null, uri, status: null, durationMs: 5, pairId: null, noResponse: false, pending: false, ...over });
const stepsOf = (records: ViewRecord[], failed = false) => businessSteps(buildTrace(records), new Map(records.map((r) => [r.id, r])), FIXTURE_ENTRY, failed);
const NAMED: RecordCatalog = { name: { source: 'external', system: { key: 'h', name: 'Система', type: 'service' }, method: { id: 1, name: 'Проверка карты', domain: null, kind: 'call', opType: null }, host: null }, error: null, outcome: null, ids: [], status: null };
/** Запрос с готовыми записями: сводка проходит тот же список полей, что на сервере. */
const requestOf = (records: ViewRecord[], status: RequestSummary['status'], reasons: ErrorReason[], over: Partial<RequestSummary> = {}): RequestDetail => businessDetail({ summary: { ...fixture('ok').summary, status, reasons, ...over }, records });

describe('четыре состояния экрана', () => {
  it('всё прошло: шаги по порядку, вход строкой не идёт, слово итога из справочника', () => {
    const m = modelOf(fixture('ok'));
    expect(m.state).toBe('ok');
    expect(m.failed).toBeNull();
    expect(m.undescribed).toBe(false);
    expect(m.steps.map((s) => [s.index, s.name, s.detail, s.tone])).toEqual([
      [1, 'Проверка карты отправителя', 'Процессинг карт', 'ok'],
      [2, 'Проверка карты получателя', 'Процессинг карт', 'ok'],
      [3, 'Списание с карты отправителя', 'Процессинг карт', 'ok'],
      [4, 'Зачисление на карту получателя', 'Процессинг карт', 'ok'],
      [5, 'Уведомление клиенту', 'Процессинг карт', 'ok'],
    ]);
    expect(m.steps[2]!.word).toBe('Списано');
    expect(m.passed).toBe(5);
  });

  it('ошибка описана: текст и «что делать» из справочника, строки о передаче ссылки нет', () => {
    const m = modelOf(fixture('known'));
    expect(m.state).toBe('known');
    expect(m.reason?.message).toBe(FIXTURE_TITLE);
    expect(m.action).toBe(FIXTURE_ACTION);
    expect(m.undescribed).toBe(false);
    expect(m.failed).toMatchObject({ index: 3, name: 'Списание с карты отправителя', tone: 'error', word: FIXTURE_TITLE });
    expect(m.lastStep).toBe(true);
  });

  it('ошибка не описана: шаг, предыдущий шаг, общие слова, строка о передаче ссылки; запланированные шаги не выдумываются', () => {
    const m = modelOf(fixture('unknown'));
    expect(m.state).toBe('unknown');
    expect(m.undescribed).toBe(true);
    expect(m.failed).toMatchObject({ index: 4, name: 'Зачисление на карту получателя', word: null });
    expect(m.previous?.name).toBe('Списание с карты отправителя');
    expect(m.reason?.message).toBe('Внешняя система ответила ошибкой');
    expect(m.lastStep).toBe(false);
    expect(m.steps).toHaveLength(5);
  });

  it('нет ответа: система и шаг, ждали до последней записи, кодов и слова о сроке нет', () => {
    const m = modelOf(fixture('noresp'));
    expect(m.state).toBe('no-answer');
    expect(m.undescribed).toBe(true);
    expect(m.failed).toMatchObject({ index: 2, tone: 'no-answer', system: 'Процессинг карт', name: 'Проверка карты получателя' });
    expect(m.failed!.waitedMs).toBe(19_980);
  });
});

describe('шаги', () => {
  const attempt = (id: string, at: number, isError: boolean, catalog?: RecordCatalog) => [
    raw({ id, kind: 'send', offsetMs: at, http: http('https://h.example/p', { pairId: `${id}-r` }), ...(catalog ? { catalog } : {}) }),
    raw({ id: `${id}-r`, kind: 'response', offsetMs: at + 10, isError, http: http('https://h.example/p', { pairId: id }), ...(catalog ? { catalog } : {}) }),
  ];

  it('повторы подряд одной строкой, успех после неудачи отдельной: ошибка не теряется', () => {
    const steps = stepsOf(businessRecords([...attempt('a', 0, true, NAMED), ...attempt('b', 20, true, NAMED), ...attempt('c', 40, false, NAMED)]));
    expect(steps.map((s) => s.tone)).toEqual(['error', 'ok']);
    expect(steps[0]).toMatchObject({ index: 1, startMs: 0, durationMs: 30 });
    expect(steps[1]!.index).toBe(2);
  });

  it('обмены без названия не сливаются: разные вызовы одной системы от повтора не отличить', () => {
    const steps = stepsOf(businessRecords([...attempt('a', 0, false), ...attempt('b', 20, false), ...attempt('c', 40, false)]));
    expect(steps.map((s) => [s.index, s.name])).toEqual([[1, 'h'], [2, 'h'], [3, 'h']]);
  });

  it('обмены без своего метода в вызове с названием не сливаются: имя вызова их не различает', () => {
    const inCall = (id: string, at: number) => [
      raw({ id: `${id}-s`, kind: 'send', requestId: 'r1', offsetMs: at, http: http('https://h.example/p', { pairId: `${id}-r` }) }),
      raw({ id: `${id}-r`, kind: 'response', requestId: 'r1', offsetMs: at + 4, http: http('https://h.example/p', { pairId: `${id}-s` }) }),
    ];
    const steps = stepsOf(businessRecords([raw({ id: 'call', kind: 'call', title: 'x', requestId: 'r1', catalog: NAMED }), ...inCall('a', 5), ...inCall('b', 20), ...inCall('c', 40)]));
    expect(steps.map((s) => s.index)).toEqual([1, 2, 3]);
  });

  it('разные методы с одним названием не сливаются', () => {
    const other: RecordCatalog = { ...NAMED, name: { ...NAMED.name!, method: { ...NAMED.name!.method!, id: 2 } } };
    const steps = stepsOf(businessRecords([...attempt('a', 0, false, NAMED), ...attempt('b', 20, false, other)]));
    expect(steps.map((s) => s.index)).toEqual([1, 2]);
  });

  it('запуск операции с выданным id не повтор', () => {
    const start: RecordCatalog = { ...NAMED, name: { ...NAMED.name!, method: { ...NAMED.name!.method!, kind: 'start' } }, ids: [{ type: 'p', name: 'Платёж', kind: 'operation', value: 'P-1', at: 'response' }] };
    const steps = stepsOf(businessRecords([...attempt('a', 0, false, start), ...attempt('b', 20, false, start)]));
    expect(steps.map((s) => s.index)).toEqual([1, 2]);
  });

  it('запись-лог с ошибкой не шаг: при ошибке без других красных строк красная строка самого запроса', () => {
    const steps = stepsOf(businessRecords([raw({ id: 'in', kind: 'incoming', http: http('/v1/t') }), ...attempt('a', 5, false), raw({ id: 'l', kind: 'log', offsetMs: 30, isError: true, level: 'ERROR' })]), true);
    expect(steps.map((s) => [s.name, s.tone, s.entry])).toEqual([['h', 'ok', false], [FIXTURE_ENTRY, 'error', true]]);
  });

  it('запрос только из записей-логов с ошибкой: одна строка самого запроса, подписи «Запись» нет', () => {
    const steps = stepsOf(businessRecords([raw({ id: 'l', kind: 'log', isError: true, level: 'ERROR' })]), true);
    expect(steps.map((s) => [s.name, s.tone, s.entry])).toEqual([[FIXTURE_ENTRY, 'error', true]]);
  });

  it('обмен без названия: имя системы вместо пути и действия', () => {
    const [ip] = stepsOf(businessRecords([raw({ id: 'a', kind: 'send', http: http('https://192.0.2.17:8443/soap?x=1', { noResponse: true }) })]));
    expect(ip).toMatchObject({ name: 'Внешняя система', detail: null, system: null, tone: 'no-answer' });
    const body = '<e:Envelope><e:Body><getCard><t>1</t></getCard></e:Body></e:Envelope>';
    const [host] = stepsOf(businessRecords([raw({ id: 'a', kind: 'send', http: http('https://esb.pay.example/soap-proxy/FeeService', { noResponse: true }), sections: { headers: null, body, payload: null, context: null } })]));
    expect(host).toMatchObject({ name: 'esb', detail: null, system: 'esb' });
  });

  it('вызов с обменом строкой не идёт, имени действия на шаге нет: шаг назван системой', () => {
    const steps = stepsOf(
      businessRecords([
        raw({ id: 'call', kind: 'call', title: 'getCard', requestId: 'r1' }),
        raw({ id: 'a', kind: 'send', requestId: 'r1', offsetMs: 5, http: http('https://h.example/p', { pairId: 'a-r' }) }),
        raw({ id: 'a-r', kind: 'response', requestId: 'r1', offsetMs: 9, http: http('https://h.example/p', { pairId: 'a' }) }),
      ]),
    );
    expect(steps.map((s) => s.name)).toEqual(['h']);
  });

  it('запрос только из логов: одна строка самого запроса с итогом, текста записи нет', () => {
    const steps = stepsOf(businessRecords([raw({ id: 'l1', kind: 'log', title: 'db01 секрет' }), raw({ id: 'l2', kind: 'log', offsetMs: 40, title: 'db01 секрет' })]));
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ name: FIXTURE_ENTRY, tone: 'ok', durationMs: 40 });
  });

  it('ошибка только на входе: строка входа последней, названа заголовком страницы', () => {
    const steps = stepsOf(
      businessRecords([
        raw({ id: 'in', kind: 'incoming', isError: true, http: http('/v1/t') }),
        raw({ id: 'a', kind: 'send', offsetMs: 5, http: http('https://h.example/p', { pairId: 'a-r' }) }),
        raw({ id: 'a-r', kind: 'response', offsetMs: 9, http: http('https://h.example/p', { pairId: 'a' }) }),
      ]),
    );
    expect(steps.map((s) => [s.entry, s.tone])).toEqual([[false, 'ok'], [true, 'error']]);
    expect(steps[1]!.name).toBe(FIXTURE_ENTRY);
  });
});

describe('причины', () => {
  const withReasons = (d: RequestDetail, reasons: ErrorReason[]) => modelOf({ ...d, summary: { ...d.summary, reasons } });

  it('часть описана: первая текстом справочника, вторая общими словами, строка о передаче ссылки есть', () => {
    const d = fixture('known');
    const m = withReasons(d, [d.summary.reasons[0]!, { kind: 'level', text: '' }]);
    expect(m.state).toBe('known');
    expect(m.reason?.message).toBe(FIXTURE_TITLE);
    expect(m.others.map((r) => r.view.message)).toEqual(['Ошибка внутри сервиса']);
    expect(m.undescribed).toBe(true);
  });

  it('статус ошибки без причин в ответе: неописанная, ссылка нужна', () => {
    const m = withReasons(fixture('unknown'), []);
    expect(m).toMatchObject({ state: 'unknown', undescribed: true });
    expect(m.reason).toBeNull();
  });

  it('только ожидание ответа: не ошибка, строки о передаче ссылки нет', () => {
    const m = withReasons(fixture('ok'), [{ kind: 'pending', text: '' }]);
    expect(m).toMatchObject({ state: 'pending', undescribed: false, failed: null });
  });

  it('ответа нет, а записи неполные: это не ожидание, обновление страницы предел чтения не снимет', () => {
    const d = fixture('ok');
    const m = modelOf({ ...d, summary: { ...d.summary, reasons: [{ kind: 'pending', text: '' }], incomplete: true } });
    expect(m).toMatchObject({ state: 'unread', undescribed: false, failed: null });
  });

  it('нет ответа и записи ERROR об этом же: шаг один, лишней причины и слов о следующих шагах нет', () => {
    const send = raw({ id: 's', kind: 'send', offsetMs: 5, http: http('https://fraud.pay.example/x', { noResponse: true }) });
    const logs = [raw({ id: 'e', kind: 'log', offsetMs: 40, isError: true, level: 'ERROR' }), raw({ id: 'w', kind: 'log', offsetMs: 50, isError: true, level: 'WARNING' })];
    const m = modelOf(requestOf(businessRecords([send, ...logs]), 'error', [{ kind: 'no-response', text: '' }, { kind: 'level', text: '' }, { kind: 'level', text: '' }]));
    expect(m.state).toBe('no-answer');
    expect(m.steps.map((s) => [s.name, s.tone])).toEqual([['fraud', 'no-answer']]);
    expect(m.others).toEqual([]);
    expect(m).toMatchObject({ lastStep: true, passed: 0, undescribed: true });
  });

  it('запись ERROR раньше отказа обмена не становится главной причиной', () => {
    const send = raw({ id: 's', kind: 'send', offsetMs: 5, http: http('https://fraud.pay.example/x', { noResponse: true }) });
    const m = modelOf(requestOf(businessRecords([raw({ id: 'e', kind: 'log', isError: true, level: 'ERROR' }), send]), 'error', [{ kind: 'level', text: '' }, { kind: 'no-response', text: '' }]));
    expect(m.state).toBe('no-answer');
  });

  it('причины, которые читаются одинаково, одна строка: кодов, которые их различали, в ответе нет', () => {
    const name = { source: 'external', system: { key: 'cards', name: 'Процессинг карт', type: 'service' }, method: null, host: null } as ErrorReason['name'];
    const http = (target: string): ErrorReason => ({ kind: 'http', text: '', name, error: null, target } as ErrorReason);
    const m = withReasons(fixture('unknown'), [http('a'), http('b'), http('c'), { kind: 'http', text: '' }, { kind: 'http', text: '' }]);
    expect(m.reason?.message).toBe('Внешняя система ответила ошибкой');
    expect(m.others.map((r) => [r.view.message, r.count])).toEqual([['Внешняя система ответила ошибкой', 2]]);
  });
});
