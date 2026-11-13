// Разметка справочника на выходе: сводка запроса (finalizeSummary) и записи страницы запроса (annotateRecords).
// Работает по немаскированным записям, до maskDeep.
// resolver = null — справочник выключен или не загружен: результат как без справочника, байт в байт.

import type { CatalogError, CatalogName, ErrorReason, RecordCatalog, RecordKind, RequestSummary, ViewRecord } from '../search/api.ts';
import { businessFact, type BusinessError } from '../search/business.ts';
import { withoutHtml } from '../search/html-text.ts';
import type { MaskPolicy } from '../search/mask-pass.ts';
import { callTitle, clipTitle, pairExchanges, sortRecords, WARNING_LEVEL, type ParsedRecord } from '../search/records.ts';
import { isPendingSend, MAX_REASONS } from '../search/status.ts';
import { parseBody, type ParsedBody } from './body.ts';
import { stepIds, stepStatus, type StepBodies } from './ids.ts';
import { uriParts } from './host.ts';
import { renderTemplate } from './outcome.ts';
import { clipMasked } from './secure.ts';
import type { ErrorFact, ErrorMatch, OutcomeMatch, ResolvedStep, Resolver, Scope } from './resolve.ts';
import { rpcAction } from './rpc.ts';
import { templatePlaceholders } from './schema.ts';

/** Запись для разметки: общее у ParsedRecord и ViewRecord. */
export interface StepRecord {
  kind: RecordKind;
  method: string | null;
  uri: string | null;
  status: number | null;
  body: string | null;
  message: string;
  level: string | null;
  context: Record<string, unknown> | null;
  /** Запись приложения уровня WARNING и выше. */
  logError: boolean;
  /** Обращение к базе по подсказке профиля (ViewRecord.flow): канал db, хост — если записан. */
  db: { host: string | null } | null;
}

/** Что справочник узнал о записи запроса. */
export interface StepFacts {
  step: ResolvedStep | null;
  name: CatalogName | null;
  /** Ответ: его отправка. */
  send: number | null;
  /** Ответ: правило итога. */
  outcome: OutcomeMatch | null;
  /** Ответ: признак бизнес-ошибки. */
  business: BusinessError | null;
  /** Факт ошибки: признаки ответа или запись WARNING+; null — признаков нет. */
  fact: ErrorFact | null;
  match: ErrorMatch | null;
  scope: Scope | null;
}

const NO_BODY: ParsedBody = { kind: 'none' };
/** Исходный текст ошибки и его часть для сличения и показа. */
const MAX_FACT_TEXT = 200;
const bodyCache = new WeakMap<object, ParsedBody>();

/** Тело записи разбирается один раз: кэш по объекту записи. */
function bodyOf(key: object, body: string | null): ParsedBody {
  if (!body) return NO_BODY;
  let b = bodyCache.get(key);
  if (!b) {
    b = parseBody(body);
    bodyCache.set(key, b);
  }
  return b;
}

function logCode(ctx: Record<string, unknown> | null): string | null {
  if (!ctx) return null;
  const err = ctx.error;
  for (const v of [ctx.code, ctx.error_code, typeof err === 'object' && err !== null ? (err as Record<string, unknown>).code : undefined]) {
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
    if (typeof v === 'number') return String(v);
  }
  return null;
}

