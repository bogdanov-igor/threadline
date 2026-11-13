// Поиск по нескольким средам в интерфейсе: адрес, ключ строки, порядок, фильтры, «N из M» и сообщения сред.
import type { ProjectsResponse } from '@threadline/core';
import type { EnvSearchPart, RequestSummary, SearchState } from '@threadline/core/search';
import { describe, expect, it } from 'vitest';
import { listRows, placeInList } from '@/features/request/result-stepper.ts';
import { envSetName, envsPath, resolveSelection, selectionPath } from '@/lib/selection.ts';
import { multiNoticesOf, newestFirst, partState } from './model.ts';
import { applyFilters, rowFacets } from './result-filters.ts';

const env = (id: string, name: string, kind: 'plain' | 'pr-stands' = 'plain') => ({ id, name, kind, notConfigured: false });
const DATA = {
  defaults: { project: 'pay', environment: 'demo' },
  hidden: [],
  incomplete: false,
  projects: [{ id: 'pay', name: 'Demo Pay', timezone: 'Asia/Karachi', retentionDays: 30, environments: [env('prod', 'Прод'), env('demo', 'Демо'), env('test', 'Тест'), env('pr', 'Стенды PR', 'pr-stands')] }],
} as unknown as ProjectsResponse;

describe('набор сред в адресе', () => {
  it('одна среда — прежний выбор, без envs', () => {
    const s = resolveSelection(DATA, { project: 'pay', env: 'prod' })!;
    expect(s.env.id).toBe('prod');
    expect(s.envs).toBeUndefined();
    expect(selectionPath(s)).toBe('/pay/prod');
  });

  it('несколько сред в любом порядке — в порядке проекта, первая — env', () => {
    const s = resolveSelection(DATA, { project: 'pay', env: 'test,prod' })!;
    expect(s.envs?.map((e) => e.id)).toEqual(['prod', 'test']);
    expect(s.env.id).toBe('prod');
    expect(envSetName(s)).toBe('Прод + Тест');
    expect(selectionPath(s)).toBe('/pay/prod,test');
  });

  it('повтор склеивается в одну среду', () => {
    expect(resolveSelection(DATA, { project: 'pay', env: 'prod,prod' })?.envs).toBeUndefined();
  });

  it.each([
    ['неизвестная среда', { env: 'prod,nope' }],
    ['стенды', { env: 'prod,pr' }],
    ['стенды с номером', { env: 'prod,pr', stand: '12' }],
    ['пустой элемент', { env: 'prod,' }],
    ['больше пяти', { env: 'a,b,c,d,e,f' }],
    ['адрес запроса', { env: 'prod,test', cid: 'abc' }],
    ['адрес операции', { env: 'prod,test', type: 'transfer' }],
  ])('%s — такой среды нет', (_name, params) => {
    expect(resolveSelection(DATA, { project: 'pay', ...params })).toBeNull();
  });

  it('адрес набора и одной среды', () => {
    expect(envsPath('pay', ['prod'])).toBe('/pay/prod');
    expect(envsPath('pay', ['prod', 'test'])).toBe('/pay/prod,test');
  });
});

const row = (cid: string, envId: string | undefined, over: Partial<RequestSummary> = {}): RequestSummary => ({
  correlationId: cid,
  firstMs: 100,
  lastMs: 200,
  durationMs: 100,
  incoming: { method: 'GET', path: '/v1/accounts' },
  component: 'api',
  recordCount: 1,
  status: 'success',
  kind: 'incoming',
  reasons: [],
  match: 'exact',
  incomplete: false,
  ...(envId ? { env: envId } : {}),
  ...over,
});

describe('строки разных сред не склеиваются', () => {
  const rows = [row('abc', 'test', { status: 'error', component: 'worker' }), row('abc', 'prod'), row('new', 'test', { firstMs: 500 })];

  it('порядок: от новых к старым, при равном времени — по средам поиска', () => {
    expect(newestFirst(rows, ['prod', 'test']).map((r) => `${r.env}/${r.correlationId}`)).toEqual(['test/new', 'prod/abc', 'test/abc']);
  });

  it('фильтр по компоненту видит строки сред отдельно', () => {
    const facets = rowFacets(rows, false);
    expect(facets.size).toBe(3);
    expect(applyFilters(rows, facets, { method: null, system: null, component: 'worker' }).map((r) => r.env)).toEqual(['test']);
  });

  it('«N из M» ищет строку по ключу со средой', () => {
    const list = listRows(rows, { onlyErrors: false, filters: { method: null, system: null, component: null } }, { brief: false, hasComponent: true }, ['prod', 'test']);
    expect(placeInList(list, 'test/abc')).toMatchObject({ index: 2, total: 3, prev: { env: 'prod' }, next: null });
    expect(placeInList(list, 'prod/abc')).toMatchObject({ index: 1 });
    expect(placeInList(list, 'abc')).toBeNull();
  });
});

