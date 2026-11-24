// Читаемый текст ошибки: сначала смысл, коды отдельно; источник ошибки — проект, внешняя система или неизвестно.
import type { ErrorReason } from '@threadline/core/search';
import i18n from '../i18n/index.ts';
import { upperFirst } from './format.ts';
import { statusMeaning } from './http-status.ts';
import { titleTemplate } from './path-template.ts';
import { systemLabel, type SystemNames } from './systems.ts';

export interface ErrorParts {
  /** Что случилось: «Card not found». */
  message: string;
  /** Коды отдельно: «PRC-ERR-0027», «код 8», «HTTP 500». */
  codes: string[];
}

// Поля бизнес-ошибки, как их называет businessError в core.
const BUSINESS_FIELDS = new Set([
  'response_code',
  'error',
  'result',
  'success',
  'res',
  'result_code',
  'transStatus',
  'resultInfo.code',
  'actionCode',
]);
const BUSINESS = /^([A-Za-z_][\w.]*)(?: ([^\s:]+))?: (.+)$/s;
// Код в начале описания: «PRC-ERR-0027 Card not found».
const LEADING_CODE = /^([A-Z][A-Z0-9]*(?:[-_][A-Z0-9]+)+):?\s+(.+)$/s;

/**
 * Текст ошибки шага или причины — смыслом вперёд. «response_code 8: PRC-ERR-0027 Card not found» →
 * «Card not found» и коды «PRC-ERR-0027», «код 8»; «HTTP 500 — …» → смысл статуса и «HTTP 500». Другой текст — как есть.
 */
export function errorParts(text: string): ErrorParts {
  const s = text.trim();
  const http = /^HTTP (\d{3})(?: — (.+))?$/.exec(s);
  if (http) {
    const meaning = http[2] ?? statusMeaning(Number(http[1]));
    return meaning ? { message: upperFirst(meaning), codes: [`HTTP ${http[1]}`] } : { message: s, codes: [] };
  }
  const m = BUSINESS.exec(s);
  if (!m || !BUSINESS_FIELDS.has(m[1]!)) return { message: s, codes: [] };
  const [, name, code, rest] = m as unknown as [string, string, string | undefined, string];
  // Без описания («response_code: 8») смысла нет — текст как есть.
  if (code === undefined && name !== 'error' && !/\s/.test(rest)) return { message: s, codes: [] };
  const codes: string[] = [];
  let message = rest.trim();
  const lead = LEADING_CODE.exec(message);
  if (lead) {
    codes.push(lead[1]!);
    message = lead[2]!.trim();
  }
  if (code !== undefined && code !== 'false' && code !== 'true') codes.push(i18n.t('reason.code', { code }));
  return { message: upperFirst(message), codes };
}

// Уровень записи в начале текста ошибки шага: «ERROR: текст».
const LEADING_LEVEL = /^(?:TRACE|DEBUG|INFO|NOTICE|WARNING|WARN|ERROR|ERR|CRITICAL|CRIT|ALERT|EMERGENCY|FATAL):\s*/;

/** Только смысл, для «Кратко»: без кодов, «HTTP N» и уровня записи, в том числе когда текст начинается сразу с кода. Остальной текст не переписывается. */
export function meaningOf(text: string): string {
  const { message } = errorParts(text.replace(LEADING_LEVEL, ''));
  const lead = LEADING_CODE.exec(message);
  return lead ? upperFirst(lead[2]!.trim()) : message;
}

/** Слова об отправке без ответа. */
export const noAnswerKey = (o: { pending: boolean }) => (o.pending ? 'trace.pending' : 'trace.noResponse');

/** Чья ошибка: проекта (внутри его функции), внешней системы (отдельный шаг) или неизвестно. */
export type ErrorSource = 'project' | 'external' | 'unknown' | 'pending';

export interface ReasonView {
  source: ErrorSource;
  message: string;
  codes: string[];
  /** Имя системы обмена: «processor». */
  system: string | null;
  /** Хост с нестандартным портом — для подсказки. */
  host: string | null;
  /** «POST /ws/services/Cards» — по нему причина связывается с шагом трассы. */
  call: string | null;
  /** Обмен целиком, как в записи: «POST host:port/path». */
  target: string | null;
  /** Причина целиком, как пришла с сервера. */
  raw: string;
}

/** Текст причины. Смысл причины, которую формирует сам сервер, берётся по её виду на языке интерфейса; адрес в хвосте как есть, формат провода тот же. */
function reasonText(r: ErrorReason): string {
  const own = r.kind === 'no-response' ? i18n.t('reason.noResponse') : r.kind === 'pending' ? i18n.t('trace.pending') : null;
  if (own === null) return r.text;
  const i = r.text.lastIndexOf(' · ');
  return i < 0 ? own : `${own}${r.text.slice(i)}`;
}

/** Причина с сервера «текст · POST host:port/path» — в читаемый вид с источником. */
export function reasonView(r: ErrorReason, names: SystemNames = {}): ReasonView {
  const text = reasonText(r);
  const i = text.lastIndexOf(' · ');
  const tail = i < 0 ? null : titleTemplate(text.slice(i + 3));
  const hasTarget = !!tail?.method;
  const head = hasTarget ? text.slice(0, i) : text;
  const parts = r.kind === 'business' || r.kind === 'http' ? errorParts(head) : { message: upperFirst(head), codes: [] };
  const external = hasTarget && (r.kind === 'business' || r.kind === 'http' || r.kind === 'no-response');
  const source: ErrorSource = r.kind === 'pending' ? 'pending' : r.kind === 'level' ? 'project' : external ? 'external' : 'unknown';
  return {
    source,
    ...parts,
    system: tail?.host ? systemLabel(tail.host, names) : null,
    host: tail?.host ?? null,
    call: hasTarget ? `${tail!.method} ${tail!.template}` : null,
    target: hasTarget ? text.slice(i + 3) : null,
    raw: text,
  };
}
