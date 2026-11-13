// Синтетические записи демо-проекта Demo Pay во встроенном формате json: одна запись JSON на строку, как её пишет приложение.
// Demo Pay — выдуманный платёжный шлюз: шлюз gateway, платёжный API api, сервис карт cards, фоновый worker и cron.
// Все системы, адреса и значения выдуманы. Формат записи описан в config/README.md («Встроенный формат json»).
// api сам вход не пишет: вход виден в записи шлюза с сырым HTTP. Перед сервисом карт шлюза нет, он пишет вход сам.

import { createHash } from 'node:crypto';
import { withLuhnCheckDigit } from '@threadline/core';
import { rng, type Rng } from './rand.ts';

export interface MockRecord {
  tsNs: bigint;
  labels: Record<string, string>;
  line: string;
}

type Component = 'api' | 'cards' | 'gateway' | 'worker' | 'cron';

/** Поля записи приложения после времени, уровня, сообщения и correlation_id. */
type Fields = Record<string, unknown>;

interface Entry {
  ms: number;
  component: Component;
  namespace: string;
  /** Запись JSON или готовый текст строки. */
  body: Record<string, unknown> | string;
  /** Строка целиком, если нужно сломать формат. */
  rawLine?: string;
  /** Метки поверх меток компонента: постоянный под, признак крона. */
  labels?: Record<string, string>;
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * Особые номера синтетического набора для проверки поиска и маскирования.
 * exactPan и twinPan — разные карты с одинаковыми краями 411111…7893, обе проходят проверку Луна.
 * nonLuhnPan — номер в primaryAccountNumber, не проходящий проверку Луна (маскируется по имени поля).
 */
export const MOCK_SPECIAL = {
  exactPan: '4111111234557893',
  twinPan: '4111119999957893',
  nonLuhnPan: '5555550000473342',
  /** Номер exactPan, который в логе уже замаскирован: только неточное совпадение. */
  maskedPan: '411111******7893',
  /**
   * user_id запроса api с вложенными телами (SOAP-прокси). Он есть только в пути входа на шлюзе
   * (запись шлюза и строка [GIN]): api своего входа не пишет. У того же клиента в наборе есть
   * ещё успешный запрос и два с ошибками: по нему ищет первый пример демо-среды.
   */
  gatewayUserId: '0192f0a1-7b2c-7d3e-8f40-5a6b7c8d9e0f',
} as const;

/** BIN карт имитации: visa и mastercard из общеизвестных тестовых номеров 4111… и 5555…, не банков-эмитентов. */
export const MOCK_BINS = { visa: '411111', mastercard: '555555', maestro: '676712' } as const;

const HOSTS = {
  processor: 'https://processor.pay.example:8443',
  balance: 'https://processor-balance.pay.example:8443',
  switch: 'http://switch.pay.example:11101',
  ledger: 'http://ledger.pay.example:8080',
  acquirer: 'https://api.acquirer.example',
  fraud: 'http://fraud.pay.example:9090',
  kyc: 'https://kyc.pay.example',
};

/** Адрес Demo Pay для партнёров в синтетических записях шлюза. */
const API_HOST = 'api.pay.example';
const DB = { host: 'db.pay.example', port: '5432' };

const NAMES = ['ALEX JOHNSON', 'MARIA GARCIA', 'DAVID MILLER', 'SOFIA ROSSI', 'LIAM NOVAK', 'EMMA SCHULZ'];
const CODE_WORDS = ['blue river', 'golden sun', 'green forest', 'silver moon'];
const LEVEL_NAMES: Record<number, string> = { 100: 'debug', 200: 'info', 250: 'notice', 300: 'warning', 400: 'error' };

/** Время ISO 8601 в UTC с fracDigits знаками дроби секунды. */
function isoUtc(ms: number, fracDigits: 6 | 9, extraNs = 0): string {
  const d = new Date(Math.trunc(ms));
  const base = d.toISOString().slice(0, 19);
  const subMs = Math.round((ms - Math.trunc(ms)) * 1000);
  const frac = (String(d.getUTCMilliseconds()).padStart(3, '0') + String(subMs).padStart(3, '0') + String(extraNs).padStart(3, '0')).slice(0, fracDigits);
  return `${base}.${frac}Z`;
}

function labels(component: Component, namespace: string, r: Rng): Record<string, string> {
  return {
    cluster: namespace === 'pay' ? 'demo' : 'demo-test',
    namespace,
    container: component,
    app_kubernetes_io_component: component,
    app_kubernetes_io_instance: 'pay-app',
    app_kubernetes_io_name: 'demo-pay',
    app_kubernetes_io_project: 'demo-pay',
    pod: `pay-app-${component}-6f8d9c7b5d-${r.letters(5).toLowerCase()}`,
    host: `demo-node-${r.int(0, 3)}`,
  };
}

/** Запись приложения: время, уровень, сообщение, correlation_id (cid = null — без него), затем поля записи. */
function rec(msg: string, fields: Fields, ms: number, cid: string | null, level = 200): Record<string, unknown> {
  return {
    time: isoUtc(ms, 6),
    level: LEVEL_NAMES[level] ?? 'info',
    msg,
    ...(cid === null || cid === '' ? {} : { correlation_id: cid }),
    ...fields,
  };
}

function soap(action: string, inner: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns1="urn:demo-processor">' +
    `<SOAP-ENV:Body><ns1:${action}>${inner}</ns1:${action}></SOAP-ENV:Body></SOAP-ENV:Envelope>\n`
  );
}

function processorHeaders(len: number) {
  return {
    'Content-Length': [String(len)],
    'User-Agent': ['pay-http/1.0'],
    Authorization: [`Basic ${Buffer.from('pay_issuing:Fake#Pass2026').toString('base64')}`],
    Host: ['processor.pay.example:8443'],
    'Content-Type': ['text/xml; charset=utf-8'],
    SOAPAction: ['""'],
  };
}

/** Выдуманный JWT для заголовка Authorization исходящего вызова api. Подпись не настоящая. */
function jwt(seed: string): string {
  const part = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const sig = createHash('sha512').update(`jwt:${seed}`).digest('base64url');
  return `${part({ alg: 'HS512' })}.${part({ sub: 'pay-app', jti: seed })}.${sig}`;
}

/** Отправка вызова: объект upstream без статуса. */
const send = (method: string, url: string, headers: unknown, body: string) => ({ upstream: { method, url, headers, body } });
/** Ответ вызова: объект upstream со статусом. */
const answer = (method: string, url: string, status: number, body: string) => ({ upstream: { method, url, status, body } });

class Builder {
  readonly entries: Entry[] = [];
  readonly pans = new Set<string>();
  readonly r: Rng;

  constructor(r: Rng) {
    this.r = r;
  }

  pan(kind: keyof typeof MOCK_BINS): string {
    const p = withLuhnCheckDigit(MOCK_BINS[kind] + this.r.digits(9));
    this.pans.add(p);
    return p;
  }

  token(pan: string): string {
    return pan.slice(0, 6) + this.r.letters(6) + pan.slice(-4);
  }

  push(ms: number, component: Component, namespace: string, body: Entry['body']) {
    this.entries.push({ ms, component, namespace, body });
  }

  /**
   * Вход запроса api: запись шлюза с сырым HTTP-запросом партнёра в raw_request.
   * X-Correlation-Id — correlation_id записей api, X-Request-Id — request_id исходящего вызова api.
   * Токен и адрес выводятся из correlation_id без генератора: остальные записи набора от этого не меняются.
   */
  gateway(ms: number, namespace: string, method: string, path: string, cid: string, rid: string, body = '') {
    const h = createHash('sha256').update(cid).digest();
    const ip = `203.0.113.${(h[1]! % 250) + 1}`;
    const token = createHash('sha256').update(`token:${cid}`).digest('base64url').slice(0, 40);
    const headers: [string, string][] = [
      ['Host', API_HOST],
      ['Authorization', `Bearer ${token}`],
      ['User-Agent', 'partner-client/2.1'],
      ...(body ? ([['Content-Length', String(Buffer.byteLength(body))], ['Content-Type', 'application/json']] as [string, string][]) : []),
      ['X-Correlation-Id', cid],
      ['X-Forwarded-For', ip],
      ['X-Forwarded-Host', API_HOST],
      ['X-Forwarded-Port', '443'],
      ['X-Forwarded-Proto', 'https'],
      ['X-Real-Ip', ip],
      ['X-Request-Id', rid],
    ];
    const http = [`${method} ${path} HTTP/1.1`, ...headers.map(([k, v]) => `${k}: ${v}`)].join('\r\n') + '\r\n\r\n' + body;
    this.entries.push({
      ms,
      component: 'gateway',
      namespace,
      body: { time: isoUtc(ms, 6), level: 'debug', msg: 'request received', raw_request: http },
    });
  }

