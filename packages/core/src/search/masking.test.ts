import { describe, expect, it } from 'vitest';
import { luhnValid, withLuhnCheckDigit } from '../luhn.ts';
import { extractNested, formatBody } from './format.ts';
import { buildView, parseLine } from './records.ts';
import { maskDeep, maskPan, maskText, PAN_KEYS, SECRET_KEYS, withoutCredentials } from './masking.ts';
import {
  API_LABELS,
  app,
  CARDS_CID,
  GATEWAY_LABELS,
  line as recordLine,
  logLine,
  nsAfter,
  PROCESSOR_URI,
  record,
  soap,
  switchCardBody,
  switchResponseLine,
} from './test-fixtures.ts';

const NONE: ReadonlySet<string> = new Set();
const mask = (s: string, keep = NONE) => maskText(s, keep);

const PAN = '4111111234557893'; // проходит проверку Луна
const PAN_MASKED = '411111******7893';
const SWITCH_PAN = '5100123440473348'; // номер коммутатора карт, не проходит проверку Луна
const SWITCH_MASKED = '510012******3348';
const NON_LUHN_PROCESSOR = '4000000000001234';

/** Строка из 15–19 цифр с проверкой Луна, кроме разрешённых. */
/** Лучшее время из трёх запусков, мс: параллельные наборы тестов дают случайные паузы, рост от длины строки они не скрывают. */
const fastest = (fn: () => void): number => {
  let best = Infinity;
  for (let i = 0; i < 3 && best >= 50; i++) {
    const t0 = performance.now();
    fn();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
};

const leakedPans = (s: string, keep = NONE) =>
  [...s.matchAll(/(?<!\d)\d{15,19}(?!\d)/g)].map((m) => m[0]).filter((d) => luhnValid(d) && !keep.has(d));

/** Строка сборщика с записью внутри (формат json-file Docker): запись — строка JSON в поле log. */
const envelope = (r: object) => JSON.stringify({ log: recordLine(r), stream: 'stderr' });

/** Три уровня экранирования: тело → запись приложения → строка сборщика. */
const rawLineWithBody = (body: string, extra: Record<string, unknown> = {}) =>
  envelope(
    app(
      'http response received',
      { request_id: CARDS_CID, upstream: { method: 'POST', url: PROCESSOR_URI, status: 200, body, ...extra } },
      '2026-10-28T16:20:30.239658',
      CARDS_CID,
    ),
  );

describe('PAN по образцу', () => {
  it('в SOAP', () => {
    expect(mask(`<Row><Value>${PAN}</Value></Row>`)).toBe(`<Row><Value>${PAN_MASKED}</Value></Row>`);
  });

  it('в JSON и в тексте', () => {
    expect(mask(`{"sender":{"card":"${PAN}"},"amount":100}`)).toBe(
      `{"sender":{"card":"${PAN_MASKED}"},"amount":100}`,
    );
    expect(mask(`card ${PAN} declined`)).toBe(`card ${PAN_MASKED} declined`);
  });

  it('в адресе', () => {
    expect(mask(`GET /v1/pan/${PAN}/info?x=1`)).toBe(`GET /v1/pan/${PAN_MASKED}/info?x=1`);
  });

  it('в сырой строке с тройным экранированием', () => {
    const line = rawLineWithBody(JSON.stringify({ result: { cards: [{ number: PAN }] } }));
    expect(line).toContain('\\\\\\"number\\\\\\"');
    const out = mask(line);
    expect(out).not.toContain(PAN);
    expect(out).toContain(PAN_MASKED);
    expect(JSON.parse(JSON.parse(out).log).upstream.body).toContain(PAN_MASKED);
  });

  it('15 и 19 цифр маскируются, 13 и 20 — нет', () => {
    const amex = withLuhnCheckDigit('37828224631000');
    const long = withLuhnCheckDigit('622202123456789012');
    const cardsCid = withLuhnCheckDigit('630001410000');
    const twenty = withLuhnCheckDigit('6222021234567890123');
    expect(mask(amex)).toBe(maskPan(amex));
    expect(mask(long)).toBe(maskPan(long));
    expect(mask(cardsCid)).toBe(cardsCid);
    expect(mask(twenty)).toBe(twenty);
    expect(mask(`a${twenty}b`)).toBe(`a${twenty}b`);
  });

  it('номер счёта без проверки Луна виден', () => {
    expect(luhnValid('3501112344650819')).toBe(false);
    expect(mask('"bankAccountId":"3501112344650819"')).toBe('"bankAccountId":"3501112344650819"');
  });

  it('13-значный correlation_id сервиса карт виден', () => {
    expect(mask(`"correlation_id":"${CARDS_CID}"`)).toBe(`"correlation_id":"${CARDS_CID}"`);
  });

  it('keep: correlation_id и request_id из 16 цифр с проверкой Луна видны', () => {
    const cid = withLuhnCheckDigit('630001410000123');
    expect(luhnValid(cid)).toBe(true);
    const s = `"request_id":"${cid}","card":"${PAN}"`;
    expect(mask(s, new Set([cid]))).toBe(`"request_id":"${cid}","card":"${PAN_MASKED}"`);
    expect(mask(s)).not.toContain(cid);
  });

  it('сразу после %XX и \\uXXXX, которые оканчиваются цифрой', () => {
    expect(mask(`data=%7B%22pan%22%3A%22${PAN}%22%7D`)).toBe(`data=%7B%22pan%22%3A%22${PAN_MASKED}%22%7D`);
    expect(mask(`q=card%20${PAN}`)).toBe(`q=card%20${PAN_MASKED}`);
    expect(mask(`q=%27${PAN}%27`)).toBe(`q=%27${PAN_MASKED}%27`);
    expect(mask(`{"s":"\\u0022${PAN}\\u0022"}`)).toBe(`{"s":"\\u0022${PAN_MASKED}\\u0022"}`);
    const long = withLuhnCheckDigit('622202123456789012');
    expect(mask(`%22${long}%22`)).toBe(`%22${maskPan(long)}%22`);
    // keep действует и здесь; число без проверки Луна видно.
    expect(mask(`q=%20${PAN}`, new Set([PAN]))).toBe(`q=%20${PAN}`);
    expect(mask(`q=%20${NON_LUHN_PROCESSOR}`)).toBe(`q=%20${NON_LUHN_PROCESSOR}`);
  });

  it('вложенное тело form-urlencoded: после раскодирования номера нет', () => {
    const body = JSON.stringify({ form: `a=1&data=%7B%22pan%22%3A%22${PAN}%22%7D` });
    const out = maskDeep({ body }, NONE).body;
    const decoded = decodeURIComponent(JSON.parse(out).form);
    expect(decoded).toContain(`"pan":"${PAN_MASKED}"`);
    expect(leakedPans(decoded)).toEqual([]);
  });
});

describe('PAN по имени поля', () => {
  it('primaryAccountNumber без проверки Луна — ответ коммутатора карт', () => {
    expect(mask(`"primaryAccountNumber":"${SWITCH_PAN}"`)).toBe(`"primaryAccountNumber":"${SWITCH_MASKED}"`);
    const body = mask(switchCardBody());
    expect(body).toContain(`"primaryAccountNumber":"${SWITCH_MASKED}"`);
    expect(body).toContain('"bankAccountId":"3501112344650819"');
  });

  it('строка ответа целиком: тело — строка JSON внутри записи', () => {
    const out = mask(switchResponseLine().line);
    expect(out).not.toContain(SWITCH_PAN);
    expect(out).toContain(`\\"primaryAccountNumber\\":\\"${SWITCH_MASKED}\\"`);
    expect(out).toContain('3501112344650819');
    expect(out).toContain('+447700900528');
  });

  it('RCARD в сырой строке с тройным экранированием', () => {
    const line = rawLineWithBody(
      soap('getCardResponse', `<Details><RCARD>${NON_LUHN_PROCESSOR}</RCARD></Details>`),
    );
    const out = mask(line);
    expect(out).not.toContain(NON_LUHN_PROCESSOR);
    expect(out).toContain(`<RCARD>${maskPan(NON_LUHN_PROCESSOR)}</RCARD>`);
  });

  it('теги с префиксом пространства имён и атрибутами', () => {
    expect(
      mask(`<ns1:primaryAccountNumber xsi:type="xsd:string">${NON_LUHN_PROCESSOR}</ns1:primaryAccountNumber>`),
    ).toBe(
      `<ns1:primaryAccountNumber xsi:type="xsd:string">${maskPan(NON_LUHN_PROCESSOR)}</ns1:primaryAccountNumber>`,
    );
    expect(mask(`<PAN>123456789012</PAN>`)).toBe('<PAN>123456**9012</PAN>');
    expect(mask('<PAN>400000ABCDEF1234</PAN>')).toBe('<PAN>400000ABCDEF1234</PAN>');
  });

  it('FilterCondition.Value без проверки Луна', () => {
    const payload = `[{"QueryName":"CARDHOLDER_BY_PAN","QueryVariant":40,"FilterCondition":[{"Key":"PAN","Value":"${NON_LUHN_PROCESSOR}","MatchingRule":0}]}]`;
    expect(mask(payload)).toContain(`"Value":"${maskPan(NON_LUHN_PROCESSOR)}"`);
    const line = envelope(app('processor call', { request_id: CARDS_CID, action: 'getCardholder', payload: JSON.parse(payload) }, '2026-10-28T16:20:29.952467', CARDS_CID));
    expect(mask(line)).not.toContain(NON_LUHN_PROCESSOR);
  });

  it('PAN-ключи: cardNumber, card_number, pan; числом и строкой, без учёта регистра', () => {
    expect(
      mask(
        `{"CardNumber":"${NON_LUHN_PROCESSOR}","card_number":${NON_LUHN_PROCESSOR},"sender":{"pan": "${NON_LUHN_PROCESSOR}"}}`,
      ),
    ).toBe(
      `{"CardNumber":"400000******1234","card_number":"400000******1234","sender":{"pan": "400000******1234"}}`,
    );
    expect(mask('"pan":"400000ABCDEF1234"')).toBe('"pan":"400000ABCDEF1234"');
  });
});

describe('учётные данные', () => {
  it('Basic у процессинга и Bearer в тексте', () => {
    expect(mask('"Authorization":["Basic Z3dfaXNzdWluZzpGYWtlI1Bhc3MyMDI2"]')).toBe(
      '"Authorization":["Basic ***"]',
    );
    expect(mask('curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.e30.sig-_~+/="')).toBe(
      'curl -H "Authorization: Bearer ***"',
    );
    expect(mask('Proxy-Authorization: Digest dXNlcjpwYXNz')).toBe('Proxy-Authorization: Digest ***');
  });

  it('Authorization без схемы в тексте — *** целиком', () => {
    expect(mask('"Authorization":["eyJhbGciOiJIUzI1NiJ9.e30.abc"]')).toBe('"Authorization":["***"]');
    expect(mask('"authorization": "token-123"')).toBe('"authorization": "***"');
    const line = envelope(app('http request sending', { upstream: { headers: { Authorization: ['eyJhbGciOiJIUzI1NiJ9.e30.abc'] } } }, '2026-10-28T16:20:29.927658', 'c'));
    const out = mask(line);
    expect(out).not.toContain('eyJhbGci');
    expect(out).toContain('\\"Authorization\\":[\\"***\\"]');
  });

  it('maskDeep: схема остаётся, значение — ***', () => {
    const headers = {
      Authorization: ['Basic Z3dfaXNzdWluZzpGYWtlI1Bhc3MyMDI2'],
      'X-Request-Id': ['0192f3a4-5b6c-7d8e-9f01-23456789abcd'],
    };
    expect(maskDeep(headers, NONE)).toEqual({
      Authorization: ['Basic ***'],
      'X-Request-Id': ['0192f3a4-5b6c-7d8e-9f01-23456789abcd'],
    });
    expect(maskDeep({ authorization: 'bearer abc.def' }, NONE)).toEqual({ authorization: 'bearer ***' });
    expect(maskDeep({ Authorization: 'Digest username="gw", response="abc"' }, NONE)).toEqual({
      Authorization: 'Digest ***',
    });
  });

  it('maskDeep: токен без схемы — ***', () => {
    expect(maskDeep({ Authorization: ['eyJhbGciOiJIUzI1NiJ9.e30.abc'] }, NONE)).toEqual({
      Authorization: ['***'],
    });
    expect(maskDeep({ Authorization: { token: 'x' } }, NONE)).toEqual({ Authorization: '***' });
  });

  it('имя схемы без учёта регистра: bearer и BEARER в тексте — как Bearer', () => {
    expect(mask('token bearer eyJhbGciOiJIUzI1NiJ9.e30.sig rejected')).toBe('token bearer *** rejected');
    expect(mask('BEARER eyJhbGciOiJIUzI1NiJ9.e30.sig')).toBe('BEARER ***');
    expect(mask('basic Z3dfdXNlcjpzZWNyZXQ= / DIGEST dXNlcjpwYXNz')).toBe('basic *** / DIGEST ***');
    expect(mask('"note":"sent with bearer tok-SECRET-1"')).toBe('"note":"sent with bearer ***"');
  });

  it('Proxy-Authorization — как Authorization: ключ JSON, maskDeep, сырой HTTP', () => {
    expect(mask('"Proxy-Authorization":["Token tok-SECRET-1"]')).toBe('"Proxy-Authorization":["***"]');
    expect(mask('{"proxy-authorization":"bearer tok-SECRET-1"}')).toBe('{"proxy-authorization":"bearer ***"}');
    expect(mask(JSON.stringify(JSON.stringify({ 'Proxy-Authorization': ['eyJhbGciOiJIUzI1NiJ9.e30.abc'] })))).not.toContain('eyJhbGci');
    expect(maskDeep({ 'Proxy-Authorization': ['eyJhbGciOiJIUzI1NiJ9.e30.abc'], 'proxy-authorization': 'bearer x.y', Host: ['h'] }, NONE)).toEqual({
      'Proxy-Authorization': ['***'],
      'proxy-authorization': 'bearer ***',
      Host: ['h'],
    });
    expect(mask('Host: h\r\nProxy-Authorization: Token tok-SECRET-1\r\nX-A: 1')).toBe('Host: h\r\nProxy-Authorization: ***\r\nX-A: 1');
  });
});

describe('секреты по имени', () => {
  it('cardholderPassword на разных уровнях экранирования', () => {
    expect(mask('"cardholderPassword":"golden sun"')).toBe('"cardholderPassword":"***"');
    expect(mask('\\"cardholderPassword\\":\\"golden sun\\"')).toBe('\\"cardholderPassword\\":\\"***\\"');
    const line = rawLineWithBody(switchCardBody('000', { cardholderPassword: 'golden sun' }));
    const out = mask(line);
    expect(out).not.toContain('golden sun');
    expect(out).toContain('\\\\\\"cardholderPassword\\\\\\":\\\\\\"***\\\\\\"');
  });

  it('access_token эквайера, token_type остаётся', () => {
    const body =
      '{"access_token":"eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJndyJ9.c2ln","token_type":"Bearer","expires_in":3600}';
    expect(mask(body)).toBe('{"access_token":"***","token_type":"Bearer","expires_in":3600}');
    const out = mask(rawLineWithBody(body));
    expect(out).not.toContain('eyJhbGciOiJSUzI1NiJ9');
    expect(out).toContain('\\\\\\"token_type\\\\\\":\\\\\\"Bearer\\\\\\"');
  });

  it('client_secret, refresh_token, id_token на уровнях 0, 1 и 3', () => {
    for (const key of ['client_secret', 'refresh_token', 'id_token', 'Client_Secret']) {
      expect(mask(`{"${key}": "s3cr3t"}`)).toBe(`{"${key}": "***"}`);
      expect(mask(`{\\"${key}\\":\\"s3cr3t\\"}`)).toBe(`{\\"${key}\\":\\"***\\"}`);
      expect(mask(`{\\\\\\"${key}\\\\\\":\\\\\\"s3cr3t\\\\\\"}`)).toBe(
        `{\\\\\\"${key}\\\\\\":\\\\\\"***\\\\\\"}`,
      );
    }
  });

  it('client_secret= в form-urlencoded и в адресе', () => {
    expect(mask('grant_type=client_credentials&client_secret=abc')).toBe(
      'grant_type=client_credentials&client_secret=***',
    );
    expect(mask('client_secret=abc&grant_type=client_credentials')).toBe(
      'client_secret=***&grant_type=client_credentials',
    );
    expect(mask('https://x.example/cb?access_token=abc.def&state=1')).toBe(
      'https://x.example/cb?access_token=***&state=1',
    );
    expect(mask('"body":"grant_type=client_credentials&client_secret=abc"')).toBe(
      '"body":"grant_type=client_credentials&client_secret=***"',
    );
    expect(mask('\\"body\\":\\"client_secret=abc\\"')).toBe('\\"body\\":\\"client_secret=***\\"');
  });

  it('XML-тег PIN и другие секреты', () => {
    expect(mask('<PIN>1234</PIN>')).toBe('<PIN>***</PIN>');
    expect(mask('<ns1:PinBlock enc="3des">AB12CD34</ns1:PinBlock><CVV2>123</CVV2>')).toBe(
      '<ns1:PinBlock enc="3des">***</ns1:PinBlock><CVV2>***</CVV2>',
    );
    expect(mask('<PIN></PIN><pinTryCount>0</pinTryCount>')).toBe('<PIN></PIN><pinTryCount>0</pinTryCount>');
  });

  it('числовое значение секрета', () => {
    expect(mask('{"pin":1234,"cvv":"123"}')).toBe('{"pin":"***","cvv":"***"}');
    expect(mask('{\\"cvc2\\": 123}')).toBe('{\\"cvc2\\": \\"***\\"}');
  });

  it('похожие ключи не маскируются', () => {
    expect(mask('{"pinTryCount":0,"password_expired":false,"secretary":"x"}')).toBe(
      '{"pinTryCount":0,"password_expired":false,"secretary":"x"}',
    );
  });

  it('PIN не попадает под правило PAN: секреты раньше', () => {
    const pinLike = withLuhnCheckDigit('123456789012345');
    expect(mask(`{"pinBlock":"${pinLike}"}`)).toBe('{"pinBlock":"***"}');
  });

  it('списки ключей в нижнем регистре', () => {
    for (const k of [...SECRET_KEYS, ...PAN_KEYS]) expect(k).toBe(k.toLowerCase());
  });
});

describe('maskDeep', () => {
  it('секреты и PAN на любой глубине', () => {
    const v = {
      payload: [
        { primaryAccountNumber: NON_LUHN_PROCESSOR, accountType: 'DEFAULT' },
        { FilterCondition: [{ Key: 'PAN', Value: NON_LUHN_PROCESSOR }] },
      ],
      result: {
        card: {
          cardholderPassword: 'blue river',
          nameOnCard: 'ALEX JOHNSON',
          pan: Number('4000000000001234'),
        },
      },
      text: `card ${PAN}`,
      numbers: [Number(PAN), 1793180955486.322, 92],
      pin: null,
    };
    expect(maskDeep(v, NONE)).toEqual({
      payload: [
        { primaryAccountNumber: '400000******1234', accountType: 'DEFAULT' },
        { FilterCondition: [{ Key: 'PAN', Value: '400000******1234' }] },
      ],
      result: { card: { cardholderPassword: '***', nameOnCard: 'ALEX JOHNSON', pan: '400000******1234' } },
      text: `card ${PAN_MASKED}`,
      numbers: [PAN_MASKED, 1793180955486.322, 92],
      pin: null,
    });
  });

  it('не меняет исходный объект', () => {
    const input = {
      headers: { Authorization: ['Basic abc'] },
      body: `{"pan":"${PAN}"}`,
      list: [{ password: 'x' }],
    };
    const copy = structuredClone(input);
    const out = maskDeep(input, NONE);
    expect(input).toEqual(copy);
    expect(out).not.toBe(input);
    expect(out.headers).not.toBe(input.headers);
    expect(out.list[0]).not.toBe(input.list[0]);
  });

  it('ключ-PAN тоже маскируется, __proto__ остаётся данными', () => {
    const v = JSON.parse(`{"${PAN}":{"x":1},"__proto__":{"password":"x"}}`) as Record<string, unknown>;
    const out = maskDeep(v, NONE) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual([PAN_MASKED, '__proto__']);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(out, '__proto__')?.value).toEqual({ password: '***' });
  });

  it('служебные tsNs, id и pairId записей не портятся, даже если проходят проверку Луна', () => {
    const tsNs = withLuhnCheckDigit('179318095549578735');
    const v = { id: `${tsNs}-3`, tsNs, http: { pairId: `${tsNs}-4` }, context: { id: PAN, tsNs: 'x' } };
    expect(maskDeep(v, NONE)).toEqual({
      id: `${tsNs}-3`,
      tsNs,
      http: { pairId: `${tsNs}-4` },
      context: { id: PAN_MASKED, tsNs: 'x' },
    });
  });

  it('ответ API с записями запроса: нет PAN ни в одном поле', () => {
    const records = [
      parseLine(switchResponseLine()),
      parseLine(record(app('processor call', { request_id: CARDS_CID, action: 'getBalance', payload: [{ primaryAccountNumber: PAN }] }, '2026-10-30T16:49:15.100000', CARDS_CID))),
      parseLine(logLine('1793180955495787352', `{"msg":"card ${PAN}`)),
    ];
    const keep = new Set([CARDS_CID]);
    const out = maskDeep({ records: buildView(records, { withOffsets: true }) }, keep);
    const json = JSON.stringify(out);
    expect(leakedPans(json, keep)).toEqual([]);
    expect(json).not.toContain(SWITCH_PAN);
    expect(json).toContain(SWITCH_MASKED);
    expect(out.records.map((r) => r.id)).toEqual(buildView(records, { withOffsets: true }).map((r) => r.id));
  });
});

