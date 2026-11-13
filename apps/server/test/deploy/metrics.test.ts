// Метрики Prometheus и метки метрик без значений.
import { connect } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Metrics } from '../../src/metrics.ts';
import { mockApp } from './kit.ts';

const LINK_ID = 'AbCdEfGhIjKlMnOpQrStUv';
const PAN = '4111110000000000';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const scrape = async () => (await app!.inject('/metrics')).body;
const value = (text: string, line: string) => {
  const found = text.split('\n').find((l) => l.startsWith(`${line} `));
  return found === undefined ? undefined : Number(found.slice(line.length + 1));
};

describe('/metrics', () => {
  it('открыт, формат Prometheus, есть все метрики', async () => {
    ({ app } = await mockApp());
    await app.inject('/api/projects');
    const r = await app.inject('/metrics');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/plain');
    for (const name of ['http_requests_total', 'http_request_duration_seconds', 'http_requests_in_progress', 'jobs_processed_total', 'jobs_failed_total', 'jobs_duration_seconds', 'jobs_memory_bytes', 'jobs_memory_limit_bytes', 'jobs_memory_evicted_total']) {
      expect(r.body).toContain(`# TYPE ${name} `);
    }
    expect(value(r.body, 'http_requests_total{method="GET",route="/api/projects",status_code="200"}')).toBe(1);
  });

  it('метки: шаблон маршрута, значений и идентификаторов нет, 404 в одной метке', async () => {
    ({ app } = await mockApp());
    await app.inject(`/api/s/${LINK_ID}`);
    await app.inject(`/api/projects/pay/envs/demo/requests/${PAN}`);
    for (let i = 0; i < 50; i++) await app.inject(`/api/unknown-${i}/${PAN}`);
    const text = await scrape();
    expect(text).toContain('route="/api/s/:id"');
    expect(text).not.toContain(LINK_ID);
    expect(text).not.toContain(PAN);
    expect(text).not.toContain('unknown-');
    expect(value(text, 'http_requests_total{method="GET",route="unmatched",status_code="404"}')).toBe(50);
  });

  it('запрос в работе учтён и снят', async () => {
    ({ app } = await mockApp());
    await app.inject('/api/projects');
    expect(value(await scrape(), 'http_requests_in_progress{method="GET",route="/api/projects"}')).toBe(0);
  });

  it('клиент закрыл соединение: в работе 0, код 499', async () => {
    ({ app } = await mockApp());
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = new URL(address);
    const socket = connect(Number(port), '127.0.0.1');
    await new Promise((done) => socket.once('connect', done));
    socket.write('GET /api/projects/pay/envs/slow/connection?refresh=1 HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
    await expect
      .poll(async () => value(await (await fetch(`${address}/metrics`)).text(), 'http_requests_in_progress{method="GET",route="/api/projects/:project/envs/:env/connection"}'))
      .toBe(1);
    socket.destroy();
    await sleep(50);
    await expect
      .poll(async () => {
        const text = await (await fetch(`${address}/metrics`)).text();
        return [
          value(text, 'http_requests_in_progress{method="GET",route="/api/projects/:project/envs/:env/connection"}'),
          value(text, 'http_requests_total{method="GET",route="/api/projects/:project/envs/:env/connection",status_code="499"}'),
        ];
      })
      .toEqual([0, 1]);
  });

  it('запрос, отклонённый раньше обработчика, тоже учтён', async () => {
    ({ app } = await mockApp());
    await app.inject({ method: 'POST', url: '/api/projects/pay/envs/demo/searches', headers: { 'content-type': 'application/json' }, payload: '{"terms":' });
    expect(value(await scrape(), 'http_requests_total{method="POST",route="/api/projects/:project/envs/:env/searches",status_code="400"}')).toBe(1);
  });
});

describe('задания поиска', () => {
  const finished = async (env: string) => {
    const r = await app!.inject({ method: 'POST', url: `/api/projects/pay/envs/${env}/searches`, payload: { terms: ['getCard'], period: { preset: '6h' } } });
    expect(r.statusCode, r.body).toBe(200);
    const { id } = r.json() as { id: string };
    await expect.poll(async () => (await app!.inject(`/api/searches/${id}`)).json().status, { timeout: 10_000, interval: 50 }).not.toBe('running');
  };

  it('успешное задание: обработано, длительность записана, упавших нет', async () => {
    ({ app } = await mockApp());
    await finished('demo');
    await expect.poll(async () => value(await scrape(), 'jobs_processed_total{kind="search"}')).toBe(1);
    const text = await scrape();
    expect(value(text, 'jobs_duration_seconds_count{kind="search"}')).toBe(1);
    expect(value(text, 'jobs_failed_total{kind="search"}')).toBeUndefined();
  });

  it('задание упало: обработано и упало', async () => {
    ({ app } = await mockApp());
    await finished('broken');
    await expect.poll(async () => value(await scrape(), 'jobs_failed_total{kind="search"}')).toBe(1);
    expect(value(await scrape(), 'jobs_processed_total{kind="search"}')).toBe(1);
  });

  it('у двух приложений свои реестры', async () => {
    const a = new Metrics();
    const b = new Metrics();
    await a.trackJob('search', { status: 'failed', start: async () => undefined });
    expect(await a.registry.metrics()).toContain('jobs_failed_total{kind="search"} 1');
    expect(await b.registry.metrics()).not.toContain('jobs_failed_total{kind="search"} 1');
  });
});
