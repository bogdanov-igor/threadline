import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ErrorRow } from '@threadline/core/catalog';
import { setRegional } from '@threadline/core/search';
import { checkPath, isMasked, errorDraft, errorModel, errorPrefill, hostValid, idTypeDraft, idTypeModel, methodDraft, methodModel, moveRow, outcomeDraft, outcomeModel, serverFieldErrors, systemDraft, systemModel } from './validate.ts';
import { SNAPSHOT } from './test-snapshot.ts';

// Проверки формы на клиенте: требования «Правка записи», «Проверка текстов записи», «Раздел «Идентификаторы»».

describe('шаблон пути', () => {
  it.each([
    ['cards/{id}', 'pathStart'],
    ['/cards?x=1', 'pathQuery'],
    ['/cards#a', 'pathQuery'],
    ['/cards/id{cardId}', 'pathPlaceholder'],
    ['/cards//x', 'pathEmptySegment'],
    ['', 'required'],
  ])('%s — %s', (path, key) => {
    expect(checkPath(path)).toBe(key);
  });

  it('верные шаблоны', () => {
    expect(checkPath('/')).toBeNull();
    expect(checkPath('/v1/users/{userId}/cards/{cardId}')).toBeNull();
    expect(checkPath('/v1/users/')).toBeNull();
  });
});

describe('метод', () => {
  const base = { systemId: 1, http: 'GET' as const, name: 'Данные карты' };

  it('повтор метода с другими именами подстановок отклонён со ссылкой', () => {
    const r = methodDraft(methodModel({ ...base, path: '/v1/users/{id}/cards/{card}' }), SNAPSHOT);
    expect(r.errors.path).toMatchObject({ key: 'duplicate', id: 1 });
  });

  it('правка той же записи — не повтор', () => {
    const r = methodDraft(methodModel({ ...base, path: '/v1/users/{id}/cards/{card}' }), SNAPSHOT, 1);
    expect(r.errors).toEqual({});
  });

  it('вид «статус операции» без типа операции', () => {
    const r = methodDraft(methodModel({ ...base, path: '/v1/x', kind: 'status' }), SNAPSHOT);
    expect(r.errors.op).toEqual({ key: 'opRequired' });
  });

  it('тип операции — сущность', () => {
    const r = methodDraft(methodModel({ ...base, path: '/v1/x', kind: 'start', op: 'user' }), SNAPSHOT);
    expect(r.errors.op).toEqual({ key: 'opNotOperation' });
  });

  it('поле id с неизвестным типом', () => {
    const r = methodDraft(methodModel({ ...base, path: '/v1/x', fields: [{ in: 'request', path: 'remote_transfer_id', type: 'payout' }] }), SNAPSHOT);
    expect(r.errors['fields.0.type']).toEqual({ key: 'unknownType' });
  });

  it('перевод статуса — только в значения словаря', () => {
    const m = { ...methodModel({ ...base, path: '/v1/x', kind: 'status', op: 'transfer' }), status: true, statusPath: 'state' };
    const ok = methodDraft({ ...m, statusMap: [{ key: 'a', from: 'complete', to: 'completed' }] }, SNAPSHOT);
    expect(ok.errors).toEqual({});
    expect(ok.draft.status).toEqual({ in: 'response', path: 'state', map: { complete: 'completed' } });
    const bad = methodDraft({ ...m, statusMap: [{ key: 'a', from: 'complete', to: 'done' }] }, SNAPSHOT);
    expect(bad.errors['statusMap.0.to']).toEqual({ key: 'statusNotInType' });
  });

  it('поле статуса без типа операции не уходит на сервер и не держит форму', () => {
    const r = methodDraft({ ...methodModel({ ...base, path: '/v1/x', name: 'x' }), status: true, statusPath: 'state' }, SNAPSHOT);
    expect(r.errors).toEqual({});
    expect(r.draft.status).toBeNull();
  });

  it('поля-секреты в id и статусе отклонены у поля', () => {
    const op = SNAPSHOT.idTypes.find((t) => t.kind === 'operation')!;
    const m = { ...methodModel({ ...base, path: '/v1/x', name: 'x', op: op.key }), status: true, statusPath: 'data.cvv', fields: [{ key: 'a', in: 'request' as const, path: 'password', type: op.key }] };
    const r = methodDraft(m, SNAPSHOT);
    expect(r.errors.statusPath).toEqual({ key: 'sensitive' });
    expect(r.errors['fields.0.path']).toEqual({ key: 'sensitive' });
  });

  it('длина названия', () => {
    expect(methodDraft(methodModel({ ...base, path: '/v1/x', name: 'я'.repeat(81) }), SNAPSHOT).errors.name).toEqual({ key: 'tooLong', max: 80 });
  });
});

