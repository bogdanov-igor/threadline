// Попытки обойти маску: записи секретов, которых нет у первого прохода, образцы рядом с обычными символами, номера с другим разделителем.
// Значения выдуманы, номера карт тестовые.
import { describe, expect, it } from 'vitest';
import { strictPathTemplate } from '../catalog/path.ts';
import { businessRecords, businessSummary } from '../view/business.ts';
import type { RequestSummary, ViewRecord } from './api.ts';
import { BUILTIN_FIELDS, maskingKeyIssues } from './mask-fields.ts';
import { BUILTIN_MASKING, compileMasking, maskKindsDeep, maskKindsText, viewerMasking } from './mask-pass.ts';
import { maskDeep, maskDeepOpeningCards, maskText } from './masking.ts';
import { UZBEKISTAN, useRegional } from './test-regional.ts';

const NO_KEEP: ReadonlySet<string> = new Set();
const S = 'ZqSkSecret77';
const N = '5100123440473348';
const L = '4111111234557893';

/** Обычный ответ. */
const shown = (t: string, keep: ReadonlySet<string> = NO_KEEP) => maskKindsText(maskText(t, keep), BUILTIN_MASKING.strict, keep);
/** Показ поддержки: номер открыт, секрет нет. */
const supportEye = (t: string) => maskKindsText(maskDeepOpeningCards(t, NO_KEEP), viewerMasking(BUILTIN_MASKING, 'support').reveal, NO_KEEP);
/** Показ аналитика: первого прохода нет, открыто всё. */
const analystEye = (t: string) => maskKindsText(t, viewerMasking(BUILTIN_MASKING, 'analyst').reveal, NO_KEEP);

