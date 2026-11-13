// Снимок проектов и его замена без перезапуска, подключение к настоящему справочнику и состояния базы.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CompiledProfile } from '@threadline/core/profile';
import { Backends } from '../../src/backends/registry.ts';
import type { Db, Queryable, Session } from '../../src/catalog/db.ts';
import { CatalogService, CatalogUnavailable } from '../../src/catalog/service.ts';
import { DbError, openDb } from '../../src/catalog/db.ts';
import { migrate, MigrationError } from '../../src/catalog/migrate.ts';
import { compileProjectProfiles } from '../../src/search/profiles.ts';
import { effectiveDefaults, ProjectsService } from '../../src/projects/service.ts';
import * as store from '../../src/projects/store.ts';
import { configFile, configYaml, logoFile, logoPair, PAY_PROJECT, pngBytes, projectYaml, TestCatalog, type Logs } from './harness.ts';

async function make(db: Db, yaml: string, drops: [string, string | undefined][] = []) {
  const config = await configFile(yaml);
  const profiles: Map<string, CompiledProfile> = compileProjectProfiles(config.config, () => undefined);
  const backends = new Backends(config);
  const logs: Logs = { info: [], warn: [] };
  const service = new ProjectsService({
    config,
    profiles,
    backends,
    log: { info: (m) => logs.info.push(m), warn: (m) => logs.warn.push(m) },
    effects: { dropScope: (p, e) => drops.push([p, e]) },
  });
  const catalog = new TestCatalog(db);
  service.attach(catalog);
  return { config, profiles, backends, service, catalog, logs };
}

const input = (over: Record<string, unknown> = {}) => ({
  id: 'acme',
  name: 'Acme',
  timezone: 'Asia/Karachi',
  retentionDays: 30,
  format: 'json',
  environments: [{ id: 'demo', name: 'Демо', kind: 'single', backend: 'demo', selector: [{ label: 'namespace', op: '=', value: 'acme' }] }],
  ...over,
});

