// Общее для видов выборки: контекст запуска, разбор строки и запись файла. ParsedRecord в файл не идёт: только поля ниже, каждое через фильтр.

import type { LogLine, Matcher } from '@threadline/core/backend';
import { uriParts } from '@threadline/core/catalog';
import type { CompiledProfile, ParsedRecord, Profile } from '@threadline/core/profile';
import { flowLabels, httpShape, labelOf, statusShape, textLabel, valueOrLabel, type ShapeOptions } from './structure.ts';
import type { SampleReader } from './reader.ts';
import type { SampleCatalog } from './names.ts';

export type RecordPath = (line: string, shape: ShapeOptions) => unknown;

/** Ссылки на correlation_id: значение только в памяти, в файл идёт cid#N. */
export class CidRefs {
  readonly #refs = new Map<string, string>();

  ref(cid: string): string {
    let r = this.#refs.get(cid);
    if (!r) {
      r = `cid#${this.#refs.size + 1}`;
      this.#refs.set(cid, r);
    }
    return r;
  }
}

export interface KindContext {
  reader: SampleReader;
  nowMs: number;
  sinceText: string;
  sinceMs: number;
  /** Обычный селектор, как у поиска: строки шлюза и порции names. */
  selector: Matcher[];
  /** Без исключений только для поиска: значения меток и background. */
  opSelector: Matcher[];
  profile: Profile;
  compiled: CompiledProfile;
  catalog: SampleCatalog;
  refs: CidRefs;
  record: RecordPath;
  /** Значения меток общие: при all читаются один раз. */
  labelValues: Map<string, string[]>;
  /** Записей с ошибкой маски: в выводе только число. */
  maskErrors: { count: number };
}

export interface Inspected {
  line: LogLine;
  record: ParsedRecord;
  variant: string | null;
}

/** Ошибка разбора одной строки не роняет запуск: запись как не разобранная. */
export function inspectLine(compiled: CompiledProfile, line: LogLine): Inspected {
  try {
    const { record, variant } = compiled.inspect(line);
    return { line, record, variant };
  } catch {
    return { line, variant: null, record: rawRecord(line) };
  }
}

function rawRecord(l: LogLine): ParsedRecord {
  return {
    tsNs: l.tsNs,
    timeMs: Number(l.tsNs) / 1e6,
    labels: l.labels,
    line: l.line,
    kind: 'raw',
    message: l.line,
    level: null,
    levelNum: null,
    correlationId: null,
    requestId: null,
    method: null,
    uri: null,
    status: null,
    headers: null,
    body: null,
    payload: null,
    action: null,
    context: null,
    component: null,
    gateway: false,
  };
}

/** Запись файла: метаданные через те же фильтры и дерево. Ошибка на любом шаге — пометка, без значений и текста исключения. */
export function buildEntry(ctx: KindContext, x: Inspected, shape: ShapeOptions, extra: Record<string, unknown> = {}): Record<string, unknown> {
  try {
    const r = x.record;
    const entry: Record<string, unknown> = {
      kind: r.kind,
      variant: x.variant === null ? null : valueOrLabel(x.variant),
      level: r.level === null ? null : valueOrLabel(r.level),
      labels: flowLabels(r.labels),
      correlationId: r.correlationId === null ? null : { shape: labelOf(r.correlationId), ref: ctx.refs.ref(r.correlationId) },
      requestId: r.requestId === null ? null : labelOf(r.requestId),
      http: r.uri === null && r.method === null && r.status === null ? null : httpOf(r, shape),
      message: textLabel(r.message),
      ...extra,
    };
    entry.tree = ctx.record(x.line.line, shape);
    return entry;
  } catch {
    ctx.maskErrors.count++;
    return { kind: 'mask-error' };
  }
}

function httpOf(r: ParsedRecord, shape: ShapeOptions): Record<string, unknown> {
  const u = r.uri === null ? null : httpShape(r.uri, shape);
  return {
    method: r.method === null ? null : valueOrLabel(r.method),
    path: u?.path ?? null,
    host: u?.host ?? null,
    queryNames: u?.queryNames ?? [],
    status: statusShape(r.status),
  };
}

/** Путь адреса записи без хоста и строки запроса. */
export const pathOf = (uri: string | null): string => uriParts(uri).path;
