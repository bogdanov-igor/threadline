// Граф потока из шагов трассы и разметки записей.
// Интервалы для параллельности граф считает сам по записям, а не берёт startMs/endMs трассы.
import type { FlowHint, ViewRecord } from '../search/api.ts';
import { hostOf } from '../catalog/host.ts';
import { businessError } from '../search/business.ts';
import { withoutHtmlShown } from '../search/html-text.ts';
import { withoutCredentials } from '../search/masking.ts';
import type { Trace, TraceStep } from '../search/trace.ts';
import { applyBudget } from './budget.ts';
import { catalogOf, idKey, shortId, type FlowCatalogId, type FlowCatalogMarkup, type FlowCatalogStatus } from './catalog.ts';
import {
  DB_WARN_MS,
  MAX_LANES,
  OVERLAP_TOLERANCE_MS,
  PAUSE_MIN_MS,
  PAUSE_NODE_MS,
  type FlowContainer,
  type FlowEdge,
  type FlowEdgeKind,
  type FlowGraph,
  type FlowGroup,
  type FlowMark,
  type FlowNode,
  type FlowOptions,
  type FlowOutcome,
  type GroupKind,
} from './model.ts';
import { attachRelated } from './related.ts';
import { rpcAction } from '../catalog/rpc.ts';

/** Подсказка шага из профиля формата (ViewRecord.flow). */
export type StepHint = FlowHint;

/** Единица последовательности: узел или группа с интервалом для сравнения. */
export interface Unit {
  node: FlowNode;
  start: number;
  end: number;
  /** Порядок первого шага в трассе: при равном начале. */
  order: number;
  retryKey: string | null;
  pollKey: string | null;
  errorKey: string | null;
  /** Ошибка или обмен без ответа: «неудачная попытка». */
  failed: boolean;
  /** Узел начала операции: от него ребро опроса. */
  asyncStart: boolean;
}

/** Параллельный участок: ветки по порядку первого начала. */
export interface Lanes {
  lanes: Item[][];
  start: number;
  end: number;
  order: number;
}

export type Item = Unit | Lanes;
export const isLanes = (i: Item): i is Lanes => 'lanes' in i;