describe('снимок проектов', () => {
  let db: Db;
  beforeEach(async () => {
    db = await openDb('pglite://memory');
    await migrate(db);
  });
  afterEach(async () => db.close());

  it('без базы: файл, правка закрыта, список полный', async () => {
    const config = await configFile(configYaml());
    const service = new ProjectsService({ config, profiles: new Map(), backends: new Backends(config), log: { info: () => undefined, warn: () => undefined } });
    expect(service.sourceState().state).toBe('off');
    expect(service.editable).toBe(false);
    expect(service.incomplete).toBe(false);
    expect(service.hiddenList()).toEqual([]);
    expect(service.settings().projects.map((p) => [p.id, p.fileState, p.updatedAt])).toEqual([['pay', 'same', null]]);
    await expect(service.create(input())).rejects.toMatchObject({ code: 'project-readonly' });
  });

  it('новая среда действует на следующий запрос без перезапуска, порядок сохранён', async () => {
    const s = await make(db, configYaml());
    await s.service.sync(db);
    const pay = s.service.settings().projects.find((p) => p.id === 'pay')!;
    await s.service.update('pay', {
      ...input({ id: 'pay', name: 'Demo Pay' }),
      updatedAt: pay.updatedAt,
      environments: [...pay.environments.map(({ missingStore: _m, outOfScope: _o, ...e }) => e), { id: 'stage', name: 'Стейдж', kind: 'single', backend: 'demo', selector: [{ label: 'namespace', op: '=', value: 'stage' }] }],
    });
    expect(Object.keys(s.config.config.projects.pay!.environments)).toEqual(['prod', 'pr', 'demo', 'stage']);
    expect(s.backends.environment('pay', 'stage')?.name).toBe('Стейдж');
  });

  it('проект из файла с названием на 90 символов и значением с пробелом остаётся рабочим после посева', async () => {
    const name = 'я'.repeat(90);
    const yaml = configYaml({
      projects: `  long:
    name: ${name}
    environments:
      demo:
        name: ${name}
        backend: demo
        selector:
          - { label: namespace, op: '=', value: ' pay' }
`,
      defaults: '{ project: long, environment: demo }',
    });
    const s = await make(db, yaml);
    await s.service.sync(db);
    expect(s.config.config.projects.long?.name).toBe(name);
    expect(s.service.settings().projects[0]!.issues).toBeUndefined();
  });

  it('неверная запись: не в работе, на странице с ошибками, сервер не падает', async () => {
    const s = await make(db, configYaml({ projects: PAY_PROJECT + projectYaml('acme') }));
    await s.service.sync(db);
    await db.query(`update project set environments = '[{"id":"demo","name":"Д","kind":"single","backend":"demo","selector":[{"label":"x","op":"!=","value":"1"}]}]'::jsonb where id = 'acme'`);
    await store.bumpVersion(db);
    await s.service.poll(db);
    expect(s.config.config.projects.acme).toBeUndefined();
    expect(s.profiles.has('acme')).toBe(false);
    const row = s.service.settings().projects.find((p) => p.id === 'acme')!;
    expect(row.issues?.[0]?.path).toBe('projects.acme.environments.demo.selector');
    expect(s.config.config.projects.pay).toBeDefined();
  });

  it.each(['s', 'settings'])('запись с занятым идентификатором %s: сервер работает, проекта нет в выборе, на странице ошибка', async (id) => {
    const s = await make(db, configYaml());
    await s.service.sync(db);
    await db.query(`insert into project (id, name, timezone, retention_days, format, environments, position) select $1, name, timezone, retention_days, format, environments, 9 from project where id = 'pay'`, [id]);
    await store.bumpVersion(db);
    await s.service.poll(db);
    expect(s.config.config.projects[id]).toBeUndefined();
    expect(s.config.config.projects.pay).toBeDefined();
    const row = s.service.settings().projects.find((p) => p.id === id)!;
    expect(row.issues?.[0]?.message).toContain('занят адресом страницы');
  });

  it('все записи неверны: снимок из файла, страница называет причину и показывает записи', async () => {
    const s = await make(db, configYaml());
    await s.service.sync(db);
    await db.query(`update project set format = 'gone'`);
    await store.bumpVersion(db);
    await s.service.poll(db);
    const settings = s.service.settings();
    expect(settings.fallbackToFile).toBe(true);
    expect(settings.projects[0]!.issues?.[0]?.path).toBe('projects.pay.format');
    expect(s.config.config.projects.pay?.format).toBe('json');
    expect(s.profiles.has('pay')).toBe(true);
  });

  it('профиль убрали из файла: проект неверный, остальные работают', async () => {
    const s = await make(db, configYaml({ projects: PAY_PROJECT + projectYaml('acme') }));
    await s.service.sync(db);
    await db.query(`update project set format = 'gone' where id = 'acme'`);
    await store.bumpVersion(db);
    await s.service.poll(db);
    expect(s.config.config.projects.acme).toBeUndefined();
    expect(s.service.settings().projects.find((p) => p.id === 'acme')!.issues?.[0]?.path).toBe('projects.acme.format');
  });

  it('скрытый проект из defaults: открывается первый видимый, страница называет заданное', async () => {
    const s = await make(db, configYaml({ projects: PAY_PROJECT + projectYaml('acme') }));
    await s.service.sync(db);
    const pay = s.service.settings().projects.find((p) => p.id === 'pay')!;
    await s.service.setHidden('pay', true, pay.updatedAt!);
    expect(s.config.config.defaults).toEqual({ project: 'acme', environment: 'demo' });
    expect(s.service.settings().configuredDefaults).toEqual({ project: 'pay', environment: 'prod' });
    expect(s.service.hiddenList()).toEqual([{ id: 'pay', name: 'Demo Pay' }]);
    expect(s.config.config.projects.pay).toBeUndefined();
  });

  it('среду из defaults убрали: открывается первая среда проекта', () => {
    const p = { pay: { name: 'O', format: 'json', retentionDays: 1, timezone: 'UTC', environments: { test: { name: 'T', kind: 'single' as const, backend: 'd', selector: [] } } } };
    expect(effectiveDefaults(p, { project: 'pay', environment: 'prod' })).toEqual({ project: 'pay', environment: 'test' });
    expect(effectiveDefaults(p, { project: 'gone', environment: 'test' })).toEqual({ project: 'pay', environment: 'test' });
    expect(effectiveDefaults(p, { project: 'pay', environment: 'test' })).toEqual({ project: 'pay', environment: 'test' });
  });

  it('логотип скрытого проекта остаётся в resolved.logos', async () => {
    const s = await make(db, configYaml({ projects: PAY_PROJECT + projectYaml('acme') }));
    await s.service.sync(db);
    await store.replaceLogo(db, 'acme', logoPair(logoFile(pngBytes(), 'abc')));
    await db.query(`update project set hidden_by = 'page' where id = 'acme'`);
    await store.bumpVersion(db);
    await s.service.poll(db);
    expect(s.config.config.projects.acme).toBeUndefined();
    expect(s.config.logos?.get('acme')?.light.hash).toBe('abc');
  });

  it('правка второй копии применяется при опросе версии', async () => {
    const a = await make(db, configYaml());
    const b = await make(db, configYaml());
    await a.service.sync(db);
    await b.service.sync(db);
    await a.service.create(input());
    expect(b.config.config.projects.acme).toBeUndefined();
    await b.service.poll(db);
    expect(b.config.config.projects.acme?.name).toBe('Acme');
    expect(b.service.version).toBe(a.service.version);
  });

  it('ошибка базы при сверке идёт в повтор подключения, как упавшая миграция — только ошибка не базы', async () => {
    const s = await make(db, configYaml());
    // База только для чтения после переключения, нарушение проверки: повтор может помочь, состояние «ошибка» без повтора — нет.
    for (const code of ['25006', '23514', 'ECONNREFUSED']) {
      const failing = { ...db, tx: () => Promise.reject(new DbError(`ошибка ${code}`, code)) } as unknown as Db;
      await expect(s.service.sync(failing)).rejects.toBeInstanceOf(DbError);
    }
    const bug = { ...db, tx: () => Promise.reject(new TypeError('сбой программы')) } as unknown as Db;
    await expect(s.service.sync(bug)).rejects.toBeInstanceOf(MigrationError);
    expect(s.service.incomplete).toBe(true);
    expect(s.config.config.projects.pay).toBeDefined();
  });

  it('обрыв после загрузки: снимок и логотип из памяти, правка закрыта, восстановление', async () => {
    const s = await make(db, configYaml({ projects: PAY_PROJECT + projectYaml('acme') }));
    await s.service.sync(db);
    await store.replaceLogo(db, 'acme', logoPair(logoFile(pngBytes(), 'abc')));
    await store.bumpVersion(db);
    await s.service.poll(db);
    s.catalog.current = 'stale';
    s.catalog.message = 'база недоступна (db:5432/x)';
    expect(s.service.editable).toBe(false);
    expect(s.service.incomplete).toBe(false);
    const settings = s.service.settings();
    expect(settings.state).toBe('stale');
    expect(settings.message).toContain('db:5432');
    expect(settings.loadedAt).not.toBeNull();
    expect(s.config.logos?.get('acme')?.light.hash).toBe('abc');
    await expect(s.service.create(input({ id: 'next' }))).rejects.toMatchObject({ code: 'project-readonly' });
    s.catalog.current = 'ok';
    expect((await s.service.create(input({ id: 'next' }))).id).toBe('next');
  });

  it('подъём базы позже: до сверки список неполный, после — данные базы', async () => {
    const s = await make(db, configYaml());
    s.catalog.current = 'connecting';
    expect(s.service.incomplete).toBe(true);
    expect(s.service.settings().projects.map((p) => p.updatedAt)).toEqual([null]);
    s.catalog.current = 'ok';
    await s.service.sync(db);
    expect(s.service.incomplete).toBe(false);
    expect(s.service.settings().projects[0]!.updatedAt).not.toBeNull();
  });

  it('действие правки на поиски: что останавливает поиски и сбрасывает кэш', async () => {
    const drops: [string, string | undefined][] = [];
    const s = await make(db, configYaml({ projects: PAY_PROJECT + projectYaml('acme') }), drops);
    await s.service.sync(db);
    drops.length = 0;
    const current = () => s.service.settings().projects.find((p) => p.id === 'acme')!;
    const save = (over: Record<string, unknown>) => {
      const c = current();
      return s.service.update('acme', { name: c.name, timezone: c.timezone, retentionDays: c.retentionDays, format: c.format, environments: c.environments, updatedAt: c.updatedAt, ...over });
    };

    await save({ name: 'Новое', retentionDays: 7 });
    expect(drops).toEqual([]);

    const envs = current().environments;
    await save({ environments: [{ ...envs[0]!, selector: [{ label: 'namespace', op: '=', value: 'другое' }] }] });
    expect(drops).toEqual([['acme', 'demo']]);
    drops.length = 0;

    await save({ format: 'acme-json' });
    expect(drops).toEqual([['acme', undefined]]);
    expect(s.profiles.get('acme')?.name).toBe('acme-json');
    drops.length = 0;

    await s.service.setHidden('acme', true, current().updatedAt!);
    expect(drops).toEqual([['acme', undefined]]);
  });
});

