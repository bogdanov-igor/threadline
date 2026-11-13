import { createServer } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { BackendError, type ExploreQuery, type Filter } from '@threadline/core/backend';
import { detectTerm, linkFilter, setRegional } from '@threadline/core/search';
import type { ResolvedLoki } from '../src/config/load.ts';
import { LokiGrafanaBackend, MAX_EXPLORE_URL } from '../src/backends/loki-grafana.ts';
import { linesLogql } from '../src/backends/logql.ts';
import { MockBackend } from '../src/backends/mock/index.ts';
import { dispatcherFor, getJson } from '../src/backends/http.ts';
import { fakeGrafana, grafana85, grafanaUid, json, type Handler } from './fake-grafana.ts';

const TOKEN = 'eyJrIjoiZmFrZS10b2tlbi1mb3ItdGVzdHMifQ==';
let servers: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
});

async function setup(handler: Handler, datasource: ResolvedLoki['datasource'] = { name: 'Loki' }) {
  const g = await fakeGrafana(handler);
  servers.push(g);
  const cfg: ResolvedLoki = {
    type: 'loki-grafana',
    url: g.url + '/',
    datasource,
    tokenEnv: 'T',
    token: TOKEN,
    ca: undefined,
    maxConcurrent: 4,
    queueTimeoutSeconds: 10,
    timeoutSeconds: 30,
  };
  return { g, backend: new LokiGrafanaBackend(cfg) };
}

const signal = () => AbortSignal.timeout(5000);

async function code(p: Promise<unknown>): Promise<BackendError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof BackendError) return e;
    throw e;
  }
  throw new Error('ожидалась ошибка');
}

