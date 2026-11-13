import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { luhnValid } from '@threadline/core';
import { extractNested, parseLine, type LinesPageResponse, type RequestDetail, type SearchState, type ViewRecord } from '@threadline/core/search';
import { buildApp } from '../src/app.ts';
import { generatePayDataset } from '../src/backends/mock/dataset-pay.ts';
import { MockBackend } from '../src/backends/mock/index.ts';
import { Backends } from '../src/backends/registry.ts';
import { loadConfig } from '../src/config/load.ts';
import { SearchJobs } from '../src/search/jobs.ts';

// Запрос api через шлюз с сырым HTTP и вложенные тела на синтетическом наборе: поиск, сшивка и маскирование на выходе.

const ANCHOR = Date.UTC(2026, 10, 2, 9, 0, 0);

const YAML = `
auth: off
defaults: { project: pay, environment: demo }
backends:
  demo: { type: mock }
projects:
  pay:
    name: Demo Pay
    environments:
      demo:
        name: Демо
        backend: demo
        selector: [{ label: namespace, op: "=", value: pay }]
`;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup(): Promise<FastifyInstance> {
  const dir = await mkdtemp(join(tmpdir(), 'threadline-gateway-'));
  await writeFile(join(dir, 'threadline.yaml'), YAML);
  const config = await loadConfig({ path: join(dir, 'threadline.yaml'), env: {} });
  const backends = new Backends(config, { createAdapter: (_id, cfg) => new MockBackend(cfg as never, { anchorMs: ANCHOR }) });
  const jobs = new SearchJobs({ now: () => ANCHOR + 1000, timer: false });
  const app = await buildApp({ config, backends, logger: false, now: () => ANCHOR + 1000, jobs });
  cleanups.push(async () => {
    jobs.close();
    await app.close();
  });
  return app;
}

async function search(app: FastifyInstance, terms: string[]): Promise<SearchState> {
  const r = await app.inject({ method: 'POST', url: '/api/projects/pay/envs/demo/searches', payload: { terms, period: { preset: '24h' } } });
  expect(r.statusCode, r.body).toBe(200);
  const { id } = r.json() as { id: string };
  for (let i = 0; i < 500; i++) {
    const s = (await app.inject(`/api/searches/${id}`)).json() as SearchState;
    if (s.status !== 'running') return s;
    await new Promise((res) => setTimeout(res, 5));
  }
  throw new Error('поиск не завершился');
}

async function detail(app: FastifyInstance, s: SearchState, cid: string): Promise<RequestDetail> {
  const r = await app.inject(`/api/searches/${s.id}/requests/${cid}`);
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as RequestDetail;
}

const dataset = generatePayDataset(ANCHOR).records.filter((r) => r.labels.namespace === 'pay');
const parsed = dataset.map((r) => parseLine({ tsNs: String(r.tsNs), line: r.line, labels: r.labels }));
const gatewayRecords = parsed.filter((r) => r.labels.container === 'gateway' && r.kind === 'incoming');

/** Токены Bearer шлюза и JWT исходящих вызовов api в сырых строках набора. */
const tokens = [...new Set(dataset.flatMap((r) => [...r.line.matchAll(/Bearer ([A-Za-z0-9._~+/=-]{20,})/g)].map((m) => m[1]!)))];

/** Последовательности 15–19 цифр с проверкой Луна, кроме correlation_id, request_id и служебного времени. */
function leakedPans(body: unknown): string[] {
  const keep = new Set<string>();
  const text = JSON.stringify(body, (k, v: unknown) => {
    if ((k === 'correlationId' || k === 'requestId') && typeof v === 'string') keep.add(v);
    return k === 'tsNs' || k === 'id' || k === 'pairId' ? undefined : v;
  });
  return [...text.matchAll(/(?<!\d)\d{15,19}(?!\d)/g)].map((m) => m[0]).filter((d) => luhnValid(d) && !keep.has(d));
}

