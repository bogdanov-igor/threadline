// Профиль → разборщик строки хранилища. Профиль уже проверен схемой (schema.ts).
import type { LogLine } from '../backend/index.ts';
import type { FlowHint, RecordKind } from '../search/api.ts';
import { countRegexpOf } from './count.ts';
import { decodeHttp, decodeJson, decodeText, isObj, type Obj } from './decoders.ts';
import { compilePath, valueAt, type CompiledPath } from './paths.ts';
import { re2ToJs } from './regex.ts';
import { FIELD_NAMES, type Decoder, type FieldName, type Fields, type Layer, type ParsedRecord, type Profile, type StepKind, type When } from './types.ts';
import { idValue, levelOf, levelTable, statusValue, textValue, timeValue, tsNsToMs } from './values.ts';

export interface CompiledProfile {
  readonly name: string;
  /** Выражение подсчёта RE2 с группой cid: явное или выведенное. */
  readonly countRegexp: string;
  parse(line: LogLine): ParsedRecord;
  /** Для проверки профиля на образце: подошедший вариант и поля, давшие значение. Значений не возвращает. */
  inspect(line: LogLine): { record: ParsedRecord; variant: string | null; found: FieldName[] };
}

export interface CompileOptions {
  /** Журнал ошибок разбора: имя профиля и тип ошибки, без содержимого строки. */
  onError?: (message: string) => void;
}

interface CLayer {
  name: string;
  decode: Decoder;
  from: CompiledPath | null;
  re: RegExp | null;
}

interface CWhen {
  labels: [string, Set<string>][];
  has: CompiledPath[];
  hasAny: CompiledPath[];
  missing: CompiledPath[];
  equals: [CompiledPath, Set<string>][];
}

type CFields = Partial<Record<FieldName, CompiledPath[]>>;

interface CVariant {
  name: string;
  when: CWhen | null;
  gateway: boolean;
  layers: Map<string, CLayer>;
  fields: CFields;
  kinds: { kind: RecordKind; when: CWhen | null; fields: CFields }[];
  /** Правила шага графа: только для записей вида log. */
  steps: { as: StepKind; when: CWhen | null; durationMs: CompiledPath[]; host: CompiledPath[]; title: CompiledPath[] }[];
  /** Остальной контекст: для каждого пути поля context — ключи, взятые путями других полей. */
  contextOwn: Map<string, Set<string>>;
}

const MISSING = Symbol('missing');
const has = (v: unknown) => v !== undefined && v !== null;
const asList = (p: string | string[] | undefined): string[] => (p === undefined ? [] : typeof p === 'string' ? [p] : p);

/** Сравнение по тексту: строка, число или логическое значение. */
const asText = (v: unknown): string | null =>
  typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : null;

