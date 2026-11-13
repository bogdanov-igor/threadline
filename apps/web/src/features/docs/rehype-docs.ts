// Разметка текста страницы перед показом. Текст остаётся обычным Markdown, вид выводится из его строения:
// первый абзац — вводный; нумерованный список сразу под снимком — подписи к цифрам на снимке; цитата — врезка;
// список, где каждый пункт начинается ссылкой на страницу, — карточки ссылок; код в строке с названием клавиши — клавиша.

export interface HNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HNode[];
  position?: { start: { line: number } };
}

export type CalloutKind = 'note' | 'tip' | 'warning' | 'danger';

const isElement = (n: HNode | undefined, tag?: string): n is HNode => n?.type === 'element' && (tag === undefined || n.tagName === tag);
/** Та же проверка без сужения типа: узел, который не прошёл одну проверку, ещё может пройти следующую. */
const tagIs = (n: HNode, tag: string): boolean => n.type === 'element' && n.tagName === tag;
const elementsOf = (n: HNode) => (n.children ?? []).filter((c) => c.type === 'element');
const blank = (n: HNode) => n.type === 'text' && (n.value ?? '').trim() === '';
const props = (n: HNode) => (n.properties ??= {});

export const textOf = (n: HNode): string => (n.type === 'text' ? (n.value ?? '') : (n.children ?? []).map(textOf).join(''));

/** Абзац из одной картинки: снимок или схема, а не текст. */
export function onlyImage(node: HNode | undefined): boolean {
  const parts = (node?.children ?? []).filter((c) => !blank(c));
  return parts.length === 1 && isElement(parts[0], 'img');
}