describe('ошибка', () => {
  it('без HTTP-статуса, кода и подстроки отклонена', () => {
    expect(errorDraft(errorModel({ systemId: 2, title: 'Карта не найдена' })).errors.conditions).toEqual({ key: 'noErrorConditions' });
  });

  it('номер карты в подстроке отклонён', () => {
    expect(errorDraft(errorModel({ systemId: 2, title: 'x', text: 'card 4111111111111111 not found' })).errors.text).toEqual({ key: 'masked' });
  });

  it('скрытая часть в подстроке отклонена, одна звёздочка нет', () => {
    for (const text of ['card … not found', 'card 400012******3456 not found', 'name И***** bad']) expect(errorDraft(errorModel({ systemId: 2, title: 'x', text })).errors.text, text).toEqual({ key: 'textHidden' });
    expect(errorDraft(errorModel({ systemId: 2, title: 'x', text: 'select * from cards' })).errors.text).toBeUndefined();
  });

  it('подстрока короче трёх символов', () => {
    expect(errorDraft(errorModel({ systemId: 2, title: 'x', text: 'ab' })).errors.text).toEqual({ key: 'textMatchLength' });
  });

  it('разметка в тексте — просто текст', () => {
    const r = errorDraft(errorModel({ systemId: 2, code: '1', title: '<b>карта</b>' }));
    expect(r.errors).toEqual({});
    expect(r.draft.title).toBe('<b>карта</b>');
  });

  it('пустые необязательные поля — null', () => {
    expect(errorDraft(errorModel({ systemId: null, http: 504, title: 'Нет ответа' })).draft).toMatchObject({ systemId: null, methodId: null, http: 504, code: null, text: null, action: null });
  });

  it('общее правило только с HTTP-статусом: отказ у подстроки, код или подстрока его снимают', () => {
    expect(errorDraft(errorModel({ systemId: null, http: 500, title: 'Сбой' })).errors).toEqual({ text: { key: 'generalHttpOnly' } });
    expect(errorDraft(errorModel({ systemId: null, http: 500, code: '15', title: 'Сбой' })).errors).toEqual({});
    expect(errorDraft(errorModel({ systemId: null, http: 500, text: 'gateway timeout', title: 'Сбой' })).errors).toEqual({});
    expect(errorDraft(errorModel({ systemId: null, code: '15', title: 'Сбой' })).errors).toEqual({});
    expect(errorDraft(errorModel({ systemId: 2, http: 500, title: 'Сбой' })).errors).toEqual({});
  });

  it('такая запись из файла правится, пока статус тот же', () => {
    const was = { systemId: null, http: 504, code: null, text: null } as ErrorRow;
    expect(errorDraft(errorModel({ systemId: null, http: 504, title: 'Новый текст' }), was).errors).toEqual({});
    expect(errorDraft(errorModel({ systemId: null, http: 502, title: 'Новый текст' }), was).errors).toEqual({ text: { key: 'generalHttpOnly' } });
    // Запись с подстрокой не становится записью только со статусом.
    expect(errorDraft(errorModel({ systemId: null, http: 504, title: 'Новый текст' }), { ...was, text: 'timeout' }).errors).toEqual({ text: { key: 'generalHttpOnly' } });
  });
});

