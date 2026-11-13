// Разбор строки лога в запись и представление записей запроса.
// Разбор — по профилю формата (profile/*); здесь — представление разобранных записей.
import type { LogLine } from '../backend/index.ts';
import { builtinProfile } from '../profile/builtin.ts';
import type { ParsedRecord } from '../profile/types.ts';
import type { ViewRecord } from './api.ts';
import { businessError } from './business.ts';
import { withoutHtml } from './html-text.ts';
import { maskText, withoutCredentials } from './masking.ts';
import { BUILTIN_MASKING, maskKindsText, type MaskPolicy } from './mask-pass.ts';
import { WARNING_LEVEL } from '../profile/values.ts';

export type { ParsedRecord } from '../profile/types.ts';
export { LEVELS, parseDatetime, tsNsToMs, WARNING_LEVEL } from '../profile/values.ts';

export const RAW_TITLE = 'не разобрана';
const MAX_TITLE = 200;

/** Разбор строки встроенным профилем json. Сервер разбирает строки профилем проекта: profile.parse(line). */
export function parseLine(l: LogLine): ParsedRecord {
  return builtinProfile().parse(l);
}

/** Порядок записей: время записи, затем время Loki. */
export function sortRecords<T extends { timeMs: number; tsNs: string }>(records: readonly T[]): T[] {
  return [...records].sort((a, b) => a.timeMs - b.timeMs || compareTsNs(a.tsNs, b.tsNs));
}

