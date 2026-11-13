import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { CheckInfo, CountQuery, LinesQuery, LogBackend, LogLine, Matcher, TimeRange } from '@threadline/core/backend';
import type { MethodRow } from '@threadline/core/catalog';
import type { RequestDetail, SearchState } from '@threadline/core/search';
import { buildApp } from '../../src/app.ts';
import { MOCK_SPECIAL } from '../../src/backends/mock/dataset-pay.ts';
import { MockBackend } from '../../src/backends/mock/index.ts';
import { Backends } from '../../src/backends/registry.ts';
import { UnknownCollector } from '../../src/catalog/collector.ts';
import type { CatalogService } from '../../src/catalog/service.ts';
import * as store from '../../src/catalog/store.ts';
import { SearchJobs } from '../../src/search/jobs.ts';
import { CATALOG_YAML, service, tempConfig } from './fixture.ts';
import { freshDatabase, PG_URL } from './pg.ts';

const ANCHOR = Date.UTC(2026, 10, 2, 9, 0, 0);

class Counting implements LogBackend {
  readonly inner: MockBackend;
  calls = 0;
  constructor(inner: MockBackend) {
    this.inner = inner;
  }
  check(signal: AbortSignal): Promise<CheckInfo> {
    return this.inner.check(signal);
  }
  labelValues(label: string, scope: Matcher[], range: TimeRange, signal: AbortSignal): Promise<string[]> {
    return this.inner.labelValues(label, scope, range, signal);
  }
  queryLines(q: LinesQuery, signal: AbortSignal): Promise<LogLine[]> {
    this.calls++;
    return this.inner.queryLines(q, signal);
  }
  countBy(q: CountQuery, signal: AbortSignal): Promise<Record<string, number>> {
    this.calls++;
    return this.inner.countBy(q, signal);
  }
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

async function setup(url: string | undefined, demoInbox = false): Promise<{ app: FastifyInstance; svc: CatalogService; collector: UnknownCollector; calls: () => number }> {
  const { config } = await tempConfig({ catalog: CATALOG_YAML });
  const svc = service(config, url);
  await svc.start();
  const collector = new UnknownCollector(svc, { demoInbox });
  const adapters: Counting[] = [];
  const backends = new Backends(config, {
    createAdapter: (_id, cfg) => {
      const a = new Counting(new MockBackend(cfg as never, { anchorMs: ANCHOR }));
      adapters.push(a);
      return a;
    },
  });
  const clock = { t: ANCHOR + 1000 };
  const jobs = new SearchJobs({ now: () => clock.t, timer: false });
  const app = await buildApp({ config, backends, now: () => clock.t, jobs, catalog: svc, collector });
  closers.push(async () => {
    jobs.close();
    await app.close();
    await svc.close();
  });
  return { app, svc, collector, calls: () => adapters.reduce((n, a) => n + a.calls, 0) };
}

async function search(app: FastifyInstance, term: string): Promise<SearchState> {
  const r = await app.inject({ method: 'POST', url: '/api/projects/pay/envs/demo/searches', payload: { terms: [term], period: { preset: '6h' } } });
  expect(r.statusCode, r.body).toBe(200);
  const { id } = r.json() as { id: string };
  for (let i = 0; i < 500; i++) {
    const s = (await app.inject(`/api/searches/${id}`)).json() as SearchState;
    if (s.status !== 'running') return s;
    await new Promise((res) => setTimeout(res, 5));
  }
  throw new Error('поиск не завершился');
}

describe('без справочника', () => {
  it('ответы без разметки', async () => {
    const { app } = await setup(undefined);
    const s = await search(app, MOCK_SPECIAL.exactPan);
    expect(s.requests.length).toBeGreaterThan(0);
    for (const r of s.requests) expect(r.entry).toBeUndefined();
  });
});

describe.skipIf(!PG_URL)('разметка поиска справочником', () => {
  it('название входа, текст ошибки, система шага; правка видна без нового чтения хранилища', async () => {
    const { app, svc, calls } = await setup((await freshDatabase())!);
    const s = await search(app, MOCK_SPECIAL.exactPan);
    expect(s.requests.length).toBeGreaterThanOrEqual(2);
    const fpans = s.requests.filter((r) => r.incoming?.path === '/v1/cards/lookup');
    expect(fpans.length).toBeGreaterThanOrEqual(2);
    for (const r of fpans) expect(r.entry?.method?.name).toBe('Карты по токенам');
    // Метод входа не описан: система-автор узнана, метод — нет.
    const other = s.requests.find((r) => r.incoming?.path !== '/v1/cards/lookup')!;
    expect(other.entry).toMatchObject({ source: 'unknown', method: null, system: { key: 'pay' } });
    const failed = s.requests.find((r) => r.status === 'error')!;
    expect(failed.reasons[0]!.error?.title).toBe('Карта не найдена в процессинге');
    expect(failed.reasons[0]!.name?.system?.name).toBe('Процессинг-тест');

    const detail = (await app.inject(`/api/searches/${s.id}/requests/${failed.correlationId}`)).json() as RequestDetail;
    const send = detail.records.find((r) => r.kind === 'send')!;
    expect(send.catalog?.name?.system?.name).toBe('Процессинг-тест');
    expect(send.catalog?.name?.method?.name).toBe('Карта по токену');
    const bad = detail.records.find((r) => r.kind === 'response' && r.catalog?.error)!;
    expect(bad.catalog!.error!.title).toBe('Карта не найдена в процессинге');
    expect(bad.catalog!.error!.action).toBe('Проверить токен карты');

    const before = calls();
    const m = svc.snapshot('pay')!.methods.find((x: MethodRow) => x.name === 'Карты по токенам')!;
    const put = await app.inject({ method: 'PUT', url: `/api/projects/pay/catalog/methods/${m.id}`, payload: { systemId: m.systemId, http: m.http, path: m.path, name: 'Карты по токенам партнёра', updatedAt: m.updatedAt } });
    expect(put.statusCode, put.body).toBe(200);
    const again = (await app.inject(`/api/searches/${s.id}`)).json() as SearchState;
    for (const r of again.requests.filter((x) => x.incoming?.path === '/v1/cards/lookup')) expect(r.entry?.method?.name).toBe('Карты по токенам партнёра');
    expect(calls()).toBe(before);
  });

  it('правило итога из правки снимает ошибку ответа', async () => {
    const { app, svc } = await setup((await freshDatabase())!);
    const s = await search(app, MOCK_SPECIAL.exactPan);
    const failed = s.requests.find((r) => r.status === 'error')!;
    const processor = svc.snapshot('pay')!.systems.find((x) => x.key === 'processor')!;
    const r = await app.inject({
      method: 'POST',
      url: '/api/projects/pay/catalog/outcome-rules',
      payload: { systemId: processor.id, when: { http: 200, fields: [{ path: 'error_action', equals: 'REJECT' }] }, outcome: 'ignore' },
    });
    expect(r.statusCode, r.body).toBe(201);
    const after = ((await app.inject(`/api/searches/${s.id}`)).json() as SearchState).requests.find((x) => x.correlationId === failed.correlationId)!;
    expect(after.status).toBe('success');
    const detail = (await app.inject(`/api/searches/${s.id}/requests/${failed.correlationId}`)).json() as RequestDetail;
    const resp = detail.records.find((x) => x.kind === 'response' && x.catalog?.outcome)!;
    expect(resp.catalog!.outcome!.kind).toBe('ignore');
    expect(resp.catalog!.error!.severity).toBe('ok');
  });

  it('«Неизвестное»: демо-среда не пишет, с флагом e2e — пишет маскированный пример', async () => {
    const quiet = await setup((await freshDatabase())!);
    await search(quiet.app, MOCK_SPECIAL.exactPan);
    expect(quiet.collector.pending).toBe(0);

    const inbox = await setup((await freshDatabase())!, true);
    await search(inbox.app, MOCK_SPECIAL.exactPan);
    expect(inbox.collector.pending).toBeGreaterThan(0);
    await inbox.collector.flush();
    const rows = await store.listUnknown(inbox.svc.readDb()!, 'pay', { hidden: false, offset: 0, limit: 100 });
    expect(rows.total).toBeGreaterThan(0);
    const text = JSON.stringify(rows.rows);
    expect(text).not.toContain(MOCK_SPECIAL.exactPan);
    expect(rows.rows.some((r) => r.kind === 'host' && r.host === 'processor-balance.pay.example:8443')).toBe(true);
    // Повтор того же поиска: те же запросы счётчик не увеличивают.
    const before = rows.rows.map((r) => r.count);
    await search(inbox.app, MOCK_SPECIAL.exactPan);
    await inbox.collector.flush();
    const again = await store.listUnknown(inbox.svc.readDb()!, 'pay', { hidden: false, offset: 0, limit: 100 });
    expect(again.rows.map((r) => r.count)).toEqual(before);

    // Правка, покрывающая хост, убирает его из «Неизвестного».
    const add = await inbox.app.inject({ method: 'POST', url: '/api/projects/pay/catalog/systems', payload: { key: 'processor-balance', name: 'Балансы-тест', hosts: ['processor-balance.pay.example:8443'] } });
    expect(add.statusCode, add.body).toBe(201);
    const swept = await store.listUnknown(inbox.svc.readDb()!, 'pay', { hidden: false, offset: 0, limit: 100 });
    expect(swept.rows.some((r) => r.kind === 'host' && r.host === 'processor-balance.pay.example:8443')).toBe(false);
  });
});
