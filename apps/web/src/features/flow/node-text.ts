// Тексты строк узла, подсказки, подписи для диктора и рёбер.
// Чистые функции: режим меняет только текст, размер узла от него не зависит.
import i18n from '@/i18n/index.ts';
import { formatDuration, formatOffset, upperFirst } from '@/lib/format.ts';
import { meaningOf, noAnswerKey } from '@/lib/error-text.ts';
import { readableTitle } from '@/lib/path-template.ts';
import { systemLabel } from '@/lib/systems.ts';
import { briefMethod, briefSystem, briefTitle } from '@/features/view/brief.ts';
import type { ViewMode as DetailMode } from '@threadline/core/view';
import type { EdgeHint, FlowCatalogStatus, FlowEntryInfo, FlowMark, FlowViewNode, Located } from './model.ts';

export type LineTone = 'normal' | 'danger' | 'warning' | 'muted' | 'success';

export interface NodeLines {
  /** Имя до двух строк: система и метод. */
  name: string;
  outcome: string;
  outcomeTone: LineTone;
  /** Верхняя строка: метод или путь, вид шага, пометка группы. */
  method: string;
  methodTone: LineTone;
  /** Верхняя строка — метод или путь: моноширинная. */
  methodMono: boolean;
  /** Длительность в верхней строке, не обрезается; у шага без ответа прочерк; null — её нет. */
  duration: string | null;
  /** Подпись под узлом: «Внешних вызовов нет: ответ из базы или кэша». */
  note: string | null;
  /** Подсказка: всё, что не влезло в строки по приоритету. */
  title: string;
  /** Подпись для диктора: номер, имя, итог с причиной, длительность, параллельность. */
  aria: string;
}

const t = i18n.t;

export const statusText = (s: FlowCatalogStatus): string => s.name ?? (s.raw || s.value);

const retryPart = (count: number, failed: number) =>
  failed >= count
    ? `${t('flow.mark.attempts', { count })} · ${t('flow.mark.allFailed')}`
    : failed > 0
      ? `${t('flow.mark.attempts', { count })} · ${t('flow.mark.failed', { count: failed })}`
      : t('flow.mark.attempts', { count });

/** Текст пометки узла: «3 попытки · 2 неудачные», «опрос ×5 · Выполнен», «id выдан …4821». */
export function markText(mark: FlowMark): string {
  switch (mark.kind) {
    case 'retry':
      return retryPart(mark.count, mark.failed);
    case 'call':
      return mark.failed > 0
        ? `${t('flow.mark.calls', { count: mark.count })} · ${t('flow.mark.failed', { count: mark.failed })}`
        : t('flow.mark.calls', { count: mark.count });
    case 'poll':
      return mark.status
        ? `${t('flow.mark.poll', { count: mark.count })} · ${statusText(mark.status)}`
        : t('flow.mark.poll', { count: mark.count });
    case 'errors':
      return t('flow.mark.retry', { count: mark.count });
    case 'parallel':
      return t('flow.node.parallel', { count: mark.count });
    case 'more':
      return mark.errors > 0
        ? `${t('flow.node.more', { count: mark.count })} · ${t('flow.mark.errors', { count: mark.errors })}`
        : t('flow.node.more', { count: mark.count });
    case 'related':
      return t('flow.node.moreFlows', { count: mark.count });
    case 'issued':
      return t('flow.mark.issued', { short: mark.short });
    case 'no-calls':
      return t('flow.noExternal');
    case 'callback-early':
      return t('flow.mark.callbackEarly');
  }
}

/** Пометка в режиме: в «Кратко» нет числа повторов и обменов, «id выдан»; у опроса остаётся только статус. */
export function shownMark(mark: FlowMark | null, mode: DetailMode): string | null {
  if (!mark) return null;
  if (mode === 'full') return markText(mark);
  switch (mark.kind) {
    case 'retry':
    case 'call':
    case 'errors':
    case 'issued':
      return null;
    case 'poll':
      return mark.status ? statusText(mark.status) : null;
    default:
      return markText(mark);
  }
}

const markTone = (mark: FlowMark): LineTone =>
  mark.kind === 'callback-early'
    ? 'warning'
    : (mark.kind === 'more' && mark.errors > 0) || mark.kind === 'errors'
      ? 'danger'
      : 'normal';

