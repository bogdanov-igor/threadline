// Пределы запуска и защитный слой: числа, чтение по одному, бюджет, окно, дедлайн, поддельная Grafana. Живой адрес тест получить не может.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BackendError, type LogLine } from '@threadline/core/backend';
import { validateConfig, type EnvironmentConfig } from '@threadline/core/config';
import { Backends } from '../../src/backends/registry.ts';
import { MockBackend } from '../../src/backends/mock/index.ts';
import type { ResolvedConfig } from '../../src/config/load.ts';
import * as L from '../../src/sample/limits.ts';
import { SampleReader, SampleStop } from '../../src/sample/reader.ts';
import { parseSince } from '../../src/sample/run.ts';
import { fakeGrafana, json } from '../fake-grafana.ts';
import { APP_LABELS, appLine, box, dropBox, incomingLine, NOW, run, Scripted, sendLine, TOKEN, uuid, type Box } from './sample-kit.ts';

const RANGE = { fromMs: NOW - 60_000, toMs: NOW };
const SELECTOR = [{ label: 'namespace', op: '=' as const, value: 'pay' }];

function setup(adapter: Scripted | MockBackend, opts: { token?: string | undefined; type?: 'mock' | 'loki' } = {}) {
  const v = validateConfig({
    auth: 'off',
    defaults: { project: 'pay', environment: 'prod' },
    backends: opts.type === 'mock' ? { b: { type: 'mock', latencyMs: 0 } } : { b: { type: 'loki-grafana', url: 'http://127.0.0.1:9', tokenEnv: 'T' } },
    projects: { pay: { name: 'Demo Pay', environments: { prod: { name: 'П', backend: 'b', selector: SELECTOR } } } },
  });
  if (!v.ok) throw new Error('настройка теста');
  const b = v.config.backends.b!;
  const config: ResolvedConfig = { path: '/x', config: v.config, backends: { b: b.type === 'mock' ? b : { ...b, token: 'token' in opts ? opts.token : 't', ca: undefined } } };
  const backends = new Backends(config, { createAdapter: () => adapter });
  return { backends, env: v.config.projects.pay!.environments.prod as EnvironmentConfig };
}

const line = (i: number): LogLine => ({ tsNs: String(i), line: '{}', labels: {} });

describe('числа пределов', () => {
  it('числа пределов не меняются незаметно', () => {
    expect(L.MAX_QUERIES).toBe(13);
    expect(L.MAX_LINES).toBe(1000);
    expect(L.MAX_WINDOW_MS).toBe(24 * 3_600_000);
    expect(L.RUN_DEADLINE_MS).toBe(120_000);
    expect(L.MAX_LABEL_NAMES).toBe(200);
    expect(L.MAX_LABEL_VALUES).toBe(50);
  });

  it('в белом списке нет одноразовых кодов, индекса и Content-Type', () => {
    for (const n of ['smscode', 'otpcode', 'zipcode', 'contenttype', 'message', 'name']) expect(L.TECHNICAL_FIELDS.has(n), n).toBe(false);
  });

  it('окно --since: от 1 минуты до 24 часов', () => {
    expect(parseSince('6h')).toBe(6 * 3_600_000);
    expect(parseSince('1d')).toBe(L.MAX_WINDOW_MS);
    for (const bad of ['25h', '2d', '0m', '30s', 'завтра', '']) expect(parseSince(bad), bad).toBeNull();
  });
});

