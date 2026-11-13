// Операция из нескольких потоков: шаги операции, роли, свёртка, ход статусов, итог.
// Чистые функции: сервер собирает факты потоков и зовёт buildOperation.
import { sha1 } from '../catalog/sha1.ts';
import { idKey, type FlowCatalogId, type FlowCatalogStatus, type FlowMethodKind } from './catalog.ts';
import { TOGETHER_MS, type FlowRole, type FlowTitleCode } from './model.ts';

export type OperationWindowPreset = '6h' | '24h';

/** Где в записях нашлось значение без разметки. Подпись на языке интерфейса выбирает браузер. */
export type FoundPlace = 'entry-path' | 'entry-body' | 'send-url' | 'send-body' | 'response-body' | 'log-body' | 'record-text';

/** Шаг потока для операции: вход, обмен (отправка с ответом), вызов или запись-лог. */
export interface OpStep {
  id: string;
  kind: 'entry' | 'exchange' | 'call' | 'log';
  /** Время, мс от эпохи. */
  atMs: number;
  /** Конец: ответ обмена; у остальных — atMs. */
  endMs: number;
  /** Название: метод проекта у входа, «система · метод» у обмена. */
  title: string;
  /** Название только из справочника и шаблона пути, без хоста и текста записи; null — такого нет. */
  safeTitle?: string | null;
  methodKind: FlowMethodKind | null;
  /** У метода есть поле статуса. */
  hasStatusField: boolean;
  /** Id записи и её пары отправка/ответ. */
  ids: FlowCatalogId[];
  status: FlowCatalogStatus | null;
  /** Статус из тела колбэка: «заявлено в колбэке». */
  claimed: boolean;
  error: boolean;
}

/** Факты одного потока или сегмента. */
export interface OpFlowFacts {
  cid: string;
  segment: number | null;
  nocid: boolean;
  firstMs: number;
  lastMs: number;
  status: 'error' | 'success';
  incomplete: boolean;
  entry: OpStep | null;
  /** Все шаги по времени, вход первым. */
  steps: OpStep[];
  /** Где в тексте записей нашлось значение id: для потока без разметки. */
  found: FoundPlace | null;
  /** Первая запись потока или сегмента: страница запроса открывается с этим шагом. */
  firstRecordId?: string | null;
}

export interface OperationFlow {
  kind: 'flow';
  cid: string;
  segment: number | null;
  nocid: boolean;
  firstMs: number;
  lastMs: number;
  role: FlowRole;
  title: string;
  /** Название только из справочника и шаблона пути: его читает вид для Бизнеса. */
  safeTitle?: string | null;
  /** Название подставил сам Threadline: интерфейс показывает его на своём языке. */
  titleCode?: FlowTitleCode;
  status: 'error' | 'success';
  incomplete: boolean;
  /** Ошибка в шагах этой операции. */
  error: boolean;
  /** Последний статус операции в шагах этой операции. */
  opStatus: FlowCatalogStatus | null;
  claimed: boolean;
  /** У метода есть поле статуса, а статус в логах не пишется. */
  noStatus: boolean;
  /** Сколько операций того же типа ведёт поток. */
  ops: number;
  linkedBy: { type: string; at: FlowCatalogId['at'] }[];
  /** У mention: где найдено значение. */
  found: FoundPlace | null;
  /** Пауза от конца предыдущего потока, не меньше 0; null — предыдущего нет. */
  pauseMs: number | null;
  /** Ближе 1 с к предыдущей строке: «одновременно». */
  together: boolean;
  /** Колбэк начался раньше ответа на создание операции. */
  callbackEarly: boolean;
  /** Первая запись потока или сегмента: шаг, выбранный на странице запроса. */
  firstRecordId?: string | null;
}

export interface OperationGroup {
  kind: 'group';
  role: FlowRole;
  title: string;
  safeTitle?: string | null;
  titleCode?: FlowTitleCode;
  cids: string[];
  firstMs: number;
  lastMs: number;
  failed: number;
  lastStatus: FlowCatalogStatus | null;
  flows: OperationFlow[];
  pauseMs: number | null;
  together: boolean;
}

/** Опросы партнёра: по подсчёту, не читались. */
export interface OperationPolls {
  kind: 'polls';
  count: number;
  fromMs: number;
  toMs: number;
}

