// Сводка и статус запроса.
import type { ErrorReason, RequestSummary, ViewRecord } from './api.ts';
import { businessError } from './business.ts';
import { withoutHtml } from './html-text.ts';
import {
  bodyOf,
  callTitle,
  clipTitle,
  incomingOf,
  pairExchanges,
  sortRecords,
  statusOf,
  WARNING_LEVEL,
  type ParsedRecord,
} from './records.ts';

export { businessError };

export interface SummarizeOptions {
  match: 'exact' | 'inexact';
  /** Конец прочитанного для запроса, мс: окно пакета по now или время последней строки оборванного пакета. */
  readEndMs: number;
  incomplete: boolean;
}

/** Отправка без ответа — ошибка, только если записи полные и с отправки до конца прочитанного прошло больше этого. */
export const NO_RESPONSE_AFTER_MS = 30_000;

export const MAX_REASONS = 5;

/** Отправка без ответа ещё может получить ответ: записи неполные или до конца прочитанного меньше 30 с. */
export function isPendingSend(
  sendMs: number,
  opts: Pick<SummarizeOptions, 'readEndMs' | 'incomplete'>,
): boolean {
  return opts.incomplete || opts.readEndMs - sendMs <= NO_RESPONSE_AFTER_MS;
}

/** Проставляет pending отправкам без ответа по тому же правилу, что summarize. Возвращает новые записи. */
export function markPending(
  records: ViewRecord[],
  opts: Pick<SummarizeOptions, 'readEndMs' | 'incomplete'>,
): ViewRecord[] {
  return records.map((r) =>
    r.http?.noResponse ? { ...r, http: { ...r.http, pending: isPendingSend(r.timeMs, opts) } } : r,
  );
}

export function summarize(cid: string, records: ParsedRecord[], opts: SummarizeOptions): RequestSummary {
  const sorted = sortRecords(records);
  const firstMs = sorted[0]?.timeMs ?? 0;
  const lastMs = sorted[sorted.length - 1]?.timeMs ?? firstMs;
  const incomingRec = sorted.find((r) => r.kind === 'incoming');

  const answered = new Set(pairExchanges(sorted).values());
  // Тексты причин маскируются до обрезки до 200 символов; correlation_id и request_id запроса остаются.
  const keep = new Set([cid]);
  for (const r of records) if (r.requestId) keep.add(r.requestId);
  const text = (s: string) => clipTitle(s, keep);
  const reasons: ErrorReason[] = [];
  sorted.forEach((r, i) => {
    if ((r.levelNum ?? 0) >= WARNING_LEVEL) reasons.push({ kind: 'level', text: text(withoutHtml(r.message) || (r.level ?? '')) });
    if (r.kind === 'response') {
      const status = statusOf(r);
      if (status !== null && status >= 400) reasons.push({ kind: 'http', text: text(`HTTP ${status} · ${callTitle(r)}`) });
      const body = bodyOf(r);
      const business = body === null ? null : businessError(body);
      if (business) reasons.push({ kind: 'business', text: text(`${business} · ${callTitle(r)}`) });
    }
    if (r.kind === 'send' && !answered.has(i)) {
      reasons.push(
        isPendingSend(r.timeMs, opts)
          ? { kind: 'pending', text: text(`ответ ещё не пришёл · ${callTitle(r)}`) }
          : { kind: 'no-response', text: text(`ответ не найден · ${callTitle(r)}`) },
      );
    }
  });

  const status = reasons.some((x) => x.kind !== 'pending') ? 'error' : 'success';
  const external = sorted.some((r) => r.kind === 'call' || r.kind === 'send' || r.kind === 'response');
  const kind = !incomingRec ? 'background' : !external && status === 'success' ? 'maybe-cached' : 'incoming';

  return {
    correlationId: cid,
    firstMs,
    lastMs,
    durationMs: Math.round((lastMs - firstMs) * 1000) / 1000,
    incoming: incomingRec ? incomingOf(incomingRec) : null,
    component: requestComponent(sorted, incomingRec),
    recordCount: records.length,
    status,
    kind,
    reasons: capReasons(reasons),
    match: opts.match,
    incomplete: opts.incomplete,
  };
}

/**
 * До MAX_REASONS причин в порядке времени. pending — не причина ошибки: такие занимают только места,
 * оставшиеся после настоящих причин, иначе запрос «ошибка» мог бы остаться без причины.
 */
function capReasons(all: ErrorReason[]): ErrorReason[] {
  const keep = new Set(all.filter((r) => r.kind !== 'pending').slice(0, MAX_REASONS));
  let room = MAX_REASONS - keep.size;
  for (const r of all) {
    if (room === 0) break;
    if (r.kind === 'pending') {
      keep.add(r);
      room--;
    }
  }
  return all.filter((r) => keep.has(r));
}

/** Компонент первой записи приложения (не шлюза); иначе входящей записи; иначе первой записи. */
function requestComponent(sorted: ParsedRecord[], incoming: ParsedRecord | undefined): string | null {
  const app = sorted.find((r) => !r.gateway && r.component);
  if (app) return app.component;
  if (incoming) return incoming.component;
  return sorted[0]?.component ?? null;
}
