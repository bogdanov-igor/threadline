// Общее правило только по HTTP-статусу. Отдельный файл без zod: проверку вызывает и форма в браузере.

import type { ErrorData } from './schema.ts';

type RuleConditions = Pick<ErrorData, 'http' | 'code' | 'text'>;

/** Условие только по HTTP-статусу. */
export const httpOnlyRule = (e: RuleConditions) => e.http !== null && e.code === null && e.text === null;

/** В строке «Неизвестного» скрытая часть есть, а в тексте настоящей ошибки нет: такая подстрока не совпадёт. Те же знаки, что оставляет маскирование. */
const HIDDEN_PART = /…|\*{2,}/;
export const hiddenPart = (text: string | null): boolean => text !== null && HIDDEN_PART.test(text);

export const TEXT_HIDDEN = { message: 'в подстроке скрытая часть, «…» или звёздочки: в тексте ошибки её нет, и правило не сработает. Оставьте только постоянную часть', key: 'catalog.textHidden' } as const;

export const GENERAL_HTTP_ONLY = { message: 'одного HTTP-статуса в общем правиле мало: этот текст получат все такие ошибки проекта. Добавьте text или code', key: 'catalog.generalHttpOnly' } as const;

/**
 * Общее правило только по HTTP-статусу дало бы одни слова всем таким ошибкам проекта: форма и сервер его не сохраняют.
 * Такая запись из файла или из базы правится и возвращается, пока её условия те же: правка текста её шире не делает.
 */
export function generalRuleTooBroad(d: RuleConditions & { systemId: number | null }, was?: (RuleConditions & { systemId: number | null }) | null): boolean {
  if (d.systemId !== null || !httpOnlyRule(d)) return false;
  return !(was && was.systemId === null && httpOnlyRule(was) && was.http === d.http);
}