/** Факты записей запроса. recs — уже по порядку; pairs — индекс ответа → индекс его отправки. */
export function analyze(recs: readonly StepRecord[], keys: readonly object[], pairs: ReadonlyMap<number, number>, resolver: Resolver): StepFacts[] {
  const sendToResp = new Map<number, number>();
  for (const [resp, send] of pairs) sendToResp.set(send, resp);
  const entryIdx = recs.findIndex((r) => r.kind === 'incoming');
  const entryRec = entryIdx >= 0 ? recs[entryIdx]! : null;
  const entry = entryRec ? resolver.entry(entryRec.method, entryRec.uri) : null;
  const projectScope: Scope = { systemId: resolver.author?.id ?? null, methodId: entry?.method?.id ?? null };
  const projectName = entry ? resolver.name(entry, 'entry') : resolver.name({ system: resolver.author, method: null, tpl: null, segs: [], uri: { scheme: null, host: null, port: null, path: '/', query: null }, byPath: false }, 'entry');

  // Действие — по телу отправки; без отправки — по телу ответа без окончания Response.
  const exchangeStep = (r: StepRecord, other: StepRecord | null) => {
    const own = rpcAction(r.body, { response: r.kind === 'response' });
    const action = r.kind === 'response' ? (other ? rpcAction(other.body) : '') || own : own || (other ? rpcAction(other.body, { response: true }) : '');
    return resolver.exchange(r.method ?? other?.method ?? null, r.uri ?? other?.uri ?? null, action);
  };

  // Ответ на вход: запись ответа с методом и путём входа без своей отправки. Хоста нет или он тот же. Это шаг метода проекта.
  const entryParts = entryRec ? uriParts(entryRec.uri) : null;
  const answersEntry = (r: StepRecord, i: number): boolean => {
    if (r.kind !== 'response' || !entryRec || !entryParts || pairs.has(i)) return false;
    const p = uriParts(r.uri);
    return p.path === entryParts.path && (p.host === null || p.host === entryParts.host) && (r.method === null || r.method === entryRec.method);
  };

  return recs.map((r, i): StepFacts => {
    const empty: StepFacts = { step: null, name: null, send: null, outcome: null, business: null, fact: null, match: null, scope: null };
    if (r.kind === 'incoming') return { ...empty, step: entry && i === entryIdx ? entry : resolver.entry(r.method, r.uri), name: projectName };
    if (r.kind === 'send' || r.kind === 'response') {
      const otherIdx = r.kind === 'response' ? pairs.get(i) : sendToResp.get(i);
      const other = otherIdx === undefined ? null : recs[otherIdx]!;
      const toEntry = answersEntry(r, i);
      const step = toEntry ? entry! : exchangeStep(r, other);
      const scope: Scope = toEntry ? projectScope : { systemId: step.system?.id ?? null, methodId: step.method?.id ?? null };
      const name = toEntry ? projectName : resolver.name(step, 'exchange');
      if (r.kind === 'send') return { ...empty, step, name, scope };
      const send = toEntry ? entryIdx : (otherIdx ?? null);
      const status = r.status;
      const outcome = resolver.hasOutcomeRules(scope)
        ? resolver.matchOutcome(scope, {
            http: status,
            response: bodyOf(keys[i]!, r.body),
            request: send === null ? NO_BODY : bodyOf(keys[send]!, recs[send]!.body),
          })
        : null;
      const business = r.body ? businessFact(r.body) : null;
      const httpError = status !== null && status >= 400;
      const fact: ErrorFact | null =
        business || httpError
          ? {
              http: httpError ? status : null,
              status,
              code: business?.code ?? null,
              text: business ? (business.message ?? business.text) : (r.body ?? '').slice(0, MAX_FACT_TEXT) || null,
              // Маска видит всё тело: срез посреди номера или секрета она бы не узнала.
              ...errorTexts(business ? (business.message ?? business.text) : (r.body ?? ''), business ? (business.message ?? business.keyText ?? business.text) : (r.body ?? ''), resolver.masking.strict),
            }
          : null;
      const match = fact ? resolver.matchError(scope, fact) : null;
      return { step, name, send, outcome, business, fact, match, scope };
    }
    // База — по хосту среди систем вида «база», иначе единственная база проекта; две базы без хоста — неизвестно.
    const dbStep = r.db ? resolver.exchange(null, r.db.host ? `//${r.db.host}` : null, '', 'db') : null;
    if (dbStep && !r.logError) return { ...empty, step: dbStep, name: resolver.name(dbStep, 'exchange') };
    if (r.logError) {
      const text = r.message || r.level || null;
      const fact: ErrorFact = { http: null, status: null, code: logCode(r.context), text, ...errorTexts(text ?? '', text ?? '', resolver.masking.strict) };
      // Ошибка базы — по правилам её системы, источник «внешняя система»; неузнанная база — как запись приложения.
      if (dbStep?.system) {
        const scope: Scope = { systemId: dbStep.system.id, methodId: null };
        return { ...empty, step: dbStep, name: resolver.name(dbStep, 'exchange'), fact, match: resolver.matchError(scope, fact), scope };
      }
      return { ...empty, name: projectName, fact, match: resolver.matchError(projectScope, fact), scope: projectScope };
    }
    return empty;
  });
}

