import { describe, expect, it } from 'vitest';
import type { LogLine } from '../backend/index.ts';
import { maskDeep, maskText } from './masking.ts';
import { buildView, parseLine } from './records.ts';
import { summarize } from './status.ts';
import { API_LABELS, app, GATEWAY_LABELS, line, nsAfter, OFFSET, record, switchCardBody } from './test-fixtures.ts';

// Запись шлюза встроенного формата json: сырой HTTP-запрос партнёра в raw_request. Все значения выдуманы.

const GW_LABELS = { ...GATEWAY_LABELS, container: 'gateway' };
const CID = '5b0c1d2e-3f40-4a51-8b62-7c83d94ea5f6';
const RID = 'a1b2c3d4-e5f6-4a07-9b18-c29d3e4f5a60';
const USER = '0193a0b1-c2d3-7e4f-8a5b-6c7d8e9f0a1b';
const CARD = '0193a1b2-c3d4-7e5f-9a6b-7c8d9e0f1a2b';
const PATH = `/v1/users/${USER}/cards/${CARD}`;
const GW_TOKEN = 'Qx7vR2mK9pL4sT8wZ1nB6cD3fG5hJ0yU';
const JWT =
  'eyJhbGciOiJIUzUxMiJ9.eyJpYXQiOjE3NjIwNzk0OTIsInN1YiI6InBheS1hcHAifQ.' +
  'c2lnbmF0dXJlLW5vdC1yZWFsLXNpZ25hdHVyZS1ub3QtcmVhbC1zaWduYXR1cmU';
const PAN_LIKE = '5555550000473342'; // не проходит проверку Луна

function httpRequest(headers: [string, string][], opts: { method?: string; path?: string; body?: string; eol?: string } = {}) {
  const eol = opts.eol ?? '\r\n';
  const lines = [`${opts.method ?? 'GET'} ${opts.path ?? PATH} HTTP/1.1`, ...headers.map(([k, v]) => `${k}: ${v}`)];
  return lines.join(eol) + eol + eol + (opts.body ?? '');
}

const SAMPLE_HEADERS: [string, string][] = [
  ['Host', 'api.pay.example'],
  ['Authorization', `Bearer ${GW_TOKEN}`],
  ['User-Agent', 'partner-client/2.1'],
  ['X-Correlation-Id', CID],
  ['X-Forwarded-For', '203.0.113.4'],
  ['X-Forwarded-Host', 'api.pay.example'],
  ['X-Forwarded-Port', '443'],
  ['X-Forwarded-Proto', 'https'],
  ['X-Real-Ip', '203.0.113.4'],
  ['X-Request-Id', RID],
];

const AT = `2026-11-01T10:11:12.345678${OFFSET}`;

/** Запись шлюза: raw_request — сырой HTTP или другое значение для проверок, over — поля поверх. */
function gatewayLine(raw: unknown = httpRequest(SAMPLE_HEADERS), over: Record<string, unknown> = {}): LogLine {
  const gw = { time: AT, level: 'debug', msg: 'request received', raw_request: raw, ...over };
  return { tsNs: nsAfter('2026-11-01T10:11:12.345678', 0), line: line(gw), labels: GW_LABELS };
}

/** Запись из контейнера шлюза без сырого запроса: обычная запись приложения. */
function gatewayLog(msg: string, level = 'debug', extra: Record<string, unknown> = {}): LogLine {
  return { tsNs: nsAfter('2026-11-01T10:11:12.345678', 0), line: line({ time: AT, level, msg, ...extra }), labels: GW_LABELS };
}