describe('условия новой ошибки из шага и «Неизвестного»', () => {
  const draft = { systemId: 2, methodId: null, http: 500, code: '8' };

  it('запись на системе: код и статус, подстрока пустая', () => {
    expect(errorPrefill(draft, 'Card not found', false)).toEqual({ ...draft, text: null });
  });

  it('общая запись: подстрока из примера, одного кода мало', () => {
    expect(errorPrefill({ ...draft, systemId: null }, 'PRC-ERR-0027 Card not found', true)).toMatchObject({ systemId: null, code: '8', text: 'PRC-ERR-0027 Card not found' });
  });

  it('других условий нет: подстрока из примера и на системе', () => {
    expect(errorPrefill({ systemId: 2, http: null, code: null }, 'deadlock detected', false)).toMatchObject({ text: 'deadlock detected' });
  });

  it('код под маской или с «…» не подставляется: с настоящим кодом он не совпадёт', () => {
    expect(errorPrefill({ ...draft, code: 'ERR-…' }, 'x', false).code).toBeNull();
    expect(errorPrefill({ ...draft, code: '411111******7893' }, 'x', false).code).toBeNull();
  });

  it('пример под маской, короткий или без текста: подстрока пустая, человек заполнит сам', () => {
    for (const sample of ['Gateway refused client …', 'Client +44********77 refused', 'ab', '', null, undefined]) {
      expect(errorPrefill(draft, sample, true).text).toBeNull();
    }
  });

  it('из примера берётся первая строка в пределах поля', () => {
    expect(errorPrefill(draft, 'first line\nsecond line', true).text).toBe('first line');
    expect(errorPrefill(draft, 'x'.repeat(300), true).text).toHaveLength(200);
  });

  it('запись из раздела без шага: ничего не добавляется', () => {
    expect(errorModel(errorPrefill({ systemId: null }, undefined, true))).toMatchObject({ systemId: null, http: '', code: '', text: '' });
  });
});

describe('система', () => {
  it('хост уже у коммутатора', () => {
    const r = systemDraft({ ...systemModel(), key: 'acquirer', name: 'Эквайер', hosts: 'switch.pay.example:9191' }, SNAPSHOT);
    expect(r.errors.hosts).toMatchObject({ key: 'hostTaken', name: 'Коммутатор' });
  });

  it('неверный ключ и повтор ключа', () => {
    expect(systemDraft({ ...systemModel(), key: 'Switch!', name: 'x' }, SNAPSHOT).errors.key).toEqual({ key: 'keySystem' });
    expect(systemDraft({ ...systemModel(), key: 'switch', name: 'x' }, SNAPSHOT).errors.key).toMatchObject({ key: 'keyTaken', id: 2 });
  });

  it('хосты строками и через запятую, в нижнем регистре', () => {
    const r = systemDraft({ ...systemModel(), key: 'acquirer', name: 'Эквайер', hosts: 'API.Acquirer.example:443\n*.partner.example, 192.0.2.1' }, SNAPSHOT);
    expect(r.errors).toEqual({});
    expect(r.draft.hosts).toEqual(['api.acquirer.example:443', '*.partner.example', '192.0.2.1']);
  });
});

describe('тип id', () => {
  it('повтор ключа со ссылкой на существующий', () => {
    expect(idTypeDraft(idTypeModel({ key: 'transfer', kind: 'operation', name: 'x' }), SNAPSHOT).errors.key).toMatchObject({ key: 'keyTaken', id: 3 });
  });

  it('у сущности словаря нет', () => {
    const r = idTypeDraft(idTypeModel({ key: 'account', kind: 'entity', name: 'Счёт', statuses: [{ value: 'a', name: 'A', outcome: 'pending' }] }), SNAPSHOT);
    expect(r.draft.statuses).toEqual([]);
  });

  it('повтор статуса без учёта регистра', () => {
    const r = idTypeDraft(
      idTypeModel({
        key: 'merchant_payment',
        kind: 'operation',
        name: 'Оплата у партнёра',
        statuses: [
          { value: 'new', name: 'Новый', outcome: 'pending' },
          { value: 'NEW', name: 'Снова', outcome: 'pending' },
        ],
      }),
      SNAPSHOT,
    );
    expect(r.errors['statuses.1.value']).toEqual({ key: 'valueDuplicate' });
  });

  it('перенос статуса выше', () => {
    expect(moveRow(['holding', 'held', 'confirmed'], 1, -1)).toEqual(['held', 'holding', 'confirmed']);
    expect(moveRow(['a', 'b'], 0, -1)).toEqual(['a', 'b']);
  });
});

describe('правило итога', () => {
  it('из шага: правило метода с HTTP 422', () => {
    const m = outcomeModel({ systemId: 2, methodId: 3, when: { http: 422 } });
    expect(m.level).toBe('method');
    const r = outcomeDraft(m);
    expect(r.errors).toEqual({});
    expect(r.draft).toMatchObject({ systemId: 2, methodId: 3, priority: 100, when: { http: 422 }, outcome: 'success' });
  });

  it('приоритет от 1 до 1000', () => {
    expect(outcomeDraft({ ...outcomeModel({ systemId: 2, when: { http: 200 } }), priority: '1001' }).errors.priority).toEqual({ key: 'priorityRange' });
  });

  it('без условий отклонено', () => {
    expect(outcomeDraft(outcomeModel({ systemId: 2 })).errors.conditions).toMatchObject({ key: 'noConditions' });
  });

  it('уровень «весь проект» снимает систему и метод', () => {
    const r = outcomeDraft({ ...outcomeModel({ systemId: 2, methodId: 3, when: { http: 200 } }), level: 'general' });
    expect(r.draft).toMatchObject({ systemId: null, methodId: null });
  });
});

