// Правила справочника не открывают то, что скрывает маскирование: поля-секреты, обрезка до маски, файл и схема.
import { describe, expect, it } from 'vitest';
import { buildView, markPending, maskDeep, summarize, type ViewRecord } from '../search/index.ts';
import { annotateRecords, finalizeSummary } from './annotate.ts';
import { parseBody } from './body.ts';
import { EMPTY_KNOWN, readCatalogFile } from './file.ts';
import { hostOf, uriParts } from './host.ts';
import { stepIds, stepStatus } from './ids.ts';
import { operationKeysOf } from '../flow/facts.ts';
import { compileMasking } from '../search/mask-pass.ts';
import { renderTemplate } from './outcome.ts';
import { parseTemplate } from './path.ts';
import { compileCatalog } from './resolve.ts';
import { checkIdType, checkMethod, checkOutcome, checkSystem, toMethodData, toOutcomeData } from './schema.ts';
import { clipMasked, maskField, sensitivePath } from './secure.ts';
import { exchange, incoming, rec, snapshotFromFile, TEST_FILE } from './test-catalog.ts';
import { isCovered, unknownItems, unknownPath } from './unknown.ts';

const PAN = '4111111234557893';
const T0 = Date.UTC(2026, 10, 2, 9, 0, 0);
const OPTS = { match: 'exact' as const, readEndMs: T0 + 600_000, incomplete: false };
const CID = 'c0ffee00-0000-4000-8000-000000000001';
const SECRET = 'SYNTHSECRET0123456789';
const NOKEEP = new Set<string>();

describe('чтение поля по имени', () => {
  it('секрет на любом уровне пути, номер карты — последним именем, регистр и префикс XML не важны', () => {
    for (const p of ['password', 'data.Password', 'ns2:pin', 'access_token', 'client_secret', 'authorization', 'Proxy-Authorization', '@cvv', 'password.value']) expect(sensitivePath(p)).toBe('secret');
    for (const p of ['pan', 'data.cardNumber', 'ns:PrimaryAccountNumber']) expect(sensitivePath(p)).toBe('pan');
    for (const p of ['status', 'data.transfer_id', 'pan.state', 'message']) expect(sensitivePath(p)).toBeNull();
  });

  it('значение по правилам имени; прочие значения не меняются', () => {
    expect(maskField('data.password', SECRET)).toBe('***');
    expect(maskField('authorization', `Bearer ${SECRET}`)).toBe('Bearer ***');
    expect(maskField('primaryAccountNumber', '1234567890123')).toBe('123456***0123');
    expect(maskField('Value', '1234567890123')).toBe('123456***0123');
    // Id сравнивается как есть: номер, похожий на карту, маскируется на выходе вместе с ответом.
    expect(maskField('transfer_id', PAN)).toBe(PAN);
  });
});

describe('поля-секреты в разметке', () => {
  const body = parseBody(JSON.stringify({ password: SECRET, access_token: SECRET, pin: '1234', cvv: '321', primaryAccountNumber: '1234567890123', status: 'ok', message: 'hi' }));
  const types = new Map([['t', { kind: 'operation' as const, name: 'T' }]]);

  it('шаблон: секрет — ***, номер без проверки Луна — маска', () => {
    const text = renderTemplate('{password} {access_token} {pin} {primaryAccountNumber} {message}', body);
    expect(text).toBe('*** *** *** 123456***0123 hi');
  });

  it('id и статус: значение скрыто', () => {
    const ids = stepIds(
      [],
      [],
      [
        { in: 'response', path: 'access_token', type: 't' },
        { in: 'response', path: 'primaryAccountNumber', type: 't' },
      ],
      { query: null, request: { kind: 'none' }, response: body },
      types,
    );
    expect(ids.map((i) => i.value)).toEqual(['***', '123456***0123']);
    const status = stepStatus('t', { in: 'response', path: 'cvv' }, { query: null, request: { kind: 'none' }, response: body }, new Map());
    expect(status).toMatchObject({ value: '***', raw: '***' });
  });

  it('параметр строки запроса и тег XML', () => {
    const xml = parseBody(`<a><ns:password>${SECRET}</ns:password></a>`);
    expect(renderTemplate('{ns:password}', xml)).toBe('***');
    const ids = stepIds([], [], [{ in: 'query', path: 'client_secret', type: 't' }], { query: `client_secret=${SECRET}`, request: { kind: 'none' }, response: { kind: 'none' } }, types);
    expect(ids[0]!.value).toBe('***');
  });
});