export interface OperationUnread {
  kind: 'unread';
  count: number;
  fromMs: number;
  toMs: number;
  reason: 'limit' | 'segments';
}

export type OperationItem = OperationFlow | OperationGroup | OperationPolls | OperationUnread;

export interface TrailItem {
  status: FlowCatalogStatus;
  atMs: number;
  cid: string;
  segment: number | null;
  /** Из тела колбэка: «заявлено в колбэке». */
  claimed: boolean;
  /** Нефинальный после финального: «устаревший». */
  stale: boolean;
  /** Ближе 1 с к предыдущему из другого потока. */
  together: boolean;
}

export interface OperationOutcome {
  kind: 'success' | 'failure' | 'pending' | 'unknown';
  status: FlowCatalogStatus | null;
  /** Другой финальный до итога: «Выполнен → Возврат». */
  previous: FlowCatalogStatus | null;
  /** claimed — только по колбэку. */
  basis: 'confirmed' | 'claimed' | null;
  cid: string | null;
  partial: boolean;
  /** Потоков с ошибкой. */
  failed: number;
}

export interface OperationKeyValue {
  type: string;
  name: string | null;
  value: string;
}

export interface OperationView {
  key: { type: string; name: string | null; values: string[]; also: OperationKeyValue[] };
  window: { fromMs: number; toMs: number; preset: OperationWindowPreset };
  /** По времени; mention — в конце. */
  items: OperationItem[];
  trail: TrailItem[];
  outcome: OperationOutcome;
  /** Условия селектора среды с != и !~, которые поиск операции применил. */
  excluded: string[];
  /** Новые id вида «операция» для дополнения поиска. */
  extraIds: OperationKeyValue[];
  /** Новые id сверх предела значений: поиск по ним не предлагается, но поддержка должна их видеть. */
  unsearchedIds: OperationKeyValue[];
  supplemented: boolean;
  /** Тип ключа не описан в справочнике или справочник недоступен. */
  unknownType: boolean;
}

/** Запас чтения у края куска: поток рядом с непрочитанным отрезком может быть прочитан. */
const UNREAD_MARGIN_MS = 5 * 60_000;

export interface OperationInput {
  key: { type: string; name: string | null; values: string[]; also?: OperationKeyValue[] };
  window: OperationView['window'];
  flows: readonly OpFlowFacts[];
  polls?: readonly OperationPolls[];
  unread?: readonly OperationUnread[];
  excluded?: readonly string[];
  /** Ошибка поиска или предел строк: итог по неполным данным. */
  partial?: boolean;
  supplemented?: boolean;
  unknownType?: boolean;
  /** Можно ли искать значение: короткое — только с привязкой к полю. Без функции — можно. */
  canSearch?: (type: string, value: string) => boolean;
}

/** Ключ типа «Опросы партнёра» и прочих строк без потоков. */
const isFinal = (s: FlowCatalogStatus) => s.outcome === 'success' || s.outcome === 'failure';
const sameStatus = (a: FlowCatalogStatus, b: FlowCatalogStatus) => a.type === b.type && a.value === b.value;
const MAX_KEY_VALUES = 3;

/** Роль по виду метода входа; без входа — фоновая обработка. */
function roleOf(f: OpFlowFacts): FlowRole {
  const k = f.entry?.methodKind ?? null;
  if (!f.entry) return 'worker';
  return k === 'start' || k === 'status' || k === 'callback' ? k : 'call';
}

