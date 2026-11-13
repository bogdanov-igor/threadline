// Пределы заданий ссылок: один поиск на смотрящих, пять минут из памяти, 90 секунд без опроса, три идущих, обычный пул не тронут.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MOCK_PERSONAL } from '../../src/backends/mock/dataset-pay.ts';
import { ANCHOR, as, finish, runLink, search, share, shareRig, type ShareRig } from './harness.ts';

const LINKS = 5;
let r: ShareRig;
let ids: string[];
const run = (id: string) => r.app.inject({ method: 'POST', url: `/api/s/${id}/run` });
const until = async (check: () => boolean) => {
  for (let i = 0; i < 500 && !check(); i++) await new Promise((x) => setTimeout(x, 5));
};

beforeAll(async () => {
  r = await shareRig();
  const searchId = await search(r, [MOCK_PERSONAL.cid]);
  ids = [];
  for (let i = 0; i < LINKS; i++) ids.push((await share(r, { kind: 'results', searchId })).id);
}, 60_000);

afterAll(async () => {
  await r.close();
});

// Часы только вперёд: задание из будущего выглядело бы завершённым только что.
beforeEach(() => {
  r.gate.open();
});

describe('Пределы заданий ссылок', () => {
  it('пять человек на одну ссылку: один поиск, столько же запросов, сколько на одного', async () => {
    const before = r.reads();
    const answers = await Promise.all([1, 2, 3, 4, 5].map(() => run(ids[0]!)));
    expect(answers.map((a) => a.statusCode)).toEqual([200, 200, 200, 200, 200]);
    expect(answers.filter((a) => (a.json() as { cached: boolean }).cached === false)).toHaveLength(1);
    await finish(r, `/api/s/${ids[0]}/state`);
    const once = r.reads() - before;
    expect(once).toBeGreaterThan(0);
    // Минута после завершения: из памяти, хранилище не читается.
    r.clock.t += 60_000;
    expect((await run(ids[0]!)).json()).toEqual({ cached: true });
    await runLink(r, ids[0]!);
    expect(r.reads() - before).toBe(once);
  });

  it('больше пяти минут после завершения: поиск идёт заново', async () => {
    await runLink(r, ids[1]!);
    const before = r.reads();
    r.clock.t += 5 * 60_000 + 1;
    expect((await run(ids[1]!)).json()).toEqual({ cached: false });
    await finish(r, `/api/s/${ids[1]}/state`);
    expect(r.reads()).toBeGreaterThan(before);
  });

  it('четвёртая ссылка получает busy с временем повтора, обычный поиск идёт и не вытесняется', async () => {
    r.clock.t += 10 * 60_000;
    r.gate.close();
    const before = r.reads();
    for (const id of ids.slice(0, 3)) expect((await run(id)).statusCode).toBe(200);
    await until(() => r.reads() >= before + 3);
    const reads = r.reads();
    const fourth = await run(ids[3]!);
    expect([fourth.statusCode, fourth.json()]).toEqual([503, { error: { code: 'busy', retryAfterSeconds: 5 } }]);
    expect(fourth.headers['retry-after']).toBe('5');
    expect(r.reads()).toBe(reads);

    const normal = await r.app.inject({ method: 'POST', url: '/api/projects/pay/envs/demo/searches', headers: as('analyst'), payload: { terms: [MOCK_PERSONAL.phone], period: { preset: '24h' } } });
    expect(normal.statusCode, normal.body).toBe(200);
    const job = r.jobs.get((normal.json() as { id: string }).id);
    expect(job?.status).toBe('running');
    expect(ids.slice(0, 3).map((id) => r.pool.find(id)?.status)).toEqual(['running', 'running', 'running']);
    r.gate.open();
    await job?.done;
    for (const id of ids.slice(0, 3)) await finish(r, `/api/s/${id}/state`);
    expect((await run(ids[3]!)).statusCode).toBe(200);
    await finish(r, `/api/s/${ids[3]}/state`);
  });

  it('задание ссылки не видно обычному маршруту, идентификатор наружу не отдаётся', async () => {
    const state = await runLink(r, ids[2]!);
    expect(state.id).toBe(ids[2]);
    const jobId = r.pool.find(ids[2]!)!.id;
    expect(JSON.stringify(state)).not.toContain(jobId);
    const res = await r.app.inject({ url: `/api/searches/${jobId}`, headers: as('admin') });
    expect([res.statusCode, res.json()]).toEqual([404, { error: { code: 'search-expired' } }]);
  });

  it('все закрыли страницу: поиск останавливается за 90 секунд без опроса; кто опрашивает, тот его держит', async () => {
    r.clock.t += 10 * 60_000;
    r.gate.close();
    expect((await run(ids[4]!)).statusCode).toBe(200);
    r.clock.t += 60_000;
    r.pool.sweep();
    expect(r.pool.find(ids[4]!)!.status).toBe('running');
    // Опрос продлевает: 60 с + 60 с без остановки.
    expect((await r.app.inject(`/api/s/${ids[4]}/state`)).statusCode).toBe(200);
    r.clock.t += 60_000;
    r.pool.sweep();
    expect(r.pool.find(ids[4]!)!.status).toBe('running');
    r.clock.t += 91_000;
    r.pool.sweep();
    expect(r.pool.find(ids[4]!)!.status).toBe('cancelled');
    r.gate.open();
  });

  it('не больше десяти заданий в памяти', async () => {
    const searchId = await search(r, [MOCK_PERSONAL.cid]);
    const more: string[] = [];
    for (let i = 0; i < 12; i++) more.push((await share(r, { kind: 'results', searchId })).id);
    for (const id of more) {
      r.clock.t += 6 * 60_000;
      await runLink(r, id);
    }
    expect(r.pool.size).toBeLessThanOrEqual(10);
  });
});

describe('Ссылка на запрос', () => {
  it('несколько человек: окно читается один раз', async () => {
    const link = await share(r, { kind: 'request', project: 'pay', env: 'demo', cid: MOCK_PERSONAL.cid, fromMs: ANCHOR - 24 * 3_600_000, toMs: ANCHOR });
    const before = r.reads();
    await Promise.all([run(link.id), run(link.id), run(link.id)]);
    await finish(r, `/api/s/${link.id}/state`);
    const once = r.reads() - before;
    await run(link.id);
    const detail = await r.app.inject(`/api/s/${link.id}/requests/${MOCK_PERSONAL.cid}`);
    expect(detail.statusCode).toBe(200);
    expect(r.reads() - before).toBe(once);
  });
});

describe('Все записи на ссылке', () => {
  it('граница вне периода отклонена; пока предел занят — busy', async () => {
    const searchId = await search(r, [MOCK_PERSONAL.cid]);
    const link = await share(r, { kind: 'results', searchId });
    await runLink(r, link.id);
    expect((await r.app.inject(`/api/s/${link.id}/lines`)).statusCode).toBe(200);
    expect((await r.app.inject(`/api/s/${link.id}/lines?cursor=плохая`)).statusCode).toBe(400);
    expect(r.pool.beginRead(link.id)).toBe(true);
    const busy = await r.app.inject(`/api/s/${link.id}/lines`);
    expect(busy.json()).toMatchObject({ error: { code: 'busy' } });
    r.pool.endRead(link.id);
  });
});