describe('обрезка после маскирования', () => {
  const resolver = compileCatalog(snapshotFromFile(TEST_FILE));

  /** Значение начинается перед 200-м символом и кончается за ним. */
  const padded = (open: string, value: string, close: string) => `${'x'.repeat(200 - open.length - 5)}${open}${value}${close}`;

  const shown = (body: string) => {
    const records = [incoming(T0, 'POST', '/v1/users'), ...exchange(T0 + 10, 'http://unknown-x.example/a', { status: 500, resp: body })];
    const view = annotateRecords(markPending(buildView(records, { withOffsets: true }), OPTS), resolver);
    const resp = view.find((r: ViewRecord) => r.kind === 'response')!;
    const final = finalizeSummary(summarize(CID, records, OPTS), records, resolver, OPTS);
    return JSON.stringify([resp.catalog?.error?.raw, final.reasons.map((r) => r.error?.raw)]);
  };

  it('секрет, номер карты и тег XML на границе 200 символов не уходят даже началом', () => {
    for (const body of [
      `{"pad":"${padded('"client_secret":"', 'x', '')}","client_secret":"${SECRET}"}`,
      `{"note":"x","password":"${SECRET}"}`.padStart(205, ' '),
      padded('<password>', SECRET, '</password>'),
      padded('"cardNumber":"', PAN, '"'),
      padded('card ', PAN, ' end'),
    ]) {
      const out = shown(body);
      expect(out).not.toContain(SECRET.slice(0, 5));
      expect(out).not.toContain(PAN.slice(0, 12));
    }
  });

  it('шаблон {message}: номер и секрет на границе', () => {
    const body = (message: string) => parseBody(JSON.stringify({ message }));
    expect(renderTemplate('{message}', body(`${'x'.repeat(190)} ${PAN} end`))).not.toContain(PAN.slice(0, 12));
    const json = JSON.stringify({ client_secret: SECRET });
    expect(renderTemplate('{message}', body(`${'x'.repeat(170)}${json}`))).not.toContain(SECRET.slice(0, 5));
  });

  it('clipMasked: длинная строка режется только после маски', () => {
    expect(clipMasked(`${'x'.repeat(195)}${PAN}`, 200)).toBe(`${'x'.repeat(195)}41111`);
    expect(clipMasked(`${'x'.repeat(190)}${PAN}`, 200)).toBe(`${'x'.repeat(190)}411111****`);
  });
});

