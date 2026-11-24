// Второй проход: таблица видов, форматы, проход по именам полей и образцам, запись, время.
import { describe, expect, it } from 'vitest';
import type { ViewRecord } from './api.ts';
import { maskText } from './masking.ts';
import {
  ALL_KINDS_MASKING,
  BUILTIN_MASKING,
  compileMasking,
  viewerMasking,
  formatKind,
  maskKindsDeep,
  maskKindsEnvelope,
  maskKindsRecord,
  maskKindsText,
  normalizeFieldName,
  openRecordOf,
  phonesIn,
} from './mask-pass.ts';
import { BUILTIN_FIELDS, kindFieldCount, maskingKeyIssues } from './mask-fields.ts';
import { MASK_KIND_CODES, type MaskKind } from './mask-kinds.ts';
import { DEMO, UZBEKISTAN, useRegional } from './test-regional.ts';

const NONE: ReadonlySet<string> = new Set();
const strict = BUILTIN_MASKING.strict;
const P = (s: string, keep = NONE) => maskKindsText(s, strict, keep);

/** Уровни экранирования строки JSON. */
const wrap = (s: string, n: number) => {
  let out = s;
  for (let i = 0; i < n; i++) out = JSON.stringify(out).slice(1, -1);
  return out;
};

describe('список полей', () => {
  it('тринадцать видов, поля разных видов не пересекаются', () => {
    expect(MASK_KIND_CODES).toHaveLength(13);
    const names = MASK_KIND_CODES.flatMap((k) => BUILTIN_FIELDS[k].map(normalizeFieldName));
    expect(new Set(names).size).toBe(names.length);
  });

  it.each(['mobile_phone', 'mobilePhone', 'MOBILE-PHONE', 'X-Phone', 'ns2:phone', 'nameOnCard', 'additionalInfo', 'additional_info', 'Expiry', 'full_name', 'national_id', 'NationalId', 'tax_id', 'passport_number', 'iban'])('%s узнаётся', (k) => {
    expect(strict.fields.has(normalizeFieldName(k))).toBe(true);
  });

  it.each(['phone_mismatch', 'client_birth_place', 'last_update_address', 'mobile_dockers', 'account', 'account_name', 'Name', 'sender_name', 'payer_name'])('%s нет ни в одном виде', (k) => {
    expect(ALL_KINDS_MASKING.strict.fields.has(normalizeFieldName(k))).toBe(false);
  });

  // Имена полей из примера Узбекистана не встроены: проект добавляет их полями вида в справочнике.
  it.each(['pinfl', 'national_id_number', 'phone_mobile', 'phone_home', 'client_family', 'client_passport_number', 'client_account_no', 'client_district_code'])('%s не встроено', (k) => {
    expect(ALL_KINDS_MASKING.strict.fields.has(normalizeFieldName(k))).toBe(false);
  });

  it.each(['given_name', 'first_name', 'patronymic', 'birth_date', 'dob', 'email_address', 'email'])('%s: вид выключен по умолчанию, в строгом проходе его нет, при всех включённых есть', (k) => {
    expect(strict.fields.has(normalizeFieldName(k))).toBe(false);
    expect(ALL_KINDS_MASKING.strict.fields.has(normalizeFieldName(k))).toBe(true);
  });

  it('имена первого прохода во второй проход не входят', () => {
    const m = compileMasking([{ type: 'secrets', enabled: true, keys: ['password', 'my_app_password', 'partner_key'] }, { type: 'card_number', enabled: true, keys: ['pan', 'partner_pan_field'] }]);
    for (const k of ['password', 'myapppassword', 'pan']) expect(m.strict.fields.has(k), k).toBe(false);
    expect(m.strict.fields.get('partnerkey')).toBe('secrets');
    expect(m.strict.fields.get('partnerpanfield')).toBe('card_number');
  });

  it('вид без строки в состоянии по умолчанию, строка неизвестного вида пропущена, отпечаток от настройки', () => {
    const m = compileMasking([{ type: 'snils', enabled: false, keys: ['x'] }, { type: 'phone', enabled: false, keys: ['alt_phone'] }]);
    expect(m.shown.kinds.has('email')).toBe(false);
    expect(m.shown.kinds.has('address')).toBe(true);
    expect(m.shown.kinds.has('phone')).toBe(false);
    expect(m.strict.kinds.has('phone')).toBe(true);
    expect(m.strict.fields.get('altphone')).toBe('phone');
    expect(m.shown.fields.has('altphone')).toBe(false);
    expect(m.strict.fields.has('x')).toBe(false);
    expect(m.stamp).not.toBe(BUILTIN_MASKING.stamp);
  });

  it('битые строки и enabled false у вида с замком: вид включён, номер карты и секрет скрыты', () => {
    const broken = [null, 7, { type: 3 }, { type: 'phone', enabled: 'нет', keys: 'p_x' }, { type: 'address', enabled: true, keys: [1, null, 'alt_addr'] }, { type: 'card_number', enabled: false, keys: [] }, { type: 'secrets', enabled: false, keys: [] }] as never[];
    const m = compileMasking(broken);
    expect(m.shown.kinds.has('card_number')).toBe(true);
    expect(m.shown.kinds.has('secrets')).toBe(true);
    expect(m.shown.kinds.has('phone')).toBe(true);
    expect(m.strict.fields.get('altaddr')).toBe('address');
    expect(m.stamp).toBe(compileMasking([{ type: 'address', enabled: true, keys: ['alt_addr'] }]).stamp);
    const pan = '4111111234557893';
    expect(maskText(`{"pan":"${pan}","password":"synth"}`, NONE)).toBe('{"pan":"411111******7893","password":"***"}');
    expect(viewerMasking(m, 'support').reveal.kinds.has('secrets')).toBe(true);
  });

  it('состояния настройки: по умолчанию, все включены', () => {
    expect([...BUILTIN_MASKING.shown.kinds].sort()).toEqual(MASK_KIND_CODES.filter((k) => !['first_name', 'birth_date', 'email'].includes(k)).sort());
    expect([...ALL_KINDS_MASKING.shown.kinds].sort()).toEqual([...MASK_KIND_CODES].sort());
    expect(ALL_KINDS_MASKING.stamp).not.toBe(BUILTIN_MASKING.stamp);
  });

  it('вид, включённый вручную, работает; выключенный обратно снова не трогает значения', () => {
    const on = compileMasking([{ type: 'email', enabled: true, keys: [] }]);
    expect(maskKindsText('user@example.com', on.strict, NONE)).toBe('u*****@example.com');
    const off = compileMasking([{ type: 'email', enabled: false, keys: [] }]);
    expect(maskKindsText('user@example.com', off.strict, NONE)).toBe('user@example.com');
    expect(off.stamp).toBe(BUILTIN_MASKING.stamp);
  });

  it('поле старой строки: побеждает встроенное поле включённого вида, а выключенный по умолчанию вид ему не мешает', () => {
    const m = compileMasking([{ type: 'passport', enabled: true, keys: ['bankAccountId', 'birth_date'] }]);
    expect(m.strict.fields.get('bankaccountid')).toBe('account_number');
    expect(m.strict.fields.get('birthdate')).toBe('passport');
    const on = compileMasking([{ type: 'passport', enabled: true, keys: ['birth_date'] }, { type: 'birth_date', enabled: true, keys: [] }]);
    expect(on.strict.fields.get('birthdate')).toBe('birth_date');
  });

  it('число полей вида: поле поверх встроенного считается один раз', () => {
    expect(kindFieldCount('address', ['post_address', 'client_home_addr'])).toBe(BUILTIN_FIELDS.address.length + 1);
    expect(kindFieldCount('secrets', ['password', 'partner_key'])).toBe(BUILTIN_FIELDS.secrets.length + 1);
  });
});