describe('секреты вне записей первого прохода', () => {
  const FORMS = [
    // Двоеточие посреди текста, YAML, карта Go, сырой HTTP.
    `got access_token: ${S} from sso`,
    `got refresh_token: ${S} x`,
    `got id_token: ${S} x`,
    `session token: ${S}`,
    `partner api_key: ${S}`,
    `sent cookie: ${S}`,
    `x auth_token: ${S} y`,
    `x csrf_token: ${S} y`,
    `x card_token: ${S} y`,
    `map[a:1 access_token:${S} z:2]`,
    `auth:\n  access_token: ${S}\n  x: 1\n`,
    `POST /x HTTP/1.1\r\nToken: ${S}\r\n\r\n`,
    `POST /x HTTP/1.1\r\nAuthToken: ${S}\r\n\r\n`,
    `POST /x HTTP/1.1\r\nApi_Key: ${S}\r\n\r\n`,
    // Имя и значение в разных полях.
    `{"value":"${S}","name":"password"}`,
    `{"name":"password","type":"string","value":"${S}"}`,
    `{"key":"password","val":"${S}"}`,
    `{"field":"password","value":"${S}"}`,
    `{"type":"token","value":"${S}"}`,
    `[{"k":"Authorization","v":"${S}"}]`,
    `{\\"value\\":\\"${S}\\",\\"name\\":\\"password\\"}`,
    `<item><name>password</name><value>${S}</value></item>`,
    `<entry><key>pin</key><value>${S}</value></entry>`,
    `<item><value>${S}</value><name>password</name></item>`,
    // Пробел, дефис, флаг команды, русское имя, перевод строки, разметка.
    `password is ${S}`,
    `password - ${S}`,
    `--password ${S}`,
    `--api-key ${S}`,
    `cvv ${S}`,
    `CVV2 ${S}`,
    `password ${S}`,
    `пароль: ${S}`,
    `пароль=${S}`,
    `токен: ${S}`,
    `пин: ${S}`,
    `password:\n${S}`,
    `<b>password:</b> ${S}`,
    `<b>token:</b> ${S}`,
    // То же имя другим написанием.
    `{"pass_word":"${S}"}`,
    `{"password ":"${S}"}`,
    `"Authorization"=>"${S}"`,
    `{Authorization: "${S}", x: 1}`,
    `&lt;c Authorization=&quot;${S}&quot;/&gt;`,
    `/x?password[]=${S}`,
    `/x?password[0]=${S}`,
    `/x?password%5B%5D=${S}`,
    // Словарь.
    ...['pwd', 'pass', 'passcode', 'passphrase', 'password_confirmation', 'passwordConfirmation', 'password1', 'password_new', 'pin2', 'pin_value', 'otp', 'sms_code', 'secret_key', 'private_key', 'access_key', 'jwt', 'JSESSIONID', 'PHPSESSID', 'laravel_session', 'credentials', 'security_code', 'cvvValue', 'cvc_value', 'authorization_code'].map((k) => `{"${k}":"${S}"}`),
    `pwd=${S}&x=1`,
    `JSESSIONID=${S}`,
    `pwd = ${S}`,
    // Адрес.
    `connect u:${S}@dbhost failed`,
    `https:&#47;&#47;u:${S}&#64;h.example`,
    `https://u:${S}\\u0040h.example/x`,
    `curl -u u:${S} https://h.example`,
    `--user u:${S}`,
    // HTML.
    `{"html":"<input type=\\"password\\" name=\\"f1\\" value=\\"${S}\\"/>"}`,
    `<meta name="csrf-token" content="${S}">`,
    `<td>Password</td><td>${S}</td>`,
    `<dt>password</dt><dd>${S}</dd>`,
    `<field id="password">${S}</field>`,
    `<a password\n=\n"${S}"/>`,
    `<a password\\n=\\n\\"${S}\\"/>`,
    // Внутри элемента номера карты и Value.
    `<RCARD><password>${S}</password></RCARD>`,
    `<Pan><Cvv>${S}</Cvv></Pan>`,
    `<pan><pin>${S}</pin></pan>`,
    `<Value><pin>${S}</pin></Value>`,
    `<x:RCARD><x:pinBlock>${S}</x:pinBlock></x:RCARD>`,
    `{"xml":"<pan><password>${S}</password></pan>"}`,
    `&lt;pan&gt;&lt;password&gt;${S}&lt;/password&gt;&lt;/pan&gt;`,
    `<pan>${N}<access_token>${S}</access_token>`,
  ];

  it.each(FORMS)('%s: скрыто и в обычном ответе, и в показе поддержки, аналитик открывает', (form) => {
    expect(shown(form)).not.toContain(S);
    expect(supportEye(form)).not.toContain(S);
    expect(analystEye(form)).toContain(S);
  });

  it.each([
    ['pin 7788 accepted', 'pin *** accepted'],
    ['PIN 4321 пин 5678', 'PIN *** пин ***'],
    ['pin-code 1111 pincode 2222', 'pin-code *** pincode ***'],
    ['cvv 987 cvc2 654', 'cvv *** cvc2 ***'],
    [`pin ${N} rejected`, 'pin *** rejected'],
    [`pin ${L} rejected`, 'pin *** rejected'],
  ])('цифры за именем: %s', (form, want) => {
    expect(shown(form)).toBe(want);
    expect(supportEye(form)).toBe(want);
    expect(analystEye(form)).toBe(form);
  });

  it('сомнение про глазок поддержки: номер в свободном тексте открыт, номер за именем секрета и шифротекст нет', () => {
    expect(supportEye(`card ${L}`)).toBe(`card ${L}`);
    expect(supportEye(`pin ${L}`)).toBe('pin ***');
    expect(supportEye(`{"enc_pan":"${L}"}`)).toBe('{"enc_pan":"***"}');
  });

  it('значения объекта: имя в соседнем поле, разобранный контекст', () => {
    const deep = (o: unknown) => maskKindsDeep(maskDeep(o, NO_KEEP), BUILTIN_MASKING.strict, NO_KEEP);
    expect(deep({ param: { field: 'password', value: S } })).toEqual({ param: { field: 'password', value: '***' } });
    expect(deep({ param: { type: 'token', value: S } })).toEqual({ param: { type: 'token', value: '***' } });
    expect(deep([{ k: 'Authorization', v: S }])).toEqual([{ k: 'Authorization', v: '***' }]);
    expect(deep({ param: { name: 'pan', value: N } })).toEqual({ param: { name: 'pan', value: '510012******3348' } });
    expect(deep({ otp: { a: 1 } })).toEqual({ otp: '***' });
  });

  it('значение других видов в соседнем поле по-прежнему известное ограничение', () => {
    expect(shown('{"name":"address","value":"ул. Примерная, 1"}')).toBe('{"name":"address","value":"ул. Примерная, 1"}');
  });

  it('образцы значения: JWT и закрытый ключ', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.c2lnbmF0dXJl';
    expect(shown(`token was ${jwt} ok`)).toBe('token was *** ok');
    expect(shown('-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----')).toBe('***');
  });

  it.each([
    'invalid token: expired',
    'token: expired',
    'password is required',
    'password expired',
    'Неверный пароль: проверьте раскладку',
    'токен: истёк',
    'spin=1',
    '{"password_expired":false}',
    '{"token_type":"Bearer"}',
    '{"error":"phone: cannot be blank"}',
    'invalid document: wrong expiry',
    '{"type":"cookie","domain":"example.com"}',
  ])('обычный текст не меняется: %s', (text) => {
    expect(shown(text)).toBe(text);
  });

  it('маска первого прохода остаётся как есть', () => {
    expect(shown('Authorization: Bearer abc')).toBe('Authorization: Bearer ***');
    expect(shown('{"Authorization":"Bearer abc"}')).toBe('{"Authorization":"Bearer ***"}');
    expect(shown('authorization=Bearer+abc&x=1')).toBe('authorization=Bearer+***&x=1');
    expect(shown('<password><![CDATA[abc]]></password>')).toBe('<password><![CDATA[***]]></password>');
  });
});

