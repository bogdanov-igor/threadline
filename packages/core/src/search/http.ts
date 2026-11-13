// Разбор сырого HTTP-сообщения: запись шлюза с сырым запросом (raw_request встроенного формата) и вложенные тела.

export interface HttpMessage {
  /** Первая строка: «GET /v1/x HTTP/1.1» или «HTTP/1.1 200 OK». */
  startLine: string;
  /** Запрос: метод и цель; у ответа null. */
  method: string | null;
  uri: string | null;
  /** Ответ: код статуса; у запроса null. */
  status: number | null;
  /** Заголовки как у Guzzle: имя → значения в порядке появления. */
  headers: Record<string, string[]>;
  /** Всё после первой пустой строки; '' — тела нет. */
  body: string;
}

const REQUEST_LINE = /^([A-Z][A-Z0-9_-]{0,19}) (\S+) HTTP\/\d(?:\.\d)?$/;
const STATUS_LINE = /^HTTP\/\d(?:\.\d)? (\d{3})(?: .*)?$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** Первая строка длиннее — не HTTP: так проверка большого текста не читает его целиком. */
const MAX_START_LINE = 8192;

/** Похожа ли строка на сырое HTTP-сообщение: первая строка запроса или ответа и перевод строки после неё. */
export function looksLikeHttp(s: string): boolean {
  const end = s.indexOf('\n');
  if (end < 0 || end > MAX_START_LINE) return false;
  const first = s.slice(0, end).replace(/\r$/, '');
  return REQUEST_LINE.test(first) || STATUS_LINE.test(first);
}

/** Разбирает сырое HTTP-сообщение; null, если первая строка не HTTP. Разделители строк — CRLF или LF. */
export function parseHttpMessage(raw: string): HttpMessage | null {
  const sep = /\r?\n\r?\n/.exec(raw);
  const head = sep ? raw.slice(0, sep.index) : raw;
  const body = sep ? raw.slice(sep.index + sep[0].length) : '';
  const lines = head.split(/\r?\n/);
  const startLine = (lines[0] ?? '').trim();
  if (startLine.length > MAX_START_LINE) return null;
  const req = REQUEST_LINE.exec(startLine);
  const res = req ? null : STATUS_LINE.exec(startLine);
  if (!req && !res) return null;

  const headers: Record<string, string[]> = {};
  for (const line of lines.slice(1)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const name = line.slice(0, i).trim();
    if (!HEADER_NAME.test(name)) continue;
    const value = line.slice(i + 1).trim();
    const prev = Object.hasOwn(headers, name) ? headers[name] : undefined;
    // defineProperty: имя «__proto__» из лога не меняет прототип объекта.
    if (prev) prev.push(value);
    else Object.defineProperty(headers, name, { value: [value], enumerable: true, writable: true, configurable: true });
  }
  return {
    startLine,
    method: req?.[1] ?? null,
    uri: req?.[2] ?? null,
    status: res ? Number(res[1]) : null,
    headers,
    body,
  };
}

/** Первое значение заголовка без учёта регистра имени. */
export function headerValue(headers: Record<string, string[]>, name: string): string | null {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === lower) return v[0] ?? null;
  return null;
}
