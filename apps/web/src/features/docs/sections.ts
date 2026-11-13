// Разделы документации: значок группы, раздел страницы по адресу, подпись раздела для пути над заголовком и карточек ссылок.
import { Compass, FileCode2, GraduationCap, Network, ServerCog, type LucideIcon } from 'lucide-react';
import { MENU, type MenuGroup, type Tree } from './menu.ts';

export const GROUP_ICONS: Readonly<Record<MenuGroup['id'], LucideIcon>> = {
  guide: Compass,
  learn: GraduationCap,
  file: FileCode2,
  admin: ServerCog,
  arch: Network,
};

/** Группа страницы: названная в menu.ts, иначе по началу имени файла; у обучения группа одна. */
export function groupOf(tree: Tree, id: string): MenuGroup['id'] | null {
  const groups = MENU[tree];
  const listed = groups.find((g) => g.pages.includes(id));
  if (listed) return listed.id;
  if (tree === 'learn') return groups[0]?.id ?? null;
  return groups.find((g) => id.startsWith(`${g.id}-`))?.id ?? null;
}

const LOCAL = /^\/(docs|learn)\/([^/?#]+)/;

/** Раздел и страница по адресу внутри документации: /docs/file-start#x → docs, file-start. */
export function placeOf(href: string): { tree: Tree; id: string } | null {
  const m = LOCAL.exec(href);
  return m ? { tree: m[1] as Tree, id: m[2]! } : null;
}

/** Подпись раздела над страницей: у обучения название самого раздела, у документации название группы. */
export const sectionKey = (tree: Tree, group: MenuGroup['id'] | null) => (tree === 'learn' || !group ? (`docs.${tree}Title` as const) : (`docs.groups.${group}` as const));

/** Последняя открытая страница каждого раздела: переключатель «Документация · Обучение» возвращает на неё. Вкладка помнит её до закрытия. */
const LAST = new Map<Tree, string>();
const lastKey = (tree: Tree) => `threadline.docs.last.${tree}`;

export function rememberPage(tree: Tree, id: string): void {
  LAST.set(tree, id);
  try {
    window.sessionStorage.setItem(lastKey(tree), id);
  } catch {
    // Хранилище запрещено: страница помнится, пока открыта вкладка.
  }
}

export function lastPage(tree: Tree): string | null {
  const known = LAST.get(tree);
  if (known) return known;
  try {
    return window.sessionStorage.getItem(lastKey(tree));
  } catch {
    return null;
  }
}
