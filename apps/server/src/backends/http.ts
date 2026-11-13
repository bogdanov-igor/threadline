// Запросы к хранилищу: прокси и сертификат, заголовок авторизации, чтение ответа с пределом объёма, классификация ошибок.

import { Agent, EnvHttpProxyAgent, fetch, type Dispatcher } from 'undici';
import { BackendError } from '@threadline/core/backend';
import { classifyFetchError, classifyHttp } from './errors.ts';

export const MAX_RESPONSE_BYTES = 50 * 1024 * 1024;

const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'];

/** Корпоративный прокси из HTTPS_PROXY/HTTP_PROXY/NO_PROXY и свой корневой сертификат работают вместе. */
export function dispatcherFor(ca: string | undefined, env: Record<string, string | undefined>): Dispatcher | undefined {
  if (PROXY_VARS.some((v) => env[v]?.trim())) {
    const pick = (...names: string[]) => names.map((n) => env[n]?.trim()).find(Boolean);
    const httpProxy = pick('HTTP_PROXY', 'http_proxy');
    const httpsProxy = pick('HTTPS_PROXY', 'https_proxy');
    const noProxy = pick('NO_PROXY', 'no_proxy');
    return new EnvHttpProxyAgent({
      ...(httpProxy ? { httpProxy } : {}),
      ...(httpsProxy ? { httpsProxy } : {}),
      ...(noProxy ? { noProxy } : {}),
      ...(ca ? { connect: { ca }, requestTls: { ca } } : {}),
    });
  }
  return ca ? new Agent({ connect: { ca } }) : undefined;
}

export interface HttpOptions {
  /** Токен Bearer. */
  token?: string | undefined;
  /** Вход Basic: имя и пароль. Вместе с token не задаётся. */
  basic?: { username: string; password: string } | undefined;
  /** Прочие заголовки запроса, например X-Scope-OrgID. */
  headers?: Record<string, string> | undefined;
  /** Кто отвечает: имя в сообщениях о перенаправлении и HTML-странице вместо ответа API. По умолчанию Grafana. */
  service?: string;
  dispatcher?: Dispatcher | undefined;
  signal: AbortSignal;
  maxBytes?: number;
}

/** Заголовок авторизации и значения, которые вырезаются из любых текстов ошибок. */
function authorization(opts: HttpOptions): { header?: string; secrets: string[] } {
  if (opts.token) return { header: `Bearer ${opts.token}`, secrets: [opts.token] };
  if (opts.basic) {
    const encoded = Buffer.from(`${opts.basic.username}:${opts.basic.password}`, 'utf8').toString('base64');
    return { header: `Basic ${encoded}`, secrets: [opts.basic.password, encoded] };
  }
  return { secrets: [] };
}

export async function getJson<T = unknown>(url: string, opts: HttpOptions): Promise<T> {
  const { header, secrets } = authorization(opts);
  const headers: Record<string, string> = { ...opts.headers, Accept: 'application/json' };
  if (header) headers.Authorization = header;
  const service = opts.service ?? 'Grafana';

  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await fetch(url, { headers, signal: opts.signal, redirect: 'manual', ...(opts.dispatcher ? { dispatcher: opts.dispatcher } : {}) });
  } catch (e) {
    throw classifyFetchError(e, secrets);
  }

  const contentType = res.headers.get('content-type') ?? '';
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel().catch(() => {});
    throw new BackendError('forbidden', {
      status: res.status,
      details: `ответ ${service} — перенаправление (HTTP ${res.status}) на ${res.headers.get('location') ?? 'другой адрес'}: учётные данные не приняты или адрес указывает не на API`,
    });
  }

  let text: string;
  try {
    text = await readText(res, opts.maxBytes ?? MAX_RESPONSE_BYTES);
  } catch (e) {
    throw classifyFetchError(e, secrets);
  }

  if (res.status < 200 || res.status >= 300) {
    throw classifyHttp(res.status, contentType, text, res.headers.get('retry-after'), secrets, service);
  }
  if (/text\/html/i.test(contentType)) throw classifyHttp(res.status, contentType, text, null, secrets, service);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new BackendError('bad-response', { status: res.status, details: 'ответ не разбирается как JSON' });
  }
}

async function readText(res: Awaited<ReturnType<typeof fetch>>, maxBytes: number): Promise<string> {
  if (!res.body) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.byteLength;
    if (size > maxBytes) {
      await res.body.cancel().catch(() => {});
      throw new BackendError('too-large', {
        details: `ответ больше ${Math.round(maxBytes / 1024 / 1024)} МБ`,
      });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
