// Адаптер Loki через Grafana: прокси источника по числовому id (Grafana 8.5 знает только его), а где такого пути нет (Grafana 13) — по uid.

import type { Dispatcher } from 'undici';
import { BackendError, type ExploreQuery } from '@threadline/core/backend';
import { describeDatasource } from '@threadline/core/config';
import type { ResolvedLoki } from '../config/load.ts';
import { dispatcherFor, getJson } from './http.ts';
import { linesLogql } from './logql.ts';
import { LokiApiBackend, type LokiResponse } from './loki-api.ts';

/** Обратный прокси обычно режет строку запроса на 8 КБ, а выражение потом идёт ещё и в GET к Loki. */
export const MAX_EXPLORE_URL = 6000;

/** Адрес для браузера: publicUrl проверен настройкой, а url с учётными данными или параметрами показывать нельзя. */
function exploreBase(cfg: ResolvedLoki): string | undefined {
  if (cfg.exploreLink === false) return undefined;
  if (cfg.publicUrl) return cfg.publicUrl.replace(/\/+$/, '');
  const u = new URL(cfg.url);
  return u.username || u.password || u.search || u.hash ? undefined : cfg.url.replace(/\/+$/, '');
}

export class LokiGrafanaBackend extends LokiApiBackend {
  readonly #cfg: ResolvedLoki;
  readonly #dispatcher: Dispatcher | undefined;
  readonly #base: string;
  /** Часть пути прокси после /api/datasources/proxy/: числовой id или uid/<uid>. */
  #proxy: string | undefined;
  /** Прокси уже отвечал: 404 после этого — источник пропал, а не другая версия Grafana. */
  #answered = false;

  constructor(cfg: ResolvedLoki, opts: { now?: () => number; env?: Record<string, string | undefined> } = {}) {
    super(opts.now);
    this.#cfg = cfg;
    this.#base = cfg.url.replace(/\/+$/, '');
    this.#dispatcher = dispatcherFor(cfg.ca, opts.env ?? process.env);
    this.#proxy = this.#configured();
  }

  get datasourceLabel(): string {
    return describeDatasource(this.#cfg.datasource);
  }

  /** Ссылка в Explore: формат Grafana 8.5. Сеть не используется, токена в адресе нет. */
  override exploreUrl(q: ExploreQuery): string | null | undefined {
    const base = exploreBase(this.#cfg);
    const ref = this.#cfg.datasource;
    // Числовой id Explore не понимает, а спрашивать имя у Grafana ради ссылки нельзя.
    const datasource = 'name' in ref ? ref.name : 'uid' in ref ? ref.uid : undefined;
    if (base === undefined || datasource === undefined) return undefined;
    const left = {
      datasource,
      queries: [{ refId: 'A', expr: linesLogql(q.selector, q.filters) }],
      range: { from: String(Math.trunc(q.range.fromMs)), to: String(Math.trunc(q.range.toMs)) },
    };
    const url = `${base}/explore?left=${encodeURIComponent(JSON.stringify(left))}`;
    return url.length > MAX_EXPLORE_URL ? null : url;
  }

  protected override async request<T>(path: string, params: Record<string, string>, signal: AbortSignal): Promise<LokiResponse<T>> {
    const first = await this.#proxyPath(signal);
    try {
      return await this.#get<T>(first, path, params, signal);
    } catch (e) {
      if (!(e instanceof BackendError && e.code === 'not-found')) throw e;
    }
    // Grafana 13 проксирует источник только по uid: путь по числовому id отвечает 404.
    const byUid = this.#answered || first.startsWith('uid/') ? undefined : await this.#uidPath(Number(first), signal).catch(() => undefined);
    if (byUid !== undefined) {
      try {
        const res = await this.#get<T>(byUid, path, params, signal);
        this.#proxy = byUid;
        return res;
      } catch (e) {
        if (!(e instanceof BackendError && e.code === 'not-found')) throw e;
      }
    }
    this.#proxy = this.#configured();
    throw new BackendError('not-found', { status: 404, details: `источник Loki (${this.datasourceLabel}) не найден в Grafana` });
  }

  async #get<T>(proxy: string, path: string, params: Record<string, string>, signal: AbortSignal): Promise<LokiResponse<T>> {
    const res = await getJson<LokiResponse<T>>(`${this.#base}/api/datasources/proxy/${proxy}/loki/api/v1/${path}?${new URLSearchParams(params)}`, this.#http(signal));
    this.#answered = true;
    return res;
  }

  /** Путь из настройки без запросов к Grafana: только для числового id. */
  #configured(): string | undefined {
    return 'id' in this.#cfg.datasource ? String(this.#cfg.datasource.id) : undefined;
  }

  async #proxyPath(signal: AbortSignal): Promise<string> {
    if (this.#proxy !== undefined) return this.#proxy;
    const ref = this.#cfg.datasource;
    const notFound = () =>
      new BackendError('not-found', { status: 404, details: `источник Loki (${describeDatasource(ref)}) не найден в Grafana` });

    if ('name' in ref) {
      let res: { id?: unknown };
      try {
        res = await getJson<{ id?: unknown }>(`${this.#base}/api/datasources/id/${encodeURIComponent(ref.name)}`, this.#http(signal));
      } catch (e) {
        if (e instanceof BackendError && e.code === 'not-found') throw notFound();
        throw e;
      }
      if (typeof res?.id !== 'number') throw new BackendError('bad-response', { details: 'Grafana не вернула id источника' });
      this.#proxy = String(res.id);
      return this.#proxy;
    }
    if ('uid' in ref) {
      const found = (await this.#sources(signal)).find((d) => d?.uid === ref.uid);
      if (!found) throw notFound();
      // Без числового id в настройках интерфейса — новая Grafana: сразу путь по uid.
      this.#proxy = typeof found.id === 'number' ? String(found.id) : `uid/${encodeURIComponent(ref.uid)}`;
      return this.#proxy;
    }
    return String(ref.id);
  }

  /** Путь по uid для того же источника: uid из настройки или из настроек интерфейса Grafana, они доступны роли Viewer. */
  async #uidPath(id: number, signal: AbortSignal): Promise<string | undefined> {
    const ref = this.#cfg.datasource;
    if ('uid' in ref) return `uid/${encodeURIComponent(ref.uid)}`;
    const found = (await this.#sources(signal)).find((d) => d?.id === id || ('name' in ref && d?.name === ref.name));
    return typeof found?.uid === 'string' && found.uid !== '' ? `uid/${encodeURIComponent(found.uid)}` : undefined;
  }

  async #sources(signal: AbortSignal): Promise<{ id?: unknown; uid?: unknown; name?: unknown }[]> {
    const settings = await getJson<{ datasources?: Record<string, { id?: unknown; uid?: unknown; name?: unknown }> }>(
      `${this.#base}/api/frontend/settings`,
      this.#http(signal),
    );
    return Object.entries(settings?.datasources ?? {}).map(([key, d]) => ({ ...d, name: typeof d?.name === 'string' ? d.name : key }));
  }

  #http(signal: AbortSignal) {
    return { token: this.#cfg.token, dispatcher: this.#dispatcher, signal, service: 'Grafana' };
  }
}