describe('поля вида: владелец имени', () => {
  const owner = (type: MaskKind, keys: string[], others: { type: string; enabled: boolean; keys: string[] }[] = [], stored: string[] = []) =>
    maskingKeyIssues(type, keys, others, 'keys', stored).map((i) => i.params?.type ?? i.key ?? i.message);

  it.each([
    ['password', 'secrets'],
    ['my_app_password', 'secrets'],
    ['Authorization', 'secrets'],
    ['card_token', 'secrets'],
    ['pan', 'card_number'],
    ['primaryAccountNumber', 'card_number'],
    ['first_name', 'first_name'],
    ['birthday', 'birth_date'],
    ['bankAccountId', 'account_number'],
    ['iban', 'account_number'],
    ['card_tokens', 'card_token'],
    ['homePhone', 'phone'],
    ['tax_id', 'national_id'],
    ['passport_number', 'passport'],
  ])('%s у другого вида: отказ с видом %s', (name, kind) => {
    expect(owner('address', [name])).toEqual([kind]);
  });

  it('своё поле проходит, в том числе имя первого прохода у своего вида', () => {
    expect(owner('secrets', ['password', 'my_app_password', 'partner_key'])).toEqual([]);
    expect(owner('card_number', ['pan', 'partner_pan_field'])).toEqual([]);
    expect(owner('address', ['post_address', 'client_home_addr'])).toEqual([]);
    // Имя поля из примера Узбекистана добавляется к своему виду.
    expect(owner('national_id', ['pinfl', 'national_id_number'])).toEqual([]);
  });

  it('поле, уже стоявшее в строке, не отклоняется, новое того же вида отклоняется', () => {
    expect(owner('passport', ['bankAccountId'], [], ['bankAccountId'])).toEqual([]);
    expect(owner('passport', ['bankAccountId', 'accountId'], [], ['bankAccountId'])).toEqual(['account_number']);
  });

  it('поле другой строки в другой записи', () => {
    expect(owner('address', ['pAltMobile'], [{ type: 'phone', enabled: true, keys: ['p_alt_mobile'] }])).toEqual(['phone']);
  });

  it('неверное имя, повтор, предел', () => {
    expect(owner('address', ['bad name'])).toEqual(['masking.fieldFormat']);
    expect(owner('address', ['a_b', 'aB'])).toEqual(['masking.fieldDuplicate']);
    expect(maskingKeyIssues('address', Array.from({ length: 201 }, (_, i) => `f${i}`), [])[0]!.path).toBe('keys');
  });
});

