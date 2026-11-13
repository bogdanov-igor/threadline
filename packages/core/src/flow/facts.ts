// Факты потока для операции и ключи операции запроса — из записей с разметкой справочника, на сервере, до маскирования.
import type { ViewRecord } from '../search/api.ts';
import { maskText } from '../search/masking.ts';
import { catalogOf, idKey, shortId, type FlowCatalogMarkup } from './catalog.ts';
import { hostOf, plainSystem, uriParts } from '../catalog/host.ts';
import { strictPathTemplate } from '../catalog/path.ts';
import { pathOfUri } from './graph.ts';
import type { FoundPlace, OpFlowFacts, OpStep } from './operation.ts';

const ERROR_LEVELS = new Set(['ERROR', 'ERR', 'CRITICAL', 'CRIT', 'ALERT', 'EMERGENCY', 'FATAL']);

/** Ошибка записи с учётом правила итога и отметки «не ошибка» справочника. */
export function recordError(r: ViewRecord, c: FlowCatalogMarkup | null = catalogOf(r)): boolean {
  const rule = c?.outcome?.kind;
  if (rule === 'error') return true;
  if (rule) return false;
  if (c?.error?.severity === 'ok') return false;
  return r.isError;
}

const hasStatusField = (c: FlowCatalogMarkup | null) => {
  const m = c?.name?.method;
  if (!m) return false;
  return m.hasStatus ?? (m.kind === 'status' && m.opType !== null);
};

/** Строгий шаблон пути адреса: без хоста, строки запроса и значений; адреса нет — null. */
const strictPathOf = (uri: string | null): string | null => (uri ? strictPathTemplate(uriParts(uri).path) : null);

/** Где в записях нашлось значение без разметки. Код: подпись на языке интерфейса выбирает браузер. */
export function foundPlace(records: readonly ViewRecord[], values: readonly string[]): FoundPlace | null {
  for (const r of records) {
    const has = (s: unknown) => typeof s === 'string' && values.some((v) => s.includes(v));
    if (!values.some((v) => r.raw.includes(v))) continue;
    if (r.kind === 'incoming' && has(r.http?.uri)) return 'entry-path';
    if (r.kind === 'incoming' && has(r.sections.body)) return 'entry-body';
    if (r.kind === 'send' && has(r.http?.uri)) return 'send-url';
    if (r.kind === 'send' && has(r.sections.body)) return 'send-body';
    if (r.kind === 'response' && has(r.sections.body)) return 'response-body';
    if (r.kind === 'log' || r.kind === 'text' || r.kind === 'raw') return 'log-body';
    return 'record-text';
  }
  return null;
}

/**
 * Факты потока: вход, обмены (отправка с ответом), вызовы и записи-логи с ошибкой. records — запросы потока по порядку,
 * с разметкой (annotateRecords), немаскированные. values — значения ключа: для места совпадения у потока без разметки.
 */
