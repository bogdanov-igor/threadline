import type { RequestSummary } from '@threadline/core/search';
import { describe, expect, it } from 'vitest';
import { NO_FILTERS } from '@/features/search/result-filters.ts';
import { listIsPartial, listRows, placeInList, readListFocus, readListSteps, staleFilters } from './result-stepper.ts';

const row = (cid: string, firstMs: number, over: Partial<RequestSummary> = {}): RequestSummary => ({
  correlationId: cid,
  firstMs,
  lastMs: firstMs + 5,
  durationMs: 5,
  incoming: { method: 'GET', path: '/v1/items' },
  component: 'api',
  recordCount: 1,
  status: 'success',
  kind: 'incoming',
  reasons: [],
  match: 'exact',
  incomplete: false,
  ...over,
});

const ROWS = [row('old', 100), row('mid-err', 200, { status: 'error', component: 'worker' }), row('new', 300), row('new-err', 400, { status: 'error' })];
const VIEW = { brief: false, hasComponent: true };
const cids = (rows: readonly RequestSummary[]) => rows.map((r) => r.correlationId);
const list = (over: Partial<Parameters<typeof listRows>[1]> = {}, view = VIEW, rows = ROWS) => cids(listRows(rows, { onlyErrors: false, filters: NO_FILTERS, ...over }, view));

describe('список таким, каким его видел человек', () => {
  it('порядок: от новых к старым, как на странице результатов', () => {
    expect(list()).toEqual(['new-err', 'new', 'mid-err', 'old']);
  });

  it('«Только с ошибкой» оставляет строки с ошибкой; без них выключатель ничего не скрывает', () => {
    expect(list({ onlyErrors: true })).toEqual(['new-err', 'mid-err']);
    expect(list({ onlyErrors: true }, VIEW, [row('a', 2), row('b', 1)])).toEqual(['a', 'b']);
  });

  it('фильтры действуют вместе с «Только с ошибкой»', () => {
    expect(list({ filters: { ...NO_FILTERS, component: 'worker' } })).toEqual(['mid-err']);
    expect(list({ onlyErrors: true, filters: { ...NO_FILTERS, component: 'api' } })).toEqual(['new-err']);
  });

  it('фильтр без такого значения не скрывает строки: компонента нет в колонках режима или значение исчезло', () => {
    expect(list({ filters: { ...NO_FILTERS, component: 'worker' } }, { brief: false, hasComponent: false })).toEqual(['new-err', 'new', 'mid-err', 'old']);
    expect(list({ filters: { ...NO_FILTERS, method: 'Нет такого' } })).toEqual(['new-err', 'new', 'mid-err', 'old']);
  });
});

describe('фильтр, который отменил режим', () => {
  const state = { requests: ROWS, requestsTotal: ROWS.length };
  const worker = { ...NO_FILTERS, component: 'worker' };

  it('в «Кратко» выбор компонента забывается, как на странице результатов', () => {
    expect(staleFilters(state, worker, { brief: true, hasComponent: false })).toEqual(NO_FILTERS);
  });

  it('значение действует или фильтра нет: забывать нечего', () => {
    expect(staleFilters(state, worker, VIEW)).toBeNull();
    expect(staleFilters(state, NO_FILTERS, { brief: true, hasComponent: false })).toBeNull();
  });

  it('пока строки не дошли, сравнивать не с чем', () => {
    expect(staleFilters({ requests: ROWS, requestsTotal: ROWS.length + 1 }, worker, { brief: true, hasComponent: false })).toBeNull();
  });
});

describe('место запроса в списке', () => {
  const rows = listRows(ROWS, { onlyErrors: false, filters: NO_FILTERS }, VIEW);

  it('соседи и номер с границами самого соседа', () => {
    const place = placeInList(rows, 'new')!;
    expect(place).toMatchObject({ index: 1, total: 4 });
    expect(place.prev).toMatchObject({ correlationId: 'new-err', firstMs: 400, lastMs: 405 });
    expect(place.next).toMatchObject({ correlationId: 'mid-err', firstMs: 200, lastMs: 205 });
  });

  it('на краях соседа нет', () => {
    expect(placeInList(rows, 'new-err')!.prev).toBeNull();
    expect(placeInList(rows, 'old')!.next).toBeNull();
  });

  it('запроса нет в списке: переходить не от чего', () => {
    expect(placeInList(rows, 'other')).toBeNull();
    expect(placeInList([], 'new')).toBeNull();
  });

  it('новые строки поиска дают соседа там, где его не было', () => {
    expect(placeInList(rows, 'old')!.next).toBeNull();
    const grown = listRows([...ROWS, row('older', 50)], { onlyErrors: false, filters: NO_FILTERS }, VIEW);
    expect(placeInList(grown, 'old')).toMatchObject({ index: 3, total: 5, next: { correlationId: 'older' } });
  });
});

describe('список может быть неполным', () => {
  const ok = { status: 'done', truncated: false, error: null } as const;

  it('поиск завершён и ничего не обрезано: число точное', () => {
    expect(listIsPartial(ok)).toBe(false);
  });

  it('идёт, остановлен, упал, упёрся в предел строк: «+»', () => {
    expect(listIsPartial({ ...ok, status: 'running' })).toBe(true);
    expect(listIsPartial({ ...ok, status: 'cancelled' })).toBe(true);
    expect(listIsPartial({ ...ok, status: 'failed' })).toBe(true);
    expect(listIsPartial({ ...ok, truncated: true })).toBe(true);
    expect(listIsPartial({ ...ok, error: { code: 'internal', stage: 'fetch' } })).toBe(true);
  });
});

describe('метка в записи истории', () => {
  it('открыт не из списка', () => {
    for (const state of [null, undefined, {}, { searchId: 's' }, { resultList: {} }, { resultList: { steps: -1 } }, { resultList: { steps: 1.5 } }, { resultList: { steps: '2' } }]) expect(readListSteps(state)).toBeNull();
  });

  it('число переходов и кнопка в фокусе', () => {
    expect(readListSteps({ resultList: { steps: 0 } })).toBe(0);
    expect(readListSteps({ resultList: { steps: 3, focus: 'next' } })).toBe(3);
    expect(readListFocus({ resultList: { steps: 3, focus: 'next' } })).toBe('next');
    expect(readListFocus({ resultList: { steps: 3, focus: 'prev' } })).toBe('prev');
    expect(readListFocus({ resultList: { steps: 3 } })).toBeNull();
    expect(readListFocus({ resultList: { steps: 3, focus: 'up' } })).toBeNull();
  });
});
