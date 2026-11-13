// Журнал для Kubernetes: JSON в stdout, в каждой записи timestamp, level словом, message и request_id.
// Адреса в журнале нет: только шаблон маршрута. В пути бывают значение операции, correlation_id и идентификатор короткой ссылки, а по нему ссылка открывается.

import { randomUUID } from 'node:crypto';
import type { Writable } from 'node:stream';
import { LogController, type FastifyBaseLogger, type FastifyServerOptions } from 'fastify';
import type { QueryTiming } from './backends/registry.ts';

/** request_id записей вне запроса: старт, остановка, фоновая работа. */
export const SYSTEM_REQUEST_ID = 'system';
export const LOG_LEVELS: readonly string[] = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];
export const DEFAULT_LOG_LEVEL = 'info';

const REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;
/** 13 цифр подряд похожи на номер карты: такой заголовок в журнал не идёт. У UUID цифр подряд не больше 12. */
const CARD_LIKE = /\d{13}/;
/**
 * Идентификатор ingress-nginx: 32 шестнадцатеричных знака. В 1,8% из них случайно 13 цифр подряд; буква a–f значит, что это
 * вывод генератора, а не номер. Шире нельзя: `pan-4111111111111111` с буквой прошёл бы.
 */
const PROXY_HEX_ID = /^(?=[0-9]*[a-f])[0-9a-f]{32}$/i;

/** Идентификатор от входного прокси, если он безопасен, иначе новый. */
export function requestId(req: { headers: Record<string, string | string[] | undefined> }): string {
  const given = req.headers['x-request-id'];
  return typeof given === 'string' && REQUEST_ID.test(given) && (PROXY_HEX_ID.test(given) || !CARD_LIKE.test(given)) ? given : randomUUID();
}

/**
 * Запись о времени запроса к хранилищу: вид, хранилище, окно, ожидание, работа, строки, исход и чей запрос — поиск, проект,
 * среда. Чтение из обработчика пишется с request_id своего запроса. Значений поиска и строк лога в записи нет.
 */
export function queryLog(log: FastifyBaseLogger): (timing: QueryTiming) => void {
  return ({ trace, ...timing }) => {
    const ids = { ...(trace?.search ? { searchId: trace.search } : {}), ...(trace?.project ? { project: trace.project } : {}), ...(trace?.env ? { env: trace.env } : {}) };
    (trace?.requestId ? log.child({ request_id: trace.requestId }) : log).info({ ...timing, ...ids }, 'запрос к хранилищу');
  };
}

/**
 * Метка маршрута для журнала и метрик: значений нет, число значений ограничено. Шаблон только у API, проверок и метрик:
 * файлы интерфейса объявлены отдельными маршрутами, их сотни, а страницы интерфейса идут одним маршрутом и содержат идентификаторы в адресе.
 */
export function routeLabel(route: string | undefined): string {
  if (route === undefined) return 'unmatched';
  return route.startsWith('/api/') || route === '/health' || route.startsWith('/health/') || route === '/metrics' ? route : 'web';
}

interface RequestFacts {
  method: string;
  routeOptions?: { url?: string | undefined };
}

export function loggerOptions(stream?: Writable): Exclude<FastifyServerOptions['logger'], boolean | undefined> {
  const options = {
    level: process.env.LOG_LEVEL?.trim() || DEFAULT_LOG_LEVEL,
    // pid и hostname в кластере ничего не добавляют.
    base: null,
    messageKey: 'message',
    timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
    formatters: { level: (label: string) => ({ level: label }) },
    // У записи запроса request_id уже есть в привязках дочернего журнала: второй такой же ключ в строке недопустим.
    mixin: (_merge: object, _level: number, logger: { bindings(): Record<string, unknown> }) => ('request_id' in logger.bindings() ? {} : { request_id: SYSTEM_REQUEST_ID }),
    redact: ['req.headers.authorization', 'req.headers.cookie'],
    serializers: {
      req: (req: RequestFacts) => ({ method: req.method, route: routeLabel(req.routeOptions?.url) }),
      // Текст ошибки может повторять значения поиска или строку лога: только тип и код.
      err: (err: { name?: string; code?: unknown }) => ({ type: err.name, code: err.code }),
    },
    ...(stream ? { stream } : {}),
  };
  // Типы Fastify требуют от err поля message и stack, а их здесь нет намеренно.
  return options as unknown as Exclude<FastifyServerOptions['logger'], boolean | undefined>;
}

/** Свои записи Fastify тоже без адреса и текста ошибки: по умолчанию в них URL и error.message, где бывают значения. */
class SafeLogController extends LogController {
  override routeNotFound(request: Parameters<LogController['routeNotFound']>[0]): void {
    if (!this.isLogDisabled(request)) request.log.info('маршрут не найден');
  }

  override defaultErrorLog(error: Parameters<LogController['defaultErrorLog']>[0], request: Parameters<LogController['defaultErrorLog']>[1], reply: Parameters<LogController['defaultErrorLog']>[2]): void {
    if (this.isLogDisabled(request)) return;
    if (reply.statusCode >= 500) reply.log.error({ req: request, res: reply, err: error }, 'запрос завершился ошибкой');
    else reply.log.info({ res: reply, err: error }, 'запрос завершился ошибкой');
  }

  override writeHeadError(error: Parameters<LogController['writeHeadError']>[0], request: Parameters<LogController['writeHeadError']>[1], reply: Parameters<LogController['writeHeadError']>[2]): void {
    if (!this.isLogDisabled(request)) reply.log.warn({ req: request, res: reply, err: error }, 'заголовки ответа не записаны');
  }
}

export const createLogController = (): LogController => new SafeLogController({ requestIdLogLabel: 'request_id' });

/** Запись того же формата там, где журнала сервера ещё нет или он не нужен: ошибка настройки, команда миграций. */
export function logLine(level: 'info' | 'warn' | 'error' | 'fatal', message: string, out: Pick<Writable, 'write'> = process.stdout): void {
  out.write(`${JSON.stringify({ level, timestamp: new Date().toISOString(), request_id: SYSTEM_REQUEST_ID, message })}\n`);
}
