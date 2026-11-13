// Модуль хранилища логов. Язык запросов хранилища живёт только в адаптерах.

import type { BackendErrorCode } from '../api.ts';

export type MatchOp = '=' | '!=' | '=~' | '!~';

/** Условие на метку потока. `!~` исключение, как `!=`: положительным условием селектора не считается. */
export interface Matcher {
  label: string;
  op: MatchOp;
  value: string;
}

/** Условие на строку лога. not-* — как `!=` и `!~` в Grafana: строка с таким значением отбрасывается хранилищем. */
export type Filter = { kind: 'contains'; value: string } | { kind: 'regex'; pattern: string } | { kind: 'not-contains'; value: string } | { kind: 'not-regex'; pattern: string };

/** То же значение, но как условие исключения. */
export function negateFilter(f: Filter): Filter {
  switch (f.kind) {
    case 'contains':
      return { kind: 'not-contains', value: f.value };
    case 'regex':
      return { kind: 'not-regex', pattern: f.pattern };
    default:
      return f;
  }
}

/**
 * Проверка строки тем же условием, что уходит в хранилище. Значения поиска — подстрока или шаблон из цифр (search/terms.ts),
 * они читаются одинаково и в RE2, и здесь.
 */
export function lineTest(f: Filter): (line: string) => boolean {
  switch (f.kind) {
    case 'contains':
      return (line) => line.includes(f.value);
    case 'not-contains':
      return (line) => !line.includes(f.value);
    case 'regex':
    case 'not-regex': {
      const re = new RegExp(f.pattern);
      return f.kind === 'regex' ? (line) => re.test(line) : (line) => !re.test(line);
    }
  }
}

export interface TimeRange {
  fromMs: number;
  toMs: number;
  /**
   * Точная граница в наносекундах строкой, включительно. Если задана, хранилище берёт её вместо fromMs/toMs.
   * Нужна для продолжения страниц: в мс теряются наносекунды времени строки.
   */
  fromNs?: string;
  toNs?: string;
}

export interface CheckInfo {
  /** Имена индексных меток, которые хранилище видит за последние минуты. */
  labelNames: string[];
}

export interface LogLine {
  /** Время Loki в наносекундах, строкой. */
  tsNs: string;
  line: string;
  labels: Record<string, string>;
}

export interface LinesQuery {
  selector: Matcher[];
  filters: Filter[];
  /** Включительно с обеих сторон. */
  range: TimeRange;
  limit: number;
  direction: 'forward' | 'backward';
}

/**
 * Ключ подсчёта. regexp — выражение RE2 с ровно одной именованной группой `(?P<cid>…)` над сырой строкой хранилища;
 * его строит сервис из профиля формата проекта. Модуль хранилища форматов не знает: адаптер только переводит
 * выражение в свой язык запросов (Loki — `| regexp`, VictoriaLogs — `| extract_regexp`). Место под форму
 * `{ field }`, если correlation_id станет полем хранилища.
 */
export interface CountKey {
  regexp: string;
}

export interface CountQuery {
  selector: Matcher[];
  filters: Filter[];
  range: TimeRange;
  key: CountKey;
  /** Поиск операции: строки без ключа считаются под пустым ключом ''. */
  keepEmpty?: boolean;
  /**
   * Признак строки: выражение RE2 с одной группой `(?P<flag>…)`. Строки, где оно совпало, считаются отдельно
   * под ключом `<ключ>` + FLAG_SUFFIX. Рядов не больше вдвое, просмотр тот же.
   */
  flag?: { regexp: string };
}

/** Группа признака строки в CountQuery.flag. */
export const FLAG_GROUP = 'flag';
/** Окончание ключа подсчёта строк с признаком. */
export const FLAG_SUFFIX = '\u0000flag';

/** Запрос для ссылки в интерфейс хранилища: те же селектор и фильтры, что у чтения строк. */
export interface ExploreQuery {
  selector: Matcher[];
  filters: Filter[];
  range: { fromMs: number; toMs: number };
}

export interface LogBackend {
  check(signal: AbortSignal): Promise<CheckInfo>;
  labelValues(label: string, scope: Matcher[], range: TimeRange, signal: AbortSignal): Promise<string[]>;
  /** Строки по возрастанию tsNs для forward и по убыванию для backward. */
  queryLines(q: LinesQuery, signal: AbortSignal): Promise<LogLine[]>;
  /** Число записей по ключу подсчёта, без чтения строк. Строки без ключа и пустой ключ не учитываются. */
  countBy(q: CountQuery, signal: AbortSignal): Promise<Record<string, number>>;
  /**
   * Адрес запроса в интерфейсе хранилища, без сети. Нет метода или undefined — ссылки нет совсем (имитация, выключена,
   * адрес нельзя показать); null — адрес длиннее предела.
   */
  exploreUrl?(q: ExploreQuery): string | null | undefined;
}

export class BackendError extends Error {
  readonly code: BackendErrorCode;
  readonly details: string | undefined;
  readonly retryAfterSeconds: number | undefined;
  readonly status: number | undefined;

  constructor(
    code: BackendErrorCode,
    opts: { details?: string; retryAfterSeconds?: number; status?: number; cause?: unknown } = {},
  ) {
    super(opts.details ? `${code}: ${opts.details}` : code, { cause: opts.cause });
    this.name = 'BackendError';
    this.code = code;
    this.details = opts.details;
    this.retryAfterSeconds = opts.retryAfterSeconds;
    this.status = opts.status;
  }
}

export function isBackendError(e: unknown): e is BackendError {
  return e instanceof BackendError;
}
