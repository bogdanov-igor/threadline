// Общее для тестов команды выборки: своя настройка во временном каталоге, адаптер по сценарию, строки встроенного формата json.
// Все значения выдуманы.

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CheckInfo, CountQuery, LinesQuery, LogBackend, LogLine, Matcher, TimeRange } from '@threadline/core/backend';
import { runSample, type SampleIo } from '../../src/sample/run.ts';

export const NOW = Date.UTC(2026, 10, 4, 10, 0, 0);
export const TOKEN = 'sample-test-token-value';

export const APP_LABELS = { cluster: 'demo', namespace: 'pay', container: 'api', app_kubernetes_io_component: 'api', pod: 'pay-app-api-6f8d9c7b5d-abcde', host: 'node-1' };
/** Шлюз на проде: контейнер называется server, компонент — gateway. */
export const GW_LABELS = { cluster: 'demo', namespace: 'pay', container: 'server', app_kubernetes_io_component: 'gateway', pod: 'pay-app-gateway-5d8c7b6f49-x7k2p' };

export const uuid = (n: number) => `c0ffee00-0000-4000-8000-${String(n).padStart(12, '0')}`;

const config = (url: string) => `
auth: off
defaults: { project: pay, environment: prod }
backends:
  live: { type: loki-grafana, url: ${url}, tokenEnv: SAMPLE_TEST_TOKEN }
  demo: { type: mock, dataset: pay, latencyMs: 0 }
projects:
  pay:
    name: Demo Pay
    timezone: Asia/Karachi
    environments:
      prod:
        name: Прод
        backend: live
        selector:
          - { label: namespace, op: '=', value: pay }
      test:
        name: Тест
        backend: live
        selector:
          - { label: namespace, op: '=', value: pay-test }
          - { label: app_kubernetes_io_sub_service, op: '!=', value: cron, searchOnly: true }
      pr:
        name: Стенды
        kind: pr-stands
        backend: live
        stand: { label: namespace, template: 'pay-pr-{number}' }
        selector:
          - { label: container, op: '!=', value: pgadmin }
      demo:
        name: Демо
        backend: demo
        selector:
          - { label: namespace, op: '=', value: pay }
`;

/** Маленький начальный набор: Кириллица в названиях не должна попасть в файл. */
export const CATALOG = {
  version: 1,
  project: 'pay',
  systems: [
    { key: 'pay', kind: 'project', name: 'Демо-платежи', methods: [{ http: 'POST', path: '/v1/users/{user}/cards', name: 'Карты' }] },
    {
      key: 'ledger',
      name: 'Платёжное ядро',
      hosts: ['ledger.local'],
      methods: [
        { http: 'POST', path: '/v1/hold', name: 'Холд', op: undefined },
        { http: 'POST', path: '/v1/pay', name: 'Платёж' },
      ],
      errors: [{ code: '51', title: 'Недостаточно средств' }],
      outcomes: [{ when: { http: 200, fields: [{ path: 'result.payment_state', equals: 'CONFIRMED' }] }, outcome: 'success' }],
    },
    { key: 'fraud', name: 'Антифрод', hosts: ['fraud.local'], methods: [{ http: 'POST', path: '/', rpc: 'risk.check', name: 'Оценка риска' }] },
  ],
};

export interface Box {
  root: string;
  home: string;
  out: string;
  env: Record<string, string | undefined>;
  lines: string[];
}

export async function box(opts: { url?: string; catalog?: unknown | string | null; token?: boolean } = {}): Promise<Box> {
  const root = await mkdtemp(join(tmpdir(), 'threadline-sample-'));
  const home = join(root, 'home');
  await mkdir(home);
  const cfg = join(root, 'cfg');
  await mkdir(join(cfg, 'catalog'), { recursive: true });
  await writeFile(join(cfg, 'threadline.yaml'), config(opts.url ?? 'http://127.0.0.1:9'));
  if (opts.catalog !== null) {
    const body = opts.catalog === undefined ? CATALOG : opts.catalog;
    await writeFile(join(cfg, 'catalog', 'pay.yaml'), typeof body === 'string' ? body : JSON.stringify(body));
  }
  const env: Record<string, string | undefined> = { THREADLINE_CONFIG: join(cfg, 'threadline.yaml') };
  if (opts.token !== false) env.SAMPLE_TEST_TOKEN = TOKEN;
  return { root, home, out: join(root, 'out'), env, lines: [] };
}

export const dropBox = (b: Box) => rm(b.root, { recursive: true, force: true });

export function ioOf(b: Box, over: Partial<SampleIo> = {}): SampleIo {
  return { env: b.env, cwd: b.root, home: b.home, out: (l) => b.lines.push(l), err: (l) => b.lines.push(l), now: () => NOW, ...over };
}

export interface RunResult {
  code: number;
  files: string[];
  doc: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  text: string;
  output: string;
}

/** Запуск в каталог out ящика: код, файлы, файл разобранным и весь вывод. */
export async function run(b: Box, args: string[], over: Partial<SampleIo> = {}): Promise<RunResult> {
  b.lines.length = 0;
  const code = await runSample([...args, '--out', b.out], ioOf(b, over));
  const files = await readdir(b.out).catch(() => [] as string[]);
  const name = files.find((f) => f.endsWith('.json'));
  const text = name ? await readFile(join(b.out, name), 'utf8') : '';
  return { code, files, text, doc: text ? JSON.parse(text) : null, output: b.lines.join('\n') };
}