const EXCHANGE_KINDS: ReadonlySet<FlowViewNode['kind']> = new Set(['exchange', 'async-start']);

/** Строка имени: система или метод проекта; без справочника у обмена — короткое имя хоста. */
export function nodeName(node: FlowViewNode, mode: DetailMode = 'full'): string {
  if (mode === 'full' && node.fallbackName === 'entry' && node.entry === 'gateway') return t('flow.node.entryGateway');
  if (node.kind === 'entry' && node.entry === 'background') return t('flow.node.background');
  // Внутри группы разные системы: имя одной из них выдало бы весь участок за её шаги.
  if (node.group?.kind === 'more' && node.mark?.kind === 'more') return markText(node.mark);
  if (node.kind === 'flow-ref' && node.mark?.kind === 'related') return markText(node.mark);
  if (node.group?.kind === 'parallel' && node.mark?.kind === 'parallel') return markText(node.mark);
  // Запасное имя ядра: интерфейс берёт его из каталога строк. Имя из справочника, даже совпавшее с ним, это данные.
  if (node.fallbackName) return t(`flow.node.${node.fallbackName}`);
  // Ядро без справочника называет обмен хостом: короткое имя читается лучше.
  if (node.component && node.name === node.component) return mode === 'brief' ? briefSystem(node.component) : systemLabel(node.component);
  if (node.related?.titleCode) return t(`operation.flowTitle.${node.related.titleCode}`);
  // Поток без названия в справочнике: метод и путь. Читаемым шаблоном, полный адрес — в подсказке.
  if (node.related) return mode === 'brief' ? briefTitle(node.name, node.related.role === 'worker') : readableTitle(node.name);
  // Обмен без адреса: имя узла — заголовок шага, а в нём метод и адрес.
  if (mode === 'brief' && EXCHANGE_KINDS.has(node.kind) && node.name === node.tech) return briefSystem(null);
  // Вид для Бизнеса: у вызова без названия нет ни текста, ни действия. С обменом внутри это обмен без системы, без него просто вызов.
  if (!node.name && node.kind === 'fn') return node.stepIds.length > 1 ? briefSystem(null) : t('flow.kind.fn');
  return node.name;
}

/** Статус операции узла: «Выполнен», у колбэка — «Отказ · заявлено в колбэке». */
export function opStatusText(node: FlowViewNode): string | null {
  if (!node.opStatus) return null;
  const s = statusText(node.opStatus.status);
  return node.opStatus.claimed ? `${s} · ${t('flow.outcome.claimed')}` : s;
}

/** Имя узла на холсте: система и метод, до двух строк. В «Подробно» метод, который уже стоит в верхней строке, не повторяется. */
export function nodeTitle(node: FlowViewNode, mode: DetailMode): string {
  const name = nodeName(node, mode);
  if (node.kind === 'flow-ref' || node.group?.kind === 'more' || node.group?.kind === 'parallel' || node.kind === 'pause' || node.kind === 'wait') return name;
  if (node.kind === 'entry' && node.entry === 'background') return name;
  const method = mode === 'brief' ? methodLine(node, mode) : node.plain;
  if (!method || method === name) return name;
  if (mode === 'full' && (node.kind === 'entry' || node.tech.includes(method))) return name;
  return `${name} · ${method}`;
}

/** Метрики для подсказки и диктора: «200 · 340 мс · +1 240 мс»; в «Кратко» — «Успешно · 340 мс · +1 240 мс». */
export function metricsText(node: FlowViewNode, mode: DetailMode): string {
  const o = node.outcome;
  const head =
    mode === 'full'
      ? o.http !== null
        ? String(o.http)
        : null
      : o.tone === 'success'
        ? t('flow.outcome.success')
        : o.tone === 'error'
          ? t('flow.outcome.error')
          : null;
  const duration = node.durationMs !== null ? formatDuration(node.durationMs) : null;
  const start = node.kind === 'entry' ? null : formatOffset(node.startMs);
  return [head, opStatusText(node), duration, start].filter(Boolean).join(' · ');
}

