// Проекты в работе сервера: снимок, замена без перезапуска, правка со страницы.
// Читатели разыменуют resolved.config и resolved.logos при каждом запросе, поэтому замена снимка — одно синхронное присваивание.

import { dirname, resolve } from 'node:path';
import { PROJECT_LIMITS, type EnvironmentSetting, type ProjectFileState, type ProjectSetting, type ProjectSettingsResponse, type ProjectsSourceState, type StoreInfo } from '@threadline/core';
import type { CatalogState } from '@threadline/core/search';
import type { ConfigIssue, EnvironmentConfig, ProjectConfig } from '@threadline/core/config';
import {
  environmentList,
  environmentWithinScope,
  LOGO_KEEP,
  sameScope,
  scopeChanged,
  validateEnvironmentInput,
  validateProjectInput,
  validateStoredProject,
  type EnvironmentDraft,
  type EnvironmentRecord,
  type ProjectDraft,
  type ProjectInputContext,
} from '@threadline/core/config/project-input';
import type { CompiledProfile } from '@threadline/core/profile';
import { DEFAULT_VIEW, normalizeView, type ViewIssue, type ViewSettings } from '@threadline/core/view';
import { validateViewInput } from '@threadline/core/view/schema';
import type { Backends } from '../backends/registry.ts';
import { DbError, safeMessage, type Db, type Queryable } from '../catalog/db.ts';
import { MigrationError } from '../catalog/migrate.ts';
import { CatalogUnavailable, type CatalogProject } from '../catalog/service.ts';
import { ensureProject } from '../catalog/store.ts';
import { missingSecret, secretEnvs, type ResolvedConfig } from '../config/load.ts';
import { checkLogoBytes, type LogoFile, type ProjectLogo } from '../config/logo.ts';
import { compileProjectProfiles } from '../search/profiles.ts';
import { dataOf, inputContext, writeProjectRecord, type ProjectFileContext } from './file.ts';
import * as store from './store.ts';
import * as viewStore from './view.ts';
import { fileData, fileStateOf, fileVersion, recordCanon, syncProjects, type FileProjects, type SyncLog } from './sync.ts';

/** Что сервису нужно от справочника: одна база и один цикл подключения на двоих. */
export interface ProjectsCatalog {
  state(): CatalogState;
  readDb(): Db | null;
  /** Транзакция записи: ok или CatalogUnavailable, обрыв закрывает правку. */
  transaction<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  /** Список видимых проектов изменился: справочник загружает новые и забывает ушедшие. */
  projectsChanged?(list: readonly CatalogProject[]): Promise<void>;
}

/** Действие правки на идущие поиски и отложенное «Неизвестное». */
export interface ProjectsEffects {
  dropScope?(project: string, env?: string): void;
  forgetUnknown?(project: string): void;
}

export type ProjectErrorStatus = 404 | 409 | 422 | 503;

/** Отказ правки: код и поля для ответа. */
export class ProjectHttpError extends Error {
  readonly status: ProjectErrorStatus;
  readonly code: string;
  readonly fields: ConfigIssue[] | undefined;
  readonly current: ProjectSetting | undefined;

  constructor(status: ProjectErrorStatus, code: string, extra: { fields?: ConfigIssue[]; current?: ProjectSetting | undefined; details?: string } = {}) {
    super(extra.details ?? code);
    this.name = 'ProjectHttpError';
    this.status = status;
    this.code = code;
    this.fields = extra.fields;
    this.current = extra.current;
  }
}

export interface EnvironmentProblem {
  missingStore?: string;
  outOfScope?: string;
}

/** Настройка вида в снимке: у всех строк базы, в том числе у скрытых и неверных, их форма открывается. */
interface ViewEntry {
  view: ViewSettings;
  issues: ViewIssue[];
  updatedAt: string | null;
}

const parseView = (stored: viewStore.StoredView | null | undefined): ViewEntry => {
  const { view, issues } = normalizeView(stored?.raw ?? null);
  return { view, issues, updatedAt: stored?.updatedAt ?? null };
};

