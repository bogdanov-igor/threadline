// Хост адреса обмена и шаблоны хостов систем.
import { uriWithoutUserinfo } from '../search/masking.ts';

export interface UriParts {
  scheme: string | null;
  /** Без «[]» у IPv6, в нижнем регистре; null — адрес без хоста. */
  host: string | null;
  port: string | null;
  /** Путь без строки запроса; «/» для адреса без пути. */
  path: string;
  query: string | null;
  /** В authority не порт, а обрезок учётных данных: host:пароль/… Хоста нет, в «Неизвестное» такая строка не идёт. */
  invalid?: boolean;
}

const SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//;

/** Части адреса: схема, хост, порт, путь, строка запроса. Относительный путь — без хоста. */
export function uriParts(source: string | null): UriParts {
  if (!source) return { scheme: null, host: null, port: null, path: '/', query: null };
  // Пароль с «/», «?» или «#» иначе стал бы частью пути: то же правило, что у маски.
  const uri = uriWithoutUserinfo(source);
  const sm = SCHEME.exec(uri);
  const scheme = sm ? sm[1]!.toLowerCase() : null;
  // «//host/path» — адрес без схемы.
  const noScheme = sm ? uri.slice(sm[0].length) : uri.startsWith('//') ? uri.slice(2) : uri;
  let rest = noScheme;
  let host: string | null = null;
  let port: string | null = null;
  let invalid = false;
  if (!rest.startsWith('/')) {
    const full = /^[^/?#]*/.exec(rest)?.[0] ?? '';
    rest = rest.slice(full.length);
    const authority = withoutUserinfo(full);
    if (authority.startsWith('[')) {
      const end = authority.indexOf(']');
      host = authority.slice(1, end < 0 ? undefined : end);
      const p = end < 0 ? null : /^:(\d+)$/.exec(authority.slice(end + 1));
      port = p ? p[1]! : null;
    } else {
      const p = /^(.*?)(?::(\d*))?$/.exec(authority)!;
      host = p[1]!;
      port = p[2] ? p[2] : null;
      if (host.includes(':')) {
        invalid = true;
        host = null;
        port = null;
      }
    }
    host = host === '' || host === null ? null : host.toLowerCase();
  }
  const hash = rest.indexOf('#');
  const noHash = hash >= 0 ? rest.slice(0, hash) : rest;
  const q = noHash.indexOf('?');
  const path = (q >= 0 ? noHash.slice(0, q) : noHash) || '/';
  const query = q >= 0 ? noHash.slice(q + 1) || null : null;
  return { scheme, host, port, path, query, ...(invalid ? { invalid } : {}) };
}

/** Authority без учётных данных: в пароле бывает «@», поэтому они кончаются на последнем «@». */
function withoutUserinfo(authority: string): string {
  return authority.slice(authority.lastIndexOf('@') + 1);
}

/** Хост для подписи без схемы, учётных данных и порта, регистр как в записи; null, если хоста нет (относительный путь). */
export function hostOf(uri: string | null): string | null {
  if (!uri) return null;
  const rest = uriWithoutUserinfo(uri).replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
  if (rest.startsWith('/')) return null;
  const authority = withoutUserinfo(/^[^/?#]*/.exec(rest)?.[0] ?? '');
  const host = authority.startsWith('[') ? authority.replace(/^(\[[^\]]*\]).*$/, '$1') : authority.replace(/:\d*$/, '');
  // Не порт, а обрезок учётных данных: host:пароль/… Подписывать шаг этим нельзя.
  if (!host.startsWith('[') && host.includes(':')) return null;
  return host === '' ? null : host;
}

/** Имена систем по хосту из настройки проекта или справочника; пока не подключены — пусто. */
export type SystemNames = Readonly<Record<string, string>>;

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
// Общие поддомены ничего не говорят о системе: gw.merchant.acquirer.example — это acquirer.
const GENERIC = new Set(['www', 'api', 'gw', 'gateway', 'merchant', 'app', 'ws', 'secure', 'services', 'm']);

/** Хост без схемы, учётных данных, пути и порта: «processor.pay.example». */
export function bareHost(hostOrUri: string): string {
  const rest = hostOrUri
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/^[^/?#@]*@/, '');
  const authority = /^[^/?#]*/.exec(rest)?.[0] ?? '';
  if (authority.startsWith('[')) return authority.replace(/^(\[[^\]]*\]).*$/, '$1');
  return authority.replace(/:\d*$/, '').toLowerCase();
}

/**
 * Короткое имя системы: из справочника, если хост там есть; иначе хост без порта и домена организации —
 * «processor», «switch», «acquirer». IP и одиночные имена остаются как есть.
 */
export function systemLabel(hostOrUri: string, names: SystemNames = {}): string {
  const host = bareHost(hostOrUri);
  if (!host) return hostOrUri;
  const named = names[host];
  if (named) return named;
  if (IPV4.test(host) || host.startsWith('[')) return host;
  const labels = host.split('.');
  if (labels.length < 3) return host;
  const sub = labels.slice(0, -2).filter((l) => l !== 'www');
  if (sub.length > 0 && !sub.every((l) => GENERIC.has(l))) return sub.join('.');
  return labels.at(-2)!;
}

const PLAIN_SYSTEM = /^[a-z][a-z0-9_-]{0,63}$/;

/**
 * Имя системы без адреса, для тех, кому адрес не показывается: первая метка короткого имени. IP, IPv6 и всё,
 * что не похоже на имя, дают null: подпись выбирает интерфейс.
 */
export function plainSystem(uri: string | null): string | null {
  const host = hostOf(uri);
  if (!host) return null;
  const label = systemLabel(host).split('.')[0] ?? '';
  return PLAIN_SYSTEM.test(label) ? label : null;
}

const DEFAULT_PORT: Record<string, string> = { http: '80', https: '443' };

/** «host:port» для подписи; IPv6 в скобках. */
export function hostLabel(p: Pick<UriParts, 'host' | 'port'>): string | null {
  if (!p.host) return null;
  const h = p.host.includes(':') ? `[${p.host}]` : p.host;
  return p.port ? `${h}:${p.port}` : h;
}

export type HostPattern = { kind: 'exact'; host: string; port: string | null } | { kind: 'suffix'; suffix: string };

const NAME = /^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)*$/;
const IPV6 = /^[0-9a-f:.]+$/;
const PORT = /^\d{1,5}$/;

/** Шаблон хоста: host, host:port, [ipv6], [ipv6]:port, *.domain. Регистр не важен. null — неверный шаблон. */
export function parseHostPattern(source: string): HostPattern | null {
  const s = source.trim().toLowerCase();
  if (s.startsWith('*.')) {
    const domain = s.slice(2);
    return NAME.test(domain) && domain.includes('.') ? { kind: 'suffix', suffix: `.${domain}` } : null;
  }
  let host: string;
  let port: string | null = null;
  if (s.startsWith('[')) {
    const m = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(s);
    if (!m || !IPV6.test(m[1]!)) return null;
    host = m[1]!;
    port = m[2] ?? null;
  } else {
    const m = /^([^:]+)(?::([^:]*))?$/.exec(s);
    if (!m) return null;
    host = m[1]!;
    if (m[2] !== undefined) {
      if (!PORT.test(m[2])) return null;
      port = m[2];
    }
    if (!NAME.test(host)) return null;
  }
  if (port !== null && (Number(port) < 1 || Number(port) > 65535)) return null;
  return { kind: 'exact', host, port };
}

/** Шаблон в каноническом виде: нижний регистр, без пробелов. Ключ уникальности шаблона. */
export function normalizeHostPattern(source: string): string {
  return source.trim().toLowerCase();
}

/** Индекс шаблонов хостов: host:port → host → *.domain по длине суффикса. */
export class HostIndex<T> {
  readonly #withPort = new Map<string, T>();
  readonly #host = new Map<string, T>();
  #suffixes: { suffix: string; value: T }[] = [];

  add(pattern: string, value: T): void {
    const p = parseHostPattern(pattern);
    if (!p) return;
    if (p.kind === 'suffix') {
      this.#suffixes.push({ suffix: p.suffix, value });
      this.#suffixes.sort((a, b) => b.suffix.length - a.suffix.length);
    } else if (p.port !== null) this.#withPort.set(`${p.host}:${p.port}`, value);
    else this.#host.set(p.host, value);
  }

  find(parts: Pick<UriParts, 'scheme' | 'host' | 'port'>): T | undefined {
    if (!parts.host) return undefined;
    const port = parts.port ?? (parts.scheme ? DEFAULT_PORT[parts.scheme] : undefined);
    if (port !== undefined) {
      const v = this.#withPort.get(`${parts.host}:${port}`);
      if (v !== undefined) return v;
    }
    const v = this.#host.get(parts.host);
    if (v !== undefined) return v;
    for (const s of this.#suffixes) if (parts.host.endsWith(s.suffix)) return s.value;
    return undefined;
  }
}