/** Причина ошибки или отсутствия ответа: первая по приоритету в строке итога. */
export function reasonText(node: FlowViewNode, mode: DetailMode = 'full'): { text: string; tone: LineTone } | null {
  const o = node.outcome;
  if (o.noResponse)
    return {
      text: t(noAnswerKey(o)),
      tone: o.pending ? 'muted' : 'danger',
    };
  // В «Кратко» коды и «HTTP N» заменяются смыслом, сам текст причины не переписывается.
  if (o.tone === 'error' && o.reason) return { text: mode === 'brief' ? meaningOf(o.reason) : o.reason, tone: 'danger' };
  if (o.noSend) return { text: t('trace.noSend'), tone: 'warning' };
  return null;
}

/** Отрезок времени группы: «+1,5 с – +4 с». */
const spanText = (node: FlowViewNode) => `${formatOffset(node.startMs)} – ${formatOffset(node.endMs)}`;

/** Слово итога без причины: «Успешно · HTTP 200», статус операции. Длительность — в верхней строке. */
function outcomeWord(node: FlowViewNode, mode: DetailMode): { text: string; tone: LineTone } {
  const o = node.outcome;
  const http = mode === 'full' && o.http !== null ? `HTTP ${o.http}` : null;
  const status = opStatusText(node);
  if (o.tone === 'success') return { text: [t('flow.outcome.success'), http, status].filter(Boolean).join(' · '), tone: 'success' };
  if (o.tone === 'error') return { text: [t('flow.outcome.error'), http, status].filter(Boolean).join(' · '), tone: 'danger' };
  return { text: [status].filter(Boolean).join(' · '), tone: 'normal' };
}

/**
 * Итог запроса на узле входа: «Итог: ошибка». Это вывод по шагам запроса: ответа партнёру в логах нет, поэтому слова про ответ здесь нет.
 * Статус операции колбэка важнее.
 */
function entryOutcome(node: FlowViewNode, entry: FlowEntryInfo): { text: string; tone: LineTone } {
  const status = opStatusText(node);
  const tone: LineTone = entry.status === 'error' ? 'danger' : 'success';
  if (status) return { text: status, tone };
  return { text: t(entry.status === 'error' ? 'flow.outcome.entryError' : 'flow.outcome.entryOk'), tone };
}

/** Имя справочника как есть, хост — коротким именем; в «Кратко» адреса нет. */
const memberName = (name: string, mode: DetailMode) => (mode === 'brief' || /[\s\p{Lu}]/u.test(name) ? briefSystem(name) : systemLabel(name));

/** Что свёрнуто в «Ещё N параллельных»: имена и итог. */
function parallelLine(node: FlowViewNode, mode: DetailMode): { text: string; tone: LineTone } {
  const names = [...new Set((node.memberNames ?? []).map((n) => memberName(n, mode)))];
  const failed = node.group?.failed ?? 0;
  const result = failed > 0 ? t('flow.mark.errors', { count: failed }) : t('flow.outcome.allOk');
  return { text: [...names, result].join(' · '), tone: failed > 0 ? 'danger' : 'normal' };
}

/** Строка итога по приоритету: причина ошибки, «шаг N из M», пометка, слово итога. */
export function outcomeLine(
  node: FlowViewNode,
  mode: DetailMode,
  located: Located | null,
  entry: FlowEntryInfo | null = null,
): { text: string; tone: LineTone } {
  if (node.group?.kind === 'parallel') return parallelLine(node, mode);
  const reason = reasonText(node, mode);
  if (reason) return reason;
  if (node.kind === 'entry' && entry) return entryOutcome(node, entry);
  if (node.group?.kind === 'more') {
    const span = spanText(node);
    if (located && located.nodeId === node.id && located.of > 1) {
      return { text: `${t('flow.mark.step', { index: located.index, of: located.of })} · ${span}`, tone: 'normal' };
    }
    return { text: span, tone: 'normal' };
  }
  // У групп с полоской шаг отмечен клеткой; у вызова — словами.
  if (located && located.nodeId === node.id && located.of > 1 && !node.attempts) {
    return { text: t('flow.mark.step', { index: located.index, of: located.of }), tone: 'normal' };
  }
  if (node.related) {
    const status = opStatusText(node) ?? (node.related.error ? t('flow.outcome.error') : null);
    return {
      text: [formatOffset(node.startMs), status].filter(Boolean).join(' · '),
      tone: node.related.error ? 'danger' : 'normal',
    };
  }
  // Пометки групп — в верхней строке; здесь только то, что относится к итогу.
  if (node.mark?.kind === 'issued' || node.mark?.kind === 'callback-early') {
    const mark = shownMark(node.mark, mode);
    if (mark) return { text: mark, tone: markTone(node.mark) };
  }
  if (node.mark?.kind === 'poll' && node.mark.status) return { text: statusText(node.mark.status), tone: 'normal' };
  return outcomeWord(node, mode);
}

