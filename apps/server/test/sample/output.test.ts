// Файл выборки: каталог, права, имя, атомарная запись, удаление. Все значения выдуманы.

import { chmod, mkdir, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ROOT } from '../../src/paths.ts';
import { MAX_FILE_BYTES } from '../../src/sample/limits.ts';
import { cleanSamples, fitFile, sampleName } from '../../src/sample/output.ts';
import { runSample } from '../../src/sample/run.ts';
import { box, dropBox, ioOf, NOW, run, Scripted, type Box } from './sample-kit.ts';

let b: Box;
beforeEach(async () => {
  b = await box();
});
afterEach(() => dropBox(b));

const DEMO = ['--env', 'demo', '--kind', 'labels'];
const adapterIo = () => ({ createAdapter: () => new Scripted() });
const mode = async (p: string) => (await stat(p)).mode & 0o777;
const NAME = sampleName('pay', 'demo', NOW);

async function runRaw(args: string[], over = {}) {
  b.lines.length = 0;
  return runSample(args, ioOf(b, { ...adapterIo(), ...over }));
}

describe('файл вне репозитория', () => {
  it('каталог по умолчанию в домашнем, права 0700 и 0600, имя из проекта, среды и времени', async () => {
    expect(await runRaw(DEMO)).toBe(0);
    const dir = join(b.home, 'threadline-samples');
    const [name] = await readdir(dir);
    expect(name).toBe(NAME);
    expect(name).toMatch(/^sample-pay-demo-\d{8}-\d{6}\.json$/);
    expect(await mode(dir)).toBe(0o700);
    expect(await mode(join(dir, name!))).toBe(0o600);
    expect(b.lines.join('\n')).toContain(join(dir, name!));
    expect(b.lines.join('\n')).toContain('--clean');
  });

  it('внутри репозитория: отказ до запросов, в том числе через ссылку', async () => {
    const adapter = new Scripted();
    const inside = join(ROOT, 'apps', 'server', 'samples-test-never-created');
    expect(await runRaw([...DEMO, '--out', inside], { createAdapter: () => adapter })).toBe(2);
    await expect(stat(inside)).rejects.toBeDefined();
    const rel = relative(b.root, inside);
    expect(await runRaw([...DEMO, '--out', rel], { createAdapter: () => adapter })).toBe(2);
    const link = join(b.root, 'to-repo');
    await symlink(join(ROOT, 'apps'), link);
    expect(await runRaw([...DEMO, '--out', link], { createAdapter: () => adapter })).toBe(2);
    expect(await runRaw([...DEMO, '--out', join(link, 'nested')], { createAdapter: () => adapter })).toBe(2);
    expect(adapter.calls).toEqual([]);
  });

  it('домашнего каталога нет или он недоступен: просьба задать --out, запросов нет', async () => {
    const adapter = new Scripted();
    expect(await runRaw(DEMO, { home: undefined, createAdapter: () => adapter })).toBe(2);
    expect(b.lines.join('\n')).toContain('--out');
    expect(await runRaw(DEMO, { home: join(b.root, 'no-such-home'), createAdapter: () => adapter })).toBe(2);
    expect(b.lines.join('\n')).toContain('--out');
    await chmod(b.home, 0o500);
    expect(await runRaw(DEMO, { createAdapter: () => adapter })).toBe(2);
    await chmod(b.home, 0o700);
    expect(adapter.calls).toEqual([]);
  });

  it('относительный --out считается от каталога запуска', async () => {
    const cwd = join(b.root, 'typed-here');
    await mkdir(cwd);
    expect(await runRaw([...DEMO, '--out', '../rel-samples'], { cwd })).toBe(0);
    expect(await readdir(join(b.root, 'rel-samples'))).toEqual([NAME]);
  });

  it('журналы *.log в корне не появляются и не растут', async () => {
    const logs = async () => {
      const out: Record<string, number> = {};
      for (const f of (await readdir(ROOT)).filter((n) => n.endsWith('.log'))) {
        // Эти журналы дописывают запущенные серверы разработки, а не команда.
        if (!/^threadline(-keycloak)?\.log$/.test(f)) out[f] = (await stat(join(ROOT, f))).size;
      }
      return out;
    };
    const before = await logs();
    expect((await run(b, DEMO, adapterIo())).code).toBe(0);
    expect(await logs()).toEqual(before);
  });
});

