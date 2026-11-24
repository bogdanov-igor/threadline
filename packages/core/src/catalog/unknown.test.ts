// «Неизвестное»: ключи, сбор, маскированные примеры без чувствительных данных, предел и уборка.
import { describe, expect, it } from 'vitest';
import { compileCatalog } from './resolve.ts';
import { errorKey } from './schema.ts';
import { exchange, incoming, rec, snapshotFromFile, TEST_FILE } from './test-catalog.ts';
import { clipMasked } from './secure.ts';
import { errorUnknownKey, isCovered, unknownItems, unknownPath, unknownText, unknownTextKey } from './unknown.ts';
import { compileMasking } from '../search/mask-pass.ts';

const snap = snapshotFromFile(TEST_FILE);
const resolver = compileCatalog(snap);
const T0 = Date.UTC(2026, 10, 2, 9, 0, 0);
const U1 = '5a1d0100-0000-4000-8000-000000000001';

describe('нормализация текста', () => {
  it('номер карты, uuid и число от 7 цифр не попадают в пример', () => {
    const t = unknownText(`card 4111111234557893 of user ${U1} order 12345678 failed`);
    expect(t).not.toContain('4111111234557893');
    expect(t).not.toContain(U1);
    expect(t).not.toContain('12345678');
    expect(t).toBe('card 411111******7893 of user … order … failed');
  });

  it('два текста с разными uuid — один ключ; PRC-ERR-0027 и PRC-ERR-0031 — разные', () => {
    expect(unknownTextKey(`User ${U1} not found`)).toBe(unknownTextKey('user 02b0b01f-0000-4000-8000-000000000001 NOT found'));
    expect(unknownTextKey('PRC-ERR-0027')).not.toBe(unknownTextKey('PRC-ERR-0031'));
  });

  it('пример не длиннее 200 символов', () => {
    expect(unknownText('x '.repeat(300)).length).toBeLessThanOrEqual(200);
  });
});

describe('страница HTML в тексте ошибки', () => {
  const PAGE = '<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body><center><h1>502 Bad Gateway</h1></center></body>\r\n</html>\r\n';
  const URL = 'http://switch.pay.example:9191/v9/new';
  const errorOf = (items: ReturnType<typeof unknownItems>) => items.find((i) => i.kind === 'error')!;

  it('в примере заголовок страницы, ключ тот же, что считался от текста со страницей', () => {
    const message = `Failed for Content: ${PAGE}`;
    const err = errorOf(unknownItems(exchange(T0, URL, { resp: { error: { code: 15, message } } }), resolver));
    expect(err.text).toBe('Failed for Content: 502 Bad Gateway');
    const system = resolver.systemByKey('switch')!;
    // Ключ прежней версии: от маскированного и обрезанного текста со страницей.
    expect(err.key).toBe(errorUnknownKey(system.key, null, null, '15', clipMasked(message, 200)));
  });

  it('всё тело страница: в примере её заголовок, ключ от тела', () => {
    const err = errorOf(unknownItems(exchange(T0, URL, { status: 502, resp: PAGE }), resolver));
    expect(err.text).toBe('502 Bad Gateway');
    expect(err.key).toBe(errorUnknownKey(resolver.systemByKey('switch')!.key, null, 502, null, clipMasked(PAGE, 200)));
  });

  it('страница без заголовка: в примере начало её текста, строка не теряется', () => {
    const err = errorOf(unknownItems(exchange(T0, URL, { status: 502, resp: '<html><body><p>oops</p></body></html>' }), resolver));
    expect(err.text).toBe('oops');
    expect(err.httpStatus).toBe(502);
  });

  it('правило по читаемому тексту и правило по коду страницы находят ошибку, примера больше нет', () => {
    const body = { error: { code: 15, message: `Failed for Content: ${PAGE}` } };
    for (const text of ['for Content: 502 Bad Gateway', '<center>']) {
      const file = { ...TEST_FILE, general: { ...TEST_FILE.general, errors: [...TEST_FILE.general.errors, { text, title: 'Шлюз отвечает страницей' }] } };
      const withRule = compileCatalog(snapshotFromFile(file));
      expect(unknownItems(exchange(T0, URL, { resp: body }), withRule).some((i) => i.kind === 'error'), text).toBe(false);
    }
  });
});

