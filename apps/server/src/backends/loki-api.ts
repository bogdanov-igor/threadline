// Общая часть адаптеров Loki: запросы HTTP API /loki/api/v1 и разбор ответов. Как дойти до API, решает наследник:
// через прокси источника Grafana (loki-grafana.ts) или напрямую (loki.ts).

import { BackendError, FLAG_SUFFIX, type CheckInfo, type CountQuery, type ExploreQuery, type LinesQuery, type LogBackend, type LogLine, type Matcher, type TimeRange } from '@threadline/core/backend';
import { countLogql, linesLogql, selector } from './logql.ts';

export const ns = (ms: number) => (BigInt(Math.trunc(ms)) * 1_000_000n).toString();

export interface LokiResponse<T> {
  status?: string;
  data?: T;
}

export abstract class LokiApiBackend implements LogBackend {
  readonly #now: () => number;

  protected constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** GET к /loki/api/v1/<path>: тело ответа Loki как есть. Ошибки HTTP, сети и формата — BackendError. */
  protected abstract request<T>(path: string, params: Record<string, string>, signal: AbortSignal): Promise<LokiResponse<T>>;

  abstract exploreUrl(q: ExploreQuery): string | null | undefined;

  async #data<T>(path: string, params: Record<string, string>, signal: AbortSignal): Promise<T> {
    const res = await this.request<T>(path, params, signal);
    if (res?.status !== 'success') throw new BackendError('bad-response', { details: 'Loki не вернул status: success' });
    return res.data as T;
  }

  async check(signal: AbortSignal): Promise<CheckInfo> {
    const now = this.#now();
    // У пустого Loki меток нет, и он отвечает без data: это пустой список, а не битый ответ.
    const names = (await this.#data<string[] | null | undefined>('labels', { start: ns(now - 5 * 60_000), end: ns(now) }, signal)) ?? [];
    if (!Array.isArray(names)) throw new BackendError('bad-response', { details: 'список меток Loki не в ожидаемом формате' });
    return { labelNames: names.filter((n) => typeof n === 'string').sort() };
  }

  async labelValues(label: string, scope: Matcher[], range: TimeRange, signal: AbortSignal): Promise<string[]> {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(label)) throw new Error(`недопустимое имя метки: ${label}`);
    // У метки без значений Loki отвечает без data: это пустой список, а не битый ответ.
    const values =
      (await this.#data<string[] | null | undefined>(
        `label/${label}/values`,
        { start: ns(range.fromMs), end: ns(range.toMs), query: selector(scope) },
        signal,
      )) ?? [];
    if (!Array.isArray(values)) throw new BackendError('bad-response', { details: 'значения метки Loki не в ожидаемом формате' });
    return values.filter((v) => typeof v === 'string');
  }

  async queryLines(q: LinesQuery, signal: AbortSignal): Promise<LogLine[]> {
    if (!Number.isSafeInteger(q.limit) || q.limit < 1) throw new Error(`недопустимый предел строк: ${q.limit}`);
    const from = BigInt(q.range.fromNs ?? ns(q.range.fromMs));
    const to = BigInt(q.range.toNs ?? ns(q.range.toMs));
    if (from > to) return [];
    // Конец в Loki не входит в период, а у нас входит.
    const data = await this.#data<unknown>(
      'query_range',
      {
        query: linesLogql(q.selector, q.filters),
        start: from.toString(),
        end: (to + 1n).toString(),
        limit: String(q.limit),
        direction: q.direction,
      },
      signal,
    );
    const lines = parseStreams(data);
    const sign = q.direction === 'forward' ? 1 : -1;
    // Сортировка устойчивая: при равном времени остаётся порядок ответа Loki.
    return lines
      .map((l) => ({ l, t: BigInt(l.tsNs) }))
      .sort((a, b) => (a.t === b.t ? 0 : a.t < b.t ? -sign : sign))
      .slice(0, q.limit)
      .map((x) => x.l);
  }

  async countBy(q: CountQuery, signal: AbortSignal): Promise<Record<string, number>> {
    const from = BigInt(q.range.fromNs ?? ns(q.range.fromMs));
    const to = BigInt(q.range.toNs ?? ns(q.range.toMs));
    if (from > to) return {};
    // Окно мгновенного запроса Loki 2.x — (time − range, time): оба конца не входят, а наш период включительно.
    // time = конец + 1 нс, окно в целых секундах строго длиннее периода: строка ровно на границе куска считается.
    // Лишнее — меньше секунды перед началом, то есть хвост соседнего куска: на набор correlation_id не влияет.
    const seconds = Number((to - from + 1n) / 1_000_000_000n) + 1;
    const data = await this.#data<unknown>('query', { query: countLogql(q, seconds), time: (to + 1n).toString() }, signal);
    return parseVector(data, { keepEmpty: q.keepEmpty === true });
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const NS = /^\d{1,20}$/;

/** Ответ query_range: потоки разворачиваются в строки с метками потока. */
function parseStreams(data: unknown): LogLine[] {
  const bad = () => new BackendError('bad-response', { details: 'строки Loki не в ожидаемом формате' });
  if (!isObj(data) || data.resultType !== 'streams' || !Array.isArray(data.result)) throw bad();
  const out: LogLine[] = [];
  for (const item of data.result) {
    if (!isObj(item) || !isObj(item.stream) || !Array.isArray(item.values)) throw bad();
    const labels: Record<string, string> = {};
    for (const [k, v] of Object.entries(item.stream)) {
      if (typeof v !== 'string') throw bad();
      labels[k] = v;
    }
    for (const value of item.values) {
      if (!Array.isArray(value)) throw bad();
      const [tsNs, line] = value as unknown[];
      if (typeof tsNs !== 'string' || !NS.test(tsNs) || typeof line !== 'string') throw bad();
      out.push({ tsNs, line, labels });
    }
  }
  return out;
}

/** Ответ мгновенного запроса подсчёта: значение метки threadline_key → число записей. */
function parseVector(data: unknown, opts: { keepEmpty?: boolean } = {}): Record<string, number> {
  const bad = () => new BackendError('bad-response', { details: 'подсчёт Loki не в ожидаемом формате' });
  if (!isObj(data) || data.resultType !== 'vector' || !Array.isArray(data.result)) throw bad();
  const counts = new Map<string, number>();
  for (const item of data.result) {
    if (!isObj(item) || !isObj(item.metric) || !Array.isArray(item.value)) throw bad();
    // Строка без ключа приходит без метки threadline_key: в поиске операции это пустой ключ.
    const raw = item.metric.threadline_key ?? (opts.keepEmpty ? '' : undefined);
    const n = Number(item.value[1]);
    if (typeof raw !== 'string' || (raw === '' && !opts.keepEmpty) || !Number.isFinite(n)) continue;
    const flag = item.metric.threadline_flag;
    const key = typeof flag === 'string' && flag !== '' ? raw + FLAG_SUFFIX : raw;
    counts.set(key, (counts.get(key) ?? 0) + n);
  }
  return Object.fromEntries(counts);
}
