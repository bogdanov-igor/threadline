// Генератор демо-логов быстрого старта (deploy/quickstart): записи набора Demo Pay для push API Loki.
// Здесь только данные, без сети: цикл и запросы к Loki в cli/demo-logs.ts. README.ru.md, «Быстрый старт».

import { createHash } from 'node:crypto';
import {
  generatePayDataset,
  LIVE_SCENARIOS,
  MOCK_PHONE,
  MOCK_SPECIAL,
  payScenario,
  type LiveIds,
  type LiveScenario,
  type MockRecord,
} from '../backends/mock/dataset-pay.ts';
import { rng, type Rng } from '../backends/mock/rand.ts';

/** Значения, которые генератор пишет постоянно: по ним README предлагает искать. */
export const DEMO_IDS = {
  user: MOCK_SPECIAL.gatewayUserId,
  card: MOCK_SPECIAL.exactPan,
  phone: MOCK_PHONE.value,
} as const;

/** namespace основных записей набора: его читает среда demo файла быстрого старта. */
export const DEMO_NAMESPACE = 'pay';

/** Запросы постоянного пользователя по кругу: успешные и с ошибками. */
const USER_SCENARIOS: LiveScenario[] = [
  'card-info',
  'transfer-fee',
  'payment-declined',
  'acquirer-error',
  'fraud-timeout',
  'kyc-rejected',
];
/** Поиск постоянной карты: по очереди успешный и с отказом процессинга по второй карте. */
const CARD_SCENARIOS: LiveScenario[] = ['card-lookup', 'card-lookup-failed'];

/**
 * Постоянный запрос раз в минуту: пользователь, карта и телефон по кругу, каждое значение раз в 3 минуты.
 * За 6 часов, период поиска по умолчанию, это 120 запросов на значение: меньше предела поиска в 200.
 */
export const STABLE_EVERY_MS = 60_000;
/** После простоя дольше этого (сон машины, пауза контейнера) пропущенное время не догоняется. */
export const MAX_CATCH_UP_MS = 5 * 60_000;

export interface PushStream {
  stream: Record<string, string>;
  /** Время в наносекундах строкой и строка записи. */
  values: [string, string][];
}

/** Тело POST /loki/api/v1/push в JSON. */
export interface PushBody {
  streams: PushStream[];
}

const byTime = (a: MockRecord, b: MockRecord) => (a.tsNs < b.tsNs ? -1 : a.tsNs > b.tsNs ? 1 : 0);

/** Случайный под записи набора. Постоянный под воркера без correlation_id (MOCK_FLOW.nocidPod) под шаблон не подходит и остаётся. */
const RANDOM_POD = /^pay-app-([a-z]+)-6f8d9c7b5d-[a-z]{5}$/;

/**
 * Метки потока Loki. Набор даёт каждой записи случайный под, и в Loki каждая запись стала бы своим потоком.
 * Здесь под и узел постоянные у компонента в namespace: потоков столько же, сколько у настоящего развёртывания.
 */
export function streamLabels(labels: Record<string, string>): Record<string, string> {
  const m = RANDOM_POD.exec(labels.pod ?? '');
  if (!m) return { ...labels };
  const h = createHash('sha256')
    .update(`${labels.namespace ?? ''}/${m[1]}`)
    .digest();
  const suffix = Array.from(h.subarray(0, 5), (b) => String.fromCharCode(97 + (b % 26))).join('');
  return { ...labels, pod: `pay-app-${m[1]}-6f8d9c7b5d-${suffix}`, host: `demo-node-${h[5]! % 4}` };
}

