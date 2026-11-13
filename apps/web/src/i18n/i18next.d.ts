import 'i18next';
import type auth from '../features/auth/ru.json';
import type business from '../features/business/ru.json';
import type catalog from '../features/catalog/ru.json';
import type docs from '../features/docs/ru.json';
import type extras from '../features/extras/ru.json';
import type projectFile from '../features/project-file/ru.json';
import type projects from '../features/projects/ru.json';
import type report from '../features/report/ru.json';
import type help from '../features/help/ru.json';
import type keys from '../features/keys/ru.json';
import type local from '../features/local/ru.json';
import type operation from '../features/operation/ru.json';
import type service from '../features/service/ru.json';
import type settings from '../features/settings/ru.json';
import type share from '../features/share/ru.json';
import type shell from '../features/shell/ru.json';
import type tools from '../features/tools/ru.json';
import type ru from './ru.json';

// Ключи типизированы: несуществующий ключ — ошибка tsc при сборке.
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    // Строки страниц проектов и редактора справочника лежат в их ленивых чанках: основной чанк от них не растёт.
    // Разделы, которые есть и в главном файле, пересечены только на своём уровне: пересечение всего файла упиралось в предел tsc TS2589.
    resources: { translation: Omit<typeof ru, 'catalog' | 'operation'> & { auth: typeof auth; business: typeof business; projects: typeof projects; 'project-file': typeof projectFile; catalog: (typeof ru)['catalog'] & typeof catalog; docs: typeof docs; share: typeof share; settings: typeof settings; tools: typeof tools; shell: typeof shell; help: typeof help; keys: typeof keys; report: typeof report; operation: (typeof ru)['operation'] & typeof operation; service: typeof service; extras: typeof extras; local: typeof local } };
  }
}