/**
 * Тексты ошибки для показа и ключа. Страница HTML в показ не идёт, а ключ строки «Неизвестного» считается как раньше: прежние строки не теряются,
 * и новая ошибка о себе не сообщает второй раз. key отличается от source, только если в тексте без поля сообщения уже убрана страница.
 */
function errorTexts(source: string, key: string, strict: MaskPolicy): Pick<ErrorFact, 'readable' | 'shown' | 'keyText'> {
  const plain = withoutHtml(source);
  return {
    ...(plain === source ? {} : { readable: plain }),
    shown: clipMasked(plain, MAX_FACT_TEXT, strict) || null,
    keyText: clipMasked(key, MAX_FACT_TEXT, strict) || null,
  };
}

function catalogError(f: StepFacts, source: CatalogName['source'] | undefined, exchange: boolean): CatalogError {
  const m = f.match;
  // Общее правило на обмене с неузнанной системой: система так и остаётся неизвестной, ошибка не проекта.
  const sys = source === 'external' ? 'external' : exchange && source === 'unknown' ? 'unknown' : 'project';
  return {
    source: m ? sys : 'unknown',
    rule: m ? { id: m.rule.id, level: m.level, kind: 'error' } : null,
    title: m?.rule.title ?? null,
    action: m?.rule.action ?? null,
    severity: m?.rule.severity ?? 'error',
    partnerCode: m?.rule.partnerCode ?? null,
    raw: rawOf(f, f.fact?.http ?? null),
  };
}

/** Исходные код и текст ошибки для показа: уже маскированы и обрезаны. */
function rawOf(f: StepFacts, http: number | null): CatalogError['raw'] {
  const code = f.fact?.code ?? null;
  return { http, code: code === null ? null : clipMasked(code, MAX_FACT_TEXT), text: f.fact?.shown ?? null };
}

/** Текст правила итога без мест подстановки: значения из ответа в него не попадают. */
function fixedRuleText(text: string | null): boolean {
  if (!text) return false;
  const t = templatePlaceholders(text);
  return t.ok && t.paths.length === 0;
}

/** Ошибка ответа по правилу итога error: текст правила, иначе правило ошибки, иначе признак, иначе HTTP-статус. */
function outcomeError(f: StepFacts, r: StepRecord, rendered: string): CatalogError {
  const o = f.outcome!;
  const m = f.match;
  return {
    safeTitle: (fixedRuleText(o.rule.text) ? rendered : '') || m?.rule.title || null,
    source: f.name?.source ?? 'project',
    rule: { id: o.rule.id, level: o.level, kind: 'outcome' },
    title: rendered || m?.rule.title || f.business?.text || (r.status === null ? null : `HTTP ${r.status}`),
    action: o.rule.action ?? m?.rule.action ?? null,
    severity: 'error',
    partnerCode: m?.rule.partnerCode ?? null,
    raw: rawOf(f, r.status),
  };
}

// ---------- Сводка запроса ----------

function fromParsed(r: ParsedRecord): StepRecord {
  return {
    kind: r.kind,
    method: r.method,
    uri: r.uri,
    status: r.status,
    body: r.body,
    message: r.message,
    level: r.level,
    context: r.context,
    logError: (r.levelNum ?? 0) >= WARNING_LEVEL,
    db: r.kind === 'log' && r.flow?.as === 'db' ? { host: r.flow.host } : null,
  };
}

export interface FinalizeOptions {
  readEndMs: number;
  incomplete: boolean;
}

