// Сопоставление методов, систем и ошибок: три источника, метод проекта, система обмена по хосту, по пути и действию,
// действие SOAP и JSON-RPC, сопоставление и порядок правил ошибки, отметка «не ошибка», вид системы и вид метода.
import { describe, expect, it } from 'vitest';
import { buildView, markPending, summarize, type ParsedRecord } from '../search/index.ts';
import { annotateRecords, finalizeSummary } from './annotate.ts';
import { compileCatalog } from './resolve.ts';
import { exchange, incoming, rec, resolverFromFile, snapshotFromFile, TEST_FILE } from './test-catalog.ts';

const resolver = resolverFromFile(TEST_FILE);
const T0 = Date.UTC(2026, 10, 2, 9, 0, 0);
const OPTS = { match: 'exact' as const, readEndMs: T0 + 600_000, incomplete: false };
const U1 = '5a1d0100-0000-4000-8000-000000000001';
const U2 = '5a1d0200-0000-4000-8000-000000000002';

const final = (records: ParsedRecord[]) => finalizeSummary(summarize('cid-1', records, OPTS), records, resolver, OPTS);
const view = (records: ParsedRecord[]) => annotateRecords(markPending(buildView(records, { withOffsets: true }), OPTS), resolver);
const ex = (uri: string, body: string | null = null, method = 'POST') => resolver.exchange(method, uri, body ? rpcOf(body) : '');
import { rpcAction as rpcOf } from './rpc.ts';

describe('три источника', () => {
  it('ошибка в функции проекта относится к проекту и методу входа', () => {
    const records = [incoming(T0, 'POST', '/v1/users'), rec({ kind: 'log', timeMs: T0 + 5, level: 'ERROR', levelNum: 400, message: 'duplicated user by phone' })];
    const s = final(records);
    expect(s.entry).toMatchObject({ source: 'project', method: { name: 'Регистрация' } });
    expect(s.reasons[0]).toMatchObject({ kind: 'level', name: { source: 'project' }, error: { source: 'project', title: 'Телефон уже зарегистрирован', rule: { level: 'system' } } });
  });

  it('ошибка внешней системы — у шага обмена', () => {
    const records = [incoming(T0, 'POST', '/v1/users'), ...exchange(T0 + 10, 'http://switch.pay.example:11101/v3/cards/info', { resp: { id: 1, error: { code: 200, message: 'Card not found' } } })];
    const s = final(records);
    expect(s.reasons).toHaveLength(1);
    expect(s.reasons[0]).toMatchObject({ kind: 'business', name: { source: 'external', system: { name: 'Коммутатор' } }, error: { source: 'external', title: 'Карта не найдена', partnerCode: '176' } });
  });

  it('неузнанный обмен: источник unknown, хост', () => {
    const step = resolver.name(ex('http://unknown-system.pay.example:8443/zzz'), 'exchange');
    expect(step).toMatchObject({ source: 'unknown', system: null, method: null, host: 'unknown-system.pay.example:8443' });
  });
});

describe('метод проекта', () => {
  it('шлюз и приложение дают одно название', () => {
    const gw = rec({ kind: 'incoming', timeMs: T0, method: 'GET', uri: `/v1/users/${U1}/cards/${U2}`, gateway: true, component: 'gateway' });
    const main = incoming(T0 + 1, 'GET', `/v1/users/${U1}/cards/${U2}`);
    const v = view([gw, main]);
    expect(v.map((r) => r.catalog?.name?.method?.name)).toEqual(['Данные карты', 'Данные карты']);
    expect(final([gw, main]).entry).toMatchObject({ source: 'project', method: { name: 'Данные карты', domain: 'Карты' } });
  });

  it('буквальный сегмент сильнее подстановки; любой HTTP-метод слабее точного', () => {
    expect(resolver.entry('GET', `/v1/users/${U1}/cards/unmask`).method?.name).toBe('Раскрытие карты');
    expect(resolver.entry('POST', '/internal/callbacks/crm').method?.name).toBe('Колбэк CRM');
    expect(resolver.entry('PUT', '/internal/callbacks/crm').method?.name).toBe('Колбэк CRM, любой метод');
  });

  it('метод не описан: источник unknown; пустой сегмент не совпадает', () => {
    expect(resolver.name(resolver.entry('POST', '/v1/cards/lookup'), 'entry')).toMatchObject({ source: 'unknown', method: null, system: { key: 'pay' } });
    expect(resolver.entry('GET', '/v1/users//cards/x').method).toBeNull();
  });

  it('фоновый запрос: метода проекта нет', () => {
    expect(final(exchange(T0, 'http://switch.pay.example:11101/v3/cards/info', { resp: { result: {} } })).entry).toBeNull();
  });
});

