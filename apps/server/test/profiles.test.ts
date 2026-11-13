// Профили формата на сервере: два проекта с разными профилями в одном хранилище, битый профиль при старте,
// встроенный профиль json в config/README.md, проверка профиля на образце строк.
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { CheckInfo, CountQuery, LinesQuery, LogBackend, LogLine, Matcher, TimeRange } from '@threadline/core/backend';
import { BUILTIN_PROFILE, checkProfile, compileProfile, COUNT_GROUP, re2ToJs, type Profile } from '@threadline/core/profile';
import type { RequestDetail, SearchCreated, SearchState } from '@threadline/core/search';
import { buildApp } from '../src/app.ts';
import { matches } from '../src/backends/mock/index.ts';
import { Backends } from '../src/backends/registry.ts';
import { checkSample, sampleLines } from '../src/cli/format-check.ts';
import { ConfigError, loadConfig } from '../src/config/load.ts';
import { SearchJobs } from '../src/search/jobs.ts';
import { compileProjectProfiles } from '../src/search/profiles.ts';
import { ROOT } from '../src/paths.ts';

const T0 = Date.UTC(2026, 10, 2, 8, 0, 0);
const NOW = T0 + 60 * 60_000;

const ACME_YAML = `
  acme:
    component: [container]
    variants:
      - name: app
        when: { labels: { container: app }, has: [rec.ts] }
        layers: [{ name: rec, decode: json }]
        fields:
          time: rec.ts
          level: rec.lvl
          message: rec.msg
          correlationId: rec.trace_id
          requestId: rec.span_id
          method: rec.http.method
          uri: rec.http.url
          status: rec.http.status
          context: rec.extra
        kinds:
          - { kind: incoming, when: { equals: { rec.msg: incoming request } } }
          - { kind: send, when: { equals: { rec.msg: outgoing request } } }
          - { kind: response, when: { equals: { rec.msg: outgoing response } } }
`;

const YAML = (formats = ACME_YAML) => `
auth: off
defaults: { project: pay, environment: demo }
backends:
  mem: { type: mock }
formats:${formats}
projects:
  pay:
    name: Demo Pay
    environments:
      demo: { name: Демо, backend: mem, selector: [{ label: namespace, op: "=", value: pay }] }
  acme:
    name: Acme
    format: acme
    environments:
      demo: { name: Демо, backend: mem, selector: [{ label: namespace, op: "=", value: acme }] }
`;

/** Хранилище в памяти: строки обоих проектов, подсчёт — выражением из запроса, как в Loki. */
class Memory implements LogBackend {
  readonly counts: CountQuery[] = [];
  readonly lines: LogLine[];
  constructor(lines: LogLine[]) {
    this.lines = lines;
  }
  async check(): Promise<CheckInfo> {
    return { labelNames: ['namespace', 'container'] };
  }
  async labelValues(_l: string, _s: Matcher[], _r: TimeRange): Promise<string[]> {
    return [];
  }
  #select(q: { selector: Matcher[]; filters: LinesQuery['filters']; range: TimeRange }): LogLine[] {
    const from = q.range.fromNs !== undefined ? BigInt(q.range.fromNs) : BigInt(Math.trunc(q.range.fromMs)) * 1_000_000n;
    const to = q.range.toNs !== undefined ? BigInt(q.range.toNs) : BigInt(Math.trunc(q.range.toMs)) * 1_000_000n;
    return this.lines.filter((l) => {
      const t = BigInt(l.tsNs);
      return t >= from && t <= to && matches(l.labels, q.selector) && q.filters.every((f) => (f.kind === 'contains' ? l.line.includes(f.value) : f.kind === 'regex' && new RegExp(f.pattern).test(l.line)));
    });
  }
  async queryLines(q: LinesQuery): Promise<LogLine[]> {
    const found = this.#select(q);
    return (q.direction === 'forward' ? found : [...found].reverse()).slice(0, q.limit);
  }
  async countBy(q: CountQuery): Promise<Record<string, number>> {
    this.counts.push(q);
    const re = re2ToJs(q.key.regexp);
    const out: Record<string, number> = {};
    for (const l of this.#select(q)) {
      const k = re.exec(l.line)?.groups?.[COUNT_GROUP];
      if (k) out[k] = (out[k] ?? 0) + 1;
    }
    return out;
  }
}

const ns = (ms: number) => (BigInt(ms) * 1_000_000n).toString();
const acme = (ms: number, rec: Record<string, unknown>): LogLine => ({
  tsNs: ns(ms + 1),
  line: JSON.stringify({ ts: ms, ...rec }),
  labels: { namespace: 'acme', container: 'app' },
});
/** Запись встроенного формата json проекта pay. */
const pay = (ms: number, msg: string, cid: string, fields: Record<string, unknown> = {}): LogLine => ({
  tsNs: ns(ms + 2),
  line: JSON.stringify({ time: new Date(ms).toISOString(), level: 'info', msg, correlation_id: cid, ...fields }),
  labels: { namespace: 'pay', container: 'api', app_kubernetes_io_component: 'api' },
});

