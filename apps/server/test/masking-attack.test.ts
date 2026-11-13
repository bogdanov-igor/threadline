// Попытки обойти маску на настоящем сервере: имитация хранилища с враждебными записями, база в памяти.
// Значения выдуманы, номера карт тестовые, сети нет.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BackendError } from '@threadline/core/backend';
import { buildApp } from '../src/app.ts';
import { LOCAL_VIEWER } from '../src/auth/access.ts';
import type { MockRecord } from '../src/backends/mock/dataset-pay.ts';
import { MockBackend } from '../src/backends/mock/index.ts';
import { Backends } from '../src/backends/registry.ts';
import { valueIssue } from '../src/operation/values.ts';
import { loadConfig } from '../src/config/load.ts';
import type { CatalogService } from '../src/catalog/service.ts';
import { ownSecrets, ownSecretScrubber } from '../src/search/own-secrets.ts';
import { insertLink } from '../src/share/store.ts';
import { storedTerm } from '../src/share/routes.ts';
import { DEMO_REGIONAL } from './demo-regional.ts';

const GRAFANA = 'glsaSynthOwnGrafanaTokenZX01';
const SESSION = 'synth-session-secret/for+attack=0123456789';
const OIDC = 'synth-oidc-client-secret-ZX02';
const TELEGRAM = '123456:SynthTelegramBotTokenZX03';
const OWN = [GRAFANA, SESSION, OIDC, TELEGRAM];
const CARD = '4111111234557893';

const YAML = `
auth: off
defaults: { project: pay, environment: prod }
backends:
  graf: { type: loki-grafana, url: 'https://grafana.example', tokenEnv: ATTACK_GRAFANA_TOKEN, datasource: { name: Loki } }
projects:
  pay:
    name: Demo Pay
    retentionDays: 30
    environments:
      prod: { name: Прод, backend: graf, selector: [{ label: namespace, op: '=', value: pay }] }
${DEMO_REGIONAL}`;

const LABELS = { cluster: 'c', namespace: 'pay', container: 'api', app_kubernetes_io_component: 'api' };
const T0 = Date.now() - 20 * 60_000;
let tick = 0;
const records: MockRecord[] = [];
/** Запись встроенного формата json: время, уровень, сообщение, correlation_id и поля записи. */
function line(cid: string, msg: string, fields: Record<string, unknown>, level = 200): void {
  const ms = T0 + tick++ * 50;
  const time = new Date(ms).toISOString().replace('Z', '000+00:00');
  records.push({ tsNs: BigInt(ms) * 1_000_000n, labels: LABELS, line: JSON.stringify({ time, level: level === 400 ? 'error' : 'info', msg, correlation_id: cid, ...fields }) });
}
/** Запись лога: остальной контекст в ctx, request_id отдельным полем. */
function log(cid: string, message: string, ctx: Record<string, unknown>, level = 200, requestId?: string): void {
  line(cid, message, { ...(requestId ? { request_id: requestId } : {}), ...(Object.keys(ctx).length > 0 ? { ctx } : {}) }, level);
}

// Собственные секреты в тексте, контексте и теле записи.
log('cid-own-1', `upstream token is ${GRAFANA}`, { session: SESSION, oidc: OIDC, tg: TELEGRAM }, 400);
line('cid-own-1', 'http response received', { request_id: 'r-own', upstream: { method: 'POST', url: `https://partner.example/x?k=${encodeURIComponent(SESSION)}`, status: 500, headers: {}, body: JSON.stringify({ note: GRAFANA }) } });
line('cid-own-1', 'http request sending', { request_id: 'r-own', upstream: { method: 'POST', url: 'https://partner.example/x', headers: {}, body: JSON.stringify({ a: OIDC }) } });
// Номер карты в id одного запроса и в тексте другого, найденных одним поиском.
log('cid-keep-a', 'keeptag-777888 first', {}, 200, CARD);
log('cid-keep-b', `keeptag-777888 card ${CARD}`, { card: CARD });
log(CARD, 'keeptag-222333 own correlation id', {});
log('cid-keep-c', `keeptag-222333 card ${CARD}`, { card: CARD });
// Для ссылки: больше одной страницы «Всех записей».
for (let i = 0; i < 130; i++) log(`cid-page-${i}`, `pagetag-555666 запись ${i}`, {});

let app: FastifyInstance;
let catalog!: CatalogService;
const clock = { t: Date.now() };
const failure = { lines: null as string | null, check: null as string | null };
const saved = new Map<string, string | undefined>();

const as = (role?: string) => (role && role !== 'no-login' ? { 'x-test-role': role } : {});
const get = (url: string, role?: string) => app.inject({ url, headers: as(role) });
const openOwn = (text: string) => OWN.filter((v) => text.includes(v) || text.includes(encodeURIComponent(v)));

