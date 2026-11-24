// Записи демо-проекта Demo Pay во встроенном формате json для тестов search/* и profile/*. Значения выдуманы.
import type { LogLine } from '../backend/index.ts';

export const CARDS_LABELS = {
  cluster: 'demo',
  namespace: 'pay',
  container: 'cards',
  app_kubernetes_io_component: 'cards',
};
export const API_LABELS = {
  cluster: 'demo',
  namespace: 'pay',
  container: 'api',
  app_kubernetes_io_component: 'api',
};
export const GATEWAY_LABELS = {
  cluster: 'demo',
  namespace: 'pay',
  app_kubernetes_io_component: 'gateway',
};

/** Смещение времени записей в тестах: время записи пишется с поясом, а не в UTC. */
export const OFFSET = '+05:00';

const LEVEL_NAMES: Record<number, string> = {
  100: 'debug',
  200: 'info',
  250: 'notice',
  300: 'warning',
  400: 'error',
};

/** Поля записи приложения после correlation_id: request_id, request, upstream, action, payload, step, duration_ms, ctx. */
export type AppFields = Record<string, unknown>;

/**
 * Запись приложения встроенного формата json. time — местное время с микросекундами без пояса, например
 * «2026-10-28T16:20:29.921030»; cid = '' — без correlation_id. Уровень — число по шкале Monolog или имя.
 */
export function app(msg: string, fields: AppFields, time: string, cid: string, level: number | string = 200): Record<string, unknown> {
  return {
    time: `${time}${OFFSET}`,
    level: typeof level === 'number' ? (LEVEL_NAMES[level] ?? 'info') : level,
    msg,
    ...(cid === '' ? {} : { correlation_id: cid }),
    ...fields,
  };
}

/** Мс эпохи для местного времени записи с дробью до микросекунд. */
export function localMs(local: string): number {
  const [whole = '', frac = ''] = local.split('.');
  return Date.parse(`${whole}${OFFSET}`) + Number(frac.padEnd(9, '0')) / 1e6;
}

/** tsNs Loki: время чтения на несколько мс позже времени записи. */
export function nsAfter(local: string, lagMs = 3): string {
  const [whole = '', frac = ''] = local.split('.');
  const ns = BigInt(Date.parse(`${whole}${OFFSET}`)) * 1_000_000n + BigInt(frac.padEnd(9, '0')) + BigInt(lagMs) * 1_000_000n;
  return ns.toString();
}

/** Строка хранилища: запись JSON или текст как есть. */
export function line(rec: object | string): string {
  return typeof rec === 'string' ? rec : JSON.stringify(rec);
}

export function logLine(tsNs: string, text: string, labels: Record<string, string> = CARDS_LABELS): LogLine {
  return { tsNs, line: text, labels };
}

/** Запись приложения строкой лога; tsNs — на lagMs позже её времени. */
export function record(r: Record<string, unknown>, labels: Record<string, string> = CARDS_LABELS, lagMs = 3): LogLine {
  const local = String(r.time).replace(OFFSET, '');
  return logLine(nsAfter(local, lagMs), line(r), labels);
}

export const PROCESSOR_URI = 'https://processor.pay.example:8443/soap/issuing';
export const CARDS_CID = '6300014100001';

export function soap(action: string, inner: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns1="urn:demo-processor">' +
    `<SOAP-ENV:Body><ns1:${action}>${inner}</ns1:${action}></SOAP-ENV:Body></SOAP-ENV:Envelope>\n`
  );
}

export const PROCESSOR_HEADERS = {
  'Content-Length': ['873'],
  'User-Agent': ['pay-http/1.0'],
  Authorization: ['Basic cGF5X2lzc3Vpbmc6RmFrZSNQYXNzMjAyNg=='],
  Host: ['processor.pay.example:8443'],
  'Content-Type': ['text/xml; charset=utf-8'],
  SOAPAction: ['""'],
};

/** Запрос сервиса карт POST /v1/cards/lookup: вход, вызов getCard, отправка и ответ процессинга. */
export function cardsLookup(
  responseInfo = '<ResponseInfo><response_code>0</response_code></ResponseInfo><Details><cardNumber>4000000000001234</cardNumber></Details>',
): LogLine[] {
  const cid = CARDS_CID;
  return [
    record(
      app(
        'incoming request',
        {
          request_id: cid,
          request: { method: 'POST', path: '/v1/cards/lookup', body: '{"card_tokens":["400000ABCDEF1234","400000GHIJKL5678"]}' },
        },
        '2026-10-28T16:20:29.921030',
        cid,
      ),
    ),
    record(
      app(
        'processor call',
        {
          request_id: cid,
          action: 'getCard',
          payload: [{ issuerCode: '01', groupCode: '02', sessionId: '019a2b3c-4d5e-7f60-8a71-b2c3d4e5f607' }, { CARD: '400000ABCDEF1234' }],
        },
        '2026-10-28T16:20:29.924512',
        cid,
      ),
    ),
    record(
      app(
        'http request sending',
        {
          request_id: cid,
          upstream: { method: 'POST', url: PROCESSOR_URI, headers: PROCESSOR_HEADERS, body: soap('getCard', '<Parameters><CARD>400000ABCDEF1234</CARD></Parameters>') },
        },
        '2026-10-28T16:20:29.927658',
        cid,
      ),
    ),
    record(
      app(
        'http response received',
        { request_id: cid, upstream: { method: 'POST', url: PROCESSOR_URI, status: 200, body: soap('getCardResponse', responseInfo) } },
        '2026-10-28T16:20:30.239658',
        cid,
      ),
    ),
  ];
}

