// Названия из справочника в результатах: строка списка, причины, шапка запроса, шкала и панель шага.
// Без разметки справочника (выключен, недоступен, поле ещё не пришло) — прежний вид: читаемый путь и хост.
import type { MethodKind } from '@threadline/core/catalog';
import { GATEWAY_LABEL, type CatalogError, type CatalogId, type CatalogName, type CatalogOutcome, type CatalogStatus, type ErrorReason, type RecordCatalog, type RequestSummary, type Trace, type TraceStep, type ViewRecord } from '@threadline/core/search';
import type { Outcome } from '@/features/request/trace-model.ts';
import i18n from '@/i18n/index.ts';
import { meaningOf, reasonView, type ReasonView } from '@/lib/error-text.ts';
import { briefSystem } from '@/features/view/brief.ts';

export const entryOf = (s: RequestSummary): CatalogName | null => (s as RequestSummary).entry ?? null;
export const recordCatalog = (r: ViewRecord | undefined): RecordCatalog | null => (r as ViewRecord | undefined)?.catalog ?? null;

/** Название входящего метода; null — справочник его не знает. */
export const entryName = (s: RequestSummary): string | null => entryOf(s)?.method?.name ?? null;

/**
 * named — текст из справочника: строка показывает «система · текст», как «Коммутатор · Карта не найдена».
 * label — подпись источника: нет правила ещё не значит, что неизвестна система.
 */
export type CatalogReasonView = ReasonView & { named: boolean; label: ReasonView['source']; /** call — название справочника, а не «МЕТОД путь». */ callNamed: boolean };

/** Причина с текстом справочника: «Коммутатор · Карта не найдена»; по правилу итога — текст правила. */
export function catalogReasonView(r: ErrorReason): CatalogReasonView {
  const c = r as ErrorReason;
  const base = reasonView({ kind: c.kind === 'outcome' ? 'business' : c.kind, text: c.text });
  const name = c.name ?? null;
  const error = c.error ?? null;
  const title = error?.title ?? (c.kind === 'outcome' ? c.text : null);
  // Бизнесу текст из логов не приходит: без записи справочника общие слова по виду причины. У остальных text не пустой.
  const silent = !title && !c.text && (c.kind === 'level' || c.kind === 'http' || c.kind === 'business' || c.kind === 'outcome');
  const words = silent ? i18n.t(c.kind === 'level' ? 'view.brief.reason.internal' : 'view.brief.reason.external') : null;
  // Ожидание ответа не ошибка, даже если система шага описана: блок не красный, подпись не про систему.
  const source = c.kind === 'pending' ? 'pending' : error || name ? (error?.source ?? name!.source) : silent && c.kind !== 'level' ? 'external' : base.source;
  const owner = c.kind === 'level' || name?.source === 'project' ? 'project' : 'external';
  return {
    ...base,
    source,
    ...(title ? { message: title, codes: [] } : words ? { message: words, codes: [] } : {}),
    system: name?.system?.name ?? base.system,
    call: name?.method?.name ?? base.call,
    callNamed: !!name?.method?.name,
    named: !!title,
    label: source === 'unknown' && name?.system ? owner : source,
  };
}

/** Причина без описания в справочнике: у Бизнеса на месте текста только общие слова, и он передаёт ссылку в поддержку. */
export const undescribedReason = (r: ErrorReason): boolean => r.kind !== 'pending' && !r.text && !r.error?.title;

export interface BriefReason {
  message: string;
  system: string | null;
  call: string | null;
  /** Подсказка из тех же слов: исходной строки, кодов и адреса в ней нет. */
  title: string;
}

/** Причина в «Кратко»: смысл без кодов, система по запасному правилу, операция или название метода. Текст причины не переписывается. */
export function briefReason(v: CatalogReasonView, operation: string | null = null): BriefReason {
  const system = v.system ? briefSystem(v.system) : v.target ? briefSystem(null) : null;
  const call = operation ?? (v.callNamed ? v.call : null);
  // Текст справочника не трогается: он написан для чтения.
  const message = v.named ? v.message : meaningOf(v.message);
  return { message, system, call, title: [message, system, call].filter(Boolean).join(' · ') };
}

// ---------- Шаг трассы ----------

export interface StepCatalog {
  name: CatalogName | null;
  error: CatalogError | null;
  outcome: CatalogOutcome | null;
  status: CatalogStatus | null;
  ids: CatalogId[];
}