describe('кэш стендов при правке', () => {
  const STANDS = `  pay:
    name: Demo Pay
    environments:
      pr:
        name: Стенды
        kind: pr-stands
        backend: mock
        stand: { label: namespace, template: 'pay-pr-{number}' }
      other:
        name: Другие
        kind: pr-stands
        backend: mock
        stand: { label: namespace, template: 'pay-pr-{number}' }
`;

  const setup = async () => {
    const config = await configFile(configYaml({ projects: STANDS, defaults: '{ project: pay, environment: pr }', backendsExtra: '  mock:\n    type: mock\n' }));
    let values = ['pay-pr-1'];
    const calls: (() => void)[] = [];
    let hold = false;
    const adapter = {
      check: async () => ({ labelNames: [] }),
      queryLines: async () => [],
      countBy: async () => ({}),
      labelValues: async () => {
        const answer = values;
        if (hold) await new Promise<void>((r) => calls.push(r));
        return answer;
      },
    };
    const backends = new Backends(config, { createAdapter: () => adapter });
    const signal = new AbortController().signal;
    const read = (env: string) => backends.stands('pay', env, config.config.projects.pay!.environments[env]!, signal);
    return { backends, read, setValues: (v: string[]) => (values = v), holdNext: () => (hold = true), release: () => { hold = false; for (const c of calls.splice(0)) c(); } };
  };

  it('читается заново только у своей среды', async () => {
    const s = await setup();
    expect(await s.read('pr')).toEqual([1]);
    expect(await s.read('other')).toEqual([1]);
    s.setValues(['pay-pr-2']);
    expect(await s.read('pr')).toEqual([1]);
    s.backends.forgetStands('pay', 'pr');
    expect(await s.read('pr')).toEqual([2]);
    expect(await s.read('other')).toEqual([1]);
  });

  it('ответ, начатый до правки, в кэш не попадает', async () => {
    const s = await setup();
    s.holdNext();
    const old = s.read('pr');
    await expect.poll(() => true).toBe(true);
    s.backends.forgetStands('pay', 'pr');
    s.setValues(['pay-pr-9']);
    s.release();
    expect(await old).toEqual([1]);
    expect(await s.read('pr')).toEqual([9]);
  });
});

