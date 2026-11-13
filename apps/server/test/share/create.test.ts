// Создание ссылки и журнал: значения только из своего задания, номер карты краями, в журнале нет ни идентификатора, ни значений.
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectTerm, edgesPattern } from '@threadline/core/search';
import { MOCK_FLOW, MOCK_PERSONAL } from '../../src/backends/mock/dataset-pay.ts';
import { ANCHOR, as, info, runLink, search, share, shareRig, type ShareRig } from './harness.ts';

const PAN = '4111111234557893';
const NUMBER = '123456789012345678';

let r: ShareRig;
const rows = (id: string) => r.catalog.db().query<Record<string, unknown>>('select * from share_link where id = $1', [id]);

beforeAll(async () => {
  r = await shareRig();
}, 60_000);

afterAll(async () => {
  await r.close();
});

describe('Ссылка на результаты', () => {
  it('значения и точные даты из своего задания, случайный адрес на 22 символа', async () => {
    const searchId = await search(r, [MOCK_PERSONAL.cid]);
    const before = r.reads();
    const link = await share(r, { kind: 'results', searchId });
    expect(r.reads(), 'создание не читает хранилище').toBe(before);
    expect(link.path).toMatch(/^\/s\/[A-Za-z0-9_-]{22}$/);
    const [row] = await rows(link.id);
    expect(row).toMatchObject({ kind: 'results', project_id: 'pay', env_id: 'demo', stand: null, terms: [MOCK_PERSONAL.cid], target: null });
    const span = new Date(row!.to_at as string).getTime() - new Date(row!.from_at as string).getTime();
    expect(span).toBe(24 * 60 * 60_000);
    expect(new Date(link.expiresAt).getTime()).toBe(r.clock.t + 30 * 24 * 60 * 60_000);
    // Автора и открытий нет ни в одной колонке.
    expect(Object.keys(row!).sort()).toEqual(['created_at', 'env_id', 'expires_at', 'from_at', 'id', 'kind', 'project_id', 'stand', 'target', 'terms', 'to_at'].sort());
  });

  it('чужое и истёкшее задание: search-expired, ссылки нет', async () => {
    const searchId = await search(r, [MOCK_PERSONAL.cid], 'analyst', 'demo', 'first');
    const foreign = await r.app.inject({ method: 'POST', url: '/api/share', headers: as('analyst', 'second'), payload: { kind: 'results', searchId } });
    expect([foreign.statusCode, foreign.json()]).toEqual([404, { error: { code: 'search-expired' } }]);
    const gone = await r.app.inject({ method: 'POST', url: '/api/share', headers: as('analyst'), payload: { kind: 'results', searchId: 'no-such-job' } });
    expect(gone.json()).toEqual({ error: { code: 'search-expired' } });
  });

  it('граница запроса в году 202333 или огромным числом: отказ, а не ошибка базы', async () => {
    for (const fromMs of [6_323_000_000_000_000, 1e300]) {
      const res = await r.app.inject({ method: 'POST', url: '/api/share', headers: as('analyst'), payload: { kind: 'request', project: 'pay', env: 'demo', cid: 'c1', fromMs, toMs: fromMs } });
      expect([res.statusCode, res.json().error.code]).toEqual([400, 'bad-request']);
    }
  });

  it('значения от браузера не принимаются', async () => {
    const res = await r.app.inject({ method: 'POST', url: '/api/share', headers: as('analyst'), payload: { kind: 'results', searchId: 'x', terms: ['подмена'] } });
    expect(res.statusCode).toBe(400);
  });

  it('401 без входа и 403 без роли', async () => {
    expect((await r.app.inject({ method: 'POST', url: '/api/share', payload: { kind: 'results', searchId: 'x' } })).statusCode).toBe(401);
    const none = await r.app.inject({ method: 'POST', url: '/api/share', headers: as('none'), payload: { kind: 'results', searchId: 'x' } });
    expect([none.statusCode, none.json()]).toEqual([403, { error: { code: 'no-role' } }]);
  });

  it.each(['business', 'support', 'developer', 'analyst', 'admin'])('%s создаёт ссылку того же вида', async (role) => {
    const searchId = await search(r, [MOCK_PERSONAL.cid], role, 'demo', role);
    const link = await share(r, { kind: 'results', searchId }, as(role, role));
    expect(link.path).toMatch(/^\/s\/[A-Za-z0-9_-]{22}$/);
  });
});

describe('Стенд', () => {
  it('берётся из задания, в ответе ссылки только номер', async () => {
    const started = await r.app.inject({ method: 'POST', url: '/api/projects/pay/envs/pr/searches', headers: as('analyst'), payload: { terms: [MOCK_PERSONAL.cid], period: { preset: '1h' }, stand: '7' } });
    expect(started.statusCode, started.body).toBe(200);
    const link = await share(r, { kind: 'results', searchId: (started.json() as { id: string }).id });
    const [row] = await rows(link.id);
    expect(row).toMatchObject({ env_id: 'pr', stand: '7' });
    const d = await info(r, link.id);
    expect(d).toMatchObject({ stand: '7', env: { id: 'pr', name: 'Стенды', kind: 'pr-stands' } });
    // Стенда уже нет, а условие собирается заново: поиск идёт, записей нет, ошибки нет.
    const state = await runLink(r, link.id);
    expect([state.status, state.requestsTotal, state.error]).toEqual(['done', 0, null]);
  });
});

