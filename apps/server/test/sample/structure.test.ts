// Режим структуры: метки, ключи, вложенные форматы, белый список, пути и метки потока. Все значения выдуманы.

import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { snapshotFromFile } from '@threadline/core/catalog';
import { MAX_TREE_BYTES } from '../../src/sample/limits.ts';
import { allowedFields, catalogWords, EMPTY_SHAPE, flowLabels, httpShape, labelOf, pathShape, recordTree, shapeTree, type ShapeOptions } from '../../src/sample/structure.ts';
import { CATALOG } from './sample-kit.ts';

const UUID = 'c0ffee00-1111-4222-8333-444455556666';
const UUID2 = 'c0ffee00-1111-4222-8333-444455556677';
const tree = (v: unknown, o: ShapeOptions = EMPTY_SHAPE): any => recordTree(JSON.stringify(v), o); // eslint-disable-line @typescript-eslint/no-explicit-any
const words = (...w: string[]): ShapeOptions => ({ ...EMPTY_SHAPE, words: new Set(w) });

describe('метка значения', () => {
  it('каждый вид', () => {
    expect(labelOf(UUID)).toBe('<uuid:36>');
    expect(labelOf('447700900001')).toBe('<digits:12>');
    expect(labelOf('deadbeef0123')).toBe('<hex:12>');
    expect(labelOf('1990-01-01')).toBe('<date:10>');
    expect(labelOf('01.01.1990')).toBe('<date:10>');
    expect(labelOf('eyJ2YWx1ZSI6MX0aB+/cd==')).toBe('<b64:23>');
    expect(labelOf('backend timeout')).toBe('<latin:15>');
    expect(labelOf('Клиент не найден')).toBe('<cyr:16>');
    expect(labelOf('Клиент 12')).toBe('<mixed:9>');
    expect(labelOf('T*****')).toBe('<masked:6>');
  });

  it('длина больше 6 цифр не показывается цифрами', () => {
    expect(labelOf('x'.repeat(3_000_000))).toBe('<latin:999999+>');
  });

  it('числа, логические значения и пустая строка', () => {
    expect(tree({ x: 447700900001, amount: 100, rate: 1.5 })).toEqual({ x: '<int:12>', amount: '<int:3>', rate: '<float>' });
    expect(tree({ success: false, parent: null, note: '' })).toEqual({ success: false, parent: null, note: '' });
  });

  it('ключ не из словаря и свободный текст', () => {
    expect(tree({ qr_owner_address: 'ул. Примерная, 1' }).qr_owner_address).toMatch(/^<mixed:\d+>$/);
    expect(tree({ message: 'Пользователь Тестов +447700900001 не найден' }).message).toMatch(/^<(mixed|masked):\d+>$/);
  });
});

describe('ключи и пределы', () => {
  it('данные в имени ключа: метка, вложенное разбирается дальше', () => {
    for (const k of ['447700900001', 'user@example.com', 'Тестов', UUID, 'abc1234567']) {
      const t = tree({ [k]: { inner: 'x' } });
      // Маска e-mail длиннее значения, поэтому метка считается от неё.
      expect(Object.keys(t)[0]).toBe(`<key:${k.includes('@') ? 'u*****@example.com'.length : k.length}>`);
      expect(Object.values(t)[0]).toEqual({ inner: '<latin:1>' });
    }
    expect(Object.keys(tree({ '@timestamp': 'x', family_name: 'Т' }))).toEqual(['@timestamp', 'family_name']);
  });

  it('два одинаковых заменённых ключа', () => {
    const t = tree({ '111111111111': 'a', '222222222222': 'b' });
    expect(t).toEqual({ '<key:12>': '<latin:1>', '<key:12#2>': '<latin:1>' });
  });

  it('массив: первые 2 и $more', () => {
    expect(tree({ a: Array.from({ length: 40 }, () => 'x') }).a).toEqual(['<latin:1>', '<latin:1>', { $more: 38 }]);
  });

  it('глубина и большой объект', () => {
    let deep: unknown = { leaf: 'x' };
    for (let i = 0; i < 15; i++) deep = { n: deep };
    expect(JSON.stringify(tree(deep))).toContain('<cut>');
    expect(JSON.stringify(tree(deep))).not.toContain('leaf');
    const big = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`k${i}`, 1]));
    const t = tree({ big }).big;
    expect(Object.keys(t)).toHaveLength(101);
    expect(t.$more).toBe(50);
  });

  it('большая запись обрезана по границе поля', () => {
    const big = Object.fromEntries(Array.from({ length: 99 }, (_, i) => [`section_${i}`, Object.fromEntries(Array.from({ length: 99 }, (__, j) => [`field_${j}`, 'x']))]));
    const t = tree(big);
    const text = JSON.stringify(t, null, 2);
    expect(text.length).toBeLessThanOrEqual(MAX_TREE_BYTES);
    expect(text).toContain('<cut>');
  });

  it('строка 3 МБ в пределах секунды', () => {
    const line = JSON.stringify({ message: 'x'.repeat(3 * 1024 * 1024), stream: 'stdout' });
    const started = performance.now();
    const t = tree(JSON.parse(line));
    expect(performance.now() - started).toBeLessThan(1000);
    expect(t.message).toBe('<latin:999999+>');
    expect(recordTree('y '.repeat(1_500_000), EMPTY_SHAPE)).toMatch(/^<latin:999999\+>$/);
  });

  it('строка не JSON и битый вложенный JSON', () => {
    expect(recordTree('[GIN] 2026/11/04 - 10:00:00 | 200', EMPTY_SHAPE)).toMatch(/^<mixed:\d+>$/);
    expect(tree({ body: '{"family_name":"Тестов"' }).body).toMatch(/^<(mixed|masked):\d+>$/);
  });

  it('форма дерева от маски: голое число стало маской, запись остаётся разобранной', () => {
    const t = tree({ message: JSON.stringify({ x: 4111111234557893, ok: 1 }) });
    expect(t.message.$json).toEqual({ x: '<masked:16>', ok: '<int:1>' });
  });
});