/** Записи одним телом push: по потоку на набор меток, внутри потока по возрастанию времени. */
export function pushBody(records: readonly MockRecord[]): PushBody {
  const streams = new Map<string, PushStream>();
  for (const rec of [...records].sort(byTime)) {
    const stream = streamLabels(rec.labels);
    const key = JSON.stringify(Object.entries(stream).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    let s = streams.get(key);
    if (!s) streams.set(key, (s = { stream, values: [] }));
    s.values.push([rec.tsNs.toString(), rec.line]);
  }
  return { streams: [...streams.values()] };
}

/** Записи кусками до maxBytes текста строк, в порядке входа: один push укладывается в предел запроса Loki. Запись больше предела идёт одна. */
export function batches(records: readonly MockRecord[], maxBytes: number): MockRecord[][] {
  const out: MockRecord[][] = [];
  let current: MockRecord[] = [];
  let size = 0;
  for (const rec of records) {
    const n = Buffer.byteLength(rec.line);
    if (current.length > 0 && size + n > maxBytes) {
      out.push(current);
      current = [];
      size = 0;
    }
    current.push(rec);
    size += n;
  }
  if (current.length > 0) out.push(current);
  return out;
}

/** История за сутки до nowMs: весь набор Demo Pay, тот же, что показывает хранилище-имитация. */
export function history(nowMs: number): MockRecord[] {
  return generatePayDataset(nowMs).records;
}

export interface LiveFeedOptions {
  startMs: number;
  /** Раз в столько начинается случайный запрос. */
  intervalMs: number;
  seed: number;
}

/**
 * Живой поток: запросы набора со временем «сейчас». Шаги запроса отдаются, когда их время пришло:
 * ответ через 20 секунд приходит через 20 секунд, а до этого запрос виден без ответа.
 */
export class LiveFeed {
  readonly #r: Rng;
  readonly #intervalMs: number;
  #nextRandom: number;
  #nextStable: number;
  #stable = 0;
  #pending: MockRecord[] = [];

  constructor(o: LiveFeedOptions) {
    if (!(o.intervalMs > 0)) throw new Error(`недопустимый интервал: ${o.intervalMs}`);
    this.#r = rng(o.seed);
    this.#intervalMs = o.intervalMs;
    this.#nextRandom = o.startMs;
    this.#nextStable = o.startMs;
  }

  /** Записи начатых запросов, чьё время ещё не пришло. */
  get pending(): number {
    return this.#pending.length;
  }

  /** Начинает запросы, чьё время пришло, и отдаёт записи со временем не позже nowMs по возрастанию времени. */
  due(nowMs: number): MockRecord[] {
    if (nowMs - this.#nextStable > MAX_CATCH_UP_MS) this.#nextStable = nowMs;
    if (nowMs - this.#nextRandom > MAX_CATCH_UP_MS) this.#nextRandom = nowMs;
    while (this.#nextStable <= nowMs) {
      const [kind, ids] = this.#stableNext();
      this.#start(kind, this.#nextStable, ids);
      this.#nextStable += STABLE_EVERY_MS;
    }
    while (this.#nextRandom <= nowMs) {
      this.#start(this.#r.pick(LIVE_SCENARIOS), this.#nextRandom, {});
      this.#nextRandom += this.#intervalMs;
    }
    const limit = BigInt(Math.trunc(nowMs)) * 1_000_000n;
    const ready = this.#pending.filter((rec) => rec.tsNs <= limit);
    this.#pending = this.#pending.filter((rec) => rec.tsNs > limit);
    return ready.sort(byTime);
  }

  /** Следующий постоянный запрос: пользователь, карта, телефон по кругу, внутри каждого свой круг. */
  #stableNext(): [LiveScenario, LiveIds] {
    const i = this.#stable++;
    const round = Math.floor(i / 3);
    if (i % 3 === 0) return [USER_SCENARIOS[round % USER_SCENARIOS.length]!, { user: DEMO_IDS.user }];
    if (i % 3 === 1) return [CARD_SCENARIOS[round % CARD_SCENARIOS.length]!, { pan: DEMO_IDS.card }];
    return ['phone-contact', { phone: MOCK_PHONE.spellings[round % MOCK_PHONE.spellings.length]! }];
  }

  #start(kind: LiveScenario, startMs: number, ids: LiveIds) {
    this.#pending.push(...payScenario(kind, startMs, this.#r.int(1, 2_147_483_646), ids));
  }
}
