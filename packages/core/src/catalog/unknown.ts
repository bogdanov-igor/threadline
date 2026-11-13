// «Неизвестное»: ключи и маскированные примеры.
// Значений из пути и тела в примере нет: путь — шаблон, сегменты с данными заменены подстановкой;
// код, действие, хост и текст — после маскирования и нормализации. Ключ считается уже от этих значений.

import { isPanName, isSecretName, maskText } from '../search/masking.ts';
import { BUILTIN_MASKING, maskKindsText, type MaskPolicy } from '../search/mask-pass.ts';
import { pairExchanges, sortRecords, WARNING_LEVEL, type ParsedRecord } from '../search/records.ts';
import { analyze, type StepRecord } from './annotate.ts';
import { hiddenPart } from './general-rule.ts';
import { hostLabel } from './host.ts';
import { isIdSegment, paramName, pathKey } from './path.ts';
import type { Resolver } from './resolve.ts';
import { rpcAction } from './rpc.ts';
import { codeKey, type MethodRow, type SystemRow } from './schema.ts';
import { sha1 } from './sha1.ts';

export type UnknownKind = 'method' | 'host' | 'error';

export interface UnknownItem {
  /** sha1 нормализованного ключа. */
  key: string;
  kind: UnknownKind;
  systemId: number | null;
  methodId: number | null;
  httpMethod: string | null;
  /** Читаемый шаблон пути без строки запроса. */
  path: string | null;
  rpc: string | null;
  host: string | null;
  httpStatus: number | null;
  code: string | null;
  /** Маскированный нормализованный текст, до 200 символов. */
  text: string | null;
}

const NO_KEEP: ReadonlySet<string> = new Set();
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const HAS_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const LONG_DIGITS = /\d{7,}/g;
const MAX_TEXT = 200;
/** Код ошибки, HTTP-метод, действие и хост: коротких значений здесь больше не бывает. */
const MAX_VALUE = 128;

// Слово с маской целиком: две ошибки с разными хвостами телефона или первыми буквами фамилии дают один ключ.
const MASKED_WORD = /[\p{L}\p{N}+._-]*\*{2,}[\p{L}\p{N}._-]*/gu;
const PAN_MASK = /^\d{6}\*+\d{4}$/;

// Символ с кодом 0: поле партнёра фиксированной длины. В текст PostgreSQL он не записывается, пакет с ним отклонён бы целиком.
const NUL = '\0';

/** Значение примера: без символа 0, маскирование, uuid, числа от 7 цифр и слова с маской → «…», пробелы схлопнуты. */
function normalized(s: string, strict: MaskPolicy = BUILTIN_MASKING.strict): string {
  return maskKindsText(maskText(s.replaceAll(NUL, ' '), NO_KEEP), strict, NO_KEEP)
    .replace(UUID, '…')
    .replace(LONG_DIGITS, '…')
    .replace(MASKED_WORD, (w) => (PAN_MASK.test(w) ? w : '…'))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Текст примера: нормализация, до 200 символов. */
export function unknownText(s: string, strict: MaskPolicy = BUILTIN_MASKING.strict): string {
  return normalized(s, strict).slice(0, MAX_TEXT);
}

/** Код, действие, хост или HTTP-метод в примере: та же нормализация. Пусто — null. */
function unknownValue(s: string | null | undefined, strict: MaskPolicy = BUILTIN_MASKING.strict): string | null {
  return s ? normalized(s, strict).slice(0, MAX_VALUE) || null : null;
}

// Серия цифр с разделителями: номер карты группами, телефон, дата, номер договора. Разделитель — любой одиночный символ.
const DIGIT_SERIES = /\d(?:[^A-Za-z0-9]?\d){6,}/;
// Значение внутри сегмента: параметр матрицы, пара имя=значение, учётные данные.
const VALUE_MARK = /[=;@,]/;
const JWT = /^eyJ[\w-]+\.[\w-]+/;
const LETTERS_AND_DIGITS = (s: string) => /\d/.test(s) && /[A-Za-z]/.test(s);
// Длинные слова: base64 и случайные строки. Подряд идущие слова имени метода короче.
const LONG_WORD = 16;

function tokenLike(seg: string): boolean {
  if (JWT.test(seg)) return true;
  const plain = /^[A-Za-z0-9]+$/.test(seg);
  if (LETTERS_AND_DIGITS(seg) && seg.length >= (plain ? 12 : 20)) return true;
  const words = seg
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z]+/);
  return words.some((w) => w.length >= LONG_WORD);
}

/** Сегмент без percent-encoding: %25 бывает до нескольких уровней. */
function decoded(seg: string): string {
  let out = seg;
  for (let i = 0; i < 3 && out.includes('%'); i++) {
    try {
      out = decodeURIComponent(out);
    } catch {
      return out;
    }
  }
  return out;
}