/**
 * Причины и статус запроса с учётом справочника: правила итога, «не ошибка», тексты и подписи, затем обрезка до 5.
 * Поля сводки, кроме status, kind, reasons и entry, остаются как в base.
 */
export function finalizeSummary(base: RequestSummary, records: readonly ParsedRecord[], resolver: Resolver | null, opts: FinalizeOptions): RequestSummary {
  if (!resolver) return base;
  const sorted = sortRecords(records);
  const pairs = pairExchanges(sorted);
  const answered = new Set(pairs.values());
  const recs = sorted.map(fromParsed);
  const facts = analyze(recs, sorted, pairs, resolver);
  const keep = new Set([base.correlationId]);
  for (const r of records) if (r.requestId) keep.add(r.requestId);
  const strict = resolver.masking.strict;
  const text = (s: string) => clipTitle(s, keep, strict);

  const reasons: ErrorReason[] = [];
  sorted.forEach((r, i) => {
    const f = facts[i]!;
    const rec = recs[i]!;
    if (rec.logError) {
      const levelText = text(withoutHtml(r.message) || (r.level ?? ''));
      // Вход, отправка и ответ уровня WARNING: правила ошибок проекта к ним не применяются.
      if (r.kind === 'incoming' || r.kind === 'send' || r.kind === 'response') reasons.push({ kind: 'level', text: levelText, name: f.name, error: null });
      else if (f.match?.rule.severity !== 'ok') reasons.push({ kind: 'level', text: levelText, name: f.name, error: catalogError(f, f.name?.source, false) });
    }
    if (r.kind === 'response') {
      const title = callTitle(r);
      if (f.outcome) {
        if (f.outcome.rule.outcome === 'error') {
          const rendered = f.outcome.rule.text ? renderTemplate(f.outcome.rule.text, bodyOf(r, r.body), strict) : '';
          const error = outcomeError(f, rec, rendered);
          reasons.push({ kind: 'outcome', text: text(`${rendered || `HTTP ${r.status ?? '—'}`} · ${title}`), name: f.name, error });
        }
      } else if (f.fact) {
        if (f.match?.rule.severity === 'ok') return;
        const error = catalogError(f, f.name?.source, true);
        const httpError = r.status !== null && r.status >= 400;
        if (f.match) {
          reasons.push(
            f.business
              ? { kind: 'business', text: text(`${f.business.text} · ${title}`), name: f.name, error }
              : { kind: 'http', text: text(`HTTP ${r.status} · ${title}`), name: f.name, error },
          );
        } else {
          if (httpError) reasons.push({ kind: 'http', text: text(`HTTP ${r.status} · ${title}`), name: f.name, error });
          if (f.business) reasons.push({ kind: 'business', text: text(`${f.business.text} · ${title}`), name: f.name, error });
        }
      }
    }
    if (r.kind === 'send' && !answered.has(i)) {
      reasons.push(
        isPendingSend(r.timeMs, opts)
          ? { kind: 'pending', text: text(`ответ ещё не пришёл · ${callTitle(r)}`), name: f.name, error: null }
          : { kind: 'no-response', text: text(`ответ не найден · ${callTitle(r)}`), name: f.name, error: null },
      );
    }
  });

  const status = reasons.some((x) => x.kind !== 'pending') ? 'error' : 'success';
  const hasIncoming = sorted.some((r) => r.kind === 'incoming');
  const external = sorted.some((r) => r.kind === 'call' || r.kind === 'send' || r.kind === 'response');
  const kind = !hasIncoming ? 'background' : !external && status === 'success' ? 'maybe-cached' : 'incoming';
  const entryIdx = sorted.findIndex((r) => r.kind === 'incoming');
  const entry = entryIdx >= 0 ? (facts[entryIdx]!.name ?? null) : null;
  // Колбэк сообщает итог сам: «возможно, ответ из кэша» к нему не относится.
  const finalKind = kind === 'maybe-cached' && entry?.method?.kind === 'callback' ? 'incoming' : kind;
  return { ...base, status, kind: finalKind, reasons: capReasons(reasons), entry };
}

