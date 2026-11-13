import { describe, expect, it } from 'vitest';
import { parseLine } from '@threadline/core/search';
import { builtinProfile, re2ToJs } from '@threadline/core/profile';
import { generatePayDataset } from '../src/backends/mock/dataset-pay.ts';

// Выражение подсчёта встроенного формата json в виде RegExp JS: те же класс символов и регистр.
// RE2 пишет флаг `(?i)` в начале и группу `(?P<имя>…)`, JS — флаг `i` и `(?<имя>…)`. Loki, как и JS, берёт первое совпадение.
const RE = re2ToJs(builtinProfile().countRegexp);
const key = (line: string) => RE.exec(line)?.groups?.cid ?? null;
const parsed = (line: string) => parseLine({ tsNs: '1', line, labels: {} }).correlationId;

/** Запись приложения: время, уровень, сообщение, correlation_id и остальные поля по порядку. */
const app = (cid: string, fields: Record<string, unknown> = {}) =>
  JSON.stringify({ time: '2026-11-01T10:11:12.373242Z', level: 'info', msg: 'http response received', correlation_id: cid, ...fields });

const gatewayLine = (http: string) => JSON.stringify({ time: '2026-11-01T10:11:12.345678Z', level: 'debug', msg: 'request received', raw_request: http });
const gateway = (cid: string, rid = 'a1b2c3d4-e5f6-4a07-9b18-c29d3e4f5a60') =>
  gatewayLine(`GET /v1/users/u/cards/c HTTP/1.1\r\nHost: api.pay.example\r\nAuthorization: Bearer abc\r\nX-Correlation-Id: ${cid}\r\nX-Request-Id: ${rid}\r\n\r\n`);

const CID = '5b0c1d2e-3f40-4a51-8b62-7c83d94ea5f6';

describe('выражение подсчёта correlation_id', () => {
  it('запись приложения: ключ correlation_id верхнего уровня', () => {
    expect(key(app(CID))).toBe(CID);
    expect(key(app('6300014100001'))).toBe('6300014100001');
    expect(key(app('AB12.cd:34_x-y'))).toBe('AB12.cd:34_x-y');
  });

  it('пробел после двоеточия (json.dumps в Python) не мешает', () => {
    const line = `{"time": "2026-11-01T10:11:12Z", "level": "info", "msg": "job", "correlation_id": "${CID}"}`;
    expect(key(line)).toBe(CID);
    expect(parsed(line)).toBe(CID);
  });

  it('ключ в строке сообщения или тела экранирован и не подходит; вложенные объекты после ключа записи его не подменяют', () => {
    const line = JSON.stringify({
      time: '2026-11-01T10:11:12.373242Z',
      level: 'info',
      msg: '{"correlation_id":"in-message"}',
      correlation_id: CID,
      upstream: { method: 'POST', url: 'https://x.example/y', headers: { 'X-Correlation-Id': ['other-three'] }, body: JSON.stringify({ correlation_id: 'other-one' }) },
      ctx: { correlation_id: 'late-one' },
    });
    expect(key(line)).toBe(CID);
    expect(parsed(line)).toBe(CID);
  });

  it('известное ограничение: вложенный объект с correlation_id до ключа записи даёт подсчёту чужое значение', () => {
    const line = JSON.stringify({ time: '2026-11-01T10:11:12Z', level: 'info', msg: 'job', ctx: { correlation_id: 'early-one' }, correlation_id: CID });
    expect(key(line)).toBe('early-one');
    expect(parsed(line)).toBe(CID);
  });

  it('запись шлюза: заголовок X-Correlation-Id после экранированного CRLF сырого HTTP', () => {
    const line = gateway(CID);
    expect(line).toContain(`X-Correlation-Id: ${CID}\\r\\n`);
    expect(key(line)).toBe(CID);
    expect(parsed(line)).toBe(CID);
  });

  it('шлюз: имя заголовка в другом регистре читают и подсчёт, и разбор', () => {
    const line = gatewayLine(`GET /v1/x HTTP/1.1\r\nhost: api.pay.example\r\nx-correlation-id: ${CID}\r\n\r\n`);
    expect(key(line)).toBe(CID);
    expect(parsed(line)).toBe(CID);
  });

  it('шлюз: ключ correlation_id в теле POST и заголовок *-Correlation-Id партнёра не подменяют X-Correlation-Id', () => {
    const post = (before: string, body: string) => gatewayLine(`POST /v1/partner/pay HTTP/1.1\r\nHost: api.pay.example\r\n${before}X-Correlation-Id: ${CID}\r\n\r\n${body}`);
    for (const line of [
      post('Content-Type: application/json\r\n', JSON.stringify({ correlation_id: 'partner-77', amount: 1 })),
      post('X-Partner-Correlation-Id: other\r\n', '{}'),
      post('', JSON.stringify({ meta: { 'correlation-id': 'partner-78' } })),
    ]) {
      expect(key(line)).toBe(CID);
      expect(parsed(line)).toBe(CID);
    }
  });

  it('строки без correlation_id: [GIN], PHP Warning, битая строка, запись без ключа и с null', () => {
    const gin = '[GIN] 2026/11/01 - 10:11:12 | 200 |   12.345678ms |  203.0.113.17 | GET      "/v1/users/u/cards/c"';
    expect(key(gin)).toBeNull();
    expect(key('PHP Warning:  Undefined array key "pan" in /app/src/Service/CardService.php on line 88')).toBeNull();
    expect(key('{"time":"2026-10-30T16:49:15.495787Z","level":"info","msg":"incoming req')).toBeNull();
    expect(key(JSON.stringify({ time: '2026-11-01T10:11:12Z', level: 'info', msg: 'background job' }))).toBeNull();
    expect(key(JSON.stringify({ time: '2026-11-01T10:11:12Z', level: 'info', msg: 'job', correlation_id: null }))).toBeNull();
  });

  it('пустое значение не считается', () => {
    expect(key(app(''))).toBeNull();
    expect(parsed(app(''))).toBeNull();
  });

  it('совпадает с разбором записи на всём синтетическом наборе: имитация считает так же, как Loki', () => {
    const { records } = generatePayDataset(Date.UTC(2026, 10, 2, 9, 0, 0));
    let gatewayLines = 0;
    for (const r of records) {
      const p = parseLine({ tsNs: r.tsNs.toString(), line: r.line, labels: r.labels });
      expect(key(r.line), r.line.slice(0, 120)).toBe(p.correlationId);
      if (r.labels.container === 'gateway' && p.correlationId) gatewayLines++;
    }
    expect(gatewayLines).toBeGreaterThan(5);
  });
});