describe('система обмена', () => {
  it('по IP с портом и по домену', () => {
    expect(ex('http://switch.pay.example:11101/v3/cards/info').method?.name).toBe('Данные карты в коммутаторе');
    expect(ex('https://gw.merchant.acquirer.example/api/payments/abc', null, 'GET').system?.key).toBe('acquirer');
  });

  it('тот же хост на другом порту — по пути', () => {
    const s = ex('http://switch.pay.example:11102/v3/cards/info');
    expect(s).toMatchObject({ byPath: true, system: { key: 'switch' } });
  });

  it('процессинг без хоста — по пути', () => {
    expect(ex('http://192.0.2.11/soap/issuing').system?.name).toBe('Процессинг карт');
  });

  it('два шаблона на корне: действие JSON-RPC выбирает систему', () => {
    const s = ex('http://192.0.2.99/', '{"jsonrpc":"2.0","method":"risk.check","id":1}');
    expect(s.system?.name).toBe('Проверка мошенничества');
    expect(s.method?.name).toBe('Оценка риска');
  });

  it('неоднозначный путь — система неизвестна', () => {
    expect(ex('http://192.0.2.99/api/payments').system).toBeNull();
  });
});

describe('действие SOAP', () => {
  const soap = (a: string) => `<soapenv:Envelope><soapenv:Body><urn:${a}><x/></urn:${a}></soapenv:Body></soapenv:Envelope>`;
  const uri = 'http://192.0.2.11/soap/issuing';

  it('метод с действием выигрывает', () => {
    const v = view(exchange(T0, uri, { req: soap('getCard'), resp: '<S:Envelope><S:Body><getCardResponse/></S:Body></S:Envelope>' }));
    expect(v.map((r) => r.catalog?.name?.method?.name)).toEqual(['Номер карты по токену', 'Номер карты по токену']);
  });

  it('тело обрезано → метод этого пути без действия', () => {
    const v = view(exchange(T0, uri, { req: '<soapenv:Envelope><soapenv:Body><urn:getCa', status: null }));
    expect(v[0]!.catalog?.name?.method?.name).toBe('Процессинг SOAP');
  });

  it('только ответ: действие по ответу без Response', () => {
    const r = rec({ kind: 'response', timeMs: T0, method: 'POST', uri, status: 200, body: '<S:Envelope><S:Body><ns2:getCardholderResponse/></S:Body></S:Envelope>' });
    expect(view([r])[0]!.catalog?.name?.method?.name).toBe('Держатель карты');
  });
});

describe('сопоставление ошибки', () => {
  const processor = (code: number, text: string) =>
    final(exchange(T0, 'http://192.0.2.11/soap/issuing', { resp: `<S:Envelope><S:Body><r><response_code>${code}</response_code><error_description>${text} text</error_description></r></S:Body></S:Envelope>` }));

  it('код и текст процессинга; код совпал, текст нет — следующее правило', () => {
    expect(processor(8, 'PRC-ERR-0027').reasons[0]!.error?.title).toBe('Карта не найдена в процессинге');
    expect(processor(8, 'PRC-ERR-0031').reasons[0]!.error?.title).toBe('Общая ошибка процессинга');
  });

  it('ведущие нули: «не ошибка» проверки мошенничества 00 при коде 0', () => {
    const s = final([incoming(T0, 'POST', '/v1/users'), ...exchange(T0 + 1, 'http://fraud.local/', { req: { jsonrpc: '2.0', method: 'risk.check', id: 1 }, resp: { jsonrpc: '2.0', error: { code: 0, message: 'Success' } } })]);
    expect(s.status).toBe('success');
    expect(s.reasons).toEqual([]);
  });

  it('только HTTP-статус: общее правило 504 у платёжного ядра', () => {
    const s = final(exchange(T0, 'http://ledger.local/v1/transfers/p2p', { status: 504, resp: '' }));
    expect(s.reasons[0]).toMatchObject({ kind: 'http', name: { system: { name: 'Платёжное ядро' } }, error: { title: 'Система не ответила вовремя', rule: { level: 'general' } } });
  });

  it('правило метода сильнее правила системы', () => {
    const body = { error: { code: 200, message: 'Card not found' } };
    expect(final(exchange(T0, 'http://switch.pay.example:11101/v3/cards/token', { resp: body })).reasons[0]!.error?.title).toBe('Карта не найдена или закрыта');
    expect(final(exchange(T0, 'http://switch.pay.example:11101/v3/cards/info', { resp: body })).reasons[0]!.error?.title).toBe('Карта не найдена');
  });

  it('ничего не найдено: источник unknown, код и текст в raw', () => {
    const s = final(exchange(T0, 'http://switch.pay.example:11101/v3/cards/info', { resp: { error: { code: 999, message: 'Odd' } } }));
    expect(s.reasons[0]!.error).toMatchObject({ source: 'unknown', rule: null, raw: { code: '999', text: 'Odd' } });
  });

  it('неузнанная система: только общие правила', () => {
    const r = resolver.matchError({ systemId: null, methodId: null }, { status: 504, code: null, text: null });
    expect(r?.level).toBe('general');
    expect(resolver.matchError({ systemId: null, methodId: null }, { status: null, code: '200', text: null })).toBeNull();
  });

  it('несколько правил одного уровня: больше условий — раньше', () => {
    const processor = resolver.systemByKey('processor')!;
    expect(resolver.matchError({ systemId: processor.id, methodId: null }, { status: null, code: '8', text: 'PRC-ERR-0027' })?.rule.title).toBe('Карта не найдена в процессинге');
  });
});

