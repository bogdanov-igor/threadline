// Проверки записей справочника: правка записи, тексты записи, раздел «Идентификаторы», форма и пределы правила итога.
import { describe, expect, it } from 'vitest';
import {
  checkError,
  checkIdType,
  checkMethod,
  checkOutcome,
  checkSystem,
  codeKey,
  condKey,
  errorInput,
  idTypeInput,
  methodInput,
  outcomeInput,
  systemInput,
  toErrorData,
  toIdTypeData,
  toMethodData,
  toOutcomeData,
  toSystemData,
  zodIssues,
  type Issue,
  maskIssues,
} from './schema.ts';
import { DEMO, UZBEKISTAN, useRegional } from '../search/test-regional.ts';

const PAN = '4111111234557893';
const types = new Map([
  ['transfer', { kind: 'operation' as const, statuses: [{ value: 'completed', name: 'Выполнен', outcome: 'success' as const }, { value: 'failed', name: 'Отказ', outcome: 'failure' as const }] }],
  ['user', { kind: 'entity' as const, statuses: [] }],
]);
const external = { kind: 'external' as const, type: 'service' as const };

function method(input: unknown, system: { kind: 'project' | 'external'; type: 'service' | 'database' | 'queue' } = external): Issue[] {
  const r = methodInput.safeParse(input);
  if (!r.success) return zodIssues(r.error);
  return checkMethod(toMethodData(r.data), { system, idTypes: types });
}
function error(input: unknown): Issue[] {
  const r = errorInput.safeParse(input);
  return r.success ? checkError(toErrorData(r.data)) : zodIssues(r.error);
}
function outcome(input: unknown): Issue[] {
  const r = outcomeInput.safeParse(input);
  return r.success ? checkOutcome(toOutcomeData(r.data)) : zodIssues(r.error);
}
function idType(input: unknown): Issue[] {
  const r = idTypeInput.safeParse(input);
  return r.success ? checkIdType(toIdTypeData(r.data)) : zodIssues(r.error);
}
const paths = (issues: Issue[]) => issues.map((i) => i.path);
const M = { http: 'GET', path: '/v1/users/{userId}/cards/{cardId}', name: 'Данные карты' };

describe('метод', () => {
  it('верный метод', () => expect(method(M)).toEqual([]));

  it('неверный шаблон пути', () => {
    for (const path of ['v1/x', '/v1/x?y=1', '/v1/x#a', '/cards/id{cardId}']) expect(paths(method({ ...M, path }))).toEqual(['path']);
  });

  it('вид без типа операции; колбэк у внешней системы; статус без op', () => {
    expect(paths(method({ ...M, kind: 'status' }))).toEqual(['op']);
    expect(paths(method({ ...M, kind: 'callback', op: 'transfer' }))).toEqual(['kind']);
    expect(method({ ...M, kind: 'callback', op: 'transfer' }, { kind: 'project', type: 'service' })).toEqual([]);
    expect(paths(method({ ...M, status: { in: 'response', path: 'state' } }))).toEqual(['status']);
  });

  it('тип операции — сущность или неизвестен; поле id с неизвестным типом', () => {
    expect(method({ ...M, kind: 'status', op: 'user' })[0]!.message).toMatch(/сущность/);
    expect(method({ ...M, op: 'payment' })[0]!.message).toMatch(/Идентификаторах/);
    expect(paths(method({ ...M, fields: [{ in: 'request', path: 'remote_transfer_id', type: 'nope' }] }))).toEqual(['fields.0.type']);
  });

  it('перевод значений статуса — в значения словаря', () => {
    expect(method({ ...M, kind: 'status', op: 'transfer', status: { in: 'request', path: 'state', map: { complete: 'completed', error: 'failed' } } })).toEqual([]);
    expect(paths(method({ ...M, kind: 'status', op: 'transfer', status: { in: 'request', path: 'state', map: { ok: 'done' } } }))).toEqual(['status.map.ok']);
  });

  it('у базы и шины методов нет', () => {
    expect(paths(method(M, { kind: 'external', type: 'database' }))).toEqual(['path']);
  });

  it('пределы: название 80, домен 40, описание 500, полей id 10, путь поля 128', () => {
    expect(paths(method({ ...M, name: 'x'.repeat(81) }))).toEqual(['name']);
    expect(paths(method({ ...M, domain: 'x'.repeat(41) }))).toEqual(['domain']);
    expect(paths(method({ ...M, description: 'x'.repeat(501) }))).toEqual(['description']);
    expect(paths(method({ ...M, fields: Array.from({ length: 11 }, () => ({ in: 'query', path: 'a', type: 'user' })) }))).toEqual(['fields']);
    expect(paths(method({ ...M, fields: [{ in: 'query', path: 'a'.repeat(129), type: 'user' }] }))).toEqual(['fields.0.path']);
  });

  it('неизвестное поле — с путём до него', () => {
    expect(paths(method({ ...M, titel: 'x' }))).toEqual(['titel']);
  });
});