describe('Номер карты в значении поиска', () => {
  it.each([['pan', PAN], ['number', NUMBER]])('%s: в базе только края, фильтр хранилища тот же', async (kind, value) => {
    const searchId = await search(r, [value]);
    const link = await share(r, { kind: 'results', searchId });
    const [row] = await rows(link.id);
    const text = JSON.stringify(row);
    expect(text).not.toContain(value);
    const stored = (row!.terms as string[])[0]!;
    expect(stored).toBe(`${value.slice(0, 6)}${'*'.repeat(value.length - 10)}${value.slice(-4)}`);
    const again = detectTerm(stored);
    expect(again).toMatchObject({ kind: 'pan-mask', filter: { kind: 'regex', pattern: edgesPattern(value) } });
    expect(detectTerm(value)).toMatchObject({ filter: { kind: 'regex', pattern: edgesPattern(value) } });
  });
});

describe('Исключённые значения', () => {
  it('в базе в target, номер карты краями; браузер их не присылает', async () => {
    const res = await r.app.inject({ method: 'POST', url: '/api/projects/pay/envs/demo/searches', headers: as('analyst'), payload: { terms: [MOCK_PERSONAL.cid], excludes: [PAN, 'лишнее-значение'], period: { preset: '24h' } } });
    expect(res.statusCode, res.body).toBe(200);
    const link = await share(r, { kind: 'results', searchId: (res.json() as { id: string }).id });
    const [row] = await rows(link.id);
    expect(row!.target).toEqual({ excludes: [`${PAN.slice(0, 6)}******${PAN.slice(-4)}`, 'лишнее-значение'] });
    expect(JSON.stringify(row)).not.toContain(PAN);
  });

  it('поиск без исключений: target пуст, как раньше', async () => {
    const link = await share(r, { kind: 'results', searchId: await search(r, [MOCK_PERSONAL.cid]) });
    expect((await rows(link.id))[0]!.target).toBeNull();
  });
});

describe('Ссылка на запрос', () => {
  const body = { kind: 'request', project: 'pay', env: 'demo', cid: MOCK_PERSONAL.cid, fromMs: ANCHOR - 3_600_000, toMs: ANCHOR - 3_500_000 };

  it('в базе correlation_id и границы, значений поиска нет, хранилище не читается', async () => {
    const before = r.reads();
    const link = await share(r, body);
    expect(r.reads()).toBe(before);
    const [row] = await rows(link.id);
    expect(row).toMatchObject({ kind: 'request', terms: [], target: { cid: MOCK_PERSONAL.cid } });
  });

  it.each([
    [{ ...body, cid: 'nocid:1' }, 400],
    [{ ...body, cid: 'плохой' }, 400],
    [{ ...body, fromMs: body.toMs + 1 }, 400],
    [{ ...body, toMs: body.fromMs + 25 * 3_600_000 }, 400],
    [{ ...body, fromMs: ANCHOR - 500 * 86_400_000, toMs: ANCHOR - 500 * 86_400_000 }, 404],
    [{ ...body, stand: '1' }, 400],
    [{ ...body, env: 'no-such' }, 404],
  ])('те же правила, что у readLink: %j', async (payload, status) => {
    const res = await r.app.inject({ method: 'POST', url: '/api/share', headers: as('analyst'), payload });
    expect(res.statusCode, res.body).toBe(status);
  });
});

describe('Ссылка на операцию', () => {
  it('в базе тип, значения, окно и стенд', async () => {
    const started = await r.app.inject({ method: 'POST', url: '/api/projects/pay/envs/demo/operations', headers: as('analyst'), payload: { type: 'transfer', values: [MOCK_FLOW.transfer], atMs: ANCHOR - 3_600_000, window: '24h' } });
    expect(started.statusCode, started.body).toBe(200);
    const link = await share(r, { kind: 'operation', searchId: (started.json() as { id: string }).id });
    const [row] = await rows(link.id);
    expect(row).toMatchObject({ kind: 'operation', terms: [], target: { type: 'transfer', values: [MOCK_FLOW.transfer], also: [], window: '24h' } });
    const results = await r.app.inject({ method: 'POST', url: '/api/share', headers: as('analyst'), payload: { kind: 'results', searchId: (started.json() as { id: string }).id } });
    expect(results.statusCode).toBe(400);
  });
});

describe('База недоступна', () => {
  it('создание: share-unavailable, поиск работает', async () => {
    const off = await shareRig({ databaseUrl: '' });
    try {
      const searchId = await search(off, [MOCK_PERSONAL.cid]);
      const res = await off.app.inject({ method: 'POST', url: '/api/share', headers: as('analyst'), payload: { kind: 'results', searchId } });
      expect([res.statusCode, res.json()]).toEqual([503, { error: { code: 'share-unavailable' } }]);
    } finally {
      await off.close();
    }
  });
});

describe('Журнал сервера', () => {
  it('при создании и открытии нет ни идентификатора, ни значений', async () => {
    const lines: string[] = [];
    const logged = await shareRig({ stream: new Writable({ write: (c, _e, cb) => (lines.push(String(c)), cb()) }) });
    try {
      const searchId = await search(logged, [MOCK_PERSONAL.phone, MOCK_PERSONAL.cid]);
      const link = await share(logged, { kind: 'results', searchId });
      await info(logged, link.id);
      await runLink(logged, link.id);
      const text = lines.join('');
      expect(text).toContain('/api/s/:id/run');
      // Опрос хода на уровне info не пишется.
      expect(text).not.toContain('/api/s/:id/state');
      expect(text).toContain('/api/share');
      expect(text).not.toContain(link.id);
      expect(text).not.toContain(MOCK_PERSONAL.phone);
      const page = await logged.app.inject({ url: `/api/s/${link.id}` });
      expect(page.headers['referrer-policy']).toBe('no-referrer');
    } finally {
      await logged.close();
    }
  });
});