  /** Строка доступа шлюза в формате Gin: текст, а не JSON. */
  gin(ms: number, status: number, durMs: number, method: string, path: string, namespace: string) {
    const d = new Date(ms).toISOString();
    const stamp = `${d.slice(0, 4)}/${d.slice(5, 7)}/${d.slice(8, 10)} - ${d.slice(11, 19)}`;
    const dur = durMs >= 1000 ? `${(durMs / 1000).toFixed(6)}s` : `${durMs.toFixed(6)}ms`;
    // Адреса партнёров — из диапазонов для документации (RFC 5737).
    const net = this.r.int(1, 254) % 2 === 0 ? '198.51.100' : '203.0.113';
    const ip = `${net}.${this.r.int(1, 254)}`;
    this.push(ms, 'gateway', namespace, `[GIN] ${stamp} | ${status} | ${dur.padStart(13)} | ${ip} | ${method.padEnd(8)} "${path}"`);
  }

  /**
   * Сервис карт: POST /v1/cards/lookup, вызовы процессинга. При fail второй вызов getCard отвечает ошибкой.
   * first — номер первой карты вместо случайного (особые номера MOCK_SPECIAL).
   */
  cardsLookup(t: number, fail: boolean, ns = 'pay', first?: string) {
    const r = this.r;
    const cid = String(r.int(6_300_000_000_000, 6_399_999_999_999));
    if (first) this.pans.add(first);
    const pans = [first ?? this.pan('visa'), this.pan('visa')];
    const tokens = pans.map((p) => this.token(p));
    const url = `${HOSTS.processor}/soap/issuing`;
    let at = t;
    this.push(at, 'cards', ns, rec('incoming request', {
      request_id: cid,
      request: { method: 'POST', path: '/v1/cards/lookup', body: JSON.stringify({ card_tokens: tokens }) },
    }, at, cid));
    tokens.forEach((token, i) => {
      const sid = r.uuid7(at);
      at += r.int(3, 8);
      this.push(at, 'cards', ns, rec('processor call', {
        request_id: cid,
        action: 'getCard',
        payload: [{ bankCode: '01', groupCode: '02', sessionId: sid }, { CARD: token }],
      }, at, cid));
      const reqBody = soap('getCard', `<Session><bankCode>01</bankCode><groupCode>02</groupCode><sessionId>${sid}</sessionId></Session><Parameters><CARD>${token}</CARD></Parameters>`);
      at += r.int(1, 4);
      this.push(at, 'cards', ns, rec('http request sending', { request_id: cid, ...send('POST', url, processorHeaders(reqBody.length), reqBody) }, at, cid));
      at += r.int(40, 400);
      const bad = fail && i === 1;
      const info = bad
        ? '<ResponseInfo><response_code>8</response_code><error_description>PRC-ERR-0027 Card not found</error_description><error_action>REJECT</error_action></ResponseInfo>'
        : `<ResponseInfo><response_code>0</response_code></ResponseInfo><Details><cardNumber>${pans[i]}</cardNumber></Details>`;
      this.push(at, 'cards', ns, rec('http response received', { request_id: cid, ...answer('POST', url, 200, soap('getCardResponse', info)) }, at, cid));
    });
    if (fail) return;
    at += r.int(3, 8);
    const name = r.pick(NAMES);
    this.push(at, 'cards', ns, rec('processor call', {
      request_id: cid,
      action: 'getCardholder',
      payload: [
        { bankCode: '01', groupCode: '02', sessionId: r.uuid7(at) },
        { lookup: 'cardholder', by: 'pan', value: pans[0] },
      ],
    }, at, cid));
    at += r.int(1, 4);
    const rd = soap('getCardholder', `<Lookup><by>pan</by><value>${pans[0]}</value></Lookup>`);
    this.push(at, 'cards', ns, rec('http request sending', { request_id: cid, ...send('POST', url, processorHeaders(rd.length), rd) }, at, cid));
    at += r.int(40, 300);
    this.push(at, 'cards', ns, rec('http response received', {
      request_id: cid,
      ...answer('POST', url, 200, soap('getCardholderResponse', `<ResponseInfo><response_code>0</response_code></ResponseInfo><Row><nameOnCard>${name}</nameOnCard><expiry>${r.int(27, 31)}0${r.int(1, 9)}</expiry></Row>`)),
    }, at, cid));
    at += r.int(3, 8);
    this.push(at, 'cards', ns, rec('processor call', {
      request_id: cid,
      action: 'getBalance',
      payload: [{ primaryAccountNumber: pans[0], accountType: 'DEFAULT', currency: null, returnExponent: false }],
    }, at, cid));
    at += r.int(1, 4);
    const bal = '<?xml version="1.0" encoding="UTF-8"?>\n<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:bal="urn:BalanceService"><SOAP-ENV:Body><bal:getBalance><primaryAccountNumber>' + pans[0] + '</primaryAccountNumber></bal:getBalance></SOAP-ENV:Body></SOAP-ENV:Envelope>\n';
    this.push(at, 'cards', ns, rec('http request sending', {
      request_id: cid, ...send('POST', HOSTS.balance, { ...processorHeaders(bal.length), SOAPAction: ['"urn:BalanceService"'] }, bal),
    }, at, cid));
    at += r.int(40, 250);
    const amount = r.int(0, 25_000_000);
    this.push(at, 'cards', ns, rec('http response received', {
      request_id: cid,
      ...answer('POST', HOSTS.balance, 200, bal.replace('</primaryAccountNumber>', `</primaryAccountNumber><availableAmount>${amount}</availableAmount><bankAccountId>2020${r.digits(16)}</bankAccountId>`)),
    }, at, cid));
  }

  /**
   * api: информация по карте через коммутатор с отказом card2 actionCode 118 в успешном ответе.
   * fixedPan — номер вместо случайного; в список pans не попадает (может не проходить проверку Луна). userId — пользователь вместо случайного.
   */
  apiCardInfo(t: number, ns = 'pay', fixedPan?: string, userId?: string) {
    const r = this.r;
    const cid = r.uuid4();
    const user = userId ?? r.uuid7(t - r.int(1, 90) * DAY);
    const card = r.uuid4();
    const pan = fixedPan ?? this.pan('mastercard');
    const path = `/v1/users/${user}/cards/${card}`;
    const rid = r.uuid4();
    const url = `${HOSTS.switch}/v3/cards/info`;
    let at = t;
    this.gateway(at, ns, 'GET', path, cid, rid);
    at += r.int(2, 20);
    this.push(at, 'api', ns, rec('db query', { step: 'db', duration_ms: r.pick([12, 35, 48, 230, 410]), ctx: DB }, at, cid));
    const id = r.uuid4();
    at += r.int(3, 10);
    this.push(at, 'api', ns, rec('http request sending', {
      request_id: rid,
      ...send('POST', url, { 'Content-Type': ['application/json'], 'User-Agent': ['pay-http/1.0'], Authorization: [`Bearer ${jwt(rid)}`] }, JSON.stringify({ id, params: { primaryAccountNumber: pan } })),
    }, at, cid));
    at += r.int(60, 600);
    const name = r.pick(NAMES);
    const amount = r.int(0, 9_000_000);
    this.push(at, 'api', ns, rec('http response received', {
      request_id: rid,
      ...answer('POST', url, 200, JSON.stringify({
        id,
        result: {
          listSize: 1,
          card: {
            institutionId: 'DEMOBANK', primaryAccountNumber: pan, expiry: `${r.int(27, 31)}0${r.int(1, 9)}`, cardholderId: r.digits(8),
            nameOnCard: name, cardholderPassword: r.pick(CODE_WORDS), additionalInfo: `BRD008${r.digits(8)}IDN002AACBS001${r.int(1, 9)}`,
            statuses: { item: [
              { type: 'card', actionCode: '000', actionDescription: 'Approved' },
              { type: 'card2', actionCode: '118', actionDescription: 'Decline, no card record' },
              { type: 'hot', actionCode: '000', actionDescription: 'Approved' },
            ] },
          },
          account: [{ accountId: r.digits(8), bankAccountId: `3501${r.digits(12)}`, currency: '978', availableAmount: amount, status: 'Active' }],
          balance: { currency: '978', availableAmount: amount, lockedAmount: 0 },
          // Только 07700 900000–900999, их Ofcom держит для вымышленных номеров. Цифр берётся семь, как на целый номер: остальной набор не сдвигается.
          mb: { state: 'on', phone: `+447700900${r.digits(7).slice(-3)}` },
        },
      })),
    }, at, cid));
    this.gin(at + r.int(2, 6), 200, at - t + 4, 'GET', path, ns);
  }