describe('вложенные форматы', () => {
  it('JSON на нескольких уровнях', () => {
    const inner = JSON.stringify({ family_name: 'Тестов', deep: JSON.stringify({ city: 'Лесогор' }) });
    const t = tree({ body: JSON.stringify({ inner }) });
    expect(t.body.$json.inner.$json.family_name).toBe('<masked:6>');
    expect(t.body.$json.inner.$json.deep.$json.city).toBe('<cyr:7>');
  });

  it('сырой HTTP: имена заголовков, вместо значений метки', () => {
    const raw = `POST /x?a=1 HTTP/1.1\r\nX-Phone: +447700900001\r\nHost: h\r\n\r\n{"amount":100}`;
    const h = tree({ raw_request: raw }).raw_request.$http;
    expect(h.method).toBe('POST');
    expect(h.queryNames).toEqual(['a']);
    expect(h.headers['X-Phone'][0]).toMatch(/^<masked:\d+>$/);
    expect(h.body.$json.amount).toBe('<int:3>');
    expect(tree({ r: `HTTP/1.1 500 Fail\r\n\r\n` }).r.$http.status).toBe(500);
  });

  it('XML: только имена тегов, тег с данными — меткой', () => {
    const t = tree({ body: '<ns2:family_name>Тестов</ns2:family_name><Тестов>1</Тестов><x><![CDATA[Тестов]]></x>' });
    expect(t.body.$xml).toEqual(['ns2:family_name', '<key:6>', 'x']);
  });

  it('форма: только имена', () => {
    expect(tree({ body: 'phone=447700900001&amount=100' }).body.$form).toEqual(['phone', 'amount']);
  });

  it('base64 не раскрывается', () => {
    const b = Buffer.from(JSON.stringify({ family_name: 'Тестов', phone: '447700900001' })).toString('base64');
    expect(tree({ blob: b }).blob).toBe(`<b64:${b.length}>`);
    expect(tree({ blob: 'YWJjZDEyMzRhYmNkMTIzNA==' }).blob).toBe('<b64:24>');
    // Короткий конец base64 с «=» не становится формой: имя открыло бы значение.
    expect(tree({ blob: 'dGVzdG92MTI=' }).blob).toMatch(/^<\w+:12>$/);
  });
});

