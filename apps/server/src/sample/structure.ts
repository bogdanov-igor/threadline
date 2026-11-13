// Режим структуры: в файл идут ключи, типы, длины и метки вида значения.
// Значение остаётся, только если поле из явного списка и значение прошло форму. Неизвестный ключ значение не открывает.

import { parseTemplate, sensitivePath, unknownPath, uriParts, type CatalogSnapshot } from '@threadline/core/catalog';
import { decodeHttp } from '@threadline/core/profile';
import { ALL_KINDS_MASKING, maskDeep, maskKindsDeep, maskKindsText, maskText, normalizeFieldName } from '@threadline/core/search';
import { passesForm } from './gate.ts';
import {
  FLOW_LABELS,
  KEY_SHAPE,
  LABEL_VALUE_SHAPE,
  MAX_ARRAY_ITEMS,
  MAX_DEPTH,
  MAX_FORM_NAMES,
  MAX_KEPT_INT,
  MAX_NESTED_BYTES,
  MAX_OBJECT_KEYS,
  MAX_SHOWN_LENGTH,
  MAX_TREE_BYTES,
  MAX_XML_TAGS,
  TECHNICAL_FIELDS,
  TEXT_FIELDS,
  VALUE_SHAPE,
  WORD_SHAPE,
} from './limits.ts';

const NO_KEEP: ReadonlySet<string> = new Set();
/** Все виды, включая выключенные по умолчанию: настройку проекта команда не читает. */
const STRICT = ALL_KINDS_MASKING.strict;
export const CUT = '<cut>';
/** Регулярные выражения вида смотрят только начало значения: строка 3 МБ обходится за линейное время. */
const LABEL_SCAN = 4096;
const MAX_PATH_SCAN = 4096;

export interface ShapeOptions {
  /** Поля, чьё значение может остаться: нормальная форма имени. */
  allowed: ReadonlySet<string>;
  /** Слова шаблонов справочника. */
  words: ReadonlySet<string>;
  /** Слова, которые встретились в прочитанных строках у 3 разных correlation_id. */
  frequent: ReadonlySet<string>;
  /** Ключ системы по адресу; null — хост справочнику неизвестен. */
  systemOf: (uri: string) => string | null;
}

export const EMPTY_SHAPE: ShapeOptions = { allowed: TECHNICAL_FIELDS, words: new Set(), frequent: new Set(), systemOf: () => null };

const masksChange = (s: string) => maskText(s, NO_KEEP) !== s || maskKindsText(s, STRICT, NO_KEEP) !== s;

// ---------- Метка значения ----------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function kindOf(s: string): string {
  const head = s.length > LABEL_SCAN ? s.slice(0, LABEL_SCAN) : s;
  if (head.includes('*')) return 'masked';
  if (UUID.test(head)) return 'uuid';
  if (/^\+?\d+$/.test(head)) return 'digits';
  if (/^(?:\d{4}-\d{2}-\d{2}|\d{2}\.\d{2}\.\d{4})/.test(head)) return 'date';
  if (s.length >= 8 && /^[0-9a-f]+$/i.test(head) && /\d/.test(head) && /[a-f]/i.test(head)) return 'hex';
  if (s.length >= 16 && /^[A-Za-z0-9+/_-]+={0,2}$/.test(head) && /[A-Z]/.test(head) && /[a-z]/.test(head) && /[\d+/=]/.test(head)) return 'b64';
  const cyr = /\p{Script=Cyrillic}/u.test(head);
  const lat = /[A-Za-z]/.test(head);
  if (cyr && !lat && !/\d/.test(head)) return 'cyr';
  if (lat && !cyr && !/\d/.test(head)) return 'latin';
  return 'mixed';
}

/** Метка строки: вид и длина. Длина больше предела не показывается цифрами: семь цифр подряд остановили бы файл. */
export function labelOf(s: string): string {
  return `<${kindOf(s)}:${s.length > MAX_SHOWN_LENGTH ? `${MAX_SHOWN_LENGTH}+` : s.length}>`;
}

/** Статус записи: число остаётся, только если проверка содержимого его не примет за серию цифр. */
export function statusShape(n: number | null): number | string | null {
  return n === null || (Number.isInteger(n) && Math.abs(n) <= MAX_KEPT_INT) ? n : numberLabel(n);
}

function numberLabel(n: number): string {
  if (!Number.isInteger(n)) return '<float>';
  const digits = Math.abs(n) < 1e21 ? String(Math.abs(n)).length : 22;
  return `<int:${digits}>`;
}

