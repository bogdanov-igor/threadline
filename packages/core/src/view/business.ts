// Вид для роли «Бизнес»: ответ собирается из явного списка полей, а не вычёркиванием запрещённых, поэтому новое поле само не уйдёт.
// Запуск идёт после обоих проходов маскирования.
// Здесь нельзя копировать объект целиком ({...r}): правило закрепляет тест. Браузер этот файл не импортирует.

import type { ConnectionResponse, ProjectInfo, ProjectsResponse } from '../api.ts';
import { plainSystem, uriParts } from '../catalog/host.ts';
import { strictPathTemplate } from '../catalog/path.ts';
import type { OperationFlow, OperationItem, OperationKeyValue, OperationView } from '../flow/operation.ts';
import type { CatalogError, CatalogName, CatalogOutcome, CatalogState, CatalogStatus, EnvSearchPart, ErrorReason, RecordCatalog, RequestDetail, RequestSummary, SearchState, ViewRecord } from '../search/api.ts';
import type { Shown, ViewSettings } from './index.ts';

/** Постоянный список уровней: другое значение из записи не уходит. */
const KNOWN_LEVELS = new Set(['TRACE', 'DEBUG', 'INFO', 'NOTICE', 'WARNING', 'WARN', 'ERROR', 'ERR', 'CRITICAL', 'CRIT', 'ALERT', 'EMERGENCY', 'FATAL']);
const levelOf = (level: string | null): string | null => {
  const up = level?.toUpperCase() ?? '';
  return KNOWN_LEVELS.has(up) ? up : null;
};

// ---------- Разметка справочника ----------

function businessName(n: CatalogName): CatalogName {
  const { system, method } = n;
  return {
    source: n.source,
    system: system ? { key: system.key, name: system.name, type: system.type } : null,
    method: method ? { id: method.id, name: method.name, domain: method.domain, kind: method.kind, opType: method.opType ? { key: method.opType.key, name: method.opType.name } : null } : null,
    host: null,
  };
}

/** Заголовок только из справочника. У ошибки по правилу итога title может быть текстом ответа, поэтому там читается safeTitle. */
const errorTitle = (e: CatalogError): string | null => (e.rule?.kind === 'outcome' ? (e.safeTitle ?? null) : e.title);

function businessError(e: CatalogError): CatalogError {
  return { source: e.source, rule: null, title: errorTitle(e), action: e.action, severity: e.severity, partnerCode: null, raw: { http: null, code: null, text: null } };
}

function businessOutcome(o: CatalogOutcome): CatalogOutcome {
  return { kind: o.kind, rule: { id: 0, level: o.rule.level }, text: o.fixed === true ? o.text : null, action: o.action };
}

/** Статус без названия в словаре типа не уходит: значение могло прийти прямо из записи. */
function businessStatus<T extends Pick<CatalogStatus, 'type' | 'value' | 'name' | 'outcome' | 'order'>>(s: T | null): CatalogStatus | null {
  if (!s || s.name === null) return null;
  return { type: s.type, value: s.value, raw: '', name: s.name, outcome: s.outcome, order: s.order };
}

function businessCatalog(c: RecordCatalog): RecordCatalog {
  return {
    name: c.name ? businessName(c.name) : null,
    error: c.error ? businessError(c.error) : null,
    outcome: c.outcome ? businessOutcome(c.outcome) : null,
    ids: c.ids.filter((id) => id.kind === 'operation').map((id) => ({ type: id.type, name: id.name, kind: id.kind, value: id.value, at: id.at })),
    status: businessStatus(c.status),
  };
}

// ---------- Записи запроса ----------

/**
 * Вход с названием из справочника — без адреса, без названия — шаблон пути. Обмен — только система: название шага даёт справочник, без него шаг подписан именем системы.
 * Шаблона пути и имени действия у обмена нет. Системы без имени нет: адреса тоже нет, шаг подписан общими словами.
 */
function businessUri(r: ViewRecord): string | null {
  const uri = r.http?.uri;
  if (!uri) return null;
  if (r.kind === 'incoming') return r.catalog?.name?.method ? null : strictPathTemplate(uriParts(uri).path);
  return r.catalog?.name?.system?.key ?? plainSystem(uri);
}

const NAMED_KINDS: ReadonlySet<ViewRecord['kind']> = new Set(['incoming', 'call', 'send', 'response']);