interface Snapshot {
  rows: store.StoredProject[];
  logos: Map<string, ProjectLogo>;
  deleted: Set<string>;
  version: number;
  views: Map<string, ViewEntry>;
}

export interface ProjectsServiceOptions {
  config: ResolvedConfig;
  /** Профили проектов: тот же объект, что у маршрутов поиска, обновляется на месте. */
  profiles: Map<string, CompiledProfile>;
  backends: Backends;
  log: SyncLog;
  effects?: ProjectsEffects;
  now?: () => number;
}

function withoutLogoField(p: ProjectConfig): ProjectConfig {
  const { logo: _logo, ...rest } = p;
  return rest;
}

export class ProjectsService {
  readonly #resolved: ResolvedConfig;
  readonly #profiles: Map<string, CompiledProfile>;
  readonly #backends: Backends;
  readonly #log: SyncLog;
  readonly #effects: ProjectsEffects;
  readonly #now: () => number;
  /** Копия файла: нужна «Взять из файла», сравнению с файлом и запасному режиму. */
  readonly #file: FileProjects & { defaults: ResolvedConfig['config']['defaults'] };
  #catalog: ProjectsCatalog | null = null;
  #snapshot: Snapshot | null = null;
  #loadedAt: number | null = null;
  #invalid = new Map<string, ConfigIssue[]>();
  #fallback = false;

