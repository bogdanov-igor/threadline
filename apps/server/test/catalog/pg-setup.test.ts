// Ловушка зелёного прогона: тесты на PostgreSQL пропускаются только при недоступном Docker, любая другая причина роняет прогон.

import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ROOT } from '../../src/paths.ts';
import { findPostgres, type DockerControl } from './pg-setup.ts';

const WRONG = 'Synthetic-Wrong-Pass-1';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return (server.address() as { port: number }).port;
}

/** Отвечает как PostgreSQL, которому не подошёл пароль: сообщение об ошибке 28P01 по протоколу. */
async function wrongPasswordUrl(): Promise<string> {
  const fields = Buffer.from('SFATAL\0C28P01\0Mpassword authentication failed for user "postgres"\0\0');
  const head = Buffer.alloc(5);
  head.write('E');
  head.writeInt32BE(fields.length + 4, 1);
  const port = await listen(createServer((s) => s.once('data', () => s.end(Buffer.concat([head, fields])))));
  return `postgres://postgres:${WRONG}@127.0.0.1:${port}/postgres`;
}

/** Адрес, на котором никто не слушает. */
async function closedUrl(): Promise<string> {
  const server = createServer();
  const port = await listen(server);
  await new Promise((r) => server.close(r));
  servers.splice(servers.indexOf(server), 1);
  return `postgres://postgres:${WRONG}@127.0.0.1:${port}/postgres`;
}

function docker(over: Partial<DockerControl> = {}) {
  return {
    available: vi.fn(() => true),
    running: vi.fn(() => false),
    start: vi.fn(),
    ...over,
  } satisfies DockerControl;
}

const dockerError = (stderr: string) => Object.assign(new Error('Command failed: docker run'), { stderr: `${stderr}\nRun 'docker run --help' for more information\n` });
const QUICK = { attempts: 2, pauseMs: 1 };

describe('поиск PostgreSQL для тестов', () => {
  it('другой пароль на порту: падение сразу, Docker не вызывается, пароль не в сообщении', async () => {
    const d = docker();
    const e = await findPostgres({ admin: await wrongPasswordUrl(), docker: d }).catch((x: Error) => x);
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).message).toContain('password authentication failed');
    expect((e as Error).message).toContain('THREADLINE_TEST_DATABASE_URL');
    expect((e as Error).message).not.toContain(WRONG);
    expect(d.available).not.toHaveBeenCalled();
  });

  it('THREADLINE_TEST_DATABASE_URL не отвечает: падение, а не пропуск, и без Docker', async () => {
    const d = docker({ available: vi.fn(() => false) });
    const e = await findPostgres({ given: await closedUrl(), docker: d }).catch((x: Error) => x);
    expect((e as Error).message).toContain('THREADLINE_TEST_DATABASE_URL не отвечает');
    expect((e as Error).message).not.toContain(WRONG);
    expect(d.available).not.toHaveBeenCalled();
  });

  it('THREADLINE_TEST_DATABASE_URL с другим паролем: падение', async () => {
    await expect(findPostgres({ given: await wrongPasswordUrl(), docker: docker() })).rejects.toThrow(/password authentication failed/);
  });

  it('Docker недоступен и порт свободен: единственный пропуск', async () => {
    const d = docker({ available: vi.fn(() => false) });
    await expect(findPostgres({ admin: await closedUrl(), docker: d })).resolves.toBeNull();
    expect(d.start).not.toHaveBeenCalled();
  });

  it('контейнер не запустился, порт занят: падение с причиной из docker', async () => {
    const d = docker({
      start: vi.fn(() => {
        throw dockerError('docker: Error response from daemon: Bind for 0.0.0.0:55432 failed: port is already allocated');
      }),
    });
    await expect(findPostgres({ admin: await closedUrl(), docker: d, ...QUICK })).rejects.toThrow(/контейнер не запустился .*port is already allocated.*Освободите порт 55432/);
  });

  it('docker ps упал при живом демоне: падение', async () => {
    const d = docker({
      running: vi.fn(() => {
        throw dockerError('permission denied');
      }),
    });
    await expect(findPostgres({ admin: await closedUrl(), docker: d, ...QUICK })).rejects.toThrow(/контейнер не запустился \(permission denied\)/);
  });

  it('контейнер запущен, но база так и не ответила: падение', async () => {
    const d = docker({ running: vi.fn(() => true) });
    await expect(findPostgres({ admin: await closedUrl(), docker: d, ...QUICK })).rejects.toThrow(/контейнер не ответил за/);
    expect(d.start).not.toHaveBeenCalled();
  });

  it('имя контейнера занято соседним прогоном: не отказ, дальше ожидание базы', async () => {
    const d = docker({
      start: vi.fn(() => {
        throw dockerError('docker: Error response from daemon: Conflict. The container name "/threadline-test-pg" is already in use');
      }),
    });
    await expect(findPostgres({ admin: await closedUrl(), docker: d, ...QUICK })).rejects.toThrow(/контейнер не ответил за/);
    expect(d.start).toHaveBeenCalledOnce();
  });
});

describe('прогон vitest целиком', () => {
  it('база отказала: файл с PostgreSQL падает, а не пропускается, код выхода ненулевой, причина в выводе', async () => {
    const url = await wrongPasswordUrl();
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('VITEST') && k !== 'NODE_ENV' && k !== 'TEST'));
    const run = promisify(execFile)(process.execPath, [join(ROOT, 'node_modules/vitest/vitest.mjs'), 'run', 'test/catalog/migrate.test.ts'], {
      cwd: join(ROOT, 'apps/server'),
      env: { ...env, THREADLINE_TEST_DATABASE_URL: url, NO_COLOR: '1' },
    });
    const r = await run.then(
      () => ({ code: 0, out: '' }),
      (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, out: e.stdout + e.stderr }),
    );
    expect(r.code).toBe(1);
    expect(r.out).toContain('password authentication failed');
    expect(r.out).not.toContain(WRONG);
    expect(r.out).toMatch(/Test Files\s+1 failed/);
    expect(r.out).not.toMatch(/\d+ skipped/);
  }, 60_000);
});
