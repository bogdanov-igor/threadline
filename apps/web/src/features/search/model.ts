// Чистая логика панели поиска и результатов: значения, период, слияние опроса, сообщения.
import { isSaneEpochMs, MAX_INPUT_YEAR, MIN_INPUT_YEAR } from '@threadline/core';
import {
  detectTerm,
  type EnvSearchPart,
  MAX_PERIOD_MS,
  MAX_TERMS,
  validateExcludes,
  validateTerms,
  type PeriodPreset,
  type RequestSummary,
  type SearchRequestBody,
  type SearchState,
  type Term,
  type TermError,
  type TermKind,
} from '@threadline/core/search';
import { localInputToEpoch, type LogTimeError } from '../../lib/zoned-time.ts';

// ---------- Значения ----------

export interface TermChip {
  id: string;
  /** Введённое значение. Живёт только в памяти страницы. null — значение восстановлено с сервера, номер карты скрыт. */
  raw: string | null;
  kind: TermKind;
  /** Что видно в поле: номер карты — маской. */
  display: string;
  /** По нему убираются повторы. */
  value: string;
}

export type InputError = TermError | 'too-many';
export type SubmitError = InputError | 'empty' | 'need-long' | 'pan-hidden';
export type ExcludeError = InputError | 'conflict' | 'pan-hidden';

let seq = 0;
const nextId = () => `c${++seq}`;

