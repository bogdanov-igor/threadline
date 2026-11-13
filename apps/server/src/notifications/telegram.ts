// Отправка в Telegram: заготовка оповещений сервера (catalog/notifier.ts) получила первый настоящий выход.
// Токен и чат только из окружения, запросы через HTTPS_PROXY, если он задан. Токен стоит в адресе запроса, поэтому текст сетевой ошибки наружу и в журнал не идёт.
import { fetch } from 'undici';
import { dispatcherFor } from '../backends/http.ts';

const API = 'https://api.telegram.org';
const TIMEOUT_MS = 10_000;

export type SendResult = { ok: true } | { ok: false; reason: string };

export interface MessageSender {
  /** Не бросает: reason короткий и без адреса, годится для журнала. */
  send(text: string): Promise<SendResult>;
}

/** Причина для журнала: только вид ошибки. message у сетевой ошибки может повторять адрес с токеном. */
function kindOf(e: unknown): string {
  const code = (e as { cause?: { code?: unknown } } | null)?.cause?.code;
  if (typeof code === 'string') return code;
  return e instanceof Error ? e.name : 'ошибка сети';
}

/** null: токен или чат не заданы, отправлять некуда. apiBase и timeoutMs только для тестов, адреса настоящего Telegram там нет. */
export function telegramFromEnv(env: Record<string, string | undefined>, opts: { apiBase?: string; timeoutMs?: number } = {}): MessageSender | null {
  const token = env.THREADLINE_TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.THREADLINE_TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) return null;
  const dispatcher = dispatcherFor(undefined, env);
  const url = `${opts.apiBase ?? API}/bot${token}/sendMessage`;
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  return {
    async send(text) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // Без parse_mode: текст человека идёт как текст, разметка не выполняется.
          body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
          ...(dispatcher ? { dispatcher } : {}),
        });
        await res.body?.cancel().catch(() => {});
        return res.ok ? { ok: true } : { ok: false, reason: `HTTP ${res.status}` };
      } catch (e) {
        return { ok: false, reason: kindOf(e) };
      }
    },
  };
}
