// Трасса запроса: шаги на шкале времени.
import { hostOf } from '../catalog/host.ts';
import type { RecordTitleCode, ViewRecord } from './api.ts';
import { clipTitle } from './records.ts';

export { hostOf };

export interface TraceStep {
  id: string;
  parentId: string | null;
  depth: number;
  kind: 'incoming' | 'call' | 'exchange' | 'log';
  title: string;
  /** Заголовок шага подставил сам Threadline: он взят из записи, а своего текста у неё нет. */
  titleCode?: RecordTitleCode;
  /** Хост внешней системы для обмена; компонент для входа, вызова и лога. */
  system: string | null;
  /** Смещение от первой записи запроса, мс. */
  startMs: number;
  endMs: number;
  durationMs: number | null;
  status: number | null;
  isError: boolean;
  noResponse: boolean;
  pending: boolean;
  recordIds: string[];
}

export interface Trace {
  steps: TraceStep[];
  totalMs: number;
  /** Объединение интервалов обменов с внешними системами, мс. */
  externalMs: number;
  /** Цепочка: «шлюз», компонент приложения, системы обменов. */
  chain: string[];
  startTimeMs: number;
}

/** Первое звено цепочки, если запрос пришёл через шлюз. */
export const GATEWAY_LABEL = 'шлюз';

