// Ссылка на поиск по нескольким средам: все среды в target, поиск заново по ним, запрос и записи по ?env=.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SearchCreated, SearchState } from '@threadline/core/search';
import { MOCK_PERSONAL } from '../../src/backends/mock/dataset-pay.ts';
import { insertLink } from '../../src/share/store.ts';
import { ANCHOR, as, DAY, finish, info, runLink, share, shareRig, type ShareRig } from './harness.ts';

const CID = MOCK_PERSONAL.cid;
let r: ShareRig;
let seq = 0;
const rows = (id: string) => r.catalog.db().query<Record<string, unknown>>('select * from share_link where id = $1', [id]);

/** Поиск по нескольким средам до конца: id задания. */
async function searchMulti(envs: string[], owner = 'multi'): Promise<string> {
  const res = await r.app.inject({ method: 'POST', url: '/api/projects/pay/searches', headers: as('analyst', owner), payload: { envs, terms: [CID], period: { preset: '24h' } } });
  if (res.statusCode !== 200) throw new Error(res.body);
  const { id } = res.json() as SearchCreated;
  await finish(r, `/api/searches/${id}`, as('analyst', owner));
  return id;
}

const direct = async (target: unknown): Promise<string> => {
  const id = `m${String(seq++).padStart(3, '0')}${'y'.repeat(18)}`;
  await insertLink(r.catalog.db(), { id, kind: 'results', projectId: 'pay', envId: 'demo', stand: null, terms: [CID], fromMs: ANCHOR - DAY, toMs: ANCHOR, target, createdMs: r.clock.t, expiresMs: r.clock.t + 30 * DAY });
  return id;
};

beforeAll(async () => {
  r = await shareRig();
}, 60_000);

afterAll(async () => {
  await r.close();
});

describe('Ссылка на несколько сред', () => {
  it('в базе все среды и пустой список исключений, браузер присылает только id задания', async () => {
    const searchId = await searchMulti(['broken', 'demo']);
    const link = await share(r, { kind: 'results', searchId }, as('analyst', 'multi'));
    const [row] = await rows(link.id);
    expect(row).toMatchObject({ kind: 'results', env_id: 'demo', stand: null, terms: [CID], target: { envs: ['demo', 'broken'], excludes: [] } });
  });

  it('открытие: все среды названы, поиск по обеим, метки сред и ошибка части без подробностей', async () => {
    const searchId = await searchMulti(['demo', 'broken'], 'second');
    const link = await share(r, { kind: 'results', searchId }, as('analyst', 'second'));
    const d = await info(r, link.id);
    expect(d.env.id).toBe('demo');
    expect(d.envs?.map((e) => [e.id, e.name])).toEqual([
      ['demo', 'Демо'],
      ['broken', 'Сбой'],
    ]);
    expect(d.envsDropped).toBeUndefined();
    const s = await runLink(r, link.id);
    expect(s.requests.map((x) => [x.env, x.correlationId])).toEqual([['demo', CID]]);
    const broken = s.envs!.find((p) => p.env === 'broken')!;
    expect(broken.error).toEqual({ code: 'timeout', stage: 'count' });
    expect(JSON.stringify(s)).not.toContain('"explore"');

    const ok = await r.app.inject(`/api/s/${link.id}/requests/${CID}?env=demo`);
    expect(ok.statusCode, ok.body).toBe(200);
    for (const url of [`/api/s/${link.id}/requests/${CID}`, `/api/s/${link.id}/requests/${CID}?env=prod`]) {
      const res = await r.app.inject(url);
      expect([res.statusCode, res.json().error.code], url).toEqual([404, 'share-not-found']);
    }
    expect((await r.app.inject(`/api/s/${link.id}/lines?env=demo`)).statusCode).toBe(200);
    expect((await r.app.inject(`/api/s/${link.id}/lines`)).statusCode).toBe(400);
  });

  it('одну среду убрали: поиск по оставшимся, страница знает о пропуске', async () => {
    const id = await direct({ envs: ['demo', 'broken', 'gone'], excludes: [] });
    const d = await info(r, id);
    expect(d.envs?.map((e) => e.id)).toEqual(['demo', 'broken']);
    expect(d.envsDropped).toBe(true);
  });

  it('осталась одна среда: ссылка этой среды, пометка о пропуске', async () => {
    const id = await direct({ envs: ['gone', 'demo'], excludes: [] });
    const d = await info(r, id);
    expect(d.env.id).toBe('demo');
    expect(d.envs).toBeUndefined();
    expect(d.envsDropped).toBe(true);
    const s: SearchState = await runLink(r, id);
    expect(s.envs).toBeUndefined();
    expect(s.requestsTotal).toBe(1);
  });

  it('все среды убрали: «такой среды больше нет», к хранилищу запросов нет', async () => {
    const id = await direct({ envs: ['gone', 'lost'], excludes: [] });
    const before = r.reads();
    const res = await r.app.inject(`/api/s/${id}`);
    expect([res.statusCode, res.json().error.code]).toEqual([404, 'unknown-environment']);
    expect(r.reads()).toBe(before);
  });

  it('ненастроенная среда: часть с ошибкой без имён переменных, остальные ищутся', async () => {
    const id = await direct({ envs: ['demo', 'prod'], excludes: [] });
    const s = await runLink(r, id);
    const prod = s.envs!.find((p) => p.env === 'prod')!;
    expect(prod.error).toEqual({ code: 'not-configured', stage: 'count' });
    expect(JSON.stringify(s)).not.toContain('THREADLINE_');
    expect(s.requests.map((x) => x.env)).toEqual(['demo']);
  });

  it('битый список сред: ссылка устарела', async () => {
    for (const target of [{ envs: ['demo'], excludes: [] }, { envs: ['demo', 'demo'], excludes: [] }, { envs: 'demo,broken', excludes: [] }]) {
      const id = await direct(target);
      const res = await r.app.inject(`/api/s/${id}`);
      expect([res.statusCode, res.json().error.code], JSON.stringify(target)).toEqual([410, 'share-outdated']);
    }
  });
});
