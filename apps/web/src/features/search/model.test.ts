import { setRegional, type RequestSummary, type SearchState } from '@threadline/core/search';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addTerms,
  aroundBounds,
  checkAround,
  checkChips,
  checkExcludes,
  checkCustomPeriod,
  checkPeriodFields,
  chipsFromState,
  errorCount,
  mergeSearchState,
  newestFirst,
  noticesOf,
  periodBody,
  periodFromState,
  progressOf,
  splitTerms,
  type TermChip,
} from './model.ts';

const H = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 2, 10, 0);

function req(cid: string, firstMs: number, status: 'error' | 'success' = 'success'): RequestSummary {
  return {
    correlationId: cid,
    firstMs,
    lastMs: firstMs + 100,
    durationMs: 100,
    incoming: { method: 'GET', path: '/v1/x' },
    component: 'api',
    recordCount: 3,
    status,
    kind: 'incoming',
    reasons: [],
    match: 'exact',
    incomplete: false,
  };
}

function state(over: Partial<SearchState> = {}): SearchState {
  return {
    id: 's1',
    status: 'done',
    stage: 'done',
    period: { fromMs: NOW - 6 * H, toMs: NOW, preset: '6h' },
    terms: [{ display: 'getCard', kind: 'text' }],
    found: 0,
    tooMany: false,
    truncated: false,
    scannedFromMs: NOW - 6 * H,
    lines: 'unknown',
    progress: { chunksDone: 6, chunksTotal: 6, batchesDone: 0, batchesTotal: 0 },
    requests: [],
    requestsTotal: 0,
    error: null,
    ...over,
  };
}

describe('значения поиска в поле', () => {
  it('делит вставку по запятым и строкам', () => {
    expect(splitTerms(' a1b2c3 , 447700900234\n\nx-y ,')).toEqual(['a1b2c3', '447700900234', 'x-y']);
  });

  it('добавляет несколько значений, номер карты показывает маской, повторы убирает', () => {
    const r = addTerms([], '4111111234557893, getCard, getCard');
    expect(r.error).toBeNull();
    expect(r.rest).toBe('');
    expect(r.chips.map((c) => [c.kind, c.display])).toEqual([
      ['pan', '411111******7893'],
      ['text', 'getCard'],
    ]);
    expect(r.chips[0]!.raw).toBe('4111111234557893');
  });

  it('непринятое значение и всё после него остаются в поле', () => {
    const r = addTerms([], 'abcdef, 7, qwerty');
    expect(r.error).toBe('too-short');
    expect(r.chips.map((c) => c.display)).toEqual(['abcdef']);
    expect(r.rest).toBe('7, qwerty');
    expect(addTerms([], 'ab"cd').error).toBe('forbidden-char');
    expect(addTerms([], 'ab\\cd').error).toBe('forbidden-char');
  });

  it('шестое значение не принимается', () => {
    const five = addTerms([], 'aa1, aa2, aa3, aa4, aa5').chips;
    expect(five).toHaveLength(5);
    const r = addTerms(five, 'aa6');
    expect(r.error).toBe('too-many');
    expect(r.chips).toHaveLength(5);
    expect(r.rest).toBe('aa6');
    // Повтор уже введённого — не шестое значение.
    expect(addTerms(five, 'aa1').error).toBeNull();
  });

  it('использует переданное распознавание', () => {
    const r = addTerms([], 'x1', () => ({ kind: 'uuid', value: 'V', display: 'D', filter: { kind: 'contains', value: 'V' } }));
    expect(r.chips[0]).toMatchObject({ kind: 'uuid', display: 'D', value: 'V', raw: 'x1' });
  });

  it('проверка перед поиском: пусто, нет длинного значения, скрытый номер', () => {
    expect(checkChips([])).toEqual({ ok: false, error: 'empty' });
    const short = addTerms([], 'ab, cd').chips;
    expect(checkChips(short)).toEqual({ ok: false, error: 'need-long' });
    const ok = addTerms([], 'ab, abcdef').chips;
    expect(checkChips(ok)).toEqual({ ok: true, raws: ['ab', 'abcdef'] });
    const restored: TermChip[] = chipsFromState([
      { display: '411111******7893', kind: 'pan' },
      { display: '447700900234', kind: 'phone' },
    ]);
    expect(restored.map((c) => c.raw)).toEqual([null, '447700900234']);
    expect(checkChips(restored)).toMatchObject({ ok: false, error: 'pan-hidden', chipId: restored[0]!.id });
  });
});