describe('схема и файл не принимают такие пути', () => {
  const idTypes = new Map([['t', { kind: 'operation' as const, statuses: [] }]]);
  const method = (o: object) =>
    checkMethod(toMethodData({ http: 'GET', path: '/x', name: 'x', ...o } as never), { system: { kind: 'external', type: 'service' }, idTypes });
  const rule = (o: object) => checkOutcome(toOutcomeData({ when: { http: 200 }, outcome: 'error', ...o } as never));

  it('поля id и статуса', () => {
    expect(method({ fields: [{ in: 'request', path: 'password', type: 't' }] }).map((i) => i.path)).toEqual(['fields.0.path']);
    expect(method({ fields: [{ in: 'response', path: 'data.cardNumber', type: 't' }] }).map((i) => i.path)).toEqual(['fields.0.path']);
    expect(method({ op: 't', status: { in: 'response', path: 'cvv' } }).map((i) => i.path)).toEqual(['status.path']);
  });

  it('шаблон и условия правила: «есть» допустимо, значение — нет', () => {
    expect(rule({ text: '{password} {access_token}' }).map((i) => i.path)).toEqual(['text']);
    expect(rule({ when: { fields: [{ path: 'pin', equals: '1' }] } }).map((i) => i.path)).toEqual(['when.fields.0.path']);
    expect(rule({ when: { fields: [{ path: 'authorization', regex: '^B' }] } }).map((i) => i.path)).toEqual(['when.fields.0.path']);
    expect(rule({ when: { fields: [{ path: 'password', exists: true }] } })).toEqual([]);
    expect(rule({ text: '{message}' })).toEqual([]);
  });

  it('файл с полями-секретами в id, статусе и тексте отклонён с путями', () => {
    const r = readCatalogFile(
      {
        version: 1,
        project: 'pay',
        idTypes: [{ key: 't', kind: 'operation', name: 'T' }],
        systems: [
          {
            key: 'a',
            name: 'A',
            methods: [{ http: 'GET', path: '/x', name: 'x', op: 't', fields: [{ in: 'request', path: 'password', type: 't' }], status: { in: 'response', path: 'cvv' } }],
            outcomes: [{ when: { http: 200 }, outcome: 'error', text: '{password} {access_token} {pin}' }],
          },
        ],
      },
      'pay',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.path).sort()).toEqual(['systems.0.methods.0.fields.0.path', 'systems.0.methods.0.status.path', 'systems.0.outcomes.0.text']);
  });

  it('key, hosts и rpc проверяются маской', () => {
    expect(checkSystem({ key: PAN, kind: 'external', type: 'service', name: 'x', hosts: [`${PAN}.pay.example`], description: null }, { project: 'pay', otherHosts: new Map() }).map((i) => i.path).sort()).toEqual(['hosts.0', 'key']);
    expect(checkIdType({ key: `a${PAN}`, kind: 'entity', name: 'x', statuses: [] }).map((i) => i.path)).toEqual(['key']);
    expect(method({ rpc: PAN }).map((i) => i.path)).toEqual(['rpc']);
  });
});

describe('ошибки файла без значений', () => {
  it('ссылка на метод, ключ типа и перевод статуса: номера карты нет ни в сообщении, ни в пути', () => {
    const r = readCatalogFile(
      {
        version: 1,
        project: 'pay',
        idTypes: [{ key: 't', kind: 'operation', name: 'T' }],
        systems: [
          {
            key: 'a',
            name: 'A',
            methods: [{ http: 'GET', path: '/x', name: 'x', op: 't', fields: [{ in: 'request', path: 'id', type: `a${PAN}` }], status: { in: 'response', path: 'state', map: { [PAN]: PAN } } }],
            errors: [{ method: { http: 'POST', path: `/v1/card/${PAN}` }, code: '1', title: 'x' }],
          },
        ],
      },
      'pay',
    );
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(PAN);
  });
});

describe('инварианты файла', () => {
  const AUTHOR = { key: 'pay', kind: 'project', name: 'Demo Pay' };
  const errorsOf = (file: object, known = EMPTY_KNOWN) => {
    const r = readCatalogFile({ version: 1, project: 'pay', ...file }, 'pay', known);
    return r.ok ? [] : r.errors.map((e) => e.path);
  };

  it('система с ключом проекта без kind: project и скрытый автор отклонены', () => {
    expect(errorsOf({ systems: [{ key: 'pay', name: 'Demo Pay' }] })).toEqual(['systems.0.kind']);
    expect(errorsOf({ systems: [{ ...AUTHOR, hidden: true }] })).toEqual(['systems.0.hidden']);
    expect(errorsOf({ systems: [AUTHOR] })).toEqual([]);
  });

  it('тип с методами не скрыть: метод из файла и метод из базы', () => {
    const idType = { key: 't', kind: 'entity', name: 'T', hidden: true };
    const m = { http: 'GET', path: '/x', name: 'x', fields: [{ in: 'request', path: 'id', type: 't' }] };
    expect(errorsOf({ idTypes: [idType], systems: [{ key: 'a', name: 'A', methods: [m] }] })).toEqual(['idTypes.0.hidden']);
    expect(errorsOf({ idTypes: [idType], systems: [{ key: 'a', name: 'A', methods: [{ ...m, hidden: true }] }] })).toEqual([]);
    expect(errorsOf({ idTypes: [idType] }, { ...EMPTY_KNOWN, typeUses: new Map([['t', 4]]) })).toEqual(['idTypes.0.hidden']);
    expect(errorsOf({ idTypes: [idType] })).toEqual([]);
  });

  it('тип системы с методами в базе не сменить на базу или шину', () => {
    const known = { ...EMPTY_KNOWN, systemMethods: new Map([['a', 2]]) };
    expect(errorsOf({ systems: [{ key: 'a', type: 'database', name: 'A' }] }, known)).toEqual(['systems.0.type']);
    expect(errorsOf({ systems: [{ key: 'a', type: 'queue', name: 'A' }] })).toEqual([]);
  });
});

