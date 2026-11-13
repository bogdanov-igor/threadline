// Экран запроса для Бизнеса: шаги по порядку и главная причина. Только то, что уже есть в ответе по списку полей, новых полей здесь нет.
// Запланированных шагов в ответе нет: список показывает только то, что случилось.
import type { ErrorReason, RequestSummary, Trace, TraceStep, ViewRecord } from '@threadline/core/search';
import { briefReason, catalogReasonView, methodName, stepCatalog, stepVerdict, systemName, undescribedReason, type CatalogReasonView, type StepCatalog } from '@/features/catalog/names.ts';
import { groupReasons, reasonsOverCap, rowAction, type ReasonRow } from '@/features/request/reasons.ts';
import { titleText } from '@/features/request/record-title.ts';
import { operationOf } from '@/features/request/trace-model.ts';
import { briefSystem } from '@/features/view/brief.ts';

export type StepTone = 'ok' | 'error' | 'no-answer' | 'pending';

export interface BusinessStep {
  id: string;
  /** С единицы, по порядку на экране. */
  index: number;
  kind: TraceStep['kind'];
  /** null — только общая подпись: названия нет ни в справочнике, ни у системы. */
  name: string | null;
  /** Строка под названием: система. У обмена без названия из справочника имя системы и есть название. */
  detail: string | null;
  /** Имя системы для слов «Система … не ответила»; null — адрес системы неизвестен. */
  system: string | null;
  /** Система и метод справочника: только так видно, что это повтор того же обмена. null — повтор не отличить от другого вызова. */
  repeat: string | null;
  tone: StepTone;
  /** Слово итога из справочника; null — общее слово по тону. */
  word: string | null;
  /** Смещение от начала запроса. */
  startMs: number;
  durationMs: number | null;
  /** Сколько запрос шёл без ответа этому шагу: от отправки до последней записи. Точного времени ожидания в записях нет. */
  waitedMs: number | null;
  /** Это сам запрос: шага внутри него нет или ошибка только на входе. */
  entry: boolean;
}

/** unread: ответа нет, а записи дочитаны не полностью. В отличие от pending, ждать бесполезно: предел чтения от времени не меняется. */
export type BusinessState = 'ok' | 'pending' | 'unread' | 'known' | 'unknown' | 'no-answer';

export interface BusinessModel {
  state: BusinessState;
  steps: BusinessStep[];
  failed: BusinessStep | null;
  /** Ближайший прошедший шаг перед ошибкой. */
  previous: BusinessStep | null;
  passed: number;
  /** После шага с ошибкой в записях нет других шагов. */
  lastStep: boolean;
  /** Главная причина. */
  reason: CatalogReasonView | null;
  action: string | null;
  /** Остальные причины: каждую видно, строка о передаче ссылки одна. */
  others: ReasonRow[];
  undescribed: boolean;
}

type Row = Omit<BusinessStep, 'index'>;

const failing = (s: Pick<BusinessStep, 'tone'>) => s.tone === 'error' || s.tone === 'no-answer';

function toneOf(step: TraceStep, c: StepCatalog | null): Pick<BusinessStep, 'tone' | 'word'> {
  if (step.kind === 'exchange' && step.noResponse) return { tone: step.pending ? 'pending' : 'no-answer', word: null };
  const verdict = stepVerdict(step, c);
  if (verdict === null ? step.isError : verdict === 'error') return { tone: 'error', word: c?.outcome?.text ?? c?.error?.title ?? null };
  if (verdict === 'pending') return { tone: 'pending', word: c?.outcome?.text ?? null };
  if (verdict === 'ignored') return { tone: 'ok', word: null };
  return { tone: 'ok', word: c?.outcome?.text ?? c?.status?.name ?? null };
}

function names(step: TraceStep, trace: Trace, c: StepCatalog | null): Pick<BusinessStep, 'name' | 'detail' | 'system'> {
  if (step.kind === 'exchange') {
    const system = systemName(c) ?? briefSystem(step.system);
    const known = system === briefSystem(null) ? null : system;
    const named = methodName(c) ?? operationOf(step, trace);
    return named ? { name: named, detail: system, system: known } : { name: system, detail: null, system: known };
  }
  const name = step.kind === 'incoming' ? methodName(c) : titleText(step);
  return { name: name || null, detail: null, system: null };
}

/** Как на графе: повтор только у обмена с методом из справочника. Имя вызова вокруг обмена его не называет, а старт с выданным id это новая операция. */
function repeatKey(step: TraceStep, c: StepCatalog | null): string | null {
  const name = c?.name;
  if (step.kind !== 'exchange' || !c || !name?.method || (name.method.kind === 'start' && c.ids.length > 0)) return null;
  return `${name.system?.key ?? step.system ?? ''}|m${name.method.id}|${name.method.name}`;
}

function toStep(step: TraceStep, trace: Trace, byId: ReadonlyMap<string, ViewRecord>): Row {
  const c = stepCatalog(step, byId);
  const { tone, word } = toneOf(step, c);
  return {
    id: step.id,
    kind: step.kind,
    ...names(step, trace, c),
    repeat: repeatKey(step, c),
    tone,
    word,
    startMs: step.startMs,
    durationMs: step.durationMs,
    waitedMs: tone === 'no-answer' && step.endMs > step.startMs ? step.endMs - step.startMs : null,
    entry: false,
  };
}

/**
 * Повторы подряд одной строкой: тот же метод справочника и тот же итог. Неудача и успех не сливаются, иначе ошибка пропала бы из списка.
 * Без своего метода у обмена в ответе только система, и разные вызовы одной системы от повтора не отличить: каждый идёт своей строкой.
 */
