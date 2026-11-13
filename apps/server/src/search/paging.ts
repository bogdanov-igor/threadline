// Постраничное чтение строк с границей продолжения. Страницы не повторяют и не теряют строки,
// даже если на границе несколько строк в одну наносекунду.

import { createHash } from 'node:crypto';
import { BackendError, type LinesQuery, type LogLine } from '@threadline/core/backend';
import type { EnvironmentConfig } from '@threadline/core/config';
import type { Backends } from '../backends/registry.ts';

/** Граница продолжения: время последней отданной строки и хэши уже отданных строк с этим временем. */
export interface PageCursor {
  tsNs: string;
  seen: string[];
}

export interface Page {
  lines: LogLine[];
  next: PageCursor | null;
  /** Страница прочитана с меньшим пределом строк: ответ с прежним не поместился в предел объёма. Продолжать с ним. */
  limit?: number;
}

export interface PageOptions {
  /** Журнал сервера: сдвиг границы с потерей строк. Содержимое строк сюда не попадает. */
  warn?: (message: string) => void;
}

const MS = 1_000_000n;
const MAX_SEEN = 100_000;
const MAX_CURSOR_LENGTH = 4_000_000;
/** Ответ больше предела объёма: страница читается заново с вдвое меньшим пределом строк, не больше стольких раз (5000 → 625). */
export const TOO_LARGE_RETRIES = 3;

/** Хэш строки для `seen`: первые 16 символов sha1 от времени и текста. */
export function lineHash(tsNs: string, line: string): string {
  return createHash('sha1').update(`${BigInt(tsNs)}\n${line}`).digest('hex').slice(0, 16);
}

/**
 * Одна страница строк. `next = null`, если хранилище не вернуло ни одной строки или продолжать некуда: короткая
 * страница — не конец данных, Loki 2.9 обрезает forward-страницы с фильтром строк там, где кончились строки одного
 * из потоков. После полной страницы следующая начинается (forward) или кончается (backward) на времени её последней
 * строки включительно, уже отданные строки этого времени отбрасываются. Короткая страница уже содержит все строки
 * этого времени: следующая начинается через 1 нс после него (backward — кончается за 1 нс до него).
 */
export async function readPage(
  backends: Backends,
  env: EnvironmentConfig,
  q: LinesQuery,
  cursor: PageCursor | null,
  signal: AbortSignal,
  opts: PageOptions = {},
): Promise<Page> {
  if (!Number.isSafeInteger(q.limit) || q.limit < 1) throw new Error(`недопустимый предел строк: ${q.limit}`);
  const forward = q.direction === 'forward';
  let cur = cursor;
  // Предел, с которым страница прочитана: от него зависит, короткая она или полная.
  let limit = q.limit;
  const shrunk = (page: Page): Page => (limit < q.limit ? { ...page, limit } : page);
  for (let attempt = 0, retries = 0; ; attempt++) {
    let raw: LogLine[];
    try {
      raw = await backends.queryLines(env, cur ? continueAt({ ...q, limit }, cur.tsNs) : { ...q, limit }, signal);
    } catch (e) {
      if (!(e instanceof BackendError) || e.code !== 'too-large' || retries >= TOO_LARGE_RETRIES || limit < 2) throw e;
      retries++;
      limit = Math.floor(limit / 2);
      attempt--;
      continue;
    }
    // Конец данных — только пустой ответ.
    if (raw.length === 0) return shrunk({ lines: [], next: null });
    const lines = cur ? unseen(raw, cur, forward) : raw;
    if (!cur || lines.length > 0) {
      const next = nextCursor(raw, cur, forward);
      return shrunk({ lines, next: raw.length < limit ? after(q, next.tsNs, forward) : next });
    }

    // Всё пришедшее уже отдано. Короткий ответ: строк этой наносекунды больше нет, проверяется время сразу за ней.
    // Полный предел: в одной наносекунде строк больше предела, граница сдвигается на 1 нс, иначе чтение
    // зациклится; остальные строки этой наносекунды теряются.
    if (raw.length >= limit) {
      (opts.warn ?? console.warn)(
        `чтение строк: с временем ${cur.tsNs} нс больше ${limit} строк, граница сдвинута на 1 нс, часть строк пропущена`,
      );
    }
    const shifted = after(q, cur.tsNs, forward);
    if (!shifted) return shrunk({ lines: [], next: null });
    cur = shifted;
    // Хранилище, которое не учитывает границу в нс, может снова вернуть то же: дальше решает вызывающий.
    if (attempt > 0) return shrunk({ lines: [], next: cur });
  }
}