describe('«Неизвестное»: только маскированные значения', () => {
  const resolver = compileCatalog(snapshotFromFile(TEST_FILE));
  const LUHN_OK = '4111-1112-3455-7893';
  const JWT_LIKE = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SYNTHSIGNATURE';

  it('сегменты с данными в пути становятся подстановкой', () => {
    expect(unknownPath(`/v1/card/${LUHN_OK}/info`)).toBe('/v1/card/{id}/info');
    expect(unknownPath(`/v1/card/${PAN}.json`)).toBe('/v1/card/{id}');
    expect(unknownPath(`/v1/card/pan_${PAN}/info`)).toBe('/v1/card/{id}/info');
    expect(unknownPath('/reset/password=abc123/x')).toBe('/reset/{id}/x');
    expect(unknownPath('/v1/users/+447700900123/cards')).toBe('/v1/users/{id}/cards');
    expect(unknownPath(`/v1/t/${JWT_LIKE}/x`)).toBe('/v1/t/{id}/x');
    expect(unknownPath('/v1/x;token=SYNTHTOKEN/y')).toBe('/v1/{id}/y');
    expect(unknownPath('/v1/SYNTHPATHTOKENabcdefghijklmnop/x')).toBe('/v1/{id}/x');
    expect(unknownPath('/v1/a1b2c3d4e5f6g7h8i9/x')).toBe('/v1/{id}/x');
    expect(unknownPath('/v1/card%204111111234557893/x')).toBe('/v1/{id}/x');
    expect(unknownPath(`/v1/users/${'01a00000-0000-4000-8000-000000000001'}/cards/${PAN}`)).toBe('/v1/users/{user}/cards/{card}');
  });

  it('имя подстановки не берётся из сегмента с данными', () => {
    expect(unknownPath(`/SYNTHPATHTOKENabcdefghijklmnop/${PAN}/x`)).toBe('/{id}/{id2}/x');
  });

  it('обычные сегменты остаются', () => {
    for (const p of ['/v1.0/transit/payment/check', '/3ds2/authentication', '/v1/orders/12345', '/getUserTransactionsByCardId', '/oauth2/token', '/get-user-card-info']) expect(unknownPath(p)).toBe(p);
  });

  const all = (items: unknown) => JSON.stringify(items);

  it('путь, код, действие и хост без значений; ключ от маскированных значений', () => {
    const a = unknownItems(exchange(T0, `http://switch.pay.example:11101/v9/card-${PAN}/x`, { req: { jsonrpc: '2.0', method: `card.get ${PAN}` }, resp: { error: { code: PAN, message: `card ${PAN}` } } }), resolver);
    const b = unknownItems(exchange(T0, 'http://switch.pay.example:11101/v9/card-4111111234550003/x', { req: { jsonrpc: '2.0', method: 'card.get 4111111234550003' }, resp: { error: { code: '4111111234550003', message: 'card 4111111234550003' } } }), resolver);
    expect(all(a)).not.toContain(PAN);
    expect(a.map((i) => i.path)).toEqual(['/v9/{id}/x', '/v9/{id}/x']);
    expect(a.find((i) => i.kind === 'method')!.rpc).toBe('card.get 411111******7893');
    // Разные значения, одна запись: ключ считается уже без них. Номера разные и по Луну различаются маской, а числа — нет.
    expect(b[1]!.path).toBe(a[1]!.path);
  });

  it('объектный код не сохраняется, пароль и номер из него не попадают в строку', () => {
    const items = unknownItems(exchange(T0, 'http://switch.pay.example:11101/v3/cards/info', { resp: { error: { code: { password: SECRET, pan: PAN }, message: 'boom' } } }), resolver);
    const err = items.find((i) => i.kind === 'error')!;
    expect(err.code).toBeNull();
    expect(all(items)).not.toContain(SECRET);
    expect(all(items)).not.toContain(PAN);
  });

  it('код из контекста записи приложения', () => {
    const items = unknownItems([incoming(T0, 'POST', '/v1/users'), rec({ kind: 'log', timeMs: T0 + 1, level: 'ERROR', levelNum: 400, message: 'strange failure', context: { code: PAN } })], resolver);
    expect(all(items)).not.toContain(PAN);
  });

  it('хост с номером и обрезок пароля в authority', () => {
    expect(all(unknownItems(exchange(T0, `http://x${PAN}.pay.example:1/a`, { resp: {} }), resolver))).not.toContain(PAN);
    // Пароль с косой чертой кончается на последнем @: хост настоящий, пароля в строке нет.
    const slash = unknownItems(exchange(T0, 'https://svc:SYNTHSLASH/PASS@unknown-b.example:443/x', { resp: {} }), resolver);
    expect(slash.map((i) => [i.host, i.path])).toEqual([['unknown-b.example:443', '/x']]);
    expect(all(slash)).not.toContain('SYNTHSLASH');
    // Обрезок: host:пароль/… без @ — хоста нет, в «Неизвестное» такая строка не идёт.
    expect(unknownItems(exchange(T0, 'https://svc:SYNTHSLASH/PASS/x', { resp: {} }), resolver)).toEqual([]);
    const items = unknownItems(exchange(T0, 'https://svc:SYNTH@URIPASS@unknown-a.example:443/x', { resp: {} }), resolver);
    expect(items.map((i) => i.host)).toEqual(['unknown-a.example:443']);
  });

  it('текст: секрет на границе 200 символов не попадает в пример', () => {
    const items = unknownItems(exchange(T0, 'http://switch.pay.example:11101/v3/cards/info', { status: 500, resp: `{"pad":"${'x'.repeat(170)}","client_secret":"${SECRET}"}` }), resolver);
    expect(all(items)).not.toContain(SECRET.slice(0, 5));
  });
});

