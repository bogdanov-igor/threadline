// Хранилища сервера: адаптер + защитный слой на каждое, кэш проверки подключения и списка стендов.

import type { ConnectionResponse, ProbeResponse } from '@threadline/core';
import { BackendError, type CountQuery, type ExploreQuery, type LinesQuery, type LogBackend, type LogLine, type Matcher, type TimeRange } from '@threadline/core/backend';
import { standPattern, STAND_PLACEHOLDER, type EnvironmentConfig } from '@threadline/core/config';
import { ALL_KINDS_MASKING, maskKindsText, maskText } from '@threadline/core/search';
import { missingSecret, type ResolvedBackend, type ResolvedConfig } from '../config/load.ts';
import { ownSecrets, ownSecretScrubber, type OwnSecretScrubber } from '../search/own-secrets.ts';
import { Guard } from './guard.ts';
import { currentQueryTrace, type QueryTrace } from './trace.ts';
import { LokiBackend } from './loki.ts';
import { LokiGrafanaBackend } from './loki-grafana.ts';
import { MockBackend } from './mock/index.ts';

const NO_KEEP: ReadonlySet<string> = new Set();

/** Текст ошибки и журнал не привязаны к проекту: скрываются все виды, настройки здесь нет. */
export const safeText = (s: string): string => maskKindsText(maskText(s, NO_KEEP), ALL_KINDS_MASKING.strict, NO_KEEP);

export const CHECK_TTL_MS = 60_000;
export const CHECK_REFRESH_MIN_MS = 5_000;
export const STANDS_TTL_MS = 5 * 60_000;
export const STANDS_WINDOW_MS = 7 * 24 * 60 * 60_000;
/** «Проверить подключение» со страницы проектов: частые нажатия не уходят в хранилище. */
export const PROBE_TTL_MS = 5_000;
export const PROBE_CACHE_MAX = 100;
const PROBE_WINDOW_MS = 5 * 60_000;

interface Slot {
  id: string;
  cfg: ResolvedBackend;
  adapter: LogBackend;
  guard: Guard;
}

interface Cached<T> {
  value: T;
  at: number;
}

export interface RegistryOptions {
  now?: () => number;
  createAdapter?: (id: string, cfg: ResolvedBackend) => LogBackend;
}

/** Время запроса к хранилищу для журнала. Значений поиска и строк лога здесь нет. */
export interface QueryTiming {
  kind: 'lines' | 'count';
  store: string;
  minutes: number;
  waitMs: number;
  workMs: number;
  rows: number | null;
  outcome: string;
  /** Чей запрос: задание поиска, проект, среда, request_id чтения из обработчика. Нет поля — подписи нет. */
  trace?: QueryTrace;
}

export class Backends {
  /** Куда писать время запросов: журнал сервера появляется позже хранилищ. */
  onQuery?: (timing: QueryTiming) => void;
  readonly #config: ResolvedConfig;
  readonly #slots = new Map<string, Slot>();
  readonly #now: () => number;
  readonly #checks = new Map<string, Cached<ConnectionResponse>>();
  readonly #stands = new Map<string, Cached<number[]>>();
  /** Поколение среды: ответ хранилища, начатый до правки, в кэш стендов не попадает. */
  readonly #standsGeneration = new Map<string, number>();
  readonly #probes = new Map<string, Cached<ProbeResponse>>();
  /** Собственные секреты сервиса: всё, что пришло из хранилища, проходит подмену здесь, поэтому значения нет ни в одном ответе и в базе. */
  #scrub: OwnSecretScrubber;
  readonly #create: (id: string, cfg: ResolvedBackend) => LogBackend;

  constructor(config: ResolvedConfig, opts: RegistryOptions = {}) {
    this.#config = config;
    this.#scrub = ownSecretScrubber(ownSecrets(config));
    this.#now = opts.now ?? Date.now;
    this.#create = opts.createAdapter ?? defaultAdapter;
    for (const [id, cfg] of Object.entries(config.backends)) this.#slots.set(id, this.#slot(id, cfg));
  }