  /** api: подтверждение платежа, платёжное ядро отвечает result = error. */
  apiPaymentLedgerError(t: number, userId?: string) {
    const r = this.r;
    const cid = r.uuid4();
    const user = userId ?? r.uuid7(t - r.int(1, 90) * DAY);
    const payment = r.uuid7(t - r.int(1, 60) * 1000);
    const path = `/v1/users/${user}/payments/${payment}/confirm`;
    const rid = r.uuid4();
    const url = `${HOSTS.ledger}/v1/payments/charge`;
    let at = t;
    this.gateway(at, 'pay', 'POST', path, cid, rid, '{}');
    at += r.int(5, 20);
    this.push(at, 'api', 'pay', rec('http request sending', {
      request_id: rid,
      ...send('POST', url, { 'Content-Type': ['application/json'] }, JSON.stringify({ request_id: payment, sender: { pan: this.pan('maestro') }, amount: r.int(1000, 900_000) * 100, service_id: r.int(100, 999) })),
    }, at, cid));
    at += r.int(200, 1500);
    this.push(at, 'api', 'pay', rec('http response received', {
      request_id: rid,
      ...answer('POST', url, 200, JSON.stringify({ result: 'error', data: null, error: { code: 12, message: 'Insufficient funds on account' } })),
    }, at, cid));
    this.gin(at + 3, 200, at - t + 5, 'POST', path, 'pay');
  }

  /** api: эквайер отвечает HTTP 500, приложение пишет ERROR. */
  apiAcquirer500(t: number, userId?: string) {
    const r = this.r;
    const cid = r.uuid4();
    const user = userId ?? r.uuid7(t - r.int(1, 90) * DAY);
    const path = `/v1/users/${user}/merchant-payments`;
    const qr = JSON.stringify({ qr: `00020101021226${r.digits(20)}` });
    const rid = r.uuid4();
    const url = `${HOSTS.acquirer}/api/payments`;
    let at = t;
    this.gateway(at, 'pay', 'POST', path, cid, rid, qr);
    at += r.int(5, 20);
    this.push(at, 'api', 'pay', rec('http request sending', {
      request_id: rid,
      ...send('POST', url, { Authorization: [`Bearer ${r.hex(40)}`], 'X-Request-Id': [r.uuid7(at)], 'Idempotency-Key': [r.uuid4()], 'Content-Type': ['application/vnd.acquirer.payment+json'] }, JSON.stringify({ partnerTransactionId: r.uuid7(at), amount: r.int(1000, 500_000) * 100 })),
    }, at, cid));
    at += r.int(300, 2500);
    this.push(at, 'api', 'pay', rec('http response received', {
      request_id: rid,
      ...answer('POST', url, 500, JSON.stringify({ type: 'about:blank', title: 'Internal Server Error', status: 500 })),
    }, at, cid));
    at += r.int(1, 4);
    this.push(at, 'api', 'pay', rec('acquirer payment failed', {
      ctx: {
        exception: {
          class: 'UpstreamServerError',
          message: 'Server error: `POST https://api.acquirer.example/api/payments` resulted in a `500 Internal Server Error` response',
          code: 500,
          file: 'src/http/client.ts:113',
        },
      },
    }, at, cid, 400));
    this.gin(at + 3, 500, at - t + 6, 'POST', path, 'pay');
  }

  /** api: проверка мошенничества не ответила. Записи ответа нет, есть ERROR и WARNING. */
  apiFraudTimeout(t: number, userId?: string) {
    const r = this.r;
    const cid = r.uuid4();
    const user = userId ?? r.uuid7(t - r.int(1, 90) * DAY);
    const card = r.uuid4();
    const path = `/v1/users/${user}/cards/${card}/balance`;
    const rid = r.uuid4();
    let at = t;
    this.gateway(at, 'pay', 'GET', path, cid, rid);
    at += r.int(5, 20);
    this.push(at, 'api', 'pay', rec('http request sending', {
      request_id: rid,
      ...send('POST', `${HOSTS.fraud}/`, { 'Content-Type': ['application/json'] }, JSON.stringify({ jsonrpc: '2.0', method: 'risk.check', id: r.int(1, 99999), params: { ids: [r.hex(32)] } })),
    }, at, cid));
    at += 20_001;
    // Адрес — только в тексте исключения: с upstream.url запись разобралась бы как вторая отправка.
    this.push(at, 'api', 'pay', rec('cURL error 28: Operation timed out after 20001 milliseconds with 0 bytes received', {
      request_id: rid,
      ctx: {
        exception: {
          class: 'UpstreamTimeout',
          message: `cURL error 28: Operation timed out after 20001 milliseconds with 0 bytes received for ${HOSTS.fraud}/`,
          code: 28,
        },
      },
    }, at, cid, 400));
    at += 1;
    this.push(at, 'api', 'pay', rec('Circuit breaker opened', { ctx: { service: 'fraud', failures: 5 } }, at, cid, 300));
    this.gin(at + 2, 503, at - t + 3, 'GET', path, 'pay');
  }

  /** api: платёж через платёжное ядро, номер карты в логе уже замаскирован. Успех. */
  apiPaymentMasked(t: number, maskedPan: string, userId?: string) {
    const r = this.r;
    const cid = r.uuid4();
    const user = userId ?? r.uuid7(t - r.int(1, 90) * DAY);
    const payment = r.uuid7(t - r.int(1, 60) * 1000);
    const path = `/v1/users/${user}/payments/${payment}/confirm`;
    const rid = r.uuid4();
    const url = `${HOSTS.ledger}/v1/payments/charge`;
    let at = t;
    this.gateway(at, 'pay', 'POST', path, cid, rid, '{}');
    at += r.int(5, 20);
    this.push(at, 'api', 'pay', rec('http request sending', {
      request_id: rid,
      ...send('POST', url, { 'Content-Type': ['application/json'] }, JSON.stringify({ request_id: payment, sender: { pan: maskedPan }, amount: r.int(1000, 900_000) * 100, service_id: r.int(100, 999) })),
    }, at, cid));
    at += r.int(200, 1500);
    this.push(at, 'api', 'pay', rec('http response received', {
      request_id: rid,
      ...answer('POST', url, 200, JSON.stringify({ result: 'success', data: { request_id: payment, payment_ref: `PR${r.digits(10)}`, stan: r.digits(6) } })),
    }, at, cid));
    this.gin(at + 3, 200, at - t + 5, 'POST', path, 'pay');
  }

  /** api: проверка личности, отказ result_code = BAD при HTTP 200. */
  apiKycBad(t: number, userId?: string) {
    const r = this.r;
    const cid = r.uuid4();
    const user = userId ?? r.uuid7(t - r.int(1, 90) * DAY);
    const path = `/v1/users/${user}/verification`;
    const doc = JSON.stringify({ document: `AB${r.digits(7)}`, birth_date: '1990-04-12' });
    const rid = r.uuid4();
    const url = `${HOSTS.kyc}/v1/verify`;
    let at = t;
    this.gateway(at, 'pay', 'POST', path, cid, rid, doc);
    at += r.int(5, 20);
    this.push(at, 'api', 'pay', rec('http request sending', {
      request_id: rid,
      ...send('POST', url, { 'Content-Type': ['application/json'] }, JSON.stringify({ national_id: r.digits(14), document: `AB${r.digits(7)}`, photo: `${r.hex(24)}...` })),
    }, at, cid));
    at += r.int(800, 3000);
    this.push(at, 'api', 'pay', rec('http response received', {
      request_id: rid,
      ...answer('POST', url, 200, JSON.stringify({ result_code: 'BAD', result_note: 'Face does not match document photo', score: 0.41 })),
    }, at, cid));
    this.gin(at + 3, 200, at - t + 5, 'POST', path, 'pay');
  }

  /** api: отправка в процессинг без ответа за несколько секунд до конца набора: ответ ещё может прийти. */
  apiPendingBalance(t: number) {
    const r = this.r;
    const cid = r.uuid4();
    const user = r.uuid7(t - r.int(1, 90) * DAY);
    const card = r.uuid4();
    const rid = r.uuid4();
    let at = t;
    this.gateway(at, 'pay', 'GET', `/v1/users/${user}/cards/${card}/balance`, cid, rid);
    at += r.int(5, 20);
    const sid = r.uuid7(at);
    const body = soap('queryCardInfo', `<Session><bankCode>01</bankCode><groupCode>02</groupCode><sessionId>${sid}</sessionId></Session><Parameters><CARD_ID>${card}</CARD_ID></Parameters>`);
    this.push(at, 'api', 'pay', rec('http request sending', { request_id: rid, ...send('POST', `${HOSTS.processor}/soap/issuing`, processorHeaders(body.length), body) }, at, cid));
  }