const LINES: LogLine[] = [
  acme(T0, { lvl: 'info', msg: 'incoming request', trace_id: 'order-77.a1', http: { method: 'POST', url: '/api/orders/77/pay' } }),
  acme(T0 + 5, { lvl: 'info', msg: 'outgoing request', trace_id: 'order-77.a1', span_id: 's1', http: { method: 'POST', url: 'https://pay.example.test/charge' } }),
  acme(T0 + 35, { lvl: 'info', msg: 'outgoing response', trace_id: 'order-77.a1', span_id: 's1', http: { method: 'POST', url: 'https://pay.example.test/charge', status: 200 } }),
  // Строка Demo Pay с тем же значением в теле в чужом пространстве: проект acme её не видит.
  pay(T0 + 40, 'incoming request', 'pay-cid-000001', { request: { method: 'GET', path: '/v1/orders/order-77' } }),
  pay(T0 + 50, 'job done', 'pay-cid-000001', { request_id: 'r' }),
];

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'threadline-profiles-'));
  await writeFile(join(dir, 'threadline.yaml'), YAML());
  const config = await loadConfig({ path: join(dir, 'threadline.yaml'), env: {} });
  const memory = new Memory(LINES);
  const backends = new Backends(config, { createAdapter: () => memory });
  const jobs = new SearchJobs({ now: () => NOW, timer: false });
  const app = await buildApp({ config, backends, logger: false, now: () => NOW, jobs });
  cleanups.push(async () => {
    jobs.close();
    await app.close();
  });
  return { app, memory };
}

async function search(app: Awaited<ReturnType<typeof setup>>['app'], project: string, term: string): Promise<SearchState> {
  const r = await app.inject({ method: 'POST', url: `/api/projects/${project}/envs/demo/searches`, payload: { terms: [term], period: { preset: '6h' } } });
  expect(r.statusCode, r.body).toBe(200);
  const { id } = r.json<SearchCreated>();
  for (let i = 0; i < 100; i++) {
    const s = (await app.inject({ method: 'GET', url: `/api/searches/${id}` })).json<SearchState>();
    if (s.status !== 'running') return s;
    await new Promise((res) => setTimeout(res, 5));
  }
  throw new Error('поиск не завершился');
}

describe('два проекта с разными профилями в одном хранилище', () => {
  it('каждый поиск считает своим выражением и разбирает строки своим профилем', async () => {
    const { app, memory } = await setup();

    const a = await search(app, 'acme', 'order-77');
    expect(a.status).toBe('done');
    const acmeCounts = memory.counts.length;
    expect(a.requests.map((r) => [r.correlationId, r.component, r.kind, r.incoming])).toEqual([
      ['order-77.a1', 'app', 'incoming', { method: 'POST', path: '/api/orders/77/pay' }],
    ]);
    const detail = (await app.inject({ method: 'GET', url: `/api/searches/${a.id}/requests/order-77.a1` })).json<RequestDetail>();
    expect(detail.records.map((r) => [r.kind, r.title])).toEqual([
      ['incoming', 'POST /api/orders/77/pay'],
      ['send', 'POST pay.example.test/charge'],
      ['response', 'POST pay.example.test/charge → 200'],
    ]);
    expect(detail.records[2]!.http?.pairId).toBe(detail.records[1]!.id);

    const o = await search(app, 'pay', 'order-77');
    expect(o.requests.map((r) => [r.correlationId, r.component, r.incoming])).toEqual([['pay-cid-000001', 'api', { method: 'GET', path: '/v1/orders/order-77' }]]);
    // Число запросов подсчёта у проекта со своим профилем такое же, как у встроенного формата за тот же период: 6 кусков по часу.
    expect(acmeCounts).toBe(6);
    expect(memory.counts.length - acmeCounts).toBe(acmeCounts);

    const regexps = new Set(memory.counts.map((q) => q.key.regexp));
    expect(regexps).toEqual(new Set([BUILTIN_PROFILE.count!.regexp, '(?i).*(?:\\\\*"trace_id\\\\*":\\s*\\\\*"?)(?P<cid>[0-9a-z._:-]+)']));
  });

  it('страница запроса по ссылке разбирает строки профилем проекта', async () => {
    const { app } = await setup();
    const r = await app.inject({ method: 'GET', url: `/api/projects/acme/envs/demo/requests/order-77.a1?from=${T0}&to=${T0 + 35}` });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json<RequestDetail>().records.map((x) => x.kind)).toEqual(['incoming', 'send', 'response']);
    // Встроенный профиль json не находит correlation_id в строках acme.
    const wrong = await app.inject({ method: 'GET', url: `/api/projects/pay/envs/demo/requests/order-77.a1?from=${T0}&to=${T0 + 35}` });
    expect(wrong.json()).toEqual({ error: { code: 'request-not-found' } });
  });

  it('проекты с одним профилем делят собранный профиль; ошибки разбора — в журнал не чаще раза в минуту', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'threadline-profiles-'));
    await writeFile(join(dir, 'threadline.yaml'), YAML().replace('projects:\n', 'projects:\n  acme-cards:\n    name: Cards\n    format: acme\n    environments:\n      demo: { name: Демо, backend: mem, selector: [{ label: namespace, op: "=", value: cards }] }\n'));
    const config = await loadConfig({ path: join(dir, 'threadline.yaml'), env: {} });
    const warns: string[] = [];
    let t = 0;
    const profiles = compileProjectProfiles(config.config, (m) => warns.push(m), () => t);
    expect(profiles.get('acme')).toBe(profiles.get('acme-cards'));
    expect(profiles.get('pay')).not.toBe(profiles.get('acme'));
    const labels = new Proxy({} as Record<string, string>, {
      get() {
        throw new RangeError('x');
      },
    });
    for (let i = 0; i < 5; i++) profiles.get('acme')!.parse({ tsNs: '1', line: '{"ts":1}', labels });
    t = 61_000;
    profiles.get('acme')!.parse({ tsNs: '1', line: '{"ts":1}', labels });
    expect(warns).toEqual(['формат «acme»: разбор строки прерван ошибкой RangeError', 'формат «acme»: разбор строки прерван ошибкой RangeError (и ещё 4 за минуту)']);
  });
});