describe('Loki через Grafana 8.5', () => {
  it('узнаёт id по имени один раз и ходит через прокси по id с токеном', async () => {
    const { g, backend } = await setup(grafana85({ id: 7 }));
    expect((await backend.check(signal())).labelNames).toEqual(['cluster', 'container', 'namespace']);
    await backend.check(signal());
    const paths = g.requests.map((r) => new URL(r.url, 'http://x').pathname);
    expect(paths).toEqual([
      '/api/datasources/id/Loki',
      '/api/datasources/proxy/7/loki/api/v1/labels',
      '/api/datasources/proxy/7/loki/api/v1/labels',
    ]);
    expect(g.requests.every((r) => r.headers.authorization === `Bearer ${TOKEN}`)).toBe(true);
  });

  it('узнаёт id по uid из настроек интерфейса Grafana', async () => {
    const { g, backend } = await setup(grafana85({ id: 9 }), { uid: 'P8E80F9AEF21F6940' });
    await backend.check(signal());
    expect(new URL(g.requests[0]!.url, 'http://x').pathname).toBe('/api/frontend/settings');
    expect(g.requests[1]!.url).toContain('/api/datasources/proxy/9/');
  });

  it('с id из настройки сразу идёт в прокси', async () => {
    const { g, backend } = await setup(grafana85({ id: 3 }), { id: 3 });
    await backend.check(signal());
    expect(g.requests).toHaveLength(1);
  });

  it('сообщает, что источник не найден, и называет его', async () => {
    const { backend } = await setup((_q, res) => json(res, 404, { message: 'Data source not found' }));
    const e = await code(backend.check(signal()));
    expect(e.code).toBe('not-found');
    expect(e.details).toContain('имя Loki');
  });

  it('сбрасывает id, если прокси ответил 404, и узнаёт заново', async () => {
    let id = 7;
    const { g, backend } = await setup((req, res) => grafana85({ id })(req, res, {} as never));
    await backend.check(signal());
    id = 8;
    expect((await code(backend.check(signal()))).code).toBe('not-found');
    await backend.check(signal());
    expect(g.requests.at(-1)!.url).toContain('/proxy/8/');
  });

  it('запрашивает значения метки с селектором', async () => {
    const { g, backend } = await setup(grafana85());
    const values = await backend.labelValues(
      'namespace',
      [{ label: 'namespace', op: '=~', value: 'pay-pr-\\d{1,6}' }, { label: 'container', op: '!=', value: 'pgadmin' }],
      { fromMs: 0, toMs: 1000 },
      signal(),
    );
    expect(values).toContain('pay-pr-92');
    const q = new URL(g.requests.at(-1)!.url, 'http://x').searchParams;
    expect(q.get('query')).toBe('{namespace=~"pay-pr-\\\\d{1,6}", container!="pgadmin"}');
    expect(q.get('start')).toBe('0');
    expect(q.get('end')).toBe('1000000000');
  });

  const labelAnswer = (body: unknown) =>
    setup((req, res) => (req.url!.startsWith('/api/datasources/id/') ? json(res, 200, { id: 7 }) : json(res, 200, body)));
  const readLabel = (backend: Awaited<ReturnType<typeof setup>>['backend']) =>
    backend.labelValues('app_kubernetes_io_sub_service', [{ label: 'namespace', op: '=', value: 'pay' }], { fromMs: 0, toMs: 1000 }, signal());

  it.each([
    ['без поля data', { status: 'success' }],
    ['с data: null', { status: 'success', data: null }],
  ])('метка без значений: ответ %s даёт пустой список', async (_name, body) => {
    const { backend } = await labelAnswer(body);
    expect(await readLabel(backend)).toEqual([]);
  });

  it('значения метки не списком остаются битым ответом', async () => {
    const { backend } = await labelAnswer({ status: 'success', data: 'nope' });
    expect((await code(readLabel(backend))).code).toBe('bad-response');
  });

  it.each([
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [503, 'overloaded'],
  ])('HTTP %i → %s', async (status, expected) => {
    const { backend } = await setup((_q, res) => json(res, status, { message: 'x' }));
    expect((await code(backend.check(signal()))).code).toBe(expected);
  });

  it('считает HTML-страницу и перенаправление отказом в правах', async () => {
    const html = await setup((_q, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>Grafana login</html>');
    });
    expect((await code(html.backend.check(signal()))).code).toBe('forbidden');
    const redirect = await setup((_q, res) => {
      res.writeHead(302, { location: '/login' });
      res.end();
    });
    const e = await code(redirect.backend.check(signal()));
    expect(e.code).toBe('forbidden');
    expect(e.details).toContain('/login');
  });

  it('берёт срок повтора у перегруженной Grafana', async () => {
    const { backend } = await setup((_q, res) => json(res, 429, { message: 'too many outstanding requests' }, { 'retry-after': '12' }));
    const e = await code(backend.check(signal()));
    expect(e).toMatchObject({ code: 'overloaded', retryAfterSeconds: 12 });
  });

  it('распознаёт лимит Loki', async () => {
    const { backend } = await setup((req, res) =>
      req.url!.startsWith('/api/datasources/id/') ? json(res, 200, { id: 7 }) : (res.writeHead(400), res.end('max entries limit per query exceeded')),
    );
    expect((await code(backend.check(signal()))).code).toBe('limit');
  });

  it('не пускает токен в текст ошибки', async () => {
    const { backend } = await setup((req, res) => {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(`proxy error, header: ${req.headers.authorization}`);
    });
    const e = await code(backend.check(signal()));
    expect(JSON.stringify({ d: e.details, m: e.message })).not.toContain(TOKEN);
  });

  it('распознаёт битый ответ', async () => {
    const { backend } = await setup((req, res) =>
      req.url!.startsWith('/api/datasources/id/') ? json(res, 200, { id: 7 }) : json(res, 200, { status: 'success', data: 'nope' }),
    );
    expect((await code(backend.check(signal()))).code).toBe('bad-response');
  });

  it('сообщает о недоступной сети', async () => {
    const { g, backend } = await setup(grafana85());
    await g.close();
    servers = [];
    expect((await code(backend.check(signal()))).code).toBe('network');
  });
});

describe('Loki через новую Grafana: прокси только по uid', () => {
  const paths = (g: Awaited<ReturnType<typeof setup>>['g']) => g.requests.map((r) => new URL(r.url, 'http://x').pathname);
  const LABELS_BY_UID = '/api/datasources/proxy/uid/loki/loki/api/v1/labels';

  it('после 404 по id берёт uid из настроек интерфейса и дальше ходит по нему', async () => {
    const { g, backend } = await setup(grafanaUid({ id: 1 }));
    expect((await backend.check(signal())).labelNames).toEqual(['cluster', 'container', 'namespace']);
    await backend.check(signal());
    expect(paths(g)).toEqual(['/api/datasources/id/Loki', '/api/datasources/proxy/1/loki/api/v1/labels', '/api/frontend/settings', LABELS_BY_UID, LABELS_BY_UID]);
  });

  it('uid в настройке, а числового id в настройках интерфейса нет: сразу путь по uid', async () => {
    const { g, backend } = await setup(grafanaUid({ withId: false }), { uid: 'loki' });
    await backend.check(signal());
    expect(paths(g)).toEqual(['/api/frontend/settings', LABELS_BY_UID]);
  });

  it('uid в настройке и числовой id в настройках интерфейса: после 404 по id путь по uid без новых запросов', async () => {
    const { g, backend } = await setup(grafanaUid({ id: 1 }), { uid: 'loki' });
    await backend.check(signal());
    expect(paths(g)).toEqual(['/api/frontend/settings', '/api/datasources/proxy/1/loki/api/v1/labels', LABELS_BY_UID]);
  });

  it('id в настройке: после 404 находит uid по этому id', async () => {
    const { g, backend } = await setup(grafanaUid({ id: 1 }), { id: 1 });
    await backend.check(signal());
    expect(paths(g)).toEqual(['/api/datasources/proxy/1/loki/api/v1/labels', '/api/frontend/settings', LABELS_BY_UID]);
  });

  it('источника нет ни по id, ни по uid: «не найден» с его именем', async () => {
    const { backend } = await setup((req, res) => (req.url!.startsWith('/api/datasources/id/') ? json(res, 200, { id: 1 }) : json(res, 404, { message: 'Not found' })));
    const e = await code(backend.check(signal()));
    expect(e.code).toBe('not-found');
    expect(e.details).toContain('имя Loki');
  });
});

