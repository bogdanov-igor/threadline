// Точка уведомления о новой неизвестной ошибке. На PGlite.

import { afterEach, describe, expect, it } from 'vitest';
import type { ParsedRecord } from '@threadline/core/search';
import { UnknownCollector } from '../../src/catalog/collector.ts';
import type { Db } from '../../src/catalog/db.ts';
import { NO_NOTIFIER, type UnknownErrorFact, type UnknownErrorNotifier } from '../../src/catalog/notifier.ts';
import type { CatalogService } from '../../src/catalog/service.ts';
import * as store from '../../src/catalog/store.ts';
import { exchange, rec } from '../../../../packages/core/src/catalog/test-catalog.ts';
import { CATALOG_YAML, service, tempConfig } from './fixture.ts';

const T0 = Date.UTC(2026, 10, 2, 9, 0, 0);
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

async function ready(): Promise<CatalogService> {
  const { config } = await tempConfig({ catalog: CATALOG_YAML });
  const s = service(config, 'pglite://memory');
  closers.push(() => s.close());
  await s.start();
  return s;
}

const withCid = (cid: string, list: ParsedRecord[]) => list.map((r) => ({ ...r, correlationId: cid }));
const errorRecords = (cid: string, message = 'broken') => withCid(cid, exchange(T0, 'https://processor.pay.example:8443/pay', { status: 200, resp: { status: 'error', error: { code: 77, message } } }));
const spy = () => {
  const seen: UnknownErrorFact[] = [];
  const notifier: UnknownErrorNotifier = { unknownError: (f) => void seen.push(f) };
  return { seen, notifier };
};

