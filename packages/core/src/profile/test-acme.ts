// Пример профиля acme и строки к нему для тестов. Все значения выдуманы.
// Поток: JSON приложения (контейнер app) и строки доступа nginx (контейнер nginx).
import type { LogLine } from '../backend/index.ts';
import type { Profile } from './types.ts';

export const NGINX_PATTERN = '^(?<ip>\\S+) \\S+ \\S+ \\[[^\\]]+\\] "(?<method>[A-Z]+) (?<uri>\\S+)[^"]*" (?<status>\\d{3})';

export const ACME_PROFILE: Profile = {
  component: ['container'],
  levels: { '50': 400 },
  variants: [
    {
      name: 'app',
      when: { labels: { container: 'app' }, has: ['rec.ts'] },
      layers: [{ name: 'rec', decode: 'json' }],
      fields: {
        time: 'rec.ts',
        level: 'rec.lvl',
        message: 'rec.msg',
        correlationId: 'rec.trace_id',
        requestId: 'rec.span_id',
        method: 'rec.http.method',
        uri: 'rec.http.url',
        status: 'rec.http.status',
        body: 'rec.http.body',
        context: 'rec.extra',
      },
      kinds: [
        { kind: 'incoming', when: { equals: { 'rec.msg': 'incoming request' } } },
        { kind: 'send', when: { equals: { 'rec.msg': 'outgoing request' } } },
        { kind: 'response', when: { equals: { 'rec.msg': 'outgoing response' } } },
      ],
    },
    {
      name: 'nginx',
      when: { labels: { container: 'nginx' }, has: ['access.status'] },
      layers: [{ name: 'access', decode: 'text', pattern: NGINX_PATTERN }],
      fields: { message: 'access.uri', method: 'access.method', uri: 'access.uri', status: 'access.status' },
    },
  ],
};

export const ACME_APP = { namespace: 'acme', container: 'app' };
export const ACME_NGINX = { namespace: 'acme', container: 'nginx' };
export const ACME_CID = 'order-77.a1';
export const ACME_T0 = 1_793_180_955_495;

let seq = 0;
const ns = (ms: number) => (BigInt(Math.trunc(ms)) * 1_000_000n + BigInt(++seq % 1000)).toString();

/** Строка приложения acme: JSON одной строкой, время в мс от эпохи. */
export function acmeApp(offsetMs: number, rec: Record<string, unknown>, labels: Record<string, string> = ACME_APP): LogLine {
  return { tsNs: ns(ACME_T0 + offsetMs + 2), line: JSON.stringify({ ts: ACME_T0 + offsetMs, ...rec }), labels };
}

export function acmeNginx(offsetMs: number, request = 'GET /api/orders/77 HTTP/1.1', status = 200): LogLine {
  return {
    tsNs: ns(ACME_T0 + offsetMs),
    line: `10.1.2.3 - - [01/Nov/2026:10:11:12 +0500] "${request}" ${status} 512 "-" "curl/8"`,
    labels: ACME_NGINX,
  };
}

/** Запрос acme: вход, отправка в платёжный шлюз и ответ, лог с остальным контекстом. */
export function acmeRequest(cid = ACME_CID): LogLine[] {
  const http = { method: 'POST', url: 'https://pay.example.test/v2/charge' };
  return [
    acmeApp(0, { lvl: 'info', msg: 'incoming request', trace_id: cid, http: { method: 'POST', url: '/api/orders/77/pay' } }),
    acmeApp(5, { lvl: 'info', msg: 'outgoing request', trace_id: cid, span_id: 's1', http: { ...http, body: { amount: 100 } } }),
    acmeApp(35, { lvl: 'info', msg: 'outgoing response', trace_id: cid, span_id: 's1', http: { ...http, status: 200, body: '{"ok":true}' } }),
    acmeApp(40, { lvl: 'warn', msg: 'slow charge', trace_id: cid, extra: { tookMs: 30, region: 'eu' } }),
  ];
}
