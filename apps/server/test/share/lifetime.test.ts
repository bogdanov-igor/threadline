// Срок жизни ссылки, уборка, удаление проекта: часы через now, база PGlite.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectSettingsResponse } from '@threadline/core';
import { MOCK_PERSONAL } from '../../src/backends/mock/dataset-pay.ts';
import { openDb } from '../../src/catalog/db.ts';
import { migrate } from '../../src/catalog/migrate.ts';
import { insertLink, readLink, sweepLinks } from '../../src/share/store.ts';
import { sweepExpired } from '../../src/share/sweep.ts';
import { SettingsService } from '../../src/settings/service.ts';
import { freshDatabase, PG_URL } from '../catalog/pg.ts';
import { ANCHOR, as, DAY, search, share, shareRig, type ShareRig } from './harness.ts';

const KEY = '/api/settings/share.lifetimeDays';

let r: ShareRig;

beforeAll(async () => {
  r = await shareRig();
}, 60_000);

afterAll(async () => {
  await r.close();
});

beforeEach(async () => {
  r.clock.t = ANCHOR + 1000;
  await r.catalog.db().query('delete from share_link');
  await r.catalog.db().query('delete from service_setting');
});

const setLifetime = async (value: number) => {
  const list = (await r.app.inject({ url: '/api/settings', headers: as('admin') })).json() as { settings: { updatedAt: string | null }[] };
  const res = await r.app.inject({ method: 'PUT', url: KEY, headers: as('admin'), payload: { value, updatedAt: list.settings[0]!.updatedAt } });
  expect(res.statusCode, res.body).toBe(200);
};
const open = (id: string) => r.app.inject(`/api/s/${id}`);
const code = async (id: string) => ((await open(id)).json() as { error?: { code: string } }).error?.code;
const makeLink = async () => {
  // Задание держится в памяти при любых часах теста: обращение продлевает срок.
  const fresh = await search(r, [MOCK_PERSONAL.cid]);
  return share(r, { kind: 'results', searchId: fresh });
};
const sweepOptions = () => ({ readDb: () => r.catalog.readDb(), settings: new SettingsService(r.catalog), now: () => r.clock.t, warn: () => undefined });
const count = async () => (await r.catalog.db().query('select id from share_link')).length;

describe('Срок жизни ссылки', () => {
  it('срок истёк: сообщение как у несуществующей, к хранилищу запросов нет', async () => {
    const link = await makeLink();
    expect((await open(link.id)).statusCode).toBe(200);
    r.clock.t += 31 * DAY;
    const before = r.reads();
    const expired = await open(link.id);
    const missing = await open('A'.repeat(22));
    expect([expired.statusCode, expired.json()]).toEqual([404, { error: { code: 'share-not-found' } }]);
    expect(missing.json()).toEqual(expired.json());
    expect(r.reads()).toBe(before);
  });

  it('сокращение действует на старые ссылки сразу, уборка удаляет', async () => {
    const link = await makeLink();
    r.clock.t += 10 * DAY;
    expect((await open(link.id)).statusCode).toBe(200);
    await setLifetime(7);
    expect(await code(link.id)).toBe('share-not-found');
    expect(await sweepExpired(sweepOptions())).toBe(1);
    expect(await count()).toBe(0);
  });

  it('сначала уменьшили, потом вернули: не убранная строка открывается до прежней даты, убранная не возвращается', async () => {
    const kept = await makeLink();
    r.clock.t += 10 * DAY;
    await setLifetime(7);
    expect(await code(kept.id)).toBe('share-not-found');
    await setLifetime(30);
    expect((await open(kept.id)).statusCode).toBe(200);
    await setLifetime(7);
    await sweepExpired(sweepOptions());
    await setLifetime(30);
    expect(await code(kept.id)).toBe('share-not-found');
  });

  it('продление: прежняя ссылка живёт свой срок, новая получает новый', async () => {
    const old = await makeLink();
    await setLifetime(90);
    const fresh = await makeLink();
    expect(new Date(fresh.expiresAt).getTime() - r.clock.t).toBe(90 * DAY);
    r.clock.t += 31 * DAY;
    expect(await code(old.id)).toBe('share-not-found');
    expect((await open(fresh.id)).statusCode).toBe(200);
  });

  it('срок ссылки больше срока хранения логов принимается', async () => {
    await setLifetime(400);
    const link = await makeLink();
    expect(new Date(link.expiresAt).getTime() - r.clock.t).toBe(400 * DAY);
  });
});