describe('Backends.labelValues', () => {
  it('имитация: селектор среды и окно доходят, отбор по ним работает', async () => {
    const mock = new MockBackend({ type: 'mock', dataset: 'pay', latencyMs: 0 } as never, { anchorMs: NOW });
    const { backends, env } = setup(mock, { type: 'mock' });
    const signal = new AbortController().signal;
    const ours = await backends.labelValues(env, 'namespace', SELECTOR, { fromMs: NOW - 86_400_000, toMs: NOW }, signal);
    expect(ours).toEqual(['pay']);
  });

  it('поддельная Grafana: запрос несёт селектор среды, без токена not-configured', async () => {
    const g = await fakeGrafana((req, res) => {
      const u = new URL(req.url ?? '', 'http://x');
      if (u.pathname === '/api/datasources/id/Loki') return json(res, 200, { id: 7 });
      if (u.pathname.endsWith('/query_range')) return json(res, 200, { status: 'success', data: { resultType: 'streams', result: [] } });
      return json(res, 200, { status: 'success', data: ['api'] });
    });
    try {
      const b = await box({ url: g.url });
      const r = await run(b, ['--env', 'prod', '--kind', 'labels', '--live']);
      expect(r.code).toBe(0);
      const values = g.requests.map((x) => new URL(x.url, 'http://x')).filter((u) => u.pathname.endsWith('/label/container/values'));
      expect(values[0]!.searchParams.get('query')).toContain('namespace="pay"');
      await dropBox(b);
    } finally {
      await g.close();
    }
    const { backends, env } = setup(new Scripted(), { token: undefined });
    await expect(backends.labelValues(env, 'x', SELECTOR, RANGE, new AbortController().signal)).rejects.toMatchObject({ code: 'not-configured' });
  });

  it('одинаковые одновременные запросы склеиваются', async () => {
    const adapter = new Scripted();
    const { backends, env } = setup(adapter);
    const signal = new AbortController().signal;
    await Promise.all([backends.labelValues(env, 'x', SELECTOR, RANGE, signal), backends.labelValues(env, 'x', SELECTOR, RANGE, signal)]);
    expect(adapter.calls).toHaveLength(1);
  });
});