describe('лишняя маска первого прохода', () => {
  it.each([
    ['{"response_type":"token","client_id":"abc"}', '{"response_type":"token","client_id":"abc"}'],
    ['{"event":"token","next":"refresh"}', '{"event":"token","next":"refresh"}'],
    ['{"name":"Authorization","value":"zzz"}', '{"name":"Authorization","value":"***"}'],
    ['["Authorization","zzz"]', '["Authorization","***"]'],
  ])('соседний элемент только в плоском списке: %s', (text, want) => {
    expect(shown(text)).toBe(want);
  });

  it('mailto: адрес почты, а не учётные данные', () => {
    expect(shown('<a href="mailto:bob@pay.example">x</a>')).toBe('<a href="mailto:bob@pay.example">x</a>');
  });

  it('маска числа оставляет JSON разбираемым', () => {
    const out = shown(`{"amount":447700900102,"txn":${L}}`);
    // Число без плана номеров телефоном не считается: остаётся числом.
    expect(JSON.parse(out)).toEqual({ amount: 447700900102, txn: '411111******7893' });
    expect(shown(`{\\"txn\\":${L},\\"x\\":1}`)).toBe('{\\"txn\\":\\"411111******7893\\",\\"x\\":1}');
  });
});

describe('номер карты с другим разделителем', () => {
  const grouped = (s: string, sep: string) => s.replace(/(\d{4})(?=\d)/g, `$1${sep}`);

  it.each(['.', '/', '_', ':', ',', '*', ' ', ' ', '–', '​', '\n', '\\n', '\\t', '%2D', '%C2%A0', '&nbsp;', '&#160;', '<br>', '</span> <span>', '    '])('разделитель %j', (sep) => {
    const out = shown(`card ${grouped(L, sep)} end`);
    expect(out).not.toContain('3455');
    expect(out).toContain('4111');
    expect(out).toContain('7893');
  });

  it.each(['card 41111112 34557893', 'card 411111 1234557893', 'card 4111 111234 557893'])('другая разбивка: %s', (text) => {
    expect(shown(text).replace(/\D/g, '')).toBe('4111117893');
  });

  it.each([' ', '\n', '&nbsp;', '.'])('под именем номера Лун не нужен, разделитель %j', (sep) => {
    expect(shown(`pan=${grouped(N, sep)}&x=1`)).not.toContain('4047');
  });

  it('показ поддержки открывает, значение из keep открыто, числа не по образцу не трогаются', () => {
    expect(supportEye(`card ${grouped(L, '.')}`)).toBe(`card ${grouped(L, '.')}`);
    expect(shown(`card ${grouped(L, '.')}`, new Set([L]))).toBe(`card ${grouped(L, '.')}`);
    for (const text of ['2026.11.04 15:30:12.123', '1234.5678.9012.3457', '2001:4860:4860:0000:0000:0000:0000:8888']) expect(shown(text), text).toBe(text);
  });

  it('имя номера другим написанием', () => {
    expect(shown(`{"Card Number":"${N}"}`)).toBe('{"Card Number":"510012******3348"}');
    expect(shown(`{"card__number":"${N}"}`)).toBe('{"card__number":"510012******3348"}');
    expect(shown('{"pan":"abc"}')).toBe('{"pan":"abc"}');
  });
});

describe('образцы рядом с обычными символами: международные правила', () => {
  it.each([
    ['(+44) 7700 900102', '(+**) **** **0102'],
    ['+44 7700 900102', '+** **** **0102'],
    ['+1-202-555-0102', '+*-***-***-0102'],
    ['sms+447700900102', 'sms+********0102'],
    ['tel:+447700900102', 'tel:+********0102'],
    ['id_+447700900102', 'id_+********0102'],
    ['acc_DE89370400440532013000', 'acc_DE****************3000'],
    ['x400000ABCDEF1234', 'x***'],
  ])('%s', (text, want) => {
    expect(shown(text)).toBe(want);
  });

  it.each(['5a1d0100-0000-0000-0000-447700900001', '+447700900001.50', '0.447700900001', '1+447700900001', 'deadbeefcafe+447700900001', '998900000102', 'AA0000123', 'aa0000001', 'TXN1234567', 'X400000ABCDEF1234', '20261104153012', 'acc_10500000900123456001'])('не значение: %s', (text) => {
    expect(shown(text)).toBe(text);
  });
});