describe('свой период', () => {
  const ret = 30;
  it('правильный период', () => {
    expect(checkCustomPeriod(NOW - 2 * H, NOW - H, NOW, ret)).toBeNull();
    // Конец в будущем допустим: сервер ищет до текущего момента.
    expect(checkCustomPeriod(NOW - 2 * H, NOW + H, NOW, ret)).toBeNull();
    expect(checkCustomPeriod(NOW - 24 * H, NOW, NOW, ret)).toBeNull();
  });
  it('ошибки', () => {
    expect(checkCustomPeriod(null, NOW, NOW, ret)).toBe('incomplete');
    expect(checkCustomPeriod(NOW - H, NOW - 2 * H, NOW, ret)).toBe('reversed');
    expect(checkCustomPeriod(NOW - H, NOW - H, NOW, ret)).toBe('reversed');
    expect(checkCustomPeriod(NOW + H, NOW + 2 * H, NOW, ret)).toBe('future');
    expect(checkCustomPeriod(NOW - 25 * H, NOW, NOW, ret)).toBe('too-long');
    expect(checkCustomPeriod(NOW - 24 * H - 60_000, NOW, NOW, ret)).toBe('too-long');
    expect(checkCustomPeriod(NOW - 31 * 24 * H, NOW - 31 * 24 * H + H, NOW, ret)).toBe('too-old');
  });
  it('тело запроса', () => {
    expect(periodBody({ preset: '6h' })).toEqual({ preset: '6h' });
    expect(periodBody({ fromMs: 1, toMs: 2 })).toEqual({ fromMs: 1, toMs: 2 });
  });
});

describe('опрос состояния', () => {
  it('дописывает новые запросы к полученным', () => {
    const a = state({ status: 'running', requests: [req('a', 1), req('b', 2)], requestsTotal: 2 });
    const b = state({ status: 'running', requests: [req('c', 3)], requestsTotal: 3 });
    expect(mergeSearchState(a, b, 2).requests.map((r) => r.correlationId)).toEqual(['a', 'b', 'c']);
    expect(mergeSearchState(a, state({ requests: [], requestsTotal: 2 }), 2).requests).toHaveLength(2);
  });
  it('первый ответ и полный список берутся как есть', () => {
    const b = state({ requests: [req('a', 1)], requestsTotal: 1 });
    expect(mergeSearchState(undefined, b, 0)).toBe(b);
    const a = state({ requests: [req('a', 1)], requestsTotal: 1 });
    const full = state({ requests: [req('a', 1), req('b', 2)], requestsTotal: 2 });
    expect(mergeSearchState(a, full, 1).requests.map((r) => r.correlationId)).toEqual(['a', 'b']);
  });
  it('свежие первыми, ошибки считаются', () => {
    const list = [req('a', 1), req('b', 3, 'error'), req('c', 2, 'error')];
    expect(newestFirst(list).map((r) => r.correlationId)).toEqual(['b', 'c', 'a']);
    expect(errorCount(list)).toBe(2);
  });
  it('полоса хода поиска', () => {
    expect(progressOf(state({ status: 'running', stage: 'count', progress: { chunksDone: 3, chunksTotal: 6, batchesDone: 0, batchesTotal: 0 } }))).toBe(0.25);
    expect(progressOf(state({ status: 'running', stage: 'fetch', progress: { chunksDone: 6, chunksTotal: 6, batchesDone: 1, batchesTotal: 2 } }))).toBe(0.75);
    expect(progressOf(state())).toBe(1);
  });
});

