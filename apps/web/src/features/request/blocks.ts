// Из каких блоков состоят подробности записи и какие из них раскрыты сразу.
import { extractNestedResult, formatBody, NESTED_MAX_BLOCKS, type FormattedBody, type NestedLang, type ViewRecord } from '@threadline/core/search';
import { blockVisible, type ViewBlock, type ViewMode, type ViewSettings } from '@threadline/core/view';
import i18n from '../../i18n/index.ts';
import { formatDuration, formatHeaders, pretty } from '../../lib/format.ts';
import { detectLang, type HighlightLang } from '../../lib/highlight.ts';

export type BlockName = 'request' | 'response' | 'headers' | 'body' | 'payload' | 'context' | 'raw';

export interface Block {
  name: BlockName;
  title: string;
  /** Отформатированный вид. */
  text: string;
  /** Подсветка отформатированного вида. */
  lang: HighlightLang;
  /** Как лежит в записи; null — вид один, переключателя нет. */
  raw: string | null;
  empty: boolean;
  open: boolean;
  /** Тела, вложенные строками в тело или payload: показываются блоками под ним. */
  nested?: NestedList;
}

export interface NestedList {
  items: NestedBlock[];
  /** Вложенных тел больше предела: показаны первые limit. */
  truncated: boolean;
  limit: number;
}

export interface NestedBlock {
  path: string;
  lang: NestedLang;
  title: string;
  text: string;
}

/** Блоки вложенных тел; ошибка разбора не ломает показ записи — тогда вложенных нет. */
export function nestedBlocks(text: string | null): NestedList | undefined {
  if (!text) return undefined;
  let found;
  try {
    found = extractNestedResult(text);
  } catch {
    return undefined;
  }
  if (found.blocks.length === 0) return undefined;
  return {
    items: found.blocks.map((n) => ({ ...n, title: i18n.t('record.nested.title', { path: n.path, lang: i18n.t(`record.nested.lang.${n.lang}`) }) })),
    truncated: found.truncated,
    limit: NESTED_MAX_BLOCKS,
  };
}

const withNested = (b: Block, source: string | null): Block => {
  const nested = nestedBlocks(source);
  return nested ? { ...b, nested } : b;
};

/** Тело, которое не удалось отформатировать, показывается как есть. */
export function safeFormat(body: string): FormattedBody {
  try {
    return formatBody(body);
  } catch {
    return { text: body, lang: 'text' };
  }
}

/** Подсветка отформатированного тела. */
export function bodyLang(f: FormattedBody): HighlightLang {
  if (f.lang === 'json' || f.lang === 'xml') return f.lang;
  return f.lang === 'empty' ? 'text' : detectLang(f.text);
}

/** «Как в логе» имеет смысл, только если отличается от отформатированного. */
const rawIfDiffers = (raw: string | null, text: string) => (raw !== null && raw !== text ? raw : null);

/** Значение одной строкой, как в записи. */
function oneLine(v: unknown): string | null {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v) ?? null;
  } catch {
    return null;
  }
}

function bodyBlock(name: 'body' | 'response', title: string, body: string | null): Block {
  const f = body === null ? { text: '', lang: 'empty' as const } : safeFormat(body);
  const empty = f.lang === 'empty';
  return withNested({ name, title, text: f.text, lang: bodyLang(f), raw: empty ? null : rawIfDiffers(body, f.text), empty, open: true }, body);
}

/** Вкладка панели шага: адрес, заголовки и тело — блоки внутри «Запроса» и «Ответа». */
export type DetailTab = Exclude<ViewBlock, 'logs' | 'headers'>;

/** Настройка, которой управляется блок записи; она же вкладка, кроме заголовков. */
export const TAB_OF: Record<BlockName, Exclude<ViewBlock, 'logs'>> = {
  request: 'request',
  body: 'request',
  payload: 'request',
  response: 'response',
  headers: 'headers',
  context: 'context',
  raw: 'raw',
};

/**
 * Единственный фильтр блоков: панель шага, вкладка «Записи», «Все записи», логи шага. recordBlocks остаётся чистой.
 * В «Кратко» блока адреса нет при любой настройке, заголовок ответа без HTTP-статуса.
 */
export function visibleBlocks(blocks: readonly Block[], view: ViewSettings, mode: ViewMode): Block[] {
  const out = blocks.filter((b) => blockVisible(view, mode, TAB_OF[b.name]) && !(mode === 'brief' && b.name === 'request'));
  return mode === 'brief' ? out.map((b) => (b.name === 'response' ? { ...b, title: i18n.t('record.section.response') } : b)) : out;
}

export function recordBlocks(r: ViewRecord): Block[] {
  const t = i18n.t;
  const out: Block[] = [];
  const { http, sections } = r;
  let headers: Block | null = null;
  if (sections.headers != null) {
    const text = formatHeaders(sections.headers);
    headers = { name: 'headers', title: t('record.section.headers'), text, lang: 'http', raw: rawIfDiffers(oneLine(sections.headers), text), empty: false, open: false };
  }

  if (r.kind === 'response') {
    const title = [t('record.section.response')];
    if (http?.status != null) title.push(t('record.responseStatus', { status: http.status }));
    if (http?.durationMs != null) title.push(formatDuration(http.durationMs));
    out.push(bodyBlock('response', title.join(' · '), sections.body));
    if (headers) out.push(headers);
  } else {
    if (http && (http.method || http.uri)) {
      out.push({ name: 'request', title: t('record.section.request'), text: [http.method, http.uri].filter(Boolean).join(' '), lang: 'text', raw: null, empty: false, open: true });
    }
    if (headers) out.push(headers);
    if (sections.body !== null) out.push(bodyBlock('body', t('record.section.body'), sections.body));
  }
  if (sections.payload != null) {
    const text = pretty(sections.payload);
    const source = oneLine(sections.payload);
    const payload: Block = { name: 'payload', title: t('record.section.payload'), text, lang: detectLang(text), raw: rawIfDiffers(source, text), empty: false, open: true };
    out.push(withNested(payload, source));
  }
  if (sections.context && Object.keys(sections.context).length > 0) {
    const text = pretty(sections.context);
    out.push({
      name: 'context',
      title: t('record.section.context'),
      text,
      lang: 'json',
      raw: rawIfDiffers(oneLine(sections.context), text),
      empty: false,
      open: r.kind === 'log' || out.length === 0,
    });
  }
  out.push({ name: 'raw', title: t('record.section.raw'), text: r.raw, lang: detectLang(r.raw), raw: null, empty: false, open: r.kind === 'raw' || r.kind === 'text' });
  return out;
}
