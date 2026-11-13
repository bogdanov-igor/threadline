// Настройки сервиса. Сервер настоящий, база PGlite.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SETTING_KEYS, SETTINGS, type ServiceSetting, type ServiceSettingsResponse, type SupportContact } from '@threadline/core/settings';
import { as, shareRig, type ShareRig } from '../share/harness.ts';

const KEY = 'share.lifetimeDays';
const URL_KEY = `/api/settings/${KEY}`;

let r: ShareRig;

beforeAll(async () => {
  r = await shareRig();
}, 60_000);

afterAll(async () => {
  await r.close();
});

const list = async () => {
  const res = await r.app.inject({ url: '/api/settings', headers: as('admin') });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as ServiceSettingsResponse;
};
const current = async () => (await list()).settings.find((s) => s.key === KEY)!;
const save = (payload: object) => r.app.inject({ method: 'PUT', url: URL_KEY, headers: as('admin'), payload });

describe('Настройки сервиса в базе', () => {
  it('записи нет: действует значение по умолчанию, настройки три', async () => {
    const res = await list();
    expect(res.editable).toBe(true);
    expect(res.settings.map((s) => s.key)).toEqual(SETTING_KEYS);
    expect(res.settings[0]).toMatchObject({ key: KEY, value: 30, min: 1, max: 400, default: 30, updatedAt: null, invalidStored: false });
  });

  it('сохранение действует на следующий запрос, вторая копия читает то же из базы', async () => {
    const saved = await save({ value: 7, updatedAt: null });
    expect(saved.statusCode, saved.body).toBe(200);
    expect((await current()).value).toBe(7);
    // Другая копия сервера правит базу напрямую: кэша нет.
    await r.catalog.db().query(`update service_setting set value = '9'::jsonb where key = $1`, [KEY]);
    expect((await current()).value).toBe(9);
  });

  it('вернуть стандартное: запись удалена', async () => {
    const { updatedAt } = await current();
    const res = await save({ value: null, updatedAt });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as ServiceSetting).value).toBe(SETTINGS[KEY].default);
    expect(await r.catalog.db().query('select key from service_setting')).toEqual([]);
  });

  it('запись не разбирается: значение по умолчанию, отметка, запись не переписана', async () => {
    const db = r.catalog.db();
    await db.query(`insert into service_setting (key, value) values ($1, '"много"'::jsonb)`, [KEY]);
    const s = await current();
    expect(s).toMatchObject({ value: 30, invalidStored: true });
    expect(await db.query('select value from service_setting where key = $1', [KEY])).toEqual([{ value: 'много' }]);
    await db.query('delete from service_setting where key = $1', [KEY]);
  });

  it('запись неизвестной настройки не показывается и не удаляется', async () => {
    const db = r.catalog.db();
    await db.query(`insert into service_setting (key, value) values ('old.setting', '1'::jsonb)`);
    expect((await list()).settings.map((s) => s.key)).toEqual(SETTING_KEYS);
    expect(await db.query(`select key from service_setting where key = 'old.setting'`)).toHaveLength(1);
    await db.query(`delete from service_setting where key = 'old.setting'`);
  });
});

describe('Одновременная правка настроек', () => {
  it('второй с прежней меткой получает конфликт и свежую запись', async () => {
    const first = await save({ value: 10, updatedAt: null });
    expect(first.statusCode, first.body).toBe(200);
    const late = await save({ value: 20, updatedAt: null });
    expect(late.statusCode).toBe(409);
    expect(late.json()).toMatchObject({ error: { code: 'setting-conflict', current: { value: 10 } } });
    expect((await current()).value).toBe(10);
    const { updatedAt } = await current();
    expect((await save({ value: null, updatedAt })).statusCode).toBe(200);
  });
});

describe('Место для новых настроек и неверные значения', () => {
  it('неизвестный ключ — 404, ничего не сохранено', async () => {
    const res = await r.app.inject({ method: 'PUT', url: '/api/settings/no.such', headers: as('admin'), payload: { value: 1, updatedAt: null } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'setting-not-found' } });
  });

  it('лишнее поле — отказ с именем поля', async () => {
    const res = await save({ value: 5, updatedAt: null, extra: 1 });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: { code: 'setting-invalid', fields: { extra: expect.stringContaining('extra') } } });
  });

  it.each([[0], [401], [1.5], ['7'], [true]])('значение %s отклонено с путём к полю', async (value) => {
    const res = await save({ value, updatedAt: null });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: { code: 'setting-invalid', fields: { value: expect.any(String) } } });
    expect((await current()).updatedAt).toBeNull();
  });
});

