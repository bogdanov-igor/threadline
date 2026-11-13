// Дополнения интерфейса: раздел настройки и выключатель шуток, который браузер читает из /api/auth/me.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuthMe } from '@threadline/core/access';
import { validateConfig } from '@threadline/core/config';
import { buildApp } from '../src/app.ts';
import { Backends } from '../src/backends/registry.ts';
import { ConfigError, loadConfig } from '../src/config/load.ts';
import { Browser, rig, type Rig } from './auth/harness.ts';

const BASE = `
defaults: { project: acme, environment: demo }
backends:
  demo: { type: mock }
projects:
  acme:
    name: Acme
    environments:
      demo: { name: Демо, backend: demo, selector: [{ label: namespace, op: '=', value: acme }] }
`;

const dirs: string[] = [];
const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

async function settingsFile(section: string) {
  const dir = await mkdtemp(join(tmpdir(), 'threadline-extras-'));
  dirs.push(dir);
  await writeFile(join(dir, 'threadline.yaml'), `auth: off\n${section}\n${BASE}`);
  return join(dir, 'threadline.yaml');
}

async function offApp(section: string) {
  const config = await loadConfig({ path: await settingsFile(section), env: {} });
  const app = await buildApp({ config, backends: new Backends(config) });
  closers.push(() => app.close());
  return app;
}

describe('раздел extras файла настроек', () => {
  const base = {
    auth: 'off',
    defaults: { project: 'a', environment: 'd' },
    backends: { m: { type: 'mock' } },
    projects: {
      a: {
        name: 'A',
        environments: {
          d: { name: 'D', backend: 'm', selector: [{ label: 'namespace', op: '=', value: 'a' }] },
        },
      },
    },
  };

  it('без раздела настройка прежняя', () => {
    const r = validateConfig(base);
    expect(r.ok && r.config.extras).toBeUndefined();
  });

  it('по умолчанию шутки включены, опечатка и неизвестное поле — ошибка с путём', () => {
    const r = validateConfig({ ...base, extras: {} });
    expect(r.ok && r.config.extras).toEqual({ publicEggs: true });
    for (const [extras, path] of [
      [{ publicEgs: false }, 'extras.publicEgs'],
      [{ file: 'x.yaml' }, 'extras.file'],
    ] as const) {
      const bad = validateConfig({ ...base, extras });
      expect(bad.ok).toBe(false);
      expect(!bad.ok && bad.issues.map((i) => i.path)).toEqual([path]);
    }
    expect(validateConfig({ ...base, extras: { publicEggs: 'no' } }).ok).toBe(false);
  });

  it('запуск с опечаткой не идёт, ошибка называет поле', async () => {
    const e = await loadConfig({ path: await settingsFile('extras: { publicEgs: false }'), env: {} }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ConfigError);
    expect((e as ConfigError).format()).toContain('extras.publicEgs: неизвестное поле');
  });
});

describe('выключатель в ответе /api/auth/me', () => {
  it.each([
    ['без раздела', '', true],
    ['publicEggs: true', 'extras: { publicEggs: true }', true],
    ['publicEggs: false', 'extras: { publicEggs: false }', false],
  ])('auth: off, %s', async (_name, section, on) => {
    const app = await offApp(section);
    const r = await app.inject('/api/auth/me');
    expect(r.statusCode).toBe(200);
    expect((r.json() as AuthMe).publicEggs).toBe(on);
  });

  it('прежних адресов дополнений нет', async () => {
    const app = await offApp('');
    for (const url of ['/api/extras', '/api/extras/media/pic.png']) expect((await app.inject(url)).statusCode, url).toBe(404);
  });

  describe('при включённом входе', () => {
    let r: Rig;
    afterEach(async () => {
      await r?.close();
    });

    it('вошедший получает значение настройки, без сессии — 401', async () => {
      r = await rig({ yaml: 'extras: { publicEggs: false }\n' });
      const b = new Browser(r.app);
      await b.login(r, 'support');
      const me = await b.get('/api/auth/me');
      expect(me.statusCode).toBe(200);
      expect((me.json() as AuthMe).publicEggs).toBe(false);
      const anon = await new Browser(r.app).get('/api/auth/me');
      expect(anon.statusCode).toBe(401);
    });
  });
});