describe('устойчивость', () => {
  it('повторное маскирование ничего не меняет', () => {
    const line = rawLineWithBody(switchCardBody('000', { cardholderPassword: 'golden sun' }), {
      headers: { Authorization: ['Bearer abc'] },
    });
    const once = mask(line);
    expect(mask(once)).toBe(once);
  });

  it('сырая строка ~3 МБ с SOAP и JSON маскируется быстрее 200 мс', () => {
    const rows: string[] = [];
    for (let i = 0, size = 0; size < 2_100_000; i++) {
      const pan = withLuhnCheckDigit(`411111${String(i).padStart(9, '0')}`);
      const row = `<Row><RCARD>${pan}</RCARD><nameOnCard>ALEX JOHNSON</nameOnCard><Value>${pan}</Value><PIN>1234</PIN><bankAccountId>2020800012345678${i % 10}</bankAccountId></Row>`;
      rows.push(row);
      size += row.length;
    }
    const soapBody = soap('getCardholderResponse', rows.join(''));
    const items = Array.from({ length: 4000 }, (_, i) => ({
      primaryAccountNumber: `555555${String(i).padStart(10, '0')}`,
      cardholderPassword: 'golden sun',
      note: `card ${withLuhnCheckDigit(`676712${String(i).padStart(9, '0')}`)}`,
      statuses: { item: [{ type: 'card', actionCode: '000' }] },
    }));
    const line = rawLineWithBody(soapBody, {
      json: JSON.stringify({ items }),
      headers: { Authorization: ['Basic Z3dfaXNzdWluZzpGYWtl'] },
    });
    expect(line.length).toBeGreaterThan(3_000_000);

    let out = '';
    const ms = fastest(() => {
      out = mask(line);
    });

    expect(ms).toBeLessThan(200);
    expect(leakedPans(out)).toEqual([]);
    expect(out).not.toContain('golden sun');
    expect(out).not.toContain('<PIN>1234</PIN>');
    expect(out).not.toMatch(/primaryAccountNumber\\+":\\+"555555\d{10}/);
  });

  it('вырожденные строки без катастрофического перебора', () => {
    const samples = [
      '\\'.repeat(1_000_000) + '"password',
      '"password":"' + 'a'.repeat(1_000_000),
      '"'.repeat(1_000_000),
      '<PIN'.repeat(250_000),
      '<PIN a="' + 'x'.repeat(1_000_000),
      '<RCARD>' + '1'.repeat(1_000_000),
      '9'.repeat(1_000_000),
      '&client_secret='.repeat(60_000),
      'Bearer '.repeat(150_000),
      '&lt;PIN&gt;'.repeat(100_000),
      '&lt;pan x'.repeat(100_000),
      '%5C'.repeat(300_000) + '%22password',
      '%26password%3D'.repeat(70_000),
      '\\'.repeat(1_000_000) + '&quot;password',
      '&quot;password&quot;:&quot;' + 'a'.repeat(1_000_000),
      '"password":[' + 'x'.repeat(1_000_000),
      '\\"pan\\":\\"' + '\\'.repeat(1_000_000),
      'password="' + 'a'.repeat(1_000_000),
      'Authorization: Digest a="' + 'b'.repeat(1_000_000),
      '<password><![CDATA[' + 'x'.repeat(1_000_000),
    ];
    for (const s of samples) expect(fastest(() => mask(s))).toBeLessThan(200);
  });
});

