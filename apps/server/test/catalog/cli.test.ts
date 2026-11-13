import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { projectFileJsonSchema } from '@threadline/core/catalog/project-file';
import { runCatalogCli } from '../../src/catalog/cli-run.ts';
import { openDb } from '../../src/catalog/db.ts';
import { removeForever, removeRow } from '../../src/catalog/edit.ts';
import * as store from '../../src/catalog/store.ts';
import { CATALOG_YAML, tempConfig } from './fixture.ts';
import { freshDatabase, PG_URL } from './pg.ts';

async function run(argv: string[], env: Record<string, string | undefined>, cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCatalogCli(argv, { env, cwd, out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('команда threadline:catalog без базы', () => {
  it('без аргументов — подсказка и код 1', async () => {
    const { dir } = await tempConfig();
    const r = await run([], {}, dir);
    expect(r.code).toBe(1);
    expect(r.err).toContain('pnpm threadline:catalog import');
  });

  it('--help — подсказка и код 0', async () => {
    const { dir } = await tempConfig();
    const r = await run(['--help'], {}, dir);
    expect(r.code).toBe(0);
    expect(r.out).toContain('pnpm threadline:catalog import');
    expect(r.err).toBe('');
  });

  it('schema пишет схему, базу не трогает; путь от каталога запуска', async () => {
    const { dir } = await tempConfig();
    const r = await run(['schema', 'out.json'], {}, dir);
    expect(r.code).toBe(0);
    expect(JSON.parse(await readFile(join(dir, 'out.json'), 'utf8'))).toEqual(projectFileJsonSchema());
  });

  it('адрес не задан — код 2 и объяснение', async () => {
    const { dir } = await tempConfig();
    await writeFile(join(dir, 'pay.yaml'), CATALOG_YAML);
    const r = await run(['import', 'pay', 'pay.yaml'], { THREADLINE_CONFIG: join(dir, 'threadline.yaml') }, dir);
    expect(r.code).toBe(2);
    expect(r.err).toContain('THREADLINE_DATABASE_URL не задан');
  });

  it('база недоступна — код 2, пароль не в выводе', async () => {
    const { dir } = await tempConfig();
    const r = await run(['export', 'pay', 'x.yaml'], { THREADLINE_CONFIG: join(dir, 'threadline.yaml'), THREADLINE_DATABASE_URL: 'postgres://threadline:Top-Secret-9@127.0.0.1:1/threadline' }, dir);
    expect(r.code).toBe(2);
    expect(r.err + r.out).not.toContain('Top-Secret-9');
  });

  it('неизвестный проект и битый файл — код 1', async () => {
    const { dir } = await tempConfig();
    const env = { THREADLINE_CONFIG: join(dir, 'threadline.yaml'), THREADLINE_DATABASE_URL: 'postgres://x@127.0.0.1:1/x' };
    expect((await run(['import', 'zz', 'a.yaml'], env, dir)).code).toBe(1);
    await writeFile(join(dir, 'bad.yaml'), 'version: [1\n');
    expect((await run(['import', 'pay', 'bad.yaml'], env, dir)).code).toBe(1);
  });
});

describe.skipIf(!PG_URL)('команда threadline:catalog с базой', () => {
  it('при включённом входе команда работает как раньше: ни секретов, ни Keycloak ей не нужно', async () => {
    const { dir } = await tempConfig();
    const path = join(dir, 'threadline.yaml');
    const auth = ['auth:', '  issuer: http://127.0.0.1:1/realms/none', '  clientId: threadline', '  publicUrl: http://127.0.0.1:1', '  roleClaim: realm_access.roles', '  roles:', ...['business', 'support', 'developer', 'analyst', 'admin'].map((r) => `    ${r}: [threadline-${r}]`)].join('\n');
    await writeFile(path, (await readFile(path, 'utf8')).replace('auth: off', auth));
    await writeFile(join(dir, 'pay.yaml'), CATALOG_YAML);
    const env = { THREADLINE_CONFIG: path, THREADLINE_DATABASE_URL: (await freshDatabase())! };
    const r = await run(['import', 'pay', 'pay.yaml'], env, dir);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('Импорт применён');
  });

  it('новые группы отчёта: удалённое не возвращается без --force, с --force «Возвращено»; вход и роли не нужны', async () => {
    const { dir } = await tempConfig();
    const url = (await freshDatabase())!;
    const env = { THREADLINE_CONFIG: join(dir, 'threadline.yaml'), THREADLINE_DATABASE_URL: url };
    await writeFile(join(dir, 'pay.yaml'), CATALOG_YAML);
    expect((await run(['import', 'pay', 'pay.yaml'], env, dir)).code).toBe(0);
    const db = await openDb(url);
    try {
      const snapshot = await store.loadSnapshot(db, 'pay');
      const soft = snapshot.errors.find((e) => e.title === 'Система не ответила вовремя')!;
      const gone = snapshot.errors.find((e) => e.title === 'Карта не найдена в процессинге')!;
      await db.tx((q) => removeRow(q, 'pay', 'error', soft.id, soft.updatedAt));
      await db.tx((q) => removeRow(q, 'pay', 'error', gone.id, gone.updatedAt));
      const hidden = (await store.getRow(db, 'error', 'pay', gone.id))!;
      await db.tx((q) => removeForever(q, 'pay', 'error', gone.id, hidden.updatedAt));

      const plain = await run(['import', 'pay', 'pay.yaml'], env, dir);
      expect(plain.code, plain.err).toBe(0);
      expect(plain.out).toContain('Удалённые записи файл не возвращает (--force вернёт): 2');
      expect(plain.out).toContain('ошибка · Карта не найдена в процессинге');
      expect(plain.out).toContain('Возвращено: 0');
      expect((await store.loadSnapshot(db, 'pay')).errors.map((e) => e.title)).toEqual(['Система не ответила вовремя']);

      const forced = await run(['import', 'pay', 'pay.yaml', '--force'], env, dir);
      expect(forced.code, forced.err).toBe(0);
      expect(forced.out).toContain('Возвращено: 1');
      expect(forced.out).toContain('ошибка · Система не ответила вовремя');
      expect(forced.out).toContain('Добавлено: 1');
      expect((await store.loadSnapshot(db, 'pay')).errors.every((e) => !e.hidden)).toBe(true);
      expect(await store.deletedKeys(db, 'pay')).toEqual(new Set());
    } finally {
      await db.close();
    }
  });

  it('dry-run → import → повтор без изменений → export; ошибки файла — код 1', async () => {
    const { dir } = await tempConfig();
    const env = { THREADLINE_CONFIG: join(dir, 'threadline.yaml'), THREADLINE_DATABASE_URL: (await freshDatabase())! };
    await writeFile(join(dir, 'pay.yaml'), CATALOG_YAML);
    const dry = await run(['import', 'pay', 'pay.yaml', '--dry-run'], env, dir);
    expect(dry.code, dry.err).toBe(0);
    expect(dry.out).toContain('Проверка без записи');
    expect(dry.out).toMatch(/Добавлено: \d+/);
    const imp = await run(['import', 'pay', 'pay.yaml'], env, dir);
    expect(imp.code, imp.err).toBe(0);
    expect(imp.out).toContain('Импорт применён');
    const again = await run(['import', 'pay', 'pay.yaml'], env, dir);
    expect(again.out).toContain('Импорт: изменений нет');
    const ex = await run(['export', 'pay', 'back.yaml'], env, dir);
    expect(ex.code).toBe(0);
    expect(await readFile(join(dir, 'back.yaml'), 'utf8')).toContain('name: Процессинг-тест');
    await writeFile(join(dir, 'v2.yaml'), 'version: 2\nproject: pay\n');
    const bad = await run(['import', 'pay', 'v2.yaml'], env, dir);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain('поддерживается версия формата 1');
    expect(imp.out + ex.out).not.toContain('threadline@');
  });
});
