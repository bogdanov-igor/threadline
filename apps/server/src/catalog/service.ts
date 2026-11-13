// Справочник в работе сервера: состояние, фоновое подключение с повтором, проверка схемы, начальный набор,
// кэш Resolver по проектам и опрос версии.
// Threadline работает и без базы: off — адрес не задан, connecting/stale — база недоступна.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { compileCatalog, isCovered, type CatalogSnapshot, type ImportReport, type Resolver } from '@threadline/core/catalog';
import { ALL_KINDS_MASKING, BUILTIN_MASKING, type CatalogState, type CompiledMasking } from '@threadline/core/search';
import { DbError, isBusyError, isConnectionError, openDb, safeMessage, type Db, type Queryable } from './db.ts';
import { importCatalog, parseCatalogText, reportLine } from './exchange.ts';
import { migrate, MigrationError, pendingMigrations } from './migrate.ts';
import * as store from './store.ts';

export interface CatalogProject {
  id: string;
  name: string;
  /** config/catalog/<проект>.yaml; null или нет файла — без начального набора. */
  seedFile: string | null;
}

export interface CatalogLog {
  info(message: string): void;
  warn(message: string): void;
}

/** Проекты из базы: сверка при подключении и опрос версии дают живой список. Без него проекты из файла. */
export interface CatalogProjectsSource {
  sync(db: Db): Promise<readonly CatalogProject[]>;
  poll(db: Db): Promise<readonly CatalogProject[]>;
}

export interface CatalogServiceOptions {
  url: string | undefined;
  projects: readonly CatalogProject[];
  log: CatalogLog;
  projectsSource?: CatalogProjectsSource;
  now?: () => number;
  /** Постоянная пауза повтора подключения, мс. По умолчанию нарастает от 1 до 30 секунд. */
  retryMs?: number;
  /** Опрос версии, мс. */
  pollMs?: number;
  /** Для тестов: своё подключение. */
  open?: (url: string) => Promise<Db>;
}

interface Loaded {
  version: number;
  loadedAt: number;
  snapshot: CatalogSnapshot;
  resolver: Resolver;
  /** Номер чтения по порядку начала: позднее начатое чтение сильнее раньше начатого. */
  ticket: number;
}

/** База недоступна для правки: 503 catalog-unavailable. */
export class CatalogUnavailable extends Error {
  constructor(message = 'справочник недоступен') {
    super(message);
    this.name = 'CatalogUnavailable';
  }
}

/** Ожидание блокировки или запрос не уложились в предел: база отвечает, идёт другая правка или импорт. Состояние справочника не меняется. */
export class CatalogBusy extends CatalogUnavailable {
  constructor() {
    super('справочник занят: идёт другая правка или импорт, повторите через несколько секунд');
    this.name = 'CatalogBusy';
  }
}

const UNKNOWN_SWEEP_LIMIT = 5000;
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 30_000;

/** Команда миграций: сервер схему не меняет, а называет её в журнале и на странице состояния. */
export const MIGRATE_COMMAND = 'node apps/server/src/cli/migrate.ts (локально pnpm threadline:migrate)';

/** Код PostgreSQL: таблицы нет. */
const UNDEFINED_TABLE = '42P01';

export class CatalogService {
  readonly #opts: CatalogServiceOptions;
  readonly #now: () => number;
  readonly #loaded = new Map<string, Loaded>();
  #projects: readonly CatalogProject[];
  #state: CatalogState['state'];
  #message: string | null = null;
  #db: Db | null = null;
  #timer: NodeJS.Timeout | null = null;
  #closed = false;
  #first: Promise<void> = Promise.resolve();
  /** Сколько попыток подряд не удалось: от этого зависит пауза. */
  #failures = 0;
  /** Подписчики «справочник проекта перезагружен»: уборка «Неизвестного», сброс кэшей. */
  readonly #onReload: ((project: string) => void)[] = [];
  /** Подписчики «база снова отвечает»: уборка коротких ссылок. */
  readonly #onConnected: (() => void)[] = [];
  /** Счётчик чтений справочника: см. Loaded.ticket. */
  #loads = 0;