// Врезки. Явная отметка GitHub ([!NOTE]) или слово в начале («Важно:», «**Совет.**»). Без отметки — заметка,
// а запрет («Не вставляйте…») и прямое предупреждение о потере или раскрытии данных — предупреждение.
const ALERTS: Readonly<Record<string, CalloutKind>> = { note: 'note', tip: 'tip', important: 'warning', warning: 'warning', caution: 'danger' };
const LABELS: Readonly<Record<string, CalloutKind>> = {
  примечание: 'note',
  заметка: 'note',
  note: 'note',
  совет: 'tip',
  подсказка: 'tip',
  tip: 'tip',
  важно: 'warning',
  внимание: 'warning',
  important: 'warning',
  warning: 'warning',
  осторожно: 'danger',
  опасно: 'danger',
  caution: 'danger',
  danger: 'danger',
};
const LABEL_TEXT = /^\s*([\p{L}]+)\s*[:.]\s+/u;
const WARNING = /^(?:не |нельзя|никогда|do not |don't |never )|может спрятать|сотр[её]т|не скрывает|can hide|erases|does not hide/i;

function callout(quote: HNode): { kind: CalloutKind; title: string | null } {
  const first = elementsOf(quote)[0];
  if (!isElement(first, 'p')) return { kind: 'note', title: null };
  const kids = (first.children ??= []);
  const head = kids[0];
  if (head?.type === 'text') {
    const alert = /^\s*\[!([a-z]+)\]\s*/i.exec(head.value ?? '');
    const kind = alert ? ALERTS[alert[1]!.toLowerCase()] : undefined;
    if (alert && kind) {
      head.value = (head.value ?? '').slice(alert[0].length);
      return { kind, title: null };
    }
    const label = LABEL_TEXT.exec(head.value ?? '');
    const byLabel = label ? LABELS[label[1]!.toLowerCase()] : undefined;
    if (label && byLabel) {
      head.value = (head.value ?? '').slice(label[0].length);
      return { kind: byLabel, title: label[1]! };
    }
  }
  if (isElement(head, 'strong')) {
    const label = textOf(head).trim().replace(/[.:!]$/, '');
    const byLabel = LABELS[label.toLowerCase()];
    if (byLabel) {
      kids.shift();
      const next = kids[0];
      if (next?.type === 'text') next.value = (next.value ?? '').replace(/^\s*[:.—–-]?\s*/, '');
      return { kind: byLabel, title: label };
    }
  }
  return { kind: WARNING.test(textOf(quote).trim()) ? 'warning' : 'note', title: null };
}

// Клавиши. Названия клавиш и сочетания с Ctrl, ⌘, Alt, Shift — всегда; одна буква или знак — только там, где речь о клавишах:
// в абзаце со словом «клавиша» или в столбце таблицы с таким заголовком. Иначе `/` и `[` остаются кодом: это путь и скобка.
const NAMED = /^(?:Enter|Esc|Escape|Tab|Space|Backspace|Delete|Home|End|PageUp|PageDown|F\d{1,2}|[↑↓←→])$/;
const MODIFIER = /^(?:Ctrl|Control|Cmd|Command|⌘|Shift|Alt|Option|⌥)$/;
const SINGLE = /^[A-Z0-9?/[\]]$/;
const ABOUT_KEYS = /клавиш|\bkeys?\b|shortcut/i;

/** Части сочетания: «Ctrl+Enter» → Ctrl, Enter. Плюс без соседей — сама клавиша. */
export const keyParts = (text: string): string[] => (text.length > 1 && text.includes('+') ? text.split('+').map((k) => k.trim()) : [text]);

function isKey(text: string, aboutKeys: boolean): boolean {
  const parts = keyParts(text.trim());
  if (parts.some((p) => p === '')) return false;
  if (parts.length > 1) return parts.slice(0, -1).every((p) => MODIFIER.test(p)) && (NAMED.test(parts.at(-1)!) || SINGLE.test(parts.at(-1)!.toUpperCase()));
  return NAMED.test(parts[0]!) || (aboutKeys && SINGLE.test(parts[0]!));
}

function markKeys(node: HNode, aboutKeys: boolean): void {
  if (tagIs(node, 'pre')) return;
  if (tagIs(node, 'table')) {
    const headers = elementsOf(elementsOf(node).find((c) => c.tagName === 'thead') ?? { type: 'root' }).flatMap((row) => elementsOf(row).map((cell) => ABOUT_KEYS.test(textOf(cell))));
    for (const section of elementsOf(node))
      for (const row of elementsOf(section)) elementsOf(row).forEach((cell, i) => markKeys(cell, aboutKeys || !!headers[i]));
    return;
  }
  if (tagIs(node, 'code')) {
    if (isKey(textOf(node), aboutKeys)) props(node).dataKbd = '';
    return;
  }
  const here = tagIs(node, 'p') || tagIs(node, 'li') ? aboutKeys || ABOUT_KEYS.test(textOf(node)) : aboutKeys;
  for (const child of node.children ?? []) markKeys(child, here);
}

// Карточки ссылок: «Что читать дальше» и похожие списки. Пункт — ссылка на страницу и, через двоеточие, пояснение.
const LOCAL = /^\/(?:docs|learn)\//;

function linkOf(item: HNode): { link: HNode; rest: HNode[] } | null {
  const holder = elementsOf(item)[0]?.tagName === 'p' && elementsOf(item).length === 1 ? elementsOf(item)[0]! : item;
  const all = holder.children ?? [];
  const kids = all.slice(Math.max(0, all.findIndex((c) => !blank(c))));
  const link = kids[0];
  if (!isElement(link, 'a') || !LOCAL.test(String(link.properties?.href ?? ''))) return null;
  if (holder === item && elementsOf(item).some((c) => c !== link && ['ul', 'ol', 'p', 'pre'].includes(c.tagName!))) return null;
  return { link, rest: kids.slice(1) };
}

/** Подпись раздела не нужна, когда название с неё и начинается: «Обучение: взять номер карты» под подписью «Обучение». */
export const repeats = (title: string, section: string): boolean => {
  const norm = (text: string) => text.trim().toLowerCase().replace(/ё/g, 'е');
  return norm(title).startsWith(norm(section));
};

function linkCards(list: HNode, sectionOf: (href: string) => string | null): HNode | null {
  const items = elementsOf(list);
  if (items.length < 2) return null;
  const links = items.map(linkOf);
  if (links.some((l) => l === null)) return null;
  const found = links.map((l) => {
    const href = String(l!.link.properties!.href);
    const section = sectionOf(href);
    return { l: l!, href, label: section && !repeats(textOf(l!.link), section) ? section : null };
  });
  // Строка подписи у всех карточек списка, если подпись есть хоть у одной: названия в одном ряду на одной линии.
  const labelled = found.some((f) => f.label !== null);
  const cards = found.map(({ l, href, label }) => {
    const note = l.rest.map(textOf).join('').replace(/^\s*[:—–-]\s*/, '').trim();
    const children: HNode[] = [];
    if (labelled) children.push({ type: 'element', tagName: 'span', properties: { dataCardSection: '' }, children: label ? [{ type: 'text', value: label }] : [] });
    children.push({ type: 'element', tagName: 'span', properties: { dataCardTitle: '' }, children: l.link.children ?? [] });
    if (note) children.push({ type: 'element', tagName: 'span', properties: { dataCardNote: '' }, children: [{ type: 'text', value: note.charAt(0).toUpperCase() + note.slice(1) }] });
    return { type: 'element', tagName: 'a', properties: { href, dataCard: '' }, children };
  });
  return { type: 'element', tagName: 'div', properties: { dataCards: '' }, children: cards, position: list.position };
}

/**
 * Страницы, на которые ведут карточки ссылок текста, без раздела после #: «Дальше» под текстом не повторяет такую карточку.
 * Читается сам Markdown, по тому же правилу, что у карточек: список из двух пунктов и больше, каждый начинается ссылкой на страницу.
 */
export function cardTargets(markdown: string): Set<string> {
  const out = new Set<string>();
  let run: string[] = [];
  let other = false;
  const flush = () => {
    if (run.length >= 2 && !other) for (const href of run) out.add(href.split('#')[0]!);
    run = [];
    other = false;
  };
  let fence: string | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const mark = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (mark) {
      if (fence === null) {
        flush();
        fence = mark[0]!;
      } else if (mark[0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const item = /^[-*+]\s+(.*)$/.exec(line);
    if (item) {
      const link = /^\[[^\]]*\]\((\/(?:docs|learn)\/[^)\s]+)\)/.exec(item[1]!.trim());
      if (link) run.push(link[1]!);
      else other = true;
    } else if (line.trim() !== '' && !/^\s/.test(line)) flush();
  }
  flush();
  return out;
}

export interface DocsMarkupOptions {
  /** Подпись раздела, к которому ведёт ссылка: на карточке над названием. */
  sectionOf?: (href: string) => string | null;
}

/** Плагин rehype: только отметки data-* и карточки ссылок, текст страницы не меняется. */
export function rehypeDocs({ sectionOf = () => null }: DocsMarkupOptions = {}) {
  return (root: HNode) => {
    const top = elementsOf(root);
    if (isElement(top[0], 'p') && !onlyImage(top[0])) props(top[0]).dataLead = '';
    const walk = (parent: HNode) => {
      const kids = parent.children ?? [];
      let previous: HNode | undefined;
      kids.forEach((node, i) => {
        if (node.type !== 'element') return;
        if (node.tagName === 'ol' && isElement(previous, 'p') && onlyImage(previous)) {
          props(node).dataLegend = '';
          const img = elementsOf(previous).find((c) => c.tagName === 'img');
          if (img) props(img).dataLegend = '';
        }
        if (node.tagName === 'blockquote') {
          const { kind, title } = callout(node);
          props(node).dataCallout = kind;
          if (title) props(node).dataTitle = title;
        }
        if (node.tagName === 'ul') {
          const cards = linkCards(node, sectionOf);
          if (cards) {
            kids[i] = cards;
            previous = cards;
            return;
          }
        }
        walk(node);
        previous = node;
      });
    };
    walk(root);
    markKeys(root, false);
  };
}
