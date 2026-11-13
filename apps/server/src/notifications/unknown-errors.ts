// Новая неописанная ошибка: запись журнала всегда, сообщение в Telegram, если он настроен.
// Наружу идут только имена справочника, идентификаторы, HTTP-статус и код безопасного вида. Текста, пути, хоста, ключа строки и запроса-примера здесь нет:
// маска снимает номера и секреты, но фамилия в тексте или логин в сегменте пути ей не видны.
import { STAND_NUMBER } from '@threadline/core/config';
import type { UnknownErrorFact, UnknownErrorNotifier } from '../catalog/notifier.ts';
import type { MessageSender } from './telegram.ts';

export const UNKNOWN_ERROR_EVENT = 'unknown_error_seen';
export const NOTICE_FAILED_EVENT = 'unknown_error_notice_failed';
export const NOTICE_WINDOW_MS = 60_000;
export const NOTICES_PER_WINDOW = 5;

const MAX_NAME = 120;
const MAX_CODE = 48;
const NUMBER = /^-?\d+$/;
const MAX_DIGITS_RESPONSE = 5;
// В записи приложения поле code бывает кодом из СМС: числа от 4 цифр там скрываются.
const MAX_DIGITS_APP_LOG = 3;
// Слова с разделителем в одном регистре или слово с цифрами. Одно слово может быть фамилией или логином, такой код скрывается в любом регистре.
const SAFE_TOKEN = [/^[A-Z][A-Z0-9]*(?:[-_.:][A-Z0-9]+)+$/, /^[a-z][a-z0-9]*(?:[-_.:][a-z0-9]+)+$/, /^[A-Z]+\d+$/];
const LONG_DIGITS = /\d{7}/;

/** Код придумывает чужая система, значение в нём маска может не узнать: показывается только то, что выглядит как код. status null: запись приложения, а не ответ. */
export function safeCode(code: string | null, status: number | null): string | null {
  if (code === null || code.length > MAX_CODE || LONG_DIGITS.test(code)) return null;
  if (NUMBER.test(code)) return code.replace('-', '').length <= (status === null ? MAX_DIGITS_APP_LOG : MAX_DIGITS_RESPONSE) ? code : null;
  return SAFE_TOKEN.some((shape) => shape.test(code)) ? code : null;
}

export interface UnknownNoticesOptions {
  /** Журнал сервера: формат записи задаёт он, здесь только поля. */
  log: { warn(fields: object, message: string): void };
  /** null: Telegram не настроен, остаётся журнал. */
  sender: MessageSender | null;
  /** Адрес сервиса без пути; null: адрес неизвестен, сообщение называет раздел словами. */
  publicUrl: string | null;
  /** Имена из справочника. Система или метод, которых уже нет в справочнике, это null. */
  names: (project: string, systemId: number | null, methodId: number | null) => { system: string | null; method: string | null };
  /** Маска: в названия справочника человек мог вставить значение. */
  mask: (text: string) => string;
}

interface Notice {
  project: string;
  environment: string;
  stand: string | null;
  system: string | null;
  method: string | null;
  code: string | null;
  codeHidden: boolean;
  status: number | null;
}

const unknownPage = (base: string, project: string) => `${base.replace(/\/+$/, '')}/${encodeURIComponent(project)}/catalog/unknown`;

function noticeText(n: Notice, publicUrl: string | null): string {
  return [
    'Threadline: новая неописанная ошибка',
    `Проект: ${n.project}, среда: ${n.environment}${n.stand === null ? '' : `, стенд: ${n.stand}`}`,
    `Система: ${n.system ?? 'не определена'}, метод: ${n.method ?? 'не описан'}`,
    `Код: ${n.code ?? (n.codeHidden ? 'скрыт' : 'нет')}, HTTP: ${n.status ?? 'нет'}`,
    `Описать: ${publicUrl ? unknownPage(publicUrl, n.project) : 'справочник проекта, раздел «Неизвестное»'}`,
  ].join('\n');
}