/** Тело ответа коммутатора /v3/cards/info: card 000, card2 118, номер без проверки Луна. */
export function switchCardBody(cardActionCode = '000', extraCard: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: '2cc11d98-8d41-477c-8352-77f2a9ab7f4c',
    result: {
      itemCount: 1,
      card: {
        issuerId: 'DEMO',
        primaryAccountNumber: '5100123440473348',
        effectiveDate: '2025-08-19T12:05:49Z',
        updateDate: '2025-08-19T12:19:12Z',
        prefixId: 1,
        expiry: '3008',
        cardSequence: 1,
        cardholderId: '00894250',
        nameOnCard: 'ALEX JOHNSON',
        accountFlag: 'E',
        feeGroup: '7',
        holderRef: '00894250',
        additionalInfo: 'ADD00100000101AAA002AABBB0011CCC00100000000A0701400000000000000A0800900000-001',
        riskLevel: 'A',
        limitGroup: 'A',
        branch: '35',
        pinTryCount: 0,
        ...extraCard,
        statuses: {
          item: [
            {
              type: 'card',
              actionCode: cardActionCode,
              actionDescription: cardActionCode === '000' ? 'Approved' : 'Do not honor',
              effectiveDate: '2025-08-19T12:05:49Z',
            },
            {
              type: 'card2',
              actionCode: '118',
              actionDescription: 'Decline, no card record',
              effectiveDate: '2025-08-19T12:05:49Z',
            },
            { type: 'hot', actionCode: '000', actionDescription: 'Approved' },
            { type: 'issuer', actionCode: '000', actionDescription: 'Approved' },
            { type: 'user', actionCode: '000', actionDescription: 'Approved' },
          ],
        },
      },
      account: [
        {
          issuerId: 'DEMO',
          accountId: '36999719',
          bankAccountId: '7001112344650819',
          currency: '978',
          cardholderId: '00123450',
          effectiveDate: '2026-10-30T15:09:15Z',
          updateDate: '2026-10-30T15:17:05Z',
          accountType: 'DEFAULT',
          openingAmount: 92,
          heldAmount: 0,
          heldUntil: '2026-10-30T15:03:39Z',
          reservedAmount: 0,
          priority: 1,
          status: 'Active',
          availableAmount: 92,
          feeGroup: '7',
        },
      ],
      balance: {
        currency: '978',
        openingAmount: 92,
        bonus: 0,
        creditLimit: 0,
        heldAmount: 0,
        heldOfflineAmount: 0,
        lockedAmount: 0,
        availableAmount: 92,
      },
      sms: {
        state: 'on',
        phone: '+447700900528',
        message: 'synthetic gateway sample phrase for tests only',
      },
    },
  });
}

export const SWITCH_CID = '1b33b84b-3dd3-4de7-b5de-1c3b1128df6e';

/** Строка ответа коммутатора целиком: тело ответа — строка JSON внутри записи. */
export function switchResponseLine(): LogLine {
  const r = {
    time: '2026-10-30T16:49:15.486322+05:00',
    level: 'info',
    msg: 'http response received',
    correlation_id: SWITCH_CID,
    request_id: 'd5258298-5586-4a80-9cbd-67d49e7f5b1c',
    upstream: { method: 'POST', url: 'http://192.0.2.41:9191/v3/cards/info', status: 200, body: switchCardBody() },
  };
  const tsNs = (BigInt(Date.parse('2026-10-30T16:49:15+05:00')) * 1_000_000n + 495_787_352n).toString();
  return logLine(tsNs, line(r), API_LABELS);
}

export const GIN_TEXT =
  '[GIN] 2026/10/28 - 16:20:29 | 500 |    7.123456s |    203.0.113.17 | POST     "/v1/users/0192f3a4-5b6c-7d8e-9f01-23456789abcd/cards/7c9e6679-7425-40de-944b-e07fc1f90ae7/unblock"';

/** Строка доступа шлюза [GIN]: текст, а не запись JSON. */
export function ginLine(): LogLine {
  return logLine(nsAfter('2026-10-28T16:20:29.955000', 7), GIN_TEXT, GATEWAY_LABELS);
}

/** Обрезанная строка: начало записи JSON без конца. */
export const BROKEN_LINE = '{"time":"2026-10-30T16:49:15.495787+05:00","level":"info","msg":"incoming req';