describe('форматы маски', () => {
  it.each<[MaskKind, string, string]>([
    ['phone', '+447700900001', '+********0001'],
    ['phone', '+1 (202) 555-0101', '+* (***) ***-0101'],
    ['phone', '+44 7700 900001', '+** **** **0001'],
    ['phone', 'нет', '***'],
    ['phone', '123', '***'],
    ['phone', 'не указан', '***'],
    ['national_id', 'ZZ000101A', '*****101A'],
    ['national_id', '31201990000011', '**********0011'],
    ['national_id', '123-45-6789', '*****6789'],
    ['national_id', '123', '***'],
    ['national_id', 'unknown', '***'],
    ['passport', 'AA0000001', 'AA*****01'],
    ['passport', 'AA 0000001', 'AA*****01'],
    ['passport', '0000001', '*****01'],
    ['passport', '123456789', '*******89'],
    ['passport', 'C01X00T47', 'C******47'],
    ['passport', 'AA', '***'],
    ['passport', 'UNKNOWN', '***'],
    ['surname', 'Тестов', 'Т*****'],
    ['surname', 'Тестов Тест', 'Т***** Т*****'],
    ['surname', 'Я Тестовтестовтестов', 'Я***** Т*****'],
    ['surname', 'Тест2 Тестов', '***'],
    ['surname', '%D0%A2%D0%B5', '***'],
    ['address', 'ул. Примерная, 1', '***'],
    ['address', 'ул. Примерная * 1', '***'],
    ['address', '10.20.30.40:8080', '10.20.30.40:8080'],
    ['card_data', '3008', '***'],
    ['card_token', '400000ABCDEF1234', '***'],
    ['account_number', '10500000900123456001', '****************6001'],
    ['account_number', '7001112344650819', '************0819'],
    ['account_number', '36999719', '****9719'],
    ['account_number', '411111******7893', '************7893'],
    ['account_number', 'нет', '***'],
    ['account_number', '123', '***'],
    ['account_number', 'ACC-12', '***'],
    ['account_number', 'DE89370400440532013000', 'DE****************3000'],
    ['account_number', 'DE89 3704 0044 0532 0130 00', 'DE** **** **** **** **30 00'],
    ['account_number', 'DE00370400440532013000', '***'],
    ['card_number', '4111111234557893', '411111******7893'],
    ['card_number', '4111 1112 3455 7893', '411111******7893'],
    ['card_number', 'нет', '***'],
    ['secrets', 'значение', '***'],
    ['first_name', 'Тест', 'Т*****'],
    ['first_name', 'Тест Тестович', 'Т***** Т*****'],
    ['first_name', 'Тест2', '***'],
    ['birth_date', '1990-01-01', '***'],
    ['email', 'user@example.com', 'u*****@example.com'],
    ['email', 'user%40example.com', 'u*****%40example.com'],
    ['email', 'нет', '***'],
    ['email', 'user@host', '***'],
  ])('%s: %s → %s', (type, value, mask) => {
    expect(formatKind(type, value)).toBe(mask);
    // Повторное маскирование не меняет маску.
    expect(formatKind(type, mask)).toBe(mask);
  });

  it('uuid под именем счёта не меняется и не считается скрытым', () => {
    const uuid = '5a1d0100-0000-0000-0000-000000000001';
    expect(formatKind('account_number', uuid)).toBe(uuid);
    const hits = new Set<MaskKind>();
    expect(maskKindsText(JSON.stringify({ account_id: uuid }), strict, NONE, hits)).toBe(JSON.stringify({ account_id: uuid }));
    expect(hits.size).toBe(0);
  });
});

describe('номер счёта', () => {
  it('XML и JSON', () => {
    expect(P('<bankAccountId>7001112344650819</bankAccountId>')).toBe('<bankAccountId>************0819</bankAccountId>');
    expect(P('{"accountId":"36999719"}')).toBe('{"accountId":"****9719"}');
    expect(P(JSON.stringify({ data: '{"accountId":"36999719"}' }))).toBe(JSON.stringify({ data: '{"accountId":"****9719"}' }));
    expect(P('<ns2:account_no><![CDATA[36999719]]></ns2:account_no>')).toBe('<ns2:account_no>****9719</ns2:account_no>');
    expect(P('&lt;bank_account&gt;36999719&lt;/bank_account&gt;')).toBe('&lt;bank_account&gt;****9719&lt;/bank_account&gt;');
    expect(P('account_no=36999719&amount=100')).toBe('account_no=****9719&amount=100');
    expect(P('GET / HTTP/1.1\r\nX-Account-No: 36999719\r\nHost: h')).toBe('GET / HTTP/1.1\r\nX-Account-No: ****9719\r\nHost: h');
  });

  it.each([
    ['/v1/accounts/10500000900123456001/00001', '/v1/accounts/****************6001/00001'],
    ['\\/v1\\/users\\/u\\/accounts\\/7001112344650819', '\\/v1\\/users\\/u\\/accounts\\/************0819'],
    ['/v1/account/36999719?x=1', '/v1/account/****9719?x=1'],
    ['%2Fv1%2Faccounts%2F36999719', '%2Fv1%2Faccounts%2F****9719'],
    ['/v1/accounts/411111******7893/x', '/v1/accounts/************7893/x'],
    ['IBAN DE89370400440532013000.', 'IBAN DE****************3000.'],
    ['IBAN DE89 3704 0044 0532 0130 00', 'IBAN DE** **** **** **** **30 00'],
    ['%22DE89370400440532013000%22', '%22DE****************3000%22'],
    ['{"to":"GB82WEST12345698765432"}', '{"to":"GB****************5432"}'],
  ])('%s', (s, want) => {
    expect(P(s)).toBe(want);
    expect(P(want)).toBe(want);
  });

  it.each([
    '/v1/subaccounts/36999719',
    '/v1/accounts/1234567',
    '/v1/accounts/123456789012345678901234567890123456',
    '/v1/accounts/36999719abc',
    'счёт 7001112344650819 в тексте',
    '1050 0000 9001 2345 6001',
    '105000009001234560011',
    '{"account":"36999719","account_name":"Текущий"}',
    // Серия из 20 цифр — счёт только по образцу раздела regional.
    'счёт 10500000900123456001',
    '%2210500000900123456001%22',
    // IBAN с неверным контрольным числом и внутри кода.
    'DE00370400440532013000',
    'XDE89370400440532013000',
    'DE89370400440532013000X',
  ])('%s не меняется', (s) => {
    expect(P(s)).toBe(s);
  });

  it('id из keep открыт, голое account с массивом: скрыт только accountId, сумма на месте', () => {
    expect(P('/v1/accounts/10500000900123456001', new Set(['10500000900123456001']))).toBe('/v1/accounts/10500000900123456001');
    expect(P('IBAN DE89370400440532013000', new Set(['DE89370400440532013000']))).toBe('IBAN DE89370400440532013000');
    expect(P('{"account":[{"accountId":"36999719","availableAmount":"100"}]}')).toBe('{"account":[{"accountId":"****9719","availableAmount":"100"}]}');
  });

  it('поле числом; число от 1e19 до 1e20 без образца счёта не меняется', () => {
    const rounded = Number('10500000900123456001');
    expect(maskKindsDeep({ x: rounded }, strict, NONE)).toEqual({ x: rounded });
    expect(maskKindsDeep({ accountId: 36999719 }, strict, NONE)).toEqual({ accountId: '****9719' });
  });

  it('форма не узнана: ***, пустое и логическое не меняются', () => {
    for (const v of ['нет', '123', 'ACC-12']) expect(P(`{"accountId":"${v}"}`)).toBe('{"accountId":"***"}');
    for (const s of ['{"accountId":null}', '{"accountId":""}', '{"accountId":true}']) expect(P(s)).toBe(s);
  });
});