describe('корпоративный прокси', () => {
  it('ходит в Grafana туннелем через прокси из HTTP_PROXY', async () => {
    const grafana = await fakeGrafana(grafana85({ id: 4 }));
    servers.push(grafana);
    const grafanaPort = Number(new URL(grafana.url).port);
    const tunnels: string[] = [];
    const proxy = createServer();
    proxy.on('connect', (req, client, head) => {
      tunnels.push(req.url ?? '');
      const upstream = connect(grafanaPort, '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
    });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
    servers.push({ close: () => new Promise<void>((r) => (proxy.closeAllConnections(), proxy.close(() => r()))) });
    const backend = new LokiGrafanaBackend(
      {
        type: 'loki-grafana',
        url: 'http://grafana.demo.invalid',
        datasource: { name: 'Loki' },
        tokenEnv: 'T',
        token: TOKEN,
        ca: undefined,
        maxConcurrent: 4,
        queueTimeoutSeconds: 10,
        timeoutSeconds: 30,
      },
      { env: { HTTP_PROXY: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}` } },
    );
    expect((await backend.check(signal())).labelNames).toEqual(['cluster', 'container', 'namespace']);
    expect(tunnels[0]).toBe('grafana.demo.invalid:80');
    expect(grafana.requests.map((r) => new URL(r.url, 'http://x').pathname)).toEqual([
      '/api/datasources/id/Loki',
      '/api/datasources/proxy/4/loki/api/v1/labels',
    ]);
  });

  it('без переменных прокси ходит напрямую', () => {
    expect(dispatcherFor(undefined, {})).toBeUndefined();
  });
});

describe('чтение ответа', () => {
  it('обрывает ответ больше 50 МБ', async () => {
    const g = await fakeGrafana((_q, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      const chunk = Buffer.alloc(1024 * 1024, 0x20);
      let sent = 0;
      const pump = () => {
        while (sent < 60) {
          sent++;
          if (!res.write(chunk)) return res.once('drain', pump);
        }
        res.end();
      };
      pump();
    });
    servers.push(g);
    const e = await code(getJson(g.url, { signal: signal() }));
    expect(e.code).toBe('too-large');
  });

  it('прерывается по тайм-ауту сигнала', async () => {
    const g = await fakeGrafana(() => {});
    servers.push(g);
    const e = await code(getJson(g.url, { signal: AbortSignal.timeout(100) }));
    expect(e.code).toBe('timeout');
  });
});

describe('ссылка в Explore', () => {
  const selector = [
    { label: 'cluster', op: '=' as const, value: 'demo' },
    { label: 'namespace', op: '=' as const, value: 'pay' },
  ];
  const range = { fromMs: 1762068000000, toMs: 1762068600000 };
  const query = (filters: Filter[] = []): ExploreQuery => ({ selector, filters, range });
  const backend = (over: Partial<ResolvedLoki> = {}) =>
    new LokiGrafanaBackend({ type: 'loki-grafana', url: 'http://grafana.example:3000', datasource: { name: 'Loki' }, tokenEnv: 'T', token: TOKEN, ca: undefined, maxConcurrent: 4, queueTimeoutSeconds: 10, timeoutSeconds: 30, ...over });
  const decode = (url: string) => JSON.parse(decodeURIComponent(url.slice(url.indexOf('?left=') + 6))) as { datasource: string; queries: { refId: string; expr: string }[]; range: { from: string; to: string } };

  it('форма адреса Grafana 8.5: объект, границы строками, выражение как у чтения строк', () => {
    const filters: Filter[] = [{ kind: 'contains', value: 'a"b|{c} Тест' }, { kind: 'regex', pattern: '7700[ ()-]{0,3}900' }];
    const url = backend().exploreUrl(query(filters))!;
    expect(url.startsWith('http://grafana.example:3000/explore?left=')).toBe(true);
    expect(decode(url)).toEqual({ datasource: 'Loki', queries: [{ refId: 'A', expr: linesLogql(selector, filters) }], range: { from: '1762068000000', to: '1762068600000' } });
    expect(url).not.toContain(TOKEN);
  });

  it('источник именем или uid; числом — ссылки нет', () => {
    expect(decode(backend({ datasource: { uid: 'abc' } }).exploreUrl(query())!).datasource).toBe('abc');
    expect(backend({ datasource: { id: 3 } }).exploreUrl(query())).toBeUndefined();
  });

  it('выключена или адрес нельзя показать: ссылки нет', () => {
    expect(backend({ exploreLink: false }).exploreUrl(query())).toBeUndefined();
    expect(backend({ url: 'https://user:secret@grafana.example' }).exploreUrl(query())).toBeUndefined();
  });

  it('publicUrl: ссылка на него, а чтение логов по url; учётные данные в url ему не мешают', () => {
    const b = backend({ url: 'https://user:secret@grafana.example', publicUrl: 'https://grafana.public.example' });
    expect(b.exploreUrl(query())!.startsWith('https://grafana.public.example/explore?left=')).toBe(true);
  });

  it('подпуть и конечная косая черта', () => {
    expect(backend({ publicUrl: 'https://grafana-host.example/grafana/' }).exploreUrl(query())!.startsWith('https://grafana-host.example/grafana/explore?left=')).toBe(true);
    expect(backend({ url: 'https://grafana-host.example/grafana/' }).exploreUrl(query())!.startsWith('https://grafana-host.example/grafana/explore?left=')).toBe(true);
  });

  it('предел длины: ровно 6000 отдаётся, 6001 — нет', () => {
    const b = backend();
    const short = b.exploreUrl(query([{ kind: 'contains', value: '' }]))!;
    const exact = b.exploreUrl(query([{ kind: 'contains', value: 'x'.repeat(MAX_EXPLORE_URL - short.length) }]))!;
    expect(exact.length).toBe(MAX_EXPLORE_URL);
    expect(b.exploreUrl(query([{ kind: 'contains', value: 'x'.repeat(MAX_EXPLORE_URL - short.length + 1) }]))).toBeNull();
  });

  it('значения с одной маской дают посимвольно один адрес', () => {
    const address = (raw: string) => {
      const t = detectTerm(raw);
      if ('error' in t) throw new Error('ожидалось значение');
      return backend().exploreUrl(query([linkFilter(t)!.filter]))!;
    };
    expect(address('+44 7700 900001')).toBe(address('+44 2079 460001'));
    expect(address('4111111234557893')).toBe(address('4111119999957893'));
    expect(address('30101900000011')).toBe(address('40202800000011'));
    expect(decodeURIComponent(address('4111111234557893'))).not.toContain('4111111234557893');
    expect(decodeURIComponent(address('+44 7700 900001'))).not.toContain('7700900001');
    // Региональные правила демо-проекта: местный номер, паспорт и личный номер по образцам.
    setRegional({ phone: { countryCode: '44', nationalDigits: 10, trunkPrefix: '0' }, patterns: { passport: ['[A-Z]{2}\\d{7}'], national_id: ['[A-Z]{2}\\d{6}[A-D]'] } });
    try {
      expect(address('+44 7700 900001')).toBe(address('02079 460001'));
      expect(address('AA0000001')).toBe(address('AA9999901'));
      expect(address('ZZ000101A')).toBe(address('ZZ999101A'));
      expect(decodeURIComponent(address('AA0000001'))).not.toContain('AA0000001');
    } finally {
      setRegional(null);
    }
  });

  it('к Grafana не уходит ни одного запроса', async () => {
    const g = await fakeGrafana(grafana85());
    servers.push(g);
    const b = backend({ url: g.url });
    expect(b.exploreUrl(query())).toContain('/explore?left=');
    expect(g.requests).toEqual([]);
  });

  it('у имитации метода нет', () => {
    expect((new MockBackend({ type: 'mock', dataset: 'pay', latencyMs: 0, maxConcurrent: 4, queueTimeoutSeconds: 10, timeoutSeconds: 30 }) as { exploreUrl?: unknown }).exploreUrl).toBeUndefined();
  });
});