describe('сбор', () => {
  it('неизвестный входящий метод — шаблоном пути', () => {
    const items = unknownItems([incoming(T0, 'POST', `/v1/cards/tokens/${U1}?x=1`)], resolver);
    expect(items).toEqual([expect.objectContaining({ kind: 'method', httpMethod: 'POST', path: '/v1/cards/tokens/{token}', systemId: resolver.author!.id })]);
  });

  it('хост без системы — одна запись без ошибок', () => {
    const items = unknownItems([...exchange(T0, 'http://unknown-system.pay.example:8443/a', { status: 500, resp: 'boom' }), ...exchange(T0 + 100, 'http://unknown-system.pay.example:8443/b', { resp: {} })], resolver);
    expect(items).toEqual([expect.objectContaining({ kind: 'host', host: 'unknown-system.pay.example:8443', path: '/a' })]);
  });

  it('метод узнанной системы и ошибка без правила', () => {
    const items = unknownItems(exchange(T0, 'http://switch.pay.example:9191/v9/new', { resp: { error: { code: 999, message: `card 4111111234557893 user ${U1}` } } }), resolver);
    expect(items.map((i) => i.kind).sort()).toEqual(['error', 'method']);
    const err = items.find((i) => i.kind === 'error')!;
    expect(err).toMatchObject({ code: '999', systemId: resolver.systemByKey('switch')!.id });
    expect(err.text).not.toContain('4111111234557893');
  });

  it('фоновый запрос и узнанный метод ничего не дают', () => {
    expect(unknownItems(exchange(T0, 'http://switch.pay.example:9191/v3/cards/info', { resp: { result: {} } }), resolver)).toEqual([]);
  });

  it('ошибка по правилу итога с текстом не собирается; без текста и правила — собирается', () => {
    expect(unknownItems(exchange(T0, 'http://alpha.local/api/pay', { status: 200, resp: { status: 'error', message: 'x', error: 'boom' } }), resolver)).toEqual([]);
    const items = unknownItems(exchange(T0, 'http://delta.local/pay', { status: 200, resp: { status: 'error', error: { code: 77, message: 'odd' } } }), resolver);
    expect(items).toEqual([expect.objectContaining({ kind: 'error', code: '77' })]);
  });

  it('запись WARNING без правила — ошибка проекта', () => {
    const items = unknownItems([incoming(T0, 'POST', '/v1/users'), rec({ kind: 'log', timeMs: T0 + 1, level: 'ERROR', levelNum: 400, message: 'strange failure', context: { code: 'E1' } })], resolver);
    expect(items).toEqual([expect.objectContaining({ kind: 'error', code: 'E1', text: 'strange failure', systemId: resolver.author!.id })]);
  });
});

describe('значения, которые база не примет', () => {
  const URL = 'http://switch.pay.example:9191/v9/new';
  const errorOf = (resp: unknown, status = 200) => unknownItems(exchange(T0, URL, { status, resp }), resolver).find((i) => i.kind === 'error')!;

  it('символ 0 в тексте и коде убран: поле партнёра фиксированной длины', () => {
    const e = errorOf({ error: { code: 'E\u00001', message: 'CARD NOT FOUND\u0000\u0000\u0000' } });
    expect(e.text).toBe('CARD NOT FOUND');
    expect(e.code).toBe('E 1');
    expect(unknownText('Card\u0000not found')).toBe('Card not found');
    expect(JSON.stringify(e)).not.toContain('\\u0000');
  });

  it('символ 0 в пути убран, ключ тот же, что без него', () => {
    expect(unknownPath('/v9/ne\u0000w')).toBe('/v9/new');
  });

  it('HTTP-статус только целый от 100 до 599, иначе пусто', () => {
    for (const bad of [200.5, 3e9, 99, 600, -1]) expect(errorOf({ error: { code: 1, message: 'x' } }, bad).httpStatus, String(bad)).toBeNull();
    expect(errorOf({ error: { code: 1, message: 'x' } }, 502).httpStatus).toBe(502);
  });
});