describe('токен карты', () => {
  it('массив в теле, адрес, тег, на всех путях', () => {
    expect(P('{"card_tokens":["400000ABCDEF1234","400000GHIJKL5678"]}')).toBe('{"card_tokens":["***","***"]}');
    expect(P('{"card_tokens":["demo-token-x"]}')).toBe('{"card_tokens":["***"]}');
    expect(P('/v1/x/400000ABCDEF1234/y')).toBe('/v1/x/***/y');
    expect(P('<CARD>400000ABCDEF1234</CARD>')).toBe('<CARD>***</CARD>');
    expect(P('%22400000ABCDEF1234%22')).toBe('%22***%22');
    expect(P('токен 400000abcdef1234.')).toBe('токен ***.');
    expect(maskKindsDeep({ card_tokens: ['400000ABCDEF1234'] }, strict, NONE)).toEqual({ card_tokens: ['***'] });
  });

  it('единственное число остаётся за секретами: второй проход его не трогает, первый скрывает', () => {
    expect(strict.fields.has('cardtoken')).toBe(false);
    expect(maskText('{"card_token":"token-x","cardToken":"token-y"}', NONE)).toBe('{"card_token":"***","cardToken":"***"}');
  });

  it('токен другой формы вне поля и похожая строка не меняются', () => {
    for (const s of ['demo-token-abc', 'X400000ABCDEF1234', '400000ABCDEF12345', '400000ABCD1234']) expect(P(s), s).toBe(s);
  });

  it('значение из keep открыто', () => {
    expect(P('/v1/x/400000ABCDEF1234', new Set(['400000ABCDEF1234']))).toBe('/v1/x/400000ABCDEF1234');
  });
});

describe('имя, дата рождения и e-mail', () => {
  const all = ALL_KINDS_MASKING.strict;
  const A = (s: string) => maskKindsText(s, all, NONE);

  it('виды не включали: значения не меняются нигде, поля open нет', () => {
    const s = JSON.stringify({ first_name: 'Тест', middle_name: 'Тестович', birth_date: '1990-01-01', email_address: 'user@example.com' });
    expect(P(s)).toBe(s);
    expect(P('/x?login=user%40example.com user@example.com')).toBe('/x?login=user%40example.com user@example.com');
    const r = maskKindsRecord(rec({ title: 't', message: 'user@example.com', sections: { headers: null, body: s, payload: null, context: null }, raw: s, http: null }), BUILTIN_MASKING, NONE);
    expect(r.hits.size).toBe(0);
    expect(r.record.open).toBeUndefined();
    expect(r.record.message).toBe('user@example.com');
  });

  it('вид включён: имя, отчество, дата и e-mail по полю и e-mail по виду значения', () => {
    expect(A('{"first_name":"Тест"}')).toBe('{"first_name":"Т*****"}');
    expect(A('{"patronymic":"Тестович"}')).toBe('{"patronymic":"Т*****"}');
    expect(A('{"birth_date":"1990-01-01"}')).toBe('{"birth_date":"***"}');
    expect(A('{"email":"user@example.com"}')).toBe('{"email":"u*****@example.com"}');
    expect(A('{"email":"нет"}')).toBe('{"email":"***"}');
    expect(A('user@example.com')).toBe('u*****@example.com');
    expect(A('/x?login=user%40example.com&y=2')).toBe('/x?login=u*****%40example.com&y=2');
    expect(A('%22user%40example.com%22')).toBe('%22u*****%40example.com%22');
    expect(A('a user.name+tag@sub.example.com b')).toBe('a u*****@sub.example.com b');
  });

  it('вид включён: что не трогается', () => {
    for (const s of ['{"Name":"Банк"}', '{"sender_name":"Банк"}', '{"receiver_name":"x"}', '{"recipient_name":"x"}', '{"payer_name":"x"}', '{"payee_name":"x"}', '{"account_name":"x"}', '{"client_birth_place":"Город"}', 'родился 1990-01-01', 'user@host']) expect(A(s), s).toBe(s);
  });

  it('учётные данные адреса это секреты, а не e-mail', () => {
    const masked = maskText('https://svc:пароль@host.example/x', NONE);
    expect(masked).toBe('https://***@host.example/x');
    expect(A(masked)).toBe(masked);
  });

  it('повторное маскирование ничего не меняет', () => {
    for (const s of ['u*****@example.com', '/x?login=u*****%40example.com', '{"email":"u*****@example.com"}', '{"first_name":"Т*****"}']) expect(A(s), s).toBe(s);
  });
});

describe('фамилия и имя разделены', () => {
  it('поле только с именем или отчеством вид «Фамилия» не трогает', () => {
    const on = compileMasking([{ type: 'surname', enabled: true, keys: [] }]).strict;
    for (const k of ['given_name', 'first_name', 'first_name_en', 'middle_name', 'patronymic']) {
      expect(on.fields.has(normalizeFieldName(k)), k).toBe(false);
    }
  });
});

