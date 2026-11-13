// Остановка и запуск настоящим процессом: остановка по сигналу, проверка окружения при старте.
import { spawn, type ChildProcess } from 'node:child_process';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Health } from '../../src/health.ts';
import { drainMs, shutdownHandler, shutdownTimeoutMs } from '../../src/shutdown.ts';
import { configDir } from './kit.ts';

const SERVER_DIR = resolve(import.meta.dirname, '../..');

describe('порядок остановки', () => {
  const quietLog = { info: () => undefined, error: () => undefined };

  it('сначала готовность, потом закрытие, потом выход 0', async () => {
    const order: string[] = [];
    const health = new Health();
    const stop = shutdownHandler({
      app: {
        log: quietLog,
        close: async () => {
          order.push(`close:${(await health.readiness()).status}`);
        },
      },
      health,
      timeoutMs: 100,
      exit: (code) => order.push(`exit:${code}`),
    });
    await stop('SIGINT');
    expect(order).toEqual(['close:not-ready', 'exit:0']);
  });

  it('повторный сигнал ничего не делает', async () => {
    const close = vi.fn(async () => undefined);
    const exit = vi.fn();
    const stop = shutdownHandler({ app: { log: quietLog, close }, health: new Health(), timeoutMs: 100, exit });
    await Promise.all([stop('SIGINT'), stop('SIGINT')]);
    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('зависшая работа: запись в журнале и выход 1 по таймауту', async () => {
    const errors: string[] = [];
    const codes: number[] = [];
    const stop = shutdownHandler({ app: { log: { info: () => undefined, error: (m) => errors.push(m) }, close: () => new Promise(() => undefined) }, health: new Health(), timeoutMs: 30, exit: (c) => codes.push(c) });
    void stop('SIGINT');
    await expect.poll(() => codes).toEqual([1]);
    expect(errors[0]).toContain('принудительный выход');
  });

  it('ошибка закрытия: выход 1', async () => {
    const codes: number[] = [];
    const stop = shutdownHandler({ app: { log: quietLog, close: async () => Promise.reject(new Error('сбой')) }, health: new Health(), timeoutMs: 100, exit: (c) => codes.push(c) });
    await stop('SIGINT');
    expect(codes).toEqual([1]);
  });

  it('таймаут из переменной, по умолчанию 25 секунд, пауза не больше 5 секунд', () => {
    expect(shutdownTimeoutMs({})).toBe(25_000);
    expect(shutdownTimeoutMs({ THREADLINE_SHUTDOWN_TIMEOUT_SECONDS: '40' })).toBe(40_000);
    expect(drainMs(25_000)).toBe(5000);
    expect(drainMs(60_000)).toBe(5000);
    expect(drainMs(5000)).toBe(1000);
  });
});

const BASE_ENV = { THREADLINE_GRAFANA_TOKEN: '', THREADLINE_DATABASE_URL: '', THREADLINE_GRAFANA_URL: '', THREADLINE_STRICT_START: '', THREADLINE_ALLOW_NO_LOGIN: '1', THREADLINE_WEB_DIST: 'apps/web/no-such-dist' };

function start(env: Record<string, string>): { child: ChildProcess; out: () => string; port: () => number | null; exit: Promise<number | null> } {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/main.ts'], { cwd: SERVER_DIR, env: { ...process.env, ...BASE_ENV, ...env } });
  let text = '';
  child.stdout!.on('data', (d: Buffer) => (text += String(d)));
  child.stderr!.on('data', (d: Buffer) => (text += String(d)));
  const exit = new Promise<number | null>((done) => child.on('close', done));
  return {
    child,
    out: () => text,
    port: () => {
      const m = /Threadline запущен: http:\/\/127\.0\.0\.1:(\d+)/.exec(text);
      return m ? Number(m[1]) : null;
    },
    exit,
  };
}

describe('настоящий процесс', () => {
  it('SIGTERM: готовность сразу 503, запрос заканчивается, код 0, все записи JSON', { timeout: 30_000 }, async () => {
    const dir = await configDir();
    const port = 18477 + Math.floor(Math.random() * 500);
    const p = start({ THREADLINE_CONFIG: join(dir, 'threadline.yaml'), PORT: String(port), LOG_LEVEL: 'info', THREADLINE_SHUTDOWN_TIMEOUT_SECONDS: '10' });
    const base = `http://127.0.0.1:${port}`;
    await expect.poll(() => p.port(), { timeout: 15_000, interval: 50 }).toBe(port);
    expect((await fetch(`${base}/health/readiness`)).status).toBe(200);
    const inFlight = fetch(`${base}/api/projects/pay/envs/slow/connection?refresh=1`);
    await new Promise((done) => setTimeout(done, 100));
    p.child.kill('SIGTERM');
    await expect.poll(async () => (await fetch(`${base}/health/readiness`)).status, { timeout: 1500, interval: 20 }).toBe(503);
    expect((await fetch(`${base}/health/liveness`)).status).toBe(200);
    expect((await inFlight).status).toBe(200);
    expect(await p.exit).toBe(0);
    const lines = p.out().split('\n').filter(Boolean);
    for (const line of lines) {
      const r = JSON.parse(line) as Record<string, unknown>;
      for (const key of ['timestamp', 'level', 'message', 'request_id']) expect(r, line).toHaveProperty(key);
    }
    expect(lines.some((l) => l.includes('получен SIGTERM'))).toBe(true);
    expect(lines.some((l) => l.includes('сервер остановлен'))).toBe(true);
  });

  it('auth: off без разрешения: код 1, запись называет переменные входа и разрешение; пустое разрешение не считается', { timeout: 20_000 }, async () => {
    const dir = await configDir();
    const p = start({ THREADLINE_CONFIG: join(dir, 'threadline.yaml'), PORT: '0', THREADLINE_ALLOW_NO_LOGIN: '' });
    expect(await p.exit).toBe(1);
    const lines = p.out().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    const r = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(r.level).toBe('fatal');
    for (const name of ['THREADLINE_PUBLIC_URL', 'THREADLINE_OIDC_ISSUER', 'THREADLINE_OIDC_CLIENT_ID', 'THREADLINE_ALLOW_NO_LOGIN=1']) expect(r.message).toContain(name);
  });

  it('строгий запуск без базы: код 1, одна запись fatal с именем переменной', { timeout: 20_000 }, async () => {
    const dir = await configDir();
    const p = start({ THREADLINE_CONFIG: join(dir, 'threadline.yaml'), PORT: '0', THREADLINE_STRICT_START: '1', THREADLINE_DATABASE_URL: '' });
    expect(await p.exit).toBe(1);
    const lines = p.out().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    const r = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(r).toMatchObject({ level: 'fatal', request_id: 'system' });
    expect(r.message).toContain('THREADLINE_DATABASE_URL');
  });
});