describe('сообщения над результатом', () => {
  it('пусто и только строки без запросов', () => {
    expect(noticesOf(state({ lines: 'none' }))).toEqual(['empty']);
    expect(noticesOf(state({ lines: 'some' }))).toEqual(['only-lines']);
    expect(noticesOf(state({ status: 'running', stage: 'count' }))).toEqual([]);
  });
  it('слишком много, ошибка, остановка, предел строк', () => {
    expect(noticesOf(state({ tooMany: true, found: 350 }))).toEqual(['too-many']);
    const error = { code: 'timeout', stage: 'count' as const };
    expect(noticesOf(state({ status: 'failed', error }))).toEqual(['error']);
    expect(noticesOf(state({ status: 'cancelled', requests: [req('a', 1)], requestsTotal: 1 }))).toEqual(['cancelled']);
    expect(noticesOf(state({ truncated: true, requests: [req('a', 1)], requestsTotal: 1 }))).toEqual(['truncated']);
  });
});

describe('телефон в поле поиска', () => {
  it('два написания — одна метка с общим видом, введённое остаётся в памяти', () => {
    const one = addTerms([], '+44 (7700) 900-001');
    expect(one.chips.map((c) => [c.kind, c.display, c.raw])).toEqual([['phone', '447700900001', '+44 (7700) 900-001']]);
    const two = addTerms(one.chips, '+447700900001');
    expect(two.chips).toHaveLength(1);
    expect(two.chips[0]!.raw).toBe('+44 (7700) 900-001');
  });

  it('после перезагрузки добавление того же номера не даёт второй метки, поиск идёт по значению', () => {
    const restored = chipsFromState([{ display: '447700900001', kind: 'phone' }]);
    expect(addTerms(restored, '+44 7700 900 001').chips).toHaveLength(1);
    expect(checkChips(restored)).toEqual({ ok: true, raws: ['447700900001'] });
  });

  it('без плана номеров местная запись — текст', () => {
    expect(addTerms([], '07700 900001').chips.map((c) => c.kind)).toEqual(['text']);
  });

  describe('с планом номеров демо-проекта', () => {
    beforeAll(() => setRegional({ phone: { countryCode: '44', nationalDigits: 10, trunkPrefix: '0' }, patterns: {} }));
    afterAll(() => setRegional(null));

    it('местная запись и международная — одна метка', () => {
      const one = addTerms([], '07700 900001');
      expect(one.chips.map((c) => [c.kind, c.display, c.raw])).toEqual([['phone', '447700900001', '07700 900001']]);
      expect(addTerms(one.chips, '+447700900001').chips).toHaveLength(1);
      expect(addTerms(one.chips, '447700900001').chips).toHaveLength(1);
    });
  });
});

describe('период вокруг времени', () => {
  const ret = 30;
  const M = 60_000;
  const DAY = 24 * H;

  it('границы — время ± отступ', () => {
    expect(aroundBounds(NOW, 15)).toEqual({ fromMs: NOW - 15 * M, toMs: NOW + 15 * M });
  });

  it('тело запроса — обычные границы, без записи времени', () => {
    const around = { atMs: NOW, minutes: 15 as const, text: '2026-11-02 15:00' };
    const p = { ...aroundBounds(NOW, 15), around };
    expect(periodBody(p)).toEqual({ fromMs: NOW - 15 * M, toMs: NOW + 15 * M });
    expect(JSON.stringify(periodBody(p))).not.toContain('2026-11-02');
  });

  it('после перезагрузки период приходит границами с теми же моментами', () => {
    const period = { fromMs: NOW - 15 * M + 500, toMs: NOW + 15 * M + 500, preset: null };
    expect(periodFromState(period)).toEqual({ fromMs: period.fromMs, toMs: period.toMs });
  });

  it('будущее время: минута запаса, дальше ошибка', () => {
    expect(checkAround(NOW + M, 15, NOW, ret)).toBeNull();
    expect(checkAround(NOW + M + 1, 15, NOW, ret)).toBe('not-yet');
    expect(checkAround(NOW + H, 60, NOW, ret)).toBe('not-yet');
  });

  it('конец в будущем допустим, время только что принято', () => {
    expect(checkAround(NOW - M, 15, NOW, ret)).toBeNull();
    expect(aroundBounds(NOW - M, 15).toMs).toBeGreaterThan(NOW);
  });

  it('срок хранения — после вычитания отступа', () => {
    const at = NOW - ret * DAY;
    expect(checkAround(at + 15 * M, 15, NOW, ret)).toBeNull();
    expect(checkAround(at + 14 * M, 15, NOW, ret)).toBe('too-old');
  });

  it('срок хранения при запуске поиска позже выбора', () => {
    const { fromMs, toMs } = aroundBounds(NOW - ret * DAY + 15 * M, 15);
    expect(checkCustomPeriod(fromMs, toMs, NOW, ret)).toBeNull();
    expect(checkCustomPeriod(fromMs, toMs, NOW + H, ret)).toBe('too-old');
  });

  it('наибольший отступ не упирается в предел 24 часа', () => {
    expect(checkAround(NOW - H, 60, NOW, ret)).toBeNull();
    expect(aroundBounds(NOW, 60).toMs - aroundBounds(NOW, 60).fromMs).toBe(2 * H);
  });
});