describe('по имени поля', () => {
  const FIELDS: [string, string, string][] = [
    ['home_phone', '447700900001', '********0001'],
    ['mobile_phone', '+447700900001', '+********0001'],
    ['post_address', 'ул. Примерная, 1', '***'],
    ['region_code', '26', '***'],
    ['address_line1', 'Flat 2', '***'],
    ['street', 'Main Street', '***'],
    ['passport_series', 'AA', '***'],
    ['passport_number', '0000001', '*****01'],
    ['passport_issued_by', 'Город', '***'],
    ['passport_issue_date', '2020-01-01', '***'],
    ['passport_expiry_date', '2030-01-01', '***'],
    ['national_id', 'ZZ000101A', '*****101A'],
    ['tax_id', '31201990000011', '**********0011'],
    ['ssn', '123-45-6789', '*****6789'],
    ['family_name', 'Тестов', 'Т*****'],
    ['customer_name', 'Тестов Тест Тестович', 'Т***** Т***** Т*****'],
    ['last_name', 'Тестов', 'Т*****'],
    ['full_name', 'Тестов Тест Тестович', 'Т***** Т***** Т*****'],
    ['nameOnCard', 'TEST TESTOV', 'T***** T*****'],
    ['document', 'not-a-passport', '***'],
    ['additionalInfo', 'ADD00100000000', '***'],
    ['expiry', '3008', '***'],
    ['sender_expiry', '3008', '***'],
    ['expiration_date', '3008', '***'],
  ];

  it.each(FIELDS)('%s на уровнях 0–3 и в кавычках других семейств', (key, value, mask) => {
    for (const n of [0, 1, 2, 3]) expect(P(wrap(JSON.stringify({ [key]: value }), n))).toBe(wrap(JSON.stringify({ [key]: mask }), n));
    expect(P(`{\\u0022${key}\\u0022:\\u0022${value}\\u0022}`)).not.toContain(value);
    expect(P(`{&quot;${key}&quot;:&quot;${value}&quot;}`)).not.toContain(value);
    expect(P(encodeURIComponent(`{"${key}":"`) + encodeURIComponent(value))).not.toContain(encodeURIComponent(value));
  });

  it('XML: префикс, CDATA, сущности и %XX', () => {
    expect(P('<ns2:passport_number>0000001</ns2:passport_number>')).toBe('<ns2:passport_number>*****01</ns2:passport_number>');
    expect(P('<ns2:passport_number><![CDATA[0000001]]></ns2:passport_number>')).toBe('<ns2:passport_number>*****01</ns2:passport_number>');
    expect(P('<nameOnCard>TEST TESTOV</nameOnCard>')).toBe('<nameOnCard>T***** T*****</nameOnCard>');
    expect(P('<expiry>3008</expiry>')).toBe('<expiry>***</expiry>');
    expect(P('&lt;expiry&gt;3008&lt;/expiry&gt;')).toBe('&lt;expiry&gt;***&lt;/expiry&gt;');
    expect(P('%3Cexpiry%3E3008%3C%2Fexpiry%3E')).toBe('%3Cexpiry%3E***%3C%2Fexpiry%3E');
    expect(P('<address><city>Город</city></address>')).toBe('<address>***</address>');
    expect(P('<post_address>ул.\nПримерная</post_address>')).toBe('<post_address>***</post_address>');
  });

  it('форма, строка запроса, атрибут и заголовок после перевода строки', () => {
    expect(P('mobile_phone=447700900001&amount=100')).toBe('mobile_phone=********0001&amount=100');
    expect(P('/x?post_address=%D1%83%D0%BB.%201&y=2')).toBe('/x?post_address=***&y=2');
    expect(P('address=ул. Примерная 1 amount=5')).toBe('address=*** amount=5');
    expect(P('<x phone="447700900001"/>')).toBe('<x phone="********0001"/>');
    expect(P('a=1%26national_id%3D31201990000011%26y%3D1')).toBe('a=1%26national_id%3D**********0011%26y%3D1');
    expect(P('GET / HTTP/1.1\r\nX-Phone: +447700900001\r\nHost: h')).toBe('GET / HTTP/1.1\r\nX-Phone: +********0001\r\nHost: h');
    expect(P(JSON.stringify({ raw_request: 'GET / HTTP/1.1\r\nX-Phone: +447700900001\r\nHost: h' }))).toBe(JSON.stringify({ raw_request: 'GET / HTTP/1.1\r\nX-Phone: +********0001\r\nHost: h' }));
  });

  it('JSON внутри обычного поля и текст с именем поля', () => {
    expect(P(JSON.stringify({ data: '{"post_address":"ул. Примерная, 1","a":"b"}' }))).toBe(JSON.stringify({ data: '{"post_address":"***","a":"b"}' }));
    for (const s of ['{"error":"phone: cannot be blank"}', 'invalid document: wrong expiry', 'клиент Тестов не найден', 'phone_mismatch=1&mobile_dockers=2']) expect(P(s)).toBe(s);
    expect(P('{"errors":{"phone":"cannot be blank"}}')).toBe('{"errors":{"phone":"***"}}');
  });

  it('число, массив, объект, null, пустое, логическое', () => {
    expect(P('{"mobile_phone":447700900001}')).toBe('{"mobile_phone":"********0001"}');
    expect(P('{"national_id":31201990000011}')).toBe('{"national_id":"**********0011"}');
    expect(P('{"expiry":3600}')).toBe('{"expiry":"***"}');
    expect(P('{"phones":["+447700900001","+447700900002"]}')).toBe('{"phones":["+********0001","+********0002"]}');
    expect(P('{"address":{"city":"Город","street":"Примерная, 1"}}')).toBe('{"address":"***"}');
    for (const s of ['{"phone":null}', '{"phone":""}', '{"phone":"   "}', '{"additional_info":true}', '{"address":{}}']) expect(P(s)).toBe(s);
    expect(P('{"address":"10.20.30.40:8080"}')).toBe('{"address":"10.20.30.40:8080"}');
  });

  it('значение на нескольких строках, обрыв, длиннее предела', () => {
    expect(P(JSON.stringify({ post_address: 'ул.\nПримерная' }))).toBe('{"post_address":"***"}');
    expect(P('{"post_address":"ул.\nПримерная"}')).toBe('{"post_address":"***"}');
    expect(P('{"post_address":"ул. При')).toBe('{"post_address":"***');
    expect(P(`{"post_address":"${'ф'.repeat(9000)}SYNTHTAIL"}`)).not.toContain('SYNTHTAIL');
  });

  it('форма без распознавания не падает и зафиксирована', () => {
    for (const s of [`'address' => 'ул. Примерная, 1'`, '{"name":"address","value":"ул. Примерная, 1"}', '<item><name>sender_last_name</name><value>Тестов</value></item>', '<additional_info href="#id7"/>']) expect(P(s)).toBe(s);
    expect(P(`'phone' => '+447700900001'`)).toBe(`'phone' => '+********0001'`);
  });

  it('дата рождения, e-mail и имя не меняются, пока виды выключены', () => {
    const s = JSON.stringify({ birth_date: '1990-01-01', client_birth_place: 'Город', client_birth_region_code: '26', client_birth_district_code: '1', email_address: 'user@example.com', email: 'user@example.com', given_name: 'Тест', first_name: 'Тест', patronymic: 'Тестович' });
    expect(P(s)).toBe(s);
    expect(P('/x?login=user%40example.com')).toBe('/x?login=user%40example.com');
    expect(P('user@example.com')).toBe('user@example.com');
  });

  it('обход объекта: те же формы, вложенность, заголовок с приставкой', () => {
    expect(maskKindsDeep({ mb: { phone: '+447700900001' }, phone: '+447700900001', 'X-Address': 'ул. Примерная, 1', 'X-Phone': ['+447700900001'], address: { city: 'Г' }, ok: true }, strict, NONE)).toEqual({
      mb: { phone: '+********0001' },
      phone: '+********0001',
      'X-Address': '***',
      'X-Phone': ['+********0001'],
      address: '***',
      ok: true,
    });
    // Ключ с плюсом — телефон; голое число без плана номеров — нет.
    expect(maskKindsDeep({ '+447700900001': { state: 'on' }, x: 447700900001 }, strict, NONE)).toEqual({ '+********0001': { state: 'on' }, x: 447700900001 });
    expect(maskKindsDeep({ phone: null, family_name: 123, additional_info: false }, strict, NONE)).toEqual({ phone: null, family_name: '***', additional_info: false });
  });
});

