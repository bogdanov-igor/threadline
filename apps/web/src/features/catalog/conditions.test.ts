import { describe, expect, it } from 'vitest';
import { checkTemplate, conditionsSummary, conditionsToModel, emptyField, emptyHttp, httpToModel, modelToConditions, type ConditionsModel, type SummaryWords } from './conditions.ts';
import { isMasked } from './validate.ts';

const WORDS: SummaryWords = {
  http: 'HTTP',
  equals: '=',
  oneOf: 'одно из',
  exists: 'есть',
  missing: 'нет',
  regex: '~',
  request: 'запрос',
  outcome: { success: 'успех', error: 'ошибка', pending: 'в обработке', ignore: 'не ошибка' },
};

const model = (patch: Partial<ConditionsModel>): ConditionsModel => ({ http: emptyHttp(), fields: [], ...patch });
const field = (patch: Partial<ReturnType<typeof emptyField>>) => ({ ...emptyField(), ...patch });

describe('условия правила итога', () => {
  it('HTTP 422 и status = OK', () => {
    const r = modelToConditions(model({ http: { ...emptyHttp(), mode: 'equals', equals: '422' }, fields: [field({ path: 'status', value: 'OK' })] }));
    expect(r.errors).toEqual({});
    expect(r.conditions).toEqual({ http: 422, fields: [{ path: 'status', equals: 'OK' }] });
  });

  it('без условий — ошибка «нужно хотя бы одно условие»', () => {
    expect(modelToConditions(model({})).errors).toEqual({ conditions: 'noConditions' });
  });

  it('диапазон и список HTTP', () => {
    expect(modelToConditions(model({ http: { ...emptyHttp(), mode: 'range', from: '400', to: '499' } })).conditions).toEqual({ http: { from: 400, to: 499 } });
    expect(modelToConditions(model({ http: { ...emptyHttp(), mode: 'oneOf', oneOf: '200, 202, 500-599' } })).conditions).toEqual({ http: [200, 202, { from: 500, to: 599 }] });
    expect(modelToConditions(model({ http: { ...emptyHttp(), mode: 'range', from: '499', to: '400' } })).errors).toEqual({ 'http.to': 'httpOrder' });
    expect(modelToConditions(model({ http: { ...emptyHttp(), mode: 'equals', equals: '99' } })).errors).toEqual({ 'http.equals': 'httpRange' });
  });

  it('51 значение в «одно из» отклонено', () => {
    const values = Array.from({ length: 51 }, (_, i) => `v${i}`).join(', ');
    expect(modelToConditions(model({ fields: [field({ path: 'status', check: 'oneOf', value: values })] })).errors).toEqual({ 'fields.0.value': 'tooManyValues' });
  });

  it('номер карты в значении условия отклонён', () => {
    const r = modelToConditions(model({ fields: [field({ path: 'pan', value: '4111111111111111' })] }), isMasked);
    expect(r.errors).toEqual({ 'fields.0.value': 'masked' });
  });

  it('выражение, которое не разбирается', () => {
    expect(modelToConditions(model({ fields: [field({ path: 'message', check: 'regex', value: '([' })] })).errors).toEqual({ 'fields.0.value': 'regexInvalid' });
  });

  it('«есть» и «нет» без значения, поле запроса', () => {
    const r = modelToConditions(model({ fields: [field({ path: 'error', check: 'exists' }), field({ in: 'request', path: 'id', check: 'missing' })] }));
    expect(r.conditions).toEqual({ fields: [{ path: 'error', exists: true }, { in: 'request', path: 'id', exists: false }] });
  });

  it('число из правила остаётся числом, если текст не меняли', () => {
    const m = conditionsToModel({ fields: [{ path: 'code', equals: 0 }, { path: 'state', oneOf: [1, 'x'] }] });
    expect(modelToConditions(m).conditions).toEqual({ fields: [{ path: 'code', equals: 0 }, { path: 'state', oneOf: [1, 'x'] }] });
  });

  it('HTTP из правила в форму и обратно', () => {
    expect(httpToModel([200, 202]).mode).toBe('oneOf');
    expect(httpToModel({ from: 400, to: 499 })).toMatchObject({ mode: 'range', from: '400', to: '499' });
    expect(httpToModel(undefined).mode).toBe('any');
  });
});

describe('короткий текст условий', () => {
  it('«HTTP 422 · status = OK → успех»', () => {
    expect(conditionsSummary({ http: 422, fields: [{ path: 'status', equals: 'OK' }] }, WORDS, 'success')).toBe('HTTP 422 · status = OK → успех');
  });

  it('диапазон, список и поле запроса', () => {
    expect(conditionsSummary({ http: [{ from: 400, to: 499 }, 504], fields: [{ in: 'request', path: 'type', oneOf: ['a', 'b'] }] }, WORDS)).toBe('HTTP 400–499, 504 · запрос type одно из a, b');
  });
});

describe('шаблон текста', () => {
  it('места подстановки', () => {
    expect(checkTemplate('Отказ: {error.message}')).toBeNull();
    expect(checkTemplate('Отказ: {message')).toBe('templateUnclosed');
    expect(checkTemplate('{a}{b}{c}{d}{e}{f}')).toBe('templateTooMany');
    expect(checkTemplate('{a b}')).toBe('templatePlace');
    expect(checkTemplate('x'.repeat(201))).toBe('tooLong');
  });
});
