// Текст для тикета: собирается в браузере, значения под маской независимо от показа скрытого.
// Маска та же, что у сервера для журнала: все виды, строгая. ID запроса и ссылка под неё не идут: это и есть то, что передаётся.
import { BUILTIN_MASKING, maskKindsText, maskText } from '@threadline/core/search';
import type { TFunction } from 'i18next';
import type { ShareTicket } from './slot.tsx';

const NO_KEEP: ReadonlySet<string> = new Set();
/** Текст на выход: значения под маской независимо от настройки проекта и роли. Её же читает блок «Что случилось» на странице операции. */
export const masked = (s: string) => maskKindsText(maskText(s, NO_KEEP), BUILTIN_MASKING.strict, NO_KEEP);

/** link: адрес короткой ссылки или подпись на её месте в предпросмотре; null — ссылки нет, строки тоже. */
export function ticketText(t: TFunction, ticket: ShareTicket, link: string | null): string {
  const { title, at, env, reason, where, requestId, operationId } = ticket;
  return [
    `**${masked(title)}**`,
    `${at} · ${masked(env)}`,
    reason ? t('share.ticket.reason', { text: masked(reason) }) : null,
    where ? t('share.ticket.where', { text: masked(where) }) : null,
    requestId ? t('share.ticket.requestId', { id: requestId }) : null,
    operationId ? t('share.ticket.operationId', { id: masked(operationId) }) : null,
    link,
  ]
    .filter((line): line is string => !!line)
    .join('\n');
}
