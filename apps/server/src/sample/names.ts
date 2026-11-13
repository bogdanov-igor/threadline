// Вид names: как названия и правила итога справочника ложатся на настоящие записи, и сводка неузнанного.
// Текст правила в файл не идёт: туда подставляются значения записи.

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  analyze,
  compileCatalog,
  methodKey,
  readCatalogFile,
  snapshotFromFile,
  unknownItems,
  uriParts,
  type CatalogSnapshot,
  type Resolver,
  type StepFacts,
  type StepRecord,
} from '@threadline/core/catalog';
import { pairExchanges, sortRecords, WARNING_LEVEL, type ParsedRecord } from '@threadline/core/search';
import { parseCatalogText } from '../catalog/exchange.ts';
import { buildEntry, inspectLine, pathOf, type Inspected, type KindContext } from './context.ts';
import { passesForm } from './gate.ts';
import { ERROR_LINES, ERROR_WINDOW_MS, MAX_GROUP_ENTRIES, MAX_UNKNOWN, MIN_WORD_CIDS, NAMES_LINES, NAMES_OLD_OFFSET_MS, NAMES_WINDOW_MS } from './limits.ts';
import { SampleStop } from './reader.ts';
import { allowedFields, catalogWords, hostShape, labelOf, pathShape, pathWords, statusShape, textLabel, valueOrLabel, type ShapeOptions } from './structure.ts';

export type CatalogInfo = { source: 'file'; methods: number } | { source: 'none' } | { source: 'invalid'; errors: number };

export interface SampleCatalog {
  info: CatalogInfo;
  resolver: Resolver;
  shape: ShapeOptions;
}

function catalogOf(info: CatalogInfo, snapshot: CatalogSnapshot, known: boolean): SampleCatalog {
  const resolver = compileCatalog(snapshot);
  const systemOf = (uri: string) => {
    const step = resolver.exchange(null, uri, '');
    return step.system && !step.byPath ? step.system.key : null;
  };
  return {
    info,
    resolver,
    shape: { allowed: allowedFields(known ? snapshot : null), words: catalogWords(known ? snapshot : null), frequent: new Set(), systemOf },
  };
}

/** Файл начального набора рядом с файлом настроек, один раз за запуск. Нет файла или он с ошибками — все методы в неизвестных. */
export async function loadSampleCatalog(configPath: string, project: string): Promise<SampleCatalog> {
  // Система-автор без методов: иначе входы проекта не попали бы в неизвестные.
  const empty = () => snapshotFromFile({ version: 1, project, systems: [{ key: project, kind: 'project', name: project }] }, project);
  let text: string;
  try {
    text = await readFile(resolve(dirname(configPath), 'catalog', `${project}.yaml`), 'utf8');
  } catch {
    return catalogOf({ source: 'none' }, empty(), false);
  }
  const parsed = parseCatalogText(text);
  if (!parsed.ok) return catalogOf({ source: 'invalid', errors: parsed.errors.length }, empty(), false);
  const read = readCatalogFile(parsed.value, project);
  if (!read.ok) return catalogOf({ source: 'invalid', errors: read.errors.length }, empty(), false);
  const snapshot = snapshotFromFile(parsed.value, project);
  return catalogOf({ source: 'file', methods: snapshot.methods.length }, snapshot, true);
}

type Group = 'incoming' | 'exchange' | 'errorResponse' | 'logError';

function stepRecord(r: ParsedRecord): StepRecord {
  return {
    kind: r.kind,
    method: r.method,
    uri: r.uri,
    status: r.status,
    body: r.body,
    message: r.message,
    level: r.level,
    context: r.context,
    logError: (r.levelNum ?? 0) >= WARNING_LEVEL,
    db: r.kind === 'log' && r.flow?.as === 'db' ? { host: r.flow.host } : null,
  };
}

function groupOf(r: ParsedRecord, f: StepFacts): Group | null {
  if (r.kind === 'incoming') return 'incoming';
  if (r.kind === 'send') return 'exchange';
  if (r.kind === 'response') return f.outcome?.rule.outcome === 'error' || (!f.outcome && f.fact) ? 'errorResponse' : 'exchange';
  return (r.levelNum ?? 0) >= WARNING_LEVEL ? 'logError' : null;
}