  /**
   * api: комиссия через SOAP-прокси шины. Тела вложены друг в друга, как бывает в логах:
   * в JSON отправки строкой лежит SOAP-конверт, в его теге — JSON, в нём строкой ещё JSON с номером карты
   * (третий уровень вложенности); в ответе — XML с JSON в CDATA.
   */
  apiSoapProxyFee(t: number, user: string) {
    const r = this.r;
    const cid = r.uuid4();
    const transfer = r.uuid7(t - r.int(1, 60) * 1000);
    const path = `/v1/users/${user}/transfers/${transfer}/fee`;
    const rid = r.uuid4();
    const pan = this.pan('maestro');
    let at = t;
    this.gateway(at, 'pay', 'POST', path, cid, rid, JSON.stringify({ amount: 15_000_000, currency: '978' }));
    at += r.int(5, 20);
    const card = JSON.stringify({ number: pan, expiry: `${r.int(27, 31)}0${r.int(1, 9)}` });
    const payload = JSON.stringify({ transferId: transfer, amount: 15_000_000, card });
    const xmlText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const envelope =
      '<?xml version="1.0" encoding="UTF-8"?>\n<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:fs="urn:FeeService">' +
      `<SOAP-ENV:Body><fs:checkFee><sessionID>${r.uuid7(at)}</sessionID><payload>${xmlText(payload)}</payload></fs:checkFee></SOAP-ENV:Body></SOAP-ENV:Envelope>\n`;
    const uri = 'http://esb.pay.example:8280/soap-proxy/FeeService';
    this.push(at, 'api', 'pay', rec('http request sending', {
      request_id: rid,
      ...send('POST', uri, { 'Content-Type': ['application/json'], Authorization: [`Bearer ${jwt(rid)}`] }, JSON.stringify({ service: 'FeeService', operation: 'checkFee', envelope })),
    }, at, cid));
    at += r.int(80, 600);
    const details = JSON.stringify({ fee: { amount: r.int(100, 5000) * 100, currency: '978' }, check_iss_acq_fees: 'confirmed', paymentID: r.digits(12) });
    this.push(at, 'api', 'pay', rec('http response received', {
      request_id: rid,
      ...answer('POST', uri, 200,
        '<?xml version="1.0" encoding="UTF-8"?>\n<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body>' +
        `<fs:checkFeeResponse xmlns:fs="urn:FeeService"><result_code>0</result_code><details><![CDATA[${details}]]></details></fs:checkFeeResponse>` +
        '</soapenv:Body></soapenv:Envelope>\n'),
    }, at, cid));
    this.gin(at + r.int(2, 6), 200, at - t + 4, 'POST', path, 'pay');
  }

  /** Фоновая запись worker без входящего запроса. */
  workerJob(t: number) {
    const cid = String(this.r.int(6_300_000_000_000, 6_399_999_999_999));
    this.push(t, 'worker', 'pay', rec('tokenization callback processed', { request_id: cid, ctx: { status: 'ACTIVE' } }, t, cid));
  }

  /** Строка не JSON и обрезанная строка JSON: обе — записи-текст. */
  noise(t: number) {
    this.push(t, 'api', 'pay', 'PHP Warning:  Undefined array key "pan" in /app/src/Service/CardService.php on line 88');
    this.entries.push({ ms: t + 5, component: 'cards', namespace: 'pay', body: '', rawLine: '{"time":"2026-10-30T11:49:15.495787Z","level":"info","msg":"incoming req' });
  }
}

// ---------- Формы потоков графа и операции ----------
// Все id выдуманы. Справочник имитация не знает: разметку даёт справочник теста или демо.

/** Id сценариев операции: по ним ищут тесты и демо. */
export const MOCK_FLOW = {
  /** Выплата из четырёх потоков: создание, фоновая отправка с опросами, опросы партнёра, колбэк. */
  transfer: '5b0e6c3a-2f4d-4a71-9c8e-1d2f3a4b5c6d',
  /** id выплаты у сети выплат: число JSON в ответе /v3/transfer; те же цифры — в микросекундах времени другой записи. */
  payoutId: '604217',
  /** Платёж с фоновыми попытками: без correlation_id (ветка A) и под исходным correlation_id (ветка B). */
  payment: '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f',
  /** Платёж на тесте: подтверждение и крон, который вызывает платёжное ядро с id платежа. */
  testPayment: '8d2e3f4a-5b6c-4d7e-9f8a-0b1c2d3e4f5a',
  installments: ['inst-20261101-0001', 'inst-20261101-0002', 'inst-20261101-0003'],
  /** Платёж с опросами: создание, 40 опросов партнёра, подтверждение. */
  polledPayment: '9e3f4a5b-6c7d-4e8f-a0b1-2c3d4e5f6a7b',
  /** Под воркера без correlation_id. */
  nocidPod: 'pay-app-worker-5f7c9d8b6a-qx2lm',
  /** Перевод с отказом платёжного ядра по коду справочника, следующий запрос несёт только обёртку, колбэк заявляет отказ. */
  failedTransfer: 'a1f0c2d3-6b7e-4c8d-9e0f-1a2b3c4d5e6f',
  /** Платёж с ошибкой, которой нет в справочнике, и телефоном в её тексте. */
  undescribedPayment: 'b2a1d3e4-7c8f-4d9e-8f1a-2b3c4d5e6f7a',
  /** Выплата: первый опрос упал, второй показал «Выполнен». */
  retriedPayout: '7710042',
  /** Выплата без ошибок. */
  plainPayout: '7710043',
} as const;

/**
 * Ответы страницей HTML: значения и страницы выдуманы. Хост вне pay.example и вход без шлюза: поиски других наборов этот запрос не находят.
 * В первой странице телефон: на экране маска, показ открывает его и там. Вторая страница враждебная: всё активное и внешнее ведёт на hostile.example.
 */
export const MOCK_HTML = {
  cid: 'd3e4f5a6-7b8c-4d9e-a0b1-2c3d4e5f6a7b',
  host: 'https://cardhub.example.test',
  card: '555555******0178',
  phone: '+447700900178',
  /** Номера во второй странице: группами в тегах и цифрами в сущностях. Браузер собрал бы их обратно, маска должна видеть то же. */
  splitCard: '5555550000051021',
  entityCard: '5555550000051039',
  gatewayPage: (phone: string) => `<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body>\r\n<center><h1>502 Bad Gateway</h1></center>\r\n<p>Client ${phone}</p>\r\n<hr><center>edge-proxy</center>\r\n</body>\r\n</html>\r\n`,
  hostilePage: [
    '<!DOCTYPE html><html><head><title>Service Unavailable</title>',
    '<meta http-equiv="refresh" content="0;url=https://hostile.example/refresh">',
    '<link rel="stylesheet" href="https://hostile.example/style.css"><base href="https://hostile.example/">',
    '<script>window.top.location = "https://hostile.example/script";</script>',
    '<style>@import url("https://hostile.example/import.css"); h1 { color: #b42318; background: url(https://hostile.example/bg.png); }</style>',
    '</head><body onload="window.top.location = \'https://hostile.example/onload\'">',
    '<h1 style="background-image: url(https://hostile.example/inline.png)">Service Unavailable</h1>',
    '<p onclick="alert(1)">The upstream is down. <a href="https://hostile.example/link" target="_blank">Details</a> <a href="javascript:alert(1)">More</a></p>',
    '<p>Split <b>5555</b><b>5500</b><b>0005</b><b>1021</b>, written &#53;&#53;&#53;&#53;&#53;&#53;&#48;&#48;&#48;&#48;&#48;&#53;&#49;&#48;&#51;&#57;</p>',
    '<img src="https://hostile.example/pixel.png" onerror="alert(1)"><iframe src="https://hostile.example/frame"></iframe>',
    '<object data="https://hostile.example/object"></object><embed src="https://hostile.example/embed">',
    '<form action="https://hostile.example/post" method="post"><input name="x" value="1"><button>Send</button></form>',
    '<svg onload="alert(1)"><image href="https://hostile.example/svg.png"/></svg>',
    '</body></html>',
  ].join(''),
  /** Страница больше предела показа. */
  bigPage: (size: number) => `<html><head><title>Huge report</title></head><body>${'<p>row</p>'.repeat(Math.ceil(size / 10))}</body></html>`,
} as const;

/** Телефон в тексте ошибки undescribedPayment: на странице операции только маской. */
export const MOCK_SUMMARY_PHONE = '+447700900177';

const PAYOUT_HOST = 'https://payout.pay.example:9443';

/** Значения всех видов маски у одного клиента: значения выдуманы, тесты ищут их в ответах. */
export const MOCK_PERSONAL = {
  cid: 'c1d2e3f4-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
  /** Международный номер без плюса: телефон по плану номеров демо-проекта. */
  phone: '447700900101',
  phone2: '+447700900102',
  address: '7 Synthetic Street',
  passport: 'ZZ0000101',
  passportNumber: '7305102',
  nationalId: 'ZZ000101A',
  surname: 'Testerson',
  fullName: 'Testerson Tess Quinn',
  holder: 'TESS TESTERSON',
  expiry: '3101',
  additionalInfo: 'BRD00800000101',
  pan: '5555550001470101',
  password: 'synthetic-pass-0101',
  account: '20208000900123456101',
  accountId: '36999101',
  bankAccountId: '3501112344650101',
  cardToken: '400000SYNTHA0101',
  firstName: 'Tess',
  middleName: 'Quinn',
  birthday: '1990-01-01',
  email: 'test@example.com',
  accountRequestId: 'c1d2e3f4-5a6b-4c7d-8e9f-0a1b2c3d0101',
} as const;