describe('SampleReader', () => {
  const lq = (limit: number, range = RANGE) => ({ selector: SELECTOR, filters: [], range, limit, direction: 'backward' as const });

  it('строго по одному, даже если чтения начаты разом', async () => {
    const adapter = new Scripted();
    const { backends, env } = setup(adapter);
    const reader = new SampleReader(backends, env);
    await Promise.all([reader.lines(lq(1)), reader.lines(lq(2)), reader.labelNames(), reader.labelValues('a', SELECTOR, RANGE)]);
    reader.close();
    expect(adapter.maxActive).toBe(1);
    expect(reader.used.queries).toBe(4);
  });

  it('хранилище вернуло больше предела: разбираются первые строки, в счётчике они же', async () => {
    const adapter = new Scripted();
    adapter.answer = () => Array.from({ length: 50 }, (_, i) => line(i));
    const { backends, env } = setup(adapter);
    const reader = new SampleReader(backends, env);
    expect(await reader.lines(lq(2))).toHaveLength(2);
    reader.close();
    expect(reader.used).toEqual({ queries: 1, lines: 2 });
  });

  it('предел запросов: четырнадцатый не уходит', async () => {
    const adapter = new Scripted();
    const { backends, env } = setup(adapter);
    const reader = new SampleReader(backends, env);
    for (let i = 0; i < L.MAX_QUERIES; i++) await reader.labelNames();
    await expect(reader.labelNames()).rejects.toMatchObject({ code: 'query-limit' });
    reader.close();
    expect(adapter.calls).toHaveLength(L.MAX_QUERIES);
  });

  it('предел строк: дальше запросов нет', async () => {
    const adapter = new Scripted();
    adapter.answer = (q) => Array.from({ length: q.limit }, (_, i) => line(i));
    const { backends, env } = setup(adapter);
    const reader = new SampleReader(backends, env);
    await reader.lines(lq(999));
    expect(await reader.lines(lq(5))).toHaveLength(1);
    const before = adapter.calls.length;
    await expect(reader.lines(lq(5))).rejects.toMatchObject({ code: 'line-limit' });
    await expect(reader.labelNames()).rejects.toMatchObject({ code: 'line-limit' });
    reader.close();
    expect(adapter.calls).toHaveLength(before);
  });

  it('окно больше 24 часов обрезается', async () => {
    const adapter = new Scripted();
    const { backends, env } = setup(adapter);
    const reader = new SampleReader(backends, env);
    await reader.lines(lq(1, { fromMs: NOW - 72 * 3_600_000, toMs: NOW }));
    reader.close();
    expect(adapter.lineCalls[0]!.range.fromMs).toBe(NOW - L.MAX_WINDOW_MS);
  });

  it('первая ошибка закрывает все следующие чтения', async () => {
    const adapter = new Scripted();
    adapter.failAt = { at: 0, error: new BackendError('timeout') };
    const { backends, env } = setup(adapter);
    const reader = new SampleReader(backends, env);
    await expect(reader.labelNames()).rejects.toBeInstanceOf(SampleStop);
    await expect(reader.lines(lq(1))).rejects.toMatchObject({ code: 'timeout' });
    reader.close();
    expect(adapter.calls).toHaveLength(1);
  });

  it('дедлайн прерывает текущий запрос', async () => {
    const adapter = new Scripted();
    adapter.check = (signal: AbortSignal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
    const { backends, env } = setup(adapter);
    const reader = new SampleReader(backends, env, { deadlineMs: 20 });
    await expect(reader.labelNames()).rejects.toMatchObject({ code: 'deadline' });
    reader.close();
  });
});

describe('запуск целиком', () => {
  let b: Box;
  beforeEach(async () => {
    b = await box();
  });
  afterEach(() => dropBox(b));

  it('все виды с полным набором кандидатов: 13 запросов, не больше 1000 строк, ни одного параллельного', async () => {
    const adapter = new Scripted();
    adapter.values = { container: ['worker-a', 'consumer-b', 'cron', 'job-c', 'queue-d'], app_kubernetes_io_component: ['worker-a'], app_kubernetes_io_sub_service: ['scheduler-e'] };
    let n = 0;
    adapter.answer = (q) =>
      Array.from({ length: Math.min(q.limit, 500) }, () => {
        n++;
        return incomingLine('POST', '/v1/x', { cid: uuid(n % 7), at: NOW - n * 1000, labels: APP_LABELS });
      });
    const r = await run(b, ['--env', 'demo', '--kind', 'all'], { createAdapter: () => adapter });
    expect(r.code).toBe(0);
    expect(adapter.calls.length).toBeLessThanOrEqual(L.MAX_QUERIES);
    expect(adapter.maxActive).toBe(1);
    expect(r.doc.used.queries).toBe(adapter.calls.length);
    expect(r.doc.used.lines).toBeLessThanOrEqual(L.MAX_LINES);
  });

  it('значения меток при all читаются один раз', async () => {
    const adapter = new Scripted();
    await run(b, ['--env', 'demo', '--kind', 'all'], { createAdapter: () => adapter });
    expect(adapter.calls.filter((c) => c.type === 'values')).toHaveLength(3);
  });
});

describe('поддельная Grafana', () => {
  const ALLOWED = /^\/api\/datasources\/(id\/Loki|proxy\/7\/loki\/api\/v1\/(labels|label\/[a-z_]+\/values|query_range))$/;

  function handler(fail?: { at: number; status: number; body?: string; type?: string }) {
    let seen = 0;
    return (req: Parameters<Parameters<typeof fakeGrafana>[0]>[0], res: Parameters<Parameters<typeof fakeGrafana>[0]>[1]) => {
      const i = seen++;
      const u = new URL(req.url ?? '', 'http://x');
      if (fail && i >= fail.at) {
        res.writeHead(fail.status, { 'content-type': fail.type ?? 'application/json' });
        res.end(fail.body ?? '{"message":"сбой"}');
        return;
      }
      if (u.pathname === '/api/datasources/id/Loki') return json(res, 200, { id: 7 });
      if (u.pathname.endsWith('/labels')) return json(res, 200, { status: 'success', data: ['container', 'namespace'] });
      if (u.pathname.includes('/label/')) return json(res, 200, { status: 'success', data: u.pathname.includes('/container/') ? ['worker-a', 'consumer-b', 'cron', 'job-c', 'queue-d'] : [] });
      const cid = uuid(1);
      const l = appLine({ cid, at: NOW - 1000 });
      return json(res, 200, { status: 'success', data: { resultType: 'streams', result: [{ stream: APP_LABELS, values: [[l.tsNs, l.line]] }] } });
    };
  }

  it('полный запуск: не больше 14 запросов, только разрешённые пути, токен только в заголовке', async () => {
    const g = await fakeGrafana(handler());
    const b = await box({ url: g.url });
    try {
      const r = await run(b, ['--env', 'prod', '--kind', 'all', '--live']);
      expect(r.code).toBe(0);
      expect(r.doc.source).toBe('loki-grafana');
      expect(g.requests.length).toBeLessThanOrEqual(14);
      for (const q of g.requests) {
        expect(new URL(q.url, 'http://x').pathname).toMatch(ALLOWED);
        expect(q.headers.authorization).toBe(`Bearer ${TOKEN}`);
      }
      expect(r.output).not.toContain(TOKEN);
      expect(r.text).not.toContain(TOKEN);
    } finally {
      await dropBox(b);
      await g.close();
    }
  });

  const CASES: [string, number, string | undefined, string | undefined, string][] = [
    ['401', 401, undefined, undefined, 'unauthorized'],
    ['403', 403, undefined, undefined, 'forbidden'],
    ['404', 404, undefined, undefined, 'not-found'],
    ['429', 429, undefined, undefined, 'overloaded'],
    ['503', 503, undefined, undefined, 'overloaded'],
    ['лимит', 400, 'max entries limit per query exceeded', 'text/plain', 'limit'],
    ['битый ответ', 200, 'не json', 'application/json', 'bad-response'],
    ['HTML', 200, '<html></html>', 'text/html', 'forbidden'],
  ];

  it.each(CASES)('ошибка %s посередине: следующих запросов нет, повторов нет', async (_name, status, body, type, code) => {
    const at = 4;
    const g = await fakeGrafana(handler({ at, status, ...(body !== undefined ? { body } : {}), ...(type !== undefined ? { type } : {}) }));
    const b = await box({ url: g.url });
    try {
      const r = await run(b, ['--env', 'prod', '--kind', 'all', '--live']);
      expect(r.code).toBe(1);
      expect(g.requests).toHaveLength(at + 1);
      expect(r.doc.stopped).toEqual({ kind: 'labels', code });
      expect(r.output).not.toContain('сбой');
      expect(r.output).not.toContain('max entries');
    } finally {
      await dropBox(b);
      await g.close();
    }
  });

  it('заголовков авторизации нет нигде, кроме запроса, и при сетевой ошибке', async () => {
    const adapter = new Scripted();
    adapter.failAt = { at: 0, error: new BackendError('network', { details: `${TOKEN} refused` }) };
    const b = await box();
    try {
      const r = await run(b, ['--env', 'demo', '--kind', 'all'], { createAdapter: () => adapter });
      expect(r.output).not.toContain(TOKEN);
      expect(r.output).toContain('сеть недоступна');
    } finally {
      await dropBox(b);
    }
  });

  it('отправка в режиме структуры: пределы действуют и на чтение строк кандидатов', async () => {
    const adapter = new Scripted();
    adapter.values = { container: ['worker-a'] };
    adapter.answer = () => Array.from({ length: 50 }, (_, i) => sendLine('http://ledger.local/v1/hold', { cid: uuid(1), at: NOW - i * 1000 }));
    const b = await box();
    try {
      const r = await run(b, ['--env', 'demo', '--kind', 'background'], { createAdapter: () => adapter });
      expect(r.doc.kinds.background.candidates[0].found).toBe(2);
    } finally {
      await dropBox(b);
    }
  });
});