// ---------- Что остаётся как есть ----------

/** Значение технического поля, код, действие, HTTP-метод: латиница и цифры, форма и обе маски не меняют. */
export function keepValue(s: string): boolean {
  return VALUE_SHAPE.test(s) && passesForm(s) && !masksChange(s);
}

/** Значение как есть или метка. */
export function valueOrLabel(s: string): string {
  return keepValue(s) ? s : labelOf(s);
}

export function keepKey(key: string): boolean {
  return KEY_SHAPE.test(key) && passesForm(key) && !masksChange(key);
}

const keyLabel = (key: string) => `<key:${key.length > MAX_SHOWN_LENGTH ? `${MAX_SHOWN_LENGTH}+` : key.length}>`;

/** Имена списком: заменённые становятся метками, повторов нет. */
function nameList(names: Iterable<string>, max: number): string[] {
  const out = new Set<string>();
  for (const n of names) {
    if (out.size >= max) break;
    out.add(keepKey(n) ? n : keyLabel(n));
  }
  return [...out];
}

export function labelValue(value: string): string {
  return LABEL_VALUE_SHAPE.test(value) && passesForm(value) && !masksChange(value) ? value : labelOf(value);
}

/** Значение метки потока: у разрешённой остаётся после проверки формы, у остальных — метка значения. */
export function flowLabelValue(name: string, value: string): string {
  return FLOW_LABELS.has(name) ? labelValue(value) : labelOf(value);
}

export function flowLabels(labels: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  const seen = new Map<string, number>();
  for (const name of Object.keys(labels).sort()) setKey(out, uniqueKey(name, seen), flowLabelValue(name, labels[name]!));
  return out;
}

function setKey(o: Record<string, unknown>, k: string, v: unknown): void {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
}

/** Ключ или его метка; повторная метка получает номер, значения не теряются. */
export function uniqueKey(key: string, seen: Map<string, number>): string {
  if (keepKey(key)) return key;
  const label = keyLabel(key);
  const n = (seen.get(label) ?? 0) + 1;
  seen.set(label, n);
  return n === 1 ? label : `<key:${label.slice(5, -1)}#${n}>`;
}

// ---------- Поля и слова справочника ----------

/** Белый список: явные поля и последнее имя полей, которые читают правила итога и status методов. Секреты и текст не входят. */
export function allowedFields(snapshot: CatalogSnapshot | null): Set<string> {
  const out = new Set(TECHNICAL_FIELDS);
  if (!snapshot) return out;
  const paths = [...snapshot.outcomeRules.flatMap((r) => (r.when.fields ?? []).map((f) => f.path)), ...snapshot.methods.flatMap((m) => (m.status ? [m.status.path] : []))];
  for (const p of paths) {
    if (sensitivePath(p) !== null) continue;
    const last = normalizeFieldName(p.slice(p.lastIndexOf('.') + 1));
    if (!TEXT_FIELDS.has(last) && !STRICT.fields.has(last)) out.add(last);
  }
  return out;
}

export function catalogWords(snapshot: CatalogSnapshot | null): Set<string> {
  const out = new Set<string>();
  for (const m of snapshot?.methods ?? []) for (const s of parseTemplate(m.path)) if (s.literal !== null) out.add(s.literal);
  return out;
}

// ---------- Адреса ----------

const PLACEHOLDER = /^\{([^{}/]*)\}$/;

/** Слова шаблона пути: подстановки не считаются. Для подсчёта по correlation_id. */
export function pathWords(path: string): string[] {
  if (path.length > MAX_PATH_SCAN) return [];
  return unknownPath(path, STRICT)
    .split('/')
    .filter((s) => s !== '' && !PLACEHOLDER.test(s) && WORD_SHAPE.test(s));
}

const wordKept = (seg: string, o: ShapeOptions) => passesForm(seg) && !masksChange(seg) && (o.words.has(seg) || (o.frequent.has(seg) && WORD_SHAPE.test(seg)));

