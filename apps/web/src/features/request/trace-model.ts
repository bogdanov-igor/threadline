// Модель страницы трассы поверх buildTrace: схема блоками, выбор по умолчанию, вкладки подробностей, шкала.
import { businessError, withoutHtmlShown, type Trace, type TraceStep, type ViewRecord } from '@threadline/core/search';
import { blockVisible, DEFAULT_VIEW, type ViewMode, type ViewSettings } from '@threadline/core/view';
import { withRevealed, type RevealOverlay } from './overlay.ts';
import i18n from '../../i18n/index.ts';
import { noAnswerKey } from '../../lib/error-text.ts';
import { numberFormat, upperFirst } from '../../lib/format.ts';
import { httpStatusText, statusMeaning } from '../../lib/http-status.ts';
import { compactHost } from '../../lib/path-template.ts';

export { httpStatusText, statusMeaning };
import { stepCatalog, stepIsError } from '../catalog/names.ts';
import { recordBlocks, TAB_OF, visibleBlocks, type Block, type DetailTab } from './blocks.ts';

export type { DetailTab } from './blocks.ts';

/** Выбран блок приложения на схеме: подробности — логи приложения. */
export const APP = 'app';

export const DETAIL_TABS: readonly DetailTab[] = ['request', 'response', 'context', 'raw'];

export interface StepBlock {
  record: ViewRecord;
  block: Block;
}

export function stepRecords(step: TraceStep, byId: ReadonlyMap<string, ViewRecord>): ViewRecord[] {
  return step.recordIds.map((id) => byId.get(id)).filter((r): r is ViewRecord => r !== undefined);
}

/** Запись запроса шага для cURL: отправка или вход с адресом. Обмен только с ответом запроса на экране не имеет. */
export function curlRecord(step: TraceStep, byId: ReadonlyMap<string, ViewRecord>): ViewRecord | null {
  return stepRecords(step, byId).find((r) => r.kind !== 'response' && !!r.http?.uri) ?? null;
}

/** Блоки записей шага по вкладкам; пустых вкладок нет. */
export function stepBlocks(step: TraceStep, byId: ReadonlyMap<string, ViewRecord>, overlay: RevealOverlay | null = null, view: ViewSettings = DEFAULT_VIEW, mode: ViewMode = 'full'): Map<DetailTab, StepBlock[]> {
  const out = new Map<DetailTab, StepBlock[]>();
  for (const record of stepRecords(step, byId)) {
    // Открытое значение — только в тексте блока: запись остаётся исходной, строгой.
    for (const block of visibleBlocks(recordBlocks(withRevealed(record, overlay)), view, mode)) {
      // В «Кратко» вкладка без данных не нужна: у входа GET кроме адреса в ней нечего показать.
      if (mode === 'brief' && block.empty) continue;
      // Заголовки — блок внутри «Запроса» или «Ответа»: вкладка выключена настройкой, значит и её заголовков нет.
      const tab: DetailTab = block.name === 'headers' ? (record.kind === 'response' ? 'response' : 'request') : (TAB_OF[block.name] as DetailTab);
      if (block.name === 'headers' && !blockVisible(view, mode, tab)) continue;
      const list = out.get(tab) ?? [];
      list.push({ record, block });
      out.set(tab, list);
    }
  }
  // Сверху вниз: адрес, заголовки, тело. Адрес запроса стоит и над ответом: видно, кому отвечали.
  const address = out.get('request')?.find((b) => b.block.name === 'request');
  if (address && out.has('response')) out.get('response')!.push(address);
  const rank = (b: StepBlock) => (b.block.name === 'request' ? 0 : b.block.name === 'headers' ? 1 : 2);
  for (const list of out.values()) list.sort((a, b) => rank(a) - rank(b));
  return new Map(DETAIL_TABS.filter((t) => out.has(t)).map((t) => [t, out.get(t)!]));
}

/** Вкладка, открытая сразу: у обмена с ответом — ответ, у лога — контекст, иначе запрос. */
export function defaultTab(step: TraceStep, tabs: readonly DetailTab[]): DetailTab {
  const prefer: DetailTab[] =
    step.kind === 'exchange' ? ['response', 'request'] : step.kind === 'log' ? ['context', 'raw'] : ['request', 'context'];
  return prefer.find((t) => tabs.includes(t)) ?? tabs[0] ?? 'raw';
}