describe('точка уведомления', () => {
  it('новая ошибка: один вызов с данными строки; та же ошибка снова и после «Скрыть» — вызова нет', async () => {
    const s = await ready();
    const { seen, notifier } = spy();
    const c = new UnknownCollector(s, { notifier });
    c.observe('pay', 'demo', false, 'cid-1', errorRecords('cid-1'), '77');
    await c.flush();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ project: 'pay', env: 'demo', stand: '77', methodId: null, httpStatus: 200, code: '77', text: 'broken', exampleCid: 'cid-1', exampleMs: T0 });
    expect(typeof seen[0]!.systemId).toBe('number');

    c.observe('pay', 'demo', false, 'cid-2', errorRecords('cid-2'));
    await c.flush();
    expect(seen).toHaveLength(1);
    const rows = (await store.listUnknown(s.readDb()!, 'pay', { kind: 'error', hidden: false, offset: 0, limit: 10 })).rows;
    expect(rows.map((r) => r.count)).toEqual([2]);
    await store.setUnknownHidden(s.readDb()!, 'pay', rows[0]!.id, true);
    c.observe('pay', 'demo', false, 'cid-3', errorRecords('cid-3'));
    await c.flush();
    expect(seen).toHaveLength(1);
  });

  it('неизвестный метод или хост: вызова нет', async () => {
    const s = await ready();
    const { seen, notifier } = spy();
    const c = new UnknownCollector(s, { notifier });
    c.observe('pay', 'demo', false, 'cid-1', withCid('cid-1', exchange(T0, 'http://new.partner.example/plain', { resp: {} })));
    await c.flush();
    const rows = (await store.listUnknown(s.readDb()!, 'pay', { hidden: false, offset: 0, limit: 10 })).rows;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.kind === 'error')).toBe(false);
    expect(seen).toEqual([]);
  });

  it('две копии записывают одну ошибку: вызов один, у той, чья запись была первой', async () => {
    const s = await ready();
    const a = spy();
    const b = spy();
    const c1 = new UnknownCollector(s, { notifier: a.notifier });
    const c2 = new UnknownCollector(s, { notifier: b.notifier });
    c1.observe('pay', 'demo', false, 'cid-1', errorRecords('cid-1'));
    c2.observe('pay', 'demo', false, 'cid-2', errorRecords('cid-2'));
    await Promise.all([c1.flush(), c2.flush()]);
    expect(a.seen.length + b.seen.length).toBe(1);
  });

  it('запись не удалась: вызова нет, он будет после успешной записи', async () => {
    const s = await ready();
    const { seen, notifier } = spy();
    let broken = true;
    const real = s.readDb()!;
    const flaky = { query: (sql: string, params?: unknown[]) => (broken ? Promise.reject(new Error('нет соединения')) : real.query(sql, params)) } as unknown as Db;
    const stub = { enabled: true, state: () => s.state(), readDb: () => flaky, resolver: (p: string) => s.resolver(p) } as unknown as CatalogService;
    const c = new UnknownCollector(stub, { notifier });
    c.observe('pay', 'demo', false, 'cid-1', errorRecords('cid-1'));
    await c.flush();
    expect(seen).toEqual([]);
    expect(c.pending).toBeGreaterThan(0);
    broken = false;
    await c.flush();
    expect(seen).toHaveLength(1);
    expect(c.pending).toBe(0);
  });

  it('вид «Телефон» выключен: в данных уведомления маска, как в самой строке', async () => {
    const s = await ready();
    await s.edit('pay', async (q) => {
      const row = (await store.getMasking(q, 'pay', 'phone'))!;
      await store.writeMasking(q, 'pay', 'phone', false, row.keys, true);
    });
    const { seen, notifier } = spy();
    const c = new UnknownCollector(s, { notifier });
    c.observe('pay', 'demo', false, 'cid-1', errorRecords('cid-1', 'звонить +447700900001 сейчас'));
    await c.flush();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.text).not.toContain('447700900001');
    const [row] = (await store.listUnknown(s.readDb()!, 'pay', { kind: 'error', hidden: false, offset: 0, limit: 10 })).rows;
    expect(row!.text).toBe(seen[0]!.text);
  });

  it('уведомление бросило исключение или вернуло отказ: строка записана, в журнале только тип ошибки, повтора нет', async () => {
    const s = await ready();
    const warn: string[] = [];
    let calls = 0;
    const thrower: UnknownErrorNotifier = {
      unknownError() {
        calls++;
        throw new RangeError('секретный текст 447700900001');
      },
    };
    const c = new UnknownCollector(s, { notifier: thrower, warn: (m) => warn.push(m) });
    c.observe('pay', 'demo', false, 'cid-1', errorRecords('cid-1'));
    await c.flush();
    expect(calls).toBe(1);
    expect(c.pending).toBe(0);
    expect((await store.listUnknown(s.readDb()!, 'pay', { kind: 'error', hidden: false, offset: 0, limit: 10 })).total).toBe(1);
    expect(warn.join()).toContain('RangeError');
    expect(warn.join()).not.toContain('секретный');
    await c.flush();
    expect(calls).toBe(1);

    const rejected: string[] = [];
    const asyncFail = { unknownError: () => Promise.reject(new TypeError('x')) } as unknown as UnknownErrorNotifier;
    const c2 = new UnknownCollector(s, { notifier: asyncFail, warn: (m) => rejected.push(m) });
    c2.observe('pay', 'demo', false, 'cid-2', errorRecords('cid-2', 'другая ошибка'));
    await c2.flush();
    await Promise.resolve();
    expect(rejected.join()).toContain('TypeError');
  });

  it('по умолчанию уведомление ничего не делает, поведение «Неизвестного» прежнее', async () => {
    expect(() => NO_NOTIFIER.unknownError({} as UnknownErrorFact)).not.toThrow();
    const s = await ready();
    const c = new UnknownCollector(s);
    c.observe('pay', 'demo', false, 'cid-1', [...errorRecords('cid-1'), rec({ kind: 'log', timeMs: T0, level: 'INFO', correlationId: 'cid-1' })]);
    await c.flush();
    expect((await store.listUnknown(s.readDb()!, 'pay', { kind: 'error', hidden: false, offset: 0, limit: 10 })).total).toBe(1);
  });

  it('справочник выключен: «Неизвестного» и уведомлений нет', async () => {
    const { config } = await tempConfig();
    const off = service(config, undefined);
    const { seen, notifier } = spy();
    const c = new UnknownCollector(off, { notifier });
    c.observe('pay', 'demo', false, 'cid-1', errorRecords('cid-1'));
    await c.flush();
    expect(c.pending).toBe(0);
    expect(seen).toEqual([]);
  });
});