/** Заголовок только из справочника. */
const businessTitle = (r: ViewRecord): string => (NAMED_KINDS.has(r.kind) ? (r.catalog?.name?.method?.name ?? '') : '');

function businessRecord(r: ViewRecord, alias: (requestId: string | null) => string | null): ViewRecord {
  const out: ViewRecord = {
    id: r.id,
    tsNs: r.tsNs,
    timeMs: r.timeMs,
    offsetMs: r.offsetMs,
    kind: r.kind,
    title: businessTitle(r),
    message: '',
    level: levelOf(r.level),
    isError: r.isError,
    component: null,
    gateway: r.gateway,
    correlationId: r.correlationId,
    requestId: alias(r.requestId),
    http: r.http ? { method: null, uri: businessUri(r), status: null, durationMs: r.http.durationMs, pairId: r.http.pairId, noResponse: r.http.noResponse, pending: r.http.pending } : null,
    sections: { headers: null, body: null, payload: null, context: null },
    raw: '',
    match: null,
  };
  if (r.titleCode) out.titleCode = r.titleCode;
  // Текста записи нет: на шаге общее слово «Запись», а не «Лог».
  else if (!NAMED_KINDS.has(r.kind)) out.titleCode = 'record';
  if (r.catalog) out.catalog = businessCatalog(r.catalog);
  if (r.flow) out.flow = { as: r.flow.as, durationMs: r.flow.durationMs, host: null, title: null };
  return out;
}

/** Шаг для Бизнеса: всё, кроме записей-логов без ошибки и без подсказки шага. */
const isStep = (r: ViewRecord): boolean => (r.kind !== 'log' && r.kind !== 'text') || r.isError || !!r.flow;

/**
 * Записи запроса для Бизнеса. Записи-логи без ошибки не уходят; если других шагов нет, идут все, с пустым заголовком: шкала не пуста.
 * Граф и шкала строятся из результата прежним кодом.
 */
export function businessRecords(view: readonly ViewRecord[]): ViewRecord[] {
  const steps = view.filter(isStep);
  const kept = steps.length > 0 ? steps : view;
  const aliases = new Map<string, string>();
  const alias = (id: string | null) => {
    if (id === null) return null;
    let a = aliases.get(id);
    if (!a) aliases.set(id, (a = `rq${aliases.size + 1}`));
    return a;
  };
  const out = kept.map((r) => businessRecord(r, alias));
  // Записи-логи убраны, а ось та же: её конец идёт отдельным полем у первой записи.
  const end = (list: readonly ViewRecord[]) => list.reduce((m, r) => Math.max(m, r.offsetMs ?? 0), 0);
  const axis = end(view);
  if (out[0] && axis > end(out)) out[0].axisEndMs = axis;
  return out;
}

// ---------- Сводка и причина ошибки ----------

/**
 * Причина: только справочник. Текст правила итога без мест подстановки или заголовок ошибки, иначе пустой текст:
 * интерфейс показывает общие слова по виду причины. Текст из логов и ответов не проходит вообще.
 */
function businessReason(r: ErrorReason): ErrorReason {
  const error = r.error ? businessError(r.error) : r.error;
  const out: ErrorReason = { kind: r.kind, text: error?.title ?? '' };
  if (r.name !== undefined) out.name = r.name ? businessName(r.name) : null;
  if (error !== undefined) out.error = error;
  return out;
}

export function businessSummary(s: RequestSummary): RequestSummary {
  const out: RequestSummary = {
    correlationId: s.correlationId,
    firstMs: s.firstMs,
    lastMs: s.lastMs,
    durationMs: s.durationMs,
    // Название из справочника заменяет адрес: значений пути у такого запроса нет совсем.
    incoming: s.incoming ? { method: '', path: s.incoming.path && !s.entry?.method ? strictPathTemplate(uriParts(s.incoming.path).path) : '' } : null,
    component: null,
    recordCount: 0,
    status: s.status,
    kind: s.kind,
    reasons: s.reasons.map(businessReason),
    match: s.match,
    incomplete: s.incomplete,
  };
  if (s.entry !== undefined) out.entry = s.entry ? businessName(s.entry) : null;
  if (s.env !== undefined) out.env = s.env;
  return out;
}

// ---------- Операция ----------

const keyValue = (v: OperationKeyValue): OperationKeyValue => ({ type: v.type, name: v.name, value: v.value });