/** Один выдуманный телефон во всех написаниях: на написание — свой запрос. */
export const MOCK_PHONE = {
  value: '447700900001',
  spellings: ['447700900001', '+447700900001', '%2B447700900001', '7700900001', '07700900001', '+44 (7700) 900-001', '7700-900-001', '07700 900001'],
  cid: (i: number) => `phone-spelling-${i}`,
} as const;

class FlowBuilder extends Builder {
  /** Запись приложения; cid = null — без correlation_id. */
  app(ms: number, component: Component, ns: string, msg: string, fields: Fields, cid: string | null, o: { level?: number; labels?: Record<string, string> } = {}) {
    this.entries.push({ ms, component, namespace: ns, body: rec(msg, fields, ms, cid, o.level ?? 200), ...(o.labels ? { labels: o.labels } : {}) });
  }

  /** Отправка и ответ JSON; resp = null — ответа нет. */
  json(at: number, component: Component, ns: string, cid: string | null, rid: string, uri: string, body: unknown, resp: { ms: number; status: number; body: unknown } | null, o: { labels?: Record<string, string>; method?: string } = {}) {
    const method = o.method ?? 'POST';
    this.app(at, component, ns, 'http request sending', { request_id: rid, ...send(method, uri, { 'Content-Type': ['application/json'] }, JSON.stringify(body)) }, cid, o);
    if (!resp) return;
    this.app(at + resp.ms, component, ns, 'http response received', { request_id: rid, ...answer(method, uri, resp.status, JSON.stringify(resp.body)) }, cid, o);
  }

  /** Вход сервиса карт: сервис пишет вход сам. */
  cardsIn(at: number, method: string, path: string, cid: string, body: unknown = null, ns = 'pay') {
    this.app(at, 'cards', ns, 'incoming request', {
      request_id: cid,
      request: { method, path, ...(body === null ? {} : { body: JSON.stringify(body) }) },
    }, cid);
  }

  /** Запись запроса к базе: шаг графа с длительностью. */
  db(at: number, component: Component, cid: string, ms: number) {
    this.app(at, component, 'pay', 'db query', { step: 'db', duration_ms: ms, ctx: DB }, cid);
  }

  /** Запросы с телефоном в разных написаниях: в теле и в строке запроса, если написание уже закодировано. */
  phoneSpellings(anchorMs: number) {
    MOCK_PHONE.spellings.forEach((phone, i) => this.phoneContact(anchorMs - (i + 1) * 35 * 60_000, phone, MOCK_PHONE.cid(i)));
  }

  /** Сервис карт: обновление контакта с телефоном в теле или, если написание уже закодировано, в строке запроса. */
  phoneContact(t: number, phone: string, cid: string) {
    if (phone.startsWith('%')) this.cardsIn(t, 'GET', `/v1/customers/contacts?phone=${phone}`, cid);
    else this.cardsIn(t, 'POST', '/v1/customers/contacts', cid, { phone });
    this.app(t + 5, 'cards', 'pay', 'contacts updated', { ctx: { result: 'ok' } }, cid);
  }

  /** Операции блока «Что случилось»: без них запрос с ошибкой есть только в операции на несколько рассрочек. */
  operationSummaries(anchorMs: number) {
    const r = this.r;
    const ago = (h: number, m: number) => anchorMs - (h * 60 + m) * 60_000;
    const worker = () => String(r.int(7_400_000_000_000, 7_499_999_999_999));

    const tr = MOCK_FLOW.failedTransfer;
    const t = ago(18, 10);
    const create = r.uuid4();
    const rid = r.uuid4();
    const hold = { request_id: tr, amount: 900_000 };
    this.gateway(t, 'pay', 'POST', `/v1/users/${r.uuid7(t - 30 * DAY)}/transfers`, create, rid, JSON.stringify({ amount: 900_000, currency: 'EUR' }));
    this.json(t + 15, 'api', 'pay', create, rid, `${HOSTS.ledger}/v1/transfers/hold`, hold, { ms: 210, status: 422, body: { result: 'error', data: null, error: { code: 12, message: 'Insufficient funds on account' } } });
    const wrapper = worker();
    this.json(t + 30_000, 'worker', 'pay', wrapper, wrapper, `${HOSTS.ledger}/v1/transfers/hold`, hold, { ms: 120, status: 500, body: { result: 'error', data: null, error: { code: 99, message: 'Transfer processing failed' } } });
    this.cardsIn(t + 60_000, 'POST', '/internal/callbacks/payout', worker(), { ext_transfer_id: tr, state: 'error' });

    const p = MOCK_FLOW.undescribedPayment;
    const u = ago(18, 40);
    const pay = r.uuid4();
    const payRid = r.uuid4();
    this.gateway(u, 'pay', 'POST', `/v1/users/${r.uuid7(u - 30 * DAY)}/payments`, pay, payRid, JSON.stringify({ service_id: 512, amount: 700_000 }));
    this.json(u + 12, 'api', 'pay', pay, payRid, `${HOSTS.ledger}/v1/payments/hold`, { request_id: p, amount: 700_000 }, { ms: 190, status: 500, body: { result: 'error', data: null, error: { code: 77, message: `Gateway refused client ${MOCK_SUMMARY_PHONE}` } } });

    const info = `${PAYOUT_HOST}/v1/transfer_info`;
    const v = ago(19, 10);
    const first = worker();
    const second = worker();
    this.json(v, 'worker', 'pay', first, first, info, { transfer_id: Number(MOCK_FLOW.retriedPayout) }, { ms: 90, status: 500, body: { status: 'error', error: { code: 55, message: 'Temporarily unavailable' } } });
    this.json(v + 60_000, 'worker', 'pay', second, second, info, { transfer_id: Number(MOCK_FLOW.retriedPayout) }, { ms: 90, status: 200, body: { status: 'ok', data: { transfer_data: { state: 'completed' } } } });

    const ok = worker();
    this.json(ago(19, 40), 'worker', 'pay', ok, ok, info, { transfer_id: Number(MOCK_FLOW.plainPayout) }, { ms: 90, status: 200, body: { status: 'ok', data: { transfer_data: { state: 'completed' } } } });
  }

  /** Вызовы, на которые шлюз ответил страницей HTML: строка JSON со страницей, тело целиком, большая страница, запись приложения со страницей в сообщении. */
  htmlErrors(anchorMs: number) {
    const t = anchorMs - 20 * 60 * 60_000 - 10 * 60_000;
    const { cid, host, card, phone } = MOCK_HTML;
    const ns = 'pay';
    const json = { 'Content-Type': ['application/json'] };
    this.cardsIn(t, 'POST', '/v1/cards/withdrawals', cid, { amount: 150_000 });
    this.json(t + 10, 'cards', ns, cid, cid, `${host}/v2/withdraw`, { amount: 150_000 }, {
      ms: 120,
      status: 200,
      body: { data: null, result: 'error', error: { code: 15, message: `Failed to withdraw from card ${card}. HttpStatusCode = BadGateway for Content: ${MOCK_HTML.gatewayPage(phone)}` } },
    });
    this.app(t + 200, 'cards', ns, 'http request sending', { request_id: cid, ...send('POST', `${host}/v2/reverse`, json, '{"amount":150000}') }, cid);
    this.app(t + 280, 'cards', ns, 'http response received', { request_id: cid, ...answer('POST', `${host}/v2/reverse`, 503, MOCK_HTML.hostilePage) }, cid);
    this.app(t + 300, 'cards', ns, 'http request sending', { request_id: cid, ...send('POST', `${host}/v2/report`, json, '{"amount":150000}') }, cid);
    this.app(t + 380, 'cards', ns, 'http response received', { request_id: cid, ...answer('POST', `${host}/v2/report`, 500, MOCK_HTML.bigPage(300 * 1024)) }, cid);
    this.app(t + 400, 'cards', ns, `Upstream answered with a page: ${MOCK_HTML.gatewayPage(phone)}`, { request_id: cid }, cid, { level: 400 });
  }