  constructor(opts: ProjectsServiceOptions) {
    this.#resolved = opts.config;
    this.#profiles = opts.profiles;
    this.#backends = opts.backends;
    this.#log = opts.log;
    this.#effects = opts.effects ?? {};
    this.#now = opts.now ?? Date.now;
    this.#file = {
      projects: Object.fromEntries(Object.entries(opts.config.config.projects).map(([id, p]) => [id, withoutLogoField(p)])),
      logos: opts.config.logos ?? new Map<string, ProjectLogo>(),
      defaults: opts.config.config.defaults,
    };
  }

  /** Без справочника сервис работает с файлом: режим off, правка закрыта. */
  attach(catalog: ProjectsCatalog): void {
    this.#catalog = catalog;
  }

  // ---------- Состояние ----------

  sourceState(): { state: ProjectsSourceState; message: string | null } {
    if (!this.#catalog) return { state: 'off', message: null };
    const s = this.#catalog.state();
    return { state: s.state, message: s.message };
  }

  get editable(): boolean {
    return this.#catalog?.state().state === 'ok' && this.#snapshot !== null;
  }

  /** Снимка из базы ещё не было: проект из адреса может быть не показан. */
  get incomplete(): boolean {
    return this.#catalog !== null && this.#catalog.state().state !== 'off' && this.#snapshot === null;
  }

  get version(): number {
    return this.#snapshot?.version ?? 0;
  }

  hiddenList(): { id: string; name: string }[] {
    return (this.#snapshot?.rows ?? []).filter((r) => r.hiddenBy !== null).map((r) => ({ id: r.id, name: r.name }));
  }

  /** Почему среда не работает: хранилище убрали из файла или условия вышли за границу. Файл доверенный: без снимка из базы границы нет. */
  unusable(project: string, envId: string): EnvironmentProblem | null {
    const projects = this.#resolved.config.projects;
    if (!Object.hasOwn(projects, project)) return null;
    const environments = projects[project]!.environments;
    if (!Object.hasOwn(environments, envId)) return null;
    return this.#environmentProblem(project, envId, environments[envId]!);
  }

  #environmentProblem(project: string, envId: string, env: EnvironmentConfig): EnvironmentProblem | null {
    const backend = this.#resolved.backends[env.backend];
    if (!Object.hasOwn(this.#resolved.backends, env.backend) || !backend) return { missingStore: env.backend };
    if (!this.#snapshot || backend.type === 'mock') return null;
    const fileEnv = Object.hasOwn(this.#file.projects, project) && Object.hasOwn(this.#file.projects[project]!.environments, envId) ? this.#file.projects[project]!.environments[envId] : undefined;
    if (fileEnv && sameScope(env, fileEnv)) return null;
    return environmentWithinScope(env, backend.formScope) ? null : { outOfScope: env.backend };
  }

  // ---------- Источник для справочника ----------

  /**
   * Сверка с файлом при подключении, сразу после миграций. Любая ошибка базы идёт в повтор подключения с нарастающей паузой:
   * база только для чтения после переключения, занятая блокировка, кратковременный сбой. Как упавшая миграция, без повтора,
   * ведёт себя только ошибка не базы.
   */
  async sync(db: Db): Promise<CatalogProject[]> {
    try {
      await db.tx((q) => syncProjects(q, this.#file, this.#formats(), this.#log));
      await this.#reload(db);
    } catch (e) {
      if (e instanceof DbError) throw e;
      throw new MigrationError('projects', `сверка проектов с файлом настроек не прошла: ${safeMessage(e, '')}`);
    }
    return this.catalogProjects();
  }

  /** Опрос версии: правка другой копии применяется здесь. */
  async poll(db: Db): Promise<CatalogProject[]> {
    if (!this.#snapshot || (await store.readVersion(db)) !== this.#snapshot.version) await this.#reload(db);
    return this.catalogProjects();
  }

  /** Видимые и верные проекты: справочник работает только с ними. */
  catalogProjects(): CatalogProject[] {
    const dir = dirname(this.#resolved.path);
    return Object.entries(this.#resolved.config.projects).map(([id, p]) => ({ id, name: p.name, seedFile: resolve(dir, 'catalog', `${id}.yaml`) }));
  }

  async #reload(db: Db): Promise<void> {
    const next = await db.tx(async (q): Promise<Snapshot> => ({
      rows: await store.readProjects(q),
      logos: await store.readLogos(q),
      deleted: await store.readDeleted(q),
      version: await store.readVersion(q),
      views: new Map([...(await viewStore.readViews(q))].map(([id, v]) => [id, parseView(v)])),
    }));
    this.#apply(next);
  }

  /** Единственная точка замены снимка: своя правка, опрос другой копии, посев, «Взять из файла». */
  #apply(next: Snapshot): void {
    const formats = this.#formats();
    const invalid = new Map<string, ConfigIssue[]>();
    const valid: [string, ProjectConfig][] = [];
    for (const row of next.rows) {
      const checked = validateStoredProject(row.id, row, formats);
      if (!checked.ok) invalid.set(row.id, checked.issues);
      else if (row.hiddenBy === null) valid.push([row.id, checked.project]);
    }
    // Верных нет совсем: работают проекты из файла, неверные записи страница показывает и даёт исправить.
    const fallback = valid.length === 0;
    const projects: Record<string, ProjectConfig> = fallback ? { ...this.#file.projects } : Object.fromEntries(valid);
    const logos = new Map<string, ProjectLogo>(fallback ? [...this.#file.logos, ...next.logos] : next.logos);

    const before = this.#resolved.config.projects;
    const changedFormat = Object.fromEntries(Object.entries(projects).filter(([id, p]) => !this.#profiles.has(id) || !Object.hasOwn(before, id) || before[id]!.format !== p.format));
    const compiled = compileProjectProfiles({ ...this.#resolved.config, projects: changedFormat }, (m) => this.#log.warn(m), this.#now);

    const defaults = effectiveDefaults(projects, this.#file.defaults);
    const known = new Set((this.#snapshot?.rows ?? []).map((r) => r.id));
    const present = new Set(next.rows.map((r) => r.id));

    // Одним синхронным блоком: следующий запрос видит новую настройку целиком.
    this.#resolved.config = { ...this.#resolved.config, projects, defaults };
    this.#resolved.logos = logos;
    for (const id of [...this.#profiles.keys()]) if (!Object.hasOwn(projects, id)) this.#profiles.delete(id);
    for (const [id, profile] of compiled) this.#profiles.set(id, profile);
    this.#snapshot = next;
    this.#invalid = invalid;
    this.#fallback = fallback;
    this.#loadedAt = this.#now();

    this.#stopAffected(before, projects);
    for (const id of known) if (!present.has(id)) this.#effects.forgetUnknown?.(id);
  }

  /** Правка, которая меняет чтение или разбор, останавливает поиски и сбрасывает кэш стендов. */
  #stopAffected(before: Readonly<Record<string, ProjectConfig>>, after: Readonly<Record<string, ProjectConfig>>): void {
    for (const [pid, was] of Object.entries(before)) {
      if (!Object.hasOwn(after, pid)) {
        this.#effects.dropScope?.(pid);
        for (const eid of Object.keys(was.environments)) this.#backends.forgetStands(pid, eid);
        continue;
      }
      const now = after[pid]!;
      if (now.format !== was.format) this.#effects.dropScope?.(pid);
      for (const [eid, e] of Object.entries(was.environments)) {
        if (Object.hasOwn(now.environments, eid) && !scopeChanged(e, now.environments[eid]!)) continue;
        if (now.format === was.format) this.#effects.dropScope?.(pid, eid);
        this.#backends.forgetStands(pid, eid);
      }
    }
  }

  #formats(): string[] {
    return Object.keys(this.#resolved.config.formats);
  }

  // ---------- Чтение для страниц ----------

  settings(): ProjectSettingsResponse {
    const { state, message } = this.sourceState();
    const configured = this.#file.defaults;
    const defaults = this.#resolved.config.defaults;
    const moved = defaults.project !== configured.project || defaults.environment !== configured.environment;
    return {
      state,
      editable: this.editable,
      message,
      loadedAt: this.#snapshot ? this.#loadedAt : null,
      projects: this.#snapshot ? this.#snapshot.rows.map((r) => this.#settingOf(r, this.#snapshot!.logos.get(r.id))) : this.#fileSettings(),
      formats: this.#formats(),
      stores: this.#stores(),
      defaults,
      ...(moved ? { configuredDefaults: configured } : {}),
      ignoredInFile: this.#snapshot ? [...this.#snapshot.deleted].filter((id) => Object.hasOwn(this.#file.projects, id) && !this.#snapshot!.rows.some((r) => r.id === id)) : [],
      fallbackToFile: this.#fallback,
    };
  }

  /** Настройка вида проекта для ответа со списком; проекта нет в снимке — null, ответ берёт встроенные значения. */
  viewOf(id: string): ViewSettings | null {
    return this.#snapshot?.views.get(id)?.view ?? null;
  }

  #fileSettings(): ProjectSetting[] {
    return Object.entries(this.#file.projects).map(([id, p]) => ({
      ...toSetting(fileData(id, p), this.#logoInfo(id, this.#file.logos.get(id))),
      environments: environmentList(p.environments).map((e) => this.#environmentSetting(id, e)),
      hidden: null,
      fileState: 'same' as ProjectFileState,
      updatedAt: null,
      view: DEFAULT_VIEW,
      viewUpdatedAt: null,
      viewIssues: [],
    }));
  }

  #settingOf(row: store.StoredProject, logo: ProjectLogo | undefined, viewEntry?: ViewEntry): ProjectSetting {
    const issues = this.#invalid.get(row.id);
    const v = viewEntry ?? this.#snapshot?.views.get(row.id) ?? parseView(null);
    return {
      ...toSetting(row, this.#logoInfo(row.id, logo)),
      environments: row.environments.map((e) => this.#environmentSetting(row.id, e)),
      hidden: row.hiddenBy,
      fileState: fileStateOf(row, recordCanon(row, logo), fileVersion(this.#file, row.id)),
      updatedAt: row.updatedAt,
      view: v.view,
      viewUpdatedAt: v.updatedAt,
      viewIssues: v.issues,
      ...(issues ? { issues } : {}),
    };
  }

  #environmentSetting(project: string, e: EnvironmentRecord): ProjectSetting['environments'][number] {
    const problem = this.#environmentProblem(project, e.id, e);
    return {
      id: e.id,
      name: e.name,
      kind: e.kind ?? 'single',
      backend: e.backend,
      selector: (e.selector ?? []).map((m) => ({ label: m.label, op: m.op, value: m.value, ...(m.searchOnly === true ? { searchOnly: true } : {}) })),
      ...(e.stand ? { stand: e.stand } : {}),
      ...(e.examples && e.examples.length > 0 ? { examples: e.examples } : {}),
      ...(problem ?? {}),
    };
  }

  #logoInfo(project: string, logo: ProjectLogo | undefined): ProjectSetting['logo'] {
    if (!logo) return undefined;
    const url = (theme: 'light' | 'dark') => `/api/projects/${encodeURIComponent(project)}/logo/${theme}?v=${logo[theme].hash}`;
    return { light: url('light'), dark: logo.dark === logo.light ? url('light') : url('dark'), ratio: logo.ratio };
  }

  #stores(): StoreInfo[] {
    return Object.entries(this.#resolved.backends).map(([id, b]): StoreInfo => {
      if (b.type === 'mock') return { id, type: b.type, scope: null };
      const scope = b.formScope ? { label: b.formScope.label, values: [...b.formScope.values] } : null;
      // У Loki без входа переменных нет: строка «токен» показывает прочерк. Не хватает переменной — названа она.
      const first = secretEnvs(b)[0]?.[0];
      if (!first) return { id, type: b.type, scope };
      const missing = missingSecret(b);
      return { id, type: b.type, tokenEnv: missing ?? first, tokenSet: !missing, scope };
    });
  }

  async deletePreview(id: string): Promise<{ systems: number; methods: number; errors: number; unknown: number }> {
    const db = this.#catalog?.readDb();
    if (!db) throw new ProjectHttpError(503, 'project-readonly');
    return store.deletePreview(db, id);
  }

  // ---------- Правка ----------

  #context(id: string | undefined, saved: readonly EnvironmentRecord[]): ProjectInputContext {
    return inputContext(this.fileContext(), id, saved);
  }

  /** Контекст раздела settings файла проекта: те же хранилища, профили и версия из файла настроек, что у формы. */
  fileContext(): ProjectFileContext {
    return { backends: this.#resolved.backends, formats: this.#formats(), file: this.#file };
  }

  /** Условия для проверки подключения: форма, правила и граница до обращения к хранилищу. */
  checkProbeEnvironment(storeId: string, project: string | undefined, input: Record<string, unknown>): EnvironmentDraft {
    const saved = project !== undefined ? (this.#snapshot?.rows.find((r) => r.id === project)?.environments ?? []) : [];
    const checked = validateEnvironmentInput({ id: 'probe', name: 'probe', ...input, backend: storeId }, this.#context(project, saved));
    if (!checked.ok) throw new ProjectHttpError(422, 'project-invalid', { fields: checked.issues });
    return checked.environment;
  }

  /** Сохранённая среда проекта на этом хранилище с такими же условиями: другого поддержка и разработчик не проверяют. */
  savedEnvironment(storeId: string, project: string | undefined, input: unknown): EnvironmentSetting | undefined {
    if (project === undefined || typeof input !== 'object' || input === null) return undefined;
    const conditions = (e: { kind?: unknown; selector?: unknown; stand?: { label?: unknown; template?: unknown } | undefined }) => {
      const selector = Array.isArray(e.selector) ? (e.selector as { label?: unknown; op?: unknown; value?: unknown; searchOnly?: unknown }[]) : [];
      return JSON.stringify([e.kind ?? 'single', selector.map((m) => [m.label, m.op, m.value, m.searchOnly === true]), e.stand ? [e.stand.label, e.stand.template] : null]);
    };
    const wanted = conditions(input as Parameters<typeof conditions>[0]);
    return this.settings().projects.find((p) => p.id === project)?.environments.find((e) => e.backend === storeId && conditions(e) === wanted);
  }

  #requireOpen(): ProjectsCatalog {
    if (!this.#catalog || !this.editable) throw new ProjectHttpError(503, 'project-readonly');
    return this.#catalog;
  }

  /** Транзакция под блокировкой правки, версия растёт, после фиксации новый снимок действует на следующий запрос. */
  async #edit<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    const catalog = this.#requireOpen();
    const out = await catalog.transaction(async (q) => {
      await store.lockProjects(q);
      const r = await fn(q);
      await store.bumpVersion(q);
      return r;
    });
    await this.afterCommit();
    return out;
  }

  /** Хвост правки после фиксации: новый снимок действует на следующий запрос, поиски останавливаются. Его же зовёт применение файла проекта. */
  async afterCommit(): Promise<void> {
    const catalog = this.#catalog;
    const db = catalog?.readDb();
    try {
      if (db) await this.#reload(db);
      await catalog?.projectsChanged?.(this.catalogProjects());
    } catch (e) {
      // Запись уже зафиксирована: снимок догонит опрос версии.
      if (!(e instanceof DbError) && !(e instanceof CatalogUnavailable)) throw e;
    }
  }

  async #setting(q: Queryable, id: string): Promise<ProjectSetting> {
    const row = await store.readProject(q, id);
    if (!row) throw new ProjectHttpError(404, 'project-not-found');
    return this.#settingOf(row, (await store.readLogos(q)).get(id), parseView(await viewStore.readView(q, id)));
  }

  /** Посчитан до транзакции: файл не меняется, а логотип проверяется вне блокировки. */
  #validate(input: unknown, id: string | undefined, saved: readonly EnvironmentRecord[]): ProjectDraft {
    const r = validateProjectInput(input, this.#context(id, saved));
    if (!r.ok) throw new ProjectHttpError(422, 'project-invalid', { fields: r.issues });
    return r.project;
  }

  async create(input: unknown): Promise<ProjectSetting> {
    this.#requireOpen();
    const draft = this.#validate(input, (input as { id?: string } | null)?.id, []);
    if (draft.id === undefined) throw new ProjectHttpError(422, 'project-invalid', { fields: [{ path: 'id', message: 'нужен идентификатор проекта', key: 'project.idRequired' }] });
    const id = draft.id;
    const logo = logoOf(draft, null);
    return this.#edit(async (q) => {
      if (await store.readProject(q, id)) throw new ProjectHttpError(409, 'project-duplicate');
      if ((await store.countProjects(q)) >= PROJECT_LIMITS.projects) throw new ProjectHttpError(409, 'project-limit');
      await store.insertProject(q, dataOf(id, draft), await store.nextPosition(q), { hiddenBy: null, fromFile: false, edited: true, fileHash: null });
      await store.replaceLogo(q, id, logo);
      await store.removeDeleted(q, id);
      await store.lockProject(q, id);
      await ensureProject(q, id, draft.name);
      await store.renameAuthor(q, id, draft.name);
      return this.#setting(q, id);
    });
  }

  async update(id: string, input: unknown): Promise<ProjectSetting> {
    this.#requireOpen();
    const known = this.#snapshot?.rows.find((r) => r.id === id);
    const draft = this.#validate(input, id, known?.environments ?? []);
    if (draft.id !== undefined && draft.id !== id) throw new ProjectHttpError(422, 'project-invalid', { fields: [{ path: 'id', message: 'идентификатор проекта не меняется', key: 'project.idImmutable' }] });
    if (draft.updatedAt === undefined) throw new ProjectHttpError(422, 'project-invalid', { fields: [{ path: 'updatedAt', message: 'нет метки версии', key: 'project.noVersion' }] });
    const expected = draft.updatedAt;
    return this.#edit(async (q) => {
      const row = await this.#fresh(q, id, expected);
      const currentLogo = (await store.readLogos(q)).get(id) ?? null;
      const logo = logoOf(draft, currentLogo);
      // Запись одна на форму и файл проекта. Ничего не изменилось: отметка «Правится здесь» не появляется.
      if (!(await writeProjectRecord(q, row, dataOf(id, draft), currentLogo, logo, fileVersion(this.#file, id)))) return this.#settingOf(row, currentLogo ?? undefined);
      return this.#setting(q, id);
    });
  }

  /** Запись под блокировкой: нет — 404, другая метка — 409 со свежей версией. */
  async #fresh(q: Queryable, id: string, expected: string): Promise<store.StoredProject> {
    const row = await store.readProject(q, id);
    if (!row) throw new ProjectHttpError(404, 'project-not-found');
    if (row.updatedAt !== expected) throw new ProjectHttpError(409, 'project-conflict', { current: this.#settingOf(row, (await store.readLogos(q)).get(id)) });
    return row;
  }

  async setHidden(id: string, hidden: boolean, updatedAt: string): Promise<ProjectSetting> {
    return this.#edit(async (q) => {
      const row = await this.#fresh(q, id, updatedAt);
      if (hidden) {
        if (row.hiddenBy !== null) return this.#setting(q, id);
        // Инвариант: видимых и верных не меньше одного. Неверные записи в счёт не идут.
        const valid = (r: store.StoredProject) => validateStoredProject(r.id, r, this.#formats()).ok;
        const others = (await store.readProjects(q)).filter((r) => r.id !== id && r.hiddenBy === null && valid(r));
        if (valid(row) && others.length === 0) throw new ProjectHttpError(409, 'project-last');
        await store.setFlags(q, id, { ...flagsOf(row), hiddenBy: 'page' });
      } else {
        // «Показать» у убранного из файла: иначе следующий перезапуск скрыл бы его снова.
        const removed = row.hiddenBy === 'file' && !Object.hasOwn(this.#file.projects, id);
        await store.setFlags(q, id, { ...flagsOf(row), hiddenBy: null, edited: row.edited || removed });
      }
      return this.#setting(q, id);
    });
  }

  async fileAction(id: string, action: 'take' | 'keep', updatedAt: string): Promise<ProjectSetting> {
    const file = fileVersion(this.#file, id);
    if (!file) throw new ProjectHttpError(422, 'project-invalid', { fields: [{ path: 'action', message: 'проекта нет в файле настроек', key: 'project.notInFile' }] });
    return this.#edit(async (q) => {
      const row = await this.#fresh(q, id, updatedAt);
      if (action === 'keep') {
        await store.setFlags(q, id, { ...flagsOf(row), edited: true, fileHash: file.hash });
        return this.#setting(q, id);
      }
      const p = this.#file.projects[id]!;
      await store.updateProject(q, fileData(id, p), { hiddenBy: row.hiddenBy === 'file' ? null : row.hiddenBy, fromFile: true, edited: false, fileHash: file.hash });
      await store.replaceLogo(q, id, this.#file.logos.get(id) ?? null);
      await store.lockProject(q, id);
      await store.renameAuthor(q, id, p.name);
      return this.#setting(q, id);
    });
  }

  /**
   * Настройка вида — отдельная единица правки со своей меткой: updated_at проекта, edited и file_hash не меняются,
   * поэтому открытая форма проекта не получает ложный конфликт, а файл продолжает применяться. Поиски и кэши стендов на месте: #apply сравнивает только то, что читает хранилище.
   */
  async saveView(id: string, input: unknown): Promise<ProjectSetting> {
    this.#requireOpen();
    const checked = validateViewInput(input);
    if (!checked.ok) throw new ProjectHttpError(422, 'project-invalid', { fields: checked.issues });
    return this.#edit(async (q) => {
      if (!(await viewStore.writeView(q, id, checked.view, checked.updatedAt))) {
        const row = await store.readProject(q, id);
        if (!row) throw new ProjectHttpError(404, 'project-not-found');
        throw new ProjectHttpError(409, 'project-conflict', { current: this.#settingOf(row, (await store.readLogos(q)).get(id), parseView(await viewStore.readView(q, id))) });
      }
      return this.#setting(q, id);
    });
  }

  /** Удалить навсегда можно только скрытый проект: инвариант видимых это не нарушает. Сервер сверяет подтверждение независимо от страницы. */
  async remove(id: string, confirm: string | undefined, updatedAt: string | undefined): Promise<void> {
    this.#requireOpen();
    if (confirm !== id) throw new ProjectHttpError(422, 'project-invalid', { fields: [{ path: 'confirm', message: 'подтверждение не совпадает с идентификатором проекта', key: 'project.confirmMismatch' }] });
    if (updatedAt === undefined) throw new ProjectHttpError(422, 'project-invalid', { fields: [{ path: 'updatedAt', message: 'нет метки версии', key: 'project.noVersion' }] });
    await this.#edit(async (q) => {
      const row = await this.#fresh(q, id, updatedAt);
      if (row.hiddenBy === null) throw new ProjectHttpError(409, 'project-not-hidden');
      await store.lockProject(q, id);
      await store.deleteProject(q, id, Object.hasOwn(this.#file.projects, id));
    });
  }
}

const flagsOf = (row: store.StoredProject): store.ProjectFlags => ({ hiddenBy: row.hiddenBy, fromFile: row.fromFile, edited: row.edited, fileHash: row.fileHash });

function toSetting(p: store.ProjectData, logo: ProjectSetting['logo']): Omit<ProjectSetting, 'environments' | 'hidden' | 'fileState' | 'updatedAt' | 'view' | 'viewUpdatedAt' | 'viewIssues'> {
  return { id: p.id, name: p.name, timezone: p.timezone, retentionDays: p.retentionDays, format: p.format, ...(logo ? { logo } : {}) };
}

/** Проект и среда по умолчанию: из файла, если видны и есть, иначе первый видимый и его первая среда. */
export function effectiveDefaults(projects: Readonly<Record<string, ProjectConfig>>, configured: { project: string; environment: string }): { project: string; environment: string } {
  const ids = Object.keys(projects);
  const project = Object.hasOwn(projects, configured.project) ? configured.project : (ids[0] ?? configured.project);
  const envs = Object.hasOwn(projects, project) ? Object.keys(projects[project]!.environments) : [];
  return { project, environment: envs.includes(configured.environment) && project === configured.project ? configured.environment : (envs[0] ?? configured.environment) };
}

function decodeVersion(base64: string, path: string): LogoFile {
  const checked = checkLogoBytes(Buffer.from(base64, 'base64'));
  if ('reason' in checked) {
    const { reason, ...ref } = checked;
    throw new ProjectHttpError(422, 'project-invalid', { fields: [{ path, message: reason, ...ref }] });
  }
  return checked;
}

/** Логотип из запроса. Ничего не указано или keep — прежний, null — без логотипа; плохая версия отклоняет сохранение целиком. */
function logoOf(draft: ProjectDraft, current: ProjectLogo | null): ProjectLogo | null {
  const input = draft.logo;
  if (input === undefined || input === LOGO_KEEP) return current;
  if (input === null) return null;
  const keepOr = (part: string, was: LogoFile | undefined, path: string): LogoFile => {
    if (part !== LOGO_KEEP) return decodeVersion(part, path);
    if (!was) throw new ProjectHttpError(422, 'project-invalid', { fields: [{ path, message: 'прежней версии логотипа нет', key: 'logo.noPrevious' }] });
    return was;
  };
  const light = keepOr(input.light, current?.light, 'logo.light');
  const dark = input.dark === undefined || input.dark === null ? light : keepOr(input.dark, current?.dark, 'logo.dark');
  return { light, dark, ratio: Math.max(light.ratio, dark.ratio) };
}

