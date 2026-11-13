// Настройки сервиса в базе: чтение при использовании, без кэша, правка с меткой версии.
// Значение читается из базы на каждый запрос: настройки меняются редко, запросы редкие, кэш потребовал бы сверки между копиями.

import type { ProjectsSourceState } from '@threadline/core';
import { isSettingKey, SETTING_KEYS, SETTINGS, validSetting, type ServiceSetting, type ServiceSettingsResponse, type SettingKey, type SupportContact } from '@threadline/core/settings';
import { limitLockWait, type Db, type Queryable } from '../catalog/db.ts';
import { EDIT_LOCK_NS } from '../catalog/store.ts';

/** Что сервису нужно от справочника: одна база на всех. */
export interface SettingsCatalog {
  state(): { state: ProjectsSourceState };
  readDb(): Db | null;
  transaction<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
}

interface StoredSetting {
  raw: unknown;
  updatedAt: string;
}

/** updated_at с микросекундами в UTC: та же метка версии, что у записей проектов и справочника. */
const STAMP = `to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at`;

async function readStored(q: Queryable, key?: SettingKey): Promise<Map<string, StoredSetting>> {
  const rows = await q.query<{ key: string; value: unknown; updated_at: string }>(`select key, value, ${STAMP} from service_setting${key ? ' where key = $1' : ''}`, key ? [key] : []);
  return new Map(rows.map((r) => [r.key, { raw: r.value, updatedAt: String(r.updated_at) }]));
}

function settingOf(key: SettingKey, stored: StoredSetting | undefined): ServiceSetting {
  const def = SETTINGS[key];
  const valid = stored !== undefined && validSetting(def, stored.raw);
  return { key, ...def, value: valid ? stored.raw : def.default, updatedAt: stored?.updatedAt ?? null, invalidStored: stored !== undefined && !valid } as ServiceSetting;
}

export class SettingConflict extends Error {
  readonly current: ServiceSetting;
  constructor(current: ServiceSetting) {
    super('настройку изменили');
    this.name = 'SettingConflict';
    this.current = current;
  }
}

export class SettingsService {
  readonly #catalog: SettingsCatalog;
  /** Последние прочитанные значения: при потере базы страница показывает их, а не значения по умолчанию. */
  #last = new Map<string, StoredSetting>();

  constructor(catalog: SettingsCatalog) {
    this.#catalog = catalog;
  }

  /** Срок жизни ссылки по запросу той же базы. Ошибку базы получает вызывающий: без базы нет и ссылок. */
  async lifetimeDays(q: Queryable): Promise<number> {
    return settingOf('share.lifetimeDays', (await readStored(q, 'share.lifetimeDays')).get('share.lifetimeDays')).value as number;
  }

  /** Контакт поддержки из базы, при сбое последние прочитанные значения, без базы пусто. Только два поля: ответ читает и пользователь без роли. */
  async supportContact(): Promise<SupportContact> {
    const db = this.#catalog.readDb();
    if (db) {
      try {
        this.#last = await readStored(db);
      } catch {
        // Контакт не стоит ошибки экрана: остаются последние значения.
      }
    }
    const value = (key: 'support.contactText' | 'support.contactUrl') => String(settingOf(key, this.#last.get(key)).value) || null;
    return { text: value('support.contactText'), url: value('support.contactUrl') };
  }

  /** Список настроек. Записи, которые эта версия не знает, не показываются и не удаляются. */
  async list(): Promise<ServiceSettingsResponse> {
    const { state } = this.#catalog.state();
    const db = this.#catalog.readDb();
    let editable = state === 'ok';
    if (db) {
      try {
        this.#last = await readStored(db);
      } catch {
        editable = false;
      }
    } else editable = false;
    return { state, editable, settings: SETTING_KEYS.map((key) => settingOf(key, this.#last.get(key))) };
  }

  /** Запись по метке версии: другая метка даёт SettingConflict. null — вернуть значение по умолчанию, запись удаляется. */
  async save(key: string, value: number | string | null, expected: string | null): Promise<ServiceSetting> {
    if (!isSettingKey(key)) throw new Error('неизвестная настройка');
    return this.#catalog.transaction(async (q) => {
      await limitLockWait(q);
      await q.query('select pg_advisory_xact_lock($1, 0)', [EDIT_LOCK_NS + 2]);
      const cur = (await readStored(q, key)).get(key);
      if ((cur?.updatedAt ?? null) !== expected) throw new SettingConflict(settingOf(key, cur));
      if (value === null) await q.query('delete from service_setting where key = $1', [key]);
      else await q.query('insert into service_setting (key, value) values ($1, $2::jsonb) on conflict (key) do update set value = excluded.value, updated_at = clock_timestamp()', [key, JSON.stringify(value)]);
      const next = (await readStored(q, key)).get(key);
      return settingOf(key, next);
    });
  }
}