describe('исключённые значения', () => {
  const chips = (text: string) => addTerms([], text).chips;

  it('те же правила ввода: минимум 2 символа, предел 5, повтор убран', () => {
    expect(addTerms([], 'x').error).toBe('too-short');
    expect(addTerms(chips('aa, bb, cc, dd, ee'), 'ff')).toMatchObject({ error: 'too-many', rest: 'ff' });
    expect(addTerms(chips('aa'), 'aa').chips).toHaveLength(1);
  });

  it('короткое значение проходит, пустой список тоже', () => {
    expect(checkExcludes(chips('ok'), ['abcdef'])).toEqual({ ok: true, raws: ['ok'] });
    expect(checkExcludes([], ['abcdef'])).toEqual({ ok: true, raws: [] });
  });

  it('значение есть в поиске: конфликт с меткой значения', () => {
    const list = chips('ok, abc');
    expect(checkExcludes(list, ['abcdef'])).toEqual({ ok: false, error: 'conflict', chipId: list[1]!.id });
  });

  it('номер карты после перезагрузки нужно ввести заново', () => {
    const restored = chipsFromState([{ display: '411111******7893', kind: 'pan' }]);
    expect(checkExcludes(restored, ['abcdef'])).toEqual({ ok: false, error: 'pan-hidden', chipId: restored[0]!.id });
  });
});

describe('checkPeriodFields: поля своего периода', () => {
  const TZ = 'Asia/Karachi';
  const AT = Date.UTC(2026, 10, 6, 7, 0);
  const check = (from: string, to: string) => checkPeriodFields(from, to, TZ, AT, 30);

  it('верный период', () => {
    expect(check('2026-11-06T10:00', '2026-11-06T11:00')).toMatchObject({ ok: true, fromMs: Date.UTC(2026, 10, 6, 5, 0), toMs: Date.UTC(2026, 10, 6, 6, 0) });
  });

  it('пустое и незаполненное значение: у своего поля', () => {
    expect(check('', '2026-11-06T11:00')).toEqual({ ok: false, error: 'incomplete', field: 'from' });
    expect(check('2026-11-06T10:00', '')).toEqual({ ok: false, error: 'incomplete', field: 'to' });
  });

  it('год вне границ: 202333 и 1999, у своего поля', () => {
    expect(check('202333-11-06T03:33', '2026-11-06T11:00')).toEqual({ ok: false, error: 'year', field: 'from' });
    expect(check('2026-11-06T10:00', '202333-11-06T03:33')).toEqual({ ok: false, error: 'year', field: 'to' });
    expect(check('1999-12-31T23:59', '2026-11-06T11:00')).toEqual({ ok: false, error: 'year', field: 'from' });
    expect(check('2026-11-06T10:00', '2100-01-01T00:00')).toEqual({ ok: false, error: 'year', field: 'to' });
  });

  it('начало позже конца, длинный и старый период правятся в начале', () => {
    expect(check('2026-11-06T11:00', '2026-11-06T10:00')).toEqual({ ok: false, error: 'reversed', field: 'from' });
    expect(check('2026-11-04T10:00', '2026-11-06T10:00')).toEqual({ ok: false, error: 'too-long', field: 'from' });
    expect(check('2026-09-01T10:00', '2026-09-01T11:00')).toEqual({ ok: false, error: 'too-old', field: 'from' });
  });
});