describe('белый список', () => {
  it('технический статус остаётся', () => {
    expect(tree({ status: 'HOLD', level_name: 'ERROR', code: -31050 })).toEqual({ status: 'HOLD', level_name: 'ERROR', code: -31050 });
  });

  it('данные в техническом поле заменены меткой', () => {
    const t = tree({ status: '447700900001', code: 'user@example.com', state: 'ул. Примерная', result: UUID, type: '192.0.2.40' });
    for (const k of ['status', 'code', 'state', 'result', 'type']) expect(t[k]).toMatch(/^<\w+:\d+>$/);
    expect(tree({ code: '1990-01-01' }).code).toBe('<date:10>');
    expect(tree({ code: 1234567 }).code).toBe('<int:7>');
  });

  it('похожие имена не совпадают', () => {
    expect(tree({ promo_code: '1234', zip_code: '100000' })).toEqual({ promo_code: '<digits:4>', zip_code: '<digits:6>' });
    // Коды подтверждения теперь секреты: их форма в выборку не идёт.
    expect(tree({ sms_code: '1234', otp_code: '1234' })).toEqual({ sms_code: '<masked:3>', otp_code: '<masked:3>' });
  });

  it('поля правил: читаемое остаётся, персональное и текстовое нет', () => {
    const snapshot = snapshotFromFile({
      version: 1,
      project: 'pay',
      systems: [
        {
          key: 'pay',
          kind: 'project',
          name: 'Demo Pay',
          outcomes: [
            { when: { fields: [{ path: 'result.payment_state', equals: 'CONFIRMED' }] }, outcome: 'success' },
            { when: { fields: [{ path: 'error.message', regex: '^x' }] }, outcome: 'error' },
            { when: { fields: [{ path: 'client_note', exists: true }] }, outcome: 'pending' },
          ],
        },
      ],
    });
    const allowed = allowedFields(snapshot);
    const o: ShapeOptions = { ...EMPTY_SHAPE, allowed };
    expect(tree({ payment_state: 'CONFIRMED' }, o).payment_state).toBe('CONFIRMED');
    expect(tree({ message: 'word' }, o).message).toBe('<latin:4>');
    // Старое правило на поле словаря: такие файл уже не пропускает, поэтому снимок собирается вручную.
    const old = allowedFields({ ...snapshot, outcomeRules: [{ ...snapshot.outcomeRules[0]!, when: { fields: [{ path: 'mobile_phone', equals: 'x' }] } }] });
    expect(old.has('mobilephone')).toBe(false);
  });

  it('на настоящем файле набора нет секретов и текста', () => {
    const allowed = allowedFields(snapshotFromFile(JSON.parse(JSON.stringify(CATALOG))));
    expect(allowed.has('paymentstate')).toBe(true);
    for (const n of ['smscode', 'otpcode', 'zipcode', 'contenttype', 'message', 'name']) expect(allowed.has(n)).toBe(false);
  });
});

describe('шаблоны путей', () => {
  const known = words('v1', 'users', 'cards', 'clients');

  it('идентификаторы', () => {
    expect(pathShape(`/v1/users/${UUID}/cards/${UUID2}`, known)).toBe('/v1/users/{user}/cards/{card}');
  });

  it('фамилия латиницей у одного correlation_id', () => {
    expect(pathShape('/v1/clients/testov/cards', known)).toBe('/v1/clients/{seg}/cards');
    expect(pathShape(`/v1/clients/testov/${UUID}`, known)).toBe('/v1/clients/{seg}/{id}');
  });

  it('частое слово остаётся', () => {
    const o: ShapeOptions = { ...known, frequent: new Set(['bind']) };
    expect(pathShape('/v1/users/bind', o)).toBe('/v1/users/bind');
  });

  it('кириллица, percent-encoding и строка запроса', () => {
    expect(pathShape('/v1/users/Тестов', known)).toBe('/v1/users/{seg}');
    expect(pathShape('/v1/users/%D0%A2%D0%B5%D1%81%D1%82', known)).toBe('/v1/users/{seg}');
    expect(httpShape('/x?address=%D1%83%D0%BB&login=user%40example.com', EMPTY_SHAPE)).toEqual({ host: null, path: '/{seg}', queryNames: ['address', 'login'] });
  });

  it('хост: система, ipv4, dns, учётные данные', () => {
    const o: ShapeOptions = { ...EMPTY_SHAPE, systemOf: (u) => (u.includes('ledger') ? 'ledger' : null) };
    expect(httpShape('http://ledger.local/x', o).host).toBe('system:ledger');
    expect(httpShape('http://192.0.2.40:8080/x', o).host).toBe('<host:ipv4>');
    expect(httpShape('https://user:pass@host.example/x', o)).toEqual({ host: '<host:dns>', path: '/{seg}', queryNames: [] });
  });

  it('слова справочника', () => {
    const w = catalogWords(snapshotFromFile(JSON.parse(JSON.stringify(CATALOG))));
    expect([...w]).toEqual(expect.arrayContaining(['v1', 'users', 'cards', 'hold', 'pay']));
  });
});

describe('метки потока', () => {
  it('разрешённые остаются, остальные меткой, данные в разрешённой меткой', () => {
    expect(flowLabels({ container: 'server', app_kubernetes_io_component: 'gateway', pod: 'pay-app-1', host: 'node-a' })).toEqual({
      app_kubernetes_io_component: 'gateway',
      container: 'server',
      host: '<latin:6>',
      pod: '<mixed:9>',
    });
    expect(flowLabels({ container: '192.0.2.40', namespace: 'ns-1234567' })).toEqual({ container: '<mixed:10>', namespace: '<mixed:10>' });
  });

  it('форма дерева не зависит от маски шлюза', () => {
    expect(shapeTree({ a: 'x' }, EMPTY_SHAPE)).toEqual({ a: '<latin:1>' });
  });
});
