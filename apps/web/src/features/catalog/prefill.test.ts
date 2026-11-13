import { describe, expect, it } from 'vitest';
import type { UnknownRow } from '@threadline/core/catalog';
import type { CatalogName, TraceStep, ViewRecord } from '@threadline/core/search';
import { diffModel } from './import-report.ts';
import type { StepCatalog } from './names.ts';
import { rpcOf, stepActions, unknownTarget, verbOf } from './prefill.ts';
import { unknownExamplePath } from './sections/UnknownSection.tsx';

// «Добавить в справочник» из шага и из «Неизвестного».

function record(id: string, kind: ViewRecord['kind'], http: Partial<NonNullable<ViewRecord['http']>> | null, body: string | null = null): ViewRecord {
  return {
    id,
    tsNs: '0',
    timeMs: 0,
    offsetMs: 0,
    kind,
    title: '',
    message: '',
    level: null,
    isError: false,
    component: null,
    gateway: false,
    correlationId: 'c1',
    requestId: null,
    http: http ? { method: null, uri: null, status: null, durationMs: null, pairId: null, noResponse: false, pending: false, ...http } : null,
    sections: { headers: null, body, payload: null, context: null },
    raw: '',
    match: null,
  };
}

function step(patch: Partial<TraceStep>): TraceStep {
  return { id: 's', parentId: null, depth: 0, kind: 'exchange', title: '', system: null, startMs: 0, endMs: 1, durationMs: 1, status: 200, isError: false, noResponse: false, pending: false, recordIds: [], ...patch };
}

const name = (patch: Partial<CatalogName>): CatalogName => ({ source: 'external', system: null, method: null, host: null, ...patch });
const cat = (patch: Partial<StepCatalog>): StepCatalog => ({ name: null, error: null, outcome: null, status: null, ids: [], ...patch });
const ACQUIRER = { key: 'acquirer', name: 'Эквайер', type: 'service' as const };

describe('действия у шага', () => {
  it('неизвестный метод входа: форма метода с POST и шаблоном пути', () => {
    const s = step({ kind: 'incoming', title: 'POST /v1/cards/lookup', status: null });
    const a = stepActions(s, cat({ name: name({ source: 'project', system: { key: 'pay', name: 'Demo Pay', type: 'service' } }) }), [record('i', 'incoming', { method: 'POST', uri: '/v1/cards/lookup' })]);
    expect(a.add).toEqual({ kind: 'method', systemKey: 'pay', draft: { http: 'POST', path: '/v1/cards/lookup', rpc: '' } });
    expect(a.edit).toBeNull();
  });

  it('путь с идентификаторами — шаблон с подстановками', () => {
    const s = step({ kind: 'incoming', title: 'GET /v1/users/5a1d0100-0000-4000-8000-000000000001/cards/5a1d0200-0000-4000-8000-000000000002', status: null });
    const a = stepActions(s, cat({ name: name({ source: 'project', system: { key: 'pay', name: 'Demo Pay', type: 'service' } }) }), []);
    expect(a.add).toMatchObject({ kind: 'method', draft: { http: 'GET', path: '/v1/users/{user}/cards/{card}' } });
  });

  it('неузнанный хост — выбор системы для хоста', () => {
    const s = step({ title: 'POST http://unknown-system.pay.example:8443/x', system: 'unknown-system.pay.example' });
    const a = stepActions(s, cat({ name: name({ source: 'unknown', host: 'unknown-system.pay.example:8443' }) }), [record('a', 'send', { method: 'POST', uri: 'http://unknown-system.pay.example:8443/x' })]);
    expect(a.add).toEqual({ kind: 'host', host: 'unknown-system.pay.example:8443' });
  });

  it('узнанный метод — «Изменить в справочнике», ответ системы — «Добавить правило итога» с HTTP шага', () => {
    const s = step({ title: 'POST https://checkout.acquirer.example/v1/pay', status: 422, isError: true });
    const c = cat({ name: name({ system: ACQUIRER, method: { id: 7, name: 'Оплата', domain: null, kind: 'call', opType: null } }) });
    const a = stepActions(s, c, [record('a', 'send', { method: 'POST', uri: 'https://checkout.acquirer.example/v1/pay' }), record('b', 'response', { status: 422 })]);
    expect(a.edit).toEqual({ kind: 'method', id: 7 });
    expect(a.rule).toEqual({ target: { kind: 'outcome', systemKey: 'acquirer', draft: { methodId: 7, when: { http: 422 }, outcome: 'success' } }, edit: false });
  });

  it('итог решило правило — «Изменить правило итога»', () => {
    const c = cat({ name: name({ system: ACQUIRER }), outcome: { kind: 'success', rule: { id: 5, level: 'system' }, text: null, action: null } });
    expect(stepActions(step({}), c, [record('b', 'response', { status: 422 })]).rule).toEqual({ target: { kind: 'outcome', id: 5 }, edit: true });
  });

  it('неизвестная ошибка узнанного метода — форма ошибки с кодом и примером', () => {
    const c = cat({
      name: name({ system: ACQUIRER, method: { id: 7, name: 'Оплата', domain: null, kind: 'call', opType: null } }),
      error: { source: 'unknown', rule: null, title: null, action: null, severity: 'error', partnerCode: null, raw: { http: null, code: '999', text: 'Unknown failure' } },
    });
    const a = stepActions(step({ isError: true }), c, [record('a', 'send', { method: 'POST', uri: 'https://x/v1/pay' })]);
    expect(a.add).toEqual({ kind: 'error', systemKey: 'acquirer', draft: { methodId: 7, http: null, code: '999' }, sample: 'Unknown failure' });
  });

  it('справочник выключен — действий нет', () => {
    expect(stepActions(step({}), null, [])).toEqual({ add: null, edit: null, rule: null });
  });
});