/**
 * Шаг, выбранный при открытии: первая ошибка среди шагов, затем ошибка записи-лога, затем вход, затем первый шаг.
 * Ошибка — с учётом справочника: шаг, снятый правилом итога или «не ошибкой», настоящую ошибку не перекрывает.
 */
export function defaultSelection(trace: Trace, byId: ReadonlyMap<string, ViewRecord> = new Map(), steps: readonly TraceStep[] = trace.steps): string | null {
  const failed = (x: TraceStep) => stepIsError(x, stepCatalog(x, byId)) || (x.noResponse && !x.pending);
  const s =
    steps.find((x) => x.kind !== 'log' && failed(x)) ??
    steps.find(failed) ??
    steps.find((x) => x.kind === 'incoming') ??
    steps[0];
  return s?.id ?? null;
}

/**
 * Шаги шкалы в режиме. Обычные записи-логи есть, пока блок логов включён; лог с ошибкой остаётся всегда: это часть
 * последовательности, а иногда единственная причина. Поток только из логов показывается целиком: шкала не бывает пустой.
 */
export function visibleSteps(trace: Trace, byId: ReadonlyMap<string, ViewRecord>, logs: boolean): readonly TraceStep[] {
  if (logs) return trace.steps;
  const kept = trace.steps.filter((s) => s.kind !== 'log' || stepIsError(s, stepCatalog(s, byId)));
  return kept.length > 0 ? kept : trace.steps;
}

/** Соседний шаг для J и K. На краю остаётся на месте; выбраны логи приложения, которых нет в списке, — первый шаг. */
export function neighbourStep(steps: readonly { id: string }[], selected: string | null, delta: 1 | -1): string | null {
  const i = steps.findIndex((s) => s.id === selected);
  const next = i < 0 ? steps[0] : steps[Math.max(0, Math.min(steps.length - 1, i + delta))];
  return next?.id ?? null;
}

export const DANGER_LEVELS: ReadonlySet<string> = new Set(['ERROR', 'CRITICAL', 'ALERT', 'EMERGENCY']);
const MAX_ERROR_TEXT = 200;

/** Текст ошибки шага: бизнес-ошибка из тела ответа, HTTP-статус, уровень записи. */
export function errorText(step: TraceStep, byId: ReadonlyMap<string, ViewRecord>): string | null {
  if (!step.isError) return null;
  const records = stepRecords(step, byId);
  for (const r of records) {
    if (r.kind !== 'response' || r.sections.body === null) continue;
    try {
      const text = businessError(r.sections.body);
      if (text) return text;
    } catch {
      // Тело не разобралось — ошибка видна по статусу или уровню.
    }
  }
  if (step.status !== null && step.status >= 400) return httpStatusText(step.status);
  const leveled = records.find((r) => r.isError && r.level);
  if (leveled) {
    // Текста записи нет (роль «Бизнес»): один уровень ничего не объясняет, итог назовёт общее слово.
    const message = withoutHtmlShown(leveled.message).trim();
    if (!message) return null;
    const text = `${leveled.level}: ${message}`.replace(/\s+/g, ' ');
    return text.length > MAX_ERROR_TEXT ? `${text.slice(0, MAX_ERROR_TEXT - 1)}…` : text;
  }
  return null;
}

export type OutcomeTone = 'success' | 'danger' | 'warning' | 'neutral';

/** Итог шага в одном месте: что случилось, статус и длительность. */
export interface Outcome {
  tone: OutcomeTone;
  /** «OK», текст ошибки или «ответ в логах не найден»; null — у шага нет своего итога (вход, вызов, лог без ошибки). */
  label: string | null;
  status: number | null;
  durationMs: number | null;
}

export function stepOutcome(step: TraceStep, byId: ReadonlyMap<string, ViewRecord>): Outcome {
  const base = { status: step.status, durationMs: step.durationMs };
  if (step.kind === 'exchange') {
    const orphan = byId.get(step.recordIds[0] ?? '')?.kind === 'response';
    if (step.noResponse) return { ...base, tone: step.pending ? 'neutral' : 'danger', label: i18n.t(noAnswerKey(step)) };
    if (step.isError) {
      // Ошибка только по статусу: статус уже в цифрах рядом, в тексте — его смысл.
      const text = errorText(step, byId);
      const meaning = step.status !== null && text === httpStatusText(step.status) ? statusMeaning(step.status) : null;
      return { ...base, tone: 'danger', label: meaning ? upperFirst(meaning) : (text ?? upperFirst(i18n.t('requests.status.error'))) };
    }
    if (orphan) return { ...base, durationMs: null, tone: 'warning', label: i18n.t('trace.noSend') };
    if (step.status !== null && step.status >= 200 && step.status < 300) return { ...base, tone: 'success', label: i18n.t('trace.ok') };
    return { ...base, tone: 'neutral', label: step.status !== null ? httpStatusText(step.status) : null };
  }
  if (step.isError) return { ...base, tone: 'danger', label: step.kind === 'log' ? null : (errorText(step, byId) ?? upperFirst(i18n.t('requests.status.error'))) };
  return { ...base, tone: 'neutral', label: null };
}

