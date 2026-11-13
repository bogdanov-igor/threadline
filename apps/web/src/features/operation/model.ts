// Модель страницы операции и переходов между её потоками.
// Чистые функции: адрес страницы, разбор адреса, список потоков, соседние и более поздние потоки.
import { MAX_EPOCH_MS } from '@threadline/core';
import type { OperationKey } from '@threadline/core/search';
import type { FlowCatalogStatus, OperationFlow, OperationItem, OperationView, RelatedFlow } from '@threadline/core/flow';
import { shareRequestLink, type ShareMode } from '@/features/share/mode.ts';
import { timeParts } from '@/lib/format.ts';
import { envPath, requestPath, type Selection } from '@/lib/selection.ts';

export type OperationWindow = '6h' | '24h';

/** Как на сервере: id операции — 6–128 символов A-Z, a-z, 0-9, «.», «_», «:», «-». */
export const OPERATION_VALUE = /^[A-Za-z0-9._:-]{6,128}$/;
const VALUE_CHARS = /^[A-Za-z0-9._:-]{1,128}$/;
const TYPE = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_ALSO = 2;

export interface OperationAddress {
  type: string;
  value: string;
  atMs: number;
  window: OperationWindow;
  /** Значения других типов той же операции. */
  also: { type: string; value: string }[];
  searchId: string | null;
}

export type ParsedAddress =
  { ok: true; address: OperationAddress } | { ok: false; reason: 'short' | 'bad-link' };

/** Адрес страницы операции: /:project/:env[/:stand]/operations/:type/:value?at=&w=&also=&search=. */
export function operationPath(
  project: string,
  env: string,
  stand: string | undefined,
  a: {
    type: string;
    value: string;
    atMs: number;
    window?: OperationWindow;
    also?: readonly { type: string; value: string }[];
    searchId?: string | null;
  },
): string {
  const qs = new URLSearchParams({ at: String(Math.floor(a.atMs)), w: a.window ?? '6h' });
  for (const x of (a.also ?? []).slice(0, MAX_ALSO)) qs.append('also', `${x.type}:${x.value}`);
  if (a.searchId) qs.set('search', a.searchId);
  return `${envPath(project, env, stand)}/operations/${encodeURIComponent(a.type)}/${encodeURIComponent(a.value)}?${qs}`;
}

/** Разбор адреса до обращения к серверу: короткое значение — своё сообщение, остальное неверное — «ссылка неверная». */
export function parseOperationAddress(
  type: string | undefined,
  value: string | undefined,
  qs: URLSearchParams,
): ParsedAddress {
  if (!type || !TYPE.test(type) || !value || !VALUE_CHARS.test(value))
    return { ok: false, reason: 'bad-link' };
  if (value.length < 6) return { ok: false, reason: 'short' };
  const at = qs.get('at');
  if (at === null || !/^\d{1,16}$/.test(at) || Number(at) >= MAX_EPOCH_MS) return { ok: false, reason: 'bad-link' };
  const w = qs.get('w');
  const also: { type: string; value: string }[] = [];
  for (const raw of qs.getAll('also').slice(0, MAX_ALSO)) {
    const i = raw.indexOf(':');
    const t = raw.slice(0, i);
    const v = raw.slice(i + 1);
    if (i > 0 && TYPE.test(t) && OPERATION_VALUE.test(v)) also.push({ type: t, value: v });
  }
  const search = qs.get('search');
  return {
    ok: true,
    address: {
      type,
      value,
      atMs: Number(at),
      window: w === '24h' ? '24h' : '6h',
      also,
      searchId: search && /^[A-Za-z0-9_-]{1,64}$/.test(search) ? search : null,
    },
  };
}

/** Что открывает кнопка «Открыть операцию»: выбор между значениями одного типа и id других типов той же операции. */
export interface OperationChoice {
  /** Одно значение — одна операция; несколько значений одного типа — выбор. */
  choices: OperationKey[];
  also: { type: string; value: string }[];
}

/**
 * Ключи разных типов на одном шаге — одна операция (наш id и id внешней системы), несколько значений одного типа —
 * разные операции (джоба по рассрочкам). Выбор — по первому типу с несколькими значениями, иначе по первому ключу.
 */
export function chooseOperation(keys: readonly OperationKey[]): OperationChoice | null {
  if (keys.length === 0) return null;
  const types = [...new Set(keys.map((k) => k.type))];
  const many = types.find((t) => keys.filter((k) => k.type === t).length > 1);
  const mainType = many ?? keys[0]!.type;
  const choices = keys.filter((k) => k.type === mainType);
  const also = keys
    .filter((k) => k.type !== mainType && !k.masked && keys.filter((x) => x.type === k.type).length === 1)
    .slice(0, MAX_ALSO)
    .map((k) => ({ type: k.type, value: k.value }));
  return { choices, also };
}