describe('«Неизвестное» в форму', () => {
  const base: UnknownRow = {
    id: 1,
    kind: 'error',
    systemId: 2,
    methodId: null,
    httpMethod: null,
    path: null,
    rpc: null,
    host: null,
    httpStatus: null,
    code: '999',
    text: 'Something …',
    env: 'prod',
    stand: null,
    exampleCid: 'cid-1',
    exampleMs: 1_000_000,
    count: 3,
    firstSeen: '2026-11-01T00:00:00.000Z',
    lastSeen: '2026-11-02T00:00:00.000Z',
    hidden: false,
  };

  it('ошибка с HTTP 200: статус и код в форме — такое правило сработает', () => {
    expect(unknownTarget({ ...base, httpStatus: 200, code: '12' })).toMatchObject({ kind: 'error', draft: { http: 200, code: '12' } });
  });

  it('ошибка: код и пример в подсказке, подстрока пустая', () => {
    expect(unknownTarget(base)).toEqual({ kind: 'error', draft: { systemId: 2, methodId: null, http: null, code: '999' }, sample: 'Something …' });
  });

  it('хост и метод', () => {
    expect(unknownTarget({ ...base, kind: 'host', host: 'unknown-system.pay.example:8443' })).toEqual({ kind: 'host', host: 'unknown-system.pay.example:8443' });
    expect(unknownTarget({ ...base, kind: 'method', systemId: null, httpMethod: 'post', path: '/v1/x/{id}' })).toEqual({ kind: 'method', draft: { http: 'POST', path: '/v1/x/{id}', rpc: '' } });
  });

  it('ссылка на пример — страница запроса с окном вокруг примера', () => {
    expect(unknownExamplePath('pay', base)).toBe('/pay/prod/requests/cid-1?from=940000&to=1060000');
    expect(unknownExamplePath('pay', { ...base, env: 'stands', stand: '92' })).toBe('/pay/stands/92/requests/cid-1?from=940000&to=1060000');
  });
});

describe('мелочи', () => {
  it('действие SOAP и JSON-RPC', () => {
    expect(rpcOf('<s:Envelope><s:Body><ns2:getCard/></s:Body></s:Envelope>')).toBe('getCard');
    expect(rpcOf('<Envelope><Body><getCardResponse/></Body></Envelope>', true)).toBe('getCard');
    expect(rpcOf('{"jsonrpc":"2.0","method":"cards.get"}')).toBe('cards.get');
    expect(rpcOf('{"method":"x"}')).toBe('');
    expect(rpcOf('not json')).toBe('');
  });

  it('HTTP-метод записи', () => {
    expect(verbOf('get')).toBe('GET');
    expect(verbOf('PROPFIND')).toBe('*');
    expect(verbOf(null, 'POST')).toBe('POST');
  });

});