export function buildOperation(input: OperationInput): OperationView {
  const also = input.key.also ?? [];
  const pairs = [...input.key.values.map((value) => ({ type: input.key.type, value })), ...also.map((a) => ({ type: a.type, value: a.value }))];
  const keySet = new Set(pairs.map((p) => idKey(p.type, p.value)));
  const keyTypes = new Set(pairs.map((p) => p.type));
  const carries = (s: OpStep) => s.ids.some((id) => keySet.has(idKey(id.type, id.value)));

  // Конец ответа на создание операции: колбэк раньше него — «колбэк раньше ответа на создание».
  const startEnds: { cid: string; endMs: number }[] = [];
  for (const f of input.flows) for (const s of f.steps) if (s.methodKind === 'start' && carries(s)) startEnds.push({ cid: f.cid, endMs: s.endMs });

  const typed: OperationFlow[] = [];
  const mentions: OperationFlow[] = [];
  const trailRaw: { status: FlowCatalogStatus; atMs: number; cid: string; segment: number | null; claimed: boolean; order: number }[] = [];
  const extra: OperationKeyValue[] = [];
  const extraSeen = new Set<string>();

  const sortedFlows = [...input.flows].sort((a, b) => a.firstMs - b.firstMs || (a.cid < b.cid ? -1 : a.cid > b.cid ? 1 : 0));
  sortedFlows.forEach((f, fi) => {
    const isTyped = f.steps.some(carries);
    const base = {
      kind: 'flow' as const,
      cid: f.cid,
      segment: f.segment,
      nocid: f.nocid,
      firstMs: f.firstMs,
      lastMs: f.lastMs,
      status: f.status,
      incomplete: f.incomplete,
      pauseMs: null,
      together: false,
      callbackEarly: false,
      firstRecordId: f.firstRecordId ?? null,
    };
    if (!isTyped) {
      const named = f.entry?.title ?? f.steps.find((s) => s.kind === 'exchange')?.title ?? f.steps[0]?.title;
      // Без названия строка называлась бы своим cid, а у сегмента без correlation_id это внутренний ключ: его не показывают.
      const unnamedNocid = named === undefined && f.nocid;
      mentions.push({
        ...base,
        role: 'mention',
        title: named ?? (unnamedNocid ? 'Записи без correlation_id' : f.cid),
        ...(unnamedNocid ? { titleCode: 'nocid' as const } : {}),
        error: false,
        opStatus: null,
        claimed: false,
        noStatus: false,
        ops: 0,
        linkedBy: [],
        found: f.found,
      });
      return;
    }
    // Поток с несколькими значениями одного типа операции ведёт несколько операций: в эту — только шаги с её id.
    let ops = 1;
    for (const t of keyTypes) {
      const values = new Set(f.steps.flatMap((s) => s.ids.filter((id) => id.type === t && id.kind === 'operation').map((id) => id.value)));
      ops = Math.max(ops, values.size);
    }
    const steps = ops >= 2 ? f.steps.filter(carries) : f.steps;
    const role = roleOf(f);
    const exchange = steps.find((s) => s.kind === 'exchange') ?? steps.find((s) => s.kind !== 'entry');
    const title = f.entry ? f.entry.title : (exchange?.title ?? 'Фоновая обработка');
    const titleCode = !f.entry && !exchange ? ({ titleCode: 'background' } as const) : {};
    const statuses = f.steps.filter((s) => s.status && carries(s));
    const last = statuses[statuses.length - 1];
    const statusField = (f.entry?.hasStatusField ?? false) || steps.some((s) => s.methodKind === 'status' && s.hasStatusField);
    const linked = new Map<string, { type: string; at: FlowCatalogId['at'] }>();
    for (const s of steps) for (const id of s.ids) if (keySet.has(idKey(id.type, id.value))) linked.set(`${id.type}|${id.at}`, { type: id.type, at: id.at });
    const callbackEarly = role === 'callback' && startEnds.some((x) => x.cid !== f.cid && f.firstMs < x.endMs);
    typed.push({
      ...base,
      role,
      title,
      safeTitle: (f.entry ? f.entry.safeTitle : exchange?.safeTitle) ?? null,
      ...titleCode,
      error: steps.some((s) => s.error),
      opStatus: last?.status ?? null,
      claimed: last?.claimed ?? false,
      noStatus: role === 'status' && statusField && statuses.length === 0,
      ops,
      linkedBy: [...linked.values()],
      found: null,
      callbackEarly,
    });
    for (const s of statuses) trailRaw.push({ status: s.status!, atMs: s.atMs, cid: f.cid, segment: f.segment, claimed: s.claimed, order: fi });
    for (const s of steps) {
      if (!carries(s)) continue;
      for (const id of s.ids) {
        const k = idKey(id.type, id.value);
        if (id.kind !== 'operation' || keyTypes.has(id.type) || extraSeen.has(k)) continue;
        extraSeen.add(k);
        if (input.canSearch && !input.canSearch(id.type, id.value)) continue;
        extra.push({ type: id.type, name: id.name, value: id.value });
      }
    }
  });

  // ---------- Ход статусов ----------
  trailRaw.sort((a, b) => a.atMs - b.atMs || a.order - b.order);
  const trail: TrailItem[] = [];
  let confirmedFinal = false;
  for (const t of trailRaw) {
    const prev = trail[trail.length - 1];
    if (prev && sameStatus(prev.status, t.status) && prev.claimed === t.claimed) continue;
    const final = isFinal(t.status);
    trail.push({
      status: t.status,
      atMs: t.atMs,
      cid: t.cid,
      segment: t.segment,
      claimed: t.claimed,
      stale: !final && confirmedFinal,
      together: !!prev && prev.cid !== t.cid && t.atMs - prev.atMs < TOGETHER_MS,
    });
    if (final && !t.claimed) confirmedFinal = true;
  }

  // ---------- Итог ----------
  const failed = typed.filter((f) => f.error).length;
  const partial =
    input.partial === true || typed.some((f) => f.incomplete) || (input.unread ?? []).some((u) => u.count > 0);
  const confirmed = trail.filter((t) => isFinal(t.status) && !t.claimed);
  const lastConfirmed = confirmed[confirmed.length - 1];
  const lastTrail = trail[trail.length - 1];
  let outcome: OperationOutcome;
  if (lastConfirmed) {
    const before = confirmed.slice(0, -1).reverse().find((t) => !sameStatus(t.status, lastConfirmed.status));
    outcome = {
      kind: lastConfirmed.status.outcome === 'success' ? 'success' : 'failure',
      status: lastConfirmed.status,
      previous: before?.status ?? null,
      basis: 'confirmed',
      cid: lastConfirmed.cid,
      partial,
      failed,
    };
  } else if (lastTrail && lastTrail.claimed && isFinal(lastTrail.status)) {
    outcome = {
      kind: lastTrail.status.outcome === 'success' ? 'success' : 'failure',
      status: lastTrail.status,
      previous: null,
      basis: 'claimed',
      cid: lastTrail.cid,
      partial,
      failed,
    };
  } else if (lastTrail) {
    outcome = { kind: 'pending', status: lastTrail.status, previous: null, basis: null, cid: lastTrail.cid, partial, failed };
  } else {
    outcome = { kind: 'unknown', status: null, previous: null, basis: null, cid: null, partial, failed };
  }

  // ---------- Список: свёртка однотипных подряд, паузы, строки опросов и непрочитанного ----------
  const runs: (OperationFlow | OperationGroup)[] = [];
  const unreadRows = (input.unread ?? []).filter((u) => u.count > 0);
  // Группа не идёт через непрочитанную середину: иначе выглядела бы непрерывной. Края отрезка прочитаны с запасом, поэтому
  // поток может стоять и внутри него: разрыв — там, где между двумя потоками непрочитанного больше запаса.
  const unreadBetween = (a: OperationFlow, b: OperationFlow) =>
    unreadRows.some((u) => Math.min(u.toMs, b.firstMs) - Math.max(u.fromMs, a.firstMs) > UNREAD_MARGIN_MS);
  for (let i = 0; i < typed.length; ) {
    const f = typed[i]!;
    let j = i + 1;
    while (j < typed.length && typed[j]!.role === f.role && typed[j]!.title === f.title && !unreadBetween(typed[j - 1]!, typed[j]!)) j++;
    if (j - i >= 2) {
      const flows = typed.slice(i, j);
      runs.push({
        kind: 'group',
        role: f.role,
        title: f.title,
        safeTitle: f.safeTitle ?? null,
        ...(f.titleCode ? { titleCode: f.titleCode } : {}),
        cids: flows.map((x) => x.cid),
        firstMs: f.firstMs,
        lastMs: Math.max(...flows.map((x) => x.lastMs)),
        failed: flows.filter((x) => x.error).length,
        lastStatus: [...flows].reverse().find((x) => x.opStatus)?.opStatus ?? null,
        flows,
        pauseMs: 0,
        together: false,
      });
    } else runs.push(f);
    i = j;
  }
  let prevEnd: number | null = null;
  for (const r of runs) {
    if (prevEnd !== null) {
      const gap = r.firstMs - prevEnd;
      r.pauseMs = Math.max(0, Math.round(gap));
      r.together = gap < TOGETHER_MS;
    }
    if (r.kind === 'group') {
      let inner: number | null = prevEnd;
      for (const f of r.flows) {
        if (inner !== null) {
          const gap = f.firstMs - inner;
          f.pauseMs = Math.max(0, Math.round(gap));
          f.together = gap < TOGETHER_MS;
        }
        inner = f.lastMs;
      }
    }
    prevEnd = Math.max(prevEnd ?? -Infinity, r.lastMs);
  }
  // Подсчёт знает опросы с точностью до часового куска: раньше первого прочитанного потока они не показываются.
  const firstFlowMs = typed.length > 0 ? Math.min(...typed.map((f) => f.firstMs)) : null;
  const polls = (input.polls ?? [])
    .filter((p) => p.count > 0)
    .map((p) => (firstFlowMs !== null && firstFlowMs <= p.toMs ? { ...p, fromMs: Math.max(p.fromMs, firstFlowMs) } : p));
  const rows: OperationItem[] = [...runs, ...polls, ...unreadRows];
  const at = (x: OperationItem) => (x.kind === 'polls' || x.kind === 'unread' ? x.fromMs : x.firstMs);
  rows.sort((a, b) => at(a) - at(b));

  return {
    key: { type: input.key.type, name: input.key.name, values: [...input.key.values], also: [...also] },
    window: { ...input.window },
    items: [...rows, ...mentions],
    trail,
    outcome,
    excluded: [...(input.excluded ?? [])],
    extraIds: extra.slice(0, Math.max(0, MAX_KEY_VALUES - pairs.length)),
    unsearchedIds: extra.slice(Math.max(0, MAX_KEY_VALUES - pairs.length)),
    supplemented: input.supplemented === true,
    unknownType: input.unknownType === true,
  };
}