  #slot(id: string, cfg: ResolvedBackend): Slot {
    return {
      id,
      cfg,
      adapter: this.#create(id, cfg),
      guard: new Guard({
        maxConcurrent: cfg.maxConcurrent,
        queueTimeoutMs: cfg.queueTimeoutSeconds * 1000,
        timeoutMs: cfg.timeoutSeconds * 1000,
      }),
    };
  }

  /** Подмена собственных секретов: текущий набор, вместе с хранилищами, подключёнными после запуска. */
  scrubOwn(text: string): string {
    return this.#scrub(text);
  }

  /**
   * Локальный режим: хранилище подключено (cfg) или убрано (null) без перезапуска. Общая настройка меняется на месте: страницы проектов,
   * список проектов и проверки видят новое хранилище со следующего запроса. Идущие запросы доходят на прежнем адаптере.
   */
  setStore(id: string, cfg: ResolvedBackend | null): void {
    if (cfg) {
      this.#config.backends[id] = cfg;
      this.#slots.set(id, this.#slot(id, cfg));
    } else {
      delete this.#config.backends[id];
      this.#slots.delete(id);
    }
    this.#checks.delete(id);
    for (const key of [...this.#stands.keys()]) if (key.startsWith(`${id}|`)) this.#stands.delete(key);
    for (const key of [...this.#probes.keys()]) if ((JSON.parse(key) as unknown[])[0] === id) this.#probes.delete(key);
    this.#scrub = ownSecretScrubber(ownSecrets(this.#config));
  }

  environment(project: string, env: string): EnvironmentConfig | undefined {
    return this.#config.config.projects[project]?.environments[env];
  }

  slotFor(env: EnvironmentConfig): Slot {
    const slot = this.#slots.get(env.backend);
    if (!slot) throw new Error(`нет хранилища ${env.backend}`);
    return slot;
  }

  /** Обращение к хранилищу: текст его ошибки может цитировать токен или строку лога. */
  async #run<T>(slot: Slot, key: string, work: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
    try {
      return await slot.guard.run(key, work, signal);
    } catch (e) {
      if (!(e instanceof BackendError) || !e.details) throw e;
      const details = this.#scrub(e.details);
      if (details === e.details) throw e;
      throw new BackendError(e.code, { details, ...(e.retryAfterSeconds !== undefined ? { retryAfterSeconds: e.retryAfterSeconds } : {}), ...(e.status !== undefined ? { status: e.status } : {}) });
    }
  }

  /** Сколько запросов одно задание шлёт сразу: одно место остаётся другим пользователям. */
  parallelFor(env: EnvironmentConfig): number {
    return Math.max(1, this.slotFor(env).cfg.maxConcurrent - 1);
  }

  async #timed<T>(
    slot: Slot,
    kind: QueryTiming['kind'],
    range: { fromMs: number; toMs: number },
    key: string,
    work: (signal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
    rows: (result: T) => number,
  ): Promise<T> {
    const queued = performance.now();
    let began = queued;
    // До первого ожидания: подпись того, кто спрашивает, а не того, чей запрос склеился с этим.
    const trace = currentQueryTrace();
    const report = (outcome: string, count: number | null) =>
      this.onQuery?.({ kind, store: slot.id, minutes: Math.round((range.toMs - range.fromMs) / 60_000), waitMs: Math.round(began - queued), workMs: Math.round(performance.now() - began), rows: count, outcome, ...(trace ? { trace } : {}) });
    try {
      const result = await this.#run(slot, key, (s) => {
        began = performance.now();
        return work(s);
      }, signal);
      report('ok', rows(result));
      return result;
    } catch (e) {
      report(e instanceof BackendError ? e.code : 'error', null);
      throw e;
    }
  }

  #scrubLines(lines: LogLine[]): LogLine[] {
    return lines.map((l) => {
      const line = this.#scrub(l.line);
      return line === l.line ? l : { ...l, line };
    });
  }

  /** Проверка подключения среды. Результат хранится 60 с; принудительно — не чаще раза в 5 с. */
  async connection(env: EnvironmentConfig, opts: { refresh?: boolean; signal: AbortSignal }): Promise<ConnectionResponse> {
    const slot = this.slotFor(env);
    const backend = slot.cfg.type;
    const missing = missingSecret(slot.cfg);
    if (missing) return { status: 'not-configured', checkedAt: new Date(this.#now()).toISOString(), missingEnv: missing, backend };

    const now = this.#now();
    const cached = this.#checks.get(slot.id);
    if (cached) {
      const age = now - cached.at;
      if (age < CHECK_REFRESH_MIN_MS || (!opts.refresh && age < CHECK_TTL_MS)) return cached.value;
    }

    let value: ConnectionResponse;
    try {
      await this.#run(slot, 'check', (s) => slot.adapter.check(s), opts.signal);
      value = { status: backend === 'mock' ? 'demo' : 'connected', checkedAt: new Date(this.#now()).toISOString(), backend };
    } catch (e) {
      if (!(e instanceof BackendError)) throw e;
      if (e.code === 'cancelled') throw e;
      value = { status: e.code, checkedAt: new Date(this.#now()).toISOString(), backend };
      // Тело ответа хранилища и адрес перенаправления: тот же рубеж, что у остальных ошибок (fail).
      if (e.details) value.details = safeText(e.details);
      if (e.retryAfterSeconds !== undefined) value.retryAfterSeconds = e.retryAfterSeconds;
      if (e.code === 'not-found' && slot.adapter instanceof LokiGrafanaBackend) value.datasource = slot.adapter.datasourceLabel;
    }
    this.#checks.set(slot.id, { value, at: this.#now() });
    return value;
  }

  /** Имена индексных меток хранилища среды, без кэша. Для проверочной команды. */
  async labelNames(env: EnvironmentConfig, signal: AbortSignal): Promise<string[]> {
    const slot = this.slotFor(env);
    this.#assertConfigured(slot);
    return (await this.#run(slot, 'check', (s) => slot.adapter.check(s), signal)).labelNames;
  }

  /** Значения метки в границах среды, без кэша. Для команды выборки. Одинаковые одновременные запросы склеиваются. */
  async labelValues(env: EnvironmentConfig, label: string, scope: Matcher[], range: TimeRange, signal: AbortSignal): Promise<string[]> {
    const slot = this.slotFor(env);
    this.#assertConfigured(slot);
    return this.#run(slot, `labelValues|${JSON.stringify([label, scope, range])}`, (s) => slot.adapter.labelValues(label, scope, range, s), signal);
  }

  /** Живые стенды среды за 7 дней, свежие (большие номера) первыми. Список хранится 5 минут. */
  async stands(project: string, envId: string, env: EnvironmentConfig, signal: AbortSignal): Promise<number[]> {
    if (env.kind !== 'pr-stands' || !env.stand) throw new Error('среда не стенды');
    const slot = this.slotFor(env);
    this.#assertConfigured(slot);
    const key = `${slot.id}|${project}|${envId}`;
    const now = this.#now();
    const cached = this.#stands.get(key);
    if (cached && now - cached.at < STANDS_TTL_MS) return cached.value;

    const generation = this.#standsGeneration.get(`${project}|${envId}`) ?? 0;
    const numbers = await this.#standNumbers(slot, env.stand, env.selector, signal);
    if ((this.#standsGeneration.get(`${project}|${envId}`) ?? 0) === generation) this.#stands.set(key, { value: numbers, at: this.#now() });
    return numbers;
  }

  async #standNumbers(slot: Slot, stand: { label: string; template: string }, selector: readonly Matcher[], signal: AbortSignal): Promise<number[]> {
    const now = this.#now();
    const { label, template } = stand;
    const scope: Matcher[] = [{ label, op: '=~', value: standRegex(template) }, ...selector];
    const range = { fromMs: now - STANDS_WINDOW_MS, toMs: now };
    const values = await this.#run(
      slot,
      `labelValues|${JSON.stringify([label, scope])}`,
      (s) => slot.adapter.labelValues(label, scope, range, s),
      signal,
    );
    const re = standPattern(template);
    return [...new Set(values.map((v) => re.exec(v)?.[1]).filter((n): n is string => !!n).map(Number))].sort((a, b) => b - a);
  }

  /** Правка границ среды: список стендов читается заново, ключ кэша содержит хранилище, а его могли сменить. */
  forgetStands(project: string, envId: string): void {
    const scope = `${project}|${envId}`;
    this.#standsGeneration.set(scope, (this.#standsGeneration.get(scope) ?? 0) + 1);
    for (const key of [...this.#stands.keys()]) if (key.endsWith(`|${scope}`)) this.#stands.delete(key);
  }

  hasStore(id: string): boolean {
    return this.#slots.has(id);
  }

  /**
   * «Проверить подключение» со страницы проектов: check и один запрос к среде. Стенды идут мимо кэша: несохранённые условия
   * не должны подменить список сохранённой среды. Тело записи не возвращается, нужен только факт наличия.
   */
  async probe(storeId: string, env: Pick<EnvironmentConfig, 'kind' | 'selector' | 'stand'> | undefined, signal: AbortSignal): Promise<ProbeResponse> {
    const slot = this.#slots.get(storeId);
    if (!slot) throw new Error(`нет хранилища ${storeId}`);
    const checkedAt = () => new Date(this.#now()).toISOString();
    const backend = slot.cfg.type;
    const missing = missingSecret(slot.cfg);
    if (missing) return { status: 'not-configured', checkedAt: checkedAt(), missingEnv: missing, backend };
    if (backend === 'mock') return { status: 'demo', checkedAt: checkedAt(), backend };

    const key = JSON.stringify([storeId, env ? [env.kind, env.selector, env.stand ?? null] : null]);
    const cached = this.#probes.get(key);
    if (cached && this.#now() - cached.at < PROBE_TTL_MS) return cached.value;

    let value: ProbeResponse;
    try {
      const info = await this.#run(slot, 'check', (s) => slot.adapter.check(s), signal);
      value = { status: 'connected', checkedAt: checkedAt(), backend, labelNames: info.labelNames };
      if (env?.kind === 'pr-stands' && env.stand) {
        value.stands = await this.#standNumbers(slot, env.stand, env.selector, signal);
      } else if (env) {
        const toMs = this.#now();
        const q: LinesQuery = { selector: env.selector.map(({ label, op, value: v }) => ({ label, op, value: v })), filters: [], range: { fromMs: toMs - PROBE_WINDOW_MS, toMs }, limit: 1, direction: 'backward' };
        value.hasRecords = (await this.#run(slot, `probe|${JSON.stringify(q.selector)}`, (s) => slot.adapter.queryLines(q, s), signal)).length > 0;
      }
    } catch (e) {
      if (!(e instanceof BackendError)) throw e;
      if (e.code === 'cancelled') throw e;
      value = { status: e.code, checkedAt: checkedAt(), backend };
      if (e.details) value.details = safeText(e.details);
      if (e.retryAfterSeconds !== undefined) value.retryAfterSeconds = e.retryAfterSeconds;
      if (e.code === 'not-found' && slot.adapter instanceof LokiGrafanaBackend) value.datasource = slot.adapter.datasourceLabel;
    }
    this.#probes.delete(key);
    this.#probes.set(key, { value, at: this.#now() });
    if (this.#probes.size > PROBE_CACHE_MAX) this.#probes.delete(this.#probes.keys().next().value!);
    return value;
  }

  /** Строки среды. Одинаковые одновременные запросы склеиваются. */
  async queryLines(env: EnvironmentConfig, q: LinesQuery, signal: AbortSignal): Promise<LogLine[]> {
    const slot = this.slotFor(env);
    this.#assertConfigured(slot);
    return this.#timed(slot, 'lines', q.range, `lines|${JSON.stringify(q)}`, async (s) => this.#scrubLines(await slot.adapter.queryLines(q, s)), signal, (lines) => lines.length);
  }

  /** Число записей среды по значению поля. Одинаковые одновременные запросы склеиваются. */
  async countBy(env: EnvironmentConfig, q: CountQuery, signal: AbortSignal): Promise<Record<string, number>> {
    const slot = this.slotFor(env);
    this.#assertConfigured(slot);
    return this.#timed(slot, 'count', q.range, `count|${JSON.stringify(q)}`, (s) => slot.adapter.countBy(q, s), signal, (counts) => Object.keys(counts).length);
  }

  /** Адрес запроса в интерфейсе хранилища среды. Без сети и без очереди: строится строка. */
  exploreUrl(env: EnvironmentConfig, q: ExploreQuery): string | null | undefined {
    return this.slotFor(env).adapter.exploreUrl?.(q);
  }

  #assertConfigured(slot: Slot): void {
    const missing = missingSecret(slot.cfg);
    if (missing) throw new BackendError('not-configured', { details: `не задана переменная окружения ${missing}` });
  }
}

/** Регулярное выражение для значений метки стенда в запросе к хранилищу (RE2, полное совпадение). */
export function standRegex(template: string): string {
  const [before = '', after = ''] = template.split(STAND_PLACEHOLDER);
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `${esc(before)}[0-9]{1,6}${esc(after)}`;
}

export function defaultAdapter(_id: string, cfg: ResolvedBackend): LogBackend {
  if (cfg.type === 'mock') return new MockBackend(cfg);
  return cfg.type === 'loki' ? new LokiBackend(cfg) : new LokiGrafanaBackend(cfg);
}