/** Запрос следующей страницы. Границы в мс накрывают границу в нс: хранилище без нс отдаст лишнее, не меньше. */
function continueAt(q: LinesQuery, tsNs: string): LinesQuery {
  const t = BigInt(tsNs);
  if (q.direction === 'forward') {
    return { ...q, range: { ...q.range, fromMs: Math.max(q.range.fromMs, Number(t / MS)), fromNs: t.toString() } };
  }
  return { ...q, range: { ...q.range, toMs: Math.min(q.range.toMs, Number((t + MS - 1n) / MS)), toNs: t.toString() } };
}

/** Граница сразу за временем tsNs по направлению чтения; null — это уже за периодом, читать нечего. */
function after(q: LinesQuery, tsNs: string, forward: boolean): PageCursor | null {
  const at = BigInt(tsNs);
  const shifted = forward ? at + 1n : at - 1n;
  if (forward ? shifted > rangeEnd(q) : shifted < rangeStart(q)) return null;
  return { tsNs: shifted.toString(), seen: [] };
}

function unseen(raw: LogLine[], cur: PageCursor, forward: boolean): LogLine[] {
  const at = BigInt(cur.tsNs);
  const seen = new Set(cur.seen);
  return raw.filter((l) => {
    const t = BigInt(l.tsNs);
    if (t === at) return !seen.has(lineHash(l.tsNs, l.line));
    return forward ? t > at : t < at;
  });
}

function nextCursor(raw: LogLine[], cur: PageCursor | null, forward: boolean): PageCursor {
  const edge = raw.reduce<bigint | null>((acc, l) => {
    const t = BigInt(l.tsNs);
    return acc === null || (forward ? t > acc : t < acc) ? t : acc;
  }, null)!;
  const seen = new Set(cur && BigInt(cur.tsNs) === edge ? cur.seen : []);
  for (const l of raw) if (BigInt(l.tsNs) === edge) seen.add(lineHash(l.tsNs, l.line));
  return { tsNs: edge.toString(), seen: [...seen] };
}

const rangeStart = (q: LinesQuery) => (q.range.fromNs !== undefined ? BigInt(q.range.fromNs) : BigInt(Math.trunc(q.range.fromMs)) * MS);
const rangeEnd = (q: LinesQuery) => (q.range.toNs !== undefined ? BigInt(q.range.toNs) : BigInt(Math.trunc(q.range.toMs)) * MS);

export function encodeCursor(c: PageCursor): string {
  return Buffer.from(JSON.stringify({ tsNs: c.tsNs, seen: c.seen }), 'utf8').toString('base64url');
}

const NS = /^(?:0|[1-9]\d{0,19})$/;
const HASH = /^[0-9a-f]{16}$/;

/** Курсор из адреса. Любая ошибка формы — `Error('bad-cursor')`. */
export function decodeCursor(s: string): PageCursor {
  const bad = () => new Error('bad-cursor');
  if (typeof s !== 'string' || s.length === 0 || s.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(s)) throw bad();
  let v: unknown;
  try {
    v = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
  } catch {
    throw bad();
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw bad();
  const { tsNs, seen } = v as { tsNs?: unknown; seen?: unknown };
  if (typeof tsNs !== 'string' || !NS.test(tsNs)) throw bad();
  if (!Array.isArray(seen) || seen.length > MAX_SEEN || !seen.every((h) => typeof h === 'string' && HASH.test(h))) throw bad();
  return { tsNs, seen: seen as string[] };
}