/** Сегмент пути с данными: что-то скрыла бы маска, есть uuid или серия от 7 цифр, значение или токен. */
function unsafeSegment(raw: string, strict: MaskPolicy): boolean {
  const seg = decoded(raw);
  return VALUE_MARK.test(seg) || maskText(seg, NO_KEEP) !== seg || maskKindsText(seg, strict, NO_KEEP) !== seg || HAS_UUID.test(seg) || DIGIT_SERIES.test(seg) || tokenLike(seg);
}

/**
 * Путь примера: без строки запроса; сегмент-идентификатор — подстановка с именем по предыдущему сегменту,
 * сегмент с данными другого вида — {id}. Имя не берётся из сегмента с данными.
 */
export function unknownPath(path: string, strict: MaskPolicy = BUILTIN_MASKING.strict): string {
  const segments = path.replace(/[?#].*$/s, '').replaceAll(NUL, '').split('/');
  const unsafe = segments.map((seg) => seg !== '' && unsafeSegment(seg, strict));
  // Значение после имени секрета или номера: /pin/1234, /password/Abc1. Обычное слово — часть пути: /password/reset.
  segments.forEach((seg, i) => {
    const prev = segments[i - 1] ?? '';
    if (seg !== '' && (isSecretName(prev) || isPanName(prev)) && !/^[a-z_-]+$/.test(seg)) unsafe[i] = true;
  });
  // Номер, разбитый на сегменты: /card/4111/1112/3455/7893.
  for (let i = 0; i < segments.length; ) {
    let j = i;
    while (j < segments.length && /^\d+$/.test(segments[j]!)) j++;
    if (segments.slice(i, j).join('').length >= 12) for (let k = i; k < j; k++) unsafe[k] = true;
    i = Math.max(j, i + 1);
  }
  const used = new Map<string, number>();
  const place = (base: string) => {
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    return `{${n === 1 ? base : `${base}${n}`}}`;
  };
  return segments
    .map((seg, i) => {
      if (seg === '') return seg;
      const prevSafe = i > 0 && !unsafe[i - 1] && !isIdSegment(segments[i - 1]!);
      if (isIdSegment(seg)) return place(paramName(prevSafe ? segments[i - 1] : undefined));
      return unsafe[i] ? place('id') : seg;
    })
    .join('/');
}

/** Текст для ключа: как пример, в нижнем регистре. Тексты, различные только uuid, дают один ключ. */
export function unknownTextKey(s: string): string {
  return unknownText(s).toLowerCase();
}

export function methodUnknownKey(systemKey: string, http: string, template: string, rpc: string): string {
  return sha1(['m', systemKey, http.toUpperCase(), pathKey(template), rpc].join('\u0000'));
}
export function hostUnknownKey(host: string): string {
  return sha1(['h', host].join('\u0000'));
}
export function errorUnknownKey(systemKey: string, methodId: number | null, http: number | null, code: string | null, text: string | null): string {
  return sha1(['e', systemKey, String(methodId ?? 0), String(http ?? ''), codeKey(code) ?? '', unknownTextKey(text ?? '')].join('\u0000'));
}

function fromParsed(r: ParsedRecord): StepRecord {
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
    // Обращения к базе в «Неизвестное» не идут: там только входы, обмены и ошибки.
    db: null,
  };
}

/**
 * Неузнанное в записях запроса: входящий метод проекта, хост без системы, метод узнанной системы,
 * ошибка без правила у узнанной системы или проекта. Ошибки неузнанных систем отдельно не собираются.
 * Ответ с итогом по правилу ошибку не даёт, кроме error без текста правила и без правила ошибки.
 */
export function unknownItems(records: readonly ParsedRecord[], resolver: Resolver): UnknownItem[] {
  // Пример хранится в базе: все виды, включая выключенные по умолчанию, какое бы значение ни имел переключатель.
  const strict = resolver.masking.stored;
  const sorted = sortRecords(records);
  const pairs = pairExchanges(sorted);
  const recs = sorted.map(fromParsed);
  const facts = analyze(recs, sorted, pairs, resolver);
  const out = new Map<string, UnknownItem>();
  const add = (item: UnknownItem) => {
    if (!out.has(item.key)) out.set(item.key, item);
  };
  const base = { systemId: null, methodId: null, httpMethod: null, path: null, rpc: null, host: null, httpStatus: null, code: null, text: null };

  sorted.forEach((r, i) => {
    const f = facts[i]!;
    const step = f.step;
    // Адрес не разобран (в authority не порт, а обрезок учётных данных): из такой строки примера нет.
    if (step?.uri.invalid) return;
    const template = step ? unknownPath(step.uri.path, strict) : null;
    const http = unknownValue((r.method ?? '').toUpperCase(), strict);
    if (r.kind === 'incoming' && step) {
      const author = resolver.author;
      if (author && !step.method && template !== null) {
        add({ ...base, key: methodUnknownKey(author.key, http ?? '', template, ''), kind: 'method', systemId: author.id, httpMethod: http, path: template });
      }
      return;
    }
    if ((r.kind === 'send' || r.kind === 'response') && step) {
      const host = unknownValue(hostLabel(step.uri), strict);
      if (!step.system) {
        if (host) add({ ...base, key: hostUnknownKey(host), kind: 'host', httpMethod: http, path: template, host });
        return;
      }
      if (!step.method && step.system.kind !== 'project' && step.system.type === 'service' && template !== null) {
        const rpc = unknownValue(actionOf(recs, i, pairs), strict) ?? '';
        add({
          ...base,
          key: methodUnknownKey(step.system.key, http ?? '', template, rpc),
          kind: 'method',
          systemId: step.system.id,
          httpMethod: http,
          path: template,
          rpc: rpc || null,
          host,
        });
      }
      if (r.kind === 'response' && f.fact && !f.match) {
        const o = f.outcome?.rule;
        if (o && (o.outcome !== 'error' || o.text)) return;
        const code = unknownCode(f.fact.code, strict);
        add({
          ...base,
          key: errorUnknownKey(step.system.key, step.method?.id ?? null, f.fact.http, code, f.fact.keyText),
          kind: 'error',
          systemId: step.system.id,
          methodId: step.method?.id ?? null,
          httpMethod: http,
          path: template,
          host,
          // Метод описали позже: действие нужно, чтобы уборка нашла его правило.
          rpc: step.method ? null : unknownValue(actionOf(recs, i, pairs), strict),
          httpStatus: httpStatus(f.fact.http ?? r.status),
          code,
          text: f.fact.shown === null ? null : unknownText(f.fact.shown, strict),
        });
      }
      return;
    }
    if (recs[i]!.logError && f.fact && !f.match && f.scope && resolver.author) {
      const code = unknownCode(f.fact.code, strict);
      add({
        ...base,
        key: errorUnknownKey(resolver.author.key, f.scope.methodId, null, code, f.fact.keyText),
        kind: 'error',
        systemId: resolver.author.id,
        methodId: f.scope.methodId,
        code,
        text: f.fact.shown === null ? null : unknownText(f.fact.shown, strict),
      });
    }
  });
  return [...out.values()];
}

/** HTTP-статус примера: только целое от 100 до 599. Дробь или огромное число из записи лога колонка int не примет. */
function httpStatus(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 100 && v <= 599 ? v : null;
}

/** Код примера: объект или массив не сохраняются, в них могут быть любые поля. */
function unknownCode(code: string | null, strict: MaskPolicy): string | null {
  return code === null || /^\s*[{[]/.test(code) ? null : unknownValue(code, strict);
}

function actionOf(recs: readonly StepRecord[], i: number, pairs: ReadonlyMap<number, number>): string {
  const r = recs[i]!;
  if (r.kind === 'send') return rpcAction(r.body);
  const s = pairs.get(i);
  return (s === undefined ? '' : rpcAction(recs[s]!.body)) || rpcAction(r.body, { response: true });
}

type UnknownRowFacts = { kind: UnknownKind; systemId: number | null; methodId: number | null; httpMethod: string | null; path: string | null; rpc: string | null; host: string | null; httpStatus: number | null; code: string | null; text: string | null };

/** Метод, который теперь описывает адрес строки. */
function describedMethod(row: UnknownRowFacts, system: SystemRow | null | undefined, resolver: Resolver): MethodRow | null {
  if (!system || row.path === null) return null;
  return system.kind === 'project' ? resolver.entry(row.httpMethod, row.path).method : resolver.methodIn(system.id, row.httpMethod, row.path, row.rpc ?? '');
}

/** Покрывает ли новый справочник строку «Неизвестного»: для уборки после правки. */
export function isCovered(row: UnknownRowFacts, resolver: Resolver): boolean {
  if (row.kind === 'host') return resolver.exchange(row.httpMethod, `//${row.host ?? ''}${row.path ?? '/'}`, row.rpc ?? '').system !== null;
  const system = row.systemId === null ? null : resolver.systems.get(row.systemId);
  if (row.kind === 'method') return describedMethod(row, system, resolver) !== null;
  // Строка собрана, когда метода ещё не было: правило этого метода тоже её покрывает.
  const scope = { systemId: row.systemId, methodId: row.methodId ?? describedMethod(row, system, resolver)?.id ?? null };
  // Текст строки под маской, а правило сравнивается с настоящим текстом: подстрока со скрытой частью совпала бы только здесь.
  if (resolver.matchError(scope, { status: row.httpStatus, code: row.code, text: row.text }, (rule) => hiddenPart(rule.text)) !== null) return true;
  // Правило итога сильнее правила ошибки: новые случаи больше не копятся. Проверить можно только условие по HTTP-статусу:
  // тела в строке нет, правило с условием по полю не подойдёт, и строка останется до следующего ответа.
  return resolver.matchOutcome(scope, { http: row.httpStatus, response: { kind: 'none' }, request: { kind: 'none' } }) !== null;
}