describe('Authorization в сыром HTTP шлюза', () => {
  const keep = new Set<string>();
  it('маскирует значение целиком, включая символы вне base64', () => {
    const raw = 'GET /v1/x HTTP/1.1\\\\r\\\\nAuthorization: Bearer JR6sk+vAn/PLG8мио~!@#tail9\\\\r\\\\nX-Correlation-Id: 5a1d0300-0000-4000-8000-000000000003\\\\r\\\\n';
    const out = maskText(raw, keep);
    expect(out).toContain('Authorization: Bearer ***');
    expect(out).not.toContain('tail9');
    expect(out).not.toContain('мио');
    expect(out).toContain('X-Correlation-Id: 5a1d0300-0000-4000-8000-000000000003');
  });
  it('маскирует значение без схемы', () => {
    const out = maskText('Host: a\r\nAuthorization: eyJhbGciOi.secret.sig\r\nX-Request-Id: 1', keep);
    expect(out).toContain('Authorization: ***');
    expect(out).not.toContain('eyJhbGciOi');
    expect(out).toContain('X-Request-Id: 1');
  });
  it('не трогает другие заголовки и JSON-ключ Authorization с массивом', () => {
    const out = maskText('{"Authorization":["Basic Z3c6cGFzcw=="],"Host":["h"]}', keep);
    expect(out).toContain('"Basic ***"');
    expect(out).toContain('"Host":["h"]');
  });
});

/** Строка, n раз упакованная в строку JSON, и обратно. */
const wrap = (s: string, n: number) => {
  let out = s;
  for (let i = 0; i < n; i++) out = JSON.stringify(out);
  return out;
};
const unwrap = (s: string, n: number) => {
  let out = s;
  for (let i = 0; i < n; i++) out = JSON.parse(out) as string;
  return out;
};

describe('экранированная кавычка внутри значения', () => {
  it('пароль с " на уровнях 0, 1 и 2: хвост скрыт, JSON цел, вложенное тело на месте', () => {
    const body = JSON.stringify({
      result: { cardholderPassword: 'zz"TAILSECRET', data: JSON.stringify({ k: { v: 1 } }) },
    });
    for (const n of [0, 1, 2]) {
      const out = unwrap(mask(wrap(body, n)), n);
      expect(out).not.toContain('TAILSECRET');
      expect(JSON.parse(out)).toEqual({ result: { cardholderPassword: '***', data: '{"k":{"v":1}}' } });
      expect(formatBody(out).lang).toBe('json');
      expect(extractNested(out).map((b) => b.path)).toEqual(['result.data']);
    }
  });

  it('секрет, который кончается косой чертой, не захватывает следующий ключ', () => {
    const body = JSON.stringify({ password: 'a\\', secret: 'S3CRET' });
    for (const n of [0, 1, 2]) {
      expect(JSON.parse(unwrap(mask(wrap(body, n)), n))).toEqual({ password: '***', secret: '***' });
    }
  });

  it('пароль с кавычкой; номер карты с косыми чертами в конце значения', () => {
    expect(mask(JSON.stringify({ password: 'ab"cd' }))).toBe('{"password":"***"}');
    expect(mask(JSON.stringify({ pan: `${NON_LUHN_PROCESSOR}\\` }))).toBe(
      JSON.stringify({ pan: `${maskPan(NON_LUHN_PROCESSOR)}\\` }),
    );
  });

  it('Digest с параметрами в кавычках: в JSON заголовков и в сыром HTTP на любом уровне', () => {
    const digest = 'Digest username="pay_iss", realm="processor", nonce="N0NCE", response="R3SPHASH"';
    const headers = JSON.stringify({ headers: { Authorization: [digest] } });
    for (const n of [0, 1, 2]) {
      expect(JSON.parse(unwrap(mask(wrap(headers, n)), n))).toEqual({ headers: { Authorization: ['Digest ***'] } });
    }
    const http = `POST /t HTTP/1.1\r\nAuthorization: ${digest}\r\nHost: h\r\n\r\n{}`;
    for (const n of [0, 1, 2, 3]) {
      const out = mask(wrap(http, n));
      expect(out).not.toMatch(/N0NCE|R3SPHASH/);
      expect(unwrap(out, n)).toBe('POST /t HTTP/1.1\r\nAuthorization: Digest ***\r\nHost: h\r\n\r\n{}');
    }
  });
});

describe('массив под ключом секрета или номера карты', () => {
  it.each([
    ['{"cards":[{"pan":["5100111122223338"]}]}', '{"cards":[{"pan":["510011******3338"]}]}'],
    ['{"pan":[5100111122223338, 5]}', '{"pan":["510011******3338", 5]}'],
    ['{"password":["hunter2"]}', '{"password":["***"]}'],
    ['{"pin":[1234]}', '{"pin":["***"]}'],
    ['{"Authorization":["Bearer a","xyz"]}', '{"Authorization":["Bearer ***","***"]}'],
    ['{"Authorization":[]}', '{"Authorization":[]}'],
  ])('%s', (input, expected) => {
    expect(mask(input)).toBe(expected);
    expect(unwrap(mask(wrap(input, 1)), 1)).toBe(expected);
    expect(unwrap(mask(wrap(input, 2)), 2)).toBe(expected);
  });

  it('JSON с отступами внутри строки JSON: элемент после экранированного перевода строки', () => {
    const pretty = JSON.stringify({ Authorization: ['tok-SECRET'], pin: [1234] }, null, 2);
    for (const n of [1, 2]) {
      const out = unwrap(mask(wrap(pretty, n)), n);
      expect(out).not.toMatch(/tok-SECRET|1234/);
      expect(JSON.parse(out)).toEqual({ Authorization: ['***'], pin: ['***'] });
    }
  });
});

describe('CDATA в тегах секретов и номеров карт', () => {
  it('значение в CDATA скрыто, обёртка CDATA остаётся', () => {
    expect(mask('<cardholderPassword><![CDATA[golden sun]]></cardholderPassword>')).toBe(
      '<cardholderPassword><![CDATA[***]]></cardholderPassword>',
    );
    expect(mask('<ns:password xsi:type="xsd:string"><![CDATA[s3cret]]></ns:password>')).toBe(
      '<ns:password xsi:type="xsd:string"><![CDATA[***]]></ns:password>',
    );
    expect(mask(`<RCARD><![CDATA[${SWITCH_PAN}]]></RCARD>`)).toBe(`<RCARD><![CDATA[${SWITCH_MASKED}]]></RCARD>`);
    const json = JSON.stringify({ body: `<r><RCARD><![CDATA[${SWITCH_PAN}]]></RCARD></r>` }).replace(
      '</RCARD>',
      '<\\/RCARD>',
    );
    expect(mask(json)).toBe(json.replace(SWITCH_PAN, SWITCH_MASKED));
  });

  it('много тегов с CDATA без закрытия — линейно', () => {
    expect(fastest(() => mask('<password><![CDATA[x]]>'.repeat(200_000)))).toBeLessThan(1000);
  });
});

describe('Value в FilterCondition', () => {
  it('в SOAP и в сырой строке с тройным экранированием', () => {
    const xml = `<ns1:FilterCondition><ns1:Key>PAN</ns1:Key><ns1:Value>${NON_LUHN_PROCESSOR}</ns1:Value></ns1:FilterCondition>`;
    expect(mask(xml)).toBe(xml.replace(NON_LUHN_PROCESSOR, maskPan(NON_LUHN_PROCESSOR)));
    const out = mask(rawLineWithBody(soap('retrieveData', xml)));
    expect(out).not.toContain(NON_LUHN_PROCESSOR);
    expect(out).toContain(`<ns1:Value>${maskPan(NON_LUHN_PROCESSOR)}</ns1:Value>`);
  });

  it('числом: в тексте и в maskDeep', () => {
    expect(mask(`{"Value":${NON_LUHN_PROCESSOR}}`)).toBe(`{"Value":"${maskPan(NON_LUHN_PROCESSOR)}"}`);
    expect(maskDeep({ FilterCondition: [{ Key: 'PAN', Value: Number(NON_LUHN_PROCESSOR) }] }, NONE)).toEqual({
      FilterCondition: [{ Key: 'PAN', Value: maskPan(NON_LUHN_PROCESSOR) }],
    });
    expect(mask(`<Value>${NON_LUHN_PROCESSOR}</Value>`, new Set([NON_LUHN_PROCESSOR]))).toBe(`<Value>${NON_LUHN_PROCESSOR}</Value>`);
  });
});

describe('пары имя=значение', () => {
  it('после экранированного перевода строки, #, [ и \\u0026', () => {
    expect(mask('POST /t HTTP/1.1\\r\\n\\r\\nclient_secret=abc&grant_type=x')).toBe(
      'POST /t HTTP/1.1\\r\\n\\r\\nclient_secret=***&grant_type=x',
    );
    const line = wrap('POST /t HTTP/1.1\r\nHost: h\r\n\r\npassword=PW-abc&username=u', 3);
    expect(mask(line)).not.toContain('PW-abc');
    expect(mask('https://a/cb#access_token=abc&t=b')).toBe('https://a/cb#access_token=***&t=b');
    expect(mask('x\\u0026client_secret=abc')).toBe('x\\u0026client_secret=***');
    expect(mask('params=[client_secret=abc]')).not.toContain('abc');
  });

  it('значение в кавычках скрыто целиком', () => {
    expect(mask('password="abc def"')).toBe('password="***"');
    expect(mask("password='it\"s'")).toBe("password='***'");
    expect(mask(JSON.stringify({ note: 'password="abc"' }))).toBe(JSON.stringify({ note: 'password="***"' }));
  });

  it('похожие имена не трогаются, префикс через _ — то же имя', () => {
    expect(mask('spin=1 secretary=x')).toBe('spin=1 secretary=x');
    expect(mask('my_password=a spin=1')).toBe('my_password=*** spin=1');
  });
});

