// Адаптер Loki напрямую: HTTP API /loki/api/v1 без Grafana. Вход Bearer или Basic из переменных окружения,
// арендатор в заголовке X-Scope-OrgID. Прокси, сертификат, предел ответа и разбор ошибок — общие с адаптером через Grafana.

import type { Dispatcher } from 'undici';
import { BackendError } from '@threadline/core/backend';
import type { ResolvedLokiDirect } from '../config/load.ts';
import { dispatcherFor, getJson, type HttpOptions } from './http.ts';
import { LokiApiBackend, type LokiResponse } from './loki-api.ts';

export const TENANT_HEADER = 'X-Scope-OrgID';

export class LokiBackend extends LokiApiBackend {
  readonly #cfg: ResolvedLokiDirect;
  readonly #dispatcher: Dispatcher | undefined;
  readonly #api: string;

  constructor(cfg: ResolvedLokiDirect, opts: { now?: () => number; env?: Record<string, string | undefined> } = {}) {
    super(opts.now);
    this.#cfg = cfg;
    this.#api = `${cfg.url.replace(/\/+$/, '')}/loki/api/v1`;
    this.#dispatcher = dispatcherFor(cfg.ca, opts.env ?? process.env);
  }

  /** У Loki нет своего интерфейса запросов: ссылки «Открыть в Grafana» у его сред нет. */
  override exploreUrl(): undefined {
    return undefined;
  }

  protected override async request<T>(path: string, params: Record<string, string>, signal: AbortSignal): Promise<LokiResponse<T>> {
    try {
      return await getJson<LokiResponse<T>>(`${this.#api}/${path}?${new URLSearchParams(params)}`, this.#http(signal));
    } catch (e) {
      if (!(e instanceof BackendError)) throw e;
      if (e.code === 'not-found') throw new BackendError('not-found', { status: 404, details: `по адресу ${this.#api} нет API Loki: проверьте поле url хранилища` });
      // Loki с несколькими арендаторами без заголовка отвечает 401 «no org id».
      if (e.code === 'unauthorized' && !this.#cfg.tenant && /no org id/i.test(e.details ?? '')) {
        throw new BackendError('unauthorized', { status: 401, details: `${e.details}: Loki ждёт арендатора в заголовке ${TENANT_HEADER}, задайте поле tenant хранилища` });
      }
      throw e;
    }
  }

  #http(signal: AbortSignal): HttpOptions {
    const { token, username, password, tenant } = this.#cfg;
    return {
      token,
      basic: !token && username !== undefined && password !== undefined ? { username, password } : undefined,
      headers: tenant ? { [TENANT_HEADER]: tenant } : undefined,
      service: 'Loki',
      dispatcher: this.#dispatcher,
      signal,
    };
  }
}