/** Строка метода: в «Подробно» — метод и путь, в «Кратко» — название, действие или шаблон пути; node.tech там не используется. */
export function methodLine(node: FlowViewNode, mode: DetailMode): string {
  if (node.related) {
    const role = t(`operation.role.${node.related.role}`);
    // В «Кратко» ключ связи — только названием типа: без названия его нет.
    const keyName = mode === 'brief' ? node.related.key.name : node.related.key.name || node.related.key.type;
    const key = keyName ? t('flow.edge.byKey', { key: keyName }) : null;
    return upperFirst([role, node.mark?.kind === 'callback-early' ? markText(node.mark) : key].filter(Boolean).join(' · '));
  }
  if (node.kind === 'flow-ref') return '';
  if (node.kind === 'entry' && node.entry === 'background') return node.component ?? '';
  // Внутри разные системы и методы: путь одного из шагов выдал бы участок за него.
  if (node.group?.kind === 'more') return '';
  // Шлюз — первым: в конце длинного пути его скрыла бы обрезка.
  const via = node.entry === 'gateway' ? t('flow.via.gateway') : null;
  if (mode === 'brief') return [via, briefMethod({ plain: node.plain, uri: node.path })].filter(Boolean).join(' · ');
  const key = node.entry === 'callback' && node.opKey ? `…${node.opKey.short}` : null;
  // Запасное имя входа уже говорит про шлюз. Путь — читаемым шаблоном, полный — в панели шага.
  return [node.fallbackName ? null : via, key, node.tech && readableTitle(node.tech)].filter(Boolean).join(' · ');
}

/** Вид шага: верхняя строка в «Кратко». */
function kindWord(node: FlowViewNode, entry: FlowEntryInfo | null): string {
  switch (node.kind) {
    case 'entry':
      return entry ? `${t('flow.kind.entry')} · ${entry.time}` : t('flow.kind.entry');
    case 'db':
      return t('flow.kind.db');
    case 'async-start':
      return t('flow.kind.async');
    case 'fn':
      return node.stepIds.length > 1 ? t('flow.kind.exchange') : t('flow.kind.fn');
    default:
      return t('flow.kind.exchange');
  }
}

/**
 * Верхняя строка узла. Записи неполные — это важнее метода. У группы — пометка: число попыток видно без подсказки.
 * В «Подробно» метод или путь, в «Кратко» вид шага.
 */
function topLine(node: FlowViewNode, mode: DetailMode, entry: FlowEntryInfo | null): { text: string; tone: LineTone; mono: boolean } {
  const mark = node.group && node.mark && node.mark.kind !== 'parallel' && node.mark.kind !== 'more' ? shownMark(node.mark, mode) : null;
  if (node.unread) return { text: [mark, t('flow.mark.unread')].filter(Boolean).join(' · '), tone: 'warning', mono: false };
  if (node.group?.kind === 'more' || node.group?.kind === 'parallel') return { text: '', tone: 'muted', mono: false };
  if (node.group) return { text: mark ?? kindWord(node, null), tone: node.outcome.tone === 'error' && mode === 'full' ? 'danger' : 'muted', mono: false };
  if (node.kind === 'flow-ref') return { text: methodLine(node, mode), tone: 'muted', mono: false };
  if (mode === 'brief') return { text: kindWord(node, entry), tone: 'muted', mono: false };
  const method = methodLine(node, mode);
  return method ? { text: method, tone: 'muted', mono: true } : { text: kindWord(node, entry), tone: 'muted', mono: false };
}