interface Node {
  step: TraceStep;
  children: Node[];
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** Путь адреса без хоста и строки запроса: «/v3/cards/info», «/» для адреса без пути. */
export function pathOf(uri: string | null): string {
  if (!uri) return '';
  const rest = uri.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '').replace(/^[^/?#@]*@/, '');
  const path = rest.startsWith('/') ? rest : rest.replace(/^[^/?#]*/, '');
  return path.replace(/[?#].*$/s, '') || '/';
}

function exchangeTitle(r: ViewRecord): string {
  const method = r.http?.method ?? '';
  // Вид для Бизнеса: от адреса обмена осталось имя системы, пути нет. Заголовок «/» читался бы как настоящий путь.
  if (!method && !r.http?.uri?.includes('/')) return '';
  return clipTitle(`${method} ${pathOf(r.http?.uri ?? null)}`.trim());
}

/** Сумма длин объединения отрезков. */
function unionLength(intervals: [number, number][]): number {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let cur: [number, number] | null = null;
  for (const [s, e] of sorted) {
    if (!cur || s > cur[1]) {
      if (cur) total += cur[1] - cur[0];
      cur = [s, e];
    } else if (e > cur[1]) cur[1] = e;
  }
  if (cur) total += cur[1] - cur[0];
  return total;
}

/**
 * Шаги трассы по записям потока. Записи — как отдаёт buildView: по порядку, со смещениями.
 * Ни одна запись не теряется: каждая входит хотя бы в один шаг.
 */
export function buildTrace(records: ViewRecord[]): Trace {
  if (records.length === 0) return { steps: [], totalMs: 0, externalMs: 0, chain: [], startTimeMs: 0 };

  const startTimeMs = records.reduce((m, r) => Math.min(m, r.timeMs), Infinity);
  const off = (r: ViewRecord) => Math.max(0, r.offsetMs ?? round3(r.timeMs - startTimeMs));
  const totalMs = records.reduce((m, r) => Math.max(m, off(r), r.axisEndMs ?? 0), 0);
  const byId = new Map(records.map((r) => [r.id, r]));

  const step = (r: ViewRecord, kind: TraceStep['kind'], over: Partial<TraceStep> = {}): TraceStep => ({
    id: r.id,
    parentId: null,
    depth: 0,
    kind,
    title: r.title,
    system: r.component,
    startMs: off(r),
    endMs: off(r),
    durationMs: null,
    status: null,
    isError: r.isError,
    noResponse: false,
    pending: false,
    recordIds: [r.id],
    ...over,
  });

  const roots: Node[] = [];
  const consumed = new Set<string>();
  // Вход — корень, даже если его запись по времени не первая (часы шлюза и приложения расходятся).
  const entry = records.find((r) => r.kind === 'incoming');
  const root: Node | null = entry
    ? { step: step(entry, 'incoming', { startMs: 0, endMs: totalMs, durationMs: totalMs }), children: [] }
    : null;
  if (root && entry) {
    roots.push(root);
    consumed.add(entry.id);
  }
  /** Открытый вызов по request_id: ему достаются следующие отправки с тем же request_id. */
  const openCalls = new Map<string, Node>();
  const exchanges: TraceStep[] = [];

  const attach = (node: Node, parent: Node | null) => {
    if (parent) {
      node.step.parentId = parent.step.id;
      parent.children.push(node);
    } else roots.push(node);
  };

  const addExchange = (first: ViewRecord, s: TraceStep) => {
    const call = first.requestId !== null ? openCalls.get(first.requestId) : undefined;
    const node: Node = { step: s, children: [] };
    attach(node, call ?? root);
    exchanges.push(s);
    if (call && s.endMs > call.step.endMs) {
      call.step.endMs = s.endMs;
      call.step.durationMs = round3(s.endMs - call.step.startMs);
    }
  };

  for (const r of records) {
    if (consumed.has(r.id)) continue;
    switch (r.kind) {
      case 'incoming': {
        // Второй вход в том же запросе — внутри первого, до конца запроса.
        attach({ step: step(r, 'incoming', { endMs: totalMs, durationMs: round3(totalMs - off(r)) }), children: [] }, root);
        break;
      }
      case 'call': {
        const node: Node = { step: step(r, 'call'), children: [] };
        attach(node, root);
        if (r.requestId !== null) openCalls.set(r.requestId, node);
        break;
      }
      case 'send': {
        const pair = r.http?.pairId ? byId.get(r.http.pairId) : undefined;
        const resp = pair && pair.kind === 'response' ? pair : undefined;
        const start = off(r);
        const s = step(r, 'exchange', {
          title: exchangeTitle(r),
          system: hostOf(r.http?.uri ?? null),
          isError: r.isError || (resp?.isError ?? false),
        });
        if (resp) {
          consumed.add(resp.id);
          s.endMs = Math.max(start, off(resp));
          s.durationMs = resp.http?.durationMs ?? round3(s.endMs - start);
          s.status = resp.http?.status ?? null;
          s.recordIds.push(resp.id);
        } else {
          s.endMs = Math.max(start, totalMs);
          s.noResponse = true;
          s.pending = r.http?.pending ?? false;
        }
        addExchange(r, s);
        break;
      }
      case 'response': {
        // Ответ без отправки: обмен нулевой длины.
        addExchange(
          r,
          step(r, 'exchange', {
            title: exchangeTitle(r),
            system: hostOf(r.http?.uri ?? null),
            status: r.http?.status ?? null,
          }),
        );
        break;
      }
      default: {
        const title = r.kind === 'raw' ? clipTitle(r.message) || r.title : r.title;
        attach({ step: step(r, 'log', { title, ...(title === r.title && r.titleCode ? { titleCode: r.titleCode } : {}) }), children: [] }, root);
      }
    }
  }

  const steps: TraceStep[] = [];
  const walk = (n: Node, depth: number) => {
    n.step.depth = depth;
    steps.push(n.step);
    for (const c of n.children) walk(c, depth + 1);
  };
  for (const n of roots) walk(n, 0);

  const chain: string[] = [];
  const push = (x: string | null) => {
    if (x && !chain.includes(x)) chain.push(x);
  };
  if (records.some((r) => r.kind === 'incoming' && r.gateway)) push(GATEWAY_LABEL);
  for (const r of records) if (!r.gateway) push(r.component);
  for (const e of exchanges) push(e.system);

  return {
    steps,
    totalMs,
    externalMs: round3(unionLength(exchanges.map((e) => [e.startMs, e.endMs]))),
    chain,
    startTimeMs,
  };
}
