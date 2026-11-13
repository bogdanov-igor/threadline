// Примеры поиска демо-среды: каждый находит запросы в синтетическом наборе за свой период, у быстрого старта, сквозных тестов и снимков документации те же примеры.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { FastifyInstance } from 'fastify';
import { EXAMPLE_LANGUAGES, exampleLabelText } from '@threadline/core';
import { DEFAULT_PRESET, type SearchCreated, type SearchState } from '@threadline/core/search';
import { buildApp } from '../src/app.ts';
import { MockBackend } from '../src/backends/mock/index.ts';
import { Backends, defaultAdapter } from '../src/backends/registry.ts';
import { loadConfig } from '../src/config/load.ts';
import { ROOT } from '../src/paths.ts';
import { SearchJobs } from '../src/search/jobs.ts';

const ANCHOR = Date.UTC(2026, 10, 2, 9, 0, 0);

const fileExamples = (path: string) => (parse(readFileSync(join(ROOT, path), 'utf8')) as { projects: Record<string, { environments: Record<string, { examples?: unknown }> }> }).projects.pay!.environments.demo!.examples;

let app: FastifyInstance;
let jobs: SearchJobs;
// Адрес Grafana нужен для чтения файла, в Grafana тест не ходит: демо-среда на имитации.
const config = await loadConfig({ env: { THREADLINE_GRAFANA_URL: 'https://grafana.example' } });
const examples = config.config.projects.pay!.environments.demo!.examples ?? [];

beforeAll(async () => {
  const backends = new Backends(config, { createAdapter: (id, cfg) => (cfg.type === 'mock' ? new MockBackend(cfg, { anchorMs: ANCHOR }) : defaultAdapter(id, cfg)) });
  jobs = new SearchJobs({ now: () => ANCHOR + 1000, timer: false });
  app = await buildApp({ config, backends, logger: false, now: () => ANCHOR + 1000, jobs });
});

afterAll(async () => {
  jobs.close();
  await app.close();
});

async function search(values: string[], preset: string): Promise<SearchState> {
  const r = await app.inject({ method: 'POST', url: '/api/projects/pay/envs/demo/searches', payload: { terms: values, period: { preset } } });
  expect(r.statusCode, r.body).toBe(200);
  const { id } = r.json() as SearchCreated;
  for (let i = 0; i < 2000; i++) {
    const s = (await app.inject(`/api/searches/${id}`)).json() as SearchState;
    if (s.status !== 'running') return s;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('поиск не завершился');
}

describe('примеры поиска демо-среды', () => {
  it('пять примеров в настройке репозитория, в ответе /api/projects они те же', async () => {
    expect(examples.map((x) => x.label)).toHaveLength(5);
    const projects = (await app.inject('/api/projects')).json() as { projects: { id: string; environments: { id: string; examples?: unknown }[] }[] };
    expect(projects.projects.find((p) => p.id === 'pay')!.environments.find((e) => e.id === 'demo')!.examples).toEqual(examples);
  });

  it('подпись каждого примера одной строкой на английском: демо-проект на английском при любом языке интерфейса', () => {
    for (const x of examples) {
      expect(typeof x.label).toBe('string');
      for (const l of EXAMPLE_LANGUAGES) expect(exampleLabelText(x.label, l)).toMatch(/^[\x20-\x7e]+$/);
    }
  });

  it.each(examples.map((x) => [exampleLabelText(x.label, 'ru'), x] as const))('%s: находит запросы за свой период', async (_label, x) => {
    const s = await search(x.values, x.period ?? DEFAULT_PRESET);
    expect(s.status).toBe('done');
    expect(s.tooMany).toBe(false);
    expect(s.requests.length).toBeGreaterThan(0);
  });

  it('клиент и карта: есть и успешные запросы, и с ошибкой; запрос с отказом — ошибка; у выплаты несколько потоков', async () => {
    const statuses = async (i: number) => (await search(examples[i]!.values, examples[i]!.period ?? DEFAULT_PRESET)).requests.map((r) => r.status);
    for (const i of [0, 1]) expect(new Set(await statuses(i))).toEqual(new Set(['success', 'error']));
    expect((await statuses(3)).length).toBeGreaterThan(3);
    expect(await statuses(4)).toEqual(['error']);
  });

  it('быстрый старт, сквозные тесты и снимки документации показывают те же примеры', () => {
    const own = fileExamples('config/threadline.yaml');
    expect(fileExamples('deploy/quickstart/threadline.yaml')).toEqual(own);
    expect(fileExamples('apps/web/e2e/threadline.e2e.yaml')).toEqual(own);
    expect(fileExamples('dev/docs-shots/threadline.docs.yaml')).toEqual(own);
  });
});
