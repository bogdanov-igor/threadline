// Классификация ошибок хранилища и вырезание секретов из любых текстов.

import { BackendError } from '@threadline/core/backend';

const CERT_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_NOT_YET_VALID',
]);
const NETWORK_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
]);

/** Отказ Loki по лимиту рядов: только он делает поиск «слишком много запросов». */
export const SERIES_LIMIT = /maximum of series|max(imum)? (number of )?series/i;

/** Тексты Loki об отказе по лимиту. Новый текст добавляется одной строкой. */
export const LIMIT_PATTERNS: RegExp[] = [
  /max entries limit/i,
  SERIES_LIMIT,
  /query time (range|length).*(limit|exceeds|greater)/i,
  /time range exceeds/i,
  /too many bytes/i,
  /query would read too many/i,
  /limit (exceeded|reached)/i,
];

function errorCode(e: unknown): string | undefined {
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur; i++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

export function classifyFetchError(e: unknown, secrets: string[]): BackendError {
  if (e instanceof BackendError) return e;
  const name = (e as { name?: string }).name;
  if (name === 'TimeoutError') return new BackendError('timeout', { cause: e });
  if (name === 'AbortError') return new BackendError('cancelled', { cause: e });
  const code = errorCode(e);
  const msg = redact(String((e as Error)?.message ?? e), secrets);
  if (code && CERT_CODES.has(code)) return new BackendError('certificate', { details: code, cause: e });
  if (code && NETWORK_CODES.has(code)) return new BackendError('network', { details: code, cause: e });
  return new BackendError('network', { details: code ? `${code}: ${msg}` : msg, cause: e });
}

export function classifyHttp(
  status: number,
  contentType: string,
  body: string,
  retryAfter: string | null,
  secrets: string[],
  service = 'Grafana',
): BackendError {
  const text = redact(body, secrets).slice(0, 2000);
  if (/text\/html/i.test(contentType)) {
    return new BackendError('forbidden', {
      status,
      details: `вместо ответа API ${service} пришла HTML-страница (HTTP ${status}): учётные данные не приняты или адрес указывает не на API`,
    });
  }
  if (status === 401) return new BackendError('unauthorized', { status, details: text });
  if (status === 403) return new BackendError('forbidden', { status, details: text });
  if (status === 404) return new BackendError('not-found', { status, details: text });
  if (status === 429 || status === 503) {
    const opts: { status: number; details: string; retryAfterSeconds?: number } = { status, details: text };
    const seconds = parseRetryAfter(retryAfter);
    if (seconds !== undefined) opts.retryAfterSeconds = seconds;
    return new BackendError('overloaded', opts);
  }
  if (LIMIT_PATTERNS.some((re) => re.test(body))) return new BackendError('limit', { status, details: text });
  return new BackendError('unknown', { status, details: `HTTP ${status}${text ? `: ${text}` : ''}` });
}

function parseRetryAfter(v: string | null): number | undefined {
  if (!v) return undefined;
  const n = Number(v);
  if (Number.isFinite(n) && n >= 0) return Math.ceil(n);
  const at = Date.parse(v);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

const AUTH_SCHEME = /\b(Bearer|Basic)\s+[A-Za-z0-9+/=._~-]+/gi;
const GRAFANA_SA = /\bglsa_[A-Za-z0-9_]+/g;

/** Убирает из текста значения секретов и всё, что похоже на заголовок авторизации. */
export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join('***');
  }
  return out.replace(AUTH_SCHEME, '$1 ***').replace(GRAFANA_SA, '***');
}
