// Задание поиска операции: подсчёт по часам без отбрасывания пустого ключа и с признаком входа GET, чтение только
// часов с совпадениями ±5 мин, хвост 15 мин, пределы 200 потоков и 8 часов, записи без correlation_id.
// Задание — то же задание поиска (SearchJob): состояние, остановка,
// записи потока и повтор из памяти идут прежними маршрутами /api/searches/:id.

import { BackendError, FLAG_SUFFIX, type LinesQuery, type LogLine } from '@threadline/core/backend';
import { annotateRecords, type Resolver } from '@threadline/core/catalog';
import {
  buildOperation,
  cidSegments,
  flowFacts,
  nocidSegments,
  type OperationKeyValue,
  type OperationPolls,
  type OperationUnread,
  type OperationView,
  type OperationWindowPreset,
  type OpFlowFacts,
} from '@threadline/core/flow';
import { isCountKey, re2Canonical, tsNsToMs } from '@threadline/core/profile';
import {
  buildView,
  markPending,
  pairExchanges,
  sortRecords,
  summarize,
  type ParsedRecord,
  type SearchState,
  type ViewRecord,
} from '@threadline/core/search';
import { SERIES_LIMIT } from '../backends/errors.ts';
import { escapeRegex } from '../backends/logql.ts';
import { countChunks, readLines, SearchJob, type EngineDeps, type Interval, type LineBudget, type SearchSpec, type StoredRequest } from '../search/engine.ts';
import { lineHash } from '../search/paging.ts';
import { canSearch, type SearchValue } from './values.ts';
import { runInOrder } from '../search/in-order.ts';

export { runInOrder };

const MINUTE = 60_000;
/** Предел читаемых потоков: опросы партнёра и записи без correlation_id в него не входят. */
export const MAX_OP_FLOWS = 200;
/** Читается не больше стольких кусков окна. */
export const MAX_OP_CHUNKS = 8;
/** Хвост: дочитывание потока за концом окна чтения. */
export const TAIL_MS = 15 * MINUTE;
/** Последняя запись ближе этого к концу окна — поток дочитывается хвостом. */
export const EDGE_MS = MINUTE;

/** Справочник для поиска операции. Сервер справочника отдаёт Resolver проекта или null. */
export interface OperationCatalog {
  resolver(project: string): Resolver | null;
}

export const NO_CATALOG: OperationCatalog = { resolver: () => null };

export interface OperationDeps extends EngineDeps {
  catalog: OperationCatalog;
  /** Разметка записей; подменяется в тестах кэша. */
  annotate?: typeof annotateRecords;
}

export interface OperationSpec {
  project: string;
  envId: string;
  /** Номер стенда PR: ссылка на пример «Неизвестного». */
  stand: string | null;
  /** Хранилище — имитация: «Неизвестное» её не собирает. */
  mock: boolean;
  key: { type: string; values: string[]; also: OperationKeyValue[] };
  /** Значения, по которым идёт этот поиск (у дополнения — только новые), и их выражение. */
  search: { values: SearchValue[]; pattern: string };
  window: { fromMs: number; toMs: number; preset: OperationWindowPreset };
  /** Условия селектора с != и !~, которые поиск операции применил. */
  excluded: string[];
  /** Признак входа GET (CountQuery.flag); null — профиль его не знает, опросы партнёра не отделяются. */
  flagRegexp: string | null;
}

interface FlowStore {
  records: ParsedRecord[];
  hashes: Set<string>;
  incomplete: boolean;
  readEndMs: number;
}

/** Что дополнение берёт у прежнего задания. */
export interface OperationSeed {
  flows: Map<string, FlowStore>;
  nocid: Map<string, ParsedRecord>;
  polls: OperationPolls | null;
  unread: OperationUnread[];
  /** Оценка памяти под эти записи: дополнение держит их вместе со своими. */
  bytes: number;
}

type SearchError = NonNullable<SearchState['error']>;

