// Общие настройки YAML файла проекта: браузер и сервер разбирают и пишут одинаково.
// Без импортов: модуль идёт и в ленивый чанк редактора, а схема zod туда не должна попасть.

/** Разбор: повтор ключа и лишние ссылки дают ошибку, предупреждения с цитатой строки не идут в журнал. */
export const YAML_PARSE_OPTIONS = { strict: true, uniqueKeys: true, maxAliasCount: 100, logLevel: 'error' } as const;

/** Запись: длинные строки не переносятся, иначе выгрузка менялась бы от ширины. */
export const YAML_STRINGIFY_OPTIONS = { lineWidth: 0 } as const;

/** Первая строка YAML-файла: подсказки редактора кода по схеме. */
export const SCHEMA_COMMENT = '# yaml-language-server: $schema=./catalog.schema.json';