describe('действия шага по правам роли', () => {
  const support = (kind: string) => kind === 'error';
  const failed: StepCatalog['error'] = { source: 'unknown', rule: null, title: null, action: null, severity: 'error', partnerCode: null, raw: { http: 500, code: '8', text: 'fail' } };
  const response = record('r', 'response', { status: 500 });

  it('неизвестный метод и неизвестная ошибка: поддержке только ошибка, остальным метод', () => {
    const c = cat({ name: name({ system: ACQUIRER }), error: failed });
    const s = step({ isError: true });
    expect(stepActions(s, c, [response], support)).toEqual({ add: expect.objectContaining({ kind: 'error' }), edit: null, rule: null });
    const full = stepActions(s, c, [response]);
    expect(full.add?.kind).toBe('method');
    expect(full.rule?.edit).toBe(false);
  });

  it('незнакомый хост и ошибка: поддержке ошибка, остальным хост', () => {
    const send = record('s', 'send', { uri: 'http://10.0.0.1:80/x' });
    const c = cat({ error: failed });
    expect(stepActions(step({ isError: true }), c, [send], support).add?.kind).toBe('error');
    expect(stepActions(step({ isError: true }), c, [send]).add?.kind).toBe('host');
  });

  it('система не описана: форма сразу на общих правилах, запись на системе шаг не изменила бы', () => {
    const send = record('s', 'send', { uri: 'http://10.0.0.1:80/x' });
    expect(stepActions(step({ isError: true }), cat({ error: failed }), [send], support).add).toEqual({ kind: 'error', noSystem: true, draft: { systemId: null, methodId: null, http: 500, code: '8' }, sample: 'fail' });
  });

  it('обмен без хоста и система не описана: кнопка остаётся и ведёт к форме ошибки', () => {
    const send = record('s', 'send', { uri: '/x' });
    expect(stepActions(step({ isError: true }), cat({ error: failed }), [send]).add).toMatchObject({ kind: 'error', noSystem: true, draft: { systemId: null } });
  });

  it('незнакомый хост без ошибки: поддержке нечего предложить', () => {
    const send = record('s', 'send', { uri: 'http://10.0.0.1:80/x' });
    expect(stepActions(step({}), cat({}), [send], support)).toEqual({ add: null, edit: null, rule: null });
  });

  it('правка: поддержка правит только ошибку, метод и систему нет', () => {
    const known = { id: 7, name: 'M', domain: null, kind: 'call' as const, opType: null };
    const withRule = cat({ name: name({ system: ACQUIRER, method: known }), error: { ...failed!, rule: { id: 3, level: 'system', kind: 'error' } } });
    expect(stepActions(step({ isError: true }), withRule, [response], support).edit).toEqual({ kind: 'error', id: 3 });
    const noError = cat({ name: name({ system: ACQUIRER, method: known }) });
    expect(stepActions(step({}), noError, [response], support)).toEqual({ add: null, edit: null, rule: null });
    expect(stepActions(step({}), noError, [response]).edit).toEqual({ kind: 'method', id: 7 });
  });
});

describe('отчёт загрузки', () => {
  it('возвращаемые и невозвращаемые записи: свои группы, возвращаемые считаются изменениями', () => {
    const m = diffModel({
      project: 'pay',
      dryRun: true,
      applied: false,
      added: [],
      changed: [],
      hidden: [],
      restored: [{ kind: 'method', key: 'pay|GET|/a|', title: 'A' }],
      undeleted: [{ kind: 'error', key: 'switch|*|||x', title: 'X' }],
      skipped: [],
      unchanged: 0,
      missing: 0,
      errors: [],
    });
    expect(m.groups.map((g) => [g.key, g.count])).toEqual([
      ['restored', 1],
      ['undeleted', 1],
    ]);
    expect(m).toMatchObject({ changes: 1, canApply: true, undeleted: 1 });
  });

  it('только то, что файл не возвращает: применять нечего', () => {
    const m = diffModel({ project: 'pay', dryRun: true, applied: false, added: [], changed: [], hidden: [], undeleted: [{ kind: 'error', key: 'k', title: 'X' }], skipped: [], unchanged: 2, missing: 0, errors: [] });
    expect(m).toMatchObject({ changes: 0, canApply: false, undeleted: 1 });
  });

  it('группы, число изменений, можно ли применить', () => {
    const m = diffModel({
      project: 'pay',
      dryRun: true,
      applied: false,
      added: [
        { kind: 'method', key: 'pay|GET|/a|', title: 'A' },
        { kind: 'method', key: 'pay|GET|/b|', title: 'B' },
        { kind: 'idType', key: 'card', title: 'Карта' },
      ],
      changed: [{ kind: 'error', key: 'switch|*|||x', title: 'X', fields: ['title'] }],
      hidden: [{ kind: 'system', key: 'old', title: 'Old' }],
      skipped: [{ kind: 'method', key: 'pay|GET|/c|', title: 'C', fields: ['name'] }],
      unchanged: 10,
      missing: 1,
      errors: [],
    });
    expect(m.groups.map((g) => [g.key, g.count])).toEqual([
      ['added', 3],
      ['changed', 1],
      ['hidden', 1],
      ['skipped', 1],
    ]);
    expect(m.groups[0]!.byKind.map((k) => k.kind)).toEqual(['idType', 'method']);
    expect(m).toMatchObject({ changes: 5, canApply: true, forceWouldHelp: true, unchanged: 10, missing: 1 });
  });

  it('ошибки файла — применить нельзя, ошибки по пути', () => {
    const m = diffModel({
      project: 'pay',
      dryRun: true,
      applied: false,
      added: [{ kind: 'method', key: 'k', title: 'K' }],
      changed: [],
      hidden: [],
      skipped: [],
      unchanged: 0,
      missing: 0,
      errors: [
        { path: 'systems.10.methods.0.path', message: 'b' },
        { path: 'systems.2.methods.5.titel', message: 'a' },
      ],
    });
    expect(m.canApply).toBe(false);
    expect(m.errors.map((e) => e.path)).toEqual(['systems.2.methods.5.titel', 'systems.10.methods.0.path']);
  });
});