function errorOf(e: unknown, stage: SearchError['stage']): SearchError {
  if (e instanceof BackendError) {
    const out: SearchError = { code: e.code, stage };
    if (e.details) out.details = e.details;
    if (e.retryAfterSeconds !== undefined) out.retryAfterSeconds = e.retryAfterSeconds;
    return out;
  }
  return { code: 'unknown', stage };
}

const isCancel = (e: unknown, signal: AbortSignal) => signal.aborted || (e instanceof BackendError && e.code === 'cancelled');

/** Куски с обоих концов окна по очереди, пока потоков не больше maxFlows и кусков не больше maxChunks. */
export function pickChunks(
  ordered: readonly number[],
  cidsOf: (chunk: number) => readonly string[],
  limits: { maxFlows: number; maxChunks: number },
): { chunks: number[]; cids: Set<string> } {
  const out: number[] = [];
  const cids = new Set<string>();
  let lo = 0;
  let hi = ordered.length - 1;
  let fromStart = true;
  while (lo <= hi && out.length < limits.maxChunks) {
    const c = fromStart ? ordered[lo]! : ordered[hi]!;
    const next = cidsOf(c).filter((x) => !cids.has(x));
    if (cids.size + next.length > limits.maxFlows) {
      // Первый кусок больше предела: читается его часть до предела.
      if (out.length === 0) {
        out.push(c);
        for (const x of next.slice(0, limits.maxFlows)) cids.add(x);
      }
      break;
    }
    out.push(c);
    for (const x of next) cids.add(x);
    if (fromStart) lo++;
    else hi--;
    fromStart = !fromStart;
  }
  return { chunks: out, cids };
}

export class OperationJob extends SearchJob {
  readonly operation: OperationSpec;
  /** Дополнение уже было (или это задание — само дополнение): новое дополнение не запускается. */
  supplemented: boolean;
  /** Задание-дополнение этого поиска: пока оно живо, та же операция из другой вкладки получает его. */
  supplement: string | null = null;

  readonly #deps: OperationDeps;
  /** Предел строк этапа чтения: общий для чтений, идущих сразу, они берут из него по мере чтения. */
  #lines: LineBudget = { left: 0 };
  /** Потоки пакетов, чьё чтение оборвал предел строк, и час пакета: итог по ним — в #settleMissed. */
  readonly #missed = new Map<string, Interval>();
  /** Это задание — само дополнение: значения дополнения уже в его результате. */
  readonly #isSupplement: boolean;
  readonly #flows: Map<string, FlowStore>;
  readonly #nocid: Map<string, ParsedRecord>;
  #polls: OperationPolls | null;
  readonly #unread: OperationUnread[];
  /** Потоки, прочитанные не во всех кусках с совпадениями: записи неполные. */
  readonly #partly = new Set<string>();
  #linesRead = 0;
  #runDone: Promise<void> = Promise.resolve();
  #cache: { key: string; view: OperationView; segments: Map<string, ParsedRecord[]> } | null = null;

