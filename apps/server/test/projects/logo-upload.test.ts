// Логотип в теле проекта: проверка, замена без перезапуска, раздача из памяти. Файлы синтетические.

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectErrorBody, ProjectSetting, ProjectSettingsResponse, ProjectsResponse } from '@threadline/core';
import { openDb, type Db } from '../../src/catalog/db.ts';
import { migrate } from '../../src/catalog/migrate.ts';
import { checkLogoBytes } from '../../src/config/logo.ts';
import { fakeGrafana, grafana85 } from '../fake-grafana.ts';
import { base64, configYaml, NAMESPACES, pngBytes, stand, svgBytes } from './harness.ts';

let db: Db;
let app: FastifyInstance;
let grafana: Awaited<ReturnType<typeof fakeGrafana>>;

beforeEach(async () => {
  db = await openDb('pglite://memory');
  await migrate(db);
  grafana = await fakeGrafana(grafana85({ values: NAMESPACES }));
  ({ app } = await stand(db, configYaml({ url: grafana.url })));
});

afterEach(async () => {
  await app.close();
  await db.close();
  await grafana.close();
});

const body = (logo?: unknown, over: Record<string, unknown> = {}) => ({
  id: 'acme',
  name: 'Acme',
  timezone: 'Asia/Karachi',
  retentionDays: 30,
  format: 'json',
  environments: [{ id: 'demo', name: 'Демо', kind: 'single', backend: 'demo', selector: [{ label: 'namespace', op: '=', value: 'acme' }] }],
  ...(logo !== undefined ? { logo } : {}),
  ...over,
});

const create = (logo?: unknown) => app.inject({ method: 'POST', url: '/api/projects', payload: body(logo) });
const setting = async (id = 'acme'): Promise<ProjectSetting> => (await app.inject('/api/project-settings')).json<ProjectSettingsResponse>().projects.find((p) => p.id === id)!;
const info = async (id = 'acme') => (await app.inject('/api/projects')).json<ProjectsResponse>().projects.find((p) => p.id === id);
const update = (p: ProjectSetting, logo: unknown, over: Record<string, unknown> = {}) =>
  app.inject({ method: 'PUT', url: `/api/projects/${p.id}`, payload: { name: p.name, timezone: p.timezone, retentionDays: p.retentionDays, format: p.format, environments: p.environments, updatedAt: p.updatedAt, ...(logo !== undefined ? { logo } : {}), ...over } });
const fields = (r: { json: () => { error: { fields: Record<string, string> } } }) => r.json().error.fields;

describe('проверка содержимого', () => {
  it('PNG 5000×5000 отклонён, SVG с viewBox 10000×10000 принят', () => {
    expect(checkLogoBytes(pngBytes(5000, 5000))).toMatchObject({ reason: expect.stringContaining('4096') });
    expect(checkLogoBytes(svgBytes('', '0 0 10000 10000'))).toMatchObject({ type: 'image/svg+xml', ratio: 1 });
  });

  it.each([
    ['@import', '<style>@import "x.css";</style>'],
    ['сущность в атрибуте', '<g fill="&#x6a;avascript"></g>'],
    ['скрипт', '<script>1</script>'],
    ['обработчик', '<g onload="1"></g>'],
    ['foreignObject', '<foreignObject></foreignObject>'],
    ['внешняя ссылка', '<a href="https://evil.example"></a>'],
  ])('SVG: %s', (_w, extra) => {
    expect(checkLogoBytes(svgBytes(extra))).toMatchObject({ reason: expect.any(String) });
  });

  it('<!DOCTYPE с внутренним подмножеством отклонён', () => {
    expect(checkLogoBytes(Buffer.from('<!DOCTYPE svg [<!ELEMENT a ANY>]><svg viewBox="0 0 1 1"></svg>'))).toMatchObject({ reason: expect.any(String) });
  });

  it('тип определяется по содержимому, а не по имени', () => {
    expect(checkLogoBytes(pngBytes(16, 8))).toMatchObject({ type: 'image/png', ratio: 2 });
    expect(checkLogoBytes(Buffer.from('GIF89a.......'))).toMatchObject({ reason: expect.any(String) });
  });
});