/** Операция обмена: имя вызова, внутри которого он идёт (getRealCard); без вызова — null. */
export function operationOf(step: TraceStep, trace: Trace): string | null {
  if (step.kind !== 'exchange' || !step.parentId) return null;
  const parent = trace.steps.find((s) => s.id === step.parentId);
  return parent?.kind === 'call' ? parent.title || null : null;
}

/** Хост обмена с нестандартным портом, как в адресе записи: «processor.pay.example:8443». */
export function exchangeHost(step: TraceStep, byId: ReadonlyMap<string, ViewRecord>): string | null {
  const uri = byId.get(step.recordIds[0] ?? '')?.http?.uri;
  return uri ? compactHost(uri) || step.system : step.system;
}

/**
 * Операции обменов по адресу «POST host:port/path», как он записан в причине ошибки запроса.
 * Причина с сервера знает только адрес; имя операции есть в трассе.
 */
export function operationsByTarget(trace: Trace, byId: ReadonlyMap<string, ViewRecord>): Map<string, string> {
  const out = new Map<string, string>();
  for (const step of trace.steps) {
    const op = operationOf(step, trace);
    const title = byId.get(step.recordIds[0] ?? '')?.title.replace(/ → \d{3}$/, '');
    if (op && title && (!out.has(title) || step.isError)) out.set(title, op);
  }
  return out;
}

/** Сводка над графом и в панели шага: откуда пришёл вход и логи приложения. */
export interface AppSummary {
  /** Откуда пришёл вход: «шлюз» или компонент; null — входа нет. */
  entrySource: string | null;
  app: { component: string | null; recordCount: number; logs: TraceStep[]; warnings: number; errors: number };
}

export function appSummary(trace: Trace, records: readonly ViewRecord[]): AppSummary {
  const byId = new Map(records.map((r) => [r.id, r]));
  const entry = trace.steps.find((s) => s.kind === 'incoming' && s.parentId === null) ?? null;
  const appRecords = records.filter((r) => !r.gateway);
  const entryRecord = entry ? byId.get(entry.id) : undefined;
  // Компонент шлюза — метка его контейнера (на проде — server): это не приложение запроса.
  const viaGateway = entryRecord?.gateway ?? false;
  const logs = trace.steps.filter((s) => s.kind === 'log');
  let warnings = 0;
  let errors = 0;
  for (const l of logs) {
    const level = byId.get(l.id)?.level?.toUpperCase();
    if (level === 'WARNING') warnings++;
    else if (level && DANGER_LEVELS.has(level)) errors++;
  }
  return {
    entrySource: entry ? (viaGateway ? i18n.t('trace.scheme.gateway') : entry.system) : null,
    app: {
      component: appRecords.find((r) => r.component)?.component ?? (viaGateway ? null : (entry?.system ?? null)),
      recordCount: appRecords.length,
      logs,
      warnings,
      errors,
    },
  };
}

/** Деления шкалы: 0, ¼, ½, ¾ и всё время запроса. */
export function axisTicks(totalMs: number): number[] {
  return [0, 0.25, 0.5, 0.75, 1].map((f) => f * totalMs);
}

const decimals = (n: number) => numberFormat({ maximumFractionDigits: n, useGrouping: 'min2' });

/** Подпись деления: точность — по длине всей шкалы. */
export function formatTick(ms: number, totalMs: number): string {
  const t = i18n.t;
  if (totalMs < 1000) return t('units.ms', { value: decimals(totalMs < 10 ? 1 : 0).format(ms) });
  return t('units.s', { value: decimals(totalMs < 10_000 ? 2 : 1).format(ms / 1000) });
}

/** Положение на шкале в процентах. */
export function percent(ms: number, totalMs: number): number {
  if (totalMs <= 0) return 0;
  return Math.min(100, Math.max(0, (ms / totalMs) * 100));
}