export function flowFacts(
  cid: string,
  records: readonly ViewRecord[],
  opts: { segment?: number | null; nocid?: boolean; incomplete?: boolean; status?: 'error' | 'success'; values?: readonly string[] } = {},
): OpFlowFacts {
  const byId = new Map(records.map((r) => [r.id, r]));
  const steps: OpStep[] = [];
  let entry: OpStep | null = null;
  for (const r of records) {
    const c = catalogOf(r);
    if (r.kind === 'incoming') {
      if (entry) continue;
      const m = c?.name?.method ?? null;
      const s: OpStep = {
        id: r.id,
        kind: 'entry',
        atMs: r.timeMs,
        endMs: r.timeMs,
        title: m?.name ?? (`${r.http?.method ?? ''} ${pathOfUri(r.http?.uri ?? null) ?? ''}`.trim() || r.title),
        safeTitle: m?.name ?? strictPathOf(r.http?.uri ?? null),
        methodKind: m?.kind ?? null,
        hasStatusField: hasStatusField(c),
        ids: c?.ids ?? [],
        status: c?.status ?? null,
        claimed: m?.kind === 'callback' && c?.status != null,
        error: recordError(r, c),
      };
      entry = s;
      steps.push(s);
      continue;
    }
    if (r.kind === 'send' || (r.kind === 'response' && !r.http?.pairId)) {
      const resp = r.kind === 'response' ? r : r.http?.pairId ? (byId.get(r.http.pairId) ?? null) : null;
      const cr = resp && resp !== r ? catalogOf(resp) : r.kind === 'response' ? c : null;
      const cs = r.kind === 'send' ? c : null;
      const name = cs?.name ?? cr?.name ?? null;
      const uri = r.http?.uri ?? null;
      const system = name?.system?.name ?? hostOf(uri) ?? '';
      const method = name?.method?.name ?? pathOfUri(uri) ?? '';
      const ids = [...(cs?.ids ?? []), ...(cr?.ids ?? [])].filter((id, i, all) => all.findIndex((x) => idKey(x.type, x.value) === idKey(id.type, id.value) && x.at === id.at) === i);
      const noAnswer = r.kind === 'send' && !resp;
      steps.push({
        id: r.id,
        kind: 'exchange',
        atMs: r.timeMs,
        endMs: resp ? Math.max(r.timeMs, resp.timeMs) : r.timeMs,
        title: [system, method].filter((x) => x).join(' · '),
        // Только справочник и имя системы: title выше может нести хост и значения из адреса. Шаблона пути у обмена для Бизнеса нет.
        safeTitle: [name?.system?.name ?? plainSystem(uri), name?.method?.name].filter((x) => x).join(' · ') || null,
        methodKind: name?.method?.kind ?? null,
        hasStatusField: hasStatusField(cs ?? cr),
        ids,
        status: cr?.status ?? cs?.status ?? null,
        claimed: false,
        error: noAnswer ? !(r.http?.pending ?? false) : recordError(resp ?? r, cr ?? cs),
      });
      continue;
    }
    if (r.kind === 'call') {
      steps.push({ id: r.id, kind: 'call', atMs: r.timeMs, endMs: r.timeMs, title: r.title, methodKind: null, hasStatusField: false, ids: c?.ids ?? [], status: null, claimed: false, error: false });
      continue;
    }
    if (r.kind === 'response') continue;
    const level = (r.level ?? '').toUpperCase();
    if (!ERROR_LEVELS.has(level) && !(c?.ids?.length ?? 0)) continue;
    steps.push({ id: r.id, kind: 'log', atMs: r.timeMs, endMs: r.timeMs, title: r.title, methodKind: null, hasStatusField: false, ids: c?.ids ?? [], status: null, claimed: false, error: ERROR_LEVELS.has(level) && recordError(r, c) });
  }
  const times = records.map((r) => r.timeMs);
  const status = opts.status ?? (steps.some((s) => s.error) ? 'error' : 'success');
  return {
    cid,
    segment: opts.segment ?? null,
    nocid: opts.nocid ?? false,
    firstMs: times.length ? Math.min(...times) : 0,
    lastMs: times.length ? Math.max(...times) : 0,
    status,
    incomplete: opts.incomplete ?? false,
    entry,
    steps,
    found: opts.values && opts.values.length > 0 ? foundPlace(records, opts.values) : null,
    firstRecordId: records[0]?.id ?? null,
  };
}

/** Ключ операции запроса для кнопки «Открыть операцию». */
export interface OperationKey {
  type: string;
  name: string | null;
  value: string;
  /** Последние 4 символа. */
  short: string;
  /** Маскирование изменило значение: «id скрыт маскированием», искать нельзя. */
  masked: boolean;
}

const MAX_KEYS = 3;

/**
 * Ключи операций потока по немаскированным записям с разметкой: id вида «операция» входа, затем обменов по порядку.
 * Id разных типов на одном шаге — ключи одной операции; поток с несколькими значениями одного типа даёт столько же ключей.
 * Не больше трёх значений. keep — correlation_id и request_id: их маскирование не трогает.
 */
export function operationKeysOf(records: readonly ViewRecord[], keep: ReadonlySet<string> = new Set()): OperationKey[] {
  const out: OperationKey[] = [];
  const seen = new Set<string>();
  const ordered = [...records.filter((r) => r.kind === 'incoming'), ...records.filter((r) => r.kind !== 'incoming')];
  for (const r of ordered) {
    for (const id of catalogOf(r)?.ids ?? []) {
      if (id.kind !== 'operation') continue;
      const k = idKey(id.type, id.value);
      if (seen.has(k)) continue;
      seen.add(k);
      // Значение скрыто и при чтении поля (maskField уже заменил его): хвост скрытого значения наружу не идёт.
      const masked = id.value.includes('*') || maskText(id.value, keep) !== id.value;
      out.push({ type: id.type, name: id.name, value: id.value, short: masked ? '' : shortId(id.value), masked });
      if (out.length >= MAX_KEYS) return out;
    }
  }
  return out;
}