function merged(list: readonly Row[], ends: ReadonlyMap<string, number>): BusinessStep[] {
  const out: BusinessStep[] = [];
  for (const s of list) {
    const last = out.at(-1);
    if (last?.repeat && last.repeat === s.repeat && last.tone === s.tone && last.word === s.word) {
      last.durationMs = Math.max(0, (ends.get(s.id) ?? s.startMs) - last.startMs);
      last.waitedMs = s.waitedMs;
      continue;
    }
    out.push({ ...s, index: out.length + 1 });
  }
  return out;
}

/** Строка самого запроса: у запроса только из логов входа нет, а строка всё равно одна. */
function requestRow(root: TraceStep | undefined, trace: Trace, byId: ReadonlyMap<string, ViewRecord>, title: string, failed: boolean): Row {
  const self: Row = root ? toStep(root, trace, byId) : { id: 'request', kind: 'log', name: null, detail: null, system: null, repeat: null, tone: 'ok', word: null, startMs: 0, durationMs: trace.totalMs, waitedMs: null, entry: true };
  return { ...self, name: title, detail: null, repeat: null, entry: true, ...(failed && !failing(self) ? { tone: 'error' as const, word: null } : {}) };
}

/**
 * Шаги экрана. Сам вход назван заголовком страницы и в список не идёт, кроме двух случаев: других шагов нет или ни один шаг ошибки не показывает.
 * Вызов с обменами внутри тоже не строка: обмены названы его именем. Записи-логи не шаги, даже с ошибкой: их текста в ответе нет,
 * а подпись «Запись» не говорит, где сломалось. Такая ошибка видна причиной и строкой самого запроса.
 */
export function businessSteps(trace: Trace, byId: ReadonlyMap<string, ViewRecord>, title: string, failed = false): BusinessStep[] {
  if (trace.steps.length === 0) return [];
  const real = trace.steps.filter((s) => s.kind !== 'log');
  const parents = new Set(real.map((s) => s.parentId));
  const isRoot = (s: TraceStep) => s.kind === 'incoming' && s.parentId === null;
  const own = real.filter((s) => !isRoot(s) && !(s.kind === 'call' && parents.has(s.id))).map((s, order) => ({ s, order }));
  own.sort((a, b) => a.s.startMs - b.s.startMs || a.order - b.order);
  const list: Row[] = own.map(({ s }) => toStep(s, trace, byId));
  const self = requestRow(real.find(isRoot), trace, byId, title, failed);
  if (list.length === 0 || (failing(self) && !list.some(failing))) list.push(self);
  return merged(list, new Map(trace.steps.map((s) => [s.id, s.endMs])));
}

/** Запись уровня ERROR без правила: общие слова без системы и шага. */
const plainLevel = (r: ErrorReason) => r.kind === 'level' && undescribedReason(r);

/** Кодов и текста у Бизнеса нет, поэтому причины, которые читаются одинаково, это одна строка с общим числом. */
function sameWords(rows: readonly ReasonRow[]): ReasonRow[] {
  const out = new Map<string, ReasonRow>();
  for (const row of rows) {
    const { message, system } = briefReason(row.view);
    const key = `${message}\u0000${system ?? ''}`;
    const had = out.get(key);
    if (had) had.count += row.count;
    else out.set(key, { ...row });
  }
  return [...out.values()];
}

export function businessModel(s: RequestSummary, trace: Trace, byId: ReadonlyMap<string, ViewRecord>, title: string): BusinessModel {
  const errors = [...s.reasons.filter((r) => r.kind !== 'pending'), ...reasonsOverCap(s, byId.values(), true)];
  const steps = businessSteps(trace, byId, title, s.status === 'error' || errors.length > 0);
  // Главная причина та, что называет обмен или слова справочника. Запись ERROR рядом с неописанным отказом обмена обычно его же эхо, строка о передаче ссылки уже есть.
  const specific = errors.filter((r) => !plainLevel(r));
  const first = specific[0] ?? errors[0] ?? null;
  const listed = first && undescribedReason(first) && specific.length > 0 ? specific : [...specific, ...errors.filter(plainLevel)];
  const views = listed.map((r) => catalogReasonView(r));
  const rows = sameWords(groupReasons(views));

  let state: BusinessState;
  if (!first && s.status === 'success') state = s.reasons.length > 0 || steps.some((x) => x.tone === 'pending') ? (s.incomplete ? 'unread' : 'pending') : 'ok';
  else if (first?.kind === 'no-response') state = 'no-answer';
  else state = first && !undescribedReason(first) ? 'known' : 'unknown';

  const calm = state === 'ok' || state === 'pending' || state === 'unread';
  const anyFailed = steps.find(failing) ?? null;
  const failed = calm ? null : state === 'no-answer' ? (steps.find((x) => x.tone === 'no-answer') ?? anyFailed) : anyFailed;
  const at = failed ? steps.indexOf(failed) : -1;
  return {
    state,
    steps,
    failed,
    previous: at > 0 ? (steps.slice(0, at).reverse().find((x) => x.tone === 'ok') ?? null) : null,
    passed: steps.filter((x) => x.tone === 'ok').length,
    lastStep: at >= 0 && at === steps.length - 1,
    reason: rows[0]?.view ?? null,
    action: rowAction(rows[0], listed, views),
    others: rows.slice(1),
    // Запрос с ошибкой без причины в ответе: описывать нечего, ссылка всё равно нужна поддержке.
    undescribed: !calm && (errors.length === 0 || errors.some(undescribedReason)),
  };
}