describe('ошибки сервера на полях', () => {
  it('пути API — в поля формы', () => {
    expect(serverFieldErrors({ 'when.fields.0.regex': 'x', 'status.map.complete': 'y', 'hosts.1': 'z', 'when.http': 'h' })).toEqual({
      'fields.0.value': 'x',
      statusMap: 'y',
      hosts: 'z',
      'http.equals': 'h',
    });
  });

  it('любая проверка условия ложится на поле значения, путь — на поле пути', () => {
    expect(serverFieldErrors({ 'when.fields.1.equals': 'a', 'when.fields.2.oneOf.3': 'b', 'when.fields.4.path': 'c' })).toEqual({
      'fields.1.value': 'a',
      'fields.2.value': 'b',
      'fields.4.path': 'c',
    });
  });
});

describe('хосты как на сервере', () => {
  it('подчёркивание в имени контейнера, порт, ipv6, домен', () => {
    for (const h of ['card_switch:8080', 'db', 'switch.pay.example:9191', '[fd00::1]:8080', '*.acquirer.example']) expect(hostValid(h)).toBe(true);
    for (const h of ['http://x/y', 'a b', 'host:99999', '*.example']) expect(hostValid(h)).toBe(false);
  });

  it('хост скрытой системы свободен', () => {
    const owner = { ...SNAPSHOT.systems[0]!, id: 900, key: 'old', hosts: ['free.pay.example'], hidden: true };
    const s = { ...SNAPSHOT, systems: [...SNAPSHOT.systems, owner] };
    expect(systemDraft(systemModel({ key: 'next', name: 'Новая', hosts: ['free.pay.example'] }), s).errors.hosts).toBeUndefined();
    const live = { ...s, systems: [...SNAPSHOT.systems, { ...owner, hidden: false }] };
    expect(systemDraft(systemModel({ key: 'next', name: 'Новая', hosts: ['free.pay.example'] }), live).errors.hosts?.key).toBe('hostTaken');
  });
});

describe('правило итога: поля-секреты', () => {
  const rule = (text: string, path: string, check: 'equals' | 'exists') => {
    const m = outcomeModel({ systemId: 1, methodId: null, when: check === 'exists' ? { fields: [{ path, exists: true }] } : { fields: [{ path, equals: 'x' }] }, outcome: 'error', text });
    return outcomeDraft(m).errors;
  };

  it('шаблон и условие со значением отклонены, «есть» — нет', () => {
    expect(rule('{password} {access_token}', 'status', 'equals').text).toEqual({ key: 'templateSensitive' });
    expect(rule('{message}', 'status', 'equals').text).toBeUndefined();
    expect(rule('', 'pin', 'equals')['fields.0.path']).toEqual({ key: 'sensitive' });
    expect(rule('', 'pin', 'exists')['fields.0.path']).toBeUndefined();
  });
});

describe('значения видов маски в форме', () => {
  it('телефон и счёт отклоняются, слово из словаря принято', () => {
    for (const v of ['+447700900001', 'x GB29NWBK60161331926819']) expect(isMasked(v), v).toBe(true);
    for (const v of ['invalid document: wrong expiry', 'Invalid phone: must be 12 digits', '447700900001', 'x ZZ0000001']) expect(isMasked(v), v).toBe(false);
  });

  describe('с региональными правилами демо-проекта', () => {
    beforeAll(() => setRegional({ phone: { countryCode: '44', nationalDigits: 10, trunkPrefix: '0' }, patterns: { passport: ['[A-Z]{2}\\d{7}'], national_id: ['[A-Z]{2}\\d{6}[A-D]'] } }));
    afterAll(() => setRegional(null));

    it('телефон без плюса, паспорт и личный номер отклоняются', () => {
      for (const v of ['447700900001', 'x ZZ0000001', 'ZZ000101A']) expect(isMasked(v), v).toBe(true);
      expect(isMasked('invalid document: wrong expiry')).toBe(false);
    });
  });
});
