// Синтетические записи для тестов графа и операции. Значения выдуманы, данные из logs.md не используются.
import type { FlowHint, ViewRecord } from '../search/api.ts';
import { buildTrace, type Trace } from '../search/trace.ts';
import type { FlowCatalogId, FlowCatalogMarkup, FlowCatalogStatus, FlowMethodKind } from './catalog.ts';
import { buildFlowGraph } from './graph.ts';
import type { FlowGraph, FlowOptions } from './model.ts';

export const BASE_MS = Date.parse('2026-11-02T10:00:00+05:00');

export interface RecOpts {
  title?: string;
  message?: string;
  level?: string | null;
  isError?: boolean;
  component?: string | null;
  gateway?: boolean;
  rid?: string | null;
  method?: string | null;
  uri?: string | null;
  status?: number | null;
  body?: string | null;
  catalog?: Partial<FlowCatalogMarkup> | null;
  flow?: FlowHint | null;
  pending?: boolean;
}

/** Разметка справочника в форме ViewRecord.catalog. */
export function markup(m: Partial<FlowCatalogMarkup>): FlowCatalogMarkup {
  return { name: null, error: null, outcome: null, ids: [], status: null, ...m };
}

export const sys = (key: string, name: string, type: 'service' | 'database' | 'queue' = 'service') => ({ key, name, type });

export function name(system: ReturnType<typeof sys> | null, method?: { id?: number; name: string; kind?: FlowMethodKind; op?: string; opName?: string }) {
  return {
    system,
    method: method
      ? { id: method.id ?? 1, name: method.name, kind: method.kind ?? 'call', opType: method.op ? { key: method.op, name: method.opName ?? method.op } : null }
      : null,
  };
}

export const opId = (type: string, value: string, at: FlowCatalogId['at'] = 'request', label = type): FlowCatalogId => ({
  type,
  name: label,
  kind: 'operation',
  value,
  at,
});

export const status = (type: string, value: string, label: string | null, outcome: FlowCatalogStatus['outcome']): FlowCatalogStatus => ({
  type,
  value,
  raw: value,
  name: label,
  outcome,
  order: null,
});

/** Поток записей: время — мс от начала потока. */
export class FlowFixture {
  readonly records: ViewRecord[] = [];
  readonly cid: string;
  #n = 0;

  constructor(cid = 'cid-0001') {
    this.cid = cid;
  }

  #rec(kind: ViewRecord['kind'], t: number, o: RecOpts): ViewRecord {
    const id = `r${String(++this.#n).padStart(4, '0')}`;
    const http =
      kind === 'incoming' || kind === 'send' || kind === 'response'
        ? {
            method: o.method ?? (kind === 'incoming' ? 'GET' : 'POST'),
            uri: o.uri ?? null,
            status: kind === 'response' ? (o.status ?? 200) : null,
            durationMs: null,
            pairId: null,
            noResponse: false,
            pending: o.pending ?? false,
          }
        : null;
    const r: ViewRecord = {
      id,
      tsNs: (BigInt(Math.round((BASE_MS + t) * 1000)) * 1000n).toString(),
      timeMs: BASE_MS + t,
      offsetMs: null,
      kind,
      title: o.title ?? o.message ?? kind,
      message: o.message ?? o.title ?? kind,
      level: o.level === undefined ? 'INFO' : o.level,
      isError: o.isError ?? false,
      component: o.component === undefined ? 'cards' : o.component,
      gateway: o.gateway ?? false,
      correlationId: this.cid,
      requestId: o.rid ?? null,
      http,
      sections: { headers: null, body: o.body ?? null, payload: null, context: null },
      raw: `${o.message ?? ''} ${o.uri ?? ''} ${o.body ?? ''}`,
      match: null,
    };
    if (o.catalog !== undefined) r.catalog = o.catalog === null ? null : (markup(o.catalog) as unknown as ViewRecord['catalog']);
    if (o.flow !== undefined) r.flow = o.flow;
    this.records.push(r);
    return r;
  }

  entry(t: number, o: RecOpts = {}): ViewRecord {
    return this.#rec('incoming', t, { uri: '/v1/users/u1/cards', title: o.title ?? `${o.method ?? 'GET'} ${o.uri ?? '/v1/users/u1/cards'}`, ...o });
  }

  call(t: number, action: string, o: RecOpts = {}): ViewRecord {
    return this.#rec('call', t, { title: action, message: o.message ?? `request ${action}`, ...o });
  }

  /** Отправка и ответ; end = null — ответа нет. status ≥ 400 или isError — ошибка. */
  exchange(t: number, end: number | null, o: RecOpts & { respBody?: string | null; respCatalog?: Partial<FlowCatalogMarkup> | null } = {}): { send: ViewRecord; resp: ViewRecord | null } {
    const uri = o.uri ?? 'https://ledger.pay.example:8443/api/v1/hold';
    const { respBody, respCatalog, status: st, ...rest } = o;
    const send = this.#rec('send', t, { ...rest, uri, title: o.title ?? `${o.method ?? 'POST'} ${uri}`, isError: false });
    if (end === null) {
      send.http!.noResponse = true;
      return { send, resp: null };
    }
    const code = st ?? 200;
    const resp = this.#rec('response', end, {
      ...rest,
      uri,
      status: code,
      body: respBody ?? null,
      catalog: respCatalog === undefined ? o.catalog : respCatalog,
      title: `${o.method ?? 'POST'} ${uri} → ${code}`,
      isError: o.isError ?? code >= 400,
    });
    send.http!.pairId = resp.id;
    resp.http!.pairId = send.id;
    send.http!.durationMs = end - t;
    resp.http!.durationMs = end - t;
    return { send, resp };
  }

  /** Ответ без отправки. */
  response(t: number, o: RecOpts = {}): ViewRecord {
    const uri = o.uri ?? 'https://ledger.pay.example:8443/api/v1/hold';
    return this.#rec('response', t, { uri, title: `POST ${uri} → ${o.status ?? 200}`, ...o });
  }

  log(t: number, message: string, o: RecOpts = {}): ViewRecord {
    return this.#rec('log', t, { message, title: message, ...o });
  }

  raw(t: number): ViewRecord {
    return this.#rec('raw', t, { message: 'не разобрана', title: 'не разобрана', level: null });
  }

  db(t: number, ms: number | null): ViewRecord {
    return this.log(t, 'db query', { flow: { as: 'db', durationMs: ms, host: null, title: null } });
  }

  /** Записи по времени со смещениями от первой. */
  view(): ViewRecord[] {
    const sorted = [...this.records].sort((a, b) => a.timeMs - b.timeMs || (a.id < b.id ? -1 : 1));
    const first = sorted[0]?.timeMs ?? 0;
    return sorted.map((r) => ({ ...r, offsetMs: Math.round((r.timeMs - first) * 1000) / 1000 }));
  }

  trace(): Trace {
    return buildTrace(this.view());
  }

  graph(opts: Partial<FlowOptions> = {}): FlowGraph {
    const records = this.view();
    return buildFlowGraph(buildTrace(records), records, { related: [], ...opts });
  }
}