export type Call = { type: 'check' } | { type: 'values'; label: string; scope: Matcher[]; range: TimeRange } | { type: 'lines'; q: LinesQuery };

/** Адаптер по сценарию: считает вызовы и одновременные запросы. */
export class Scripted implements LogBackend {
  calls: Call[] = [];
  active = 0;
  maxActive = 0;
  names = ['cluster', 'container', 'namespace'];
  values: Record<string, string[]> = {};
  answer: (q: LinesQuery) => LogLine[] = () => [];
  /** Ошибка на вызове с этим номером, с нуля. */
  failAt: { at: number; error: unknown } | null = null;

  async #enter<T>(call: Call, signal: AbortSignal, value: () => T): Promise<T> {
    const i = this.calls.length;
    this.calls.push(call);
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      await new Promise((r) => setImmediate(r));
      if (signal.aborted) throw new Error('aborted');
      if (this.failAt?.at === i) throw this.failAt.error;
      return value();
    } finally {
      this.active--;
    }
  }

  check(signal: AbortSignal): Promise<CheckInfo> {
    return this.#enter({ type: 'check' }, signal, () => ({ labelNames: this.names }));
  }
  labelValues(label: string, scope: Matcher[], range: TimeRange, signal: AbortSignal): Promise<string[]> {
    return this.#enter({ type: 'values', label, scope, range }, signal, () => this.values[label] ?? []);
  }
  queryLines(q: LinesQuery, signal: AbortSignal): Promise<LogLine[]> {
    return this.#enter({ type: 'lines', q }, signal, () => this.answer(q));
  }
  async countBy(_q: CountQuery): Promise<Record<string, number>> {
    throw new Error('команда выборки не считает');
  }

  get lineCalls(): LinesQuery[] {
    return this.calls.flatMap((c) => (c.type === 'lines' ? [c.q] : []));
  }
}

const LEVEL_NAME: Record<number, string> = { 200: 'info', 300: 'warning', 400: 'error' };

/**
 * Строка хранилища: запись приложения встроенного формата json. fields — поля записи после correlation_id:
 * request_id, request, upstream, action, payload, ctx.
 */
export function appLine(o: { msg?: string; fields?: Record<string, unknown>; cid?: string | null; level?: number; at?: number; labels?: Record<string, string> }): LogLine {
  const at = o.at ?? NOW - 60_000;
  const rec = {
    time: new Date(at).toISOString(),
    level: LEVEL_NAME[o.level ?? 200] ?? 'info',
    msg: o.msg ?? 'http request sending',
    ...(o.cid === null || o.cid === undefined ? {} : { correlation_id: o.cid }),
    ...(o.fields ?? {}),
  };
  return { tsNs: `${at}000000`, line: JSON.stringify(rec), labels: o.labels ?? APP_LABELS };
}

/** Строка хранилища: запись шлюза с сырым HTTP. */
export function gatewayLine(o: { method?: string; path?: string; cid?: string; headers?: [string, string][]; body?: string; at?: number; labels?: Record<string, string> }): LogLine {
  const at = o.at ?? NOW - 60_000;
  const headers = [...(o.cid ? ([['X-Correlation-Id', o.cid]] as [string, string][]) : []), ...(o.headers ?? [])];
  const raw = `${[`${o.method ?? 'GET'} ${o.path ?? '/v1/users'} HTTP/1.1`, ...headers.map(([k, v]) => `${k}: ${v}`)].join('\r\n')}\r\n\r\n${o.body ?? ''}`;
  const gw = { time: new Date(at).toISOString(), level: 'debug', msg: 'request received', raw_request: raw };
  return { tsNs: `${at}000000`, line: JSON.stringify(gw), labels: o.labels ?? GW_LABELS };
}

type ExchangeOpts = { cid?: string | null; body?: unknown; method?: string; at?: number; requestId?: string; labels?: Record<string, string> };

export const sendLine = (url: string, o: ExchangeOpts = {}) =>
  appLine({
    cid: o.cid ?? null,
    ...(o.at !== undefined ? { at: o.at } : {}),
    ...(o.labels ? { labels: o.labels } : {}),
    fields: { ...(o.requestId ? { request_id: o.requestId } : {}), upstream: { method: o.method ?? 'POST', url, body: o.body === undefined ? '{}' : JSON.stringify(o.body) } },
  });

export const responseLine = (url: string, status: number, o: ExchangeOpts = {}) =>
  appLine({
    msg: 'http response received',
    cid: o.cid ?? null,
    ...(o.at !== undefined ? { at: o.at } : {}),
    ...(o.labels ? { labels: o.labels } : {}),
    fields: { ...(o.requestId ? { request_id: o.requestId } : {}), upstream: { method: o.method ?? 'POST', url, status, body: o.body === undefined ? '{}' : JSON.stringify(o.body) } },
  });

export const incomingLine = (method: string, path: string, o: { cid?: string | null; at?: number; labels?: Record<string, string> } = {}) =>
  appLine({
    msg: 'incoming request',
    cid: o.cid ?? null,
    ...(o.at !== undefined ? { at: o.at } : {}),
    ...(o.labels ? { labels: o.labels } : {}),
    fields: { request: { method, path, headers: {}, body: '' } },
  });