describe('запрос api через шлюз', () => {
  it('в наборе вход api — запись шлюза, «incoming request» api не пишет', () => {
    expect(gatewayRecords.length).toBeGreaterThan(5);
    expect(parsed.some((r) => r.labels.container === 'api' && r.kind === 'incoming')).toBe(false);
    expect(parsed.some((r) => r.labels.container === 'cards' && r.kind === 'incoming')).toBe(true);
    for (const g of gatewayRecords) {
      expect(g.level).toBe('DEBUG');
      expect(g.correlationId).not.toBeNull();
      const own = parsed.filter((r) => r.correlationId === g.correlationId);
      expect(own.some((r) => r.labels.container === 'api')).toBe(true);
      // X-Request-Id шлюза — request_id исходящих вызовов api.
      const sends = own.filter((r) => r.kind === 'send');
      expect(sends.every((r) => r.requestId === g.requestId)).toBe(true);
    }
    expect(tokens.length).toBeGreaterThan(gatewayRecords.length);
  });

  it('поиск по user_id, который есть только в записи шлюза, находит запрос со всеми записями', async () => {
    const app = await setup();
    const g = gatewayRecords.find((r) => parsed.filter((x) => x.correlationId === r.correlationId).length >= 3)!;
    const path = g.uri!;
    const user = /^\/v1\/users\/([^/]+)\//.exec(path)![1]!;
    expect(dataset.filter((r) => r.line.includes(user))).toHaveLength(dataset.filter((r) => r.line.includes(user) && (r.labels.container === 'gateway')).length);

    const s = await search(app, [user]);
    expect(s.status).toBe('done');
    const summary = s.requests.find((r) => r.correlationId === g.correlationId)!;
    const own = parsed.filter((r) => r.correlationId === g.correlationId);
    expect(summary).toMatchObject({
      incoming: { method: g.method!, path },
      component: 'api',
      recordCount: own.length,
    });
    expect(summary.kind).not.toBe('background');

    const d = await detail(app, s, g.correlationId!);
    expect(d.records).toHaveLength(own.length);
    expect(d.records[0]).toMatchObject({ kind: 'incoming', component: 'gateway', title: `${g.method!} ${path}` });
    expect(d.records.slice(1).every((r) => r.component === 'api')).toBe(true);
    expect((d.records[0]!.sections.headers as Record<string, string[]>).Authorization).toEqual(['Bearer ***']);
  });

  it('токены Authorization шлюза и api нигде в ответах', async () => {
    const app = await setup();
    const s = await search(app, ['raw_request']);
    const out: unknown[] = [s];
    for (const r of s.requests) out.push(await detail(app, s, r.correlationId));
    let cursor: string | null = null;
    for (let i = 0; i < 50; i++) {
      const page = (await app.inject(`/api/searches/${s.id}/lines${cursor ? `?cursor=${cursor}` : ''}`)).json() as LinesPageResponse;
      out.push(page);
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    const text = JSON.stringify(out);
    expect(text).toContain('Authorization: Bearer ***');
    for (const t of tokens) expect(text).not.toContain(t);
    expect(leakedPans(out)).toEqual([]);
    const sends = out.flatMap((x) => ((x as RequestDetail).records ?? []).filter((r: ViewRecord) => r.kind === 'send' && r.sections.headers));
    const auth = sends.map((r) => (r.sections.headers as Record<string, string[]>).Authorization).filter(Boolean);
    expect(auth.length).toBeGreaterThan(0);
    expect(auth.every((a) => a!.every((v) => v === 'Bearer ***' || v.startsWith('Basic ***')))).toBe(true);
  });
});

describe('вложенные тела', () => {
  it('номер карты во вложенном теле третьего уровня замаскирован сервером', async () => {
    const app = await setup();
    const raw = dataset.find((r) => r.line.includes('soap-proxy') && r.line.includes('http request sending'))!;
    // В сырой строке номер лежит полностью: JSON → SOAP строкой → JSON в теге → JSON строкой.
    const pan = [...raw.line.matchAll(/(?<!\d)\d{16}(?!\d)/g)].map((m) => m[0]).find(luhnValid)!;
    expect(pan).toBeDefined();

    const s = await search(app, ['soap-proxy']);
    expect(s.requests).toHaveLength(1);
    const d = await detail(app, s, s.requests[0]!.correlationId);
    expect(JSON.stringify(d)).not.toContain(pan);
    expect(leakedPans(d)).toEqual([]);

    const send = d.records.find((r) => r.kind === 'send')!;
    const nested = extractNested(send.sections.body!);
    expect(nested.map((b) => `${b.path} · ${b.lang}`)).toEqual([
      'envelope · xml',
      'envelope.Envelope.Body.checkFee.payload · json',
      'envelope.Envelope.Body.checkFee.payload.card · json',
    ]);
    expect(nested[2]!.text).toContain(`"number": "${pan.slice(0, 6)}******${pan.slice(-4)}"`);

    const response = d.records.find((r) => r.kind === 'response')!;
    expect(extractNested(response.sections.body!).map((b) => `${b.path} · ${b.lang}`)).toEqual(['Envelope.Body.checkFeeResponse.details · json']);
    expect(d.summary).toMatchObject({ status: 'success', component: 'api' });
  });
});