export function compileProfile(name: string, profile: Profile, opts: CompileOptions = {}): CompiledProfile {
  const count = countRegexpOf(profile);
  if (!count.ok) throw new Error(`профиль «${name}»: ${count.issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`);

  const decoders = new Map<string, Decoder>();
  const compileLayer = (l: Layer): CLayer => {
    const c: CLayer = {
      name: l.name,
      decode: l.decode,
      from: l.from === undefined ? null : path(l.from),
      re: l.decode === 'text' && l.pattern !== undefined ? re2ToJs(l.pattern) : null,
    };
    decoders.set(l.name, l.decode);
    return c;
  };
  const path = (p: string) => compilePath(p, decoders.get(p.split('.')[0] ?? ''));
  const paths = (p: string | string[] | undefined) => asList(p).map(path);
  const when = (w: When | undefined): CWhen | null =>
    w === undefined
      ? null
      : {
          labels: Object.entries(w.labels ?? {}).map(([k, v]) => [k, new Set(asList(v))]),
          has: (w.has ?? []).map(path),
          hasAny: (w.hasAny ?? []).map(path),
          missing: (w.missing ?? []).map(path),
          equals: Object.entries(w.equals ?? {}).map(([p, v]) => [path(p), new Set((Array.isArray(v) ? v : [v]).map(String))]),
        };
  const fields = (f: Fields | undefined): CFields => {
    const out: CFields = {};
    for (const k of FIELD_NAMES) if (f?.[k] !== undefined) out[k] = paths(f[k]);
    return out;
  };

  const common = (profile.layers ?? []).map(compileLayer);
  const variants: CVariant[] = profile.variants.map((v) => {
    const own = new Map<string, Decoder>(decoders);
    const layers = new Map((v.layers ?? []).map((l) => [l.name, compileLayer(l)]));
    const c: CVariant = {
      name: v.name,
      when: when(v.when),
      gateway: v.gateway === true,
      layers,
      fields: fields(v.fields),
      kinds: (v.kinds ?? []).map((k) => ({ kind: k.kind, when: when(k.when), fields: fields(k.fields) })),
      steps: (v.steps ?? []).map((st) => ({
        as: st.as,
        when: when(st.when),
        durationMs: paths(st.fields?.durationMs),
        host: paths(st.fields?.host),
        title: paths(st.fields?.title),
      })),
      contextOwn: contextOwnKeys(v.fields, v.kinds ?? [], v.when),
    };
    // Слои варианта не видны другим вариантам.
    decoders.clear();
    for (const [k, d] of own) decoders.set(k, d);
    return c;
  });

  const components = profile.component ?? [];
  const gateways = new Set(profile.gateways ?? []);
  const table = levelTable(profile.levels);

  const componentOf = (labels: Record<string, string>): string | null => {
    // Значение шлюза важнее порядка меток: у шлюза бывает container=server, а у воркера метка компонента другая, чем контейнер.
    for (const k of components) if (labels[k] && gateways.has(labels[k])) return labels[k];
    for (const k of components) if (labels[k]) return labels[k];
    return null;
  };
  const labelGateway = (labels: Record<string, string>): boolean => components.some((k) => labels[k] !== undefined && gateways.has(labels[k]));

  function run(l: LogLine, diag: { variant: string | null; found: Set<FieldName> } | null): ParsedRecord {
    try {
      return parse(l, diag);
    } catch (e) {
      opts.onError?.(`формат «${name}»: разбор строки прерван ошибкой ${e instanceof Error ? e.name : typeof e}`);
      return { ...rawRecord(l), component: null, gateway: false };
    }
  }

  function parse(l: LogLine, diag: { variant: string | null; found: Set<FieldName> } | null): ParsedRecord {
    const base: ParsedRecord = {
      ...rawRecord(l),
      component: componentOf(l.labels),
      gateway: labelGateway(l.labels),
    };
    if (l.line.trim() === '') return base;

    // Общие слои — строгие.
    const values = new Map<string, unknown>();
    let lastText = l.line;
    for (const [i, layer] of common.entries()) {
      const input = layer.from ? valueAt(values.get(layer.from.layer), layer.from) : l.line;
      const out = decode(layer, input);
      if (out === undefined) {
        if (i === 0) return base;
        return { ...base, kind: 'text', message: typeof input === 'string' ? input : lastText };
      }
      values.set(layer.name, out);
      if (typeof input === 'string') lastText = input;
    }

    for (const v of variants) {
      // Слои варианта — мягкие и ленивые: раскрываются при первом обращении к пути.
      const cache = new Map<string, unknown>();
      const layerValue = (name: string): unknown => {
        if (values.has(name)) return values.get(name);
        const layer = v.layers.get(name);
        if (!layer) return undefined;
        const hit = cache.get(name);
        if (hit !== undefined) return hit === MISSING ? undefined : hit;
        const input = layer.from ? get(layer.from) : l.line;
        const out = decode(layer, input);
        cache.set(name, out === undefined ? MISSING : out);
        return out;
      };
      const get = (p: CompiledPath): unknown => valueAt(layerValue(p.layer), p);
      const first = (ps: CompiledPath[] | undefined): { value: unknown; path: CompiledPath | null } => {
        for (const p of ps ?? []) {
          const value = get(p);
          if (has(value)) return { value, path: p };
        }
        return { value: undefined, path: null };
      };
      const ok = (w: CWhen | null): boolean => {
        if (!w) return true;
        // Метки — первыми: они дешёвые и не раскрывают слоёв.
        for (const [k, vals] of w.labels) if (!vals.has(l.labels[k] ?? '')) return false;
        for (const p of w.has) if (!has(get(p))) return false;
        if (w.hasAny.length > 0 && !w.hasAny.some((p) => has(get(p)))) return false;
        for (const p of w.missing) if (has(get(p))) return false;
        for (const [p, vals] of w.equals) {
          const t = asText(get(p));
          if (t === null || !vals.has(t)) return false;
        }
        return true;
      };

      if (!ok(v.when)) continue;

      let kind: RecordKind = 'log';
      const f: CFields = { ...v.fields };
      for (const rule of v.kinds) {
        if (!ok(rule.when)) continue;
        kind = rule.kind;
        Object.assign(f, rule.fields);
        break;
      }
      const value = (k: FieldName): unknown => {
        const r = first(f[k]);
        if (diag && r.path) diag.found.add(k);
        return r.value;
      };
      const levelValues = (f.level ?? []).map(get);
      if (diag && levelValues.some(has)) diag.found.add('level');
      const { level, levelNum } = levelOf(levelValues, table);
      const ctx = first(f.context);
      if (diag) {
        diag.variant = v.name;
        if (ctx.path) diag.found.add('context');
      }
      // Подсказка шага графа: вид записи и её показ не меняются.
      let flow: FlowHint | null = null;
      if (kind === 'log') {
        const rule = v.steps.find((st) => ok(st.when));
        if (rule) {
          flow = {
            as: rule.as,
            durationMs: durationValue(first(rule.durationMs).value),
            host: textValue(first(rule.host).value),
            title: textValue(first(rule.title).value),
          };
        }
      }
      return {
        ...base,
        kind,
        timeMs: timeValue(value('time')) ?? base.timeMs,
        message: textValue(value('message')) ?? '',
        level,
        levelNum,
        correlationId: idValue(value('correlationId')),
        requestId: idValue(value('requestId')),
        method: textValue(value('method')),
        uri: textValue(value('uri')),
        status: statusValue(value('status')),
        headers: value('headers') ?? null,
        body: textValue(value('body')),
        payload: value('payload') ?? null,
        action: textValue(value('action')),
        context: ctx.path ? restOf(ctx.value, v.contextOwn.get(ctx.path.source)) : null,
        gateway: base.gateway || v.gateway,
        ...(flow ? { flow } : {}),
      };
    }

    // Ни один вариант не подошёл: текст последнего общего слоя.
    return { ...base, kind: 'text', message: lastText };
  }

  return {
    name,
    countRegexp: count.regexp,
    parse: (l) => run(l, null),
    inspect: (l) => {
      const diag = { variant: null as string | null, found: new Set<FieldName>() };
      const record = run(l, diag);
      return { record, variant: diag.variant, found: [...diag.found] };
    },
  };
}

