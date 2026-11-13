// «Скопировать как cURL»: команда из того, что на экране.

import type { ViewRecord } from '@threadline/core/search';

export interface CurlSource {
  method: string | null;
  uri: string;
  headers: unknown;
  body: string | null;
}

export interface CurlCommand {
  command: string;
  /** В команде есть значение под маской: у всех масок таблицы видов есть `***`. */
  masked: boolean;
  /** В записи только путь, а заголовка Host нет. */
  noHost: boolean;
}

// RFC 9110: имя заголовка. Значение вида `@файл` у -H читает файл, поэтому другие имена в команду не идут.
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const HOST = /^[\w.\-:[\]]+$/;
const TOKEN = /^[A-Za-z]+$/;

/** Что идёт в команду из записи, какой она видна на экране: тело как в записи, а не отформатированное, иначе payload одной строкой. */
export function curlSource(r: ViewRecord, withHeaders: boolean): CurlSource {
  const { payload, body, headers } = r.sections;
  return { method: r.http?.method ?? null, uri: r.http?.uri ?? '', headers: withHeaders ? headers : null, body: body ?? (payload == null ? null : typeof payload === 'string' ? payload : JSON.stringify(payload)) };
}

/** Значение для оболочки в одинарных кавычках: внутри них не работают ни `$`, ни обратная кавычка, ни перевод строки. Символа NUL в строке оболочки быть не может. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll('\0', '').replaceAll("'", `'\\''`)}'`;
}

const scalar = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : JSON.stringify(v));

/** Заголовки записи парами: Guzzle {Имя: [значения]}, строка или список строк «Имя: значение». */
export function headerPairs(headers: unknown): [string, string][] {
  const fromLine = (line: string): [string, string] | null => {
    const i = line.indexOf(':');
    return i > 0 ? [line.slice(0, i), line.slice(i + 1)] : null;
  };
  if (typeof headers === 'string') return headers.split(/\r?\n/).map(fromLine).filter((p) => p !== null);
  if (Array.isArray(headers)) return headers.map((l) => (typeof l === 'string' ? fromLine(l) : null)).filter((p) => p !== null);
  if (headers && typeof headers === 'object') {
    return Object.entries(headers as Record<string, unknown>).flatMap(([name, v]) => (Array.isArray(v) ? v : [v]).map((x): [string, string] => [name, scalar(x)]));
  }
  return [];
}

/** Строка `-H`. Перевод строки в значении заменяется пробелом: иначе из одного заголовка вышло бы два. Пустое значение curl понимает только как `Имя;`. */
function headerArg(name: string, value: string): string {
  const v = value.replace(/[\r\n]+/g, ' ').trim();
  return `-H ${shellQuote(v === '' ? `${name};` : `${name}: ${v}`)}`;
}

/** Адрес из записи. Путь без хоста дополняется видимым заголовком Host: схемы в записи нет, вход идёт через шлюз по https. */
function fullAddress(uri: string, pairs: readonly [string, string][]): { url: string; noHost: boolean } {
  if (!uri.startsWith('/')) return { url: uri, noHost: false };
  const host = pairs.find(([name]) => name.toLowerCase() === 'host')?.[1].trim();
  return host && HOST.test(host) ? { url: `https://${host}${uri}`, noHost: false } : { url: uri, noHost: true };
}

/**
 * Команда для оболочки. `-g` — иначе `{}` и `[]` адреса стали бы шаблоном curl, `--url` — адрес с минусом впереди стал бы параметром,
 * `--data-raw` — тело с `@` впереди прочитало бы файл. `Content-Length` посчитает сам curl.
 */
export function buildCurl(s: CurlSource): CurlCommand {
  const pairs = headerPairs(s.headers).filter(([name]) => HEADER_NAME.test(name));
  const { url, noHost } = fullAddress(s.uri, pairs);
  const method = s.method ? ` -X ${TOKEN.test(s.method) ? s.method : shellQuote(s.method)}` : '';
  const lines = [`curl -g${method} --url ${shellQuote(url)}`];
  for (const [name, value] of pairs) if (name.toLowerCase() !== 'content-length') lines.push(headerArg(name, value));
  if (s.body) lines.push(`--data-raw ${shellQuote(s.body)}`);
  const command = lines.join(' \\\n  ');
  return { command, masked: command.includes('***'), noHost };
}