describe('учётные данные в адресе', () => {
  it('uriParts и hostOf берут последний @; не порт — адрес не разобран', () => {
    expect(uriParts('https://svc:SYNTH@URIPASS@unknown-a.example:443/x')).toMatchObject({ host: 'unknown-a.example', port: '443', path: '/x' });
    expect(hostOf('https://svc:SYNTH@URIPASS@unknown-a.example:443/x')).toBe('unknown-a.example');
    expect(uriParts('https://svc:SYNTHSLASH/PASS@unknown-b.example:443/x')).toMatchObject({ host: 'unknown-b.example', port: '443', path: '/x' });
    expect(hostOf('https://svc:SYNTHSLASH/PASS@unknown-b.example:443/x')).toBe('unknown-b.example');
    expect(uriParts('https://svc:SYNTHSLASH/PASS/x')).toMatchObject({ host: null, invalid: true });
    expect(hostOf('https://svc:SYNTHSLASH/PASS/x')).toBeNull();
    expect(uriParts('https://switch.example:443/x').invalid).toBeUndefined();
    expect(uriParts('http://[fd00::1]:8080').invalid).toBeUndefined();
  });

  it('вход: правило ошибки с HTTP ниже 400 сравнивается с настоящим статусом', () => {
    const file = structuredClone(TEST_FILE) as unknown as { systems: { key: string; errors?: unknown[] }[] };
    file.systems.find((s) => s.key === 'switch')!.errors!.push({ http: 200, code: '12', title: 'Код 12 при HTTP 200' });
    const resolver = compileCatalog(snapshotFromFile(file));
    const sw = resolver.systemByKey('switch')!;
    const records = exchange(T0, 'http://switch.pay.example:11101/v3/cards/info', { resp: { error: { code: 12, message: 'boom' } } });
    expect(unknownItems(records, resolver).filter((i) => i.kind === 'error')).toEqual([]);
    const final = finalizeSummary(summarize(CID, records, OPTS), records, resolver, OPTS);
    expect(final.reasons[0]!.error).toMatchObject({ source: 'external', title: 'Код 12 при HTTP 200' });
    // Строка «Неизвестного» с HTTP 200 покрывается этим правилом и уходит.
    expect(isCovered({ kind: 'error', systemId: sw.id, methodId: null, httpMethod: 'POST', path: '/v3/cards/info', rpc: null, host: null, httpStatus: 200, code: '12', text: 'boom' }, resolver)).toBe(true);
    expect(resolver.matchError({ systemId: sw.id, methodId: null }, { status: 500, code: '12', text: null })?.rule.title).not.toBe('Код 12 при HTTP 200');
    expect(resolver.matchError({ systemId: sw.id, methodId: null }, { status: null, code: '12', text: null })?.rule.title).not.toBe('Код 12 при HTTP 200');
  });
});

