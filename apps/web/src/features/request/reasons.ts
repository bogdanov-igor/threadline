// Причины ошибки запроса для шапки: одинаковые схлопнуты с ×N, HTTP и код одного шага — одна строка, сверх 3 — «ещё N».
// Длинный поток на 1280px: панель шага начинается на первом экране.
import { businessError, MAX_REASONS, withoutHtmlShown, type ErrorReason, type RequestSummary, type ViewRecord } from '@threadline/core/search';
import { briefReason, catalogReasonView, undescribedReason, type CatalogReasonView } from '@/features/catalog/names.ts';

export const MAX_REASON_ROWS = 3;

export interface ReasonRow {
  view: CatalogReasonView;
  /** Сколько причин в этой строке. */
  count: number;
}

/** Строка только со статусом: её смысл уже в строке с текстом ошибки этого же обмена. */
const httpOnly = (v: CatalogReasonView) => !v.named && v.codes.length === 1 && v.codes[0]!.startsWith('HTTP ');

export function groupReasons(views: readonly CatalogReasonView[]): ReasonRow[] {
  const withText = new Map<string, CatalogReasonView>();
  for (const v of views) if (v.target && !httpOnly(v)) withText.set(v.target, v);
  const rows = new Map<string, ReasonRow>();
  const statusOf = new Map<string, string>();
  for (const v of views) {
    if (v.target && httpOnly(v) && withText.has(v.target)) {
      statusOf.set(v.target, v.codes[0]!);
      continue;
    }
    const key = [v.source, v.system ?? '', v.call ?? '', v.message.toLowerCase()].join('\u0000');
    const row = rows.get(key);
    if (row) row.count++;
    else rows.set(key, { view: v, count: 1 });
  }
  return [...rows.values()].map((r) => {
    const status = r.view.target ? statusOf.get(r.view.target) : undefined;
    return status && !r.view.codes.includes(status) ? { ...r, view: { ...r.view, codes: [status, ...r.view.codes] } } : r;
  });
}

/** «Что делать» у строки причин: действие справочника у причины с тем же текстом. */
export function rowAction(row: ReasonRow | undefined, reasons: readonly ErrorReason[], views: readonly CatalogReasonView[]): string | null {
  return row ? (reasons[views.findIndex((v) => v.message === row.view.message)]?.error?.action ?? null) : null;
}

/** Где случилось: система и вызов теми же словами, что в этом режиме. «Кратко» без адреса и кодов. */
export function reasonWhere(v: CatalogReasonView, operation: string | null, brief: boolean): string {
  const short = brief ? briefReason(v, operation) : null;
  return (short ? [short.system, short.call] : [v.system, operation ?? v.call]).filter(Boolean).join(' · ');
}

export interface RootReason {
  view: CatalogReasonView;
  action: string | null;
  /** У главной причины нет слов справочника: у Бизнеса на её месте только общие слова. */
  undescribed: boolean;
}

/** Главная причина запроса: первая строка блока причин. Отправка без ответа, когда записи неполные, причиной не считается. */
export function rootReason(reasons: readonly ErrorReason[]): RootReason | null {
  const errors = reasons.filter((r) => r.kind !== 'pending');
  const views = errors.map((r) => catalogReasonView(r));
  const row = groupReasons(views)[0];
  if (!row) return null;
  const reason = errors[views.findIndex((v) => v.message === row.view.message)];
  return { view: row.view, action: rowAction(row, errors, views), undescribed: reason ? undescribedReason(reason) : false };
}

/** Уровень записи, с которого сервер считает её причиной: WARNING и выше. */
const REASON_LEVELS = new Set(['WARNING', 'WARN', 'ERROR', 'ERR', 'CRITICAL', 'CRIT', 'ALERT', 'EMERGENCY', 'FATAL']);
const MAX_TEXT = 200;
const oneLine = (s: string) => {
  const line = withoutHtmlShown(s).replace(/[\r\n]+/g, ' ');
  return line.length > MAX_TEXT ? `${line.slice(0, MAX_TEXT - 1)}…` : line;
};

/**
 * Причины по записям страницы: те же правила и тот же порядок, что на сервере до обрезки до пяти (finalizeSummary).
 * Читается только то, что браузер уже получил и что видно на графе и в итоге шага. restricted, и запись без сырого текста тоже:
 * текст только из справочника, иначе пусто и общие слова, как в серверной причине Бизнеса.
 */
export function recordReasons(records: Iterable<ViewRecord>, restricted: boolean): ErrorReason[] {
  const out: ErrorReason[] = [];
  for (const r of records) {
    const c = r.catalog ?? null;
    const plain = restricted || r.raw === '';
    const say = (kind: ErrorReason['kind'], text: string, withError = true) => {
      const error = withError ? (c?.error ?? null) : null;
      out.push({ kind, text: plain ? (error?.title ?? '') : oneLine(text), ...(c ? { name: c.name, error } : {}) });
    };
    const ok = c?.error?.severity === 'ok';
    const service = r.kind === 'incoming' || r.kind === 'send' || r.kind === 'response';
    if (REASON_LEVELS.has(r.level?.toUpperCase() ?? '') && (service || !ok)) say('level', r.message || (r.level ?? ''), !service);
    if (r.kind === 'response') {
      const title = r.title.replace(/ → \d{3}$/, '');
      const status = r.http?.status ?? null;
      if (c?.outcome) {
        if (c.outcome.kind === 'error') say('outcome', `${c.outcome.text || `HTTP ${status ?? '—'}`} · ${title}`);
      } else if (plain) {
        // Статуса и тела в такой записи нет, остаётся признак ошибки. Запись с уровнем уже посчитана выше.
        if (!ok && r.isError && !REASON_LEVELS.has(r.level?.toUpperCase() ?? '')) say('http', '');
      } else if (!ok) {
        const business = r.sections.body === null ? null : businessError(r.sections.body);
        const failed = status !== null && status >= 400;
        // Запись с правилом справочника даёт одну причину, без правила — статус и текст отдельно.
        if (failed && !(c?.error?.rule && business)) say('http', `HTTP ${status} · ${title}`);
        if (business) say('business', `${business} · ${title}`);
      }
    }
    if (r.kind === 'send' && r.http?.noResponse && !r.http.pending) say('no-response', `ответ не найден · ${r.title}`, false);
  }
  return out;
}

/** Причины сверх обрезки сервера. Сервер отдал меньше пяти настоящих — обрезки не было, остального нет. */
export function reasonsOverCap(s: Pick<RequestSummary, 'reasons'>, records: Iterable<ViewRecord>, restricted: boolean): ErrorReason[] {
  if (s.reasons.filter((r) => r.kind !== 'pending').length < MAX_REASONS) return [];
  return recordReasons(records, restricted).slice(MAX_REASONS);
}
