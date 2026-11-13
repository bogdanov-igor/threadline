// Имена в «Кратко» без справочника: на месте имени всегда читаемый текст, адресов и значений нет.
// Чистые функции: сервер новых данных не присылает.
import i18n from '@/i18n/index.ts';
import { pathTemplate } from '@/lib/path-template.ts';
import { systemLabel } from '@/lib/systems.ts';

const METHOD = /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT) (\S+)$/;
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}(?::\d*)?$/;
const SPACE = /\s/;
const UPPER = /\p{Lu}/u;

const external = () => i18n.t('view.brief.external');
const exchange = () => i18n.t('view.brief.exchange');

/** IPv4, IPv6 в скобках и без них, с портом или без. */
function isAddress(text: string): boolean {
  const host = text.replace(SCHEME, '').replace(/^[^/?#@]*@/, '').split(/[/?#]/)[0]!;
  return IPV4.test(host) || host.startsWith('[') || (host.match(/:/g)?.length ?? 0) >= 2;
}

/**
 * Имя системы: IP и пустой адрес — «Внешняя система», хост — короткое имя, имя справочника — как есть.
 * Имя справочника отличается от хоста заглавными буквами или пробелами; строчное с точкой сократилось бы, это редкость и ничего не открывает.
 */
export function briefSystem(name: string | null | undefined): string {
  const s = name?.trim();
  if (!s) return external();
  // Адреса у Бизнеса нет: без системы в справочнике и без имени хоста от обмена остался только шаблон пути.
  if (s.startsWith('/')) return external();
  if (isAddress(s)) return external();
  if (SPACE.test(s)) return s;
  const hostLike = SCHEME.test(s) || (!UPPER.test(s) && (s.includes('.') || /:\d+$/.test(s)));
  return hostLike ? systemLabel(s) : s;
}

/** Шаблон пути без хоста, значений, строки запроса и метода; null — это не адрес. */
function pathOf(text: string): string | null {
  const s = text.trim();
  const m = METHOD.exec(s);
  const target = m ? m[1]! : s;
  if (target.startsWith('/')) return pathTemplate(target).template;
  const scheme = SCHEME.test(target);
  if (!m && !scheme) return null;
  const rest = target.replace(SCHEME, '');
  const at = rest.search(/[/?#]/);
  return at < 0 || rest[at] !== '/' ? '/' : pathTemplate(rest.slice(at)).template;
}

export interface BriefMethodInput {
  /** Название из справочника. */
  name?: string | null | undefined;
  /** Действие записи или подпись профиля. */
  plain?: string | null | undefined;
  /** Адрес, путь или «МЕТОД адрес». */
  uri?: string | null | undefined;
}

/** Строка метода: название, действие, шаблон пути, слово «Обмен» вместо пути «/». Адреса нет — пусто, имя системы остаётся. */
export function briefMethod({ name, plain, uri }: BriefMethodInput): string {
  if (name) return name;
  if (plain) return plain;
  if (!uri) return '';
  const path = pathOf(uri);
  return path === null || path === '/' ? exchange() : path;
}

/**
 * Название, склеенное строкой «система · метод»: части читаются по виду. Пустое — «Обмен».
 * fromExchange — название взято с обмена, а не с входа: один только путь читается «Внешняя система · /путь».
 */
export function briefTitle(title: string | null | undefined, fromExchange = false): string {
  const parts = (title ?? '').split(' · ').map((p) => p.trim()).filter(Boolean);
  // Названия нет: у Бизнеса так выглядит обмен с системой по IP.
  if (parts.length === 0) return fromExchange ? external() : exchange();
  if (fromExchange && parts.length === 1 && parts[0]!.startsWith('/')) return `${external()} · ${pathOf(parts[0]!)}`;
  return parts
    .map((part) => {
      const path = pathOf(part);
      if (path !== null) return path === '/' ? exchange() : path;
      return briefSystem(part);
    })
    .join(' · ');
}

/** Цепочка именами: одинаковые соседи показываются один раз. */
export function collapseNeighbours(names: readonly string[]): string[] {
  return names.filter((n, i) => i === 0 || names[i - 1] !== n);
}