/** Потоки операции по порядку списка: группы раскрыты, опросы партнёра и непрочитанные — не потоки. */
export function flowsOf(view: OperationView | null | undefined): OperationFlow[] {
  if (!view) return [];
  return view.items.flatMap((it: OperationItem) =>
    it.kind === 'flow' ? [it] : it.kind === 'group' ? it.flows : [],
  );
}

/** Ключ потока в списке: correlation_id и номер сегмента. */
export const flowKey = (f: { cid: string; segment: number | null }) =>
  f.segment === null ? f.cid : `${f.cid}#${f.segment}`;

/** Буква строки таблицы: A…Z, затем AA, AB. */
export function rowLetter(i: number): string {
  let n = i;
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/** Буквы таблицы: у строки потока и группы своя буква, у потока группы буква и номер, у опросов и непрочитанного буквы нет. */
export function lettersOf(items: readonly OperationItem[]): { rows: (string | null)[]; flows: Map<string, string> } {
  const rows: (string | null)[] = [];
  const flows = new Map<string, string>();
  let n = 0;
  for (const it of items) {
    if (it.kind === 'flow') {
      const letter = rowLetter(n++);
      rows.push(letter);
      flows.set(flowKey(it), letter);
    } else if (it.kind === 'group') {
      const letter = rowLetter(n++);
      rows.push(letter);
      it.flows.forEach((f, i) => flows.set(flowKey(f), `${letter}${i + 1}`));
    } else rows.push(null);
  }
  return { rows, flows };
}

export interface OperationScale {
  fromMs: number;
  spanMs: number;
}

/**
 * Общая шкала: от начала первого запроса до конца последнего. Опросы партнёра и непрочитанные отрезки известны с точностью
 * до куска поиска и шкалу не растягивают, иначе запросы слиплись бы в одну точку. Шкалу они задают, только если запросов нет.
 */
export function scaleOf(items: readonly OperationItem[]): OperationScale | null {
  const flows = items.flatMap((it) => (it.kind === 'flow' ? [it] : it.kind === 'group' ? it.flows : []));
  const spans: { from: number; to: number }[] = flows.length > 0
    ? flows.map((f) => ({ from: f.firstMs, to: f.lastMs }))
    : items.flatMap((it) => (it.kind === 'polls' || it.kind === 'unread' ? [{ from: it.fromMs, to: it.toMs }] : []));
  if (spans.length === 0) return null;
  const fromMs = Math.min(...spans.map((x) => x.from));
  const toMs = Math.max(...spans.map((x) => x.to));
  return { fromMs, spanMs: Math.max(0, toMs - fromMs) };
}

/** Положение на шкале в процентах. Вне шкалы метка прижимается к краю. Метка короче 4 px растягивается в разметке. */
export function barOf(scale: OperationScale, fromMs: number, toMs: number): { left: number; width: number } {
  if (scale.spanMs <= 0) return { left: 0, width: 0 };
  const at = (ms: number) => Math.min(100, Math.max(0, ((ms - scale.fromMs) / scale.spanMs) * 100));
  const left = at(fromMs);
  return { left, width: Math.max(0, at(toMs) - left) };
}

/**
 * С какой стороны отрезок выходит за шкалу. Так бывает у опросов партнёра: их время известно с точностью до куска подсчёта,
 * а шкала идёт по прочитанным запросам. На обрезанной стороне полоса открыта, иначе край шкалы читался бы как конец опросов.
 */
export function cutOf(scale: OperationScale, fromMs: number, toMs: number): { start: boolean; end: boolean } {
  return { start: fromMs < scale.fromMs, end: toMs > scale.fromMs + scale.spanMs };
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const TICK_STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 500, SECOND, 2 * SECOND, 5 * SECOND, 10 * SECOND, 15 * SECOND, 30 * SECOND, MINUTE, 2 * MINUTE, 5 * MINUTE, 10 * MINUTE, 15 * MINUTE, 30 * MINUTE, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, 24 * HOUR];

/** Подписи шкалы: 0, середина и конец круглыми значениями. Шаг самый крупный, при котором два шага ещё на шкале. */
export function scaleTicks(spanMs: number): { ms: number; left: number }[] {
  const step = [...TICK_STEPS].reverse().find((s) => 2 * s <= spanMs);
  if (!step) return [{ ms: 0, left: 0 }];
  return [0, step, 2 * step].map((ms) => ({ ms, left: (ms / spanMs) * 100 }));
}

/** Типы id, по которым связаны потоки операции: сначала ключ, затем дополнения и связи строк, без повторов. */
export function linkedTypes(view: OperationView): string[] {
  const types = [view.key.type, ...view.key.also.map((a) => a.type), ...flowsOf(view).flatMap((f) => f.linkedBy.map((l) => l.type))];
  return [...new Set(types)];
}

/** Ключ операции, который совпал со значением поиска: по нему над результатами стоит строка операции. Скрытый маскированием не годится. */
export function operationKeyOfTerm(keys: readonly OperationKey[] | undefined, term: string): OperationKey | null {
  return keys?.find((k) => !k.masked && k.value === term) ?? null;
}

/** Название типа id: из ключа операции, дополнения или найденных id; иначе сам тип. */
export function typeName(view: OperationView, type: string): string {
  if (view.key.type === type && view.key.name) return view.key.name;
  return (
    view.key.also.find((a) => a.type === type)?.name ??
    view.extraIds.find((a) => a.type === type)?.name ??
    type
  );
}

/** Поток по ключу; ключ без сегмента (ссылка без состояния) — первый сегмент этого correlation_id. */
function indexOfFlow(flows: readonly OperationFlow[], key: string): number {
  const exact = flows.findIndex((f) => flowKey(f) === key);
  if (exact >= 0) return exact;
  const cid = key.split('#')[0];
  return flows.findIndex((f) => f.cid === cid);
}

/** «Поток N из M» и соседи по ключу потока (correlation_id и сегмент); поток не из операции — null. */
export function positionOf(
  view: OperationView | null | undefined,
  key: string,
): { index: number; total: number; prev: OperationFlow | null; next: OperationFlow | null } | null {
  const flows = flowsOf(view);
  const i = indexOfFlow(flows, key);
  if (i < 0) return null;
  return { index: i + 1, total: flows.length, prev: flows[i - 1] ?? null, next: flows[i + 1] ?? null };
}

/**
 * Более поздние потоки операции для узлов-ссылок графа: после открытого, без «id в тексте записи». Ранние
 * потоки на графе не рисуются, их покрывают «← К операции» и «Поток N из M».
 */
export function relatedAfter(view: OperationView | null | undefined, key: string): RelatedFlow[] {
  if (!view) return [];
  const flows = flowsOf(view);
  const i = indexOfFlow(flows, key);
  if (i < 0) return [];
  const cid = flows[i]!.cid;
  return flows
    .slice(i + 1)
    .filter((f) => f.role !== 'mention' && f.cid !== cid)
    .map((f) => {
      const type = f.linkedBy[0]?.type ?? view.key.type;
      return {
        cid: f.cid,
        segment: f.segment,
        role: f.role,
        title: f.title,
        ...(f.titleCode ? { titleCode: f.titleCode } : {}),
        firstMs: f.firstMs,
        lastMs: f.lastMs,
        error: f.error,
        opStatus: f.opStatus,
        claimed: f.claimed,
        key: { type, name: typeName(view, type) },
      };
    });
}

/** Состояние перехода со страницы операции на её поток: задание поиска и адрес возврата. */
export interface OperationLinkState {
  searchId: string;
  /** step — первая запись потока или сегмента: шаг, выбранный при открытии; segment — какой сегмент открыт. */
  operation: { href: string; step?: string | null; segment?: number | null };
}

/** Состояние перехода к конкретному потоку: с его первым шагом. */
export const linkTo = (
  link: OperationLinkState,
  f: { firstRecordId?: string | null; segment?: number | null },
): OperationLinkState => ({
  searchId: link.searchId,
  operation: { href: link.operation.href, step: f.firstRecordId ?? null, segment: f.segment ?? null },
});

export function readOperationLink(state: unknown): OperationLinkState | null {
  const s = state as { searchId?: unknown; operation?: { href?: unknown; step?: unknown; segment?: unknown } } | null;
  if (typeof s?.searchId !== 'string' || !s.searchId) return null;
  const href = s.operation?.href;
  if (typeof href !== 'string' || !href.startsWith('/') || href.startsWith('//')) return null;
  const step = s.operation?.step;
  const segment = s.operation?.segment;
  return {
    searchId: s.searchId,
    operation: { href, step: typeof step === 'string' && step ? step : null, segment: typeof segment === 'number' ? segment : null },
  };
}

/**
 * Куда ведёт уход со страницы операции или её потока: на саму операцию с тем же моментом и окном или на её поток?
 * Такой переход поиск не останавливает.
 */
export function staysInOperation(
  href: string,
  searchId: string,
  to: { pathname: string; search: string; state: unknown },
): boolean {
  if ((to.state as { searchId?: unknown } | null)?.searchId === searchId) return true;
  const here = new URL(href, 'http://x');
  if (to.pathname !== here.pathname) return false;
  const qs = new URLSearchParams(to.search);
  return qs.get('at') === here.searchParams.get('at') && qs.get('w') === here.searchParams.get('w');
}

/** Сегмент записей без correlation_id: открывается только из задания операции. */
export const isNocid = (cid: string) => cid.startsWith('nocid:');

/** Ссылка на поток операции; у сегмента без correlation_id — с адресом операции, чтобы предложить открыть её заново. */
export function flowPath(
  project: string,
  env: string,
  stand: string | undefined,
  f: OperationFlow,
  operationHref: string,
): string {
  const base = requestPath(project, env, stand, f.cid, f.firstMs, f.lastMs);
  if (!isNocid(f.cid)) return base;
  return `${base}&op=${encodeURIComponent(operationHref.replace(/[?&]search=[^&]*/, ''))}`;
}

/** Куда ведёт запрос операции: адрес и состояние перехода. На странице короткой ссылки адрес внутри неё. */
export function flowTarget(share: ShareMode | null, { project, env, stand }: Selection, link: OperationLinkState, f: OperationFlow): { to: string; state: unknown } {
  return share
    ? shareRequestLink(share, { cid: f.cid, segment: f.segment, step: f.firstRecordId })
    : { to: flowPath(project.id, env.id, stand, f, link.operation.href), state: linkTo(link, f) };
}

/** Адрес операции из ссылки сегмента без correlation_id: только путь этого же приложения. */
export function readOperationHref(raw: string | null): string | null {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || !raw.includes('/operations/')) return null;
  return raw;
}