describe('уборка', () => {
  it('добавили метод — запись покрыта', () => {
    const [item] = unknownItems([incoming(T0, 'POST', '/v1/cards/lookup')], resolver);
    expect(isCovered(item!, resolver)).toBe(false);
    const file = structuredClone(TEST_FILE);
    file.systems[0]!.methods!.push({ http: 'POST', path: '/v1/cards/lookup', name: 'Карты по токенам' } as never);
    expect(isCovered(item!, compileCatalog(snapshotFromFile(file)))).toBe(true);
  });

  it('хост и ошибка', () => {
    const items = unknownItems(exchange(T0, 'http://unknown-system.pay.example:8443/a', { resp: {} }), resolver);
    const file = structuredClone(TEST_FILE);
    file.systems.push({ key: 'new', name: 'Новая', hosts: ['unknown-system.pay.example:8443'] } as never);
    expect(isCovered(items[0]!, compileCatalog(snapshotFromFile(file)))).toBe(true);
    const errs = unknownItems(exchange(T0, 'http://switch.pay.example:9191/v3/cards/info', { resp: { error: { code: 999, message: 'x' } } }), resolver);
    const file2 = structuredClone(TEST_FILE);
    (file2.systems[1] as { errors: unknown[] }).errors.push({ code: '999', title: 'Новая ошибка' });
    expect(isCovered(errs[0]!, compileCatalog(snapshotFromFile(file2)))).toBe(true);
  });
});

describe('подстрока правила и пробелы в тексте', () => {
  const logError = (message: string) => [incoming(T0, 'POST', '/v1/users'), rec({ kind: 'log', timeMs: T0 + 1, level: 'ERROR', levelNum: 400, message })];
  const withRule = (text: string) => {
    const file = structuredClone(TEST_FILE);
    (file.general.errors as unknown[]).push({ text, title: 'Описано' });
    return compileCatalog(snapshotFromFile(file));
  };
  const cases: [string, string, string][] = [
    ['два пробела в логе, один в правиле', '1731 7 ERROR:  duplicate key value', 'ERROR: duplicate key'],
    ['один пробел в логе, два в сохранённом правиле', '1731 7 ERROR: duplicate key value', 'ERROR:  duplicate key'],
    ['две строки в логе', 'first line\r\n  second line', 'first line second line'],
    ['правило с переводом строки', 'first line second line', 'first line\nsecond'],
  ];

  it.each(cases)('%s: шаг описан, строка не собирается и уходит', (_name, message, text) => {
    const records = logError(message);
    const [row] = unknownItems(records, resolver);
    const described = withRule(text);
    expect(row).toMatchObject({ kind: 'error' });
    expect(isCovered(row!, described)).toBe(true);
    expect(unknownItems(records, described)).toEqual([]);
    expect(described.matchError({ systemId: described.author!.id, methodId: null }, { status: null, code: null, text: message })?.rule.title).toBe('Описано');
  });

  it('слова вразрядку и другие слова не совпадают', () => {
    const described = withRule('duplicate key');
    expect(described.matchError({ systemId: null, methodId: null }, { status: null, code: null, text: 'duplicatekey' })).toBeNull();
    expect(described.matchError({ systemId: null, methodId: null }, { status: null, code: null, text: 'd u p l i c a t e key' })).toBeNull();
  });

  it('`\\n` и `\\r` буквами в сыром JSON считаются пробелом', () => {
    const described = withRule('duplicate key value');
    const fact = (text: string) => described.matchError({ systemId: null, methodId: null }, { status: null, code: null, text })?.rule.title;
    expect(fact('ERROR: duplicate key\\nvalue violates')).toBe('Описано');
    expect(fact('ERROR: duplicate\\r\\nkey value')).toBe('Описано');
    expect(fact('ERROR: duplicate keyvalue')).toBeUndefined();
  });

  it('два правила, разные только пробелами, это повтор', () => {
    const key = (text: string) => errorKey(null, null, { http: null, code: null, text });
    expect(key('Duplicate  key\nvalue')).toBe(key('duplicate key value'));
    expect(key('duplicate key')).not.toBe(key('duplicatekey'));
  });

  it('подстрока со скрытой частью строку не покрывает, другое подходящее правило покрывает', () => {
    const row = { kind: 'error' as const, systemId: null, methodId: null, httpMethod: null, path: null, rpc: null, host: null, httpStatus: null, code: null, text: 'карта … не найдена' };
    expect(isCovered(row, withRule('карта … не найдена'))).toBe(false);
    expect(isCovered({ ...row, text: 'имя И***** неверно' }, withRule('И***** неверно'))).toBe(false);
    expect(isCovered(row, withRule('не найдена'))).toBe(true);
    const both = structuredClone(TEST_FILE);
    (both.general.errors as unknown[]).push({ text: 'карта …', title: 'Скрытая' }, { text: 'не найдена', title: 'Настоящая' });
    expect(isCovered(row, compileCatalog(snapshotFromFile(both)))).toBe(true);
  });

  it('текст страницы без тегов тоже сравнивается без лишних пробелов', () => {
    const described = withRule('bad   gateway');
    expect(described.matchError({ systemId: null, methodId: null }, { status: null, code: null, text: '<x>', readable: 'Bad\nGateway' })?.rule.title).toBe('Описано');
  });
});

