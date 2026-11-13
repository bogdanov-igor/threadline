import { afterEach, describe, expect, it } from 'vitest';
import type { UnknownItem } from '@threadline/core/catalog';
import { UnknownCollector, UNKNOWN_LIMITS } from '../../src/catalog/collector.ts';
import type { CatalogService } from '../../src/catalog/service.ts';
import * as store from '../../src/catalog/store.ts';
import { generatePayDataset } from '../../src/backends/mock/dataset-pay.ts';
import { parseLine } from '@threadline/core/search';
import { service, tempConfig } from './fixture.ts';
import { freshDatabase, PG_URL } from './pg.ts';

const records = generatePayDataset(Date.UTC(2026, 10, 2, 9, 0, 0)).records.map((r) => parseLine({ tsNs: String(r.tsNs), line: r.line, labels: r.labels }));

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

async function ready(): Promise<CatalogService> {
  const { config } = await tempConfig();
  const s = service(config, (await freshDatabase())!);
  closers.push(() => s.close());
  await s.start();
  return s;
}

const item = (key: string): UnknownItem => ({ key, kind: 'host', systemId: null, methodId: null, httpMethod: 'GET', path: '/x', rpc: '', host: `${key}.pay.example`, httpStatus: null, code: null, text: null });
const agg = (key: string, lastSeen: number): store.UnknownAggregate => ({ project: 'pay', item: item(key), count: 1, env: 'demo', stand: null, exampleCid: `c-${key}`, exampleMs: lastSeen, firstSeen: lastSeen, lastSeen });

describe.skipIf(!PG_URL)('«Неизвестное» в базе', () => {
  it('повтор ключа складывает счётчик, скрытая строка остаётся скрытой', async () => {
    const s = await ready();
    const db = s.readDb()!;
    await store.upsertUnknown(db, [agg('a', 1000)]);
    const [row] = (await store.listUnknown(db, 'pay', { hidden: false, offset: 0, limit: 10 })).rows;
    await store.setUnknownHidden(db, 'pay', row!.id, true);
    await store.upsertUnknown(db, [{ ...agg('a', 2000), count: 3 }]);
    const hidden = (await store.listUnknown(db, 'pay', { hidden: true, offset: 0, limit: 10 })).rows;
    expect(hidden.map((r) => [r.count, r.exampleCid])).toEqual([[4, 'c-a']]);
  });

  it('обрезка до предела убирает строки с самым давним last_seen', async () => {
    const s = await ready();
    const db = s.readDb()!;
    await store.upsertUnknown(db, [agg('old', 1000), agg('mid', 2000), agg('new', 3000)]);
    expect(await store.trimUnknown(db, 2)).toBe(1);
    const left = (await store.listUnknown(db, 'pay', { hidden: false, offset: 0, limit: 10 })).rows.map((r) => r.host);
    expect(left.sort()).toEqual(['mid.pay.example', 'new.pay.example']);
  });

  it('сбор: LRU по запросу, сброс одним запросом, при ошибке базы агрегат остаётся в памяти', async () => {
    const s = await ready();
    const c = new UnknownCollector(s);
    const cid = records[0]!.correlationId!;
    const own = records.filter((r) => r.correlationId === cid);
    c.observe('pay', 'demo', false, cid, own);
    const first = c.pending;
    expect(first).toBeGreaterThan(0);
    // Тот же запрос второй раз счётчик не растит.
    c.observe('pay', 'demo', false, cid, own);
    await c.flush();
    expect(c.pending).toBe(0);
    const rows = (await store.listUnknown(s.readDb()!, 'pay', { hidden: false, offset: 0, limit: 100 })).rows;
    expect(rows).toHaveLength(first);
    expect(rows.every((r) => r.count === 1)).toBe(true);
    // Имитация пишет только с флагом e2e.
    c.observe('pay', 'demo', true, 'other', own);
    expect(c.pending).toBe(0);

    const other = records.find((r) => r.correlationId && r.correlationId !== cid)!.correlationId!;
    c.observe('pay', 'demo', false, other, records.filter((r) => r.correlationId === other));
    const pending = c.pending;
    expect(pending).toBeGreaterThan(0);
    await s.readDb()!.close();
    await c.flush();
    expect(c.pending).toBe(pending);
    expect(UNKNOWN_LIMITS.aggregate).toBe(1000);
  });

  it('забытый проект: отложенные строки отброшены, другой проект сбрасывается, тот же запрос считается заново', async () => {
    const s = await ready();
    const c = new UnknownCollector(s);
    const cid = records[0]!.correlationId!;
    const own = records.filter((r) => r.correlationId === cid);
    c.observe('pay', 'demo', false, cid, own);
    const pending = c.pending;
    c.forget('other');
    expect(c.pending).toBe(pending);
    c.forget('pay');
    expect(c.pending).toBe(0);
    await c.flush();
    expect((await store.listUnknown(s.readDb()!, 'pay', { hidden: false, offset: 0, limit: 100 })).rows).toEqual([]);
    c.observe('pay', 'demo', false, cid, own);
    expect(c.pending).toBe(pending);
    await c.flush();
    expect((await store.listUnknown(s.readDb()!, 'pay', { hidden: false, offset: 0, limit: 100 })).rows).toHaveLength(pending);
  });

  it('неудачный сброс не возвращает строки проекта, забытого за это время', async () => {
    const s = await ready();
    const c = new UnknownCollector(s);
    const cid = records[0]!.correlationId!;
    c.observe('pay', 'demo', false, cid, records.filter((r) => r.correlationId === cid));
    await s.readDb()!.close();
    const flushing = c.flush();
    c.forget('pay');
    await flushing;
    expect(c.pending).toBe(0);
  });

  it('пакет со строкой проекта, удалённого другой копией, отбрасывает только её', async () => {
    const s = await ready();
    const db = s.readDb()!;
    await store.upsertUnknown(db, [agg('a', 1000), { ...agg('b', 1000), project: 'gone' }]);
    expect((await store.listUnknown(db, 'pay', { hidden: false, offset: 0, limit: 10 })).rows.map((r) => r.host)).toEqual(['a.pay.example']);
    expect(await db.query(`select 1 from catalog_unknown where project_id = 'gone'`)).toEqual([]);
  });
});