async function search(terms: string[], role?: string, excludes?: string[]): Promise<string> {
  const r = await app.inject({ method: 'POST', url: '/api/projects/pay/envs/prod/searches', headers: as(role), payload: { terms, ...(excludes ? { excludes } : {}), period: { preset: '1h' }, fresh: true } });
  expect(r.statusCode, r.body).toBe(200);
  const { id } = r.json() as { id: string };
  await vi.waitFor(async () => expect((await get(`/api/searches/${id}`, role)).json().status).not.toBe('running'), { timeout: 10_000 });
  return id;
}

async function share(searchId: string): Promise<string> {
  const r = await app.inject({ method: 'POST', url: '/api/share', payload: { kind: 'results', searchId } });
  expect(r.statusCode, r.body).toBe(201);
  return (r.json() as { path: string }).path.split('/').pop()!;
}

async function run(linkId: string): Promise<void> {
  expect((await app.inject({ method: 'POST', url: `/api/s/${linkId}/run` })).statusCode).toBe(200);
  await vi.waitFor(async () => expect((await get(`/api/s/${linkId}/state`)).json().status).not.toBe('running'), { timeout: 10_000 });
}

beforeAll(async () => {
  for (const [k, v] of [['THREADLINE_SESSION_SECRET', SESSION], ['THREADLINE_OIDC_CLIENT_SECRET', OIDC], ['THREADLINE_TELEGRAM_BOT_TOKEN', TELEGRAM]] as const) {
    saved.set(k, process.env[k]);
    process.env[k] = v;
  }
  const dir = await mkdtemp(join(tmpdir(), 'threadline-attack-'));
  await writeFile(join(dir, 'threadline.yaml'), YAML);
  await mkdir(join(dir, 'catalog'));
  await writeFile(join(dir, 'catalog', 'pay.yaml'), 'version: 1\nproject: pay\n');
  const config = await loadConfig({ path: join(dir, 'threadline.yaml'), env: { ATTACK_GRAFANA_TOKEN: GRAFANA } });
  const mock = new MockBackend({ type: 'mock', latencyMs: 0 } as never, { flowScenarios: false });
  mock.records.length = 0;
  mock.records.push(...records);
  const check = mock.check.bind(mock);
  mock.check = async (s) => {
    if (failure.check) throw new BackendError('unauthorized', { status: 401, details: failure.check });
    return check(s);
  };
  const lines = mock.queryLines.bind(mock);
  mock.queryLines = async (q, s) => {
    if (failure.lines) throw new BackendError('bad-response', { details: failure.lines });
    return lines(q, s);
  };
  const count = mock.countBy.bind(mock);
  mock.countBy = async (q, s) => {
    if (failure.lines) throw new BackendError('bad-response', { details: failure.lines });
    return count(q, s);
  };
  const backends = new Backends(config, { createAdapter: () => mock });
  app = await buildApp({
    config,
    backends,
    databaseUrl: 'pglite://memory',
    now: () => clock.t,
    testViewer: (req) => {
      const role = req.headers['x-test-role'];
      return role === undefined ? LOCAL_VIEWER : { owner: `owner-${String(role)}`, role: role as never, name: null };
    },
    onCatalog: (c) => {
      catalog = c;
    },
  });
  await app.ready();
  await vi.waitFor(() => expect(catalog.state().state).toBe('ok'), { timeout: 20_000 });
}, 40_000);