describe('образцы рядом с обычными символами: пример Узбекистана', () => {
  useRegional(UZBEKISTAN);

  it.each([
    ['(+998) 90 000 01 02', '(+***) ** *** 01 02'],
    ['(998) 90 000 01 02', '(***) ** *** 01 02'],
    ['+998.90.000.01.02', '+***.**.***.01.02'],
    ['00998900000102', '**********0102'],
    ['+998 90 000 01 02', '+*** ** *** 01 02'],
    ['sms998900000102', 'sms********0102'],
    ['id_998900000102', 'id_********0102'],
    ['id-998900000102', 'id-********0102'],
    ['E998901234567', 'E********4567'],
    ['TEL-998-90-123-45-67', 'TEL-***-**-***-45-67'],
    ['pinfl-31201990000011', 'pinfl-**********0011'],
    ['pinfl_31201990000011', 'pinfl_**********0011'],
    ['31201990000011_', '**********0011_'],
    ['N31201990000277', 'N**********0277'],
    ['passportAA0000123', 'passportAA*****23'],
    ['acc_10500000900123456001', 'acc_****************6001'],
    ['x400000ABCDEF1234', 'x***'],
  ])('%s', (text, want) => {
    expect(shown(text)).toBe(want);
  });

  it.each(['5a1d0100-0000-0000-0000-998900000001', '99890123-4567-4abc-8def-0123456789ab', '998900000001.50', '0.998900000001', 'aa0000001', 'AA00000011', 'AA№0000123', 'AA  0000123', 'TXN1234567', 'X400000ABCDEF1234', '20261104153012', 'deadbeefcafe998900000001'])('не значение: %s', (text) => {
    expect(shown(text)).toBe(text);
  });

  it('id из keep открыт целиком', () => {
    const keep = new Set(['U998901234567']);
    expect(shown('request U998901234567 failed', keep)).toBe('request U998901234567 failed');
  });

  it('маска числа оставляет JSON разбираемым', () => {
    expect(JSON.parse(shown(`{"amount":998900000102,"txn":${L}}`))).toEqual({ amount: '********0102', txn: '411111******7893' });
  });
});

describe('значение вида целиком', () => {
  it.each([
    ['address=ул."Примерная-77" 1&x=1', 'address=***&x=1'],
    ['a\nAddress: ул. "Пример", 1\nb', 'a\nAddress: ***\nb'],
    ['\r\nX-Address: ул.\r\n Примерная-77\r\nHost: h', '\r\nX-Address: ***\r\nHost: h'],
    ['\\r\\nX-Address: ул.\\r\\n Примерная-77\\r\\nHost: h', '\\r\\nX-Address: ***\\r\\nHost: h'],
    ['{"data":"address=ул. 1","x":"y"}', '{"data":"address=***","x":"y"}'],
  ])('%s', (text, want) => {
    expect(shown(text)).toBe(want);
  });

  it.each([
    ['{"_phone":"900000102"}', '{"_phone":"*****0102"}'],
    ['<_phone>900000102</_phone>', '<_phone>*****0102</_phone>'],
    ['phone[]=900000102', 'phone[]=*****0102'],
    ['phone[0]=900000102', 'phone[0]=*****0102'],
    ['phone%5B%5D=900000102', 'phone%5B%5D=*****0102'],
  ])('имя той же формы: %s', (text, want) => {
    expect(shown(text)).toBe(want);
  });
});

