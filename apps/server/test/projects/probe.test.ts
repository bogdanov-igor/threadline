// «Проверить подключение» на поддельной Grafana: запросы только по нажатию, тел записей нет.

import type { ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProbeResponse } from '@threadline/core';
import { openDb, type Db } from '../../src/catalog/db.ts';
import { migrate } from '../../src/catalog/migrate.ts';
import { fakeGrafana, grafana85, json } from '../fake-grafana.ts';
import { configYaml, stand, TOKEN_ENV } from './harness.ts';

let db: Db;
let app: FastifyInstance;
let grafana: Awaited<ReturnType<typeof fakeGrafana>>;
let lines: string[][] = [];
let onRange: ((res: ServerResponse) => boolean) | null = null;
let onLabels: ((res: ServerResponse) => boolean) | null = null;

const SECRET_LINE = 'тело записи не должно уйти';

const handler = (() => {
  const base = grafana85({ values: ['pay-pr-92', 'pay-pr-105', 'pay'] });
  return (req: Parameters<typeof base>[0], res: ServerResponse, rec: Parameters<typeof base>[2]) => {
    const u = new URL(req.url ?? '', 'http://x');
    if (u.pathname.endsWith('/query_range')) {
      if (onRange?.(res)) return;
      return json(res, 200, { status: 'success', data: { resultType: 'streams', result: [{ stream: { namespace: 'x' }, values: lines }] } });
    }
    if (u.pathname.endsWith('/labels') && onLabels?.(res)) return;
    base(req, res, rec);
  };
})();

beforeEach(async () => {
  lines = [];
  onRange = null;
  onLabels = null;
  db = await openDb('pglite://memory');
  await migrate(db);
  grafana = await fakeGrafana(handler);
  ({ app } = await stand(db, configYaml({ url: grafana.url })));
});

afterEach(async () => {
  await app.close();
  await db.close();
  await grafana.close();
});

const env = (value = 'pay', over: Record<string, unknown> = {}) => ({ kind: 'single', selector: [{ label: 'namespace', op: '=', value }], ...over });
const probe = (payload: unknown = {}, store = 'grafana') => app.inject({ method: 'POST', url: `/api/stores/${store}/probe`, payload: payload as object });
const count = (suffix: string) => grafana.requests.filter((r) => new URL(r.url, 'http://x').pathname.endsWith(suffix)).length;

