import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeRequest {
  url: string;
  headers: IncomingMessage['headers'];
  closedEarly: boolean;
  closedAt?: number;
}

export type Handler = (req: IncomingMessage, res: ServerResponse, record: FakeRequest) => void;

/** Поддельная Grafana на локальном порту. Обработчик задаёт каждый тест. */
export async function fakeGrafana(handler: Handler) {
  const requests: FakeRequest[] = [];
  const server = createServer((req, res) => {
    const record: FakeRequest = { url: req.url ?? '', headers: req.headers, closedEarly: false };
    requests.push(record);
    res.on('close', () => {
      if (!res.writableFinished) {
        record.closedEarly = true;
        record.closedAt = Date.now();
      }
    });
    handler(req, res, record);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

export function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

/** Типовая Grafana 8.5: id источника по имени, прокси по id. */
export function grafana85(opts: { id?: number; labels?: string[]; values?: string[] } = {}): Handler {
  const id = opts.id ?? 7;
  return (req, res) => {
    const u = new URL(req.url ?? '', 'http://x');
    if (u.pathname === '/api/datasources/id/Loki') return json(res, 200, { id });
    if (u.pathname === '/api/frontend/settings')
      return json(res, 200, { datasources: { Loki: { id, uid: 'P8E80F9AEF21F6940', type: 'loki' } } });
    if (u.pathname === `/api/datasources/proxy/${id}/loki/api/v1/labels`)
      return json(res, 200, { status: 'success', data: opts.labels ?? ['namespace', 'cluster', 'container'] });
    if (u.pathname === `/api/datasources/proxy/${id}/loki/api/v1/label/namespace/values`)
      return json(res, 200, { status: 'success', data: opts.values ?? ['pay', 'pay-pr-92', 'pay-pr-105', 'pay-pr-test'] });
    json(res, 404, { message: 'Not found' });
  };
}

/** Новая Grafana (13): id по имени ещё отвечает, а прокси только по uid. */
export function grafanaUid(opts: { id?: number; withId?: boolean } = {}): Handler {
  const id = opts.id ?? 1;
  return (req, res) => {
    const u = new URL(req.url ?? '', 'http://x');
    if (u.pathname === '/api/datasources/id/Loki') return json(res, 200, { id });
    if (u.pathname === '/api/frontend/settings')
      return json(res, 200, { datasources: { Loki: { ...(opts.withId === false ? {} : { id }), uid: 'loki', name: 'Loki', type: 'loki' } } });
    if (u.pathname === '/api/datasources/proxy/uid/loki/loki/api/v1/labels')
      return json(res, 200, { status: 'success', data: ['namespace', 'cluster', 'container'] });
    json(res, 404, { message: 'Not found' });
  };
}