/** До MAX_REASONS причин; pending — только на оставшиеся места. Как в search/status.ts. */
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

// ---------- Записи страницы запроса ----------

function fromView(v: ViewRecord): StepRecord {
  const notExchange = v.kind !== 'incoming' && v.kind !== 'send' && v.kind !== 'response';
  return {
    kind: v.kind,
    method: v.http?.method ?? null,
    uri: v.http?.uri ?? null,
    status: v.http?.status ?? null,
    body: v.sections.body,
    message: v.message,
    level: v.level,
    context: v.sections.context,
    // У записей, кроме ответа, isError — это уровень WARNING и выше (records.ts, isErrorRecord).
    logError: notExchange && v.isError,
    db: v.kind === 'log' && v.flow?.as === 'db' ? { host: v.flow.host } : null,
  };
}

/**
 * ViewRecord.catalog у входа, отправок, ответов и записей с ошибкой: подпись, ошибка, итог по правилу, id и статус.
 * Отправка и ответ связаны по pairId; во «Всех записях» связи нет.
 */
export function annotateRecords(view: readonly ViewRecord[], resolver: Resolver | null): ViewRecord[] {
  if (!resolver) return [...view];
  const index = new Map(view.map((v, i) => [v.id, i]));
  const pairs = new Map<number, number>();
  view.forEach((v, i) => {
    if (v.kind === 'response' && v.http?.pairId) {
      const s = index.get(v.http.pairId);
      if (s !== undefined) pairs.set(i, s);
    }
  });
  const recs = view.map(fromView);
  const facts = analyze(recs, view, pairs, resolver);
  const strict = resolver.masking.strict;
  return view.map((v, i) => {
    const f = facts[i]!;
    const r = recs[i]!;
    if (!f.name) return v;
    const catalog: RecordCatalog = { name: f.name, error: null, outcome: null, ids: [], status: null };
    if (f.step && (v.kind === 'incoming' || v.kind === 'send' || v.kind === 'response')) {
      const send = f.send === null ? null : view[f.send]!;
      const bodies: StepBodies = {
        query: f.step.uri.query,
        request: v.kind === 'response' ? (send ? bodyOf(send, send.sections.body) : NO_BODY) : bodyOf(v, r.body),
        response: v.kind === 'response' ? bodyOf(v, r.body) : NO_BODY,
      };
      const m = f.step.method;
      if (m && f.step.tpl) {
        // У ответа подстановки — из адреса, поля — из тела ответа; у входа и отправки — строка запроса и тело отправки.
        const fields = m.fields.filter((x) => (v.kind === 'response' ? x.in === 'response' : x.in !== 'response'));
        catalog.ids = stepIds(f.step.tpl, f.step.segs, fields, bodies, resolver.idTypes, strict);
        if (m.op && m.status && (m.status.in === 'response') === (v.kind === 'response')) {
          catalog.status = stepStatus(m.op, m.status, bodies, resolver.idTypes, strict);
        }
      }
    }
    if (v.kind === 'response') {
      if (f.outcome) {
        const o = f.outcome.rule;
        const rendered = o.text ? renderTemplate(o.text, bodyOf(v, r.body), strict) : '';
        catalog.outcome = { kind: o.outcome, rule: { id: o.id, level: f.outcome.level }, text: rendered || null, action: o.action, ...(fixedRuleText(o.text) ? { fixed: true } : {}) };
        if (o.outcome === 'error') catalog.error = outcomeError(f, r, rendered);
        else if (o.outcome === 'ignore' && f.fact) catalog.error = { ...catalogError(f, f.name.source, true), severity: 'ok', rule: { id: o.id, level: f.outcome.level, kind: 'outcome' } };
      } else if (f.fact) catalog.error = catalogError(f, f.name.source, true);
    } else if (r.logError && f.fact) catalog.error = catalogError(f, f.name.source, false);
    return { ...v, catalog };
  });
}
