// compileCatalog(snapshot) → Resolver: индексы хостов, методов, правил ошибок и итога, типов id.
// Скрытые записи в Resolver не входят.

import type { CatalogName, CatalogRuleLevel } from '../search/api.ts';
import { compileMasking, type CompiledMasking } from '../search/mask-pass.ts';
import { HostIndex, hostLabel, uriParts, type UriParts } from './host.ts';
import { conditionsMatch, type OutcomeContext } from './outcome.ts';
import { compareTemplates, matchSegments, parseTemplate, pathSegments, type TemplateSegment } from './path.ts';
import { codeKey, matchText, type CatalogSnapshot, type ErrorRow, type IdTypeRow, type MethodRow, type OutcomeRow, type SystemRow, type SystemType } from './schema.ts';

export interface CompiledMethod {
  row: MethodRow;
  system: SystemRow;
  tpl: TemplateSegment[];
}

/** Шаг по справочнику: система, метод, сегменты пути и шаблон выбранного метода. */
export interface ResolvedStep {
  system: SystemRow | null;
  method: MethodRow | null;
  tpl: TemplateSegment[] | null;
  segs: string[];
  uri: UriParts;
  /** Система узнана по пути и действию, а не по хосту. */
  byPath: boolean;
}

export interface ErrorFact {
  /** Статус для показа: только HTTP 400 и выше. */
  http: number | null;
  /** Настоящий статус ответа: с ним сравнивается условие правила. У записи приложения статуса нет. */
  status: number | null;
  code: string | null;
  /** Исходный текст для подстроки правила: в браузер не уходит. */
  text: string | null;
  /** В тексте страница HTML: текст без неё. Правило, написанное по строке «Неизвестного», сравнивается и с ним. */
  readable?: string;
  /** Текст для показа и «Неизвестного»: без страницы HTML, маскирован, затем обрезан. */
  shown: string | null;
  /** Текст для ключа строки «Неизвестного»: как `shown`, но со страницей HTML, чтобы прежние строки не потерялись. */
  keyText: string | null;
}

/** Что сравнивает правило ошибки. */
export type ErrorQuery = Pick<ErrorFact, 'status' | 'code' | 'text' | 'readable'>;

export interface Scope {
  systemId: number | null;
  methodId: number | null;
}

export interface ErrorMatch {
  rule: ErrorRow;
  level: CatalogRuleLevel;
}

export interface OutcomeMatch {
  rule: OutcomeRow;
  level: CatalogRuleLevel;
}

export type Channel = 'http' | 'db' | 'queue';

const CHANNEL_TYPE: Record<Exclude<Channel, 'http'>, SystemType> = { db: 'database', queue: 'queue' };

const conditionCount = (e: ErrorRow) => (e.http !== null ? 1 : 0) + (e.code !== null ? 1 : 0) + (e.text !== null ? 1 : 0);

function byErrorOrder(a: ErrorRow, b: ErrorRow): number {
  return (
    conditionCount(b) - conditionCount(a) ||
    Number(b.code !== null) - Number(a.code !== null) ||
    Number(b.text !== null) - Number(a.text !== null) ||
    a.id - b.id
  );
}

const byOutcomeOrder = (a: OutcomeRow, b: OutcomeRow) => a.priority - b.priority || a.id - b.id;

/** Текст для подстроки правила: регистр, лишние пробелы и переводы строк не важны. Так же собрана строка «Неизвестного». */

function levelKeys(scope: Scope): { key: string; level: CatalogRuleLevel }[] {
  const out: { key: string; level: CatalogRuleLevel }[] = [];
  if (scope.methodId !== null) out.push({ key: `m:${scope.methodId}`, level: 'method' });
  if (scope.systemId !== null) out.push({ key: `s:${scope.systemId}`, level: 'system' });
  out.push({ key: 'g', level: 'general' });
  return out;
}

function ruleKey(r: { systemId: number | null; methodId: number | null }): string {
  return r.methodId !== null ? `m:${r.methodId}` : r.systemId !== null ? `s:${r.systemId}` : 'g';
}

