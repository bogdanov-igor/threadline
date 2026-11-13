// Хранилище-имитация: отвечает над синтетическим набором, наружу не ходит.

import { BackendError, FLAG_GROUP, FLAG_SUFFIX, lineTest, type CheckInfo, type CountQuery, type Filter, type LinesQuery, type LogBackend, type LogLine, type Matcher, type TimeRange } from '@threadline/core/backend';
import type { MockConfig, MockFailMode } from '@threadline/core/config';
import { checkRe2, COUNT_GROUP, re2ToJs } from '@threadline/core/profile';
import { generatePayDataset, type MockRecord } from './dataset-pay.ts';

const FAIL_DETAILS: Record<MockFailMode, string> = {
  unauthorized: 'имитация: Grafana ответила 401 Invalid API key',
  forbidden: 'имитация: Grafana ответила 403 Permission denied',
  'not-found': 'имитация: источник Loki не найден',
  network: 'имитация: ECONNREFUSED',
  certificate: 'имитация: UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  timeout: 'имитация: хранилище не ответило',
  overloaded: 'имитация: too many outstanding requests',
  limit: 'имитация: max entries limit per query exceeded',
  'bad-response': 'имитация: ответ не разбирается как JSON',
};

export function matches(labels: Record<string, string>, matchers: Matcher[]): boolean {
  return matchers.every((m) => {
    const v = labels[m.label] ?? '';
    if (m.op === '=') return v === m.value;
    if (m.op === '!=') return v !== m.value;
    // Неверное выражение не пропускает запись ни у =~, ни у !~: Loki на такой запрос отвечает ошибкой, записей нет.
    try {
      const hit = new RegExp(`^(?:${m.value})$`).test(v);
      return m.op === '!~' ? !hit : hit;
    } catch {
      return false;
    }
  });
}

export class MockBackend implements LogBackend {
  readonly records: MockRecord[];
  readonly pans: string[];
  readonly #cfg: MockConfig;
  readonly #countCache = new Map<string, RegExp>();

  constructor(cfg: MockConfig, opts: { anchorMs?: number; flowScenarios?: boolean } = {}) {
    this.#cfg = cfg;
    const data = generatePayDataset(opts.anchorMs ?? Date.now(), opts.flowScenarios === false ? { flowScenarios: false } : {});
    this.records = data.records;
    this.pans = data.pans;
  }

  async check(signal: AbortSignal): Promise<CheckInfo> {
    await this.#respond(signal);
    const names = new Set<string>();
    for (const rec of this.records) for (const k of Object.keys(rec.labels)) names.add(k);
    return { labelNames: [...names].sort() };
  }

  async labelValues(label: string, scope: Matcher[], range: TimeRange, signal: AbortSignal): Promise<string[]> {
    await this.#respond(signal);
    const from = BigInt(Math.trunc(range.fromMs)) * 1_000_000n;
    const to = BigInt(Math.trunc(range.toMs)) * 1_000_000n;
    const values = new Set<string>();
    for (const rec of this.records) {
      if (rec.tsNs < from || rec.tsNs > to) continue;
      const v = rec.labels[label];
      if (v !== undefined && matches(rec.labels, scope)) values.add(v);
    }
    return [...values].sort();
  }

  async queryLines(q: LinesQuery, signal: AbortSignal): Promise<LogLine[]> {
    await this.#respond(signal);
    if (!Number.isSafeInteger(q.limit) || q.limit < 1) throw new Error(`недопустимый предел строк: ${q.limit}`);
    const found = this.#select(q.selector, q.filters, q.range);
    // Набор отсортирован по возрастанию; при равном времени порядок набора сохраняется в обе стороны.
    const ordered = q.direction === 'forward' ? found : stableReverse(found);
    return ordered.slice(0, q.limit).map((rec) => ({ tsNs: rec.tsNs.toString(), line: rec.line, labels: { ...rec.labels } }));
  }

  async countBy(q: CountQuery, signal: AbortSignal): Promise<Record<string, number>> {
    await this.#respond(signal);
    const re = this.#countRegExp(q.key.regexp);
    const flag = q.flag ? this.#countRegExp(q.flag.regexp) : null;
    const counts: Record<string, number> = {};
    for (const rec of this.#select(q.selector, q.filters, q.range)) {
      let key = re.exec(rec.line)?.groups?.[COUNT_GROUP];
      // Поиск операции: строки без ключа — под пустым ключом, как у Loki без фильтра threadline_key!="".
      if (q.keepEmpty) key ??= '';
      if (key === undefined || (key === '' && !q.keepEmpty)) continue;
      if (flag && (flag.exec(rec.line)?.groups?.[FLAG_GROUP] ?? '') !== '') key += FLAG_SUFFIX;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  }

  /** Выражение подсчёта в JS: тот же разбор строки, что делает Loki, без разбора записи. */
  #countRegExp(regexp: string): RegExp {
    let re = this.#countCache.get(regexp);
    if (!re) {
      try {
        re = re2ToJs(regexp);
      } catch (e) {
        throw new BackendError('unknown', { details: `имитация: выражение подсчёта не годится: ${e instanceof Error ? e.message : String(e)}` });
      }
      this.#countCache.set(regexp, re);
    }
    return re;
  }

  /** Записи по селектору, периоду (включительно, с точностью до нс) и фильтрам, по возрастанию времени. */
  #select(selector: Matcher[], filters: Filter[], range: TimeRange): MockRecord[] {
    const from = range.fromNs !== undefined ? BigInt(range.fromNs) : BigInt(Math.trunc(range.fromMs)) * 1_000_000n;
    const to = range.toNs !== undefined ? BigInt(range.toNs) : BigInt(Math.trunc(range.toMs)) * 1_000_000n;
    if (from > to) return [];
    const tests = filters.map(filterTest);
    return this.records.filter(
      (rec) => rec.tsNs >= from && rec.tsNs <= to && matches(rec.labels, selector) && tests.every((t) => t(rec.line)),
    );
  }

  async #respond(signal: AbortSignal): Promise<void> {
    if (this.#cfg.latencyMs > 0) await delay(this.#cfg.latencyMs, signal);
    if (signal.aborted) throw new BackendError('cancelled');
    const fail = this.#cfg.fail;
    if (fail) {
      throw new BackendError(fail, {
        details: FAIL_DETAILS[fail],
        ...(fail === 'overloaded' ? { retryAfterSeconds: 15 } : {}),
      });
    }
  }
}

/**
 * Фильтр строки, как у Loki: регулярное выражение читается как RE2 профиля, с ведущим (?i) и группами (?P<имя>…).
 * Выражение, которое checkRe2 не принимает, читается как раньше.
 */
function filterTest(f: Filter): (line: string) => boolean {
  if (f.kind !== 'regex' && f.kind !== 'not-regex') return lineTest(f);
  const c = checkRe2(f.pattern);
  if (!c.ok) return lineTest(f);
  const re = c.js;
  return f.kind === 'regex' ? (line) => re.test(line) : (line) => !re.test(line);
}

function stableReverse(records: MockRecord[]): MockRecord[] {
  const out: MockRecord[] = [];
  let end = records.length;
  while (end > 0) {
    let start = end - 1;
    while (start > 0 && records[start - 1]!.tsNs === records[end - 1]!.tsNs) start--;
    out.push(...records.slice(start, end));
    end = start;
  }
  return out;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new BackendError('cancelled'));
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new BackendError('cancelled'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