function businessFlow(f: OperationFlow): OperationFlow {
  return {
    kind: 'flow',
    cid: f.cid,
    segment: f.segment,
    nocid: f.nocid,
    firstMs: f.firstMs,
    lastMs: f.lastMs,
    role: f.role,
    title: f.safeTitle ?? '',
    ...(f.titleCode ? { titleCode: f.titleCode } : {}),
    status: f.status,
    incomplete: f.incomplete,
    error: f.error,
    opStatus: businessStatus(f.opStatus),
    claimed: f.claimed,
    noStatus: f.noStatus,
    ops: f.ops,
    linkedBy: f.linkedBy.map((l) => ({ type: l.type, at: l.at })),
    found: null,
    pauseMs: f.pauseMs,
    together: f.together,
    callbackEarly: f.callbackEarly,
    firstRecordId: f.firstRecordId ?? null,
  };
}

function businessItem(i: OperationItem): OperationItem | null {
  switch (i.kind) {
    case 'flow':
      return i.role === 'mention' ? null : businessFlow(i);
    case 'group':
      return {
        kind: 'group',
        role: i.role,
        title: i.safeTitle ?? '',
        ...(i.titleCode ? { titleCode: i.titleCode } : {}),
        cids: [...i.cids],
        firstMs: i.firstMs,
        lastMs: i.lastMs,
        failed: i.failed,
        lastStatus: businessStatus(i.lastStatus),
        flows: i.flows.map(businessFlow),
        pauseMs: i.pauseMs,
        together: i.together,
      };
    case 'polls':
      return { kind: 'polls', count: i.count, fromMs: i.fromMs, toMs: i.toMs };
    case 'unread':
      return { kind: 'unread', count: i.count, fromMs: i.fromMs, toMs: i.toMs, reason: i.reason };
  }
}

/** Нет условий селектора, места совпадения, потоков-упоминаний, id сверх предела и исходных значений статусов. */
export function businessOperation(op: OperationView): OperationView {
  const { key, window, outcome } = op;
  return {
    key: { type: key.type, name: key.name, values: [...key.values], also: key.also.map(keyValue) },
    window: { fromMs: window.fromMs, toMs: window.toMs, preset: window.preset },
    items: op.items.map(businessItem).filter((x) => x !== null),
    trail: op.trail.flatMap((t) => {
      const status = businessStatus(t.status);
      return status ? [{ status, atMs: t.atMs, cid: t.cid, segment: t.segment, claimed: t.claimed, stale: t.stale, together: t.together }] : [];
    }),
    outcome: { kind: outcome.kind, status: businessStatus(outcome.status), previous: businessStatus(outcome.previous), basis: outcome.basis, cid: outcome.cid, partial: outcome.partial, failed: outcome.failed },
    excluded: [],
    extraIds: op.extraIds.map(keyValue),
    unsearchedIds: [],
    supplemented: op.supplemented,
    unknownType: op.unknownType,
  };
}

// ---------- Ответы ----------

/** Ответ состояния поиска: значения поиска ввёл сам пользователь, подробностей ошибки и ссылки на хранилище нет. */
export function businessState(s: SearchState): SearchState {
  const { period, progress, error } = s;
  const out: SearchState = {
    id: s.id,
    status: s.status,
    stage: s.stage,
    period: { fromMs: period.fromMs, toMs: period.toMs, preset: period.preset },
    terms: s.terms.map((t) => ({ display: t.display, kind: t.kind })),
    found: s.found,
    tooMany: s.tooMany,
    truncated: s.truncated,
    scannedFromMs: s.scannedFromMs,
    lines: s.lines,
    progress: { chunksDone: progress.chunksDone, chunksTotal: progress.chunksTotal, batchesDone: progress.batchesDone, batchesTotal: progress.batchesTotal },
    requests: s.requests.map(businessSummary),
    requestsTotal: s.requestsTotal,
    error: error ? { code: error.code, ...(error.retryAfterSeconds !== undefined ? { retryAfterSeconds: error.retryAfterSeconds } : {}), stage: error.stage } : null,
  };
  if (s.excludes) out.excludes = s.excludes.map((t) => ({ display: t.display, kind: t.kind }));
  if (s.excluding) out.excluding = { removed: s.excluding.removed };
  if (s.operation !== undefined) out.operation = s.operation ? businessOperation(s.operation) : null;
  // Части поиска по нескольким средам: ход и итог, у ошибки только код, время повтора и этап, ссылки в Grafana нет.
  if (s.envs) out.envs = s.envs.map(businessPart);
  return out;
}

