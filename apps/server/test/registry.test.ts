import { describe, expect, it } from 'vitest';
import { BackendError, type CheckInfo, type LogBackend, type LogLine, type Matcher, type TimeRange } from '@threadline/core/backend';
import { validateConfig } from '@threadline/core/config';
import type { ResolvedConfig } from '../src/config/load.ts';
import { Backends, standRegex } from '../src/backends/registry.ts';

class FakeAdapter implements LogBackend {
  checks = 0;
  labelCalls: { label: string; scope: Matcher[]; range: TimeRange }[] = [];
  fail: BackendError | undefined;
  values = ['pay-pr-92', 'pay-pr-105', 'pay-pr-test', 'pay-test', 'pay-pr-92'];
  async check(): Promise<CheckInfo> {
    this.checks++;
    if (this.fail) throw this.fail;
    return { labelNames: ['namespace'] };
  }
  async labelValues(label: string, scope: Matcher[], range: TimeRange): Promise<string[]> {
    this.labelCalls.push({ label, scope, range });
    return this.values;
  }
  async queryLines(): Promise<LogLine[]> {
    return [];
  }
  async countBy(): Promise<Record<string, number>> {
    return {};
  }
}

function setup(opts: { token?: string } = { token: 't' }) {
  const v = validateConfig({
    auth: 'off',
    defaults: { project: 'pay', environment: 'prod' },
    backends: {
      grafana: { type: 'loki-grafana', url: 'https://g.example', tokenEnv: 'T' },
      demo: { type: 'mock' },
    },
    projects: {
      pay: {
        name: 'Demo Pay',
        environments: {
          prod: { name: 'Прод', backend: 'grafana', selector: [{ label: 'namespace', op: '=', value: 'pay' }] },
          test: { name: 'Тест', backend: 'grafana', selector: [{ label: 'namespace', op: '=', value: 'pay-test' }] },
          pr: {
            name: 'PR',
            kind: 'pr-stands',
            backend: 'grafana',
            stand: { label: 'namespace', template: 'pay-pr-{number}' },
            selector: [{ label: 'container', op: '!=', value: 'pgadmin' }],
          },
          demo: { name: 'Демо', backend: 'demo', selector: [{ label: 'namespace', op: '=', value: 'pay' }] },
        },
      },
    },
  });
  if (!v.ok) throw new Error(JSON.stringify(v.issues));
  const g = v.config.backends.grafana;
  const d = v.config.backends.demo;
  if (g?.type !== 'loki-grafana' || d?.type !== 'mock') throw new Error('bad base');
  const resolved: ResolvedConfig = {
    path: 'x',
    config: v.config,
    backends: {
      grafana: { ...g, token: opts.token, ca: undefined },
      demo: d,
    },
  };
  let now = 1_800_000_000_000;
  const adapters: Record<string, FakeAdapter> = {};
  const reg = new Backends(resolved, {
    now: () => now,
    createAdapter: (id) => (adapters[id] = new FakeAdapter()),
  });
  const env = (id: string) => reg.environment('pay', id)!;
  return { reg, env, adapters, tick: (ms: number) => (now += ms) };
}

const signal = () => new AbortController().signal;

describe('проверка подключения', () => {
  it('десять запросов за минуту дают один запрос к Grafana', async () => {
    const { reg, env, adapters, tick } = setup();
    for (let i = 0; i < 10; i++) {
      expect((await reg.connection(env('prod'), { signal: signal() })).status).toBe('connected');
      tick(5_000);
    }
    expect(adapters.grafana!.checks).toBe(1);
  });

  it('среды одного хранилища делят проверку', async () => {
    const { reg, env, adapters } = setup();
    await reg.connection(env('prod'), { signal: signal() });
    await reg.connection(env('test'), { signal: signal() });
    expect(adapters.grafana!.checks).toBe(1);
  });

  it('через минуту проверяет снова', async () => {
    const { reg, env, adapters, tick } = setup();
    await reg.connection(env('prod'), { signal: signal() });
    tick(60_001);
    await reg.connection(env('prod'), { signal: signal() });
    expect(adapters.grafana!.checks).toBe(2);
  });

  it('«Проверить снова» три раза за две секунды даёт один запрос', async () => {
    const { reg, env, adapters, tick } = setup();
    await reg.connection(env('prod'), { signal: signal() });
    tick(10_000);
    for (let i = 0; i < 3; i++) {
      await reg.connection(env('prod'), { refresh: true, signal: signal() });
      tick(700);
    }
    expect(adapters.grafana!.checks).toBe(2);
  });

  it('одновременные проверки склеиваются', async () => {
    const { reg, env, adapters } = setup();
    await Promise.all(Array.from({ length: 5 }, () => reg.connection(env('prod'), { signal: signal() })));
    expect(adapters.grafana!.checks).toBe(1);
  });

  it('без токена отвечает «не настроено» и не ходит в Grafana', async () => {
    const { reg, env, adapters } = setup({});
    const r = await reg.connection(env('prod'), { signal: signal() });
    expect(r).toMatchObject({ status: 'not-configured', missingEnv: 'T' });
    expect(adapters.grafana!.checks).toBe(0);
  });

  it('демо-среда отвечает «демо»', async () => {
    const { reg, env } = setup();
    expect((await reg.connection(env('demo'), { signal: signal() })).status).toBe('demo');
  });

  it('превращает ошибку в состояние с подробностями и сроком повтора', async () => {
    const { reg, env, adapters } = setup();
    await reg.connection(env('demo'), { signal: signal() });
    adapters.grafana!.fail = new BackendError('overloaded', { details: 'too many', retryAfterSeconds: 9 });
    expect(await reg.connection(env('prod'), { signal: signal() })).toMatchObject({
      status: 'overloaded',
      details: 'too many',
      retryAfterSeconds: 9,
    });
  });
});

describe('список стендов', () => {
  it('отбирает значения по шаблону и сортирует от свежих', async () => {
    const { reg, env, adapters } = setup();
    expect(await reg.stands('pay', 'pr', env('pr'), signal())).toEqual([105, 92]);
    const call = adapters.grafana!.labelCalls[0]!;
    expect(call.scope[0]).toEqual({ label: 'namespace', op: '=~', value: 'pay-pr-[0-9]{1,6}' });
    expect(call.range.toMs - call.range.fromMs).toBe(7 * 24 * 60 * 60_000);
  });

  it('хранит список 5 минут', async () => {
    const { reg, env, adapters, tick } = setup();
    await reg.stands('pay', 'pr', env('pr'), signal());
    tick(4 * 60_000);
    await reg.stands('pay', 'pr', env('pr'), signal());
    expect(adapters.grafana!.labelCalls).toHaveLength(1);
    tick(61_000);
    await reg.stands('pay', 'pr', env('pr'), signal());
    expect(adapters.grafana!.labelCalls).toHaveLength(2);
  });

  it('возвращает пустой список, если стендов нет', async () => {
    const { reg, env, adapters } = setup();
    adapters.grafana!.values = ['pay-test'];
    expect(await reg.stands('pay', 'pr', env('pr'), signal())).toEqual([]);
  });

  it('экранирует шаблон в выражении', () => {
    expect(standRegex('pay.pr-{number}')).toBe('pay\\.pr-[0-9]{1,6}');
  });
});
