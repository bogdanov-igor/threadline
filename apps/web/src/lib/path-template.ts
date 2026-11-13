// Читаемые пути: идентификаторы в пути заменяются именованными параметрами.

import { pathTemplate, type PathTemplate } from '@threadline/core/catalog';

// Шаблон пути и признак сегмента-идентификатора — из core: те же правила у справочника и интерфейса.
export { isIdSegment, pathTemplate, type PathParam, type PathTemplate } from '@threadline/core/catalog';

export interface TitleTemplate extends PathTemplate {
  /** Метод HTTP, если заголовок вида «GET /path». */
  method: string | null;
  /** Хост, если в заголовке полный адрес; без схемы и стандартного порта. */
  host: string | null;
}

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Хост из адреса: без схемы, учётных данных, пути и стандартного порта. IP остаётся как есть. */
export function compactHost(uri: string): string {
  const scheme = SCHEME.exec(uri)?.[0].toLowerCase() ?? '';
  const rest = uri.slice(scheme.length).replace(/^[^/?#@]*@/, '');
  const authority = /^[^/?#]*/.exec(rest)?.[0] ?? '';
  const port = /:(\d+)$/.exec(authority)?.[1];
  const standard = port === '443' ? !scheme || scheme === 'https://' : port === '80' ? !scheme || scheme === 'http://' : false;
  return standard ? authority.slice(0, -port!.length - 1) : authority;
}

/**
 * Заголовок шага или запроса — в шаблон: «GET /v1/users/<uuid>» и «POST https://host:443/path».
 * Заголовок не по форме «МЕТОД путь» остаётся как есть, без параметров.
 */
export function titleTemplate(title: string): TitleTemplate {
  const m = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT) (\S+)$/.exec(title.trim());
  const target = m ? m[2]! : title.trim();
  const method = m ? m[1]! : null;
  if (target.startsWith('/')) return { method, host: null, ...pathTemplate(target) };
  // Полный адрес, со схемой или без: «https://host:443/path», «host:8443/path».
  if (method) {
    const host = compactHost(target);
    const path = target.slice(target.indexOf(host) + host.length).replace(/^:\d+/, '');
    return { method, host, ...pathTemplate(path || '/') };
  }
  return { method: null, host: null, template: title, params: [], query: null };
}

/** Заголовок с шаблоном вместо пути: «GET /v1/users/{user}». */
export function templateTitle(title: string): string {
  const t = titleTemplate(title);
  if (!t.method) return t.template;
  return `${t.method} ${t.host ?? ''}${t.template}`;
}

/** Короткая форма длинного значения: «01a0…f9484». Короткие — целиком. */
export function shortValue(value: string): string {
  return value.length > 12 ? `${value.slice(0, 4)}…${value.slice(-5)}` : value;
}

/** Читаемый текст шага: части «МЕТОД путь» и «/путь» — шаблоном, без строки запроса; прочие части как есть. */
export function readableTitle(text: string): string {
  return text
    .split(' · ')
    .map((part) => (part.startsWith('/') ? pathTemplate(part).template : templateTitle(part)))
    .join(' · ');
}