/** Шаблон пути: сегмент с данными и редкое слово заменены, имя подстановки только от оставшегося слова. */
export function pathShape(path: string, o: ShapeOptions): string {
  if (path.length > MAX_PATH_SCAN) return labelOf(path);
  const parts = unknownPath(path, STRICT).split('/');
  const kept = parts.map(() => false);
  const used = new Map<string, number>();
  const place = (base: string) => {
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    return `{${n === 1 ? base : `${base}${n}`}}`;
  };
  return parts
    .map((seg, i) => {
      if (seg === '') return seg;
      const m = PLACEHOLDER.exec(seg);
      if (m) {
        const base = m[1]!.replace(/\d+$/, '');
        if (base === 'seg') return seg;
        return place(i > 0 && kept[i - 1] && base !== '' ? base : 'id');
      }
      kept[i] = wordKept(seg, o);
      return kept[i] ? seg : '{seg}';
    })
    .join('/');
}

const IPV4_HOST = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** Хост: ключ системы или метка. Настоящих хостов в файле нет. */
export function hostMark(uri: string, o: ShapeOptions): string | null {
  const parts = uriParts(uri);
  if (!parts.host) return null;
  const key = o.systemOf(uri);
  if (key !== null && keepValue(key)) return `system:${key}`;
  return hostShape(parts.host);
}

export function hostShape(host: string): string {
  return IPV4_HOST.test(host.replace(/:\d*$/, '')) ? '<host:ipv4>' : '<host:dns>';
}

function queryNames(query: string | null): string[] {
  if (!query) return [];
  return nameList(
    query.split('&').map((p) => p.split('=', 1)[0]!).filter((n) => n !== ''),
    MAX_FORM_NAMES,
  );
}

export function httpShape(uri: string, o: ShapeOptions): { host: string | null; path: string; queryNames: string[] } {
  const parts = uriParts(uri);
  return { host: hostMark(uri, o), path: pathShape(parts.path, o), queryNames: queryNames(parts.query) };
}

// ---------- Обход ----------