describe('по виду значения: международные правила', () => {
  it.each([
    ['Пользователь +447700900001 не найден', 'Пользователь +********0001 не найден'],
    ['+1 (202) 555-0101', '+* (***) ***-0101'],
    ['call +44 7700 900001.', 'call +** **** **0001.'],
    ['%2B447700900001', '%2B********0001'],
    ['\\u0022+447700900001', '\\u0022+********0001'],
    ['Номер:\\n+447700900001', 'Номер:\\n+********0001'],
    ['{"to":"+33123456789"}', '{"to":"+*******6789"}'],
  ])('%s', (s, want) => {
    expect(P(s)).toBe(want);
    expect(P(want)).toBe(want);
  });

  it.each([
    // Без плана номеров цифры без плюса телефоном не считаются, паспорт и личный номер — только по именам полей.
    '447700900001',
    '998900000001',
    '%22447700900001%22',
    '900000001',
    'Паспорт AA0000001',
    'ПИНФЛ 31201990000011.',
    'ZZ000101A',
    // Плюс внутри числа, слишком длинный номер, дробь, хвост uuid.
    '1+447700900001',
    '+4477009001012345678',
    '+447700900001.50',
    '5a1d0100-0000-0000-0000-447700900001',
    '20261104153012',
    '/x?login=user%40example.com',
    'user@example.com',
  ])('%s не меняется', (s) => {
    expect(P(s)).toBe(s);
  });

  it('значения из keep образец не трогает, по именам полей keep не действует', () => {
    expect(P('x +447700900001', new Set(['447700900001']))).toBe('x +447700900001');
    expect(P('{"national_id":"31201990000011"}', new Set(['31201990000011']))).toBe('{"national_id":"**********0011"}');
  });

  it('выключенный вид образец не скрывает, остальные скрывает', () => {
    const shown = compileMasking([{ type: 'phone', enabled: false, keys: [] }]).shown;
    expect(maskKindsText('+447700900001 DE89370400440532013000', shown, NONE)).toBe('+447700900001 DE****************3000');
  });

  it('границы телефонов для страницы: тот же образец и та же проверка слева', () => {
    const at = (s: string) => phonesIn(s).map(([a, b]) => s.slice(a, b));
    expect(at('Phone +44 7700 900101, или +447700900102.')).toEqual(['+44 7700 900101', '+447700900102']);
    expect(at('id 1+447700900101 и +4477009001012345678')).toEqual([]);
    expect(at('5a1d0100-0000-0000-0000-447700900001')).toEqual([]);
    expect(at('без плюса 447700900101 и 7700900101')).toEqual([]);
    // Каждая найденная граница закрывается маской так же, как весь текст.
    const s = 'Клиент +1 (202) 555-0101';
    const [[a, b]] = phonesIn(s) as [[number, number]];
    expect(P(s)).toBe(s.slice(0, a) + P(s.slice(a, b)));
  });
});