  constructor(opts: CatalogServiceOptions) {
    this.#opts = opts;
    this.#now = opts.now ?? Date.now;
    this.#projects = opts.projects;
    this.#state = opts.url?.trim() ? 'connecting' : 'off';
  }

  get enabled(): boolean {
    return this.#state !== 'off';
  }

  get projects(): readonly CatalogProject[] {
    return this.#projects;
  }

  project(id: string): CatalogProject | undefined {
    return this.#projects.find((p) => p.id === id);
  }

  state(): CatalogState {
    const times = [...this.#loaded.values()].map((l) => l.loadedAt);
    return { state: this.#state, loadedAt: times.length > 0 ? Math.min(...times) : null, message: this.#message };
  }

  /** Resolver проекта или null: справочник выключен или ещё не загружен. */
  resolver(project: string): Resolver | null {
    return this.#loaded.get(project)?.resolver ?? null;
  }

  /**
   * Настройка маскирования. Справочник выключен — настройки не существует, состояния по умолчанию.
   * База недоступна и данных нет — настройка неизвестна, включены все виды. Данные есть — последние данные.
   */
  masking(project: string): CompiledMasking {
    return this.#loaded.get(project)?.resolver.masking ?? (this.#state === 'off' ? BUILTIN_MASKING : ALL_KINDS_MASKING);
  }

  /** Отпечатки настройки всех проектов, во всех состояниях: без данных — отпечаток запасной настройки. */
  maskingStamps(): Record<string, string> {
    return Object.fromEntries(this.#projects.map((p) => [p.id, this.masking(p.id).stamp]));
  }

  snapshot(project: string): CatalogSnapshot | null {
    return this.#loaded.get(project)?.snapshot ?? null;
  }

  onReload(fn: (project: string) => void): void {
    this.#onReload.push(fn);
  }

  onConnected(fn: () => void): void {
    this.#onConnected.push(fn);
  }

  /** Соединение для записи: только в состоянии ok. */
  db(): Db {
    if (this.#state !== 'ok' || !this.#db) throw new CatalogUnavailable();
    return this.#db;
  }

  /** База для чтения: ok или stale (выгрузка из базы, «Неизвестное»). */
  readDb(): Db | null {
    return this.#db && (this.#state === 'ok' || this.#state === 'stale') ? this.#db : null;
  }

  /** Фоновое подключение: сервер не ждёт базу. Промис — первая попытка, для тестов и команды. */
  start(): Promise<void> {
    if (this.#state === 'off') return Promise.resolve();
    this.#first = this.#connect();
    return this.#first;
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    const db = this.#db;
    this.#db = null;
    await db?.close().catch(() => undefined);
  }

  #schedule(fn: () => Promise<void>, ms: number): void {
    if (this.#closed) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void fn(), ms);
    this.#timer.unref();
  }

  #lost(e: unknown): void {
    const url = this.#opts.url ?? '';
    this.#message = `база справочника недоступна (${this.#db?.label ?? 'адрес'}): ${safeMessage(e, url)}`;
    this.#state = this.#loaded.size > 0 ? 'stale' : 'connecting';
  }

  /** Пауза до следующей попытки: 1, 2, 4… до 30 секунд. */
  #nextRetryMs(): number {
    if (this.#opts.retryMs !== undefined) return this.#opts.retryMs;
    return Math.min(RETRY_MIN_MS * 2 ** this.#failures++, RETRY_MAX_MS);
  }

  async #connect(): Promise<void> {
    if (this.#closed) return;
    const url = this.#opts.url!.trim();
    try {
      if (!this.#db) this.#db = await (this.#opts.open ?? ((u: string) => openDb(u, { warn: (m) => this.#opts.log.warn(m) })))(url);
      await this.#db.query('select 1');
      // База PGlite открыта только этим процессом, в памяти или в каталоге локального режима: команда миграций до неё не дотянется.
      if (url.startsWith('pglite:')) await migrate(this.#db);
      else {
        const behind = await pendingMigrations(this.#db);
        if (behind.length > 0) {
          this.#state = 'error';
          this.#message = `схема базы отстала, не применено: ${behind.join(', ')}. Выполните команду миграций: ${MIGRATE_COMMAND}`;
          const pause = this.#nextRetryMs();
          this.#opts.log.warn(`справочник: ${this.#message}; следующая проверка через ${Math.round(pause / 1000)} с`);
          this.#schedule(() => this.#connect(), pause);
          return;
        }
      }
      if (this.#opts.projectsSource) {
        this.#projects = await this.#opts.projectsSource.sync(this.#db);
        this.#forgetGone(this.#projects);
      }
      for (const p of this.#projects) await this.#prepare(this.#db, p);
      for (const p of this.#projects) {
        await this.#load(this.#db, p.id);
        await this.sweepUnknown(p.id);
      }
      this.#state = 'ok';
      this.#message = null;
      this.#failures = 0;
      this.#opts.log.info(`справочник подключён: ${this.#db.label}`);
      for (const fn of this.#onConnected) fn();
      this.#schedule(() => this.#poll(), this.#opts.pollMs ?? 30_000);
    } catch (e) {
      if (e instanceof MigrationError) {
        this.#state = 'error';
        this.#message = e.message;
        this.#opts.log.warn(`справочник: ${e.message}`);
        return;
      }
      if (this.#closed) return;
      // Ошибка открытия (неверная схема адреса, нет PGlite) — состояние «ошибка», повтор не поможет.
      if (!this.#db && e instanceof DbError) {
        this.#state = 'error';
        this.#message = e.message;
        this.#opts.log.warn(`справочник: ${e.message}`);
        return;
      }
      this.#lost(e);
      const pause = this.#nextRetryMs();
      this.#opts.log.warn(`${this.#message}; повтор через ${Math.round(pause / 1000)} с`);
      this.#schedule(() => this.#connect(), pause);
    }
  }

  async #prepare(db: Db, p: CatalogProject): Promise<void> {
    await db.tx(async (q) => {
      await store.lockProject(q, p.id);
      await store.ensureProject(q, p.id, p.name);
    });
    await this.#seed(db, p);
  }

  /** Скрытый и удалённый проект уходят из загруженных: время загрузки и stale считаются только по живым. */
  #forgetGone(list: readonly CatalogProject[]): void {
    const live = new Set(list.map((p) => p.id));
    for (const id of [...this.#loaded.keys()]) if (!live.has(id)) this.#loaded.delete(id);
  }

  /** Новый список проектов: ушедшие забыты, появившиеся получают автора, начальный набор и справочник без перезапуска. */
  async #adopt(db: Db, list: readonly CatalogProject[]): Promise<void> {
    this.#projects = list;
    this.#forgetGone(list);
    for (const p of list) {
      if (this.#loaded.has(p.id)) continue;
      await this.#prepare(db, p);
      await this.#load(db, p.id);
      await this.sweepUnknown(p.id);
    }
  }

  /** Правка со страницы сменила список. Обрыв переводит в stale: запись уже зафиксирована, догонит опрос версии. */
  async projectsChanged(list: readonly CatalogProject[]): Promise<void> {
    const db = this.#db;
    if (!db) {
      this.#projects = list;
      return;
    }
    try {
      await this.#adopt(db, list);
    } catch (e) {
      this.#lost(e);
    }
  }

  /**
   * Начальный набор: импорт без force, если хэш файла изменился. Проект, загруженный командой или со страницы, набор не трогает.
   * Ошибки файла — в журнал, сервер работает.
   */
  async #seed(db: Db, p: CatalogProject): Promise<void> {
    if (!p.seedFile) return;
    let text: string;
    try {
      text = await readFile(p.seedFile, 'utf8');
    } catch {
      return;
    }
    const hash = createHash('sha256').update(text).digest('hex');
    const last = await store.seedHash(db, p.id);
    if (last === hash) return;
    if (last === store.OPERATOR_SEED) {
      this.#opts.log.info(`начальный набор ${p.id} не применяется: справочник проекта загружен командой или со страницы, файл набора его не меняет. Применить набор вручную: pnpm threadline:catalog import ${p.id} <файл>`);
      return;
    }
    const parsed = parseCatalogText(text);
    let report: ImportReport;
    try {
      report = parsed.ok
        ? await importCatalog(db, p.id, p.name, parsed.value, { dryRun: false, force: false, seedHash: hash, warnings: parsed.warnings })
        : { project: p.id, dryRun: false, applied: false, added: [], changed: [], hidden: [], skipped: [], unchanged: 0, missing: 0, errors: parsed.errors };
    } catch (e) {
      // Обрыв — повтор подключения; прочее — ошибка набора: журнал, справочник работает с прежними данными.
      if ((e instanceof DbError && isConnectionError(e)) || isBusyError(e)) throw e;
      this.#opts.log.warn(`начальный набор ${p.id} не импортирован: ${safeMessage(e, this.#opts.url ?? '')}`);
      return;
    }
    if (report.errors.length > 0) {
      // Все ошибки: исправлять файл по кругу из-за обрезанного списка незачем.
      const list = report.errors.map((x) => `${x.path || '—'}: ${x.message}`).join('; ');
      this.#opts.log.warn(`начальный набор ${p.id}: ${reportLine(report)} (${list})`);
    } else this.#opts.log.info(`начальный набор ${p.id}: ${reportLine(report)}`);
    // Поля без действия и пропущенный раздел settings. Набор они не останавливают: warn остаётся за непринятым набором. Один раз на содержимое файла.
    if (report.warnings?.length) this.#opts.log.info(`начальный набор ${p.id}: предупреждения (${report.warnings.map((x) => `${x.path || '—'}: ${x.message}`).join('; ')})`);
  }

  /**
   * Чтение справочника проекта одним снимком базы: правка между шестью запросами не смешает старые строки с новыми.
   * Раньше начатое чтение с меньшей версией, закончившееся позже, ничего не заменяет. Позже начатое заменяет и при меньшей
   * версии: проект удалили и создали заново, версия началась с 1.
   */
  async #load(db: Db, project: string): Promise<void> {
    const ticket = ++this.#loads;
    const snapshot = await db.tx(async (q) => {
      await q.exec('set transaction isolation level repeatable read, read only');
      return store.loadSnapshot(q, project);
    });
    const was = this.#loaded.get(project);
    if (was && snapshot.version < was.version && ticket < was.ticket) return;
    this.#loaded.set(project, { version: snapshot.version, loadedAt: this.#now(), snapshot, resolver: compileCatalog(snapshot), ticket });
    for (const fn of this.#onReload) fn(project);
  }

  async #poll(): Promise<void> {
    if (this.#closed || !this.#db) return;
    try {
      if (this.#opts.projectsSource) await this.#adopt(this.#db, await this.#opts.projectsSource.poll(this.#db));
      const v = await store.versions(this.#db);
      for (const p of this.#projects) {
        const was = this.#loaded.get(p.id);
        if (!was || v.get(p.id) !== was.version) {
          await this.#load(this.#db, p.id);
          // Импорт командой и правка в другой копии: покрытые строки «Неизвестного» уходят и здесь.
          await this.sweepUnknown(p.id);
        }
      }
      if (this.#state === 'stale' || this.#state === 'connecting') this.#opts.log.info('справочник снова доступен');
      this.#state = 'ok';
      this.#message = null;
    } catch (e) {
      // Том базы пересоздан: база отвечает, таблиц нет. Подключение назовёт команду миграций и дождётся её, затем начальный набор.
      if (e instanceof DbError && e.pgCode === UNDEFINED_TABLE) {
        this.#opts.log.warn('справочник: в базе нет таблиц');
        const db = this.#db;
        this.#db = null;
        await db.close().catch(() => undefined);
        this.#state = 'connecting';
        this.#schedule(() => this.#connect(), 0);
        return;
      }
      if (this.#state === 'ok') this.#opts.log.warn(`справочник: опрос версии не удался, данные остаются на ${new Date(this.state().loadedAt ?? 0).toISOString()}`);
      this.#lost(e);
    }
    this.#schedule(() => this.#poll(), this.#opts.pollMs ?? 30_000);
  }

  /** Опрос сейчас: для тестов. */
  pollNow(): Promise<void> {
    return this.#poll();
  }

  /**
   * Правка: транзакция под блокировкой проекта, version + 1, после фиксации — перезагрузка проекта
   * и уборка «Неизвестного». Ошибка соединения переводит справочник в stale. Занятая блокировка или предел запроса —
   * CatalogBusy: отказ только этой правке, состояние справочника прежнее.
   */
  async edit<T>(project: string, fn: (q: Queryable) => Promise<T>): Promise<T> {
    const db = this.db();
    let out: T;
    try {
      out = await db.tx(async (q) => {
        await store.lockProject(q, project);
        const r = await fn(q);
        await store.bumpVersion(q, project);
        return r;
      });
    } catch (e) {
      if (isBusyError(e)) throw new CatalogBusy();
      if (e instanceof DbError && isConnectionError(e)) {
        this.#lost(e);
        throw new CatalogUnavailable();
      }
      throw e;
    }
    await this.afterChange(project);
    return out;
  }

  /** Запись страниц проектов: как edit, но без блокировки и версии справочника. Обрыв закрывает правку сразу, занятость — только эту запись. */
  async transaction<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    const db = this.db();
    try {
      return await db.tx(fn);
    } catch (e) {
      if (isBusyError(e)) throw new CatalogBusy();
      if (e instanceof DbError && isConnectionError(e)) {
        this.#lost(e);
        throw new CatalogUnavailable();
      }
      throw e;
    }
  }

  /** После правки или импорта: перезагрузка проекта и уборка покрытых строк «Неизвестного». */
  async afterChange(project: string): Promise<void> {
    const db = this.#db;
    if (!db) return;
    try {
      await this.#load(db, project);
      await this.sweepUnknown(project);
    } catch (e) {
      this.#lost(e);
    }
  }

  async sweepUnknown(project: string): Promise<number> {
    const db = this.#db;
    const resolver = this.resolver(project);
    if (!db || !resolver) return 0;
    const rows = await store.allUnknown(db, project, UNKNOWN_SWEEP_LIMIT);
    return store.deleteUnknown(
      db,
      rows.filter((r) => isCovered(r, resolver)).map((r) => r.id),
    );
  }
}

/** Сервис справочника по настройке: проекты из threadline.yaml, начальный набор — catalog/<проект>.yaml рядом с ней. */
export function createCatalogService(
  config: { path: string; config: { projects: Record<string, { name: string }> } },
  url: string | undefined,
  log: CatalogLog,
  now?: () => number,
  projectsSource?: CatalogProjectsSource,
): CatalogService {
  const dir = dirname(config.path);
  const projects = Object.entries(config.config.projects).map(([id, p]) => ({ id, name: p.name, seedFile: resolve(dir, 'catalog', `${id}.yaml`) }));
  return new CatalogService({ url, projects, log, ...(now ? { now } : {}), ...(projectsSource ? { projectsSource } : {}) });
}