describe('ошибка', () => {
  it('без условий отклонена', () => expect(error({ title: 'x' })[0]!.message).toMatch(/хотя бы одно условие/));

  it('пределы: текст 200, «что делать» 500, подстрока 3–200, код 64', () => {
    expect(paths(error({ code: '1', title: 'x'.repeat(201) }))).toEqual(['title']);
    expect(paths(error({ code: '1', title: 'x', action: 'x'.repeat(501) }))).toEqual(['action']);
    expect(paths(error({ text: 'ab', title: 'x' }))).toEqual(['text']);
    expect(paths(error({ text: 'a'.repeat(201), title: 'x' }))).toEqual(['text']);
    expect(paths(error({ code: 'x'.repeat(65), title: 'x' }))).toEqual(['code']);
  });

  it('номер карты в подстроке отклонён без значения в тексте ошибки', () => {
    const issues = error({ text: `card ${PAN} not active`, title: 'x' });
    expect(paths(issues)).toEqual(['text']);
    expect(JSON.stringify(issues)).not.toContain(PAN);
  });

  it('код числом принимается, ведущие нули — одно правило', () => {
    expect(error({ code: 200, title: 'x' })).toEqual([]);
    expect(codeKey('00')).toBe(codeKey(0));
    expect(codeKey('-0350')).toBe('-350');
    expect(codeKey(' PRC-ERR-0027 ')).toBe('PRC-ERR-0027');
  });

  it('разметка в тексте сохраняется как текст', () => {
    expect(error({ code: '1', title: '<b>карта</b>' })).toEqual([]);
  });
});

describe('тип id', () => {
  it('ключ: латиница с буквы, до 32', () => {
    expect(paths(idType({ key: '1abc', kind: 'entity', name: 'x' }))).toEqual(['key']);
    expect(paths(idType({ key: 'Abc', kind: 'entity', name: 'x' }))).toEqual(['key']);
    expect(paths(idType({ key: 'a'.repeat(33), kind: 'entity', name: 'x' }))).toEqual(['key']);
    expect(idType({ key: 'merchant_payment', kind: 'operation', name: 'Оплата у партнёра' })).toEqual([]);
  });

  it('у сущности нет словаря; статусов до 30; значение до 64; повтор значения', () => {
    const st = (value: string) => ({ value, name: 'n', outcome: 'pending' });
    expect(paths(idType({ key: 'user', kind: 'entity', name: 'x', statuses: [st('a')] }))).toEqual(['statuses']);
    expect(paths(idType({ key: 'op', kind: 'operation', name: 'x', statuses: Array.from({ length: 31 }, (_, i) => st(`s${i}`)) }))).toEqual(['statuses']);
    expect(paths(idType({ key: 'op', kind: 'operation', name: 'x', statuses: [st('x'.repeat(65))] }))).toEqual(['statuses.0.value']);
    expect(paths(idType({ key: 'op', kind: 'operation', name: 'x', statuses: [st('a'), st('A')] }))).toEqual(['statuses.1.value']);
  });
});