describe('Уборка', () => {
  it('идемпотентна при двух копиях; строки до срока остаются', async () => {
    const a = await makeLink();
    r.clock.t += 20 * DAY;
    const b = await makeLink();
    r.clock.t += 11 * DAY;
    const [one, two] = await Promise.all([sweepExpired(sweepOptions()), sweepExpired(sweepOptions())]);
    expect(one + two).toBe(1);
    expect(await code(a.id)).toBe('share-not-found');
    expect((await open(b.id)).statusCode).toBe(200);
    expect(await count()).toBe(1);
  });

  it('база не ответила: предупреждение без значений, сервер работает, следующая уборка удалит', async () => {
    await makeLink();
    r.clock.t += 31 * DAY;
    const warnings: string[] = [];
    const failing = { ...r.catalog.readDb()!, query: () => Promise.reject(new Error('обрыв +447700900101')) };
    expect(await sweepExpired({ ...sweepOptions(), readDb: () => failing as never, warn: (m) => warnings.push(m) })).toBe(0);
    expect(warnings.join('')).not.toContain('447700900101');
    expect(await sweepExpired(sweepOptions())).toBe(1);
  });
});

describe('Проект и ссылки', () => {
  const settings = async () => (await r.app.inject({ url: '/api/project-settings', headers: as('admin') })).json() as ProjectSettingsResponse;
  const setting = async (id: string) => (await settings()).projects.find((p) => p.id === id)!;
  const hide = async (id: string, hidden: boolean) => {
    const res = await r.app.inject({ method: 'PUT', url: `/api/projects/${id}/visibility`, headers: as('admin'), payload: { hidden, updatedAt: (await setting(id)).updatedAt } });
    expect(res.statusCode, res.body).toBe(200);
  };
  const otherLink = () => r.catalog.db().query(`insert into share_link (id, kind, project_id, env_id, terms, from_at, to_at, created_at, expires_at)
    values ($1, 'results', 'other', 'demo', $2::jsonb, to_timestamp($3::double precision / 1000), to_timestamp($4::double precision / 1000), to_timestamp($4::double precision / 1000), to_timestamp($5::double precision / 1000))`, ['O'.repeat(22), JSON.stringify([MOCK_PERSONAL.cid]), ANCHOR - DAY, ANCHOR, ANCHOR + 30 * DAY]);

  it('скрыт: причина названа, показали снова: снова работает, к хранилищу запросов нет', async () => {
    await otherLink();
    const before = r.reads();
    await hide('other', true);
    expect(await code('O'.repeat(22))).toBe('share-project-hidden');
    expect((await open('O'.repeat(22))).statusCode).toBe(409);
    await hide('other', false);
    expect((await open('O'.repeat(22))).statusCode).toBe(200);
    expect(r.reads()).toBe(before);
  });

  it('удалён навсегда: строки стёрты той же транзакцией, новый проект их не получает', async () => {
    await otherLink();
    await hide('other', true);
    const { updatedAt } = await setting('other');
    const res = await r.app.inject({ method: 'DELETE', url: `/api/projects/other?confirm=other&updatedAt=${encodeURIComponent(updatedAt!)}`, headers: as('admin') });
    expect(res.statusCode, res.body).toBe(204);
    expect(await count()).toBe(0);
    expect(await code('O'.repeat(22))).toBe('share-not-found');
  });
});

describe.skipIf(!PG_URL)('запросы ссылок на настоящем PostgreSQL', () => {
  it('запись, чтение точных дат, выражение least и уборка', async () => {
    const db = await openDb((await freshDatabase())!);
    try {
      await migrate(db);
      const id = 'P'.repeat(22);
      await insertLink(db, { id, kind: 'operation', projectId: 'pay', envId: 'demo', stand: '7', terms: [], fromMs: ANCHOR - 123, toMs: ANCHOR + 456, target: { type: 't' }, createdMs: ANCHOR, expiresMs: ANCHOR + 30 * DAY });
      expect(await readLink(db, id, ANCHOR, 30)).toMatchObject({ kind: 'operation', stand: '7', fromMs: ANCHOR - 123, toMs: ANCHOR + 456, target: { type: 't' }, untilMs: ANCHOR + 30 * DAY });
      expect((await readLink(db, id, ANCHOR, 7))?.untilMs).toBe(ANCHOR + 7 * DAY);
      expect(await readLink(db, id, ANCHOR + 8 * DAY, 7)).toBeNull();
      expect(await sweepLinks(db, ANCHOR + 8 * DAY, 30)).toBe(0);
      expect(await sweepLinks(db, ANCHOR + 8 * DAY, 7)).toBe(1);
    } finally {
      await db.close();
    }
  });
});
