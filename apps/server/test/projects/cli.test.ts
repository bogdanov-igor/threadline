// Команда проверки видит проекты базы, предупреждает о расхождении и ничего не меняет. Только имитация и база теста.

import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCatalogCli } from '../../src/catalog/cli-run.ts';
import { DbError, openDb, type Db } from '../../src/catalog/db.ts';
import { migrate } from '../../src/catalog/migrate.ts';
import { commandProjects } from '../../src/projects/cli.ts';
import * as store from '../../src/projects/store.ts';
import { fileData, fileVersion, syncProjects } from '../../src/projects/sync.ts';
import { freshDatabase, PG_URL } from '../catalog/pg.ts';
import { configFile, configYaml, PAY_PROJECT, projectYaml } from './harness.ts';

const SERVER_DIR = resolve(import.meta.dirname, '../..');
const MOCK_ONLY = `
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

const quiet = { info: () => undefined, warn: () => undefined };

describe('проекты для команд', () => {
  it('адрес не задан: файл без предупреждений', async () => {
    const config = await configFile(configYaml());
    expect(await commandProjects(config, undefined)).toEqual({ projects: config.config.projects, warnings: [] });
    expect((await commandProjects(config, '   ')).warnings).toEqual([]);
  });

  it('база недоступна: файл и предупреждение без пароля', async () => {
    const config = await configFile(configYaml());
    const r = await commandProjects(config, 'postgres://u:secret-password@127.0.0.1:1/x', async () => {
      throw new DbError('connect ECONNREFUSED secret-password', 'ECONNREFUSED');
    });
    expect(r.projects).toBe(config.config.projects);
    expect(r.warnings[0]).toContain('база недоступна');
    expect(r.warnings[0]).not.toContain('secret-password');
  });

  it('схемы ещё нет: файл, предупреждение, миграции не применены', async () => {
    const db = await openDb('pglite://memory');
    const config = await configFile(configYaml());
    const r = await commandProjects(config, 'pglite://memory', async () => ({ ...db, close: async () => undefined }) as Db);
    expect(r.warnings[0]).toContain('таблиц проектов');
    expect(await db.query(`select to_regclass('public.project') as t`)).toEqual([{ t: null }]);
    await db.close();
  });

  it('проект со страницы и скрытый находятся, команда ничего не меняет, расхождение называется', async () => {
    const db = await openDb('pglite://memory');
    await migrate(db);
    const config = await configFile(configYaml({ projects: PAY_PROJECT + projectYaml('edit', 'Из файла') }));
    const side = { projects: config.config.projects, logos: new Map() };
    await db.tx((q) => syncProjects(q, side, [], quiet));
    await store.insertProject(db, fileData('page', config.config.projects.edit!), 5, { hiddenBy: 'page', fromFile: false, edited: true, fileHash: null });
    const edited = (await store.readProject(db, 'edit'))!;
    await store.updateProject(db, { ...edited, name: 'Со страницы' }, { hiddenBy: null, fromFile: true, edited: true, fileHash: 'другая версия' });
    const version = await store.readVersion(db);
    const before = await store.readProjects(db);

    const r = await commandProjects(config, 'pglite://memory', async () => ({ ...db, close: async () => undefined }) as Db);
    expect(Object.keys(r.projects)).toEqual(['pay', 'edit', 'page']);
    expect(r.projects.edit?.name).toBe('Со страницы');
    expect(r.warnings.join()).toContain('«edit»');
    expect(fileVersion(side, 'edit')?.hash).not.toBe('другая версия');
    expect(await store.readProjects(db)).toEqual(before);
    expect(await store.readVersion(db)).toBe(version);
    await db.close();
  });
});

describe.skipIf(!PG_URL)('команда threadline:check', () => {
  const run = (args: string[], env: Record<string, string>) =>
    new Promise<{ code: number | null; out: string }>((done) => {
      // Явные значения: .env не подставит настоящие токен и адрес базы.
      const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/cli/check.ts', ...args], { cwd: SERVER_DIR, env: { ...process.env, THREADLINE_GRAFANA_URL: '', THREADLINE_GRAFANA_TOKEN: '', THREADLINE_DATABASE_URL: '', ...env } });
      let out = '';
      child.stdout.on('data', (d) => (out += String(d)));
      child.stderr.on('data', (d) => (out += String(d)));
      child.on('close', (code) => done({ code, out }));
    });

  const prepare = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'threadline-check-'));
    await writeFile(join(dir, 'threadline.yaml'), MOCK_ONLY);
    const url = (await freshDatabase({ empty: true }))!;
    const db = await openDb(url);
    return { config: join(dir, 'threadline.yaml'), url, db };
  };

  const envOf = (backend: string) => [{ id: 'demo', name: 'Демо', kind: 'single' as const, backend, selector: [{ label: 'namespace', op: '=' as const, value: 'acme' }] }];

  it('находит проект из базы и скрытый', async () => {
    const { config, url, db } = await prepare();
    await migrate(db);
    await store.insertProject(db, { id: 'acme', name: 'Acme', timezone: 'UTC', retentionDays: 3, format: 'json', environments: envOf('demo') }, 0, { hiddenBy: 'page', fromFile: false, edited: true, fileHash: null });
    await db.close();
    const r = await run(['--project', 'acme', '--env', 'demo'], { THREADLINE_CONFIG: config, THREADLINE_DATABASE_URL: url });
    expect(r.out).toContain('Среда: Acme / Демо');
    expect(r.code).toBe(0);
  });

  it('среда на пропавшем хранилище: название и код 2', async () => {
    const { config, url, db } = await prepare();
    await migrate(db);
    await store.insertProject(db, { id: 'acme', name: 'Acme', timezone: 'UTC', retentionDays: 3, format: 'json', environments: envOf('gone') }, 0, { hiddenBy: null, fromFile: false, edited: true, fileHash: null });
    await db.close();
    const r = await run(['--project', 'acme', '--env', 'demo'], { THREADLINE_CONFIG: config, THREADLINE_DATABASE_URL: url });
    expect(r.code).toBe(2);
    expect(r.out).toContain('gone');
  });

  it('база без таблиц: работает с файлом, предупреждает, код не меняется, миграций нет', async () => {
    const { config, url, db } = await prepare();
    const r = await run(['--project', 'pay', '--env', 'demo'], { THREADLINE_CONFIG: config, THREADLINE_DATABASE_URL: url });
    expect(r.code).toBe(0);
    expect(r.out).toContain('таблиц проектов');
    expect(await db.query(`select to_regclass('public.project') as t`)).toEqual([{ t: null }]);
    await db.close();
  });

  it('threadline:catalog находит проект со страницы и скрытый; удалённый из базы не находит', async () => {
    const { config, url, db } = await prepare();
    await migrate(db);
    await store.insertProject(db, { id: 'acme', name: 'Acme', timezone: 'UTC', retentionDays: 3, format: 'json', environments: envOf('demo') }, 0, { hiddenBy: 'page', fromFile: false, edited: true, fileHash: null });
    await db.close();
    const out: string[] = [];
    const err: string[] = [];
    const io = { env: { THREADLINE_CONFIG: config, THREADLINE_DATABASE_URL: url }, cwd: dirname(config), out: (l: string) => out.push(l), err: (l: string) => err.push(l) };
    expect(await runCatalogCli(['export', 'acme', 'acme.yaml'], io), err.join()).toBe(0);
    expect(out.join()).toContain('Справочник acme выгружен');
    expect(await runCatalogCli(['export', 'pay', 'pay.yaml'], io)).toBe(1);
    expect(err.join()).toContain('проекта «pay» нет');
  });

  it('база недоступна: работает с файлом, предупреждает', async () => {
    const { config, db } = await prepare();
    await db.close();
    const r = await run(['--project', 'pay', '--env', 'demo'], { THREADLINE_CONFIG: config, THREADLINE_DATABASE_URL: 'postgres://u:p@127.0.0.1:1/x' });
    expect(r.code).toBe(0);
    expect(r.out).toContain('база недоступна');
  });
});