/** Разметка записей шага одним целым: у обмена имя — с отправки, итог и ошибка — с ответа. */
export function stepCatalog(step: TraceStep, byId: ReadonlyMap<string, ViewRecord>): StepCatalog | null {
  const list = step.recordIds.map((id) => recordCatalog(byId.get(id))).filter((c): c is RecordCatalog => c !== null);
  if (list.length === 0) return null;
  const ids = new Map<string, CatalogId>();
  for (const c of list) for (const id of c.ids) ids.set(`${id.type}\u0000${id.value}`, id);
  return {
    name: list.find((c) => c.name?.method)?.name ?? list.find((c) => c.name)?.name ?? null,
    error: list.find((c) => c.error)?.error ?? null,
    outcome: list.find((c) => c.outcome)?.outcome ?? null,
    status: [...list].reverse().find((c) => c.status)?.status ?? null,
    ids: [...ids.values()],
  };
}

/** Итог шага по справочнику: правило итога сильнее отметки «не ошибка» правила ошибок. */
export type StepVerdict = 'success' | 'error' | 'pending' | 'ignored';

export function stepVerdict(step: TraceStep, c: StepCatalog | null): StepVerdict | null {
  if (!c) return null;
  if (c.outcome) return c.outcome.kind === 'ignore' ? 'ignored' : c.outcome.kind;
  if (step.isError && c.error?.severity === 'ok') return 'ignored';
  return null;
}

/** Красный ли шаг с учётом справочника. */
export function stepIsError(step: TraceStep, c: StepCatalog | null): boolean {
  const v = stepVerdict(step, c);
  return v === null ? step.isError : v === 'error';
}

/** Имя системы обмена: из справочника, иначе null. */
export const systemName = (c: StepCatalog | null): string | null => c?.name?.system?.name ?? null;
/** Название метода шага: из справочника, иначе null. */
export const methodName = (c: StepCatalog | null): string | null => c?.name?.method?.name ?? null;

/**
 * Цепочка «шлюз → api → Коммутатор» именами справочника: хост обмена заменяется именем его системы.
 * fallback — подпись хоста без справочника.
 */
export function chainNames(trace: Trace, byId: ReadonlyMap<string, ViewRecord>, fallback: (host: string) => string): string[] {
  const names = new Map<string, string>();
  for (const s of trace.steps) {
    if (s.kind !== 'exchange' || !s.system) continue;
    const name = systemName(stepCatalog(s, byId));
    if (name && !names.has(s.system)) names.set(s.system, name);
    else if (!names.has(s.system)) names.set(s.system, fallback(s.system));
  }
  return chainLabels(trace.chain).map((c) => names.get(c) ?? c);
}

/** Звено шлюза подставляет ядро: оно на языке интерфейса, а не в данных. */
export const chainLabels = (chain: readonly string[]): string[] => chain.map((c) => (c === GATEWAY_LABEL ? i18n.t('trace.scheme.gateway') : c));

/** Вид метода для подписи: у внешней системы «создание операции» — «асинхронная отправка». */
export function kindLabelKey(kind: MethodKind, source: 'project' | 'external'): `catalog.methodKind.${'project' | 'external'}.${MethodKind}` {
  return `catalog.methodKind.${source}.${kind}`;
}

export interface LineWords {
  ok: string;
  pending: string;
  ignored: string;
}

/**
 * Строка итога шага с учётом справочника: правило итога задаёт цвет и текст, «не ошибка» снимает красный,
 * ошибка с правилом справочника называется его текстом. Без разметки — как было.
 */
export function catalogLine(o: Outcome, step: TraceStep, c: StepCatalog | null, w: LineWords): Outcome {
  if (!c) return o;
  const v = stepVerdict(step, c);
  const text = c.outcome?.text ?? null;
  if (v === 'success') return { ...o, tone: 'success', label: text ?? w.ok };
  if (v === 'pending') return { ...o, tone: 'neutral', label: text ?? w.pending };
  if (v === 'ignored') return { ...o, tone: 'neutral', label: w.ignored };
  if (v === 'error') return { ...o, tone: 'danger', label: text ?? (c.error?.rule ? c.error.title : null) ?? o.label };
  if (o.tone === 'danger' && c.error?.rule && c.error.title) return { ...o, label: c.error.title };
  return o;
}