/**
 * Идут ли сами запросы через полночь: тогда в строках дата вместо секунд. Окно поиска через полночь ещё ничего не значит,
 * иначе дата вытесняла бы секунды у всех строк, а запрос в 02:16 не отличался бы от запроса в 02:16:40.
 */
export function spansDays(items: readonly OperationItem[], tz: string): boolean {
  const days = new Set<string>();
  for (const x of items) {
    if (x.kind === 'unread') continue;
    for (const ms of x.kind === 'polls' ? [x.fromMs, x.toMs] : [x.firstMs, x.lastMs]) days.add(timeParts(ms, tz).date);
  }
  return days.size > 1;
}

// ---------- Блок «Что случилось» ----------

/** Первое предложение блока: что известно об итоге операции. */
export type SummaryLead = 'failure' | 'claimed' | 'success' | 'pending' | 'unknown' | 'notRead';

export type SummaryPlan =
  /** Причину читаем у этого запроса. */
  | { kind: 'reason'; lead: SummaryLead; flow: OperationFlow }
  /** Запрос ведёт несколько операций: чья первая причина, неизвестно, записи не читаем. */
  | { kind: 'shared'; lead: SummaryLead; flow: OperationFlow }
  /** Итог подтверждён успешным, ошибка была раньше: записи не читаем. */
  | { kind: 'calm'; lead: 'success'; flow: OperationFlow; failed: number }
  /** Отказ только статусом, запросы без ошибок: слова уже в статусе, записи не читаем. */
  | { kind: 'status'; lead: 'failure'; flow: OperationFlow | null; status: FlowCatalogStatus };