describe('Доступ', () => {
  it.each(['business', 'support', 'developer', 'analyst'])('%s получает 403 на чтение и правку', async (role) => {
    expect((await r.app.inject({ url: '/api/settings', headers: as(role) })).statusCode).toBe(403);
    expect((await r.app.inject({ method: 'PUT', url: URL_KEY, headers: as(role), payload: { value: 5, updatedAt: null } })).statusCode).toBe(403);
    expect((await current()).updatedAt).toBeNull();
  });

  it('без входа 401, без роли 403 no-role, к хранилищу запросов нет', async () => {
    const before = r.reads();
    expect((await r.app.inject({ url: '/api/settings' })).statusCode).toBe(401);
    const none = await r.app.inject({ method: 'PUT', url: URL_KEY, headers: as('none'), payload: { value: 5, updatedAt: null } });
    expect([none.statusCode, none.json()]).toEqual([403, { error: { code: 'no-role' } }]);
    await list();
    expect(r.reads()).toBe(before);
  });
});

describe('Контакт поддержки', () => {
  const TEXT = '/api/settings/support.contactText';
  const LINK = '/api/settings/support.contactUrl';
  const put = (url: string, value: unknown, updatedAt: string | null = null) => r.app.inject({ method: 'PUT', url, headers: as('admin'), payload: { value, updatedAt } });
  const read = async (role: string) => r.app.inject({ url: '/api/support-contact', headers: as(role) });

  it('значений нет: контакт пуст, отвечает и пользователю без роли', async () => {
    const res = await read('none');
    expect([res.statusCode, res.json()]).toEqual([200, { text: null, url: null }]);
  });

  it('без входа 401, ответ только из двух полей, хранилище не читается', async () => {
    const before = r.reads();
    expect((await r.app.inject({ url: '/api/support-contact' })).statusCode).toBe(401);
    const saved = (await put(TEXT, 'Дежурная смена, 1234')).json() as ServiceSetting;
    const link = (await put(LINK, 'https://support.corp.example/ask?x=1')).json() as ServiceSetting;
    for (const role of ['none', 'business', 'admin']) expect((await read(role)).json() as SupportContact).toEqual({ text: 'Дежурная смена, 1234', url: 'https://support.corp.example/ask?x=1' });
    expect(r.reads()).toBe(before);
    expect((await put(TEXT, null, saved.updatedAt)).statusCode).toBe(200);
    expect((await put(LINK, null, link.updatedAt)).statusCode).toBe(200);
    expect((await read('none')).json()).toEqual({ text: null, url: null });
  });

  it.each([['x'.repeat(201)], ['строка\nвторая'], [''], ['  поля  '], [5]])('текст %j отклонён', async (value) => {
    const res = await put(TEXT, value);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: { code: 'setting-invalid', fields: { value: expect.any(String) } } });
  });

  it('текст ровно 200 символов принимается', async () => {
    const res = await put(TEXT, 'x'.repeat(200));
    expect(res.statusCode, res.body).toBe(200);
    expect((await put(TEXT, null, (res.json() as ServiceSetting).updatedAt)).statusCode).toBe(200);
  });

  it.each([['http://support.corp.example'], ['javascript:alert(1)'], ['https://user:pass@support.corp.example'], ['//support.corp.example'], ['https:support.corp.example'], ['https://a b'], ['data:text/html,x'], [`https://${'x'.repeat(500)}`]])('ссылка %s отклонена', async (value) => {
    expect((await put(LINK, value)).statusCode).toBe(422);
  });

  it('запись в базе не проходит проверку: контакта нет, страница называет это, запись на месте', async () => {
    const db = r.catalog.db();
    await db.query(`insert into service_setting (key, value) values ('support.contactUrl', '"javascript:alert(1)"'::jsonb)`);
    expect((await read('none')).json()).toEqual({ text: null, url: null });
    expect((await list()).settings.find((s) => s.key === 'support.contactUrl')).toMatchObject({ value: '', invalidStored: true });
    expect(await db.query(`select value from service_setting where key = 'support.contactUrl'`)).toEqual([{ value: 'javascript:alert(1)' }]);
    await db.query(`delete from service_setting where key = 'support.contactUrl'`);
  });

  it('базы нет: контакт пуст, ошибки нет', async () => {
    const off = await shareRig({ databaseUrl: '' });
    try {
      const res = await off.app.inject({ url: '/api/support-contact', headers: as('none') });
      expect([res.statusCode, res.json()]).toEqual([200, { text: null, url: null }]);
    } finally {
      await off.close();
    }
  });
});

describe('Настройки без базы', () => {
  it('базы нет: значения по умолчанию только для чтения, правка отклонена', async () => {
    const off = await shareRig({ databaseUrl: '' });
    try {
      const res = (await off.app.inject({ url: '/api/settings', headers: as('admin') })).json() as ServiceSettingsResponse;
      expect(res).toMatchObject({ state: 'off', editable: false });
      expect(res.settings[0]!.value).toBe(30);
      const saved = await off.app.inject({ method: 'PUT', url: URL_KEY, headers: as('admin'), payload: { value: 5, updatedAt: null } });
      expect([saved.statusCode, saved.json()]).toEqual([503, { error: { code: 'settings-unavailable' } }]);
    } finally {
      await off.close();
    }
  });
});