/** Значения из поля или вставки: через запятую или с новой строки. */
export function splitTerms(text: string): string[] {
  return text
    .split(/[,\n\r\t]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

type Detect = (raw: string) => Term | { error: TermError };

/**
 * Добавляет значения из текста. Первое непринятое значение и всё после него остаются в поле (rest),
 * чтобы пользователь поправил его, а не набирал заново.
 */
export function addTerms(chips: TermChip[], text: string, detect: Detect = detectTerm): { chips: TermChip[]; rest: string; error: InputError | null } {
  const parts = splitTerms(text);
  const out = [...chips];
  for (const [i, part] of parts.entries()) {
    const t = detect(part);
    const rest = () => parts.slice(i).join(', ');
    if ('error' in t) return { chips: out, rest: rest(), error: t.error };
    if (out.some((c) => c.value === t.value)) continue;
    if (out.length >= MAX_TERMS) return { chips: out, rest: rest(), error: 'too-many' };
    out.push({ id: nextId(), raw: part, kind: t.kind, display: t.display, value: t.value });
  }
  return { chips: out, rest: '', error: null };
}

/** Значения из состояния поиска после перезагрузки: полного номера карты там нет. */
export function chipsFromState(terms: SearchState['terms']): TermChip[] {
  return terms.map((t) => ({ id: nextId(), raw: t.kind === 'pan' ? null : t.display, kind: t.kind, display: t.display, value: t.display }));
}

export function checkChips(chips: TermChip[]): { ok: true; raws: string[] } | { ok: false; error: SubmitError; chipId?: string } {
  const hidden = chips.find((c) => c.raw === null);
  if (hidden) return { ok: false, error: 'pan-hidden', chipId: hidden.id };
  const raws = chips.map((c) => c.raw ?? '');
  const v = validateTerms(raws);
  if (v.ok) return { ok: true, raws };
  if (typeof v.error === 'string') return { ok: false, error: v.error };
  const chip = chips[v.error.index];
  return { ok: false, error: v.error.error, ...(chip ? { chipId: chip.id } : {}) };
}

/** Исключённые значения: те же проверки, что на сервере. termRaws — уже проверенные значения поиска. */
export function checkExcludes(chips: TermChip[], termRaws: string[]): { ok: true; raws: string[] } | { ok: false; error: ExcludeError; chipId?: string } {
  const hidden = chips.find((c) => c.raw === null);
  if (hidden) return { ok: false, error: 'pan-hidden', chipId: hidden.id };
  const raws = chips.map((c) => c.raw ?? '');
  const terms = validateTerms(termRaws);
  const v = validateExcludes(raws, terms.ok ? terms.terms : []);
  if (v.ok) return { ok: true, raws };
  if (v.error === 'too-many') return { ok: false, error: 'too-many' };
  const chip = chips[v.error.index];
  return { ok: false, error: v.error.error, ...(chip ? { chipId: chip.id } : {}) };
}

export const isCardKind = (kind: TermKind) => kind === 'pan' || kind === 'number' || kind === 'pan-mask';

// ---------- Период ----------

/** Отступ периода вокруг времени: другие значения — режим границ. */
export const AROUND_MINUTES = [5, 15, 30, 60] as const;
export type AroundMinutes = (typeof AROUND_MINUTES)[number];
export const DEFAULT_AROUND: AroundMinutes = 15;

/** Как период задан в окне: только в памяти вкладки, на сервер и в адрес не идёт. */
export interface AroundChoice {
  atMs: number;
  minutes: AroundMinutes;
  text: string;
}

export type PeriodChoice = { preset: PeriodPreset } | { fromMs: number; toMs: number; around?: AroundChoice };
export type PeriodError = 'incomplete' | 'year' | 'reversed' | 'future' | 'too-long' | 'too-old' | 'not-yet' | LogTimeError;
export type PeriodField = 'from' | 'to';

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

/** Проверка своего периода, как на сервере. Конец в будущем допустим: сервер ищет до текущего момента. */
export function checkCustomPeriod(fromMs: number | null, toMs: number | null, nowMs: number, retentionDays: number): PeriodError | null {
  if (fromMs === null || toMs === null) return 'incomplete';
  if (fromMs >= toMs) return 'reversed';
  if (fromMs >= nowMs) return 'future';
  if (toMs - fromMs > MAX_PERIOD_MS) return 'too-long';
  if (fromMs < nowMs - retentionDays * DAY) return 'too-old';
  return null;
}

/** Год значения поля вне 2000–2099. Браузер без предела в сегменте года отдаёт и «202333-11-06T03:33». */
function badYear(value: string): boolean {
  const year = /^\+?(\d+)-/.exec(value)?.[1];
  return year !== undefined && (Number(year) < MIN_INPUT_YEAR || Number(year) > MAX_INPUT_YEAR);
}

/**
 * Два поля своего периода: что не так и у какого поля. Пустое и заполненное не до конца значения браузер отдаёт одинаково, пустой строкой: сообщение одно.
 * Начало позже конца, слишком длинный и слишком старый период правятся в начале.
 */
export function checkPeriodFields(from: string, to: string, timeZone: string, nowMs: number, retentionDays: number): { ok: true; fromMs: number; toMs: number } | { ok: false; error: PeriodError; field: PeriodField } {
  if (from === '') return { ok: false, error: 'incomplete', field: 'from' };
  if (to === '') return { ok: false, error: 'incomplete', field: 'to' };
  if (badYear(from)) return { ok: false, error: 'year', field: 'from' };
  if (badYear(to)) return { ok: false, error: 'year', field: 'to' };
  const fromMs = localInputToEpoch(from, timeZone);
  const toMs = localInputToEpoch(to, timeZone);
  if (fromMs === null || !isSaneEpochMs(fromMs)) return { ok: false, error: 'incomplete', field: 'from' };
  if (toMs === null || !isSaneEpochMs(toMs)) return { ok: false, error: 'incomplete', field: 'to' };
  const error = checkCustomPeriod(fromMs, toMs, nowMs, retentionDays);
  return error ? { ok: false, error, field: 'from' } : { ok: true, fromMs, toMs };
}

/** Границы складываются из моментов, поэтому переход часов в поясе проекта на них не влияет. */
export function aroundBounds(atMs: number, minutes: number): { fromMs: number; toMs: number } {
  return { fromMs: atMs - minutes * MINUTE, toMs: atMs + minutes * MINUTE };
}

/** Те же проверки, что у своего периода, и ещё одна: время позже текущего больше чем на минуту почти всегда ошибка. */
export function checkAround(atMs: number, minutes: number, nowMs: number, retentionDays: number): PeriodError | null {
  if (atMs > nowMs + MINUTE) return 'not-yet';
  const { fromMs, toMs } = aroundBounds(atMs, minutes);
  return checkCustomPeriod(fromMs, toMs, nowMs, retentionDays);
}

export const isPreset = (p: PeriodChoice): p is Extract<PeriodChoice, { preset: PeriodPreset }> => 'preset' in p;

export function periodBody(p: PeriodChoice): SearchRequestBody['period'] {
  return isPreset(p) ? { preset: p.preset } : { fromMs: p.fromMs, toMs: p.toMs };
}

export function periodFromState(period: SearchState['period']): PeriodChoice {
  return period.preset ? { preset: period.preset } : { fromMs: period.fromMs, toMs: period.toMs };
}

// ---------- Результаты ----------

/** Опрос отдаёт запросы с индекса from: дописываем их к уже полученным. */
export function mergeSearchState(prev: SearchState | undefined, next: SearchState, from: number): SearchState {
  if (!prev || from === 0 || prev.id !== next.id) return next;
  // Сервер отдал список целиком — берём его как есть.
  if (from + next.requests.length > next.requestsTotal) return next;
  return { ...next, requests: [...prev.requests.slice(0, from), ...next.requests] };
}

export const errorCount = (requests: RequestSummary[]) => requests.reduce((n, r) => n + (r.status === 'error' ? 1 : 0), 0);

/** От новых к старым; при равном времени — correlation_id, затем порядок сред: envOrder — среды поиска по нескольким средам. */
export const newestFirst = (requests: RequestSummary[], envOrder: readonly string[] = []) =>
  [...requests].sort((a, b) => b.firstMs - a.firstMs || a.correlationId.localeCompare(b.correlationId) || envOrder.indexOf(a.env ?? '') - envOrder.indexOf(b.env ?? ''));

export type Notice = 'too-many' | 'error' | 'cancelled' | 'truncated' | 'empty' | 'only-lines';

/** Какие сообщения показать над результатом, в порядке важности. */
export function noticesOf(s: SearchState): Notice[] {
  const out: Notice[] = [];
  if (s.tooMany) out.push('too-many');
  if (s.error) out.push('error');
  if (s.status === 'cancelled') out.push('cancelled');
  if (s.truncated) out.push('truncated');
  if (s.status === 'done' && !s.tooMany && !s.error && s.requestsTotal === 0) out.push(s.lines === 'some' ? 'only-lines' : 'empty');
  return out;
}

/** Сообщения поиска по нескольким средам: у каждой среды свои, общие — остановка, пустой результат и сбой всех сред. */
export interface MultiNotices {
  group: Notice[];
  parts: { part: EnvSearchPart; notices: Notice[] }[];
}

/**
 * Предел запросов, ошибка и предел строк говорит сообщение своей среды. «Ничего не нашлось» и «только строки без correlation_id» — только когда
 * ни одна среда не упала и не упёрлась в предел. Общая ошибка есть, только если не удалось ни в одной среде.
 */
export function multiNoticesOf(s: SearchState): MultiNotices {
  const parts = (s.envs ?? []).map((part) => {
    const notices: Notice[] = [];
    if (part.tooMany) notices.push('too-many');
    if (part.error) notices.push('error');
    if (part.truncated) notices.push('truncated');
    return { part, notices };
  });
  const group: Notice[] = [];
  if (s.error) group.push('error');
  if (s.status === 'cancelled') group.push('cancelled');
  const clean = (s.envs ?? []).every((p) => !p.error && !p.tooMany);
  if (s.status === 'done' && clean && s.requestsTotal === 0) group.push(s.lines === 'some' ? 'only-lines' : 'empty');
  return { group, parts };
}

/** Состояние части как состояние поиска одной среды: сообщения среды показываются тем же видом. */
export function partState(s: SearchState, p: EnvSearchPart): SearchState {
  const { envs: _envs, ...rest } = s;
  return { ...rest, status: p.status, stage: p.stage, found: p.found, tooMany: p.tooMany, truncated: p.truncated, ...(p.truncatedBy ? { truncatedBy: p.truncatedBy } : {}), scannedFromMs: p.scannedFromMs, lines: p.lines, progress: p.progress, requestsTotal: p.requestsTotal, error: p.error, ...(p.excluding ? { excluding: p.excluding } : {}), requests: [] };
}

/** Доля выполненного: первый проход — первая половина полосы, второй — вторая. */
export function progressOf(s: SearchState): number {
  if (s.status !== 'running') return 1;
  const p = s.progress;
  const count = p.chunksTotal > 0 ? p.chunksDone / p.chunksTotal : 0;
  if (s.stage === 'count') return count / 2;
  const fetch = p.batchesTotal > 0 ? p.batchesDone / p.batchesTotal : 0;
  return 0.5 + fetch / 2;
}