/** Длительность шага: число или строка из цифр с точкой, иначе null. */
function durationValue(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : null;
  if (typeof v === 'string' && /^\d{1,12}(?:\.\d{1,9})?$/.test(v.trim())) return Number(v.trim());
  return null;
}

/** Запись «не разобрана»: строка целиком, время хранилища. */
function rawRecord(l: LogLine): Omit<ParsedRecord, 'component' | 'gateway'> {
  return {
    tsNs: l.tsNs,
    timeMs: tsNsToMs(l.tsNs),
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
  };
}

function decode(layer: CLayer, input: unknown): Obj | undefined {
  if (layer.decode === 'json') return decodeJson(input);
  if (layer.decode === 'http') return decodeHttp(input);
  return layer.re ? decodeText(input, layer.re) : undefined;
}

/** Объект без своих ключей; не объект или пустой — null. */
function restOf(v: unknown, own: ReadonlySet<string> | undefined): Record<string, unknown> | null {
  if (!isObj(v)) return null;
  const rest: Obj = {};
  let any = false;
  for (const [k, x] of Object.entries(v)) {
    if (own?.has(k)) continue;
    // defineProperty: ключ «__proto__» из лога не меняет прототип объекта.
    Object.defineProperty(rest, k, { value: x, enumerable: true, writable: true, configurable: true });
    any = true;
  }
  return any ? rest : null;
}

/**
 * Свои ключи остального контекста: для каждого пути из fields, kinds[].fields и when варианта,
 * который начинается с пути поля context, исключается первый ключ после этого начала.
 */
export function contextOwnKeys(fields: Fields | undefined, kinds: readonly { when?: When; fields?: Fields }[], variantWhen?: When): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const contextPaths = asList(fields?.context);
  if (contextPaths.length === 0) return out;
  const all: string[] = [];
  const addFields = (f: Fields | undefined) => {
    for (const k of FIELD_NAMES) if (k !== 'context') all.push(...asList(f?.[k]));
  };
  const addWhen = (w: When | undefined) => {
    if (!w) return;
    all.push(...(w.has ?? []), ...(w.hasAny ?? []), ...(w.missing ?? []), ...Object.keys(w.equals ?? {}));
  };
  addFields(fields);
  addWhen(variantWhen);
  for (const k of kinds) {
    addFields(k.fields);
    addWhen(k.when);
  }
  for (const c of contextPaths) {
    const own = new Set<string>();
    const prefix = `${c}.`;
    for (const p of all) {
      if (!p.startsWith(prefix)) continue;
      const key = p.slice(prefix.length).split('.')[0];
      if (key) own.add(key);
    }
    out.set(c, own);
  }
  return out;
}