describe('маска для вывода', () => {
  it('ответ после maskDeep не содержит значения', () => {
    const resolver = compileCatalog(snapshotFromFile(TEST_FILE));
    const records = exchange(T0, 'http://switch.pay.example:11101/v3/cards/info', { status: 500, resp: `<password>${SECRET}</password>` });
    const view = annotateRecords(markPending(buildView(records, { withOffsets: true }), OPTS), resolver);
    expect(JSON.stringify(maskDeep(view, NOKEEP))).not.toContain(SECRET);
  });
});

describe('пример пути «Неизвестного»: значения вне обычной записи', () => {
  it.each([
    ['/v1/auth/abc123XYZ789/info', '/v1/auth/{id}/info'],
    ['/v1/card/4111!1110!0028!7774/info', '/v1/card/{id}/info'],
    ['/v1/pin/1234', '/v1/pin/{id}'],
    ['/v1/password/SecretPass1/x', '/v1/password/{id}/x'],
    ['/v1/card/4111/1112/3455/7893', '/v1/card/{id}/{id2}/{id3}/{id4}'],
    ['/v1/card/4111%25201112%25203455%25207893/x', '/v1/card/{id}/x'],
    ['/v1/password/reset', '/v1/password/reset'],
    ['/v1/users/list', '/v1/users/list'],
    ['/v1/oauth2/token', '/v1/oauth2/token'],
  ])('%s', (input, expected) => {
    expect(unknownPath(input)).toBe(expected);
  });
});

describe('регрессии атаки: правило справочника и обрезка', () => {
  const NON_LUHN = '5100123440473348';

  it('путь с тем же правилом имени, что у маски; FilterCondition.value', () => {
    for (const p of ['client-secret', 'user-pin', 'old_user_pin', 'my_app_client_secret', 'data.a_b_secret', 'accessToken']) expect(sensitivePath(p), p).toBe('secret');
    for (const p of ['sender_card_pan', 'card-pan', 'FilterCondition.value']) expect(sensitivePath(p), p).toBe('pan');
    expect(renderTemplate('{client-secret} {sender_card_pan} {FilterCondition.value}', parseBody(JSON.stringify({ 'client-secret': SECRET, sender_card_pan: NON_LUHN, FilterCondition: { value: NON_LUHN } })))).toBe('*** 510012******3348 510012******3348');
  });

  it('XML: значение внутри элемента-секрета или номера не читается по локальному имени', () => {
    const read = (xml: string, tpl: string) => renderTemplate(tpl, parseBody(xml));
    expect(read(`<a><password><value>${SECRET}</value></password></a>`, 'x{value}')).toBe('x');
    expect(read(`<a><RCARD><number>${NON_LUHN}</number></RCARD></a>`, 'x{number}')).toBe('x');
    expect(read(`<a><Authorization><token>${SECRET}</token></Authorization></a>`, 'x{inner}{token}')).toBe('x');
    expect(read('<a><status><value>ok</value></status></a>', 'x{value}')).toBe('xok');
  });

  it('срез на 32 КБ не открывает цифры номера сверх маски: маскируется весь текст', () => {
    const body = `Bearer ${'x'.repeat(32 * 1024 - 20)} card ${PAN}`;
    expect(clipMasked(body, 200)).not.toMatch(/\d{7}/);
    expect(clipMasked(`password=${'x'.repeat(32 * 1024 - 21)} card ${PAN} ${PAN}`, 200)).not.toContain(PAN.slice(0, 7));
  });
});