describe('«не ошибка»', () => {
  it('вместе с настоящей ошибкой: запрос с одной причиной', () => {
    const records = [
      incoming(T0, 'POST', '/v1/users'),
      ...exchange(T0 + 1, 'http://fraud.local/', { req: { jsonrpc: '2.0', method: 'risk.check', id: 1 }, resp: { jsonrpc: '2.0', error: { code: '00', message: 'ok' } } }),
      ...exchange(T0 + 100, 'http://switch.pay.example:11101/v3/cards/info', { resp: { error: { code: 200, message: 'Card not found' } } }),
    ];
    const s = final(records);
    expect(s.status).toBe('error');
    expect(s.reasons).toHaveLength(1);
    expect(s.reasons[0]!.name?.system?.key).toBe('switch');
  });

  it('запись WARNING с правилом проекта «не ошибка»', () => {
    const records = [incoming(T0, 'POST', '/v1/users'), rec({ kind: 'log', timeMs: T0 + 5, level: 'WARNING', levelNum: 300, message: 'Cache warmup slow' })];
    expect(summarize('cid-1', records, OPTS).status).toBe('error');
    expect(final(records).status).toBe('success');
  });

  it('шаг с «не ошибкой» в подробностях: severity ok', () => {
    const v = view(exchange(T0, 'http://fraud.local/', { req: { jsonrpc: '2.0', method: 'risk.check', id: 1 }, resp: { jsonrpc: '2.0', error: { code: '00', message: 'ok' } } }));
    expect(v[1]!.catalog?.error).toMatchObject({ severity: 'ok', title: 'Успешно', rule: { kind: 'error' } });
  });

  it('обрезка до 5 после справочника: шесть причин, одна «не ошибка»', () => {
    const records = [incoming(T0, 'POST', '/v1/users')];
    for (let i = 0; i < 5; i++) records.push(...exchange(T0 + 100 * (i + 1), 'http://switch.pay.example:11101/v3/cards/info', { resp: { error: { code: 999 + i, message: 'x' } } }));
    records.push(...exchange(T0 + 50, 'http://fraud.local/', { req: { jsonrpc: '2.0', method: 'risk.check', id: 1 }, resp: { jsonrpc: '2.0', error: { code: '00', message: 'ok' } } }));
    const base = summarize('cid-1', records, OPTS);
    expect(base.reasons[0]!.text).toContain('error 00');
    const s = final(records);
    expect(s.reasons).toHaveLength(5);
    expect(s.reasons.every((r) => r.name?.system?.key === 'switch')).toBe(true);
  });
});

describe('вид системы', () => {
  it('шина по хосту, база без хоста — единственная', () => {
    expect(resolver.exchange(null, 'tcp://kafka.pay.example:9092', '', 'queue').system?.name).toBe('Kafka Demo Pay');
    expect(resolver.exchange(null, null, '', 'db').system?.name).toBe('PostgreSQL Demo Pay');
  });

  it('две базы без хоста — неизвестно', () => {
    const file = structuredClone(TEST_FILE) as typeof TEST_FILE;
    file.systems.push({ key: 'pg2', type: 'database', name: 'PostgreSQL 2' } as (typeof TEST_FILE.systems)[number]);
    expect(compileCatalog(snapshotFromFile(file)).exchange(null, null, '', 'db').system).toBeNull();
  });

  it('ошибка базы по подстроке', () => {
    const pg = resolver.systemByKey('pg')!;
    expect(resolver.matchError({ systemId: pg.id, methodId: null }, { status: null, code: null, text: 'ERROR: deadlock detected' })?.rule.title).toBe('Взаимная блокировка в базе');
  });
});