function entryCatalog(f: StepFacts, resolver: Resolver): Record<string, unknown> {
  const row = f.name?.method ? resolver.methods.get(f.name.method.id) : undefined;
  const owner = row ? resolver.systems.get(row.systemId) : undefined;
  const key = row && owner ? methodKey(owner.key, row) : null;
  const system = f.name?.system?.key ?? null;
  const code = f.fact?.code ?? f.match?.rule.code ?? null;
  return {
    system: system === null ? null : valueOrLabel(system),
    method: key === null ? null : passesForm(key) ? key : labelOf(key),
    outcome: f.outcome?.rule.outcome ?? null,
    outcomeLevel: f.outcome?.level ?? null,
    errorLevel: f.match?.level ?? null,
    code: code === null ? null : valueOrLabel(code),
  };
}

/** Слова пути по correlation_id: остаётся слово, которое встретилось у 3 разных. */
function frequentWords(read: readonly Inspected[]): Set<string> {
  const cids = new Map<string, Set<string>>();
  for (const { record: r } of read) {
    if (r.correlationId === null || r.uri === null) continue;
    for (const w of pathWords(pathOf(r.uri))) {
      const set = cids.get(w) ?? new Set<string>();
      set.add(r.correlationId);
      cids.set(w, set);
    }
  }
  return new Set([...cids].filter(([, s]) => s.size >= MIN_WORD_CIDS).map(([w]) => w));
}

interface UnknownRow {
  row: Record<string, unknown>;
  cids: Set<string>;
}

function unknownRows(groups: readonly (readonly ParsedRecord[])[], resolver: Resolver, shape: ShapeOptions): { rows: Record<string, unknown>[]; more: number } {
  const merged = new Map<string, UnknownRow>();
  groups.forEach((records, i) => {
    const cid = records[0]?.correlationId ?? `no-cid#${i}`;
    for (const item of unknownItems(records, resolver)) {
      const system = item.systemId === null ? null : (resolver.systems.get(item.systemId)?.key ?? null);
      const fields = {
        kind: item.kind,
        ...(system === null ? {} : { system: valueOrLabel(system) }),
        ...(item.httpMethod === null ? {} : { http: valueOrLabel(item.httpMethod) }),
        ...(item.path === null ? {} : { path: pathShape(item.path, shape) }),
        ...(item.rpc === null ? {} : { rpc: valueOrLabel(item.rpc) }),
        ...(item.kind === 'host' && item.host !== null ? { host: hostShape(item.host) } : {}),
        ...(item.httpStatus === null ? {} : { status: statusShape(item.httpStatus) }),
        ...(item.code === null ? {} : { code: valueOrLabel(item.code) }),
      };
      // Строки сводятся заново: две фамилии в пути дали бы одинаковый {seg}, а разные тексты одной ошибки — одну строку.
      const key = JSON.stringify(fields);
      const hit = merged.get(key);
      if (hit) hit.cids.add(cid);
      else merged.set(key, { row: { ...fields, ...(item.text === null ? {} : { text: labelOf(item.text) }) }, cids: new Set([cid]) });
    }
  });
  const sorted = [...merged.values()].sort((a, b) => b.cids.size - a.cids.size);
  return { rows: sorted.slice(0, MAX_UNKNOWN).map((x) => ({ ...x.row, count: x.cids.size })), more: Math.max(0, sorted.length - MAX_UNKNOWN) };
}

/** Строки группами по correlation_id; строка без него — отдельная группа. */
function groupRecords(read: readonly Inspected[]): Inspected[][] {
  const byCid = new Map<string, Inspected[]>();
  const out: Inspected[][] = [];
  for (const x of read) {
    const cid = x.record.correlationId;
    if (cid === null) {
      out.push([x]);
      continue;
    }
    let list = byCid.get(cid);
    if (!list) {
      list = [];
      byCid.set(cid, list);
      out.push(list);
    }
    list.push(x);
  }
  return out;
}