describe('строка собрана раньше, чем описан метод', () => {
  const URL = 'http://switch.pay.example:9191/v9/new/4f1a';
  const file = () => structuredClone(TEST_FILE) as unknown as { systems: { key: string; methods?: unknown[]; errors?: unknown[] }[]; general: unknown };
  const row = () => unknownItems(exchange(T0, URL, { resp: { error: { code: 999, message: 'x' } } }), resolver).find((i) => i.kind === 'error')!;

  it('правило нового метода покрывает строку без метода', () => {
    const f = file();
    const sw = f.systems.find((s) => s.key === 'switch')!;
    sw.methods!.push({ http: 'POST', path: '/v9/new/{id}', name: 'Новый' });
    expect(row().methodId).toBeNull();
    expect(isCovered(row(), compileCatalog(snapshotFromFile(f)))).toBe(false);
    sw.errors!.push({ method: { http: 'POST', path: '/v9/new/{id}' }, code: '999', title: 'Описано на методе' });
    expect(isCovered(row(), compileCatalog(snapshotFromFile(f)))).toBe(true);
  });

  it('метод с действием находится по действию строки', () => {
    const soap = (rpc: string) => `<soap:Envelope><soap:Body><${rpc}/></soap:Body></soap:Envelope>`;
    const records = exchange(T0, 'http://switch.pay.example:9191/ws', { req: soap('getThing'), resp: { error: { code: 999, message: 'x' } } });
    const item = unknownItems(records, resolver).find((i) => i.kind === 'error')!;
    expect(item.rpc).toBe('getThing');
    const f = file();
    const sw = f.systems.find((s) => s.key === 'switch')!;
    sw.methods!.push({ http: 'POST', path: '/ws', rpc: 'getThing', name: 'С действием' });
    sw.errors!.push({ method: { http: 'POST', path: '/ws', rpc: 'getThing' }, code: '999', title: 'Описано' });
    expect(isCovered(item, compileCatalog(snapshotFromFile(f)))).toBe(true);
  });

  it('правило другого метода строку не покрывает', () => {
    const f = file();
    const sw = f.systems.find((s) => s.key === 'switch')!;
    sw.methods!.push({ http: 'POST', path: '/v8/other', name: 'Другой' });
    sw.errors!.push({ method: { http: 'POST', path: '/v8/other' }, code: '999', title: 'Не то' });
    expect(isCovered(row(), compileCatalog(snapshotFromFile(f)))).toBe(false);
  });
});

describe('значения видов маски в «Неизвестном»', () => {
  it('в базу значение идёт под маской всех видов, в том числе выключенных по умолчанию', () => {
    const { stored, strict } = compileMasking([]);
    expect(unknownText('нет клиента user@example.com', strict)).toContain('user@example.com');
    expect(unknownText('нет клиента user@example.com', stored)).not.toContain('user@example.com');
    expect(unknownText('{"birth_date":"1990-01-01"}', stored)).not.toContain('1990-01-01');
    expect(stored.fields.get('birthdate')).toBe('birth_date');
    expect(stored.kinds.has('email')).toBe(true);
  });

  it('две ошибки с разными телефонами или фамилиями — один ключ, без цифр и букв значения, вид выключен тоже', () => {
    const off = compileMasking([{ type: 'phone', enabled: false, keys: [] }]).strict;
    const a = unknownText('Customer +447700900001 not found', off);
    const b = unknownText('Customer +447700900002 not found');
    expect(a).toBe('Customer … not found');
    expect(a).toBe(b);
    expect(unknownTextKey('{"last_name":"Testerson"} x')).toBe(unknownTextKey('{"last_name":"Johnson"} x'));
    expect(unknownText('{"last_name":"Testerson"}')).not.toContain('T*');
  });

  it('сегмент пути с телефоном и паспортом — подстановка', () => {
    expect(unknownPath('/v1/users/+447700900123/cards')).toBe('/v1/users/{id}/cards');
    expect(unknownPath('/v1/doc/ZZ0000101/x')).toBe('/v1/doc/{id}/x');
  });
});