/**
 * Что показать в блоке. Запрос с ошибкой считается как outcome.failed: ошибка в шагах этой операции, без упоминаний в тексте записи.
 * Самый ранний, потому что сервисы часто оборачивают настоящую ошибку в свою, а поздние запросы несут только обёртку.
 * interrupted: поиск закончился, но прочитано не всё. null: блока нет.
 */
export function summaryPlan(view: OperationView, interrupted: boolean): SummaryPlan | null {
  const failed = flowsOf(view).filter((f) => f.role !== 'mention' && f.error);
  const o = view.outcome;
  const flow = failed.reduce<OperationFlow | null>((first, f) => (first === null || f.firstMs < first.firstMs ? f : first), null);
  if (!flow) {
    if (o.kind !== 'failure' || !o.status) return null;
    return { kind: 'status', lead: 'failure', flow: flowsOf(view).find((f) => f.cid === o.cid) ?? null, status: o.status };
  }
  if (o.kind === 'success' && o.basis === 'confirmed') return { kind: 'calm', lead: 'success', flow, failed: failed.length };
  const lead: SummaryLead = o.kind === 'failure' ? 'failure' : o.kind === 'success' ? 'claimed' : o.kind === 'pending' ? 'pending' : interrupted ? 'notRead' : 'unknown';
  return { kind: flow.ops > 1 ? 'shared' : 'reason', lead, flow };
}