describe('по виду значения: пример Узбекистана из config/README.md', () => {
  useRegional(UZBEKISTAN);

  it.each([
    ['Пользователь 998900000001 не найден', 'Пользователь ********0001 не найден'],
    ['+998 (90) 000-00-01', '+*** (**) ***-00-01'],
    ['%22998900000001%22', '%22********0001%22'],
    ['%3D998900000001', '%3D********0001'],
    ['%2B998900000001', '%2B********0001'],
    ['\\u0022998900000001', '\\u0022********0001'],
    ['Номер:\\n998900000001', 'Номер:\\n********0001'],
    ['%22AA0000001%22', '%22AA*****01%22'],
    ['Паспорт:\\nAA0000001', 'Паспорт:\\nAA*****01'],
    ['ПИНФЛ 31201990000011.', 'ПИНФЛ **********0011.'],
    ['счёт 10500000900123456001', 'счёт ****************6001'],
    ['%2210500000900123456001%22', '%22****************6001%22'],
    // Номер другой страны — по международным правилам.
    ['+447700900001', '+********0001'],
  ])('%s', (s, want) => {
    expect(P(s)).toBe(want);
    expect(P(want)).toBe(want);
  });

  it.each([
    '900000001',
    '5a1d0100-0000-0000-0000-998900000001',
    '99890123-4567-4abc-8def-0123456789ab',
    '998900000001.50',
    '9980000000000012',
    '20261104153012',
    'aa0000001',
    'AA00000011',
    'TXN1234567',
  ])('%s не меняется', (s) => {
    expect(P(s)).toBe(s);
  });

  it('значения из keep образец не трогает; имена полей проекта — полями вида', () => {
    expect(P('id 31201990000011', new Set(['31201990000011']))).toBe('id 31201990000011');
    expect(P('x 998900000001', new Set(['998900000001']))).toBe('x 998900000001');
    expect(P('id 10500000900123456001', new Set(['10500000900123456001']))).toBe('id 10500000900123456001');
    const bank = compileMasking([{ type: 'national_id', enabled: true, keys: ['pinfl', 'national_id_number'] }]).strict;
    expect(maskKindsText('{"pinfl":"31201990000011","national_id_number":"31201990000011"}', bank, NONE)).toBe('{"pinfl":"**********0011","national_id_number":"**********0011"}');
  });

  it('выключенный вид образец не скрывает, остальные скрывает', () => {
    const shown = compileMasking([{ type: 'phone', enabled: false, keys: [] }]).shown;
    expect(maskKindsText('998900000001 AA0000001', shown, NONE)).toBe('998900000001 AA*****01');
  });

  it('голое число и ключ из цифр с кодом страны — телефон; 20 цифр числом — счёт', () => {
    expect(maskKindsDeep({ '998900000001': { state: 'on' }, x: 998900000001 }, strict, NONE)).toEqual({ '********0001': { state: 'on' }, x: '********0001' });
    const rounded = Number('10500000900123456001');
    expect(maskKindsDeep({ x: rounded, y: 1e20, z: 9e18 }, strict, NONE)).toEqual({ x: '***', y: 1e20, z: 9e18 });
    const off = compileMasking([{ type: 'account_number', enabled: false, keys: [] }]);
    expect(maskKindsDeep({ x: rounded }, off.shown, NONE)).toEqual({ x: rounded });
  });

  it('границы телефонов для страницы: тот же образец и та же проверка слева', () => {
    const at = (s: string) => phonesIn(s).map(([a, b]) => s.slice(a, b));
    expect(at('Phone +998 90 000 01 01, или 998900000102.')).toEqual(['+998 90 000 01 01', '998900000102']);
    expect(at('id 1998900000101 и 998900000101234')).toEqual([]);
    expect(at('5a1d0100-0000-0000-0000-998900000001')).toEqual([]);
    expect(at('без кода страны 900000101')).toEqual([]);
    const s = 'Клиент +998 (90) 000-00-01';
    const [[a, b]] = phonesIn(s) as [[number, number]];
    expect(P(s)).toBe(s.slice(0, a) + P(s.slice(a, b)));
  });
});

describe('по виду значения: правила демо-проекта', () => {
  useRegional(DEMO);

  it.each([
    ['client 447700900001', 'client ********0001'],
    ['client 07700 900001', 'client 07700 900001'],
    ['passport ZZ0000101', 'passport ZZ*****01'],
    ['national id ZZ000101A', 'national id *****101A'],
    ['+447700900001', '+********0001'],
  ])('%s', (s, want) => {
    expect(P(s)).toBe(want);
    expect(P(want)).toBe(want);
  });
});

describe('после блоков с правилами действуют международные', () => {
  it('голые номера и паспорт снова открыты', () => {
    expect(P('client 447700900001 passport ZZ0000101')).toBe('client 447700900001 passport ZZ0000101');
  });
});

const rec = (over: Partial<ViewRecord> = {}): ViewRecord => ({
  id: '1-0',
  tsNs: '1',
  timeMs: 1,
  offsetMs: 0,
  kind: 'send',
  title: 'POST /x?phone=+447700900001',
  message: 'Пользователь +447700900001',
  level: null,
  isError: false,
  component: null,
  gateway: false,
  correlationId: '31201990000011',
  requestId: null,
  http: { method: 'POST', uri: '/x?phone=+447700900001', status: null, durationMs: null, pairId: null, noResponse: false, pending: false },
  sections: { headers: null, body: '{"phone":"+447700900001","address":"ул."}', payload: null, context: { name: 'Тестов' } },
  raw: 'raw +447700900001',
  match: null,
  ...over,
});