const part = (envId: string, over: Partial<EnvSearchPart> = {}): EnvSearchPart => ({
  env: envId,
  status: 'done',
  stage: 'done',
  found: 0,
  tooMany: false,
  truncated: false,
  scannedFromMs: null,
  lines: 'none',
  progress: { chunksDone: 6, chunksTotal: 6, batchesDone: 0, batchesTotal: 0 },
  requestsTotal: 0,
  error: null,
  ...over,
});

const state = (envs: EnvSearchPart[], over: Partial<SearchState> = {}): SearchState => ({
  id: 'g',
  status: 'done',
  stage: 'done',
  period: { fromMs: 0, toMs: 6 * 3_600_000, preset: '6h' },
  terms: [{ display: 'abcdef', kind: 'text' }],
  found: 0,
  tooMany: false,
  truncated: false,
  scannedFromMs: null,
  lines: 'none',
  progress: { chunksDone: 12, chunksTotal: 12, batchesDone: 0, batchesTotal: 0 },
  requests: [],
  requestsTotal: envs.reduce((n, p) => n + p.requestsTotal, 0),
  error: null,
  envs,
  ...over,
});

describe('сообщения сред', () => {
  it('тайм-аут одной среды: сообщение этой среды, «ничего не нашлось» нет', () => {
    const n = multiNoticesOf(state([part('prod'), part('test', { status: 'failed', error: { code: 'timeout', stage: 'count' } })]));
    expect(n.group).toEqual([]);
    expect(n.parts.map((p) => [p.part.env, p.notices])).toEqual([
      ['prod', []],
      ['test', ['error']],
    ]);
  });

  it('пусто везде — обычное «ничего не нашлось»; строки без correlation_id в одной — их сообщение', () => {
    expect(multiNoticesOf(state([part('prod'), part('test')])).group).toEqual(['empty']);
    expect(multiNoticesOf(state([part('prod'), part('test', { lines: 'some' })], { lines: 'some' })).group).toEqual(['only-lines']);
  });

  it('предел запросов и строк — у своей среды', () => {
    const n = multiNoticesOf(state([part('prod', { tooMany: true, found: 350 }), part('test', { requestsTotal: 2, truncated: true })]));
    expect(n.group).toEqual([]);
    expect(n.parts.map((p) => p.notices)).toEqual([['too-many'], ['truncated']]);
  });

  it('не удалось ни в одной: общая ошибка и сообщения сред', () => {
    const err = { code: 'network', stage: 'count' as const };
    const n = multiNoticesOf(state([part('prod', { status: 'failed', error: err }), part('test', { status: 'failed', error: err })], { status: 'failed', error: err }));
    expect(n.group).toEqual(['error']);
    expect(n.parts.every((p) => p.notices.includes('error'))).toBe(true);
  });

  it('остановка — общее сообщение', () => {
    expect(multiNoticesOf(state([part('prod', { status: 'cancelled' })], { status: 'cancelled' })).group).toEqual(['cancelled']);
  });

  it('состояние части читается как поиск одной среды', () => {
    const s = partState(state([part('prod', { requestsTotal: 3, scannedFromMs: 5 })]), part('prod', { requestsTotal: 3, scannedFromMs: 5 }));
    expect(s.requestsTotal).toBe(3);
    expect(s.scannedFromMs).toBe(5);
    expect(s.envs).toBeUndefined();
  });

  it('предел памяти среды доходит до её сообщения', () => {
    const p = part('test', { truncated: true, truncatedBy: 'memory' });
    expect(partState(state([p]), p).truncatedBy).toBe('memory');
    expect(partState(state([part('prod')]), part('prod')).truncatedBy).toBeUndefined();
  });
});