describe('запись файла', () => {
  it('каталог с широкими правами сужается', async () => {
    await mkdir(b.out, { mode: 0o755 });
    await chmod(b.out, 0o755);
    expect((await run(b, DEMO, adapterIo())).code).toBe(0);
    expect(await mode(b.out)).toBe(0o700);
  });

  it('каталог или имя файла — символическая ссылка: отказ', async () => {
    const real = join(b.root, 'real');
    await mkdir(real);
    const link = join(b.root, 'link');
    await symlink(real, link);
    expect(await runRaw([...DEMO, '--out', link])).toBe(2);
    expect(await readdir(real)).toEqual([]);
    await mkdir(b.out);
    await symlink(real, join(b.out, NAME));
    expect(await runRaw([...DEMO, '--out', b.out])).toBe(2);
  });

  it('файл с таким именем уже есть: новый с окончанием -2, прежний не меняется', async () => {
    await mkdir(b.out, { mode: 0o700 });
    await writeFile(join(b.out, NAME), 'прежний');
    expect((await run(b, DEMO, adapterIo())).code).toBe(0);
    const files = (await readdir(b.out)).sort();
    expect(files).toEqual([NAME.replace('.json', '-2.json'), NAME].sort());
    expect(await readFile(join(b.out, NAME), 'utf8')).toBe('прежний');
  });

  it('имя заняли за время запуска: следующий номер', async () => {
    const adapter = new Scripted();
    adapter.check = async () => {
      await writeFile(join(b.out, NAME), 'чужой');
      return { labelNames: [] };
    };
    expect(await runRaw([...DEMO, '--out', b.out], { createAdapter: () => adapter })).toBe(0);
    expect((await readdir(b.out)).sort()).toEqual([NAME.replace('.json', '-2.json'), NAME].sort());
    expect(await readFile(join(b.out, NAME), 'utf8')).toBe('чужой');
  });

  it('запись оборвалась: временный файл удалён, код 2', async () => {
    const r = await run(b, DEMO, {
      ...adapterIo(),
      writeContent: async (h) => {
        await h.writeFile('часть');
        throw Object.assign(new Error('ENOSPC: нет места'), { code: 'ENOSPC' });
      },
    });
    expect(r.code).toBe(2);
    expect(r.files).toEqual([]);
    expect(r.output).not.toContain('ENOSPC');
  });

  it('файл больше 256 КБ: деревья самых больших записей заменены, treesCut считает', () => {
    const tree = (kb: number) => ({ a: 'x'.repeat(kb * 1024) });
    const doc = {
      treesCut: 0,
      kinds: { names: { entries: { incoming: [{ tree: tree(120) }, { tree: tree(150) }, { tree: tree(10) }], exchange: [{ tree: tree(80) }] } } },
    };
    fitFile(doc);
    expect(doc.treesCut).toBe(1);
    expect(doc.kinds.names.entries.incoming[1]!.tree).toBe('<cut>');
    expect(doc.kinds.names.entries.incoming[0]!.tree).not.toBe('<cut>');
    expect(Buffer.byteLength(JSON.stringify(doc, null, 2))).toBeLessThanOrEqual(MAX_FILE_BYTES);
  });

  it('пустая выборка: файл с нулями и found 0, код 0', async () => {
    const r = await run(b, ['--env', 'demo', '--kind', 'all'], adapterIo());
    expect(r.code).toBe(0);
    expect(r.doc).toMatchObject({ format: 1, source: 'mock', project: 'pay', env: 'demo', mode: 'structure', startedOn: '2026-11-04', stopped: null, treesCut: 0 });
    expect(r.doc.kinds.labels.gateway.found).toBe(0);
    expect(r.text.endsWith('\n')).toBe(true);
    expect(r.text).toContain('\n  "format": 1');
  });
});

describe('--clean', () => {
  const samples = async (...names: string[]) => {
    await mkdir(b.out, { recursive: true, mode: 0o700 });
    for (const n of names) await writeFile(join(b.out, n), 'x');
  };
  const clean = (...more: string[]) => runRaw(['--clean', '--out', b.out, ...more]);

  it('три файла: удалены, каталог удалён, напечатано число', async () => {
    await samples('sample-pay-prod-20261104-153012.json', 'sample-pay-prod-20261104-153012-2.json', 'sample-pay-test-20261104-153013.json');
    expect(await clean()).toBe(0);
    await expect(stat(b.out)).rejects.toBeDefined();
    expect(b.lines.join('\n')).toContain('3');
  });

  it('чужой файл на месте, каталог остаётся, названо число оставшихся', async () => {
    await samples('sample-pay-prod-20261104-153012.json', 'notes.txt', 'sample-pay.json');
    expect(await clean()).toBe(0);
    expect((await readdir(b.out)).sort()).toEqual(['notes.txt', 'sample-pay.json']);
    expect(b.lines.join('\n')).toMatch(/осталось других файлов: 2/);
  });

  it('каталога нет: удалено 0, код 0', async () => {
    expect(await clean()).toBe(0);
    expect(b.lines.join('\n')).toContain('Удалено файлов выборки: 0');
  });

  it('ссылка удаляется как ссылка, цель остаётся; временный файл тоже', async () => {
    await samples('sample-pay-prod-20261104-153012.json.1234.tmp');
    const target = join(b.root, 'target.txt');
    await writeFile(target, 'цель');
    await symlink(target, join(b.out, 'sample-pay-prod-20261104-153013.json'));
    expect(await clean()).toBe(0);
    expect(await readFile(target, 'utf8')).toBe('цель');
    await expect(stat(b.out)).rejects.toBeDefined();
  });

  it('лишние флаги: подсказка, код 2, ничего не удалено', async () => {
    await samples('sample-pay-prod-20261104-153012.json');
    expect(await clean('--env', 'prod')).toBe(2);
    expect(await readdir(b.out)).toHaveLength(1);
  });

  it('работает с неверным THREADLINE_CONFIG и без токена', async () => {
    await samples('sample-pay-prod-20261104-153012.json');
    b.env = { THREADLINE_CONFIG: join(b.root, 'нет-такого.yaml') };
    expect(await clean()).toBe(0);
    await expect(stat(b.out)).rejects.toBeDefined();
  });

  it('каталог по умолчанию из домашнего', async () => {
    const dir = join(b.home, 'threadline-samples');
    await mkdir(dir);
    await writeFile(join(dir, 'sample-pay-prod-20261104-153012.json'), 'x');
    expect(await runRaw(['--clean'])).toBe(0);
    await expect(stat(dir)).rejects.toBeDefined();
  });

  it('cleanSamples на ссылке вместо каталога: отказ', async () => {
    const real = join(b.root, 'real');
    await mkdir(real);
    await symlink(real, b.out);
    await expect(cleanSamples(b.out)).rejects.toThrow();
  });
});
