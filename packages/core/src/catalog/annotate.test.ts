// Разметка сводки и записей: справочник выключен — прежний результат, «не ошибка», обрезка до 5 после справочника,
// статус операции не меняет статус запроса.
import { describe, expect, it } from 'vitest';
import { buildView, markPending, summarize, type ParsedRecord } from '../search/index.ts';
import { annotateRecords, finalizeSummary } from './annotate.ts';
import { exchange, incoming, rec, resolverFromFile, TEST_FILE } from './test-catalog.ts';

const resolver = resolverFromFile(TEST_FILE);
const T0 = Date.UTC(2026, 10, 2, 9, 0, 0);
const OPTS = { match: 'exact' as const, readEndMs: T0 + 600_000, incomplete: false };
const CID = 'c0ffee00-0000-4000-8000-000000000001';
const warn = (t: number, message: string) => rec({ kind: 'log', timeMs: t, message, level: 'WARNING', levelNum: 300 });

describe('справочник выключен', () => {
  it('сводка и записи — как без справочника', () => {
    const records = [incoming(T0, 'POST', '/v1/users'), ...exchange(T0 + 10, 'http://delta.local/pay', { status: 500, resp: { status: 'error' } })];
    const base = summarize(CID, records, OPTS);
    expect(finalizeSummary(base, records, null, OPTS)).toBe(base);
    const view = markPending(buildView(records, { withOffsets: true }), OPTS);
    expect(annotateRecords(view, null)).toEqual(view);
  });
});

describe('отметка «не ошибка»', () => {
  it('запись WARNING по правилу severity ok не делает запрос ошибочным', () => {
    const records = [incoming(T0, 'POST', '/v1/users'), warn(T0 + 5, 'Cache warmup is slow')];
    const base = summarize(CID, records, OPTS);
    expect(base.status).toBe('error');
    const final = finalizeSummary(base, records, resolver, OPTS);
    expect(final.status).toBe('success');
    expect(final.reasons).toEqual([]);
    expect(final.entry?.method?.name).toBe('Регистрация');
  });

  it('6 причин, одна «не ошибка»: после справочника остаются 5 настоящих', () => {
    const records: ParsedRecord[] = [incoming(T0, 'POST', '/v1/users'), warn(T0 + 1, 'cache warmup')];
    for (let i = 0; i < 5; i++) records.push(warn(T0 + 10 + i, `real problem ${i}`));
    const base = summarize(CID, records, OPTS);
    const final = finalizeSummary(base, records, resolver, OPTS);
    expect(final.reasons).toHaveLength(5);
    expect(final.reasons.every((r) => !r.text.toLowerCase().includes('cache warmup'))).toBe(true);
    expect(final.status).toBe('error');
  });
});

describe('статус операции', () => {
  it('статус «отказ» из колбэка не меняет статус запроса', () => {
    const records = [incoming(T0, 'POST', '/internal/callbacks/payout', { ext_transfer_id: 'tr-1', state: 'error' })];
    const base = summarize(CID, records, OPTS);
    const final = finalizeSummary(base, records, resolver, OPTS);
    expect(final.status).toBe(base.status);
    const view = annotateRecords(markPending(buildView(records, { withOffsets: true }), OPTS), resolver);
    const inc = view.find((v) => v.kind === 'incoming')!;
    expect(inc.catalog?.status).toMatchObject({ type: 'transfer', value: 'failed', raw: 'error', outcome: 'failure' });
    expect(inc.catalog?.ids).toContainEqual(expect.objectContaining({ type: 'transfer', value: 'tr-1', at: 'request' }));
  });
});

describe('обращение к базе по подсказке профиля', () => {
  const db = (t: number, host: string | null) =>
    rec({ kind: 'log', timeMs: t, message: 'db query', level: 'INFO', levelNum: 200, flow: { as: 'db', durationMs: 21, host, title: null } });
  const file = (systems: unknown[]) => ({ ...TEST_FILE, systems: [...(TEST_FILE.systems as unknown[]), ...systems] });
  const base = { kind: 'external', type: 'database' } as const;
  const named = (r: ReturnType<typeof resolverFromFile>, host: string | null) => {
    const records = [incoming(T0, 'POST', '/v1/users'), db(T0 + 5, host)];
    const view = annotateRecords(markPending(buildView(records, { withOffsets: true }), OPTS), r);
    return view.find((v) => v.kind === 'log')!.catalog?.name ?? null;
  };

  it('одна база проекта: запись db query подписана её именем', () => {
    // В TEST_FILE одна система вида «база» — PostgreSQL Demo Pay, без хостов.
    expect(named(resolver, null)?.system?.name).toBe('PostgreSQL Demo Pay');
    expect(named(resolver, 'pg-other.pay.example')?.system?.name).toBe('PostgreSQL Demo Pay');
  });

  it('две базы: без хоста система неизвестна, по хосту — та, чей хост', () => {
    const r = resolverFromFile(file([{ ...base, key: 'pg-cards', name: 'База карт', hosts: ['pg-cards.pay.example:5432'] }]));
    expect(named(r, null)).toMatchObject({ source: 'unknown', system: null });
    expect(named(r, 'pg-cards.pay.example:5432')?.system?.name).toBe('База карт');
  });

  it('без справочника и без подсказки разметки нет', () => {
    const records = [incoming(T0, 'POST', '/v1/users'), db(T0 + 5, null)];
    const view = markPending(buildView(records, { withOffsets: true }), OPTS);
    expect(annotateRecords(view, null)).toEqual(view);
    const plain = [incoming(T0, 'POST', '/v1/users'), rec({ kind: 'log', timeMs: T0 + 5, message: 'cache hit', level: 'INFO', levelNum: 200 })];
    expect(annotateRecords(markPending(buildView(plain, { withOffsets: true }), OPTS), resolver).find((v) => v.kind === 'log')!.catalog).toBeUndefined();
  });
});