// ---------- Записи без correlation_id (ветка A) ----------

/** Пауза, после которой записи одного пода — новый сегмент. */
export const NOCID_GAP_MS = 30_000;
export const MAX_SEGMENTS = 50;
/** Ветка B: пауза внутри одного correlation_id, после которой — новый сегмент. */
export const SEGMENT_GAP_MS = 3 * 60_000;

/**
 * Ветка B: записи одного correlation_id по времени делятся на сегменты по паузе больше SEGMENT_GAP_MS.
 * Один сегмент — поток целиком. Роль сегмента — по его входу, без входа — фоновая обработка (buildOperation).
 */
export function cidSegments<T extends { timeMs: number }>(records: readonly T[], gapMs: number = SEGMENT_GAP_MS): T[][] {
  const sorted = [...records].sort((a, b) => a.timeMs - b.timeMs);
  const out: T[][] = [];
  for (const r of sorted) {
    const cur = out[out.length - 1];
    if (cur && r.timeMs - cur[cur.length - 1]!.timeMs <= gapMs) cur.push(r);
    else out.push([r]);
  }
  return out;
}

export interface NocidSegment<T> {
  id: string;
  pod: string;
  firstMs: number;
  lastMs: number;
  records: T[];
}

/**
 * Записи с id операции без correlation_id: сегменты по метке пода (без неё — по компоненту) и паузе больше 30 с.
 * Не больше 50 сегментов по времени, остальные — в rest.
 */
