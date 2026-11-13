import type { TFunction } from 'i18next';
import i18n from '@/i18n/index.ts';
import { DEFAULT_LANGUAGE } from '@/i18n/languages.ts';
import { ApiError } from '@/lib/api.ts';

// Ошибки хранилища называются так же, как при проверке подключения.
const KNOWN = [
  'unauthorized',
  'forbidden',
  'not-found',
  'network',
  'certificate',
  'timeout',
  'overloaded',
  'limit',
  'too-large',
  'busy',
  'bad-response',
  'not-configured',
  'unknown',
  'server-unreachable',
] as const;
type Known = (typeof KNOWN)[number];

const ADVICE = ['timeout', 'limit', 'busy', 'overloaded'] as const;
type Advice = (typeof ADVICE)[number];

// Тексты, которые подходят и для поиска: остальные говорят о проверке подключения.
const GENERIC_TEXT = ['unauthorized', 'forbidden', 'network', 'certificate', 'too-large', 'bad-response', 'unknown', 'server-unreachable'] as const;
type Generic = (typeof GENERIC_TEXT)[number];

const isKnown = (c: string): c is Known => (KNOWN as readonly string[]).includes(c);
const isAdvice = (c: string): c is Advice => (ADVICE as readonly string[]).includes(c);
const isGeneric = (c: string): c is Generic => (GENERIC_TEXT as readonly string[]).includes(c);

export function errorTitle(t: TFunction, code: string): string {
  return t(`connection.status.${isKnown(code) ? code : 'unknown'}.title`);
}

export function errorAdvice(t: TFunction, code: string): string | null {
  if (isAdvice(code)) return t(`search.errorAdvice.${code}`);
  if (isGeneric(code)) return t(`connection.status.${code}.text`);
  return null;
}

/** Бизнесу сервер присылает только код: имён переменных и хранилищ нет, значит и совета о файле настроек тоже. */
export function closedAdvice(t: TFunction, code: string, details: string | undefined): string | null {
  return code === 'not-configured' && !details ? t('connection.status.not-configured.closed') : null;
}

/** Ошибка запуска поиска или загрузки: причина одной строкой. */
export function describeError(t: TFunction, e: unknown): { title: string; advice: string | null; details: string | undefined } {
  if (e instanceof ApiError) {
    if (isKnown(e.code)) return { title: errorTitle(t, e.code), advice: errorAdvice(t, e.code) ?? closedAdvice(t, e.code, e.details), details: e.details };
    // Без текста сервера (ответ Бизнесу) кода на экране нет: только общие слова.
    if (!e.details) return { title: errorTitle(t, 'unknown'), advice: null, details: undefined };
    // Код интерфейсу неизвестен. На других языках общий текст и код: русский текст сервера не стоит на месте заголовка.
    if (i18n.language !== DEFAULT_LANGUAGE) return { title: `${errorTitle(t, 'unknown')} · ${e.code}`, advice: null, details: undefined };
    return { title: e.details, advice: null, details: undefined };
  }
  return { title: errorTitle(t, 'unknown'), advice: null, details: e instanceof Error ? e.message : undefined };
}
