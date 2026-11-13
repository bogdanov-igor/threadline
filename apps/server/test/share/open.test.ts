// Открытая поверхность: без сессии и с каждой ролью ответы одинаковы, значения под маской, состояния ссылки проверяются до хранилища.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ShareInfo } from '@threadline/core';
import type { RequestDetail, SearchState } from '@threadline/core/search';
import { MOCK_FLOW, MOCK_PERSONAL } from '../../src/backends/mock/dataset-pay.ts';
import { insertLink, type NewShare } from '../../src/share/store.ts';
import { ANCHOR, as, DAY, info, runLink, search, share, shareRig, type ShareRig } from './harness.ts';

const SYNTHETIC = [MOCK_PERSONAL.phone, MOCK_PERSONAL.phone2.slice(1), MOCK_PERSONAL.nationalId, MOCK_PERSONAL.pan, MOCK_PERSONAL.passport, MOCK_PERSONAL.password, MOCK_PERSONAL.surname, MOCK_PERSONAL.address];

let r: ShareRig;
let seq = 0;

const direct = async (over: Partial<NewShare>): Promise<string> => {
  const id = `${String(seq++).padStart(4, '0')}${'x'.repeat(18)}`;
  await insertLink(r.catalog.db(), { id, kind: 'results', projectId: 'pay', envId: 'demo', stand: null, terms: [MOCK_PERSONAL.cid], fromMs: ANCHOR - DAY, toMs: ANCHOR, target: null, createdMs: r.clock.t, expiresMs: r.clock.t + 30 * DAY, ...over });
  return id;
};

/** Все ответы ссылки подряд: описание, опрос, запрос, записи. */
async function responses(id: string, cid: string, headers: Record<string, string> = {}) {
  const urls = [`/api/s/${id}`, `/api/s/${id}/state`, `/api/s/${id}/requests/${cid}`, `/api/s/${id}/lines`];
  const out: Record<string, unknown> = {};
  for (const url of urls) {
    const res = await r.app.inject({ url, headers });
    out[url] = { status: res.statusCode, body: res.json() };
  }
  return out;
}

beforeAll(async () => {
  r = await shareRig();
}, 60_000);

afterAll(async () => {
  await r.close();
});