describe('поля вида', () => {
  const enc = '{"enc_pan":"A1B2C3D4E5F6","encPan":"A1B2C3D4E5F6","pan_enc":"A1B2C3D4E5F6","hashed_pan":"A1B2C3D4E5F6"}';

  it('шифротекст номера скрыт как секрет, глазок открывает только аналитику', () => {
    expect(shown(enc)).not.toContain('A1B2');
    expect(supportEye(enc)).not.toContain('A1B2');
    expect(analystEye(enc)).toContain('A1B2');
  });

  it('новые имена видны в разделе, принадлежат секретам, номер туда не добавить', () => {
    expect(BUILTIN_FIELDS.secrets).toEqual(expect.arrayContaining(['password', 'enc_pan', 'pwd', 'otp']));
    expect(maskingKeyIssues('secrets', ['enc_pan', 'pwd'], [])).toEqual([]);
    expect(maskingKeyIssues('card_number', ['enc_pan'], [])[0]?.params).toEqual({ type: 'secrets' });
    expect(maskingKeyIssues('phone', ['otp'], [])[0]?.params).toEqual({ type: 'secrets' });
  });

  it('имя на pan, добавленное к номеру карты, работает: значение другой формы ***', () => {
    const m = compileMasking([{ type: 'card_number', enabled: true, keys: ['partner_pan', 'pan'] }]);
    expect(maskKindsText('{"partner_pan":"A1B2C3"}', m.strict, NO_KEEP)).toBe('{"partner_pan":"***"}');
    // Встроенное имя правило значения не меняет.
    expect(maskKindsText('{"pan":"A1B2C3"}', m.strict, NO_KEEP)).toBe('{"pan":"A1B2C3"}');
  });

  it('спрятанное до записи в лог не открывается', () => {
    expect(analystEye('{"masked_pan":"411111******7893"}')).toBe('{"masked_pan":"411111******7893"}');
  });
});

describe('путь у Бизнеса', () => {
  it.each([
    ['/v1/users/ivanov/profile', '/v1/users/{value}/profile'],
    ['/v1/clients/testovichev/profile?x=1', '/v1/clients/{value}/profile'],
    ['/v2/holder/rustamova/get', '/v2/holder/{value}/get'],
    ['/v1/clients/testov-anvar/profile', '/v1/clients/{value}/profile'],
    ['/v1/otp/zzsecretword', '/v1/otp/{value}'],
    ['/v1/x/aa0000123/y', '/v1/x/{value}/y'],
    ['/v1/x/u447700900102/y', '/v1/x/{value}/y'],
    ['/v1/x/abc123secret/y', '/v1/x/{value}/y'],
    ['/v1/x/a1b2c3d4e5f6/y', '/v1/x/{value}/y'],
    ['/v1/transfers/tx-20261104-7781', '/v1/transfers/{value}'],
    ['/v1/users/5a1d0100-0000-4000-8000-000000000001/cards', '/v1/users/{user}/cards'],
    ['/v2/oauth2/token', '/v2/oauth2/token'],
    ['/api/card/status-check', '/api/card/status-check'],
  ])('%s → %s', (path, template) => {
    expect(strictPathTemplate(path)).toBe(template);
  });

  it('известный остаток: слово строчными вне таких мест по форме не отличить', () => {
    expect(strictPathTemplate('/v1/foo/ivanov/bar')).toBe('/v1/foo/ivanov/bar');
  });

  const NAME = { source: 'catalog', system: null, method: { id: 1, name: 'Статус перевода', domain: null, kind: 'status', opType: null }, host: null } as const;

  it('метод с названием из справочника: пути нет ни в сводке, ни в записи', () => {
    const summary = { correlationId: 'c', firstMs: 1, lastMs: 2, durationMs: 1, incoming: { method: 'GET', path: '/v1/foo/rustamova/tx-20261104-7781' }, component: null, recordCount: 1, status: 'success', kind: 'incoming', reasons: [], match: 'exact', incomplete: false, entry: NAME } as unknown as RequestSummary;
    const out = businessSummary(summary);
    expect(out.incoming).toEqual({ method: '', path: '' });
    expect(JSON.stringify(out)).not.toContain('rustamova');
    const record = { id: 'a', tsNs: '1', timeMs: 1, offsetMs: 0, kind: 'incoming', title: 'x', message: '', level: null, isError: false, component: null, gateway: false, correlationId: 'c', requestId: null, http: { method: 'GET', uri: '/v1/foo/rustamova/tx-20261104-7781', status: null, durationMs: null, pairId: null, noResponse: false, pending: false }, sections: { headers: null, body: null, payload: null, context: null }, raw: '', match: null, catalog: { name: NAME, error: null, outcome: null, ids: [], status: null } } as unknown as ViewRecord;
    const [named] = businessRecords([record]);
    expect(named!.http!.uri).toBeNull();
    expect(named!.title).toBe('Статус перевода');
    const [unnamed] = businessRecords([{ ...record, catalog: { name: null, error: null, outcome: null, ids: [], status: null } } as ViewRecord]);
    expect(unnamed!.http!.uri).toBe('/v1/foo/rustamova/{value}');
  });
});
