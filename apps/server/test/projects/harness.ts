// Общее для тестов проектов: настройка на временном файле, база PGlite или PostgreSQL, справочник-заглушка над настоящей базой.
// Grafana только поддельная, значения выдуманы. Подключение к настоящему CatalogService проверяет service.test.ts.

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { LogBackend } from '@threadline/core/backend';
import type { CatalogState } from '@threadline/core/search';
import { ACME_PROFILE } from '../../../../packages/core/src/profile/test-acme.ts';
import { buildApp } from '../../src/app.ts';
import { Backends } from '../../src/backends/registry.ts';
import { DbError, isConnectionError, openDb, type Db, type Queryable } from '../../src/catalog/db.ts';
import { migrate } from '../../src/catalog/migrate.ts';
import { CatalogUnavailable } from '../../src/catalog/service.ts';
import { loadConfig, type ResolvedConfig } from '../../src/config/load.ts';
import type { LogoFile, ProjectLogo } from '../../src/config/logo.ts';
import { ProjectsService, type ProjectsCatalog } from '../../src/projects/service.ts';

export const TOKEN_ENV = 'THREADLINE_PROJECTS_TEST_TOKEN';
/** Значения метки namespace в поддельной Grafana: прод и живые стенды демо-проекта. */
export const NAMESPACES = ['pay', 'pay-pr-92', 'pay-pr-105', 'pay-pr-test'];
const SCOPE = "{ label: namespace, values: [pay, pay-test, 'pay-pr-*', acme, 'acme-*'] }";

export function configYaml(opts: { url?: string; scope?: string | null; projects?: string; backendsExtra?: string; defaults?: string } = {}): string {
  const scope = opts.scope === undefined ? SCOPE : opts.scope;
  return `
auth: off
defaults: ${opts.defaults ?? '{ project: pay, environment: prod }'}
backends:
  grafana:
    type: loki-grafana
    url: ${opts.url ?? 'http://127.0.0.1:9'}
    tokenEnv: ${TOKEN_ENV}
${scope ? `    formScope: ${scope}\n` : ''}${opts.backendsExtra ?? ''}  demo:
    type: mock
formats:
  acme-json: ${JSON.stringify(ACME_PROFILE)}
projects:
${opts.projects ?? PAY_PROJECT}
`;
}

export const PAY_PROJECT = `  pay:
    name: Demo Pay
    environments:
      prod:
        name: Прод
        backend: grafana
        selector:
          - { label: namespace, op: '=', value: pay }
      pr:
        name: Стенды
        kind: pr-stands
        backend: grafana
        stand: { label: namespace, template: 'pay-pr-{number}' }
      demo:
        name: Демо
        backend: demo
        selector:
          - { label: namespace, op: '=', value: pay }
`;

export const projectYaml = (id: string, name = id, env = 'demo', backend = 'demo', value = 'acme') => `  ${id}:
    name: ${name}
    environments:
      ${env}:
        name: Среда
        backend: ${backend}
        selector:
          - { label: namespace, op: '=', value: ${value} }
`;

export async function configFile(yaml: string, env: Record<string, string> = { [TOKEN_ENV]: 'test-token' }): Promise<ResolvedConfig> {
  const dir = await mkdtemp(join(tmpdir(), 'threadline-projects-'));
  await writeFile(join(dir, 'threadline.yaml'), yaml);
  return loadConfig({ path: join(dir, 'threadline.yaml'), env });
}

export interface Logs {
  info: string[];
  warn: string[];
}

export class TestCatalog implements ProjectsCatalog {
  current: CatalogState['state'] = 'ok';
  message: string | null = null;
  lists: string[][] = [];
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  state(): CatalogState {
    return { state: this.current, loadedAt: null, message: this.message };
  }

  readDb(): Db | null {
    return this.current === 'ok' || this.current === 'stale' ? this.#db : null;
  }

  async transaction<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    if (this.current !== 'ok') throw new CatalogUnavailable();
    try {
      return await this.#db.tx(fn);
    } catch (e) {
      if (e instanceof DbError && isConnectionError(e)) {
        this.current = 'stale';
        throw new CatalogUnavailable();
      }
      throw e;
    }
  }

  async projectsChanged(list: readonly { id: string }[]): Promise<void> {
    this.lists.push(list.map((p) => p.id));
  }
}

export interface Stand {
  app: FastifyInstance;
  service: ProjectsService;
  config: ResolvedConfig;
  backends: Backends;
  catalog: TestCatalog;
}

/** Сервер с проектами из базы: как запуск с подключённой базой. */
export async function stand(db: Db, yaml: string, opts: { catalog?: TestCatalog; env?: Record<string, string>; createAdapter?: () => LogBackend } = {}): Promise<Stand> {
  const config = await configFile(yaml, opts.env);
  const backends = new Backends(config, opts.createAdapter ? { createAdapter: opts.createAdapter } : {});
  const catalog = opts.catalog ?? new TestCatalog(db);
  let service!: ProjectsService;
  const app = await buildApp({
    config,
    backends,
    logger: false,
    onProjects: (s) => {
      service = s;
      s.attach(catalog);
    },
  });
  await migrate(db);
  await service.sync(db);
  return { app, service, config, backends, catalog };
}

export const openFresh = async (url: string): Promise<Db> => {
  const db = await openDb(url);
  await migrate(db);
  return db;
};

// ---------- Логотипы ----------

/** Заголовок PNG с заявленными размерами: содержимого проверке не нужно. */
export function pngBytes(width = 8, height = 8, seed = 0): Buffer {
  const b = Buffer.alloc(33 + seed);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

export const svgBytes = (extra = '', viewBox = '0 0 20 10') => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${extra}<rect width="1" height="1"/></svg>`);

export const base64 = (b: Buffer) => b.toString('base64');

export function logoFile(body: Buffer, hash: string, type: LogoFile['type'] = 'image/png', ratio = 1): LogoFile {
  return { body, type, ratio, hash };
}

export function logoPair(light: LogoFile, dark: LogoFile = light): ProjectLogo {
  return { light, dark, ratio: Math.max(light.ratio, dark.ratio) };
}
