// Имена локального режима в одном месте: смена названия продукта правит только этот файл (и bin в package.json).

/** Имя команды: pnpm local, позже npx <имя>. Совпадает с ключом bin в apps/server/package.json. */
export const BIN_NAME = 'threadline';
/** Название в сообщениях командной строки. */
export const PRODUCT_NAME = 'Threadline';
/** Каталог данных по умолчанию в домашней папке. */
export const DATA_DIR_NAME = '.threadline';
/** Переменная окружения с другим каталогом данных; флаг --data важнее. */
export const DATA_DIR_ENV = 'THREADLINE_DATA';
/** Файл настроек в каталоге данных. */
export const CONFIG_FILE = 'threadline.yaml';
