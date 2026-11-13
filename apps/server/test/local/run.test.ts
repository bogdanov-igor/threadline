// Запуск локального режима целиком: папка данных 0700 с настройкой демо-проекта, база PGlite в папке с миграциями, хранилища
// переживают перезапуск, вторая копия с той же папкой не запускается. Порты 8495–8497, папки временные.

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalStoragesResponse, ProjectSettingsResponse } from '@threadline/core';
import { openDb, pgliteDirUrl } from '../../src/catalog/db.ts';
import { pendingMigrations, readMigrations } from '../../src/catalog/migrate.ts';
import { runLocal, type Running } from '../../src/local/run.ts';

let root: string;
let web: string;
let lines: string[];
const out = { info: (m: string) => void lines.push(m), error: (m: string) => void lines.push(m) };
const running: Running[] = [];

// Журнал сервера в этих проверках не нужен: команда сама ставит warn, тест — тише.
process.env.LOG_LEVEL = 'silent';
// Настоящий запуск: PGlite в папке поднимается секунды, при параллельном прогоне дольше.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'threadline-local-run-'));
  web = join(root, 'web');
  await mkdir(web);
  await writeFile(join(web, 'index.html'), '<!doctype html><title>Threadline</title>');
  lines = [];
});

afterEach(async () => {
  for (const r of running.splice(0)) await r.close();
  await rm(root, { recursive: true, force: true });
});

const start = async (port: number, data = join(root, 'data'), extra: string[] = []) => {
  const r = await runLocal(['--port', String(port), '--no-open', '--data', data, ...extra], { env: { THREADLINE_WEB_DIST: web }, out, signals: false });
  if (typeof r !== 'number') running.push(r);
  return r;
};

const started = async (port: number, data?: string): Promise<Running> => {
  const r = await start(port, data);
  if (typeof r === 'number') throw new Error(`не запустился: ${lines.join('\n')}`);
  return r;
};

async function editable(url: string): Promise<ProjectSettingsResponse> {
  for (let i = 0; i < 200; i++) {
    const s = (await (await fetch(`${url}api/project-settings`)).json()) as ProjectSettingsResponse;
    if (s.editable) return s;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('база не подключилась');
}

describe('запуск', () => {
  it('первый запуск: папка 0700, настройка демо-проекта, база PGlite в папке с миграциями, только 127.0.0.1', async () => {
    const data = join(root, 'data');
    const r = await started(8495, data);
    expect(r.url).toBe('http://127.0.0.1:8495/');
    expect((await stat(data)).mode & 0o777).toBe(0o700);
    expect(lines.join('\n')).toContain('Threadline работает: http://127.0.0.1:8495/');

    const config = await readFile(join(data, 'threadline.yaml'), 'utf8');
    expect(config).toMatch(/^auth: off$/m);
    expect(config).toContain('Demo Pay');
    // Хранилищ кроме имитации нет: ни grafana, ни сред на ней.
    expect(config).not.toMatch(/loki-grafana|tokenEnv|backend: grafana/);
    await stat(join(data, 'catalog', 'pay.yaml'));
    await stat(join(data, 'logos', 'demo-pay-light.png'));

    const settings = await editable(r.url);
    expect(settings.state).toBe('ok');
    expect(settings.projects.map((p) => p.id)).toEqual(['pay']);
    expect(settings.stores.map((s) => s.id)).toEqual(['demo']);
    expect(((await (await fetch(`${r.url}api/auth/me`)).json()) as { local?: boolean }).local).toBe(true);
    expect(((await (await fetch(`${r.url}api/local/storages`)).json()) as LocalStoragesResponse).realStores).toBe(0);

    // На другом адресе сервер не слушает.
    await expect(fetch('http://[::1]:8495/api/health')).rejects.toThrow();
    await r.close();
    running.pop();

    // База — тот же путь миграций: после остановки ничего не отстало.
    const db = await openDb(pgliteDirUrl(join(data, 'db')));
    try {
      expect(await pendingMigrations(db, await readMigrations())).toEqual([]);
      const rows = await db.query<{ id: string }>('select id from project');
      expect(rows.map((x) => x.id)).toEqual(['pay']);
    } finally {
      await db.close();
    }
  });

  it('хранилище и проект переживают перезапуск; вторая копия с той же папкой не запускается', async () => {
    const data = join(root, 'data');
    let r = await started(8496, data);
    await editable(r.url);
    const saved = await fetch(`${r.url}api/local/storages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'my-loki', type: 'loki', url: 'http://127.0.0.1:9', auth: 'basic', username: 'reader', password: 'restart-secret-pw' }),
    });
    expect(saved.status).toBe(201);
    const made = await fetch(`${r.url}api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'shop', name: 'Shop', timezone: 'UTC', retentionDays: 30, format: 'json', environments: [{ id: 'prod', name: 'Прод', kind: 'single', backend: 'my-loki', selector: [{ label: 'namespace', op: '=', value: 'shop' }] }] }),
    });
    expect(made.status).toBe(201);

    // Вторая копия: код 0, адрес работающей, база не открывается дважды.
    lines = [];
    expect(await start(8497, data)).toBe(0);
    expect(lines.join('\n')).toContain('уже запущен');
    expect(lines.join('\n')).toContain('http://127.0.0.1:8496/');

    await r.close();
    running.pop();
    r = await started(8496, data);
    const after = await editable(r.url);
    expect(after.projects.map((p) => p.id).sort()).toEqual(['pay', 'shop']);
    expect(after.stores.map((s) => s.id).sort()).toEqual(['demo', 'my-loki']);
    const list = (await (await fetch(`${r.url}api/local/storages`)).json()) as LocalStoragesResponse;
    expect(list.storages).toMatchObject([{ id: 'my-loki', auth: 'basic', tokenSet: true, usedBy: ['shop/prod'] }]);
    expect(JSON.stringify(list)).not.toContain('restart-secret-pw');
  });

  it('занятый порт — код 1; справка и неверный параметр — без запуска', async () => {
    const r = await started(8495);
    lines = [];
    expect(await start(8495, join(root, 'other'))).toBe(1);
    expect(lines.join('\n')).toContain('Порт 8495 занят');
    await r.close();
    running.pop();
    expect(await runLocal(['--help'], { out, signals: false })).toBe(0);
    expect(await runLocal(['--host', '0.0.0.0'], { out, signals: false })).toBe(2);
    await expect(stat(join(root, 'never'))).rejects.toThrow();
  });

  it('без собранного интерфейса — понятная ошибка', async () => {
    const r = await runLocal(['--port', '8495', '--no-open', '--data', join(root, 'data')], { env: { THREADLINE_WEB_DIST: join(root, 'nope') }, out, signals: false });
    expect(r).toBe(1);
    expect(lines.join('\n')).toContain('pnpm build');
  });
});
