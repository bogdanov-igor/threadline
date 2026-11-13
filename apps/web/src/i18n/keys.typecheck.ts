// Проверка при сборке: tsc падает, если ключа нет в каталоге.
// Если строка ниже вдруг перестанет быть ошибкой, tsc упадёт на неиспользованном @ts-expect-error.
import i18n from './index.ts';

// @ts-expect-error ключа нет в каталоге
export const missing = i18n.t('header.noSuchKey');