function businessPart(p: EnvSearchPart): EnvSearchPart {
  const { progress, error } = p;
  const out: EnvSearchPart = {
    env: p.env,
    status: p.status,
    stage: p.stage,
    found: p.found,
    tooMany: p.tooMany,
    truncated: p.truncated,
    scannedFromMs: p.scannedFromMs,
    lines: p.lines,
    progress: { chunksDone: progress.chunksDone, chunksTotal: progress.chunksTotal, batchesDone: progress.batchesDone, batchesTotal: progress.batchesTotal },
    requestsTotal: p.requestsTotal,
    error: error ? { code: error.code, ...(error.retryAfterSeconds !== undefined ? { retryAfterSeconds: error.retryAfterSeconds } : {}), stage: error.stage } : null,
  };
  if (p.excluding) out.excluding = { removed: p.excluding.removed };
  return out;
}

/**
 * Ответ страницы запроса: без сведений о скрытых видах и ссылки на хранилище. Пути входа нет даже шаблоном: экран Бизнеса называет запрос
 * словами, а строчное слово в пути по форме от значения не отличить.
 */
export function businessDetail(d: RequestDetail): RequestDetail {
  const summary = businessSummary(d.summary);
  if (summary.incoming) summary.incoming = { method: '', path: '' };
  const records = businessRecords(d.records);
  for (const r of records) if (r.kind === 'incoming' && r.http) r.http.uri = null;
  const out: RequestDetail = { summary, records };
  if (d.operationKeys) out.operationKeys = d.operationKeys.map((k) => ({ type: k.type, name: k.name, value: k.value, short: k.short, masked: k.masked }));
  return out;
}

const OFF: Shown = { full: false, brief: false };
const on = (shown: boolean): Shown => ({ full: shown, brief: shown });

/** Настройка вида: не открывает Бизнесу колонки, вкладки и блоки сверх «Кратко», какие бы блоки проект ни включил. */
export function businessView(view: ViewSettings): ViewSettings {
  const scheme = view.tabs.scheme.brief;
  return {
    defaultMode: 'brief',
    columns: { time: on(true), request: on(true), outcome: on(true), component: { ...OFF }, duration: on(view.columns.duration.brief), records: { ...OFF }, cid: { ...OFF } },
    defaultTab: view.defaultTab === 'scheme' && scheme ? 'scheme' : 'timeline',
    tabs: { scheme: on(scheme), records: { ...OFF } },
    blocks: { request: { ...OFF }, response: { ...OFF }, headers: { ...OFF }, context: { ...OFF }, raw: { ...OFF }, logs: { ...OFF } },
    bodyView: 'pretty',
  };
}

function businessProject(p: ProjectInfo, fallback: ViewSettings): ProjectInfo {
  return {
    id: p.id,
    name: p.name,
    timezone: p.timezone,
    retentionDays: p.retentionDays,
    // Примеры поиска задаёт администратор для всех: роль поддержки ищет по ним так же.
    environments: p.environments.map((e) => ({ id: e.id, name: e.name, kind: e.kind, notConfigured: e.notConfigured, ...(e.examples ? { examples: e.examples } : {}) })),
    ...(p.logo ? { logo: { light: p.logo.light, dark: p.logo.dark, ratio: p.logo.ratio } } : {}),
    view: businessView(p.view ?? fallback),
  };
}

/** Список проектов: только нужное выбору проекта и среды. Скрытых проектов и имён переменных и хранилищ нет. */
export function businessProjects(r: ProjectsResponse, fallback: ViewSettings): ProjectsResponse {
  return {
    projects: r.projects.map((p) => businessProject(p, fallback)),
    defaults: { project: r.defaults.project, environment: r.defaults.environment },
    ...(r.incomplete !== undefined ? { incomplete: r.incomplete } : {}),
  };
}

export function businessConnection(c: ConnectionResponse): ConnectionResponse {
  return { status: c.status, checkedAt: c.checkedAt, ...(c.retryAfterSeconds !== undefined ? { retryAfterSeconds: c.retryAfterSeconds } : {}) };
}

/** Состояние справочника: только состояние, время данных и версия списка проектов. */
export function businessCatalogState(s: CatalogState): CatalogState {
  return { state: s.state, loadedAt: s.loadedAt, message: null, ...(s.projectsVersion !== undefined ? { projectsVersion: s.projectsVersion } : {}) };
}