describe('слои, которые раскрывает браузер: сущности XML и percent-encoding', () => {
  const CODE_WORD = 'golden sun';
  const LUHN_PAN = withLuhnCheckDigit('676712345678900');

  /** Ни тело после маскирования, ни его вложенные тела не содержат секретов; маскирование их уже не меняет. */
  function checkNested(body: string, secrets: string[]) {
    const masked = mask(body);
    const blocks = extractNested(masked);
    for (const t of [masked, ...blocks.map((b) => b.text)]) {
      for (const x of secrets) expect(t).not.toContain(x);
      expect(leakedPans(t)).toEqual([]);
      expect(mask(t)).toBe(t);
    }
    return blocks;
  }

  it('JSON сущностями в тексте XML: pan и cvv (как mainSoapProxyFee)', () => {
    const body = `<checkFee><payload>{&quot;card&quot;:{&quot;pan&quot;:&quot;${SWITCH_PAN}&quot;,&quot;cvv&quot;:&quot;987&quot;}}</payload></checkFee>`;
    const blocks = checkNested(body, [SWITCH_PAN, '987']);
    expect(blocks).toEqual([
      { path: 'checkFee.payload', lang: 'json', text: expect.stringContaining(`"pan": "${SWITCH_MASKED}"`) },
    ]);
    checkNested('<a>{&#34;pin&#34;:1234,&#x22;primaryAccountNumber&#x22;:&#x22;' + SWITCH_PAN + '&#x22;}</a>', [
      SWITCH_PAN,
      '1234',
    ]);
  });

  it('XML сущностями внутри XML внутри JSON: секрет, RCARD с атрибутом, двойные сущности', () => {
    const inner = `&lt;r&gt;&lt;cardholderPassword&gt;${CODE_WORD}&lt;/cardholderPassword&gt;&lt;ns:RCARD a=&quot;1&quot;&gt;${SWITCH_PAN}&lt;/ns:RCARD&gt;&lt;/r&gt;`;
    const body = JSON.stringify({ envelope: `<Envelope><Body><return>${inner}</return></Body></Envelope>` });
    const blocks = checkNested(body, [CODE_WORD, SWITCH_PAN]);
    expect(blocks.map((b) => b.path)).toEqual(['envelope', 'envelope.Envelope.Body.return']);
    checkNested(`<a>&amp;lt;password&amp;gt;${CODE_WORD}&amp;lt;/password&amp;gt;</a>`, [CODE_WORD]);
    // В сырой строке тело экранировано ещё дважды, закрывающий тег — <\/RCARD>.
    const raw = mask(rawLineWithBody(`<return>&lt;RCARD&gt;${SWITCH_PAN}&lt;\\/RCARD&gt;</return>`));
    expect(raw).not.toContain(SWITCH_PAN);
  });

  it('JSON в JSON в тексте XML (\\&quot;) и в percent-encoding (%5C%22)', () => {
    const inner = JSON.stringify({ password: 'S3cretPw' });
    const xml = `<p>${JSON.stringify({ a: inner }).replace(/"/g, '&quot;')}</p>`;
    expect(xml).toContain('\\&quot;password\\&quot;');
    checkNested(xml, ['S3cretPw']);
    const form = `v=${encodeURIComponent(JSON.stringify({ a: inner }))}&z=1`;
    expect(form).toContain('%5C%22password%5C%22');
    checkNested(form, ['S3cretPw']);
  });

  it('form-urlencoded: JSON с паролем, номером карты и Authorization; XML; пары внутри значения', () => {
    const json = JSON.stringify({ password: 'S3cretPw', pan: SWITCH_PAN, card: LUHN_PAN, Authorization: ['Bearer tok-SECRET'] });
    const blocks = checkNested(`data=${encodeURIComponent(json)}&lang=en`, ['S3cretPw', SWITCH_PAN, 'tok-SECRET']);
    expect(blocks.map((b) => `${b.path} · ${b.lang}`)).toEqual(['data · json']);
    checkNested(`x=${encodeURIComponent(`<r><RCARD>${SWITCH_PAN}</RCARD></r>`)}&y=1`, [SWITCH_PAN]);
    checkNested(`x=${encodeURIComponent(`<r><RCARD>${SWITCH_PAN}<\\/RCARD></r>`)}&y=1`, [SWITCH_PAN]);
    checkNested(`q=${encodeURIComponent('user=u&password=S3cretPw')}&x=1`, ['S3cretPw']);
    checkNested(`<q>grant_type=x&amp;client_secret=S3cretPw&amp;scope=y</q>`, ['S3cretPw']);
  });
});

describe('номер карты числом выше 2^53', () => {
  it('JSON.parse округлил число: маска без проверки Луна', () => {
    const pan = '9100123400010005';
    expect(luhnValid(pan)).toBe(true);
    expect(String(Number(pan))).not.toBe(pan);
    expect(maskDeep({ card: Number(pan) }, NONE).card).toMatch(/^910012\*{6}\d{4}$/);
    // Безопасное целое без проверки Луна остаётся числом.
    expect(maskDeep({ id: 3501112344650819 }, NONE).id).toBe(3501112344650819);
  });
});

describe('кавычка и обратная косая черта в значении Authorization', () => {
  // Хвост после " или \ раньше оставался виден: значение обрывалось на первой кавычке.
  const TOKENS = [
    'abc"TAIL1',
    '"TAIL1',
    'abc"TAIL1"',
    'a"b"TAIL1',
    'abc\\"TAIL1',
    'abc\\TAIL1',
    'TAIL1\\',
    'TAIL1\\n',
  ];
  const SCHEMES = ['Bearer ', 'Basic ', 'Digest ', ''];
  const values = () => TOKENS.flatMap((t) => SCHEMES.map((s) => ({ v: s + t, masked: `${s}***` })));

  it('сырой HTTP на уровнях 0–3: значение скрыто до конца строки заголовка, остальное цело', () => {
    const http = (v: string) => `POST /t HTTP/1.1\r\nAuthorization: ${v}\r\nHost: h\r\n\r\n{"a":1}`;
    for (const { v, masked } of values()) {
      for (const n of [0, 1, 2, 3]) {
        const out = mask(wrap(http(v), n));
        expect(out).not.toContain('TAIL1');
        expect(unwrap(out, n)).toBe(http(masked));
        expect(mask(out)).toBe(out);
      }
    }
  });

  it('заголовок последним в строке JSON: значение до закрывающей кавычки этого уровня', () => {
    const doc = (v: string) =>
      JSON.stringify({ headers: [`Authorization: ${v}`, 'Host: h'], note: `Authorization: ${v}` });
    for (const { v, masked } of values()) {
      for (const n of [0, 1, 2, 3]) {
        const out = mask(wrap(doc(v), n));
        expect(out).not.toContain('TAIL1');
        expect(unwrap(out, n)).toBe(doc(masked));
      }
    }
  });

  it('ключ Authorization: строка и массив на уровнях 0–3', () => {
    const doc = (v: unknown) => JSON.stringify({ headers: { Authorization: v, 'X-Id': 'id-1' } });
    for (const t of TOKENS) {
      for (const n of [0, 1, 2, 3]) {
        expect(unwrap(mask(wrap(doc(`Bearer ${t}`), n)), n)).toBe(doc('Bearer ***'));
        expect(unwrap(mask(wrap(doc([`Basic ${t}`, t]), n)), n)).toBe(doc(['Basic ***', '***']));
      }
    }
  });

  it('curl, Proxy-Authorization и maskDeep', () => {
    expect(mask('curl -H "Authorization: Bearer abc\\"TAIL1" https://x')).toBe(
      'curl -H "Authorization: Bearer ***" https://x',
    );
    expect(mask('{"h":"Host: h\\r\\nProxy-Authorization: Basic a\\"TAIL1\\r\\nX: 1"}')).toBe(
      '{"h":"Host: h\\r\\nProxy-Authorization: Basic ***\\r\\nX: 1"}',
    );
    expect(
      maskDeep(
        {
          raw_request: 'GET / HTTP/1.1\r\nAuthorization: Bearer abc"TAIL1\r\nHost: h',
          note: 'Authorization: a"TAIL1',
        },
        NONE,
      ),
    ).toEqual({
      raw_request: 'GET / HTTP/1.1\r\nAuthorization: Bearer ***\r\nHost: h',
      note: 'Authorization: ***',
    });
  });

  it('вырожденные строки с Authorization — линейно', () => {
    const samples = [
      '"Authorization: ' + '\\'.repeat(1_000_000),
      '"Authorization: x' + '\\'.repeat(1_000_000) + '"',
      '\\'.repeat(1_000_000) + '"Authorization: x' + '\\'.repeat(1_000_000) + 'r',
      '\\'.repeat(1_000_000) + 'nAuthorization: ' + 'x\\"'.repeat(300_000),
      '\\nAuthorization: '.repeat(50_000),
      '"Authorization: Bearer ' + '\\\\\\"'.repeat(200_000),
      '"' + 'a'.repeat(1_000_000) + 'Authorization: x',
      '\n' + 'a-'.repeat(500_000) + 'Authorization: x',
      ('"' + 'a'.repeat(1000)).repeat(1000) + 'Authorization: x',
      'x Authorization: ' + '"'.repeat(1_000_000),
    ];
    for (const s of samples) expect(fastest(() => mask(s))).toBeLessThan(200);
  });
});

// ---------- Записи, которые правила раньше пропускали ----------

/** Тело и его вложенные тела без секретов; повторное маскирование их не меняет. */
function cleanNested(body: string, secrets: string[]): string {
  const masked = mask(body);
  for (const t of [masked, ...extractNested(masked).map((b) => b.text)]) {
    for (const x of secrets) expect(t, body).not.toContain(x);
    expect(leakedPans(t)).toEqual([]);
    expect(mask(t)).toBe(t);
  }
  return masked;
}

