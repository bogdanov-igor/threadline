import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { formatReport } from '../../src/catalog/cli-run.ts';
import { DbError, openDb, type Db } from '../../src/catalog/db.ts';
import { CatalogService } from '../../src/catalog/service.ts';
import { exportCatalogText, importCatalog, parseCatalogText } from '../../src/catalog/exchange.ts';
import { migrate } from '../../src/catalog/migrate.ts';
import * as store from '../../src/catalog/store.ts';
import { CATALOG_YAML, service, tempConfig, type Logs } from './fixture.ts';
import { freshDatabase, PG_URL } from './pg.ts';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

async function db(): Promise<Db> {
  const d = await openDb((await freshDatabase())!);
  closers.push(() => d.close());
  await migrate(d);
  return d;
}

const file = (text = CATALOG_YAML) => {
  const p = parseCatalogText(text);
  if (!p.ok) throw new Error('fixture');
  return p.value;
};
const imp = (d: Db, input: unknown, opts: { dryRun?: boolean; force?: boolean } = {}) =>
  importCatalog(d, 'pay', 'Demo Pay', input, { dryRun: opts.dryRun ?? false, force: opts.force ?? false });
const version = async (d: Db) => (await store.loadSnapshot(d, 'pay')).version;

describe('разбор текста файла', () => {
  it('YAML и JSON дают одно и то же', () => {
    const y = file();
    const j = parseCatalogText(JSON.stringify(y));
    expect(j.ok && j.value).toEqual(y);
  });

  it('больше 2 МБ — отказ до разбора', () => {
    const r = parseCatalogText(`version: 1\n#${'x'.repeat(2 * 1024 * 1024)}`);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.tooLarge).toBe(true);
  });

  it('битый YAML — ошибка без строки файла', () => {
    const r = parseCatalogText('version: 1\nproject: [pay\n  secret: 4111111234557893');
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain('4111111234557893');
  });

  it('повтор поля в JSON: предупреждение с путём, последнее значение действует, номера карты в пути нет', () => {
    const r = parseCatalogText('{"version":1,"project":"pay","systems":[{"key":"a","name":"A","\\u006eame":"B"}],"4111111234557893":1,"4111111234557893":2}');
    if (!r.ok) throw new Error('fixture');
    expect((r.value as { systems: { name: string }[] }).systems[0]!.name).toBe('B');
    expect(r.warnings.map((w) => w.key)).toEqual(['catalog.duplicateField', 'catalog.duplicateField']);
    expect(r.warnings[0]!.path).toBe('systems.0.name');
    expect(JSON.stringify(r.warnings)).not.toContain('4111111234557893');
  });

  it('JSON без повторов, неверный JSON и слишком глубокий текст: как раньше', () => {
    expect(parseCatalogText('{"a":{"b":1},"c":{"b":1},"d":[{"b":1},{"b":2}]}', 'json')).toMatchObject({ ok: true, warnings: [] });
    expect(parseCatalogText("{'a':1}", 'json').ok).toBe(false);
    expect(parseCatalogText(`${'['.repeat(100_000)}${']'.repeat(100_000)}`, 'json')).toMatchObject({ ok: true, warnings: [] });
  });

  it('повтор поля в YAML: ошибка синтаксиса, а 1 и «1» в одной записи предупреждение', () => {
    expect(parseCatalogText('a: 1\na: 2\n', 'yaml')).toMatchObject({ ok: false, errors: [{ message: 'файл не разбирается как YAML: строка 2, столбец 1' }] });
    const mixed = parseCatalogText("m: { 1: x, '1': y }\n", 'yaml');
    expect(mixed).toMatchObject({ ok: true, value: { m: { 1: 'y' } }, warnings: [{ path: 'm.1', key: 'catalog.duplicateField' }] });
  });

  it('YAML читается как раньше: пустой текст, два документа, лишние ссылки', () => {
    expect(parseCatalogText('', 'yaml')).toEqual({ ok: true, value: null, warnings: [] });
    expect(parseCatalogText('a: 1\n---\nb: 2\n', 'yaml').ok).toBe(false);
    const aliases = `a: &a [1]\nb: [${Array.from({ length: 101 }, () => '*a').join(', ')}]\n`;
    expect(parseCatalogText(aliases, 'yaml').ok).toBe(false);
  });
});