export function nocidSegments<T extends { timeMs: number; labels: Record<string, string>; component: string | null }>(
  records: readonly T[],
): { segments: NocidSegment<T>[]; rest: number } {
  const byPod = new Map<string, T[]>();
  for (const r of records) {
    const pod = r.labels.pod ?? r.component ?? '';
    const list = byPod.get(pod);
    if (list) list.push(r);
    else byPod.set(pod, [r]);
  }
  const all: NocidSegment<T>[] = [];
  for (const [pod, list] of byPod) {
    const sorted = [...list].sort((a, b) => a.timeMs - b.timeMs);
    let cur: T[] = [];
    const flush = () => {
      if (cur.length === 0) return;
      const firstMs = cur[0]!.timeMs;
      // Хеш вместо имени пода: идентификатор уходит в ответы и адрес страницы, имя пода туда не должно попадать.
      all.push({ id: `nocid:${sha1(pod || 'unknown').slice(0, 12)}:${Math.trunc(firstMs)}`, pod, firstMs, lastMs: cur[cur.length - 1]!.timeMs, records: cur });
      cur = [];
    };
    for (const r of sorted) {
      if (cur.length > 0 && r.timeMs - cur[cur.length - 1]!.timeMs > NOCID_GAP_MS) flush();
      cur.push(r);
    }
    flush();
  }
  all.sort((a, b) => a.firstMs - b.firstMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { segments: all.slice(0, MAX_SEGMENTS), rest: Math.max(0, all.length - MAX_SEGMENTS) };
}