/** Запись Go encoding/json: <, > и & как \u003c, \u003e, \u0026. */
const goJson = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
/** Строка JSON от System.Text.Json (.NET): кавычка внутри — \u0022. */
const dotnetString = (s: string) => JSON.stringify(s).replace(/\\"/g, '\\u0022');
/** PHP json_encode: «/» как «\/». */
const phpString = (s: string) => JSON.stringify(s).replace(/\//g, '\\/');

describe('CDATA с пробелами и «<» внутри, пробел в закрывающем теге, Value', () => {
  const masked = (xml: string) => xml.replace(SWITCH_PAN, SWITCH_MASKED);
  const PAN_XML = [
    `<RCARD>\n<![CDATA[${SWITCH_PAN}]]>\n</RCARD>`,
    `<r>\n  <ns1:RCARD xsi:type="xsd:string">\n    <![CDATA[${SWITCH_PAN}]]>\n  </ns1:RCARD>\n</r>`,
    `<RCARD>${SWITCH_PAN}</RCARD >`,
    `<RCARD>\n  ${SWITCH_PAN}\n</RCARD>`,
    `<Value> ${SWITCH_PAN} </Value>`,
    `<Value><![CDATA[${SWITCH_PAN}]]></Value>`,
    `<ns1:Value>\n  <![CDATA[ ${SWITCH_PAN} ]]>\n</ns1:Value >`,
  ];

  it('номер карты скрыт на уровнях 0–3, с «<\\/» у PHP и без', () => {
    for (const xml of PAN_XML) {
      for (const n of [0, 1, 2, 3]) expect(unwrap(mask(wrap(xml, n)), n), `${xml} / ${n}`).toBe(masked(xml));
      expect(mask(phpString(xml))).not.toContain(SWITCH_PAN);
      expect(mask(phpString(phpString(xml)))).not.toContain(SWITCH_PAN);
    }
  });

  it('секрет в CDATA с отступами, с «<» и «]» внутри', () => {
    expect(mask('<password>\n  <![CDATA[s3cret]]>\n</password>')).toBe('<password>\n  <![CDATA[***]]>\n</password>');
    expect(mask('<password><![CDATA[a<b]]></password>')).toBe('<password><![CDATA[***]]></password>');
    expect(mask('<password><![CDATA[a]]]></password>')).toBe('<password><![CDATA[***]]></password>');
    expect(mask('<password>s3cret</password >')).toBe('<password>***</password >');
    for (const n of [1, 2]) expect(mask(wrap('<pin>\n  <![CDATA[1234]]>\n</pin>', n))).not.toContain('1234');
  });

  it('CDATA и Value сущностями XML и в %XX', () => {
    for (const xml of [`<RCARD><![CDATA[${SWITCH_PAN}]]></RCARD>`, `<Value>${SWITCH_PAN}</Value>`, `<Value> ${SWITCH_PAN} </Value>`, `<password><![CDATA[S3cretPw]]></password>`]) {
      const ent = xml.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      cleanNested(`<return>${ent}</return>`, [SWITCH_PAN, 'S3cretPw']);
      cleanNested(`x=${encodeURIComponent(xml)}&y=1`, [SWITCH_PAN, 'S3cretPw']);
    }
  });

  it('Value: keep и не 12–19 цифр — как есть', () => {
    expect(mask(`<Value> ${SWITCH_PAN} </Value>`, new Set([SWITCH_PAN]))).toBe(`<Value> ${SWITCH_PAN} </Value>`);
    expect(mask('<Value>CARD</Value><value>1234567890123</value>')).toBe('<Value>CARD</Value><value>1234567890123</value>');
  });
});

describe('<, >, & и " через \\uXXXX (Go, .NET) и числовые ссылки с нулями', () => {
  it('Go: XML в строке JSON, сущности внутри Go-JSON, на уровнях 1 и 2', () => {
    const cases: [string, string[]][] = [
      [`<r><RCARD>${SWITCH_PAN}</RCARD></r>`, [SWITCH_PAN]],
      ['<r><password>S3cretPw</password></r>', ['S3cretPw']],
      ['<a>{&quot;password&quot;:&quot;S3cretPw&quot;}</a>', ['S3cretPw']],
      [`<a>&lt;RCARD&gt;${SWITCH_PAN}&lt;/RCARD&gt;</a>`, [SWITCH_PAN]],
    ];
    for (const [body, secrets] of cases) {
      const one = goJson({ body });
      const out = mask(one);
      for (const x of secrets) expect(out, one).not.toContain(x);
      expect(JSON.parse(out).body).toBe(mask(body));
      const two = goJson({ log: goJson({ body }) });
      for (const x of secrets) expect(mask(two), two).not.toContain(x);
    }
  });

  it('.NET: JSON в строке с \\u0022, экранированная кавычка в значении', () => {
    const inner = JSON.stringify({ password: 'S3cret"TAIL', pan: SWITCH_PAN, note: 'ok' });
    const line = `{"body":${dotnetString(inner)}}`;
    expect(line).toContain('\\u0022password\\u0022');
    const out = mask(line);
    expect(out).not.toMatch(/S3cret|TAIL/);
    expect(JSON.parse(JSON.parse(out).body)).toEqual({ password: '***', pan: SWITCH_MASKED, note: 'ok' });
    // Пароль с косой чертой в конце не съедает следующий ключ.
    const bs = `{"body":${dotnetString(JSON.stringify({ cvv: 'x\\', secret: 'S3cret' }))}}`;
    expect(JSON.parse(JSON.parse(mask(bs)).body)).toEqual({ cvv: '***', secret: '***' });
  });

  it('&#034; (JSTL escapeXml), &#x0022;, &#060; и &#062;', () => {
    cleanNested('<a>{&#034;password&#034;:&#034;S3cretPw&#034;,&#034;pan&#034;:&#034;' + SWITCH_PAN + '&#034;}</a>', ['S3cretPw', SWITCH_PAN]);
    cleanNested('<a>{&#x0022;pin&#x0022;:&#x0022;S3cretPw&#x0022;}</a>', ['S3cretPw']);
    cleanNested('<a>&#060;password&#062;S3cretPw&#060;/password&#062;</a>', ['S3cretPw']);
    cleanNested(`<a>&#x3C;RCARD&#x3E;${SWITCH_PAN}&#x3C;/RCARD&#x3E;</a>`, [SWITCH_PAN]);
  });

  it('сквозь разбор и maskDeep: шлюз (контейнер server) с XML в сыром запросе и запись api', () => {
    const http = (body: string) => `POST /v1/x HTTP/1.1\r\nHost: h\r\nContent-Type: text/xml\r\n\r\n${body}`;
    const gw = {
      time: '2026-11-01T10:11:12.345678+05:00',
      level: 'debug',
      msg: 'request received',
      raw_request: http(`<r><RCARD>${SWITCH_PAN}</RCARD><password>S3cretPw</password></r>`),
    };
    const gateway = logLine(nsAfter('2026-11-01T10:11:12.345678', 0), goJson(gw), { ...GATEWAY_LABELS, container: 'server' });
    const api = record(
      app(
        'http response received',
        { request_id: 'r1', upstream: { method: 'POST', url: 'http://x/y', status: 200, body: `<Envelope><Body>\n  <password>\n    <![CDATA[S3cretPw]]>\n  </password>\n</Body></Envelope>` } },
        '2026-11-01T10:11:12.359832',
        'c1',
      ),
      API_LABELS,
    );
    const dotnet = record(app('http response received', { request_id: 'r2', upstream: { method: 'POST', url: 'http://x/z', status: 200, body: dotnetString(JSON.stringify({ client_secret: 'S3cretPw' })) } }, '2026-11-01T10:11:12.369832', 'c1'), API_LABELS);
    const view = JSON.stringify(maskDeep(buildView([gateway, api, dotnet].map(parseLine), { withOffsets: false }), NONE));
    expect(view).not.toMatch(/S3cretPw|5100123440/);
  });
});

describe('JSON в percent-encoding с пробелами: +, %20, %0A', () => {
  it('json.dumps и urlencode, encodeURIComponent от JSON с отступами', () => {
    cleanNested(`payload=${encodeURIComponent('{"password": "S3cretPw"}').replace(/%20/g, '+')}&x=1`, ['S3cretPw']);
    cleanNested(`payload=${encodeURIComponent(JSON.stringify({ client_secret: 'S3cretPw', pin: [1234] }, null, 2))}`, ['S3cretPw', '1234']);
    cleanNested(`d=${encodeURIComponent(encodeURIComponent('{"password" : "S3cretPw"}'))}`, ['S3cretPw']);
  });

  it('ключи номера карты, тег с префиксом пространства имён, число после %2C', () => {
    cleanNested(`d=${encodeURIComponent(`{ "card_number" : "${SWITCH_PAN}" }`)}`, [SWITCH_PAN]);
    cleanNested(`d=${encodeURIComponent(`{"rcard": "${SWITCH_PAN}"}`)}`, [SWITCH_PAN]);
    cleanNested(`d=${encodeURIComponent(`<ns1:RCARD>${SWITCH_PAN}</ns1:RCARD>`)}`, [SWITCH_PAN]);
    cleanNested(`d=${encodeURIComponent(`{"pan":[1,${SWITCH_PAN}]}`)}`, [SWITCH_PAN]);
    cleanNested(`d=${encodeURIComponent(`{"pan":[1, ${SWITCH_PAN}]}`)}`, [SWITCH_PAN]);
  });
});

describe('номер карты с пробелами и дефисами', () => {
  it('в PAN-ключе: JSON, XML, maskDeep — видны первые 6 и последние 4 цифры, разделители на месте', () => {
    const spaced = '5100 1234 4047 3348';
    const dashed = '5100-1234-4047-3348';
    expect(mask(`{"cardNumber":"${spaced}"}`)).toBe('{"cardNumber":"5100 12** **** 3348"}');
    expect(mask(`{"pan":"${dashed}"}`)).toBe('{"pan":"5100-12**-****-3348"}');
    for (const n of [1, 2]) expect(unwrap(mask(wrap(`{"card_number":"${spaced}"}`, n)), n)).toBe('{"card_number":"5100 12** **** 3348"}');
    expect(mask(`<RCARD>${spaced}</RCARD>`)).toBe('<RCARD>5100 12** **** 3348</RCARD>');
    expect(maskDeep({ cardNumber: spaced, x: { pan: [dashed] } }, NONE)).toEqual({ cardNumber: '5100 12** **** 3348', x: { pan: ['5100-12**-****-3348'] } });
  });

  it('по образцу: группы по 4 с проверкой Луна; без проверки и из keep — видны', () => {
    const grouped = PAN.replace(/(\d{4})(?=\d)/g, '$1 ');
    expect(mask(`card ${grouped} declined`)).toBe('card 4111 11** **** 7893 declined');
    expect(mask(`card ${PAN.replace(/(\d{4})(?=\d)/g, '$1-')}-12 x`)).toBe('card 4111-11**-****-7893-12 x');
    expect(mask('acc 3501 1123 4465 0819')).toBe('acc 3501 1123 4465 0819');
    expect(mask(`card ${grouped}`, new Set([PAN]))).toBe(`card ${grouped}`);
  });
});

describe('пары имя=значение: экранированная кавычка, апостроф и \\ в значении', () => {
  it('значение в кавычках с \\" и \\\' скрыто целиком на уровнях 0–2', () => {
    for (const [line, expected] of [
      ['password="ab\\"cd" next', 'password="***" next'],
      ["password='ab\\'cd' next", "password='***' next"],
      ['x password="a\\\\" y', 'x password="***" y'],
    ]) {
      for (const n of [0, 1, 2]) expect(unwrap(mask(wrap(line!, n)), n), `${line} / ${n}`).toBe(expected);
    }
  });

  it("значение без кавычек: ', \\ и \" внутри не обрывают его", () => {
    expect(mask("grant_type=password&password=ab'cd&x=1")).toBe('grant_type=password&password=***&x=1');
    expect(mask("GET /cb?password=a'b HTTP/1.1")).toBe('GET /cb?password=*** HTTP/1.1');
    expect(mask("a=1\\u0026password=x'tail\\u0026b=2")).toBe('a=1\\u0026password=***\\u0026b=2');
    expect(mask('password=ab\\cd e')).toBe('password=*** e');
    for (const n of [1, 2, 3]) expect(mask(wrap("POST /t HTTP/1.1\r\n\r\nusername=u&password=p'TAIL", n))).not.toContain('TAIL');
  });

  it('кавычка без закрывающей — скрыто до конца значения, а не *** перед ним', () => {
    expect(mask('password="abc&x=1')).toBe('password="***');
    expect(mask("password='abc")).toBe("password='***");
  });
});

describe('секрет с объектом, вложенным массивом или скобками в строке', () => {
  it.each([
    ['{"pinBlock":{"format":0,"value":"ABCDEF01"},"next":"keep"}', '{"pinBlock":"***","next":"keep"}'],
    ['{"cvv":[["123"]],"next":1}', '{"cvv":"***","next":1}'],
    ['{"password":["ab]cd"]}', '{"password":["***"]}'],
    ['{"pin":["{x}", 5]}', '{"pin":["***", "***"]}'],
    ['{"Authorization":["tok]en"]}', '{"Authorization":["***"]}'],
    ['{"Authorization":{"scheme":"Bearer","token":"t"}}', '{"Authorization":"***"}'],
    ['{"pan":["5100 1234 4047 3348", {"x": "y]"}]}', '{"pan":["5100 12** **** 3348", {"x": "y]"}]}'],
  ])('%s', (input, expected) => {
    for (const n of [0, 1, 2]) expect(unwrap(mask(wrap(input, n)), n)).toBe(expected);
  });

  it('то же сущностями XML и в percent-encoding', () => {
    const json = JSON.stringify({ pinBlock: { format: 0, value: 'S3cretPB' }, cvv: [['987']], ok: 1 });
    cleanNested(`<a>${json.replace(/"/g, '&quot;')}</a>`, ['S3cretPB', '987']);
    cleanNested(`d=${encodeURIComponent(json)}&x=1`, ['S3cretPB', '987']);
  });

  it('объект без закрывающей скобки — скрыто до конца строки, быстро', () => {
    const s = '{"pinBlock":{"value":"' + 'S'.repeat(1_000_000);
    expect(mask(s)).toBe('{"pinBlock":"***"');
    expect(fastest(() => mask(s))).toBeLessThan(200);
  });
});

describe('семейство ENC: значение с \\ в конце не съедает следующий ключ', () => {
  it('сущности XML и percent-encoding', () => {
    const json = JSON.stringify({ cvv: 'x\\', password: 'S3cretPw' });
    const attr = `<a v="${json.replace(/"/g, '&quot;')}"/>`;
    expect(mask(attr)).toBe('<a v="{&quot;cvv&quot;:&quot;***&quot;,&quot;password&quot;:&quot;***&quot;}"/>');
    expect(decodeURIComponent(mask(`d=${encodeURIComponent(json)}`))).toBe('d={"cvv":"***","password":"***"}');
  });

  it('любое значение из a, \\ и " до 3 символов: следующий секрет и номер скрыты', () => {
    const encodings: ((s: string) => string)[] = [
      (s) => `<a v="${s.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"/>`,
      (s) => JSON.stringify({ x: `<a v="${s.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"/>` }),
      (s) => `a=1&d=${encodeURIComponent(s)}`,
      (s) => `{"b":"${dotnetString(s).slice(1, -1)}"}`,
    ];
    const values = [''];
    for (let len = 1; len <= 3; len++) for (const v of values.filter((x) => x.length === len - 1)) for (const c of ['a', '\\', '"']) values.push(v + c);
    for (const enc of encodings) {
      for (const v of values) {
        for (const [key, secret] of [['password', 'QZYsecret'], ['pan', SWITCH_PAN]] as const) {
          const s = enc(JSON.stringify({ cvv: `QZX${v}`, [key]: secret }));
          expect(mask(s), s).not.toMatch(new RegExp(`QZX|${secret}`));
        }
      }
    }
  });
});

describe('уровни экранирования ограничены: строка 3 МБ, у каждого открытия своя запись', () => {
  const fill = (gen: (i: number) => string, size: number) => {
    let s = '';
    for (let i = 0; s.length < size; i++) s += gen(i);
    return s;
  };
  it.each([
    ['&(amp;)^i quot; password', (i: number) => `&${'amp;'.repeat(i)}quot;password&${'amp;'.repeat(i)}quot;:&${'amp;'.repeat(i)}quot;x `],
    ['%(25)^i 22 pin', (i: number) => `%${'25'.repeat(i)}22pin%${'25'.repeat(i)}22%3A%${'25'.repeat(i)}22x `],
    ['&(amp;)^i lt; password', (i: number) => `&${'amp;'.repeat(i)}lt;password&${'amp;'.repeat(i)}gt;x `],
    ['%(25)^i 3c RCARD', (i: number) => `%${'25'.repeat(i)}3cRCARD%${'25'.repeat(i)}3e1 `],
    ['\\^(2i+1) " cvv', (i: number) => `${'\\'.repeat(2 * i + 1)}"cvv${'\\'.repeat(2 * i + 1)}":${'\\'.repeat(2 * i + 1)}"x `],
    ['password=\\^i "', (i: number) => `password=${'\\'.repeat(i % 64)}"abc `],
  ])('%s', (_name, gen) => {
    const s = fill(gen, 3 * 1024 * 1024);
    expect(fastest(() => mask(s))).toBeLessThan(1000);
  });
});

describe('учётные данные в адресе и служебные поля', () => {
  const T = (s: string) => maskText(s, new Set());

  it('scheme://***@host на любом уровне экранирования', () => {
    expect(T('GET https://svc:SYNTHPASS@partner.example:443/x')).toBe('GET https://***@partner.example:443/x');
    expect(T('https://svc:SYNTH@URIPASS@partner.example/x')).toBe('https://***@partner.example/x');
    expect(T('https://svc:SYNTHSLASH/PASS@partner.example/x')).toBe('https://***@partner.example/x');
    expect(T('https://token@partner.example/x')).toBe('https://***@partner.example/x');
    expect(T(String.raw`{"u":"https:\/\/svc:SYNTHPASS@partner.example\/x"}`)).toBe(String.raw`{"u":"https:\/\/***@partner.example\/x"}`);
    expect(T(String.raw`{\"u\":\"https://svc:SYNTHPASS@partner.example/x\"}`)).toBe(String.raw`{\"u\":\"https://***@partner.example/x\"}`);
    expect(T('cb=https%3A%2F%2Fsvc%3ASYNTHPASS%40partner.example%2Fx')).toBe('cb=https%3A%2F%2F***%40partner.example%2Fx');
    expect(T('cb=https%253A%252F%252Fsvc%253ASYNTHPASS%2540partner.example')).toBe('cb=https%253A%252F%252F***%2540partner.example');
  });

  it('адреса без учётных данных не меняются', () => {
    for (const s of ['https://partner.example:443/x', 'http://host:8080/path?mail=a@b.example', 'https://host/path@v2', 'http://[::1]:8080/a@b', 'see https://a.example and mail me@b.example', 'postgres://db/x']) expect(T(s)).toBe(s);
  });

  it('длинная строка без @ проходит за линейное время', () => {
    expect(
      fastest(() => {
        T(`${'https://'.repeat(20000)}x`);
        T(`http://${'a:'.repeat(50000)}`);
      }),
    ).toBeLessThan(1500);
  });

  it('firstRecordId с tsNs, проходящим проверку Луна, не маскируется', () => {
    const ts = '1793609700000000009';
    const id = `${ts}-0`;
    expect(maskText(id, new Set())).not.toBe(id);
    expect(maskDeep({ firstRecordId: id }, new Set())).toEqual({ firstRecordId: id });
  });
});

// ---------- Обрезанные значения, длинные значения и записи вне JSON и XML ----------

describe('значение без закрывающей кавычки или тега', () => {
  it('JSON: секрет скрыт, у номера замаскированы цифры, на уровнях экранирования', () => {
    expect(mask('{"code":1,"password":"SYNTHSEC015Q')).toBe('{"code":1,"password":"***');
    expect(mask(`{"pan":"${SWITCH_PAN}`)).toBe(`{"pan":"${SWITCH_MASKED}`);
    expect(mask('{"access_token":"eyJhbGciOiJ')).toBe('{"access_token":"***');
    expect(mask('{"Authorization":"Bearer SYNTHSEC')).toBe('{"Authorization":"Bearer ***');
    expect(mask('{"password":"')).toBe('{"password":"');
    expect(mask(`{\\"pan\\":\\"${SWITCH_PAN}`)).toBe(`{\\"pan\\":\\"${SWITCH_MASKED}`);
    expect(mask(`{"pan":["${SWITCH_PAN}`)).not.toContain(SWITCH_PAN);
  });

  it('значение кончается на кавычке внешней строки, остальное цело', () => {
    expect(mask('{"body":"{\\"password\\":\\"SYNTHSEC","status":500}')).toBe('{"body":"{\\"password\\":\\"***","status":500}');
    expect(mask('{"body":"{\\\\\\"password\\\\\\":\\\\\\"SYNTHSEC\\","status":500}')).toBe('{"body":"{\\\\\\"password\\\\\\":\\\\\\"***\\","status":500}');
  });

  it('все семейства экранирования', () => {
    for (const s of [
      '{&quot;password&quot;:&quot;SYNTHSEC',
      '<a>{&quot;password&quot;:&quot;SYNTHSEC</a>',
      '{&#34;password&#34;:&#34;SYNTHSEC',
      'd=%7B%22password%22%3A%22SYNTHSEC',
      'd=%7B%22password%22%3A%22SYNTHSEC&x=1',
      '{\\u0022password\\u0022:\\u0022SYNTHSEC',
      '<a><password>SYNTHSEC',
      '&lt;a&gt;&lt;password&gt;SYNTHSEC',
      '<a>&lt;password&gt;SYNTHSEC</a>',
      'x=%3Cpassword%3ESYNTHSEC&y=1',
      '{"b":"\\u003cpassword\\u003eSYNTHSEC","x":1}',
    ]) {
      expect(mask(s), s).not.toContain('SYNTHSEC');
      expect(mask(mask(s)), s).toBe(mask(s));
    }
    expect(mask('<a>&lt;password&gt;SYNTHSEC</a>')).toBe('<a>&lt;password&gt;***</a>');
    expect(mask('x=%3Cpassword%3ESYNTHSEC&y=1')).toBe('x=%3Cpassword%3E***&y=1');
    expect(mask('{"b":"\\u003cpassword\\u003eSYNTHSEC","x":1}')).toBe('{"b":"\\u003cpassword\\u003e***","x":1}');
  });

  it('тег номера: цифры скрыты, тег секрета — всё до конца', () => {
    expect(mask(`<RCARD>${SWITCH_PAN}`)).toBe(`<RCARD>${SWITCH_MASKED}`);
    expect(mask('<a><password>SYNTHSEC')).toBe('<a><password>***');
    expect(mask('<password a="1"/><next>keep</next>')).toBe('<password a="1"/><next>keep</next>');
  });

  it('повторные и вырожденные случаи — линейно', () => {
    const samples = [
      '{"password":"' + 'x'.repeat(2_000_000),
      '{"pan":"' + '1 '.repeat(1_000_000),
      '<password>' + '<a>'.repeat(500_000),
      '<RCARD>' + '<![CDATA[1]]>'.repeat(200_000),
      '{\\"password\\":\\"'.repeat(150_000),
      '&lt;password&gt;'.repeat(150_000),
    ];
    for (const s of samples) expect(fastest(() => mask(s)), s.slice(0, 20)).toBeLessThan(500);
  });
});

describe('настоящий перевод строки и значение длиннее предела просмотра', () => {
  const LONG = `SYNTHSEC${'a'.repeat(9000)}`;

  it('перевод строки и U+2028 внутри значения', () => {
    expect(mask('{"password":"SYNTHSEC\nz","next":1}')).toBe('{"password":"***","next":1}');
    expect(mask('{"password":"SYNTHSEC z","next":1}')).toBe('{"password":"***","next":1}');
    expect(mask('{"password":["SYNTHSEC\nz"]}')).toBe('{"password":["***"]}');
    expect(mask(`{"pan":"${SWITCH_PAN}\nz","next":1}`)).toBe(`{"pan":"${SWITCH_MASKED}\nz","next":1}`);
    expect(mask('password="SYNTHSEC\nz" next')).toBe('password="***" next');
    expect(mask('<password>S YNTHSEC</password>')).toBe('<password>***</password>');
  });

  it('длиннее 8 КБ: скрыто до конца текста, строкой и объектом, в JSON и XML', () => {
    expect(mask(`{"access_token":"${LONG}"}`)).toBe('{"access_token":"***');
    expect(mask(JSON.stringify({ access_token: { v: LONG } }))).not.toContain('SYNTHSEC');
    expect(mask(`<password>${LONG}</password>`)).toBe('<password>***</password>');
    expect(mask(wrap(`{"client_secret":"${LONG}"}`, 2))).not.toContain('SYNTHSEC');
  });
});

describe('тег с вложенным элементом, комментарием и несколькими CDATA', () => {
  it.each([
    ['<a><password><value>SYNTHSEC</value></password></a>', '<a><password>***</password></a>'],
    ['<password><!-- c -->SYNTHSEC</password>', '<password>***</password>'],
    ['<password>a<![CDATA[SYNTHSEC]]></password>', '<password>***</password>'],
    ['<password><![CDATA[a]]><![CDATA[SYNTHSEC]]></password>', '<password>***</password>'],
    ['<password><password>x</password>SYNTHSEC</password>', '<password>***</password>'],
    ['<a:password>SYNTHSEC</b:password>', '<a:password>***'],
  ])('%s', (input, expected) => {
    expect(mask(input)).toBe(expected);
  });

  it('номер: цифры на всём отрезке, разбитые разметкой — как один номер', () => {
    expect(mask(`<RCARD><number>${SWITCH_PAN}</number></RCARD>`)).toBe(`<RCARD><number>${SWITCH_MASKED}</number></RCARD>`);
    expect(mask(`<RCARD><![CDATA[5100]]><![CDATA[123440473348]]></RCARD>`)).toBe('<RCARD><![CDATA[5100]]><![CDATA[12******3348]]></RCARD>');
    expect(mask('<RCARD><n>abc</n></RCARD>')).toBe('<RCARD><n>abc</n></RCARD>');
  });

  it('сущностями и в XML внутри JSON', () => {
    expect(mask('<r>&lt;password&gt;&lt;value&gt;SYNTHSEC&lt;/value&gt;&lt;/password&gt;</r>')).toBe('<r>&lt;password&gt;***&lt;/password&gt;</r>');
    expect(mask(wrap('<password><value>SYNTHSEC</value></password>', 1))).not.toContain('SYNTHSEC');
  });
});

describe('служебные имена и числа в содержимом лога', () => {
  const ts = withLuhnCheckDigit('179318095549578735');

  it('служебные поля свободны от маски только вне содержимого лога', () => {
    const v = { id: `${ts}-3`, tsNs: ts, sections: { context: { tsNs: PAN, id: `${PAN}-1`, pairId: `${PAN}-1`, a: { b: { tsNs: PAN } } } } };
    const out = maskDeep(v, NONE);
    expect(out.id).toBe(`${ts}-3`);
    expect(out.tsNs).toBe(ts);
    expect(JSON.stringify(out.sections)).not.toContain(PAN);
  });

  it('отрицательное и дробное число с номером', () => {
    expect(maskDeep({ amount: -Number(PAN), x: Number(PAN) + 0.5 }, NONE)).toEqual({ amount: PAN_MASKED, x: PAN_MASKED });
    expect(maskDeep({ pan: -Number(NON_LUHN_PROCESSOR) }, NONE)).toEqual({ pan: maskPan(NON_LUHN_PROCESSOR) });
    expect(maskDeep({ amount: -1234.5, y: 3501112344650819 }, NONE)).toEqual({ amount: -1234.5, y: 3501112344650819 });
    expect(mask(`{"pan":-${NON_LUHN_PROCESSOR}}`)).toBe(`{"pan":"${maskPan(NON_LUHN_PROCESSOR)}"}`);
    expect(mask(`{"pan":${NON_LUHN_PROCESSOR}.5}`)).toBe(`{"pan":"${maskPan(NON_LUHN_PROCESSOR)}"}`);
    expect(leakedPans(mask(`{"amount":-${PAN},"b":${PAN}.5}`))).toEqual([]);
  });
});

describe('Basic, Bearer и Digest в тексте', () => {
  it.each([
    ['login Digest username="SYNTHSEC", realm="r", response="z"', 'login Digest ***'],
    ['auth=Bearer+SYNTHSEC&x=1', 'auth=Bearer+***&x=1'],
    ['Bearer%20SYNTHSEC', 'Bearer%20***'],
    ['Basic%20SYNTHSEC', 'Basic%20***'],
    ['Bearer%2520SYNTHSEC', 'Bearer%2520***'],
    ['Bearer\nSYNTHSEC', 'Bearer\n***'],
    ['Bearer: SYNTHSEC', 'Bearer: ***'],
    ['Bearer "SYNTHSEC"', 'Bearer "***"'],
    ['Bearer abc,SYNTHSEC next', 'Bearer *** next'],
    ['Bearer abc:SYNTHSEC!x|y next', 'Bearer *** next'],
    ['Bearer abc%2BSYNTHSEC next', 'Bearer *** next'],
    ['{"a":"Bearer abc"}', '{"a":"Bearer ***"}'],
    ['{\\"a\\":\\"Bearer abc,SYNTHSEC\\"}', '{\\"a\\":\\"Bearer ***\\"}'],
    ['{"token_type":"Bearer","expires_in":3600}', '{"token_type":"Bearer","expires_in":3600}'],
  ])('%s', (input, expected) => {
    expect(mask(input)).toBe(expected);
    expect(mask(expected)).toBe(expected);
  });

  it('Digest на уровнях экранирования', () => {
    const s = 'x Digest username="SYNTHSEC", realm="r", response="SYNTHRESP"';
    for (const n of [1, 2]) expect(mask(wrap(s, n))).not.toMatch(/SYNTHSEC|SYNTHRESP/);
  });
});

describe('родственные имена заголовка Authorization', () => {
  it.each([
    ['{"X-Authorization":"SYNTHSEC"}', '{"X-Authorization":"***"}'],
    ['{"HTTP_AUTHORIZATION":"SYNTHSEC"}', '{"HTTP_AUTHORIZATION":"***"}'],
    ['{"proxy_authorization":"Bearer SYNTHSEC"}', '{"proxy_authorization":"Bearer ***"}'],
    ["{'Authorization': 'SYNTHSEC'}", "{'Authorization': '***'}"],
    ['Authorization : SYNTHSEC', 'Authorization : ***'],
    ['Authorization%3A%20SYNTHSEC', 'Authorization%3A%20***'],
    ['Authorization&#58; SYNTHSEC', 'Authorization&#58; ***'],
    ['authorization=SYNTHSEC&x=1', 'authorization=***&x=1'],
    ['<a><Authorization>SYNTHSEC</Authorization></a>', '<a><Authorization>***</Authorization></a>'],
    ['<Authorization>Bearer SYNTHSEC</Authorization>', '<Authorization>Bearer ***</Authorization>'],
  ])('%s', (input, expected) => {
    expect(mask(input)).toBe(expected);
  });

  it('значение, перенесённое на следующую строку', () => {
    const http = 'GET / HTTP/1.1\r\nAuthorization: Bearer\r\n SYNTHSEC\r\nHost: h\r\n\r\n';
    for (const n of [0, 1, 2]) {
      const out = mask(wrap(http, n));
      expect(out, String(n)).not.toContain('SYNTHSEC');
      expect(out, String(n)).toContain('Host: h');
    }
  });

  it('maskDeep: имя по окончанию', () => {
    expect(maskDeep({ 'X-Authorization': ['SYNTHSEC'], HTTP_AUTHORIZATION: 'Bearer SYNTHSEC' }, NONE)).toEqual({ 'X-Authorization': ['***'], HTTP_AUTHORIZATION: 'Bearer ***' });
  });
});

describe('учётные данные в адресе: без схемы и с символами в пароле', () => {
  it.each([
    ['//svc:SYNTHSEC@partner.example/x', '//***@partner.example/x'],
    ['svc:SYNTHSEC@partner.example/x', '***@partner.example/x'],
    ['https://svc:pa SYNTHSEC@partner.example/x', 'https://***@partner.example/x'],
    ['https://svc:pa"SYNTHSEC@partner.example/x', 'https://***@partner.example/x'],
    ['https://svc:pa<SYNTHSEC@partner.example/x', 'https://***@partner.example/x'],
    ['https://svc:pa\\SYNTHSEC@partner.example/x', 'https://***@partner.example/x'],
    [`https://svc:${'SYNTHSEC'.repeat(75)}@partner.example/x`, 'https://***@partner.example/x'],
    ['https%3A//svc:SYNTHSEC@partner.example', 'https%3A//***@partner.example'],
    ['https://svc%3ASYNTHSEC%40partner.example', 'https://***%40partner.example'],
    ['https:%2F%2Fsvc:SYNTHSEC@partner.example', 'https:%2F%2F***@partner.example'],
    ['https://svc:SYNTHSEC%40partner.example', 'https://***%40partner.example'],
    ['https://svc:SYNTHSEC&#64;partner.example', 'https://***&#64;partner.example'],
    ['{"u":"https://svc:pa\\"SYNTHSEC@partner.example/x","n":"a@b.example"}', '{"u":"https://***@partner.example/x","n":"a@b.example"}'],
  ])('%s', (input, expected) => {
    expect(mask(input)).toBe(expected);
    expect(mask(expected)).toBe(expected);
  });

  it('на уровне 2 пароль с кавычкой', () => {
    const s = wrap(JSON.stringify({ u: 'https://svc:pa"SYNTHSEC@partner.example/x', n: 'a@b.example' }), 1);
    expect(mask(s)).not.toContain('SYNTHSEC');
    expect(mask(s)).toContain('a@b.example');
  });

  it('адрес без учётных данных и текст с собакой не меняются', () => {
    for (const s of ['//partner.example/x', '// note b@c', 'mail me@b.example', 'host:8080/a@b', 'http://h:80/x?y=a@b']) expect(mask(s), s).toBe(s);
  });

  it('много адресов и одна собака — линейно', () => {
    const samples = [`${'https://a/'.repeat(100_000)}@`, `@${'https://a:b/ '.repeat(100_000)}`, `${'https://a:b/ '.repeat(100_000)}\n@`];
    for (const s of samples) expect(fastest(() => mask(s))).toBeLessThan(1000);
  });
});

describe('номер без проверки Луна вне ключа JSON и тега', () => {
  it.each([
    [`https://partner.example/x?pan=${SWITCH_PAN}&y=1`, `https://partner.example/x?pan=${SWITCH_MASKED}&y=1`],
    [`cardNumber=${SWITCH_PAN}&y=1`, `cardNumber=${SWITCH_MASKED}&y=1`],
    [`<card pan="${SWITCH_PAN}"/>`, `<card pan="${SWITCH_MASKED}"/>`],
    [`<field name="pan">${SWITCH_PAN}</field>`, `<field name="pan">${SWITCH_MASKED}</field>`],
    [`'pan' => '${SWITCH_PAN}'`, `'pan' => '${SWITCH_MASKED}'`],
    [`pan: ${SWITCH_PAN}`, `pan: ${SWITCH_MASKED}`],
    [`{pan:'${SWITCH_PAN}'}`, `{pan:'${SWITCH_MASKED}'}`],
    [`[pan] => ${SWITCH_PAN}`, `[pan] => ${SWITCH_MASKED}`],
    ['{"cardNumber":"5100  1234  4047  3348"}', '{"cardNumber":"5100  12**  ****  3348"}'],
    ['{"pan":"5100.1234.4047.3348"}', '{"pan":"5100.12**.****.3348"}'],
    ['{"pan":"5100 - 1234 - 4047 - 3348"}', '{"pan":"5100 - 12** - **** - 3348"}'],
    [`<FilterCondition><value>${SWITCH_PAN}</value></FilterCondition>`, `<FilterCondition><value>${SWITCH_MASKED}</value></FilterCondition>`],
    ['<Value>5100 1234 4047 3348</Value>', '<Value>5100 12** **** 3348</Value>'],
    [`{"Value":" ${SWITCH_PAN} "}`, `{"Value":" ${SWITCH_MASKED} "}`],
    [`{"FilterCondition":{"value":"${SWITCH_PAN}"}}`, `{"FilterCondition":{"value":"${SWITCH_MASKED}"}}`],
  ])('%s', (input, expected) => {
    expect(mask(input)).toBe(expected);
  });

  it('объект под именем номера: цифры скрыты, остальное цело', () => {
    expect(mask(`{"pan":{"number":"${SWITCH_PAN}","type":"debit"}}`)).toBe(`{"pan":{"number":"${SWITCH_MASKED}","type":"debit"}}`);
    expect(mask(`{"pan":{"number":${SWITCH_PAN}}}`)).toBe(`{"pan":{"number":"${SWITCH_MASKED}"}}`);
    expect(maskDeep({ pan: { number: SWITCH_PAN, password: 'S', k: [Number(NON_LUHN_PROCESSOR)] } }, NONE)).toEqual({ pan: { number: SWITCH_MASKED, password: '***', k: [maskPan(NON_LUHN_PROCESSOR)] } });
    expect(maskDeep({ FilterCondition: { value: SWITCH_PAN } }, NONE)).toEqual({ FilterCondition: { value: SWITCH_MASKED } });
  });

  it('value вне FilterCondition и короткий value не меняются', () => {
    expect(mask(`{"value":"${CARDS_CID}"}`)).toBe(`{"value":"${CARDS_CID}"}`);
    expect(maskDeep({ value: SWITCH_PAN }, NONE)).toEqual({ value: SWITCH_PAN });
  });
});

describe('секрет вне форм "ключ":"значение" и имя=значение', () => {
  it.each([
    ['login failed password: SYNTHSEC', 'login failed password: ***'],
    ['cardholderPassword=oltin SYNTHSEC&x=1', 'cardholderPassword=***&x=1'],
    ["req {'password': 'SYNTHSEC'}", "req {'password': '***'}"],
    ['password = SYNTHSEC', 'password = ***'],
    ['password= SYNTHSEC', 'password= ***'],
    ['password =SYNTHSEC', 'password =***'],
    ["{password:'SYNTHSEC'}", "{password:'***'}"],
    ['"password"=>"SYNTHSEC"', '"password"=>"***"'],
    ['[password] => SYNTHSEC', '[password] => ***'],
    ['user_password=SYNTHSEC', 'user_password=***'],
    ['newpassword=SYNTHSEC', 'newpassword=***'],
    ['password=ab"SYNTHSEC', 'password=***'],
    ['password&#61;SYNTHSEC', 'password&#61;***'],
    ['{"password":[\'SYNTHSEC\']}', '{"password":"***"}'],
    ['{"password":[SYNTHSEC]}', '{"password":"***"}'],
    ['{"user_password":"SYNTHSEC"}', '{"user_password":"***"}'],
    ['{"newPassword":"SYNTHSEC"}', '{"newPassword":"***"}'],
    ['<user_password>SYNTHSEC</user_password>', '<user_password>***</user_password>'],
    ['<field name="password">SYNTHSEC</field>', '<field name="password">***</field>'],
  ])('%s', (input, expected) => {
    expect(mask(input)).toBe(expected);
    expect(mask(expected)).toBe(expected);
  });

  it('значение не секрет: null, логическое, пустое перед концом фразы, JSON цел', () => {
    for (const s of ['{"password":null}', '{"pin":true}', 'password: null', 'Invalid password:', 'password_expired: true', 'spin: 5', '{"secretary":"x"}']) expect(mask(s), s).toBe(s);
    expect(JSON.parse(mask('{"password":{"a":1},"pin":[1],"next":null}'))).toEqual({ password: '***', pin: ['***'], next: null });
  });

  it('maskDeep: имена с префиксом', () => {
    expect(maskDeep({ user_password: 'S', newPassword: 'S', password_expired: false, sender_pan: SWITCH_PAN }, NONE)).toEqual({ user_password: '***', newPassword: '***', password_expired: false, sender_pan: SWITCH_MASKED });
  });
});

describe('номер группами с проверкой Луна: разделители', () => {
  it.each([
    ['card 4111  1112  3455  7893', 'card 4111  11**  ****  7893'],
    ['card 4111 1112-3455 7893', 'card 4111 11**-**** 7893'],
    ['card=4111+1112+3455+7893&y=1', 'card=4111+11**+****+7893&y=1'],
    ['card=4111%201112%203455%207893&y=1', 'card=4111%2011**%20****%207893&y=1'],
    ['amex 3782 822463 10005', 'amex 3782 82**** *0005'],
  ])('%s', (input, expected) => {
    expect(mask(input)).toBe(expected);
  });
});

describe('заголовок записи и адрес: withoutCredentials', () => {
  it.each([
    ['https://svc:pa/SYNTHA01@partner.example/x', 'partner.example/x'],
    ['https://svc:pa@SYNTHA02@partner.example/x', 'partner.example/x'],
    ['https://svc:SYNTHT01?z@partner.example/x', 'partner.example/x'],
    ['https://svc:SYNTHT01#z@partner.example/x', 'partner.example/x'],
    ['//svc:SYNTHT04@partner.example/zzz', 'partner.example/zzz'],
    ['svc:SYNTHT05@partner.example/zzz', 'partner.example/zzz'],
    ['https://partner.example:443/x?y=1', 'partner.example:443/x?y=1'],
    ['/v1/users/a@b/x', '/v1/users/a@b/x'],
  ])('%s', (input, expected) => {
    expect(withoutCredentials(input)).toBe(expected);
  });
});

// Формы, которые воспроизвела атака маскирования: по одному тесту на исправленный пункт. Значения синтетические.
describe('регрессии атаки маскирования', () => {
  const S = 'SYNTHSEC42';
  const hidden = (s: string, x = S) => expect(mask(s), s).not.toContain(x);

  it('кавычка без пары на любом уровне и значение длиннее предела — до конца внешней строки', () => {
    for (const s of [`password="ab ${S}`, `password="ab&${S}`, `{'password': 'ab ${S}`, `password=&quot;${S}`, `password="${'x'.repeat(9000)} ${S}"`]) hidden(s);
    expect(mask(JSON.stringify({ a: `password="ab ${S}`, b: 'open' }))).toContain('open');
  });

  it('вложенный адрес и форма PHP: имя после %XX разделителя, закрывающая %5D', () => {
    for (const s of [`cb?next=https%3A%2F%2Fh.example%2Fx%3Faccess_token%3D${S}%26y%3D1`, `note=login%20pin%3D${S}`, `a=b%2Cpin=${S}`, `a=b%0Apin=${S}`, `x%23access_token%3D${S}`, `state%3Dabc%3Baccess_token%3D${S}`, `user%5Bpassword%5D=${S}&y=1`, `user%5Bpin%5D=${S}`]) hidden(s);
    for (const s of [`x%3Fpan%3D${SWITCH_PAN}%26y%3D1`, `card%5Bpan%5D=${SWITCH_PAN}`]) hidden(s, SWITCH_PAN);
    expect(mask(`next=x%3Fpage%3D2%26pin%3D${S}%26y%3D1`)).toBe('next=x%3Fpage%3D2%26pin%3D***%26y%3D1');
  });

  it('одно правило имени у ключа, тега, объекта и обхода: контекст скрывает то же, что сырая строка', () => {
    for (const k of ['user.password', 'spring.datasource.password', 'my_app_client_secret', 'old_user_pin', 'sender_card_cvv', 'user-pin', 'client-secret', 'headers.Authorization']) {
      expect(JSON.stringify(maskDeep({ context: { [k]: S } }, NONE)), k).not.toContain(S);
      hidden(JSON.stringify({ [k]: S }));
      hidden(JSON.stringify({ [k]: { v: S } }));
      hidden(`<${k}>${S}</${k}>`);
    }
    for (const k of ['sender_card_pan', 'a_b_cardNumber']) {
      expect(JSON.stringify(maskDeep({ context: { [k]: SWITCH_PAN } }, NONE)), k).not.toContain(SWITCH_PAN);
      hidden(JSON.stringify({ [k]: { n: SWITCH_PAN } }), SWITCH_PAN);
      hidden(`<${k}>${SWITCH_PAN}</${k}>`, SWITCH_PAN);
    }
    for (const s of ['{"password_expired":"x"}', '{"token_type":"Bearer"}', 'spin=1', '<spin>1</spin>', '{"timeSpan":"1"}']) expect(mask(s)).toBe(s);
  });

  it('пароль в адресе без схемы и в длинном адресе', () => {
    for (const s of [`svc:pa/${S}@partner.example/x`, `svc:pa@${S}@partner.example/x`, `svc:pa ${S}@partner.example/x`, `svc:${'y'.repeat(600)}${S}@partner.example/x`, `https://svc:pa/${'z'.repeat(20_000)}${S}@partner.example/x`, `https://svc:pa ${'z'.repeat(20_000)}${S}@partner.example/x`, `ERROR connect svc:pa/${S}@partner.example/x failed`]) hidden(s);
    expect(mask(`svc:pa/${S}@partner.example/x`)).toBe('***@partner.example/x');
    for (const s of ['host:8080/path?mail=a@b.example', 'Error: foo bar@baz.example', 'user@example.com']) expect(mask(s)).toBe(s);
  });

  it('время линейное: одна строка лога не останавливает сервер', () => {
    for (const s of [`Bearer ${' '.repeat(128_000)}<`, `digest ${' '.repeat(64_000)}<`, `Bearer ${'%20'.repeat(40_000)}<`, `Bearer ${'\\n'.repeat(60_000)}<`, '%3Cpassword%3Ea&'.repeat(65_000), '&lt;password&gt;a"'.repeat(60_000), '<password>a"'.repeat(90_000), Array.from({ length: 40_000 }, (_, i) => `%3Cp${i}_password%3Ea&`).join('')]) {
      expect(fastest(() => mask(s)), s.slice(0, 20)).toBeLessThan(1000);
    }
  });

  it('%26 и экранированная кавычка в настоящей форме — часть значения', () => {
    expect(mask(`password=ab%26${S}&x=1`)).toBe('password=***&x=1');
    expect(mask(`grant_type=client_credentials&client_secret=ab%26${S}`)).toBe('grant_type=client_credentials&client_secret=***');
    expect(mask(`password=ab%2526${S}&x=1`)).toBe('password=***&x=1');
    hidden(JSON.stringify({ body: `password=ab"${S}&x=1` }));
    expect(mask(`a%3D1%26pin%3D${S}%26y%3D1`)).toBe('a%3D1%26pin%3D***%26y%3D1');
  });

  it('значение-объект, массив и значение после null', () => {
    for (const s of [`password={"x":"${S}"}`, `secret: {"value":"${S}"}`, `password=["a","${S}"]`, `{'password':{'x':'${S}'}}`, `{'password': ['${S}']}`, `Card(pin=null,cvv=${S})`, `password=true,${S}`, `userPassword:: ${S}`]) hidden(s);
    expect(mask('Card(pin=null,other=1)')).toBe('Card(pin=null,other=1)');
    expect(mask('password=true')).toBe('password=true');
  });

  it('номер по имени с любыми разделителями и в других формах', () => {
    const GROUPS = '5100|1234|4047|3348';
    for (const s of [JSON.stringify({ cardNumber: GROUPS }), `<RCARD>${GROUPS}</RCARD>`, '{"Value":"5100.1234.4047.3348"}', '<Value>5100.1234.4047.3348</Value>']) expect(mask(s), s).toContain('12**');
    expect(JSON.stringify(maskDeep({ context: { pan: GROUPS, FilterCondition: { Value: '5100.1234.4047.3348' } } }, NONE))).not.toContain('4047');
    for (const s of [`{"FilterCondition":{"x":"${'q'.repeat(600)}","value":"${SWITCH_PAN}"}}`, `pan="card ${SWITCH_PAN}"`, `pan=card:${SWITCH_PAN}`, `<card pan="x${SWITCH_PAN}"/>`, `pan: {"n":"${SWITCH_PAN}"}`, `{'pan': ['${SWITCH_PAN}']}`, `<field name="pan"><![CDATA[${SWITCH_PAN}]]></field>`, `<field name="pan"><v>${SWITCH_PAN}</v></field>`]) hidden(s, SWITCH_PAN);
  });

  it('секрет в теге с именем в атрибуте и в паре name и value', () => {
    for (const s of [`<field name="password"><![CDATA[${S}]]></field>`, `<field name="password"><v>${S}</v></field>`, `&lt;field name=&quot;password&quot;&gt;${S}&lt;/field&gt;`, `<input name="password" value="${S}"/>`, `<entry key="password" value="${S}"/>`, `<password value="${S}"/>`, JSON.stringify({ params: [{ name: 'password', value: S }] })]) hidden(s);
    expect(mask(`<input name="login" value="u"/>`)).toBe(`<input name="login" value="u"/>`);
  });

  it('заголовок Authorization в массиве: объект name и value, плоский список', () => {
    const list = ['Authorization', S, 'X-Authorization', `Bearer ${S}2`, 'Host', 'h'];
    expect(JSON.stringify(maskDeep({ context: { headers: [{ name: 'Authorization', value: S }, ...list, ['Authorization', S]] } }, NONE))).not.toContain(S);
    expect(maskDeep({ headers: ['Host', 'h'] }, NONE)).toEqual({ headers: ['Host', 'h'] });
    hidden(JSON.stringify({ name: 'Authorization', value: S }));
    hidden(JSON.stringify(list));
    expect(mask(JSON.stringify(list))).toContain('"Host","h"');
  });

  it('токены и номера под именами вне прежнего списка', () => {
    for (const k of ['accessToken', 'refreshToken', 'idToken', 'clientSecret', 'access-token', 'apiKey', 'api_key', 'x-api-key', 'auth_token', 'token', 'pin_code', 'pinCode', 'cvv_code', 'Cookie', 'Set-Cookie', 'X-Auth-Token']) {
      hidden(JSON.stringify({ [k]: S }));
      hidden(`<${k}>${S}</${k}>`);
      expect(JSON.stringify(maskDeep({ [k]: S }, NONE)), k).not.toContain(S);
    }
    for (const k of ['card-number', 'card.number', 'primary_account_number', 'pan_number', 'panNumber', 'cardNo']) hidden(JSON.stringify({ [k]: SWITCH_PAN }), SWITCH_PAN);
    for (const h of ['Cookie', 'Set-Cookie', 'X-Api-Key', 'Api-Key', 'X-Auth-Token', 'X-Access-Token', 'X-Csrf-Token']) {
      hidden(`Host: h\r\n${h}: ${S}\r\nAccept: x`);
      hidden(JSON.stringify({ raw_request: `GET / HTTP/1.1\r\n${h}: ${S}\r\nAccept: x` }));
    }
    expect(mask('invalid token: expired; invalid cookie: none')).toBe('invalid token: expired; invalid cookie: none');
  });
});