  constructor(id: string, key: string, spec: SearchSpec, operation: OperationSpec, deps: OperationDeps, seed?: OperationSeed) {
    super(id, key, spec, deps);
    this.operation = operation;
    this.#deps = deps;
    this.supplemented = seed !== undefined;
    this.#isSupplement = seed !== undefined;
    this.#flows = new Map([...(seed?.flows ?? [])].map(([k, f]) => [k, { ...f, records: [...f.records], hashes: new Set(f.hashes) }]));
    this.#nocid = new Map(seed?.nocid ?? []);
    this.#polls = seed?.polls ? { ...seed.polls } : null;
    this.#unread = [...(seed?.unread ?? [])].map((u) => ({ ...u }));
    for (const cid of this.#flows.keys()) this.keep.add(cid);
    // Записи прежнего задания: в бюджете памяти, но не в пределе своего чтения.
    this.memory.extra = seed?.bytes ?? 0;
  }

  override get done(): Promise<void> {
    return this.#runDone;
  }

  override start(): Promise<void> {
    this.#runDone = this.#run().catch((e: unknown) => {
      this.#deps.warn(`поиск операции ${this.id} прерван ошибкой ${e instanceof Error ? e.name : typeof e}`);
      if (this.status === 'running') {
        this.error = { code: 'unknown', stage: this.stage === 'count' ? 'count' : 'fetch' };
        this.#finish();
      }
    });
    return this.#runDone;
  }

  /** Данные для дополнения: прочитанное этим заданием. */
  seed(): OperationSeed {
    return { flows: this.#flows, nocid: this.#nocid, polls: this.#polls, unread: this.#unread, bytes: this.bytes };
  }

  /** Поток или сегмент без correlation_id из задания, немаскированный. */
  override request(cid: string): StoredRequest | undefined {
    const f = this.#flows.get(cid);
    if (f && f.records.length > 0) {
      const records = sortRecords(f.records);
      return { summary: summarize(cid, records, { match: 'exact', readEndMs: f.readEndMs, incomplete: f.incomplete }), records, readEndMs: f.readEndMs, incomplete: f.incomplete };
    }
    if (!cid.startsWith('nocid:')) return undefined;
    this.operationView();
    const seg = this.#cache?.segments.get(cid);
    if (!seg) return undefined;
    const readEndMs = this.operation.window.toMs;
    return { summary: summarize(cid, seg, { match: 'exact', readEndMs, incomplete: false }), records: seg, readEndMs, incomplete: false };
  }

  override state(from = 0): SearchState {
    return { ...super.state(from), operation: this.operationView() };
  }

  #finish(): void {
    if (this.status !== 'running') return;
    this.status = this.error ? 'failed' : 'done';
    this.stage = 'done';
  }

  // ---------- Сборка операции ----------

  /**
   * OperationView по прочитанным записям. Кэш — по числу прочитанных строк, версии справочника и состоянию задания:
   * опрос раз в 500 мс не разбирает тела заново, правка справочника видна без нового чтения хранилища.
   */
  operationView(): OperationView {
    const resolver = this.#deps.catalog.resolver(this.operation.project);
    const ck = `${this.#linesRead}|${this.#flows.size}|${this.#nocid.size}|${resolver?.version ?? 'off'}|${this.status}`;
    if (this.#cache?.key === ck) return this.#cache.view;
    const annotate = this.#deps.annotate ?? annotateRecords;
    const op = this.operation;
    const values = [...op.key.values, ...op.key.also.map((a) => a.value)];
    const flows: OpFlowFacts[] = [];
    for (const [cid, f] of this.#flows) {
      if (f.records.length === 0) continue;
      const view = annotate(markPending(buildView(f.records, { withOffsets: true }), f), resolver);
      // Ветка B: записи одного correlation_id с паузой больше 3 мин — сегменты со своей ролью.
      const segs = cidSegments(view);
      if (segs.length === 1) flows.push(flowFacts(cid, view, { incomplete: f.incomplete, values }));
      else segs.forEach((s, i) => flows.push(flowFacts(cid, s, { segment: i, incomplete: f.incomplete && i === segs.length - 1, values })));
    }
    // Ветка A: записи с id без correlation_id — сегменты по поду и паузе.
    const { segments, rest } = nocidSegments([...this.#nocid.values()]);
    const segRecords = new Map<string, ParsedRecord[]>();
    for (const seg of segments) {
      const records = sortRecords(seg.records);
      segRecords.set(seg.id, records);
      this.keep.add(seg.id);
      const view = annotate(buildView(records, { withOffsets: true }), resolver);
      flows.push(flowFacts(seg.id, view, { nocid: true, values }));
    }
    const unread = [...this.#unread];
    if (rest > 0) {
      const tail = segments[segments.length - 1];
      unread.push({ kind: 'unread', count: rest, fromMs: tail?.lastMs ?? op.window.fromMs, toMs: op.window.toMs, reason: 'segments' });
    }
    const type = resolver?.idTypes.get(op.key.type) ?? null;
    const view = buildOperation({
      key: { type: op.key.type, name: type?.name ?? null, values: op.key.values, also: op.key.also },
      window: op.window,
      flows,
      polls: this.#polls ? [this.#polls] : [],
      unread,
      excluded: op.excluded,
      partial: this.error !== null || this.truncated || this.status === 'cancelled',
      // Для запрошенного набора значений, а не для задания в памяти: без also= кнопка дополнения остаётся.
      supplemented: this.#isSupplement,
      unknownType: type === null || type.kind !== 'operation',
      canSearch: (t, v) => canSearch(resolver, t, v),
    });
    this.#cache = { key: ck, view, segments: segRecords };
    return view;
  }

  // ---------- Поиск ----------

  async #run(): Promise<void> {
    const signal = this.signal;
    const { spec, operation: op } = this;
    const chunks = countChunks(op.window, spec.limits.countChunkMinutes);
    this.progress.chunksTotal = chunks.length;
    const plain = new Map<string, Set<number>>();
    const flagged = new Map<string, Set<number>>();
    const add = (m: Map<string, Set<number>>, cid: string, i: number) => {
      const s = m.get(cid);
      if (s) s.add(i);
      else m.set(cid, new Set([i]));
    };

    // Подсчёт: все куски окна, без остановки на 200 найденных. Запросы идут параллельно, итоги складываются по порядку кусков.
    // Ошибка куска прерывает остальные подсчёты: граница просмотра — последний кусок, подсчитанный без пропусков.
    const parallel = this.#deps.backends.parallelFor(spec.env);
    let stop = null as 'cancel' | 'finish' | null;
    await runInOrder(
      chunks,
      parallel,
      async (chunk, _i, stage): Promise<{ counts: Record<string, number> } | { failure: unknown }> => {
        try {
          return {
            counts: await this.#deps.backends.countBy(
              spec.env,
              {
                selector: spec.selector,
                filters: [{ kind: 'regex', pattern: op.search.pattern }],
                range: { ...chunk },
                key: { regexp: spec.profile.countRegexp },
                keepEmpty: true,
                ...(op.flagRegexp ? { flag: { regexp: op.flagRegexp } } : {}),
              },
              stage,
            ),
          };
        } catch (failure) {
          return { failure };
        }
      },
      (result, i) => {
        if ('failure' in result) {
          const e = result.failure;
          if (isCancel(e, signal)) {
            stop = 'cancel';
          } else if (e instanceof BackendError && e.code === 'limit' && SERIES_LIMIT.test(e.details ?? '')) {
            this.tooMany = true;
            this.found = null;
            stop = 'finish';
          } else {
            // Тайм-аут куска: собирается то, что уже просмотрено.
            this.error = errorOf(e, 'count');
          }
          return false;
        }
        if (this.status !== 'running') {
          stop = 'cancel';
          return false;
        }
        for (const [k, n] of Object.entries(result.counts)) {
          if (!(n > 0)) continue;
          const isFlag = k.endsWith(FLAG_SUFFIX);
          const cid = isFlag ? k.slice(0, -FLAG_SUFFIX.length) : k;
          if (cid !== '' && !isCountKey(cid)) continue;
          add(isFlag ? flagged : plain, cid, i);
        }
        this.scannedFromMs = chunks[i]!.fromMs;
        this.progress.chunksDone = i + 1;
        return true;
      },
      { signal, failed: (r) => 'failure' in r },
    );
    if (stop === 'cancel') return;
    if (stop === 'finish') return this.#finish();

    // Опросы партнёра: все совпадения потока — входящий GET. Такие потоки не читаются.
    const polls = [...flagged.keys()].filter((cid) => cid !== '' && !plain.has(cid) && !this.#flows.has(cid));
    if (polls.length > 0) {
      const idx = polls.flatMap((cid) => [...flagged.get(cid)!]);
      const fromMs = Math.min(...idx.map((i) => chunks[i]!.fromMs));
      const toMs = Math.max(...idx.map((i) => chunks[i]!.toMs));
      const prev = this.#polls;
      this.#polls = prev
        ? { kind: 'polls', count: prev.count + polls.length, fromMs: Math.min(prev.fromMs, fromMs), toMs: Math.max(prev.toMs, toMs) }
        : { kind: 'polls', count: polls.length, fromMs, toMs };
    }
    const nocidChunks = new Set([...(plain.get('') ?? []), ...(flagged.get('') ?? [])]);
    // Потоки, уже прочитанные заданием, которое дополняется, второй раз не читаются.
    const readable = new Map([...plain].filter(([cid]) => cid !== '' && !this.#flows.has(cid)));
    this.found = readable.size;

    const byChunk = new Map<number, string[]>();
    for (const [cid, idx] of readable) for (const i of idx) byChunk.set(i, [...(byChunk.get(i) ?? []), cid]);
    // По времени: куски идут от конца окна к началу.
    const withMatches = [...new Set([...byChunk.keys(), ...nocidChunks])].sort((a, b) => b - a);
    const picked = pickChunks(withMatches, (c) => byChunk.get(c) ?? [], { maxFlows: MAX_OP_FLOWS, maxChunks: MAX_OP_CHUNKS });
    const selected = new Set(picked.chunks);
    this.#markUnread(chunks, withMatches, selected, picked.cids, readable);

    this.stage = 'fetch';
    const plan = picked.chunks
      .sort((a, b) => b - a)
      .map((c) => {
        const cids = (byChunk.get(c) ?? []).filter((x) => picked.cids.has(x)).sort();
        const batches: string[][] = [];
        for (let k = 0; k < cids.length; k += spec.limits.batchSize) batches.push(cids.slice(k, k + spec.limits.batchSize));
        return { chunk: c, batches, nocid: nocidChunks.has(c) };
      });
    this.progress.batchesTotal = plan.reduce((n, p) => n + p.batches.length + (p.nocid ? 1 : 0), 0);
    const margin = spec.limits.periodMarginMinutes * MINUTE;
    const steps = plan.flatMap((p) => {
      const c = chunks[p.chunk]!;
      const range: Interval = { fromMs: c.fromMs - margin, toMs: Math.min(c.toMs + margin, this.#deps.now()) };
      // Поток продолжается в следующем выбранном куске: хвост ему не нужен.
      const continues = (cid: string) => (readable.get(cid) ?? new Set()).has(p.chunk - 1) && selected.has(p.chunk - 1);
      return [...p.batches.map((batch) => ({ c, range, continues, batch })), ...(p.nocid ? [{ c, range, continues, batch: null }] : [])];
    });
    // Ошибка шага прерывает остальные чтения: потоки уже прочитанных пакетов остаются.
    this.#lines = this.readBudget(spec.limits.maxLinesPerSearch);
    let failed = null as { error: unknown } | null;
    await runInOrder(
      steps,
      parallel,
      async ({ c, range, continues, batch }, _i, stage): Promise<{ error: unknown } | null> => {
        try {
          if (this.#lines.left <= 0) {
            // Предел строк исчерпан до этого шага.
            this.truncated = true;
            if (batch) this.#miss(batch, c);
            return null;
          }
          if (batch) await this.#readBatch(batch, c, range, continues, stage);
          else await this.#readNocid(range, stage);
          if (this.status === 'running') this.progress.batchesDone++;
          return null;
        } catch (error) {
          return { error };
        }
      },
      (result) => {
        if (result) failed = result;
        return !result && this.status === 'running';
      },
      { signal, failed: (r) => r !== null },
    );
    this.#settleMissed();
    if (failed) {
      if (isCancel(failed.error, signal)) return;
      if (!this.error) this.error = errorOf(failed.error, 'fetch');
      return this.#finish();
    }
    if (this.status !== 'running') return;
    this.#publish();
    this.#finish();
  }

  /** Сводки прочитанных потоков в общий список задания: для «Поток N из M» и подписи строк. */
  #publish(): void {
    const out = [...this.#flows.keys()].map((cid) => this.request(cid)?.summary).filter((s) => s !== undefined);
    out.sort((a, b) => b.firstMs - a.firstMs);
    this.requests.push(...out);
  }

  /**
   * Строка непрочитанной середины окна: потоки только из невыбранных кусков и потоки, у которых совпадения есть и там.
   * Один correlation_id на всё окно читается с краёв: его середина тоже не прочитана, итог — по неполным данным.
   */
  #markUnread(chunks: readonly Interval[], withMatches: readonly number[], selected: ReadonlySet<number>, read: ReadonlySet<string>, readable: ReadonlyMap<string, Set<number>>): void {
    const skipped = withMatches.filter((c) => !selected.has(c));
    const left = [...readable.keys()].filter((cid) => !read.has(cid));
    for (const cid of read) if ([...(readable.get(cid) ?? [])].some((c) => !selected.has(c))) this.#partly.add(cid);
    if (left.length === 0 && this.#partly.size === 0) return;
    const idx = skipped.length > 0 ? skipped : withMatches;
    this.#unread.push({
      kind: 'unread',
      count: left.length + this.#partly.size,
      fromMs: Math.min(...idx.map((i) => chunks[i]!.fromMs)),
      toMs: Math.max(...idx.map((i) => chunks[i]!.toMs)),
      reason: 'limit',
    });
  }

  /** Потоки пакета, чьё чтение оборвал предел строк. Час запоминается первый. */
  #miss(batch: readonly string[], c: Interval): void {
    for (const cid of batch) if (!this.#missed.has(cid)) this.#missed.set(cid, c);
  }

  /**
   * Итог по оборванным пакетам, когда чтения этапа кончились: поток со строками из любого часа — «записи неполные»,
   * поток без единой строки — в строку непрочитанного за час пакета. Поток из строки #markUnread второй раз не считается.
   */
  #settleMissed(): void {
    const rows = new Map<Interval, number>();
    for (const [cid, c] of this.#missed) {
      const f = this.#flows.get(cid);
      if (f) f.incomplete = true;
      else if (!this.#partly.has(cid)) rows.set(c, (rows.get(c) ?? 0) + 1);
    }
    this.#missed.clear();
    for (const [c, count] of rows) this.#unread.push({ kind: 'unread', count, fromMs: c.fromMs, toMs: c.toMs, reason: 'limit' });
  }

  #query(filter: string, range: Interval): LinesQuery {
    return { selector: this.spec.selector, filters: [{ kind: 'regex', pattern: filter }], range: { ...range }, limit: this.spec.limits.maxLinesPerQuery, direction: 'forward' };
  }

  /** Строки в поток с отсевом повторов по хэшу времени и строки. Возвращает correlation_id новых записей. */
  #take(lines: readonly LogLine[], only: ReadonlySet<string>, readEndMs: number): void {
    for (const l of lines) {
      const rec = this.spec.profile.parse(l);
      if (rec.correlationId === null || !only.has(rec.correlationId)) continue;
      let f = this.#flows.get(rec.correlationId);
      if (!f) {
        f = { records: [], hashes: new Set(), incomplete: this.#partly.has(rec.correlationId), readEndMs };
        this.#flows.set(rec.correlationId, f);
        this.keep.add(rec.correlationId);
      }
      const h = lineHash(l.tsNs, l.line);
      if (f.hashes.has(h)) continue;
      f.hashes.add(h);
      f.records.push(rec);
      if (rec.requestId) this.keep.add(rec.requestId);
    }
    for (const cid of only) {
      const f = this.#flows.get(cid);
      if (f) f.readEndMs = Math.max(f.readEndMs, readEndMs);
    }
  }

  async #readBatch(batch: readonly string[], c: Interval, range: Interval, continues: (cid: string) => boolean, signal: AbortSignal): Promise<void> {
    const only = new Set(batch);
    const filter = batch.map(escapeRegex).join('|');
    const read = await readLines(this.#deps, this.spec.env, this.#query(filter, range), this.#lines, signal);
    if (signal.aborted) return;
    const { lines, truncated } = read;
    this.#linesRead += lines.length;
    this.#take(lines, only, range.toMs);
    this.noteRead(read);
    if (truncated) {
      this.#miss(batch, c);
      return;
    }
    // Хвост: последняя запись у конца окна чтения или отправка без ответа — один запрос на пакет за 15 минут вперёд.
    const now = this.#deps.now();
    if (range.toMs >= now) {
      // Окно уже упирается в текущее время: дочитывать нечего, поток у границы — «записи неполные».
      for (const cid of batch) if (this.#nearEdge(cid, range.toMs)) this.#flows.get(cid)!.incomplete = true;
      return;
    }
    const tail = batch.filter((cid) => !continues(cid) && (this.#nearEdge(cid, range.toMs) || this.#openSend(cid, range.toMs)));
    if (tail.length === 0) return;
    const tailRange: Interval = { fromMs: range.toMs, toMs: Math.min(range.toMs + TAIL_MS, now) };
    const more = await readLines(this.#deps, this.spec.env, this.#query(tail.map(escapeRegex).join('|'), tailRange), this.#lines, signal);
    if (signal.aborted) return;
    this.#linesRead += more.lines.length;
    this.#take(more.lines, new Set(tail), tailRange.toMs);
    this.noteRead(more);
    for (const cid of tail) {
      const f = this.#flows.get(cid);
      if (f && (more.truncated || this.#nearEdge(cid, tailRange.toMs))) f.incomplete = true;
    }
  }

  /**
   * Записи с id операции без correlation_id. Строки, где выражение подсчёта находит ключ, исключает хранилище: это потоки
   * и опросы партнёра, подсчёт отнёс к пустому ключу только остальные. Группы — в форме (?P<…>, её понимает любой RE2.
   */
  async #readNocid(range: Interval, signal: AbortSignal): Promise<void> {
    const q = this.#query(this.operation.search.pattern, range);
    q.filters.push({ kind: 'not-regex', pattern: re2Canonical(this.spec.profile.countRegexp) });
    const read = await readLines(this.#deps, this.spec.env, q, this.#lines, signal);
    if (signal.aborted) return;
    const { lines } = read;
    this.#linesRead += lines.length;
    this.noteRead(read);
    for (const l of lines) {
      const h = lineHash(l.tsNs, l.line);
      if (this.#nocid.has(h)) continue;
      const rec = this.spec.profile.parse(l);
      if (rec.correlationId !== null) continue;
      this.#nocid.set(h, rec);
    }
  }

  /**
   * Последняя запись потока не позже конца окна чтения endMs ближе EDGE_MS к нему. Время — хранилища, как у окна чтения:
   * записи более позднего часа, прочитанные раньше, в счёт не идут.
   */
  #nearEdge(cid: string, endMs: number): boolean {
    const f = this.#flows.get(cid);
    if (!f) return false;
    let last = -Infinity;
    for (const r of f.records) {
      const t = tsNsToMs(r.tsNs);
      if (t <= endMs && t > last) last = t;
    }
    return endMs - last < EDGE_MS;
  }

  /** Отправка без ответа не позже endMs. Ответ ищется среди всех записей: ответ из позднего часа её закрывает. */
  #openSend(cid: string, endMs: number): boolean {
    const f = this.#flows.get(cid);
    if (!f) return false;
    const sorted = sortRecords(f.records);
    const answered = new Set(pairExchanges(sorted).values());
    return sorted.some((r, i) => r.kind === 'send' && tsNsToMs(r.tsNs) <= endMs && !answered.has(i));
  }
}

/** Записи потока операции для страницы запроса: размеченные, до маскирования. */
export function annotatedView(records: ParsedRecord[], read: { readEndMs: number; incomplete: boolean }, resolver: Resolver | null): ViewRecord[] {
  return annotateRecords(markPending(buildView(records, { withOffsets: true }), read), resolver);
}