describe('битый профиль при старте', () => {
  it('сервер не запускается и перечисляет все ошибки профиля с путями', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'threadline-profiles-'));
    const broken = ACME_YAML.replace('time: rec.ts', 'time: rex.ts').replace('kind: send,', 'kind: request,');
    await writeFile(join(dir, 'threadline.yaml'), YAML(broken));
    const e = await loadConfig({ path: join(dir, 'threadline.yaml'), env: {} }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ConfigError);
    const issues = (e as ConfigError).issues;
    expect(issues.map((i) => i.path).sort()).toEqual(['formats.acme.variants.0(app).fields.time', 'formats.acme.variants.0(app).kinds.1.kind']);
    expect((e as ConfigError).format()).toContain('известные слои: rec');
  });
});

describe('config/README.md', () => {
  const blocks = async () => [...(await readFile(join(ROOT, 'config/README.md'), 'utf8')).matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => parse(m[1]!) as unknown);

  it('полный профиль json в описании совпадает со встроенным', async () => {
    const json = (await blocks()).find((b) => (b as { formats?: { json?: unknown } }).formats?.json) as { formats: { json: Profile } };
    expect(json.formats.json).toEqual(BUILTIN_PROFILE);
  });

  it('пример acme проходит проверку профиля', async () => {
    const acmeBlock = (await blocks()).find((b) => typeof (b as { formats?: { acme?: { variants?: unknown[] } } }).formats?.acme?.variants?.[0] === 'object') as { formats: { acme: unknown } };
    expect(checkProfile(acmeBlock.formats.acme)).toMatchObject({ ok: true });
  });
});

describe('проверка профиля на образце', () => {
  const profile = (parse(`formats:${ACME_YAML}`) as { formats: { acme: Profile } }).formats.acme;
  const compiled = compileProfile('acme', profile);

  it('варианты и виды, доля correlation_id, согласие подсчёта; значений не печатает', () => {
    const text = [...LINES.slice(0, 3).map((l) => l.line), 'not json', ''].join('\n');
    const out = checkSample(compiled, profile, sampleLines(text, { container: 'app' })).join('\n');
    expect(out).toContain('Формат: acme, строк: 4');
    expect(out).toContain('app: 3 (incoming 1, send 1, response 1)');
    expect(out).toContain('(нет варианта): 1 (text 1)');
    expect(out).toContain('correlation_id разобран: 3 из 4 (75%)');
    expect(out).toContain('Подсчёт и разбор согласны на всех строках.');
    expect(out).toContain('app: context');
    expect(out).not.toContain('order-77');
    expect(out).not.toContain('pay.example');
  });

  it('опечатка в пути: поле без значения ни на одной строке варианта', () => {
    const typo = (parse(`formats:${ACME_YAML.replace('requestId: rec.span_id', 'requestId: rec.spanid')}`) as { formats: { acme: Profile } }).formats.acme;
    const out = checkSample(compileProfile('acme', typo), typo, sampleLines(LINES.slice(0, 3).map((l) => l.line).join('\n'), { container: 'app' }));
    expect(out).toContain('  app: requestId, context');
  });

  it('называет номера строк, где подсчёт и разбор расходятся', () => {
    const lines = [
      JSON.stringify({ ts: 1, trace_id: 'abc/def' }), // косая черта вне класса подсчёта: ключ обрезан
      JSON.stringify({ ts: 1, msg: 'x', body: '{"trace_id":"from-body"}' }), // ключ в теле без correlation_id записи
      JSON.stringify({ ts: 1, trace_id: '***' }), // подсчёт не находит
      JSON.stringify({ ts: 1, trace_id: null }), // литерал null — не ключ: согласие
    ].join('\n');
    const out = checkSample(compiled, profile, sampleLines(lines, { container: 'app' })).join('\n');
    expect(out).toMatch(/другой ключ.*строки: 1$/m);
    expect(out).toMatch(/разбор его не нашёл.*строки: 2$/m);
    expect(out).toMatch(/не находит.*строки: 3$/m);
    expect(out).not.toContain('abc');
  });
});