describe('персональные поля в правилах', () => {
  const body = parseBody(JSON.stringify({ home_phone: '447700900001', phone: '447700900002', alt_addr: '1 Sample Road', transfer_id: 'tr-1' }));
  const types = new Map([['t', { kind: 'operation' as const, name: 'T', statuses: [] }]]);
  const custom = compileMasking([{ type: 'address', enabled: false, keys: ['alt_addr'] }]).strict;

  it('sensitivePath: встроенное поле на любом уровне, добавленное запись не отклоняет', () => {
    for (const p of ['home_phone', 'data.phone', 'nameOnCard', 'address.city', 'national_id']) expect(sensitivePath(p), p).toBe('kind');
    for (const p of ['phone_mobile', 'client_pinfl']) expect(sensitivePath(p), p).toBeNull();
    for (const p of ['accountId', 'data.bank_account', 'card_tokens']) expect(sensitivePath(p), p).toBe('kind');
    expect(sensitivePath('account')).toBeNull();
    expect(sensitivePath('alt_addr')).toBeNull();
    expect(sensitivePath('first_name')).toBeNull();
  });

  it('шаблон, id и статус: маска вида и при выключенном виде, правило работает по исходному значению', () => {
    expect(renderTemplate('{home_phone} {alt_addr}', body, custom)).toBe('********0001 ***');
    const ids = stepIds([], [], [{ in: 'request', path: 'home_phone', type: 't' }, { in: 'request', path: 'transfer_id', type: 't' }], { query: null, request: body, response: { kind: 'none' } }, types, custom);
    expect(ids.map((i) => i.value)).toEqual(['********0001', 'tr-1']);
    expect(stepStatus('t', { in: 'response', path: 'alt_addr' }, { query: null, request: { kind: 'none' }, response: body }, types, custom)?.raw).toBe('***');
  });

  it('заполнитель пути — тоже имя', () => {
    const tpl = parseTemplate('/v1/users/{user_id}/contacts/{phone}');
    const types2 = new Map([['phone', { kind: 'entity' as const, name: 'Телефон' }]]);
    const ids = stepIds(tpl, ['v1', 'users', 'u1', 'contacts', '7700900001'], [], { query: null, request: { kind: 'none' }, response: { kind: 'none' } }, types2);
    expect(ids[0]!.value).toBe('******0001');
  });

  it('обрезка: телефон на границе не оставляет начала; без resolver результат прежний', () => {
    const text = `${'x'.repeat(195)} +447700900001 конец`;
    expect(clipMasked(text, 200)).not.toContain('4477');
    expect(maskField('transfer_id', PAN)).toBe(PAN);
    expect(finalizeSummary(summarize(CID, [rec({ kind: 'log', timeMs: T0, correlationId: CID, message: 'x' })], OPTS), [], null, { readEndMs: T0, incomplete: false }).correlationId).toBe(CID);
  });

  it('ключ операции из поля словаря недоступен для поиска', () => {
    const view = [{ id: '1-0', kind: 'send', catalog: { name: null, error: null, outcome: null, status: null, ids: [{ type: 't', name: 'T', kind: 'operation', value: '********0001', at: 'request' }] } }] as unknown as ViewRecord[];
    expect(operationKeysOf(view)).toEqual([{ type: 't', name: 'T', value: '********0001', short: '', masked: true }]);
  });

  it('запись читает добавленное поле: разметка и причина с маской проекта', () => {
    const snapshot = { ...snapshotFromFile(TEST_FILE), masking: [{ id: 1, type: 'address', enabled: false, keys: ['alt_addr'], edited: true, updatedAt: 't' }] };
    expect(compileCatalog(snapshot).masking.strict.fields.get('altaddr')).toBe('address');
  });
});