  /** Запрос со всеми видами маски на всех уровнях экранирования. */
  personalData(t: number) {
    const v = MOCK_PERSONAL;
    const ns = 'pay';
    const core = 'http://core.pay.example:8080';
    this.cardsIn(t, 'POST', `/v1/customers/${v.cid}/contacts/${v.phone}?address=${encodeURIComponent(v.address)}&y=2`, v.cid, { phone: v.phone2 });
    this.json(t + 5, 'cards', ns, v.cid, this.r.uuid7(t + 5), `${core}/createCustomer`, {
      phone: v.phone,
      home_phone: v.phone2,
      address: v.address,
      region_code: '26',
      passport_series: 'ZZ',
      passport_number: v.passportNumber,
      national_id: v.nationalId,
      tax_id: v.nationalId,
      last_name: v.surname,
      full_name: v.fullName,
      first_name: v.firstName,
      birth_date: v.birthday,
      email: v.email,
      document: v.passport,
    }, {
      ms: 20,
      status: 200,
      body: {
        data: JSON.stringify({ national_id: v.nationalId, phones: [v.phone, v.phone2] }),
        nameOnCard: v.holder,
        expiry: v.expiry,
        additionalInfo: v.additionalInfo,
        primaryAccountNumber: v.pan,
        last_name: v.surname,
        address: { city: 'Sampletown', street: v.address },
      },
    });
    this.app(t + 30, 'cards', ns, 'http request sending', {
      request_id: this.r.uuid7(t + 30),
      ...send('POST', `${core}/form`, { 'X-Phone': [v.phone] }, `phone=${v.phone}&amount=100&address=${encodeURIComponent(v.address)}`),
    }, v.cid);
    this.app(t + 40, 'cards', ns, 'http response received', {
      request_id: this.r.uuid7(t + 40),
      ...answer('POST', `${core}/soap`, 200, `<ns2:customer><ns2:passport_number>${v.passportNumber}</ns2:passport_number><nameOnCard>${v.holder}</nameOnCard><expiry><![CDATA[${v.expiry}]]></expiry></ns2:customer>`),
    }, v.cid);
    this.app(t + 50, 'cards', ns, `Customer +${v.phone} not found, passport ${v.passport}, national id ${v.nationalId}`, { ctx: { full_name: v.fullName, passport: v.passport } }, v.cid, { level: 400 });
    // Идентификатор запроса постоянный: последовательность случайных значений других сценариев не сдвигается.
    this.json(t + 60, 'cards', ns, v.cid, v.accountRequestId, `${core}/v1/accounts/${v.account}/00444`, {
      accountId: v.accountId,
      bankAccountId: v.bankAccountId,
      card_tokens: [v.cardToken],
      middle_name: v.middleName,
      password: v.password,
      primaryAccountNumber: v.pan,
    }, { ms: 15, status: 200, body: { account: [{ accountId: v.accountId, availableAmount: '100' }], primaryAccountNumber: v.pan } });
  }

  /** Параллельные обмены по картам: процессинг ∥ коммутатор, затем платёжное ядро. */
  parallelCards(t: number) {
    const r = this.r;
    const cid = String(r.int(6_400_000_000_000, 6_499_999_999_999));
    const pan = this.pan('visa');
    this.cardsIn(t, 'POST', '/v1/cards/lookup', cid, { card_tokens: [this.token(pan)] });
    const sid = r.uuid7(t);
    const processor = soap('getCard', `<Session><bankCode>01</bankCode><sessionId>${sid}</sessionId></Session><Parameters><CARD>${this.token(pan)}</CARD></Parameters>`);
    const issuing = `${HOSTS.processor}/soap/issuing`;
    const card = `${HOSTS.switch}/v3/cards/info`;
    this.app(t + 4, 'cards', 'pay', 'http request sending', { request_id: cid, ...send('POST', issuing, processorHeaders(processor.length), processor) }, cid);
    this.app(t + 7, 'cards', 'pay', 'http request sending', {
      request_id: cid, ...send('POST', card, { 'Content-Type': ['application/json'] }, JSON.stringify({ id: r.uuid4(), params: { primaryAccountNumber: this.pan('mastercard') } })),
    }, cid);
    this.app(t + 61, 'cards', 'pay', 'http response received', { request_id: cid, ...answer('POST', card, 200, JSON.stringify({ result: { card: { status: 'Active' } } })) }, cid);
    this.app(t + 182, 'cards', 'pay', 'http response received', {
      request_id: cid, ...answer('POST', issuing, 200, soap('getCardResponse', `<ResponseInfo><response_code>0</response_code></ResponseInfo><Details><cardNumber>${pan}</cardNumber></Details>`)),
    }, cid);
    this.json(t + 200, 'cards', 'pay', cid, cid, `${HOSTS.ledger}/v1/cards/limits`, { card: this.token(pan) }, { ms: 38, status: 200, body: { result: 'ok' } });
  }

  /** Параллельные карты с записями вызова: «вызов, вызов, отправка, отправка», обмены перекрываются. */
  parallelCalls(t: number) {
    const r = this.r;
    const cid = String(r.int(6_600_000_000_000, 6_699_999_999_999));
    const [a, b] = [this.token(this.pan('visa')), this.token(this.pan('visa'))];
    const issuing = `${HOSTS.processor}/soap/issuing`;
    this.cardsIn(t, 'POST', '/v1/cards/lookup', cid, { card_tokens: [a, b], batch: 'parallel-lookup' });
    this.app(t + 5, 'cards', 'pay', 'processor call', { request_id: cid, action: 'getCard', payload: [{ CARD: a }] }, cid);
    this.app(t + 6, 'cards', 'pay', 'processor call', { request_id: cid, action: 'getCard', payload: [{ CARD: b }] }, cid);
    for (const [at, card] of [[t + 10, a], [t + 20, b]] as const) {
      const body = soap('getCard', `<Parameters><CARD>${card}</CARD></Parameters>`);
      this.app(at, 'cards', 'pay', 'http request sending', { request_id: cid, ...send('POST', issuing, processorHeaders(body.length), body) }, cid);
    }
    for (const at of [t + 250, t + 300]) {
      this.app(at, 'cards', 'pay', 'http response received', { request_id: cid, ...answer('POST', issuing, 200, soap('getCardResponse', '<ResponseInfo><response_code>0</response_code></ResponseInfo>')) }, cid);
    }
  }

  /** Сервис карт: вызов процессинга без ответа, затем отправка в проверку мошенничества с тем же request_id. */
  processorThenFraud(t: number) {
    const r = this.r;
    const cid = String(r.int(6_500_000_000_000, 6_599_999_999_999));
    const token = this.token(this.pan('visa'));
    this.cardsIn(t, 'POST', '/v1/cards/lookup', cid, { card_tokens: [token] });
    this.app(t + 5, 'cards', 'pay', 'processor call', { request_id: cid, action: 'getCard', payload: [{ CARD: token }] }, cid);
    const body = soap('getCard', `<Parameters><CARD>${token}</CARD></Parameters>`);
    this.app(t + 8, 'cards', 'pay', 'http request sending', { request_id: cid, ...send('POST', `${HOSTS.processor}/soap/issuing`, processorHeaders(body.length), body) }, cid);
    this.json(t + 30_100, 'cards', 'pay', cid, cid, `${HOSTS.fraud}/`, { jsonrpc: '2.0', method: 'risk.check', id: r.int(1, 9999), params: { ids: [r.digits(10)] } }, { ms: 140, status: 200, body: { jsonrpc: '2.0', result: { cards: [] } } });
  }

  /** api: подтверждение платежа, две попытки платёжного ядра без ответа с паузами, третья успешна. */
  ledgerRetries(t: number) {
    const r = this.r;
    const cid = r.uuid4();
    const rid = r.uuid4();
    const payment = r.uuid4();
    const path = `/v1/users/${r.uuid7(t - 20 * DAY)}/payments/${payment}/confirm`;
    const confirm = `${HOSTS.ledger}/v1/payments/confirm`;
    this.gateway(t, 'pay', 'POST', path, cid, rid, '{}');
    const body = { request_id: payment, amount: r.int(1000, 90_000) * 100 };
    this.json(t + 12, 'api', 'pay', cid, rid, confirm, body, null);
    this.app(t + 5_020, 'api', 'pay', 'ledger timeout, retrying', { ctx: { attempt: 1 } }, cid, { level: 300 });
    this.json(t + 7_030, 'api', 'pay', cid, rid, confirm, body, null);
    this.app(t + 12_040, 'api', 'pay', 'ledger timeout, retrying', { ctx: { attempt: 2 } }, cid, { level: 300 });
    this.json(t + 16_050, 'api', 'pay', cid, rid, confirm, body, { ms: 420, status: 200, body: { result: 'ok', data: { status: 'confirmed' } } });
  }

