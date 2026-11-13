// Языки интерфейса: одно место на всё приложение.
export const LANGUAGES = [
  { code: 'ru', tag: 'ru', short: 'RU', name: 'Русский', script: 'cyrillic', quotes: ['«', '»'] },
  { code: 'en', tag: 'en', short: 'EN', name: 'English', script: 'latin', quotes: ['“', '”'] },
] as const;

export type Language = (typeof LANGUAGES)[number];
export type LanguageCode = Language['code'];

/** Язык по умолчанию и запасной: его основной файл лежит в главном чанке. */
export const DEFAULT_LANGUAGE = LANGUAGES[0].code;

export const isLanguage = (code: string | null): code is LanguageCode => LANGUAGES.some((l) => l.code === code);

/** Строка таблицы по коду i18next; неизвестный код даёт русский. */
export const languageOf = (code: string): Language => LANGUAGES.find((l) => l.code === code) ?? LANGUAGES[0];