describe('Маска и равенство ответов', () => {
  it('без сессии и с сессией любой роли ответы равны, синтетических значений и полей показа нет', async () => {
    const searchId = await search(r, [MOCK_PERSONAL.cid]);
    const { id } = await share(r, { kind: 'results', searchId });
    const state = await runLink(r, id);
    expect(state.requestsTotal).toBeGreaterThan(0);
    const anon = await responses(id, MOCK_PERSONAL.cid);
    const text = JSON.stringify(anon);
    for (const value of SYNTHETIC) expect(text, value).not.toContain(value);
    for (const field of ['"open"', '"explore"', '"reveal"', 'missingEnv', 'grafana.corp.example']) expect(text, field).not.toContain(field);
    for (const role of ['business', 'support', 'developer', 'analyst', 'admin', 'none']) expect(await responses(id, MOCK_PERSONAL.cid, as(role)), role).toEqual(anon);
  });

  it('вид выключен в справочнике: на ссылке под маской, поля open нет; в обычном интерфейсе правило прежнее', async () => {
    const edit = await r.app.inject({ method: 'PUT', url: '/api/projects/pay/catalog/masking/phone', headers: as('admin'), payload: { enabled: false, keys: [], updatedAt: await rowStamp('phone') } });
    expect(edit.statusCode, edit.body).toBe(200);
    const searchId = await search(r, [MOCK_PERSONAL.cid], 'analyst', 'demo', 'second');
    const { id } = await share(r, { kind: 'results', searchId }, as('analyst', 'second'));
    await runLink(r, id);
    const res = await r.app.inject(`/api/s/${id}/requests/${MOCK_PERSONAL.cid}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(MOCK_PERSONAL.phone);
    expect(res.body).not.toContain('"open"');
    const plain = await r.app.inject({ url: `/api/searches/${searchId}/requests/${MOCK_PERSONAL.cid}`, headers: as('support', 'second') });
    expect(plain.body).toContain('"open"');
  });

  it('значения поиска показаны маской, uuid как есть, текст заменён; в ответах их нет', async () => {
    const searchId = await search(r, [MOCK_PERSONAL.phone, MOCK_PERSONAL.pan, 'произвольный-текст', MOCK_PERSONAL.cid], 'analyst', 'demo', 'third');
    const { id } = await share(r, { kind: 'results', searchId }, as('analyst', 'third'));
    const d = await info(r, id);
    expect(d.terms).toEqual([
      { kind: 'phone', display: `+********${MOCK_PERSONAL.phone.slice(-4)}` },
      { kind: 'pan-mask', display: `${MOCK_PERSONAL.pan.slice(0, 6)}******${MOCK_PERSONAL.pan.slice(-4)}` },
      { kind: 'text', display: '***' },
      { kind: 'uuid', display: MOCK_PERSONAL.cid },
    ]);
    const state = await runLink(r, id);
    expect(state.terms).toEqual([]);
    const text = JSON.stringify([d, state]);
    for (const value of [MOCK_PERSONAL.phone, MOCK_PERSONAL.pan, 'произвольный-текст']) expect(text).not.toContain(value);
  });

  it('исключённые значения: маска в описании, в состоянии их нет, строки исключены и у открывшего', async () => {
    const id = await direct({ terms: ['getCard'], target: { excludes: [`${MOCK_PERSONAL.pan.slice(0, 6)}******${MOCK_PERSONAL.pan.slice(-4)}`, 'произвольный-текст', MOCK_PERSONAL.phone] } });
    const d = await info(r, id);
    expect(d.excludes).toEqual([
      { kind: 'pan-mask', display: `${MOCK_PERSONAL.pan.slice(0, 6)}******${MOCK_PERSONAL.pan.slice(-4)}` },
      { kind: 'text', display: '***' },
      { kind: 'phone', display: `+********${MOCK_PERSONAL.phone.slice(-4)}` },
    ]);
    const state = await runLink(r, id);
    expect('excludes' in state).toBe(false);
    const text = JSON.stringify([d, state]);
    for (const value of [MOCK_PERSONAL.phone, MOCK_PERSONAL.pan, 'произвольный-текст']) expect(text).not.toContain(value);
  });

  it('исключённое значение реально действует при поиске заново', async () => {
    const lines = async (target: NewShare['target']) => {
      const id = await direct({ terms: ['getCard'], target });
      expect((await runLink(r, id)).status).toBe('done');
      return (await r.app.inject(`/api/s/${id}/lines`)).body;
    };
    expect(await lines(null)).toContain('getCardResponse');
    expect(await lines({ excludes: ['getCardResponse'] })).not.toContain('getCardResponse');
  });

  it('ссылка с условием: запросы с исключённым значением убраны из списка, остальные и строка в «Всех записях» открываются целиком', async () => {
    const stateOf = async (target: NewShare['target']) => {
      const id = await direct({ terms: ['getCard'], target });
      return { id, state: await runLink(r, id) };
    };
    const all = await stateOf(null);
    const left = await stateOf({ excludes: ['getBalance'] });
    expect(left.state.requestsTotal).toBeGreaterThan(0);
    expect(left.state.requestsTotal).toBeLessThan(all.state.requestsTotal);
    expect(left.state.excluding).toEqual({ removed: true });
    expect('excludes' in left.state).toBe(false);
    const gone = all.state.requests.find((x) => !left.state.requests.some((y) => y.correlationId === x.correlationId))!;
    const whole = (await r.app.inject(`/api/s/${left.id}/requests/${gone.correlationId}`)).json<RequestDetail>();
    expect(whole.summary.status).toBe(gone.status);
    expect(whole.records.length).toBe(gone.recordCount);
  });

  it.each([[{ excludes: 'строка' }], [{ excludes: [1] }], [{ excludes: ['x'] }], [{ excludes: ['getCard'] }], [{ other: 1 }]])('запись %j не разбирается: share-outdated, хранилище не читается', async (target) => {
    const before = r.reads();
    const id = await direct({ terms: ['getCard'], target });
    const res = await r.app.inject(`/api/s/${id}`);
    expect(res.json()).toEqual({ error: { code: 'share-outdated' } });
    expect(r.reads()).toBe(before);
  });

  it('ссылка старой версии: target пуст, исключений нет', async () => {
    expect('excludes' in (await info(r, await direct({ terms: ['getCard'] })))).toBe(false);
  });

  it('описание без селекторов и хранилищ, период точными датами', async () => {
    const { id } = await share(r, { kind: 'results', searchId: await search(r, [MOCK_PERSONAL.cid], 'analyst', 'demo', 'fourth') }, as('analyst', 'fourth'));
    const d = await info(r, id);
    expect(Object.keys(d).sort()).toEqual(['env', 'expiresAt', 'kind', 'period', 'periodCut', 'project', 'stand', 'target', 'terms'] satisfies (keyof ShareInfo)[]);
    expect(Object.keys(d.env).sort()).toEqual(['id', 'kind', 'name']);
    expect(d.period.toMs - d.period.fromMs).toBe(DAY);
    // Селекторы и хранилище среды в описание не попадают.
    for (const secret of ['namespace', 'selector', 'backend', 'mock']) expect(JSON.stringify(d)).not.toContain(secret);
    const state = await runLink(r, id);
    expect(state.period.preset).toBeNull();
  });

  it('маршрута показа нет: 404', async () => {
    const id = await direct({});
    expect((await r.app.inject(`/api/s/${id}/requests/${MOCK_PERSONAL.cid}/reveal`)).statusCode).toBe(404);
    expect((await r.app.inject(`/api/s/${id}/reveal`)).statusCode).toBe(404);
  });
});

describe('Узкая открытая поверхность', () => {
  it('подмена условий: тело не учитывается, поиск идёт по сохранённому', async () => {
    const id = await direct({ terms: [MOCK_PERSONAL.cid], fromMs: ANCHOR - 3_600_000, toMs: ANCHOR - 1_800_000 });
    const res = await r.app.inject({ method: 'POST', url: `/api/s/${id}/run`, payload: { terms: ['подмена'], period: { preset: '24h' }, env: 'prod', stand: '1' } });
    expect(res.statusCode).toBe(200);
    const state = await runLink(r, id);
    expect(state.period).toEqual({ fromMs: ANCHOR - 3_600_000, toMs: ANCHOR - 1_800_000, preset: null });
  });

  it('чужой источник не запускает поиск, свой запускает', async () => {
    const id = await direct({});
    const before = r.reads();
    const evil = await r.app.inject({ method: 'POST', url: `/api/s/${id}/run`, headers: { origin: 'https://evil.example', host: 'localhost' } });
    expect([evil.statusCode, evil.json()]).toEqual([403, { error: { code: 'forbidden' } }]);
    expect(r.reads()).toBe(before);
  });

  it('чужой идентификатор: ответ байт в байт как у неизвестной ссылки, хранилище не читается', async () => {
    const results = await direct({});
    await runLink(r, results);
    const target = await direct({ kind: 'request', terms: [], target: { cid: MOCK_PERSONAL.cid }, fromMs: ANCHOR - 3_600_000, toMs: ANCHOR });
    await runLink(r, target);
    const operation = await direct({ kind: 'operation', terms: [], target: { type: 'transfer', values: [MOCK_FLOW.transfer], also: [], window: '24h' }, fromMs: ANCHOR - DAY, toMs: ANCHOR });
    await runLink(r, operation);
    const unknown = await r.app.inject(`/api/s/${'u'.repeat(22)}`);
    expect(unknown.statusCode).toBe(404);
    // Настоящий запрос другой ссылки тоже чужой: страница не становится способом читать записи по идентификатору.
    const foreign = await direct({ terms: ['no-such-value'] });
    await runLink(r, foreign);
    const before = r.reads();
    for (const url of [`/api/s/${foreign}/requests/${MOCK_PERSONAL.cid}`, `/api/s/${results}/requests/foreign-cid`, `/api/s/${target}/requests/foreign-cid`, `/api/s/${operation}/requests/foreign-cid`, `/api/s/${results}/requests/${encodeURIComponent('плохой идентификатор')}`]) {
      const res = await r.app.inject(url);
      expect([res.statusCode, res.body, res.headers['content-type']], url).toEqual([unknown.statusCode, unknown.body, unknown.headers['content-type']]);
    }
    expect(r.reads()).toBe(before);
  });

  it('свой запрос ссылки открывается и по вложенному адресу страницы', async () => {
    const results = await direct({});
    const state = await runLink(r, results);
    const cid = state.requests[0]!.correlationId;
    const res = await r.app.inject(`/api/s/${results}/requests/${encodeURIComponent(cid)}`);
    expect(res.statusCode).toBe(200);
    expect((res.json() as RequestDetail).summary.correlationId).toBe(cid);
    const body = res.body;
    for (const value of SYNTHETIC) expect(body, value).not.toContain(value);
  });

  it('значение операции сервер от браузера не принимает: маршрута нет, хранилище не читается', async () => {
    const id = await direct({ kind: 'operation', terms: [], target: { type: 'transfer', values: [MOCK_FLOW.transfer], also: [], window: '24h' }, fromMs: ANCHOR - DAY, toMs: ANCHOR });
    const before = r.reads();
    for (const url of [`/api/s/${id}/operations/transfer/${MOCK_FLOW.transfer}`, `/api/s/${id}/operations/transfer/foreign`, `/api/s/${id}/requests/x/y`]) {
      const res = await r.app.inject(url);
      expect([res.statusCode, res.json()], url).toEqual([404, { error: { code: 'bad-request', details: 'нет такого метода API' } }]);
    }
    expect(r.reads()).toBe(before);
  });

  it('неверный вид идентификатора: то же сообщение без запроса к базе', async () => {
    const seen: string[] = [];
    const db = r.catalog.readDb()!;
    const original = db.query;
    db.query = ((sql: string, params?: readonly unknown[]) => (seen.push(sql), original(sql, params))) as typeof db.query;
    try {
      for (const id of ['abc', '%24%24%24', 'x'.repeat(23), 'a!'.repeat(11)]) {
        const res = await r.app.inject(`/api/s/${id}`);
        expect([res.statusCode, res.json()], id).toEqual([404, { error: { code: 'share-not-found' } }]);
      }
      expect(seen).toEqual([]);
    } finally {
      db.query = original;
    }
  });
});

describe('Поиск заново: ссылка на запрос и операцию', () => {
  it('запрос: окно прочитано, запрос показан; записей нет — request-not-found', async () => {
    const id = await direct({ kind: 'request', terms: [], target: { cid: MOCK_PERSONAL.cid }, fromMs: ANCHOR - DAY, toMs: ANCHOR });
    expect(await info(r, id)).toMatchObject({ kind: 'request', target: { cid: MOCK_PERSONAL.cid } });
    const state = await runLink(r, id);
    expect(state.requests.map((s) => s.correlationId)).toEqual([MOCK_PERSONAL.cid]);
    const detail = (await r.app.inject(`/api/s/${id}/requests/${MOCK_PERSONAL.cid}`)).json() as RequestDetail;
    expect(detail.records.length).toBeGreaterThan(0);
    const empty = await direct({ kind: 'request', terms: [], target: { cid: 'cid-without-records' }, fromMs: ANCHOR - 3_600_000, toMs: ANCHOR });
    const none = await runLink(r, empty);
    expect([none.status, none.requestsTotal]).toEqual(['done', 0]);
    expect((await r.app.inject(`/api/s/${empty}/requests/cid-without-records`)).json()).toEqual({ error: { code: 'request-not-found' } });
  });

  it('операция: потоки в сохранённом окне, условий селектора в ответе нет', async () => {
    const id = await direct({ kind: 'operation', terms: [], target: { type: 'transfer', values: [MOCK_FLOW.transfer], also: [], window: '24h' }, fromMs: ANCHOR - DAY, toMs: ANCHOR });
    const state = await runLink(r, id);
    expect(state.operation?.items.length).toBeGreaterThan(0);
    expect(state.operation?.excluded).toEqual([]);
    expect(state.operation?.window.preset).toBe('24h');
    expect(JSON.stringify(state)).not.toContain('"explore"');
  });

  it('«Неизвестное» не растёт, названия есть', async () => {
    const before = r.observed.length;
    const id = await direct({ terms: [MOCK_PERSONAL.cid] });
    const state = await runLink(r, id);
    expect(state.requestsTotal).toBeGreaterThan(0);
    const detail = (await r.app.inject(`/api/s/${id}/requests/${MOCK_PERSONAL.cid}`)).json() as RequestDetail;
    expect(detail.summary.entry === undefined ? 'нет разметки' : 'есть').toBe('есть');
    expect(r.observed.length).toBe(before);
    // Обычный поиск собирает: хук настоящий, просто ссылка его не зовёт.
    const plain = await search(r, [MOCK_PERSONAL.cid], 'analyst', 'demo', 'collector');
    expect(plain).toBeTruthy();
    expect(r.observed.length).toBeGreaterThan(before);
  });
});

describe('Состояния ссылки до хранилища', () => {
  const old = ANCHOR - 500 * DAY;
  const CASES: [string, () => Partial<NewShare>, number, string][] = [
    ['проект скрыт или убран', () => ({ projectId: 'gone' }), 409, 'share-project-hidden'],
    ['среды нет', () => ({ envId: 'gone' }), 404, 'unknown-environment'],
    ['среда не настроена', () => ({ envId: 'prod' }), 409, 'not-configured'],
    ['стенд у среды без стендов', () => ({ stand: '5' }), 409, 'not-configured'],
    ['весь период старше срока хранения', () => ({ fromMs: old - DAY, toMs: old }), 410, 'logs-gone'],
    ['значение больше не проходит', () => ({ terms: ['"кавычки"'] }), 410, 'share-outdated'],
    ['цель запроса испорчена', () => ({ kind: 'request', terms: [], target: { cid: 'плохой идентификатор' } }), 410, 'share-outdated'],
    ['цель операции испорчена', () => ({ kind: 'operation', terms: [], target: { type: 'transfer', values: [], window: '6h' } }), 410, 'share-outdated'],
  ];

  it.each(CASES)('%s: код и статус, к хранилищу запросов нет', async (_name, over, status, code) => {
    const id = await direct(over());
    const before = r.reads();
    for (const res of [await r.app.inject(`/api/s/${id}`), await r.app.inject({ method: 'POST', url: `/api/s/${id}/run` })]) {
      expect([res.statusCode, res.json()]).toEqual([status, { error: { code } }]);
    }
    expect(r.reads()).toBe(before);
  });

  it('часть периода старше: обычный ответ и periodCut, поиск по оставшейся части', async () => {
    const floor = r.clock.t - 400 * DAY;
    const id = await direct({ fromMs: floor - DAY, toMs: floor + DAY });
    const d = await info(r, id);
    expect(d).toMatchObject({ periodCut: true, period: { fromMs: floor, toMs: floor + DAY } });
    expect((await runLink(r, id)).period.fromMs).toBe(floor);
  });

  it('задание удалено: search-expired, запуск заново работает', async () => {
    const id = await direct({});
    expect((await r.app.inject(`/api/s/${id}/state`)).json()).toEqual({ error: { code: 'search-expired' } });
    expect((await r.app.inject(`/api/s/${id}/requests/${MOCK_PERSONAL.cid}`)).json()).toEqual({ error: { code: 'search-expired' } });
    expect((await r.app.inject(`/api/s/${id}/lines`)).json()).toEqual({ error: { code: 'search-expired' } });
    expect((await runLink(r, id)).status).toBe('done');
  });

  it('ошибка хранилища: только код, без текста', async () => {
    const id = await direct({ envId: 'broken' });
    const state = await runLink(r, id);
    expect(state.error?.code).toBe('timeout');
    expect(state.error?.details).toBeUndefined();
  });

  it('база недоступна: share-unavailable, а не «ссылка больше не действует»; поиск в памяти работает', async () => {
    const id = await direct({});
    await runLink(r, id);
    const db = r.catalog.readDb()!;
    await db.exec('alter table share_link rename to share_link_away');
    try {
      const res = await r.app.inject(`/api/s/${id}`);
      expect([res.statusCode, res.json()]).toEqual([503, { error: { code: 'share-unavailable' } }]);
      expect(((await r.app.inject(`/api/s/${id}/state`)).json() as SearchState).status).toBe('done');
    } finally {
      await db.exec('alter table share_link_away rename to share_link');
    }
    const off = await shareRig({ databaseUrl: '' });
    try {
      expect((await off.app.inject(`/api/s/${id}`)).json()).toEqual({ error: { code: 'share-unavailable' } });
    } finally {
      await off.close();
    }
  });
});

async function rowStamp(type: string): Promise<string | null> {
  const res = (await r.app.inject({ url: '/api/projects/pay/catalog', headers: as('admin') })).json() as { masking?: { type: string; updatedAt: string }[] };
  return res.masking?.find((m) => m.type === type)?.updatedAt ?? null;
}