describe('запись', () => {
  it('конверт не сравнивается с именами словаря, содержимое — сравнивается', () => {
    const m = compileMasking([{ type: 'surname', enabled: true, keys: ['name'] }]);
    const r = rec({ catalog: { name: { source: 'project', system: { key: 'k', name: 'Тестов', type: 'service' }, method: null, host: null }, error: null, outcome: null, ids: [{ type: 't', name: 'Тестов', kind: 'entity', value: 'v', at: 'path' }], status: null } });
    const { record } = maskKindsRecord(r, m, NONE);
    expect(record.catalog!.name!.system!.name).toBe('Тестов');
    expect(record.catalog!.ids[0]!.name).toBe('Тестов');
    expect(record.sections.context).toEqual({ name: 'Т*****' });
  });

  it('служебные поля не меняются, id из keep открыт', () => {
    const { record } = maskKindsRecord(rec(), BUILTIN_MASKING, NONE);
    expect([record.id, record.tsNs, record.correlationId]).toEqual(['1-0', '1', '31201990000011']);
    expect(maskKindsEnvelope({ correlationId: '31201990000011', firstRecordId: '+447700900001-0', text: '+447700900001' }, strict, NONE)).toEqual({ correlationId: '31201990000011', firstRecordId: '+447700900001-0', text: '+********0001' });
  });

  it('вид выключен: обычные поля с маской, open открыт; значений выключенного вида нет — open нет', () => {
    const off = compileMasking([{ type: 'phone', enabled: false, keys: [] }]);
    const { record, hits } = maskKindsRecord(rec(), off, NONE);
    expect([...hits].sort()).toEqual(['address', 'phone']);
    expect(record.title).toBe('POST /x?phone=+********0001');
    expect(record.message).toBe('Пользователь +********0001');
    expect(record.http!.uri).toBe('/x?phone=+********0001');
    expect(record.sections.body).toBe('{"phone":"+********0001","address":"***"}');
    expect(record.raw).toBe('raw +********0001');
    expect(record.open!.uri).toBe('/x?phone=+447700900001');
    // Другие виды в open остаются с маской.
    expect(record.open!.sections.body).toBe('{"phone":"+447700900001","address":"***"}');
    expect(maskKindsRecord(rec({ sections: { headers: null, body: '{"address":"ул."}', payload: null, context: null }, raw: '', title: 't', message: '', http: null }), off, NONE).record.open).toBeUndefined();
    expect(maskKindsRecord(rec(), BUILTIN_MASKING, NONE).record.open).toBeUndefined();
  });

  it('ответ показа: только содержимое, без заголовка и разметки', () => {
    expect(Object.keys(openRecordOf(rec(), { fields: new Map(), kinds: new Set() }, NONE)).sort()).toEqual(['id', 'raw', 'sections', 'uri']);
  });
});

describe('линейное время', () => {
  const fastest = (fn: () => void) => {
    let best = Infinity;
    for (let i = 0; i < 3 && best >= 50; i++) {
      const t0 = performance.now();
      fn();
      best = Math.min(best, performance.now() - t0);
    }
    return best;
  };
  const size = 3 * 1024 * 1024;
  const fill = (s: string) => s.repeat(Math.ceil(size / s.length));
  const both = (s: string, m = strict) => maskKindsText(maskText(s, NONE), m, NONE);
  const at = compileMasking(MASK_KIND_CODES.map((t) => ({ type: t, enabled: true, keys: Array.from({ length: 200 }, (_, i) => `custom_${t}_${i}`) })));
  const everything = ALL_KINDS_MASKING.strict;
  const similar = Array.from({ length: 1000 }, (_, i) => `"custom_phone_${i}x":"a`).join(',');

  it.each([
    ['имена без закрывающей кавычки', () => fill('"mobile_phone":"a')],
    ['пары без конца', () => fill('phone=a ')],
    ['теги без закрытия', () => fill('<address>a')],
    ['закодированные теги', () => fill('%3Cexpiry%3Ea&')],
    ['серии цифр 1–30', () => Array.from({ length: 200_000 }, (_, i) => '9'.repeat(1 + (i % 30))).join(' ')],
    ['имена счёта без значения', () => fill('accounts/1 account/ accounts%2F ')],
    ['слитная строка счёта', () => fill('accounts/accounts/')],
    ['собаки без домена', () => fill('a@ b@c ')],
    ['длинная локальная часть', () => `${'a'.repeat(size)}@`],
    ['серии %25 перед 40', () => fill('%2525252540 ')],
    ['почти токен', () => fill('400000ABCDEF ')],
    ['длинная серия цифр', () => '1'.repeat(size)],
    ['плюсы перед цифрами', () => fill('+1234567 +')],
    ['почти IBAN', () => fill('DE89 3704 0044 ')],
  ])('3 МБ: %s', (_n, make) => {
    const s = make();
    expect(fastest(() => both(s, everything))).toBeLessThan(400);
  });

  describe('с правилами Узбекистана', () => {
    useRegional(UZBEKISTAN);
    it.each([
      ['серии цифр 1–30', () => Array.from({ length: 200_000 }, (_, i) => '9'.repeat(1 + (i % 30))).join(' ')],
      ['код страны без номера', () => fill('998 ')],
      ['длинная серия цифр', () => '3'.repeat(size)],
      ['почти паспорт', () => fill('AA000000 ')],
    ])('3 МБ: %s', (_n, make) => {
      const s = make();
      expect(fastest(() => both(s, everything))).toBeLessThan(400);
    });
  });

  it('словарь на пределе: 200 полей на вид, строка из похожих имён', () => {
    const s = fill(similar);
    expect(fastest(() => both(s, at.strict))).toBeLessThan(400);
    expect(at.strict.fields.size).toBeGreaterThan(13 * 200);
  });

  it('встроенные поля на месте', () => {
    expect(BUILTIN_FIELDS.phone).toContain('mobile_phone');
    expect(BUILTIN_FIELDS.national_id).toContain('national_id');
  });
});
