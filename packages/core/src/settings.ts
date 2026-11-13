// Настройки сервиса: одна запись на настройку. Новая настройка — новая строка таблицы, без миграции, маршрута и новой страницы.
// Только данные и чистые проверки: файл читают и сервер, и ленивая страница /settings.

import type { ProjectsSourceState } from './api.ts';

export interface IntSetting {
  kind: 'int';
  min: number;
  max: number;
  default: number;
}

/** Текст одной строкой. Пустого значения в базе не бывает: его заменяет отсутствие записи, поэтому default у текста всегда пустой. https — значение должно быть ссылкой https. */
export interface TextSetting {
  kind: 'text';
  maxLength: number;
  https?: boolean;
  default: string;
}

export type SettingDef = IntSetting | TextSetting;

export const SETTINGS = {
  'share.lifetimeDays': { kind: 'int', min: 1, max: 400, default: 30 },
  'support.contactText': { kind: 'text', maxLength: 200, default: '' },
  'support.contactUrl': { kind: 'text', maxLength: 500, https: true, default: '' },
} as const satisfies Record<string, SettingDef>;

export type SettingKey = keyof typeof SETTINGS;

export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];

export const isSettingKey = (key: string): key is SettingKey => Object.hasOwn(SETTINGS, key);

/** Ссылка, которую можно показать как есть: только https, без учётных данных, управляющих символов и пробелов. Начало проверяется отдельно: разбор принял бы и `https:x`. */
export function safeHttpsUrl(value: string): boolean {
  if (!/^https:\/\/[^\s\\]+$/i.test(value)) return false;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && u.hostname !== '' && u.username === '' && u.password === '';
  } catch {
    return false;
  }
}

const validText = (def: TextSetting, value: string): boolean => value !== '' && value === value.trim() && value.length <= def.maxLength && !/\p{Cc}/u.test(value) && (!def.https || safeHttpsUrl(value));

/** Значение проходит проверку настройки. */
export const validSetting = (def: SettingDef, value: unknown): value is number | string => (def.kind === 'int' ? typeof value === 'number' && Number.isInteger(value) && value >= def.min && value <= def.max : typeof value === 'string' && validText(def, value));

interface SettingState {
  key: SettingKey;
  /** Метка версии строки; null — настройку ещё не сохраняли. */
  updatedAt: string | null;
  /** Запись не прошла проверку: действует значение по умолчанию, сама запись не переписана. */
  invalidStored: boolean;
}

/** value — что действует сейчас. */
export type ServiceSetting = (IntSetting & SettingState & { value: number }) | (TextSetting & SettingState & { value: string });

/** GET /api/settings. */
export interface ServiceSettingsResponse {
  state: ProjectsSourceState;
  editable: boolean;
  settings: ServiceSetting[];
}

/** PUT /api/settings/:key. value: null — вернуть значение по умолчанию, запись удаляется. */
export interface SettingSaveBody {
  value: number | string | null;
  updatedAt: string | null;
}

/** GET /api/support-contact: только эти два поля, пользователю без роли тоже. null — не задано. */
export interface SupportContact {
  text: string | null;
  url: string | null;
}

export type SettingErrorCode = 'setting-not-found' | 'setting-invalid' | 'setting-conflict' | 'settings-unavailable';

export interface SettingErrorBody {
  error: { code: SettingErrorCode; fields?: Record<string, string>; current?: ServiceSetting };
}