interface WalkState {
  o: ShapeOptions;
  budget: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const FORM_NAME = /^[^=&\s/:?#]{1,64}$/;
const REQUEST_LINE = /^[A-Z][A-Z0-9_-]{0,19} \S+ HTTP\/\d|^HTTP\/\d/;
const XML_TAG = /<([^\s<>/!?][^\s<>/]*)/g;
/** Метка, которую поставил withoutHuge: значения в ней нет. */
const OWN_LABEL = /^<(?:uuid|digits|hex|date|b64|latin|cyr|mixed|masked|int):\d{1,6}\+?>$/;

function formNames(s: string): string[] | null {
  if (!s.includes('=')) return null;
  const names: string[] = [];
  for (const pair of s.split('&')) {
    const at = pair.indexOf('=');
    if (at <= 0 || !FORM_NAME.test(pair.slice(0, at))) return null;
    names.push(pair.slice(0, at));
  }
  // Одна пара без значения — скорее конец base64, чем форма: имя открыло бы значение.
  if (names.length === 1 && s.trimEnd().endsWith('=')) return null;
  return names;
}

function xmlTags(s: string): string[] {
  const names = new Set<string>();
  for (const m of s.matchAll(XML_TAG)) {
    names.add(m[1]!);
    if (names.size >= MAX_XML_TAGS) break;
  }
  return [...names];
}

const BROKEN = Symbol('broken');
const BARE_MASK = /([:[,]\s*)([\w+.-]*\*+[\w+.-]*)(?=\s*[,\]}])/g;

/** Проход по тексту заменяет голое число маской без кавычек: {"x":********0001}. Форма записи та же, поэтому разбор повторяется с кавычками. */
function parseMasked(t: string): unknown {
  try {
    return JSON.parse(t);
  } catch {
    try {
      return JSON.parse(t.replace(BARE_MASK, '$1"$2"'));
    } catch {
      return BROKEN;
    }
  }
}

function nested(s: string, depth: number, st: WalkState): unknown {
  if (s.length > MAX_NESTED_BYTES) return null;
  const t = s.trimStart();
  const first = t[0];
  if (first === '{' || first === '[') {
    if (depth >= MAX_DEPTH) return CUT;
    const parsed = parseMasked(t);
    return parsed === BROKEN ? null : { $json: walk(parsed, null, depth + 1, st) };
  }
  if (REQUEST_LINE.test(t.slice(0, 8192))) {
    const m = decodeHttp(t);
    if (m) {
      const uri = typeof m.uri === 'string' ? httpShape(m.uri, st.o) : null;
      return {
        $http: {
          method: typeof m.method === 'string' ? valueOrLabel(m.method) : null,
          path: uri?.path ?? null,
          queryNames: uri?.queryNames ?? [],
          status: typeof m.status === 'number' ? m.status : null,
          headers: walk(m.headers, null, depth + 1, st),
          body: typeof m.body === 'string' ? walk(m.body, null, depth + 1, st) : null,
        },
      };
    }
  }
  if (first === '<') return { $xml: nameList(xmlTags(t), MAX_XML_TAGS) };
  if (kindOf(t) === 'b64') return null;
  const form = formNames(t);
  if (form) return { $form: nameList(form, MAX_FORM_NAMES) };
  if (/^https?:\/\//i.test(t) || /^\/\S*$/.test(t)) {
    const u = httpShape(t, st.o);
    return { $url: { host: u.host, path: u.path, query: u.queryNames } };
  }
  return null;
}

const allowedName = (name: string | null, st: WalkState) => name !== null && st.o.allowed.has(normalizeFieldName(name));

function walk(v: unknown, name: string | null, depth: number, st: WalkState): unknown {
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number') return allowedName(name, st) && Number.isInteger(v) && Math.abs(v) <= MAX_KEPT_INT ? v : numberLabel(v);
  if (typeof v === 'string') {
    if (v === '' || OWN_LABEL.test(v)) return v;
    if (allowedName(name, st) && keepValue(v)) return v;
    return nested(v, depth, st) ?? labelOf(v);
  }
  if (Array.isArray(v)) {
    if (depth >= MAX_DEPTH) return CUT;
    const out: unknown[] = v.slice(0, MAX_ARRAY_ITEMS).map((x) => walk(x, name, depth + 1, st));
    if (v.length > MAX_ARRAY_ITEMS) out.push({ $more: v.length - MAX_ARRAY_ITEMS });
    return out;
  }
  if (isObj(v)) {
    if (depth >= MAX_DEPTH) return CUT;
    const out: Record<string, unknown> = {};
    const keys = Object.keys(v);
    const seen = new Map<string, number>();
    for (let i = 0; i < keys.length; i++) {
      if (i === MAX_OBJECT_KEYS) {
        out.$more = keys.length - i;
        break;
      }
      // Обрезка по границе поля: дальше поля записи не идут.
      if (st.budget <= 0) {
        out.$cut = CUT;
        break;
      }
      const key = keys[i]!;
      const shown = uniqueKey(key, seen);
      const child = walk(v[key], keepKey(key) ? key : null, depth + 1, st);
      setKey(out, shown, child);
      st.budget -= shown.length + (typeof child === 'string' ? child.length : 8) + depth * 4 + 12;
    }
    return out;
  }
  return CUT;
}

/** До маски: строка больше предела вложенного разбора и число больше предела белого списка всё равно станут меткой. */
function withoutHuge(v: unknown): unknown {
  if (typeof v === 'string') return v.length > MAX_NESTED_BYTES ? labelOf(v) : v;
  if (typeof v === 'number') return Number.isInteger(v) && Math.abs(v) > MAX_KEPT_INT ? numberLabel(v) : v;
  if (Array.isArray(v)) return v.map(withoutHuge);
  if (isObj(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) setKey(out, k, withoutHuge(x));
    return out;
  }
  return v;
}

/** Текст после обеих масок: значения словаря уже скрыты. Для сообщения и строки не JSON. */
export function maskedText(s: string): string {
  if (s.length > MAX_NESTED_BYTES) return s;
  return maskKindsText(maskText(s, NO_KEEP), STRICT, NO_KEEP);
}

export function textLabel(s: string): string {
  return labelOf(maskedText(s));
}

/** Обход значения в режиме структуры с пределом записи. Не уложилось — бюджет меньше, в конце <cut> целиком. */
export function shapeTree(masked: unknown, o: ShapeOptions): unknown {
  for (let budget = MAX_TREE_BYTES; budget >= MAX_TREE_BYTES / 8; budget /= 2) {
    const tree = walk(masked, null, 0, { o, budget });
    if (JSON.stringify(tree, null, 2).length <= MAX_TREE_BYTES) return tree;
  }
  return CUT;
}

/**
 * Путь записи: JSON.parse → базовая маска → строгий проход всех видов → режим структуры.
 * Строка не JSON становится меткой: значит, текст в файл не идёт ни при какой форме.
 */
export function recordTree(line: string, o: ShapeOptions): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return textLabel(line);
  }
  const masked = maskKindsDeep(maskDeep(withoutHuge(parsed), NO_KEEP), STRICT, NO_KEEP);
  return shapeTree(masked, o);
}