/** Записи api того же запроса: отправка в коммутатор с JWT и ответ. request_id — X-Request-Id шлюза. */
function apiLines(): LogLine[] {
  const url = 'http://switch.pay.example:9191/v3/cards/info';
  return [
    record(
      app(
        'http request sending',
        {
          request_id: RID,
          upstream: {
            method: 'POST',
            url,
            headers: { 'Content-Type': ['application/json'], Authorization: [`Bearer ${JWT}`] },
            body: JSON.stringify({ params: { primaryAccountNumber: PAN_LIKE, lang_flag: 1 } }),
          },
        },
        '2026-11-01T10:11:12.359832',
        CID,
      ),
      API_LABELS,
    ),
    record(app('http response received', { request_id: RID, upstream: { method: 'POST', url, status: 200, body: switchCardBody() } }, '2026-11-01T10:11:12.373242', CID), API_LABELS),
  ];
}

const done = { match: 'exact' as const, readEndMs: Date.parse('2026-11-01T10:20:00+05:00'), incomplete: false };

describe('запись шлюза', () => {
  it('вход: метод и путь, заголовки, correlation_id и request_id из заголовков, время и уровень', () => {
    const r = parseLine(gatewayLine());
    expect(r).toMatchObject({
      kind: 'incoming',
      message: 'request received',
      level: 'DEBUG',
      levelNum: 100,
      gateway: true,
      correlationId: CID,
      requestId: RID,
      labels: GW_LABELS,
    });
    expect(r.timeMs).toBeCloseTo(Date.UTC(2026, 10, 1, 5, 11, 12, 345) + 0.678, 6);
    expect(r.method).toBe('GET');
    expect(r.uri).toBe(PATH);
    expect(r.body).toBe('');
    expect(r.headers).toEqual(Object.fromEntries(SAMPLE_HEADERS.map(([k, v]) => [k, [v]])));
    expect(r.context).toBeNull();
  });

  it('в просмотре — как вход приложения: заголовок, запрос, заголовки, тело «пусто»', () => {
    const [v] = buildView([parseLine(gatewayLine())], { withOffsets: true });
    expect(v).toMatchObject({
      kind: 'incoming',
      title: `GET ${PATH}`,
      message: 'request received',
      level: 'DEBUG',
      isError: false,
      component: 'gateway',
      correlationId: CID,
      requestId: RID,
      http: { method: 'GET', uri: PATH, status: null, noResponse: false },
      sections: { body: '', payload: null, context: null },
    });
    expect((v!.sections.headers as Record<string, string[]>)['X-Correlation-Id']).toEqual([CID]);
  });

  it('уровни строкой и числом', () => {
    const levels: [unknown, string | null, number | null][] = [
      ['DEBUG', 'DEBUG', 100],
      ['INFO', 'INFO', 200],
      ['NOTICE', 'NOTICE', 250],
      ['warning', 'WARNING', 300],
      ['ERROR', 'ERROR', 400],
      ['CRITICAL', 'CRITICAL', 500],
      ['ALERT', 'ALERT', 550],
      ['EMERGENCY', 'EMERGENCY', 600],
      ['TRACE', 'TRACE', null],
      [400, 'ERROR', 400],
      [undefined, null, null],
    ];
    for (const [level, name, num] of levels) {
      const r = parseLine(gatewayLine(undefined, { level }));
      expect([r.level, r.levelNum], String(level)).toEqual([name, num]);
    }
    const [warn] = buildView([parseLine(gatewayLine(undefined, { level: 'WARNING' }))], { withOffsets: true });
    expect(warn!.isError).toBe(true);
  });

  it('без raw_request — лог с текстом msg и уровнем из level, шлюз по метке', () => {
    const r = parseLine(gatewayLog('backend timeout: http://api:8080', 'error'));
    expect(r).toMatchObject({
      kind: 'log',
      gateway: true,
      message: 'backend timeout: http://api:8080',
      level: 'ERROR',
      levelNum: 400,
      correlationId: null,
      context: null,
    });
    expect(r.timeMs).toBeCloseTo(Date.UTC(2026, 10, 1, 5, 11, 12, 345) + 0.678, 6);
    expect(parseLine(gatewayLog('done', 'info', { response_data: 'x' })).kind).toBe('log');
  });

  it('raw_request не HTTP-запрос — лог, строка не теряется', () => {
    for (const rd of ['hello', 'HTTP/1.1 200 OK\r\n\r\n', '', 'GET /x\r\n\r\n']) {
      const l = gatewayLine(rd);
      const r = parseLine(l);
      expect(r.kind, rd).toBe('log');
      expect(r.line).toBe(l.line);
    }
    expect(parseLine(gatewayLine({ method: 'GET' })).kind).toBe('log');
  });

  it('сообщение шлюза объектом, а не строкой: вход разбирается, сообщение — текст JSON', () => {
    const r = parseLine(gatewayLine(undefined, { msg: { text: 'edge' } }));
    expect(r).toMatchObject({ kind: 'incoming', correlationId: CID, message: '{"text":"edge"}' });
  });

  it('POST с телом, переводы строк LF, повтор заголовка, имя без учёта регистра', () => {
    const raw = httpRequest(
      [
        ['x-correlation-id', CID],
        ['Accept', 'application/json'],
        ['Accept', 'text/plain'],
        ['Content-Type', 'application/json'],
        ['not a header line', ''],
      ],
      { method: 'POST', path: '/v1/users/u/payments/p/confirm?x=1', body: '{"amount":100}\n', eol: '\n' },
    );
    const r = parseLine(gatewayLine(raw));
    expect(r).toMatchObject({ kind: 'incoming', correlationId: CID, requestId: null });
    const [v] = buildView([r], { withOffsets: true });
    expect(v!.title).toBe('POST /v1/users/u/payments/p/confirm?x=1');
    expect(v!.sections.body).toBe('{"amount":100}\n');
    expect(v!.sections.headers).toEqual({
      'x-correlation-id': [CID],
      Accept: ['application/json', 'text/plain'],
      'Content-Type': ['application/json'],
    });
  });

  it('время не разобралось — время Loki', () => {
    const l = gatewayLine(undefined, { time: 'вчера' });
    expect(parseLine(l).timeMs).toBe(Number(BigInt(l.tsNs) / 1_000_000n) + Number(BigInt(l.tsNs) % 1_000_000n) / 1e6);
  });

  it('запись приложения с raw_request внутри ctx и с полем @timestamp остаётся записью приложения', () => {
    const m = { ...app('incoming request', { request: { method: 'GET', path: '/x' }, ctx: { raw_request: 'GET /y HTTP/1.1' } }, '2026-11-01T10:11:12.300000', CID), '@timestamp': 'x' };
    const r = parseLine(record(m, API_LABELS));
    expect(r).toMatchObject({ kind: 'incoming', message: 'incoming request', correlationId: CID, gateway: false, uri: '/x' });
    expect(r.context).toEqual({ raw_request: 'GET /y HTTP/1.1' });
  });

  it('запрос api через шлюз: записи сшиты, вход из шлюза, компонент api, не фоновый', () => {
    const parsed = [...apiLines(), gatewayLine()].map(parseLine);
    expect(new Set(parsed.map((r) => r.correlationId))).toEqual(new Set([CID]));
    const s = summarize(CID, parsed, done);
    expect(s).toMatchObject({
      incoming: { method: 'GET', path: PATH },
      component: 'api',
      kind: 'incoming',
      status: 'success',
      recordCount: 3,
    });
    const v = buildView(parsed, { withOffsets: true });
    expect(v.map((r) => [r.kind, r.component])).toEqual([
      ['incoming', 'gateway'],
      ['send', 'api'],
      ['response', 'api'],
    ]);
    expect(v[1]!.offsetMs).toBeCloseTo(14.154, 3);
    expect(v[2]!.http?.pairId).toBe(v[1]!.id);
  });

  it('только запись шлюза: компонент gateway', () => {
    expect(summarize(CID, [parseLine(gatewayLine())], done)).toMatchObject({ component: 'gateway', kind: 'maybe-cached' });
  });
});