function compareTsNs(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** HTTP-статус ответа числом или null. */
export function statusOf(r: ParsedRecord): number | null {
  return r.status;
}

/** Тело записи строкой. */
export function bodyOf(r: ParsedRecord): string | null {
  return r.body;
}

/** «host:port/path» без схемы, учётных данных и строки запроса. */
export function shortUri(uri: string): string {
  const rest = withoutCredentials(uri).replace(/[?#].*$/s, '');
  const authority = /^[^/]*/.exec(rest)![0];
  // Не порт, а обрезок учётных данных (host:пароль/…): такая часть в заголовок не идёт, только путь.
  if (!authority.startsWith('[') && /:(?!\d*$)/.test(authority)) return rest.slice(authority.length) || '/';
  return rest;
}

/** «POST host/path» для отправки и ответа. */
export function callTitle(r: ParsedRecord): string {
  return [r.method, r.uri === null ? null : shortUri(r.uri)].filter((x) => x).join(' ');
}

/** Метод и путь входящей записи. */
export function incomingOf(r: ParsedRecord): { method: string; path: string } {
  return { method: r.method ?? '', path: r.uri ?? '' };
}

/**
 * Связь отправки и ответа: ответ берёт последнюю неотвеченную отправку
 * с тем же uri и request_id, иначе с тем же uri. Записи — уже по порядку. Результат: индекс ответа → индекс отправки.
 */
export function pairExchanges(sorted: readonly ParsedRecord[]): Map<number, number> {
  const open: number[] = [];
  const pairs = new Map<number, number>();
  const uris = sorted.map((r) => r.uri);
  const findLast = (ok: (j: number) => boolean) => {
    for (let k = open.length - 1; k >= 0; k--) if (ok(open[k]!)) return k;
    return -1;
  };
  sorted.forEach((r, i) => {
    if (r.kind === 'send') {
      open.push(i);
      return;
    }
    if (r.kind !== 'response') return;
    let at =
      r.requestId === null
        ? -1
        : findLast((j) => uris[j] === uris[i] && sorted[j]!.requestId === r.requestId);
    if (at < 0) at = findLast((j) => uris[j] === uris[i]);
    if (at < 0) return;
    pairs.set(i, open[at]!);
    open.splice(at, 1);
  });
  return pairs;
}

export function isErrorRecord(r: ParsedRecord): boolean {
  if ((r.levelNum ?? 0) >= WARNING_LEVEL) return true;
  if (r.kind !== 'response') return false;
  if ((statusOf(r) ?? 0) >= 400) return true;
  const body = bodyOf(r);
  return body !== null && businessError(body) !== null;
}

const NO_KEEP: ReadonlySet<string> = new Set();

/**
 * Заголовок или причина до MAX_TITLE символов. Маскирование — до обрезки: срез посреди номера карты или значения
 * секрета превратил бы их в то, чего маскирование на выходе уже не узнаёт. keep — correlation_id и request_id.
 */
export function clipTitle(s: string, keep: ReadonlySet<string> = NO_KEEP, strict: MaskPolicy = BUILTIN_MASKING.strict): string {
  // Сначала маска: заголовку Authorization в сыром HTTP нужны переводы строк.
  const one = maskKindsText(maskText(s, keep), strict, keep).replace(/[\r\n]+/g, ' ');
  return one.length > MAX_TITLE ? one.slice(0, MAX_TITLE - 1) + '…' : one;
}

/** Собственные correlation_id и request_id записи: маскирование их не трогает. */
function idsOf(r: ParsedRecord): ReadonlySet<string> {
  const ids = new Set<string>();
  if (r.correlationId) ids.add(r.correlationId);
  if (r.requestId) ids.add(r.requestId);
  return ids;
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

function titleOf(r: ParsedRecord, strict: MaskPolicy): string {
  const keep = idsOf(r);
  switch (r.kind) {
    case 'incoming': {
      const { method, path } = incomingOf(r);
      return clipTitle(`${method} ${path}`.trim() || r.message, keep, strict);
    }
    case 'call':
      return clipTitle(r.action ?? withoutHtml(r.message), keep, strict);
    case 'send':
      return clipTitle(callTitle(r) || r.message, keep, strict);
    case 'response': {
      const status = statusOf(r);
      return clipTitle([callTitle(r), status === null ? '' : `→ ${status}`].filter((x) => x).join(' '), keep, strict);
    }
    case 'raw':
      return RAW_TITLE;
    default:
      return clipTitle(withoutHtml(r.message), keep, strict);
  }
}

/** Сортировка, смещения от первой записи (если withOffsets), связь отправки и ответа, заголовки и блоки. */
export function buildView(records: ParsedRecord[], opts: { withOffsets: boolean; strict?: MaskPolicy }): ViewRecord[] {
  const strict = opts.strict ?? BUILTIN_MASKING.strict;
  const sorted = sortRecords(records);
  const ids = sorted.map((r, i) => `${r.tsNs}-${i}`);
  const respToSend = pairExchanges(sorted);
  const sendToResp = new Map<number, number>();
  for (const [resp, send] of respToSend) sendToResp.set(send, resp);
  const firstMs = sorted[0]?.timeMs ?? 0;

  return sorted.map((r, i): ViewRecord => {
    let http: ViewRecord['http'] = null;
    if (r.kind === 'incoming') {
      http = {
        method: r.method,
        uri: r.uri,
        status: null,
        durationMs: null,
        pairId: null,
        noResponse: false,
        pending: false,
      };
    } else if (r.kind === 'send' || r.kind === 'response') {
      const pair = r.kind === 'send' ? sendToResp.get(i) : respToSend.get(i);
      const other = pair === undefined ? undefined : sorted[pair];
      http = {
        method: r.method,
        uri: r.uri,
        status: r.kind === 'response' ? statusOf(r) : null,
        durationMs: other ? round3(Math.abs(r.timeMs - other.timeMs)) : null,
        pairId: pair === undefined ? null : ids[pair]!,
        noResponse: r.kind === 'send' && pair === undefined,
        pending: false,
      };
    }

    return {
      id: ids[i]!,
      tsNs: r.tsNs,
      timeMs: r.timeMs,
      offsetMs: opts.withOffsets ? round3(r.timeMs - firstMs) : null,
      kind: r.kind,
      title: titleOf(r, strict),
      ...(r.kind === 'raw' ? { titleCode: 'raw' as const } : {}),
      message: r.message,
      level: r.level,
      isError: isErrorRecord(r),
      component: r.component,
      gateway: r.gateway,
      correlationId: r.correlationId,
      requestId: r.requestId,
      http,
      sections: {
        headers: r.headers ?? null,
        body: r.body,
        payload: r.payload ?? null,
        context: r.context,
      },
      raw: r.line,
      match: null,
      // Подсказка шага графа из профиля: только у записей-логов.
      ...(r.kind === 'log' && r.flow ? { flow: r.flow } : {}),
    };
  });
}
