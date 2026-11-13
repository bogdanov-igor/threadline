import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { OperationFlow, OperationView } from '../flow/operation.ts';
import { buildFlowGraph } from '../flow/graph.ts';
import { flowFacts } from '../flow/facts.ts';
import { buildOperation, nocidSegments } from '../flow/operation.ts';
import { annotateRecords, finalizeSummary } from '../catalog/annotate.ts';
import { strictPathTemplate } from '../catalog/path.ts';
import { exchange, incoming, resolverFromFile } from '../catalog/test-catalog.ts';
import { plainSystem } from '../catalog/host.ts';
import type { CatalogError, CatalogName, ErrorReason, RecordCatalog, RequestDetail, RequestSummary, SearchState, ViewRecord } from '../search/api.ts';
import { buildView, markPending, summarize } from '../search/index.ts';
import { buildTrace } from '../search/trace.ts';
import { businessConnection, businessCatalogState, businessDetail, businessOperation, businessProjects, businessRecords, businessState, businessSummary, businessView } from './business.ts';
import { DEFAULT_VIEW, type ViewSettings } from './index.ts';

const NAME: CatalogName = {
  source: 'external',
  system: { key: 'switch', name: 'Коммутатор', type: 'service' },
  method: { id: 7, name: 'Карта по токену', domain: 'Карты', kind: 'call', opType: null },
  host: '192.0.2.17:11101',
};

const rec = (over: Partial<ViewRecord> & Pick<ViewRecord, 'id' | 'kind'>): ViewRecord => ({
  tsNs: '1000',
  timeMs: 1000,
  offsetMs: 0,
  title: 'сырой заголовок db01.pay.example',
  message: 'сырое сообщение db01.pay.example:5432',
  level: 'INFO',
  isError: false,
  component: 'worker',
  gateway: false,
  correlationId: 'cid-1',
  requestId: 'req-long-value',
  http: null,
  sections: { headers: { Authorization: '***' }, body: '{"secret":"тело"}', payload: { a: 1 }, context: { host: 'db01' } },
  raw: 'сырая строка',
  match: 'exact',
  ...over,
});

const http = (uri: string, over: Partial<NonNullable<ViewRecord['http']>> = {}): NonNullable<ViewRecord['http']> => ({ method: 'POST', uri, status: 502, durationMs: 12, pairId: null, noResponse: false, pending: false, ...over });

const errorOf = (over: Partial<CatalogError> = {}): CatalogError => ({
  source: 'external',
  rule: { id: 9, level: 'system', kind: 'error' },
  title: 'Карта не найдена',
  action: 'Проверить токен',
  severity: 'error',
  partnerCode: 'PARTNER-8',
  raw: { http: 502, code: 'PRC-ERR-0027', text: 'Card not found' },
  ...over,
});