function restText(rest: ReadonlyMap<string, number>, publicUrl: string | null): string {
  const total = [...rest.values()].reduce((sum, n) => sum + n, 0);
  const projects = [...rest].map(([project, n]) => `${project}: ${n}`).join(', ');
  const only = rest.size === 1 ? [...rest.keys()][0]! : null;
  return `Threadline: ещё новых неописанных ошибок за минуту: ${total} (${projects})${only !== null && publicUrl ? `, ${unknownPage(publicUrl, only)}` : ''}`;
}

/** Предел в памяти: копия сервиса одна, а перезапуск окно обнуляет безвредно. Записи журнала пределу не подчиняются. */
export class UnknownErrorNotices implements UnknownErrorNotifier {
  readonly #opts: UnknownNoticesOptions;
  /** Остаток минуты по проектам. */
  readonly #rest = new Map<string, number>();
  #sent = 0;
  #timer: NodeJS.Timeout | null = null;
  #closed = false;

  constructor(opts: UnknownNoticesOptions) {
    this.#opts = opts;
  }

  /** Вызов из сброса «Неизвестного»: отправка идёт в фоне и никого не задерживает. */
  unknownError(fact: UnknownErrorFact): void {
    const notice = this.#notice(fact);
    this.#opts.log.warn(
      {
        event: UNKNOWN_ERROR_EVENT,
        project: notice.project,
        environment: notice.environment,
        stand: notice.stand,
        system: notice.system,
        method: notice.method,
        code: notice.code,
        ...(notice.codeHidden ? { code_hidden: true } : {}),
        status: notice.status,
      },
      'новая неописанная ошибка',
    );
    if (!this.#opts.sender || this.#closed) return;
    this.#openWindow();
    if (this.#sent >= NOTICES_PER_WINDOW) {
      this.#rest.set(notice.project, (this.#rest.get(notice.project) ?? 0) + 1);
      return;
    }
    this.#sent++;
    void this.#deliver(noticeText(notice, this.#opts.publicUrl));
  }

  /** Остаток минуты теряется: записи журнала о нём уже есть. Идущая отправка ограничена своим таймаутом, остановку она не держит. */
  close(): void {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #notice(fact: UnknownErrorFact): Notice {
    const { system, method } = this.#opts.names(fact.project, fact.systemId, fact.methodId);
    const status = Number.isInteger(fact.httpStatus) ? fact.httpStatus : null;
    const code = safeCode(fact.code, status);
    return {
      project: fact.project,
      environment: fact.env,
      stand: fact.stand !== null && STAND_NUMBER.test(fact.stand) ? fact.stand : null,
      system: this.#name(system),
      method: this.#name(method),
      code,
      codeHidden: fact.code !== null && code === null,
      status,
    };
  }

  #name(name: string | null): string | null {
    return name === null ? null : this.#opts.mask(name).replace(/\s+/g, ' ').trim().slice(0, MAX_NAME) || null;
  }

  #openWindow(): void {
    if (this.#timer) return;
    this.#timer = setTimeout(() => this.#endWindow(), NOTICE_WINDOW_MS);
    this.#timer.unref();
  }

  #endWindow(): void {
    this.#timer = null;
    this.#sent = 0;
    if (this.#rest.size === 0) return;
    const text = restText(this.#rest, this.#opts.publicUrl);
    this.#rest.clear();
    // Строка остатка занимает место в новой минуте: предел держится и при долгом потоке.
    this.#openWindow();
    this.#sent = 1;
    void this.#deliver(text);
  }

  /** Одна попытка. Без интернета каждая неудача это одна запись журнала, а число попыток в минуту ограничено пределом. */
  async #deliver(text: string): Promise<void> {
    let reason: string | null;
    try {
      const result = await this.#opts.sender!.send(text);
      reason = result.ok ? null : result.reason;
    } catch (e) {
      // Отправка не должна бросать. Если всё же бросила, текст ошибки может повторять адрес с токеном: только тип.
      reason = e instanceof Error ? e.name : typeof e;
    }
    if (reason !== null) this.#opts.log.warn({ event: NOTICE_FAILED_EVENT, reason }, 'оповещение о новой неописанной ошибке не отправлено');
  }
}