afterAll(async () => {
  await app.close();
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('собственные секреты', () => {
  it.each(['no-login', 'business', 'support', 'developer', 'analyst', 'admin'])('%s: нет ни в одном ответе с записями', async (role) => {
    const id = await search(['cid-own-1'], role);
    for (const url of [`/api/searches/${id}`, `/api/searches/${id}/requests/cid-own-1`, `/api/searches/${id}/lines`, `/api/searches/${id}/requests/cid-own-1/reveal`]) {
      const r = await get(url, role);
      expect(openOwn(r.body), `${url}: ${r.statusCode}`).toEqual([]);
    }
  }, 30_000);

  it('нет по короткой ссылке и в «Неизвестном», текст записи вокруг на месте', async () => {
    const link = await share(await search(['cid-own-1']));
    await run(link);
    for (const url of [`/api/s/${link}/state`, `/api/s/${link}/requests/cid-own-1`, `/api/s/${link}/lines`]) expect(openOwn((await get(url)).body), url).toEqual([]);
    expect((await get(`/api/s/${link}/requests/cid-own-1`)).body).toContain('upstream token is ***');
    const stored = await catalog.readDb()!.query('select * from catalog_unknown');
    expect(openOwn(JSON.stringify(stored))).toEqual([]);
    expect(openOwn((await get('/api/projects/pay/catalog/unknown')).body)).toEqual([]);
  }, 30_000);

  it('текст ошибки хранилища: задание, чтение, проверка подключения, проба', async () => {
    const quote = `boom ${GRAFANA} ${SESSION} ${OIDC} ${TELEGRAM} client +447700900567 national id ZZ000277A AB7654321 last_name=Атакиев`;
    failure.lines = quote;
    failure.check = quote;
    try {
      const id = await search(['cid-own-1']);
      const pages = [(await get(`/api/searches/${id}`)).body, (await get(`/api/projects/pay/envs/prod/requests/cid-own-1?from=${T0}&to=${T0 + 1000}`)).body, (await get('/api/projects/pay/envs/prod/connection?refresh=1', 'support')).body];
      clock.t += 10_000;
      const probe = await app.inject({ method: 'POST', url: '/api/stores/graf/probe', headers: { ...as('support'), 'content-type': 'application/json' }, payload: {} });
      pages.push(probe.body);
      for (const text of pages) {
        expect(text).toContain('boom ***');
        expect(openOwn(text)).toEqual([]);
        for (const v of ['447700900567', 'ZZ000277A', 'AB7654321', 'Атакиев']) expect(text, v).not.toContain(v);
      }
      clock.t += 70_000;
      expect((await get('/api/projects/pay/envs/prod/connection?refresh=1', 'business')).json().details).toBeUndefined();
    } finally {
      failure.lines = null;
      failure.check = null;
      clock.t += 70_000;
    }
  }, 30_000);

  it('Telegram в списке, короткое значение нет: подмена портила бы сами записи', () => {
    const got = ownSecrets({ backends: {} } as never, { THREADLINE_TELEGRAM_BOT_TOKEN: TELEGRAM, THREADLINE_SESSION_SECRET: 'abc' });
    expect(got).toEqual([TELEGRAM]);
  });

  const b64 = (s: string) => Buffer.from(s).toString('base64');
  const TOK = 'SkOwn+Tok/en=Val3k';
  const B = b64(`u:${TOK}`);

  it.each([
    [`Basic ${B}`, 'Basic ***'],
    [`Basic+${B}`, 'Basic+***'],
    [`Basic%20${B}`, 'Basic%20***'],
    [`Basic\n${B}`, 'Basic\n***'],
    [`Basic%0A${B}`, 'Basic%0A***'],
    [`Basic\\n${B}`, 'Basic\\n***'],
    [`Authorization Basic: ${B}`, 'Authorization Basic: ***'],
    [`{"Authorization":"${B}"}`, '{"Authorization":"***"}'],
    [`x ${b64(TOK)} y`, 'x *** y'],
    [`x ${Buffer.from(TOK).toString('base64url')} y`, 'x *** y'],
    [`x ${encodeURIComponent(TOK)} y`, 'x *** y'],
    [`x ${encodeURIComponent(encodeURIComponent(TOK))} y`, 'x *** y'],
    [`x ${encodeURIComponent(TOK).toLowerCase().replace('skown', 'SkOwn').replace('tok', 'Tok').replace('val3k', 'Val3k')} y`, 'x *** y'],
    [`x ${TOK.replace('/', '\\/')} y`, 'x *** y'],
  ])('подмена: %s', (text, want) => {
    expect(ownSecretScrubber([TOK])(text)).toBe(want);
  });
});

describe('id в чужом запросе не снимает маску', () => {
  const MASK = '411111******7893';

  it.each(['no-login', 'support', 'developer', 'analyst', 'admin'])('%s: request_id и correlation_id другого запроса', async (role) => {
    const byRequestId = await search(['keeptag-777888'], role);
    const b = await get(`/api/searches/${byRequestId}/requests/cid-keep-b`, role);
    expect(b.statusCode).toBe(200);
    expect(b.body).not.toContain(CARD);
    expect(b.body).toContain(MASK);
    const a = await get(`/api/searches/${byRequestId}/requests/cid-keep-a`, role);
    expect(a.json().records.some((r: { requestId: string | null }) => r.requestId === CARD), 'свой request_id открыт').toBe(true);
    const lines = (await get(`/api/searches/${byRequestId}/lines`, role)).json().records as { correlationId: string; title: string }[];
    expect(lines.find((r) => r.correlationId === 'cid-keep-b')!.title).toContain(MASK);
    const byCid = await search(['keeptag-222333'], role);
    expect((await get(`/api/searches/${byCid}`, role)).json().requests.map((r: { correlationId: string }) => r.correlationId), 'свой correlation_id открыт').toContain(CARD);
    expect((await get(`/api/searches/${byCid}/requests/cid-keep-c`, role)).body).not.toContain(CARD);
  }, 40_000);

  it('показ без входа и короткая ссылка: края номера', async () => {
    const id = await search(['keeptag-777888']);
    expect((await get(`/api/searches/${id}/requests/cid-keep-b/reveal`)).body).not.toContain(CARD);
    const link = await share(id);
    await run(link);
    const page = await get(`/api/s/${link}/requests/cid-keep-b`);
    expect(page.statusCode).toBe(200);
    expect(page.body).not.toContain(CARD);
    expect((await get(`/api/s/${link}/lines`)).body).not.toContain(`keeptag-777888 card ${CARD}`);
  }, 30_000);
});

describe('короткие ссылки', () => {
  it.each([
    ['pan=4111111234557893', '411111******7893'],
    ['card:4111111234557893', '411111******7893'],
    ['x4111111234557893', '411111******7893'],
    ['клиент 4111 1112 3455 7893', '411111******7893'],
    ['обычный текст', 'обычный текст'],
  ])('значение текстом %s хранится краями номера', (value, want) => {
    expect(storedTerm({ kind: 'text', value })).toBe(want);
  });

  it('номера нет в строке базы, ссылка открывается и ищет по краям', async () => {
    const id = await search([`pan=${CARD}`], undefined, [`card:5100123456789013`]);
    const link = await share(id);
    const [row] = await catalog.readDb()!.query<{ terms: unknown; target: unknown }>('select terms, target from share_link where id = $1', [link]);
    const text = JSON.stringify(row);
    expect(text).not.toContain(CARD);
    expect(text).not.toContain('5100123456789013');
    expect(row!.terms).toEqual(['411111******7893']);
    expect(row!.target).toEqual({ excludes: ['510012******9013'] });
    const info = await get(`/api/s/${link}`);
    expect(info.statusCode).toBe(200);
    expect(info.json().terms).toEqual([{ display: '411111******7893', kind: 'pan-mask' }]);
  }, 30_000);

  it('одно и то же значение в поиске и исключённых не закрывает ссылку', async () => {
    const id = await search([`pan=${CARD}`], undefined, [`card:${CARD}`]);
    const link = await share(id);
    expect((await get(`/api/s/${link}`)).statusCode).toBe(200);
  }, 30_000);

  it('номер внутри id операции отклонён, обычный id проходит', async () => {
    expect(valueIssue(`card:${CARD}`)).toBe('kind');
    expect(valueIssue(`tx-${CARD}`)).toBe('kind');
    expect(valueIssue('plainopid-0001')).toBeNull();
    expect(valueIssue('5a1d0100-0000-4000-8000-000000000001')).toBeNull();
  });

  it('истёкшая ссылка не читает хранилище, прочитанное остаётся в памяти', async () => {
    const id = 'attackExpiredLink00001';
    const now = clock.t;
    await insertLink(catalog.db(), { id, kind: 'results', projectId: 'pay', envId: 'prod', stand: null, terms: ['pagetag-555666'], fromMs: now - 3_600_000, toMs: now, target: null, createdMs: now, expiresMs: now + 60_000 });
    await run(id);
    const first = await get(`/api/s/${id}/lines`);
    expect(first.statusCode).toBe(200);
    const next = (first.json() as { nextCursor: string | null }).nextCursor;
    expect(next).not.toBeNull();
    const alive = await get(`/api/s/${id}/lines?cursor=${encodeURIComponent(next!)}`);
    expect(alive.statusCode).toBe(200);
    clock.t = now + 120_000;
    const gone = await get(`/api/s/${id}/lines?cursor=${encodeURIComponent(next!)}`);
    expect(gone.statusCode).toBe(404);
    expect(gone.json().error.code).toBe('share-not-found');
    expect((await get(`/api/s/${id}/state`)).statusCode, 'опрос из памяти').toBe(200);
  }, 30_000);
});

describe('поля вида на сервере', () => {
  const put = async (type: string, keys: string[]) => {
    const list = (await get('/api/projects/pay/catalog')).json().masking as { type: string; updatedAt: string; enabled: boolean }[];
    const row = list.find((r) => r.type === type)!;
    return app.inject({ method: 'PUT', url: `/api/projects/pay/catalog/masking/${type}`, payload: { enabled: row.enabled, keys, updatedAt: row.updatedAt } });
  };

  it('enc_pan можно добавить к секретам, к номеру карты нельзя; партнёрское имя на pan работает у номера', async () => {
    expect((await put('secrets', ['enc_pan'])).statusCode).toBe(200);
    const taken = await put('card_number', ['enc_pan']);
    expect(taken.statusCode).toBe(422);
    expect((await put('card_number', ['partner_pan'])).statusCode).toBe(200);
  }, 20_000);
});