describe('команда показывает предупреждения', () => {
  const base = { project: 'pay', dryRun: true, applied: false, added: [], changed: [], hidden: [], skipped: [], unchanged: 0, missing: 0 };
  const warning = { path: 'systems.0.type', message: 'поле без действия' };

  it('рядом с отчётом и рядом с ошибками файла', () => {
    expect(formatReport({ ...base, errors: [], warnings: [warning] }).join('\n')).toContain('Предупреждения (1), файл они не останавливают:\n  systems.0.type: поле без действия');
    const failed = formatReport({ ...base, errors: [{ path: 'a', message: 'нет' }], warnings: [warning] }).join('\n');
    expect(failed).toContain('Ошибки файла (1)');
    expect(failed).toContain('systems.0.type: поле без действия');
    expect(formatReport({ ...base, errors: [] }).join('\n')).not.toContain('Предупреждения');
  });
});

describe.skipIf(!PG_URL)('импорт файла', () => {
  it('первый импорт добавляет, повтор ничего не меняет', async () => {
    const d = await db();
    const first = await imp(d, file());
    expect(first.errors).toEqual([]);
    expect(first.applied).toBe(true);
    expect(first.added.map((i) => i.kind)).toEqual(expect.arrayContaining(['idType', 'system', 'method', 'error', 'outcome']));
    // Система-автор создана заранее — её переименование из файла считается изменением, а не повтором.
    expect(first.changed.map((i) => i.key)).toEqual(['pay']);
    const v = await version(d);
    const again = await imp(d, file());
    expect(again.applied).toBe(false);
    expect(again.added).toEqual([]);
    expect(again.changed).toEqual([]);
    expect(await version(d)).toBe(v);
  });

  it('проверка без записи не меняет таблицы и версию', async () => {
    const d = await db();
    await store.ensureProject(d, 'pay', 'Demo Pay');
    const v = await version(d);
    const r = await imp(d, file(), { dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(r.applied).toBe(false);
    expect(r.added.length).toBeGreaterThan(5);
    const s = await store.loadSnapshot(d, 'pay');
    expect(s.methods).toHaveLength(0);
    expect(s.version).toBe(v);
  });

  it('ручная правка не меняется без --force, с --force — заменяется', async () => {
    const d = await db();
    await imp(d, file());
    const s = await store.loadSnapshot(d, 'pay');
    const m = s.methods.find((x) => x.name === 'Карта по токену')!;
    await store.updateMethod(d, 'pay', m.id, m.systemId, { ...m, name: 'Своё название' }, { edited: true, hidden: false });
    const changed = file(CATALOG_YAML.replace('name: Карта по токену', 'name: Карта по токену v2'));
    const skip = await imp(d, changed);
    expect(skip.skipped.map((i) => i.kind)).toEqual(['method']);
    expect(skip.skipped[0]!.fields).toEqual(['name']);
    expect((await store.getRow(d, 'method', 'pay', m.id))!.name).toBe('Своё название');
    const forced = await imp(d, changed, { force: true });
    expect(forced.changed.map((i) => i.kind)).toEqual(['method']);
    const after = (await store.getRow(d, 'method', 'pay', m.id))!;
    expect(after.name).toBe('Карта по токену v2');
    expect(after.edited).toBe(false);
  });

  it('запись из редактора найдена по смысловому ключу и не дублируется', async () => {
    const d = await db();
    await store.ensureProject(d, 'pay', 'Demo Pay');
    const s = await store.loadSnapshot(d, 'pay');
    const author = s.systems[0]!;
    const base = { rpc: '', domain: null, description: null, kind: 'call' as const, op: null, fields: [], status: null };
    // В редакторе подстановка названа иначе: {id} вместо {userId} — это тот же метод.
    await store.insertMethod(d, 'pay', author.id, { ...base, http: 'POST', path: '/v1/cards/lookup', name: 'Из редактора' }, { seedKey: null, edited: true, hidden: false });
    const r = await imp(d, file());
    expect(r.skipped.some((i) => i.kind === 'method')).toBe(true);
    const methods = (await store.loadSnapshot(d, 'pay')).methods.filter((m) => m.path === '/v1/cards/lookup');
    expect(methods).toHaveLength(1);
    expect(methods[0]!.name).toBe('Из редактора');
  });

  it('скрытие записи файлом, запись пропала из файла — только число', async () => {
    const d = await db();
    await imp(d, file());
    const hidden = CATALOG_YAML.replace('name: Коммутатор-тест', 'name: Коммутатор-тест\n    hidden: true');
    const r = await imp(d, file(hidden));
    expect(r.hidden.map((i) => i.key)).toEqual(['switch']);
    const noProcessor = CATALOG_YAML.replace(/ {2}- key: processor[\s\S]*?(?= {2}- key: switch)/, '');
    const r2 = await imp(d, file(noProcessor));
    expect(r2.missing).toBeGreaterThanOrEqual(3);
    expect((await store.loadSnapshot(d, 'pay')).systems.some((x) => x.key === 'processor')).toBe(true);
  });

  it('ошибка в одной записи — ничего не применено', async () => {
    const d = await db();
    await store.ensureProject(d, 'pay', 'Demo Pay');
    const v = await version(d);
    const bad = file(CATALOG_YAML.replace('op: transfer }', 'op: nope }'));
    const r = await imp(d, bad);
    expect(r.applied).toBe(false);
    expect(r.errors.map((e) => e.path)).toContain('systems.0.methods.1.op');
    expect((await store.loadSnapshot(d, 'pay')).methods).toHaveLength(0);
    expect(await version(d)).toBe(v);
  });

  it('номер карты в файле — ошибка с путём, без значения', async () => {
    const d = await db();
    const r = await imp(d, file(CATALOG_YAML.replace('title: Карта не найдена в процессинге', 'title: Карта 4111111234557893 не найдена')));
    expect(r.errors.length).toBeGreaterThan(0);
    expect(JSON.stringify(r)).not.toContain('4111111234557893');
  });

  it('версия 2 и чужой проект отклонены', async () => {
    const d = await db();
    expect((await imp(d, { version: 2, project: 'pay' })).errors).toEqual([{ path: 'version', message: 'поддерживается версия формата 1' }]);
    expect((await imp(d, { version: 1, project: 'other' })).errors[0]!.path).toBe('project');
  });

  it('выгрузка → импорт без изменений, две выгрузки байт в байт', async () => {
    const d = await db();
    await imp(d, file());
    const a = await exportCatalogText(d, 'pay', 'yaml');
    const b = await exportCatalogText(d, 'pay', 'yaml');
    expect(a).toBe(b);
    expect(a.split('\n')[0]).toBe('# yaml-language-server: $schema=./catalog.schema.json');
    expect(a).not.toMatch(/updated_at|updatedAt|edited|seedKey/);
    const r = await imp(d, parse(a));
    expect(r.errors).toEqual([]);
    expect([r.added, r.changed, r.hidden, r.skipped].flat()).toEqual([]);
    const j = await exportCatalogText(d, 'pay', 'json');
    expect(JSON.parse(j)).toEqual(parse(a));
  });
});

describe.skipIf(!PG_URL)('сервис: состояния, начальный набор, опрос', () => {
  it('без адреса — off, Resolver нет', async () => {
    const { config } = await tempConfig();
    const s = service(config, undefined);
    await s.start();
    expect(s.state()).toEqual({ state: 'off', loadedAt: null, message: null });
    expect(s.resolver('pay')).toBeNull();
  });

  it('старт: миграции, автор, импорт набора по хэшу, загрузка', async () => {
    const url = (await freshDatabase())!;
    const { config } = await tempConfig({ catalog: CATALOG_YAML });
    const logs: Logs = { info: [], warn: [] };
    const s = service(config, url, logs, () => 1_000);
    closers.push(() => s.close());
    await s.start();
    expect(s.state()).toEqual({ state: 'ok', loadedAt: 1_000, message: null });
    expect(logs.info.some((m) => m.startsWith('начальный набор pay: добавлено'))).toBe(true);
    const r = s.resolver('pay')!;
    expect(r.author?.name).toBe('Тестовый шлюз');
    expect(s.snapshot('pay')!.methods.length).toBe(3);

    // Повторный старт с тем же файлом: импорта нет.
    const logs2: Logs = { info: [], warn: [] };
    const s2 = service(config, url, logs2);
    closers.push(() => s2.close());
    await s2.start();
    expect(logs2.info.some((m) => m.startsWith('начальный набор'))).toBe(false);
  });

  it('битый набор — в журнал, сервер работает', async () => {
    const url = (await freshDatabase())!;
    const { config } = await tempConfig({ catalog: 'version: 1\nproject: pay\nsystems: [{ key: X }]\n' });
    const logs: Logs = { info: [], warn: [] };
    const s = service(config, url, logs);
    closers.push(() => s.close());
    await s.start();
    expect(s.state().state).toBe('ok');
    expect(logs.warn.some((m) => m.includes('начальный набор pay: ошибок в файле'))).toBe(true);
  });

  it('база недоступна при старте — connecting, пароль не в тексте', async () => {
    const { config } = await tempConfig();
    const s = service(config, 'postgres://threadline:Very-Secret-1@127.0.0.1:1/threadline');
    closers.push(() => s.close());
    await s.start();
    const st = s.state();
    expect(st.state).toBe('connecting');
    expect(st.message).toContain('127.0.0.1:1/threadline');
    expect(st.message).not.toContain('Very-Secret-1');
  });

  it('база пропала во время работы — stale с прежними данными, правка закрыта; вернулась — ok', async () => {
    const url = (await freshDatabase())!;
    // Своё подключение, которое можно «уронить».
    let down = false;
    const s = new CatalogService({
      url,
      projects: [{ id: 'pay', name: 'Demo Pay', seedFile: null }],
      log: { info: () => undefined, warn: () => undefined },
      open: async (u) => {
        const real = await openDb(u);
        const guard = <T>(fn: () => Promise<T>) => (down ? Promise.reject(new DbError('connect ECONNREFUSED')) : fn());
        return {
          ...real,
          label: real.label,
          query: (sql: string, p?: readonly unknown[]) => guard(() => real.query(sql, p)),
          tx: <T>(fn: Parameters<Db['tx']>[0]) => guard(() => real.tx(fn)) as Promise<T>,
          close: () => real.close(),
        } as Db;
      },
    });
    closers.push(() => s.close());
    await s.start();
    expect(s.state().state).toBe('ok');
    down = true;
    await s.pollNow();
    expect(s.state().state).toBe('stale');
    expect(s.resolver('pay')).not.toBeNull();
    expect(() => s.db()).toThrow();
    down = false;
    await s.pollNow();
    expect(s.state().state).toBe('ok');
  });

  it('правка другой копии видна после опроса версии', async () => {
    const url = (await freshDatabase())!;
    const { config } = await tempConfig({ catalog: CATALOG_YAML });
    const a = service(config, url);
    const b = service(config, url);
    closers.push(() => a.close(), () => b.close());
    await a.start();
    await b.start();
    const m = a.snapshot('pay')!.methods.find((x) => x.name === 'Карты по токенам')!;
    await a.edit('pay', (q) => store.updateMethod(q, 'pay', m.id, m.systemId, { ...m, name: 'Переименовано' }, { edited: true, hidden: false }));
    expect(a.resolver('pay')!.methods.get(m.id)!.name).toBe('Переименовано');
    expect(b.resolver('pay')!.methods.get(m.id)!.name).toBe('Карты по токенам');
    await b.pollNow();
    expect(b.resolver('pay')!.methods.get(m.id)!.name).toBe('Переименовано');
  });
});