export interface Builder {
  nodes: Record<string, FlowNode>;
  /** Родитель узла: группа, в которой он лежит. */
  parent: Map<string, string>;
  totalMs: number;
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;
const WARN_LEVELS = new Set(['WARNING', 'WARN', 'NOTICE']);
const ERROR_LEVELS = new Set(['ERROR', 'ERR', 'CRITICAL', 'CRIT', 'ALERT', 'EMERGENCY', 'FATAL']);

/** Путь адреса без хоста и строки запроса. */
export function pathOfUri(uri: string | null): string | null {
  if (!uri) return null;
  const rest = withoutCredentials(uri);
  const path = rest.startsWith('/') ? rest : rest.replace(/^[^/?#]*/, '');
  return path.replace(/[?#].*$/s, '') || '/';
}

/** Подсказка шага записи, если профиль её дал. */
export function hintOf(r: ViewRecord): StepHint | null {
  const f: unknown = r.flow;
  if (typeof f !== 'object' || f === null) return null;
  const h = f as Partial<StepHint>;
  if (h.as !== 'db' && h.as !== 'wait') return null;
  return {
    as: h.as,
    durationMs: typeof h.durationMs === 'number' && Number.isFinite(h.durationMs) ? h.durationMs : null,
    host: typeof h.host === 'string' ? h.host : null,
    title: typeof h.title === 'string' ? h.title : null,
  };
}

/** Текст бизнес-ошибки тела без служебной приставки «response_code 8: …». */
function bodyReason(body: string | null): string | null {
  const text = body ? businessError(body) : null;
  return text === null ? null : (/^[\w.]+ [^:]{1,40}: (.+)$/s.exec(text)?.[1] ?? text);
}

const emptyOutcome = (): FlowOutcome => ({ tone: 'none', reason: null, http: null, noResponse: false, pending: false, noSend: false });

export function newNode(id: string, over: Partial<FlowNode> & Pick<FlowNode, 'kind' | 'name'>): FlowNode {
  return {
    id,
    entry: null,
    stepIds: [],
    logIds: [],
    tech: '',
    plain: null,
    path: null,
    component: null,
    startMs: 0,
    endMs: 0,
    durationMs: null,
    share: 0,
    outcome: emptyOutcome(),
    mark: null,
    unread: false,
    opStatus: null,
    badges: { total: 0, warning: 0, error: 0 },
    opKey: null,
    group: null,
    lane: 0,
    laneCount: 0,
    block: null,
    select: null,
    related: null,
    ...over,
  } as FlowNode;
}

/** Итог обмена: правило итога и отметка справочника, затем общие признаки ошибки. */
function exchangeOutcome(step: TraceStep, send: ViewRecord | null, resp: ViewRecord | null, cs: FlowCatalogMarkup | null, cr: FlowCatalogMarkup | null): FlowOutcome {
  const o = emptyOutcome();
  o.http = resp?.http?.status ?? null;
  o.noSend = !send && !!resp;
  if (send && !resp) {
    o.noResponse = true;
    o.pending = send.http?.pending ?? step.pending;
    o.tone = o.pending ? 'pending' : 'error';
    return o;
  }
  const rule = cr?.outcome ?? null;
  if (rule) {
    if (rule.kind === 'error') {
      o.tone = 'error';
      o.reason = rule.text ?? cr?.error?.title ?? bodyReason(resp?.sections.body ?? null) ?? (o.http !== null ? `HTTP ${o.http}` : null);
    } else o.tone = rule.kind === 'pending' ? 'pending' : 'success';
    return o;
  }
  const err = cr?.error ?? cs?.error ?? null;
  if (step.isError && err?.severity !== 'ok') {
    o.tone = 'error';
    o.reason = err?.title ?? bodyReason(resp?.sections.body ?? null) ?? (o.http !== null && o.http >= 400 ? `HTTP ${o.http}` : null);
  } else o.tone = 'success';
  return o;
}

function opIds(...marks: (FlowCatalogMarkup | null)[]): FlowCatalogId[] {
  const out: FlowCatalogId[] = [];
  const seen = new Set<string>();
  for (const m of marks) {
    for (const id of m?.ids ?? []) {
      const k = idKey(id.type, id.value);
      if (id.kind !== 'operation' || seen.has(k)) continue;
      seen.add(k);
      out.push(id);
    }
  }
  return out;
}

const opKeyOf = (id: FlowCatalogId | undefined) => (id ? { type: id.type, name: id.name, short: shortId(id.value) } : null);

/**
 * Граф потока. trace — buildTrace(records); records — записи запроса как их отдаёт API (маскированные, с разметкой).
 * Одинаковые записи дают одинаковый граф: порядок — по началу, при равенстве — по трассе.
 */
export function buildFlowGraph(trace: Trace, records: readonly ViewRecord[], opts: FlowOptions): FlowGraph {
  const byId = new Map(records.map((r) => [r.id, r]));
  const order = new Map(trace.steps.map((s, i) => [s.id, i]));
  const off = (r: ViewRecord) => Math.max(0, r.offsetMs ?? round3(r.timeMs - trace.startTimeMs));
  const b: Builder = { nodes: {}, parent: new Map(), totalMs: trace.totalMs };
  const add = (n: FlowNode) => {
    b.nodes[n.id] = n;
    return n;
  };
  const share = (d: number | null) => (d === null || trace.totalMs <= 0 ? 0 : Math.min(1, Math.max(0, d / trace.totalMs)));

  const entryStep = trace.steps.find((s) => s.kind === 'incoming' && s.parentId === null) ?? null;
  const hasCalls = trace.steps.some((s) => s.kind === 'call' || s.kind === 'exchange');

  // ---------- Вход ----------
  let entry: FlowNode;
  if (entryStep) {
    const r = byId.get(entryStep.recordIds[0]!) ?? null;
    const c = r ? catalogOf(r) : null;
    const method = c?.name?.method ?? null;
    const variant = method?.kind === 'callback' ? 'callback' : r?.gateway ? 'gateway' : 'request';
    const ids = opIds(c);
    const status = c?.status ?? null;
    entry = add(
      newNode(entryStep.id, {
        kind: 'entry',
        entry: variant,
        stepIds: [entryStep.id],
        select: entryStep.id,
        name: method?.name ?? 'Вход',
        ...(method?.name ? {} : { fallbackName: 'entry' as const }),
        tech: `${r?.http?.method ?? ''} ${pathOfUri(r?.http?.uri ?? null) ?? ''}`.trim() || entryStep.title,
        plain: null,
        path: pathOfUri(r?.http?.uri ?? null),
        component: r?.component ?? null,
        startMs: 0,
        endMs: trace.totalMs,
        durationMs: trace.totalMs,
        share: 1,
        opKey: opKeyOf(ids[0]),
        opStatus: status ? { status, claimed: variant === 'callback' } : null,
        // У колбэка внешняя система сама сообщает итог: про ответ из базы или кэша здесь речи нет.
        mark: hasCalls || variant === 'callback' ? null : { kind: 'no-calls' },
      }),
    );
  } else {
    const comp = records.find((r) => !r.gateway && r.component)?.component ?? null;
    entry = add(
      newNode('entry', {
        kind: 'entry',
        entry: 'background',
        name: comp ? `Фоновый запуск · ${comp}` : 'Фоновый запуск',
        tech: comp ?? '',
        component: comp,
        endMs: trace.totalMs,
        durationMs: trace.totalMs,
        share: 1,
      }),
    );
  }

  // ---------- Обмены и вызовы ----------
  interface Ex {
    step: TraceStep;
    send: ViewRecord | null;
    resp: ViewRecord | null;
    cs: FlowCatalogMarkup | null;
    cr: FlowCatalogMarkup | null;
    action: string;
    start: number;
    end: number;
  }
  const exOf = (s: TraceStep): Ex => {
    const first = byId.get(s.recordIds[0]!) ?? null;
    const second = s.recordIds[1] ? (byId.get(s.recordIds[1]) ?? null) : null;
    const send = first?.kind === 'send' ? first : null;
    const resp = first?.kind === 'response' ? first : second;
    const start = first ? off(first) : s.startMs;
    const end = send && resp ? Math.max(start, off(resp)) : start;
    const sendAction = (r: ViewRecord) => rpcAction(r.sections.body);
    const respAction = (r: ViewRecord) => rpcAction(r.sections.body, { response: true });
    const action = send ? sendAction(send) || (resp ? respAction(resp) : '') : resp ? respAction(resp) : '';
    return { step: s, send, resp, cs: send ? catalogOf(send) : null, cr: resp ? catalogOf(resp) : null, action, start, end };
  };

  const exchangeUnit = (e: Ex): Unit => {
    const sys = e.cs?.name?.system ?? e.cr?.name?.system ?? null;
    const method = e.cs?.name?.method ?? e.cr?.name?.method ?? null;
    const uri = e.send?.http?.uri ?? e.resp?.http?.uri ?? null;
    const outcome = exchangeOutcome(e.step, e.send, e.resp, e.cs, e.cr);
    const ids = opIds(e.cs, e.cr);
    const status: FlowCatalogStatus | null = e.cr?.status ?? e.cs?.status ?? null;
    const asyncStart = method?.kind === 'start' && ids.length > 0;
    const issued = ids.find((i) => i.at === 'response') ?? ids[0];
    const durationMs = e.send && e.resp ? (e.resp.http?.durationMs ?? round3(e.end - e.start)) : e.resp ? 0 : null;
    const name = sys?.name ?? hostOf(uri) ?? e.step.title;
    // Вид для Бизнеса: у обмена без названия только система. Другой вызов той же системы от повтора не отличить, такие шаги не сливаются.
    const nameless = !method && !e.action && !e.step.title;
    const node = add(
      newNode(e.step.id, {
        kind: asyncStart ? 'async-start' : 'exchange',
        stepIds: [e.step.id],
        select: e.step.id,
        name,
        tech: e.step.title,
        plain: method?.name ?? null,
        path: nameless ? null : pathOfUri(uri),
        component: hostOf(uri),
        startMs: e.start,
        endMs: e.end,
        durationMs,
        share: share(durationMs),
        outcome,
        mark: asyncStart && issued ? { kind: 'issued', short: shortId(issued.value) } : null,
        opStatus: status ? { status, claimed: false } : null,
        opKey: opKeyOf(ids[0]),
      }),
    );
    const pollId = method?.kind === 'status' ? ids[0] : undefined;
    return {
      node,
      start: e.start,
      end: e.end,
      order: order.get(e.step.id) ?? 0,
      retryKey: asyncStart || nameless ? null : `${sys?.key ?? hostOf(uri) ?? ''}|${method ? `m${method.id}` : `${e.send?.http?.method ?? e.resp?.http?.method ?? ''} ${pathOfUri(uri) ?? ''}`}|${e.action}`,
      pollKey: pollId ? idKey(pollId.type, pollId.value) : null,
      errorKey: outcome.tone === 'error' ? `${name}|${method?.name ?? e.step.title}|${outcome.reason ?? (outcome.noResponse ? 'no-response' : '')}` : null,
      failed: outcome.tone === 'error',
      asyncStart,
    };
  };

  /** Записи вызова: действие — заголовок записи вызова (context.action). */
  const callAction = (s: TraceStep) => (byId.get(s.recordIds[0]!)?.title ?? '').trim();
  const callSystemKey = (s: TraceStep) => {
    const r = byId.get(s.recordIds[0]!);
    return r ? (catalogOf(r)?.name?.system?.key ?? null) : null;
  };
  const owns = (call: TraceStep, e: Ex) => {
    const action = callAction(call);
    if (action !== '' && e.action !== '' && action === e.action) return true;
    // Вид для Бизнеса: имён действий нет, вызов и его обмен связывает request_id, как в трассе.
    if (action === '' && e.action === '') {
      const id = byId.get(call.recordIds[0]!)?.requestId ?? null;
      if (id !== null && id === (e.send ?? e.resp)?.requestId) return true;
    }
    const sys = callSystemKey(call);
    const exSys = e.cs?.name?.system?.key ?? e.cr?.name?.system?.key ?? null;
    return sys !== null && exSys !== null && sys === exSys;
  };

  const steps = trace.steps.filter((s) => s !== entryStep);
  const sortKey = (s: TraceStep) => {
    const r = byId.get(s.recordIds[0]!);
    return r ? off(r) : s.startMs;
  };
  const sorted = [...steps].sort((x, y) => sortKey(x) - sortKey(y) || (order.get(x.id) ?? 0) - (order.get(y.id) ?? 0));

  const units: Unit[] = [];
  const logs: TraceStep[] = [];
  let open: { call: TraceStep; owned: Ex[] } | null = null;
  const calls: { call: TraceStep; owned: Ex[] }[] = [];
  const standalone: Ex[] = [];
  const others: TraceStep[] = [];
  for (const s of sorted) {
    if (s.kind === 'log') {
      const r = byId.get(s.recordIds[0]!);
      if (r && hintOf(r)) others.push(s);
      else logs.push(s);
      continue;
    }
    if (s.kind === 'call') {
      open = { call: s, owned: [] };
      calls.push(open);
      continue;
    }
    if (s.kind === 'exchange') {
      const e = exOf(s);
      if (open && owns(open.call, e)) {
        open.owned.push(e);
        continue;
      }
      open = null;
      standalone.push(e);
      continue;
    }
    // Второй вход внутри запроса закрывает вызов и идёт отдельным узлом.
    open = null;
    others.push(s);
  }

  redistributeCalls(calls, (a, x) => owns(a, x), (id) => order.get(id) ?? 0);

  for (const e of standalone) units.push(exchangeUnit(e));

  for (const { call, owned } of calls) {
    const r = byId.get(call.recordIds[0]!) ?? null;
    const action = callAction(call);
    const start = r ? off(r) : call.startMs;
    const ord = order.get(call.id) ?? 0;
    if (owned.length === 0) {
      const c = r ? catalogOf(r) : null;
      const node = add(
        newNode(call.id, {
          kind: 'fn',
          stepIds: [call.id],
          select: call.id,
          name: c?.name?.system?.name ?? (withoutHtmlShown(r?.message ?? '') || action || call.title),
          tech: action || call.title,
          plain: c?.name?.method?.name ?? (action || null),
          component: r?.component ?? null,
          startMs: start,
          endMs: start,
        }),
      );
      units.push({ node, start, end: start, order: ord, retryKey: null, pollKey: null, errorKey: null, failed: false, asyncStart: false });
      continue;
    }
    const exUnits = owned.map(exchangeUnit);
    // Конец вызова — максимум концов своих обменов; обмен без ответа даёт своё начало.
    const end = Math.max(start, ...exUnits.map((u) => u.end));
    if (exUnits.length === 1) {
      // Вызов с одним обменом — один узел: система в имени, действие в строке метода.
      const u = exUnits[0]!;
      const x = u.node;
      delete b.nodes[x.id];
      const node = add({
        ...x,
        id: call.id,
        kind: 'fn',
        stepIds: [call.id, ...x.stepIds],
        select: x.select,
        tech: [action, x.path].filter((t) => t).join(' · ') || x.tech,
        plain: x.plain ?? (action || null),
        startMs: start,
        endMs: end,
      });
      units.push({ ...u, node, start, end, order: ord, retryKey: null, pollKey: null });
      continue;
    }
    const failed = exUnits.filter((u) => u.failed).length;
    // Перекрытые обмены вызова — ветки, а не цепочка повторов.
    const inner = splitLanes(b, [...exUnits].sort((x, y) => x.start - y.start || x.order - y.order));
    const node = makeGroup(b, 'call', exUnits, {
      id: `g:${call.id}`,
      ownSteps: [call.id],
      tech: action || exUnits[0]!.node.tech,
      mark: { kind: 'call', count: exUnits.length, failed },
      ...(inner.length < exUnits.length ? { sequence: inner } : {}),
    });
    node.startMs = start;
    node.endMs = end;
    units.push({ node, start, end, order: ord, retryKey: null, pollKey: null, errorKey: groupErrorKey(exUnits), failed: failed > 0, asyncStart: false });
  }

  for (const s of others) {
    const r = byId.get(s.recordIds[0]!) ?? null;
    const at = r ? off(r) : s.startMs;
    const ord = order.get(s.id) ?? 0;
    const hint = r ? hintOf(r) : null;
    if (s.kind === 'incoming' || !hint) {
      const node = add(
        newNode(s.id, {
          kind: 'entry',
          entry: r?.gateway ? 'gateway' : 'request',
          stepIds: [s.id],
          select: s.id,
          name: 'Вход',
          fallbackName: 'entry',
          tech: s.title,
          path: pathOfUri(r?.http?.uri ?? null),
          component: r?.component ?? null,
          startMs: at,
          endMs: at,
        }),
      );
      units.push({ node, start: at, end: at, order: ord, retryKey: null, pollKey: null, errorKey: null, failed: false, asyncStart: false });
      continue;
    }
    const c = r ? catalogOf(r) : null;
    const db = hint.as === 'db';
    const sys = c?.name?.system;
    // Обращение к базе с уровнем ERROR: узел красный с причиной, как обмен с ошибкой.
    const dbFailed = db && !!r?.isError && c?.error?.severity !== 'ok';
    const dbReason = dbFailed ? (c?.error?.title ?? r?.title ?? null) : null;
    const node = add(
      newNode(s.id, {
        kind: hint.as,
        stepIds: [s.id],
        select: s.id,
        name: db ? (sys?.name ?? 'База данных') : 'Ожидание',
        ...(!db ? { fallbackName: 'wait' as const } : sys?.name ? {} : { fallbackName: 'db' as const }),
        tech: s.title,
        plain: hint.title,
        component: hint.host ?? r?.component ?? null,
        startMs: at,
        endMs: at,
        durationMs: hint.durationMs,
        share: share(hint.durationMs),
        outcome: dbFailed
          ? { ...emptyOutcome(), tone: 'error', reason: dbReason }
          : { ...emptyOutcome(), tone: db && hint.durationMs !== null && hint.durationMs > DB_WARN_MS ? 'warning' : 'none' },
      }),
    );
    // Ожидание и база в ветки не делят: нулевой интервал в точке записи.
    units.push({ node, start: at, end: at, order: ord, retryKey: null, pollKey: null, errorKey: dbFailed ? `${node.name}|${dbReason ?? ''}` : null, failed: dbFailed, asyncStart: false });
  }

  units.sort((x, y) => x.start - y.start || x.order - y.order);

  // ---------- Отрезки и ветки ----------
  const items = groupSequence(b, splitLanes(b, units));

  // ---------- Счётчики логов ----------
  assignLogs(b, entry, units, logs, byId, off);

  // ---------- Бюджет, связанные потоки, рёбра ----------
  const root: FlowContainer = { nodes: [], edges: [] };
  const budgeted = applyBudget(b, entry, items, opts.related.length);
  // Первая запись потока — начало отсчёта: пауза до первого шага подписана, как между шагами.
  linkSequence(b, root, budgeted, { from: entry.id, end: 0 });
  root.nodes.unshift(entry.id);
  attachRelated(b, root, entry, opts.related, trace.startTimeMs);

  if (opts.incomplete) {
    const last = lastNode(b, root);
    if (last) last.unread = true;
  }

  return { nodes: b.nodes, root, totalMs: trace.totalMs, steps: trace.steps.length, incomplete: opts.incomplete === true };
}

/** Интервалы единиц пересекаются: обмены идут параллельно, а не друг за другом. */
function overlapping<T extends { start: number; end: number }>(list: readonly T[]): boolean {
  const sorted = [...list].sort((x, y) => x.start - y.start);
  let maxEnd = -Infinity;
  for (const u of sorted) {
    if (u.start < maxEnd - OVERLAP_TOLERANCE_MS) return true;
    maxEnd = Math.max(maxEnd, u.end);
  }
  return false;
}

/**
 * Вызовы, записанные подряд перед перекрытыми обменами: «вызов, вызов, отправка, отправка». Цепочка отдаёт все обмены
 * последнему вызову, а первые остаются пустыми. Перекрытые обмены раздаются таким вызовам по порядку, лишние — последнему.
 */
function redistributeCalls<E extends { start: number; end: number }>(
  calls: { call: TraceStep; owned: E[] }[],
  owns: (call: TraceStep, e: E) => boolean,
  position: (id: string) => number,
): void {
  for (let i = 0; i < calls.length; i++) {
    const c = calls[i]!;
    if (c.owned.length < 2 || !overlapping(c.owned)) continue;
    let j = i;
    while (j > 0 && calls[j - 1]!.owned.length === 0 && position(calls[j]!.call.id) - position(calls[j - 1]!.call.id) === 1 && owns(calls[j - 1]!.call, c.owned[0]!)) j--;
    if (j === i) continue;
    const targets = calls.slice(j, i + 1);
    const list = c.owned;
    c.owned = [];
    list.forEach((e, k) => targets[Math.min(k, targets.length - 1)]!.owned.push(e));
  }
}

function groupErrorKey(units: readonly Unit[]): string | null {
  return units.find((u) => u.errorKey)?.errorKey ?? null;
}

/** Последний по началу узел корня, кроме слияний и ссылок на потоки. */
function lastNode(b: Builder, root: FlowContainer): FlowNode | null {
  let last: FlowNode | null = null;
  for (const id of root.nodes) {
    const n = b.nodes[id]!;
    if (n.kind === 'junction' || n.kind === 'pause' || n.kind === 'flow-ref') continue;
    if (!last || n.startMs >= last.startMs) last = n;
  }
  return last;
}

// ---------- Ветки ----------

/** Отрезки пересекающихся интервалов; отрезок из нескольких единиц — ветки, жадно по концу. */
export function splitLanes(b: Builder, units: readonly Unit[]): Item[] {
  const out: Item[] = [];
  let i = 0;
  while (i < units.length) {
    const seg: Unit[] = [units[i]!];
    // Шаг нулевой длины ни с чем не пересекается: ветка ему не нужна, он идёт в цепочке за участком.
    const instant: Unit[] = [];
    let maxEnd = units[i]!.end;
    let j = i + 1;
    while (j < units.length && units[j]!.start < maxEnd - OVERLAP_TOLERANCE_MS) {
      const u = units[j]!;
      if (u.end - u.start <= OVERLAP_TOLERANCE_MS) instant.push(u);
      else {
        seg.push(u);
        maxEnd = Math.max(maxEnd, u.end);
      }
      j++;
    }
    i = j;
    if (seg.length === 1) {
      out.push(seg[0]!, ...instant);
      continue;
    }
    const lanes: { units: Unit[]; end: number }[] = [];
    for (const u of seg) {
      const lane = lanes.find((l) => l.end <= u.start + OVERLAP_TOLERANCE_MS);
      if (lane) {
        lane.units.push(u);
        lane.end = Math.max(lane.end, u.end);
      } else lanes.push({ units: [u], end: u.end });
    }
    const start = seg[0]!.start;
    const order = seg[0]!.order;
    if (lanes.length > MAX_LANES) {
      // Упавшие ветки попадают в видимые раньше успешных; на экране ветки идут по порядку начала.
      const failed = (l: { units: Unit[] }) => (l.units.some((u) => u.failed) ? 1 : 0);
      const ranked = lanes.map((l, at) => ({ l, at })).sort((x, y) => failed(y.l) - failed(x.l) || x.at - y.at);
      const byStart = (list: typeof ranked) => [...list].sort((x, y) => x.at - y.at).map((x) => x.l.units);
      const rest = parallelGroup(b, byStart(ranked.slice(MAX_LANES)));
      out.push({ lanes: [...byStart(ranked.slice(0, MAX_LANES)), [rest]], start, end: maxEnd, order }, ...instant);
      continue;
    }
    out.push({ lanes: lanes.map((l) => l.units), start, end: maxEnd, order }, ...instant);
  }
  return out;
}

/** Ветки сверх трёх видимых: одна группа «Ещё N параллельных» на любой ширине. */
function parallelGroup(b: Builder, lanes: Unit[][]): Unit {
  const all = lanes.flat();
  const start = Math.min(...all.map((u) => u.start));
  const end = Math.max(...all.map((u) => u.end));
  const order = Math.min(...all.map((u) => u.order));
  const grouped = lanes.map((l) => groupSequence(b, l) as Unit[]);
  const failed = all.filter((u) => u.failed).length;
  const first = all[0]!;
  const node = makeGroup(b, 'parallel', grouped.flat(), {
    id: `g:${first.node.id}`,
    name: `Ещё ${lanes.length} параллельных`,
    tech: first.node.tech,
    mark: { kind: 'parallel', count: lanes.length },
    lanes: grouped,
  });
  node.startMs = start;
  node.endMs = end;
  return { node, start, end, order, retryKey: null, pollKey: null, errorKey: groupErrorKey(all), failed: failed > 0, asyncStart: false };
}

// ---------- Группы ----------

interface GroupSpec {
  id: string;
  ownSteps?: string[];
  name?: string;
  tech?: string;
  mark: FlowMark;
  /** У параллельной группы — ветки внутри рамки. */
  lanes?: Unit[][];
  /** Своя последовательность с развилками: у вызова с перекрытыми обменами. */
  sequence?: Item[];
}

const uniqueId = (b: Builder, id: string) => {
  let out = id;
  while (b.nodes[out]) out = `g:${out}`;
  return out;
};

/** Узел-группа над единицами: представитель — первая ошибка, иначе последняя. */
export function makeGroup(b: Builder, kind: GroupKind, units: readonly Unit[], spec: GroupSpec): FlowNode {
  const id = uniqueId(b, spec.id);
  const errorUnit = units.find((u) => u.node.outcome.tone === 'error' || u.failed);
  const last = units[units.length - 1]!;
  const rep = errorUnit ?? last;
  const representative = representativeStep(b, rep.node);
  // Цвет повторов и опроса — по последней попытке; ошибок подряд, вызова и прочих — по первой ошибке.
  const toneSource = kind === 'retry' || kind === 'poll' ? last : rep;
  const errors = units.reduce((n, u) => n + errorCount(b, u.node), 0);
  const children: FlowContainer = { nodes: [], edges: [] };
  const node = newNode(id, {
    kind: 'group',
    stepIds: spec.ownSteps ?? [],
    select: representative,
    name: spec.name ?? rep.node.name,
    ...(spec.name === undefined && rep.node.fallbackName ? { fallbackName: rep.node.fallbackName } : {}),
    tech: spec.tech ?? rep.node.tech,
    plain: rep.node.plain,
    path: rep.node.path,
    component: rep.node.component,
    startMs: units[0]!.start,
    endMs: Math.max(...units.map((u) => u.end)),
    outcome: { ...toneSource.node.outcome },
    mark: spec.mark,
    opKey: units.find((u) => u.node.opKey)?.node.opKey ?? null,
    opStatus: [...units].reverse().find((u) => u.node.opStatus)?.node.opStatus ?? null,
  });
  if (kind === 'more' || kind === 'parallel' || kind === 'call') {
    if (errors > 0 && node.outcome.tone !== 'error') node.outcome = { ...(errorUnit?.node.outcome ?? node.outcome), tone: 'error' };
  }
  node.durationMs = round3(node.endMs - node.startMs);
  node.share = b.totalMs > 0 ? Math.min(1, node.durationMs / b.totalMs) : 0;
  const group: FlowGroup = {
    kind,
    count: kind === 'parallel' && spec.lanes ? spec.lanes.length : units.length,
    failed: units.filter((u) => u.failed).length,
    errors,
    representative,
    children,
    cost: 0,
  };
  node.group = group;
  b.nodes[id] = node;
  if (spec.sequence) {
    linkSequence(b, children, spec.sequence, { from: null, end: null });
    for (const c of children.nodes) b.parent.set(c, id);
  } else if (spec.lanes) {
    spec.lanes.forEach((lane, i) => {
      let prev: string | null = null;
      let prevEnd = 0;
      for (const u of lane) {
        u.node.lane = i + 1;
        u.node.block = id;
        children.nodes.push(u.node.id);
        b.parent.set(u.node.id, id);
        if (prev) children.edges.push(edge(prev, u.node.id, 'next', pauseHint(u.start - prevEnd)));
        prev = u.node.id;
        prevEnd = u.end;
      }
    });
    children.nodes.sort((x, y) => b.nodes[x]!.startMs - b.nodes[y]!.startMs || b.nodes[x]!.lane - b.nodes[y]!.lane);
  } else {
    let prev: Unit | null = null;
    for (const u of units) {
      if (prev) {
        const k: FlowEdgeKind = kind === 'poll' ? 'poll' : kind === 'retry' || prev.retryKey === u.retryKey ? 'retry' : 'next';
        // Повторы, опрос и ошибки подряд показаны списком: пауза перед попыткой подписана в нём. У вызова рамка раскрывается.
        if (kind === 'call') connect(b, children, prev.node.id, u, k, u.start - prev.end);
        else children.edges.push(edge(prev.node.id, u.node.id, k, pauseHint(u.start - prev.end)));
      }
      children.nodes.push(u.node.id);
      b.parent.set(u.node.id, id);
      prev = u;
    }
  }
  group.cost = children.nodes.length;
  for (const c of children.nodes) if (!b.parent.has(c)) b.parent.set(c, id);
  return node;
}

/** Шаг, который выбирает клик по узлу: у группы — её представитель. */
export function representativeStep(b: Builder, n: FlowNode): string {
  if (n.group) return n.group.representative;
  return n.select ?? n.stepIds[0] ?? n.id;
}

function errorCount(b: Builder, n: FlowNode): number {
  if (n.group) return n.group.errors;
  return n.outcome.tone === 'error' ? 1 : 0;
}

/** Повторы, опросы и ошибки подряд в одной последовательности (основная линия или ветка). */
export function groupSequence(b: Builder, items: readonly Item[]): Item[] {
  const out: Item[] = [];
  let i = 0;
  const unitAt = (k: number): Unit | null => {
    const it = items[k];
    return it && !isLanes(it) && !it.node.group ? it : null;
  };
  while (i < items.length) {
    const it = items[i]!;
    if (isLanes(it)) {
      out.push({ ...it, lanes: it.lanes.map((l) => groupSequence(b, l)) });
      i++;
      continue;
    }
    const u = unitAt(i);
    if (!u) {
      out.push(it);
      i++;
      continue;
    }
    const run = (same: (x: Unit) => boolean) => {
      let j = i + 1;
      while (unitAt(j) && same(unitAt(j)!)) j++;
      return j;
    };
    if (u.pollKey) {
      const j = run((x) => x.pollKey === u.pollKey);
      if (j - i >= 2) {
        const polls = items.slice(i, j) as Unit[];
        const last = polls[polls.length - 1]!;
        const status = [...polls].reverse().find((p) => p.node.opStatus)?.node.opStatus?.status ?? null;
        const node = makeGroup(b, 'poll', polls, { id: `g:${u.node.id}`, mark: { kind: 'poll', count: polls.length, status } });
        out.push({ node, start: u.start, end: Math.max(...polls.map((p) => p.end)), order: u.order, retryKey: null, pollKey: u.pollKey, errorKey: last.errorKey, failed: last.failed, asyncStart: false });
        i = j;
        continue;
      }
    }
    if (u.retryKey) {
      const j = run((x) => x.retryKey === u.retryKey && !x.pollKey);
      if (j - i >= 2) {
        const tries = items.slice(i, j) as Unit[];
        const last = tries[tries.length - 1]!;
        const failed = tries.filter((t) => t.failed).length;
        const node = makeGroup(b, 'retry', tries, { id: `g:${u.node.id}`, mark: { kind: 'retry', count: tries.length, failed } });
        out.push({ node, start: u.start, end: Math.max(...tries.map((t) => t.end)), order: u.order, retryKey: u.retryKey, pollKey: null, errorKey: last.errorKey, failed: last.failed, asyncStart: false });
        i = j;
        continue;
      }
    }
    if (u.errorKey) {
      const j = run((x) => x.errorKey === u.errorKey);
      if (j - i >= 2) {
        const errs = items.slice(i, j) as Unit[];
        const node = makeGroup(b, 'errors', errs, {
          id: `g:${u.node.id}`,
          mark: { kind: 'errors', count: errs.length, firstMs: u.start, lastMs: errs[errs.length - 1]!.start },
        });
        out.push({ node, start: u.start, end: Math.max(...errs.map((e) => e.end)), order: u.order, retryKey: null, pollKey: null, errorKey: u.errorKey, failed: true, asyncStart: false });
        i = j;
        continue;
      }
    }
    out.push(u);
    i++;
  }
  return out;
}

// ---------- Рёбра ----------

export function edge(source: string, target: string, kind: FlowEdgeKind, hint: FlowEdge['hint'] = null): FlowEdge {
  return { id: `${kind}:${source}>${target}`, source, target, kind, hint };
}

/** Подпись ребра: пауза от миллисекунды и короче минуты. Длиннее — отдельный узел, connect. */
export function pauseHint(gapMs: number): FlowEdge['hint'] {
  return gapMs >= PAUSE_MIN_MS && gapMs < PAUSE_NODE_MS ? { kind: 'pause', ms: round3(gapMs) } : null;
}

/** Узел долгой паузы перед target; его рёбра идут через него. Шагов в нём нет, бюджет шагов он не считает. */
function pauseNode(b: Builder, into: FlowContainer, from: string, target: string, startMs: number, gapMs: number, kind: FlowEdgeKind): string {
  const id = `p:${target}`;
  b.nodes[id] = newNode(id, { kind: 'pause', name: '', startMs, endMs: startMs + gapMs, durationMs: round3(gapMs) });
  into.nodes.push(id);
  into.edges.push(edge(from, id, kind));
  return id;
}

/** Ребро от шага к следующему шагу той же ветки: с подписью паузы, от минуты через узел «Пауза». Узел цели ставит вызывающий. */
function connect(b: Builder, into: FlowContainer, from: string, to: Unit, kind: FlowEdgeKind, gapMs: number): void {
  if (gapMs < PAUSE_NODE_MS) {
    into.edges.push(edge(from, to.node.id, kind, pauseHint(gapMs)));
    return;
  }
  const pause = pauseNode(b, into, from, to.node.id, to.start - gapMs, gapMs, kind);
  into.edges.push(edge(pause, to.node.id, kind));
}

const itemStart = (i: Item) => i.start;
const itemEnd = (i: Item) => i.end;

/**
 * Узлы и рёбра последовательности в контейнер. prev — узел перед ней; end — конец предыдущего шага для паузы
 * (null — от входа паузу не подписываем). Возвращает последний узел и его конец.
 */
export function linkSequence(
  b: Builder,
  into: FlowContainer,
  items: readonly Item[],
  prev: { from: string | null; end: number | null },
): { from: string | null; end: number | null } {
  let from = prev.from;
  let end = prev.end;
  let asyncPrev = false;
  for (const it of items) {
    if (!isLanes(it)) {
      if (from) {
        const poll = asyncPrev && it.node.group?.kind === 'poll';
        if (end === null) into.edges.push(edge(from, it.node.id, poll ? 'poll' : 'next'));
        else connect(b, into, from, it, poll ? 'poll' : 'next', it.start - end);
      }
      into.nodes.push(it.node.id);
      from = it.node.id;
      end = it.end;
      asyncPrev = it.asyncStart;
      continue;
    }
    const lanes = it.lanes.map((l) => l.filter((u): u is Unit => !isLanes(u))).filter((l) => l.length > 0);
    const jid = `j:${lanes[0]![0]!.node.id}`;
    const tails: string[] = [];
    const block: Unit[] = [];
    // Значок на рамке считает и свёрнутые ветки: «Ещё N параллельных» — это N веток.
    const rest = lanes.at(-1)!.find((u) => u.node.group?.kind === 'parallel');
    const laneCount = lanes.length + (rest ? rest.node.group!.count - 1 : 0);
    // Долгая пауза перед развилкой — узел, рёбра к веткам идут уже от него.
    if (from && end !== null && it.start - end >= PAUSE_NODE_MS) from = pauseNode(b, into, from, jid, end, it.start - end, 'next');
    lanes.forEach((lane, li) => {
      const head = lane[0]!;
      if (from) into.edges.push(edge(from, head.node.id, 'fork', li === 0 ? { kind: 'parallel', count: lanes.length } : null));
      let laneFrom: string | null = null;
      let laneEnd = 0;
      for (const u of lane) {
        u.node.lane = li + 1;
        u.node.laneCount = laneCount;
        u.node.block = jid;
        block.push(u);
        if (laneFrom) connect(b, into, laneFrom, u, 'next', itemStart(u) - laneEnd);
        laneFrom = u.node.id;
        laneEnd = itemEnd(u);
      }
      tails.push(laneFrom!);
    });
    // Узлы участка — по началу, при равенстве — по ветке: порядок в DOM и на клавиатуре — по времени.
    block.sort((x, y) => x.start - y.start || x.node.lane - y.node.lane);
    for (const u of block) into.nodes.push(u.node.id);
    const junction = newNode(jid, { kind: 'junction', name: '', startMs: it.end, endMs: it.end, block: jid });
    b.nodes[jid] = junction;
    into.nodes.push(jid);
    for (const t of tails) into.edges.push(edge(t, jid, 'join'));
    from = jid;
    end = it.end;
    asyncPrev = false;
  }
  return { from, end };
}

// ---------- Счётчики логов ----------

/** Активный узел записи-лога: чей интервал содержит её время, иначе предыдущий по началу. Листья — по началу. */
export function activeLeaf<L extends { start: number; end: number }>(leaves: readonly L[], t: number): L | null {
  let target: L | null = null;
  for (const l of leaves) {
    if (l.start > t) break;
    if (l.end >= t) target = l;
  }
  if (target) return target;
  for (const l of leaves) {
    if (l.start > t) break;
    target = l;
  }
  return target;
}

/** Записи-логи по шагам панели: шаг узла и шаг, который выбирает клик, — логи этого узла. */
export function logsByStep(graph: FlowGraph): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const n of Object.values(graph.nodes)) {
    if (n.logIds.length === 0) continue;
    const steps = new Set([...n.stepIds, ...(n.select ? [n.select] : [])]);
    for (const id of steps) out.set(id, [...(out.get(id) ?? []), ...n.logIds]);
  }
  return out;
}

function assignLogs(
  b: Builder,
  entry: FlowNode,
  units: readonly Unit[],
  logs: readonly TraceStep[],
  byId: ReadonlyMap<string, ViewRecord>,
  off: (r: ViewRecord) => number,
): void {
  // Листья по началу: узел, чей интервал содержит время записи, иначе предыдущий, иначе вход.
  const leaves = units.flatMap((u) => leafUnits(b, u.node, u));
  leaves.sort((x, y) => x.start - y.start || x.order - y.order);
  for (const s of logs) {
    const r = byId.get(s.recordIds[0]!);
    const t = r ? off(r) : s.startMs;
    const n = activeLeaf(leaves, t)?.node ?? entry;
    n.logIds.push(s.id);
    const level = (r?.level ?? '').toUpperCase();
    const error = ERROR_LEVELS.has(level);
    const warning = !error && (WARN_LEVELS.has(level) ? level !== 'NOTICE' : r?.isError === true);
    for (let id: string | undefined = n.id; id; id = b.parent.get(id)) {
      const x = b.nodes[id]!;
      x.badges.total++;
      if (error) x.badges.error++;
      if (warning) x.badges.warning++;
    }
  }
}

interface Leaf {
  node: FlowNode;
  start: number;
  end: number;
  order: number;
}

/** Листья под узлом с их интервалами: у листа — интервал единицы. */
function leafUnits(b: Builder, n: FlowNode, u: Unit): Leaf[] {
  if (!n.group) return [{ node: n, start: u.start, end: u.end, order: u.order }];
  const out: Leaf[] = [];
  const walk = (id: string) => {
    const x = b.nodes[id]!;
    if (x.kind === 'junction' || x.kind === 'pause') return;
    if (x.group) x.group.children.nodes.forEach(walk);
    else out.push({ node: x, start: x.startMs, end: x.endMs, order: u.order });
  };
  n.group.children.nodes.forEach(walk);
  return out;
}
