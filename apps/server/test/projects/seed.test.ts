// Таблицы проектов и сверка с файлом: каждый случай посева и сверки. Журнал без значений полей.

import { describe, expect, it } from 'vitest';
import { environmentList } from '@threadline/core/config/project-input';
import type { ProjectConfig } from '@threadline/core/config';
import { DbError, openDb, type Db, type Queryable } from '../../src/catalog/db.ts';
import { migrate } from '../../src/catalog/migrate.ts';
import * as catalogStore from '../../src/catalog/store.ts';
import * as store from '../../src/projects/store.ts';
import { fileData, fileStateOf, fileVersion, recordCanon, syncProjects, type FileProjects } from '../../src/projects/sync.ts';
import { freshDatabase, PG_URL } from '../catalog/pg.ts';
import { logoFile, logoPair, pngBytes, type Logs } from './harness.ts';

const env = (name: string, value: string, id = 'prod') => ({
  [id]: { name, kind: 'single' as const, backend: 'demo', selector: [{ label: 'namespace', op: '=' as const, value }] },
});

const project = (name = 'Acme', over: Partial<ProjectConfig> = {}): ProjectConfig => ({ name, format: 'json', retentionDays: 30, timezone: 'Asia/Karachi', environments: env('Прод', 'acme'), ...over });

const file = (projects: Record<string, ProjectConfig>, logos: FileProjects['logos'] = new Map()): FileProjects => ({ projects, logos });

const engines: [string, () => Promise<string | null>][] = [
  ['PGlite', async () => 'pglite://memory'],
  ['PostgreSQL', async () => (PG_URL ? await freshDatabase() : null)],
];