describe('логотип на форме', () => {
  it('обе версии: адреса с хешем, байты отдаются, запросов наружу нет', async () => {
    const light = pngBytes(16, 8);
    const dark = pngBytes(8, 8, 3);
    expect((await create({ light: base64(light), dark: base64(dark) })).statusCode).toBe(201);
    const logo = (await info())!.logo!;
    expect(logo.ratio).toBe(2);
    expect(logo.light).not.toBe(logo.dark);
    const r = await app.inject(logo.light);
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('image/png');
    expect(Buffer.compare(r.rawPayload, light)).toBe(0);
    expect(r.headers['cache-control']).toContain('immutable');
    expect(Buffer.compare((await app.inject(logo.dark)).rawPayload, dark)).toBe(0);
    expect(grafana.requests).toHaveLength(0);
  });

  it('одна версия: адреса совпадают', async () => {
    await create({ light: base64(pngBytes()) });
    const logo = (await info())!.logo!;
    expect(logo.light).toBe(logo.dark);
  });

  it('только тёмная и плохая одна из двух: ничего не сохранено', async () => {
    const dark = await create({ dark: base64(pngBytes()) });
    expect(fields(dark)['logo.light']).toContain('обязательна');
    const bad = await create({ light: base64(pngBytes()), dark: base64(Buffer.from('GIF89a')) });
    expect(bad.statusCode).toBe(422);
    expect(Object.keys(fields(bad))).toEqual(['logo.dark']);
    expect(await info()).toBeUndefined();
  });

  it('отклонённый логотип: ключ сообщения и параметры рядом с русским текстом', async () => {
    const active = await create({ light: base64(Buffer.from('<svg viewBox="0 0 1 1" onload="x()"></svg>')) });
    expect(active.statusCode).toBe(422);
    const error = active.json().error as ProjectErrorBody['error'];
    expect(error.fields!['logo.light']).toContain('активное содержимое');
    expect(error.fieldKeys).toEqual({ 'logo.light': { key: 'logo.svgHandler' } });
    const huge = await create({ light: base64(pngBytes(5000, 5000)) });
    expect((huge.json().error as ProjectErrorBody['error']).fieldKeys).toEqual({ 'logo.light': { key: 'logo.pngTooLarge', params: { width: 5000, height: 5000, max: 4096 } } });
  });

  it('больше предела и адрес вместо содержимого: отказ без запросов наружу', async () => {
    const big = await create({ light: base64(Buffer.alloc(300 * 1024, 1)) });
    expect(big.statusCode).toBe(422);
    expect(fields(big)['logo.light']).toContain('256');
    const url = await create({ light: 'https://evil.example/logo.png' });
    expect(fields(url)['logo.light']).toContain('адрес не принимается');
    const asString = await create('https://evil.example/logo.png');
    expect(Object.keys(fields(asString))).toEqual(['logo']);
    expect(grafana.requests).toHaveLength(0);
  });

  it('замена: новый адрес без перезапуска, старый хеш без долгого кэша; keep и правка названия не трогают логотип', async () => {
    await create({ light: base64(pngBytes()) });
    const was = (await info())!.logo!;
    const fresh = pngBytes(32, 8);
    expect((await update(await setting(), { light: base64(fresh) })).statusCode).toBe(200);
    const now = (await info())!.logo!;
    expect(now.light).not.toBe(was.light);
    expect(now.ratio).toBe(4);
    const old = await app.inject(was.light);
    expect(old.headers['cache-control']).toBe('no-cache');
    expect(Buffer.compare(old.rawPayload, fresh)).toBe(0);
    await update(await setting(), undefined, { name: 'Другое' });
    expect((await info())!.logo!.light).toBe(now.light);
    await update(await setting(), 'keep', { name: 'Ещё' });
    expect((await info())!.logo!.light).toBe(now.light);
  });

  it('убрать: поля нет, адрес отвечает 404', async () => {
    await create({ light: base64(pngBytes()) });
    const was = (await info())!.logo!;
    await update(await setting(), null);
    expect((await info())!.logo).toBeUndefined();
    expect((await app.inject(was.light)).statusCode).toBe(404);
  });

  it('скрытый проект: 200', async () => {
    await create({ light: base64(pngBytes()) });
    const was = (await info())!.logo!;
    const p = await setting();
    await app.inject({ method: 'PUT', url: '/api/projects/acme/visibility', payload: { hidden: true, updatedAt: p.updatedAt } });
    expect((await app.inject(was.light)).statusCode).toBe(200);
  });

  it('SVG со скрытым скриптом обходит текстовую проверку, но открывается в песочнице', async () => {
    const tricky = svgBytes('<svg:script xmlns:svg="x">1</svg:script>');
    expect((await create({ light: base64(tricky) })).statusCode).toBe(201);
    const r = await app.inject((await info())!.logo!.light);
    expect(r.headers['content-type']).toBe('image/svg+xml');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(String(r.headers['content-security-policy'])).toContain('sandbox');
    expect(String(r.headers['content-security-policy'])).toContain("default-src 'none'");
  });

  it('тело больше 1 МБ', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/projects', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(body({ light: 'A'.repeat(1_100_000) })) });
    expect(r.statusCode).toBe(413);
  });
});