describe('маскирование записи шлюза', () => {
  const keep = new Set([CID, RID]);

  it('Authorization в сырой строке: Bearer с \\r\\n в строке JSON и глубже, если строку вложили ещё', () => {
    const l = gatewayLine();
    // Сырой HTTP лежит строкой в записи JSON: переводы строк экранированы один раз.
    expect(l.line).toContain(`Authorization: Bearer ${GW_TOKEN}\\r\\n`);
    const masked = maskText(l.line, keep);
    expect(masked).not.toContain(GW_TOKEN);
    expect(masked).toContain('Authorization: Bearer ***\\r\\nUser-Agent');
    expect(masked).toContain(`X-Correlation-Id: ${CID}`);
    // После маскирования строка разбирается так же.
    expect(parseLine({ ...l, line: masked })).toMatchObject({ kind: 'incoming', correlationId: CID, requestId: RID });
    // Строку записи переслали ещё двумя обёртками JSON: третий уровень экранирования.
    const deep = maskText(JSON.stringify({ message: JSON.stringify({ message: l.line }) }), keep);
    expect(deep).not.toContain(GW_TOKEN);
    expect(deep).toContain('Authorization: Bearer ***');
  });

  it('Basic и Digest в сырой строке тоже', () => {
    for (const scheme of ['Basic', 'Digest']) {
      const raw = httpRequest([['Authorization', `${scheme} cGF5X3VzZXI6c2VjcmV0`], ['X-Correlation-Id', CID]]);
      const masked = maskText(gatewayLine(raw).line, keep);
      expect(masked).not.toContain('cGF5X3VzZXI6c2VjcmV0');
      expect(masked).toContain(`Authorization: ${scheme} ***`);
    }
  });

  it('Authorization в разобранных заголовках: схема и ***, без схемы — *** целиком', () => {
    const [v] = maskDeep(buildView([parseLine(gatewayLine())], { withOffsets: true }), keep);
    expect((v!.sections.headers as Record<string, string[]>).Authorization).toEqual(['Bearer ***']);
    expect(JSON.stringify(v)).not.toContain(GW_TOKEN);

    const raw = httpRequest([['authorization', 'opaque-token-value'], ['X-Correlation-Id', CID]]);
    const [w] = maskDeep(buildView([parseLine(gatewayLine(raw))], { withOffsets: true }), keep);
    expect((w!.sections.headers as Record<string, string[]>).authorization).toEqual(['***']);
  });

  it('Proxy-Authorization в разобранных заголовках и в сырой строке: без схемы, JWT, Token, bearer строчными', () => {
    for (const [value, expected] of [
      ['opaque-token-value', '***'],
      [JWT, '***'],
      ['Token tok-SECRET-1', '***'],
      [`bearer ${GW_TOKEN}`, 'bearer ***'],
    ] as const) {
      const raw = httpRequest([['Proxy-Authorization', value], ['X-Correlation-Id', CID]]);
      const l = gatewayLine(raw);
      const [v] = maskDeep(buildView([parseLine(l)], { withOffsets: true }), keep);
      expect((v!.sections.headers as Record<string, string[]>)['Proxy-Authorization'], value).toEqual([expected]);
      const secret = value.replace(/^\S+ /, '');
      expect(JSON.stringify(v), value).not.toContain(secret);
      expect(maskText(l.line, keep), value).not.toContain(secret);
    }
  });

  it('JWT Bearer в массиве заголовков исходящего вызова api', () => {
    const v = maskDeep(buildView(apiLines().map(parseLine), { withOffsets: true }), keep);
    const send = v.find((r) => r.kind === 'send')!;
    expect((send.sections.headers as Record<string, string[]>).Authorization).toEqual(['Bearer ***']);
    const out = JSON.stringify(v);
    expect(out).not.toContain(JWT.slice(0, 40));
    expect(out).not.toContain(PAN_LIKE);
    expect(out).toContain('555555******3342');
  });
});