  /**
   * Выплата из четырёх потоков: создание (api через шлюз), фоновая отправка в сеть выплат с опросами
   * transfer_info (worker), опросы партнёра (сервис карт, id только во входящем GET), колбэк (сервис карт).
   * Колбэк приходит на 300 мс раньше ответа сети выплат на /v3/transfer.
   */
  payoutTransfer(t: number) {
    const r = this.r;
    const user = r.uuid7(t - 30 * DAY);
    const tr = MOCK_FLOW.transfer;
    const payout = Number(MOCK_FLOW.payoutId);
    const create = r.uuid4();
    const rid = r.uuid4();
    this.gateway(t, 'pay', 'POST', `/v1/users/${user}/transfers`, create, rid, JSON.stringify({ amount: 1_500_000, currency: 'EUR' }));
    this.db(t + 9, 'api', create, 21);
    this.json(t + 15, 'api', 'pay', create, rid, `${HOSTS.ledger}/v1/transfers/hold`, { request_id: tr, amount: 1_500_000 }, { ms: 310, status: 200, body: { result: 'ok', data: { status: 'held' } } });

    // Фоновая отправка: свой correlation_id, входа нет.
    const w = String(r.int(6_600_000_000_000, 6_699_999_999_999));
    const sent = t + 40_000;
    this.json(sent, 'worker', 'pay', w, w, `${PAYOUT_HOST}/v3/transfer`, { document_id: tr, amount: 1_500_000, recipient: { pan: this.pan('visa') } }, { ms: 2_000, status: 200, body: { status: 'ok', data: { transfer_id: payout, state: 'created' } } });
    const states = ['processing', 'processing', 'processing', 'processing', 'failed'];
    states.forEach((state, i) => {
      const at = sent + 3_000 + i * 1_000;
      this.json(at, 'worker', 'pay', w, w, `${PAYOUT_HOST}/v1/transfer_info`, { transfer_id: payout }, { ms: 90, status: 200, body: { status: 'ok', data: { transfer_data: state === 'failed' ? { state, resolution: 'Recipient card is blocked' } : { state } } } });
    });

    // Колбэк сети выплат в сервис карт: на 300 мс раньше ответа на /v3/transfer.
    const cb = String(r.int(6_700_000_000_000, 6_799_999_999_999));
    this.cardsIn(sent + 1_700, 'POST', '/internal/callbacks/payout', cb, { ext_transfer_id: tr, state: 'error' });
    this.app(sent + 1_720, 'cards', 'pay', 'callback accepted', { ctx: { ext_transfer_id: tr } }, cb);

    // Опросы партнёра: id только во входящем GET, статус в лог не пишется.
    for (let i = 0; i < 6; i++) {
      const at = t + 60_000 + i * 8 * 60_000;
      const c = String(r.int(6_800_000_000_000, 6_899_999_999_999));
      this.cardsIn(at, 'GET', `/v1/users/${user}/transfers/${tr}`, c);
      this.db(at + 4, 'cards', c, 3);
    }
  }

  /** Те же цифры, что у id выплаты, — в микросекундах времени чужой записи. */
  digitsInDatetime(t: number) {
    const v = MOCK_FLOW.payoutId;
    const ms = Math.floor(t / 1000) * 1000 + Number(v.slice(0, 3)) + Number(v.slice(3)) / 1000;
    const cid = String(this.r.int(6_900_000_000_000, 6_999_999_999_999));
    this.app(ms, 'worker', 'pay', 'tokenization callback processed', { request_id: cid, ctx: { status: 'ACTIVE' } }, cid);
  }

  /**
   * Платёж с фоновыми попытками. Ветка A: воркер вызывает платёжное ядро с id платежа без correlation_id, два запуска
   * с паузой больше 30 с. Ветка B: подтверждение и две попытки под исходным correlation_id раз в 5 минут.
   */
  paymentRetries(t: number) {
    const r = this.r;
    const p = MOCK_FLOW.payment;
    const pod = { pod: MOCK_FLOW.nocidPod };
    // Ветка A: холд без correlation_id.
    for (const at of [t, t + 45_000]) {
      this.json(at, 'worker', 'pay', null, p, `${HOSTS.ledger}/v1/payments/hold`, { request_id: p, sender: { pan: this.pan('maestro') } }, { ms: 260, status: 200, body: { result: 'ok', data: { status: 'held' } } }, { labels: pod });
    }
    // Ветка B: подтверждение и повторные попытки под тем же correlation_id.
    const cid = r.uuid4();
    const rid = r.uuid4();
    const c0 = t + 3 * 60_000;
    const confirm = `${HOSTS.ledger}/v1/payments/confirm`;
    this.gateway(c0, 'pay', 'POST', `/v1/users/${r.uuid7(t - 50 * DAY)}/payments/${p}/confirm`, cid, rid, '{}');
    const body = { request_id: p };
    this.json(c0 + 14, 'api', 'pay', cid, rid, confirm, body, { ms: 380, status: 500, body: { result: 'error', error: { code: 99, message: 'Processing temporarily unavailable' } } });
    this.json(c0 + 5 * 60_000, 'worker', 'pay', cid, rid, confirm, body, { ms: 300, status: 500, body: { result: 'error', error: { code: 99, message: 'Processing temporarily unavailable' } } });
    this.json(c0 + 10 * 60_000, 'worker', 'pay', cid, rid, confirm, body, { ms: 280, status: 200, body: { result: 'ok', data: { status: 'confirmed' } } });
  }

  /** Тест: подтверждение платежа и крон без входа, который вызывает платёжное ядро с id платежа в request_id. */
  cronOnTest(t: number) {
    const r = this.r;
    const p = MOCK_FLOW.testPayment;
    const cid = r.uuid4();
    const rid = r.uuid4();
    this.gateway(t, 'pay-test', 'POST', `/v1/users/${r.uuid7(t - 10 * DAY)}/payments/${p}/confirm`, cid, rid, '{}');
    this.json(t + 11, 'api', 'pay-test', cid, rid, `${HOSTS.ledger}/v1/payments/confirm`, { request_id: p }, { ms: 240, status: 200, body: { result: 'ok', data: { status: 'confirming' } } });
    const cron = String(r.int(7_000_000_000_000, 7_099_999_999_999));
    const sub = { app_kubernetes_io_sub_service: 'cron' };
    this.json(t + 4 * 60_000, 'cron', 'pay-test', cron, cron, `${HOSTS.ledger}/v1/payments/status`, { request_id: p }, { ms: 120, status: 200, body: { result: 'ok', data: { status: 'confirmed' } } }, { labels: sub });
  }

  /** Задание по трём рассрочкам, вторая с ошибкой платёжного ядра. */
  installmentJob(t: number) {
    const cid = String(this.r.int(7_100_000_000_000, 7_199_999_999_999));
    MOCK_FLOW.installments.forEach((inst, i) => {
      const bad = i === 1;
      this.json(t + i * 900, 'worker', 'pay', cid, cid, `${HOSTS.ledger}/v1/installments/charge`, { request_id: inst, amount: 250_000 }, {
        ms: 200,
        status: bad ? 422 : 200,
        body: bad ? { result: 'error', error: { code: 51, message: 'Insufficient funds on account' } } : { result: 'ok', data: { status: 'charged' } },
      });
    });
  }

  /** Поток из 250 обменов, 50 из них с ошибкой трёх видов. */
  longFlow(t: number) {
    const r = this.r;
    const cid = String(r.int(7_200_000_000_000, 7_299_999_999_999));
    this.cardsIn(t, 'POST', '/v1/cards/sync', cid);
    const hosts = [HOSTS.ledger, HOSTS.switch, HOSTS.fraud, HOSTS.kyc, `${PAYOUT_HOST}`];
    for (let i = 0; i < 250; i++) {
      const err = i % 5 === 2 ? [500, 502, 503][Math.floor(i / 5) % 3]! : null;
      const at = t + 10 + i * 30;
      this.json(at, 'cards', 'pay', cid, cid, `${hosts[i % hosts.length]}/sync/item/${i % 7}`, { n: i }, { ms: 20, status: err ?? 200, body: err ? { error: { code: err, message: `Upstream failure ${err}` } } : { result: 'ok' } });
    }
  }

  /** Платёж с опросами: создание с холдом, 40 опросов партнёра раз в 3 минуты, подтверждение. */
  polledPayment(t: number) {
    const r = this.r;
    const p = MOCK_FLOW.polledPayment;
    const user = r.uuid7(t - 60 * DAY);
    const create = r.uuid4();
    const rid = r.uuid4();
    this.gateway(t, 'pay', 'POST', `/v1/users/${user}/payments`, create, rid, JSON.stringify({ service_id: 512, amount: 4_200_000 }));
    this.json(t + 12, 'api', 'pay', create, rid, `${HOSTS.ledger}/v1/payments/hold`, { request_id: p, sender: { pan: this.pan('maestro') } }, { ms: 290, status: 200, body: { result: 'ok', data: { status: 'held' } } });
    for (let i = 0; i < 40; i++) {
      const at = t + 60_000 + i * 3 * 60_000;
      const c = String(r.int(7_300_000_000_000, 7_399_999_999_999));
      this.cardsIn(at, 'GET', `/v1/users/${user}/payments/${p}`, c);
      this.db(at + 3, 'cards', c, 2);
    }
    const confirm = r.uuid4();
    const rid2 = r.uuid4();
    const c0 = t + 125 * 60_000;
    this.gateway(c0, 'pay', 'POST', `/v1/users/${user}/payments/${p}/confirm`, confirm, rid2, '{}');
    this.json(c0 + 10, 'api', 'pay', confirm, rid2, `${HOSTS.ledger}/v1/payments/confirm`, { request_id: p }, { ms: 330, status: 200, body: { result: 'ok', data: { status: 'confirmed' } } });
  }

  all(anchorMs: number) {
    const ago = (h: number, m: number) => anchorMs - (h * 60 + m) * 60_000;
    this.parallelCards(ago(7, 10));
    this.processorThenFraud(ago(7, 40));
    this.ledgerRetries(ago(8, 5));
    this.payoutTransfer(ago(9, 0));
    this.digitsInDatetime(ago(9, 20));
    this.paymentRetries(ago(10, 30));
    this.cronOnTest(ago(11, 0));
    this.installmentJob(ago(12, 0));
    this.longFlow(ago(13, 0));
    this.polledPayment(ago(16, 0));
    this.parallelCalls(ago(16, 30));
    this.personalData(ago(17, 0));
  }
}