describe('проекты на настоящем справочнике', () => {
  const quiet = { info: () => undefined, warn: () => undefined };
  let db: Db;
  const started: CatalogService[] = [];
  beforeEach(async () => {
    db = await openDb('pglite://memory');
    // Адрес в этих тестах вида postgres://, поэтому сервис схему не ставит: схему ставит команда, здесь её заменяет вызов.
    await migrate(db);
  });
  afterEach(async () => {
    for (const c of started.splice(0)) await c.close();
    await db.close();
  });

  /** База, которую можно «выключить»: обрыв приходит кодом соединения, как у настоящей. */
  const flaky = (real: Db, power: { down: boolean }): Db => {
    const guard = <T>(fn: () => Promise<T>): Promise<T> => (power.down ? Promise.reject(new DbError('connect ECONNREFUSED', 'ECONNREFUSED')) : fn());
    return {
      label: 'db.test:5432/x',
      query: (sql: string, p?: readonly unknown[]) => guard(() => real.query(sql, p)),
      exec: (sql: string) => guard(() => real.exec(sql)),
      tx: <T>(fn: (q: Queryable) => Promise<T>) => guard(() => real.tx(fn)),
      session: <T>(fn: (s: Session) => Promise<T>) => guard(() => real.session(fn)),
      close: () => Promise.resolve(),
    } as Db;
  };

  async function live(yaml: string, opts: { power?: { down: boolean }; now?: () => number; url?: string | undefined; retryMs?: number; afterSync?: () => void; target?: Db } = {}) {
    const config = await configFile(yaml);
    const profiles = compileProjectProfiles(config.config, () => undefined);
    const backends = new Backends(config);
    const service = new ProjectsService({ config, profiles, backends, log: quiet, ...(opts.now ? { now: opts.now } : {}) });
    const power = opts.power ?? { down: false };
    let opened = 0;
    const catalog = new CatalogService({
      url: 'url' in opts ? opts.url : 'postgres://synthetic:Top-Secret-9@db.test:5432/x',
      projects: [],
      log: quiet,
      ...(opts.now ? { now: opts.now } : {}),
      pollMs: 3_600_000,
      retryMs: opts.retryMs ?? 3_600_000,
      open: async () => {
        opened++;
        return flaky(opts.target ?? db, power);
      },
      projectsSource: {
        sync: async (q) => {
          const list = await service.sync(q);
          opts.afterSync?.();
          return list;
        },
        poll: (q) => service.poll(q),
      },
    });
    service.attach(catalog);
    started.push(catalog);
    return { config, backends, service, catalog, power, openedCount: () => opened };
  }

  const TWO = PAY_PROJECT + projectYaml('acme');

  it('новый проект получает автора, начальный набор и справочник без перезапуска', async () => {
    const s = await live(configYaml());
    await s.catalog.start();
    expect(s.catalog.state().state).toBe('ok');
    expect(s.catalog.project('next')).toBeUndefined();
    await mkdir(join(dirname(s.config.path), 'catalog'), { recursive: true });
    await writeFile(
      join(dirname(s.config.path), 'catalog', 'next.yaml'),
      'version: 1\nproject: next\nsystems:\n  - key: next\n    kind: project\n    name: Next\n    methods:\n      - { http: GET, path: /v1/ping, name: Проверка связи }\n',
    );
    await s.service.create(input({ id: 'next', name: 'Next' }));
    expect(s.catalog.project('next')?.name).toBe('Next');
    expect(s.catalog.resolver('next')).not.toBeNull();
    expect(s.catalog.snapshot('next')?.methods.map((m) => m.name)).toEqual(['Проверка связи']);
  });

  it('правка второй копии доходит за один опрос: новый загружен, скрытый забыт', async () => {
    const a = await live(configYaml({ projects: TWO }));
    const b = await live(configYaml({ projects: TWO }));
    await a.catalog.start();
    await b.catalog.start();
    await a.service.create(input({ id: 'next' }));
    expect(b.catalog.resolver('next')).toBeNull();
    await b.catalog.pollNow();
    expect(b.catalog.resolver('next')).not.toBeNull();
    const acme = a.service.settings().projects.find((p) => p.id === 'acme')!;
    await a.service.setHidden('acme', true, acme.updatedAt!);
    await b.catalog.pollNow();
    expect(b.catalog.project('acme')).toBeUndefined();
    expect(b.catalog.resolver('acme')).toBeNull();
    expect(b.config.config.projects.acme).toBeUndefined();
  });

  it('время загрузки не считает скрытый проект, показ загружает заново', async () => {
    const clock = { t: 1000 };
    const s = await live(configYaml({ projects: TWO }), { now: () => clock.t });
    await s.catalog.start();
    expect(s.catalog.state().loadedAt).toBe(1000);
    clock.t = 5000;
    await s.service.create(input({ id: 'next' }));
    expect(s.catalog.state().loadedAt).toBe(1000);
    clock.t = 7000;
    for (const id of ['pay', 'acme']) await s.service.setHidden(id, true, s.service.settings().projects.find((p) => p.id === id)!.updatedAt!);
    expect(s.catalog.state().loadedAt).toBe(5000);
    expect(s.catalog.resolver('pay')).toBeNull();
    await s.service.setHidden('pay', false, s.service.settings().projects.find((p) => p.id === 'pay')!.updatedAt!);
    expect(s.catalog.resolver('pay')).not.toBeNull();
  });

  it('обрыв в транзакции правки закрывает её сразу: stale, введённое не записано', async () => {
    const s = await live(configYaml());
    await s.catalog.start();
    s.power.down = true;
    await expect(s.service.create(input())).rejects.toBeInstanceOf(CatalogUnavailable);
    expect(s.catalog.state().state).toBe('stale');
    expect(s.service.editable).toBe(false);
    await expect(s.service.create(input())).rejects.toMatchObject({ code: 'project-readonly' });
    s.power.down = false;
    await s.catalog.pollNow();
    expect(s.catalog.state().state).toBe('ok');
    expect(s.service.editable).toBe(true);
    expect((await s.service.create(input())).id).toBe('acme');
  });

  it('старт без базы: off, файл, подключения нет', async () => {
    const s = await live(configYaml(), { url: undefined });
    await s.catalog.start();
    expect(s.openedCount()).toBe(0);
    expect(s.service.sourceState().state).toBe('off');
    expect(s.service.incomplete).toBe(false);
    expect(s.service.editable).toBe(false);
    expect(s.service.settings().projects.map((p) => p.id)).toEqual(['pay']);
  });

  it('база поднялась позже: connecting и неполный список, потом снимок без перезапуска', async () => {
    const s = await live(configYaml(), { power: { down: true }, retryMs: 5 });
    await s.catalog.start();
    expect(s.service.sourceState().state).toBe('connecting');
    expect(s.service.incomplete).toBe(true);
    expect(s.service.editable).toBe(false);
    expect(s.service.sourceState().message).not.toContain('Top-Secret-9');
    expect(s.config.config.projects.pay).toBeDefined();
    s.power.down = false;
    // Подключение проходит все миграции на настоящей базе: под нагрузкой полного прогона секунды по умолчанию мало.
    await expect.poll(() => s.service.sourceState().state, { timeout: 15_000 }).toBe('ok');
    expect(s.service.incomplete).toBe(false);
    expect(s.service.editable).toBe(true);
    expect(s.service.version).toBeGreaterThan(0);
  });

  it('миграция с ошибкой: error без пароля в тексте, повтора нет, файл работает', async () => {
    // Сервер миграции не применяет: ошибка приходит при проверке схемы, файл применённой миграции изменён.
    await db.query("update threadline_migrations set checksum = 'другая' where name = '0004_projects.sql'");
    const broken = flaky(db, { down: false });
    const s = await live(configYaml(), { target: broken });
    const catalog = new CatalogService({ url: 'postgres://u:Top-Secret-9@db.test:5432/x', projects: [], log: quiet, projectsSource: { sync: (q) => s.service.sync(q), poll: (q) => s.service.poll(q) }, open: async () => broken });
    started.push(catalog);
    s.service.attach(catalog);
    await catalog.start();
    expect(s.service.sourceState().state).toBe('error');
    expect(s.service.sourceState().message).toContain('0004_projects.sql');
    expect(s.service.sourceState().message).not.toContain('Top-Secret-9');
    expect(s.service.incomplete).toBe(true);
    expect(s.service.editable).toBe(false);
    expect(s.config.config.projects.pay).toBeDefined();
  });

  it('обрыв после загрузки: снимок и логотип из памяти, восстановление открывает правку', async () => {
    const s = await live(configYaml({ projects: TWO }));
    await s.catalog.start();
    await migrate(db);
    await store.replaceLogo(db, 'acme', logoPair(logoFile(pngBytes(), 'abc')));
    await store.bumpVersion(db);
    await s.catalog.pollNow();
    await s.service.create(input({ id: 'next' }));
    s.power.down = true;
    await s.catalog.pollNow();
    const settings = s.service.settings();
    expect(settings.state).toBe('stale');
    expect(settings.loadedAt).not.toBeNull();
    expect(settings.editable).toBe(false);
    expect(s.service.incomplete).toBe(false);
    expect(s.config.config.projects.next?.name).toBe('Acme');
    expect(s.config.logos?.get('acme')?.light.hash).toBe('abc');
    s.power.down = false;
    await s.catalog.pollNow();
    expect(s.service.settings().state).toBe('ok');
    expect(s.service.editable).toBe(true);
  });

  it('обрыв между сверкой и загрузкой справочника: снимок из базы, incomplete: false', async () => {
    const power = { down: false };
    const s = await live(configYaml(), { power, afterSync: () => (power.down = true) });
    await s.catalog.start();
    expect(s.service.sourceState().state).toBe('connecting');
    expect(s.service.incomplete).toBe(false);
    expect(s.service.editable).toBe(false);
    expect(s.service.settings().projects[0]!.updatedAt).not.toBeNull();
  });
});
