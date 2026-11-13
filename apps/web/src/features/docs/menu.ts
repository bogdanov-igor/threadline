// Меню документации и обучения: порядок групп и страниц, группы в том же порядке, что разделы на главной (HOME_SECTIONS).
// Название страницы берётся из её файла, первая строка «# Название».
// Страница без места в списке встаёт в конец своей группы: группа определяется началом имени файла, поэтому новый файл виден в меню сразу.
export type Tree = 'docs' | 'learn';

export interface MenuGroup {
  /** Подпись группы: строка docs.groups.<id>, описание на главной документации: docs.home.sections.<id>. */
  id: 'guide' | 'file' | 'arch' | 'admin' | 'learn';
  pages: readonly string[];
  /** Страницы на карточке раздела на главной документации, по порядку. Несуществующие пропускаются. */
  featured: readonly string[];
}

export const MENU: Readonly<Record<Tree, readonly MenuGroup[]>> = {
  docs: [
    {
      id: 'guide',
      pages: ['guide-start', 'guide-search', 'guide-request', 'guide-operation', 'guide-share', 'guide-roles', 'guide-modes', 'guide-catalog', 'guide-status', 'guide-keys', 'guide-faq'],
      featured: ['guide-start', 'guide-search', 'guide-request', 'guide-share'],
    },
    {
      id: 'file',
      pages: ['file-start', 'file-how', 'file-settings', 'file-systems', 'file-methods', 'file-errors', 'file-outcomes', 'file-ids', 'file-masks', 'file-from-swagger', 'file-errors-reference', 'file-all-fields'],
      featured: ['file-start', 'file-methods', 'file-errors', 'file-outcomes'],
    },
    {
      id: 'admin',
      pages: ['admin-install', 'admin-local', 'admin-variables', 'admin-keycloak', 'admin-grafana', 'admin-backup'],
      featured: ['admin-install', 'admin-local', 'admin-variables', 'admin-grafana'],
    },
    { id: 'arch', pages: ['arch-overview', 'arch-request'], featured: ['arch-overview', 'arch-request'] },
  ],
  learn: [{ id: 'learn', pages: ['find-error', 'card', 'transfer', 'share', 'postman', 'describe-error', 'business', 'file-first'], featured: ['find-error', 'card', 'transfer', 'describe-error'] }],
};

/** Порядок разделов на главной документации: как пользоваться, обучение, файл проекта, установка, как устроено. */
export const HOME_SECTIONS: readonly { tree: Tree; group: MenuGroup['id'] }[] = [
  { tree: 'docs', group: 'guide' },
  { tree: 'learn', group: 'learn' },
  { tree: 'docs', group: 'file' },
  { tree: 'docs', group: 'admin' },
  { tree: 'docs', group: 'arch' },
];