/** Набор Demo Pay: содержимое одинаково при каждом запуске, время лежит в последних 24 часах от anchorMs. */
export function generatePayDataset(anchorMs: number, opts: { flowScenarios?: boolean } = {}): { records: MockRecord[]; pans: string[] } {
  const r = rng(20261030);
  const b = new Builder(r);
  const at = (hoursAgo: number) => anchorMs - hoursAgo * 60 * 60 * 1000 - r.int(60_000, 50 * 60 * 1000);

  for (let h = 23; h >= 0; h--) {
    const kind = h % 6;
    if (kind === 0) b.cardsLookup(at(h), false);
    if (kind === 1) b.apiCardInfo(at(h));
    if (kind === 2) b.apiPaymentLedgerError(at(h));
    if (kind === 3) b.cardsLookup(at(h), true);
    if (kind === 4) b.apiAcquirer500(at(h));
    if (kind === 5) b.apiFraudTimeout(at(h));
    if (h % 4 === 0) b.workerJob(at(h));
    if (h % 8 === 0) b.apiCardInfo(at(h));
  }
  b.noise(at(2));
  b.apiCardInfo(at(3), 'pay-test');
  b.cardsLookup(at(5), false, 'pay-test');
  b.apiCardInfo(at(1), 'pay-pr-92');
  b.apiCardInfo(at(6), 'pay-pr-105');

  // Особые случаи поиска — своим генератором: записи выше от них не меняются.
  const sr = rng(20261102);
  const s = new Builder(sr);
  const ago = (h: number, m: number, sec = 0) => anchorMs - ((h * 60 + m) * 60 + sec) * 1000;
  s.apiCardInfo(ago(2, 17), 'pay', MOCK_SPECIAL.nonLuhnPan);
  s.cardsLookup(ago(1, 33), false, 'pay', MOCK_SPECIAL.exactPan);
  s.cardsLookup(ago(4, 41), true, 'pay', MOCK_SPECIAL.exactPan);
  s.cardsLookup(ago(2, 52), false, 'pay', MOCK_SPECIAL.twinPan);
  s.apiPaymentMasked(ago(3, 26), MOCK_SPECIAL.maskedPan);
  s.apiKycBad(ago(0, 47));
  s.apiPendingBalance(ago(0, 0, 15));
  s.apiSoapProxyFee(ago(1, 12), MOCK_SPECIAL.gatewayUserId);

  // Формы потоков графа и операции — своим генератором: записи выше от них не меняются.
  const fr = rng(20261103);
  const f = new FlowBuilder(fr);
  if (opts.flowScenarios !== false) f.all(anchorMs);

  // Телефон в разных написаниях — своим генератором, эталон прежних сценариев его не содержит.
  const pr = rng(20261104);
  const ph = new FlowBuilder(pr);
  if (opts.flowScenarios !== false) ph.phoneSpellings(anchorMs);

  // Операции блока «Что случилось» — своим генератором, записи выше от них не меняются.
  const or = rng(20261106);
  const os = new FlowBuilder(or);
  if (opts.flowScenarios !== false) os.operationSummaries(anchorMs);

  // Ответы страницей HTML — своим генератором, записи выше от них не меняются.
  const hr = rng(20261107);
  const hs = new FlowBuilder(hr);
  if (opts.flowScenarios !== false) hs.htmlErrors(anchorMs);

  // Клиент первого примера демо-среды: кроме запроса через шлюз, успешный запрос и два отказа, как у постоянного клиента
  // живого потока быстрого старта. Раньше запроса через шлюз: в поиске он остаётся первым. Своим генератором.
  const ur = rng(20261113);
  const us = new Builder(ur);
  if (opts.flowScenarios !== false) {
    us.apiCardInfo(ago(2, 38), 'pay', undefined, MOCK_SPECIAL.gatewayUserId);
    us.apiPaymentLedgerError(ago(4, 5), MOCK_SPECIAL.gatewayUserId);
    us.apiKycBad(ago(7, 50), MOCK_SPECIAL.gatewayUserId);
  }

  const records = [
    ...toRecords(b.entries, anchorMs, r),
    ...toRecords(s.entries, anchorMs, sr),
    ...toRecords(f.entries, anchorMs, fr),
    ...toRecords(ph.entries, anchorMs, pr),
    ...toRecords(os.entries, anchorMs, or),
    ...toRecords(hs.entries, anchorMs, hr),
    ...toRecords(us.entries, anchorMs, ur),
  ].sort((x, y) => (x.tsNs < y.tsNs ? -1 : x.tsNs > y.tsNs ? 1 : 0));
  return { records, pans: [...b.pans, ...s.pans, ...f.pans, ...us.pans] };
}

/** Строки хранилища: запись JSON как есть, время Loki на 1–10 мс позже времени записи. */
function toRecords(entries: Entry[], anchorMs: number, r: Rng): MockRecord[] {
  return entries
    .filter((e) => e.ms <= anchorMs)
    .map((e) => {
      const readMs = e.ms + r.int(1, 10);
      const nsExtra = r.int(0, 999);
      const line = e.rawLine ?? (typeof e.body === 'string' ? e.body : JSON.stringify(e.body));
      const own = labels(e.component, e.namespace, r);
      return {
        tsNs: BigInt(Math.trunc(readMs)) * 1_000_000n + BigInt(nsExtra),
        labels: e.labels ? { ...own, ...e.labels } : own,
        line,
      };
    });
}

// ---------- Живой поток быстрого старта (deploy/quickstart) ----------
// Генератор демо-логов (cli/demo-logs.ts) запускает эти сценарии со временем «сейчас» и пишет их записи в Loki.

/** Сценарии живого потока: один запрос набора Demo Pay со свежими id. */
export const LIVE_SCENARIOS = [
  'card-lookup',
  'card-lookup-failed',
  'card-info',
  'payment-declined',
  'acquirer-error',
  'fraud-timeout',
  'payment-masked',
  'kyc-rejected',
  'transfer-fee',
  'worker-job',
  'parallel-cards',
  'parallel-calls',
  'processor-then-fraud',
  'ledger-retries',
  'phone-contact',
] as const;

export type LiveScenario = (typeof LIVE_SCENARIOS)[number];

/** Постоянные значения вместо случайных: пользователь у запросов api, первая карта у поиска карт, написание телефона. */
export interface LiveIds {
  user?: string;
  pan?: string;
  phone?: string;
}

/**
 * Один запрос сценария kind с началом в startMs: записи всех шагов по возрастанию времени, в том числе шагов позже startMs.
 * Содержимое задаёт seed. Метки потока — как у набора, под случайный у каждой записи.
 */
export function payScenario(kind: LiveScenario, startMs: number, seed: number, ids: LiveIds = {}): MockRecord[] {
  const r = rng(seed);
  const b = new FlowBuilder(r);
  const user = ids.user;
  switch (kind) {
    case 'card-lookup':
    case 'card-lookup-failed':
      b.cardsLookup(startMs, kind === 'card-lookup-failed', 'pay', ids.pan);
      break;
    case 'card-info':
      b.apiCardInfo(startMs, 'pay', undefined, user);
      break;
    case 'payment-declined':
      b.apiPaymentLedgerError(startMs, user);
      break;
    case 'acquirer-error':
      b.apiAcquirer500(startMs, user);
      break;
    case 'fraud-timeout':
      b.apiFraudTimeout(startMs, user);
      break;
    case 'payment-masked': {
      // Своя карта под маской: маска особого номера сделала бы каждый такой запрос неточным совпадением его поиска.
      const pan = b.pan('maestro');
      b.apiPaymentMasked(startMs, `${pan.slice(0, 6)}******${pan.slice(-4)}`, user);
      break;
    }
    case 'kyc-rejected':
      b.apiKycBad(startMs, user);
      break;
    case 'transfer-fee':
      b.apiSoapProxyFee(startMs, user ?? r.uuid7(startMs - r.int(1, 90) * DAY));
      break;
    case 'worker-job':
      b.workerJob(startMs);
      break;
    case 'parallel-cards':
      b.parallelCards(startMs);
      break;
    case 'parallel-calls':
      b.parallelCalls(startMs);
      break;
    case 'processor-then-fraud':
      b.processorThenFraud(startMs);
      break;
    case 'ledger-retries':
      b.ledgerRetries(startMs);
      break;
    case 'phone-contact':
      // Номера из диапазона Ofcom для вымысла, мимо особых номеров набора.
      b.phoneContact(startMs, ids.phone ?? `+447700900${r.int(500, 999)}`, String(r.int(6_300_000_000_000, 6_399_999_999_999)));
      break;
  }
  return toRecords(b.entries, Number.POSITIVE_INFINITY, r).sort((x, y) => (x.tsNs < y.tsNs ? -1 : x.tsNs > y.tsNs ? 1 : 0));
}