describe('система', () => {
  const sys = (input: unknown, otherHosts = new Map<string, string>()) => {
    const r = systemInput.safeParse(input);
    return r.success ? checkSystem(toSystemData(r.data), { project: 'pay', otherHosts }) : zodIssues(r.error);
  };

  it('хост уже у другой системы — с её названием', () => {
    const issues = sys({ key: 'acquirer', name: 'Эквайер', hosts: ['switch.pay.example:9191'] }, new Map([['switch.pay.example:9191', 'Коммутатор']]));
    expect(issues).toEqual([{ path: 'hosts.0', message: 'хост уже у системы «Коммутатор»' }]);
  });

  it('система-автор: ключ проекта, сервис', () => {
    expect(paths(sys({ key: 'acme', kind: 'project', name: 'X' }))).toEqual(['key']);
    expect(paths(sys({ key: 'pay', kind: 'project', type: 'queue', name: 'X' }))).toEqual(['type']);
  });

  it('неверный шаблон хоста', () => {
    expect(paths(sys({ key: 'x', name: 'X', hosts: ['http://x'] }))).toEqual(['hosts.0']);
  });
});

describe('правило итога', () => {
  const W = { when: { http: 422, fields: [{ path: 'status', equals: 'OK' }] }, outcome: 'success' };

  it('верное правило', () => expect(outcome(W)).toEqual([]));

  it('без условий; две проверки в одном поле', () => {
    expect(outcome({ when: {}, outcome: 'success' })[0]!.message).toMatch(/хотя бы одно условие/);
    expect(paths(outcome({ when: { fields: [{ path: 'status', equals: 'OK', exists: true }] }, outcome: 'success' }))).toEqual(['when.fields.0']);
  });

  it('пределы: приоритет 1–1000, HTTP 100–599, условий 10, одно из 50, значение 200', () => {
    expect(paths(outcome({ ...W, priority: 0 }))).toEqual(['priority']);
    expect(paths(outcome({ ...W, priority: 1001 }))).toEqual(['priority']);
    expect(paths(outcome({ when: { http: 99 }, outcome: 'success' }))).toEqual(['when.http']);
    expect(paths(outcome({ when: { http: { from: 500, to: 400 } }, outcome: 'success' }))).toEqual(['when.http']);
    expect(paths(outcome({ when: { fields: Array.from({ length: 11 }, () => ({ path: 'a', exists: true })) }, outcome: 'success' }))).toEqual(['when.fields']);
    expect(paths(outcome({ when: { fields: [{ path: 'a', oneOf: Array.from({ length: 51 }, (_, i) => i) }] }, outcome: 'success' }))).toEqual(['when.fields.0.oneOf']);
    expect(paths(outcome({ when: { fields: [{ path: 'a', equals: 'x'.repeat(201) }] }, outcome: 'success' }))).toEqual(['when.fields.0.equals']);
  });

  it('номер карты в значении условия отклонён', () => {
    const issues = outcome({ when: { fields: [{ path: 'card', equals: PAN }] }, outcome: 'error' });
    expect(paths(issues)).toEqual(['when.fields.0.equals']);
    expect(JSON.stringify(issues)).not.toContain(PAN);
  });

  it('регулярное выражение: не разбирается или вне диалекта', () => {
    expect(paths(outcome({ when: { fields: [{ path: 'm', regex: '(' }] }, outcome: 'error' }))).toEqual(['when.fields.0.regex']);
    expect(paths(outcome({ when: { fields: [{ path: 'm', regex: '(?=a)' }] }, outcome: 'error' }))).toEqual(['when.fields.0.regex']);
    expect(outcome({ when: { fields: [{ path: 'm', regex: '^[Tt]imeout' }] }, outcome: 'error' })).toEqual([]);
  });

  it('текст: до 200 символов, до 5 мест, незакрытая скобка', () => {
    expect(paths(outcome({ ...W, text: 'x'.repeat(201) }))).toEqual(['text']);
    expect(paths(outcome({ ...W, text: '{a}{b}{c}{d}{e}{f}' }))).toEqual(['text']);
    expect(paths(outcome({ ...W, text: 'Отказ: {message' }))).toEqual(['text']);
    expect(outcome({ ...W, text: 'Отказ: {error.message}' })).toEqual([]);
  });

  it('ключ условий: одинаковые условия — один ключ, in по умолчанию response', () => {
    expect(condKey({ fields: [{ path: 'status', equals: 'OK' }], http: 422 })).toBe(condKey({ http: 422, fields: [{ in: 'response', path: 'status', equals: 'OK' }] }));
    expect(condKey({ http: 422 })).not.toBe(condKey({ http: 423 }));
  });
});