/** Отбор строк для названий: адрес http(s) или HTTP-метод отдельным словом. */
export const HTTP_LINE = String.raw`https?://|\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b`;

export async function sampleNames(ctx: KindContext, out: Record<string, unknown>): Promise<void> {
  const resolver = ctx.catalog.resolver;
  const zero = () => ({ total: 0, named: 0, outcomeRule: 0, errorRule: 0 });
  const summary: Record<Group, ReturnType<typeof zero>> = { incoming: zero(), exchange: zero(), errorResponse: zero(), logError: zero() };
  const entries: Record<Group, Record<string, unknown>[]> = { incoming: [], exchange: [], errorResponse: [], logError: [] };
  out.catalog = ctx.catalog.info;
  out.read = 0;
  out.noVariant = 0;
  out.summary = summary;
  out.entries = entries;
  out.unknown = [];
  out.more = 0;

  // Уже прочитанные порции разбираются и при остановке: ошибка на третьей не отменяет первые две.
  const read: Inspected[] = [];
  const seen = new Set<string>();
  let lines = 0;
  let stop: SampleStop | null = null;
  // Строки с HTTP: адрес или метод запроса. Отбор не зависит от формата записей проекта.
  const windows = [
    { filters: [{ kind: 'regex', pattern: HTTP_LINE } as const], toMs: ctx.nowMs, spanMs: NAMES_WINDOW_MS, limit: NAMES_LINES },
    { filters: [{ kind: 'regex', pattern: HTTP_LINE } as const], toMs: ctx.nowMs - NAMES_OLD_OFFSET_MS, spanMs: NAMES_WINDOW_MS, limit: NAMES_LINES },
    { filters: [{ kind: 'contains', value: 'ERROR' } as const], toMs: ctx.nowMs, spanMs: ERROR_WINDOW_MS, limit: ERROR_LINES },
  ];
  try {
    for (const w of windows) {
      const found = await ctx.reader.lines({ selector: ctx.selector, filters: [...w.filters], range: { fromMs: w.toMs - w.spanMs, toMs: w.toMs }, limit: w.limit, direction: 'backward' });
      lines += found.length;
      for (const l of found) {
        const key = `${l.tsNs}|${l.line.length}|${l.line.slice(0, 128)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        read.push(inspectLine(ctx.compiled, l));
      }
    }
  } catch (e) {
    if (!(e instanceof SampleStop)) throw e;
    stop = e;
  }

  out.read = lines;
  out.noVariant = read.filter((x) => x.variant === null).length;
  const shape: ShapeOptions = { ...ctx.catalog.shape, frequent: frequentWords(read) };

  const usedShapes: Record<Group, Set<string>> = { incoming: new Set(), exchange: new Set(), errorResponse: new Set(), logError: new Set() };
  const groups = groupRecords(read);
  const parsedGroups: ParsedRecord[][] = [];
  for (const group of groups) {
    const byRecord = new Map(group.map((x) => [x.record, x]));
    const sorted = sortRecords(group.map((x) => x.record));
    parsedGroups.push(sorted);
    const facts = analyze(sorted.map(stepRecord), sorted, pairExchanges(sorted), resolver);
    sorted.forEach((r, i) => {
      const f = facts[i]!;
      const g = groupOf(r, f);
      if (!g) return;
      const s = summary[g];
      s.total++;
      if (f.name?.method) s.named++;
      if (f.outcome) s.outcomeRule++;
      if (f.match) s.errorRule++;
      if (entries[g].length >= MAX_GROUP_ENTRIES) return;
      const form = r.uri === null ? `log|${f.fact?.code ?? ''}|${textLabel(r.message)}` : `${r.method ?? ''}|${pathShape(uriParts(r.uri).path, shape)}`;
      if (usedShapes[g].has(form)) return;
      usedShapes[g].add(form);
      entries[g].push(buildEntry(ctx, byRecord.get(r)!, shape, { catalog: entryCatalog(f, resolver) }));
    });
  }
  const unknown = unknownRows(parsedGroups, resolver, shape);
  out.unknown = unknown.rows;
  out.more = unknown.more;
  if (stop) throw stop;
}