describe('проверка подключения', () => {
  it('подключено, записи есть: тела записи в ответе нет, запрос с limit=1 за 5 минут', async () => {
    lines = [['1000000000000000000', SECRET_LINE]];
    const r = await probe({ environment: env() });
    expect(r.statusCode).toBe(200);
    expect(r.json<ProbeResponse>()).toMatchObject({ status: 'connected', hasRecords: true, labelNames: expect.arrayContaining(['namespace']) });
    expect(r.body).not.toContain(SECRET_LINE);
    const q = grafana.requests.find((x) => x.url.includes('/query_range'))!;
    const params = new URL(q.url, 'http://x').searchParams;
    expect(params.get('limit')).toBe('1');
    expect(params.get('query')).toBe('{namespace="pay"}');
    expect(BigInt(params.get('end')!) - BigInt(params.get('start')!)).toBe(300_000_000_001n);
  });

  it('записей за 5 минут нет: это не ошибка', async () => {
    expect((await probe({ environment: env() })).json<ProbeResponse>()).toMatchObject({ status: 'connected', hasRecords: false });
  });

  it('без условий: только хранилище', async () => {
    expect((await probe()).json<ProbeResponse>()).toMatchObject({ status: 'connected' });
    expect(count('/query_range')).toBe(0);
  });

  it('стенды: живые номера запросом к индексу меток', async () => {
    const r = await probe({ environment: { kind: 'pr-stands', selector: [], stand: { label: 'namespace', template: 'pay-pr-{number}' } } });
    expect(r.json<ProbeResponse>()).toMatchObject({ status: 'connected', stands: [105, 92] });
    expect(count('/query_range')).toBe(0);
  });

  it('проверка несохранённого шаблона не меняет кэш стендов сохранённой среды', async () => {
    expect((await app.inject('/api/projects/pay/envs/pr/stands')).json()).toEqual({ stands: [105, 92] });
    const before = count('/label/namespace/values');
    await probe({ environment: { kind: 'pr-stands', selector: [], stand: { label: 'namespace', template: 'acme-pr-{number}' } } });
    expect(count('/label/namespace/values')).toBe(before + 1);
    expect((await app.inject('/api/projects/pay/envs/pr/stands')).json()).toEqual({ stands: [105, 92] });
    expect(count('/label/namespace/values')).toBe(before + 1);
  });

  it('токен не задан: «не настроено» с именем переменной, запросов нет', async () => {
    await app.close();
    ({ app } = await stand(db, configYaml({ url: grafana.url }), { env: { [TOKEN_ENV]: ' ' } }));
    expect((await probe({ environment: env() })).json<ProbeResponse>()).toMatchObject({ status: 'not-configured', missingEnv: TOKEN_ENV });
    expect(grafana.requests).toHaveLength(0);
  });

  it('имитация: «демо», запросов нет', async () => {
    expect((await probe({ environment: env('любое') }, 'demo')).json<ProbeResponse>()).toMatchObject({ status: 'demo' });
    expect(grafana.requests).toHaveLength(0);
  });

  it('условие вне границы и лишнее поле: ошибка поля без запросов', async () => {
    const out = await probe({ environment: env('core-ledger') });
    expect(out.statusCode).toBe(422);
    expect(Object.keys(out.json<{ error: { fields: Record<string, string> } }>().error.fields)).toEqual(['environment.selector.0.value']);
    const extra = await probe({ environment: env('pay', { url: 'https://evil.example' }) });
    expect(Object.keys(extra.json<{ error: { fields: Record<string, string> } }>().error.fields)).toEqual(['environment.url']);
    expect((await probe({ url: 'https://evil.example' })).statusCode).toBe(422);
    expect(grafana.requests).toHaveLength(0);
  });

  it('условия из файла на хранилище с границей проходят по проекту', async () => {
    const saved = { id: 'prod', kind: 'single', selector: [{ label: 'namespace', op: '=', value: 'pay' }] };
    expect((await probe({ project: 'pay', environment: saved })).statusCode).toBe(200);
  });

  it('неизвестное хранилище', async () => {
    const r = await probe({}, 'nope');
    expect([r.statusCode, r.json<{ error: { code: string } }>().error.code]).toEqual([404, 'store-not-found']);
  });

  it('три нажатия за две секунды: один набор запросов', async () => {
    const a = await probe({ environment: env() });
    await probe({ environment: env() });
    await probe({ environment: env() });
    expect(a.statusCode).toBe(200);
    expect(count('/query_range')).toBe(1);
    expect(count('/labels')).toBe(1);
  });

  it('одновременные одинаковые нажатия склеиваются', async () => {
    await Promise.all([probe({ environment: env() }), probe({ environment: env() }), probe({ environment: env() })]);
    expect(count('/query_range')).toBe(1);
  });

  it('101-е разное условие вытесняет самое старое: кэш не растёт', async () => {
    const q = (i: number) => env(`acme-${i}`);
    for (let i = 0; i < 101; i++) await probe({ environment: q(i) });
    expect(count('/query_range')).toBe(101);
    await probe({ environment: q(100) });
    expect(count('/query_range')).toBe(101);
    await probe({ environment: q(0) });
    expect(count('/query_range')).toBe(102);
  });

  it.each([
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [503, 'overloaded'],
  ])('ошибка хранилища %i — состояние %s телом', async (status, code) => {
    onLabels = (res) => {
      json(res, status, { message: 'нет' });
      return true;
    };
    const r = await probe({ environment: env() });
    expect(r.statusCode).toBe(200);
    expect(r.json<ProbeResponse>().status).toBe(code);
  });

  it('сеть недоступна: состояние телом', async () => {
    await grafana.close();
    expect((await probe()).json<ProbeResponse>().status).toBe('network');
    grafana = await fakeGrafana(handler);
  });

  it('номер карты в тексте ошибки хранилища скрыт', async () => {
    onRange = (res) => {
      json(res, 500, { message: 'неверный запрос для карты 4111111111111111' });
      return true;
    };
    const r = await probe({ environment: env() });
    expect(r.body).not.toContain('4111111111111111');
    expect(r.json<ProbeResponse>().status).toBe('unknown');
  });

  it('значения идут в запрос только как данные', async () => {
    const vector = '"} or {x="1';
    const r = await probe({ environment: { kind: 'single', selector: [{ label: 'namespace', op: '=', value: 'acme' }, { label: 'app', op: '=', value: vector }] } });
    expect(r.statusCode).toBe(200);
    const q = new URL(grafana.requests.find((x) => x.url.includes('/query_range'))!.url, 'http://x').searchParams.get('query');
    expect(q).toBe('{namespace="acme", app="\\"} or {x=\\"1"}');
    for (const value of ['обратная\\', 'апостроф`', 'раз\u2028делитель']) {
      const ok = await probe({ environment: { kind: 'single', selector: [{ label: 'namespace', op: '=', value: 'acme' }, { label: 'app', op: '=', value }] } });
      expect(ok.json<{ error?: unknown }>().error).toBeUndefined();
    }
    const queries = grafana.requests.filter((x) => x.url.includes('/query_range')).map((x) => new URL(x.url, 'http://x').searchParams.get('query'));
    expect(queries).toContain('{namespace="acme", app="обратная\\\\"}');
    expect(queries).toContain('{namespace="acme", app="апостроф`"}');
    expect(queries).toContain('{namespace="acme", app="раз\u2028делитель"}');
    const newline = await probe({ environment: { kind: 'single', selector: [{ label: 'namespace', op: '=', value: 'acme' }, { label: 'app', op: '=', value: 'a\nb' }] } });
    expect(newline.statusCode).toBe(422);
  });

  it('уход клиента отменяет запрос к хранилищу', async () => {
    let answered: ServerResponse | null = null;
    onRange = (res) => {
      answered = res;
      return true;
    };
    await app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = app.server.address() as AddressInfo;
    const ac = new AbortController();
    const pending = fetch(`http://127.0.0.1:${port}/api/stores/grafana/probe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ environment: env() }), signal: ac.signal }).catch(() => null);
    await expect.poll(() => count('/query_range')).toBe(1);
    expect(answered).not.toBeNull();
    ac.abort();
    await pending;
    await expect.poll(() => grafana.requests.find((x) => x.url.includes('/query_range'))!.closedEarly).toBe(true);
  });
});