describe('записи запроса', () => {
  it('новое поле записи не уходит: список полей явный', () => {
    const r = rec({ id: 'a', kind: 'send', http: http('https://192.0.2.17:11101/x') }) as ViewRecord & { fresh: string };
    r.fresh = 'новое значение';
    (r.http as unknown as { extra: string }).extra = 'значение http';
    (r.sections as unknown as { extra: string }).extra = 'значение блока';
    r.catalog = { name: { ...NAME, extra: 'значение имени' } as CatalogName, error: { ...errorOf(), extra: 'значение ошибки' } as CatalogError, outcome: null, ids: [], status: null, extra: 'значение разметки' } as RecordCatalog;
    const text = JSON.stringify(businessRecords([r]));
    expect(text).not.toContain('fresh');
    expect(text).not.toContain('значение');
  });

  it('в файле нет копирования объектов целиком', () => {
    const source = readFileSync(new URL('./business.ts', import.meta.url), 'utf8');
    const copies = source.split('\n').filter((l) => /\{\s*\.\.\.(?!\(|OFF\b)[a-z]/.test(l.replace(/\/\/.*$/, '')));
    expect(copies).toEqual([]);
  });

  it('обмен: без тела, заголовков, метода, статуса, хоста и значений', () => {
    const uri = 'https://svc:пароль@processor.pay.example:8443/v1/users/5a1d0100-0000-4000-8000-000000000001/cards/Ivanov?lang=ru';
    const [out] = businessRecords([rec({ id: 'a', kind: 'send', http: http(uri, { pairId: 'b' }), catalog: { name: { ...NAME, system: null, method: null }, error: null, outcome: null, ids: [], status: null } })]);
    expect(out).toMatchObject({ title: '', message: '', component: null, raw: '', match: null, sections: { headers: null, body: null, payload: null, context: null }, http: { method: null, status: null, pairId: 'b', durationMs: 12 } });
    expect(out!.http!.uri).toBe('processor');
    expect(JSON.stringify(out)).not.toMatch(/пароль|pay\.example|8443|lang|Ivanov|сыр/);
  });

  it('система из справочника даёт ключ, IP без справочника отбрасывается', () => {
    const named = businessRecords([rec({ id: 'a', kind: 'send', http: http('http://192.0.2.17:8443/x/y'), catalog: { name: NAME, error: null, outcome: null, ids: [], status: null } })]);
    expect(named[0]!.http!.uri).toBe('switch');
    expect(named[0]!.title).toBe('Карта по токену');
    expect(named[0]!.catalog!.name).toEqual({ source: 'external', system: NAME.system, method: NAME.method, host: null });
    for (const uri of ['http://192.0.2.17:8443/x/y', 'http://[fd00::17]:8443/x/y']) {
      expect(businessRecords([rec({ id: 'a', kind: 'send', http: http(uri) })])[0]!.http!.uri).toBeNull();
    }
  });

  it('действие SOAP и имя вызова не уходят: шаг без справочника подписан системой', () => {
    const soap = (name: string) => `<e:Envelope><e:Body><${name}><token>секрет</token></${name}></e:Body></e:Envelope>`;
    const send = rec({ id: 'a', kind: 'send', http: http('https://processor.pay.example/soap-proxy/FeeService'), sections: { headers: null, body: soap('getCard'), payload: null, context: null } });
    const resp = rec({ id: 'b', kind: 'response', http: http('https://processor.pay.example/soap-proxy/FeeService'), sections: { headers: null, body: soap('getCardResponse'), payload: null, context: null } });
    const call = rec({ id: 'c', kind: 'call', title: 'getCard' });
    const text = JSON.stringify(businessRecords([call, send, resp]));
    expect(text).not.toMatch(/getCard|soap-proxy|FeeService|секрет|rpc/);
    expect(businessRecords([send])[0]!.http!.uri).toBe('processor');
    expect(businessRecords([call])[0]!.title).toBe('');
  });

  it('вход: шаблон пути остаётся', () => {
    expect(businessRecords([rec({ id: 'a', kind: 'incoming', http: http('https://api.pay.example/v1/users/5a1d0100-0000-4000-8000-000000000001/cards') })])[0]!.http!.uri).toBe('/v1/users/{user}/cards');
  });

  it('вызов с названием из справочника: название; запись без текста: общее слово «Запись»', () => {
    const named = rec({ id: 'c', kind: 'call', title: 'getCard', catalog: { name: NAME, error: null, outcome: null, ids: [], status: null } });
    expect(businessRecords([named])[0]!.title).toBe('Карта по токену');
    const [log] = businessRecords([rec({ id: 'l', kind: 'log', title: 'текст db01', isError: true })]);
    expect(log).toMatchObject({ title: '', titleCode: 'record' });
    expect(businessRecords([rec({ id: 's', kind: 'send', http: http('/x') })])[0]).not.toHaveProperty('titleCode');
  });


  it('уровень только из постоянного списка', () => {
    expect(businessRecords([rec({ id: 'a', kind: 'log', isError: true, level: 'error' })])[0]!.level).toBe('ERROR');
    expect(businessRecords([rec({ id: 'a', kind: 'log', isError: true, level: 'Иванов' })])[0]!.level).toBeNull();
  });

  it('request_id заменён псевдонимами в пределах ответа, связь сохранена', () => {
    const out = businessRecords([rec({ id: 'a', kind: 'call', requestId: 'one' }), rec({ id: 'b', kind: 'send', requestId: 'one', http: http('/x') }), rec({ id: 'c', kind: 'send', requestId: 'two', http: http('/y') }), rec({ id: 'd', kind: 'send', requestId: null, http: http('/z') })]);
    expect(out.map((r) => r.requestId)).toEqual(['rq1', 'rq1', 'rq2', null]);
  });

  it('записи-логи без ошибки не уходят, ось времени та же', () => {
    const view = [rec({ id: 'a', kind: 'incoming', http: http('/v1/x'), offsetMs: 0 }), rec({ id: 'l1', kind: 'log', offsetMs: 10 }), rec({ id: 'b', kind: 'send', http: http('/y'), offsetMs: 20 }), rec({ id: 'l2', kind: 'log', offsetMs: 900 })];
    const out = businessRecords(view);
    expect(out.map((r) => r.id)).toEqual(['a', 'b']);
    expect(buildTrace(out).totalMs).toBe(buildTrace(view).totalMs);
  });

  it('запись-лог с ошибкой идёт без текста, подсказка шага без хоста и подписи', () => {
    const out = businessRecords([rec({ id: 'e', kind: 'log', isError: true, level: 'ERROR' }), rec({ id: 'w', kind: 'log', flow: { as: 'db', durationMs: 5, host: 'db01.pay.example', title: 'select' } }), rec({ id: 'x', kind: 'log' })]);
    expect(out.map((r) => r.id)).toEqual(['e', 'w']);
    expect(out[1]!.flow).toEqual({ as: 'db', durationMs: 5, host: null, title: null });
    expect(JSON.stringify(out)).not.toMatch(/db01|сыр|select/);
  });

  it('поток только из логов: идут все, с пустым заголовком', () => {
    const out = businessRecords([rec({ id: 'a', kind: 'log', offsetMs: 0 }), rec({ id: 'b', kind: 'text', offsetMs: 5 })]);
    expect(out.map((r) => [r.id, r.title])).toEqual([['a', ''], ['b', '']]);
    expect(buildTrace(out).steps).toHaveLength(2);
  });

  it('нераспознанная запись и заглушка маскирования: вид и время, строки нет', () => {
    const out = businessRecords([rec({ id: 'r', kind: 'raw', title: 'запись не разобрана', titleCode: 'raw' }), rec({ id: 'm', kind: 'raw', title: 'запись скрыта: ошибка маскирования', titleCode: 'mask-failed' }), rec({ id: 's', kind: 'send', http: http('/x') })]);
    expect(out.map((r) => [r.id, r.kind, r.title, r.titleCode, r.raw])).toEqual([['r', 'raw', '', 'raw', ''], ['m', 'raw', '', 'mask-failed', ''], ['s', 'send', '', undefined, '']]);
  });

  it('разметка: ошибка без кодов, id только операции, статус только из словаря, текст правила только без подстановки', () => {
    const catalog: RecordCatalog = {
      name: NAME,
      error: errorOf(),
      outcome: { kind: 'error', rule: { id: 3, level: 'method' }, text: 'Платёж 12345 отклонён', action: 'Повторить' },
      ids: [
        { type: 'user', name: 'Пользователь', kind: 'entity', value: 'u-1', at: 'path' },
        { type: 'transfer', name: 'Перевод', kind: 'operation', value: 't-1', at: 'response' },
      ],
      status: { type: 'transfer', value: 'weird', raw: 'WEIRD', name: null, outcome: null, order: null },
    };
    const [out] = businessRecords([rec({ id: 'a', kind: 'response', http: http('/x'), catalog })]);
    expect(out!.catalog).toMatchObject({ error: { title: 'Карта не найдена', action: 'Проверить токен', rule: null, partnerCode: null, raw: { http: null, code: null, text: null } }, outcome: { kind: 'error', text: null, action: 'Повторить' }, status: null });
    expect(out!.catalog!.ids.map((i) => i.value)).toEqual(['t-1']);
    const fixed = businessRecords([rec({ id: 'a', kind: 'response', http: http('/x'), catalog: { ...catalog, outcome: { kind: 'error', rule: { id: 3, level: 'method' }, text: 'Платёж отклонён', action: null, fixed: true }, status: { type: 'transfer', value: 'done', raw: 'DONE', name: 'Выполнен', outcome: 'success', order: 1 } } })]);
    expect(fixed[0]!.catalog!.outcome!.text).toBe('Платёж отклонён');
    expect(fixed[0]!.catalog!.status).toEqual({ type: 'transfer', value: 'done', raw: '', name: 'Выполнен', outcome: 'success', order: 1 });
    expect(JSON.stringify(out)).not.toMatch(/12345|PRC-ERR|Card not found|PARTNER|u-1|WEIRD/);
  });
});

describe('граф и шкала на сокращённых записях', () => {
  const send = (id: string, pair: string, offsetMs: number, uri: string, body: string | null = null) => rec({ id, kind: 'send', offsetMs, timeMs: 1000 + offsetMs, requestId: 'r', http: http(uri, { pairId: pair, status: null }), sections: { headers: null, body, payload: null, context: null } });
  const resp = (id: string, pair: string, offsetMs: number, uri: string, isError = false) => rec({ id, kind: 'response', offsetMs, timeMs: 1000 + offsetMs, isError, requestId: 'r', http: http(uri, { pairId: pair, status: isError ? 502 : 200 }) });
  const opts = { related: [] };

  it('узлы без адреса, статуса и кода; система по имени и без домена', () => {
    const uri = 'https://processor.pay.example:8443/v3/cards/5a1d0100-0000-4000-8000-000000000001';
    const view = [rec({ id: 'in', kind: 'incoming', http: http('/v1/users/5a1d0100-0000-4000-8000-000000000002') }), send('s', 'p', 10, uri), resp('p', 's', 20, uri, true)];
    const out = businessRecords(view);
    const trace = buildTrace(out);
    const graph = buildFlowGraph(trace, out, opts);
    const text = JSON.stringify(graph);
    expect(text).not.toMatch(/pay\.example|8443|5a1d0100|POST|502/);
    const node = Object.values(graph.nodes).find((n) => n.id === 's');
    expect(node).toMatchObject({ name: 'processor', path: null, tech: '', plain: null, outcome: { tone: 'error', reason: null, http: null } });
  });

  it('система по IP без справочника: хоста нет и в графе', () => {
    const uri = 'http://192.0.2.17:8443/issuingws';
    const out = businessRecords([send('s', 'p', 0, uri), resp('p', 's', 5, uri)]);
    expect(JSON.stringify(buildFlowGraph(buildTrace(out), out, opts))).not.toContain('192.0.2.17');
    expect(buildTrace(out).chain).toEqual([]);
  });

  it('повторы и параллельные ветки обменов с названием те же, что у других ролей', () => {
    const uri = 'https://192.0.2.17:11101/pay/charge';
    const named = (r: ViewRecord): ViewRecord => ({ ...r, catalog: { name: NAME, error: null, outcome: null, ids: [], status: null } });
    const view = [send('a', 'a2', 0, uri), resp('a2', 'a', 5, uri, true), send('b', 'b2', 10, uri), resp('b2', 'b', 15, uri, true), send('c', 'c2', 20, uri), resp('c2', 'c', 25, uri)].map(named);
    const shape = (rs: ViewRecord[]) => {
      const nodes = Object.values(buildFlowGraph(buildTrace(rs), rs, opts).nodes);
      return nodes.map((n) => [n.kind, n.group ?? null, n.lane, n.stepIds.length]).sort();
    };
    expect(shape(businessRecords(view))).toEqual(shape(view));
  });

  it('обмены без названия с одной системой не сливаются: повтор от другого вызова не отличить', () => {
    const view = [send('a', 'a2', 0, 'https://h.pay.example/one'), resp('a2', 'a', 5, 'https://h.pay.example/one', true), send('b', 'b2', 10, 'https://h.pay.example/two'), resp('b2', 'b', 15, 'https://h.pay.example/two')];
    const out = businessRecords(view);
    const nodes = Object.values(buildFlowGraph(buildTrace(out), out, opts).nodes).filter((n) => n.kind === 'exchange');
    expect(nodes.map((n) => [n.name, n.group ?? null, n.outcome.tone])).toEqual([['h', null, 'error'], ['h', null, 'success']]);
  });

  it('вызов и обмен связывает request_id: имени действия в ответе нет, узел один, как у других ролей', () => {
    const uri = 'https://h.pay.example/ws';
    const body = '<e:Envelope><e:Body><getCard><t>секрет</t></getCard></e:Body></e:Envelope>';
    const view = [rec({ id: 'c', kind: 'call', title: 'getCard', offsetMs: 0, requestId: 'r' }), send('s', 'p', 1, uri, body), resp('p', 's', 2, uri)];
    const shape = (rs: ViewRecord[]) => Object.values(buildFlowGraph(buildTrace(rs), rs, opts).nodes).map((n) => [n.id, n.kind]).sort();
    expect(shape(businessRecords(view))).toEqual(shape(view));
    const out = businessRecords(view);
    expect(Object.values(buildFlowGraph(buildTrace(out), out, opts).nodes).find((n) => n.id === 'c')).toMatchObject({ kind: 'fn', name: 'h', plain: null, tech: '' });
  });
});

describe('строгий шаблон пути', () => {
  it.each([
    ['/v1/users/5a1d0100-0000-4000-8000-000000000001/cards/5a1d0200-0000-4000-8000-000000000002?lang=ru', '/v1/users/{user}/cards/{card}'],
    ['/api/getCardDetails', '/api/{value}'],
    ['/v1/clients/Ivanov', '/v1/clients/{value}'],
    ['/v1/клиенты/Иванов', '/v1/{value}/{value}'],
    ['/Ivanov/5a1d0100-0000-4000-8000-000000000001', '/{value}/{value}'],
    ['/users/5a1d0100-0000-4000-8000-000000000001/5a1d0100-0000-4000-8000-000000000002', '/users/{user}/{id}'],
    ['/v1/x/12345', '/v1/x/{value}'],
    ['/', '/'],
  ])('%s → %s', (path, template) => {
    expect(strictPathTemplate(path)).toBe(template);
  });
});

describe('имя системы без адреса', () => {
  it.each([
    ['https://processor.pay.example:8443/x', 'processor'],
    ['http://switch-mw:11101/x', 'switch-mw'],
    ['https://gw.merchant.acquirer.example/x', 'acquirer'],
    ['https://acquirer.example/x', 'acquirer'],
    ['http://192.0.2.17:8443/x', null],
    ['http://[fd00::17]:8443/x', null],
    ['/x', null],
    [null, null],
  ])('%s → %s', (uri, name) => {
    expect(plainSystem(uri)).toBe(name);
  });
});

const reason = (over: Partial<ErrorReason> & Pick<ErrorReason, 'kind'>): ErrorReason => ({ text: 'response_code 8: PRC-ERR-0027 Card not found · POST 192.0.2.17:8443/soap/issuing', ...over });
const summary = (reasons: ErrorReason[], over: Partial<RequestSummary> = {}): RequestSummary => ({
  correlationId: 'cid-1',
  firstMs: 1,
  lastMs: 2,
  durationMs: 1,
  incoming: { method: 'GET', path: '/v1/users/5a1d0100-0000-4000-8000-000000000001/cards/5a1d0200-0000-4000-8000-000000000002?lang=ru' },
  component: 'api',
  recordCount: 9,
  status: 'error',
  kind: 'incoming',
  reasons,
  match: 'exact',
  incomplete: false,
  ...over,
});

describe('сводка и причина ошибки', () => {
  it('без компонента, метода, строки запроса, значений и числа записей', () => {
    const out = businessSummary(summary([], { entry: NAME }));
    // Название из справочника заменяет адрес: значений пути у такого запроса нет совсем. Без названия остаётся шаблон.
    expect(out).toMatchObject({ component: null, recordCount: 0, incoming: { method: '', path: '' }, entry: { host: null, method: { name: 'Карта по токену' } } });
    expect(businessSummary(summary([])).incoming).toEqual({ method: '', path: '/v1/users/{user}/cards/{card}' });
    expect(JSON.stringify(out)).not.toMatch(/GET|lang|5a1d|pay\.example|"api"/);
    expect(businessSummary(summary([], { incoming: null })).incoming).toBeNull();
    expect('entry' in businessSummary(summary([]))).toBe(false);
  });

  it('новое поле сводки и причины не уходит', () => {
    const s = summary([{ ...reason({ kind: 'http' }), extra: 'значение' } as ErrorReason]) as RequestSummary & { extra: string };
    s.extra = 'значение';
    expect(JSON.stringify(businessSummary(s))).not.toContain('значение');
  });

  it('причина есть в справочнике: текст справочника и «что делать», кодов нет', () => {
    const [r] = businessSummary(summary([reason({ kind: 'http', name: NAME, error: errorOf() })])).reasons;
    expect(r).toMatchObject({ kind: 'http', text: 'Карта не найдена', error: { title: 'Карта не найдена', action: 'Проверить токен', partnerCode: null, rule: null }, name: { host: null } });
    expect(JSON.stringify(r)).not.toMatch(/PRC-ERR|PARTNER|Card not found|10\.10\.5\.17/);
  });

  it('причины нет в справочнике: пустой текст, общие слова выбирает интерфейс', () => {
    const r = businessSummary(summary([reason({ kind: 'http', name: { ...NAME, method: null }, error: errorOf({ source: 'unknown', rule: null, title: null, action: null, partnerCode: null }) })])).reasons[0]!;
    expect(r.text).toBe('');
    expect(r.error!.title).toBeNull();
    expect(JSON.stringify(r)).not.toMatch(/PRC-ERR|Card not found|10\.10\.5\.17|502/);
  });

  it('справочник выключен: поля name и error не появляются, текста нет', () => {
    const r = businessSummary(summary([reason({ kind: 'level', text: 'connect to db01.pay.example:5432 failed' })])).reasons[0]!;
    expect(r).toEqual({ kind: 'level', text: '' });
  });

  it('правило итога: текст с подстановкой не идёт, без подстановки идёт, заголовок ошибки вместо него', () => {
    const outcome = (over: Partial<CatalogError>) => reason({ kind: 'outcome', text: 'Платёж 12345 отклонён · POST /pay', error: errorOf({ rule: { id: 1, level: 'method', kind: 'outcome' }, ...over }) });
    const read = (r: ErrorReason) => businessSummary(summary([r])).reasons[0]!;
    expect(read(outcome({ title: 'Платёж 12345 отклонён', safeTitle: null })).text).toBe('');
    expect(read(outcome({ title: 'Платёж 12345 отклонён', safeTitle: 'Карта не найдена' })).text).toBe('Карта не найдена');
    expect(read(outcome({ title: 'Платёж отклонён', safeTitle: 'Платёж отклонён' })).text).toBe('Платёж отклонён');
    expect(read(outcome({ title: 'HTTP 502' })).text).toBe('');
  });

  it('виды причин без правила: ответа нет, ответ не пришёл', () => {
    const list = businessSummary(summary([reason({ kind: 'no-response', text: 'ответ не найден · POST https://h/x', name: NAME, error: null }), reason({ kind: 'pending', text: 'ответ ещё не пришёл · POST https://h/x', name: NAME, error: null })])).reasons;
    expect(list.map((r) => [r.kind, r.text, r.error])).toEqual([['no-response', '', null], ['pending', '', null]]);
  });
});

describe('причина ошибки по настоящей разметке справочника', () => {
  const T0 = Date.UTC(2026, 10, 2, 9, 0, 0);
  const OPTS = { match: 'exact' as const, readEndMs: T0 + 600_000, incomplete: false };
  const CID = 'c0ffee00-0000-4000-8000-000000000001';
  const resolver = resolverFromFile({
    version: 1,
    project: 'pay',
    systems: [
      { key: 'pay', kind: 'project', name: 'Платёжный шлюз' },
      {
        key: 'delta',
        name: 'Дельта',
        hosts: ['delta.local'],
        errors: [{ code: '77', title: 'Карта не найдена', action: 'Проверить токен' }],
        outcomes: [
          { when: { http: 500 }, outcome: 'error', text: 'Платёж {payment} отклонён' },
          { when: { http: 502 }, outcome: 'error', text: 'Платёж отклонён' },
          { when: { http: 503 }, outcome: 'error' },
        ],
      },
    ],
  });
  const read = (status: number, resp: unknown) => {
    const records = [incoming(T0, 'POST', '/v1/users'), ...exchange(T0 + 10, 'http://delta.local/pay', { status, resp })];
    const final = finalizeSummary(summarize(CID, records, OPTS), records, resolver, OPTS);
    const view = annotateRecords(markPending(buildView(records, { withOffsets: true }), OPTS), resolver);
    return { reason: businessSummary(final).reasons.find((r) => r.kind === 'outcome')!, record: businessRecords(view).find((r) => r.kind === 'response')! };
  };

  it('правило с подстановкой: текста правила нет ни в причине, ни на шаге', () => {
    const { reason, record } = read(500, { payment: 'P-12345' });
    expect(reason.text).toBe('');
    expect(record.catalog!.outcome).toMatchObject({ kind: 'error', text: null });
    expect(JSON.stringify([reason, record])).not.toContain('P-12345');
    expect(JSON.stringify([reason, record])).not.toContain('отклонён');
  });

  it('правило без подстановки: текст как есть, он же заголовок шага', () => {
    const { reason, record } = read(502, { any: 1 });
    expect(reason.text).toBe('Платёж отклонён');
    expect(record.catalog!.outcome!.text).toBe('Платёж отклонён');
    expect(record.catalog!.error!.title).toBe('Платёж отклонён');
  });

  it('правило без текста: заголовок HTTP и текст ответа не проходят', () => {
    const { reason, record } = read(503, { error: 'connect to db01.pay.example:5432 failed' });
    expect(reason.text).toBe('');
    expect(record.catalog!.error!.title).toBeNull();
    expect(JSON.stringify([reason, record])).not.toMatch(/HTTP|503|db01/);
  });

  it('другой роли ответ прежний: разметка только добавляет признаки', () => {
    const records = [incoming(T0, 'POST', '/v1/users'), ...exchange(T0 + 10, 'http://delta.local/pay', { status: 500, resp: { payment: 'P-12345' } })];
    const view = annotateRecords(markPending(buildView(records, { withOffsets: true }), OPTS), resolver);
    expect(view.find((r) => r.kind === 'response')!.catalog!.outcome!.text).toContain('P-12345');
  });
});

const flowOf = (over: Partial<OperationFlow>): OperationFlow => ({
  kind: 'flow',
  cid: 'cid-1',
  segment: null,
  nocid: false,
  firstMs: 1,
  lastMs: 2,
  role: 'call',
  title: '192.0.2.17 · /v3/cards/5a1d',
  safeTitle: '/v3/cards/{card}',
  status: 'success',
  incomplete: false,
  error: false,
  opStatus: null,
  claimed: false,
  noStatus: false,
  ops: 1,
  linkedBy: [{ type: 'transfer', at: 'response' }],
  found: null,
  pauseMs: null,
  together: false,
  callbackEarly: false,
  firstRecordId: 'r1',
  ...over,
});

describe('операция', () => {
  const op = (over: Partial<OperationView> = {}): OperationView => ({
    key: { type: 'transfer', name: 'Перевод', values: ['t-1'], also: [{ type: 'pay', name: 'Платёж', value: 'p-1' }] },
    window: { fromMs: 1, toMs: 2, preset: '6h' },
    items: [flowOf({}), flowOf({ cid: 'cid-m', role: 'mention', title: 'упоминание db01', safeTitle: null, found: 'log-body' })],
    trail: [
      { status: { type: 'transfer', value: 'done', raw: 'DONE', name: 'Выполнен', outcome: 'success', order: 1 }, atMs: 1, cid: 'cid-1', segment: null, claimed: false, stale: false, together: false },
      { status: { type: 'transfer', value: 'odd', raw: 'ODD-RAW', name: null, outcome: null, order: null }, atMs: 2, cid: 'cid-1', segment: null, claimed: false, stale: false, together: false },
    ],
    outcome: { kind: 'unknown', status: { type: 'transfer', value: 'odd', raw: 'ODD-RAW', name: null, outcome: null, order: null }, previous: null, basis: null, cid: null, partial: false, failed: 0 },
    excluded: ['container != pgadmin'],
    extraIds: [{ type: 'pay', name: 'Платёж', value: 'p-2' }],
    unsearchedIds: [{ type: 'pay', name: 'Платёж', value: 'p-3' }],
    supplemented: false,
    unknownType: true,
    ...over,
  });

  it('нет условий селектора, упоминаний, id сверх предела и исходных значений статусов', () => {
    const out = businessOperation(op());
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({ title: '/v3/cards/{card}', found: null, linkedBy: [{ type: 'transfer', at: 'response' }] });
    expect(out.trail.map((t) => [t.status.name, t.status.raw])).toEqual([['Выполнен', '']]);
    expect(out.outcome.status).toBeNull();
    expect(out.excluded).toEqual([]);
    expect(out.unsearchedIds).toEqual([]);
    expect(out.extraIds).toEqual([{ type: 'pay', name: 'Платёж', value: 'p-2' }]);
    expect(JSON.stringify(out)).not.toMatch(/pgadmin|cid-m|упоминание|ODD|10\.10\.5\.17|p-3/);
  });

  it('новое поле потока и операции не уходит', () => {
    const f = flowOf({}) as OperationFlow & { extra: string };
    f.extra = 'значение';
    const v = op({ items: [f] }) as OperationView & { extra: string };
    v.extra = 'значение';
    expect(JSON.stringify(businessOperation(v))).not.toContain('значение');
  });

  it('группа: название по шаблону, поток без названия с пустым заголовком', () => {
    const items = businessOperation(op({ items: [{ kind: 'group', role: 'status', title: 'db01 · сырой', safeTitle: null, cids: ['a'], firstMs: 1, lastMs: 2, failed: 0, lastStatus: null, flows: [flowOf({ safeTitle: null, title: 'сырой db01' })], pauseMs: 0, together: false }] })).items;
    expect(items[0]).toMatchObject({ kind: 'group', title: '' });
    expect(JSON.stringify(items)).not.toMatch(/db01|сырой/);
  });

  it('safeTitle потока: справочник, имя системы или шаблон входа, а не текст записи', () => {
    const send = rec({ id: 's', kind: 'send', http: http('http://192.0.2.17:8443/v3/cards/5a1d0100-0000-4000-8000-000000000001', { pairId: 'p' }) });
    const facts = flowFacts('cid-1', [send]);
    expect(facts.steps[0]!.safeTitle).toBeNull();
    expect(flowFacts('cid-5', [rec({ id: 'in', kind: 'incoming', http: http('/v3/cards/5a1d0100-0000-4000-8000-000000000001') })]).entry!.safeTitle).toBe('/v3/cards/{card}');
    const log = flowFacts('cid-2', [rec({ id: 'l', kind: 'log', level: 'ERROR', isError: true })]);
    expect(log.steps[0]!.safeTitle ?? null).toBeNull();
    const named = flowFacts('cid-3', [rec({ id: 'in', kind: 'incoming', http: http('/v1/x/5a1d0100-0000-4000-8000-000000000001'), catalog: { name: NAME, error: null, outcome: null, ids: [{ type: 'transfer', name: 'Перевод', kind: 'operation', value: 't-1', at: 'path' }], status: null } })]);
    expect(named.entry!.safeTitle).toBe('Карта по токену');
    const view = buildOperation({ key: { type: 'transfer', name: 'Перевод', values: ['t-1'] }, window: { fromMs: 0, toMs: 9, preset: '6h' }, flows: [named] });
    expect((view.items[0] as OperationFlow).safeTitle).toBe('Карта по токену');
    expect(flowFacts('cid-4', [rec({ id: 's', kind: 'send', http: http('https://processor.pay.example:8443/x/y') })]).steps[0]!.safeTitle).toBe('processor');
  });

  it('идентификатор сегмента без имени пода, тот же для разных прогонов', () => {
    const rec2 = { timeMs: 5, labels: { pod: 'pay-app-worker-5f7c9d8b6a-qx2lm' }, component: null };
    const a = nocidSegments([rec2]).segments[0]!;
    expect(a.id).toMatch(/^nocid:[0-9a-f]{12}:5$/);
    expect(a.id).not.toContain('worker');
    expect(nocidSegments([rec2]).segments[0]!.id).toBe(a.id);
  });
});

describe('ответы', () => {
  it('состояние поиска: ошибка только кодом, ссылки на хранилище нет', () => {
    const s: SearchState = {
      id: 'j',
      status: 'failed',
      stage: 'fetch',
      period: { fromMs: 1, toMs: 2, preset: '6h' },
      terms: [{ display: '+447700900001', kind: 'phone' }],
      found: 1,
      tooMany: false,
      truncated: false,
      scannedFromMs: null,
      lines: 'none',
      progress: { chunksDone: 1, chunksTotal: 1, batchesDone: 0, batchesTotal: 0 },
      requests: [summary([])],
      requestsTotal: 1,
      error: { code: 'timeout', details: 'строка лога db01', retryAfterSeconds: 7, stage: 'fetch' },
      explore: { url: 'https://grafana.example/explore?x=1', wider: false, typed: false },
    };
    const out = businessState(s);
    expect(out.error).toEqual({ code: 'timeout', retryAfterSeconds: 7, stage: 'fetch' });
    expect(out.terms).toEqual([{ display: '+447700900001', kind: 'phone' }]);
    expect('explore' in out).toBe(false);
    // Исключённые значения ввёл сам пользователь. Нет у задания — нет и поля.
    expect(businessState({ ...s, excludes: [{ display: 'abc', kind: 'text' }] }).excludes).toEqual([{ display: 'abc', kind: 'text' }]);
    expect('excludes' in out).toBe(false);
    expect(businessState({ ...s, excluding: { removed: true } }).excluding).toEqual({ removed: true });
    expect('excluding' in out).toBe(false);
    expect(JSON.stringify(out)).not.toMatch(/grafana|db01|"main"/);
  });

  it('состояние справочника: счётчика «Неизвестного» нет', () => {
    const out = businessCatalogState({ state: 'ok', loadedAt: 1, message: null, unknownOpen: { pay: 3 } });
    expect('unknownOpen' in out).toBe(false);
  });

  it('страница запроса: пути входа нет и шаблоном, в списке он остаётся', () => {
    const list = summary([]);
    const out = businessDetail({ summary: list, records: [rec({ id: 'a', kind: 'incoming', http: http('/v1/beneficiary/rustamova/pay') })] } as RequestDetail);
    expect(out.summary.incoming).toEqual({ method: '', path: '' });
    expect(out.records[0]!.http!.uri).toBeNull();
    expect(JSON.stringify(out)).not.toContain('rustamova');
    expect(businessSummary(list).incoming!.path).toBe('/v1/users/{user}/cards/{card}');
  });

  it('запрос: без сведений о скрытых видах и ссылки на хранилище', () => {
    const out = businessDetail({
      summary: summary([]),
      records: [rec({ id: 'a', kind: 'send', http: http('/x'), open: { uri: 'открыто', sections: { headers: null, body: 'открыто', payload: null, context: null }, raw: 'открыто' } })],
      // Оба написания: список полей явный, поэтому переименование ничего не открывает.
      personal: { types: ['phone'] },
      reveal: { kinds: ['phone'], stays: ['secrets'] },
      explore: { url: 'https://grafana.example/x', wider: false, typed: false },
      operationKeys: [{ type: 't', name: 'Т', value: 'v', short: 'v', masked: false }],
    } as RequestDetail);
    expect(Object.keys(out).sort()).toEqual(['operationKeys', 'records', 'summary']);
    expect(JSON.stringify(out)).not.toMatch(/открыто|grafana|phone|secrets/);
  });

  it('список проектов: нет имён переменных, хранилищ и скрытых проектов', () => {
    const out = businessProjects(
      {
        projects: [{ id: 'pay', name: 'Demo Pay', timezone: 'UTC', retentionDays: 30, logo: { light: '/l', dark: '/d', ratio: 2 }, environments: [{ id: 'prod', name: 'Прод', kind: 'single', backendType: 'loki-grafana', notConfigured: true, missingEnv: 'THREADLINE_GRAFANA_TOKEN', missingStore: 'grafana', outOfScope: 'grafana' }] }],
        defaults: { project: 'pay', environment: 'prod' },
        hidden: [{ id: 'secret', name: 'Скрытый' }],
        incomplete: false,
      },
      DEFAULT_VIEW,
    );
    expect(out.projects[0]!.environments).toEqual([{ id: 'prod', name: 'Прод', kind: 'single', notConfigured: true }]);
    expect(out.projects[0]!.logo).toEqual({ light: '/l', dark: '/d', ratio: 2 });
    expect('hidden' in out).toBe(false);
    expect(JSON.stringify(out)).not.toMatch(/THREADLINE|grafana|Скрытый|secret/);
  });

  it('проверка подключения и состояние справочника без подробностей', () => {
    expect(businessConnection({ status: 'unauthorized', checkedAt: 't', retryAfterSeconds: 3, details: 'db', missingEnv: 'X', datasource: 'Loki', missingStore: 's', outOfScope: 'o' })).toEqual({ status: 'unauthorized', checkedAt: 't', retryAfterSeconds: 3 });
    expect(businessCatalogState({ state: 'stale', loadedAt: 5, message: 'db01:5432', masking: { pay: 'x' }, projectsVersion: 2 })).toEqual({ state: 'stale', loadedAt: 5, message: null, projectsVersion: 2 });
  });

  it('настройка вида: проект не открывает Бизнесу блоки, вкладки и колонки', () => {
    const all = (v: boolean) => ({ full: v, brief: v });
    const open: ViewSettings = { ...DEFAULT_VIEW, defaultMode: 'full', defaultTab: 'records', columns: { time: all(true), request: all(true), outcome: all(true), component: all(true), duration: all(true), records: all(true), cid: all(true) }, tabs: { scheme: all(true), records: all(true) }, blocks: { request: all(true), response: all(true), headers: all(true), context: all(true), raw: all(true), logs: all(true) } };
    const out = businessView(open);
    expect(out.defaultMode).toBe('brief');
    expect(out.defaultTab).toBe('timeline');
    expect(out.tabs.records).toEqual({ full: false, brief: false });
    for (const b of Object.values(out.blocks)) expect(b).toEqual({ full: false, brief: false });
    for (const c of ['component', 'records', 'cid'] as const) expect(out.columns[c]).toEqual({ full: false, brief: false });
    expect(businessView(DEFAULT_VIEW).defaultTab).toBe('scheme');
    expect(businessView({ ...DEFAULT_VIEW, tabs: { scheme: { full: true, brief: false }, records: all(false) } }).defaultTab).toBe('timeline');
  });
});