describe.each(engines)('проекты на %s', (engineName, urlOf) => {
  const skip = engineName === 'PostgreSQL' && !PG_URL;

  const withDb = async (fn: (db: Db) => Promise<void>) => {
    const db = await openDb((await urlOf())!);
    try {
      await migrate(db);
      await fn(db);
    } finally {
      await db.close();
    }
  };

  const sync = (db: Db, f: FileProjects, logs: Logs = { info: [], warn: [] }, formats: string[] = []) =>
    db.tx((q) => syncProjects(q, f, formats, { info: (m) => logs.info.push(m), warn: (m) => logs.warn.push(m) }));

  const row = async (db: Queryable, id: string) => (await store.readProject(db, id))!;
  const edit = async (db: Db, id: string, name: string) => {
    const r = await row(db, id);
    await store.updateProject(db, { ...r, name }, { hiddenBy: r.hiddenBy, fromFile: r.fromFile, edited: true, fileHash: r.fileHash });
  };

  it.skipIf(skip)('миграция: повтор ничего не применяет, ограничения отклоняют неверное', async () => {
    await withDb(async (db) => {
      expect((await migrate(db)).applied).toEqual([]);
      const insert = (id: string, hidden: string | null = null) =>
        db.query(`insert into project (id, name, timezone, retention_days, format, environments, position, hidden_by) values ($1, 'x', 'UTC', 1, 'json', '[]'::jsonb, 0, $2)`, [id, hidden]);
      await expect(insert('BAD ID')).rejects.toBeInstanceOf(DbError);
      await expect(insert('ok-id', 'nobody')).rejects.toBeInstanceOf(DbError);
      await insert('ok-id');
      const big = Buffer.alloc(262_145);
      await expect(db.query(`insert into project_logo (project_id, theme, content, content_type, ratio, hash) values ('ok-id', 'light', $1, 'image/png', 1, 'h')`, [big])).rejects.toBeInstanceOf(DbError);
    });
  });

  it.skipIf(skip)('запись читается как написана: порядок сред и проектов, байты логотипа, признаки', async () => {
    await withDb(async (db) => {
      const envs = environmentList({ ...env('Б', 'b', 'zeta'), ...env('А', 'a', 'alpha'), ...env('В', 'c', 'mid') });
      const data = { id: 'second', name: 'Второй', timezone: 'UTC', retentionDays: 7, format: 'json', environments: envs };
      await store.insertProject(db, { ...data, id: 'zzz' }, 0, { hiddenBy: null, fromFile: true, edited: false, fileHash: 'h1' });
      await store.insertProject(db, data, 1, { hiddenBy: 'page', fromFile: false, edited: true, fileHash: null });
      const rows = await store.readProjects(db);
      expect(rows.map((r) => r.id)).toEqual(['zzz', 'second']);
      expect(rows[1]!.environments.map((e) => e.id)).toEqual(['zeta', 'alpha', 'mid']);
      expect(rows[1]).toMatchObject({ hiddenBy: 'page', fromFile: false, edited: true, fileHash: null, retentionDays: 7 });
      expect(rows[0]).toMatchObject({ fromFile: true, edited: false, fileHash: 'h1' });
      expect(rows[0]!.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);

      const bytes = pngBytes(16, 8);
      await store.replaceLogo(db, 'second', logoPair(logoFile(bytes, 'aaa', 'image/png', 2), logoFile(pngBytes(8, 8), 'bbb')));
      const logos = await store.readLogos(db);
      expect(Buffer.compare(logos.get('second')!.light.body, bytes)).toBe(0);
      expect(logos.get('second')).toMatchObject({ ratio: 2, dark: { hash: 'bbb' } });
      await store.replaceLogo(db, 'second', logoPair(logoFile(bytes, 'aaa', 'image/png', 2)));
      const one = (await store.readLogos(db)).get('second')!;
      expect(one.dark).toBe(one.light);
    });
  });

  it.skipIf(skip)('пустая база: проекты из файла в том же порядке, у каждого автор справочника', async () => {
    await withDb(async (db) => {
      expect(await sync(db, file({ zeta: project('Зета'), alpha: project('Альфа') }))).toBe(true);
      const rows = await store.readProjects(db);
      expect(rows.map((r) => r.id)).toEqual(['zeta', 'alpha']);
      expect(rows[0]).toMatchObject({ fromFile: true, edited: false });
      expect(rows[0]!.fileHash).toBe(fileVersion(file({ zeta: project('Зета') }), 'zeta')!.hash);
      expect(await db.query('select key, name from catalog_system where project_id = $1', ['zeta'])).toEqual([{ key: 'zeta', name: 'Зета' }]);
      expect(await store.readVersion(db)).toBe(2);
    });
  });

  it.skipIf(skip)('перезапуск с тем же файлом не меняет записи и версию', async () => {
    await withDb(async (db) => {
      const f = file({ acme: project() });
      await sync(db, f);
      const before = await row(db, 'acme');
      const version = await store.readVersion(db);
      expect(await sync(db, f)).toBe(false);
      expect((await row(db, 'acme')).updatedAt).toBe(before.updatedAt);
      expect(await store.readVersion(db)).toBe(version);
    });
  });

  it.skipIf(skip)('файл изменился, проект не правили: заменён, непроправленный автор переименован', async () => {
    await withDb(async (db) => {
      await sync(db, file({ acme: project('Старое') }));
      await sync(db, file({ acme: project('Новое') }));
      const r = await row(db, 'acme');
      expect(r.name).toBe('Новое');
      expect(r.edited).toBe(false);
      expect(await db.query('select name from catalog_system where project_id = $1', ['acme'])).toEqual([{ name: 'Новое' }]);
    });
  });

  it.skipIf(skip)('автора правили в редакторе: его название остаётся', async () => {
    await withDb(async (db) => {
      await sync(db, file({ acme: project('Старое') }));
      await db.query(`update catalog_system set name = 'Своё', edited = true where project_id = 'acme'`);
      await sync(db, file({ acme: project('Новое') }));
      expect(await db.query('select name from catalog_system where project_id = $1', ['acme'])).toEqual([{ name: 'Своё' }]);
    });
  });

  it.skipIf(skip)('правили на странице: файл прежний — здесь, файл другой — не применён, журнал без значений', async () => {
    await withDb(async (db) => {
      const f = file({ acme: project('Из файла') });
      await sync(db, f);
      await edit(db, 'acme', 'Со страницы');
      const logs: Logs = { info: [], warn: [] };
      await sync(db, f, logs);
      const r = await row(db, 'acme');
      expect(r.name).toBe('Со страницы');
      expect(logs.warn).toEqual([]);
      expect(fileStateOf(r, recordCanon(r, null), fileVersion(f, 'acme'))).toBe('here');

      const secret = 'значение-селектора-из-файла';
      const g = file({ acme: project('Новое из файла', { environments: env('Прод', secret) }) });
      await sync(db, g, logs);
      const s = await row(db, 'acme');
      expect(s.name).toBe('Со страницы');
      expect(fileStateOf(s, recordCanon(s, null), fileVersion(g, 'acme'))).toBe('file-newer');
      expect(logs.warn).toHaveLength(1);
      expect(logs.warn[0]).toContain('acme');
      expect(logs.warn[0]).toContain('environments');
      expect(logs.warn[0]).not.toContain(secret);
      expect(logs.warn[0]).not.toContain('Новое из файла');
    });
  });

  it.skipIf(skip)('канон совпал: отметки снимаются, дальше файл снова применяется', async () => {
    await withDb(async (db) => {
      await sync(db, file({ acme: project('Из файла') }));
      await edit(db, 'acme', 'Перенесли');
      await sync(db, file({ acme: project('Перенесли') }));
      const r = await row(db, 'acme');
      expect(r.edited).toBe(false);
      await sync(db, file({ acme: project('Дальше') }));
      expect((await row(db, 'acme')).name).toBe('Дальше');
    });
  });

  it.skipIf(skip)('созданный на странице и дописанный в файл не заменён: file-newer', async () => {
    await withDb(async (db) => {
      await store.insertProject(db, fileData('acme', project('Со страницы')), 0, { hiddenBy: null, fromFile: false, edited: true, fileHash: null });
      await sync(db, file({ other: project('Другой') }));
      const f = file({ acme: project('Из файла'), other: project('Другой') });
      await sync(db, f);
      const r = await row(db, 'acme');
      expect(r).toMatchObject({ name: 'Со страницы', edited: true, fileHash: null });
      expect(fileStateOf(r, recordCanon(r, null), fileVersion(f, 'acme'))).toBe('file-newer');
    });
  });

  it.skipIf(skip)('убран из файла, не правили: скрыт отметкой, записи на месте, возврат показывает', async () => {
    await withDb(async (db) => {
      await sync(db, file({ a: project('A'), b: project('B') }));
      const f = file({ a: project('A') });
      await sync(db, f);
      const r = await row(db, 'b');
      expect(r.hiddenBy).toBe('file');
      expect(fileStateOf(r, recordCanon(r, null), fileVersion(f, 'b'))).toBe('removed');
      expect(await db.query('select key from catalog_system where project_id = $1', ['b'])).toHaveLength(1);
      await sync(db, file({ a: project('A'), b: project('B') }));
      expect((await row(db, 'b')).hiddenBy).toBe(null);
    });
  });

  it.skipIf(skip)('убран из файла, правили или создан на странице: не трогается, отметка none', async () => {
    await withDb(async (db) => {
      await sync(db, file({ a: project('A'), b: project('B') }));
      await edit(db, 'b', 'Правили');
      await store.insertProject(db, fileData('page', project('Со страницы')), 9, { hiddenBy: null, fromFile: false, edited: true, fileHash: null });
      const f = file({ a: project('A') });
      await sync(db, f);
      for (const id of ['b', 'page']) {
        const r = await row(db, id);
        expect(r.hiddenBy).toBe(null);
        expect(fileStateOf(r, recordCanon(r, null), fileVersion(f, id))).toBe('none');
      }
    });
  });

  it.skipIf(skip)('последний видимый при уборке из файла остаётся видимым, журнал называет причину', async () => {
    await withDb(async (db) => {
      await sync(db, file({ a: project('A') }));
      const logs: Logs = { info: [], warn: [] };
      await sync(db, file({ other: project('Другой', { format: 'gone' }) }), logs, []);
      expect((await row(db, 'a')).hiddenBy).toBe(null);
      expect(logs.warn.join()).toContain('других видимых проектов нет');
    });
  });

  it.skipIf(skip)('«Показать» после уборки: запись правленая, следующий запуск её не скрывает', async () => {
    await withDb(async (db) => {
      await sync(db, file({ a: project('A'), b: project('B') }));
      const f = file({ a: project('A') });
      await sync(db, f);
      const r = await row(db, 'b');
      await store.setFlags(db, 'b', { hiddenBy: null, fromFile: r.fromFile, edited: true, fileHash: r.fileHash });
      await sync(db, f);
      const s = await row(db, 'b');
      expect(s.hiddenBy).toBe(null);
      expect(fileStateOf(s, recordCanon(s, null), fileVersion(f, 'b'))).toBe('none');
    });
  });

  it.skipIf(skip)('скрытый на странице: файл обновляет его, он остаётся скрытым и после уборки и возврата', async () => {
    await withDb(async (db) => {
      await sync(db, file({ a: project('A'), b: project('B') }));
      const r = await row(db, 'b');
      await store.setFlags(db, 'b', { ...r, hiddenBy: 'page' });
      await sync(db, file({ a: project('A'), b: project('B новое') }));
      expect(await row(db, 'b')).toMatchObject({ name: 'B новое', hiddenBy: 'page' });
      await sync(db, file({ a: project('A') }));
      expect((await row(db, 'b')).hiddenBy).toBe('page');
      await sync(db, file({ a: project('A'), b: project('B новое') }));
      expect((await row(db, 'b')).hiddenBy).toBe('page');
    });
  });

  it.skipIf(skip)('удалённый на странице файл не возвращает и журнал просит убрать; новое создание снимает запрет', async () => {
    await withDb(async (db) => {
      const f = file({ a: project('A'), b: project('B') });
      await sync(db, f);
      await db.tx(async (q) => {
        await catalogStore.lockProject(q, 'b');
        await store.deleteProject(q, 'b', true);
      });
      const logs: Logs = { info: [], warn: [] };
      await sync(db, f, logs);
      expect(await store.readProject(db, 'b')).toBe(null);
      expect(logs.warn.join()).toContain('уберите его из файла');
      await store.removeDeleted(db, 'b');
      await sync(db, f);
      expect((await row(db, 'b')).name).toBe('B');
    });
  });

  it.skipIf(skip)('логотип копируется при посеве, совпавший логотип не даёт расхождения', async () => {
    await withDb(async (db) => {
      const logo = logoPair(logoFile(pngBytes(8, 8), 'aaa'));
      const f = file({ a: project('A') }, new Map([['a', logo]]));
      await sync(db, f);
      const saved = (await store.readLogos(db)).get('a')!;
      expect(saved.light.hash).toBe('aaa');
      expect(await sync(db, f)).toBe(false);
      // Битый файл до посева не доходит: проект без логотипа, запуск не останавливается.
      await sync(db, file({ a: project('A') }));
      expect((await store.readLogos(db)).get('a')).toBeUndefined();
    });
  });

  it.skipIf(skip)('обрыв на середине: сверка откатана целиком', async () => {
    await withDb(async (db) => {
      await sync(db, file({ a: project('A') }));
      const version = await store.readVersion(db);
      let inserts = 0;
      const breaking = async (q: Queryable) => {
        const wrapped: Queryable = {
          exec: (s) => q.exec(s),
          query: (s, p) => {
            if (/^\s*insert into project\b/.test(s) && ++inserts === 2) return Promise.reject(new DbError('connection lost', 'ECONNRESET'));
            return q.query(s, p) as never;
          },
        };
        return syncProjects(wrapped, file({ a: project('A'), b: project('B'), c: project('C') }), [], { info: () => undefined, warn: () => undefined });
      };
      await expect(db.tx(breaking)).rejects.toBeInstanceOf(DbError);
      expect((await store.readProjects(db)).map((r) => r.id)).toEqual(['a']);
      expect(await store.readVersion(db)).toBe(version);
    });
  });
});

describe.skipIf(!PG_URL)('две копии на PostgreSQL', () => {
  it('одновременно на пустой базе: каждый проект один раз', async () => {
    const url = (await freshDatabase())!;
    const a = await openDb(url);
    const b = await openDb(url);
    try {
      await migrate(a);
      const f = file({ one: project('Один'), two: project('Два') });
      const log = { info: () => undefined, warn: () => undefined };
      await Promise.all([a.tx((q) => syncProjects(q, f, [], log)), b.tx((q) => syncProjects(q, f, [], log))]);
      expect((await store.readProjects(a)).map((r) => r.id)).toEqual(['one', 'two']);
    } finally {
      await a.close();
      await b.close();
    }
  });
});
