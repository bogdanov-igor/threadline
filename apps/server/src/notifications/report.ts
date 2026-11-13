// «Сообщить о проблеме»: текст человека и короткая ссылка уходят в Telegram. Содержимого записей сервер сюда не подставляет.
// Текст проходит ту же маску, что журнал: форма просит не вставлять персональные данные, а вставленный номер карты в чат не уйдёт.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { REPORT_MAX_TEXT, reportPage, type ReportSent } from '@threadline/core';
import { ownerOf } from '../auth/access.ts';
import type { ErrorCode, ErrorExtra } from '../search/routes.ts';
import type { MessageSender } from './telegram.ts';

const BODY_LIMIT = 16 * 1024;
const WINDOW_MS = 10 * 60_000;
const PER_PERSON = 5;
const IN_TOTAL = 30;
/** Только адрес короткой ссылки: произвольную ссылку в чат форма не положит. */
const LINK = /^https?:\/\/[^\s/?#]{1,255}\/s\/[A-Za-z0-9_-]{22}$/;
const FIELDS = new Set(['text', 'link', 'page']);
export const REPORT_FAILED_EVENT = 'report_not_delivered';

export interface ReportContext {
  sender: MessageSender | null;
  now: () => number;
  fail: (reply: FastifyReply, code: ErrorCode, extra?: ErrorExtra) => FastifyReply;
  mask: (text: string) => string;
}

/** Предел по человеку и общий: скользящее окно в памяти. Сервер один, а перезапуск окно обнуляет безвредно. */
export class ReportLimiter {
  readonly #now: () => number;
  readonly #people = new Map<string, number[]>();
  #all: number[] = [];

  constructor(now: () => number) {
    this.#now = now;
  }

  /** Секунды до следующей попытки, если предел исчерпан; иначе попытка записана. */
  take(person: string): number | null {
    const now = this.#now();
    const alive = (list: readonly number[]) => list.filter((t) => t > now - WINDOW_MS);
    for (const [key, list] of this.#people) {
      const left = alive(list);
      if (left.length > 0) this.#people.set(key, left);
      else this.#people.delete(key);
    }
    this.#all = alive(this.#all);
    const mine = this.#people.get(person) ?? [];
    const full = mine.length >= PER_PERSON ? mine : this.#all.length >= IN_TOTAL ? this.#all : null;
    if (full) return Math.max(1, Math.ceil((full[0]! + WINDOW_MS - now) / 1000));
    this.#people.set(person, [...mine, now]);
    this.#all.push(now);
    return null;
  }
}

function parse(b: unknown): { text: string; link: string | null; page: string | null } | string {
  if (typeof b !== 'object' || b === null || Array.isArray(b)) return 'тело запроса: нужен объект JSON';
  const body = b as Record<string, unknown>;
  for (const name of Object.keys(body)) if (!FIELDS.has(name)) return `неизвестное поле «${name}»`;
  if (typeof body.text !== 'string') return 'text: строка';
  const text = body.text.trim();
  if (!text) return 'text: пустое описание';
  if (text.length > REPORT_MAX_TEXT) return `text: не длиннее ${REPORT_MAX_TEXT} символов`;
  const link = body.link ?? null;
  if (link !== null && (typeof link !== 'string' || !LINK.test(link))) return 'link: адрес короткой ссылки или null';
  const page = body.page ?? null;
  if (page !== null && typeof page !== 'string') return 'page: строка или null';
  return { text, link, page: page === null ? null : reportPage(page) };
}

export function registerReportRoutes(app: FastifyInstance, { sender, now, fail, mask }: ReportContext): void {
  const limiter = new ReportLimiter(now);
  app.post('/api/report', { bodyLimit: BODY_LIMIT, config: { access: 'view' } }, async (req: FastifyRequest, reply): Promise<ReportSent | FastifyReply> => {
    const parsed = parse(req.body);
    if (typeof parsed === 'string') return fail(reply, 'bad-request', { details: parsed });
    // В записи журнала только вид и шаблон страницы: в тексте может быть номер карты, а по короткой ссылке открывается страница.
    if (!sender) {
      // Предел здесь бережёт только журнал: ответ один и тот же, форма каждый раз показывает контакт поддержки.
      if (limiter.take(ownerOf(req)) === null) req.log.warn({ event: REPORT_FAILED_EVENT, kind: 'not-configured', page: parsed.page }, 'сообщение о проблеме не отправлено: Telegram не настроен');
      return fail(reply, 'report-not-configured');
    }
    const wait = limiter.take(ownerOf(req));
    if (wait !== null) return fail(reply, 'report-rate-limited', { retryAfterSeconds: wait });
    const result = await sender.send(['Threadline: сообщение о проблеме', mask(parsed.text), ...(parsed.link ? [parsed.link] : [])].join('\n\n'));
    if (!result.ok) {
      req.log.warn({ event: REPORT_FAILED_EVENT, kind: 'failed', page: parsed.page, reason: result.reason }, `сообщение о проблеме не отправлено: ${result.reason}`);
      return fail(reply, 'report-failed');
    }
    return { sent: true };
  });
}