describe('проверка значений: номер в ключе и числа', () => {
  it('путь проблемы без полного номера; отрицательное и дробное число с номером отклоняются', () => {
    const PAN = '4111111234557893';
    const issues = maskIssues({ map: { [PAN]: 'x' }, a: -Number(PAN), b: Number(PAN) + 0.5, ok: 12.5 }, 'status');
    expect(JSON.stringify(issues)).not.toContain(PAN);
    expect(issues.map((i) => i.path)).toEqual(expect.arrayContaining(['status.map', 'status.a', 'status.b']));
    expect(issues.some((i) => i.path === 'status.ok')).toBe(false);
  });
});

describe('значения видов маски в записях', () => {
  const m = (over: object) => toMethodData(methodInput.parse({ http: 'GET', path: '/v1/x', name: 'M', ...over }));
  const ctx = { system: { kind: 'external' as const, type: 'service' as const }, idTypes: types };

  const rejects = (values: string[]) => {
    for (const v of values) {
      const issues = maskIssues({ text: `x ${v}` }, '');
      expect(issues.length, v).toBe(1);
      expect(JSON.stringify(issues)).not.toContain(v);
      expect(issues[0]!.message).toContain('вида маски');
    }
  };

  it('телефон E.164, IBAN и телефон в паре отклоняются без значения в сообщении', () => {
    rejects(['+447700900001', 'DE89370400440532013000', 'phone=+447700900001']);
  });

  it('без региональных правил номер без плюса и паспорт в тексте значением вида не считаются', () => {
    for (const v of ['447700900001', 'ZZ0000101']) expect(maskIssues({ text: `x ${v}` }, ''), v).toEqual([]);
  });

  describe('правила демо-проекта', () => {
    useRegional(DEMO);
    it('номер с кодом страны без плюса, паспорт и личный номер отклоняются', () => {
      rejects(['447700900001', 'ZZ0000101', 'ZZ000101A', 'phone=447700900001']);
    });
  });

  describe('пример Узбекистана', () => {
    useRegional(UZBEKISTAN);
    it('телефон 998, паспорт и ПИНФЛ отклоняются', () => {
      rejects(['998900000001', 'AA0000001', '31201990000011', 'phone=998900000001']);
    });
  });

  it('слово из словаря в тексте принято', () => {
    for (const v of ['invalid document: wrong expiry', 'Invalid phone: must be 12 digits', 'Адрес не найден']) expect(maskIssues({ text: v }, '')).toEqual([]);
  });

  it('встроенное поле в поле id, статусе и шаблоне отклоняется, условие «есть» разрешено', () => {
    expect(checkMethod(m({ fields: [{ in: 'request', path: 'home_phone', type: 'user' }] }), ctx).map((i) => i.path)).toContain('fields.0.path');
    const rule = (when: object, text: string | null = null) => toOutcomeData(outcomeInput.parse({ when, outcome: 'error', text }));
    expect(checkOutcome(rule({ fields: [{ path: 'phone', equals: 'x' }] })).map((i) => i.path)).toContain('when.fields.0.path');
    expect(checkOutcome(rule({ fields: [{ path: 'phone', exists: true }] }))).toEqual([]);
    expect(checkOutcome(rule({ http: 500 }, 'Ошибка {national_id}')).map((i) => i.path)).toContain('text');
    expect(checkOutcome(rule({ http: 500 }, 'Ошибка {client_alt}'))).toEqual([]);
  });

  it('{phone} в шаблоне пути метода не отклоняется, поле вне словаря — тоже', () => {
    expect(checkMethod(m({ path: '/v1/users/{user_id}/contacts/{phone}', fields: [{ in: 'request', path: 'client_alt', type: 'user' }] }), ctx)).toEqual([]);
  });
});