export class Resolver {
  readonly project: string;
  readonly version: number;
  readonly author: SystemRow | null;
  readonly idTypes: ReadonlyMap<string, IdTypeRow>;
  readonly systems: ReadonlyMap<number, SystemRow>;
  readonly methods: ReadonlyMap<number, MethodRow>;
  /** Настройка маскирования проекта. */
  readonly masking: CompiledMasking;

  readonly #hosts = new HostIndex<SystemRow>();
  /** Методы по числу сегментов: все системы. */
  readonly #byLength = new Map<number, CompiledMethod[]>();
  readonly #errors = new Map<string, ErrorRow[]>();
  readonly #outcomes = new Map<string, OutcomeRow[]>();
  readonly #single = new Map<SystemType, SystemRow | null>();
  readonly #systemByKey = new Map<string, SystemRow>();

  constructor(snapshot: CatalogSnapshot) {
    this.project = snapshot.project;
    this.version = snapshot.version;
    this.masking = compileMasking(snapshot.masking ?? []);
    const systems = snapshot.systems.filter((s) => !s.hidden);
    this.systems = new Map(systems.map((s) => [s.id, s]));
    this.author = systems.find((s) => s.kind === 'project') ?? null;
    this.idTypes = new Map(snapshot.idTypes.filter((t) => !t.hidden).map((t) => [t.key, t]));
    for (const s of systems) {
      this.#systemByKey.set(s.key, s);
      for (const h of s.hosts) this.#hosts.add(h, s);
      if (s.type !== 'service') this.#single.set(s.type, this.#single.has(s.type) ? null : s);
    }
    const methods = snapshot.methods.filter((m) => !m.hidden && this.systems.has(m.systemId));
    this.methods = new Map(methods.map((m) => [m.id, m]));
    for (const m of methods) {
      const tpl = parseTemplate(m.path);
      const list = this.#byLength.get(tpl.length) ?? [];
      list.push({ row: m, system: this.systems.get(m.systemId)!, tpl });
      this.#byLength.set(tpl.length, list);
    }
    const visible = (r: { systemId: number | null; methodId: number | null; hidden: boolean }) =>
      !r.hidden && (r.systemId === null || this.systems.has(r.systemId)) && (r.methodId === null || this.methods.has(r.methodId));
    for (const e of snapshot.errors.filter(visible)) push(this.#errors, ruleKey(e), e);
    for (const o of snapshot.outcomeRules.filter(visible)) push(this.#outcomes, ruleKey(o), o);
    for (const list of this.#errors.values()) list.sort(byErrorOrder);
    for (const list of this.#outcomes.values()) list.sort(byOutcomeOrder);
  }

  systemByKey(key: string): SystemRow | undefined {
    return this.#systemByKey.get(key);
  }

  /** Подходящие методы: HTTP-метод, шаблон; сначала с этим действием, иначе без действия. Лучший — первым. */
  #candidates(http: string | null, segs: readonly string[], action: string, only?: (m: CompiledMethod) => boolean): CompiledMethod[] {
    const verb = (http ?? '').toUpperCase();
    const matching = (this.#byLength.get(segs.length) ?? []).filter(
      (m) => (!only || only(m)) && (m.row.http === '*' || m.row.http === verb) && matchSegments(m.tpl, segs),
    );
    const withAction = action ? matching.filter((m) => m.row.rpc === action) : [];
    const pool = withAction.length > 0 ? withAction : matching.filter((m) => m.row.rpc === '');
    return pool.sort((a, b) => compareTemplates(a.tpl, b.tpl) || Number(a.row.http === '*') - Number(b.row.http === '*') || a.row.id - b.row.id);
  }

  /** Вход: только методы системы-автора, шлюз и приложение не различаются. */
  entry(http: string | null, uri: string | null): ResolvedStep {
    const parts = uriParts(uri);
    const segs = pathSegments(parts.path);
    const author = this.author;
    const best = author ? this.#candidates(http, segs, '', (m) => m.system.id === author.id)[0] : undefined;
    return { system: author, method: best?.row ?? null, tpl: best?.tpl ?? null, segs, uri: parts, byPath: false };
  }

  /** Обмен: система по хосту, иначе по пути и действию, если они указывают на одну систему. */
  exchange(http: string | null, uri: string | null, action: string, channel: Channel = 'http'): ResolvedStep {
    const parts = uriParts(uri);
    const segs = pathSegments(parts.path);
    const none: ResolvedStep = { system: null, method: null, tpl: null, segs, uri: parts, byPath: false };
    let system = this.#hosts.find(parts) ?? null;
    if (channel !== 'http') {
      const s = system && system.type === CHANNEL_TYPE[channel] ? system : (this.#single.get(CHANNEL_TYPE[channel]) ?? null);
      return { ...none, system: s };
    }
    if (system) {
      const best = this.#candidates(http, segs, action, (m) => m.system.id === system!.id)[0];
      return { ...none, system, method: best?.row ?? null, tpl: best?.tpl ?? null };
    }
    const authorId = this.author?.id;
    const pool = this.#candidates(http, segs, action, (m) => m.system.id !== authorId);
    const ids = new Set(pool.map((m) => m.system.id));
    if (ids.size !== 1) return none;
    const best = pool[0]!;
    system = best.system;
    return { ...none, system, method: best.row, tpl: best.tpl, byPath: true };
  }

  /** Метод системы по HTTP-методу, пути и действию. */
  methodIn(systemId: number, http: string | null, uri: string, action: string): MethodRow | null {
    const segs = pathSegments(uriParts(uri).path);
    return this.#candidates(http, segs, action, (m) => m.system.id === systemId)[0]?.row ?? null;
  }

  /** Правило ошибки: метод → система → общие; внутри уровня — больше условий, код, текст, id. */
  /** skip: правила, которые при этой проверке не считаются. */
  matchError(scope: Scope, fact: ErrorQuery, skip?: (rule: ErrorRow) => boolean): ErrorMatch | null {
    const key = codeKey(fact.code);
    const text = fact.text ? matchText(fact.text) : null;
    const readable = fact.readable ? matchText(fact.readable) : null;
    for (const { key: k, level } of levelKeys(scope)) {
      for (const rule of this.#errors.get(k) ?? []) {
        if (skip?.(rule)) continue;
        if (rule.http !== null && rule.http !== fact.status) continue;
        if (rule.code !== null && codeKey(rule.code) !== key) continue;
        if (rule.text !== null) {
          const wanted = matchText(rule.text);
          if (!text?.includes(wanted) && !readable?.includes(wanted)) continue;
        }
        return { rule, level };
      }
    }
    return null;
  }

  /** Правило итога: метод → система → общие; внутри уровня — по приоритету, затем по id. */
  matchOutcome(scope: Scope, ctx: OutcomeContext): OutcomeMatch | null {
    for (const { key, level } of levelKeys(scope)) {
      for (const rule of this.#outcomes.get(key) ?? []) if (conditionsMatch(rule.when, ctx)) return { rule, level };
    }
    return null;
  }

  /** Есть ли правила итога для области: без них тела ответов для итога не разбираются. */
  hasOutcomeRules(scope: Scope): boolean {
    return levelKeys(scope).some(({ key }) => (this.#outcomes.get(key)?.length ?? 0) > 0);
  }

  /** Подпись шага. Вход — проект, если метод узнан; обмен — вид узнанной системы. */
  name(step: ResolvedStep, at: 'entry' | 'exchange'): CatalogName {
    const { system, method } = step;
    const source = at === 'entry' ? (method ? 'project' : 'unknown') : system ? (system.kind === 'project' ? 'project' : 'external') : 'unknown';
    return {
      source,
      system: system ? { key: system.key, name: system.name, type: system.type } : null,
      method: method
        ? {
            id: method.id,
            name: method.name,
            domain: method.domain,
            kind: method.kind,
            opType: method.op ? { key: method.op, name: this.idTypes.get(method.op)?.name ?? method.op } : null,
          }
        : null,
      host: at === 'entry' ? null : hostLabel(step.uri),
    };
  }
}

function push<T>(map: Map<string, T[]>, key: string, v: T): void {
  const list = map.get(key);
  if (list) list.push(v);
  else map.set(key, [v]);
}

export function compileCatalog(snapshot: CatalogSnapshot): Resolver {
  return new Resolver(snapshot);
}