export function nodeLines(
  node: FlowViewNode,
  mode: DetailMode,
  order: number,
  total: number,
  located: Located | null,
  /** Значок логов виден в режиме: иначе диктор о логах не говорит. */
  logs = true,
  /** Итог запроса и время первой записи для узла входа. */
  entry: FlowEntryInfo | null = null,
): NodeLines {
  if (node.kind === 'wait') return waitLines(node, mode, order, total);
  const name = nodeTitle(node, mode);
  const out = outcomeLine(node, mode, located, entry);
  const reason = reasonText(node, mode);
  const third = topLine(node, mode, entry);
  const method = methodLine(node, mode);
  const note = node.mark?.kind === 'no-calls' ? markText(node.mark) : null;
  const mark = shownMark(node.mark, mode);
  const metrics = metricsText(node, mode);
  const status = opStatusText(node);
  const unread = node.unread ? t('flow.mark.unread') : null;
  const full = node.related && !node.related.titleCode && mode === 'full' ? node.name : null;
  const stepAt = located && located.nodeId === node.id && located.of > 1 ? t('flow.mark.step', { index: located.index, of: located.of }) : null;
  const title = [...new Set([name, full, method, out.text, stepAt, mark, metrics, unread].filter((x): x is string => !!x))].join(
    '\n',
  );
  const timing = [
    node.durationMs !== null ? formatDuration(node.durationMs) : null,
    node.kind === 'entry' ? null : t('flow.aria.start', { offset: formatOffset(node.startMs) }),
  ].filter(Boolean);
  const b = node.badges;
  // Сначала то, что видно на узле, в том же порядке: голосовое управление находит элемент по видимому тексту.
  const aria = [
    [name, out.text, third.text].filter(Boolean).join('. '),
    stepAt && !out.text.includes(stepAt) ? stepAt : null,
    reason?.tone === 'danger' ? t('flow.aria.error') : null,
    method && !third.text.includes(method) ? method : null,
    mark && mark !== out.text && mark !== name && mark !== note && !third.text.includes(mark) ? t('flow.aria.group', { mark }) : null,
    status && (!node.related || !out.text.includes(status)) ? t('flow.aria.status', { status }) : null,
    unread && !third.text.includes(unread) ? unread : null,
    note,
    timing.join(', ') || null,
    node.lane > 0 && node.block ? t('flow.aria.parallel', { branch: node.lane }) : null,
    logs && b.total > 0
      ? [
          t('flow.aria.logs', { count: b.total }),
          b.error > 0 ? t('flow.aria.errors') : b.warning > 0 ? t('flow.aria.warnings') : null,
        ]
          .filter(Boolean)
          .join(', ')
      : null,
    t('flow.aria.step', { order, total }),
  ]
    .filter(Boolean)
    .join('. ');
  const duration = node.durationMs !== null ? formatDuration(node.durationMs) : node.outcome.noResponse ? '—' : null;
  return { name, outcome: out.text, outcomeTone: out.tone, method: third.text, methodTone: third.tone, methodMono: third.mono, duration, note, title, aria };
}

/** Подпись узла паузы: «Пауза 20 м 15 с»; длительности нет — просто «Пауза». */
export function pauseLabel(durationMs: number | null): string {
  return durationMs !== null ? t('flow.node.pause', { duration: formatDuration(durationMs) }) : t('flow.node.pauseBare');
}

/** Запись ожидания: подпись «Пауза» и в «Подробно» её текст. */
function waitLines(node: FlowViewNode, mode: DetailMode, order: number, total: number): NodeLines {
  const name = pauseLabel(node.durationMs);
  const text = mode === 'full' ? (node.plain ?? node.tech) : '';
  const title = [name, text].filter(Boolean).join('\n');
  const aria = [name, text, t('flow.aria.start', { offset: formatOffset(node.startMs) }), t('flow.aria.step', { order, total })].filter(Boolean).join('. ');
  return { name, outcome: '', outcomeTone: 'normal', method: text, methodTone: 'muted', methodMono: true, duration: null, note: null, title, aria };
}

/** Больше на ребре не бывает: от минуты пауза — отдельный узел. Округление не должно давать «+60 с». */
const MAX_EDGE_PAUSE_MS = 59_900;

/** Подпись ребра: пауза «+3 мс», время до связанного потока; null — ребро без подписи. Ключ связи — в узле-ссылке, число веток — значком на узлах. */
export function edgeLabel(hint: EdgeHint | null): string | null {
  if (!hint) return null;
  if (hint.kind === 'pause') return `+${formatDuration(Math.min(hint.ms, MAX_EDGE_PAUSE_MS))}`;
  if (hint.kind === 'parallel') return null;
  return hint.together ? t('flow.edge.together') : t('flow.edge.pause', { duration: formatDuration(hint.pauseMs) });
}