describe('вид метода', () => {
  it('статус операции у входа и колбэк', () => {
    const v = view([incoming(T0, 'GET', `/v1/users/${U1}/transfers/${U2}`)]);
    expect(v[0]!.catalog?.name?.method).toMatchObject({ kind: 'status', opType: { key: 'transfer', name: 'Перевод' } });
    const cb = view([incoming(T0, 'POST', '/internal/callbacks/payout', { ext_transfer_id: U2, state: 'complete' })]);
    expect(cb[0]!.catalog?.name?.method).toMatchObject({ name: 'Колбэк сети выплат', kind: 'callback' });
  });

  it('асинхронная отправка и статус у внешней системы одним типом', () => {
    const v = view([...exchange(T0, 'http://payout.local/v3/transfer', { req: {} }), ...exchange(T0 + 100, 'http://payout.local/v1/transfer_info', { req: {} })]);
    expect(v.filter((r) => r.kind === 'send').map((r) => [r.catalog?.name?.method?.kind, r.catalog?.name?.method?.opType?.key])).toEqual([
      ['start', 'payout'],
      ['status', 'payout'],
    ]);
  });

  it('без справочника разметки нет', () => {
    const records = [incoming(T0, 'GET', `/v1/users/${U1}/transfers/${U2}`)];
    const plain = markPending(buildView(records, { withOffsets: true }), OPTS);
    expect(annotateRecords(plain, null)).toEqual(plain);
    expect('catalog' in annotateRecords(plain, null)[0]!).toBe(false);
  });
});

describe('ошибка обращения к базе', () => {
  const dbLog = (message: string) => rec({ kind: 'log', timeMs: T0 + 5, level: 'ERROR', levelNum: 400, message, flow: { as: 'db', title: 'db query', host: null, durationMs: null } });

  it('правило системы базы: текст и источник «внешняя система», в сводке и в записи', () => {
    const records = [incoming(T0, 'POST', '/v1/users'), dbLog('ERROR: deadlock detected')];
    const s = final(records);
    expect(s.status).toBe('error');
    expect(s.reasons[0]).toMatchObject({ kind: 'level', error: { title: 'Взаимная блокировка в базе', source: 'external' }, name: { system: { name: 'PostgreSQL Demo Pay' } } });
    const v = view(records);
    expect(v[1]!.catalog?.error).toMatchObject({ title: 'Взаимная блокировка в базе', source: 'external' });
  });

  it('без правила — ошибка остаётся, подпись базы', () => {
    const s = final([incoming(T0, 'POST', '/v1/users'), dbLog('ERROR: strange db failure')]);
    expect(s.status).toBe('error');
    expect(s.reasons[0]).toMatchObject({ kind: 'level', name: { system: { name: 'PostgreSQL Demo Pay' } } });
  });
});

describe('ответ на вход', () => {
  const file = structuredClone(TEST_FILE) as unknown as { systems: { key: string; methods?: Record<string, unknown>[]; outcomes?: unknown[] }[]; idTypes: unknown[] };
  const project = file.systems.find((s) => s.key === 'pay')!;
  project.methods!.push(
    { http: 'POST', path: '/v1/orders', name: 'Заказ', op: 'payment', kind: 'status', status: { in: 'response', path: 'state' } },
    { http: 'POST', path: '/v1/widgets', name: 'Виджет' },
  );
  project.outcomes = [{ when: { http: 409 }, outcome: 'ignore' }];
  const r2 = resolverFromFile(file as unknown as typeof TEST_FILE);
  const answer = (uri: string, status: number, body: unknown) => rec({ kind: 'response', timeMs: T0 + 5, method: 'POST', uri, status, body: JSON.stringify(body) });

  it('правило итога системы-автора действует, источник — проект', () => {
    const records = [incoming(T0, 'POST', '/v1/widgets'), answer('/v1/widgets', 409, { x: 1 })];
    const s = finalizeSummary(summarize('cid-1', records, OPTS), records, r2, OPTS);
    expect(s.status).toBe('success');
    const v = annotateRecords(markPending(buildView(records, { withOffsets: true }), OPTS), r2);
    expect(v[1]!.catalog?.outcome).toMatchObject({ kind: 'ignore' });
    expect(v[1]!.catalog?.name).toMatchObject({ source: 'project', method: { name: 'Виджет' } });
  });

  it('статус метода с in: response читается', () => {
    const records = [incoming(T0, 'POST', '/v1/orders'), answer('/v1/orders', 200, { state: 'confirmed' })];
    const v = annotateRecords(markPending(buildView(records, { withOffsets: true }), OPTS), r2);
    expect(v[1]!.catalog?.status).toMatchObject({ value: 'confirmed' });
  });

  it('ответ с другим путём или своей отправкой — обмен', () => {
    const records = [incoming(T0, 'POST', '/v1/widgets'), answer('/v1/other', 500, { x: 1 })];
    const s = finalizeSummary(summarize('cid-1', records, OPTS), records, r2, OPTS);
    expect(s.status).toBe('error');
    expect(s.reasons[0]!.kind).toBe('http');
    const v = annotateRecords(markPending(buildView(records, { withOffsets: true }), OPTS), r2);
    expect(v[1]!.catalog?.name?.method?.name).not.toBe('Виджет');
  });
});
