import type { ErrorReason, RequestSummary } from '@threadline/core/search';
import { describe, expect, it } from 'vitest';
import { activeFilters, applyFilters, filterOptions, NO_FILTERS, NO_VALUE, rowFacets } from './result-filters.ts';

const row = (cid: string, over: Partial<RequestSummary> = {}): RequestSummary => ({
  correlationId: cid,
  firstMs: 1,
  lastMs: 2,
  durationMs: 1,
  incoming: { method: 'GET', path: '/v1/items/5a1d0100-e29b-41d4-a716-446655440000' },
  component: 'api',
  recordCount: 1,
  status: 'success',
  kind: 'incoming',
  reasons: [],
  match: 'exact',
  incomplete: false,
  ...over,
});

const entry = (method: string, system: string): NonNullable<RequestSummary['entry']> => ({ source: 'project', system: { key: system, name: system, type: 'service' }, method: { id: 1, name: method, domain: null, kind: 'call', opType: null }, host: null });
const reason = (system: string): ErrorReason => ({ kind: 'business', text: `Ошибка · POST ${system}/v1/x` });

const ROWS = [
  row('a', { entry: entry('Списание', 'Demo Pay'), component: 'api' }),
  row('b', { entry: entry('Списание', 'Demo Pay'), component: 'worker', status: 'error', reasons: [reason('switch.pay.example:9191')] }),
  row('c', { component: null, incoming: null }),
];
const options = (rows = ROWS, brief = false, hasComponent = true) => filterOptions(rowFacets(rows, brief), hasComponent);
const cids = (rows: readonly RequestSummary[]) => rows.map((r) => r.correlationId);

describe('значения фильтров', () => {
  it('метод: название, иначе шаблон пути без значений; без входа — отдельное значение последним', () => {
    const o = options([...ROWS, row('d')]);
    expect(o.method[0]).toBe('/v1/items/{item}');
    expect(o.method).toContain('Списание');
    expect(o.method.at(-1)).toBe(NO_VALUE);
    expect(JSON.stringify(o.method)).not.toContain('5a1d0100');
  });

  it('система: система входа и системы причин', () => {
    expect(options().system).toEqual(expect.arrayContaining(['Demo Pay', NO_VALUE]));
    expect(options().system.some((s) => s.includes('switch'))).toBe(true);
  });

  it('в «Кратко» в значениях системы нет адреса', () => {
    const o = options([row('x', { status: 'error', reasons: [reason('switch.pay.example:8443')] })], true);
    expect(JSON.stringify(o.system)).not.toContain('switch.pay.example');
  });

  it('компонента нет там, где нет его колонки', () => {
    expect(options().component).toEqual(['api', 'worker', NO_VALUE]);
    expect(options(ROWS, true, false).component).toEqual([]);
  });

  it('причина «ожидание ответа» систему не добавляет', () => {
    const o = options([row('x', { reasons: [{ kind: 'pending', text: 'x · POST pending.example/v1' }] })]);
    expect(JSON.stringify(o.system)).not.toContain('pending');
  });
});

describe('применение', () => {
  const facets = rowFacets(ROWS, false);

  it('без фильтра все строки', () => {
    expect(cids(applyFilters(ROWS, facets, NO_FILTERS))).toEqual(['a', 'b', 'c']);
  });

  it('метод, компонент и их сочетание', () => {
    expect(cids(applyFilters(ROWS, facets, { ...NO_FILTERS, method: 'Списание' }))).toEqual(['a', 'b']);
    expect(cids(applyFilters(ROWS, facets, { ...NO_FILTERS, method: 'Списание', component: 'worker' }))).toEqual(['b']);
  });

  it('строка подходит по любой своей системе', () => {
    const sw = options().system.find((s) => s.includes('switch'))!;
    expect(cids(applyFilters(ROWS, facets, { ...NO_FILTERS, system: sw }))).toEqual(['b']);
    expect(cids(applyFilters(ROWS, facets, { ...NO_FILTERS, system: 'Demo Pay' }))).toEqual(['a', 'b']);
  });

  it('значение «без значения»', () => {
    expect(cids(applyFilters(ROWS, facets, { ...NO_FILTERS, component: NO_VALUE }))).toEqual(['c']);
    expect(cids(applyFilters(ROWS, facets, { ...NO_FILTERS, method: NO_VALUE }))).toEqual(['c']);
  });

  it('ничего не подошло: пусто, без исключения', () => {
    expect(applyFilters(ROWS, facets, { ...NO_FILTERS, method: 'нет такого' })).toEqual([]);
  });
});

describe('действующий выбор', () => {
  it('значения нет среди значений фильтра: выбор не действует', () => {
    expect(activeFilters({ ...NO_FILTERS, component: 'api' }, options(ROWS, true, false))).toEqual(NO_FILTERS);
    expect(activeFilters({ ...NO_FILTERS, system: 'host.example' }, options())).toEqual(NO_FILTERS);
  });

  it('значение есть: выбор на месте', () => {
    expect(activeFilters({ ...NO_FILTERS, component: 'api' }, options()).component).toBe('api');
  });
});
